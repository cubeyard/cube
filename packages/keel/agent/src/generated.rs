//! What keel writes into the workload root for cube on `machine_setup`,
//! besides the agent account: what today's seed writes through cloud-init.
//!
//!   /etc/cube            state/etc-cube, bind-mounted read-only: `env`
//!                        (cube's lines for every command), `hooks/pre-setup`
//!                        and `hooks/pre-resume` (the boot documents), `ca.pem`
//!                        (the runner's CA)
//!   /etc/hosts, /etc/hostname, /etc/resolv.conf, /etc/sudoers.d/cube
//!                        state/generated/*, each bind-mounted over its path
//!   the image's CA bundle, /etc/gitconfig, /etc/environment
//!                        a block between cube's marker lines, replaced on
//!                        every setup; the image's own lines stay
//!   /usr/local/share/ca-certificates/cube-runner.crt
//!                        the runner's CA, so update-ca-certificates keeps it
//!                        in the bundle it writes again
//!
//! The binds are made once per boot, before the workload's mount namespace
//! (a later mount would not reach it); the files behind them are written in
//! place on every setup, so the bound inode stays. Paths in the root are
//! resolved inside it and opened with every link refused. What lands in the
//! overlay (the blocks, the certificate file, empty mount points) is cube's,
//! and template publishing leaves it out (template.rs): the mount points
//! this agent made are listed in `state/mount-points`, and every CA a setup
//! brought is kept in `state/runner-cas.pem`.
use std::{
    fs,
    io::{self, Read, Write},
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::fs::{OpenOptionsExt, PermissionsExt},
    },
    path::Path,
};

use cube_runner_protocol::{proto::Code, refuse};

use crate::{
    fileops::write_atomic_at,
    paths::{open_resolved, resolve_in_root},
    setup::{CA_BUNDLES, Refusal, STATE},
};

/// Bound at /etc/cube.
const ETC_CUBE: &str = "etc-cube";
/// The files bound over a path each.
const GENERATED: &str = "generated";
/// state/generated/NAME → the root's path, its mode.
const BOUND: [(&str, &str, u32); 4] = [
    ("hosts", "etc/hosts", 0o644),
    ("hostname", "etc/hostname", 0o644),
    ("resolv.conf", "etc/resolv.conf", 0o644),
    ("sudoers", "etc/sudoers.d/cube", 0o440),
];
/// The runner's address on the machine's private link: DNS (B-4).
pub const RUNNER_IP: &str = "192.168.127.1";
pub const BEGIN: &str = "# cube: begin (keel writes this block on every machine_setup)";
const END: &str = "# cube: end";
/// What update-ca-certificates adds to the bundle it writes.
pub const CA_FILE: &str = "usr/local/share/ca-certificates/cube-runner.crt";
/// The mount points this agent made in the root, one path a line.
pub const MOUNT_POINTS: &str = "mount-points";
/// Every CA a setup brought to this machine (PEM), for template publishing.
pub const RUNNER_CAS: &str = "runner-cas.pem";
/// The largest file cube rewrites to put a block in; a larger one is refused.
const MAX_FILE_BYTES: u64 = 16 << 20;
const MAX_CA_BYTES: usize = 64 * 1024;
/// The variables tools with their own CA list read, kept through sudo.
const CA_VARIABLES: [&str; 4] = [
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    "SSL_CERT_FILE",
    "CURL_CA_BUNDLE",
];
const GITCONFIG: &str = "[credential \"https://github.com\"]\n\thelper =\n\thelper = \"!f() { test \\\"$1\\\" = get || exit 0; echo username=x-access-token; echo \\\"password=$GH_TOKEN\\\"; }; f\"\n[init]\n\tdefaultBranch = main\n";

fn internal(what: &str, error: impl std::fmt::Display) -> Refusal {
    refuse(
        Code::Internal,
        "generated_files",
        &format!("{what}: {error}"),
    )
}

/// The runner's CA as given: one or more PEM certificates, or nothing.
pub fn check_ca(pem: &str) -> Result<Option<String>, Refusal> {
    let bad = |why: &str| refuse(Code::InvalidArgument, "bad_ca", &format!("ca_pem: {why}"));
    if pem.trim().is_empty() {
        return Ok(None);
    }
    if pem.len() > MAX_CA_BYTES {
        return Err(bad("larger than 64 KiB"));
    }
    let (mut inside, mut certificates, mut text) = (false, 0, String::new());
    for line in pem.lines().map(str::trim).filter(|line| !line.is_empty()) {
        match line {
            "-----BEGIN CERTIFICATE-----" if !inside => inside = true,
            "-----END CERTIFICATE-----" if inside => {
                inside = false;
                certificates += 1;
            }
            _ if inside
                && line
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"+/=".contains(&b)) => {}
            _ => return Err(bad("not PEM certificates")),
        }
        text.push_str(line);
        text.push('\n');
    }
    if inside || certificates == 0 {
        return Err(bad("not PEM certificates"));
    }
    Ok(Some(text))
}

/// The image's CA bundle (the first of the known paths it has), as the
/// workload sees it.
pub fn bundle(root: &Path) -> Option<String> {
    let dir = fs::File::open(root).ok()?;
    CA_BUNDLES
        .iter()
        .find(|path| crate::paths::has_file(&dir, path))
        .map(|path| format!("/{path}"))
}

/// cube's fixed lines for every command (the env document goes on top).
pub fn cube_lines(bundle: Option<&str>) -> Vec<(String, String)> {
    let mut lines: Vec<(String, String)> = bundle
        .map(|bundle| {
            CA_VARIABLES
                .iter()
                .map(|name| (name.to_string(), bundle.to_string()))
                .collect()
        })
        .unwrap_or_default();
    for (name, value) in [
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GH_PROMPT_DISABLED", "1"),
        ("GH_NO_UPDATE_NOTIFIER", "1"),
    ] {
        lines.push((name.into(), value.into()));
    }
    lines
}

/// `text` without cube's blocks, and with `block` at the end when given.
fn with_block(text: &str, block: Option<&str>) -> String {
    let mut out = String::new();
    let mut inside = false;
    for line in text.split_inclusive('\n') {
        let bare = line.trim_end_matches('\n');
        if !inside && bare == BEGIN {
            inside = true;
        } else if inside {
            inside = bare != END;
        } else {
            out.push_str(line);
        }
    }
    if let Some(block) = block {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&format!("{BEGIN}\n{block}{END}\n"));
    }
    out
}

fn c(text: &str) -> io::Result<std::ffi::CString> {
    std::ffi::CString::new(text).map_err(io::Error::other)
}

/// The root's `path`, resolved inside it: the directory that holds it and
/// its name there, or None when that directory does not exist.
fn locate(root: &fs::File, path: &str) -> io::Result<Option<(Vec<String>, OwnedFd, String)>> {
    let components = resolve_in_root(root, path)?;
    let Some((name, parent)) = components.split_last() else {
        return Ok(None);
    };
    match open_resolved(root, parent, libc::O_PATH | libc::O_DIRECTORY, 0) {
        Ok(dir) => Ok(Some((components.clone(), dir, name.clone()))),
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                || error.raw_os_error() == Some(libc::ENOTDIR) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

/// The file at `components`, or None when there is none (or it is not a
/// regular file).
fn read_resolved(root: &fs::File, components: &[String]) -> io::Result<Option<(String, u32)>> {
    let file = match open_resolved(root, components, libc::O_RDONLY | libc::O_NONBLOCK, 0) {
        Ok(fd) => fs::File::from(fd),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let meta = file.metadata()?;
    if !meta.is_file() {
        return Ok(None);
    }
    let too_large = || io::Error::other("larger than 16 MiB; not rewritten");
    if meta.len() > MAX_FILE_BYTES {
        return Err(too_large());
    }
    let mut text = String::new();
    (&file).take(MAX_FILE_BYTES + 1).read_to_string(&mut text)?;
    if text.len() as u64 > MAX_FILE_BYTES {
        return Err(too_large());
    }
    Ok(Some((text, meta.permissions().mode() & 0o7777)))
}

/// Puts cube's `block` into the root's `path` (None takes it out), keeping
/// the file's own lines and mode; `create` makes the file when missing.
fn put_block(root: &fs::File, path: &str, block: Option<&str>, create: bool) -> io::Result<()> {
    let Some((components, dir, name)) = locate(root, path)? else {
        return Ok(());
    };
    let (text, mode) = match read_resolved(root, &components)? {
        Some(found) => found,
        None if create && block.is_some() => (String::new(), 0o644),
        None => return Ok(()),
    };
    let wanted = with_block(&text, block);
    if wanted != text {
        write_atomic_at(&dir, &name, wanted.as_bytes(), mode, None)?;
    }
    Ok(())
}

/// Writes or removes a whole file of cube's in the root.
fn put_file(root: &fs::File, path: &str, content: Option<&str>) -> io::Result<()> {
    let Some((components, dir, name)) = locate(root, path)? else {
        return Ok(());
    };
    match content {
        Some(content) => {
            if read_resolved(root, &components)?.is_none_or(|(text, _)| text != content) {
                write_atomic_at(&dir, &name, content.as_bytes(), 0o644, None)?;
            }
        }
        None => {
            let name = c(&name)?;
            if unsafe { libc::unlinkat(dir.as_raw_fd(), name.as_ptr(), 0) } != 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::NotFound {
                    return Err(error);
                }
            }
        }
    }
    Ok(())
}

/// The mount point for a bind over the root's `path`: the file (or
/// directory) there, made empty when missing, and where it is below the
/// root. None when its directory is missing, or something else is there
/// (nothing is bound then).
fn mount_point(
    root: &fs::File,
    path: &str,
    directory: bool,
) -> io::Result<Option<(OwnedFd, Vec<String>)>> {
    let Some((components, dir, name)) = locate(root, path)? else {
        return Ok(None);
    };
    match open_resolved(root, &components, libc::O_PATH, 0) {
        Ok(fd) => {
            let meta = fs::File::from(fd.try_clone()?).metadata()?;
            Ok(
                (meta.is_dir() == directory && (directory || meta.is_file()))
                    .then_some((fd, components)),
            )
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            let name = c(&name)?;
            let made = unsafe {
                if directory {
                    libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o755)
                } else {
                    libc::openat(
                        dir.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_WRONLY
                            | libc::O_CREAT
                            | libc::O_EXCL
                            | libc::O_NOFOLLOW
                            | libc::O_CLOEXEC,
                        0o644,
                    )
                }
            };
            if made < 0 {
                return Err(io::Error::last_os_error());
            }
            if !directory {
                unsafe { libc::close(made) };
            }
            record_mount_point(&components);
            Ok(Some((
                open_resolved(root, &components, libc::O_PATH, 0)?,
                components,
            )))
        }
        Err(error) => Err(error),
    }
}

/// Notes a mount point this agent made in the root (`state/mount-points`),
/// so template publishing leaves it out.
pub fn record_mount_point(components: &[String]) {
    let path = Path::new(STATE).join(MOUNT_POINTS);
    let line = components.join("/");
    if fs::read_to_string(&path).is_ok_and(|known| known.lines().any(|known| known == line)) {
        return;
    }
    let result = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .open(&path)
        .and_then(|mut file| writeln!(file, "{line}"));
    if let Err(error) = result {
        eprintln!("cube-agent: {}: {error}", path.display());
    }
}

/// Binds `source` over what `at` opened (through `/proc/self/fd`, so no
/// link is followed again). The read-only remount needs the new mount's
/// own path (`under` below `root`); nothing runs in the workload yet.
fn bind(
    source: &Path,
    (at, under): &(OwnedFd, Vec<String>),
    root: &Path,
    read_only: bool,
) -> io::Result<()> {
    let target = format!("/proc/self/fd/{}", at.as_raw_fd());
    crate::setup::mount(
        &source.to_string_lossy(),
        &target,
        None,
        libc::MS_BIND,
        None,
    )?;
    if read_only {
        crate::setup::mount(
            "none",
            &root.join(under.join("/")).to_string_lossy(),
            None,
            libc::MS_REMOUNT | libc::MS_BIND | libc::MS_RDONLY | libc::MS_NODEV | libc::MS_NOSUID,
            None,
        )?;
    }
    Ok(())
}

/// Once per boot, before the workload namespace: /etc/cube and the
/// generated files bound over their paths in `root`. Returns the paths that
/// could not be bound (the image has no place for them); the machine is not
/// ready then.
pub fn bind_all(root: &Path) -> Result<Vec<String>, Refusal> {
    let mut unbound = vec![];
    let state = Path::new(STATE);
    let etc_cube = state.join(ETC_CUBE);
    let generated = state.join(GENERATED);
    for (dir, mode) in [
        (&etc_cube, 0o755),
        (&etc_cube.join("hooks"), 0o755),
        (&generated, 0o755),
    ] {
        fs::create_dir_all(dir)
            .and_then(|()| fs::set_permissions(dir, fs::Permissions::from_mode(mode)))
            .map_err(|error| internal(&dir.display().to_string(), error))?;
    }
    let root_dir = fs::File::open(root).map_err(|error| internal("the workload root", error))?;
    match mount_point(&root_dir, "etc/cube", true) {
        Ok(Some(at)) => {
            bind(&etc_cube, &at, root, true).map_err(|error| internal("/etc/cube", error))?
        }
        Ok(None) => {
            eprintln!("cube-agent: /etc/cube is not a directory in this image");
            unbound.push("/etc/cube".to_string());
        }
        Err(error) => return Err(internal("/etc/cube", error)),
    }
    for (name, path, mode) in BOUND {
        let source = generated.join(name);
        fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .mode(mode)
            .open(&source)
            .and_then(|_| fs::set_permissions(&source, fs::Permissions::from_mode(mode)))
            .map_err(|error| internal(name, error))?;
        match mount_point(&root_dir, path, false) {
            Ok(Some(at)) => {
                bind(&source, &at, root, false).map_err(|error| internal(path, error))?
            }
            Ok(None) => {
                eprintln!("cube-agent: no /{path} in this image (not bound)");
                unbound.push(format!("/{path}"));
            }
            Err(error) => return Err(internal(path, error)),
        }
    }
    Ok(unbound)
}

/// Writes a bound file in place when its content changed.
fn rewrite(path: &Path, content: &str) -> io::Result<()> {
    if fs::read_to_string(path).is_ok_and(|text| text == content) {
        return Ok(());
    }
    let mut file = fs::OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)?;
    file.write_all(content.as_bytes())?;
    file.sync_all()
}

/// What a setup writes. `env` is cube's lines for every command.
pub struct Files<'a> {
    pub hostname: &'a str,
    pub env: &'a [(String, String)],
    pub hooks: [(&'a str, Option<&'a [u8]>); 2],
    pub ca: Option<&'a str>,
}

/// On every setup: the files behind the binds, cube's blocks and the
/// runner's CA. Idempotent; a file already right is not touched.
pub fn write_all(root: &Path, files: &Files) -> Result<(), Refusal> {
    let state = Path::new(STATE);
    let etc_cube = state.join(ETC_CUBE);
    let generated = state.join(GENERATED);
    let mut env = String::from(
        "# cube's environment for every command (keel writes it on every machine_setup)\n",
    );
    for (name, value) in files.env {
        env.push_str(&format!("{name}={value}\n"));
    }
    let hostname = files.hostname;
    let content = [
        (
            "hosts",
            format!(
                "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n127.0.1.1\t{hostname}\n"
            ),
        ),
        ("hostname", format!("{hostname}\n")),
        (
            "resolv.conf",
            format!(
                "# the runner answers DNS on the machine's private link\nnameserver {RUNNER_IP}\n"
            ),
        ),
        (
            "sudoers",
            format!(
                "agent ALL=(ALL) NOPASSWD:ALL\nDefaults env_keep += \"{}\"\n",
                CA_VARIABLES.join(" ")
            ),
        ),
    ];
    for (name, text) in &content {
        rewrite(&generated.join(name), text).map_err(|error| internal(name, error))?;
    }
    let write = |path: &Path, data: &[u8], mode: u32| -> Result<(), Refusal> {
        if fs::read(path).is_ok_and(|have| have == data)
            && fs::metadata(path).is_ok_and(|meta| meta.permissions().mode() & 0o7777 == mode)
        {
            return Ok(());
        }
        crate::files::write_atomic(path, data, mode)
            .map_err(|error| internal(&path.display().to_string(), error))
    };
    let remove = |path: &Path| match fs::remove_file(path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => {
            Err(internal(&path.display().to_string(), error))
        }
        _ => Ok(()),
    };
    write(&etc_cube.join("env"), env.as_bytes(), 0o644)?;
    for (name, script) in files.hooks {
        let path = etc_cube.join("hooks").join(name);
        match script.filter(|script| !script.is_empty()) {
            Some(script) => write(&path, script, 0o755)?,
            None => remove(&path)?,
        }
    }
    match files.ca {
        Some(ca) => {
            write(&etc_cube.join("ca.pem"), ca.as_bytes(), 0o644)?;
            remember_ca(&state.join(RUNNER_CAS), ca)
                .map_err(|error| internal(RUNNER_CAS, error))?;
        }
        None => remove(&etc_cube.join("ca.pem"))?,
    }

    let root_dir = fs::File::open(root).map_err(|error| internal("the workload root", error))?;
    if let Some(bundle) = bundle(root) {
        put_block(&root_dir, &bundle, files.ca, false).map_err(|error| internal(&bundle, error))?;
    }
    if let Some(ca) = files.ca {
        let has_dir = locate(&root_dir, CA_FILE).ok().flatten().is_some();
        if has_dir {
            put_file(&root_dir, CA_FILE, Some(ca)).map_err(|error| internal(CA_FILE, error))?;
        }
    } else {
        put_file(&root_dir, CA_FILE, None).map_err(|error| internal(CA_FILE, error))?;
    }
    put_block(&root_dir, "etc/gitconfig", Some(GITCONFIG), true)
        .map_err(|error| internal("/etc/gitconfig", error))?;
    let environment: String = files
        .env
        .iter()
        .filter(|(name, _)| CA_VARIABLES.contains(&name.as_str()))
        .map(|(name, value)| format!("{name}={value}\n"))
        .collect();
    put_block(
        &root_dir,
        "etc/environment",
        (!environment.is_empty()).then_some(environment.as_str()),
        true,
    )
    .map_err(|error| internal("/etc/environment", error))?;
    Ok(())
}

/// Adds the certificates of `ca` that `path` lacks (by DER), so template
/// publishing knows every CA this machine was given, a replaced one too.
fn remember_ca(path: &Path, ca: &str) -> io::Result<()> {
    let mut known = fs::read(path).unwrap_or_default();
    let have = pem_certificates(&known);
    let mut changed = false;
    for (der, lines) in pem_blocks(ca.as_bytes()) {
        if !have.contains(&der) {
            known.extend_from_slice(&lines);
            changed = true;
        }
    }
    if changed {
        crate::files::write_atomic(path, &known, 0o600)?;
    }
    Ok(())
}

fn decode(body: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(body).ok()
}

/// The PEM certificates in `data`: each one's DER and its lines, from BEGIN
/// to END as they are in `data`. One that does not decode is left out.
fn pem_blocks(data: &[u8]) -> Vec<(Vec<u8>, Vec<u8>)> {
    let mut out = vec![];
    let mut current: Option<(String, Vec<u8>)> = None;
    for line in data.split_inclusive(|&b| b == b'\n') {
        let bare = line.trim_ascii();
        match &mut current {
            None if bare == b"-----BEGIN CERTIFICATE-----" => {
                current = Some((String::new(), line.to_vec()));
            }
            None => {}
            Some((body, lines)) => {
                lines.extend_from_slice(line);
                if bare == b"-----END CERTIFICATE-----" {
                    if !lines.ends_with(b"\n") {
                        lines.push(b'\n');
                    }
                    if let Some(der) = decode(body) {
                        out.push((der, std::mem::take(lines)));
                    }
                    current = None;
                } else {
                    body.push_str(&String::from_utf8_lossy(bare));
                }
            }
        }
    }
    out
}

/// The DER of every PEM certificate in `data`.
pub fn pem_certificates(data: &[u8]) -> Vec<Vec<u8>> {
    pem_blocks(data).into_iter().map(|(der, _)| der).collect()
}

/// `data` without cube's marker blocks and without every PEM certificate
/// whose DER is one of `ders`, marked or not (update-ca-certificates copies
/// `cube-runner.crt` into the bundle it writes again, without markers). The
/// rest stays byte for byte. Template publishing removes the runner's CA
/// with it; a CA rotation can use it the same way.
pub fn without_runner_cas(data: &[u8], ders: &[Vec<u8>]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut block = false;
    let mut cert: Option<(String, Vec<u8>)> = None;
    for line in data.split_inclusive(|&b| b == b'\n') {
        let bare = line.strip_suffix(b"\n").unwrap_or(line);
        if block {
            block = bare != END.as_bytes();
            continue;
        }
        if bare == BEGIN.as_bytes() {
            block = true;
            continue;
        }
        let trimmed = line.trim_ascii();
        match &mut cert {
            Some((body, lines)) => {
                lines.extend_from_slice(line);
                if trimmed == b"-----END CERTIFICATE-----" {
                    if !decode(body).is_some_and(|der| ders.contains(&der)) {
                        out.extend_from_slice(lines);
                    }
                    cert = None;
                } else {
                    body.push_str(&String::from_utf8_lossy(trimmed));
                }
            }
            None if trimmed == b"-----BEGIN CERTIFICATE-----" => {
                cert = Some((String::new(), line.to_vec()));
            }
            None => out.extend_from_slice(line),
        }
    }
    if let Some((_, lines)) = cert {
        out.extend_from_slice(&lines); // an unfinished certificate stays as it was
    }
    out
}

/// The sysctls systemd sets: a link or hard link in a sticky or another
/// account's directory does not lend its owner's rights (fs.protected_*).
pub fn protect_links() {
    for name in ["protected_hardlinks", "protected_symlinks"] {
        if let Err(error) = fs::write(format!("/proc/sys/fs/{name}"), "1") {
            eprintln!("cube-agent: fs.{name}: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PEM: &str =
        "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\nAAAA==\n-----END CERTIFICATE-----\n";

    #[test]
    fn the_ca_is_pem_certificates_or_nothing() {
        assert_eq!(check_ca("").unwrap(), None);
        assert_eq!(check_ca("  \n").unwrap(), None);
        assert_eq!(check_ca(PEM).unwrap().as_deref(), Some(PEM));
        assert_eq!(
            check_ca(&format!("  {}", PEM.replace('\n', "\r\n")))
                .unwrap()
                .as_deref(),
            Some(PEM),
            "lines are trimmed"
        );
        assert!(check_ca(&format!("{PEM}{PEM}")).is_ok());
        for bad in [
            "hello",
            "-----BEGIN CERTIFICATE-----\nAAAA\n",
            "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n",
            "-----BEGIN CERTIFICATE-----\nAA AA\n-----END CERTIFICATE-----\n",
            &format!("{PEM}trailing words\n"),
            &"x".repeat(MAX_CA_BYTES + 1),
        ] {
            assert_eq!(check_ca(bad).unwrap_err().reason, "bad_ca", "{bad:.40}");
        }
    }

    #[test]
    fn cube_s_block_is_replaced_and_the_image_s_lines_stay() {
        let image = "image line 1\nimage line 2";
        let once = with_block(image, Some("A\n"));
        assert_eq!(
            once,
            format!("image line 1\nimage line 2\n{BEGIN}\nA\n{END}\n")
        );
        let twice = with_block(&once, Some("B\n"));
        assert_eq!(
            twice,
            format!("image line 1\nimage line 2\n{BEGIN}\nB\n{END}\n")
        );
        assert_eq!(with_block(&twice, None), "image line 1\nimage line 2\n");
        assert_eq!(with_block("", Some("A\n")), format!("{BEGIN}\nA\n{END}\n"));
        // Lines the image added after cube's block stay too.
        let later = format!("{twice}after\n");
        assert_eq!(
            with_block(&later, Some("C\n")),
            format!("image line 1\nimage line 2\nafter\n{BEGIN}\nC\n{END}\n")
        );
    }

    #[test]
    fn blocks_and_files_are_written_inside_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("etc/ssl/certs")).unwrap();
        fs::create_dir_all(root.join("usr/local/share/ca-certificates")).unwrap();
        fs::write(root.join("etc/ssl/certs/ca-certificates.crt"), "IMAGE CA\n").unwrap();
        fs::write(root.join("etc/gitconfig"), "[user]\n\tname = image\n").unwrap();
        let file = fs::File::open(root).unwrap();
        assert_eq!(
            bundle(root).as_deref(),
            Some("/etc/ssl/certs/ca-certificates.crt")
        );
        put_block(
            &file,
            "/etc/ssl/certs/ca-certificates.crt",
            Some(PEM),
            false,
        )
        .unwrap();
        put_block(
            &file,
            "/etc/ssl/certs/ca-certificates.crt",
            Some(PEM),
            false,
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(root.join("etc/ssl/certs/ca-certificates.crt")).unwrap(),
            format!("IMAGE CA\n{BEGIN}\n{PEM}{END}\n"),
            "once, however often"
        );
        put_block(&file, "etc/gitconfig", Some(GITCONFIG), true).unwrap();
        let git = fs::read_to_string(root.join("etc/gitconfig")).unwrap();
        assert!(
            git.starts_with("[user]\n\tname = image\n# cube: begin"),
            "{git}"
        );
        put_block(&file, "etc/environment", Some("A=b\n"), true).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("etc/environment")).unwrap(),
            format!("{BEGIN}\nA=b\n{END}\n")
        );
        // Not made when it is missing and `create` is false.
        put_block(&file, "etc/pki/tls/certs/ca-bundle.crt", Some(PEM), false).unwrap();
        assert!(!root.join("etc/pki").exists());
        put_file(&file, CA_FILE, Some(PEM)).unwrap();
        assert_eq!(fs::read_to_string(root.join(CA_FILE)).unwrap(), PEM);
        put_file(&file, CA_FILE, None).unwrap();
        assert!(!root.join(CA_FILE).exists());
        put_file(&file, CA_FILE, None).unwrap();

        // A link to / in the image names the root's file, never this host's.
        std::os::unix::fs::symlink("/", root.join("etc/up")).unwrap();
        fs::create_dir_all(root.join("tmp")).unwrap();
        std::os::unix::fs::symlink("/etc/up/tmp/hosts", root.join("etc/hosts")).unwrap();
        let at = mount_point(&file, "etc/hosts", false).unwrap();
        assert!(at.is_some());
        assert!(
            root.join("tmp/hosts").is_file(),
            "made in the root, through the link"
        );
        // A directory where a file is bound is left alone.
        fs::create_dir_all(root.join("etc/hostname")).unwrap();
        assert!(mount_point(&file, "etc/hostname", false).unwrap().is_none());
        // No /etc/sudoers.d: nothing to bind, nothing made.
        assert!(
            mount_point(&file, "etc/sudoers.d/cube", false)
                .unwrap()
                .is_none()
        );
        assert!(!root.join("etc/sudoers.d").exists());
        assert!(mount_point(&file, "etc/cube", true).unwrap().is_some());
        assert!(root.join("etc/cube").is_dir());
    }

    #[test]
    fn a_file_too_large_to_rewrite_is_refused_not_cut() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("etc")).unwrap();
        let big = vec![b'x'; (MAX_FILE_BYTES + 1) as usize];
        fs::write(root.join("etc/environment"), &big).unwrap();
        let file = fs::File::open(root).unwrap();
        assert!(put_block(&file, "etc/environment", Some("A=b\n"), true).is_err());
        assert_eq!(
            fs::read(root.join("etc/environment")).unwrap().len(),
            big.len()
        );
    }

    #[test]
    fn every_ca_a_setup_brought_is_remembered_once() {
        use base64::Engine;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(RUNNER_CAS);
        let pem = |der: &[u8]| {
            format!(
                "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
                base64::engine::general_purpose::STANDARD.encode(der)
            )
        };
        remember_ca(&path, &pem(b"first")).unwrap();
        remember_ca(&path, &pem(b"first")).unwrap();
        remember_ca(&path, &format!("{}{}", pem(b"first"), pem(b"second"))).unwrap();
        assert_eq!(
            pem_certificates(&fs::read(&path).unwrap()),
            vec![b"first".to_vec(), b"second".to_vec()]
        );
    }

    #[test]
    fn cube_s_lines_name_the_bundle() {
        let lines = cube_lines(Some("/etc/ssl/cert.pem"));
        assert_eq!(
            lines[0],
            ("NODE_EXTRA_CA_CERTS".into(), "/etc/ssl/cert.pem".into())
        );
        assert_eq!(lines.len(), 7);
        assert_eq!(cube_lines(None).len(), 3);
    }
}
