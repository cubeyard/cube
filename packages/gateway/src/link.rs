//! The reconnecting frame link from the gateway to a runner (`cube/l2/1`).
//!
//! The gateway dials; the runner only accepts. After the hello, guest frames
//! arrive as datagrams and go into the VM's LAN; frames from the LAN go out
//! through [`IrohSink`] on whatever connection is current. While no
//! connection is up, frames are dropped.
use anyhow::{Context, Result, anyhow, bail};
use cube_node_transport::{
    NetworkMode,
    l2::{Fragmenter, FrameHello, L2_ALPN, Reassembler, send_hello},
};
use iroh::{Endpoint, EndpointAddr, EndpointId, endpoint::Connection};
use serde::{Deserialize, Serialize};
use std::{
    net::SocketAddr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering::SeqCst},
    },
    time::{Duration, Instant},
};
use tokio::{sync::watch, task::JoinHandle};

use crate::lan::{FrameInput, FrameSink};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const BACKOFF_MIN: Duration = Duration::from_millis(500);
const BACKOFF_MAX: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RunnerTarget {
    pub peer: String,
    pub network: NetworkMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<SocketAddr>,
}

fn rank(mode: NetworkMode) -> u8 {
    match mode {
        NetworkMode::Loopback => 0,
        NetworkMode::Direct => 1,
        NetworkMode::Relay => 2,
    }
}

impl RunnerTarget {
    /// The Iroh address to dial from a gateway bound in `gateway` mode.
    pub fn endpoint_addr(&self, gateway: NetworkMode) -> Result<EndpointAddr> {
        let peer: EndpointId = self.peer.parse().context("invalid runner peer")?;
        if rank(self.network) > rank(gateway) {
            bail!(
                "a {:?} runner needs a gateway in {:?} mode or wider",
                self.network,
                self.network
            );
        }
        match (self.network, self.address) {
            (NetworkMode::Relay, None) => Ok(EndpointAddr::new(peer)),
            (NetworkMode::Relay, Some(_)) => bail!("relay runners take no address"),
            (mode, Some(address)) => {
                cube_node_transport::validate_target(address, mode)?;
                Ok(EndpointAddr::new(peer).with_ip_addr(address))
            }
            (_, None) => bail!("loopback and direct runners need an address"),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LinkState {
    Connecting,
    Up,
    Down,
}

#[derive(Debug)]
pub struct LinkStatus {
    pub state: LinkState,
    pub last_error: Option<String>,
}

/// The connection frames are currently sent on, shared by the link task and
/// the LAN's sink. Only the newest link may fill it: a replaced link task
/// that is still finishing a connect cannot install its connection.
pub struct Slot {
    tx: watch::Sender<Option<Connection>>,
    generation: AtomicU64,
}

impl Slot {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            tx: watch::channel(None).0,
            generation: AtomicU64::new(0),
        })
    }
    fn install(&self, generation: u64, connection: Option<Connection>) -> bool {
        let mut installed = false;
        self.tx.send_if_modified(|current| {
            if self.generation.load(SeqCst) != generation {
                return false;
            }
            *current = connection.clone();
            installed = true;
            true
        });
        installed
    }
    /// Starts a new generation and closes the previous link's connection.
    fn next(&self) -> u64 {
        let generation = self.generation.fetch_add(1, SeqCst) + 1;
        close(self.tx.send_replace(None));
        generation
    }
    /// Ends `generation` unless a newer link already replaced it.
    fn end(&self, generation: u64) {
        if self
            .generation
            .compare_exchange(generation, generation + 1, SeqCst, SeqCst)
            .is_ok()
        {
            close(self.tx.send_replace(None));
        }
    }
}

/// A running link. Dropping it closes its connection and stops redialling.
pub struct Link {
    task: JoinHandle<()>,
    slot: Arc<Slot>,
    generation: u64,
    pub status: Arc<Mutex<LinkStatus>>,
}

fn close(connection: Option<Connection>) {
    if let Some(connection) = connection {
        connection.close(0u32.into(), b"link replaced");
    }
}

impl Drop for Link {
    fn drop(&mut self) {
        self.task.abort();
        self.slot.end(self.generation);
    }
}

impl Link {
    pub fn spawn(
        endpoint: Endpoint,
        address: EndpointAddr,
        hello: FrameHello,
        input: FrameInput,
        slot: Arc<Slot>,
    ) -> Self {
        let generation = slot.next();
        let status = Arc::new(Mutex::new(LinkStatus {
            state: LinkState::Connecting,
            last_error: None,
        }));
        let task = tokio::spawn(run(
            endpoint,
            address,
            hello,
            input,
            slot.clone(),
            generation,
            status.clone(),
        ));
        Self {
            task,
            slot,
            generation,
            status,
        }
    }
}

async fn connect(
    endpoint: &Endpoint,
    address: EndpointAddr,
    hello: &FrameHello,
) -> Result<Connection> {
    let connection = tokio::time::timeout(CONNECT_TIMEOUT, async {
        let connection = endpoint.connect(address, L2_ALPN).await?;
        let ready = send_hello(&connection, hello).await?;
        if !ready.ok {
            connection.close(1u32.into(), b"refused");
            bail!(
                "runner refused the frame channel: {}",
                ready.error.as_deref().unwrap_or("no reason")
            );
        }
        if ready.mtu != cube_node_transport::l2::GUEST_MTU {
            bail!("runner announced MTU {}", ready.mtu);
        }
        if connection.max_datagram_size().is_none() {
            bail!("runner connection does not support datagrams");
        }
        Ok(connection)
    })
    .await
    .map_err(|_| anyhow!("connecting to the runner timed out"))??;
    Ok(connection)
}

async fn run(
    endpoint: Endpoint,
    address: EndpointAddr,
    hello: FrameHello,
    input: FrameInput,
    slot: Arc<Slot>,
    generation: u64,
    status: Arc<Mutex<LinkStatus>>,
) {
    let mut backoff = BACKOFF_MIN;
    loop {
        status.lock().unwrap().state = LinkState::Connecting;
        match connect(&endpoint, address.clone(), &hello).await {
            Ok(connection) => {
                let since = Instant::now();
                *status.lock().unwrap() = LinkStatus {
                    state: LinkState::Up,
                    last_error: None,
                };
                if !slot.install(generation, Some(connection.clone())) {
                    connection.close(0u32.into(), b"link replaced");
                    return;
                }
                let mut reassembler = Reassembler::default();
                let error = loop {
                    match connection.read_datagram().await {
                        Ok(datagram) => {
                            if let Some(frame) = reassembler.push(datagram) {
                                input.push(frame);
                            }
                        }
                        Err(error) => break error,
                    }
                };
                slot.install(generation, None);
                *status.lock().unwrap() = LinkStatus {
                    state: LinkState::Down,
                    last_error: Some(format!("frame connection closed: {error}")),
                };
                if since.elapsed() > BACKOFF_MAX {
                    backoff = BACKOFF_MIN;
                }
            }
            Err(error) => {
                *status.lock().unwrap() = LinkStatus {
                    state: LinkState::Down,
                    last_error: Some(format!("{error:#}")),
                };
            }
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

/// Sends the LAN's frames on the current connection, fragmented to fit.
pub struct IrohSink {
    slot: watch::Receiver<Option<Connection>>,
    current: Option<Connection>,
    fragmenter: Fragmenter,
}

impl IrohSink {
    pub fn new(slot: &Slot) -> Self {
        Self {
            slot: slot.tx.subscribe(),
            current: None,
            fragmenter: Fragmenter::default(),
        }
    }
}

impl FrameSink for IrohSink {
    fn send(&mut self, frame: &[u8]) {
        if self.slot.has_changed().unwrap_or(false) {
            self.current = self.slot.borrow_and_update().clone();
        }
        let Some(connection) = &self.current else {
            return;
        };
        // Congested: this frame is dropped whole; the guest's TCP retransmits.
        let _ = cube_node_transport::l2::send_frame(connection, &mut self.fragmenter, frame);
    }
}

/// Binds the gateway's Iroh endpoint. It accepts nothing; it only dials.
pub async fn bind(
    key: iroh::SecretKey,
    network: NetworkMode,
    listen: Option<SocketAddr>,
) -> Result<Endpoint> {
    use iroh::endpoint::presets;
    if network == NetworkMode::Relay {
        if listen.is_some() {
            bail!("relay mode takes no listen address");
        }
        let endpoint = Endpoint::builder(presets::N0)
            .secret_key(key)
            .alpns(vec![])
            .bind()
            .await?;
        tokio::time::timeout(cube_node_transport::RELAY_READY_TIMEOUT, endpoint.online())
            .await
            .context("timed out connecting to an N0 relay")?;
        return Ok(endpoint);
    }
    let listen = match (listen, network) {
        (Some(listen), _) => listen,
        (None, NetworkMode::Loopback) => "127.0.0.1:0".parse()?,
        (None, _) => "0.0.0.0:0".parse()?,
    };
    if network == NetworkMode::Loopback && !listen.ip().is_loopback() {
        bail!("loopback mode needs a loopback listen address");
    }
    Ok(Endpoint::builder(presets::Minimal)
        .secret_key(key)
        .alpns(vec![])
        .clear_ip_transports()
        .clear_relay_transports()
        .clear_address_lookup()
        .bind_addr(listen)?
        .bind()
        .await?)
}
