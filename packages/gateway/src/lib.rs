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
//! The model channel (model.rs) is the other door: claude-code threads'
//! `claude` children, which cubed runs on this host, reach api.anthropic.com
//! through a loopback listener with a per-thread placeholder; the same
//! decision and B6 apply, and each exchange is kept in an append-only audit
//! file (audit.rs).
//!
//! The guest-facing half of HTTP, the address check and the upstream are
//! `cube-netstack`'s; berth vm's per-machine LAN is too, inside berth.
pub mod audit;
pub mod credential;
pub mod decide;
pub mod http;
pub mod model;
pub mod reverse;
pub mod secrets;

/// The network stack lives in `cube-netstack`; its modules keep their paths
/// here so the gateway's code and tests read as before.
pub use cube_netstack::{addr, ca, dns, lan};

use anyhow::{Result, bail, ensure};
use std::{
    fs,
    net::SocketAddr,
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
    /// The model channel, when cubed asks for it.
    pub model: Option<ModelOptions>,
}

pub struct ModelOptions {
    /// A loopback address; port 0 picks one.
    pub listen: SocketAddr,
    /// The append-only audit file.
    pub audit: PathBuf,
}

pub struct Running {
    /// The ready line printed on stdout.
    pub ready: serde_json::Value,
    pub credential: PathBuf,
    pub task: JoinHandle<Result<()>>,
    pub model: Option<ModelRunning>,
}

/// The model channel's task, its stop signal and its audit.
pub struct ModelRunning {
    pub task: JoinHandle<Result<()>>,
    pub stop: tokio::sync::watch::Sender<bool>,
    pub audit: audit::Audit,
}

impl Running {
    /// Stops at once (tests): open exchanges are cut, queued writes may be
    /// left for the next start's recovery.
    pub fn stop(self) {
        self.task.abort();
        if let Some(model) = self.model {
            model.task.abort();
        }
        let _ = fs::remove_file(&self.credential);
    }

    /// The orderly stop cubed asks for (SIGTERM, stdin closed): the model
    /// channel accepts no more, lets open answers end for SHUTDOWN_GRACE,
    /// cuts the rest and drains the audit for FLUSH_LIMIT; 4 s in all,
    /// inside cubed's 5 s before SIGKILL.
    pub async fn shutdown(self) {
        if let Some(model) = self.model {
            let _ = model.stop.send(true);
            let bound = model::SHUTDOWN_GRACE + std::time::Duration::from_millis(250);
            if tokio::time::timeout(bound, model.task).await.is_err() {
                eprintln!("cube-gateway: the model channel did not stop in time");
            }
            if let Err(error) = model.audit.flush(model::FLUSH_LIMIT).await {
                eprintln!(
                    "cube-gateway: model audit not drained before stopping: {error} (the next start records what is open as lost)"
                );
            }
        }
        self.task.abort();
        let _ = fs::remove_file(&self.credential);
    }
}

/// Binds the credential socket and serves it.
pub async fn start(options: ServeOptions) -> Result<Running> {
    let decide = Arc::new(decide::DecideClient::new(
        options.decide.clone(),
        options.decide_timeout,
    ));
    let upstream = Arc::new(options.upstream);
    let mut ready = serde_json::json!({ "ready": true, "version": VERSION });
    let model = match options.model {
        Some(model) => {
            let audit = audit::Audit::open(&model.audit)?;
            let listener = model::bind(model.listen).await?;
            ready["model"] = listener.local_addr()?.to_string().into();
            let channel = Arc::new(model::ModelChannel {
                decide: decide.clone(),
                upstream: upstream.clone(),
                audit: audit.clone(),
            });
            let (stop, stopped) = tokio::sync::watch::channel(false);
            Some(ModelRunning {
                task: tokio::spawn(model::serve(listener, channel, stopped)),
                stop,
                audit,
            })
        }
        None => None,
    };
    let egress = Arc::new(http::Egress { decide, upstream });
    let listener = bind_socket(&options.credential).await?;
    let task = tokio::spawn(credential::serve(listener, egress));
    Ok(Running {
        ready,
        credential: options.credential,
        task,
        model,
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
