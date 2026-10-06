//! Machine templates over the real Iroh wire with the fake QEMU: a cleanly
//! stopped VM's disk becomes a read-only template, VMs are allocated on it,
//! and it is deleted only once no VM's disk depends on it.
mod support;

use std::os::unix::fs::PermissionsExt;

use cube_node_transport::{
    Response,
    runner::{TemplateRecord, TemplateState, VmState},
};
use serde_json::{Value, json};
use support::*;

const VM3: &str = "00112233445566ff";
const KEY: &str = "abababababababababababababababababababababababababababababababab";
const META: &str = r#"{"format":1,"projectId":"p1","setupBlob":"none","commit":null}"#;

fn publish(thread: &str, vm: &str, epoch: u64, key: &str, meta: &str) -> Value {
    json!({"method":"vm.publish","threadId":thread,"vmId":vm,"epoch":epoch,"key":key,"meta":meta})
}
fn allocate_on(thread: &str, vm: &str, epoch: u64, disk: u32, template: &str) -> Value {
    let mut request = allocate(thread, vm, epoch, disk);
    request["template"] = json!(template);
    request
}

async fn template(served: &Served, request: Value) -> TemplateRecord {
    match served.rpc(request.clone()).await {
        Response::Template { template } => template,
        other => panic!("{request} -> {other:?}"),
    }
}
async fn templates(served: &Served) -> Vec<TemplateRecord> {
    match served.rpc(json!({"method":"template.list"})).await {
        Response::Templates { templates } => templates,
        other => panic!("{other:?}"),
    }
}

/// A build VM: allocated, started and powered off cleanly.
async fn built(served: &Served, fx: &Fixture, thread: &str, vm: &str) {
    served.vm(allocate(thread, vm, 1, 8)).await;
    served.vm(start(thread, vm, 1, &fx.gateway, TOKEN)).await;
    served.vm(stop(thread, vm, 1)).await;
    let stopped = served.wait_state(thread, vm, VmState::Stopped).await;
    assert!(!stopped.interrupted);
}

#[tokio::test]
async fn templates_are_published_shared_read_only_and_collected() {
    let fx = fixture();
    let served = serve(&fx).await;
    served.runner.set_max_active_vms(4).unwrap();

    // Only a cleanly stopped VM that booted from the base image qualifies.
    served.vm(allocate("t1", VM, 1, 8)).await;
    assert_eq!(
        served.code(publish("t1", VM, 1, KEY, META)).await,
        "CONFLICT",
        "never started"
    );
    served.vm(start("t1", VM, 1, &fx.gateway, TOKEN)).await;
    assert_eq!(
        served.code(publish("t1", VM, 1, KEY, META)).await,
        "CONFLICT",
        "running"
    );
    assert_eq!(
        served.code(publish("t1", VM, 1, "x", META)).await,
        "INVALID_REQUEST"
    );
    assert_eq!(
        served.code(publish("t1", VM, 1, KEY, "[]")).await,
        "INVALID_REQUEST"
    );
    served.vm(stop("t1", VM, 1)).await;
    served.wait_state("t1", VM, VmState::Stopped).await;
    assert_eq!(
        served.code(publish("t1", VM, 0, KEY, META)).await,
        "INVALID_REQUEST"
    );

    let published = template(&served, publish("t1", VM, 2, KEY, META)).await;
    assert_eq!(
        (
            published.id.as_str(),
            published.state,
            published.disk_gib,
            published.users
        ),
        (VM, TemplateState::Ready, 8, 0)
    );
    assert_eq!(published.meta, META);
    assert_eq!(
        template(&served, publish("t1", VM, 2, KEY, META)).await,
        published,
        "idempotent"
    );
    assert_eq!(
        served
            .code(publish("t1", VM, 2, &"c".repeat(64), META))
            .await,
        "CONFLICT",
        "a different key"
    );
    // The VM is released; its disk moved, read-only, next to the base image.
    assert_eq!(served.vm(inspect("t1", VM)).await.state, VmState::Released);
    assert!(!fx.state.join("vms/1").exists());
    let disk = fx.state.join("templates").join(VM).join("disk.qcow2");
    assert_eq!(
        std::fs::metadata(&disk).unwrap().permissions().mode() & 0o777,
        0o400
    );
    assert_eq!(templates(&served).await, vec![published.clone()]);

    // Two VMs on it, each with its own overlay backed by the template.
    let a = served.vm(allocate_on("t2", VM2, 1, 8, VM)).await;
    assert_eq!(a.template.as_deref(), Some(VM));
    assert_eq!(
        served.vm(allocate_on("t2", VM2, 1, 8, VM)).await,
        a,
        "same request, same record"
    );
    assert_eq!(
        served.code(allocate("t2", VM2, 1, 8)).await,
        "CONFLICT",
        "the template is fixed"
    );
    let args = std::fs::read_to_string(fx.state.join("vms/2/disk.qcow2.args")).unwrap();
    assert!(
        args.contains(&format!("-F qcow2 -b ../../templates/{VM}/disk.qcow2")),
        "{args}"
    );
    served.vm(allocate_on("t3", VM3, 1, 9, VM)).await;
    assert_eq!(
        served
            .code(allocate_on("t4", "0000000000000004", 1, 4, VM))
            .await,
        "INVALID_REQUEST",
        "smaller than the template"
    );
    assert_eq!(
        served
            .code(allocate_on(
                "t4",
                "0000000000000004",
                1,
                8,
                "0000000000000009"
            ))
            .await,
        "NOT_FOUND"
    );
    assert_eq!(templates(&served).await[0].users, 2);
    // A template-backed VM cannot become a template itself (no chains).
    served.vm(start("t3", VM3, 1, &fx.gateway, TOKEN2)).await;
    served.vm(stop("t3", VM3, 1)).await;
    served.wait_state("t3", VM3, VmState::Stopped).await;
    assert_eq!(
        served.code(publish("t3", VM3, 1, KEY, META)).await,
        "CONFLICT"
    );

    // Removal: no new VM, but the disk stays while VMs depend on it.
    let removing = template(&served, json!({"method":"template.remove","id":VM})).await;
    assert_eq!(
        (removing.state, removing.users),
        (TemplateState::Removing, 2)
    );
    assert_eq!(
        served
            .code(allocate_on("t4", "0000000000000004", 1, 8, VM))
            .await,
        "NOT_FOUND"
    );
    served.vm(release("t2", VM2, 1, false)).await;
    served.wait_state("t2", VM2, VmState::Released).await;
    assert!(disk.exists(), "t3 still depends on it");
    // A retained VM keeps it until the operator discards that VM.
    served.vm(release("t3", VM3, 1, true)).await;
    served.wait_state("t3", VM3, VmState::Retained).await;
    assert!(disk.exists(), "a retained disk still depends on it");
    served
        .vm(json!({"method":"vm.discard","threadId":"t3","vmId":VM3,"epoch":1}))
        .await;
    assert!(
        !fx.state.join("templates").join(VM).exists(),
        "collected with its last user"
    );
    assert!(templates(&served).await.is_empty());
    assert_eq!(
        served
            .code(json!({"method":"template.remove","id":VM}))
            .await,
        "NOT_FOUND"
    );
    served.close().await;
}

#[tokio::test]
async fn an_interrupted_vm_is_not_published_and_templates_survive_restarts() {
    let fx = fixture();
    let served = serve(&fx).await;
    served.runner.set_max_active_vms(4).unwrap();
    // Forced stop: interrupted, so its disk may be inconsistent.
    served.vm(allocate("t1", VM2, 1, 8)).await;
    served.vm(start("t1", VM2, 1, &fx.gateway, TOKEN)).await;
    served.runner.shutdown(false).await;
    assert!(served.vm(inspect("t1", VM2)).await.interrupted);
    assert_eq!(
        served.code(publish("t1", VM2, 1, KEY, META)).await,
        "CONFLICT"
    );
    served.runner.resume().unwrap();

    built(&served, &fx, "t2", VM).await;
    let published = template(&served, publish("t2", VM, 1, KEY, META)).await;
    served.vm(allocate_on("t3", VM3, 1, 8, VM)).await;
    served.close().await;

    // A restarted runner keeps the template, its user and the old journal rows.
    let served = serve(&fx).await;
    let listed = templates(&served).await;
    assert_eq!(listed.len(), 1);
    assert_eq!((listed[0].id.clone(), listed[0].users), (published.id, 1));
    assert_eq!(
        served.vm(inspect("t3", VM3)).await.template.as_deref(),
        Some(VM)
    );
    served.close().await;
}

#[tokio::test]
async fn a_publish_cut_off_by_a_crash_is_finished_or_undone_on_open() {
    let fx = fixture();
    let served = serve(&fx).await;
    served.runner.set_max_active_vms(4).unwrap();
    built(&served, &fx, "t1", VM).await;
    built(&served, &fx, "t2", VM2).await;
    assert_eq!(
        served.code(allocate_on("t3", VM3, 1, 8, VM3)).await,
        "INVALID_REQUEST",
        "a vm is not its own template"
    );
    served.close().await;

    // Both crashed while publishing; VM's disk had been moved, VM2's not.
    let db = rusqlite::Connection::open(fx.state.join("journal.db")).unwrap();
    for id in [VM, VM2] {
        db.execute(
            "INSERT INTO template(id,key,meta,state,disk_gib,created_at) VALUES(?1,?2,?3,'publishing',8,1)",
            [id, KEY, META],
        )
        .unwrap();
    }
    drop(db);
    let moved = fx.state.join("templates").join(VM);
    std::fs::create_dir_all(&moved).unwrap();
    for dir in [moved.parent().unwrap(), moved.as_path()] {
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    std::fs::rename(fx.state.join("vms/1/disk.qcow2"), moved.join("disk.qcow2")).unwrap();

    let served = serve(&fx).await;
    let listed = templates(&served).await;
    assert_eq!(listed.len(), 1);
    assert_eq!(
        (listed[0].id.as_str(), listed[0].state),
        (VM, TemplateState::Ready)
    );
    assert_eq!(served.vm(inspect("t1", VM)).await.state, VmState::Released);
    assert!(
        !fx.state.join("vms/1").exists(),
        "the released vm's directory went"
    );
    // Undone: VM2 is still a stopped vm with its disk, and can be published now.
    assert_eq!(served.vm(inspect("t2", VM2)).await.state, VmState::Stopped);
    assert!(!fx.state.join("templates").join(VM2).exists());
    let published = template(&served, publish("t2", VM2, 2, KEY, META)).await;
    assert_eq!(published.state, TemplateState::Ready);
    served.close().await;
}
