//! Only disposable workspaces, node keys and child processes owned by the test.
use cube_node_transport::{
    DeliveryError, Limits, Request, Response, bind_loopback, call, encode,
    intent::Intent,
    read_frame,
    runner::RepositorySource,
    runner::{Binding, ExecSpec, Operation, Runner, WorkspaceAllocation, WorkspaceRepository},
};
use iroh::{Endpoint, EndpointAddr, SecretKey};
use rusqlite::Connection;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::{Command as StdCommand, Stdio},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
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

fn project_repo(root: &Path, name: &str, contents: &str) -> (PathBuf, String) {
    let repository = root.join(name);
    fs::create_dir(&repository).unwrap();
    let git = |args: &[&str]| {
        let output = StdCommand::new("git")
            .args([
                "-c",
                "user.name=Cube Test",
                "-c",
                "user.email=cube@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "-C",
            ])
            .arg(&repository)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    };
    git(&["init", "-q", "-b", "main"]);
    fs::write(repository.join("project-marker"), contents).unwrap();
    git(&["add", "project-marker"]);
    git(&["commit", "-qm", "base"]);
    let oid = git(&["rev-parse", "HEAD"]);
    (repository, oid)
}

fn allocation(project_id: &str, repository: &Path, oid: &str) -> WorkspaceAllocation {
    WorkspaceAllocation {
        project_id: project_id.into(),
        project_revision: 1,
        repositories: vec![WorkspaceRepository {
            url: repository.to_string_lossy().into_owned(),
            base: "main".into(),
            base_oid: oid.into(),
            checkout_name: "workspace".into(),
        }],
    }
}
fn start(id: &str, spec: ExecSpec) -> Request {
    Request::ExecStart {
        operation_id: id.into(),
        env: 1,
        thread_id: None,
        epoch: None,
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
            cursor: None,
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
async fn thread_worktrees_are_distinct_reusable_and_dirty_safe_across_restart() {
    let _case = CASE.lock().await;
    let fixture = Fixture::new();
    let git = |args: &[&str]| {
        let status = StdCommand::new("git")
            .args([
                "-c",
                "user.name=Cube Test",
                "-c",
                "user.email=cube@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "-C",
            ])
            .arg(&fixture.workspace)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    };
    git(&["init", "-q"]);
    fs::write(fixture.workspace.join("tracked"), b"template").unwrap();
    git(&["add", "tracked"]);
    git(&["commit", "-qm", "template"]);

    let remote = fixture.root.path().join("remote.git");
    git(&["clone", "--bare", ".", remote.to_str().unwrap()]);
    git(&["remote", "add", "origin", remote.to_str().unwrap()]);

    let runner = fixture.open();
    let first = runner.allocate("thread-one", None).unwrap();
    assert_eq!(first.kind, "git");
    assert!(
        matches!(runner.allocate("thread-two", None), Err(error) if error.to_string() == "CAPACITY_EXCEEDED")
    );
    runner
        .start_in_workspace(
            1,
            Some("thread-one"),
            "workspace-one",
            spec("printf one > unique"),
        )
        .unwrap();
    timeout(BUDGET, async {
        loop {
            if matches!(
                runner.get(1, "workspace-one").unwrap(),
                Operation::Succeeded { .. }
            ) {
                break;
            }
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let first_path = fixture.state.join("workspaces/thread-one");
    assert_eq!(fs::read(first_path.join("unique")).unwrap(), b"one");
    let released = runner.release("thread-one").unwrap();
    assert!(released.retained, "dirty worktree must be retained");
    drop(runner);

    let runner = fixture.open();
    let second = runner.allocate("thread-two", None).unwrap();
    assert_eq!(second.kind, "git");
    let second_path = fixture.state.join("workspaces/thread-two");
    assert_ne!(first_path, second_path);
    assert!(
        !second_path.join("unique").exists(),
        "threads must not share workspace contents"
    );
    drop(runner);
    fs::write(second_path.join("recovery-marker"), b"keep").unwrap();
    let db = Connection::open(fixture.state.join("journal.db")).unwrap();
    db.execute(
        "UPDATE workspace SET state='releasing' WHERE thread_id='thread-two'",
        [],
    )
    .unwrap();
    drop(db);
    let runner = fixture.open();
    assert!(
        runner.release("thread-two").unwrap().retained,
        "interrupted release must retain user work"
    );
    assert!(second_path.join("recovery-marker").exists());
    runner.allocate("thread-three", None).unwrap();
    assert!(
        !runner.release("thread-three").unwrap().retained,
        "clean worktree should be removed"
    );
    runner.allocate("thread-four", None).unwrap();
    let fourth_path = fixture.state.join("workspaces/thread-four");
    fs::write(fourth_path.join("committed"), b"keep committed work").unwrap();
    let commit = StdCommand::new("git")
        .args([
            "-c",
            "user.name=Cube Test",
            "-c",
            "user.email=cube@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-C",
        ])
        .arg(&fourth_path)
        .args(["add", "committed"])
        .status()
        .unwrap();
    assert!(commit.success());
    let commit = StdCommand::new("git")
        .args([
            "-c",
            "user.name=Cube Test",
            "-c",
            "user.email=cube@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-C",
        ])
        .arg(&fourth_path)
        .args(["commit", "-qm", "thread work"])
        .status()
        .unwrap();
    assert!(commit.success());
    assert!(
        runner.release("thread-four").unwrap().retained,
        "a clean worktree with a thread-only commit must be retained"
    );
    assert_eq!(
        fs::read(fourth_path.join("committed")).unwrap(),
        b"keep committed work"
    );
    assert!(
        first_path.join("unique").exists(),
        "later releases must not delete retained user work"
    );
    assert!(
        matches!(runner.allocate("../escape", None), Err(error) if error.to_string() == "INVALID_REQUEST")
    );
}

#[tokio::test]
async fn one_runner_switches_projects_without_reusing_workspace_state() {
    let _case = CASE.lock().await;
    let fixture = Fixture::new();
    fs::write(fixture.workspace.join("legacy-template-marker"), b"legacy").unwrap();
    let (alpha, alpha_oid) = project_repo(fixture.root.path(), "alpha", "alpha");
    let (beta, beta_oid) = project_repo(fixture.root.path(), "beta", "beta");
    fs::write(alpha.join("project-marker"), b"newer alpha").unwrap();
    let update = StdCommand::new("git")
        .args([
            "-c",
            "user.name=Cube Test",
            "-c",
            "user.email=cube@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-C",
        ])
        .arg(&alpha)
        .args(["commit", "-qam", "advance branch after host snapshot"])
        .status()
        .unwrap();
    assert!(update.success());
    let runner = fixture.open();

    runner
        .allocate_with(
            "thread-alpha",
            &allocation("project-alpha", &alpha, &alpha_oid),
        )
        .unwrap();
    let alpha_workspace = fixture.state.join("workspaces/thread-alpha/workspace");
    assert_eq!(
        fs::read(alpha_workspace.join("project-marker")).unwrap(),
        b"alpha"
    );
    let checked_out = StdCommand::new("git")
        .arg("-C")
        .arg(&alpha_workspace)
        .args(["rev-parse", "HEAD"])
        .output()
        .unwrap();
    assert_eq!(
        String::from_utf8(checked_out.stdout).unwrap().trim(),
        alpha_oid,
        "runner must use the host-supplied immutable OID, not the branch's newer tip"
    );
    assert!(!runner.release("thread-alpha").unwrap().retained);

    let (rewritten, unavailable_oid) = project_repo(fixture.root.path(), "rewritten", "old");
    let rewrite = |args: &[&str]| {
        let status = StdCommand::new("git")
            .args([
                "-c",
                "user.name=Cube Test",
                "-c",
                "user.email=cube@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "-C",
            ])
            .arg(&rewritten)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success());
    };
    rewrite(&["checkout", "--orphan", "replacement"]);
    rewrite(&["rm", "-f", "project-marker"]);
    fs::write(rewritten.join("project-marker"), b"replacement").unwrap();
    rewrite(&["add", "project-marker"]);
    rewrite(&["commit", "-qm", "replacement"]);
    rewrite(&["branch", "-M", "main"]);
    let unavailable = runner
        .allocate_with(
            "thread-unavailable",
            &allocation("project-rewritten", &rewritten, &unavailable_oid),
        )
        .unwrap_err()
        .to_string();
    assert_eq!(
        unavailable, "IO_ERROR",
        "a force-pushed-away OID must fail closed"
    );
    assert!(
        fixture.state.join("workspaces/thread-unavailable").exists(),
        "partial allocation evidence must be retained for inspection"
    );

    runner
        .allocate_with("thread-beta", &allocation("project-beta", &beta, &beta_oid))
        .unwrap();
    let beta_workspace = fixture.state.join("workspaces/thread-beta/workspace");
    assert_eq!(
        fs::read(beta_workspace.join("project-marker")).unwrap(),
        b"beta"
    );
    assert!(!beta_workspace.join("alpha-only").exists());
    fs::write(beta_workspace.join("dirty"), b"retained evidence").unwrap();
    assert!(runner.release("thread-beta").unwrap().retained);
    assert_eq!(
        fs::read(beta_workspace.join("dirty")).unwrap(),
        b"retained evidence"
    );

    runner
        .allocate_with(
            "thread-empty",
            &WorkspaceAllocation {
                project_id: "project-empty".into(),
                project_revision: 1,
                repositories: Vec::new(),
            },
        )
        .unwrap();
    let empty_workspace = fixture.state.join("workspaces/thread-empty/workspace");
    assert!(empty_workspace.is_dir());
    assert!(
        !empty_workspace.join("legacy-template-marker").exists(),
        "global empty projects must not reuse the installation template"
    );
}

#[tokio::test]
async fn git_allocation_fetches_remote_tip_without_touching_dirty_template() {
    let _case = CASE.lock().await;
    let fixture = Fixture::new();
    let run = |cwd: &Path, args: &[&str]| -> String {
        let output = StdCommand::new("git")
            .args([
                "-c",
                "user.name=Cube Test",
                "-c",
                "user.email=cube@example.invalid",
                "-c",
                "commit.gpgsign=false",
                "-C",
            ])
            .arg(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    };
    run(
        &fixture.workspace,
        &["init", "-q", "--initial-branch=develop"],
    );
    fs::write(fixture.workspace.join("tracked"), b"old remote\n").unwrap();
    run(&fixture.workspace, &["add", "tracked"]);
    run(&fixture.workspace, &["commit", "-qm", "old"]);
    let old_oid = run(&fixture.workspace, &["rev-parse", "HEAD"]);
    let remote = fixture.root.path().join("remote.git");
    run(
        &fixture.workspace,
        &["clone", "--bare", ".", remote.to_str().unwrap()],
    );
    run(
        &fixture.workspace,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );

    let publisher = fixture.root.path().join("publisher");
    run(
        fixture.root.path(),
        &[
            "clone",
            remote.to_str().unwrap(),
            publisher.to_str().unwrap(),
        ],
    );
    fs::write(publisher.join("tracked"), b"fresh remote\n").unwrap();
    run(&publisher, &["add", "tracked"]);
    run(&publisher, &["commit", "-qm", "fresh"]);
    run(&publisher, &["push", "origin", "develop"]);
    let fresh_oid = run(&publisher, &["rev-parse", "HEAD"]);

    fs::write(fixture.workspace.join("tracked"), b"dirty template\n").unwrap();
    fs::write(fixture.workspace.join("staged"), b"staged\n").unwrap();
    run(&fixture.workspace, &["add", "staged"]);
    fs::write(fixture.workspace.join("untracked"), b"untracked\n").unwrap();
    let status_before = run(&fixture.workspace, &["status", "--porcelain=v1"]);
    let head_before = run(&fixture.workspace, &["rev-parse", "HEAD"]);

    let runner = fixture.open();
    let first = runner.allocate("thread-fresh", None).unwrap();
    assert_eq!(first.base_ref.as_deref(), Some("refs/heads/develop"));
    assert_eq!(first.base_oid.as_deref(), Some(fresh_oid.as_str()));
    let first_path = fixture.state.join("workspaces/thread-fresh");
    assert_eq!(
        fs::read(first_path.join("tracked")).unwrap(),
        b"fresh remote\n"
    );
    assert_eq!(run(&first_path, &["rev-parse", "HEAD"]), fresh_oid);
    assert_eq!(
        run(&first_path, &["rev-parse", "--abbrev-ref", "HEAD"]),
        "HEAD"
    );
    assert_eq!(
        run(&fixture.workspace, &["status", "--porcelain=v1"]),
        status_before
    );
    assert_eq!(run(&fixture.workspace, &["rev-parse", "HEAD"]), head_before);
    assert_eq!(
        fs::read(fixture.workspace.join("tracked")).unwrap(),
        b"dirty template\n"
    );
    drop(runner);
    let runner = fixture.open();
    let recovered = runner.allocate("thread-fresh", None).unwrap();
    assert_eq!(
        recovered.base_oid, first.base_oid,
        "restart must recover the pinned base"
    );
    assert!(!runner.release("thread-fresh").unwrap().retained);

    run(&publisher, &["reset", "--hard", &old_oid]);
    fs::write(publisher.join("tracked"), b"force pushed\n").unwrap();
    run(&publisher, &["add", "tracked"]);
    run(&publisher, &["commit", "-qm", "rewritten"]);
    run(&publisher, &["push", "--force", "origin", "develop"]);
    let rewritten_oid = run(&publisher, &["rev-parse", "HEAD"]);
    let configured = RepositorySource {
        url: remote.to_string_lossy().into_owned(),
        branch: "develop".into(),
    };
    let second = runner
        .allocate("thread-rewritten", Some(&configured))
        .unwrap();
    assert_eq!(second.base_oid.as_deref(), Some(rewritten_oid.as_str()));
    assert_eq!(
        fs::read(fixture.state.join("workspaces/thread-rewritten/tracked")).unwrap(),
        b"force pushed\n"
    );
    assert!(!runner.release("thread-rewritten").unwrap().retained);

    fs::rename(&remote, fixture.root.path().join("remote-offline.git")).unwrap();
    let offline = runner
        .allocate("thread-offline", Some(&configured))
        .unwrap_err()
        .to_string();
    assert!(
        offline.contains("no stale local fallback was used"),
        "{offline}"
    );
    assert!(!fixture.state.join("workspaces/thread-offline").exists());
    drop(runner);
    let db = Connection::open(fixture.state.join("journal.db")).unwrap();
    let journaled: (String, String, Option<String>) = db
        .query_row(
            "SELECT remote,ref_name,oid FROM workspace_base WHERE thread_id='thread-offline'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(journaled.0, configured.url);
    assert_eq!(journaled.1, "refs/heads/develop");
    assert_eq!(
        journaled.2, None,
        "a failed fetch must not invent a base OID"
    );
    drop(db);
    let restarted = fixture.open();
    assert_eq!(
        restarted
            .allocate("thread-offline", Some(&configured))
            .unwrap_err()
            .to_string(),
        offline,
        "restart must retain the actionable allocation failure"
    );
    fs::rename(fixture.root.path().join("remote-offline.git"), &remote).unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let attempts: Vec<_> = ["thread-concurrent-a", "thread-concurrent-b"]
        .into_iter()
        .map(|thread_id| {
            let runner = restarted.clone();
            let repository = configured.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                (thread_id, runner.allocate(thread_id, Some(&repository)))
            })
        })
        .collect();
    barrier.wait();
    let results: Vec<_> = attempts
        .into_iter()
        .map(|attempt| attempt.join().unwrap())
        .collect();
    let allocated: Vec<_> = results
        .iter()
        .filter_map(|(thread_id, result)| result.as_ref().ok().map(|_| *thread_id))
        .collect();
    assert_eq!(allocated.len(), 1, "only one concurrent allocation may win");
    assert!(results.iter().any(|(_, result)| {
        result
            .as_ref()
            .is_err_and(|error| error.to_string() == "CAPACITY_EXCEEDED")
    }));
    restarted.release(allocated[0]).unwrap();
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
        Response::Status { status, protocol_version: 2, minimum_protocol_version: 2, .. }
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
        matches!(request(&client, &address, &Request::ExecStart { operation_id: "wrong-env".into(), env: 2, thread_id: None, epoch: None, spec: spec("touch wrong-env") }).await, Response::Error { code, .. } if code == "ENVIRONMENT_MISSING")
    );
    assert!(
        matches!(request(&client, &address, &Request::OperationGet { operation_id: "op-once".into(), env: 2, cursor: None }).await, Response::Error { code, .. } if code == "ENVIRONMENT_MISSING")
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
                    protocol_version: 2
                }
            ));
            send.write_all(
                &encode(&Response::Hello {
                    node_id: "node-test".into(),
                    protocol_version: 2,
                    minimum_protocol_version: 2,
                    software_version: env!("CARGO_PKG_VERSION").into(),
                    binding: Some(host.installation().binding.clone()),
                    profiles: vec!["runner".into(), "host".into()],
                    capabilities: vec!["exec.start".into()],
                    limits: Limits::current(),
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
                ..
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
    for index in 1..cube_node_transport::runner::MAX_RECORDS {
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

#[tokio::test]
async fn direct_aliases_are_foreground_and_second_interrupt_cancels() {
    let _case = CASE.lock().await;
    let fixture = Fixture::new();
    let mut child = Command::new(BIN)
        .args([
            "runner-serve",
            "--key",
            fixture.key_file.to_str().unwrap(),
            "--state",
            fixture.state.to_str().unwrap(),
            "--ready-file",
            fixture.root.path().join("ready.json").to_str().unwrap(),
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
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
    let ready: serde_json::Value = serde_json::from_str(&ready).unwrap();
    let address = EndpointAddr::new(fixture.key.public())
        .with_ip_addr(ready["addresses"][0].as_str().unwrap().parse().unwrap());
    let client = fixture.client().await;
    assert!(matches!(
        request(
            &client,
            &address,
            &start("op-two-stage", spec("sleep 10; touch must-not-survive")),
        )
        .await,
        Response::Accepted { .. }
    ));
    timeout(BUDGET, async {
        loop {
            if matches!(
                get(&client, &address, "op-two-stage").await,
                Operation::Running
            ) {
                break;
            }
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    unsafe { libc::kill(child.id().unwrap() as i32, libc::SIGINT) };
    timeout(BUDGET, async {
        loop {
            if fs::read_to_string(fixture.root.path().join("ready.json"))
                .unwrap_or_default()
                .contains("\"lifecycle\":\"draining\"")
            {
                break;
            }
            sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        child.try_wait().unwrap().is_none(),
        "first Ctrl-C waits for active work"
    );
    unsafe { libc::kill(child.id().unwrap() as i32, libc::SIGINT) };
    let status = timeout(BUDGET, child.wait()).await;
    let timed_out = status.is_err();
    if timed_out {
        child.kill().await.unwrap();
        child.wait().await.unwrap();
    }
    let mut diagnostics = String::new();
    child
        .stderr
        .take()
        .unwrap()
        .read_to_string(&mut diagnostics)
        .await
        .unwrap();
    assert!(!timed_out, "{diagnostics}");
    assert!(status.unwrap().unwrap().success(), "{diagnostics}");
    assert!(diagnostics.contains("runner_stopping"), "{diagnostics}");
    assert!(
        diagnostics.contains("runner_cancelling_active"),
        "{diagnostics}"
    );
    drop(client);
    let runner = fixture.open();
    assert_eq!(
        runner.get(1, "op-two-stage").unwrap(),
        Operation::Failed {
            error: "CANCELLED".into(),
            completion_unknown: false,
        }
    );
    assert!(!fixture.workspace.join("must-not-survive").exists());
    drop(runner);

    let root = tempfile::tempdir().unwrap();
    let home = root.path().join("home");
    let workspace = root.path().join("workspace");
    fs::create_dir(&workspace).unwrap();
    let control = SecretKey::generate();
    let initialized = cli(&[
        "init",
        "--home",
        home.to_str().unwrap(),
        "--workspace",
        workspace.to_str().unwrap(),
        "--allow-peer",
        &control.public().to_string(),
        "--node-id",
        "node-direct",
        "--thread-id",
        "thread-direct",
        "--env",
        "7",
    ])
    .await;
    assert!(
        initialized.status.success(),
        "{}",
        String::from_utf8_lossy(&initialized.stderr)
    );
    assert!(String::from_utf8_lossy(&initialized.stdout).contains("next: cube-runner run"));
    assert_eq!(
        fs::metadata(&home).unwrap().permissions().mode() & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(home.join("runner.key"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    let mut foreground = Command::new(BIN)
        .args(["run", "--home", home.to_str().unwrap()])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let stderr = foreground.stderr.take().unwrap();
    let mut lines = BufReader::new(stderr).lines();
    let mut startup = String::new();
    timeout(BUDGET, async {
        while let Some(line) = lines.next_line().await.unwrap() {
            startup.push_str(&line);
            startup.push('\n');
            if line.contains("network ready / waiting for cubed") {
                break;
            }
        }
    })
    .await
    .unwrap();
    assert!(startup.contains("cube-runner"));
    let mut stdout = foreground.stdout.take().unwrap();
    assert!(
        timeout(Duration::from_millis(50), stdout.read_u8())
            .await
            .is_err(),
        "human run reserves stdout for future machine output"
    );
    unsafe { libc::kill(foreground.id().unwrap() as i32, libc::SIGINT) };
    assert!(
        timeout(BUDGET, foreground.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}

#[tokio::test]
async fn restored_workspace_requires_explicit_identity_preserving_recovery() {
    let _case = CASE.lock().await;
    let fixture = Fixture::new();
    let original = {
        let runner = fixture.open();
        runner.installation().clone()
    };

    fs::rename(
        &fixture.workspace,
        fixture.root.path().join("workspace-before-restore"),
    )
    .unwrap();
    fs::create_dir(&fixture.workspace).unwrap();

    let replaced = fixture.open();
    assert!(
        replaced.inspect(1).is_err(),
        "ordinary replacement stays rejected"
    );
    drop(replaced);
    assert!(
        Runner::acknowledge_recovery(&fixture.state, fixture.key.public(), &fixture.workspace)
            .is_err(),
        "physical identity cannot change outside restore quarantine"
    );

    let marker = fixture.state.join("restore-quarantine");
    fs::write(&marker, b"operator review required\n").unwrap();
    fs::set_permissions(&marker, fs::Permissions::from_mode(0o600)).unwrap();
    assert!(
        Runner::acknowledge_recovery(
            &fixture.state,
            SecretKey::generate().public(),
            &fixture.workspace,
        )
        .is_err(),
        "the restored private identity must match"
    );
    assert!(marker.exists(), "failed recovery remains quarantined");

    let other = fixture.root.path().join("other-workspace");
    fs::create_dir(&other).unwrap();
    assert!(
        Runner::acknowledge_recovery(&fixture.state, fixture.key.public(), &other).is_err(),
        "recovery cannot change the canonical workspace path"
    );
    assert!(marker.exists(), "failed recovery remains quarantined");

    let owner = fixture.open();
    assert!(
        Runner::acknowledge_recovery(&fixture.state, fixture.key.public(), &fixture.workspace)
            .is_err(),
        "recovery requires exclusive journal ownership"
    );
    drop(owner);

    Runner::acknowledge_recovery(&fixture.state, fixture.key.public(), &fixture.workspace).unwrap();
    assert!(!marker.exists());
    let recovered = fixture.open();
    recovered.inspect(1).unwrap();
    let installation = recovered.installation();
    assert_eq!(installation.binding, original.binding);
    assert_eq!(installation.peer_id, original.peer_id);
    assert_eq!(installation.allowed_peer, original.allowed_peer);
    assert_eq!(installation.workspace, original.workspace);
    assert_ne!(installation.workspace_inode, original.workspace_inode);
    drop(recovered);
    let db = rusqlite::Connection::open(fixture.state.join("journal.db")).unwrap();
    assert!(
        db.execute("UPDATE installation SET document=document WHERE id=1", [])
            .is_err(),
        "recovery must restore the immutable installation trigger"
    );
}

fn code(error: anyhow::Error) -> String {
    error.to_string()
}

async fn finished(host: &Arc<Runner>, id: &str) -> Operation {
    timeout(BUDGET, async {
        loop {
            let operation = host.get(1, id).unwrap();
            if !matches!(operation, Operation::Accepted | Operation::Running) {
                break operation;
            }
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap()
}

#[tokio::test]
async fn protocol_two_pages_output_and_moves_files_over_the_wire() {
    let _case = CASE.lock().await;
    let fixture = Fixture::new();
    let (mut daemon, address, _) = fixture.start().await;
    let client = fixture.client().await;
    let mut long = spec("head -c 200000 /dev/zero | tr '\\0' a; printf end");
    long.output_limit = cube_node_transport::runner::MAX_OUTPUT;
    long.timeout_ms = cube_node_transport::runner::MAX_TIMEOUT_MS;
    assert!(matches!(
        request(&client, &address, &start("op-long", long)).await,
        Response::Accepted { .. }
    ));
    done(&client, &address, "op-long").await;
    let mut output = Vec::new();
    loop {
        let Response::Operation {
            operation: Operation::Succeeded { result },
            ..
        } = request(
            &client,
            &address,
            &Request::OperationGet {
                env: 1,
                operation_id: "op-long".into(),
                cursor: Some(output.len() as u64),
            },
        )
        .await
        else {
            panic!("expected a result page")
        };
        assert_eq!(result.output_offset, Some(output.len() as u64));
        assert_eq!(result.retained_bytes, Some(200_003));
        assert!(result.output.len() <= cube_node_transport::runner::OUTPUT_PAGE_BYTES);
        assert!(!result.truncated);
        output.extend_from_slice(&result.output);
        if output.len() as u64 == result.retained_bytes.unwrap() {
            break;
        }
    }
    assert!(output.ends_with(b"aend"));
    assert!(matches!(
        request(&client, &address, &Request::OperationGet { env: 1, operation_id: "op-long".into(), cursor: Some(200_004) }).await,
        Response::Error { code, .. } if code == "INVALID_REQUEST"
    ));

    let binary: Vec<u8> = (0..=255).collect();
    let write = Request::FsWrite {
        env: 1,
        thread_id: None,
        epoch: Some(1),
        idempotency_key: "write-binary".into(),
        path: "nested/dir/blob.bin".into(),
        content: binary.clone(),
        expected_sha: None,
        create_parents: true,
    };
    let Response::Written { result, .. } = request(&client, &address, &write).await else {
        panic!("expected write")
    };
    assert_eq!(result.size, 256);
    assert_eq!(
        fs::read(fixture.workspace.join("nested/dir/blob.bin")).unwrap(),
        binary
    );
    assert!(matches!(
        request(&client, &address, &write).await,
        Response::Written { result: again, .. } if again == result
    ));
    let Response::File { file, .. } = request(
        &client,
        &address,
        &Request::FsRead {
            env: 1,
            thread_id: None,
            path: "nested/dir/blob.bin".into(),
            offset: Some(250),
            limit: Some(100),
        },
    )
    .await
    else {
        panic!("expected file")
    };
    assert_eq!(file.content, (250..=255).collect::<Vec<u8>>());
    assert!(file.eof);
    assert_eq!(file.size, 256);
    assert_eq!(file.sha256.as_deref(), Some(result.sha256.as_str()));
    assert!(matches!(
        request(&client, &address, &Request::FsStat { env: 1, thread_id: None, path: "nested".into() }).await,
        Response::Stat { stat, .. } if stat.kind == "directory" && stat.sha256.is_none()
    ));
    assert!(matches!(
        request(&client, &address, &Request::FsWrite { env: 1, thread_id: None, epoch: None, idempotency_key: "write-unfenced".into(), path: "unfenced".into(), content: vec![1], expected_sha: None, create_parents: false }).await,
        Response::Error { code, .. } if code == "LEASE_STALE"
    ));
    daemon.kill().await.unwrap();
    daemon.wait().await.unwrap();
    client.close().await;
}

#[tokio::test]
async fn exec_cancel_kills_the_process_group_and_respects_the_fence() {
    let _case = CASE.lock().await;
    let fixture = Fixture::new();
    let host = fixture.open();
    let mut command = spec("sleep 30 & printf %s $! > child.pid; wait");
    command.timeout_ms = 60_000;
    host.start_fenced(1, None, "op-cancel", Some(3), command)
        .unwrap();
    timeout(BUDGET, async {
        while fs::read_to_string(fixture.workspace.join("child.pid"))
            .map_or(true, |pid| pid.is_empty())
        {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(code(host.cancel(1, None, "op-cancel", Some(2)).unwrap_err()).contains("LEASE_STALE"));
    assert!(matches!(
        host.get(1, "op-cancel").unwrap(),
        Operation::Running
    ));
    host.cancel(1, None, "op-cancel", Some(3)).unwrap();
    assert_eq!(
        finished(&host, "op-cancel").await,
        Operation::Failed {
            error: "CANCELLED".into(),
            completion_unknown: false
        }
    );
    let pid: i32 = fs::read_to_string(fixture.workspace.join("child.pid"))
        .unwrap()
        .parse()
        .unwrap();
    timeout(BUDGET, async {
        // The background child was in the cancelled process group.
        while unsafe { libc::kill(pid, 0) } == 0 {
            sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    // Cancelling a finished or unknown operation is an inspection, not an error.
    assert!(matches!(
        host.cancel(1, None, "op-cancel", Some(3)).unwrap(),
        Operation::Failed { .. }
    ));
    assert_eq!(
        host.cancel(1, None, "op-never", Some(3)).unwrap(),
        Operation::Unknown
    );
    // The same identity is never re-run after cancellation.
    host.start_fenced(1, None, "op-cancel", Some(3), {
        let mut command = spec("sleep 30 & printf %s $! > child.pid; wait");
        command.timeout_ms = 60_000;
        command
    })
    .unwrap();
    assert!(matches!(
        host.get(1, "op-cancel").unwrap(),
        Operation::Failed { .. }
    ));
}

#[tokio::test]
async fn lease_epochs_fence_mutations_durably() {
    let _case = CASE.lock().await;
    let fixture = Fixture::new();
    let host = fixture.open();
    host.start_fenced(1, None, "op-epoch-five", Some(5), spec("true"))
        .unwrap();
    finished(&host, "op-epoch-five").await;
    for epoch in [None, Some(4)] {
        assert!(
            code(
                host.start_fenced(1, None, "op-stale", epoch, spec("touch must-not-run"))
                    .unwrap_err()
            )
            .contains("LEASE_STALE")
        );
        assert!(
            code(
                host.write_file(1, None, epoch, "write-stale", "stale", b"x", None, false)
                    .unwrap_err()
            )
            .contains("LEASE_STALE")
        );
    }
    assert!(
        code(
            host.start_fenced(1, None, "op-invalid", Some(0), spec("true"))
                .unwrap_err()
        )
        .contains("INVALID_REQUEST")
    );
    // A stale holder cannot even replay its own retained identity.
    assert!(
        code(
            host.start_fenced(1, None, "op-epoch-five", Some(4), spec("true"))
                .unwrap_err()
        )
        .contains("LEASE_STALE")
    );
    host.write_file(1, None, Some(6), "write-six", "six", b"6", None, false)
        .unwrap();
    drop(host);
    let host = fixture.open();
    assert!(
        code(
            host.write_file(1, None, Some(5), "write-five", "five", b"5", None, false)
                .unwrap_err()
        )
        .contains("LEASE_STALE")
    );
    assert_eq!(host.get(1, "op-stale").unwrap(), Operation::Unknown);
    assert!(!fixture.workspace.join("must-not-run").exists());
    assert!(!fixture.workspace.join("stale").exists());
    let db = Connection::open(fixture.state.join("journal.db")).unwrap();
    assert!(db.execute("UPDATE lease_epoch SET epoch=1", []).is_err());
    assert!(db.execute("DELETE FROM lease_epoch", []).is_err());
}

#[tokio::test]
async fn file_operations_are_beneath_atomic_and_idempotent() {
    let _case = CASE.lock().await;
    let fixture = Fixture::new();
    let host = fixture.open();
    let write = |key: &str, path: &str, content: &[u8], expected: Option<&str>| {
        host.write_file(1, None, Some(1), key, path, content, expected, false)
    };
    let first = write("w-1", "a.txt", b"one\n", None).unwrap();
    assert_eq!(fs::read(fixture.workspace.join("a.txt")).unwrap(), b"one\n");
    // A repeated key returns the original result and never writes again.
    fs::write(fixture.workspace.join("a.txt"), b"changed elsewhere").unwrap();
    assert_eq!(write("w-1", "a.txt", b"one\n", None).unwrap(), first);
    assert_eq!(
        fs::read(fixture.workspace.join("a.txt")).unwrap(),
        b"changed elsewhere"
    );
    assert!(code(write("w-1", "a.txt", b"two\n", None).unwrap_err()).contains("CONFLICT"));
    assert!(code(write("w-1", "b.txt", b"one\n", None).unwrap_err()).contains("CONFLICT"));
    // expectedSha is the whole current file; a mismatch is retained too.
    assert!(
        code(write("w-2", "a.txt", b"two\n", Some(&first.sha256)).unwrap_err())
            .contains("PRECONDITION_FAILED")
    );
    fs::write(fixture.workspace.join("a.txt"), b"one\n").unwrap();
    assert!(
        code(write("w-2", "a.txt", b"two\n", Some(&first.sha256)).unwrap_err())
            .contains("PRECONDITION_FAILED")
    );
    let second = write("w-3", "a.txt", b"two\n", Some(&first.sha256)).unwrap();
    assert_eq!(fs::read(fixture.workspace.join("a.txt")).unwrap(), b"two\n");
    assert_eq!(
        host.get(1, "w-3").unwrap(),
        Operation::Written {
            result: second.clone()
        }
    );
    assert!(
        code(write("w-4", "missing.txt", b"x", Some(&second.sha256)).unwrap_err())
            .contains("PRECONDITION_FAILED")
    );
    fs::set_permissions(
        fixture.workspace.join("a.txt"),
        fs::Permissions::from_mode(0o750),
    )
    .unwrap();
    write("w-5", "a.txt", b"three\n", None).unwrap();
    assert_eq!(
        fs::metadata(fixture.workspace.join("a.txt"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o750,
        "replacement preserves the file mode"
    );
    // Keys share the operation namespace with commands.
    host.start_fenced(1, None, "shared-key", Some(1), spec("true"))
        .unwrap();
    finished(&host, "shared-key").await;
    assert!(code(write("shared-key", "c.txt", b"x", None).unwrap_err()).contains("CONFLICT"));
    assert!(code(write("w-6", "no/parent.txt", b"x", None).unwrap_err()).contains("NOT_FOUND"));
    for path in [
        "../escape",
        "/etc/passwd",
        "",
        ".",
        "a/../../b",
        "nul\0byte",
    ] {
        assert!(
            code(write("w-7", path, b"x", None).unwrap_err()).contains("INVALID_REQUEST"),
            "{path:?}"
        );
        assert!(
            code(host.read_file(1, None, path, None, None).unwrap_err())
                .contains("INVALID_REQUEST"),
            "{path:?}"
        );
    }
    let outside = fixture.root.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret"), b"secret").unwrap();
    symlink(&outside, fixture.workspace.join("escape")).unwrap();
    symlink(
        outside.join("secret"),
        fixture.workspace.join("leaf-escape"),
    )
    .unwrap();
    symlink("a.txt", fixture.workspace.join("alias")).unwrap();
    assert!(
        code(
            host.read_file(1, None, "escape/secret", None, None)
                .unwrap_err()
        )
        .contains("INVALID_REQUEST")
    );
    assert!(
        code(
            host.read_file(1, None, "leaf-escape", None, None)
                .unwrap_err()
        )
        .contains("INVALID_REQUEST")
    );
    assert!(code(write("w-8", "escape/new", b"x", None).unwrap_err()).contains("INVALID_REQUEST"));
    assert!(code(write("w-9", "alias", b"x", None).unwrap_err()).contains("INVALID_REQUEST"));
    assert_eq!(fs::read(outside.join("secret")).unwrap(), b"secret");
    assert!(!outside.join("new").exists());
    // In-workspace symlinks are readable on Linux; stat reports the link.
    if cfg!(target_os = "linux") {
        assert_eq!(
            host.read_file(1, None, "alias", None, None)
                .unwrap()
                .content,
            b"three\n"
        );
    }
    assert_eq!(host.stat_path(1, None, "alias").unwrap().kind, "symlink");
    let stat = host.stat_path(1, None, "a.txt").unwrap();
    assert_eq!(
        (stat.kind.as_str(), stat.size, stat.mode & 0o777),
        ("file", 6, 0o750)
    );
    assert_eq!(
        stat.sha256,
        host.read_file(1, None, "a.txt", None, None).unwrap().sha256
    );
    assert_eq!(host.stat_path(1, None, ".").unwrap().kind, "directory");
    assert!(code(host.stat_path(1, None, "missing").unwrap_err()).contains("NOT_FOUND"));
    assert!(
        code(host.read_file(1, None, "missing", None, None).unwrap_err()).contains("NOT_FOUND")
    );
    assert!(
        code(host.read_file(1, None, ".", None, None).unwrap_err()).contains("INVALID_REQUEST")
    );
    let page = host.read_file(1, None, "a.txt", Some(1), Some(2)).unwrap();
    assert_eq!((page.content.as_slice(), page.eof), (&b"hr"[..], false));
    assert!(
        code(
            host.write_file(
                1,
                None,
                Some(1),
                "w-10",
                "big",
                &vec![0; cube_node_transport::runner::MAX_WRITE_BYTES + 1],
                None,
                false
            )
            .unwrap_err()
        )
        .contains("INVALID_REQUEST")
    );
    // No temporary files are left behind.
    assert!(fs::read_dir(&fixture.workspace).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".cube-write-")
    }));
}
