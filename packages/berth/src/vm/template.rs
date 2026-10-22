//! Templates on `berth vm` (masterplan B-8): a build machine's `upper/`,
//! written by its agent as one EROFS layer to its template disk (vdd,
//! `template.raw`, keel's `template.rs`), checked here and kept as
//! `DIRECTORY/templates/<id>.erofs`; machines made from it get it as the
//! topmost lower layer, above the image's layers it was built on.
//!
//! ```text
//! templates/<id>.json    the record (written whole, synced, renamed)
//! templates/<id>.erofs   the layer, read-only (0444), never changed
//! ```
//!
//! A template's id is its build machine's (16 hex, never reused), and so is
//! its owner. Publishing goes `publishing` (the record, then the disk moved
//! here) to `ready` (the file cut to the layer's size, read-only, hashed);
//! the build machine is deleted then, as p3 releases its build VM. A runner
//! that starts finishes a publication whose layer was moved and forgets one
//! whose layer was not (the build machine keeps its disk). `template_delete`
//! makes it `removing`; it is deleted when no machine that is not deleted
//! (retained ones too) is made from it. Templates are outside the layer
//! cache (B-8 D2): never trimmed, removed only by `template_delete`.
//!
//! A template is bound to the runner's CA (record version 2): its build
//! machine's agent may leave that CA's public certificate in the layer (a
//! Java keystore, say; keel's `template.rs`), so the record keeps the CA's
//! fingerprint and a machine is made from the template only while the
//! runner has that CA (`template_runner_ca_changed` after a new CA). A
//! version 1 record was sealed against every runner CA and holds none; it
//! is usable under any. A berth from before version 2 does not start with
//! a version 2 record: once one exists, rolling back is unsupported; roll
//! forward, and never delete a template, its layer or a machine's retained
//! disk to make an earlier berth start (docs/runner-operations.md).
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use cube_runner_protocol::Timestamp;
use serde::{Deserialize, Serialize};

use super::record::{MachineImage, write_json};

pub const DIR: &str = "templates";
/// A build machine's template disk (vdd), in its directory.
pub const DISK: &str = "template.raw";
/// What cubed may keep in `key` and `meta` (p3's bound on meta).
pub const MAX_KEY_BYTES: usize = 128;
pub const MAX_META_BYTES: usize = 4096;
const EROFS_MAGIC: u32 = 0xE0F5_E1E2;
const SUPERBLOCK_OFFSET: u64 = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum State {
    Publishing,
    Ready,
    Removing,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateRecord {
    pub version: u32,
    /// The build machine's id and owner.
    pub id: String,
    pub owner: String,
    /// cubed's, opaque to the runner.
    pub key: String,
    pub meta: String,
    pub state: State,
    /// The build machine's `size.disk_gib`: the most the layer could be.
    pub disk_gib: u32,
    /// The layer's size, from its EROFS superblock.
    pub bytes: u64,
    /// sha256 of the layer file; empty until it is ready.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sha256: String,
    /// The image whose layers the template lies on; it is valid only there
    /// (B-8 D3).
    pub image: MachineImage,
    /// The keel release the build machine ran (evidence; not checked).
    pub kernel_sha256: String,
    pub base_sha256: String,
    /// The build machine's fence epoch at the publication.
    pub fence_epoch: i64,
    pub created_at: Timestamp,
    /// Version 2: sha256 of the DER of the runner's CA the template was
    /// built under, the only CA it may hold; empty in version 1.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub runner_ca_sha256: String,
}

/// The record version of a template bound to the runner's CA.
pub const VERSION: u32 = 2;

impl TemplateRecord {
    /// Whether a machine may be made from the template under the runner's
    /// CA `ca_sha256`: a version 2 template only under the CA it was built
    /// under; a version 1 template, which holds no runner CA, under any.
    pub fn usable_under(&self, ca_sha256: &str) -> bool {
        self.version < VERSION || self.runner_ca_sha256 == ca_sha256
    }
}

pub fn dir(directory: &Path) -> PathBuf {
    directory.join(DIR)
}

/// The layer file of template `id`.
pub fn layer(directory: &Path, id: &str) -> PathBuf {
    dir(directory).join(format!("{id}.erofs"))
}

fn record_path(directory: &Path, id: &str) -> PathBuf {
    dir(directory).join(format!("{id}.json"))
}

/// Writes `record` (whole, synced, renamed).
pub fn write(directory: &Path, record: &TemplateRecord) -> Result<()> {
    write_json(&record_path(directory, &record.id), record)
}

/// Every template record under `directory`, by id.
pub fn load(directory: &Path) -> Result<BTreeMap<String, TemplateRecord>> {
    use std::os::unix::fs::DirBuilderExt;
    let templates = dir(directory);
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&templates)?;
    let mut out = BTreeMap::new();
    for entry in std::fs::read_dir(&templates)? {
        let path = entry?.path();
        let name = path.file_name().unwrap_or_default().to_string_lossy();
        if name.ends_with(".json.tmp") {
            let _ = std::fs::remove_file(&path); // a write that crashed
            continue;
        }
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        let record: TemplateRecord = serde_json::from_slice(&std::fs::read(&path)?)
            .with_context(|| format!("read {}", path.display()))?;
        let valid = match record.version {
            1 => record.runner_ca_sha256.is_empty(),
            VERSION => {
                record.runner_ca_sha256.len() == 64
                    && record
                        .runner_ca_sha256
                        .bytes()
                        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            }
            _ => false,
        };
        ensure!(
            valid && record.id == id && crate::host::valid_id(id),
            "{} is not a template record of this runner",
            path.display()
        );
        out.insert(record.id.clone(), record);
    }
    Ok(out)
}

/// The size of the EROFS image at the start of `path`, from its superblock
/// (the check the keel plan asks of the runner): the magic, a block size of
/// 512 B to 64 KiB, at least one block, whole sectors, and no more than the
/// file holds.
pub fn layer_bytes(path: &Path) -> Result<u64> {
    use std::os::unix::fs::FileExt;
    let file = std::fs::File::open(path).with_context(|| format!("read {}", path.display()))?;
    let length = file.metadata()?.len();
    let mut sb = [0u8; 128];
    file.read_exact_at(&mut sb, SUPERBLOCK_OFFSET)
        .with_context(|| format!("{}: no EROFS superblock", path.display()))?;
    if sb[..4] != EROFS_MAGIC.to_le_bytes() {
        bail!("{}: no EROFS superblock (magic)", path.display());
    }
    let bits = u32::from(sb[12]);
    ensure!(
        (9..=16).contains(&bits),
        "{}: an EROFS block of 2^{bits} bytes",
        path.display()
    );
    let blocks = u64::from(u32::from_le_bytes(sb[36..40].try_into().unwrap()));
    let bytes = blocks << bits;
    ensure!(
        bytes > SUPERBLOCK_OFFSET + 128 && bytes % 512 == 0 && bytes <= length,
        "{}: the EROFS superblock says {bytes} bytes; the disk has {length}",
        path.display()
    );
    Ok(bytes)
}

/// Moves a build machine's checked template disk into place, as template
/// `record.id` in state `publishing` (the record first, then the rename).
pub fn adopt(directory: &Path, record: &TemplateRecord, disk: &Path) -> Result<()> {
    ensure!(record.state == State::Publishing);
    write(directory, record)?;
    std::fs::rename(disk, layer(directory, &record.id))
        .with_context(|| format!("move {} to {}", disk.display(), DIR))?;
    std::fs::File::open(dir(directory))?.sync_all()?;
    Ok(())
}

/// Finishes a publication whose layer is in place: the file is cut to the
/// layer's size, synced, made read-only and hashed, and the record says
/// `ready`. Repeating it changes nothing.
pub fn finish(directory: &Path, record: &mut TemplateRecord) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let path = layer(directory, &record.id);
    let bytes = layer_bytes(&path)?;
    ensure!(
        bytes == record.bytes,
        "{}: {bytes} bytes now, {} when it was checked",
        path.display(),
        record.bytes
    );
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))?;
    let file = std::fs::OpenOptions::new().write(true).open(&path)?;
    file.set_len(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444))?;
    record.sha256 = super::qemu::sha256_file(&path)?;
    record.state = State::Ready;
    write(directory, record)
}

/// What a runner that starts does with a publication it finds unfinished:
/// finishes it when its layer was moved here and still checks, else
/// forgets it (removing a moved file that does not check). True: finished.
pub fn recover(directory: &Path, record: &mut TemplateRecord) -> Result<bool> {
    if record.state != State::Publishing {
        return Ok(false);
    }
    let path = layer(directory, &record.id);
    if path.is_file() {
        match finish(directory, record) {
            Ok(()) => return Ok(true),
            Err(error) => eprintln!("template {}: not finished: {error:#}", record.id),
        }
    }
    remove(directory, &record.id)?;
    Ok(false)
}

/// Deletes template `id`: the layer, then the record.
pub fn remove(directory: &Path, id: &str) -> Result<()> {
    for path in [layer(directory, id), record_path(directory, id)] {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error).with_context(|| format!("remove {}", path.display())),
        }
    }
    std::fs::File::open(dir(directory))?.sync_all()?;
    Ok(())
}

/// `key` and `meta` of a publication: cubed's and opaque, but bounded, as
/// they go out in every runner report.
pub fn valid_key(key: &str) -> bool {
    (1..=MAX_KEY_BYTES).contains(&key.len()) && key.bytes().all(|b| (0x21..0x7f).contains(&b))
}

pub fn valid_meta(meta: &str) -> bool {
    meta.len() <= MAX_META_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An EROFS image's first block as mkfs.erofs writes it: the magic, a
    /// 4 KiB block (2^12) and `blocks` blocks.
    pub fn erofs(blocks: u32, total: usize) -> Vec<u8> {
        let mut data = vec![0u8; total];
        data[1024..1028].copy_from_slice(&EROFS_MAGIC.to_le_bytes());
        data[1024 + 12] = 12;
        data[1024 + 36..1024 + 40].copy_from_slice(&blocks.to_le_bytes());
        data
    }

    fn record(id: &str) -> TemplateRecord {
        TemplateRecord {
            version: VERSION,
            id: id.into(),
            owner: "thread-1".into(),
            key: "k".into(),
            meta: "{}".into(),
            state: State::Publishing,
            disk_gib: 1,
            bytes: 2 * 4096,
            sha256: String::new(),
            image: MachineImage {
                reference: "registry.test/o/n@sha256:00".into(),
                manifest: "sha256:11".into(),
                diff_ids: vec!["sha256:22".into()],
            },
            kernel_sha256: "k".into(),
            base_sha256: "b".into(),
            fence_epoch: 3,
            created_at: Timestamp {
                seconds: 1,
                nanos: 0,
            },
            runner_ca_sha256: "ab".repeat(32),
        }
    }

    #[test]
    fn the_superblock_says_how_much_of_the_disk_is_the_layer() {
        let dir = tempfile::tempdir().unwrap();
        let disk = dir.path().join(DISK);
        // A sparse vdd that holds a 2-block image.
        std::fs::write(&disk, erofs(2, 3 * 4096)).unwrap();
        assert_eq!(layer_bytes(&disk).unwrap(), 2 * 4096);
        // A blank disk (the agent never wrote it), a wrong magic, a bad block
        // size, and a superblock that claims more than the disk has.
        std::fs::write(&disk, vec![0u8; 8192]).unwrap();
        assert!(format!("{:#}", layer_bytes(&disk).unwrap_err()).contains("magic"));
        let mut bad = erofs(2, 3 * 4096);
        bad[1024 + 12] = 30;
        std::fs::write(&disk, &bad).unwrap();
        assert!(format!("{:#}", layer_bytes(&disk).unwrap_err()).contains("block"));
        std::fs::write(&disk, erofs(4, 3 * 4096)).unwrap();
        assert!(format!("{:#}", layer_bytes(&disk).unwrap_err()).contains("the disk has"));
        std::fs::write(&disk, erofs(0, 4096)).unwrap();
        assert!(layer_bytes(&disk).is_err(), "no blocks");
        std::fs::write(&disk, b"short").unwrap();
        assert!(layer_bytes(&disk).is_err(), "shorter than a superblock");
    }

    #[test]
    fn a_publication_is_moved_cut_to_size_and_read_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        load(dir.path()).unwrap();
        let disk = dir.path().join(DISK);
        std::fs::write(&disk, erofs(2, 16 * 4096)).unwrap();
        let mut published = record("0123456789abcdef");
        adopt(dir.path(), &published, &disk).unwrap();
        assert!(!disk.exists());
        assert_eq!(
            load(dir.path()).unwrap()["0123456789abcdef"].state,
            State::Publishing
        );
        finish(dir.path(), &mut published).unwrap();
        let path = layer(dir.path(), "0123456789abcdef");
        let meta = std::fs::metadata(&path).unwrap();
        assert_eq!(meta.len(), 2 * 4096);
        assert_eq!(meta.permissions().mode() & 0o777, 0o444);
        let loaded = load(dir.path()).unwrap();
        assert_eq!(loaded["0123456789abcdef"], published);
        assert_eq!(published.state, State::Ready);
        assert_eq!(
            published.sha256,
            super::super::qemu::sha256_file(&path).unwrap()
        );
        // Again (a recovery after the record was written): the same.
        finish(dir.path(), &mut published).unwrap();
        assert_eq!(load(dir.path()).unwrap()["0123456789abcdef"], published);
    }

    #[test]
    fn a_runner_that_starts_finishes_a_moved_layer_and_forgets_one_not_moved() {
        let dir = tempfile::tempdir().unwrap();
        load(dir.path()).unwrap();
        // Crashed after the rename: finished.
        let disk = dir.path().join(DISK);
        std::fs::write(&disk, erofs(2, 8 * 4096)).unwrap();
        let mut moved = record("00000000000000aa");
        adopt(dir.path(), &moved, &disk).unwrap();
        assert!(recover(dir.path(), &mut moved).unwrap());
        assert_eq!(moved.state, State::Ready);
        // Crashed after the record, before the rename: forgotten.
        let mut unmoved = record("00000000000000bb");
        write(dir.path(), &unmoved).unwrap();
        assert!(!recover(dir.path(), &mut unmoved).unwrap());
        // A moved layer that no longer checks: forgotten, file and all.
        let mut broken = record("00000000000000cc");
        write(dir.path(), &broken).unwrap();
        std::fs::write(layer(dir.path(), &broken.id), vec![0u8; 8192]).unwrap();
        assert!(!recover(dir.path(), &mut broken).unwrap());
        assert!(!layer(dir.path(), &broken.id).exists());
        // A ready one is left alone.
        assert!(!recover(dir.path(), &mut moved).unwrap());
        let left = load(dir.path()).unwrap();
        assert_eq!(left.keys().collect::<Vec<_>>(), ["00000000000000aa"]);
        remove(dir.path(), "00000000000000aa").unwrap();
        assert!(load(dir.path()).unwrap().is_empty());
        assert!(!layer(dir.path(), "00000000000000aa").exists());
        // A record that is not this runner's stops the start.
        std::fs::write(record_path(dir.path(), "00000000000000dd"), b"{}").unwrap();
        assert!(load(dir.path()).is_err());
    }

    #[test]
    fn a_record_is_bound_to_a_ca_from_version_2_on() {
        let dir = tempfile::tempdir().unwrap();
        load(dir.path()).unwrap();
        let id = "00000000000000ee";
        let check = |version: u32, ca: &str| {
            let record = TemplateRecord {
                version,
                runner_ca_sha256: ca.into(),
                ..record(id)
            };
            write(dir.path(), &record).unwrap();
            load(dir.path()).map(|_| ())
        };
        let ca = "ab".repeat(32);
        assert!(check(2, &ca).is_ok());
        assert!(check(1, "").is_ok(), "before the binding: no CA");
        for (version, bad) in [(2, String::new()), (2, "AB".repeat(32)), (2, "ab".into())] {
            assert!(check(version, &bad).is_err(), "{version} {bad:?}");
        }
        assert!(check(1, &ca).is_err(), "version 1 names no CA");
        assert!(check(3, &ca).is_err(), "a later version");
        let bound = TemplateRecord {
            runner_ca_sha256: ca.clone(),
            ..record(id)
        };
        assert!(bound.usable_under(&ca));
        assert!(!bound.usable_under(&"cd".repeat(32)));
        let earlier = TemplateRecord {
            version: 1,
            runner_ca_sha256: String::new(),
            ..record(id)
        };
        assert!(earlier.usable_under(&"cd".repeat(32)));
    }

    #[test]
    fn key_and_meta_are_opaque_but_bounded() {
        assert!(valid_key(&"a".repeat(64)));
        assert!(valid_key("cube:setup/v1"));
        for key in ["", "a b", "\u{e9}", &"a".repeat(129)] {
            assert!(!valid_key(key), "{key:?}");
        }
        assert!(valid_meta("") && valid_meta(&"x".repeat(4096)));
        assert!(!valid_meta(&"x".repeat(4097)));
    }
}
