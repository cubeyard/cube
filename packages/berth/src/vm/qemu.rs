//! QEMU for `berth vm`: the binary is given by path and never searched for
//! (masterplan A17); its floor is read over QMP before the runner serves,
//! and a QEMU below it is refused (runner.proto's header, keel's "QEMU
//! floor"). One set of arguments on Linux and macOS; the architecture picks
//! the machine family and console, the platform the accelerator and
//! `-sandbox`.
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{
        UnixStream,
        unix::{OwnedReadHalf, OwnedWriteHalf},
    },
    process::Command,
};

/// What the floor needs of `qom-list-types`.
pub const FLOOR_DEVICES: [&str; 4] = [
    "virtio-rtc-pci",
    "virtio-serial-pci",
    "virtserialport",
    "virtio-balloon-pci",
];
/// What the floor needs of `query-commands`.
pub const FLOOR_COMMANDS: [&str; 6] = [
    "migrate",
    "migrate-incoming",
    "migrate-set-capabilities",
    "migrate-set-parameters",
    "query-migrate",
    "query-status",
];

/// The accelerator a machine runs under.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Accel {
    Kvm,
    Hvf,
    Tcg,
}

impl Accel {
    pub fn parse(text: &str) -> Result<Self> {
        Ok(match text {
            "kvm" => Self::Kvm,
            "hvf" => Self::Hvf,
            "tcg" => Self::Tcg,
            _ => bail!("--accel is kvm, hvf or tcg"),
        })
    }
    /// KVM on Linux, HVF on macOS.
    pub fn native() -> Self {
        if cfg!(target_os = "macos") {
            Self::Hvf
        } else {
            Self::Kvm
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Kvm => "kvm",
            Self::Hvf => "hvf",
            Self::Tcg => "tcg",
        }
    }
}

/// The guest architecture: the runner host's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Arch {
    X86_64,
    Aarch64,
}

impl Arch {
    pub fn host() -> Result<Self> {
        match std::env::consts::ARCH {
            "x86_64" => Ok(Self::X86_64),
            "aarch64" => Ok(Self::Aarch64),
            other => bail!("berth vm runs on x86_64 and aarch64 hosts, not {other}"),
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::X86_64 => "x86_64",
            Self::Aarch64 => "aarch64",
        }
    }
    /// The versioned machine family: `pc-q35-<x.y>` or `virt-<x.y>`.
    pub fn family(self) -> &'static str {
        match self {
            Self::X86_64 => "pc-q35-",
            Self::Aarch64 => "virt-",
        }
    }
    fn console(self) -> &'static str {
        match self {
            Self::X86_64 => "ttyS0",
            Self::Aarch64 => "ttyAMA0",
        }
    }
}

/// What QMP said about a QEMU binary on `-machine none`.
#[derive(Clone, Debug, Default)]
pub struct Answers {
    pub version: Value,
    pub types: Value,
    pub balloon_properties: Value,
    pub capabilities: Value,
    /// Whether `migrate-set-parameters {mode: cpr-reboot}` was accepted.
    pub cpr_reboot: bool,
    pub commands: Value,
    pub machines: Value,
}

/// A QEMU binary measured against keel's floor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Floor {
    /// `11.1.2`.
    pub version: String,
    /// The family's versioned machine types, newest first.
    pub machine_types: Vec<String>,
    /// What keel needs and this QEMU lacks; empty means it meets the floor.
    pub missing: Vec<String>,
}

impl Floor {
    pub fn newest_machine_type(&self) -> Option<&str> {
        self.machine_types.first().map(String::as_str)
    }
}

fn names(list: &Value, key: &str) -> Vec<String> {
    list.as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item[key].as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

/// Measures `answers` against the floor (runner.proto's header): the
/// devices, `free-page-reporting`, the `mapped-ram` capability, migration
/// mode `cpr-reboot`, the migration commands, a versioned machine type of
/// the family, and the accelerator.
pub fn evaluate(answers: &Answers, arch: Arch, accel: Accel) -> Floor {
    let q = &answers.version["qemu"];
    let version = format!("{}.{}.{}", q["major"], q["minor"], q["micro"]);
    let mut missing = Vec::new();
    let types = names(&answers.types, "name");
    for device in FLOOR_DEVICES {
        if !types.iter().any(|t| t == device) {
            missing.push(device.to_owned());
        }
    }
    if !names(&answers.balloon_properties, "name")
        .iter()
        .any(|p| p == "free-page-reporting")
    {
        missing.push("virtio-balloon-pci free-page-reporting".into());
    }
    if !names(&answers.capabilities, "capability")
        .iter()
        .any(|c| c == "mapped-ram")
    {
        missing.push("migrate capability mapped-ram".into());
    }
    if !answers.cpr_reboot {
        missing.push("migrate mode cpr-reboot".into());
    }
    // x86-64 guests reseed their random generator from QEMU's VM
    // generation id when a snapshot is restored (keel's kernel has VMGENID;
    // QEMU has no such device for arm64).
    if arch == Arch::X86_64 && !types.iter().any(|t| t == "vmgenid") {
        missing.push("vmgenid".into());
    }
    let commands = names(&answers.commands, "name");
    for command in FLOOR_COMMANDS {
        if !commands.iter().any(|c| c == command) {
            missing.push(format!("QMP {command}"));
        }
    }
    let mut versioned: Vec<(u32, u32, String)> = names(&answers.machines, "name")
        .into_iter()
        .filter_map(|name| {
            let (major, minor) = name.strip_prefix(arch.family())?.split_once('.')?;
            Some((major.parse().ok()?, minor.parse().ok()?, name))
        })
        .collect();
    versioned.sort_by(|a, b| (b.0, b.1).cmp(&(a.0, a.1)));
    if versioned.is_empty() {
        missing.push(format!("a versioned {}<x.y> machine type", arch.family()));
    }
    // An accelerator QEMU was built with is a QOM type `<name>-accel`.
    if !types
        .iter()
        .any(|t| *t == format!("{}-accel", accel.name()))
    {
        missing.push(format!("accelerator {}", accel.name()));
    }
    Floor {
        version,
        machine_types: versioned.into_iter().map(|(_, _, name)| name).collect(),
        missing,
    }
}

/// One QMP connection: a greeting, `qmp_capabilities`, then commands.
pub struct Qmp {
    reader: BufReader<OwnedReadHalf>,
    writer: OwnedWriteHalf,
}

impl Qmp {
    /// Connects to `path`, trying until `wait` has passed (QEMU creates the
    /// socket shortly after it starts).
    pub async fn open(path: &Path, wait: Duration) -> Result<Self> {
        let deadline = Instant::now() + wait;
        let stream = loop {
            match UnixStream::connect(path).await {
                Ok(stream) => break stream,
                Err(_) if Instant::now() < deadline => {
                    tokio::time::sleep(Duration::from_millis(10)).await
                }
                Err(error) => {
                    return Err(error).with_context(|| format!("connect {}", path.display()));
                }
            }
        };
        let (read, writer) = stream.into_split();
        let mut qmp = Self {
            reader: BufReader::new(read),
            writer,
        };
        let greeting = qmp.line().await?;
        ensure!(
            greeting.get("QMP").is_some(),
            "not a QMP greeting: {greeting}"
        );
        qmp.execute("qmp_capabilities", Value::Null).await?;
        Ok(qmp)
    }

    async fn line(&mut self) -> Result<Value> {
        let mut line = String::new();
        let read = tokio::time::timeout(QMP_TIMEOUT, self.reader.read_line(&mut line))
            .await
            .context("QMP did not answer")??;
        ensure!(read > 0, "QMP closed");
        Ok(serde_json::from_str(&line)?)
    }

    /// The next event, however long it takes (a connection kept for events).
    pub async fn event(&mut self) -> Result<Value> {
        loop {
            let mut line = String::new();
            let read = self.reader.read_line(&mut line).await?;
            ensure!(read > 0, "QMP closed");
            let message: Value = serde_json::from_str(&line)?;
            if message.get("event").is_some() {
                return Ok(message);
            }
        }
    }

    /// The command's `return`, or its `error` as an error.
    pub async fn execute(&mut self, command: &str, arguments: Value) -> Result<Value> {
        let message = if arguments.is_null() {
            json!({ "execute": command })
        } else {
            json!({ "execute": command, "arguments": arguments })
        };
        self.writer
            .write_all(format!("{message}\n").as_bytes())
            .await?;
        loop {
            let answer = self.line().await?;
            if answer.get("event").is_some() {
                continue;
            }
            if let Some(error) = answer.get("error") {
                bail!("{command}: {}", error["desc"].as_str().unwrap_or("error"));
            }
            return Ok(answer["return"].clone());
        }
    }
}

const QMP_TIMEOUT: Duration = Duration::from_secs(10);

/// Starts `qemu` with `-machine none` and asks it what the floor needs.
pub async fn probe(qemu: &Path, socket: &Path) -> Result<Answers> {
    let _ = std::fs::remove_file(socket);
    let mut child = Command::new(qemu)
        .args([
            "-machine",
            "none",
            "-S",
            "-nodefaults",
            "-no-user-config",
            "-display",
            "none",
            "-qmp",
        ])
        .arg(format!("unix:{},server=on,wait=off", socket.display()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("start {}", qemu.display()))?;
    let answers = async {
        let mut qmp = Qmp::open(socket, Duration::from_secs(10)).await?;
        let types = qmp.execute("qom-list-types", Value::Null).await?;
        let balloon = if names(&types, "name")
            .iter()
            .any(|t| t == "virtio-balloon-pci")
        {
            qmp.execute(
                "device-list-properties",
                json!({ "typename": "virtio-balloon-pci" }),
            )
            .await?
        } else {
            Value::Array(vec![])
        };
        let cpr_reboot = qmp
            .execute("migrate-set-parameters", json!({ "mode": "cpr-reboot" }))
            .await
            .is_ok();
        Ok::<_, anyhow::Error>(Answers {
            version: qmp.execute("query-version", Value::Null).await?,
            types,
            balloon_properties: balloon,
            capabilities: qmp
                .execute("query-migrate-capabilities", Value::Null)
                .await?,
            cpr_reboot,
            commands: qmp.execute("query-commands", Value::Null).await?,
            machines: qmp.execute("query-machines", Value::Null).await?,
        })
    }
    .await;
    let _ = child.kill().await;
    let _ = std::fs::remove_file(socket);
    answers.with_context(|| format!("{} did not answer QMP on -machine none", qemu.display()))
}

/// Everything one boot of a machine needs.
pub struct Launch<'a> {
    pub arch: Arch,
    pub accel: Accel,
    pub machine_type: &'a str,
    pub vcpus: u32,
    pub memory_mib: u32,
    pub kernel: &'a Path,
    pub base: &'a Path,
    /// The machine's directory: layers.vmdk, rw.qcow2, the sockets and the
    /// console.
    pub dir: &'a Path,
}

pub const QMP_SOCKET: &str = "qmp.sock";
/// A second QMP monitor, for the runner's event reader alone (QMP serves
/// one client per socket at a time).
pub const EVENTS_SOCKET: &str = "qev.sock";
pub const CHANNEL_SOCKET: &str = "ctl.sock";
/// The `cube.0` port's device id, as QMP's VSERPORT_CHANGE names it.
pub const PORT_ID: &str = "cube0";
pub const CONSOLE: &str = "console.log";

/// keel's QEMU arguments (docs/plans/2026-10-10-vm-base-and-image-layers.md,
/// "Target layout"): vda the base read-only, vdb the layer disk read-only
/// (its layer files are read-only cache files, keel-layers' H4), vdc the
/// machine's writable disk, `cube.0` on `ctl.sock`. No network device yet.
pub fn argv(launch: &Launch) -> Vec<String> {
    let dir = launch.dir;
    let path = |name: &str| dir.join(name).display().to_string();
    let mut args: Vec<String> = vec![
        "-machine".into(),
        format!("{},accel={}", launch.machine_type, launch.accel.name()),
        "-cpu".into(),
        (if launch.accel == Accel::Tcg {
            "max"
        } else {
            "host"
        })
        .into(),
        "-smp".into(),
        launch.vcpus.to_string(),
        "-m".into(),
        launch.memory_mib.to_string(),
        "-nodefaults".into(),
        "-no-user-config".into(),
        "-display".into(),
        "none".into(),
        "-no-reboot".into(),
        "-kernel".into(),
        launch.kernel.display().to_string(),
        "-append".into(),
        format!(
            "console={} root=/dev/vda ro rootfstype=erofs init=/sbin/cube-init quiet panic=-1",
            launch.arch.console()
        ),
        "-drive".into(),
        format!(
            "if=virtio,format=raw,readonly=on,file={}",
            launch.base.display()
        ),
        "-drive".into(),
        format!(
            "if=virtio,format=vmdk,readonly=on,file={}",
            path(keel_layers::disk::DESCRIPTOR)
        ),
        "-drive".into(),
        format!(
            "if=virtio,format=qcow2,discard=unmap,file={}",
            path(RW_DISK)
        ),
        "-device".into(),
        "virtio-serial-pci".into(),
        "-chardev".into(),
        format!(
            "socket,id=ctl,path={},server=on,wait=off",
            path(CHANNEL_SOCKET)
        ),
        "-device".into(),
        format!("virtserialport,chardev=ctl,name=cube.0,id={PORT_ID}"),
        "-device".into(),
        "virtio-rtc-pci".into(),
        "-device".into(),
        "virtio-balloon-pci,free-page-reporting=on".into(),
        "-serial".into(),
        format!("file:{}", path(CONSOLE)),
        "-qmp".into(),
        format!("unix:{},server=on,wait=off", path(QMP_SOCKET)),
        "-qmp".into(),
        format!("unix:{},server=on,wait=off", path(EVENTS_SOCKET)),
    ];
    if launch.arch == Arch::X86_64 {
        // A new generation id every time QEMU starts, so also in a restore.
        args.extend(["-device".into(), "vmgenid,guid=auto".into()]);
    }
    if cfg!(target_os = "linux") {
        args.extend(["-sandbox".into(), "on".into()]);
    }
    args
}

pub const RW_DISK: &str = "rw.qcow2";

/// The keel release a runner boots: `vmlinuz` and `base.erofs` in one
/// directory (`packages/keel/out/<arch>` of a build).
pub struct Keel {
    pub kernel: PathBuf,
    pub base: PathBuf,
    pub kernel_sha256: String,
    pub base_sha256: String,
}

impl Keel {
    pub fn open(dir: &Path) -> Result<Self> {
        let kernel = dir.join("vmlinuz");
        let base = dir.join("base.erofs");
        for file in [&kernel, &base] {
            ensure!(
                file.is_file(),
                "--keel {}: no {} (a keel build's out/<arch> directory)",
                dir.display(),
                file.file_name().unwrap().to_string_lossy()
            );
        }
        Ok(Self {
            kernel_sha256: sha256_file(&kernel)?,
            base_sha256: sha256_file(&base)?,
            kernel,
            base,
        })
    }
}

pub fn sha256_file(path: &Path) -> Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path).with_context(|| format!("read {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}

/// `qemu-img create -f qcow2 FILE SIZEG`, with the binary given by path.
pub async fn create_disk(qemu_img: &Path, file: &Path, gib: u32) -> Result<()> {
    let output = Command::new(qemu_img)
        .args(["create", "-q", "-f", "qcow2"])
        .arg(file)
        .arg(format!("{gib}G"))
        .stdin(Stdio::null())
        .output()
        .await
        .with_context(|| format!("start {}", qemu_img.display()))?;
    if !output.status.success() {
        return Err(anyhow!(
            "qemu-img create failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(key: &str, items: &[&str]) -> Value {
        Value::Array(items.iter().map(|item| json!({ key: item })).collect())
    }

    /// What QEMU 11.1.2 answers on x86_64 (trimmed to what the floor reads).
    fn qemu_11_1_2() -> Answers {
        Answers {
            version: json!({"qemu": {"major": 11, "minor": 1, "micro": 2}, "package": ""}),
            types: list(
                "name",
                &[
                    "virtio-rtc-pci",
                    "virtio-serial-pci",
                    "virtserialport",
                    "virtio-balloon-pci",
                    "virtio-blk-pci",
                    "vmgenid",
                    "kvm-accel",
                    "tcg-accel",
                ],
            ),
            balloon_properties: list("name", &["deflate-on-oom", "free-page-reporting"]),
            capabilities: list("capability", &["xbzrle", "mapped-ram", "multifd"]),
            cpr_reboot: true,
            commands: list(
                "name",
                &[
                    "migrate",
                    "migrate-incoming",
                    "migrate-set-capabilities",
                    "migrate-set-parameters",
                    "query-migrate",
                    "query-status",
                    "quit",
                ],
            ),
            machines: list(
                "name",
                &[
                    "pc-q35-10.2",
                    "pc-q35-11.1",
                    "pc-q35-9.0",
                    "q35",
                    "pc-i440fx-11.1",
                    "none",
                ],
            ),
        }
    }

    /// What QEMU 8.2.2 (Ubuntu 24.04's, server1's system QEMU) answers: no
    /// virtio-rtc, no mapped-ram (9.0); cpr-reboot exists since 8.2.
    fn qemu_8_2_2() -> Answers {
        Answers {
            version: json!({"qemu": {"major": 8, "minor": 2, "micro": 2}}),
            types: list(
                "name",
                &[
                    "virtio-serial-pci",
                    "virtserialport",
                    "virtio-balloon-pci",
                    "vmgenid",
                    "kvm-accel",
                ],
            ),
            balloon_properties: list("name", &["free-page-reporting"]),
            capabilities: list("capability", &["xbzrle", "multifd"]),
            cpr_reboot: true,
            machines: list("name", &["pc-q35-8.2", "pc-q35-8.1", "q35"]),
            ..qemu_11_1_2()
        }
    }

    #[test]
    fn qemu_11_1_2_meets_the_floor_and_pins_its_newest_machine_type() {
        let floor = evaluate(&qemu_11_1_2(), Arch::X86_64, Accel::Kvm);
        assert_eq!(floor.version, "11.1.2");
        assert_eq!(floor.missing, Vec::<String>::new());
        assert_eq!(floor.newest_machine_type(), Some("pc-q35-11.1"));
        assert_eq!(
            floor.machine_types,
            ["pc-q35-11.1", "pc-q35-10.2", "pc-q35-9.0"]
        );
    }

    #[test]
    fn qemu_8_2_2_is_refused_for_virtio_rtc_and_mapped_ram() {
        let floor = evaluate(&qemu_8_2_2(), Arch::X86_64, Accel::Kvm);
        assert_eq!(floor.version, "8.2.2");
        assert_eq!(
            floor.missing,
            ["virtio-rtc-pci", "migrate capability mapped-ram"]
        );
    }

    #[test]
    fn each_part_of_the_floor_is_checked() {
        let answers = Answers {
            balloon_properties: list("name", &["deflate-on-oom"]),
            cpr_reboot: false,
            commands: list("name", &["migrate", "query-status"]),
            machines: list("name", &["q35", "pc-i440fx-11.1", "virt-11.1"]),
            types: list(
                "name",
                &[
                    "virtio-rtc-pci",
                    "virtio-serial-pci",
                    "virtserialport",
                    "virtio-balloon-pci",
                    "tcg-accel",
                ],
            ),
            ..qemu_11_1_2()
        };
        assert_eq!(
            evaluate(&answers, Arch::X86_64, Accel::Kvm).missing,
            [
                "virtio-balloon-pci free-page-reporting",
                "migrate mode cpr-reboot",
                "vmgenid",
                "QMP migrate-incoming",
                "QMP migrate-set-capabilities",
                "QMP migrate-set-parameters",
                "QMP query-migrate",
                "a versioned pc-q35-<x.y> machine type",
                "accelerator kvm",
            ]
        );
        // The same QEMU's virt-11.1 is the arm64 family.
        let arm = evaluate(&answers, Arch::Aarch64, Accel::Tcg);
        assert_eq!(arm.machine_types, ["virt-11.1"]);
        assert!(
            !arm.missing.iter().any(|m| m == "vmgenid"),
            "arm64 has no vmgenid device: {:?}",
            arm.missing
        );
    }

    #[test]
    fn keel_arguments_pin_the_machine_type_and_keep_vda_and_vdb_read_only() {
        let dir = Path::new("/r/0123456789abcdef");
        let args = argv(&Launch {
            arch: Arch::X86_64,
            accel: Accel::Kvm,
            machine_type: "pc-q35-10.2",
            vcpus: 2,
            memory_mib: 1024,
            kernel: Path::new("/k/vmlinuz"),
            base: Path::new("/k/base.erofs"),
            dir,
        });
        let after = |flag: &str| -> Vec<&str> {
            args.windows(2)
                .filter(|pair| pair[0] == flag)
                .map(|pair| pair[1].as_str())
                .collect()
        };
        assert_eq!(after("-machine"), ["pc-q35-10.2,accel=kvm"]);
        assert_eq!(after("-cpu"), ["host"]);
        assert_eq!(
            after("-drive"),
            [
                "if=virtio,format=raw,readonly=on,file=/k/base.erofs",
                "if=virtio,format=vmdk,readonly=on,file=/r/0123456789abcdef/layers.vmdk",
                "if=virtio,format=qcow2,discard=unmap,file=/r/0123456789abcdef/rw.qcow2",
            ]
        );
        assert!(after("-device").contains(&"virtserialport,chardev=ctl,name=cube.0,id=cube0"));
        assert!(
            after("-device").contains(&"vmgenid,guid=auto"),
            "x86-64 restores reseed"
        );
        assert_eq!(
            after("-qmp"),
            [
                "unix:/r/0123456789abcdef/qmp.sock,server=on,wait=off",
                "unix:/r/0123456789abcdef/qev.sock,server=on,wait=off",
            ]
        );
        assert!(after("-device").contains(&"virtio-rtc-pci"));
        assert!(after("-device").contains(&"virtio-balloon-pci,free-page-reporting=on"));
        assert!(
            after("-append")[0]
                .contains("console=ttyS0 root=/dev/vda ro rootfstype=erofs init=/sbin/cube-init")
        );
        assert!(
            args.iter().all(|arg| !arg.starts_with("-netdev")),
            "no network until B-4"
        );
        assert_eq!(
            args.contains(&"-sandbox".to_string()),
            cfg!(target_os = "linux")
        );
    }
}
