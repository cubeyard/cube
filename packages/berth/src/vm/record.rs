//! A VM machine's journal: `DIRECTORY/<id>/machine.json`, written whole
//! under a temporary name, synced and renamed before the runner answers, so
//! what it says survives a crash of the runner or the host. A deleted
//! machine leaves `DIRECTORY/.berth/deleted/<id>.json` (its id is never
//! reused) and nothing else.
use std::path::Path;

use anyhow::{Context, Result};
use cube_runner_protocol::{Timestamp, proto::machine_status::Phase as ProtoPhase};
use serde::{Deserialize, Serialize};

pub const RECORD: &str = "machine.json";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Stopped,
    Starting,
    Running,
    Stopping,
    Retained,
    Deleted,
}

impl Phase {
    /// A QEMU may run for the machine.
    pub fn live(self) -> bool {
        matches!(self, Self::Starting | Self::Running | Self::Stopping)
    }
    pub fn proto(self) -> ProtoPhase {
        match self {
            Self::Stopped => ProtoPhase::Stopped,
            Self::Starting => ProtoPhase::Starting,
            Self::Running => ProtoPhase::Running,
            Self::Stopping => ProtoPhase::Stopping,
            Self::Retained => ProtoPhase::Retained,
            Self::Deleted => ProtoPhase::Deleted,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Running => "running",
            Self::Stopping => "stopping",
            Self::Retained => "retained",
            Self::Deleted => "deleted",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Size {
    pub vcpus: u32,
    pub memory_mib: u32,
    pub disk_gib: u32,
}

/// The newest boot: what ran, and since when.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Boot {
    pub boot_id: String,
    pub started_at: Timestamp,
    pub pid: u32,
    /// `11.1.2 /path/to/qemu-system-x86_64`.
    pub qemu: String,
    pub kernel_sha256: String,
    pub base_sha256: String,
}

/// The runner stopped the machine, not cubed: a restart (crash) or the
/// runner's own shutdown. Shown as the `Interrupted` condition until the
/// next start succeeds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Interruption {
    /// `runner_restarted` or `runner_stopped`.
    pub reason: String,
    pub message: String,
    pub since: Timestamp,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MachineRecord {
    pub version: u32,
    pub owner: String,
    pub id: String,
    pub fence_epoch: i64,
    pub phase: Phase,
    pub size: Size,
    /// Pinned when the machine is created: every boot (and, later, every
    /// restore) uses it, and a QEMU without it does not start the machine.
    pub machine_type: String,
    /// The QEMU that created it (`11.1.2 /path`).
    pub created_with: String,
    pub created_at: Timestamp,
    pub interrupted: Option<Interruption>,
    /// Why the newest boot ended or failed; cleared by the next start.
    pub error: String,
    pub boot: Option<Boot>,
}

impl MachineRecord {
    /// What a runner that starts finds: a machine whose QEMU ran under the
    /// previous runner (live phase) is stopped and interrupted. `quit` says
    /// whether that QEMU still answered and was told to quit.
    pub fn after_restart(&mut self, quit: bool, now: Timestamp) -> bool {
        if !self.phase.live() {
            return false;
        }
        let was = self.phase;
        self.phase = Phase::Stopped;
        self.interrupted = Some(Interruption {
            reason: "runner_restarted".into(),
            message: format!(
                "the runner restarted while the machine was {}; {}",
                was.name(),
                if quit {
                    "its QEMU still ran and was told to quit"
                } else {
                    "no QEMU answered"
                }
            ),
            since: now,
        });
        true
    }

    /// The runner itself stops: the machine is stopped with it.
    pub fn runner_stopping(&mut self, now: Timestamp) {
        self.interrupted = Some(Interruption {
            reason: "runner_stopped".into(),
            message: format!(
                "the runner stopped while the machine was {}; its QEMU was told to quit",
                self.phase.name()
            ),
            since: now,
        });
        self.phase = Phase::Stopping;
    }

    /// A deleted machine keeps its disk if asked to, or if the runner
    /// interrupted it (its disk may hold what cubed has not seen).
    pub fn keeps_disk(&self, retain: bool) -> bool {
        retain || self.interrupted.is_some()
    }
}

/// Writes `value` to `path` under a temporary name, synced, then renamed,
/// and syncs the directory.
pub fn write_json(path: &Path, value: &impl Serialize) -> Result<()> {
    let temporary = path.with_extension("json.tmp");
    std::fs::write(&temporary, serde_json::to_vec_pretty(value)?)
        .with_context(|| format!("write {}", temporary.display()))?;
    std::fs::File::open(&temporary)?.sync_all()?;
    std::fs::rename(&temporary, path)?;
    if let Some(parent) = path.parent() {
        std::fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

pub fn read(path: &Path) -> Result<MachineRecord> {
    serde_json::from_slice(&std::fs::read(path)?)
        .with_context(|| format!("read {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(phase: Phase) -> MachineRecord {
        MachineRecord {
            version: 1,
            owner: "thread-1".into(),
            id: "0123456789abcdef".into(),
            fence_epoch: 7,
            phase,
            size: Size {
                vcpus: 2,
                memory_mib: 1024,
                disk_gib: 8,
            },
            machine_type: "pc-q35-11.1".into(),
            created_with: "11.1.2 /q".into(),
            created_at: Timestamp {
                seconds: 1,
                nanos: 0,
            },
            interrupted: None,
            error: String::new(),
            boot: None,
        }
    }

    #[test]
    fn a_restart_interrupts_only_machines_whose_qemu_ran() {
        let now = Timestamp {
            seconds: 9,
            nanos: 0,
        };
        for phase in [Phase::Starting, Phase::Running, Phase::Stopping] {
            let mut machine = record(phase);
            assert!(machine.after_restart(true, now));
            assert_eq!(machine.phase, Phase::Stopped);
            let interrupted = machine.interrupted.unwrap();
            assert_eq!(interrupted.reason, "runner_restarted");
            assert!(interrupted.message.contains(phase.name()));
            assert!(interrupted.message.contains("told to quit"));
        }
        for phase in [Phase::Stopped, Phase::Retained, Phase::Deleted] {
            let mut machine = record(phase);
            assert!(!machine.after_restart(false, now));
            assert_eq!(machine, record(phase));
        }
        let mut gone = record(Phase::Running);
        gone.after_restart(false, now);
        assert!(
            gone.interrupted
                .unwrap()
                .message
                .ends_with("no QEMU answered")
        );
    }

    #[test]
    fn an_interrupted_machine_keeps_its_disk_when_deleted() {
        let mut machine = record(Phase::Running);
        assert!(!machine.keeps_disk(false));
        assert!(machine.keeps_disk(true));
        machine.runner_stopping(Timestamp::now());
        assert_eq!(machine.phase, Phase::Stopping);
        assert_eq!(
            machine.interrupted.as_ref().unwrap().reason,
            "runner_stopped"
        );
        assert!(machine.keeps_disk(false));
    }

    #[test]
    fn the_record_survives_a_write_and_refuses_unknown_fields() {
        let dir = std::env::temp_dir().join(format!("berth-record-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(RECORD);
        let mut machine = record(Phase::Running);
        machine.after_restart(true, Timestamp::now());
        write_json(&path, &machine).unwrap();
        assert_eq!(read(&path).unwrap(), machine);
        assert!(!dir.join("machine.json.tmp").exists());
        let mut text: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        text["extra"] = true.into();
        std::fs::write(&path, text.to_string()).unwrap();
        assert!(read(&path).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
