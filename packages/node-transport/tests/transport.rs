//! Real iroh/QUIC on explicitly bound loopback sockets. No relays, Incus,
//! provider calls, external listener, or existing thread resources.
use std::{path::Path, process::Stdio, time::Duration};

use cube_node_transport::{ALPN, Request, Response, bind_loopback, encode, read_frame, serve};
use iroh::{EndpointAddr, SecretKey};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};

const BIN: &str = env!("CARGO_BIN_EXE_cube-runner");
const DEADLINE: Duration = Duration::from_secs(12);

async fn run(args: &[&str]) -> std::process::Output {
    timeout(
        DEADLINE,
        Command::new(BIN).args(args).kill_on_drop(true).output(),
    )
    .await
    .expect("CLI deadline")
    .expect("CLI spawn")
}
async fn generate(path: &Path) -> String {
    let result = run(&["keygen", "--key", path.to_str().unwrap()]).await;
    assert!(result.status.success(), "{:?}", result);
    serde_json::from_slice::<Value>(&result.stdout).unwrap()["peerId"]
        .as_str()
        .unwrap()
        .into()
}
async fn start(path: &Path, allowed: &str) -> (Child, Value) {
    let mut child = Command::new(BIN)
        .args([
            "serve",
            "--key",
            path.to_str().unwrap(),
            "--allow-peer",
            allowed,
            "--node-id",
            "node-test",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut line = String::new();
    timeout(
        DEADLINE,
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line),
    )
    .await
    .unwrap()
    .unwrap();
    (child, serde_json::from_str(&line).expect("ready JSON"))
}

#[tokio::test]
async fn separate_processes_pinned_peers_and_restart() {
    let root = tempfile::tempdir().unwrap();
    let server_key = root.path().join("server.key");
    let client_key = root.path().join("client.key");
    let rogue_key = root.path().join("rogue.key");
    let server_id = generate(&server_key).await;
    let client_id = generate(&client_key).await;
    let rogue_id = generate(&rogue_key).await;
    // Identity creation never overwrites an existing key.
    assert!(
        !run(&["keygen", "--key", server_key.to_str().unwrap()])
            .await
            .status
            .success()
    );

    for _ in 0..2 {
        let (mut child, ready) = start(&server_key, &client_id).await;
        assert_eq!(ready["peerId"], server_id);
        let address = ready["addresses"][0].as_str().unwrap();
        let call = |key, peer, node| {
            vec![
                "hello",
                "--key",
                key,
                "--peer",
                peer,
                "--address",
                address,
                "--expect-node",
                node,
            ]
        };
        let response = run(&call(client_key.to_str().unwrap(), &server_id, "node-test")).await;
        assert!(response.status.success(), "{:?}", response);
        let response: Value = serde_json::from_slice(&response.stdout).unwrap();
        assert_eq!(response["nodeId"], "node-test");
        assert_eq!(response["capabilities"], serde_json::json!(["node.hello"]));
        assert_eq!(response["profiles"], serde_json::json!([]));

        let wrong_node = run(&call(
            client_key.to_str().unwrap(),
            &server_id,
            "node-other",
        ))
        .await;
        assert!(!wrong_node.status.success());
        assert!(String::from_utf8_lossy(&wrong_node.stderr).contains("WRONG_NODE"));
        assert!(
            !run(&call(rogue_key.to_str().unwrap(), &server_id, "node-test"))
                .await
                .status
                .success()
        );
        // Correct address with the wrong pinned server key cannot authenticate.
        assert!(
            !run(&call(client_key.to_str().unwrap(), &rogue_id, "node-test"))
                .await
                .status
                .success()
        );
        child.kill().await.unwrap();
        child.wait().await.unwrap();
    }
    // Existing identity corruption is a hard failure, not key regeneration.
    std::fs::write(&server_key, b"broken").unwrap();
    assert!(
        !run(&[
            "serve",
            "--key",
            server_key.to_str().unwrap(),
            "--allow-peer",
            &client_id,
            "--node-id",
            "node-test"
        ])
        .await
        .status
        .success()
    );
}

#[tokio::test]
async fn real_wire_rejection_and_no_hello_before_authorization() {
    let client_key = SecretKey::generate();
    let server = bind_loopback(SecretKey::generate(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let address = EndpointAddr::new(server.id()).with_ip_addr(server.bound_sockets()[0]);
    let task = tokio::spawn({
        let server = server.clone();
        let allowed = client_key.public();
        async move { serve(&server, allowed, "node-test").await.unwrap() }
    });
    let rogue = bind_loopback(SecretKey::generate(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let connection = timeout(DEADLINE, rogue.connect(address.clone(), ALPN))
        .await
        .unwrap()
        .unwrap();
    // Send no application bytes: rejection must happen before node.hello.
    let closed = timeout(Duration::from_secs(2), connection.closed())
        .await
        .unwrap();
    assert!(closed.to_string().contains("UNAUTHORIZED"), "{closed}");
    rogue.close().await;

    let client = bind_loopback(client_key, "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    for (bytes, expected) in [
        (
            encode(&Request::Hello {
                protocol_version: 2,
            })
            .unwrap(),
            "INCOMPATIBLE_PROTOCOL",
        ),
        (vec![255; 4], "INVALID_REQUEST"),
        (vec![0, 0, 0, 10, b'{'], "INVALID_REQUEST"),
        (
            encode(&serde_json::json!({"method":"exec.start"})).unwrap(),
            "INVALID_REQUEST",
        ),
    ] {
        let connection = timeout(DEADLINE, client.connect(address.clone(), ALPN))
            .await
            .unwrap()
            .unwrap();
        let (mut send, mut recv) = connection.open_bi().await.unwrap();
        send.write_all(&bytes).await.unwrap();
        send.finish().unwrap();
        let response: Response = timeout(DEADLINE, read_frame(&mut recv))
            .await
            .unwrap()
            .unwrap();
        assert!(
            matches!(response, Response::Error { code, completion_unknown: false, .. } if code == expected)
        );
        connection.close(0u32.into(), b"done");
    }
    // An authorized peer that opens no stream cannot occupy a slot indefinitely.
    let idle = timeout(DEADLINE, client.connect(address, ALPN))
        .await
        .unwrap()
        .unwrap();
    timeout(Duration::from_secs(7), idle.closed())
        .await
        .expect("idle connection must close");
    client.close().await;
    server.close().await;
    timeout(DEADLINE, task).await.unwrap().unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn refuses_shared_or_symlinked_keys() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = tempfile::tempdir().unwrap();
    let key = root.path().join("private.key");
    let peer = generate(&key).await;
    let link = root.path().join("link.key");
    symlink(&key, &link).unwrap();
    let args = |path| {
        vec![
            "serve",
            "--key",
            path,
            "--allow-peer",
            &peer,
            "--node-id",
            "node-test",
        ]
    };
    assert!(!run(&args(link.to_str().unwrap())).await.status.success());
    std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(!run(&args(key.to_str().unwrap())).await.status.success());
}

#[tokio::test]
async fn explicit_direct_mode_never_implies_a_wildcard_listener() {
    use cube_node_transport::{NetworkMode, bind_node, validate_target};
    for mode in [NetworkMode::Loopback, NetworkMode::Direct] {
        for address in [
            "0.0.0.0:1234",
            "[::]:1234",
            "224.0.0.1:1234",
            "255.255.255.255:1234",
            "[ff02::1]:1234",
        ] {
            assert!(validate_target(address.parse().unwrap(), mode).is_err());
            assert!(
                bind_node(SecretKey::generate(), address.parse().unwrap(), mode)
                    .await
                    .is_err()
            );
        }
        assert!(validate_target("127.0.0.1:0".parse().unwrap(), mode).is_err());
        let endpoint = bind_node(SecretKey::generate(), "127.0.0.1:0".parse().unwrap(), mode)
            .await
            .unwrap();
        assert!(
            endpoint
                .bound_sockets()
                .iter()
                .all(|address| address.ip().is_loopback())
        );
        endpoint.close().await;
    }
    // Validate only; never contact documentation-range external addresses.
    for address in ["203.0.113.1:443", "[2001:db8::1]:443"] {
        assert!(validate_target(address.parse().unwrap(), NetworkMode::Loopback).is_err());
        assert!(validate_target(address.parse().unwrap(), NetworkMode::Direct).is_ok());
        assert!(validate_target(address.parse().unwrap(), NetworkMode::Relay).is_err());
    }
    assert!(
        bind_node(
            SecretKey::generate(),
            "127.0.0.1:0".parse().unwrap(),
            NetworkMode::Relay
        )
        .await
        .is_err()
    );
}
