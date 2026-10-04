//! Test guest and fakes shared by the gateway's integration tests.
//!
//! The test guest is a second smoltcp stack (a DHCP client, UDP and TCP
//! sockets) driven by a tokio task; frames go to and from the gateway through
//! in-memory channels, so no QEMU and no network are involved.
#![allow(dead_code)]

use bytes::Bytes;
use cube_gateway::{
    ca::Ca,
    decide::DecideClient,
    http::{Egress, HostResolver, Upstream, VmEgress},
    lan::{FrameSink, Lan, LanConfig, LanLimits},
};
use http_body_util::{BodyExt, Full};
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use rustls::{
    RootCertStore,
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, pem::PemObject},
};
use smoltcp::{
    iface::{Config, Interface, SocketHandle, SocketSet},
    phy::{Device, DeviceCapabilities, Medium, RxToken, TxToken},
    socket::{dhcpv4, tcp, udp},
    time::Instant as NetInstant,
    wire::{
        DhcpPacket, EthernetAddress, EthernetFrame, EthernetProtocol, IpAddress, IpCidr,
        IpEndpoint, IpListenEndpoint, IpProtocol, Ipv4Address, Ipv4Cidr, Ipv4Packet, UdpPacket,
    },
};
use std::{
    collections::{HashMap, VecDeque},
    io,
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    net::{TcpListener, UnixListener},
    sync::{Notify, mpsc},
};

pub const GUEST_MAC: EthernetAddress = EthernetAddress([0x02, 0x11, 0x22, 0x33, 0x44, 0x55]);
pub const GUEST_MAC_TEXT: &str = "02:11:22:33:44:55";
pub const VM_ID: &str = "0123456789abcdef";
pub const THREAD_ID: &str = "thread-1";
pub const GH: &str = "cube_ph_github_AbCdEfGhIjKlMnOpQrStUv";
pub const OTHER: &str = "cube_ph_npm_0123456789abcdefABCDEF";
pub const REAL_TOKEN: &str = "ghp_real_token_value";

// ---------------------------------------------------------------- guest

struct PipeDevice {
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
impl Device for PipeDevice {
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
        caps.max_transmission_unit = 1514;
        caps
    }
}

#[derive(Clone, Debug, Default)]
pub struct Lease {
    pub address: Option<Ipv4Cidr>,
    pub router: Option<Ipv4Address>,
    pub dns: Vec<Ipv4Address>,
    /// DHCP option 26 as seen on the wire.
    pub mtu: Option<u16>,
}

struct Inner {
    iface: Interface,
    sockets: SocketSet<'static>,
    dev: PipeDevice,
    dhcp: SocketHandle,
    lease: Lease,
}

/// A guest on the LAN. `frames_in` receives frames from the gateway; frames
/// the guest sends go to `out`.
#[derive(Clone)]
pub struct TestGuest {
    inner: Arc<Mutex<Inner>>,
    notify: Arc<Notify>,
}

/// Where guest frames go: the LAN directly or a fake runner's datagrams.
pub type GuestOut = Box<dyn FnMut(Bytes) + Send>;

fn dhcp_mtu(frame: &[u8]) -> Option<u16> {
    let eth = EthernetFrame::new_checked(frame).ok()?;
    if eth.ethertype() != EthernetProtocol::Ipv4 {
        return None;
    }
    let ip = Ipv4Packet::new_checked(eth.payload()).ok()?;
    if ip.next_header() != IpProtocol::Udp {
        return None;
    }
    let udp = UdpPacket::new_checked(ip.payload()).ok()?;
    if udp.src_port() != 67 {
        return None;
    }
    let dhcp = DhcpPacket::new_checked(udp.payload()).ok()?;
    dhcp.options()
        .find(|o| o.kind == 26 && o.data.len() == 2)
        .map(|o| u16::from_be_bytes([o.data[0], o.data[1]]))
}

impl TestGuest {
    pub fn start(mut frames_in: mpsc::UnboundedReceiver<Bytes>, mut out: GuestOut) -> Self {
        let mut dev = PipeDevice {
            rx: VecDeque::new(),
            tx: VecDeque::new(),
        };
        let iface = Interface::new(Config::new(GUEST_MAC.into()), &mut dev, NetInstant::now());
        let mut sockets = SocketSet::new(vec![]);
        // Like a real guest, keep retrying: the first DISCOVER may go out
        // before the frame channel is up.
        let mut client = dhcpv4::Socket::new();
        let mut retry = dhcpv4::RetryConfig::default();
        retry.discover_timeout = smoltcp::time::Duration::from_millis(250);
        retry.initial_request_timeout = smoltcp::time::Duration::from_millis(250);
        client.set_retry_config(retry);
        let dhcp = sockets.add(client);
        let guest = Self {
            inner: Arc::new(Mutex::new(Inner {
                iface,
                sockets,
                dev,
                dhcp,
                lease: Lease::default(),
            })),
            notify: Arc::new(Notify::new()),
        };
        let (inner, notify) = (guest.inner.clone(), guest.notify.clone());
        tokio::spawn(async move {
            let mut delay = Duration::ZERO;
            loop {
                tokio::select! {
                    f = frames_in.recv() => match f {
                        Some(f) => {
                            let mut g = inner.lock().unwrap();
                            if let Some(mtu) = dhcp_mtu(&f) {
                                g.lease.mtu = Some(mtu);
                            }
                            g.dev.rx.push_back(f);
                        }
                        None => return,
                    },
                    _ = notify.notified() => {}
                    _ = tokio::time::sleep(delay) => {}
                }
                let outgoing: Vec<Vec<u8>> = {
                    let mut guard = inner.lock().unwrap();
                    let g = &mut *guard;
                    while let Ok(f) = frames_in.try_recv() {
                        if let Some(mtu) = dhcp_mtu(&f) {
                            g.lease.mtu = Some(mtu);
                        }
                        g.dev.rx.push_back(f);
                    }
                    g.iface.poll(NetInstant::now(), &mut g.dev, &mut g.sockets);
                    let event =
                        g.sockets
                            .get_mut::<dhcpv4::Socket>(g.dhcp)
                            .poll()
                            .map(|e| match e {
                                dhcpv4::Event::Configured(c) => {
                                    Some((c.address, c.router, c.dns_servers.to_vec()))
                                }
                                dhcpv4::Event::Deconfigured => None,
                            });
                    if let Some(Some((address, router, dns))) = event {
                        g.iface.update_ip_addrs(|a| {
                            a.clear();
                            let _ = a.push(IpCidr::Ipv4(address));
                        });
                        if let Some(router) = router {
                            let _ = g.iface.routes_mut().add_default_ipv4_route(router);
                        }
                        g.lease.address = Some(address);
                        g.lease.router = router;
                        g.lease.dns = dns;
                        g.iface.poll(NetInstant::now(), &mut g.dev, &mut g.sockets);
                    }
                    delay = g
                        .iface
                        .poll_delay(NetInstant::now(), &g.sockets)
                        .map(|d| Duration::from_micros(d.total_micros()))
                        .unwrap_or(Duration::from_millis(50))
                        .min(Duration::from_millis(50));
                    g.dev.tx.drain(..).collect()
                };
                for frame in outgoing {
                    out(frame.into());
                }
            }
        });
        guest
    }

    pub fn lease(&self) -> Lease {
        self.inner.lock().unwrap().lease.clone()
    }

    pub async fn wait_for_lease(&self) -> Lease {
        for _ in 0..500 {
            let lease = self.lease();
            if lease.address.is_some() {
                return lease;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no DHCP lease");
    }

    /// Sends a raw DNS query to the gateway and returns the raw answer.
    pub async fn dns(&self, query: &[u8]) -> Vec<u8> {
        let handle = {
            let mut g = self.inner.lock().unwrap();
            let meta =
                || udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 4], vec![0; 4096]);
            let mut s = udp::Socket::new(meta(), meta());
            s.bind(5353).unwrap();
            s.send_slice(query, IpEndpoint::new(IpAddress::v4(10, 77, 0, 1), 53))
                .unwrap();
            g.sockets.add(s)
        };
        self.notify.notify_one();
        for _ in 0..500 {
            {
                let mut g = self.inner.lock().unwrap();
                let mut buf = vec![0u8; 4096];
                if let Ok((n, _)) = g
                    .sockets
                    .get_mut::<udp::Socket>(handle)
                    .recv_slice(&mut buf)
                {
                    g.sockets.remove(handle);
                    buf.truncate(n);
                    return buf;
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no DNS answer");
    }

    fn tcp_socket() -> tcp::Socket<'static> {
        tcp::Socket::new(
            tcp::SocketBuffer::new(vec![0; 256 * 1024]),
            tcp::SocketBuffer::new(vec![0; 256 * 1024]),
        )
    }

    /// Connects to `address:port`. `Err` when the connection is refused (RST).
    pub async fn connect(&self, address: Ipv4Addr, port: u16, local: u16) -> io::Result<GuestTcp> {
        let handle = {
            let mut guard = self.inner.lock().unwrap();
            let g = &mut *guard;
            let mut s = Self::tcp_socket();
            s.connect(
                g.iface.context(),
                IpEndpoint::new(IpAddress::Ipv4(address), port),
                local,
            )
            .map_err(|e| io::Error::other(format!("{e:?}")))?;
            g.sockets.add(s)
        };
        self.notify.notify_one();
        for _ in 0..500 {
            let state = self.state(handle);
            match state {
                tcp::State::Established => return Ok(self.stream(handle)),
                tcp::State::Closed => {
                    return Err(io::ErrorKind::ConnectionRefused.into());
                }
                _ => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        }
        Err(io::ErrorKind::TimedOut.into())
    }

    /// Listens on `port` and returns the first established connection.
    pub fn listen(&self, port: u16) -> SocketHandle {
        let mut g = self.inner.lock().unwrap();
        let mut s = Self::tcp_socket();
        s.listen(IpListenEndpoint { addr: None, port }).unwrap();
        g.sockets.add(s)
    }

    pub async fn accept(&self, handle: SocketHandle) -> GuestTcp {
        for _ in 0..1000 {
            if matches!(
                self.state(handle),
                tcp::State::Established | tcp::State::CloseWait
            ) {
                return self.stream(handle);
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no connection accepted");
    }

    pub fn state(&self, handle: SocketHandle) -> tcp::State {
        self.inner
            .lock()
            .unwrap()
            .sockets
            .get::<tcp::Socket>(handle)
            .state()
    }

    pub fn remote(&self, handle: SocketHandle) -> Option<IpEndpoint> {
        self.inner
            .lock()
            .unwrap()
            .sockets
            .get::<tcp::Socket>(handle)
            .remote_endpoint()
    }

    fn stream(&self, handle: SocketHandle) -> GuestTcp {
        GuestTcp {
            guest: self.clone(),
            handle,
        }
    }
}

/// A guest TCP connection as a tokio stream.
pub struct GuestTcp {
    guest: TestGuest,
    pub handle: SocketHandle,
}

impl AsyncRead for GuestTcp {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let mut g = self.guest.inner.lock().unwrap();
        let s = g.sockets.get_mut::<tcp::Socket>(self.handle);
        if s.can_recv() {
            let n = s.recv_slice(buf.initialize_unfilled()).unwrap_or(0);
            buf.advance(n);
            drop(g);
            self.guest.notify.notify_one();
            return Poll::Ready(Ok(()));
        }
        if !s.may_recv() {
            return if s.state() == tcp::State::Closed {
                Poll::Ready(Err(io::ErrorKind::ConnectionReset.into()))
            } else {
                Poll::Ready(Ok(()))
            };
        }
        s.register_recv_waker(cx.waker());
        Poll::Pending
    }
}

impl AsyncWrite for GuestTcp {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        data: &[u8],
    ) -> Poll<io::Result<usize>> {
        let mut g = self.guest.inner.lock().unwrap();
        let s = g.sockets.get_mut::<tcp::Socket>(self.handle);
        if !s.may_send() {
            return Poll::Ready(Err(io::ErrorKind::BrokenPipe.into()));
        }
        if s.can_send() {
            let n = s.send_slice(data).unwrap_or(0);
            drop(g);
            self.guest.notify.notify_one();
            return Poll::Ready(Ok(n));
        }
        s.register_send_waker(cx.waker());
        Poll::Pending
    }
    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        self.guest
            .inner
            .lock()
            .unwrap()
            .sockets
            .get_mut::<tcp::Socket>(self.handle)
            .close();
        self.guest.notify.notify_one();
        Poll::Ready(Ok(()))
    }
}

// ---------------------------------------------------------------- fakes

/// A cubed decision server on a unix socket. `decide` maps the request JSON
/// to (delay, answer).
pub struct FakeDecide {
    pub requests: Arc<Mutex<Vec<serde_json::Value>>>,
}

pub type DecideFn = Arc<dyn Fn(&serde_json::Value) -> (Duration, serde_json::Value) + Send + Sync>;

impl FakeDecide {
    pub fn start(path: PathBuf, decide: DecideFn) -> Self {
        let listener = UnixListener::bind(&path).unwrap();
        let requests = Arc::new(Mutex::new(vec![]));
        let recorded = requests.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let (decide, recorded) = (decide.clone(), recorded.clone());
                tokio::spawn(async move {
                    let service =
                        service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                            let (decide, recorded) = (decide.clone(), recorded.clone());
                            async move {
                                assert_eq!(request.uri().path(), "/v1/decide");
                                let body = request.into_body().collect().await?.to_bytes();
                                let value: serde_json::Value =
                                    serde_json::from_slice(&body).unwrap();
                                recorded.lock().unwrap().push(value.clone());
                                let (delay, answer) = decide(&value);
                                tokio::time::sleep(delay).await;
                                Ok::<_, hyper::Error>(hyper::Response::new(Full::new(Bytes::from(
                                    serde_json::to_vec(&answer).unwrap(),
                                ))))
                            }
                        });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        Self { requests }
    }
}

pub fn allow_with(substitute: &[(&str, &str)]) -> DecideFn {
    let substitute: serde_json::Map<String, serde_json::Value> = substitute
        .iter()
        .map(|(k, v)| (k.to_string(), serde_json::Value::String(v.to_string())))
        .collect();
    Arc::new(move |_| {
        (
            Duration::ZERO,
            serde_json::json!({"allow": true, "substitute": substitute.clone()}),
        )
    })
}

/// Upstream that echoes what it received as JSON.
pub struct FakeUpstream {
    pub address: SocketAddr,
    pub hits: Arc<AtomicUsize>,
}

fn echo_service(
    hits: Arc<AtomicUsize>,
) -> impl hyper::service::Service<
    hyper::Request<hyper::body::Incoming>,
    Response = hyper::Response<Full<Bytes>>,
    Error = hyper::Error,
    Future = impl Send,
> + Clone {
    service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
        let hits = hits.clone();
        async move {
            hits.fetch_add(1, Ordering::SeqCst);
            let (parts, body) = request.into_parts();
            let body = body.collect().await?.to_bytes();
            let headers: HashMap<String, String> = parts
                .headers
                .iter()
                .map(|(k, v)| {
                    (
                        k.to_string(),
                        String::from_utf8_lossy(v.as_bytes()).into_owned(),
                    )
                })
                .collect();
            let echo = serde_json::json!({
                "method": parts.method.as_str(),
                "uri": parts.uri.to_string(),
                "headers": headers,
                "body": String::from_utf8_lossy(&body),
            });
            Ok::<_, hyper::Error>(hyper::Response::new(Full::new(Bytes::from(
                serde_json::to_vec(&echo).unwrap(),
            ))))
        }
    })
}

/// A CA for fake upstreams, trusted by the gateway through test hooks.
pub struct UpstreamCa {
    pub issuer: rcgen::Issuer<'static, rcgen::KeyPair>,
    pub der: CertificateDer<'static>,
}

impl UpstreamCa {
    pub fn new() -> Self {
        let key = rcgen::KeyPair::generate().unwrap();
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "fake upstream CA");
        let cert = params.self_signed(&key).unwrap();
        Self {
            der: cert.der().clone(),
            issuer: rcgen::Issuer::new(params, key),
        }
    }

    pub fn roots(&self) -> RootCertStore {
        let mut roots = RootCertStore::empty();
        roots.add(self.der.clone()).unwrap();
        roots
    }
}

impl FakeUpstream {
    pub async fn plain() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let service = echo_service(hits.clone());
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let service = service.clone();
                tokio::spawn(async move {
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        Self { address, hits }
    }

    pub async fn tls(ca: &UpstreamCa, names: &[&str]) -> Self {
        let key = rcgen::KeyPair::generate().unwrap();
        let params =
            rcgen::CertificateParams::new(names.iter().map(|n| n.to_string()).collect::<Vec<_>>())
                .unwrap();
        let cert = params.signed_by(&key, &ca.issuer).unwrap();
        let config = rustls::ServerConfig::builder_with_provider(cube_gateway::ca::provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.der().clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
            )
            .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let service = echo_service(hits.clone());
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let (service, acceptor) = (service.clone(), acceptor.clone());
                tokio::spawn(async move {
                    let Ok(tls) = acceptor.accept(stream).await else {
                        return;
                    };
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(tls), service)
                        .await;
                });
            }
        });
        Self { address, hits }
    }
}

// ---------------------------------------------------------------- env

/// A LAN wired straight to a test guest, with a fake decision server and
/// fake upstreams mapped through test hooks:
/// `github.test` and `api.github.test` (HTTPS) and `plain.test` (HTTP).
pub struct Env {
    pub dir: tempfile::TempDir,
    pub lan: Lan,
    pub guest: TestGuest,
    pub decide: FakeDecide,
    pub tls_upstream: FakeUpstream,
    pub plain_upstream: FakeUpstream,
    pub ca: Arc<Ca>,
}

struct ChannelSink(mpsc::UnboundedSender<Bytes>);
impl FrameSink for ChannelSink {
    fn send(&mut self, frame: &[u8]) {
        let _ = self.0.send(Bytes::copy_from_slice(frame));
    }
}

pub fn test_upstream(ca: &UpstreamCa, tls: &FakeUpstream, plain: &FakeUpstream) -> Arc<Upstream> {
    let overrides = HashMap::from([
        ("github.test".to_string(), tls.address),
        ("api.github.test".to_string(), tls.address),
        ("plain.test".to_string(), plain.address),
    ]);
    Arc::new(Upstream::with_test_hooks(ca.roots(), overrides).unwrap())
}

impl Env {
    pub async fn new(decide: DecideFn) -> Self {
        Self::with_timeout(decide, Duration::from_secs(5)).await
    }

    pub async fn with_timeout(decide: DecideFn, timeout: Duration) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let decide_path = dir.path().join("egress.sock");
        let decide_server = FakeDecide::start(decide_path.clone(), decide);
        let upstream_ca = UpstreamCa::new();
        let tls_upstream =
            FakeUpstream::tls(&upstream_ca, &["github.test", "api.github.test"]).await;
        let plain_upstream = FakeUpstream::plain().await;
        let upstream = test_upstream(&upstream_ca, &tls_upstream, &plain_upstream);
        std::fs::create_dir_all(dir.path().join("gateway")).unwrap();
        let ca = Arc::new(Ca::load_or_create(&dir.path().join("gateway")).unwrap());
        let egress = Arc::new(Egress {
            ca: ca.clone(),
            decide: Arc::new(DecideClient::new(decide_path, timeout)),
            upstream: upstream.clone(),
        });
        let (to_guest, guest_rx) = mpsc::unbounded_channel();
        let lan = Lan::spawn(
            LanConfig {
                vm_id: VM_ID.into(),
                mac: GUEST_MAC,
                limits: LanLimits::default(),
            },
            Box::new(ChannelSink(to_guest)),
            Arc::new(VmEgress::new(egress, VM_ID.into(), THREAD_ID.into())),
            Arc::new(HostResolver::new(upstream)),
        );
        let input = lan.input();
        let guest = TestGuest::start(
            guest_rx,
            Box::new(move |frame| {
                input.push(frame);
            }),
        );
        Self {
            dir,
            lan,
            guest,
            decide: decide_server,
            tls_upstream,
            plain_upstream,
            ca,
        }
    }

    /// TLS to the gateway as the guest would, trusting only the installation CA.
    pub async fn tls(
        &self,
        name: ServerName<'static>,
        port: u16,
    ) -> io::Result<tokio_rustls::client::TlsStream<GuestTcp>> {
        let tcp = self
            .guest
            .connect(Ipv4Addr::new(203, 0, 113, 1), 443, port)
            .await?;
        let mut roots = RootCertStore::empty();
        roots
            .add(CertificateDer::from_pem_slice(self.ca.pem().as_bytes()).unwrap())
            .unwrap();
        let config = rustls::ClientConfig::builder_with_provider(cube_gateway::ca::provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        tokio_rustls::TlsConnector::from(Arc::new(config))
            .connect(name, tcp)
            .await
    }
}

/// One HTTP/1.1 exchange over `io`; returns status, headers and body.
pub async fn request<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    io: S,
    request: hyper::Request<Full<Bytes>>,
) -> (hyper::StatusCode, hyper::HeaderMap, Bytes) {
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(io))
        .await
        .unwrap();
    tokio::spawn(connection);
    let response = sender.send_request(request).await.unwrap();
    let (parts, body) = response.into_parts();
    (
        parts.status,
        parts.headers,
        body.collect().await.unwrap().to_bytes(),
    )
}

pub fn get(host: &str, path: &str, headers: &[(&str, String)]) -> hyper::Request<Full<Bytes>> {
    let mut builder = hyper::Request::get(path).header("host", host);
    for (k, v) in headers {
        builder = builder.header(*k, v);
    }
    builder.body(Full::new(Bytes::new())).unwrap()
}
