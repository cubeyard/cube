//! Where an operation's processes run: one cgroup v2 group per operation id,
//! as systemd's transient unit per command does for cube-guest
//! (`KillMode=control-group`). The group outlives the agent, so an agent that
//! starts again finds its running operations by their groups.
use std::{
    ffi::OsStr,
    fs, io,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use serde_json::{Value, json};

/// The operation domains the journal starts commands in.
pub trait Domain: Send + Sync {
    /// Runs `program args` as the main process of a new domain `id` and waits
    /// until it has detached (the wrapper forks and its first process exits).
    fn start(&self, id: &str, program: &Path, args: &[&OsStr]) -> io::Result<()>;
    /// The domain still exists: its operation has not been recorded yet.
    fn exists(&self, id: &str) -> bool;
    /// A process of the domain still runs.
    fn populated(&self, id: &str) -> bool;
    /// Kills every process in the domain.
    fn kill(&self, id: &str);
    /// `{peakBytes, totalBytes, oomKills}`, or None when the kernel does not say.
    fn memory(&self, id: &str) -> Option<Value>;
    /// Removes the domain once nothing runs in it.
    fn remove(&self, id: &str);
}

/// Operations under one cgroup v2 directory (`/sys/fs/cgroup/cube-ops`).
pub struct Cgroups {
    pub root: PathBuf,
    pub meminfo: PathBuf,
}

impl Cgroups {
    /// Creates the parent group and enables the controllers an operation's
    /// accounting reads (memory.peak, memory.events) in its children.
    pub fn open(root: &Path) -> io::Result<Self> {
        match fs::create_dir(root) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error),
        }
        fs::write(root.join("cgroup.subtree_control"), "+memory +pids")?;
        Ok(Self {
            root: root.into(),
            meminfo: "/proc/meminfo".into(),
        })
    }

    fn group(&self, id: &str) -> PathBuf {
        self.root.join(id)
    }
}

impl Domain for Cgroups {
    fn start(&self, id: &str, program: &Path, args: &[&OsStr]) -> io::Result<()> {
        let group = self.group(id);
        fs::create_dir(&group)?;
        let procs = std::ffi::CString::new(
            group
                .join("cgroup.procs")
                .into_os_string()
                .into_encoded_bytes(),
        )
        .map_err(io::Error::other)?;
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .env_clear()
            .env("PATH", "/sbin:/bin");
        // In the child, before exec: join the operation's group, so the
        // wrapper and everything it starts are in it from the first instruction.
        unsafe {
            command.pre_exec(move || {
                let fd = libc::open(procs.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC);
                if fd < 0 {
                    return Err(io::Error::last_os_error());
                }
                let written = libc::write(fd, b"0".as_ptr().cast(), 1);
                let error = io::Error::last_os_error();
                libc::close(fd);
                if written != 1 {
                    return Err(error);
                }
                libc::setsid();
                Ok(())
            });
        }
        let status = command.status();
        match status {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => {
                let _ = fs::remove_dir(&group);
                Err(io::Error::other(format!(
                    "the wrapper did not start ({status})"
                )))
            }
            Err(error) => {
                let _ = fs::remove_dir(&group);
                Err(error)
            }
        }
    }

    fn exists(&self, id: &str) -> bool {
        self.group(id).is_dir()
    }

    fn populated(&self, id: &str) -> bool {
        // An exited process leaves the group at once, before it is reaped.
        match fs::read_to_string(self.group(id).join("cgroup.events")) {
            Ok(events) => events.lines().any(|line| line == "populated 1"),
            Err(_) => false,
        }
    }

    fn kill(&self, id: &str) {
        let _ = fs::write(self.group(id).join("cgroup.kill"), "1");
    }

    fn memory(&self, id: &str) -> Option<Value> {
        cgroup_memory(&self.group(id), &self.meminfo)
    }

    fn remove(&self, id: &str) {
        let _ = fs::remove_dir(self.group(id));
    }
}

/// A cgroup's peak memory and OOM kills (memory.peak, memory.events) on a
/// machine with `meminfo`'s MemTotal, as cube-guest's `cgroup_memory`.
pub fn cgroup_memory(group: &Path, meminfo: &Path) -> Option<Value> {
    let peak: u64 = fs::read_to_string(group.join("memory.peak"))
        .ok()?
        .trim()
        .parse()
        .ok()?;
    let mut kills = 0u64;
    for line in fs::read_to_string(group.join("memory.events"))
        .ok()?
        .lines()
    {
        if let Some(value) = line.strip_prefix("oom_kill ") {
            kills = value.trim().parse().ok()?;
        }
    }
    let total = fs::read_to_string(meminfo)
        .ok()?
        .lines()
        .find_map(|line| line.strip_prefix("MemTotal:"))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|kib| kib.parse::<u64>().ok())?
        * 1024;
    Some(json!({"peakBytes": peak, "totalBytes": total, "oomKills": kills}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_reads_peak_events_and_total() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("memory.peak"), "1048576\n").unwrap();
        fs::write(
            dir.path().join("memory.events"),
            "low 0\nhigh 0\nmax 2\noom 1\noom_kill 1\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("meminfo"),
            "MemTotal:        2000 kB\nMemFree: 1 kB\n",
        )
        .unwrap();
        assert_eq!(
            cgroup_memory(dir.path(), &dir.path().join("meminfo")),
            Some(json!({"peakBytes": 1048576, "totalBytes": 2048000, "oomKills": 1}))
        );
        fs::remove_file(dir.path().join("memory.peak")).unwrap();
        assert_eq!(cgroup_memory(dir.path(), &dir.path().join("meminfo")), None);
    }
}
