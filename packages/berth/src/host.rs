//! `berth host`: a runner whose machines are directories on the host it
//! runs on. A guest call runs `cube-guest host MACHINE call OP` as a child
//! process of the user who started the runner, with that user's environment
//! and logins. There is no VM, no sandbox and no egress policy: it exists to
//! develop and debug real runners from a cube thread.
//!
//! Each machine is `DIRECTORY/<id>` with its record in `machine.json`.
//! Nothing here ever deletes a directory: deleting a machine marks it
//! retained and keeps everything in it.
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::broadcast,
};

use cube_runner_protocol::{
    MAX_FRAME_BYTES, PROTOCOL, Timestamp,
    proto::{self, Code, call::Verb, call_result, machine_status::Phase, watch_event},
    refuse,
};

use crate::serve::{self, Service, unimplemented};

/// The guest helper this runner ships; written into a machine that has
/// none. cubed replaces it with its own (`install`) when they differ.
pub const GUEST_HELPER: &str = include_str!("../../server/guest/cube-guest.py");
/// What one guest request may carry (a header line and a write's body).
const MAX_GUEST_REQUEST: u64 = 8 * 1024 * 1024;
/// What one guest answer may carry.
const MAX_GUEST_ANSWER: u64 = 4 * 1024 * 1024;
const CAPABILITIES: [&str; 9] = [
    "runner.get",
    "machine.create",
    "machine.start",
    "machine.stop",
    "machine.delete",
    "machine.get",
    "machine.list",
    "watch",
    "guest",
];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MachineFile {
    version: u32,
    owner: String,
    id: String,
    fence_epoch: i64,
    retained: bool,
}

struct Entry {
    file: MachineFile,
    guest: Option<proto::GuestInfo>,
    version: i64,
    updated: Timestamp,
}

struct State {
    version: i64,
    machines: BTreeMap<String, Entry>,
}

pub struct HostOptions {
    pub directory: PathBuf,
    pub node_id: String,
    pub python: String,
    pub network: String,
    pub max_machines: u32,
    pub labels: BTreeMap<String, String>,
}

pub struct HostRunner {
    options: HostOptions,
    boot_id: String,
    started_at: Timestamp,
    state: Mutex<State>,
    events: broadcast::Sender<proto::WatchEvent>,
}

pub(crate) fn valid_owner(owner: &str) -> bool {
    (1..=128).contains(&owner.len())
        && owner
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
pub(crate) fn valid_id(id: &str) -> bool {
    id.len() == 16 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}
pub(crate) fn valid_op(op: &str) -> bool {
    (1..=32).contains(&op.len()) && op.bytes().all(|b| b.is_ascii_lowercase())
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(value)?)?;
    std::fs::File::open(&temporary)?.sync_all()?;
    std::fs::rename(&temporary, path)?;
    Ok(())
}

impl HostRunner {
    /// Loads every machine directory under `options.directory`.
    pub fn open(options: HostOptions) -> Result<Arc<Self>> {
        let mut machines = BTreeMap::new();
        for entry in std::fs::read_dir(&options.directory)? {
            let path = entry?.path();
            let record = path.join("machine.json");
            if !record.is_file() {
                continue;
            }
            let file: MachineFile = serde_json::from_slice(&std::fs::read(&record)?)
                .with_context(|| format!("read {}", record.display()))?;
            ensure!(
                file.version == 1 && valid_id(&file.id) && path.ends_with(&file.id),
                "{} is not a machine record of this runner",
                record.display()
            );
            machines.insert(
                file.id.clone(),
                Entry {
                    file,
                    guest: None,
                    version: 1,
                    updated: Timestamp::now(),
                },
            );
        }
        let boot_id = {
            let mut bytes = [0u8; 16];
            getrandom(&mut bytes);
            bytes.iter().map(|b| format!("{b:02x}")).collect()
        };
        let (events, _) = broadcast::channel(256);
        let runner = Arc::new(Self {
            options,
            boot_id,
            started_at: Timestamp::now(),
            state: Mutex::new(State {
                version: 1,
                machines,
            }),
            events,
        });
        for id in runner.state.lock().unwrap().machines.keys() {
            runner.ensure_helper(id)?;
        }
        Ok(runner)
    }

    pub fn machine_count(&self) -> usize {
        self.state.lock().unwrap().machines.len()
    }

    /// Asks every live machine's guest how it is, so watch reports it.
    pub fn probe_all(self: &Arc<Self>) {
        let ids: Vec<String> = self
            .state
            .lock()
            .unwrap()
            .machines
            .values()
            .filter(|entry| !entry.file.retained)
            .map(|entry| entry.file.id.clone())
            .collect();
        for id in ids {
            tokio::spawn(self.clone().probe(id));
        }
    }

    fn machine_dir(&self, id: &str) -> PathBuf {
        self.options.directory.join(id)
    }

    fn ensure_helper(&self, id: &str) -> Result<()> {
        use std::os::unix::fs::PermissionsExt;
        let bin = self.machine_dir(id).join("bin");
        let helper = bin.join("cube-guest");
        if !helper.exists() {
            std::fs::create_dir_all(&bin)?;
            let temporary = bin.join(".cube-guest.tmp");
            std::fs::write(&temporary, GUEST_HELPER)?;
            std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o755))?;
            std::fs::rename(&temporary, &helper)?;
        }
        Ok(())
    }

    fn runner(&self, state: &State) -> proto::Runner {
        let active = state
            .machines
            .values()
            .filter(|entry| !entry.file.retained)
            .count() as u32;
        let retained = state.machines.len() as u32 - active;
        proto::Runner {
            node_id: self.options.node_id.clone(),
            software_version: crate::SOFTWARE_VERSION.into(),
            kind: proto::runner::Kind::Host as i32,
            platform: Some(proto::Platform {
                os: std::env::consts::OS.into(),
                arch: std::env::consts::ARCH.into(),
                accelerator: "none".into(),
                host_name: host_name(),
                ..Default::default()
            }),
            limits: Some(proto::Limits {
                max_machines: self.options.max_machines,
                max_frame_bytes: MAX_FRAME_BYTES as u32,
                ..Default::default()
            }),
            capacity: Some(proto::Capacity {
                machines_active: active,
                machines_running: active,
                slots_free: self.options.max_machines.saturating_sub(active),
                host_cpus: std::thread::available_parallelism().map_or(0, |n| n.get() as u32),
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

    fn machine(&self, entry: &Entry) -> proto::Machine {
        proto::Machine {
            r#ref: Some(proto::Ref {
                owner: entry.file.owner.clone(),
                id: entry.file.id.clone(),
            }),
            spec: Some(proto::MachineSpec {
                source: Some(proto::machine_spec::Source::Base(true)),
                size: None,
                boot: None,
                build: false,
            }),
            status: Some(proto::MachineStatus {
                phase: if entry.file.retained {
                    Phase::Retained
                } else {
                    Phase::Running
                } as i32,
                conditions: vec![],
                boot_id: self.boot_id.clone(),
                disk_bytes: 0,
                error: String::new(),
                started_at: Some(self.started_at),
                guest: entry.guest.clone(),
            }),
            meta: Some(proto::Meta {
                version: entry.version,
                updated: Some(entry.updated),
            }),
            fence_epoch: entry.file.fence_epoch,
        }
    }

    /// Records a change of `id` and tells every watch.
    fn changed(&self, state: &mut State, id: &str) -> proto::Machine {
        state.version += 1;
        let version = state.version;
        let entry = state.machines.get_mut(id).unwrap();
        entry.version = version;
        entry.updated = Timestamp::now();
        let machine = self.machine(state.machines.get(id).unwrap());
        let _ = self.events.send(proto::WatchEvent {
            r#type: watch_event::Type::Put as i32,
            version,
            resource: Some(watch_event::Resource::Machine(machine.clone())),
        });
        let _ = self.events.send(proto::WatchEvent {
            r#type: watch_event::Type::Put as i32,
            version,
            resource: Some(watch_event::Resource::Runner(self.runner(state))),
        });
        machine
    }

    pub fn hello(
        &self,
        hello: &proto::Hello,
    ) -> std::result::Result<proto::HelloAnswer, proto::Error> {
        if hello.protocol != PROTOCOL {
            return Err(refuse(
                Code::FailedPrecondition,
                "incompatible_protocol",
                &format!(
                    "berth host speaks runner protocol {PROTOCOL}, not {}",
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

    /// Checks `reference` and `fence` against the record and raises the
    /// record's epoch to `fence`.
    fn fenced<'a>(
        state: &'a mut State,
        reference: Option<&proto::Ref>,
        fence: Option<&proto::Fence>,
    ) -> std::result::Result<&'a mut Entry, proto::Error> {
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
        let entry = state
            .machines
            .get_mut(&reference.id)
            .filter(|entry| entry.file.owner == reference.owner)
            .ok_or_else(|| refuse(Code::NotFound, "machine", "no such machine"))?;
        if epoch < entry.file.fence_epoch {
            return Err(refuse(
                Code::FailedPrecondition,
                "stale_epoch",
                "a newer epoch has been used for this machine",
            ));
        }
        entry.file.fence_epoch = epoch;
        Ok(entry)
    }

    fn save(&self, entry: &Entry) -> std::result::Result<(), proto::Error> {
        write_json(
            &self.machine_dir(&entry.file.id).join("machine.json"),
            &entry.file,
        )
        .map_err(|error| refuse(Code::Internal, "io", &error.to_string()))
    }

    fn create(
        self: &Arc<Self>,
        request: proto::MachineCreate,
    ) -> std::result::Result<proto::Machine, proto::Error> {
        let reference = request.r#ref.clone().unwrap_or_default();
        if !valid_owner(&reference.owner) || !valid_id(&reference.id) {
            return Err(refuse(
                Code::InvalidArgument,
                "ref",
                "owner is 1-128 of [A-Za-z0-9_-], id is 16 hex characters",
            ));
        }
        if let Some(proto::machine_spec::Source::TemplateId(_)) =
            request.spec.as_ref().and_then(|spec| spec.source.as_ref())
        {
            return Err(refuse(
                Code::Unimplemented,
                "templates",
                "a host runner has no templates",
            ));
        }
        let mut state = self.state.lock().unwrap();
        if let Some(existing) = state.machines.get(&reference.id) {
            if existing.file.owner != reference.owner {
                return Err(refuse(
                    Code::AlreadyExists,
                    "id",
                    "this machine id belongs to another owner",
                ));
            }
            let entry = Self::fenced(&mut state, Some(&reference), request.fence.as_ref())?;
            self.save(entry)?;
            return Ok(self.machine(state.machines.get(&reference.id).unwrap()));
        }
        let active = state
            .machines
            .values()
            .filter(|entry| !entry.file.retained)
            .count() as u32;
        if active >= self.options.max_machines {
            return Err(refuse(
                Code::ResourceExhausted,
                "capacity",
                "the runner hosts as many machines as it may",
            ));
        }
        let epoch = request.fence.as_ref().map_or(0, |fence| fence.epoch);
        if epoch < 1 {
            return Err(refuse(
                Code::InvalidArgument,
                "fence",
                "a fence epoch of at least 1 is required",
            ));
        }
        let entry = Entry {
            file: MachineFile {
                version: 1,
                owner: reference.owner.clone(),
                id: reference.id.clone(),
                fence_epoch: epoch,
                retained: false,
            },
            guest: None,
            version: 0,
            updated: Timestamp::now(),
        };
        std::fs::create_dir_all(self.machine_dir(&reference.id))
            .and_then(|_| {
                self.ensure_helper(&reference.id)
                    .map_err(std::io::Error::other)
            })
            .map_err(|error| refuse(Code::Internal, "io", &error.to_string()))?;
        self.save(&entry)?;
        state.machines.insert(reference.id.clone(), entry);
        let machine = self.changed(&mut state, &reference.id);
        drop(state);
        tokio::spawn(self.clone().probe(reference.id));
        Ok(machine)
    }

    /// `start` and `stop` change nothing on a host: a machine is a directory
    /// and is "running" while this process runs. Both check the fence.
    fn touch(
        &self,
        reference: Option<&proto::Ref>,
        fence: Option<&proto::Fence>,
    ) -> std::result::Result<proto::Machine, proto::Error> {
        let mut state = self.state.lock().unwrap();
        let entry = Self::fenced(&mut state, reference, fence)?;
        if entry.file.retained {
            return Err(refuse(
                Code::FailedPrecondition,
                "retained",
                "the machine was deleted; its directory is kept",
            ));
        }
        self.save(entry)?;
        let id = entry.file.id.clone();
        Ok(self.machine(state.machines.get(&id).unwrap()))
    }

    /// Never deletes the directory: the machine is retained either way.
    fn delete(
        &self,
        request: proto::MachineDelete,
    ) -> std::result::Result<proto::Machine, proto::Error> {
        let mut state = self.state.lock().unwrap();
        let entry = Self::fenced(&mut state, request.r#ref.as_ref(), request.fence.as_ref())?;
        let id = entry.file.id.clone();
        if !entry.file.retained {
            entry.file.retained = true;
            self.save(entry)?;
            return Ok(self.changed(&mut state, &id));
        }
        self.save(entry)?;
        Ok(self.machine(state.machines.get(&id).unwrap()))
    }

    fn get(
        &self,
        reference: Option<&proto::Ref>,
    ) -> std::result::Result<proto::Machine, proto::Error> {
        let state = self.state.lock().unwrap();
        let reference = reference.ok_or_else(|| {
            refuse(
                Code::InvalidArgument,
                "ref",
                "a machine reference is required",
            )
        })?;
        state
            .machines
            .get(&reference.id)
            .filter(|entry| entry.file.owner == reference.owner)
            .map(|entry| self.machine(entry))
            .ok_or_else(|| refuse(Code::NotFound, "machine", "no such machine"))
    }

    fn answer(self: &Arc<Self>, call: proto::Call) -> proto::CallResult {
        use call_result::Result as R;
        let unimplemented = |what: &str| Err(unimplemented::<Self>(what));
        let result: std::result::Result<R, proto::Error> = match call.verb {
            Some(Verb::RunnerGet(_)) => Ok(R::Runner(self.runner(&self.state.lock().unwrap()))),
            Some(Verb::MachineCreate(request)) => self.create(request).map(R::Machine),
            Some(Verb::MachineStart(request)) => self
                .touch(request.r#ref.as_ref(), request.fence.as_ref())
                .map(R::Machine),
            Some(Verb::MachineStop(request)) => self
                .touch(request.r#ref.as_ref(), request.fence.as_ref())
                .map(R::Machine),
            Some(Verb::MachineDelete(request)) => self.delete(request).map(R::Machine),
            Some(Verb::MachineGet(request)) => self.get(request.r#ref.as_ref()).map(R::Machine),
            Some(Verb::MachineList(_)) => {
                let state = self.state.lock().unwrap();
                Ok(R::Machines(proto::Machines {
                    items: state
                        .machines
                        .values()
                        .map(|entry| self.machine(entry))
                        .collect(),
                    version: state.version,
                }))
            }
            Some(Verb::MachineDiscard(_)) => {
                unimplemented("discard: it never deletes a machine's directory")
            }
            Some(Verb::MachineDiagnose(_)) => unimplemented("diagnosis"),
            Some(Verb::TemplatePublish(_) | Verb::TemplateList(_) | Verb::TemplateDelete(_)) => {
                unimplemented("templates")
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

    /// One guest operation: checked, then run as a child that outlives the
    /// stream (a caller that goes away never kills a command it started).
    async fn run_guest(
        self: &Arc<Self>,
        header: proto::GuestHeader,
        recv: &mut iroh::endpoint::RecvStream,
    ) -> std::result::Result<Vec<u8>, proto::Error> {
        if !valid_op(&header.op) {
            return Err(refuse(
                Code::InvalidArgument,
                "op",
                "invalid guest operation name",
            ));
        }
        let id = {
            let mut state = self.state.lock().unwrap();
            let entry = Self::fenced(&mut state, header.r#ref.as_ref(), header.fence.as_ref())?;
            if entry.file.retained {
                return Err(refuse(
                    Code::FailedPrecondition,
                    "retained",
                    "the machine was deleted; its directory is kept",
                ));
            }
            let id = entry.file.id.clone();
            if let Some(entry) = state.machines.get(&id) {
                self.save(entry)?;
            }
            id
        };
        let mut request = Vec::new();
        recv.take(MAX_GUEST_REQUEST + 1)
            .read_to_end(&mut request)
            .await
            .map_err(|error| refuse(Code::Unavailable, "stream", &error.to_string()))?;
        if request.len() as u64 > MAX_GUEST_REQUEST {
            return Err(refuse(
                Code::InvalidArgument,
                "size",
                "the guest request is too large",
            ));
        }
        let runner = self.clone();
        let op = header.op.clone();
        let answer = tokio::spawn(async move { runner.run_helper(&id, &op, request).await })
            .await
            .map_err(|error| refuse(Code::Internal, "helper", &error.to_string()))?;
        let answer = answer.map_err(|message| proto::Error {
            code: Code::Unavailable as i32,
            reason: "guest_failed".into(),
            message,
            completion_unknown: true,
        })?;
        if let Some(reference) = header
            .r#ref
            .filter(|_| matches!(header.op.as_str(), "hello" | "install"))
        {
            tokio::spawn(self.clone().probe(reference.id));
        }
        Ok(answer)
    }

    async fn run_helper(
        &self,
        id: &str,
        op: &str,
        request: Vec<u8>,
    ) -> std::result::Result<Vec<u8>, String> {
        let directory = self.machine_dir(id);
        let mut child = Command::new(&self.options.python)
            .arg(directory.join("bin").join("cube-guest"))
            .arg("host")
            .arg(&directory)
            .args(["call", op])
            .env("CUBE_HOST_BOOT_ID", &self.boot_id)
            .current_dir(&directory)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("cannot start {}: {error}", self.options.python))?;
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let write = async move {
            let _ = stdin.write_all(&request).await;
            drop(stdin);
        };
        let read = async {
            let mut out = Vec::new();
            let _ = (&mut stdout)
                .take(MAX_GUEST_ANSWER + 1)
                .read_to_end(&mut out)
                .await;
            out
        };
        let errors = async {
            let mut out = Vec::new();
            let _ = (&mut stderr).take(64 * 1024).read_to_end(&mut out).await;
            out
        };
        let ((), out, errors) = tokio::join!(write, read, errors);
        let status = child.wait().await.map_err(|error| error.to_string())?;
        if out.len() as u64 > MAX_GUEST_ANSWER {
            return Err("the guest answer is too large".into());
        }
        if !status.success() || !out.contains(&b'\n') {
            let said = String::from_utf8_lossy(&errors);
            let tail: Vec<&str> = said.trim().lines().rev().take(2).collect();
            let tail: Vec<&str> = tail.into_iter().rev().collect();
            return Err(format!(
                "the guest helper failed ({status}){}",
                if tail.is_empty() {
                    String::new()
                } else {
                    format!(": {}", tail.join("; "))
                }
            ));
        }
        Ok(out)
    }

    /// Asks the machine's helper `hello` and keeps its answer, unmodified
    /// but for the runner's own `connected` and `since`, as the machine's
    /// `status.guest`.
    async fn probe(self: Arc<Self>, id: String) {
        let info = match self.run_helper(&id, "hello", b"{}\n".to_vec()).await {
            Ok(answer) => {
                let line = answer.split(|b| *b == b'\n').next().unwrap_or_default();
                match serde_json::from_slice::<proto::GuestInfo>(line) {
                    Ok(info) => proto::GuestInfo {
                        connected: true,
                        ..info
                    },
                    Err(_) => proto::GuestInfo::default(),
                }
            }
            Err(_) => proto::GuestInfo::default(),
        };
        let mut state = self.state.lock().unwrap();
        let Some(entry) = state.machines.get_mut(&id) else {
            return;
        };
        let same = entry.guest.as_ref().is_some_and(|old| {
            proto::GuestInfo {
                since: None,
                ..old.clone()
            } == info
        });
        if same {
            return;
        }
        entry.guest = Some(proto::GuestInfo {
            since: Some(Timestamp::now()),
            ..info
        });
        self.changed(&mut state, &id);
    }
}

pub(crate) fn host_name() -> String {
    let mut buffer = [0u8; 256];
    // SAFETY: gethostname writes at most `len` bytes into the buffer.
    let ok = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } == 0;
    if !ok {
        return String::new();
    }
    let end = buffer.iter().position(|b| *b == 0).unwrap_or(buffer.len());
    String::from_utf8_lossy(&buffer[..end]).into_owned()
}

pub(crate) fn getrandom(bytes: &mut [u8]) {
    use std::io::Read;
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(bytes))
        .is_err()
    {
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            ^ std::process::id() as u128;
        for (index, byte) in bytes.iter_mut().enumerate() {
            *byte = (seed >> ((index % 16) * 8)) as u8;
        }
    }
}

impl Service for HostRunner {
    const KIND: &'static str = "host_runner";

    fn hello(&self, hello: &proto::Hello) -> std::result::Result<proto::HelloAnswer, proto::Error> {
        HostRunner::hello(self, hello)
    }
    async fn call(self: Arc<Self>, call: proto::Call) -> proto::CallResult {
        self.answer(call)
    }
    async fn watch(self: Arc<Self>, send: &mut iroh::endpoint::SendStream) -> Result<()> {
        serve::watch(send, &self.events, || {
            let state = self.state.lock().unwrap();
            let mut resources = vec![watch_event::Resource::Runner(self.runner(&state))];
            resources.extend(
                state
                    .machines
                    .values()
                    .map(|entry| watch_event::Resource::Machine(self.machine(entry))),
            );
            (state.version, resources)
        })
        .await
    }
    async fn guest(
        self: Arc<Self>,
        header: proto::GuestHeader,
        recv: &mut iroh::endpoint::RecvStream,
        _send: &mut iroh::endpoint::SendStream,
    ) -> std::result::Result<Vec<u8>, proto::Error> {
        self.run_guest(header, recv).await
    }
    fn serving(self: &Arc<Self>) {
        self.probe_all();
    }
}
