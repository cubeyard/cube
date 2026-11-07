//! The model channel (model.rs, audit.rs) as cubed's `claude` child uses
//! it: HTTP on loopback to `/t/<thread>/v1/messages` with the thread's
//! claude placeholder. cubed's decision server and api.anthropic.com (a
//! TLS fake through the test hooks) are local.
mod common;

use bytes::Bytes;
use common::*;
use cube_gateway::{ModelOptions, ServeOptions, http::Upstream};
use http_body_util::{BodyExt, Full};
use hyper::{
    body::{Body, Frame, Incoming},
    service::service_fn,
};
use hyper_util::rt::TokioIo;
use rustls::pki_types::{PrivateKeyDer, PrivatePkcs8KeyDer};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll},
    time::Duration,
};
use tokio::{
    io::AsyncBufReadExt,
    net::{TcpListener, TcpStream},
    sync::{Notify, mpsc},
};

const TOKEN: &str = "sk-ant-oat01-modelChannelTestToken_0123456789abcdefABCDEF-xyz";
const PH: &str = "cube_ph_claude_AbCdEfGhIjKlMnOpQrStUv";
const REQUEST: &str =
    r#"{"model":"claude-x","stream":true,"messages":[{"role":"user","content":"hi"}]}"#;

struct Frames(mpsc::Receiver<Bytes>);
impl Body for Frames {
    type Data = Bytes;
    type Error = hyper::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Bytes>, hyper::Error>>> {
        self.0
            .poll_recv(cx)
            .map(|data| data.map(|d| Ok(Frame::data(d))))
    }
}

type Answer = hyper::Response<http_body_util::combinators::BoxBody<Bytes, hyper::Error>>;

/// What api.anthropic.com saw: target, Host, Authorization, Accept-Encoding, body.
#[derive(Clone, Debug)]
struct Seen {
    target: String,
    host: String,
    auth: String,
    encoding: String,
    body: Bytes,
}

#[derive(Clone, Default)]
struct Fake {
    seen: Arc<Mutex<Vec<Seen>>>,
    /// The streaming answer waits here before its second event.
    release: Arc<Notify>,
}

/// The SSE answer: the token (echoed back, as an upstream might) in the
/// text, a web search result block, and the end.
fn events(auth: &str) -> (String, String) {
    let first = format!(
        "event: message_start\ndata: {{\"type\":\"message_start\",\"message\":{{\"id\":\"m\",\"content\":[],\"echo\":\"{auth}\"}}}}\n\n"
    );
    let rest = format!(
        concat!(
            "event: content_block_start\n",
            "data: {{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{{\"type\":\"web_search_tool_result\",\"tool_use_id\":\"s\",\"content\":[{{\"type\":\"web_search_result\",\"url\":\"https://example.com/{auth}\"}}]}}}}\n\n",
            "event: content_block_start\n",
            "data: {{\"type\":\"content_block_start\",\"index\":1,\"content_block\":{{\"type\":\"text\",\"text\":\"\"}}}}\n\n",
            "event: content_block_delta\n",
            "data: {{\"type\":\"content_block_delta\",\"index\":1,\"delta\":{{\"type\":\"text_delta\",\"text\":\"{auth}{auth}\"}}}}\n\n",
            "event: message_stop\n",
            "data: {{\"type\":\"message_stop\"}}\n\n",
        ),
        auth = auth
    );
    (first, rest)
}

async fn fake_anthropic(ca: &UpstreamCa, fake: Fake) -> std::net::SocketAddr {
    let key = rcgen::KeyPair::generate().unwrap();
    let params = rcgen::CertificateParams::new(vec!["api.anthropic.com".to_string()]).unwrap();
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
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let (acceptor, fake) = (acceptor.clone(), fake.clone());
            tokio::spawn(async move {
                let Ok(tls) = acceptor.accept(stream).await else {
                    return;
                };
                let service = service_fn(move |request: hyper::Request<Incoming>| {
                    let fake = fake.clone();
                    async move { Ok::<_, hyper::Error>(answer(request, fake).await) }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(tls), service)
                    .await;
            });
        }
    });
    address
}

async fn answer(request: hyper::Request<Incoming>, fake: Fake) -> Answer {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
            .unwrap_or_default()
    };
    let target = request.uri().to_string();
    let (host, auth, encoding) = (
        header("host"),
        header("authorization"),
        header("accept-encoding"),
    );
    let chunk: usize = header("x-test-chunk").parse().unwrap_or(0);
    let wait = header("x-test-wait") == "1";
    let body = request.into_body().collect().await.unwrap().to_bytes();
    fake.seen.lock().unwrap().push(Seen {
        target: target.clone(),
        host,
        auth: auth.clone(),
        encoding,
        body,
    });
    let token = auth.strip_prefix("Bearer ").unwrap_or(&auth).to_string();
    if target.starts_with("/v1/messages/count_tokens") {
        return hyper::Response::builder()
            .header("content-type", "application/json")
            .body(
                Full::new(Bytes::from(format!(
                    "{{\"input_tokens\":3,\"echo\":\"{token}\"}}"
                )))
                .map_err(|never| match never {})
                .boxed(),
            )
            .unwrap();
    }
    let (first, rest) = events(&token);
    let (tx, rx) = mpsc::channel(64);
    tokio::spawn(async move {
        let _ = tx.send(Bytes::from(first)).await;
        if wait {
            fake.release.notified().await;
        }
        let bytes = rest.into_bytes();
        let size = if chunk == 0 { bytes.len() } else { chunk };
        for piece in bytes.chunks(size) {
            if tx.send(Bytes::copy_from_slice(piece)).await.is_err() {
                return;
            }
        }
    });
    hyper::Response::builder()
        .header("content-type", "text/event-stream")
        .header("request-id", "req_test")
        .header("x-echo-auth", &auth)
        .header("set-cookie", "kept=no")
        .body(Frames(rx).boxed())
        .unwrap()
}

struct Channel {
    _dir: tempfile::TempDir,
    address: std::net::SocketAddr,
    audit: PathBuf,
    decide: FakeDecide,
    fake: Fake,
}

impl Channel {
    async fn start(decide: DecideFn) -> Self {
        Self::start_with(decide, Duration::from_secs(5)).await
    }

    async fn start_with(decide: DecideFn, decide_timeout: Duration) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let decide_path = dir.path().join("egress.sock");
        let decide = FakeDecide::start(decide_path.clone(), decide);
        let ca = UpstreamCa::new();
        let fake = Fake::default();
        let upstream_address = fake_anthropic(&ca, fake.clone()).await;
        let upstream = Upstream::with_test_hooks(
            ca.roots(),
            HashMap::from([("api.anthropic.com".to_string(), upstream_address)]),
        )
        .unwrap();
        let audit = dir.path().join("model-audit.sqlite");
        let running = cube_gateway::start(ServeOptions {
            decide: decide_path,
            credential: dir.path().join("credential.sock"),
            upstream,
            decide_timeout,
            model: Some(ModelOptions {
                listen: "127.0.0.1:0".parse().unwrap(),
                audit: audit.clone(),
            }),
        })
        .await
        .unwrap();
        let address = running.ready["model"].as_str().unwrap().parse().unwrap();
        std::mem::forget(running);
        Self {
            _dir: dir,
            address,
            audit,
            decide,
            fake,
        }
    }

    async fn send(
        &self,
        exchange: hyper::Request<Full<Bytes>>,
    ) -> (hyper::StatusCode, hyper::HeaderMap, Bytes) {
        request(TcpStream::connect(self.address).await.unwrap(), exchange).await
    }

    fn decisions(&self) -> usize {
        self.decide.requests.lock().unwrap().len()
    }

    fn upstream_requests(&self) -> usize {
        self.fake.seen.lock().unwrap().len()
    }

    /// The audit's exchanges, waiting until there are `count`.
    async fn exchanges(&self, count: usize) -> Vec<serde_json::Value> {
        exchanges(&self.audit, count).await
    }
}

async fn exchanges(audit: &Path, count: usize) -> Vec<serde_json::Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let rows = read_exchanges(audit);
        if rows.len() >= count {
            return rows;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{count} exchanges recorded, have {}",
            rows.len()
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn read_exchanges(audit: &Path) -> Vec<serde_json::Value> {
    let connection = rusqlite::Connection::open(audit).unwrap();
    let mut statement = connection
        .prepare(
            "SELECT seq, thread, method, route, outcome, status, reason, request_headers, request_sha256,
               response_headers, response_sha256, (SELECT count(*) FROM event WHERE event.exchange=exchange.seq), response_message_sha256
             FROM exchange ORDER BY seq",
        )
        .unwrap();
    statement
        .query_map([], |row| {
            Ok(serde_json::json!({
                "seq": row.get::<_, i64>(0)?,
                "thread": row.get::<_, String>(1)?,
                "method": row.get::<_, String>(2)?,
                "route": row.get::<_, String>(3)?,
                "outcome": row.get::<_, String>(4)?,
                "status": row.get::<_, Option<i64>>(5)?,
                "reason": row.get::<_, Option<String>>(6)?,
                "request_headers": row.get::<_, String>(7)?,
                "request": row.get::<_, Option<String>>(8)?,
                "response_headers": row.get::<_, String>(9)?,
                "response": row.get::<_, Option<String>>(10)?,
                "events": row.get::<_, i64>(11)?,
                "message": row.get::<_, Option<String>>(12)?,
            }))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
}

fn blob(audit: &Path, hash: &str) -> Vec<u8> {
    let connection = rusqlite::Connection::open(audit).unwrap();
    cube_gateway::audit::read_blob(&connection, hash)
        .unwrap()
        .unwrap()
}

/// Every byte of the audit's files.
fn audit_bytes(audit: &Path) -> Vec<u8> {
    let mut all = vec![];
    for suffix in ["", "-wal", "-shm"] {
        let file = PathBuf::from(format!("{}{suffix}", audit.display()));
        if let Ok(bytes) = std::fs::read(file) {
            all.extend(bytes);
        }
    }
    all
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|w| w == needle.as_bytes())
}

fn post(path: &str, auth: Option<&str>, extra: &[(&str, &str)]) -> hyper::Request<Full<Bytes>> {
    let mut builder = hyper::Request::post(path)
        .header("host", "127.0.0.1")
        .header("content-type", "application/json")
        .header("anthropic-version", "2023-06-01")
        .header("anthropic-beta", "oauth-2025-04-20");
    if let Some(auth) = auth {
        builder = builder.header("authorization", auth);
    }
    for (k, v) in extra {
        builder = builder.header(*k, *v);
    }
    builder.body(Full::new(Bytes::from(REQUEST))).unwrap()
}

fn substitute() -> DecideFn {
    allow_with(&[(PH, TOKEN)])
}

/// The answer as the audit reconstructs it: one message, placeholder only.
fn expected_message() -> serde_json::Value {
    serde_json::json!({
        "id": "m", "echo": PH,
        "content": [
            { "type": "web_search_tool_result", "tool_use_id": "s",
              "content": [{ "type": "web_search_result", "url": format!("https://example.com/{PH}") }] },
            { "type": "text", "text": format!("{PH}{PH}") },
        ],
    })
}

fn message_of(audit: &Path, row: &serde_json::Value) -> serde_json::Value {
    let hash = row["message"].as_str().expect("a reconstructed message");
    serde_json::from_slice(&blob(audit, hash)).unwrap()
}

fn expected_answer() -> String {
    let (first, rest) = events(PH);
    format!("{first}{rest}")
}

#[tokio::test]
async fn sse_streams_as_it_comes_with_the_token_upstream_and_only_the_placeholder_back() {
    let channel = Channel::start(substitute()).await;
    let stream = TcpStream::connect(channel.address).await.unwrap();
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    tokio::spawn(connection);
    let response = sender
        .send_request(post(
            "/t/thread-1/v1/messages?beta=true",
            Some(&format!("Bearer {PH}")),
            &[("x-test-wait", "1")],
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["x-echo-auth"], format!("Bearer {PH}"));
    let mut body = response.into_body();
    // The first event arrives while the upstream still holds the rest: the
    // channel holds nothing back.
    let mut received = Vec::new();
    let (first, _) = events(PH);
    while received.len() < first.len() {
        let frame = tokio::time::timeout(Duration::from_secs(5), body.frame())
            .await
            .expect("the first event arrives before the upstream sends more")
            .unwrap()
            .unwrap();
        received.extend_from_slice(&frame.into_data().unwrap());
    }
    assert_eq!(received, first.as_bytes());
    channel.fake.release.notify_one();
    while let Some(frame) = body.frame().await {
        received.extend_from_slice(&frame.unwrap().into_data().unwrap());
    }
    assert_eq!(
        String::from_utf8(received.clone()).unwrap(),
        expected_answer()
    );
    assert!(!contains(&received, TOKEN));

    let seen = channel.fake.seen.lock().unwrap()[0].clone();
    assert_eq!(seen.target, "/v1/messages?beta=true");
    assert_eq!(seen.host, "api.anthropic.com");
    assert_eq!(seen.auth, format!("Bearer {TOKEN}"));
    assert_eq!(seen.encoding, "identity");
    assert_eq!(seen.body, REQUEST.as_bytes());

    let decision = channel.decide.requests.lock().unwrap()[0].clone();
    assert_eq!(decision["channel"], "model");
    assert_eq!(decision["threadId"], "thread-1");
    assert_eq!(decision["host"], "api.anthropic.com");
    assert_eq!(decision["path"], "/v1/messages");
    assert_eq!(decision["scheme"], "https");
    assert_eq!(decision["placeholders"], serde_json::json!([PH]));

    let rows = channel.exchanges(1).await;
    let row = &rows[0];
    assert_eq!(row["thread"], "thread-1");
    assert_eq!(row["route"], "/v1/messages?beta=true");
    assert_eq!(row["outcome"], "forwarded");
    assert_eq!(row["status"], 200);
    assert_eq!(
        row["events"], 1,
        "the web search result is an event of its own"
    );
    assert_eq!(
        blob(&channel.audit, row["request"].as_str().unwrap()),
        REQUEST.as_bytes()
    );
    assert_eq!(
        blob(&channel.audit, row["response"].as_str().unwrap()),
        received
    );
    assert_eq!(
        message_of(&channel.audit, row),
        expected_message(),
        "the stream reconstructed as one message"
    );
    let request_headers = row["request_headers"].as_str().unwrap();
    assert!(
        request_headers.contains("anthropic-beta") && !request_headers.contains("authorization")
    );
    let response_headers = row["response_headers"].as_str().unwrap();
    assert!(response_headers.contains("req_test") && !response_headers.contains("set-cookie"));
    assert!(
        !contains(&audit_bytes(&channel.audit), TOKEN),
        "no token in the audit"
    );
}

#[tokio::test]
async fn the_answer_is_the_same_however_the_upstream_chunks_it() {
    let channel = Channel::start(substitute()).await;
    for chunk in [1, 2, 3, 7, 13, 64, 4096] {
        let (status, _, body) = channel
            .send(post(
                "/t/thread-1/v1/messages",
                Some(&format!("Bearer {PH}")),
                &[("x-test-chunk", &chunk.to_string())],
            ))
            .await;
        assert_eq!(status, 200);
        assert_eq!(
            String::from_utf8(body.to_vec()).unwrap(),
            expected_answer(),
            "chunks of {chunk}"
        );
    }
    let (status, _, body) = channel
        .send(post(
            "/t/thread-1/v1/messages/count_tokens?beta=true",
            Some(&format!("Bearer {PH}")),
            &[],
        ))
        .await;
    assert_eq!(status, 200);
    assert_eq!(body, format!("{{\"input_tokens\":3,\"echo\":\"{PH}\"}}"));
    let rows = channel.exchanges(8).await;
    assert!(rows.iter().all(|row| row["outcome"] == "forwarded"));
    // Every chunking, the token split anywhere: the same message, the same
    // hash, and its web search result an event of its own.
    for row in &rows[..7] {
        assert_eq!(
            message_of(&channel.audit, row),
            expected_message(),
            "{}",
            row["seq"]
        );
        assert_eq!(row["message"], rows[0]["message"]);
        assert_eq!(row["events"], 1);
    }
    assert_eq!(
        message_of(&channel.audit, &rows[7])["echo"],
        PH,
        "a whole JSON answer is its own message"
    );
    assert!(!contains(&audit_bytes(&channel.audit), TOKEN));
}

#[tokio::test]
async fn other_routes_and_missing_or_foreign_placeholders_are_refused_and_recorded() {
    let channel = Channel::start(substitute()).await;
    let bearer = format!("Bearer {PH}");
    let refused: Vec<(hyper::Request<Full<Bytes>>, u16, &str)> = vec![
        (post("/v1/messages", Some(&bearer), &[]), 404, "/t/<thread>"),
        (
            post("/t/thread-1/api/oauth/profile", Some(&bearer), &[]),
            404,
            "not a model route",
        ),
        (
            post("/t/thread-1/v1/files", Some(&bearer), &[]),
            404,
            "not a model route",
        ),
        (
            hyper::Request::get("/t/thread-1/v1/messages")
                .header("host", "127.0.0.1")
                .header("authorization", &bearer)
                .body(Full::new(Bytes::new()))
                .unwrap(),
            404,
            "not a model route",
        ),
        (
            post("/t/thread-1/v1/messages", None, &[]),
            401,
            "placeholder is missing",
        ),
        (
            post(
                "/t/thread-1/v1/messages",
                Some(&format!("Bearer {GH}")),
                &[],
            ),
            403,
            "one claude placeholder",
        ),
        (
            post(
                "/t/thread-1/v1/messages",
                Some(&bearer),
                &[("x-api-key", GH)],
            ),
            403,
            "one claude placeholder",
        ),
        (
            post(
                "/t/thread-1/v1/messages",
                Some("Bearer sk-ant-not-a-placeholder"),
                &[],
            ),
            401,
            "placeholder is missing",
        ),
    ];
    let count = refused.len();
    for (request, status, reason) in refused {
        let target = request.uri().to_string();
        let (got, headers, _) = channel.send(request).await;
        assert_eq!(got.as_u16(), status, "{target}");
        let denied = headers["x-cube-denied"].to_str().unwrap();
        assert!(denied.contains(reason), "{target}: {denied}");
    }
    assert_eq!(channel.decisions(), 0, "refused before any decision");
    assert_eq!(channel.upstream_requests(), 0, "nothing went upstream");
    let rows = channel.exchanges(count).await;
    assert!(
        rows.iter()
            .all(|row| row["outcome"] == "refused" && row["request"].is_null())
    );
    let routes: Vec<&str> = rows
        .iter()
        .map(|row| row["route"].as_str().unwrap())
        .collect();
    assert!(routes.contains(&"/api/oauth/profile") && routes.contains(&"/v1/files"));
}

#[tokio::test]
async fn cubed_decides_and_a_denial_late_answer_or_missing_token_fails_closed() {
    let deny: DecideFn = Arc::new(|_| {
        (
            Duration::ZERO,
            serde_json::json!({"allow": false, "reason": "a secret placeholder does not belong to this thread"}),
        )
    });
    let late: DecideFn = Arc::new(|_| {
        (
            Duration::from_millis(600),
            serde_json::json!({"allow": true, "substitute": {PH: TOKEN}}),
        )
    });
    let empty: DecideFn = Arc::new(|_| (Duration::ZERO, serde_json::json!({"allow": true})));
    for (decide, timeout, reason) in [
        (deny, Duration::from_secs(5), "does not belong"),
        (late, Duration::from_millis(200), "timed out"),
        (empty, Duration::from_secs(5), "no claude token"),
    ] {
        let channel = Channel::start_with(decide, timeout).await;
        let (status, headers, _) = channel
            .send(post(
                "/t/thread-2/v1/messages",
                Some(&format!("Bearer {PH}")),
                &[],
            ))
            .await;
        assert_eq!(status, 403);
        assert!(headers["x-cube-denied"].to_str().unwrap().contains(reason));
        assert_eq!(channel.upstream_requests(), 0);
        let rows = channel.exchanges(1).await;
        assert_eq!(rows[0]["thread"], "thread-2");
        assert_eq!(rows[0]["outcome"], "refused");
    }
}

#[tokio::test]
async fn the_listener_is_loopback_only() {
    let error = cube_gateway::model::bind("0.0.0.0:0".parse().unwrap())
        .await
        .unwrap_err();
    assert!(error.to_string().contains("loopback only"));
}

/// The real binary (a test-hooks build): its ready line names the
/// listener, and nothing it logs or records carries the token.
#[tokio::test]
async fn the_binary_logs_and_records_no_token() {
    let dir = tempfile::tempdir().unwrap();
    let decide_path = dir.path().join("egress.sock");
    let decide = FakeDecide::start(decide_path.clone(), substitute());
    let ca = UpstreamCa::new();
    let ca_file = dir.path().join("ca.pem");
    std::fs::write(&ca_file, pem(&ca)).unwrap();
    let fake = Fake::default();
    let upstream = fake_anthropic(&ca, fake.clone()).await;
    let audit = dir.path().join("model-audit.sqlite");
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_cube-gateway"))
        .args(["serve", "--decide"])
        .arg(&decide_path)
        .arg("--credential")
        .arg(dir.path().join("credential.sock"))
        .args(["--model-listen", "127.0.0.1:0", "--model-audit"])
        .arg(&audit)
        .arg("--test-upstream")
        .arg(format!("api.anthropic.com={upstream}"))
        .arg("--test-upstream-ca")
        .arg(&ca_file)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let mut stdout = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
    let ready: serde_json::Value =
        serde_json::from_str(&stdout.next_line().await.unwrap().unwrap()).unwrap();
    let address: std::net::SocketAddr = ready["model"].as_str().unwrap().parse().unwrap();
    assert!(address.ip().is_loopback());
    let bearer = format!("Bearer {PH}");
    let send = |exchange| async move {
        request(TcpStream::connect(address).await.unwrap(), exchange).await
    };
    let (status, _, body) = send(post(
        "/t/thread-1/v1/messages?beta=true",
        Some(&bearer),
        &[],
    ))
    .await;
    assert_eq!(status, 200);
    assert_eq!(String::from_utf8(body.to_vec()).unwrap(), expected_answer());
    let (status, _, _) = send(post("/t/thread-1/v1/models", Some(&bearer), &[])).await;
    assert_eq!(status, 404);
    let (status, _, _) = send(post(
        "/t/thread-1/v1/messages",
        Some(&format!("Bearer {TOKEN}")),
        &[],
    ))
    .await;
    assert_eq!(
        status, 401,
        "a real token from the child is not a placeholder"
    );
    exchanges(&audit, 3).await;
    drop(child.stdin.take());
    let output = child.wait_with_output().await.unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("model channel refused POST /v1/models"),
        "{stderr}"
    );
    assert!(!stderr.contains(TOKEN), "no token in the gateway's log");
    assert!(
        !contains(&audit_bytes(&audit), TOKEN),
        "no token in the audit"
    );
    assert_eq!(decide.requests.lock().unwrap().len(), 1);
    assert_eq!(fake.seen.lock().unwrap().len(), 1);
}

fn pem(ca: &UpstreamCa) -> String {
    use base64::{Engine, engine::general_purpose::STANDARD};
    let encoded = STANDARD.encode(ca.der.as_ref());
    let lines: Vec<&str> = encoded
        .as_bytes()
        .chunks(64)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect();
    format!(
        "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
        lines.join("\n")
    )
}
