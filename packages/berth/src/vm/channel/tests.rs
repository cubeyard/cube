//! The runner's end of the channel against a stand-in agent on a real Unix
//! socket, with QMP's port events fed by hand and short deadlines.
use super::*;
use cube_runner_protocol::read_frame;
use tokio::net::UnixListener;

const FAST: Timing = Timing {
    plain_hello: Duration::from_millis(150),
    reset_hello: Duration::from_millis(400),
    open_at_boot: Duration::from_millis(600),
    open_after_close: Duration::from_millis(600),
};

#[derive(Default)]
struct Recorder {
    infos: Mutex<Vec<proto::GuestInfo>>,
    events: Mutex<Vec<String>>,
    setups: Mutex<u32>,
}

impl Host for Recorder {
    fn setup(&self) -> proto::MachineSetup {
        *self.setups.lock().unwrap() += 1;
        proto::MachineSetup {
            entropy: vec![7; 32],
            protocol: 4,
            ..Default::default()
        }
    }
    fn publish(&self, info: proto::GuestInfo) {
        self.infos.lock().unwrap().push(info);
    }
    fn event(&self, what: &str, detail: &str) {
        self.events
            .lock()
            .unwrap()
            .push(format!("{what}: {detail}"));
    }
}

impl Recorder {
    fn last(&self) -> proto::GuestInfo {
        self.infos.lock().unwrap().last().cloned().unwrap()
    }
    fn saw(&self, needle: &str) -> bool {
        self.events
            .lock()
            .unwrap()
            .iter()
            .any(|e| e.contains(needle))
    }
}

struct Lab {
    _dir: tempfile::TempDir,
    listener: UnixListener,
    ports: mpsc::UnboundedSender<bool>,
    guest: Arc<Guest>,
    host: Arc<Recorder>,
    exit: watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

fn lab() -> Lab {
    lab_with(HashSet::new())
}

/// A lab whose machine's agent used `seen` in earlier QEMUs.
fn lab_with(seen: HashSet<String>) -> Lab {
    let dir = tempfile::tempdir().unwrap();
    let ctl = dir.path().join("ctl.sock");
    let listener = UnixListener::bind(&ctl).unwrap();
    let (ports, port_events) = mpsc::unbounded_channel();
    let (guest, frames) = Guest::with_seen(seen);
    let host = Arc::new(Recorder::default());
    let (exit, exited) = watch::channel(false);
    let task = tokio::spawn(run(
        Arc::clone(&guest),
        frames,
        ctl,
        port_events,
        host.clone(),
        FAST,
        exited,
    ));
    Lab {
        _dir: dir,
        listener,
        ports,
        guest,
        host,
        exit,
        task,
    }
}

/// The stand-in agent's end of one connection.
struct Agent {
    stream: UnixStream,
}

const S1: &str = "11111111111111111111111111111111";
const S2: &str = "22222222222222222222222222222222";

impl Agent {
    async fn accept(listener: &UnixListener) -> Self {
        let (stream, _) = tokio::time::timeout(Duration::from_secs(5), listener.accept())
            .await
            .expect("the runner connects")
            .unwrap();
        Self { stream }
    }
    async fn send(&mut self, ch: u32, t: T, session: &str) {
        write_frame(
            &mut self.stream,
            &proto::DaemonFrame {
                ch,
                t: Some(t),
                session: session.into(),
            },
        )
        .await
        .unwrap();
    }
    async fn hello(&mut self, session: &str) {
        let info = proto::GuestInfo {
            connected: true,
            reason: "waiting for machine_setup".into(),
            session: session.into(),
            ..Default::default()
        };
        self.send(0, T::Hello(info), session).await;
    }
    /// The next frame from the runner, within `wait`.
    async fn next(&mut self, wait: Duration) -> Option<proto::DaemonFrame> {
        tokio::time::timeout(wait, read_frame::<proto::DaemonFrame>(&mut self.stream))
            .await
            .ok()
            .map(|frame| frame.unwrap())
    }
    /// After a `hello`: the runner's `machine_setup` on a channel above 0.
    async fn setup(&mut self, session: &str) -> u32 {
        let frame = self
            .next(Duration::from_secs(2))
            .await
            .expect("machine_setup");
        assert!(
            matches!(&frame.t, Some(T::Req(proto::DaemonRequest { op: Some(Op::MachineSetup(s)) })) if s.entropy.len() >= 32),
            "{frame:?}"
        );
        assert!(frame.ch > 0 && frame.session == session, "{frame:?}");
        frame.ch
    }
}

fn is_reset(frame: &proto::DaemonFrame) -> bool {
    frame.ch == 0
        && frame.session.is_empty()
        && matches!(&frame.t, Some(T::Req(proto::DaemonRequest { op: Some(Op::Guest(g)) })) if g.op == "hello")
}

fn guest_op() -> Op {
    Op::Guest(proto::GuestRequest {
        op: "hello".into(),
        data: b"{}\n".to_vec(),
    })
}

#[tokio::test]
async fn at_boot_the_runner_waits_for_the_port_then_takes_the_hello_and_sends_its_setup() {
    let mut lab = lab();
    let mut agent = Agent::accept(&lab.listener).await;
    // The port is closed: nothing is sent, however long the boot takes
    // (within its deadline).
    assert!(
        agent.next(Duration::from_millis(400)).await.is_none(),
        "nothing before the port opens"
    );
    assert!(!lab.host.last().connected);
    lab.ports.send(true).unwrap();
    agent.hello(S1).await;
    let ch = agent.setup(S1).await;
    let info = lab.host.last();
    assert!(info.connected && info.session == S1, "{info:?}");
    assert_eq!(lab.guest.session().as_deref(), Some(S1));
    // The setup's answer and the status after it.
    agent
        .send(
            ch,
            T::Ans(proto::DaemonAnswer {
                result: Some(AnswerKind::Done(proto::Empty {})),
            }),
            S1,
        )
        .await;
    let ready = proto::GuestInfo {
        connected: true,
        ready: true,
        session: S1.into(),
        ..Default::default()
    };
    agent.send(0, T::Status(ready), S1).await;
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(lab.host.last().ready);
    assert!(lab.host.saw("machine_setup: done"));
    lab.exit.send(true).unwrap();
    (&mut lab.task).await.unwrap();
}

#[tokio::test]
async fn no_hello_after_the_port_opens_brings_one_reset_then_unhealthy() {
    let lab = lab();
    let mut agent = Agent::accept(&lab.listener).await;
    lab.ports.send(true).unwrap();
    let t = std::time::Instant::now();
    let reset = agent.next(Duration::from_secs(2)).await.expect("the reset");
    assert!(is_reset(&reset), "{reset:?}");
    assert!(
        t.elapsed() >= FAST.plain_hello,
        "not before the plain hello's time"
    );
    // No second reset: after RESET_HELLO the machine is unhealthy.
    assert!(
        agent.next(Duration::from_millis(800)).await.is_none(),
        "one reset only"
    );
    let info = lab.host.last();
    assert!(
        !info.connected && info.reason.contains("unhealthy"),
        "{info:?}"
    );
    // A late hello still starts a session.
    agent.hello(S1).await;
    agent.setup(S1).await;
    assert!(lab.host.last().connected);
}

#[tokio::test]
async fn a_hello_after_the_reset_starts_the_session() {
    let lab = lab();
    let mut agent = Agent::accept(&lab.listener).await;
    lab.ports.send(true).unwrap();
    assert!(is_reset(&agent.next(Duration::from_secs(2)).await.unwrap()));
    // The agent ends its connection: the port closes and opens again.
    lab.ports.send(false).unwrap();
    lab.ports.send(true).unwrap();
    agent.hello(S1).await;
    agent.setup(S1).await;
    assert!(
        lab.host
            .saw("no hello after the connect; the reset on channel 0")
    );
    assert!(!lab.host.saw("unhealthy"));
}

#[tokio::test]
async fn a_port_that_never_opens_is_not_trusted_the_reset_goes_anyway() {
    let lab = lab();
    let mut agent = Agent::accept(&lab.listener).await;
    let reset = agent
        .next(Duration::from_secs(2))
        .await
        .expect("the reset after the open deadline");
    assert!(is_reset(&reset), "{reset:?}");
    assert!(
        lab.host
            .saw("QMP did not say the agent opened cube.0 in time")
    );
    agent.hello(S1).await;
    agent.setup(S1).await;
}

#[tokio::test]
async fn a_repeated_session_is_refused_and_a_new_one_taken() {
    let lab = lab();
    let mut agent = Agent::accept(&lab.listener).await;
    lab.ports.send(true).unwrap();
    agent.hello(S1).await;
    agent.setup(S1).await;
    // A restored machine says hello with the session it had at the save.
    agent.hello(S1).await;
    let reset = agent.next(Duration::from_secs(2)).await.unwrap();
    assert!(
        is_reset(&reset),
        "a repeated session is answered with the reset: {reset:?}"
    );
    assert_eq!(lab.guest.session(), None, "and the old session ended");
    assert!(lab.host.saw("which it used before"));
    agent.hello(S2).await;
    agent.setup(S2).await;
    assert_eq!(lab.guest.session().as_deref(), Some(S2));
    // An invalid session is refused the same way.
    agent.hello("not-a-session").await;
    assert!(is_reset(&agent.next(Duration::from_secs(2)).await.unwrap()));
}

#[tokio::test]
async fn answers_belong_to_their_session_and_a_new_hello_ends_the_old_channels() {
    let lab = lab();
    let mut agent = Agent::accept(&lab.listener).await;
    lab.ports.send(true).unwrap();
    agent.hello(S1).await;
    agent.setup(S1).await;
    let (ch, answer) = lab.guest.request(guest_op()).unwrap();
    let sent = agent.next(Duration::from_secs(2)).await.unwrap();
    assert_eq!((sent.ch, sent.session.as_str()), (ch, S1));
    // An answer for this channel from another session is not this one's.
    agent
        .send(
            ch,
            T::Ans(proto::DaemonAnswer {
                result: Some(AnswerKind::Guest(b"old".to_vec())),
            }),
            S2,
        )
        .await;
    agent
        .send(
            ch,
            T::Ans(proto::DaemonAnswer {
                result: Some(AnswerKind::Guest(b"new".to_vec())),
            }),
            S1,
        )
        .await;
    let got = tokio::time::timeout(Duration::from_secs(2), answer)
        .await
        .unwrap()
        .unwrap();
    assert!(
        matches!(got, Ok(AnswerKind::Guest(ref b)) if b == b"new"),
        "{got:?}"
    );
    assert_eq!(lab.guest.inner.lock().unwrap().foreign, 1);
    // A request still waiting when the agent starts a new session.
    let (_, waiting) = lab.guest.request(guest_op()).unwrap();
    agent.next(Duration::from_secs(2)).await.unwrap();
    agent.hello(S2).await;
    let lost = tokio::time::timeout(Duration::from_secs(2), waiting)
        .await
        .unwrap()
        .unwrap();
    let error = lost.unwrap_err();
    assert!(
        error.code == Code::Unavailable as i32 && error.completion_unknown,
        "{error:?}"
    );
    let ch2 = agent.setup(S2).await;
    assert!(ch2 > ch, "channels are never reused");
}

#[tokio::test]
async fn an_abort_goes_to_the_agent_and_its_answer_is_dropped() {
    let lab = lab();
    let mut agent = Agent::accept(&lab.listener).await;
    lab.ports.send(true).unwrap();
    agent.hello(S1).await;
    agent.setup(S1).await;
    let (ch, answer) = lab.guest.request(guest_op()).unwrap();
    agent.next(Duration::from_secs(2)).await.unwrap();
    lab.guest.abort(ch);
    let abort = agent.next(Duration::from_secs(2)).await.unwrap();
    assert!(
        matches!(abort.t, Some(T::Abort(_))) && abort.ch == ch && abort.session == S1,
        "{abort:?}"
    );
    assert!(answer.await.is_err(), "nobody waits any more");
}

#[tokio::test]
async fn the_port_closing_ends_the_session_and_its_channels() {
    let lab = lab();
    let mut agent = Agent::accept(&lab.listener).await;
    lab.ports.send(true).unwrap();
    agent.hello(S1).await;
    agent.setup(S1).await;
    let (_, waiting) = lab.guest.request(guest_op()).unwrap();
    agent
        .next(Duration::from_secs(2))
        .await
        .expect("the request");
    lab.ports.send(false).unwrap();
    let lost = tokio::time::timeout(Duration::from_secs(2), waiting)
        .await
        .unwrap()
        .unwrap();
    assert!(lost.unwrap_err().completion_unknown);
    assert!(!lab.host.last().connected);
    assert!(
        lab.guest.request(guest_op()).is_err(),
        "no session, no requests"
    );
    // The agent starts again: the port opens, hello within the plain time.
    lab.ports.send(true).unwrap();
    agent.hello(S2).await;
    agent.setup(S2).await;
}

#[tokio::test]
async fn a_frame_that_breaks_the_rules_ends_the_socket_and_the_runner_connects_again() {
    let lab = lab();
    let mut agent = Agent::accept(&lab.listener).await;
    lab.ports.send(true).unwrap();
    agent.hello(S1).await;
    agent.setup(S1).await;
    // Only the runner sends requests.
    agent
        .send(
            5,
            T::Req(proto::DaemonRequest {
                op: Some(guest_op()),
            }),
            S1,
        )
        .await;
    let mut again = Agent::accept(&lab.listener).await;
    assert!(lab.host.saw("broke the channel rules"));
    assert_eq!(lab.guest.session(), None);
    // The port is open: the plain hello's deadline applies at once.
    again.hello(S2).await;
    again.setup(S2).await;
}

#[tokio::test]
async fn a_session_from_an_earlier_qemu_of_the_machine_is_refused() {
    // A restore is a new QEMU and a new channel; the runner still knows
    // what the machine's agent used before (the save's session).
    let lab = lab_with(HashSet::from([S1.to_string()]));
    let mut agent = Agent::accept(&lab.listener).await;
    lab.ports.send(true).unwrap();
    agent.hello(S1).await;
    let reset = agent.next(Duration::from_secs(2)).await.unwrap();
    assert!(is_reset(&reset), "{reset:?}");
    assert!(lab.host.saw("which it used before"));
    agent.hello(S2).await;
    agent.setup(S2).await;
    assert!(lab.guest.seen().contains(S1) && lab.guest.seen().contains(S2));
}

/// S-7a's save: the runner leaves (the socket closes, nothing connects
/// again), learns from a port change after the close that the agent saw it,
/// and after a failed save rejoins: a new `hello` gets `machine_setup`
/// again (K-3).
#[tokio::test]
async fn a_leave_holds_the_channel_until_rejoin_and_the_next_hello_gets_its_setup() {
    let lab = lab();
    let mut agent = Agent::accept(&lab.listener).await;
    lab.ports.send(true).unwrap();
    agent.hello(S1).await;
    agent.setup(S1).await;
    assert_eq!(*lab.host.setups.lock().unwrap(), 1);

    let mut seen = lab.guest.leave();
    let eof = tokio::time::timeout(
        Duration::from_secs(2),
        read_frame::<proto::DaemonFrame>(&mut agent.stream),
    )
    .await
    .expect("the runner closes its end");
    assert!(eof.is_err(), "the socket ended: {eof:?}");
    // A change from before the close does not count.
    lab.guest.port_changed(0.0);
    assert!(seen.try_recv().is_err(), "an old port change is no answer");
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        lab.guest.port_changed(wall_clock() + 1.0);
        match seen.try_recv() {
            Ok(()) => break,
            Err(_) if Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(10)).await
            }
            Err(error) => panic!("the leave was never answered: {error:?}"),
        }
    }
    assert!(
        lab.guest.session().is_none(),
        "the session ended with the leave"
    );
    assert!(
        lab.guest.request(guest_op()).is_err(),
        "nothing is sent while the runner is away"
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(400), lab.listener.accept())
            .await
            .is_err(),
        "no connect while held"
    );

    lab.guest.rejoin();
    let mut agent = Agent::accept(&lab.listener).await;
    agent.hello(S2).await;
    agent.setup(S2).await;
    assert_eq!(*lab.host.setups.lock().unwrap(), 2, "machine_setup again");
    assert!(lab.host.saw("the runner left cube.0 to save the machine"));
    assert!(lab.host.saw("the runner connects to cube.0 again"));
    lab.exit.send(true).unwrap();
    lab.task.await.unwrap();
}
