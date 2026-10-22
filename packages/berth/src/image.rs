//! Image fetching for `berth vm` (masterplan row B-7): a public OCI image,
//! pinned by digest, resolved for this runner's platform, every blob checked
//! against its digest and size before it is used, and each layer converted
//! once into keel-layers' cache. `berth vm` pulls its `--image` this way
//! when it starts, before it listens, unless the record and every layer file
//! are there ([`Store::cached`]); `berth image pull` does the same by hand.
//!
//! ```text
//! DIRECTORY/layers/1/sha256:<diff_id>.erofs   keel_layers::cache, layer format 1
//! DIRECTORY/images/sha256:<digest>.json       what a pull resolved (ImageRecord)
//! DIRECTORY/images/.tmp-*                     a blob being fetched, never kept
//! ```
//!
//! Public registries only (masterplan U4): an anonymous bearer token when the
//! registry asks for one, never a stored credential. HTTPS only, also across
//! redirects; reqwest drops `Authorization` when a redirect leaves the host
//! (blob downloads go to a CDN), so the token stays with the registry.
//!
//! Nothing half-done is ever usable: a blob is written under a temporary
//! name and must match its descriptor's size and digest before conversion
//! reads it; the layer is published by keel-layers only after its tar
//! matched the `diff_id` and `mkfs.erofs` succeeded; the record is written
//! last, by rename. A pull that fails leaves the layers it finished (each
//! complete and verified), so the next pull starts where it stopped.
//!
//! Before each blob the disk must have 3 × the blob's size + 2 GiB free
//! (masterplan B-7 D2); otherwise the pull stops and publishes nothing more.

use std::{
    fs::{self, File, OpenOptions},
    io::Write as _,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail, ensure};
use keel_layers::{
    DiffId,
    cache::LayerCache,
    convert::{self, Compression, Mkfs, TarMode, TimeLimits},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};

/// What `mkfs.erofs` is asked for (`--tar=f -b4096 -zlz4hc -T0 --aufs` and a
/// UUID from the `diff_id`, keel-layers' `TarMode::Full`). A change to the
/// arguments takes a new number, and so a new cache directory, so one cache
/// never mixes two formats under the same name (masterplan H2).
pub const LAYER_FORMAT: u32 = 1;
const RECORD_VERSION: u32 = 1;
/// Manifests, indexes and image configurations; containerd's limit.
const MAX_DOCUMENT_BYTES: u64 = 4 << 20;
/// One compressed layer blob, as its descriptor states it.
const MAX_BLOB_BYTES: u64 = 16 << 30;
/// One layer's uncompressed tar (masterplan H5).
const MAX_TAR_BYTES: u64 = 32 << 30;
/// The layer disk has 128 partitions; one is kept for a template (B-8).
const MAX_LAYERS: usize = 127;
const MAX_TOKEN_BYTES: u64 = 64 << 10;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Between two reads of one response, not for the whole of it.
const READ_TIMEOUT: Duration = Duration::from_secs(60);
/// A whole document, configuration or token answer (at most 4 MiB), so a
/// registry that sends a byte now and then cannot hold a pull forever.
const DOCUMENT_DEADLINE: Duration = Duration::from_secs(120);
/// How often a wait on the network looks at the cancel flag.
const CANCEL_POLL: Duration = Duration::from_millis(50);
/// Free space before a blob: `FREE_FACTOR` × its size + `FREE_RESERVE`
/// (masterplan B-7 D2): the blob, the layer it becomes, and room left for
/// the machines' disks.
const FREE_FACTOR: u64 = 3;
const FREE_RESERVE: u64 = 2 << 30;

/// mkfs.erofs's time for a pull `berth vm` starts itself (masterplan B-7
/// D3): 60 s + 60 s per GiB of tar after its input ends, instead of
/// keel-layers' 120 s + 240 s for one run by hand. Any erofs-utils is
/// accepted; this bounds what a crafted layer can cost on one before 1.9.1.
/// A write into mkfs.erofs may still block 300 s, as by hand.
pub const RUNNER_TIME_LIMITS: TimeLimits = TimeLimits {
    stall: Duration::from_secs(300),
    finish: Duration::from_secs(60),
    finish_per_gib: Duration::from_secs(60),
};

const INDEX_TYPES: [&str; 2] = [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
];
const MANIFEST_TYPES: [&str; 2] = [
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
];
const CONFIG_TYPES: [&str; 2] = [
    "application/vnd.oci.image.config.v1+json",
    "application/vnd.docker.container.image.v1+json",
];

/// A content digest, `sha256:<64 lowercase hex>`: the same form as a
/// `diff_id`, so the same type.
pub type Digest = DiffId;

/// An image named as `REGISTRY/REPOSITORY@sha256:<hex>`, optionally with a
/// `:tag` before the `@` that is only a label: the digest decides. A
/// reference without a digest, or without a registry host, is refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reference {
    /// As written (`docker.io`, `ghcr.io`, `localhost:5000`).
    pub registry: String,
    pub repository: String,
    pub digest: Digest,
}

impl Reference {
    pub fn parse(text: &str) -> Result<Self> {
        let (name, digest) = text.split_once('@').with_context(|| {
            format!("{text:?} is not pinned: name the image as REGISTRY/REPOSITORY@sha256:<digest>")
        })?;
        let digest: Digest = digest
            .parse()
            .with_context(|| format!("{text:?}: the digest"))?;
        let (registry, path) = name
            .split_once('/')
            .with_context(|| format!("{text:?} names no registry"))?;
        ensure!(
            registry.contains('.') || registry.contains(':') || registry == "localhost",
            "{text:?} names no registry host (docker.io/library/debian, ghcr.io/owner/name)"
        );
        ensure!(
            registry
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".-:".contains(&b)),
            "{text:?}: not a registry host: {registry:?}"
        );
        // A tag is the part after the last `:` of the last path component.
        let last = path.rsplit('/').next().unwrap_or_default();
        let repository = match last.rsplit_once(':') {
            Some((_, tag)) => {
                ensure!(valid_tag(tag), "{text:?}: not a tag: {tag:?}");
                &path[..path.len() - tag.len() - 1]
            }
            None => path,
        };
        ensure!(
            repository.split('/').all(valid_path_component),
            "{text:?}: not a repository name: {repository:?}"
        );
        let repository = if registry == "docker.io" && !repository.contains('/') {
            format!("library/{repository}")
        } else {
            repository.to_owned()
        };
        Ok(Self {
            registry: registry.to_owned(),
            repository,
            digest,
        })
    }

    /// Docker Hub's registry API is not at the name it is known by.
    fn api_host(&self) -> &str {
        if self.registry == "docker.io" {
            "registry-1.docker.io"
        } else {
            &self.registry
        }
    }
}

impl std::fmt::Display for Reference {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}@{}", self.registry, self.repository, self.digest)
    }
}

/// The OCI distribution spec's path component:
/// `[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*`.
fn valid_path_component(component: &str) -> bool {
    let bytes = component.as_bytes();
    let alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    if bytes.is_empty() || !alnum(bytes[0]) || !alnum(bytes[bytes.len() - 1]) {
        return false;
    }
    let mut i = 0;
    while i < bytes.len() {
        if alnum(bytes[i]) {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && !alnum(bytes[i]) {
            i += 1;
        }
        let separator = &component[start..i];
        if !(separator == "."
            || separator == "_"
            || separator == "__"
            || separator.bytes().all(|b| b == b'-'))
        {
            return false;
        }
    }
    true
}

/// `[A-Za-z0-9_][A-Za-z0-9._-]{0,127}`.
fn valid_tag(tag: &str) -> bool {
    let bytes = tag.as_bytes();
    (1..=128).contains(&bytes.len())
        && (bytes[0].is_ascii_alphanumeric() || bytes[0] == b'_')
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(b))
}

/// `linux/amd64` or `linux/arm64`: what the runner's guests run.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Platform {
    pub os: &'static str,
    pub architecture: &'static str,
}

impl Platform {
    pub fn native() -> Result<Self> {
        Ok(Self {
            os: "linux",
            architecture: match std::env::consts::ARCH {
                "x86_64" => "amd64",
                "aarch64" => "arm64",
                other => bail!("no keel guests on {other}"),
            },
        })
    }

    /// An index entry or configuration for this platform. arm64 images name
    /// the variant `v8` or nothing; an amd64 variant (`v2`, `v3`) is a
    /// microarchitecture level the guest's CPU may lack, so only none.
    fn matches(&self, os: &str, architecture: &str, variant: Option<&str>) -> bool {
        os == self.os
            && architecture == self.architecture
            && matches!(
                (self.architecture, variant),
                (_, None | Some("")) | ("arm64", Some("v8"))
            )
    }
}

impl std::fmt::Display for Platform {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}/{}", self.os, self.architecture)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Descriptor {
    pub media_type: String,
    pub digest: String,
    pub size: u64,
}

#[derive(Deserialize)]
struct WirePlatform {
    os: String,
    architecture: String,
    variant: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireIndexEntry {
    media_type: String,
    digest: String,
    size: u64,
    platform: Option<WirePlatform>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireDocument {
    media_type: Option<String>,
    manifests: Option<Vec<WireIndexEntry>>,
    config: Option<Descriptor>,
    layers: Option<Vec<WireLayer>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WireLayer {
    media_type: String,
    digest: String,
    size: u64,
    /// Foreign layers live somewhere else than the registry.
    urls: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct WireConfig {
    os: String,
    architecture: String,
    variant: Option<String>,
    rootfs: WireRootfs,
    config: Option<WireRuntime>,
}

#[derive(Deserialize)]
struct WireRootfs {
    #[serde(rename = "type")]
    kind: String,
    diff_ids: Vec<String>,
}

#[derive(Deserialize)]
struct WireRuntime {
    #[serde(rename = "Env")]
    env: Option<Vec<String>>,
}

/// What a pull resolved and where its layers are: the provenance of every
/// cached layer file this image uses, and what B-7 needs for
/// `MachineSetup.layers` and `.image` (digest and `Env`).
#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageRecord {
    pub version: u32,
    pub reference: String,
    pub registry: String,
    pub repository: String,
    /// What the reference pins: an index or a manifest.
    pub digest: String,
    pub platform: String,
    /// This platform's manifest; `ImageConfig.digest` in `MachineSetup`.
    pub manifest: Descriptor,
    pub config: Descriptor,
    pub env: Vec<String>,
    /// Bottom layer first, as in the manifest (`MachineSetup.layers` is
    /// topmost first).
    pub layers: Vec<LayerRecord>,
    pub layer_format: u32,
    /// The `mkfs.erofs` given by path and what it says it is.
    pub mkfs: String,
    pub mkfs_version: String,
    /// Seconds since the Unix epoch.
    pub resolved_at: u64,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayerRecord {
    pub diff_id: String,
    pub blob: Descriptor,
    /// The cached EROFS file, relative to the runner directory.
    pub file: String,
    pub erofs_bytes: u64,
    /// Set when this pull converted the layer; absent when it was cached.
    pub tar_bytes: Option<u64>,
}

/// Where a pull keeps things in a runner directory.
pub struct Store {
    directory: PathBuf,
    cache: LayerCache,
}

impl Store {
    /// The caller holds the runner directory's lock, so no other pull or
    /// runner works here: leftovers of a crashed pull can go.
    pub fn open(directory: &Path) -> Result<Self> {
        let cache = LayerCache::open(layer_dir(directory))?;
        cache.remove_temporary()?;
        let images = directory.join("images");
        fs::create_dir_all(&images)?;
        for item in fs::read_dir(&images)? {
            let item = item?;
            if item.file_name().to_string_lossy().starts_with(".tmp-") {
                // A directory is a Debian preparation's (debian.rs).
                if item.file_type()?.is_dir() {
                    fs::remove_dir_all(item.path())?;
                } else {
                    fs::remove_file(item.path())?;
                }
            }
        }
        Ok(Self {
            directory: directory.to_owned(),
            cache,
        })
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    fn images(&self) -> PathBuf {
        self.directory.join("images")
    }

    pub fn record_path(&self, digest: &Digest) -> PathBuf {
        self.images().join(format!("{digest}.json"))
    }

    /// The image's record if it and every layer file it names are here for
    /// `platform` (each layer is marked used); otherwise why not, and the
    /// image is pulled again. A layer the cache lost is fetched again by the
    /// pull, which looks each one up (#162's F7).
    pub fn cached(
        &self,
        reference: &Reference,
        platform: Platform,
    ) -> Result<std::result::Result<ImageRecord, String>> {
        let path = self.record_path(&reference.digest);
        let text = match fs::read(&path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(Err(format!("no record of {reference}")));
            }
            Err(e) => return Err(e).with_context(|| format!("read {}", path.display())),
        };
        let record: ImageRecord = match serde_json::from_slice(&text) {
            Ok(record) => record,
            Err(e) => {
                return Ok(Err(format!(
                    "{} is not an image record: {e}",
                    path.display()
                )));
            }
        };
        if record.platform != platform.to_string()
            || record.digest != reference.digest.to_string()
            || record.layer_format != LAYER_FORMAT
        {
            return Ok(Err(format!(
                "{} is for {} {} in layer format {}",
                path.display(),
                record.platform,
                record.digest,
                record.layer_format
            )));
        }
        for layer in &record.layers {
            let Ok(diff_id) = layer.diff_id.parse::<DiffId>() else {
                return Ok(Err(format!(
                    "{}: diff_id {:?}",
                    path.display(),
                    layer.diff_id
                )));
            };
            if self.directory.join(&layer.file) != self.cache.path(&diff_id) {
                return Ok(Err(format!(
                    "{}: layer {diff_id} is named as {:?}, not in the cache",
                    path.display(),
                    layer.file
                )));
            }
            if self.cache.get(&diff_id)?.is_none() {
                return Ok(Err(format!(
                    "layer {diff_id} of {reference} is not in the cache"
                )));
            }
        }
        Ok(Ok(record))
    }
}

/// Bytes an unprivileged process may still write on the file system that
/// holds `path`.
pub fn free_bytes(path: &Path) -> std::io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let name = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    // statfs, not statvfs, on macOS: Darwin's statvfs has 32-bit block
    // counts, which a large disk overflows.
    #[cfg(target_os = "macos")]
    {
        // SAFETY: plain data, filled in by statfs.
        let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
        // SAFETY: a NUL-terminated path and a struct of the right type.
        if unsafe { libc::statfs(name.as_ptr(), &mut stat) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(stat.f_bavail.saturating_mul(u64::from(stat.f_bsize)))
    }
    #[cfg(not(target_os = "macos"))]
    {
        // SAFETY: plain data, filled in by statvfs.
        let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
        // SAFETY: a NUL-terminated path and a struct of the right type.
        if unsafe { libc::statvfs(name.as_ptr(), &mut stat) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        #[allow(clippy::unnecessary_cast)]
        Ok((stat.f_bavail as u64).saturating_mul(stat.f_frsize as u64))
    }
}

/// What a blob of `blob_bytes` needs free before it is fetched.
pub fn free_needed(blob_bytes: u64) -> u64 {
    blob_bytes
        .saturating_mul(FREE_FACTOR)
        .saturating_add(FREE_RESERVE)
}

pub fn layer_dir(directory: &Path) -> PathBuf {
    directory.join("layers").join(LAYER_FORMAT.to_string())
}

/// What `mkfs.erofs --version` says: `mkfs.erofs (erofs-utils) 1.8.6`; 1.7.1
/// does not know the option but prints `mkfs.erofs 1.7.1` before refusing it.
pub fn mkfs_version(mkfs: &Path) -> Result<String> {
    let output = std::process::Command::new(mkfs)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .output()
        .with_context(|| format!("run {} --version", mkfs.display()))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text.lines().next().unwrap_or_default().trim();
    ensure!(
        line.starts_with("mkfs.erofs "),
        "{} --version does not say it is mkfs.erofs",
        mkfs.display()
    );
    Ok(line.chars().take(200).collect())
}

/// A registry's API for one repository, with the anonymous token it handed
/// out, if it asked for one.
struct Registry {
    client: reqwest::Client,
    base: String,
    repository: String,
    token: Option<String>,
    cancel: Arc<AtomicBool>,
}

pub(crate) fn client(https_only: bool) -> Result<reqwest::Client> {
    // berth links ring for Iroh; reqwest is built without a provider of its
    // own. Installing it twice is harmless.
    let _ = rustls::crypto::ring::default_provider().install_default();
    Ok(reqwest::Client::builder()
        .https_only(https_only)
        .connect_timeout(CONNECT_TIMEOUT)
        .read_timeout(READ_TIMEOUT)
        .user_agent(concat!("berth/", env!("CARGO_PKG_VERSION")))
        .build()?)
}

/// Pulls in the order of the bearer challenge: `realm`, `service`, `scope`.
fn challenge_field<'a>(challenge: &'a str, name: &str) -> Option<&'a str> {
    let start = challenge.find(&format!("{name}=\""))? + name.len() + 2;
    let end = challenge[start..].find('"')? + start;
    Some(&challenge[start..end])
}

impl Registry {
    fn new(
        client: reqwest::Client,
        base: String,
        repository: String,
        cancel: Arc<AtomicBool>,
    ) -> Self {
        Self {
            client,
            base,
            repository,
            token: None,
            cancel,
        }
    }

    async fn get(&mut self, path: &str, accept: &[&str]) -> Result<reqwest::Response> {
        let url = format!("{}/v2/{}/{path}", self.base, self.repository);
        for attempt in 0..2 {
            let mut request = self.client.get(&url);
            if !accept.is_empty() {
                request = request.header(reqwest::header::ACCEPT, accept.join(", "));
            }
            if let Some(token) = &self.token {
                request = request.bearer_auth(token);
            }
            let response = unless_cancelled(&self.cancel, request.send())
                .await?
                .with_context(|| format!("GET {url}"))?;
            if response.status() == reqwest::StatusCode::UNAUTHORIZED {
                ensure!(
                    attempt == 0,
                    "GET {url}: HTTP 401 with an anonymous token: the image is not public (only public images are supported)"
                );
                let challenge = response
                    .headers()
                    .get(reqwest::header::WWW_AUTHENTICATE)
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default()
                    .to_owned();
                self.token = Some(self.anonymous_token(&url, &challenge).await?);
                continue;
            }
            ensure!(
                response.status().is_success(),
                "GET {url}: HTTP {}",
                response.status()
            );
            return Ok(response);
        }
        unreachable!("the second attempt returns or fails")
    }

    /// The token a public registry gives anyone for `pull` (Docker's token
    /// protocol). The token is never logged or written anywhere.
    async fn anonymous_token(&self, url: &str, challenge: &str) -> Result<String> {
        ensure!(
            challenge.len() >= 7 && challenge[..7].eq_ignore_ascii_case("bearer "),
            "GET {url}: HTTP 401 without a bearer challenge"
        );
        let realm = challenge_field(challenge, "realm")
            .with_context(|| format!("GET {url}: bearer challenge without realm"))?;
        let mut token_url = reqwest::Url::parse(realm)
            .with_context(|| format!("GET {url}: bearer realm {realm:?}"))?;
        token_url
            .query_pairs_mut()
            .append_pair("scope", &format!("repository:{}:pull", self.repository));
        if let Some(service) = challenge_field(challenge, "service") {
            token_url.query_pairs_mut().append_pair("service", service);
        }
        let response = unless_cancelled(&self.cancel, self.client.get(token_url).send())
            .await?
            .with_context(|| format!("anonymous token from {realm}"))?;
        ensure!(
            response.status().is_success(),
            "anonymous token from {realm}: HTTP {}",
            response.status()
        );
        #[derive(Deserialize)]
        struct Answer {
            token: Option<String>,
            access_token: Option<String>,
        }
        let body = read_bounded(
            response,
            MAX_TOKEN_BYTES,
            "the token answer",
            &self.cancel,
            DOCUMENT_DEADLINE,
        )
        .await?;
        let answer: Answer =
            serde_json::from_slice(&body).context("the token answer is not JSON")?;
        answer
            .token
            .or(answer.access_token)
            .filter(|token| !token.is_empty())
            .with_context(|| format!("{realm} gave no token"))
    }

    /// A manifest or index by digest: at most 4 MiB, and its bytes must hash
    /// to the digest.
    async fn document(&mut self, digest: &Digest, accept: &[&str]) -> Result<(Vec<u8>, String)> {
        let response = self.get(&format!("manifests/{digest}"), accept).await?;
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .split(';')
            .next()
            .unwrap_or_default()
            .trim()
            .to_owned();
        let body = read_bounded(
            response,
            MAX_DOCUMENT_BYTES,
            &digest.to_string(),
            &self.cancel,
            DOCUMENT_DEADLINE,
        )
        .await?;
        check_digest(&body, digest)?;
        Ok((body, content_type))
    }

    /// A small blob (the configuration) in memory, checked.
    async fn small_blob(&mut self, descriptor: &Descriptor) -> Result<Vec<u8>> {
        let digest: Digest = descriptor.digest.parse()?;
        ensure!(
            descriptor.size <= MAX_DOCUMENT_BYTES,
            "{digest} is {} bytes, more than {MAX_DOCUMENT_BYTES}",
            descriptor.size
        );
        let response = self.get(&format!("blobs/{digest}"), &[]).await?;
        let body = read_bounded(
            response,
            descriptor.size,
            &digest.to_string(),
            &self.cancel,
            DOCUMENT_DEADLINE,
        )
        .await?;
        ensure!(
            body.len() as u64 == descriptor.size,
            "{digest}: {} bytes, the descriptor says {}",
            body.len(),
            descriptor.size
        );
        check_digest(&body, &digest)?;
        Ok(body)
    }

    /// A layer blob into `path` (created new): stops as soon as it exceeds
    /// the descriptor's size, and fails unless size and digest match.
    async fn blob_to_file(&mut self, descriptor: &Descriptor, path: &Path) -> Result<()> {
        let digest: Digest = descriptor.digest.parse()?;
        let mut response = self.get(&format!("blobs/{digest}"), &[]).await?;
        if let Some(length) = response.content_length() {
            ensure!(
                length == descriptor.size,
                "{digest}: the registry sends {length} bytes, the descriptor says {}",
                descriptor.size
            );
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .with_context(|| format!("create {}", path.display()))?;
        let mut hasher = Sha256::new();
        let mut received = 0u64;
        while let Some(chunk) = unless_cancelled(&self.cancel, response.chunk())
            .await?
            .with_context(|| format!("read {digest}"))?
        {
            received += chunk.len() as u64;
            ensure!(
                received <= descriptor.size,
                "{digest}: more than the {} bytes the descriptor says",
                descriptor.size
            );
            hasher.update(&chunk);
            file.write_all(&chunk)?;
        }
        ensure!(
            received == descriptor.size,
            "{digest}: {received} bytes, the descriptor says {}",
            descriptor.size
        );
        let actual: [u8; 32] = hasher.finalize().into();
        ensure!(
            &actual == digest.as_bytes(),
            "{digest}: the bytes received hash to {}",
            Digest::from_bytes(actual)
        );
        file.sync_all()?;
        Ok(())
    }
}

/// `future`'s output, unless `cancel` is set first: a pull stuck on the
/// network stops within [`CANCEL_POLL`] of a signal, not after a read
/// timeout (#162's F2).
async fn unless_cancelled<T>(
    cancel: &AtomicBool,
    future: impl std::future::Future<Output = T>,
) -> Result<T> {
    tokio::pin!(future);
    loop {
        ensure!(!cancel.load(Ordering::SeqCst), "cancelled");
        tokio::select! {
            output = &mut future => return Ok(output),
            () = tokio::time::sleep(CANCEL_POLL) => {}
        }
    }
}

/// A small body whole: at most `max` bytes, within `deadline`, and stopped
/// by `cancel` (#162's F2).
async fn read_bounded(
    mut response: reqwest::Response,
    max: u64,
    what: &str,
    cancel: &AtomicBool,
    deadline: Duration,
) -> Result<Vec<u8>> {
    if let Some(length) = response.content_length() {
        ensure!(length <= max, "{what}: {length} bytes, more than {max}");
    }
    let read = async {
        let mut body = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .with_context(|| format!("read {what}"))?
        {
            ensure!(
                body.len() as u64 + chunk.len() as u64 <= max,
                "{what}: more than {max} bytes"
            );
            body.extend_from_slice(&chunk);
        }
        anyhow::Ok(body)
    };
    unless_cancelled(cancel, tokio::time::timeout(deadline, read))
        .await?
        .map_err(|_| {
            anyhow::anyhow!(
                "{what}: not all of it arrived within {} s",
                deadline.as_secs_f64()
            )
        })?
}

fn check_digest(body: &[u8], digest: &Digest) -> Result<()> {
    let actual: [u8; 32] = Sha256::digest(body).into();
    ensure!(
        &actual == digest.as_bytes(),
        "{digest}: the registry's bytes hash to {}",
        Digest::from_bytes(actual)
    );
    Ok(())
}

fn media_type(document: &WireDocument, content_type: &str) -> String {
    document
        .media_type
        .clone()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| content_type.to_owned())
}

/// How the pull went, for the operator.
pub trait Progress {
    fn line(&self, text: &str);
}

pub struct Pull<'a> {
    pub store: &'a Store,
    pub mkfs: &'a Path,
    pub platform: Platform,
    pub progress: &'a dyn Progress,
    /// Once set, the pull stops within [`CANCEL_POLL`] while it waits on the
    /// network, or at the next write into mkfs.erofs, which it kills and
    /// reaps; it fails "cancelled".
    pub cancel: Arc<AtomicBool>,
    /// mkfs.erofs's: keel-layers' default by hand, [`RUNNER_TIME_LIMITS`]
    /// for `berth vm`.
    pub time_limits: TimeLimits,
    /// [`free_bytes`]; tests give another.
    pub free_space: &'a dyn Fn(&Path) -> std::io::Result<u64>,
}

impl<'a> Pull<'a> {
    pub fn new(
        store: &'a Store,
        mkfs: &'a Path,
        platform: Platform,
        progress: &'a dyn Progress,
        cancel: Arc<AtomicBool>,
    ) -> Self {
        Self {
            store,
            mkfs,
            platform,
            progress,
            cancel,
            time_limits: TimeLimits::default(),
            free_space: &free_bytes,
        }
    }

    /// Resolves, fetches, verifies and converts the image; writes and
    /// returns its record.
    pub async fn run(&self, reference: &Reference) -> Result<ImageRecord> {
        let base = format!("https://{}", reference.api_host());
        self.run_at(reference, client(true)?, base).await
    }

    /// What `berth vm` does before it listens (masterplan B-7 D1): nothing
    /// more, and nothing on the network, when the record and every layer
    /// file are here; otherwise a pull, which fetches only what is missing.
    pub async fn ensure(&self, reference: &Reference) -> Result<ImageRecord> {
        let base = format!("https://{}", reference.api_host());
        self.ensure_at(reference, client(true)?, base).await
    }

    async fn ensure_at(
        &self,
        reference: &Reference,
        client: reqwest::Client,
        base: String,
    ) -> Result<ImageRecord> {
        match self.store.cached(reference, self.platform)? {
            Ok(record) => {
                self.progress.line(&format!(
                    "image: {reference} is in {}",
                    self.store.directory.display()
                ));
                Ok(record)
            }
            Err(missing) => {
                self.progress.line(&format!(
                    "image: {missing}; pulling {reference} with {}",
                    self.mkfs.display()
                ));
                self.run_at(reference, client, base).await
            }
        }
    }

    async fn run_at(
        &self,
        reference: &Reference,
        client: reqwest::Client,
        base: String,
    ) -> Result<ImageRecord> {
        let mkfs_version = mkfs_version(self.mkfs)?;
        let mut registry = Registry::new(
            client,
            base,
            reference.repository.clone(),
            self.cancel.clone(),
        );
        let all_types: Vec<&str> = INDEX_TYPES.iter().chain(&MANIFEST_TYPES).copied().collect();

        let (body, content_type) = registry.document(&reference.digest, &all_types).await?;
        let document: WireDocument =
            serde_json::from_slice(&body).context("the manifest is not JSON")?;
        let kind = media_type(&document, &content_type);
        let (manifest, body, document) = if INDEX_TYPES.contains(&kind.as_str()) {
            let chosen = self.choose(reference, document.manifests.unwrap_or_default())?;
            self.progress.line(&format!(
                "{reference}: index, {} is {}",
                self.platform, chosen.digest
            ));
            let digest: Digest = chosen.digest.parse()?;
            let (body, content_type) = registry.document(&digest, &MANIFEST_TYPES).await?;
            ensure!(
                body.len() as u64 == chosen.size,
                "{digest}: {} bytes, the index says {}",
                body.len(),
                chosen.size
            );
            let document: WireDocument =
                serde_json::from_slice(&body).context("the manifest is not JSON")?;
            let kind = media_type(&document, &content_type);
            ensure!(
                kind == chosen.media_type,
                "{digest} is {kind}, the index says {}",
                chosen.media_type
            );
            let manifest = Descriptor {
                media_type: kind,
                digest: chosen.digest,
                size: chosen.size,
            };
            (manifest, body, document)
        } else {
            let manifest = Descriptor {
                media_type: kind,
                digest: reference.digest.to_string(),
                size: body.len() as u64,
            };
            (manifest, body, document)
        };
        drop(body);
        ensure!(
            MANIFEST_TYPES.contains(&manifest.media_type.as_str()),
            "{}: not an image manifest ({})",
            manifest.digest,
            manifest.media_type
        );
        let config_descriptor = document
            .config
            .with_context(|| format!("{}: no config", manifest.digest))?;
        ensure!(
            CONFIG_TYPES.contains(&config_descriptor.media_type.as_str()),
            "{}: the config is {}, not an image configuration",
            manifest.digest,
            config_descriptor.media_type
        );
        let layers = document.layers.unwrap_or_default();
        ensure!(
            layers.len() <= MAX_LAYERS,
            "{}: {} layers, at most {MAX_LAYERS}",
            manifest.digest,
            layers.len()
        );

        let config_bytes = registry.small_blob(&config_descriptor).await?;
        let config: WireConfig =
            serde_json::from_slice(&config_bytes).context("the image configuration")?;
        ensure!(
            self.platform
                .matches(&config.os, &config.architecture, config.variant.as_deref()),
            "{}: the configuration is for {}/{}, this runner needs {}",
            manifest.digest,
            config.os,
            config.architecture,
            self.platform
        );
        ensure!(
            config.rootfs.kind == "layers",
            "rootfs type {:?}",
            config.rootfs.kind
        );
        ensure!(
            config.rootfs.diff_ids.len() == layers.len(),
            "{}: {} layers, {} diff_ids",
            manifest.digest,
            layers.len(),
            config.rootfs.diff_ids.len()
        );
        let env = config.config.and_then(|c| c.env).unwrap_or_default();

        let mkfs = Mkfs::new(self.mkfs)
            .max_tar_bytes(MAX_TAR_BYTES)
            .time_limits(self.time_limits)
            .cancel_on(self.cancel.clone());
        let mut records = Vec::new();
        for (index, (layer, diff_id)) in layers.into_iter().zip(config.rootfs.diff_ids).enumerate()
        {
            let diff_id: DiffId = diff_id
                .parse()
                .with_context(|| format!("layer {}: the diff_id", index + 1))?;
            ensure!(
                layer.urls.as_ref().is_none_or(Vec::is_empty),
                "layer {}: a foreign layer (urls), not in the registry",
                index + 1
            );
            let compression = Compression::from_media_type(&layer.media_type)?;
            let _: Digest = layer.digest.parse()?;
            ensure!(
                layer.size <= MAX_BLOB_BYTES,
                "layer {}: {} bytes, more than {MAX_BLOB_BYTES}",
                index + 1,
                layer.size
            );
            let blob = Descriptor {
                media_type: layer.media_type,
                digest: layer.digest,
                size: layer.size,
            };
            let (path, tar_bytes) = match self.store.cache.get(&diff_id)? {
                Some(path) => {
                    self.progress
                        .line(&format!("layer {} {diff_id}: cached", index + 1));
                    (path, None)
                }
                None => {
                    let converted = self
                        .fetch_and_convert(
                            &mut registry,
                            &blob,
                            &diff_id,
                            compression,
                            &mkfs,
                            index,
                        )
                        .await?;
                    (self.store.cache.path(&diff_id), Some(converted))
                }
            };
            records.push(LayerRecord {
                diff_id: diff_id.to_string(),
                blob,
                file: path
                    .strip_prefix(&self.store.directory)
                    .unwrap_or(&path)
                    .display()
                    .to_string(),
                erofs_bytes: fs::metadata(&path)?.len(),
                tar_bytes,
            });
        }

        let record = ImageRecord {
            version: RECORD_VERSION,
            reference: reference.to_string(),
            registry: reference.registry.clone(),
            repository: reference.repository.clone(),
            digest: reference.digest.to_string(),
            platform: self.platform.to_string(),
            manifest,
            config: config_descriptor,
            env,
            layers: records,
            layer_format: LAYER_FORMAT,
            mkfs: self.mkfs.display().to_string(),
            mkfs_version,
            resolved_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_secs()),
        };
        write_record(&self.store.record_path(&reference.digest), &record)?;
        Ok(record)
    }

    /// The one index entry for this platform. Attestations and other
    /// platforms are skipped; two candidates are refused, not guessed.
    fn choose(
        &self,
        reference: &Reference,
        entries: Vec<WireIndexEntry>,
    ) -> Result<WireIndexEntry> {
        let mut candidates: Vec<WireIndexEntry> = entries
            .into_iter()
            .filter(|entry| {
                entry.platform.as_ref().is_some_and(|p| {
                    self.platform
                        .matches(&p.os, &p.architecture, p.variant.as_deref())
                })
            })
            .collect();
        match candidates.len() {
            0 => bail!("{reference} has no {} image", self.platform),
            1 => Ok(candidates.remove(0)),
            n => bail!(
                "{reference} has {n} {} images; name one by its digest",
                self.platform
            ),
        }
    }

    async fn fetch_and_convert(
        &self,
        registry: &mut Registry,
        blob: &Descriptor,
        diff_id: &DiffId,
        compression: Compression,
        mkfs: &Mkfs,
        index: usize,
    ) -> Result<u64> {
        let temporary = self.store.images().join(format!(
            ".tmp-{}-{}",
            &blob.digest["sha256:".len()..],
            std::process::id()
        ));
        self.check_free_space(blob, index)?;
        let started = Instant::now();
        let fetched = registry.blob_to_file(blob, &temporary).await;
        let result = match fetched {
            Ok(()) => {
                let fetch_seconds = started.elapsed().as_secs_f64();
                let cache = LayerCache::open(self.store.cache.dir())?;
                let (mkfs, diff_id, path) = (mkfs.clone(), *diff_id, temporary.clone());
                let converted = tokio::task::spawn_blocking(move || {
                    let mut tar_bytes = 0;
                    cache.publish(&diff_id, |out| {
                        let blob = File::open(&path)?;
                        tar_bytes = convert::convert(
                            &mkfs,
                            TarMode::Full,
                            blob,
                            compression,
                            &diff_id,
                            out,
                        )?
                        .tar_bytes;
                        Ok(())
                    })?;
                    anyhow::Ok(tar_bytes)
                })
                .await?;
                if let Ok(tar_bytes) = &converted {
                    self.progress.line(&format!(
                        "layer {} {diff_id}: fetched {} ({} bytes, {fetch_seconds:.1} s), converted {tar_bytes} tar bytes ({:.1} s)",
                        index + 1,
                        blob.digest,
                        blob.size,
                        started.elapsed().as_secs_f64() - fetch_seconds
                    ));
                }
                converted
            }
            Err(e) => Err(e),
        };
        let _ = fs::remove_file(&temporary);
        result.with_context(|| format!("layer {} ({})", index + 1, blob.digest))
    }
}

impl Pull<'_> {
    /// Refuses a blob the disk has no room for: the images directory (where
    /// the blob goes) and the cache (where its layer goes) must each have
    /// [`free_needed`] free.
    fn check_free_space(&self, blob: &Descriptor, index: usize) -> Result<()> {
        let needed = free_needed(blob.size);
        for directory in [self.store.images(), self.store.cache.dir().to_owned()] {
            let free = (self.free_space)(&directory)
                .with_context(|| format!("free space in {}", directory.display()))?;
            ensure!(
                free >= needed,
                "layer {} ({}, {} bytes): {} has {free} bytes free, and a blob needs 3 × its size + 2 GiB = {needed}; free space there and start again",
                index + 1,
                blob.digest,
                blob.size,
                directory.display()
            );
        }
        Ok(())
    }
}

fn write_record(path: &Path, record: &ImageRecord) -> Result<()> {
    let directory = path.parent().context("record path")?;
    let temporary = directory.join(format!(".tmp-record-{}", std::process::id()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(serde_json::to_string_pretty(record)?.as_bytes())?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        File::open(directory)?.sync_all()?;
        anyhow::Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.with_context(|| format!("write {}", path.display()))
}

#[cfg(test)]
mod tests;
