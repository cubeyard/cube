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
//! connection and says `hello` about 100 ms later.
use std::{
    collections::HashSet,
    fs,
    io::{self, Read},
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::fs::OpenOptionsExt,
    },
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use cube_runner_protocol::{
    proto::{self, Code, daemon_answer::Result as AnswerKind, daemon_frame::T, daemon_request::Op},
    read_daemon_frame, refuse, write_frame,
};
use tokio::{io::BufReader, net::unix::pipe, sync::mpsc};

use crate::agent::Agent;

/// The port's device: `/sys/class/virtio-ports/*/name` is `cube.0`.
pub fn find_port() -> Option<PathBuf> {
    for entry in fs::read_dir("/sys/class/virtio-ports").ok()?.flatten() {
        if fs::read_to_string(entry.path().join("name")).is_ok_and(|name| name.trim() == "cube.0") {
            return Some(PathBuf::from("/dev").join(entry.file_name()));
        }
    }
    None
}

/// How often the agent looks for the runner while its end is closed: the
/// port has no event for "connected again" (below).
const RECONNECT_POLL: Duration = Duration::from_millis(20);

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

/// Waits until the runner's end is connected, looking every
/// RECONNECT_POLL. Bytes a closed connection left unread are dropped on
/// the way: they belong to channels the disconnect ended, and the next
/// connection starts with `hello` (the runner speaks after it).
async fn wait_for_host(port: &fs::File) {
    let mut buffer = [0u8; 4096];
    let mut dropped = 0;
    while !host_connected(port) {
        loop {
            match (&*port).read(&mut buffer) {
                Ok(n) if n > 0 => dropped += n,
                _ => break, // EOF (nothing left), or connected again (EAGAIN)
            }
        }
        tokio::time::sleep(RECONNECT_POLL).await;
    }
    if dropped > 0 {
        eprintln!("cube-agent: dropped {dropped} bytes a closed connection left unread");
    }
}

fn dup(port: &fs::File) -> io::Result<OwnedFd> {
    port.try_clone().map(OwnedFd::from)
}

/// Serves the port until the agent is told to stop.
pub async fn serve(agent: Arc<Agent>) -> io::Result<()> {
    let path = loop {
        if let Some(path) = find_port() {
            break path;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    loop {
        let port = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open(&path)?;
        loop {
            wait_for_host(&port).await;
            let started = Instant::now();
            match connection(&agent, &port).await {
                // The runner went away; wait for the next. Never more than one
                // connection per RECONNECT_POLL, whatever the port reports.
                Ok(()) => tokio::time::sleep_until((started + RECONNECT_POLL).into()).await,
                Err(error) => {
                    eprintln!("cube-agent: ending the connection: {error}");
                    break; // reopen the port
                }
            }
        }
        drop(port);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// One connection: Ok when the runner's end closed, Err when it broke the
/// channel rules.
async fn connection(agent: &Arc<Agent>, port: &fs::File) -> anyhow::Result<()> {
    let receiver = pipe::Receiver::from_owned_fd_unchecked(dup(port)?)?;
    let mut sender = pipe::Sender::from_owned_fd_unchecked(dup(port)?)?;
    let (frames, mut queue) = mpsc::unbounded_channel::<proto::DaemonFrame>();
    let writer = tokio::spawn(async move {
        while let Some(frame) = queue.recv().await {
            if write_frame(&mut sender, &frame).await.is_err() {
                break;
            }
        }
    });
    agent.connected();
    let _ = frames.send(proto::DaemonFrame {
        ch: 0,
        t: Some(T::Hello(agent.info())),
    });

    let mut reader = BufReader::new(receiver);
    let mut used = HashSet::new();
    let aborted: Arc<Mutex<HashSet<u32>>> = Arc::default();
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
        match frame.t {
            Some(T::Req(request)) => {
                if !used.insert(ch) {
                    break Err(anyhow::anyhow!(
                        "channel {ch} was used before on this connection"
                    ));
                }
                let (agent, frames, aborted) =
                    (Arc::clone(agent), frames.clone(), Arc::clone(&aborted));
                tokio::spawn(async move {
                    let (answer, follow) = handle(&agent, request).await;
                    if aborted.lock().unwrap().remove(&ch) {
                        return; // the runner stopped waiting; the work is done anyway
                    }
                    let _ = frames.send(proto::DaemonFrame {
                        ch,
                        t: Some(T::Ans(proto::DaemonAnswer {
                            result: Some(answer),
                        })),
                    });
                    if follow {
                        let _ = frames.send(proto::DaemonFrame {
                            ch: 0,
                            t: Some(T::Status(agent.info())),
                        });
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
    drop(frames);
    writer.abort();
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
        Some(Op::SnapshotPrepare(_) | Op::SnapshotDone(_)) => (
            AnswerKind::Error(refuse(
                Code::Unimplemented,
                "unimplemented",
                "snapshots come with a later cube-agent (masterplan K-5f)",
            )),
            false,
        ),
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
    use std::os::unix::net::UnixStream;

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

    fn guest_hello(ch: u32) -> proto::DaemonFrame {
        proto::DaemonFrame {
            ch,
            t: Some(T::Req(proto::DaemonRequest {
                op: Some(Op::Guest(proto::GuestRequest {
                    op: "hello".into(),
                    data: Vec::new(),
                })),
            })),
        }
    }

    async fn hello(runner: &mut tokio::net::UnixStream) {
        let frame = read_daemon_frame(runner).await.unwrap();
        assert!(
            frame.ch == 0 && matches!(frame.t, Some(T::Hello(_))),
            "{frame:?}"
        );
    }

    #[tokio::test]
    async fn a_req_on_channel_0_ends_the_connection() {
        let agent = Agent::start();
        let (port, mut runner) = port();
        let served = tokio::spawn({
            let agent = Arc::clone(&agent);
            async move { connection(&agent, &port).await }
        });
        hello(&mut runner).await;
        // The connection works: an operation on channel 1 is answered.
        write_frame(&mut runner, &guest_hello(1)).await.unwrap();
        let answer = read_daemon_frame(&mut runner).await.unwrap();
        assert!(
            answer.ch == 1 && matches!(answer.t, Some(T::Ans(_))),
            "{answer:?}"
        );
        // The runner's way out of a stale connection.
        write_frame(&mut runner, &guest_hello(0)).await.unwrap();
        let ended = served.await.unwrap();
        assert!(
            ended
                .as_ref()
                .is_err_and(|e| e.to_string().contains("channel above 0")),
            "{ended:?}"
        );
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
