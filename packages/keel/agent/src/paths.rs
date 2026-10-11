//! Paths inside the workload root, resolved as a process in that root
//! would resolve them (`openat2` with `RESOLVE_IN_ROOT`): an absolute link
//! names the workload's file, never the base root's.
use std::{
    ffi::CString,
    fs, io,
    os::fd::{AsRawFd, FromRawFd, OwnedFd},
    path::Path,
};

/// Opens `path` (relative to `root`) as `O_PATH`, resolved inside `root`.
pub fn open_in_root(root: &fs::File, path: &str) -> io::Result<OwnedFd> {
    open_in_root_with(root, path, libc::O_PATH)
}

/// Opens `path` with `flags`, resolved inside `root` as a process in that
/// root resolves it: links are followed, an absolute one from `root`.
pub fn open_in_root_with(root: &fs::File, path: &str, flags: i32) -> io::Result<OwnedFd> {
    let name = CString::new(path.trim_start_matches('/')).map_err(io::Error::other)?;
    let mut how: libc::open_how = unsafe { std::mem::zeroed() };
    how.flags = (flags | libc::O_CLOEXEC) as u64;
    how.resolve = libc::RESOLVE_IN_ROOT | libc::RESOLVE_NO_MAGICLINKS;
    let fd = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            root.as_raw_fd(),
            name.as_ptr(),
            &how as *const libc::open_how,
            std::mem::size_of::<libc::open_how>(),
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd as i32) })
}

/// Gives the calling thread, and it alone, `account`'s ids (the raw system
/// calls act on one thread; libc's change every thread of the process).
/// Its effective capabilities go with root's uid, so `DAC_OVERRIDE` too.
/// Call it on a thread that ends with the work.
pub fn become_account(account: &crate::journal::Account) -> io::Result<()> {
    let none = libc::uid_t::MAX;
    unsafe {
        if libc::syscall(
            libc::SYS_setgroups,
            account.groups.len(),
            account.groups.as_ptr(),
        ) != 0
            || libc::syscall(libc::SYS_setresgid, none, account.gid, none) != 0
            || libc::syscall(libc::SYS_setresuid, none, account.uid, none) != 0
        {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Opens `components` (below `root`, every link already resolved) with
/// `flags`, refusing any link on the way (`RESOLVE_NO_SYMLINKS`): what is
/// opened is what was resolved and checked, or `ELOOP` if a link was put
/// there since. Never leaves `root`.
pub fn open_resolved(
    root: &fs::File,
    components: &[String],
    flags: i32,
    mode: u32,
) -> io::Result<OwnedFd> {
    let path = if components.is_empty() {
        ".".to_string()
    } else {
        components.join("/")
    };
    let name = CString::new(path).map_err(io::Error::other)?;
    let mut how: libc::open_how = unsafe { std::mem::zeroed() };
    how.flags = (flags | libc::O_CLOEXEC | libc::O_NOFOLLOW) as u64;
    how.mode = if flags & libc::O_CREAT != 0 {
        mode as u64
    } else {
        0
    };
    how.resolve = libc::RESOLVE_IN_ROOT | libc::RESOLVE_NO_SYMLINKS | libc::RESOLVE_NO_MAGICLINKS;
    let fd = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            root.as_raw_fd(),
            name.as_ptr(),
            &how as *const libc::open_how,
            std::mem::size_of::<libc::open_how>(),
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd as i32) })
}

/// `path` resolved as realpath(3) would resolve it with `root` as `/`:
/// every link that exists is followed (an absolute one from `root`), what
/// does not exist yet is kept as named, and `..` never leaves `root`.
/// Returns the components below `root`.
pub fn resolve_in_root(root: &fs::File, path: &str) -> io::Result<Vec<String>> {
    let mut pending: Vec<String> = path.split('/').rev().map(str::to_string).collect();
    let mut resolved: Vec<String> = vec![];
    let mut links = 0;
    while let Some(part) = pending.pop() {
        match part.as_str() {
            "" | "." => continue,
            ".." => {
                resolved.pop();
                continue;
            }
            _ => {}
        }
        let candidate = resolved
            .iter()
            .chain(std::iter::once(&part))
            .cloned()
            .collect::<Vec<_>>()
            .join("/");
        let name = CString::new(candidate).map_err(io::Error::other)?;
        let mut how: libc::open_how = unsafe { std::mem::zeroed() };
        how.flags = (libc::O_PATH | libc::O_NOFOLLOW | libc::O_CLOEXEC) as u64;
        how.resolve = libc::RESOLVE_IN_ROOT | libc::RESOLVE_NO_MAGICLINKS;
        let fd = unsafe {
            libc::syscall(
                libc::SYS_openat2,
                root.as_raw_fd(),
                name.as_ptr(),
                &how as *const libc::open_how,
                std::mem::size_of::<libc::open_how>(),
            )
        };
        if fd < 0 {
            let error = io::Error::last_os_error();
            // Below a file nothing exists either (realpath(3) keeps going).
            if error.kind() != io::ErrorKind::NotFound
                && error.raw_os_error() != Some(libc::ENOTDIR)
            {
                return Err(error);
            }
            resolved.push(part);
            continue;
        }
        let fd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
        let mut target = vec![0u8; 4096];
        let n = unsafe {
            libc::readlinkat(
                fd.as_raw_fd(),
                c"".as_ptr(),
                target.as_mut_ptr().cast(),
                target.len(),
            )
        };
        if n < 0 {
            resolved.push(part); // not a link
            continue;
        }
        links += 1;
        if links > 40 {
            return Err(io::Error::from_raw_os_error(libc::ELOOP));
        }
        let target = String::from_utf8_lossy(&target[..n as usize]).into_owned();
        if target.starts_with('/') {
            resolved.clear();
        }
        pending.extend(target.split('/').rev().map(str::to_string));
    }
    Ok(resolved)
}

/// Whether the workspace path `relative` (no `..`, checked by the caller)
/// leads out of `root/workspace` through its links.
pub fn leaves_workspace(root: &Path, relative: &str) -> io::Result<bool> {
    let root_dir = fs::File::open(root)?;
    let workspace = resolve_in_root(&root_dir, "workspace")?;
    let at = resolve_in_root(&root_dir, &format!("workspace/{relative}"))?;
    Ok(!at.starts_with(&workspace))
}

/// Whether `name` is an executable file on the standard PATH in the
/// workload root.
pub fn has_command(root: &fs::File, name: &str) -> bool {
    use std::os::unix::fs::PermissionsExt;
    crate::STANDARD_PATH.split(':').any(|dir| {
        open_in_root(root, &format!("{dir}/{name}"))
            .ok()
            .map(fs::File::from)
            .and_then(|file| file.metadata().ok())
            .is_some_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    })
}

/// Whether a regular file exists at `path` in the workload root.
pub fn has_file(root: &fs::File, path: &str) -> bool {
    open_in_root(root, path)
        .ok()
        .map(fs::File::from)
        .and_then(|file| file.metadata().ok())
        .is_some_and(|meta| meta.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{PermissionsExt, symlink};

    #[test]
    fn links_resolve_inside_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("workspace/sub")).unwrap();
        fs::create_dir_all(root.join("etc")).unwrap();
        symlink("/etc", root.join("workspace/abs")).unwrap();
        symlink("sub", root.join("workspace/rel")).unwrap();
        // An absolute link to the workspace stays inside it (the root's /workspace).
        symlink("/workspace/sub", root.join("workspace/back")).unwrap();
        assert!(!leaves_workspace(root, "sub").unwrap());
        assert!(!leaves_workspace(root, "rel").unwrap());
        assert!(!leaves_workspace(root, "back").unwrap());
        assert!(!leaves_workspace(root, "missing/deeper").unwrap());
        assert!(leaves_workspace(root, "abs").unwrap());
        assert!(leaves_workspace(root, "abs/missing").unwrap());
        symlink("/nowhere/at/all", root.join("workspace/dangling")).unwrap();
        assert!(
            leaves_workspace(root, "dangling").unwrap(),
            "a dangling link still leads out"
        );
        symlink("../..", root.join("workspace/sub/up")).unwrap();
        assert!(
            leaves_workspace(root, "sub/up").unwrap(),
            "relative links leave too (but never the root)"
        );
    }

    #[test]
    fn commands_are_found_through_links_in_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("usr/bin")).unwrap();
        symlink("usr/bin", root.join("bin")).unwrap();
        fs::write(root.join("usr/bin/bash"), "").unwrap();
        fs::set_permissions(root.join("usr/bin/bash"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(root.join("usr/bin/plain"), "").unwrap();
        // An absolute link resolves in the root, not on this host.
        symlink("/usr/bin/bash", root.join("usr/bin/sh")).unwrap();
        let file = fs::File::open(root).unwrap();
        assert!(has_command(&file, "bash"));
        assert!(has_command(&file, "sh"));
        assert!(!has_command(&file, "plain"), "not executable");
        assert!(!has_command(&file, "git"));
    }
}
