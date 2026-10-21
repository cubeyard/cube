//! berth: cube's runner on runner protocol 4 (`cubeyard/runner/4`). Two
//! modes: `berth vm`, whose machines are keel guests under QEMU, and `berth
//! host`, whose machines are directories on the host it runs on, unsandboxed,
//! for developing and debugging runners. Key files hold secrets; stdout and
//! stderr show only public identities and addresses.
mod debian;
mod host;
mod image;
mod serve;
mod served;
mod vm;

use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use iroh::{Endpoint, EndpointId, SecretKey, endpoint::presets};
use serde::{Deserialize, Serialize};

pub const SOFTWARE_VERSION: &str = env!("CARGO_PKG_VERSION");
const RELAY_READY_TIMEOUT: Duration = Duration::from_secs(20);
/// The layer cache's limit unless `--layer-cache-gib` says (masterplan B-7
/// D2); layers machines use are kept beyond it.
const DEFAULT_LAYER_CACHE_GIB: u64 = 16;
const MAX_LAYER_CACHE_GIB: u64 = 1 << 20;

const USAGE: &str = "usage:
  berth vm --dir <directory> --qemu <qemu-system binary> --qemu-img <qemu-img binary> --keel <directory with vmlinuz and base.erofs> --mkfs-erofs <mkfs.erofs binary> [--image default|<registry/repository@sha256:digest>] [--change-image] [--layer-cache-gib 16] [--accel kvm|hvf|tcg] [--allow-peer <public-key> --node-id <node-id>] [--network loopback|direct|relay [--relay-only]] [--listen <ip:port>] [--max-machines 8] [--labels k=v,...] [--suspend-disk-margin-gib <GiB>]
      each machine is a keel guest under the QEMU given by path, which must meet keel's QEMU floor,
      built on the image, which berth pulls into <directory> before it listens if any of it is missing;
      without --image (or with default) cube's default image, official Debian trixie pinned by digest, which berth
      prepares for cube with a layer of pinned Debian packages (sudo, git, gh, curl, ca-certificates, openssh-client); any other image
      is the operator's and must bring bash, sudo, flock, git, gh, curl and a CA bundle itself;
      a directory that served an image of the operator's own keeps it: without --image berth refuses to start there
      unless --change-image says to move it to the default (machines keep their layers; nothing is deleted);
      the layer cache keeps at most --layer-cache-gib (kept in .berth/vm.json) besides the layers machines use;
      machine_suspend is on only with --suspend-disk-margin-gib (no default): a machine is saved only while the disk
      keeps its memory and that many GiB besides
  berth host --dir <directory> [--allow-peer <public-key> --node-id <node-id>] [--network loopback|direct|relay [--relay-only]] [--listen <ip:port>] [--python python3] [--max-machines 8] [--labels k=v,...]
      UNSANDBOXED: each machine is a subdirectory of <directory>; commands run as you, with your logins
  berth image pull --dir <directory> --mkfs-erofs <mkfs.erofs binary> [--image default|<registry/repository@sha256:digest>]
      fetches a public image for this runner's platform, checks every blob, converts its layers into <directory>'s layer cache
      (and for cube's default image builds its preparation layer there)
      (berth vm does this itself; by hand only while berth is stopped)
  berth image check --dir <directory> [--image default|<registry/repository@sha256:digest>] [--change-image]
      whether berth vm would start there with that image (an operator's own image is not left without --image);
      with --change-image, records the move, so later starts need no flag (while berth is stopped)
  berth keygen --key <new-private-file>     a control key for cubed (prints its public key)
  berth version";

const HOST_WARNING: &str = "UNSANDBOXED: threads routed to this runner run commands as you, on this host, with your files, network and logins (gh, git, ssh). Use it only to develop and debug cube runners.";

/// loopback (default) and direct listen at an address; relay uses Iroh's N0
/// discovery and relays, and with `--relay-only` no IP transport, so every
/// connection stays on the relay.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum NetworkMode {
    #[default]
    Loopback,
    Direct,
    Relay,
}

impl NetworkMode {
    fn name(self) -> &'static str {
        match self {
            Self::Loopback => "loopback",
            Self::Direct => "direct",
            Self::Relay => "relay",
        }
    }
}

/// `DIRECTORY/.berth/host.json` or `vm.json`: written by the first run of
/// the mode; a directory serves one mode only.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostHome {
    version: u32,
    node_id: String,
    allowed_peer: String,
    network: NetworkMode,
    listen: Option<String>,
    labels: BTreeMap<String, String>,
    /// `berth vm` only: the layer cache's limit, set with
    /// `--layer-cache-gib`; absent means DEFAULT_LAYER_CACHE_GIB.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    layer_cache_gib: Option<u64>,
    /// `--relay-only`, with `network: relay` only; absent means false.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    relay_only: bool,
}

fn read_key(path: &Path) -> Result<SecretKey> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .context("open private key")?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.mode() & 0o077 == 0 && metadata.nlink() == 1,
        "private key must be a regular, single-link, owner-only file"
    );
    ensure!(metadata.len() == 32, "invalid private key length");
    let mut bytes = [0u8; 32];
    file.read_exact(&mut bytes)?;
    Ok(SecretKey::from_bytes(&bytes))
}

/// Never overwrites a key or follows a symlink.
fn keygen(path: &Path) -> Result<SecretKey> {
    use std::os::unix::fs::OpenOptionsExt;
    let key = SecretKey::generate();
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(&key.to_bytes())?;
    file.sync_all()?;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    File::open(parent)?.sync_all()?;
    Ok(key)
}

fn validate_node_id(node_id: &str) -> Result<()> {
    ensure!(
        node_id.starts_with("node-")
            && (6..=128).contains(&node_id.len())
            && node_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-'),
        "--node-id must start with node- and contain letters, digits and dashes only"
    );
    Ok(())
}

/// Relay mode: the N0 preset's relays and address lookup, and with
/// `relay_only` none of its IP transports, so no direct path can form.
fn relay_builder(key: SecretKey, relay_only: bool) -> iroh::endpoint::Builder {
    let builder = Endpoint::builder(presets::N0)
        .secret_key(key)
        .alpns(vec![cube_runner_protocol::ALPN.to_vec()]);
    if relay_only {
        builder.clear_ip_transports()
    } else {
        builder
    }
}

/// The runner's endpoint, as its manifest says.
async fn bind_home(key: SecretKey, home: &HostHome) -> Result<Endpoint> {
    if home.relay_only {
        ensure!(
            home.network == NetworkMode::Relay,
            "--relay-only requires --network relay"
        );
        ensure!(home.listen.is_none(), "relay mode does not accept --listen");
        return relay(key, true).await;
    }
    bind(key, home.network, listen_address(home)?).await
}

async fn relay(key: SecretKey, relay_only: bool) -> Result<Endpoint> {
    let endpoint = relay_builder(key, relay_only).bind().await?;
    tokio::time::timeout(RELAY_READY_TIMEOUT, endpoint.online())
        .await
        .context("timed out connecting to an N0 relay")?;
    Ok(endpoint)
}

/// An endpoint that accepts protocol 4 only.
async fn bind(
    key: SecretKey,
    network: NetworkMode,
    listen: Option<SocketAddr>,
) -> Result<Endpoint> {
    if network == NetworkMode::Relay {
        ensure!(listen.is_none(), "relay mode does not accept --listen");
        return relay(key, false).await;
    }
    let alpns = vec![cube_runner_protocol::ALPN.to_vec()];
    let listen = match (network, listen) {
        (NetworkMode::Direct, None) => bail!("direct mode requires --listen"),
        (_, Some(listen)) => listen,
        (_, None) => "127.0.0.1:0".parse()?,
    };
    let ip = listen.ip().to_canonical();
    ensure!(
        !ip.is_unspecified() && !ip.is_multicast(),
        "--listen must name a concrete unicast interface, not a wildcard"
    );
    ensure!(
        network == NetworkMode::Direct || ip.is_loopback(),
        "a non-loopback --listen requires --network direct"
    );
    Ok(Endpoint::builder(presets::Minimal)
        .secret_key(key)
        .alpns(alpns)
        .clear_ip_transports()
        .clear_relay_transports()
        .clear_address_lookup()
        .bind_addr(listen)?
        .bind()
        .await?)
}

/// Writes the runner's manifest whole: under a temporary name, synced,
/// renamed, and the directory synced.
fn write_home(path: &Path, home: &HostHome) -> Result<()> {
    let temporary = path.with_extension("json.tmp");
    let _ = fs::remove_file(&temporary);
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(serde_json::to_string_pretty(home)?.as_bytes())?;
    file.sync_all()?;
    fs::rename(&temporary, path)?;
    File::open(path.parent().context("manifest path")?)?.sync_all()?;
    Ok(())
}

fn take(options: &mut BTreeMap<String, String>, key: &str) -> Result<String> {
    options
        .remove(key)
        .with_context(|| format!("missing {key}\n{USAGE}"))
}

/// A runner directory, locked, with its manifest and key: what both modes
/// do before they serve.
struct Prepared {
    directory: PathBuf,
    home: HostHome,
    key: SecretKey,
    max_machines: u32,
    _lock: File,
}

fn prepare(options: &mut BTreeMap<String, String>, mode: &str) -> Result<Prepared> {
    use std::os::unix::{fs::DirBuilderExt, io::AsRawFd};
    let network = match options.remove("--network").as_deref() {
        None => None,
        Some("loopback") => Some(NetworkMode::Loopback),
        Some("direct") => Some(NetworkMode::Direct),
        Some("relay") => Some(NetworkMode::Relay),
        Some(_) => bail!("--network is loopback, direct or relay"),
    };
    let directory = PathBuf::from(take(options, "--dir")?);
    ensure!(directory.is_absolute(), "--dir must be an absolute path");
    fs::create_dir_all(&directory)?;
    let directory = fs::canonicalize(&directory)?;
    let control = directory.join(".berth");
    if !control.exists() {
        fs::DirBuilder::new().mode(0o700).create(&control)?;
    }
    let lock = File::create(control.join("lock"))?;
    // SAFETY: flock on a descriptor this function owns.
    ensure!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
        "another berth {mode} runs in {}",
        directory.display()
    );
    let (home, key, max_machines) = load_home(&directory, &control, mode, network, options)?;
    Ok(Prepared {
        directory,
        home,
        key,
        max_machines,
        _lock: lock,
    })
}

/// The part of `prepare` under the lock: checks the mode, reads the manifest
/// (or makes it and the key on the first run) and the key. Apart from
/// `prepare` only for tests, which must not take, drop and take the lock
/// again in one process: a child that another thread has forked but not
/// yet exec'd holds a copy of the lock's descriptor, and with it the flock,
/// so a dropped lock can still look held for that moment.
fn load_home(
    directory: &Path,
    control: &Path,
    mode: &str,
    network: Option<NetworkMode>,
    options: &mut BTreeMap<String, String>,
) -> Result<(HostHome, SecretKey, u32)> {
    let other = if mode == "host" { "vm" } else { "host" };
    ensure!(
        !control.join(format!("{other}.json")).exists(),
        "{} is a berth {other} directory; a directory serves one mode only",
        directory.display()
    );
    let manifest = control.join(format!("{mode}.json"));
    let allow = options.remove("--allow-peer");
    let node = options.remove("--node-id");
    let listen = options.remove("--listen");
    let labels = options.remove("--labels");
    let relay_only = options.remove("--relay-only").is_some();
    ensure!(
        !relay_only || network == Some(NetworkMode::Relay),
        "--relay-only requires --network relay"
    );
    let max_machines: u32 = options
        .remove("--max-machines")
        .map_or(Ok(8), |value| value.parse())
        .context("--max-machines must be a number")?;
    ensure!(
        (1..=64).contains(&max_machines),
        "--max-machines must be 1 through 64"
    );
    let layer_cache_gib = match mode {
        "vm" => options
            .remove("--layer-cache-gib")
            .map(|value| {
                value
                    .parse::<u64>()
                    .ok()
                    .filter(|gib| *gib <= MAX_LAYER_CACHE_GIB)
                    .with_context(|| {
                        format!(
                            "--layer-cache-gib is a number of GiB, 0 through {MAX_LAYER_CACHE_GIB}"
                        )
                    })
            })
            .transpose()?,
        _ => None,
    };
    let home = if manifest.exists() {
        let home: HostHome = serde_json::from_slice(&fs::read(&manifest)?)?;
        ensure!(
            home.version == 1,
            "unsupported berth version in {}",
            manifest.display()
        );
        ensure!(
            allow
                .as_deref()
                .is_none_or(|peer| peer == home.allowed_peer)
                && node.as_deref().is_none_or(|node| node == home.node_id)
                && labels.is_none(),
            "{} already names this runner's control peer, node id and labels; a runner is never rebound",
            manifest.display()
        );
        // --relay-only goes with --network: a start that names a network
        // names relay-only too, and like the network it is not kept.
        let home = HostHome {
            network: network.unwrap_or(home.network),
            relay_only: if network.is_some() {
                relay_only
            } else {
                home.relay_only
            },
            listen: listen.or(home.listen),
            ..home
        };
        ensure!(
            !home.relay_only || home.network == NetworkMode::Relay,
            "{} has relayOnly without network relay",
            manifest.display()
        );
        // The cache limit is the one setting a later start may change, and
        // it stays changed.
        match layer_cache_gib {
            Some(gib) if home.layer_cache_gib != Some(gib) => {
                let mut stored: HostHome = serde_json::from_slice(&fs::read(&manifest)?)?;
                stored.layer_cache_gib = Some(gib);
                write_home(&manifest, &stored)?;
                HostHome {
                    layer_cache_gib: Some(gib),
                    ..home
                }
            }
            _ => home,
        }
    } else {
        let allowed_peer = allow
            .context("the first run needs --allow-peer (cubed's control key) and --node-id")?;
        let node_id = node.context("the first run needs --node-id")?;
        validate_node_id(&node_id)?;
        let _: EndpointId = allowed_peer
            .parse()
            .context("--allow-peer must be a public key")?;
        let mut parsed = BTreeMap::new();
        for pair in labels
            .iter()
            .flat_map(|labels| labels.split(','))
            .filter(|pair| !pair.is_empty())
        {
            let (key, value) = pair.split_once('=').context("--labels is k=v,k=v")?;
            parsed.insert(key.to_owned(), value.to_owned());
        }
        let home = HostHome {
            version: 1,
            node_id,
            allowed_peer,
            network: network.unwrap_or_default(),
            listen,
            labels: parsed,
            layer_cache_gib: match mode {
                "vm" => Some(layer_cache_gib.unwrap_or(DEFAULT_LAYER_CACHE_GIB)),
                _ => None,
            },
            relay_only,
        };
        keygen(&control.join("runner.key"))?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&manifest)?;
        file.write_all(serde_json::to_string_pretty(&home)?.as_bytes())?;
        file.sync_all()?;
        home
    };
    let key = read_key(&control.join("runner.key"))?;
    Ok((home, key, max_machines))
}

fn listen_address(home: &HostHome) -> Result<Option<SocketAddr>> {
    Ok(home
        .listen
        .as_deref()
        .map(str::parse::<SocketAddr>)
        .transpose()?)
}

fn print_endpoint(endpoint: &Endpoint, directory: &Path, home: &HostHome) {
    eprintln!("dir: {}", directory.display());
    eprintln!("node: {}", home.node_id);
    eprintln!("peer: {}", endpoint.id());
    eprintln!("control peer: {}", home.allowed_peer);
    if home.relay_only {
        eprintln!("network: {} (relay-only)", home.network.name());
    } else {
        eprintln!("network: {}", home.network.name());
    }
    let addresses = endpoint
        .addr()
        .ip_addrs()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    if !addresses.is_empty() {
        eprintln!("listen: {addresses}");
    }
}

async fn host(mut options: BTreeMap<String, String>) -> Result<()> {
    let python = options
        .remove("--python")
        .unwrap_or_else(|| "python3".into());
    let Prepared {
        directory,
        home,
        key,
        max_machines,
        _lock,
    } = prepare(&mut options, "host")?;
    ensure!(options.is_empty(), "unknown options\n{USAGE}");
    let python_ok = std::process::Command::new(&python)
        .args([
            "-c",
            "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)",
        ])
        .status()
        .is_ok_and(|status| status.success());
    ensure!(
        python_ok,
        "{python} (Python 3.8 or newer) is needed to run the guest helper; pass --python"
    );
    let allowed: EndpointId = home.allowed_peer.parse()?;
    let runner = host::HostRunner::open(host::HostOptions {
        directory: directory.clone(),
        node_id: home.node_id.clone(),
        python,
        network: home.network.name().into(),
        max_machines,
        labels: home.labels.clone(),
    })?;
    let endpoint = bind_home(key, &home).await?;
    eprintln!(
        "berth {SOFTWARE_VERSION} host (runner protocol {})",
        cube_runner_protocol::PROTOCOL
    );
    eprintln!("{HOST_WARNING}");
    print_endpoint(&endpoint, &directory, &home);
    eprintln!(
        "machines: {} (at most {max_machines} at once)",
        runner.machine_count()
    );
    eprintln!("waiting for cubed; Ctrl-C stops the runner (commands it started keep running)");
    use tokio::signal::unix::{SignalKind, signal};
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    let result = tokio::select! {
        result = serve::serve(&endpoint, allowed, runner) => result,
        _ = interrupt.recv() => Ok(()),
        _ = terminate.recv() => Ok(()),
    };
    endpoint.close().await;
    eprintln!("stopped");
    result
}

/// An absolute path to an existing file, given by the operator: berth never
/// searches for QEMU or its tools (`PATH`, Homebrew, home directories).
fn given_file(options: &mut BTreeMap<String, String>, key: &str) -> Result<PathBuf> {
    let value = options.remove(key).with_context(|| {
        format!(
            "berth vm needs {key}: QEMU and its tools are given by path, never searched for\n{USAGE}"
        )
    })?;
    let path = PathBuf::from(&value);
    ensure!(
        path.is_absolute(),
        "{key} must be an absolute path, not {value}"
    );
    ensure!(path.is_file(), "{key} {value} is not a file");
    Ok(path)
}

struct Stderr;
impl image::Progress for Stderr {
    fn line(&self, text: &str) {
        eprintln!("{text}");
    }
}

/// SIGINT and SIGTERM, taken once for the whole run: once tokio has a
/// handler, a signal no one waits for is kept for the next wait rather
/// than ending the process.
struct Stops {
    interrupt: tokio::signal::unix::Signal,
    terminate: tokio::signal::unix::Signal,
}

impl Stops {
    fn new() -> Result<Self> {
        use tokio::signal::unix::{SignalKind, signal};
        Ok(Self {
            interrupt: signal(SignalKind::interrupt())?,
            terminate: signal(SignalKind::terminate())?,
        })
    }

    /// Whether it was SIGINT.
    async fn next(&mut self) -> bool {
        tokio::select! {
            _ = self.interrupt.recv() => true,
            _ = self.terminate.recv() => false,
        }
    }
}

/// The image `--image` names, and the word for it as given: cube's default
/// (`default`) without it or with `default`.
fn image_option(options: &mut BTreeMap<String, String>) -> Result<(image::Reference, String)> {
    match options.remove("--image").as_deref() {
        None | Some("default") => Ok((debian::default_image(), "default".into())),
        Some(text) => Ok((image::Reference::parse(text)?, text.to_owned())),
    }
}

/// Pulls `reference` into `store`, and for cube's default image builds its
/// Debian preparation layer (debian.rs), until it is done or SIGINT or
/// SIGTERM stops it: then the pull is awaited until mkfs.erofs is reaped
/// and its temporary files are gone, and it fails "cancelled".
async fn pull_until_signal(
    store: &image::Store,
    mkfs: &Path,
    reference: &image::Reference,
    time_limits: keel_layers::convert::TimeLimits,
    only_what_is_missing: bool,
    stops: &mut Stops,
) -> Result<image::ImageRecord> {
    use std::sync::{Arc, atomic::AtomicBool, atomic::Ordering};
    let cancel = Arc::new(AtomicBool::new(false));
    let mut pull = image::Pull::new(
        store,
        mkfs,
        image::Platform::native()?,
        &Stderr,
        cancel.clone(),
    );
    pull.time_limits = time_limits;
    let platform = pull.platform;
    let pull = async {
        let record = if only_what_is_missing {
            pull.ensure(reference).await
        } else {
            pull.run(reference).await
        }?;
        if let Some(plan) = debian::for_manifest(platform, &record.manifest.digest) {
            debian::Prepare {
                directory: store.directory(),
                mkfs,
                progress: &Stderr,
                cancel: cancel.clone(),
                time_limits,
                free_space: &image::free_bytes,
            }
            .ensure(plan)
            .await?;
        }
        Ok(record)
    };
    tokio::pin!(pull);
    tokio::select! {
        record = &mut pull => record,
        interrupt = stops.next() => {
            cancel.store(true, Ordering::SeqCst);
            if interrupt {
                eprintln!("stopping");
            }
            pull.await
        }
    }
}

async fn vm(mut options: BTreeMap<String, String>) -> Result<()> {
    let qemu = given_file(&mut options, "--qemu")?;
    let qemu_img = given_file(&mut options, "--qemu-img")?;
    let mkfs = given_file(&mut options, "--mkfs-erofs")?;
    let keel = PathBuf::from(take(&mut options, "--keel")?);
    ensure!(keel.is_absolute(), "--keel must be an absolute path");
    let (image, given) = image_option(&mut options)?;
    let change_image = options.remove("--change-image").is_some();
    // Before anything is written or pulled: the image this directory
    // served is not left without the operator's word (served.rs).
    if let Some(dir) = options.get("--dir").map(PathBuf::from)
        && dir.is_absolute()
    {
        served::check(&dir, &given, change_image, image::Platform::native()?)?;
    }
    let accel = match options.remove("--accel") {
        Some(accel) => vm::Accel::parse(&accel)?,
        None => vm::Accel::native(),
    };
    let suspend_disk_margin_gib = options
        .remove("--suspend-disk-margin-gib")
        .map(|value| {
            value
                .parse::<u64>()
                .ok()
                .filter(|gib| *gib <= MAX_LAYER_CACHE_GIB)
                .context("--suspend-disk-margin-gib is a number of GiB")
        })
        .transpose()?;
    let floor = vm::check_floor(&qemu, accel).await?;
    let Prepared {
        directory,
        home,
        key,
        max_machines,
        _lock,
    } = prepare(&mut options, "vm")?;
    ensure!(options.is_empty(), "unknown options\n{USAGE}");
    let allowed: EndpointId = home.allowed_peer.parse()?;
    let mkfs_version = image::mkfs_version(&mkfs)?;
    let mut stops = Stops::new()?;
    // The image before the endpoint (masterplan B-7 D1): until it is here,
    // cubed finds no runner, and its threads wait as for one that is down.
    let store = image::Store::open(&directory)?;
    pull_until_signal(
        &store,
        &mkfs,
        &image,
        image::RUNNER_TIME_LIMITS,
        true,
        &mut stops,
    )
    .await?;
    drop(store);
    let runner = vm::VmRunner::open(
        vm::VmOptions {
            directory: directory.clone(),
            node_id: home.node_id.clone(),
            network: home.network.name().into(),
            max_machines,
            labels: home.labels.clone(),
            qemu,
            qemu_img,
            keel,
            accel,
            image,
            mkfs,
            mkfs_version,
            layer_cache_bytes: home
                .layer_cache_gib
                .unwrap_or(DEFAULT_LAYER_CACHE_GIB)
                .saturating_mul(1 << 30),
            free_space: image::free_bytes,
            suspend_disk_margin_gib,
        },
        floor,
    )
    .await?;
    served::record(&directory, &given)?;
    let endpoint = bind_home(key, &home).await?;
    eprintln!(
        "berth {SOFTWARE_VERSION} vm (runner protocol {})",
        cube_runner_protocol::PROTOCOL
    );
    print_endpoint(&endpoint, &directory, &home);
    for line in runner.describe() {
        eprintln!("{line}");
    }
    eprintln!(
        "waiting for cubed; Ctrl-C stops the runner and quits its machines' QEMUs (each is marked interrupted)"
    );
    let result = tokio::select! {
        result = serve::serve(&endpoint, allowed, runner.clone()) => result,
        _ = stops.next() => Ok(()),
    };
    endpoint.close().await;
    runner.shutdown().await;
    eprintln!("stopped");
    result
}

/// `berth image pull`: under the runner directory's lock, so never while
/// `berth vm` or another pull uses the directory.
async fn image_pull(mut options: BTreeMap<String, String>) -> Result<()> {
    use std::os::unix::{fs::DirBuilderExt, io::AsRawFd};
    let mkfs = given_file(&mut options, "--mkfs-erofs")?;
    let (reference, _) = image_option(&mut options)?;
    let directory = PathBuf::from(take(&mut options, "--dir")?);
    ensure!(options.is_empty(), "unknown options\n{USAGE}");
    ensure!(directory.is_absolute(), "--dir must be an absolute path");
    fs::create_dir_all(&directory)?;
    let directory = fs::canonicalize(&directory)?;
    let control = directory.join(".berth");
    if !control.exists() {
        fs::DirBuilder::new().mode(0o700).create(&control)?;
    }
    ensure!(
        !control.join("host.json").exists(),
        "{} is a berth host directory; images are for berth vm",
        directory.display()
    );
    let lock = File::create(control.join("lock"))?;
    // SAFETY: flock on a descriptor this function owns.
    ensure!(
        unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
        "berth runs in {}; pull while it is stopped",
        directory.display()
    );
    let store = image::Store::open(&directory)?;
    let record = pull_until_signal(
        &store,
        &mkfs,
        &reference,
        keel_layers::convert::TimeLimits::default(),
        false,
        &mut Stops::new()?,
    )
    .await?;
    eprintln!("record: {}", store.record_path(&reference.digest).display());
    println!("{}", serde_json::to_string_pretty(&record)?);
    Ok(())
}

/// `berth image check`: whether `berth vm` would start in `--dir` with that
/// `--image` (served.rs); with `--change-image`, the move recorded, under the
/// directory's lock, so the next starts need no flag.
fn image_check(mut options: BTreeMap<String, String>) -> Result<()> {
    use std::os::unix::io::AsRawFd;
    let (_, given) = image_option(&mut options)?;
    let change = options.remove("--change-image").is_some();
    let directory = PathBuf::from(take(&mut options, "--dir")?);
    ensure!(options.is_empty(), "unknown options\n{USAGE}");
    ensure!(directory.is_absolute(), "--dir must be an absolute path");
    let platform = image::Platform::native()?;
    served::check(&directory, &given, change, platform)?;
    let control = directory.join(".berth");
    if change && control.is_dir() {
        let lock = File::create(control.join("lock"))?;
        // SAFETY: flock on a descriptor this function owns.
        ensure!(
            unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0,
            "berth runs in {}; record the move while it is stopped",
            directory.display()
        );
        served::record(&directory, &given)?;
        println!(
            "{} serves {given} from its next start (recorded)",
            directory.display()
        );
    } else {
        println!("{} may serve {given}", directory.display());
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let mut command = args.next().context(USAGE)?;
    if command == "image" {
        command.push(' ');
        command.push_str(&args.next().context(USAGE)?);
    }
    let mut options = BTreeMap::new();
    while let Some(key) = args.next() {
        ensure!(key.starts_with("--"), "{USAGE}");
        // The options without a value.
        let value = if key == "--relay-only" || key == "--change-image" {
            String::new()
        } else {
            args.next().context(USAGE)?
        };
        ensure!(options.insert(key, value).is_none(), "duplicate option");
    }
    match command.as_str() {
        "host" => host(options).await,
        "vm" => vm(options).await,
        "image pull" => image_pull(options).await,
        "image check" => image_check(options),
        "keygen" => {
            let path = PathBuf::from(take(&mut options, "--key")?);
            ensure!(options.is_empty(), "unknown options\n{USAGE}");
            let key = keygen(&path)?;
            println!(
                "{}",
                serde_json::json!({ "peerId": key.public().to_string() })
            );
            Ok(())
        }
        "version" => {
            println!(
                "{}",
                serde_json::json!({ "softwareVersion": SOFTWARE_VERSION, "protocolVersion": cube_runner_protocol::PROTOCOL })
            );
            Ok(())
        }
        "help" | "--help" => {
            println!("{USAGE}");
            Ok(())
        }
        _ => bail!("{USAGE}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::io::AsRawFd;

    fn options(directory: &Path, extra: &[(&str, &str)]) -> BTreeMap<String, String> {
        let mut options = BTreeMap::from([("--dir".to_owned(), directory.display().to_string())]);
        for (key, value) in extra {
            options.insert((*key).to_owned(), (*value).to_owned());
        }
        options
    }

    fn stored(directory: &Path, mode: &str) -> serde_json::Value {
        serde_json::from_slice(&fs::read(directory.join(format!(".berth/{mode}.json"))).unwrap())
            .unwrap()
    }

    /// A later start of the runner in `prepared`'s directory, under the lock
    /// `prepared` still holds (the lock is never dropped and taken again in
    /// this process; see `load_home`).
    fn later(
        prepared: &Prepared,
        network: Option<NetworkMode>,
        extra: &[(&str, &str)],
    ) -> Result<HostHome> {
        let mut options: BTreeMap<String, String> = extra
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        let (home, _, _) = load_home(
            &prepared.directory,
            &prepared.directory.join(".berth"),
            "vm",
            network,
            &mut options,
        )?;
        assert!(options.is_empty(), "{options:?}");
        Ok(home)
    }

    #[test]
    fn the_runner_lock_refuses_a_second_runner_and_is_closed_on_exec() {
        let directory = tempfile::tempdir().unwrap();
        let peer = SecretKey::generate().public().to_string();
        let first = [("--allow-peer", peer.as_str()), ("--node-id", "node-test")];
        let prepared = prepare(&mut options(directory.path(), &first), "vm").unwrap();
        // A second berth (or a pull) is refused while the first runs.
        let error = prepare(&mut options(directory.path(), &[]), "vm")
            .err()
            .unwrap();
        assert!(
            error.to_string().contains("another berth vm runs"),
            "{error}"
        );
        // The programs the runner starts (QEMU, mkfs.erofs) never keep it:
        // the descriptor closes when they exec.
        // SAFETY: F_GETFD on a descriptor `prepared` owns.
        let flags = unsafe { libc::fcntl(prepared._lock.as_raw_fd(), libc::F_GETFD) };
        assert!(flags >= 0 && flags & libc::FD_CLOEXEC != 0, "{flags}");
    }

    #[test]
    fn the_layer_cache_limit_is_16_gib_kept_in_vm_json_and_changed_by_the_flag() {
        let directory = tempfile::tempdir().unwrap();
        let peer = SecretKey::generate().public().to_string();
        let first = [("--allow-peer", peer.as_str()), ("--node-id", "node-test")];
        let prepared = prepare(&mut options(directory.path(), &first), "vm").unwrap();
        assert_eq!(prepared.home.layer_cache_gib, Some(DEFAULT_LAYER_CACHE_GIB));
        assert_eq!(stored(directory.path(), "vm")["layerCacheGib"], 16);

        // A later start with the flag (and a network override) keeps the
        // limit, and only the limit.
        let home = later(
            &prepared,
            Some(NetworkMode::Direct),
            &[("--layer-cache-gib", "4")],
        )
        .unwrap();
        assert_eq!(home.layer_cache_gib, Some(4));
        assert_eq!(home.network, NetworkMode::Direct);
        let manifest = stored(directory.path(), "vm");
        assert_eq!(manifest["layerCacheGib"], 4);
        assert_eq!(manifest["network"], "loopback", "an override is not kept");
        assert_eq!(manifest["allowedPeer"], peer.as_str());
        assert!(!directory.path().join(".berth/vm.json.tmp").exists());

        // Without the flag, the stored limit stays.
        assert_eq!(
            later(&prepared, None, &[]).unwrap().layer_cache_gib,
            Some(4)
        );
        // 0 keeps only the layers in use.
        let zero = later(&prepared, None, &[("--layer-cache-gib", "0")]).unwrap();
        assert_eq!(zero.layer_cache_gib, Some(0));
        for bad in ["-1", "16GiB", "1048577"] {
            let error = later(&prepared, None, &[("--layer-cache-gib", bad)])
                .err()
                .unwrap();
            assert!(error.to_string().contains("--layer-cache-gib"), "{error}");
        }
        assert_eq!(stored(directory.path(), "vm")["layerCacheGib"], 0);
    }

    #[test]
    fn a_vm_json_from_before_b7_reads_as_16_gib_and_a_host_has_no_limit() {
        let directory = tempfile::tempdir().unwrap();
        let peer = SecretKey::generate().public().to_string();
        let first = [("--allow-peer", peer.as_str()), ("--node-id", "node-test")];
        let prepared = prepare(&mut options(directory.path(), &first), "vm").unwrap();
        let path = directory.path().join(".berth/vm.json");
        let mut manifest = stored(directory.path(), "vm");
        manifest.as_object_mut().unwrap().remove("layerCacheGib");
        fs::write(&path, manifest.to_string()).unwrap();
        let home = later(&prepared, None, &[]).unwrap();
        assert_eq!(home.layer_cache_gib, None, "the default, 16 GiB");
        assert!(
            stored(directory.path(), "vm")
                .get("layerCacheGib")
                .is_none()
        );

        let host = tempfile::tempdir().unwrap();
        let mut flagged = options(
            host.path(),
            &[
                ("--allow-peer", peer.as_str()),
                ("--node-id", "node-test"),
                ("--layer-cache-gib", "4"),
            ],
        );
        let prepared = prepare(&mut flagged, "host").unwrap();
        assert_eq!(prepared.home.layer_cache_gib, None);
        assert!(stored(host.path(), "host").get("layerCacheGib").is_none());
        // Left for host() to refuse as an unknown option.
        assert!(flagged.contains_key("--layer-cache-gib"));
    }
    #[test]
    fn relay_only_is_refused_without_network_relay() {
        let peer = SecretKey::generate().public().to_string();
        for network in [None, Some("loopback"), Some("direct")] {
            let directory = tempfile::tempdir().unwrap();
            let mut extra = vec![
                ("--allow-peer", peer.as_str()),
                ("--node-id", "node-test"),
                ("--relay-only", ""),
            ];
            if let Some(network) = network {
                extra.push(("--network", network));
            }
            let error = prepare(&mut options(directory.path(), &extra), "vm")
                .err()
                .unwrap();
            assert!(
                error
                    .to_string()
                    .contains("--relay-only requires --network relay"),
                "{network:?}: {error}"
            );
            assert!(!directory.path().join(".berth/vm.json").exists());
        }
    }

    #[test]
    fn relay_only_is_kept_in_vm_json_and_an_old_file_reads_as_false() {
        let directory = tempfile::tempdir().unwrap();
        let peer = SecretKey::generate().public().to_string();
        let first = [
            ("--allow-peer", peer.as_str()),
            ("--node-id", "node-test"),
            ("--network", "relay"),
            ("--relay-only", ""),
        ];
        let prepared = prepare(&mut options(directory.path(), &first), "vm").unwrap();
        assert!(prepared.home.relay_only);
        let manifest = stored(directory.path(), "vm");
        assert_eq!(manifest["network"], "relay");
        assert_eq!(manifest["relayOnly"], true);

        // A later start with only --dir serves relay-only again.
        let home = later(&prepared, None, &[]).unwrap();
        assert!(home.relay_only && home.network == NetworkMode::Relay);
        // A later start that names the network names relay-only too, and
        // neither is kept.
        let home = later(&prepared, Some(NetworkMode::Relay), &[]).unwrap();
        assert!(!home.relay_only);
        let home = later(&prepared, Some(NetworkMode::Relay), &[("--relay-only", "")]).unwrap();
        assert!(home.relay_only);
        assert!(later(&prepared, None, &[("--relay-only", "")]).is_err());
        assert_eq!(stored(directory.path(), "vm")["relayOnly"], true);

        // A vm.json from before the flag (or one without it) is not relay-only.
        let path = directory.path().join(".berth/vm.json");
        let mut old = stored(directory.path(), "vm");
        old.as_object_mut().unwrap().remove("relayOnly");
        fs::write(&path, old.to_string()).unwrap();
        let home = later(&prepared, None, &[]).unwrap();
        assert!(!home.relay_only && home.network == NetworkMode::Relay);

        // A relayOnly that names another network is refused.
        let mut wrong = stored(directory.path(), "vm");
        wrong["network"] = "direct".into();
        wrong["relayOnly"] = true.into();
        fs::write(&path, wrong.to_string()).unwrap();
        assert!(later(&prepared, None, &[]).is_err());

        // A runner that is not relay-only writes no relayOnly, so a berth
        // from before the flag still reads its file.
        let plain = tempfile::tempdir().unwrap();
        let first = [
            ("--allow-peer", peer.as_str()),
            ("--node-id", "node-test"),
            ("--network", "relay"),
        ];
        let prepared = prepare(&mut options(plain.path(), &first), "vm").unwrap();
        assert!(!prepared.home.relay_only);
        assert!(stored(plain.path(), "vm").get("relayOnly").is_none());
    }

    /// iroh 1.2.0 has no public transport list; `Endpoint::bound_sockets`
    /// lists the bound IP sockets, and an endpoint has one only through an
    /// IP transport. Binding needs no network: the relay connection and
    /// address lookup start in the background.
    #[tokio::test]
    async fn a_relay_only_endpoint_has_no_ip_transport() {
        let relay_only = relay_builder(SecretKey::generate(), true)
            .bind()
            .await
            .unwrap();
        assert_eq!(relay_only.bound_sockets(), Vec::<SocketAddr>::new());
        assert_eq!(relay_only.addr().ip_addrs().count(), 0);
        // The same builder without the flag binds the N0 preset's IP sockets.
        let relay = relay_builder(SecretKey::generate(), false)
            .bind()
            .await
            .unwrap();
        assert!(!relay.bound_sockets().is_empty());
        relay_only.close().await;
        relay.close().await;
    }
}
