//! The hooks this machine runs, as cube-guest shows them (`cube hooks`,
//! `hello.hooks`). cubed runs them as commands (the preparation and resume
//! scripts in `vm.ts`): the project's `pre-setup` and `pre-resume` are the
//! boot documents, written to /etc/cube/hooks on every `machine_setup`; the
//! repository's `.agents/setup` and `.agents/resume` are in the workspace;
//! each hook's last outcome and log are in the agent account's
//! ~/.cache/cube. The agent only reads them: inside the workload root, and
//! with the caller's own permissions (a log is the agent account's file).
use std::{
    collections::BTreeMap,
    fs,
    io::{self, Read, Seek, SeekFrom},
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::Path,
};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{files::hex, journal::Account, paths};

/// Where the project's hooks are, in the workload root.
pub const DIRECTORY: &str = "/etc/cube/hooks";

/// Name, the repository's script (None: the project's, in DIRECTORY), its
/// log: in the order they run.
const HOOKS: [(&str, Option<&str>, &str); 4] = [
    ("pre-setup", None, "pre-setup.log"),
    ("setup", Some(".agents/setup"), "setup.log"),
    ("pre-resume", None, "pre-resume.log"),
    ("resume", Some(".agents/resume"), "resume.log"),
];

pub const USAGE: &str = "usage: cube hooks [-n LINES] [--json]

Shows the hooks this machine runs, read only: the project's external
pre-setup and pre-resume hooks (set in cube's projects, written to
/etc/cube/hooks when this machine was made) and the repository's
.agents/setup and .agents/resume, each with its last outcome in this
machine and the last LINES lines of its log (default 20, at most 200).

Order: pre-setup, then .agents/setup (only if pre-setup succeeded), once
when the machine is prepared; pre-resume, then .agents/resume, on every
boot. All run as agent in /workspace. A thread cannot change the project's
hooks: the user changes them in cube's projects, or asks OptChat
(project_hooks_write). New threads use the hooks saved when they start.
";

/// The reader: the workload root as the agent sees it, the agent account
/// (whose ~/.cache/cube holds the logs) and whose permissions to read with
/// (None: the agent's own, root).
pub struct Hooks<'a> {
    pub root: &'a Path,
    pub account: &'a Account,
    pub reader: Option<&'a Account>,
}

/// A `NAME.status` line: `ok|absent|skipped|notrun|failed:N MS ENDED_MS`.
struct Last {
    outcome: String,
    exit_code: Option<i64>,
    ms: i64,
    ended_at: i64,
}

fn parse_status(line: &str) -> Option<Last> {
    let mut words = line.trim().split(' ');
    let (outcome, ms, ended_at) = (words.next()?, words.next()?, words.next()?);
    if words.next().is_some() {
        return None;
    }
    let digits = |word: &str| !word.is_empty() && word.bytes().all(|b| b.is_ascii_digit());
    let exit_code = match outcome.strip_prefix("failed:") {
        Some(code) if digits(code) => Some(code.parse().ok()?),
        Some(_) => return None,
        None if ["ok", "absent", "skipped", "notrun"].contains(&outcome) => None,
        None => return None,
    };
    if !digits(ms) || !digits(ended_at) {
        return None;
    }
    Some(Last {
        outcome: outcome.into(),
        exit_code,
        ms: ms.parse().ok()?,
        ended_at: ended_at.parse().ok()?,
    })
}

/// The last `lines` lines of a file, from at most its last 64 KiB; None
/// when it cannot be read.
fn tail_lines(file: Option<fs::File>, lines: usize) -> Option<String> {
    let mut file = file?;
    let size = file.seek(SeekFrom::End(0)).ok()?;
    file.seek(SeekFrom::Start(size.saturating_sub(65536)))
        .ok()?;
    let mut bytes = vec![];
    file.read_to_end(&mut bytes).ok()?;
    if lines == 0 {
        return Some(String::new());
    }
    let text = String::from_utf8_lossy(&bytes);
    let all: Vec<&str> = text.lines().collect();
    Some(all[all.len().saturating_sub(lines)..].join("\n"))
}

/// `endedAt` as cube-guest prints it (local time; a keel machine's is UTC).
fn utc(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let (days, rest) = (seconds.div_euclid(86400), seconds.rem_euclid(86400));
    // Howard Hinnant's civil_from_days.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02} {:02}:{:02}:{:02}",
        rest / 3600,
        rest % 3600 / 60,
        rest % 60
    )
}

impl Hooks<'_> {
    fn logs(&self) -> String {
        format!("{}/.cache/cube", self.account.home.trim_end_matches('/'))
    }

    fn script(&self, name: &str, repository: Option<&str>) -> String {
        match repository {
            Some(path) => format!("/workspace/{path}"),
            None => format!("{DIRECTORY}/{name}"),
        }
    }

    /// Runs `work` with the reader's permissions, on a thread of its own.
    fn read_as<T: Send>(&self, work: impl FnOnce() -> T + Send) -> io::Result<T> {
        let Some(reader) = self.reader.filter(|_| unsafe { libc::geteuid() } == 0) else {
            return Ok(work());
        };
        std::thread::scope(|scope| {
            scope
                .spawn(|| {
                    paths::become_account(reader)?;
                    Ok(work())
                })
                .join()
                .unwrap_or_else(|_| Err(io::Error::other("reading the hooks failed")))
        })
    }

    fn open(root: &fs::File, path: &str) -> Option<fs::File> {
        let file = fs::File::from(
            paths::open_in_root_with(root, path, libc::O_RDONLY | libc::O_NONBLOCK).ok()?,
        );
        file.metadata().ok()?.is_file().then_some(file)
    }

    fn last(root: &fs::File, logs: &str, name: &str) -> Option<Last> {
        let line = tail_lines(Self::open(root, &format!("{logs}/{name}.status")), 1)?;
        parse_status(&line)
    }

    /// Each hook's last outcome (`ok`, `failed:N`, ...); a hook that never
    /// ran is left out.
    pub fn outcomes(&self) -> BTreeMap<String, String> {
        let logs = self.logs();
        self.read_as(|| {
            let Ok(root) = fs::File::open(self.root) else {
                return BTreeMap::new();
            };
            HOOKS
                .iter()
                .filter_map(|(name, _, _)| {
                    Self::last(&root, &logs, name).map(|last| (name.to_string(), last.outcome))
                })
                .collect()
        })
        .unwrap_or_default()
    }

    /// cube-guest's `hook_view` for every hook.
    pub fn views(&self, lines: usize) -> io::Result<Vec<Value>> {
        let logs = self.logs();
        let reader = self.reader.map(|a| (a.uid, a.gid, a.groups.clone()));
        self.read_as(|| {
            let root = fs::File::open(self.root)?;
            Ok(HOOKS
                .iter()
                .map(|(name, repository, log)| {
                    let script = self.script(name, *repository);
                    let file = Self::open(&root, &script);
                    let executable = file.as_ref().and_then(|f| f.metadata().ok()).is_some_and(|meta| {
                        let bits = meta.permissions().mode();
                        match &reader {
                            None => bits & 0o111 != 0,
                            Some((uid, _, _)) if meta.uid() == *uid => bits & 0o100 != 0,
                            Some((_, gid, groups)) if meta.gid() == *gid || groups.contains(&meta.gid()) => {
                                bits & 0o010 != 0
                            }
                            Some(_) => bits & 0o001 != 0,
                        }
                    });
                    let log_path = format!("{logs}/{log}");
                    let mut view = json!({
                        "name": name,
                        "source": if repository.is_some() { "repository" } else { "project" },
                        "path": script, "present": executable, "log": log_path,
                    });
                    if executable && let Some(mut file) = file {
                        view["bytes"] = json!(file.metadata().map_or(0, |meta| meta.len()));
                        let mut digest = Sha256::new();
                        let mut buffer = vec![0; 1 << 16];
                        let readable = loop {
                            match file.read(&mut buffer) {
                                Ok(0) => break true,
                                Ok(n) => digest.update(&buffer[..n]),
                                Err(_) => break false,
                            }
                        };
                        if readable {
                            view["sha256"] = json!(hex(&digest.finalize()));
                        }
                    }
                    view["last"] = Self::last(&root, &logs, name).map_or(Value::Null, |last| {
                        json!({
                            "status": if last.exit_code.is_some() { "failed" } else { last.outcome.as_str() },
                            "exitCode": last.exit_code, "ms": last.ms, "endedAt": last.ended_at,
                        })
                    });
                    view["logTail"] = json!(tail_lines(Self::open(&root, &log_path), lines));
                    view
                })
                .collect())
        })?
    }
}

/// cube-guest's `describe_hook`.
pub fn describe(view: &Value) -> String {
    let path = view["path"].as_str().unwrap_or_default();
    let script = if view["present"] == true {
        format!(
            "{path}, {} bytes, sha256 {}",
            view["bytes"],
            view["sha256"].as_str().unwrap_or("(unreadable)")
        )
    } else {
        format!("none ({path})")
    };
    let last = &view["last"];
    let outcome = if last.is_null() {
        "no outcome recorded in this machine".to_string()
    } else {
        format!(
            "{}{}, {:.1} s, {}",
            last["status"].as_str().unwrap_or_default(),
            last["exitCode"]
                .as_i64()
                .map(|code| format!(" (exit {code})"))
                .unwrap_or_default(),
            last["ms"].as_i64().unwrap_or(0) as f64 / 1000.0,
            utc(last["endedAt"].as_i64().unwrap_or(0))
        )
    };
    let mut lines = vec![
        format!(
            "{} ({} hook): {script}",
            view["name"].as_str().unwrap_or_default(),
            view["source"].as_str().unwrap_or_default()
        ),
        format!("  last: {outcome}"),
    ];
    match view["logTail"].as_str() {
        None => lines.push(format!(
            "  log: none ({})",
            view["log"].as_str().unwrap_or_default()
        )),
        Some("") => {}
        Some(tail) => {
            lines.push(format!(
                "  log {}, last lines:",
                view["log"].as_str().unwrap_or_default()
            ));
            lines.push(
                tail.lines()
                    .map(|line| format!("    {line}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        }
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn account(home: &str) -> Account {
        let (uid, gid) = unsafe { (libc::geteuid(), libc::getegid()) };
        Account {
            uid,
            gid,
            groups: vec![gid],
            home: home.into(),
        }
    }

    #[test]
    fn status_lines_are_read_as_cube_guest_reads_them() {
        let ok = parse_status("ok 1520 1760000000123\n").unwrap();
        assert_eq!(
            (ok.outcome.as_str(), ok.exit_code, ok.ms),
            ("ok", None, 1520)
        );
        let failed = parse_status("failed:7 3 4").unwrap();
        assert_eq!(
            (failed.outcome.as_str(), failed.exit_code),
            ("failed:7", Some(7))
        );
        for bad in [
            "",
            "ok",
            "ok 1",
            "maybe 1 2",
            "failed: 1 2",
            "failed:x 1 2",
            "ok 1 2 3",
            "ok -1 2",
        ] {
            assert!(parse_status(bad).is_none(), "{bad:?}");
        }
        assert_eq!(utc(0), "1970-01-01 00:00:00");
        assert_eq!(utc(1_760_183_696_789), "2025-10-11 11:54:56");
        assert_eq!(utc(951_782_400_000), "2000-02-29 00:00:00");
    }

    #[test]
    fn hooks_are_shown_from_the_root_and_the_account_s_logs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for d in [
            "etc/cube/hooks",
            "workspace/.agents",
            "home/agent/.cache/cube",
            "etc",
        ] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        fs::write(
            root.join("etc/cube/hooks/pre-resume"),
            "#!/bin/bash\necho hi\n",
        )
        .unwrap();
        fs::set_permissions(
            root.join("etc/cube/hooks/pre-resume"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        // Not executable: not present, as `os.access(X_OK)` says.
        fs::write(root.join("workspace/.agents/resume"), "true\n").unwrap();
        let logs = root.join("home/agent/.cache/cube");
        fs::write(logs.join("pre-resume.status"), "ok 1520 0\n").unwrap();
        fs::write(logs.join("resume.status"), "failed:3 40 0\n").unwrap();
        fs::write(logs.join("setup.status"), "garbage\n").unwrap();
        fs::write(logs.join("pre-resume.log"), "one\ntwo\nthree\n").unwrap();
        // A link in the account's directory names the root's file, never this host's.
        fs::write(root.join("etc/secret"), "ok 1 1\n").unwrap();
        std::os::unix::fs::symlink("/etc/secret", logs.join("pre-setup.status")).unwrap();
        let me = account("/home/agent");
        let hooks = Hooks {
            root,
            account: &me,
            reader: Some(&me),
        };
        let outcomes = hooks.outcomes();
        assert_eq!(
            outcomes,
            BTreeMap::from([
                ("pre-resume".to_string(), "ok".to_string()),
                ("pre-setup".to_string(), "ok".to_string()),
                ("resume".to_string(), "failed:3".to_string()),
            ])
        );
        let views = hooks.views(2).unwrap();
        let by = |name: &str| views.iter().find(|v| v["name"] == name).unwrap().clone();
        let pre = by("pre-resume");
        assert_eq!(pre["present"], true);
        assert_eq!(pre["source"], "project");
        assert_eq!(pre["path"], "/etc/cube/hooks/pre-resume");
        assert_eq!(pre["bytes"], 20);
        assert_eq!(
            pre["sha256"],
            hex(&Sha256::digest(b"#!/bin/bash\necho hi\n"))
        );
        assert_eq!(pre["logTail"], "two\nthree");
        assert_eq!(
            pre["last"],
            json!({"status": "ok", "exitCode": null, "ms": 1520, "endedAt": 0})
        );
        let resume = by("resume");
        assert_eq!(resume["present"], false);
        assert_eq!(resume["source"], "repository");
        assert_eq!(resume["path"], "/workspace/.agents/resume");
        assert_eq!(resume["last"]["status"], "failed");
        assert_eq!(resume["last"]["exitCode"], 3);
        assert_eq!(resume["logTail"], Value::Null);
        assert_eq!(by("setup")["last"], Value::Null);
        assert_eq!(
            describe(&pre),
            format!(
                "pre-resume (project hook): /etc/cube/hooks/pre-resume, 20 bytes, sha256 {}\n  last: ok, 1.5 s, 1970-01-01 00:00:00\n  log /home/agent/.cache/cube/pre-resume.log, last lines:\n    two\n    three",
                pre["sha256"].as_str().unwrap()
            )
        );
        assert_eq!(
            describe(&resume),
            "resume (repository hook): none (/workspace/.agents/resume)\n  last: failed (exit 3), 0.0 s, 1970-01-01 00:00:00\n  log: none (/home/agent/.cache/cube/resume.log)"
        );
    }

    /// Needs root (`sudo cargo test`; CI sets CUBE_AGENT_ROOT_TESTS): the
    /// agent account reads with its own permissions, root with root's.
    #[test]
    fn hooks_are_read_as_the_caller() {
        if unsafe { libc::geteuid() } != 0 {
            assert!(
                std::env::var_os("CUBE_AGENT_ROOT_TESTS").is_none(),
                "CUBE_AGENT_ROOT_TESTS is set: run this test as root"
            );
            eprintln!("skipped: needs root");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::set_permissions(root, fs::Permissions::from_mode(0o755)).unwrap();
        let logs = root.join("home/agent/.cache/cube");
        fs::create_dir_all(&logs).unwrap();
        for d in [
            "home",
            "home/agent",
            "home/agent/.cache",
            "home/agent/.cache/cube",
        ] {
            fs::set_permissions(root.join(d), fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::write(logs.join("setup.status"), "ok 1 2\n").unwrap();
        // Root's alone, as a link or hard link to a root file would be.
        fs::write(logs.join("resume.status"), "failed:1 1 2\n").unwrap();
        fs::set_permissions(
            logs.join("resume.status"),
            fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        let nobody = Account {
            uid: 65534,
            gid: 65534,
            groups: vec![65534],
            home: "/home/agent".into(),
        };
        let as_account = Hooks {
            root,
            account: &nobody,
            reader: Some(&nobody),
        };
        assert_eq!(
            as_account.outcomes(),
            BTreeMap::from([("setup".to_string(), "ok".to_string())])
        );
        let as_root = Hooks {
            root,
            account: &nobody,
            reader: None,
        };
        assert_eq!(as_root.outcomes().len(), 2);
        assert_eq!(unsafe { libc::geteuid() }, 0, "this thread is still root");
    }
}
