//! VM lifecycle over the real Iroh wire with a fake QEMU (tests/support):
//! it answers QMP, echoes frames and writes a console line. These tests are
//! unit-level; a real guest runs in scripts/smoke-runner-vm.ts.
mod support;

use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

use cube_node_transport::{
    Response,
    l2::{Fragmenter, FrameHello, FrameReady, L2_ALPN, Reassembler, send_hello},
    runner::VmState,
    seed,
};
use iroh::{Endpoint, EndpointAddr, SecretKey};
use serde_json::{Value, json};
use support::*;
use tokio::time::timeout;

fn vm_dir(fx: &Fixture, slot: u32) -> PathBuf {
    fx.state.join("vms").join(slot.to_string())
}

fn pid_of(fx: &Fixture, slot: u32) -> i32 {
    std::fs::read_to_string(vm_dir(fx, slot).join("fake.pid"))
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

fn alive(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

async fn status(served: &Served) -> Value {
    match served.rpc(json!({"method":"node.status"})).await {
        Response::Status { status, .. } => serde_json::to_value(status).unwrap(),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn lifecycle_is_idempotent_fenced_and_bounded() {
    let fx = fixture();
    let served = serve(&fx).await;
    let gw = &fx.gateway;

    let allocated = served.vm(allocate("t1", VM, 1, 8)).await;
    assert_eq!(allocated.state, VmState::Allocated);
    assert!(!allocated.interrupted);
    assert_eq!(
        served.vm(allocate("t1", VM, 1, 8)).await,
        allocated,
        "same request, same record"
    );
    let args = std::fs::read_to_string(vm_dir(&fx, 1).join("disk.qcow2.args")).unwrap();
    let sha = &served.runner.installation().image.sha256;
    assert!(
        args.contains(&format!("-F qcow2 -b ../../images/{sha}.qcow2")),
        "{args}"
    );
    assert!(args.trim_end().ends_with("8G"), "{args}");

    assert_eq!(served.code(allocate("t1", VM, 1, 9)).await, "CONFLICT");
    assert_eq!(served.code(allocate("t2", VM, 1, 8)).await, "CONFLICT");
    assert_eq!(served.code(allocate("t1", VM2, 1, 8)).await, "CONFLICT");
    assert_eq!(
        served.code(allocate("t2", VM2, 1, 8)).await,
        "CAPACITY_EXCEEDED"
    );
    assert_eq!(
        served.code(allocate("t3", VM2, 1, 2)).await,
        "INVALID_REQUEST",
        "below the base image"
    );
    assert_eq!(
        served.code(allocate("t3", VM2, 1, 65)).await,
        "INVALID_REQUEST",
        "above the limit"
    );
    assert_eq!(
        served.code(allocate("t3", "../etc", 1, 8)).await,
        "INVALID_REQUEST"
    );
    assert_eq!(served.code(inspect("t1", VM2)).await, "NOT_FOUND");

    let running = served.vm(start("t1", VM, 2, gw, TOKEN)).await;
    assert_eq!(running.state, VmState::Running);
    assert!(running.started_at.is_some() && running.seed_sha256.is_some());
    assert_eq!(
        served.vm(start("t1", VM, 2, gw, TOKEN)).await,
        running,
        "same start, same record"
    );
    // A newer cubed rebuilds its seed and may size VMs differently: a
    // running VM is re-authorized and keeps its first seed and sizes.
    let mut changed = start("t1", VM, 2, gw, TOKEN);
    changed["seed"]["userData"] = json!("#cloud-config\npackages: [git]\n");
    changed["vcpus"] = json!(3);
    changed["memoryMiB"] = json!(2048);
    assert_eq!(
        served.vm(changed).await,
        running,
        "seed and sizes are fixed for the vm's life"
    );
    let mut changed = start("t1", VM, 2, gw, TOKEN);
    changed["mac"] = json!("02:00:00:00:00:43");
    assert_eq!(
        served.code(changed).await,
        "CONFLICT",
        "the mac is fixed for the vm's life"
    );
    let mut changed = start("t1", VM, 2, gw, TOKEN);
    changed["vcpus"] = json!(5);
    assert_eq!(
        served.code(changed).await,
        "INVALID_REQUEST",
        "above maxVcpus"
    );
    let mut changed = start("t1", VM, 2, gw, TOKEN);
    changed["mac"] = json!("01:00:00:00:00:42");
    assert_eq!(
        served.code(changed).await,
        "INVALID_REQUEST",
        "multicast mac"
    );
    assert_eq!(served.code(stop("t1", VM, 1)).await, "LEASE_STALE");
    assert_eq!(
        served.code(release("t1", VM, 1, false)).await,
        "LEASE_STALE"
    );

    let Response::Vm { vm, console_tail } = served.rpc(inspect("t1", VM)).await else {
        panic!()
    };
    assert_eq!(vm.state, VmState::Running);
    assert!(console_tail.unwrap().contains("Cloud-init finished"));
    let image = std::fs::read(vm_dir(&fx, 1).join("seed.img")).unwrap();
    assert_eq!(seed::volume_label(&image).unwrap(), "CIDATA");
    assert_eq!(
        seed::read_file(&image, "meta-data").unwrap().unwrap(),
        format!("instance-id: {VM}\n")
    );
    let qemu_args = std::fs::read_to_string(vm_dir(&fx, 1).join("fake.args")).unwrap();
    assert!(qemu_args.contains("-name\nguest=0123456789abcdef"));
    assert!(qemu_args.contains("mac=02:00:00:00:00:42"));
    let st = status(&served).await;
    assert_eq!(
        (st["activeVms"].clone(), st["runningVms"].clone()),
        (json!(1), json!(1))
    );
    assert_eq!(st["lifecycle"], "ready");

    let pid = pid_of(&fx, 1);
    let stopping = served.vm(stop("t1", VM, 2)).await;
    assert!(matches!(
        stopping.state,
        VmState::Stopping | VmState::Stopped
    ));
    let stopped = served.wait_state("t1", VM, VmState::Stopped).await;
    assert!(
        !stopped.interrupted && stopped.error.is_none(),
        "{stopped:?}"
    );
    assert!(!alive(pid));
    assert_eq!(served.vm(stop("t1", VM, 2)).await.state, VmState::Stopped);

    // A stopped VM boots again from the same disk, seed and sizes, even
    // when the request carries another seed and other sizes.
    let seed_before = std::fs::read(vm_dir(&fx, 1).join("seed.img")).unwrap();
    let mut again = start("t1", VM, 3, gw, TOKEN2);
    again["seed"]["userData"] = json!("#cloud-config\npackages: [jq]\n");
    again["vcpus"] = json!(1);
    again["memoryMiB"] = json!(2048);
    let again = served.vm(again).await;
    assert_eq!(again.state, VmState::Running);
    assert_eq!(again.seed_sha256, running.seed_sha256);
    assert_ne!(pid_of(&fx, 1), pid);
    assert_eq!(
        std::fs::read(vm_dir(&fx, 1).join("seed.img")).unwrap(),
        seed_before
    );
    let qemu_args = std::fs::read_to_string(vm_dir(&fx, 1).join("fake.args")).unwrap();
    assert!(qemu_args.contains("-smp\n2\n-m\n1024\n"), "{qemu_args}");

    let releasing = served.vm(release("t1", VM, 3, false)).await;
    assert!(matches!(
        releasing.state,
        VmState::Releasing | VmState::Released
    ));
    let released = served.wait_state("t1", VM, VmState::Released).await;
    assert_eq!(released.disk_bytes, 0);
    assert!(
        !vm_dir(&fx, 1).exists(),
        "a clean release deletes the vm directory"
    );
    assert_eq!(served.vm(release("t1", VM, 3, false)).await, released);
    assert_eq!(
        served.code(start("t1", VM, 3, gw, TOKEN2)).await,
        "CONFLICT"
    );
    let again = served.vm(allocate("t1", VM, 3, 8)).await;
    assert_eq!(again.state, VmState::Released, "a vm id is never reused");
    assert!(!vm_dir(&fx, 1).exists());
    assert_eq!(status(&served).await["activeVms"], 0);

    // The slot is free again.
    assert_eq!(
        served.vm(allocate("t2", VM2, 1, 8)).await.state,
        VmState::Allocated
    );
    assert!(vm_dir(&fx, 2).join("disk.qcow2").exists());
    served.runner.shutdown(true).await;
    served.close().await;
}

#[tokio::test]
async fn release_keeps_evidence() {
    let fx = fixture();
    let served = serve(&fx).await;
    served.vm(allocate("t1", VM, 1, 8)).await;
    served.vm(start("t1", VM, 1, &fx.gateway, TOKEN)).await;
    served.vm(release("t1", VM, 1, true)).await;
    let retained = served.wait_state("t1", VM, VmState::Retained).await;
    assert!(retained.disk_bytes > 0);
    assert!(vm_dir(&fx, 1).join("disk.qcow2").exists());
    let st = status(&served).await;
    assert_eq!(
        (st["activeVms"].clone(), st["retainedVms"].clone()),
        (json!(0), json!(1))
    );
    assert!(st["retainedBytes"].as_u64().unwrap() > 0);

    // A VM stopped by force is interrupted and kept even when released clean.
    served.vm(allocate("t2", VM2, 1, 8)).await;
    served.vm(start("t2", VM2, 1, &fx.gateway, TOKEN)).await;
    served.runner.shutdown(false).await;
    let stopped = served.vm(inspect("t2", VM2)).await;
    assert_eq!(
        (stopped.state, stopped.interrupted),
        (VmState::Stopped, true)
    );
    assert_eq!(status(&served).await["lifecycle"], "draining");
    assert_eq!(
        served.code(start("t2", VM2, 1, &fx.gateway, TOKEN)).await,
        "DRAINING"
    );
    served.vm(release("t2", VM2, 1, false)).await;
    let kept = served.wait_state("t2", VM2, VmState::Retained).await;
    assert!(kept.interrupted);
    assert!(vm_dir(&fx, 2).exists());
    assert_eq!(status(&served).await["retainedVms"], 2);

    // The operator discards retained evidence; a live VM cannot be discarded.
    let discarded = served.vm(discard("t1", VM, 1)).await;
    assert_eq!(discarded.state, VmState::Released);
    assert!(!vm_dir(&fx, 1).exists());
    assert_eq!(
        served.vm(discard("t1", VM, 1)).await.state,
        VmState::Released,
        "repeatable"
    );
    assert_eq!(status(&served).await["retainedVms"], 1);
    served.close().await;
}

fn discard(thread: &str, vm: &str, epoch: u64) -> serde_json::Value {
    json!({"method": "vm.discard", "threadId": thread, "vmId": vm, "epoch": epoch})
}

#[tokio::test]
async fn failures_are_recorded_not_hidden() {
    let fx = fixture();
    let served = serve(&fx).await;
    std::fs::write(fx.bin.join("fail-create"), b"").unwrap();
    let Response::Error { code, message, .. } = served.rpc(allocate("t1", VM, 1, 8)).await else {
        panic!()
    };
    assert_eq!(code, "IO_ERROR");
    assert!(message.contains("no space left"), "{message}");
    std::fs::remove_file(fx.bin.join("fail-create")).unwrap();
    assert_eq!(
        served.vm(allocate("t1", VM, 1, 8)).await.state,
        VmState::Allocated,
        "retry works"
    );

    std::fs::write(fx.bin.join("exit-at-once"), b"").unwrap();
    let failed = served.vm(start("t1", VM, 1, &fx.gateway, TOKEN)).await;
    let failed = if failed.state == VmState::Starting {
        served.wait_state("t1", VM, VmState::Stopped).await
    } else {
        failed
    };
    assert_eq!(failed.state, VmState::Stopped);
    let error = failed.error.unwrap();
    assert!(
        error.contains("qemu exited") && error.contains("refused to start"),
        "{error}"
    );
    std::fs::remove_file(fx.bin.join("exit-at-once")).unwrap();
    let restarted = served.vm(start("t1", VM, 1, &fx.gateway, TOKEN)).await;
    assert_eq!(restarted.state, VmState::Running, "{restarted:?}");
    served.runner.shutdown(true).await;
    served.close().await;
}

async fn gateway_endpoint(key: &SecretKey) -> Endpoint {
    Endpoint::builder(iroh::endpoint::presets::Minimal)
        .secret_key(key.clone())
        .alpns(vec![])
        .clear_ip_transports()
        .clear_relay_transports()
        .clear_address_lookup()
        .bind_addr("127.0.0.1:0".parse::<std::net::SocketAddr>().unwrap())
        .unwrap()
        .bind()
        .await
        .unwrap()
}

async fn frame_hello(
    endpoint: &Endpoint,
    address: &EndpointAddr,
    vm: &str,
    thread: &str,
    token: &str,
) -> (iroh::endpoint::Connection, anyhow::Result<FrameReady>) {
    let connection = endpoint.connect(address.clone(), L2_ALPN).await.unwrap();
    let ready = timeout(
        Duration::from_secs(10),
        send_hello(
            &connection,
            &FrameHello {
                vm_id: vm.into(),
                thread_id: thread.into(),
                frame_token: token.into(),
            },
        ),
    )
    .await
    .unwrap();
    (connection, ready)
}

#[tokio::test]
async fn frame_channel_is_authorized_by_the_latest_start() {
    let fx = fixture();
    let served = serve(&fx).await;
    served.vm(allocate("t1", VM, 1, 8)).await;
    served.vm(start("t1", VM, 1, &fx.gateway, TOKEN)).await;
    let gateway = gateway_endpoint(&fx.gateway).await;
    let rogue = gateway_endpoint(&SecretKey::generate()).await;

    let connection = rogue
        .connect(served.address.clone(), L2_ALPN)
        .await
        .unwrap();
    let closed = timeout(Duration::from_secs(5), connection.closed())
        .await
        .unwrap();
    assert!(closed.to_string().contains("UNAUTHORIZED"), "{closed}");

    for (vm, thread, token, reason) in [
        (VM, "t1", TOKEN2, "frame token does not match"),
        (VM2, "t1", TOKEN, "no running vm"),
        (VM, "t9", TOKEN, "no running vm"),
    ] {
        let (_, ready) = frame_hello(&gateway, &served.address, vm, thread, token).await;
        let ready = ready.unwrap();
        assert!(!ready.ok);
        assert!(ready.error.unwrap().contains(reason));
    }
    // The gateway's key is not a control peer.
    let control = gateway
        .connect(served.address.clone(), cube_node_transport::ALPN)
        .await;
    if let Ok(control) = control {
        let closed = timeout(Duration::from_secs(5), control.closed())
            .await
            .unwrap();
        assert!(closed.to_string().contains("UNAUTHORIZED"), "{closed}");
    }

    let (connection, ready) = frame_hello(&gateway, &served.address, VM, "t1", TOKEN).await;
    assert_eq!(ready.unwrap(), FrameReady::accepted());
    assert!(served.runner.pumps().has_connection(VM));
    // A full-size frame crosses the pump to the fake QEMU and back.
    let frame: Vec<u8> = (0..1514u32).map(|i| (i % 251) as u8).collect();
    let mut fragmenter = Fragmenter::default();
    let mut reassembler = Reassembler::default();
    let echoed = timeout(Duration::from_secs(10), async {
        loop {
            for datagram in fragmenter.split(&frame, connection.max_datagram_size().unwrap()) {
                connection.send_datagram(datagram).unwrap();
            }
            let received = timeout(Duration::from_millis(500), async {
                loop {
                    let datagram = connection.read_datagram().await.unwrap();
                    if let Some(frame) = reassembler.push(datagram) {
                        return frame;
                    }
                }
            })
            .await;
            if let Ok(frame) = received {
                return frame;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(&echoed[..], &frame[..]);

    // A newer start rotates the token: the old connection is dropped and the
    // old token no longer opens the channel.
    served.vm(start("t1", VM, 2, &fx.gateway, TOKEN2)).await;
    timeout(Duration::from_secs(5), connection.closed())
        .await
        .unwrap();
    let (_, ready) = frame_hello(&gateway, &served.address, VM, "t1", TOKEN).await;
    assert!(!ready.unwrap().ok);
    let (_, ready) = frame_hello(&gateway, &served.address, VM, "t1", TOKEN2).await;
    assert!(ready.unwrap().ok);

    // Stopping the VM closes the channel too.
    served.vm(stop("t1", VM, 2)).await;
    served.wait_state("t1", VM, VmState::Stopped).await;
    assert!(!served.runner.pumps().has_connection(VM));
    gateway.close().await;
    rogue.close().await;
    served.close().await;
}

#[tokio::test]
async fn restart_reconciles_a_vm_left_running() {
    let fx = fixture();
    let served = serve(&fx).await;
    served.vm(allocate("t1", VM, 1, 8)).await;
    served.vm(start("t1", VM, 1, &fx.gateway, TOKEN)).await;
    let pid = pid_of(&fx, 1);
    assert!(alive(pid));
    // The runner goes away without stopping its VM. On Linux PDEATHSIG of
    // the spawner thread kills QEMU; on macOS QEMU survives until the next
    // runner tells it to quit over QMP.
    let weak = Arc::downgrade(&served.runner);
    served.close().await;
    let deadline = Instant::now() + Duration::from_secs(10);
    while weak.upgrade().is_some() {
        assert!(Instant::now() < deadline, "runner still referenced");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let served = serve(&fx).await;
    let deadline = Instant::now() + Duration::from_secs(10);
    while alive(pid) {
        assert!(Instant::now() < deadline, "qemu {pid} survived the runner");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let record = served.vm(inspect("t1", VM)).await;
    assert_eq!((record.state, record.interrupted), (VmState::Stopped, true));
    let running = served.vm(start("t1", VM, 2, &fx.gateway, TOKEN2)).await;
    assert_eq!(running.state, VmState::Running);
    assert!(
        !running.interrupted,
        "a boot that reached running clears interrupted"
    );
    served.runner.shutdown(true).await;
    served.close().await;
}

#[tokio::test]
async fn journal_identity_and_restore_quarantine_are_explicit() {
    let fx = fixture();
    let runner = cube_node_transport::runner::Runner::open(&fx.state, fx.key.public()).unwrap();
    let error = cube_node_transport::runner::Runner::open(&fx.state, fx.key.public())
        .err()
        .unwrap();
    assert!(format!("{error:#}").contains("another daemon"), "{error:#}");
    let installation = runner.installation().clone();
    drop(runner);
    assert!(
        cube_node_transport::runner::Runner::open(&fx.state, SecretKey::generate().public())
            .is_err()
    );
    let image = fx.root.path().join("base.qcow2");
    assert!(
        cube_node_transport::runner::Runner::initialize(
            &fx.state,
            installation.binding.clone(),
            fx.key.public(),
            fx.control.public(),
            &image,
            Default::default(),
        )
        .is_err(),
        "never rebind existing state"
    );
    let db = rusqlite::Connection::open(fx.state.join("journal.db")).unwrap();
    assert!(
        db.execute("UPDATE installation SET document='{}'", [])
            .is_err()
    );
    assert!(db.execute("DELETE FROM installation", []).is_err());
    drop(db);

    // Restore quarantine: no new VM until the operator acknowledges.
    std::fs::write(fx.state.join("restore-quarantine"), b"").unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(
        fx.state.join("restore-quarantine"),
        std::fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let served = serve(&fx).await;
    let status = served.runner.status().unwrap();
    assert_eq!(status.lifecycle, "recoveryRequired");
    assert!(served.runner.resume().is_err());
    assert_eq!(served.code(allocate("t1", VM, 1, 8)).await, "DRAINING");
    served.close().await;
    cube_node_transport::runner::Runner::acknowledge_recovery(&fx.state, fx.key.public()).unwrap();
    assert!(!fx.state.join("restore-quarantine").exists());
    let served = serve(&fx).await;
    assert_eq!(served.runner.status().unwrap().lifecycle, "ready");
    served.close().await;

    // A changed base image refuses to serve.
    let base = fx
        .state
        .join("images")
        .join(format!("{}.qcow2", installation.image.sha256));
    std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut bytes = std::fs::read(&base).unwrap();
    bytes[100] ^= 1;
    std::fs::write(&base, bytes).unwrap();
    std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o400)).unwrap();
    let error = cube_node_transport::runner::Runner::open(&fx.state, fx.key.public())
        .err()
        .unwrap();
    assert!(format!("{error:#}").contains("sha256"), "{error:#}");
}

#[tokio::test]
async fn protocol_two_state_is_refused_with_a_clear_message() {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("state");
    std::fs::create_dir(&state).unwrap();
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    std::fs::set_permissions(&state, std::fs::Permissions::from_mode(0o700)).unwrap();
    for name in ["owner.lock", "journal.db"] {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(state.join(name))
            .unwrap();
    }
    let db = rusqlite::Connection::open(state.join("journal.db")).unwrap();
    db.execute_batch("CREATE TABLE operation(id TEXT); PRAGMA user_version=1;")
        .unwrap();
    drop(db);
    let error = cube_node_transport::runner::Runner::open(&state, SecretKey::generate().public())
        .err()
        .unwrap();
    assert!(format!("{error:#}").contains("protocol-2"), "{error:#}");
}

#[tokio::test]
async fn a_mutation_outliving_its_connection_still_completes() {
    // qemu-img takes longer than the control connection may live: the
    // caller times out, the allocation still finishes instead of being
    // cancelled half way and left `allocating`.
    let fx = fixture();
    std::fs::write(fx.bin.join("slow-create"), "7").unwrap();
    let served = serve(&fx).await;
    let request: cube_node_transport::Request =
        serde_json::from_value(allocate("t1", VM, 1, 8)).unwrap();
    let outcome =
        cube_node_transport::call(&served.client, served.address.clone(), NODE, &request).await;
    assert!(outcome.is_err(), "{outcome:?}");
    let allocated = served.wait_state("t1", VM, VmState::Allocated).await;
    assert!(vm_dir(&fx, 1).join("disk.qcow2").is_file());
    assert!(allocated.error.is_none(), "{allocated:?}");
    served.close().await;
}

#[tokio::test]
async fn concurrent_vms_are_isolated_and_bounded() {
    const VM3: &str = "00000000000000aa";
    const VM4: &str = "00000000000000bb";
    let fx = fixture();
    let served = serve(&fx).await;
    let gw = &fx.gateway;
    assert_eq!(
        status(&served).await["maxActiveVms"],
        1,
        "one until configured"
    );
    assert!(served.runner.set_max_active_vms(0).is_err());
    assert!(served.runner.set_max_active_vms(33).is_err());
    served.runner.set_max_active_vms(2).unwrap();
    assert_eq!(status(&served).await["maxActiveVms"], 2);

    // Two threads allocate at once; a third finds the runner full.
    let (one, two) = tokio::join!(
        served.vm(allocate("t1", VM, 1, 8)),
        served.vm(allocate("t2", VM2, 1, 8))
    );
    assert_eq!(
        (one.state, two.state),
        (VmState::Allocated, VmState::Allocated)
    );
    assert_eq!(
        served.code(allocate("t3", VM3, 1, 8)).await,
        "CAPACITY_EXCEEDED"
    );

    let mut second = start("t2", VM2, 1, gw, TOKEN2);
    second["mac"] = json!("02:00:00:00:00:43");
    let (one, two) = tokio::join!(served.vm(start("t1", VM, 1, gw, TOKEN)), served.vm(second));
    assert_eq!((one.state, two.state), (VmState::Running, VmState::Running));
    let st = status(&served).await;
    assert_eq!(
        (st["activeVms"].clone(), st["runningVms"].clone()),
        (json!(2), json!(2))
    );
    // Each VM has its own slot directory, disk, seed and QEMU.
    let (slot1, slot2) = (one_slot(&fx, VM), one_slot(&fx, VM2));
    assert_ne!(slot1, slot2);
    let (pid1, pid2) = (pid_of(&fx, slot1), pid_of(&fx, slot2));
    assert!(alive(pid1) && alive(pid2) && pid1 != pid2);
    // A VM is only reachable under its own thread, and its frame channel
    // only with its own token.
    assert_eq!(served.code(inspect("t1", VM2)).await, "CONFLICT");
    assert_eq!(served.code(stop("t1", VM2, 2)).await, "CONFLICT");
    let gateway = gateway_endpoint(gw).await;
    let (_, ready) = frame_hello(&gateway, &served.address, VM2, "t2", TOKEN).await;
    assert!(
        !ready.unwrap().ok,
        "one VM's token never opens another's channel"
    );
    let (_c1, ready) = frame_hello(&gateway, &served.address, VM, "t1", TOKEN).await;
    assert!(ready.unwrap().ok);
    let (_c2, ready) = frame_hello(&gateway, &served.address, VM2, "t2", TOKEN2).await;
    assert!(ready.unwrap().ok);
    assert!(served.runner.pumps().has_connection(VM) && served.runner.pumps().has_connection(VM2));

    // Stopping one leaves the other running.
    served.vm(stop("t1", VM, 2)).await;
    served.wait_state("t1", VM, VmState::Stopped).await;
    assert!(!alive(pid1) && alive(pid2));
    assert!(served.runner.pumps().has_connection(VM2));
    assert_eq!(
        served.code(allocate("t3", VM3, 1, 8)).await,
        "CAPACITY_EXCEEDED",
        "a stopped VM still holds its slot until release"
    );

    // Releasing frees exactly one slot; two racing allocations get one.
    served.vm(release("t1", VM, 3, false)).await;
    served.wait_state("t1", VM, VmState::Released).await;
    let (three, four) = tokio::join!(
        served.rpc(allocate("t3", VM3, 1, 8)),
        served.rpc(allocate("t4", VM4, 1, 8))
    );
    let won = [&three, &four]
        .iter()
        .filter(|response| matches!(response, Response::Vm { .. }))
        .count();
    let full = [&three, &four]
        .iter()
        .filter(|response| matches!(response, Response::Error { code, .. } if code == "CAPACITY_EXCEEDED"))
        .count();
    assert_eq!((won, full), (1, 1), "{three:?} {four:?}");
    assert_eq!(status(&served).await["activeVms"], 2);

    // Lowering the bound below the active VMs only refuses new ones.
    served.runner.set_max_active_vms(1).unwrap();
    assert!(alive(pid2));
    served.vm(release("t2", VM2, 2, false)).await;
    served.wait_state("t2", VM2, VmState::Released).await;
    let loser = if won == 1 && matches!(three, Response::Vm { .. }) {
        ("t4", VM4)
    } else {
        ("t3", VM3)
    };
    assert_eq!(
        served.code(allocate(loser.0, loser.1, 1, 8)).await,
        "CAPACITY_EXCEEDED"
    );
    gateway.close().await;
    served.runner.shutdown(false).await;
    served.close().await;
}

fn one_slot(fx: &Fixture, vm: &str) -> u32 {
    std::fs::read_dir(fx.state.join("vms"))
        .unwrap()
        .flatten()
        .find(|entry| {
            std::fs::read_to_string(entry.path().join("fake.args"))
                .is_ok_and(|args| args.contains(&format!("guest={vm}")))
        })
        .and_then(|entry| entry.file_name().to_str()?.parse().ok())
        .unwrap()
}

#[tokio::test]
async fn a_booting_vm_does_not_hold_up_other_vms() {
    let fx = fixture();
    let served = serve(&fx).await;
    served.runner.set_max_active_vms(2).unwrap();
    served.vm(allocate("t1", VM, 1, 8)).await;
    std::fs::write(fx.bin.join("slow-qmp"), b"").unwrap();
    // t1's QEMU takes 2 s to answer QMP; t2's allocation must not wait for it.
    let booting = served.vm(start("t1", VM, 1, &fx.gateway, TOKEN));
    let other = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let began = Instant::now();
        let record = served.vm(allocate("t2", VM2, 1, 8)).await;
        (record, began.elapsed())
    };
    let (started, (allocated, waited)) = tokio::join!(booting, other);
    std::fs::remove_file(fx.bin.join("slow-qmp")).unwrap();
    assert_eq!(started.state, VmState::Running);
    assert_eq!(allocated.state, VmState::Allocated);
    assert!(
        waited < Duration::from_millis(1500),
        "allocation waited {waited:?} behind another VM's boot"
    );
    served.runner.shutdown(false).await;
    served.close().await;
}
