//! Read-only evidence about one VM for `vm.diagnose`: what the runner
//! recorded about it and what it observes now. Everything is bounded, and
//! every string that leaves the runner is made safe for a terminal (no raw
//! control, format or invalid bytes) and has secret-looking values redacted.
//!
//! The per-VM event log (`vms/<slot>/events.log`, JSON lines) is written
//! from 0.8.3 on; a VM started by an older runner has none, which the
//! diagnosis says rather than implying nothing happened.
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Result, ensure};
use serde_json::{Map, Value, json};

/// An event log larger than this moves to `events.prev.log`.
pub const EVENT_LOG_LIMIT: u64 = 64 * 1024;
/// Events a diagnosis returns, newest last.
pub const EVENTS_RETURNED: usize = 200;
/// One event's detail, after escaping.
pub const EVENT_DETAIL_BYTES: usize = 512;
/// Any other string in a diagnosis, after escaping.
pub const STRING_BYTES: usize = 4096;
/// A log excerpt: up to `head` bytes from its start and `tail` from its end.
#[derive(Clone, Copy, Debug)]
pub struct Window {
    pub head: u64,
    pub tail: u64,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

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
        // The key type between BEGIN/END and PRIVATE KEY: letters, digits, spaces.
        let mut start = at;
        while start > 0 && (bytes[start - 1].is_ascii_alphanumeric() || bytes[start - 1] == b' ') {
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

/// Only line breaks, as they are or escaped, between two base64 runs.
fn line_break_gap(gap: &str) -> bool {
    let gap = gap
        .replace("\\x0d", "")
        .replace("\\x0a", "")
        .replace("\\r", "")
        .replace("\\n", "");
    gap.len() <= 4
        && gap
            .bytes()
            .all(|b| b.is_ascii_whitespace() || b == b'"' || b == b'\'' || b == b',')
}

/// Key bodies whose BEGIN and END lines were both cut off: base64 runs of
/// 60+ characters in mixed case with digits (PEM and OpenSSH key lines are
/// 64 and 70), the shorter runs that continue them on the next lines, and
/// anything with the OpenSSH key magic. A public key after its type
/// (`ssh-ed25519 AAAA…`) stays.
fn redact_key_bodies(text: &str) -> String {
    const OPENSSH_MAGIC: &str = "b3BlbnNzaC1rZXktdjE";
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let (mut i, mut copied) = (0, 0);
    // Where the last redacted run ended.
    let mut previous: Option<usize> = None;
    while i < bytes.len() {
        if !base64_byte(bytes[i]) || (i > 0 && base64_byte(bytes[i - 1])) {
            i += 1;
            continue;
        }
        let end = i + bytes[i..].iter().take_while(|&&b| base64_byte(b)).count();
        let run = &text[i..end];
        let long = run.len() >= 60
            && run.bytes().any(|b| b.is_ascii_uppercase())
            && run.bytes().any(|b| b.is_ascii_lowercase())
            && run.bytes().any(|b| b.is_ascii_digit());
        let public = text[..i]
            .trim_end_matches(' ')
            .rsplit([' ', '\n', '"', '\''])
            .next()
            .is_some_and(|word| {
                word.starts_with("ssh-")
                    || word.starts_with("ecdsa-")
                    || word.starts_with("sk-ssh-")
                    || word.starts_with("sk-ecdsa-")
            });
        // A continuation is a whole line of its own.
        let line_ends = matches!(bytes.get(end), None | Some(b'\n' | b'\\' | b'"' | b'\''));
        let continued =
            run.len() >= 4 && line_ends && previous.is_some_and(|p| line_break_gap(&text[p..i]));
        if (long && !public) || continued || run.contains(OPENSSH_MAGIC) {
            out.push_str(&text[copied..i]);
            out.push_str(REDACTED_KEY);
            copied = end;
            previous = Some(end);
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
            match markers[next..].iter().position(|m| !m.2) {
                Some(close) => {
                    copied = markers[next + close].1;
                    next += close + 1;
                }
                None => {
                    copied = text.len();
                    break;
                }
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
    let mut text = redact(&text);
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

/// Appends one event to a VM's `events.log`. Best effort: a VM directory
/// that is gone (released) is not created again, and a failed write is
/// ignored; diagnostics never fail a VM operation.
pub fn record_event(dir: &Path, event: &str, detail: Option<&str>) {
    if !dir.is_dir() {
        return;
    }
    let path = dir.join("events.log");
    if fs::metadata(&path).is_ok_and(|m| m.len() > EVENT_LOG_LIMIT) {
        let _ = fs::rename(&path, dir.join("events.prev.log"));
    }
    let mut line = json!({ "at": now_ms(), "event": event });
    if let Some(detail) = detail {
        line["detail"] = clean(detail.as_bytes(), EVENT_DETAIL_BYTES).0.into();
    }
    let Ok(mut bytes) = serde_json::to_vec(&line) else {
        return;
    };
    bytes.push(b'\n');
    use std::os::unix::fs::OpenOptionsExt;
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(&path)
    {
        let _ = file.write_all(&bytes);
    }
}

/// The newest events of a VM, oldest first, and how many lines could not
/// be read. `null` when the VM has no event log at all.
pub fn read_events(dir: &Path) -> Value {
    let mut lines: Vec<Vec<u8>> = Vec::new();
    let mut found = false;
    for name in ["events.prev.log", "events.log"] {
        // Each file is bounded by EVENT_LOG_LIMIT plus one line.
        if let Some((bytes, _)) = read_window(&dir.join(name), 0, 2 * EVENT_LOG_LIMIT) {
            found = true;
            lines.extend(
                bytes
                    .split(|&b| b == b'\n')
                    .filter(|l| !l.is_empty())
                    .map(<[u8]>::to_vec),
            );
        }
    }
    if !found {
        return Value::Null;
    }
    let skip = lines.len().saturating_sub(EVENTS_RETURNED);
    let entries: Vec<Value> = lines[skip..]
        .iter()
        .filter_map(|line| {
            let value: Value = serde_json::from_slice(line).ok()?;
            let (Some(at), Some(event)) = (value["at"].as_u64(), value["event"].as_str()) else {
                return None;
            };
            let mut entry = json!({ "at": at, "event": event });
            if let Some(detail) = value["detail"].as_str() {
                entry["detail"] = detail.into();
            }
            Some(entry)
        })
        .collect();
    let unreadable = lines.len() - skip - entries.len();
    json!({ "entries": entries, "omitted": skip, "unreadable": unreadable })
}

/// Up to `head` bytes from the start and `tail` from the end of `path`,
/// and the file's size. None: the file does not exist or cannot be read.
fn read_window(path: &Path, head: u64, tail: u64) -> Option<(Vec<u8>, u64)> {
    let mut file = File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    let mut bytes = Vec::new();
    if size <= head + tail {
        Read::by_ref(&mut file)
            .take(head + tail)
            .read_to_end(&mut bytes)
            .ok()?;
        return Some((bytes, size));
    }
    Read::by_ref(&mut file)
        .take(head)
        .read_to_end(&mut bytes)
        .ok()?;
    let mut end = Vec::new();
    file.seek(SeekFrom::Start(size - tail)).ok()?;
    file.take(tail).read_to_end(&mut end).ok()?;
    bytes.extend_from_slice(
        format!("\n[... {} bytes omitted ...]\n", size - head - tail).as_bytes(),
    );
    bytes.extend(end);
    Some((bytes, size))
}

/// One log file as a cleaned excerpt: its size, when it last changed, and
/// whether the excerpt is the whole file.
pub fn log_excerpt(path: &Path, window: Window) -> Value {
    let modified_at = fs::metadata(path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    match read_window(path, window.head, window.tail) {
        None => json!({ "present": false }),
        Some((bytes, size)) => {
            // Escaping grows text at most fourfold.
            let (text, cut) = clean(&bytes, 4 * (window.head + window.tail) as usize + 64);
            json!({
                "present": true,
                "bytes": size,
                "modifiedAt": modified_at,
                "omittedBytes": size.saturating_sub(window.head + window.tail),
                "complete": size <= window.head + window.tail && !cut,
                "text": text,
            })
        }
    }
}

/// A qcow2 file's virtual size and backing file name, from its header.
pub fn qcow2_header(path: &Path) -> Result<(u64, Option<String>)> {
    let mut file = File::open(path)?;
    let mut header = [0u8; 32];
    file.read_exact(&mut header)?;
    ensure!(&header[..4] == b"QFI\xfb", "not a qcow2 image");
    let backing_offset = u64::from_be_bytes(header[8..16].try_into()?);
    let backing_size = u32::from_be_bytes(header[16..20].try_into()?);
    let virtual_size = u64::from_be_bytes(header[24..32].try_into()?);
    if backing_offset == 0 || backing_size == 0 {
        return Ok((virtual_size, None));
    }
    ensure!(backing_size <= 1023, "backing file name too long");
    let mut name = vec![0u8; backing_size as usize];
    file.seek(SeekFrom::Start(backing_offset))?;
    file.read_exact(&mut name)?;
    Ok((
        virtual_size,
        Some(String::from_utf8_lossy(&name).into_owned()),
    ))
}

/// CPU time (ms) and resident memory (bytes) of a process, if readable.
#[cfg(target_os = "linux")]
pub fn process_usage(pid: u32) -> Option<(u64, u64)> {
    let stat = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // Fields after the command name, which is in parentheses.
    let fields: Vec<&str> = stat.rsplit_once(')')?.1.split_whitespace().collect();
    let utime: u64 = fields.get(11)?.parse().ok()?;
    let stime: u64 = fields.get(12)?.parse().ok()?;
    let rss_pages: u64 = fields.get(21)?.parse().ok()?;
    // SAFETY: sysconf has no preconditions.
    let (ticks, page) = unsafe {
        (
            libc::sysconf(libc::_SC_CLK_TCK),
            libc::sysconf(libc::_SC_PAGESIZE),
        )
    };
    if ticks <= 0 || page <= 0 {
        return None;
    }
    Some((
        (utime + stime) * 1000 / ticks as u64,
        rss_pages * page as u64,
    ))
}

/// CPU time (ms) and resident memory (bytes) of a process, if readable.
#[cfg(target_os = "macos")]
#[allow(deprecated)] // libc points mach_timebase_info at the mach2 crate
pub fn process_usage(pid: u32) -> Option<(u64, u64)> {
    // SAFETY: proc_pidinfo writes at most the size given into a zeroed
    // struct owned by this frame; mach_timebase_info fills a plain struct.
    let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_taskinfo>() as libc::c_int;
    let written = unsafe {
        libc::proc_pidinfo(
            pid as libc::c_int,
            libc::PROC_PIDTASKINFO,
            0,
            (&mut info as *mut libc::proc_taskinfo).cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    let mut timebase = libc::mach_timebase_info { numer: 0, denom: 0 };
    if unsafe { libc::mach_timebase_info(&mut timebase) } != 0 || timebase.denom == 0 {
        return None;
    }
    // Task times are in Mach absolute time units.
    let nanos = u128::from(info.pti_total_user + info.pti_total_system)
        * u128::from(timebase.numer)
        / u128::from(timebase.denom);
    Some(((nanos / 1_000_000) as u64, info.pti_resident_size))
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn process_usage(_pid: u32) -> Option<(u64, u64)> {
    None
}

/// Whether `pid` exists (signal 0).
pub fn process_exists(pid: u32) -> bool {
    // SAFETY: signal 0 only checks existence and permission.
    unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_controls_are_escaped() {
        let hostile = b"ok\x1b[2J\x1b]0;title\x07\x1bc\r\nline\rover\x00\x7f\xc2\x9b31m\xe2\x80\xae\xef\xbb\xbfend\xff\xfe\ttab\\x41";
        let (text, cut) = safe_text(hostile, 4096);
        assert!(!cut);
        assert_eq!(
            text,
            "ok\\x1b[2J\\x1b]0;title\\x07\\x1bc\nline\\x0dover\\x00\\x7f\\u{009b}31m\\u{202e}\\u{feff}end\\xff\\xfe\ttab\\x41"
        );
        assert!(
            !text
                .chars()
                .any(|c| c != '\n' && c != '\t' && unsafe_char(c))
        );
        assert_eq!(safe_text(text.as_bytes(), 4096).0, text, "idempotent");
        let (short, cut) = safe_text(b"\x1b\x1b\x1b", 9);
        assert!(cut);
        assert_eq!(short, "\\x1b\\x1b", "never half an escape");
    }

    #[test]
    fn secrets_are_redacted() {
        let text = "a ghp_0123456789abcdefABCDEF b\nAuthorization: Bearer eyJhbGciOi.payload.sig\n\
            password=hunter2 token: \"abc def\" {\"frameToken\":\"0123abcd\"} tokens: 5\n\
            -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\nafter\n\
            sk-ant-api03-AAAAAAAAAAAAAAAA ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA host";
        let redacted = redact(text);
        for secret in [
            "0123456789abcdefABCDEF",
            "eyJhbGciOi",
            "hunter2",
            "\"abc",
            "0123abcd",
            "b3BlbnNzaC1rZXk",
            "api03-AAAA",
        ] {
            assert!(!redacted.contains(secret), "{secret} in {redacted}");
        }
        for kept in [
            "tokens: 5",
            "after",
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA host",
            "[redacted private key]",
        ] {
            assert!(redacted.contains(kept), "{kept} missing in {redacted}");
        }
        assert_eq!(redact(&redacted), redacted, "idempotent");
        // An excerpt cut inside a key.
        assert_eq!(
            redact("x\n-----BEGIN RSA PRIVATE KEY-----\nMIIE"),
            "x\n[redacted private key]"
        );
        assert_eq!(
            redact("MIIEpAIB\n-----END RSA PRIVATE KEY-----\ny"),
            "[redacted private key]\ny"
        );
        assert_eq!(
            redact("-----BEGIN CERTIFICATE-----\nMIIB\n"),
            "-----BEGIN CERTIFICATE-----\nMIIB\n",
            "certificates are public"
        );
    }

    /// Synthetic key body lines: what a key line looks like, no real key.
    fn body(lines: usize) -> Vec<String> {
        (0..lines)
            .map(|n| format!("SyntheticKeyBody{n}Line{}", "Ab9+/Cd8".repeat(7))[..70].to_string())
            .collect()
    }

    fn assert_no_body(text: &str, lines: &[String]) {
        for line in lines {
            for piece in [&line[..16], &line[line.len() - 16..]] {
                assert!(!text.contains(piece), "{piece} leaked in {text}");
            }
        }
    }

    #[test]
    fn keys_cut_or_escaped_are_redacted() {
        let lines = body(6);
        let joined = lines.join("\n");
        let key = format!(
            "-----BEGIN OPENSSH PRIVATE KEY-----\n{joined}\n-----END OPENSSH PRIVATE KEY-----"
        );
        // An excerpt whose tail starts inside a key, after a head that has
        // other BEGIN and END lines (a certificate, cloud-init's public keys).
        let head = "boot\n-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n\
            -----BEGIN SSH HOST KEY KEYS-----\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPublicHostKeyStaysVisible0123456789abcdefABCD root@cube\n\
            -----END SSH HOST KEY KEYS-----\n";
        let cut = &key[60..];
        let text = format!("{head}\n[... 900 bytes omitted ...]\n{cut}\nlogin:");
        let redacted = redact(&text);
        assert_no_body(&redacted, &lines);
        for kept in [
            "boot",
            "MIIB",
            "PublicHostKeyStaysVisible",
            "omitted ...]",
            "login:",
        ] {
            assert!(redacted.contains(kept), "{kept} missing in {redacted}");
        }
        // A tail that starts inside a key after a whole key.
        let text = format!("{key}\nmiddle\n[... 9 bytes omitted ...]\n{cut}\nend");
        let redacted = redact(&text);
        assert_no_body(&redacted, &lines);
        assert!(redacted.contains("middle") && redacted.contains("end"));
        // Both BEGIN and END cut off: body lines alone, the short last one too.
        let short = "ShortLastLine0Ab9==";
        let text = format!(
            "x\n{}\n{short}\ncloud-init[1]: done",
            lines[1..5].join("\n")
        );
        let redacted = redact(&text);
        assert_no_body(&redacted, &lines[1..5]);
        assert!(!redacted.contains(short), "{redacted}");
        assert!(redacted.contains("cloud-init[1]: done"));
        // A console that ends lines with a lone CR, escaped by safe_text.
        let cr = key.replace('\n', "\r");
        let (escaped, _) = safe_text(cr.as_bytes(), 1 << 16);
        assert_no_body(&redact(&escaped), &lines);
        // The key as a JSON or Python string: one line, escaped newlines.
        let one_line = format!(
            "ssh_keys: {{'ed25519_private': '{}\\n'}} next",
            key.replace('\n', "\\n")
        );
        let redacted = redact(&one_line);
        assert_no_body(&redacted, &lines);
        assert!(redacted.ends_with(" next"), "{redacted}");
        // Its END escaped too, cut off where the excerpt starts.
        assert_no_body(&redact(&one_line[90..]), &lines);
        // Other armors and cases; a prefix on every line.
        for (begin, end) in [
            (
                "-----BEGIN PGP PRIVATE KEY BLOCK-----",
                "-----END PGP PRIVATE KEY BLOCK-----",
            ),
            ("-----begin private key-----", "-----end private key-----"),
            (
                "-----BEGIN ENCRYPTED PRIVATE KEY-----",
                "-----END ENCRYPTED PRIVATE KEY-----",
            ),
        ] {
            let prefixed = format!(
                "[ 12.5] ci: {begin}\n[ 12.5] ci: {}\n[ 12.5] ci: {end}\nok",
                lines.join("\n[ 12.5] ci: ")
            );
            let redacted = redact(&prefixed);
            assert_no_body(&redacted, &lines);
            assert!(redacted.ends_with("\nok"), "{redacted}");
        }
        // Cut by clean's bound inside the key.
        let (cleaned, cut) = clean(key.as_bytes(), 200);
        assert!(cut);
        assert_no_body(&cleaned, &lines);
        // Fingerprints, hashes and paths stay.
        for kept in [
            "256 SHA256:Ab9Cd8Ef7Gh6Ij5Kl4Mn3Op2Qr1St0UvWxYz0123456 root@cube (ED25519)",
            "sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            "/opt/homebrew/share/qemu/edk2-aarch64-code.fd",
        ] {
            assert_eq!(redact(kept), kept);
        }
        for text in [&text, &one_line, &escaped] {
            let once = redact(text);
            assert_eq!(redact(&once), once, "idempotent");
        }
    }

    #[test]
    fn excerpt_cut_inside_a_key_is_redacted() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("console.log");
        let lines = body(40);
        let key = format!(
            "-----BEGIN RSA PRIVATE KEY-----\n{}\n-----END RSA PRIVATE KEY-----\n",
            lines.join("\n")
        );
        // A BEGIN of another kind in the head, the key's BEGIN in the omitted middle.
        let content = format!(
            "-----BEGIN SSH HOST KEY FINGERPRINTS-----\n{}{key}tail\n",
            "k".repeat(2000)
        );
        fs::write(&log, &content).unwrap();
        for window in [
            Window {
                head: 64,
                tail: 1024,
            },
            Window { head: 0, tail: 700 },
            Window {
                head: 2100,
                tail: 300,
            },
        ] {
            let excerpt = log_excerpt(&log, window);
            let text = excerpt["text"].as_str().unwrap();
            assert_no_body(text, &lines);
            assert!(text.contains("[redacted private key]"), "{text}");
        }
    }

    #[test]
    fn values_are_cleaned_everywhere() {
        let value = clean_value(
            json!({"a\x1b": ["x\x1b[0m", {"note": "password=1"}], "n": 3}),
            64,
        );
        assert_eq!(
            value,
            json!({"a\\x1b": ["x\\x1b[0m", {"note": "password=[redacted]"}], "n": 3})
        );
    }

    #[test]
    fn excerpts_and_events_are_bounded() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("console.log");
        assert_eq!(
            log_excerpt(&log, Window { head: 4, tail: 4 }),
            json!({"present": false})
        );
        fs::write(&log, b"0123456789\x1b[2Jabcdefgh").unwrap();
        let excerpt = log_excerpt(&log, Window { head: 4, tail: 4 });
        assert_eq!(excerpt["bytes"], 22);
        assert_eq!(excerpt["omittedBytes"], 14);
        assert_eq!(excerpt["complete"], false);
        assert_eq!(excerpt["text"], "0123\n[... 14 bytes omitted ...]\nefgh");
        let whole = log_excerpt(&log, Window { head: 64, tail: 64 });
        assert_eq!(whole["complete"], true);
        assert_eq!(whole["text"], "0123456789\\x1b[2Jabcdefgh");

        assert_eq!(read_events(dir.path()), Value::Null, "never recorded");
        for n in 0..EVENTS_RETURNED + 5 {
            record_event(dir.path(), "tick", Some(&format!("n={n} \x1b[31m")));
        }
        fs::OpenOptions::new()
            .append(true)
            .open(dir.path().join("events.log"))
            .unwrap()
            .write_all(b"not json\n")
            .unwrap();
        let events = read_events(dir.path());
        let entries = events["entries"].as_array().unwrap();
        assert_eq!(entries.len(), EVENTS_RETURNED - 1);
        assert_eq!(events["omitted"], 6);
        assert_eq!(events["unreadable"], 1);
        assert_eq!(entries.last().unwrap()["detail"], "n=204 \\x1b[31m");
        record_event(&dir.path().join("gone"), "tick", None);
        assert!(!dir.path().join("gone").exists());
        // The log rotates once it is over its bound.
        let long = "x".repeat(EVENT_DETAIL_BYTES);
        for _ in 0..200 {
            record_event(dir.path(), "tick", Some(&long));
        }
        assert!(dir.path().join("events.prev.log").exists());
        assert!(fs::metadata(dir.path().join("events.log")).unwrap().len() <= EVENT_LOG_LIMIT);
    }

    #[test]
    fn qcow2_backing_is_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("d.qcow2");
        let mut header = vec![0u8; 512];
        header[..4].copy_from_slice(b"QFI\xfb");
        header[8..16].copy_from_slice(&100u64.to_be_bytes());
        header[16..20].copy_from_slice(&9u32.to_be_bytes());
        header[24..32].copy_from_slice(&(8u64 << 30).to_be_bytes());
        header[100..109].copy_from_slice(b"../../b.q");
        fs::write(&path, &header).unwrap();
        assert_eq!(
            qcow2_header(&path).unwrap(),
            (8 << 30, Some("../../b.q".into()))
        );
        fs::write(&path, b"nope nope nope nope nope nope nope").unwrap();
        assert!(qcow2_header(&path).is_err());
    }

    #[test]
    fn own_process_usage() {
        let usage = process_usage(std::process::id());
        if cfg!(any(target_os = "linux", target_os = "macos")) {
            let (_, resident) = usage.expect("own process");
            assert!(resident > 0);
        }
        assert!(process_exists(std::process::id()));
    }
}
