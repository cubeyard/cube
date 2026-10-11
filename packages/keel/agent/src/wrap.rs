//! `cube-agent wrap OPDIR`: an operation's main process, cube-guest's `wrap`.
//! It detaches (the agent waits only for its first process), runs the command
//! as the workload's `agent` in the workload root with `/bin/bash -c`, keeps
//! the first `outputLimit` bytes of the combined output, drains the rest, and
//! writes `wrapped.json` itself before it exits. It stays in the operation's
//! cgroup, so the agent finds it again after a restart; the agent records
//! the result.
use std::{
    ffi::CString,
    fs,
    io::{self, Read, Write},
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    path::Path,
};

use serde_json::{Value, json};

use crate::files::{read_json, write_json};

fn cstring(text: &str) -> CString {
    CString::new(text.replace('\0', "")).unwrap()
}

/// Runs the wrapper; returns the process exit status.
pub fn main(dir: &Path) -> i32 {
    // Detach: the first process exits once the second exists (it is in the
    // operation's cgroup already), so the agent does not wait for the command.
    match unsafe { libc::fork() } {
        -1 => return 1,
        0 => {}
        _ => return 0,
    }
    let _ = fs::write(dir.join("wrap.pid"), std::process::id().to_string());
    match run(dir) {
        Ok(()) => 0,
        Err(error) => {
            eprintln!("cube-agent wrap: {error}");
            1
        }
    }
}

fn run(dir: &Path) -> io::Result<()> {
    let request =
        read_json(&dir.join("request.json"))?.ok_or_else(|| io::Error::other("no request"))?;
    let launch =
        read_json(&dir.join("launch.json"))?.ok_or_else(|| io::Error::other("no launch"))?;
    let limit = request["outputLimit"].as_u64().unwrap_or(0) as usize;
    let command = request["command"].as_str().unwrap_or_default();
    let cwd = match request["cwd"].as_str().unwrap_or(".") {
        "." => launch["workspace"]
            .as_str()
            .unwrap_or("/workspace")
            .to_string(),
        relative => format!(
            "{}/{relative}",
            launch["workspace"].as_str().unwrap_or("/workspace")
        ),
    };

    // Everything the child needs, prepared before fork.
    let namespace = match launch["namespace"].as_str() {
        Some(path) => Some(fs::File::open(path)?),
        None => None,
    };
    let account = launch["account"].as_object().map(|a| {
        let ids = |value: &Value| value.as_u64().unwrap_or(65534) as u32;
        let groups: Vec<libc::gid_t> = a
            .get("groups")
            .and_then(Value::as_array)
            .map(|g| g.iter().map(ids).collect())
            .unwrap_or_default();
        (ids(&a["uid"]), ids(&a["gid"]), groups)
    });
    let env: Vec<CString> = launch["env"]
        .as_object()
        .map(|map| {
            map.iter()
                .map(|(k, v)| cstring(&format!("{k}={}", v.as_str().unwrap_or_default())))
                .collect()
        })
        .unwrap_or_default();
    let mut envp: Vec<*const libc::c_char> = env.iter().map(|c| c.as_ptr()).collect();
    envp.push(std::ptr::null());
    let bash = cstring("/bin/bash");
    let argv_owned = [cstring("/bin/bash"), cstring("-c"), cstring(command)];
    let mut argv: Vec<*const libc::c_char> = argv_owned.iter().map(|c| c.as_ptr()).collect();
    argv.push(std::ptr::null());
    let cwd_c = cstring(&cwd);
    let null = fs::File::open("/dev/null")?;

    let mut fds = [0; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let (reader, writer) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
    let mut output = fs::File::create(dir.join("output"))?;

    let pid = unsafe { libc::fork() };
    if pid < 0 {
        return Err(io::Error::last_os_error());
    }
    if pid == 0 {
        unsafe {
            libc::dup2(null.as_raw_fd(), 0);
            libc::dup2(writer.as_raw_fd(), 1);
            libc::dup2(writer.as_raw_fd(), 2);
            let fail = |what: &str| -> ! {
                let error = io::Error::last_os_error();
                let message = format!("cube: cannot start the command: {what}: {error}\n");
                libc::write(1, message.as_ptr().cast(), message.len());
                libc::_exit(127);
            };
            if let Some(ns) = &namespace
                && libc::setns(ns.as_raw_fd(), libc::CLONE_NEWNS) != 0
            {
                fail("entering the workload root");
            }
            if libc::chdir(cwd_c.as_ptr()) != 0 {
                fail(&cwd);
            }
            if let Some((uid, gid, groups)) = &account
                && (libc::setgroups(groups.len(), groups.as_ptr()) != 0
                    || libc::setgid(*gid) != 0
                    || libc::setuid(*uid) != 0)
            {
                fail("becoming agent");
            }
            libc::umask(0o022);
            libc::execve(bash.as_ptr(), argv.as_ptr(), envp.as_ptr());
            fail("/bin/bash");
        }
    }
    drop(writer);
    drop(namespace);
    let mut reader = fs::File::from(reader);
    let mut total = 0usize;
    let mut buffer = vec![0; 65536];
    loop {
        let n = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        let keep = limit.saturating_sub(total).min(n);
        if keep > 0 {
            output.write_all(&buffer[..keep])?;
        }
        total += n;
    }
    let mut status = 0;
    while unsafe { libc::waitpid(pid, &mut status, 0) } < 0 {
        if io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
            return Err(io::Error::last_os_error());
        }
    }
    output.sync_all()?;
    let (code, signal) = if libc::WIFEXITED(status) {
        (json!(libc::WEXITSTATUS(status)), Value::Null)
    } else {
        (Value::Null, json!(libc::WTERMSIG(status)))
    };
    write_json(
        &dir.join("wrapped.json"),
        &json!({"exitCode": code, "signal": signal, "outputBytes": total}),
    )
}
