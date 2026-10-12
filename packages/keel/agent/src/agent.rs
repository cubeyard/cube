//! The agent's state between connections: the journal and the services
//! (once the writable disk is mounted), whether the newest setup is
//! applied for this connection, and what `hello` and `GuestInfo` say.
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};

use cube_runner_protocol::{
    Timestamp,
    proto::{self, Code, daemon_answer::Result as AnswerKind},
    refuse,
};
use serde_json::{Value, json};

use crate::{
    cli,
    domain::{Cgroups, Domain},
    journal::{Journal, Limits},
    ops,
    services::{self, Services},
    setup,
    snapshot::{Gate, Settle},
};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const CGROUP: &str = "/sys/fs/cgroup/cube-ops";
const SERVICES_CGROUP: &str = "/sys/fs/cgroup/cube-services";
/// This boot's service state, in the base root.
const SERVICES_RUN: &str = "/run/keel/services";

struct Status {
    ready: bool,
    reason: String,
    since: Timestamp,
}

pub struct Agent {
    journal: Mutex<Option<Arc<Journal>>>,
    services: Mutex<Option<Arc<Services>>>,
    /// Whether the `cube` socket is served (once per agent process).
    listening: AtomicBool,
    domain: Result<Arc<Cgroups>, String>,
    services_domain: Result<Arc<Cgroups>, String>,
    status: Mutex<Status>,
    setup: tokio::sync::Mutex<()>,
    /// Holds requests while the machine is prepared for a snapshot.
    gate: Gate,
    settle: Settle,
    build: String,
    kernel: String,
    boot_id: String,
    /// The guest channel's current session (runner.proto's header).
    session: Mutex<String>,
    /// Sessions this agent process started, mixed into the next one.
    sessions: std::sync::atomic::AtomicU64,
}

/// A new session: 16 bytes of sha256 over fresh random bytes, the host's
/// time as the guest reads it now (the PTP clock, else realtime), the time
/// since boot, the boot id and a counter. A restore rolls the random state
/// back with memory (and arm64 has no VMGENID to reseed it); the host's time
/// still differs between two restores of one snapshot.
fn session_id(host_ns: Option<i128>, boot_id: &str, count: u64) -> String {
    let mut random = [0u8; 32];
    // SAFETY: getrandom into a buffer this function owns.
    let filled = unsafe { libc::getrandom(random.as_mut_ptr().cast(), random.len(), 0) };
    if filled != random.len() as isize {
        eprintln!("cube-agent: getrandom gave {filled} bytes for a session");
    }
    let clock = |id| {
        let mut t: libc::timespec = unsafe { std::mem::zeroed() };
        // SAFETY: clock_gettime into a zeroed timespec owned here.
        unsafe { libc::clock_gettime(id, &mut t) };
        t.tv_sec as i128 * 1_000_000_000 + t.tv_nsec as i128
    };
    derive_session(
        &random,
        host_ns.unwrap_or_else(|| clock(libc::CLOCK_REALTIME)),
        clock(libc::CLOCK_BOOTTIME),
        boot_id,
        count,
    )
}

fn derive_session(
    random: &[u8],
    host_ns: i128,
    boottime_ns: i128,
    boot_id: &str,
    count: u64,
) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    hash.update(random);
    hash.update(host_ns.to_le_bytes());
    hash.update(boottime_ns.to_le_bytes());
    hash.update(boot_id.as_bytes());
    hash.update(count.to_le_bytes());
    hash.finalize()[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// What a machine says once it was published (or failed to be).
fn published_reason(record: &Value) -> String {
    match record["outcome"].as_str() {
        Some("ok") => "this machine was published as a template; power it off".into(),
        Some(failure) => format!("template publishing {failure}; power it off"),
        None => "template publishing did not finish; power it off".into(),
    }
}

fn read_trimmed(path: &str) -> String {
    std::fs::read_to_string(path)
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

impl Agent {
    /// Recovers the journal at once when the root is assembled already (the
    /// agent started again): running commands are supervised before the
    /// first answer.
    pub fn start() -> Arc<Self> {
        Self::start_with(Settle::default())
    }

    /// `start`, with the kernel knobs a snapshot prepare writes.
    pub fn start_with(settle: Settle) -> Arc<Self> {
        let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("/sbin/cube-agent"));
        let agent = Arc::new(Self {
            journal: Mutex::new(None),
            services: Mutex::new(None),
            listening: AtomicBool::new(false),
            domain: Cgroups::open(Path::new(CGROUP))
                .map(Arc::new)
                .map_err(|error| format!("{CGROUP}: {error}")),
            services_domain: Cgroups::open(Path::new(SERVICES_CGROUP))
                .map(Arc::new)
                .map_err(|error| format!("{SERVICES_CGROUP}: {error}")),
            status: Mutex::new(Status {
                ready: false,
                reason: "waiting for machine_setup".into(),
                since: Timestamp::now(),
            }),
            setup: tokio::sync::Mutex::new(()),
            gate: Gate::default(),
            settle,
            build: crate::files::sha256_file(&exe).unwrap_or_default(),
            kernel: read_trimmed("/proc/sys/kernel/osrelease"),
            boot_id: read_trimmed("/proc/sys/kernel/random/boot_id"),
            session: Mutex::new(String::new()),
            sessions: std::sync::atomic::AtomicU64::new(0),
        });
        crate::clock::spawn();
        if let Some(record) = crate::template::published() {
            // Published in this boot: nothing runs here again.
            agent.set_status(false, published_reason(&record));
            return agent;
        }
        if setup::is_mounted(setup::ROOT) {
            if let Err(error) = agent.open_journal() {
                eprintln!("cube-agent: {error}");
            }
            // Services go on at once; `cube` is served again.
            match agent.open_services() {
                Ok(services) => agent.listen(&services, None),
                Err(error) => eprintln!("cube-agent: {error}"),
            }
        }
        agent
    }

    /// The machine's services, opened once the writable disk is mounted.
    fn open_services(&self) -> Result<Arc<Services>, String> {
        if let Some(services) = self.services.lock().unwrap().as_ref() {
            return Ok(Arc::clone(services));
        }
        let domain: Arc<dyn Domain> = self.services_domain.clone()?;
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        let state = Path::new(setup::STATE);
        let services = Services::open(
            services::Paths {
                registry: state.join("services"),
                run: SERVICES_RUN.into(),
                portal: state.join("portal.json"),
                root: setup::ROOT.into(),
            },
            domain,
            exe,
            None,
        )
        .map_err(|error| format!("the services: {error}"))?;
        services.spawn_supervisor();
        *self.services.lock().unwrap() = Some(Arc::clone(&services));
        Ok(services)
    }

    /// Serves `cube` on the workload's /run/cube/agent.sock, for the agent
    /// account (`uid`, or the one the last setup recorded) and root.
    fn listen(&self, services: &Arc<Services>, uid: Option<u32>) {
        let uid = uid.or_else(|| {
            crate::files::read_json(&Path::new(SERVICES_RUN).join("launch.json"))
                .ok()
                .flatten()
                .and_then(|launch| launch["account"]["uid"].as_u64())
                .map(|uid| uid as u32)
        });
        if uid.is_none() || self.listening.swap(true, Ordering::SeqCst) {
            return;
        }
        let socket = Path::new(setup::ROOT).join(cli::SOCKET.trim_start_matches('/'));
        if let Err(error) = cli::listen(Arc::clone(services), &socket, uid) {
            self.listening.store(false, Ordering::SeqCst);
            eprintln!("cube-agent: {}: {error}", cli::SOCKET);
        }
    }

    pub fn services(&self) -> Option<Arc<Services>> {
        self.services.lock().unwrap().clone()
    }

    fn open_journal(&self) -> Result<Arc<Journal>, String> {
        if let Some(journal) = self.journal.lock().unwrap().as_ref() {
            journal
                .recover()
                .map_err(|error| format!("recovering the journal: {error}"))?;
            return Ok(Arc::clone(journal));
        }
        let domain: Arc<dyn Domain> = self.domain.clone()?;
        let exe = std::env::current_exe().map_err(|error| error.to_string())?;
        let journal = Arc::new(Journal::new(
            setup::STATE.into(),
            setup::ROOT.into(),
            domain,
            exe,
        ));
        let adopted = journal
            .recover()
            .map_err(|error| format!("recovering the journal: {error}"))?;
        if adopted > 0 {
            eprintln!("cube-agent: {adopted} running operation(s) found again");
        }
        journal.spawn_supervisor();
        *self.journal.lock().unwrap() = Some(Arc::clone(&journal));
        Ok(journal)
    }

    pub fn journal(&self) -> Option<Arc<Journal>> {
        self.journal.lock().unwrap().clone()
    }

    fn set_status(&self, ready: bool, reason: impl Into<String>) {
        let mut status = self.status.lock().unwrap();
        status.ready = ready;
        status.reason = reason.into();
        status.since = Timestamp::now();
    }

    /// A new connection: a new session, the clock synced with the host's
    /// first, and ready again only once its setup is applied. Returns the
    /// session.
    pub fn connected(&self) -> String {
        let host_ns = crate::clock::sync_now();
        let count = self.sessions.fetch_add(1, Ordering::SeqCst);
        let session = session_id(host_ns, &self.boot_id, count);
        *self.session.lock().unwrap() = session.clone();
        match crate::template::published() {
            Some(record) => self.set_status(false, published_reason(&record)),
            None => self.set_status(false, "waiting for machine_setup"),
        }
        session
    }

    /// The connection ended: a prepare ends with it, and what it held is
    /// dropped (the gate's waiters see the end first).
    pub fn disconnected(&self) {
        if self.gate.release() {
            eprintln!("cube-agent: snapshot: the connection ended while prepared");
        }
    }

    pub fn gate(&self) -> &Gate {
        &self.gate
    }

    pub fn ready(&self) -> bool {
        self.status.lock().unwrap().ready
    }

    pub fn shutting_down(&self) {
        if let Some(journal) = self.journal() {
            journal
                .stopping
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    fn epoch(&self) -> i64 {
        self.journal().map_or(0, |journal| journal.current_epoch())
    }

    /// Each hook's last outcome in this machine, read as the agent account
    /// (from ~/.cache/cube in the workload root); nothing before a setup.
    fn hooks(&self) -> std::collections::BTreeMap<String, String> {
        let account = self.services().and_then(|services| services.account());
        match account {
            Some(account) if setup::is_mounted(setup::ROOT) => crate::hooks::Hooks {
                root: Path::new(setup::ROOT),
                account: &account,
                reader: Some(&account),
            }
            .outcomes(),
            _ => Default::default(),
        }
    }

    pub fn info(&self) -> proto::GuestInfo {
        let hooks = self.hooks().into_iter().collect();
        let status = self.status.lock().unwrap();
        let prepared = self.gate.prepared();
        let ready = status.ready && !prepared;
        proto::GuestInfo {
            connected: true,
            ready,
            build: self.build.clone(),
            version: VERSION.into(),
            capabilities: ops::CAPABILITIES.iter().map(|c| c.to_string()).collect(),
            os: "linux".into(),
            kernel: self.kernel.clone(),
            boot_id: self.boot_id.clone(),
            hooks,
            since: Some(status.since),
            limits: Some(proto::GuestLimits {
                max_frame_bytes: Limits::MAX_FRAME_BYTES,
                request_timeout_ms: Limits::REQUEST_TIMEOUT_MS,
                max_command_bytes: Limits::MAX_COMMAND_BYTES,
                max_path_bytes: Limits::MAX_PATH_BYTES,
                max_exec_timeout_ms: Limits::MAX_EXEC_TIMEOUT_MS,
                max_output_bytes: Limits::MAX_OUTPUT_BYTES,
                output_page_bytes: Limits::OUTPUT_PAGE_BYTES,
                max_read_bytes: Limits::MAX_READ_BYTES,
                max_write_bytes: Limits::MAX_WRITE_BYTES,
            }),
            epoch: self.epoch(),
            reason: if ready {
                String::new()
            } else if prepared {
                "prepared for a snapshot".into()
            } else {
                status.reason.clone()
            },
            session: self.session.lock().unwrap().clone(),
            ..Default::default()
        }
    }

    /// The `hello` operation's answer: cube-guest's fields.
    fn hello(&self) -> Value {
        let info = self.info();
        json!({
            "version": info.version, "ready": info.ready, "capabilities": info.capabilities,
            "limits": Limits::json(), "epoch": info.epoch, "build": info.build, "os": info.os,
            "kernel": info.kernel, "hooks": info.hooks, "bootId": info.boot_id,
        })
    }

    /// A guest operation; refused until the machine is ready, but `hello`.
    pub fn guest(self: &Arc<Self>, op: &str, data: &[u8]) -> AnswerKind {
        if !op.bytes().all(|b| b.is_ascii_lowercase()) || op.is_empty() {
            return AnswerKind::Error(refuse(
                Code::InvalidArgument,
                "bad_operation",
                "an operation name is lowercase ASCII letters",
            ));
        }
        if op != "hello" && !self.ready() {
            let reason = self.status.lock().unwrap().reason.clone();
            return AnswerKind::Error(refuse(Code::Unavailable, "not_ready", &reason));
        }
        let journal = self.journal();
        let services = self.services();
        AnswerKind::Guest(ops::call(
            op,
            data,
            journal.as_deref(),
            services.as_deref(),
            &|| self.hello(),
        ))
    }

    /// Publishes this build machine as a template (template.rs), under the
    /// setup lock; Ok means `done`. A repeated request answers as the first.
    pub async fn template_publish(self: &Arc<Self>) -> Result<(), proto::Error> {
        let _one = self.setup.lock().await;
        if let Some(record) = crate::template::published() {
            return crate::template::outcome(&record);
        }
        crate::template::precheck()?;
        self.set_status(false, "publishing the template");
        let agent = Arc::clone(self);
        let result = tokio::task::spawn_blocking(move || {
            let services = agent.services();
            let home = services
                .as_ref()
                .and_then(|services| services.account())
                .map_or_else(|| "/home/agent".to_string(), |account| account.home);
            if let Some(services) = services {
                services.halt();
            }
            crate::template::publish(&home)
        })
        .await
        .unwrap_or_else(|error| Err(refuse(Code::Internal, "publish_failed", &error.to_string())));
        let record = crate::template::published().unwrap_or_default();
        self.set_status(false, published_reason(&record));
        result.map(|_| ())
    }

    /// `snapshot_prepare` (snapshot.rs): Ok means `done`, the machine
    /// prepared. A machine that could not be settled is not left prepared.
    pub async fn snapshot_prepare(self: &Arc<Self>) -> Result<(), proto::Error> {
        let started = std::time::Instant::now();
        self.gate.prepare().await?;
        let settle = self.settle.clone();
        let settled = tokio::task::spawn_blocking(move || settle.run())
            .await
            .unwrap_or_else(|error| Err(std::io::Error::other(error.to_string())));
        if let Err(error) = settled {
            self.gate.release();
            eprintln!("cube-agent: snapshot: not prepared: {error}");
            return Err(refuse(
                Code::Internal,
                "snapshot_prepare",
                &format!("settling the machine failed, so it is not prepared: {error}"),
            ));
        }
        if !self.gate.prepared() {
            return Err(refuse(
                Code::Aborted,
                "snapshot_done",
                "the machine was let go before it was prepared",
            ));
        }
        eprintln!(
            "cube-agent: snapshot: prepared in {} ms (synced, page cache dropped, memory compacted)",
            started.elapsed().as_millis()
        );
        Ok(())
    }

    /// `snapshot_done`: what the prepare held goes on. Done also when the
    /// machine was not prepared.
    pub fn snapshot_done(&self) {
        if self.gate.release() {
            eprintln!("cube-agent: snapshot: snapshot_done; what was held goes on");
        }
    }

    /// Applies a setup, one at a time; Ok means `done`.
    pub async fn machine_setup(
        self: &Arc<Self>,
        request: proto::MachineSetup,
    ) -> Result<(), proto::Error> {
        let _one = self.setup.lock().await;
        if let Some(record) = crate::template::published() {
            return Err(refuse(
                Code::FailedPrecondition,
                "published",
                &published_reason(&record),
            ));
        }
        self.set_status(false, "applying machine_setup");
        let agent = Arc::clone(self);
        let outcome = tokio::task::spawn_blocking(move || -> Result<Vec<String>, proto::Error> {
            let applied = setup::apply(&request)?;
            let journal = agent
                .open_journal()
                .map_err(|error| refuse(Code::Internal, "journal", &error))?;
            let services = agent
                .open_services()
                .map_err(|error| refuse(Code::Internal, "services", &error))?;
            services
                .set_launch(&applied.launch)
                .map_err(|error| refuse(Code::Internal, "services", &error.to_string()))?;
            agent.listen(&services, applied.launch.account.as_ref().map(|a| a.uid));
            journal.set_launch(applied.launch);
            if applied.formatted {
                eprintln!("cube-agent: formatted the writable disk");
            }
            Ok(applied.missing)
        })
        .await
        .unwrap_or_else(|error| Err(refuse(Code::Internal, "setup", &error.to_string())));
        match outcome {
            Ok(missing) if missing.is_empty() => {
                self.set_status(true, "");
                Ok(())
            }
            Ok(missing) => {
                // Applied, but the image lacks what cube needs: not ready.
                self.set_status(false, format!("the image lacks {}", missing.join(", ")));
                Ok(())
            }
            Err(error) => {
                self.set_status(false, format!("machine_setup failed: {}", error.message));
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod session_tests {
    #[test]
    fn sessions_differ_by_the_host_time_even_with_the_random_bytes_rolled_back() {
        // Two restores of one snapshot: same random state, boot, counter and
        // time since boot; only the host's time differs.
        let random = [7u8; 32];
        let a = super::derive_session(&random, 1_000, 5, "boot", 3);
        let b = super::derive_session(&random, 2_000, 5, "boot", 3);
        assert!(cube_runner_protocol::valid_session(&a), "{a}");
        assert_ne!(a, b);
        assert_eq!(a, super::derive_session(&random, 1_000, 5, "boot", 3));
        // And fresh random bytes alone make two sessions differ.
        assert_ne!(
            super::session_id(Some(1), "boot", 0),
            super::session_id(Some(1), "boot", 0)
        );
    }
}
