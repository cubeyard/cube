//! Shared fixture: a runner initialized with the fake QEMU and qemu-img in
//! this directory, served on Iroh loopback, and request builders.
#![allow(dead_code)]
use std::{
    io::Write,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use cube_node_transport::{
    Request, Response, bind_loopback, bind_runner, call,
    runner::{Binding, InitOptions, Runner, VmLimits, VmRecord, VmState},
    serve_runner,
};
use iroh::{Endpoint, EndpointAddr, SecretKey};
use serde_json::{Value, json};
use tokio::task::JoinHandle;

pub const NODE: &str = "node-test";
pub const VM: &str = "0123456789abcdef";
pub const VM2: &str = "fedcba9876543210";
pub const TOKEN: &str = "1111111111111111111111111111111111111111111111111111111111111111";
pub const TOKEN2: &str = "2222222222222222222222222222222222222222222222222222222222222222";

fn qcow2(virtual_size: u64) -> Vec<u8> {
    let mut bytes = vec![0u8; 4096];
    bytes[..4].copy_from_slice(b"QFI\xfb");
    bytes[4..8].copy_from_slice(&3u32.to_be_bytes());
    bytes[24..32].copy_from_slice(&virtual_size.to_be_bytes());
    bytes
}

pub struct Fixture {
    pub root: tempfile::TempDir,
    pub bin: PathBuf,
    pub state: PathBuf,
    pub key: SecretKey,
    pub control: SecretKey,
    pub gateway: SecretKey,
}

pub fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let support = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support");
    std::fs::copy(support.join("fake-qemu.py"), bin.join("qemu-system-fake")).unwrap();
    std::fs::copy(support.join("fake-qemu-img.sh"), bin.join("qemu-img")).unwrap();
    let firmware = bin.join("firmware.fd");
    std::fs::write(&firmware, b"fake firmware").unwrap();
    let image = root.path().join("base.qcow2");
    std::fs::write(&image, qcow2(3 << 30)).unwrap();
    let state = root.path().join("state");
    let key = SecretKey::generate();
    let control = SecretKey::generate();
    Runner::initialize(
        &state,
        Binding {
            thread_id: "t-install".into(),
            environment_id: 1,
            node_id: NODE.into(),
        },
        key.public(),
        control.public(),
        &image,
        InitOptions {
            qemu: Some(bin.join("qemu-system-fake")),
            firmware: Some(firmware),
            limits: VmLimits::default(),
        },
    )
    .unwrap();
    Fixture {
        root,
        bin,
        state,
        key,
        control,
        gateway: SecretKey::generate(),
    }
}

pub struct Served {
    pub runner: Arc<Runner>,
    pub server: Endpoint,
    pub client: Endpoint,
    pub address: EndpointAddr,
    pub task: JoinHandle<()>,
}

/// How long `open_runner` retries while another holder has `owner.lock`.
pub const OPEN_RETRY: Duration = Duration::from_secs(5);
/// How long `close` waits for the runner's other references to go.
pub const CLOSE_WAIT: Duration = Duration::from_secs(10);
const CONTENDED: &str = "another daemon owns this journal";

/// A contended open that succeeded within the bound.
pub struct Contention {
    pub held: Duration,
    pub holders: String,
}

/// Writes past libtest's output capture, so a passing test's CI log still
/// shows the line.
pub fn report(line: &str) {
    let _ = writeln!(std::io::stderr(), "{line}");
}

/// Opens the fixture's runner. On `owner.lock` contention it reports who
/// holds the lock, retries every 50 ms up to `bound`, and on success reports
/// how long it was held; past the bound it returns both holder dumps.
pub async fn try_open_runner(
    fx: &Fixture,
    bound: Duration,
) -> Result<(Arc<Runner>, Option<Contention>), String> {
    let started = Instant::now();
    let mut first: Option<String> = None;
    loop {
        let error = match Runner::open(&fx.state, fx.key.public()) {
            Ok(runner) => {
                let contention = first.map(|holders| {
                    let held = started.elapsed();
                    report(&format!(
                        "support: owner.lock was held for {} ms by {}",
                        held.as_millis(),
                        holder_summary(&holders)
                    ));
                    Contention { held, holders }
                });
                return Ok((runner, contention));
            }
            Err(error) => error,
        };
        if !error.chain().any(|cause| cause.to_string() == CONTENDED) {
            panic!("{error:?}");
        }
        if first.is_none() {
            let holders = lock_holders(&fx.state);
            report(&format!(
                "support: owner.lock contended at open: {error:#}\n{holders}"
            ));
            first = Some(holders);
        }
        if started.elapsed() >= bound {
            return Err(format!(
                "owner.lock still held after {} ms: {error:#}\n\
                 --- holders at first contention ---\n{}\n\
                 --- holders at the deadline ---\n{}",
                started.elapsed().as_millis(),
                first.unwrap_or_default(),
                lock_holders(&fx.state)
            ));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

pub async fn open_runner(fx: &Fixture) -> Arc<Runner> {
    match try_open_runner(fx, OPEN_RETRY).await {
        Ok((runner, _)) => runner,
        Err(dump) => panic!("{dump}"),
    }
}

/// Who holds `owner.lock` in `state`: on Linux the `/proc/locks` entries on
/// its inode and every process with a descriptor on it (with that
/// descriptor's fdinfo lock line); elsewhere `lsof`, or `fuser` without it.
pub fn lock_holders(state: &Path) -> String {
    let lock = state.join("owner.lock");
    let lock = std::fs::canonicalize(&lock).unwrap_or(lock);
    let mut out = format!("test pid {}; lock {}\n", std::process::id(), lock.display());
    platform_holders(&lock, &mut out);
    out
}

#[cfg(target_os = "linux")]
fn platform_holders(lock: &Path, out: &mut String) {
    use std::{fmt::Write as _, os::unix::fs::MetadataExt};
    let meta = match std::fs::metadata(lock) {
        Ok(meta) => meta,
        Err(error) => {
            let _ = writeln!(out, "stat failed: {error}");
            return;
        }
    };
    let id = format!(
        "{:02x}:{:02x}:{}",
        libc::major(meta.dev()),
        libc::minor(meta.dev()),
        meta.ino()
    );
    let _ = writeln!(out, "/proc/locks on {id}:");
    match std::fs::read_to_string("/proc/locks") {
        Ok(locks) => {
            let lines: Vec<&str> = locks
                .lines()
                .filter(|line| line.split_whitespace().any(|field| field == id))
                .collect();
            if lines.is_empty() {
                let _ = writeln!(out, "  (none)");
            }
            for line in lines {
                let _ = writeln!(out, "  {line}");
            }
        }
        Err(error) => {
            let _ = writeln!(out, "  unreadable: {error}");
        }
    }
    let _ = writeln!(out, "descriptors on owner.lock:");
    let me = std::process::id().to_string();
    let mut found = false;
    for process in std::fs::read_dir("/proc").into_iter().flatten().flatten() {
        let name = process.file_name();
        let Some(pid) = name
            .to_str()
            .filter(|name| name.bytes().all(|b| b.is_ascii_digit()))
        else {
            continue;
        };
        let read = |file: &str| {
            std::fs::read_to_string(process.path().join(file))
                .unwrap_or_default()
                .replace('\0', " ")
                .trim()
                .to_owned()
        };
        for fd in std::fs::read_dir(process.path().join("fd"))
            .into_iter()
            .flatten()
            .flatten()
        {
            if std::fs::read_link(fd.path()).ok().as_deref() != Some(lock) {
                continue;
            }
            found = true;
            let fd = fd.file_name().to_string_lossy().into_owned();
            let locked = read(&format!("fdinfo/{fd}"))
                .lines()
                .filter(|line| line.starts_with("lock:"))
                .collect::<Vec<_>>()
                .join("; ");
            let stat = read("stat");
            let ppid = stat
                .rsplit(") ")
                .next()
                .and_then(|rest| rest.split_whitespace().nth(1))
                .unwrap_or("?");
            let _ = writeln!(
                out,
                "  pid {pid} fd {fd}{} ppid {ppid} comm {:?} cmdline {:?} {}",
                if pid == me { " (test)" } else { "" },
                read("comm"),
                read("cmdline"),
                if locked.is_empty() {
                    "no fdinfo lock line"
                } else {
                    &locked
                },
            );
        }
    }
    if !found {
        let _ = writeln!(out, "  (none)");
    }
}

#[cfg(not(target_os = "linux"))]
fn platform_holders(lock: &Path, out: &mut String) {
    use std::fmt::Write as _;
    let tools: [(&str, &[&str]); 2] = [("lsof", &["-nP", "--"]), ("fuser", &[])];
    for (tool, args) in tools {
        match std::process::Command::new(tool)
            .args(args)
            .arg(lock)
            .output()
        {
            Ok(output) => {
                let _ = writeln!(
                    out,
                    "{tool} ({}):\n{}{}",
                    output.status,
                    String::from_utf8_lossy(&output.stdout),
                    String::from_utf8_lossy(&output.stderr)
                );
                return;
            }
            Err(error) => {
                let _ = writeln!(out, "{tool}: {error}");
            }
        }
    }
}

/// A dump on one line, for the report of a contention that passed.
fn holder_summary(dump: &str) -> String {
    dump.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join(" | ")
}

pub async fn serve(fx: &Fixture) -> Served {
    let runner = open_runner(fx).await;
    // Test state may live on a small tmpfs.
    runner.set_min_free_disk_gib(0);
    let server = bind_runner(
        fx.key.clone(),
        "127.0.0.1:0".parse().unwrap(),
        cube_node_transport::NetworkMode::Loopback,
    )
    .await
    .unwrap();
    let address = EndpointAddr::new(server.id()).with_ip_addr(server.bound_sockets()[0]);
    let task = tokio::spawn({
        let (runner, server, peer) = (runner.clone(), server.clone(), fx.control.public());
        async move {
            serve_runner(&server, peer, NODE, Some(runner))
                .await
                .unwrap()
        }
    });
    let client = bind_loopback(fx.control.clone(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    Served {
        runner,
        server,
        client,
        address,
        task,
    }
}

impl Served {
    pub async fn rpc(&self, value: Value) -> Response {
        let request: Request = serde_json::from_value(value).unwrap();
        call(&self.client, self.address.clone(), NODE, &request)
            .await
            .unwrap()
    }
    pub async fn vm(&self, value: Value) -> VmRecord {
        match self.rpc(value.clone()).await {
            Response::Vm { vm, .. } => vm,
            other => panic!("{value} -> {other:?}"),
        }
    }
    pub async fn code(&self, value: Value) -> String {
        match self.rpc(value.clone()).await {
            Response::Error { code, .. } => code,
            other => panic!("{value} expected an error, got {other:?}"),
        }
    }
    pub async fn wait_state(&self, thread: &str, vm: &str, state: VmState) -> VmRecord {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let record = self.vm(inspect(thread, vm)).await;
            if record.state == state {
                return record;
            }
            assert!(
                Instant::now() < deadline,
                "{vm} stuck in {:?}",
                record.state
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    pub async fn close(self) {
        self.close_timed().await;
    }
    /// `close`, returning how long the runner's other references took to go.
    pub async fn close_timed(self) -> Duration {
        self.task.abort();
        let _ = self.task.await;
        self.client.close().await;
        self.server.close().await;
        // Connection tasks may still hold the runner (and its journal lock)
        // for a moment; the next open of the same state must find it free,
        // so a reference that outlives the wait fails here, not there.
        let started = Instant::now();
        while Arc::strong_count(&self.runner) > 1 {
            if started.elapsed() >= CLOSE_WAIT {
                panic!(
                    "close: the runner still has {} references after {} ms; status {:?}; \
                     live vms {}; tasks alive in this runtime {}; holders:\n{}",
                    Arc::strong_count(&self.runner),
                    started.elapsed().as_millis(),
                    self.runner.status(),
                    self.runner.has_running_vms(),
                    tokio::runtime::Handle::current()
                        .metrics()
                        .num_alive_tasks(),
                    lock_holders(self.runner.state_dir()),
                );
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        started.elapsed()
    }
}

pub fn allocate(thread: &str, vm: &str, epoch: u64, disk: u32) -> Value {
    json!({"method":"vm.allocate","threadId":thread,"vmId":vm,"epoch":epoch,"diskGiB":disk})
}
pub fn start(thread: &str, vm: &str, epoch: u64, gateway: &SecretKey, token: &str) -> Value {
    json!({"method":"vm.start","threadId":thread,"vmId":vm,"epoch":epoch,
        "vcpus":2,"memoryMiB":1024,"mac":"02:00:00:00:00:42",
        "seed":{"metaData":format!("instance-id: {vm}\n"),"userData":"#cloud-config\n",
                "networkConfig":"version: 2\n"},
        "gateway":{"peer":gateway.public().to_string(),"frameToken":token}})
}
pub fn stop(thread: &str, vm: &str, epoch: u64) -> Value {
    json!({"method":"vm.stop","threadId":thread,"vmId":vm,"epoch":epoch})
}
pub fn inspect(thread: &str, vm: &str) -> Value {
    json!({"method":"vm.inspect","threadId":thread,"vmId":vm})
}
pub fn release(thread: &str, vm: &str, epoch: u64, retain: bool) -> Value {
    json!({"method":"vm.release","threadId":thread,"vmId":vm,"epoch":epoch,"retain":retain})
}
