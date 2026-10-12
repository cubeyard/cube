//! The runner's own CA (masterplan B4; B-2 decision 2): one per runner
//! directory, kept in `DIRECTORY/.berth/ca/`:
//!
//! ```text
//! .berth/ca/       0700, the runner's account
//!   ca.key         0600, PKCS#8 PEM (P-256): never logged, never sent
//!   ca.pem         0644, the certificate: Runner.ca_pem and MachineSetup.ca_pem
//! ```
//!
//! Made on the first start of `berth vm` in the directory and kept from then
//! on; the guests trust the certificate only (each `machine_setup` brings
//! it). A missing pair is made; half a pair, a key others can read or that
//! another account owns, a key that is not P-256, or a certificate that does
//! not carry the key is refused, and the runner does not start: it never
//! replaces a CA it cannot read on its own. Remove both files to have a new
//! one made (machines get the new certificate with their next setup). Only
//! the certificate is used until the runner's egress (masterplan B-4) signs
//! with the key; nothing intercepts traffic yet.
use std::{
    fs,
    io::Write,
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::Path,
};

use anyhow::{Context, Result, bail, ensure};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, IsCa, KeyPair, KeyUsagePurpose,
    PKCS_ECDSA_P256_SHA256,
};
use sha2::{Digest, Sha256};

const YEARS: i64 = 10;

pub struct RunnerCa {
    /// The certificate, PEM.
    pub pem: String,
    /// sha256 of the certificate's DER, for people (`describe`).
    pub sha256: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The CA's name and limits follow from its key alone.
fn params(key: &KeyPair) -> CertificateParams {
    let id = hex(&Sha256::digest(key.public_key_raw())[..6]);
    let mut name = DistinguishedName::new();
    name.push(DnType::OrganizationName, "cube");
    name.push(DnType::CommonName, format!("cube runner CA {id}"));
    let mut params = CertificateParams::default();
    params.distinguished_name = name;
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    params
}

/// Written under a temporary name, synced, then renamed.
fn write_new(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let temporary = path.with_extension("tmp");
    let _ = fs::remove_file(&temporary);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::set_permissions(&temporary, fs::Permissions::from_mode(mode))?;
    fs::rename(&temporary, path)?;
    Ok(())
}

impl RunnerCa {
    /// Loads `dir/ca.key` and `dir/ca.pem`, making both when neither exists.
    pub fn load_or_create(dir: &Path) -> Result<Self> {
        if !dir.exists() {
            fs::DirBuilder::new().mode(0o700).create(dir)?;
        }
        // SAFETY: geteuid has no preconditions.
        let me = unsafe { libc::geteuid() };
        let meta = fs::metadata(dir)?;
        ensure!(
            meta.uid() == me && meta.mode() & 0o077 == 0,
            "{} must be the runner account's and closed to group and others (0700)",
            dir.display()
        );
        let (key_path, pem_path) = (dir.join("ca.key"), dir.join("ca.pem"));
        match (key_path.exists(), pem_path.exists()) {
            (false, false) => {
                let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)?;
                let mut params = params(&key);
                let now = time::OffsetDateTime::now_utc();
                params.not_before = now - time::Duration::days(1);
                params.not_after = now + time::Duration::days(365 * YEARS);
                let certificate = params.self_signed(&key)?;
                // The certificate last: a crash in between leaves half a
                // pair, which is refused rather than guessed at.
                write_new(&key_path, key.serialize_pem().as_bytes(), 0o600)?;
                write_new(&pem_path, certificate.pem().as_bytes(), 0o644)?;
                let sync = fs::File::open(dir)?;
                sync.sync_all()?;
            }
            (true, true) => {}
            _ => bail!(
                "{} holds only one of ca.key and ca.pem; restore both, or remove both to have a new CA made",
                dir.display()
            ),
        }
        let meta = fs::symlink_metadata(&key_path)?;
        ensure!(
            meta.file_type().is_file() && meta.uid() == me && meta.mode() & 0o077 == 0,
            "{} must be a file of the runner account's, closed to group and others (0600)",
            key_path.display()
        );
        let key = KeyPair::from_pem(&fs::read_to_string(&key_path)?)
            .with_context(|| format!("{} is not a PEM key", key_path.display()))?;
        ensure!(
            key.algorithm() == &PKCS_ECDSA_P256_SHA256,
            "{} must be a P-256 key",
            key_path.display()
        );
        let pem = fs::read_to_string(&pem_path)?;
        let der = rustls::pki_types::CertificateDer::from_pem_slice(pem.as_bytes())
            .with_context(|| format!("{} is not a PEM certificate", pem_path.display()))?;
        let public = key.public_key_raw();
        ensure!(
            der.windows(public.len()).any(|w| w == public),
            "{} does not belong to {}",
            pem_path.display(),
            key_path.display()
        );
        Ok(Self {
            sha256: hex(&Sha256::digest(&der)),
            pem,
        })
    }
}

use rustls::pki_types::pem::PemObject as _;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ca_is_made_once_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let ca = dir.path().join("ca");
        let first = RunnerCa::load_or_create(&ca).unwrap();
        assert!(
            first.pem.starts_with("-----BEGIN CERTIFICATE-----"),
            "{}",
            first.pem
        );
        assert!(!first.pem.contains("PRIVATE KEY"));
        let mode = |name: &str| fs::metadata(ca.join(name)).unwrap().mode() & 0o777;
        assert_eq!(
            (mode(""), mode("ca.key"), mode("ca.pem")),
            (0o700, 0o600, 0o644)
        );
        let again = RunnerCa::load_or_create(&ca).unwrap();
        assert_eq!(
            (again.pem, again.sha256),
            (first.pem, first.sha256),
            "kept, not made again"
        );
    }

    #[test]
    fn a_damaged_or_open_ca_is_refused_and_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let ca = dir.path().join("ca");
        RunnerCa::load_or_create(&ca).unwrap();
        let key = fs::read(ca.join("ca.key")).unwrap();
        let pem = fs::read(ca.join("ca.pem")).unwrap();
        let refused = |what: &str| {
            let error = RunnerCa::load_or_create(&ca)
                .err()
                .unwrap_or_else(|| panic!("{what} was taken"));
            error.to_string()
        };

        fs::set_permissions(ca.join("ca.key"), fs::Permissions::from_mode(0o640)).unwrap();
        assert!(refused("a key the group reads").contains("0600"));
        fs::set_permissions(ca.join("ca.key"), fs::Permissions::from_mode(0o600)).unwrap();

        fs::set_permissions(&ca, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(refused("an open directory").contains("0700"));
        fs::set_permissions(&ca, fs::Permissions::from_mode(0o700)).unwrap();

        fs::write(ca.join("ca.key"), b"not a key").unwrap();
        assert!(refused("a damaged key").contains("not a PEM key"));
        assert_eq!(
            fs::read(ca.join("ca.key")).unwrap(),
            b"not a key",
            "never replaced"
        );
        fs::write(ca.join("ca.key"), &key).unwrap();

        let other = tempfile::tempdir().unwrap();
        let other_ca = other.path().join("ca");
        RunnerCa::load_or_create(&other_ca).unwrap();
        fs::copy(other_ca.join("ca.pem"), ca.join("ca.pem")).unwrap();
        assert!(refused("another CA's certificate").contains("does not belong"));
        fs::write(ca.join("ca.pem"), &pem).unwrap();

        fs::remove_file(ca.join("ca.pem")).unwrap();
        assert!(refused("half a pair").contains("only one of"));
        assert!(
            !ca.join("ca.pem").exists(),
            "not made again beside the old key"
        );
        fs::write(ca.join("ca.pem"), &pem).unwrap();
        RunnerCa::load_or_create(&ca).unwrap();
    }
}
