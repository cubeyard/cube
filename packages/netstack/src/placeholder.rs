//! Placeholders: the only form of a secret a guest ever holds,
//! `cube_ph_<name>_<22 base62>`. Recognizing them in request header values
//! (also inside a decoded `Authorization: Basic` value) is shared: the
//! gateway replaces the ones cubed returns, berth refuses requests that
//! carry one where no credential rule applies. No secret is here, only the
//! form; nothing looks at bodies, paths or query strings.
use base64::{Engine, engine::general_purpose::STANDARD};
use http::{HeaderMap, HeaderValue, header};

const PREFIX: &[u8] = b"cube_ph_";
const RANDOM_LEN: usize = 22;

/// Returns the end of a placeholder starting at `start`, if any. A placeholder
/// must not be followed by another alphanumeric character.
pub fn placeholder_end(s: &[u8], start: usize) -> Option<usize> {
    let rest = s.get(start..)?;
    if !rest.starts_with(PREFIX) {
        return None;
    }
    let mut i = start + PREFIX.len();
    let name_start = i;
    while i < s.len() && (s[i].is_ascii_lowercase() || s[i].is_ascii_digit()) {
        i += 1;
    }
    if i == name_start || s.get(i) != Some(&b'_') {
        return None;
    }
    i += 1;
    let random = s.get(i..i + RANDOM_LEN)?;
    if !random.iter().all(u8::is_ascii_alphanumeric) {
        return None;
    }
    let end = i + RANDOM_LEN;
    if s.get(end).is_some_and(u8::is_ascii_alphanumeric) {
        return None;
    }
    Some(end)
}

/// All placeholders in `s`, in order of appearance, without duplicates.
pub fn find(s: &[u8]) -> Vec<String> {
    let mut found: Vec<String> = vec![];
    let mut i = 0;
    while i < s.len() {
        if let Some(end) = placeholder_end(s, i) {
            let p = String::from_utf8_lossy(&s[i..end]).into_owned();
            if !found.contains(&p) {
                found.push(p);
            }
            i = end;
        } else {
            i += 1;
        }
    }
    found
}

pub fn is_placeholder(s: &str) -> bool {
    placeholder_end(s.as_bytes(), 0) == Some(s.len())
}

/// A `Basic` credential's decoded bytes, for `Authorization` and
/// `Proxy-Authorization` only.
pub fn basic_credentials(name: &header::HeaderName, value: &HeaderValue) -> Option<Vec<u8>> {
    if name != header::AUTHORIZATION && name != header::PROXY_AUTHORIZATION {
        return None;
    }
    let bytes = value.as_bytes();
    let scheme = bytes.get(..6)?;
    if !scheme.eq_ignore_ascii_case(b"basic ") {
        return None;
    }
    STANDARD.decode(bytes[6..].trim_ascii()).ok()
}

/// Placeholders in the header values, including decoded Basic credentials.
pub fn scan_headers(headers: &HeaderMap) -> Vec<String> {
    let mut found: Vec<String> = vec![];
    for (name, value) in headers {
        let mut add = |items: Vec<String>| {
            for p in items {
                if !found.contains(&p) {
                    found.push(p);
                }
            }
        };
        add(find(value.as_bytes()));
        if let Some(decoded) = basic_credentials(name, value) {
            add(find(&decoded));
        }
    }
    found
}
