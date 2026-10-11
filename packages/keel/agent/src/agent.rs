//! The agent's state between connections: the journal (once the writable
//! disk is mounted), whether the newest setup is applied for this
//! connection, and what `hello` and `GuestInfo` say.
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use cube_runner_protocol::{
    Timestamp,
    proto::{self, Code, daemon_answer::Result as AnswerKind},
    refuse,
};
use serde_json::{Value, json};

use crate::{
    domain::{Cgroups, Domain},
    journal::{Journal, Limits},
    ops, setup,
};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const CGROUP: &str = "/sys/fs/cgroup/cube-ops";

struct Status {
    ready: bool,
    reason: String,
    since: Timestamp,
}

pub struct Agent {
    journal: Mutex<Option<Arc<Journal>>>,
    domain: Result<Arc<Cgroups>, String>,
    status: Mutex<Status>,
    setup: tokio::sync::Mutex<()>,
    build: String,
    kernel: String,
    boot_id: String,
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
        let exe = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("/sbin/cube-agent"));
        let agent = Arc::new(Self {
            journal: Mutex::new(None),
            domain: Cgroups::open(Path::new(CGROUP))
                .map(Arc::new)
                .map_err(|error| format!("{CGROUP}: {error}")),
            status: Mutex::new(Status {
                ready: false,
                reason: "waiting for machine_setup".into(),
                since: Timestamp::now(),
            }),
            setup: tokio::sync::Mutex::new(()),
            build: crate::files::sha256_file(&exe).unwrap_or_default(),
            kernel: read_trimmed("/proc/sys/kernel/osrelease"),
            boot_id: read_trimmed("/proc/sys/kernel/random/boot_id"),
        });
        if setup::is_mounted(setup::ROOT)
            && let Err(error) = agent.open_journal()
        {
            eprintln!("cube-agent: {error}");
        }
        agent
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

    /// A new connection: ready again only once its setup is applied.
    pub fn connected(&self) {
        self.set_status(false, "waiting for machine_setup");
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

    pub fn info(&self) -> proto::GuestInfo {
        let status = self.status.lock().unwrap();
        proto::GuestInfo {
            connected: true,
            ready: status.ready,
            build: self.build.clone(),
            version: VERSION.into(),
            capabilities: ops::CAPABILITIES.iter().map(|c| c.to_string()).collect(),
            os: "linux".into(),
            kernel: self.kernel.clone(),
            boot_id: self.boot_id.clone(),
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
            reason: if status.ready {
                String::new()
            } else {
                status.reason.clone()
            },
            ..Default::default()
        }
    }

    /// The `hello` operation's answer: cube-guest's fields.
    fn hello(&self) -> Value {
        let info = self.info();
        json!({
            "version": info.version, "ready": info.ready, "capabilities": info.capabilities,
            "limits": Limits::json(), "epoch": info.epoch, "build": info.build, "os": info.os,
            "kernel": info.kernel, "hooks": {}, "bootId": info.boot_id,
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
        AnswerKind::Guest(ops::call(op, data, journal.as_deref(), &|| self.hello()))
    }

    /// Applies a setup, one at a time; Ok means `done`.
    pub async fn machine_setup(
        self: &Arc<Self>,
        request: proto::MachineSetup,
    ) -> Result<(), proto::Error> {
        let _one = self.setup.lock().await;
        self.set_status(false, "applying machine_setup");
        let agent = Arc::clone(self);
        let outcome = tokio::task::spawn_blocking(move || -> Result<Vec<String>, proto::Error> {
            let applied = setup::apply(&request)?;
            let journal = agent
                .open_journal()
                .map_err(|error| refuse(Code::Internal, "journal", &error))?;
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
