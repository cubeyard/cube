#![cfg(target_os = "linux")]
use cube_node_transport::{
    ALPN, DeliveryError, Request, Response, bind_loopback, call, encode,
    host::{Binding, ExecSpec, Host, Operation},
    read_frame, serve_host,
};
use iroh::{EndpointAddr, SecretKey};
use std::{fs, sync::Arc, time::Duration};
use tokio::time::timeout;

#[tokio::test]
async fn authorization_and_hello_gate_precede_mutation() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let state = root.path().join("state");
    let key = SecretKey::generate();
    let allowed = SecretKey::generate();
    Host::initialize(
        &state,
        Binding {
            thread_id: "t-test".into(),
            environment_id: 1,
            node_id: "node-test".into(),
        },
        key.public(),
        allowed.public(),
        &workspace,
    )
    .unwrap();
    let host = Host::open(&state, key.public()).unwrap();
    let server = bind_loopback(key, "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let address = EndpointAddr::new(server.id()).with_ip_addr(server.bound_sockets()[0]);
    let task = tokio::spawn({
        let host = Arc::clone(&host);
        let server = server.clone();
        let peer = allowed.public();
        async move {
            serve_host(&server, peer, "node-test", Some(host))
                .await
                .unwrap();
        }
    });
    let query = Request::ExecStart {
        env: 1,
        operation_id: "op-rejected".into(),
        spec: ExecSpec {
            command: "touch must-not-exist".into(),
            guest_cwd: ".".into(),
            timeout_ms: 1000,
            output_limit: 1,
        },
    };
    let client = bind_loopback(allowed, "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let error = call(&client, address.clone(), "node-wrong", &query)
        .await
        .unwrap_err();
    let error = error.downcast_ref::<DeliveryError>().unwrap();
    assert_eq!(error.code, "WRONG_NODE");
    assert!(!error.completion_unknown);
    let connection = client.connect(address.clone(), ALPN).await.unwrap();
    let (mut send, mut recv) = connection.open_bi().await.unwrap();
    send.write_all(&encode(&query).unwrap()).await.unwrap();
    send.finish().unwrap();
    assert!(
        matches!(timeout(Duration::from_secs(6), read_frame::<Response>(&mut recv)).await.unwrap().unwrap(), Response::Error { code, completion_unknown: false, .. } if code == "INVALID_REQUEST")
    );
    connection.close(0u32.into(), b"done");
    let rogue = bind_loopback(SecretKey::generate(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    assert!(call(&rogue, address, "node-test", &query).await.is_err());
    assert_eq!(host.get(1, "op-rejected").unwrap(), Operation::Unknown);
    assert!(!workspace.join("must-not-exist").exists());
    host.shutdown().await;
    client.close().await;
    rogue.close().await;
    server.close().await;
    timeout(Duration::from_secs(6), task)
        .await
        .unwrap()
        .unwrap();
}
