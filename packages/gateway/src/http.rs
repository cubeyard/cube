//! The credential proxy's HTTP (credential.rs): one request per connection
//! from cubed, a runner's `credential` stream, as HTTPS for the stream's
//! server name. Each request is parsed by hyper, checked (`Host` must match
//! the server name, no CONNECT or Upgrade, every placeholder of the stream's
//! credential), decided by cubed, given its secret and sent over TLS to the
//! name's public address. The request asks for `Accept-Encoding: identity`,
//! an encoded answer is refused (502), and what the gateway substituted is
//! turned back into the guest's placeholder in the answer (B6, reverse.rs).
use anyhow::{Context as _, Result};
use bytes::Bytes;
use http::{HeaderMap, HeaderValue, Method, Request, Response, StatusCode, Uri, header};
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
    decide::{DecideClient, DecideRequest, Decision},
    reverse::{Pairs, Reversed},
    secrets,
};
#[cfg(feature = "test-hooks")]
pub use cube_netstack::http::TEST_HOST_ADDRESS;
use cube_netstack::http::{HANDSHAKE_TIMEOUT, Scheme, authority, client, strip_hop_by_hop};
pub use cube_netstack::http::{HostResolver, MAX_HEAD, Upstream, UpstreamError};

const HEADER_TIMEOUT: Duration = Duration::from_secs(60);
pub const DENIED_HEADER: &str = "x-cube-denied";
pub const ERROR_HEADER: &str = "x-cube-error";

type Body = BoxBody<Bytes, hyper::Error>;

/// Shared by every credential stream.
pub struct Egress {
    pub decide: Arc<DecideClient>,
    pub upstream: Arc<Upstream>,
}

/// One request of a runner's `credential` stream, as HTTPS for `sni`: the
/// credential proxy's connection (credential.rs).
pub async fn serve_credential<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    egress: Arc<Egress>,
    vm_id: String,
    thread_id: String,
    sni: String,
    credential: String,
    io: S,
) -> Result<()> {
    Arc::new(Connection {
        egress,
        vm_id,
        thread_id,
        scheme: Scheme::Https(sni),
        credential,
        upstream: Mutex::new(None),
    })
    .serve(io)
    .await
}

struct Connection {
    egress: Arc<Egress>,
    vm_id: String,
    thread_id: String,
    /// Always `Https` of the stream's server name.
    scheme: Scheme,
    /// The stream's credential name.
    credential: String,
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
            // A credential stream carries one request.
            .keep_alive(false)
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
        let name = &self.credential;
        if placeholders
            .iter()
            .any(|p| secrets::placeholder_name(p) != Some(name.as_str()))
        {
            return denied(
                StatusCode::FORBIDDEN,
                &format!("only {name} placeholders go through this credential"),
            );
        }
        // B6 reads every answer, so it must not be encoded.
        request.headers_mut().insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("identity"),
        );
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
        let basic = match secrets::substitute_headers(request.headers_mut(), &substitute) {
            Ok(basic) => basic,
            Err(_) => return denied(StatusCode::FORBIDDEN, "invalid secret substitution"),
        };
        // B6: exactly what was substituted, to turn back in the answer.
        let mut pairs = Pairs::default();
        for (placeholder, value) in &substitute {
            pairs.add(value.as_bytes(), placeholder.as_bytes());
        }
        for (upstream, guest) in basic {
            pairs.add(upstream, guest);
        }
        drop(substitute);
        let head = request.method() == Method::HEAD;
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
        if encoded(&parts.headers) {
            return failed("the credential proxy refuses an encoded answer");
        }
        if pairs.rewrite_headers(&mut parts.headers).is_err() {
            return failed("the answer's headers cannot carry the placeholder");
        }
        if pairs.is_empty() {
            return Response::from_parts(parts, body.boxed());
        }
        let bodiless = head
            || parts.status.is_informational()
            || parts.status == StatusCode::NO_CONTENT
            || parts.status == StatusCode::NOT_MODIFIED;
        if !bodiless && pairs.changes_length() {
            // The length may change: hyper sends the rewritten body chunked.
            parts.headers.remove(header::CONTENT_LENGTH);
        }
        Response::from_parts(parts, Reversed::new(body, pairs).boxed())
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

/// A `Content-Encoding` other than `identity`.
fn encoded(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::CONTENT_ENCODING)
        .iter()
        .flat_map(|v| v.as_bytes().split(|b| *b == b','))
        .map(|token| token.trim_ascii())
        .any(|token| !token.is_empty() && !token.eq_ignore_ascii_case(b"identity"))
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
