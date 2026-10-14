//! The runner's end of one machine's guest channel, `cube.0` on `ctl.sock`
//! (runner.proto's header, "The guest channel"; masterplan B-2).
//!
//! ```text
//! QMP VSERPORT_CHANGE ──► port open/closed ─┐
//! ctl.sock ──► DaemonFrames ────────────────┼─► the connect rule ─► session
//! guest streams ──► request/abort ──────────┘        │
//!                                                     ├─► machine_setup after every hello
//!                                                     └─► status.guest (Host::publish)
//! ```
//!
//! The connect rule: while the agent has the port closed (the machine
//! boots, the agent starts again) the runner waits for QMP to say it opened
//! it, at most OPEN_AT_BOOT or OPEN_AFTER_CLOSE; then `hello` within
//! PLAIN_HELLO; without one, one reset (a `req` on channel 0 with no
//! session) and `hello` within RESET_HELLO; a second miss marks the machine
//! unhealthy (it stays so until a `hello` or the port opens again). A
//! deadline for the port that passes is not trusted either way: the reset
//! goes as if it had opened. The port event is never taken as a `hello`.
//!
//! A `hello` starts a session: its session must be new for this machine,
//! every channel of the session before is closed (`UNAVAILABLE`, completion
//! unknown: cubed asks again by key), `machine_setup` goes on a fresh
//! channel, and `status.guest` follows what the agent says. Frames of
//! another session are dropped. A frame that breaks the channel rules ends
//! the socket; the runner connects again (the agent sees the disconnect and
//! says `hello`).
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};

use cube_runner_protocol::{
    proto::{self, Code, daemon_answer::Result as AnswerKind, daemon_frame::T, daemon_request::Op},
    read_daemon_frame, refuse, valid_session, write_frame,
};
use tokio::{
    io::BufReader,
    net::{UnixStream, unix::OwnedWriteHalf},
    sync::{mpsc, oneshot, watch},
    time::Instant,
};

/// The connect rule's deadlines (runner.proto's header).
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// `hello` after the port is open (or after a connect to an open port).
    pub plain_hello: Duration,
    /// `hello` after the reset on channel 0.
    pub reset_hello: Duration,
    /// The agent opens the port after the machine starts.
    pub open_at_boot: Duration,
    /// The agent opens the port again after it closed it (cube-init starts
    /// a crashed agent again within 5 s).
    pub open_after_close: Duration,
}

pub const TIMING: Timing = Timing {
    plain_hello: Duration::from_millis(500),
    reset_hello: Duration::from_secs(2),
    open_at_boot: Duration::from_secs(120),
    open_after_close: Duration::from_secs(30),
};

/// What the channel needs from the runner for its machine.
pub trait Host: Send + Sync + 'static {
    /// The machine's setup, with fresh entropy each time.
    fn setup(&self) -> proto::MachineSetup;
    /// The guest's status changed (`status.guest`).
    fn publish(&self, info: proto::GuestInfo);
    /// One line of the machine's `events.log`.
    fn event(&self, what: &str, detail: &str);
}

/// A guest operation's outcome: the agent's answer, or why there is none.
pub type Answer = Result<AnswerKind, proto::Error>;

#[derive(Default)]
struct Inner {
    /// The current session, from the newest accepted `hello`.
    session: Option<String>,
    /// Every session this machine's agent has started under this runner.
    seen: HashSet<String>,
    /// Channels waiting for an answer, in the current session.
    pending: HashMap<u32, oneshot::Sender<Answer>>,
    /// The next channel; never reused while the runner runs.
    next: u32,
    /// The channel of the newest `machine_setup`.
    setup: Option<u32>,
    /// Frames of another session that came from the agent.
    foreign: u64,
}

/// One machine's channel, shared by its task and the guest streams.
pub struct Guest {
    inner: Mutex<Inner>,
    queue: mpsc::UnboundedSender<proto::DaemonFrame>,
}

fn ended(message: &str) -> proto::Error {
    proto::Error {
        completion_unknown: true,
        ..refuse(Code::Unavailable, "guest_disconnected", message)
    }
}

impl Guest {
    /// A channel and its outgoing queue, which [`run`] takes, for a machine
    /// whose agent used `seen` before (in an earlier QEMU of the same
    /// machine: a boot or a restore).
    pub fn with_seen(
        seen: HashSet<String>,
    ) -> (Arc<Self>, mpsc::UnboundedReceiver<proto::DaemonFrame>) {
        let (queue, frames) = mpsc::unbounded_channel();
        (
            Arc::new(Self {
                inner: Mutex::new(Inner {
                    next: 1,
                    seen,
                    ..Default::default()
                }),
                queue,
            }),
            frames,
        )
    }

    /// Every session this machine's agent has used under this runner.
    pub fn seen(&self) -> HashSet<String> {
        self.inner.lock().unwrap().seen.clone()
    }

    /// A channel whose agent said `hello` in `session` (tests).
    #[cfg(test)]
    pub fn connected(session: &str) -> (Arc<Self>, mpsc::UnboundedReceiver<proto::DaemonFrame>) {
        let (guest, frames) = Self::with_seen(HashSet::new());
        guest.inner.lock().unwrap().session = Some(session.into());
        (guest, frames)
    }

    /// The current session, if the agent said `hello`.
    #[cfg(test)]
    pub fn session(&self) -> Option<String> {
        self.inner.lock().unwrap().session.clone()
    }

    /// Sends `op` on a fresh channel of the current session; the answer
    /// comes on the receiver (or why it will not).
    pub fn request(&self, op: Op) -> Result<(u32, oneshot::Receiver<Answer>), proto::Error> {
        let mut inner = self.inner.lock().unwrap();
        let Some(session) = inner.session.clone() else {
            return Err(refuse(
                Code::Unavailable,
                "not_connected",
                "the machine's agent has not said hello on its channel",
            ));
        };
        let ch = inner.next;
        inner.next += 1;
        let (sender, receiver) = oneshot::channel();
        inner.pending.insert(ch, sender);
        let _ = self.queue.send(proto::DaemonFrame {
            ch,
            t: Some(T::Req(proto::DaemonRequest { op: Some(op) })),
            session,
        });
        Ok((ch, receiver))
    }

    /// Stops waiting on `ch` (its stream went away): `abort` to the agent,
    /// which lets the operation finish and drops its answer.
    pub fn abort(&self, ch: u32) {
        let mut inner = self.inner.lock().unwrap();
        if inner.pending.remove(&ch).is_some()
            && let Some(session) = inner.session.clone()
        {
            let _ = self.queue.send(proto::DaemonFrame {
                ch,
                t: Some(T::Abort(proto::Empty {})),
                session,
            });
        }
    }

    /// Ends the current session: every waiting channel is answered `why`.
    fn end_session(&self, why: &str) -> bool {
        let mut inner = self.inner.lock().unwrap();
        inner.setup = None;
        for (_, waiting) in inner.pending.drain() {
            let _ = waiting.send(Err(ended(why)));
        }
        inner.session.take().is_some()
    }
}

/// Where the connect rule stands.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Wait {
    /// For QMP to say the agent opened the port.
    Open(Instant),
    /// For `hello`; `true` after the reset.
    Hello(Instant, bool),
    /// A session is live.
    Live,
    /// Two misses: nothing more is sent until the port opens again or a
    /// `hello` comes.
    Unhealthy,
}

impl Wait {
    fn deadline(self) -> Option<Instant> {
        match self {
            Self::Open(at) | Self::Hello(at, _) => Some(at),
            Self::Live | Self::Unhealthy => None,
        }
    }
}

fn not_connected(reason: impl Into<String>) -> proto::GuestInfo {
    proto::GuestInfo {
        connected: false,
        ready: false,
        reason: reason.into(),
        ..Default::default()
    }
}

/// The reset on channel 0: a `req` there breaks the channel rules, so the
/// agent ends its connection, opens the port again and says `hello`.
fn reset_frame() -> proto::DaemonFrame {
    proto::DaemonFrame {
        ch: 0,
        t: Some(T::Req(proto::DaemonRequest {
            op: Some(Op::Guest(proto::GuestRequest {
                op: "hello".into(),
                data: Vec::new(),
            })),
        })),
        session: String::new(),
    }
}

enum Read {
    Frame(Box<proto::DaemonFrame>),
    /// The socket ended: None at EOF, else the rule the agent broke.
    End(Option<String>),
}

/// Serves the machine's channel until its QEMU exits (`exited` turns true):
/// connects to `ctl` (again after a broken connection), follows `ports`
/// (VSERPORT_CHANGE's `open`) and keeps the connect rule.
pub async fn run(
    guest: Arc<Guest>,
    mut frames: mpsc::UnboundedReceiver<proto::DaemonFrame>,
    ctl: PathBuf,
    mut ports: mpsc::UnboundedReceiver<bool>,
    host: Arc<dyn Host>,
    timing: Timing,
    mut exited: watch::Receiver<bool>,
) {
    let mut port_open = false;
    let mut ports_closed = false;
    let mut backoff = Duration::from_millis(100);
    let mut first = true;
    host.publish(not_connected(
        "the machine boots; its agent has not opened cube.0 yet",
    ));
    'socket: loop {
        if *exited.borrow() {
            break;
        }
        let stream = loop {
            match UnixStream::connect(&ctl).await {
                Ok(stream) => break stream,
                Err(_) => {
                    tokio::select! {
                        _ = stopped(&mut exited) => break 'socket,
                        _ = tokio::time::sleep(Duration::from_millis(20)) => {}
                    }
                }
            }
        };
        let (read, mut write) = stream.into_split();
        let (reads, mut incoming) = mpsc::unbounded_channel();
        let reader = tokio::spawn(async move {
            let mut read = BufReader::new(read);
            loop {
                match read_daemon_frame(&mut read).await {
                    Ok(frame) => {
                        if reads.send(Read::Frame(Box::new(frame))).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        let eof = error
                            .downcast_ref::<std::io::Error>()
                            .is_some_and(|e| e.kind() == std::io::ErrorKind::UnexpectedEof);
                        let _ = reads.send(Read::End((!eof).then(|| error.to_string())));
                        return;
                    }
                }
            }
        });
        let now = Instant::now();
        let mut wait = if port_open {
            Wait::Hello(now + timing.plain_hello, false)
        } else if first {
            Wait::Open(now + timing.open_at_boot)
        } else {
            Wait::Open(now + timing.open_after_close)
        };
        first = false;
        let broken: Option<String> = loop {
            let deadline = wait.deadline();
            tokio::select! {
                _ = stopped(&mut exited) => {
                    reader.abort();
                    break 'socket;
                }
                port = ports.recv(), if !ports_closed => match port {
                    None => ports_closed = true, // QMP went away: QEMU exits
                    Some(true) => {
                        port_open = true;
                        host.event("port", "the agent opened cube.0 (QMP VSERPORT_CHANGE)");
                        match wait {
                            Wait::Open(_) | Wait::Unhealthy => {
                                wait = Wait::Hello(Instant::now() + timing.plain_hello, false);
                            }
                            // After the reset the agent closes and opens the
                            // port; the reset's deadline stands.
                            Wait::Hello(..) | Wait::Live => {}
                        }
                    }
                    Some(false) => {
                        port_open = false;
                        host.event("port", "the agent closed cube.0 (QMP VSERPORT_CHANGE)");
                        if guest.end_session("the machine's agent closed its channel") {
                            host.event("channel", "the agent closed cube.0; the session ended");
                            host.publish(not_connected("the agent closed cube.0; waiting for it to open it again"));
                        }
                        match wait {
                            Wait::Hello(_, true) => {}
                            _ => wait = Wait::Open(Instant::now() + timing.open_after_close),
                        }
                    }
                },
                _ = sleep_until(deadline) => {
                    match wait {
                        Wait::Open(_) | Wait::Hello(_, false) => {
                            let why = if matches!(wait, Wait::Open(_)) {
                                "QMP did not say the agent opened cube.0 in time"
                            } else {
                                "no hello after the connect"
                            };
                            host.event("channel", &format!("{why}; the reset on channel 0"));
                            if write_frame(&mut write, &reset_frame()).await.is_err() {
                                break None;
                            }
                            wait = Wait::Hello(Instant::now() + timing.reset_hello, true);
                        }
                        Wait::Hello(_, true) => {
                            let why = "no hello after the reset on channel 0: the machine is unhealthy";
                            host.event("channel", why);
                            host.publish(not_connected(why));
                            wait = Wait::Unhealthy;
                        }
                        Wait::Live | Wait::Unhealthy => {}
                    }
                }
                frame = frames.recv() => {
                    let Some(frame) = frame else { break None };
                    // Only the current session's frames go out; one made for
                    // an older session is dropped (its channel was answered).
                    let current = guest.inner.lock().unwrap().session.clone();
                    let live = wait == Wait::Live && current.as_deref() == Some(frame.session.as_str());
                    if live && matches!(frame.t, Some(T::Abort(_))) {
                        host.event("abort", &format!("channel {}: cubed stopped waiting", frame.ch));
                    }
                    if live && write_frame(&mut write, &frame).await.is_err() {
                        break None;
                    }
                }
                read = incoming.recv() => match read {
                    None | Some(Read::End(None)) => break None,
                    Some(Read::End(Some(rule))) => break Some(rule),
                    Some(Read::Frame(frame)) => {
                        match accept(&guest, &*host, &mut write, *frame, &mut wait, timing).await {
                            Ok(()) => {}
                            Err(rule) => break Some(rule),
                        }
                    }
                },
            }
        };
        reader.abort();
        drop(write);
        if guest.end_session("the machine's channel was connected again") {
            host.publish(not_connected("connecting to the agent again"));
        }
        match broken {
            Some(rule) => {
                host.event(
                    "channel",
                    &format!("the agent broke the channel rules ({rule}); connecting again"),
                );
                tokio::select! {
                    _ = stopped(&mut exited) => break,
                    _ = tokio::time::sleep(backoff) => {}
                }
                backoff = (backoff * 2).min(Duration::from_secs(5));
            }
            // EOF: QEMU closed the socket (it exits), or the write failed.
            None => {
                tokio::select! {
                    _ = stopped(&mut exited) => break,
                    _ = tokio::time::sleep(Duration::from_millis(200)) => {}
                }
            }
        }
    }
    guest.end_session("the machine stopped");
}

/// Until the machine's QEMU has exited.
async fn stopped(exited: &mut watch::Receiver<bool>) {
    let _ = exited.wait_for(|e| *e).await;
}

async fn sleep_until(deadline: Option<Instant>) {
    match deadline {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

/// One frame from the agent. Err ends the socket.
async fn accept(
    guest: &Guest,
    host: &dyn Host,
    write: &mut OwnedWriteHalf,
    frame: proto::DaemonFrame,
    wait: &mut Wait,
    timing: Timing,
) -> Result<(), String> {
    match frame.t {
        Some(T::Hello(mut info)) => {
            let session = frame.session;
            let repeated = guest.inner.lock().unwrap().seen.contains(&session);
            if !valid_session(&session) || repeated {
                let why = if repeated {
                    format!("the agent said hello with session {session}, which it used before")
                } else {
                    format!("the agent said hello without a valid session ({session:?})")
                };
                host.event("channel", &why);
                if guest.end_session(&why) {
                    host.publish(not_connected(why.clone()));
                }
                // As a missed hello: the reset asks for a new one, once.
                if matches!(*wait, Wait::Hello(_, true)) {
                    host.publish(not_connected(format!("{why}: the machine is unhealthy")));
                    *wait = Wait::Unhealthy;
                } else {
                    write_frame(write, &reset_frame())
                        .await
                        .map_err(|e| e.to_string())?;
                    *wait = Wait::Hello(Instant::now() + timing.reset_hello, true);
                }
                return Ok(());
            }
            let had = guest.end_session("the machine's agent started a new session");
            let setup = host.setup();
            let ch = {
                let mut inner = guest.inner.lock().unwrap();
                inner.seen.insert(session.clone());
                inner.session = Some(session.clone());
                let ch = inner.next;
                inner.next += 1;
                inner.setup = Some(ch);
                ch
            };
            host.event(
                "hello",
                &format!(
                    "session {session}{}; machine_setup on channel {ch}",
                    if had { " (the previous one ended)" } else { "" }
                ),
            );
            info.session = session.clone();
            host.publish(info);
            *wait = Wait::Live;
            write_frame(
                write,
                &proto::DaemonFrame {
                    ch,
                    t: Some(T::Req(proto::DaemonRequest {
                        op: Some(Op::MachineSetup(setup)),
                    })),
                    session,
                },
            )
            .await
            .map_err(|e| e.to_string())
        }
        t @ (Some(T::Status(_)) | Some(T::Ans(_))) => {
            let mut inner = guest.inner.lock().unwrap();
            if inner.session.as_deref() != Some(frame.session.as_str()) {
                // On its way before the session changed: not this session's.
                inner.foreign += 1;
                return Ok(());
            }
            match t {
                Some(T::Status(mut info)) => {
                    drop(inner);
                    info.session = frame.session;
                    host.publish(info);
                }
                Some(T::Ans(answer)) => {
                    let result = answer.result.ok_or("an answer of no kind")?;
                    if inner.setup == Some(frame.ch) {
                        inner.setup = None;
                        drop(inner);
                        match &result {
                            AnswerKind::Done(_) => host.event("machine_setup", "done"),
                            AnswerKind::Error(error) => host.event(
                                "machine_setup",
                                &format!("refused: {} {}", error.reason, error.message),
                            ),
                            AnswerKind::Guest(_) => {
                                host.event("machine_setup", "answered as a guest operation")
                            }
                        }
                    } else if let Some(waiting) = inner.pending.remove(&frame.ch) {
                        let _ = waiting.send(Ok(result));
                    }
                    // Else: aborted, or never asked: dropped.
                }
                _ => unreachable!(),
            }
            Ok(())
        }
        _ => Err("the agent sent a frame only the runner sends".into()),
    }
}

#[cfg(test)]
mod tests;
