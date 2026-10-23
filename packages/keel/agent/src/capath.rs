//! OpenSSL's `-CApath` link for the runner's CA: `/etc/ssl/certs/<hash>.N`
//! → `cube-runner.pem`, as `openssl rehash` (which update-ca-certificates
//! runs only when it adds or removes a certificate) names it. A tool that
//! looks certificates up by directory alone (`-CApath`, Python's `capath`)
//! finds the CA there; one that reads the bundle needs nothing of this.
//!
//! `<hash>` is `X509_NAME_hash`: the first four bytes of the SHA-1 of the
//! subject's canonical encoding, little-endian, as 8 hex digits. The
//! canonical encoding is OpenSSL's `x509_name_canon`: every RDN's SET, each
//! string value (UTF8String, PrintableString, T61String, IA5String,
//! VisibleString, UniversalString, BMPString) as a UTF8String with leading
//! and trailing white space dropped, inner runs of it made one space and
//! ASCII letters lowercased; other values as they are. `N` is the first free
//! number for that hash (another certificate may have the same one).
use std::{
    ffi::{CStr, CString},
    fs, io,
    os::fd::{AsRawFd, OwnedFd},
};

/// The link's target, relative, as `openssl rehash` writes it.
pub const TARGET: &str = "cube-runner.pem";

/// One DER element: its tag, its content and what follows it. Only what a
/// certificate's name needs (one-byte tags, definite lengths).
fn element(data: &[u8]) -> Option<(u8, &[u8], &[u8])> {
    let (&tag, rest) = data.split_first()?;
    if tag & 0x1f == 0x1f {
        return None;
    }
    let (&first, rest) = rest.split_first()?;
    let (length, rest) = match first {
        0..=0x7f => (first as usize, rest),
        0x81..=0x84 => {
            let n = (first & 0x7f) as usize;
            if rest.len() < n {
                return None;
            }
            let length = rest[..n]
                .iter()
                .fold(0usize, |acc, &b| (acc << 8) | b as usize);
            (length, &rest[n..])
        }
        _ => return None,
    };
    (rest.len() >= length).then(|| (tag, &rest[..length], &rest[length..]))
}

fn encode(tag: u8, content: &[u8]) -> Vec<u8> {
    let mut out = vec![tag];
    let n = content.len();
    if n < 0x80 {
        out.push(n as u8);
    } else {
        let bytes: Vec<u8> = n
            .to_be_bytes()
            .into_iter()
            .skip_while(|&b| b == 0)
            .collect();
        out.push(0x80 | bytes.len() as u8);
        out.extend_from_slice(&bytes);
    }
    out.extend_from_slice(content);
    out
}

/// A name's string value as UTF-8, as `ASN1_STRING_to_UTF8` reads it; None
/// for a value that is no string OpenSSL canonicalizes.
fn utf8(tag: u8, content: &[u8]) -> Option<Result<String, ()>> {
    let chars = |width: usize| -> Result<String, ()> {
        if !content.len().is_multiple_of(width) {
            return Err(());
        }
        content
            .chunks(width)
            .map(|c| char::from_u32(c.iter().fold(0u32, |acc, &b| (acc << 8) | b as u32)).ok_or(()))
            .collect()
    };
    Some(match tag {
        0x0c => String::from_utf8(content.to_vec()).map_err(|_| ()),
        // PrintableString, T61String, IA5String, VisibleString: one byte each.
        0x13 | 0x14 | 0x16 | 0x1a => chars(1),
        0x1e => chars(2), // BMPString
        0x1c => chars(4), // UniversalString
        _ => return None,
    })
}

/// `asn1_string_canon` on UTF-8 bytes.
fn canonical(text: &str) -> Vec<u8> {
    let space = |b: u8| matches!(b, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r');
    let bytes = text.as_bytes();
    let start = bytes.iter().position(|&b| !space(b)).unwrap_or(bytes.len());
    let end = bytes
        .iter()
        .rposition(|&b| !space(b))
        .map_or(start, |i| i + 1);
    let mut out = Vec::with_capacity(end - start);
    let mut i = start;
    while i < end {
        let b = bytes[i];
        if !b.is_ascii() {
            out.push(b);
            i += 1;
        } else if space(b) {
            out.push(b' ');
            while i < end && space(bytes[i]) {
                i += 1;
            }
        } else {
            out.push(b.to_ascii_lowercase());
            i += 1;
        }
    }
    out
}

/// The subject's canonical encoding (`x509_name_canon`).
fn canonical_name(subject: &[u8]) -> Option<Vec<u8>> {
    let mut out = vec![];
    let mut sets = subject;
    while !sets.is_empty() {
        let (tag, set, rest) = element(sets)?;
        sets = rest;
        if tag != 0x31 {
            return None;
        }
        let mut entries = vec![];
        let mut items = set;
        while !items.is_empty() {
            let (tag, entry, rest) = element(items)?;
            items = rest;
            if tag != 0x30 {
                return None;
            }
            let (oid_tag, _, after_oid) = element(entry)?;
            if oid_tag != 0x06 {
                return None;
            }
            let oid = &entry[..entry.len() - after_oid.len()];
            let (value_tag, value, end) = element(after_oid)?;
            if !end.is_empty() {
                return None;
            }
            let value = match utf8(value_tag, value) {
                Some(Ok(text)) => encode(0x0c, &canonical(&text)),
                Some(Err(())) => return None,
                None => after_oid.to_vec(),
            };
            entries.push(encode(0x30, &[oid, &value[..]].concat()));
        }
        entries.sort(); // DER's SET OF order
        out.extend(encode(0x31, &entries.concat()));
    }
    Some(out)
}

/// `X509_NAME_hash` of a certificate's subject, as `openssl x509 -hash`
/// prints it; None for DER this cannot read.
pub fn subject_hash(certificate: &[u8]) -> Option<String> {
    let (tag, cert, _) = element(certificate)?;
    let (tbs_tag, tbs, _) = element(cert)?;
    if tag != 0x30 || tbs_tag != 0x30 {
        return None;
    }
    let mut fields = tbs;
    if fields.first() == Some(&0xa0) {
        fields = element(fields)?.2; // the version
    }
    for _ in 0..4 {
        fields = element(fields)?.2; // serial, signature, issuer, validity
    }
    let (subject_tag, subject, _) = element(fields)?;
    if subject_tag != 0x30 {
        return None;
    }
    let digest = sha1_smol::Sha1::from(canonical_name(subject)?)
        .digest()
        .bytes();
    Some(format!(
        "{:08x}",
        u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]])
    ))
}

fn c(text: &str) -> io::Result<CString> {
    CString::new(text).map_err(io::Error::other)
}

fn is_hash_name(name: &str) -> bool {
    name.split_once('.').is_some_and(|(hash, n)| {
        hash.len() == 8
            && hash
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            && !n.is_empty()
            && n.bytes().all(|b| b.is_ascii_digit())
    })
}

/// In the certificate directory `dir` (opened for reading, resolved inside
/// the root): one `<hash>.N` link to `cube-runner.pem` when `hash` is
/// given, none when not; a link of cube's under another hash (the CA
/// before a rotation) goes. Another certificate's links are never touched.
pub fn put_hash_link(dir: &OwnedFd, hash: Option<&str>) -> io::Result<()> {
    let listing = fs::read_dir(format!("/proc/self/fd/{}", dir.as_raw_fd()))?;
    // cube's links: (hash, number, name), the lowest number first.
    let mut ours = vec![];
    for entry in listing {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !is_hash_name(&name) || !entry.file_type()?.is_symlink() {
            continue;
        }
        if link_target(dir, &c(&name)?).as_deref() != Some(TARGET.as_bytes()) {
            continue;
        }
        let (h, n) = name.split_once('.').unwrap();
        ours.push((
            h.to_string(),
            n.parse::<u64>().unwrap_or(u64::MAX),
            name.clone(),
        ));
    }
    ours.sort();
    let mut kept = false;
    for (h, _, name) in ours {
        if !kept && Some(h.as_str()) == hash {
            kept = true;
            continue;
        }
        if unsafe { libc::unlinkat(dir.as_raw_fd(), c(&name)?.as_ptr(), 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    let Some(hash) = hash.filter(|_| !kept) else {
        return Ok(());
    };
    let target = c(TARGET)?;
    for n in 0..1000 {
        let name = c(&format!("{hash}.{n}"))?;
        if unsafe { libc::symlinkat(target.as_ptr(), dir.as_raw_fd(), name.as_ptr()) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error);
        }
    }
    Err(io::Error::other(format!("no free {hash}.N")))
}

fn link_target(dir: &OwnedFd, name: &CStr) -> Option<Vec<u8>> {
    let mut target = vec![0u8; 4096];
    let n = unsafe {
        libc::readlinkat(
            dir.as_raw_fd(),
            name.as_ptr(),
            target.as_mut_ptr().cast(),
            target.len(),
        )
    };
    (n >= 0).then(|| target[..n as usize].to_vec())
}

#[cfg(test)]
mod tests;
