//! B-5 in process: requests a credential rule matches go over a
//! `credential` stream on cubed's connection, a real Iroh connection over
//! loopback; the test plays cubed and its credential proxy (the stream's
//! header, `StreamAnswer`, then an HTTP/1.1 server on the stream). The real
//! chain (cubed's RunnerSession and cube-gateway) is in runner-vm-test.ts.
use super::*;
use crate::{NetworkMode, bind};
use cube_runner_protocol::{ALPN, refuse};
use iroh::endpoint::Connection;

/// What fake cubed does with a credential stream.
#[derive(Clone)]
enum Cubed {
    /// Answers and serves the request: `/echo` echoes it as JSON,
    /// `/stream` sends 1 KiB every 20 ms until the stream dies.
    Serve,
    Refuse(proto::Error),
    /// Takes the stream and never answers.
    Silent,
}

struct FakeCubed {
    /// Its connection to the runner; closing it is cubed going.
    connection: Connection,
    headers: Arc<Mutex<Vec<proto::CredentialHeader>>>,
    /// Bytes `/stream` wrote.
    written: Arc<AtomicUsize>,
    _attached: crate::vm::presence::Attached,
    _endpoints: (iroh::Endpoint, iroh::Endpoint),
}

async fn cubed(env: &Env, behavior: Cubed) -> FakeCubed {
    let runner = bind(iroh::SecretKey::generate(), NetworkMode::Loopback, None)
        .await
        .unwrap();
    let cubed = bind(iroh::SecretKey::generate(), NetworkMode::Loopback, None)
        .await
        .unwrap();
    let accepting = {
        let runner = runner.clone();
        tokio::spawn(async move { runner.accept().await.unwrap().await.unwrap() })
    };
    let to_runner = cubed.connect(runner.addr(), ALPN).await.unwrap();
    let from_cubed = accepting.await.unwrap();
    let attached = env.presence.attach(Some(from_cubed));
    let headers = Arc::new(Mutex::new(vec![]));
    let written = Arc::new(AtomicUsize::new(0));
    let (connection, seen, count) = (to_runner.clone(), headers.clone(), written.clone());
    tokio::spawn(async move {
        while let Ok((mut send, mut recv)) = connection.accept_bi().await {
            let (behavior, seen, count) = (behavior.clone(), seen.clone(), count.clone());
            tokio::spawn(async move {
                let opened: proto::Open = read_frame(&mut recv).await.unwrap();
                let Some(open::Kind::Credential(header)) = opened.kind else {
                    panic!("not a credential stream: {opened:?}");
                };
                seen.lock().unwrap().push(header);
                let error = match behavior {
                    Cubed::Silent => {
                        tokio::time::sleep(Duration::from_secs(60)).await;
                        return;
                    }
                    Cubed::Refuse(error) => Some(error),
                    Cubed::Serve => None,
                };
                let refused = error.is_some();
                write_frame(&mut send, &proto::StreamAnswer { error })
                    .await
                    .unwrap();
                if refused {
                    let _ = send.finish();
                    return;
                }
                let service = service_fn(move |request: Request<Incoming>| {
                    let count = count.clone();
                    async move { Ok::<_, hyper::Error>(proxy(request, count).await) }
                });
                let _ = hyper::server::conn::http1::Builder::new()
                    .keep_alive(false)
                    .serve_connection(TokioIo::new(tokio::io::join(recv, send)), service)
                    .await;
            });
        }
    });
    FakeCubed {
        connection: to_runner,
        headers,
        written,
        _attached: attached,
        _endpoints: (runner, cubed),
    }
}

/// A body fed from a channel.
struct Channel(tokio::sync::mpsc::Receiver<Bytes>);
impl hyper::body::Body for Channel {
    type Data = Bytes;
    type Error = hyper::Error;
    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<hyper::body::Frame<Bytes>, hyper::Error>>> {
        self.0
            .poll_recv(cx)
            .map(|d| d.map(|d| Ok(hyper::body::Frame::data(d))))
    }
}

/// cubed's proxy, as far as the runner can tell.
async fn proxy(request: Request<Incoming>, written: Arc<AtomicUsize>) -> Response<Body> {
    let (parts, body) = request.into_parts();
    if parts.uri.path() == "/stream" {
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        tokio::spawn(async move {
            while tx.send(Bytes::from(vec![b'x'; 1024])).await.is_ok() {
                written.fetch_add(1024, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        });
        return Response::new(Channel(rx).boxed());
    }
    let length = body.collect().await.unwrap().to_bytes().len();
    let headers: HashMap<String, String> = parts
        .headers
        .iter()
        .map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).into()))
        .collect();
    let echo = serde_json::json!({
        "method": parts.method.as_str(),
        "uri": parts.uri.to_string(),
        "headers": headers,
        "length": length,
    });
    Response::new(
        Full::new(Bytes::from(serde_json::to_vec(&echo).unwrap()))
            .map_err(|never| match never {})
            .boxed(),
    )
}

fn credential_policy(lease: Duration) -> Policy {
    policy(
        egress_policy::Default::AllowPublicHttp,
        &[],
        vec![rule(
            &["api.github.test", "github.test"],
            egress_policy::rule::Kind::Https(egress_policy::Https {
                credential: Some(egress_policy::Credential {
                    name: "github".into(),
                }),
            }),
        )],
        lease,
    )
}

#[tokio::test]
async fn a_credential_request_goes_to_cubed_on_its_connection_placeholder_and_all() {
    let env = Env::new(credential_policy(Duration::from_secs(900))).await;
    let cubed = cubed(&env, Cubed::Serve).await;
    let upload = vec![b'u'; 3 << 20];
    let tls = env.tls("api.github.test", 40200).await.unwrap();
    let request = Request::post("/repos/x/y/git?q=1")
        .header("host", "api.github.test")
        .header("authorization", format!("Bearer {GH}"))
        .header("connection", "x-hop")
        .header("x-hop", "1")
        .header("proxy-authorization", "Basic eDp5")
        .body(Full::new(Bytes::from(upload.clone())))
        .unwrap();
    let (status, _, body) = request_over(tls, request).await;
    assert_eq!(status, StatusCode::OK);
    let echo = json(&body);
    assert_eq!(echo["method"], "POST");
    assert_eq!(echo["uri"], "/repos/x/y/git?q=1");
    assert_eq!(echo["length"], upload.len());
    assert_eq!(echo["headers"]["authorization"], format!("Bearer {GH}"));
    assert_eq!(echo["headers"]["host"], "api.github.test");
    for gone in ["x-hop", "proxy-authorization"] {
        assert!(echo["headers"].get(gone).is_none(), "{gone}: {echo}");
    }
    let headers = cubed.headers.lock().unwrap().clone();
    assert_eq!(headers.len(), 1);
    assert_eq!(
        headers[0],
        proto::CredentialHeader {
            r#ref: Some(reference()),
            credential: "github".into(),
            sni: "api.github.test".into(),
            host: "api.github.test".into(),
            port: 443,
            fence: Some(proto::Fence { epoch: 42 }),
        }
    );
    // Nothing went out from the runner, and nothing was refused.
    assert_eq!(env.tls.hits.load(Ordering::SeqCst), 0);
    assert!(env.reasons().is_empty(), "{:?}", env.reasons());
    // Without a placeholder too: the rule decides the route.
    let tls = env.tls("github.test", 40201).await.unwrap();
    let (status, _, _) = request_over(tls, get("github.test", "/info/refs", &[])).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(cubed.headers.lock().unwrap().len(), 2);
    assert_eq!(env.tls.hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn without_cubed_or_when_it_refuses_a_credential_request_is_a_503_at_once() {
    let env = Env::new(credential_policy(Duration::from_secs(900))).await;
    let bearer = [("authorization", format!("Bearer {GH}"))];
    // cubed gone, the lease still running: ordinary egress goes on, the
    // credential request is refused at once.
    let started = std::time::Instant::now();
    let tls = env.tls("api.github.test", 40210).await.unwrap();
    let (status, headers, _) = request_over(tls, get("api.github.test", "/", &bearer)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        headers[ERROR_HEADER],
        Denial::CredentialUnavailable.message()
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    let tcp = env.guest.connect(ANY, 80, 40211).await.unwrap();
    assert_eq!(
        request_over(tcp, get("plain.test", "/", &[])).await.0,
        StatusCode::OK
    );
    // cubed refuses (another thread's machine, an old epoch, no proxy).
    let refusing = cubed(
        &env,
        Cubed::Refuse(refuse(
            proto::Code::FailedPrecondition,
            "stale_epoch",
            "a newer epoch has been used for this machine",
        )),
    )
    .await;
    let tls = env.tls("api.github.test", 40212).await.unwrap();
    let (status, headers, _) = request_over(tls, get("api.github.test", "/", &bearer)).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        headers[ERROR_HEADER],
        "cubed refused the credential request: a newer epoch has been used for this machine"
    );
    assert_eq!(refusing.headers.lock().unwrap().len(), 1);
    assert_eq!(
        env.reasons(),
        [
            (
                "api.github.test".to_string(),
                "credential_unavailable".to_string()
            ),
            (
                "api.github.test".to_string(),
                "credential_unavailable".to_string()
            ),
        ]
    );
    assert_eq!(env.tls.hits.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = false)]
async fn a_cubed_that_does_not_answer_is_given_ten_seconds() {
    let env = Env::new(credential_policy(Duration::from_secs(900))).await;
    let _silent = cubed(&env, Cubed::Silent).await;
    let started = std::time::Instant::now();
    let tls = env.tls("api.github.test", 40220).await.unwrap();
    let (status, headers, _) = request_over(tls, get("api.github.test", "/", &[])).await;
    let waited = started.elapsed();
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        headers[ERROR_HEADER],
        "cubed did not take the credential request in time"
    );
    assert!(
        waited >= Duration::from_secs(10) && waited < Duration::from_secs(13),
        "{waited:?}"
    );
}

#[tokio::test]
async fn an_answer_under_way_when_cubed_goes_drains_to_the_guest_then_ends() {
    let env = Env::new(credential_policy(Duration::from_secs(900))).await;
    let cubed = cubed(&env, Cubed::Serve).await;
    let mut tls = env.tls("github.test", 40230).await.unwrap();
    tls.write_all(b"GET /stream HTTP/1.1\r\nhost: github.test\r\n\r\n")
        .await
        .unwrap();
    let mut first = [0u8; 4096];
    let n = tls.read(&mut first).await.unwrap();
    assert!(String::from_utf8_lossy(&first[..n]).starts_with("HTTP/1.1 200"));
    tokio::time::sleep(Duration::from_millis(300)).await;
    // cubed goes: its connection closes, and the stream with it.
    cubed.connection.close(0u32.into(), b"bye");
    let mut received = n;
    let mut buffer = vec![0u8; 65536];
    let end = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match tls.read(&mut buffer).await {
                Ok(0) => return Ok(()),
                Ok(k) => received += k,
                Err(e) => return Err(e),
            }
        }
    })
    .await
    .expect("the answer ended once cubed was gone");
    // The runner ends a broken answer as hyper does an upstream failure:
    // the guest's TLS ends without close_notify (no reset from the runner).
    match &end {
        Ok(()) => {}
        Err(error) => assert_eq!(
            error.kind(),
            io::ErrorKind::UnexpectedEof,
            "an EOF, not a reset: {error:?}"
        ),
    }
    let written = cubed.written.load(Ordering::SeqCst);
    assert!(received > 8 * 1024, "{received}");
    assert!(received <= written + 4096, "{received} of {written}");
    // A new credential request: refused at once, and reported.
    let tls = env.tls("github.test", 40231).await.unwrap();
    let (status, _, _) = request_over(tls, get("github.test", "/", &[])).await;
    assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        env.reasons(),
        [(
            "github.test".to_string(),
            "credential_unavailable".to_string()
        )]
    );
}

async fn request_over<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    io: S,
    exchange: Request<Full<Bytes>>,
) -> (StatusCode, http::HeaderMap, Bytes) {
    request(io, exchange).await
}
