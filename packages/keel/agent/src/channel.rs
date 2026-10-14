//! The guest channel: `DaemonFrame`s on the virtio-serial port named
//! `cube.0` (runner.proto's header). Channel 0 carries the agent's `hello`
//! when the runner's end connects and `status` when `GuestInfo` changes; a
//! channel above 0 is one operation, one `req` and one `ans`. A disconnect
//! (the runner closed its socket, a restore gave it a new one) ends every
//! channel; operations keep running and are found by their keys. A frame
//! that breaks the channel rules ends the connection: the agent closes the
//! port and opens it again, and says `hello` again. A reconnect that comes
//! right after the disconnect, so the guest learns of both at once, leaves
//! no EOF to read: the agent keeps the old connection and sends no `hello`.
//! Any frame from the runner on channel 0 breaks the rules, so it is the
//! runner's way out (runner.proto's header): with no `hello` 500 ms after a
//! connect, it sends a `req` on channel 0, and the agent ends the stale
//! connection and says `hello` about 100 ms later. Between
//! `snapshot_prepare` and `snapshot_done` requests and the answers of reads
//! are held (snapshot.rs); the end of the connection drops them.
use std::{
    collections::HashSet,
    fs,
    io::{self, Read},
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::fs::OpenOptionsExt,
    },
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
    task::{Context, Poll, ready},
    time::{Duration, Instant},
};

use cube_runner_protocol::{
    proto::{self, Code, daemon_answer::Result as AnswerKind, daemon_frame::T, daemon_request::Op},
    read_daemon_frame, refuse, write_frame,
};
use tokio::{
    io::{AsyncRead, BufReader, Interest, ReadBuf, unix::AsyncFd},
    net::unix::pipe,
    signal::unix::{Signal, SignalKind, signal},
    sync::{mpsc, watch},
};

use crate::{agent::Agent, snapshot};

/// The port's device: `/sys/class/virtio-ports/*/name` is `cube.0`.
pub fn find_port() -> Option<PathBuf> {
    for entry in fs::read_dir("/sys/class/virtio-ports").ok()?.flatten() {
        if fs::read_to_string(entry.path().join("name")).is_ok_and(|name| name.trim() == "cube.0") {
            return Some(PathBuf::from("/dev").join(entry.file_name()));
        }
    }
    None
}

/// At most one connection per this long, whatever the port reports.
const RECONNECT_POLL: Duration = Duration::from_millis(20);
/// How often the agent looks for the runner while its end is closed, besides
/// SIGIO (below): a backstop, never what a restore waits for.
const HOST_POLL: Duration = Duration::from_millis(20);

/// Asks the guest driver for SIGIO on this port (`O_ASYNC`, owner: this
/// process). It sends one for every message from the host about its end
/// (`VIRTIO_CONSOLE_PORT_OPEN`, connected or not) and for data, while the
/// port is open. That is how the agent learns the runner connected without
/// a timer: a timer armed before a save can fire late after a restore (on
/// KVM, about 0.9 s for a young guest), an interrupt does not.
fn signal_on_host_events(port: &fs::File) -> io::Result<()> {
    let fd = port.as_raw_fd();
    // SAFETY: fcntl on a descriptor this process owns.
    unsafe {
        if libc::fcntl(fd, libc::F_SETOWN, libc::getpid()) != 0 {
            return Err(io::Error::last_os_error());
        }
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_ASYNC) != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

/// Whether the runner's end of the port is connected. The guest driver sets
/// POLLHUP while the host's end is closed, and POLLIN with it, because a
/// read would not block then (it returns what is left, then EOF), so POLLIN
/// says nothing about a connection.
fn host_connected(port: &fs::File) -> bool {
    let mut poll = libc::pollfd {
        fd: port.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    let n = unsafe { libc::poll(&mut poll, 1, 0) };
    n >= 0 && poll.revents & (libc::POLLHUP | libc::POLLERR | libc::POLLNVAL) == 0
}

/// Waits until the runner's end is connected: woken by SIGIO (`events`,
/// see signal_on_host_events), and every `poll` as a backstop. Bytes a
/// closed connection left unread are dropped on the way: they belong to
/// channels the disconnect ended, and the next connection starts with
/// `hello` (the runner speaks after it).
async fn wait_for_host(port: &fs::File, events: &mut Option<Signal>, poll: Duration) {
    let mut buffer = [0u8; 4096];
    let mut dropped = 0;
    while !host_connected(port) {
        loop {
            match (&*port).read(&mut buffer) {
                Ok(n) if n > 0 => dropped += n,
                _ => break, // EOF (nothing left), or connected again (EAGAIN)
            }
        }
        match events {
            Some(events) => {
                tokio::select! {
                    _ = events.recv() => {}
                    _ = tokio::time::sleep(poll) => {}
                }
            }
            None => tokio::time::sleep(poll).await,
        }
    }
    if dropped > 0 {
        eprintln!("cube-agent: dropped {dropped} bytes a closed connection left unread");
    }
}

fn dup(port: &fs::File) -> io::Result<OwnedFd> {
    port.try_clone().map(OwnedFd::from)
}

/// The port's reading side. Not tokio's `pipe::Receiver`: on epoll it takes
/// a read shorter than its buffer as "drained" and waits for the next
/// edge, but a virtio port's read returns one of the guest's buffers (a
/// page) at a time, so the rest of a frame the host sent in more than one
/// buffer (any frame over 4 KiB) would wait until the host sent something
/// else. This waits for readiness only after a read says WouldBlock.
struct PortReader(AsyncFd<fs::File>);

impl PortReader {
    fn new(fd: OwnedFd) -> io::Result<Self> {
        AsyncFd::with_interest(fs::File::from(fd), Interest::READABLE).map(Self)
    }
}

impl AsyncRead for PortReader {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        loop {
            let mut guard = ready!(self.0.poll_read_ready(cx))?;
            let unfilled = buf.initialize_unfilled();
            if let Ok(read) = guard.try_io(|port| port.get_ref().read(unfilled)) {
                buf.advance(read?);
                return Poll::Ready(Ok(()));
            }
        }
    }
}

/// Serves the port until the agent is told to stop.
pub async fn serve(agent: Arc<Agent>) -> io::Result<()> {
    let path = loop {
        if let Some(path) = find_port() {
            break path;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    // Registered once, before any port is open, so no SIGIO is lost.
    let mut events = match signal(SignalKind::io()) {
        Ok(events) => Some(events),
        Err(error) => {
            eprintln!("cube-agent: no SIGIO ({error}); waiting for the runner by polling only");
            None
        }
    };
    loop {
        let port = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(&path)?;
        if let Err(error) = signal_on_host_events(&port) {
            eprintln!(
                "cube-agent: no SIGIO on cube.0 ({error}); waiting for the runner by polling only"
            );
        }
        wait_for_host(&port, &mut events, HOST_POLL).await;
        let started = Instant::now();
        match connection(&agent, &port).await {
            // The runner went away: close the port and open it again at
            // once, so the runner sees (QMP VSERPORT_CHANGE, timestamped)
            // that this side knows. No timer stands between that and the
            // next hello: a machine saved now waits for the host on SIGIO,
            // and the runner's connect after a restore wakes it. Never more
            // than one connection per RECONNECT_POLL.
            Ok(()) => {
                eprintln!("cube-agent: the runner closed its end of cube.0; closing the port");
                drop(port);
                tokio::time::sleep_until((started + RECONNECT_POLL).into()).await;
            }
            // It broke the channel rules (or reset): the port is opened again
            // after a pause.
            Err(error) => {
                eprintln!("cube-agent: ending the connection: {error}");
                drop(port);
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

/// One connection: Ok when the runner's end closed, Err when it broke the
/// channel rules.
async fn connection(agent: &Arc<Agent>, port: &fs::File) -> anyhow::Result<()> {
    let receiver = PortReader::new(dup(port)?)?;
    let mut sender = pipe::Sender::from_owned_fd_unchecked(dup(port)?)?;
    let (frames, mut queue) = mpsc::unbounded_channel::<proto::DaemonFrame>();
    // True once this connection is over: what the gate holds for it is
    // dropped, and the writer stops between two frames.
    let (end, ended) = watch::channel(false);
    let session = agent.connected();
    let writer = tokio::spawn({
        let (session, mut ended) = (session.clone(), ended.clone());
        async move {
            loop {
                let mut frame = tokio::select! {
                    biased;
                    _ = ended.wait_for(|ended| *ended) => break,
                    frame = queue.recv() => match frame {
                        Some(frame) => frame,
                        None => break,
                    },
                };
                // Every frame is this connection's session's, whatever task
                // made it: a frame made for an older one never gets here.
                frame.session = session.clone();
                if write_frame(&mut sender, &frame).await.is_err() {
                    break;
                }
            }
        }
    });
    let _ = frames.send(proto::DaemonFrame {
        ch: 0,
        t: Some(T::Hello(agent.info())),
        session: String::new(),
    });

    let mut reader = BufReader::new(receiver);
    let mut used = HashSet::new();
    let aborted: Arc<Mutex<HashSet<u32>>> = Arc::default();
    let mut stale = 0u64;
    let result = loop {
        let frame = match read_daemon_frame(&mut reader).await {
            Ok(frame) => frame,
            Err(error) => {
                let eof = error
                    .downcast_ref::<io::Error>()
                    .is_some_and(|e| e.kind() == io::ErrorKind::UnexpectedEof);
                break if eof { Ok(()) } else { Err(error) };
            }
        };
        let ch = frame.ch;
        if ch > 0 && frame.session != session {
            // A request or abort the runner sent for another session (it had
            // not read this connection's `hello` yet): never run, never
            // answered; the runner asks again by key in this session.
            stale += 1;
            eprintln!(
                "cube-agent: dropped a frame on channel {ch} for session {:?}, not {session}",
                frame.session
            );
            continue;
        }
        match frame.t {
            Some(T::Req(request)) => {
                if !used.insert(ch) {
                    break Err(anyhow::anyhow!(
                        "channel {ch} was used before on this connection"
                    ));
                }
                let (agent, frames, aborted, mut ended) = (
                    Arc::clone(agent),
                    frames.clone(),
                    Arc::clone(&aborted),
                    ended.clone(),
                );
                tokio::spawn(async move {
                    let send = |answer, follow| {
                        if aborted.lock().unwrap().remove(&ch) {
                            return; // the runner stopped waiting; the work is done anyway
                        }
                        let _ = frames.send(proto::DaemonFrame {
                            ch,
                            t: Some(T::Ans(proto::DaemonAnswer {
                                result: Some(answer),
                            })),
                            session: String::new(),
                        });
                        if follow {
                            let _ = frames.send(proto::DaemonFrame {
                                ch: 0,
                                t: Some(T::Status(agent.info())),
                                session: String::new(),
                            });
                        }
                    };
                    // A shut machine refuses at once (the gate a shutdown
                    // closed is never opened again).
                    if agent.is_shut()
                        || matches!(
                            request.op,
                            Some(Op::SnapshotPrepare(_) | Op::SnapshotDone(_) | Op::Shutdown(_))
                        )
                    {
                        let (answer, follow) = handle(&agent, request).await;
                        return send(answer, follow);
                    }
                    let writes = snapshot::writes(&request);
                    let what = format!("channel {ch}");
                    let Some(pass) = agent.gate().enter(writes, &what, &mut ended).await else {
                        return;
                    };
                    let (answer, follow) = handle(&agent, request).await;
                    if writes {
                        // Answered before the pass goes, so before a prepare
                        // that waited for it.
                        send(answer, follow);
                        drop(pass);
                    } else {
                        drop(pass);
                        if agent.gate().answer(&what, &mut ended).await {
                            send(answer, follow);
                        }
                    }
                });
            }
            Some(T::Abort(_)) => {
                if used.contains(&ch) {
                    aborted.lock().unwrap().insert(ch);
                }
            }
            _ => {
                break Err(anyhow::anyhow!(
                    "the runner sent a frame only the agent sends"
                ));
            }
        }
    };
    if stale > 0 {
        eprintln!(
            "cube-agent: session {session} ended; {stale} frame(s) of other sessions dropped"
        );
    }
    // The end first, so what the gate held is dropped, not let go.
    let _ = end.send(true);
    agent.disconnected();
    drop(frames);
    // The writer stops after the frame it is writing, so the next session's
    // `hello` never follows half a frame. A runner that does not read at all
    // leaves it blocked: then it is cut off.
    let mut writer = writer;
    if tokio::time::timeout(Duration::from_secs(2), &mut writer)
        .await
        .is_err()
    {
        writer.abort();
    }
    result
}

/// Answers one request; `true` when a `status` should follow the answer.
async fn handle(agent: &Arc<Agent>, request: proto::DaemonRequest) -> (AnswerKind, bool) {
    match request.op {
        Some(Op::Guest(guest)) => {
            let agent = Arc::clone(agent);
            let answer = tokio::task::spawn_blocking(move || agent.guest(&guest.op, &guest.data))
                .await
                .unwrap_or_else(|error| {
                    AnswerKind::Error(refuse(Code::Internal, "agent", &error.to_string()))
                });
            (answer, false)
        }
        Some(Op::MachineSetup(setup)) => match agent.machine_setup(setup).await {
            Ok(()) => (AnswerKind::Done(proto::Empty {}), true),
            Err(error) => (AnswerKind::Error(error), true),
        },
        Some(Op::TemplatePublish(_)) => match agent.template_publish().await {
            Ok(()) => (AnswerKind::Done(proto::Empty {}), true),
            Err(error) => (AnswerKind::Error(error), true),
        },
        Some(Op::SnapshotPrepare(_)) => match agent.snapshot_prepare().await {
            Ok(()) => (AnswerKind::Done(proto::Empty {}), true),
            Err(error) => (AnswerKind::Error(error), true),
        },
        Some(Op::SnapshotDone(_)) => {
            agent.snapshot_done();
            (AnswerKind::Done(proto::Empty {}), true)
        }
        Some(Op::Shutdown(_)) => match agent.shutdown().await {
            Ok(()) => (AnswerKind::Done(proto::Empty {}), true),
            Err(error) => (AnswerKind::Error(error), true),
        },
        None => (
            AnswerKind::Error(refuse(
                Code::InvalidArgument,
                "bad_request",
                "a request of no known kind",
            )),
            false,
        ),
    }
}

#[cfg(test)]
mod tests {
    use std::os::{fd::FromRawFd, unix::net::UnixStream};

    use tokio::io::AsyncWriteExt;

    use super::*;

    /// One end of a socket pair as the agent's port, the other as the
    /// runner's socket.
    fn port() -> (fs::File, tokio::net::UnixStream) {
        let (agent, runner) = UnixStream::pair().unwrap();
        agent.set_nonblocking(true).unwrap();
        runner.set_nonblocking(true).unwrap();
        (
            fs::File::from(OwnedFd::from(agent)),
            tokio::net::UnixStream::from_std(runner).unwrap(),
        )
    }

    fn guest_hello(ch: u32, session: &str) -> proto::DaemonFrame {
        proto::DaemonFrame {
            ch,
            t: Some(T::Req(proto::DaemonRequest {
                op: Some(Op::Guest(proto::GuestRequest {
                    op: "hello".into(),
                    data: Vec::new(),
                })),
            })),
            session: session.into(),
        }
    }

    /// The `hello` that starts a connection; its session.
    async fn hello(runner: &mut tokio::net::UnixStream) -> String {
        let frame = read_daemon_frame(runner).await.unwrap();
        let Some(T::Hello(info)) = &frame.t else {
            panic!("{frame:?}")
        };
        assert!(
            frame.ch == 0 && cube_runner_protocol::valid_session(&frame.session),
            "{frame:?}"
        );
        assert_eq!(info.session, frame.session, "hello says its own session");
        frame.session
    }

    #[tokio::test]
    async fn a_req_on_channel_0_ends_the_connection() {
        let agent = Agent::start();
        let (port, mut runner) = port();
        let served = tokio::spawn({
            let agent = Arc::clone(&agent);
            async move { connection(&agent, &port).await }
        });
        let s = hello(&mut runner).await;
        // The connection works: an operation on channel 1 is answered.
        write_frame(&mut runner, &guest_hello(1, &s)).await.unwrap();
        let answer = read_daemon_frame(&mut runner).await.unwrap();
        assert!(
            answer.ch == 1 && matches!(answer.t, Some(T::Ans(_))),
            "{answer:?}"
        );
        // The runner's way out of a stale connection (no session yet).
        write_frame(&mut runner, &guest_hello(0, "")).await.unwrap();
        let ended = served.await.unwrap();
        assert!(
            ended
                .as_ref()
                .is_err_and(|e| e.to_string().contains("channel above 0")),
            "{ended:?}"
        );
    }

    /// A port that, as a virtio port does, answers each read with at most
    /// one of the buffers the host's bytes came in: one end of a
    /// SOCK_SEQPACKET pair (one packet per read) as the agent's port, the
    /// other as the runner's (blocking, read whole packets at a time).
    fn packet_port() -> (fs::File, std::os::unix::net::UnixStream) {
        let mut fds = [0; 2];
        // SAFETY: socketpair fills both descriptors, which are then owned.
        let made = unsafe {
            libc::socketpair(
                libc::AF_UNIX,
                libc::SOCK_SEQPACKET | libc::SOCK_CLOEXEC,
                0,
                fds.as_mut_ptr(),
            )
        };
        assert_eq!(made, 0, "{}", io::Error::last_os_error());
        // SAFETY: fresh descriptors from socketpair, each owned once.
        let (agent, runner) = unsafe {
            (
                UnixStream::from_raw_fd(fds[0]),
                UnixStream::from_raw_fd(fds[1]),
            )
        };
        agent.set_nonblocking(true).unwrap();
        runner
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        (fs::File::from(OwnedFd::from(agent)), runner)
    }

    /// The next frame from packets on the runner's end (blocking).
    fn packet_frame(runner: &mut UnixStream, pending: &mut Vec<u8>) -> proto::DaemonFrame {
        loop {
            if pending.len() >= 4 {
                let length = u32::from_be_bytes(pending[..4].try_into().unwrap()) as usize;
                if pending.len() >= 4 + length {
                    let frame = serde_json::from_slice(&pending[4..4 + length]).unwrap();
                    pending.drain(..4 + length);
                    return frame;
                }
            }
            let mut packet = vec![0u8; 1 << 20];
            let n = runner
                .read(&mut packet)
                .expect("a packet from the agent within 10 s");
            assert!(n > 0, "the agent closed its end");
            pending.extend_from_slice(&packet[..n]);
        }
    }

    /// The B-6 gate's stall: a request over 4 KiB reaches the guest in two
    /// of the port's buffers, both there before the agent reads. The first
    /// read gets only the first buffer; the agent must read the second
    /// without waiting for more from the host.
    #[tokio::test]
    async fn a_frame_in_two_port_buffers_is_read_without_more_from_the_host() {
        use std::io::Write;
        let agent = Agent::start();
        let (port, runner) = packet_port();
        let served = tokio::spawn({
            let agent = Arc::clone(&agent);
            async move { connection(&agent, &port).await }
        });
        let read = |mut runner: UnixStream, mut pending: Vec<u8>| {
            tokio::task::spawn_blocking(move || {
                let frame = packet_frame(&mut runner, &mut pending);
                (runner, pending, frame)
            })
        };
        let (mut runner, pending, hello) = read(runner, Vec::new()).await.unwrap();
        let session = hello.session.clone();
        assert!(matches!(hello.t, Some(T::Hello(_))), "{hello:?}");
        let mut request = guest_hello(1, &session);
        if let Some(T::Req(proto::DaemonRequest {
            op: Some(Op::Guest(guest)),
        })) = &mut request.t
        {
            guest.data = b"{}\n"
                .iter()
                .copied()
                .chain(std::iter::repeat_n(b'x', 4486))
                .collect();
        }
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &request).await.unwrap();
        assert!(bytes.len() > 4096 + 1024, "{} bytes", bytes.len());
        // Both buffers before the agent's next read: no await in between.
        runner.write_all(&bytes[..4096]).unwrap();
        runner.write_all(&bytes[4096..]).unwrap();
        let (runner, _, answer) = read(runner, pending).await.unwrap();
        assert!(
            answer.ch == 1 && matches!(answer.t, Some(T::Ans(_))),
            "{answer:?}"
        );
        drop(runner);
        let _ = served.await;
    }

    fn runner_op(ch: u32, op: Op, session: &str) -> proto::DaemonFrame {
        proto::DaemonFrame {
            ch,
            t: Some(T::Req(proto::DaemonRequest { op: Some(op) })),
            session: session.into(),
        }
    }

    /// An agent whose prepare syncs with a recording stand-in (never the
    /// host's disks) and writes its kernel knobs into DIR (or fails to, when
    /// `writable` is false); the count is its syncs.
    fn agent_settling_in(
        dir: &std::path::Path,
        writable: bool,
    ) -> (Arc<Agent>, Arc<std::sync::atomic::AtomicUsize>) {
        let knobs = if writable {
            dir.to_path_buf()
        } else {
            dir.join("missing")
        };
        let (syncs, sync) = snapshot::tests::recording_sync(&knobs);
        let agent = Agent::start_with(snapshot::Settle {
            sync,
            drop_caches: knobs.join("drop_caches"),
            compact_memory: knobs.join("compact_memory"),
        });
        (agent, syncs)
    }

    fn synced(syncs: &std::sync::atomic::AtomicUsize) -> usize {
        syncs.load(std::sync::atomic::Ordering::SeqCst)
    }

    async fn frame(runner: &mut tokio::net::UnixStream) -> proto::DaemonFrame {
        tokio::time::timeout(Duration::from_secs(5), read_daemon_frame(runner))
            .await
            .expect("a frame within 5 s")
            .unwrap()
    }

    fn answer(frame: &proto::DaemonFrame) -> Option<(u32, &AnswerKind)> {
        match &frame.t {
            Some(T::Ans(proto::DaemonAnswer {
                result: Some(result),
            })) => Some((frame.ch, result)),
            _ => None,
        }
    }

    fn status(frame: &proto::DaemonFrame) -> Option<&proto::GuestInfo> {
        match &frame.t {
            Some(T::Status(info)) if frame.ch == 0 => Some(info),
            _ => None,
        }
    }

    #[tokio::test]
    async fn snapshot_done_releases_what_the_prepare_held_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let (agent, syncs) = agent_settling_in(dir.path(), true);
        let (port, mut runner) = port();
        tokio::spawn({
            let agent = Arc::clone(&agent);
            async move { connection(&agent, &port).await }
        });
        let s = hello(&mut runner).await;
        write_frame(
            &mut runner,
            &runner_op(1, Op::SnapshotPrepare(proto::Empty {}), &s),
        )
        .await
        .unwrap();
        let done = frame(&mut runner).await;
        assert_eq!(synced(&syncs), 1, "done after one sync, before the knobs");
        assert!(
            matches!(answer(&done), Some((1, AnswerKind::Done(_)))),
            "{done:?}"
        );
        let prepared = frame(&mut runner).await;
        let info = status(&prepared).expect("a status after the prepare");
        assert!(
            !info.ready && info.reason == "prepared for a snapshot",
            "{info:?}"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("drop_caches")).unwrap(),
            "3"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("compact_memory")).unwrap(),
            "1"
        );
        // Held: a guest operation, then the release on a later channel. The
        // release's answer and status come first, then the held answer.
        write_frame(&mut runner, &guest_hello(2, &s)).await.unwrap();
        write_frame(
            &mut runner,
            &runner_op(3, Op::SnapshotDone(proto::Empty {}), &s),
        )
        .await
        .unwrap();
        let first = frame(&mut runner).await;
        assert!(
            matches!(answer(&first), Some((3, AnswerKind::Done(_)))),
            "{first:?}"
        );
        let after = frame(&mut runner).await;
        let info = status(&after).expect("a status after snapshot_done");
        assert_eq!(info.reason, "waiting for machine_setup", "{info:?}");
        let held = frame(&mut runner).await;
        assert!(
            matches!(answer(&held), Some((2, AnswerKind::Guest(_)))),
            "{held:?}"
        );
        // Not prepared any more: the next operation is answered at once.
        write_frame(&mut runner, &guest_hello(4, &s)).await.unwrap();
        let next = frame(&mut runner).await;
        assert!(
            matches!(answer(&next), Some((4, AnswerKind::Guest(_)))),
            "{next:?}"
        );
    }

    #[tokio::test]
    async fn the_end_of_the_connection_ends_a_prepare_and_drops_what_it_held() {
        let dir = tempfile::tempdir().unwrap();
        let (agent, syncs) = agent_settling_in(dir.path(), true);
        let (stale, mut runner) = port();
        let served = tokio::spawn({
            let agent = Arc::clone(&agent);
            async move { connection(&agent, &stale).await }
        });
        let s = hello(&mut runner).await;
        write_frame(
            &mut runner,
            &runner_op(1, Op::SnapshotPrepare(proto::Empty {}), &s),
        )
        .await
        .unwrap();
        frame(&mut runner).await;
        frame(&mut runner).await;
        assert_eq!(synced(&syncs), 1);
        write_frame(&mut runner, &guest_hello(2, &s)).await.unwrap();
        // A restored machine's stale connection: the runner's reset ends it.
        write_frame(&mut runner, &guest_hello(0, "")).await.unwrap();
        assert!(served.await.unwrap().is_err());
        assert!(
            !agent.gate().prepared(),
            "the prepare ended with the connection"
        );
        // The next connection starts unprepared, and nothing held answers on it.
        let (next, mut runner) = port();
        tokio::spawn({
            let agent = Arc::clone(&agent);
            async move { connection(&agent, &next).await }
        });
        let fresh = frame(&mut runner).await;
        let Some(T::Hello(info)) = &fresh.t else {
            panic!("{fresh:?}")
        };
        assert_eq!(info.reason, "waiting for machine_setup");
        assert!(
            cube_runner_protocol::valid_session(&fresh.session) && fresh.session != s,
            "a new connection is a new session: {} after {s}",
            fresh.session
        );
        // A request made for the old session is dropped, never answered.
        write_frame(&mut runner, &guest_hello(2, &s)).await.unwrap();
        // The same request in this session is answered, in this session.
        write_frame(&mut runner, &guest_hello(3, &fresh.session))
            .await
            .unwrap();
        let next = frame(&mut runner).await;
        assert!(
            matches!(answer(&next), Some((3, AnswerKind::Guest(_)))),
            "only the current session's request is answered: {next:?}"
        );
        assert_eq!(next.session, fresh.session);
    }

    #[tokio::test]
    async fn a_prepare_that_cannot_settle_the_machine_fails_closed() {
        let dir = tempfile::tempdir().unwrap();
        let (agent, syncs) = agent_settling_in(dir.path(), false);
        let (port, mut runner) = port();
        tokio::spawn({
            let agent = Arc::clone(&agent);
            async move { connection(&agent, &port).await }
        });
        let s = hello(&mut runner).await;
        write_frame(
            &mut runner,
            &runner_op(1, Op::SnapshotPrepare(proto::Empty {}), &s),
        )
        .await
        .unwrap();
        let refused = frame(&mut runner).await;
        let Some((1, AnswerKind::Error(error))) = answer(&refused) else {
            panic!("{refused:?}")
        };
        assert_eq!(
            (error.code, error.reason.as_str()),
            (Code::Internal as i32, "snapshot_prepare"),
            "{error:?}"
        );
        assert_eq!(synced(&syncs), 1, "synced, then the knob failed");
        let info = frame(&mut runner).await;
        assert_ne!(status(&info).unwrap().reason, "prepared for a snapshot");
        assert!(!agent.gate().prepared());
        write_frame(&mut runner, &guest_hello(2, &s)).await.unwrap();
        let next = frame(&mut runner).await;
        assert!(
            matches!(answer(&next), Some((2, AnswerKind::Guest(_)))),
            "{next:?}"
        );
    }

    #[tokio::test]
    async fn frames_without_this_session_are_dropped_and_answers_carry_it() {
        let agent = Agent::start();
        let (port, mut runner) = port();
        tokio::spawn({
            let agent = Arc::clone(&agent);
            async move { connection(&agent, &port).await }
        });
        let s = hello(&mut runner).await;
        for other in ["", "0123456789abcdef0123456789abcdef"] {
            write_frame(&mut runner, &guest_hello(1, other))
                .await
                .unwrap();
        }
        // Dropped frames do not use their channel: 1 still works.
        write_frame(&mut runner, &guest_hello(1, &s)).await.unwrap();
        let answered = frame(&mut runner).await;
        assert!(
            matches!(answer(&answered), Some((1, AnswerKind::Guest(_)))),
            "{answered:?}"
        );
        assert_eq!(answered.session, s, "an answer carries its session");
        let more = tokio::time::timeout(Duration::from_millis(300), read_daemon_frame(&mut runner));
        assert!(more.await.is_err(), "nothing answers the dropped frames");
    }

    /// An agent whose shutdown acts on stand-in cgroups in `dir` (`populated`
    /// says whether a workload outlives SIGKILL) and an unmounted disk.
    fn agent_shutting_down_in(dir: &std::path::Path, populated: bool) -> Arc<Agent> {
        let group = dir.join("ops").join("op-1");
        fs::create_dir_all(&group).unwrap();
        fs::write(
            group.join("cgroup.events"),
            if populated {
                "populated 1\n"
            } else {
                "populated 0\n"
            },
        )
        .unwrap();
        fs::write(group.join("cgroup.procs"), "").unwrap();
        Agent::start_with_teardown(
            snapshot::Settle::default(),
            crate::shutdown::Teardown {
                cgroups: vec![dir.join("ops")],
                rw: dir.join("rw"),
                writers_wait: Duration::from_millis(300),
                term_wait: Duration::from_millis(50),
                kill_wait: Duration::from_millis(50),
                sync: || {},
            },
        )
    }

    async fn shutdown_and_after(
        agent: Arc<Agent>,
    ) -> (
        AnswerKind,
        AnswerKind,
        AnswerKind,
        AnswerKind,
        proto::GuestInfo,
    ) {
        let (port, mut runner) = port();
        tokio::spawn({
            let agent = Arc::clone(&agent);
            async move { connection(&agent, &port).await }
        });
        let s = hello(&mut runner).await;
        write_frame(
            &mut runner,
            &runner_op(1, Op::Shutdown(proto::Empty {}), &s),
        )
        .await
        .unwrap();
        let answered = frame(&mut runner).await;
        let first = answer(&answered).unwrap().1.clone();
        let info = status(&frame(&mut runner).await).unwrap().clone();
        write_frame(
            &mut runner,
            &runner_op(
                2,
                Op::Guest(proto::GuestRequest {
                    op: "exec".into(),
                    data: b"{}\n".to_vec(),
                }),
                &s,
            ),
        )
        .await
        .unwrap();
        let exec = answer(&frame(&mut runner).await).unwrap().1.clone();
        write_frame(
            &mut runner,
            &runner_op(3, Op::MachineSetup(Default::default()), &s),
        )
        .await
        .unwrap();
        let setup = answer(&frame(&mut runner).await).unwrap().1.clone();
        frame(&mut runner).await; // its status
        write_frame(
            &mut runner,
            &runner_op(4, Op::Shutdown(proto::Empty {}), &s),
        )
        .await
        .unwrap();
        let again = answer(&frame(&mut runner).await).unwrap().1.clone();
        (first, exec, setup, again, info)
    }

    fn reason(answer: &AnswerKind) -> &str {
        match answer {
            AnswerKind::Error(error) => &error.reason,
            _ => "",
        }
    }

    #[tokio::test]
    async fn a_shutdown_answers_done_once_the_teardown_held_and_the_machine_refuses_everything_after()
     {
        let dir = tempfile::tempdir().unwrap();
        let (first, exec, setup, again, info) =
            shutdown_and_after(agent_shutting_down_in(dir.path(), false)).await;
        assert!(matches!(first, AnswerKind::Done(_)), "{first:?}");
        assert!(
            !info.ready && info.reason.starts_with("shut down: "),
            "{info:?}"
        );
        assert_eq!(reason(&exec), "shut_down", "{exec:?}");
        assert_eq!(reason(&setup), "shut_down", "{setup:?}");
        assert!(
            matches!(again, AnswerKind::Done(_)),
            "a repeated shutdown answers as the first: {again:?}"
        );
    }

    #[tokio::test]
    async fn a_shutdown_whose_teardown_fails_answers_an_error_never_done() {
        let dir = tempfile::tempdir().unwrap();
        let (first, exec, setup, again, info) =
            shutdown_and_after(agent_shutting_down_in(dir.path(), true)).await;
        let AnswerKind::Error(error) = &first else {
            panic!("{first:?}")
        };
        assert_eq!(error.reason, "shutdown_failed");
        assert!(error.message.contains("did not end"), "{error:?}");
        assert!(info.reason.contains("teardown failed"), "{info:?}");
        assert_eq!(reason(&exec), "shut_down");
        assert_eq!(reason(&setup), "shut_down");
        assert_eq!(reason(&again), "shutdown_failed", "the same outcome again");
    }

    #[tokio::test]
    async fn a_shutdown_waits_a_bounded_time_for_a_request_that_writes() {
        // R13: a writer in flight when the shutdown comes. One that answers
        // in time is waited for; one that does not is not waited for longer:
        // the teardown goes on (and decides, through the remount, whether the
        // disk is safe). Either way the answer comes after the wait, not
        // before.
        for (writer_ms, waited_ms) in [(100u64, 100u128), (1000, 300)] {
            let dir = tempfile::tempdir().unwrap();
            let agent = agent_shutting_down_in(dir.path(), false);
            let (_end, mut ended) = watch::channel(false);
            let pass = agent
                .gate()
                .enter(true, "a write", &mut ended)
                .await
                .unwrap();
            let started = std::time::Instant::now();
            let shutting = tokio::spawn({
                let agent = Arc::clone(&agent);
                async move { agent.shutdown().await }
            });
            tokio::time::sleep(Duration::from_millis(writer_ms)).await;
            drop(pass);
            let outcome = tokio::time::timeout(Duration::from_secs(5), shutting)
                .await
                .unwrap()
                .unwrap();
            assert!(outcome.is_ok(), "{outcome:?}");
            assert!(
                started.elapsed().as_millis() >= waited_ms,
                "waited {:?} for a writer of {writer_ms} ms",
                started.elapsed()
            );
        }
    }

    #[tokio::test]
    async fn eof_is_the_end_of_a_connection_not_an_error() {
        let agent = Agent::start();
        let (port, mut runner) = port();
        let served = tokio::spawn({
            let agent = Arc::clone(&agent);
            async move { connection(&agent, &port).await }
        });
        hello(&mut runner).await;
        runner.shutdown().await.unwrap();
        drop(runner);
        assert!(served.await.unwrap().is_ok());
    }
}
