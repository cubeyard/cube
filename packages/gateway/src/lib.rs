//! `cube-gateway`: the credential proxy of runner protocol 4, started and
//! supervised by cubed.
//!
//! A `berth vm` runner sends each guest request a credential rule matches
//! over a `credential` stream to cubed, which checks the machine and fence
//! and carries the stream to the gateway's credential socket
//! (credential.rs). The gateway asks cubed's egress policy over
//! `egress.sock` (decide.rs), substitutes the real secret only where cubed
//! says so (secrets.rs), sends the request over TLS from this host and turns
//! what it substituted back into the placeholder in the answer (B6,
//! reverse.rs). The token exists only in this process.
//!
//! The guest-facing half of HTTP, the address check and the upstream are
//! `cube-netstack`'s; berth vm's per-machine LAN is too, inside berth.
pub mod credential;
pub mod decide;
pub mod http;
pub mod reverse;
pub mod secrets;

/// The network stack lives in `cube-netstack`; its modules keep their paths
/// here so the gateway's code and tests read as before.
pub use cube_netstack::{addr, ca, dns, lan};

use anyhow::{Result, bail, ensure};
use std::{
    fs,
    os::unix::fs::{FileTypeExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{net::UnixListener, task::JoinHandle};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub struct ServeOptions {
    /// cubed's decision socket.
    pub decide: PathBuf,
    /// The credential socket this gateway serves (0600).
    pub credential: PathBuf,
    pub upstream: http::Upstream,
    pub decide_timeout: Duration,
}

pub struct Running {
    /// The ready line printed on stdout.
    pub ready: serde_json::Value,
    pub credential: PathBuf,
    pub task: JoinHandle<Result<()>>,
}

impl Running {
    pub fn stop(self) {
        self.task.abort();
        let _ = fs::remove_file(&self.credential);
    }
}

/// Binds the credential socket and serves it.
pub async fn start(options: ServeOptions) -> Result<Running> {
    let egress = Arc::new(http::Egress {
        decide: Arc::new(decide::DecideClient::new(
            options.decide.clone(),
            options.decide_timeout,
        )),
        upstream: Arc::new(options.upstream),
    });
    let listener = bind_socket(&options.credential).await?;
    let task = tokio::spawn(credential::serve(listener, egress));
    let ready = serde_json::json!({ "ready": true, "version": VERSION });
    Ok(Running {
        ready,
        credential: options.credential,
        task,
    })
}

/// Binds the credential socket (0600). A stale socket from a previous
/// gateway is replaced; a socket another gateway still serves is not.
async fn bind_socket(path: &Path) -> Result<UnixListener> {
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
    let listener = UnixListener::bind(path)
        .map_err(|error| anyhow::anyhow!("bind {}: {error}", path.display()))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(listener)
}
