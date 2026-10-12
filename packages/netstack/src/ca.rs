//! The per-installation CA and the in-memory leaf cache.
//!
//! `ca.key` (PKCS#8 PEM, 0600) and `ca.pem` (0644) are created on first start
//! and never rotated by the gateway. The CA's subject is derived from its key,
//! so loading needs no X.509 parser: the issuer is rebuilt from the key and
//! the loaded certificate is checked to carry that key.
use anyhow::{Context, Result, bail, ensure};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa,
    Issuer, KeyPair, KeyUsagePurpose, PKCS_ECDSA_P256_SHA256, SerialNumber,
};
use rustls::{
    ServerConfig,
    crypto::CryptoProvider,
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, pem::PemObject},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use time::OffsetDateTime;

const CA_YEARS: i64 = 10;
const LEAF_HOURS: i64 = 24;
/// Leaves are re-minted well before they expire.
const LEAF_REFRESH: Duration = Duration::from_secs(12 * 3600);
const LEAF_CACHE: usize = 4096;

pub fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

pub struct Ca {
    issuer: Issuer<'static, KeyPair>,
    ca_der: CertificateDer<'static>,
    pem: String,
    sha256: String,
    leaf_key: KeyPair,
    serial: AtomicU64,
    cache: Mutex<HashMap<String, (Arc<ServerConfig>, Instant)>>,
    provider: Arc<CryptoProvider>,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The CA's parameters are a pure function of its key.
fn ca_params(key: &KeyPair) -> CertificateParams {
    let id = hex(&Sha256::digest(key.public_key_raw())[..6]);
    let mut dn = DistinguishedName::new();
    dn.push(DnType::OrganizationName, "cube");
    dn.push(DnType::CommonName, format!("cube installation CA {id}"));
    let mut params = CertificateParams::default();
    params.distinguished_name = dn;
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    params.key_usages = vec![
        KeyUsagePurpose::KeyCertSign,
        KeyUsagePurpose::CrlSign,
        KeyUsagePurpose::DigitalSignature,
    ];
    params
}

fn write_new(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let tmp = path.with_extension("tmp");
    let _ = fs::remove_file(&tmp);
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&tmp)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::set_permissions(&tmp, fs::Permissions::from_mode(mode))?;
    fs::rename(&tmp, path)?;
    Ok(())
}

impl Ca {
    /// Loads `dir/ca.key` and `dir/ca.pem`, creating both when neither exists.
    pub fn load_or_create(dir: &Path) -> Result<Self> {
        let (key_path, pem_path) = (dir.join("ca.key"), dir.join("ca.pem"));
        match (key_path.exists(), pem_path.exists()) {
            (false, false) => {
                let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)?;
                let mut params = ca_params(&key);
                let now = OffsetDateTime::now_utc();
                params.not_before = now - time::Duration::days(1);
                params.not_after = now + time::Duration::days(365 * CA_YEARS);
                let cert = params.self_signed(&key)?;
                write_new(&key_path, key.serialize_pem().as_bytes(), 0o600)?;
                write_new(&pem_path, cert.pem().as_bytes(), 0o644)?;
            }
            (true, true) => {}
            _ => bail!(
                "{} holds only one of ca.key and ca.pem; restore both or remove both to create a new CA",
                dir.display()
            ),
        }
        let mode = fs::metadata(&key_path)?.permissions().mode();
        ensure!(
            mode & 0o077 == 0,
            "{} must not be accessible by group or others",
            key_path.display()
        );
        let key = KeyPair::from_pem(&fs::read_to_string(&key_path)?).context("read ca.key")?;
        ensure!(
            key.algorithm() == &PKCS_ECDSA_P256_SHA256,
            "ca.key must be a P-256 key"
        );
        let pem = fs::read_to_string(&pem_path)?;
        let ca_der = CertificateDer::from_pem_slice(pem.as_bytes()).context("read ca.pem")?;
        ensure!(
            ca_der
                .windows(key.public_key_raw().len())
                .any(|w| w == key.public_key_raw()),
            "ca.pem does not belong to ca.key"
        );
        let sha256 = hex(&Sha256::digest(&ca_der));
        Ok(Self {
            issuer: Issuer::new(ca_params(&key), key),
            ca_der,
            pem,
            sha256,
            leaf_key: KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)?,
            serial: AtomicU64::new(0),
            cache: Mutex::new(HashMap::new()),
            provider: provider(),
        })
    }

    pub fn pem(&self) -> &str {
        &self.pem
    }
    /// SHA-256 of the CA certificate's DER, lowercase hex.
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
    pub fn der(&self) -> &CertificateDer<'static> {
        &self.ca_der
    }

    /// A leaf for `name` (a DNS name), signed by the CA, valid 24 hours.
    pub fn leaf(&self, name: &str) -> Result<CertificateDer<'static>> {
        let mut params = CertificateParams::new(vec![name.to_string()])?;
        params.distinguished_name = DistinguishedName::new();
        params.distinguished_name.push(DnType::CommonName, name);
        let now = OffsetDateTime::now_utc();
        params.not_before = now - time::Duration::hours(1);
        params.not_after = now + time::Duration::hours(LEAF_HOURS);
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
        params.use_authority_key_identifier_extension = true;
        // Every leaf shares one key, so serials must not be derived from it.
        let mut serial = Sha256::new();
        serial.update(name.as_bytes());
        serial.update(now.unix_timestamp_nanos().to_be_bytes());
        serial.update(self.serial.fetch_add(1, Ordering::Relaxed).to_be_bytes());
        let mut serial = serial.finalize()[..16].to_vec();
        serial[0] &= 0x7f;
        params.serial_number = Some(SerialNumber::from_slice(&serial));
        Ok(params
            .signed_by(&self.leaf_key, &self.issuer)?
            .der()
            .clone())
    }

    /// TLS server configuration for one SNI name, offering only `http/1.1`.
    pub fn server_config(&self, name: &str) -> Result<Arc<ServerConfig>> {
        let mut cache = self.cache.lock().unwrap();
        if let Some((config, minted)) = cache.get(name)
            && minted.elapsed() < LEAF_REFRESH
        {
            return Ok(config.clone());
        }
        let leaf = self.leaf(name)?;
        let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(self.leaf_key.serialize_der()));
        let mut config = ServerConfig::builder_with_provider(self.provider.clone())
            .with_safe_default_protocol_versions()?
            .with_no_client_auth()
            .with_single_cert(vec![leaf, self.ca_der.clone()], key)?;
        config.alpn_protocols = vec![b"http/1.1".to_vec()];
        let config = Arc::new(config);
        if cache.len() >= LEAF_CACHE {
            cache.clear();
        }
        cache.insert(name.to_string(), (config.clone(), Instant::now()));
        Ok(config)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustls::{
        RootCertStore,
        client::{WebPkiServerVerifier, danger::ServerCertVerifier},
        pki_types::{ServerName, UnixTime},
    };

    #[test]
    fn ca_files_are_created_once_and_leaves_verify() {
        let dir = tempfile::tempdir().unwrap();
        let ca = Ca::load_or_create(dir.path()).unwrap();
        let key_mode = fs::metadata(dir.path().join("ca.key"))
            .unwrap()
            .permissions()
            .mode();
        let pem_mode = fs::metadata(dir.path().join("ca.pem"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(key_mode & 0o777, 0o600);
        assert_eq!(pem_mode & 0o777, 0o644);
        let key_before = fs::read(dir.path().join("ca.key")).unwrap();
        let pem_before = fs::read(dir.path().join("ca.pem")).unwrap();

        // A restart loads the same CA and leaves still chain to the stored ca.pem.
        let again = Ca::load_or_create(dir.path()).unwrap();
        assert_eq!(again.sha256(), ca.sha256());
        assert_eq!(fs::read(dir.path().join("ca.key")).unwrap(), key_before);
        assert_eq!(fs::read(dir.path().join("ca.pem")).unwrap(), pem_before);

        let mut roots = RootCertStore::empty();
        roots
            .add(CertificateDer::from_pem_slice(&pem_before).unwrap())
            .unwrap();
        let verifier = WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider())
            .build()
            .unwrap();
        let leaf = again.leaf("api.github.com").unwrap();
        verifier
            .verify_server_cert(
                &leaf,
                &[],
                &ServerName::try_from("api.github.com").unwrap(),
                &[],
                UnixTime::now(),
            )
            .unwrap();
        assert!(
            verifier
                .verify_server_cert(
                    &leaf,
                    &[],
                    &ServerName::try_from("github.com").unwrap(),
                    &[],
                    UnixTime::now(),
                )
                .is_err()
        );
        // Distinct serials for leaves sharing one key.
        assert_ne!(again.leaf("a.test").unwrap(), again.leaf("a.test").unwrap());
        let config = again.server_config("api.github.com").unwrap();
        assert_eq!(config.alpn_protocols, vec![b"http/1.1".to_vec()]);
        assert!(Arc::ptr_eq(
            &config,
            &again.server_config("api.github.com").unwrap()
        ));
    }

    #[test]
    fn half_a_ca_or_an_open_key_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        Ca::load_or_create(dir.path()).unwrap();
        fs::set_permissions(dir.path().join("ca.key"), fs::Permissions::from_mode(0o644)).unwrap();
        assert!(Ca::load_or_create(dir.path()).is_err());
        fs::remove_file(dir.path().join("ca.pem")).unwrap();
        fs::set_permissions(dir.path().join("ca.key"), fs::Permissions::from_mode(0o600)).unwrap();
        assert!(Ca::load_or_create(dir.path()).is_err());
        assert!(!dir.path().join("ca.pem").exists());
    }
}
