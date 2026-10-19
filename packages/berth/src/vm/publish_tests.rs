//! R14b in process: a publication holds `ops` only to begin and to finish,
//! not while its agent works, and marks its build machine meanwhile. Calls
//! go through `answer` (the verbs' own locking); the agent is the test, on
//! the build machine's channel (`channel::Guest::connected`), no QEMU.
use super::template_tests::{
    BUILD, Lab, OWNER, USER, base, create, fence, plenty, pull, reason, reference, write_layer,
};
use super::*;
use tokio::sync::mpsc;

/// What "not held up" and "at once" mean here: the publication's own
/// wait is 600 s.
const BOUND: Duration = Duration::from_secs(5);

/// The machine runs (no QEMU: `live` stays empty, so a stop or delete
/// needs none), its agent connected; what the runner sends it comes out.
fn running(runner: &VmRunner, id: &str) -> mpsc::UnboundedReceiver<proto::DaemonFrame> {
    let (guest, frames) = channel::Guest::connected("s1");
    let mut state = runner.state.lock().unwrap();
    let entry = state.machines.get_mut(id).unwrap();
    entry.record.phase = Phase::Running;
    entry.guest = Some(guest);
    frames
}

/// One call as cubed makes it, answered within BOUND.
async fn call(runner: &Arc<VmRunner>, verb: Verb) -> Answer<call_result::Result> {
    let answered = tokio::time::timeout(BOUND, runner.answer(proto::Call { verb: Some(verb) }))
        .await
        .unwrap_or_else(|_| panic!("no answer within {BOUND:?}"));
    match answered.result.unwrap() {
        call_result::Result::Error(error) => Err(error),
        result => Ok(result),
    }
}

fn ask(epoch: i64) -> proto::TemplatePublish {
    proto::TemplatePublish {
        from: Some(reference(BUILD)),
        fence: fence(epoch),
        key: "key-1".into(),
        meta: String::new(),
    }
}

/// `template_publish` from a task of its own, as cubed's stream.
fn publish(runner: &Arc<VmRunner>, epoch: i64) -> tokio::task::JoinHandle<proto::CallResult> {
    let runner = Arc::clone(runner);
    tokio::spawn(async move {
        runner
            .answer(proto::Call {
                verb: Some(Verb::TemplatePublish(ask(epoch))),
            })
            .await
    })
}

/// The channel the agent was asked to publish on.
async fn asked(frames: &mut mpsc::UnboundedReceiver<proto::DaemonFrame>) -> u32 {
    let frame = tokio::time::timeout(BOUND, frames.recv())
        .await
        .expect("the agent is asked")
        .unwrap();
    assert!(
        matches!(
            frame.t,
            Some(proto::daemon_frame::T::Req(proto::DaemonRequest {
                op: Some(Op::TemplatePublish(_))
            }))
        ),
        "{frame:?}"
    );
    frame.ch
}

fn guest(runner: &VmRunner, id: &str) -> Arc<channel::Guest> {
    runner.state.lock().unwrap().machines[id]
        .guest
        .clone()
        .unwrap()
}

fn marked(runner: &VmRunner, id: &str) -> bool {
    runner.state.lock().unwrap().machines[id]
        .publishing
        .is_some()
}

fn template(result: proto::CallResult) -> Answer<proto::Template> {
    match result.result.unwrap() {
        call_result::Result::Template(template) => Ok(template),
        call_result::Result::Error(error) => Err(error),
        other => panic!("{other:?}"),
    }
}

/// The machine as cubed and the disk see it: phase, epoch, record file.
fn snapshot(runner: &VmRunner, id: &str) -> (Phase, i64, i64, bool, Vec<u8>) {
    let state = runner.state.lock().unwrap();
    let entry = &state.machines[id];
    (
        entry.record.phase,
        entry.record.fence_epoch,
        entry.version,
        entry.guest.is_some(),
        std::fs::read(runner.machine_dir(id).join(record::RECORD)).unwrap(),
    )
}

#[tokio::test]
async fn other_machines_are_not_held_up_while_one_publishes() {
    let lab = Lab::new();
    let image = pull(lab.path(), 1, &[1]);
    let runner = lab.runner(image, 16 << 30, plenty).await;
    create(&runner, BUILD, base(), true).await.unwrap();
    create(&runner, USER, base(), false).await.unwrap();
    let mut frames = running(&runner, BUILD);
    let _user = running(&runner, USER);
    let publishing = publish(&runner, 1);
    let ch = asked(&mut frames).await;
    // The agent says nothing; machine B starts (a new policy for its
    // QEMU), stops, is deleted, and machine C is created, each at once.
    let other = |id: &str| Some(reference(id));
    call(
        &runner,
        Verb::MachineStart(proto::MachineStart {
            r#ref: other(USER),
            fence: fence(2),
            ..Default::default()
        }),
    )
    .await
    .unwrap();
    call(
        &runner,
        Verb::MachineStop(proto::MachineRef {
            r#ref: other(USER),
            fence: fence(2),
        }),
    )
    .await
    .unwrap();
    let third = "00000000000000c2";
    let dir = runner.machine_dir(third);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(qemu::RW_DISK), b"").unwrap();
    call(
        &runner,
        Verb::MachineCreate(proto::MachineCreate {
            r#ref: other(third),
            fence: fence(1),
            spec: Some(proto::MachineSpec {
                source: Some(base()),
                size: Some(proto::Size {
                    vcpus: 1,
                    memory_mib: 512,
                    disk_gib: 1,
                }),
                boot: None,
                build: false,
            }),
        }),
    )
    .await
    .unwrap();
    call(
        &runner,
        Verb::MachineDelete(proto::MachineDelete {
            r#ref: other(USER),
            fence: fence(2),
            retain: false,
        }),
    )
    .await
    .unwrap();
    assert!(!publishing.is_finished() && marked(&runner, BUILD));
    // Then the agent's done: `ops` again, and the template is kept.
    write_layer(&runner, BUILD, 2);
    guest(&runner, BUILD).answer(ch, Ok(AnswerKind::Done(proto::Empty {})));
    let kept = template(
        tokio::time::timeout(BOUND, publishing)
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(kept.id, BUILD);
    let state = runner.state.lock().unwrap();
    assert!(state.deleted.contains_key(BUILD) && state.deleted.contains_key(USER));
    assert!(state.machines.contains_key(third));
}

#[tokio::test]
async fn a_publishing_machine_refuses_its_own_mutations_at_once_and_is_unchanged() {
    let lab = Lab::new();
    let image = pull(lab.path(), 1, &[1]);
    let runner = lab.runner(image, 16 << 30, plenty).await;
    create(&runner, BUILD, base(), true).await.unwrap();
    let mut frames = running(&runner, BUILD);
    let first = publish(&runner, 1);
    let ch = asked(&mut frames).await;
    let before = snapshot(&runner, BUILD);
    // A newer epoch each time: none of them is taken.
    let me = || Some(reference(BUILD));
    let refusals = [
        Verb::MachineStart(proto::MachineStart {
            r#ref: me(),
            fence: fence(5),
            ..Default::default()
        }),
        Verb::MachineStop(proto::MachineRef {
            r#ref: me(),
            fence: fence(5),
        }),
        Verb::MachineDelete(proto::MachineDelete {
            r#ref: me(),
            fence: fence(5),
            retain: false,
        }),
        Verb::MachineDelete(proto::MachineDelete {
            r#ref: me(),
            fence: fence(5),
            retain: true,
        }),
        Verb::MachineDiscard(proto::MachineRef {
            r#ref: me(),
            fence: fence(5),
        }),
        Verb::MachineCreate(proto::MachineCreate {
            r#ref: me(),
            fence: fence(5),
            spec: Some(proto::MachineSpec {
                source: Some(base()),
                build: true,
                ..Default::default()
            }),
        }),
    ];
    for verb in refusals {
        let what = format!("{verb:?}");
        let refused = call(&runner, verb).await.unwrap_err();
        assert!(!refused.completion_unknown, "{what}");
        assert_eq!(
            reason(refused),
            (Code::FailedPrecondition, "publishing".into()),
            "{what}"
        );
        assert_eq!(snapshot(&runner, BUILD), before, "{what}");
    }
    // Another owner's call does not learn of the machine.
    let stranger = call(
        &runner,
        Verb::MachineStop(proto::MachineRef {
            r#ref: Some(proto::Ref {
                owner: "thread-2".into(),
                id: BUILD.into(),
            }),
            fence: fence(5),
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(stranger), (Code::NotFound, "machine".into()));
    // Reads still answer.
    call(
        &runner,
        Verb::MachineGet(proto::MachineRef {
            r#ref: me(),
            fence: None,
        }),
    )
    .await
    .unwrap();
    // The same publication again (cubed's 600 s ran out first): it waits
    // for the first, without `ops` and without asking the agent twice.
    let again = publish(&runner, 1);
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(!again.is_finished());
    assert!(frames.try_recv().is_err(), "the agent is asked once");
    call(&runner, Verb::MachineList(proto::Empty {}))
        .await
        .unwrap();
    // The first ends with the agent's refusal; the second asks anew.
    let busy = refuse(
        Code::FailedPrecondition,
        "busy",
        "commands are still running",
    );
    guest(&runner, BUILD).answer(ch, Ok(AnswerKind::Error(busy.clone())));
    let refused = template(first.await.unwrap()).unwrap_err();
    assert_eq!(refused, busy);
    let ch = asked(&mut frames).await;
    assert!(marked(&runner, BUILD));
    write_layer(&runner, BUILD, 2);
    guest(&runner, BUILD).answer(ch, Ok(AnswerKind::Done(proto::Empty {})));
    let kept = template(tokio::time::timeout(BOUND, again).await.unwrap().unwrap()).unwrap();
    assert_eq!(kept.id, BUILD);
    assert_eq!(runner.state.lock().unwrap().templates[BUILD].owner, OWNER);
}

#[tokio::test]
async fn the_runners_shutdown_does_not_wait_for_a_publication() {
    let lab = Lab::new();
    let image = pull(lab.path(), 1, &[1]);
    let runner = lab.runner(image, 16 << 30, plenty).await;
    create(&runner, BUILD, base(), true).await.unwrap();
    // The build machine runs, and its agent never answers.
    let mut frames = running(&runner, BUILD);
    let publishing = publish(&runner, 1);
    asked(&mut frames).await;
    let waiting = publish(&runner, 1);
    tokio::time::timeout(Duration::from_secs(10), runner.shutdown())
        .await
        .expect("the shutdown waits for no publication");
    for call in [publishing, waiting] {
        let stopped = template(call.await.unwrap()).unwrap_err();
        assert!(
            stopped.completion_unknown && stopped.reason == "runner_stopping",
            "{stopped:?}"
        );
    }
    assert!(runner.list_templates().items.is_empty());
    assert!(!marked(&runner, BUILD));
}

#[tokio::test]
async fn an_answer_the_runners_stop_overtook_keeps_nothing() {
    let lab = Lab::new();
    let image = pull(lab.path(), 1, &[1]);
    let runner = lab.runner(image, 16 << 30, plenty).await;
    create(&runner, BUILD, base(), true).await.unwrap();
    let mut frames = running(&runner, BUILD);
    let publishing = publish(&runner, 1);
    let ch = asked(&mut frames).await;
    // The shutdown holds `ops` when the agent's done comes; then it stops.
    let shutdown = runner.ops.lock().await;
    write_layer(&runner, BUILD, 2);
    guest(&runner, BUILD).answer(ch, Ok(AnswerKind::Done(proto::Empty {})));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!publishing.is_finished(), "it waits for `ops` to finish");
    runner.stopping.send_replace(true);
    drop(shutdown);
    let stopped = template(publishing.await.unwrap()).unwrap_err();
    assert!(
        stopped.completion_unknown && stopped.reason == "runner_stopping",
        "{stopped:?}"
    );
    assert!(runner.list_templates().items.is_empty());
    let state = runner.state.lock().unwrap();
    let entry = &state.machines[BUILD];
    assert!(entry.publishing.is_none());
    assert_eq!(entry.record.phase, Phase::Running, "the stop's to handle");
    assert!(runner.machine_dir(BUILD).join(template::DISK).is_file());
}

/// After any way out short of a template: no mark, the machine as it was,
/// and its own mutations go through again (B-8: the machine is cubed's to
/// publish again or delete).
async fn usable_again(
    runner: &Arc<VmRunner>,
    frames: &mut mpsc::UnboundedReceiver<proto::DaemonFrame>,
) {
    assert!(!marked(runner, BUILD));
    assert_eq!(snapshot(runner, BUILD).0, Phase::Running);
    let again = publish(runner, 1);
    asked(frames).await;
    again.abort();
    let _ = again.await;
    assert!(!marked(runner, BUILD), "a dropped call clears its mark");
    call(
        runner,
        Verb::MachineStop(proto::MachineRef {
            r#ref: Some(reference(BUILD)),
            fence: fence(1),
        }),
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn a_refused_or_lost_publication_leaves_the_machine_usable() {
    let lab = Lab::new();
    let image = pull(lab.path(), 1, &[1]);
    let runner = lab.runner(image, 16 << 30, plenty).await;
    let lost = channel::Answer::Err(proto::Error {
        completion_unknown: true,
        ..refuse(Code::Unavailable, "guest_disconnected", "the session ended")
    });
    let refused = channel::Answer::Ok(AnswerKind::Error(refuse(
        Code::FailedPrecondition,
        "seal_failed",
        "the layer did not check",
    )));
    for (n, answer, why) in [
        (1u8, refused, "seal_failed"),
        (2, lost, "guest_disconnected"),
    ] {
        let id = format!("00000000000000b{}", n + 1);
        create(&runner, &id, base(), true).await.unwrap();
        let mut frames = running(&runner, &id);
        let publishing = {
            let runner = Arc::clone(&runner);
            let ask = proto::TemplatePublish {
                from: Some(reference(&id)),
                ..ask(1)
            };
            tokio::spawn(async move {
                runner
                    .answer(proto::Call {
                        verb: Some(Verb::TemplatePublish(ask)),
                    })
                    .await
            })
        };
        let ch = asked(&mut frames).await;
        guest(&runner, &id).answer(ch, answer);
        let error = template(publishing.await.unwrap()).unwrap_err();
        assert_eq!(error.reason, why);
        assert!(
            runner.state.lock().unwrap().machines[&id]
                .publishing
                .is_none()
        );
    }
    // No agent session: nothing was sent, and no mark is left.
    create(&runner, BUILD, base(), true).await.unwrap();
    running(&runner, BUILD);
    {
        let mut state = runner.state.lock().unwrap();
        state.machines.get_mut(BUILD).unwrap().guest =
            Some(channel::Guest::with_seen(Default::default()).0);
    }
    let error = template(publish(&runner, 1).await.unwrap()).unwrap_err();
    assert_eq!(error.reason, "not_connected");
    assert!(!marked(&runner, BUILD));
    let (connected, mut frames) = channel::Guest::connected("s2");
    runner
        .state
        .lock()
        .unwrap()
        .machines
        .get_mut(BUILD)
        .unwrap()
        .guest = Some(connected);
    usable_again(&runner, &mut frames).await;
}

#[tokio::test(start_paused = true)]
async fn a_publication_that_times_out_clears_its_mark() {
    let lab = Lab::new();
    let image = pull(lab.path(), 1, &[1]);
    let runner = lab.runner(image, 16 << 30, plenty).await;
    create(&runner, BUILD, base(), true).await.unwrap();
    let mut frames = running(&runner, BUILD);
    let publishing = publish(&runner, 1);
    asked(&mut frames).await;
    // Paused time: idle, it runs to the publication's 600 s.
    let late = template(publishing.await.unwrap()).unwrap_err();
    assert!(
        late.completion_unknown && late.reason == "publish_timeout",
        "{late:?}"
    );
    usable_again(&runner, &mut frames).await;
}

/// runner.proto has `machine_suspend` (S-7a); this berth does not suspend
/// yet: it says so, sends the agent nothing and leaves the machine running.
#[tokio::test]
async fn machine_suspend_is_unimplemented_and_changes_nothing() {
    let lab = Lab::new();
    let image = pull(lab.path(), 1, &[1]);
    let runner = lab.runner(image, 16 << 30, plenty).await;
    create(&runner, BUILD, base(), true).await.unwrap();
    let mut frames = running(&runner, BUILD);
    let before = snapshot(&runner, BUILD);
    let error = call(
        &runner,
        Verb::MachineSuspend(proto::MachineRef {
            r#ref: Some(reference(BUILD)),
            fence: fence(5),
        }),
    )
    .await
    .unwrap_err();
    assert_eq!(reason(error), (Code::Unimplemented, "suspend".to_string()));
    assert!(frames.try_recv().is_err(), "the agent was sent nothing");
    assert_eq!(snapshot(&runner, BUILD), before);
}
