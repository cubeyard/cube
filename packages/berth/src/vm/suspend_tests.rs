//! Suspend and resume in process (suspend.rs), without QEMU: a stand-in QMP
//! on the machine's `qmp.sock`, a `sleep` process as its QEMU (killed by
//! `quit`, reaped as `launch` reaps), and the agent's side of the channel
//! answered by hand. What only a real QEMU and agent show (the memory file,
//! the restore, the guest going on) is G-F's, natively.
use super::template_tests::{Lab, USER, base, create, fence, plenty, pull, reason, reference};
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
};

#[derive(Clone, Copy, PartialEq, Debug)]
enum Migrate {
    /// Writes the memory file and says completed.
    Completes,
    /// Stays active until cancelled.
    Hangs,
    Fails,
    /// `stop` is never answered (QEMU may have paused the guest).
    StopHangs,
    /// `migrate` itself is never answered (the migration may run).
    AnswerHangs,
    /// The migration stays active, and neither `migrate_cancel` nor `cont`
    /// is answered: the undo hangs (N-8).
    UndoHangs,
    /// Completes, but `quit` is never answered.
    QuitHangs,
}

/// The stand-in QEMU's monitor: every command it got, in order.
#[derive(Clone)]
struct Fake {
    commands: Arc<Mutex<Vec<String>>>,
}

impl Fake {
    fn commands(&self) -> Vec<String> {
        self.commands.lock().unwrap().clone()
    }
    fn index(&self, command: &str) -> Option<usize> {
        self.commands().iter().position(|c| c == command)
    }
}

/// Serves `qmp.sock` in `dir`. `on_quit` and `on_cont` run when those come.
fn fake_qmp(
    dir: &Path,
    migrate: Migrate,
    status: &'static str,
    on_quit: Arc<dyn Fn() + Send + Sync>,
    on_cont: Arc<dyn Fn() + Send + Sync>,
) -> Fake {
    let socket = dir.join(qemu::QMP_SOCKET);
    let _ = std::fs::remove_file(&socket);
    let listener = UnixListener::bind(&socket).unwrap();
    let fake = Fake {
        commands: Arc::default(),
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    let commands = Arc::clone(&fake.commands);
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let commands = Arc::clone(&commands);
            let cancelled = Arc::clone(&cancelled);
            let (on_quit, on_cont) = (Arc::clone(&on_quit), Arc::clone(&on_cont));
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut read = BufReader::new(read);
                let _ = write
                    .write_all(b"{\"QMP\": {\"version\": {}, \"capabilities\": []}}\n")
                    .await;
                let mut line = String::new();
                while read.read_line(&mut line).await.unwrap_or(0) > 0 {
                    let message: serde_json::Value = serde_json::from_str(&line).unwrap();
                    line.clear();
                    let command = message["execute"].as_str().unwrap_or_default().to_owned();
                    commands.lock().unwrap().push(command.clone());
                    // Taken, never answered: the runner's wait runs out first.
                    if (migrate == Migrate::StopHangs && command == "stop")
                        || (migrate == Migrate::AnswerHangs && command == "migrate")
                        || (migrate == Migrate::UndoHangs
                            && matches!(command.as_str(), "migrate_cancel" | "cont"))
                        || (migrate == Migrate::QuitHangs && command == "quit")
                    {
                        tokio::time::sleep(Duration::from_secs(60)).await;
                        return;
                    }
                    let answer = match command.as_str() {
                        "migrate" => {
                            if matches!(migrate, Migrate::Completes | Migrate::QuitHangs) {
                                let uri = message["arguments"]["uri"].as_str().unwrap();
                                std::fs::write(
                                    uri.strip_prefix("file:").unwrap(),
                                    vec![7u8; 1 << 16],
                                )
                                .unwrap();
                            }
                            serde_json::json!({})
                        }
                        "migrate_cancel" => {
                            cancelled.store(true, Ordering::SeqCst);
                            serde_json::json!({})
                        }
                        "query-migrate" => match (migrate, cancelled.load(Ordering::SeqCst)) {
                            (_, true) => serde_json::json!({"status": "cancelled"}),
                            (Migrate::Completes | Migrate::QuitHangs, _) => {
                                serde_json::json!({"status": "completed"})
                            }
                            (
                                Migrate::Hangs
                                | Migrate::StopHangs
                                | Migrate::AnswerHangs
                                | Migrate::UndoHangs,
                                _,
                            ) => {
                                serde_json::json!({"status": "active"})
                            }
                            (Migrate::Fails, _) => {
                                serde_json::json!({"status": "failed", "error-desc": "no space left"})
                            }
                        },
                        "query-status" => serde_json::json!({"status": status}),
                        "quit" => {
                            on_quit();
                            serde_json::json!({})
                        }
                        "cont" => {
                            on_cont();
                            serde_json::json!({})
                        }
                        _ => serde_json::json!({}),
                    };
                    let reply = format!("{}\n", serde_json::json!({ "return": answer }));
                    if write.write_all(reply.as_bytes()).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    fake
}

/// How the stand-in agent answers `snapshot_prepare`.
#[derive(Clone, Copy, PartialEq)]
enum Agent {
    /// Answers done, then says it is prepared (its `status`), then sees the
    /// runner leave: keel's agent.
    Prepares,
    /// Prepares, but never sees the runner leave.
    PreparesDeaf,
    /// Answers done but never says it is prepared.
    PreparesSilent,
    Refuses,
}

/// A RUNNING machine: a `sleep` as its QEMU, reaped as `launch` reaps it;
/// its channel connected, the agent answering on its own task. Returns the
/// stand-in monitor and the ops the runner sent the agent.
async fn running(
    runner: &Arc<VmRunner>,
    id: &str,
    migrate: Migrate,
    agent: Agent,
) -> (Fake, Arc<Mutex<Vec<String>>>) {
    let dir = runner.machine_dir(id);
    let mut child = tokio::process::Command::new("sleep")
        .arg("60")
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let pid = child.id().unwrap();
    let (exited_tx, exited) = watch::channel(false);
    let (guest, mut frames) = channel::Guest::connected("s1");
    {
        let mut state = runner.state.lock().unwrap();
        let entry = state.machines.get_mut(id).unwrap();
        entry.record.phase = Phase::Running;
        entry.record.boot = Some(Boot {
            boot_id: "boot-1".into(),
            started_at: Timestamp::now(),
            pid,
            qemu: runner.qemu_version(),
            kernel_sha256: runner.keel.kernel_sha256.clone(),
            base_sha256: runner.keel.base_sha256.clone(),
        });
        entry.live = Some(Live { pid, exited });
        entry.guest = Some(Arc::clone(&guest));
        runner.commit(&mut state, id).unwrap();
    }
    let reaper = Arc::clone(runner);
    let reaped = id.to_owned();
    tokio::spawn(async move {
        let status = child.wait().await;
        reaper.exited(&reaped, pid, status.map(|s| s.to_string()));
        let _ = exited_tx.send(true);
    });
    let quit: Arc<dyn Fn() + Send + Sync> = Arc::new(move || unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGKILL);
    });
    let fake = fake_qmp(&dir, migrate, "running", quit, Arc::new(|| {}));
    let ops = Arc::new(Mutex::new(vec![]));
    let sent = Arc::clone(&ops);
    let (says, machine) = (Arc::clone(runner), id.to_owned());
    tokio::spawn(async move {
        loop {
            tokio::select! {
                frame = frames.recv() => {
                    let Some(frame) = frame else { return };
                    let Some(proto::daemon_frame::T::Req(request)) = frame.t else { continue };
                    let name = match &request.op {
                        Some(Op::SnapshotPrepare(_)) => "snapshot_prepare",
                        Some(Op::SnapshotDone(_)) => "snapshot_done",
                        _ => "other",
                    };
                    sent.lock().unwrap().push(name.to_owned());
                    let answer = match (name, agent) {
                        ("snapshot_prepare", Agent::Refuses) => AnswerKind::Error(refuse(
                            Code::Internal,
                            "snapshot_prepare",
                            "drop_caches: permission denied",
                        )),
                        _ => AnswerKind::Done(proto::Empty {}),
                    };
                    guest.answer(frame.ch, Ok(answer));
                    if name == "snapshot_prepare" && matches!(agent, Agent::Prepares | Agent::PreparesDeaf) {
                        says.publish_guest(&machine, "boot-1", proto::GuestInfo {
                            connected: true,
                            ready: false,
                            reason: "prepared for a snapshot".into(),
                            ..Default::default()
                        });
                    }
                }
                _ = tokio::time::sleep(Duration::from_millis(20)) => {
                    if agent == Agent::Prepares {
                        guest.agent_saw_leave();
                    }
                }
            }
        }
    });
    (fake, ops)
}

fn suspend_call(id: &str, epoch: i64) -> proto::Call {
    proto::Call {
        verb: Some(Verb::MachineSuspend(proto::MachineRef {
            r#ref: Some(reference(id)),
            fence: fence(epoch),
        })),
    }
}

async fn call(runner: &Arc<VmRunner>, verb: proto::Call) -> Answer<call_result::Result> {
    match tokio::time::timeout(Duration::from_secs(20), runner.answer(verb))
        .await
        .expect("an answer")
        .result
        .unwrap()
    {
        call_result::Result::Error(error) => Err(error),
        result => Ok(result),
    }
}

fn phase(runner: &VmRunner, id: &str) -> Phase {
    runner.state.lock().unwrap().machines[id].record.phase
}

fn on_disk(runner: &VmRunner, id: &str) -> MachineRecord {
    record::read(&runner.machine_dir(id).join(record::RECORD)).unwrap()
}

async fn lab_runner(lab: &Lab, margin: Option<u64>, max: u32) -> Arc<VmRunner> {
    let image = pull(lab.path(), 1, &[1]);
    lab.runner_with(image, 16 << 30, plenty, margin, max).await
}

#[tokio::test]
async fn suspend_saves_the_memory_records_it_then_quits_and_the_machine_holds_no_slot() {
    let lab = Lab::new();
    let runner = lab_runner(&lab, Some(20), 8).await;
    create(&runner, USER, base(), false).await.unwrap();
    let (fake, ops) = running(&runner, USER, Migrate::Completes, Agent::Prepares).await;
    assert!(
        runner
            .hello(&proto::Hello {
                protocol: PROTOCOL,
                expect_node: "node-test".into(),
                ..Default::default()
            })
            .unwrap()
            .capabilities
            .contains(&"machine.suspend".to_owned())
    );
    let machine = match call(&runner, suspend_call(USER, 2)).await.unwrap() {
        call_result::Result::Machine(machine) => machine,
        other => panic!("{other:?}"),
    };
    let status = machine.status.unwrap();
    assert_eq!(status.phase, proto::machine_status::Phase::Suspended as i32);
    assert_eq!(
        status.boot_id, "boot-1",
        "a suspended machine keeps its boot"
    );
    let suspended = status.suspended.expect("MachineStatus.suspended");
    assert!(suspended.memory_bytes > 0 && suspended.saved_at.is_some());
    // The order of runner.proto: prepare, leave, stop, migrate, completed,
    // quit; the journal says SUSPENDED with its snapshot.
    assert_eq!(
        ops.lock().unwrap().first().map(String::as_str),
        Some("snapshot_prepare")
    );
    let (stop, migrate, quit) = (
        fake.index("stop").unwrap(),
        fake.index("migrate").unwrap(),
        fake.index("quit").unwrap(),
    );
    assert!(stop < migrate && migrate < quit, "{:?}", fake.commands());
    assert!(fake.index("cont").is_none(), "{:?}", fake.commands());
    let dir = runner.machine_dir(USER);
    assert!(dir.join(record::MEMORY).is_file() && !dir.join(record::MEMORY_PART).exists());
    let journal = on_disk(&runner, USER);
    assert_eq!(journal.phase, Phase::Suspended);
    assert_eq!(
        journal.snapshot.as_ref().unwrap().key,
        runner.snapshot_key(&dir, &journal)
    );
    // QEMU is gone, with no error; the slot is free (B7-2).
    tokio::time::timeout(Duration::from_secs(5), async {
        while runner.state.lock().unwrap().machines[USER].live.is_some() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("QEMU quit");
    {
        let state = runner.state.lock().unwrap();
        assert_eq!(state.machines[USER].record.phase, Phase::Suspended);
        assert!(state.machines[USER].record.error.is_empty());
        let capacity = runner.runner(&state).capacity.unwrap();
        assert_eq!((capacity.machines_active, capacity.suspended), (0, 1));
        assert_eq!(capacity.suspended_bytes, suspended.memory_bytes);
        // Streams to a suspended machine: UNAVAILABLE/suspended (cubed
        // wakes it).
        assert_eq!(
            reason(not_running(&state.machines[USER])),
            (Code::Unavailable, "suspended".into())
        );
    }
    // Again: answered as it is.
    assert!(matches!(
        call(&runner, suspend_call(USER, 3)).await,
        Ok(call_result::Result::Machine(_))
    ));
}

#[tokio::test]
async fn refusals_leave_the_machine_running_and_untouched() {
    let lab = Lab::new();
    // Off without the flag: UNIMPLEMENTED, not advertised.
    let off = lab_runner(&lab, None, 8).await;
    create(&off, USER, base(), false).await.unwrap();
    assert_eq!(
        reason(call(&off, suspend_call(USER, 2)).await.unwrap_err()),
        (Code::Unimplemented, "suspend".into())
    );
    assert!(
        !off.hello(&proto::Hello {
            protocol: PROTOCOL,
            expect_node: "node-test".into(),
            ..Default::default()
        })
        .unwrap()
        .capabilities
        .iter()
        .any(|c| c == "machine.suspend")
    );
    drop(off);

    let lab = Lab::new();
    let runner = lab_runner(&lab, Some(20), 8).await;
    create(&runner, USER, base(), false).await.unwrap();
    // A stopped machine is not suspended.
    assert_eq!(
        reason(call(&runner, suspend_call(USER, 2)).await.unwrap_err()),
        (Code::FailedPrecondition, "not_running".into())
    );
    let (fake, ops) = running(&runner, USER, Migrate::Completes, Agent::Prepares).await;
    // An open stream: busy (K-4), nothing sent, still RUNNING.
    runner
        .state
        .lock()
        .unwrap()
        .machines
        .get_mut(USER)
        .unwrap()
        .streams = 1;
    assert_eq!(
        reason(call(&runner, suspend_call(USER, 3)).await.unwrap_err()),
        (Code::FailedPrecondition, "busy".into())
    );
    runner
        .state
        .lock()
        .unwrap()
        .machines
        .get_mut(USER)
        .unwrap()
        .streams = 0;
    assert!(ops.lock().unwrap().is_empty() && fake.commands().is_empty());
    assert_eq!(phase(&runner, USER), Phase::Running);
}

fn twenty_gib(_: &Path) -> std::io::Result<u64> {
    Ok(20 << 30)
}

#[tokio::test]
async fn too_little_disk_keeps_the_machine_running() {
    let lab = Lab::new();
    let image = pull(lab.path(), 1, &[1]);
    // 20 GiB free, a 512 MiB machine, a margin of 20 GiB: refused.
    let runner = lab
        .runner_with(image, 16 << 30, twenty_gib, Some(20), 8)
        .await;
    create(&runner, USER, base(), false).await.unwrap();
    let (fake, ops) = running(&runner, USER, Migrate::Completes, Agent::Prepares).await;
    let error = call(&runner, suspend_call(USER, 2)).await.unwrap_err();
    assert_eq!(reason(error), (Code::ResourceExhausted, "disk".into()));
    assert!(ops.lock().unwrap().is_empty() && fake.commands().is_empty());
    assert_eq!(phase(&runner, USER), Phase::Running);
}

/// K-8: a save past SUSPEND_WAIT is undone: the migration cancelled, the
/// guest running again, the partial file gone, the runner back on the
/// channel; the answer is UNAVAILABLE/snapshot and the machine RUNNING.
#[tokio::test]
async fn a_save_that_takes_too_long_is_cancelled_and_the_machine_goes_on() {
    let lab = Lab::new();
    let runner = lab_runner(&lab, Some(1), 8).await;
    create(&runner, USER, base(), false).await.unwrap();
    let (fake, _) = running(&runner, USER, Migrate::Hangs, Agent::Prepares).await;
    let dir = runner.machine_dir(USER);
    std::fs::write(dir.join(record::MEMORY_PART), b"partial").unwrap();
    let started = std::time::Instant::now();
    let error = call(&runner, suspend_call(USER, 2)).await.unwrap_err();
    assert!(started.elapsed() >= suspend::SUSPEND_WAIT);
    assert_eq!(
        reason(error.clone()),
        (Code::Unavailable, "snapshot".into()),
        "{error:?}"
    );
    assert!(error.message.contains("longer than"), "{error:?}");
    let (cancel, cont) = (
        fake.index("migrate_cancel").unwrap(),
        fake.index("cont").unwrap(),
    );
    assert!(cancel < cont, "{:?}", fake.commands());
    assert!(fake.index("quit").is_none());
    assert!(!dir.join(record::MEMORY_PART).exists() && !dir.join(record::MEMORY).exists());
    assert_eq!(phase(&runner, USER), Phase::Running);
    assert_eq!(on_disk(&runner, USER).phase, Phase::Running);
    assert!(on_disk(&runner, USER).snapshot.is_none());
}

#[tokio::test]
async fn a_failed_migration_or_a_refused_prepare_is_undone() {
    let lab = Lab::new();
    let runner = lab_runner(&lab, Some(1), 8).await;
    create(&runner, USER, base(), false).await.unwrap();
    let (fake, _) = running(&runner, USER, Migrate::Fails, Agent::Prepares).await;
    let error = call(&runner, suspend_call(USER, 2)).await.unwrap_err();
    assert_eq!(
        reason(error.clone()),
        (Code::Unavailable, "snapshot".into())
    );
    assert!(error.message.contains("no space left"), "{error:?}");
    assert!(fake.index("cont").is_some(), "{:?}", fake.commands());
    assert_eq!(phase(&runner, USER), Phase::Running);

    // The agent refuses the prepare: snapshot_done, QEMU never stopped.
    let lab = Lab::new();
    let runner = lab_runner(&lab, Some(1), 8).await;
    create(&runner, USER, base(), false).await.unwrap();
    let (fake, ops) = running(&runner, USER, Migrate::Completes, Agent::Refuses).await;
    let error = call(&runner, suspend_call(USER, 2)).await.unwrap_err();
    assert_eq!(
        reason(error.clone()),
        (Code::Unavailable, "snapshot".into())
    );
    assert!(
        error.message.contains("refused snapshot_prepare"),
        "{error:?}"
    );
    assert_eq!(*ops.lock().unwrap(), ["snapshot_prepare", "snapshot_done"]);
    assert!(fake.commands().is_empty(), "{:?}", fake.commands());
    assert_eq!(phase(&runner, USER), Phase::Running);

    // The agent never says it is prepared: the runner does not leave, sends
    // snapshot_done and never stops QEMU (F-P7-2).
    let lab = Lab::new();
    let runner = lab_runner(&lab, Some(1), 8).await;
    create(&runner, USER, base(), false).await.unwrap();
    let (fake, ops) = running(&runner, USER, Migrate::Completes, Agent::PreparesSilent).await;
    let error = call(&runner, suspend_call(USER, 2)).await.unwrap_err();
    assert!(
        error
            .message
            .contains("did not say \"prepared for a snapshot\""),
        "{error:?}"
    );
    assert_eq!(*ops.lock().unwrap(), ["snapshot_prepare", "snapshot_done"]);
    assert!(fake.commands().is_empty(), "{:?}", fake.commands());
    assert_eq!(phase(&runner, USER), Phase::Running);

    // The agent never sees the runner leave: no stop; the runner rejoins.
    let lab = Lab::new();
    let runner = lab_runner(&lab, Some(1), 8).await;
    create(&runner, USER, base(), false).await.unwrap();
    let (fake, _) = running(&runner, USER, Migrate::Completes, Agent::PreparesDeaf).await;
    let error = call(&runner, suspend_call(USER, 2)).await.unwrap_err();
    assert!(
        error.message.contains("did not see the runner leave"),
        "{error:?}"
    );
    assert!(fake.index("stop").is_none(), "{:?}", fake.commands());
    assert_eq!(phase(&runner, USER), Phase::Running);
}

/// Writes `id`'s journal as a crash left it, and files beside it.
fn crashed(
    lab: &Lab,
    runner_dir: &Path,
    id: &str,
    change: impl FnOnce(&mut MachineRecord),
    files: &[&str],
) {
    let _ = lab;
    let dir = runner_dir.join(id);
    let mut record = record::read(&dir.join(record::RECORD)).unwrap();
    change(&mut record);
    record::write_json(&dir.join(record::RECORD), &record).unwrap();
    for file in files {
        std::fs::write(dir.join(file), b"memory").unwrap();
    }
}

fn key() -> record::SnapshotKey {
    record::SnapshotKey {
        qemu: "11.1.2 /q".into(),
        kernel_sha256: "k".into(),
        base_sha256: "b".into(),
        machine_type: "pc-q35-11.1".into(),
        size: record::Size {
            vcpus: 1,
            memory_mib: 512,
            disk_gib: 1,
        },
        argv_sha256: "a".into(),
        berth: "0.1.0".into(),
    }
}

fn snapshot() -> record::Snapshot {
    record::Snapshot {
        saved_at: Timestamp::now(),
        memory_bytes: 6,
        key: key(),
    }
}

/// K-2 and K-1 across a runner restart: the journal is the only authority.
#[tokio::test]
async fn a_restart_keeps_only_the_snapshots_the_journal_names_for_suspended_machines() {
    const A: &str = "00000000000000a1";
    const B: &str = "00000000000000a2";
    const C: &str = "00000000000000a3";
    const D: &str = "00000000000000a4";
    let lab = Lab::new();
    {
        let runner = lab_runner(&lab, Some(1), 8).await;
        for id in [A, B, C, D] {
            create(&runner, id, base(), false).await.unwrap();
        }
    }
    let root = lab.path().to_owned();
    // A: suspended and recorded; a partial file from an older save beside.
    crashed(
        &lab,
        &root,
        A,
        |r| {
            r.phase = Phase::Suspended;
            r.snapshot = Some(snapshot());
        },
        &[record::MEMORY, record::MEMORY_PART],
    );
    // B: a crash after the rename, before the journal (K-2).
    crashed(
        &lab,
        &root,
        B,
        |r| r.phase = Phase::Suspending,
        &[record::MEMORY],
    );
    // C: a crash between cont and the file's deletion (K-1): the journal
    // already lost the snapshot.
    crashed(
        &lab,
        &root,
        C,
        |r| r.phase = Phase::Running,
        &[record::MEMORY],
    );
    // D: a crash during a resume, before the load finished.
    crashed(
        &lab,
        &root,
        D,
        |r| {
            r.phase = Phase::Starting;
            r.snapshot = Some(snapshot());
        },
        &[record::MEMORY],
    );
    let runner = lab_runner(&lab, Some(1), 8).await;
    let has = |id: &str, file: &str| root.join(id).join(file).exists();
    assert!(has(A, record::MEMORY) && !has(A, record::MEMORY_PART));
    assert_eq!(phase(&runner, A), Phase::Suspended);
    for id in [B, C, D] {
        assert!(!has(id, record::MEMORY), "{id}: the memory file is deleted");
        let journal = on_disk(&runner, id);
        assert_eq!(journal.phase, Phase::Stopped, "{id}");
        assert!(journal.snapshot.is_none(), "{id}");
        assert_eq!(
            journal.interrupted.as_ref().unwrap().reason,
            "runner_restarted"
        );
    }
    assert_eq!(on_disk(&runner, D).dropped.unwrap().reason, "load");
    assert!(on_disk(&runner, C).dropped.is_none());
}

/// K-7 and the missing file: a snapshot that does not fit is dropped with
/// its reason, deleted, and the machine boots cold.
#[test]
fn only_a_snapshot_that_fits_is_loaded() {
    let dir = tempfile::tempdir().unwrap();
    let base_record = || {
        let mut r: MachineRecord = serde_json::from_value(serde_json::json!({
            "version": 1, "owner": "thread-1", "id": USER, "fenceEpoch": 1,
            "phase": "suspended", "size": {"vcpus": 1, "memoryMib": 512, "diskGib": 1},
            "machineType": "pc-q35-11.1", "createdWith": "11.1.2 /q",
            "createdAt": "2026-10-19T00:00:00Z", "interrupted": null, "error": "", "boot": null
        }))
        .unwrap();
        r.snapshot = Some(snapshot());
        r
    };
    let memory = dir.path().join(record::MEMORY);
    std::fs::write(&memory, b"m").unwrap();
    let mut fits = base_record();
    assert_eq!(
        suspend::usable(dir.path(), &mut fits, &key()),
        Some(memory.clone())
    );
    assert!(fits.dropped.is_none());
    for (changed, what) in [
        (
            record::SnapshotKey {
                qemu: "11.1.3 /q".into(),
                ..key()
            },
            "QEMU",
        ),
        (
            record::SnapshotKey {
                kernel_sha256: "k2".into(),
                ..key()
            },
            "keel kernel",
        ),
        (
            record::SnapshotKey {
                machine_type: "pc-q35-11.2".into(),
                ..key()
            },
            "machine type",
        ),
        (
            record::SnapshotKey {
                argv_sha256: "a2".into(),
                ..key()
            },
            "QEMU arguments",
        ),
        (
            record::SnapshotKey {
                size: record::Size {
                    memory_mib: 1024,
                    ..key().size
                },
                ..key()
            },
            "size",
        ),
        (
            record::SnapshotKey {
                berth: "0.1.1".into(),
                ..key()
            },
            "berth",
        ),
    ] {
        std::fs::write(&memory, b"m").unwrap();
        let mut record = base_record();
        assert_eq!(
            suspend::usable(dir.path(), &mut record, &changed),
            None,
            "{what}"
        );
        let dropped = record.dropped.unwrap();
        assert_eq!(dropped.reason, "version", "{what}");
        assert!(
            dropped.message.contains(what),
            "{what}: {}",
            dropped.message
        );
        assert!(record.snapshot.is_none() && !memory.exists(), "{what}");
    }
    let mut gone = base_record();
    assert_eq!(suspend::usable(dir.path(), &mut gone, &key()), None);
    assert_eq!(gone.dropped.unwrap().reason, "missing");
}

/// K-1 on a restore: the snapshot leaves the journal, synced, before the
/// guest runs (`cont`), and the memory file goes after.
#[tokio::test]
async fn a_restore_forgets_the_snapshot_before_cont_and_deletes_the_file_after() {
    let lab = Lab::new();
    let runner = lab_runner(&lab, Some(1), 8).await;
    create(&runner, USER, base(), false).await.unwrap();
    let dir = runner.machine_dir(USER);
    let memory = dir.join(record::MEMORY);
    std::fs::write(&memory, b"memory").unwrap();
    {
        let mut state = runner.state.lock().unwrap();
        let entry = state.machines.get_mut(USER).unwrap();
        entry.record.phase = Phase::Starting;
        entry.record.snapshot = Some(snapshot());
        runner.commit(&mut state, USER).unwrap();
    }
    let journal = dir.join(record::RECORD);
    let at_cont: Arc<Mutex<Option<(bool, bool)>>> = Arc::default();
    let seen = Arc::clone(&at_cont);
    let (memory_at_cont, journal_at_cont) = (memory.clone(), journal.clone());
    let fake = fake_qmp(
        &dir,
        Migrate::Completes,
        "inmigrate",
        Arc::new(|| {}),
        Arc::new(move || {
            let record = record::read(&journal_at_cont).unwrap();
            // The first cont is the one that counts.
            seen.lock()
                .unwrap()
                .get_or_insert((record.snapshot.is_none(), memory_at_cont.exists()));
        }),
    );
    let mut qmp = Qmp::open(&dir.join(qemu::QMP_SOCKET), Duration::from_secs(2))
        .await
        .unwrap();
    runner.load(&mut qmp, USER, &dir, &memory).await.unwrap();
    assert_eq!(
        *at_cont.lock().unwrap(),
        Some((true, true)),
        "at cont the journal had no snapshot and the file was still there"
    );
    assert!(!memory.exists(), "deleted after cont");
    let commands = fake.commands();
    let incoming = commands
        .iter()
        .position(|c| c == "migrate-incoming")
        .unwrap();
    assert!(incoming < commands.iter().position(|c| c == "cont").unwrap());
}

#[tokio::test]
async fn a_suspended_machine_resumes_only_into_a_free_slot_and_stop_drops_its_snapshot() {
    const OTHER: &str = "00000000000000c2";
    let lab = Lab::new();
    let runner = lab_runner(&lab, Some(1), 1).await;
    create(&runner, USER, base(), false).await.unwrap();
    let dir = runner.machine_dir(USER);
    {
        let mut state = runner.state.lock().unwrap();
        let entry = state.machines.get_mut(USER).unwrap();
        entry.record.phase = Phase::Suspended;
        entry.record.snapshot = Some(snapshot());
        runner.commit(&mut state, USER).unwrap();
    }
    std::fs::write(dir.join(record::MEMORY), b"m").unwrap();
    // The suspended machine holds no slot: another may be created (B7-2).
    create(&runner, OTHER, base(), false).await.unwrap();
    // Now the runner is full: the resume waits (cubed shows it), unchanged.
    let start = proto::Call {
        verb: Some(Verb::MachineStart(proto::MachineStart {
            r#ref: Some(reference(USER)),
            fence: fence(2),
            ..Default::default()
        })),
    };
    assert_eq!(
        reason(call(&runner, start).await.unwrap_err()),
        (Code::ResourceExhausted, "capacity".into())
    );
    assert_eq!(phase(&runner, USER), Phase::Suspended);
    assert!(dir.join(record::MEMORY).exists());
    // A stop drops the snapshot: the next start boots cold.
    let stop = proto::Call {
        verb: Some(Verb::MachineStop(proto::MachineRef {
            r#ref: Some(reference(USER)),
            fence: fence(3),
        })),
    };
    call(&runner, stop).await.unwrap();
    let journal = on_disk(&runner, USER);
    assert_eq!(journal.phase, Phase::Stopped);
    assert!(journal.snapshot.is_none() && !dir.join(record::MEMORY).exists());
}

/// B-1: the wait runs out after `stop` or `migrate` was sent but before
/// QEMU answered. The undo must still let the guest go on: `cont` after an
/// unanswered `stop`; `migrate_cancel`, then `cont`, after an unanswered
/// `migrate`. The journal says RUNNING and keeps no snapshot.
#[tokio::test]
async fn a_wait_that_runs_out_before_stop_or_migrate_answer_still_lets_the_guest_go_on() {
    for (migrate, sent) in [
        (Migrate::StopHangs, "stop"),
        (Migrate::AnswerHangs, "migrate"),
    ] {
        let lab = Lab::new();
        let runner = lab_runner(&lab, Some(1), 8).await;
        create(&runner, USER, base(), false).await.unwrap();
        let (fake, _) = running(&runner, USER, migrate, Agent::Prepares).await;
        let error = call(&runner, suspend_call(USER, 2)).await.unwrap_err();
        assert_eq!(
            reason(error.clone()),
            (Code::Unavailable, "snapshot".into()),
            "{migrate:?}: {error:?}"
        );
        assert!(
            error.message.contains("longer than"),
            "{migrate:?}: {error:?}"
        );
        let commands = fake.commands();
        let sent_at = fake
            .index(sent)
            .unwrap_or_else(|| panic!("{migrate:?}: {sent} not sent: {commands:?}"));
        let cont = commands
            .iter()
            .rposition(|c| c == "cont")
            .unwrap_or_else(|| panic!("{migrate:?}: {sent} was sent, but no cont: {commands:?}"));
        assert!(sent_at < cont, "{migrate:?}: {commands:?}");
        if migrate == Migrate::AnswerHangs {
            let cancel = fake
                .index("migrate_cancel")
                .unwrap_or_else(|| panic!("no migrate_cancel: {commands:?}"));
            assert!(sent_at < cancel && cancel < cont, "{commands:?}");
        }
        assert!(fake.index("quit").is_none(), "{commands:?}");
        let dir = runner.machine_dir(USER);
        assert!(!dir.join(record::MEMORY_PART).exists() && !dir.join(record::MEMORY).exists());
        assert_eq!(phase(&runner, USER), Phase::Running, "{migrate:?}");
        let journal = on_disk(&runner, USER);
        assert_eq!(journal.phase, Phase::Running, "{migrate:?}");
        assert!(journal.snapshot.is_none(), "{migrate:?}");
    }
}

/// B-207-3: a suspend waits at most OPS_WAIT for the runner's `ops`. Held by
/// another operation past that, it is refused as busy and nothing is sent;
/// it never saves later, after cubed gave up. Control: once `ops` is free,
/// the same call suspends.
#[tokio::test]
async fn a_suspend_that_cannot_have_ops_in_time_is_refused_and_never_runs_later() {
    let lab = Lab::new();
    let runner = lab_runner(&lab, Some(1), 8).await;
    create(&runner, USER, base(), false).await.unwrap();
    let (fake, ops) = running(&runner, USER, Migrate::Completes, Agent::Prepares).await;
    let held = runner.ops.lock().await;
    let started = std::time::Instant::now();
    let error = call(&runner, suspend_call(USER, 2)).await.unwrap_err();
    let waited = started.elapsed();
    assert_eq!(
        reason(error.clone()),
        (Code::FailedPrecondition, "busy".into()),
        "{error:?}"
    );
    assert!(error.message.contains("held the runner"), "{error:?}");
    assert!(
        waited >= suspend::OPS_WAIT && waited < suspend::OPS_WAIT + Duration::from_secs(1),
        "{waited:?}"
    );
    // The other operation goes on well past the refusal: still nothing.
    tokio::time::sleep(Duration::from_millis(500)).await;
    drop(held);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(ops.lock().unwrap().is_empty() && fake.commands().is_empty());
    assert_eq!(phase(&runner, USER), Phase::Running);
    assert_eq!(on_disk(&runner, USER).phase, Phase::Running);
    // Control: with `ops` free, the same machine suspends.
    assert!(matches!(
        call(&runner, suspend_call(USER, 3)).await,
        Ok(call_result::Result::Machine(_))
    ));
    assert_eq!(phase(&runner, USER), Phase::Suspended);
}

/// N-8: an undo QEMU does not answer (no `migrate_cancel`, no `cont`) is
/// bounded by TAIL_WAIT: QEMU is killed, the machine is STOPPED with its disk,
/// no memory file stays, and `ops` is free for the next operation. The answer
/// comes within the bound cubed relies on.
#[tokio::test]
async fn an_undo_that_hangs_kills_qemu_and_frees_the_runner_in_time() {
    let lab = Lab::new();
    let runner = lab_runner(&lab, Some(1), 8).await;
    create(&runner, USER, base(), false).await.unwrap();
    let (fake, _) = running(&runner, USER, Migrate::UndoHangs, Agent::Prepares).await;
    let started = std::time::Instant::now();
    let error = call(&runner, suspend_call(USER, 2)).await.unwrap_err();
    let waited = started.elapsed();
    assert_eq!(
        reason(error.clone()),
        (Code::Unavailable, "snapshot".into()),
        "{error:?}"
    );
    assert!(error.message.contains("undo did not finish"), "{error:?}");
    assert!(
        waited < suspend::SUSPEND_WAIT + suspend::TAIL_WAIT + Duration::from_secs(2),
        "{waited:?}"
    );
    assert!(
        fake.index("migrate_cancel").is_some(),
        "{:?}",
        fake.commands()
    );
    let dir = runner.machine_dir(USER);
    assert!(!dir.join(record::MEMORY_PART).exists() && !dir.join(record::MEMORY).exists());
    assert!(runner.state.lock().unwrap().machines[USER].live.is_none());
    assert_eq!(phase(&runner, USER), Phase::Stopped);
    let journal = on_disk(&runner, USER);
    assert_eq!(journal.phase, Phase::Stopped);
    assert!(journal.snapshot.is_none());
    assert!(runner.ops.try_lock().is_ok(), "ops is free");
}

/// After a completed save, a QEMU that does not answer `quit` is killed
/// within TAIL_WAIT: the machine is SUSPENDED, its snapshot kept.
#[tokio::test]
async fn a_quit_that_hangs_after_the_save_is_bounded() {
    let lab = Lab::new();
    let runner = lab_runner(&lab, Some(1), 8).await;
    create(&runner, USER, base(), false).await.unwrap();
    let (fake, _) = running(&runner, USER, Migrate::QuitHangs, Agent::Prepares).await;
    let started = std::time::Instant::now();
    let machine = match call(&runner, suspend_call(USER, 2)).await.unwrap() {
        call_result::Result::Machine(machine) => machine,
        other => panic!("{other:?}"),
    };
    let waited = started.elapsed();
    // TAIL_WAIT is 2 s here; QMP's own read timeout alone would take 10 s.
    assert!(waited < Duration::from_secs(5), "{waited:?}");
    assert!(fake.index("quit").is_some(), "{:?}", fake.commands());
    assert_eq!(
        machine.status.unwrap().phase,
        proto::machine_status::Phase::Suspended as i32
    );
    assert!(runner.state.lock().unwrap().machines[USER].live.is_none());
    let journal = on_disk(&runner, USER);
    assert_eq!(journal.phase, Phase::Suspended);
    assert!(journal.snapshot.is_some());
    assert!(runner.machine_dir(USER).join(record::MEMORY).is_file());
}
