//! The model channel: claude-code threads' model traffic. cubed starts each
//! `claude` child with `ANTHROPIC_BASE_URL=http://127.0.0.1:PORT/t/<thread>`
//! and `CLAUDE_CODE_OAUTH_TOKEN=<the thread's claude placeholder>`; this
//! listener (loopback only) takes those requests and sends them to
//! api.anthropic.com with the host's token.
//!
//! ```text
//! request  /t/<thread><route>
//!   route not on ROUTES                        404, recorded
//!   no placeholder, or not one claude one      401 / 403, recorded
//!   cubed's decision (channel "model", 5 s, fail closed) denies   403, recorded
//!   the token substituted; upstream over TLS from this host (public only)
//! answer   streamed as it comes, B6 turning the token back (reverse.rs),
//!          and recorded per thread (audit.rs) when it ends
//! ```
//!
//! Any local process can connect, so the placeholder is what authorizes a
//! request, and cubed checks it belongs to the thread the path names.
use anyhow::{Context as _, Result, ensure};
use bytes::Bytes;
use http::{HeaderValue, Request, Response, StatusCode, Uri, header};
use http_body_util::{BodyExt, Full, Limited, combinators::BoxBody};
use hyper::{
    body::{Body as HttpBody, Frame, Incoming, SizeHint},
    client::conn::http1::SendRequest,
    service::service_fn,
};
use hyper_util::rt::{TokioIo, TokioTimer};
use rustls::pki_types::ServerName;
use std::{
    collections::HashMap,
    net::SocketAddr,
    pin::Pin,
    sync::Arc,
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    net::{TcpListener, TcpStream},
    sync::watch,
    task::JoinSet,
};

use crate::{
    audit::{Audit, Captured, End, MAX_BODY, Outcome, Start, kept_headers, now_ms},
    decide::{DecideClient, DecideRequest, Decision},
    http::{MAX_HEAD, Upstream, UpstreamError, denied, encoded, failed},
    reverse::{Pairs, Reversed},
    secrets,
};
use cube_netstack::http::{HANDSHAKE_TIMEOUT, strip_hop_by_hop};

/// The only upstream of the channel.
pub const HOST: &str = "api.anthropic.com";
/// The routes Claude Code uses for a thread's model, as method and path
/// (any query). Every other request is refused and recorded.
pub const ROUTES: &[(&str, &str)] = &[
    ("POST", "/v1/messages"),
    ("POST", "/v1/messages/count_tokens"),
];
/// The secret name of the channel's placeholders.
pub const CREDENTIAL: &str = "claude";
/// On stop, how long answers still streaming may go on; then they are cut.
/// With FLUSH_LIMIT it stays inside cubed's 5 s between SIGTERM and SIGKILL
/// (packages/server/src/gateway.ts `stop`).
pub const SHUTDOWN_GRACE: Duration = Duration::from_secs(3);
/// On stop, how long the audit writer may take to drain.
pub const FLUSH_LIMIT: Duration = Duration::from_secs(1);
const HEADER_TIMEOUT: Duration = Duration::from_secs(60);
/// A request body must arrive whole within this.
const BODY_TIMEOUT: Duration = Duration::from_secs(60);

type Body = BoxBody<Bytes, hyper::Error>;

pub struct ModelChannel {
    pub decide: Arc<DecideClient>,
    pub upstream: Arc<Upstream>,
    pub audit: Audit,
}

/// Binds the listener; only a loopback address is accepted.
pub async fn bind(address: SocketAddr) -> Result<TcpListener> {
    ensure!(
        address.ip().is_loopback(),
        "the model channel listens on loopback only, not {address}"
    );
    TcpListener::bind(address)
        .await
        .with_context(|| format!("bind {address}"))
}

/// Serves the listener until `stop` turns true; then it accepts no more,
/// lets open exchanges end for SHUTDOWN_GRACE and drops the connections
/// still open (their answers are recorded as cut).
pub async fn serve(
    listener: TcpListener,
    channel: Arc<ModelChannel>,
    mut stop: watch::Receiver<bool>,
) -> Result<()> {
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let (stream, _) = accepted?;
                let channel = channel.clone();
                connections.spawn(async move {
                    if let Err(error) = connection(stream, channel).await {
                        eprintln!("cube-gateway: model channel connection: {error:#}");
                    }
                });
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
            _ = stop.wait_for(|stop| *stop) => break,
        }
    }
    drop(listener);
    if !channel.audit.idle(SHUTDOWN_GRACE).await {
        eprintln!(
            "cube-gateway: model channel stopping with {} answer(s) still streaming; they are cut",
            channel.audit.open_exchanges()
        );
    }
    connections.abort_all();
    while connections.join_next().await.is_some() {}
    Ok(())
}

async fn connection(stream: TcpStream, channel: Arc<ModelChannel>) -> Result<()> {
    let connection = Arc::new(Connection {
        channel,
        upstream: tokio::sync::Mutex::new(None),
    });
    hyper::server::conn::http1::Builder::new()
        .max_buf_size(MAX_HEAD)
        .timer(TokioTimer::new())
        .header_read_timeout(HEADER_TIMEOUT)
        .serve_connection(
            TokioIo::new(stream),
            service_fn(move |request| {
                let connection = connection.clone();
                async move { Ok::<_, std::convert::Infallible>(connection.handle(request).await) }
            }),
        )
        .await?;
    Ok(())
}

/// `/t/<thread><route>`: the thread and the route, or None.
pub fn target(path: &str) -> Option<(&str, &str)> {
    let rest = path.strip_prefix("/t/")?;
    let slash = rest.find('/')?;
    let (thread, route) = rest.split_at(slash);
    let valid = !thread.is_empty()
        && thread.len() <= 128
        && thread
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    valid.then_some((thread, route))
}

struct Connection {
    channel: Arc<ModelChannel>,
    /// One upstream connection per child connection, reused while alive.
    upstream: tokio::sync::Mutex<Option<SendRequest<Full<Bytes>>>>,
}

impl Connection {
    async fn handle(&self, request: Request<Incoming>) -> Response<Body> {
        let method = request.method().as_str().to_string();
        let path = request.uri().path().to_string();
        let query = request.uri().query().map(|q| format!("?{q}"));
        let (thread, route) = target(&path).unwrap_or(("", path.as_str()));
        let start = Start {
            thread: thread.to_string(),
            at_ms: now_ms(),
            method: method.clone(),
            route: format!("{route}{}", query.as_deref().unwrap_or("")),
            request_headers: kept_headers(request.headers(), true),
            request: None,
        };
        if thread.is_empty() {
            return self.refuse(
                start,
                StatusCode::NOT_FOUND,
                "model requests go to /t/<thread>/…",
            );
        }
        if !ROUTES.contains(&(method.as_str(), route)) {
            let reason = format!("{method} {route} is not a model route cube allows");
            return self.refuse(start, StatusCode::NOT_FOUND, &reason);
        }
        if request.headers().contains_key(header::UPGRADE) {
            return self.refuse(
                start,
                StatusCode::FORBIDDEN,
                "protocol upgrades are not supported",
            );
        }
        let placeholders = secrets::scan_headers(request.headers());
        if placeholders.is_empty() {
            return self.refuse(
                start,
                StatusCode::UNAUTHORIZED,
                "the thread's claude placeholder is missing",
            );
        }
        if placeholders.len() != 1
            || secrets::placeholder_name(&placeholders[0]) != Some(CREDENTIAL)
        {
            return self.refuse(
                start,
                StatusCode::FORBIDDEN,
                "only the thread's one claude placeholder goes through the model channel",
            );
        }
        let decision = self
            .channel
            .decide
            .decide(&DecideRequest {
                vm_id: String::new(),
                thread_id: thread.to_string(),
                scheme: "https",
                method: method.clone(),
                host: HOST.into(),
                port: 443,
                path: route.to_string(),
                placeholders: placeholders.clone(),
                channel: Some("model"),
            })
            .await;
        let substitute: HashMap<String, String> = match decision {
            Decision::Deny { reason } => return self.refuse(start, StatusCode::FORBIDDEN, &reason),
            Decision::Allow { substitute } => substitute
                .into_iter()
                .filter(|(k, _)| placeholders.contains(k))
                .collect(),
        };
        if substitute.is_empty() {
            return self.refuse(
                start,
                StatusCode::FORBIDDEN,
                "cubed gave no claude token for this request",
            );
        }
        let target = format!("{route}{}", query.as_deref().unwrap_or(""));
        self.forward(request, start, target, substitute).await
    }

    async fn forward(
        &self,
        request: Request<Incoming>,
        mut start: Start,
        target: String,
        substitute: HashMap<String, String>,
    ) -> Response<Body> {
        let (mut parts, body) = request.into_parts();
        let body = match tokio::time::timeout(BODY_TIMEOUT, Limited::new(body, MAX_BODY).collect())
            .await
        {
            Ok(Ok(body)) => body.to_bytes(),
            Ok(Err(error)) if error.is::<http_body_util::LengthLimitError>() => {
                let reason = format!("the request body is over {} MiB", MAX_BODY >> 20);
                return self.refuse(start, StatusCode::PAYLOAD_TOO_LARGE, &reason);
            }
            Ok(Err(_)) | Err(_) => {
                return self.refuse(
                    start,
                    StatusCode::BAD_REQUEST,
                    "the request body did not arrive whole",
                );
            }
        };
        let basic = match secrets::substitute_headers(&mut parts.headers, &substitute) {
            Ok(basic) => basic,
            Err(_) => {
                return self.refuse(start, StatusCode::FORBIDDEN, "invalid secret substitution");
            }
        };
        let mut pairs = Pairs::default();
        for (placeholder, value) in &substitute {
            pairs.add(value.as_bytes(), placeholder.as_bytes());
        }
        for (upstream, guest) in basic {
            pairs.add(upstream, guest);
        }
        drop(substitute);
        let headers = &mut parts.headers;
        strip_hop_by_hop(headers);
        headers.remove(header::PROXY_AUTHORIZATION);
        headers.insert(header::HOST, HeaderValue::from_static(HOST));
        // B6 reads every answer, so it must not be encoded.
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_static("identity"),
        );
        parts.uri = match target.parse::<Uri>() {
            Ok(uri) => uri,
            Err(_) => return self.refuse(start, StatusCode::BAD_REQUEST, "invalid request target"),
        };
        // Recorded before it leaves, or it does not leave.
        start.request = Some(body.to_vec());
        let (thread, method, route) = (
            start.thread.clone(),
            start.method.clone(),
            start.route.clone(),
        );
        // From here the exchange owes one outcome: `started` records `cut` if
        // this future is dropped (the child went away, the gateway stopped)
        // before the answer's Tee takes it over.
        let started = match self.channel.audit.start(start).await {
            Ok(started) => started,
            Err(error) => {
                eprintln!(
                    "cube-gateway: model channel refused {method} {} (thread {thread:?}), not sent: the model audit cannot record it: {error}",
                    route.split('?').next().unwrap_or_default()
                );
                return plain_error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "the model audit cannot record this request, so it was not sent",
                );
            }
        };
        let request = Request::from_parts(parts, Full::new(body));
        let fail = |started: crate::audit::Started, reason: &str| {
            eprintln!(
                "cube-gateway: model channel failed {method} {} (thread {thread:?}): {reason}",
                route.split('?').next().unwrap_or_default()
            );
            let response = failed(reason);
            started.finish(End {
                outcome: Outcome::Failed,
                status: Some(StatusCode::BAD_GATEWAY.as_u16()),
                reason: Some(reason.to_string()),
                response_headers: kept_headers(response.headers(), false),
                response: None,
            });
            response
        };
        let response = match self.send(request).await {
            Ok(response) => response,
            Err(reason) => return fail(started, &reason),
        };
        let (mut parts, body) = response.into_parts();
        strip_hop_by_hop(&mut parts.headers);
        if encoded(&parts.headers) {
            return fail(started, "the model channel refuses an encoded answer");
        }
        if pairs.rewrite_headers(&mut parts.headers).is_err() {
            return fail(started, "the answer's headers cannot carry the placeholder");
        }
        let bodiless = parts.status == StatusCode::NO_CONTENT
            || parts.status == StatusCode::NOT_MODIFIED
            || parts.status.is_informational();
        if !bodiless && pairs.changes_length() {
            // The length may change: hyper sends the rewritten body chunked.
            parts.headers.remove(header::CONTENT_LENGTH);
        }
        let record = Record {
            started: Some(started),
            status: parts.status.as_u16(),
            response_headers: kept_headers(&parts.headers, false),
        };
        let body = Tee::new(Reversed::new(body, pairs), record);
        Response::from_parts(parts, body.boxed())
    }

    async fn send(&self, request: Request<Full<Bytes>>) -> Result<Response<Incoming>, String> {
        let mut sender = match self.sender().await {
            Ok(sender) => sender,
            Err(UpstreamError::NotPublic) => return Err("upstream address is not public".into()),
            Err(UpstreamError::Failed(error)) => return Err(format!("{error:#}")),
        };
        let response = sender
            .send_request(request)
            .await
            .map_err(|error| format!("upstream request failed: {error}"))?;
        *self.upstream.lock().await = Some(sender);
        Ok(response)
    }

    async fn sender(&self) -> Result<SendRequest<Full<Bytes>>, UpstreamError> {
        if let Some(mut sender) = self.upstream.lock().await.take()
            && sender.ready().await.is_ok()
        {
            return Ok(sender);
        }
        let stream = self.channel.upstream.connect(HOST, 443).await?;
        let handshake = async {
            let name = ServerName::try_from(HOST).context("invalid server name")?;
            let tls = tokio::time::timeout(
                HANDSHAKE_TIMEOUT,
                self.channel.upstream.connector().connect(name, stream),
            )
            .await
            .context("upstream TLS timed out")?
            .context("upstream TLS")?;
            let (sender, connection) = hyper::client::conn::http1::Builder::new()
                .handshake(TokioIo::new(tls))
                .await?;
            tokio::spawn(async move {
                let _ = connection.await;
            });
            anyhow::Ok(sender)
        };
        handshake.await.map_err(UpstreamError::Failed)
    }

    fn refuse(&self, start: Start, status: StatusCode, reason: &str) -> Response<Body> {
        eprintln!(
            "cube-gateway: model channel refused {} {} (thread {:?}): {reason}",
            start.method,
            start.route.split('?').next().unwrap_or_default(),
            start.thread
        );
        let response = denied(status, reason);
        let end = End {
            outcome: Outcome::Refused,
            status: Some(status.as_u16()),
            reason: Some(reason.to_string()),
            response_headers: kept_headers(response.headers(), false),
            response: None,
        };
        self.channel.audit.refusal(start, end);
        response
    }
}

/// 503 with `x-cube-error`: the channel cannot serve, nothing was sent.
fn plain_error(status: StatusCode, reason: &str) -> Response<Body> {
    let mut response = failed(reason);
    *response.status_mut() = status;
    response
}

/// A forwarded exchange waiting for its answer to end: its outcome is
/// recorded once, when the answer body ends (forwarded) or is dropped or
/// broken before (cut).
struct Record {
    started: Option<crate::audit::Started>,
    status: u16,
    response_headers: Vec<(String, String)>,
}

/// An answer passed on frame by frame as it comes, with a copy of its data
/// (up to MAX_BODY) kept for the audit. It holds nothing back.
struct Tee<B> {
    inner: B,
    captured: Captured,
    record: Record,
}

impl<B> Tee<B> {
    fn new(inner: B, record: Record) -> Self {
        Self {
            inner,
            captured: Captured::default(),
            record,
        }
    }

    fn keep(&mut self, data: &[u8]) {
        let room = MAX_BODY.saturating_sub(self.captured.bytes.len());
        if data.len() > room {
            self.captured.truncated = true;
        }
        self.captured
            .bytes
            .extend_from_slice(&data[..data.len().min(room)]);
    }

    fn finish(&mut self, complete: bool) {
        let Some(started) = self.record.started.take() else {
            return;
        };
        let end = End {
            outcome: if complete {
                Outcome::Forwarded
            } else {
                Outcome::Cut
            },
            status: Some(self.record.status),
            reason: None,
            response_headers: std::mem::take(&mut self.record.response_headers),
            response: Some(std::mem::take(&mut self.captured)),
        };
        started.finish(end);
    }
}

impl<B> Drop for Tee<B> {
    fn drop(&mut self) {
        self.finish(false);
    }
}

impl<B> HttpBody for Tee<B>
where
    B: HttpBody<Data = Bytes> + Unpin,
{
    type Data = Bytes;
    type Error = B::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, Self::Error>>> {
        let this = self.get_mut();
        let polled = Pin::new(&mut this.inner).poll_frame(cx);
        match &polled {
            Poll::Ready(Some(Ok(frame))) => {
                if let Some(data) = frame.data_ref() {
                    this.keep(data);
                }
            }
            Poll::Ready(Some(Err(_))) => this.finish(false),
            Poll::Ready(None) => this.finish(true),
            Poll::Pending => {}
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        self.inner.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.inner.size_hint()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_path_names_the_thread_and_the_route() {
        assert_eq!(
            target("/t/thread-1/v1/messages"),
            Some(("thread-1", "/v1/messages"))
        );
        assert_eq!(target("/v1/messages"), None);
        assert_eq!(target("/t/thread-1"), None);
        assert_eq!(target("/t//v1/messages"), None);
        assert_eq!(target("/t/a.b/v1/messages"), None);
        assert_eq!(target("/t/a%2Fb/v1/messages"), None);
    }
}
