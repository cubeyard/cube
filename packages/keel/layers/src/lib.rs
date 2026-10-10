//! keel's image layers on the runner side (keel plan, work package 3).
//!
//! An OCI layer becomes one read-only EROFS file, converted once and kept in
//! a cache by its uncompressed digest (`diff_id`); a machine sees its layers
//! as one virtual disk, a GPT whose partitions are the cached files, stitched
//! together by a VMDK descriptor so that no layer is copied:
//!
//! ```text
//! registry blob (tar, tar+gzip, tar+zstd)
//!   -> convert: decompress, check diff_id, mkfs.erofs --tar=f --aufs
//!   -> cache:   <dir>/sha256:<diff_id>.erofs, published by rename
//!   -> disk:    <machine>/layers.vmdk = head (MBR + GPT) + layer files
//!               (+ zero padding) + tail (backup GPT), all FLAT extents
//! ```
//!
//! Fetching images (index, manifest, anonymous tokens) and deciding when the
//! cache is evicted belong to the runner (`berth vm`); this crate only does
//! the work it is told to do.

pub mod cache;
pub mod convert;
pub mod disk;

use std::fmt;
use std::str::FromStr;

use anyhow::{Result, bail};

/// An OCI layer's uncompressed digest, `sha256:<64 lowercase hex>`, as in an
/// image configuration's `rootfs.diff_ids` and `runner.proto`'s `Layer`.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct DiffId([u8; 32]);

impl DiffId {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// The 64 hex digits without `sha256:`.
    pub fn hex(&self) -> String {
        hex(&self.0)
    }
}

impl FromStr for DiffId {
    type Err = anyhow::Error;

    fn from_str(text: &str) -> Result<Self> {
        let Some(digits) = text.strip_prefix("sha256:") else {
            bail!("not a sha256 digest: {text:?}");
        };
        if digits.len() != 64
            || !digits
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        {
            bail!("not a sha256 digest (64 lowercase hex digits): {text:?}");
        }
        let mut bytes = [0u8; 32];
        for (i, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&digits[2 * i..2 * i + 2], 16)?;
        }
        Ok(Self(bytes))
    }
}

impl fmt::Display for DiffId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "sha256:{}", self.hex())
    }
}

impl fmt::Debug for DiffId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diff_id_round_trips_and_rejects_other_forms() {
        let text = "sha256:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
        let id: DiffId = text.parse().unwrap();
        assert_eq!(id.to_string(), text);
        assert_eq!(id.as_bytes()[1], 0x11);
        for bad in [
            "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
            "sha512:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
            "sha256:00112233445566778899AABBCCDDEEFF00112233445566778899aabbccddeeff",
            "sha256:00112233445566778899aabbccddeeff00112233445566778899aabbccddeef",
            "sha256:../12233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
        ] {
            assert!(bad.parse::<DiffId>().is_err(), "{bad}");
        }
    }
}
