//! HTTP and HTTPS egress for guest flows to ports 80 and 443.
//!
//! HTTPS is terminated with a leaf for the ClientHello's SNI (no SNI: the
//! flow is closed). Each request is parsed by hyper, checked (`Host` must
//! match SNI, no CONNECT or Upgrade), decided by cubed, given its secrets and
//! sent to the SNI/Host name's public address. Bodies stream unmodified.
use anyhow::{Context as _, Result, anyhow, bail};
use bytes::Bytes;
use http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode, Uri, header};
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::{body::Incoming, client::conn::http1::SendRequest, service::service_fn};
use hyper_util::rt::{TokioIo, TokioTimer};
use rustls::{ClientConfig, RootCertStore, pki_types::ServerName};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
    sync::Mutex,
};
use tokio_rustls::{LazyConfigAcceptor, TlsConnector};

use crate::{
    addr,
    ca::{self, Ca},
    decide::{DecideClient, DecideRequest, Decision},
    dns,
    lan::{FlowHandler, FlowInfo, FlowStream, ResolveFuture, Resolver},
    secrets,
};

pub const MAX_HEAD: usize = 64 * 1024;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const HEADER_TIMEOUT: Duration = Duration::from_secs(60);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
pub const DENIED_HEADER: &str = "x-cube-denied";
pub const ERROR_HEADER: &str = "x-cube-error";
/// What the guest's DNS gets for a test-hooks host: any address works,
/// because the upstream comes from SNI/Host, never from the dialled IP.
#[cfg(feature = "test-hooks")]
pub const TEST_HOST_ADDRESS: std::net::Ipv4Addr = std::net::Ipv4Addr::new(203, 0, 113, 1);

type Body = BoxBody<Bytes, hyper::Error>;

/// How the gateway reaches upstream hosts.
pub struct Upstream {
    tls: Arc<ClientConfig>,
    #[cfg(feature = "test-hooks")]
    overrides: HashMap<String, SocketAddr>,
}

#[derive(Debug)]
pub enum UpstreamError {
    NotPublic,
    Failed(anyhow::Error),
}

impl Upstream {
    /// Upstream TLS verifies against the system roots.
    pub fn system() -> Result<Self> {
        let mut roots = RootCertStore::empty();
        let native = rustls_native_certs::load_native_certs();
        for cert in native.certs {
            let _ = roots.add(cert);
        }
        if roots.is_empty() {
            bail!("no system root certificates found");
        }
        Self::with_roots(roots)
    }

    pub fn with_roots(roots: RootCertStore) -> Result<Self> {
        let mut tls = ClientConfig::builder_with_provider(ca::provider())
            .with_safe_default_protocol_versions()?
            .with_root_certificates(roots)
            .with_no_client_auth();
        tls.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(Self {
            tls: Arc::new(tls),
            #[cfg(feature = "test-hooks")]
            overrides: HashMap::new(),
        })
    }

    /// Test hooks: `host` is reached at `address` regardless of the public
    /// address check, and `roots` are trusted in addition.
    #[cfg(feature = "test-hooks")]
    pub fn with_test_hooks(
        roots: RootCertStore,
        overrides: HashMap<String, SocketAddr>,
    ) -> Result<Self> {
        let mut upstream = Self::with_roots(roots)?;
        upstream.overrides = overrides;
        Ok(upstream)
    }

    #[cfg(feature = "test-hooks")]
    fn test_override(&self, host: &str) -> Option<SocketAddr> {
        self.overrides.get(host).copied()
    }
    #[cfg(not(feature = "test-hooks"))]
    fn test_override(&self, _: &str) -> Option<SocketAddr> {
        None
    }

    /// Resolves `host` and connects to it. Every resolved address must be
    /// public unicast, otherwise nothing is dialled.
    pub async fn connect(&self, host: &str, port: u16) -> Result<TcpStream, UpstreamError> {
        let addresses: Vec<SocketAddr> = match self.test_override(host) {
            Some(address) => vec![address],
            None => {
                let resolved: Vec<SocketAddr> =
                    tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::lookup_host((host, port)))
                        .await
                        .map_err(|_| UpstreamError::Failed(anyhow!("resolving {host} timed out")))?
                        .map_err(|e| UpstreamError::Failed(anyhow!("resolve {host}: {e}")))?
                        .collect();
                if resolved.is_empty() {
                    return Err(UpstreamError::Failed(anyhow!("{host} has no address")));
                }
                if resolved.iter().any(|a| !addr::is_public(a.ip())) {
                    return Err(UpstreamError::NotPublic);
                }
                resolved
            }
        };
        let mut last = anyhow!("no address");
        for address in addresses {
            match tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect(address)).await {
                Ok(Ok(stream)) => {
                    let _ = stream.set_nodelay(true);
                    return Ok(stream);
                }
                Ok(Err(e)) => last = anyhow!("connect {address}: {e}"),
                Err(_) => last = anyhow!("connect {address}: timed out"),
            }
        }
        Err(UpstreamError::Failed(last))
    }

    fn connector(&self) -> TlsConnector {
        TlsConnector::from(self.tls.clone())
    }
}

/// The guest's DNS: public A records from the host resolver.
pub struct HostResolver {
    upstream: Arc<Upstream>,
}

impl HostResolver {
    pub fn new(upstream: Arc<Upstream>) -> Self {
        Self { upstream }
    }
}

impl Resolver for HostResolver {
    fn resolve(&self, name: String) -> ResolveFuture {
        #[cfg(feature = "test-hooks")]
        if self.upstream.test_override(&name).is_some() {
            return Box::pin(async { dns::Answer::A(vec![TEST_HOST_ADDRESS]) });
        }
        let _ = &self.upstream;
        Box::pin(async move {
            match tokio::net::lookup_host((name.as_str(), 0)).await {
                Ok(addresses) => {
                    // Private addresses are never useful to the guest (the
                    // gateway refuses them) and would leak the host's network.
                    let v4: Vec<_> = addresses
                        .filter_map(|a| match a.ip() {
                            IpAddr::V4(v4) if addr::is_public(a.ip()) => Some(v4),
                            _ => None,
                        })
                        .collect();
                    if v4.is_empty() {
                        dns::Answer::Empty
                    } else {
                        dns::Answer::A(v4)
                    }
                }
                Err(e) => {
                    let text = e.to_string();
                    if text.contains("not known") || text.contains("No address") {
                        dns::Answer::NxDomain
                    } else {
                        dns::Answer::ServFail
                    }
                }
            }
        })
    }
}

/// Shared by every VM.
pub struct Egress {
    pub ca: Arc<Ca>,
    pub decide: Arc<DecideClient>,
    pub upstream: Arc<Upstream>,
}

/// Flow handler of one VM's LAN.
pub struct VmEgress {
    egress: Arc<Egress>,
    vm_id: String,
    thread_id: String,
}

impl VmEgress {
    pub fn new(egress: Arc<Egress>, vm_id: String, thread_id: String) -> Self {
        Self {
            egress,
            vm_id,
            thread_id,
        }
    }
}

impl FlowHandler for VmEgress {
    fn spawn(&self, info: FlowInfo, stream: FlowStream) {
        let connection = Arc::new(Connection {
            egress: self.egress.clone(),
            vm_id: self.vm_id.clone(),
            thread_id: self.thread_id.clone(),
            scheme: if info.destination.port() == 443 {
                Scheme::Https(String::new())
            } else {
                Scheme::Http
            },
            upstream: Mutex::new(None),
        });
        tokio::spawn(async move {
            let result = match info.destination.port() {
                443 => connection.serve_tls(stream).await,
                80 => connection.serve(stream).await,
                _ => Ok(()),
            };
            if let Err(error) = result {
                // Guest-side failures (bad TLS, resets) are routine.
                let _ = error;
            }
        });
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Scheme {
    Http,
    /// The SNI name.
    Https(String),
}

struct Connection {
    egress: Arc<Egress>,
    vm_id: String,
    thread_id: String,
    scheme: Scheme,
    /// One upstream connection per guest connection, reused while alive.
    upstream: Mutex<Option<(String, SendRequest<Incoming>)>>,
}

impl Connection {
    async fn serve_tls(self: Arc<Self>, stream: FlowStream) -> Result<()> {
        let acceptor = LazyConfigAcceptor::new(rustls::server::Acceptor::default(), stream);
        let start = tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor).await??;
        let Some(name) = start
            .client_hello()
            .server_name()
            .map(str::to_ascii_lowercase)
        else {
            // No SNI: nothing to name the upstream by.
            return Ok(());
        };
        let config = self.egress.ca.server_config(&name)?;
        let tls = tokio::time::timeout(HANDSHAKE_TIMEOUT, start.into_stream(config)).await??;
        let connection = Arc::new(Connection {
            egress: self.egress.clone(),
            vm_id: self.vm_id.clone(),
            thread_id: self.thread_id.clone(),
            scheme: Scheme::Https(name),
            upstream: Mutex::new(None),
        });
        connection.serve(tls).await
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

    async fn handle(&self, mut request: Request<Incoming>) -> Response<Body> {
        if request.method() == Method::CONNECT {
            return denied(StatusCode::FORBIDDEN, "CONNECT is not supported");
        }
        if request.headers().contains_key(header::UPGRADE) {
            return denied(StatusCode::FORBIDDEN, "protocol upgrades are not supported");
        }
        let (host, port) = match self.authority(&request) {
            Ok(target) => target,
            Err((status, reason)) => return denied(status, reason),
        };
        let https = matches!(self.scheme, Scheme::Https(_));
        let placeholders = secrets::scan_headers(request.headers());
        let decision = self
            .egress
            .decide
            .decide(&DecideRequest {
                vm_id: self.vm_id.clone(),
                thread_id: self.thread_id.clone(),
                scheme: if https { "https" } else { "http" },
                method: request.method().as_str().to_string(),
                host: host.clone(),
                port,
                path: request.uri().path().to_string(),
                placeholders: placeholders.clone(),
            })
            .await;
        let substitute = match decision {
            Decision::Deny { reason } => return denied(StatusCode::FORBIDDEN, &reason),
            Decision::Allow { substitute } => substitute,
        };
        // Only placeholders actually present are replaced, and only over TLS.
        let substitute: HashMap<String, String> = substitute
            .into_iter()
            .filter(|(k, _)| placeholders.contains(k))
            .collect();
        if !substitute.is_empty() && !https {
            return denied(StatusCode::FORBIDDEN, "secrets are only sent over https");
        }
        if secrets::substitute_headers(request.headers_mut(), &substitute).is_err() {
            return denied(StatusCode::FORBIDDEN, "invalid secret substitution");
        }
        drop(substitute);
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
        let mut sender = match self.sender(&host, port).await {
            Ok(sender) => sender,
            Err(UpstreamError::NotPublic) => {
                return denied(StatusCode::FORBIDDEN, "upstream address is not public");
            }
            Err(UpstreamError::Failed(error)) => return failed(&format!("{error:#}")),
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

    /// The request's host and port. For HTTPS the host must equal the SNI
    /// name (else 421); the port must be the one the guest dialled.
    fn authority(
        &self,
        request: &Request<Incoming>,
    ) -> Result<(String, u16), (StatusCode, &'static str)> {
        let from_header = request
            .headers()
            .get(header::HOST)
            .map(|h| {
                h.to_str()
                    .map_err(|_| (StatusCode::BAD_REQUEST, "invalid Host header"))
            })
            .transpose()?;
        let from_uri = request.uri().authority().map(|a| a.as_str());
        let raw = match (from_uri, from_header) {
            (Some(u), Some(h)) if !u.eq_ignore_ascii_case(h) => {
                return Err((StatusCode::BAD_REQUEST, "request target and Host differ"));
            }
            (Some(a), _) | (None, Some(a)) => a,
            (None, None) => return Err((StatusCode::BAD_REQUEST, "missing Host header")),
        };
        let authority: http::uri::Authority = raw
            .parse()
            .map_err(|_| (StatusCode::BAD_REQUEST, "invalid Host header"))?;
        if raw.contains('@') {
            return Err((StatusCode::BAD_REQUEST, "invalid Host header"));
        }
        let host = authority.host().trim_end_matches('.').to_ascii_lowercase();
        let default_port = match self.scheme {
            Scheme::Https(_) => 443,
            Scheme::Http => 80,
        };
        let port = authority.port_u16().unwrap_or(default_port);
        if host.is_empty() || host.starts_with('[') {
            return Err((StatusCode::BAD_REQUEST, "unsupported Host"));
        }
        match &self.scheme {
            Scheme::Https(sni) if *sni != host || port != 443 => Err((
                StatusCode::MISDIRECTED_REQUEST,
                "Host does not match the TLS server name",
            )),
            Scheme::Http if port != 80 => Err((
                StatusCode::MISDIRECTED_REQUEST,
                "Host port does not match the connection",
            )),
            _ => Ok((host, port)),
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
        let stream = self.egress.upstream.connect(host, port).await?;
        let handshake = async {
            match &self.scheme {
                Scheme::Https(_) => {
                    let name =
                        ServerName::try_from(host.to_string()).context("invalid server name")?;
                    let tls = tokio::time::timeout(
                        HANDSHAKE_TIMEOUT,
                        self.egress.upstream.connector().connect(name, stream),
                    )
                    .await
                    .context("upstream TLS timed out")?
                    .context("upstream TLS")?;
                    client(tls).await
                }
                Scheme::Http => client(stream).await,
            }
        };
        handshake.await.map_err(UpstreamError::Failed)
    }
}

async fn client<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    io: S,
) -> Result<SendRequest<Incoming>> {
    let (sender, connection) = hyper::client::conn::http1::Builder::new()
        .handshake(TokioIo::new(io))
        .await?;
    tokio::spawn(async move {
        let _ = connection.await;
    });
    Ok(sender)
}

fn strip_hop_by_hop(headers: &mut HeaderMap) {
    let listed: Vec<String> = headers
        .get_all(header::CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    for name in listed {
        if let Ok(name) = header::HeaderName::from_bytes(name.as_bytes()) {
            headers.remove(name);
        }
    }
    for name in [
        header::CONNECTION,
        header::TE,
        header::TRAILER,
        header::TRANSFER_ENCODING,
        header::UPGRADE,
        header::PROXY_AUTHENTICATE,
    ] {
        headers.remove(name);
    }
    headers.remove("keep-alive");
    headers.remove("proxy-connection");
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
        Full::new(Bytes::from(format!("cube gateway: {reason}\n")))
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
