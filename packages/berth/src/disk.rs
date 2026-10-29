//! Room on the runner's disk: one rule for every operation that allocates
//! there (a new machine, a build machine's template disk, a suspend's
//! memory file), and one evidence line per operation.
//!
//! ```text
//! free bytes − committed ≥ need + reserve, and free inodes ≥ RESERVE_INODES
//! ```
//!
//! `committed` is an estimate: what template builds may still write into
//! their sparse template disks. Running machines' writable disks are not
//! counted (they are overcommitted on purpose), and nothing stops another
//! writer from taking the room after the check: it only refuses new
//! allocations. A measurement that failed is unknown, never zero, and so
//! is an inode count a file system does not keep.
use std::{
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    time::Instant,
};

use cube_runner_protocol::{proto::Code, refuse};

/// Room every allocation leaves besides its own need: as much as an image
/// pull's and a template build's reserve (image.rs, `BUILD_RESERVE`).
pub const RESERVE: u64 = 2 << 30;
/// A machine's directory holds about ten files; this is only short when the
/// file system has almost no inodes left.
pub const RESERVE_INODES: u64 = 10_000;

/// What the file system of a path still lets an unprivileged process write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Space {
    pub bytes: u64,
    /// None: the file system keeps no inode count (btrfs says 0 of 0).
    pub inodes: Option<u64>,
}

/// statvfs (statfs on macOS, whose statvfs has 32-bit block counts that a
/// large disk overflows).
pub fn space(path: &Path) -> std::io::Result<Space> {
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    #[cfg(target_os = "macos")]
    {
        // SAFETY: plain data, filled in by statfs.
        let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
        // SAFETY: a NUL-terminated path and a struct of the right type.
        if unsafe { libc::statfs(name.as_ptr(), &mut stat) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Space {
            bytes: stat.f_bavail.saturating_mul(u64::from(stat.f_bsize)),
            inodes: (stat.f_files > 0).then_some(stat.f_ffree),
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        // SAFETY: plain data, filled in by statvfs.
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: a NUL-terminated path and a struct of the right type.
        if unsafe { libc::statvfs(name.as_ptr(), &mut stat) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        #[allow(clippy::unnecessary_cast)]
        Ok(Space {
            bytes: (stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64),
            inodes: (stat.f_files > 0).then_some(stat.f_favail as u64),
        })
    }
}

/// A file's allocated bytes (its blocks) and apparent bytes (its length):
/// a sparse file allocates less than its length.
pub fn size(path: &Path) -> std::io::Result<(u64, u64)> {
    let metadata = std::fs::metadata(path)?;
    Ok((metadata.blocks().saturating_mul(512), metadata.len()))
}

/// What a template disk of `bytes` may still take: its length less what it
/// allocated; all of it when that cannot be read.
pub fn still_to_write(file: &Path, bytes: u64) -> u64 {
    bytes.saturating_sub(size(file).map_or(0, |(allocated, _)| allocated))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    /// A machine's writable disk (and a build machine's without its
    /// template disk): its need is the reserve alone.
    Create,
    /// A build machine's template disk, as large as the machine's disk.
    Build,
    /// A suspend's memory file, as large as the machine's memory.
    Suspend,
    /// A template kept: measured, never refused.
    Publish,
}

impl Op {
    fn name(self) -> &'static str {
        match self {
            Self::Create => "create",
            Self::Build => "build",
            Self::Suspend => "suspend",
            Self::Publish => "publish",
        }
    }

    fn what(self) -> &'static str {
        match self {
            Self::Create => "a new machine",
            Self::Build => "a build machine's template disk",
            Self::Suspend => "a suspend's memory file",
            Self::Publish => "a template",
        }
    }

    /// The RESOURCE_EXHAUSTED reason cubed tells apart: a suspend's is
    /// `disk` (as before), an allocation's `disk_space`.
    fn reason(self) -> &'static str {
        match self {
            Self::Suspend => "disk",
            _ => "disk_space",
        }
    }

    /// A new machine goes on when the disk cannot be measured: a file
    /// system without statvfs must not stop every machine. A template build
    /// and a suspend, which may write their whole size, do not.
    fn allows_unknown(self) -> bool {
        matches!(self, Self::Create | Self::Publish)
    }
}

/// One measurement before an operation, and its verdict.
pub struct Room {
    op: Op,
    path: PathBuf,
    before: Result<Space, String>,
    committed: u64,
    need: u64,
    reserve: u64,
    started: Instant,
}

impl Room {
    pub fn measure(
        op: Op,
        path: &Path,
        measured: std::io::Result<Space>,
        committed: u64,
        need: u64,
        reserve: u64,
    ) -> Self {
        Self {
            op,
            path: path.to_owned(),
            before: measured.map_err(|error| error.to_string()),
            committed,
            need,
            reserve,
            started: Instant::now(),
        }
    }

    /// Ok, or why the operation is refused (nothing was allocated yet).
    pub fn verdict(&self) -> Result<(), cube_runner_protocol::proto::Error> {
        let space = match &self.before {
            Ok(space) => *space,
            Err(_) if self.op.allows_unknown() => return Ok(()),
            Err(error) => {
                return Err(refuse(
                    Code::Internal,
                    "io",
                    &format!(
                        "the free space of {} could not be measured: {error}",
                        self.path.display()
                    ),
                ));
            }
        };
        let wanted = self.need.saturating_add(self.reserve);
        let usable = space.bytes.saturating_sub(self.committed);
        let inodes_short = space.inodes.is_some_and(|n| n < RESERVE_INODES);
        if usable >= wanted && !inodes_short {
            return Ok(());
        }
        let inodes = space
            .inodes
            .map_or("an unknown number of".to_owned(), |n| n.to_string());
        Err(refuse(
            Code::ResourceExhausted,
            self.op.reason(),
            &format!(
                "{} needs {} and a reserve of {} free in {}; it has {} free, {} of it committed to template builds (an estimate), and {inodes} free inodes (at least {RESERVE_INODES})",
                self.op.what(),
                gib(self.need),
                gib(self.reserve),
                self.path.display(),
                gib(space.bytes),
                gib(self.committed),
            ),
        ))
    }

    /// The evidence line (`disk: …` in events.log) after the operation:
    /// `ok`, `refused` or `failed`, the space measured then, and `extra`
    /// (` key=value` pairs). free_after − free_before is not the
    /// operation's use: other writers are included.
    pub fn line(&self, outcome: &str, after: std::io::Result<Space>, extra: &str) -> String {
        let (free, inodes) = shown(self.before.as_ref().ok().copied());
        let (free_after, _) = shown(after.ok());
        format!(
            "op={} outcome={outcome} path={} free_before={free} inodes_before={inodes} committed_estimate={} need={} reserve={} free_after={free_after} ms={}{extra} concurrent_writers=included",
            self.op.name(),
            self.path.display(),
            self.committed,
            self.need,
            self.reserve,
            self.started.elapsed().as_millis(),
        )
    }
}

/// Bytes and inodes as an evidence line shows them: `unknown`, never 0.
fn shown(space: Option<Space>) -> (String, String) {
    let unknown = || "unknown".to_owned();
    match space {
        None => (unknown(), unknown()),
        Some(space) => (
            space.bytes.to_string(),
            space.inodes.map_or_else(unknown, |n| n.to_string()),
        ),
    }
}

/// GiB to 0.1, so a refusal's text changes only when the space really does
/// (cubed logs a wait when its text changes).
fn gib(bytes: u64) -> String {
    format!("{:.1} GiB", bytes as f64 / f64::from(1u32 << 30))
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1 << 30;

    fn space(bytes: u64, inodes: Option<u64>) -> std::io::Result<Space> {
        Ok(Space { bytes, inodes })
    }

    fn reason(room: &Room) -> Option<(Code, String)> {
        room.verdict()
            .err()
            .map(|error| (Code::try_from(error.code).unwrap(), error.reason))
    }

    fn check(op: Op, measured: std::io::Result<Space>, committed: u64, need: u64) -> Room {
        Room::measure(op, Path::new("/runner"), measured, committed, need, RESERVE)
    }

    #[test]
    fn exactly_enough_passes_and_one_byte_less_is_refused() {
        let short = Some((Code::ResourceExhausted, "disk_space".to_owned()));
        assert_eq!(reason(&check(Op::Create, space(2 * GIB, None), 0, 0)), None);
        assert_eq!(
            reason(&check(Op::Create, space(2 * GIB - 1, None), 0, 0)),
            short
        );
        assert_eq!(
            reason(&check(Op::Build, space(34 * GIB, None), 0, 32 * GIB)),
            None
        );
        assert_eq!(
            reason(&check(Op::Build, space(34 * GIB - 1, None), 0, 32 * GIB)),
            short
        );
    }

    #[test]
    fn committed_bytes_are_not_free() {
        assert_eq!(
            reason(&check(Op::Create, space(10 * GIB, None), 8 * GIB, 0)),
            None
        );
        assert_eq!(
            reason(&check(Op::Create, space(10 * GIB, None), 8 * GIB + 1, 0)),
            Some((Code::ResourceExhausted, "disk_space".to_owned()))
        );
        assert_eq!(
            reason(&check(Op::Create, space(GIB, None), u64::MAX, 0)),
            Some((Code::ResourceExhausted, "disk_space".to_owned()))
        );
    }

    #[test]
    fn too_few_inodes_refuse_and_an_unknown_count_does_not() {
        let room = |inodes| check(Op::Create, space(100 * GIB, inodes), 0, 0);
        assert_eq!(reason(&room(Some(RESERVE_INODES))), None);
        assert_eq!(reason(&room(None)), None);
        assert_eq!(
            reason(&room(Some(RESERVE_INODES - 1))),
            Some((Code::ResourceExhausted, "disk_space".to_owned()))
        );
    }

    #[test]
    fn an_unmeasured_disk_lets_a_new_machine_through_but_not_a_build_or_a_suspend() {
        let failed = || Err(std::io::Error::other("statvfs failed"));
        assert_eq!(reason(&check(Op::Create, failed(), 0, 0)), None);
        assert_eq!(
            reason(&check(Op::Build, failed(), 0, GIB)),
            Some((Code::Internal, "io".to_owned()))
        );
        assert_eq!(
            reason(&check(Op::Suspend, failed(), 0, GIB)),
            Some((Code::Internal, "io".to_owned()))
        );
    }

    #[test]
    fn a_refusal_says_what_was_measured() {
        let error = check(Op::Suspend, space(3 * GIB, Some(500)), GIB, 2 * GIB)
            .verdict()
            .unwrap_err();
        assert_eq!(
            (error.reason.as_str(), error.message.as_str()),
            (
                "disk",
                "a suspend's memory file needs 2.0 GiB and a reserve of 2.0 GiB free in /runner; it has 3.0 GiB free, 1.0 GiB of it committed to template builds (an estimate), and 500 free inodes (at least 10000)"
            )
        );
    }

    #[test]
    fn the_evidence_line_writes_unknown_never_zero() {
        let room = check(Op::Create, Err(std::io::Error::other("no")), 7, 0);
        let line = room.line("ok", space(5, None), " extra=1");
        let ms = line
            .split(" ms=")
            .nth(1)
            .unwrap()
            .split(' ')
            .next()
            .unwrap();
        assert_eq!(
            line.replace(&format!(" ms={ms} "), " ms=N "),
            format!(
                "op=create outcome=ok path=/runner free_before=unknown inodes_before=unknown committed_estimate=7 need=0 reserve={RESERVE} free_after=5 ms=N extra=1 concurrent_writers=included"
            )
        );
    }

    #[test]
    fn a_real_directory_is_measured_and_a_sparse_file_allocates_less_than_its_length() {
        let directory = tempfile::tempdir().unwrap();
        let measured = super::space(directory.path()).unwrap();
        assert!(measured.bytes > 0, "{measured:?}");
        assert!(super::space(&directory.path().join("missing")).is_err());
        let file = directory.path().join("sparse");
        std::fs::File::create(&file)
            .unwrap()
            .set_len(64 << 20)
            .unwrap();
        let (allocated, apparent) = size(&file).unwrap();
        assert_eq!(apparent, 64 << 20);
        assert!(allocated < apparent, "allocated {allocated}");
        assert_eq!(still_to_write(&file, 64 << 20), (64 << 20) - allocated);
        assert_eq!(
            still_to_write(&directory.path().join("gone"), 64 << 20),
            64 << 20
        );
    }
}
