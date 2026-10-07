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
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result, ensure};
use iroh::EndpointId;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::watch;

pub use crate::journal::{Binding, Installation, TemplateState, VmConfig, VmLimits, VmState};
use crate::{
    diagnose::{self, Window, record_event},
    journal::{self, Journal, TemplateRow, VmRow},
    pump::{FrameGrant, Pumps},
    seed::Seed,
    vm::{self, Qmp, Spawner, VmPaths},
};

/// The most active VMs an operator may allow (`--max-active-vms`).
pub const MAX_ACTIVE_VMS_LIMIT: u64 = 32;
/// `--max-active-vms auto` never allows more than this.
pub const AUTO_MAX_ACTIVE_VMS: u64 = 4;
/// Host memory `auto` leaves to the host itself (runner, QEMU overhead, page cache).
const HOST_RESERVE_MIB: u64 = 2048;
/// By default `vm.allocate` refuses a new VM while the state directory's
/// filesystem has less free space than this: overlays grow as guests write,
/// and a full disk would fail every running VM on the runner, not only the
/// new one.
pub const MIN_FREE_DISK_GIB: u64 = 4;
/// `vm.stop`: time the guest gets after ACPI power-down before `quit`.
pub const STOP_GRACE: Duration = Duration::from_secs(30);
const QUIT_GRACE: Duration = Duration::from_secs(10);
/// A `vm.start` request waits this long for QMP before answering `starting`.
const START_WAIT: Duration = Duration::from_secs(3);
/// After this long without QMP a starting QEMU is killed.
const QMP_READY: Duration = Duration::from_secs(60);
const CONSOLE_TAIL: u64 = 16 * 1024;
/// `vm.diagnose` log excerpts. Escaped text is at most four times as long,
/// so a diagnosis stays well within one protocol frame.
const DIAGNOSE_CONSOLE: Window = Window {
    head: 8 * 1024,
    tail: 56 * 1024,
};
const DIAGNOSE_PREVIOUS_CONSOLE: Window = Window {
    head: 0,
    tail: 8 * 1024,
};
const DIAGNOSE_QEMU_LOG: Window = Window {
    head: 0,
    tail: 8 * 1024,
};
/// QMP questions of a diagnosis: per answer, and in all.
const DIAGNOSE_QMP_WAIT: Duration = Duration::from_millis(300);
const DIAGNOSE_QMP_BUDGET: Duration = Duration::from_millis(1000);
const MAX_VCPUS: u32 = 64;
const MIN_MEMORY_MIB: u32 = 256;
const MAX_MEMORY_MIB: u32 = 1024 * 1024;
const MAX_DISK_GIB: u32 = 4096;
const GIB: u64 = 1 << 30;
/// cubed's opaque template metadata (JSON).
pub const MAX_TEMPLATE_META: usize = 4096;

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

use diagnose::now_ms;

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
    /// The template the disk is backed by (absent: the base image).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub template: Option<String>,
}

/// The wire record of a template: a stopped VM's disk, read-only, that new
/// VMs' overlays are backed by.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateRecord {
    pub id: String,
    pub key: String,
    pub meta: String,
    pub state: TemplateState,
    #[serde(rename = "diskGiB")]
    pub disk_gib: u32,
    pub bytes: u64,
    pub created_at: u64,
    /// VMs whose disk still depends on it.
    pub users: u64,
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
    /// QEMU serves one QMP client at a time: the runner's own commands hold
    /// this while connected, and a diagnosis asks only if it is free.
    qmp: Arc<Mutex<()>>,
}

pub struct Runner {
    installation: Installation,
    state: PathBuf,
    quarantine: PathBuf,
    journal: Mutex<Journal>,
    accepting: AtomicBool,
    faulted: AtomicBool,
    /// Active VMs (`VmState::active`) this process admits; 1 until the
    /// operator's choice is applied with `set_max_active_vms`.
    max_active_vms: AtomicU64,
    /// Free space `vm.allocate` requires on the state filesystem; 0 is off.
    min_free_disk_gib: AtomicU64,
    /// Serializes mutations; inspection and status do not take it.
    ops: tokio::sync::Mutex<()>,
    live: Mutex<HashMap<String, Live>>,
    pumps: Arc<Pumps>,
    spawner: Spawner,
    this: Weak<Runner>,
    /// When this process opened the state (ms).
    started_at: u64,
    /// `qemu --version`, from the preflight.
    qemu_version: OnceLock<String>,
}

/// `--max-active-vms auto`: as many VMs as fit if every one uses the
/// installation's per-VM maximum vCPUs and memory, so a host is never
/// oversubscribed whatever sizes cubed asks for; at least 1, at most
/// `AUTO_MAX_ACTIVE_VMS`.
pub fn auto_max_active_vms(limits: &VmLimits) -> u64 {
    let cpus = std::thread::available_parallelism().map_or(1, |n| n.get() as u64);
    capacity_for(host_memory_mib(), cpus, limits)
}

fn capacity_for(host_memory_mib: u64, cpus: u64, limits: &VmLimits) -> u64 {
    let by_memory =
        host_memory_mib.saturating_sub(HOST_RESERVE_MIB) / u64::from(limits.max_memory_mib).max(1);
    let by_cpu = cpus / u64::from(limits.max_vcpus).max(1);
    by_memory.min(by_cpu).clamp(1, AUTO_MAX_ACTIVE_VMS)
}

/// Free space for this user on the filesystem holding `path`.
#[allow(clippy::unnecessary_cast)] // statvfs field types differ on macOS
fn free_disk_bytes(path: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    // SAFETY: a zeroed statvfs owned by this frame and a valid C string.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    (unsafe { libc::statvfs(path.as_ptr(), &mut stat) } == 0)
        .then(|| (stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
}

fn host_memory_mib() -> u64 {
    // SAFETY: sysconf has no preconditions.
    let (pages, size) = unsafe {
        (
            libc::sysconf(libc::_SC_PHYS_PAGES),
            libc::sysconf(libc::_SC_PAGESIZE),
        )
    };
    if pages <= 0 || size <= 0 {
        return 0;
    }
    (pages as u64).saturating_mul(size as u64) >> 20
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

fn tail(path: &Path, limit: u64) -> Option<Vec<u8>> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(limit)))
        .ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    Some(bytes)
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
                    record_event(
                        &VmPaths::new(&state, row.slot).dir,
                        "runner restarted",
                        Some(&format!("the vm was {}; now failed", row.state.as_str())),
                    );
                }
                live if live.live() => {
                    let paths = VmPaths::new(&state, row.slot);
                    let quit = quit_orphan(&paths.qmp, &row.vm_id);
                    journal.set_state(&row.vm_id, VmState::Stopped, None)?;
                    journal.set_interrupted(&row.vm_id, true)?;
                    record_event(
                        &paths.dir,
                        "runner restarted",
                        Some(&format!(
                            "the vm was {}; now stopped, interrupted ({})",
                            live.as_str(),
                            if quit {
                                "its qemu still ran and was told to quit"
                            } else {
                                "no qemu answered"
                            }
                        )),
                    );
                }
                _ => {}
            }
        }
        for template in journal.templates()? {
            if template.state != TemplateState::Publishing {
                // A crash after publishing, before the VM directory went.
                if let Some(row) = journal.get(&template.id)?
                    && row.state == VmState::Released
                {
                    let _ = fs::remove_dir_all(VmPaths::new(&state, row.slot).dir);
                }
                continue;
            }
            // A crash while publishing: the rename either happened or not.
            let disk = template_dir(&state, &template.id).join("disk.qcow2");
            if disk.is_file() {
                journal.finish_publish(&template.id)?;
                if let Some(row) = journal.get(&template.id)? {
                    let _ = fs::remove_dir_all(VmPaths::new(&state, row.slot).dir);
                }
            } else {
                let _ = fs::remove_dir_all(template_dir(&state, &template.id));
                journal.delete_template(&template.id)?;
            }
        }
        gc_templates(&journal, &state)?;
        let quarantined = quarantine.exists();
        Ok(Arc::new_cyclic(|this| Self {
            installation,
            quarantine,
            journal: Mutex::new(journal),
            accepting: AtomicBool::new(!quarantined),
            faulted: AtomicBool::new(false),
            max_active_vms: AtomicU64::new(1),
            min_free_disk_gib: AtomicU64::new(MIN_FREE_DISK_GIB),
            ops: tokio::sync::Mutex::new(()),
            live: Mutex::new(HashMap::new()),
            pumps: Arc::new(Pumps::default()),
            spawner: Spawner::new(),
            this: this.clone(),
            started_at: now_ms(),
            qemu_version: OnceLock::new(),
            state,
        }))
    }

    /// Run before serving: the accelerator and QEMU must be usable now.
    pub fn preflight(&self) -> Result<()> {
        vm::check_accelerator(&self.installation.platform)?;
        let (major, minor, micro) = vm::check_qemu(&self.installation.qemu)?;
        let _ = self.qemu_version.set(format!("{major}.{minor}.{micro}"));
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
            template: row.template.clone(),
        }
    }

    fn template_record(&self, journal: &Journal, row: &TemplateRow) -> Result<TemplateRecord> {
        Ok(TemplateRecord {
            id: row.id.clone(),
            key: row.key.clone(),
            meta: row.meta.clone(),
            state: row.state,
            disk_gib: row.disk_gib,
            bytes: file_bytes(&template_dir(&self.state, &row.id).join("disk.qcow2")),
            created_at: row.created_at,
            users: journal.template_users(&row.id)?,
        })
    }

    pub fn templates(&self) -> Result<Vec<TemplateRecord>> {
        let journal = self.journal.lock().unwrap();
        journal
            .templates()?
            .iter()
            .map(|row| self.template_record(&journal, row))
            .collect()
    }

    /// Turns a VM's disk into a template and releases the VM. Only a VM
    /// that booted from the base image and stopped cleanly qualifies: cubed
    /// prepared it, sealed it and the guest powered itself off. The disk is
    /// moved, not copied, and becomes read-only; VMs allocated from the
    /// template get their own overlay on top of it. Idempotent by content.
    pub async fn publish(
        &self,
        thread_id: &str,
        vm_id: &str,
        epoch: u64,
        key: &str,
        meta: &str,
    ) -> Result<TemplateRecord> {
        Self::check_ids(thread_id, vm_id)?;
        if !(key.len() == 64 && key.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')))
            || meta.len() > MAX_TEMPLATE_META
            || !serde_json::from_str::<serde_json::Value>(meta).is_ok_and(|v| v.is_object())
        {
            return reject("INVALID_REQUEST");
        }
        let _ops = self.ops.lock().await;
        self.journal.lock().unwrap().fence(thread_id, epoch)?;
        let row = self.row_for(thread_id, vm_id)?;
        let journal = self.journal.lock().unwrap();
        match journal.template(vm_id)? {
            Some(existing) if existing.key != key || existing.meta != meta => {
                return detail("CONFLICT", "the vm was published with a different key");
            }
            Some(existing) if existing.state != TemplateState::Publishing => {
                return self.template_record(&journal, &existing);
            }
            Some(_) => {} // interrupted half way: finish it
            None => {
                if row.state != VmState::Stopped
                    || row.interrupted
                    || row.config.is_none()
                    || row.template.is_some()
                {
                    return detail(
                        "CONFLICT",
                        format!(
                            "only a vm started from the base image and stopped cleanly can become a template (it is {}{})",
                            row.state.as_str(),
                            if row.interrupted { ", interrupted" } else { "" }
                        ),
                    );
                }
                journal.insert_publishing(&TemplateRow {
                    id: vm_id.into(),
                    key: key.into(),
                    meta: meta.into(),
                    state: TemplateState::Publishing,
                    disk_gib: row.disk_gib,
                    created_at: now_ms(),
                })?;
            }
        }
        let paths = self.paths(row.slot);
        journal::private_dir(&self.state.join("templates"))?;
        let dir = template_dir(&self.state, vm_id);
        journal::private_dir(&dir)?;
        let target = dir.join("disk.qcow2");
        if paths.disk.is_file() {
            // Same filesystem: the overlay's relative backing path
            // (`../../images/<sha>.qcow2`) still resolves from here.
            fs::rename(&paths.disk, &target)?;
        }
        ensure!(target.is_file(), "the template disk is missing");
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&target, fs::Permissions::from_mode(0o400))?;
        }
        File::open(&dir)?.sync_all()?;
        File::open(self.state.join("templates"))?.sync_all()?;
        journal.finish_publish(vm_id)?;
        let _ = fs::remove_dir_all(&paths.dir);
        let published = journal.template(vm_id)?.context("template vanished")?;
        self.template_record(&journal, &published)
    }

    /// No new VM may use the template; its disk is deleted at once when no
    /// VM depends on it, otherwise when the last one is released or
    /// discarded. Retained VMs keep it alive. A removed template is NOT_FOUND.
    pub async fn remove_template(&self, id: &str) -> Result<TemplateRecord> {
        if !valid_vm_id(id) {
            return reject("INVALID_REQUEST");
        }
        let _ops = self.ops.lock().await;
        let journal = self.journal.lock().unwrap();
        let Some(row) = journal.template(id)? else {
            return detail("NOT_FOUND", "no such template on this runner");
        };
        if row.state == TemplateState::Publishing {
            return detail("CONFLICT", "the template is still being published");
        }
        journal.set_template_state(id, TemplateState::Removing)?;
        let record = self.template_record(
            &journal,
            &journal.template(id)?.context("template vanished")?,
        )?;
        gc_templates(&journal, &self.state)?;
        Ok(record)
    }

    fn gc_templates(&self) {
        let journal = self.journal.lock().unwrap();
        if gc_templates(&journal, &self.state).is_err() {
            self.faulted.store(true, Ordering::SeqCst);
            self.accepting.store(false, Ordering::SeqCst);
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
            max_active_vms: self.max_active_vms(),
            retained_vms: retained.len() as u64,
            retained_bytes: retained
                .iter()
                .map(|row| dir_bytes(&self.paths(row.slot).dir))
                .sum(),
        })
    }

    /// The operator's bound on active VMs, from `--max-active-vms`. A lower
    /// bound than the VMs already active only refuses new allocations.
    pub fn set_max_active_vms(&self, max: u64) -> Result<()> {
        ensure!(
            (1..=MAX_ACTIVE_VMS_LIMIT).contains(&max),
            "--max-active-vms must be 1 through {MAX_ACTIVE_VMS_LIMIT}"
        );
        self.max_active_vms.store(max, Ordering::SeqCst);
        Ok(())
    }

    /// Free space on the state filesystem below which `vm.allocate` refuses
    /// a new VM (`CUBE_RUNNER_MIN_FREE_DISK_GIB`); 0 turns the check off.
    pub fn set_min_free_disk_gib(&self, gib: u64) {
        self.min_free_disk_gib.store(gib, Ordering::SeqCst);
    }

    pub fn max_active_vms(&self) -> u64 {
        self.max_active_vms.load(Ordering::SeqCst)
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
        // Cleaned as `vm.diagnose` cleans its logs: the console carries
        // whatever the guest prints, its host key included if it prints it.
        let console = tail(&self.paths(row.slot).console, CONSOLE_TAIL)
            .map(|bytes| diagnose::clean(&bytes, 4 * CONSOLE_TAIL as usize + 64).0);
        Ok((self.record(&row), console))
    }

    /// One event in the VM's own event log (see `diagnose`).
    fn event(&self, slot: u32, event: &str, detail: Option<&str>) {
        record_event(&self.paths(slot).dir, event, detail);
    }

    /// Keeps the command line QEMU was started with, for `vm.diagnose`.
    fn record_launch(&self, slot: u32, pid: u32, argv: &[String], epoch: u64) {
        let launch = json!({
            "at": now_ms(),
            "pid": pid,
            "epoch": epoch,
            "runnerVersion": crate::SOFTWARE_VERSION,
            "qemu": self.installation.qemu.to_string_lossy(),
            "argv": argv,
        });
        if let Ok(bytes) = serde_json::to_vec(&launch) {
            use std::{io::Write, os::unix::fs::OpenOptionsExt};
            let _ = fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .mode(0o600)
                .open(self.paths(slot).dir.join("launch.json"))
                .and_then(|mut file| file.write_all(&bytes));
        }
        self.event(
            slot,
            "qemu started",
            Some(&format!("pid {pid}, epoch {epoch}")),
        );
    }

    /// A path as a diagnosis shows it: the state directory as `$STATE` and
    /// the runner account's home as `~`.
    fn shown(&self, text: &str) -> String {
        let mut text = text.replace(&*self.state.to_string_lossy(), "$STATE");
        if let Some(home) = std::env::var_os("HOME").filter(|home| home.len() > 1) {
            text = text.replace(&*home.to_string_lossy(), "~");
        }
        text
    }

    /// `vm.diagnose`: read-only evidence about one of the thread's VMs, as
    /// the runner recorded it and observes it now. It takes no `ops` lock,
    /// so it neither waits for nor holds up a mutation; its QMP questions
    /// are bounded by [`DIAGNOSE_QMP_BUDGET`]. Every string is cleaned
    /// (`diagnose::clean_value`) before it leaves the runner.
    pub fn diagnose(&self, thread_id: &str, vm_id: &str) -> Result<Value> {
        Self::check_ids(thread_id, vm_id)?;
        let row = self.row_for(thread_id, vm_id)?;
        let paths = self.paths(row.slot);
        let live = self
            .live
            .lock()
            .unwrap()
            .get(vm_id)
            .map(|live| (live.pid, *live.exited.borrow(), live.qmp.clone()));
        let pid = live.as_ref().map(|(pid, exited, _)| (*pid, *exited));
        let installation = &self.installation;
        let firmware = installation
            .firmware
            .as_ref()
            .map(|path| self.shown(&path.to_string_lossy()));
        let runner = json!({
            "softwareVersion": crate::SOFTWARE_VERSION,
            "platform": installation.platform,
            "processStartedAt": self.started_at,
            "lifecycle": self.status().map(|status| status.lifecycle).ok(),
            "qemu": self.shown(&installation.qemu.to_string_lossy()),
            "qemuVersion": self.qemu_version.get(),
            "firmware": firmware,
            "baseImageSha256": installation.image.sha256,
            "baseImageVirtualSize": installation.image.virtual_size,
        });
        let mut diagnosis = json!({
            "collectedAt": now_ms(),
            "runner": runner,
            "vm": self.record(&row),
            "slot": row.slot,
            "config": row.config,
            "launch": self.launch_facts(&row, &paths),
            "disk": self.disk_facts(&row, &paths),
            "process": live_facts(pid, row.state),
            "qmp": qmp_facts(live, row.state, &paths.qmp),
            "frames": self.pumps.observe(vm_id),
            "logs": {
                "console": diagnose::log_excerpt(&paths.console, DIAGNOSE_CONSOLE),
                "previousConsole": diagnose::log_excerpt(&paths.dir.join("console.prev.log"), DIAGNOSE_PREVIOUS_CONSOLE),
                "qemu": diagnose::log_excerpt(&paths.qemu_log, DIAGNOSE_QEMU_LOG),
            },
            "events": diagnose::read_events(&paths.dir),
        });
        diagnosis = diagnose::clean_value(diagnosis, crate::MAX_FRAME_BYTES / 2);
        // The budgets above keep a diagnosis far below one frame; if they
        // ever do not, the logs go rather than the whole answer.
        if serde_json::to_vec(&diagnosis)?.len() > crate::MAX_FRAME_BYTES - 4096 {
            for log in ["console", "previousConsole", "qemu"] {
                diagnosis["logs"][log]["text"] = "[dropped: the diagnosis was too large]".into();
            }
        }
        Ok(diagnosis)
    }

    fn launch_facts(&self, row: &VmRow, paths: &VmPaths) -> Value {
        if let Ok(bytes) = fs::read(paths.dir.join("launch.json"))
            && let Ok(mut launch) = serde_json::from_slice::<Value>(&bytes)
            && launch.is_object()
        {
            launch["source"] = "recorded".into();
            if let Some(argv) = launch["argv"].as_array_mut() {
                for arg in argv {
                    *arg = self.shown(arg.as_str().unwrap_or_default()).into();
                }
            }
            launch["qemu"] = self
                .shown(launch["qemu"].as_str().unwrap_or_default())
                .into();
            return launch;
        }
        let Some(config) = &row.config else {
            return json!({ "source": "none", "note": "the vm was never started" });
        };
        let argv = vm::qemu_args(&vm::Launch {
            platform: &self.installation.platform,
            firmware: self.installation.firmware.as_deref(),
            vm_id: &row.vm_id,
            vcpus: config.vcpus,
            memory_mib: config.memory_mib,
            mac: &config.mac,
            paths,
            net_fd: 3,
        });
        json!({
            "source": "reconstructed",
            "note": "the runner that last started this vm did not record its command line; \
                this is the one this runner would use, with an assumed net fd",
            "qemu": self.shown(&self.installation.qemu.to_string_lossy()),
            "argv": argv.map(|args| args
                .iter()
                .map(|arg| self.shown(&arg.to_string_lossy()))
                .collect::<Vec<_>>())
                .map_err(|error| format!("{error:#}"))
                .unwrap_or_else(|error| vec![error]),
        })
    }

    fn disk_facts(&self, row: &VmRow, paths: &VmPaths) -> Value {
        let expected = backing_path(&self.installation.image.sha256, row.template.as_deref());
        let overlay = match diagnose::qcow2_header(&paths.disk) {
            Ok((virtual_size, backing)) => json!({
                "present": true,
                "allocatedBytes": file_bytes(&paths.disk),
                "virtualSize": virtual_size,
                "backing": backing,
                "expectedBacking": expected,
                "backingMatches": backing.as_deref() == Some(expected.as_str()),
                "backingPresent": backing.as_ref().map(|b| paths.dir.join(b).is_file()),
            }),
            Err(error) => json!({
                "present": paths.disk.exists(),
                "error": format!("{error:#}"),
                "expectedBacking": expected,
            }),
        };
        let template = row.template.as_ref().map(|id| {
            let state = self.journal.lock().unwrap().template(id).ok().flatten();
            json!({ "id": id, "state": state.map(|t| t.state) })
        });
        json!({
            "overlay": overlay,
            "template": template,
            "diskGiB": row.disk_gib,
            "seed": { "present": paths.seed.is_file(), "bytes": file_bytes(&paths.seed) },
        })
    }

    pub async fn allocate(
        &self,
        thread_id: &str,
        vm_id: &str,
        epoch: u64,
        disk_gib: u32,
        template: Option<&str>,
    ) -> Result<VmRecord> {
        Self::check_ids(thread_id, vm_id)?;
        let limits = &self.installation.limits;
        if template.is_some_and(|id| !valid_vm_id(id) || id == vm_id) {
            return reject("INVALID_REQUEST");
        }
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
                if row.thread_id != thread_id
                    || row.disk_gib != disk_gib
                    || row.template.as_deref() != template
                {
                    return detail(
                        "CONFLICT",
                        "vm exists with a different thread, disk size or template",
                    );
                }
                return Ok(self.record(&row));
            }
            if let Some(id) = template {
                match journal.template(id)? {
                    Some(row) if row.state == TemplateState::Ready => {
                        if disk_gib < row.disk_gib {
                            return detail(
                                "INVALID_REQUEST",
                                format!("diskGiB must cover the template ({} GiB)", row.disk_gib),
                            );
                        }
                    }
                    _ => {
                        return detail("NOT_FOUND", "the template is not available on this runner");
                    }
                }
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
            // Checked and inserted under `ops` and the journal lock: two
            // allocations can never both take the last slot.
            if rows.iter().filter(|row| row.state.active()).count() as u64 >= self.max_active_vms()
            {
                return reject("CAPACITY_EXCEEDED");
            }
            let floor = self.min_free_disk_gib.load(Ordering::SeqCst);
            if free_disk_bytes(&self.state).is_some_and(|free| free < floor.saturating_mul(GIB)) {
                return detail(
                    "CAPACITY_EXCEEDED",
                    format!("the runner's disk has less than {floor} GiB free"),
                );
            }
            journal.insert_allocating(vm_id, thread_id, disk_gib, template)?
        };
        let paths = self.paths(slot);
        // Relative backing paths: a restored state directory may live elsewhere.
        let backing = backing_path(&self.installation.image.sha256, template);
        let created = self.create_disk(&paths, disk_gib, &backing).await;
        let journal = self.journal.lock().unwrap();
        match created {
            Ok(()) => {
                journal.set_state(vm_id, VmState::Allocated, None)?;
                let row = journal.get(vm_id)?.context("vm record vanished")?;
                drop(journal);
                self.event(
                    slot,
                    "allocated",
                    Some(&format!("{disk_gib} GiB on {backing}")),
                );
                Ok(self.record(&row))
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

    async fn create_disk(&self, paths: &VmPaths, disk_gib: u32, backing: &str) -> Result<()> {
        paths.check_socket_lengths()?;
        journal::private_dir(&paths.dir)?;
        let output = tokio::process::Command::new(&self.installation.qemu_img)
            .args(["create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", backing])
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
        let ops = self.ops.lock().await;
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
                let pump = self.pumps.authorize(vm_id, grant);
                self.event(
                    row.slot,
                    "start while live",
                    Some(&format!(
                        "the vm is {}; {}",
                        row.state.as_str(),
                        if pump {
                            "its gateway grant was renewed"
                        } else {
                            "it has no frame pump in this process"
                        }
                    )),
                );
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
            self.event(row.slot, "start refused", Some("the runner is draining"));
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
        // The last launch's record goes with its console: a start that fails
        // to spawn must not leave it to read as this start's.
        let _ = fs::remove_file(paths.dir.join("launch.json"));
        let _ = fs::remove_file(&paths.qmp);
        // Sockets of runners before the socket pair.
        let _ = fs::remove_file(&paths.net);
        let _ = fs::remove_file(&paths.qemu_net);
        let net_fd = self
            .pumps
            .open(vm_id, thread_id, grant, paths.dir.clone())?;
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
        let argv: Vec<String> = args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        let spawned = vm::qemu_command(&self.installation.qemu, args, &paths.qemu_log)
            .and_then(|command| self.spawner.spawn(command));
        // QEMU holds its own copy now (or failed to start).
        drop(net_fd);
        let child = match spawned {
            Ok(child) => child,
            Err(error) => {
                self.pumps.close(vm_id);
                let message = format!("starting qemu failed: {error:#}");
                self.journal
                    .lock()
                    .unwrap()
                    .set_state(vm_id, row.state, Some(&message))?;
                self.event(row.slot, "qemu did not start", Some(&message));
                return self.current(vm_id);
            }
        };
        let pid = child.id();
        self.record_launch(row.slot, pid, &argv, epoch);
        let exited = self.watch(vm_id, child, paths.qemu_log.clone());
        // The VM is `starting` and watched: other VMs' mutations need not
        // wait for its QMP (mark_running only moves `starting` on).
        drop(ops);
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
                    runner.event(
                        row.slot,
                        "qmp did not answer",
                        Some(&format!(
                            "no answer within {} s; qemu pid {pid} is killed if it still runs",
                            QMP_READY.as_secs()
                        )),
                    );
                    // Only this start's QEMU: by the time QMP gave up, it may
                    // have exited and a later start may run under the same id.
                    runner.kill_pid(&vm_id, pid);
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
                qmp: Arc::default(),
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
                            tail(&log, 512)
                                .map(|bytes| diagnose::clean(&bytes, 4 * 512 + 64).0)
                                .unwrap_or_default()
                                .trim()
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
        let error = match current.as_ref().map(|row| row.state) {
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
        drop(journal);
        if let Some(row) = &current {
            let after = error.map(|e| format!("; {e}")).unwrap_or_default();
            self.event(
                row.slot,
                "qemu exited",
                Some(&format!("the vm was {}{after}", row.state.as_str())),
            );
        }
    }

    /// `starting` -> `running` once QMP answered with the VM's name. A boot
    /// that got this far clears an earlier `interrupted`.
    fn mark_running(&self, vm_id: &str) -> Result<()> {
        let journal = self.journal.lock().unwrap();
        if journal.transition(vm_id, &[VmState::Starting], VmState::Running, None)? {
            journal.set_interrupted(vm_id, false)?;
            let slot = journal.get(vm_id)?.map(|row| row.slot);
            drop(journal);
            if let Some(slot) = slot {
                self.event(slot, "running", Some("qemu answered qmp"));
            }
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
        let pid = self.live.lock().unwrap().get(vm_id).map(|live| live.pid);
        if let Some(pid) = pid {
            self.kill_pid(vm_id, pid);
        }
    }

    /// SIGKILL `vm_id`'s QEMU only if it is still the process `pid`.
    fn kill_pid(&self, vm_id: &str, pid: u32) {
        if let Some(live) = self.live.lock().unwrap().get(vm_id)
            && live.pid == pid
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
        let Some((mut exited, lock)) = self
            .live
            .lock()
            .unwrap()
            .get(vm_id)
            .map(|live| (live.exited.clone(), live.qmp.clone()))
        else {
            return;
        };
        let qmp = self.paths(slot).qmp;
        let command = |command: &'static str| {
            let (qmp, lock) = (qmp.clone(), lock.clone());
            tokio::task::spawn_blocking(move || {
                // A diagnosis never holds QMP while the runner needs it.
                // A poisoned lock still serializes: a stop must go on.
                let _qmp = lock
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let mut connection = Qmp::connect(&qmp, Duration::from_secs(2))?;
                connection.execute(command)?;
                Ok::<_, anyhow::Error>(())
            })
        };
        if graceful {
            self.event(slot, "power-down", Some("acpi power-down sent"));
            let _ = command("system_powerdown").await;
            if tokio::time::timeout(STOP_GRACE, exited.wait_for(|e| *e))
                .await
                .is_ok()
            {
                return;
            }
        }
        let _ = self.journal.lock().unwrap().set_interrupted(vm_id, true);
        self.event(
            slot,
            "quit",
            Some(if graceful {
                "the guest did not power off in time; qemu told to quit"
            } else {
                "qemu told to quit at once"
            }),
        );
        let _ = command("quit").await;
        if tokio::time::timeout(QUIT_GRACE, exited.wait_for(|e| *e))
            .await
            .is_ok()
        {
            return;
        }
        self.event(slot, "killed", Some("qemu did not quit; SIGKILL"));
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
            self.event(row.slot, "stop requested", None);
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
        self.event(
            row.slot,
            "release requested",
            Some(if retain {
                "keep the disk"
            } else {
                "delete the disk"
            }),
        );
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

    /// Deletes a retained (or failed) VM's directory: the operator decided
    /// the evidence is no longer needed. A released VM is already gone.
    pub fn discard(&self, thread_id: &str, vm_id: &str, epoch: u64) -> Result<VmRecord> {
        Self::check_ids(thread_id, vm_id)?;
        self.journal.lock().unwrap().fence(thread_id, epoch)?;
        let row = self.row_for(thread_id, vm_id)?;
        match row.state {
            VmState::Released => return Ok(self.record(&row)),
            VmState::Retained | VmState::Failed => {}
            state => {
                return detail(
                    "CONFLICT",
                    format!(
                        "vm is {}; only a retained vm can be discarded",
                        state.as_str()
                    ),
                );
            }
        }
        let dir = self.paths(row.slot).dir;
        let journal = self.journal.lock().unwrap();
        match fs::remove_dir_all(&dir) {
            Ok(()) => journal.set_state(vm_id, VmState::Released, None)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                journal.set_state(vm_id, VmState::Released, None)?
            }
            Err(error) => return Err(error).context("deleting the retained vm directory"),
        }
        drop(journal);
        self.gc_templates();
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
        let retained = row.retain || row.interrupted;
        let result = if retained {
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
        drop(journal);
        if retained {
            self.event(slot, "retained", None);
        }
        self.gc_templates();
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
            self.event(
                slot,
                "runner stopping",
                Some(if graceful {
                    "the runner shuts down; the guest is powered down"
                } else {
                    "the runner shuts down at once"
                }),
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

/// A VM overlay's backing file, relative to its directory.
fn backing_path(image_sha256: &str, template: Option<&str>) -> String {
    match template {
        Some(id) => format!("../../templates/{id}/disk.qcow2"),
        None => format!("../../images/{image_sha256}.qcow2"),
    }
}

/// The VM's QEMU as this process knows it.
fn live_facts(live: Option<(u32, bool)>, state: VmState) -> Value {
    match live {
        Some((pid, exited)) => {
            let usage = (!exited).then(|| diagnose::process_usage(pid)).flatten();
            json!({
                "tracked": true,
                "pid": pid,
                "exited": exited,
                "exists": !exited && diagnose::process_exists(pid),
                "cpuMs": usage.map(|(cpu, _)| cpu),
                "residentBytes": usage.map(|(_, resident)| resident),
            })
        }
        None => json!({
            "tracked": false,
            "note": if state.live() {
                format!("the journal says {} but this runner process has no qemu for it", state.as_str())
            } else {
                format!("no qemu runs for a {} vm", state.as_str())
            },
        }),
    }
}

/// QMP's view of a live VM: its name, run state and vCPUs. A QEMU that
/// does not answer within the budget is reported as such.
fn qmp_facts(live: Option<(u32, bool, Arc<Mutex<()>>)>, state: VmState, path: &Path) -> Value {
    // While `starting` the runner itself polls QMP; its answer is `running`.
    let Some((_, false, lock)) = live else {
        return json!({ "asked": false });
    };
    if state != VmState::Running {
        return json!({ "asked": false });
    }
    let _qmp = match lock.try_lock() {
        Ok(guard) => guard,
        Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => {
            return json!({ "asked": false, "note": "the runner is using qmp now" });
        }
    };
    let started = Instant::now();
    let mut answers = serde_json::Map::new();
    let mut qmp = match Qmp::connect(path, DIAGNOSE_QMP_WAIT) {
        Ok(qmp) => qmp,
        Err(error) => {
            return json!({ "asked": true, "answered": false, "error": format!("{error:#}") });
        }
    };
    for command in ["query-name", "query-status", "query-cpus-fast"] {
        if started.elapsed() > DIAGNOSE_QMP_BUDGET {
            answers.insert(command.into(), json!({ "error": "not asked: out of time" }));
            continue;
        }
        let answer = match qmp.execute(command) {
            Ok(value) => value,
            Err(error) => json!({ "error": format!("{error:#}") }),
        };
        answers.insert(command.into(), answer);
    }
    json!({ "asked": true, "answered": true, "ms": started.elapsed().as_millis() as u64, "answers": answers })
}

pub(crate) fn template_dir(state: &Path, id: &str) -> PathBuf {
    state.join("templates").join(id)
}

/// Deletes every removing template no VM depends on any more. A directory
/// that cannot be deleted keeps its row and is tried again next time.
fn gc_templates(journal: &Journal, state: &Path) -> Result<()> {
    for template in journal.templates()? {
        if template.state != TemplateState::Removing || journal.template_users(&template.id)? > 0 {
            continue;
        }
        match fs::remove_dir_all(template_dir(state, &template.id)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => continue,
        }
        journal.delete_template(&template.id)?;
    }
    Ok(())
}

/// Startup reconciliation for a VM a previous runner process left live. On
/// Linux PDEATHSIG has already killed QEMU and nothing answers; on macOS
/// QEMU may still run and is told to quit over its QMP socket.
fn quit_orphan(qmp: &Path, vm_id: &str) -> bool {
    let Ok(mut connection) = Qmp::connect(qmp, Duration::from_secs(2)) else {
        return false;
    };
    if connection.name().is_ok_and(|name| name == vm_id) && connection.execute("quit").is_ok() {
        connection.wait_closed(QUIT_GRACE);
        return true;
    }
    false
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

    #[test]
    fn auto_capacity_fits_every_vm_at_its_maximum() {
        let limits = VmLimits::default(); // 4 vCPUs, 8 GiB
        assert_eq!(capacity_for(8 * 1024, 64, &limits), 1, "never below one");
        assert_eq!(
            capacity_for(16 * 1024, 16, &limits),
            1,
            "14 GiB after the reserve"
        );
        assert_eq!(capacity_for(32 * 1024, 16, &limits), 3);
        assert_eq!(capacity_for(32 * 1024, 8, &limits), 2, "bounded by cores");
        assert_eq!(capacity_for(512 * 1024, 128, &limits), AUTO_MAX_ACTIVE_VMS);
        let small = VmLimits {
            max_vcpus: 2,
            max_memory_mib: 4096,
            max_disk_gib: 64,
        };
        assert_eq!(capacity_for(18 * 1024, 8, &small), 4);
        assert_eq!(capacity_for(0, 0, &small), 1, "unknown host");
    }
}
