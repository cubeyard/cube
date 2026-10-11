//! `OPERATIONS`: one guest request is one JSON header line and a raw body; the
//! answer is one JSON header line and a raw body. Errors are answered as
//! `{"error": {"code", "message"}}`, as cube-guest's `call` writes them.
//! This agent takes `hello`, `exec`, `get` and `cancel` (masterplan K-5a)
//! and `read`, `write` and `stat` (K-5b); services and the portal come with
//! K-5c, and `install` never: keel's agent is replaced with a keel release.
use serde_json::{Value, json};

use crate::journal::{Answer, Fail, Journal, Limits, MAX_HEADER_BYTES, integer};

/// What `hello` advertises: only what this agent implements.
pub const CAPABILITIES: [&str; 7] = [
    "exec.start",
    "exec.cancel",
    "operation.get",
    "fs.read",
    "fs.write",
    "fs.stat",
    "fs.absolute",
];
/// Every name cube-guest takes; the others are answered as unsupported.
const KNOWN: [&str; 10] = [
    "hello", "exec", "get", "cancel", "read", "write", "stat", "services", "install", "portal",
];

fn read_request(data: &[u8]) -> Result<(Value, &[u8]), Fail> {
    let end = data
        .iter()
        .take(MAX_HEADER_BYTES + 1)
        .position(|&b| b == b'\n')
        .ok_or_else(|| Fail::invalid("request header must be one JSON line"))?;
    let header: Value = serde_json::from_slice(&data[..end])
        .map_err(|_| Fail::invalid("request header is not JSON"))?;
    if !header.is_object() {
        return Err(Fail::invalid("request header must be an object"));
    }
    let length = match header.get("length") {
        None => 0,
        value => integer(value, 0, Some(Limits::MAX_WRITE_BYTES as i64))
            .ok_or_else(|| Fail::invalid("invalid body length"))?,
    } as usize;
    let rest = &data[end + 1..];
    if rest.len() < length {
        return Err(Fail::invalid("request body is shorter than its length"));
    }
    Ok((header, &rest[..length]))
}

/// Answers one guest operation; `hello` is the agent's own description.
pub fn call(
    op: &str,
    data: &[u8],
    journal: Option<&Journal>,
    hello: &dyn Fn() -> Value,
) -> Vec<u8> {
    let answer: Answer = (|| {
        if !KNOWN.contains(&op) {
            return Err(Fail::new("UNSUPPORTED", "unknown operation"));
        }
        let (header, body) = read_request(data)?;
        let journal =
            || journal.ok_or_else(|| Fail::new("UNAVAILABLE", "the machine is not ready"));
        match op {
            "hello" => Ok((hello(), vec![])),
            "exec" => journal()?.exec(&header),
            "get" => journal()?.get(&header),
            "cancel" => journal()?.cancel(&header),
            "read" => journal()?.read(&header),
            "write" => journal()?.write(&header, body),
            "stat" => journal()?.stat(&header),
            other => Err(Fail::new(
                "UNSUPPORTED",
                format!("{other} is not implemented by this cube-agent"),
            )),
        }
    })();
    let (header, payload) = answer.unwrap_or_else(|failure| {
        let message: String = failure.message.chars().take(256).collect();
        (
            json!({"error": {"code": failure.code, "message": message}}),
            vec![],
        )
    });
    let mut bytes = header.to_string().into_bytes();
    bytes.push(b'\n');
    bytes.extend(payload);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(bytes: &[u8]) -> Value {
        let end = bytes.iter().position(|&b| b == b'\n').unwrap();
        serde_json::from_slice(&bytes[..end]).unwrap()
    }

    #[test]
    fn requests_are_checked_as_cube_guest_checks_them() {
        let hello = || json!({"version": "x"});
        assert_eq!(
            header(&call("hello", b"{}\n", None, &hello)),
            json!({"version": "x"})
        );
        assert_eq!(
            header(&call("shout", b"{}\n", None, &hello))["error"]["code"],
            "UNSUPPORTED"
        );
        assert_eq!(
            header(&call("hello", b"{}", None, &hello))["error"]["message"],
            "request header must be one JSON line"
        );
        assert_eq!(
            header(&call("hello", b"[]\n", None, &hello))["error"]["message"],
            "request header must be an object"
        );
        assert_eq!(
            header(&call("hello", b"nope\n", None, &hello))["error"]["message"],
            "request header is not JSON"
        );
        assert_eq!(
            header(&call("hello", b"{\"length\":4}\nab", None, &hello))["error"]["message"],
            "request body is shorter than its length"
        );
        assert_eq!(
            header(&call("hello", b"{\"length\":true}\n", None, &hello))["error"]["message"],
            "invalid body length"
        );
        let long = format!("{{\"x\":\"{}\"}}\n", "a".repeat(MAX_HEADER_BYTES));
        assert_eq!(
            header(&call("hello", long.as_bytes(), None, &hello))["error"]["code"],
            "INVALID_REQUEST"
        );
        assert_eq!(
            header(&call("exec", b"{}\n", None, &hello))["error"]["code"],
            "UNAVAILABLE"
        );
        assert_eq!(
            header(&call("read", b"{}\n", None, &hello))["error"]["code"],
            "UNAVAILABLE"
        );
        assert_eq!(
            header(&call("services", b"{}\n", None, &hello))["error"]["code"],
            "UNSUPPORTED"
        );
        assert_eq!(
            header(&call("install", b"{}\n", None, &hello))["error"]["code"],
            "UNSUPPORTED"
        );
    }
}
