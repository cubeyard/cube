//! Only disposable workspaces, node keys and child processes owned by the test.
use cube_node_transport::{
    DeliveryError, Limits, Request, Response, bind_loopback, call, encode,
    intent::Intent,
    read_frame,
    runner::{Binding, ExecSpec, Operation, Runner},
};
use iroh::{Endpoint, EndpointAddr, SecretKey};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::{Child, Command},
    time::{sleep, timeout},
};

const BIN: &str = env!("CARGO_BIN_EXE_cube-runner");
const BUDGET: Duration = Duration::from_secs(12);
// These cases fork from one test process. A sibling's child can transiently
// inherit another fixture's flock before exec closes CLOEXEC descriptors.
// Serialize fixtures, not the concurrent requests exercised inside each case.
static CASE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
struct Fixture {
    root: tempfile::TempDir,
    state: PathBuf,
    workspace: PathBuf,
    key_file: PathBuf,
    control_file: PathBuf,
    key: SecretKey,
    control: SecretKey,
}
fn key_file(path: &Path, key: &SecretKey) {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .unwrap();
    file.write_all(&key.to_bytes()).unwrap();
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let state = root.path().join("state");
        let workspace = root.path().join("workspace");
        fs::create_dir(&workspace).unwrap();
        let key = SecretKey::generate();
        let control = SecretKey::generate();
        let key_path = root.path().join("node.key");
        let control_path = root.path().join("control.key");
        key_file(&key_path, &key);
        key_file(&control_path, &control);
        Runner::initialize(
            &state,
            Binding {
                thread_id: "thread-test".into(),
                environment_id: 1,
                node_id: "node-test".into(),
            },
            key.public(),
            control.public(),
            &workspace,
        )
        .unwrap();
        Self {
            root,
            state,
            workspace,
            key_file: key_path,
            control_file: control_path,
            key,
            control,
        }
    }
    fn open(&self) -> Arc<Runner> {
        Runner::open(&self.state, self.key.public()).unwrap()
    }
    async fn client(&self) -> Endpoint {
        bind_loopback(self.control.clone(), "127.0.0.1:0".parse().unwrap())
            .await
            .unwrap()
    }
    async fn start(&self) -> (Child, EndpointAddr, String) {
        let mut child = Command::new(BIN)
            .args([
                "runner-serve",
                "--key",
                self.key_file.to_str().unwrap(),
                "--state",
                self.state.to_str().unwrap(),
                "--ready-file",
                self.root.path().join("ready.json").to_str().unwrap(),
            ])
            .env("CUBE_TEST_SHOULD_NOT_LEAK", "private-fixture-value")
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut ready = String::new();
        timeout(
            BUDGET,
            BufReader::new(child.stdout.take().unwrap()).read_line(&mut ready),
        )
        .await
        .unwrap()
        .unwrap();
        let ready: serde_json::Value = serde_json::from_str(&ready).expect("host ready");
        assert_eq!(ready["peerId"], self.key.public().to_string());
        let socket = ready["addresses"][0].as_str().unwrap().to_owned();
        (
            child,
            EndpointAddr::new(self.key.public()).with_ip_addr(socket.parse().unwrap()),
            socket,
        )
    }
}
fn spec(command: &str) -> ExecSpec {
    ExecSpec {
        command: command.into(),
        guest_cwd: ".".into(),
        timeout_ms: 3000,
        output_limit: 8192,
    }
}
fn start(id: &str, spec: ExecSpec) -> Request {
    Request::ExecStart {
        operation_id: id.into(),
        env: 1,
        spec,
    }
}
async fn request(client: &Endpoint, addr: &EndpointAddr, query: &Request) -> Response {
    call(client, addr.clone(), "node-test", query)
        .await
        .unwrap()
}
async fn get(client: &Endpoint, addr: &EndpointAddr, id: &str) -> Operation {
    match request(
        client,
        addr,
        &Request::OperationGet {
            env: 1,
            operation_id: id.into(),
        },
    )
    .await
    {
        Response::Operation {
            operation_id,
            operation,
        } => {
            assert_eq!(operation_id, id);
            operation
        }
        response => panic!("unexpected operation response: {response:?}"),
    }
}
async fn done(client: &Endpoint, addr: &EndpointAddr, id: &str) -> Operation {
    timeout(BUDGET, async {
        loop {
            let operation = get(client, addr, id).await;
            if !matches!(operation, Operation::Accepted | Operation::Running) {
                break operation;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}
async fn cli(args: &[&str]) -> std::process::Output {
    timeout(
        BUDGET,
        Command::new(BIN).args(args).kill_on_drop(true).output(),
    )
    .await
    .unwrap()
    .unwrap()
}

#[tokio::test]
async fn real_exec_dedup_capacity_binding_and_restart() {
    let _case = CASE.lock().await;
    let fixture = Fixture::new();
    let (mut daemon, address, _) = fixture.start().await;
    let client = fixture.client().await;
    let query = start(
        "op-once",
        spec(
            "printf once >> count; for i in {1..200}; do [ -f release ] && break; sleep 0.01; done; [ -f release ] || exit 99; printf '\\377hello'; printf err >&2; test -z \"${CUBE_TEST_SHOULD_NOT_LEAK-}\"; exit 7",
        ),
    );
    let (a, b) = tokio::join!(
        request(&client, &address, &query),
        request(&client, &address, &query)
    );
    assert!(matches!(a, Response::Accepted { .. }));
    assert!(matches!(b, Response::Accepted { .. }));
    assert!(
        matches!(request(&client, &address, &start("op-other", spec("touch must-not-exist"))).await, Response::Error { code, .. } if code == "CAPACITY_EXCEEDED")
    );
    assert_eq!(get(&client, &address, "op-other").await, Operation::Unknown);
    fs::write(fixture.workspace.join("release"), b"go").unwrap();
    let result = done(&client, &address, "op-once").await;
    match &result {
        Operation::Succeeded { result } => {
            assert_eq!(result.exit_code, Some(7));
            assert_eq!(result.termination, "exited");
            assert!(result.output.contains(&255));
            assert_eq!(result.output_bytes, 9);
            assert!(!result.truncated);
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(fs::read(fixture.workspace.join("count")).unwrap(), b"once");
    assert!(!fixture.workspace.join("must-not-exist").exists());
    unsafe { libc::kill(daemon.id().unwrap() as i32, libc::SIGUSR1) };
    timeout(BUDGET, async {
        loop {
            let value: serde_json::Value =
                serde_json::from_slice(&fs::read(fixture.root.path().join("ready.json")).unwrap())
                    .unwrap();
            if value["lifecycle"] == "draining" {
                break;
            }
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        matches!(request(&client, &address, &start("op-draining", spec("touch must-not-exist"))).await,
            Response::Error { code, .. } if code == "DRAINING")
    );
    assert!(matches!(
        request(&client, &address, &Request::Status).await,
        Response::Status { status, protocol_version: 1, minimum_protocol_version: 1, .. }
            if status.lifecycle == "draining" && !status.active
    ));
    unsafe { libc::kill(daemon.id().unwrap() as i32, libc::SIGUSR2) };
    timeout(BUDGET, async {
        while !fs::read_to_string(fixture.root.path().join("ready.json"))
            .unwrap()
            .contains("\"lifecycle\":\"ready\"")
        {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        matches!(request(&client, &address, &start("op-once", spec("echo changed"))).await, Response::Error { code, .. } if code == "CONFLICT")
    );
    assert!(
        matches!(request(&client, &address, &Request::ExecStart { operation_id: "wrong-env".into(), env: 2, spec: spec("touch wrong-env") }).await, Response::Error { code, .. } if code == "ENVIRONMENT_MISSING")
    );
    assert!(
        matches!(request(&client, &address, &Request::OperationGet { operation_id: "op-once".into(), env: 2 }).await, Response::Error { code, .. } if code == "ENVIRONMENT_MISSING")
    );
    assert!(
        matches!(request(&client, &address, &Request::Inspect { env: 1 }).await, Response::Environment { binding, .. } if binding.thread_id == "thread-test")
    );
    // A second process cannot own, recover or alter the active journal.
    let duplicate = cli(&[
        "runner-serve",
        "--key",
        fixture.key_file.to_str().unwrap(),
        "--state",
        fixture.state.to_str().unwrap(),
    ])
    .await;
    assert!(!duplicate.status.success());
    assert!(String::from_utf8_lossy(&duplicate.stderr).contains("another daemon"));
    daemon.kill().await.unwrap();
    daemon.wait().await.unwrap();
    let (mut daemon, address, _) = fixture.start().await;
    assert_eq!(get(&client, &address, "op-once").await, result);
    assert!(matches!(
        request(&client, &address, &query).await,
        Response::Accepted { .. }
    ));
    sleep(Duration::from_millis(80)).await;
    assert_eq!(fs::read(fixture.workspace.join("count")).unwrap(), b"once");
    daemon.kill().await.unwrap();
    daemon.wait().await.unwrap();
    client.close().await;
}

#[tokio::test]
async fn bounded_output_timeout_cwd_and_environment() {
    let _case = CASE.lock().await;
    let fixture = Fixture::new();
    fs::create_dir(fixture.workspace.join("sub")).unwrap();
    let (mut daemon, address, _) = fixture.start().await;
    let client = fixture.client().await;
    let mut command = spec(
        "printf '%s' \"${CUBE_TEST_SHOULD_NOT_LEAK-unset}\"; read ignored; pwd; printf abcdefghijklmnop",
    );
    command.guest_cwd = "sub".into();
    command.output_limit = 8;
    request(&client, &address, &start("op-output", command)).await;
    let Operation::Succeeded { result } = done(&client, &address, "op-output").await else {
        panic!()
    };
    assert!(result.output.starts_with(b"unset"));
    assert_eq!(result.output.len(), 8);
    assert!(result.output_bytes > 8 && result.truncated);
    assert_eq!(result.exit_code, Some(0));
    for (id, script) in [
        (
            "op-timeout",
            "(sleep 0.5; touch timeout-descendant-survived) & wait",
        ),
        ("op-closed-pipes", "exec 1>&- 2>&-; sleep 5"),
    ] {
        let mut command = spec(script);
        command.timeout_ms = 80;
        request(&client, &address, &start(id, command)).await;
        let Operation::Succeeded { result } = done(&client, &address, id).await else {
            panic!()
        };
        assert_eq!(result.termination, "timedOut");
        assert_eq!(result.exit_code, None);
    }
    sleep(Duration::from_millis(550)).await;
    assert!(
        !fixture
            .workspace
            .join("timeout-descendant-survived")
            .exists(),
        "timeout must kill ordinary descendants in the command process group"
    );
    let mut command = spec("head -c 1000000 /dev/zero");
    command.output_limit = 0;
    request(&client, &address, &start("op-drain", command)).await;
    let Operation::Succeeded { result } = done(&client, &address, "op-drain").await else {
        panic!()
    };
    assert!(result.output.is_empty() && result.truncated);
    assert_eq!(result.output_bytes, 1_000_000);
    symlink(fixture.root.path(), fixture.workspace.join("escape")).unwrap();
    for cwd in ["..", "/tmp", "escape", "missing"] {
        let mut command = spec("touch escaped");
        command.guest_cwd = cwd.into();
        assert!(
            matches!(request(&client, &address, &start("bad-cwd", command)).await, Response::Error { code, .. } if code == "INVALID_REQUEST")
        );
    }
    assert_eq!(get(&client, &address, "bad-cwd").await, Operation::Unknown);
    // Access errors must not be misreported as a physically missing environment.
    fs::set_permissions(&fixture.workspace, fs::Permissions::from_mode(0o000)).unwrap();
    assert!(
        matches!(request(&client, &address, &Request::Inspect { env: 1 }).await,
        Response::Error { code, completion_unknown: false, .. } if code == "IO_ERROR")
    );
    fs::set_permissions(&fixture.workspace, fs::Permissions::from_mode(0o700)).unwrap();
    // A deleted/replaced workspace is missing, not a freshly provisioned env.
    fs::rename(
        &fixture.workspace,
        fixture.root.path().join("old-workspace"),
    )
    .unwrap();
    fs::create_dir(&fixture.workspace).unwrap();
    assert!(
        matches!(request(&client, &address, &start("replacement", spec("touch wrong"))).await, Response::Error { code, .. } if code == "ENVIRONMENT_MISSING")
    );
    assert!(matches!(
        get(&client, &address, "op-output").await,
        Operation::Succeeded { .. }
    ));
    assert!(!fixture.workspace.join("wrong").exists());
    daemon.kill().await.unwrap();
    daemon.wait().await.unwrap();
    client.close().await;
}

#[tokio::test]
async fn crash_during_exec_is_unknown_and_never_replayed() {
    let _case = CASE.lock().await;
    let fixture = Fixture::new();
    let (mut daemon, address, _) = fixture.start().await;
    let client = fixture.client().await;
    let query = start(
        "op-crash",
        spec(
            "printf before >> count; for i in {1..200}; do [ -f release ] && break; sleep 0.01; done; [ -f release ] || exit 99; printf after >> count",
        ),
    );
    request(&client, &address, &query).await;
    timeout(BUDGET, async {
        while !fixture.workspace.join("count").exists() {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    daemon.kill().await.unwrap();
    daemon.wait().await.unwrap();
    let (mut daemon, address, _) = fixture.start().await;
    assert_eq!(
        get(&client, &address, "op-crash").await,
        Operation::Interrupted {
            completion_unknown: true
        }
    );
    // Descendants can survive a hard daemon crash: Interrupted must not claim
    // Cancelled or stopped. This test's own bounded command exits by itself.
    fs::write(fixture.workspace.join("release"), b"go").unwrap();
    timeout(BUDGET, async {
        while fs::read(fixture.workspace.join("count")).unwrap() != b"beforeafter" {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    request(&client, &address, &query).await;
    sleep(Duration::from_millis(100)).await;
    assert_eq!(
        fs::read(fixture.workspace.join("count")).unwrap(),
        b"beforeafter"
    );
    assert_eq!(
        get(&client, &address, "op-crash").await,
        Operation::Interrupted {
            completion_unknown: true
        }
    );
    daemon.kill().await.unwrap();
    daemon.wait().await.unwrap();
    client.close().await;
}

#[tokio::test]
async fn lost_accepted_response_does_not_cancel_work() {
    let _case = CASE.lock().await;
    let fixture = Fixture::new();
    let host = fixture.open();
    let server = bind_loopback(fixture.key.clone(), "127.0.0.1:0".parse().unwrap())
        .await
        .unwrap();
    let address = EndpointAddr::new(server.id()).with_ip_addr(server.bound_sockets()[0]);
    let client = fixture.client().await;
    let fault = tokio::spawn({
        let server = server.clone();
        let host = host.clone();
        async move {
            let connection = server.accept().await.unwrap().await.unwrap();
            assert_eq!(
                connection.remote_id().to_string(),
                host.installation().allowed_peer
            );
            let (mut send, mut recv) = connection.accept_bi().await.unwrap();
            assert!(matches!(
                read_frame::<Request>(&mut recv).await.unwrap(),
                Request::Hello {
                    protocol_version: 1
                }
            ));
            send.write_all(
                &encode(&Response::Hello {
                    node_id: "node-test".into(),
                    protocol_version: 1,
                    minimum_protocol_version: 1,
                    software_version: env!("CARGO_PKG_VERSION").into(),
                    binding: Some(host.installation().binding.clone()),
                    profiles: vec!["runner".into(), "host".into()],
                    capabilities: vec!["exec.start".into()],
                    limits: Limits {
                        max_frame_bytes: 65536,
                        request_timeout_ms: 5000,
                    },
                })
                .unwrap(),
            )
            .await
            .unwrap();
            send.finish().unwrap();
            let (_send, mut recv) = connection.accept_bi().await.unwrap();
            let Request::ExecStart {
                env,
                operation_id,
                spec,
            } = read_frame::<Request>(&mut recv).await.unwrap()
            else {
                panic!()
            };
            host.start(env, &operation_id, spec).unwrap();
            // Deliberate response loss at the transport boundary, not a production toggle.
            connection.close(1u32.into(), b"test lost accepted response");
        }
    });
    let query = start(
        "lost-response",
        spec("printf once >> count; sleep 0.1; printf finished"),
    );
    let error = call(&client, address, "node-test", &query)
        .await
        .unwrap_err();
    let error = error.downcast_ref::<DeliveryError>().unwrap();
    assert_eq!(error.code, "OUTCOME_UNKNOWN");
    assert!(error.completion_unknown);
    assert_eq!(error.operation_id.as_deref(), Some("lost-response"));
    timeout(BUDGET, fault).await.unwrap().unwrap();
    timeout(BUDGET, async {
        loop {
            if matches!(
                host.get(1, "lost-response").unwrap(),
                Operation::Succeeded { .. }
            ) {
                break;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(fs::read(fixture.workspace.join("count")).unwrap(), b"once");
    host.shutdown(false).await;
    client.close().await;
    server.close().await;
}

#[tokio::test]
async fn durable_cli_intent_cannot_be_submitted_twice() {
    let _case = CASE.lock().await;
    let fixture = Fixture::new();
    let intent_path = fixture.root.path().join("intent.json");
    let prepared = cli(&[
        "prepare-exec",
        "--key",
        fixture.control_file.to_str().unwrap(),
        "--intent",
        intent_path.to_str().unwrap(),
        "--peer",
        &fixture.key.public().to_string(),
        "--expect-node",
        "node-test",
        "--env",
        "1",
        "--command",
        "printf once >> count; printf ok",
    ])
    .await;
    assert!(prepared.status.success(), "{prepared:?}");
    let intent = Intent::load(&intent_path).unwrap();
    assert!(
        Intent::prepare(
            &intent_path,
            "node-test".into(),
            1,
            fixture.key.public(),
            fixture.control.public(),
            spec("echo replaced")
        )
        .is_err()
    );
    let (mut daemon, _, address) = fixture.start().await;
    let args = |command| {
        vec![
            command,
            "--key",
            fixture.control_file.to_str().unwrap(),
            "--intent",
            intent_path.to_str().unwrap(),
            "--address",
            &address,
        ]
    };
    let submit_args = args("submit");
    let (a, b) = tokio::join!(cli(&submit_args), cli(&submit_args));
    assert_ne!(
        a.status.success(),
        b.status.success(),
        "one submission only: {a:?} {b:?}"
    );
    assert!(!cli(&args("submit")).await.status.success());
    let result = timeout(BUDGET, async {
        loop {
            let result = cli(&args("operation")).await;
            assert!(result.status.success());
            let Response::Operation { operation, .. } =
                serde_json::from_slice(&result.stdout).unwrap()
            else {
                panic!()
            };
            if matches!(operation, Operation::Succeeded { .. }) {
                break operation;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(matches!(result, Operation::Succeeded { .. }));
    assert_eq!(
        Intent::load(&intent_path).unwrap().operation_id,
        intent.operation_id
    );
    assert!(fs::metadata(intent_path.with_file_name("intent.json.sent")).is_ok());
    assert_eq!(fs::read(fixture.workspace.join("count")).unwrap(), b"once");
    daemon.kill().await.unwrap();
    daemon.wait().await.unwrap();
}

#[tokio::test]
async fn journal_immutability_no_identity_replacement_and_accepted_cutpoint() {
    let _case = CASE.lock().await;
    let fixture = Fixture::new();
    let host = fixture.open();
    assert!(Runner::open(&fixture.state, fixture.key.public()).is_err());
    let installation = host.installation().clone();
    drop(host);
    assert!(Runner::open(&fixture.state, SecretKey::generate().public()).is_err());
    assert!(
        Runner::initialize(
            &fixture.state,
            installation.binding.clone(),
            fixture.key.public(),
            fixture.control.public(),
            &fixture.workspace
        )
        .is_err()
    );
    let db = rusqlite::Connection::open(fixture.state.join("journal.db")).unwrap();
    assert!(
        db.execute("UPDATE installation SET document='{}'", [])
            .is_err()
    );
    assert!(db.execute("DELETE FROM installation", []).is_err());
    assert!(
        db.execute("INSERT OR REPLACE INTO installation VALUES(1, '{}')", [])
            .is_err()
    );
    // Simulate the durable commit-before-spawn crash cutpoint without adding a
    // production failure switch. Boot must not interpret Accepted as a queue.
    let command = spec("touch must-not-run");
    let request = serde_json::to_string(&("exec.start", &installation.binding, &command)).unwrap();
    use sha2::{Digest, Sha256};
    let hash = Sha256::digest(request.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    db.execute(
        "INSERT INTO operation VALUES(?1,?2,?3,?4)",
        rusqlite::params![
            "accepted-cutpoint",
            request,
            hash,
            serde_json::to_string(&Operation::Accepted).unwrap()
        ],
    )
    .unwrap();
    assert!(db.execute("DELETE FROM operation", []).is_err());
    assert!(
        db.execute(
            "INSERT OR REPLACE INTO operation VALUES('accepted-cutpoint', '{}', 'bad', '{}')",
            []
        )
        .is_err()
    );
    assert!(db.execute("UPDATE operation SET request='{}'", []).is_err());
    // Fill the retained journal to its documented limit; no expiry or queue.
    db.execute_batch("BEGIN").unwrap();
    for index in 1..10_000 {
        db.execute(
            "INSERT INTO operation VALUES(?1,'{}','fixture',?2)",
            rusqlite::params![
                format!("retained-{index}"),
                serde_json::to_string(&Operation::Interrupted {
                    completion_unknown: true
                })
                .unwrap()
            ],
        )
        .unwrap();
    }
    db.execute_batch("COMMIT").unwrap();
    drop(db);
    let host = fixture.open();
    assert!(
        host.start(1, "capacity-rejected", spec("touch must-not-run"))
            .unwrap_err()
            .to_string()
            .contains("CAPACITY_EXCEEDED")
    );
    assert_eq!(
        host.get(1, "capacity-rejected").unwrap(),
        Operation::Unknown
    );
    assert_eq!(
        host.get(1, "accepted-cutpoint").unwrap(),
        Operation::Interrupted {
            completion_unknown: true
        }
    );
    host.start(1, "accepted-cutpoint", command).unwrap();
    sleep(Duration::from_millis(50)).await;
    assert!(!fixture.workspace.join("must-not-run").exists());
    drop(host);
    fs::remove_file(fixture.state.join("journal.db")).unwrap();
    assert!(Runner::open(&fixture.state, fixture.key.public()).is_err());
    assert!(!fixture.state.join("journal.db").exists());
}

#[tokio::test]
async fn drain_wait_cancel_and_restore_quarantine_are_explicit() {
    let _case = CASE.lock().await;

    let waiting = Fixture::new();
    let host = waiting.open();
    host.start(
        1,
        "op-wait",
        spec("while [ ! -f release ]; do sleep 0.01; done; printf completed"),
    )
    .unwrap();
    timeout(BUDGET, async {
        while !host.status().unwrap().active {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    host.drain();
    assert_eq!(host.status().unwrap().lifecycle, "draining");
    assert!(
        host.start(1, "op-refused", spec("touch must-not-run"))
            .unwrap_err()
            .to_string()
            .contains("DRAINING")
    );
    let shutdown = tokio::spawn({
        let host = Arc::clone(&host);
        async move { host.shutdown(false).await }
    });
    sleep(Duration::from_millis(40)).await;
    assert!(
        !shutdown.is_finished(),
        "wait policy must preserve active work"
    );
    fs::write(waiting.workspace.join("release"), b"go").unwrap();
    timeout(BUDGET, shutdown).await.unwrap().unwrap();
    assert!(matches!(
        host.get(1, "op-wait").unwrap(),
        Operation::Succeeded { .. }
    ));
    assert!(!waiting.workspace.join("must-not-run").exists());
    drop(host);

    let cancelling = Fixture::new();
    let host = cancelling.open();
    host.start(
        1,
        "op-cancel",
        spec("(sleep 2; touch survived-cancel) & wait"),
    )
    .unwrap();
    timeout(BUDGET, async {
        while !host.status().unwrap().active {
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    timeout(BUDGET, host.shutdown(true)).await.unwrap();
    assert_eq!(
        host.get(1, "op-cancel").unwrap(),
        Operation::Failed {
            error: "CANCELLED".into(),
            completion_unknown: false,
        }
    );
    sleep(Duration::from_millis(2100)).await;
    assert!(!cancelling.workspace.join("survived-cancel").exists());
    drop(host);

    let recovered = Fixture::new();
    fs::write(
        recovered.state.join("restore-quarantine"),
        b"operator review required\n",
    )
    .unwrap();
    let host = recovered.open();
    assert_eq!(host.status().unwrap().lifecycle, "recoveryRequired");
    assert!(host.resume().is_err());
    assert!(
        host.start(1, "op-quarantined", spec("touch must-not-run"))
            .unwrap_err()
            .to_string()
            .contains("DRAINING")
    );
    assert!(!recovered.workspace.join("must-not-run").exists());
}
