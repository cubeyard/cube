//! Central side: one virtual LAN per VM connection. smoltcp terminates the
//! guest's TCP; the gateway answers DHCP and DNS itself and opens upstream
//! sockets only for HTTP/HTTPS ports. Everything else is refused (RST).
use anyhow::{Result, bail};
use bytes::Bytes;
use iroh::{EndpointId, endpoint::Connection};
use l2_gateway_spike::{ALPN, Fragmenter, Reassembler, bind, load_key};
use smoltcp::{
    iface::{Config, Interface, SocketHandle, SocketSet},
    phy::{ChecksumCapabilities, Device, DeviceCapabilities, Medium, RxToken, TxToken},
    socket::{tcp, udp},
    time::Instant,
    wire::{
        DhcpMessageType, DhcpOption, DhcpPacket, DhcpRepr, EthernetAddress, EthernetFrame,
        EthernetProtocol, EthernetRepr, IpAddress, IpCidr, IpEndpoint, IpListenEndpoint,
        IpProtocol, Ipv4Address, Ipv4Packet, Ipv4Repr, TcpPacket, UdpPacket, UdpRepr,
    },
};
use std::{
    collections::{HashMap, VecDeque},
    net::SocketAddr,
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpStream, UdpSocket},
    sync::{Notify, mpsc},
};

const GW_MAC: EthernetAddress = EthernetAddress([0x02, 0, 0, 0, 0, 0x01]);
const GW_IP: Ipv4Address = Ipv4Address::new(10, 77, 0, 1);
const GUEST_IP: Ipv4Address = Ipv4Address::new(10, 77, 0, 2);
const ALLOWED_PORTS: [u16; 2] = [80, 443];
const TCP_BUFFER: usize = 256 * 1024;
const CHUNK: usize = 16 * 1024;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let [_, key, allow, listen, resolver] = &args[..] else {
        bail!("usage: gateway <key> <allowed-pump-id> <listen-ip:port> <resolver-ip:port>");
    };
    let endpoint = bind(load_key(&PathBuf::from(key))?, listen.parse()?, vec![ALPN.to_vec()]).await?;
    let allowed: EndpointId = allow.parse()?;
    let resolver: SocketAddr = resolver.parse()?;
    println!("{}", endpoint.id());
    eprintln!("gateway: listening on {listen}");
    while let Some(incoming) = endpoint.accept().await {
        tokio::spawn(async move {
            let result = async {
                let conn = incoming.await?;
                if conn.remote_id() != allowed {
                    conn.close(1u32.into(), b"not allowed");
                    bail!("refused {}", conn.remote_id());
                }
                serve_vm(conn, resolver).await
            }
            .await;
            eprintln!("gateway: vm session ended: {result:?}");
        });
    }
    Ok(())
}

/// Frame queues that smoltcp reads from and writes to.
struct Frames {
    rx: VecDeque<Bytes>,
    tx: VecDeque<Vec<u8>>,
    frame_max: usize,
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
    fn receive(&mut self, _: Instant) -> Option<(Rx, Tx<'_>)> {
        let frame = self.rx.pop_front()?;
        Some((Rx(frame), Tx(&mut self.tx)))
    }
    fn transmit(&mut self, _: Instant) -> Option<Tx<'_>> {
        Some(Tx(&mut self.tx))
    }
    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ethernet;
        caps.max_transmission_unit = self.frame_max;
        caps
    }
}

enum Event {
    Frame(Bytes),
    Dns(Vec<u8>, IpEndpoint),
    Connected(u64, mpsc::Sender<Bytes>, mpsc::Receiver<Bytes>),
    Failed(u64),
    Closed,
}

struct Flow {
    handle: SocketHandle,
    key: (IpEndpoint, IpEndpoint),
    to_upstream: Option<mpsc::Sender<Bytes>>,
    from_upstream: Option<mpsc::Receiver<Bytes>>,
    pending: Option<Bytes>,
    connected: bool,
    upstream_eof: bool,
    closing: bool,
    started: std::time::Instant,
    up_bytes: usize,
    down_bytes: usize,
}

async fn serve_vm(conn: Connection, resolver: SocketAddr) -> Result<()> {
    // Frames are fragmented over datagrams, so the guest keeps Ethernet's MTU.
    let frame_max = 1514;
    let mtu = 1500u16;
    eprintln!("gateway: vm {} connected, max datagram {:?}", conn.remote_id(), conn.max_datagram_size());

    let (events, mut inbox) = mpsc::unbounded_channel();
    let wake = Arc::new(Notify::new());
    {
        let (conn, events) = (conn.clone(), events.clone());
        tokio::spawn(async move {
            let mut reassembler = Reassembler::default();
            while let Ok(datagram) = conn.read_datagram().await {
                let Some(frame) = reassembler.push(datagram) else { continue };
                if events.send(Event::Frame(frame)).is_err() {
                    break;
                }
            }
            let _ = events.send(Event::Closed);
        });
    }

    let mut dev = Frames { rx: VecDeque::new(), tx: VecDeque::new(), frame_max };
    let mut iface = Interface::new(Config::new(GW_MAC.into()), &mut dev, Instant::now());
    iface.update_ip_addrs(|a| a.push(IpCidr::new(GW_IP.into(), 24)).unwrap());
    // AnyIP plus a default route through our own address: the gateway
    // terminates TCP for every destination the guest dials.
    iface.routes_mut().add_default_ipv4_route(GW_IP)?;
    iface.set_any_ip(true);

    let mut sockets = SocketSet::new(vec![]);
    let dns = {
        let meta = || udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 32], vec![0; 64 * 1024]);
        let mut s = udp::Socket::new(meta(), meta());
        s.bind(IpListenEndpoint { addr: Some(GW_IP.into()), port: 53 })?;
        sockets.add(s)
    };

    let mut flows: HashMap<u64, Flow> = HashMap::new();
    let mut by_tuple: HashMap<(IpEndpoint, IpEndpoint), u64> = HashMap::new();
    let mut next_id = 0u64;
    let mut stats = (0u64, 0u64);
    let mut delay = Duration::from_millis(0);
    let mut fragmenter = Fragmenter::default();
    let mut overflow = 0u64;
    let mut last_dump = std::time::Instant::now();

    loop {
        let first = tokio::select! {
            e = inbox.recv() => e,
            _ = wake.notified() => None,
            _ = tokio::time::sleep(delay) => None,
        };
        let mut batch: Vec<Event> = first.into_iter().collect();
        while let Ok(e) = inbox.try_recv() {
            batch.push(e);
        }
        for event in batch {
            match event {
                Event::Closed => {
                    eprintln!("gateway: frames in/out {stats:?}");
                    return Ok(());
                }
                Event::Frame(frame) => {
                    stats.0 += 1;
                    if let Some(reply) = dhcp_reply(&frame, mtu) {
                        dev.tx.push_back(reply);
                        continue;
                    }
                    if let Some((src, dst)) = tcp_syn(&frame)
                        && ALLOWED_PORTS.contains(&dst.port)
                        && !by_tuple.contains_key(&(src, dst))
                    {
                        let id = next_id;
                        next_id += 1;
                        let mut s = tcp::Socket::new(
                            tcp::SocketBuffer::new(vec![0; TCP_BUFFER]),
                            tcp::SocketBuffer::new(vec![0; TCP_BUFFER]),
                        );
                        s.set_nagle_enabled(false);
                        s.set_ack_delay(None);
                        s.listen(IpListenEndpoint { addr: Some(dst.addr), port: dst.port })?;
                        let handle = sockets.add(s);
                        by_tuple.insert((src, dst), id);
                        flows.insert(id, Flow {
                            handle,
                            key: (src, dst),
                            to_upstream: None,
                            from_upstream: None,
                            pending: None,
                            connected: false,
                            upstream_eof: false,
                            closing: false,
                            started: std::time::Instant::now(),
                            up_bytes: 0,
                            down_bytes: 0,
                        });
                        eprintln!("flow {id} open {src} -> {dst}");
                        let IpAddress::Ipv4(ip) = dst.addr;
                        tokio::spawn(connect(id, SocketAddr::from((ip, dst.port)), events.clone(), wake.clone()));
                    }
                    dev.rx.push_back(frame);
                }
                Event::Dns(reply, to) => {
                    let _ = sockets.get_mut::<udp::Socket>(dns).send_slice(&reply, to);
                }
                Event::Connected(id, up, down) => {
                    if let Some(f) = flows.get_mut(&id) {
                        f.to_upstream = Some(up);
                        f.from_upstream = Some(down);
                        f.connected = true;
                    }
                }
                Event::Failed(id) => {
                    eprintln!("flow {id} upstream connect failed");
                    if let Some(f) = flows.get(&id) {
                        sockets.get_mut::<tcp::Socket>(f.handle).abort();
                    }
                }
            }
        }

        // Run the stack until the flows stop making progress.
        for _ in 0..8 {
            iface.poll(Instant::now(), &mut dev, &mut sockets);
            let mut progress = false;

            let s = sockets.get_mut::<udp::Socket>(dns);
            while let Ok((n, meta)) = {
                let mut buf = [0u8; 1500];
                s.recv_slice(&mut buf).map(|(n, m)| ((buf, n), m))
            } {
                let (buf, n) = n;
                let query = buf[..n].to_vec();
                let events = events.clone();
                tokio::spawn(async move {
                    let t = std::time::Instant::now();
                    let r = resolve(&query, resolver).await;
                    eprintln!("dns {} bytes -> {:?} in {:?}", query.len(), r.as_ref().map(|r| r.len()).map_err(|e| e.to_string()), t.elapsed());
                    if let Ok(reply) = r {
                        let _ = events.send(Event::Dns(reply, meta.endpoint));
                    }
                });
            }

            let mut finished = vec![];
            for (id, f) in flows.iter_mut() {
                let s = sockets.get_mut::<tcp::Socket>(f.handle);
                // Guest -> upstream; a full channel closes the guest's window.
                if let Some(up) = &f.to_upstream {
                    while s.can_recv() {
                        let Ok(permit) = up.try_reserve() else { break };
                        let data = s.recv(|b| { let n = b.len().min(CHUNK); (n, Bytes::copy_from_slice(&b[..n])) });
                        match data {
                            Ok(d) if !d.is_empty() => { f.up_bytes += d.len(); permit.send(d); progress = true; }
                            _ => break,
                        }
                    }
                    let past_handshake = !matches!(s.state(), tcp::State::Listen | tcp::State::SynReceived);
                    if past_handshake && !s.may_recv() {
                        f.to_upstream = None; // guest sent FIN: half-close upstream
                    }
                }
                // Upstream -> guest.
                loop {
                    if f.pending.is_none() {
                        match f.from_upstream.as_mut().map(|r| r.try_recv()) {
                            Some(Ok(d)) => f.pending = Some(d),
                            Some(Err(mpsc::error::TryRecvError::Disconnected)) => {
                                f.from_upstream = None;
                                f.upstream_eof = true;
                            }
                            _ => {}
                        }
                    }
                    let Some(p) = f.pending.as_mut() else { break };
                    if !s.can_send() { break }
                    let n = s.send_slice(p).unwrap_or(0);
                    if n == 0 { break }
                    progress = true;
                    f.down_bytes += n;
                    let _ = p.split_to(n);
                    if p.is_empty() { f.pending = None; }
                }
                if f.connected && f.upstream_eof && f.pending.is_none() && !f.closing {
                    s.close();
                    f.closing = true;
                    progress = true;
                }
                if matches!(s.state(), tcp::State::Closed | tcp::State::TimeWait) && (f.connected || f.closing || s.state() == tcp::State::TimeWait) {
                    finished.push(*id);
                } else if s.state() == tcp::State::Closed {
                    finished.push(*id); // aborted before upstream connected
                }
            }
            for id in finished {
                if let Some(f) = flows.remove(&id) {
                    eprintln!("flow {id} done {:?} up={} down={} after {:?}", f.key.1, f.up_bytes, f.down_bytes, f.started.elapsed());
                    sockets.remove(f.handle);
                    by_tuple.remove(&f.key);
                }
            }
            if !progress {
                break;
            }
        }

        while let Some(frame) = dev.tx.pop_front() {
            stats.1 += 1;
            for d in fragmenter.split(&frame, conn.max_datagram_size().unwrap_or(1200)) {
                if conn.datagram_send_buffer_space() < d.len() {
                    overflow += 1;
                    if overflow % 50 == 1 {
                        eprintln!("gateway: datagram send buffer full ({overflow} times)");
                    }
                }
                let _ = conn.send_datagram(d);
            }
        }
        if last_dump.elapsed() > Duration::from_secs(5) {
            last_dump = std::time::Instant::now();
            for (id, f) in &flows {
                let s = sockets.get::<tcp::Socket>(f.handle);
                eprintln!(
                    "  flow {id} t={:?} {:?} up={} down={} pending={:?} sendq={} recvq={} can_send={} can_recv={} upq={:?} downq={:?} eof={}",
                    f.started.elapsed(), s.state(), f.up_bytes, f.down_bytes, f.pending.as_ref().map(|p| p.len()),
                    s.send_queue(), s.recv_queue(), s.can_send(), s.can_recv(),
                    f.to_upstream.as_ref().map(|u| u.capacity()), f.from_upstream.as_ref().map(|d| d.len()), f.upstream_eof
                );
            }
        }
        delay = iface
            .poll_delay(Instant::now(), &sockets)
            .map(|d| Duration::from_micros(d.total_micros()))
            .unwrap_or(Duration::from_secs(1));
    }
}

async fn connect(id: u64, to: SocketAddr, events: mpsc::UnboundedSender<Event>, wake: Arc<Notify>) {
    let stream = match tokio::time::timeout(Duration::from_secs(10), TcpStream::connect(to)).await {
        Ok(Ok(s)) => s,
        _ => {
            let _ = events.send(Event::Failed(id));
            return;
        }
    };
    let _ = stream.set_nodelay(true);
    let (mut read, mut write) = stream.into_split();
    let (up_tx, mut up_rx) = mpsc::channel::<Bytes>(16);
    let (down_tx, down_rx) = mpsc::channel::<Bytes>(16);
    {
        let wake = wake.clone();
        tokio::spawn(async move {
            while let Some(d) = up_rx.recv().await {
                if write.write_all(&d).await.is_err() {
                    break;
                }
                wake.notify_one();
            }
            let _ = write.shutdown().await;
        });
    }
    tokio::spawn(async move {
        let mut buf = vec![0u8; CHUNK];
        loop {
            match read.read(&mut buf).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if down_tx.send(Bytes::copy_from_slice(&buf[..n])).await.is_err() {
                        break;
                    }
                    wake.notify_one();
                }
            }
        }
        drop(down_tx);
        wake.notify_one();
    });
    let _ = events.send(Event::Connected(id, up_tx, down_rx));
}

async fn resolve(query: &[u8], resolver: SocketAddr) -> Result<Vec<u8>> {
    let sock = UdpSocket::bind("0.0.0.0:0").await?;
    sock.send_to(query, resolver).await?;
    let mut buf = vec![0u8; 4096];
    let n = tokio::time::timeout(Duration::from_secs(3), sock.recv(&mut buf)).await??;
    buf.truncate(n);
    Ok(buf)
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

/// Answers DISCOVER/REQUEST with the guest's fixed lease, the gateway as
/// router and resolver, and an MTU that fits one QUIC datagram.
fn dhcp_reply(frame: &[u8], mtu: u16) -> Option<Vec<u8>> {
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
    let message_type = match request.message_type {
        DhcpMessageType::Discover => DhcpMessageType::Offer,
        DhcpMessageType::Request => DhcpMessageType::Ack,
        _ => return None,
    };
    let mtu_bytes = mtu.to_be_bytes();
    let options = [DhcpOption { kind: 26, data: &mtu_bytes }];
    let reply = DhcpRepr {
        message_type,
        transaction_id: request.transaction_id,
        secs: 0,
        client_hardware_address: request.client_hardware_address,
        client_ip: Ipv4Address::UNSPECIFIED,
        your_ip: GUEST_IP,
        server_ip: GW_IP,
        router: Some(GW_IP),
        subnet_mask: Some(Ipv4Address::new(255, 255, 255, 0)),
        relay_agent_ip: Ipv4Address::UNSPECIFIED,
        broadcast: false,
        requested_ip: None,
        client_identifier: None,
        server_identifier: Some(GW_IP),
        parameter_request_list: None,
        dns_servers: Some(heapless::Vec::from_slice(&[GW_IP]).ok()?),
        max_size: None,
        lease_duration: Some(86400),
        renew_duration: None,
        rebind_duration: None,
        additional_options: &options,
    };
    let dhcp_len = reply.buffer_len();
    let udp_repr = UdpRepr { src_port: 67, dst_port: 68 };
    let ip_repr = Ipv4Repr {
        src_addr: GW_IP,
        dst_addr: Ipv4Address::BROADCAST,
        next_header: IpProtocol::Udp,
        payload_len: udp_repr.header_len() + dhcp_len,
        hop_limit: 64,
    };
    let eth_repr = EthernetRepr {
        src_addr: GW_MAC,
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
        &GW_IP.into(),
        &Ipv4Address::BROADCAST.into(),
        dhcp_len,
        |buf| {
            let _ = reply.emit(&mut DhcpPacket::new_unchecked(buf));
        },
        &caps,
    );
    Some(out)
}
