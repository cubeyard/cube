//! The guest's `cube` command, over the agent socket.
//!
//! `cube` is `cube-agent` under another name (bind-mounted read-only at
//! `/usr/local/bin/cube` in the workload root). It runs as whoever calls
//! it, in the workload root, and sends its arguments and directory to the
//! agent over `/run/cube/agent.sock`; the agent does the work (cube-guest's
//! `cube service`, with the same options, texts and exit statuses) and
//! streams the output back. Only the `agent` account and root may use the
//! socket (`SO_PEERCRED`); services run as `agent` whoever asked.
//!
//! On the socket: one JSON line `{"argv": [...], "cwd": "..."}` from the
//! client, then JSON lines from the agent, `{"out": TEXT}` (stdout),
//! `{"err": TEXT}` (stderr) and last `{"exit": N}`.
use std::{
    fs,
    io::{self, BufRead, BufReader, Read, Seek, Write},
    os::{
        fd::AsRawFd,
        unix::{
            fs::PermissionsExt,
            net::{UnixListener, UnixStream},
        },
    },
    path::Path,
    sync::Arc,
    time::{Duration, Instant},
};

use serde_json::{Value, json};

use crate::{
    journal::Fail,
    services::{self, MAX_COMMAND_BYTES, MIN_PORT, Services},
};

/// The socket as the workload sees it.
pub const SOCKET: &str = "/run/cube/agent.sock";
const MAX_REQUEST_BYTES: u64 = 64 * 1024;

pub const USAGE: &str = "usage: cube service <command> [options]

Runs web servers in this machine as supervised services that outlive the
command that started them, and opens them in cube's portal.

  cube service start NAME --port PORT [--cwd DIR] [--env KEY=VALUE]... [--wait SECONDS] [--json] -- COMMAND...
      run COMMAND as service NAME (restarted when it fails and when the
      machine boots again); waits until it listens on PORT and prints its URL
  cube service open NAME --port PORT [--wait SECONDS] [--json]
      register a server that already runs outside cube service on PORT
  cube service list [--json]
  cube service status NAME [--json]
  cube service logs NAME [-n LINES] [-f]
  cube service restart NAME [--wait SECONDS] [--json]
  cube service stop NAME [--json]
      stop the service and remove it from the portal

A service gets PORT and HOST=0.0.0.0 in its environment and must listen on
0.0.0.0 (or this machine's address), not only on 127.0.0.1: the portal
reaches it over the machine's network. Ports 1024-65535; plain HTTP and
WebSocket. NAME is 1-24 lowercase letters, digits and dashes.
";

// --- the client: `cube ARGS` ----------------------------------------------

/// `cube ARGS` in the workload: asks the agent; returns the exit status.
pub fn client(args: Vec<String>, socket: &Path) -> i32 {
    let cwd = std::env::current_dir()
        .map(|dir| dir.to_string_lossy().into_owned())
        .unwrap_or_else(|_| "/".into());
    let mut stream = match UnixStream::connect(socket) {
        Ok(stream) => stream,
        Err(error) => {
            eprintln!(
                "cube: the machine's agent does not answer ({}: {error})",
                socket.display()
            );
            return 1;
        }
    };
    let mut request = json!({"argv": args, "cwd": cwd}).to_string();
    request.push('\n');
    if let Err(error) = stream.write_all(request.as_bytes()) {
        eprintln!("cube: {error}");
        return 1;
    }
    let (mut out, mut err) = (io::stdout(), io::stderr());
    for line in BufReader::new(stream).lines() {
        let Ok(line) = line else { break };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            break;
        };
        if let Some(text) = message["out"].as_str() {
            if out
                .write_all(text.as_bytes())
                .and_then(|()| out.flush())
                .is_err()
            {
                return 1;
            }
        } else if let Some(text) = message["err"].as_str() {
            let _ = err.write_all(text.as_bytes());
        } else if let Some(code) = message["exit"].as_i64() {
            return code as i32;
        }
    }
    eprintln!("cube: the machine's agent ended the answer early");
    1
}

// --- the server ---------------------------------------------------------------

/// Listens on `socket` (the workload's `/run/cube/agent.sock` as the
/// agent sees it) for `cube`, in a thread of its own. A socket left by an
/// earlier agent is replaced.
pub fn listen(services: Arc<Services>, socket: &Path, account: Option<u32>) -> io::Result<()> {
    let dir = socket.parent().unwrap_or(Path::new("/"));
    fs::create_dir_all(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o755))?;
    match fs::remove_file(socket) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
        _ => {}
    }
    let listener = UnixListener::bind(socket)?;
    // Anyone may connect; who is served is decided by the peer's uid.
    fs::set_permissions(socket, fs::Permissions::from_mode(0o666))?;
    std::thread::Builder::new()
        .name("cube".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                let services = Arc::clone(&services);
                let _ = std::thread::Builder::new()
                    .name("cube-call".into())
                    .spawn(move || serve(&services, stream, account));
            }
        })?;
    Ok(())
}

fn peer_uid(stream: &UnixStream) -> Option<u32> {
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut len,
        )
    };
    (rc == 0).then_some(cred.uid)
}

fn serve(services: &Services, stream: UnixStream, account: Option<u32>) {
    let mut out = Out {
        stream: match stream.try_clone() {
            Ok(stream) => stream,
            Err(_) => return,
        },
        json: false,
    };
    let uid = peer_uid(&stream);
    if !uid.is_some_and(|uid| uid == 0 || Some(uid) == account) {
        out.err("cube: only the agent account and root may use cube service\n");
        out.exit(1);
        return;
    }
    let mut line = String::new();
    let request = BufReader::new((&stream).take(MAX_REQUEST_BYTES))
        .read_line(&mut line)
        .ok()
        .and_then(|_| serde_json::from_str::<Value>(&line).ok());
    let argv: Option<Vec<String>> = request.as_ref().and_then(|r| {
        r["argv"]
            .as_array()?
            .iter()
            .map(|a| a.as_str().map(str::to_string))
            .collect()
    });
    let cwd = request
        .as_ref()
        .and_then(|r| r["cwd"].as_str())
        .unwrap_or("/");
    let Some(argv) = argv else {
        out.err("cube: a malformed request\n");
        out.exit(2);
        return;
    };
    let code = cli(services, &argv, cwd, &mut out);
    out.exit(code);
}

/// What the agent sends back to `cube`.
pub struct Out {
    stream: UnixStream,
    json: bool,
}

impl Out {
    fn send(&mut self, value: Value) -> bool {
        let mut line = value.to_string();
        line.push('\n');
        self.stream.write_all(line.as_bytes()).is_ok()
    }
    fn out(&mut self, text: &str) -> bool {
        self.send(json!({"out": text}))
    }
    fn err(&mut self, text: &str) {
        self.send(json!({"err": text}));
    }
    fn exit(&mut self, code: i32) {
        self.send(json!({"exit": code}));
    }
    /// Progress, only without `--json`.
    fn say(&mut self, text: &str) {
        if !self.json {
            self.out(&format!("{text}\n"));
        }
    }
    fn result(&mut self, value: &Value, text: &str) {
        let text = if self.json {
            value.to_string()
        } else {
            text.to_string()
        };
        self.out(&format!("{text}\n"));
    }
}

struct Usage(String);

impl<T: Into<String>> From<T> for Usage {
    fn from(text: T) -> Self {
        Usage(text.into())
    }
}

enum Problem {
    Usage(Usage),
    Fail(Fail),
}

impl From<Usage> for Problem {
    fn from(usage: Usage) -> Self {
        Problem::Usage(usage)
    }
}
impl From<Fail> for Problem {
    fn from(fail: Fail) -> Self {
        Problem::Fail(fail)
    }
}

/// `cube ARGV` from `caller_cwd`; the exit status.
pub fn cli(services: &Services, argv: &[String], caller_cwd: &str, out: &mut Out) -> i32 {
    let args: Vec<&str> = argv.iter().map(String::as_str).collect();
    match args.first().copied() {
        None => {
            out.out(USAGE);
            2
        }
        Some("-h" | "--help" | "help") => {
            out.out(USAGE);
            0
        }
        Some("--version") => {
            out.out(&format!("cube (cube-agent {})\n", crate::agent::VERSION));
            0
        }
        Some("hooks") => {
            out.err("cube hooks: this machine does not run hooks yet\n");
            2
        }
        Some("service") => match service(services, &args[1..], caller_cwd, out) {
            Ok(code) => code,
            Err(Problem::Usage(Usage(text))) => {
                out.err(&format!("cube service: {text}\n"));
                2
            }
            Err(Problem::Fail(fail)) => {
                out.err(&format!("cube service: {}\n", fail.message));
                1
            }
        },
        Some(other) => {
            out.err(&format!("cube: unknown command {other}\n{USAGE}"));
            2
        }
    }
}

#[derive(Default)]
struct Options<'a> {
    flags: Vec<&'a str>,
    values: Vec<(&'a str, &'a str)>,
    positionals: Vec<&'a str>,
    rest: Option<Vec<&'a str>>,
}

impl<'a> Options<'a> {
    /// cube-guest's `cli_options`: `--flag`, `--key VALUE` or `--key=VALUE`
    /// and positionals; what follows `--` as it is.
    fn parse(args: &[&'a str], flags: &[&str], values: &[&str]) -> Result<Self, Usage> {
        let mut options = Options::default();
        let mut index = 0;
        while index < args.len() {
            let arg = args[index];
            if arg == "--" {
                options.rest = Some(args[index + 1..].to_vec());
                break;
            }
            if arg.starts_with('-') && arg != "-" {
                let (key, inline) = match arg.split_once('=') {
                    Some((key, value)) => (key, Some(value)),
                    None => (arg, None),
                };
                if flags.contains(&key) && inline.is_none() {
                    options.flags.push(key);
                } else if values.contains(&key) {
                    let value = match inline {
                        Some(value) => value,
                        None => {
                            index += 1;
                            *args
                                .get(index)
                                .ok_or_else(|| Usage(format!("{key} needs a value")))?
                        }
                    };
                    options.values.push((key, value));
                } else {
                    return Err(Usage(format!("unknown option {arg}")));
                }
            } else {
                options.positionals.push(arg);
            }
            index += 1;
        }
        Ok(options)
    }
    fn flag(&self, name: &str) -> bool {
        self.flags.contains(&name)
    }
    /// The last value given for any of `names`.
    fn value(&self, names: &[&str]) -> Option<&'a str> {
        self.values
            .iter()
            .rev()
            .find(|(key, _)| names.contains(key))
            .map(|(_, value)| *value)
    }
    fn all(&self, name: &str) -> Vec<&'a str> {
        self.values
            .iter()
            .filter(|(key, _)| *key == name)
            .map(|(_, value)| *value)
            .collect()
    }
    fn name(&self) -> Result<&'a str, Usage> {
        if self.positionals.len() != 1 {
            return Err("give one service name".into());
        }
        let name = self.positionals[0];
        if !services::valid_name(name) {
            return Err(
                "a service name is 1-24 lowercase letters, digits and dashes, starting with a letter"
                    .into(),
            );
        }
        Ok(name)
    }
    fn port(&self) -> Result<i64, Usage> {
        let raw = self.value(&["--port"]).ok_or("--port is required")?;
        match raw.parse::<i64>() {
            Ok(port)
                if raw.bytes().all(|b| b.is_ascii_digit())
                    && (MIN_PORT..=65535).contains(&port) =>
            {
                Ok(port)
            }
            _ => Err(Usage(format!("--port must be {MIN_PORT}-65535"))),
        }
    }
    fn wait(&self, default: u64) -> Result<u64, Usage> {
        match self.value(&["--wait"]) {
            None => Ok(default),
            Some(raw) => raw
                .parse::<u64>()
                .ok()
                .filter(|&s| raw.bytes().all(|b| b.is_ascii_digit()) && s <= 600)
                .ok_or_else(|| "--wait is 0-600 seconds".into()),
        }
    }
}

fn indent(text: &str) -> String {
    text.lines()
        .map(|line| format!("  {line}"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn service(services: &Services, args: &[&str], cwd: &str, out: &mut Out) -> Result<i32, Problem> {
    let Some((&command, args)) = args.split_first() else {
        out.out(USAGE);
        return Ok(2);
    };
    match command {
        "-h" | "--help" | "help" => {
            out.out(USAGE);
            Ok(0)
        }
        "start" => start(services, args, cwd, out),
        "open" => open(services, args, out),
        "list" => {
            let options = Options::parse(args, &["--json"], &[])?;
            out.json = options.flag("--json");
            if !options.positionals.is_empty() {
                return Err(Usage::from("list takes no name").into());
            }
            let views: Vec<Value> = services
                .registrations()
                .iter()
                .map(|record| services.view(record, true))
                .collect();
            let text = views
                .iter()
                .map(|view| describe(services, view))
                .collect::<Vec<_>>()
                .join("\n");
            out.result(
                &json!({"services": views}),
                if text.is_empty() {
                    "no services"
                } else {
                    &text
                },
            );
            Ok(0)
        }
        "status" => status(services, args, out),
        "logs" => logs(services, args, out),
        "restart" => {
            let options = Options::parse(args, &["--json"], &["--wait"])?;
            out.json = options.flag("--json");
            let name = options.name()?;
            let wait = options.wait(60)?;
            let record = services
                .registration(name)
                .filter(|record| record["kind"] == "command")
                .ok_or_else(|| Usage(format!("no service {name} run by cube service")))?;
            services.start(name)?;
            let port = record["port"].as_u64().unwrap_or(0) as u16;
            let (ok, error, http) = healthy(services, name, port, true, wait);
            Ok(report(services, name, ok, &error, &http, out, "restarted"))
        }
        "stop" => {
            let options = Options::parse(args, &["--json"], &[])?;
            out.json = options.flag("--json");
            let name = options.name()?;
            // Off the portal first: nothing routes to a port being given up.
            let record = services.drop_registration(name);
            if record.as_ref().is_none_or(|r| r["kind"] == "command") {
                services.remove(name);
            }
            let text = if record.is_some() {
                format!("service {name} stopped")
            } else {
                format!("no service {name}")
            };
            out.result(&json!({"name": name, "stopped": record.is_some()}), &text);
            Ok(0)
        }
        other => Err(Usage(format!(
            "unknown command {other} (start, open, list, status, logs, restart, stop)"
        ))
        .into()),
    }
}

/// `--cwd` (default the caller's directory) as a path in the workload
/// root, which must be a directory there.
fn directory(services: &Services, caller: &str, given: Option<&str>) -> Result<String, Usage> {
    let joined = match given {
        Some(dir) if dir.starts_with('/') => dir.to_string(),
        Some(dir) => format!("{caller}/{dir}"),
        None => caller.to_string(),
    };
    // normpath: `.` and empty parts go, `..` takes one back (never above /).
    let mut parts: Vec<&str> = vec![];
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    let path = format!("/{}", parts.join("/"));
    let is_dir = fs::File::open(&services.paths.root)
        .and_then(|root| crate::paths::open_in_root(&root, &path))
        .map(fs::File::from)
        .and_then(|file| file.metadata())
        .is_ok_and(|meta| meta.is_dir());
    if !is_dir {
        return Err(Usage(format!("no directory {path}")));
    }
    Ok(path)
}

fn start(services: &Services, args: &[&str], cwd: &str, out: &mut Out) -> Result<i32, Problem> {
    let options = Options::parse(args, &["--json"], &["--port", "--cwd", "--wait", "--env"])?;
    out.json = options.flag("--json");
    let name = options.name()?;
    let port = options.port()?;
    let wait = options.wait(60)?;
    let rest = options.rest.clone().filter(|rest| !rest.is_empty()).ok_or(
        Usage::from("give the command after --, for example: cube service start web --port 8000 -- python3 -m http.server"),
    )?;
    // One word is a shell command line; several are quoted as they are.
    let text = if rest.len() == 1 {
        rest[0].to_string()
    } else {
        rest.iter()
            .map(|word| quote(word))
            .collect::<Vec<_>>()
            .join(" ")
    };
    if text.len() > MAX_COMMAND_BYTES || text.contains('\0') {
        return Err(Usage(format!("the command is at most {MAX_COMMAND_BYTES} bytes")).into());
    }
    let dir = directory(services, cwd, options.value(&["--cwd"]))?;
    let mut env = serde_json::Map::new();
    for item in options.all("--env") {
        match item.split_once('=') {
            Some((key, value))
                if services::valid_env_name(key)
                    && !value.contains(['\0', '\n'])
                    && key != "PORT"
                    && key != "HOST" =>
            {
                env.insert(key.into(), json!(value));
            }
            _ => return Err(Usage::from("--env takes KEY=VALUE (cube sets PORT and HOST)").into()),
        }
    }
    let verb = services
        .register(json!({"name": name, "port": port, "kind": "command", "command": text, "cwd": dir, "env": env}))
        .map_err(Usage)?;
    if let Err(fail) = services.start(name) {
        services.drop_registration(name);
        return Err(fail.into());
    }
    out.say(&format!("starting service {name} on port {port} ..."));
    let (ok, error, http) = healthy(services, name, port as u16, true, wait);
    Ok(report(services, name, ok, &error, &http, out, verb))
}

fn open(services: &Services, args: &[&str], out: &mut Out) -> Result<i32, Problem> {
    let options = Options::parse(args, &["--json"], &["--port", "--wait"])?;
    out.json = options.flag("--json");
    let name = options.name()?;
    let port = options.port()?;
    let wait = options.wait(10)?;
    if options.rest.is_some() {
        return Err(Usage::from("open takes no command; cube service start runs one").into());
    }
    let existing = services.registration(name);
    let verb = services
        .register(json!({"name": name, "port": port, "kind": "external"}))
        .map_err(Usage)?;
    if existing.is_some_and(|record| record["kind"] == "command") {
        services.remove(name);
    }
    let (ok, error, http) = healthy(services, name, port as u16, false, wait);
    let verb = if verb == "started" { "opened" } else { verb };
    Ok(report(services, name, ok, &error, &http, out, verb))
}

fn status(services: &Services, args: &[&str], out: &mut Out) -> Result<i32, Problem> {
    let options = Options::parse(args, &["--json"], &[])?;
    out.json = options.flag("--json");
    let name = options.name()?;
    let Some(record) = services.registration(name) else {
        out.result(
            &json!({"name": name, "error": "not registered"}),
            &format!("no service {name}"),
        );
        return Ok(1);
    };
    let mut view = services.view(&record, true);
    let mut text = describe(services, &view);
    if view["kind"] == "command" && (view["state"] != "active" || view["listening"] != true) {
        let tail = services.log_tail(name, 10);
        let tail = tail.trim_end();
        if !tail.is_empty() {
            text += &format!("\nlast output:\n{}", indent(tail));
        }
        view["logTail"] = json!(tail);
    }
    out.result(&view, &text);
    Ok(0)
}

fn logs(services: &Services, args: &[&str], out: &mut Out) -> Result<i32, Problem> {
    let options = Options::parse(args, &["-f", "--follow"], &["-n", "--lines"])?;
    let name = options.name()?;
    let record = services
        .registration(name)
        .ok_or_else(|| Usage(format!("no service {name}")))?;
    if record["kind"] != "command" {
        return Err(Usage(format!(
            "{name} is not run by cube service; its logs are where it runs"
        ))
        .into());
    }
    let raw = options.value(&["-n", "--lines"]).unwrap_or("100");
    let lines = raw
        .parse::<usize>()
        .ok()
        .filter(|&n| raw.bytes().all(|b| b.is_ascii_digit()) && (1..=10000).contains(&n))
        .ok_or(Usage::from("-n is 1-10000 lines"))?;
    out.out(&services.log_tail(name, lines));
    if options.flag("-f") || options.flag("--follow") {
        follow(services, name, out);
    }
    Ok(0)
}

/// `logs -f`: new output as it comes, until the caller goes or the
/// service is stopped.
fn follow(services: &Services, name: &str, out: &mut Out) {
    let path = services.log(name);
    let open = || -> Option<(fs::File, u64)> {
        let mut file = fs::File::open(&path).ok()?;
        let at = file.seek(io::SeekFrom::End(0)).ok()?;
        Some((file, at))
    };
    let mut current = open();
    let mut buffer = vec![0u8; 65536];
    loop {
        std::thread::sleep(Duration::from_millis(250));
        if services.registration(name).is_none() {
            return;
        }
        let size = fs::metadata(&path).map(|m| m.len()).ok();
        match &mut current {
            // Moved to .log.1 (or not there yet): read the new file from its start.
            Some((_, at)) if size.is_none_or(|size| size < *at) => {
                current = fs::File::open(&path).ok().map(|file| (file, 0));
            }
            None => current = fs::File::open(&path).ok().map(|file| (file, 0)),
            _ => {}
        }
        let mut text = Vec::new();
        if let Some((file, at)) = &mut current {
            while let Ok(n) = file.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                text.extend_from_slice(&buffer[..n]);
                *at += n as u64;
            }
        }
        // Always send something: a caller that went away ends this.
        if !out.out(&String::from_utf8_lossy(&text)) {
            return;
        }
    }
}

/// Waits until the service listens on the machine's address:
/// `(ok, error, http status line)`, as cube-guest's `wait_healthy`.
fn healthy(
    services: &Services,
    name: &str,
    port: u16,
    command: bool,
    seconds: u64,
) -> (bool, String, String) {
    let host = services.service_host();
    let started = Instant::now();
    let deadline = started + Duration::from_secs(seconds);
    loop {
        if command {
            let status = services.status(name);
            // Restart=on-failure: a command that exits 0 is not restarted.
            if status.state == "failed"
                || status.state == "missing"
                || (status.state == "inactive" && started.elapsed() > Duration::from_secs(3))
            {
                let why = if status.sub.is_empty() {
                    status.state
                } else {
                    status.sub
                };
                return (false, format!("the service stopped ({why})"), String::new());
            }
        }
        if services::listening(&host, port) {
            break;
        }
        if Instant::now() >= deadline {
            if host != "127.0.0.1" && services::listening("127.0.0.1", port) {
                return (
                    false,
                    format!(
                        "port {port} answers on 127.0.0.1 only, and the portal reaches the service on {host}: make it \
                         listen on 0.0.0.0 (for example --host 0.0.0.0, or HOST and PORT from its environment)"
                    ),
                    String::new(),
                );
            }
            return (
                false,
                format!("nothing listens on {host}:{port} after {seconds} s"),
                String::new(),
            );
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    let header = services
        .url(name)
        .and_then(|url| url.split('/').nth(2).map(str::to_string))
        .unwrap_or_else(|| format!("{host}:{port}"));
    let (status, line) = services::http_probe(&host, port, &header);
    let http = if status.is_some() {
        line
    } else {
        format!("listening, but {line}")
    };
    (true, String::new(), http)
}

fn url_text(services: &Services, view: &Value) -> String {
    match view["url"].as_str() {
        Some(url) => url.to_string(),
        None => format!("none ({})", services.no_portal_reason()),
    }
}

/// One service in a few lines.
fn describe(services: &Services, view: &Value) -> String {
    let state = if view["kind"] == "command" {
        let restarts = view["restarts"].as_u64().unwrap_or(0);
        let state = view["state"].as_str().unwrap_or("unknown");
        if restarts > 0 {
            format!("{state} ({restarts} restarts)")
        } else {
            state.to_string()
        }
    } else {
        "external".to_string()
    };
    let mut lines = vec![format!(
        "{}  port {}  {state}",
        view["name"].as_str().unwrap_or_default(),
        view["port"]
    )];
    if let Some(listening) = view["listening"].as_bool() {
        lines.push(format!(
            "  listening: {}",
            if listening { "yes" } else { "no" }
        ));
    }
    lines.push(format!("  url: {}", url_text(services, view)));
    if view["kind"] == "command" {
        lines.push(format!(
            "  command: {}",
            view["command"].as_str().unwrap_or_default()
        ));
        lines.push(format!(
            "  cwd: {}",
            view["cwd"].as_str().unwrap_or_default()
        ));
    }
    lines.join("\n")
}

fn report(
    services: &Services,
    name: &str,
    ok: bool,
    error: &str,
    http: &str,
    out: &mut Out,
    verb: &str,
) -> i32 {
    let record = services.registration(name);
    let mut view = match &record {
        Some(record) => services.view(record, false),
        None => json!({"name": name}),
    };
    view["ok"] = json!(ok);
    view["http"] = if http.is_empty() {
        Value::Null
    } else {
        json!(http)
    };
    view["error"] = if ok { Value::Null } else { json!(error) };
    let command = record.as_ref().is_some_and(|r| r["kind"] == "command");
    if ok {
        let mut text = vec![
            format!("service {name} {verb} on port {}", view["port"]),
            format!("  http: {http}"),
            format!("  url: {}", url_text(services, &view)),
        ];
        if command {
            text.push(format!("  logs: cube service logs {name}"));
        }
        out.result(&view, &text.join("\n"));
        return 0;
    }
    let mut text = vec![format!(
        "service {name} is registered but not healthy: {error}"
    )];
    if command {
        let tail = services.log_tail(name, 20);
        let tail = tail.trim_end();
        if !tail.is_empty() {
            text.push("last output:".into());
            text.push(indent(tail));
        }
        view["logTail"] = json!(tail);
        text.push(format!(
            "fix it and run cube service restart {name}, or remove it with cube service stop {name}"
        ));
    } else {
        text.push(format!(
            "start the server, or remove it with cube service stop {name}"
        ));
    }
    out.result(&view, &text.join("\n"));
    1
}

/// Python's `shlex.quote`.
fn quote(word: &str) -> String {
    if !word.is_empty()
        && word
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"@%+=:,./-_".contains(&b))
    {
        return word.to_string();
    }
    format!("'{}'", word.replace('\'', "'\"'\"'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_are_parsed_as_cube_guest_parses_them() {
        let args = [
            "web",
            "--port=8000",
            "--env",
            "A=1",
            "--env",
            "B=2",
            "--json",
            "--",
            "x",
            "--y",
        ];
        let options = Options::parse(&args, &["--json"], &["--port", "--env"])
            .unwrap_or_else(|u| panic!("{}", u.0));
        assert_eq!(options.name().ok(), Some("web"));
        assert_eq!(options.port().ok(), Some(8000));
        assert_eq!(options.all("--env"), vec!["A=1", "B=2"]);
        assert!(options.flag("--json"));
        assert_eq!(options.rest, Some(vec!["x", "--y"]));
        let usage = |args: &[&str]| match Options::parse(args, &["--json"], &["--port"]) {
            Err(Usage(text)) => text,
            Ok(options) => match (options.name(), options.port()) {
                (Err(Usage(text)), _) | (_, Err(Usage(text))) => text,
                _ => String::new(),
            },
        };
        assert_eq!(usage(&["web", "--port"]), "--port needs a value");
        assert_eq!(usage(&["web", "--frob"]), "unknown option --frob");
        assert_eq!(usage(&["web", "--port", "80"]), "--port must be 1024-65535");
        assert_eq!(
            usage(&["web", "--port", "+8000"]),
            "--port must be 1024-65535"
        );
        assert_eq!(usage(&["web"]), "--port is required");
        assert!(usage(&["Web", "--port", "8000"]).starts_with("a service name"));
        assert_eq!(
            usage(&["a", "b", "--port", "8000"]),
            "give one service name"
        );
    }

    #[test]
    fn words_are_quoted_as_shlex_quotes_them() {
        assert_eq!(quote("python3"), "python3");
        assert_eq!(quote("-m"), "-m");
        assert_eq!(quote("a b"), "'a b'");
        assert_eq!(quote("it's"), "'it'\"'\"'s'");
        assert_eq!(quote(""), "''");
    }
}
