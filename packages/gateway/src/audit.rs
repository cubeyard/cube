//! The model channel's audit (model.rs): an append-only SQLite file under
//! CUBED_STATE (`model-audit.sqlite`, 0600), written by this process alone
//! on one thread. It is a record for people; nothing reads it back as an
//! agent's input.
//!
//! ```text
//! blob(sha256, size, bytes)          request bodies, answers, events, by hash
//! exchange(seq, thread, at, method, route, outcome, status, reason,
//!          request_headers, request_sha256, request_truncated,
//!          response_headers, response_sha256, response_truncated,
//!          response_message_sha256)
//! event(seq, exchange, thread, kind, sha256)
//!                                    kind: web_search_tool_result
//! ```
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
use anyhow::{Context as _, Result};
use rusqlite::{Connection, OptionalExtension as _, params};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::OpenOptions,
    os::unix::fs::OpenOptionsExt,
    path::Path,
    sync::mpsc::{Receiver, Sender, channel},
    time::{SystemTime, UNIX_EPOCH},
};

/// A body larger than this is kept up to it and marked truncated.
pub const MAX_BODY: usize = 64 * 1024 * 1024;

const SCHEMA: &str = "
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
CREATE TABLE IF NOT EXISTS blob(sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, bytes BLOB NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS exchange(seq INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT NOT NULL, at INTEGER NOT NULL,
  method TEXT NOT NULL, route TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('forwarded','refused','failed','cut')), status INTEGER, reason TEXT,
  request_headers TEXT NOT NULL, request_sha256 TEXT REFERENCES blob(sha256), request_truncated INTEGER NOT NULL,
  response_headers TEXT NOT NULL, response_sha256 TEXT REFERENCES blob(sha256), response_truncated INTEGER NOT NULL,
  response_message_sha256 TEXT REFERENCES blob(sha256));
CREATE INDEX IF NOT EXISTS exchange_thread ON exchange(thread, seq);
CREATE TABLE IF NOT EXISTS event(seq INTEGER PRIMARY KEY AUTOINCREMENT, exchange INTEGER NOT NULL REFERENCES exchange(seq),
  thread TEXT NOT NULL, kind TEXT NOT NULL, sha256 TEXT NOT NULL REFERENCES blob(sha256));
CREATE TRIGGER IF NOT EXISTS blob_no_update BEFORE UPDATE ON blob BEGIN SELECT RAISE(ABORT, 'the model audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS blob_no_delete BEFORE DELETE ON blob BEGIN SELECT RAISE(ABORT, 'the model audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS exchange_no_update BEFORE UPDATE ON exchange BEGIN SELECT RAISE(ABORT, 'the model audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS exchange_no_delete BEFORE DELETE ON exchange BEGIN SELECT RAISE(ABORT, 'the model audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS event_no_update BEFORE UPDATE ON event BEGIN SELECT RAISE(ABORT, 'the model audit is append-only'); END;
CREATE TRIGGER IF NOT EXISTS event_no_delete BEFORE DELETE ON event BEGIN SELECT RAISE(ABORT, 'the model audit is append-only'); END;
";

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
    /// refuses (502).
    Failed,
    /// The answer stopped before its end (the child went away, or the
    /// upstream broke off).
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

/// One exchange of one thread.
#[derive(Debug)]
pub struct Exchange {
    pub thread: String,
    pub at_ms: i64,
    pub method: String,
    pub route: String,
    pub outcome: Outcome,
    pub status: Option<u16>,
    pub reason: Option<String>,
    pub request_headers: Vec<(String, String)>,
    pub request: Option<Captured>,
    pub response_headers: Vec<(String, String)>,
    pub response: Option<Captured>,
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

/// The writer: a handle any connection may send to.
#[derive(Clone)]
pub struct Audit {
    sender: Sender<Exchange>,
}

impl Audit {
    /// Opens (or creates, 0600) the file and starts its writer thread.
    pub fn open(file: &Path) -> Result<Self> {
        OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(file)
            .with_context(|| format!("open {}", file.display()))?;
        let connection =
            Connection::open(file).with_context(|| format!("open {}", file.display()))?;
        connection.execute_batch(SCHEMA)?;
        let (sender, receiver) = channel();
        std::thread::Builder::new()
            .name("model-audit".into())
            .spawn(move || write_all(connection, receiver))?;
        Ok(Self { sender })
    }

    pub fn record(&self, exchange: Exchange) {
        if self.sender.send(exchange).is_err() {
            eprintln!(
                "cube-gateway: model audit: the writer has stopped; an exchange was not recorded"
            );
        }
    }
}

fn write_all(mut connection: Connection, receiver: Receiver<Exchange>) {
    for exchange in receiver {
        if let Err(error) = write(&mut connection, &exchange) {
            eprintln!(
                "cube-gateway: model audit: {} {} of thread {} not recorded: {error:#}",
                exchange.method,
                route_path(&exchange.route),
                exchange.thread
            );
        }
    }
}

fn route_path(route: &str) -> &str {
    route.split('?').next().unwrap_or(route)
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

fn write(connection: &mut Connection, exchange: &Exchange) -> Result<()> {
    let tx = connection.transaction()?;
    let request = exchange
        .request
        .as_ref()
        .map(|c| blob(&tx, &c.bytes))
        .transpose()?;
    let response = exchange
        .response
        .as_ref()
        .map(|c| blob(&tx, &c.bytes))
        .transpose()?;
    let content_type = exchange
        .response_headers
        .iter()
        .find(|(name, _)| name == "content-type")
        .map(|(_, value)| value.as_str());
    let message = exchange
        .response
        .as_ref()
        .and_then(|c| reconstruct(content_type, &c.bytes));
    let message_hash = match &message {
        Some(message) => Some(blob(&tx, &serde_json::to_vec(message)?)?),
        None => None,
    };
    tx.execute(
        "INSERT INTO exchange(thread, at, method, route, outcome, status, reason, request_headers, request_sha256,
           request_truncated, response_headers, response_sha256, response_truncated, response_message_sha256)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
        params![
            exchange.thread,
            exchange.at_ms,
            exchange.method,
            exchange.route,
            exchange.outcome.as_str(),
            exchange.status,
            exchange.reason,
            serde_json::to_string(&exchange.request_headers)?,
            request,
            exchange.request.as_ref().is_some_and(|c| c.truncated),
            serde_json::to_string(&exchange.response_headers)?,
            response,
            exchange.response.as_ref().is_some_and(|c| c.truncated),
            message_hash,
        ],
    )?;
    let seq = tx.last_insert_rowid();
    if let Some(message) = &message {
        for block in web_search_results(message) {
            let hash = blob(&tx, &block)?;
            tx.execute(
                "INSERT INTO event(exchange, thread, kind, sha256) VALUES (?1, ?2, 'web_search_tool_result', ?3)",
                params![seq, exchange.thread, hash],
            )?;
        }
    }
    tx.commit()?;
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
                (Some(i), Some(block)) => {
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

    #[test]
    fn the_file_is_append_only_and_private() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("model-audit.sqlite");
        let audit = Audit::open(&file).unwrap();
        audit.record(Exchange {
            thread: "t1".into(),
            at_ms: now_ms(),
            method: "POST".into(),
            route: "/v1/messages?beta=true".into(),
            outcome: Outcome::Forwarded,
            status: Some(200),
            reason: None,
            request_headers: vec![],
            request: Some(Captured {
                bytes: b"{}".to_vec(),
                truncated: false,
            }),
            response_headers: vec![],
            response: Some(Captured::default()),
        });
        drop(audit);
        let connection = Connection::open(&file).unwrap();
        let wait = std::time::Instant::now();
        while connection
            .query_row("SELECT count(*) FROM exchange", [], |r| r.get::<_, i64>(0))
            .unwrap()
            == 0
        {
            assert!(wait.elapsed().as_secs() < 5, "recorded");
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        for statement in [
            "UPDATE exchange SET thread='x'",
            "DELETE FROM exchange",
            "UPDATE blob SET size=0",
            "DELETE FROM blob",
        ] {
            let error = connection.execute(statement, []).unwrap_err();
            assert!(error.to_string().contains("append-only"), "{statement}");
        }
        let mode = std::fs::metadata(&file).unwrap().permissions();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(mode.mode() & 0o777, 0o600);
    }
}
