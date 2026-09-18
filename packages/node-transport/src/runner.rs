//! Opt-in trusted Unix runner execution. This is not an isolation boundary.
//! The daemon must have exclusive ownership of its journal; never replay on boot.
use std::{
    fs::{self, File, OpenOptions},
    io,
    os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Component, Path, PathBuf},
    process::{Command as StdCommand, Stdio},
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

#[cfg(target_os = "macos")]
use std::{
    ffi::CString,
    os::{fd::FromRawFd, unix::ffi::OsStrExt},
};

pub const MAX_OUTPUT: u32 = 8192;
pub const MAX_TIMEOUT_MS: u64 = 60_000;
pub const MAX_RECORDS: i64 = 10_000;
pub const MAX_ACTIVE_WORKSPACES: u64 = 1;
pub const MAX_WORKSPACE_BYTES: u64 = 50 * 1024 * 1024 * 1024;

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
        let cwd = Path::new(&self.guest_cwd);
        ensure!(
            !self.guest_cwd.is_empty()
                && self.guest_cwd.len() <= 4096
                && !self.guest_cwd.contains('\0')
                && !cwd.is_absolute()
                && cwd
                    .components()
                    .all(|component| matches!(component, Component::CurDir | Component::Normal(_))),
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

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerStatus {
    pub lifecycle: String,
    pub active: bool,
    pub operation_records: u64,
    pub operation_capacity: u64,
    pub error: Option<String>,
    pub active_workspaces: u64,
    pub retained_workspaces: u64,
    pub workspace_bytes: u64,
    pub workspace_capacity: u64,
    pub workspace_byte_limit: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceStatus {
    pub thread_id: String,
    pub state: String,
    pub kind: String,
    pub retained: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_remote: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_oid: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositorySource {
    pub url: String,
    pub branch: String,
}

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
fn reject<T>(code: &'static str) -> Result<T> {
    Err(RunnerError(code).into())
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

#[cfg(target_os = "macos")]
fn open_beneath_without_symlinks(mut directory: File, path: &Path) -> Result<File> {
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(name) => {
                let name =
                    CString::new(name.as_bytes()).map_err(|_| RunnerError("INVALID_REQUEST"))?;
                let fd = unsafe {
                    libc::openat(
                        directory.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    return Err(
                        RunnerError(match io::Error::last_os_error().raw_os_error() {
                            Some(libc::ENOENT | libc::ENOTDIR | libc::ELOOP) => "INVALID_REQUEST",
                            _ => "IO_ERROR",
                        })
                        .into(),
                    );
                }
                // SAFETY: openat returned a new owned descriptor.
                directory = unsafe { File::from_raw_fd(fd) };
            }
            _ => return reject("INVALID_REQUEST"),
        }
    }
    Ok(directory)
}

struct Journal {
    db: Connection,
    // A kernel-released lock, not a stale-PID lock. Never unlink/replace this file.
    _lock: File,
    active: bool,
    active_thread: Option<String>,
}

pub struct Runner {
    installation: Installation,
    workspace_root: PathBuf,
    recovery_quarantine: PathBuf,
    journal: Mutex<Journal>,
    accepting: AtomicBool,
    faulted: AtomicBool,
    cancel_active: AtomicBool,
    cancel: Notify,
    idle: Notify,
}

impl Runner {
    pub fn installation(&self) -> &Installation {
        &self.installation
    }

    /// Complete an offline, identity-preserving restore. Archive extraction
    /// necessarily changes the workspace directory inode, so this narrowly
    /// refreshes that physical anchor while retaining every logical binding.
    pub fn acknowledge_recovery(state: &Path, peer: EndpointId, workspace: &Path) -> Result<()> {
        ensure!(
            cfg!(any(target_os = "linux", target_os = "macos")) && unsafe { libc::geteuid() } != 0,
            "runner recovery requires non-root Linux or macOS"
        );
        let state_meta = fs::symlink_metadata(state)?;
        ensure!(
            state_meta.is_dir() && state_meta.mode() & 0o077 == 0,
            "state directory must be private and not a symlink"
        );
        let lock = private_file(&state.join("owner.lock"), false)?;
        lock.try_lock()
            .context("another daemon owns this journal")?;
        let marker_path = state.join("restore-quarantine");
        let _marker = private_file(&marker_path, false)
            .context("restore quarantine is required for physical workspace recovery")?;
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
        let document: String =
            db.query_row("SELECT document FROM installation WHERE id=1", [], |r| {
                r.get(0)
            })?;
        let mut installation: Installation = serde_json::from_str(&document)?;
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
        let canonical_workspace = fs::canonicalize(workspace)?;
        ensure!(
            canonical_workspace == installation.workspace,
            "recovery workspace must match the permanent canonical path"
        );
        let metadata = fs::metadata(&canonical_workspace)?;
        ensure!(metadata.is_dir(), "workspace must be a directory");
        installation.workspace_device = metadata.dev();
        installation.workspace_inode = metadata.ino();
        let recovered_document = serde_json::to_string(&installation)?;
        db.execute_batch(
            "BEGIN IMMEDIATE;
             DROP TRIGGER immutable_installation_update;",
        )?;
        let recovery = (|| -> Result<()> {
            ensure!(
                db.execute(
                    "UPDATE installation SET document=?1 WHERE id=1 AND document=?2",
                    params![recovered_document, document],
                )? == 1,
                "installation changed during recovery"
            );
            db.execute_batch(
                "CREATE TRIGGER immutable_installation_update BEFORE UPDATE ON installation BEGIN SELECT RAISE(ABORT, 'immutable installation'); END;
                 COMMIT;",
            )?;
            Ok(())
        })();
        if recovery.is_err() {
            let _ = db.execute_batch("ROLLBACK");
        }
        recovery?;
        fs::remove_file(marker_path)?;
        File::open(state)?.sync_all()?;
        Ok(())
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
            cfg!(any(target_os = "linux", target_os = "macos")),
            "runner execution requires Linux or macOS"
        );
        ensure!(
            unsafe { libc::geteuid() } != 0,
            "refusing root runner execution"
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
            CREATE TABLE workspace(thread_id TEXT PRIMARY KEY, state TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
              kind TEXT NOT NULL, device INTEGER NOT NULL, inode INTEGER NOT NULL, error TEXT);
            CREATE TABLE workspace_base(thread_id TEXT PRIMARY KEY REFERENCES workspace(thread_id),
              remote TEXT NOT NULL, ref_name TEXT NOT NULL, oid TEXT);
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
            cfg!(any(target_os = "linux", target_os = "macos")) && unsafe { libc::geteuid() } != 0,
            "runner execution requires non-root Linux or macOS"
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
        db.execute_batch("CREATE TABLE IF NOT EXISTS workspace(thread_id TEXT PRIMARY KEY, state TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
            kind TEXT NOT NULL, device INTEGER NOT NULL, inode INTEGER NOT NULL, error TEXT);
            CREATE TABLE IF NOT EXISTS workspace_base(thread_id TEXT PRIMARY KEY REFERENCES workspace(thread_id),
              remote TEXT NOT NULL, ref_name TEXT NOT NULL, oid TEXT);")?;
        let recovery_quarantine = state.join("restore-quarantine");
        let quarantined = recovery_quarantine.exists();
        let workspace_root = state.join("workspaces");
        if !workspace_root.exists() {
            let mut builder = fs::DirBuilder::new();
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700).create(&workspace_root)?;
        }
        let workspace_meta = fs::symlink_metadata(&workspace_root)?;
        ensure!(
            workspace_meta.is_dir() && workspace_meta.mode() & 0o077 == 0,
            "workspace allocation root must be private and not a symlink"
        );
        // A crash can strand a filesystem tree between two durable transitions.
        // Preserve it and require explicit inspection; never infer that it is safe
        // to delete user work during startup reconciliation.
        db.execute("UPDATE workspace SET state='failed', error='allocation interrupted; workspace retained' WHERE state='allocating' OR state='releasing'", [])?;
        Ok(Arc::new(Self {
            installation,
            workspace_root,
            recovery_quarantine,
            journal: Mutex::new(Journal {
                db,
                _lock: lock,
                active: false,
                active_thread: None,
            }),
            accepting: AtomicBool::new(!quarantined),
            faulted: AtomicBool::new(false),
            cancel_active: AtomicBool::new(false),
            cancel: Notify::new(),
            idle: Notify::new(),
        }))
    }

    pub fn status(&self) -> Result<RunnerStatus> {
        let workspace_error = self.cwd(None, ".").err().map(|error| {
            error
                .downcast_ref::<RunnerError>()
                .map_or("IO_ERROR", |error| error.0)
                .to_owned()
        });
        if workspace_error.is_some() {
            self.accepting.store(false, Ordering::SeqCst);
            self.faulted.store(true, Ordering::SeqCst);
        }
        let journal = self.journal.lock().unwrap();
        let operation_records = journal
            .db
            .query_row("SELECT COUNT(*) FROM operation", [], |r| r.get::<_, i64>(0))?
            as u64;
        let active_workspaces = journal.db.query_row(
            "SELECT COUNT(*) FROM workspace WHERE state='available'",
            [],
            |r| r.get::<_, i64>(0),
        )? as u64;
        let retained_workspaces = journal.db.query_row(
            "SELECT COUNT(*) FROM workspace WHERE state='released' OR state='failed'",
            [],
            |r| r.get::<_, i64>(0),
        )? as u64;
        let workspace_bytes = directory_bytes(&self.workspace_root).unwrap_or(MAX_WORKSPACE_BYTES);
        Ok(RunnerStatus {
            lifecycle: if self.recovery_quarantine.exists() {
                "recoveryRequired"
            } else if self.faulted.load(Ordering::SeqCst) {
                "faulted"
            } else if self.accepting.load(Ordering::SeqCst) {
                "ready"
            } else {
                "draining"
            }
            .into(),
            active: journal.active,
            operation_records,
            operation_capacity: MAX_RECORDS as u64,
            error: workspace_error.or_else(|| {
                self.faulted
                    .load(Ordering::SeqCst)
                    .then(|| "IO_ERROR".into())
            }),
            active_workspaces,
            retained_workspaces,
            workspace_bytes,
            workspace_capacity: MAX_ACTIVE_WORKSPACES,
            workspace_byte_limit: MAX_WORKSPACE_BYTES,
        })
    }

    pub fn allocate(
        &self,
        thread_id: &str,
        repository: Option<&RepositorySource>,
    ) -> Result<WorkspaceStatus> {
        ensure!(valid_id(thread_id), RunnerError("INVALID_REQUEST"));
        ensure!(
            thread_id != self.installation.binding.thread_id,
            RunnerError("CONFLICT")
        );
        let journal = self.journal.lock().unwrap();
        if let Some((state, kind, error, base_remote, base_ref, base_oid)) = journal
            .db
            .query_row(
                "SELECT w.state,w.kind,w.error,b.remote,b.ref_name,b.oid FROM workspace w LEFT JOIN workspace_base b USING(thread_id) WHERE w.thread_id=?1",
                [thread_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get(3)?, r.get(4)?, r.get(5)?)),
            )
            .optional()?
        {
            return match state.as_str() {
                "available" => Ok(WorkspaceStatus {
                    thread_id: thread_id.into(),
                    state,
                    kind,
                    retained: false,
                    base_remote,
                    base_ref,
                    base_oid,
                }),
                "released" => reject("CONFLICT"),
                "failed" => Err(RunnerErrorDetail(
                    "IO_ERROR",
                    error.unwrap_or_else(|| "workspace allocation previously failed".into()),
                )
                .into()),
                _ => reject("IO_ERROR"),
            };
        }
        ensure!(
            self.accepting.load(Ordering::SeqCst),
            RunnerError("DRAINING")
        );
        ensure!(!journal.active, RunnerError("CAPACITY_EXCEEDED"));
        let active = journal.db.query_row("SELECT COUNT(*) FROM workspace WHERE state='available' OR state='allocating' OR state='releasing'", [], |r| r.get::<_, i64>(0))? as u64;
        ensure!(
            active < MAX_ACTIVE_WORKSPACES,
            RunnerError("CAPACITY_EXCEEDED")
        );
        ensure!(
            directory_bytes(&self.workspace_root)? < MAX_WORKSPACE_BYTES,
            RunnerError("CAPACITY_EXCEEDED")
        );
        let destination = self.workspace_root.join(thread_id);
        ensure!(!destination.exists(), RunnerError("CONFLICT"));
        journal.db.execute(
            "INSERT INTO workspace VALUES(?1,'allocating',?2,'pending',0,0,NULL)",
            params![thread_id, destination.to_string_lossy()],
        )?;
        drop(journal);

        let provisioned = (|| -> Result<(&'static str, Option<GitBase>)> {
            let base = git_worktree(
                &self.installation.workspace,
                &self.workspace_root,
                &destination,
                thread_id,
                repository,
                |remote, ref_name, oid| {
                    self.journal.lock().unwrap().db.execute(
                        "INSERT INTO workspace_base VALUES(?1,?2,?3,?4)
                         ON CONFLICT(thread_id) DO UPDATE SET remote=excluded.remote,ref_name=excluded.ref_name,oid=excluded.oid",
                        params![thread_id, remote, ref_name, oid],
                    )?;
                    Ok(())
                },
            )?;
            let kind = if base.is_some() {
                "git"
            } else {
                copy_directory(&self.installation.workspace, &destination)?;
                "copy"
            };
            let metadata = fs::metadata(&destination)?;
            let journal = self.journal.lock().unwrap();
            journal.db.execute("UPDATE workspace SET state='available',kind=?1,device=?2,inode=?3 WHERE thread_id=?4 AND state='allocating'",
                params![kind, i64::try_from(metadata.dev())?, i64::try_from(metadata.ino())?, thread_id])?;
            Ok((kind, base))
        })();
        let (kind, base) = match provisioned {
            Ok(value) => value,
            Err(error) => {
                let journal = self.journal.lock().unwrap();
                let discovered_remote = journal
                    .db
                    .query_row(
                        "SELECT remote FROM workspace_base WHERE thread_id=?1",
                        [thread_id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?;
                let message = allocation_error(
                    &error,
                    repository
                        .map(|source| source.url.as_str())
                        .or(discovered_remote.as_deref()),
                );
                journal.db.execute(
                    "UPDATE workspace SET state='failed',error=?1 WHERE thread_id=?2",
                    params![message, thread_id],
                )?;
                return Err(RunnerErrorDetail("IO_ERROR", message).into());
            }
        };
        File::open(&self.workspace_root)?.sync_all()?;
        Ok(WorkspaceStatus {
            thread_id: thread_id.into(),
            state: "available".into(),
            kind: kind.into(),
            retained: false,
            base_remote: base.as_ref().map(|base| base.remote.clone()),
            base_ref: base.as_ref().map(|base| base.ref_name.clone()),
            base_oid: base.map(|base| base.oid),
        })
    }

    pub fn release(&self, thread_id: &str) -> Result<WorkspaceStatus> {
        ensure!(valid_id(thread_id), RunnerError("INVALID_REQUEST"));
        ensure!(
            thread_id != self.installation.binding.thread_id,
            RunnerError("CONFLICT")
        );
        let journal = self.journal.lock().unwrap();
        ensure!(
            journal.active_thread.as_deref() != Some(thread_id),
            RunnerError("CAPACITY_EXCEEDED")
        );
        let row = journal
            .db
            .query_row(
                "SELECT w.state,w.path,w.kind,b.remote,b.ref_name,b.oid FROM workspace w LEFT JOIN workspace_base b USING(thread_id) WHERE w.thread_id=?1",
                [thread_id],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        PathBuf::from(r.get::<_, String>(1)?),
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, Option<String>>(5)?,
                    ))
                },
            )
            .optional()?;
        let Some((state, workspace, kind, base_remote, base_ref, base_oid)) = row else {
            return reject("ENVIRONMENT_MISSING");
        };
        if state == "released" {
            return Ok(WorkspaceStatus {
                thread_id: thread_id.into(),
                state,
                kind,
                retained: workspace.exists(),
                base_remote,
                base_ref,
                base_oid,
            });
        }
        if state == "failed" {
            let kind = if kind == "pending" {
                "retained".to_owned()
            } else {
                kind
            };
            journal.db.execute(
                "UPDATE workspace SET state='released',kind=?1 WHERE thread_id=?2",
                params![kind, thread_id],
            )?;
            return Ok(WorkspaceStatus {
                thread_id: thread_id.into(),
                state: "released".into(),
                kind,
                retained: workspace.exists(),
                base_remote,
                base_ref,
                base_oid,
            });
        }
        ensure!(state == "available", RunnerError("IO_ERROR"));
        journal.db.execute(
            "UPDATE workspace SET state='releasing' WHERE thread_id=?1",
            [thread_id],
        )?;
        drop(journal);

        let retained = if kind == "git" {
            let status = StdCommand::new("git")
                .args(["-C"])
                .arg(&workspace)
                .args(["status", "--porcelain", "--untracked-files=all"])
                .output()?;
            let workspace_head = StdCommand::new("git")
                .args(["-C"])
                .arg(&workspace)
                .args(["rev-parse", "HEAD"])
                .output()?;
            let expected_head = if let Some(oid) = &base_oid {
                format!("{oid}\n").into_bytes()
            } else {
                let output = StdCommand::new("git")
                    .args(["-C"])
                    .arg(&self.installation.workspace)
                    .args(["rev-parse", "HEAD"])
                    .output()?;
                if !output.status.success() || !output.stderr.is_empty() {
                    return self.fail_release(thread_id, "could not inspect git template");
                }
                output.stdout
            };
            if !status.status.success()
                || !status.stderr.is_empty()
                || !workspace_head.status.success()
                || !workspace_head.stderr.is_empty()
            {
                return self.fail_release(thread_id, "could not inspect git workspace");
            }
            if status.stdout.is_empty() && workspace_head.stdout == expected_head {
                let worktree_owner = if base_oid.is_some() {
                    self.workspace_root.join("repository.git")
                } else {
                    self.installation.workspace.clone()
                };
                let status = StdCommand::new("git")
                    .arg("--git-dir")
                    .arg(worktree_owner)
                    .args(["worktree", "remove", "--"])
                    .arg(&workspace)
                    .status()?;
                if !status.success() {
                    return self.fail_release(thread_id, "could not remove clean git workspace");
                }
                false
            } else {
                true
            }
        } else {
            // A copied non-Git tree has no trustworthy clean/dirty oracle.
            true
        };
        let journal = self.journal.lock().unwrap();
        journal.db.execute(
            "UPDATE workspace SET state='released',error=NULL WHERE thread_id=?1",
            [thread_id],
        )?;
        File::open(&self.workspace_root)?.sync_all()?;
        Ok(WorkspaceStatus {
            thread_id: thread_id.into(),
            state: "released".into(),
            kind,
            retained,
            base_remote,
            base_ref,
            base_oid,
        })
    }

    fn fail_release<T>(&self, thread_id: &str, message: &str) -> Result<T> {
        self.journal.lock().unwrap().db.execute(
            "UPDATE workspace SET state='failed',error=?1 WHERE thread_id=?2",
            params![message, thread_id],
        )?;
        reject("IO_ERROR")
    }

    /// Draining is local operator authority. Remote peers may observe it but
    /// cannot enter or leave it. Existing operations remain inspectable.
    pub fn drain(&self) {
        self.accepting.store(false, Ordering::SeqCst);
    }

    pub fn resume(&self) -> Result<()> {
        ensure!(
            !self.recovery_quarantine.exists() && !self.faulted.load(Ordering::SeqCst),
            "runner requires offline operator recovery"
        );
        self.cancel_active.store(false, Ordering::SeqCst);
        self.accepting.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn check_env(&self, env: u64) -> Result<()> {
        if env != self.installation.binding.environment_id {
            return reject("ENVIRONMENT_MISSING");
        }
        Ok(())
    }
    pub fn inspect(&self, env: u64) -> Result<&Installation> {
        self.check_env(env)?;
        self.cwd(None, ".")?;
        Ok(&self.installation)
    }

    fn cwd(&self, thread_id: Option<&str>, path: &str) -> Result<File> {
        let (root, expected_device, expected_inode) = if let Some(thread_id) = thread_id {
            ensure!(valid_id(thread_id), RunnerError("INVALID_REQUEST"));
            let row = self.journal.lock().unwrap().db.query_row(
                "SELECT path,device,inode FROM workspace WHERE thread_id=?1 AND state='available'", [thread_id],
                |r| Ok((PathBuf::from(r.get::<_, String>(0)?), r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)? as u64)),
            ).optional()?;
            row.ok_or(RunnerError("ENVIRONMENT_MISSING"))?
        } else {
            (
                self.installation.workspace.clone(),
                self.installation.workspace_device,
                self.installation.workspace_inode,
            )
        };
        let workspace = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(&root)
            .map_err(|error| {
                RunnerError(match error.raw_os_error() {
                    Some(libc::ENOENT | libc::ELOOP | libc::ENOTDIR) => "ENVIRONMENT_MISSING",
                    _ => "IO_ERROR",
                })
            })?;
        let meta = workspace.metadata()?;
        if meta.dev() != expected_device || meta.ino() != expected_inode {
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
                RunnerError(match error {
                    Errno::NOENT | Errno::NOTDIR | Errno::LOOP | Errno::XDEV => "INVALID_REQUEST",
                    Errno::NOSYS | Errno::INVAL => "UNSUPPORTED",
                    _ => "IO_ERROR",
                })
            })?;
            Ok(File::from(fd))
        }
        #[cfg(target_os = "macos")]
        {
            open_beneath_without_symlinks(workspace, Path::new(path))
        }
        #[cfg(not(any(target_os = "linux", target_os = "macos")))]
        {
            let _ = (workspace, path);
            reject("UNSUPPORTED")
        }
    }

    pub fn get(&self, env: u64, id: &str) -> Result<Operation> {
        self.check_env(env)?;
        ensure!(valid_id(id), RunnerError("INVALID_REQUEST"));
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
    /// runner, never to a connection task. Capacity is rejection, not queuing.
    pub fn start(self: &Arc<Self>, env: u64, id: &str, spec: ExecSpec) -> Result<()> {
        self.start_in_workspace(env, None, id, spec)
    }

    pub fn start_in_workspace(
        self: &Arc<Self>,
        env: u64,
        thread_id: Option<&str>,
        id: &str,
        spec: ExecSpec,
    ) -> Result<()> {
        self.check_env(env)?;
        ensure!(valid_id(id), RunnerError("INVALID_REQUEST"));
        spec.validate()
            .map_err(|_| RunnerError("INVALID_REQUEST"))?;
        // Resolve the descriptor before taking the journal mutex; allocated
        // workspace identity is itself stored in that journal.
        let cwd = self.cwd(thread_id, &spec.guest_cwd)?;
        // A typed, fixed-field serialization canonicalizes JSON field order.
        let request = if let Some(thread_id) = thread_id {
            serde_json::to_string(&("exec.start", &self.installation.binding, thread_id, &spec))?
        } else {
            // Preserve protocol-v1 operation hashes for existing bound threads.
            serde_json::to_string(&("exec.start", &self.installation.binding, &spec))?
        };
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
        if self.faulted.load(Ordering::SeqCst) {
            return reject("IO_ERROR");
        }
        if !self.accepting.load(Ordering::SeqCst) {
            return reject("DRAINING");
        }
        if journal.active {
            return reject("CAPACITY_EXCEEDED");
        }
        if journal
            .db
            .query_row("SELECT COUNT(*) FROM operation", [], |r| r.get::<_, i64>(0))?
            >= MAX_RECORDS
        {
            return reject("CAPACITY_EXCEEDED");
        }
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
        journal.active_thread = thread_id.map(str::to_owned);
        let runner = Arc::clone(self);
        let id = id.to_owned();
        let workspace = thread_id.map_or_else(
            || runner.installation.workspace.clone(),
            |thread_id| runner.workspace_root.join(thread_id),
        );
        tokio::spawn(async move {
            let outcome = runner.run(&id, &spec, cwd, &workspace).await;
            let mut journal = runner.journal.lock().unwrap();
            if let Err(error) = outcome {
                // A storage/runner failure must stop further admission. Do not
                // claim that an executed mutation failed without side effects.
                runner.accepting.store(false, Ordering::SeqCst);
                runner.faulted.store(true, Ordering::SeqCst);
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
                let _ = error;
                eprintln!(
                    "{{\"level\":\"error\",\"event\":\"operation_reconciliation_required\",\"operationId\":{}}}",
                    serde_json::to_string(&id).unwrap()
                );
            }
            journal.active = false;
            journal.active_thread = None;
            runner.idle.notify_waiters();
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
    async fn run(&self, id: &str, spec: &ExecSpec, cwd: File, workspace: &Path) -> Result<()> {
        self.save(id, Operation::Running)?; // Durable intent before possible spawn.
        let result = execute(spec, cwd, workspace, &self.cancel_active, &self.cancel).await;
        match result {
            Ok(ExecutionOutcome::Completed(result)) => {
                self.save(id, Operation::Succeeded { result })
            }
            Ok(ExecutionOutcome::Cancelled) => self.save(
                id,
                Operation::Failed {
                    error: "CANCELLED".into(),
                    completion_unknown: false,
                },
            ),
            Err(error) => {
                let _ = error;
                eprintln!(
                    "{{\"level\":\"error\",\"event\":\"operation_failed\",\"operationId\":{}}}",
                    serde_json::to_string(id).unwrap()
                );
                self.accepting.store(false, Ordering::SeqCst);
                self.faulted.store(true, Ordering::SeqCst);
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
    pub async fn shutdown(&self, cancel_active: bool) {
        self.drain();
        if cancel_active {
            self.cancel_active.store(true, Ordering::SeqCst);
            self.cancel.notify_waiters();
        }
        loop {
            let notified = self.idle.notified();
            if !self.journal.lock().unwrap().active {
                break;
            }
            notified.await;
        }
    }
}

#[derive(Clone)]
struct GitBase {
    remote: String,
    ref_name: String,
    oid: String,
}

fn git_worktree(
    source: &Path,
    workspace_root: &Path,
    destination: &Path,
    thread_id: &str,
    configured: Option<&RepositorySource>,
    mut record_base: impl FnMut(&str, &str, Option<&str>) -> Result<()>,
) -> Result<Option<GitBase>> {
    let probe = StdCommand::new("git")
        .args(["-C"])
        .arg(source)
        .args(["rev-parse", "--show-toplevel"])
        .output();
    let Ok(probe) = probe else {
        return Ok(None);
    };
    if !probe.status.success() {
        return Ok(None);
    }
    let top = PathBuf::from(String::from_utf8(probe.stdout)?.trim());
    if fs::canonicalize(top)? != fs::canonicalize(source)? {
        return Ok(None);
    }
    let (remote, branch) = if let Some(configured) = configured {
        validate_remote_url(&configured.url)?;
        validate_branch(&configured.branch)?;
        (configured.url.clone(), configured.branch.clone())
    } else {
        discover_remote_default(source)?
    };
    let ref_name = format!("refs/heads/{branch}");
    record_base(&remote, &ref_name, None)?;
    let control = workspace_root.join("repository.git");
    if control.exists() {
        let metadata = fs::symlink_metadata(&control)?;
        ensure!(
            metadata.is_dir() && !metadata.file_type().is_symlink(),
            "controlled git repository is not a directory"
        );
        ensure!(
            git_text_bare(&control, &["rev-parse", "--is-bare-repository"])? == "true",
            "controlled git repository is invalid"
        );
    } else {
        let temporary = workspace_root.join(format!("repository.git.tmp-{thread_id}"));
        if temporary.exists() {
            fs::remove_dir_all(&temporary)?;
        }
        let output = StdCommand::new("git")
            .args(["init", "--bare", "--"])
            .arg(&temporary)
            .output()?;
        ensure!(
            output.status.success(),
            "could not initialize controlled git repository"
        );
        fs::rename(&temporary, &control)?;
        File::open(workspace_root)?.sync_all()?;
    }
    let internal_ref = format!("refs/cube/bases/{thread_id}");
    let fetch = git_network_command()
        .arg("--git-dir")
        .arg(&control)
        .args([
            "fetch",
            "--no-tags",
            "--force",
            "--no-write-fetch-head",
            "--",
        ])
        .arg(&remote)
        .arg(format!("+{ref_name}:{internal_ref}"))
        .output()?;
    ensure!(
        fetch.status.success(),
        "git fetch failed: {}",
        String::from_utf8_lossy(&fetch.stderr).trim()
    );
    let resolved = StdCommand::new("git")
        .arg("--git-dir")
        .arg(&control)
        .args(["rev-parse", "--verify"])
        .arg(format!("{internal_ref}^{{commit}}"))
        .output()?;
    ensure!(
        resolved.status.success(),
        "fetched branch did not resolve to a commit"
    );
    let oid = String::from_utf8(resolved.stdout)?.trim().to_owned();
    ensure!(valid_oid(&oid), "fetch returned an invalid commit OID");
    record_base(&remote, &ref_name, Some(&oid))?;
    let output = StdCommand::new("git")
        .arg("--git-dir")
        .arg(&control)
        .args(["worktree", "add", "--detach", "--"])
        .arg(destination)
        .arg(&oid)
        .output()?;
    ensure!(
        output.status.success(),
        "git worktree add failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    );
    Ok(Some(GitBase {
        remote,
        ref_name,
        oid,
    }))
}

fn git_network_command() -> StdCommand {
    let mut command = StdCommand::new("git");
    command
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ALLOW_PROTOCOL", "file:https:ssh")
        .env("LC_ALL", "C")
        .env(
            "GIT_SSH_COMMAND",
            std::env::var("GIT_SSH_COMMAND").unwrap_or_else(|_| "ssh -oBatchMode=yes".into()),
        );
    command
}

fn validate_branch(branch: &str) -> Result<()> {
    ensure!(
        !branch.is_empty()
            && branch.len() <= 255
            && !branch.starts_with('-')
            && !branch.contains("..")
            && !branch.contains("//")
            && !branch.ends_with('/')
            && !branch.ends_with('.')
            && !branch.ends_with(".lock")
            && branch
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._/-".contains(&byte))
            && branch
                .split('/')
                .all(|part| !part.is_empty() && !part.starts_with('.')),
        "invalid remote branch"
    );
    Ok(())
}

fn validate_remote_url(url: &str) -> Result<()> {
    ensure!(
        !url.is_empty()
            && url.len() <= 4096
            && !url.starts_with('-')
            && !url
                .bytes()
                .any(|byte| byte.is_ascii_whitespace() || byte == 0),
        "invalid repository remote"
    );
    ensure!(
        !url.starts_with("ext::") && !url.starts_with("http://"),
        "unsupported repository remote"
    );
    ensure!(
        url.starts_with("https://")
            || url.starts_with("ssh://")
            || url.starts_with("file://")
            || Path::new(url).is_absolute()
            || (url.contains('@') && url.contains(':')),
        "unsupported repository remote"
    );
    ensure!(
        !(url.starts_with("https://") || url.starts_with("ssh://"))
            || !url.split_once("//").is_some_and(|(_, authority)| {
                authority.split('/').next().is_some_and(|value| {
                    value
                        .rsplit_once('@')
                        .is_some_and(|(userinfo, _)| userinfo.contains(':'))
                })
            }),
        "repository credentials must not be embedded in the URL"
    );
    ensure!(
        url.starts_with("https://")
            || url.starts_with("ssh://")
            || !url
                .split_once('@')
                .is_some_and(|(userinfo, _)| userinfo.contains(':')),
        "repository credentials must not be embedded in the URL"
    );
    Ok(())
}

fn discover_remote_default(source: &Path) -> Result<(String, String)> {
    let remotes = git_text(source, &["remote"])?;
    let remotes: Vec<&str> = remotes.lines().filter(|line| !line.is_empty()).collect();
    ensure!(!remotes.is_empty(), "git template has no configured remote");
    let current = git_text(source, &["symbolic-ref", "--quiet", "--short", "HEAD"]).ok();
    let configured = current.as_deref().and_then(|branch| {
        git_text(
            source,
            &["config", "--get", &format!("branch.{branch}.remote")],
        )
        .ok()
    });
    let remote = configured
        .as_deref()
        .filter(|name| *name != "." && remotes.contains(name))
        .or_else(|| remotes.contains(&"origin").then_some("origin"))
        .or_else(|| (remotes.len() == 1).then_some(remotes[0]))
        .context(
            "git template has ambiguous remotes; configure the current branch remote or origin",
        )?;
    ensure!(
        remote
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
            && !remote.starts_with('-'),
        "invalid git remote name"
    );
    let url = git_text(source, &["remote", "get-url", remote])?;
    validate_remote_url(&url)?;
    let advertised = git_network_command()
        .args(["ls-remote", "--symref", "--"])
        .arg(&url)
        .arg("HEAD")
        .output()?;
    ensure!(
        advertised.status.success(),
        "could not resolve remote default branch: {}",
        String::from_utf8_lossy(&advertised.stderr).trim()
    );
    let stdout = String::from_utf8(advertised.stdout)?;
    let branch = stdout
        .lines()
        .find_map(|line| {
            line.strip_prefix("ref: refs/heads/")?
                .strip_suffix("\tHEAD")
        })
        .context("remote has no resolvable default branch")?;
    validate_branch(branch)?;
    Ok((url, branch.to_owned()))
}

fn git_text(source: &Path, args: &[&str]) -> Result<String> {
    let output = StdCommand::new("git")
        .args(["-C"])
        .arg(source)
        .args(args)
        .output()?;
    ensure!(output.status.success(), "git metadata lookup failed");
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

fn git_text_bare(repository: &Path, args: &[&str]) -> Result<String> {
    let output = StdCommand::new("git")
        .arg("--git-dir")
        .arg(repository)
        .args(args)
        .output()?;
    ensure!(output.status.success(), "git metadata lookup failed");
    Ok(String::from_utf8(output.stdout)?.trim().to_owned())
}

fn valid_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn allocation_error(error: &anyhow::Error, remote: Option<&str>) -> String {
    let detail = error.to_string();
    let lower = detail.to_ascii_lowercase();
    if lower.contains("authentication failed")
        || lower.contains("could not read username")
        || lower.contains("could not read password")
        || lower.contains("permission denied (publickey")
        || lower.contains("returned error: 401")
        || lower.contains("returned error: 403")
    {
        let github = remote.is_some_and(|url| url.contains("github.com"));
        let gh = StdCommand::new("gh").arg("--version").output().is_ok();
        return if github && !gh {
            "git fetch authentication failed; gh is not installed in the runner environment — install it and run `gh auth setup-git`, or configure a non-interactive credential helper/SSH key for the runner service account".into()
        } else if github {
            "git fetch authentication failed; authenticate the runner service account with `gh auth setup-git`, a non-interactive credential helper, or an SSH key".into()
        } else {
            "git fetch authentication failed; configure a non-interactive credential helper or SSH key for the runner service account".into()
        };
    }
    if lower.contains("could not resolve host")
        || lower.contains("failed to connect")
        || lower.contains("network is unreachable")
    {
        return "git fetch failed because the repository remote is unreachable; no stale local fallback was used".into();
    }
    if lower.contains("couldn't find remote ref") || lower.contains("not our ref") {
        return "git fetch failed because the configured remote branch does not exist; no stale local fallback was used".into();
    }
    if lower.starts_with("git fetch failed:") {
        return "git fetch failed for the configured repository branch; check runner network, repository access and branch configuration — no stale local fallback was used".into();
    }
    let safe: String = detail
        .chars()
        .filter(|character| !character.is_control() || *character == ' ')
        .take(160)
        .collect();
    format!("{safe}; no stale local fallback was used")
}

fn copy_directory(source: &Path, destination: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(source)?;
    ensure!(
        metadata.is_dir() && !metadata.file_type().is_symlink(),
        "copy source must be a directory"
    );
    let mut builder = fs::DirBuilder::new();
    use std::os::unix::fs::DirBuilderExt;
    builder.mode(metadata.mode() & 0o777).create(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let from = entry.path();
        let to = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&from)?;
        if metadata.is_dir() {
            copy_directory(&from, &to)?;
        } else if metadata.is_file() {
            fs::copy(&from, &to)?;
            fs::set_permissions(&to, metadata.permissions())?;
        } else if metadata.file_type().is_symlink() {
            std::os::unix::fs::symlink(fs::read_link(&from)?, &to)?;
        } else {
            ensure!(false, "unsupported file type in workspace template");
        }
    }
    Ok(())
}

fn directory_bytes(root: &Path) -> Result<u64> {
    let mut total = 0u64;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.is_dir() {
            total = total.saturating_add(directory_bytes(&entry.path())?);
        } else {
            total = total.saturating_add(metadata.len());
        }
    }
    Ok(total)
}

enum ExecutionOutcome {
    Completed(ExecResult),
    Cancelled,
}

async fn execute(
    spec: &ExecSpec,
    cwd: File,
    workspace: &Path,
    cancel_active: &AtomicBool,
    cancel: &Notify,
) -> Result<ExecutionOutcome> {
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
    let mut cancelled = false;
    let cancellation = async {
        if !cancel_active.load(Ordering::SeqCst) {
            cancel.notified().await;
        }
    };
    tokio::pin!(cancellation);
    // Do not reap the leader while draining pipes: its PID/process-group ID
    // cannot be reused before timeout cleanup. Background pipe holders count
    // against the same deadline. Detached daemons are outside this profile.
    while out_open || err_open {
        let chunk = tokio::select! {
            n = stdout.read(&mut a), if out_open => { let n = n?; out_open = n != 0; &a[..n] },
            n = stderr.read(&mut b), if err_open => { let n = n?; err_open = n != 0; &b[..n] },
            _ = &mut deadline => { timed_out = true; break; },
            _ = &mut cancellation => { cancelled = true; break; },
        };
        output_bytes = output_bytes.saturating_add(chunk.len() as u64);
        let keep = chunk
            .len()
            .min((spec.output_limit as usize).saturating_sub(output.len()));
        output.extend_from_slice(&chunk[..keep]);
    }
    let status = if timed_out || cancelled {
        None
    } else {
        tokio::select! {
            status = child.wait() => Some(status?),
            _ = &mut deadline => { timed_out = true; None },
            _ = &mut cancellation => { cancelled = true; None },
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
    if cancelled {
        return Ok(ExecutionOutcome::Cancelled);
    }
    Ok(ExecutionOutcome::Completed(ExecResult {
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
    }))
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

#[cfg(test)]
mod tests {
    use super::{allocation_error, validate_branch, validate_remote_url};

    #[test]
    fn repository_inputs_and_auth_failures_are_safe_and_actionable() {
        for branch in [
            "-main",
            "../main",
            "main.lock",
            "feature//escape",
            "refs heads/main",
        ] {
            assert!(
                validate_branch(branch).is_err(),
                "accepted branch {branch:?}"
            );
        }
        for remote in [
            "--upload-pack=evil",
            "ext::evil",
            "http://example.test/repo",
            "relative/repo",
            "user:password@example.test:repo",
        ] {
            assert!(
                validate_remote_url(remote).is_err(),
                "accepted remote {remote:?}"
            );
        }
        let message = allocation_error(
            &anyhow::anyhow!(
                "git fetch failed: fatal: could not read Username for 'https://github.com'"
            ),
            Some("https://github.com/private/repository.git"),
        );
        assert!(message.contains("authentication failed"));
        assert!(message.contains("runner service account"));
        assert!(!message.contains("private/repository"));
    }
}
