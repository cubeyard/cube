//! The journal and the real wrapper (`cube-agent wrap`) on this host, with
//! process groups standing in for the agent's cgroups (the test runs as an
//! ordinary user). Not the guest: the same operations run inside a keel
//! machine in keel-agent-check.
#![cfg(target_os = "linux")]
use std::{
    collections::BTreeMap,
    ffi::OsStr,
    fs, io,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
    time::{Duration, Instant},
};

use cube_agent::{
    domain::Domain,
    journal::{Journal, Launch},
};
use serde_json::{Value, json};

/// One process group per operation, a marker file while it is unrecorded.
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
        let _ = fs::remove_file(self.0.join(id));
    }
}

struct Machine {
    _dir: tempfile::TempDir,
    root: PathBuf,
    groups: PathBuf,
    journal: Arc<Journal>,
}

fn journal(root: &Path, groups: &Path) -> Arc<Journal> {
    let journal = Arc::new(Journal::new(
        root.join("var/lib/cube"),
        root.into(),
        Arc::new(ProcessGroups(groups.into())),
        PathBuf::from(env!("CARGO_BIN_EXE_cube-agent")),
    ));
    journal.set_launch(Launch {
        workspace: root.join("workspace"),
        namespace: None,
        account: None,
        env: BTreeMap::from([
            ("PATH".into(), cube_agent::STANDARD_PATH.into()),
            ("CUBE_TEST".into(), "yes".into()),
        ]),
    });
    journal.recover().unwrap();
    journal
}

fn machine() -> Machine {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("root");
    let groups = dir.path().join("groups");
    fs::create_dir_all(root.join("workspace/sub")).unwrap();
    fs::create_dir_all(&groups).unwrap();
    let journal = journal(&root, &groups);
    journal.spawn_supervisor();
    Machine {
        _dir: dir,
        root,
        groups,
        journal,
    }
}

fn exec(journal: &Journal, id: &str, command: &str, epoch: i64) -> Result<Value, (String, String)> {
    journal
        .exec(&json!({"id": id, "epoch": epoch, "command": command, "timeoutMs": 10000}))
        .map(|(header, _)| header)
        .map_err(|f| (f.code, f.message))
}

fn settle(journal: &Journal, id: &str) -> (Value, Vec<u8>) {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let (header, body) = journal.get(&json!({"id": id, "waitMs": 2000})).unwrap();
        if header["state"] != "Running" {
            return (header, body);
        }
        assert!(Instant::now() < deadline, "{id} still running");
    }
}

#[test]
fn a_key_runs_once_and_its_output_is_kept() {
    let m = machine();
    let j = &m.journal;
    assert_eq!(
        exec(
            j,
            "e1",
            "printf once >> count; printf hello; echo \"$CUBE_TEST\" >&2",
            1
        )
        .unwrap()["state"],
        "Running"
    );
    let (header, body) = settle(j, "e1");
    assert_eq!(header["state"], "Succeeded");
    assert_eq!(body, b"helloyes\n");
    assert_eq!(header["result"]["exitCode"], 0);
    assert_eq!(header["result"]["termination"], "exited");
    assert_eq!(header["result"]["serviceResult"], "success");
    assert_eq!(header["result"]["truncated"], false);
    // The same key and request: the recorded state, never run again.
    assert_eq!(
        exec(
            j,
            "e1",
            "printf once >> count; printf hello; echo \"$CUBE_TEST\" >&2",
            1
        )
        .unwrap()["state"],
        "Succeeded"
    );
    assert_eq!(
        fs::read_to_string(m.root.join("workspace/count")).unwrap(),
        "once"
    );
    assert_eq!(
        exec(j, "e1", "touch must-not-run", 1).unwrap_err().0,
        "CONFLICT"
    );
    assert!(!m.root.join("workspace/must-not-run").exists());
    // An unknown key.
    assert_eq!(
        j.get(&json!({"id": "never"})).unwrap().0,
        json!({"state": "Unknown"})
    );
    // Exit codes and cwd.
    exec(j, "e2", "pwd; exit 3", 1).unwrap();
    let (header, body) = settle(j, "e2");
    assert_eq!(
        (
            header["result"]["exitCode"].clone(),
            header["result"]["serviceResult"].clone()
        ),
        (json!(3), json!("exit-code"))
    );
    assert!(
        String::from_utf8(body)
            .unwrap()
            .trim_end()
            .ends_with("/workspace")
    );
    j.exec(&json!({"id": "e3", "epoch": 1, "command": "pwd", "cwd": "sub", "timeoutMs": 5000}))
        .unwrap();
    assert!(
        String::from_utf8(settle(j, "e3").1)
            .unwrap()
            .trim_end()
            .ends_with("/workspace/sub")
    );
}

#[test]
fn output_is_paged_and_truncated() {
    let m = machine();
    let j = &m.journal;
    j.exec(&json!({"id": "big", "epoch": 1, "command": "head -c 150000 /dev/zero | tr '\\0' b", "timeoutMs": 10000})).unwrap();
    let (header, body) = settle(j, "big");
    assert_eq!(header["result"]["retainedBytes"], 150000);
    assert_eq!(body.len(), 65536);
    let (page, body) = j.get(&json!({"id": "big", "cursor": 131072})).unwrap();
    assert_eq!(
        (page["result"]["outputOffset"].clone(), body.len()),
        (json!(131072), 150000 - 131072)
    );
    assert_eq!(
        j.get(&json!({"id": "big", "cursor": 150001}))
            .unwrap_err()
            .code,
        "INVALID_REQUEST"
    );
    j.exec(&json!({"id": "cut", "epoch": 1, "command": "head -c 5000 /dev/zero", "outputLimit": 100, "timeoutMs": 10000})).unwrap();
    let (header, body) = settle(j, "cut");
    assert_eq!(
        (
            body.len(),
            header["result"]["outputBytes"].clone(),
            header["result"]["truncated"].clone()
        ),
        (100, json!(5000), json!(true))
    );
}

#[test]
fn requests_are_checked_and_epochs_never_go_back() {
    let m = machine();
    let j = &m.journal;
    let refused = |header: Value| j.exec(&header).unwrap_err().code;
    assert_eq!(
        refused(json!({"id": "bad key", "epoch": 1, "command": "true", "timeoutMs": 1})),
        "INVALID_REQUEST"
    );
    assert_eq!(
        refused(json!({"id": "a", "epoch": 1, "command": "", "timeoutMs": 1})),
        "INVALID_REQUEST"
    );
    assert_eq!(
        refused(json!({"id": "a", "epoch": 1, "command": "x".repeat(8193), "timeoutMs": 1})),
        "INVALID_REQUEST"
    );
    assert_eq!(
        refused(json!({"id": "a", "epoch": 1, "command": "true", "timeoutMs": 1_800_001})),
        "INVALID_REQUEST"
    );
    assert_eq!(
        refused(json!({"id": "a", "epoch": 1, "command": "true", "timeoutMs": 1.5})),
        "INVALID_REQUEST"
    );
    assert_eq!(
        refused(json!({"id": "a", "epoch": 1, "command": "true", "timeoutMs": 10, "cwd": ".."})),
        "INVALID_REQUEST"
    );
    assert_eq!(
        refused(json!({"id": "a", "epoch": 1, "command": "true", "timeoutMs": 10, "cwd": "/tmp"})),
        "INVALID_REQUEST"
    );
    std::os::unix::fs::symlink("/etc", m.root.join("workspace/out")).unwrap();
    assert_eq!(
        refused(json!({"id": "a", "epoch": 1, "command": "true", "timeoutMs": 10, "cwd": "out"})),
        "INVALID_REQUEST"
    );
    assert_eq!(
        refused(json!({"id": "a", "epoch": 0, "command": "true", "timeoutMs": 10})),
        "INVALID_REQUEST"
    );
    assert!(
        !m.root.join("var/lib/cube/ops/a").exists(),
        "a refused request leaves no record"
    );
    exec(j, "e5", "true", 5).unwrap();
    assert_eq!(j.current_epoch(), 5);
    assert_eq!(
        exec(j, "e4", "touch stale", 4).unwrap_err().0,
        "LEASE_STALE"
    );
    assert_eq!(
        j.cancel(&json!({"id": "e5", "epoch": 4})).unwrap_err().code,
        "LEASE_STALE"
    );
    exec(j, "e6", "true", 6).unwrap();
    settle(j, "e5");
    settle(j, "e6");
    assert!(!m.root.join("workspace/stale").exists());
}

#[test]
fn cancel_kills_the_whole_tree_and_can_come_first() {
    let m = machine();
    let j = &m.journal;
    j.exec(&json!({"id": "c1", "epoch": 1, "command": "(sleep 30; touch child-survived) & sleep 30; touch not-cancelled", "timeoutMs": 60000})).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    j.cancel(&json!({"id": "c1", "epoch": 1})).unwrap();
    let (header, _) = settle(j, "c1");
    assert_eq!(
        header,
        json!({"state": "Failed", "error": "CANCELLED", "completionUnknown": false})
    );
    // Cancelled before it arrived: the command never runs.
    assert_eq!(
        j.cancel(&json!({"id": "c2", "epoch": 1})).unwrap().0["error"],
        "CANCELLED"
    );
    assert_eq!(
        exec(j, "c2", "touch late", 1).unwrap()["error"],
        "CANCELLED"
    );
    std::thread::sleep(Duration::from_millis(300));
    for name in ["late", "not-cancelled", "child-survived"] {
        assert!(!m.root.join("workspace").join(name).exists(), "{name}");
    }
}

#[test]
fn a_timeout_and_the_end_of_the_main_process_kill_what_is_left() {
    let m = machine();
    let j = &m.journal;
    j.exec(&json!({"id": "t1", "epoch": 1, "command": "sleep 30", "timeoutMs": 300}))
        .unwrap();
    let (header, _) = settle(j, "t1");
    assert_eq!(header["result"]["termination"], "timedOut");
    assert_eq!(header["result"]["exitCode"], Value::Null);
    assert_eq!(header["result"]["serviceResult"], "timeout");
    // A background process the command leaves behind is killed with the
    // domain when the main process ends (KillMode=control-group).
    j.exec(&json!({"id": "bg", "epoch": 1, "command": "(sleep 2; touch leftover) >/dev/null 2>&1 & echo started", "timeoutMs": 10000})).unwrap();
    let (header, body) = settle(j, "bg");
    assert_eq!(
        (header["result"]["exitCode"].clone(), body),
        (json!(0), b"started\n".to_vec())
    );
    std::thread::sleep(Duration::from_millis(2500));
    assert!(!m.root.join("workspace/leftover").exists());
}

#[test]
fn an_agent_that_starts_again_finds_its_commands_and_a_reboot_interrupts_them() {
    let m = machine();
    exec(&m.journal, "long", "sleep 1; printf done", 1).unwrap();
    // A second journal over the same state and domains: the agent started
    // again while the command runs. It adopts the command and records it.
    let again = journal(&m.root, &m.groups);
    again.spawn_supervisor();
    m.journal
        .stopping
        .store(true, std::sync::atomic::Ordering::SeqCst); // the old one is gone
    let (header, body) = settle(&again, "long");
    assert_eq!(
        (header["state"].clone(), body),
        (json!("Succeeded"), b"done".to_vec())
    );

    // A record without an end and without a domain: cut off by a reboot.
    exec(&again, "cut", "sleep 30", 1).unwrap();
    again
        .stopping
        .store(true, std::sync::atomic::Ordering::SeqCst);
    let pgid: i32 = fs::read_to_string(m.groups.join("cut"))
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    unsafe { libc::killpg(pgid, libc::SIGKILL) };
    fs::remove_file(m.groups.join("cut")).unwrap(); // the boot took every cgroup with it
    let booted = journal(&m.root, &m.groups);
    assert_eq!(
        booted.get(&json!({"id": "cut"})).unwrap().0,
        json!({"state": "Interrupted", "completionUnknown": true})
    );
    assert_eq!(
        exec(&booted, "cut", "sleep 30", 1).unwrap()["state"],
        "Interrupted",
        "never run again"
    );
}
