//! Whether a machine's guest was ever ready, kept on disk from the
//! machine's creation on (`DIRECTORY/<id>/readiness.json`), apart from the
//! record so an older berth still reads the record.
//!
//! ```text
//! {"version":1,"everReady":false}   written when the machine is created
//! {"version":1,"everReady":true}    the first time its agent says ready
//! (no file)                         made by an earlier berth: unknown
//! ```
//!
//! It vetoes, never proves: `everReady: true` keeps a machine from any
//! renewal, but `false` is not proof that it was never ready (a write that
//! failed, or a run of an earlier berth after a rollback, which never
//! writes the file, can leave it on a machine that was ready); renewal
//! needs the machine's layers to be exactly official Debian's own
//! (`vm/mod.rs`, `renews_disk`). A ready that cannot be recorded removes
//! the file, so the machine reads as unknown. berth before this file kept
//! no trace of readiness (its events say `machine_setup: done` also when
//! the image lacks keel's tools).

use std::{fs, io::Write as _, path::Path};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

pub const FILE: &str = "readiness.json";

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Readiness {
    version: u32,
    ever_ready: bool,
}

/// What the file says: `Some(ever_ready)`, or `None` without a readable
/// file (unknown).
pub fn read(dir: &Path) -> Option<bool> {
    let text = fs::read(dir.join(FILE)).ok()?;
    serde_json::from_slice::<Readiness>(&text)
        .ok()
        .map(|r| r.ever_ready)
}

/// At creation: never ready yet. An existing file is left alone (a create
/// asked again).
pub fn begin(dir: &Path) -> Result<()> {
    if dir.join(FILE).exists() {
        return Ok(());
    }
    write(dir, false)
}

/// The agent said ready: recorded once, durably, if the machine is tracked.
pub fn mark_ready(dir: &Path) -> Result<()> {
    if read(dir) == Some(false) {
        write(dir, true)?;
    }
    Ok(())
}

fn write(dir: &Path, ever_ready: bool) -> Result<()> {
    let target = dir.join(FILE);
    let temporary = dir.join(format!("{FILE}.tmp"));
    let mut file =
        fs::File::create(&temporary).with_context(|| format!("create {}", temporary.display()))?;
    file.write_all(&serde_json::to_vec(&Readiness {
        version: 1,
        ever_ready,
    })?)?;
    file.sync_all()?;
    fs::rename(&temporary, &target).with_context(|| format!("write {}", target.display()))?;
    fs::File::open(dir)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tracked_from_creation_and_ready_once() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(
            read(dir.path()),
            None,
            "an earlier berth's machine: unknown"
        );
        mark_ready(dir.path()).unwrap();
        assert_eq!(
            read(dir.path()),
            None,
            "never invented for an untracked machine"
        );
        begin(dir.path()).unwrap();
        assert_eq!(read(dir.path()), Some(false));
        mark_ready(dir.path()).unwrap();
        assert_eq!(read(dir.path()), Some(true));
        begin(dir.path()).unwrap();
        assert_eq!(
            read(dir.path()),
            Some(true),
            "a create asked again keeps it"
        );
        fs::write(
            dir.path().join(FILE),
            b"{\"version\":1,\"everReady\":\"x\"}",
        )
        .unwrap();
        assert_eq!(read(dir.path()), None, "unreadable is unknown");
    }
}
