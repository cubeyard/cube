//! The model channel's audit (model.rs): an append-only SQLite file under
//! CUBED_STATE (`model-audit.sqlite`, 0600), written by one gateway at a
//! time (an exclusive lock on `model-audit.sqlite.lock`) on one thread. It
//! is a record for people; nothing reads it back as an agent's input.
//!
//! ```text
//! meta(key, value)                   schema = 2
//! blob(sha256, size, bytes)          request bodies, answers, messages, events
//! exchange(seq, thread, at, method, route, request_headers, request_sha256)
//!                                    committed before the request goes upstream
//! outcome(exchange, at, outcome, status, reason, response_headers,
//!         response_sha256, response_truncated, response_message_sha256)
//!                                    forwarded | refused | failed | cut | lost
//! event(seq, exchange, thread, kind, sha256)
//!                                    kind: web_search_tool_result
//! exchange_outcome                   a view joining the three
//! ```
//!
//! A forwarded request has its `exchange` row before it leaves (`start`,
//! `synchronous=FULL`; no commit, no request) and its `outcome` when the
//! answer ends. An outcome that cannot be written stays queued and is
//! retried before every later write; while one is queued, `start` fails, so
//! the channel stops rather than forward unrecorded. On open, under the
//! lock, every exchange without an outcome (its gateway was killed) gets
//! `lost`.
//!
//! `response_sha256` is the answer's bytes as the child got them (for a
//! stream, the SSE itself); `response_message_sha256` is that answer
//! reconstructed as one Messages API message (`reconstruct`), and the
//! `web_search_tool_result` blocks of that message are the events.
//!
//! What is kept is what the child sent (before the gateway substitutes the
//! token) and what it got (after B6 turned the token back): no token, and
//! of the headers only an allow-list, never `Authorization`. Triggers
//! refuse every UPDATE and DELETE.
use anyhow::{Context as _, Result, bail};
use rusqlite::{Connection, OptionalExtension as _, params};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs::{File, OpenOptions},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc::{Receiver, Sender, channel},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{Notify, oneshot};

/// A request body larger than this is refused (413), and an answer is kept
/// up to it (then marked truncated): Anthropic's own request limit.
pub const MAX_BODY: usize = 32 * 1024 * 1024;
/// How long a request waits for its `exchange` row to commit.
pub const START_TIMEOUT: Duration = Duration::from_secs(2);
/// How long a write waits for a lock someone else holds on the file.
const BUSY_TIMEOUT: Duration = Duration::from_secs(1);
/// Block indexes past this in a stream are ignored by `reconstruct`.
const MAX_BLOCKS: usize = 4096;
const SCHEMA_VERSION: &str = "2";

const SCHEMA: &str = "
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS blob(sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, bytes BLOB NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS exchange(seq INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT NOT NULL, at INTEGER NOT NULL,
  method TEXT NOT NULL, route TEXT NOT NULL, request_headers TEXT NOT NULL, request_sha256 TEXT REFERENCES blob(sha256));
CREATE INDEX IF NOT EXISTS exchange_thread ON exchange(thread, seq);
CREATE TABLE IF NOT EXISTS outcome(exchange INTEGER PRIMARY KEY REFERENCES exchange(seq), at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('forwarded','refused','failed','cut','lost')), status INTEGER, reason TEXT,
  response_headers TEXT NOT NULL, response_sha256 TEXT REFERENCES blob(sha256), response_truncated INTEGER NOT NULL,
  response_message_sha256 TEXT REFERENCES blob(sha256));
CREATE TABLE IF NOT EXISTS event(seq INTEGER PRIMARY KEY AUTOINCREMENT, exchange INTEGER NOT NULL REFERENCES exchange(seq),
  thread TEXT NOT NULL, kind TEXT NOT NULL, sha256 TEXT NOT NULL REFERENCES blob(sha256));
CREATE VIEW IF NOT EXISTS exchange_outcome AS
  SELECT e.seq, e.thread, e.at, e.method, e.route, e.request_headers, e.request_sha256, o.at AS ended_at, o.outcome,
    o.status, o.reason, o.response_headers, o.response_sha256, o.response_truncated, o.response_message_sha256,
    (SELECT count(*) FROM event v WHERE v.exchange = e.seq) AS events
  FROM exchange e LEFT JOIN outcome o ON o.exchange = e.seq;
";

/// Append-only: every table refuses UPDATE and DELETE.
fn triggers() -> String {
    ["meta", "blob", "exchange", "outcome", "event"]
        .iter()
        .flat_map(|table| {
            ["update", "delete"].map(|op| {
                format!(
                    "CREATE TRIGGER IF NOT EXISTS {table}_no_{op} BEFORE {} ON {table} BEGIN SELECT RAISE(ABORT, 'the model audit is append-only'); END;",
                    op.to_uppercase()
                )
            })
        })
        .collect()
}

/// Request headers kept; every other header (`Authorization` first) is not.
const REQUEST_HEADERS: &[&str] = &[
    "anthropic-beta",
    "anthropic-version",
    "content-type",
    "user-agent",
    "x-app",
    "x-claude-code-session-id",
    "x-stainless-retry-count",
];
/// Answer headers kept, and those starting with `anthropic-ratelimit-`.
const RESPONSE_HEADERS: &[&str] = &[
    "content-type",
    "request-id",
    "retry-after",
    "x-should-retry",
    "x-cube-denied",
    "x-cube-error",
];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    /// Sent upstream and answered to the end.
    Forwarded,
    /// Refused here or by cubed's policy; nothing went upstream.
    Refused,
    /// The upstream could not be reached or gave an answer the channel
    /// refuses (502), or the request was not sent after all.
    Failed,
    /// The answer stopped before its end (the child went away, the upstream
    /// broke off, or the gateway stopped).
    Cut,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Forwarded => "forwarded",
            Self::Refused => "refused",
            Self::Failed => "failed",
            Self::Cut => "cut",
        }
    }
}

/// A body as far as it was kept.
#[derive(Clone, Debug, Default)]
pub struct Captured {
    pub bytes: Vec<u8>,
    pub truncated: bool,
}

/// What is known of a request when it arrives.
#[derive(Debug)]
pub struct Start {
    pub thread: String,
    pub at_ms: i64,
    pub method: String,
    pub route: String,
    pub request_headers: Vec<(String, String)>,
    /// The whole body; None for a refusal that never read it.
    pub request: Option<Vec<u8>>,
}

/// How an exchange ended.
#[derive(Debug)]
pub struct End {
    pub outcome: Outcome,
    pub status: Option<u16>,
    pub reason: Option<String>,
    pub response_headers: Vec<(String, String)>,
    pub response: Option<Captured>,
}

impl End {
    pub fn plain(outcome: Outcome, status: Option<u16>, reason: &str) -> Self {
        Self {
            outcome,
            status,
            reason: Some(reason.to_string()),
            response_headers: vec![],
            response: None,
        }
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

/// The kept headers, in order, as text.
pub fn kept_headers(headers: &http::HeaderMap, request: bool) -> Vec<(String, String)> {
    headers
        .iter()
        .filter(|(name, _)| {
            let name = name.as_str();
            if request {
                REQUEST_HEADERS.contains(&name)
            } else {
                RESPONSE_HEADERS.contains(&name) || name.starts_with("anthropic-ratelimit-")
            }
        })
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                String::from_utf8_lossy(value.as_bytes()).into_owned(),
            )
        })
        .collect()
}

/// A write that must not be lost: retried before every later one.
enum Pending {
    End(i64, End),
    Refusal(Start, End),
}

enum Command {
    Start(Start, oneshot::Sender<Result<i64, String>>),
    Write(Pending),
    Flush(oneshot::Sender<Result<(), String>>),
}

/// The writer: a handle any connection may send to.
#[derive(Clone)]
pub struct Audit {
    sender: Sender<Command>,
    /// Exchanges started and not ended yet, for an orderly stop.
    open: Arc<(AtomicUsize, Notify)>,
}

impl Audit {
    /// Takes the audit's lock (or fails: another gateway writes it), opens
    /// or creates the file (0600), checks its schema, records `lost` for
    /// every exchange its last writer left without an outcome, and starts
    /// the writer thread.
    pub fn open(file: &Path) -> Result<Self> {
        let lock_path = PathBuf::from(format!("{}.lock", file.display()));
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .mode(0o600)
            .open(&lock_path)
            .with_context(|| format!("open {}", lock_path.display()))?;
        if lock.try_lock().is_err() {
            bail!(
                "another cube-gateway writes the model audit {} (its lock is held)",
                file.display()
            );
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(file)
            .with_context(|| format!("open {}", file.display()))?;
        let connection =
            Connection::open(file).with_context(|| format!("open {}", file.display()))?;
        connection.busy_timeout(BUSY_TIMEOUT)?;
        let existing: bool = connection.query_row(
            "SELECT count(*) > 0 FROM sqlite_master WHERE name='exchange'",
            [],
            |row| row.get(0),
        )?;
        let version: Option<String> = if existing {
            connection
                .query_row("SELECT value FROM meta WHERE key='schema'", [], |row| {
                    row.get(0)
                })
                .optional()
                .unwrap_or(None)
        } else {
            None
        };
        if existing && version.as_deref() != Some(SCHEMA_VERSION) {
            bail!(
                "the model audit {} has another schema ({}); move it aside to start a new one",
                file.display(),
                version.as_deref().unwrap_or("none")
            );
        }
        connection.execute_batch(SCHEMA)?;
        connection.execute_batch(&triggers())?;
        connection.execute(
            "INSERT OR IGNORE INTO meta(key, value) VALUES ('schema', ?1)",
            [SCHEMA_VERSION],
        )?;
        let lost = connection.execute(
            "INSERT INTO outcome(exchange, at, outcome, reason, response_headers, response_truncated)
             SELECT seq, ?1, 'lost', 'the gateway stopped before this exchange ended', '[]', 0
             FROM exchange WHERE seq NOT IN (SELECT exchange FROM outcome)",
            [now_ms()],
        )?;
        if lost > 0 {
            eprintln!(
                "cube-gateway: model audit: {lost} exchange(s) of the last gateway never ended; recorded as lost"
            );
        }
        let (sender, receiver) = channel();
        let open = Arc::new((AtomicUsize::new(0), Notify::new()));
        let writer_open = open.clone();
        std::thread::Builder::new()
            .name("model-audit".into())
            .spawn(move || Writer::new(connection, lock, writer_open).run(receiver))?;
        Ok(Self { sender, open })
    }

    /// Commits the exchange's row before its request may go upstream, or
    /// says why it cannot (the caller answers 503 and sends nothing).
    pub async fn start(&self, start: Start) -> Result<i64, String> {
        let (reply, answer) = oneshot::channel();
        self.sender
            .send(Command::Start(start, reply))
            .map_err(|_| "the audit writer has stopped".to_string())?;
        match tokio::time::timeout(START_TIMEOUT, answer).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("the audit writer has stopped".into()),
            Err(_) => Err(format!(
                "the audit did not commit within {} s",
                START_TIMEOUT.as_secs()
            )),
        }
    }

    /// How a started exchange ended.
    pub fn end(&self, seq: i64, end: End) {
        if self
            .sender
            .send(Command::Write(Pending::End(seq, end)))
            .is_err()
        {
            eprintln!(
                "cube-gateway: model audit: the writer has stopped; exchange {seq} has no outcome (recorded as lost on the next start)"
            );
        }
    }

    /// A request refused before it was started; nothing went upstream.
    pub fn refusal(&self, start: Start, end: End) {
        if self
            .sender
            .send(Command::Write(Pending::Refusal(start, end)))
            .is_err()
        {
            eprintln!(
                "cube-gateway: model audit: the writer has stopped; a refusal was not recorded"
            );
        }
    }

    /// Exchanges started and not ended.
    pub fn open_exchanges(&self) -> usize {
        self.open.0.load(Ordering::SeqCst)
    }

    /// Waits until no exchange is open, or `limit` passes; true when none is.
    pub async fn idle(&self, limit: Duration) -> bool {
        let wait = async {
            loop {
                let notified = self.open.1.notified();
                if self.open_exchanges() == 0 {
                    return;
                }
                notified.await;
            }
        };
        tokio::time::timeout(limit, wait).await.is_ok()
    }

    /// Waits for every queued write, at most `limit`.
    pub async fn flush(&self, limit: Duration) -> Result<(), String> {
        let (reply, answer) = oneshot::channel();
        self.sender
            .send(Command::Flush(reply))
            .map_err(|_| "the audit writer has stopped".to_string())?;
        match tokio::time::timeout(limit, answer).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("the audit writer has stopped".into()),
            Err(_) => Err("the audit did not drain in time".into()),
        }
    }
}

struct Writer {
    connection: Connection,
    /// Held for the writer's life: one gateway per audit file.
    _lock: File,
    open: Arc<(AtomicUsize, Notify)>,
    pending: VecDeque<Pending>,
}

impl Writer {
    fn new(connection: Connection, lock: File, open: Arc<(AtomicUsize, Notify)>) -> Self {
        Self {
            connection,
            _lock: lock,
            open,
            pending: VecDeque::new(),
        }
    }

    fn run(mut self, receiver: Receiver<Command>) {
        for command in receiver {
            match command {
                Command::Start(start, reply) => {
                    let result = self.drain().and_then(|()| {
                        write_start(&mut self.connection, &start).map_err(|e| format!("{e:#}"))
                    });
                    if let Ok(seq) = result {
                        self.open.0.fetch_add(1, Ordering::SeqCst);
                        if reply.send(Ok(seq)).is_err() {
                            // Its request gave up waiting and was not sent.
                            let end = End::plain(
                                Outcome::Failed,
                                Some(503),
                                "not sent: the audit committed after the request stopped waiting",
                            );
                            self.pending.push_back(Pending::End(seq, end));
                            let _ = self.drain();
                        }
                    } else {
                        eprintln!(
                            "cube-gateway: model audit: an exchange could not be started, so its request is refused: {}",
                            result.as_ref().unwrap_err()
                        );
                        let _ = reply.send(result);
                    }
                }
                Command::Write(pending) => {
                    self.pending.push_back(pending);
                    if let Err(error) = self.drain() {
                        eprintln!(
                            "cube-gateway: model audit: {} write(s) queued, the channel refuses new requests until they are written: {error}",
                            self.pending.len()
                        );
                    }
                }
                Command::Flush(reply) => {
                    let _ = reply.send(self.drain());
                }
            }
        }
    }

    /// Writes every queued outcome and refusal in order; stops at the first
    /// that fails, which stays first in the queue.
    fn drain(&mut self) -> Result<(), String> {
        while let Some(pending) = self.pending.front() {
            let result = match pending {
                Pending::End(seq, end) => write_end(&mut self.connection, *seq, end),
                Pending::Refusal(start, end) => write_refusal(&mut self.connection, start, end),
            };
            if let Err(error) = result {
                return Err(format!("{error:#}"));
            }
            if matches!(pending, Pending::End(..)) {
                self.open.0.fetch_sub(1, Ordering::SeqCst);
                self.open.1.notify_waiters();
            }
            self.pending.pop_front();
        }
        Ok(())
    }
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn blob(tx: &rusqlite::Transaction<'_>, bytes: &[u8]) -> Result<String> {
    let hash = sha256(bytes);
    tx.execute(
        "INSERT OR IGNORE INTO blob(sha256, size, bytes) VALUES (?1, ?2, ?3)",
        params![hash, bytes.len() as i64, bytes],
    )?;
    Ok(hash)
}

fn insert_exchange(tx: &rusqlite::Transaction<'_>, start: &Start) -> Result<i64> {
    let request = start
        .request
        .as_ref()
        .map(|bytes| blob(tx, bytes))
        .transpose()?;
    tx.execute(
        "INSERT INTO exchange(thread, at, method, route, request_headers, request_sha256) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            start.thread,
            start.at_ms,
            start.method,
            start.route,
            serde_json::to_string(&start.request_headers)?,
            request,
        ],
    )?;
    Ok(tx.last_insert_rowid())
}

fn write_start(connection: &mut Connection, start: &Start) -> Result<i64> {
    let tx = connection.transaction()?;
    let seq = insert_exchange(&tx, start)?;
    tx.commit()?;
    Ok(seq)
}

fn write_refusal(connection: &mut Connection, start: &Start, end: &End) -> Result<()> {
    let tx = connection.transaction()?;
    let seq = insert_exchange(&tx, start)?;
    insert_end(&tx, seq, end)?;
    tx.commit()?;
    Ok(())
}

fn write_end(connection: &mut Connection, seq: i64, end: &End) -> Result<()> {
    let tx = connection.transaction()?;
    insert_end(&tx, seq, end)?;
    tx.commit()?;
    Ok(())
}

/// The outcome row, its answer and message blobs and its events.
fn insert_end(tx: &rusqlite::Transaction<'_>, seq: i64, end: &End) -> Result<()> {
    let response = end
        .response
        .as_ref()
        .map(|c| blob(tx, &c.bytes))
        .transpose()?;
    let content_type = end
        .response_headers
        .iter()
        .find(|(name, _)| name == "content-type")
        .map(|(_, value)| value.as_str());
    let message = end
        .response
        .as_ref()
        .and_then(|c| reconstruct(content_type, &c.bytes));
    let message_hash = match &message {
        Some(message) => Some(blob(tx, &serde_json::to_vec(message)?)?),
        None => None,
    };
    tx.execute(
        "INSERT INTO outcome(exchange, at, outcome, status, reason, response_headers, response_sha256,
           response_truncated, response_message_sha256)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            seq,
            now_ms(),
            end.outcome.as_str(),
            end.status,
            end.reason,
            serde_json::to_string(&end.response_headers)?,
            response,
            end.response.as_ref().is_some_and(|c| c.truncated),
            message_hash,
        ],
    )?;
    if let Some(message) = &message {
        let thread: String =
            tx.query_row("SELECT thread FROM exchange WHERE seq=?1", [seq], |row| {
                row.get(0)
            })?;
        for block in web_search_results(message) {
            let hash = blob(tx, &block)?;
            tx.execute(
                "INSERT INTO event(exchange, thread, kind, sha256) VALUES (?1, ?2, 'web_search_tool_result', ?3)",
                params![seq, thread, hash],
            )?;
        }
    }
    Ok(())
}

/// The answer as one Messages API message: a whole JSON answer as it is,
/// or a stream (`text/event-stream`) folded event by event. `message_start`
/// gives the message, `content_block_start` each block, the deltas extend
/// them (text, thinking, signature, citations, a tool's input JSON, parsed
/// at `content_block_stop`), `message_delta` sets the stop and usage, and an
/// `error` event is kept as `error`. Input JSON that never stopped or does
/// not parse is kept as text in `cube_input_json`; events it does not know
/// are counted in `cube_unknown_events`. None when there is nothing to fold
/// (a stream without `message_start` or `error`, a body that is not JSON).
pub fn reconstruct(content_type: Option<&str>, body: &[u8]) -> Option<Value> {
    if !content_type.is_some_and(|t| t.starts_with("text/event-stream")) {
        return serde_json::from_slice(body).ok();
    }
    let text = String::from_utf8_lossy(body).replace("\r\n", "\n");
    let mut message: Option<Value> = None;
    let mut blocks: Vec<Value> = vec![];
    let mut inputs: Vec<Option<String>> = vec![];
    let mut error: Option<Value> = None;
    let mut unknown = 0u64;
    for event in text.split("\n\n") {
        let data: Vec<&str> = event
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(|data| data.strip_prefix(' ').unwrap_or(data))
            .collect();
        if data.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(&data.join("\n")) else {
            unknown += 1;
            continue;
        };
        let index = value
            .get("index")
            .and_then(Value::as_u64)
            .map(|i| i as usize);
        match value.get("type").and_then(Value::as_str) {
            Some("message_start") => message = value.get("message").cloned(),
            Some("content_block_start") => match (index, value.get("content_block")) {
                (Some(i), Some(block)) if i < MAX_BLOCKS => {
                    if blocks.len() <= i {
                        blocks.resize(i + 1, Value::Null);
                        inputs.resize(i + 1, None);
                    }
                    blocks[i] = block.clone();
                }
                _ => unknown += 1,
            },
            Some("content_block_delta") => {
                let (Some(i), Some(delta)) = (index, value.get("delta")) else {
                    unknown += 1;
                    continue;
                };
                let Some(block) = blocks.get_mut(i).and_then(Value::as_object_mut) else {
                    unknown += 1;
                    continue;
                };
                let field = |name: &str| delta.get(name).and_then(Value::as_str).unwrap_or("");
                let append = |block: &mut Map<String, Value>, key: &str, more: &str| {
                    let old = block.get(key).and_then(Value::as_str).unwrap_or("");
                    let joined = format!("{old}{more}");
                    block.insert(key.into(), Value::String(joined));
                };
                match delta.get("type").and_then(Value::as_str) {
                    Some("text_delta") => append(block, "text", field("text")),
                    Some("thinking_delta") => append(block, "thinking", field("thinking")),
                    Some("signature_delta") => {
                        block.insert("signature".into(), field("signature").into());
                    }
                    Some("citations_delta") => {
                        let citation = delta.get("citation").cloned().unwrap_or(Value::Null);
                        if let Some(list) = block
                            .entry("citations")
                            .or_insert_with(|| Value::Array(vec![]))
                            .as_array_mut()
                        {
                            list.push(citation);
                        }
                    }
                    Some("input_json_delta") => inputs[i]
                        .get_or_insert_with(String::new)
                        .push_str(field("partial_json")),
                    _ => unknown += 1,
                }
            }
            Some("content_block_stop") => {
                if let Some(i) = index
                    && let Some(json) = inputs.get_mut(i).and_then(Option::take)
                    && let Some(block) = blocks.get_mut(i).and_then(Value::as_object_mut)
                {
                    let source = if json.is_empty() { "{}" } else { json.as_str() };
                    match serde_json::from_str::<Value>(source) {
                        Ok(input) => block.insert("input".into(), input),
                        Err(_) => block.insert("cube_input_json".into(), Value::String(json)),
                    };
                }
            }
            Some("message_delta") => {
                if let Some(Value::Object(message)) = message.as_mut() {
                    if let Some(Value::Object(delta)) = value.get("delta") {
                        for (key, field) in delta {
                            message.insert(key.clone(), field.clone());
                        }
                    }
                    if let Some(Value::Object(usage)) = value.get("usage")
                        && let Some(target) = message
                            .entry("usage")
                            .or_insert_with(|| Value::Object(Map::new()))
                            .as_object_mut()
                    {
                        for (key, field) in usage {
                            target.insert(key.clone(), field.clone());
                        }
                    }
                }
            }
            Some("error") => error = value.get("error").cloned(),
            Some("message_stop" | "ping") => {}
            _ => unknown += 1,
        }
    }
    if message.is_none() && error.is_some() {
        message = Some(serde_json::json!({ "type": "error" }));
    }
    let Some(Value::Object(mut message)) = message else {
        return None;
    };
    for (block, json) in blocks.iter_mut().zip(inputs) {
        if let (Some(json), Some(block)) = (json, block.as_object_mut()) {
            block.insert("cube_input_json".into(), Value::String(json));
        }
    }
    message.insert("content".into(), Value::Array(blocks));
    if let Some(error) = error {
        message.insert("error".into(), error);
    }
    if unknown > 0 {
        message.insert("cube_unknown_events".into(), unknown.into());
    }
    Some(Value::Object(message))
}

/// The `web_search_tool_result` blocks of a message, each as JSON.
pub fn web_search_results(message: &Value) -> Vec<Vec<u8>> {
    message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("web_search_tool_result"))
        .map(|block| serde_json::to_vec(block).unwrap_or_default())
        .collect()
}

/// Test and inspection helper: the stored bytes of a hash.
pub fn read_blob(connection: &Connection, hash: &str) -> Result<Option<Vec<u8>>> {
    Ok(connection
        .query_row("SELECT bytes FROM blob WHERE sha256=?1", [hash], |row| {
            row.get(0)
        })
        .optional()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stream of every kind of event `reconstruct` folds.
    pub(crate) fn sample_stream(newline: &str) -> String {
        let events: &[(&str, &str)] = &[
            (
                "message_start",
                r#"{"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-x","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":1}}}"#,
            ),
            ("ping", r#"{"type":"ping"}"#),
            (
                "content_block_start",
                r#"{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"let me "}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"look"}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig=="}}"#,
            ),
            (
                "content_block_stop",
                r#"{"type":"content_block_stop","index":0}"#,
            ),
            (
                "content_block_start",
                r#"{"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"srv_1","name":"web_search","input":{}}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"query\": \"cu"}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"be\"}"}}"#,
            ),
            (
                "content_block_stop",
                r#"{"type":"content_block_stop","index":1}"#,
            ),
            (
                "content_block_start",
                r#"{"type":"content_block_start","index":2,"content_block":{"type":"web_search_tool_result","tool_use_id":"srv_1","content":[{"type":"web_search_result","url":"https://example.com/"}]}}"#,
            ),
            (
                "content_block_stop",
                r#"{"type":"content_block_stop","index":2}"#,
            ),
            (
                "content_block_start",
                r#"{"type":"content_block_start","index":3,"content_block":{"type":"text","text":""}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"Hello, "}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":3,"delta":{"type":"citations_delta","citation":{"type":"web_search_result_location","url":"https://example.com/"}}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"world"}}"#,
            ),
            (
                "content_block_stop",
                r#"{"type":"content_block_stop","index":3}"#,
            ),
            (
                "content_block_start",
                r#"{"type":"content_block_start","index":4,"content_block":{"type":"tool_use","id":"tu_1","name":"Bash","input":{}}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":4,"delta":{"type":"input_json_delta","partial_json":""}}"#,
            ),
            (
                "content_block_delta",
                r#"{"type":"content_block_delta","index":4,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"ls\"}"}}"#,
            ),
            (
                "content_block_stop",
                r#"{"type":"content_block_stop","index":4}"#,
            ),
            (
                "message_delta",
                r#"{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"output_tokens":42}}"#,
            ),
            ("message_stop", r#"{"type":"message_stop"}"#),
        ];
        events
            .iter()
            .map(|(name, data)| format!("event: {name}{newline}data: {data}{newline}{newline}"))
            .collect()
    }

    pub(crate) fn sample_message() -> Value {
        serde_json::json!({
            "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-x",
            "stop_reason": "tool_use", "stop_sequence": null,
            "usage": { "input_tokens": 5, "output_tokens": 42 },
            "content": [
                { "type": "thinking", "thinking": "let me look", "signature": "sig==" },
                { "type": "server_tool_use", "id": "srv_1", "name": "web_search", "input": { "query": "cube" } },
                { "type": "web_search_tool_result", "tool_use_id": "srv_1", "content": [{ "type": "web_search_result", "url": "https://example.com/" }] },
                { "type": "text", "text": "Hello, world", "citations": [{ "type": "web_search_result_location", "url": "https://example.com/" }] },
                { "type": "tool_use", "id": "tu_1", "name": "Bash", "input": { "command": "ls" } },
            ],
        })
    }

    #[test]
    fn a_stream_folds_into_the_message_it_carries() {
        let sse = Some("text/event-stream; charset=utf-8");
        assert_eq!(
            reconstruct(sse, sample_stream("\n").as_bytes()),
            Some(sample_message())
        );
        assert_eq!(
            reconstruct(sse, sample_stream("\r\n").as_bytes()),
            Some(sample_message()),
            "CRLF framing"
        );
        let found = web_search_results(&sample_message());
        assert_eq!(found.len(), 1);
        let block: Value = serde_json::from_slice(&found[0]).unwrap();
        assert_eq!(block["content"][0]["url"], "https://example.com/");
    }

    #[test]
    fn a_cut_stream_an_error_and_other_bodies() {
        let sse = Some("text/event-stream");
        let stream = sample_stream("\n");
        let cut = &stream[..stream.find("\"command\\\":\\\"ls").unwrap()];
        let message = reconstruct(sse, cut.as_bytes()).unwrap();
        assert_eq!(message["stop_reason"], Value::Null, "no message_delta yet");
        assert_eq!(
            message["content"][4]["cube_input_json"], "",
            "unfinished input kept as text"
        );
        assert_eq!(message["content"][3]["text"], "Hello, world");
        let error = "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"busy\"}}\n\n";
        assert_eq!(
            reconstruct(sse, error.as_bytes()).unwrap()["error"]["type"],
            "overloaded_error"
        );
        let odd = format!("{stream}event: brand_new\ndata: {{\"type\":\"brand_new\"}}\n\n");
        assert_eq!(
            reconstruct(sse, odd.as_bytes()).unwrap()["cube_unknown_events"],
            1
        );
        assert_eq!(reconstruct(sse, b"data: nope\n\n"), None);
        let whole =
            br#"{"type":"message","content":[{"type":"web_search_tool_result","content":[]}]}"#;
        let message = reconstruct(Some("application/json"), whole).unwrap();
        assert_eq!(web_search_results(&message).len(), 1);
        assert_eq!(
            reconstruct(Some("text/plain"), b"cube gateway: denied\n"),
            None
        );
    }

    fn start(thread: &str) -> Start {
        Start {
            thread: thread.into(),
            at_ms: now_ms(),
            method: "POST".into(),
            route: "/v1/messages?beta=true".into(),
            request_headers: vec![],
            request: Some(b"{}".to_vec()),
        }
    }

    fn outcomes(file: &Path) -> Vec<(i64, Option<String>)> {
        let connection = Connection::open(file).unwrap();
        let mut statement = connection
            .prepare("SELECT seq, outcome FROM exchange_outcome ORDER BY seq")
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[tokio::test]
    async fn one_writer_append_only_private_and_open_exchanges_lost_on_reopen() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("model-audit.sqlite");
        let audit = Audit::open(&file).unwrap();
        let error = Audit::open(&file)
            .err()
            .expect("a second writer is refused");
        assert!(
            error.to_string().contains("another cube-gateway"),
            "{error}"
        );
        // A start is committed when it returns: before any request leaves.
        let ended = audit.start(start("t1")).await.unwrap();
        let open = audit.start(start("t1")).await.unwrap();
        assert_eq!(outcomes(&file), vec![(ended, None), (open, None)]);
        audit.end(ended, End::plain(Outcome::Forwarded, Some(200), "done"));
        audit.flush(Duration::from_secs(5)).await.unwrap();
        assert_eq!(audit.open_exchanges(), 1);
        assert!(!audit.idle(Duration::from_millis(50)).await);
        drop(audit);
        // The writer and its lock go with the process in real life; here
        // with the thread, once its channel closes.
        let reopened = loop {
            match Audit::open(&file) {
                Ok(audit) => break audit,
                Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
            }
        };
        assert_eq!(
            outcomes(&file),
            vec![
                (ended, Some("forwarded".into())),
                (open, Some("lost".into()))
            ],
            "an exchange its gateway never ended is recorded as lost"
        );
        drop(reopened);
        let connection = Connection::open(&file).unwrap();
        for statement in [
            "UPDATE exchange SET thread='x'",
            "DELETE FROM exchange",
            "UPDATE outcome SET outcome='forwarded'",
            "DELETE FROM outcome",
            "UPDATE blob SET size=0",
            "DELETE FROM meta",
        ] {
            let error = connection.execute(statement, []).unwrap_err();
            assert!(error.to_string().contains("append-only"), "{statement}");
        }
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[tokio::test]
    async fn another_schema_is_refused_and_a_locked_file_fails_starts_until_free() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old.sqlite");
        Connection::open(&old)
            .unwrap()
            .execute_batch("CREATE TABLE exchange(seq INTEGER PRIMARY KEY, outcome TEXT);")
            .unwrap();
        let error = Audit::open(&old).err().expect("an older audit is refused");
        assert!(error.to_string().contains("another schema"), "{error}");

        let file = dir.path().join("model-audit.sqlite");
        let audit = Audit::open(&file).unwrap();
        let first = audit.start(start("t1")).await.unwrap();
        let holder = Connection::open(&file).unwrap();
        holder.execute_batch("BEGIN EXCLUSIVE").unwrap();
        // The outcome cannot be written: it stays queued, and starts fail.
        audit.end(first, End::plain(Outcome::Forwarded, Some(200), "done"));
        tokio::time::sleep(BUSY_TIMEOUT + Duration::from_millis(200)).await;
        let refused = audit.start(start("t1")).await.unwrap_err();
        assert!(
            !refused.contains("within"),
            "it failed on the write, not the deadline: {refused}"
        );
        holder.execute_batch("ROLLBACK").unwrap();
        let next = audit.start(start("t1")).await.unwrap();
        assert_eq!(
            outcomes(&file),
            vec![(first, Some("forwarded".into())), (next, None)],
            "the queued outcome is written first, then the new start"
        );
        // A start queued behind writes that keep failing passes its
        // deadline; when the file frees it commits, and the writer records
        // it as not sent, never open.
        holder.execute_batch("BEGIN EXCLUSIVE").unwrap();
        audit.end(next, End::plain(Outcome::Forwarded, Some(200), "done"));
        audit.refusal(
            start("t3"),
            End::plain(Outcome::Refused, Some(404), "not a route"),
        );
        let late = audit.start(start("t2")).await.unwrap_err();
        assert!(late.contains("within"), "the deadline passed: {late}");
        holder.execute_batch("ROLLBACK").unwrap();
        audit.flush(Duration::from_secs(5)).await.unwrap();
        let connection = Connection::open(&file).unwrap();
        let rows: Vec<(String, String, Option<String>)> = connection
            .prepare(
                "SELECT thread, outcome, reason FROM exchange_outcome WHERE seq > ?1 ORDER BY seq",
            )
            .unwrap()
            .query_map([next], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(rows.len(), 2, "{rows:?}");
        assert_eq!((rows[0].0.as_str(), rows[0].1.as_str()), ("t3", "refused"));
        assert_eq!((rows[1].0.as_str(), rows[1].1.as_str()), ("t2", "failed"));
        assert!(rows[1].2.as_deref().unwrap().starts_with("not sent"));
        assert_eq!(outcomes(&file)[1].1.as_deref(), Some("forwarded"));
        assert_eq!(audit.open_exchanges(), 0);
    }
}
