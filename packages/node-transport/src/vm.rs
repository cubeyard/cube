//! QEMU for one VM: paths, command line per platform, process spawning and
//! a small blocking QMP client.
//!
//! The guest's only network device is `-netdev dgram` on a unix socket pair
//! inside the VM directory; the runner's pump owns the other end. QEMU gets
//! no user-mode network, no host forwarding and no display.
use std::{
    ffi::OsString,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Mutex, mpsc},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde_json::{Value, json};

/// macOS `sockaddr_un.sun_path` holds 104 bytes including the NUL.
pub const MAX_SOCKET_PATH: usize = 103;
pub const PLATFORM_LINUX_X86_64: &str = "linux-x86_64";
pub const PLATFORM_MACOS_AARCH64: &str = "macos-aarch64";
/// `-netdev dgram` appeared in QEMU 7.2.
pub const MIN_QEMU: (u32, u32) = (7, 2);

pub fn host_platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some(PLATFORM_LINUX_X86_64),
        ("macos", "aarch64") => Some(PLATFORM_MACOS_AARCH64),
        _ => None,
    }
}

pub fn default_qemu(platform: &str) -> &'static str {
    if platform == PLATFORM_MACOS_AARCH64 {
        "qemu-system-aarch64"
    } else {
        "qemu-system-x86_64"
    }
}

/// Every file of one VM lives in `state/vms/<slot>/`. The short slot keeps
/// unix socket paths below the platform limit.
#[derive(Clone, Debug)]
pub struct VmPaths {
    pub dir: PathBuf,
    pub disk: PathBuf,
    pub seed: PathBuf,
    pub console: PathBuf,
    pub qemu_log: PathBuf,
    pub qmp: PathBuf,
    /// Bound by the runner's pump.
    pub net: PathBuf,
    /// Bound by QEMU.
    pub qemu_net: PathBuf,
}

impl VmPaths {
    pub fn new(state: &Path, slot: u32) -> Self {
        let dir = state.join("vms").join(slot.to_string());
        Self {
            disk: dir.join("disk.qcow2"),
            seed: dir.join("seed.img"),
            console: dir.join("console.log"),
            qemu_log: dir.join("qemu.log"),
            qmp: dir.join("qmp.sock"),
            net: dir.join("net.sock"),
            qemu_net: dir.join("qemu-net.sock"),
            dir,
        }
    }
    pub fn check_socket_lengths(&self) -> Result<()> {
        for path in [&self.qmp, &self.net, &self.qemu_net] {
            ensure!(
                path.as_os_str().len() <= MAX_SOCKET_PATH,
                "socket path {} is too long; use a shorter state directory",
                path.display()
            );
        }
        Ok(())
    }
}

pub struct Launch<'a> {
    pub platform: &'a str,
    pub firmware: Option<&'a Path>,
    pub vm_id: &'a str,
    pub vcpus: u32,
    pub memory_mib: u32,
    pub mac: &'a str,
    pub paths: &'a VmPaths,
    /// QEMU's inherited end of the frame socket pair.
    pub net_fd: i32,
}

fn path_arg(prefix: &str, path: &Path, suffix: &str) -> OsString {
    let mut value = OsString::from(prefix);
    value.push(path.as_os_str());
    value.push(suffix);
    value
}

/// The QEMU arguments. Paths are absolute; commas in them are refused
/// because QEMU option syntax would split them.
pub fn qemu_args(launch: &Launch<'_>) -> Result<Vec<OsString>> {
    let paths = launch.paths;
    for path in [&paths.disk, &paths.seed, &paths.console, &paths.qmp] {
        ensure!(path.is_absolute(), "VM paths must be absolute");
        ensure!(
            !path.to_string_lossy().contains(','),
            "VM paths must not contain commas"
        );
    }
    let mut args: Vec<OsString> = Vec::new();
    let mut push = |values: &[&str]| args.extend(values.iter().map(OsString::from));
    match launch.platform {
        PLATFORM_LINUX_X86_64 => {
            push(&["-machine", "q35,accel=kvm", "-cpu", "host"]);
        }
        PLATFORM_MACOS_AARCH64 => {
            push(&["-machine", "virt,accel=hvf", "-cpu", "host"]);
        }
        other => bail!("unsupported platform {other}"),
    }
    let smp = launch.vcpus.to_string();
    let memory = launch.memory_mib.to_string();
    push(&["-smp", &smp, "-m", &memory]);
    push(&["-nodefaults", "-no-user-config", "-display", "none"]);
    if launch.platform == PLATFORM_LINUX_X86_64 {
        // With -nodefaults and no display adapter the Debian 13 genericcloud
        // image reboots in a loop right after GRUB (QEMU 8.2).
        push(&["-vga", "std"]);
    }
    let name = format!("guest={}", launch.vm_id);
    push(&["-name", &name]);
    if let Some(firmware) = launch.firmware {
        args.push("-bios".into());
        args.push(firmware.as_os_str().into());
    }
    args.push("-serial".into());
    args.push(path_arg("file:", &paths.console, ""));
    args.push("-qmp".into());
    args.push(path_arg("unix:", &paths.qmp, ",server=on,wait=off"));
    args.push("-drive".into());
    args.push(path_arg(
        "if=virtio,format=qcow2,discard=unmap,file=",
        &paths.disk,
        "",
    ));
    args.push("-drive".into());
    args.push(path_arg(
        "if=virtio,format=raw,readonly=on,file=",
        &paths.seed,
        "",
    ));
    args.push("-netdev".into());
    args.push(format!("dgram,id=n0,local.type=fd,local.str={}", launch.net_fd).into());
    args.push("-device".into());
    // QEMU's default option ROM for this NIC is x86 iPXE: aarch64 firmware
    // refuses it ("Image type X64 can't be loaded on AARCH64 UEFI system"),
    // which reads like a wrong-architecture disk in the console.
    let rom = if launch.platform == PLATFORM_MACOS_AARCH64 {
        ",romfile="
    } else {
        ""
    };
    args.push(format!("virtio-net-pci,netdev=n0,mac={}{rom}", launch.mac).into());
    args.push("-device".into());
    args.push("virtio-rng-pci".into());
    if launch.platform == PLATFORM_LINUX_X86_64 {
        args.push("-sandbox".into());
        args.push("on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny".into());
    }
    Ok(args)
}

/// Parses `QEMU emulator version 8.2.2 (...)`.
pub fn parse_qemu_version(text: &str) -> Option<(u32, u32, u32)> {
    let rest = text.split("version ").nth(1)?;
    let version: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = version.split('.').map(|p| p.parse::<u32>().ok());
    Some((
        parts.next()??,
        parts.next()??,
        parts.next().flatten().unwrap_or(0),
    ))
}

pub fn check_qemu(qemu: &Path) -> Result<(u32, u32, u32)> {
    let output = Command::new(qemu)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
        .with_context(|| format!("run {} --version", qemu.display()))?;
    ensure!(
        output.status.success(),
        "{} --version failed",
        qemu.display()
    );
    let text = String::from_utf8_lossy(&output.stdout);
    let version = parse_qemu_version(&text)
        .with_context(|| format!("unrecognised QEMU version output: {}", text.trim()))?;
    ensure!(
        (version.0, version.1) >= MIN_QEMU,
        "QEMU {}.{}.{} is too old; 7.2 or newer is required",
        version.0,
        version.1,
        version.2
    );
    Ok(version)
}

/// KVM on Linux, Hypervisor.framework on macOS.
pub fn check_accelerator(platform: &str) -> Result<()> {
    match platform {
        PLATFORM_LINUX_X86_64 => {
            std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open("/dev/kvm")
                .context("/dev/kvm is not usable; the runner account needs KVM (group kvm)")?;
            Ok(())
        }
        PLATFORM_MACOS_AARCH64 => {
            let output = Command::new("sysctl")
                .args(["-n", "kern.hv_support"])
                .output()
                .context("sysctl kern.hv_support")?;
            ensure!(
                String::from_utf8_lossy(&output.stdout).trim() == "1",
                "Hypervisor.framework is not available (kern.hv_support != 1)"
            );
            Ok(())
        }
        other => bail!("unsupported platform {other}"),
    }
}

pub fn which(name: &str) -> Option<PathBuf> {
    let candidate = Path::new(name);
    if candidate.is_absolute() {
        return candidate.is_file().then(|| candidate.into());
    }
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(name))
            .find(|path| path.is_file())
    })
}

type SpawnJob = (Command, mpsc::Sender<std::io::Result<Child>>);

/// Spawns QEMU from one long-lived thread. On Linux the child gets
/// `PR_SET_PDEATHSIG(SIGKILL)`, which fires when the *spawning thread* exits,
/// so spawning must not happen on a short-lived blocking-pool thread.
pub struct Spawner {
    jobs: Mutex<mpsc::Sender<SpawnJob>>,
}

impl Default for Spawner {
    fn default() -> Self {
        Self::new()
    }
}

impl Spawner {
    pub fn new() -> Self {
        let (tx, rx) = mpsc::channel::<SpawnJob>();
        std::thread::Builder::new()
            .name("cube-vm-spawner".into())
            .spawn(move || {
                for (mut command, reply) in rx {
                    let _ = reply.send(command.spawn());
                }
            })
            .expect("spawn thread");
        Self {
            jobs: Mutex::new(tx),
        }
    }

    pub fn spawn(&self, mut command: Command) -> Result<Child> {
        use std::os::unix::process::CommandExt;
        let parent = std::process::id() as libc::pid_t;
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            command.pre_exec(move || {
                // Own process group: a terminal Ctrl-C reaches the runner,
                // which then stops its VMs; it must not kill QEMU directly.
                if libc::setpgid(0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                #[cfg(target_os = "linux")]
                {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                    if libc::getppid() != parent {
                        libc::_exit(1);
                    }
                }
                let _ = parent;
                Ok(())
            });
        }
        let (tx, rx) = mpsc::channel();
        self.jobs
            .lock()
            .unwrap()
            .send((command, tx))
            .map_err(|_| anyhow!("spawner thread is gone"))?;
        Ok(rx.recv().map_err(|_| anyhow!("spawner thread is gone"))??)
    }
}

pub fn qemu_command(qemu: &Path, args: Vec<OsString>, log: &Path) -> Result<Command> {
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)?;
    let mut command = Command::new(qemu);
    command
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    Ok(command)
}

/// A blocking QMP connection. QEMU serves one QMP client at a time, so
/// every use opens its own short connection.
pub struct Qmp {
    reader: BufReader<UnixStream>,
    writer: UnixStream,
}

impl Qmp {
    pub fn connect(path: &Path, timeout: Duration) -> Result<Self> {
        let stream = UnixStream::connect(path)?;
        stream.set_read_timeout(Some(timeout))?;
        stream.set_write_timeout(Some(timeout))?;
        let mut qmp = Self {
            reader: BufReader::new(stream.try_clone()?),
            writer: stream,
        };
        let greeting = qmp.read()?;
        ensure!(greeting.get("QMP").is_some(), "not a QMP greeting");
        qmp.execute("qmp_capabilities")?;
        Ok(qmp)
    }

    fn read(&mut self) -> Result<Value> {
        let mut line = String::new();
        loop {
            line.clear();
            ensure!(
                self.reader.read_line(&mut line)? > 0,
                "QMP connection closed"
            );
            ensure!(line.len() < 1 << 20, "QMP line too long");
            let value: Value = serde_json::from_str(&line)?;
            if value.get("event").is_none() {
                return Ok(value);
            }
        }
    }

    pub fn execute(&mut self, command: &str) -> Result<Value> {
        let mut request = serde_json::to_vec(&json!({ "execute": command }))?;
        request.push(b'\n');
        self.writer.write_all(&request)?;
        let response = self.read()?;
        if let Some(value) = response.get("return") {
            return Ok(value.clone());
        }
        bail!(
            "QMP {command} failed: {}",
            response
                .get("error")
                .map(Value::to_string)
                .unwrap_or_default()
        )
    }

    pub fn name(&mut self) -> Result<String> {
        Ok(self.execute("query-name")?["name"]
            .as_str()
            .unwrap_or_default()
            .to_owned())
    }

    /// Waits until QEMU closes the connection (it exits after `quit`).
    pub fn wait_closed(mut self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut line = String::new();
        while Instant::now() < deadline {
            line.clear();
            match self.reader.read_line(&mut line) {
                Ok(0) => return true,
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => return true,
            }
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions() {
        assert_eq!(
            parse_qemu_version("QEMU emulator version 8.2.2 (Debian 1:8.2.2+ds-0ubuntu1.17)\n"),
            Some((8, 2, 2))
        );
        assert_eq!(
            parse_qemu_version("QEMU emulator version 10.1.0\nCopyright"),
            Some((10, 1, 0))
        );
        assert_eq!(
            parse_qemu_version("QEMU emulator version 7.2"),
            Some((7, 2, 0))
        );
        assert_eq!(parse_qemu_version("nothing"), None);
    }

    #[test]
    fn linux_command_line() {
        let paths = VmPaths::new(Path::new("/var/lib/cube-runner/state"), 3);
        let args = qemu_args(&Launch {
            platform: PLATFORM_LINUX_X86_64,
            firmware: None,
            vm_id: "0123456789abcdef",
            vcpus: 2,
            memory_mib: 2048,
            mac: "02:aa:bb:cc:dd:ee",
            paths: &paths,
            net_fd: 7,
        })
        .unwrap();
        let line: Vec<String> = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        let line = line.join(" ");
        for expected in [
            "-machine q35,accel=kvm -cpu host -smp 2 -m 2048",
            "-nodefaults -no-user-config -display none -vga std",
            "-name guest=0123456789abcdef",
            "-serial file:/var/lib/cube-runner/state/vms/3/console.log",
            "-qmp unix:/var/lib/cube-runner/state/vms/3/qmp.sock,server=on,wait=off",
            "file=/var/lib/cube-runner/state/vms/3/disk.qcow2",
            "if=virtio,format=raw,readonly=on,file=/var/lib/cube-runner/state/vms/3/seed.img",
            "-netdev dgram,id=n0,local.type=fd,local.str=7",
            "-device virtio-net-pci,netdev=n0,mac=02:aa:bb:cc:dd:ee",
            "-sandbox on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny",
        ] {
            assert!(line.contains(expected), "missing {expected:?} in {line}");
        }
        for absent in [
            "-netdev user",
            "hostfwd",
            "-nic",
            "vnc",
            "spice",
            "-bios",
            "romfile",
        ] {
            assert!(!line.contains(absent), "unexpected {absent:?} in {line}");
        }
        assert_eq!(
            line.matches("-netdev ").count(),
            1,
            "one network device only"
        );
    }

    #[test]
    fn macos_command_line() {
        let paths = VmPaths::new(Path::new("/Users/r/state"), 1);
        let args = qemu_args(&Launch {
            platform: PLATFORM_MACOS_AARCH64,
            firmware: Some(Path::new("/opt/homebrew/share/qemu/edk2-aarch64-code.fd")),
            vm_id: "0123456789abcdef",
            vcpus: 1,
            memory_mib: 1024,
            mac: "02:00:00:00:00:01",
            paths: &paths,
            net_fd: 7,
        })
        .unwrap();
        let line = args
            .iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        assert!(line.contains("-machine virt,accel=hvf -cpu host"));
        assert!(line.contains("-bios /opt/homebrew/share/qemu/edk2-aarch64-code.fd"));
        assert!(!line.contains("-sandbox") && !line.contains("-vga"));
        // No x86 iPXE option ROM in an aarch64 guest.
        assert!(
            args.iter()
                .any(|a| a == "virtio-net-pci,netdev=n0,mac=02:00:00:00:00:01,romfile=")
        );
    }

    #[test]
    fn refuses_commas_and_relative_paths() {
        for state in ["/tmp/a,b", "relative"] {
            let paths = VmPaths::new(Path::new(state), 1);
            assert!(
                qemu_args(&Launch {
                    platform: PLATFORM_LINUX_X86_64,
                    firmware: None,
                    vm_id: "0123456789abcdef",
                    vcpus: 1,
                    memory_mib: 512,
                    mac: "02:00:00:00:00:01",
                    paths: &paths,
                    net_fd: 7,
                })
                .is_err()
            );
        }
        let long = "/".to_owned() + &"x".repeat(100);
        assert!(
            VmPaths::new(Path::new(&long), 1)
                .check_socket_lengths()
                .is_err()
        );
        assert!(
            VmPaths::new(Path::new("/tmp/s"), 1)
                .check_socket_lengths()
                .is_ok()
        );
    }
}
