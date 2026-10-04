//! Shared fixture: a runner initialized with the fake QEMU and qemu-img in
//! this directory, served on Iroh loopback, and request builders.
#![allow(dead_code)]
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

use cube_node_transport::{
    Request, Response, bind_loopback, bind_runner, call,
    runner::{Binding, InitOptions, Runner, VmLimits, VmRecord, VmState},
    serve_runner,
};
use iroh::{Endpoint, EndpointAddr, SecretKey};
use serde_json::{Value, json};
use tokio::task::JoinHandle;

pub const NODE: &str = "node-test";
pub const VM: &str = "0123456789abcdef";
pub const VM2: &str = "fedcba9876543210";
pub const TOKEN: &str = "1111111111111111111111111111111111111111111111111111111111111111";
pub const TOKEN2: &str = "2222222222222222222222222222222222222222222222222222222222222222";

fn qcow2(virtual_size: u64) -> Vec<u8> {
    let mut bytes = vec![0u8; 4096];
    bytes[..4].copy_from_slice(b"QFI\xfb");
    bytes[4..8].copy_from_slice(&3u32.to_be_bytes());
    bytes[24..32].copy_from_slice(&virtual_size.to_be_bytes());
    bytes
}

pub struct Fixture {
    pub root: tempfile::TempDir,
    pub bin: PathBuf,
    pub state: PathBuf,
    pub key: SecretKey,
    pub control: SecretKey,
    pub gateway: SecretKey,
}

pub fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("bin");
    std::fs::create_dir(&bin).unwrap();
    let support = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support");
    std::fs::copy(support.join("fake-qemu.py"), bin.join("qemu-system-fake")).unwrap();
    std::fs::copy(support.join("fake-qemu-img.sh"), bin.join("qemu-img")).unwrap();
    let firmware = bin.join("firmware.fd");
    std::fs::write(&firmware, b"fake firmware").unwrap();
    let image = root.path().join("base.qcow2");
    std::fs::write(&image, qcow2(3 << 30)).unwrap();
    let state = root.path().join("state");
    let key = SecretKey::generate();
    let control = SecretKey::generate();
    Runner::initialize(
        &state,
        Binding {
            thread_id: "t-install".into(),
            environment_id: 1,
            node_id: NODE.into(),
        },
        key.public(),
        control.public(),
        &image,
        InitOptions {
            qemu: Some(bin.join("qemu-system-fake")),
            firmware: Some(firmware),
            limits: VmLimits::default(),
        },
    )
    .unwrap();
    Fixture {
        root,
        bin,
        state,
        key,
        control,
        gateway: SecretKey::generate(),
    }
}

pub struct Served {
    pub runner: Arc<Runner>,
    pub server: Endpoint,
    pub client: Endpoint,
    pub address: EndpointAddr,
    pub task: JoinHandle<()>,
}

pub async fn serve(fx: &Fixture) -> Served {
    let runner = Runner::open(&fx.state, fx.key.public()).unwrap();
    let server = bind_runner(
        fx.key.clone(),
        "127.0.0.1:0".parse().unwrap(),
        cube_node_transport::NetworkMode::Loopback,
    )
    .await
    .unwrap();
    let address = EndpointAddr::new(server.id()).with_ip_addr(server.bound_sockets()[0]);
    let task = tokio::spawn({
        let (runner, server, peer) = (runner.clone(), server.clone(), fx.control.public());
        async move {
            serve_runner(&server, peer, NODE, Some(runner))
                .await
                .unwrap()
        }
    });
    let client = bind_loopback(fx.control.clone(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    Served {
        runner,
        server,
        client,
        address,
        task,
    }
}

impl Served {
    pub async fn rpc(&self, value: Value) -> Response {
        let request: Request = serde_json::from_value(value).unwrap();
        call(&self.client, self.address.clone(), NODE, &request)
            .await
            .unwrap()
    }
    pub async fn vm(&self, value: Value) -> VmRecord {
        match self.rpc(value.clone()).await {
            Response::Vm { vm, .. } => vm,
            other => panic!("{value} -> {other:?}"),
        }
    }
    pub async fn code(&self, value: Value) -> String {
        match self.rpc(value.clone()).await {
            Response::Error { code, .. } => code,
            other => panic!("{value} expected an error, got {other:?}"),
        }
    }
    pub async fn wait_state(&self, thread: &str, vm: &str, state: VmState) -> VmRecord {
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let record = self.vm(inspect(thread, vm)).await;
            if record.state == state {
                return record;
            }
            assert!(
                Instant::now() < deadline,
                "{vm} stuck in {:?}",
                record.state
            );
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    pub async fn close(self) {
        self.task.abort();
        let _ = self.task.await;
        self.client.close().await;
        self.server.close().await;
    }
}

pub fn allocate(thread: &str, vm: &str, epoch: u64, disk: u32) -> Value {
    json!({"method":"vm.allocate","threadId":thread,"vmId":vm,"epoch":epoch,"diskGiB":disk})
}
pub fn start(thread: &str, vm: &str, epoch: u64, gateway: &SecretKey, token: &str) -> Value {
    json!({"method":"vm.start","threadId":thread,"vmId":vm,"epoch":epoch,
        "vcpus":2,"memoryMiB":1024,"mac":"02:00:00:00:00:42",
        "seed":{"metaData":format!("instance-id: {vm}\n"),"userData":"#cloud-config\n",
                "networkConfig":"version: 2\n"},
        "gateway":{"peer":gateway.public().to_string(),"frameToken":token}})
}
pub fn stop(thread: &str, vm: &str, epoch: u64) -> Value {
    json!({"method":"vm.stop","threadId":thread,"vmId":vm,"epoch":epoch})
}
pub fn inspect(thread: &str, vm: &str) -> Value {
    json!({"method":"vm.inspect","threadId":thread,"vmId":vm})
}
pub fn release(thread: &str, vm: &str, epoch: u64, retain: bool) -> Value {
    json!({"method":"vm.release","threadId":thread,"vmId":vm,"epoch":epoch,"retain":retain})
}
