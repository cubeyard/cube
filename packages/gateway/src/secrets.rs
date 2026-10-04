//! Placeholder secrets. The guest only ever holds placeholders of the form
//! `cube_ph_<name>_<22 base62>`. The gateway lists the placeholders it finds
//! in request header values (also inside a decoded `Authorization: Basic`
//! value) and replaces exactly those that cubed's decision returns. It never
//! looks at bodies, paths or query strings.
use anyhow::{Result, bail};
use base64::{Engine, engine::general_purpose::STANDARD};
use http::{HeaderMap, HeaderValue, header};
use std::collections::HashMap;

const PREFIX: &[u8] = b"cube_ph_";
const RANDOM_LEN: usize = 22;

/// Returns the end of a placeholder starting at `start`, if any. A placeholder
/// must not be followed by another alphanumeric character.
fn placeholder_end(s: &[u8], start: usize) -> Option<usize> {
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

fn replace(s: &[u8], map: &HashMap<String, String>) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    let mut i = 0;
    while i < s.len() {
        if let Some(end) = placeholder_end(s, i) {
            let key = std::str::from_utf8(&s[i..end]).unwrap_or_default();
            match map.get(key) {
                Some(value) => out.extend_from_slice(value.as_bytes()),
                None => out.extend_from_slice(&s[i..end]),
            }
            i = end;
        } else {
            out.push(s[i]);
            i += 1;
        }
    }
    out
}

fn basic_credentials(name: &header::HeaderName, value: &HeaderValue) -> Option<Vec<u8>> {
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

/// Replaces the placeholders named in `map` (and only those). Values that
/// would make an invalid header are refused, never sent partially.
pub fn substitute_headers(headers: &mut HeaderMap, map: &HashMap<String, String>) -> Result<()> {
    if map.is_empty() {
        return Ok(());
    }
    for (key, value) in map {
        if !is_placeholder(key) {
            bail!("substitution key is not a placeholder");
        }
        if value.bytes().any(|b| b < 0x20 || b == 0x7f) {
            bail!("substitution value contains control characters");
        }
    }
    for (name, value) in headers.iter_mut() {
        let replaced = if let Some(decoded) = basic_credentials(name, value) {
            let new = replace(&decoded, map);
            if new == decoded {
                None
            } else {
                Some(format!("Basic {}", STANDARD.encode(new)).into_bytes())
            }
        } else {
            let new = replace(value.as_bytes(), map);
            (new != value.as_bytes()).then_some(new)
        };
        if let Some(bytes) = replaced {
            let mut new = HeaderValue::from_bytes(&bytes)?;
            new.set_sensitive(true);
            *value = new;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const GH: &str = "cube_ph_github_AbCdEfGhIjKlMnOpQrStUv";
    const OTHER: &str = "cube_ph_npm_0123456789abcdefABCDEF";

    #[test]
    fn finds_placeholders_with_boundaries() {
        assert!(is_placeholder(GH));
        assert!(is_placeholder(OTHER));
        assert_eq!(find(format!("Bearer {GH}").as_bytes()), vec![GH]);
        assert_eq!(
            find(format!("{GH},{OTHER};{GH}").as_bytes()),
            vec![GH, OTHER]
        );
        // Too short, too long, uppercase name, missing name.
        assert!(find(b"cube_ph_github_AbCdEf").is_empty());
        assert!(find(format!("{GH}x").as_bytes()).is_empty());
        assert!(find(b"cube_ph_GitHub_AbCdEfGhIjKlMnOpQrStUv").is_empty());
        assert!(find(b"cube_ph__AbCdEfGhIjKlMnOpQrStUv").is_empty());
        assert!(!is_placeholder(&format!("{GH} ")));
    }

    fn headers(pairs: &[(&'static str, String)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(*k, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn bearer_substitution_only_for_returned_placeholders() {
        let mut h = headers(&[
            ("authorization", format!("Bearer {GH}")),
            ("x-other", OTHER.to_string()),
        ]);
        assert_eq!(scan_headers(&h), vec![GH, OTHER]);
        let map = HashMap::from([(GH.to_string(), "ghp_real".to_string())]);
        substitute_headers(&mut h, &map).unwrap();
        assert_eq!(h["authorization"], "Bearer ghp_real");
        assert!(h["authorization"].is_sensitive());
        assert_eq!(h["x-other"], OTHER);
    }

    #[test]
    fn basic_credentials_are_decoded_and_reencoded() {
        let encoded = STANDARD.encode(format!("x-access-token:{GH}"));
        let mut h = headers(&[("authorization", format!("basic {encoded}"))]);
        assert_eq!(scan_headers(&h), vec![GH]);
        let map = HashMap::from([(GH.to_string(), "ghp_real".to_string())]);
        substitute_headers(&mut h, &map).unwrap();
        assert_eq!(
            h["authorization"],
            format!("Basic {}", STANDARD.encode("x-access-token:ghp_real"))
        );
        // Not returned: left untouched, byte for byte.
        let mut h = headers(&[("authorization", format!("basic {encoded}"))]);
        substitute_headers(
            &mut h,
            &HashMap::from([(OTHER.to_string(), "x".to_string())]),
        )
        .unwrap();
        assert_eq!(h["authorization"], format!("basic {encoded}"));
    }

    #[test]
    fn invalid_substitutions_are_refused() {
        let mut h = headers(&[("authorization", format!("Bearer {GH}"))]);
        let bad = HashMap::from([(GH.to_string(), "a\r\nx-evil: 1".to_string())]);
        assert!(substitute_headers(&mut h, &bad).is_err());
        let not_placeholder = HashMap::from([("Bearer".to_string(), "x".to_string())]);
        assert!(substitute_headers(&mut h, &not_placeholder).is_err());
        assert_eq!(h["authorization"], format!("Bearer {GH}"));
    }
}
