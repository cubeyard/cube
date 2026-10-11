//! `snapshot_prepare` and `snapshot_done` (runner.proto's `DaemonRequest`).
//! Before a save the runner sends `snapshot_prepare`. The agent holds every
//! request that comes after it, waits for the requests that write (`exec`,
//! `cancel`, `write`, `portal`, `machine_setup`, `template_publish`) to
//! answer, syncs, drops the page cache and compacts memory, so the pages it
//! freed are whole blocks free page reporting can give back, then answers
//! `done`. While prepared it sends nothing but that answer and its
//! `status`: a read that was running when the prepare came keeps its answer
//! too. It stays prepared until `snapshot_done` (the save failed, or the
//! machine keeps running), which lets what was held go on, or until the
//! connection ends (the machine was saved, and its restore brings a new
//! connection), which drops what was held unrun; the runner asks again by
//! key, as after any disconnect. A prepare that cannot settle the machine
//! answers an error and leaves it unprepared. Commands keep running: they
//! are frozen with the machine and go on after a restore.
use std::{
    io,
    path::{Path, PathBuf},
};

use cube_runner_protocol::{
    proto::{self, Code, daemon_request::Op},
    refuse,
};
use tokio::sync::watch;

#[derive(Clone, Copy, Default)]
struct State {
    prepared: bool,
    /// Requests that write, let through and not answered yet.
    writers: usize,
}

/// Whether a request changes what is on the writable disk; a prepare waits
/// for those. (`get` can record an end it finds cut off, a repair the
/// next `get` makes again.)
pub fn writes(request: &proto::DaemonRequest) -> bool {
    match &request.op {
        Some(Op::MachineSetup(_) | Op::TemplatePublish(_)) => true,
        Some(Op::Guest(guest)) => {
            matches!(guest.op.as_str(), "exec" | "cancel" | "write" | "portal")
        }
        _ => false,
    }
}

/// Where the agent lets requests through, or holds them while prepared.
pub struct Gate {
    state: watch::Sender<State>,
}

/// A request let through; a writer counts until its pass is dropped.
pub struct Pass<'a> {
    gate: &'a Gate,
    writer: bool,
}

impl Drop for Pass<'_> {
    fn drop(&mut self) {
        if self.writer {
            self.gate.state.send_modify(|state| state.writers -= 1);
        }
    }
}

impl Default for Gate {
    fn default() -> Self {
        Self {
            state: watch::Sender::new(State::default()),
        }
    }
}

impl Gate {
    pub fn prepared(&self) -> bool {
        self.state.borrow().prepared
    }

    /// Lets a request through, or holds it while the machine is prepared:
    /// Some once `snapshot_done` lets it go on, None when its connection
    /// ended first (it is dropped, never run).
    pub async fn enter(
        &self,
        writes: bool,
        what: &str,
        ended: &mut watch::Receiver<bool>,
    ) -> Option<Pass<'_>> {
        let mut held = false;
        loop {
            let mut changes = self.state.subscribe();
            let mut admitted = false;
            self.state.send_if_modified(|state| {
                if state.prepared {
                    return false;
                }
                admitted = true;
                if writes {
                    state.writers += 1;
                }
                writes
            });
            if admitted {
                if held {
                    eprintln!("cube-agent: snapshot: {what} goes on");
                }
                return Some(Pass {
                    gate: self,
                    writer: writes,
                });
            }
            if !held {
                eprintln!(
                    "cube-agent: snapshot: holding {what} until snapshot_done or the end of the connection"
                );
                held = true;
            }
            if !wait(&mut changes, ended).await {
                eprintln!("cube-agent: snapshot: dropped {what}, never run: the connection ended");
                return None;
            }
        }
    }

    /// Whether an answer may go out: at once when not prepared, else once
    /// `snapshot_done` comes (true) or the connection ends first (false).
    pub async fn answer(&self, what: &str, ended: &mut watch::Receiver<bool>) -> bool {
        let mut changes = self.state.subscribe();
        if !changes.borrow_and_update().prepared {
            return true;
        }
        eprintln!("cube-agent: snapshot: holding the answer on {what}");
        let sent = wait(&mut changes, ended).await;
        if !sent {
            eprintln!("cube-agent: snapshot: dropped the answer on {what}: the connection ended");
        }
        sent
    }

    /// Holds what comes from now on and waits until the requests that write
    /// have answered. Refused when `snapshot_done` or the end of the
    /// connection came first.
    pub async fn prepare(&self) -> Result<(), proto::Error> {
        self.state.send_modify(|state| state.prepared = true);
        let mut changes = self.state.subscribe();
        let prepared = changes
            .wait_for(|state| state.writers == 0 || !state.prepared)
            .await
            .is_ok_and(|state| state.prepared);
        if prepared {
            Ok(())
        } else {
            Err(refuse(
                Code::Aborted,
                "snapshot_done",
                "the machine was let go before it was prepared",
            ))
        }
    }

    /// Ends the prepared state; true when the machine was prepared.
    pub fn release(&self) -> bool {
        let mut was = false;
        self.state.send_if_modified(|state| {
            was = state.prepared;
            state.prepared = false;
            was
        });
        was
    }
}

/// Until the machine is let go (true) or the connection ended (false); the
/// end wins when both came, so a restore never runs what was held.
async fn wait(changes: &mut watch::Receiver<State>, ended: &mut watch::Receiver<bool>) -> bool {
    let let_go = tokio::select! {
        biased;
        _ = ended.wait_for(|ended| *ended) => false,
        _ = changes.wait_for(|state| !state.prepared) => true,
    };
    let_go && !*ended.borrow()
}

/// The kernel's knobs a prepare writes.
#[derive(Clone)]
pub struct Settle {
    pub drop_caches: PathBuf,
    pub compact_memory: PathBuf,
}

impl Default for Settle {
    fn default() -> Self {
        Self {
            drop_caches: "/proc/sys/vm/drop_caches".into(),
            compact_memory: "/proc/sys/vm/compact_memory".into(),
        }
    }
}

impl Settle {
    /// Syncs every filesystem, then drops the page cache (clean pages only,
    /// so after the sync all of it) and compacts memory. An error means the
    /// machine is not settled.
    pub fn run(&self) -> io::Result<()> {
        unsafe { libc::sync() };
        write(&self.drop_caches, "3")?;
        write(&self.compact_memory, "1")
    }
}

fn write(path: &Path, value: &str) -> io::Result<()> {
    std::fs::write(path, value)
        .map_err(|error| io::Error::new(error.kind(), format!("{}: {error}", path.display())))
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use super::*;

    fn guest(op: &str) -> proto::DaemonRequest {
        proto::DaemonRequest {
            op: Some(Op::Guest(proto::GuestRequest {
                op: op.into(),
                data: vec![],
            })),
        }
    }

    /// Whether a future is still pending after the runtime ran everything
    /// else it could.
    async fn pending<T>(handle: &tokio::task::JoinHandle<T>) -> bool {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        !handle.is_finished()
    }

    #[test]
    fn writes_are_the_operations_that_change_the_disk() {
        for op in ["exec", "cancel", "write", "portal"] {
            assert!(writes(&guest(op)), "{op}");
        }
        for op in ["hello", "get", "read", "stat", "services"] {
            assert!(!writes(&guest(op)), "{op}");
        }
        let setup = proto::DaemonRequest {
            op: Some(Op::MachineSetup(Default::default())),
        };
        let publish = proto::DaemonRequest {
            op: Some(Op::TemplatePublish(proto::Empty {})),
        };
        let prepare = proto::DaemonRequest {
            op: Some(Op::SnapshotPrepare(proto::Empty {})),
        };
        assert!(writes(&setup) && writes(&publish) && !writes(&prepare));
    }

    #[tokio::test]
    async fn a_prepare_waits_for_writers_only() {
        let gate = Arc::new(Gate::default());
        let (_end, ended) = watch::channel(false);
        let reader = gate
            .enter(false, "a read", &mut ended.clone())
            .await
            .unwrap();
        let writer = gate
            .enter(true, "a write", &mut ended.clone())
            .await
            .unwrap();
        let prepare = tokio::spawn({
            let gate = Arc::clone(&gate);
            async move { gate.prepare().await }
        });
        assert!(pending(&prepare).await, "the prepare waits for the write");
        assert!(gate.prepared(), "and holds what comes meanwhile");
        drop(writer);
        assert!(prepare.await.unwrap().is_ok(), "the read does not count");
        drop(reader);
        assert!(gate.release());
        assert!(!gate.release(), "a second release finds nothing prepared");
    }

    #[tokio::test]
    async fn snapshot_done_lets_held_requests_and_answers_go_on() {
        let gate = Arc::new(Gate::default());
        let (_end, ended) = watch::channel(false);
        gate.prepare().await.unwrap();
        let held = tokio::spawn({
            let (gate, mut ended) = (Arc::clone(&gate), ended.clone());
            async move { gate.enter(true, "a write", &mut ended).await.is_some() }
        });
        let answer = tokio::spawn({
            let (gate, mut ended) = (Arc::clone(&gate), ended.clone());
            async move { gate.answer("a read", &mut ended).await }
        });
        assert!(pending(&held).await && pending(&answer).await);
        assert!(gate.release());
        assert!(held.await.unwrap(), "the held request goes on");
        assert!(answer.await.unwrap(), "the held answer goes out");
    }

    #[tokio::test]
    async fn the_end_of_the_connection_drops_what_was_held() {
        let gate = Arc::new(Gate::default());
        let (end, ended) = watch::channel(false);
        gate.prepare().await.unwrap();
        let held = tokio::spawn({
            let (gate, mut ended) = (Arc::clone(&gate), ended.clone());
            async move { gate.enter(false, "a read", &mut ended).await.is_some() }
        });
        let answer = tokio::spawn({
            let (gate, mut ended) = (Arc::clone(&gate), ended.clone());
            async move { gate.answer("a read", &mut ended).await }
        });
        assert!(pending(&held).await && pending(&answer).await);
        // As the channel does: the end first, then the release. Both have
        // happened by the time the held tasks run, and the end wins.
        end.send(true).unwrap();
        assert!(gate.release());
        assert!(!held.await.unwrap(), "never run");
        assert!(!answer.await.unwrap(), "never sent");
        // A connection whose sender is gone counts as ended too.
        gate.prepare().await.unwrap();
        let (end, mut ended) = watch::channel(false);
        drop(end);
        assert!(gate.enter(false, "a read", &mut ended).await.is_none());
    }

    #[tokio::test]
    async fn a_prepare_let_go_before_the_writers_finished_is_refused() {
        let gate = Arc::new(Gate::default());
        let (_end, mut ended) = watch::channel(false);
        let writer = gate.enter(true, "a write", &mut ended).await.unwrap();
        let prepare = tokio::spawn({
            let gate = Arc::clone(&gate);
            async move { gate.prepare().await }
        });
        assert!(pending(&prepare).await);
        assert!(gate.release());
        let refused = prepare.await.unwrap().unwrap_err();
        assert_eq!(
            (refused.code, refused.reason.as_str()),
            (Code::Aborted as i32, "snapshot_done")
        );
        drop(writer);
        // Not prepared: requests go through at once.
        let pass = tokio::time::timeout(Duration::from_secs(1), gate.enter(true, "x", &mut ended));
        assert!(pass.await.unwrap().is_some());
    }

    #[test]
    fn settling_fails_closed_when_a_knob_cannot_be_written() {
        let dir = tempfile::tempdir().unwrap();
        let ok = Settle {
            drop_caches: dir.path().join("drop_caches"),
            compact_memory: dir.path().join("compact_memory"),
        };
        ok.run().unwrap();
        assert_eq!(std::fs::read_to_string(&ok.drop_caches).unwrap(), "3");
        assert_eq!(std::fs::read_to_string(&ok.compact_memory).unwrap(), "1");
        let missing = Settle {
            compact_memory: dir.path().join("no/such/knob"),
            ..ok
        };
        let error = missing.run().unwrap_err();
        assert!(error.to_string().contains("no/such/knob"), "{error}");
    }
}
