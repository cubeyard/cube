//! The whole gateway over Iroh loopback: control socket, frame channel to a
//! fake runner (hello authorization like the runner's), a test guest behind
//! it, and the SSH dial path.
mod common;

use bytes::Bytes;
use common::*;
use cube_gateway::{ServeOptions, decide::DECIDE_TIMEOUT, dial, lan::LanLimits};
use cube_node_transport::{
    NetworkMode,
    l2::{Fragmenter, FrameReady, L2_ALPN, Reassembler, accept_hello, answer_hello},
};
use http_body_util::{BodyExt, Full};
use hyper_util::rt::TokioIo;
use iroh::{Endpoint, EndpointId, SecretKey, endpoint::Connection, endpoint::presets};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
    sync::mpsc,
};

async fn control(
    socket: &Path,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> (u16, serde_json::Value) {
    let stream = UnixStream::connect(socket).await.unwrap();
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
        .await
        .unwrap();
    tokio::spawn(connection);
    let request = hyper::Request::builder()
        .method(method)
        .uri(path)
        .header("host", "gateway")
        .body(Full::new(Bytes::from(
            body.map(|b| serde_json::to_vec(&b).unwrap())
                .unwrap_or_default(),
        )))
        .unwrap();
    let response = sender.send_request(request).await.unwrap();
    let status = response.status().as_u16();
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let value = if body.is_empty() {
        serde_json::Value::Null
    } else {
        serde_json::from_slice(&body).unwrap()
    };
    (status, value)
}

/// Accepts `cube/l2/1` like the runner: only from `gateway`, only for this
/// VM and the currently expected token. Bridges frames to a test guest.
struct FakeRunner {
    endpoint: Endpoint,
    token: Arc<Mutex<String>>,
    current: Arc<Mutex<Option<Connection>>>,
    accepted: Arc<Mutex<Vec<Connection>>>,
    guest: TestGuest,
}

impl FakeRunner {
    async fn start(gateway: EndpointId, token: &str) -> Self {
        let endpoint = Endpoint::builder(presets::Minimal)
            .secret_key(SecretKey::generate())
            .alpns(vec![L2_ALPN.to_vec()])
            .clear_ip_transports()
            .clear_relay_transports()
            .clear_address_lookup()
            .bind_addr("127.0.0.1:0".parse::<std::net::SocketAddr>().unwrap())
            .unwrap()
            .bind()
            .await
            .unwrap();
        let token = Arc::new(Mutex::new(token.to_string()));
        let current: Arc<Mutex<Option<Connection>>> = Arc::new(Mutex::new(None));
        let accepted = Arc::new(Mutex::new(vec![]));
        let (to_guest, guest_rx) = mpsc::unbounded_channel::<Bytes>();
        let out_conn = current.clone();
        let mut fragmenter = Fragmenter::default();
        let guest = TestGuest::start(
            guest_rx,
            Box::new(move |frame| {
                if let Some(c) = out_conn.lock().unwrap().as_ref() {
                    for d in fragmenter.split(&frame, c.max_datagram_size().unwrap_or(1200)) {
                        let _ = c.send_datagram(d);
                    }
                }
            }),
        );
        let (ep, tok, cur, acc) = (
            endpoint.clone(),
            token.clone(),
            current.clone(),
            accepted.clone(),
        );
        tokio::spawn(async move {
            while let Some(incoming) = ep.accept().await {
                let Ok(connection) = incoming.await else {
                    continue;
                };
                let (tok, cur, acc, to_guest) =
                    (tok.clone(), cur.clone(), acc.clone(), to_guest.clone());
                tokio::spawn(async move {
                    let Ok((hello, send)) = accept_hello(&connection).await else {
                        return;
                    };
                    let expected = tok.lock().unwrap().clone();
                    let refusal = if connection.remote_id() != gateway {
                        Some("peer is not the gateway of the latest vm.start")
                    } else if hello.vm_id != VM_ID || hello.thread_id != THREAD_ID {
                        Some("no running vm with that id")
                    } else if !cube_node_transport::l2::constant_time_eq(
                        hello.frame_token.as_bytes(),
                        expected.as_bytes(),
                    ) {
                        Some("frame token does not match")
                    } else {
                        None
                    };
                    if let Some(reason) = refusal {
                        let _ = answer_hello(send, &FrameReady::refused(reason)).await;
                        tokio::time::sleep(Duration::from_millis(100)).await;
                        connection.close(1u32.into(), b"refused");
                        return;
                    }
                    answer_hello(send, &FrameReady::accepted()).await.unwrap();
                    // A newly authenticated connection replaces the old one.
                    if let Some(old) = cur.lock().unwrap().replace(connection.clone()) {
                        old.close(0u32.into(), b"replaced");
                    }
                    acc.lock().unwrap().push(connection.clone());
                    let mut reassembler = Reassembler::default();
                    while let Ok(d) = connection.read_datagram().await {
                        if let Some(frame) = reassembler.push(d) {
                            let _ = to_guest.send(frame);
                        }
                    }
                });
            }
        });
        Self {
            endpoint,
            token,
            current,
            accepted,
            guest,
        }
    }

    fn runner_json(&self) -> serde_json::Value {
        let address = self
            .endpoint
            .bound_sockets()
            .into_iter()
            .find(|a| a.is_ipv4())
            .unwrap();
        serde_json::json!({
            "peer": self.endpoint.id().to_string(),
            "network": "loopback",
            "address": address.to_string(),
        })
    }
}

struct Gateway {
    _dir: tempfile::TempDir,
    control: PathBuf,
    running: Option<cube_gateway::Running>,
    _decide: FakeDecide,
}

impl Gateway {
    async fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let decide_path = dir.path().join("egress.sock");
        let decide = FakeDecide::start(decide_path.clone(), allow_with(&[]));
        let upstream_ca = UpstreamCa::new();
        let tls = FakeUpstream::tls(&upstream_ca, &["github.test"]).await;
        let plain = FakeUpstream::plain().await;
        let upstream = Arc::try_unwrap(test_upstream(&upstream_ca, &tls, &plain))
            .ok()
            .unwrap();
        let control = dir.path().join("gateway.sock");
        let running = cube_gateway::start(ServeOptions {
            state: dir.path().join("gateway"),
            control: control.clone(),
            decide: decide_path,
            network: NetworkMode::Loopback,
            listen: None,
            upstream,
            decide_timeout: DECIDE_TIMEOUT,
            limits: LanLimits::default(),
        })
        .await
        .unwrap();
        Self {
            _dir: dir,
            control,
            running: Some(running),
            _decide: decide,
        }
    }
    fn peer(&self) -> EndpointId {
        self.running.as_ref().unwrap().ready["peer"]
            .as_str()
            .unwrap()
            .parse()
            .unwrap()
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        if let Some(running) = self.running.take() {
            running.stop();
        }
    }
}

fn attach(runner: &FakeRunner, token: &str) -> serde_json::Value {
    serde_json::json!({
        "threadId": THREAD_ID,
        "runner": runner.runner_json(),
        "frameToken": token,
        "mac": GUEST_MAC_TEXT,
    })
}

async fn wait_status(
    control: &Path,
    check: impl Fn(&serde_json::Value) -> bool,
) -> serde_json::Value {
    for _ in 0..300 {
        let (status, value) = control_get(control).await;
        if status == 200 && check(&value) {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("status never matched: {:?}", control_get(control).await);
}

async fn control_get(socket: &Path) -> (u16, serde_json::Value) {
    control(socket, "GET", &format!("/v1/vms/{VM_ID}"), None).await
}

const TOKEN_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TOKEN_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TOKEN_C: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

#[tokio::test]
async fn attach_lease_and_ssh_dial_over_iroh() {
    let gateway = Gateway::start().await;
    let ready = &gateway.running.as_ref().unwrap().ready;
    assert_eq!(ready["ready"], true);
    let (status, hello) = control(&gateway.control, "GET", "/v1/hello", None).await;
    assert_eq!(status, 200);
    assert_eq!(hello["peer"], ready["peer"]);
    assert_eq!(hello["network"], "loopback");
    assert_eq!(hello["caSha256"], ready["caSha256"]);
    assert!(
        hello["caPem"]
            .as_str()
            .unwrap()
            .starts_with("-----BEGIN CERTIFICATE-----")
    );
    let mode = std::fs::metadata(&gateway.control).unwrap();
    assert_eq!(
        std::os::unix::fs::PermissionsExt::mode(&mode.permissions()) & 0o777,
        0o600
    );

    let runner = FakeRunner::start(gateway.peer(), TOKEN_A).await;
    let (status, value) = control(
        &gateway.control,
        "PUT",
        &format!("/v1/vms/{VM_ID}"),
        Some(attach(&runner, TOKEN_A)),
    )
    .await;
    assert_eq!(status, 200, "{value}");
    let lease = runner.guest.wait_for_lease().await;
    assert_eq!(lease.mtu, Some(1500));
    let status = wait_status(&gateway.control, |s| {
        s["leased"] == true && s["link"] == "up"
    })
    .await;
    assert_eq!(status["guestIp"], "10.77.0.2");
    assert_eq!(status["threadId"], THREAD_ID);

    // The OpenSSH ProxyCommand path: an upgraded stream to guest port 22.
    let listener = runner.guest.listen(22);
    let dialed = dial::open(&gateway.control, VM_ID, 22).await.unwrap();
    let mut guest_side = runner.guest.accept(listener).await;
    let mut stream = dialed.stream;
    assert!(dialed.early.is_empty());
    guest_side
        .write_all(b"SSH-2.0-OpenSSH_test\r\n")
        .await
        .unwrap();
    let mut banner = [0u8; 22];
    stream.read_exact(&mut banner).await.unwrap();
    assert_eq!(&banner, b"SSH-2.0-OpenSSH_test\r\n");
    stream.write_all(b"client hello").await.unwrap();
    let mut buf = [0u8; 12];
    guest_side.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"client hello");

    // The portal path: a guest service on an unprivileged port.
    let listener = runner.guest.listen(8080);
    let dialed = dial::open(&gateway.control, VM_ID, 8080).await.unwrap();
    let mut service = runner.guest.accept(listener).await;
    let mut stream = dialed.stream;
    stream.write_all(b"GET / HTTP/1.1\r\n\r\n").await.unwrap();
    let mut request = [0u8; 18];
    service.read_exact(&mut request).await.unwrap();
    assert_eq!(&request, b"GET / HTTP/1.1\r\n\r\n");
    let closed = dial::open(&gateway.control, VM_ID, 8081).await.err().unwrap();
    assert!(format!("{closed:#}").contains("502"), "{closed:#}");

    let refused = dial::open(&gateway.control, VM_ID, 23).await.err().unwrap();
    assert!(format!("{refused:#}").contains("403"), "{refused:#}");
    let privileged = dial::open(&gateway.control, VM_ID, 80).await.err().unwrap();
    assert!(format!("{privileged:#}").contains("403"), "{privileged:#}");
    let missing = dial::open(&gateway.control, "fedcba9876543210", 22)
        .await
        .err()
        .unwrap();
    assert!(format!("{missing:#}").contains("404"), "{missing:#}");

    let (status, list) = control(&gateway.control, "GET", "/v1/vms", None).await;
    assert_eq!(status, 200);
    assert_eq!(list["vms"].as_array().unwrap().len(), 1);
    assert_eq!(list["vms"][0]["vmId"], VM_ID);

    let (status, _) = control(
        &gateway.control,
        "DELETE",
        &format!("/v1/vms/{VM_ID}"),
        None,
    )
    .await;
    assert_eq!(status, 204);
    assert_eq!(control_get(&gateway.control).await.0, 404);
    let gone = dial::open(&gateway.control, VM_ID, 22).await.err().unwrap();
    assert!(format!("{gone:#}").contains("404"));
    // Detaching closes the frame connection.
    let first = runner.accepted.lock().unwrap()[0].clone();
    tokio::time::timeout(Duration::from_secs(5), first.closed())
        .await
        .unwrap();
}

#[tokio::test]
async fn wrong_token_is_refused_and_a_new_token_replaces_the_connection() {
    let gateway = Gateway::start().await;
    let runner = FakeRunner::start(gateway.peer(), TOKEN_B).await;
    let path = format!("/v1/vms/{VM_ID}");
    let (status, _) = control(
        &gateway.control,
        "PUT",
        &path,
        Some(attach(&runner, TOKEN_A)),
    )
    .await;
    assert_eq!(status, 200);
    let refused = wait_status(&gateway.control, |s| s["lastError"].is_string()).await;
    assert!(
        refused["lastError"]
            .as_str()
            .unwrap()
            .contains("frame token does not match"),
        "{refused}"
    );
    assert_ne!(refused["link"], "up");

    // The right token (cubed re-PUTs after vm.start) brings the link up.
    let (status, _) = control(
        &gateway.control,
        "PUT",
        &path,
        Some(attach(&runner, TOKEN_B)),
    )
    .await;
    assert_eq!(status, 200);
    runner.guest.wait_for_lease().await;
    wait_status(&gateway.control, |s| {
        s["link"] == "up" && s["leased"] == true
    })
    .await;
    let first = runner.accepted.lock().unwrap()[0].clone();

    // vm.start with a newer epoch rotates the token: a new connection
    // replaces the old one and the LAN (and lease) survive.
    *runner.token.lock().unwrap() = TOKEN_C.to_string();
    let (status, _) = control(
        &gateway.control,
        "PUT",
        &path,
        Some(attach(&runner, TOKEN_C)),
    )
    .await;
    assert_eq!(status, 200);
    tokio::time::timeout(Duration::from_secs(5), first.closed())
        .await
        .unwrap();
    wait_status(&gateway.control, |s| s["link"] == "up").await;
    assert_eq!(runner.accepted.lock().unwrap().len(), 2);
    let listener = runner.guest.listen(22);
    let _stream = dial::open(&gateway.control, VM_ID, 22).await.unwrap();
    runner.guest.accept(listener).await;
    assert!(runner.current.lock().unwrap().is_some());
}

#[tokio::test]
async fn attach_requests_are_validated() {
    let gateway = Gateway::start().await;
    let runner = FakeRunner::start(gateway.peer(), TOKEN_A).await;
    let put =
        |path: String, body: serde_json::Value| put_status(gateway.control.clone(), path, body);
    let ok = attach(&runner, TOKEN_A);
    assert_eq!(put("/v1/vms/NOT-HEX".into(), ok.clone()).await, 400);
    let mut bad_token = ok.clone();
    bad_token["frameToken"] = "short".into();
    assert_eq!(put(format!("/v1/vms/{VM_ID}"), bad_token).await, 400);
    let mut bad_mac = ok.clone();
    bad_mac["mac"] = "ff:ff:ff:ff:ff:ff".into();
    assert_eq!(put(format!("/v1/vms/{VM_ID}"), bad_mac).await, 400);
    let mut relay = ok.clone();
    relay["runner"] =
        serde_json::json!({"peer": runner.endpoint.id().to_string(), "network": "relay"});
    assert_eq!(
        put(format!("/v1/vms/{VM_ID}"), relay).await,
        400,
        "loopback gateway cannot reach a relay runner"
    );
    let mut extra = ok.clone();
    extra["secret"] = "x".into();
    assert_eq!(put(format!("/v1/vms/{VM_ID}"), extra).await, 400);
    assert_eq!(put(format!("/v1/vms/{VM_ID}"), ok.clone()).await, 200);
    let mut other_thread = ok.clone();
    other_thread["threadId"] = "thread-2".into();
    assert_eq!(put(format!("/v1/vms/{VM_ID}"), other_thread).await, 409);
    assert_eq!(
        put(format!("/v1/vms/{VM_ID}"), ok).await,
        200,
        "same request is idempotent"
    );
}

async fn put_status(socket: PathBuf, path: String, body: serde_json::Value) -> u16 {
    control(&socket, "PUT", &path, Some(body)).await.0
}

#[tokio::test]
async fn a_second_gateway_cannot_take_a_live_control_socket() {
    let gateway = Gateway::start().await;
    let dir = tempfile::tempdir().unwrap();
    let upstream_ca = UpstreamCa::new();
    let tls = FakeUpstream::tls(&upstream_ca, &["github.test"]).await;
    let plain = FakeUpstream::plain().await;
    let second = cube_gateway::start(ServeOptions {
        state: dir.path().join("gateway"),
        control: gateway.control.clone(),
        decide: dir.path().join("egress.sock"),
        network: NetworkMode::Loopback,
        listen: None,
        upstream: Arc::try_unwrap(test_upstream(&upstream_ca, &tls, &plain))
            .ok()
            .unwrap(),
        decide_timeout: DECIDE_TIMEOUT,
        limits: LanLimits::default(),
    })
    .await;
    assert!(second.is_err());
    assert_eq!(
        control(&gateway.control, "GET", "/v1/hello", None).await.0,
        200
    );
}
