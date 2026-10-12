//! `shutdown` (runner.proto's `DaemonRequest.shutdown`): the controlled end
//! of a machine before the runner quits its QEMU. Every workload process (the
//! operations' and the services' cgroups) gets SIGTERM; what is left after
//! TERM_WAIT gets SIGKILL; then the filesystems are synced and the writable
//! disk is remounted read-only, so everything on it is on the disk and its
//! filesystem is clean. Ok only when all of that held; the guest does not
//! power off (the runner quits QEMU).
use std::{
    ffi::CString,
    fs, io,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

/// How long the requests that write (journaled commands starting, file
/// writes, a setup) have to answer before the teardown goes on anyway.
/// The agent's waits add up to WRITERS_WAIT + TERM_WAIT + KILL_WAIT = 20 s,
/// which leaves at least 10 s of the runner's 30 s for `sync` and the
/// remount (berth's SHUTDOWN_WAIT).
pub const WRITERS_WAIT: Duration = Duration::from_secs(5);
/// How long the workload has after SIGTERM.
pub const TERM_WAIT: Duration = Duration::from_secs(10);
/// How long SIGKILL may take to empty the cgroups.
pub const KILL_WAIT: Duration = Duration::from_secs(5);

/// Where a teardown acts; tests give their own.
#[derive(Clone)]
pub struct Teardown {
    /// The cgroups whose children hold the workload (operations, services).
    pub cgroups: Vec<PathBuf>,
    /// The writable disk's mount point.
    pub rw: PathBuf,
    pub writers_wait: Duration,
    pub term_wait: Duration,
    pub kill_wait: Duration,
    pub sync: fn(),
}

impl Default for Teardown {
    fn default() -> Self {
        Self {
            cgroups: vec![
                PathBuf::from("/sys/fs/cgroup/cube-ops"),
                PathBuf::from("/sys/fs/cgroup/cube-services"),
            ],
            rw: PathBuf::from(crate::setup::RW),
            writers_wait: WRITERS_WAIT,
            term_wait: TERM_WAIT,
            kill_wait: KILL_WAIT,
            // SAFETY: sync(2) has no preconditions.
            sync: || unsafe { libc::sync() },
        }
    }
}

/// Every cgroup below `parent`, deepest last.
fn below(parent: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(parent) else {
        return;
    };
    for entry in entries.flatten() {
        if entry.file_type().is_ok_and(|t| t.is_dir()) {
            out.push(entry.path());
            below(&entry.path(), out);
        }
    }
}

fn populated(group: &Path) -> bool {
    fs::read_to_string(group.join("cgroup.events"))
        .is_ok_and(|events| events.lines().any(|line| line == "populated 1"))
}

fn pids(group: &Path) -> Vec<i32> {
    fs::read_to_string(group.join("cgroup.procs"))
        .map(|text| text.lines().filter_map(|l| l.trim().parse().ok()).collect())
        .unwrap_or_default()
}

/// Whether the filesystem at `path` is mounted read-only (or not mounted
/// apart from its parent's, which the caller checks).
fn read_only(path: &Path) -> io::Result<bool> {
    let target =
        CString::new(path.as_os_str().to_string_lossy().as_bytes()).map_err(io::Error::other)?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: statvfs into a zeroed struct owned here.
    if unsafe { libc::statvfs(target.as_ptr(), &mut stat) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(stat.f_flag & libc::ST_RDONLY != 0)
}

impl Teardown {
    fn groups(&self) -> Vec<PathBuf> {
        let mut all = vec![];
        for parent in &self.cgroups {
            below(parent, &mut all);
        }
        all
    }

    fn wait_empty(&self, groups: &[PathBuf], within: Duration) -> bool {
        let deadline = Instant::now() + within;
        loop {
            if !groups.iter().any(|g| populated(g)) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// The workload ends: SIGTERM, then (after `term_wait`) SIGKILL.
    /// Returns how many processes got SIGTERM and whether SIGKILL was
    /// needed; Err when the cgroups do not empty even then.
    pub fn end_workload(&self) -> io::Result<(usize, bool)> {
        let groups = self.groups();
        let mut termed = 0;
        for group in &groups {
            for pid in pids(group) {
                // SAFETY: a signal to a process of the workload's cgroups.
                if unsafe { libc::kill(pid, libc::SIGTERM) } == 0 {
                    termed += 1;
                }
            }
        }
        if self.wait_empty(&groups, self.term_wait) {
            return Ok((termed, false));
        }
        for group in &groups {
            if populated(group) {
                let _ = fs::write(group.join("cgroup.kill"), "1");
            }
        }
        if self.wait_empty(&groups, self.kill_wait) {
            return Ok((termed, true));
        }
        Err(io::Error::other(
            "the workload's processes did not end after SIGKILL",
        ))
    }

    /// Syncs, then remounts the writable disk read-only and checks that it
    /// is. A disk that was never mounted (no setup) has nothing to keep.
    pub fn settle_disk(&self) -> io::Result<String> {
        (self.sync)();
        let rw = self.rw.to_string_lossy().into_owned();
        if !crate::setup::is_mounted(&rw) {
            return Ok(format!("{rw} was not mounted"));
        }
        let target = CString::new(rw.as_bytes()).map_err(io::Error::other)?;
        // SAFETY: a remount of a mount point, no data.
        let remounted = unsafe {
            libc::mount(
                std::ptr::null(),
                target.as_ptr(),
                std::ptr::null(),
                libc::MS_REMOUNT | libc::MS_RDONLY,
                std::ptr::null(),
            )
        };
        if remounted != 0 {
            let error = io::Error::last_os_error();
            return Err(io::Error::new(
                error.kind(),
                format!("remounting {rw} read-only: {error}"),
            ));
        }
        if !read_only(&self.rw)? {
            return Err(io::Error::other(format!("{rw} is still writable")));
        }
        Ok(format!("{rw} synced and read-only"))
    }

    /// The whole teardown; Ok says what was done.
    pub fn run(&self) -> io::Result<String> {
        let (termed, killed) = self.end_workload()?;
        let disk = self.settle_disk()?;
        Ok(format!(
            "{termed} workload process(es) sent SIGTERM{}; {disk}",
            if killed {
                ", the rest killed"
            } else {
                ", all ended"
            }
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_workload_that_ends_on_sigterm_is_not_killed() {
        let dir = tempfile::tempdir().unwrap();
        let group = dir.path().join("ops").join("op-1");
        fs::create_dir_all(&group).unwrap();
        fs::write(group.join("cgroup.events"), "populated 0\n").unwrap();
        fs::write(group.join("cgroup.procs"), "").unwrap();
        let teardown = Teardown {
            cgroups: vec![dir.path().join("ops")],
            rw: dir.path().join("rw"),
            writers_wait: Duration::ZERO,
            term_wait: Duration::from_millis(50),
            kill_wait: Duration::from_millis(50),
            sync: || {},
        };
        assert_eq!(teardown.end_workload().unwrap(), (0, false));
        assert!(!group.join("cgroup.kill").exists(), "nothing killed");
    }

    #[test]
    fn a_workload_that_outlives_sigterm_is_killed_and_one_that_outlives_that_fails() {
        let dir = tempfile::tempdir().unwrap();
        let group = dir.path().join("services").join("web");
        fs::create_dir_all(&group).unwrap();
        // A stand-in cgroup that stays populated: SIGKILL is written, and
        // since nothing empties it, the teardown fails rather than going on.
        fs::write(group.join("cgroup.events"), "populated 1\n").unwrap();
        fs::write(group.join("cgroup.procs"), "").unwrap();
        let teardown = Teardown {
            cgroups: vec![dir.path().join("services")],
            rw: dir.path().join("rw"),
            writers_wait: Duration::ZERO,
            term_wait: Duration::from_millis(50),
            kill_wait: Duration::from_millis(50),
            sync: || {},
        };
        let started = Instant::now();
        let error = teardown.end_workload().unwrap_err();
        assert!(error.to_string().contains("did not end"), "{error}");
        assert_eq!(fs::read_to_string(group.join("cgroup.kill")).unwrap(), "1");
        assert!(
            started.elapsed() >= Duration::from_millis(100),
            "TERM then KILL waits"
        );
        assert!(teardown.run().is_err(), "no disk step after a failed end");
    }

    #[test]
    fn a_disk_that_is_not_mounted_has_nothing_to_keep_and_one_that_is_must_go_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let teardown = Teardown {
            cgroups: vec![],
            rw: dir.path().join("not-a-mount"),
            writers_wait: Duration::ZERO,
            term_wait: Duration::ZERO,
            kill_wait: Duration::ZERO,
            sync: || {},
        };
        assert!(teardown.settle_disk().unwrap().contains("was not mounted"));
        // A mount point an ordinary user cannot remount: the teardown fails
        // closed (in the guest the agent is root and the remount works).
        // SAFETY: getuid has no preconditions.
        if unsafe { libc::getuid() } != 0 {
            let mounted = Teardown {
                rw: PathBuf::from("/proc"),
                ..teardown
            };
            let error = mounted.settle_disk().unwrap_err();
            assert!(error.to_string().contains("read-only"), "{error}");
        }
    }
}
