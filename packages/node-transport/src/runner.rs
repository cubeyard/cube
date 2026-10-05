//! VM lifecycle on a trusted runner host (protocol 3).
//!
//! A runner hosts one QEMU VM per active thread. It runs no command of its
//! own for a thread and opens no network socket for a guest: the guest's
//! only network is the frame pump to `cube-gateway`. QEMU itself runs as the
//! runner account; the guest is the isolation boundary, QEMU is not hardened
//! beyond `-sandbox on` (Linux).
//!
//! The daemon owns its journal exclusively and never replays on boot.
//! Every mutation is fenced by the thread's lease epoch and idempotent by
//! content: the same request returns the current record.
use std::{
    collections::HashMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Child,
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, ensure};
use iroh::EndpointId;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

pub use crate::journal::{Binding, Installation, VmConfig, VmLimits, VmState};
use crate::{
    journal::{self, Journal, VmRow},
    pump::{FrameGrant, Pumps},
    seed::Seed,
    vm::{self, Qmp, Spawner, VmPaths},
};

/// One active VM per runner this round; more is a later seam.
pub const MAX_ACTIVE_VMS: u64 = 1;
/// `vm.stop`: time the guest gets after ACPI power-down before `quit`.
pub const STOP_GRACE: Duration = Duration::from_secs(30);
const QUIT_GRACE: Duration = Duration::from_secs(10);
/// A `vm.start` request waits this long for QMP before answering `starting`.
const START_WAIT: Duration = Duration::from_secs(3);
/// After this long without QMP a starting QEMU is killed.
const QMP_READY: Duration = Duration::from_secs(60);
const CONSOLE_TAIL: u64 = 16 * 1024;
const MAX_VCPUS: u32 = 64;
const MIN_MEMORY_MIB: u32 = 256;
const MAX_MEMORY_MIB: u32 = 1024 * 1024;
const MAX_DISK_GIB: u32 = 4096;
const GIB: u64 = 1 << 30;

#[derive(Debug)]
pub struct RunnerError(pub &'static str);
impl std::fmt::Display for RunnerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for RunnerError {}

#[derive(Debug)]
pub struct RunnerErrorDetail(pub &'static str, pub String);
impl std::fmt::Display for RunnerErrorDetail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.1)
    }
}
impl std::error::Error for RunnerErrorDetail {}

pub(crate) fn reject<T>(code: &'static str) -> Result<T> {
    Err(RunnerError(code).into())
}
fn detail<T>(code: &'static str, message: impl Into<String>) -> Result<T> {
    Err(RunnerErrorDetail(code, message.into()).into())
}

pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// 16 lowercase hex characters, chosen by cubed at thread creation.
pub fn valid_vm_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// A locally administered unicast MAC in lowercase `xx:xx:xx:xx:xx:xx`.
pub fn valid_mac(mac: &str) -> bool {
    let parts: Vec<&str> = mac.split(':').collect();
    parts.len() == 6
        && parts
            .iter()
            .all(|p| p.len() == 2 && p.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
        && u8::from_str_radix(parts[0], 16).is_ok_and(|first| first & 0x03 == 0x02)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// The wire record of one VM.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VmRecord {
    pub vm_id: String,
    pub thread_id: String,
    pub state: VmState,
    /// The last stop was not clean: the runner died or the guest had to be
    /// killed. Cleared by the next successful start.
    pub interrupted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub disk_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub seed_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerStatus {
    /// `ready`, `draining`, `faulted` or `recoveryRequired`.
    pub lifecycle: String,
    pub draining: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub active_vms: u64,
    pub running_vms: u64,
    pub max_active_vms: u64,
    pub retained_vms: u64,
    pub retained_bytes: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayGrant {
    pub peer: String,
    pub frame_token: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StartSpec {
    pub vcpus: u32,
    #[serde(rename = "memoryMiB")]
    pub memory_mib: u32,
    pub mac: String,
    pub seed: Seed,
    pub gateway: GatewayGrant,
}

/// Operator choices at `init`.
#[derive(Clone, Debug, Default)]
pub struct InitOptions {
    pub qemu: Option<PathBuf>,
    pub firmware: Option<PathBuf>,
    pub limits: VmLimits,
}

struct Live {
    pid: u32,
    exited: watch::Receiver<bool>,
}

pub struct Runner {
    installation: Installation,
    state: PathBuf,
    quarantine: PathBuf,
    journal: Mutex<Journal>,
    accepting: AtomicBool,
    faulted: AtomicBool,
    /// Serializes mutations; inspection and status do not take it.
    ops: tokio::sync::Mutex<()>,
    live: Mutex<HashMap<String, Live>>,
    pumps: Arc<Pumps>,
    spawner: Spawner,
    this: Weak<Runner>,
}

fn require_unix_user() -> Result<()> {
    ensure!(
        cfg!(any(target_os = "linux", target_os = "macos")),
        "the runner requires Linux or macOS"
    );
    ensure!(
        unsafe { libc::geteuid() } != 0,
        "refusing to run the runner as root"
    );
    Ok(())
}

fn file_bytes(path: &Path) -> u64 {
    fs::symlink_metadata(path).map_or(0, |m| m.blocks() * 512)
}

fn dir_bytes(path: &Path) -> u64 {
    let Ok(entries) = fs::read_dir(path) else {
        return 0;
    };
    entries
        .flatten()
        .map(|entry| match entry.file_type() {
            Ok(kind) if kind.is_dir() => dir_bytes(&entry.path()),
            _ => file_bytes(&entry.path()),
        })
        .sum()
}

fn tail(path: &Path, limit: u64) -> Option<String> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(limit)))
        .ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

impl Runner {
    pub fn installation(&self) -> &Installation {
        &self.installation
    }

    pub fn state_dir(&self) -> &Path {
        &self.state
    }

    /// Local operator enrollment, not an RPC. Requires a NEW state directory.
    /// The base image is copied in and identified by its sha256.
    pub fn initialize(
        state: &Path,
        binding: Binding,
        peer: EndpointId,
        allowed: EndpointId,
        image: &Path,
        options: InitOptions,
    ) -> Result<Installation> {
        require_unix_user()?;
        let platform = vm::host_platform()
            .context("supported runner platforms are Linux x86_64 and macOS arm64")?;
        crate::validate_node_id(&binding.node_id)?;
        ensure!(
            valid_id(&binding.thread_id)
                && (1..=journal::MAX_EPOCH).contains(&binding.environment_id),
            "invalid binding"
        );
        let limits = options.limits;
        ensure!(
            (1..=MAX_VCPUS).contains(&limits.max_vcpus)
                && (MIN_MEMORY_MIB..=MAX_MEMORY_MIB).contains(&limits.max_memory_mib)
                && (1..=MAX_DISK_GIB).contains(&limits.max_disk_gib),
            "VM limits out of range"
        );
        let qemu_name = options
            .qemu
            .unwrap_or_else(|| vm::default_qemu(platform).into());
        let qemu = vm::which(&qemu_name.to_string_lossy())
            .with_context(|| format!("QEMU not found: {}", qemu_name.display()))?;
        let qemu = fs::canonicalize(qemu)?;
        vm::check_qemu(&qemu)?;
        let qemu_img = qemu
            .parent()
            .map(|dir| dir.join("qemu-img"))
            .filter(|path| path.is_file())
            .or_else(|| vm::which("qemu-img"))
            .context("qemu-img not found next to QEMU or on PATH")?;
        let firmware = match (options.firmware, platform) {
            (Some(path), _) => Some(
                fs::canonicalize(&path)
                    .with_context(|| format!("firmware {} not found", path.display()))?,
            ),
            (None, vm::PLATFORM_MACOS_AARCH64) => Some(
                [
                    "/opt/homebrew/share/qemu/edk2-aarch64-code.fd",
                    "/usr/local/share/qemu/edk2-aarch64-code.fd",
                ]
                .iter()
                .map(PathBuf::from)
                .find(|path| path.is_file())
                .context("arm64 UEFI firmware not found; pass --firmware")?,
            ),
            (None, _) => None,
        };
        {
            let mut probe = File::open(image)
                .with_context(|| format!("open base image {}", image.display()))?;
            let virtual_size = journal::qcow2_virtual_size(&mut probe)?;
            ensure!(
                u64::from(limits.max_disk_gib) * GIB >= virtual_size,
                "--max-disk-gib is smaller than the base image"
            );
        }
        let state_parent = state
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new("."));
        ensure!(
            !state.exists(),
            "state directory already exists; never rebind it"
        );
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new().mode(0o700).create(state)?;
        }
        let state = fs::canonicalize(state)?;
        VmPaths::new(&state, 999_999).check_socket_lengths()?;
        let (image, _) = journal::import_image(&state, image)?;
        journal::private_dir(&state.join("vms"))?;
        let installation = Installation {
            binding,
            peer_id: peer.to_string(),
            allowed_peer: allowed.to_string(),
            platform: platform.into(),
            image,
            qemu,
            qemu_img,
            firmware,
            limits,
        };
        Journal::create(&state, &installation, peer)?;
        File::open(fs::canonicalize(state_parent)?)?.sync_all()?;
        Ok(installation)
    }

    /// Opens existing state, verifies the base image and reconciles VMs a
    /// previous process left running: each is stopped and marked
    /// `interrupted`. The runner never signals a process it did not spawn.
    pub fn open(state: &Path, peer: EndpointId) -> Result<Arc<Self>> {
        require_unix_user()?;
        let state = fs::canonicalize(state)?;
        let (journal, installation) = Journal::open(&state, peer)?;
        journal::verify_image(&state, &installation.image)?;
        journal::private_dir(&state.join("vms"))?;
        let quarantine = state.join("restore-quarantine");
        for row in journal.all()? {
            match row.state {
                VmState::Allocating | VmState::Releasing => {
                    // A crash between two durable transitions: keep the tree
                    // and let an operator look at it.
                    journal.set_state(
                        &row.vm_id,
                        VmState::Failed,
                        Some("interrupted during allocation or release; disk retained"),
                    )?;
                }
                live if live.live() => {
                    quit_orphan(&VmPaths::new(&state, row.slot).qmp, &row.vm_id);
                    journal.set_state(&row.vm_id, VmState::Stopped, None)?;
                    journal.set_interrupted(&row.vm_id, true)?;
                }
                _ => {}
            }
        }
        let quarantined = quarantine.exists();
        Ok(Arc::new_cyclic(|this| Self {
            installation,
            quarantine,
            journal: Mutex::new(journal),
            accepting: AtomicBool::new(!quarantined),
            faulted: AtomicBool::new(false),
            ops: tokio::sync::Mutex::new(()),
            live: Mutex::new(HashMap::new()),
            pumps: Arc::new(Pumps::default()),
            spawner: Spawner::new(),
            this: this.clone(),
            state,
        }))
    }

    /// Run before serving: the accelerator and QEMU must be usable now.
    pub fn preflight(&self) -> Result<()> {
        vm::check_accelerator(&self.installation.platform)?;
        vm::check_qemu(&self.installation.qemu)?;
        ensure!(
            self.installation.qemu_img.is_file(),
            "qemu-img {} is missing",
            self.installation.qemu_img.display()
        );
        if let Some(firmware) = &self.installation.firmware {
            ensure!(
                firmware.is_file(),
                "firmware {} is missing",
                firmware.display()
            );
        }
        Ok(())
    }

    /// Complete an offline restore: the journal must open with this key and
    /// the base image must verify. VMs that were running at backup time are
    /// already recorded `stopped`/`interrupted` by `open`.
    pub fn acknowledge_recovery(state: &Path, peer: EndpointId) -> Result<()> {
        let marker = state.join("restore-quarantine");
        journal::private_file(&marker, false)
            .context("restore quarantine is required for recovery acknowledgement")?;
        let runner = Self::open(state, peer)?;
        fs::remove_file(&marker)?;
        File::open(&runner.state)?.sync_all()?;
        Ok(())
    }

    pub fn pumps(&self) -> Arc<Pumps> {
        self.pumps.clone()
    }

    fn paths(&self, slot: u32) -> VmPaths {
        VmPaths::new(&self.state, slot)
    }

    fn arc(&self) -> Arc<Self> {
        self.this.upgrade().expect("runner is alive while in use")
    }

    fn record(&self, row: &VmRow) -> VmRecord {
        let disk_bytes = match row.state {
            VmState::Released => 0,
            _ => file_bytes(&self.paths(row.slot).disk),
        };
        VmRecord {
            vm_id: row.vm_id.clone(),
            thread_id: row.thread_id.clone(),
            state: row.state,
            interrupted: row.interrupted,
            error: row.error.clone(),
            disk_bytes,
            seed_sha256: row.config.as_ref().map(|c| c.seed_sha256.clone()),
            started_at: row.started_at,
        }
    }

    fn current(&self, vm_id: &str) -> Result<VmRecord> {
        let row = self.journal.lock().unwrap().get(vm_id)?;
        row.map(|row| self.record(&row))
            .context("vm record vanished")
    }

    pub fn status(&self) -> Result<RunnerStatus> {
        let rows = self.journal.lock().unwrap().all()?;
        let retained: Vec<&VmRow> = rows
            .iter()
            .filter(|row| matches!(row.state, VmState::Retained | VmState::Failed))
            .collect();
        let faulted = self.faulted.load(Ordering::SeqCst);
        let accepting = self.accepting.load(Ordering::SeqCst);
        Ok(RunnerStatus {
            lifecycle: if self.quarantine.exists() {
                "recoveryRequired"
            } else if faulted {
                "faulted"
            } else if accepting {
                "ready"
            } else {
                "draining"
            }
            .into(),
            draining: !accepting,
            error: faulted.then(|| "IO_ERROR".into()),
            active_vms: rows.iter().filter(|row| row.state.active()).count() as u64,
            running_vms: self.live.lock().unwrap().len() as u64,
            max_active_vms: MAX_ACTIVE_VMS,
            retained_vms: retained.len() as u64,
            retained_bytes: retained
                .iter()
                .map(|row| dir_bytes(&self.paths(row.slot).dir))
                .sum(),
        })
    }

    /// Draining is local operator authority: `vm.allocate` and `vm.start`
    /// are refused, running VMs keep running.
    pub fn drain(&self) {
        self.accepting.store(false, Ordering::SeqCst);
    }

    pub fn resume(&self) -> Result<()> {
        ensure!(
            !self.quarantine.exists() && !self.faulted.load(Ordering::SeqCst),
            "runner requires offline operator recovery"
        );
        self.accepting.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn check_ids(thread_id: &str, vm_id: &str) -> Result<()> {
        if !valid_id(thread_id) || !valid_vm_id(vm_id) {
            return reject("INVALID_REQUEST");
        }
        Ok(())
    }

    /// Looks up a VM for a request naming `thread_id`.
    fn row_for(&self, thread_id: &str, vm_id: &str) -> Result<VmRow> {
        let Some(row) = self.journal.lock().unwrap().get(vm_id)? else {
            return detail("NOT_FOUND", "no such vm on this runner");
        };
        if row.thread_id != thread_id {
            return detail("CONFLICT", "vm belongs to another thread");
        }
        Ok(row)
    }

    pub fn inspect(&self, thread_id: &str, vm_id: &str) -> Result<(VmRecord, Option<String>)> {
        Self::check_ids(thread_id, vm_id)?;
        let row = self.row_for(thread_id, vm_id)?;
        let console = tail(&self.paths(row.slot).console, CONSOLE_TAIL);
        Ok((self.record(&row), console))
    }

    pub async fn allocate(
        &self,
        thread_id: &str,
        vm_id: &str,
        epoch: u64,
        disk_gib: u32,
    ) -> Result<VmRecord> {
        Self::check_ids(thread_id, vm_id)?;
        let limits = &self.installation.limits;
        if disk_gib == 0
            || disk_gib > limits.max_disk_gib
            || u64::from(disk_gib) * GIB < self.installation.image.virtual_size
        {
            return detail(
                "INVALID_REQUEST",
                format!(
                    "diskGiB must cover the base image ({} bytes) and stay within {}",
                    self.installation.image.virtual_size, limits.max_disk_gib
                ),
            );
        }
        let _ops = self.ops.lock().await;
        let slot = {
            let journal = self.journal.lock().unwrap();
            journal.fence(thread_id, epoch)?;
            if let Some(row) = journal.get(vm_id)? {
                if row.thread_id != thread_id || row.disk_gib != disk_gib {
                    return detail("CONFLICT", "vm exists with a different thread or disk size");
                }
                return Ok(self.record(&row));
            }
            if !self.accepting.load(Ordering::SeqCst) {
                return reject("DRAINING");
            }
            let rows = journal.all()?;
            if rows
                .iter()
                .any(|row| row.thread_id == thread_id && row.state.active())
            {
                return detail("CONFLICT", "thread already has an active vm");
            }
            if rows.iter().filter(|row| row.state.active()).count() as u64 >= MAX_ACTIVE_VMS {
                return reject("CAPACITY_EXCEEDED");
            }
            journal.insert_allocating(vm_id, thread_id, disk_gib)?
        };
        let paths = self.paths(slot);
        let created = self.create_disk(&paths, disk_gib).await;
        let journal = self.journal.lock().unwrap();
        match created {
            Ok(()) => {
                journal.set_state(vm_id, VmState::Allocated, None)?;
                Ok(self.record(&journal.get(vm_id)?.context("vm record vanished")?))
            }
            Err(error) => {
                // Nothing of the VM existed yet: forget it so cubed can retry.
                let _ = fs::remove_dir_all(&paths.dir);
                journal.forget_allocation(vm_id)?;
                detail(
                    "IO_ERROR",
                    format!("creating the vm disk failed: {error:#}"),
                )
            }
        }
    }

    async fn create_disk(&self, paths: &VmPaths, disk_gib: u32) -> Result<()> {
        paths.check_socket_lengths()?;
        journal::private_dir(&paths.dir)?;
        // Relative backing path: a restored state directory may live elsewhere.
        let backing = format!("../../images/{}.qcow2", self.installation.image.sha256);
        let output = tokio::process::Command::new(&self.installation.qemu_img)
            .args(["create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", &backing])
            .arg(&paths.disk)
            .arg(format!("{disk_gib}G"))
            .current_dir(&paths.dir)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .stdin(std::process::Stdio::null())
            .output()
            .await?;
        ensure!(
            output.status.success(),
            "qemu-img create failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        ensure!(paths.disk.is_file(), "qemu-img created no disk");
        File::open(&paths.dir)?.sync_all()?;
        Ok(())
    }

    pub async fn start(
        &self,
        thread_id: &str,
        vm_id: &str,
        epoch: u64,
        spec: StartSpec,
    ) -> Result<VmRecord> {
        Self::check_ids(thread_id, vm_id)?;
        let limits = &self.installation.limits;
        if !(1..=limits.max_vcpus).contains(&spec.vcpus)
            || !(MIN_MEMORY_MIB..=limits.max_memory_mib).contains(&spec.memory_mib)
            || !valid_mac(&spec.mac)
            || !crate::l2::valid_frame_token(&spec.gateway.frame_token)
        {
            return reject("INVALID_REQUEST");
        }
        let Ok(gateway) = spec.gateway.peer.parse::<EndpointId>() else {
            return reject("INVALID_REQUEST");
        };
        if let Err(error) = spec.seed.validate() {
            return detail("INVALID_REQUEST", format!("{error:#}"));
        }
        let grant = FrameGrant::new(gateway, &spec.gateway.frame_token);
        let config = VmConfig {
            vcpus: spec.vcpus,
            memory_mib: spec.memory_mib,
            mac: spec.mac.clone(),
            seed_sha256: spec.seed.sha256(),
        };
        let _ops = self.ops.lock().await;
        self.journal.lock().unwrap().fence(thread_id, epoch)?;
        let row = self.row_for(thread_id, vm_id)?;
        // The first start fixes vcpus, memory, mac and seed. Later starts
        // reuse them and ignore the request's sizes and seed: cubed rebuilds
        // its seed and sizes from its current release and settings, which
        // must never strand an existing VM. The mac names the VM on the
        // gateway's LAN, so a different one is a real conflict.
        if row.config.as_ref().is_some_and(|c| c.mac != config.mac) {
            return detail("CONFLICT", "the mac is fixed at the vm's first start");
        }
        match row.state {
            VmState::Starting | VmState::Running => {
                // A new grant (newer epoch, restarted cubed or gateway)
                // replaces the frame connection; the VM keeps running.
                self.pumps.authorize(vm_id, grant);
                return Ok(self.record(&row));
            }
            VmState::Allocated | VmState::Stopped => {}
            state => {
                return detail(
                    "CONFLICT",
                    format!("vm is {}; it cannot start", state.as_str()),
                );
            }
        }
        if !self.accepting.load(Ordering::SeqCst) {
            return reject("DRAINING");
        }
        let paths = self.paths(row.slot);
        let config = match row.config.clone() {
            None => {
                spec.seed.write(&paths.seed)?;
                self.journal.lock().unwrap().set_config(vm_id, &config)?;
                config
            }
            Some(mut fixed) => {
                if !paths.seed.is_file() {
                    // A lost seed image is rewritten from this request.
                    spec.seed.write(&paths.seed)?;
                    fixed.seed_sha256 = config.seed_sha256;
                    self.journal.lock().unwrap().replace_config(vm_id, &fixed)?;
                }
                fixed
            }
        };
        if paths.console.exists() {
            let _ = fs::rename(&paths.console, paths.dir.join("console.prev.log"));
        }
        let _ = fs::remove_file(&paths.qmp);
        // Sockets of runners before the socket pair.
        let _ = fs::remove_file(&paths.net);
        let _ = fs::remove_file(&paths.qemu_net);
        let net_fd = self.pumps.open(vm_id, thread_id, grant)?;
        let args = vm::qemu_args(&vm::Launch {
            platform: &self.installation.platform,
            firmware: self.installation.firmware.as_deref(),
            vm_id,
            vcpus: config.vcpus,
            memory_mib: config.memory_mib,
            mac: &config.mac,
            paths: &paths,
            net_fd: std::os::fd::AsRawFd::as_raw_fd(&net_fd),
        })?;
        self.journal.lock().unwrap().set_started(vm_id, now_ms())?;
        let spawned = vm::qemu_command(&self.installation.qemu, args, &paths.qemu_log)
            .and_then(|command| self.spawner.spawn(command));
        // QEMU holds its own copy now (or failed to start).
        drop(net_fd);
        let child = match spawned {
            Ok(child) => child,
            Err(error) => {
                self.pumps.close(vm_id);
                self.journal.lock().unwrap().set_state(
                    vm_id,
                    row.state,
                    Some(&format!("starting qemu failed: {error:#}")),
                )?;
                return self.current(vm_id);
            }
        };
        let exited = self.watch(vm_id, child, paths.qemu_log.clone());
        let ready =
            Self::wait_for_qmp(paths.qmp.clone(), vm_id.into(), exited.clone(), START_WAIT).await;
        if ready {
            self.mark_running(vm_id)?;
        } else if !*exited.borrow() {
            let runner = self.arc();
            let vm_id = vm_id.to_owned();
            tokio::spawn(async move {
                let ready = Self::wait_for_qmp(
                    runner.paths(row.slot).qmp,
                    vm_id.clone(),
                    exited,
                    QMP_READY,
                )
                .await;
                if ready {
                    let _ = runner.mark_running(&vm_id);
                } else {
                    runner.kill(&vm_id);
                }
            });
        }
        self.current(vm_id)
    }

    /// Registers a spawned QEMU and reaps it on a dedicated thread. When it
    /// exits the record becomes `stopped` (unless a release is under way)
    /// and the frame pump closes.
    fn watch(&self, vm_id: &str, mut child: Child, log: PathBuf) -> watch::Receiver<bool> {
        let (tx, rx) = watch::channel(false);
        let pid = child.id();
        self.live.lock().unwrap().insert(
            vm_id.into(),
            Live {
                pid,
                exited: rx.clone(),
            },
        );
        let runner = self.this.clone();
        let vm_id = vm_id.to_owned();
        std::thread::Builder::new()
            .name(format!("cube-vm-{vm_id}"))
            .spawn(move || {
                // Wait without reaping, drop the live entry, then reap: while
                // the entry exists the PID cannot belong to anyone else, so
                // `kill` never hits a reused PID.
                wait_exit_unreaped(pid);
                if let Some(runner) = runner.upgrade() {
                    runner.live.lock().unwrap().remove(&vm_id);
                }
                let status = child.wait();
                if let Some(runner) = runner.upgrade() {
                    let error = match &status {
                        Ok(status) if status.success() => None,
                        Ok(status) => Some(format!(
                            "qemu exited ({status}): {}",
                            tail(&log, 512).unwrap_or_default().trim()
                        )),
                        Err(error) => Some(format!("waiting for qemu failed: {error}")),
                    };
                    runner.exited(&vm_id, error.as_deref());
                }
                let _ = tx.send(true);
            })
            .expect("spawn reaper thread");
        rx
    }

    fn exited(&self, vm_id: &str, error: Option<&str>) {
        self.pumps.close(vm_id);
        let journal = self.journal.lock().unwrap();
        let current = journal.get(vm_id).ok().flatten();
        // A requested stop records no error; an unexpected exit does.
        let error = match current.map(|row| row.state) {
            Some(VmState::Stopping) => None,
            _ => error,
        };
        if journal
            .transition(
                vm_id,
                &[VmState::Starting, VmState::Running, VmState::Stopping],
                VmState::Stopped,
                error,
            )
            .is_err()
        {
            self.faulted.store(true, Ordering::SeqCst);
            self.accepting.store(false, Ordering::SeqCst);
        }
    }

    /// `starting` -> `running` once QMP answered with the VM's name. A boot
    /// that got this far clears an earlier `interrupted`.
    fn mark_running(&self, vm_id: &str) -> Result<()> {
        let journal = self.journal.lock().unwrap();
        if journal.transition(vm_id, &[VmState::Starting], VmState::Running, None)? {
            journal.set_interrupted(vm_id, false)?;
        }
        Ok(())
    }

    async fn wait_for_qmp(
        path: PathBuf,
        vm_id: String,
        exited: watch::Receiver<bool>,
        budget: Duration,
    ) -> bool {
        let deadline = Instant::now() + budget;
        while Instant::now() < deadline && !*exited.borrow() {
            let (path, vm_id) = (path.clone(), vm_id.clone());
            let named = tokio::task::spawn_blocking(move || {
                Qmp::connect(&path, Duration::from_secs(2))
                    .and_then(|mut qmp| qmp.name())
                    .is_ok_and(|name| name == vm_id)
            })
            .await
            .unwrap_or(false);
            if named {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        false
    }

    /// SIGKILL for a QEMU this process spawned and has not reaped yet.
    fn kill(&self, vm_id: &str) {
        if let Some(live) = self.live.lock().unwrap().get(vm_id)
            && !*live.exited.borrow()
        {
            // The entry is removed before the reaper reaps, so while we hold
            // the lock the PID is still this QEMU (at worst a zombie).
            unsafe {
                libc::kill(live.pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }

    /// Stops a live VM: ACPI power-down (when `graceful`), then QMP `quit`,
    /// then SIGKILL. A forced stop marks the VM `interrupted`.
    async fn stop_vm(&self, vm_id: &str, slot: u32, graceful: bool) {
        let Some(mut exited) = self
            .live
            .lock()
            .unwrap()
            .get(vm_id)
            .map(|live| live.exited.clone())
        else {
            return;
        };
        let qmp = self.paths(slot).qmp;
        let command = |command: &'static str| {
            let qmp = qmp.clone();
            tokio::task::spawn_blocking(move || {
                let mut connection = Qmp::connect(&qmp, Duration::from_secs(2))?;
                connection.execute(command)?;
                Ok::<_, anyhow::Error>(())
            })
        };
        if graceful {
            let _ = command("system_powerdown").await;
            if tokio::time::timeout(STOP_GRACE, exited.wait_for(|e| *e))
                .await
                .is_ok()
            {
                return;
            }
        }
        let _ = self.journal.lock().unwrap().set_interrupted(vm_id, true);
        let _ = command("quit").await;
        if tokio::time::timeout(QUIT_GRACE, exited.wait_for(|e| *e))
            .await
            .is_ok()
        {
            return;
        }
        self.kill(vm_id);
        let _ = exited.wait_for(|e| *e).await;
    }

    pub async fn stop(&self, thread_id: &str, vm_id: &str, epoch: u64) -> Result<VmRecord> {
        Self::check_ids(thread_id, vm_id)?;
        let _ops = self.ops.lock().await;
        self.journal.lock().unwrap().fence(thread_id, epoch)?;
        let row = self.row_for(thread_id, vm_id)?;
        if matches!(row.state, VmState::Starting | VmState::Running) {
            self.journal
                .lock()
                .unwrap()
                .set_state(vm_id, VmState::Stopping, None)?;
            self.pumps.close(vm_id);
            let runner = self.arc();
            let vm_id = vm_id.to_owned();
            tokio::spawn(async move { runner.stop_vm(&vm_id, row.slot, true).await });
        }
        self.current(vm_id)
    }

    /// `retain: false` deletes the VM directory; `retain: true`, an
    /// interrupted VM and a failed one keep it as evidence.
    pub async fn release(
        &self,
        thread_id: &str,
        vm_id: &str,
        epoch: u64,
        retain: bool,
    ) -> Result<VmRecord> {
        Self::check_ids(thread_id, vm_id)?;
        let _ops = self.ops.lock().await;
        self.journal.lock().unwrap().fence(thread_id, epoch)?;
        let row = self.row_for(thread_id, vm_id)?;
        match row.state {
            VmState::Released | VmState::Retained | VmState::Releasing => {
                return Ok(self.record(&row));
            }
            VmState::Failed | VmState::Allocating => {
                let journal = self.journal.lock().unwrap();
                journal.set_retain(vm_id, true)?;
                journal.set_state(vm_id, VmState::Retained, row.error.as_deref())?;
                drop(journal);
                return self.current(vm_id);
            }
            _ => {}
        }
        {
            let journal = self.journal.lock().unwrap();
            journal.set_retain(vm_id, retain)?;
            journal.set_state(vm_id, VmState::Releasing, None)?;
        }
        self.pumps.close(vm_id);
        if row.state.live() {
            let runner = self.arc();
            let vm_id = vm_id.to_owned();
            tokio::spawn(async move {
                runner.stop_vm(&vm_id, row.slot, true).await;
                runner.finish_release(&vm_id, row.slot);
            });
        } else {
            self.finish_release(vm_id, row.slot);
        }
        self.current(vm_id)
    }

    fn finish_release(&self, vm_id: &str, slot: u32) {
        let journal = self.journal.lock().unwrap();
        let Ok(Some(row)) = journal.get(vm_id) else {
            return;
        };
        if row.state != VmState::Releasing {
            return;
        }
        let result = if row.retain || row.interrupted {
            journal.set_state(vm_id, VmState::Retained, None)
        } else {
            match fs::remove_dir_all(self.paths(slot).dir) {
                Ok(()) => journal.set_state(vm_id, VmState::Released, None),
                Err(error) => journal.set_state(
                    vm_id,
                    VmState::Failed,
                    Some(&format!("deleting the vm directory failed: {error}")),
                ),
            }
        };
        if result.is_err() {
            self.faulted.store(true, Ordering::SeqCst);
            self.accepting.store(false, Ordering::SeqCst);
        }
    }

    /// Daemon shutdown: refuse new work and stop every running VM. Graceful
    /// gives each guest [`STOP_GRACE`] after ACPI power-down; otherwise QEMU
    /// is told to quit at once and the VMs are marked `interrupted`.
    pub async fn shutdown(&self, graceful: bool) {
        self.drain();
        let live: Vec<String> = self.live.lock().unwrap().keys().cloned().collect();
        let mut stops = tokio::task::JoinSet::new();
        for vm_id in live {
            let slot = match self.journal.lock().unwrap().get(&vm_id) {
                Ok(Some(row)) => row.slot,
                _ => continue,
            };
            let _ = self.journal.lock().unwrap().transition(
                &vm_id,
                &[VmState::Starting, VmState::Running],
                VmState::Stopping,
                None,
            );
            let runner = self.arc();
            stops.spawn(async move { runner.stop_vm(&vm_id, slot, graceful).await });
        }
        while stops.join_next().await.is_some() {}
        self.pumps.close_all();
    }

    pub fn has_running_vms(&self) -> bool {
        !self.live.lock().unwrap().is_empty()
    }
}

fn wait_exit_unreaped(pid: u32) {
    loop {
        // SAFETY: plain syscall on a zeroed siginfo owned by this frame.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if result == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return;
        }
    }
}

/// Startup reconciliation for a VM a previous runner process left live. On
/// Linux PDEATHSIG has already killed QEMU and nothing answers; on macOS
/// QEMU may still run and is told to quit over its QMP socket.
fn quit_orphan(qmp: &Path, vm_id: &str) {
    let Ok(mut connection) = Qmp::connect(qmp, Duration::from_secs(2)) else {
        return;
    };
    if connection.name().is_ok_and(|name| name == vm_id) && connection.execute("quit").is_ok() {
        connection.wait_closed(QUIT_GRACE);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers() {
        assert!(valid_vm_id("0123456789abcdef"));
        for id in [
            "0123456789ABCDEF",
            "0123456789abcde",
            "0123456789abcdefg",
            "",
        ] {
            assert!(!valid_vm_id(id), "{id}");
        }
        assert!(valid_mac("02:aa:bb:cc:dd:ee"));
        assert!(valid_mac("06:00:00:00:00:00"));
        for mac in [
            "00:aa:bb:cc:dd:ee", // globally administered
            "03:aa:bb:cc:dd:ee", // multicast
            "02:AA:bb:cc:dd:ee",
            "02:aa:bb:cc:dd",
            "02-aa-bb-cc-dd-ee",
        ] {
            assert!(!valid_mac(mac), "{mac}");
        }
    }
}
