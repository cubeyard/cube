//! A machine's network in process: a smoltcp test guest with keel's fixed
//! address sends its frames over the very socket pair QEMU would get
//! ([`Net::open`]), to the machine's LAN and egress gate. The runner's CA is
//! made by ca.rs and the guest trusts its certificate alone. Upstreams are
//! local fakes mapped by netstack's test hooks (which skip the address
//! check for those names only); the address check runs for every other
//! name. No QEMU and no network: masterplan B-4's V5 as far as it is
//! testable without a machine (the real one is in runner-vm-test.ts).
use super::*;
use crate::vm::{ca::RunnerCa, policy::Policy, presence::Presence, report::Reports};
use cube_runner_protocol::proto::{self, egress_policy};
use rustls::{
    RootCertStore,
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, pem::PemObject},
};
use smoltcp::{
    iface::{Config, Interface, SocketHandle, SocketSet},
    phy::{Device, DeviceCapabilities, Medium, RxToken, TxToken},
    socket::{tcp, udp},
    time::Instant as NetInstant,
    wire::{EthernetAddress, IpAddress, IpCidr, IpEndpoint},
};
use std::{
    collections::{HashMap, VecDeque},
    io,
    net::{IpAddr, SocketAddr},
    pin::Pin,
    sync::atomic::{AtomicUsize, Ordering},
    task::{Context, Poll},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, ReadBuf},
    net::TcpListener,
    sync::Notify,
};

const GH: &str = "cube_ph_github_AbCdEfGhIjKlMnOpQrStUv";
/// Any address works: upstreams are named by SNI/Host, never by it.
const ANY: Ipv4Addr = Ipv4Addr::new(203, 0, 113, 1);

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

struct Inner {
    iface: Interface,
    sockets: SocketSet<'static>,
    dev: PipeDevice,
    /// Every frame the guest received from the runner (for DHCP checks).
    seen: Vec<Bytes>,
}

/// keel's guest as the kernel's `ip=` sets it up: 192.168.127.2/24, the
/// runner at .1 as gateway and resolver, no DHCP client.
#[derive(Clone)]
struct TestGuest {
    inner: Arc<Mutex<Inner>>,
    notify: Arc<Notify>,
}

impl TestGuest {
    /// The guest on QEMU's end of the socket pair.
    fn start(qemu_end: OwnedFd) -> Self {
        let socket = std::os::unix::net::UnixDatagram::from(qemu_end);
        socket.set_nonblocking(true).unwrap();
        let socket = Arc::new(UnixDatagram::from_std(socket).unwrap());
        let mut dev = PipeDevice {
            rx: VecDeque::new(),
            tx: VecDeque::new(),
        };
        let mac = EthernetAddress([2, 0, 0, 0, 0, 2]);
        let mut iface = Interface::new(Config::new(mac.into()), &mut dev, NetInstant::now());
        iface.update_ip_addrs(|a| {
            let _ = a.push(IpCidr::new(KEEL.guest.into(), KEEL.prefix));
        });
        let _ = iface.routes_mut().add_default_ipv4_route(KEEL.gateway);
        let guest = Self {
            inner: Arc::new(Mutex::new(Inner {
                iface,
                sockets: SocketSet::new(vec![]),
                dev,
                seen: vec![],
            })),
            notify: Arc::new(Notify::new()),
        };
        let (inner, notify) = (guest.inner.clone(), guest.notify.clone());
        tokio::spawn(async move {
            let mut delay = Duration::ZERO;
            let mut buffer = vec![0u8; 65536];
            loop {
                tokio::select! {
                    n = socket.recv(&mut buffer) => match n {
                        Ok(n) => {
                            let frame = Bytes::copy_from_slice(&buffer[..n]);
                            let mut g = inner.lock().unwrap();
                            g.seen.push(frame.clone());
                            g.dev.rx.push_back(frame);
                        }
                        Err(_) => return,
                    },
                    _ = notify.notified() => {}
                    _ = tokio::time::sleep(delay) => {}
                }
                let outgoing: Vec<Vec<u8>> = {
                    let mut guard = inner.lock().unwrap();
                    let g = &mut *guard;
                    g.iface.poll(NetInstant::now(), &mut g.dev, &mut g.sockets);
                    delay = g
                        .iface
                        .poll_delay(NetInstant::now(), &g.sockets)
                        .map(|d| Duration::from_micros(d.total_micros()))
                        .unwrap_or(Duration::from_millis(50))
                        .min(Duration::from_millis(50));
                    g.dev.tx.drain(..).collect()
                };
                for frame in outgoing {
                    let _ = socket.send(&frame).await;
                }
            }
        });
        guest
    }

    /// A raw frame from the guest, past its own stack.
    async fn raw(&self, frame: Vec<u8>) {
        self.inner.lock().unwrap().dev.tx.push_back(frame);
        self.notify.notify_one();
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    async fn udp(&self, to: IpEndpoint, local: u16, data: &[u8]) -> Option<Vec<u8>> {
        let handle = {
            let mut g = self.inner.lock().unwrap();
            let meta =
                || udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 4], vec![0; 4096]);
            let mut s = udp::Socket::new(meta(), meta());
            s.bind(local).unwrap();
            s.send_slice(data, to).unwrap();
            g.sockets.add(s)
        };
        self.notify.notify_one();
        for _ in 0..100 {
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
                    return Some(buf);
                }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        self.inner.lock().unwrap().sockets.remove(handle);
        None
    }

    async fn dns(&self, id: u16, name: &str, qtype: u16) -> Vec<u8> {
        let mut query = id.to_be_bytes().to_vec();
        query.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
        for label in name.split('.') {
            query.push(label.len() as u8);
            query.extend_from_slice(label.as_bytes());
        }
        query.extend_from_slice(&[0, (qtype >> 8) as u8, qtype as u8, 0, 1]);
        self.udp(
            IpEndpoint::new(IpAddress::Ipv4(KEEL.gateway), 53),
            5300 + id,
            &query,
        )
        .await
        .expect("a DNS answer")
    }

    fn tcp_socket() -> tcp::Socket<'static> {
        tcp::Socket::new(
            tcp::SocketBuffer::new(vec![0; 256 * 1024]),
            tcp::SocketBuffer::new(vec![0; 256 * 1024]),
        )
    }

    /// `Err(ConnectionRefused)` when the runner resets the SYN.
    async fn connect(&self, address: Ipv4Addr, port: u16, local: u16) -> io::Result<GuestTcp> {
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
            match self.state(handle) {
                // A flow the runner closes at once is still connected first.
                tcp::State::Established | tcp::State::CloseWait => {
                    return Ok(GuestTcp {
                        guest: self.clone(),
                        handle,
                    });
                }
                tcp::State::Closed => return Err(io::ErrorKind::ConnectionRefused.into()),
                _ => tokio::time::sleep(Duration::from_millis(10)).await,
            }
        }
        Err(io::ErrorKind::TimedOut.into())
    }

    fn state(&self, handle: SocketHandle) -> tcp::State {
        self.inner
            .lock()
            .unwrap()
            .sockets
            .get::<tcp::Socket>(handle)
            .state()
    }
}

struct GuestTcp {
    guest: TestGuest,
    handle: SocketHandle,
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

// ---------------------------------------------------------------- upstreams

/// Echoes the request as JSON; counts hits.
struct FakeUpstream {
    address: SocketAddr,
    hits: Arc<AtomicUsize>,
}

fn echo(
    hits: Arc<AtomicUsize>,
) -> impl hyper::service::Service<
    Request<Incoming>,
    Response = Response<Full<Bytes>>,
    Error = hyper::Error,
    Future = impl Send,
> + Clone {
    service_fn(move |request: Request<Incoming>| {
        let hits = hits.clone();
        async move {
            hits.fetch_add(1, Ordering::SeqCst);
            let (parts, _) = request.into_parts();
            let headers: HashMap<String, String> = parts
                .headers
                .iter()
                .map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).into()))
                .collect();
            let echo = serde_json::json!({ "uri": parts.uri.to_string(), "headers": headers });
            Ok::<_, hyper::Error>(Response::new(Full::new(Bytes::from(
                serde_json::to_vec(&echo).unwrap(),
            ))))
        }
    })
}

struct UpstreamCa {
    issuer: rcgen::Issuer<'static, rcgen::KeyPair>,
    der: CertificateDer<'static>,
}

impl UpstreamCa {
    fn new() -> Self {
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
}

impl FakeUpstream {
    async fn serve<F, Fut>(accept: F) -> Self
    where
        F: Fn(tokio::net::TcpStream, Arc<AtomicUsize>) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let hits = Arc::new(AtomicUsize::new(0));
        let counted = hits.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                tokio::spawn(accept(stream, counted.clone()));
            }
        });
        Self { address, hits }
    }

    async fn plain() -> Self {
        Self::serve(|stream, hits| async move {
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), echo(hits))
                .await;
        })
        .await
    }

    async fn tls(ca: &UpstreamCa, names: &[&str]) -> Self {
        let key = rcgen::KeyPair::generate().unwrap();
        let params =
            rcgen::CertificateParams::new(names.iter().map(|n| n.to_string()).collect::<Vec<_>>())
                .unwrap();
        let cert = params.signed_by(&key, &ca.issuer).unwrap();
        let config = rustls::ServerConfig::builder_with_provider(cube_netstack::ca::provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_no_client_auth()
            .with_single_cert(
                vec![cert.der().clone()],
                PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
            )
            .unwrap();
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        Self::serve(move |stream, hits| {
            let acceptor = acceptor.clone();
            async move {
                let Ok(tls) = acceptor.accept(stream).await else {
                    return;
                };
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(tls), echo(hits))
                    .await;
            }
        })
        .await
    }
}

// ---------------------------------------------------------------- env

struct Env {
    _dir: tempfile::TempDir,
    guest: TestGuest,
    gate: Arc<Gate>,
    presence: Arc<Presence>,
    reports: Arc<Reports>,
    runner_ca: RunnerCa,
    tls: FakeUpstream,
    plain: FakeUpstream,
    stream: StreamUpstream,
    _net: Net,
}

/// Answers any request with an endless body, 1 KiB every 20 ms, and notes
/// when the runner closes the upstream connection.
struct StreamUpstream {
    address: SocketAddr,
    written: Arc<AtomicUsize>,
    closed: Arc<Mutex<Option<std::time::Instant>>>,
}

impl StreamUpstream {
    /// When the runner closed the upstream, waiting a little: the guest may
    /// see its side end before this fake reads the EOF.
    async fn closed_within(&self, wait: Duration) -> Option<std::time::Instant> {
        let deadline = std::time::Instant::now() + wait;
        loop {
            if let Some(at) = *self.closed.lock().unwrap() {
                return Some(at);
            }
            if std::time::Instant::now() > deadline {
                return None;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let written = Arc::new(AtomicUsize::new(0));
        let closed = Arc::new(Mutex::new(None));
        let (count, mark) = (written.clone(), closed.clone());
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let (count, mark) = (count.clone(), mark.clone());
                tokio::spawn(async move {
                    let (mut read, mut write) = stream.into_split();
                    let mut head = vec![0u8; 4096];
                    let _ = read.read(&mut head).await;
                    let _ = write
                        .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 1000000000\r\n\r\n")
                        .await;
                    let writer = tokio::spawn(async move {
                        let chunk = [b'x'; 1024];
                        while write.write_all(&chunk).await.is_ok() {
                            count.fetch_add(chunk.len(), Ordering::SeqCst);
                            tokio::time::sleep(Duration::from_millis(20)).await;
                        }
                    });
                    // The runner closing its end reads as EOF here.
                    let mut rest = [0u8; 64];
                    while matches!(read.read(&mut rest).await, Ok(n) if n > 0) {}
                    *mark.lock().unwrap() = Some(std::time::Instant::now());
                    writer.abort();
                });
            }
        });
        Self {
            address,
            written,
            closed,
        }
    }
}

fn reference() -> proto::Ref {
    proto::Ref {
        owner: "thread-1".into(),
        id: "0123456789abcdef".into(),
    }
}

fn rule(hosts: &[&str], kind: egress_policy::rule::Kind) -> egress_policy::Rule {
    egress_policy::Rule {
        hosts: hosts.iter().map(|h| h.to_string()).collect(),
        ports: vec![],
        kind: Some(kind),
    }
}

fn policy(
    default: egress_policy::Default,
    deny: &[&str],
    rules: Vec<egress_policy::Rule>,
    lease: Duration,
) -> Policy {
    Policy::from_proto(Some(&proto::EgressPolicy {
        default: default as i32,
        deny_hosts: deny.iter().map(|h| h.to_string()).collect(),
        rules,
        lease: Some(pbjson_types::Duration {
            seconds: lease.as_secs() as i64,
            nanos: lease.subsec_nanos() as i32,
        }),
    }))
    .unwrap()
}

fn open_policy(lease: Duration) -> Policy {
    policy(egress_policy::Default::AllowPublicHttp, &[], vec![], lease)
}

impl Env {
    async fn new(policy: Policy) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let runner_ca = RunnerCa::load_or_create(&dir.path().join("ca")).unwrap();
        let upstream_ca = UpstreamCa::new();
        let tls = FakeUpstream::tls(&upstream_ca, &["github.test", "api.github.test"]).await;
        let plain = FakeUpstream::plain().await;
        let stream = StreamUpstream::start().await;
        let mut roots = RootCertStore::empty();
        roots.add(upstream_ca.der.clone()).unwrap();
        let upstream = Arc::new(
            Upstream::with_test_hooks(
                roots,
                HashMap::from([
                    ("github.test".to_string(), tls.address),
                    ("api.github.test".to_string(), tls.address),
                    ("plain.test".to_string(), plain.address),
                    ("stream.test".to_string(), stream.address),
                ]),
            )
            .unwrap(),
        );
        let presence = Presence::new();
        let reports = Reports::new();
        let egress = Arc::new(Egress {
            ca: runner_ca.signer.clone(),
            upstream,
            presence: presence.clone(),
            reports: reports.clone(),
        });
        let gate = Gate::new(egress, reference(), policy);
        let (net, qemu_end) = Net::open(gate.clone(), "0123456789abcdef").unwrap();
        // QEMU's end is close-on-exec until the spawn puts it on NET_FD.
        // SAFETY: fcntl on a descriptor this test owns.
        let flags = unsafe { libc::fcntl(qemu_end.as_raw_fd(), libc::F_GETFD) };
        assert_ne!(
            flags & libc::FD_CLOEXEC,
            0,
            "only the QEMU child inherits it"
        );
        let guest = TestGuest::start(qemu_end);
        Self {
            _dir: dir,
            guest,
            gate,
            presence,
            reports,
            runner_ca,
            tls,
            plain,
            stream,
            _net: net,
        }
    }

    /// TLS to the runner as a keel guest would, trusting only ca.pem.
    async fn tls(
        &self,
        name: &str,
        local: u16,
    ) -> io::Result<tokio_rustls::client::TlsStream<GuestTcp>> {
        let tcp = self.guest.connect(ANY, 443, local).await?;
        let mut roots = RootCertStore::empty();
        roots
            .add(CertificateDer::from_pem_slice(self.runner_ca.pem.as_bytes()).unwrap())
            .unwrap();
        let config = rustls::ClientConfig::builder_with_provider(cube_netstack::ca::provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        tokio_rustls::TlsConnector::from(Arc::new(config))
            .connect(ServerName::try_from(name.to_string()).unwrap(), tcp)
            .await
    }

    fn reasons(&self) -> Vec<(String, String)> {
        self.reports
            .queued()
            .into_iter()
            .map(|r| {
                assert_eq!(r.r#ref, Some(reference()));
                assert!(r.at.is_some());
                (r.host, r.reason)
            })
            .collect()
    }
}

async fn request<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    io: S,
    request: Request<Full<Bytes>>,
) -> (StatusCode, http::HeaderMap, Bytes) {
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

fn get(host: &str, path: &str, headers: &[(&str, String)]) -> Request<Full<Bytes>> {
    let mut builder = Request::get(path).header("host", host);
    for (k, v) in headers {
        builder = builder.header(*k, v);
    }
    builder.body(Full::new(Bytes::new())).unwrap()
}

fn json(body: &[u8]) -> serde_json::Value {
    serde_json::from_slice(body).unwrap()
}

// ---------------------------------------------------------------- tests

#[tokio::test]
async fn a_fixed_address_dns_and_https_through_the_runner_ca() {
    let env = Env::new(open_policy(Duration::from_secs(900))).await;
    let _cubed = env.presence.attach(None);
    // DNS at .1: A for a name, AAAA empty (IPv4 only), MX not implemented.
    let a = env.guest.dns(1, "github.test", 1).await;
    assert_eq!((a[3] & 0x0f, u16::from_be_bytes([a[6], a[7]])), (0, 1));
    let aaaa = env.guest.dns(2, "github.test", 28).await;
    assert_eq!((aaaa[3] & 0x0f, aaaa[7]), (0, 0));
    assert_eq!(env.guest.dns(3, "github.test", 15).await[3] & 0x0f, 4);

    // HTTPS: the guest trusts only the runner's ca.pem; twice on one connection.
    let tls = env
        .tls("api.github.test", 40001)
        .await
        .expect("the runner CA's leaf verifies");
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(tls))
        .await
        .unwrap();
    tokio::spawn(connection);
    for path in ["/user?x=1", "/repos"] {
        let response = sender
            .send_request(get("api.github.test", path, &[]))
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let body = response.into_body().collect().await.unwrap().to_bytes();
        assert_eq!(json(&body)["uri"], path);
        assert_eq!(json(&body)["headers"]["host"], "api.github.test");
    }
    assert_eq!(env.tls.hits.load(Ordering::SeqCst), 2);
    // Plain HTTP on 80.
    let tcp = env.guest.connect(ANY, 80, 40002).await.unwrap();
    let (status, _, body) = request(tcp, get("plain.test", "/index", &[])).await;
    assert_eq!(
        (status, json(&body)["uri"].clone()),
        (StatusCode::OK, "/index".into())
    );
    assert!(
        env.reasons().is_empty(),
        "nothing refused: {:?}",
        env.reasons()
    );
}

#[tokio::test]
async fn no_dhcp_other_ports_reset_and_other_udp_dropped() {
    let env = Env::new(open_policy(Duration::from_secs(900))).await;
    let _cubed = env.presence.attach(None);
    // A DHCP DISCOVER from the guest's MAC gets no answer: the address is fixed.
    let discover = dhcp_discover();
    env.guest.raw(discover).await;
    tokio::time::sleep(Duration::from_millis(200)).await;
    let answered = env.guest.inner.lock().unwrap().seen.iter().any(|f| {
        f.len() > 14 + 20 + 8
            && f[12..14] == [8, 0]
            && f[23] == 17
            && f[34..36] == 67u16.to_be_bytes()
    });
    assert!(!answered, "the runner answered DHCP");
    for (address, port, local) in [
        (ANY, 22, 40010),
        (KEEL.gateway, 8080, 40011),
        (ANY, 8443, 40012),
    ] {
        let started = std::time::Instant::now();
        let error = env.guest.connect(address, port, local).await.err();
        assert_eq!(
            error.map(|e| e.kind()),
            Some(io::ErrorKind::ConnectionRefused),
            "{address}:{port}"
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }
    // UDP other than DNS at .1 goes nowhere.
    for to in [
        IpEndpoint::new(IpAddress::v4(1, 1, 1, 1), 53),
        IpEndpoint::new(IpAddress::v4(1, 1, 1, 1), 123),
        IpEndpoint::new(IpAddress::Ipv4(KEEL.gateway), 123),
    ] {
        assert_eq!(env.guest.udp(to, 5400, b"ping").await, None, "{to}");
    }
}

/// A DHCP DISCOVER frame from keel's MAC, built by hand.
fn dhcp_discover() -> Vec<u8> {
    use smoltcp::wire::{
        DhcpMessageType, DhcpPacket, DhcpRepr, EthernetFrame, EthernetProtocol, EthernetRepr,
        IpProtocol, Ipv4Address, Ipv4Packet, Ipv4Repr, UdpPacket, UdpRepr,
    };
    let mac = EthernetAddress([2, 0, 0, 0, 0, 2]);
    let repr = DhcpRepr {
        message_type: DhcpMessageType::Discover,
        transaction_id: 7,
        secs: 0,
        client_hardware_address: mac,
        client_ip: Ipv4Address::UNSPECIFIED,
        your_ip: Ipv4Address::UNSPECIFIED,
        server_ip: Ipv4Address::UNSPECIFIED,
        router: None,
        subnet_mask: None,
        relay_agent_ip: Ipv4Address::UNSPECIFIED,
        broadcast: true,
        requested_ip: None,
        client_identifier: Some(mac),
        server_identifier: None,
        parameter_request_list: None,
        dns_servers: None,
        max_size: None,
        lease_duration: None,
        renew_duration: None,
        rebind_duration: None,
        additional_options: &[],
    };
    let udp = UdpRepr {
        src_port: 68,
        dst_port: 67,
    };
    let ip = Ipv4Repr {
        src_addr: Ipv4Address::UNSPECIFIED,
        dst_addr: Ipv4Address::BROADCAST,
        next_header: IpProtocol::Udp,
        payload_len: udp.header_len() + repr.buffer_len(),
        hop_limit: 64,
    };
    let eth = EthernetRepr {
        src_addr: mac,
        dst_addr: EthernetAddress::BROADCAST,
        ethertype: EthernetProtocol::Ipv4,
    };
    let mut out = vec![0; eth.buffer_len() + ip.buffer_len() + ip.payload_len];
    let caps = smoltcp::phy::ChecksumCapabilities::default();
    let mut frame = EthernetFrame::new_unchecked(&mut out[..]);
    eth.emit(&mut frame);
    let mut packet = Ipv4Packet::new_unchecked(frame.payload_mut());
    ip.emit(&mut packet, &caps);
    let mut datagram = UdpPacket::new_unchecked(packet.payload_mut());
    udp.emit(
        &mut datagram,
        &Ipv4Address::UNSPECIFIED.into(),
        &Ipv4Address::BROADCAST.into(),
        repr.buffer_len(),
        |buf| {
            let _ = repr.emit(&mut DhcpPacket::new_unchecked(buf));
        },
        &caps,
    );
    out
}

#[tokio::test]
async fn the_policy_refuses_and_every_refusal_is_reported() {
    let env = Env::new(policy(
        egress_policy::Default::Deny,
        &["api.github.test"],
        vec![
            rule(
                &["github.test"],
                egress_policy::rule::Kind::Https(egress_policy::Https { credential: None }),
            ),
            rule(
                &["*.cred.test"],
                egress_policy::rule::Kind::Https(egress_policy::Https {
                    credential: Some(egress_policy::Credential {
                        name: "github".into(),
                    }),
                }),
            ),
            rule(
                &["plain.test", "*"],
                egress_policy::rule::Kind::Http(egress_policy::Http {}),
            ),
        ],
        Duration::from_secs(900),
    ))
    .await;
    let _cubed = env.presence.attach(None);
    let denied = |headers: &http::HeaderMap| headers[DENIED_HEADER].to_str().unwrap().to_owned();

    // allowed by a rule
    let tls = env.tls("github.test", 40020).await.unwrap();
    assert_eq!(
        request(tls, get("github.test", "/", &[])).await.0,
        StatusCode::OK
    );
    // deny_hosts before the rules
    let tls = env.tls("api.github.test", 40021).await.unwrap();
    let (status, headers, _) = request(tls, get("api.github.test", "/", &[])).await;
    assert_eq!(
        (status, denied(&headers)),
        (StatusCode::FORBIDDEN, Denial::DenyHost.message().into())
    );
    // DENY by default for https to anything else
    let tls = env.tls("other.test", 40022).await.unwrap();
    assert_eq!(
        request(tls, get("other.test", "/", &[])).await.0,
        StatusCode::FORBIDDEN
    );
    // a credential rule: not on this runner yet (B-5)
    let tls = env.tls("a.cred.test", 40023).await.unwrap();
    let (status, headers, _) = request(
        tls,
        get(
            "a.cred.test",
            "/",
            &[("authorization", format!("Bearer {GH}"))],
        ),
    )
    .await;
    assert_eq!(
        (status, denied(&headers)),
        (
            StatusCode::FORBIDDEN,
            Denial::CredentialUnavailable.message().into()
        )
    );
    // a placeholder where no credential rule applies (plain HTTP, also in Basic)
    let tcp = env.guest.connect(ANY, 80, 40024).await.unwrap();
    let basic = {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{GH}"))
    };
    let (status, headers, _) = request(
        tcp,
        get(
            "plain.test",
            "/",
            &[("authorization", format!("Basic {basic}"))],
        ),
    )
    .await;
    assert_eq!(
        (status, denied(&headers)),
        (StatusCode::FORBIDDEN, Denial::Placeholder.message().into())
    );
    // CONNECT and Upgrade, before anything else
    let tcp = env.guest.connect(ANY, 80, 40025).await.unwrap();
    let connect = Request::builder()
        .method(Method::CONNECT)
        .uri("example.com:443")
        .header("host", "example.com:443")
        .body(Full::new(Bytes::new()))
        .unwrap();
    assert_eq!(request(tcp, connect).await.0, StatusCode::FORBIDDEN);
    let tls = env.tls("github.test", 40026).await.unwrap();
    let upgrade = get(
        "github.test",
        "/socket",
        &[
            ("connection", "upgrade".into()),
            ("upgrade", "websocket".into()),
        ],
    );
    let (status, headers, _) = request(tls, upgrade).await;
    assert_eq!(
        (status, denied(&headers)),
        (StatusCode::FORBIDDEN, Denial::Upgrade.message().into())
    );
    // Host must be the SNI name (no domain fronting past deny_hosts)
    let tls = env.tls("github.test", 40027).await.unwrap();
    assert_eq!(
        request(tls, get("api.github.test", "/", &[])).await.0,
        StatusCode::MISDIRECTED_REQUEST
    );
    // no SNI: closed, nothing reported (there is no name)
    let no_sni = {
        let tcp = env.guest.connect(ANY, 443, 40028).await.unwrap();
        let mut roots = RootCertStore::empty();
        roots
            .add(CertificateDer::from_pem_slice(env.runner_ca.pem.as_bytes()).unwrap())
            .unwrap();
        let config = rustls::ClientConfig::builder_with_provider(cube_netstack::ca::provider())
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        tokio_rustls::TlsConnector::from(Arc::new(config))
            .connect(ServerName::IpAddress(IpAddr::from(ANY).into()), tcp)
            .await
    };
    assert!(no_sni.is_err());
    assert_eq!(
        env.tls.hits.load(Ordering::SeqCst),
        1,
        "only the allowed request went out"
    );
    assert_eq!(env.plain.hits.load(Ordering::SeqCst), 0);
    assert_eq!(
        env.reasons(),
        [
            ("api.github.test", "deny_host"),
            ("other.test", "policy"),
            ("a.cred.test", "credential_unavailable"),
            ("plain.test", "placeholder"),
            ("example.com:443", "connect"),
            ("github.test", "upgrade"),
            ("github.test", "sni_mismatch"),
        ]
        .map(|(h, r)| (h.to_string(), r.to_string()))
    );
}

#[tokio::test]
async fn private_own_and_cubed_addresses_are_refused_even_when_allowed() {
    let env = Env::new(open_policy(Duration::from_secs(900))).await;
    let _cubed = env.presence.attach(None);
    // A public address cubed is reached at (as Iroh's direct path names it).
    let cubed = Ipv4Addr::new(93, 184, 215, 14);
    env.presence.note_address(IpAddr::V4(cubed));
    let mut hosts = vec![
        "10.1.2.3".to_string(),
        "192.168.1.1".into(),
        "169.254.169.254".into(),
        "127.0.0.1".into(),
        "192.168.127.1".into(),
        "localhost".into(),
        cubed.to_string(),
    ];
    // This host's own public addresses, if it has any (none in most VMs).
    hosts.extend(
        cube_netstack::addr::local_addresses()
            .unwrap()
            .into_iter()
            .filter(|a| a.is_ipv4() && cube_netstack::addr::is_public(*a))
            .map(|a| a.to_string()),
    );
    for (i, host) in hosts.iter().enumerate() {
        let tcp = env.guest.connect(ANY, 80, 40040 + i as u16).await.unwrap();
        let (status, headers, _) = request(tcp, get(host, "/", &[])).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{host}");
        assert_eq!(headers[DENIED_HEADER], Denial::Address.message(), "{host}");
    }
    let reasons = env.reasons();
    assert_eq!(reasons.len(), hosts.len());
    assert!(reasons.iter().all(|(_, r)| r == "address"), "{reasons:?}");
}

#[tokio::test]
async fn egress_goes_on_for_the_lease_then_stops_new_flows_and_requests() {
    let lease = Duration::from_millis(1500);
    let env = Env::new(open_policy(lease)).await;
    let cubed = env.presence.attach(None);
    // A connection opened while cubed is here, kept alive.
    let tls = env.tls("github.test", 40060).await.unwrap();
    let (mut kept, connection) = hyper::client::conn::http1::handshake(TokioIo::new(tls))
        .await
        .unwrap();
    let kept_ended = tokio::spawn(connection);
    assert_eq!(
        kept.send_request(get("github.test", "/1", &[]))
            .await
            .unwrap()
            .status(),
        200
    );

    // cubed goes: within the lease, egress goes on (also new flows).
    drop(cubed);
    let lost = std::time::Instant::now();
    assert_eq!(
        kept.send_request(get("github.test", "/2", &[]))
            .await
            .unwrap()
            .status(),
        200
    );
    let tcp = env.guest.connect(ANY, 80, 40061).await.unwrap();
    assert_eq!(
        request(tcp, get("plain.test", "/", &[])).await.0,
        StatusCode::OK
    );
    assert!(lost.elapsed() < lease, "checked within the lease");

    // The lease runs out: the open connection is the guest's to end (the
    // runner does not close or reset it), but it carries no more egress.
    tokio::time::sleep(lease.saturating_sub(lost.elapsed()) + Duration::from_millis(300)).await;
    let refused = kept
        .send_request(get("github.test", "/3", &[]))
        .await
        .expect("the open connection still answers");
    assert_eq!(refused.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        refused.headers()[DENIED_HEADER],
        Denial::LeaseExpired.message()
    );
    assert!(
        !kept_ended.is_finished(),
        "the runner left the connection open"
    );
    assert_eq!(env.tls.hits.load(Ordering::SeqCst), 2, "/3 never went out");
    let mut tcp = env.guest.connect(ANY, 80, 40062).await.unwrap();
    let _ = tcp
        .write_all(b"GET / HTTP/1.1\r\nhost: plain.test\r\n\r\n")
        .await;
    let mut answer = vec![];
    let _ = tokio::time::timeout(Duration::from_secs(5), tcp.read_to_end(&mut answer)).await;
    assert!(
        answer.is_empty(),
        "a new flow gets nothing: {}",
        String::from_utf8_lossy(&answer)
    );
    let servfail = env.guest.dns(9, "github.test", 1).await;
    assert_eq!(servfail[3] & 0x0f, 2, "no lookups without cubed");
    let hits = env.plain.hits.load(Ordering::SeqCst);

    // cubed is back: the grace is over, egress again.
    let _back = env.presence.attach(None);
    // The connection that outlived the grace works again (it was refused,
    // not poisoned): its next request goes out.
    assert_eq!(
        kept.send_request(get("github.test", "/4", &[]))
            .await
            .expect("the surviving connection still answers")
            .status(),
        StatusCode::OK
    );
    assert_eq!(env.tls.hits.load(Ordering::SeqCst), 3);
    let tcp = env.guest.connect(ANY, 80, 40063).await.unwrap();
    assert_eq!(
        request(tcp, get("plain.test", "/", &[])).await.0,
        StatusCode::OK
    );
    assert_eq!(env.plain.hits.load(Ordering::SeqCst), hits + 1);
    let reasons = env.reasons();
    assert!(
        reasons
            .iter()
            .any(|(h, r)| h == "203.0.113.1:80" && r == "lease_expired"),
        "{reasons:?}"
    );
    assert!(
        reasons.iter().all(|(_, r)| r == "lease_expired"),
        "{reasons:?}"
    );
}

/// A download under way when the lease runs out: the runner closes its
/// upstream (no more egress) and leaves the guest's side to end as TCP
/// does: what reached the guest's stream is read, then EOF, never a reset.
#[tokio::test]
async fn at_the_end_of_the_lease_a_download_stops_upstream_and_drains_to_the_guest() {
    let lease = Duration::from_millis(1000);
    let env = Env::new(open_policy(lease)).await;
    let cubed = env.presence.attach(None);
    let mut tcp = env.guest.connect(ANY, 80, 40080).await.unwrap();
    tcp.write_all(b"GET /big HTTP/1.1\r\nhost: stream.test\r\n\r\n")
        .await
        .unwrap();
    let mut first = [0u8; 4096];
    let n = tcp.read(&mut first).await.unwrap();
    assert!(String::from_utf8_lossy(&first[..n]).starts_with("HTTP/1.1 200"));
    tokio::time::sleep(Duration::from_millis(300)).await;
    drop(cubed);
    let lost = std::time::Instant::now();
    let mut received = n;
    let mut buffer = vec![0u8; 65536];
    let end = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match tcp.read(&mut buffer).await {
                Ok(0) => return Ok(()),
                Ok(k) => received += k,
                Err(e) => return Err(e),
            }
        }
    })
    .await
    .expect("the download ended");
    let closed = env
        .stream
        .closed_within(Duration::from_secs(3))
        .await
        .expect("the upstream was closed");
    let after = closed.duration_since(lost);
    assert!(
        after >= lease && after < lease + Duration::from_millis(1500),
        "upstream closed {after:?} after cubed went (lease {lease:?})"
    );
    assert!(
        end.is_ok(),
        "the guest's connection ended by FIN, not a reset: {end:?}"
    );
    let written = env.stream.written.load(Ordering::SeqCst);
    assert!(
        received > 8 * 1024,
        "the guest got the download until then: {received} bytes"
    );
    assert!(
        received <= written + 1024,
        "nothing beyond what the upstream sent: {received} of {written}"
    );
    let reasons = env.reasons();
    assert!(
        reasons.is_empty(),
        "closing an upstream is no refusal: {reasons:?}"
    );
}

#[tokio::test]
async fn a_lease_of_zero_stops_egress_when_cubed_goes_and_a_new_policy_applies() {
    let env = Env::new(open_policy(Duration::ZERO)).await;
    // Never connected: alone since the runner started, so nothing goes out.
    let tcp = env.guest.connect(ANY, 80, 40070).await.unwrap();
    let mut tcp = tcp;
    let _ = tcp
        .write_all(b"GET / HTTP/1.1\r\nhost: plain.test\r\n\r\n")
        .await;
    let mut answer = vec![];
    let _ = tokio::time::timeout(Duration::from_secs(5), tcp.read_to_end(&mut answer)).await;
    assert!(answer.is_empty());
    let cubed = env.presence.attach(None);
    let tcp = env.guest.connect(ANY, 80, 40071).await.unwrap();
    assert_eq!(
        request(tcp, get("plain.test", "/", &[])).await.0,
        StatusCode::OK
    );
    // A new machine_start replaces the policy for the running machine.
    env.gate.replace(policy(
        egress_policy::Default::Deny,
        &[],
        vec![],
        Duration::ZERO,
    ));
    let tcp = env.guest.connect(ANY, 80, 40072).await.unwrap();
    assert_eq!(
        request(tcp, get("plain.test", "/", &[])).await.0,
        StatusCode::FORBIDDEN
    );
    drop(cubed);
    assert_eq!(
        env.reasons()
            .iter()
            .map(|(_, r)| r.as_str())
            .collect::<Vec<_>>(),
        ["lease_expired", "policy"]
    );
}

#[tokio::test]
async fn no_upstream_opens_while_the_lease_is_over_and_one_opens_again_after() {
    let upstreams = Upstreams::default();
    let (open, _peer) = tokio::io::duplex(1024);
    let sender = upstreams
        .client(open, || false)
        .await
        .expect("before the lease ran out");
    upstreams.stop();
    assert!(
        sender.is_closed()
            || tokio::time::timeout(Duration::from_secs(2), async {
                let mut sender = sender;
                while sender.ready().await.is_ok() {
                    tokio::task::yield_now().await;
                }
            })
            .await
            .is_ok(),
        "stop closes the open upstream"
    );
    let (late, _peer) = tokio::io::duplex(1024);
    let Err(error) = upstreams.client(late, || true).await else {
        panic!("an upstream opened while the lease is over");
    };
    assert!(error.to_string().contains("lease expired"), "{error}");
    // cubed is back: the flow's next request may open an upstream again.
    let (again, _peer) = tokio::io::duplex(1024);
    upstreams
        .client(again, || false)
        .await
        .expect("an upstream once the lease covers the flow again");
}

/// One guest connection over two losses of cubed: refused after the first
/// lease, served again once cubed is back, and a download it starts then is
/// stopped upstream when the lease runs out again (the flow re-arms).
#[tokio::test]
async fn a_surviving_connection_recovers_and_is_stopped_again_at_the_next_expiry() {
    let lease = Duration::from_millis(1000);
    let env = Env::new(open_policy(lease)).await;
    let cubed = env.presence.attach(None);
    let tcp = env.guest.connect(ANY, 80, 40090).await.unwrap();
    let (mut conn, connection) = hyper::client::conn::http1::handshake(TokioIo::new(tcp))
        .await
        .unwrap();
    let ended = tokio::spawn(connection);
    let status = |r: Response<Incoming>| r.status();
    assert_eq!(
        status(
            conn.send_request(get("plain.test", "/1", &[]))
                .await
                .unwrap()
        ),
        StatusCode::OK
    );
    drop(cubed);
    tokio::time::sleep(lease + Duration::from_millis(300)).await;
    let refused = conn
        .send_request(get("plain.test", "/2", &[]))
        .await
        .unwrap();
    assert_eq!(
        (
            refused.status(),
            refused.headers()[DENIED_HEADER].to_str().unwrap()
        ),
        (StatusCode::FORBIDDEN, Denial::LeaseExpired.message())
    );
    // cubed is back: the same connection is served again, at once.
    let cubed = env.presence.attach(None);
    assert_eq!(
        status(
            conn.send_request(get("plain.test", "/3", &[]))
                .await
                .unwrap()
        ),
        StatusCode::OK,
        "a request on the surviving connection after cubed came back"
    );
    assert_eq!(env.plain.hits.load(Ordering::SeqCst), 2);
    // A download on it, then cubed goes again: its upstream is stopped.
    let download = conn
        .send_request(get("stream.test", "/big", &[]))
        .await
        .unwrap();
    assert_eq!(download.status(), StatusCode::OK);
    let mut body = download.into_body();
    let mut received = 0;
    while received < 4096 {
        let frame = body.frame().await.unwrap().unwrap();
        received += frame.data_ref().map_or(0, |d| d.len());
    }
    drop(cubed);
    let lost = std::time::Instant::now();
    let drained = tokio::time::timeout(Duration::from_secs(10), async {
        while let Some(Ok(_)) = body.frame().await {}
    })
    .await;
    assert!(drained.is_ok(), "the download ended");
    let closed = env
        .stream
        .closed_within(Duration::from_secs(3))
        .await
        .expect("the upstream was closed again");
    let after = closed.duration_since(lost);
    assert!(
        after >= lease && after < lease + Duration::from_millis(1500),
        "upstream closed {after:?} after cubed went the second time (lease {lease:?})"
    );
    drop(conn);
    let _ = ended.await;
}
