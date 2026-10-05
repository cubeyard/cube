//! Signed runner releases for self-update. The manifest is signed with the
//! same Ed25519 key as cubed's updates; the public key is installed beside
//! the updater and never fetched with the manifest.
use anyhow::{Context, Result, bail, ensure};
use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

/// DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw key follows.
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub url: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseManifest {
    pub schema: u32,
    pub product: String,
    /// cube-runner's software version.
    pub version: String,
    /// The cube release tag that built it.
    pub release: String,
    pub commit: String,
    pub platform: String,
    pub protocol_version: u32,
    pub artifact: Artifact,
}

/// The manifest platform this binary runs on.
pub fn host_platform() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("linux-x64-gnu"),
        ("macos", "aarch64") => Some("darwin-arm64"),
        _ => None,
    }
}

pub fn public_key_from_pem(pem: &str) -> Result<VerifyingKey> {
    let body: String = pem
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    let der = base64::engine::general_purpose::STANDARD
        .decode(body.trim())
        .context("public key is not base64 PEM")?;
    ensure!(
        der.len() == 44 && der[..12] == ED25519_SPKI_PREFIX,
        "public key is not an Ed25519 SubjectPublicKeyInfo"
    );
    let raw: [u8; 32] = der[12..].try_into().expect("checked length");
    Ok(VerifyingKey::from_bytes(&raw)?)
}

/// Verifies `manifest` against the base64 `signature` and checks that it
/// describes a cube-runner release for this platform.
pub fn verify(key_pem: &str, manifest: &[u8], signature: &str) -> Result<ReleaseManifest> {
    let key = public_key_from_pem(key_pem)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(signature.trim())
        .context("signature is not base64")?;
    let signature = Signature::from_slice(&bytes).context("signature has the wrong length")?;
    key.verify_strict(manifest, &signature)
        .context("manifest signature does not verify")?;
    let parsed: ReleaseManifest =
        serde_json::from_slice(manifest).context("manifest is not JSON")?;
    ensure!(parsed.schema == 1, "unsupported manifest schema");
    ensure!(
        parsed.product == "cube-runner",
        "manifest is not for cube-runner"
    );
    ensure!(
        Some(parsed.platform.as_str()) == host_platform(),
        "manifest is for {}, not this platform",
        parsed.platform
    );
    ensure!(
        parsed.protocol_version == crate::PROTOCOL_VERSION,
        "manifest is for runner protocol {}",
        parsed.protocol_version
    );
    let version_ok = parsed.version.split('.').count() == 3
        && parsed
            .version
            .split('.')
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    ensure!(version_ok, "manifest version is not x.y.z");
    if !parsed.artifact.url.starts_with("https://") {
        bail!("artifact url must be https");
    }
    ensure!(
        parsed.artifact.sha256.len() == 64
            && parsed
                .artifact
                .sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
        "artifact sha256 is not 64 lowercase hex"
    );
    ensure!(
        parsed.artifact.bytes > 0 && parsed.artifact.bytes <= 512 << 20,
        "artifact size out of range"
    );
    Ok(parsed)
}

/// Whether `candidate` (x.y.z) is newer than `current` (x.y.z).
pub fn newer(candidate: &str, current: &str) -> bool {
    let parse = |v: &str| -> Option<(u64, u64, u64)> {
        let mut it = v.split(['.', '-', '+']).map(|p| p.parse::<u64>().ok());
        Some((it.next()??, it.next()??, it.next()??))
    };
    matches!((parse(candidate), parse(current)), (Some(a), Some(b)) if a > b)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn pem(key: &VerifyingKey) -> String {
        let mut der = ED25519_SPKI_PREFIX.to_vec();
        der.extend_from_slice(key.as_bytes());
        format!(
            "-----BEGIN PUBLIC KEY-----\n{}\n-----END PUBLIC KEY-----\n",
            base64::engine::general_purpose::STANDARD.encode(der)
        )
    }

    fn manifest(platform: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "schema": 1, "product": "cube-runner", "version": "0.6.0", "release": "v0.3.2",
            "commit": "0".repeat(40), "platform": platform, "protocolVersion": 3,
            "artifact": {"url": "https://example.com/r.tar.gz", "sha256": "a".repeat(64), "bytes": 10}
        }))
        .unwrap()
    }

    #[test]
    fn verifies_only_signed_manifests_for_this_platform() {
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let key = pem(&signing.verifying_key());
        let Some(platform) = host_platform() else {
            return;
        };
        let good = manifest(platform);
        let sig = base64::engine::general_purpose::STANDARD.encode(signing.sign(&good).to_bytes());
        assert_eq!(verify(&key, &good, &sig).unwrap().version, "0.6.0");

        let mut tampered = good.clone();
        tampered[10] ^= 1;
        assert!(verify(&key, &tampered, &sig).is_err(), "tampered manifest");
        let other = pem(&SigningKey::from_bytes(&[8u8; 32]).verifying_key());
        assert!(verify(&other, &good, &sig).is_err(), "other key");
        let foreign = manifest("windows-x64");
        let foreign_sig =
            base64::engine::general_purpose::STANDARD.encode(signing.sign(&foreign).to_bytes());
        assert!(
            verify(&key, &foreign, &foreign_sig).is_err(),
            "other platform"
        );
    }

    #[test]
    fn compares_versions() {
        assert!(newer("0.6.0", "0.5.0"));
        assert!(newer("0.10.0", "0.9.9"));
        assert!(!newer("0.5.0", "0.5.0"));
        assert!(!newer("0.4.9", "0.5.0"));
    }
}
