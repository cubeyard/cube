//! keel's agent check (masterplan K-5a): boots a disposable keel machine
//! (base.erofs with cube-init and cube-agent, an image's layer, a writable
//! disk) under QEMU and talks to cube-agent over protocol 4's DaemonFrame on
//! the host end of `cube.0`, as a VM runner will. Then it serves the guest
//! operations on a Unix socket for the Workspace contract's exec part
//! (packages/server/test/keel-agent-contract-test.ts) and runs it.
//!
//!   keel-agent-check --qemu PATH --qemu-img PATH --kernel PATH --base PATH \
//!     --mkfs PATH --tar IMAGE.tar --out DIR [--arch x86_64|arm64] \
//!     [--accel tcg|kvm|hvf] [--contract COMMAND] [--smp 2] [--memory 1024]
//!
//! QEMU and every tool are given by path, never searched for. The driver is
//! not a runner: no network, no secrets, one machine at a time. It writes
//! DIR/results.json and kills every QEMU it started when it ends.
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use cube_runner_protocol::{
    proto::{self, daemon_answer::Result as Answer, daemon_frame::T, daemon_request::Op},
    read_daemon_frame, write_frame,
};
use keel_layers::{DiffId, cache::LayerCache, convert, disk};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream, unix::OwnedWriteHalf},
    process::{Child, Command},
    sync::{mpsc, oneshot},
};

// ---------------------------------------------------------------- options

struct Options {
    qemu: PathBuf,
    qemu_img: PathBuf,
    kernel: PathBuf,
    base: PathBuf,
    mkfs: PathBuf,
    tar: PathBuf,
    out: PathBuf,
    arch: String,
    accel: String,
    contract: Option<String>,
    smp: String,
    memory: String,
}

fn options() -> Result<Options> {
    let mut values: HashMap<String, String> = HashMap::new();
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        let key = arg
            .strip_prefix("--")
            .ok_or_else(|| anyhow!("unexpected argument {arg}"))?;
        values.insert(
            key.into(),
            args.next()
                .ok_or_else(|| anyhow!("--{key} needs a value"))?,
        );
    }
    let path = |key: &str| -> Result<PathBuf> {
        let value = values.get(key).ok_or_else(|| {
            anyhow!("--{key} is required (QEMU and every tool are given by path)")
        })?;
        fs::canonicalize(value).with_context(|| format!("--{key} {value}"))
    };
    let out = PathBuf::from(
        values
            .get("out")
            .ok_or_else(|| anyhow!("--out is required"))?,
    );
    fs::create_dir_all(&out)?;
    let arch = values.get("arch").cloned().unwrap_or_else(|| {
        if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x86_64"
        }
        .into()
    });
    ensure!(
        arch == "x86_64" || arch == "arm64",
        "--arch is x86_64 or arm64"
    );
    let accel = values.get("accel").cloned().unwrap_or_else(|| "tcg".into());
    ensure!(
        ["tcg", "kvm", "hvf"].contains(&accel.as_str()),
        "--accel is tcg, kvm or hvf"
    );
    Ok(Options {
        qemu: path("qemu")?,
        qemu_img: path("qemu-img")?,
        kernel: path("kernel")?,
        base: path("base")?,
        mkfs: path("mkfs")?,
        tar: path("tar")?,
        out: fs::canonicalize(&out)?,
        arch,
        accel,
        contract: values.get("contract").cloned(),
        smp: values.get("smp").cloned().unwrap_or_else(|| "2".into()),
        memory: values
            .get("memory")
            .cloned()
            .unwrap_or_else(|| "1024".into()),
    })
}

fn log(message: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    eprintln!(
        "[{:>5}.{:03}] {message}",
        now.as_secs() % 100_000,
        now.subsec_millis()
    );
}

struct Checks(Vec<String>);
impl Checks {
    fn ok(&mut self, ok: bool, what: &str, detail: impl std::fmt::Display) -> Result<()> {
        if !ok {
            bail!("check failed: {what}: {detail}");
        }
        log(&format!("ok: {what}"));
        self.0.push(what.into());
        Ok(())
    }
}

fn sha256_file(path: &Path) -> Result<String> {
    use std::io::Read;
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0; 1 << 20];
    loop {
        match file.read(&mut buffer)? {
            0 => return Ok(hex(&digest.finalize())),
            n => digest.update(&buffer[..n]),
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ---------------------------------------------------------------- QMP

struct Qmp {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: OwnedWriteHalf,
}

async fn connect(path: &Path, timeout: Duration) -> Result<UnixStream> {
    let deadline = Instant::now() + timeout;
    loop {
        match UnixStream::connect(path).await {
            Ok(stream) => return Ok(stream),
            Err(error) if Instant::now() < deadline => {
                let _ = error;
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            Err(error) => return Err(error).with_context(|| format!("connect {}", path.display())),
        }
    }
}

impl Qmp {
    async fn open(path: &Path) -> Result<Self> {
        let (read, writer) = connect(path, Duration::from_secs(30)).await?.into_split();
        let mut qmp = Self {
            reader: BufReader::new(read),
            writer,
        };
        qmp.line().await?; // greeting
        qmp.execute("qmp_capabilities", Value::Null).await?;
        Ok(qmp)
    }
    async fn line(&mut self) -> Result<Value> {
        let mut line = String::new();
        ensure!(self.reader.read_line(&mut line).await? > 0, "QMP closed");
        Ok(serde_json::from_str(&line)?)
    }
    async fn execute(&mut self, command: &str, arguments: Value) -> Result<Value> {
        let message = if arguments.is_null() {
            json!({"execute": command})
        } else {
            json!({"execute": command, "arguments": arguments})
        };
        self.writer
            .write_all(format!("{message}\n").as_bytes())
            .await?;
        loop {
            let answer = self.line().await?;
            if answer.get("event").is_some() {
                continue;
            }
            if let Some(error) = answer.get("error") {
                bail!("{command}: {error}");
            }
            return Ok(answer["return"].clone());
        }
    }
}

/// The newest versioned machine type, and the devices keel needs.
async fn read_floor(qemu: &Path, sockets: &Path, arch: &str) -> Result<(String, String)> {
    let path = sockets.join("floor.qmp");
    let mut child = Command::new(qemu)
        .args([
            "-machine",
            "none",
            "-S",
            "-nodefaults",
            "-no-user-config",
            "-display",
            "none",
            "-qmp",
        ])
        .arg(format!("unix:{},server=on,wait=off", path.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut qmp = Qmp::open(&path).await?;
    let version = qmp.execute("query-version", Value::Null).await?;
    let types = qmp.execute("qom-list-types", Value::Null).await?;
    for device in ["virtio-rtc-pci", "virtio-serial-pci", "virtserialport"] {
        ensure!(
            types
                .as_array()
                .unwrap()
                .iter()
                .any(|t| t["name"] == device),
            "{} lacks {device}",
            qemu.display()
        );
    }
    let prefix = if arch == "x86_64" { "pc-q35-" } else { "virt-" };
    let machines = qmp.execute("query-machines", Value::Null).await?;
    let mut versioned: Vec<(u32, u32, String)> = machines
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|m| {
            let name = m["name"].as_str()?;
            let (major, minor) = name.strip_prefix(prefix)?.split_once('.')?;
            Some((major.parse().ok()?, minor.parse().ok()?, name.to_string()))
        })
        .collect();
    versioned.sort();
    let machine = versioned
        .pop()
        .ok_or_else(|| anyhow!("no versioned machine type"))?
        .2;
    let q = &version["qemu"];
    let _ = child.kill().await;
    Ok((
        format!("{}.{}.{}", q["major"], q["minor"], q["micro"]),
        machine,
    ))
}

// ---------------------------------------------------------------- the channel

/// The runner's end of `cube.0`: requests on fresh channels, answers by
/// channel, and the agent's `hello`/`status` in arrival order.
struct Channel {
    writer: tokio::sync::Mutex<OwnedWriteHalf>,
    pending: Arc<Mutex<HashMap<u32, oneshot::Sender<Answer>>>>,
    infos: tokio::sync::Mutex<mpsc::UnboundedReceiver<(&'static str, proto::GuestInfo)>>,
    next: AtomicU32,
    reader: tokio::task::JoinHandle<()>,
}

/// Dropping the last handle closes the socket: the runner's end disconnects.
impl Drop for Channel {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

const TIMEOUT: Duration = Duration::from_secs(120);

impl Channel {
    async fn open(path: &Path) -> Result<Arc<Self>> {
        let (read, writer) = connect(path, TIMEOUT).await?.into_split();
        let pending: Arc<Mutex<HashMap<u32, oneshot::Sender<Answer>>>> = Arc::default();
        let (infos, receiver) = mpsc::unbounded_channel();
        let waiting = Arc::clone(&pending);
        let reader = tokio::spawn(async move {
            let mut reader = BufReader::new(read);
            loop {
                // The agent's frames must keep the channel rules the runner holds it to.
                let frame = match read_daemon_frame(&mut reader).await {
                    Ok(frame) => frame,
                    Err(error) => {
                        if !error.to_string().contains("early eof") {
                            log(&format!("channel: {error}"));
                        }
                        break;
                    }
                };
                match frame.t {
                    Some(T::Hello(info)) => drop(infos.send(("hello", info))),
                    Some(T::Status(info)) => drop(infos.send(("status", info))),
                    Some(T::Ans(answer)) => {
                        if let (Some(sender), Some(result)) =
                            (waiting.lock().unwrap().remove(&frame.ch), answer.result)
                        {
                            let _ = sender.send(result);
                        }
                    }
                    other => log(&format!("channel: the agent sent {other:?}")),
                }
            }
        });
        Ok(Arc::new(Self {
            writer: tokio::sync::Mutex::new(writer),
            pending,
            infos: tokio::sync::Mutex::new(receiver),
            next: AtomicU32::new(1),
            reader,
        }))
    }

    async fn info(&self, kind: &str, timeout: Duration) -> Result<proto::GuestInfo> {
        let mut infos = self.infos.lock().await;
        loop {
            let (got, info) = tokio::time::timeout(timeout, infos.recv())
                .await
                .map_err(|_| anyhow!("no {kind} from the agent in {timeout:?}"))?
                .ok_or_else(|| anyhow!("the channel closed"))?;
            if got == kind {
                return Ok(info);
            }
            log(&format!(
                "({got} while waiting for {kind}: ready={} {})",
                info.ready, info.reason
            ));
        }
    }

    async fn send(&self, frame: &proto::DaemonFrame) -> Result<()> {
        write_frame(&mut *self.writer.lock().await, frame).await
    }

    /// Sends a request on channel `ch` (a fresh one when None).
    async fn request_on(&self, ch: Option<u32>, op: Op, timeout: Duration) -> Result<Answer> {
        let ch = ch.unwrap_or_else(|| self.next.fetch_add(1, Ordering::SeqCst));
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(ch, sender);
        self.send(&proto::DaemonFrame {
            ch,
            t: Some(T::Req(proto::DaemonRequest { op: Some(op) })),
        })
        .await?;
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(answer)) => Ok(answer),
            Ok(Err(_)) => bail!("the channel closed before channel {ch} was answered"),
            Err(_) => {
                self.pending.lock().unwrap().remove(&ch);
                bail!("no answer on channel {ch} in {timeout:?}")
            }
        }
    }

    async fn request(&self, op: Op) -> Result<Answer> {
        self.request_on(None, op, TIMEOUT).await
    }

    /// A guest operation's raw answer, or the agent's refusal.
    async fn guest_raw(&self, op: &str, data: Vec<u8>) -> Result<Result<Vec<u8>, proto::Error>> {
        match self
            .request(Op::Guest(proto::GuestRequest {
                op: op.into(),
                data,
            }))
            .await?
        {
            Answer::Guest(bytes) => Ok(Ok(bytes)),
            Answer::Error(error) => Ok(Err(error)),
            Answer::Done(_) => bail!("a guest operation answered done"),
        }
    }

    /// A guest operation as cubed's VmWorkspace sends it: header JSON line + body.
    async fn guest(&self, op: &str, header: Value) -> Result<(Value, Vec<u8>)> {
        let bytes = self
            .guest_raw(op, format!("{header}\n").into_bytes())
            .await?
            .map_err(|e| anyhow!("{op} refused: {e:?}"))?;
        let end = bytes
            .iter()
            .position(|&b| b == b'\n')
            .ok_or_else(|| anyhow!("{op}: no header line"))?;
        Ok((
            serde_json::from_slice(&bytes[..end])?,
            bytes[end + 1..].to_vec(),
        ))
    }

    async fn settle(&self, id: &str) -> Result<(Value, Vec<u8>)> {
        let deadline = Instant::now() + TIMEOUT;
        loop {
            let (header, body) = self.guest("get", json!({"id": id, "waitMs": 5000})).await?;
            if header["state"] != "Running" {
                return Ok((header, body));
            }
            ensure!(Instant::now() < deadline, "{id} still running");
        }
    }

    async fn run(&self, id: &str, command: &str, epoch: i64) -> Result<(Value, String)> {
        let (started, _) = self
            .guest(
                "exec",
                json!({"id": id, "epoch": epoch, "command": command, "timeoutMs": 60000}),
            )
            .await?;
        ensure!(started.get("error").is_none(), "exec {id}: {started}");
        let (header, body) = self.settle(id).await?;
        Ok((header, String::from_utf8_lossy(&body).into_owned()))
    }

    /// The agent's own CPU time and age in seconds, from the guest's /proc
    /// (utime + stime of all its threads; its children are not counted).
    async fn agent_cpu(&self, id: &str, epoch: i64) -> Result<(f64, f64)> {
        let (header, output) = self
            .run(id, "for p in /proc/[0-9]*; do [ \"$(cat $p/comm 2>/dev/null)\" = cube-agent ] && [ \"$(cat $p/cgroup 2>/dev/null)\" = 0::/ ] && pid=${p#/proc/}; done; read -r up _ < /proc/uptime; echo $(cut -d' ' -f14,15,22 /proc/$pid/stat) $up $(getconf CLK_TCK)", epoch)
            .await?;
        let fields: Vec<f64> = output
            .split_whitespace()
            .map(|f| f.parse())
            .collect::<Result<_, _>>()
            .with_context(|| format!("agent cpu: {header} {output:?}"))?;
        ensure!(fields.len() == 5, "agent cpu: {output:?}");
        let tick = fields[4];
        Ok(((fields[0] + fields[1]) / tick, fields[3] - fields[2] / tick))
    }
}

/// How much of a vCPU the agent may use while the runner is away: it looks
/// for the runner every 20 ms; the bug this guards against was a whole vCPU.
const IDLE_SHARE: f64 = 0.25;

// ---------------------------------------------------------------- layers

/// A tar of FILES as ustar with owner 0 and time 0, so its digest is stable.
fn make_tar(files: &[(&str, &str)]) -> Vec<u8> {
    let mut tar = vec![];
    for (path, content) in files {
        let mut header = [0u8; 512];
        let field = |header: &mut [u8; 512], offset: usize, value: &str| {
            header[offset..offset + value.len()].copy_from_slice(value.as_bytes())
        };
        field(&mut header, 0, path);
        field(&mut header, 100, "0000644");
        field(&mut header, 108, "0000000");
        field(&mut header, 116, "0000000");
        field(&mut header, 124, &format!("{:011o}", content.len()));
        field(&mut header, 136, "00000000000");
        field(&mut header, 148, "        ");
        field(&mut header, 156, "0");
        field(&mut header, 257, "ustar");
        field(&mut header, 263, "00");
        let sum: u32 = header.iter().map(|&b| b as u32).sum();
        field(&mut header, 148, &format!("{sum:06o}\0 "));
        tar.extend(header);
        tar.extend(content.as_bytes());
        tar.extend(vec![0; (512 - content.len() % 512) % 512]);
    }
    tar.extend([0; 1024]);
    tar
}

fn convert_tar(cache: &LayerCache, mkfs: &Path, tar: &Path) -> Result<(DiffId, PathBuf)> {
    let diff_id: DiffId = format!("sha256:{}", sha256_file(tar)?).parse()?;
    let (path, _) = cache.get_or_convert(
        &diff_id,
        &convert::Mkfs::new(mkfs),
        convert::TarMode::Full,
        convert::Compression::from_media_type("application/vnd.oci.image.layer.v1.tar")?,
        || fs::File::open(tar).map_err(Into::into),
    )?;
    Ok((diff_id, path))
}

fn layer_disk(dir: &Path, layers: &[(DiffId, PathBuf)]) -> Result<Vec<proto::Layer>> {
    fs::create_dir_all(dir)?;
    let written = disk::write(
        dir,
        &layers
            .iter()
            .map(|(id, path)| disk::Layer {
                path: path.clone(),
                name: id.hex()[..29].into(),
            })
            .collect::<Vec<_>>(),
    )?;
    Ok(written
        .partitions
        .iter()
        .zip(layers)
        .map(|(partition, (id, _))| proto::Layer {
            partition: partition.number,
            source: Some(proto::layer::Source::DiffId(id.to_string())),
        })
        .collect())
}

// ---------------------------------------------------------------- the machine

struct Machine {
    child: Child,
    qmp: PathBuf,
    ctl: PathBuf,
    console: PathBuf,
    started: Instant,
}

struct Lab {
    o: Options,
    machine_type: String,
    sockets: PathBuf,
}

impl Lab {
    fn argv(&self, dir: &Path, layers: &Path, boot: usize) -> Vec<String> {
        let console = if self.o.arch == "x86_64" {
            "ttyS0"
        } else {
            "ttyAMA0"
        };
        let mut args: Vec<String> = [
            "-machine", &format!("{},accel={}", self.machine_type, self.o.accel),
            "-cpu", if self.o.accel == "tcg" { "max" } else { "host" },
            "-smp", &self.o.smp, "-m", &self.o.memory,
            "-nodefaults", "-no-user-config", "-display", "none", "-no-reboot",
            "-kernel", &self.o.kernel.display().to_string(),
            "-append", &format!("console={console} root=/dev/vda ro rootfstype=erofs init=/sbin/cube-init quiet panic=-1"),
            "-drive", &format!("if=virtio,format=raw,readonly=on,file={}", self.o.base.display()),
            "-drive", &format!("if=virtio,format=vmdk,readonly=on,file={}", layers.join("layers.vmdk").display()),
            "-drive", &format!("if=virtio,format=qcow2,discard=unmap,file={}", dir.join("rw.qcow2").display()),
            "-device", "virtio-serial-pci",
            "-chardev", &format!("socket,id=ctl,path={},server=on,wait=off", self.sockets.join("ctl.sock").display()),
            "-device", "virtserialport,chardev=ctl,name=cube.0",
            "-device", "virtio-rtc-pci",
            "-device", "virtio-balloon-pci,free-page-reporting=on",
            "-serial", &format!("file:{}", dir.join(format!("console-{boot}.log")).display()),
            "-qmp", &format!("unix:{},server=on,wait=off", self.sockets.join("qmp.sock").display()),
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        if cfg!(target_os = "linux") {
            args.extend(["-sandbox".into(), "on".into()]);
        }
        args
    }

    fn new_disk(&self, name: &str) -> Result<PathBuf> {
        let dir = self.o.out.join("runs").join(name);
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir)?;
        let status = std::process::Command::new(&self.o.qemu_img)
            .args(["create", "-q", "-f", "qcow2"])
            .arg(dir.join("rw.qcow2"))
            .arg("8G")
            .status()?;
        ensure!(status.success(), "qemu-img create");
        Ok(dir)
    }

    fn start(&self, dir: &Path, layers: &Path) -> Result<Machine> {
        for s in ["ctl.sock", "qmp.sock"] {
            let _ = fs::remove_file(self.sockets.join(s));
        }
        let mut boot = 1;
        while dir.join(format!("console-{boot}.log")).exists() {
            boot += 1;
        }
        let args = self.argv(dir, layers, boot);
        fs::write(
            dir.join(format!("argv-{boot}.json")),
            serde_json::to_string_pretty(&json!([self.o.qemu, args]))?,
        )?;
        let child = Command::new(&self.o.qemu)
            .args(&args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(
                dir.join(format!("qemu-stderr-{boot}.log")),
            )?)
            .kill_on_drop(true)
            .spawn()?;
        Ok(Machine {
            child,
            qmp: self.sockets.join("qmp.sock"),
            ctl: self.sockets.join("ctl.sock"),
            console: dir.join(format!("console-{boot}.log")),
            started: Instant::now(),
        })
    }
}

async fn quit(machine: &mut Machine) -> Result<()> {
    if let Ok(mut qmp) = Qmp::open(&machine.qmp).await {
        let _ = qmp.execute("quit", Value::Null).await;
    }
    let _ = tokio::time::timeout(Duration::from_secs(30), machine.child.wait()).await;
    let _ = machine.child.kill().await;
    Ok(())
}

fn setup(layers: &[proto::Layer], documents: &[(&str, &[u8])]) -> Op {
    let mut entropy = vec![0u8; 32];
    let seed = Sha256::digest(format!("{:?}", Instant::now()).as_bytes());
    entropy.copy_from_slice(&seed);
    Op::MachineSetup(proto::MachineSetup {
        r#ref: Some(proto::Ref {
            owner: "keel-agent-check".into(),
            id: "0123456789abcdef".into(),
        }),
        documents: documents
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_vec()))
            .collect(),
        entropy,
        layers: layers.to_vec(),
        image: Some(proto::ImageConfig {
            digest: String::new(),
            env: vec!["IMAGE_ONLY=from-image".into()],
        }),
        ca_pem: String::new(),
        runner_version: "keel-agent-check".into(),
        protocol: 4,
        capabilities: vec![],
    })
}

fn refusal(answer: &Answer) -> Option<(i32, String)> {
    match answer {
        Answer::Error(error) => Some((error.code, error.reason.clone())),
        _ => None,
    }
}

// ---------------------------------------------------------------- the bridge

/// Guest operations for the contract test, one per connection:
/// `OP\n` + request bytes, then EOF; the answer is `ok\n` + the agent's
/// bytes, or `error JSON\n` with the agent's refusal (`StreamAnswer.error`).
async fn bridge(listener: UnixListener, channel: Arc<Channel>) {
    loop {
        let Ok((mut stream, _)) = listener.accept().await else {
            return;
        };
        let channel = Arc::clone(&channel);
        tokio::spawn(async move {
            let mut request = vec![];
            if stream.read_to_end(&mut request).await.is_err() {
                return;
            }
            let Some(end) = request.iter().position(|&b| b == b'\n') else {
                return;
            };
            let op = String::from_utf8_lossy(&request[..end]).into_owned();
            let reply = match channel.guest_raw(&op, request[end + 1..].to_vec()).await {
                Ok(Ok(bytes)) => [b"ok\n".to_vec(), bytes].concat(),
                Ok(Err(error)) => {
                    format!("error {}\n", serde_json::to_string(&error).unwrap()).into_bytes()
                }
                Err(error) => format!(
                    "error {}\n",
                    json!({"code": "INTERNAL", "reason": "bridge", "message": error.to_string()})
                )
                .into_bytes(),
            };
            let _ = stream.write_all(&reply).await;
            let _ = stream.shutdown().await;
        });
    }
}

// ---------------------------------------------------------------- main

#[tokio::main(flavor = "current_thread")]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("keel-agent-check: {error:#}");
        std::process::exit(1);
    }
}

async fn run() -> Result<()> {
    let o = options()?;
    let sockets = PathBuf::from(format!("/tmp/kac-{}", std::process::id()));
    fs::create_dir_all(&sockets)?;
    let result = check(o, &sockets).await;
    let _ = fs::remove_dir_all(&sockets);
    result
}

async fn check(o: Options, sockets: &Path) -> Result<()> {
    let (version, machine_type) = read_floor(&o.qemu, sockets, &o.arch).await?;
    log(&format!(
        "QEMU {version} at {}, machine {machine_type}, {}",
        o.qemu.display(),
        o.accel
    ));
    let mut checks = Checks(vec![]);
    let mut timings: Vec<Value> = vec![];

    // Layers: the image (one flat tar) and a bare layer without bash.
    let cache = LayerCache::open(o.out.join("cache"))?;
    let image = convert_tar(&cache, &o.mkfs, &o.tar)?;
    let bare_tar = o.out.join("bare.tar");
    fs::write(&bare_tar, make_tar(&[("etc/keel-bare", "bare\n")]))?;
    let bare = convert_tar(&cache, &o.mkfs, &bare_tar)?;
    let image_disk = o.out.join("image-disk");
    let bare_disk = o.out.join("bare-disk");
    let image_layers = layer_disk(&image_disk, std::slice::from_ref(&image))?;
    let bare_layers = layer_disk(&bare_disk, std::slice::from_ref(&bare))?;
    let lab = Lab {
        o,
        machine_type: machine_type.clone(),
        sockets: sockets.into(),
    };
    let env: &[u8] = b"GH_TOKEN=cube_ph_github_keelcheck\nCUBE_SECRET_X=cube_ph_x\n";
    let documents: &[(&str, &[u8])] = &[("hostname", b"keel-check\n"), ("env", env)];

    // 1. The bare layer: hello, refusals before setup, an image that is not ready.
    {
        let dir = lab.new_disk("bare")?;
        let mut m = lab.start(&dir, &bare_disk)?;
        let ch = Channel::open(&m.ctl).await?;
        let hello = ch.info("hello", TIMEOUT).await?;
        let hello_ms = m.started.elapsed().as_millis();
        checks.ok(
            !hello.ready && hello.reason == "waiting for machine_setup",
            "hello before setup: not ready, waiting for machine_setup",
            format!("{hello:?}"),
        )?;
        checks.ok(
            hello.capabilities == ["exec.start", "exec.cancel", "operation.get"],
            "hello advertises only exec, cancel and get",
            format!("{:?}", hello.capabilities),
        )?;
        let limits = hello.limits.unwrap_or_default();
        checks.ok(
            limits.max_frame_bytes == 1_048_576
                && limits.max_exec_timeout_ms == 1_800_000
                && limits.output_page_bytes == 65_536,
            "hello carries cube-guest's limits",
            format!("{limits:?}"),
        )?;
        checks.ok(
            hello.build.len() == 64
                && hello.os == "linux"
                && hello.boot_id.len() == 36
                && hello.epoch == 0,
            "hello: build hash, os, boot id, epoch 0",
            format!("{hello:?}"),
        )?;
        let refused = ch
            .guest_raw(
                "exec",
                format!(
                    "{}\n",
                    json!({"id": "early", "epoch": 1, "command": "true", "timeoutMs": 1000})
                )
                .into_bytes(),
            )
            .await?;
        checks.ok(
            refused.as_ref().is_err_and(|e| {
                e.code == proto::Code::Unavailable as i32 && e.reason == "not_ready"
            }),
            "exec before setup is UNAVAILABLE/not_ready",
            format!("{refused:?}"),
        )?;
        let (guest_hello, _) = ch.guest("hello", json!({})).await?;
        checks.ok(
            guest_hello["ready"] == false
                && guest_hello["limits"]["maxWriteBytes"] == 524288
                && guest_hello["version"].is_string(),
            "the hello operation answers before setup, as cube-guest's",
            &guest_hello,
        )?;
        let unknown = ch.request(setup(&bare_layers, &[("seed", b"x")])).await?;
        checks.ok(
            refusal(&unknown)
                == Some((
                    proto::Code::InvalidArgument as i32,
                    "unknown_document".into(),
                )),
            "a setup with an unknown document is refused",
            format!("{unknown:?}"),
        )?;
        let _ = ch.info("status", TIMEOUT).await?;
        let mut weak = setup(&bare_layers, documents);
        if let Op::MachineSetup(s) = &mut weak {
            s.entropy.truncate(8);
        }
        let answer = ch.request(weak).await?;
        checks.ok(
            refusal(&answer) == Some((proto::Code::InvalidArgument as i32, "entropy".into())),
            "a setup with less than 32 bytes of entropy is refused",
            format!("{answer:?}"),
        )?;
        let _ = ch.info("status", TIMEOUT).await?;
        let done = ch.request(setup(&bare_layers, documents)).await?;
        checks.ok(
            matches!(done, Answer::Done(_)),
            "setup of the bare layer is done",
            format!("{done:?}"),
        )?;
        let status = ch.info("status", TIMEOUT).await?;
        checks.ok(
            !status.ready
                && status.reason == "the image lacks bash, sudo, flock, git, gh, curl, a CA bundle",
            "an image without cube's tools is not ready, and status says what it lacks",
            &status.reason,
        )?;
        let refused = ch
            .guest_raw(
                "exec",
                format!(
                    "{}\n",
                    json!({"id": "bare", "epoch": 1, "command": "true", "timeoutMs": 1000})
                )
                .into_bytes(),
            )
            .await?;
        checks.ok(
            refused.is_err(),
            "exec is refused while not ready",
            format!("{refused:?}"),
        )?;
        // A channel number used twice breaks the rules: the agent ends the
        // connection and says hello again.
        let ch_used = 900;
        let _ = ch
            .request_on(
                Some(ch_used),
                Op::Guest(proto::GuestRequest {
                    op: "hello".into(),
                    data: b"{}\n".to_vec(),
                }),
                TIMEOUT,
            )
            .await?;
        let again = ch
            .request_on(
                Some(ch_used),
                Op::Guest(proto::GuestRequest {
                    op: "hello".into(),
                    data: b"{}\n".to_vec(),
                }),
                Duration::from_secs(3),
            )
            .await;
        let hello = ch.info("hello", TIMEOUT).await?;
        checks.ok(again.is_err() && !hello.ready, "a reused channel number ends the connection; the agent says hello again (not ready until the next setup)", format!("{again:?}"))?;
        timings.push(json!({"run": "bare", "helloMs": hello_ms}));
        quit(&mut m).await?;
    }

    // 2. The image: setup, ready, exec as agent in the workload root.
    let dir = lab.new_disk("image")?;
    let token = hex(&Sha256::digest(format!("{:?}", Instant::now())))[..16].to_string();
    let first_ready_ms;
    let epoch: i64;
    let image_hello_ms;
    {
        let mut m = lab.start(&dir, &image_disk)?;
        let ch = Channel::open(&m.ctl).await?;
        let _ = ch.info("hello", TIMEOUT).await?;
        let hello_ms = m.started.elapsed().as_millis();
        image_hello_ms = hello_ms;
        let t = Instant::now();
        let done = ch.request(setup(&image_layers, documents)).await?;
        checks.ok(
            matches!(done, Answer::Done(_)),
            "setup of the image is done (blank disk formatted)",
            format!("{done:?}"),
        )?;
        let status = ch.info("status", TIMEOUT).await?;
        first_ready_ms = t.elapsed().as_millis();
        checks.ok(
            status.ready && status.reason.is_empty(),
            "the image with cube's tools is ready",
            format!("{status:?}"),
        )?;
        let again = ch.request(setup(&image_layers, documents)).await?;
        let status = ch.info("status", TIMEOUT).await?;
        checks.ok(
            matches!(again, Answer::Done(_)) && status.ready,
            "the same setup again is done and changes nothing",
            format!("{again:?}"),
        )?;
        let changed = ch
            .request(setup(
                &[image_layers.clone(), bare_layers.clone()]
                    .concat()
                    .iter()
                    .enumerate()
                    .map(|(i, l)| proto::Layer {
                        partition: i as u32 + 1,
                        ..l.clone()
                    })
                    .collect::<Vec<_>>(),
                documents,
            ))
            .await?;
        checks.ok(
            refusal(&changed)
                == Some((
                    proto::Code::FailedPrecondition as i32,
                    "layers_changed".into(),
                )),
            "another layer list under a running workload is FAILED_PRECONDITION/layers_changed",
            format!("{changed:?}"),
        )?;
        let status = ch.info("status", TIMEOUT).await?;
        checks.ok(
            !status.ready,
            "after a refused setup the machine is not ready",
            &status.reason,
        )?;
        let _ = ch.request(setup(&image_layers, documents)).await?;
        checks.ok(
            ch.info("status", TIMEOUT).await?.ready,
            "the right setup makes it ready again",
            "",
        )?;

        let (header, output) = ch
            .run("who", "id -un; id -u; pwd; echo \"$GH_TOKEN $CUBE_SECRET_X $IMAGE_ONLY $HOME $PATH\"; hostname; cat /proc/self/cgroup", 1)
            .await?;
        let lines: Vec<&str> = output.lines().collect();
        checks.ok(
            header["result"]["exitCode"] == 0
                && lines.first() == Some(&"agent")
                && lines.get(1) != Some(&"0"),
            "a command runs as agent, not root",
            &output,
        )?;
        checks.ok(
            lines.get(2) == Some(&"/workspace"),
            "a command runs in /workspace",
            &output,
        )?;
        checks.ok(
            lines.get(3) == Some(&format!("cube_ph_github_keelcheck cube_ph_x from-image /home/agent {}", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin").as_str()),
            "the environment: the env document's placeholders over the image's Env and the account's own",
            &output,
        )?;
        checks.ok(
            lines.get(4) == Some(&"keel-check"),
            "the hostname document is the machine's host name",
            &output,
        )?;
        checks.ok(
            lines
                .get(5)
                .is_some_and(|l| l.starts_with("0::/cube-ops/who")),
            "the command runs in its operation's own cgroup",
            &output,
        )?;
        let (_, output) = ch
            .run("root", "cat /proc/self/mountinfo | awk '$5 == \"/\" {print $9}'; ls /dev | tr '\\n' ' '; echo; touch /sys/x 2>&1 | head -n 1; test -e /run/keel && echo base-visible || echo base-hidden; findmnt -no FSTYPE /var/lib/cube", 1)
            .await?;
        let lines: Vec<&str> = output.lines().collect();
        checks.ok(
            lines.first() == Some(&"overlay"),
            "the workload's / is the overlay (its own mount namespace, pivot_root)",
            &output,
        )?;
        let devices = lines.get(1).copied().unwrap_or_default();
        checks.ok(
            ["null", "zero", "urandom", "tty", "ptmx", "pts", "shm"].iter().all(|d| devices.split(' ').any(|x| x == *d))
                && !devices.split(' ').any(|x| x.starts_with("vd") || x.starts_with("vport") || x == "console"),
            "the workload's /dev has the character devices programs expect, and no disks or virtio ports",
            devices,
        )?;
        checks.ok(
            lines
                .get(2)
                .is_some_and(|l| l.contains("Read-only file system")),
            "the workload's /sys is read-only",
            &output,
        )?;
        checks.ok(
            lines.get(3) == Some(&"base-hidden"),
            "the base root (/run/keel) is not visible in the workload root",
            &output,
        )?;
        checks.ok(
            lines.get(4) == Some(&"ext4"),
            "state/ on the writable disk is /var/lib/cube",
            &output,
        )?;

        // The Workspace contract's exec part, over this channel. Its lease
        // store is new, so its epochs start at 1: it runs before the epochs below.
        if let Some(command) = &lab.o.contract {
            let path = lab.sockets.join("bridge.sock");
            let listener = UnixListener::bind(&path)?;
            let serving = tokio::spawn(bridge(listener, Arc::clone(&ch)));
            log(&format!("running the contract: {command}"));
            let status = Command::new("/bin/sh")
                .args(["-c", command])
                .env("CUBE_AGENT_BRIDGE", &path)
                .status()
                .await?;
            serving.abort();
            checks.ok(
                status.success(),
                "the Workspace contract's exec part passes over DaemonFrame",
                status,
            )?;
        }

        // The journal over DaemonFrame: a repeated key, a conflict, an abort.
        // cubed's lease epochs are milliseconds since 1970; so are these.
        epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_millis() as i64;
        let (_, output) = ch
            .run(
                "e1",
                &format!("printf once >> count; printf {token}"),
                epoch,
            )
            .await?;
        checks.ok(
            output == token,
            "exec under a key returns its output",
            &output,
        )?;
        let (again, _) = ch.guest("exec", json!({"id": "e1", "epoch": epoch, "command": format!("printf once >> count; printf {token}"), "timeoutMs": 60000})).await?;
        let (_, count) = ch.run("count", "cat count", epoch).await?;
        checks.ok(
            again["state"] == "Succeeded" && count == "once",
            "a repeated key returns the recorded state and never runs again",
            format!("{again} {count}"),
        )?;
        let (conflict, _) = ch.guest("exec", json!({"id": "e1", "epoch": epoch, "command": "touch must-not-run", "timeoutMs": 60000})).await?;
        checks.ok(
            conflict["error"]["code"] == "CONFLICT",
            "the same key for another command is CONFLICT",
            &conflict,
        )?;
        // An abort stops the wait, not the operation; its answer is dropped:
        // a get that waits for a running command is aborted, and the command
        // still finishes.
        let (started, _) = ch.guest("exec", json!({"id": "aborted", "epoch": epoch, "command": "sleep 2; echo ran > aborted", "timeoutMs": 60000})).await?;
        let ch_abort = 5000;
        let data = format!("{}\n", json!({"id": "aborted", "waitMs": 20000})).into_bytes();
        let waiting = {
            let ch = Arc::clone(&ch);
            tokio::spawn(async move {
                ch.request_on(
                    Some(ch_abort),
                    Op::Guest(proto::GuestRequest {
                        op: "get".into(),
                        data,
                    }),
                    Duration::from_secs(25),
                )
                .await
            })
        };
        tokio::time::sleep(Duration::from_millis(200)).await;
        ch.send(&proto::DaemonFrame {
            ch: ch_abort,
            t: Some(T::Abort(proto::Empty {})),
        })
        .await?;
        let dropped = waiting.await?;
        let (state, _) = ch.settle("aborted").await?;
        let (_, ran) = ch.run("aborted-check", "cat aborted", epoch).await?;
        checks.ok(
            started["state"] == "Running"
                && dropped.is_err()
                && state["state"] == "Succeeded"
                && ran == "ran\n",
            "abort stops the wait, not the operation; the answer after it is dropped",
            format!("{dropped:?} {state}"),
        )?;
        // Cancel kills the tree.
        let (started, _) = ch.guest("exec", json!({"id": "c1", "epoch": epoch, "command": "(sleep 20; touch child-survived) & sleep 20; touch not-cancelled", "timeoutMs": 60000})).await?;
        tokio::time::sleep(Duration::from_millis(500)).await;
        let (cancelled, _) = ch
            .guest("cancel", json!({"id": "c1", "epoch": epoch}))
            .await?;
        let (state, _) = ch.settle("c1").await?;
        checks.ok(
            started["state"] == "Running"
                && state
                    == json!({"state": "Failed", "error": "CANCELLED", "completionUnknown": false}),
            "cancel kills a running command",
            format!("{cancelled} {state}"),
        )?;
        // Epochs.
        let _ = ch.run("epoch", "true", epoch).await?;
        let (stale, _) = ch.guest("exec", json!({"id": "stale", "epoch": epoch - 1, "command": "touch stale", "timeoutMs": 1000})).await?;
        checks.ok(
            stale["error"]["code"] == "LEASE_STALE",
            "an older lease epoch is LEASE_STALE",
            &stale,
        )?;
        // A timeout.
        let (_, _) = ch
            .guest(
                "exec",
                json!({"id": "slow", "epoch": epoch, "command": "sleep 30", "timeoutMs": 500}),
            )
            .await?;
        let (state, _) = ch.settle("slow").await?;
        checks.ok(
            state["result"]["termination"] == "timedOut"
                && state["result"]["serviceResult"] == "timeout",
            "a command past its timeout is killed and recorded timedOut",
            &state,
        )?;
        let (memory, _) = ch.settle("e1").await?;
        checks.ok(
            memory["result"]["memory"]["peakBytes"]
                .as_u64()
                .is_some_and(|p| p > 0)
                && memory["result"]["memory"]["oomKills"] == 0,
            "the result carries the operation cgroup's peak memory and OOM kills",
            &memory["result"]["memory"],
        )?;

        // The agent dies under a running command; cube-init starts it again,
        // it finds the command by its cgroup and records it once.
        let _ = ch.guest("exec", json!({"id": "survivor", "epoch": epoch, "command": "sleep 4; echo survived >> survivor; printf done", "timeoutMs": 60000})).await?;
        tokio::time::sleep(Duration::from_millis(500)).await;
        let (killer, _) = ch.guest("exec", json!({"id": "killer", "epoch": epoch, "command": "for p in /proc/[0-9]*; do [ \"$(cat $p/comm 2>/dev/null)\" = cube-agent ] && [ \"$(cat $p/cgroup 2>/dev/null)\" = 0::/ ] && sudo -n kill -9 ${p#/proc/}; done; true", "timeoutMs": 60000})).await?;
        let hello = ch.info("hello", Duration::from_secs(60)).await?;
        checks.ok(killer.get("error").is_none() && !hello.ready && hello.epoch == epoch, "the agent was killed; cube-init started it again and it says hello (journal epoch kept)", format!("{killer} {hello:?}"))?;
        let done = ch.request(setup(&image_layers, documents)).await?;
        let status = ch.info("status", TIMEOUT).await?;
        checks.ok(
            matches!(done, Answer::Done(_)) && status.ready,
            "after the agent restart the same setup is done and the machine ready again",
            format!("{done:?}"),
        )?;
        let (state, body) = ch.settle("survivor").await?;
        let (_, survivor) = ch.run("survivor-check", "cat survivor", epoch).await?;
        checks.ok(
            state["state"] == "Succeeded" && body == b"done" && survivor == "survived\n",
            "a command that ran across the agent restart is found by its key and recorded once",
            format!("{state} {survivor}"),
        )?;
        let changed = ch.request(setup(&bare_layers, documents)).await?;
        checks.ok(
            refusal(&changed).is_some_and(|(_, r)| r == "layers_changed"),
            "after an agent restart another layer list is still refused (kept in /run)",
            format!("{changed:?}"),
        )?;
        let _ = ch.info("status", TIMEOUT).await?;
        let _ = ch.request(setup(&image_layers, documents)).await?;
        let _ = ch.info("status", TIMEOUT).await?;

        // A command still running when the machine powers off: interrupted after the boot.
        let _ = ch.guest("exec", json!({"id": "cut", "epoch": epoch, "command": "sleep 60; touch cut-ran", "timeoutMs": 120000})).await?;
        let (_, _) = ch.run("persist", &format!("echo {token} > persist; echo {token} | sudo -n tee /var/lib/cube/token >/dev/null; sync"), epoch).await?;
        let _ = ch.guest("exec", json!({"id": "poweroff", "epoch": epoch, "command": "sudo -n kill -TERM 1", "timeoutMs": 60000})).await;
        let exited = tokio::time::timeout(Duration::from_secs(60), m.child.wait()).await;
        let console = fs::read_to_string(&m.console).unwrap_or_default();
        checks.ok(
            exited
                .as_ref()
                .is_ok_and(|s| s.as_ref().is_ok_and(|s| s.success())),
            "SIGTERM to cube-init powers the machine off; QEMU exits 0",
            format!("{exited:?}"),
        )?;
        checks.ok(
            !console.contains("stays mounted") && !console.contains("Kernel panic"),
            "clean shutdown on the console",
            &console[console.len().saturating_sub(1500)..],
        )?;
        timings.push(
            json!({"run": "image", "helloMs": hello_ms, "firstSetupToReadyMs": first_ready_ms}),
        );
    }

    // 3. The same disk boots again: the journal and the workload's files stay;
    // the command cut off by the power-off is interrupted and never runs again.
    // No runner is connected while it boots, and later the runner goes away
    // and comes back: the agent waits without spinning and says hello again.
    let mut idle = json!({});
    {
        let mut m = lab.start(&dir, &image_disk)?;
        let late = Duration::from_millis(image_hello_ms as u64 * 2 + 2000);
        log(&format!("connecting {late:?} after the start"));
        tokio::time::sleep(late).await;
        let connected = Instant::now();
        let ch = Channel::open(&m.ctl).await?;
        let hello = ch.info("hello", TIMEOUT).await?;
        let hello_ms = m.started.elapsed().as_millis();
        let t = Instant::now();
        let done = ch.request(setup(&image_layers, documents)).await?;
        let status = ch.info("status", TIMEOUT).await?;
        let ready_ms = t.elapsed().as_millis();
        checks.ok(
            matches!(done, Answer::Done(_)) && status.ready && status.epoch == epoch,
            "the second boot is ready on the kept disk; the journal's epoch is kept",
            format!("{done:?} {status:?}"),
        )?;
        checks.ok(
            hello.epoch == 0 || hello.epoch == epoch,
            "hello before setup (journal not mounted yet)",
            hello.epoch,
        )?;
        // All of the agent's CPU time so far, the setup included, against the
        // time it spent with nobody on the runner's end.
        let (cpu, age) = ch.agent_cpu("cpu-boot", epoch).await?;
        let alone = age - connected.elapsed().as_secs_f64();
        idle["boot"] = json!({"agentCpuS": cpu, "agentAgeS": age, "disconnectedS": alone});
        checks.ok(
            alone >= 1.0 && cpu < IDLE_SHARE * alone,
            "booted with no runner connected, the agent waits without spinning (its CPU time from /proc)",
            format!("{cpu:.2} s CPU in {age:.2} s, {alone:.2} s of them disconnected"),
        )?;
        let (cut, _) = ch.guest("get", json!({"id": "cut"})).await?;
        checks.ok(
            cut == json!({"state": "Interrupted", "completionUnknown": true}),
            "a command the power-off cut off is Interrupted after the boot",
            &cut,
        )?;
        let (again, _) = ch.guest("exec", json!({"id": "cut", "epoch": epoch, "command": "sleep 60; touch cut-ran", "timeoutMs": 120000})).await?;
        let (_, files) = ch.run("files", "cat persist; sudo -n cat /var/lib/cube/token 2>/dev/null; test -e cut-ran && echo cut-ran || echo cut-not-run", epoch).await?;
        checks.ok(
            again["state"] == "Interrupted" && files == format!("{token}\n{token}\ncut-not-run\n"),
            "the interrupted key never runs again; the workspace and state/ are kept",
            format!("{again} {files}"),
        )?;
        let (e1, body) = ch.guest("get", json!({"id": "e1"})).await?;
        checks.ok(
            e1["state"] == "Succeeded" && String::from_utf8_lossy(&body) == token,
            "a result recorded before the boot is still there",
            &e1,
        )?;

        // The runner closes its socket and connects again 2 s later.
        let (before, _) = ch.agent_cpu("cpu-connected", epoch).await?;
        drop(ch);
        let closed = Instant::now();
        tokio::time::sleep(Duration::from_secs(2)).await;
        let away = closed.elapsed().as_secs_f64();
        let ch = Channel::open(&m.ctl).await?;
        let hello = ch.info("hello", TIMEOUT).await?;
        checks.ok(
            !hello.ready && hello.epoch == epoch,
            "the runner connects again: a fresh hello (not ready until the next setup, epoch kept)",
            format!("{hello:?}"),
        )?;
        let done = ch.request(setup(&image_layers, documents)).await?;
        let status = ch.info("status", TIMEOUT).await?;
        let (after, _) = ch.agent_cpu("cpu-reconnect", epoch).await?;
        let (_, output) = ch.run("reconnected", "cat persist", epoch).await?;
        checks.ok(
            matches!(done, Answer::Done(_)) && status.ready && output == format!("{token}\n"),
            "after the reconnect the channels work again: setup on channel 1, then commands",
            format!("{done:?} {output:?}"),
        )?;
        idle["reconnect"] = json!({"agentCpuS": after - before, "disconnectedS": away});
        checks.ok(
            after - before < IDLE_SHARE * away,
            "while the runner is away the agent waits without spinning (its CPU time from /proc)",
            format!(
                "{:.2} s CPU over {away:.2} s away, the setup again included",
                after - before
            ),
        )?;

        // Information, not a check: the runner connects again at once. A
        // disconnect the agent does not see before the next connect (the
        // read finds the new connection, not EOF) is K-5f's gap, so a missed
        // hello here is reported, not failed.
        let mut ch = ch;
        let tries = 5;
        let mut hellos = 0;
        for _ in 0..tries {
            drop(ch);
            ch = Channel::open(&m.ctl).await?;
            if ch.info("hello", Duration::from_secs(10)).await.is_err() {
                break;
            }
            let done = ch.request(setup(&image_layers, documents)).await?;
            if !matches!(done, Answer::Done(_)) || !ch.info("status", TIMEOUT).await?.ready {
                break;
            }
            hellos += 1;
        }
        if hellos == tries {
            let (_, output) = ch.run("immediate", "cat persist", epoch).await?;
            ensure!(
                output == format!("{token}\n"),
                "after immediate reconnects: {output:?}"
            );
        }
        log(&format!(
            "immediate reconnect: {hellos} of {tries} got a fresh hello and a working setup"
        ));
        idle["immediateReconnect"] = json!({"tries": tries, "hellos": hellos});

        timings
            .push(json!({"run": "second boot", "helloMs": hello_ms, "setupToReadyMs": ready_ms}));
        quit(&mut m).await?;
    }

    let results = json!({
        "qemu": {"path": lab.o.qemu, "version": version, "machine": machine_type, "accel": lab.o.accel, "smp": lab.o.smp, "memory": lab.o.memory},
        "arch": lab.o.arch,
        "kernel": {"path": lab.o.kernel, "sha256": sha256_file(&lab.o.kernel)?},
        "base": {"path": lab.o.base, "sha256": sha256_file(&lab.o.base)?},
        "image": {"tar": lab.o.tar, "diffId": image.0.to_string()},
        "checks": checks.0,
        "idle": idle,
        "timings": timings,
    });
    fs::write(
        lab.o.out.join("results.json"),
        serde_json::to_string_pretty(&results)?,
    )?;
    println!(
        "keel agent check: {} {}, QEMU {version} {machine_type}; {} checks passed",
        lab.o.arch,
        lab.o.accel,
        results["checks"].as_array().unwrap().len()
    );
    println!(
        "timings (ms, one run each; not measurements): {}",
        serde_json::to_string(&timings)?
    );
    Ok(())
}
