//! One virtual LAN per VM: 10.77.0.0/24, the gateway at .1, the guest at .2.
//!
//! smoltcp terminates the guest's TCP. DHCP is answered by hand (fixed lease,
//! MTU 1500, router and resolver .1), DNS by [`crate::dns`]. A guest SYN to
//! port 80 or 443 on any address gets a listening socket; every other TCP
//! segment gets smoltcp's RST, other UDP is dropped and there is no IPv6.
//! Established flows are handed to a [`FlowHandler`] as a [`FlowStream`].
//! The gateway can also dial into the guest ([`Lan::dial`]) from .1.
//!
//! The LAN outlives the runner link: frames are dropped while no link is up
//! and the guest's TCP retransmits.
use anyhow::{Result, anyhow, bail};
use bytes::Bytes;
use smoltcp::{
    iface::{Config, Interface, SocketHandle, SocketSet},
    phy::{ChecksumCapabilities, Device, DeviceCapabilities, Medium, RxToken, TxToken},
    socket::{tcp, udp},
    time::Instant as NetInstant,
    wire::{
        DhcpMessageType, DhcpOption, DhcpPacket, DhcpRepr, EthernetAddress, EthernetFrame,
        EthernetProtocol, EthernetRepr, IpAddress, IpCidr, IpEndpoint, IpListenEndpoint,
        IpProtocol, Ipv4Address, Ipv4Packet, Ipv4Repr, TcpPacket, UdpPacket, UdpRepr,
    },
};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    future::Future,
    io,
    net::{Ipv4Addr, SocketAddrV4},
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::Relaxed},
    },
    task::{Context, Poll, ready},
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    sync::{Notify, mpsc, oneshot},
    task::JoinHandle,
};
use tokio_util::sync::PollSender;

use crate::dns;

pub const GATEWAY_MAC: EthernetAddress = EthernetAddress([0x02, 0, 0, 0, 0, 0x01]);
pub const GATEWAY_IP: Ipv4Addr = Ipv4Addr::new(10, 77, 0, 1);
pub const GUEST_IP: Ipv4Addr = Ipv4Addr::new(10, 77, 0, 2);
pub const EGRESS_PORTS: [u16; 2] = [80, 443];
const CHUNK: usize = 16 * 1024;
const CHANNEL_CHUNKS: usize = 16;
const FRAME_QUEUE: usize = 4096;
const DNS_IN_FLIGHT: usize = 64;
const DNS_TIMEOUT: Duration = Duration::from_secs(5);
const DIAL_PORTS: std::ops::Range<u16> = 40000..60000;

#[derive(Clone, Debug)]
pub struct LanLimits {
    pub max_flows: usize,
    pub buffer: usize,
    pub idle: Duration,
    pub handshake: Duration,
    pub dial: Duration,
    /// Unacknowledged data older than this closes the flow.
    pub tcp_timeout: Duration,
}

impl Default for LanLimits {
    fn default() -> Self {
        Self {
            max_flows: 256,
            buffer: 256 * 1024,
            idle: Duration::from_secs(600),
            handshake: Duration::from_secs(30),
            dial: Duration::from_secs(10),
            tcp_timeout: Duration::from_secs(120),
        }
    }
}

/// Destination of an inbound flow as the guest dialled it. The address is
/// only informational: upstream hosts come from SNI/Host, never from it.
#[derive(Clone, Copy, Debug)]
pub struct FlowInfo {
    pub destination: SocketAddrV4,
}

pub trait FlowHandler: Send + Sync + 'static {
    /// Called on the LAN task for each established guest flow; must not block.
    fn spawn(&self, info: FlowInfo, stream: FlowStream);
}

pub type ResolveFuture = Pin<Box<dyn Future<Output = dns::Answer> + Send>>;

/// Answers the guest's A queries.
pub trait Resolver: Send + Sync + 'static {
    fn resolve(&self, name: String) -> ResolveFuture;
}

/// Where the LAN writes frames for the guest.
pub trait FrameSink: Send + 'static {
    fn send(&mut self, frame: &[u8]);
}

#[derive(Default, Debug)]
pub struct LanStats {
    pub leased: AtomicBool,
    pub flows: AtomicUsize,
    pub rx_bytes: AtomicU64,
    pub tx_bytes: AtomicU64,
}

pub struct LanConfig {
    pub vm_id: String,
    /// The guest's MAC. Frames from any other source are dropped.
    pub mac: EthernetAddress,
    pub limits: LanLimits,
}

enum Command {
    Dial(u16, oneshot::Sender<Result<FlowStream>>),
    Dns(Vec<u8>, IpEndpoint),
}

/// Handle to a running LAN. Dropping it stops the LAN and resets every flow.
pub struct Lan {
    commands: mpsc::UnboundedSender<Command>,
    frames: mpsc::Sender<Bytes>,
    pub stats: Arc<LanStats>,
    task: JoinHandle<()>,
}

impl Drop for Lan {
    fn drop(&mut self) {
        self.task.abort();
    }
}

/// Input side of a LAN, given to the runner link.
#[derive(Clone)]
pub struct FrameInput(mpsc::Sender<Bytes>);

impl FrameInput {
    /// Queues one Ethernet frame from the guest; drops it when the LAN is
    /// congested (the guest's TCP retransmits).
    pub fn push(&self, frame: Bytes) -> bool {
        self.0.try_send(frame).is_ok()
    }
}

impl Lan {
    pub fn spawn(
        config: LanConfig,
        sink: Box<dyn FrameSink>,
        handler: Arc<dyn FlowHandler>,
        resolver: Arc<dyn Resolver>,
    ) -> Self {
        let (commands, command_rx) = mpsc::unbounded_channel();
        let (frames, frame_rx) = mpsc::channel(FRAME_QUEUE);
        let stats = Arc::new(LanStats::default());
        let task = tokio::spawn(
            Stack::new(
                config,
                sink,
                handler,
                resolver,
                stats.clone(),
                commands.clone(),
            )
            .run(frame_rx, command_rx),
        );
        Self {
            commands,
            frames,
            stats,
            task,
        }
    }

    pub fn input(&self) -> FrameInput {
        FrameInput(self.frames.clone())
    }

    pub fn dialer(&self) -> Dialer {
        Dialer(self.commands.clone())
    }

    /// Opens a TCP connection from 10.77.0.1 to the guest on `port`.
    pub async fn dial(&self, port: u16) -> Result<FlowStream> {
        self.dialer().dial(port).await
    }
}

/// Dials into the guest without holding the [`Lan`].
#[derive(Clone)]
pub struct Dialer(mpsc::UnboundedSender<Command>);

impl Dialer {
    pub async fn dial(&self, port: u16) -> Result<FlowStream> {
        let (reply, result) = oneshot::channel();
        self.0
            .send(Command::Dial(port, reply))
            .map_err(|_| anyhow!("vm network stopped"))?;
        result.await.map_err(|_| anyhow!("vm network stopped"))?
    }
}

/// One end of a terminated TCP flow. Reading yields the peer's bytes, EOF
/// once it sent FIN; writing queues bytes for it; shutdown sends FIN.
pub struct FlowStream {
    rx: mpsc::Receiver<Bytes>,
    leftover: Bytes,
    tx: PollSender<Bytes>,
    wake: Arc<Notify>,
}

impl FlowStream {
    fn new(rx: mpsc::Receiver<Bytes>, tx: mpsc::Sender<Bytes>, wake: Arc<Notify>) -> Self {
        Self {
            rx,
            leftover: Bytes::new(),
            tx: PollSender::new(tx),
            wake,
        }
    }
}

impl Drop for FlowStream {
    fn drop(&mut self) {
        self.wake.notify_one();
    }
}

impl AsyncRead for FlowStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if self.leftover.is_empty() {
            match ready!(self.rx.poll_recv(cx)) {
                Some(bytes) => {
                    self.leftover = bytes;
                    // The LAN may have data waiting for channel room.
                    self.wake.notify_one();
                }
                None => return Poll::Ready(Ok(())),
            }
        }
        let n = buf.remaining().min(self.leftover.len());
        let chunk = self.leftover.split_to(n);
        buf.put_slice(&chunk);
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for FlowStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        if ready!(self.tx.poll_reserve(cx)).is_err() {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        }
        let n = data.len().min(CHUNK);
        if self
            .tx
            .send_item(Bytes::copy_from_slice(&data[..n]))
            .is_err()
        {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        }
        self.wake.notify_one();
        Poll::Ready(Ok(n))
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.tx.close();
        self.wake.notify_one();
        Poll::Ready(Ok(()))
    }
}

/// Frame queues that smoltcp reads from and writes to.
struct Frames {
    rx: VecDeque<Bytes>,
    tx: VecDeque<Vec<u8>>,
}
struct Rx(Bytes);
struct Tx<'a>(&'a mut VecDeque<Vec<u8>>);
impl RxToken for Rx {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.0)
    }
}
impl TxToken for Tx<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut buf = vec![0; len];
        let r = f(&mut buf);
        self.0.push_back(buf);
        r
    }
}
impl Device for Frames {
    type RxToken<'a> = Rx;
    type TxToken<'a> = Tx<'a>;
    fn receive(&mut self, _: NetInstant) -> Option<(Rx, Tx<'_>)> {
        let frame = self.rx.pop_front()?;
        Some((Rx(frame), Tx(&mut self.tx)))
    }
    fn transmit(&mut self, _: NetInstant) -> Option<Tx<'_>> {
        Some(Tx(&mut self.tx))
    }
    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ethernet;
        caps.max_transmission_unit = cube_node_transport::l2::MAX_FRAME;
        caps
    }
}

enum Stage {
    /// Inbound: listening until the guest's handshake completes.
    Handshake {
        deadline: Instant,
    },
    /// Outbound: connecting to the guest.
    Dial {
        reply: Option<oneshot::Sender<Result<FlowStream>>>,
        deadline: Instant,
        port: u16,
    },
    Open,
}

struct Flow {
    handle: SocketHandle,
    /// The guest's SYN tuple for inbound flows (retransmitted SYNs).
    syn: Option<(IpEndpoint, IpEndpoint)>,
    stage: Stage,
    to_app: Option<mpsc::Sender<Bytes>>,
    from_app: Option<mpsc::Receiver<Bytes>>,
    pending: Option<Bytes>,
    app_eof: bool,
    closing: bool,
    last_active: Instant,
}

struct Stack {
    config: LanConfig,
    sink: Box<dyn FrameSink>,
    handler: Arc<dyn FlowHandler>,
    resolver: Arc<dyn Resolver>,
    stats: Arc<LanStats>,
    commands: mpsc::UnboundedSender<Command>,
    wake: Arc<Notify>,
    dns_in_flight: Arc<AtomicUsize>,
    dev: Frames,
    iface: Interface,
    sockets: SocketSet<'static>,
    dns: SocketHandle,
    flows: HashMap<u64, Flow>,
    by_syn: HashMap<(IpEndpoint, IpEndpoint), u64>,
    next_flow: u64,
    next_dial_port: u16,
}

impl Stack {
    fn new(
        config: LanConfig,
        sink: Box<dyn FrameSink>,
        handler: Arc<dyn FlowHandler>,
        resolver: Arc<dyn Resolver>,
        stats: Arc<LanStats>,
        commands: mpsc::UnboundedSender<Command>,
    ) -> Self {
        let mut dev = Frames {
            rx: VecDeque::new(),
            tx: VecDeque::new(),
        };
        let mut iface =
            Interface::new(Config::new(GATEWAY_MAC.into()), &mut dev, NetInstant::now());
        iface.update_ip_addrs(|a| {
            let _ = a.push(IpCidr::new(GATEWAY_IP.into(), 24));
        });
        // AnyIP plus a default route through our own address: the gateway
        // terminates TCP for every destination the guest dials.
        let _ = iface.routes_mut().add_default_ipv4_route(GATEWAY_IP);
        iface.set_any_ip(true);
        let mut sockets = SocketSet::new(vec![]);
        let dns = {
            let meta =
                || udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 32], vec![0; 32 * 1024]);
            let mut s = udp::Socket::new(meta(), meta());
            s.bind(IpListenEndpoint {
                addr: Some(GATEWAY_IP.into()),
                port: 53,
            })
            .expect("bind dns");
            sockets.add(s)
        };
        Self {
            config,
            sink,
            handler,
            resolver,
            stats,
            commands,
            wake: Arc::new(Notify::new()),
            dns_in_flight: Arc::new(AtomicUsize::new(0)),
            dev,
            iface,
            sockets,
            dns,
            flows: HashMap::new(),
            by_syn: HashMap::new(),
            next_flow: 0,
            next_dial_port: DIAL_PORTS.start,
        }
    }

    async fn run(
        mut self,
        mut frames: mpsc::Receiver<Bytes>,
        mut commands: mpsc::UnboundedReceiver<Command>,
    ) {
        let mut delay = Duration::ZERO;
        loop {
            let mut batch_frames = vec![];
            let mut batch_commands = vec![];
            tokio::select! {
                f = frames.recv() => match f {
                    Some(f) => batch_frames.push(f),
                    None => return,
                },
                c = commands.recv() => match c {
                    Some(c) => batch_commands.push(c),
                    None => return,
                },
                _ = self.wake.notified() => {}
                _ = tokio::time::sleep(delay) => {}
            }
            while batch_frames.len() < 256
                && let Ok(f) = frames.try_recv()
            {
                batch_frames.push(f);
            }
            while let Ok(c) = commands.try_recv() {
                batch_commands.push(c);
            }
            for frame in batch_frames {
                self.ingress(frame);
            }
            for command in batch_commands {
                self.command(command);
            }
            self.pump();
            delay = self
                .iface
                .poll_delay(NetInstant::now(), &self.sockets)
                .map(|d| Duration::from_micros(d.total_micros()))
                .unwrap_or(Duration::from_secs(1))
                .min(Duration::from_secs(1));
        }
    }

    fn ingress(&mut self, frame: Bytes) {
        self.stats.rx_bytes.fetch_add(frame.len() as u64, Relaxed);
        let Ok(eth) = EthernetFrame::new_checked(&frame[..]) else {
            return;
        };
        if eth.src_addr() != self.config.mac {
            return;
        }
        if let Some(reply) = dhcp_reply(&frame, self.config.mac) {
            if reply.1 {
                self.stats.leased.store(true, Relaxed);
            }
            self.dev.tx.push_back(reply.0);
            return;
        }
        if let Some((src, dst)) = tcp_syn(&frame)
            && EGRESS_PORTS.contains(&dst.port)
            && !self.by_syn.contains_key(&(src, dst))
            && self.flows.len() < self.config.limits.max_flows
        {
            let mut s = self.tcp_socket();
            if s.listen(IpListenEndpoint {
                addr: Some(dst.addr),
                port: dst.port,
            })
            .is_ok()
            {
                let handle = self.sockets.add(s);
                let id = self.flow_id();
                self.by_syn.insert((src, dst), id);
                self.flows.insert(
                    id,
                    Flow::new(
                        handle,
                        Some((src, dst)),
                        Stage::Handshake {
                            deadline: Instant::now() + self.config.limits.handshake,
                        },
                    ),
                );
            }
        }
        self.dev.rx.push_back(frame);
    }

    fn tcp_socket(&self) -> tcp::Socket<'static> {
        let limits = &self.config.limits;
        let mut s = tcp::Socket::new(
            tcp::SocketBuffer::new(vec![0; limits.buffer]),
            tcp::SocketBuffer::new(vec![0; limits.buffer]),
        );
        s.set_nagle_enabled(false);
        s.set_ack_delay(None);
        s.set_timeout(Some(limits.tcp_timeout.into()));
        s
    }

    fn flow_id(&mut self) -> u64 {
        self.next_flow += 1;
        self.next_flow
    }

    fn command(&mut self, command: Command) {
        match command {
            Command::Dns(reply, to) => {
                let _ = self
                    .sockets
                    .get_mut::<udp::Socket>(self.dns)
                    .send_slice(&reply, to);
            }
            Command::Dial(port, reply) => {
                if self.flows.len() >= self.config.limits.max_flows {
                    let _ = reply.send(Err(anyhow!("too many flows")));
                    return;
                }
                let in_use: HashSet<u16> = self
                    .flows
                    .values()
                    .filter_map(|f| {
                        let s = self.sockets.get::<tcp::Socket>(f.handle);
                        s.local_endpoint().map(|e| e.port)
                    })
                    .collect();
                let mut local = None;
                for _ in DIAL_PORTS {
                    let port = self.next_dial_port;
                    self.next_dial_port = if port + 1 >= DIAL_PORTS.end {
                        DIAL_PORTS.start
                    } else {
                        port + 1
                    };
                    if !in_use.contains(&port) {
                        local = Some(port);
                        break;
                    }
                }
                let Some(local) = local else {
                    let _ = reply.send(Err(anyhow!("no local port")));
                    return;
                };
                let mut s = self.tcp_socket();
                let remote = IpEndpoint::new(GUEST_IP.into(), port);
                let local = IpListenEndpoint {
                    addr: Some(GATEWAY_IP.into()),
                    port: local,
                };
                if let Err(e) = s.connect(self.iface.context(), remote, local) {
                    let _ = reply.send(Err(anyhow!("connect: {e}")));
                    return;
                }
                let handle = self.sockets.add(s);
                let id = self.flow_id();
                self.flows.insert(
                    id,
                    Flow::new(
                        handle,
                        None,
                        Stage::Dial {
                            reply: Some(reply),
                            deadline: Instant::now() + self.config.limits.dial,
                            port,
                        },
                    ),
                );
            }
        }
    }

    fn open(&mut self, id: u64) -> FlowStream {
        let (to_app, app_rx) = mpsc::channel(CHANNEL_CHUNKS);
        let (app_tx, from_app) = mpsc::channel(CHANNEL_CHUNKS);
        let flow = self.flows.get_mut(&id).expect("flow");
        flow.to_app = Some(to_app);
        flow.from_app = Some(from_app);
        flow.stage = Stage::Open;
        flow.last_active = Instant::now();
        FlowStream::new(app_rx, app_tx, self.wake.clone())
    }

    /// Runs the stack until the flows stop making progress, then sends the
    /// queued frames to the guest.
    fn pump(&mut self) {
        for _ in 0..8 {
            self.iface
                .poll(NetInstant::now(), &mut self.dev, &mut self.sockets);
            let mut progress = self.serve_dns();
            progress |= self.serve_flows();
            if !progress {
                break;
            }
        }
        while let Some(frame) = self.dev.tx.pop_front() {
            self.stats.tx_bytes.fetch_add(frame.len() as u64, Relaxed);
            self.sink.send(&frame);
        }
        self.stats.flows.store(self.flows.len(), Relaxed);
    }

    fn serve_dns(&mut self) -> bool {
        let mut progress = false;
        let socket = self.sockets.get_mut::<udp::Socket>(self.dns);
        let mut buf = [0u8; 1500];
        while let Ok((n, meta)) = socket.recv_slice(&mut buf) {
            progress = true;
            let query = match dns::parse(&buf[..n]) {
                Ok(q) => q,
                Err(Some(reply)) => {
                    let _ = socket.send_slice(&reply, meta.endpoint);
                    continue;
                }
                Err(None) => continue,
            };
            if let Some(answer) = dns::immediate(&query) {
                let _ = socket.send_slice(&dns::reply(&query, &answer), meta.endpoint);
                continue;
            }
            if self.dns_in_flight.load(Relaxed) >= DNS_IN_FLIGHT {
                continue;
            }
            self.dns_in_flight.fetch_add(1, Relaxed);
            let (resolver, commands, in_flight, wake) = (
                self.resolver.clone(),
                self.commands.clone(),
                self.dns_in_flight.clone(),
                self.wake.clone(),
            );
            tokio::spawn(async move {
                let answer =
                    tokio::time::timeout(DNS_TIMEOUT, resolver.resolve(query.name.clone()))
                        .await
                        .unwrap_or(dns::Answer::ServFail);
                in_flight.fetch_sub(1, Relaxed);
                let _ = commands.send(Command::Dns(dns::reply(&query, &answer), meta.endpoint));
                wake.notify_one();
            });
        }
        progress
    }

    fn serve_flows(&mut self) -> bool {
        let now = Instant::now();
        let mut progress = false;
        let mut opened = vec![];
        let mut finished = vec![];
        for (id, f) in self.flows.iter_mut() {
            let s = self.sockets.get_mut::<tcp::Socket>(f.handle);
            let established = matches!(s.state(), tcp::State::Established | tcp::State::CloseWait);
            match &mut f.stage {
                Stage::Handshake { deadline } => {
                    if established {
                        opened.push(*id);
                    } else if now > *deadline {
                        s.abort();
                        f.closing = true;
                    }
                }
                Stage::Dial {
                    reply,
                    deadline,
                    port,
                } => {
                    if established {
                        opened.push(*id);
                    } else if s.state() == tcp::State::Closed || now > *deadline {
                        let refused = s.state() == tcp::State::Closed;
                        s.abort();
                        f.closing = true;
                        if let Some(reply) = reply.take() {
                            let _ = reply.send(Err(if refused {
                                anyhow!("guest refused port {port}")
                            } else {
                                anyhow!("guest did not answer on port {port}")
                            }));
                        }
                    }
                }
                Stage::Open => {
                    progress |= f.transfer(s, now, self.config.limits.idle);
                }
            }
            // Closed without a tuple: any RST has been sent. A flow in
            // TIME-WAIT is done; late segments get an RST.
            if s.state() == tcp::State::Closed && s.remote_endpoint().is_none()
                || s.state() == tcp::State::TimeWait
            {
                finished.push(*id);
            }
        }
        for id in opened {
            progress = true;
            let stream = self.open_flow(id);
            let flow = &self.flows[&id];
            let s = self.sockets.get::<tcp::Socket>(flow.handle);
            if let Some(stream) = stream {
                let Some(IpEndpoint {
                    addr: IpAddress::Ipv4(address),
                    port,
                }) = s.local_endpoint()
                else {
                    continue;
                };
                self.handler.spawn(
                    FlowInfo {
                        destination: SocketAddrV4::new(address, port),
                    },
                    stream,
                );
            }
        }
        for id in finished {
            if let Some(f) = self.flows.remove(&id) {
                if let Stage::Dial {
                    reply: Some(reply), ..
                } = f.stage
                {
                    let _ = reply.send(Err(anyhow!("flow closed")));
                }
                self.sockets.remove(f.handle);
                if let Some(syn) = f.syn {
                    self.by_syn.remove(&syn);
                }
            }
        }
        progress
    }

    /// Moves a flow to `Open`. Inbound flows return their stream for the
    /// handler; dial flows hand it to the waiting caller.
    fn open_flow(&mut self, id: u64) -> Option<FlowStream> {
        let stage = std::mem::replace(
            &mut self.flows.get_mut(&id).expect("flow").stage,
            Stage::Open,
        );
        let stream = self.open(id);
        match stage {
            Stage::Dial {
                reply: Some(reply), ..
            } => {
                if let Err(Ok(stream)) = reply.send(Ok(stream)) {
                    // The caller gave up: reset the connection.
                    drop(stream);
                    let flow = &mut self.flows.get_mut(&id).expect("flow");
                    self.sockets.get_mut::<tcp::Socket>(flow.handle).abort();
                    flow.closing = true;
                }
                None
            }
            Stage::Dial { reply: None, .. } => None,
            _ => Some(stream),
        }
    }
}

impl Flow {
    fn new(handle: SocketHandle, syn: Option<(IpEndpoint, IpEndpoint)>, stage: Stage) -> Self {
        Self {
            handle,
            syn,
            stage,
            to_app: None,
            from_app: None,
            pending: None,
            app_eof: false,
            closing: false,
            last_active: Instant::now(),
        }
    }

    /// Moves bytes between the socket and the application channels.
    fn transfer(&mut self, s: &mut tcp::Socket<'_>, now: Instant, idle: Duration) -> bool {
        let mut progress = false;
        // Guest -> application; a full channel closes the guest's window.
        if let Some(to_app) = &self.to_app {
            while s.can_recv() {
                let permit = match to_app.try_reserve() {
                    Ok(p) => p,
                    Err(mpsc::error::TrySendError::Full(_)) => break,
                    Err(mpsc::error::TrySendError::Closed(_)) => {
                        // The application is gone but the guest still sends.
                        s.abort();
                        self.closing = true;
                        return true;
                    }
                };
                match s.recv(|b| {
                    let n = b.len().min(CHUNK);
                    (n, Bytes::copy_from_slice(&b[..n]))
                }) {
                    Ok(d) if !d.is_empty() => {
                        permit.send(d);
                        progress = true;
                    }
                    _ => break,
                }
            }
            if !s.may_recv() {
                self.to_app = None; // guest sent FIN
                progress = true;
            }
        }
        // Application -> guest.
        loop {
            if self.pending.is_none() {
                match self.from_app.as_mut().map(|r| r.try_recv()) {
                    Some(Ok(d)) => self.pending = Some(d),
                    Some(Err(mpsc::error::TryRecvError::Disconnected)) => {
                        self.from_app = None;
                        self.app_eof = true;
                    }
                    _ => {}
                }
            }
            let Some(p) = self.pending.as_mut() else {
                break;
            };
            if !s.can_send() {
                break;
            }
            let n = s.send_slice(p).unwrap_or(0);
            if n == 0 {
                break;
            }
            progress = true;
            let _ = p.split_to(n);
            if p.is_empty() {
                self.pending = None;
            }
        }
        if progress {
            self.last_active = now;
        }
        if self.app_eof && self.pending.is_none() && !self.closing {
            s.close();
            self.closing = true;
            progress = true;
        }
        if now.duration_since(self.last_active) > idle && s.state() != tcp::State::Closed {
            s.abort();
            self.closing = true;
            self.to_app = None;
            self.from_app = None;
            progress = true;
        }
        progress
    }
}

fn tcp_syn(frame: &[u8]) -> Option<(IpEndpoint, IpEndpoint)> {
    let eth = EthernetFrame::new_checked(frame).ok()?;
    if eth.ethertype() != EthernetProtocol::Ipv4 {
        return None;
    }
    let ip = Ipv4Packet::new_checked(eth.payload()).ok()?;
    if ip.next_header() != IpProtocol::Tcp {
        return None;
    }
    let tcp = TcpPacket::new_checked(ip.payload()).ok()?;
    (tcp.syn() && !tcp.ack()).then(|| {
        (
            IpEndpoint::new(ip.src_addr().into(), tcp.src_port()),
            IpEndpoint::new(ip.dst_addr().into(), tcp.dst_port()),
        )
    })
}

/// Answers DISCOVER/REQUEST from the guest's MAC with the fixed lease, the
/// gateway as router and resolver, and MTU 1500. Returns the frame and
/// whether it is an ACK.
fn dhcp_reply(frame: &[u8], mac: EthernetAddress) -> Option<(Vec<u8>, bool)> {
    let eth = EthernetFrame::new_checked(frame).ok()?;
    if eth.ethertype() != EthernetProtocol::Ipv4 {
        return None;
    }
    let ip = Ipv4Packet::new_checked(eth.payload()).ok()?;
    if ip.next_header() != IpProtocol::Udp {
        return None;
    }
    let udp = UdpPacket::new_checked(ip.payload()).ok()?;
    if udp.dst_port() != 67 {
        return None;
    }
    let dhcp = DhcpPacket::new_checked(udp.payload()).ok()?;
    let request = DhcpRepr::parse(&dhcp).ok()?;
    if request.client_hardware_address != mac {
        return None;
    }
    let message_type = match request.message_type {
        DhcpMessageType::Discover => DhcpMessageType::Offer,
        DhcpMessageType::Request => {
            if request
                .requested_ip
                .is_some_and(|requested| requested != GUEST_IP)
                || request
                    .server_identifier
                    .is_some_and(|server| server != GATEWAY_IP)
            {
                DhcpMessageType::Nak
            } else {
                DhcpMessageType::Ack
            }
        }
        _ => return None,
    };
    let mtu = cube_node_transport::l2::GUEST_MTU.to_be_bytes();
    let options = [DhcpOption {
        kind: 26,
        data: &mtu,
    }];
    let nak = message_type == DhcpMessageType::Nak;
    let reply = DhcpRepr {
        message_type,
        transaction_id: request.transaction_id,
        secs: 0,
        client_hardware_address: request.client_hardware_address,
        client_ip: Ipv4Address::UNSPECIFIED,
        your_ip: if nak {
            Ipv4Address::UNSPECIFIED
        } else {
            GUEST_IP
        },
        server_ip: GATEWAY_IP,
        router: (!nak).then_some(GATEWAY_IP),
        subnet_mask: (!nak).then_some(Ipv4Address::new(255, 255, 255, 0)),
        relay_agent_ip: Ipv4Address::UNSPECIFIED,
        broadcast: false,
        requested_ip: None,
        client_identifier: None,
        server_identifier: Some(GATEWAY_IP),
        parameter_request_list: None,
        dns_servers: if nak {
            None
        } else {
            Some(heapless::Vec::from_slice(&[GATEWAY_IP]).ok()?)
        },
        max_size: None,
        lease_duration: (!nak).then_some(86400),
        renew_duration: None,
        rebind_duration: None,
        additional_options: if nak { &[] } else { &options },
    };
    let dhcp_len = reply.buffer_len();
    let udp_repr = UdpRepr {
        src_port: 67,
        dst_port: 68,
    };
    let ip_repr = Ipv4Repr {
        src_addr: GATEWAY_IP,
        dst_addr: Ipv4Address::BROADCAST,
        next_header: IpProtocol::Udp,
        payload_len: udp_repr.header_len() + dhcp_len,
        hop_limit: 64,
    };
    let eth_repr = EthernetRepr {
        src_addr: GATEWAY_MAC,
        dst_addr: EthernetAddress::BROADCAST,
        ethertype: EthernetProtocol::Ipv4,
    };
    let mut out = vec![0; eth_repr.buffer_len() + ip_repr.buffer_len() + ip_repr.payload_len];
    let caps = ChecksumCapabilities::default();
    let mut frame = EthernetFrame::new_unchecked(&mut out[..]);
    eth_repr.emit(&mut frame);
    let mut packet = Ipv4Packet::new_unchecked(frame.payload_mut());
    ip_repr.emit(&mut packet, &caps);
    let mut datagram = UdpPacket::new_unchecked(packet.payload_mut());
    udp_repr.emit(
        &mut datagram,
        &GATEWAY_IP.into(),
        &Ipv4Address::BROADCAST.into(),
        dhcp_len,
        |buf| {
            let _ = reply.emit(&mut DhcpPacket::new_unchecked(buf));
        },
        &caps,
    );
    Some((out, message_type == DhcpMessageType::Ack))
}

/// Parses `02:00:00:00:00:01` style addresses; only unicast MACs.
pub fn parse_mac(s: &str) -> Result<EthernetAddress> {
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() != 6 {
        bail!("invalid MAC address");
    }
    let mut bytes = [0u8; 6];
    for (b, p) in bytes.iter_mut().zip(parts) {
        if p.len() != 2 {
            bail!("invalid MAC address");
        }
        *b = u8::from_str_radix(p, 16).map_err(|_| anyhow!("invalid MAC address"))?;
    }
    let mac = EthernetAddress(bytes);
    if !mac.is_unicast() || bytes == [0; 6] || mac == GATEWAY_MAC {
        bail!("MAC address must be a unicast guest address");
    }
    Ok(mac)
}
