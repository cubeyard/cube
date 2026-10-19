//! Suspend and resume (masterplan S-7a, phase 7 P7-4; runner.proto's
//! `machine_suspend`). cubed decides when a machine is idle; the runner
//! saves it and, on `machine_start`, restores it.
//!
//! ```text
//! machine_suspend (under ops)  RUNNING ─► SUSPENDING ─────────────► SUSPENDED
//!   refused, still RUNNING:      snapshot_prepare        journal: snapshot, synced
//!   busy, disk, not on           leave cube.0 (seen)     quit QEMU
//!                                stop, migrate memory.part (mapped-ram, cpr-reboot)
//!                                completed, sync, rename memory
//!   a failure or SUSPEND_WAIT: migrate_cancel, cont, rejoin (hello,
//!   machine_setup again), partial file deleted: RUNNING, UNAVAILABLE/snapshot
//!
//! machine_start on SUSPENDED   key fits (K-7) ─► new QEMU -S -incoming defer
//!   (a free slot, B7-2)          migrate-incoming, completed
//!                                journal: no snapshot, synced (K-1), cont
//!                                memory deleted; same boot_id
//!                              else: SnapshotDropped (version, missing,
//!                                load), memory deleted, cold boot
//! ```
//!
//! The journal (`machine.json`) is the only authority (K-2): a memory file
//! it does not name is deleted when the runner starts, and so is one whose
//! machine is not SUSPENDED. A memory file is loaded at most once and never
//! after the guest ran again, because the snapshot leaves the journal before
//! `cont`.
use std::{
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use cube_runner_protocol::{
    Timestamp,
    proto::{self, Code, daemon_answer::Result as AnswerKind, daemon_request::Op},
    refuse,
};
use serde_json::{Value, json};

use super::{
    Answer, Phase, Qmp, VmRunner, channel, event, internal, qemu,
    record::{self, Dropped, MEMORY, MEMORY_PART, MachineRecord, Snapshot, SnapshotKey},
};

/// A whole save, from `snapshot_prepare` to the renamed memory file (K-8):
/// shorter than cubed's wait for `machine_suspend` (90 s, as for a stop), so
/// the runner answers first. Past it the save is undone.
pub const SUSPEND_WAIT: Duration = Duration::from_secs(if cfg!(test) { 3 } else { 60 });
/// The agent sees the runner leave cube.0 (a port change after the close):
/// runner.proto's reset wait.
const LEAVE_WAIT: Duration = Duration::from_secs(2);
/// A restore's load of the memory file.
const LOAD_WAIT: Duration = Duration::from_secs(60);
const POLL: Duration = Duration::from_millis(20);

/// How far a save got, for undoing it.
#[derive(Default)]
struct Progress {
    /// `snapshot_prepare` was sent (answered or not).
    prepared: bool,
    /// The runner left cube.0.
    left: bool,
    /// QEMU was stopped.
    stopped: bool,
    /// `migrate` was sent.
    migrating: bool,
}

/// Deletes the machine's memory files and forgets its snapshot.
pub(super) fn drop_snapshot(dir: &Path, record: &mut MachineRecord) {
    for name in [MEMORY, MEMORY_PART] {
        let _ = std::fs::remove_file(dir.join(name));
    }
    record.snapshot = None;
}

/// When the runner starts (K-2): a partial save is deleted; a memory file is
/// kept only for a SUSPENDED machine whose journal names it. A machine whose
/// resume the runner did not finish (it is no longer SUSPENDED but still has
/// its snapshot) loses it, with `SnapshotDropped`.
pub(super) fn forget_orphans(dir: &Path, record: &mut MachineRecord, path: &Path) -> Result<()> {
    if std::fs::remove_file(dir.join(MEMORY_PART)).is_ok() {
        event(
            dir,
            "snapshot",
            "a save the runner did not finish: its partial memory file is deleted",
        );
    }
    if record.phase == Phase::Suspended {
        return Ok(());
    }
    if record.snapshot.is_some() {
        drop_snapshot(dir, record);
        record.dropped = Some(Dropped {
            reason: "load".into(),
            message: "the runner restarted while the machine resumed; its snapshot is deleted"
                .into(),
            at: Timestamp::now(),
        });
        record::write_json(path, record)?;
        event(
            dir,
            "snapshot dropped",
            "the runner restarted while the machine resumed",
        );
    } else if std::fs::remove_file(dir.join(MEMORY)).is_ok() {
        event(
            dir,
            "snapshot",
            "a memory file the journal does not name is deleted",
        );
    }
    Ok(())
}

/// The memory file a SUSPENDED machine resumes from, or None: then its
/// snapshot is dropped with the reason (K-7: another QEMU, keel, machine
/// type, size or QEMU arguments is `version`), and it boots cold.
pub(super) fn usable(dir: &Path, record: &mut MachineRecord, key: &SnapshotKey) -> Option<PathBuf> {
    let file = dir.join(MEMORY);
    let dropped = match &record.snapshot {
        None => Some((
            "missing",
            "the machine was suspended, but its journal names no snapshot".to_owned(),
        )),
        Some(_) if !file.is_file() => Some((
            "missing",
            format!("its memory file {} is gone", file.display()),
        )),
        Some(snapshot) if snapshot.key != *key => {
            Some(("version", differences(&snapshot.key, key)))
        }
        Some(_) => None,
    };
    match dropped {
        None => Some(file),
        Some((reason, message)) => {
            drop_snapshot(dir, record);
            event(
                dir,
                "snapshot dropped",
                &format!("{reason}: {message}; the machine boots cold"),
            );
            record.dropped = Some(Dropped {
                reason: reason.into(),
                message,
                at: Timestamp::now(),
            });
            None
        }
    }
}

/// What changed since the save, for people.
fn differences(saved: &SnapshotKey, now: &SnapshotKey) -> String {
    let mut changed = vec![];
    let mut differ = |what: &str, a: &str, b: &str| {
        if a != b {
            changed.push(format!("{what} {a} → {b}"));
        }
    };
    differ("QEMU", &saved.qemu, &now.qemu);
    differ("keel kernel", &saved.kernel_sha256, &now.kernel_sha256);
    differ("keel base", &saved.base_sha256, &now.base_sha256);
    differ("machine type", &saved.machine_type, &now.machine_type);
    differ("QEMU arguments", &saved.argv_sha256, &now.argv_sha256);
    differ("berth", &saved.berth, &now.berth);
    if saved.size != now.size {
        changed.push(format!("size {:?} → {:?}", saved.size, now.size));
    }
    format!("saved under another runner setup: {}", changed.join(", "))
}

/// The mapped-ram capability and migration mode of every save and load.
async fn migration_mode(qmp: &mut Qmp) -> Result<()> {
    qmp.execute(
        "migrate-set-capabilities",
        json!({"capabilities": [{"capability": "mapped-ram", "state": true}]}),
    )
    .await?;
    qmp.execute("migrate-set-parameters", json!({"mode": "cpr-reboot"}))
        .await?;
    Ok(())
}

/// Until `query-migrate` says completed (or failed).
async fn migrated(qmp: &mut Qmp) -> Result<()> {
    loop {
        let status = qmp.execute("query-migrate", Value::Null).await?;
        match status["status"].as_str() {
            Some("completed") => return Ok(()),
            Some("failed" | "cancelled") => bail!(
                "the migration {}: {}",
                status["status"].as_str().unwrap_or_default(),
                status["error-desc"].as_str().unwrap_or("no reason given")
            ),
            _ => tokio::time::sleep(POLL).await,
        }
    }
}

fn sync_dir(dir: &Path) -> Result<()> {
    std::fs::File::open(dir)?.sync_all()?;
    Ok(())
}

impl VmRunner {
    /// What a snapshot must match to be loaded (K-7): this runner's QEMU,
    /// keel, berth and the machine's type, size and QEMU arguments.
    pub(super) fn snapshot_key(&self, dir: &Path, record: &MachineRecord) -> SnapshotKey {
        use sha2::{Digest, Sha256};
        let argv = serde_json::to_vec(&self.boot_argv(dir, record)).unwrap_or_default();
        SnapshotKey {
            qemu: self.qemu_version(),
            kernel_sha256: self.keel.kernel_sha256.clone(),
            base_sha256: self.keel.base_sha256.clone(),
            machine_type: record.machine_type.clone(),
            size: record.size,
            argv_sha256: Sha256::digest(argv)
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect(),
            berth: crate::SOFTWARE_VERSION.into(),
        }
    }

    /// A restore's load (`launch` with a memory file), on the new QEMU's
    /// QMP: the memory comes in, the snapshot leaves the journal, synced,
    /// and only then does the guest run (K-1); the file goes after.
    pub(super) async fn load(
        &self,
        qmp: &mut Qmp,
        id: &str,
        dir: &Path,
        memory: &Path,
    ) -> Result<()> {
        let status = qmp.execute("query-status", Value::Null).await?;
        ensure!(
            status["status"] == "inmigrate",
            "QEMU is {}, not waiting for the memory file",
            status["status"]
        );
        migration_mode(qmp).await?;
        qmp.execute(
            "migrate-incoming",
            json!({"uri": format!("file:{}", memory.display())}),
        )
        .await?;
        tokio::time::timeout(LOAD_WAIT, migrated(qmp))
            .await
            .context("the memory file did not load in time")??;
        {
            let mut state = self.state.lock().unwrap();
            let entry = state.machines.get_mut(id).context("the machine went")?;
            entry.record.snapshot = None;
            self.commit(&mut state, id)
                .map_err(|error| anyhow::anyhow!(error.message))?;
        }
        event(
            dir,
            "restore",
            "loaded; the snapshot left the journal before cont",
        );
        qmp.execute("cont", Value::Null).await?;
        let _ = std::fs::remove_file(memory);
        Ok(())
    }

    /// `machine_suspend` (runner.proto), under `ops`.
    pub(super) async fn suspend(
        self: &Arc<Self>,
        request: proto::MachineRef,
    ) -> Answer<proto::Machine> {
        let Some(margin_gib) = self.options.suspend_disk_margin_gib else {
            return Err(refuse(
                Code::Unimplemented,
                "suspend",
                "suspend is off on this runner: berth vm suspends machines only when started with --suspend-disk-margin-gib",
            ));
        };
        let (id, dir, guest) = {
            let mut state = self.state.lock().unwrap();
            Self::not_publishing(&state, request.r#ref.as_ref())?;
            let entry = Self::fenced(&mut state, request.r#ref.as_ref(), request.fence.as_ref())?;
            let id = entry.record.id.clone();
            let dir = self.machine_dir(&id);
            let guest = match (entry.record.phase, &entry.guest, &entry.live) {
                (Phase::Suspended, _, _) => return Ok(self.current(&state, &id)),
                (Phase::Running, Some(guest), Some(_)) => Arc::clone(guest),
                (phase, _, _) => {
                    return Err(refuse(
                        Code::FailedPrecondition,
                        "not_running",
                        &format!(
                            "the machine is {}; only a running machine is suspended",
                            phase.name()
                        ),
                    ));
                }
            };
            // Atomic with the change to SUSPENDING (K-4): a stream let
            // through later sees SUSPENDING and is refused.
            if entry.streams > 0 {
                return Err(refuse(
                    Code::FailedPrecondition,
                    "busy",
                    &format!(
                        "{} guest or dial stream(s) to the machine are open",
                        entry.streams
                    ),
                ));
            }
            // The memory file is at most the guest's memory; one suspend at a
            // time (`ops`), so no other save counts the same free space.
            let needed = (u64::from(entry.record.size.memory_mib) << 20)
                .saturating_add(margin_gib.saturating_mul(1 << 30));
            let free = (self.options.free_space)(&dir).map_err(internal)?;
            if free < needed {
                return Err(refuse(
                    Code::ResourceExhausted,
                    "disk",
                    &format!(
                        "{} MiB free; a suspend needs the machine's memory ({} MiB) and --suspend-disk-margin-gib {margin_gib}; the machine keeps running",
                        free >> 20,
                        entry.record.size.memory_mib
                    ),
                ));
            }
            entry.record.phase = Phase::Suspending;
            entry.record.dropped = None;
            self.commit(&mut state, &id)?;
            (id, dir, guest)
        };
        event(&dir, "suspend", "the machine is saved");
        let mut progress = Progress::default();
        let saved = tokio::time::timeout(SUSPEND_WAIT, self.save(&dir, &guest, &mut progress))
            .await
            .unwrap_or_else(|_| {
                Err(anyhow::anyhow!(
                    "the save took longer than {} s",
                    SUSPEND_WAIT.as_secs()
                ))
            });
        match saved {
            Ok(memory_bytes) => {
                {
                    let mut state = self.state.lock().unwrap();
                    let key = self.snapshot_key(&dir, &state.machines[&id].record);
                    let entry = state.machines.get_mut(&id).unwrap();
                    entry.record.snapshot = Some(Snapshot {
                        saved_at: Timestamp::now(),
                        memory_bytes,
                        key,
                    });
                    entry.record.phase = Phase::Suspended;
                    entry.info = None;
                    self.commit(&mut state, &id)?;
                }
                event(
                    &dir,
                    "suspended",
                    &format!("{} MiB of memory saved; QEMU is quit", memory_bytes >> 20),
                );
                self.quit(&id).await;
                let state = self.state.lock().unwrap();
                Ok(self.current(&state, &id))
            }
            Err(error) => {
                let message = format!("{error:#}");
                self.unsave(&id, &dir, &guest, &progress).await;
                event(&dir, "suspend failed", &message);
                Err(refuse(
                    Code::Unavailable,
                    "snapshot",
                    &format!("the machine was not suspended and keeps running: {message}"),
                ))
            }
        }
    }

    /// The save itself: the allocated bytes of the renamed memory file.
    async fn save(
        &self,
        dir: &Path,
        guest: &channel::Guest,
        progress: &mut Progress,
    ) -> Result<u64> {
        let (_, answer) = guest
            .request(Op::SnapshotPrepare(proto::Empty {}))
            .map_err(|error| anyhow::anyhow!("no snapshot_prepare was sent: {}", error.message))?;
        progress.prepared = true;
        match answer.await {
            Ok(Ok(AnswerKind::Done(_))) => {}
            Ok(Ok(AnswerKind::Error(error))) => {
                bail!(
                    "the agent refused snapshot_prepare: {} {}",
                    error.reason,
                    error.message
                )
            }
            Ok(Ok(AnswerKind::Guest(_))) => {
                bail!("the agent answered snapshot_prepare as a guest operation")
            }
            Ok(Err(error)) => bail!("snapshot_prepare: {}", error.message),
            Err(_) => bail!("snapshot_prepare: the channel ended"),
        }
        let seen = guest.leave();
        progress.left = true;
        tokio::time::timeout(LEAVE_WAIT, seen)
            .await
            .ok()
            .and_then(Result::ok)
            .with_context(|| {
                format!(
                    "the agent did not see the runner leave cube.0 within {} s",
                    LEAVE_WAIT.as_secs()
                )
            })?;
        let mut qmp = Qmp::open(&dir.join(qemu::QMP_SOCKET), Duration::from_secs(2)).await?;
        qmp.execute("stop", Value::Null).await?;
        progress.stopped = true;
        migration_mode(&mut qmp).await?;
        let part = dir.join(MEMORY_PART);
        qmp.execute(
            "migrate",
            json!({"uri": format!("file:{}", part.display())}),
        )
        .await?;
        progress.migrating = true;
        migrated(&mut qmp).await?;
        std::fs::File::open(&part)?.sync_all()?;
        let bytes = std::fs::metadata(&part)?.blocks() * 512;
        std::fs::rename(&part, dir.join(MEMORY))?;
        sync_dir(dir)?;
        Ok(bytes)
    }

    /// A save that failed or took too long is undone: the migration
    /// cancelled, the guest running again, the partial file gone, and the
    /// runner back on cube.0, where the agent's `hello` gets `machine_setup`
    /// again (K-3), or, when the runner had not left yet, `snapshot_done`.
    async fn unsave(&self, id: &str, dir: &Path, guest: &channel::Guest, progress: &Progress) {
        if (progress.stopped || progress.migrating)
            && let Ok(mut qmp) =
                Qmp::open(&dir.join(qemu::QMP_SOCKET), Duration::from_secs(2)).await
        {
            if progress.migrating {
                let _ = qmp.execute("migrate_cancel", Value::Null).await;
                let _ = tokio::time::timeout(Duration::from_secs(10), async {
                    while let Ok(status) = qmp.execute("query-migrate", Value::Null).await {
                        if !matches!(
                            status["status"].as_str(),
                            Some("active" | "setup" | "cancelling" | "device")
                        ) {
                            break;
                        }
                        tokio::time::sleep(POLL).await;
                    }
                })
                .await;
            }
            if let Err(error) = qmp.execute("cont", Value::Null).await {
                event(dir, "suspend failed", &format!("cont: {error:#}"));
            }
        }
        for name in [MEMORY_PART, MEMORY] {
            let _ = std::fs::remove_file(dir.join(name));
        }
        if progress.left {
            guest.rejoin();
        } else if progress.prepared
            && let Ok((_, answer)) = guest.request(Op::SnapshotDone(proto::Empty {}))
        {
            let _ = tokio::time::timeout(Duration::from_secs(5), answer).await;
        }
        let mut state = self.state.lock().unwrap();
        if let Some(entry) = state.machines.get_mut(id)
            && entry.record.phase == Phase::Suspending
        {
            entry.record.phase = if entry.live.is_some() {
                Phase::Running
            } else {
                Phase::Stopped
            };
            let _ = self.commit(&mut state, id);
        }
    }
}
