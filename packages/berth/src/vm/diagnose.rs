//! `machine_diagnose` on `berth vm` (masterplan B-9): read-only evidence
//! about one machine, as one JSON document in `Diagnosis.json`, for cubed
//! and OptChat to show when a thread's machine fails.
//!
//! ```text
//! machine   its record: phase, boot, fence epoch, image and layers, build, template
//! qemu      path and version (A17), machine type, accelerator, pid, argv of the newest boot, qemu.log's tail
//! qmp       query-status while it runs, within QMP_BUDGET; else null and why
//! console   the tail of console.log (the newest boot's)
//! events    the newest lines of events.log
//! guest     what the agent last said (GuestInfo); null and why
//! egress    the policy of the newest start, the lease, the newest refusals
//! runner    version, the directory's free space, the layer cache, templates
//! iroh      every connection from cubed: its paths (direct or relay), the one in use, RTT (U15 (a))
//! ```
//!
//! Read only: the fence is checked (owner, a deleted machine, a stale
//! epoch) and never raised, no lock of a mutation (`ops`) is taken, no file
//! is written or touched (not the layer cache's use times either), and the
//! guest channel is not used; QEMU is asked `query-status` only. Evidence
//! that is missing, old or unknown says so (`present`, `current`, `reason`)
//! rather than looking like a success. Every string is made safe for a
//! terminal and has secret-looking values and cube's placeholders redacted
//! (the cleaning is node-transport's `diagnose.rs`, copied: berth does not
//! depend on node-transport, which goes with p3), and the document is at
//! most MAX_DIAGNOSIS_BYTES: logs go first when it would be larger.
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    os::unix::fs::MetadataExt,
    path::Path,
    time::{Duration, Instant},
};

use cube_runner_protocol::{
    Timestamp,
    proto::{self, Code},
    refuse,
};
use serde_json::{Map, Value, json};

use super::{Answer, Phase, State, VmRunner, qemu, setup_layers, template};

/// The whole document, at most.
pub const MAX_DIAGNOSIS_BYTES: usize = 256 * 1024;
/// console.log's last bytes.
pub const CONSOLE_TAIL: u64 = 32 * 1024;
/// qemu.log's last bytes (QEMU's own stderr, every boot).
pub const QEMU_LOG_TAIL: u64 = 8 * 1024;
/// events.log is read from this far before its end ...
pub const EVENTS_TAIL: u64 = 64 * 1024;
/// ... and this many of its newest lines are shown, each at most
/// EVENT_LINE_BYTES after cleaning.
pub const EVENTS_RETURNED: usize = 200;
pub const EVENT_LINE_BYTES: usize = 512;
/// Any other string, after cleaning.
pub const STRING_BYTES: usize = 4096;
/// argv.json is read only up to this size.
const ARGV_BYTES: u64 = 64 * 1024;
/// QMP's `query-status`: connect, greeting and answer, in all. A stop that
/// quits QEMU meanwhile waits at most this long for the socket (QMP serves
/// one client at a time).
pub const QMP_BUDGET: Duration = Duration::from_secs(1);
/// The document's format.
pub const VERSION: u32 = 1;
/// What a dropped part says.
pub const DROPPED: &str = "[dropped: the diagnosis was too large]";

/// A character a terminal could act on, or that hides or reorders text.
fn unsafe_char(c: char) -> bool {
    c.is_control()
        || matches!(c as u32,
            0x200b..=0x200f | 0x2028..=0x202e | 0x2060..=0x2069 | 0xfeff | 0xfff9..=0xfffb
            | 0xe0000..=0xe007f)
}

/// Text safe to print anywhere, at most `max_bytes` long: newlines and tabs
/// stay, `\r\n` becomes `\n`, other control characters and invalid UTF-8
/// become `\xNN`, invisible or reordering characters `\u{NNNN}`. Idempotent:
/// backslashes are kept as they are, so escapes are not reversible. Returns
/// whether it was cut.
pub fn safe_text(bytes: &[u8], max_bytes: usize) -> (String, bool) {
    let mut out = String::with_capacity(bytes.len().min(max_bytes));
    let push = |piece: &str, out: &mut String| {
        if out.len() + piece.len() > max_bytes {
            return false;
        }
        out.push_str(piece);
        true
    };
    for chunk in bytes.utf8_chunks() {
        let mut chars = chunk.valid().chars().peekable();
        while let Some(c) = chars.next() {
            let mut buffer = [0u8; 4];
            let escaped;
            let piece: &str = match c {
                '\n' | '\t' => c.encode_utf8(&mut buffer),
                '\r' if chars.peek() == Some(&'\n') => continue,
                c if (c as u32) < 0x80 && unsafe_char(c) => {
                    escaped = format!("\\x{:02x}", c as u32);
                    &escaped
                }
                c if unsafe_char(c) => {
                    escaped = format!("\\u{{{:04x}}}", c as u32);
                    &escaped
                }
                c => c.encode_utf8(&mut buffer),
            };
            if !push(piece, &mut out) {
                return (out, true);
            }
        }
        for byte in chunk.invalid() {
            if !push(&format!("\\x{byte:02x}"), &mut out) {
                return (out, true);
            }
        }
    }
    (out, false)
}

const TOKEN_PREFIXES: [&str; 12] = [
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "glpat-",
    "sk-ant-",
    "sk-proj-",
    "xoxb-",
    "xoxp-",
    "AKIA",
];
const SECRET_KEYS: [&str; 8] = [
    "password",
    "passwd",
    "secret",
    "token",
    "api_key",
    "apikey",
    "api-key",
    "private_key",
];
pub const REDACTED: &str = "[redacted]";
/// cube's secret placeholders (`cube_ph_<name>_<22 base62>`): not secrets,
/// but a diagnosis carries none (masterplan B-9). The name stays.
const PLACEHOLDER: &str = "cube_ph_";

fn token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_' || b == b'-'
}

fn starts_with_ignore_case(bytes: &[u8], at: usize, word: &str) -> bool {
    bytes
        .get(at..at + word.len())
        .is_some_and(|slice| slice.eq_ignore_ascii_case(word.as_bytes()))
}

/// The span of a secret value that starts at `i`, if one does.
fn secret_at(bytes: &[u8], i: usize) -> Option<(usize, usize)> {
    let run = |from: usize, accept: &dyn Fn(u8) -> bool| {
        bytes[from..].iter().take_while(|&&b| accept(b)).count()
    };
    // Anywhere, also glued to other text: its value after the name.
    if bytes[i] == b'c' && bytes[i..].starts_with(PLACEHOLDER.as_bytes()) {
        let name = i + PLACEHOLDER.len();
        let length = run(name, &|b| b.is_ascii_lowercase() || b.is_ascii_digit());
        let start = if length > 0 && bytes.get(name + length) == Some(&b'_') {
            name + length + 1
        } else {
            name
        };
        let length = run(start, &|b| b.is_ascii_alphanumeric());
        if length > 0 {
            return Some((start, start + length));
        }
    }
    let boundary = i == 0 || !token_byte(bytes[i - 1]);
    if boundary {
        for prefix in TOKEN_PREFIXES {
            if bytes[i..].starts_with(prefix.as_bytes()) {
                let start = i + prefix.len();
                let length = run(start, &token_byte);
                if length >= 12 {
                    return Some((start, start + length));
                }
            }
        }
        if starts_with_ignore_case(bytes, i, "bearer ") {
            let start = i + 7 + run(i + 7, &|b| b == b' ');
            let length = run(start, &|b| token_byte(b) || b"._~+/=".contains(&b));
            if length >= 8 {
                return Some((start, start + length));
            }
        }
    }
    for key in SECRET_KEYS {
        if !starts_with_ignore_case(bytes, i, key) {
            continue;
        }
        let mut at = i + key.len();
        at += run(at, &|b| b == b'"' || b == b'\'');
        at += run(at, &|b| b == b' ' || b == b'\t');
        if !matches!(bytes.get(at), Some(b'=' | b':')) {
            continue;
        }
        at += 1;
        at += run(at, &|b| b == b' ' || b == b'\t' || b == b'"' || b == b'\'');
        let length = run(at, &|b| {
            !b.is_ascii_whitespace() && !b"\"',;&}<>".contains(&b)
        });
        if length > 0 && &bytes[at..at + length] != REDACTED.as_bytes() {
            return Some((at, at + length));
        }
    }
    None
}

pub const REDACTED_KEY: &str = "[redacted private key]";
/// What `read_window` puts where it left bytes out: an excerpt's tail may
/// start inside a key whose BEGIN line was omitted.
const OMITTED: &str = " bytes omitted ...]";

/// A `-----BEGIN … PRIVATE KEY-----` or `-----END …` line marker (any key
/// type, PGP's `PRIVATE KEY BLOCK`, any case): (start, end, is_begin).
fn key_markers(text: &str) -> Vec<(usize, usize, bool)> {
    const PRIVATE: &[u8] = b"PRIVATE KEY";
    let bytes = text.as_bytes();
    let mut markers = Vec::new();
    let mut at = 0;
    while at + PRIVATE.len() <= bytes.len() {
        if !bytes[at..at + PRIVATE.len()].eq_ignore_ascii_case(PRIVATE) {
            at += 1;
            continue;
        }
        // The key type between BEGIN/END and PRIVATE KEY: letters, digits,
        // spaces, and never longer than an armor's (bounded: linear time).
        let mut start = at;
        while start > 0
            && at - start < 48
            && (bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b' ')
        {
            start -= 1;
        }
        let words = &text[start..at];
        let words = words.trim_start_matches(' ');
        let begin = words.len() >= 6 && words[..6].eq_ignore_ascii_case("BEGIN ");
        let end_word = words.len() >= 4 && words[..4].eq_ignore_ascii_case("END ");
        // A dash before the word, or the text starts there (cut off).
        let dashed = start == 0 || bytes[start - 1] == b'-';
        let mut end = at + PRIVATE.len();
        if (begin || end_word) && dashed {
            while end < bytes.len()
                && (bytes[end].is_ascii_alphabetic() || bytes[end] == b' ')
                && !bytes[end..].starts_with(b" -")
            {
                end += 1;
            }
            end += bytes[end..].iter().take_while(|&&b| b == b'-').count();
            while start > 0 && bytes[start - 1] == b'-' {
                start -= 1;
            }
            markers.push((start, end, begin));
        }
        at = end;
    }
    markers
}

/// Whether `b` can be part of a base64 run.
fn base64_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'='
}

/// Between two key lines: one line break (as it is or escaped), then a
/// prefix like the previous key line's (`[   12.5] cloud-init[1]: `; digits
/// may differ), if it had one.
fn next_key_line(gap: &str, prefix: &str) -> bool {
    let gap = gap
        .replace("\\x0d", "\n")
        .replace("\\x0a", "\n")
        .replace("\\r", "")
        .replace("\\n", "\n");
    let rest = gap.trim_start_matches([' ', '\t', '"', '\'', ',']);
    let Some(rest) = rest.strip_prefix('\n') else {
        return false;
    };
    let rest = rest.strip_prefix('\n').unwrap_or(rest);
    let alike = rest.len() == prefix.len()
        && rest
            .bytes()
            .zip(prefix.bytes())
            .all(|(a, b)| a == b || (a.is_ascii_digit() && b.is_ascii_digit()));
    alike || rest.trim_matches([' ', '\t', '"', '\'', ',']).is_empty()
}

/// What comes before `at` on its line (after a newline, an escaped CR or
/// an escaped newline, or the text's start), if that is at most 128 bytes.
fn line_prefix(text: &str, at: usize) -> &str {
    let bytes = text.as_bytes();
    let from = at.saturating_sub(129);
    let line = (from..at).rev().find(|&k| {
        bytes[k] == b'\n'
            || (k >= 3 && &bytes[k - 3..=k] == b"\\x0d")
            || (k >= 1 && &bytes[k - 1..=k] == b"\\n")
    });
    match line {
        Some(k) => &text[k + 1..at],
        None if from == 0 => &text[..at],
        None => "",
    }
}

/// Key bodies whose BEGIN and END lines were both cut off: base64 runs of
/// 60+ characters in mixed case with digits (PEM and OpenSSH key lines are
/// 64 and 70), the lines that continue them (the last one shorter), and
/// anything with the OpenSSH key magic. A public key after its type
/// (`ssh-ed25519 AAAA…`) stays. Linear in the text's length.
fn redact_key_bodies(text: &str) -> String {
    const OPENSSH_MAGIC: &str = "b3BlbnNzaC1rZXktdjE";
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut i, mut copied) = (0, 0);
    // Where the last key line ended, and what came before it on its line.
    let mut previous: Option<(usize, &str)> = None;
    while i < bytes.len() {
        if !base64_byte(bytes[i]) || (i > 0 && base64_byte(bytes[i - 1])) {
            i += 1;
            continue;
        }
        let end = i + bytes[i..].iter().take_while(|&&b| base64_byte(b)).count();
        // A run right after an escape (`\x0d`, `\n`) starts after it.
        let mut start = i;
        if i > 0 && bytes[i - 1] == b'\\' {
            if bytes[i] == b'x'
                && end - i >= 3
                && bytes[i + 1..i + 3].iter().all(u8::is_ascii_hexdigit)
            {
                start += 3;
            } else if matches!(bytes[i], b'n' | b'r' | b't') {
                start += 1;
            }
        }
        let run = &text[start..end];
        let long = run.len() >= 60
            && run.bytes().any(|b| b.is_ascii_uppercase())
            && run.bytes().any(|b| b.is_ascii_lowercase())
            && run.bytes().any(|b| b.is_ascii_digit());
        let before = &bytes[i.saturating_sub(40)..i];
        let word = before.trim_ascii_end();
        let word = &word[word
            .iter()
            .rposition(|b| matches!(b, b' ' | b'\n' | b'"' | b'\''))
            .map_or(0, |n| n + 1)..];
        let public = [&b"ssh-"[..], b"ecdsa-", b"sk-ssh-", b"sk-ecdsa-"]
            .iter()
            .any(|kind| word.starts_with(kind));
        // A continuation is a whole line of its own, right after a key line.
        let spaces = bytes[end..]
            .iter()
            .take(8)
            .take_while(|&&b| b == b' ' || b == b'\t')
            .count();
        let line_ends = matches!(
            bytes.get(end + spaces),
            None | Some(b'\n' | b'\\' | b'"' | b'\'')
        );
        let continued = run.len() >= 4
            && line_ends
            && previous
                .is_some_and(|(p, prefix)| i - p <= 160 && next_key_line(&text[p..start], prefix));
        if (long && !public) || continued || run.contains(OPENSSH_MAGIC) {
            out.push_str(&text[copied..start]);
            out.push_str(REDACTED_KEY);
            copied = end;
            // A key's lines are all full but its last: a shorter one ends it.
            previous = (run.len() >= 60).then(|| (end, line_prefix(text, start)));
        }
        i = end;
    }
    out.push_str(&text[copied..]);
    out
}

/// Private key blocks become `[redacted private key]`. A key whose END was
/// cut off is redacted to the end; one whose BEGIN was cut off, from where
/// the text (or the excerpt's tail) starts.
fn redact_keys(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    // Copied up to; where a key body with no BEGIN may start.
    let (mut copied, mut floor) = (0, 0);
    let markers = key_markers(text);
    let mut next = 0;
    while next < markers.len() {
        let (start, end, begin) = markers[next];
        next += 1;
        if start < copied {
            continue;
        }
        if begin {
            out.push_str(&text[copied..start]);
            out.push_str(REDACTED_KEY);
            // Its END, if it is in this part of the excerpt: an END past an
            // omission is another key's (or this one's cut tail).
            let limit = text[end..].find(OMITTED).map_or(text.len(), |n| {
                text[..end + n]
                    .rfind('\n')
                    .map_or(end, |line| line.max(end))
            });
            match markers[next..].iter().position(|m| !m.2) {
                Some(close) if markers[next + close].0 < limit => {
                    copied = markers[next + close].1;
                    next += close + 1;
                }
                _ => copied = limit,
            }
        } else {
            let from = text[floor..start]
                .rfind(OMITTED)
                .map_or(floor, |n| floor + n + OMITTED.len());
            out.push_str(&text[copied..from.max(copied)]);
            out.push_str(REDACTED_KEY);
            copied = end;
        }
        floor = copied;
    }
    out.push_str(&text[copied..]);
    redact_key_bodies(&out)
}

/// Replaces private keys (see `redact_keys`), well-known token formats,
/// bearer tokens and the values of password/secret/token keys with
/// `[redacted]`.
pub fn redact(text: &str) -> String {
    let keys = redact_keys(text);
    let bytes = keys.as_bytes();
    let mut out = String::with_capacity(keys.len());
    let (mut i, mut copied) = (0, 0);
    while i < bytes.len() {
        if let Some((start, end)) = secret_at(bytes, i) {
            out.push_str(&keys[copied..start]);
            out.push_str(REDACTED);
            (i, copied) = (end, end);
        } else {
            i += 1;
        }
    }
    out.push_str(&keys[copied..]);
    out
}

/// `safe_text` then `redact`, cut to `max_bytes`.
pub fn clean(bytes: &[u8], max_bytes: usize) -> (String, bool) {
    let (text, cut) = safe_text(bytes, max_bytes);
    let mut text = text; // CONTROL: no redaction
    let mut cut = cut;
    if text.len() > max_bytes {
        let mut end = max_bytes;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
        cut = true;
    }
    (text, cut)
}

/// Every string in `value` (keys included) cleaned and bounded.
pub fn clean_value(value: Value, max_bytes: usize) -> Value {
    match value {
        Value::String(text) => Value::String(clean(text.as_bytes(), max_bytes).0),
        Value::Array(items) => Value::Array(
            items
                .into_iter()
                .map(|v| clean_value(v, max_bytes))
                .collect(),
        ),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .map(|(k, v)| (clean(k.as_bytes(), 128).0, clean_value(v, max_bytes)))
                .collect::<Map<_, _>>(),
        ),
        other => other,
    }
}

/// The last `tail` bytes of the regular file `path`, its size and when it
/// last changed. None: it does not exist, is not a regular file or cannot
/// be read.
fn read_tail(path: &Path, tail: u64) -> Option<(Vec<u8>, u64, Option<Timestamp>)> {
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    file.seek(SeekFrom::Start(size.saturating_sub(tail))).ok()?;
    let mut bytes = Vec::new();
    file.take(tail).read_to_end(&mut bytes).ok()?;
    Some((bytes, size, metadata.modified().ok().map(Timestamp::from)))
}

/// The end of a log as a cleaned excerpt: its size, when it last changed,
/// how much of its start is left out, and whether the excerpt is all of it.
pub fn log_tail(path: &Path, tail: u64) -> Value {
    match read_tail(path, tail) {
        None => json!({ "present": false }),
        Some((bytes, size, modified)) => {
            // Escaping grows text at most fourfold.
            let (text, cut) = clean(&bytes, 4 * tail as usize + 64);
            let omitted = size - bytes.len() as u64;
            json!({
                "present": true,
                "bytes": size,
                "modifiedAt": modified,
                "omittedBytes": omitted,
                "complete": omitted == 0 && !cut,
                "text": text,
            })
        }
    }
}

/// The newest lines of the machine's `events.log` (`<time> <what>:
/// <detail>`, written by the runner), oldest first. The window is cleaned
/// whole, so a key across lines is redacted, then cut into lines of at most
/// EVENT_LINE_BYTES; a first line the window starts inside is left out.
pub fn event_lines(path: &Path) -> Value {
    let Some((bytes, size, modified)) = read_tail(path, EVENTS_TAIL) else {
        return json!({ "present": false });
    };
    let (text, _) = clean(&bytes, 4 * EVENTS_TAIL as usize + 64);
    let mut lines: Vec<&str> = text.split('\n').collect();
    let mut omitted_bytes = size - bytes.len() as u64;
    if omitted_bytes > 0 && !lines.is_empty() {
        let partial = lines.remove(0);
        omitted_bytes += partial.len() as u64;
    }
    lines.retain(|line| !line.is_empty());
    let skip = lines.len().saturating_sub(EVENTS_RETURNED);
    let shown: Vec<String> = lines[skip..]
        .iter()
        .map(|line| cut_at(line, EVENT_LINE_BYTES))
        .collect();
    json!({
        "present": true,
        "bytes": size,
        "modifiedAt": modified,
        "omittedBytes": omitted_bytes,
        "omittedLines": skip,
        "lines": shown,
    })
}

/// `text` cut to at most `max` bytes, on a character boundary.
fn cut_at(text: &str, max: usize) -> String {
    let mut end = text.len().min(max);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text[..end].to_owned()
}

/// A file's size, the room it takes and when it last changed; null when
/// there is none.
fn file_facts(path: &Path) -> Value {
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => json!({
            "bytes": metadata.len(),
            "allocatedBytes": metadata.blocks() * 512,
            "modifiedAt": metadata.modified().ok().map(Timestamp::from),
        }),
        _ => Value::Null,
    }
}

/// The QEMU command line the runner recorded at the machine's newest start
/// (`argv.json`), or why there is none.
fn recorded_argv(dir: &Path) -> Value {
    let path = dir.join("argv.json");
    let Ok(metadata) = std::fs::metadata(&path) else {
        return json!({
            "present": false,
            "reason": "argv.json is missing: the runner writes it at every start, so this machine was never started",
        });
    };
    if !metadata.is_file() || metadata.len() > ARGV_BYTES {
        return json!({
            "present": false,
            "reason": format!("argv.json is not a file of at most {ARGV_BYTES} bytes"),
        });
    }
    match std::fs::read(&path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    {
        Some(argv) if argv["args"].is_array() => json!({
            "present": true,
            "modifiedAt": metadata.modified().ok().map(Timestamp::from),
            "qemu": argv["qemu"],
            "args": argv["args"],
        }),
        _ => json!({
            "present": false,
            "reason": "argv.json is not the runner's record of a start",
        }),
    }
}

/// The machine `reference` names, for a diagnosis: this owner's, not
/// deleted, and `fence` not older than its epoch (`stale_epoch`). Unlike a
/// mutation's fence, the epoch is never raised and nothing is written.
pub(super) fn diagnosed<'a>(
    state: &'a State,
    reference: Option<&proto::Ref>,
    fence: Option<&proto::Fence>,
) -> Answer<&'a super::Entry> {
    let reference = reference.ok_or_else(|| {
        refuse(
            Code::InvalidArgument,
            "ref",
            "a machine reference is required",
        )
    })?;
    let epoch = fence.map_or(0, |fence| fence.epoch);
    if epoch < 1 {
        return Err(refuse(
            Code::InvalidArgument,
            "fence",
            "a fence epoch of at least 1 is required",
        ));
    }
    if let Some(gone) = state.deleted.get(&reference.id)
        && gone.owner == reference.owner
    {
        return Err(refuse(
            Code::FailedPrecondition,
            "deleted",
            "the machine was deleted",
        ));
    }
    let entry = state
        .machines
        .get(&reference.id)
        .filter(|entry| entry.record.owner == reference.owner)
        .ok_or_else(|| refuse(Code::NotFound, "machine", "no such machine"))?;
    if epoch < entry.record.fence_epoch {
        return Err(refuse(
            Code::FailedPrecondition,
            "stale_epoch",
            "a newer epoch has been used for this machine",
        ));
    }
    Ok(entry)
}

fn millis(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

/// What a diagnosis reads of the machine under the state lock; the rest is
/// read after it is let go.
struct Snapshot {
    record: super::MachineRecord,
    /// QEMU's pid and whether the reaper saw it exit.
    live: Option<(u32, bool)>,
    info: Option<proto::GuestInfo>,
    channel: bool,
    network: bool,
    policy: Option<(Value, Duration)>,
    machines: (usize, usize),
    templates: (usize, u64),
}

impl VmRunner {
    /// `machine_diagnose` (masterplan B-9); see the module's comment.
    pub(super) async fn diagnose(&self, request: proto::MachineRef) -> Answer<proto::Diagnosis> {
        let collected_at = Timestamp::now();
        let snapshot = {
            let state = self.state.lock().unwrap();
            let entry = diagnosed(&state, request.r#ref.as_ref(), request.fence.as_ref())?;
            Snapshot {
                record: entry.record.clone(),
                live: entry
                    .live
                    .as_ref()
                    .map(|live| (live.pid, *live.exited.borrow())),
                info: entry.info.clone(),
                channel: entry.guest.is_some(),
                network: entry.net.is_some(),
                policy: entry
                    .policy
                    .as_ref()
                    .map(|policy| (policy.summary(), policy.lease)),
                machines: (
                    state.machines.len(),
                    state.machines.values().filter(|e| e.live.is_some()).count(),
                ),
                templates: (
                    state.templates.len(),
                    state.templates.values().map(|t| t.bytes).sum(),
                ),
            }
        };
        let id = snapshot.record.id.clone();
        let dir = self.machine_dir(&id);
        let qmp = self.query_status(&id, &snapshot).await;
        let mut document = json!({
            "version": VERSION,
            "collectedAt": collected_at,
            "machine": self.machine_facts(&snapshot, &dir),
            "qemu": self.qemu_facts(&snapshot, &dir),
            "qmp": qmp,
            "guest": guest_facts(&snapshot),
            "egress": self.egress_facts(&snapshot, &id),
            "runner": self.runner_facts(&snapshot),
            "iroh": self.iroh_facts(),
        });
        document = clean_value(document, STRING_BYTES);
        // The logs, cleaned as they are read, with their own bounds.
        document["qemu"]["log"] = log_tail(&dir.join("qemu.log"), QEMU_LOG_TAIL);
        let current = snapshot.record.phase.live() && running(&snapshot);
        let mut console = log_tail(&dir.join(qemu::CONSOLE), CONSOLE_TAIL);
        if let Some(console) = console.as_object_mut() {
            console.insert(
                "bootId".into(),
                json!(snapshot.record.boot.as_ref().map(|b| b.boot_id.clone())),
            );
            console.insert("current".into(), json!(current));
        }
        document["console"] = console;
        document["events"] = event_lines(&dir.join("events.log"));
        Ok(proto::Diagnosis {
            json: bound(document),
        })
    }

    async fn query_status(&self, id: &str, snapshot: &Snapshot) -> Value {
        let phase = snapshot.record.phase;
        let not_asked = match phase {
            Phase::Running if running(snapshot) => None,
            Phase::Running => Some(
                "the record says running, but this runner has no QEMU for the machine".to_owned(),
            ),
            Phase::Starting => {
                Some("the machine is starting: the runner itself asks QMP until it runs".into())
            }
            Phase::Stopping => Some("the machine is stopping: its QEMU is being quit".into()),
            other => Some(format!("the machine is {}: no QEMU runs", other.name())),
        };
        if let Some(reason) = not_asked {
            return json!({ "asked": false, "status": null, "reason": reason });
        }
        let socket = self.machine_dir(id).join(qemu::QMP_SOCKET);
        let started = Instant::now();
        let asked = tokio::time::timeout(QMP_BUDGET, async {
            let mut qmp = qemu::Qmp::open(&socket, QMP_BUDGET).await?;
            qmp.execute("query-status", Value::Null).await
        })
        .await;
        let ms = started.elapsed().as_millis() as u64;
        match asked {
            Ok(Ok(status)) => json!({ "asked": true, "status": status, "reason": null, "ms": ms }),
            Ok(Err(error)) => {
                json!({ "asked": true, "status": null, "reason": format!("QMP: {error:#}"), "ms": ms })
            }
            Err(_) => json!({
                "asked": true,
                "status": null,
                "reason": format!(
                    "QMP did not answer within {} ms (it serves one client at a time, so the runner may be using it)",
                    QMP_BUDGET.as_millis()
                ),
                "ms": ms,
            }),
        }
    }

    fn machine_facts(&self, snapshot: &Snapshot, dir: &Path) -> Value {
        let record = &snapshot.record;
        let live = record.phase.live();
        let layers: Vec<Value> = record
            .image
            .as_ref()
            .map(|image| setup_layers(image, record.template.as_deref()))
            .unwrap_or_default()
            .into_iter()
            .map(|layer| {
                let (source, file) = match &layer.source {
                    Some(proto::layer::Source::DiffId(diff_id)) => (
                        json!({ "diffId": diff_id }),
                        diff_id
                            .parse()
                            .ok()
                            .map(|diff_id| self.cache.path(&diff_id)),
                    ),
                    Some(proto::layer::Source::TemplateId(id)) => (
                        json!({ "templateId": id }),
                        Some(template::layer(&self.options.directory, id)),
                    ),
                    None => (Value::Null, None),
                };
                json!({
                    "partition": layer.partition,
                    "source": source,
                    "file": file.as_ref().map(|f| f.display().to_string()),
                    // Its size only: the cache's use time is not touched.
                    "present": file.as_ref().map(|f| file_facts(f)),
                })
            })
            .collect();
        let files: Map<String, Value> = [
            qemu::RW_DISK,
            keel_layers::disk::DESCRIPTOR,
            template::DISK,
            super::record::RECORD,
            "argv.json",
            qemu::CONSOLE,
            "console.previous.log",
            "qemu.log",
            "events.log",
        ]
        .iter()
        .map(|name| (name.to_string(), file_facts(&dir.join(name))))
        .collect();
        json!({
            "ref": { "owner": record.owner, "id": record.id },
            "phase": record.phase.name(),
            "fenceEpoch": record.fence_epoch,
            "bootId": record.boot.as_ref().filter(|_| live).map(|b| b.boot_id.clone()),
            "newestBoot": record.boot.as_ref().map(|boot| json!({
                "bootId": boot.boot_id,
                "startedAt": boot.started_at,
                "pid": boot.pid,
                "qemu": boot.qemu,
                "kernelSha256": boot.kernel_sha256,
                "baseSha256": boot.base_sha256,
                "current": live,
            })),
            "size": record.size,
            "machineType": record.machine_type,
            "createdWith": record.created_with,
            "createdAt": record.created_at,
            "build": record.build,
            "templateId": record.template,
            "image": record.image,
            "layers": layers,
            "interrupted": record.interrupted,
            "stopped": record.stopped,
            "error": record.error,
            "directory": dir.display().to_string(),
            "files": files,
        })
    }

    fn qemu_facts(&self, snapshot: &Snapshot, dir: &Path) -> Value {
        let (pid, exited) = snapshot
            .live
            .map_or((None, None), |(pid, exited)| (Some(pid), Some(exited)));
        let mut argv = recorded_argv(dir);
        if let Some(argv) = argv.as_object_mut() {
            argv.insert("current".into(), json!(running(snapshot)));
            argv.insert(
                "bootId".into(),
                json!(snapshot.record.boot.as_ref().map(|b| b.boot_id.clone())),
            );
        }
        json!({
            "path": self.options.qemu.display().to_string(),
            "version": self.floor.version,
            "machineType": snapshot.record.machine_type,
            "accelerator": self.options.accel.name(),
            "arch": self.arch.name(),
            "pid": pid,
            "exited": exited,
            "running": running(snapshot),
            "argv": argv,
        })
    }

    fn egress_facts(&self, snapshot: &Snapshot, id: &str) -> Value {
        let cubed = self.egress.presence.now();
        let lease = snapshot.policy.as_ref().map(|(_, lease)| *lease);
        let recent = self.egress.reports.recent(id);
        let policy = match &snapshot.policy {
            Some((summary, _)) => json!({
                "summary": summary,
                "current": running(snapshot),
                "reason": null,
            }),
            None => json!({
                "summary": null,
                "current": false,
                "reason": "no machine_start since the runner started: the policy is kept in memory only",
            }),
        };
        json!({
            "policy": policy,
            "network": snapshot.network,
            "lease": {
                "cubedConnections": cubed.connections,
                "cubedGoneSeconds": (cubed.connections == 0).then(|| cubed.gone_since.elapsed().as_secs_f64()),
                "leaseSeconds": lease.map(|lease| lease.as_secs_f64()),
                "expired": lease.map(|lease| cubed.expired(lease)),
            },
            "refusals": {
                "since": "the runner started (kept in memory)",
                "total": recent.total,
                "newest": recent.items.iter().map(|report| json!({
                    "at": report.at,
                    "host": report.host,
                    "reason": report.reason,
                })).collect::<Vec<_>>(),
            },
        })
    }

    fn runner_facts(&self, snapshot: &Snapshot) -> Value {
        let directory = &self.options.directory;
        let free = (self.options.free_space)(directory);
        let cache = match self.cache.entries() {
            Ok(entries) => json!({
                "dir": self.cache.dir().display().to_string(),
                "bytes": entries.iter().map(|e| e.bytes).sum::<u64>(),
                "layers": entries.len(),
                "limitBytes": self.options.layer_cache_bytes,
            }),
            Err(error) => json!({
                "dir": self.cache.dir().display().to_string(),
                "error": format!("{error:#}"),
                "limitBytes": self.options.layer_cache_bytes,
            }),
        };
        json!({
            "softwareVersion": crate::SOFTWARE_VERSION,
            "nodeId": self.options.node_id,
            "startedAt": self.started_at,
            "os": std::env::consts::OS,
            "network": self.options.network,
            "directory": directory.display().to_string(),
            "freeBytes": free.as_ref().ok(),
            "freeBytesError": free.as_ref().err().map(|e| e.to_string()),
            "keel": {
                "dir": self.options.keel.display().to_string(),
                "kernelSha256": self.keel.kernel_sha256,
                "baseSha256": self.keel.base_sha256,
            },
            "image": {
                "reference": self.image.reference,
                "platform": self.image.record.platform,
                "manifest": self.image.record.manifest.digest,
                "layers": self.image.record.layers.len(),
            },
            "layerCache": cache,
            "templates": { "count": snapshot.templates.0, "bytes": snapshot.templates.1 },
            "machines": {
                "count": snapshot.machines.0,
                "running": snapshot.machines.1,
                "max": self.options.max_machines,
            },
            "caSha256": self.ca.sha256,
        })
    }

    fn iroh_facts(&self) -> Value {
        let presence = &self.egress.presence;
        let connections: Vec<Value> = presence
            .paths()
            .into_iter()
            .map(|connection| {
                json!({
                    "closed": connection.closed,
                    "openPaths": connection.open,
                    "paths": connection.paths.iter().map(|path| json!({
                        "kind": path.kind,
                        "address": path.address,
                        "selected": path.selected,
                        "rttMs": millis(path.rtt),
                        "sentDatagrams": path.sent_datagrams,
                        "receivedDatagrams": path.received_datagrams,
                    })).collect::<Vec<_>>(),
                })
            })
            .collect();
        json!({
            "configuredMode": self.options.network,
            "note": "the configured mode is what the runner allows; the paths are what Iroh uses now",
            "connections": connections,
            "rttToCubedMs": presence.rtt().map(millis),
        })
    }
}

/// QEMU runs for the machine: this runner started it and has not reaped it.
fn running(snapshot: &Snapshot) -> bool {
    snapshot.live.is_some_and(|(_, exited)| !exited)
}

fn guest_facts(snapshot: &Snapshot) -> Value {
    match (&snapshot.info, running(snapshot)) {
        (Some(info), _) => json!({
            "info": serde_json::to_value(info).unwrap_or(Value::Null),
            "reason": null,
        }),
        (None, true) if snapshot.channel => json!({
            "info": null,
            "reason": "the agent has not said hello in this boot yet",
        }),
        (None, true) => json!({
            "info": null,
            "reason": "the runner has no guest channel for this QEMU",
        }),
        (None, false) => json!({
            "info": null,
            "reason": format!(
                "the machine is {}: what its agent said goes with its QEMU",
                snapshot.record.phase.name()
            ),
        }),
    }
}

/// The parts a diagnosis drops, in this order, while it is larger than
/// MAX_DIAGNOSIS_BYTES: the logs first.
const DROPPABLE: [&str; 8] = [
    "/console/text",
    "/events/lines",
    "/qemu/log/text",
    "/egress/refusals/newest",
    "/qemu/argv/args",
    "/guest/info",
    "/iroh/connections",
    "/egress/policy/summary",
];

/// The document as JSON of at most MAX_DIAGNOSIS_BYTES: parts are dropped
/// (and named in `bounds.dropped`) until it fits; if it still does not,
/// only the machine's reference and phase are left.
pub fn bound(mut document: Value) -> String {
    document["bounds"] = json!({ "maxBytes": MAX_DIAGNOSIS_BYTES, "dropped": [] });
    let mut droppable = DROPPABLE.iter();
    loop {
        let text = document.to_string();
        if text.len() <= MAX_DIAGNOSIS_BYTES {
            return text;
        }
        let Some(part) = droppable.next() else { break };
        if let Some(value) = document.pointer_mut(part) {
            *value = DROPPED.into();
            document["bounds"]["dropped"]
                .as_array_mut()
                .unwrap()
                .push(json!(part));
        }
    }
    json!({
        "version": document["version"],
        "collectedAt": document["collectedAt"],
        "machine": { "ref": document["machine"]["ref"], "phase": document["machine"]["phase"] },
        "bounds": { "maxBytes": MAX_DIAGNOSIS_BYTES, "dropped": ["everything else"] },
    })
    .to_string()
}

#[cfg(test)]
mod tests;
