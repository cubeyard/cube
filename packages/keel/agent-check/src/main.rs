//! keel's agent check (masterplan K-5a): boots a disposable keel machine
//! (base.erofs with cube-init and cube-agent, an image's layer, a writable
//! disk) under QEMU and talks to cube-agent over protocol 4's DaemonFrame on
//! the host end of `cube.0`, as a VM runner will. Then it serves the guest
//! operations on a Unix socket for the Workspace contract
//! (packages/server/test/keel-agent-contract-test.ts) and runs it.
//!
//!   keel-agent-check --qemu PATH --qemu-img PATH --kernel PATH --base PATH \
//!     --mkfs PATH --fsck PATH --tar IMAGE.tar --out DIR [--arch x86_64|arm64] \
//!     [--accel tcg|kvm|hvf] [--contract COMMAND] [--smp 2] [--memory 1024] \
//!     [--vmgenid on|off] [--only snapshot|rest] \
//!     [--control reconnect|late-hello|restore|prepare|clock|seal|redirect|snapshot]
//!
//! `--control` runs one negative control, expected to fail at its check:
//! `reconnect` (also `--reset off`): the immediate reconnects wait for the
//! plain `hello` only, without the reset on channel 0. `late-hello`: the
//! forced late `hello` is not forced (no reset before the setup).
//! `restore`: after each restore the runner waits for the plain `hello`
//! only. `prepare`: no `snapshot_prepare` before the saves, so the request
//! sent then is not held. `clock`: the machine has no virtio-rtc. `seal`:
//! the build machine's setup leaves the runner's CA (DER) in a file, so
//! publishing is refused. `redirect`: the template's redirects point at
//! nothing. `snapshot`: in the same-snapshot restores (check 83) the runner
//! stays connected through the save, so the restored port already says
//! connected and the guest may see no open when the runner connects again.
//!
//! `--vmgenid` (x86-64 only, default on, as `berth vm` runs machines): QEMU's
//! `vmgenid` device, whose new GUID makes the guest kernel reseed its random
//! generator after a restore. QEMU has no such device for arm64.
//!
//! Last, a build machine with a template disk publishes its `upper/` as a
//! template layer (`template_publish`); `fsck.erofs` (`--fsck`) checks it,
//! the driver reads it in place (erofs.rs: no extraction, so no root and no
//! `mknod` on the host, macOS included) and looks for anything of cube's in
//! it, and a new machine boots with it as its topmost layer.
//!
//! QEMU and every tool are given by path, never searched for. The driver is
//! not a runner: no network, no secrets, one machine at a time. It writes
//! DIR/results.json and kills every QEMU it started when it ends.
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU32, Ordering},
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

mod erofs;

// ---------------------------------------------------------------- options

struct Options {
    qemu: PathBuf,
    qemu_img: PathBuf,
    kernel: PathBuf,
    base: PathBuf,
    mkfs: PathBuf,
    fsck: PathBuf,
    tar: PathBuf,
    out: PathBuf,
    arch: String,
    accel: String,
    contract: Option<String>,
    smp: String,
    memory: String,
    control: Option<Control>,
    /// x86-64: QEMU's vmgenid device (as berth vm's machines have it).
    vmgenid: bool,
    /// `--only snapshot`: check 83 alone (a host retest of the restore flow).
    only_snapshot: bool,
    /// `--only rest`: every check but 83 (the two together are the whole
    /// check, for a machine where one run takes too long).
    skip_snapshot: bool,
}

/// A negative control: the one place the reset on channel 0 is left out,
/// (`clock`) the machine without virtio-rtc, (`seal`) a build setup that
/// leaves the runner's CA behind, or (`redirect`) a template whose
/// redirects point at nothing.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Control {
    Reconnect,
    LateHello,
    Restore,
    Clock,
    Seal,
    Redirect,
    Prepare,
    Snapshot,
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
    let reset = values.get("reset").map_or("on", String::as_str);
    ensure!(reset == "on" || reset == "off", "--reset is on or off");
    let control = match (reset, values.get("control").map(String::as_str)) {
        ("on", None) => None,
        ("off", None | Some("reconnect")) | ("on", Some("reconnect")) => Some(Control::Reconnect),
        ("on", Some("late-hello")) => Some(Control::LateHello),
        ("on", Some("restore")) => Some(Control::Restore),
        ("on", Some("clock")) => Some(Control::Clock),
        ("on", Some("seal")) => Some(Control::Seal),
        ("on", Some("redirect")) => Some(Control::Redirect),
        ("on", Some("prepare")) => Some(Control::Prepare),
        ("on", Some("snapshot")) => Some(Control::Snapshot),
        _ => bail!(
            "--control is reconnect, late-hello, restore, prepare, clock, seal, redirect or snapshot (and --reset off is reconnect)"
        ),
    };
    let vmgenid = match values.get("vmgenid").map(String::as_str) {
        None | Some("on") => arch == "x86_64",
        Some("off") => false,
        Some(other) => bail!("--vmgenid is on or off, not {other}"),
    };
    let (only_snapshot, skip_snapshot) = match values.get("only").map(String::as_str) {
        None => (false, false),
        Some("snapshot") => (true, false),
        Some("rest") => (false, true),
        Some(other) => bail!("--only is snapshot or rest, not {other}"),
    };
    Ok(Options {
        control,
        vmgenid,
        only_snapshot,
        skip_snapshot,
        qemu: path("qemu")?,
        qemu_img: path("qemu-img")?,
        kernel: path("kernel")?,
        base: path("base")?,
        mkfs: path("mkfs")?,
        fsck: path("fsck")?,
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

impl Qmp {
    /// Until QEMU reports a change of cube.0's guest side (VSERPORT_CHANGE,
    /// `cube0`) that happened after `since` (QMP's own timestamp, host
    /// time): the agent saw the runner leave and closed and opened its port.
    /// QEMU sends this event at most once a second per port and keeps only
    /// the newest state, so its timestamp, not its `open`, says it is the
    /// agent's answer and not an older change. Open this connection before
    /// the runner leaves. Returns how long after `since` the change was.
    async fn port_changed_after(&mut self, since: f64, within: Duration) -> Result<f64> {
        let deadline = Instant::now() + within;
        loop {
            let left = deadline.saturating_duration_since(Instant::now());
            let event = tokio::time::timeout(left, self.line())
                .await
                .map_err(|_| {
                    anyhow!("no VSERPORT_CHANGE of cube0 after the runner left, within {within:?}")
                })??;
            if event["event"] != "VSERPORT_CHANGE" || event["data"]["id"] != "cube0" {
                continue;
            }
            let at = event["timestamp"]["seconds"].as_f64().unwrap_or(0.0)
                + event["timestamp"]["microseconds"].as_f64().unwrap_or(0.0) / 1e6;
            if at > since {
                return Ok(at - since);
            }
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
    /// Set by the reader on the first `hello`.
    helloed: Arc<AtomicBool>,
    /// What the driver sent before that `hello`: the runner's rule allows
    /// only the reset on channel 0.
    early: Mutex<Vec<String>>,
    /// The session of the newest `hello` (runner.proto's header): put on
    /// every frame sent on a channel above 0.
    session: Arc<Mutex<String>>,
    /// Frames the agent sent with another session than its newest `hello`'s.
    foreign: Arc<AtomicU32>,
}

impl Drop for Channel {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

/// Closes the socket before it returns: the runner's end disconnects.
async fn close(ch: Arc<Channel>) -> Result<()> {
    let mut ch = Arc::into_inner(ch).ok_or_else(|| anyhow!("the channel is still in use"))?;
    ch.reader.abort();
    let _ = (&mut ch.reader).await;
    Ok(())
}

const TIMEOUT: Duration = Duration::from_secs(120);
/// A web server in Perl (perl-base is in every Debian image), as the
/// contract's: says where it listens and logs each request line.
const SERVICE_SCRIPT: &str = r#"use IO::Socket::INET;
$| = 1;
$SIG{PIPE} = "IGNORE";
my $s = IO::Socket::INET->new(LocalAddr => "$ENV{HOST}:$ENV{PORT}", Listen => 5, ReuseAddr => 1) or die "listen: $!\n";
print "listening on $ENV{PORT} as $ENV{CUBE_SERVICE}\n";
while (my $c = $s->accept) {
  my $line = <$c>;
  print "got $line" if defined $line;
  while (my $h = <$c>) { last if $h =~ /^\r?\n$/ }
  print $c "HTTP/1.0 200 OK\r\nContent-Type: text/plain\r\n\r\nhello from $ENV{CUBE_SERVICE}\n";
  close $c;
}
"#;
/// The pid of the `keep` service's server (empty when none runs).
/// The runner's CA in every setup: a throwaway self-signed certificate (its
/// key was never kept); only its text matters.
const TEST_CA: &str = "-----BEGIN CERTIFICATE-----
MIIByTCCAW+gAwIBAgIUYGCQ1sdCMj23aBebvDb0lf8BeaUwCgYIKoZIzj0EAwIw
OTE3MDUGA1UEAwwua2VlbC1hZ2VudC1jaGVjayB0ZXN0IENBIChubyBwcml2YXRl
IGtleSBrZXB0KTAgFw0yNjEwMTExMTIzMzJaGA8yMTI2MDkxNzExMjMzMlowOTE3
MDUGA1UEAwwua2VlbC1hZ2VudC1jaGVjayB0ZXN0IENBIChubyBwcml2YXRlIGtl
eSBrZXB0KTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABD0KP9cpkzDCrJu5ysZ8
F4ffGJZtFjbxgV/VF/NQsfaewZlAX33TGXwFRMwoimGQGCVWQnNtyiZ53q1CSOBD
wWKjUzBRMB0GA1UdDgQWBBQPgA8fy5tZfD175gjk8QsV/rJL8DAfBgNVHSMEGDAW
gBQPgA8fy5tZfD175gjk8QsV/rJL8DAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49
BAMCA0gAMEUCIQD65YEKd62BBay48IZq/x1b+rcj1JeDKj6W99kIgg5a3gIgaYs/
h7a4hHplJXlEJ+aP+giyDKZu+FDDJAW+xNWg6Do=
-----END CERTIFICATE-----
";
/// The project's pre-resume hook in every setup (the boot document).
const PRE_RESUME: &[u8] =
    b"#!/bin/bash\necho \"pre-resume as $(id -un) in $(pwd) token=$GH_TOKEN\"\n";
/// A guest's realtime may be this far from the host's after a pause.
const CLOCK_TOLERANCE: f64 = 1.0;
const PAUSE: Duration = Duration::from_secs(3);
const SERVICE_PID: &str = "pgrep -u agent -f '^perl server.pl' | head -1";
/// Waits (20 s) until the `keep` service listens.
const WAIT_LISTENING: &str = "for i in $(seq 100); do cube service status keep --json 2>/dev/null | grep -q '\"listening\":true' && break; sleep 0.2; done";

impl Channel {
    async fn open(path: &Path) -> Result<Arc<Self>> {
        let (read, writer) = connect(path, TIMEOUT).await?.into_split();
        let pending: Arc<Mutex<HashMap<u32, oneshot::Sender<Answer>>>> = Arc::default();
        let (infos, receiver) = mpsc::unbounded_channel();
        let waiting = Arc::clone(&pending);
        let helloed = Arc::new(AtomicBool::new(false));
        let seen = Arc::clone(&helloed);
        let session = Arc::new(Mutex::new(String::new()));
        let foreign = Arc::new(AtomicU32::new(0));
        let (current, others) = (Arc::clone(&session), Arc::clone(&foreign));
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
                if let Some(T::Hello(_)) = &frame.t {
                    *current.lock().unwrap() = frame.session.clone();
                } else if frame.session != *current.lock().unwrap() {
                    others.fetch_add(1, Ordering::SeqCst);
                    log(&format!(
                        "channel: a frame of session {:?} dropped",
                        frame.session
                    ));
                    continue;
                }
                match frame.t {
                    Some(T::Hello(info)) => {
                        seen.store(true, Ordering::SeqCst);
                        drop(infos.send(("hello", info)))
                    }
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
            helloed,
            early: Mutex::default(),
            session,
            foreign,
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
        if !self.helloed.load(Ordering::SeqCst) {
            self.early.lock().unwrap().push(describe(frame));
        }
        let mut frame = frame.clone();
        if frame.ch > 0 {
            frame.session = self.session.lock().unwrap().clone();
        }
        write_frame(&mut *self.writer.lock().await, &frame).await
    }

    /// Drops the `hello`s and `status`es queued so far, so the next `status`
    /// is the one a request brings.
    fn drop_infos(&self) {
        if let Ok(mut infos) = self.infos.try_lock() {
            while let Ok((kind, info)) = infos.try_recv() {
                log(&format!(
                    "(dropped a queued {kind}: ready={} {})",
                    info.ready, info.reason
                ));
            }
        }
    }

    /// `snapshot_prepare`: its answer and, after `done`, the `status` that
    /// follows it (an agent that refuses may send none).
    async fn prepare(&self) -> Result<(Answer, Option<proto::GuestInfo>)> {
        self.drop_infos();
        let answer = self.request(Op::SnapshotPrepare(proto::Empty {})).await?;
        let status = match answer {
            Answer::Done(_) => Some(self.info("status", TIMEOUT).await?),
            _ => None,
        };
        Ok((answer, status))
    }

    /// The frames sent before the first `hello`, as `describe` names them.
    fn sent_before_hello(&self) -> Vec<String> {
        self.early.lock().unwrap().clone()
    }

    /// The reset: a `req` on channel 0, which breaks the channel rules, so
    /// the agent ends the connection and says `hello` again.
    async fn reset(&self) -> Result<()> {
        self.send(&reset_frame()).await
    }

    /// Sends a request on channel `ch` (a fresh one when None); the answer
    /// comes on the receiver.
    async fn start(&self, ch: Option<u32>, op: Op) -> Result<(u32, oneshot::Receiver<Answer>)> {
        let ch = ch.unwrap_or_else(|| self.next.fetch_add(1, Ordering::SeqCst));
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(ch, sender);
        self.send(&proto::DaemonFrame {
            ch,
            t: Some(T::Req(proto::DaemonRequest { op: Some(op) })),
            session: String::new(), // send() puts the current session on it
        })
        .await?;
        Ok((ch, receiver))
    }

    /// Sends a request on channel `ch` (a fresh one when None).
    async fn request_on(&self, ch: Option<u32>, op: Op, timeout: Duration) -> Result<Answer> {
        let (ch, receiver) = self.start(ch, op).await?;
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

    /// The runner's connect rule (runner.proto's header): `hello` within
    /// PLAIN_HELLO of the connect; without one, a `req` on channel 0, which
    /// makes the agent end the connection and say `hello` again, within
    /// RESET_HELLO. True when the reset was needed. With `reset` false (the
    /// negative control) it only waits, as long.
    async fn hello_or_reset(&self, reset: bool) -> Result<(proto::GuestInfo, bool)> {
        if let Ok(hello) = self.info("hello", PLAIN_HELLO).await {
            return Ok((hello, false));
        }
        if !reset {
            return Ok((self.info("hello", RESET_HELLO).await?, false));
        }
        self.reset().await?;
        let hello = self
            .info("hello", RESET_HELLO)
            .await
            .context("after the reset on channel 0 (a second miss: the machine is unhealthy)")?;
        Ok((hello, true))
    }

    /// `machine_setup` until `status` says ready. A `hello` while it waits
    /// means the agent ended the connection and every channel closed (a
    /// plain `hello` that came after PLAIN_HELLO, then the reset), so the
    /// setup goes again on a new channel. Returns how many such `hello`s came.
    async fn setup_after_hello(&self, op: impl Fn() -> Op) -> Result<u32> {
        let mut hellos = 0;
        loop {
            let (ch, answer) = self.start(None, op()).await?;
            // The answer first: the `status` after it must stay queued.
            let answer = tokio::select! {
                biased;
                answer = answer => Some(answer.map_err(|_| anyhow!("channel {ch} closed"))?),
                hello = self.info("hello", TIMEOUT) => { hello?; None }
            };
            match answer {
                Some(Answer::Done(_)) => {
                    let status = self.info("status", TIMEOUT).await?;
                    ensure!(status.ready, "not ready after the setup: {}", status.reason);
                    return Ok(hellos);
                }
                Some(other) => bail!("machine_setup on channel {ch}: {other:?}"),
                None => {
                    self.pending.lock().unwrap().remove(&ch);
                    hellos += 1;
                    ensure!(hellos < 3, "{hellos} hellos instead of a setup answer");
                }
            }
        }
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

    /// A file operation: header JSON line (with `length`) + body.
    async fn file(&self, op: &str, mut header: Value, body: &[u8]) -> Result<(Value, Vec<u8>)> {
        header["length"] = json!(body.len());
        let bytes = self
            .guest_raw(
                op,
                [format!("{header}\n").into_bytes(), body.to_vec()].concat(),
            )
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

    /// The guest's realtime minus the host's, in seconds: `date` in a
    /// command, against the middle of the host's time around the call.
    async fn clock_offset(&self, id: &str, epoch: i64) -> Result<f64> {
        let now = || {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64()
        };
        let before = now();
        let (_, output) = self.run(id, "date +%s.%N", epoch).await?;
        let after = now();
        let guest: f64 = output
            .trim()
            .parse()
            .with_context(|| format!("date: {output:?}"))?;
        Ok(guest - (before + after) / 2.0)
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

fn reset_frame() -> proto::DaemonFrame {
    proto::DaemonFrame {
        session: String::new(),
        ch: 0,
        t: Some(T::Req(proto::DaemonRequest {
            op: Some(Op::Guest(proto::GuestRequest {
                op: "hello".into(),
                data: Vec::new(),
            })),
        })),
    }
}

/// A frame by channel and kind (and operation), for `sent_before_hello`.
fn describe(frame: &proto::DaemonFrame) -> String {
    let kind = match &frame.t {
        Some(T::Req(proto::DaemonRequest {
            op: Some(Op::Guest(g)),
        })) => format!("req guest.{}", g.op),
        Some(T::Req(proto::DaemonRequest {
            op: Some(Op::MachineSetup(_)),
        })) => "req machine_setup".into(),
        Some(T::Req(_)) => "req".into(),
        Some(T::Abort(_)) => "abort".into(),
        other => format!("{other:?}"),
    };
    format!("ch {} {kind}", frame.ch)
}

/// How much of a vCPU the agent may use while the runner is away: it looks
/// for the runner every 20 ms; the bug this guards against was a whole vCPU.
const IDLE_SHARE: f64 = 0.25;

/// How long a runner waits for the plain `hello` after a connect: the
/// agent looks for the runner every 20 ms.
const PLAIN_HELLO: Duration = Duration::from_millis(500);
/// How long after `cont` the clock thread has synced at least once: every
/// 500 ms, and a sleep armed before the save can end about 1 s late under
/// KVM. A step it adds after the hello's (R18) is on the console by then.
const CLOCK_SETTLED: Duration = Duration::from_secs(2);
/// How long it waits for `hello` after the reset on channel 0: the agent
/// opens the port again after 100 ms, then looks every 20 ms.
const RESET_HELLO: Duration = Duration::from_secs(2);
/// Immediate reconnects in a row, each one recovered.
const RECONNECTS: usize = 10;
/// Restores in a row into a new QEMU, the runner connected before `cont`.
const RESTORES: usize = 3;

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
            "-device", "virtserialport,chardev=ctl,name=cube.0,id=cube0",
            "-device", "virtio-balloon-pci,free-page-reporting=on",
            "-serial", &format!("file:{}", dir.join(format!("console-{boot}.log")).display()),
            "-qmp", &format!("unix:{},server=on,wait=off", self.sockets.join("qmp.sock").display()),
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        if self.o.control != Some(Control::Clock) {
            args.extend(["-device".into(), "virtio-rtc-pci".into()]);
        }
        if self.o.vmgenid {
            // A new generation id every time QEMU starts, so in a restore too.
            args.extend(["-device".into(), "vmgenid,guid=auto".into()]);
        }
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
        self.start_with(dir, layers, &[])
    }

    /// `extra` goes after the machine's own arguments (`-S -incoming defer`
    /// for a restore).
    fn start_with(&self, dir: &Path, layers: &Path, extra: &[&str]) -> Result<Machine> {
        for s in ["ctl.sock", "qmp.sock"] {
            let _ = fs::remove_file(self.sockets.join(s));
        }
        let mut boot = 1;
        while dir.join(format!("console-{boot}.log")).exists() {
            boot += 1;
        }
        let mut args = self.argv(dir, layers, boot);
        args.extend(extra.iter().map(|s| s.to_string()));
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

/// Suspends as a runner will: `stop`, `migrate` to `file:` with
/// `mapped-ram` in mode `cpr-reboot` (QEMU's vmdk driver refuses mode
/// `normal`, and the layer disk is a VMDK), the file renamed once QEMU says
/// `completed`, then `quit`. The runner's socket stays connected throughout.
async fn save(machine: &mut Machine, memory: &Path) -> Result<Duration> {
    let mut qmp = Qmp::open(&machine.qmp).await?;
    let t = Instant::now();
    qmp.execute("stop", Value::Null).await?;
    migration_mode(&mut qmp).await?;
    let part = memory.with_extension("part");
    qmp.execute(
        "migrate",
        json!({"uri": format!("file:{}", part.display())}),
    )
    .await?;
    await_migration(&mut qmp).await?;
    let took = t.elapsed();
    fs::rename(&part, memory)?;
    let _ = qmp.execute("quit", Value::Null).await;
    let _ = tokio::time::timeout(Duration::from_secs(30), machine.child.wait()).await;
    let _ = machine.child.kill().await;
    Ok(took)
}

/// Check 83: one snapshot restored twice. A machine on a fresh disk is set
/// up, left by the runner (its end of cube.0 closed, which the agent
/// acknowledges by closing and opening the port: a VSERPORT_CHANGE
/// timestamped after the runner left), stopped and saved once
/// (memory file and a copy of its writable disk); then, twice, the disk is
/// put back, a new QEMU loads the memory and runs, and the runner connects
/// (the supported flow: the guest sees the port open). Each `hello` must come without the reset, start a session
/// neither the save nor the other restore had, and carry the host's time;
/// after each setup the guest's random bytes must differ from the other's.
async fn same_snapshot(
    lab: &Lab,
    layers: &Path,
    image_layers: &[proto::Layer],
    documents: &[(&str, &[u8])],
) -> Result<Value> {
    let dir = lab.new_disk("snapshot")?;
    let mut m = lab.start(&dir, layers)?;
    let ch = Channel::open(&m.ctl).await?;
    ch.info("hello", TIMEOUT).await?;
    ch.setup_after_hello(|| setup(image_layers, documents))
        .await?;
    let saved_session = ch.session.lock().unwrap().clone();
    let memory = dir.join("memory");
    // The supported flow: the runner closes its end of cube.0 while the
    // machine runs and waits until the agent has seen it (it closes the port
    // and opens it again: a VSERPORT_CHANGE timestamped after the runner
    // left), then stops and saves. The saved
    // guest waits for the host, so the runner's connect after a restore is an
    // open the guest sees. (Left connected, the restored guest gets the
    // host's close and open within moments of each other and may read
    // after both, finding the host connected: no EOF, no hello; a race the
    // agent usually loses.)
    let disconnect_first = lab.o.control != Some(Control::Snapshot);
    if disconnect_first {
        let mut qmp = Qmp::open(&m.qmp).await?;
        let left = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        close(ch).await?;
        let acknowledged = qmp.port_changed_after(left, RESET_HELLO).await?;
        drop(qmp); // one QMP client at a time: save opens its own
        log(&format!(
            "same snapshot: the agent closed and opened cube.0 {:.0} ms after the runner left (VSERPORT_CHANGE)",
            acknowledged * 1000.0
        ));
        save(&mut m, &memory).await?;
    } else {
        save(&mut m, &memory).await?;
        close(ch).await?;
    }
    fs::copy(dir.join("rw.qcow2"), dir.join("rw.saved.qcow2"))?;
    let mut sessions = vec![saved_session.clone()];
    let mut randoms: Vec<String> = vec![];
    let mut each = vec![];
    for i in 0..2 {
        // Saved for a while: the guest's clock stands still meanwhile.
        tokio::time::sleep(PAUSE).await;
        fs::copy(dir.join("rw.saved.qcow2"), dir.join("rw.qcow2"))?;
        let mut m = lab.start_with(&dir, layers, &["-S", "-incoming", "defer"])?;
        let mut qmp = Qmp::open(&m.qmp).await?;
        migration_mode(&mut qmp).await?;
        qmp.execute(
            "migrate-incoming",
            json!({"uri": format!("file:{}", memory.display())}),
        )
        .await?;
        await_migration(&mut qmp).await?;
        qmp.execute("cont", Value::Null).await?;
        let resumed = Instant::now();
        drop(qmp); // one QMP client at a time: quit opens its own
        let ch = Channel::open(&m.ctl).await?;
        let hello = match ch.info("hello", PLAIN_HELLO).await {
            Ok(hello) => hello,
            Err(error) => {
                // Still a failure; say whether a hello came late, and when.
                let late = ch.info("hello", Duration::from_secs(3)).await;
                bail!(
                    "restore {i}: no plain hello within {PLAIN_HELLO:?} of cont: {error}; {}",
                    match late {
                        Ok(_) => format!(
                            "a hello came {} ms after cont",
                            resumed.elapsed().as_millis()
                        ),
                        Err(_) => "none within 3.5 s either".into(),
                    }
                );
            }
        };
        let hello_ms = resumed.elapsed().as_millis();
        let host_now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        let since = hello
            .since
            .map_or(0.0, |t| t.seconds as f64 + t.nanos as f64 / 1e9);
        let offset = since - host_now;
        ensure!(
            cube_runner_protocol::valid_session(&hello.session)
                && !sessions.contains(&hello.session),
            "restore {i}: session {:?}, but this machine had {sessions:?}",
            hello.session
        );
        ensure!(
            offset.abs() <= CLOCK_TOLERANCE,
            "restore {i}: hello's since is {offset:+.3} s from the host's time"
        );
        sessions.push(hello.session.clone());
        ch.setup_after_hello(|| setup(image_layers, documents))
            .await?;
        let (_, random) = ch
            .run(
                &format!("random-{i}"),
                "head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \\n'",
                1,
            )
            .await?;
        let (_, forks) = ch
            .run(
                &format!("forks-{i}"),
                "sudo dmesg | grep -c 'virtual machine fork' || true",
                1,
            )
            .await?;
        let forks: u32 = forks.trim().parse().unwrap_or(0);
        ensure!(
            forks == u32::from(lab.o.vmgenid),
            "restore {i}: {forks} kernel record(s) of a VM generation change, with vmgenid {}",
            lab.o.vmgenid
        );
        ensure!(
            random.len() == 32 && !randoms.contains(&random),
            "restore {i}: random bytes {random:?} after {randoms:?}: the guest's random state is the save's"
        );
        randoms.push(random.clone());
        // The restore's step is made once: by the sync before hello or by
        // the clock thread, not by both (each logs a step of 1 s or more),
        // and realtime is still the host's once the thread has synced.
        tokio::time::sleep_until((resumed + CLOCK_SETTLED).into()).await;
        let settled = ch.clock_offset(&format!("date-{i}"), 1).await?;
        let steps = count_in(&m.console, "cube-agent: clock: stepped");
        ensure!(
            steps <= 1,
            "restore {i}: the restore's clock step was made {steps} times:\n{}",
            fs::read_to_string(&m.console)
                .unwrap_or_default()
                .lines()
                .filter(|line| line.contains("cube-agent: clock:"))
                .collect::<Vec<_>>()
                .join("\n")
        );
        ensure!(
            settled.abs() <= CLOCK_TOLERANCE,
            "restore {i}: realtime is {settled:+.3} s from the host's time {CLOCK_SETTLED:?} after cont"
        );
        log(&format!(
            "same snapshot, restore {i}: plain hello {hello_ms} ms after cont, session {}, clock {offset:+.3} s, random {random}, vmgenid records {forks}; clock steps {steps}, clock {settled:+.3} s at {CLOCK_SETTLED:?}",
            hello.session
        ));
        each.push(json!({"contToHelloMs": hello_ms, "session": hello.session, "helloClockOffsetS": offset, "random": random, "vmgenidRecords": forks, "clockSteps": steps, "settledClockOffsetS": settled}));
        close(ch).await?;
        quit(&mut m).await?;
    }
    let _ = fs::remove_file(&memory);
    Ok(json!({"savedSession": saved_session, "vmgenid": lab.o.vmgenid, "restores": each}))
}

async fn migration_mode(qmp: &mut Qmp) -> Result<()> {
    qmp.execute(
        "migrate-set-capabilities",
        json!({"capabilities": [{"capability": "mapped-ram", "state": true}]}),
    )
    .await?;
    qmp.execute("migrate-set-parameters", json!({"mode": "cpr-reboot"}))
        .await?;
    Ok(())
}

async fn await_migration(qmp: &mut Qmp) -> Result<()> {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        let status = qmp.execute("query-migrate", Value::Null).await?;
        match status["status"].as_str() {
            Some("completed") => return Ok(()),
            Some("failed" | "cancelled") => bail!("migration: {status}"),
            _ => ensure!(Instant::now() < deadline, "migration: {status}"),
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
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

fn count_in(path: &Path, needle: &str) -> usize {
    fs::read_to_string(path).map_or(0, |text| text.matches(needle).count())
}

/// Waits (10 s) until the console holds more lines with NEEDLE than
/// BEFORE: the agent says there what the gate holds.
async fn await_console(path: &Path, needle: &str, before: usize) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(10);
    while count_in(path, needle) <= before {
        ensure!(
            Instant::now() < deadline,
            "no {needle:?} on the console in 10 s"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    Ok(())
}

/// What the agent prints when it holds a request (snapshot.rs).
const HOLDING: &str = "cube-agent: snapshot: holding channel";

/// An exec request on a channel of its own, not waited for: the answer
/// comes on the receiver.
async fn exec_held(
    ch: &Channel,
    id: &str,
    command: &str,
    epoch: i64,
) -> Result<(u32, oneshot::Receiver<Answer>)> {
    let header = json!({"id": id, "epoch": epoch, "command": command, "timeoutMs": 60000});
    ch.start(
        None,
        Op::Guest(proto::GuestRequest {
            op: "exec".into(),
            data: format!("{header}\n").into_bytes(),
        }),
    )
    .await
}

/// snapshot_prepare, an exec that must be held, `stop`, a `migrate` to a
/// file QEMU cannot create (the save fails), `cont`, `snapshot_done`: the
/// held exec runs then.
async fn save_that_fails(ch: &Channel, m: &Machine, dir: &Path, epoch: i64) -> Result<Value> {
    let t = Instant::now();
    let (answer, status) = ch.prepare().await?;
    ensure!(
        prepared(&answer, &status),
        "the prepare: {answer:?} {status:?}"
    );
    let prepare_ms = t.elapsed().as_millis();
    let before = count_in(&m.console, HOLDING);
    let (_, mut held) = exec_held(ch, "held-released", "echo released > released", epoch).await?;
    await_console(&m.console, HOLDING, before).await?;
    let mut qmp = Qmp::open(&m.qmp).await?;
    qmp.execute("stop", Value::Null).await?;
    migration_mode(&mut qmp).await?;
    let nowhere = dir.join("no-such-directory").join("memory");
    let migrated = match qmp
        .execute(
            "migrate",
            json!({"uri": format!("file:{}", nowhere.display())}),
        )
        .await
    {
        Ok(_) => await_migration(&mut qmp).await,
        Err(error) => Err(error),
    };
    let Err(migrate_error) = migrated else {
        bail!("the migrate to {} did not fail", nowhere.display());
    };
    ensure!(
        matches!(held.try_recv(), Err(oneshot::error::TryRecvError::Empty)),
        "the held exec was answered while prepared"
    );
    qmp.execute("cont", Value::Null).await?;
    drop(qmp);
    let done = ch.request(Op::SnapshotDone(proto::Empty {})).await?;
    let status = ch.info("status", TIMEOUT).await?;
    ensure!(
        matches!(done, Answer::Done(_)) && status.ready,
        "snapshot_done: {done:?} {status:?}"
    );
    let answer = tokio::time::timeout(TIMEOUT, held)
        .await
        .map_err(|_| anyhow!("the held exec had no answer after snapshot_done"))??;
    let Answer::Guest(bytes) = &answer else {
        bail!("the held exec: {answer:?}");
    };
    ensure!(
        bytes.starts_with(br#"{"state":"Running"}"#),
        "the held exec: {}",
        String::from_utf8_lossy(bytes)
    );
    let (state, _) = ch.settle("held-released").await?;
    let (_, out) = ch.run("released-out", "cat released", epoch).await?;
    ensure!(
        state["state"] == "Succeeded" && out == "released\n",
        "the held exec ran: {state} {out:?}"
    );
    Ok(
        json!({"prepareMs": prepare_ms, "migrateError": format!("{migrate_error:#}"), "held": "ran after snapshot_done"}),
    )
}

fn prepared(answer: &Answer, status: &Option<proto::GuestInfo>) -> bool {
    matches!(answer, Answer::Done(_))
        && status
            .as_ref()
            .is_some_and(|status| !status.ready && status.reason == "prepared for a snapshot")
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
        ca_pem: TEST_CA.into(),
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
    let documents: &[(&str, &[u8])] = &[
        ("hostname", b"keel-check\n"),
        ("env", env),
        ("hooks/pre-resume", PRE_RESUME),
    ];
    if lab.o.only_snapshot {
        let same = same_snapshot(&lab, &image_disk, &image_layers, documents).await?;
        fs::write(
            lab.o.out.join("results.json"),
            serde_json::to_string_pretty(&json!({
                "qemu": {"path": lab.o.qemu, "version": version, "machine": machine_type, "accel": lab.o.accel, "vmgenid": lab.o.vmgenid},
                "arch": lab.o.arch,
                "kernel": {"path": lab.o.kernel, "sha256": sha256_file(&lab.o.kernel)?},
                "base": {"path": lab.o.base, "sha256": sha256_file(&lab.o.base)?},
                "sameSnapshot": same,
            }))?,
        )?;
        println!(
            "keel agent check: {} {}, QEMU {version} {machine_type}; check 83 (the same snapshot restored twice) passed",
            lab.o.arch, lab.o.accel
        );
        return Ok(());
    }

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
            hello.capabilities
                == [
                    "exec.start",
                    "exec.cancel",
                    "operation.get",
                    "fs.read",
                    "fs.write",
                    "fs.stat",
                    "fs.absolute",
                    "services.list",
                    "portal.configure",
                ],
            "hello advertises exec, cancel, get, the file operations, services and the portal (no install)",
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
                && status.reason == "the image lacks bash, sudo, flock, git, gh, curl, a CA bundle, a place for /etc/sudoers.d/cube",
            "an image without cube's tools is not ready, and status says what it lacks (the tools, a CA bundle, a place for a file cube binds)",
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
    // What the first boot saw of the `keep` service (checked after the second).
    let (keep_started, keep_before, keep_after): (String, String, String);
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

        // The Workspace contract (leases, files, commands), over this channel. Its lease
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
                "the Workspace contract (leases, files, commands, services, the resume hook) passes over DaemonFrame",
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
            session: String::new(),
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

        // K-5c: a service started with `cube` runs across the agent's restart.
        ch.run(
            "svc-script",
            &format!("mkdir -p svc && cat > svc/server.pl <<'EOF'\n{SERVICE_SCRIPT}EOF\n"),
            epoch,
        )
        .await?;
        (_, keep_started) = ch.run("svc-keep", "cube service start keep --port 8101 --cwd svc --json -- perl server.pl; echo \"exit=$?\"", epoch).await?;
        (_, keep_before) = ch.run("svc-keep-pid", SERVICE_PID, epoch).await?;

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
        (_, keep_after) = ch
            .run(
                "svc-keep-after",
                &format!("{SERVICE_PID}; cube service status keep --json"),
                epoch,
            )
            .await?;
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
        // A file written with the file operations, read again after the boot.
        let (kept, _) = ch.file("write", json!({"id": "fw-kept", "epoch": epoch, "path": "files/kept.txt", "createParents": true}), token.as_bytes()).await?;
        ensure!(kept.get("error").is_none(), "write files/kept.txt: {kept}");
        ch.run("sync", "sync", epoch).await?;
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
    let mut restore = json!({});
    let mut snapshot = json!({});
    let failed_save_error: Option<String>;
    let restored_sessions: Result<usize, String>;
    let clock;
    {
        let m = lab.start(&dir, &image_disk)?;
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

        // After the idle sample above: `cube` calls cost the agent CPU.
        let (_, keep_boot) = ch.run("svc-boot", &format!("{WAIT_LISTENING}; {SERVICE_PID}; cube service status keep --json; cube service logs keep -n 50"), epoch).await?;

        // The runner closes its socket and connects again 2 s later.
        let (before, _) = ch.agent_cpu("cpu-connected", epoch).await?;
        close(ch).await?;
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

        // The runner connects again right after its socket closed. The guest
        // may learn of both at once; the agent then reads no EOF and says no
        // hello. So each connect keeps the runner's rule (hello_or_reset),
        // and every one must recover. How many got the plain hello is
        // information only.
        let mut ch = ch;
        let (mut hellos, mut resets, mut late) = (0, 0, 0);
        let mut failed = None;
        for i in 0..RECONNECTS {
            close(ch).await?;
            ch = Channel::open(&m.ctl).await?;
            let connected = Instant::now();
            match ch
                .hello_or_reset(lab.o.control != Some(Control::Reconnect))
                .await
            {
                Ok((hello, _)) if hello.ready || hello.epoch != epoch => {
                    failed = Some(format!("reconnect {i}: {hello:?}"));
                }
                Ok((_, reset)) => *(if reset { &mut resets } else { &mut hellos }) += 1,
                Err(error) => {
                    let after = connected.elapsed();
                    failed = Some(format!("reconnect {i}: {error:#} ({after:?})"));
                }
            }
            if failed.is_some() {
                break;
            }
            match ch
                .setup_after_hello(|| setup(&image_layers, documents))
                .await
            {
                Ok(n) => late += n,
                Err(error) => {
                    failed = Some(format!("reconnect {i}: setup: {error:#}"));
                    break;
                }
            }
        }
        log(&format!(
            "immediate reconnect: {hellos} of {RECONNECTS} had the plain hello, {resets} the reset on channel 0, {late} a late hello"
        ));
        idle["immediateReconnect"] = json!({"tries": RECONNECTS, "hellos": hellos, "resets": resets, "lateHellos": late, "reset": lab.o.control != Some(Control::Reconnect)});
        checks.ok(
            hellos + resets == RECONNECTS,
            "the runner connects again at once, 10 times: a fresh hello each time (not ready, epoch kept), after a reset on channel 0 when none came in 500 ms",
            failed.as_deref().unwrap_or_default(),
        )?;
        let (_, output) = ch.run("immediate", "cat persist", epoch).await?;
        checks.ok(
            output == format!("{token}\n"),
            "after each of those reconnects a setup makes the agent ready; commands work",
            &output,
        )?;

        // 4. A late hello, forced: right after a plain hello the runner
        // sends the reset on channel 0 and then machine_setup at once. The
        // agent reads the reset first and ends that connection, so its next
        // hello comes while the setup waits: the setup goes again on a new
        // channel (setup_after_hello's late branch), deterministically.
        close(ch).await?;
        let ch = Channel::open(&m.ctl).await?;
        let (hello, _) = ch.hello_or_reset(true).await?;
        let force = lab.o.control != Some(Control::LateHello);
        if force {
            ch.reset().await?;
        }
        let late = ch
            .setup_after_hello(|| setup(&image_layers, documents))
            .await;
        let output = match &late {
            Ok(_) => ch.run("late-hello", "cat persist", epoch).await?.1,
            Err(_) => String::new(),
        };
        restore["lateHello"] = json!({"lateHellos": late.as_ref().ok(), "reset": force});
        checks.ok(
            !hello.ready
                && late.as_ref().is_ok_and(|n| *n == 1)
                && output == format!("{token}\n"),
            "a reset right after hello, then machine_setup at once: the next hello comes while the setup waits; the setup goes again on a new channel, its status makes the agent ready and commands work",
            format!("late hellos {late:?}, output {output:?}"),
        )?;

        // 5. Restores. The runner saves the machine with its socket still
        // connected, starts a new QEMU with -incoming defer and connects to
        // it before migrate-incoming and cont. QEMU's post-load path sends
        // the guest no port event then (the host end was connected at the
        // save and is again), so the agent reads no EOF and says no hello by
        // itself. The runner's rule brings it: hello within 500 ms of cont,
        // else the reset on channel 0 and hello within 2 s, else unhealthy;
        // nothing else before the hello. Then machine_setup, ready from its
        // status, and the command that ran at the save is found by its key.
        // Before each save the runner sends snapshot_prepare: the agent
        // answers done once settled and holds what comes after it until
        // snapshot_done or the end of the connection. First a save that
        // fails, so the machine goes on: snapshot_done lets the held
        // operation run (its check comes last, after the templates).
        let failed_save = save_that_fails(&ch, &m, &dir, epoch).await;
        if failed_save.is_err() {
            // Leave the machine running and let go, whatever happened.
            if let Ok(mut qmp) = Qmp::open(&m.qmp).await {
                let _ = qmp.execute("cont", Value::Null).await;
            }
            let _ = ch
                .request_on(
                    None,
                    Op::SnapshotDone(proto::Empty {}),
                    Duration::from_secs(10),
                )
                .await;
        }
        log(&format!("a save that fails: {failed_save:?}"));
        failed_save_error = failed_save.as_ref().err().map(|error| format!("{error:#}"));
        snapshot["failedSave"] = match &failed_save {
            Ok(value) => value.clone(),
            Err(error) => json!({"error": format!("{error:#}")}),
        };
        // In memory only: a restore keeps it, a boot would not.
        ch.run(
            "shm-mark",
            &format!("mkdir -p /dev/shm/cube-check && echo {token} > /dev/shm/cube-check/mark"),
            epoch,
        )
        .await?;

        let boot_id = hello.boot_id.clone();
        let reset = lab.o.control != Some(Control::Restore);
        let prepare = lab.o.control != Some(Control::Prepare);
        let (mut ch, mut m) = (ch, m);
        let mut restores: Vec<Value> = vec![];
        // Every session this machine's agent started so far; a restore's
        // must be new although its memory (and random state) is the save's.
        let mut sessions = vec![ch.session.lock().unwrap().clone()];
        let mut session_failure: Option<String> = None;
        // (which check, why); the loop stops at the first failure.
        let mut failed: Option<(u8, String)> = None;
        for i in 0..RESTORES {
            let key = format!("tick-{i}");
            let (started, _) = ch.guest("exec", json!({"id": key, "epoch": epoch, "command": format!("i=0; while [ $i -lt 50 ]; do i=$((i+1)); echo $i > {key}; sleep 0.1; done; printf ticked"), "timeoutMs": 60000})).await?;
            ensure!(started["state"] == "Running", "exec {key}: {started}");
            tokio::time::sleep(Duration::from_millis(500)).await;
            // snapshot_prepare, then an operation the agent must hold: the
            // save ends the connection, so it never runs.
            let t = Instant::now();
            if prepare {
                let (answer, status) = ch.prepare().await?;
                if !prepared(&answer, &status) {
                    failed = Some((
                        1,
                        format!("restore {i}: the prepare: {answer:?} {status:?}"),
                    ));
                    break;
                }
            }
            let prepare_ms = t.elapsed().as_millis();
            let held_key = format!("held-{i}");
            let before = count_in(&m.console, HOLDING);
            let (_, mut held) =
                exec_held(&ch, &held_key, &format!("echo ran > {held_key}"), epoch).await?;
            if let Err(error) = await_console(&m.console, HOLDING, before).await {
                failed = Some((2, format!("restore {i}: {held_key}: {error:#}")));
                break;
            }
            if !matches!(held.try_recv(), Err(oneshot::error::TryRecvError::Empty)) {
                failed = Some((
                    2,
                    format!("restore {i}: {held_key} was answered while prepared"),
                ));
                break;
            }
            let memory = dir.join("memory");
            let saved = save(&mut m, &memory).await?;
            close(ch).await?;
            // Saved for a while: the guest's clock stands still meanwhile, so
            // its realtime is behind by more than CLOCK_TOLERANCE until the
            // agent syncs it with the host's.
            tokio::time::sleep(PAUSE).await;
            let file = fs::metadata(&memory)?;
            m = lab.start_with(&dir, &image_disk, &["-S", "-incoming", "defer"])?;
            // Connected before migrate-incoming and cont.
            ch = Channel::open(&m.ctl).await?;
            let mut qmp = Qmp::open(&m.qmp).await?;
            let t = Instant::now();
            migration_mode(&mut qmp).await?;
            qmp.execute(
                "migrate-incoming",
                json!({"uri": format!("file:{}", memory.display())}),
            )
            .await?;
            await_migration(&mut qmp).await?;
            let loaded = t.elapsed();
            qmp.execute("cont", Value::Null).await?;
            let resumed = Instant::now();
            let got = ch.hello_or_reset(reset).await;
            let hello_ms = resumed.elapsed().as_millis();
            let host_at_hello = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs_f64();
            let early = ch.sent_before_hello();
            fs::remove_file(&memory)?;
            let (hello, was_reset) = match got {
                Ok(got) => got,
                Err(error) => {
                    failed = Some((
                        1,
                        format!("restore {i}: {error:#} ({hello_ms} ms after cont)"),
                    ));
                    break;
                }
            };
            let allowed: &[&str] = if was_reset {
                &["ch 0 req guest.hello"]
            } else {
                &[]
            };
            if hello.ready
                || hello.reason != "waiting for machine_setup"
                || hello.epoch != epoch
                || hello.boot_id != boot_id
                || early != allowed
            {
                failed = Some((
                    1,
                    format!("restore {i}: {hello:?}; sent before it: {early:?}"),
                ));
                break;
            }
            // A new session, never one of this machine's before, and the
            // clock synced before the hello: `since` is the agent's realtime
            // when the session started.
            let since = hello
                .since
                .map_or(0.0, |t| t.seconds as f64 + t.nanos as f64 / 1e9);
            let clock_offset = since - host_at_hello;
            if !cube_runner_protocol::valid_session(&hello.session)
                || sessions.contains(&hello.session)
                || clock_offset.abs() > CLOCK_TOLERANCE
            {
                // Checked last (check 82), so the numbers before stay.
                session_failure.get_or_insert(format!(
                    "restore {i}: session {:?} after {sessions:?}; hello's since is {clock_offset:+.3} s from the host's time",
                    hello.session
                ));
            }
            sessions.push(hello.session.clone());
            // Answered at once, not held: the prepare ended with the old connection.
            let refused = ch
                .request_on(
                    None,
                    Op::Guest(proto::GuestRequest {
                        op: "exec".into(),
                        data: format!("{}\n", json!({"id": format!("early-{i}"), "epoch": epoch, "command": "true", "timeoutMs": 1000})).into_bytes(),
                    }),
                    Duration::from_secs(10),
                )
                .await;
            let late = ch
                .setup_after_hello(|| setup(&image_layers, documents))
                .await;
            let not_ready = matches!(&refused, Ok(Answer::Error(e)) if e.code == proto::Code::Unavailable as i32 && e.reason == "not_ready");
            if !not_ready || late.is_err() {
                failed = Some((
                    2,
                    format!("restore {i}: before the setup {refused:?}; the setup {late:?}"),
                ));
                break;
            }
            // The command running at the save still runs (Q1); the
            // operation held at the save never ran.
            let (ticking, _) = ch.guest("get", json!({"id": key})).await?;
            let (held_state, _) = ch.guest("get", json!({"id": held_key})).await?;
            let (_, held_file) = ch
                .run(
                    &format!("held-file-{i}"),
                    &format!("test -e {held_key} && echo ran || echo never"),
                    epoch,
                )
                .await?;
            if held_state != json!({"state": "Unknown"}) || held_file != "never\n" {
                failed = Some((
                    2,
                    format!("restore {i}: the held {held_key} {held_state}, file {held_file:?}"),
                ));
                break;
            }
            let (state, body) = ch.settle(&key).await?;
            let (_, persist) = ch
                .run(
                    &format!("persist-{i}"),
                    "cat persist /dev/shm/cube-check/mark",
                    epoch,
                )
                .await?;
            if ticking["state"] != "Running"
                || state["state"] != "Succeeded"
                || body != b"ticked"
                || persist != format!("{token}\n{token}\n")
            {
                failed = Some((
                    3,
                    format!(
                        "restore {i}: {key} {} then {state} {:?}, persist and mark {persist:?}",
                        ticking["state"],
                        String::from_utf8_lossy(&body)
                    ),
                ));
                break;
            }
            log(&format!(
                "restore {i}: save {} ms, load {} ms, hello {hello_ms} ms after cont{}",
                saved.as_millis(),
                loaded.as_millis(),
                if was_reset {
                    " (after the reset)"
                } else {
                    " (plain)"
                }
            ));
            restores.push(json!({
                "prepareMs": prepare_ms, "heldNeverRan": true,
                "saveMs": saved.as_millis(), "loadMs": loaded.as_millis(),
                "contToHelloMs": hello_ms, "reset": was_reset, "lateHellos": late.ok(),
                "session": hello.session, "helloClockOffsetS": clock_offset,
                "foreignFrames": ch.foreign.load(Ordering::SeqCst),
                "memoryFileMiB": file.len() / (1 << 20),
                "memoryOnDiskMiB": std::os::unix::fs::MetadataExt::blocks(&file) / 2048,
            }));
        }
        restored_sessions = match session_failure {
            Some(why) => Err(why),
            None => Ok(sessions.len() - 1),
        };
        let resets = restores.iter().filter(|r| r["reset"] == true).count();
        log(&format!(
            "restores: {} of {RESTORES}, {resets} needed the reset on channel 0",
            restores.len()
        ));
        restore["restores"] = json!({"tries": RESTORES, "done": restores.len(), "resets": resets, "reset": reset, "each": restores});
        let detail = failed
            .as_ref()
            .map(|(_, why)| why.as_str())
            .unwrap_or_default();
        checks.ok(
            failed.as_ref().is_none_or(|(k, _)| *k != 1),
            "restored into a new QEMU with the runner connected before cont, 3 times: before each save snapshot_prepare is answered done and the status says not ready (prepared for a snapshot); after it hello (same boot, not ready, waiting for machine_setup, epoch kept) within 500 ms of cont, or within 2 s of the reset on channel 0; the runner sent nothing else before it",
            detail,
        )?;
        checks.ok(
            failed.as_ref().is_none_or(|(k, _)| *k != 2),
            "an operation sent after snapshot_prepare is held (no answer; the agent says so) and never runs (its key unknown after the restore, no file); after each restore guest operations are answered at once UNAVAILABLE/not_ready until machine_setup, and the status after its answer says ready",
            detail,
        )?;
        checks.ok(
            failed.is_none() && restores.len() == RESTORES,
            "after each restore the command running at the save is still running, is found by its key and finishes; the disk is the one saved and /dev/shm is kept (a restore is not a boot)",
            detail,
        )?;

        // File operations (K-5b) over the channel, as cube-guest's: they
        // stay in the workload root, and out of the workspace they have the
        // agent account's permissions.
        let (hello, _) = ch.guest("hello", json!({})).await?;
        let advertised = ["fs.read", "fs.write", "fs.stat", "fs.absolute"]
            .iter()
            .all(|c| {
                hello["capabilities"]
                    .as_array()
                    .is_some_and(|a| a.contains(&json!(c)))
            });
        let (kept, kept_body) = ch.guest("read", json!({"path": "files/kept.txt"})).await?;
        let (again, _) = ch.file("write", json!({"id": "fw-kept", "epoch": epoch, "path": "files/kept.txt", "createParents": true}), token.as_bytes()).await?;
        let (new, _) = ch
            .file(
                "write",
                json!({"id": "fw-new", "epoch": epoch, "path": "files/new.txt"}),
                b"k5b\n",
            )
            .await?;
        let (read, read_body) = ch
            .guest("read", json!({"path": "/workspace/files/new.txt"}))
            .await?;
        let (stat, _) = ch.guest("stat", json!({"path": "files/new.txt"})).await?;
        let (_, seen) = ch
            .run(
                "fw-seen",
                "stat -c '%U %a' files/new.txt; cat files/new.txt",
                epoch,
            )
            .await?;
        let token_sha = hex(&Sha256::digest(token.as_bytes()));
        checks.ok(
            advertised
                && kept_body == token.as_bytes()
                && kept["sha256"] == token_sha.as_str()
                && again == json!({"sha256": token_sha, "size": token.len()})
                && new.get("error").is_none()
                && read_body == b"k5b\n"
                && read["sha256"] == new["sha256"]
                && stat["kind"] == "file"
                && stat["sha256"] == new["sha256"]
                && seen == "agent 644\nk5b\n",
            "file operations over DaemonFrame (fs.read, fs.write, fs.stat, fs.absolute advertised): a write before the power-off reads back after the boot and the restores and its key returns its result; a new write reads back, stats the same and belongs to agent",
            format!("{hello} | {kept} | {again} | {new} | {read} | {stat} | {seen:?}"),
        )?;

        ch.run("fw-links", "ln -sfn /run/keel/setup.json files/base-link; ln -sfn / files/root-link; ln -sfn ../../../../../.. files/up-link; echo workload | sudo -n tee /etc/k5b-root >/dev/null", epoch).await?;
        let code = |answer: &Value| answer["error"]["code"].as_str().unwrap_or("").to_string();
        let (base_link, _) = ch.guest("read", json!({"path": "files/base-link"})).await?;
        let (base_dir, _) = ch.guest("stat", json!({"path": "/run/keel"})).await?;
        let (via_root, via_root_body) = ch
            .guest("read", json!({"path": "files/root-link/etc/k5b-root"}))
            .await?;
        let (via_up, via_up_body) = ch
            .guest("read", json!({"path": "files/up-link/etc/k5b-root"}))
            .await?;
        let mut pseudo = vec![];
        for path in [
            "/proc/1/environ",
            "/sys/kernel/hostname",
            "/dev/vda",
            "files/root-link/proc/self/status",
        ] {
            pseudo.push(code(&ch.guest("read", json!({"path": path})).await?.0));
        }
        pseudo.push(code(
            &ch.file(
                "write",
                json!({"id": "fw-dev", "epoch": epoch, "path": "/dev/null"}),
                b"x",
            )
            .await?
            .0,
        ));
        let (dotdot, _) = ch
            .guest("read", json!({"path": "files/../../etc/k5b-root"}))
            .await?;
        checks.ok(
            code(&base_link) == "NOT_FOUND"
                && code(&base_dir) == "NOT_FOUND"
                && via_root.get("error").is_none()
                && via_root_body == b"workload\n"
                && via_up.get("error").is_none()
                && via_up_body == b"workload\n"
                && pseudo.iter().all(|c| c == "INVALID_REQUEST")
                && code(&dotdot) == "INVALID_REQUEST",
            "file operations stay in the workload root: absolute and upward links name the workload's files, the base root (/run/keel) is out of reach, /proc /sys /dev and .. are refused",
            format!("{base_link} | {base_dir} | {via_root} | {via_up} | {pseudo:?} | {dotdot}"),
        )?;

        let (etc, _) = ch
            .file(
                "write",
                json!({"id": "fw-etc", "epoch": epoch, "path": "/etc/k5b-denied"}),
                b"x",
            )
            .await?;
        let (etc_link, _) = ch.file("write", json!({"id": "fw-etc-link", "epoch": epoch, "path": "files/root-link/etc/k5b-denied"}), b"x").await?;
        let (tmp, _) = ch.file("write", json!({"id": "fw-tmp", "epoch": epoch, "path": "/tmp/k5b/x", "createParents": true}), b"x").await?;
        let (home, _) = ch.file("write", json!({"id": "fw-home", "epoch": epoch, "path": "/home/agent/k5b/y", "createParents": true}), b"y").await?;
        let (_, owners) = ch.run("fw-owners", "test ! -e /etc/k5b-denied && echo absent; stat -c %U /tmp/k5b /tmp/k5b/x /home/agent/k5b /home/agent/k5b/y", epoch).await?;
        let denied = |answer: &Value| {
            code(answer) == "IO_ERROR"
                && answer["error"]["message"]
                    .as_str()
                    .is_some_and(|m| m.starts_with("permission denied"))
        };
        checks.ok(
            denied(&etc)
                && denied(&etc_link)
                && tmp.get("error").is_none()
                && home.get("error").is_none()
                && owners == "absent\nagent\nagent\nagent\nagent\n",
            "out of the workspace file operations have the agent account's permissions: /etc is refused (also through a workspace link) and nothing is written; what they make in /tmp and /home/agent is agent's",
            format!("{etc} | {etc_link} | {tmp} | {home} | {owners:?}"),
        )?;

        // Services (K-5c): `cube` in the workload, over the agent socket.
        let (_, keep_restored) = ch
            .run(
                "svc-restored",
                &format!("{SERVICE_PID}; cube service status keep --json"),
                epoch,
            )
            .await?;
        let (hello, _) = ch.guest("hello", json!({})).await?;
        let (_, cli) = ch.run("svc-cli", "{ stat -c '%a %U' /usr/local/bin/cube; sha256sum < /usr/local/bin/cube | cut -c1-64; sudo -n touch /usr/local/bin/cube 2>&1 | grep -o 'Read-only file system'; sudo -n cube service list --json >/dev/null; echo root=$?; sudo -n -u nobody cube service list; echo nobody=$?; } 2>&1 | grep -v 'unable to resolve host'", epoch).await?;
        let pid = |output: &str| output.lines().next().unwrap_or_default().trim().to_string();
        let first_pid = pid(&keep_before);
        let (_, environ) = ch.run("svc-environ", &format!("stat -c %U /proc/{p}; cat /proc/{p}/cgroup; sudo -n cat /proc/{p}/environ 2>/dev/null | tr '\\0' '\\n' | grep -E '^(PORT|HOST|CUBE_SERVICE)=' | sort", p = pid(&keep_restored)), epoch).await?;
        let status_of = |output: &str| -> Value {
            output
                .lines()
                .find(|line| line.starts_with('{'))
                .and_then(|line| serde_json::from_str(line).ok())
                .unwrap_or(Value::Null)
        };
        let started = status_of(&keep_started);
        checks.ok(
            cli.lines().collect::<Vec<_>>()
                == [
                    "755 root",
                    hello["build"].as_str().unwrap_or("?"),
                    "Read-only file system",
                    "root=0",
                    "cube: only the agent account and root may use cube service",
                    "nobody=1",
                ],
            "cube in the workload is the agent's own binary, read-only; the agent account and root may use it, other accounts are refused",
            &cli,
        )?;
        let after = status_of(&keep_after);
        checks.ok(
            started["ok"] == true
                && keep_started.ends_with("exit=0\n")
                && !first_pid.is_empty()
                && pid(&keep_after) == first_pid
                && after["state"] == "active"
                && after["listening"] == true
                && after["restarts"] == 0
                && environ == "agent\n0::/cube-services/keep\nCUBE_SERVICE=keep\nHOST=0.0.0.0\nPORT=8101\n",
            "a service started with cube runs as agent in its own cgroup with PORT, HOST and CUBE_SERVICE; it runs on across an agent restart (found again, not started twice) and cube answers again",
            format!("{keep_started} | {keep_before} | {keep_after} | {environ:?}"),
        )?;
        let boot = status_of(&keep_boot);
        let restored = status_of(&keep_restored);
        checks.ok(
            boot["state"] == "active"
                && boot["listening"] == true
                && boot["restarts"] == 0
                && pid(&keep_boot) != first_pid
                && keep_boot.matches("listening on 8101 as keep").count() == 2
                && pid(&keep_restored) == pid(&keep_boot)
                && restored["listening"] == true,
            "a registered service starts again after the boot once machine_setup has assembled the root, and runs on across the restores; its log is kept across the boot",
            format!("{keep_boot} | {keep_restored}"),
        )?;
        let (_, restarted) = ch.run("svc-kill", &format!("sudo -n kill -9 {p} 2>/dev/null; for i in $(seq 100); do sleep 0.2; s=$(cube service status keep --json); case $s in *'\"restarts\":1'*) case $s in *'\"listening\":true'*) break;; esac;; esac; done; {SERVICE_PID}; cube service status keep --json", p = pid(&keep_restored)), epoch).await?;
        let (_, flaky) = ch.run("svc-flaky", "cube service start flaky --port 8102 --wait 2 -- 'echo flaky; exit 3'; echo exit=$?; for i in $(seq 150); do sleep 0.2; cube service status flaky --json | grep -q '\"state\":\"failed\"' && break; done; cube service status flaky --json", epoch).await?;
        let (_, once) = ch.run("svc-once", "cube service start once --port 8103 --wait 5 -- 'echo once'; echo exit=$?; sleep 3; cube service status once --json", epoch).await?;
        let killed = status_of(&restarted);
        let flaky_status = status_of(flaky.lines().last().unwrap_or_default());
        let once_status = status_of(once.lines().last().unwrap_or_default());
        checks.ok(
            killed["restarts"] == 1
                && killed["listening"] == true
                && !pid(&restarted).is_empty()
                && pid(&restarted) != pid(&keep_restored)
                && flaky.contains("service flaky is registered but not healthy")
                && flaky.contains("exit=1")
                && flaky_status["state"] == "failed"
                && flaky_status["restarts"] == 4
                && once.contains("the service stopped (dead)")
                && once_status["state"] == "inactive"
                && once_status["restarts"] == 0,
            "a killed service is started again (1 restart, a new process); one that keeps failing stops after 5 starts in a minute (failed, 4 restarts); one that exits 0 is not restarted",
            format!("{restarted} | {flaky} | {once}"),
        )?;
        let (portal, _) = ch
            .guest(
                "portal",
                json!({"portal": {"urlTemplate": "http://{name}-0123456789.keel-check.example/"}}),
            )
            .await?;
        let (listed, _) = ch.guest("services", json!({"probe": true})).await?;
        let (_, stopped) = ch
            .run(
                "svc-stop",
                "for s in keep flaky once; do cube service stop $s; done; cube service list",
                epoch,
            )
            .await?;
        let (empty, _) = ch.guest("services", json!({})).await?;
        let keep = listed["services"]
            .as_array()
            .and_then(|all| all.iter().find(|s| s["name"] == "keep"))
            .cloned()
            .unwrap_or(Value::Null);
        checks.ok(
            portal == json!({"urlTemplate": "http://{name}-0123456789.keel-check.example/"})
                && keep["url"] == "http://keep-0123456789.keel-check.example/"
                && keep["state"] == "active"
                && keep["listening"] == true
                && keep["command"] == "perl server.pl"
                && keep["cwd"] == "/workspace/svc"
                && listed["services"].as_array().map(Vec::len) == Some(3)
                && stopped == "service keep stopped\nservice flaky stopped\nservice once stopped\nno services\n"
                && empty == json!({"services": []}),
            "the services and portal operations: the registered services with their state, whether they listen and their URL from the portal settings; cube service stop removes them",
            format!("{portal} | {listed} | {stopped:?} | {empty}"),
        )?;

        // K-5d: what keel writes for cube (generated files, the runner's CA,
        // git's credential helper), the hooks, and the clock.
        let (_, files) = ch
            .run(
                "k5d-files",
                "cat /etc/hostname; grep -c . /etc/hosts; grep -x '127.0.1.1.keel-check' /etc/hosts; grep nameserver /etc/resolv.conf; \
                 stat -c '%U %a' /etc/sudoers.d/cube /etc/cube/env /etc/cube/hooks/pre-resume; \
                 sudo -n true 2>&1 | wc -c; sudo -n touch /etc/cube/x 2>&1 | grep -c 'Read-only file system'; \
                 awk '$5 == \"/etc/hosts\" || $5 == \"/etc/hostname\" || $5 == \"/etc/resolv.conf\" || $5 == \"/etc/sudoers.d/cube\" || $5 == \"/etc/cube\" {print $5}' /proc/self/mountinfo | sort | tr '\\n' ' '; echo; \
                 grep -cx 'GH_TOKEN=cube_ph_github_keelcheck' /etc/cube/env; cmp -s /etc/cube/hooks/pre-resume - <<'EOF' && echo hook-is-document\n#!/bin/bash\necho \"pre-resume as $(id -un) in $(pwd) token=$GH_TOKEN\"\nEOF",
                epoch,
            )
            .await?;
        checks.ok(
            files
                == "keel-check\n3\n127.0.1.1\tkeel-check\nnameserver 192.168.127.1\nroot 440\nroot 644\nroot 755\n0\n1\n/etc/cube /etc/hostname /etc/hosts /etc/resolv.conf /etc/sudoers.d/cube \n1\nhook-is-document\n",
            "generated files: /etc/hosts (localhost and the hostname, so sudo resolves it), /etc/hostname, /etc/resolv.conf and /etc/sudoers.d/cube bound over their paths; /etc/cube read-only with cube's env and the pre-resume document",
            format!("{files:?}"),
        )?;

        let ca_head = "MIIByTCCAW+gAwIBAgIU";
        let ca_script = format!(
            "b=$SSL_CERT_FILE; echo $b; [ \"$NODE_EXTRA_CA_CERTS $REQUESTS_CA_BUNDLE $CURL_CA_BUNDLE\" = \"$b $b $b\" ] && echo variables; \
             grep -c '^# cube: begin' $b; grep -c '{ca_head}' $b; \
             sed -n '/^# cube: begin/,/^# cube: end/p' $b | sed '1d;$d' | cmp -s - /etc/cube/ca.pem && echo block-is-ca; \
             cmp -s /etc/cube/ca.pem /usr/local/share/ca-certificates/cube-runner.crt && echo crt; \
             grep -c \"^SSL_CERT_FILE=$b$\" /etc/environment; sudo -n sh -c 'echo $SSL_CERT_FILE'"
        );
        let (_, ca) = ch.run("k5d-ca", &ca_script, epoch).await?;
        let bundle = ca.lines().next().unwrap_or_default().to_string();
        let ca_ok = !bundle.is_empty()
            && ca == format!("{bundle}\nvariables\n1\n1\nblock-is-ca\ncrt\n1\n{bundle}\n");
        // update-ca-certificates writes the bundle again: the CA stays (from
        // cube-runner.crt), and the next setup puts cube's block back once.
        let (_, updated) = ch
            .run(
                "k5d-update-ca",
                &format!("sudo -n update-ca-certificates >/dev/null 2>&1; echo $?; grep -c '^# cube: begin' $SSL_CERT_FILE; grep -c '{ca_head}' $SSL_CERT_FILE"),
                epoch,
            )
            .await?;
        let done = ch.request(setup(&image_layers, documents)).await?;
        let status = ch.info("status", TIMEOUT).await?;
        let (_, again) = ch.run("k5d-ca-again", &ca_script, epoch).await?;
        checks.ok(
            ca_ok
                && updated == "0\n0\n1\n"
                && matches!(done, Answer::Done(_))
                && status.ready
                && again == format!("{bundle}\nvariables\n1\n2\nblock-is-ca\ncrt\n1\n{bundle}\n"),
            "the runner's CA: in the image's bundle once between cube's markers, in /etc/cube/ca.pem and cube-runner.crt; the CA variables name the bundle, also through sudo; after update-ca-certificates it stays, and the next setup puts the block back once",
            format!("{ca:?} | {updated:?} | {done:?} | {again:?}"),
        )?;

        let (_, git) = ch
            .run(
                "k5d-git",
                "printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill; git config --system init.defaultBranch; echo $GH_PROMPT_DISABLED",
                epoch,
            )
            .await?;
        checks.ok(
            git == "protocol=https\nhost=github.com\nusername=x-access-token\npassword=cube_ph_github_keelcheck\nmain\n1\n",
            "git's credential helper for github.com (cube's block in /etc/gitconfig) answers with the placeholder; keel's own lines are in the environment",
            format!("{git:?}"),
        )?;

        // The hooks: the contract ran cubed's resume script, which ran the
        // pre-resume document; the agent reports what is in this machine.
        let contract = lab.o.contract.is_some();
        let _ = ch.request(setup(&image_layers, documents)).await?;
        let status = ch.info("status", TIMEOUT).await?;
        let reported: BTreeMap<String, String> = status.hooks.clone().into_iter().collect();
        let (_, shown) = ch
            .run("k5d-hooks", "cube hooks --json -n 5; cube hooks | tail -n 1; cube hooks -n 999 2>&1; echo \"exit=$?\"", epoch)
            .await?;
        let mut shown_lines = shown.lines();
        let views: Value =
            serde_json::from_str(shown_lines.next().unwrap_or_default()).unwrap_or(Value::Null);
        let rest: Vec<&str> = shown_lines.collect();
        let view = |name: &str| {
            views["hooks"]
                .as_array()
                .and_then(|all| all.iter().find(|v| v["name"] == name))
                .cloned()
                .unwrap_or(Value::Null)
        };
        let pre = view("pre-resume");
        let ran = "pre-resume as agent in /workspace token=cube_ph_github_keelcheck";
        let expected: BTreeMap<String, String> = if contract {
            [("pre-resume", "ok"), ("resume", "absent")]
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .into()
        } else {
            BTreeMap::new()
        };
        checks.ok(
            reported == expected
                && views["hooks"].as_array().map(Vec::len) == Some(4)
                && pre["present"] == true
                && pre["path"] == "/etc/cube/hooks/pre-resume"
                && pre["sha256"] == hex(&Sha256::digest(PRE_RESUME)).as_str()
                && view("setup")["present"] == false
                && (if contract {
                    pre["last"]["status"] == "ok" && pre["logTail"] == ran
                } else {
                    pre["last"].is_null()
                })
                && rest
                    == [
                        "the project's hooks are changed in cube's projects, not here; see cube hooks --help",
                        "cube hooks: -n is 0-200 lines",
                        "exit=2",
                    ],
            "the hooks: cube hooks shows the project's pre-resume (the boot document), its last outcome and log from ~/.cache/cube (it ran as agent in /workspace with the placeholder); status.guest.hooks has the outcomes",
            format!("{reported:?} | {shown:?}"),
        )?;

        let mut bad = setup(&image_layers, documents);
        if let Op::MachineSetup(s) = &mut bad {
            s.ca_pem =
                "-----BEGIN CERTIFICATE-----\nnot base64!\n-----END CERTIFICATE-----\n".into();
        }
        let refused = ch.request(bad).await?;
        let not_ready = ch.info("status", TIMEOUT).await?;
        let _ = ch.request(setup(&image_layers, documents)).await?;
        let ready = ch.info("status", TIMEOUT).await?;
        checks.ok(
            refusal(&refused) == Some((proto::Code::InvalidArgument as i32, "bad_ca".into()))
                && !not_ready.ready
                && ready.ready,
            "a setup whose CA is not PEM certificates is refused (bad_ca) and the machine is not ready until a good one",
            format!("{refused:?} {not_ready:?}"),
        )?;

        // The clock: the guest's clocks stop while the machine is paused;
        // the agent follows the host's PTP clock and puts realtime right
        // within its interval of cont.
        // The agent says which clock it follows when it starts (this boot's
        // first console; a restored QEMU writes a new one).
        let mut consoles = vec![];
        for boot in 1.. {
            match fs::read_to_string(dir.join(format!("console-{boot}.log"))) {
                Ok(text) => consoles.push(text),
                Err(_) => break,
            }
        }
        let source = consoles
            .iter()
            .flat_map(|text| text.lines())
            .filter_map(|line| line.split("cube-agent: clock: ").nth(1))
            .filter(|said| !said.starts_with("stepped"))
            .next_back()
            .unwrap_or("no line from the agent")
            .to_string();
        let before = ch.clock_offset("clock-before", epoch).await?;
        let mut qmp = Qmp::open(&m.qmp).await?;
        qmp.execute("stop", Value::Null).await?;
        tokio::time::sleep(PAUSE).await;
        qmp.execute("cont", Value::Null).await?;
        // QEMU serves one QMP client at a time; `quit` below opens its own.
        drop(qmp);
        let at_cont = ch.clock_offset("clock-cont", epoch).await?;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let after = ch.clock_offset("clock-after", epoch).await?;
        clock = json!({"source": source, "beforeS": before, "pausedS": PAUSE.as_secs_f64(), "atContS": at_cont, "afterS": after});
        log(&format!("clock: {clock}"));
        checks.ok(
            before.abs() < CLOCK_TOLERANCE && after.abs() < CLOCK_TOLERANCE,
            "the clock: the guest's realtime is within 1 s of the host's, also 1.5 s after a 3 s pause (the agent follows the host's PTP clock)",
            &clock,
        )?;

        timings
            .push(json!({"run": "second boot", "helloMs": hello_ms, "setupToReadyMs": ready_ms}));
        quit(&mut m).await?;
    }

    let template = template_checks(
        &lab,
        &mut checks,
        &image,
        &image_disk,
        &image_layers,
        documents,
    )
    .await?;

    checks.ok(
        failed_save_error.is_none(),
        "a save that fails (stop, a migrate QEMU cannot write, cont): the operation sent after snapshot_prepare is held, and snapshot_done lets it go on: it runs, and the status says ready again",
        failed_save_error.as_deref().unwrap_or_default(),
    )?;
    checks.ok(
        restored_sessions == Ok(RESTORES),
        "each restore's hello starts a new session (32 hex, none of this machine's earlier ones, though memory and random state are the save's), and its since (the agent's realtime when the session started) is within 1 s of the host's time after 3 s saved: the clock is synced before the hello",
        match &restored_sessions {
            Ok(n) => format!("{n} new sessions"),
            Err(why) => why.clone(),
        },
    )?;

    let same = if lab.o.skip_snapshot {
        Ok(json!("not run (--only rest)"))
    } else {
        same_snapshot(&lab, &image_disk, &image_layers, documents).await
    };
    let same_detail = match &same {
        Ok(value) => value.to_string(),
        Err(error) => format!("{error:#}"),
    };
    if !lab.o.skip_snapshot {
        checks.ok(
        same.is_ok(),
        "one snapshot restored twice, each into a new QEMU, the runner having closed cube.0 before the save (the agent closed and opened its port: a VSERPORT_CHANGE after the runner left) and connecting after cont (the supported flow): the guest sees the port open and says hello at once without the reset; each hello starts a session that is not the saved one nor the other restore's, though both start from the same memory; the clock is right at hello after 3 s saved; random bytes read after each setup differ (x86-64: the vmgenid reseed, one kernel record each; arm64: the setup's entropy and RNDRESEEDCRNG)",
        same_detail,
    )?;
    }
    let same = same.unwrap_or_default();

    let results = json!({
        "qemu": {"path": lab.o.qemu, "version": version, "machine": machine_type, "accel": lab.o.accel, "smp": lab.o.smp, "memory": lab.o.memory, "vmgenid": lab.o.vmgenid},
        "sameSnapshot": same,
        "arch": lab.o.arch,
        "kernel": {"path": lab.o.kernel, "sha256": sha256_file(&lab.o.kernel)?},
        "base": {"path": lab.o.base, "sha256": sha256_file(&lab.o.base)?},
        "image": {"tar": lab.o.tar, "diffId": image.0.to_string()},
        "checks": checks.0,
        "idle": idle,
        "restore": restore,
        "snapshot": snapshot,
        "clock": clock,
        "template": template,
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

// ---------------------------------------------------------------- templates

/// The build machine's setup (as `agent`, in /workspace): work a template
/// keeps (a file with its time, a deleted image file, a directory made
/// again, a group) and what cube's scrub must take out (the runner's CA as
/// update-ca-certificates spreads it and in a project's copy of the bundle,
/// a shell history, hook logs, an ssh host key, a machine id). It also
/// changes image files in place (W1): with keel's overlay defaults a
/// `chmod` or `chown` leaves a metacopy inode without data in `upper/`, and
/// a `mv` a redirect and a whiteout at the old name; `app/w1.expect` is what
/// those files held before, for the next machine to compare.
const BUILD_SETUP: &str = r#"set -e
mkdir -p app && printf built > app/out.txt && touch -d @1700000000 app/out.txt
test -f /etc/issue && sudo rm /etc/issue
test -n "$(ls /etc/apt/apt.conf.d)" && sudo rm -rf /etc/apt/apt.conf.d && sudo mkdir /etc/apt/apt.conf.d
echo mine | sudo tee /etc/apt/apt.conf.d/only >/dev/null
sudo update-ca-certificates >/dev/null 2>&1
test -L "/etc/ssl/certs/$(openssl x509 -hash -noout -in /usr/local/share/ca-certificates/cube-runner.crt 2>/dev/null || echo none).0" || ls /etc/ssl/certs | grep -q cube-runner
sudo groupadd -g 1500 project
cp "$SSL_CERT_FILE" app/bundle-copy.pem
echo ls > ~/.bash_history
mkdir -p ~/.cache/cube && echo 'token=cube_ph_github_keelcheck' > ~/.cache/cube/resume.log
sudo mkdir -p /etc/ssh && echo key | sudo tee /etc/ssh/ssh_host_ed25519_key >/dev/null
echo 0123456789abcdef | sudo tee /etc/machine-id >/dev/null
for f in GPL-3 Apache-2.0 MPL-2.0; do test -f /usr/share/common-licenses/$f; done
test -d /usr/share/base-files
(stat -c '%a %u:%g %s' /usr/share/common-licenses/MPL-2.0 && cd /usr/share/common-licenses && sha256sum GPL-3 Apache-2.0 MPL-2.0 | cut -d' ' -f1 && cd ../base-files && find . | LC_ALL=C sort && find . -type f | LC_ALL=C sort | xargs sha256sum) > app/w1.expect
sudo chmod 600 /usr/share/common-licenses/GPL-3
sudo chown 1500:1500 /usr/share/common-licenses/Apache-2.0
sudo mv /usr/share/common-licenses/MPL-2.0 /usr/local/share/MPL-2.0.moved
sudo mv /usr/share/base-files /usr/share/base-files.moved
mkdir -p svc
echo setup-done
"#;

/// The same files read in a machine booted from the template: the mode and
/// owner from the metacopy inodes, the old names gone, and the data and
/// the moved directory's entries as before (found through the metacopy
/// and redirect inodes in the image layer below).
const W1_NEXT: &str = r#"stat -c %a /usr/share/common-licenses/GPL-3
stat -c %u:%g /usr/share/common-licenses/Apache-2.0
test -e /usr/share/common-licenses/MPL-2.0 || echo no-old-file
test -e /usr/share/base-files || echo no-old-dir
(stat -c '%a %u:%g %s' /usr/local/share/MPL-2.0.moved && cd /usr/share/common-licenses && sudo sha256sum GPL-3 Apache-2.0 /usr/local/share/MPL-2.0.moved | cut -d' ' -f1 && cd ../base-files.moved && find . | LC_ALL=C sort && find . -type f | LC_ALL=C sort | xargs sha256sum) > /tmp/w1.now 2>&1
diff app/w1.expect /tmp/w1.now && echo same-as-before
"#;

/// What must never be in a published template, below its root.
const NEVER_IN_A_TEMPLATE: [&str; 11] = [
    "etc/hosts",
    "etc/hostname",
    "etc/resolv.conf",
    "etc/sudoers.d/cube",
    "usr/local/bin/cube",
    "etc/cube",
    "var/lib/cube",
    "home/agent/.bash_history",
    "home/agent/.cache/cube",
    "etc/ssh/ssh_host_ed25519_key",
    "usr/local/share/ca-certificates/cube-runner.crt",
];

const MARKER: &str = "# cube: begin (keel writes this block on every machine_setup)";

/// Whether `data` has cube's marker as a line of its own: nothing else on
/// it but spaces or tabs before and spaces, tabs or a carriage return
/// after (the agent's seal refuses those too). The marker inside a longer
/// line, as in cube's own source, is not one.
fn marker_line(data: &[u8]) -> bool {
    data.split(|&b| b == b'\n').any(|line| {
        let start = line
            .iter()
            .position(|&b| b != b' ' && b != b'\t')
            .unwrap_or(line.len());
        let end = line
            .iter()
            .rposition(|&b| !matches!(b, b' ' | b'\t' | b'\r'))
            .map_or(start, |i| i + 1);
        start < end && &line[start..end] == MARKER.as_bytes()
    })
}

/// A line of cube's own source that holds the marker (generated.rs): what
/// made the seal refuse the cube project's templates until the marker was
/// matched as a line only.
fn source_line() -> String {
    format!("pub const BEGIN: &str = \"{MARKER}\";")
}

/// The DER of TEST_CA.
fn test_ca_der() -> Vec<u8> {
    use base64::Engine;
    let body: String = TEST_CA
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    base64::engine::general_purpose::STANDARD
        .decode(body)
        .expect("TEST_CA is PEM")
}

/// The EROFS superblock's image size on `disk`, or None.
fn erofs_bytes(disk: &Path) -> Result<Option<u64>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = fs::File::open(disk)?;
    let mut sb = [0u8; 128];
    file.seek(SeekFrom::Start(1024))?;
    file.read_exact(&mut sb)?;
    if sb[..4] != 0xE0F5E1E2u32.to_le_bytes() {
        return Ok(None);
    }
    let blocks = u32::from_le_bytes(sb[36..40].try_into().unwrap());
    Ok(Some(u64::from(blocks) << sb[12]))
}

/// Everything of cube's found in a template's tree (read from the image,
/// see erofs.rs): files or xattrs that hold a marker line, the CA's DER or
/// the start of its base64; entries and links named for the runner's CA;
/// the paths on NEVER_IN_A_TEMPLATE; `agent` lines in the account files; a
/// machine id. Also how many files it read, so an empty layer cannot pass.
fn template_findings(tree: &[erofs::Entry], der: &[u8]) -> (Vec<String>, usize) {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&der[..der.len().min(48)]);
    let needles: [&[u8]; 2] = [der, b64.as_bytes()];
    let holds = |data: &[u8]| {
        marker_line(data)
            || needles
                .iter()
                .any(|n| data.windows(n.len()).any(|w| w == *n))
    };
    let mut found = vec![];
    let mut read = 0;
    for entry in tree {
        let rel = &entry.path;
        if rel
            .rsplit('/')
            .next()
            .unwrap_or("")
            .starts_with("cube-runner")
        {
            found.push(format!("/{rel} is named for the runner's CA"));
        }
        match entry.kind {
            erofs::Kind::Symlink => {
                if entry.data.windows(11).any(|w| w == b"cube-runner") {
                    found.push(format!("/{rel} links to the runner's CA"));
                }
            }
            erofs::Kind::File => {
                read += 1;
                if holds(&entry.data) {
                    found.push(format!("/{rel} holds cube's block or the runner's CA"));
                }
            }
            _ => {}
        }
        for (name, value) in &entry.xattrs {
            if holds(value) {
                found.push(format!(
                    "/{rel}'s {name} holds cube's block or the runner's CA"
                ));
            }
        }
    }
    let at = |rel: &str| tree.iter().find(|e| e.path == rel);
    for rel in NEVER_IN_A_TEMPLATE {
        if at(rel).is_some() {
            found.push(format!("/{rel} is in the template"));
        }
    }
    for rel in ["etc/passwd", "etc/group", "etc/shadow", "etc/gshadow"] {
        if at(rel).is_some_and(|e| {
            String::from_utf8_lossy(&e.data)
                .lines()
                .any(|line| line.starts_with("agent:"))
        }) {
            found.push(format!("/{rel} has the agent account"));
        }
    }
    if at("etc/machine-id").is_some_and(|e| {
        e.kind == erofs::Kind::Symlink || (e.kind == erofs::Kind::File && !e.data.is_empty())
    }) {
        found.push("/etc/machine-id is not empty".into());
    }
    (found, read)
}

/// The build setup's work, as the layer holds it: whether all of it is
/// there, and what was seen.
fn template_work(tree: &[erofs::Entry]) -> (bool, Value) {
    let at = |rel: &str| tree.iter().find(|e| e.path == rel);
    let text = |rel: &str| {
        at(rel)
            .filter(|e| e.kind == erofs::Kind::File)
            .map(|e| String::from_utf8_lossy(&e.data).into_owned())
            .unwrap_or_default()
    };
    let out = at("workspace/app/out.txt");
    let mtime = out.map(|e| e.mtime);
    let owner = out.map(|e| format!("{}:{} {:o}", e.uid, e.gid, e.mode));
    let issue = at("etc/issue").map(|e| format!("{:?}", e.kind));
    let whiteout = at("etc/issue").is_some_and(erofs::Entry::is_whiteout);
    let dir = "etc/apt/apt.conf.d";
    let opaque = at(dir).is_some_and(|e| {
        e.kind == erofs::Kind::Dir && e.xattr("trusted.overlay.opaque") == Some(b"y".as_slice())
    });
    let inside: Vec<&str> = tree
        .iter()
        .filter_map(|e| e.path.strip_prefix(dir)?.strip_prefix('/'))
        .collect();
    let copy = text("workspace/app/bundle-copy.pem");
    let source = text("workspace/app/source.rs");
    let ok = text("workspace/app/out.txt") == "built"
        && source == format!("{}\n", source_line())
        && mtime == Some(1700000000)
        && whiteout
        && opaque
        && inside == ["only"]
        && text("etc/apt/apt.conf.d/only") == "mine\n"
        && text("etc/group").contains("\nproject:x:1500:")
        && copy.contains("BEGIN CERTIFICATE");
    (
        ok,
        json!({
            "mtime": mtime,
            "owner": owner,
            "issue": issue,
            "whiteout": whiteout,
            "opaque": opaque,
            "aptConfD": inside,
            "copyCerts": copy.matches("BEGIN CERTIFICATE").count(),
            "source": source,
        }),
    )
}

/// Where an overlayfs redirect on `path` points, below the root: an
/// absolute one names the path, a relative one a name in the same
/// directory.
fn redirect_target(path: &str, value: &[u8]) -> Option<String> {
    let value = std::str::from_utf8(value).ok()?;
    if let Some(absolute) = value.strip_prefix('/') {
        return Some(absolute.into());
    }
    Some(match path.rsplit_once('/') {
        Some((parent, _)) => format!("{parent}/{value}"),
        None => value.into(),
    })
}

/// The image files the build setup changed in place (W1), as the layer
/// holds them: the `chmod`ed and `chown`ed files and the moved file as
/// metacopy inodes whose data is all zeros (so a reader must find it in
/// the image layer), the moved file and directory with redirects to their
/// old names, 0/0 whiteouts there, and nothing below the moved directory.
fn template_moves(tree: &[erofs::Entry]) -> (bool, Value) {
    let at = |rel: &str| tree.iter().find(|e| e.path == rel);
    let metacopy = |rel: &str| {
        at(rel).is_some_and(|e| {
            e.kind == erofs::Kind::File
                && e.xattr("trusted.overlay.metacopy").is_some()
                && !e.data.is_empty()
                && e.data.iter().all(|&b| b == 0)
        })
    };
    let redirect = |rel: &str| {
        at(rel)
            .and_then(|e| e.xattr("trusted.overlay.redirect"))
            .and_then(|v| redirect_target(rel, v))
    };
    let whiteout = |rel: &str| at(rel).is_some_and(erofs::Entry::is_whiteout);
    let (gpl, apache, file, dir) = (
        "usr/share/common-licenses/GPL-3",
        "usr/share/common-licenses/Apache-2.0",
        "usr/local/share/MPL-2.0.moved",
        "usr/share/base-files.moved",
    );
    let inside: Vec<&str> = tree
        .iter()
        .filter_map(|e| e.path.strip_prefix(dir)?.strip_prefix('/'))
        .collect();
    let seen = json!({
        "chmod": at(gpl).map(|e| format!("{:o} metacopy {}", e.mode, metacopy(gpl))),
        "chown": at(apache).map(|e| format!("{}:{} metacopy {}", e.uid, e.gid, metacopy(apache))),
        "movedFile": {"metacopy": metacopy(file), "redirect": redirect(file), "oldWhiteout": whiteout("usr/share/common-licenses/MPL-2.0")},
        "movedDir": {"dir": at(dir).map(|e| format!("{:?}", e.kind)), "redirect": redirect(dir), "oldWhiteout": whiteout("usr/share/base-files"), "inside": inside},
    });
    let ok = metacopy(gpl)
        && at(gpl).is_some_and(|e| e.mode == 0o600)
        && metacopy(apache)
        && at(apache).is_some_and(|e| (e.uid, e.gid) == (1500, 1500))
        && metacopy(file)
        && redirect(file).as_deref() == Some("usr/share/common-licenses/MPL-2.0")
        && whiteout("usr/share/common-licenses/MPL-2.0")
        && at(dir).is_some_and(|e| e.kind == erofs::Kind::Dir)
        && redirect(dir).as_deref() == Some("usr/share/base-files")
        && whiteout("usr/share/base-files")
        && inside.is_empty();
    (ok, seen)
}

/// CRC-32C as EROFS sums its superblock (seed !0, no final inversion).
fn crc32c(mut crc: u32, data: &[u8]) -> u32 {
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = (crc >> 1) ^ (0x82F6_3B78 & (crc & 1).wrapping_neg());
        }
    }
    crc
}

/// `--control redirect`: points every `trusted.overlay.redirect` in an
/// EROFS image at a name that does not exist (the value's last byte made
/// `~`) and sums the superblock again, so the image stays valid for
/// `fsck.erofs` and the kernel but the moved file's data and the moved
/// directory's entries can no longer be found. Returns how many it changed.
fn break_redirects(image: &mut [u8]) -> Result<usize> {
    // An xattr entry: name length, index 4 (trusted.), value size, name, value.
    let name = b"overlay.redirect";
    let mut changed = 0;
    let mut at = 0;
    while at + 4 + name.len() <= image.len() {
        if image[at] == name.len() as u8
            && image[at + 1] == 4
            && &image[at + 4..at + 4 + name.len()] == name
        {
            let size = usize::from(u16::from_le_bytes([image[at + 2], image[at + 3]]));
            let end = at + 4 + name.len() + size;
            ensure!(
                size > 0 && end <= image.len(),
                "a redirect xattr at {at} runs past the image"
            );
            image[end - 1] = if image[end - 1] == b'~' { b'-' } else { b'~' };
            changed += 1;
            at = end;
        } else {
            at += 1;
        }
    }
    let sb = 1024;
    ensure!(
        image.len() >= sb + 128 && image[sb..sb + 4] == 0xE0F5E1E2u32.to_le_bytes(),
        "no EROFS superblock"
    );
    if u32::from_le_bytes(image[sb + 8..sb + 12].try_into().unwrap()) & 1 != 0 {
        let block = 1usize << image[sb + 12];
        ensure!(
            block > sb && image.len() >= block,
            "a block of {block} bytes"
        );
        image[sb + 4..sb + 8].fill(0);
        let crc = crc32c(!0, &image[sb..block]);
        image[sb + 4..sb + 8].copy_from_slice(&crc.to_le_bytes());
    }
    Ok(changed)
}

/// The console's `cube-agent: template:` lines.
fn template_lines(dir: &Path) -> Vec<String> {
    (1..)
        .map_while(|boot| fs::read_to_string(dir.join(format!("console-{boot}.log"))).ok())
        .flat_map(|text| {
            text.lines()
                .filter_map(|line| line.split("cube-agent: template: ").nth(1))
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .collect()
}

/// A build machine publishes its upper/ as a template layer; the layer is
/// checked here and a new machine boots with it.
async fn template_checks(
    lab: &Lab,
    checks: &mut Checks,
    image: &(DiffId, PathBuf),
    image_disk: &Path,
    image_layers: &[proto::Layer],
    documents: &[(&str, &[u8])],
) -> Result<Value> {
    let epoch = 7;
    let dir = lab.new_disk("build")?;
    let vdd = dir.join("template.raw");
    let status = std::process::Command::new(&lab.o.qemu_img)
        .args(["create", "-q", "-f", "raw"])
        .arg(&vdd)
        .arg("1G")
        .status()?;
    ensure!(status.success(), "qemu-img create");
    let drive = format!("if=virtio,format=raw,file={}", vdd.display());
    let mut m = lab.start_with(&dir, image_disk, &["-drive", &drive])?;
    let ch = Channel::open(&m.ctl).await?;
    ch.info("hello", TIMEOUT).await?;
    let done = ch.request(setup(image_layers, documents)).await?;
    let ready = ch.info("status", TIMEOUT).await?;
    ensure!(
        matches!(done, Answer::Done(_)) && ready.ready,
        "the build machine's setup: {done:?} {ready:?}"
    );
    let mut script = BUILD_SETUP.to_string();
    // cube's own source: the marker inside a line, which travels as it is.
    script.push_str(&format!(
        "printf '%s\\n' '{}' > app/source.rs\n",
        source_line()
    ));
    if lab.o.control == Some(Control::Seal) {
        use base64::Engine;
        let der = base64::engine::general_purpose::STANDARD.encode(test_ca_der());
        script.push_str(&format!("echo {der} | base64 -d > app/runner.der\n"));
    }
    let (header, output) = ch.run("tpl-setup", &script, epoch).await?;
    ensure!(
        header["result"]["exitCode"] == 0 && output.contains("setup-done"),
        "the build machine's setup: {header} {output}"
    );
    let (_, started) = ch
        .run(
            "tpl-svc",
            &format!("cat > svc/server.pl <<'EOF'\n{SERVICE_SCRIPT}EOF\ncube service start web --port 8102 --cwd svc --json -- perl server.pl; echo \"exit=$?\""),
            epoch,
        )
        .await?;
    ensure!(
        started.contains("exit=0"),
        "a service on the build machine: {started}"
    );

    // A running command keeps the machine from being published.
    let (running, _) = ch
        .guest(
            "exec",
            json!({"id": "tpl-busy", "epoch": epoch, "command": "sleep 120", "timeoutMs": 600000}),
        )
        .await?;
    let busy = ch.request(Op::TemplatePublish(proto::Empty {})).await?;
    let _ = ch.info("status", TIMEOUT).await?;
    ch.guest("cancel", json!({"id": "tpl-busy", "epoch": epoch}))
        .await?;
    let (cancelled, _) = ch.settle("tpl-busy").await?;
    checks.ok(
        running.get("error").is_none()
            && refusal(&busy) == Some((proto::Code::FailedPrecondition as i32, "busy".into()))
            && cancelled["state"] != "Running",
        "template publishing is refused while a command runs (busy); the machine stays usable",
        format!("{busy:?} {cancelled}"),
    )?;

    let t = Instant::now();
    let published = ch
        .request_on(
            None,
            Op::TemplatePublish(proto::Empty {}),
            Duration::from_secs(600),
        )
        .await?;
    let publish_ms = t.elapsed().as_millis();
    let after = ch.info("status", TIMEOUT).await?;
    let exec = ch
        .guest_raw(
            "exec",
            format!(
                "{}\n",
                json!({"id": "tpl-after", "epoch": epoch, "command": "true"})
            )
            .into_bytes(),
        )
        .await?;
    let again_setup = ch.request(setup(image_layers, documents)).await?;
    let again = ch.request(Op::TemplatePublish(proto::Empty {})).await?;
    let lines = template_lines(&dir);
    log(&format!(
        "template: {publish_ms} ms; {published:?}; {lines:?}"
    ));
    checks.ok(
        matches!(published, Answer::Done(_))
            && !after.ready
            && after.reason.contains("published as a template")
            && exec.as_ref().is_err_and(|e| e.reason == "not_ready")
            && refusal(&again_setup) == Some((proto::Code::FailedPrecondition as i32, "published".into()))
            && matches!(again, Answer::Done(_)),
        "template_publish: done; then the machine is not ready (published), refuses commands and setups, and a repeated request is done again",
        format!("{published:?} | {after:?} | {exec:?} | {again_setup:?} | {again:?}"),
    )?;
    quit(&mut m).await?;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let lines = template_lines(&dir);

    // The layer, as the runner will check it: an EROFS superblock and a size.
    let bytes =
        erofs_bytes(&vdd)?.ok_or_else(|| anyhow!("no EROFS superblock on the template disk"))?;
    let layer = dir.join("template.erofs");
    {
        use std::io::Read;
        let mut data = vec![];
        fs::File::open(&vdd)?.take(bytes).read_to_end(&mut data)?;
        fs::write(&layer, data)?;
    }
    // fsck.erofs checks the image; the driver reads it in place (no
    // extraction, so no mknod for the whiteouts, and the xattrs are seen).
    let fsck = std::process::Command::new(&lab.o.fsck)
        .arg(&layer)
        .output()?;
    ensure!(
        fsck.status.success(),
        "fsck.erofs: {}{}",
        String::from_utf8_lossy(&fsck.stdout),
        String::from_utf8_lossy(&fsck.stderr)
    );
    let tree = erofs::read_tree(&fs::read(&layer)?).context("reading the template layer")?;
    let (found, files) = template_findings(&tree, &test_ca_der());
    checks.ok(
        found.is_empty() && files > 0,
        "the template layer (fsck.erofs clean, read in place) holds nothing of cube's: no marker block or runner CA in any file or xattr (DER or base64), no cube-runner.crt/.pem or link to it, no mount point, /etc/cube, /var/lib/cube, agent account line, hook log, shell history, ssh host key or machine id",
        json!({"found": found, "files": files}),
    )?;
    let (work, seen) = template_work(&tree);
    checks.ok(
        work,
        "the setup's work is in the layer: a file with its time, a 0/0 whiteout for a deleted image file, an opaque directory made again holding only its new file, a new group, the project's copy of the bundle (without the runner's CA), a source line holding the marker inside it, as it was",
        seen,
    )?;
    // Checked after 78, so 73-78 keep their numbers.
    let (moves, moves_seen) = template_moves(&tree);
    if lab.o.control == Some(Control::Redirect) {
        let mut image = fs::read(&layer)?;
        let changed = break_redirects(&mut image)?;
        fs::write(&layer, &image)?;
        log(&format!(
            "control redirect: {changed} redirects in the template now point at nothing"
        ));
    }

    // A new machine with the template as its topmost layer.
    let template_id: DiffId = format!("sha256:{}", sha256_file(&layer)?).parse()?;
    let next_disk = lab.o.out.join("template-disk");
    let mut layers = layer_disk(&next_disk, &[(template_id, layer.clone()), image.clone()])?;
    layers[0].source = Some(proto::layer::Source::TemplateId(
        template_id.hex()[..16].into(),
    ));
    let next = lab.new_disk("from-template")?;
    let mut m = lab.start(&next, &next_disk)?;
    let ch = Channel::open(&m.ctl).await?;
    ch.info("hello", TIMEOUT).await?;
    let done = ch.request(setup(&layers, documents)).await?;
    let status = ch.info("status", TIMEOUT).await?;
    let (_, seen) = ch
        .run(
            "tpl-next",
            "stat -c '%U %Y' app/out.txt; cat app/out.txt; echo; test -e /etc/issue || echo no-issue; ls /etc/apt/apt.conf.d; grep -c '^agent:' /etc/passwd; getent group project; grep -c '^# cube: begin' \"$SSL_CERT_FILE\"; cube service list >/dev/null && echo cube-ok",
            epoch,
        )
        .await?;
    let (_, w1) = ch.run("tpl-w1", W1_NEXT, epoch).await?;
    let refused = ch.request(Op::TemplatePublish(proto::Empty {})).await?;
    let _ = ch.info("status", TIMEOUT).await;
    checks.ok(
        matches!(done, Answer::Done(_))
            && status.ready
            && seen
                == "agent 1700000000\nbuilt\nno-issue\nonly\n1\nproject:x:1500:\n1\ncube-ok\n",
        "a new machine with the template as its topmost layer is ready: the work is there (owner agent, its time), the deleted file stays deleted, the directory holds only what setup put there, one agent account, the machine's own CA block, the cube command",
        &seen,
    )?;
    checks.ok(
        refusal(&refused)
            == Some((
                proto::Code::FailedPrecondition as i32,
                "no_template_disk".into(),
            )),
        "a machine without a template disk refuses template_publish (no_template_disk)",
        format!("{refused:?}"),
    )?;
    checks.ok(
        moves,
        "the image files the setup changed in place are in the layer as overlayfs keeps them: the chmod and chown as metacopy inodes without data, a moved file (metacopy) and a moved directory with redirects to their old names, whiteouts there, nothing below the moved directory",
        moves_seen.clone(),
    )?;
    let w1_ok = w1 == "600\n1500:1500\nno-old-file\nno-old-dir\nsame-as-before\n";
    checks.ok(
        w1_ok,
        "in the machine booted from the template those files resolve through the image layer below: the new mode and owner, the old names gone, the data of all three and the moved directory's entries and data as before the setup",
        &w1,
    )?;
    quit(&mut m).await?;
    Ok(json!({
        "bytes": bytes,
        "sha256": sha256_file(&layer)?,
        "publishMs": publish_ms,
        "files": files,
        "agent": lines,
        "moves": moves_seen,
    }))
}

#[cfg(test)]
mod tests {
    //! The runner's connect rule against a scripted agent on a Unix socket
    //! (a stand-in; the real agent is checked in the machine).
    use super::*;

    fn info() -> proto::GuestInfo {
        proto::GuestInfo::default()
    }

    async fn agent_end(name: &str) -> (PathBuf, UnixListener) {
        let path =
            std::env::temp_dir().join(format!("kac-test-{}-{name}.sock", std::process::id()));
        let _ = fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();
        (path, listener)
    }

    async fn say(stream: &mut UnixStream, ch: u32, t: T) {
        write_frame(
            stream,
            &proto::DaemonFrame {
                ch,
                t: Some(t),
                session: String::new(),
            },
        )
        .await
        .unwrap();
    }

    async fn read_any(stream: &mut UnixStream) -> proto::DaemonFrame {
        // The agent's own reader would refuse a req on channel 0; read the raw frame.
        cube_runner_protocol::read_frame(stream).await.unwrap()
    }

    fn entry(path: &str, kind: erofs::Kind, data: &[u8]) -> erofs::Entry {
        erofs::Entry {
            path: path.into(),
            kind,
            mode: 0o644,
            uid: 0,
            gid: 0,
            mtime: 0,
            xattrs: vec![],
            data: data.to_vec(),
        }
    }

    /// The leftovers check 75 must find, each as (path, kind, data).
    fn leftovers(der: &[u8]) -> Vec<(&'static str, erofs::Kind, Vec<u8>)> {
        use base64::Engine;
        use erofs::Kind::{Char, File, Symlink};
        let b64 = base64::engine::general_purpose::STANDARD.encode(der);
        let mut deep = erofs::testing::mixed(300_000, 11);
        // Across lclusters and pclusters, deep in a compressed file: a
        // marker line.
        deep.splice(150_000..150_000, format!("\n  {MARKER}\r\n").into_bytes());
        vec![
            ("etc/gitconfig", File, format!("{MARKER}\n").into_bytes()),
            ("opt/x.der", File, der.to_vec()),
            (
                "opt/x.pem",
                File,
                format!("-----BEGIN CERTIFICATE-----\n{}\n", &b64[..64]).into_bytes(),
            ),
            ("opt/deep.bin", File, deep),
            ("etc/ssl/certs/cube-runner.pem", File, b"x".to_vec()),
            ("etc/ssl/certs/abcd.0", Symlink, b"cube-runner.pem".to_vec()),
            ("etc/hosts", File, vec![]),
            // A whiteout on a never-path is still that path in the layer.
            ("etc/resolv.conf", Char(0), vec![]),
            ("etc/shadow", File, b"agent:!:1:0:99999:7:::\n".to_vec()),
            ("etc/machine-id", File, b"0123\n".to_vec()),
        ]
    }

    #[test]
    fn the_template_scan_finds_each_kind_of_leftover() {
        use erofs::Kind::{Dir, File};
        let der = test_ca_der();
        let clean = vec![
            entry("", Dir, b""),
            entry("workspace/app/out.txt", File, b"built"),
            entry("etc/passwd", File, b"root:x:0:0::/root:/bin/bash\n"),
            entry("etc/machine-id", File, b""),
        ];
        let (found, files) = template_findings(&clean, &der);
        assert_eq!((found.len(), files), (0, 3), "{found:?}");
        for (rel, kind, data) in leftovers(&der) {
            let mut tree = clean.clone();
            tree.retain(|e| e.path != rel);
            tree.push(entry(rel, kind, &data));
            let (found, _) = template_findings(&tree, &der);
            assert_eq!(found.len(), 1, "{rel}: {found:?}");
        }
        // The marker inside a line (cube's own source, prose) is no block.
        for data in [
            format!("x{MARKER}y"),
            format!("{}\n", source_line()),
            format!("see `{MARKER}`\n"),
        ] {
            let mut tree = clean.clone();
            tree.push(entry("workspace/src/generated.rs", File, data.as_bytes()));
            assert_eq!(
                template_findings(&tree, &der).0,
                Vec::<String>::new(),
                "{data:?}"
            );
        }
        // The CA in an xattr's value.
        let mut tree = clean.clone();
        tree[1].xattrs.push(("user.ca".into(), der.clone()));
        assert_eq!(template_findings(&tree, &der).0.len(), 1);
        // No files read: check 75 cannot pass on an empty layer.
        assert_eq!(template_findings(&clean[..1], &der).1, 0);
    }

    /// A layer like the build machine's, as a tar for mkfs.erofs.
    fn template_like() -> Vec<erofs::testing::E> {
        use erofs::testing::{T, e};
        let mut out = e("workspace/app/out.txt", T::File(b"built".to_vec()));
        (out.uid, out.gid, out.mtime) = (1000, 1000, 1_700_000_000);
        let mut apt = e("etc/apt/apt.conf.d", T::Dir);
        apt.xattrs.push(("trusted.overlay.opaque", b"y".to_vec()));
        vec![
            e("etc", T::Dir),
            e("etc/issue", T::Char(0, 0)),
            e("etc/apt", T::Dir),
            apt,
            e("etc/apt/apt.conf.d/only", T::File(b"mine\n".to_vec())),
            e(
                "etc/group",
                T::File(b"root:x:0:\nproject:x:1500:\n".to_vec()),
            ),
            e("etc/machine-id", T::File(vec![])),
            e("workspace", T::Dir),
            e("workspace/app", T::Dir),
            out,
            e(
                "workspace/app/source.rs",
                T::File(format!("{}\n", source_line()).into_bytes()),
            ),
            e(
                "workspace/app/bundle-copy.pem",
                T::File(b"-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n".to_vec()),
            ),
            e(
                "workspace/app/big",
                T::File(erofs::testing::mixed(300_000, 5)),
            ),
        ]
    }

    /// Checks 75 and 76 against real layers from `mkfs.erofs` in the agent's
    /// form: a clean one passes both; each leftover fails 75; each missing
    /// piece of work (a whiteout that is a file or another device, a
    /// directory that is not opaque, a lost time, an extra file) fails 76.
    #[test]
    fn checks_75_and_76_on_real_layers_pass_clean_and_fail_dirty() {
        use erofs::testing::{E, T, e, image};
        let der = test_ca_der();
        let read = |name: &str, entries: &[E]| {
            image(name, &["-b4096", "-zlz4hc"], entries).map(|i| erofs::read_tree(&i).unwrap())
        };
        let base = template_like();
        let Some(tree) = read("clean", &base) else {
            return;
        };
        let (found, files) = template_findings(&tree, &der);
        assert!(found.is_empty() && files == 7, "{found:?} {files}");
        let (ok, seen) = template_work(&tree);
        assert!(ok, "{seen}");

        for (rel, kind, data) in leftovers(&der) {
            let mut entries = base.clone();
            entries.retain(|e| e.path != rel);
            for dir in ["opt", "etc/ssl", "etc/ssl/certs"] {
                if rel.starts_with(&format!("{dir}/")) && !entries.iter().any(|e| e.path == dir) {
                    entries.push(e(dir, T::Dir));
                }
            }
            entries.push(e(
                rel,
                match kind {
                    erofs::Kind::Symlink => T::Link("cube-runner.pem"),
                    erofs::Kind::Char(_) => T::Char(0, 0),
                    _ => T::File(data),
                },
            ));
            let tree = read("dirty", &entries).unwrap();
            let (found, _) = template_findings(&tree, &der);
            assert_eq!(found.len(), 1, "{rel}: {found:?}");
        }

        let change = |path: &str, f: &dyn Fn(&mut E)| {
            let mut entries = base.clone();
            entries.iter_mut().filter(|e| e.path == path).for_each(f);
            entries
        };
        let missing: [(&str, Vec<E>); 6] = [
            (
                "issue is a file",
                change("etc/issue", &|e| e.t = T::File(vec![])),
            ),
            (
                "issue is 1/3",
                change("etc/issue", &|e| e.t = T::Char(1, 3)),
            ),
            (
                "not opaque",
                change("etc/apt/apt.conf.d", &|e| e.xattrs.clear()),
            ),
            (
                "opaque n",
                change("etc/apt/apt.conf.d", &|e| {
                    e.xattrs = vec![("trusted.overlay.opaque", b"n".to_vec())]
                }),
            ),
            (
                "time lost",
                change("workspace/app/out.txt", &|e| e.mtime = 1_700_000_001),
            ),
            ("an extra file", {
                let mut entries = base.clone();
                entries.push(e("etc/apt/apt.conf.d/more", T::File(vec![])));
                entries
            }),
        ];
        for (what, entries) in missing {
            let (ok, seen) = template_work(&read("work", &entries).unwrap());
            assert!(!ok, "{what}: {seen}");
        }
    }

    /// The W1 part of a build machine's layer as overlayfs leaves it (as
    /// seen on a real overlay over an EROFS lower): metacopy files hold
    /// zeros of the full size, a moved file's redirect is absolute (another
    /// directory) and a moved directory's relative (the same one).
    fn moves_like() -> Vec<erofs::testing::E> {
        use erofs::testing::{T, e};
        let meta = |path: &str| {
            let mut entry = e(path, T::File(vec![0; 35_149]));
            entry.xattrs = vec![
                ("trusted.overlay.metacopy", vec![]),
                ("trusted.overlay.origin", vec![0, 0xfb, 0x21, 0, 0x81]),
            ];
            entry
        };
        let mut gpl = meta("usr/share/common-licenses/GPL-3");
        gpl.mode = 0o600;
        let mut apache = meta("usr/share/common-licenses/Apache-2.0");
        (apache.uid, apache.gid) = (1500, 1500);
        let mut file = meta("usr/local/share/MPL-2.0.moved");
        file.xattrs.push((
            "trusted.overlay.redirect",
            b"/usr/share/common-licenses/MPL-2.0".to_vec(),
        ));
        let mut dir = e("usr/share/base-files.moved", T::Dir);
        dir.xattrs = vec![("trusted.overlay.redirect", b"base-files".to_vec())];
        vec![
            e("usr", T::Dir),
            e("usr/share", T::Dir),
            e("usr/share/common-licenses", T::Dir),
            gpl,
            apache,
            e("usr/share/common-licenses/MPL-2.0", T::Char(0, 0)),
            e("usr/share/base-files", T::Char(0, 0)),
            dir,
            e("usr/local", T::Dir),
            e("usr/local/share", T::Dir),
            file,
        ]
    }

    /// Check 79 against real layers: the W1 changes pass (and a template
    /// without them would not), each way overlayfs or the scrub could have
    /// lost one fails.
    #[test]
    fn check_79_on_real_layers_passes_metacopy_and_redirects_and_fails_each_gap() {
        use erofs::testing::{E, T, e, image};
        let read = |name: &str, entries: &[E]| {
            image(name, &["-b4096", "-zlz4hc"], entries).map(|i| erofs::read_tree(&i).unwrap())
        };
        let mut base = template_like();
        base.extend(moves_like());
        let Some(tree) = read("moves", &base) else {
            return;
        };
        let (ok, seen) = template_moves(&tree);
        assert!(ok, "{seen}");
        // Checks 75 and 76 are not disturbed by the W1 entries.
        assert!(template_findings(&tree, &test_ca_der()).0.is_empty());
        assert!(template_work(&tree).0);
        // The absolute form of the directory's redirect means the same.
        let mut absolute = base.clone();
        absolute
            .iter_mut()
            .filter(|e| e.path == "usr/share/base-files.moved")
            .for_each(|e| {
                e.xattrs = vec![(
                    "trusted.overlay.redirect",
                    b"/usr/share/base-files".to_vec(),
                )]
            });
        let (ok, seen) = template_moves(&read("absolute", &absolute).unwrap());
        assert!(ok, "{seen}");
        assert!(!template_moves(&read("none", &template_like()).unwrap()).0);

        let change = |path: &str, f: &dyn Fn(&mut E)| {
            let mut entries = base.clone();
            assert!(entries.iter().any(|e| e.path == path), "{path}");
            entries.iter_mut().filter(|e| e.path == path).for_each(f);
            entries
        };
        let without = |path: &str| {
            let mut entries = base.clone();
            entries.retain(|e| e.path != path);
            entries
        };
        let xattr = |name: &'static str, value: Option<&'static [u8]>| {
            move |e: &mut E| {
                e.xattrs.retain(|(n, _)| *n != name);
                if let Some(value) = value {
                    e.xattrs.push((name, value.to_vec()));
                }
            }
        };
        let gpl = "usr/share/common-licenses/GPL-3";
        let apache = "usr/share/common-licenses/Apache-2.0";
        let file = "usr/local/share/MPL-2.0.moved";
        let dir = "usr/share/base-files.moved";
        let gaps: Vec<(&str, Vec<E>)> = vec![
            (
                "chmod copied with its data",
                change(gpl, &|e| e.t = T::File(b"GNU".repeat(100))),
            ),
            (
                "chmod without metacopy",
                change(gpl, &xattr("trusted.overlay.metacopy", None)),
            ),
            ("chmod lost", change(gpl, &|e| e.mode = 0o644)),
            ("chmod empty", change(gpl, &|e| e.t = T::File(vec![]))),
            ("chown lost", change(apache, &|e| (e.uid, e.gid) = (0, 0))),
            (
                "chown without metacopy",
                change(apache, &xattr("trusted.overlay.metacopy", None)),
            ),
            (
                "moved file copied with its data",
                change(file, &|e| e.t = T::File(vec![1; 100])),
            ),
            (
                "moved file without metacopy",
                change(file, &xattr("trusted.overlay.metacopy", None)),
            ),
            (
                "moved file without redirect",
                change(file, &xattr("trusted.overlay.redirect", None)),
            ),
            (
                "moved file to the wrong name",
                change(
                    file,
                    &xattr(
                        "trusted.overlay.redirect",
                        Some(b"/usr/share/common-licenses/MPL-2.~"),
                    ),
                ),
            ),
            (
                "moved file, relative to the wrong directory",
                change(file, &xattr("trusted.overlay.redirect", Some(b"MPL-2.0"))),
            ),
            ("moved file not there", without(file)),
            (
                "old file name without whiteout",
                without("usr/share/common-licenses/MPL-2.0"),
            ),
            (
                "old file name a file",
                change("usr/share/common-licenses/MPL-2.0", &|e| {
                    e.t = T::File(vec![])
                }),
            ),
            (
                "moved dir without redirect",
                change(dir, &|e| e.xattrs.clear()),
            ),
            (
                "moved dir to the wrong name",
                change(dir, &xattr("trusted.overlay.redirect", Some(b"base-file~"))),
            ),
            (
                "old dir name without whiteout",
                without("usr/share/base-files"),
            ),
            (
                "old dir name 1/3",
                change("usr/share/base-files", &|e| e.t = T::Char(1, 3)),
            ),
            ("moved dir copied with its entries", {
                let mut entries = base.clone();
                entries.push(e(
                    "usr/share/base-files.moved/motd",
                    T::File(b"hi\n".to_vec()),
                ));
                entries
            }),
        ];
        for (what, entries) in gaps {
            let (ok, seen) = template_moves(&read("gap", &entries).unwrap());
            assert!(!ok, "{what}: {seen}");
        }
    }

    #[test]
    fn crc32c_is_the_castagnoli_crc() {
        assert_eq!(!crc32c(!0, b"123456789"), 0xE306_9283);
    }

    /// `--control redirect` on a real layer: both redirects point at
    /// names that do not exist, everything else is as it was, and the
    /// image is still valid (`fsck.erofs`, with the superblock summed
    /// again); left unsummed, `fsck.erofs` refuses it.
    #[test]
    fn the_redirect_control_breaks_both_redirects_and_keeps_the_image_valid() {
        use erofs::testing::{image, tool};
        let mut entries = template_like();
        entries.extend(moves_like());
        let Some(clean) = image("control", &["-b4096", "-zlz4hc"], &entries) else {
            return;
        };
        let Some(fsck) = tool("fsck.erofs") else {
            return;
        };
        let fsck_ok = |name: &str, bytes: &[u8]| {
            let path = std::env::temp_dir()
                .join(format!("kac-control-{}-{name}.erofs", std::process::id()));
            fs::write(&path, bytes).unwrap();
            let output = std::process::Command::new(&fsck)
                .arg(&path)
                .output()
                .unwrap();
            let _ = fs::remove_file(&path);
            // fsck.erofs (1.8.6) reports a wrong superblock sum as an
            // error line but exits 0.
            let said = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            output.status.success() && !said.contains("<E>")
        };
        assert!(fsck_ok("clean", &clean));
        let mut broken = clean.clone();
        assert_eq!(break_redirects(&mut broken).unwrap(), 2);
        assert!(fsck_ok("broken", &broken));
        let before = erofs::read_tree(&clean).unwrap();
        let after = erofs::read_tree(&broken).unwrap();
        assert_eq!(before.len(), after.len());
        for (b, a) in before.iter().zip(&after) {
            let redirect =
                |e: &erofs::Entry| e.xattr("trusted.overlay.redirect").map(<[u8]>::to_vec);
            match a.path.as_str() {
                "usr/local/share/MPL-2.0.moved" => {
                    assert_eq!(redirect(a).unwrap(), b"/usr/share/common-licenses/MPL-2.~")
                }
                "usr/share/base-files.moved" => assert_eq!(redirect(a).unwrap(), b"base-file~"),
                _ => assert_eq!(redirect(a), redirect(b), "{}", a.path),
            }
            assert_eq!(
                (&a.path, a.kind, a.mode, a.uid, a.gid, a.mtime, &a.data),
                (&b.path, b.kind, b.mode, b.uid, b.gid, b.mtime, &b.data)
            );
        }
        let (ok, seen) = template_moves(&after);
        assert!(!ok, "{seen}");
        // The sum is mkfs.erofs' own, and fsck.erofs checks it: a byte
        // changed in the summed block without a new sum is refused.
        if u32::from_le_bytes(clean[1032..1036].try_into().unwrap()) & 1 != 0 {
            let mut zeroed = clean[1024..4096].to_vec();
            zeroed[4..8].fill(0);
            assert_eq!(crc32c(!0, &zeroed).to_le_bytes(), clean[1028..1032]);
            let mut unsummed = clean.clone();
            unsummed[1024 + 127] ^= 1;
            assert!(!fsck_ok("unsummed", &unsummed));
        }
    }

    #[tokio::test]
    async fn no_hello_brings_a_reset_on_channel_0_then_hello() {
        let (path, listener) = agent_end("reset").await;
        let agent = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            // A stale connection: no hello until the runner breaks the rules.
            let frame = read_any(&mut s).await;
            assert!(
                frame.ch == 0
                    && matches!(&frame.t, Some(T::Req(r)) if matches!(&r.op, Some(Op::Guest(g)) if g.op == "hello")),
                "{frame:?}"
            );
            say(&mut s, 0, T::Hello(info())).await;
            s
        });
        let ch = Channel::open(&path).await.unwrap();
        let t = Instant::now();
        let (_, reset) = ch.hello_or_reset(true).await.unwrap();
        assert!(reset && t.elapsed() >= PLAIN_HELLO);
        drop(agent.await.unwrap());
        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn without_the_reset_a_missing_hello_fails() {
        let (path, listener) = agent_end("off").await;
        let agent = tokio::spawn(async move { listener.accept().await.unwrap().0 });
        let ch = Channel::open(&path).await.unwrap();
        let _s = agent.await.unwrap();
        assert!(ch.hello_or_reset(false).await.is_err());
        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn a_second_miss_after_the_reset_is_unhealthy() {
        let (path, listener) = agent_end("unhealthy").await;
        let agent = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            // Reads the reset and stays silent.
            let frame = read_any(&mut s).await;
            assert_eq!(frame.ch, 0);
            s
        });
        let ch = Channel::open(&path).await.unwrap();
        let t = Instant::now();
        let error = ch.hello_or_reset(true).await.unwrap_err();
        assert!(
            t.elapsed() >= PLAIN_HELLO + RESET_HELLO,
            "{:?}",
            t.elapsed()
        );
        assert!(format!("{error:#}").contains("unhealthy"), "{error:#}");
        assert_eq!(ch.sent_before_hello(), ["ch 0 req guest.hello"]);
        drop(agent.await.unwrap());
        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn frames_before_the_first_hello_are_recorded() {
        let (path, listener) = agent_end("early").await;
        let agent = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let _ = read_any(&mut s).await;
            say(&mut s, 0, T::Hello(info())).await;
            let _ = read_any(&mut s).await;
            s
        });
        let ch = Channel::open(&path).await.unwrap();
        // A runner that breaks the rule: an operation before hello.
        let (_, _) = ch
            .start(
                None,
                Op::Guest(proto::GuestRequest {
                    op: "exec".into(),
                    data: Vec::new(),
                }),
            )
            .await
            .unwrap();
        let _ = ch.info("hello", RESET_HELLO).await.unwrap();
        ch.reset().await.unwrap();
        assert_eq!(ch.sent_before_hello(), ["ch 1 req guest.exec"]);
        drop(agent.await.unwrap());
        let _ = fs::remove_file(&path);
    }

    #[tokio::test]
    async fn a_hello_during_the_setup_means_the_setup_again() {
        let (path, listener) = agent_end("late").await;
        let agent = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            say(&mut s, 0, T::Hello(info())).await;
            // The first setup is lost with the connection the reset ended.
            let first = read_any(&mut s).await;
            say(&mut s, 0, T::Hello(info())).await;
            let second = read_any(&mut s).await;
            assert!(second.ch > first.ch, "{first:?} {second:?}");
            say(
                &mut s,
                second.ch,
                T::Ans(proto::DaemonAnswer {
                    result: Some(Answer::Done(proto::Empty {})),
                }),
            )
            .await;
            say(
                &mut s,
                0,
                T::Status(proto::GuestInfo {
                    ready: true,
                    ..info()
                }),
            )
            .await;
            s
        });
        let ch = Channel::open(&path).await.unwrap();
        let (_, reset) = ch.hello_or_reset(true).await.unwrap();
        assert!(!reset);
        let op = || {
            Op::Guest(proto::GuestRequest {
                op: "hello".into(),
                data: Vec::new(),
            })
        };
        assert_eq!(ch.setup_after_hello(op).await.unwrap(), 1);
        drop(agent.await.unwrap());
        let _ = fs::remove_file(&path);
    }
}
