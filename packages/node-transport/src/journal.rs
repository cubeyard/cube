//! The runner's durable state: the immutable installation, one record per
//! VM, lease epochs and the base image. SQLite with FULL synchronous
//! durability, owned by one process through a kernel-released file lock.
//!
//! Layout of a state directory:
//!
//! ```text
//! owner.lock  journal.db  images/<sha256>.qcow2 (0400)  vms/<slot>/
//! ```
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use iroh::EndpointId;
use rusqlite::{Connection, OpenFlags, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::runner::{RunnerError, reject, valid_id};

/// Protocol-2 journals are version 1; they are refused, never migrated.
pub const JOURNAL_VERSION: u32 = 3;
pub const MAX_EPOCH: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub thread_id: String,
    pub environment_id: u64,
    pub node_id: String,
}

/// Upper bounds the operator chose at `init`.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VmLimits {
    pub max_vcpus: u32,
    #[serde(rename = "maxMemoryMiB")]
    pub max_memory_mib: u32,
    #[serde(rename = "maxDiskGiB")]
    pub max_disk_gib: u32,
}

impl Default for VmLimits {
    fn default() -> Self {
        Self {
            max_vcpus: 4,
            max_memory_mib: 8192,
            max_disk_gib: 64,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BaseImage {
    pub sha256: String,
    pub size: u64,
    pub virtual_size: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Installation {
    pub binding: Binding,
    pub peer_id: String,
    pub allowed_peer: String,
    /// `linux-x86_64` or `macos-aarch64`.
    pub platform: String,
    pub image: BaseImage,
    pub qemu: PathBuf,
    pub qemu_img: PathBuf,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub firmware: Option<PathBuf>,
    pub limits: VmLimits,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum VmState {
    Allocating,
    Allocated,
    Starting,
    Running,
    Stopping,
    Stopped,
    Releasing,
    Released,
    Retained,
    Failed,
}

impl VmState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allocating => "allocating",
            Self::Allocated => "allocated",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Stopped => "stopped",
            Self::Releasing => "releasing",
            Self::Released => "released",
            Self::Retained => "retained",
            Self::Failed => "failed",
        }
    }
    fn parse(value: &str) -> Result<Self> {
        Ok(serde_json::from_value(serde_json::Value::String(
            value.into(),
        ))?)
    }
    /// Holds the one VM slot: everything between allocation and release.
    /// (Also used by `active_vm_count`, which reads a live runner's journal.)
    pub fn active(self) -> bool {
        matches!(
            self,
            Self::Allocating
                | Self::Allocated
                | Self::Starting
                | Self::Running
                | Self::Stopping
                | Self::Stopped
                | Self::Releasing
        )
    }
    /// A QEMU process may exist for the VM.
    pub fn live(self) -> bool {
        matches!(self, Self::Starting | Self::Running | Self::Stopping)
    }
}

/// Fixed at the first `vm.start` for the VM's life; later starts reuse it.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VmConfig {
    pub vcpus: u32,
    #[serde(rename = "memoryMiB")]
    pub memory_mib: u32,
    pub mac: String,
    pub seed_sha256: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VmRow {
    pub vm_id: String,
    pub thread_id: String,
    pub slot: u32,
    pub state: VmState,
    pub interrupted: bool,
    pub error: Option<String>,
    pub disk_gib: u32,
    pub config: Option<VmConfig>,
    pub retain: bool,
    pub started_at: Option<u64>,
}

pub fn private_file(path: &Path, create: bool) -> Result<File> {
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

pub fn private_dir(path: &Path) -> Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    if !path.exists() {
        fs::DirBuilder::new().mode(0o700).create(path)?;
    }
    let meta = fs::symlink_metadata(path)?;
    ensure!(
        meta.is_dir() && meta.mode() & 0o077 == 0,
        "{} must be a private directory, not a symlink",
        path.display()
    );
    Ok(())
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

const QCOW2_MAGIC: &[u8; 4] = b"QFI\xfb";

/// Reads the qcow2 header: version 2 or 3, no backing file (a base image
/// that names a backing file could make QEMU open any path), and returns the
/// virtual size in bytes.
pub fn qcow2_virtual_size(file: &mut File) -> Result<u64> {
    let mut header = [0u8; 32];
    file.seek(SeekFrom::Start(0))?;
    file.read_exact(&mut header)
        .context("base image is too short for a qcow2 header")?;
    ensure!(&header[..4] == QCOW2_MAGIC, "base image is not qcow2");
    let version = u32::from_be_bytes(header[4..8].try_into()?);
    ensure!(
        version == 2 || version == 3,
        "unsupported qcow2 version {version}"
    );
    let backing = u64::from_be_bytes(header[8..16].try_into()?);
    ensure!(backing == 0, "base image must not have a backing file");
    let size = u64::from_be_bytes(header[24..32].try_into()?);
    ensure!(size > 0, "base image has no virtual size");
    Ok(size)
}

/// Copies the operator's image into `state/images/<sha256>.qcow2` (0400).
pub fn import_image(state: &Path, source: &Path) -> Result<(BaseImage, PathBuf)> {
    let mut input = File::open(source).with_context(|| format!("open {}", source.display()))?;
    ensure!(
        input.metadata()?.is_file(),
        "base image must be a regular file"
    );
    let virtual_size = qcow2_virtual_size(&mut input)?;
    input.seek(SeekFrom::Start(0))?;
    let images = state.join("images");
    private_dir(&images)?;
    let temporary = images.join(".import.tmp");
    let _ = fs::remove_file(&temporary);
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temporary)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    let mut size = 0u64;
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        output.write_all(&buffer[..n])?;
        size += n as u64;
    }
    output.sync_all()?;
    drop(output);
    let sha256 = hex(&hasher.finalize());
    let path = images.join(format!("{sha256}.qcow2"));
    fs::set_permissions(&temporary, fs::Permissions::from_mode(0o400))?;
    fs::rename(&temporary, &path)?;
    File::open(&images)?.sync_all()?;
    Ok((
        BaseImage {
            sha256,
            size,
            virtual_size,
        },
        path,
    ))
}

pub fn image_path(state: &Path, image: &BaseImage) -> PathBuf {
    state.join("images").join(format!("{}.qcow2", image.sha256))
}

/// The base image is re-hashed on every start: a changed image would change
/// every VM disk built on it.
pub fn verify_image(state: &Path, image: &BaseImage) -> Result<()> {
    let path = image_path(state, image);
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .with_context(|| format!("base image {} is missing", path.display()))?;
    let meta = file.metadata()?;
    ensure!(
        meta.is_file() && meta.mode() & 0o222 == 0 && meta.len() == image.size,
        "base image {} changed (size or mode)",
        path.display()
    );
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    ensure!(
        hex(&hasher.finalize()) == image.sha256,
        "base image {} does not match its recorded sha256",
        path.display()
    );
    Ok(())
}

pub struct Journal {
    db: Connection,
    // A kernel-released lock, not a stale-PID lock. Never unlink/replace it.
    _lock: File,
}

const SCHEMA: &str = "
CREATE TABLE installation(id INTEGER PRIMARY KEY CHECK(id=1), document TEXT NOT NULL);
CREATE TABLE vm(vm_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, slot INTEGER NOT NULL UNIQUE,
  state TEXT NOT NULL, interrupted INTEGER NOT NULL DEFAULT 0, error TEXT,
  disk_gib INTEGER NOT NULL, config TEXT, retain INTEGER NOT NULL DEFAULT 0, started_at INTEGER);
CREATE TABLE lease_epoch(thread_id TEXT PRIMARY KEY, epoch INTEGER NOT NULL CHECK(epoch >= 1));
CREATE TRIGGER retain_installation_insert BEFORE INSERT ON installation WHEN EXISTS(SELECT 1 FROM installation) BEGIN SELECT RAISE(ABORT, 'immutable installation'); END;
CREATE TRIGGER immutable_installation_update BEFORE UPDATE ON installation BEGIN SELECT RAISE(ABORT, 'immutable installation'); END;
CREATE TRIGGER immutable_installation_delete BEFORE DELETE ON installation BEGIN SELECT RAISE(ABORT, 'immutable installation'); END;
CREATE TRIGGER immutable_vm_identity BEFORE UPDATE OF vm_id,thread_id,slot,disk_gib ON vm BEGIN SELECT RAISE(ABORT, 'immutable vm identity'); END;
CREATE TRIGGER immutable_vm_config BEFORE UPDATE OF config ON vm WHEN OLD.config IS NOT NULL BEGIN SELECT RAISE(ABORT, 'immutable vm config'); END;
CREATE TRIGGER monotonic_lease_epoch BEFORE UPDATE OF epoch ON lease_epoch WHEN NEW.epoch < OLD.epoch BEGIN SELECT RAISE(ABORT, 'lease epoch decreased'); END;
CREATE TRIGGER retain_lease_epoch BEFORE DELETE ON lease_epoch BEGIN SELECT RAISE(ABORT, 'retain lease epoch'); END;
";

fn validate_installation(installation: &Installation, peer: EndpointId) -> Result<()> {
    ensure!(
        installation.peer_id == peer.to_string(),
        "WRONG_NODE: peer key differs from permanent installation"
    );
    crate::validate_node_id(&installation.binding.node_id)?;
    installation.allowed_peer.parse::<EndpointId>()?;
    ensure!(
        valid_id(&installation.binding.thread_id)
            && (1..=MAX_EPOCH).contains(&installation.binding.environment_id),
        "invalid installation binding"
    );
    ensure!(
        installation.qemu.is_absolute() && installation.qemu_img.is_absolute(),
        "QEMU paths must be absolute"
    );
    Ok(())
}

fn open_db(state: &Path, create: bool) -> Result<(Connection, File)> {
    let lock = private_file(&state.join("owner.lock"), create)?;
    lock.try_lock()
        .context("another daemon owns this journal")?;
    private_file(&state.join("journal.db"), create)?;
    let db =
        Connection::open_with_flags(state.join("journal.db"), OpenFlags::SQLITE_OPEN_READ_WRITE)?;
    db.execute_batch("PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;")?;
    Ok((db, lock))
}

fn row(r: &rusqlite::Row<'_>) -> rusqlite::Result<(VmRowRaw,)> {
    Ok((VmRowRaw {
        vm_id: r.get(0)?,
        thread_id: r.get(1)?,
        slot: r.get(2)?,
        state: r.get(3)?,
        interrupted: r.get(4)?,
        error: r.get(5)?,
        disk_gib: r.get(6)?,
        config: r.get(7)?,
        retain: r.get(8)?,
        started_at: r.get(9)?,
    },))
}

struct VmRowRaw {
    vm_id: String,
    thread_id: String,
    slot: i64,
    state: String,
    interrupted: i64,
    error: Option<String>,
    disk_gib: i64,
    config: Option<String>,
    retain: i64,
    started_at: Option<i64>,
}

impl VmRowRaw {
    fn parse(self) -> Result<VmRow> {
        Ok(VmRow {
            vm_id: self.vm_id,
            thread_id: self.thread_id,
            slot: u32::try_from(self.slot)?,
            state: VmState::parse(&self.state)?,
            interrupted: self.interrupted != 0,
            error: self.error,
            disk_gib: u32::try_from(self.disk_gib)?,
            config: self.config.map(|c| serde_json::from_str(&c)).transpose()?,
            retain: self.retain != 0,
            started_at: self.started_at.map(u64::try_from).transpose()?,
        })
    }
}

const COLUMNS: &str =
    "vm_id,thread_id,slot,state,interrupted,error,disk_gib,config,retain,started_at";

impl Journal {
    /// Local operator enrollment: requires a NEW state directory.
    pub fn create(state: &Path, installation: &Installation, peer: EndpointId) -> Result<()> {
        validate_installation(installation, peer)?;
        let (db, _lock) = open_db(state, true)?;
        db.execute_batch(&format!(
            "BEGIN IMMEDIATE; {SCHEMA} PRAGMA user_version={JOURNAL_VERSION};"
        ))?;
        db.execute(
            "INSERT INTO installation VALUES(1, ?1)",
            [serde_json::to_string(installation)?],
        )?;
        db.execute_batch("COMMIT")?;
        File::open(state)?.sync_all()?;
        Ok(())
    }

    pub fn open(state: &Path, peer: EndpointId) -> Result<(Self, Installation)> {
        let meta = fs::symlink_metadata(state)?;
        ensure!(
            meta.is_dir() && meta.mode() & 0o077 == 0,
            "state directory must be private and not a symlink"
        );
        let (db, lock) = open_db(state, false)?;
        let version = db.query_row("PRAGMA user_version", [], |r| r.get::<_, u32>(0))?;
        if version == 1 {
            bail!(
                "this state belongs to a protocol-2 runner; protocol 3 needs a new state directory (re-enroll the runner)"
            );
        }
        ensure!(version == JOURNAL_VERSION, "unknown journal version");
        ensure!(
            db.query_row("PRAGMA quick_check", [], |r| r.get::<_, String>(0))? == "ok",
            "journal integrity check failed"
        );
        let installation: Installation = serde_json::from_str(&db.query_row(
            "SELECT document FROM installation WHERE id=1",
            [],
            |r| r.get::<_, String>(0),
        )?)?;
        validate_installation(&installation, peer)?;
        Ok((Self { db, _lock: lock }, installation))
    }

    pub fn get(&self, vm_id: &str) -> Result<Option<VmRow>> {
        self.db
            .query_row(
                &format!("SELECT {COLUMNS} FROM vm WHERE vm_id=?1"),
                [vm_id],
                row,
            )
            .optional()?
            .map(|(r,)| r.parse())
            .transpose()
    }

    pub fn all(&self) -> Result<Vec<VmRow>> {
        let mut statement = self
            .db
            .prepare(&format!("SELECT {COLUMNS} FROM vm ORDER BY slot"))?;
        let rows = statement
            .query_map([], row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter().map(|(r,)| r.parse()).collect()
    }

    pub fn insert_allocating(&self, vm_id: &str, thread_id: &str, disk_gib: u32) -> Result<u32> {
        let slot: i64 =
            self.db
                .query_row("SELECT COALESCE(MAX(slot), 0) + 1 FROM vm", [], |r| {
                    r.get(0)
                })?;
        self.db.execute(
            "INSERT INTO vm(vm_id,thread_id,slot,state,disk_gib) VALUES(?1,?2,?3,'allocating',?4)",
            params![vm_id, thread_id, slot, disk_gib],
        )?;
        Ok(u32::try_from(slot)?)
    }

    /// Only an allocation whose disk was never created is forgotten.
    pub fn forget_allocation(&self, vm_id: &str) -> Result<()> {
        self.db.execute(
            "DELETE FROM vm WHERE vm_id=?1 AND state='allocating'",
            [vm_id],
        )?;
        Ok(())
    }

    pub fn set_state(&self, vm_id: &str, state: VmState, error: Option<&str>) -> Result<()> {
        ensure!(
            self.db.execute(
                "UPDATE vm SET state=?1, error=?2 WHERE vm_id=?3",
                params![state.as_str(), error, vm_id],
            )? == 1,
            "vm record missing"
        );
        Ok(())
    }

    /// Moves `from` to `to` only if the record is still in `from`.
    pub fn transition(
        &self,
        vm_id: &str,
        from: &[VmState],
        to: VmState,
        error: Option<&str>,
    ) -> Result<bool> {
        let Some(current) = self.get(vm_id)? else {
            return Ok(false);
        };
        if !from.contains(&current.state) {
            return Ok(false);
        }
        self.set_state(vm_id, to, error)?;
        Ok(true)
    }

    pub fn set_interrupted(&self, vm_id: &str, interrupted: bool) -> Result<()> {
        self.db.execute(
            "UPDATE vm SET interrupted=?1 WHERE vm_id=?2",
            params![interrupted, vm_id],
        )?;
        Ok(())
    }

    pub fn set_config(&self, vm_id: &str, config: &VmConfig) -> Result<()> {
        self.db.execute(
            "UPDATE vm SET config=?1 WHERE vm_id=?2 AND config IS NULL",
            params![serde_json::to_string(config)?, vm_id],
        )?;
        Ok(())
    }

    /// Overwrites a VM's fixed config; only for rewriting a lost seed image.
    pub fn replace_config(&self, vm_id: &str, config: &VmConfig) -> Result<()> {
        self.db.execute(
            "UPDATE vm SET config=?1 WHERE vm_id=?2",
            params![serde_json::to_string(config)?, vm_id],
        )?;
        Ok(())
    }

    pub fn set_started(&self, vm_id: &str, started_at: u64) -> Result<()> {
        self.db.execute(
            "UPDATE vm SET state='starting', error=NULL, started_at=?1 WHERE vm_id=?2",
            params![i64::try_from(started_at)?, vm_id],
        )?;
        Ok(())
    }

    pub fn set_retain(&self, vm_id: &str, retain: bool) -> Result<()> {
        self.db.execute(
            "UPDATE vm SET retain=?1 WHERE vm_id=?2",
            params![retain, vm_id],
        )?;
        Ok(())
    }

    /// Lease epochs fence mutations per thread: an epoch below the newest
    /// one seen for the thread is `LEASE_STALE`.
    pub fn fence(&self, thread_id: &str, epoch: u64) -> Result<()> {
        if !(1..=MAX_EPOCH).contains(&epoch) {
            return reject("INVALID_REQUEST");
        }
        let seen = self
            .db
            .query_row(
                "SELECT epoch FROM lease_epoch WHERE thread_id=?1",
                [thread_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .map_or(0, |epoch| epoch as u64);
        if epoch < seen {
            return Err(RunnerError("LEASE_STALE").into());
        }
        if epoch > seen {
            self.db.execute(
                "INSERT INTO lease_epoch VALUES(?1,?2) ON CONFLICT(thread_id) DO UPDATE SET epoch=excluded.epoch",
                params![thread_id, i64::try_from(epoch)?],
            )?;
        }
        Ok(())
    }

    /// The newest epoch seen for a thread (0 when none).
    pub fn epoch(&self, thread_id: &str) -> Result<u64> {
        Ok(self
            .db
            .query_row(
                "SELECT epoch FROM lease_epoch WHERE thread_id=?1",
                [thread_id],
                |r| r.get::<_, i64>(0),
            )
            .optional()?
            .map_or(0, |epoch| epoch as u64))
    }
}

/// Active VMs in a journal another process may own, read without its owner
/// lock (SQLite allows concurrent readers). For the self-updater's idle check.
pub fn active_vm_count(state: &Path) -> Result<u64> {
    let db = Connection::open_with_flags(
        state.join("journal.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.busy_timeout(std::time::Duration::from_secs(5))?;
    let mut statement = db.prepare("SELECT state FROM vm")?;
    let mut active = 0;
    for state in statement.query_map([], |row| row.get::<_, String>(0))? {
        if VmState::parse(&state?)?.active() {
            active += 1;
        }
    }
    Ok(active)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn qcow2(virtual_size: u64, backing: u64) -> Vec<u8> {
        let mut bytes = vec![0u8; 512];
        bytes[..4].copy_from_slice(QCOW2_MAGIC);
        bytes[4..8].copy_from_slice(&3u32.to_be_bytes());
        bytes[8..16].copy_from_slice(&backing.to_be_bytes());
        bytes[24..32].copy_from_slice(&virtual_size.to_be_bytes());
        bytes
    }

    #[test]
    fn image_import_checks_header_and_hash() {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("state");
        private_dir(&state).unwrap();
        let source = root.path().join("base.qcow2");
        fs::write(&source, qcow2(3 << 30, 0)).unwrap();
        let (image, path) = import_image(&state, &source).unwrap();
        assert_eq!(image.virtual_size, 3 << 30);
        assert_eq!(image.size, 512);
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o400);
        verify_image(&state, &image).unwrap();
        let mut wrong = image.clone();
        wrong.sha256 = "0".repeat(64);
        assert!(verify_image(&state, &wrong).is_err());

        fs::write(&source, qcow2(1 << 30, 4096)).unwrap();
        assert!(
            import_image(&state, &source).is_err(),
            "backing file refused"
        );
        fs::write(&source, b"not an image at all, but long enough to read").unwrap();
        assert!(import_image(&state, &source).is_err());
    }

    #[test]
    fn states_serialize_lowercase() {
        assert_eq!(
            serde_json::to_value(VmState::Retained).unwrap(),
            serde_json::json!("retained")
        );
        assert_eq!(VmState::parse("stopping").unwrap(), VmState::Stopping);
        assert!(VmState::Stopped.active() && !VmState::Released.active());
        assert!(VmState::Running.live() && !VmState::Stopped.live());
    }
}
