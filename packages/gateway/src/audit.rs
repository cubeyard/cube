//! The model channel's audit (model.rs): an append-only SQLite file under
//! CUBED_STATE (`model-audit.sqlite`, 0600), written by this process alone
//! on one thread. It is a record for people; nothing reads it back as an
//! agent's input.
//!
//! ```text
//! blob(sha256, size, bytes)          request bodies, answers, events, by hash
//! exchange(seq, thread, at, method, route, outcome, status, reason,
//!          request_headers, request_sha256, request_truncated,
//!          response_headers, response_sha256, response_truncated)
//! event(seq, exchange, thread, kind, sha256)
//!                                    kind: web_search_tool_result
//! ```
//!
//! What is kept is what the child sent (before the gateway substitutes the
//! token) and what it got (after B6 turned the token back): no token, and
//! of the headers only an allow-list, never `Authorization`. Triggers
//! refuse every UPDATE and DELETE.
use anyhow::{Context as _, Result};
use rusqlite::{Connection, OptionalExtension as _, params};
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
  response_headers TEXT NOT NULL, response_sha256 TEXT REFERENCES blob(sha256), response_truncated INTEGER NOT NULL);
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
    tx.execute(
        "INSERT INTO exchange(thread, at, method, route, outcome, status, reason, request_headers, request_sha256,
           request_truncated, response_headers, response_sha256, response_truncated)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
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
        ],
    )?;
    let seq = tx.last_insert_rowid();
    if let Some(captured) = &exchange.response {
        let content_type = exchange
            .response_headers
            .iter()
            .find(|(name, _)| name == "content-type")
            .map(|(_, value)| value.as_str());
        for block in web_search_results(content_type, &captured.bytes) {
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

/// The `web_search_tool_result` content blocks of a Messages answer, each
/// as JSON: from `content_block_start` events of a stream, or from the
/// `content` of a whole message.
pub fn web_search_results(content_type: Option<&str>, body: &[u8]) -> Vec<Vec<u8>> {
    let is_block = |block: &serde_json::Value| {
        block.get("type").and_then(|t| t.as_str()) == Some("web_search_tool_result")
    };
    let encode = |block: &serde_json::Value| serde_json::to_vec(block).unwrap_or_default();
    if content_type.is_some_and(|t| t.starts_with("text/event-stream")) {
        let text = String::from_utf8_lossy(body);
        let mut out = vec![];
        for event in text.split("\n\n") {
            let data: Vec<&str> = event
                .lines()
                .filter_map(|line| line.strip_prefix("data:"))
                .map(|data| data.strip_prefix(' ').unwrap_or(data))
                .collect();
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&data.join("\n")) else {
                continue;
            };
            if value.get("type").and_then(|t| t.as_str()) == Some("content_block_start")
                && let Some(block) = value.get("content_block")
                && is_block(block)
            {
                out.push(encode(block));
            }
        }
        return out;
    }
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|message| message.get("content").and_then(|c| c.as_array()).cloned())
        .unwrap_or_default()
        .iter()
        .filter(|block| is_block(block))
        .map(encode)
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

    #[test]
    fn web_search_results_come_from_streams_and_whole_messages() {
        let stream = concat!(
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"server_tool_use\",\"id\":\"s\",\"name\":\"web_search\"}}\n\n",
            "event: content_block_start\n",
            "data: {\"type\":\"content_block_start\",\"index\":2,\"content_block\":{\"type\":\"web_search_tool_result\",\"tool_use_id\":\"s\",\"content\":[{\"type\":\"web_search_result\",\"url\":\"https://example.com\"}]}}\n\n",
            "event: content_block_stop\n",
            "data: {\"type\":\"content_block_stop\",\"index\":2}\n\n",
        );
        let found = web_search_results(Some("text/event-stream; charset=utf-8"), stream.as_bytes());
        assert_eq!(found.len(), 1);
        let block: serde_json::Value = serde_json::from_slice(&found[0]).unwrap();
        assert_eq!(block["content"][0]["url"], "https://example.com");

        let message = br#"{"content":[{"type":"text","text":"x"},{"type":"web_search_tool_result","tool_use_id":"s","content":[]}]}"#;
        assert_eq!(
            web_search_results(Some("application/json"), message).len(),
            1
        );
        assert!(web_search_results(Some("text/event-stream"), b"data: nope\n\n").is_empty());
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
