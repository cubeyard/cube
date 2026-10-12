//! `berth vm`: a runner whose machines are keel guests under QEMU
//! (docs/plans/2026-10-10-vm-base-and-image-layers.md, package 8; masterplan
//! row B-1). Each machine is `DIRECTORY/<id>`:
//!
//! ```text
//! machine.json   the journal (record.rs); the pinned machine type
//! rw.qcow2       the writable disk (vdc), created once, never replaced
//! layers.vmdk    the layer disk (vdb, read-only) with layers.head/.tail
//! ctl.sock       cube.0, the guest channel (spoken from masterplan B-2 on)
//! qmp.sock       QMP; console.log, qemu.log, argv.json, events.log
//! ```
//!
//! The runner is given QEMU, qemu-img and the keel release by path and
//! refuses a QEMU below keel's floor. Each QEMU runs in a process group of
//! its own, so a Ctrl-C meant for the runner does not reach it: the runner
//! quits its machines itself and marks them interrupted, and a runner that
//! starts after a crash quits the QEMUs it finds over QMP and marks their
//! machines interrupted. A machine is never started again by the runner on
//! its own; cubed starts it.
//!
//! Not here yet: the guest channel (B-2: `status.guest`, `machine_setup`,
//! guest streams), the network (B-4: no network device at all), image layers
//! (B-7: the layer disk has no partitions), templates (B-8), diagnosis (B-9)
//! and snapshots (S-7a). `stop` quits QEMU: a clean power-off through the
//! agent comes with the channel.
mod qemu;
mod record;

use std::{
    collections::BTreeMap,
    io::Write as _,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use cube_runner_protocol::{
    MAX_FRAME_BYTES, PROTOCOL, Timestamp,
    proto::{self, Code, call::Verb, call_result, watch_event},
    refuse,
};
use iroh::endpoint::{RecvStream, SendStream};
use tokio::sync::{broadcast, watch};

pub use qemu::{Accel, Floor};
use qemu::{Arch, Keel, Qmp};
use record::{Boot, MachineRecord, Phase, Size};

use crate::{
    host::{getrandom, host_name, valid_id, valid_owner},
    serve::{self, Service, unimplemented},
};

const CAPABILITIES: [&str; 9] = [
    "runner.get",
    "machine.create",
    "machine.start",
    "machine.stop",
    "machine.delete",
    "machine.discard",
    "machine.get",
    "machine.list",
    "watch",
];
const DEFAULT_SIZE: Size = Size {
    vcpus: 2,
    memory_mib: 2048,
    disk_gib: 16,
};
const MAX_VCPUS: u32 = 16;
const MAX_MEMORY_MIB: u32 = 32768;
const MIN_MEMORY_MIB: u32 = 256;
const MAX_DISK_GIB: u32 = 512;
/// QEMU has this long to answer QMP after it starts.
const BOOT_TIMEOUT: Duration = Duration::from_secs(20);
/// After `quit`, QEMU has this long to exit before it is killed.
const QUIT_TIMEOUT: Duration = Duration::from_secs(20);
/// A Unix socket path must fit `sun_path` (104 bytes on macOS).
const MAX_SOCKET_PATH: usize = 100;

pub struct VmOptions {
    pub directory: PathBuf,
    pub node_id: String,
    pub network: String,
    pub max_machines: u32,
    pub labels: BTreeMap<String, String>,
    pub qemu: PathBuf,
    pub qemu_img: PathBuf,
    pub keel: PathBuf,
    pub accel: Accel,
}

/// A QEMU this runner started for a machine.
struct Live {
    pid: u32,
    exited: watch::Receiver<bool>,
}

struct Entry {
    record: MachineRecord,
    live: Option<Live>,
    version: i64,
    updated: Timestamp,
}

struct State {
    version: i64,
    machines: BTreeMap<String, Entry>,
    /// Deleted machines: their ids are never reused.
    deleted: BTreeMap<String, MachineRecord>,
}

pub struct VmRunner {
    options: VmOptions,
    arch: Arch,
    floor: Floor,
    keel: Keel,
    started_at: Timestamp,
    state: Mutex<State>,
    events: broadcast::Sender<proto::WatchEvent>,
    /// One mutation at a time (create, start, stop, delete, discard).
    ops: tokio::sync::Mutex<()>,
}

type Answer<T> = std::result::Result<T, proto::Error>;

fn internal(error: impl std::fmt::Display) -> proto::Error {
    refuse(Code::Internal, "io", &error.to_string())
}

fn random_hex() -> String {
    let mut bytes = [0u8; 16];
    getrandom(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Appends one line to the machine's `events.log` (evidence, never read
/// back by the runner).
fn event(dir: &Path, what: &str, detail: &str) {
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("events.log"))
    {
        let now = serde_json::to_string(&Timestamp::now()).unwrap_or_default();
        let _ = writeln!(file, "{now} {what}: {detail}");
    }
}

/// The last lines of a log, for an error people read.
fn tail(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text.trim().lines().rev().take(3).collect();
    lines.into_iter().rev().collect::<Vec<_>>().join("; ")
}

/// Reads the floor of the QEMU at `qemu` (on `-machine none`, its QMP
/// socket in a private temporary directory) and refuses one below it, before
/// the runner touches its directory.
pub async fn check_floor(qemu: &Path, accel: Accel) -> Result<Floor> {
    use std::os::unix::fs::DirBuilderExt;
    let arch = Arch::host()?;
    let sockets = std::env::temp_dir().join(format!(
        "berth-floor-{}-{}",
        std::process::id(),
        &random_hex()[..8]
    ));
    std::fs::DirBuilder::new().mode(0o700).create(&sockets)?;
    let answers = qemu::probe(qemu, &sockets.join("floor.qmp")).await;
    let _ = std::fs::remove_dir_all(&sockets);
    let floor = qemu::evaluate(&answers?, arch, accel);
    ensure!(
        floor.missing.is_empty(),
        "{} (QEMU {}) is below keel's QEMU floor; missing: {}",
        qemu.display(),
        floor.version,
        floor.missing.join(", ")
    );
    if accel == Accel::Kvm {
        std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/kvm")
            .context("--accel kvm needs read and write access to /dev/kvm (group kvm)")?;
    }
    Ok(floor)
}

impl VmRunner {
    /// Checks the keel release, then loads every machine under the
    /// directory, quitting QEMUs a previous runner left behind. `floor` is
    /// [`check_floor`]'s, for `options.qemu`.
    pub async fn open(options: VmOptions, floor: Floor) -> Result<Arc<Self>> {
        let arch = Arch::host()?;
        let control = options.directory.join(".berth");
        ensure!(
            options.directory.as_os_str().len() + 1 + 16 + 1 + qemu::QMP_SOCKET.len()
                <= MAX_SOCKET_PATH,
            "--dir {} is too long: a machine's sockets must fit {MAX_SOCKET_PATH} bytes",
            options.directory.display()
        );
        let keel = Keel::open(&options.keel)?;
        for dir in ["deleted", "trash"] {
            std::fs::create_dir_all(control.join(dir))?;
        }
        // A delete that crashed after its tombstone: finish it.
        let _ = std::fs::remove_dir_all(control.join("trash"));
        std::fs::create_dir_all(control.join("trash"))?;
        let mut deleted = BTreeMap::new();
        for entry in std::fs::read_dir(control.join("deleted"))? {
            let path = entry?.path();
            if path.extension().is_some_and(|e| e == "json") {
                let record = record::read(&path)?;
                deleted.insert(record.id.clone(), record);
            }
        }
        let mut machines = BTreeMap::new();
        for entry in std::fs::read_dir(&options.directory)? {
            let dir = entry?.path();
            let path = dir.join(record::RECORD);
            if !path.is_file() {
                continue;
            }
            let mut record = record::read(&path)?;
            ensure!(
                record.version == 1 && valid_id(&record.id) && dir.ends_with(&record.id),
                "{} is not a machine record of this runner",
                path.display()
            );
            if deleted.contains_key(&record.id) {
                let _ = std::fs::remove_dir_all(&dir);
                continue;
            }
            if record.phase.live() {
                let quit = quit_orphan(&dir.join(qemu::QMP_SOCKET)).await;
                record.after_restart(quit, Timestamp::now());
                record::write_json(&path, &record)?;
                event(
                    &dir,
                    "runner restarted",
                    &record.interrupted.as_ref().unwrap().message,
                );
            }
            machines.insert(
                record.id.clone(),
                Entry {
                    record,
                    live: None,
                    version: 1,
                    updated: Timestamp::now(),
                },
            );
        }
        let (events, _) = broadcast::channel(256);
        Ok(Arc::new(Self {
            options,
            arch,
            floor,
            keel,
            started_at: Timestamp::now(),
            state: Mutex::new(State {
                version: 1,
                machines,
                deleted,
            }),
            events,
            ops: tokio::sync::Mutex::new(()),
        }))
    }

    fn qemu_version(&self) -> String {
        format!("{} {}", self.floor.version, self.options.qemu.display())
    }

    /// What the runner says when it starts.
    pub fn describe(&self) -> Vec<String> {
        let state = self.state.lock().unwrap();
        let interrupted = state
            .machines
            .values()
            .filter(|entry| entry.record.interrupted.is_some())
            .count();
        vec![
            format!(
                "qemu: {} (meets keel's floor; new machines get {})",
                self.qemu_version(),
                self.floor.newest_machine_type().unwrap_or_default()
            ),
            format!(
                "accelerator: {}, guest {}",
                self.options.accel.name(),
                self.arch.name()
            ),
            format!(
                "keel: {} (vmlinuz {}, base.erofs {})",
                self.options.keel.display(),
                self.keel.kernel_sha256,
                self.keel.base_sha256
            ),
            format!(
                "machines: {} ({interrupted} interrupted; at most {} at once)",
                state.machines.len(),
                self.options.max_machines
            ),
        ]
    }

    fn machine_dir(&self, id: &str) -> PathBuf {
        self.options.directory.join(id)
    }

    fn runner(&self, state: &State) -> proto::Runner {
        let active = state
            .machines
            .values()
            .filter(|entry| entry.record.phase != Phase::Retained)
            .count() as u32;
        let running = state
            .machines
            .values()
            .filter(|entry| entry.live.is_some())
            .count() as u32;
        let retained = state.machines.len() as u32 - active;
        let host_cpus = std::thread::available_parallelism().map_or(0, |n| n.get() as u32);
        proto::Runner {
            node_id: self.options.node_id.clone(),
            software_version: crate::SOFTWARE_VERSION.into(),
            kind: proto::runner::Kind::Vm as i32,
            platform: Some(proto::Platform {
                os: std::env::consts::OS.into(),
                arch: self.arch.name().into(),
                accelerator: self.options.accel.name().into(),
                qemu_version: self.qemu_version(),
                base_image_sha256: self.keel.base_sha256.clone(),
                base_image_name: "keel".into(),
                host_name: host_name(),
            }),
            limits: Some(proto::Limits {
                max_vcpus: MAX_VCPUS.min(host_cpus.max(1)),
                max_memory_mib: MAX_MEMORY_MIB,
                max_disk_gib: MAX_DISK_GIB,
                max_machines: self.options.max_machines,
                max_frame_bytes: MAX_FRAME_BYTES as u32,
                ..Default::default()
            }),
            capacity: Some(proto::Capacity {
                machines_active: active,
                machines_running: running,
                slots_free: self.options.max_machines.saturating_sub(active),
                host_cpus,
                retained,
                ..Default::default()
            }),
            lifecycle: proto::runner::Lifecycle::Ready as i32,
            network: Some(proto::Network {
                mode: self.options.network.clone(),
                ..Default::default()
            }),
            templates: vec![],
            labels: self.options.labels.clone(),
            ca_pem: String::new(),
            meta: Some(proto::Meta {
                version: state.version,
                updated: Some(Timestamp::now()),
            }),
            started_at: Some(self.started_at),
        }
    }

    fn machine(record: &MachineRecord, version: i64, updated: Timestamp) -> proto::Machine {
        let boot = record.boot.as_ref().filter(|_| record.phase.live());
        let conditions = record
            .interrupted
            .iter()
            .map(|interrupted| proto::Condition {
                r#type: "Interrupted".into(),
                status: true,
                reason: interrupted.reason.clone(),
                message: interrupted.message.clone(),
                since: Some(interrupted.since),
            })
            .collect();
        proto::Machine {
            r#ref: Some(proto::Ref {
                owner: record.owner.clone(),
                id: record.id.clone(),
            }),
            spec: Some(proto::MachineSpec {
                source: Some(proto::machine_spec::Source::Base(true)),
                size: Some(proto::Size {
                    vcpus: record.size.vcpus,
                    memory_mib: record.size.memory_mib,
                    disk_gib: record.size.disk_gib,
                }),
                boot: None,
            }),
            status: Some(proto::MachineStatus {
                phase: record.phase.proto() as i32,
                conditions,
                boot_id: boot.map(|b| b.boot_id.clone()).unwrap_or_default(),
                disk_bytes: 0,
                error: record.error.clone(),
                started_at: boot.map(|b| b.started_at),
                guest: None,
            }),
            meta: Some(proto::Meta {
                version,
                updated: Some(updated),
            }),
            fence_epoch: record.fence_epoch,
        }
    }

    fn current(&self, state: &State, id: &str) -> proto::Machine {
        match state.machines.get(id) {
            Some(entry) => Self::machine(&entry.record, entry.version, entry.updated),
            None => Self::machine(&state.deleted[id], state.version, Timestamp::now()),
        }
    }

    /// Saves `id`'s record, then tells every watch.
    fn commit(&self, state: &mut State, id: &str) -> Answer<proto::Machine> {
        let entry = state.machines.get_mut(id).unwrap();
        record::write_json(&self.machine_dir(id).join(record::RECORD), &entry.record)
            .map_err(internal)?;
        state.version += 1;
        let version = state.version;
        let entry = state.machines.get_mut(id).unwrap();
        entry.version = version;
        entry.updated = Timestamp::now();
        let machine = Self::machine(&entry.record, version, entry.updated);
        self.tell(watch_event::Type::Put, machine.clone(), state);
        Ok(machine)
    }

    fn tell(&self, r#type: watch_event::Type, machine: proto::Machine, state: &State) {
        let _ = self.events.send(proto::WatchEvent {
            r#type: r#type as i32,
            version: state.version,
            resource: Some(watch_event::Resource::Machine(machine)),
        });
        let _ = self.events.send(proto::WatchEvent {
            r#type: watch_event::Type::Put as i32,
            version: state.version,
            resource: Some(watch_event::Resource::Runner(self.runner(state))),
        });
    }

    /// Checks `reference` and `fence` and raises the machine's epoch.
    fn fenced<'a>(
        state: &'a mut State,
        reference: Option<&proto::Ref>,
        fence: Option<&proto::Fence>,
    ) -> Answer<&'a mut Entry> {
        let reference = reference.ok_or_else(|| {
            refuse(
                Code::InvalidArgument,
                "ref",
                "a machine reference is required",
            )
        })?;
        let epoch = fence.map_or(0, |fence| fence.epoch);
        if epoch < 1 {
            return Err(refuse(
                Code::InvalidArgument,
                "fence",
                "a fence epoch of at least 1 is required",
            ));
        }
        if let Some(gone) = state.deleted.get(&reference.id)
            && gone.owner == reference.owner
        {
            return Err(refuse(
                Code::FailedPrecondition,
                "deleted",
                "the machine was deleted",
            ));
        }
        let entry = state
            .machines
            .get_mut(&reference.id)
            .filter(|entry| entry.record.owner == reference.owner)
            .ok_or_else(|| refuse(Code::NotFound, "machine", "no such machine"))?;
        if epoch < entry.record.fence_epoch {
            return Err(refuse(
                Code::FailedPrecondition,
                "stale_epoch",
                "a newer epoch has been used for this machine",
            ));
        }
        entry.record.fence_epoch = epoch;
        Ok(entry)
    }

    fn size(requested: Option<&proto::Size>) -> Answer<Size> {
        let size = Size {
            vcpus: requested
                .map(|s| s.vcpus)
                .filter(|v| *v > 0)
                .unwrap_or(DEFAULT_SIZE.vcpus),
            memory_mib: requested
                .map(|s| s.memory_mib)
                .filter(|v| *v > 0)
                .unwrap_or(DEFAULT_SIZE.memory_mib),
            disk_gib: requested
                .map(|s| s.disk_gib)
                .filter(|v| *v > 0)
                .unwrap_or(DEFAULT_SIZE.disk_gib),
        };
        if size.vcpus > MAX_VCPUS
            || !(MIN_MEMORY_MIB..=MAX_MEMORY_MIB).contains(&size.memory_mib)
            || size.disk_gib > MAX_DISK_GIB
        {
            return Err(refuse(
                Code::InvalidArgument,
                "size",
                &format!(
                    "at most {MAX_VCPUS} vCPUs, {MIN_MEMORY_MIB} to {MAX_MEMORY_MIB} MiB of memory and {MAX_DISK_GIB} GiB of disk"
                ),
            ));
        }
        Ok(size)
    }

    async fn create(self: &Arc<Self>, request: proto::MachineCreate) -> Answer<proto::Machine> {
        let reference = request.r#ref.clone().unwrap_or_default();
        if !valid_owner(&reference.owner) || !valid_id(&reference.id) {
            return Err(refuse(
                Code::InvalidArgument,
                "ref",
                "owner is 1-128 of [A-Za-z0-9_-], id is 16 hex characters",
            ));
        }
        let spec = request.spec.clone().unwrap_or_default();
        if let Some(proto::machine_spec::Source::TemplateId(_)) = spec.source {
            return Err(unimplemented::<Self>("templates yet (masterplan B-8)"));
        }
        let size = Self::size(spec.size.as_ref())?;
        {
            let mut state = self.state.lock().unwrap();
            let taken = state
                .deleted
                .get(&reference.id)
                .map(|r| r.owner.clone())
                .or_else(|| {
                    state
                        .machines
                        .get(&reference.id)
                        .map(|e| e.record.owner.clone())
                });
            match taken {
                Some(owner) if owner != reference.owner => {
                    return Err(refuse(
                        Code::AlreadyExists,
                        "id",
                        "this machine id belongs to another owner",
                    ));
                }
                Some(_) => {
                    let entry = Self::fenced(&mut state, Some(&reference), request.fence.as_ref())?;
                    let id = entry.record.id.clone();
                    let record = entry.record.clone();
                    record::write_json(&self.machine_dir(&id).join(record::RECORD), &record)
                        .map_err(internal)?;
                    return Ok(self.current(&state, &id));
                }
                None => {}
            }
            let active = state
                .machines
                .values()
                .filter(|entry| entry.record.phase != Phase::Retained)
                .count() as u32;
            if active >= self.options.max_machines {
                return Err(refuse(
                    Code::ResourceExhausted,
                    "capacity",
                    "the runner hosts as many machines as it may",
                ));
            }
        }
        let epoch = request.fence.as_ref().map_or(0, |fence| fence.epoch);
        if epoch < 1 {
            return Err(refuse(
                Code::InvalidArgument,
                "fence",
                "a fence epoch of at least 1 is required",
            ));
        }
        let dir = self.machine_dir(&reference.id);
        std::fs::create_dir_all(&dir).map_err(internal)?;
        let disk = dir.join(qemu::RW_DISK);
        if !disk.exists() {
            let temporary = dir.join("rw.qcow2.tmp");
            let _ = std::fs::remove_file(&temporary);
            qemu::create_disk(&self.options.qemu_img, &temporary, size.disk_gib)
                .await
                .map_err(internal)?;
            std::fs::rename(&temporary, &disk).map_err(internal)?;
        }
        // No image layers before masterplan B-7: a GPT without partitions.
        keel_layers::disk::write(&dir, &[]).map_err(internal)?;
        let machine_type = self
            .floor
            .newest_machine_type()
            .unwrap_or_default()
            .to_owned();
        let record = MachineRecord {
            version: 1,
            owner: reference.owner.clone(),
            id: reference.id.clone(),
            fence_epoch: epoch,
            phase: Phase::Stopped,
            size,
            machine_type: machine_type.clone(),
            created_with: self.qemu_version(),
            created_at: Timestamp::now(),
            interrupted: None,
            error: String::new(),
            boot: None,
        };
        event(&dir, "created", &format!("machine type {machine_type}"));
        let mut state = self.state.lock().unwrap();
        state.machines.insert(
            reference.id.clone(),
            Entry {
                record,
                live: None,
                version: 0,
                updated: Timestamp::now(),
            },
        );
        self.commit(&mut state, &reference.id)
    }

    async fn start(self: &Arc<Self>, request: proto::MachineStart) -> Answer<proto::Machine> {
        let (id, record) = {
            let mut state = self.state.lock().unwrap();
            let entry = Self::fenced(&mut state, request.r#ref.as_ref(), request.fence.as_ref())?;
            let id = entry.record.id.clone();
            match entry.record.phase {
                Phase::Retained => {
                    return Err(refuse(
                        Code::FailedPrecondition,
                        "retained",
                        "the machine was deleted; its disk is kept",
                    ));
                }
                Phase::Running | Phase::Starting => {
                    let record = entry.record.clone();
                    record::write_json(&self.machine_dir(&id).join(record::RECORD), &record)
                        .map_err(internal)?;
                    return Ok(self.current(&state, &id));
                }
                _ => {}
            }
            if !self
                .floor
                .machine_types
                .contains(&entry.record.machine_type)
            {
                return Err(refuse(
                    Code::FailedPrecondition,
                    "machine_type",
                    &format!(
                        "the machine is pinned to {}, which QEMU {} lacks",
                        entry.record.machine_type,
                        self.qemu_version()
                    ),
                ));
            }
            entry.record.phase = Phase::Starting;
            entry.record.error.clear();
            let record = entry.record.clone();
            self.commit(&mut state, &id)?;
            (id, record)
        };
        let dir = self.machine_dir(&id);
        match self.launch(&id, &dir, &record).await {
            Ok(()) => {
                let mut state = self.state.lock().unwrap();
                let entry = state.machines.get_mut(&id).unwrap();
                if entry.record.phase == Phase::Starting {
                    entry.record.phase = Phase::Running;
                    entry.record.interrupted = None;
                    event(&dir, "running", "QEMU answers QMP and runs the guest");
                    return self.commit(&mut state, &id);
                }
                Err(refuse(
                    Code::Unavailable,
                    "boot",
                    &format!("the machine's QEMU exited: {}", entry.record.error),
                ))
            }
            Err(error) => {
                self.await_exit(&id, false).await;
                let message = format!("{error:#}; qemu.log: {}", tail(&dir.join("qemu.log")));
                let mut state = self.state.lock().unwrap();
                let entry = state.machines.get_mut(&id).unwrap();
                if entry.record.phase == Phase::Starting {
                    entry.record.phase = Phase::Stopped;
                    entry.record.error = message.clone();
                    self.commit(&mut state, &id)?;
                }
                event(&dir, "start failed", &message);
                Err(refuse(Code::Unavailable, "boot", &message))
            }
        }
    }

    /// Spawns the machine's QEMU, records the boot, and waits until it runs.
    async fn launch(self: &Arc<Self>, id: &str, dir: &Path, record: &MachineRecord) -> Result<()> {
        for name in [qemu::QMP_SOCKET, qemu::CHANNEL_SOCKET] {
            let _ = std::fs::remove_file(dir.join(name));
        }
        let console = dir.join(qemu::CONSOLE);
        if console.exists() {
            std::fs::rename(&console, dir.join("console.previous.log"))?;
        }
        let args = qemu::argv(&qemu::Launch {
            arch: self.arch,
            accel: self.options.accel,
            machine_type: &record.machine_type,
            vcpus: record.size.vcpus,
            memory_mib: record.size.memory_mib,
            kernel: &self.keel.kernel,
            base: &self.keel.base,
            dir,
        });
        record::write_json(
            &dir.join("argv.json"),
            &serde_json::json!({ "qemu": self.options.qemu, "args": args }),
        )?;
        let mut log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("qemu.log"))?;
        let boot_id = random_hex();
        writeln!(log, "--- boot {boot_id}: {}", self.qemu_version())?;
        let mut child = tokio::process::Command::new(&self.options.qemu)
            .args(&args)
            .current_dir(dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log)
            // Its own process group: a terminal's Ctrl-C reaches the runner,
            // which quits its machines itself.
            .process_group(0)
            .spawn()
            .with_context(|| format!("start {}", self.options.qemu.display()))?;
        let pid = child.id().context("QEMU exited at once")?;
        let (exited_tx, exited) = watch::channel(false);
        {
            let mut state = self.state.lock().unwrap();
            let entry = state.machines.get_mut(id).unwrap();
            entry.live = Some(Live { pid, exited });
            entry.record.boot = Some(Boot {
                boot_id: boot_id.clone(),
                started_at: Timestamp::now(),
                pid,
                qemu: self.qemu_version(),
                kernel_sha256: self.keel.kernel_sha256.clone(),
                base_sha256: self.keel.base_sha256.clone(),
            });
            self.commit(&mut state, id)
                .map_err(|e| anyhow::anyhow!(e.message))?;
        }
        event(dir, "boot", &format!("{boot_id}, QEMU pid {pid}"));
        let runner = self.clone();
        let reaped = id.to_owned();
        tokio::spawn(async move {
            let status = child.wait().await;
            runner.exited(&reaped, pid, status.map(|s| s.to_string()));
            let _ = exited_tx.send(true);
        });
        let mut qmp = Qmp::open(&dir.join(qemu::QMP_SOCKET), BOOT_TIMEOUT).await?;
        let status = qmp.execute("query-status", serde_json::Value::Null).await?;
        ensure!(
            status["status"] == "running",
            "QEMU is {}, not running",
            status["status"]
        );
        Ok(())
    }

    /// The reaper: QEMU `pid` of machine `id` has exited.
    fn exited(&self, id: &str, pid: u32, status: std::io::Result<String>) {
        let mut state = self.state.lock().unwrap();
        let Some(entry) = state.machines.get_mut(id) else {
            return;
        };
        if entry.live.as_ref().is_none_or(|live| live.pid != pid) {
            return;
        }
        entry.live = None;
        let status = status.unwrap_or_else(|error| error.to_string());
        let dir = self.machine_dir(id);
        if entry.record.phase != Phase::Stopping {
            entry.record.error = format!("QEMU exited ({status}): {}", tail(&dir.join("qemu.log")));
        }
        if entry.record.phase.live() {
            entry.record.phase = Phase::Stopped;
        }
        event(&dir, "exited", &format!("QEMU pid {pid}: {status}"));
        let _ = self.commit(&mut state, id);
    }

    /// SIGKILL the machine's QEMU, only while it is still this runner's
    /// child (the reaper has not reaped it, so the pid is still QEMU's).
    fn kill(&self, id: &str) {
        let state = self.state.lock().unwrap();
        if let Some(live) = state.machines.get(id).and_then(|entry| entry.live.as_ref())
            && !*live.exited.borrow()
        {
            // SAFETY: a plain signal to a child this process has not reaped.
            unsafe {
                libc::kill(live.pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }

    fn exited_watch(&self, id: &str) -> Option<watch::Receiver<bool>> {
        self.state
            .lock()
            .unwrap()
            .machines
            .get(id)
            .and_then(|entry| entry.live.as_ref())
            .map(|live| live.exited.clone())
    }

    /// Asks the machine's QEMU to quit over QMP; false if it did not answer.
    async fn send_quit(&self, id: &str) -> bool {
        let socket = self.machine_dir(id).join(qemu::QMP_SOCKET);
        match Qmp::open(&socket, Duration::from_secs(2)).await {
            Ok(mut qmp) => qmp.execute("quit", serde_json::Value::Null).await.is_ok(),
            Err(_) => false,
        }
    }

    /// Waits for the reaper, giving a QEMU told to quit [`QUIT_TIMEOUT`]
    /// before it is killed.
    async fn await_exit(&self, id: &str, asked: bool) {
        let Some(mut exited) = self.exited_watch(id) else {
            return;
        };
        let wait = if asked { QUIT_TIMEOUT } else { Duration::ZERO };
        if tokio::time::timeout(wait, exited.wait_for(|e| *e))
            .await
            .is_err()
        {
            self.kill(id);
            let _ = exited.wait_for(|e| *e).await;
        }
    }

    /// Quits the machine's QEMU (QMP `quit`, then SIGKILL) and waits for the
    /// reaper. The machine is `Stopping` already.
    async fn quit(&self, id: &str) {
        if self.exited_watch(id).is_some() {
            let asked = self.send_quit(id).await;
            self.await_exit(id, asked).await;
        }
    }

    async fn stop(self: &Arc<Self>, request: proto::MachineRef) -> Answer<proto::Machine> {
        let id = {
            let mut state = self.state.lock().unwrap();
            let entry = Self::fenced(&mut state, request.r#ref.as_ref(), request.fence.as_ref())?;
            let id = entry.record.id.clone();
            if entry.live.is_none() {
                let record = entry.record.clone();
                record::write_json(&self.machine_dir(&id).join(record::RECORD), &record)
                    .map_err(internal)?;
                return Ok(self.current(&state, &id));
            }
            entry.record.phase = Phase::Stopping;
            self.commit(&mut state, &id)?;
            id
        };
        event(&self.machine_dir(&id), "stop", "QEMU told to quit");
        self.quit(&id).await;
        let state = self.state.lock().unwrap();
        Ok(self.current(&state, &id))
    }

    /// Stops the machine, then keeps its disk (`RETAINED`) when asked to or
    /// when the runner interrupted it, or deletes its directory.
    async fn delete(self: &Arc<Self>, request: proto::MachineDelete) -> Answer<proto::Machine> {
        if let Some(deleted) = self.deleted(request.r#ref.as_ref(), request.fence.as_ref())? {
            return Ok(deleted);
        }
        let reference = proto::MachineRef {
            r#ref: request.r#ref.clone(),
            fence: request.fence,
        };
        let stopped = self.stop(reference).await?;
        let id = stopped.r#ref.unwrap_or_default().id;
        let mut state = self.state.lock().unwrap();
        let entry = state.machines.get_mut(&id).unwrap();
        if entry.record.phase == Phase::Retained {
            return Ok(self.current(&state, &id));
        }
        if entry.record.keeps_disk(request.retain) {
            entry.record.phase = Phase::Retained;
            event(&self.machine_dir(&id), "retained", "its disk is kept");
            return self.commit(&mut state, &id);
        }
        self.remove(&mut state, &id)
    }

    /// Forgets a retained machine: its directory is deleted.
    async fn discard(self: &Arc<Self>, request: proto::MachineRef) -> Answer<proto::Machine> {
        if let Some(deleted) = self.deleted(request.r#ref.as_ref(), request.fence.as_ref())? {
            return Ok(deleted);
        }
        let mut state = self.state.lock().unwrap();
        let entry = Self::fenced(&mut state, request.r#ref.as_ref(), request.fence.as_ref())?;
        let id = entry.record.id.clone();
        if entry.record.phase != Phase::Retained {
            return Err(refuse(
                Code::FailedPrecondition,
                "not_retained",
                &format!(
                    "the machine is {}; only a retained machine can be discarded",
                    entry.record.phase.name()
                ),
            ));
        }
        self.remove(&mut state, &id)
    }

    /// A deleted machine of this owner, for a delete or discard that comes
    /// again (every verb is idempotent); an older epoch is still refused.
    fn deleted(
        &self,
        reference: Option<&proto::Ref>,
        fence: Option<&proto::Fence>,
    ) -> Answer<Option<proto::Machine>> {
        let state = self.state.lock().unwrap();
        let Some(record) = reference.and_then(|r| {
            state
                .deleted
                .get(&r.id)
                .filter(|record| record.owner == r.owner)
        }) else {
            return Ok(None);
        };
        if fence.map_or(0, |fence| fence.epoch) < record.fence_epoch {
            return Err(refuse(
                Code::FailedPrecondition,
                "stale_epoch",
                "a newer epoch has been used for this machine",
            ));
        }
        Ok(Some(self.current(&state, &record.id)))
    }

    /// The tombstone first, then the directory: moved aside, then deleted.
    fn remove(&self, state: &mut State, id: &str) -> Answer<proto::Machine> {
        let mut entry = state.machines.remove(id).unwrap();
        entry.record.phase = Phase::Deleted;
        let control = self.options.directory.join(".berth");
        let result = record::write_json(
            &control.join("deleted").join(format!("{id}.json")),
            &entry.record,
        );
        if let Err(error) = result {
            entry.record.phase = Phase::Retained;
            state.machines.insert(id.to_owned(), entry);
            return Err(internal(error));
        }
        let trash = control.join("trash").join(id);
        if std::fs::rename(self.machine_dir(id), &trash).is_ok() {
            let _ = std::fs::remove_dir_all(&trash);
        }
        state.version += 1;
        state.deleted.insert(id.to_owned(), entry.record.clone());
        let machine = Self::machine(&entry.record, state.version, Timestamp::now());
        self.tell(watch_event::Type::Delete, machine.clone(), state);
        Ok(machine)
    }

    fn get(&self, reference: Option<&proto::Ref>) -> Answer<proto::Machine> {
        let reference = reference.ok_or_else(|| {
            refuse(
                Code::InvalidArgument,
                "ref",
                "a machine reference is required",
            )
        })?;
        let state = self.state.lock().unwrap();
        let owned = state
            .machines
            .get(&reference.id)
            .map(|entry| &entry.record)
            .or_else(|| state.deleted.get(&reference.id))
            .is_some_and(|record| record.owner == reference.owner);
        if !owned {
            return Err(refuse(Code::NotFound, "machine", "no such machine"));
        }
        Ok(self.current(&state, &reference.id))
    }

    async fn answer(self: &Arc<Self>, call: proto::Call) -> proto::CallResult {
        use call_result::Result as R;
        let result: Answer<R> = match call.verb {
            Some(Verb::RunnerGet(_)) => Ok(R::Runner(self.runner(&self.state.lock().unwrap()))),
            Some(Verb::MachineGet(request)) => self.get(request.r#ref.as_ref()).map(R::Machine),
            Some(Verb::MachineList(_)) => {
                let state = self.state.lock().unwrap();
                Ok(R::Machines(proto::Machines {
                    items: state
                        .machines
                        .values()
                        .map(|entry| Self::machine(&entry.record, entry.version, entry.updated))
                        .collect(),
                    version: state.version,
                }))
            }
            Some(Verb::MachineCreate(request)) => {
                let _op = self.ops.lock().await;
                self.create(request).await.map(R::Machine)
            }
            Some(Verb::MachineStart(request)) => {
                let _op = self.ops.lock().await;
                self.start(request).await.map(R::Machine)
            }
            Some(Verb::MachineStop(request)) => {
                let _op = self.ops.lock().await;
                self.stop(request).await.map(R::Machine)
            }
            Some(Verb::MachineDelete(request)) => {
                let _op = self.ops.lock().await;
                self.delete(request).await.map(R::Machine)
            }
            Some(Verb::MachineDiscard(request)) => {
                let _op = self.ops.lock().await;
                self.discard(request).await.map(R::Machine)
            }
            Some(Verb::MachineDiagnose(_)) => {
                Err(unimplemented::<Self>("diagnosis yet (masterplan B-9)"))
            }
            Some(Verb::TemplatePublish(_) | Verb::TemplateList(_) | Verb::TemplateDelete(_)) => {
                Err(unimplemented::<Self>("templates yet (masterplan B-8)"))
            }
            None => Err(refuse(
                Code::InvalidArgument,
                "verb",
                "unknown or missing verb",
            )),
        };
        proto::CallResult {
            result: Some(result.unwrap_or_else(R::Error)),
        }
    }

    /// The runner stops: every machine's QEMU is quit and the machine is
    /// marked interrupted (its disk is kept; cubed starts it again).
    pub async fn shutdown(&self) {
        let _op = self.ops.lock().await;
        let live: Vec<String> = {
            let mut state = self.state.lock().unwrap();
            let ids: Vec<String> = state
                .machines
                .values()
                .filter(|entry| entry.live.is_some())
                .map(|entry| entry.record.id.clone())
                .collect();
            for id in &ids {
                let entry = state.machines.get_mut(id).unwrap();
                entry.record.runner_stopping(Timestamp::now());
                let _ = self.commit(&mut state, id);
            }
            ids
        };
        let mut asked = Vec::new();
        for id in &live {
            event(
                &self.machine_dir(id),
                "runner stopping",
                "QEMU told to quit",
            );
            asked.push(self.send_quit(id).await);
        }
        for (id, asked) in live.iter().zip(asked) {
            self.await_exit(id, asked).await;
        }
    }
}

/// A QEMU a previous runner left: told to quit over its QMP socket. The
/// runner never signals a process it did not start. True if one answered.
async fn quit_orphan(socket: &Path) -> bool {
    let Ok(mut qmp) = Qmp::open(socket, Duration::from_millis(500)).await else {
        return false;
    };
    let _ = qmp.execute("quit", serde_json::Value::Null).await;
    drop(qmp);
    // Gone once its socket refuses connections.
    for _ in 0..200 {
        if tokio::net::UnixStream::connect(socket).await.is_err() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    true
}

impl Service for VmRunner {
    const KIND: &'static str = "vm_runner";

    fn hello(&self, hello: &proto::Hello) -> Answer<proto::HelloAnswer> {
        if hello.protocol != PROTOCOL {
            return Err(refuse(
                Code::FailedPrecondition,
                "incompatible_protocol",
                &format!(
                    "berth vm speaks runner protocol {PROTOCOL}, not {}",
                    hello.protocol
                ),
            ));
        }
        if hello.expect_node != self.options.node_id {
            return Err(refuse(
                Code::PermissionDenied,
                "wrong_node",
                &format!("this runner is {}", self.options.node_id),
            ));
        }
        Ok(proto::HelloAnswer {
            protocol: PROTOCOL,
            capabilities: CAPABILITIES.map(String::from).to_vec(),
            runner: Some(self.runner(&self.state.lock().unwrap())),
        })
    }
    async fn call(self: Arc<Self>, call: proto::Call) -> proto::CallResult {
        self.answer(call).await
    }
    async fn watch(self: Arc<Self>, send: &mut SendStream) -> Result<()> {
        serve::watch(send, &self.events, || {
            let state = self.state.lock().unwrap();
            let mut resources = vec![watch_event::Resource::Runner(self.runner(&state))];
            resources.extend(state.machines.values().map(|entry| {
                watch_event::Resource::Machine(Self::machine(
                    &entry.record,
                    entry.version,
                    entry.updated,
                ))
            }));
            (state.version, resources)
        })
        .await
    }
    async fn guest(
        self: Arc<Self>,
        _header: proto::GuestHeader,
        recv: &mut RecvStream,
    ) -> Answer<Vec<u8>> {
        // Read the request to its end (bounded), so the answer is what
        // cubed sees rather than a stopped stream.
        use tokio::io::AsyncReadExt;
        let _ = tokio::io::copy(&mut recv.take(8 << 20), &mut tokio::io::sink()).await;
        Err(unimplemented::<Self>("guest channel yet (masterplan B-2)"))
    }
}
