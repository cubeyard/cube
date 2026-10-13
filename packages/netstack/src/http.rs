//! The guest-facing and upstream halves of HTTP and HTTPS egress, without
//! policy or secrets.
//!
//! HTTPS is terminated with a leaf for the ClientHello's SNI ([`accept_tls`];
//! no SNI: nothing to serve). A request's target is checked against the
//! connection ([`authority`]: `Host` must match SNI, one `Host` only), and the
//! upstream is the SNI/Host name's public address ([`Upstream::connect`]).
//! What is allowed and what a request carries is the caller's decision.
use anyhow::{Result, anyhow, bail};
use http::{HeaderMap, Request, StatusCode, header};
use hyper::{body::Incoming, client::conn::http1::SendRequest};
use hyper_util::rt::TokioIo;
use rustls::{ClientConfig, RootCertStore};
#[cfg(feature = "test-hooks")]
use std::collections::HashMap;
use std::{
    collections::HashSet,
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::TcpStream,
};
use tokio_rustls::{LazyConfigAcceptor, TlsConnector, server::TlsStream};

use crate::{
    addr,
    ca::{self, Ca},
    dns,
    lan::{ResolveFuture, Resolver},
};

pub const MAX_HEAD: usize = 64 * 1024;
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// What the guest's DNS gets for a test-hooks host: any address works,
/// because the upstream comes from SNI/Host, never from the dialled IP.
#[cfg(feature = "test-hooks")]
pub const TEST_HOST_ADDRESS: std::net::Ipv4Addr = std::net::Ipv4Addr::new(203, 0, 113, 1);

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
        self.connect_avoiding(host, port, &HashSet::new()).await
    }

    /// [`Self::connect`], with `avoid` refused as this host's own addresses
    /// are (berth: the addresses it reaches cubed at).
    pub async fn connect_avoiding(
        &self,
        host: &str,
        port: u16,
        avoid: &HashSet<IpAddr>,
    ) -> Result<TcpStream, UpstreamError> {
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
                // Read per connection: the host's addresses can change, and
                // failing to read them refuses rather than guesses.
                let mut local = addr::local_addresses()
                    .map_err(|e| UpstreamError::Failed(anyhow!("reading local addresses: {e}")))?;
                local.extend(avoid.iter().copied());
                if resolved.iter().any(|a| !addr::is_upstream(a.ip(), &local)) {
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

    /// Upstream TLS against the roots this upstream trusts.
    pub fn connector(&self) -> TlsConnector {
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
                    // Private and host-local addresses are never useful to
                    // the guest (the gateway refuses them) and would leak the
                    // host's network.
                    let local = addr::local_addresses().unwrap_or_default();
                    let v4: Vec<_> = addresses
                        .filter_map(|a| match a.ip() {
                            IpAddr::V4(v4) if addr::is_upstream(a.ip(), &local) => Some(v4),
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

/// Terminates TLS with a leaf for the ClientHello's SNI, returning the
/// lowercased SNI name and the stream. Without SNI there is nothing to name
/// the upstream by: `None`, and the caller closes the flow.
pub async fn accept_tls<S: AsyncRead + AsyncWrite + Unpin>(
    ca: &Ca,
    stream: S,
) -> Result<Option<(String, TlsStream<S>)>> {
    let acceptor = LazyConfigAcceptor::new(rustls::server::Acceptor::default(), stream);
    let start = tokio::time::timeout(HANDSHAKE_TIMEOUT, acceptor).await??;
    let Some(name) = start
        .client_hello()
        .server_name()
        .map(str::to_ascii_lowercase)
    else {
        return Ok(None);
    };
    let config = ca.server_config(&name)?;
    let tls = tokio::time::timeout(HANDSHAKE_TIMEOUT, start.into_stream(config)).await??;
    Ok(Some((name, tls)))
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Scheme {
    Http,
    /// The SNI name.
    Https(String),
}

/// The request's host and port. For HTTPS the host must equal the SNI
/// name (else 421); the port must be the one the guest dialled.
pub fn authority<B>(
    scheme: &Scheme,
    request: &Request<B>,
) -> Result<(String, u16), (StatusCode, &'static str)> {
    // RFC 9112 section 3.2: more than one Host is a 400. Otherwise a
    // second Host could route a substituted secret past the SNI check.
    if request.headers().get_all(header::HOST).iter().count() > 1 {
        return Err((StatusCode::BAD_REQUEST, "more than one Host header"));
    }
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
    let default_port = match scheme {
        Scheme::Https(_) => 443,
        Scheme::Http => 80,
    };
    let port = authority.port_u16().unwrap_or(default_port);
    if host.is_empty() || host.starts_with('[') {
        return Err((StatusCode::BAD_REQUEST, "unsupported Host"));
    }
    match scheme {
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

/// An HTTP/1.1 client connection over `io`, driven on its own task.
pub async fn client<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
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

/// Removes hop-by-hop headers: those `Connection` lists and the fixed set.
pub fn strip_hop_by_hop(headers: &mut HeaderMap) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    fn request(target: &str, hosts: &[&str]) -> Request<()> {
        let mut builder = Request::builder().uri(target);
        for host in hosts {
            builder = builder.header(header::HOST, *host);
        }
        builder.body(()).unwrap()
    }

    fn https(sni: &str) -> Scheme {
        Scheme::Https(sni.into())
    }

    #[test]
    fn the_host_names_the_upstream_and_must_match_the_connection() {
        let ok =
            |scheme: &Scheme, target, hosts: &[&str]| authority(scheme, &request(target, hosts));
        assert_eq!(
            ok(&https("example.com"), "/", &["Example.COM."]),
            Ok(("example.com".into(), 443))
        );
        assert_eq!(
            ok(&https("example.com"), "/", &["example.com:443"]),
            Ok(("example.com".into(), 443))
        );
        assert_eq!(
            ok(&Scheme::Http, "/x", &["example.com"]),
            Ok(("example.com".into(), 80))
        );
        assert_eq!(
            ok(&Scheme::Http, "http://example.com/x", &[]),
            Ok(("example.com".into(), 80))
        );
        for (scheme, target, hosts, status, reason) in [
            (
                https("example.com"),
                "/",
                vec!["example.com", "example.com"],
                400,
                "more than one Host header",
            ),
            (
                https("example.com"),
                "/",
                vec![],
                400,
                "missing Host header",
            ),
            (
                https("example.com"),
                "https://a.example/",
                vec!["b.example"],
                400,
                "request target and Host differ",
            ),
            (
                https("example.com"),
                "/",
                vec!["user@example.com"],
                400,
                "invalid Host header",
            ),
            (
                https("example.com"),
                "/",
                vec!["[::1]"],
                400,
                "unsupported Host",
            ),
            (
                https("example.com"),
                "/",
                vec!["other.example"],
                421,
                "Host does not match the TLS server name",
            ),
            (
                https("example.com"),
                "/",
                vec!["example.com:8443"],
                421,
                "Host does not match the TLS server name",
            ),
            (
                Scheme::Http,
                "/",
                vec!["example.com:8080"],
                421,
                "Host port does not match the connection",
            ),
        ] {
            let got = ok(&scheme, target, &hosts);
            assert_eq!(
                got,
                Err((StatusCode::from_u16(status).unwrap(), reason)),
                "{scheme:?} {target} {hosts:?}"
            );
        }
    }

    #[test]
    fn hop_by_hop_headers_are_removed() {
        let mut headers = HeaderMap::new();
        for (name, value) in [
            ("connection", "close, X-Listed"),
            ("x-listed", "1"),
            ("keep-alive", "timeout=5"),
            ("proxy-connection", "keep-alive"),
            ("te", "trailers"),
            ("trailer", "x"),
            ("transfer-encoding", "chunked"),
            ("upgrade", "websocket"),
            ("proxy-authenticate", "Basic"),
            ("authorization", "Bearer kept"),
            ("x-other", "kept"),
        ] {
            headers.append(name, HeaderValue::from_static(value));
        }
        strip_hop_by_hop(&mut headers);
        let mut left: Vec<_> = headers.keys().map(|k| k.as_str()).collect();
        left.sort();
        assert_eq!(left, ["authorization", "x-other"]);
    }
}
