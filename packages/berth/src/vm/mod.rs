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
//! The guest channel (B-2, channel.rs): the runner connects to `ctl.sock`
//! when QEMU runs, follows the agent's port over QMP (`qev.sock`), sends
//! `machine_setup` after every `hello` (the image's layers, `Boot.documents`,
//! the runner's CA from ca.rs, fresh entropy), keeps `status.guest` as the
//! agent says it, and carries `guest` streams as `req`/`ans`. The image is
//! the one `berth vm --image` names, pulled beforehand into the directory by
//! `berth image pull`; a machine keeps the image it first started with.
//!
//! Not here yet: the network (B-4: no network device at all), image pulls
//! by the runner itself and the cache limit (B-7), templates (B-8),
//! diagnosis (B-9) and snapshots (S-7a).
//!
//! `stop` (also `delete` and the runner's own shutdown) asks the agent to
//! shut down (`DaemonRequest.shutdown`: the workload gets SIGTERM, then
//! SIGKILL after 10 s, the disk is synced and remounted read-only) and waits
//! at most 30 s for done in the session it asked in; then QEMU is quit. The
//! record says `controlled` (done came: what was written is on the disk) or
//! `forced` (no session, an error, no answer: as a power cut, `e2fsck` on the
//! next boot), shown as the `Stopped` condition until the next start.
mod ca;
mod channel;
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
use cube_runner_protocol::proto::{daemon_answer::Result as AnswerKind, daemon_request::Op};
use cube_runner_protocol::{
    MAX_FRAME_BYTES, PROTOCOL, Timestamp,
    proto::{self, Code, call::Verb, call_result, watch_event},
    refuse,
};
use iroh::endpoint::{RecvStream, SendStream};
use tokio::sync::{broadcast, watch};

pub use qemu::{Accel, Floor};
use qemu::{Arch, Keel, Qmp};
use record::{Boot, MachineImage, MachineRecord, Phase, Size, Stopped};

use crate::{
    host::{getrandom, host_name, valid_id, valid_op, valid_owner},
    image,
    serve::{self, Service, unimplemented},
};

const CAPABILITIES: [&str; 10] = [
    "runner.get",
    "machine.create",
    "machine.start",
    "machine.stop",
    "machine.delete",
    "machine.discard",
    "machine.get",
    "machine.list",
    "watch",
    "guest",
];
/// The `Boot.documents` names keel knows (runner.proto's `Boot`).
const BOOT_DOCUMENTS: [&str; 4] = ["hostname", "env", "hooks/pre-setup", "hooks/pre-resume"];
/// All of a machine's boot documents together, at most.
const MAX_BOOT_BYTES: usize = 256 * 1024;
/// A guest request, at most: in one `req` frame its bytes are base64, and
/// the frame must stay within MAX_FRAME_BYTES.
const MAX_GUEST_REQUEST: u64 = 704 * 1024;
/// What the runner uses of the agent (`MachineSetup.capabilities`).
const AGENT_CAPABILITIES: [&str; 3] = ["machine_setup", "session", "abort"];
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
/// How long the agent has to answer `shutdown` with done (a controlled
/// stop); then QEMU is quit anyway (a forced stop).
const SHUTDOWN_WAIT: Duration = Duration::from_secs(30);
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
    /// The image every machine is built on, pulled into `directory` first.
    pub image: image::Reference,
}

/// The runner's image, as `berth image pull` recorded it.
struct Image {
    reference: String,
    record: image::ImageRecord,
}

impl Image {
    fn machine_image(&self) -> MachineImage {
        MachineImage {
            reference: self.reference.clone(),
            manifest: self.record.manifest.digest.clone(),
            diff_ids: self
                .record
                .layers
                .iter()
                .map(|l| l.diff_id.clone())
                .collect(),
        }
    }
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
    /// While QEMU runs: its channel, what the agent last said, and the boot
    /// documents of the start (memory only; cubed sends them every start).
    guest: Option<Arc<channel::Guest>>,
    info: Option<proto::GuestInfo>,
    documents: std::collections::HashMap<String, Vec<u8>>,
    /// The sessions this machine's agent used in earlier QEMUs (boots and,
    /// with S-7a, restores), for as long as the runner runs.
    sessions: std::collections::HashSet<String>,
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
    ca: ca::RunnerCa,
    image: Image,
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
        let ca = ca::RunnerCa::load_or_create(&control.join("ca"))?;
        let image = load_image(&options.directory, &options.image)?;
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
                    guest: None,
                    info: None,
                    documents: Default::default(),
                    sessions: Default::default(),
                },
            );
        }
        let (events, _) = broadcast::channel(256);
        Ok(Arc::new(Self {
            options,
            arch,
            floor,
            keel,
            ca,
            image,
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
                "image: {} ({}, {} layers, manifest {})",
                self.image.reference,
                self.image.record.platform,
                self.image.record.layers.len(),
                self.image.record.manifest.digest
            ),
            format!("runner CA: certificate sha256 {}", self.ca.sha256),
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
                max_boot_bytes: MAX_BOOT_BYTES as u32,
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
            ca_pem: self.ca.pem.clone(),
            meta: Some(proto::Meta {
                version: state.version,
                updated: Some(Timestamp::now()),
            }),
            started_at: Some(self.started_at),
        }
    }

    fn machine(
        record: &MachineRecord,
        guest: Option<&proto::GuestInfo>,
        version: i64,
        updated: Timestamp,
    ) -> proto::Machine {
        let boot = record.boot.as_ref().filter(|_| record.phase.live());
        let mut conditions: Vec<proto::Condition> = record
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
        // How the runner's newest stop went: status true only when it was
        // controlled (reason `controlled` or `forced`).
        conditions.extend(record.stopped.iter().map(|stopped| proto::Condition {
            r#type: "Stopped".into(),
            status: stopped.kind == "controlled",
            reason: stopped.kind.clone(),
            message: stopped.message.clone(),
            since: Some(stopped.at),
        }));
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
                guest: guest.filter(|_| record.phase.live()).cloned(),
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
            Some(entry) => Self::machine(
                &entry.record,
                entry.info.as_ref(),
                entry.version,
                entry.updated,
            ),
            None => Self::machine(&state.deleted[id], None, state.version, Timestamp::now()),
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
        let machine = Self::machine(&entry.record, entry.info.as_ref(), version, entry.updated);
        self.tell(watch_event::Type::Put, machine.clone(), state);
        Ok(machine)
    }

    /// What the agent of machine `id` said in boot `boot_id`, as
    /// `status.guest`: a watch event, not a journal write.
    fn publish_guest(&self, id: &str, boot_id: &str, info: proto::GuestInfo) {
        let mut state = self.state.lock().unwrap();
        let Some(entry) = state.machines.get_mut(id) else {
            return;
        };
        let this_boot = entry.live.is_some()
            && entry
                .record
                .boot
                .as_ref()
                .is_some_and(|b| b.boot_id == boot_id);
        if !this_boot {
            return;
        }
        entry.info = Some(info);
        state.version += 1;
        let version = state.version;
        let entry = state.machines.get_mut(id).unwrap();
        entry.version = version;
        entry.updated = Timestamp::now();
        let machine = Self::machine(&entry.record, entry.info.as_ref(), version, entry.updated);
        self.tell(watch_event::Type::Put, machine, &state);
    }

    /// Machine `id`'s setup (runner.proto's `MachineSetup`): its image's
    /// layers topmost first, its boot documents, the runner's CA, and 32
    /// fresh random bytes.
    fn setup(&self, id: &str) -> proto::MachineSetup {
        let state = self.state.lock().unwrap();
        let entry = state.machines.get(id);
        let documents = entry
            .map(|entry| entry.documents.clone().into_iter().collect())
            .unwrap_or_default();
        let layers = entry
            .and_then(|entry| entry.record.image.as_ref())
            .map(|image| {
                image
                    .diff_ids
                    .iter()
                    .enumerate()
                    .rev()
                    .map(|(i, diff_id)| proto::Layer {
                        partition: i as u32 + 1,
                        source: Some(proto::layer::Source::DiffId(diff_id.clone())),
                    })
                    .collect()
            })
            .unwrap_or_default();
        let mut entropy = vec![0u8; 32];
        getrandom(&mut entropy);
        proto::MachineSetup {
            r#ref: entry.map(|entry| proto::Ref {
                owner: entry.record.owner.clone(),
                id: entry.record.id.clone(),
            }),
            documents,
            entropy,
            layers,
            image: Some(proto::ImageConfig {
                digest: self.image.record.manifest.digest.clone(),
                env: self.image.record.env.clone(),
            }),
            ca_pem: self.ca.pem.clone(),
            runner_version: crate::SOFTWARE_VERSION.into(),
            protocol: PROTOCOL,
            capabilities: AGENT_CAPABILITIES.map(String::from).to_vec(),
        }
    }

    /// Writes the runner's image onto machine `id`'s layer disk (QEMU does
    /// not run) and returns what the record keeps of it.
    fn write_layers(&self, id: &str) -> Result<MachineImage> {
        let layers: Vec<keel_layers::disk::Layer> = self
            .image
            .record
            .layers
            .iter()
            .map(|layer| keel_layers::disk::Layer {
                path: self.options.directory.join(&layer.file),
                name: layer
                    .diff_id
                    .trim_start_matches("sha256:")
                    .chars()
                    .take(29)
                    .collect(),
            })
            .collect();
        keel_layers::disk::write(&self.machine_dir(id), &layers)?;
        Ok(self.image.machine_image())
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
        let image = self.write_layers(&reference.id).map_err(internal)?;
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
            image: Some(image),
            stopped: None,
        };
        event(
            &dir,
            "created",
            &format!(
                "machine type {machine_type}, image {}",
                self.image.reference
            ),
        );
        let mut state = self.state.lock().unwrap();
        state.machines.insert(
            reference.id.clone(),
            Entry {
                record,
                live: None,
                version: 0,
                updated: Timestamp::now(),
                guest: None,
                info: None,
                documents: Default::default(),
                sessions: Default::default(),
            },
        );
        self.commit(&mut state, &reference.id)
    }

    async fn start(self: &Arc<Self>, request: proto::MachineStart) -> Answer<proto::Machine> {
        let documents = boot_documents(request.boot.as_ref())?;
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
            // A machine keeps its image: its workload root is built on it.
            let runner_image = self.image.machine_image();
            match &entry.record.image {
                Some(image) if image.manifest != runner_image.manifest => {
                    return Err(refuse(
                        Code::FailedPrecondition,
                        "image_changed",
                        &format!(
                            "the machine is built on {} ({}); this runner serves {}",
                            image.reference, image.manifest, runner_image.reference
                        ),
                    ));
                }
                Some(_) => {}
                // Created before the runner had an image (B-1): its disk
                // never had a workload root, so it takes the runner's.
                None => {
                    entry.record.image = Some(self.write_layers(&id).map_err(internal)?);
                }
            }
            let entry = state.machines.get_mut(&id).unwrap();
            entry.documents = documents;
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
                    entry.record.stopped = None;
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
        for name in [qemu::QMP_SOCKET, qemu::EVENTS_SOCKET, qemu::CHANNEL_SOCKET] {
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
        // The guest channel: the port's events first, so none is missed
        // (the agent opens the port well after QEMU answers QMP).
        let mut events = Qmp::open(&dir.join(qemu::EVENTS_SOCKET), BOOT_TIMEOUT).await?;
        let (ports, port_events) = tokio::sync::mpsc::unbounded_channel();
        // R3: the agent may have opened the port before this monitor was
        // connected; QMP's chardev state says so (`frontend-open`).
        if let Ok(chardevs) = events
            .execute("query-chardev", serde_json::Value::Null)
            .await
            && chardevs
                .as_array()
                .into_iter()
                .flatten()
                .any(|c| c["label"] == "ctl" && c["frontend-open"] == true)
        {
            let _ = ports.send(true); // an event during the query was skipped; this state is after it
        }
        tokio::spawn(async move {
            while let Ok(event) = events.event().await {
                if event["event"] == "VSERPORT_CHANGE" && event["data"]["id"] == qemu::PORT_ID {
                    let open = event["data"]["open"].as_bool().unwrap_or(false);
                    if ports.send(open).is_err() {
                        break;
                    }
                }
            }
        });
        let seen = self
            .state
            .lock()
            .unwrap()
            .machines
            .get(id)
            .map(|entry| entry.sessions.clone())
            .unwrap_or_default();
        let (guest, frames) = channel::Guest::with_seen(seen);
        let exited = {
            let mut state = self.state.lock().unwrap();
            let entry = state.machines.get_mut(id).unwrap();
            entry.guest = Some(Arc::clone(&guest));
            entry.live.as_ref().map(|live| live.exited.clone())
        };
        if let Some(exited) = exited {
            let host = Arc::new(MachineHost {
                runner: Arc::clone(self),
                id: id.to_owned(),
                boot_id,
                dir: dir.to_owned(),
            });
            tokio::spawn(channel::run(
                guest,
                frames,
                dir.join(qemu::CHANNEL_SOCKET),
                port_events,
                host,
                channel::TIMING,
                exited,
            ));
        }
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
        if let Some(guest) = entry.guest.take() {
            entry.sessions.extend(guest.seen());
        }
        entry.info = None;
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

    /// Asks the machine's agent to shut down (runner.proto's
    /// `DaemonRequest.shutdown`) and waits at most SHUTDOWN_WAIT for done in
    /// the session it was sent in. Anything else is a forced stop.
    async fn shut_down_guest(&self, id: &str) -> (bool, String) {
        let guest = self
            .state
            .lock()
            .unwrap()
            .machines
            .get(id)
            .and_then(|entry| entry.guest.clone());
        let Some(guest) = guest else {
            return (false, "the machine had no guest channel".into());
        };
        let (_, answer) = match guest.request(Op::Shutdown(proto::Empty {})) {
            Ok(sent) => sent,
            Err(error) => return (false, format!("no shutdown was sent: {}", error.message)),
        };
        stop_outcome(tokio::time::timeout(SHUTDOWN_WAIT, answer).await.ok())
    }

    /// The machine's QEMU goes: a controlled stop when the agent shut down,
    /// else forced. The machine is `Stopping` already; its record says how.
    async fn stop_machine(&self, id: &str) {
        let dir = self.machine_dir(id);
        let (controlled, message) = self.shut_down_guest(id).await;
        event(
            &dir,
            if controlled {
                "stop: controlled"
            } else {
                "stop: forced"
            },
            &message,
        );
        self.quit(id).await;
        let mut state = self.state.lock().unwrap();
        if let Some(entry) = state.machines.get_mut(id) {
            entry.record.stopped = Some(Stopped {
                kind: if controlled { "controlled" } else { "forced" }.into(),
                message,
                at: Timestamp::now(),
            });
            let _ = self.commit(&mut state, id);
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
        event(
            &self.machine_dir(&id),
            "stop",
            "the agent is asked to shut down",
        );
        self.stop_machine(&id).await;
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
        let machine = Self::machine(&entry.record, None, state.version, Timestamp::now());
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
                        .map(|entry| {
                            Self::machine(
                                &entry.record,
                                entry.info.as_ref(),
                                entry.version,
                                entry.updated,
                            )
                        })
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
    pub async fn shutdown(self: &Arc<Self>) {
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
        let mut stops = tokio::task::JoinSet::new();
        for id in live {
            event(
                &self.machine_dir(&id),
                "runner stopping",
                "the agent is asked to shut down",
            );
            let runner = Arc::clone(self);
            stops.spawn(async move { runner.stop_machine(&id).await });
        }
        while stops.join_next().await.is_some() {}
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

/// Whether the agent's answer to `shutdown` makes a controlled stop (only
/// done does), and what to record; None is no answer within the wait.
fn stop_outcome(
    answer: Option<std::result::Result<channel::Answer, tokio::sync::oneshot::error::RecvError>>,
) -> (bool, String) {
    match answer {
        Some(Ok(Ok(AnswerKind::Done(_)))) => (
            true,
            "the agent shut down: its writes are on the disk and the disk is read-only".into(),
        ),
        Some(Ok(Ok(AnswerKind::Error(error)))) => (
            false,
            format!(
                "the agent's shutdown failed: {} {}",
                error.reason, error.message
            ),
        ),
        Some(Ok(Ok(AnswerKind::Guest(_)))) => {
            (false, "the agent answered shutdown with guest bytes".into())
        }
        Some(Ok(Err(error))) => (false, format!("no answer to shutdown: {}", error.message)),
        Some(Err(_)) => (false, "no answer to shutdown: the channel ended".into()),
        None => (
            false,
            format!("no answer to shutdown within {} s", SHUTDOWN_WAIT.as_secs()),
        ),
    }
}

/// One boot of one machine, as its guest channel sees the runner.
struct MachineHost {
    runner: Arc<VmRunner>,
    id: String,
    boot_id: String,
    dir: PathBuf,
}

impl channel::Host for MachineHost {
    fn setup(&self) -> proto::MachineSetup {
        self.runner.setup(&self.id)
    }
    fn publish(&self, info: proto::GuestInfo) {
        self.runner.publish_guest(&self.id, &self.boot_id, info);
    }
    fn event(&self, what: &str, detail: &str) {
        event(&self.dir, what, detail);
    }
}

/// `MachineStart.boot`'s documents, checked: names keel knows, and at most
/// MAX_BOOT_BYTES together. `Boot.mac` has no use before the network (B-4).
fn boot_documents(
    boot: Option<&proto::Boot>,
) -> Answer<std::collections::HashMap<String, Vec<u8>>> {
    let documents = boot.map(|boot| boot.documents.clone()).unwrap_or_default();
    if let Some(name) = documents
        .keys()
        .find(|name| !BOOT_DOCUMENTS.contains(&name.as_str()))
    {
        return Err(refuse(
            Code::InvalidArgument,
            "unknown_document",
            &format!(
                "boot document {name:?}; keel knows {}",
                BOOT_DOCUMENTS.join(", ")
            ),
        ));
    }
    let bytes: usize = documents.iter().map(|(k, v)| k.len() + v.len()).sum();
    if bytes > MAX_BOOT_BYTES {
        return Err(refuse(
            Code::InvalidArgument,
            "boot_size",
            &format!("boot documents are at most {MAX_BOOT_BYTES} bytes together"),
        ));
    }
    Ok(documents.into_iter().collect())
}

/// The image `reference` names, as `berth image pull` left it in
/// `directory`: its record and every layer file, for this platform.
fn load_image(directory: &Path, reference: &image::Reference) -> Result<Image> {
    let store = image::Store::open(directory)?;
    let path = store.record_path(&reference.digest);
    let pull = format!(
        "pull it first: berth image pull --dir {} --mkfs-erofs <mkfs.erofs> --image {reference}",
        directory.display()
    );
    let text = std::fs::read(&path).with_context(|| {
        format!(
            "no record of {reference} in {}; {pull}",
            directory.display()
        )
    })?;
    let record: image::ImageRecord = serde_json::from_slice(&text)
        .with_context(|| format!("{} is not an image record", path.display()))?;
    let platform = image::Platform::native()?.to_string();
    ensure!(
        record.platform == platform && record.digest == reference.digest.to_string(),
        "{} is for {} {}, not {platform} {}",
        path.display(),
        record.platform,
        record.digest,
        reference.digest
    );
    for layer in &record.layers {
        let file = directory.join(&layer.file);
        ensure!(
            Path::new(&layer.file).is_relative() && !layer.file.contains("..") && file.is_file(),
            "{reference}: layer {} is not in the cache ({}); {pull}",
            layer.diff_id,
            file.display()
        );
    }
    Ok(Image {
        reference: reference.to_string(),
        record,
    })
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
                    entry.info.as_ref(),
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
        header: proto::GuestHeader,
        recv: &mut RecvStream,
        send: &mut SendStream,
    ) -> Answer<Vec<u8>> {
        // The request first, to its end (bounded), so a refusal is what
        // cubed reads rather than a stopped stream.
        use tokio::io::AsyncReadExt;
        let mut request = Vec::new();
        recv.take(MAX_GUEST_REQUEST + 1)
            .read_to_end(&mut request)
            .await
            .map_err(|error| refuse(Code::Unavailable, "stream", &error.to_string()))?;
        if request.len() as u64 > MAX_GUEST_REQUEST {
            return Err(refuse(
                Code::InvalidArgument,
                "size",
                &format!("a guest request is at most {MAX_GUEST_REQUEST} bytes"),
            ));
        }
        if !valid_op(&header.op) {
            return Err(refuse(
                Code::InvalidArgument,
                "op",
                "invalid guest operation name",
            ));
        }
        let guest = {
            let mut state = self.state.lock().unwrap();
            let before = header
                .r#ref
                .as_ref()
                .and_then(|r| state.machines.get(&r.id))
                .map(|entry| entry.record.fence_epoch);
            let entry = Self::fenced(&mut state, header.r#ref.as_ref(), header.fence.as_ref())?;
            if before != Some(entry.record.fence_epoch) {
                let id = entry.record.id.clone();
                record::write_json(&self.machine_dir(&id).join(record::RECORD), &entry.record)
                    .map_err(internal)?;
            }
            match (&entry.guest, entry.record.phase) {
                (Some(guest), Phase::Running) => Arc::clone(guest),
                _ => {
                    return Err(refuse(
                        Code::Unavailable,
                        "not_running",
                        &format!("the machine is {}", entry.record.phase.name()),
                    ));
                }
            }
        };
        let (ch, answer) = guest.request(Op::Guest(proto::GuestRequest {
            op: header.op.clone(),
            data: request,
        }))?;
        let answer = tokio::select! {
            answer = answer => answer,
            // cubed stopped reading (its call was aborted or timed out):
            // the agent lets the operation finish and drops its answer.
            stopped = send.stopped() => {
                if let Some(r) = header.r#ref.as_ref() {
                    event(&self.machine_dir(&r.id), "stream", &format!("channel {ch}: cubed stopped reading ({stopped:?})"));
                }
                guest.abort(ch);
                return Err(refuse(Code::Aborted, "stream", "cubed stopped waiting for the answer"));
            }
        };
        match answer {
            Ok(Ok(AnswerKind::Guest(bytes))) => Ok(bytes),
            Ok(Ok(AnswerKind::Error(error))) => Err(error),
            Ok(Ok(AnswerKind::Done(_))) => Err(refuse(
                Code::Internal,
                "agent",
                "the agent answered a guest operation with done",
            )),
            Ok(Err(error)) => Err(error),
            Err(_) => Err(proto::Error {
                completion_unknown: true,
                ..refuse(
                    Code::Unavailable,
                    "guest_disconnected",
                    "the machine stopped",
                )
            }),
        }
    }
}

#[cfg(test)]
mod stop_tests {
    use super::*;

    #[test]
    fn only_done_is_a_controlled_stop() {
        assert!(stop_outcome(Some(Ok(Ok(AnswerKind::Done(proto::Empty {}))))).0);
        let failed = stop_outcome(Some(Ok(Ok(AnswerKind::Error(refuse(
            Code::Internal,
            "shutdown_failed",
            "remounting /run/keel/rw read-only: Device or resource busy",
        ))))));
        assert!(
            !failed.0 && failed.1.contains("shutdown_failed"),
            "{failed:?}"
        );
        assert!(!stop_outcome(Some(Ok(Ok(AnswerKind::Guest(b"{}".to_vec()))))).0);
        let ended = stop_outcome(Some(Ok(Err(refuse(
            Code::Unavailable,
            "guest_disconnected",
            "the machine's agent started a new session",
        )))));
        assert!(!ended.0 && ended.1.contains("new session"), "{ended:?}");
        let (sender, receiver) = tokio::sync::oneshot::channel::<channel::Answer>();
        drop(sender);
        let gone = stop_outcome(Some(
            tokio::runtime::Builder::new_current_thread()
                .build()
                .unwrap()
                .block_on(receiver),
        ));
        assert!(!gone.0 && gone.1.contains("channel ended"), "{gone:?}");
        let late = stop_outcome(None);
        assert!(!late.0 && late.1.contains("within 30 s"), "{late:?}");
    }
}
