//! HTTP and HTTPS egress for guest flows to ports 80 and 443.
//!
//! HTTPS is terminated with a leaf for the ClientHello's SNI (no SNI: the
//! flow is closed). Each request is parsed by hyper, checked (`Host` must
//! match SNI, no CONNECT or Upgrade), decided by cubed, given its secrets and
//! sent to the SNI/Host name's public address. Bodies stream unmodified.
use anyhow::{Context as _, Result};
use bytes::Bytes;
use http::{HeaderValue, Method, Request, Response, StatusCode, Uri, header};
use http_body_util::{BodyExt, Full, combinators::BoxBody};
use hyper::{body::Incoming, client::conn::http1::SendRequest, service::service_fn};
use hyper_util::rt::{TokioIo, TokioTimer};
use rustls::pki_types::ServerName;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::Mutex,
};

use crate::{
    ca::Ca,
    decide::{DecideClient, DecideRequest, Decision},
    lan::{FlowHandler, FlowInfo, FlowStream},
    secrets,
};
#[cfg(feature = "test-hooks")]
pub use cube_netstack::http::TEST_HOST_ADDRESS;
use cube_netstack::http::{
    HANDSHAKE_TIMEOUT, Scheme, accept_tls, authority, client, strip_hop_by_hop,
};
pub use cube_netstack::http::{HostResolver, MAX_HEAD, Upstream, UpstreamError};

const HEADER_TIMEOUT: Duration = Duration::from_secs(60);
pub const DENIED_HEADER: &str = "x-cube-denied";
pub const ERROR_HEADER: &str = "x-cube-error";

type Body = BoxBody<Bytes, hyper::Error>;

/// Shared by every VM.
pub struct Egress {
    pub ca: Arc<Ca>,
    pub decide: Arc<DecideClient>,
    pub upstream: Arc<Upstream>,
}

/// Flow handler of one VM's LAN.
#[derive(Clone)]
pub struct VmEgress {
    egress: Arc<Egress>,
    vm_id: String,
    thread_id: String,
}

impl VmEgress {
    pub fn new(egress: Arc<Egress>, vm_id: String, thread_id: String) -> Arc<Self> {
        Arc::new(Self {
            egress,
            vm_id,
            thread_id,
        })
    }
}

impl VmEgress {
    fn connection(&self, scheme: Scheme) -> Arc<Connection> {
        Arc::new(Connection {
            egress: self.egress.clone(),
            vm_id: self.vm_id.clone(),
            thread_id: self.thread_id.clone(),
            scheme,
            upstream: Mutex::new(None),
        })
    }

    /// Terminates TLS with a leaf for the ClientHello's SNI. Without SNI
    /// there is nothing to name the upstream by, so the flow is closed.
    async fn serve_tls(self: Arc<Self>, stream: FlowStream) -> Result<()> {
        let Some((name, tls)) = accept_tls(&self.egress.ca, stream).await? else {
            return Ok(());
        };
        self.connection(Scheme::Https(name)).serve(tls).await
    }
}

impl FlowHandler for VmEgress {
    fn spawn(&self, info: FlowInfo, stream: FlowStream) {
        let this = Arc::new(self.clone());
        tokio::spawn(async move {
            // Guest-side failures (bad TLS, resets, timeouts) are routine and
            // only end this flow.
            let _ = match info.destination.port() {
                443 => this.serve_tls(stream).await,
                80 => this.connection(Scheme::Http).serve(stream).await,
                _ => Ok(()),
            };
        });
    }
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
        let (host, port) = match authority(&self.scheme, &request) {
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
