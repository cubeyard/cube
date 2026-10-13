//! The credential proxy (credential.rs, http.rs in credential mode, B6 in
//! reverse.rs) over its real socket, as cubed drives it: one header frame,
//! then one HTTP/1.1 exchange. The decision server and the upstream (a TLS
//! fake for `api.github.test` and `github.test`) are local.
mod common;

use base64::{Engine, engine::general_purpose::STANDARD};
use bytes::Bytes;
use common::*;
use cube_gateway::{
    ca::Ca,
    decide::DecideClient,
    http::{Egress, Upstream},
};
use cube_runner_protocol::proto::{CredentialHeader, Fence, Ref};
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
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, UnixStream},
    sync::mpsc,
};

const TOKEN: &str = "ghs_credentialTestToken0123456789abcdef";
const BASIC_USER: &str = "x-access-token";

/// A body fed from a channel, one frame per message.
struct Channel(mpsc::Receiver<Bytes>);
impl Body for Channel {
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

fn full(body: impl Into<Bytes>) -> http_body_util::combinators::BoxBody<Bytes, hyper::Error> {
    Full::new(body.into())
        .map_err(|never| match never {})
        .boxed()
}

/// What the upstream saw of each request: path, Authorization,
/// Accept-Encoding, body length.
type Seen = Arc<Mutex<Vec<(String, String, String, usize)>>>;

/// An upstream that echoes the request's Authorization in several ways.
async fn upstream(ca: &UpstreamCa) -> (std::net::SocketAddr, Seen) {
    let key = rcgen::KeyPair::generate().unwrap();
    let params = rcgen::CertificateParams::new(vec![
        "api.github.test".to_string(),
        "github.test".to_string(),
        "other.github.test".to_string(),
    ])
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
    let seen: Seen = Arc::default();
    let recorded = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                return;
            };
            let (acceptor, recorded) = (acceptor.clone(), recorded.clone());
            tokio::spawn(async move {
                let Ok(tls) = acceptor.accept(stream).await else {
                    return;
                };
                let service = service_fn(move |request: hyper::Request<Incoming>| {
                    let recorded = recorded.clone();
                    async move { Ok::<_, hyper::Error>(answer(request, recorded).await) }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .serve_connection(TokioIo::new(tls), service)
                    .await;
            });
        }
    });
    (address, seen)
}

async fn answer(request: hyper::Request<Incoming>, seen: Seen) -> Answer {
    let path = request.uri().path().to_string();
    let query = request.uri().query().unwrap_or("").to_string();
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .map(|v| String::from_utf8_lossy(v.as_bytes()).into_owned())
            .unwrap_or_default()
    };
    let auth = header("authorization");
    let encoding = header("accept-encoding");
    let length = request
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .len();
    seen.lock()
        .unwrap()
        .push((path.clone(), auth.clone(), encoding, length));
    let response = hyper::Response::builder().header("x-echo-auth", &auth);
    match path.as_str() {
        // Echo in a header and in a body with Content-Length.
        "/echo" => response
            .header("content-length", auth.len() + 11)
            .body(full(format!("auth=[{auth}] end")))
            .unwrap(),
        // Echo split into frames at byte `query` of the value, with a
        // pause between them, chunked.
        "/split" => {
            let at: usize = query.parse().unwrap();
            let (tx, rx) = mpsc::channel(4);
            let (a, b) = auth.split_at(at.min(auth.len()));
            let (a, b) = (format!("auth=[{a}"), format!("{b}] end"));
            tokio::spawn(async move {
                let _ = tx.send(Bytes::from(a)).await;
                tokio::time::sleep(Duration::from_millis(50)).await;
                let _ = tx.send(Bytes::from(b)).await;
            });
            response.body(Channel(rx).boxed()).unwrap()
        }
        "/gzip" => response
            .header("content-encoding", "gzip")
            .body(full(format!("compressed {auth}")))
            .unwrap(),
        "/redirect" => response
            .status(302)
            .header(
                "location",
                format!("https://objects.example/x?sig={}", auth.replace(' ', "+")),
            )
            .body(full(""))
            .unwrap(),
        // `query` MiB of the value repeated with a counter between.
        "/download" => {
            let mib: usize = query.parse().unwrap();
            let (tx, rx) = mpsc::channel(8);
            tokio::spawn(async move {
                let mut sent = 0;
                let mut n = 0u64;
                while sent < mib << 20 {
                    let chunk = format!("{n:08} {auth}\n").repeat(997);
                    sent += chunk.len();
                    n += 1;
                    if tx.send(Bytes::from(chunk)).await.is_err() {
                        return;
                    }
                }
            });
            response.body(Channel(rx).boxed()).unwrap()
        }
        "/head" => response
            .header("content-length", "12345")
            .body(full(""))
            .unwrap(),
        _ => response.body(full(format!("length={length}"))).unwrap(),
    }
}

struct Proxy {
    _dir: tempfile::TempDir,
    socket: PathBuf,
    decide: FakeDecide,
    seen: Seen,
}

impl Proxy {
    async fn start(decide: DecideFn) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let decide_path = dir.path().join("egress.sock");
        let decide = FakeDecide::start(decide_path.clone(), decide);
        let ca = UpstreamCa::new();
        let (address, seen) = upstream(&ca).await;
        let overrides = HashMap::from([
            ("api.github.test".to_string(), address),
            ("github.test".to_string(), address),
            ("other.github.test".to_string(), address),
        ]);
        let upstream = Arc::new(Upstream::with_test_hooks(ca.roots(), overrides).unwrap());
        std::fs::create_dir_all(dir.path().join("gateway")).unwrap();
        let egress = Arc::new(Egress {
            ca: Arc::new(Ca::load_or_create(&dir.path().join("gateway")).unwrap()),
            decide: Arc::new(DecideClient::new(decide_path, Duration::from_secs(5))),
            upstream,
        });
        let socket = dir.path().join("credential.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        tokio::spawn(cube_gateway::credential::serve(listener, egress));
        Self {
            _dir: dir,
            socket,
            decide,
            seen,
        }
    }

    async fn open(&self, host: &str) -> UnixStream {
        open(&self.socket, host).await
    }

    /// One request; status, headers and the body.
    async fn send(
        &self,
        host: &str,
        request: hyper::Request<Full<Bytes>>,
    ) -> (hyper::StatusCode, hyper::HeaderMap, Bytes) {
        request_over(self.open(host).await, request).await
    }
}

async fn open(socket: &Path, host: &str) -> UnixStream {
    let mut stream = UnixStream::connect(socket).await.unwrap();
    let header = CredentialHeader {
        r#ref: Some(Ref {
            owner: THREAD_ID.into(),
            id: VM_ID.into(),
        }),
        credential: "github".into(),
        sni: host.into(),
        host: host.into(),
        port: 443,
        fence: Some(Fence { epoch: 7 }),
    };
    cube_runner_protocol::write_frame(&mut stream, &header)
        .await
        .unwrap();
    stream
}

async fn request_over(
    stream: UnixStream,
    exchange: hyper::Request<Full<Bytes>>,
) -> (hyper::StatusCode, hyper::HeaderMap, Bytes) {
    request(stream, exchange).await
}

fn substitute() -> DecideFn {
    allow_with(&[(GH, TOKEN)])
}

fn with(host: &str, path: &str, auth: &str) -> hyper::Request<Full<Bytes>> {
    get(host, path, &[("authorization", auth.to_string())])
}

#[tokio::test]
async fn the_token_goes_upstream_and_only_the_placeholder_comes_back() {
    let proxy = Proxy::start(substitute()).await;
    let bearer = format!("Bearer {GH}");
    let (status, headers, body) = proxy
        .send("api.github.test", with("api.github.test", "/echo", &bearer))
        .await;
    assert_eq!(status, 200);
    assert_eq!(headers["x-echo-auth"], bearer.as_str());
    assert_eq!(body, format!("auth=[{bearer}] end"));
    assert!(
        !headers.contains_key("content-length"),
        "the length may change: chunked"
    );
    let seen = proxy.seen.lock().unwrap().clone();
    assert_eq!(
        seen[0].1,
        format!("Bearer {TOKEN}"),
        "the upstream got the token"
    );
    assert_eq!(seen[0].2, "identity", "identity is asked for");
    // cubed decided it as for p3, with the stream's machine.
    let decided = proxy.decide.requests.lock().unwrap()[0].clone();
    assert_eq!(decided["vmId"], VM_ID);
    assert_eq!(decided["threadId"], THREAD_ID);
    assert_eq!(decided["scheme"], "https");
    assert_eq!(decided["host"], "api.github.test");
    assert_eq!(decided["placeholders"], serde_json::json!([GH]));
}

#[tokio::test]
async fn a_basic_credential_comes_back_as_the_guest_encoded_it_also_split_across_chunks() {
    let proxy = Proxy::start(substitute()).await;
    // The guest's own encoding (lowercase scheme, as git may not send it).
    let guest = STANDARD.encode(format!("{BASIC_USER}:{GH}"));
    let real = STANDARD.encode(format!("{BASIC_USER}:{TOKEN}"));
    let auth = format!("basic {guest}");
    let upstream_auth = format!("Basic {real}");
    for at in [0, 1, 6, 7, 20, upstream_auth.len() - 1, upstream_auth.len()] {
        let (status, headers, body) = proxy
            .send(
                "github.test",
                with("github.test", &format!("/split?{at}"), &auth),
            )
            .await;
        assert_eq!(status, 200, "split at {at}");
        assert_eq!(headers["x-echo-auth"], format!("Basic {guest}").as_str());
        assert_eq!(body, format!("auth=[Basic {guest}] end"), "split at {at}");
    }
    assert!(
        proxy
            .seen
            .lock()
            .unwrap()
            .iter()
            .all(|s| s.1 == upstream_auth)
    );
    // The token alone in a body is turned back too, at every split.
    let bearer = format!("Bearer {GH}");
    for at in 0..=(7 + TOKEN.len()) {
        let (_, _, body) = proxy
            .send(
                "api.github.test",
                with("api.github.test", &format!("/split?{at}"), &bearer),
            )
            .await;
        assert_eq!(body, format!("auth=[{bearer}] end"), "split at {at}");
    }
}

#[tokio::test]
async fn an_encoded_answer_is_refused_and_identity_is_forced() {
    let proxy = Proxy::start(substitute()).await;
    let mut request = with("api.github.test", "/gzip", &format!("token {GH}"));
    request
        .headers_mut()
        .insert("accept-encoding", "gzip, br".parse().unwrap());
    let (status, headers, body) = proxy.send("api.github.test", request).await;
    assert_eq!(status, 502);
    assert_eq!(
        headers["x-cube-error"],
        "the credential proxy refuses an encoded answer"
    );
    assert!(!String::from_utf8_lossy(&body).contains(TOKEN));
    assert_eq!(proxy.seen.lock().unwrap()[0].2, "identity");
    // Also without a substitution (nothing to turn back): refused alike.
    let (status, _, _) = proxy
        .send("api.github.test", get("api.github.test", "/gzip", &[]))
        .await;
    assert_eq!(status, 502);
}

#[tokio::test]
async fn a_redirect_is_passed_on_rewritten_and_never_followed() {
    let proxy = Proxy::start(substitute()).await;
    let (status, headers, _) = proxy
        .send(
            "api.github.test",
            with("api.github.test", "/redirect", &format!("Bearer {GH}")),
        )
        .await;
    assert_eq!(status, 302);
    assert_eq!(
        headers["location"],
        format!("https://objects.example/x?sig=Bearer+{GH}").as_str()
    );
    assert_eq!(proxy.seen.lock().unwrap().len(), 1, "not followed");
}

#[tokio::test]
async fn placeholders_of_another_credential_and_denials_are_refused() {
    let proxy = Proxy::start(substitute()).await;
    let (status, headers, _) = proxy
        .send(
            "api.github.test",
            with("api.github.test", "/echo", &format!("Bearer {OTHER}")),
        )
        .await;
    assert_eq!(status, 403);
    assert_eq!(
        headers["x-cube-denied"],
        "only github placeholders go through this credential"
    );
    assert!(proxy.decide.requests.lock().unwrap().is_empty());
    // The Host must be the stream's server name.
    let (status, _, _) = proxy
        .send(
            "api.github.test",
            with("other.github.test", "/echo", &format!("Bearer {GH}")),
        )
        .await;
    assert_eq!(status, 421);
    // cubed's decision denies: nothing goes upstream.
    let denying = Proxy::start(Arc::new(|_| {
        (
            Duration::ZERO,
            serde_json::json!({"allow": false, "reason": "the github secret is not allowed for other.github.test"}),
        )
    }))
    .await;
    let (status, headers, _) = denying
        .send(
            "other.github.test",
            with("other.github.test", "/echo", &format!("Bearer {GH}")),
        )
        .await;
    assert_eq!(status, 403);
    assert_eq!(
        headers["x-cube-denied"],
        "the github secret is not allowed for other.github.test"
    );
    assert!(denying.seen.lock().unwrap().is_empty());
    assert!(proxy.seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn without_a_substitution_the_answer_is_untouched() {
    let proxy = Proxy::start(allow_with(&[])).await;
    let (status, headers, body) = proxy
        .send(
            "api.github.test",
            with("api.github.test", "/echo", "Bearer public"),
        )
        .await;
    assert_eq!(status, 200);
    assert_eq!(headers["content-length"], (body.len()).to_string().as_str());
    assert_eq!(body, "auth=[Bearer public] end");
    // A HEAD answer keeps its Content-Length also with a substitution.
    let proxy = Proxy::start(substitute()).await;
    let mut head = with("api.github.test", "/head", &format!("Bearer {GH}"));
    *head.method_mut() = hyper::Method::HEAD;
    let (status, headers, body) = proxy.send("api.github.test", head).await;
    assert_eq!((status.as_u16(), body.len()), (200, 0));
    assert_eq!(headers["content-length"], "12345");
}

#[tokio::test]
async fn bodies_stream_both_ways_and_a_connection_carries_one_request() {
    let proxy = Proxy::start(substitute()).await;
    // 8 MiB up: the upstream reads every byte.
    let upload = Bytes::from(vec![b'u'; 8 << 20]);
    let request = hyper::Request::post("/upload")
        .header("host", "github.test")
        .header("authorization", format!("Bearer {GH}"))
        .body(Full::new(upload.clone()))
        .unwrap();
    let (status, _, body) = proxy.send("github.test", request).await;
    assert_eq!(status, 200);
    assert_eq!(body, format!("length={}", 8 << 20));
    // 16 MiB down with the token in every line: none comes back.
    let (status, _, body) = proxy
        .send(
            "github.test",
            with("github.test", "/download?16", &format!("Bearer {GH}")),
        )
        .await;
    assert_eq!(status, 200);
    let text = String::from_utf8(body.to_vec()).unwrap();
    assert!(text.len() >= 15 << 20, "{}", text.len());
    assert!(!text.contains(TOKEN));
    let lines = text.lines().count();
    assert_eq!(text.matches(GH).count(), lines, "one placeholder per line");
    // A second request on the same connection is not served.
    let stream = proxy.open("github.test").await;
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    tokio::spawn(connection);
    let first = sender
        .send_request(with("github.test", "/echo", "Bearer x"))
        .await
        .unwrap();
    assert_eq!(first.headers()["connection"], "close");
    let _ = first.into_body().collect().await;
    assert!(
        sender
            .send_request(with("github.test", "/echo", "Bearer x"))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn a_bad_header_frame_closes_the_connection_unanswered() {
    let proxy = Proxy::start(substitute()).await;
    // Server name and host differ.
    let mut stream = UnixStream::connect(&proxy.socket).await.unwrap();
    let header = CredentialHeader {
        r#ref: Some(Ref {
            owner: THREAD_ID.into(),
            id: VM_ID.into(),
        }),
        credential: "github".into(),
        sni: "api.github.test".into(),
        host: "github.test".into(),
        port: 443,
        fence: None,
    };
    cube_runner_protocol::write_frame(&mut stream, &header)
        .await
        .unwrap();
    stream
        .write_all(b"GET / HTTP/1.1\r\nhost: api.github.test\r\n\r\n")
        .await
        .unwrap();
    let mut out = vec![];
    let read = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut out)).await;
    assert!(matches!(read, Ok(Ok(0)) | Ok(Err(_))), "{out:?}");
    // A frame over 64 KiB.
    let mut stream = UnixStream::connect(&proxy.socket).await.unwrap();
    stream.write_u32(64 * 1024 + 1).await.unwrap();
    let mut out = vec![];
    let read = tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut out)).await;
    assert!(matches!(read, Ok(Ok(0)) | Ok(Err(_))));
    assert!(proxy.seen.lock().unwrap().is_empty());
    assert!(proxy.decide.requests.lock().unwrap().is_empty());
}
