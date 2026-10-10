//! The runner's layer cache: one EROFS file per `diff_id`,
//! `<dir>/sha256:<hex>.erofs`, shared read-only by every machine.
//!
//! A file appears only complete: it is built under a temporary name in the
//! same directory, made read-only, synced and renamed into place, and the
//! directory is synced. Whoever owns the directory (the runner, under its
//! lock) calls [`LayerCache::remove_temporary`] at start for what a crash
//! left behind.
//!
//! Eviction follows the masterplan's U6: a size limit per runner and least
//! recently used first, over the layers no machine references. Using a layer
//! ([`LayerCache::get`], [`LayerCache::publish`]) sets its modification time,
//! which is the recency the eviction reads. Referenced layers are never
//! removed, even when they alone exceed the limit.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::SystemTime;

use anyhow::{Context, Result, bail};

use crate::DiffId;
use crate::convert::{self, Compression, Converted, Mkfs, TarMode};

const SUFFIX: &str = ".erofs";
const TEMPORARY: &str = ".tmp-";

pub struct LayerCache {
    dir: PathBuf,
}

/// One cached layer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Entry {
    pub diff_id: DiffId,
    pub bytes: u64,
    pub last_used: SystemTime,
}

/// What [`LayerCache::evict`] did.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Eviction {
    pub removed: Vec<DiffId>,
    pub freed_bytes: u64,
    /// The cache's size afterwards; above the limit only if the referenced
    /// layers alone are.
    pub remaining_bytes: u64,
}

impl LayerCache {
    /// Opens the cache at `dir`, creating the directory if needed.
    pub fn open(dir: impl Into<PathBuf>) -> Result<Self> {
        let dir = dir.into();
        fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
        Ok(Self { dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Where the layer's file is, whether or not it is cached. Always
    /// absolute when the cache directory is.
    pub fn path(&self, diff_id: &DiffId) -> PathBuf {
        self.dir.join(format!("{diff_id}{SUFFIX}"))
    }

    /// The layer's file if it is cached, marked as just used.
    pub fn get(&self, diff_id: &DiffId) -> Result<Option<PathBuf>> {
        let path = self.path(diff_id);
        match File::open(&path) {
            Ok(file) => {
                file.set_modified(SystemTime::now())
                    .with_context(|| format!("mark {} used", path.display()))?;
                Ok(Some(path))
            }
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e).with_context(|| format!("open {}", path.display())),
        }
    }

    /// Publishes the layer: `build` writes the file at the temporary path it
    /// is given, and the file is then moved into place whole. Returns the
    /// cached file's path. If `build` fails, nothing is published.
    pub fn publish(
        &self,
        diff_id: &DiffId,
        build: impl FnOnce(&Path) -> Result<()>,
    ) -> Result<PathBuf> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let temporary = self.dir.join(format!(
            "{TEMPORARY}{}-{}-{}",
            diff_id.hex(),
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let result = (|| {
            build(&temporary)?;
            let file = File::open(&temporary)
                .with_context(|| format!("{} was not written", temporary.display()))?;
            let mut permissions = file.metadata()?.permissions();
            permissions.set_readonly(true);
            fs::set_permissions(&temporary, permissions)?;
            file.sync_all()?;
            file.set_modified(SystemTime::now())?;
            let path = self.path(diff_id);
            // The same layer always converts to the same bytes, so replacing
            // a file another conversion published meanwhile changes nothing
            // (and a machine that has the old one open keeps reading it).
            fs::rename(&temporary, &path).with_context(|| {
                format!("publish {} as {}", temporary.display(), path.display())
            })?;
            File::open(&self.dir)?.sync_all()?;
            Ok(path)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
            let _ = fs::remove_file(format!("{}.tar", temporary.display()));
        }
        result
    }

    /// The layer's file, converting `blob` and publishing it first unless it
    /// is cached already. `blob` is opened only when it is needed. Returns the
    /// path and, when it converted, what the conversion did.
    pub fn get_or_convert<R: std::io::Read>(
        &self,
        diff_id: &DiffId,
        mkfs: &Mkfs,
        mode: TarMode,
        compression: Compression,
        blob: impl FnOnce() -> Result<R>,
    ) -> Result<(PathBuf, Option<Converted>)> {
        if let Some(path) = self.get(diff_id)? {
            return Ok((path, None));
        }
        let mut converted = None;
        let path = self.publish(diff_id, |out| {
            converted = Some(convert::convert(
                mkfs,
                mode,
                blob()?,
                compression,
                diff_id,
                out,
            )?);
            Ok(())
        })?;
        Ok((path, converted))
    }

    /// Every cached layer. Files that are not `sha256:<hex>.erofs` are left
    /// alone and not listed.
    pub fn entries(&self) -> Result<Vec<Entry>> {
        let mut entries = Vec::new();
        for item in
            fs::read_dir(&self.dir).with_context(|| format!("list {}", self.dir.display()))?
        {
            let item = item?;
            let name = item.file_name();
            let Some(diff_id) = name
                .to_str()
                .and_then(|n| n.strip_suffix(SUFFIX))
                .and_then(|n| n.parse::<DiffId>().ok())
            else {
                continue;
            };
            let metadata = item.metadata()?;
            if !metadata.is_file() {
                continue;
            }
            entries.push(Entry {
                diff_id,
                bytes: metadata.len(),
                last_used: metadata.modified()?,
            });
        }
        entries.sort_by(|a, b| {
            a.last_used
                .cmp(&b.last_used)
                .then(a.diff_id.cmp(&b.diff_id))
        });
        Ok(entries)
    }

    /// Removes the least recently used layers that are not in `in_use` until
    /// the cache holds at most `limit_bytes`.
    pub fn evict(&self, limit_bytes: u64, in_use: &HashSet<DiffId>) -> Result<Eviction> {
        let entries = self.entries()?;
        let mut eviction = Eviction {
            remaining_bytes: entries.iter().map(|e| e.bytes).sum(),
            ..Default::default()
        };
        for entry in entries {
            if eviction.remaining_bytes <= limit_bytes {
                break;
            }
            if in_use.contains(&entry.diff_id) {
                continue;
            }
            let path = self.path(&entry.diff_id);
            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == ErrorKind::NotFound => {}
                Err(e) => return Err(e).with_context(|| format!("remove {}", path.display())),
            }
            eviction.removed.push(entry.diff_id);
            eviction.freed_bytes += entry.bytes;
            eviction.remaining_bytes -= entry.bytes;
        }
        if !eviction.removed.is_empty() {
            File::open(&self.dir)?.sync_all()?;
        }
        Ok(eviction)
    }

    /// Removes temporary files a conversion left when the process died.
    /// Only for the cache's owner, while no conversion runs.
    pub fn remove_temporary(&self) -> Result<usize> {
        let mut removed = 0;
        for item in fs::read_dir(&self.dir)? {
            let item = item?;
            if item
                .file_name()
                .to_str()
                .is_some_and(|n| n.starts_with(TEMPORARY))
            {
                if !item.file_type()?.is_file() {
                    bail!("{} is not a file", item.path().display());
                }
                fs::remove_file(item.path())?;
                removed += 1;
            }
        }
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn id(n: u8) -> DiffId {
        DiffId::from_bytes([n; 32])
    }

    fn put(cache: &LayerCache, diff_id: DiffId, bytes: usize, age_seconds: u64) {
        let path = cache
            .publish(&diff_id, |out| Ok(fs::write(out, vec![7u8; bytes])?))
            .unwrap();
        File::open(path)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(age_seconds))
            .unwrap();
    }

    #[test]
    fn publish_is_whole_read_only_and_named_by_diff_id() {
        let dir = tempfile::tempdir().unwrap();
        let cache = LayerCache::open(dir.path().join("layers")).unwrap();
        assert_eq!(cache.get(&id(1)).unwrap(), None);
        let path = cache
            .publish(&id(1), |out| Ok(fs::write(out, b"layer")?))
            .unwrap();
        assert_eq!(
            path.file_name().unwrap(),
            "sha256:0101010101010101010101010101010101010101010101010101010101010101.erofs"
        );
        assert_eq!(fs::read(&path).unwrap(), b"layer");
        assert!(fs::metadata(&path).unwrap().permissions().readonly());
        assert_eq!(cache.get(&id(1)).unwrap(), Some(path));
        // Nothing else is left in the directory.
        assert_eq!(fs::read_dir(cache.dir()).unwrap().count(), 1);
    }

    #[test]
    fn a_failed_build_publishes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let cache = LayerCache::open(dir.path()).unwrap();
        let error = cache
            .publish(&id(2), |out| {
                fs::write(out, b"half")?;
                bail!("digest mismatch")
            })
            .unwrap_err();
        assert_eq!(error.to_string(), "digest mismatch");
        assert_eq!(cache.get(&id(2)).unwrap(), None);
        assert_eq!(fs::read_dir(cache.dir()).unwrap().count(), 0);
    }

    #[test]
    fn get_marks_a_layer_used() {
        let dir = tempfile::tempdir().unwrap();
        let cache = LayerCache::open(dir.path()).unwrap();
        put(&cache, id(1), 10, 3600);
        let before = cache.entries().unwrap()[0].last_used;
        cache.get(&id(1)).unwrap().unwrap();
        let after = cache.entries().unwrap()[0].last_used;
        assert!(
            after > before + Duration::from_secs(3000),
            "{before:?} -> {after:?}"
        );
    }

    #[test]
    fn evicts_least_recently_used_unreferenced_layers_down_to_the_limit() {
        let dir = tempfile::tempdir().unwrap();
        let cache = LayerCache::open(dir.path()).unwrap();
        put(&cache, id(1), 100, 400); // oldest, but in use
        put(&cache, id(2), 100, 300);
        put(&cache, id(3), 100, 200);
        put(&cache, id(4), 100, 100); // newest
        fs::write(dir.path().join("notes.txt"), b"not a layer").unwrap();

        let in_use = HashSet::from([id(1)]);
        let eviction = cache.evict(250, &in_use).unwrap();
        assert_eq!(
            eviction,
            Eviction {
                removed: vec![id(2), id(3)],
                freed_bytes: 200,
                remaining_bytes: 200
            }
        );
        let left: Vec<DiffId> = cache
            .entries()
            .unwrap()
            .into_iter()
            .map(|e| e.diff_id)
            .collect();
        assert_eq!(left, vec![id(1), id(4)]);
        assert!(dir.path().join("notes.txt").exists());

        // Under the limit: nothing to do.
        assert_eq!(
            cache.evict(250, &in_use).unwrap(),
            Eviction {
                remaining_bytes: 200,
                ..Default::default()
            }
        );
        // Referenced layers stay even when they alone exceed the limit.
        let eviction = cache.evict(0, &in_use).unwrap();
        assert_eq!(
            eviction,
            Eviction {
                removed: vec![id(4)],
                freed_bytes: 100,
                remaining_bytes: 100
            }
        );
        assert_eq!(cache.entries().unwrap().len(), 1);
    }

    #[test]
    fn removes_temporary_files_left_by_a_crash() {
        let dir = tempfile::tempdir().unwrap();
        let cache = LayerCache::open(dir.path()).unwrap();
        put(&cache, id(1), 10, 0);
        fs::write(
            dir.path().join(format!(".tmp-{}-1-0", id(2).hex())),
            b"half",
        )
        .unwrap();
        fs::write(
            dir.path().join(format!(".tmp-{}-1-0.tar", id(2).hex())),
            b"half",
        )
        .unwrap();
        assert_eq!(cache.remove_temporary().unwrap(), 2);
        assert_eq!(fs::read_dir(cache.dir()).unwrap().count(), 1);
        assert_eq!(cache.get(&id(1)).unwrap(), Some(cache.path(&id(1))));
    }
}
