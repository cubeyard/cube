//! berth: cube's runner on runner protocol 4 (`cubeyard/runner/4`). Today
//! it has one mode, `berth host`, whose machines are directories on the host
//! it runs on, unsandboxed, for developing and debugging runners. Key files
//! hold secrets; stdout and stderr show only public identities and addresses.
mod host;

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

const USAGE: &str = "usage:
  berth host --dir <directory> [--allow-peer <public-key> --node-id <node-id>] [--network loopback|direct|relay] [--listen <ip:port>] [--python python3] [--max-machines 8] [--labels k=v,...]
      UNSANDBOXED: each machine is a subdirectory of <directory>; commands run as you, with your logins
  berth keygen --key <new-private-file>     a control key for cubed (prints its public key)
  berth version";

const HOST_WARNING: &str = "UNSANDBOXED: threads routed to this runner run commands as you, on this host, with your files, network and logins (gh, git, ssh). Use it only to develop and debug cube runners.";

/// loopback (default) and direct listen at an address; relay uses Iroh's N0
/// discovery and relays.
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

/// `DIRECTORY/.berth/host.json`: written by the first `host` run.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HostHome {
    version: u32,
    node_id: String,
    allowed_peer: String,
    network: NetworkMode,
    listen: Option<String>,
    labels: BTreeMap<String, String>,
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

/// An endpoint that accepts protocol 4 only.
async fn bind(
    key: SecretKey,
    network: NetworkMode,
    listen: Option<SocketAddr>,
) -> Result<Endpoint> {
    let alpns = vec![cube_runner_protocol::ALPN.to_vec()];
    if network == NetworkMode::Relay {
        ensure!(listen.is_none(), "relay mode does not accept --listen");
        let endpoint = Endpoint::builder(presets::N0)
            .secret_key(key)
            .alpns(alpns)
            .bind()
            .await?;
        tokio::time::timeout(RELAY_READY_TIMEOUT, endpoint.online())
            .await
            .context("timed out connecting to an N0 relay")?;
        return Ok(endpoint);
    }
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

fn take(options: &mut BTreeMap<String, String>, key: &str) -> Result<String> {
    options
        .remove(key)
        .with_context(|| format!("missing {key}\n{USAGE}"))
}

async fn host(mut options: BTreeMap<String, String>) -> Result<()> {
    use std::os::unix::{fs::DirBuilderExt, io::AsRawFd};
    let network = match options.remove("--network").as_deref() {
        None => None,
        Some("loopback") => Some(NetworkMode::Loopback),
        Some("direct") => Some(NetworkMode::Direct),
        Some("relay") => Some(NetworkMode::Relay),
        Some(_) => bail!("--network is loopback, direct or relay"),
    };
    let directory = PathBuf::from(take(&mut options, "--dir")?);
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
        "another berth host runs in {}",
        directory.display()
    );
    let manifest = control.join("host.json");
    let allow = options.remove("--allow-peer");
    let node = options.remove("--node-id");
    let listen = options.remove("--listen");
    let labels = options.remove("--labels");
    let python = options
        .remove("--python")
        .unwrap_or_else(|| "python3".into());
    let max_machines: u32 = options
        .remove("--max-machines")
        .map_or(Ok(8), |value| value.parse())
        .context("--max-machines must be a number")?;
    ensure!(options.is_empty(), "unknown options\n{USAGE}");
    ensure!(
        (1..=64).contains(&max_machines),
        "--max-machines must be 1 through 64"
    );
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
        HostHome {
            network: network.unwrap_or(home.network),
            listen: listen.or(home.listen),
            ..home
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
    let key = read_key(&control.join("runner.key"))?;
    let allowed: EndpointId = home.allowed_peer.parse()?;
    let listen = home
        .listen
        .as_deref()
        .map(str::parse::<SocketAddr>)
        .transpose()?;
    let runner = host::HostRunner::open(host::HostOptions {
        directory: directory.clone(),
        node_id: home.node_id.clone(),
        python,
        network: home.network.name().into(),
        max_machines,
        labels: home.labels.clone(),
    })?;
    let endpoint = bind(key, home.network, listen).await?;
    eprintln!(
        "berth {SOFTWARE_VERSION} host (runner protocol {})",
        cube_runner_protocol::PROTOCOL
    );
    eprintln!("{HOST_WARNING}");
    eprintln!("dir: {}", directory.display());
    eprintln!("node: {}", home.node_id);
    eprintln!("peer: {}", endpoint.id());
    eprintln!("control peer: {}", home.allowed_peer);
    eprintln!("network: {}", home.network.name());
    let addresses = endpoint
        .addr()
        .ip_addrs()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    if !addresses.is_empty() {
        eprintln!("listen: {addresses}");
    }
    eprintln!(
        "machines: {} (at most {max_machines} at once)",
        runner.machine_count()
    );
    eprintln!("waiting for cubed; Ctrl-C stops the runner (commands it started keep running)");
    use tokio::signal::unix::{SignalKind, signal};
    let mut interrupt = signal(SignalKind::interrupt())?;
    let mut terminate = signal(SignalKind::terminate())?;
    let result = tokio::select! {
        result = host::serve(&endpoint, allowed, runner) => result,
        _ = interrupt.recv() => Ok(()),
        _ = terminate.recv() => Ok(()),
    };
    endpoint.close().await;
    eprintln!("stopped");
    drop(lock);
    result
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let command = args.next().context(USAGE)?;
    let mut options = BTreeMap::new();
    while let Some(key) = args.next() {
        ensure!(key.starts_with("--"), "{USAGE}");
        let value = args.next().context(USAGE)?;
        ensure!(options.insert(key, value).is_none(), "duplicate option");
    }
    match command.as_str() {
        "host" => host(options).await,
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
