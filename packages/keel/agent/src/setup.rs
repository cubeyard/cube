//! `machine_setup`: assembles the workload root from the runner's layer
//! list, idempotently. Disks are fixed by keel's QEMU arguments: vdb the
//! layer disk (partition N is a layer, EROFS), vdc the writable disk.
//!
//!   /run/keel/layers/N   vdbN, read-only EROFS
//!   /run/keel/rw         vdc, ext4 (formatted when blank, e2fsck -p when not):
//!                        upper/ work/ state/
//!   /run/keel/root       overlay(lowerdir = layers topmost first, upper, work)
//!                        with state/ at /var/lib/cube, its own proc, a
//!                        read-only sysfs, a /dev with only the character
//!                        devices programs expect (no disks, no cube.0), and
//!                        tmpfs /run and /tmp
//!   /run/keel/workload.mnt  the workload's mount namespace (pivot_root into
//!                        the root), which commands enter
//!   /run/keel/setup.json the layers this boot assembled
//!   /etc/cube, /etc/hosts, ... cube's generated files (generated.rs)
//!
//! The layers cannot change under a running workload: another list is
//! FAILED_PRECONDITION/layers_changed (the runner boots the machine cold).
//! The list is kept in /run, so an agent that starts again still refuses it.
use std::{
    collections::BTreeMap,
    ffi::CString,
    fs,
    io::{self, BufRead, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

use cube_runner_protocol::{
    proto::{self, Code},
    refuse,
};
use serde_json::{Value, json};

use crate::journal::{Account, Launch};

pub const RUN: &str = "/run/keel";
pub const ROOT: &str = "/run/keel/root";
pub const RW: &str = "/run/keel/rw";
pub const STATE: &str = "/run/keel/rw/state";
pub const NAMESPACE: &str = "/run/keel/workload.mnt";
const SETUP: &str = "/run/keel/setup.json";
const LAYER_DISK: &str = "/dev/vdb";
const RW_DISK: &str = "/dev/vdc";
const MAX_LAYERS: u32 = 128;
const DOCUMENTS: [&str; 4] = ["hostname", "env", "hooks/pre-setup", "hooks/pre-resume"];
/// What `ready` needs in the workload root (runner.proto, `GuestInfo.ready`).
const COMMANDS: [&str; 6] = ["bash", "sudo", "flock", "git", "gh", "curl"];
pub const CA_BUNDLES: [&str; 3] = [
    "etc/ssl/certs/ca-certificates.crt",
    "etc/pki/tls/certs/ca-bundle.crt",
    "etc/ssl/cert.pem",
];
const AGENT: &str = "agent";

pub type Refusal = proto::Error;

fn invalid(reason: &str, message: impl AsRef<str>) -> Refusal {
    refuse(Code::InvalidArgument, reason, message.as_ref())
}
fn internal(reason: &str, message: impl AsRef<str>) -> Refusal {
    refuse(Code::Internal, reason, message.as_ref())
}

/// What a setup gave: how commands run, and what the root lacks for `ready`.
pub struct Applied {
    pub launch: Launch,
    pub missing: Vec<String>,
    pub formatted: bool,
}

/// The layer list as compared between setups.
pub fn layer_key(layers: &[proto::Layer]) -> Result<Vec<Value>, Refusal> {
    if layers.is_empty() {
        return Err(invalid("no_layers", "a machine needs at least one layer"));
    }
    let mut seen = std::collections::HashSet::new();
    layers
        .iter()
        .map(|layer| {
            if layer.partition < 1 || layer.partition > MAX_LAYERS || !seen.insert(layer.partition)
            {
                return Err(invalid(
                    "bad_partition",
                    format!(
                        "layer partition {} is not 1-{MAX_LAYERS} or repeats",
                        layer.partition
                    ),
                ));
            }
            let source = match &layer.source {
                Some(proto::layer::Source::DiffId(id)) => json!({"diffId": id}),
                Some(proto::layer::Source::TemplateId(id)) => json!({"templateId": id}),
                None => Value::Null,
            };
            Ok(json!({"partition": layer.partition, "source": source}))
        })
        .collect()
}

fn env_lines(text: &str, what: &str) -> Result<Vec<(String, String)>, Refusal> {
    text.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| {
            let (name, value) = line
                .split_once('=')
                .ok_or_else(|| invalid("bad_env", format!("{what}: not NAME=value")))?;
            let valid = !name.is_empty()
                && name.bytes().enumerate().all(|(i, b)| {
                    b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit())
                })
                && !value.contains('\0');
            if !valid {
                return Err(invalid(
                    "bad_env",
                    format!("{what}: invalid line for {name}"),
                ));
            }
            Ok((name.to_string(), value.to_string()))
        })
        .collect()
}

/// A command's environment: a clean one for the agent account, then the
/// image's `Env`, then the account's own variables, then cube's on top:
/// keel's fixed lines (`cube`, the CA variables, ...) and the `env`
/// document (the placeholders).
pub fn environment(
    image_env: &[String],
    cube: &[(String, String)],
    document: Option<&[u8]>,
    home: &str,
) -> Result<BTreeMap<String, String>, Refusal> {
    let mut env: BTreeMap<String, String> = [("PATH", crate::STANDARD_PATH), ("LANG", "C.UTF-8")]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    env.extend(env_lines(&image_env.join("\n"), "image Env")?);
    for (name, value) in [
        ("HOME", home),
        ("USER", AGENT),
        ("LOGNAME", AGENT),
        ("SHELL", "/bin/bash"),
        ("TERM", "dumb"),
        ("GIT_TERMINAL_PROMPT", "0"),
    ] {
        env.insert(name.into(), value.into());
    }
    env.extend(cube.iter().cloned());
    if let Some(document) = document {
        let text =
            std::str::from_utf8(document).map_err(|_| invalid("bad_env", "env: not UTF-8"))?;
        env.extend(env_lines(text, "env")?);
    }
    Ok(env)
}

pub fn check_documents(documents: &BTreeMap<String, Vec<u8>>) -> Result<Option<String>, Refusal> {
    if let Some(unknown) = documents
        .keys()
        .find(|name| !DOCUMENTS.contains(&name.as_str()))
    {
        return Err(invalid(
            "unknown_document",
            format!("unknown boot document {unknown}"),
        ));
    }
    let Some(hostname) = documents.get("hostname") else {
        return Ok(None);
    };
    let name = std::str::from_utf8(hostname)
        .unwrap_or("")
        .trim_end_matches('\n');
    if name.is_empty()
        || name.len() > 64
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
    {
        return Err(invalid(
            "bad_hostname",
            "hostname is one line of letters, digits, '-' and '.'",
        ));
    }
    Ok(Some(name.into()))
}

/// The `agent` account in the workload's /etc files (uid 1000 unless the
/// image uses it), added in `upper/` when the image has none.
pub fn ensure_account(root: &Path) -> io::Result<Account> {
    let passwd = fs::read_to_string(root.join("etc/passwd")).unwrap_or_default();
    let group = fs::read_to_string(root.join("etc/group")).unwrap_or_default();
    let field = |line: &str, index: usize| line.split(':').nth(index).map(str::to_string);
    let ids = |text: &str, index: usize| -> Vec<u32> {
        text.lines()
            .filter_map(|l| field(l, index)?.parse().ok())
            .collect()
    };
    let (uid, gid, home) = match passwd.lines().find(|line| line.starts_with("agent:")) {
        Some(line) => (
            field(line, 2).and_then(|v| v.parse().ok()).unwrap_or(1000),
            field(line, 3).and_then(|v| v.parse().ok()).unwrap_or(1000),
            field(line, 5).unwrap_or_else(|| "/home/agent".into()),
        ),
        None => {
            let used_uids = ids(&passwd, 2);
            let gid = match group.lines().find(|line| line.starts_with("agent:")) {
                Some(line) => field(line, 2).and_then(|v| v.parse().ok()).unwrap_or(1000),
                None => {
                    let used = ids(&group, 2);
                    let gid = (1000..).find(|id| !used.contains(id)).unwrap();
                    append(&root.join("etc/group"), &format!("agent:x:{gid}:"))?;
                    if root.join("etc/gshadow").exists() {
                        append(&root.join("etc/gshadow"), "agent:!::")?;
                    }
                    gid
                }
            };
            let uid = if used_uids.contains(&1000) {
                (1000..).find(|id| !used_uids.contains(id)).unwrap()
            } else {
                1000
            };
            append(
                &root.join("etc/passwd"),
                &format!("agent:x:{uid}:{gid}:cube agent:/home/agent:/bin/bash"),
            )?;
            if root.join("etc/shadow").exists() {
                append(&root.join("etc/shadow"), "agent:!:1:0:99999:7:::")?;
            }
            (uid, gid, "/home/agent".into())
        }
    };
    let group = fs::read_to_string(root.join("etc/group")).unwrap_or_default();
    let mut groups = vec![gid];
    for line in group.lines() {
        let members = field(line, 3).unwrap_or_default();
        if members.split(',').any(|m| m == AGENT)
            && let Some(id) = field(line, 2).and_then(|v| v.parse().ok())
            && !groups.contains(&id)
        {
            groups.push(id);
        }
    }
    for (dir, mode) in [
        (home.trim_start_matches('/').to_string(), 0o755),
        ("workspace".to_string(), 0o755),
    ] {
        let path = root.join(dir);
        if !path.exists() {
            fs::create_dir_all(&path)?;
            fs::set_permissions(&path, fs::Permissions::from_mode(mode))?;
        }
        std::os::unix::fs::lchown(&path, Some(uid), Some(gid))?;
    }
    Ok(Account {
        uid,
        gid,
        groups,
        home,
    })
}

/// Appends a line, keeping the file's owner and mode (a shadow file's group).
fn append(path: &Path, line: &str) -> io::Result<()> {
    let existing = fs::read(path).unwrap_or_default();
    let mut file = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o644)
        .open(path)?;
    if !existing.is_empty() && !existing.ends_with(b"\n") {
        file.write_all(b"\n")?;
    }
    file.write_all(format!("{line}\n").as_bytes())
}

/// What the workload root lacks for `ready`.
pub fn missing_tools(root: &Path) -> Vec<String> {
    let Ok(dir) = fs::File::open(root) else {
        return vec!["the workload root".into()];
    };
    let mut missing: Vec<String> = COMMANDS
        .iter()
        .filter(|c| !crate::paths::has_command(&dir, c))
        .map(|c| c.to_string())
        .collect();
    if !CA_BUNDLES
        .iter()
        .any(|path| crate::paths::has_file(&dir, path))
    {
        missing.push("a CA bundle".into());
    }
    missing
}

// ---------------------------------------------------------------- mounts

fn c(path: &str) -> CString {
    CString::new(path).unwrap()
}

pub(crate) fn mount(
    source: &str,
    target: &str,
    kind: Option<&str>,
    flags: libc::c_ulong,
    data: Option<&str>,
) -> io::Result<()> {
    let (source, target) = (c(source), c(target));
    let kind = kind.map(c);
    let data = data.map(c);
    let rc = unsafe {
        libc::mount(
            source.as_ptr(),
            target.as_ptr(),
            kind.as_ref().map_or(std::ptr::null(), |k| k.as_ptr()),
            flags,
            data.as_ref()
                .map_or(std::ptr::null(), |d| d.as_ptr().cast()),
        )
    };
    if rc != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Whether `path` is a mount point (from this process's mountinfo).
pub fn is_mounted(path: &str) -> bool {
    fs::read_to_string("/proc/self/mountinfo")
        .map(|info| {
            info.lines()
                .any(|line| line.split(' ').nth(4) == Some(path))
        })
        .unwrap_or(false)
}

fn mkdirs(path: &str, mode: u32) -> io::Result<()> {
    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(mode))
}

/// 0: ext4, 1: blank (the first 64 KiB are zero), -1: something else.
fn rw_disk_kind() -> io::Result<i32> {
    use std::os::unix::fs::FileExt;
    let file = fs::File::open(RW_DISK)?;
    let mut head = vec![0u8; 65536];
    file.read_exact_at(&mut head, 0)?;
    if head[1080] == 0x53 && head[1081] == 0xef {
        return Ok(0);
    }
    Ok(if head.iter().all(|&b| b == 0) { 1 } else { -1 })
}

fn run_base(argv: &[&str]) -> io::Result<i32> {
    let status = Command::new(argv[0])
        .args(&argv[1..])
        .env_clear()
        .env("PATH", "/sbin:/bin")
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()?;
    Ok(status.code().unwrap_or(128))
}

fn ok(what: &str, result: io::Result<()>) -> Result<(), Refusal> {
    result.map_err(|error| internal("mount_failed", format!("{what}: {error}")))
}

/// The workload's /dev: the character devices programs expect, its own
/// devpts and shm. No disks and no virtio ports.
fn workload_dev(dev: &str) -> Result<(), Refusal> {
    ok(
        dev,
        mount(
            "tmpfs",
            dev,
            Some("tmpfs"),
            libc::MS_NOSUID | libc::MS_NOEXEC,
            Some("mode=0755"),
        ),
    )?;
    for (name, major, minor) in [
        ("null", 1, 3),
        ("zero", 1, 5),
        ("full", 1, 7),
        ("random", 1, 8),
        ("urandom", 1, 9),
        ("tty", 5, 0),
    ] {
        let path = c(&format!("{dev}/{name}"));
        if unsafe {
            libc::mknod(
                path.as_ptr(),
                libc::S_IFCHR | 0o666,
                libc::makedev(major, minor),
            )
        } != 0
        {
            return Err(internal(
                "mount_failed",
                format!("mknod {name}: {}", io::Error::last_os_error()),
            ));
        }
        unsafe { libc::chmod(path.as_ptr(), 0o666) };
    }
    for (target, link) in [
        ("pts/ptmx", "ptmx"),
        ("/proc/self/fd", "fd"),
        ("/proc/self/fd/0", "stdin"),
        ("/proc/self/fd/1", "stdout"),
        ("/proc/self/fd/2", "stderr"),
    ] {
        ok(
            link,
            std::os::unix::fs::symlink(target, format!("{dev}/{link}")),
        )?;
    }
    for (name, kind, flags, data) in [
        (
            "pts",
            "devpts",
            libc::MS_NOSUID | libc::MS_NOEXEC,
            "newinstance,ptmxmode=0666,mode=0620,gid=5",
        ),
        (
            "shm",
            "tmpfs",
            libc::MS_NOSUID | libc::MS_NODEV,
            "mode=1777",
        ),
    ] {
        let target = format!("{dev}/{name}");
        ok(&target, mkdirs(&target, 0o755))?;
        ok(&target, mount(kind, &target, Some(kind), flags, Some(data)))?;
    }
    Ok(())
}

/// Mounts the layers, the writable disk and the overlay with its inner
/// mounts; what is mounted already is kept. Returns whether vdc was formatted.
fn assemble(layers: &[proto::Layer]) -> Result<bool, Refusal> {
    let mut lower = vec![];
    for layer in layers {
        let (device, target) = (
            format!("{LAYER_DISK}{}", layer.partition),
            format!("{RUN}/layers/{}", layer.partition),
        );
        ok(&target, mkdirs(&target, 0o755))?;
        if !is_mounted(&target) {
            ok(
                &device,
                mount(
                    &device,
                    &target,
                    Some("erofs"),
                    libc::MS_RDONLY | libc::MS_NODEV | libc::MS_NOSUID,
                    None,
                ),
            )?;
        }
        lower.push(target);
    }
    let mut formatted = false;
    if !is_mounted(RW) {
        match rw_disk_kind().map_err(|error| internal("rw_disk", format!("{RW_DISK}: {error}")))? {
            1 => {
                let rc = run_base(&[
                    "/sbin/mke2fs",
                    "-q",
                    "-t",
                    "ext4",
                    "-L",
                    "cube-rw",
                    "-E",
                    "lazy_itable_init=1",
                    RW_DISK,
                ])
                .map_err(|error| internal("rw_disk", format!("mke2fs: {error}")))?;
                if rc != 0 {
                    return Err(internal("rw_disk", format!("mke2fs exited {rc}")));
                }
                formatted = true;
            }
            0 => {
                // -p repairs what is safe; 1 means it fixed something.
                let rc = run_base(&["/sbin/e2fsck", "-p", RW_DISK])
                    .map_err(|error| internal("rw_disk", format!("e2fsck: {error}")))?;
                if rc != 0 && rc != 1 {
                    return Err(internal("rw_disk", format!("e2fsck exited {rc}")));
                }
            }
            _ => {
                return Err(internal(
                    "rw_disk_foreign",
                    format!("{RW_DISK} is neither ext4 nor blank; not formatting it"),
                ));
            }
        }
        ok(RW, mkdirs(RW, 0o755))?;
        ok(
            RW,
            mount(
                RW_DISK,
                RW,
                Some("ext4"),
                libc::MS_NODEV | libc::MS_NOSUID,
                None,
            ),
        )?;
    }
    for (dir, mode) in [("upper", 0o755), ("work", 0o755), ("state", 0o700)] {
        ok(dir, mkdirs(&format!("{RW}/{dir}"), mode))?;
    }
    if !is_mounted(ROOT) {
        ok(ROOT, mkdirs(ROOT, 0o755))?;
        let options = format!(
            "lowerdir={},upperdir={RW}/upper,workdir={RW}/work",
            lower.join(":")
        );
        ok(
            "overlay",
            mount("overlay", ROOT, Some("overlay"), 0, Some(&options)),
        )?;
        let secure = libc::MS_NOSUID | libc::MS_NODEV | libc::MS_NOEXEC;
        for (source, target, kind, flags, data) in [
            (STATE, "var/lib/cube", None, libc::MS_BIND, None),
            ("proc", "proc", Some("proc"), secure, None),
            (
                "sysfs",
                "sys",
                Some("sysfs"),
                secure | libc::MS_RDONLY,
                None,
            ),
            (
                "tmpfs",
                "run",
                Some("tmpfs"),
                libc::MS_NOSUID | libc::MS_NODEV,
                Some("mode=0755"),
            ),
            (
                "tmpfs",
                "tmp",
                Some("tmpfs"),
                libc::MS_NOSUID | libc::MS_NODEV,
                Some("mode=1777"),
            ),
        ] {
            let target = format!("{ROOT}/{target}");
            ok(&target, fs::create_dir_all(&target))?;
            ok(&target, mount(source, &target, kind, flags, data))?;
        }
        let dev = format!("{ROOT}/dev");
        ok(&dev, fs::create_dir_all(&dev))?;
        workload_dev(&dev)?;
        if let Err(error) = bind_cli(Path::new(ROOT)) {
            eprintln!("cube-agent: no cube command in the workload: {error}");
        }
        crate::generated::bind_all(Path::new(ROOT))?;
    }
    Ok(formatted)
}

/// Where the workload finds the `cube` command.
pub const CLI: &str = "usr/local/bin/cube";

/// The agent's own binary, read-only, as `/usr/local/bin/cube` in the
/// workload root. The path is resolved inside the root and opened with no
/// link on the way, so an image's link never puts the mount elsewhere; an
/// empty file is made in `upper/` as the mount point (template publishing
/// leaves it out, K-5e).
pub fn bind_cli(root: &Path) -> io::Result<()> {
    use crate::paths::{open_resolved, resolve_in_root};
    let root_dir = fs::File::open(root)?;
    let components = resolve_in_root(&root_dir, CLI)?;
    for depth in 1..components.len() {
        match open_resolved(
            &root_dir,
            &components[..depth],
            libc::O_PATH | libc::O_DIRECTORY,
            0,
        ) {
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let parent = open_resolved(
                    &root_dir,
                    &components[..depth - 1],
                    libc::O_PATH | libc::O_DIRECTORY,
                    0,
                )?;
                let name = c(&components[depth - 1]);
                if unsafe {
                    libc::mkdirat(
                        std::os::fd::AsRawFd::as_raw_fd(&parent),
                        name.as_ptr(),
                        0o755,
                    )
                } != 0
                {
                    return Err(io::Error::last_os_error());
                }
            }
            Err(error) => return Err(error),
        }
    }
    let target = open_resolved(
        &root_dir,
        &components,
        libc::O_WRONLY | libc::O_CREAT,
        0o755,
    )?;
    let at = format!("/proc/self/fd/{}", std::os::fd::AsRawFd::as_raw_fd(&target));
    let exe = std::env::current_exe()?;
    mount(&exe.to_string_lossy(), &at, None, libc::MS_BIND, None)?;
    mount(
        "none",
        &root.join(components.join("/")).to_string_lossy(),
        None,
        libc::MS_REMOUNT | libc::MS_BIND | libc::MS_RDONLY | libc::MS_NODEV | libc::MS_NOSUID,
        None,
    )
}

/// The workload's mount namespace: `cube-agent hold-ns` pivots into the
/// root in a namespace of its own; its namespace file is bind-mounted at
/// NAMESPACE, so it outlives that process and this agent.
fn namespace() -> Result<(), Refusal> {
    if is_mounted(NAMESPACE) {
        return Ok(());
    }
    let fail = |error: io::Error| internal("namespace", format!("the workload namespace: {error}"));
    let exe = std::env::current_exe().map_err(fail)?;
    let mut child = Command::new(exe)
        .args(["hold-ns", ROOT])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(fail)?;
    let mut line = String::new();
    io::BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut line)
        .map_err(fail)?;
    let result = if line.trim() == "ok" {
        fs::File::create(NAMESPACE)
            .and_then(|_| {
                mount(
                    &format!("/proc/{}/ns/mnt", child.id()),
                    NAMESPACE,
                    None,
                    libc::MS_BIND,
                    None,
                )
            })
            .map_err(fail)
    } else {
        Err(internal("namespace", "the namespace holder failed"))
    };
    drop(child.stdin.take());
    let _ = child.wait();
    result
}

/// `cube-agent hold-ns ROOT`: a new mount namespace whose root is ROOT; says
/// "ok" and waits until its stdin closes.
pub fn hold_namespace(root: &str) -> i32 {
    let root = c(root);
    let dot = c(".");
    unsafe {
        if libc::unshare(libc::CLONE_NEWNS) != 0
            || libc::mount(
                std::ptr::null(),
                c("/").as_ptr(),
                std::ptr::null(),
                libc::MS_REC | libc::MS_PRIVATE,
                std::ptr::null(),
            ) != 0
            || libc::chdir(root.as_ptr()) != 0
            || libc::syscall(libc::SYS_pivot_root, dot.as_ptr(), dot.as_ptr()) != 0
            || libc::umount2(dot.as_ptr(), libc::MNT_DETACH) != 0
            || libc::chdir(c("/").as_ptr()) != 0
        {
            eprintln!("cube-agent hold-ns: {}", io::Error::last_os_error());
            return 1;
        }
    }
    println!("ok");
    let _ = io::stdout().flush();
    let _ = io::copy(&mut io::stdin(), &mut io::sink());
    0
}

/// Applies a `MachineSetup`. Idempotent: what is in place stays; another
/// layer list under an assembled root is refused.
pub fn apply(setup: &proto::MachineSetup) -> Result<Applied, Refusal> {
    let hostname = check_documents(&setup.documents)?;
    if setup.entropy.len() < 32 {
        return Err(invalid(
            "entropy",
            "a setup brings at least 32 bytes of entropy",
        ));
    }
    let key = layer_key(&setup.layers)?;
    let ca = crate::generated::check_ca(&setup.ca_pem)?;
    let env_document = setup.documents.get("env").map(Vec::as_slice);
    // Validate the environment before anything is mounted.
    environment(
        setup.image.as_ref().map_or(&[][..], |i| &i.env),
        &[],
        env_document,
        "/home/agent",
    )?;
    crate::generated::protect_links();
    // Mixed into the pool without crediting it: a restored machine must not
    // repeat another's random numbers.
    fs::OpenOptions::new()
        .write(true)
        .open("/dev/urandom")
        .and_then(|mut random| random.write_all(&setup.entropy))
        .map_err(|error| internal("entropy", error.to_string()))?;

    let formatted = if is_mounted(ROOT) {
        let assembled: Option<Value> = fs::read(SETUP)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok());
        if assembled.as_ref().and_then(|a| a.get("layers")) != Some(&Value::Array(key.clone())) {
            return Err(refuse(
                Code::FailedPrecondition,
                "layers_changed",
                "the layers cannot change under a running workload; boot the machine cold",
            ));
        }
        false
    } else {
        let formatted = assemble(&setup.layers)?;
        crate::files::write_atomic(
            Path::new(SETUP),
            json!({"layers": key}).to_string().as_bytes(),
            0o600,
        )
        .map_err(|error| internal("setup", error.to_string()))?;
        formatted
    };
    namespace()?;
    if let Some(name) = &hostname
        && unsafe { libc::sethostname(name.as_ptr().cast(), name.len()) } != 0
    {
        return Err(internal("hostname", io::Error::last_os_error().to_string()));
    }
    let account = ensure_account(Path::new(ROOT))
        .map_err(|error| internal("account", format!("the agent account: {error}")))?;
    let bundle = crate::generated::bundle(Path::new(ROOT));
    let mut cube = crate::generated::cube_lines(bundle.as_deref());
    if let Some(document) = env_document {
        // Validated above.
        cube.extend(env_lines(&String::from_utf8_lossy(document), "env")?);
    }
    let env = environment(
        setup.image.as_ref().map_or(&[][..], |i| &i.env),
        &cube,
        None,
        &account.home,
    )?;
    let hostname = match hostname {
        Some(name) => name,
        None => fs::read_to_string("/proc/sys/kernel/hostname")
            .map(|name| name.trim().to_string())
            .unwrap_or_else(|_| "localhost".into()),
    };
    crate::generated::write_all(
        Path::new(ROOT),
        &crate::generated::Files {
            hostname: &hostname,
            env: &cube,
            hooks: [
                (
                    "pre-setup",
                    setup.documents.get("hooks/pre-setup").map(Vec::as_slice),
                ),
                (
                    "pre-resume",
                    setup.documents.get("hooks/pre-resume").map(Vec::as_slice),
                ),
            ],
            ca: ca.as_deref(),
        },
    )?;
    Ok(Applied {
        launch: Launch {
            workspace: PathBuf::from("/workspace"),
            namespace: Some(PathBuf::from(NAMESPACE)),
            account: Some(account),
            env,
        },
        missing: missing_tools(Path::new(ROOT)),
        formatted,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn documents_and_layers_are_checked() {
        let mut documents = BTreeMap::new();
        documents.insert("hostname".to_string(), b"cube-0123\n".to_vec());
        documents.insert("env".to_string(), b"GH_TOKEN=cube_ph_github_x\n".to_vec());
        assert_eq!(
            check_documents(&documents).unwrap().as_deref(),
            Some("cube-0123")
        );
        documents.insert("seed".to_string(), vec![]);
        assert_eq!(
            check_documents(&documents).unwrap_err().reason,
            "unknown_document"
        );
        documents.remove("seed");
        documents.insert("hostname".to_string(), b"a b".to_vec());
        assert_eq!(
            check_documents(&documents).unwrap_err().reason,
            "bad_hostname"
        );

        let layer = |partition, id: &str| proto::Layer {
            partition,
            source: Some(proto::layer::Source::DiffId(id.into())),
        };
        assert_eq!(layer_key(&[]).unwrap_err().reason, "no_layers");
        assert_eq!(
            layer_key(&[layer(1, "a"), layer(1, "b")])
                .unwrap_err()
                .reason,
            "bad_partition"
        );
        assert_eq!(
            layer_key(&[layer(129, "a")]).unwrap_err().reason,
            "bad_partition"
        );
        assert_ne!(
            layer_key(&[layer(1, "a"), layer(2, "b")]).unwrap(),
            layer_key(&[layer(2, "b"), layer(1, "a")]).unwrap(),
            "order is part of the list"
        );
    }

    #[test]
    fn the_environment_layers_cube_over_the_image() {
        let env = environment(
            &[
                "PATH=/opt/node/bin:/usr/bin".into(),
                "HOME=/root".into(),
                "NODE_VERSION=24".into(),
            ],
            &crate::generated::cube_lines(Some("/etc/ssl/certs/ca-certificates.crt")),
            Some(b"GH_TOKEN=cube_ph_github_x\n# comment\nCUBE_SECRET_A=cube_ph_a\n"),
            "/home/agent",
        )
        .unwrap();
        assert_eq!(
            env["PATH"], "/opt/node/bin:/usr/bin",
            "the image's PATH replaces the default"
        );
        assert_eq!(
            env["HOME"], "/home/agent",
            "the account's own variables win over the image"
        );
        assert_eq!(env["NODE_VERSION"], "24");
        assert_eq!(env["GH_TOKEN"], "cube_ph_github_x");
        assert_eq!(env["CUBE_SECRET_A"], "cube_ph_a");
        assert_eq!(env["GIT_TERMINAL_PROMPT"], "0");
        assert_eq!(env["GH_PROMPT_DISABLED"], "1");
        assert_eq!(
            env["SSL_CERT_FILE"], "/etc/ssl/certs/ca-certificates.crt",
            "keel's own lines"
        );
        assert_eq!(
            environment(&[], &[], Some(b"1BAD=x"), "/h")
                .unwrap_err()
                .reason,
            "bad_env"
        );
        assert_eq!(
            environment(&["NOEQUALS".into()], &[], None, "/h")
                .unwrap_err()
                .reason,
            "bad_env"
        );
    }

    #[test]
    fn the_account_is_added_once_and_avoids_a_taken_uid() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("etc")).unwrap();
        fs::write(
            root.join("etc/passwd"),
            "root:x:0:0:root:/root:/bin/bash\nnode:x:1000:1000::/home/node:/bin/bash",
        )
        .unwrap();
        fs::write(
            root.join("etc/group"),
            "root:x:0:\nnode:x:1000:\nsudo:x:27:agent\n",
        )
        .unwrap();
        fs::write(root.join("etc/shadow"), "root:*:1::::::\n").unwrap();
        let me = unsafe { (libc::getuid(), libc::getgid()) };
        let account = match ensure_account(root) {
            Ok(account) => account,
            // Not root: lchown to uid 1001 is refused; the files are still written.
            Err(error) if me.0 != 0 && error.kind() == io::ErrorKind::PermissionDenied => {
                let passwd = fs::read_to_string(root.join("etc/passwd")).unwrap();
                assert!(passwd.ends_with("node:x:1000:1000::/home/node:/bin/bash\nagent:x:1001:1001:cube agent:/home/agent:/bin/bash\n"), "{passwd}");
                return;
            }
            Err(error) => panic!("{error}"),
        };
        assert_eq!((account.uid, account.gid), (1001, 1001));
        assert_eq!(account.groups, vec![1001, 27]);
        let again = ensure_account(root).unwrap();
        assert_eq!(again, account);
        let passwd = fs::read_to_string(root.join("etc/passwd")).unwrap();
        assert_eq!(
            passwd
                .lines()
                .filter(|line| line.starts_with("agent:"))
                .count(),
            1,
            "{passwd}"
        );
        assert!(
            fs::read_to_string(root.join("etc/shadow"))
                .unwrap()
                .contains("agent:!:")
        );
    }

    #[test]
    fn readiness_names_what_the_root_lacks() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("usr/bin")).unwrap();
        for tool in ["bash", "flock"] {
            fs::write(root.join("usr/bin").join(tool), "").unwrap();
            fs::set_permissions(
                root.join("usr/bin").join(tool),
                fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        assert_eq!(
            missing_tools(root),
            ["sudo", "git", "gh", "curl", "a CA bundle"]
        );
    }
}
