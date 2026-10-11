//! Small file helpers the journal shares with cube-guest's: atomic writes
//! (temporary file, fsync, rename, fsync of the directory) and JSON records.
use std::{
    fs,
    io::{self, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
};

use serde_json::Value;
use sha2::{Digest, Sha256};

pub fn fsync_dir(directory: &Path) -> io::Result<()> {
    fs::File::open(directory)?.sync_all()
}

/// Writes `data` to `target` so a reader sees the old file or the new one,
/// never a part, also after a crash.
pub fn write_atomic(target: &Path, data: &[u8], mode: u32) -> io::Result<()> {
    let temporary = target.with_file_name(format!(
        "{}.tmp-{}",
        target
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("file"),
        std::process::id()
    ));
    let result = (|| {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(mode)
            .open(&temporary)?;
        file.write_all(data)?;
        file.set_permissions(fs::Permissions::from_mode(mode))?;
        file.sync_all()?;
        fs::rename(&temporary, target)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    fsync_dir(target.parent().unwrap_or(Path::new(".")))
}

/// A JSON record with sorted keys, as cube-guest writes them.
pub fn write_json(target: &Path, value: &Value) -> io::Result<()> {
    write_atomic(target, value.to_string().as_bytes(), 0o600)
}

/// None when the file does not exist; an unreadable record is an error.
pub fn read_json(target: &Path) -> io::Result<Option<Value>> {
    match fs::read(target) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

pub fn sha256_file(target: &Path) -> io::Result<String> {
    use std::io::Read;
    let mut file = fs::File::open(target)?;
    let mut digest = Sha256::new();
    let mut buffer = vec![0; 1 << 20];
    loop {
        match file.read(&mut buffer)? {
            0 => return Ok(hex(&digest.finalize())),
            n => digest.update(&buffer[..n]),
        }
    }
}

/// sha256 of `value` as Python's `json.dumps(value, sort_keys=True,
/// separators=(",", ":"))` writes it (ASCII only, `\uXXXX` escapes), which
/// is how cube-guest compares the request a key was first used for.
pub fn canonical(value: &Value) -> String {
    // serde_json keeps object keys sorted (no preserve_order).
    let mut ascii = String::new();
    for character in value.to_string().chars() {
        if character.is_ascii() {
            ascii.push(character);
        } else {
            let mut units = [0u16; 2];
            for unit in character.encode_utf16(&mut units) {
                ascii.push_str(&format!("\\u{unit:04x}"));
            }
        }
    }
    hex(&Sha256::digest(ascii.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn canonical_matches_python() {
        // python3 -c 'import json,hashlib; print(hashlib.sha256(json.dumps(
        //   {"kind":"exec","command":"echo æ😀","cwd":".","timeoutMs":1000,"outputLimit":5},
        //   sort_keys=True, separators=(",",":")).encode()).hexdigest())'
        let request = json!({"kind": "exec", "command": "echo æ😀", "cwd": ".", "timeoutMs": 1000, "outputLimit": 5});
        assert_eq!(
            canonical(&request),
            "fa4553c9aa1ec7f82ec7d5b0754234c70a8988db9688d8dc46a07acf60a4cf4f"
        );
    }

    #[test]
    fn atomic_write_replaces_and_keeps_mode() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("a");
        write_atomic(&target, b"one", 0o600).unwrap();
        write_atomic(&target, b"two", 0o644).unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"two");
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o644
        );
        assert_eq!(
            fs::read_dir(dir.path()).unwrap().count(),
            1,
            "no temporary file left"
        );
    }
}
