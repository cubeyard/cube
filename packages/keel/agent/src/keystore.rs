//! Java's system keystore and the runner's CA, checked on the first
//! `machine_setup` of each boot and again when a setup brings another CA.
//!
//! Debian's ca-certificates-java keeps one keystore for every packaged JDK,
//! `/etc/ssl/certs/java/cacerts` (JKS; each JDK's `lib/security/cacerts`
//! links to it), built from the `*.pem` links update-ca-certificates makes
//! in /etc/ssl/certs. keel makes the runner CA's link on every setup
//! (generated.rs), so a JDK installed after it trusts the CA. A keystore
//! made before (an image's, a template's from a build without the link, a
//! machine's from before a CA rotation) lacks it; this module adds it, so
//! no project needs a hook for Debian's Java:
//!
//! 1. No keystore: nothing to do (no outcome).
//! 2. The keystore is parsed as JKS (its structure to the end, not a byte
//!    search). It holds every certificate of the CA as a trusted entry:
//!    `ok`, nothing is written. PKCS#12, JCEKS or another format cube does
//!    not read: `skipped` (not checked). A damaged JKS or an empty file
//!    (Java cannot load it either): `failed`. Both are left as they are.
//! 3. `/etc/default/cacerts` turns updates off (`cacerts_updates`, the
//!    administrator's choice): `skipped`. A `storepass` there that cannot
//!    be read without a shell, or no `keytool` in the root: `failed`, since
//!    the keystore lacks the CA and stays so.
//! 4. A copy beside it (`.cacerts.cube-new`, same owner and mode) gets the
//!    CA from the JDK's own `keytool`, run as root in the workload root and
//!    in a cgroup of its own, 20 s per call, everything it started killed
//!    after it: a stale entry under cube's alias (`debian:cube-runner.pem`,
//!    the alias ca-certificates-java gives the link) is deleted first, then
//!    the CA is imported under it.
//! 5. The copy is parsed again and kept only if it holds the CA and every
//!    other certificate the keystore had (the public roots); then it is
//!    renamed over the keystore (`repaired`). Anything else removes the copy
//!    and leaves the keystore as it was (`failed`).
//!
//! The outcome goes to the console, to `/run/keel/runner-ca.json` (with the
//! CA's fingerprint: a later setup of this boot under the same CA does
//! nothing), to `status.guest.hooks["runner-ca"]`, and as one line to the
//! workload's `/run/cube/runner-ca`, which cubed's resume script reports
//! as the `runner-ca` outcome and `cube hooks` shows. The first setup of a
//! boot runs before any command. A later one with another CA (the runner's
//! CA rotated while the machine ran) repairs at once, while the workload
//! runs: a package manager writing the keystore at that moment can lose its
//! write or this one, and a JVM already running (a Gradle daemon) keeps the
//! trust it loaded until it starts again. JDKs that keep their own store
//! (SDKMAN, a tarball, a Gradle toolchain) are not touched: that stays a
//! project's (docs/project-hooks.md).
use std::{
    fs,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{fs::MetadataExt, process::CommandExt},
    },
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{
    files::hex,
    generated::{self, pem_blocks},
    paths::{self, open_resolved, resolve_in_root},
};

/// Debian's system keystore, in the workload root.
pub const KEYSTORE: &str = "etc/ssl/certs/java/cacerts";
/// ca-certificates-java's alias for `/etc/ssl/certs/cube-runner.pem`.
pub const ALIAS: &str = "debian:cube-runner.pem";
const DEFAULTS: &str = "etc/default/cacerts";
const COPY: &str = ".cacerts.cube-new";
/// This boot's outcome (base root, tmpfs).
pub const RECORD: &str = "/run/keel/runner-ca.json";
/// The same, one line, for the workload (tmpfs).
pub const NOTE: &str = "run/cube/runner-ca";
/// The `status.guest.hooks` key.
pub const HOOK: &str = "runner-ca";
/// Per `keytool` call (it takes about a second): at most two calls for a
/// runner's CA keep a setup well inside cubed's two minutes for `ready`.
const TIMEOUT: Duration = Duration::from_secs(20);
const MAX_KEYSTORE_BYTES: u64 = 16 << 20;
const MAX_OUTPUT: usize = 4096;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// The keystore holds the CA.
    Ok,
    /// The CA was added (or a stale one under cube's alias replaced).
    Repaired(String),
    /// Left alone on purpose, and why: updates turned off in
    /// `/etc/default/cacerts`, or a keystore format cube does not read.
    Skipped(String),
    /// The keystore lacks the CA, or cannot be loaded, and cube could not
    /// fix it; the keystore is as it was.
    Failed(String),
}

impl Outcome {
    pub fn word(&self) -> &'static str {
        match self {
            Outcome::Ok => "ok",
            Outcome::Repaired(_) => "repaired",
            Outcome::Skipped(_) => "skipped",
            Outcome::Failed(_) => "failed",
        }
    }
    pub fn detail(&self) -> String {
        match self {
            Outcome::Ok => format!("/{KEYSTORE} holds the runner's CA"),
            Outcome::Repaired(why) | Outcome::Skipped(why) | Outcome::Failed(why) => why.clone(),
        }
    }
}

/// What a keystore file is.
#[derive(Debug, PartialEq, Eq)]
pub enum Kind {
    /// JKS: every trusted certificate entry, alias and DER.
    Jks(Vec<(String, Vec<u8>)>),
    /// A keystore format cube does not read (whether it holds the CA is
    /// unknown), and which.
    Foreign(String),
    /// Not a keystore the JDK can load, and why.
    Damaged(String),
}

struct Reader<'a> {
    data: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn take(&mut self, n: usize) -> Result<&[u8], String> {
        let end = self.at.checked_add(n).filter(|&end| end <= self.data.len());
        let end = end.ok_or_else(|| format!("cut off at byte {}", self.at))?;
        let out = &self.data[self.at..end];
        self.at = end;
        Ok(out)
    }
    fn u16(&mut self) -> Result<usize, String> {
        Ok(u16::from_be_bytes(self.take(2)?.try_into().unwrap()) as usize)
    }
    fn u32(&mut self) -> Result<usize, String> {
        Ok(u32::from_be_bytes(self.take(4)?.try_into().unwrap()) as usize)
    }
    fn utf(&mut self) -> Result<String, String> {
        let n = self.u16()?;
        Ok(String::from_utf8_lossy(self.take(n)?).into_owned())
    }
    fn certificate(&mut self, version: usize) -> Result<Vec<u8>, String> {
        if version == 2 {
            let kind = self.utf()?;
            if kind != "X.509" {
                return Err(format!("a certificate of type {kind:?}"));
            }
        }
        let n = self.u32()?;
        Ok(self.take(n)?.to_vec())
    }
}

/// Reads a keystore's structure: JKS (`0xFEEDFEED`, version 1 or 2) to its
/// last entry and the 20-byte digest after it, nothing more and nothing
/// less. The digest is not checked (that needs the store password); a
/// keystore the JDK would refuse is refused by `keytool` in the repair.
pub fn kind(data: &[u8]) -> Kind {
    match data {
        [0xfe, 0xed, 0xfe, 0xed, ..] => match jks(data) {
            Ok(entries) => Kind::Jks(entries),
            Err(why) => Kind::Damaged(format!("a damaged JKS keystore ({why})")),
        },
        [0xce, 0xce, 0xce, 0xce, ..] => Kind::Foreign("a JCEKS keystore".into()),
        [0x30, ..] => Kind::Foreign("a PKCS#12 keystore".into()),
        [] => Kind::Damaged("an empty file".into()),
        _ => Kind::Foreign("not a keystore format cube knows".into()),
    }
}

fn jks(data: &[u8]) -> Result<Vec<(String, Vec<u8>)>, String> {
    let mut r = Reader { data, at: 4 };
    let version = r.u32()?;
    if version != 1 && version != 2 {
        return Err(format!("version {version}"));
    }
    let count = r.u32()?;
    let mut trusted = vec![];
    for _ in 0..count {
        let tag = r.u32()?;
        let alias = r.utf()?;
        r.take(8)?; // the date
        match tag {
            1 => {
                let key = r.u32()?;
                r.take(key)?;
                for _ in 0..r.u32()? {
                    r.certificate(version)?;
                }
            }
            2 => trusted.push((alias, r.certificate(version)?)),
            _ => return Err(format!("an entry of tag {tag}")),
        }
    }
    match data.len() - r.at {
        20 => Ok(trusted),
        n => Err(format!("{n} bytes after the entries, not a 20-byte digest")),
    }
}

/// `storepass` (default `changeit`) and whether updates are on, from
/// ca-certificates-java's `/etc/default/cacerts` (shell assignments, read
/// as its maintainer scripts source it): a value only a shell could read
/// is an error.
pub fn defaults(text: Option<&str>) -> Result<(String, bool), String> {
    let (mut storepass, mut updates) = ("changeit".to_string(), true);
    for line in text.unwrap_or_default().lines().map(str::trim) {
        let Some((name, value)) = line.split_once('=') else {
            continue;
        };
        if line.starts_with('#') || !matches!(name, "storepass" | "cacerts_updates") {
            continue;
        }
        let bare = match value.as_bytes() {
            [b'\'', .., b'\''] | [b'"', .., b'"'] if value.len() >= 2 => &value[1..value.len() - 1],
            _ => value,
        };
        if bare.is_empty() || bare.contains(['$', '`', '\\', '\'', '"', ' ', '\t', ';']) {
            return Err(format!("/{DEFAULTS}: {name} is not a plain value"));
        }
        match name {
            "storepass" => storepass = bare.to_string(),
            _ => updates = bare == "yes",
        }
    }
    Ok((storepass, updates))
}

/// What one `keytool` call did.
#[derive(Debug)]
pub struct Ran {
    pub status: Option<i32>,
    pub timed_out: bool,
    /// The end of its output (stdout and stderr).
    pub output: String,
}

/// Where a call runs: the workload's mount namespace (its `/` and working
/// directory), and a cgroup v2 directory made for the call and removed
/// after it, so what the call starts, a process that left its process group
/// too, is killed with `cgroup.kill`.
pub struct Confined<'a> {
    pub namespace: Option<&'a fs::File>,
    pub group: Option<&'a Path>,
}

/// How long the output may stay open after the call ended and its
/// processes were killed (something outside the call may hold it).
const OUTPUT_GRACE: Duration = Duration::from_secs(2);

/// Runs `/bin/sh -c script sh args…` as root with a clean environment and
/// `stdin` as its input, confined as `confined` says; after `timeout`, and
/// in any case once the shell has ended, its process group and its cgroup
/// are killed. Bounded in every case: the output is waited for at most
/// `OUTPUT_GRACE` after that (what was read by then is the output).
pub fn run(
    confined: &Confined,
    script: &str,
    args: &[String],
    stdin: &[u8],
    timeout: Duration,
) -> io::Result<Ran> {
    let group = match confined.group {
        Some(group) => Some(Group::new(group)?),
        None => None,
    };
    let (mut reader, writer) = io::pipe()?;
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(script)
        .arg("sh")
        .args(args)
        .env_clear()
        .env("PATH", crate::STANDARD_PATH)
        .env("LANG", "C.UTF-8")
        .env("HOME", "/root")
        .stdin(Stdio::piped())
        .stdout(writer.try_clone()?)
        .stderr(writer)
        .process_group(0);
    let procs = group.as_ref().map(|g| g.procs.as_raw_fd());
    let namespace = confined.namespace.map(|ns| ns.as_raw_fd());
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        command.pre_exec(move || {
            // Into the cgroup first ("0": the writer itself), through a
            // descriptor opened before the fork: the workload root has no
            // cgroup filesystem.
            if let Some(fd) = procs
                && libc::write(fd, b"0".as_ptr().cast(), 1) != 1
            {
                return Err(io::Error::last_os_error());
            }
            if let Some(fd) = namespace
                && (libc::setns(fd, libc::CLONE_NEWNS) != 0 || libc::chdir(c"/".as_ptr()) != 0)
            {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command.spawn()?;
    drop(command); // the parent's ends of the output pipe
    let pid = child.id() as libc::pid_t;
    let tail = std::sync::Arc::new(std::sync::Mutex::new(Vec::<u8>::new()));
    let (done, finished) = std::sync::mpsc::channel::<()>();
    {
        let tail = std::sync::Arc::clone(&tail);
        std::thread::spawn(move || {
            let mut buffer = [0u8; 4096];
            loop {
                let n = match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => n,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => break,
                };
                let mut tail = tail.lock().unwrap();
                tail.extend_from_slice(&buffer[..n]);
                if tail.len() > MAX_OUTPUT {
                    let extra = tail.len() - MAX_OUTPUT;
                    tail.drain(..extra);
                }
            }
            let _ = done.send(());
        });
    }
    if let Some(mut input) = child.stdin.take() {
        let stdin = stdin.to_vec();
        // Its own thread: a child that never reads it must not hold us.
        std::thread::spawn(move || {
            let _ = input.write_all(&stdin);
        });
    }
    let deadline = Instant::now() + timeout;
    // Waited for without reaping (WNOWAIT): until the child is reaped its
    // pid, the process group's id, cannot be reused, so the kill below
    // reaches only what it left running.
    let timed_out = loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let waited = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        };
        if waited != 0 {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            unsafe { libc::kill(-pid, libc::SIGKILL) };
            drop(group);
            let _ = child.wait();
            return Err(error);
        }
        if unsafe { info.si_pid() } != 0 {
            break false;
        }
        if Instant::now() >= deadline {
            break true;
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    unsafe { libc::kill(-pid, libc::SIGKILL) };
    let status = child.wait()?;
    drop(group); // kills what is left in it, then removes it
    let complete = finished.recv_timeout(OUTPUT_GRACE).is_ok();
    let mut output = String::from_utf8_lossy(&tail.lock().unwrap()).into_owned();
    if !complete {
        // The reading thread stays blocked until that process ends.
        output.push_str("\n(the output was still held open by a process outside the call)\n");
    }
    Ok(Ran {
        status: if timed_out { None } else { status.code() },
        timed_out,
        output,
    })
}

/// A cgroup made for one call: killed and removed when dropped.
struct Group {
    path: std::path::PathBuf,
    procs: fs::File,
}

impl Group {
    fn new(path: &Path) -> io::Result<Self> {
        if path.exists() {
            Self::empty(path); // left by a call cut off before
        }
        fs::create_dir(path)?;
        let procs = fs::OpenOptions::new()
            .write(true)
            .open(path.join("cgroup.procs"))?;
        Ok(Self {
            path: path.to_path_buf(),
            procs,
        })
    }
    /// `cgroup.kill`, up to two seconds for it to empty, then removed.
    fn empty(path: &Path) {
        let _ = fs::write(path.join("cgroup.kill"), "1");
        let deadline = Instant::now() + Duration::from_secs(2);
        while fs::read_to_string(path.join("cgroup.events"))
            .is_ok_and(|events| events.lines().any(|line| line == "populated 1"))
            && Instant::now() < deadline
        {
            std::thread::sleep(Duration::from_millis(10));
        }
        let _ = fs::remove_dir(path);
    }
}

impl Drop for Group {
    fn drop(&mut self) {
        Self::empty(&self.path);
    }
}

/// How the repair calls `keytool` (`run` in the workload; tests give their
/// own): the arguments after `keytool`, its input.
pub type Keytool<'a> = dyn FnMut(&[String], &[u8]) -> io::Result<Ran> + 'a;

/// `keytool` as the workload has it, with a small heap.
pub fn workload_keytool<'a>(
    confined: &'a Confined<'a>,
) -> impl FnMut(&[String], &[u8]) -> io::Result<Ran> + 'a {
    move |args, stdin| {
        let mut all = vec!["-J-Xmx64m".to_string()];
        all.extend_from_slice(args);
        run(confined, "exec keytool \"$@\"", &all, stdin, TIMEOUT)
    }
}

/// The cgroup each `keytool` call runs in, beside the operations' own.
pub const CGROUP: &str = "/sys/fs/cgroup/cube-keystore";

fn read_regular(
    root: &fs::File,
    components: &[String],
    max: u64,
) -> io::Result<Option<(Vec<u8>, fs::Metadata)>> {
    let file = match open_resolved(root, components, libc::O_RDONLY | libc::O_NONBLOCK, 0) {
        Ok(fd) => fs::File::from(fd),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Err(io::Error::other("not a regular file"));
    }
    if meta.len() > max {
        return Err(io::Error::other(format!("larger than {max} bytes")));
    }
    let mut data = vec![];
    (&file).take(max + 1).read_to_end(&mut data)?;
    Ok(Some((data, meta)))
}

fn c(text: &str) -> io::Result<std::ffi::CString> {
    std::ffi::CString::new(text).map_err(io::Error::other)
}

/// The alias for the CA's `index`th certificate (a runner's CA is one).
fn alias(index: usize) -> String {
    match index {
        0 => ALIAS.to_string(),
        n => format!("debian:cube-runner-{}.pem", n + 1),
    }
}

/// Steps 1-5 of the module comment for the workload root `root` and the
/// runner's CA (`ca`, PEM). None: there is no keystore.
pub fn reconcile(root: &fs::File, ca: &str, keytool: &mut Keytool) -> Option<Outcome> {
    let shown = format!("/{KEYSTORE}");
    let components = match resolve_in_root(root, KEYSTORE) {
        Ok(components) => components,
        Err(error) => return Some(Outcome::Failed(format!("{shown}: {error}"))),
    };
    let (data, meta) = match read_regular(root, &components, MAX_KEYSTORE_BYTES) {
        Ok(Some(found)) => found,
        Ok(None) => return None,
        Err(error) => return Some(Outcome::Failed(format!("{shown}: {error}"))),
    };
    let entries = match kind(&data) {
        Kind::Jks(entries) => entries,
        // A format cube does not read: whether it holds the CA is unknown.
        Kind::Foreign(what) => {
            return Some(Outcome::Skipped(format!(
                "{shown} is {what}; cube reads Debian's JKS only, so it was not checked"
            )));
        }
        // Java cannot load it either.
        Kind::Damaged(what) => {
            return Some(Outcome::Failed(format!("{shown} is {what}; left as it is")));
        }
    };
    let certificates = pem_blocks(ca.as_bytes());
    let missing: Vec<usize> = (0..certificates.len())
        .filter(|&i| !entries.iter().any(|(_, der)| *der == certificates[i].0))
        .collect();
    if missing.is_empty() {
        return Some(Outcome::Ok);
    }
    let defaults_text = paths::open_in_root_with(root, DEFAULTS, libc::O_RDONLY | libc::O_NONBLOCK)
        .ok()
        .map(fs::File::from)
        .and_then(|mut file| {
            let mut text = String::new();
            file.read_to_string(&mut text).ok().map(|_| text)
        });
    let storepass = match defaults(defaults_text.as_deref()) {
        Ok((_, false)) => {
            return Some(Outcome::Skipped(format!(
                "{shown} lacks the runner's CA; updates are off (cacerts_updates in /{DEFAULTS})"
            )));
        }
        Ok((storepass, true)) => storepass,
        Err(why) => {
            return Some(Outcome::Failed(format!(
                "{shown} lacks the runner's CA and cube cannot add it: {why}"
            )));
        }
    };
    if !paths::has_command(root, "keytool") {
        return Some(Outcome::Failed(format!(
            "{shown} lacks the runner's CA and cube cannot add it: the machine has no keytool"
        )));
    }
    let (parent, _) = components.split_at(components.len() - 1);
    let dir = match open_resolved(root, parent, libc::O_RDONLY | libc::O_DIRECTORY, 0) {
        Ok(dir) => dir,
        Err(error) => return Some(Outcome::Failed(format!("{shown}'s directory: {error}"))),
    };
    let copy_path = format!("/{}/{COPY}", parent.join("/"));
    // The keystore's own name where it is (a link to it was followed).
    let target_name = match c(components.last().map_or("cacerts", String::as_str)) {
        Ok(name) => name,
        Err(error) => return Some(Outcome::Failed(error.to_string())),
    };
    let copy_name = match c(COPY) {
        Ok(name) => name,
        Err(error) => return Some(Outcome::Failed(error.to_string())),
    };
    let result = repair(
        &dir,
        &copy_name,
        &target_name,
        &copy_path,
        &data,
        &meta,
        &entries,
        &certificates,
        &missing,
        &storepass,
        keytool,
    );
    match result {
        Ok(replaced) => Some(Outcome::Repaired(format!(
            "added the runner's CA to {shown}{}; its {} other certificates kept",
            if replaced {
                ", in place of a stale one under its alias"
            } else {
                ""
            },
            entries.len() - usize::from(replaced),
        ))),
        Err(why) => {
            unsafe { libc::unlinkat(dir.as_raw_fd(), copy_name.as_ptr(), 0) };
            Some(Outcome::Failed(format!(
                "{shown} lacks the runner's CA and was left as it was: {why}"
            )))
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn repair(
    dir: &OwnedFd,
    copy_name: &std::ffi::CStr,
    target: &std::ffi::CStr,
    copy_path: &str,
    data: &[u8],
    meta: &fs::Metadata,
    entries: &[(String, Vec<u8>)],
    certificates: &[(Vec<u8>, Vec<u8>)],
    missing: &[usize],
    storepass: &str,
    keytool: &mut Keytool,
) -> Result<bool, String> {
    let failed = |what: &str, error: io::Error| format!("{what}: {error}");
    // A copy left by a repair that was cut off is never reused.
    unsafe { libc::unlinkat(dir.as_raw_fd(), copy_name.as_ptr(), 0) };
    let fd = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            copy_name.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(failed("the copy", io::Error::last_os_error()));
    }
    let mut copy = fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
    copy.write_all(data).map_err(|e| failed("the copy", e))?;
    if unsafe { libc::fchown(copy.as_raw_fd(), meta.uid(), meta.gid()) } != 0
        || unsafe { libc::fchmod(copy.as_raw_fd(), meta.mode() & 0o7777) } != 0
    {
        return Err(failed(
            "the copy's owner and mode",
            io::Error::last_os_error(),
        ));
    }
    copy.sync_all().map_err(|e| failed("the copy", e))?;
    drop(copy);

    let common = |args: &[&str]| -> Vec<String> {
        let mut all: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        all.extend(
            [
                "-noprompt",
                "-keystore",
                copy_path,
                "-storetype",
                "JKS",
                "-storepass",
                storepass,
            ]
            .map(String::from),
        );
        all
    };
    let mut call = |args: Vec<String>, input: &[u8], what: &str| -> Result<(), String> {
        let ran = keytool(&args, input).map_err(|e| failed(&format!("keytool {what}"), e))?;
        let tail = ran.output.trim().lines().rev().take(3).collect::<Vec<_>>();
        let tail = tail.into_iter().rev().collect::<Vec<_>>().join(" / ");
        match (ran.timed_out, ran.status) {
            (true, _) => Err(format!(
                "keytool {what} took longer than {} s",
                TIMEOUT.as_secs()
            )),
            (false, Some(0)) => Ok(()),
            (false, status) => Err(format!(
                "keytool {what} exited {}: {tail}",
                status.map_or("on a signal".into(), |s| s.to_string())
            )),
        }
    };
    let mut replaced = vec![];
    for &index in missing {
        let name = alias(index);
        if let Some((_, der)) = entries.iter().find(|(a, _)| a.eq_ignore_ascii_case(&name)) {
            call(common(&["-delete", "-alias", &name]), b"", "-delete")?;
            replaced.push(der.clone());
        }
        call(
            common(&["-importcert", "-alias", &name]),
            &certificates[index].1,
            "-importcert",
        )?;
    }

    // Kept only if it holds the CA and every other certificate it had.
    let mut after = vec![];
    let opened = unsafe {
        libc::openat(
            dir.as_raw_fd(),
            copy_name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if opened < 0 {
        return Err(failed("the copy after keytool", io::Error::last_os_error()));
    }
    let copy = fs::File::from(unsafe { OwnedFd::from_raw_fd(opened) });
    (&copy)
        .take(MAX_KEYSTORE_BYTES + 1)
        .read_to_end(&mut after)
        .map_err(|e| failed("the copy after keytool", e))?;
    let now = match kind(&after) {
        Kind::Jks(entries) => entries,
        Kind::Foreign(what) | Kind::Damaged(what) => return Err(format!("keytool left {what}")),
    };
    let has = |der: &Vec<u8>| now.iter().any(|(_, have)| have == der);
    if certificates.iter().any(|(der, _)| !has(der)) {
        return Err("keytool's copy lacks a certificate of the CA".into());
    }
    let lost = entries
        .iter()
        .filter(|(_, der)| !replaced.contains(der) && !has(der))
        .count();
    if lost > 0 {
        return Err(format!(
            "keytool's copy lost {lost} of the keystore's certificates"
        ));
    }
    // The keystore's owner and mode, whatever keytool wrote.
    if unsafe { libc::fchown(copy.as_raw_fd(), meta.uid(), meta.gid()) } != 0
        || unsafe { libc::fchmod(copy.as_raw_fd(), meta.mode() & 0o7777) } != 0
    {
        return Err(failed(
            "the copy's owner and mode",
            io::Error::last_os_error(),
        ));
    }
    copy.sync_all().map_err(|e| failed("the copy", e))?;
    if unsafe {
        libc::renameat(
            dir.as_raw_fd(),
            copy_name.as_ptr(),
            dir.as_raw_fd(),
            target.as_ptr(),
        )
    } != 0
    {
        return Err(failed(
            "renaming the copy over the keystore",
            io::Error::last_os_error(),
        ));
    }
    unsafe { libc::fsync(dir.as_raw_fd()) };
    Ok(!replaced.is_empty())
}

fn fingerprint(ca: &str) -> String {
    hex(&Sha256::digest(ca.as_bytes()))
}

/// This boot's recorded outcome word, for `status.guest.hooks`.
pub fn recorded() -> Option<String> {
    crate::files::read_json(Path::new(RECORD))
        .ok()
        .flatten()
        .and_then(|record| record["outcome"].as_str().map(str::to_string))
}

/// On a setup (setup.rs, after the generated files): the check and repair
/// for this boot's CA, once per CA; the outcome recorded and shown.
pub fn at_setup(root: &Path, namespace: &Path, ca: Option<&str>) {
    let Ok(root_dir) = fs::File::open(root) else {
        return;
    };
    let Some(ca) = ca else {
        let _ = fs::remove_file(RECORD);
        let _ = generated::put_file(&root_dir, NOTE, None);
        return;
    };
    let print = fingerprint(ca);
    let known: Option<Value> = crate::files::read_json(Path::new(RECORD)).ok().flatten();
    if known.as_ref().is_some_and(|k| k["ca"] == print.as_str()) {
        return;
    }
    let started = Instant::now();
    let outcome = match fs::File::open(namespace) {
        Ok(ns) => {
            // Without a cgroup filesystem the process group is still killed.
            let cgroups = Path::new("/sys/fs/cgroup/cgroup.procs").exists();
            let confined = Confined {
                namespace: Some(&ns),
                group: cgroups.then(|| Path::new(CGROUP)),
            };
            reconcile(&root_dir, ca, &mut workload_keytool(&confined))
        }
        Err(error) => Some(Outcome::Failed(format!("the workload namespace: {error}"))),
    };
    let record = match &outcome {
        Some(outcome) => {
            json!({"ca": print, "outcome": outcome.word(), "detail": outcome.detail()})
        }
        None => json!({"ca": print, "outcome": null}),
    };
    if let Err(error) = crate::files::write_json(Path::new(RECORD), &record) {
        eprintln!("cube-agent: {RECORD}: {error}");
    }
    let note = outcome
        .as_ref()
        .map(|o| format!("{} {}\n", o.word(), o.detail().replace('\n', " ")));
    if note.is_some()
        && let Err(error) = make_run_cube(&root_dir)
    {
        eprintln!("cube-agent: /run/cube: {error}");
    }
    if let Err(error) = generated::put_file(&root_dir, NOTE, note.as_deref()) {
        eprintln!("cube-agent: /{NOTE}: {error}");
    }
    if let Some(outcome) = outcome {
        eprintln!(
            "cube-agent: runner CA in Java's keystore: {} ({}; {} ms)",
            outcome.word(),
            outcome.detail(),
            started.elapsed().as_millis()
        );
    }
}

/// The workload's /run/cube (a tmpfs below it), made inside the root.
fn make_run_cube(root: &fs::File) -> io::Result<()> {
    let Some(run) = generated::open_dir(root, "run")? else {
        return Err(io::Error::other("the root has no /run"));
    };
    let name = c("cube")?;
    if unsafe { libc::mkdirat(run.as_raw_fd(), name.as_ptr(), 0o755) } != 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests;
