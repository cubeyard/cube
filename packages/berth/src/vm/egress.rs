//! A keel machine's network (masterplan B-4): virtio-net on `-netdev dgram`
//! over a socket pair, one cube-netstack LAN per QEMU process, and the
//! machine's egress policy enforced here, in the runner.
//!
//! ```text
//! guest eth0 192.168.127.2/24 (kernel ip=, no DHCP)
//!   -> QEMU virtio-net-pci -> socket pair (one frame per datagram)
//!   -> Lan (192.168.127.1: DNS A, TCP 80/443; other TCP reset, other UDP dropped)
//!   -> Gate: lease, then per request CONNECT/Upgrade, Host = SNI, policy,
//!      placeholders, then the address check (public, not this host's,
//!      not cubed's) -> upstream with the system roots
//! ```
//!
//! HTTPS on 443 is always terminated with a leaf of the runner's CA for the
//! ClientHello's SNI (the guest trusts the CA through `machine_setup`);
//! without SNI the flow is closed. A refusal is a 403 with `x-cube-denied`
//! (or the flow closed when no HTTP is spoken yet) and a report to cubed.
//! The LAN lives as long as the QEMU process: a new start or a restore gets
//! a new socket pair and LAN, and every flow of the old one is reset.
//!
//! When the lease runs out (presence.rs), new flows and new requests are
//! refused and every upstream connection of an open flow is closed: no
//! more egress. The guest's side of an open flow is left alone: what is
//! already on its way to the guest drains, and the connection then ends as
//! TCP ends it (the runner neither resets it nor discards its buffers).
//! Once cubed is back, an open flow's next request goes out again, and the
//! next time the lease runs out its upstreams are stopped again.
//!
//! A request a credential rule matches (B-5) never goes out from here: it
//! goes, placeholder and all, over a `credential` stream on cubed's newest
//! connection to cubed's proxy, which holds the token (runner.proto's
//! `CredentialHeader`). Without a connection, or when cubed refuses, it is
//! a 503 with `x-cube-error` and a `credential_unavailable` report, at
//! once (the lease does not apply). An answer under way when cubed goes
//! ends as an upstream failure does: what the runner already has drains to
//! the guest, then its connection ends.
use std::{
    os::fd::{AsRawFd, OwnedFd, RawFd},
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{Context as _, Result};
use bytes::Bytes;
use cube_netstack::{
    ca::Ca,
    dns,
    http::{
        HANDSHAKE_TIMEOUT, HostResolver, MAX_HEAD, Scheme as Authority, Upstream, UpstreamError,
        accept_tls, authority, strip_hop_by_hop,
    },
    lan::{
        Addressing, FlowHandler, FlowInfo, FlowStream, FrameSink, Lan, LanConfig, LanLimits,
        ResolveFuture, Resolver,
    },
    placeholder,
};
use cube_runner_protocol::{
    proto::{self, open},
    read_frame, write_frame,
};
use http::{HeaderValue, Method, Request, Response, StatusCode, Uri, header};
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::{body::Incoming, client::conn::http1::SendRequest, service::service_fn};
use hyper_util::rt::{TokioIo, TokioTimer};
use rustls::pki_types::ServerName;
use std::net::Ipv4Addr;
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::UnixDatagram,
    sync::mpsc,
    task::JoinHandle,
};

use super::{
    policy::{Denial, Policy, Route, Scheme},
    presence::{Presence, lease_restored, lease_runs_out},
    report::Reports,
};

/// keel's link (keel plan, "Network"; K9): the same for every machine.
pub const KEEL: Addressing = Addressing {
    gateway: Ipv4Addr::new(192, 168, 127, 1),
    guest: Ipv4Addr::new(192, 168, 127, 2),
    prefix: 24,
    dhcp: false,
};
/// The guest's MAC; the runner's side keeps netstack's 02:00:00:00:00:01.
pub const GUEST_MAC: &str = "02:00:00:00:00:02";
/// The kernel's own IPv4 setup (`CONFIG_IP_PNP`): address, no server, the
/// runner as gateway, the netmask, no hostname, eth0, no autoconfiguration.
pub fn kernel_ip() -> String {
    format!(
        "ip={}::{}:255.255.255.0::eth0:off",
        KEEL.guest, KEEL.gateway
    )
}

const HEADER_TIMEOUT: Duration = Duration::from_secs(60);
/// A credential stream must be open and answered by cubed within this.
const CREDENTIAL_OPEN_TIMEOUT: Duration = Duration::from_secs(10);
pub const DENIED_HEADER: &str = "x-cube-denied";
pub const ERROR_HEADER: &str = "x-cube-error";
/// Frames queued for QEMU before more are dropped (the guest retransmits).
const TO_QEMU: usize = 4096;

type Body = BoxBody<Bytes, hyper::Error>;

/// What every machine's egress shares.
pub struct Egress {
    pub ca: Arc<Ca>,
    pub upstream: Arc<Upstream>,
    pub presence: Arc<Presence>,
    pub reports: Arc<Reports>,
}

/// The machine's fence epoch as the runner last recorded it.
pub type FenceEpoch = Arc<dyn Fn() -> i64 + Send + Sync>;

/// One machine's egress: its policy (replaced by each `machine_start`) and
/// the flow handler of its LAN.
pub struct Gate {
    egress: Arc<Egress>,
    reference: proto::Ref,
    /// Shared with the copies flows hold, so a new policy reaches them.
    policy: Arc<Mutex<Arc<Policy>>>,
    fence: FenceEpoch,
}

impl Gate {
    pub fn new(
        egress: Arc<Egress>,
        reference: proto::Ref,
        policy: Policy,
        fence: FenceEpoch,
    ) -> Arc<Self> {
        Arc::new(Self {
            egress,
            reference,
            policy: Arc::new(Mutex::new(Arc::new(policy))),
            fence,
        })
    }

    pub fn replace(&self, policy: Policy) {
        *self.policy.lock().unwrap() = Arc::new(policy);
    }

    fn policy(&self) -> Arc<Policy> {
        self.policy.lock().unwrap().clone()
    }

    fn lease(&self) -> Duration {
        self.policy().lease
    }

    fn lease_expired(&self) -> bool {
        self.egress.presence.now().expired(self.lease())
    }

    fn report(&self, host: &str, denial: Denial) {
        self.egress
            .reports
            .push(&self.reference, host, denial.reason());
    }

    async fn serve(
        self: Arc<Self>,
        info: FlowInfo,
        stream: FlowStream,
        upstreams: Arc<Upstreams>,
    ) -> Result<()> {
        match info.destination.port() {
            443 => {
                let Some((name, tls)) = accept_tls(&self.egress.ca, stream).await? else {
                    return Ok(());
                };
                HttpConnection::new(self, Scheme::Https, Some(name), upstreams)
                    .serve(tls)
                    .await
            }
            80 => {
                HttpConnection::new(self, Scheme::Http, None, upstreams)
                    .serve(stream)
                    .await
            }
            _ => Ok(()),
        }
    }
}

impl FlowHandler for Gate {
    fn spawn(&self, info: FlowInfo, stream: FlowStream) {
        let this = Arc::new(Self {
            egress: self.egress.clone(),
            reference: self.reference.clone(),
            policy: self.policy.clone(),
            fence: self.fence.clone(),
        });
        if this.lease_expired() {
            // Before TLS: the dialled address is all there is to name.
            this.report(&info.destination.to_string(), Denial::LeaseExpired);
            return; // the stream drops: the guest's connection closes
        }
        let cubed = this.egress.presence.subscribe();
        tokio::spawn(async move {
            let gate = this.clone();
            let upstreams = Arc::new(Upstreams::default());
            // Guest-side failures (bad TLS, resets, timeouts) are routine
            // and only end this flow.
            let serve = this.serve(info, stream, upstreams.clone());
            tokio::pin!(serve);
            loop {
                tokio::select! {
                    _ = &mut serve => return,
                    _ = lease_runs_out(cubed.clone(), || gate.lease()) => {}
                }
                // The lease ran out: no more egress for this flow. Its guest
                // side goes on until it ends by itself.
                upstreams.stop();
                // cubed may come back while the guest keeps the flow open:
                // its next request goes out again, and the next time the
                // lease runs out its upstreams are stopped again.
                tokio::select! {
                    _ = &mut serve => return,
                    _ = lease_restored(cubed.clone(), || gate.lease()) => {}
                }
            }
        });
    }
}

/// Answers the guest's A queries from this host's resolver while egress
/// may run; once the lease ran out, SERVFAIL (no lookups without cubed).
pub struct GateResolver {
    gate: Arc<Gate>,
    inner: HostResolver,
}

impl GateResolver {
    pub fn new(gate: Arc<Gate>, upstream: Arc<Upstream>) -> Self {
        Self {
            gate,
            inner: HostResolver::new(upstream),
        }
    }
}

impl Resolver for GateResolver {
    fn resolve(&self, name: String) -> ResolveFuture {
        if self.gate.lease_expired() {
            return Box::pin(async { dns::Answer::ServFail });
        }
        self.inner.resolve(name)
    }
}

/// The upstream connections of one guest flow, closed when the lease runs
/// out. None opens while the lease is over: `client` reads the lease under
/// the same lock `stop` closes them under, and `stop` runs only once the
/// lease is over, so a connection either is closed by it or is refused.
/// Once cubed is back, the flow's next request opens one again.
#[derive(Default)]
struct Upstreams(Mutex<Vec<tokio::task::AbortHandle>>);

impl Upstreams {
    fn stop(&self) {
        for task in self.0.lock().unwrap().drain(..) {
            task.abort();
        }
    }

    /// An HTTP/1.1 client connection over `io`, driven on its own task that
    /// [`Self::stop`] ends; refused while `lease_expired()` says so.
    async fn client<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
        &self,
        io: S,
        lease_expired: impl Fn() -> bool,
    ) -> Result<SendRequest<Incoming>> {
        let (sender, connection) = hyper::client::conn::http1::Builder::new()
            .handshake(TokioIo::new(io))
            .await?;
        let task = tokio::spawn(async move {
            let _ = connection.await;
        });
        let mut tasks = self.0.lock().unwrap();
        if lease_expired() {
            task.abort();
            anyhow::bail!("egress lease expired");
        }
        tasks.retain(|t| !t.is_finished());
        tasks.push(task.abort_handle());
        Ok(sender)
    }
}

struct HttpConnection {
    gate: Arc<Gate>,
    upstreams: Arc<Upstreams>,
    scheme: Scheme,
    sni: Option<String>,
    /// One upstream connection per guest connection, reused while alive.
    upstream: tokio::sync::Mutex<Option<(String, SendRequest<Incoming>)>>,
}

impl HttpConnection {
    fn new(
        gate: Arc<Gate>,
        scheme: Scheme,
        sni: Option<String>,
        upstreams: Arc<Upstreams>,
    ) -> Arc<Self> {
        Arc::new(Self {
            gate,
            upstreams,
            scheme,
            sni,
            upstream: tokio::sync::Mutex::new(None),
        })
    }

    async fn serve<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
        self: Arc<Self>,
        io: S,
    ) -> Result<()> {
        let this = self.clone();
        hyper::server::conn::http1::Builder::new()
            .max_buf_size(MAX_HEAD)
            .timer(TokioTimer::new())
            .header_read_timeout(HEADER_TIMEOUT)
            .serve_connection(
                TokioIo::new(io),
                service_fn(move |request| {
                    let this = this.clone();
                    async move { Ok::<_, std::convert::Infallible>(this.handle(request).await) }
                }),
            )
            .await?;
        Ok(())
    }

    /// The host to name in a report before the request's own is known.
    fn connection_host(&self, request: &Request<Incoming>) -> String {
        self.sni.clone().unwrap_or_else(|| {
            request
                .headers()
                .get(header::HOST)
                .and_then(|h| h.to_str().ok())
                .unwrap_or("")
                .to_ascii_lowercase()
        })
    }

    fn deny(&self, host: &str, denial: Denial) -> Response<Body> {
        self.gate.report(host, denial);
        denied(StatusCode::FORBIDDEN, denial.message())
    }

    async fn handle(&self, mut request: Request<Incoming>) -> Response<Body> {
        if self.gate.lease_expired() {
            return self.deny(&self.connection_host(&request), Denial::LeaseExpired);
        }
        if request.method() == Method::CONNECT {
            return self.deny(&self.connection_host(&request), Denial::Connect);
        }
        if request.headers().contains_key(header::UPGRADE) {
            return self.deny(&self.connection_host(&request), Denial::Upgrade);
        }
        let expected = match &self.sni {
            Some(name) => Authority::Https(name.clone()),
            None => Authority::Http,
        };
        let (host, port) = match authority(&expected, &request) {
            Ok(target) => target,
            Err((status, reason)) => {
                if status == StatusCode::MISDIRECTED_REQUEST && self.sni.is_some() {
                    self.gate
                        .report(&self.connection_host(&request), Denial::SniMismatch);
                }
                return denied(status, reason);
            }
        };
        let placeholders = placeholder::scan_headers(request.headers());
        let route = match self
            .gate
            .policy()
            .decide(self.scheme, &host, port, &placeholders)
        {
            Ok(route) => route,
            Err(denial) => return self.deny(&host, denial),
        };
        strip_hop_by_hop(request.headers_mut());
        request.headers_mut().remove(header::PROXY_AUTHORIZATION);
        let path = request
            .uri()
            .path_and_query()
            .map(|p| p.as_str().to_string())
            .unwrap_or_else(|| "/".into());
        *request.uri_mut() = match path.parse::<Uri>() {
            Ok(uri) => uri,
            Err(_) => return denied(StatusCode::BAD_REQUEST, "invalid request target"),
        };
        if let Route::Credential(name) = route {
            return self.credential(request, &host, port, name).await;
        }
        let mut sender = match self.sender(&host, port).await {
            Ok(sender) => sender,
            Err(UpstreamError::NotPublic) => return self.deny(&host, Denial::Address),
            Err(UpstreamError::Failed(error)) => {
                let text = format!("{error:#}");
                if text.contains("resolv") || text.contains("has no address") {
                    self.gate.report(&host, Denial::ResolveFailed);
                }
                return failed(&text);
            }
        };
        let response = match sender.send_request(request).await {
            Ok(response) => response,
            Err(error) => return failed(&format!("upstream request failed: {error}")),
        };
        *self.upstream.lock().await = Some((format!("{host}:{port}"), sender));
        let (mut parts, body) = response.into_parts();
        strip_hop_by_hop(&mut parts.headers);
        Response::from_parts(parts, body.boxed())
    }

    /// A request a credential rule matched, over a `credential` stream to
    /// cubed's proxy (one request per stream; the guest's request as hyper
    /// writes it, the placeholder untouched).
    async fn credential(
        &self,
        request: Request<Incoming>,
        host: &str,
        port: u16,
        credential: String,
    ) -> Response<Body> {
        let unavailable = |message: &str| {
            self.gate.report(host, Denial::CredentialUnavailable);
            plain(StatusCode::SERVICE_UNAVAILABLE, ERROR_HEADER, message)
        };
        // Credential requests need cubed: no grace, no waiting for it.
        let Some(connection) = self.gate.egress.presence.connection() else {
            return unavailable(Denial::CredentialUnavailable.message());
        };
        let header = proto::CredentialHeader {
            r#ref: Some(self.gate.reference.clone()),
            credential,
            sni: host.to_owned(),
            host: host.to_owned(),
            port: port.into(),
            fence: Some(proto::Fence {
                epoch: (self.gate.fence)(),
            }),
        };
        let opened = tokio::time::timeout(CREDENTIAL_OPEN_TIMEOUT, async {
            let (mut send, mut recv) = connection.open_bi().await?;
            write_frame(
                &mut send,
                &proto::Open {
                    kind: Some(open::Kind::Credential(header)),
                },
            )
            .await?;
            let answer: proto::StreamAnswer = read_frame(&mut recv).await?;
            anyhow::Ok((send, recv, answer))
        })
        .await;
        let (send, recv) = match opened {
            Ok(Ok((send, recv, proto::StreamAnswer { error: None }))) => (send, recv),
            Ok(Ok((_, _, proto::StreamAnswer { error: Some(error) }))) => {
                return unavailable(&format!(
                    "cubed refused the credential request: {}",
                    error.message
                ));
            }
            Ok(Err(error)) => {
                return unavailable(&format!("the credential stream failed: {error:#}"));
            }
            Err(_) => return unavailable("cubed did not take the credential request in time"),
        };
        let exchange = async {
            let (mut sender, connection) = hyper::client::conn::http1::Builder::new()
                .handshake(TokioIo::new(tokio::io::join(recv, send)))
                .await?;
            tokio::spawn(async move {
                let _ = connection.await;
            });
            sender.send_request(request).await
        };
        match exchange.await {
            Ok(response) => {
                let (mut parts, body) = response.into_parts();
                strip_hop_by_hop(&mut parts.headers);
                Response::from_parts(parts, body.boxed())
            }
            Err(error) => failed(&format!("the credential request failed: {error}")),
        }
    }

    async fn sender(&self, host: &str, port: u16) -> Result<SendRequest<Incoming>, UpstreamError> {
        let key = format!("{host}:{port}");
        if let Some((existing, mut sender)) = self.upstream.lock().await.take()
            && existing == key
            && sender.ready().await.is_ok()
        {
            return Ok(sender);
        }
        let egress = &self.gate.egress;
        let avoid = egress.presence.cubed_addresses();
        let stream = egress.upstream.connect_avoiding(host, port, &avoid).await?;
        let handshake = async {
            match self.scheme {
                Scheme::Https => {
                    let name =
                        ServerName::try_from(host.to_string()).context("invalid server name")?;
                    let tls = tokio::time::timeout(
                        HANDSHAKE_TIMEOUT,
                        egress.upstream.connector().connect(name, stream),
                    )
                    .await
                    .context("upstream TLS timed out")?
                    .context("upstream TLS")?;
                    self.upstreams
                        .client(tls, || self.gate.lease_expired())
                        .await
                }
                Scheme::Http => {
                    self.upstreams
                        .client(stream, || self.gate.lease_expired())
                        .await
                }
            }
        };
        handshake.await.map_err(UpstreamError::Failed)
    }
}

fn header_text(reason: &str) -> HeaderValue {
    let clean: String = reason
        .chars()
        .filter(|c| (' '..='~').contains(c))
        .take(200)
        .collect();
    HeaderValue::from_str(&clean).unwrap_or_else(|_| HeaderValue::from_static("denied"))
}

fn plain(status: StatusCode, name: &'static str, reason: &str) -> Response<Body> {
    let mut response = Response::new(
        Full::new(Bytes::from(format!("cube runner: {reason}\n")))
            .map_err(|never| match never {})
            .boxed(),
    );
    *response.status_mut() = status;
    let headers = response.headers_mut();
    headers.insert(name, header_text(reason));
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    response
}

fn denied(status: StatusCode, reason: &str) -> Response<Body> {
    plain(status, DENIED_HEADER, reason)
}

fn failed(reason: &str) -> Response<Body> {
    plain(StatusCode::BAD_GATEWAY, ERROR_HEADER, reason)
}

/// A machine's network while its QEMU runs. Dropping it stops the LAN
/// (every flow reset) and the frame pump.
pub struct Net {
    lan: Lan,
    pub gate: Arc<Gate>,
    tasks: Vec<JoinHandle<()>>,
}

impl Drop for Net {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

struct ToQemu(mpsc::Sender<Bytes>);

impl FrameSink for ToQemu {
    fn send(&mut self, frame: &[u8]) {
        // Full: dropped; the guest's TCP retransmits.
        let _ = self.0.try_send(Bytes::copy_from_slice(frame));
    }
}

impl Net {
    /// TCP into the guest from the LAN's address (cubed's `dial` streams).
    pub fn dialer(&self) -> cube_netstack::lan::Dialer {
        self.lan.dialer()
    }

    /// The socket pair and the LAN for one QEMU process. Returns QEMU's end
    /// (close-on-exec; the spawn puts it on [`NET_FD`]).
    pub fn open(gate: Arc<Gate>, vm_id: &str) -> Result<(Self, OwnedFd)> {
        let (ours, theirs) = std::os::unix::net::UnixDatagram::pair()?;
        // macOS gives a Unix datagram socket 4 KiB of buffer: two frames.
        enlarge_buffers(ours.as_raw_fd());
        enlarge_buffers(theirs.as_raw_fd());
        ours.set_nonblocking(true)?;
        let socket = Arc::new(UnixDatagram::from_std(ours)?);
        let (to_qemu, mut frames) = mpsc::channel::<Bytes>(TO_QEMU);
        let lan = Lan::spawn_addressed(
            LanConfig {
                vm_id: vm_id.into(),
                mac: cube_netstack::lan::parse_mac(GUEST_MAC)?,
                limits: LanLimits::default(),
            },
            KEEL,
            Box::new(ToQemu(to_qemu)),
            gate.clone(),
            Arc::new(GateResolver::new(
                gate.clone(),
                gate.egress.upstream.clone(),
            )),
        );
        let input = lan.input();
        let reader = {
            let socket = socket.clone();
            tokio::spawn(async move {
                let mut buffer = vec![0u8; 65536];
                while let Ok(n) = socket.recv(&mut buffer).await {
                    input.push(Bytes::copy_from_slice(&buffer[..n]));
                }
            })
        };
        let writer = tokio::spawn(async move {
            while let Some(frame) = frames.recv().await {
                send_to_qemu(&socket, &frame).await;
            }
        });
        Ok((
            Self {
                lan,
                gate,
                tasks: vec![reader, writer],
            },
            OwnedFd::from(theirs),
        ))
    }
}

/// The descriptor QEMU finds its end of the socket pair on.
pub const NET_FD: RawFd = 3;

/// For the QEMU child between fork and exec: QEMU's end of the socket pair
/// on [`NET_FD`], without close-on-exec there only.
///
/// # Safety
/// Only async-signal-safe calls; run in `pre_exec`.
pub unsafe fn inherit(fd: RawFd) -> std::io::Result<()> {
    // SAFETY: dup2 and fcntl on descriptors the child has.
    unsafe {
        if fd == NET_FD {
            // dup2 onto itself would leave close-on-exec set.
            let flags = libc::fcntl(fd, libc::F_GETFD);
            if flags < 0 || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                return Err(std::io::Error::last_os_error());
            }
        } else if libc::dup2(fd, NET_FD) < 0 {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Unix datagram buffers are small on macOS; ask for 4 MiB (the kernel caps
/// it at its own limit). As cube-runner's pump does.
fn enlarge_buffers(fd: RawFd) {
    const SIZE: libc::c_int = 4 << 20;
    for option in [libc::SO_SNDBUF, libc::SO_RCVBUF] {
        // SAFETY: plain setsockopt on a socket this process owns.
        unsafe {
            libc::setsockopt(
                fd,
                libc::SOL_SOCKET,
                option,
                (&SIZE as *const libc::c_int).cast(),
                std::mem::size_of::<libc::c_int>() as libc::socklen_t,
            );
        }
    }
}

/// macOS answers ENOBUFS instead of blocking while QEMU's receive buffer is
/// full: retry by yielding, then briefly sleeping; a frame that still does
/// not fit is dropped (as cube-runner's pump does).
async fn send_to_qemu(socket: &UnixDatagram, frame: &[u8]) {
    for attempt in 0..300u32 {
        match socket.send(frame).await {
            Ok(_) => return,
            Err(e) if e.raw_os_error() == Some(libc::ENOBUFS) => {
                if attempt < 250 {
                    tokio::task::yield_now().await;
                } else {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            }
            Err(_) => return,
        }
    }
}

#[cfg(test)]
mod tests;
