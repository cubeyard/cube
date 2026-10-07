//! `cube-gateway`: the central network for runner VMs, started and supervised
//! by cubed.
//!
//! Each VM's raw Ethernet frames arrive over Iroh (`cube/l2/1`, the gateway
//! dials the runner). Per VM the gateway runs a small LAN (DHCP, DNS, TCP
//! termination). The only egress is HTTP and HTTPS: HTTPS is intercepted with
//! the installation CA, cubed decides every request over `egress.sock`, and
//! placeholder secrets are substituted only where cubed says so. cubed reaches
//! the guest's sshd, and its portal the guest's registered services, through
//! the control socket's dial route.
pub mod addr;
pub mod ca;
pub mod control;
pub mod decide;
pub mod dial;
pub mod dns;
pub mod http;
pub mod lan;
pub mod link;
pub mod secrets;

use anyhow::{Context, Result, bail, ensure};
use cube_node_transport::NetworkMode;
use iroh::SecretKey;
use std::{
    fs,
    io::{Read, Write},
    net::SocketAddr,
    os::unix::fs::{FileTypeExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{net::UnixListener, task::JoinHandle};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub struct ServeOptions {
    /// `CUBED_STATE/gateway`: Iroh key and installation CA.
    pub state: PathBuf,
    pub control: PathBuf,
    pub decide: PathBuf,
    pub network: NetworkMode,
    pub listen: Option<SocketAddr>,
    pub upstream: http::Upstream,
    pub decide_timeout: Duration,
    pub limits: lan::LanLimits,
}

pub struct Running {
    pub gateway: Arc<control::Gateway>,
    /// The ready line printed on stdout.
    pub ready: serde_json::Value,
    pub control: PathBuf,
    pub task: JoinHandle<Result<()>>,
}

impl Running {
    pub fn stop(self) {
        self.task.abort();
        let _ = fs::remove_file(&self.control);
    }
}

pub async fn start(options: ServeOptions) -> Result<Running> {
    fs::create_dir_all(&options.state)
        .with_context(|| format!("create {}", options.state.display()))?;
    fs::set_permissions(&options.state, fs::Permissions::from_mode(0o700))?;
    let key = load_or_create_key(&options.state.join("iroh.key"))?;
    let ca = Arc::new(ca::Ca::load_or_create(&options.state)?);
    let endpoint = link::bind(key, options.network, options.listen).await?;
    let upstream = Arc::new(options.upstream);
    let egress = Arc::new(http::Egress {
        ca: ca.clone(),
        decide: Arc::new(decide::DecideClient::new(
            options.decide.clone(),
            options.decide_timeout,
        )),
        upstream: upstream.clone(),
    });
    let gateway = Arc::new(control::Gateway::new(
        endpoint.clone(),
        options.network,
        egress,
        Arc::new(http::HostResolver::new(upstream)),
        options.limits,
    ));
    let listener = bind_control(&options.control).await?;
    let task = tokio::spawn(control::serve(listener, gateway.clone()));
    let ready = serde_json::json!({
        "ready": true,
        "version": VERSION,
        "peer": endpoint.id().to_string(),
        "caSha256": ca.sha256(),
    });
    Ok(Running {
        gateway,
        ready,
        control: options.control,
        task,
    })
}

/// Binds the control socket (0600). A stale socket from a previous gateway
/// is replaced; a socket another gateway still serves is not.
async fn bind_control(path: &Path) -> Result<UnixListener> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        ensure!(
            metadata.file_type().is_socket(),
            "{} exists and is not a socket",
            path.display()
        );
        if tokio::net::UnixStream::connect(path).await.is_ok() {
            bail!("another gateway is serving {}", path.display());
        }
        fs::remove_file(path)?;
    }
    let listener = UnixListener::bind(path).with_context(|| format!("bind {}", path.display()))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}

/// The gateway's Iroh identity: 32 raw bytes, owner-only, created once.
pub fn load_or_create_key(path: &Path) -> Result<SecretKey> {
    if !path.exists() {
        let key = SecretKey::generate();
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(&key.to_bytes())?;
        file.sync_all()?;
        return Ok(key);
    }
    let mut file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.mode() & 0o077 == 0 && metadata.len() == 32,
        "{} must be a 32-byte owner-only file",
        path.display()
    );
    let mut bytes = [0u8; 32];
    file.read_exact(&mut bytes)?;
    Ok(SecretKey::from_bytes(&bytes))
}
