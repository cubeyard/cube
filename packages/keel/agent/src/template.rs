//! Template publishing (`DaemonRequest.template_publish`, masterplan K-5e):
//! a build machine's `upper/` becomes an EROFS layer on its template disk,
//! vdd, which the runner checks and keeps as a template; later machines
//! mount it as their topmost lower layer.
//!
//! The machine is used up by it, as a sealed p3 build machine is powered
//! off: services and their processes are killed, the workload's mount
//! namespace and root are detached, `upper/` is cleaned in place
//! ([`scrub`]), checked ([`seal_check`]) and written with the base's
//! `mkfs.erofs`. Afterwards every operation and setup is refused until the
//! machine powers off; a repeated request gets the same outcome.
//!
//! What is cube's and never travels in a template (what cube-guest's
//! `seal_final` removes, and what keel put into the overlay):
//!   - cube's marker blocks (the CA bundle, /etc/gitconfig, /etc/environment)
//!     and every PEM certificate equal to a CA a setup brought, in any file;
//!     `cube-runner.crt`, `cube-runner.pem` and links to them
//!   - the empty mount points this agent made (`state/mount-points`) and the
//!     paths cube binds over in every machine
//!   - the `agent` account's lines that the layers below do not have
//!   - /var/lib/cube, /etc/cube, the hook logs, shell histories, ssh host
//!     keys, machine ids and the random seed
//!
//! Anything left that still holds a marker line fails the publication: no
//! layer is written. So does what still holds a runner CA (its DER, or the
//! start of its base64), and a Java keystore changed by the build while a
//! runner CA was installed (keel cannot clean one yet), unless the runner
//! binds its templates to its CA (`setup::TEMPLATE_RUNNER_CA`): it records
//! the CA's fingerprint with the template and refuses the template under
//! another CA, so the layer may keep that CA's public certificate (in the
//! Java keystore, say). Then the machine must never have had another CA
//! (`runner_ca_changed`).
use std::{
    fs,
    io::{self, Read, Write},
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::{Path, PathBuf},
};

use cube_runner_protocol::{
    proto::{self, Code},
    refuse,
};
use serde_json::{Value, json};

use crate::{
    generated::{self, BEGIN, CA_FILE, MOUNT_POINTS, RUNNER_CAS},
    setup::{self, Refusal},
};

/// The template disk: the fourth virtio disk, on build machines only.
pub const TEMPLATE_DISK: &str = "/dev/vdd";
/// This boot's outcome (`{"outcome": "ok", "bytes": N}` or a failure).
pub const PUBLISHED: &str = "/run/keel/published.json";
const UPPER: &str = "/run/keel/rw/upper";
const OPS_CGROUP: &str = "/sys/fs/cgroup/cube-ops";
const SERVICES_CGROUP: &str = "/sys/fs/cgroup/cube-services";
/// A file cleaned in place is read whole; a larger one that needs it fails.
const MAX_CLEAN_BYTES: u64 = 16 << 20;
/// The paths cube binds over in every machine: whatever `upper/` holds
/// there is never seen, so it goes.
const BOUND_PATHS: [&str; 5] = [
    "etc/hosts",
    "etc/hostname",
    "etc/resolv.conf",
    "etc/sudoers.d/cube",
    setup::CLI,
];
const ACCOUNT_FILES: [&str; 4] = ["etc/passwd", "etc/group", "etc/shadow", "etc/gshadow"];
const JAVA_KEYSTORE: &str = "etc/ssl/certs/java/cacerts";

/// What the scrub needs to know about the machine.
pub struct Machine<'a> {
    /// The lower layers' mount points, topmost first.
    pub lowers: &'a [PathBuf],
    /// The DER of every CA a setup brought.
    pub cas: &'a [Vec<u8>],
    /// Paths (below the root) of the mount points this agent made.
    pub mount_points: &'a [String],
    /// The agent account's home, as in the root ("/home/agent").
    pub home: &'a str,
}

/// `rel` below `upper`, when no component on the way is a link (the scrub
/// never follows one; nothing else runs while it works).
fn plain(upper: &Path, rel: &str) -> Option<PathBuf> {
    let mut path = upper.to_path_buf();
    let parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
    for (i, part) in parts.iter().enumerate() {
        path.push(part);
        let meta = fs::symlink_metadata(&path).ok()?;
        if i + 1 < parts.len() && !meta.is_dir() {
            return None;
        }
    }
    Some(path)
}

fn is_whiteout(meta: &fs::Metadata) -> bool {
    meta.file_type().is_char_device() && meta.rdev() == 0
}

fn opaque(path: &Path) -> bool {
    let (Ok(path), Ok(name)) = (
        std::ffi::CString::new(path.as_os_str().as_encoded_bytes()),
        std::ffi::CString::new("trusted.overlay.opaque"),
    ) else {
        return false;
    };
    let mut value = [0u8; 4];
    let n = unsafe {
        libc::lgetxattr(
            path.as_ptr(),
            name.as_ptr(),
            value.as_mut_ptr().cast(),
            value.len(),
        )
    };
    n == 1 && value[0] == b'y'
}

/// The file at `rel` as the lower layers show it (topmost first), as
/// overlayfs would: None when no layer has it, or a whiteout or an opaque
/// directory in a higher layer hides it. Links are not followed.
pub fn lower_file(lowers: &[PathBuf], rel: &str) -> Option<Vec<u8>> {
    let parts: Vec<&str> = rel.split('/').filter(|p| !p.is_empty()).collect();
    for layer in lowers {
        let mut path = layer.clone();
        let mut stop = false;
        for (i, part) in parts.iter().enumerate() {
            path.push(part);
            let Ok(meta) = fs::symlink_metadata(&path) else {
                break; // not in this layer: look below
            };
            if is_whiteout(&meta) {
                return None;
            }
            if i + 1 == parts.len() {
                return meta.is_file().then(|| fs::read(&path).ok()).flatten();
            }
            if !meta.is_dir() {
                return None; // a file hides the directories below it
            }
            stop |= opaque(&path);
        }
        if stop {
            return None;
        }
    }
    None
}

/// Rewrites a file in place (the inode, its owner, mode and xattrs stay).
fn rewrite(path: &Path, data: &[u8]) -> io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)?;
    file.write_all(data)?;
    file.sync_all()
}

fn remove(path: &Path) -> io::Result<()> {
    let meta = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if meta.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

/// What a runner CA leaves in a file, found anywhere in its bytes, and
/// cube's marker, found only as a line of its own ([`MarkerLine`]).
struct Needles(Vec<Vec<u8>>);

impl Needles {
    fn new(cas: &[Vec<u8>]) -> Self {
        use base64::Engine;
        let mut needles = vec![];
        for der in cas {
            needles.push(der.clone());
            // The first 48 bytes as base64: the first line of any PEM copy
            // (64 or more characters a line), whatever its wrapping.
            let head = &der[..der.len().min(48)];
            needles.push(
                base64::engine::general_purpose::STANDARD
                    .encode(head)
                    .into_bytes(),
            );
        }
        Self(needles)
    }

    fn longest(&self) -> usize {
        self.0.iter().map(Vec::len).max().unwrap_or(1)
    }

    fn in_bytes(&self, data: &[u8]) -> bool {
        self.0
            .iter()
            .any(|needle| memchr::memmem::find(data, needle).is_some())
    }

    /// Whether the file holds a runner CA or a marker line, read in pieces.
    fn in_file(&self, path: &Path) -> io::Result<bool> {
        let mut file = fs::File::open(path)?;
        let keep = self.longest().saturating_sub(1);
        let mut buffer = vec![0u8; (1 << 20) + keep];
        let mut have = 0;
        let mut marker = MarkerLine::default();
        loop {
            let n = file.read(&mut buffer[have..])?;
            if n == 0 {
                return Ok(marker.end() || (have > 0 && self.in_bytes(&buffer[..have])));
            }
            // Each byte goes to the marker's scan once; the needles see the
            // kept tail again.
            if marker.feed(&buffer[have..have + n]) {
                return Ok(true);
            }
            have += n;
            if self.in_bytes(&buffer[..have]) {
                return Ok(true);
            }
            let from = have.saturating_sub(keep);
            buffer.copy_within(from..have, 0);
            have -= from;
        }
    }
}

/// A line that is cube's marker, as keel writes it (`generated::with_block`):
/// the marker with nothing else on the line but spaces or tabs before it
/// and spaces, tabs or a carriage return after it. That is wider than the
/// scrub, which cuts out only a block whose line is the marker exactly, so
/// an indented or CRLF marker line fails the seal rather than travel. The
/// marker inside a longer line (a string literal in cube's own source, a
/// sentence about it, a binary that embeds it) is no block of cube's: what
/// a block could carry that matters, the runner's CA, the needles find in
/// any form. Fed a file's bytes in order, in pieces of any size.
#[derive(Default)]
struct MarkerLine {
    state: Marker,
}

#[derive(Default, Clone, Copy, PartialEq)]
enum Marker {
    /// At the start of a line, or after spaces and tabs there.
    #[default]
    Lead,
    /// This many bytes of the marker matched.
    Matched(usize),
    /// The whole marker, then only spaces, tabs or carriage returns.
    Trail,
    /// Not a marker line: wait for the next one.
    Other,
}

impl MarkerLine {
    /// Whether a marker line ended in `data`.
    fn feed(&mut self, data: &[u8]) -> bool {
        let marker = BEGIN.as_bytes();
        let mut i = 0;
        while i < data.len() {
            if self.state == Marker::Other {
                match memchr::memchr(b'\n', &data[i..]) {
                    Some(at) => {
                        self.state = Marker::Lead;
                        i += at + 1;
                        continue;
                    }
                    None => return false,
                }
            }
            let byte = data[i];
            i += 1;
            if byte == b'\n' {
                if self.state == Marker::Trail {
                    return true;
                }
                self.state = Marker::Lead;
                continue;
            }
            self.state = match self.state {
                Marker::Lead if byte == b' ' || byte == b'\t' => Marker::Lead,
                Marker::Lead if byte == marker[0] => Marker::Matched(1),
                Marker::Matched(n) if n < marker.len() && byte == marker[n] => {
                    if n + 1 == marker.len() {
                        Marker::Trail
                    } else {
                        Marker::Matched(n + 1)
                    }
                }
                Marker::Trail if matches!(byte, b' ' | b'\t' | b'\r') => Marker::Trail,
                _ => Marker::Other,
            };
        }
        false
    }

    /// Whether the file ended on a marker line (no newline after it).
    fn end(&self) -> bool {
        self.state == Marker::Trail
    }
}

/// Every regular file below `dir`, links never followed.
fn files(dir: &Path, out: &mut Vec<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_dir() {
            files(&entry.path(), out)?;
        } else if kind.is_file() {
            out.push(entry.path());
        }
    }
    Ok(())
}

fn shown(upper: &Path, path: &Path) -> String {
    format!(
        "/{}",
        path.strip_prefix(upper).unwrap_or(path).to_string_lossy()
    )
}

/// Cleans `upper` in place of what is cube's (the module's list). Returns
/// what it changed, for the console.
pub fn scrub(upper: &Path, machine: &Machine) -> io::Result<Vec<String>> {
    let mut changed = vec![];
    let gone = |upper: &Path, rel: &str, changed: &mut Vec<String>| -> io::Result<()> {
        if let Some(path) = plain(upper, rel)
            && fs::symlink_metadata(&path).is_ok()
        {
            remove(&path)?;
            changed.push(format!("removed /{rel}"));
        }
        Ok(())
    };
    let home = machine.home.trim_start_matches('/');
    // cube-guest's seal_final, for what exists in a keel root.
    for rel in [
        "var/lib/cube".to_string(),
        "etc/cube".to_string(),
        format!("{home}/.cache/cube"),
        format!("{home}/.bash_history"),
        "root/.bash_history".to_string(),
        "root/.cache/cube".to_string(),
        "var/lib/dbus/machine-id".to_string(),
        "var/lib/systemd/random-seed".to_string(),
        CA_FILE.to_string(),
        "etc/ssl/certs/cube-runner.pem".to_string(),
    ] {
        gone(upper, &rel, &mut changed)?;
    }
    for dir in ["etc/ssh", "var/lib/dhcp", "etc/ssl/certs"] {
        let Some(path) = plain(upper, dir).filter(|p| p.is_dir()) else {
            continue;
        };
        for entry in fs::read_dir(&path)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let doomed = match dir {
                "etc/ssh" => name.starts_with("ssh_host_"),
                "var/lib/dhcp" => true,
                // update-ca-certificates' links (the hash ones) to cube's CA.
                _ => {
                    entry.file_type()?.is_symlink()
                        && fs::read_link(entry.path()).is_ok_and(|target| {
                            target
                                .file_name()
                                .is_some_and(|n| n == "cube-runner.pem" || n == "cube-runner.crt")
                        })
                }
            };
            if doomed {
                remove(&entry.path())?;
                changed.push(format!("removed /{dir}/{name}"));
            }
        }
    }
    // An empty machine id: the next machine gets its own.
    if let Some(path) = plain(upper, "etc/machine-id")
        && fs::symlink_metadata(&path).is_ok_and(|m| m.is_file() && m.len() > 0)
    {
        rewrite(&path, b"")?;
        changed.push("emptied /etc/machine-id".into());
    }
    // Mount points: the paths bound in every machine, and what this agent
    // made (newest first, so a directory it made goes after its file).
    for rel in BOUND_PATHS {
        if let Some(path) = plain(upper, rel)
            && fs::symlink_metadata(&path).is_ok_and(|m| m.is_file())
        {
            remove(&path)?;
            changed.push(format!("removed /{rel}"));
        }
    }
    for rel in machine.mount_points.iter().rev() {
        let Some(path) = plain(upper, rel) else {
            continue;
        };
        let empty = match fs::symlink_metadata(&path) {
            Ok(meta) if meta.is_file() => meta.len() == 0,
            Ok(meta) if meta.is_dir() => fs::read_dir(&path)?.next().is_none(),
            _ => false,
        };
        if empty {
            remove(&path)?;
            changed.push(format!("removed /{rel}"));
        }
    }
    // The agent account: the lines keel added, which the layers lack.
    for rel in ACCOUNT_FILES {
        let Some(path) = plain(upper, rel).filter(|p| p.is_file()) else {
            continue;
        };
        let text = fs::read(&path)?;
        let lower = lower_file(machine.lowers, rel);
        let below: Vec<&[u8]> = lower
            .as_deref()
            .map(|l| l.split(|&b| b == b'\n').collect())
            .unwrap_or_default();
        let kept: Vec<u8> = text
            .split_inclusive(|&b| b == b'\n')
            .filter(|line| {
                let bare = line.strip_suffix(b"\n").unwrap_or(line);
                !bare.starts_with(b"agent:") || below.contains(&bare)
            })
            .flatten()
            .copied()
            .collect();
        if kept == text {
            continue;
        }
        if lower.as_deref() == Some(&kept[..]) {
            fs::remove_file(&path)?; // the same as below: the lower one shows
        } else {
            rewrite(&path, &kept)?;
        }
        changed.push(format!("removed the agent account from /{rel}"));
    }
    // The runner's CAs and cube's blocks, in any file.
    let needles = Needles::new(machine.cas);
    let mut all = vec![];
    files(upper, &mut all)?;
    for path in all {
        if !needles.in_file(&path)? {
            continue;
        }
        if fs::metadata(&path)?.len() > MAX_CLEAN_BYTES {
            continue; // the seal check names it
        }
        let data = fs::read(&path)?;
        let clean = generated::without_runner_cas(&data, machine.cas);
        if clean != data {
            rewrite(&path, &clean)?;
            changed.push(format!(
                "removed cube's block or the runner's CA from {}",
                shown(upper, &path)
            ));
        }
    }
    Ok(changed)
}

/// The seal's check on what the scrub left: every file that still holds a
/// runner CA of `cas` or a marker line, and a Java keystore the build
/// changed while a CA of `cas` was installed. Empty: the layer may be
/// published.
pub fn seal_check(upper: &Path, cas: &[Vec<u8>]) -> io::Result<Vec<String>> {
    let needles = Needles::new(cas);
    let mut all = vec![];
    files(upper, &mut all)?;
    let mut left = vec![];
    for path in all {
        if needles.in_file(&path)? {
            left.push(format!(
                "{} holds cube's block or a runner CA",
                shown(upper, &path)
            ));
        }
    }
    if !cas.is_empty() && plain(upper, JAVA_KEYSTORE).is_some_and(|p| p.is_file()) {
        left.push(format!(
            "/{JAVA_KEYSTORE} was changed by the build and may hold the runner's CA (keel cannot clean a Java keystore yet)"
        ));
    }
    Ok(left)
}

fn failed(reason: &str, message: impl AsRef<str>) -> Refusal {
    refuse(Code::FailedPrecondition, reason, message.as_ref())
}

/// The CAs the seal refuses in the layer: every CA a setup brought (`cas`),
/// or none when the runner binds its templates to the CA this boot's setup
/// brought (`bound`) and the machine never had another.
pub fn sealed_cas(cas: &[Vec<u8>], bound: Option<&[Vec<u8>]>) -> Result<Vec<Vec<u8>>, Refusal> {
    let Some(bound) = bound.filter(|bound| !bound.is_empty()) else {
        return Ok(cas.to_vec());
    };
    if cas.iter().all(|ca| bound.contains(ca)) {
        return Ok(vec![]);
    }
    Err(failed(
        "runner_ca_changed",
        "the machine had another runner CA before this one, which its layer may hold; build the template on a new machine",
    ))
}

/// The outcome of this boot's publication, if there was one.
pub fn published() -> Option<Value> {
    crate::files::read_json(Path::new(PUBLISHED)).ok().flatten()
}

/// The answer a published machine gives: done, or the failure again.
pub fn outcome(record: &Value) -> Result<(), Refusal> {
    match record["outcome"].as_str() {
        Some("ok") => Ok(()),
        other => Err(proto::Error {
            code: record["code"]
                .as_i64()
                .map_or(Code::Internal as i32, |c| c as i32),
            reason: record["reason"].as_str().unwrap_or("publish_failed").into(),
            message: record["message"]
                .as_str()
                .or(other)
                .unwrap_or("the publication failed")
                .into(),
            completion_unknown: false,
        }),
    }
}

/// Child cgroups of `parent` (operations or services).
fn groups(parent: &str) -> Vec<PathBuf> {
    fs::read_dir(parent)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|e| e.file_type().is_ok_and(|t| t.is_dir()))
                .map(|e| e.path())
                .collect()
        })
        .unwrap_or_default()
}

fn populated(group: &Path) -> bool {
    fs::read_to_string(group.join("cgroup.events"))
        .is_ok_and(|events| events.lines().any(|line| line == "populated 1"))
}

/// Whether an operation's processes still run.
pub fn busy() -> bool {
    groups(OPS_CGROUP).iter().any(|group| populated(group))
}

/// Kills every process of the workload's operations and services, and
/// waits (10 s) until they are gone.
fn kill_workload() -> Result<(), Refusal> {
    let all: Vec<PathBuf> = groups(OPS_CGROUP)
        .into_iter()
        .chain(groups(SERVICES_CGROUP))
        .collect();
    for group in &all {
        let _ = fs::write(group.join("cgroup.kill"), "1");
    }
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while all.iter().any(|group| populated(group)) {
        if std::time::Instant::now() > deadline {
            return Err(refuse(
                Code::Internal,
                "publish_failed",
                "the workload's processes did not end",
            ));
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    Ok(())
}

fn detach(path: &str) -> Result<(), Refusal> {
    let target = std::ffi::CString::new(path).unwrap();
    if unsafe { libc::umount2(target.as_ptr(), libc::MNT_DETACH) } != 0 {
        let error = io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::EINVAL) {
            return Err(refuse(
                Code::Internal,
                "publish_failed",
                &format!("detaching {path}: {error}"),
            ));
        }
    }
    Ok(())
}

/// The EROFS superblock's size of the image on `disk`, or None.
pub fn erofs_bytes(disk: &Path) -> io::Result<Option<u64>> {
    use std::os::unix::fs::FileExt;
    let mut sb = [0u8; 128];
    fs::File::open(disk)?.read_exact_at(&mut sb, 1024)?;
    if sb[..4] != 0xE0F5E1E2u32.to_le_bytes() {
        return Ok(None);
    }
    let blkszbits = u32::from(sb[12]);
    let blocks = u32::from_le_bytes(sb[36..40].try_into().unwrap());
    Ok(Some(u64::from(blocks) << blkszbits))
}

/// The layers below `upper` (from this boot's setup), topmost first.
fn lowers() -> Vec<PathBuf> {
    crate::files::read_json(Path::new(setup::SETUP))
        .ok()
        .flatten()
        .and_then(|setup| {
            setup["layers"].as_array().map(|layers| {
                layers
                    .iter()
                    .filter_map(|layer| layer["partition"].as_u64())
                    .map(|n| PathBuf::from(format!("{}/layers/{n}", setup::RUN)))
                    .collect()
            })
        })
        .unwrap_or_default()
}

/// Publishes this build machine's `upper/` to the template disk (the
/// module's steps). The caller has refused a busy machine and halted the
/// services' supervisor; the outcome is recorded either way.
pub fn publish(home: &str) -> Result<u64, Refusal> {
    let result = publish_inner(home);
    let record = match &result {
        Ok(bytes) => json!({"outcome": "ok", "bytes": bytes}),
        Err(error) => json!({
            "outcome": format!("failed: {}", error.message),
            "code": error.code,
            "reason": error.reason,
            "message": error.message,
        }),
    };
    if let Err(error) = crate::files::write_json(Path::new(PUBLISHED), &record) {
        eprintln!("cube-agent: {PUBLISHED}: {error}");
    }
    result
}

fn publish_inner(home: &str) -> Result<u64, Refusal> {
    let io = |what: &'static str| {
        move |error: io::Error| {
            refuse(
                Code::Internal,
                "publish_failed",
                &format!("{what}: {error}"),
            )
        }
    };
    kill_workload()?;
    detach(setup::NAMESPACE)?;
    detach(setup::ROOT)?;
    let state = Path::new(setup::STATE);
    let cas = generated::pem_certificates(&fs::read(state.join(RUNNER_CAS)).unwrap_or_default());
    let mount_points: Vec<String> = fs::read_to_string(state.join(MOUNT_POINTS))
        .unwrap_or_default()
        .lines()
        .map(str::to_string)
        .collect();
    let lowers = lowers();
    let upper = Path::new(UPPER);
    let changed = scrub(
        upper,
        &Machine {
            lowers: &lowers,
            cas: &cas,
            mount_points: &mount_points,
            home,
        },
    )
    .map_err(io("cleaning the layer"))?;
    for line in &changed {
        eprintln!("cube-agent: template: {line}");
    }
    let bound = fs::read(setup::BOUND_CA)
        .ok()
        .map(|pem| generated::pem_certificates(&pem));
    let sealed = sealed_cas(&cas, bound.as_deref())?;
    if bound.is_some() && sealed.is_empty() {
        eprintln!("cube-agent: template: bound to the runner's CA; its certificate may stay");
    }
    let left = seal_check(upper, &sealed).map_err(io("checking the layer"))?;
    if !left.is_empty() {
        return Err(failed(
            "seal_failed",
            format!("the layer is not clean: {}", left.join("; ")),
        ));
    }
    let rw = fs::File::open(setup::RW).map_err(io(setup::RW))?;
    if unsafe { libc::syncfs(std::os::fd::AsRawFd::as_raw_fd(&rw)) } != 0 {
        return Err(io("syncing the writable disk")(io::Error::last_os_error()));
    }
    // Times, owners and xattrs (whiteouts, opaque directories) as in upper/.
    let status = std::process::Command::new("/sbin/mkfs.erofs")
        .args(["--quiet", "-b4096", "-zlz4hc", TEMPLATE_DISK, UPPER])
        .env_clear()
        .env("PATH", "/sbin:/bin")
        .stdin(std::process::Stdio::null())
        .status()
        .map_err(io("mkfs.erofs"))?;
    if !status.success() {
        return Err(refuse(
            Code::Internal,
            "publish_failed",
            &format!("mkfs.erofs exited {status}"),
        ));
    }
    fs::OpenOptions::new()
        .write(true)
        .open(TEMPLATE_DISK)
        .and_then(|disk| disk.sync_all())
        .map_err(io(TEMPLATE_DISK))?;
    let bytes = erofs_bytes(Path::new(TEMPLATE_DISK))
        .map_err(io(TEMPLATE_DISK))?
        .ok_or_else(|| {
            refuse(
                Code::Internal,
                "publish_failed",
                "no EROFS superblock was written",
            )
        })?;
    eprintln!("cube-agent: template: {bytes} bytes on {TEMPLATE_DISK}");
    Ok(bytes)
}

/// Refuses what cannot be published: no template disk, no assembled root.
pub fn precheck() -> Result<(), Refusal> {
    let is_disk = fs::metadata(TEMPLATE_DISK).is_ok_and(|m| m.file_type().is_block_device());
    if !is_disk {
        return Err(failed(
            "no_template_disk",
            "this machine has no template disk (vdd): only a build machine publishes",
        ));
    }
    if !setup::is_mounted(setup::ROOT) {
        return Err(failed(
            "not_ready",
            "the workload root is not assembled (no machine_setup in this boot)",
        ));
    }
    if busy() {
        return Err(failed(
            "busy",
            "commands are still running; publish after they ended",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn der(n: u8) -> Vec<u8> {
        (0..200u16)
            .map(|i| (i as u8).wrapping_mul(n).wrapping_add(n))
            .collect()
    }

    fn pem(der: &[u8]) -> String {
        use base64::Engine;
        let body = base64::engine::general_purpose::STANDARD.encode(der);
        let lines: Vec<&str> = body
            .as_bytes()
            .chunks(64)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect();
        format!(
            "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
            lines.join("\n")
        )
    }

    fn write(root: &Path, rel: &str, data: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, data).unwrap();
    }

    #[test]
    fn the_runner_ca_goes_marked_or_not_and_the_rest_stays() {
        let (runner, image) = (der(3), der(5));
        let bundle = format!(
            "{}{}{BEGIN}\n{}# cube: end\n",
            pem(&image),
            pem(&runner),
            pem(&runner)
        );
        let clean = generated::without_runner_cas(bundle.as_bytes(), std::slice::from_ref(&runner));
        assert_eq!(String::from_utf8(clean).unwrap(), pem(&image));
        // Other text and CRLF certificates of the image stay byte for byte.
        let text = format!("x\r\n{}y", pem(&image).replace('\n', "\r\n"));
        assert_eq!(
            generated::without_runner_cas(text.as_bytes(), std::slice::from_ref(&runner)),
            text.as_bytes()
        );
        assert_eq!(generated::pem_certificates(bundle.as_bytes()).len(), 3);
    }

    #[test]
    fn a_whiteout_or_an_opaque_directory_hides_the_layers_below() {
        let dir = tempfile::tempdir().unwrap();
        let (top, bottom) = (dir.path().join("1"), dir.path().join("2"));
        write(&bottom, "etc/passwd", "root\n");
        write(&top, "etc/other", "x");
        let lowers = [top.clone(), bottom.clone()];
        assert_eq!(
            lower_file(&lowers, "etc/passwd").as_deref(),
            Some(&b"root\n"[..])
        );
        write(&top, "etc/passwd", "top\n");
        assert_eq!(
            lower_file(&lowers, "etc/passwd").as_deref(),
            Some(&b"top\n"[..])
        );
        assert_eq!(lower_file(&lowers, "etc/none"), None);
        fs::remove_file(top.join("etc/passwd")).unwrap();
        symlink("/elsewhere", top.join("etc/passwd")).unwrap();
        assert_eq!(
            lower_file(&lowers, "etc/passwd"),
            None,
            "a link is not a file"
        );
    }

    /// Needs root (`sudo cargo test`; CI sets CUBE_AGENT_ROOT_TESTS):
    /// whiteouts are character devices 0/0 and opaque directories carry a
    /// `trusted.` xattr.
    #[test]
    fn whiteouts_and_opaque_directories_hide_lower_files() {
        if unsafe { libc::geteuid() } != 0 {
            assert!(
                std::env::var_os("CUBE_AGENT_ROOT_TESTS").is_none(),
                "CUBE_AGENT_ROOT_TESTS is set: run this test as root"
            );
            eprintln!("skipped: needs root");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let (top, bottom) = (dir.path().join("1"), dir.path().join("2"));
        write(&bottom, "etc/passwd", "root\n");
        fs::create_dir_all(top.join("etc")).unwrap();
        let lowers = [top.clone(), bottom.clone()];
        assert!(lower_file(&lowers, "etc/passwd").is_some());
        let path =
            std::ffi::CString::new(top.join("etc/passwd").as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(
            unsafe { libc::mknod(path.as_ptr(), libc::S_IFCHR | 0o600, 0) },
            0
        );
        assert_eq!(lower_file(&lowers, "etc/passwd"), None, "whiteout");
        fs::remove_file(top.join("etc/passwd")).unwrap();
        let etc = std::ffi::CString::new(top.join("etc").as_os_str().as_encoded_bytes()).unwrap();
        let name = std::ffi::CString::new("trusted.overlay.opaque").unwrap();
        assert_eq!(
            unsafe { libc::setxattr(etc.as_ptr(), name.as_ptr(), b"y".as_ptr().cast(), 1, 0) },
            0
        );
        assert_eq!(lower_file(&lowers, "etc/passwd"), None, "opaque");
    }

    /// A build machine's upper/ as K-5d leaves it, after a setup that ran
    /// update-ca-certificates and installed an ssh server.
    fn build_machine(dir: &Path, runner: &[u8]) -> (PathBuf, PathBuf) {
        let (upper, lower) = (dir.join("upper"), dir.join("lower"));
        let image_ca = pem(&der(5));
        write(&lower, "etc/passwd", "root:x:0:0::/root:/bin/bash\n");
        write(&lower, "etc/group", "root:x:0:\nsudo:x:27:\n");
        write(
            &upper,
            "etc/passwd",
            "root:x:0:0::/root:/bin/bash\nagent:x:1000:1000:cube agent:/home/agent:/bin/bash\n",
        );
        write(
            &upper,
            "etc/group",
            "root:x:0:\nsudo:x:27:\nproject:x:1500:\nagent:x:1000:\n",
        );
        write(&upper, "etc/shadow", "agent:!:1:0:99999:7:::\n");
        // update-ca-certificates wrote the bundle again: no markers, the CA in it.
        write(
            &upper,
            "etc/ssl/certs/ca-certificates.crt",
            &format!("{image_ca}{}", pem(runner)),
        );
        write(&upper, "etc/ssl/certs/cube-runner.pem", &pem(runner));
        symlink("cube-runner.pem", upper.join("etc/ssl/certs/abcd1234.0")).unwrap();
        symlink(
            "/usr/share/ca-certificates/x.crt",
            upper.join("etc/ssl/certs/x.pem"),
        )
        .unwrap();
        write(&upper, CA_FILE, &pem(runner));
        write(
            &upper,
            "etc/gitconfig",
            &format!("[user]\n\tname = p\n{BEGIN}\n[x]\n# cube: end\n"),
        );
        write(
            &upper,
            "etc/environment",
            &format!("{BEGIN}\nSSL_CERT_FILE=/x\n# cube: end\n"),
        );
        write(&upper, "etc/hosts", "");
        write(&upper, "etc/sudoers.d/cube", "");
        write(&upper, "usr/local/bin/cube", "");
        fs::create_dir_all(upper.join("etc/cube")).unwrap();
        fs::create_dir_all(upper.join("var/lib/cube")).unwrap();
        write(&upper, "etc/ssh/ssh_host_ed25519_key", "KEY");
        write(&upper, "etc/ssh/sshd_config", "Port 22\n");
        write(&upper, "etc/machine-id", "0123456789abcdef\n");
        write(
            &upper,
            "home/agent/.cache/cube/resume.log",
            "token=cube_ph_x\n",
        );
        write(&upper, "home/agent/.bash_history", "ls\n");
        write(&upper, "workspace/app/main.rs", "fn main() {}\n");
        // A project's own copy of the bundle.
        write(
            &upper,
            "opt/app/certs.pem",
            &format!("{BEGIN}\n{}# cube: end\n", pem(runner)),
        );
        (upper, lower)
    }

    #[test]
    fn a_build_machine_s_upper_is_left_without_cube_s_things() {
        let dir = tempfile::tempdir().unwrap();
        let runner = der(3);
        let (upper, lower) = build_machine(dir.path(), &runner);
        let cas = [runner.clone()];
        assert!(
            !seal_check(&upper, &cas).unwrap().is_empty(),
            "dirty before"
        );
        let lowers = [lower];
        let machine = Machine {
            lowers: &lowers,
            cas: &cas,
            mount_points: &["usr/local/bin".into(), "usr/local/bin/cube".into()],
            home: "/home/agent",
        };
        let changed = scrub(&upper, &machine).unwrap();
        assert!(!changed.is_empty());
        assert_eq!(seal_check(&upper, &cas).unwrap(), Vec::<String>::new());
        let read = |rel: &str| fs::read_to_string(upper.join(rel)).ok();
        assert_eq!(read("etc/passwd"), None, "equal to the lower one: gone");
        assert_eq!(
            read("etc/group").as_deref(),
            Some("root:x:0:\nsudo:x:27:\nproject:x:1500:\n")
        );
        assert_eq!(read("etc/shadow").as_deref(), Some(""));
        assert_eq!(
            read("etc/ssl/certs/ca-certificates.crt"),
            Some(pem(&der(5)))
        );
        assert_eq!(
            read("etc/gitconfig").as_deref(),
            Some("[user]\n\tname = p\n")
        );
        assert_eq!(read("etc/environment").as_deref(), Some(""));
        assert_eq!(read("etc/machine-id").as_deref(), Some(""));
        assert_eq!(read("etc/ssh/sshd_config").as_deref(), Some("Port 22\n"));
        assert_eq!(
            read("workspace/app/main.rs").as_deref(),
            Some("fn main() {}\n")
        );
        assert_eq!(read("opt/app/certs.pem").as_deref(), Some(""));
        for gone in [
            "etc/ssl/certs/cube-runner.pem",
            "etc/ssl/certs/abcd1234.0",
            CA_FILE,
            "etc/hosts",
            "etc/sudoers.d/cube",
            "usr/local/bin/cube",
            "usr/local/bin",
            "etc/cube",
            "var/lib/cube",
            "etc/ssh/ssh_host_ed25519_key",
            "home/agent/.cache/cube",
            "home/agent/.bash_history",
        ] {
            assert!(
                fs::symlink_metadata(upper.join(gone)).is_err(),
                "{gone} is left"
            );
        }
        assert!(
            fs::symlink_metadata(upper.join("etc/ssl/certs/x.pem")).is_ok(),
            "the image's links stay"
        );
        assert!(
            upper.join("etc/sudoers.d").is_dir(),
            "the image's directory stays"
        );
        // Again: nothing more to do.
        assert_eq!(scrub(&upper, &machine).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn what_cannot_be_cleaned_fails_the_seal() {
        let dir = tempfile::tempdir().unwrap();
        let upper = dir.path().join("upper");
        let runner = der(3);
        let cas = [runner.clone()];
        // The CA's DER inside a binary file: nothing to cut out by lines.
        let mut binary = b"\x00\x01JKS".to_vec();
        binary.extend_from_slice(&runner);
        fs::create_dir_all(upper.join("opt")).unwrap();
        fs::write(upper.join("opt/store.bin"), &binary).unwrap();
        write(&upper, JAVA_KEYSTORE, "PKCS12");
        let machine = Machine {
            lowers: &[],
            cas: &cas,
            mount_points: &[],
            home: "/home/agent",
        };
        scrub(&upper, &machine).unwrap();
        let left = seal_check(&upper, &cas).unwrap();
        assert_eq!(left.len(), 2, "{left:?}");
        assert!(left[0].contains("/opt/store.bin") || left[1].contains("/opt/store.bin"));
        assert!(left.iter().any(|l| l.contains("Java keystore")));
        // Without a runner CA ever installed, a keystore is the project's own.
        assert_eq!(seal_check(&upper, &[]).unwrap().len(), 0);
        // A wrapped copy of the PEM (76 characters a line) is found too.
        use base64::Engine;
        let body = base64::engine::general_purpose::STANDARD.encode(&runner);
        let wrapped: Vec<String> = body
            .as_bytes()
            .chunks(76)
            .map(|c| String::from_utf8_lossy(c).into())
            .collect();
        fs::remove_file(upper.join("opt/store.bin")).unwrap();
        fs::remove_file(upper.join(JAVA_KEYSTORE)).unwrap();
        write(
            &upper,
            "opt/notes.txt",
            &format!("CA:\n{}\n", wrapped.join("\n")),
        );
        assert_eq!(seal_check(&upper, &cas).unwrap().len(), 1);
    }

    #[test]
    fn only_a_runner_that_binds_its_ca_and_only_one_ca_let_the_ca_stay() {
        let (first, second) = (der(3), der(4));
        // No binding (an earlier runner, a host runner): every CA is sealed.
        let one = std::slice::from_ref(&first);
        assert_eq!(sealed_cas(one, None).unwrap(), one);
        assert_eq!(sealed_cas(one, Some(&[])).unwrap(), one);
        // Bound to the CA this boot's setup brought, the only one it had.
        let bound = [first.clone()];
        assert!(sealed_cas(&bound, Some(&bound)).unwrap().is_empty());
        assert!(sealed_cas(&[], Some(&bound)).unwrap().is_empty());
        // The machine had another CA before (the runner's was replaced):
        // the layer may hold that one, which nothing binds.
        let refused = sealed_cas(&[first, second.clone()], Some(&[second])).unwrap_err();
        assert_eq!(refused.reason, "runner_ca_changed");
    }

    #[test]
    fn a_layer_bound_to_the_runner_s_ca_keeps_it_and_nothing_else_of_cube_s() {
        let dir = tempfile::tempdir().unwrap();
        let runner = der(3);
        let (upper, lower) = build_machine(dir.path(), &runner);
        // ca-certificates-java's hook after update-ca-certificates: the
        // runner's CA inside the keystore, and in a project's own store.
        let mut keystore = b"\xfe\xed\xfe\xed".to_vec();
        keystore.extend_from_slice(&runner);
        fs::create_dir_all(upper.join("etc/ssl/certs/java")).unwrap();
        fs::write(upper.join(JAVA_KEYSTORE), &keystore).unwrap();
        fs::write(upper.join("opt/app/store.p12"), &keystore).unwrap();
        let cas = [runner.clone()];
        let sealed = sealed_cas(&cas, Some(&cas)).unwrap();
        let lowers = [lower];
        let machine = Machine {
            lowers: &lowers,
            cas: &cas,
            mount_points: &["usr/local/bin".into(), "usr/local/bin/cube".into()],
            home: "/home/agent",
        };
        scrub(&upper, &machine).unwrap();
        assert_eq!(seal_check(&upper, &sealed).unwrap(), Vec::<String>::new());
        assert_eq!(fs::read(upper.join(JAVA_KEYSTORE)).unwrap(), keystore);
        // Unbound, the same layer fails as before: both stores hold the
        // CA, and the keystore was changed.
        assert_eq!(seal_check(&upper, &cas).unwrap().len(), 3);
        // cube's own things went as without a binding: placeholders, the
        // ssh host key, the CA files keel writes, cube's blocks.
        for gone in [
            "etc/cube",
            "home/agent/.cache/cube",
            "etc/ssh/ssh_host_ed25519_key",
            "etc/ssl/certs/cube-runner.pem",
            CA_FILE,
        ] {
            assert!(
                fs::symlink_metadata(upper.join(gone)).is_err(),
                "{gone} is left"
            );
        }
        let read = |rel: &str| fs::read_to_string(upper.join(rel)).unwrap();
        assert_eq!(read("etc/environment"), "");
        assert_eq!(read("etc/gitconfig"), "[user]\n\tname = p\n");
        // A block of cube's the scrub cannot cut out still fails the seal.
        write(
            &upper,
            "etc/profile.d/cube.sh",
            &format!("  {BEGIN}\r\nGH_TOKEN=cube_ph_github_x\n"),
        );
        let left = seal_check(&upper, &sealed).unwrap();
        assert_eq!(left.len(), 1, "{left:?}");
        assert!(left[0].contains("/etc/profile.d/cube.sh"), "{left:?}");
    }

    #[test]
    fn a_repeated_request_gets_the_same_failure() {
        let error = failed("seal_failed", "the layer is not clean: /x");
        let record = json!({
            "outcome": format!("failed: {}", error.message),
            "code": error.code,
            "reason": error.reason,
            "message": error.message,
        });
        assert_eq!(outcome(&record).unwrap_err(), error);
        assert!(outcome(&json!({"outcome": "ok", "bytes": 1})).is_ok());
    }

    #[test]
    fn needles_are_found_across_the_pieces_a_file_is_read_in() {
        let dir = tempfile::tempdir().unwrap();
        let runner = der(7);
        let needles = Needles::new(std::slice::from_ref(&runner));
        let mut data = vec![b'.'; (1 << 20) - 50];
        data.extend_from_slice(&runner);
        data.extend_from_slice(&[b'.'; 100]);
        let path = dir.path().join("f");
        fs::write(&path, &data).unwrap();
        assert!(needles.in_file(&path).unwrap());
        fs::write(&path, vec![b'.'; 3 << 20]).unwrap();
        assert!(!needles.in_file(&path).unwrap());
    }

    /// A runner CA as berth makes one (berth/src/vm/ca.rs): P-256, a CA
    /// for one level, `cube runner CA <id>`. Its DER and PEM.
    fn real_ca() -> (Vec<u8>, String) {
        use rcgen::{
            BasicConstraints, CertificateParams, DistinguishedName, DnType, IsCa, KeyPair,
            KeyUsagePurpose, PKCS_ECDSA_P256_SHA256,
        };
        let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
        let mut name = DistinguishedName::new();
        name.push(DnType::CommonName, "cube runner CA 0123456789abcdef");
        let mut params = CertificateParams::default();
        params.distinguished_name = name;
        params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        params.key_usages = vec![
            KeyUsagePurpose::KeyCertSign,
            KeyUsagePurpose::CrlSign,
            KeyUsagePurpose::DigitalSignature,
        ];
        let certificate = params.self_signed(&key).unwrap();
        (certificate.der().to_vec(), certificate.pem())
    }

    fn marker_in(data: &[u8]) -> bool {
        let mut scan = MarkerLine::default();
        scan.feed(data) || scan.end()
    }

    #[test]
    fn the_marker_counts_only_as_a_line_of_its_own() {
        let lines = [
            (format!("{BEGIN}\n"), true),
            (format!("x\n{BEGIN}\nA\n# cube: end\n"), true),
            (BEGIN.to_string(), true),
            (format!("{BEGIN}\r\n"), true),
            (format!("  \t{BEGIN} \t\r\n"), true),
            (format!("pub const BEGIN: &str = \"{BEGIN}\";\n"), false),
            (format!("const MARKER: &str = \"{BEGIN}\";"), false),
            (format!("keel writes `{BEGIN}` first\n"), false),
            (format!("#{BEGIN}\n"), false),
            (format!("{BEGIN}x\n"), false),
            (format!("{BEGIN} x\n"), false),
            (BEGIN[..BEGIN.len() - 1].to_string(), false),
            (format!("{}\n", &BEGIN[..BEGIN.len() - 1]), false),
            (String::new(), false),
        ];
        for (data, want) in &lines {
            assert_eq!(marker_in(data.as_bytes()), *want, "{data:?}");
            // Fed in two pieces, split anywhere: the same answer.
            for at in 0..=data.len() {
                let mut scan = MarkerLine::default();
                let found = scan.feed(&data.as_bytes()[..at])
                    || scan.feed(&data.as_bytes()[at..])
                    || scan.end();
                assert_eq!(found, *want, "{data:?} split at {at}");
            }
        }
    }

    #[test]
    fn a_marker_line_is_found_across_the_pieces_a_file_is_read_in() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f");
        let needles = Needles::new(&[]);
        for before in [(1 << 20) - 30, (1 << 20) - 1, 1 << 20, (1 << 20) + 5] {
            let mut data = vec![b'.'; before];
            data.push(b'\n');
            data.extend_from_slice(BEGIN.as_bytes());
            data.extend_from_slice(b"\nA\n# cube: end\n");
            fs::write(&path, &data).unwrap();
            assert!(needles.in_file(&path).unwrap(), "line at {before}");
            // The same bytes inside a longer line: no marker line.
            let at = data.iter().position(|&b| b == b'\n').unwrap();
            data[at] = b'"';
            fs::write(&path, &data).unwrap();
            assert!(
                !needles.in_file(&path).unwrap(),
                "inside a line at {before}"
            );
        }
    }

    #[test]
    fn cube_s_own_source_is_published_as_it_is() {
        // The two files that held the marker in a string literal and made
        // the seal refuse the cube project's templates (2026-10-18).
        let sources = [
            (
                "workspace/packages/keel/agent/src/generated.rs",
                include_str!("generated.rs"),
            ),
            (
                "workspace/packages/keel/agent-check/src/main.rs",
                include_str!("../../agent-check/src/main.rs"),
            ),
        ];
        let dir = tempfile::tempdir().unwrap();
        let upper = dir.path().join("upper");
        let (runner, _) = real_ca();
        let cas = [runner];
        for (rel, text) in sources {
            assert!(text.contains(BEGIN), "{rel} holds the marker's text");
            write(&upper, rel, text);
        }
        let machine = Machine {
            lowers: &[],
            cas: &cas,
            mount_points: &[],
            home: "/home/agent",
        };
        assert_eq!(scrub(&upper, &machine).unwrap(), Vec::<String>::new());
        assert_eq!(seal_check(&upper, &cas).unwrap(), Vec::<String>::new());
        for (rel, text) in sources {
            assert_eq!(fs::read_to_string(upper.join(rel)).unwrap(), text, "{rel}");
        }
    }

    #[test]
    fn a_real_runner_ca_left_in_any_form_fails_the_seal() {
        use base64::Engine;
        let dir = tempfile::tempdir().unwrap();
        let upper = dir.path().join("upper");
        let (runner, runner_pem) = real_ca();
        let cas = [runner.clone()];
        let body = base64::engine::general_purpose::STANDARD.encode(&runner);
        let wrapped: Vec<&str> = body
            .as_bytes()
            .chunks(76)
            .map(|c| std::str::from_utf8(c).unwrap())
            .collect();
        let escaped = runner_pem.replace('\n', "\\n");
        let mut binary = b"\x7fELF\x00\x01".to_vec();
        binary.extend_from_slice(&runner);
        binary.extend_from_slice(b"\x00tail");
        fs::create_dir_all(upper.join("workspace/app")).unwrap();
        fs::write(upper.join("workspace/app/ca.der"), &binary).unwrap();
        let leaks = [
            ("workspace/app/ca.b64", format!("{}\n", wrapped.join("\n"))),
            (
                "workspace/app/ca.json",
                format!("{{\"ca\":\"{escaped}\"}}\n"),
            ),
            (
                "workspace/app/ca.rs",
                format!("pub const CA: &str = \"{escaped}\";\n"),
            ),
            (
                "workspace/app/notes.md",
                format!("  {BEGIN}\nSSL_CERT_FILE=/x\n# cube: end\n"),
            ),
            (
                "workspace/app/crlf.txt",
                format!("{BEGIN}\r\nA=b\r\n# cube: end\r\n"),
            ),
        ];
        for (rel, text) in &leaks {
            write(&upper, rel, text);
        }
        // What the scrub can cut out: plain PEM lines and a block as keel
        // writes it.
        write(
            &upper,
            "workspace/app/bundle.pem",
            &format!("{}{runner_pem}", pem(&der(5))),
        );
        write(
            &upper,
            "workspace/app/env",
            &format!("A=1\n{BEGIN}\nB=2\n# cube: end\n"),
        );
        // And cube's own source beside them.
        write(
            &upper,
            "workspace/src/generated.rs",
            include_str!("generated.rs"),
        );
        let machine = Machine {
            lowers: &[],
            cas: &cas,
            mount_points: &[],
            home: "/home/agent",
        };
        scrub(&upper, &machine).unwrap();
        let mut left = seal_check(&upper, &cas).unwrap();
        left.sort();
        let mut want: Vec<String> = ["workspace/app/ca.der"]
            .into_iter()
            .chain(leaks.iter().map(|(rel, _)| *rel))
            .map(|rel| format!("/{rel} holds cube's block or a runner CA"))
            .collect();
        want.sort();
        assert_eq!(left, want);
        assert_eq!(
            fs::read_to_string(upper.join("workspace/app/bundle.pem")).unwrap(),
            pem(&der(5))
        );
        assert_eq!(
            fs::read_to_string(upper.join("workspace/app/env")).unwrap(),
            "A=1\n"
        );
    }

    #[test]
    fn links_in_upper_are_never_followed() {
        let dir = tempfile::tempdir().unwrap();
        let (upper, outside) = (dir.path().join("upper"), dir.path().join("outside"));
        write(
            &outside,
            "etc/passwd",
            "agent:x:1000:1000::/home/agent:/bin/bash\n",
        );
        write(&outside, "etc/hosts", "");
        fs::create_dir_all(&upper).unwrap();
        symlink(outside.join("etc"), upper.join("etc")).unwrap();
        let machine = Machine {
            lowers: &[],
            cas: &[],
            mount_points: &["etc/hosts".into()],
            home: "/home/agent",
        };
        scrub(&upper, &machine).unwrap();
        assert!(outside.join("etc/hosts").exists());
        assert!(
            fs::read_to_string(outside.join("etc/passwd"))
                .unwrap()
                .starts_with("agent:")
        );
    }
}
