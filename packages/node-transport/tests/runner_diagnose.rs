//! `vm.diagnose` over the real Iroh wire with the fake QEMU: what it
//! reports at each stage, that it is scoped to the VM's own thread, that
//! hostile console bytes and secrets never leave the runner raw, and that
//! evidence a runner did not record is said to be missing.
mod support;

use std::{path::PathBuf, time::Duration};

use cube_node_transport::{
    Response,
    l2::{Fragmenter, FrameHello, L2_ALPN, send_hello},
    runner::VmState,
};
use iroh::Endpoint;
use serde_json::{Value, json};
use support::*;
use tokio::time::timeout;

fn diagnose(thread: &str, vm: &str) -> Value {
    json!({"method":"vm.diagnose","threadId":thread,"vmId":vm})
}

async fn diagnosis(served: &Served, thread: &str, vm: &str) -> Value {
    match served.rpc(diagnose(thread, vm)).await {
        Response::Diagnosis { diagnosis } => diagnosis,
        other => panic!("{other:?}"),
    }
}

fn vm_dir(fx: &Fixture) -> PathBuf {
    fx.state.join("vms").join("1")
}

fn events(diagnosis: &Value) -> Vec<String> {
    diagnosis["events"]["entries"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["event"].as_str().unwrap().to_owned())
        .collect()
}

/// No string anywhere in `value` carries a character a terminal acts on.
fn assert_printable(value: &Value) {
    match value {
        Value::String(text) => assert!(
            !text.chars().any(|c| (c.is_control() && c != '\n' && c != '\t')
                || matches!(c as u32, 0x200b..=0x200f | 0x2028..=0x202e | 0x2060..=0x2069 | 0xfeff)),
            "{text:?}"
        ),
        Value::Array(items) => items.iter().for_each(assert_printable),
        Value::Object(map) => map.iter().for_each(|(k, v)| {
            assert_printable(&Value::String(k.clone()));
            assert_printable(v);
        }),
        _ => {}
    }
}

#[tokio::test]
async fn diagnosis_reports_each_stage_and_is_scoped() {
    let fx = fixture();
    let served = serve(&fx).await;
    served.vm(allocate("t1", VM, 1, 8)).await;

    let before = diagnosis(&served, "t1", VM).await;
    assert_eq!(before["vm"]["state"], "allocated");
    assert_eq!(before["launch"]["source"], "none");
    assert_eq!(before["process"]["tracked"], false);
    assert_eq!(before["qmp"]["asked"], false);
    assert_eq!(before["frames"], Value::Null);
    assert_eq!(before["logs"]["console"]["present"], false);
    assert_eq!(before["disk"]["overlay"]["backingMatches"], true);
    assert_eq!(before["disk"]["overlay"]["backingPresent"], true);
    assert_eq!(before["runner"]["softwareVersion"], "0.8.3");
    assert_eq!(events(&before), ["allocated"]);

    served.vm(start("t1", VM, 2, &fx.gateway, TOKEN)).await;
    // A hostile guest console: terminal controls, a bidi override, invalid
    // UTF-8 and secrets.
    std::fs::OpenOptions::new()
        .append(true)
        .open(vm_dir(&fx).join("console.log"))
        .and_then(|mut file| {
            use std::io::Write;
            file.write_all(
                b"\x1b[2J\x1b]0;owned\x07\xe2\x80\xaeevil\xff\r\npassword=hunter2 ghp_0123456789abcdefABCD\n\
                  -----BEGIN OPENSSH PRIVATE KEY-----\nAAAAsecretkeymaterial\n-----END OPENSSH PRIVATE KEY-----\nlogin:\n",
            )
        })
        .unwrap();
    // A gateway connects and one frame crosses to the guest and back.
    let gateway = Endpoint::builder(iroh::endpoint::presets::Minimal)
        .secret_key(fx.gateway.clone())
        .alpns(vec![])
        .clear_ip_transports()
        .clear_relay_transports()
        .clear_address_lookup()
        .bind_addr("127.0.0.1:0".parse::<std::net::SocketAddr>().unwrap())
        .unwrap()
        .bind()
        .await
        .unwrap();
    let connection = gateway
        .connect(served.address.clone(), L2_ALPN)
        .await
        .unwrap();
    let hello = FrameHello {
        vm_id: VM.into(),
        thread_id: "t1".into(),
        frame_token: TOKEN.into(),
    };
    assert!(send_hello(&connection, &hello).await.unwrap().ok);
    let mut fragmenter = Fragmenter::default();
    timeout(Duration::from_secs(10), async {
        loop {
            for datagram in fragmenter.split(&[7u8; 64], connection.max_datagram_size().unwrap()) {
                connection.send_datagram(datagram).unwrap();
            }
            if timeout(Duration::from_millis(300), connection.read_datagram())
                .await
                .is_ok()
            {
                return;
            }
        }
    })
    .await
    .unwrap();

    let live = diagnosis(&served, "t1", VM).await;
    assert_printable(&live);
    assert_eq!(live["vm"]["state"], "running");
    assert_eq!(live["launch"]["source"], "recorded");
    let argv: Vec<&str> = live["launch"]["argv"]
        .as_array()
        .unwrap()
        .iter()
        .map(|arg| arg.as_str().unwrap())
        .collect();
    assert!(argv.contains(&"guest=0123456789abcdef"), "{argv:?}");
    assert!(
        argv.contains(&"file:$STATE/vms/1/console.log"),
        "state directory shown as $STATE: {argv:?}"
    );
    assert!(!live.to_string().contains(&*fx.state.to_string_lossy()));
    assert_eq!(live["process"]["tracked"], true);
    assert_eq!(live["process"]["exists"], true);
    assert_eq!(live["qmp"]["answered"], true);
    assert_eq!(
        live["qmp"]["answers"]["query-name"]["name"],
        "0123456789abcdef"
    );
    assert_eq!(live["frames"]["gatewayConnected"], true);
    assert!(live["frames"]["framesToGuest"].as_u64().unwrap() >= 1);
    assert!(live["frames"]["framesFromGuest"].as_u64().unwrap() >= 1);
    let console = live["logs"]["console"]["text"].as_str().unwrap();
    assert!(console.contains("fake qemu booting"), "{console}");
    assert!(
        console.contains("\\x1b[2J\\x1b]0;owned\\x07\\u{202e}evil\\xff\n"),
        "{console}"
    );
    for secret in ["hunter2", "0123456789abcdefABCD", "secretkeymaterial"] {
        assert!(!live.to_string().contains(secret), "{secret} leaked");
    }
    assert!(
        console.contains("[redacted private key]\nlogin:"),
        "{console}"
    );
    assert_eq!(live["logs"]["console"]["complete"], true);
    let seen = events(&live);
    for expected in [
        "allocated",
        "qemu started",
        "running",
        "gateway connected",
        "first frame from the guest",
    ] {
        assert!(seen.iter().any(|e| e == expected), "{expected} in {seen:?}");
    }

    // Another thread's request names this VM: refused, nothing disclosed.
    let Response::Error { code, message, .. } = served.rpc(diagnose("t2", VM)).await else {
        panic!()
    };
    assert_eq!(code, "CONFLICT");
    assert!(!message.contains("console"), "{message}");
    assert_eq!(served.code(diagnose("t1", VM2)).await, "NOT_FOUND");
    assert_eq!(
        served.code(diagnose("t1", "../../etc")).await,
        "INVALID_REQUEST"
    );

    // A long console is cut in the middle, and says how much is missing.
    std::fs::write(
        vm_dir(&fx).join("console.log"),
        "boot line\n".repeat(20_000),
    )
    .unwrap();
    let long = diagnosis(&served, "t1", VM).await;
    let excerpt = &long["logs"]["console"];
    assert_eq!(excerpt["complete"], false);
    assert_eq!(excerpt["bytes"], 200_000);
    assert_eq!(excerpt["omittedBytes"], 200_000 - 64 * 1024);
    assert!(
        excerpt["text"]
            .as_str()
            .unwrap()
            .contains(&format!("[... {} bytes omitted ...]", 200_000 - 64 * 1024))
    );

    served.vm(stop("t1", VM, 3)).await;
    served.wait_state("t1", VM, VmState::Stopped).await;
    let stopped = diagnosis(&served, "t1", VM).await;
    assert_eq!(stopped["process"]["tracked"], false);
    assert_eq!(stopped["qmp"]["asked"], false);
    let seen = events(&stopped);
    for expected in ["stop requested", "power-down", "qemu exited"] {
        assert!(seen.iter().any(|e| e == expected), "{expected} in {seen:?}");
    }

    // A VM an older runner started: no launch record and no event log.
    std::fs::remove_file(vm_dir(&fx).join("launch.json")).unwrap();
    std::fs::remove_file(vm_dir(&fx).join("events.log")).unwrap();
    let older = diagnosis(&served, "t1", VM).await;
    assert_eq!(older["launch"]["source"], "reconstructed");
    assert!(
        older["launch"]["argv"]
            .as_array()
            .unwrap()
            .contains(&json!("guest=0123456789abcdef"))
    );
    assert_eq!(older["events"], Value::Null, "missing, not empty");

    gateway.close().await;
    served.close().await;
}

#[tokio::test]
async fn a_restart_and_a_draining_runner_are_recorded() {
    let fx = fixture();
    let served = serve(&fx).await;
    served.vm(allocate("t1", VM, 1, 8)).await;
    served.vm(start("t1", VM, 1, &fx.gateway, TOKEN)).await;
    // cubed attaches the running machine again: a start while it is live.
    served.vm(start("t1", VM, 2, &fx.gateway, TOKEN2)).await;
    served.runner.shutdown(true).await;
    served.close().await;

    let served = serve(&fx).await;
    served.runner.drain();
    assert_eq!(
        served.code(start("t1", VM, 3, &fx.gateway, TOKEN)).await,
        "DRAINING"
    );
    let after = diagnosis(&served, "t1", VM).await;
    let seen = events(&after);
    for expected in [
        "start while live",
        "runner stopping",
        "qemu exited",
        "start refused",
    ] {
        assert!(seen.iter().any(|e| e == expected), "{expected} in {seen:?}");
    }
    assert!(
        after["runner"]["processStartedAt"].as_u64().unwrap()
            >= after["events"]["entries"][0]["at"].as_u64().unwrap()
    );
    served.close().await;
}
