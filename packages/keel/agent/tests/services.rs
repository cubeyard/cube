//! `cube service` on this host: the services, the real `cube-agent
//! service-run` wrapper and the `cube` socket, with process groups standing
//! in for the agent's cgroups (the test runs as an ordinary user) and
//! 127.0.0.1 as the machine's address. Not the guest: the same commands run
//! inside a keel machine in keel-agent-check.
#![cfg(target_os = "linux")]
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fs,
    io::{self, BufRead, BufReader, Write},
    net::TcpListener,
    os::unix::{net::UnixStream, process::CommandExt},
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::{Duration, Instant},
};

use cube_agent::{
    cli,
    domain::Domain,
    journal::Launch,
    services::{Paths, Services},
};
use serde_json::{Value, json};

/// One process group per service, a file with its id while it exists.
struct ProcessGroups(PathBuf);

impl ProcessGroups {
    fn group(&self, id: &str) -> Option<i32> {
        fs::read_to_string(self.0.join(id))
            .ok()?
            .trim()
            .parse()
            .ok()
    }
}

impl Domain for ProcessGroups {
    fn start(&self, id: &str, program: &Path, args: &[&OsStr]) -> io::Result<()> {
        let mut command = Command::new(program);
        command.args(args);
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        let child = command.spawn()?;
        fs::write(self.0.join(id), child.id().to_string())?;
        let status = child.wait_with_output()?.status;
        if !status.success() {
            return Err(io::Error::other(format!("wrapper: {status}")));
        }
        Ok(())
    }
    fn exists(&self, id: &str) -> bool {
        self.0.join(id).exists()
    }
    fn populated(&self, id: &str) -> bool {
        self.group(id)
            .is_some_and(|pgid| unsafe { libc::killpg(pgid, 0) } == 0)
    }
    fn kill(&self, id: &str) {
        if let Some(pgid) = self.group(id) {
            unsafe { libc::killpg(pgid, libc::SIGKILL) };
        }
    }
    fn memory(&self, _id: &str) -> Option<Value> {
        None
    }
    fn remove(&self, id: &str) {
        if !self.populated(id) {
            let _ = fs::remove_file(self.0.join(id));
        }
    }
}

struct Machine {
    dir: tempfile::TempDir,
    groups: Arc<ProcessGroups>,
    services: Arc<Services>,
    socket: PathBuf,
}

impl Drop for Machine {
    /// Registrations first, so no supervisor starts a service again.
    fn drop(&mut self) {
        let names: Vec<String> = self
            .services
            .registrations()
            .iter()
            .map(|record| record["name"].as_str().unwrap().to_string())
            .collect();
        let _ = fs::remove_dir_all(&self.services.paths.registry);
        for name in names {
            self.groups.kill(&name);
        }
    }
}

fn paths(dir: &Path, run: &str) -> Paths {
    Paths {
        registry: dir.join("root/var/lib/cube/services"),
        run: dir.join(run),
        portal: dir.join("root/var/lib/cube/portal.json"),
        root: dir.join("root"),
    }
}

fn launch(dir: &Path) -> Launch {
    Launch {
        workspace: dir.join("root/workspace"),
        namespace: None,
        account: None,
        env: BTreeMap::from([
            ("PATH".into(), cube_agent::STANDARD_PATH.into()),
            ("CUBE_TEST".into(), "yes".into()),
        ]),
    }
}

fn open(dir: &Path, groups: &Arc<ProcessGroups>, run: &str) -> Arc<Services> {
    let services = Services::open(
        paths(dir, run),
        Arc::clone(groups) as Arc<dyn Domain>,
        PathBuf::from(env!("CARGO_BIN_EXE_cube-agent")),
        Some("127.0.0.1".into()),
    )
    .unwrap();
    services.spawn_supervisor();
    services
}

fn machine() -> Machine {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("root/workspace/app")).unwrap();
    fs::create_dir_all(dir.path().join("groups")).unwrap();
    let groups = Arc::new(ProcessGroups(dir.path().join("groups")));
    let services = open(dir.path(), &groups, "run");
    services.set_launch(&launch(dir.path())).unwrap();
    let socket = dir.path().join("root/run/cube/agent.sock");
    cli::listen(
        Arc::clone(&services),
        &socket,
        Some(unsafe { libc::getuid() }),
    )
    .unwrap();
    Machine {
        dir,
        groups,
        services,
        socket,
    }
}

/// `cube ARGS` from `cwd` over the socket: (exit, stdout, stderr).
fn cube_at(socket: &Path, cwd: &str, args: &[&str]) -> (i64, String, String) {
    let mut stream = UnixStream::connect(socket).unwrap();
    let mut line = json!({"argv": args, "cwd": cwd}).to_string();
    line.push('\n');
    stream.write_all(line.as_bytes()).unwrap();
    let (mut out, mut err) = (String::new(), String::new());
    for line in BufReader::new(stream).lines() {
        let message: Value = serde_json::from_str(&line.unwrap()).unwrap();
        if let Some(text) = message["out"].as_str() {
            out += text;
        } else if let Some(text) = message["err"].as_str() {
            err += text;
        } else if let Some(code) = message["exit"].as_i64() {
            return (code, out, err);
        }
    }
    panic!("no exit status; out {out:?} err {err:?}");
}

fn cube(machine: &Machine, args: &[&str]) -> (i64, String, String) {
    cube_at(&machine.socket, "/workspace", args)
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn until(what: &str, seconds: u64, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(seconds);
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn listed(services: &Services) -> Value {
    services.list(&json!({"probe": true})).unwrap().0["services"].clone()
}

const SERVER: &str = "exec python3 -m http.server \"$PORT\" --bind \"$HOST\"";

#[test]
fn a_service_runs_restarts_logs_and_stops() {
    let machine = machine();
    let services = &machine.services;
    services
        .portal(&json!({"portal": {"urlTemplate": "http://{name}-0123456789.100-64-0-1.sslip.io:7780/"}}))
        .unwrap();
    let port = free_port();
    let port_text = port.to_string();
    let command = format!("echo greeting=$GREETING service=$CUBE_SERVICE pwd=$(pwd); {SERVER}");
    let (code, out, err) = cube(
        &machine,
        &[
            "service",
            "start",
            "web",
            "--port",
            &port_text,
            "--cwd",
            "app",
            "--env",
            "GREETING=hi",
            "--json",
            "--",
            &command,
        ],
    );
    assert_eq!(code, 0, "{out}{err}");
    let view: Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(view["ok"], true);
    assert_eq!(
        view["url"],
        "http://web-0123456789.100-64-0-1.sslip.io:7780/"
    );
    assert!(
        view["http"].as_str().unwrap().starts_with("HTTP/1.0 200"),
        "{view}"
    );
    assert_eq!(view["cwd"], "/workspace/app");
    assert_eq!(view["state"], "active");

    let list = listed(services);
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(
        (
            &list[0]["name"],
            &list[0]["port"],
            &list[0]["state"],
            &list[0]["listening"],
            &list[0]["restarts"]
        ),
        (
            &json!("web"),
            &json!(port),
            &json!("active"),
            &json!(true),
            &json!(0)
        )
    );
    let (code, out, _) = cube(&machine, &["service", "list"]);
    assert_eq!(code, 0);
    assert!(out.contains(&format!("web  port {port}  active")), "{out}");
    let (code, _, err) = cube(
        &machine,
        &[
            "service", "start", "other", "--port", &port_text, "--", "true",
        ],
    );
    assert_eq!(code, 2);
    assert!(err.contains("already service web"), "{err}");

    // The command's output, with its environment and directory.
    until("the log", 10, || {
        cube(&machine, &["service", "logs", "web"])
            .1
            .contains("GET / HTTP/1.1")
    });
    let (_, logs, _) = cube(&machine, &["service", "logs", "web", "-n", "200"]);
    let root = machine.dir.path().join("root");
    assert!(
        logs.contains(&format!(
            "greeting=hi service=web pwd={}/workspace/app",
            root.display()
        )),
        "{logs}"
    );

    // Killed: restarted after the delay, counted.
    let before = machine.groups.group("web").unwrap();
    machine.groups.kill("web");
    until("the restart", 15, || {
        let list = listed(services);
        list[0]["restarts"] == 1 && list[0]["state"] == "active" && list[0]["listening"] == true
    });
    assert_ne!(
        machine.groups.group("web"),
        Some(before),
        "a new process group"
    );

    // `restart` starts it over: restarts are counted from there.
    let (code, out, err) = cube(&machine, &["service", "restart", "web"]);
    assert_eq!(code, 0, "{out}{err}");
    assert!(
        out.contains(&format!("service web restarted on port {port}")),
        "{out}"
    );
    assert_eq!(listed(services)[0]["restarts"], 0);

    let (code, out, _) = cube(&machine, &["service", "stop", "web"]);
    assert_eq!((code, out.trim()), (0, "service web stopped"));
    assert_eq!(listed(services), json!([]));
    assert!(!machine.groups.populated("web"));
    assert!(!services.log("web").exists(), "its log goes with it");
    assert_eq!(
        cube(&machine, &["service", "stop", "web"]).1.trim(),
        "no service web"
    );
}

#[test]
fn a_failing_service_reports_its_output_and_stops_being_restarted() {
    let machine = machine();
    let port = free_port().to_string();
    let (code, out, _) = cube(
        &machine,
        &[
            "service",
            "start",
            "broken",
            "--port",
            &port,
            "--wait",
            "5",
            "--",
            "echo it broke; exit 3",
        ],
    );
    assert_eq!(code, 1);
    assert!(
        out.contains("service broken is registered but not healthy"),
        "{out}"
    );
    assert!(out.contains("it broke"), "{out}");
    assert!(out.contains("cube service restart broken"), "{out}");
    // Five starts in a minute, then failed (2 s apart).
    until("failed", 30, || {
        listed(&machine.services)[0]["state"] == "failed"
    });
    assert_eq!(listed(&machine.services)[0]["restarts"], 4);
    let (_, status, _) = cube(&machine, &["service", "status", "broken"]);
    assert!(status.contains("failed (4 restarts)"), "{status}");
    assert!(
        status.contains("url: none (cube has not configured a portal"),
        "{status}"
    );
    assert!(status.contains("last output:\n  it broke"), "{status}");

    // Exit status 0 is done, not restarted.
    let (code, out, _) = cube(
        &machine,
        &[
            "service",
            "start",
            "once",
            "--port",
            &free_port().to_string(),
            "--wait",
            "5",
            "--",
            "echo done",
        ],
    );
    assert_eq!(code, 1);
    assert!(out.contains("the service stopped (dead)"), "{out}");
    std::thread::sleep(Duration::from_secs(3));
    let once = listed(&machine.services);
    let once = once
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["name"] == "once")
        .unwrap();
    assert_eq!(
        (&once["state"], &once["restarts"]),
        (&json!("inactive"), &json!(0))
    );
}

#[test]
fn services_start_again_after_a_boot_and_are_found_again_after_an_agent_restart() {
    let machine = machine();
    let port = free_port();
    let (code, out, err) = cube(
        &machine,
        &[
            "service",
            "start",
            "web",
            "--port",
            &port.to_string(),
            "--",
            SERVER,
        ],
    );
    assert_eq!(code, 0, "{out}{err}");
    let group = machine.groups.group("web").unwrap();

    // The agent starts again (same boot, same /run): the running process is
    // found again, not started twice.
    let again = open(machine.dir.path(), &machine.groups, "run");
    assert_eq!(listed(&again)[0]["state"], "active");
    again.set_launch(&launch(machine.dir.path())).unwrap();
    std::thread::sleep(Duration::from_millis(600));
    assert_eq!(machine.groups.group("web"), Some(group));

    // A new boot of the same disk: a copy of its state (its own port, so
    // the first machine's process stays apart), no cgroups and an empty
    // /run. Nothing runs before the setup; the first setup starts it.
    let disk = tempfile::tempdir().unwrap();
    fs::create_dir_all(disk.path().join("root/workspace")).unwrap();
    fs::create_dir_all(disk.path().join("root/var/lib/cube/services")).unwrap();
    fs::create_dir_all(disk.path().join("groups")).unwrap();
    let mut record: Value = serde_json::from_slice(
        &fs::read(machine.services.paths.registry.join("web.json")).unwrap(),
    )
    .unwrap();
    let port = free_port();
    record["port"] = json!(port);
    fs::write(
        disk.path().join("root/var/lib/cube/services/web.json"),
        record.to_string(),
    )
    .unwrap();
    let groups = Arc::new(ProcessGroups(disk.path().join("groups")));
    let booted = open(disk.path(), &groups, "run");
    assert_eq!(
        listed(&booted)[0]["state"],
        "missing",
        "nothing before the setup"
    );
    booted.set_launch(&launch(disk.path())).unwrap();
    until("the service after the boot", 10, || {
        let list = listed(&booted);
        list[0]["state"] == "active" && list[0]["listening"] == true
    });
    assert_eq!(listed(&booted)[0]["restarts"], 0);
    assert_eq!(
        machine.groups.group("web"),
        Some(group),
        "the first machine's own"
    );
    fs::remove_file(disk.path().join("root/var/lib/cube/services/web.json")).unwrap();
    groups.kill("web");
}

#[test]
fn the_cli_checks_what_it_is_given() {
    let machine = machine();
    for (argv, message) in [
        (
            vec!["service", "start", "Web", "--port", "8000", "--", "x"],
            "service name",
        ),
        (
            vec![
                "service",
                "start",
                "web\nExecStartPre=x",
                "--port",
                "8000",
                "--",
                "x",
            ],
            "service name",
        ),
        (vec!["service", "status", "web\n"], "service name"),
        (
            vec!["service", "start", "web", "--port", "80", "--", "x"],
            "--port must be 1024-65535",
        ),
        (
            vec!["service", "start", "web", "--port", "8000"],
            "give the command after --",
        ),
        (
            vec![
                "service", "start", "web", "--port", "8000", "--env", "PORT=1", "--", "x",
            ],
            "--env takes",
        ),
        (
            vec![
                "service", "start", "web", "--port", "8000", "--cwd", "missing", "--", "x",
            ],
            "no directory /workspace/missing",
        ),
        (
            vec![
                "service",
                "start",
                "web",
                "--port",
                "8000",
                "--cwd",
                "../../../missing",
                "--",
                "x",
            ],
            "no directory /missing",
        ),
        (vec!["service", "frobnicate"], "unknown command"),
        (vec!["service", "status"], "one service name"),
        (vec!["service", "logs", "nope"], "no service nope"),
    ] {
        let (code, _, err) = cube(&machine, &argv);
        assert_eq!(code, 2, "{argv:?}: {err}");
        assert!(err.contains(message), "{argv:?}: {err}");
    }
    assert_eq!(cube(&machine, &["service", "--help"]).0, 0);
    assert!(
        cube(&machine, &["service", "--help"])
            .1
            .contains("cube service start NAME")
    );
    assert_eq!(cube(&machine, &["service"]).0, 2);
    assert_eq!(cube(&machine, &["frob"]).0, 2);
    for i in 0..16 {
        let name = format!("s{i}");
        let (code, _, err) = cube(
            &machine,
            &[
                "service",
                "open",
                &name,
                "--port",
                &(2000 + i).to_string(),
                "--wait",
                "0",
            ],
        );
        assert_eq!(code, 1, "{err}");
    }
    let (code, _, err) = cube(&machine, &["service", "open", "one-more", "--port", "3000"]);
    assert_eq!(code, 2);
    assert!(err.contains("at most 16 services"), "{err}");
    let (code, out, _) = cube(
        &machine,
        &[
            "service", "open", "s0", "--port", "2000", "--wait", "0", "--json",
        ],
    );
    assert_eq!(code, 1);
    let view: Value = serde_json::from_str(out.trim()).unwrap();
    assert_eq!(
        (&view["kind"], &view["ok"]),
        (&json!("external"), &json!(false))
    );
    assert_eq!(
        cube(&machine, &["service", "logs", "s0"]).0,
        2,
        "an external service has no logs here"
    );
}

#[test]
fn the_portal_settings_are_checked() {
    let machine = machine();
    for portal in [
        json!({"urlTemplate": "https://{name}-x.example/"}),
        json!({"urlTemplate": "http://evil/{name}"}),
        json!({}),
        Value::Null,
        json!({"reason": ""}),
        json!({"reason": "x".repeat(301)}),
    ] {
        assert_eq!(
            machine
                .services
                .portal(&json!({"portal": portal}))
                .map(|_| ())
                .unwrap_err()
                .code,
            "INVALID_REQUEST",
            "{portal}"
        );
    }
    let (value, _) = machine
        .services
        .portal(&json!({"portal": {"reason": "no portal here"}}))
        .unwrap();
    assert_eq!(value, json!({"reason": "no portal here"}));
    assert_eq!(machine.services.no_portal_reason(), "no portal here");
}

#[test]
fn only_the_agent_account_and_root_are_served() {
    if unsafe { libc::geteuid() } == 0 {
        return; // root is always served
    }
    let machine = machine();
    let other = machine.dir.path().join("other.sock");
    cli::listen(
        Arc::clone(&machine.services),
        &other,
        Some(unsafe { libc::getuid() } + 1),
    )
    .unwrap();
    let (code, _, err) = cube_at(&other, "/workspace", &["service", "list"]);
    assert_eq!(code, 1);
    assert!(err.contains("only the agent account and root"), "{err}");
    // A client slow to write its request still writes it whole and reads
    // the refusal, not a broken pipe (CI's flake: the refusal came first).
    let mut stream = UnixStream::connect(&other).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    stream
        .write_all(b"{\"argv\":[\"service\",\"list\"],\"cwd\":\"/\"}\n")
        .unwrap();
    let refusal = std::io::read_to_string(stream).unwrap();
    assert!(
        refusal.contains("only the agent account and root"),
        "{refusal}"
    );
}
