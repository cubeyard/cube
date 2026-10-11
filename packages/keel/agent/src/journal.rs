//! The operation journal under `/var/lib/cube/ops/<id>` and the commands it
//! runs: protocol 2's semantics, as cube-guest keeps them. A key is
//! journaled before anything happens; the same key and request returns the
//! recorded state, a different request is CONFLICT, records are never
//! deleted. Mutations carry a lease epoch that never goes back (an older one
//! is LEASE_STALE). A command's wrapper runs in its own operation domain (a
//! cgroup), so it outlives the agent and is found again by its key; a
//! record without an end and without a domain was cut off (a reboot) and is
//! marked interrupted. Nothing is ever run twice.
//!
//! Files per operation (the same as cube-guest's, plus `launch.json`,
//! `deadline` and `timeout`): `request.json`, `launch.json` (what the
//! wrapper runs with), `wrap.pid`, `deadline` (CLOCK_MONOTONIC ms),
//! `output`, `wrapped.json` (written by the wrapper), `cancel`, `timeout`
//! and `result.json` (written by the agent alone).
use std::{
    collections::{BTreeMap, HashSet},
    ffi::OsStr,
    fs, io,
    os::fd::AsRawFd,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use serde_json::{Value, json};

use crate::{
    domain::Domain,
    files::{canonical, read_json, write_atomic, write_json},
};

pub const MAX_RECORDS: usize = 100_000;
pub const MAX_WAIT_MS: i64 = 20_000;
pub const MAX_HEADER_BYTES: usize = 16_384;

/// cube-guest's LIMITS: what one guest operation may carry.
pub struct Limits;
impl Limits {
    pub const MAX_FRAME_BYTES: u32 = 1_048_576;
    pub const REQUEST_TIMEOUT_MS: u32 = 30_000;
    pub const MAX_COMMAND_BYTES: u32 = 8192;
    pub const MAX_PATH_BYTES: u32 = 4096;
    pub const MAX_EXEC_TIMEOUT_MS: u32 = 1_800_000;
    pub const MAX_OUTPUT_BYTES: u32 = 262_144;
    pub const OUTPUT_PAGE_BYTES: u32 = 65_536;
    pub const MAX_READ_BYTES: u32 = 524_288;
    pub const MAX_WRITE_BYTES: u32 = 524_288;

    pub fn json() -> Value {
        json!({
            "maxFrameBytes": Self::MAX_FRAME_BYTES,
            "requestTimeoutMs": Self::REQUEST_TIMEOUT_MS,
            "maxCommandBytes": Self::MAX_COMMAND_BYTES,
            "maxPathBytes": Self::MAX_PATH_BYTES,
            "maxExecTimeoutMs": Self::MAX_EXEC_TIMEOUT_MS,
            "maxOutputBytes": Self::MAX_OUTPUT_BYTES,
            "outputPageBytes": Self::OUTPUT_PAGE_BYTES,
            "maxReadBytes": Self::MAX_READ_BYTES,
            "maxWriteBytes": Self::MAX_WRITE_BYTES,
        })
    }
}

/// An operation's error as `OPERATIONS` answers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fail {
    pub code: String,
    pub message: String,
}

impl Fail {
    pub fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
        }
    }
    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("INVALID_REQUEST", message)
    }
}

impl From<io::Error> for Fail {
    fn from(error: io::Error) -> Self {
        Self::new("IO_ERROR", error.to_string())
    }
}

pub type Answer = Result<(Value, Vec<u8>), Fail>;

/// The account commands run as (the workload's `agent`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub uid: u32,
    pub gid: u32,
    pub groups: Vec<u32>,
    pub home: String,
}

/// What a command's wrapper needs that the request does not say: where the
/// workspace is, the workload's mount namespace, the account and the
/// environment. Fixed by `machine_setup`.
#[derive(Clone, Debug)]
pub struct Launch {
    /// The workspace as the command sees it (inside the namespace, if any).
    pub workspace: PathBuf,
    /// A bind-mounted mount namespace file to enter (the workload root), or
    /// None to stay in the agent's (tests only).
    pub namespace: Option<PathBuf>,
    /// None keeps the agent's own account (tests only).
    pub account: Option<Account>,
    pub env: BTreeMap<String, String>,
}

/// The journal and the commands it supervises.
pub struct Journal {
    pub state: PathBuf,
    /// The workload root as the agent sees it; the workspace is its
    /// `workspace` directory.
    pub root: PathBuf,
    domain: Arc<dyn Domain>,
    /// `cube-agent`, run again as `cube-agent wrap OPDIR`.
    wrapper: PathBuf,
    launch: Mutex<Option<Launch>>,
    running: Mutex<HashSet<String>>,
    /// The machine is powering off: ends are no longer recorded, so a
    /// command the shutdown kills is interrupted, as cube-guest records it.
    pub stopping: AtomicBool,
}

const CANCELLED: &str = r#"{"completionUnknown":false,"error":"CANCELLED","state":"Failed"}"#;

fn cancelled() -> Value {
    serde_json::from_str(CANCELLED).unwrap()
}
fn interrupted() -> Value {
    json!({"state": "Interrupted", "completionUnknown": true})
}

pub fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A JSON integer in [minimum, maximum] (no booleans, no floats), as
/// cube-guest's `integer`.
pub fn integer(value: Option<&Value>, minimum: i64, maximum: Option<i64>) -> Option<i64> {
    let number = value?.as_i64()?;
    (number >= minimum && maximum.is_none_or(|max| number <= max)).then_some(number)
}

pub(crate) fn op_id(header: &Value) -> Result<String, Fail> {
    match header.get("id").and_then(Value::as_str) {
        Some(id) if valid_id(id) => Ok(id.into()),
        _ => Err(Fail::invalid("invalid operation id")),
    }
}

pub fn monotonic_ms() -> i64 {
    let mut time = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) };
    time.tv_sec * 1000 + time.tv_nsec / 1_000_000
}

/// `flock` on `state/lock`: one journal mutation at a time.
pub(crate) struct Lock(#[allow(dead_code)] fs::File);
impl Lock {
    pub(crate) fn take(state: &Path) -> io::Result<Self> {
        fs::create_dir_all(state)?;
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(state.join("lock"))?;
        while unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } != 0 {
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
        Ok(Self(file))
    }
}

impl Journal {
    pub fn new(state: PathBuf, root: PathBuf, domain: Arc<dyn Domain>, wrapper: PathBuf) -> Self {
        Self {
            state,
            root,
            domain,
            wrapper,
            launch: Mutex::new(None),
            running: Mutex::new(HashSet::new()),
            stopping: AtomicBool::new(false),
        }
    }

    pub fn set_launch(&self, launch: Launch) {
        *self.launch.lock().unwrap() = Some(launch);
    }

    /// The account commands run as; None before `machine_setup` and in tests.
    pub(crate) fn account(&self) -> Option<Account> {
        self.launch.lock().unwrap().as_ref()?.account.clone()
    }

    fn ops(&self) -> PathBuf {
        self.state.join("ops")
    }
    pub(crate) fn op(&self, id: &str) -> PathBuf {
        self.ops().join(id)
    }

    pub fn current_epoch(&self) -> i64 {
        fs::read_to_string(self.state.join("epoch"))
            .ok()
            .and_then(|text| text.trim().parse().ok())
            .unwrap_or(0)
    }

    /// Lease epochs never go back; call with the lock held.
    pub(crate) fn fence(&self, header: &Value) -> Result<(), Fail> {
        let epoch = integer(header.get("epoch"), 1, None)
            .ok_or_else(|| Fail::invalid("epoch must be a positive integer"))?;
        let current = self.current_epoch();
        if epoch < current {
            return Err(Fail::new(
                "LEASE_STALE",
                "a newer workspace lease has been used",
            ));
        }
        if epoch > current {
            write_atomic(
                &self.state.join("epoch"),
                epoch.to_string().as_bytes(),
                0o600,
            )?;
        }
        Ok(())
    }

    pub(crate) fn count_records(&self) -> usize {
        fs::read_dir(self.ops())
            .map(|entries| entries.count())
            .unwrap_or(0)
    }

    /// Creates the record of a new key (true), or finds the existing one
    /// (false). CONFLICT when the key was used for a different request.
    pub(crate) fn new_record(&self, id: &str, request: Value) -> Result<bool, Fail> {
        let digest = canonical(&request);
        fs::create_dir_all(self.ops())?;
        match fs::create_dir(self.op(id)) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let recorded = read_json(&self.op(id).join("request.json"))?;
                if recorded
                    .as_ref()
                    .and_then(|r| r.get("kind"))
                    .and_then(Value::as_str)
                    == Some("cancelled")
                {
                    return Ok(false); // cancelled before it arrived: report that, never run it
                }
                if recorded
                    .as_ref()
                    .and_then(|r| r.get("hash"))
                    .and_then(Value::as_str)
                    != Some(digest.as_str())
                {
                    return Err(Fail::new(
                        "CONFLICT",
                        "this key was used for a different request",
                    ));
                }
                return Ok(false);
            }
            Err(error) => return Err(error.into()),
        }
        crate::files::fsync_dir(&self.ops())?;
        let mut record = request;
        record["hash"] = Value::String(digest);
        write_json(&self.op(id).join("request.json"), &record)?;
        Ok(true)
    }

    fn active(&self, id: &str) -> bool {
        self.running.lock().unwrap().contains(id) || self.domain.exists(id)
    }

    /// The operation state of a key; call with the lock held.
    fn state_of(&self, id: &str, cursor: i64) -> Answer {
        let dir = self.op(id);
        let Some(request) = read_json(&dir.join("request.json"))? else {
            return Ok((json!({"state": "Unknown"}), vec![]));
        };
        let result = match read_json(&dir.join("result.json"))? {
            Some(result) => result,
            None => {
                if request["kind"] == "exec" && self.active(id) {
                    return Ok((json!({"state": "Running"}), vec![]));
                }
                // Nothing runs this key and nothing recorded an end: the
                // agent or the machine stopped in between. Never run it again.
                let result = if dir.join("cancel").exists() {
                    cancelled()
                } else {
                    interrupted()
                };
                write_json(&dir.join("result.json"), &result)?;
                result
            }
        };
        if result["state"] != "Succeeded" {
            return Ok((result, vec![]));
        }
        let retained = result["result"]["retainedBytes"].as_i64().unwrap_or(0);
        if cursor < 0 || cursor > retained {
            return Err(Fail::invalid("output cursor is past the retained output"));
        }
        let mut page = vec![];
        if retained > 0 {
            use std::io::{Read, Seek, SeekFrom};
            let mut output = fs::File::open(dir.join("output"))?;
            output.seek(SeekFrom::Start(cursor as u64))?;
            let length = (Limits::OUTPUT_PAGE_BYTES as i64).min(retained - cursor) as u64;
            output.take(length).read_to_end(&mut page)?;
        }
        let mut header = json!({"state": "Succeeded", "result": result["result"].clone()});
        header["result"]["outputOffset"] = json!(cursor);
        header["result"]["outputLength"] = json!(page.len());
        Ok((header, page))
    }

    /// A relative `cwd` that stays in the workspace, wherever its links lead
    /// (resolved inside the workload root).
    fn check_cwd(&self, cwd: &str) -> Result<(), Fail> {
        if cwd.is_empty()
            || cwd.contains('\0')
            || cwd.starts_with('/')
            || cwd.len() > Limits::MAX_PATH_BYTES as usize
            || cwd.split('/').any(|part| part == "..")
        {
            return Err(Fail::invalid("path must be relative to the workspace"));
        }
        if crate::paths::leaves_workspace(&self.root, cwd)? {
            return Err(Fail::invalid("path leaves the workspace"));
        }
        Ok(())
    }

    pub fn exec(&self, header: &Value) -> Answer {
        let id = op_id(header)?;
        let command = header.get("command").and_then(Value::as_str);
        let cwd = match header.get("cwd") {
            None => ".",
            Some(value) => value
                .as_str()
                .ok_or_else(|| Fail::invalid("path must be relative to the workspace"))?,
        };
        let command = match command {
            Some(text)
                if !text.is_empty()
                    && !text.contains('\0')
                    && text.len() <= Limits::MAX_COMMAND_BYTES as usize =>
            {
                text
            }
            _ => {
                return Err(Fail::invalid(format!(
                    "command must be 1-{} bytes",
                    Limits::MAX_COMMAND_BYTES
                )));
            }
        };
        if cwd != "." {
            self.check_cwd(cwd)?;
        }
        let timeout_ms = integer(
            header.get("timeoutMs"),
            1,
            Some(Limits::MAX_EXEC_TIMEOUT_MS as i64),
        )
        .ok_or_else(|| Fail::invalid(format!("timeout is 1-{} ms", Limits::MAX_EXEC_TIMEOUT_MS)))?;
        let output_limit = match header.get("outputLimit") {
            None => Limits::MAX_OUTPUT_BYTES as i64,
            value => integer(value, 0, Some(Limits::MAX_OUTPUT_BYTES as i64)).ok_or_else(|| {
                Fail::invalid(format!(
                    "output limit is at most {} bytes",
                    Limits::MAX_OUTPUT_BYTES
                ))
            })?,
        };
        let request = json!({"kind": "exec", "command": command, "cwd": cwd, "timeoutMs": timeout_ms, "outputLimit": output_limit});
        let _lock = Lock::take(&self.state)?;
        self.fence(header)?;
        if !self.op(&id).is_dir() && self.count_records() >= MAX_RECORDS {
            return Err(Fail::new(
                "CAPACITY_EXCEEDED",
                format!("the guest keeps at most {MAX_RECORDS} operation records"),
            ));
        }
        // A domain that was not created, or removed again, runs nothing.
        if self.new_record(&id, request)?
            && let Err(failure) = self.launch(&id, timeout_ms)
        {
            write_json(
                &self.op(&id).join("result.json"),
                &json!({"state": "Failed", "error": "IO_ERROR", "completionUnknown": false, "message": failure.message}),
            )?;
        }
        self.state_of(&id, 0)
    }

    fn launch(&self, id: &str, timeout_ms: i64) -> Result<(), Fail> {
        let launch = self
            .launch
            .lock()
            .unwrap()
            .clone()
            .ok_or_else(|| Fail::new("IO_ERROR", "the workload root is not assembled"))?;
        let dir = self.op(id);
        let spec = json!({
            "workspace": launch.workspace,
            "namespace": launch.namespace,
            "account": launch.account.as_ref().map(|a| json!({"uid": a.uid, "gid": a.gid, "groups": a.groups, "home": a.home})),
            "env": launch.env,
        });
        write_json(&dir.join("launch.json"), &spec)?;
        write_atomic(
            &dir.join("deadline"),
            (monotonic_ms() + timeout_ms).to_string().as_bytes(),
            0o600,
        )?;
        self.domain
            .start(id, &self.wrapper, &[OsStr::new("wrap"), dir.as_os_str()])
            .map_err(|error| {
                Fail::new("IO_ERROR", format!("starting the command failed: {error}"))
            })?;
        // The lock is held: the supervisor records nothing before this.
        self.running.lock().unwrap().insert(id.into());
        Ok(())
    }

    pub fn get(&self, header: &Value) -> Answer {
        let id = op_id(header)?;
        let cursor = integer(header.get("cursor").or(Some(&json!(0))), 0, None);
        let wait = integer(
            header.get("waitMs").or(Some(&json!(0))),
            0,
            Some(MAX_WAIT_MS),
        );
        let (Some(cursor), Some(wait)) = (cursor, wait) else {
            return Err(Fail::invalid("invalid cursor or wait"));
        };
        let deadline = Instant::now() + Duration::from_millis(wait as u64);
        loop {
            let state = {
                let _lock = Lock::take(&self.state)?;
                self.state_of(&id, cursor)?
            };
            if state.0["state"] != "Running" || Instant::now() >= deadline {
                return Ok(state);
            }
            // Running: wait cheaply for the supervisor to record an end.
            while Instant::now() < deadline && !self.op(&id).join("result.json").exists() {
                std::thread::sleep(Duration::from_millis(50).min(deadline - Instant::now()));
            }
        }
    }

    /// Kills a running command. A key not seen yet is cancelled before it
    /// arrives: a stop can overtake the command it stops.
    pub fn cancel(&self, header: &Value) -> Answer {
        let id = op_id(header)?;
        let _lock = Lock::take(&self.state)?;
        self.fence(header)?;
        let dir = self.op(&id);
        match read_json(&dir.join("request.json"))? {
            None => {
                self.new_record(&id, json!({"kind": "cancelled"}))?;
                write_json(&dir.join("result.json"), &cancelled())?;
            }
            Some(request)
                if request["kind"] == "exec"
                    && !dir.join("result.json").exists()
                    && self.active(&id) =>
            {
                write_atomic(&dir.join("cancel"), b"", 0o600)?;
                self.domain.kill(&id);
            }
            Some(_) => {}
        }
        self.state_of(&id, 0)
    }

    /// Before the journal answers: a record without an end either still has
    /// its domain (the agent started again; the supervisor takes it over) or
    /// was cut off (a reboot) and is marked interrupted. Never rerun.
    pub fn recover(&self) -> io::Result<usize> {
        let _lock = Lock::take(&self.state)?;
        fs::create_dir_all(self.ops())?;
        let mut adopted = 0;
        for entry in fs::read_dir(self.ops())? {
            let name = entry?.file_name();
            let Some(id) = name.to_str().filter(|id| valid_id(id)) else {
                continue;
            };
            let dir = self.op(id);
            if !dir.join("request.json").exists() || dir.join("result.json").exists() {
                continue;
            }
            if self.domain.exists(id) {
                self.running.lock().unwrap().insert(id.into());
                adopted += 1;
            } else {
                let result = if dir.join("cancel").exists() {
                    cancelled()
                } else {
                    interrupted()
                };
                write_json(&dir.join("result.json"), &result)?;
            }
        }
        Ok(adopted)
    }

    /// One pass of the supervisor over the running commands: a timeout kills
    /// the domain, the wrapper's end kills what it left behind
    /// (`KillMode=control-group`), and an empty domain is recorded.
    pub fn supervise(&self) {
        if self.stopping.load(Ordering::SeqCst) {
            return;
        }
        let ids: Vec<String> = self.running.lock().unwrap().iter().cloned().collect();
        for id in ids {
            let dir = self.op(&id);
            if !self.domain.populated(&id) {
                if let Err(error) = self.record(&id) {
                    eprintln!(
                        "cube-agent: recording {id}: {}: {}",
                        error.code, error.message
                    );
                }
                continue;
            }
            let main_ended = dir.join("wrapped.json").exists()
                || fs::read_to_string(dir.join("wrap.pid"))
                    .ok()
                    .and_then(|pid| pid.trim().parse::<i32>().ok())
                    .is_some_and(|pid| !alive(pid));
            let deadline = fs::read_to_string(dir.join("deadline"))
                .ok()
                .and_then(|text| text.trim().parse::<i64>().ok());
            if main_ended || dir.join("cancel").exists() {
                self.domain.kill(&id);
            } else if deadline.is_some_and(|deadline| monotonic_ms() >= deadline) {
                let _ = write_atomic(&dir.join("timeout"), b"", 0o600);
                self.domain.kill(&id);
            }
        }
    }

    fn record(&self, id: &str) -> Result<(), Fail> {
        let _lock = Lock::take(&self.state)?;
        if self.stopping.load(Ordering::SeqCst) {
            return Ok(());
        }
        if self.domain.populated(id) {
            return Ok(()); // started again under the lock; not ended
        }
        let dir = self.op(id);
        if !dir.join("result.json").exists() && dir.join("request.json").exists() {
            let result = if dir.join("cancel").exists() {
                cancelled()
            } else {
                json!({"state": "Succeeded", "result": self.exec_result(id)?})
            };
            write_json(&dir.join("result.json"), &result)?;
        }
        self.domain.remove(id);
        self.running.lock().unwrap().remove(id);
        Ok(())
    }

    fn exec_result(&self, id: &str) -> Result<Value, Fail> {
        let dir = self.op(id);
        let wrapped = read_json(&dir.join("wrapped.json"))?;
        let retained = fs::metadata(dir.join("output"))
            .map(|m| m.len())
            .unwrap_or(0);
        let memory = self.domain.memory(id);
        let oom = memory
            .as_ref()
            .and_then(|m| m["oomKills"].as_u64())
            .unwrap_or(0)
            > 0;
        let (exit_code, termination, service) = if dir.join("timeout").exists() {
            (Value::Null, "timedOut", "timeout")
        } else if let Some(code) = wrapped
            .as_ref()
            .and_then(|w| w["exitCode"].as_i64())
            .filter(|c| (0..=255).contains(c))
        {
            (
                json!(code),
                "exited",
                if code == 0 { "success" } else { "exit-code" },
            )
        } else {
            (
                Value::Null,
                "signalled",
                if oom { "oom-kill" } else { "signal" },
            )
        };
        let output_bytes = wrapped
            .as_ref()
            .and_then(|w| w["outputBytes"].as_u64())
            .unwrap_or(retained)
            .max(retained);
        Ok(json!({
            "exitCode": exit_code,
            "termination": termination,
            "outputBytes": output_bytes,
            "truncated": output_bytes > retained,
            "retainedBytes": retained,
            "serviceResult": service,
            "memory": memory,
        }))
    }

    /// Runs `supervise` every 50 ms on a thread of its own.
    pub fn spawn_supervisor(self: &Arc<Self>) {
        let journal = Arc::clone(self);
        std::thread::Builder::new()
            .name("supervisor".into())
            .spawn(move || {
                loop {
                    journal.supervise();
                    std::thread::sleep(Duration::from_millis(50));
                }
            })
            .expect("the supervisor thread starts");
    }
}

/// Whether `pid` runs and is no zombie.
pub fn alive(pid: i32) -> bool {
    if unsafe { libc::kill(pid, 0) } != 0
        && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    {
        return false;
    }
    match fs::read_to_string(format!("/proc/{pid}/stat")) {
        Ok(stat) => {
            stat.rsplit(") ")
                .next()
                .and_then(|rest| rest.split(' ').next())
                != Some("Z")
        }
        Err(_) => false,
    }
}
