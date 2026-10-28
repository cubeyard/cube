//! The per-installation CA and the in-memory leaf cache.
//!
//! `ca.key` (PKCS#8 PEM, 0600) and `ca.pem` (0644) are created on first start
//! and never rotated by the gateway. The CA's subject is derived from its key,
//! so loading needs no X.509 parser: the issuer is rebuilt from the key and
//! the loaded certificate is checked to carry that key.
//!
//! A CA someone else keeps (berth's runner CA, loaded by berth under its own
//! rules) comes in through [`Ca::from_loaded`] (feature `loaded-ca`): the
//! leaves' issuer is read from that certificate, never rebuilt from this
//! module's own parameters, and a leaf is checked to chain to it first.
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
};
use time::OffsetDateTime;

const CA_YEARS: i64 = 10;
const LEAF_HOURS: i64 = 24;
/// Leaves are re-minted well before they expire.
const LEAF_REFRESH: time::Duration = time::Duration::hours(12);
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
    /// Each name's config and the wall-clock time its leaf was minted.
    cache: Mutex<HashMap<String, (Arc<ServerConfig>, OffsetDateTime)>>,
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
        Self::assemble(Issuer::new(ca_params(&key), key), ca_der, pem)
    }

    fn assemble(
        issuer: Issuer<'static, KeyPair>,
        ca_der: CertificateDer<'static>,
        pem: String,
    ) -> Result<Self> {
        Ok(Self {
            sha256: hex(&Sha256::digest(&ca_der)),
            issuer,
            ca_der,
            pem,
            leaf_key: KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256)?,
            serial: AtomicU64::new(0),
            cache: Mutex::new(HashMap::new()),
            provider: provider(),
        })
    }

    /// A CA its owner has loaded and checked already: its key (PKCS#8 PEM)
    /// and its certificate (PEM). The leaves' issuer name, key identifier
    /// and key usages are the certificate's, whatever parameters made it;
    /// a CA whose leaves would not verify against the certificate (a key
    /// that is not the certificate's, a name that does not match) is
    /// refused here rather than in the guest's TLS.
    #[cfg(feature = "loaded-ca")]
    pub fn from_loaded(key_pem: &str, cert_pem: &str) -> Result<Self> {
        let key = KeyPair::from_pem(key_pem).context("read the CA key")?;
        ensure!(
            key.algorithm() == &PKCS_ECDSA_P256_SHA256,
            "the CA key must be a P-256 key"
        );
        let ca_der = CertificateDer::from_pem_slice(cert_pem.as_bytes())
            .context("read the CA certificate")?;
        let issuer = Issuer::from_ca_cert_der(&ca_der, key).context("parse the CA certificate")?;
        let ca = Self::assemble(issuer, ca_der, cert_pem.to_string())?;
        ca.check_chain()
            .context("a leaf does not verify against the CA certificate")?;
        Ok(ca)
    }

    /// Mints a leaf and verifies it against the CA certificate alone.
    pub fn check_chain(&self) -> Result<()> {
        use rustls::{
            RootCertStore,
            client::{WebPkiServerVerifier, danger::ServerCertVerifier},
            pki_types::{ServerName, UnixTime},
        };
        const NAME: &str = "chain-check.cube.invalid";
        let mut roots = RootCertStore::empty();
        roots.add(self.ca_der.clone())?;
        WebPkiServerVerifier::builder_with_provider(Arc::new(roots), self.provider.clone())
            .build()?
            .verify_server_cert(
                &self.leaf(NAME)?,
                &[],
                &ServerName::try_from(NAME)?,
                &[],
                UnixTime::now(),
            )?;
        Ok(())
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
        self.leaf_at(name, OffsetDateTime::now_utc())
    }

    fn leaf_at(&self, name: &str, now: OffsetDateTime) -> Result<CertificateDer<'static>> {
        let mut params = CertificateParams::new(vec![name.to_string()])?;
        params.distinguished_name = DistinguishedName::new();
        params.distinguished_name.push(DnType::CommonName, name);
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
        self.server_config_at(name, OffsetDateTime::now_utc())
    }

    fn server_config_at(&self, name: &str, now: OffsetDateTime) -> Result<Arc<ServerConfig>> {
        let mut cache = self.cache.lock().unwrap();
        // The leaf's age is read on the clock that set its validity: a
        // monotonic clock stops while the host sleeps, the wall clock (and
        // the guest's) does not.
        if let Some((config, minted)) = cache.get(name)
            && *minted <= now
            && now - *minted < LEAF_REFRESH
        {
            return Ok(config.clone());
        }
        let leaf = self.leaf_at(name, now)?;
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
        cache.insert(name.to_string(), (config.clone(), now));
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

    /// A client whose clock reads `now`, as the guest's does.
    #[derive(Debug)]
    struct At(OffsetDateTime);
    impl rustls::time_provider::TimeProvider for At {
        fn current_time(&self) -> Option<UnixTime> {
            Some(UnixTime::since_unix_epoch(std::time::Duration::from_secs(
                self.0.unix_timestamp() as u64,
            )))
        }
    }

    /// Moves TLS records both ways until neither side has more to say.
    fn pump(
        client: &mut rustls::ClientConnection,
        server: &mut rustls::ServerConnection,
    ) -> Result<(), rustls::Error> {
        loop {
            let mut wire = Vec::new();
            while client.wants_write() {
                client.write_tls(&mut wire).unwrap();
            }
            let sent = !wire.is_empty();
            let mut rest = &wire[..];
            while !rest.is_empty() {
                server.read_tls(&mut rest).unwrap();
                server.process_new_packets()?;
            }
            wire.clear();
            while server.wants_write() {
                server.write_tls(&mut wire).unwrap();
            }
            let answered = !wire.is_empty();
            let mut rest = &wire[..];
            while !rest.is_empty() {
                client.read_tls(&mut rest).unwrap();
                client.process_new_packets()?;
            }
            if !sent && !answered {
                return Ok(());
            }
        }
    }

    /// A real handshake for `name` with `config`, by a client that trusts
    /// only the CA and verifies at `now`.
    fn connect(
        ca: &Ca,
        config: Arc<ServerConfig>,
        name: &str,
        now: OffsetDateTime,
    ) -> Result<(rustls::ClientConnection, rustls::ServerConnection), rustls::Error> {
        let mut roots = RootCertStore::empty();
        roots.add(ca.der().clone()).unwrap();
        let client = rustls::ClientConfig::builder_with_details(provider(), Arc::new(At(now)))
            .with_safe_default_protocol_versions()
            .unwrap()
            .with_root_certificates(roots)
            .with_no_client_auth();
        let mut client = rustls::ClientConnection::new(
            Arc::new(client),
            ServerName::try_from(name.to_string()).unwrap(),
        )
        .unwrap();
        let mut server = rustls::ServerConnection::new(config).unwrap();
        pump(&mut client, &mut server)?;
        assert!(!client.is_handshaking());
        Ok((client, server))
    }

    /// The leaf a guest at `now` is served for `name`, through the cache.
    fn served(ca: &Ca, name: &str, now: OffsetDateTime) -> Result<Vec<u8>, rustls::Error> {
        let config = ca.server_config_at(name, now).unwrap();
        let (client, _) = connect(ca, config, name, now)?;
        Ok(client.peer_certificates().unwrap()[0].to_vec())
    }

    fn expired(error: &rustls::Error) -> bool {
        matches!(
            error,
            rustls::Error::InvalidCertificate(
                rustls::CertificateError::Expired | rustls::CertificateError::ExpiredContext { .. }
            )
        )
    }

    fn start() -> (tempfile::TempDir, Ca, OffsetDateTime) {
        let dir = tempfile::tempdir().unwrap();
        let ca = Ca::load_or_create(dir.path()).unwrap();
        let now = OffsetDateTime::from_unix_timestamp(OffsetDateTime::now_utc().unix_timestamp())
            .unwrap();
        (dir, ca, now)
    }

    fn hours(h: i64) -> time::Duration {
        time::Duration::hours(h)
    }

    /// The incident's shape: a leaf minted, then the host asleep (its
    /// monotonic clock still) while the wall clock passes the leaf's end.
    #[test]
    fn a_leaf_is_renewed_by_the_wall_clock_across_a_host_sleep() {
        let (_dir, ca, t0) = start();
        let first = ca.server_config_at("github.com", t0).unwrap();
        let (mut open, mut open_server) = connect(&ca, first.clone(), "github.com", t0).unwrap();
        let later = t0 + hours(24) + time::Duration::minutes(40);

        // The first leaf is truly expired by then: the guest refuses it.
        let error = connect(&ca, first, "github.com", later).unwrap_err();
        assert!(expired(&error), "{error:?}");
        // A new connection gets a fresh leaf, with no restart.
        served(&ca, "github.com", later).unwrap();

        // A connection made before the renewal goes on working.
        use std::io::{Read, Write};
        open.writer().write_all(b"ping").unwrap();
        pump(&mut open, &mut open_server).unwrap();
        let mut got = [0; 4];
        open_server.reader().read_exact(&mut got).unwrap();
        assert_eq!(&got, b"ping");
    }

    #[test]
    fn leaves_are_cached_until_half_their_life_then_renewed_per_host() {
        let (_dir, ca, t0) = start();
        let skew = time::Duration::seconds(142);
        let github = served(&ca, "github.com", t0).unwrap();
        let api = served(&ca, "api.github.com", t0 + skew).unwrap();
        assert_eq!(served(&ca, "github.com", t0 + hours(1)).unwrap(), github);
        let edge = t0 + hours(12) - time::Duration::seconds(1);
        assert_eq!(served(&ca, "github.com", edge).unwrap(), github);
        assert_eq!(served(&ca, "api.github.com", edge).unwrap(), api);

        // Each host renews on its own leaf's age.
        let renewed = served(&ca, "github.com", t0 + hours(12)).unwrap();
        assert_ne!(renewed, github);
        assert_eq!(served(&ca, "api.github.com", t0 + hours(12)).unwrap(), api);
        assert_ne!(
            served(&ca, "api.github.com", t0 + hours(12) + skew).unwrap(),
            api
        );
        assert_eq!(
            served(&ca, "github.com", t0 + hours(12) + skew).unwrap(),
            renewed
        );
    }

    /// A wall clock stepped back past a leaf's start gets a new leaf, not
    /// one the guest would call not yet valid.
    #[test]
    fn a_clock_stepped_back_renews_the_leaf() {
        let (_dir, ca, t0) = start();
        let first = served(&ca, "github.com", t0).unwrap();
        assert_ne!(served(&ca, "github.com", t0 - hours(2)).unwrap(), first);
    }

    #[test]
    fn concurrent_handshakes_share_one_renewal() {
        let (_dir, ca, t0) = start();
        let first = ca.server_config_at("github.com", t0).unwrap();
        let later = t0 + hours(13);
        let barrier = std::sync::Barrier::new(16);
        let configs: Vec<_> = std::thread::scope(|scope| {
            let workers: Vec<_> = (0..16)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        ca.server_config_at("github.com", later).unwrap()
                    })
                })
                .collect();
            workers.into_iter().map(|w| w.join().unwrap()).collect()
        });
        assert!(!Arc::ptr_eq(&configs[0], &first));
        assert!(configs.iter().all(|c| Arc::ptr_eq(c, &configs[0])));
        connect(&ca, configs[0].clone(), "github.com", later).unwrap();
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
