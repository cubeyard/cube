//! Opt-in, trusted Linux host execution. This is not an isolation boundary.
//! The daemon must have exclusive ownership of its journal; never replay on boot.
use std::{
    fs::{self, File, OpenOptions},
    io,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, ensure};
use iroh::EndpointId;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::{io::AsyncReadExt, process::Command, sync::Notify};

pub const MAX_OUTPUT: u32 = 8192;
pub const MAX_TIMEOUT_MS: u64 = 60_000;
const MAX_RECORDS: i64 = 10_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub thread_id: String,
    pub environment_id: u64,
    pub node_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Installation {
    pub binding: Binding,
    pub peer_id: String,
    pub allowed_peer: String,
    pub workspace: PathBuf,
    pub workspace_device: u64,
    pub workspace_inode: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecSpec {
    pub command: String,
    pub guest_cwd: String,
    pub timeout_ms: u64,
    pub output_limit: u32,
}
impl ExecSpec {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.command.is_empty() && self.command.len() <= 8192 && !self.command.contains('\0'),
            "invalid command"
        );
        ensure!(
            !self.guest_cwd.is_empty()
                && self.guest_cwd.len() <= 4096
                && !self.guest_cwd.contains('\0')
                && !Path::new(&self.guest_cwd).is_absolute(),
            "cwd must be relative to the workspace"
        );
        ensure!(
            (1..=MAX_TIMEOUT_MS).contains(&self.timeout_ms),
            "invalid timeout"
        );
        ensure!(self.output_limit <= MAX_OUTPUT, "invalid output limit");
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecResult {
    pub exit_code: Option<i32>,
    pub termination: String,
    /// Combined stdout/stderr in observation order, as bytes (not lossy UTF-8).
    pub output: Vec<u8>,
    pub output_bytes: u64,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "state", deny_unknown_fields)]
pub enum Operation {
    Accepted,
    Running,
    Succeeded {
        result: ExecResult,
    },
    Failed {
        error: String,
        #[serde(rename = "completionUnknown")]
        completion_unknown: bool,
    },
    /// The daemon lost ownership. This does NOT assert that descendants stopped.
    Interrupted {
        #[serde(rename = "completionUnknown")]
        completion_unknown: bool,
    },
    Unknown,
}

#[derive(Debug)]
pub struct HostError(pub &'static str);
impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for HostError {}
fn reject<T>(code: &'static str) -> Result<T> {
    Err(HostError(code).into())
}
pub fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}
fn private_file(path: &Path, create: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(true)
        .custom_flags(libc::O_NOFOLLOW)
        .mode(0o600);
    if create {
        options.create_new(true);
    }
    let file = options.open(path)?;
    let meta = file.metadata()?;
    ensure!(
        meta.is_file() && meta.nlink() == 1 && meta.mode() & 0o077 == 0,
        "state files must be private regular single-link files"
    );
    Ok(file)
}

struct Journal {
    db: Connection,
    // A kernel-released lock, not a stale-PID lock. Never unlink/replace this file.
    _lock: File,
    active: bool,
}

pub struct Host {
    installation: Installation,
    journal: Mutex<Journal>,
    closed: AtomicBool,
    idle: Notify,
}

impl Host {
    pub fn installation(&self) -> &Installation {
        &self.installation
    }

    /// Local operator enrollment, not an RPC. Requires a NEW state directory and
    /// an already existing workspace. Incomplete initialization is fail-closed.
    pub fn initialize(
        state: &Path,
        binding: Binding,
        peer: EndpointId,
        allowed: EndpointId,
        workspace: &Path,
    ) -> Result<()> {
        ensure!(
            cfg!(target_os = "linux"),
            "host execution currently requires Linux"
        );
        ensure!(
            unsafe { libc::geteuid() } != 0,
            "refusing root host execution"
        );
        crate::validate_node_id(&binding.node_id)?;
        ensure!(
            valid_id(&binding.thread_id)
                && (1..=9_007_199_254_740_991).contains(&binding.environment_id),
            "invalid binding"
        );
        let workspace = fs::canonicalize(workspace)?;
        let metadata = fs::metadata(&workspace)?;
        ensure!(metadata.is_dir(), "workspace must exist and be a directory");
        let installation = Installation {
            binding,
            peer_id: peer.to_string(),
            allowed_peer: allowed.to_string(),
            workspace,
            workspace_device: metadata.dev(),
            workspace_inode: metadata.ino(),
        };
        // The state root is operator-selected, outside the workspace. The account
        // itself is trusted: arbitrary shell execution is not filesystem isolation.
        let state_parent = fs::canonicalize(
            state
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new(".")),
        )?;
        ensure!(
            !state_parent.starts_with(&installation.workspace),
            "state must be outside the workspace"
        );
        let mut builder = fs::DirBuilder::new();
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700).create(state)?;
        let lock = private_file(&state.join("owner.lock"), true)?;
        lock.try_lock()?;
        private_file(&state.join("journal.db"), true)?.sync_all()?;
        let db = Connection::open_with_flags(
            state.join("journal.db"),
            OpenFlags::SQLITE_OPEN_READ_WRITE,
        )?;
        db.execute_batch("PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;
            BEGIN IMMEDIATE;
            CREATE TABLE installation(id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL);
            CREATE TABLE operation(id TEXT PRIMARY KEY, request TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL);
            CREATE TRIGGER retain_installation_insert BEFORE INSERT ON installation WHEN EXISTS(SELECT 1 FROM installation) BEGIN SELECT RAISE(ABORT, 'immutable installation'); END;
            CREATE TRIGGER retain_operation_insert BEFORE INSERT ON operation WHEN EXISTS(SELECT 1 FROM operation WHERE id=NEW.id) BEGIN SELECT RAISE(ABORT, 'immutable request'); END;
            CREATE TRIGGER immutable_installation_update BEFORE UPDATE ON installation BEGIN SELECT RAISE(ABORT, 'immutable installation'); END;
            CREATE TRIGGER immutable_installation_delete BEFORE DELETE ON installation BEGIN SELECT RAISE(ABORT, 'immutable installation'); END;
            CREATE TRIGGER immutable_operation_request BEFORE UPDATE OF id,request,hash ON operation BEGIN SELECT RAISE(ABORT, 'immutable request'); END;
            CREATE TRIGGER retain_operation BEFORE DELETE ON operation BEGIN SELECT RAISE(ABORT, 'retain deduplication record'); END;
            PRAGMA user_version=1;")?;
        db.execute(
            "INSERT INTO installation VALUES(1, ?1)",
            [serde_json::to_string(&installation)?],
        )?;
        db.execute_batch("COMMIT")?;
        File::open(state)?.sync_all()?;
        File::open(state_parent)?.sync_all()?;
        Ok(())
    }

    pub fn open(state: &Path, peer: EndpointId) -> Result<Arc<Self>> {
        ensure!(
            cfg!(target_os = "linux") && unsafe { libc::geteuid() } != 0,
            "host execution requires non-root Linux"
        );
        let meta = fs::symlink_metadata(state)?;
        ensure!(
            meta.is_dir() && meta.mode() & 0o077 == 0,
            "state directory must be private and not a symlink"
        );
        let lock = private_file(&state.join("owner.lock"), false)?;
        lock.try_lock()
            .context("another daemon owns this journal")?;
        private_file(&state.join("journal.db"), false)?;
        let db = Connection::open_with_flags(
            state.join("journal.db"),
            OpenFlags::SQLITE_OPEN_READ_WRITE,
        )?;
        db.execute_batch("PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;")?;
        ensure!(
            db.query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))? == 1,
            "unknown journal version"
        );
        ensure!(
            db.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))? == "ok",
            "journal integrity check failed"
        );
        let installation: Installation = serde_json::from_str(&db.query_row(
            "SELECT document FROM installation WHERE id=1",
            [],
            |r| r.get::<_, String>(0),
        )?)?;
        ensure!(
            installation.peer_id == peer.to_string(),
            "WRONG_NODE: peer key differs from permanent installation"
        );
        crate::validate_node_id(&installation.binding.node_id)?;
        installation.allowed_peer.parse::<EndpointId>()?;
        ensure!(
            valid_id(&installation.binding.thread_id)
                && (1..=9_007_199_254_740_991).contains(&installation.binding.environment_id)
                && installation.workspace.is_absolute(),
            "invalid installation binding"
        );
        // No scanning PIDs and no restart queue. An Accepted record may or may
        // not have reached spawn; Running may have finished without its commit.
        let interrupted = serde_json::to_string(&Operation::Interrupted {
            completion_unknown: true,
        })?;
        db.execute(
            "UPDATE operation SET state=?1 WHERE state=?2 OR state=?3",
            params![
                interrupted,
                serde_json::to_string(&Operation::Accepted)?,
                serde_json::to_string(&Operation::Running)?
            ],
        )?;
        Ok(Arc::new(Self {
            installation,
            journal: Mutex::new(Journal {
                db,
                _lock: lock,
                active: false,
            }),
            closed: AtomicBool::new(false),
            idle: Notify::new(),
        }))
    }

    fn check_env(&self, env: u64) -> Result<()> {
        if env != self.installation.binding.environment_id {
            return reject("ENVIRONMENT_MISSING");
        }
        Ok(())
    }
    pub fn inspect(&self, env: u64) -> Result<&Installation> {
        self.check_env(env)?;
        self.cwd(".")?;
        Ok(&self.installation)
    }

    fn cwd(&self, path: &str) -> Result<File> {
        let workspace = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(&self.installation.workspace)
            .map_err(|error| {
                HostError(match error.raw_os_error() {
                    Some(libc::ENOENT | libc::ELOOP | libc::ENOTDIR) => "ENVIRONMENT_MISSING",
                    _ => "IO_ERROR",
                })
            })?;
        let meta = workspace.metadata()?;
        if meta.dev() != self.installation.workspace_device
            || meta.ino() != self.installation.workspace_inode
        {
            return reject("ENVIRONMENT_MISSING");
        }
        #[cfg(target_os = "linux")]
        {
            use rustix::fs::{Mode, OFlags, ResolveFlags, openat2};
            // Kernel-resolved beneath the opened root: no path preflight/exec
            // symlink race and no dependency on control-plane host paths.
            let fd = openat2(
                &workspace,
                path,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
                Mode::empty(),
                ResolveFlags::BENEATH | ResolveFlags::NO_MAGICLINKS,
            )
            .map_err(|error| {
                use rustix::io::Errno;
                HostError(match error {
                    Errno::NOENT | Errno::NOTDIR | Errno::LOOP | Errno::XDEV => "INVALID_REQUEST",
                    Errno::NOSYS | Errno::INVAL => "UNSUPPORTED",
                    _ => "IO_ERROR",
                })
            })?;
            Ok(File::from(fd))
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = path;
            reject("UNSUPPORTED")
        }
    }

    pub fn get(&self, env: u64, id: &str) -> Result<Operation> {
        self.check_env(env)?;
        ensure!(valid_id(id), HostError("INVALID_REQUEST"));
        let journal = self.journal.lock().unwrap();
        let state: Option<String> = journal
            .db
            .query_row("SELECT state FROM operation WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()?;
        state
            .map(|s| serde_json::from_str(&s).map_err(Into::into))
            .unwrap_or(Ok(Operation::Unknown))
    }

    /// Commit before spawning, without awaiting network IO. Work belongs to the
    /// host, never to a connection task. Capacity is rejection, not queuing.
    pub fn start(self: &Arc<Self>, env: u64, id: &str, spec: ExecSpec) -> Result<()> {
        self.check_env(env)?;
        ensure!(valid_id(id), HostError("INVALID_REQUEST"));
        // A typed, fixed-field serialization canonicalizes JSON field order.
        let request = serde_json::to_string(&("exec.start", &self.installation.binding, &spec))?;
        let hash = Sha256::digest(request.as_bytes())
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let mut journal = self.journal.lock().unwrap();
        let previous: Option<(String, String)> = journal
            .db
            .query_row(
                "SELECT request,hash FROM operation WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        if let Some(previous) = previous {
            if previous != (request, hash) {
                return reject("CONFLICT");
            }
            return Ok(()); // Including Interrupted: never run it again.
        }
        spec.validate().map_err(|_| HostError("INVALID_REQUEST"))?;
        if self.closed.load(Ordering::SeqCst) || journal.active {
            return reject("CAPACITY_EXCEEDED");
        }
        if journal
            .db
            .query_row("SELECT COUNT(*) FROM operation", [], |r| r.get::<_, i64>(0))?
            >= MAX_RECORDS
        {
            return reject("CAPACITY_EXCEEDED");
        }
        let cwd = self.cwd(&spec.guest_cwd)?;
        journal.db.execute(
            "INSERT INTO operation VALUES(?1,?2,?3,?4)",
            params![
                id,
                request,
                hash,
                serde_json::to_string(&Operation::Accepted)?
            ],
        )?;
        journal.active = true;
        let host = Arc::clone(self);
        let id = id.to_owned();
        tokio::spawn(async move {
            let outcome = host.run(&id, &spec, cwd).await;
            let mut journal = host.journal.lock().unwrap();
            if let Err(error) = outcome {
                // A storage/runner failure must stop further admission. Do not
                // claim that an executed mutation failed without side effects.
                host.closed.store(true, Ordering::SeqCst);
                let state = Operation::Failed {
                    error: "IO_ERROR".into(),
                    completion_unknown: true,
                };
                let _ = journal.db.execute(
                    "UPDATE operation SET state=?1 WHERE id=?2 AND (state=?3 OR state=?4)",
                    params![
                        serde_json::to_string(&state).unwrap(),
                        id,
                        serde_json::to_string(&Operation::Accepted).unwrap(),
                        serde_json::to_string(&Operation::Running).unwrap()
                    ],
                );
                eprintln!("host operation reconciliation required: {error}");
            }
            journal.active = false;
            host.idle.notify_one();
        });
        Ok(())
    }
    fn save(&self, id: &str, state: Operation) -> Result<()> {
        let changed = self.journal.lock().unwrap().db.execute(
            "UPDATE operation SET state=?1 WHERE id=?2",
            params![serde_json::to_string(&state)?, id],
        )?;
        ensure!(changed == 1, "operation record disappeared");
        Ok(())
    }
    async fn run(&self, id: &str, spec: &ExecSpec, cwd: File) -> Result<()> {
        self.save(id, Operation::Running)?; // Durable intent before possible spawn.
        let result = execute(spec, cwd, &self.installation.workspace).await;
        match result {
            Ok(result) => self.save(id, Operation::Succeeded { result }),
            Err(error) => {
                eprintln!("host exec failed: {error}");
                self.closed.store(true, Ordering::SeqCst);
                self.save(
                    id,
                    Operation::Failed {
                        error: "IO_ERROR".into(),
                        completion_unknown: true,
                    },
                )
            }
        }
    }
    /// Graceful shutdown waits for already accepted bounded work. Disconnecting
    /// a client never calls this and never cancels its accepted operation.
    pub async fn shutdown(&self) {
        self.closed.store(true, Ordering::SeqCst);
        loop {
            let notified = self.idle.notified();
            if !self.journal.lock().unwrap().active {
                break;
            }
            notified.await;
        }
    }
}

async fn execute(spec: &ExecSpec, cwd: File, workspace: &Path) -> Result<ExecResult> {
    let mut command = Command::new("/bin/bash");
    command
        .args(["--noprofile", "--norc", "-c", &spec.command])
        .env_clear()
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("HOME", workspace)
        .env("LANG", "C.UTF-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .process_group(0);
    // Only async-signal-safe libc calls between fork and exec. The opened cwd
    // survives path replacement; CLOEXEC closes it after fchdir in the child.
    unsafe {
        command.pre_exec(move || {
            if libc::fchdir(cwd.as_raw_fd()) != 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    let pid = child.id().context("missing child PID")?;
    let mut group = ProcessGroup {
        pid: pid as i32,
        armed: true,
    };
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    let mut out_open = true;
    let mut err_open = true;
    let mut output = Vec::new();
    let mut output_bytes = 0u64;
    let mut a = [0u8; 4096];
    let mut b = [0u8; 4096];
    let deadline = tokio::time::sleep(Duration::from_millis(spec.timeout_ms));
    tokio::pin!(deadline);
    let mut timed_out = false;
    // Do not reap the leader while draining pipes: its PID/process-group ID
    // cannot be reused before timeout cleanup. Background pipe holders count
    // against the same deadline. Detached daemons are outside this profile.
    while out_open || err_open {
        let chunk = tokio::select! {
            n = stdout.read(&mut a), if out_open => { let n = n?; out_open = n != 0; &a[..n] },
            n = stderr.read(&mut b), if err_open => { let n = n?; err_open = n != 0; &b[..n] },
            _ = &mut deadline => { timed_out = true; break; },
        };
        output_bytes = output_bytes.saturating_add(chunk.len() as u64);
        let keep = chunk
            .len()
            .min((spec.output_limit as usize).saturating_sub(output.len()));
        output.extend_from_slice(&chunk[..keep]);
    }
    let status = if timed_out {
        None
    } else {
        tokio::select! {
            status = child.wait() => Some(status?),
            _ = &mut deadline => { timed_out = true; None },
        }
    };
    let status = if let Some(status) = status {
        status
    } else {
        // Only the current, unreaped child group; never a journal-restored PID.
        let rc = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
        if rc != 0 && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH) {
            return Err(io::Error::last_os_error().into());
        }
        tokio::time::timeout(Duration::from_secs(2), child.wait())
            .await
            .context("child termination unconfirmed")??
    };
    group.armed = false; // The leader has been reaped; never signal this ID again.
    Ok(ExecResult {
        exit_code: status.code(),
        termination: if timed_out {
            "timedOut"
        } else if status.code().is_some() {
            "exited"
        } else {
            "signalled"
        }
        .into(),
        truncated: output_bytes > output.len() as u64 || timed_out,
        output,
        output_bytes,
    })
}

// While armed, the leader has not been reaped, so this process-group ID cannot
// be reused. Covers IO errors and future cancellation, not a hard daemon crash.
struct ProcessGroup {
    pid: i32,
    armed: bool,
}
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        if self.armed {
            unsafe {
                libc::kill(-self.pid, libc::SIGKILL);
            }
        }
    }
}
