//! `berth vm`: a runner whose machines are keel guests under QEMU
//! (docs/plans/2026-10-10-vm-base-and-image-layers.md, package 8; masterplan
//! row B-1). Each machine is `DIRECTORY/<id>`:
//!
//! ```text
//! machine.json   the journal (record.rs); the pinned machine type
//! rw.qcow2       the writable disk (vdc), created once, never replaced
//! layers.vmdk    the layer disk (vdb, read-only) with layers.head/.tail
//! ctl.sock       cube.0, the guest channel (spoken from masterplan B-2 on)
//! (no socket)    virtio-net: QEMU inherits one end of a socket pair (B-4)
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
//! the one `berth vm --image` names, which berth pulls into the directory
//! before it listens if any of it is missing (B-7, image.rs); a machine
//! keeps the image it first started with.
//!
//! The layer cache (B-7, masterplan U6): least recently used layers go
//! first once the cache is over `--layer-cache-gib`, but never a layer of
//! the runner's image or of a machine that is not deleted, retained ones
//! too (their layer disks name the cache's files). It is trimmed when the
//! runner starts and when a machine is deleted or discarded.
//!
//! The network (B-4, egress.rs): every QEMU process gets a socket pair for
//! `-netdev dgram` and its own cube-netstack LAN in the runner, with the
//! fixed guest address on the kernel command line; egress follows the
//! policy of the newest `machine_start` (policy.rs), goes on for its lease
//! after cubed's connection is gone (presence.rs), and refusals are
//! reported to cubed (report.rs). HTTPS is intercepted with the runner's CA.
//!
//! `dial` (B-6): a TCP connection from the LAN's address to a port of a
//! running machine, 1024 to 65535 only, fenced as `guest` is; its bytes go
//! both ways on the stream (serve.rs). It needs cubed's connection, which
//! carries it, and nothing else: the egress lease does not apply.
//!
//! Templates (B-8, template.rs): a build machine (`MachineSpec.build`) has
//! a blank template disk, vdd; `template_publish` has its agent write its
//! `upper/` there as one EROFS layer, checks the superblock, keeps the disk
//! as `templates/<id>.erofs` and deletes the build machine. A machine made
//! from a template gets it above the image's layers, and only on the image
//! it was built on. Templates are outside the layer cache's limit, keep the
//! layers of their image in the cache, and go only by `template_delete`,
//! once no machine is made from them.
//!
//! Diagnosis (B-9, diagnose.rs): `machine_diagnose` answers one bounded,
//! redacted JSON document of read-only evidence about a machine (its
//! record, QEMU's path, version and argv, `query-status`, the tails of its
//! console and events, what its agent said, its egress, the runner, and
//! Iroh's paths to cubed with their RTT). It takes no mutation's lock and
//! changes nothing. The RTT of the path in use is `Network.rtt_to_cubed`
//! in hello and watch (masterplan U15 (a)).
//!
//! Not here yet: snapshots (S-7a).
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
mod diagnose;
mod egress;
mod policy;
mod presence;
#[cfg(test)]
mod publish_tests;
mod qemu;
mod record;
mod report;
mod template;
#[cfg(test)]
mod template_tests;

use std::{
    collections::{BTreeMap, HashSet},
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
    serve::{self, Service},
};

const CAPABILITIES: [&str; 15] = [
    "runner.get",
    "machine.create",
    "machine.start",
    "machine.stop",
    "machine.delete",
    "machine.discard",
    "machine.get",
    "machine.list",
    "machine.diagnose",
    "watch",
    "guest",
    "dial",
    "template.publish",
    "template.list",
    "template.delete",
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
/// How long the agent has to publish (clean, check and write the layer with
/// mkfs.erofs) before the call says `completion_unknown`; asked again, it
/// answers as the first time.
const PUBLISH_WAIT: Duration = Duration::from_secs(600);
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
    /// Given by path, as QEMU; and what it says it is.
    pub mkfs: PathBuf,
    pub mkfs_version: String,
    /// The layer cache's limit (`--layer-cache-gib`).
    pub layer_cache_bytes: u64,
    /// Free bytes on the file system of a path ([`image::free_bytes`]; tests
    /// give another).
    pub free_space: fn(&Path) -> std::io::Result<u64>,
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
    /// The egress policy of the newest start (memory only, as documents).
    policy: Option<policy::Policy>,
    /// While QEMU runs: its LAN and egress gate.
    net: Option<egress::Net>,
    /// While a `template_publish` waits for this machine's agent (R14b).
    publishing: Option<Publishing>,
}

/// A build machine's publishing mark: every other mutation of the machine
/// is refused while it is set ([`VmRunner::not_publishing`]); a publication
/// that comes again waits for `cleared`.
struct Publishing {
    token: u64,
    cleared: watch::Receiver<()>,
}

/// Clears its machine's [`Publishing`] mark when dropped, on every way out
/// of a publication: the template kept, a refusal, a timeout, the runner's
/// stop, or the call dropped. Never dropped with `state` locked.
struct Mark {
    runner: Arc<VmRunner>,
    id: String,
    token: u64,
    /// Dropped after the mark is cleared: it wakes the publications that
    /// wait for it.
    _cleared: watch::Sender<()>,
}

impl Mark {
    fn holds(&self, entry: &Entry) -> bool {
        entry
            .publishing
            .as_ref()
            .is_some_and(|mark| mark.token == self.token)
    }
}

impl Drop for Mark {
    fn drop(&mut self) {
        if let Ok(mut state) = self.runner.state.lock()
            && let Some(entry) = state.machines.get_mut(&self.id)
            && entry
                .publishing
                .as_ref()
                .is_some_and(|mark| mark.token == self.token)
        {
            entry.publishing = None;
        }
    }
}

struct State {
    version: i64,
    machines: BTreeMap<String, Entry>,
    /// Deleted machines: their ids are never reused.
    deleted: BTreeMap<String, MachineRecord>,
    /// Templates by id (a build machine's id); `publishing` ones only for
    /// as long as a publication runs.
    templates: BTreeMap<String, template::TemplateRecord>,
    /// The newest [`Publishing`] mark's token.
    marks: u64,
}

pub struct VmRunner {
    options: VmOptions,
    arch: Arch,
    floor: Floor,
    keel: Keel,
    ca: ca::RunnerCa,
    egress: Arc<egress::Egress>,
    image: Image,
    cache: keel_layers::cache::LayerCache,
    started_at: Timestamp,
    state: Mutex<State>,
    events: broadcast::Sender<proto::WatchEvent>,
    /// One mutation at a time (create, start, stop, delete, discard,
    /// template publish and delete). A publication holds it only to begin
    /// and to finish, not while its agent works (R14b: [`Publishing`]).
    ops: tokio::sync::Mutex<()>,
    /// The runner stops: a publication stops waiting for the agent and
    /// keeps nothing.
    stopping: watch::Sender<bool>,
}

type Answer<T> = std::result::Result<T, proto::Error>;

fn internal(error: impl std::fmt::Display) -> proto::Error {
    refuse(Code::Internal, "io", &error.to_string())
}

/// A `google.protobuf.Duration`.
fn duration(duration: Duration) -> pbjson_types::Duration {
    pbjson_types::Duration {
        seconds: duration.as_secs() as i64,
        nanos: duration.subsec_nanos() as i32,
    }
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
        let cache = keel_layers::cache::LayerCache::open(image::layer_dir(&options.directory))?;
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
        // Templates: a publication a crash cut short is finished or
        // forgotten (template.rs).
        let mut templates = template::load(&options.directory)?;
        for record in templates.values_mut() {
            if record.state == template::State::Publishing {
                let finished = template::recover(&options.directory, record)?;
                eprintln!(
                    "template {}: a publication the runner did not finish was {}",
                    record.id,
                    if finished {
                        "finished (its layer was in place)"
                    } else {
                        "forgotten (its build machine keeps its disk)"
                    }
                );
            }
        }
        templates.retain(|_, record| record.state != template::State::Publishing);
        for record in templates.values() {
            let layer = template::layer(&options.directory, &record.id);
            if !layer.is_file() {
                eprintln!(
                    "template {}: its layer {} is missing; a machine made from it does not start",
                    record.id,
                    layer.display()
                );
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
                    policy: None,
                    net: None,
                    publishing: None,
                },
            );
        }
        let (events, _) = broadcast::channel(256);
        let egress = Arc::new(egress::Egress {
            ca: ca.signer.clone(),
            upstream: Arc::new(
                cube_netstack::http::Upstream::system()
                    .context("the runner's egress verifies upstreams against the system roots")?,
            ),
            presence: presence::Presence::new(),
            reports: report::Reports::new(),
        });
        let runner = Arc::new(Self {
            options,
            arch,
            floor,
            keel,
            ca,
            egress,
            image,
            cache,
            started_at: Timestamp::now(),
            state: Mutex::new(State {
                version: 1,
                machines,
                deleted,
                templates,
                marks: 0,
            }),
            events,
            ops: tokio::sync::Mutex::new(()),
            stopping: watch::channel(false).0,
        });
        {
            let mut state = runner.state.lock().unwrap();
            // A crash after the publication, before its build machine went.
            let published: Vec<String> = state
                .templates
                .keys()
                .filter(|id| state.machines.contains_key(*id))
                .cloned()
                .collect();
            for id in published {
                runner.remove(&mut state, &id).map_err(|e| {
                    anyhow::anyhow!("template {id}: its build machine: {}", e.message)
                })?;
            }
            runner.collect_templates(&mut state);
            runner.evict(&state);
        }
        Ok(runner)
    }

    /// Trims the layer cache to its limit (masterplan B-7 D2). Nothing is
    /// removed when a machine's layers cannot be read.
    fn evict(&self, state: &State) {
        let limit = self.options.layer_cache_bytes;
        match trim_cache(&self.cache, limit, &self.image.record, state) {
            Ok((eviction, _))
                if eviction.removed.is_empty() && eviction.remaining_bytes <= limit => {}
            Ok((eviction, in_use)) => {
                for diff_id in &eviction.removed {
                    eprintln!(
                        "layer cache: removed {diff_id} (least recently used, no machine uses it)"
                    );
                }
                eprintln!(
                    "layer cache: {} bytes left of a {limit}-byte limit{}",
                    eviction.remaining_bytes,
                    if eviction.remaining_bytes > limit {
                        format!(
                            "; the {in_use} layers the runner's image and its machines use are kept beyond it"
                        )
                    } else {
                        String::new()
                    }
                );
            }
            Err(error) => eprintln!("layer cache: nothing removed: {error:#}"),
        }
    }

    fn qemu_version(&self) -> String {
        format!("{} {}", self.floor.version, self.options.qemu.display())
    }

    /// What the runner says when it starts.
    pub fn describe(&self) -> Vec<String> {
        let cached = self.cache.entries().unwrap_or_default();
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
            format!(
                "layer cache: {} ({} bytes in {} layers; limit {} GiB besides the layers machines use), mkfs.erofs {} ({})",
                self.cache.dir().display(),
                cached.iter().map(|entry| entry.bytes).sum::<u64>(),
                cached.len(),
                self.options.layer_cache_bytes >> 30,
                self.options.mkfs.display(),
                self.options.mkfs_version
            ),
            format!("runner CA: certificate sha256 {}", self.ca.sha256),
            format!(
                "network: each machine {}/{} on its own link to the runner at {} (DNS, HTTP and HTTPS out by its policy; HTTPS intercepted with the runner CA)",
                egress::KEEL.guest,
                egress::KEEL.prefix,
                egress::KEEL.gateway
            ),
            format!(
                "machines: {} ({interrupted} interrupted; at most {} at once)",
                state.machines.len(),
                self.options.max_machines
            ),
            format!(
                "templates: {} in {} ({} bytes; outside the layer cache's limit, removed only by template_delete)",
                state.templates.len(),
                template::dir(&self.options.directory).display(),
                state.templates.values().map(|t| t.bytes).sum::<u64>()
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
                // The path in use to cubed now (U15 (a)); unset while cubed
                // is not connected. Sent with every runner event, never on
                // its own.
                rtt_to_cubed: self.egress.presence.rtt().map(duration),
                // The runner lets guest traffic out itself (B-4).
                egress: true,
            }),
            templates: state
                .templates
                .values()
                .filter_map(|record| {
                    let template = template_proto(record, state)?;
                    Some(proto::TemplateSummary {
                        id: template.id,
                        key: template.key,
                        state: template.state,
                        created_at: template.created_at,
                    })
                })
                .collect(),
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
                source: Some(match &record.template {
                    Some(id) => proto::machine_spec::Source::TemplateId(id.clone()),
                    None => proto::machine_spec::Source::Base(true),
                }),
                size: Some(proto::Size {
                    vcpus: record.size.vcpus,
                    memory_mib: record.size.memory_mib,
                    disk_gib: record.size.disk_gib,
                }),
                boot: None,
                build: record.build,
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

    /// Machine `id`'s setup (runner.proto's `MachineSetup`): its template
    /// and its image's layers topmost first, its boot documents, the
    /// runner's CA, and 32 fresh random bytes.
    fn setup(&self, id: &str) -> proto::MachineSetup {
        let state = self.state.lock().unwrap();
        let entry = state.machines.get(id);
        let documents = entry
            .map(|entry| entry.documents.clone().into_iter().collect())
            .unwrap_or_default();
        let layers = entry
            .and_then(|entry| Some((entry.record.image.as_ref()?, &entry.record.template)))
            .map(|(image, template)| setup_layers(image, template.as_deref()))
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

    /// Writes the runner's image, and above it `template`'s layer, onto
    /// machine `id`'s layer disk (QEMU does not run) and returns what the
    /// record keeps of the image.
    fn write_layers(
        &self,
        id: &str,
        template: Option<&template::TemplateRecord>,
    ) -> Result<MachineImage> {
        let mut layers: Vec<keel_layers::disk::Layer> = self
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
        if let Some(template) = template {
            // The topmost partition, as `setup_layers` names it.
            layers.push(keel_layers::disk::Layer {
                path: template::layer(&self.options.directory, &template.id),
                name: format!("template-{}", template.id),
            });
        }
        keel_layers::disk::write(&self.machine_dir(id), &layers)?;
        Ok(self.image.machine_image())
    }

    /// Tells every watch about a template (and the runner, whose summaries
    /// changed).
    fn tell_template(&self, r#type: watch_event::Type, template: proto::Template, state: &State) {
        let _ = self.events.send(proto::WatchEvent {
            r#type: r#type as i32,
            version: state.version,
            resource: Some(watch_event::Resource::Template(template)),
        });
        let _ = self.events.send(proto::WatchEvent {
            r#type: watch_event::Type::Put as i32,
            version: state.version,
            resource: Some(watch_event::Resource::Runner(self.runner(state))),
        });
    }

    /// Deletes every removing template no machine is made from any more
    /// (p3's `gc_templates`). One that cannot be deleted is tried again the
    /// next time.
    fn collect_templates(&self, state: &mut State) {
        let gone: Vec<String> = state
            .templates
            .values()
            .filter(|t| t.state == template::State::Removing && users(state, &t.id) == 0)
            .map(|t| t.id.clone())
            .collect();
        for id in gone {
            if let Err(error) = template::remove(&self.options.directory, &id) {
                eprintln!("template {id}: not removed yet: {error:#}");
                continue;
            }
            let record = state.templates.remove(&id).unwrap();
            eprintln!(
                "template {id}: removed ({} bytes; deleted, and no machine is made from it)",
                record.bytes
            );
            state.version += 1;
            if let Some(gone) = template_proto(&record, state) {
                self.tell_template(watch_event::Type::Delete, gone, state);
            }
        }
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

    /// The epoch of the machine `reference` names, as it is now.
    fn epoch(state: &State, reference: Option<&proto::Ref>) -> Option<i64> {
        reference
            .and_then(|r| state.machines.get(&r.id))
            .map(|entry| entry.record.fence_epoch)
    }

    /// After a `guest` or `dial` stream was fenced: an epoch it raised is
    /// written down at once, as a mutation's is.
    fn write_raised(
        &self,
        state: &State,
        reference: Option<&proto::Ref>,
        before: Option<i64>,
    ) -> Answer<()> {
        let Some(entry) = reference.and_then(|r| state.machines.get(&r.id)) else {
            return Ok(());
        };
        if before != Some(entry.record.fence_epoch) {
            record::write_json(
                &self.machine_dir(&entry.record.id).join(record::RECORD),
                &entry.record,
            )
            .map_err(internal)?;
        }
        Ok(())
    }

    /// What a `dial` stream reaches: its port (1024 to 65535), the machine
    /// fenced as for `guest` (raising its epoch), and its LAN while it runs.
    fn dial_target(
        state: &mut State,
        header: &proto::DialHeader,
    ) -> Answer<(u16, cube_netstack::lan::Dialer)> {
        let port = dial_port(header.port)?;
        let entry = Self::fenced(state, header.r#ref.as_ref(), header.fence.as_ref())?;
        Ok((port, running_dialer(entry)?))
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
        let from = match &spec.source {
            Some(proto::machine_spec::Source::TemplateId(id)) => Some(id.clone()),
            _ => None,
        };
        if spec.build && from.is_some() {
            return Err(refuse(
                Code::InvalidArgument,
                "build",
                "a build machine is made from the base (source = base), not from a template",
            ));
        }
        let size = Self::size(spec.size.as_ref())?;
        let template = {
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
                    Self::not_publishing(&state, Some(&reference))?;
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
            match &from {
                Some(id) => Some(self.usable_template(&state, id)?),
                None => None,
            }
        };
        if spec.build {
            // B-8 D2 and C2: room for the template disk before it is
            // made, as the agent may fill it.
            let free = (self.options.free_space)(&self.options.directory).map_err(internal)?;
            build_room(free, size.disk_gib)?;
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
        let vdd = dir.join(template::DISK);
        if spec.build && !vdd.exists() {
            let temporary = dir.join("template.raw.tmp");
            let _ = std::fs::remove_file(&temporary);
            qemu::create_template_disk(&temporary, size.disk_gib).map_err(internal)?;
            std::fs::rename(&temporary, &vdd).map_err(internal)?;
        }
        let image = self
            .write_layers(&reference.id, template.as_ref())
            .map_err(internal)?;
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
            build: spec.build,
            template: from,
        };
        event(
            &dir,
            "created",
            &format!(
                "machine type {machine_type}, image {}{}",
                self.image.reference,
                match (&record.template, record.build) {
                    (Some(id), _) => format!(", from template {id}"),
                    (None, true) => format!(
                        ", a build machine with a {} GiB template disk",
                        size.disk_gib
                    ),
                    (None, false) => String::new(),
                }
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
                policy: None,
                net: None,
                publishing: None,
            },
        );
        self.commit(&mut state, &reference.id)
    }

    /// Template `id` for a new machine: ready, and on this runner's image
    /// (B-8 D3: a template is an upper layer over those layers only).
    fn usable_template(&self, state: &State, id: &str) -> Answer<template::TemplateRecord> {
        let record = state
            .templates
            .get(id)
            .filter(|t| t.state != template::State::Publishing)
            .ok_or_else(|| {
                refuse(
                    Code::NotFound,
                    "template",
                    "no such template on this runner",
                )
            })?;
        if record.state == template::State::Removing {
            return Err(refuse(
                Code::FailedPrecondition,
                "template_removing",
                "the template is deleted; it goes when the last machine made from it does",
            ));
        }
        let runner = &self.image.record.manifest.digest;
        if &record.image.manifest != runner {
            return Err(refuse(
                Code::FailedPrecondition,
                "template_image_changed",
                &format!(
                    "the template was built on {} ({}); this runner serves {} ({runner})",
                    record.image.reference, record.image.manifest, self.image.reference
                ),
            ));
        }
        Ok(record.clone())
    }

    /// `template_publish` (masterplan B-8): the build machine's agent writes
    /// its layer to vdd (runner.proto's `DaemonRequest.template_publish`);
    /// then its QEMU is quit, the disk checked and kept as the template, and
    /// the build machine deleted. Asked again, the same template.
    ///
    /// R14b: `ops` is held to begin (checks, fence, the machine's mark, the
    /// request) and to finish (quit and keep), not while the agent works:
    /// other machines change meanwhile; this one refuses every other
    /// mutation at once ([`Self::not_publishing`]). A publication of the
    /// same machine that comes again (cubed asks once more when its own
    /// 600 s ran out a moment before ours) waits for the first to answer.
    async fn publish(self: &Arc<Self>, request: proto::TemplatePublish) -> Answer<proto::Template> {
        if !template::valid_key(&request.key) {
            return Err(refuse(
                Code::InvalidArgument,
                "key",
                &format!(
                    "a template key is 1 to {} printable ASCII characters",
                    template::MAX_KEY_BYTES
                ),
            ));
        }
        if !template::valid_meta(&request.meta) {
            return Err(refuse(
                Code::InvalidArgument,
                "meta",
                &format!(
                    "template meta is at most {} bytes",
                    template::MAX_META_BYTES
                ),
            ));
        }
        let mut stopping = self.stopping.subscribe();
        let (mark, answer) = loop {
            let mut cleared = {
                let _op = self.ops.lock().await;
                if let Some(published) = self.published(&request)? {
                    return Ok(published);
                }
                if *self.stopping.borrow() {
                    return Err(runner_stopping());
                }
                match self.begin_publish(&request)? {
                    Ok(begun) => break begun,
                    Err(cleared) => cleared,
                }
            };
            tokio::select! {
                // Its sender goes with the other publication's mark.
                _ = cleared.changed() => {}
                _ = stopping.wait_for(|stopping| *stopping) => return Err(runner_stopping()),
            }
        };
        let id = mark.id.clone();
        let dir = self.machine_dir(&id);
        // The wait, without `ops`.
        let answer = tokio::select! {
            answer = tokio::time::timeout(PUBLISH_WAIT, answer) => answer.ok(),
            // The runner stops; it stops the machine as it stops every one.
            _ = stopping.wait_for(|stopping| *stopping) => {
                event(&dir, "template_publish not done", "the runner stops");
                return Err(runner_stopping());
            }
        };
        publish_outcome(answer).inspect_err(|error| {
            event(
                &dir,
                "template_publish not done",
                &format!("{} {}", error.reason, error.message),
            )
        })?;
        let _op = self.ops.lock().await;
        // A shutdown that began meanwhile held `ops` until it stopped every
        // machine, this one too: nothing is kept.
        if *self.stopping.borrow() {
            event(&dir, "template_publish not done", "the runner stops");
            return Err(runner_stopping());
        }
        // The layer is on vdd; the machine is used up (its agent refuses
        // everything now), so its QEMU is quit without a shutdown.
        {
            let mut state = self.state.lock().unwrap();
            let entry = state
                .machines
                .get_mut(&id)
                .filter(|entry| mark.holds(entry))
                .ok_or_else(|| internal("the build machine lost its publishing mark"))?;
            entry.record.phase = Phase::Stopping;
            self.commit(&mut state, &id)?;
        }
        event(
            &dir,
            "published",
            "the agent wrote its layer to vdd; QEMU is quit",
        );
        self.quit(&id).await;
        let kept = {
            let mut state = self.state.lock().unwrap();
            self.keep_template(&mut state, &id, &request.key, &request.meta)
        };
        drop(mark);
        kept
    }

    /// Under `ops`: the build machine fenced, marked and asked to publish;
    /// or, when it is marked already, the other publication's `cleared`.
    #[allow(clippy::type_complexity)]
    fn begin_publish(
        self: &Arc<Self>,
        request: &proto::TemplatePublish,
    ) -> Answer<
        std::result::Result<
            (Mark, tokio::sync::oneshot::Receiver<channel::Answer>),
            watch::Receiver<()>,
        >,
    > {
        let (sender, cleared) = watch::channel(());
        let (guest, id, token) = {
            let mut state = self.state.lock().unwrap();
            if let Some(other) = Self::publishing(&state, request.from.as_ref()) {
                return Ok(Err(other.cleared.clone()));
            }
            let before = Self::epoch(&state, request.from.as_ref());
            let fenced = Self::fenced(&mut state, request.from.as_ref(), request.fence.as_ref())
                .and_then(|entry| publishing_guest(entry));
            self.write_raised(&state, request.from.as_ref(), before)?;
            let guest = fenced?;
            state.marks += 1;
            let token = state.marks;
            let id = request.from.clone().unwrap_or_default().id;
            state.machines.get_mut(&id).unwrap().publishing = Some(Publishing { token, cleared });
            (guest, id, token)
        };
        let mark = Mark {
            runner: Arc::clone(self),
            id,
            token,
            _cleared: sender,
        };
        event(
            &self.machine_dir(&mark.id),
            "template_publish",
            "the agent is asked to publish its layer",
        );
        let (_, answer) = guest.request(Op::TemplatePublish(proto::Empty {}))?;
        Ok(Ok((mark, answer)))
    }

    /// The mark of the machine `reference` names (its owner's), if it is
    /// publishing.
    fn publishing<'a>(state: &'a State, reference: Option<&proto::Ref>) -> Option<&'a Publishing> {
        let reference = reference?;
        state
            .machines
            .get(&reference.id)
            .filter(|entry| entry.record.owner == reference.owner)?
            .publishing
            .as_ref()
    }

    /// R14b: a machine that publishes refuses create, start, stop, delete
    /// and discard at once, before its fence, and stays as it is; cubed
    /// gets the refusal (`FAILED_PRECONDITION publishing`) as any other.
    fn not_publishing(state: &State, reference: Option<&proto::Ref>) -> Answer<()> {
        match Self::publishing(state, reference) {
            Some(_) => Err(refuse(
                Code::FailedPrecondition,
                "publishing",
                "the machine is publishing its template; ask again once template_publish answered",
            )),
            None => Ok(()),
        }
    }

    /// A publication that came again: the template it made (fenced against
    /// the build machine's epoch then; another key or meta is refused).
    fn published(&self, request: &proto::TemplatePublish) -> Answer<Option<proto::Template>> {
        let state = self.state.lock().unwrap();
        let Some(record) = request.from.as_ref().and_then(|from| {
            state
                .templates
                .get(&from.id)
                .filter(|t| t.owner == from.owner && t.state != template::State::Publishing)
        }) else {
            return Ok(None);
        };
        if request.fence.as_ref().map_or(0, |fence| fence.epoch) < record.fence_epoch {
            return Err(refuse(
                Code::FailedPrecondition,
                "stale_epoch",
                "a newer epoch has been used for this machine",
            ));
        }
        if record.key != request.key || record.meta != request.meta {
            return Err(refuse(
                Code::AlreadyExists,
                "template",
                "the machine was published as a template with another key or meta",
            ));
        }
        Ok(template_proto(record, &state))
    }

    /// After the agent published and QEMU is gone: the template disk's
    /// superblock is checked, the disk becomes template `id` (template.rs:
    /// `publishing`, moved, cut to size, read-only, `ready`), and the build
    /// machine is deleted.
    fn keep_template(
        &self,
        state: &mut State,
        id: &str,
        key: &str,
        meta: &str,
    ) -> Answer<proto::Template> {
        let entry = state
            .machines
            .get(id)
            .ok_or_else(|| refuse(Code::NotFound, "machine", "no such machine"))?;
        let dir = self.machine_dir(id);
        let disk = dir.join(template::DISK);
        let bytes = template::layer_bytes(&disk).map_err(|error| {
            event(&dir, "template refused", &format!("{error:#}"));
            refuse(
                Code::FailedPrecondition,
                "template_disk",
                &format!("the template disk does not hold a layer: {error:#}"),
            )
        })?;
        let image = entry
            .record
            .image
            .clone()
            .ok_or_else(|| internal("the build machine has no image"))?;
        let boot = entry.record.boot.as_ref();
        let mut record = template::TemplateRecord {
            version: 1,
            id: id.to_owned(),
            owner: entry.record.owner.clone(),
            key: key.to_owned(),
            meta: meta.to_owned(),
            state: template::State::Publishing,
            disk_gib: entry.record.size.disk_gib,
            bytes,
            sha256: String::new(),
            image,
            kernel_sha256: boot.map_or_else(
                || self.keel.kernel_sha256.clone(),
                |b| b.kernel_sha256.clone(),
            ),
            base_sha256: boot
                .map_or_else(|| self.keel.base_sha256.clone(), |b| b.base_sha256.clone()),
            fence_epoch: entry.record.fence_epoch,
            created_at: Timestamp::now(),
        };
        template::adopt(&self.options.directory, &record, &disk).map_err(internal)?;
        // A failure from here on is finished or forgotten when the runner
        // starts again (template::recover).
        template::finish(&self.options.directory, &mut record).map_err(internal)?;
        event(
            &dir,
            "template",
            &format!(
                "published as template {id}: {bytes} bytes, sha256 {}",
                record.sha256
            ),
        );
        eprintln!(
            "template {id}: published ({bytes} bytes, sha256 {}, image {})",
            record.sha256, record.image.reference
        );
        state.templates.insert(id.to_owned(), record.clone());
        state.version += 1;
        let published = template_proto(&record, state).unwrap();
        self.tell_template(watch_event::Type::Put, published, state);
        // The build machine is used up, as p3 releases its build VM.
        self.remove(state, id)?;
        Ok(template_proto(&record, state).unwrap())
    }

    /// `template_delete`: no new machine is made from it (`removing`), and
    /// it goes once no machine that is not deleted is made from it. Gone:
    /// NOT_FOUND.
    fn delete_template(&self, request: proto::TemplateRef) -> Answer<proto::Template> {
        let mut state = self.state.lock().unwrap();
        let Some(record) = state
            .templates
            .get_mut(&request.id)
            .filter(|t| t.state != template::State::Publishing)
        else {
            return Err(refuse(
                Code::NotFound,
                "template",
                "no such template on this runner",
            ));
        };
        if record.state == template::State::Ready {
            record.state = template::State::Removing;
            if let Err(error) = template::write(&self.options.directory, record) {
                record.state = template::State::Ready;
                return Err(internal(error));
            }
            state.version += 1;
            let removing = template_proto(&state.templates[&request.id], &state).unwrap();
            self.tell_template(watch_event::Type::Put, removing, &state);
        }
        let answer = template_proto(&state.templates[&request.id], &state).unwrap();
        self.collect_templates(&mut state);
        // Its image's layers may be free for the cache to trim now.
        self.evict(&state);
        Ok(answer)
    }

    fn list_templates(&self) -> proto::Templates {
        let state = self.state.lock().unwrap();
        proto::Templates {
            items: state
                .templates
                .values()
                .filter_map(|record| template_proto(record, &state))
                .collect(),
        }
    }

    async fn start(self: &Arc<Self>, request: proto::MachineStart) -> Answer<proto::Machine> {
        let documents = boot_documents(request.boot.as_ref())?;
        let policy = policy::Policy::from_proto(request.policy.as_ref())?;
        let (id, record) = {
            let mut state = self.state.lock().unwrap();
            Self::not_publishing(&state, request.r#ref.as_ref())?;
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
                    // A new start replaces the policy of the running QEMU.
                    if let Some(net) = &entry.net {
                        net.gate.replace(policy.clone());
                    }
                    entry.policy = Some(policy);
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
                    entry.record.image = Some(self.write_layers(&id, None).map_err(internal)?);
                }
            }
            let entry = state.machines.get_mut(&id).unwrap();
            entry.documents = documents;
            entry.policy = Some(policy);
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
            build: record.build,
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
        // The network of this QEMU process: a new socket pair and LAN.
        let gate = {
            let state = self.state.lock().unwrap();
            let entry = &state.machines[id];
            // Credential streams carry the epoch the runner holds now.
            let runner = Arc::downgrade(self);
            let machine = id.to_owned();
            egress::Gate::new(
                Arc::clone(&self.egress),
                proto::Ref {
                    owner: entry.record.owner.clone(),
                    id: entry.record.id.clone(),
                },
                entry
                    .policy
                    .clone()
                    .unwrap_or_else(policy::Policy::deny_all),
                Arc::new(move || {
                    runner.upgrade().map_or(0, |runner| {
                        runner
                            .state
                            .lock()
                            .unwrap()
                            .machines
                            .get(&machine)
                            .map_or(0, |entry| entry.record.fence_epoch)
                    })
                }),
            )
        };
        let (net, theirs) = egress::Net::open(gate, id)?;
        let mut command = tokio::process::Command::new(&self.options.qemu);
        command
            .args(&args)
            .current_dir(dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(log)
            // Its own process group: a terminal's Ctrl-C reaches the runner,
            // which quits its machines itself.
            .process_group(0);
        let fd = std::os::fd::AsRawFd::as_raw_fd(&theirs);
        // SAFETY: `inherit` makes only async-signal-safe calls.
        unsafe {
            command.pre_exec(move || egress::inherit(fd));
        }
        let spawned = command.spawn();
        // QEMU holds its own copy now (or failed to start).
        drop(theirs);
        let mut child =
            spawned.with_context(|| format!("start {}", self.options.qemu.display()))?;
        let pid = child.id().context("QEMU exited at once")?;
        let (exited_tx, exited) = watch::channel(false);
        {
            let mut state = self.state.lock().unwrap();
            let entry = state.machines.get_mut(id).unwrap();
            entry.live = Some(Live { pid, exited });
            entry.net = Some(net);
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
        // The LAN goes with its QEMU: every flow is reset.
        entry.net = None;
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
            Self::not_publishing(&state, request.r#ref.as_ref())?;
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
        Self::not_publishing(&state, request.r#ref.as_ref())?;
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
        self.egress.reports.forget(id);
        let machine = Self::machine(&entry.record, None, state.version, Timestamp::now());
        self.tell(watch_event::Type::Delete, machine.clone(), state);
        // Its template may have lost its last user.
        self.collect_templates(state);
        self.evict(state);
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
            // Read only: no `ops` lock, so it neither waits for a mutation
            // nor holds one up (diagnose.rs).
            Some(Verb::MachineDiagnose(request)) => self.diagnose(request).await.map(R::Diagnosis),
            // Takes `ops` itself, not while its agent works (R14b).
            Some(Verb::TemplatePublish(request)) => self.publish(request).await.map(R::Template),
            Some(Verb::TemplateList(_)) => Ok(R::Templates(self.list_templates())),
            Some(Verb::TemplateDelete(request)) => {
                let _op = self.ops.lock().await;
                self.delete_template(request).map(R::Template)
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
        self.stopping.send_replace(true);
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

/// Free space a build machine's template disk needs besides its size (B-8
/// C2, approved: 1 × the disk + 2 GiB).
const BUILD_RESERVE: u64 = 2 << 30;

/// The room check before a build machine's template disk is made (B-8 D2,
/// C2): the disk's size + 2 GiB, since the agent may fill it and the
/// template is that same file, renamed, not a copy; the templates already
/// kept are on the same disk.
fn build_room(free: u64, disk_gib: u32) -> Answer<()> {
    let needed = (u64::from(disk_gib) << 30).saturating_add(BUILD_RESERVE);
    if free < needed {
        return Err(refuse(
            Code::ResourceExhausted,
            "disk_space",
            &format!(
                "a build machine's {disk_gib} GiB template disk needs its size + 2 GiB = {needed} bytes free; the runner's directory has {free}"
            ),
        ));
    }
    Ok(())
}

/// `MachineSetup.layers` of a machine on `image` (partition N the Nth
/// layer, bottom first), made from `template` (the partition above them):
/// topmost first.
fn setup_layers(image: &MachineImage, template: Option<&str>) -> Vec<proto::Layer> {
    let template = template.map(|id| proto::Layer {
        partition: image.diff_ids.len() as u32 + 1,
        source: Some(proto::layer::Source::TemplateId(id.to_owned())),
    });
    template
        .into_iter()
        .chain(
            image
                .diff_ids
                .iter()
                .enumerate()
                .rev()
                .map(|(i, diff_id)| proto::Layer {
                    partition: i as u32 + 1,
                    source: Some(proto::layer::Source::DiffId(diff_id.clone())),
                }),
        )
        .collect()
}

/// How many machines that are not deleted (retained ones too) are made
/// from template `id`.
fn users(state: &State, id: &str) -> u32 {
    state
        .machines
        .values()
        .filter(|entry| entry.record.template.as_deref() == Some(id))
        .count() as u32
}

/// A template as cubed sees it; None while it is being published.
fn template_proto(record: &template::TemplateRecord, state: &State) -> Option<proto::Template> {
    let phase = match record.state {
        template::State::Publishing => return None,
        template::State::Ready => proto::template::State::Ready,
        template::State::Removing => proto::template::State::Removing,
    };
    Some(proto::Template {
        id: record.id.clone(),
        key: record.key.clone(),
        meta: record.meta.clone(),
        state: phase as i32,
        disk_gib: record.disk_gib,
        bytes: record.bytes,
        users: users(state, &record.id),
        created_at: Some(record.created_at),
    })
}

/// The layers the cache must keep: the runner's image's, those of every
/// machine that is not deleted, retained ones too, and those of the image
/// every template lies on (B-8 D2: a template keeps them while it exists).
fn layers_in_use(
    image: &image::ImageRecord,
    state: &State,
) -> Result<HashSet<keel_layers::DiffId>> {
    let machines = state
        .machines
        .values()
        .filter_map(|entry| entry.record.image.as_ref())
        .flat_map(|image| image.diff_ids.iter());
    let templates = state
        .templates
        .values()
        .flat_map(|template| template.image.diff_ids.iter());
    let runner = image.layers.iter().map(|layer| &layer.diff_id);
    runner
        .chain(machines)
        .chain(templates)
        .map(|diff_id| {
            diff_id
                .parse()
                .with_context(|| format!("a machine's layer {diff_id:?}"))
        })
        .collect()
}

/// Removes least recently used layers no one keeps until the cache holds at
/// most `limit` bytes; also returns how many layers are kept. Removes
/// nothing when a layer in use cannot be read.
fn trim_cache(
    cache: &keel_layers::cache::LayerCache,
    limit: u64,
    image: &image::ImageRecord,
    state: &State,
) -> Result<(keel_layers::cache::Eviction, usize)> {
    let in_use = layers_in_use(image, state)?;
    Ok((cache.evict(limit, &in_use)?, in_use.len()))
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

/// The channel of a machine that may publish now: a build machine (B-8
/// D1) that runs.
fn publishing_guest(entry: &Entry) -> Answer<Arc<channel::Guest>> {
    if !entry.record.build {
        return Err(refuse(
            Code::FailedPrecondition,
            "not_build",
            "only a build machine (MachineSpec.build) publishes a template",
        ));
    }
    match (&entry.guest, entry.record.phase) {
        (Some(guest), Phase::Running) => Ok(Arc::clone(guest)),
        _ => Err(not_running(entry)),
    }
}

/// A publication the runner's stop cut short: whether the agent finished
/// is not known, and nothing was kept.
fn runner_stopping() -> proto::Error {
    proto::Error {
        completion_unknown: true,
        ..refuse(Code::Unavailable, "runner_stopping", "the runner stops")
    }
}

/// The agent's answer to `template_publish`: only done goes on to keep the
/// disk. Its refusal (busy, not ready, a seal that failed) is cubed's
/// answer, the machine as it was; no answer is `completion_unknown`.
fn publish_outcome(
    answer: Option<std::result::Result<channel::Answer, tokio::sync::oneshot::error::RecvError>>,
) -> Answer<()> {
    let unknown = |reason: &str, message: &str| proto::Error {
        completion_unknown: true,
        ..refuse(Code::Unavailable, reason, message)
    };
    match answer {
        Some(Ok(Ok(AnswerKind::Done(_)))) => Ok(()),
        Some(Ok(Ok(AnswerKind::Error(error)))) => Err(error),
        Some(Ok(Ok(AnswerKind::Guest(_)))) => Err(refuse(
            Code::Internal,
            "agent",
            "the agent answered template_publish with guest bytes",
        )),
        Some(Ok(Err(error))) => Err(unknown(&error.reason, &error.message)),
        Some(Err(_)) => Err(unknown(
            "guest_disconnected",
            "the machine's channel ended during the publication",
        )),
        None => Err(unknown(
            "publish_timeout",
            &format!(
                "the agent did not publish within {} s; ask again",
                PUBLISH_WAIT.as_secs()
            ),
        )),
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
/// MAX_BOOT_BYTES together. `Boot.mac` is ignored: every keel machine has
/// the same fixed MAC and address on its own link (egress.rs).
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

/// The image `reference` names, as the pull at start left it in
/// `directory`: its record and every layer file, for this platform.
fn load_image(directory: &Path, reference: &image::Reference) -> Result<Image> {
    let store = image::Store::open(directory)?;
    let path = store.record_path(&reference.digest);
    let pull = "berth vm pulls it when it starts";
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

    /// cubed is here while the connection lives (the egress lease), and
    /// the connection carries the refusal reports.
    fn attach(self: &Arc<Self>, connection: &iroh::endpoint::Connection) -> Box<dyn Send> {
        struct Attached {
            _present: presence::Attached,
            writer: tokio::task::JoinHandle<()>,
        }
        impl Drop for Attached {
            fn drop(&mut self) {
                self.writer.abort();
            }
        }
        Box::new(Attached {
            _present: self.egress.presence.attach(Some(connection.clone())),
            writer: tokio::spawn(Arc::clone(&self.egress.reports).run(connection.clone())),
        })
    }

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
            resources.extend(
                state
                    .templates
                    .values()
                    .filter_map(|record| template_proto(record, &state))
                    .map(watch_event::Resource::Template),
            );
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
            let before = Self::epoch(&state, header.r#ref.as_ref());
            let fenced = Self::fenced(&mut state, header.r#ref.as_ref(), header.fence.as_ref())
                .map(|entry| match (&entry.guest, entry.record.phase) {
                    (Some(guest), Phase::Running) => Ok(Arc::clone(guest)),
                    _ => Err(not_running(entry)),
                });
            self.write_raised(&state, header.r#ref.as_ref(), before)?;
            fenced??
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
    async fn dial(
        self: Arc<Self>,
        header: proto::DialHeader,
    ) -> Answer<cube_netstack::lan::FlowStream> {
        let (port, dialer) = {
            let mut state = self.state.lock().unwrap();
            let before = Self::epoch(&state, header.r#ref.as_ref());
            let target = Self::dial_target(&mut state, &header);
            self.write_raised(&state, header.r#ref.as_ref(), before)?;
            target?
        };
        dial_into(dialer, port).await
    }
}

/// TCP to `port` of the machine whose LAN `dialer` is. The LAN gives up
/// after its own 10 s (`LanLimits::dial`), as p3's gateway does.
async fn dial_into(
    dialer: cube_netstack::lan::Dialer,
    port: u16,
) -> Answer<cube_netstack::lan::FlowStream> {
    dialer
        .dial(port)
        .await
        .map_err(|error| refuse(Code::Unavailable, "dial_failed", &format!("{error:#}")))
}

/// The ports cubed may dial in a machine (V9): 1024 to 65535. Unlike p3's
/// gateway not 22, which was for its SSH; keel runs no sshd.
fn dial_port(port: u32) -> Answer<u16> {
    match u16::try_from(port) {
        Ok(port) if port >= 1024 => Ok(port),
        _ => Err(refuse(
            Code::PermissionDenied,
            "port",
            &format!("dialling port {port} is not allowed; only 1024 to 65535"),
        )),
    }
}

fn not_running(entry: &Entry) -> proto::Error {
    refuse(
        Code::Unavailable,
        "not_running",
        &format!("the machine is {}", entry.record.phase.name()),
    )
}

/// The LAN of a running machine, to dial into it.
fn running_dialer(entry: &Entry) -> Answer<cube_netstack::lan::Dialer> {
    match (&entry.net, entry.record.phase) {
        (Some(net), Phase::Running) => Ok(net.dialer()),
        _ => Err(not_running(entry)),
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

#[cfg(test)]
mod dial_tests {
    use super::*;

    fn one_machine(phase: Phase) -> State {
        let record = MachineRecord {
            version: 1,
            owner: "thread-1".into(),
            id: "0123456789abcdef".into(),
            fence_epoch: 7,
            phase,
            size: DEFAULT_SIZE,
            machine_type: "pc-q35-11.1".into(),
            created_with: "11.1.2 /q".into(),
            created_at: Timestamp {
                seconds: 1,
                nanos: 0,
            },
            interrupted: None,
            error: String::new(),
            boot: None,
            image: None,
            stopped: None,
            build: false,
            template: None,
        };
        let entry = Entry {
            record,
            live: None,
            version: 1,
            updated: Timestamp {
                seconds: 1,
                nanos: 0,
            },
            guest: None,
            info: None,
            documents: Default::default(),
            sessions: Default::default(),
            policy: None,
            net: None,
            publishing: None,
        };
        State {
            version: 1,
            machines: BTreeMap::from([("0123456789abcdef".to_string(), entry)]),
            deleted: BTreeMap::new(),
            templates: BTreeMap::new(),
            marks: 0,
        }
    }

    fn reference(owner: &str) -> proto::Ref {
        proto::Ref {
            owner: owner.into(),
            id: "0123456789abcdef".into(),
        }
    }

    fn reason(error: proto::Error) -> (Code, String) {
        (Code::try_from(error.code).unwrap(), error.reason)
    }

    #[test]
    fn only_ports_1024_to_65535_are_dialled() {
        for port in [1024, 3000, 8080, 65535] {
            assert_eq!(dial_port(port).unwrap(), port as u16);
        }
        // 22 too: p3's gateway let cubed reach sshd there; keel has none.
        for port in [0, 22, 80, 443, 1023, 65536, u32::MAX] {
            let refused = reason(dial_port(port).unwrap_err());
            assert_eq!(refused, (Code::PermissionDenied, "port".into()), "{port}");
        }
    }

    fn header(owner: &str, epoch: i64, port: u32) -> proto::DialHeader {
        proto::DialHeader {
            r#ref: Some(reference(owner)),
            fence: Some(proto::Fence { epoch }),
            port,
        }
    }

    #[test]
    fn a_dial_is_fenced_owned_and_needs_a_running_machine() {
        let refused = |state: &mut State, header: proto::DialHeader| {
            reason(VmRunner::dial_target(state, &header).err().unwrap())
        };
        let mut state = one_machine(Phase::Running);
        assert_eq!(
            refused(&mut state, header("thread-1", 6, 8080)),
            (Code::FailedPrecondition, "stale_epoch".into())
        );
        // The port first: a refused port leaves the epoch as it was.
        assert_eq!(
            refused(&mut state, header("thread-1", 9, 80)),
            (Code::PermissionDenied, "port".into())
        );
        assert_eq!(state.machines["0123456789abcdef"].record.fence_epoch, 7);
        assert_eq!(
            refused(&mut state, header("thread-2", 7, 8080)),
            (Code::NotFound, "machine".into())
        );
        // Running, but its network is gone (as while QEMU is being quit);
        // the newer epoch is taken as guest takes it.
        assert_eq!(
            refused(&mut state, header("thread-1", 8, 8080)),
            (Code::Unavailable, "not_running".into())
        );
        assert_eq!(state.machines["0123456789abcdef"].record.fence_epoch, 8);
        for phase in [
            Phase::Stopped,
            Phase::Starting,
            Phase::Stopping,
            Phase::Retained,
        ] {
            let mut state = one_machine(phase);
            let refused = VmRunner::dial_target(&mut state, &header("thread-1", 7, 8080))
                .err()
                .unwrap();
            assert_eq!(
                reason(refused.clone()),
                (Code::Unavailable, "not_running".into())
            );
            assert!(
                refused.message.contains(phase.name()),
                "{}",
                refused.message
            );
        }
    }
}

#[cfg(test)]
mod cache_tests {
    use super::*;
    use keel_layers::{DiffId, cache::LayerCache};
    use std::{fs::File, time::SystemTime};

    fn id(n: u8) -> DiffId {
        DiffId::from_bytes([n; 32])
    }

    /// A 100-byte layer last used `age_seconds` ago.
    fn put(cache: &LayerCache, n: u8, age_seconds: u64) {
        let path = cache
            .publish(&id(n), |out| Ok(std::fs::write(out, [n; 100])?))
            .unwrap();
        File::open(path)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(age_seconds))
            .unwrap();
    }

    fn left(cache: &LayerCache) -> Vec<DiffId> {
        let mut left: Vec<DiffId> = cache
            .entries()
            .unwrap()
            .into_iter()
            .map(|e| e.diff_id)
            .collect();
        left.sort();
        left
    }

    fn runner_image(layers: &[u8]) -> image::ImageRecord {
        let descriptor = image::Descriptor {
            media_type: "m".into(),
            digest: "sha256:00".into(),
            size: 1,
        };
        image::ImageRecord {
            version: 1,
            reference: "registry.test/o/n@sha256:00".into(),
            registry: "registry.test".into(),
            repository: "o/n".into(),
            digest: "sha256:00".into(),
            platform: "linux/amd64".into(),
            manifest: descriptor.clone(),
            config: descriptor.clone(),
            env: Vec::new(),
            layers: layers
                .iter()
                .map(|n| image::LayerRecord {
                    diff_id: id(*n).to_string(),
                    blob: descriptor.clone(),
                    file: format!("layers/1/{}.erofs", id(*n)),
                    erofs_bytes: 100,
                    tar_bytes: None,
                })
                .collect(),
            layer_format: 1,
            mkfs: "/m".into(),
            mkfs_version: "mkfs.erofs 1".into(),
            resolved_at: 0,
        }
    }

    fn machine(n: u8, phase: Phase, diff_ids: Option<Vec<String>>) -> MachineRecord {
        MachineRecord {
            version: 1,
            owner: "thread-1".into(),
            id: format!("{n:016x}"),
            fence_epoch: 1,
            phase,
            size: DEFAULT_SIZE,
            machine_type: "pc-q35-11.1".into(),
            created_with: "11.1.2 /q".into(),
            created_at: Timestamp::now(),
            interrupted: None,
            error: String::new(),
            boot: None,
            image: diff_ids.map(|diff_ids| MachineImage {
                reference: "registry.test/o/old@sha256:11".into(),
                manifest: "sha256:11".into(),
                diff_ids,
            }),
            stopped: None,
            build: false,
            template: None,
        }
    }

    fn state(machines: Vec<MachineRecord>, deleted: Vec<MachineRecord>) -> State {
        State {
            version: 1,
            machines: machines
                .into_iter()
                .map(|record| {
                    let entry = Entry {
                        record,
                        live: None,
                        version: 1,
                        updated: Timestamp::now(),
                        guest: None,
                        info: None,
                        documents: Default::default(),
                        sessions: Default::default(),
                        policy: None,
                        net: None,
                        publishing: None,
                    };
                    (entry.record.id.clone(), entry)
                })
                .collect(),
            deleted: deleted.into_iter().map(|r| (r.id.clone(), r)).collect(),
            templates: BTreeMap::new(),
            marks: 0,
        }
    }

    fn ids(ns: &[u8]) -> Vec<String> {
        ns.iter().map(|n| id(*n).to_string()).collect()
    }

    #[test]
    fn the_cache_keeps_the_runners_image_and_every_machine_not_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let cache = LayerCache::open(dir.path()).unwrap();
        // The oldest layers are the ones in use, so LRU alone would take them.
        for (n, age) in [(1, 900), (2, 800), (3, 700), (4, 600), (5, 500), (6, 400)] {
            put(&cache, n, age);
        }
        let state = state(
            vec![
                machine(1, Phase::Stopped, Some(ids(&[2]))),
                // Deleted with retain: its disk is kept, so are its layers.
                machine(2, Phase::Retained, Some(ids(&[3, 4]))),
                // A B-1 machine without an image keeps nothing of its own.
                machine(3, Phase::Stopped, None),
            ],
            vec![machine(4, Phase::Deleted, Some(ids(&[5])))],
        );
        let (eviction, kept) = trim_cache(&cache, 0, &runner_image(&[1]), &state).unwrap();
        assert_eq!(eviction.removed, vec![id(5), id(6)]);
        assert_eq!(
            eviction.remaining_bytes, 400,
            "in use beyond a 0-byte limit"
        );
        assert_eq!(kept, 4);
        assert_eq!(left(&cache), vec![id(1), id(2), id(3), id(4)]);
    }

    #[test]
    fn unused_layers_go_least_recently_used_first_and_a_retained_machines_once_it_goes() {
        let dir = tempfile::tempdir().unwrap();
        let cache = LayerCache::open(dir.path()).unwrap();
        put(&cache, 1, 100); // the runner's image
        put(&cache, 2, 400); // the retained machine's, oldest
        put(&cache, 3, 300);
        put(&cache, 4, 200);
        let image = runner_image(&[1]);
        let retained = machine(2, Phase::Retained, Some(ids(&[2])));
        let mut kept = state(vec![retained.clone()], Vec::new());
        // Under the limit: nothing goes.
        let (eviction, _) = trim_cache(&cache, 400, &image, &kept).unwrap();
        assert!(eviction.removed.is_empty());
        // Over it: the oldest layer no one uses (3), not the older retained one.
        let (eviction, _) = trim_cache(&cache, 300, &image, &kept).unwrap();
        assert_eq!(eviction.removed, vec![id(3)]);
        assert_eq!(left(&cache), vec![id(1), id(2), id(4)]);
        // Over again, with the machine still retained: only 4 can go.
        let (eviction, _) = trim_cache(&cache, 100, &image, &kept).unwrap();
        assert_eq!(eviction.removed, vec![id(4)]);
        assert_eq!(left(&cache), vec![id(1), id(2)]);
        // Discarded: its layer goes; the runner's stays.
        kept.machines.clear();
        kept.deleted.insert(retained.id.clone(), retained);
        let (eviction, _) = trim_cache(&cache, 100, &image, &kept).unwrap();
        assert_eq!(eviction.removed, vec![id(2)]);
        assert_eq!(left(&cache), vec![id(1)]);
    }

    #[test]
    fn nothing_is_removed_when_a_machines_layers_cannot_be_read() {
        let dir = tempfile::tempdir().unwrap();
        let cache = LayerCache::open(dir.path()).unwrap();
        put(&cache, 1, 200);
        put(&cache, 2, 100);
        let unreadable = state(
            vec![machine(1, Phase::Retained, Some(vec!["sha256:zz".into()]))],
            Vec::new(),
        );
        let error = trim_cache(&cache, 0, &runner_image(&[]), &unreadable).unwrap_err();
        assert!(format!("{error:#}").contains("sha256:zz"), "{error:#}");
        assert_eq!(left(&cache), vec![id(1), id(2)]);
    }
}
