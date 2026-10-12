//! `cube service`'s services, cube-guest's `SystemdServices` without
//! systemd: a registration per service in the journal's state
//! (`state/services/NAME.json`, the same record cube-guest keeps), one
//! cgroup per service (`/sys/fs/cgroup/cube-services/NAME`), a restart
//! loop with systemd's limits (`Restart=on-failure`, 2 s apart, at most 5
//! starts in 60 s, then `failed`), a bounded log per service
//! (`state/services/NAME.log`, 1 MiB, then one older `.log.1`), and every
//! registered command started again when a boot's first `machine_setup`
//! has assembled the root. Also cubed's portal settings (`portal`) and the
//! `services` operation.
//!
//! A service's main process is `cube-agent service-run REGISTRY RUN NAME`:
//! it detaches, runs the registration's command as the workload's `agent`
//! in the workload root (as `wrap` runs a command), copies its output into
//! the log and writes `RUN/NAME.exit` before it ends. It stays in the
//! service's cgroup, so an agent that starts again finds it running.
use std::{
    collections::{BTreeMap, VecDeque},
    ffi::OsStr,
    fs,
    io::{self, Read, Seek, Write},
    net::{SocketAddr, TcpStream, UdpSocket},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

use crate::{
    domain::Domain,
    files::{read_json, write_atomic, write_json},
    journal::{Answer, Fail, Launch},
    wrap,
};

pub const MAX_SERVICES: usize = 16;
pub const MIN_PORT: i64 = 1024;
pub const MAX_COMMAND_BYTES: usize = 8192;
/// A log file's size before it becomes `.log.1` (the older one is dropped).
pub const LOG_BYTES: u64 = 1 << 20;
const RESTART_DELAY: Duration = Duration::from_secs(2);
const START_LIMIT: usize = 5;
const START_INTERVAL: Duration = Duration::from_secs(60);
const TICK: Duration = Duration::from_millis(200);
/// The runner's address on the machine's private link (keel plan, "Network").
const RUNNER_ADDRESS: &str = "192.168.127.1:9";

/// `^[a-z](?:[a-z0-9-]{0,22}[a-z0-9])?$`, cube-guest's `SERVICE_NAME`.
pub fn valid_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 24
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && (bytes.len() == 1 || bytes[bytes.len() - 1] != b'-')
}

/// `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, cube-guest's `ENV_NAME`.
pub fn valid_env_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .enumerate()
            .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
}

/// `^http://\{name\}-[a-z0-9]{1,32}\.[a-z0-9.-]{1,200}(?::[0-9]{1,5})?/$`,
/// cube-guest's `PORTAL_TEMPLATE`.
pub fn valid_portal_template(template: &str) -> bool {
    let Some(rest) = template
        .strip_prefix("http://{name}-")
        .and_then(|rest| rest.strip_suffix('/'))
    else {
        return false;
    };
    let Some((label, rest)) = rest.split_once('.') else {
        return false;
    };
    let lower_digit = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    if label.is_empty() || label.len() > 32 || !label.bytes().all(lower_digit) {
        return false;
    }
    // The host part is greedy in the expression; it cannot hold a colon, so
    // the first colon starts the port.
    let (host, port) = match rest.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (rest, None),
    };
    !host.is_empty()
        && host.len() <= 200
        && host
            .bytes()
            .all(|b| lower_digit(b) || b == b'.' || b == b'-')
        && port
            .is_none_or(|p| !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit()))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// Where a machine keeps its services.
#[derive(Clone, Debug)]
pub struct Paths {
    /// Registrations and logs (`state/services`, on the writable disk).
    pub registry: PathBuf,
    /// This boot's state (`/run/keel/services`): `launch.json`, `booted`,
    /// `NAME.state`, `NAME.exit`.
    pub run: PathBuf,
    /// cubed's portal settings (`state/portal.json`).
    pub portal: PathBuf,
    /// The workload root as the agent sees it (`--cwd` is checked in it).
    pub root: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum State {
    /// It runs.
    Active,
    /// It ended with a failure and starts again at `retry`.
    Activating,
    /// It ended with status 0 (not restarted, as `Restart=on-failure`).
    Inactive,
    /// It failed too often, or could not be started.
    Failed,
}

impl State {
    fn name(self) -> &'static str {
        match self {
            State::Active => "active",
            State::Activating => "activating",
            State::Inactive => "inactive",
            State::Failed => "failed",
        }
    }
    fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "active" => State::Active,
            "activating" => State::Activating,
            "inactive" => State::Inactive,
            "failed" => State::Failed,
            _ => return None,
        })
    }
}

struct Unit {
    state: State,
    /// Automatic restarts since the last start by `cube service`.
    restarts: u32,
    /// Starts within the limit's interval.
    starts: VecDeque<Instant>,
    retry: Option<Instant>,
    /// When it last started (`inactive` soon after a start means it exited).
    since: Instant,
}

/// What `cube service` and the portal see of one service's process.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Status {
    pub state: String,
    pub sub: String,
    pub restarts: u32,
    pub since_start: Duration,
}

pub struct Services {
    pub paths: Paths,
    domain: Arc<dyn Domain>,
    /// `cube-agent`, run again as `cube-agent service-run`.
    exe: PathBuf,
    /// The launch spec (as an operation's `launch.json`), from `machine_setup`.
    launch: Mutex<Option<Value>>,
    units: Mutex<BTreeMap<String, Unit>>,
    /// Where the portal reaches services; None: found from the machine's routes.
    host: Option<String>,
    /// Template publishing took the machine: nothing is started any more.
    halted: std::sync::atomic::AtomicBool,
}

impl Services {
    /// Opens the services of this machine. After an agent restart within
    /// the same boot, `RUN/launch.json` is there: supervision goes on at once
    /// and running services are found again by their cgroups.
    pub fn open(
        paths: Paths,
        domain: Arc<dyn Domain>,
        exe: PathBuf,
        host: Option<String>,
    ) -> io::Result<Arc<Self>> {
        fs::create_dir_all(&paths.run)?;
        let services = Arc::new(Self {
            launch: Mutex::new(read_json(&paths.run.join("launch.json")).ok().flatten()),
            paths,
            domain,
            exe,
            units: Mutex::new(BTreeMap::new()),
            host,
            halted: Default::default(),
        });
        if services.launch.lock().unwrap().is_some() {
            services.adopt();
        }
        Ok(services)
    }

    /// The agent account of the newest setup (None before the first).
    pub fn account(&self) -> Option<crate::journal::Account> {
        let launch = self.launch.lock().unwrap();
        let account = launch.as_ref()?.get("account")?;
        Some(crate::journal::Account {
            uid: account["uid"].as_u64()? as u32,
            gid: account["gid"].as_u64()? as u32,
            groups: account["groups"]
                .as_array()?
                .iter()
                .filter_map(|g| g.as_u64().map(|g| g as u32))
                .collect(),
            home: account["home"].as_str()?.to_string(),
        })
    }

    /// The launch spec from `machine_setup`. The first one of a boot starts
    /// every registered command; later ones (another connection, an agent
    /// restart) only replace the spec.
    pub fn set_launch(&self, launch: &Launch) -> io::Result<()> {
        let spec = json!({
            "workspace": launch.workspace,
            "namespace": launch.namespace,
            "account": launch.account.as_ref().map(|a| json!({"uid": a.uid, "gid": a.gid, "groups": a.groups, "home": a.home})),
            "env": launch.env,
            "root": self.paths.root,
        });
        write_json(&self.paths.run.join("launch.json"), &spec)?;
        let first = self.launch.lock().unwrap().replace(spec).is_none();
        let booted = self.paths.run.join("booted");
        if booted.exists() {
            if first {
                self.adopt();
            }
            return Ok(());
        }
        let mut units = self.units.lock().unwrap();
        for record in self.registrations() {
            if record["kind"] == "command" {
                let name = record["name"].as_str().unwrap_or_default().to_string();
                let mut unit = Unit::new();
                self.launch_unit(&name, &mut unit);
                units.insert(name, unit);
            }
        }
        drop(units);
        write_atomic(&booted, b"", 0o600)
    }

    /// The agent started again: running services are found by their
    /// cgroups, the others take up their state from this boot.
    fn adopt(&self) {
        let mut units = self.units.lock().unwrap();
        for record in self.registrations() {
            if record["kind"] != "command" {
                continue;
            }
            let name = record["name"].as_str().unwrap_or_default().to_string();
            let saved = read_json(&self.paths.run.join(format!("{name}.state")))
                .ok()
                .flatten()
                .unwrap_or(Value::Null);
            let mut unit = Unit::new();
            unit.restarts = saved["restarts"].as_u64().unwrap_or(0) as u32;
            unit.state = saved["state"]
                .as_str()
                .and_then(State::parse)
                .unwrap_or(State::Inactive);
            if self.domain.populated(&name) {
                unit.state = State::Active;
            } else if unit.state == State::Active {
                // It ended while no agent watched: as if it ended now.
                self.ended(&name, &mut unit);
            } else if unit.state == State::Activating {
                unit.retry = Some(Instant::now());
            }
            units.insert(name, unit);
        }
    }

    pub fn spawn_supervisor(self: &Arc<Self>) {
        let services = Arc::clone(self);
        let _ = std::thread::Builder::new()
            .name("services".into())
            .spawn(move || {
                loop {
                    services.tick();
                    std::thread::sleep(TICK);
                }
            });
    }

    /// One look at every service: an ended one is recorded and, when it
    /// failed, started again after the delay unless it hit the limit.
    pub fn tick(&self) {
        let mut units = self.units.lock().unwrap();
        if self.halted.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let names: Vec<String> = units.keys().cloned().collect();
        for name in names {
            let unit = units.get_mut(&name).unwrap();
            match unit.state {
                State::Active if !self.domain.populated(&name) => self.ended(&name, unit),
                State::Activating if unit.retry.is_some_and(|at| Instant::now() >= at) => {
                    // Stopped meanwhile: nothing to start again.
                    if self.registration(&name).is_none() {
                        units.remove(&name);
                        continue;
                    }
                    unit.restarts += 1;
                    self.launch_unit(&name, unit);
                }
                _ => {}
            }
        }
    }

    fn ended(&self, name: &str, unit: &mut Unit) {
        let exit = read_json(&self.paths.run.join(format!("{name}.exit")))
            .ok()
            .flatten();
        self.domain.remove(name);
        let succeeded = exit
            .as_ref()
            .is_some_and(|e| e["exitCode"].as_i64() == Some(0));
        let now = Instant::now();
        while unit
            .starts
            .front()
            .is_some_and(|&at| now.duration_since(at) > START_INTERVAL)
        {
            unit.starts.pop_front();
        }
        unit.retry = None;
        unit.state = if succeeded {
            State::Inactive
        } else if unit.starts.len() >= START_LIMIT {
            eprintln!(
                "cube-agent: service {name} failed {START_LIMIT} times in a minute; not restarting it"
            );
            State::Failed
        } else {
            unit.retry = Some(now + RESTART_DELAY);
            State::Activating
        };
        self.save(name, unit);
    }

    /// Starts the service's main process in a new cgroup.
    fn launch_unit(&self, name: &str, unit: &mut Unit) {
        let _ = fs::remove_file(self.paths.run.join(format!("{name}.exit")));
        self.domain.remove(name);
        let args: [&OsStr; 4] = [
            OsStr::new("service-run"),
            self.paths.registry.as_os_str(),
            self.paths.run.as_os_str(),
            OsStr::new(name),
        ];
        unit.since = Instant::now();
        unit.starts.push_back(unit.since);
        unit.retry = None;
        unit.state = match self.domain.start(name, &self.exe, &args) {
            Ok(()) => State::Active,
            Err(error) => {
                eprintln!("cube-agent: service {name} did not start: {error}");
                State::Failed
            }
        };
        self.save(name, unit);
    }

    fn save(&self, name: &str, unit: &Unit) {
        let _ = write_json(
            &self.paths.run.join(format!("{name}.state")),
            &json!({"state": unit.state.name(), "restarts": unit.restarts}),
        );
    }

    /// Kills the service's processes and waits (5 s) until they are gone.
    fn kill(&self, name: &str) {
        self.domain.kill(name);
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.domain.populated(name) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        self.domain.remove(name);
    }

    /// (Re)starts a registered command now, as `cube service start` and
    /// `restart` do: the old process goes, the restart count and the limit
    /// start over.
    pub fn start(&self, name: &str) -> Result<(), Fail> {
        if self.halted.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(Fail::new(
                "IO_ERROR",
                "this machine is being published as a template",
            ));
        }
        if self.launch.lock().unwrap().is_none() {
            return Err(Fail::new("IO_ERROR", "the workload root is not assembled"));
        }
        let mut units = self.units.lock().unwrap();
        self.kill(name);
        let mut unit = Unit::new();
        self.launch_unit(name, &mut unit);
        let failed = unit.state == State::Failed;
        units.insert(name.into(), unit);
        if failed {
            return Err(Fail::new(
                "IO_ERROR",
                format!("service {name} could not be started"),
            ));
        }
        Ok(())
    }

    /// No service starts again or anew from now on; running ones are left
    /// to the caller (the shutdown sends them SIGTERM first).
    pub fn hold(&self) {
        let _units = self.units.lock().unwrap();
        self.halted.store(true, std::sync::atomic::Ordering::SeqCst);
    }

    /// Template publishing: the supervisor starts nothing again and every
    /// service's processes are killed (their registrations stay in state/,
    /// which no template holds).
    pub fn halt(&self) {
        let mut units = self.units.lock().unwrap();
        self.halted.store(true, std::sync::atomic::Ordering::SeqCst);
        for name in units.keys().cloned().collect::<Vec<_>>() {
            self.kill(&name);
        }
        units.clear();
    }

    /// Stops a service and forgets its process (not its registration).
    pub fn remove(&self, name: &str) {
        let mut units = self.units.lock().unwrap();
        units.remove(name);
        self.kill(name);
        for suffix in ["state", "exit"] {
            let _ = fs::remove_file(self.paths.run.join(format!("{name}.{suffix}")));
        }
        for suffix in ["log", "log.1"] {
            let _ = fs::remove_file(self.paths.registry.join(format!("{name}.{suffix}")));
        }
    }

    /// systemd's ActiveState, SubState and NRestarts, as cube-guest reads them.
    pub fn status(&self, name: &str) -> Status {
        let units = self.units.lock().unwrap();
        match units.get(name) {
            None => Status {
                state: "missing".into(),
                sub: String::new(),
                restarts: 0,
                since_start: Duration::ZERO,
            },
            Some(unit) => Status {
                state: unit.state.name().into(),
                sub: match unit.state {
                    State::Active => "running",
                    State::Activating => "auto-restart",
                    State::Inactive => "dead",
                    State::Failed => "failed",
                }
                .into(),
                restarts: unit.restarts,
                since_start: unit.since.elapsed(),
            },
        }
    }

    // --- registrations --------------------------------------------------

    pub fn registration(&self, name: &str) -> Option<Value> {
        if !valid_name(name) {
            return None;
        }
        self.registrations()
            .into_iter()
            .find(|record| record["name"] == name)
    }

    /// The valid registrations, by name.
    pub fn registrations(&self) -> Vec<Value> {
        let Ok(entries) = fs::read_dir(&self.paths.registry) else {
            return vec![];
        };
        let mut names: Vec<String> = entries
            .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
            .filter_map(|file| Some(file.strip_suffix(".json")?.to_string()))
            .filter(|name| valid_name(name))
            .collect();
        names.sort();
        names
            .into_iter()
            .filter_map(|name| {
                let record = read_json(&self.paths.registry.join(format!("{name}.json")))
                    .ok()
                    .flatten()?;
                let port = record["port"].as_i64()?;
                (record["name"] == name.as_str()
                    && (MIN_PORT..=65535).contains(&port)
                    && (record["kind"] == "command" || record["kind"] == "external"))
                    .then_some(record)
            })
            .collect()
    }

    /// Saves a registration; `started` or `replaced`. Usage errors as text.
    pub fn register(&self, record: Value) -> Result<&'static str, String> {
        let _one = self.units.lock().unwrap();
        let current = self.registrations();
        let name = record["name"].as_str().unwrap_or_default().to_string();
        let name = name.as_str();
        if let Some(other) = current
            .iter()
            .find(|other| other["name"] != name && other["port"] == record["port"])
        {
            return Err(format!(
                "port {} is already service {}",
                record["port"],
                other["name"].as_str().unwrap_or_default()
            ));
        }
        let existing = current.iter().any(|other| other["name"] == name);
        if !existing && current.len() >= MAX_SERVICES {
            return Err(format!(
                "a machine has at most {MAX_SERVICES} services; stop one first"
            ));
        }
        let mut record = record;
        record["createdAt"] = json!(now_ms());
        fs::create_dir_all(&self.paths.registry)
            .and_then(|()| write_json(&self.paths.registry.join(format!("{name}.json")), &record))
            .map_err(|error| format!("cannot save the registration: {error}"))?;
        Ok(if existing { "replaced" } else { "started" })
    }

    /// Removes a registration (off the portal); returns what it was.
    pub fn drop_registration(&self, name: &str) -> Option<Value> {
        let _one = self.units.lock().unwrap();
        let record = self.registration(name)?;
        let _ = fs::remove_file(self.paths.registry.join(format!("{name}.json")));
        let _ = crate::files::fsync_dir(&self.paths.registry);
        Some(record)
    }

    // --- portal ---------------------------------------------------------

    pub fn portal_settings(&self) -> Value {
        read_json(&self.paths.portal)
            .ok()
            .flatten()
            .filter(Value::is_object)
            .unwrap_or_else(|| json!({}))
    }

    pub fn url(&self, name: &str) -> Option<String> {
        self.portal_settings()["urlTemplate"]
            .as_str()
            .map(|template| template.replace("{name}", name))
    }

    pub fn no_portal_reason(&self) -> String {
        self.portal_settings()["reason"]
            .as_str()
            .filter(|reason| !reason.is_empty())
            .unwrap_or("cube has not configured a portal for this machine yet")
            .to_string()
    }

    /// The `portal` operation: cubed's URL template, or why there is none.
    pub fn portal(&self, header: &Value) -> Answer {
        let portal = header
            .get("portal")
            .filter(|p| p.is_object())
            .ok_or_else(|| Fail::invalid("portal must be an object"))?;
        let template = &portal["urlTemplate"];
        let reason = &portal["reason"];
        if !template.is_null() && !template.as_str().is_some_and(valid_portal_template) {
            return Err(Fail::invalid("invalid portal url template"));
        }
        if template.is_null()
            && !reason
                .as_str()
                .is_some_and(|r| !r.is_empty() && r.chars().count() <= 300)
        {
            return Err(Fail::invalid(
                "a portal without url template needs a reason",
            ));
        }
        let value = match template.as_str().filter(|t| !t.is_empty()) {
            Some(template) => json!({"urlTemplate": template}),
            None => json!({"reason": reason}),
        };
        if let Some(parent) = self.paths.portal.parent() {
            fs::create_dir_all(parent)?;
        }
        write_atomic(&self.paths.portal, value.to_string().as_bytes(), 0o644)?;
        Ok((value, vec![]))
    }

    /// The `services` operation: every registration, for the portal and
    /// the thread view.
    pub fn list(&self, header: &Value) -> Answer {
        let probe = header.get("probe") == Some(&Value::Bool(true));
        let views: Vec<Value> = self
            .registrations()
            .iter()
            .map(|record| self.view(record, probe))
            .collect();
        Ok((json!({"services": views}), vec![]))
    }

    /// One service as cube-guest's `service_view` shows it.
    pub fn view(&self, record: &Value, probe: bool) -> Value {
        let name = record["name"].as_str().unwrap_or_default();
        let mut view = json!({
            "name": name, "port": record["port"], "kind": record["kind"],
            "url": self.url(name), "createdAt": record["createdAt"],
        });
        if record["kind"] == "command" {
            let status = self.status(name);
            view["command"] = record["command"].clone();
            view["cwd"] = record["cwd"].clone();
            view["state"] = json!(status.state);
            view["restarts"] = json!(status.restarts);
        }
        if probe {
            let port = record["port"].as_u64().unwrap_or(0) as u16;
            view["listening"] = json!(listening(&self.service_host(), port));
        }
        view
    }

    /// Where the portal reaches services: the machine's address on its
    /// private link to the runner, or 127.0.0.1 while it has none (a keel
    /// machine has no network before berth's netstack, B-4).
    pub fn service_host(&self) -> String {
        if let Some(host) = &self.host {
            return host.clone();
        }
        UdpSocket::bind("0.0.0.0:0")
            .and_then(|socket| {
                socket.connect(RUNNER_ADDRESS)?;
                socket.local_addr()
            })
            .map(|address| address.ip().to_string())
            .unwrap_or_else(|_| "127.0.0.1".into())
    }

    // --- logs -----------------------------------------------------------

    pub fn log(&self, name: &str) -> PathBuf {
        self.paths.registry.join(format!("{name}.log"))
    }

    /// The last `lines` lines of the service's output (both log files).
    pub fn log_tail(&self, name: &str, lines: usize) -> String {
        let mut text = Vec::new();
        for path in [
            self.paths.registry.join(format!("{name}.log.1")),
            self.log(name),
        ] {
            if let Ok(bytes) = fs::read(path) {
                text.extend(bytes);
            }
        }
        let text = String::from_utf8_lossy(&text);
        let all: Vec<&str> = text.lines().collect();
        let mut tail = all[all.len().saturating_sub(lines)..].join("\n");
        if !tail.is_empty() {
            tail.push('\n');
        }
        tail
    }
}

impl Unit {
    fn new() -> Self {
        Self {
            state: State::Inactive,
            restarts: 0,
            starts: VecDeque::new(),
            retry: None,
            since: Instant::now(),
        }
    }
}

pub fn listening(host: &str, port: u16) -> bool {
    let Ok(ip) = host.parse() else {
        return false;
    };
    TcpStream::connect_timeout(&SocketAddr::new(ip, port), Duration::from_secs(1)).is_ok()
}

/// The status line a `GET /` answers with, or why there is none.
pub fn http_probe(host: &str, port: u16, host_header: &str) -> (Option<u16>, String) {
    let attempt = || -> io::Result<Vec<u8>> {
        let ip = host.parse().map_err(io::Error::other)?;
        let timeout = Duration::from_secs(5);
        let mut connection = TcpStream::connect_timeout(&SocketAddr::new(ip, port), timeout)?;
        connection.set_read_timeout(Some(timeout))?;
        connection.set_write_timeout(Some(timeout))?;
        connection.write_all(
            format!("GET / HTTP/1.1\r\nHost: {host_header}\r\nUser-Agent: cube-service\r\nAccept: */*\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )?;
        let mut data = Vec::new();
        let mut chunk = [0u8; 4096];
        while !data.windows(2).any(|w| w == b"\r\n") && data.len() < 4096 {
            let n = connection.read(&mut chunk)?;
            if n == 0 {
                break;
            }
            data.extend_from_slice(&chunk[..n]);
        }
        Ok(data)
    };
    let data = match attempt() {
        Ok(data) => data,
        Err(error) => return (None, format!("no HTTP answer ({error})")),
    };
    let text = String::from_utf8_lossy(&data);
    let line = text.split("\r\n").next().unwrap_or_default().to_string();
    let status = line
        .strip_prefix("HTTP/1.")
        .filter(|rest| rest.starts_with(['0', '1']) && rest.as_bytes().get(1) == Some(&b' '))
        .and_then(|rest| rest.get(2..5))
        .filter(|code| code.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|code| code.parse().ok());
    match status {
        Some(code) => (Some(code), line),
        None if data.is_empty() => (None, "it closed the connection without an answer".into()),
        None => (None, "it answers, but not with HTTP/1.x".into()),
    }
}

// --- `cube-agent service-run REGISTRY RUN NAME` -------------------------------

/// A service's main process; returns the process exit status.
pub fn service_run(registry: &Path, run: &Path, name: &str) -> i32 {
    // Detach, as `wrap` does: the agent waits only for the first process.
    match unsafe { libc::fork() } {
        -1 => return 1,
        0 => {}
        _ => return 0,
    }
    let (code, signal) = match run_service(registry, run, name) {
        Ok(status) => wrap::exit_json(status),
        Err(error) => {
            eprintln!("cube-agent service-run {name}: {error}");
            (json!(1), Value::Null)
        }
    };
    let _ = write_json(
        &run.join(format!("{name}.exit")),
        &json!({"exitCode": code, "signal": signal}),
    );
    0
}

fn run_service(registry: &Path, run: &Path, name: &str) -> io::Result<i32> {
    if !valid_name(name) {
        return Err(io::Error::other("not a service name"));
    }
    let record = read_json(&registry.join(format!("{name}.json")))?
        .filter(|record| record["kind"] == "command")
        .ok_or_else(|| io::Error::other("not registered"))?;
    let launch = read_json(&run.join("launch.json"))?
        .ok_or_else(|| io::Error::other("the workload root is not assembled"))?;
    let cwd = record["cwd"].as_str().unwrap_or("/workspace");
    // Without a namespace (tests), workload paths are under the root.
    let cwd = if launch["namespace"].is_string() {
        cwd.to_string()
    } else {
        format!(
            "{}/{}",
            launch["root"].as_str().unwrap_or_default(),
            cwd.trim_start_matches('/')
        )
    };
    let mut extra: Vec<(String, String)> = record["env"]
        .as_object()
        .map(|env| {
            env.iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string()))
                .collect()
        })
        .unwrap_or_default();
    extra.extend([
        ("PORT".into(), record["port"].to_string()),
        ("HOST".into(), "0.0.0.0".into()),
        ("CUBE_SERVICE".into(), name.into()),
    ]);
    let prepared = wrap::Prepared::new(
        &launch,
        cwd,
        record["command"].as_str().unwrap_or(""),
        &extra,
    )?;
    let (reader, writer) = wrap::pipe()?;
    let mut log = Log::open(registry, name)?;
    let pid = prepared.spawn(writer)?;
    let mut reader = fs::File::from(reader);
    let mut buffer = vec![0; 65536];
    loop {
        let n = match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error),
        };
        // A full disk must not stop the service: its output is dropped.
        let _ = log.write(&buffer[..n]);
    }
    wrap::wait(pid)
}

/// A service's log: appended to, and moved to `.log.1` when it would
/// pass `LOG_BYTES` (the previous `.log.1` is dropped).
struct Log {
    path: PathBuf,
    older: PathBuf,
    file: fs::File,
    size: u64,
}

impl Log {
    fn open(registry: &Path, name: &str) -> io::Result<Self> {
        let path = registry.join(format!("{name}.log"));
        let mut file = Self::append(&path)?;
        let size = file.seek(io::SeekFrom::End(0))?;
        Ok(Self {
            older: registry.join(format!("{name}.log.1")),
            path,
            file,
            size,
        })
    }

    fn append(path: &Path) -> io::Result<fs::File> {
        fs::OpenOptions::new()
            .append(true)
            .create(true)
            .mode(0o600)
            .open(path)
    }

    fn write(&mut self, mut data: &[u8]) -> io::Result<()> {
        while !data.is_empty() {
            if self.size >= LOG_BYTES {
                fs::rename(&self.path, &self.older)?;
                self.file = Self::append(&self.path)?;
                self.size = 0;
            }
            let room = (LOG_BYTES - self.size) as usize;
            let part = &data[..room.min(data.len())];
            self.file.write_all(part)?;
            self.size += part.len() as u64;
            data = &data[part.len()..];
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_templates_are_cube_guests() {
        for name in ["a", "web", "a-b", "x1", "abcdefghijklmnopqrstuvwx"] {
            assert!(valid_name(name), "{name}");
        }
        for name in [
            "",
            "Web",
            "1a",
            "a-",
            "-a",
            "a_b",
            "web\n",
            "abcdefghijklmnopqrstuvwxy",
            "a.b",
        ] {
            assert!(!valid_name(name), "{name:?}");
        }
        for template in [
            "http://{name}-0123456789.100-64-0-1.sslip.io:7780/",
            "http://{name}-x.example/",
        ] {
            assert!(valid_portal_template(template), "{template}");
        }
        for template in [
            "https://{name}-x.example/",
            "http://evil/{name}",
            "http://{name}-X.example/",
            "http://{name}-x.example",
            "http://{name}-x.example:/",
            "http://{name}-x.example:123456/",
            "http://{name}-x.ex/ample/",
            "http://{name}-.example/",
            "http://{name}-x./",
        ] {
            assert!(!valid_portal_template(template), "{template}");
        }
        assert!(valid_env_name("GREETING") && valid_env_name("_x1"));
        assert!(!valid_env_name("1X") && !valid_env_name("A-B") && !valid_env_name(""));
    }

    #[test]
    fn the_log_is_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let mut log = Log::open(dir.path(), "web").unwrap();
        let chunk = vec![b'x'; 300 * 1024];
        for _ in 0..8 {
            log.write(&chunk).unwrap();
        }
        let size = |name: &str| fs::metadata(dir.path().join(name)).unwrap().len();
        assert_eq!(size("web.log.1"), LOG_BYTES);
        assert_eq!(size("web.log"), 8 * 300 * 1024 - 2 * LOG_BYTES);
        // Opened again, it goes on from its size.
        let mut log = Log::open(dir.path(), "web").unwrap();
        log.write(&vec![b'y'; LOG_BYTES as usize]).unwrap();
        assert_eq!(size("web.log.1"), LOG_BYTES);
        assert!(size("web.log") < LOG_BYTES);
    }

    #[test]
    fn http_status_lines_are_read() {
        use std::net::TcpListener;
        let answer = |reply: &'static [u8]| {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0u8; 1024];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(reply);
            });
            http_probe("127.0.0.1", port, "x")
        };
        assert_eq!(
            answer(b"HTTP/1.1 200 OK\r\n\r\n"),
            (Some(200), "HTTP/1.1 200 OK".into())
        );
        assert_eq!(
            answer(b"SSH-2.0-x\r\n").1,
            "it answers, but not with HTTP/1.x"
        );
        assert_eq!(answer(b"").1, "it closed the connection without an answer");
    }

    /// The supervisor against a scripted domain (T1): no process runs; the
    /// test says which groups are populated and how each process ended.
    #[derive(Default)]
    struct Script {
        populated: Mutex<std::collections::HashSet<String>>,
        starts: Mutex<Vec<String>>,
        refuse: std::sync::atomic::AtomicBool,
    }
    impl Domain for Script {
        fn start(&self, id: &str, _: &Path, _: &[&OsStr]) -> io::Result<()> {
            if self.refuse.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(io::Error::other("refused"));
            }
            self.starts.lock().unwrap().push(id.into());
            self.populated.lock().unwrap().insert(id.into());
            Ok(())
        }
        fn exists(&self, id: &str) -> bool {
            self.populated(id)
        }
        fn populated(&self, id: &str) -> bool {
            self.populated.lock().unwrap().contains(id)
        }
        fn kill(&self, id: &str) {
            self.populated.lock().unwrap().remove(id);
        }
        fn memory(&self, _: &str) -> Option<Value> {
            None
        }
        fn remove(&self, _: &str) {}
    }

    struct Bench {
        _dir: tempfile::TempDir,
        paths: Paths,
        script: Arc<Script>,
    }

    impl Bench {
        fn new(names: &[&str]) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let paths = Paths {
                registry: dir.path().join("registry"),
                run: dir.path().join("run"),
                portal: dir.path().join("portal.json"),
                root: dir.path().join("root"),
            };
            fs::create_dir_all(&paths.registry).unwrap();
            for (i, name) in names.iter().enumerate() {
                write_json(
                    &paths.registry.join(format!("{name}.json")),
                    &json!({"name": name, "port": 8000 + i, "kind": "command", "command": "x", "cwd": "/workspace"}),
                )
                .unwrap();
            }
            Self {
                _dir: dir,
                paths,
                script: Arc::new(Script::default()),
            }
        }
        fn open(&self) -> Arc<Services> {
            Services::open(
                self.paths.clone(),
                self.script.clone(),
                "/sbin/cube-agent".into(),
                Some("127.0.0.1".into()),
            )
            .unwrap()
        }
        fn launch(&self, services: &Services) {
            services
                .set_launch(&Launch {
                    workspace: "/workspace".into(),
                    namespace: None,
                    account: None,
                    env: Default::default(),
                })
                .unwrap();
        }
        /// The service's process ends with `code`, as `service-run` records it.
        fn end(&self, name: &str, code: i64) {
            write_json(
                &self.paths.run.join(format!("{name}.exit")),
                &json!({"exitCode": code}),
            )
            .unwrap();
            self.script.populated.lock().unwrap().remove(name);
        }
        fn starts(&self) -> usize {
            self.script.starts.lock().unwrap().len()
        }
    }

    fn state(services: &Services, name: &str) -> (State, u32) {
        let units = services.units.lock().unwrap();
        let unit = &units[name];
        (unit.state, unit.restarts)
    }

    /// The retry is due now (instead of RESTART_DELAY from now).
    fn due(services: &Services, name: &str) {
        let mut units = services.units.lock().unwrap();
        let unit = units.get_mut(name).unwrap();
        assert!(unit.retry.is_some(), "a retry is set");
        unit.retry = Some(Instant::now());
    }

    #[test]
    fn a_service_that_exits_0_is_not_started_again() {
        let bench = Bench::new(&["web"]);
        let services = bench.open();
        bench.launch(&services);
        assert_eq!(state(&services, "web"), (State::Active, 0));
        assert_eq!(bench.starts(), 1, "the boot's first setup starts it");
        bench.launch(&services);
        assert_eq!(bench.starts(), 1, "a later setup does not");
        services.tick();
        assert_eq!(state(&services, "web"), (State::Active, 0), "still running");
        bench.end("web", 0);
        services.tick();
        assert_eq!(state(&services, "web"), (State::Inactive, 0));
        services.tick();
        assert_eq!(bench.starts(), 1);
    }

    #[test]
    fn a_failed_service_starts_again_after_the_delay() {
        let bench = Bench::new(&["web"]);
        let services = bench.open();
        bench.launch(&services);
        bench.end("web", 3);
        services.tick();
        assert_eq!(state(&services, "web"), (State::Activating, 0));
        services.tick();
        assert_eq!(bench.starts(), 1, "not before the delay");
        due(&services, "web");
        services.tick();
        assert_eq!(state(&services, "web"), (State::Active, 1));
        assert_eq!(bench.starts(), 2);
        // No exit file (killed): a failure too.
        bench.script.populated.lock().unwrap().remove("web");
        services.tick();
        assert_eq!(state(&services, "web"), (State::Activating, 1));
    }

    #[test]
    fn five_starts_in_a_minute_are_the_limit() {
        let bench = Bench::new(&["web"]);
        let services = bench.open();
        bench.launch(&services);
        for restart in 1..START_LIMIT as u32 {
            bench.end("web", 1);
            services.tick();
            due(&services, "web");
            services.tick();
            assert_eq!(state(&services, "web"), (State::Active, restart));
        }
        assert_eq!(bench.starts(), START_LIMIT);
        bench.end("web", 1);
        services.tick();
        assert_eq!(state(&services, "web"), (State::Failed, 4));
        services.tick();
        assert_eq!(bench.starts(), START_LIMIT, "failed stays failed");
        // `cube service start` starts it over: the count and the limit reset.
        services.start("web").unwrap();
        assert_eq!(state(&services, "web"), (State::Active, 0));
        // A start the domain refuses is failed at once.
        bench
            .script
            .refuse
            .store(true, std::sync::atomic::Ordering::SeqCst);
        assert!(services.start("web").is_err());
        assert_eq!(state(&services, "web"), (State::Failed, 0));
    }

    #[test]
    fn a_service_stopped_while_it_waits_is_forgotten() {
        let bench = Bench::new(&["web"]);
        let services = bench.open();
        bench.launch(&services);
        bench.end("web", 1);
        services.tick();
        assert!(services.drop_registration("web").is_some());
        due(&services, "web");
        services.tick();
        assert!(!services.units.lock().unwrap().contains_key("web"));
        assert_eq!(bench.starts(), 1, "never started again");
    }

    #[test]
    fn an_agent_that_starts_again_takes_up_this_boot_s_state() {
        let bench = Bench::new(&["gone", "kept", "stopped", "waiting"]);
        let services = bench.open();
        bench.launch(&services);
        assert_eq!(bench.starts(), 4);
        bench.end("stopped", 0);
        services.tick();
        assert_eq!(state(&services, "stopped"), (State::Inactive, 0));
        drop(services);
        // While no agent watches: `kept` runs on, `gone` ends with a failure
        // (its saved state still says active), `waiting` was waiting for its
        // retry with 2 restarts.
        bench.end("gone", 9);
        write_json(
            &bench.paths.run.join("gone.state"),
            &json!({"state": "active", "restarts": 1}),
        )
        .unwrap();
        bench.script.populated.lock().unwrap().remove("waiting");
        write_json(
            &bench.paths.run.join("waiting.state"),
            &json!({"state": "activating", "restarts": 2}),
        )
        .unwrap();

        let again = bench.open();
        assert_eq!(
            state(&again, "kept"),
            (State::Active, 0),
            "found by its group"
        );
        assert_eq!(
            state(&again, "gone"),
            (State::Activating, 1),
            "ended as if now; the restart count kept"
        );
        assert_eq!(state(&again, "stopped"), (State::Inactive, 0));
        assert_eq!(state(&again, "waiting"), (State::Activating, 2));
        again.tick();
        assert_eq!(
            state(&again, "waiting"),
            (State::Active, 3),
            "its retry is due at once"
        );
        assert_eq!(bench.starts(), 5, "only `waiting` started; nothing twice");
        drop(again);

        // The next boot: /run is empty; its first setup starts every command.
        fs::remove_dir_all(&bench.paths.run).unwrap();
        let boot = bench.open();
        assert!(
            boot.units.lock().unwrap().is_empty(),
            "nothing before the setup"
        );
        bench.launch(&boot);
        assert_eq!(bench.starts(), 9);
    }
}
