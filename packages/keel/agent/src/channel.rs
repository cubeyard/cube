//! The guest channel: `DaemonFrame`s on the virtio-serial port named
//! `cube.0` (runner.proto's header). Channel 0 carries the agent's `hello`
//! when the runner's end connects and `status` when `GuestInfo` changes; a
//! channel above 0 is one operation, one `req` and one `ans`. A disconnect
//! (the runner closed its socket, a restore gave it a new one) ends every
//! channel; operations keep running and are found by their keys. A frame
//! that breaks the channel rules ends the connection: the agent closes the
//! port and opens it again, and says `hello` again.
use std::{
    collections::HashSet,
    fs, io,
    os::{
        fd::{AsRawFd, OwnedFd},
        unix::fs::OpenOptionsExt,
    },
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
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

/// Whether the runner's end of the port is connected (no POLLHUP).
fn host_connected(port: &fs::File) -> bool {
    let mut poll = libc::pollfd {
        fd: port.as_raw_fd(),
        events: libc::POLLIN,
        revents: 0,
    };
    let n = unsafe { libc::poll(&mut poll, 1, 0) };
    n >= 0 && (poll.revents & libc::POLLHUP == 0 || poll.revents & libc::POLLIN != 0)
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
            while !host_connected(&port) {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            match connection(&agent, &port).await {
                Ok(()) => continue, // the runner went away; wait for the next
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
