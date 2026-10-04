//! Authorization, hello and protocol gates precede any VM mutation.
mod support;

use std::time::Duration;

use cube_node_transport::{
    ALPN, DeliveryError, Request, Response, bind_loopback, call, encode, read_frame,
};
use iroh::SecretKey;
use serde_json::json;
use support::*;
use tokio::time::timeout;

async fn exchange(connection: &iroh::endpoint::Connection, bytes: Vec<u8>) -> Option<Response> {
    let (mut send, mut recv) = connection.open_bi().await.ok()?;
    send.write_all(&bytes).await.ok()?;
    send.finish().ok()?;
    timeout(Duration::from_secs(6), read_frame::<Response>(&mut recv))
        .await
        .ok()?
        .ok()
}

fn code(response: Option<Response>) -> String {
    match response {
        Some(Response::Error {
            code,
            completion_unknown: false,
            ..
        }) => code,
        other => panic!("expected an error, got {other:?}"),
    }
}

#[tokio::test]
async fn authorization_and_protocol_gates_precede_mutation() {
    let fx = fixture();
    let served = serve(&fx).await;
    let allocate = encode(&allocate("t1", VM, 1, 8)).unwrap();

    // Wrong logical node: refused before the request is sent.
    let query: Request = serde_json::from_value(allocate_value()).unwrap();
    let error = call(&served.client, served.address.clone(), "node-wrong", &query)
        .await
        .unwrap_err();
    let error = error.downcast_ref::<DeliveryError>().unwrap();
    assert_eq!(error.code, "WRONG_NODE");
    assert!(!error.completion_unknown);

    // No hello first.
    let connection = served
        .client
        .connect(served.address.clone(), ALPN)
        .await
        .unwrap();
    assert_eq!(
        code(exchange(&connection, allocate.clone()).await),
        "INVALID_REQUEST"
    );
    connection.close(0u32.into(), b"done");

    // A protocol-2 peer is refused at hello and the connection ends there:
    // its next request is never read.
    for version in [1, 2] {
        let connection = served
            .client
            .connect(served.address.clone(), ALPN)
            .await
            .unwrap();
        let hello = encode(&json!({"method":"node.hello","protocolVersion":version})).unwrap();
        assert_eq!(
            code(exchange(&connection, hello).await),
            "INCOMPATIBLE_PROTOCOL"
        );
        assert!(exchange(&connection, allocate.clone()).await.is_none());
        connection.close(0u32.into(), b"done");
    }

    // After a protocol-3 hello, protocol-2 methods are unsupported, not executed.
    for request in [
        json!({"method":"exec.start","operationId":"op","env":1,"spec":{"command":"touch x"}}),
        json!({"method":"fs.write","env":1,"path":"x"}),
        json!({"method":"workspace.allocate.v2","threadId":"t1"}),
    ] {
        let connection = served
            .client
            .connect(served.address.clone(), ALPN)
            .await
            .unwrap();
        let hello = encode(&json!({"method":"node.hello","protocolVersion":3})).unwrap();
        let Some(Response::Hello {
            protocol_version: 3,
            capabilities,
            platform,
            base_image_sha256,
            limits,
            ..
        }) = exchange(&connection, hello).await
        else {
            panic!("hello failed")
        };
        assert!(capabilities.contains(&"vm.start".to_string()));
        assert!(
            !capabilities
                .iter()
                .any(|c| c.starts_with("exec") || c.starts_with("fs."))
        );
        assert!(platform.is_some());
        assert_eq!(
            base_image_sha256.as_deref(),
            Some(served.runner.installation().image.sha256.as_str())
        );
        assert_eq!((limits.max_active_vms, limits.max_seed_bytes), (1, 65536));
        assert_eq!(
            code(exchange(&connection, encode(&request).unwrap()).await),
            "UNSUPPORTED"
        );
        connection.close(0u32.into(), b"done");
    }

    // An unauthorized peer is closed before any application byte.
    let rogue = bind_loopback(SecretKey::generate(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    assert!(
        call(&rogue, served.address.clone(), NODE, &query)
            .await
            .is_err()
    );
    rogue.close().await;

    assert_eq!(
        served.runner.status().unwrap().active_vms,
        0,
        "nothing was allocated"
    );
    assert!(
        std::fs::read_dir(fx.state.join("vms"))
            .unwrap()
            .next()
            .is_none()
    );
    served.close().await;
}

fn allocate_value() -> serde_json::Value {
    allocate("t1", VM, 1, 8)
}
