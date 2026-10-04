//! In-process LAN tests: a smoltcp test guest talks to the gateway's LAN over
//! an in-memory frame pipe. Upstreams and the decision server are local fakes.
mod common;

use base64::{Engine, engine::general_purpose::STANDARD};
use common::*;
use rustls::pki_types::ServerName;
use std::{
    net::{IpAddr, Ipv4Addr},
    sync::{Arc, atomic::Ordering},
    time::Duration,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

fn dns_query(id: u16, name: &str, qtype: u16) -> Vec<u8> {
    let mut out = id.to_be_bytes().to_vec();
    out.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
    for label in name.split('.') {
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.extend_from_slice(&[0, (qtype >> 8) as u8, qtype as u8, 0, 1]);
    out
}

fn json(body: &[u8]) -> serde_json::Value {
    serde_json::from_slice(body).unwrap()
}

fn name(n: &str) -> ServerName<'static> {
    ServerName::try_from(n.to_string()).unwrap()
}

#[tokio::test]
async fn lease_dns_and_https_through_an_allow_decision() {
    let env = Env::new(allow_with(&[(GH, REAL_TOKEN)])).await;
    let lease = env.guest.wait_for_lease().await;
    assert_eq!(
        lease.address.unwrap().address(),
        Ipv4Addr::new(10, 77, 0, 2)
    );
    assert_eq!(lease.address.unwrap().prefix_len(), 24);
    assert_eq!(lease.router, Some(Ipv4Addr::new(10, 77, 0, 1)));
    assert_eq!(lease.dns, vec![Ipv4Addr::new(10, 77, 0, 1)]);
    assert_eq!(lease.mtu, Some(1500));
    assert!(env.lan.stats.leased.load(Ordering::Relaxed));

    // A: a test-hooks host resolves; AAAA: empty NOERROR; MX: NOTIMP.
    let answer = env.guest.dns(&dns_query(7, "github.test", 1)).await;
    assert_eq!(&answer[..2], &[0, 7]);
    assert_eq!(answer[3] & 0x0f, 0);
    assert_eq!(u16::from_be_bytes([answer[6], answer[7]]), 1);
    assert_eq!(&answer[answer.len() - 4..], &[203, 0, 113, 1]);
    let aaaa = env.guest.dns(&dns_query(8, "github.test", 28)).await;
    assert_eq!((aaaa[3] & 0x0f, aaaa[7]), (0, 0));
    let mx = env.guest.dns(&dns_query(9, "github.test", 15)).await;
    assert_eq!(mx[3] & 0x0f, 4);

    // HTTPS with a Bearer placeholder, twice on one connection.
    let tls = env.tls(name("api.github.test"), 40001).await.unwrap();
    let (mut sender, connection) =
        hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(tls))
            .await
            .unwrap();
    tokio::spawn(connection);
    for path in ["/user?x=1", "/repos"] {
        let response = sender
            .send_request(get(
                "api.github.test",
                path,
                &[("authorization", format!("Bearer {GH}"))],
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        let body = http_body_util::BodyExt::collect(response.into_body())
            .await
            .unwrap()
            .to_bytes();
        let echo = json(&body);
        assert_eq!(echo["uri"], path);
        assert_eq!(
            echo["headers"]["authorization"],
            format!("Bearer {REAL_TOKEN}")
        );
        assert_eq!(echo["headers"]["host"], "api.github.test");
    }
    let requests = env.decide.requests.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    assert_eq!(
        requests[0],
        serde_json::json!({
            "vmId": VM_ID, "threadId": THREAD_ID, "scheme": "https", "method": "GET",
            "host": "api.github.test", "port": 443, "path": "/user", "placeholders": [GH],
        })
    );
    assert_eq!(env.tls_upstream.hits.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn deny_is_403_with_reason_and_never_reaches_upstream() {
    let env = Env::new(Arc::new(|_| {
        (
            Duration::ZERO,
            serde_json::json!({"allow": false, "reason": "host is not allowed"}),
        )
    }))
    .await;
    env.guest.wait_for_lease().await;
    let tls = env.tls(name("github.test"), 40002).await.unwrap();
    let (status, headers, _) = request(tls, get("github.test", "/", &[])).await;
    assert_eq!(status, 403);
    assert_eq!(headers["x-cube-denied"], "host is not allowed");
    assert_eq!(env.tls_upstream.hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn decision_timeout_denies() {
    let env = Env::with_timeout(
        Arc::new(|_| (Duration::from_secs(3), serde_json::json!({"allow": true}))),
        Duration::from_millis(300),
    )
    .await;
    env.guest.wait_for_lease().await;
    let tls = env.tls(name("github.test"), 40003).await.unwrap();
    let (status, headers, _) = request(tls, get("github.test", "/", &[])).await;
    assert_eq!(status, 403);
    assert_eq!(headers["x-cube-denied"], "policy decision timed out");
    assert_eq!(env.tls_upstream.hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn malformed_or_unreachable_decisions_deny() {
    let env = Env::new(Arc::new(|_| {
        (Duration::ZERO, serde_json::json!({"allow": "yes"}))
    }))
    .await;
    env.guest.wait_for_lease().await;
    let tls = env.tls(name("github.test"), 40004).await.unwrap();
    let (status, headers, _) = request(tls, get("github.test", "/", &[])).await;
    assert_eq!(status, 403);
    assert_eq!(headers["x-cube-denied"], "policy decision unavailable");
    std::fs::remove_file(env.dir.path().join("egress.sock")).unwrap();
    let tls = env.tls(name("github.test"), 40005).await.unwrap();
    let (status, _, _) = request(tls, get("github.test", "/", &[])).await;
    assert_eq!(status, 403);
    assert_eq!(env.tls_upstream.hits.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn other_tcp_ports_are_reset() {
    let env = Env::new(allow_with(&[])).await;
    env.guest.wait_for_lease().await;
    for (address, port) in [
        (Ipv4Addr::new(203, 0, 113, 1), 22),
        (Ipv4Addr::new(10, 77, 0, 1), 7777),
        (Ipv4Addr::new(1, 1, 1, 1), 8443),
    ] {
        let started = std::time::Instant::now();
        let error = env
            .guest
            .connect(address, port, 40010 + port % 100)
            .await
            .err();
        assert_eq!(
            error.map(|e| e.kind()),
            Some(std::io::ErrorKind::ConnectionRefused),
            "{address}:{port}"
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}

#[tokio::test]
async fn host_must_match_sni_and_no_sni_is_closed() {
    let env = Env::new(allow_with(&[])).await;
    env.guest.wait_for_lease().await;
    let tls = env.tls(name("github.test"), 40020).await.unwrap();
    let (status, headers, _) = request(tls, get("api.github.test", "/", &[])).await;
    assert_eq!(status, 421);
    assert!(headers.contains_key("x-cube-denied"));
    // An IP server name sends no SNI: the gateway closes the connection.
    let no_sni = env
        .tls(
            ServerName::IpAddress(IpAddr::from([203, 0, 113, 1]).into()),
            40021,
        )
        .await;
    assert!(no_sni.is_err());
    assert!(env.decide.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn private_upstreams_are_refused_even_when_allowed() {
    let env = Env::new(allow_with(&[])).await;
    env.guest.wait_for_lease().await;
    // `localhost` resolves to loopback on the gateway host.
    let tls = env.tls(name("localhost"), 40030).await.unwrap();
    let (status, headers, _) = request(tls, get("localhost", "/", &[])).await;
    assert_eq!(status, 403);
    assert_eq!(headers["x-cube-denied"], "upstream address is not public");
    for (i, host) in [
        "10.1.2.3",
        "192.168.1.1",
        "169.254.169.254",
        "127.0.0.1",
        "10.77.0.1",
    ]
    .into_iter()
    .enumerate()
    {
        let tcp = env
            .guest
            .connect(Ipv4Addr::new(203, 0, 113, 1), 80, 40031 + i as u16)
            .await
            .unwrap();
        let (status, headers, _) = request(tcp, get(host, "/", &[])).await;
        assert_eq!(status, 403, "{host}");
        assert_eq!(headers["x-cube-denied"], "upstream address is not public");
    }
    assert_eq!(
        env.decide.requests.lock().unwrap().len(),
        6,
        "all were allowed by policy"
    );
}

#[tokio::test]
async fn plain_http_works_but_never_carries_secrets() {
    let env = Env::new(allow_with(&[(GH, REAL_TOKEN)])).await;
    env.guest.wait_for_lease().await;
    let tcp = env
        .guest
        .connect(Ipv4Addr::new(203, 0, 113, 1), 80, 40040)
        .await
        .unwrap();
    let (status, _, body) = request(tcp, get("plain.test", "/index", &[])).await;
    assert_eq!(status, 200);
    assert_eq!(json(&body)["uri"], "/index");

    let tcp = env
        .guest
        .connect(Ipv4Addr::new(203, 0, 113, 1), 80, 40041)
        .await
        .unwrap();
    let (status, headers, _) = request(
        tcp,
        get(
            "plain.test",
            "/",
            &[("authorization", format!("Bearer {GH}"))],
        ),
    )
    .await;
    assert_eq!(status, 403);
    assert_eq!(headers["x-cube-denied"], "secrets are only sent over https");
    assert_eq!(env.plain_upstream.hits.load(Ordering::SeqCst), 1);
    let requests = env.decide.requests.lock().unwrap().clone();
    assert_eq!(requests[1]["scheme"], "http");
    assert_eq!(requests[1]["port"], 80);

    // Port 80 with a Host naming another port is misdirected.
    let tcp = env
        .guest
        .connect(Ipv4Addr::new(203, 0, 113, 1), 80, 40042)
        .await
        .unwrap();
    let (status, _, _) = request(tcp, get("plain.test:8080", "/", &[])).await;
    assert_eq!(status, 421);
}

#[tokio::test]
async fn basic_credentials_are_substituted_only_when_returned() {
    let env = Env::new(allow_with(&[(GH, REAL_TOKEN)])).await;
    env.guest.wait_for_lease().await;
    let basic = STANDARD.encode(format!("x-access-token:{GH}"));
    let tls = env.tls(name("github.test"), 40050).await.unwrap();
    let (status, _, body) = request(
        tls,
        get(
            "github.test",
            "/cubeyard/cube.git/info/refs",
            &[
                ("authorization", format!("Basic {basic}")),
                ("x-other", OTHER.to_string()),
            ],
        ),
    )
    .await;
    assert_eq!(status, 200);
    let echo = json(&body);
    assert_eq!(
        echo["headers"]["authorization"],
        format!(
            "Basic {}",
            STANDARD.encode(format!("x-access-token:{REAL_TOKEN}"))
        )
    );
    assert_eq!(echo["headers"]["x-other"], OTHER);
    let requests = env.decide.requests.lock().unwrap().clone();
    assert_eq!(requests[0]["placeholders"], serde_json::json!([GH, OTHER]));

    // Without a substitution the placeholder is forwarded as is.
    let env = Env::new(allow_with(&[])).await;
    env.guest.wait_for_lease().await;
    let tls = env.tls(name("github.test"), 40051).await.unwrap();
    let (_, _, body) = request(
        tls,
        get(
            "github.test",
            "/",
            &[("authorization", format!("Bearer {GH}"))],
        ),
    )
    .await;
    assert_eq!(
        json(&body)["headers"]["authorization"],
        format!("Bearer {GH}")
    );
}

#[tokio::test]
async fn connect_and_upgrade_are_refused() {
    let env = Env::new(allow_with(&[])).await;
    env.guest.wait_for_lease().await;
    let tls = env.tls(name("github.test"), 40060).await.unwrap();
    let upgrade = get(
        "github.test",
        "/socket",
        &[
            ("connection", "upgrade".to_string()),
            ("upgrade", "websocket".to_string()),
        ],
    );
    let (status, headers, _) = request(tls, upgrade).await;
    assert_eq!(status, 403);
    assert_eq!(
        headers["x-cube-denied"],
        "protocol upgrades are not supported"
    );
    assert!(env.decide.requests.lock().unwrap().is_empty());
}

#[tokio::test]
async fn gateway_dials_a_listener_in_the_guest() {
    let env = Env::new(allow_with(&[])).await;
    env.guest.wait_for_lease().await;
    let listener = env.guest.listen(22);
    let mut flow = env.lan.dial(22).await.unwrap();
    let mut guest_side = env.guest.accept(listener).await;
    let remote = env.guest.remote(listener).unwrap();
    assert_eq!(remote.addr, smoltcp::wire::IpAddress::v4(10, 77, 0, 1));
    flow.write_all(b"SSH-2.0-test\r\n").await.unwrap();
    let mut buf = [0u8; 14];
    guest_side.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"SSH-2.0-test\r\n");
    guest_side.write_all(b"pong").await.unwrap();
    let mut buf = [0u8; 4];
    flow.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"pong");
    // A closed guest port fails the dial.
    assert!(env.lan.dial(2222).await.is_err());
}

#[tokio::test]
async fn bulk_transfer_in_both_directions() {
    let env = Env::new(allow_with(&[])).await;
    env.guest.wait_for_lease().await;
    let listener = env.guest.listen(22);
    let flow = env.lan.dial(22).await.unwrap();
    let guest_side = env.guest.accept(listener).await;
    let data: Vec<u8> = (0..4 * 1024 * 1024u32).map(|i| (i % 253) as u8).collect();
    let (mut flow_read, mut flow_write) = tokio::io::split(flow);
    let (mut guest_read, mut guest_write) = tokio::io::split(guest_side);
    let expected = data.clone();
    let up = tokio::spawn(async move {
        flow_write.write_all(&data).await.unwrap();
        flow_write.shutdown().await.unwrap();
        let mut back = vec![];
        flow_read.read_to_end(&mut back).await.unwrap();
        back
    });
    let mut received = vec![];
    guest_read.read_to_end(&mut received).await.unwrap();
    assert_eq!(received.len(), expected.len());
    assert!(received == expected);
    guest_write.write_all(&received).await.unwrap();
    guest_write.shutdown().await.unwrap();
    let back = tokio::time::timeout(Duration::from_secs(30), up)
        .await
        .unwrap()
        .unwrap();
    assert!(back == expected);
}
