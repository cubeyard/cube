//! The file operations `read`, `write` and `stat`, with cube-guest's
//! semantics (`op_read`, `op_write`, `op_stat`): a relative path is in the
//! workspace, an absolute one anywhere in the workload root but its kernel
//! and device filesystems (`/proc`, `/sys`, `/dev`), never with `..`. Paths
//! are resolved inside the workload root (`paths::resolve_in_root`), so an
//! absolute link names the workload's file and nothing reaches the base
//! root. What was resolved is opened with every link refused, so a link put
//! there after the check fails the operation instead of leading elsewhere.
//! In the workspace the agent acts as root and gives what it creates to the
//! `agent` account; a path that leads out of it, through its links or by
//! itself, is reached with the `agent` account's permissions. A write is
//! journaled under its key like a command: the same key and request returns
//! the recorded result, another request is CONFLICT, and a write cut off
//! before its result is never done again (COMPLETION_UNKNOWN).
use std::{
    ffi::CString,
    fs, io,
    io::{Read, Seek, SeekFrom, Write},
    os::fd::{AsRawFd, OwnedFd},
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    files::{hex, read_json, write_json},
    journal::{Account, Answer, Fail, Journal, Limits, Lock, MAX_RECORDS, integer, op_id},
    paths::{open_resolved, resolve_in_root},
};

/// Kernel and device filesystems: endless, blocking or live "files" a file
/// operation must not read or write whole; bash reaches them.
const PSEUDO_FILESYSTEMS: [&str; 3] = ["proc", "sys", "dev"];

/// Where an operation's path leads, as components below the workload root.
struct Target {
    /// The parent resolved, the last component as named: a final link
    /// itself (`write`, `stat`).
    located: Vec<String>,
    /// Every link followed (`read`, and what a `write` replaces).
    resolved: Vec<String>,
    /// Out of the workspace: reached as the `agent` account.
    outside: bool,
}

fn os_error(error: &io::Error) -> String {
    // cube-guest answers OSError's strerror, without Rust's "(os error N)".
    let text = error.to_string();
    match text.find(" (os error ") {
        Some(end) => text[..end].to_string(),
        None => text,
    }
}

fn io_fail(error: io::Error) -> Fail {
    Fail::new("IO_ERROR", os_error(&error))
}

fn under(path: &[String], prefix: &[String]) -> bool {
    path.starts_with(prefix)
}

/// A file operation's target, as cube-guest's `file_path` checks it.
fn locate(root: &fs::File, path: Option<&Value>, follow: bool) -> Result<Target, Fail> {
    let path = match path.and_then(Value::as_str) {
        Some(path)
            if !path.is_empty()
                && !path.contains('\0')
                && path.len() <= Limits::MAX_PATH_BYTES as usize
                && !path.split('/').any(|part| part == "..") =>
        {
            path
        }
        _ => {
            return Err(Fail::invalid(
                "path must be relative to the workspace or absolute, without ..",
            ));
        }
    };
    let mut named: Vec<String> = vec![];
    if !path.starts_with('/') {
        named.push("workspace".into());
    }
    named.extend(
        path.split('/')
            .filter(|part| !part.is_empty() && *part != ".")
            .map(str::to_string),
    );
    let workspace = resolve_in_root(root, "workspace").map_err(io_fail)?;
    let resolved = resolve_in_root(root, &named.join("/")).map_err(io_fail)?;
    let located = match named.split_last() {
        Some((last, parent)) if !follow => {
            let mut located = resolve_in_root(root, &parent.join("/")).map_err(io_fail)?;
            located.push(last.clone());
            located
        }
        _ => resolved.clone(),
    };
    for place in [&named, &located, &resolved] {
        if let Some(first) = place.first()
            && PSEUDO_FILESYSTEMS.contains(&first.as_str())
        {
            return Err(Fail::invalid(format!(
                "{path} is in /{first}, a kernel or device filesystem; use bash"
            )));
        }
    }
    let outside = !(under(&located, &workspace) && under(&resolved, &workspace));
    Ok(Target {
        located,
        resolved,
        outside,
    })
}

/// Runs `work` with the `agent` account's file permissions when `outside`
/// (cube-guest's `AsAgent`): on a thread of its own whose credentials alone
/// change (the raw system calls act on the calling thread, unlike libc's,
/// which change every thread of the process), and which ends with `work`.
fn as_agent<T: Send>(
    account: Option<&Account>,
    outside: bool,
    work: impl FnOnce() -> Result<T, Fail> + Send,
) -> Result<T, Fail> {
    let Some(account) = account.filter(|_| outside && unsafe { libc::geteuid() } == 0) else {
        return work();
    };
    let denied = |failure: Fail| {
        let refused =
            [libc::EACCES, libc::EPERM].map(|code| os_error(&io::Error::from_raw_os_error(code)));
        if failure.code == "IO_ERROR" && refused.contains(&failure.message) {
            Fail::new(
                "IO_ERROR",
                "permission denied: this path leads outside the workspace, where the file tools \
                 have the agent account's permissions; use sudo in bash for this file",
            )
        } else {
            failure
        }
    };
    std::thread::scope(|scope| {
        scope
            .spawn(|| {
                let groups: Vec<libc::gid_t> = account.groups.clone();
                let none = libc::uid_t::MAX;
                unsafe {
                    if libc::syscall(libc::SYS_setgroups, groups.len(), groups.as_ptr()) != 0
                        || libc::syscall(libc::SYS_setresgid, none, account.gid, none) != 0
                        || libc::syscall(libc::SYS_setresuid, none, account.uid, none) != 0
                    {
                        return Err(io_fail(io::Error::last_os_error()));
                    }
                }
                work().map_err(denied)
            })
            .join()
            .unwrap_or_else(|_| Err(Fail::new("IO_ERROR", "the file operation failed")))
    })
}

fn open(root: &fs::File, at: &[String], flags: i32) -> io::Result<fs::File> {
    open_resolved(root, at, flags, 0).map(fs::File::from)
}

fn not_found(error: io::Error, message: &str) -> Fail {
    if error.kind() == io::ErrorKind::NotFound {
        Fail::new("NOT_FOUND", message)
    } else {
        io_fail(error)
    }
}

fn is_regular(file: &fs::File) -> io::Result<bool> {
    Ok(file.metadata()?.file_type().is_file())
}

/// A regular file at `at` opened for reading; never blocks on a FIFO.
fn open_regular(root: &fs::File, at: &[String]) -> Result<fs::File, Fail> {
    let probe = open(root, at, libc::O_PATH).map_err(|e| not_found(e, "no such file"))?;
    if !is_regular(&probe).map_err(io_fail)? {
        return Err(Fail::invalid("not a regular file"));
    }
    let file = open(root, at, libc::O_RDONLY | libc::O_NONBLOCK)
        .map_err(|e| not_found(e, "no such file"))?;
    if !is_regular(&file).map_err(io_fail)? {
        return Err(Fail::invalid("not a regular file"));
    }
    Ok(file)
}

fn sha256(file: &mut fs::File) -> io::Result<String> {
    file.seek(SeekFrom::Start(0))?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0; 1 << 20];
    loop {
        match file.read(&mut buffer)? {
            0 => return Ok(hex(&digest.finalize())),
            n => digest.update(&buffer[..n]),
        }
    }
}

/// `fstatat(dir, name, AT_SYMLINK_NOFOLLOW)`.
fn lstat_at(dir: &OwnedFd, name: &str) -> io::Result<libc::stat> {
    let name = CString::new(name).map_err(io::Error::other)?;
    let mut info: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe {
        libc::fstatat(
            dir.as_raw_fd(),
            name.as_ptr(),
            &mut info,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(info)
}

fn check(result: libc::c_int) -> io::Result<()> {
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn c_name(name: &str) -> io::Result<CString> {
    CString::new(name).map_err(io::Error::other)
}

impl Journal {
    fn root_dir(&self) -> Result<fs::File, Fail> {
        fs::File::open(&self.root).map_err(io_fail)
    }

    /// `read`: a part of a regular file (`offset`, at most `limit` bytes),
    /// its whole size and sha256.
    pub fn read(&self, header: &Value) -> Answer {
        let root = self.root_dir()?;
        let target = locate(&root, header.get("path"), true)?;
        let offset = match header.get("offset") {
            None => Some(0),
            value => integer(value, 0, None),
        };
        let limit = match header.get("limit") {
            None => Some(Limits::MAX_READ_BYTES as i64),
            value => integer(value, 1, Some(Limits::MAX_READ_BYTES as i64)),
        };
        let (Some(offset), Some(limit)) = (offset, limit) else {
            return Err(Fail::invalid(format!(
                "read limit is at most {} bytes",
                Limits::MAX_READ_BYTES
            )));
        };
        let account = self.account();
        let (size, sha, content) = as_agent(account.as_ref(), target.outside, || {
            let mut file = open_regular(&root, &target.resolved)?;
            let sha = sha256(&mut file).map_err(io_fail)?;
            let size = file.stream_position().map_err(io_fail)?;
            let mut content = vec![];
            file.seek(SeekFrom::Start(offset as u64)).map_err(io_fail)?;
            file.take(limit as u64)
                .read_to_end(&mut content)
                .map_err(io_fail)?;
            Ok((size, sha, content))
        })?;
        Ok((
            json!({
                "path": header["path"], "offset": offset, "size": size,
                "eof": offset as u64 + content.len() as u64 >= size,
                "sha256": sha, "length": content.len(),
            }),
            content,
        ))
    }

    /// `stat`: what is at the path itself (a final link is not followed).
    pub fn stat(&self, header: &Value) -> Answer {
        let root = self.root_dir()?;
        let target = locate(&root, header.get("path"), false)?;
        let account = self.account();
        as_agent(account.as_ref(), target.outside, || {
            let info = match target.located.split_last() {
                None => {
                    let mut info: libc::stat = unsafe { std::mem::zeroed() };
                    check(unsafe { libc::fstat(root.as_raw_fd(), &mut info) }).map_err(io_fail)?;
                    info
                }
                Some((name, parent)) => {
                    let dir = open_resolved(&root, parent, libc::O_PATH | libc::O_DIRECTORY, 0)
                        .map_err(|e| not_found(e, "no such file"))?;
                    lstat_at(&dir, name).map_err(|e| not_found(e, "no such file"))?
                }
            };
            let kind = match info.st_mode & libc::S_IFMT {
                libc::S_IFREG => "file",
                libc::S_IFDIR => "directory",
                libc::S_IFLNK => "symlink",
                _ => "other",
            };
            let sha = if kind == "file" {
                Some(sha256(&mut open_regular(&root, &target.located)?).map_err(io_fail)?)
            } else {
                None
            };
            Ok((
                json!({
                    "kind": kind, "size": info.st_size, "mode": info.st_mode & 0o7777,
                    "modifiedMs": info.st_mtime * 1000 + info.st_mtime_nsec / 1_000_000,
                    "sha256": sha,
                }),
                vec![],
            ))
        })
    }

    /// `write`: replaces a regular file whole (atomically), journaled under
    /// the request's key and fenced by its lease epoch.
    pub fn write(&self, header: &Value, body: &[u8]) -> Answer {
        let id = op_id(header)?;
        let root = self.root_dir()?;
        let target = locate(&root, header.get("path"), false)?;
        let expected = match header.get("expectedSha") {
            None | Some(Value::Null) => None,
            Some(Value::String(sha))
                if sha.len() == 64
                    && sha.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) =>
            {
                Some(sha.clone())
            }
            Some(_) => return Err(Fail::invalid("expectedSha must be a sha256")),
        };
        let parents = match header.get("createParents") {
            None => Some(false),
            Some(value) => value.as_bool(),
        };
        let length = integer(
            header.get("length"),
            0,
            Some(Limits::MAX_WRITE_BYTES as i64),
        );
        let (Some(parents), Some(_)) = (parents, length.filter(|n| *n as usize == body.len()))
        else {
            return Err(Fail::invalid(format!(
                "file content is at most {} bytes",
                Limits::MAX_WRITE_BYTES
            )));
        };
        let request = json!({
            "kind": "write", "path": header["path"], "sha256": hex(&Sha256::digest(body)),
            "expectedSha": expected, "createParents": parents,
        });
        let _lock = Lock::take(&self.state).map_err(io_fail)?;
        self.fence(header)?;
        if !self.op(&id).is_dir() && self.count_records() >= MAX_RECORDS {
            return Err(Fail::new(
                "CAPACITY_EXCEEDED",
                format!("the guest keeps at most {MAX_RECORDS} operation records"),
            ));
        }
        let result_file = self.op(&id).join("result.json");
        if !self.new_record(&id, request)? {
            let result = match read_json(&result_file).map_err(io_fail)? {
                Some(result) => result,
                None => {
                    // The agent stopped between journaling and recording.
                    let result = json!({"state": "Interrupted", "completionUnknown": true});
                    write_json(&result_file, &result).map_err(io_fail)?;
                    result
                }
            };
            return written(result);
        }
        let account = self.account();
        let give = (!target.outside).then_some(account.as_ref()).flatten();
        let result = match as_agent(account.as_ref(), target.outside, || {
            replace(&root, &target, body, expected.as_deref(), parents, give)
        }) {
            Ok(done) => json!({"state": "Written", "result": done}),
            Err(failure) => json!({
                "state": "Failed", "error": failure.code, "completionUnknown": false,
                "message": failure.message,
            }),
        };
        write_json(&result_file, &result).map_err(io_fail)?;
        written(result)
    }
}

fn written(result: Value) -> Answer {
    match result["state"].as_str() {
        Some("Written") => Ok((result["result"].clone(), vec![])),
        Some("Interrupted") => Err(Fail::new(
            "COMPLETION_UNKNOWN",
            "the outcome of this write is unknown",
        )),
        _ => Err(Fail::new(
            result["error"].as_str().unwrap_or("IO_ERROR"),
            result["message"].as_str().unwrap_or_default(),
        )),
    }
}

/// cube-guest's `replace`: the parent made if asked, the file written to a
/// temporary file beside it and renamed over the target (a final link is
/// replaced, as `os.rename` replaces it), its mode kept, given to `agent`
/// in the workspace.
fn replace(
    root: &fs::File,
    target: &Target,
    content: &[u8],
    expected: Option<&str>,
    parents: bool,
    give: Option<&Account>,
) -> Result<Value, Fail> {
    let Some((name, parent)) = target.located.split_last() else {
        return Err(Fail::invalid("not a regular file"));
    };
    let directory = open_resolved(root, parent, libc::O_PATH | libc::O_DIRECTORY, 0);
    let exists = match &directory {
        Ok(dir) => match lstat_at(dir, name) {
            Ok(_) => true,
            Err(error) if error.kind() == io::ErrorKind::NotFound => false,
            Err(error) => return Err(io_fail(error)),
        },
        Err(_) => false,
    };
    // What the target names, its links followed (`os.path.isfile`).
    let mut current = match open_regular(root, &target.resolved) {
        Ok(file) => Some(file),
        Err(failure)
            if failure.code == "NOT_FOUND"
                || failure.code == "INVALID_REQUEST"
                || failure.message == os_error(&io::Error::from_raw_os_error(libc::ENOTDIR)) =>
        {
            None
        }
        Err(failure) => return Err(failure),
    };
    if exists && current.is_none() {
        return Err(Fail::invalid("not a regular file"));
    }
    if let Some(expected) = expected {
        let matches = match current.as_mut() {
            Some(file) => sha256(file).map_err(io_fail)? == expected,
            None => false,
        };
        if !matches {
            return Err(Fail::new(
                "PRECONDITION_FAILED",
                "the file changed since it was read",
            ));
        }
    }
    let directory = match directory {
        Ok(dir) => dir,
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                || error.raw_os_error() == Some(libc::ENOTDIR) =>
        {
            if !parents {
                return Err(Fail::new(
                    "NOT_FOUND",
                    "the parent directory does not exist",
                ));
            }
            make_parents(root, parent, give).map_err(io_fail)?
        }
        Err(error) => return Err(io_fail(error)),
    };
    let mode = match current.as_ref() {
        Some(file) => {
            use std::os::unix::fs::PermissionsExt;
            file.metadata().map_err(io_fail)?.permissions().mode() & 0o7777
        }
        None => 0o644,
    };
    write_atomic_at(&directory, name, content, mode, give).map_err(io_fail)?;
    Ok(json!({"sha256": hex(&Sha256::digest(content)), "size": content.len()}))
}

/// Makes the missing directories of `parent` (mode 0755, given to `give`);
/// returns the last one.
fn make_parents(root: &fs::File, parent: &[String], give: Option<&Account>) -> io::Result<OwnedFd> {
    let mut at = open_resolved(root, &[], libc::O_PATH | libc::O_DIRECTORY, 0)?;
    for depth in 0..parent.len() {
        let prefix = &parent[..=depth];
        at = match open_resolved(root, prefix, libc::O_PATH | libc::O_DIRECTORY, 0) {
            Ok(dir) => dir,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let name = c_name(&parent[depth])?;
                check(unsafe { libc::mkdirat(at.as_raw_fd(), name.as_ptr(), 0o755) })?;
                if let Some(account) = give {
                    check(unsafe {
                        libc::fchownat(
                            at.as_raw_fd(),
                            name.as_ptr(),
                            account.uid,
                            account.gid,
                            libc::AT_SYMLINK_NOFOLLOW,
                        )
                    })?;
                }
                open_resolved(root, prefix, libc::O_PATH | libc::O_DIRECTORY, 0)?
            }
            Err(error) => return Err(error),
        };
    }
    Ok(at)
}

/// `files::write_atomic` in a directory given by descriptor: a temporary
/// file made anew (never one found there), fsync, rename, fsync of the
/// directory.
fn write_atomic_at(
    directory: &OwnedFd,
    name: &str,
    content: &[u8],
    mode: u32,
    give: Option<&Account>,
) -> io::Result<()> {
    // The descriptor is O_PATH; the *at calls need one that can be read.
    let dir_name = c_name(".")?;
    let dir = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            dir_name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    };
    if dir < 0 {
        return Err(io::Error::last_os_error());
    }
    let dir = unsafe { <OwnedFd as std::os::fd::FromRawFd>::from_raw_fd(dir) };
    let temporary = c_name(&format!("{name}.tmp-{}", std::process::id()))?;
    let target = c_name(name)?;
    unsafe { libc::unlinkat(dir.as_raw_fd(), temporary.as_ptr(), 0) };
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            mode as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    let mut file = fs::File::from(unsafe { <OwnedFd as std::os::fd::FromRawFd>::from_raw_fd(fd) });
    let result = (|| {
        file.write_all(content)?;
        if let Some(account) = give {
            check(unsafe { libc::fchown(file.as_raw_fd(), account.uid, account.gid) })?;
        }
        // After the owner: a change of owner clears set-id bits.
        check(unsafe { libc::fchmod(file.as_raw_fd(), mode) })?;
        file.sync_all()?;
        check(unsafe {
            libc::renameat(
                dir.as_raw_fd(),
                temporary.as_ptr(),
                dir.as_raw_fd(),
                target.as_ptr(),
            )
        })
    })();
    if result.is_err() {
        unsafe { libc::unlinkat(dir.as_raw_fd(), temporary.as_ptr(), 0) };
    }
    result?;
    check(unsafe { libc::fsync(dir.as_raw_fd()) })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{domain::Domain, journal::Launch};
    use std::{
        collections::BTreeMap,
        ffi::OsStr,
        os::unix::fs::{MetadataExt, PermissionsExt, symlink},
        path::{Path, PathBuf},
        sync::Arc,
    };

    /// File operations start nothing.
    struct NoDomain;
    impl Domain for NoDomain {
        fn start(&self, _: &str, _: &Path, _: &[&OsStr]) -> io::Result<()> {
            unreachable!()
        }
        fn exists(&self, _: &str) -> bool {
            false
        }
        fn populated(&self, _: &str) -> bool {
            false
        }
        fn kill(&self, _: &str) {}
        fn memory(&self, _: &str) -> Option<Value> {
            None
        }
        fn remove(&self, _: &str) {}
    }

    struct Machine {
        _dir: tempfile::TempDir,
        root: PathBuf,
        journal: Journal,
    }

    fn machine(account: Option<Account>) -> Machine {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root");
        for sub in [
            "workspace",
            "tmp",
            "etc",
            "proc",
            "dev",
            "sys",
            "var/lib/cube",
        ] {
            fs::create_dir_all(root.join(sub)).unwrap();
        }
        let journal = Journal::new(
            root.join("var/lib/cube"),
            root.clone(),
            Arc::new(NoDomain),
            PathBuf::from("/bin/false"),
        );
        journal.set_launch(Launch {
            workspace: "/workspace".into(),
            namespace: None,
            account,
            env: BTreeMap::new(),
        });
        Machine {
            _dir: dir,
            root,
            journal,
        }
    }

    fn write(m: &Machine, key: &str, path: &str, body: &[u8], extra: Value) -> Answer {
        let mut header = json!({"id": key, "epoch": 1, "path": path, "length": body.len()});
        for (name, value) in extra.as_object().unwrap() {
            header[name] = value.clone();
        }
        m.journal.write(&header, body)
    }
    fn read(m: &Machine, path: &str) -> Answer {
        m.journal.read(&json!({"path": path}))
    }
    fn stat(m: &Machine, path: &str) -> Answer {
        m.journal.stat(&json!({"path": path}))
    }
    fn code(answer: Answer) -> String {
        answer.expect_err("a refusal").code
    }

    #[test]
    fn files_are_written_read_and_stated_as_cube_guest_does() {
        let m = machine(None);
        let written = write(
            &m,
            "w1",
            "d/notes/a.txt",
            b"hello\n",
            json!({"createParents": true}),
        )
        .unwrap()
        .0;
        assert_eq!(written["size"], 6);
        let sha = written["sha256"].as_str().unwrap().to_string();
        assert_eq!(
            fs::read(m.root.join("workspace/d/notes/a.txt")).unwrap(),
            b"hello\n"
        );
        let (header, content) = read(&m, "d/notes/a.txt").unwrap();
        assert_eq!(content, b"hello\n");
        assert_eq!(header["sha256"], sha);
        assert_eq!(header["eof"], true);
        assert_eq!(header["path"], "d/notes/a.txt");
        let (header, content) = m
            .journal
            .read(&json!({"path": "d/notes/a.txt", "offset": 1, "limit": 3}))
            .unwrap();
        assert_eq!(content, b"ell");
        assert_eq!(
            (header["size"].as_i64(), header["eof"].as_bool()),
            (Some(6), Some(false))
        );
        let info = stat(&m, "d/notes/a.txt").unwrap().0;
        assert_eq!(
            (info["kind"].as_str(), info["sha256"].as_str()),
            (Some("file"), Some(sha.as_str()))
        );
        assert_eq!(info["mode"], 0o644);
        assert_eq!(stat(&m, "d").unwrap().0["kind"], "directory");
        assert_eq!(stat(&m, "d").unwrap().0["sha256"], Value::Null);

        // expectedSha, a repeated key, CONFLICT, a failed key replays its failure
        let changed = write(
            &m,
            "w2",
            "d/notes/a.txt",
            b"changed\n",
            json!({"expectedSha": sha}),
        )
        .unwrap()
        .0;
        assert_eq!(
            write(
                &m,
                "w1",
                "d/notes/a.txt",
                b"hello\n",
                json!({"createParents": true})
            )
            .unwrap()
            .0,
            written
        );
        assert_eq!(
            read(&m, "d/notes/a.txt").unwrap().1,
            b"changed\n",
            "never written again"
        );
        assert_eq!(
            code(write(
                &m,
                "w1",
                "d/notes/a.txt",
                b"other\n",
                json!({"createParents": true})
            )),
            "CONFLICT"
        );
        for _ in 0..2 {
            assert_eq!(
                code(write(
                    &m,
                    "w3",
                    "d/notes/a.txt",
                    b"stale\n",
                    json!({"expectedSha": sha})
                )),
                "PRECONDITION_FAILED"
            );
        }
        write(
            &m,
            "w4",
            "d/notes/a.txt",
            b"edited\n",
            json!({"expectedSha": changed["sha256"]}),
        )
        .unwrap();
        assert_eq!(read(&m, "d/notes/a.txt").unwrap().1, b"edited\n");
        assert_eq!(
            code(write(&m, "w5", "d/missing/x", b"x", json!({}))),
            "NOT_FOUND",
            "no parents without createParents"
        );
        assert_eq!(
            code(write(&m, "w6", "d", b"x", json!({}))),
            "INVALID_REQUEST",
            "a directory is not replaced"
        );
        assert_eq!(
            code(write(&m, "w6b", "d/notes/a.txt/x", b"x", json!({}))),
            "NOT_FOUND",
            "a file is no parent"
        );

        // the mode is kept; no temporary file is left
        fs::set_permissions(
            m.root.join("workspace/d/notes/a.txt"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        write(&m, "w7", "d/notes/a.txt", b"kept\n", json!({})).unwrap();
        assert_eq!(
            fs::metadata(m.root.join("workspace/d/notes/a.txt"))
                .unwrap()
                .permissions()
                .mode()
                & 0o7777,
            0o600
        );
        assert_eq!(
            fs::read_dir(m.root.join("workspace/d/notes"))
                .unwrap()
                .count(),
            1
        );

        // a lease epoch never goes back
        m.journal
            .write(
                &json!({"id": "w8", "epoch": 5, "path": "e", "length": 0}),
                b"",
            )
            .unwrap();
        assert_eq!(code(write(&m, "w9", "e", b"", json!({}))), "LEASE_STALE");
    }

    #[test]
    fn paths_stay_in_the_workload_root() {
        let m = machine(None);
        for outside in [
            "../outside",
            "d/../../outside",
            "/tmp/../etc/passwd",
            "",
            "a\0b",
        ] {
            assert_eq!(code(read(&m, outside)), "INVALID_REQUEST", "{outside:?}");
            assert_eq!(code(stat(&m, outside)), "INVALID_REQUEST", "{outside:?}");
            assert_eq!(
                code(write(&m, "o", outside, b"x", json!({}))),
                "INVALID_REQUEST",
                "{outside:?}"
            );
        }
        assert_eq!(code(read(&m, &"a".repeat(4097))), "INVALID_REQUEST");
        // /workspace is the workspace; other absolute paths are the root's
        write(&m, "a1", "/workspace/abs.txt", b"abs\n", json!({})).unwrap();
        assert_eq!(read(&m, "abs.txt").unwrap().1, b"abs\n");
        write(
            &m,
            "a2",
            "/tmp/run/screens/shot.png",
            b"machine\n",
            json!({"createParents": true}),
        )
        .unwrap();
        assert_eq!(
            fs::read(m.root.join("tmp/run/screens/shot.png")).unwrap(),
            b"machine\n"
        );
        assert_eq!(code(read(&m, "/tmp/run/missing")), "NOT_FOUND");
        assert_eq!(code(stat(&m, "missing")), "NOT_FOUND");
        // kernel and device filesystems, also through a link
        fs::write(m.root.join("proc/status"), "x").unwrap();
        symlink("/proc", m.root.join("workspace/kernel")).unwrap();
        for pseudo in [
            "/proc/status",
            "/sys/kernel/hostname",
            "/dev/null",
            "/dev",
            "kernel/status",
        ] {
            assert_eq!(code(read(&m, pseudo)), "INVALID_REQUEST", "{pseudo}");
            assert_eq!(
                code(write(&m, "p", pseudo, b"x", json!({}))),
                "INVALID_REQUEST",
                "{pseudo}"
            );
        }
        assert_eq!(fs::read(m.root.join("proc/status")).unwrap(), b"x");
        // links resolve inside the root, never on this host
        symlink("/etc", m.root.join("workspace/etc-link")).unwrap();
        symlink("../../../../../../../../tmp", m.root.join("workspace/up")).unwrap();
        write(&m, "l1", "etc-link/hosts-test", b"in root\n", json!({})).unwrap();
        assert_eq!(
            fs::read(m.root.join("etc/hosts-test")).unwrap(),
            b"in root\n"
        );
        write(&m, "l2", "up/through", b"in root\n", json!({})).unwrap();
        assert_eq!(fs::read(m.root.join("tmp/through")).unwrap(), b"in root\n");
        assert_eq!(read(&m, "/etc/hosts-test").unwrap().1, b"in root\n");
        // a final link: stat sees the link, read follows it, write replaces it
        symlink("abs.txt", m.root.join("workspace/link")).unwrap();
        assert_eq!(stat(&m, "link").unwrap().0["kind"], "symlink");
        assert_eq!(stat(&m, "link").unwrap().0["sha256"], Value::Null);
        assert_eq!(read(&m, "link").unwrap().1, b"abs\n");
        // not regular files
        assert_eq!(code(read(&m, ".")), "INVALID_REQUEST");
        let fifo = CString::new(m.root.join("workspace/fifo").to_str().unwrap()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o644) }, 0);
        assert_eq!(
            code(read(&m, "fifo")),
            "INVALID_REQUEST",
            "never blocks on a FIFO"
        );
        assert_eq!(stat(&m, "fifo").unwrap().0["kind"], "other");
        assert_eq!(
            code(write(&m, "f", "fifo", b"x", json!({}))),
            "INVALID_REQUEST"
        );
        // limits
        assert_eq!(
            code(
                m.journal
                    .read(&json!({"path": "abs.txt", "limit": 524_289}))
            ),
            "INVALID_REQUEST"
        );
        assert_eq!(
            code(m.journal.read(&json!({"path": "abs.txt", "offset": -1}))),
            "INVALID_REQUEST"
        );
        assert_eq!(
            code(m.journal.write(
                &json!({"id": "x", "epoch": 1, "path": "x", "length": 2}),
                b"x"
            )),
            "INVALID_REQUEST"
        );
        assert_eq!(
            code(write(&m, "x", "x", b"x", json!({"expectedSha": "ABC"}))),
            "INVALID_REQUEST"
        );
        assert_eq!(
            code(write(&m, "x", "x", b"x", json!({"createParents": 1}))),
            "INVALID_REQUEST"
        );
        assert_eq!(
            code(write(&m, "bad key", "x", b"x", json!({}))),
            "INVALID_REQUEST"
        );
    }

    #[test]
    fn a_write_cut_off_is_never_done_again() {
        let m = machine(None);
        let request = json!({"kind": "write", "path": "cut", "sha256": hex(&Sha256::digest(b"x")), "expectedSha": null, "createParents": false});
        let ops = m.root.join("var/lib/cube/ops/cut-key");
        fs::create_dir_all(&ops).unwrap();
        let mut record = request.clone();
        record["hash"] = json!(crate::files::canonical(&request));
        write_json(&ops.join("request.json"), &record).unwrap();
        assert_eq!(
            code(write(&m, "cut-key", "cut", b"x", json!({}))),
            "COMPLETION_UNKNOWN"
        );
        assert!(!m.root.join("workspace/cut").exists());
        assert_eq!(
            read_json(&ops.join("result.json")).unwrap().unwrap()["state"],
            "Interrupted"
        );
    }

    /// Needs root (`sudo cargo test`): out of the workspace the operations
    /// have the agent account's permissions; in it, files are given to it.
    #[test]
    fn out_of_the_workspace_the_agent_account_acts() {
        if unsafe { libc::geteuid() } != 0 {
            eprintln!("skipped: needs root");
            return;
        }
        let nobody = Account {
            uid: 65534,
            gid: 65534,
            groups: vec![65534],
            home: "/home/agent".into(),
        };
        let m = machine(Some(nobody));
        fs::create_dir_all(m.root.join("root")).unwrap();
        fs::set_permissions(m.root.join("root"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::write(m.root.join("root/secret"), "s").unwrap();
        fs::set_permissions(
            m.root.join("root/secret"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let refused = write(&m, "r1", "/root/new", b"x", json!({})).unwrap_err();
        assert_eq!(refused.code, "IO_ERROR");
        assert!(
            refused
                .message
                .starts_with("permission denied: this path leads outside"),
            "{}",
            refused.message
        );
        assert!(
            read(&m, "/root/secret")
                .unwrap_err()
                .message
                .starts_with("permission denied")
        );
        assert!(!m.root.join("root/new").exists());
        // a workspace link out of it does not lend the agent's root rights
        symlink("/root", m.root.join("workspace/to-root")).unwrap();
        assert!(
            write(&m, "r2", "to-root/new", b"x", json!({}))
                .unwrap_err()
                .message
                .starts_with("permission denied")
        );
        // /tmp is open to the agent: its files are its own
        fs::set_permissions(m.root.join("tmp"), fs::Permissions::from_mode(0o1777)).unwrap();
        write(&m, "t1", "/tmp/a/b", b"x", json!({"createParents": true})).unwrap();
        assert_eq!(fs::metadata(m.root.join("tmp/a/b")).unwrap().uid(), 65534);
        assert_eq!(fs::metadata(m.root.join("tmp/a")).unwrap().uid(), 65534);
        // in the workspace the agent (root) writes and gives to the account
        write(&m, "w1", "n/e/w", b"x", json!({"createParents": true})).unwrap();
        for made in ["workspace/n", "workspace/n/e", "workspace/n/e/w"] {
            assert_eq!(
                fs::metadata(m.root.join(made)).unwrap().uid(),
                65534,
                "{made}"
            );
        }
        // and this thread is still root
        assert_eq!(unsafe { libc::geteuid() }, 0);
    }
}
