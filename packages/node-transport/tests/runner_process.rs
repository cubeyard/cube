//! The real `cube-runner runner-serve` process with the fake QEMU. Its
//! preflight requires the platform accelerator, so this test runs only
//! where /dev/kvm (Linux) is usable and says so when it skips.
mod support;

use std::{
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};

use cube_node_transport::{
    Request, Response, bind_loopback, call,
    runner::{VmRecord, VmState},
};
use iroh::{EndpointAddr, EndpointId};
use serde_json::{Value, json};
use support::*;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::timeout,
};

const BIN: &str = env!("CARGO_BIN_EXE_cube-runner");

fn kvm_usable() -> bool {
    cfg!(target_os = "linux")
        && std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open("/dev/kvm")
            .is_ok()
}

fn write_key(path: &Path, key: &iroh::SecretKey) {
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    file.write_all(&key.to_bytes()).unwrap();
}

async fn spawn_runner(key: &Path, state: &Path) -> (Child, Value) {
    let mut child = Command::new(BIN)
        .args([
            "runner-serve",
            "--key",
            key.to_str().unwrap(),
            "--state",
            state.to_str().unwrap(),
        ])
        // Test state may live on a small tmpfs.
        .env("CUBE_RUNNER_MIN_FREE_DISK_GIB", "0")
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut line = String::new();
    timeout(
        Duration::from_secs(30),
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut line),
    )
    .await
    .unwrap()
    .unwrap();
    (child, serde_json::from_str(&line).expect("ready JSON"))
}

async fn rpc(client: &iroh::Endpoint, ready: &Value, value: Value) -> Response {
    let peer: EndpointId = ready["peerId"].as_str().unwrap().parse().unwrap();
    let address = EndpointAddr::new(peer)
        .with_ip_addr(ready["addresses"][0].as_str().unwrap().parse().unwrap());
    let request: Request = serde_json::from_value(value).unwrap();
    call(client, address, NODE, &request).await.unwrap()
}

async fn vm(client: &iroh::Endpoint, ready: &Value, value: Value) -> VmRecord {
    match rpc(client, ready, value.clone()).await {
        Response::Vm { vm, .. } => vm,
        other => panic!("{value} -> {other:?}"),
    }
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

#[tokio::test]
async fn runner_death_takes_qemu_down_and_restart_marks_it_interrupted() {
    if !kvm_usable() {
        eprintln!("SKIP: runner-serve preflight needs a usable /dev/kvm (Linux); not run here");
        return;
    }
    let fx = fixture();
    let key = fx.root.path().join("runner.key");
    write_key(&key, &fx.key);
    let client = bind_loopback(fx.control.clone(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();

    let (mut runner, ready) = spawn_runner(&key, &fx.state).await;
    assert_eq!(ready["lifecycle"], "ready");
    assert_eq!(ready["protocolVersion"], 3);
    assert!(ready["baseImageSha256"].is_string());
    vm(&client, &ready, allocate("t1", VM, 1, 8)).await;
    let running = vm(&client, &ready, start("t1", VM, 1, &fx.gateway, TOKEN)).await;
    assert_eq!(running.state, VmState::Running);
    let pid: i32 = std::fs::read_to_string(fx.state.join("vms/1/fake.pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    assert!(alive(pid));

    // SIGKILL: no shutdown code runs; PDEATHSIG takes QEMU down with it.
    runner.kill().await.unwrap();
    runner.wait().await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while alive(pid) {
        assert!(Instant::now() < deadline, "qemu {pid} outlived its runner");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    let (mut runner, ready) = spawn_runner(&key, &fx.state).await;
    let record = vm(&client, &ready, inspect("t1", VM)).await;
    assert_eq!((record.state, record.interrupted), (VmState::Stopped, true));
    let booted = vm(&client, &ready, start("t1", VM, 2, &fx.gateway, TOKEN2)).await;
    assert_eq!(booted.state, VmState::Running);
    assert!(fx.state.join("vms/1/disk.qcow2").exists(), "same disk");

    // SIGTERM drains: the guest gets an ACPI power-down and the runner exits.
    let pid: i32 = std::fs::read_to_string(fx.state.join("vms/1/fake.pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    unsafe {
        libc::kill(runner.id().unwrap() as i32, libc::SIGTERM);
    }
    let status = timeout(Duration::from_secs(40), runner.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success(), "{status}");
    assert!(!alive(pid));
    let (mut runner, ready) = spawn_runner(&key, &fx.state).await;
    let record = vm(&client, &ready, inspect("t1", VM)).await;
    assert_eq!(
        (record.state, record.interrupted),
        (VmState::Stopped, false)
    );
    let status = match rpc(&client, &ready, json!({"method":"node.status"})).await {
        Response::Status { status, .. } => status,
        other => panic!("{other:?}"),
    };
    assert_eq!((status.active_vms, status.running_vms), (1, 0));
    runner.kill().await.unwrap();
    client.close().await;
}
