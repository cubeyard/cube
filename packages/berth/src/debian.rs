//! cube's default image and what makes it a guest cube can use: official
//! Debian trixie (`debian/trixie.json`, `image`), pinned by digest, and one
//! more layer above its own, the **Debian preparation layer**, with what a
//! keel guest needs and the image lacks: sudo, git, gh, curl and
//! ca-certificates (keel/agent `setup.rs` COMMANDS and CA_BUNDLES; without
//! them a machine is never `ready`).
//!
//! The layer is built on the runner, not booted: the packages are Debian's
//! own `.deb` files, pinned by name, version, size and sha256 for each
//! platform (resolved by `debian/resolve.sh` with apt at the image's own
//! snapshot time, without Recommends), fetched from deb.debian.org or, once
//! they left it, snapshot.debian.org, and each checked before it is read.
//! Their files are unpacked into one tar in a fixed order, with what their
//! maintainer scripts do on a fresh install that a guest needs:
//!
//! - `/etc/sudoers` 0440 (sudo);
//! - `/etc/ca-certificates.conf` with every certificate enabled,
//!   `/etc/ssl/certs/<name>.pem` and the bundle
//!   `/etc/ssl/certs/ca-certificates.crt`, as `update-ca-certificates`
//!   writes them, and `/usr/local/share/ca-certificates` (ca-certificates);
//! - dpkg's database: the image's status with these packages `install ok
//!   installed` (`debian/trixie-<arch>.status` is the image's own), their
//!   `info/` files and trigger interests, so apt and dpkg in the guest know
//!   them and a later `apt-get install` configures on top of them.
//!
//! Not done, and not needed by the tools: OpenSSL's hash links in
//! `/etc/ssl/certs` (the next `update-ca-certificates` writes them),
//! `ld.so.cache` (the libraries are in the default directories), debconf's
//! answers and the sysv links of sudo's init script.
//!
//! The tar is the same bytes on every runner, so its sha256 is pinned too
//! (`diffId`); a build that hashes otherwise is refused, and the layer goes
//! into the layer cache under that `diff_id` like an image layer. Machines
//! get it as the topmost layer of the image (`MachineImage.diff_ids`), so a
//! changed plan is a changed image for machines and templates alike.
//!
//! It applies to an image whose manifest for this platform is the plan's,
//! whether it was named by default or by `--image`; any other image is the
//! operator's own and must bring the tools itself.

use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use keel_layers::{
    DiffId,
    cache::LayerCache,
    convert::{self, Compression, Mkfs, TarMode, TimeLimits},
};
use md5::Md5;
use serde::Deserialize;
use sha2::{Digest as _, Sha256};

use crate::image::{self, Platform, Progress, Reference};

const PLAN: &str = include_str!("../debian/trixie.json");
const STATUS_AMD64: &str = include_str!("../debian/trixie-amd64.status");
const STATUS_ARM64: &str = include_str!("../debian/trixie-arm64.status");

/// Where a package is fetched from, in order: the archive's CDN, which has
/// the current packages, then the snapshot archive, which keeps every one.
const MIRROR: &str = "https://deb.debian.org";
const SNAPSHOT: &str = "https://snapshot.debian.org/archive";
/// One `.deb`, whole (the largest pinned one is under 10 MB; the snapshot
/// archive can be slow).
const DEB_DEADLINE: Duration = Duration::from_secs(900);
/// What one package's member may unpack to, and the whole layer.
const MAX_MEMBER_BYTES: u64 = 512 << 20;
const MAX_LAYER_BYTES: u64 = 4 << 30;

/// `debian/trixie.json`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    /// cube's default image (`berth vm` without `--image`).
    pub image: String,
    /// snapshot.debian.org's time the packages were resolved at, the image's
    /// own.
    pub snapshot: String,
    pub requested: Vec<String>,
    /// By platform (`linux/amd64`).
    pub platforms: BTreeMap<String, PlatformPlan>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlatformPlan {
    /// The image's manifest for this platform: the plan applies to it only.
    pub manifest: String,
    /// The image's `/var/lib/dpkg/status`, beside the plan.
    pub status: String,
    /// sha256 of the layer's tar.
    pub diff_id: String,
    pub packages: Vec<Package>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Package {
    pub name: String,
    pub version: String,
    pub architecture: String,
    /// `debian` or `debian-security`.
    pub archive: String,
    /// The pool path, as in the archive's Packages index.
    pub filename: String,
    pub size: u64,
    pub sha256: String,
}

pub fn plan() -> &'static Plan {
    static PARSED: OnceLock<Plan> = OnceLock::new();
    PARSED.get_or_init(|| serde_json::from_str(PLAN).expect("debian/trixie.json"))
}

/// cube's default image: what `berth vm` serves without `--image` (or with
/// `--image default`).
pub fn default_image() -> Reference {
    Reference::parse(&plan().image).expect("debian/trixie.json's image")
}

/// The preparation for an image whose manifest for `platform` is
/// `manifest`, if it is the plan's.
pub fn for_manifest(platform: Platform, manifest: &str) -> Option<&'static PlatformPlan> {
    plan()
        .platforms
        .get(&platform.to_string())
        .filter(|p| p.manifest == manifest)
}

impl PlatformPlan {
    pub fn diff_id(&self) -> Result<DiffId> {
        self.diff_id
            .parse()
            .with_context(|| format!("debian/trixie.json's diffId {:?}", self.diff_id))
    }

    fn base_status(&self) -> Result<&'static str> {
        Ok(match self.status.as_str() {
            "trixie-amd64.status" => STATUS_AMD64,
            "trixie-arm64.status" => STATUS_ARM64,
            other => bail!("debian/trixie.json names {other}, which berth does not carry"),
        })
    }

    fn requested(&self) -> usize {
        self.packages.len()
    }
}

/// Makes sure the preparation layer of `plan` is in `directory`'s layer
/// cache: nothing, and nothing on the network, when it is; otherwise the
/// packages are fetched into a temporary directory under `images/`, the tar
/// is built and checked against the plan's `diff_id`, and converted by
/// `mkfs.erofs` as an image layer is.
pub struct Prepare<'a> {
    pub directory: &'a Path,
    pub mkfs: &'a Path,
    pub progress: &'a dyn Progress,
    pub cancel: Arc<AtomicBool>,
    pub time_limits: TimeLimits,
    pub free_space: &'a dyn Fn(&Path) -> io::Result<u64>,
}

impl Prepare<'_> {
    pub async fn ensure(&self, plan: &'static PlatformPlan) -> Result<DiffId> {
        let diff_id = plan.diff_id()?;
        let cache = LayerCache::open(image::layer_dir(self.directory))?;
        if cache.get(&diff_id)?.is_some() {
            return Ok(diff_id);
        }
        let total: u64 = plan.packages.iter().map(|p| p.size).sum();
        // The packages, their tar (several times their size: they are xz)
        // and the layer it becomes.
        let needed = image::free_needed(total.saturating_mul(4));
        for directory in [self.directory.join("images"), cache.dir().to_owned()] {
            let free = (self.free_space)(&directory)
                .with_context(|| format!("free space in {}", directory.display()))?;
            ensure!(
                free >= needed,
                "the Debian preparation layer needs {needed} bytes free in {}, which has {free}; free space there and start again",
                directory.display()
            );
        }
        self.progress.line(&format!(
            "preparing the image for cube: {} Debian packages ({total} bytes: {}), unpacked into layer {diff_id}",
            plan.requested(),
            plan_names(plan)
        ));
        let work = self.directory.join("images").join(format!(
            ".tmp-debian-{}-{}",
            &diff_id.hex()[..16],
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&work);
        fs::create_dir_all(&work)?;
        let result = self.build(plan, &diff_id, &work, &cache).await;
        let _ = fs::remove_dir_all(&work);
        result.context("the Debian preparation layer")?;
        Ok(diff_id)
    }

    async fn build(
        &self,
        plan: &'static PlatformPlan,
        diff_id: &DiffId,
        work: &Path,
        cache: &LayerCache,
    ) -> Result<()> {
        let client = image::client(true)?;
        let mut debs = Vec::new();
        for package in &plan.packages {
            let path = work.join(format!("{}.deb", package.name));
            fetch(&client, package, &path, &self.cancel).await?;
            debs.push((package.clone(), path));
        }
        self.progress
            .line(&format!("fetched and checked {} packages", debs.len()));
        let tar = work.join("layer.tar");
        let (plan_status, tar_path) = (plan.base_status()?, tar.clone());
        let built = tokio::task::spawn_blocking(move || {
            let file = BufWriterHash::new(File::create(&tar_path)?);
            let file = build_layer(plan_status, &debs, file)?;
            file.finish()
        })
        .await??;
        ensure!(
            built == *diff_id,
            "the packages unpacked to a tar with sha256 {built}, but debian/trixie.json pins {diff_id}; nothing was cached"
        );
        let mkfs = Mkfs::new(self.mkfs)
            .time_limits(self.time_limits)
            .cancel_on(self.cancel.clone());
        let (cache, diff_id) = (LayerCache::open(cache.dir())?, *diff_id);
        let converted = tokio::task::spawn_blocking(move || {
            let mut tar_bytes = 0;
            cache.publish(&diff_id, |out| {
                tar_bytes = convert::convert(
                    &mkfs,
                    TarMode::Full,
                    File::open(&tar)?,
                    Compression::None,
                    &diff_id,
                    out,
                )?
                .tar_bytes;
                Ok(())
            })?;
            anyhow::Ok(tar_bytes)
        })
        .await??;
        self.progress.line(&format!(
            "prepared layer {diff_id}: {converted} tar bytes converted"
        ));
        Ok(())
    }
}

fn plan_names(plan: &PlatformPlan) -> String {
    plan.packages
        .iter()
        .map(|p| p.name.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

/// The URLs a package is fetched from, in order.
pub fn urls(package: &Package) -> Vec<String> {
    vec![
        format!("{MIRROR}/{}/{}", package.archive, package.filename),
        format!(
            "{SNAPSHOT}/{}/{}/{}",
            package.archive,
            plan().snapshot,
            package.filename
        ),
    ]
}

/// One package into `path`: from the first URL that gives exactly its
/// pinned bytes.
async fn fetch(
    client: &reqwest::Client,
    package: &Package,
    path: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    let mut failures = Vec::new();
    for url in urls(package) {
        ensure!(!cancel.load(Ordering::SeqCst), "cancelled");
        let _ = fs::remove_file(path);
        match fetch_one(client, &url, package, path, cancel).await {
            Ok(()) => return Ok(()),
            Err(e) if e.to_string() == "cancelled" => return Err(e),
            Err(e) => failures.push(format!("{url}: {e:#}")),
        }
    }
    let _ = fs::remove_file(path);
    bail!(
        "{} {}: no source gave its pinned bytes ({})",
        package.name,
        package.version,
        failures.join("; ")
    )
}

async fn fetch_one(
    client: &reqwest::Client,
    url: &str,
    package: &Package,
    path: &Path,
    cancel: &AtomicBool,
) -> Result<()> {
    let download = async {
        let mut response = client.get(url).send().await?.error_for_status()?;
        let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
        let mut hasher = Sha256::new();
        let mut received = 0u64;
        while let Some(chunk) = response.chunk().await? {
            ensure!(!cancel.load(Ordering::SeqCst), "cancelled");
            received += chunk.len() as u64;
            ensure!(
                received <= package.size,
                "more than the {} bytes pinned",
                package.size
            );
            hasher.update(&chunk);
            file.write_all(&chunk)?;
        }
        ensure!(
            received == package.size,
            "{received} bytes, {} pinned",
            package.size
        );
        let actual = hex(&hasher.finalize());
        ensure!(
            actual == package.sha256,
            "sha256 {actual}, {} pinned",
            package.sha256
        );
        anyhow::Ok(())
    };
    tokio::time::timeout(DEB_DEADLINE, download)
        .await
        .map_err(|_| anyhow::anyhow!("not all of it within {} s", DEB_DEADLINE.as_secs()))?
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A writer that hashes what goes through it: the tar's `diff_id`.
struct BufWriterHash<W: Write> {
    inner: io::BufWriter<W>,
    hasher: Sha256,
    bytes: u64,
}

impl<W: Write> BufWriterHash<W> {
    fn new(inner: W) -> Self {
        Self {
            inner: io::BufWriter::new(inner),
            hasher: Sha256::new(),
            bytes: 0,
        }
    }

    fn finish(mut self) -> Result<DiffId> {
        self.inner.flush()?;
        Ok(DiffId::from_bytes(self.hasher.finalize().into()))
    }
}

impl<W: Write> Write for BufWriterHash<W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(data)?;
        self.bytes += n as u64;
        if self.bytes > MAX_LAYER_BYTES {
            return Err(io::Error::other("the layer exceeds 4 GiB"));
        }
        self.hasher.update(&data[..n]);
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

// ------------------------------------------------------------ the layer

/// The members of a `.deb` berth reads.
struct Deb {
    control: Vec<u8>,
    data: Vec<u8>,
}

/// A `.deb` is an `ar` archive: `debian-binary`, `control.tar.*`,
/// `data.tar.*`.
fn read_deb(path: &Path) -> Result<Deb> {
    let bytes = fs::read(path)?;
    ensure!(bytes.starts_with(b"!<arch>\n"), "not an ar archive");
    let (mut at, mut control, mut data) = (8usize, None, None);
    while at + 60 <= bytes.len() {
        let header = &bytes[at..at + 60];
        ensure!(&header[58..60] == b"`\n", "a bad ar member header");
        let name = String::from_utf8_lossy(&header[..16])
            .trim_end()
            .trim_end_matches('/')
            .to_owned();
        let size: usize = String::from_utf8_lossy(&header[48..58])
            .trim()
            .parse()
            .context("an ar member's size")?;
        let start = at + 60;
        ensure!(start + size <= bytes.len(), "an ar member past the end");
        let body = &bytes[start..start + size];
        if let Some(kind) = name.strip_prefix("control.tar") {
            control = Some(decompress(kind, body)?);
        } else if let Some(kind) = name.strip_prefix("data.tar") {
            data = Some(decompress(kind, body)?);
        }
        at = start + size + (size & 1);
    }
    Ok(Deb {
        control: control.context("no control.tar")?,
        data: data.context("no data.tar")?,
    })
}

fn decompress(kind: &str, body: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    match kind {
        "" => out.extend_from_slice(body),
        ".xz" => {
            let mut reader = io::BufReader::new(body);
            lzma_rs::xz_decompress(&mut reader, &mut out).context("xz")?;
        }
        ".gz" => {
            flate2::read::GzDecoder::new(body)
                .take(MAX_MEMBER_BYTES + 1)
                .read_to_end(&mut out)?;
        }
        ".zst" => {
            zstd::stream::read::Decoder::new(body)?
                .take(MAX_MEMBER_BYTES + 1)
                .read_to_end(&mut out)?;
        }
        other => bail!("a member compressed as {other:?}"),
    }
    ensure!(
        out.len() as u64 <= MAX_MEMBER_BYTES,
        "a member over {MAX_MEMBER_BYTES} bytes"
    );
    Ok(out)
}

/// A path in a package's tar as the layer names it: no `./`, no leading or
/// trailing `/`; the root is empty.
fn clean(path: &Path) -> Result<String> {
    let text = path.to_str().context("a path that is not UTF-8")?;
    let text = text.trim_start_matches("./").trim_start_matches('/');
    let text = text.trim_end_matches('/');
    let text = if text == "." { "" } else { text };
    ensure!(
        !text.split('/').any(|c| c == ".." || c == "."),
        "a path with . or ..: {text}"
    );
    Ok(text.to_owned())
}

/// What the maintainer scripts set on a fresh install, by path.
fn installed_mode(path: &str, mode: u32) -> u32 {
    match path {
        // sudo's postinst.
        "etc/sudoers" => 0o440,
        _ => mode,
    }
}

/// One file of a package's control tar or data tar.
struct Member {
    path: String,
    kind: tar::EntryType,
    mode: u32,
    uid: u64,
    gid: u64,
    user: String,
    group: String,
    mtime: u64,
    link: Option<String>,
    data: Vec<u8>,
}

fn members(tar_bytes: &[u8]) -> Result<Vec<Member>> {
    let mut archive = tar::Archive::new(tar_bytes);
    let mut out = Vec::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let header = entry.header().clone();
        let kind = header.entry_type();
        let path = clean(&entry.path()?)?;
        let link = match kind {
            tar::EntryType::Symlink => Some(
                entry
                    .link_name()?
                    .context("a symlink without a target")?
                    .to_str()
                    .context("a link that is not UTF-8")?
                    .to_owned(),
            ),
            tar::EntryType::Link => Some(clean(
                &entry.link_name()?.context("a hard link without a target")?,
            )?),
            tar::EntryType::Regular | tar::EntryType::Directory => None,
            other => bail!("{path}: an entry of type {other:?}"),
        };
        let mut data = Vec::new();
        if kind == tar::EntryType::Regular {
            entry.read_to_end(&mut data)?;
        }
        out.push(Member {
            path,
            kind,
            mode: header.mode()? & 0o7777,
            uid: header.uid()?,
            gid: header.gid()?,
            user: header
                .username()
                .ok()
                .flatten()
                .unwrap_or("root")
                .to_owned(),
            group: header
                .groupname()
                .ok()
                .flatten()
                .unwrap_or("root")
                .to_owned(),
            mtime: header.mtime()?,
            link,
            data,
        });
    }
    Ok(out)
}

/// A control file's fields, in order, each with its value as written
/// (continuation lines included, without the final newline).
fn fields(paragraph: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for line in paragraph.lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            if let Some((_, value)) = out.last_mut() {
                value.push('\n');
                value.push_str(line);
            }
        } else if let Some((name, value)) = line.split_once(':') {
            out.push((name.to_owned(), value.trim_start().to_owned()));
        }
    }
    out
}

/// dpkg's order of the fields it knows (lib/dpkg/parse.c); others follow
/// in their own order.
const DPKG_ORDER: [&str; 32] = [
    "Package",
    "Essential",
    "Protected",
    "Status",
    "Priority",
    "Section",
    "Installed-Size",
    "Origin",
    "Maintainer",
    "Bugs",
    "Architecture",
    "Multi-Arch",
    "Source",
    "Version",
    "Config-Version",
    "Replaces",
    "Provides",
    "Depends",
    "Pre-Depends",
    "Recommends",
    "Suggests",
    "Breaks",
    "Conflicts",
    "Enhances",
    "Conffiles",
    "Filename",
    "Size",
    "MD5sum",
    "MSDOS-Filename",
    "Description",
    "Triggers-Pending",
    "Triggers-Awaited",
];

/// A package's paragraph in dpkg's status: `install ok installed`, its
/// conffiles with their sums.
fn status_paragraph(control: &[(String, String)], conffiles: &[(String, String)]) -> String {
    let mut fields: Vec<(String, String)> = control.to_vec();
    fields.push(("Status".into(), "install ok installed".into()));
    if !conffiles.is_empty() {
        let lines: String = conffiles
            .iter()
            .map(|(path, sum)| format!("\n {path} {sum}"))
            .collect();
        fields.push(("Conffiles".into(), lines));
    }
    let rank = |name: &str| {
        DPKG_ORDER
            .iter()
            .position(|known| known.eq_ignore_ascii_case(name))
            .unwrap_or(DPKG_ORDER.len())
    };
    // Stable: unknown fields keep their order, after the known ones.
    fields.sort_by_key(|(name, _)| rank(name));
    let mut out = String::new();
    for (name, value) in fields {
        if value.starts_with('\n') {
            out.push_str(&format!("{name}:{value}\n"));
        } else {
            out.push_str(&format!("{name}: {value}\n"));
        }
    }
    out
}

fn field<'a>(fields: &'a [(String, String)], name: &str) -> Option<&'a str> {
    fields
        .iter()
        .find(|(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

/// update-ca-certificates' name for a certificate's link.
fn pem_name(crt: &str) -> String {
    let base = crt.rsplit('/').next().unwrap_or(crt);
    let base = base.strip_suffix(".crt").unwrap_or(base);
    let base: String = base
        .chars()
        .map(|c| match c {
            ' ' | ',' => '_',
            '(' | ')' => '=',
            c => c,
        })
        .collect();
    format!("{base}.pem")
}

const CA_CONF_HEADER: &str =
    "# This file lists certificates that you wish to use or to ignore to be
# installed in /etc/ssl/certs.
# update-ca-certificates(8) will update /etc/ssl/certs by reading this file.
#
# This is autogenerated by dpkg-reconfigure ca-certificates.
# Certificates should be installed under /usr/share/ca-certificates
# and files with extension '.crt' is recognized as available certs.
#
# line begins with # is comment.
# line begins with ! is certificate filename to be deselected.
#
";

/// Writes the tar: every package's files in the plan's order (a directory
/// once, a file twice is refused), then what their maintainer scripts and
/// dpkg would have written (module comment). The same packages give the same
/// bytes.
fn build_layer<W: Write>(base_status: &str, debs: &[(Package, PathBuf)], out: W) -> Result<W> {
    let mut layer = Layer::new(out);
    let mut paragraphs: BTreeMap<String, String> = BTreeMap::new();
    let mut interests: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut info: Vec<(String, u32, Vec<u8>)> = Vec::new();
    let mut certificates: BTreeMap<String, Vec<u8>> = BTreeMap::new();
    for (package, path) in debs {
        let deb =
            read_deb(path).with_context(|| format!("{} {}", package.name, package.version))?;
        let control_members = members(&deb.control)?;
        let control_text = control_members
            .iter()
            .find(|m| m.path == "control")
            .context("no control file")?;
        let control = fields(&String::from_utf8_lossy(&control_text.data));
        ensure!(
            field(&control, "Package") == Some(&package.name)
                && field(&control, "Version") == Some(&package.version),
            "{}: its control file names another package or version",
            package.filename
        );
        let data = members(&deb.data)?;
        let contents: BTreeMap<&str, &[u8]> = data
            .iter()
            .filter(|m| m.kind == tar::EntryType::Regular)
            .map(|m| (m.path.as_str(), m.data.as_slice()))
            .collect();
        // dpkg's names: `name:arch` for Multi-Arch: same.
        let db_name = if field(&control, "Multi-Arch") == Some("same") {
            format!("{}:{}", package.name, package.architecture)
        } else {
            package.name.clone()
        };
        let mut conffiles = Vec::new();
        for member in &control_members {
            match member.path.as_str() {
                "" | "control" => {}
                "conffiles" => {
                    for line in String::from_utf8_lossy(&member.data).lines() {
                        let path = line.trim();
                        if path.is_empty() {
                            continue;
                        }
                        let key = path.trim_start_matches('/');
                        let data = contents
                            .get(key)
                            .with_context(|| format!("conffile {path} is not in the package"))?;
                        conffiles.push((path.to_owned(), hex(&Md5::digest(data))));
                    }
                    info.push((
                        format!("{db_name}.conffiles"),
                        member.mode,
                        member.data.clone(),
                    ));
                }
                "triggers" => {
                    for line in String::from_utf8_lossy(&member.data).lines() {
                        let mut words = line.split_whitespace();
                        let (Some(directive), Some(name)) = (words.next(), words.next()) else {
                            continue;
                        };
                        let awaits = match directive {
                            "interest" | "interest-await" => true,
                            "interest-noawait" => false,
                            _ => continue,
                        };
                        ensure!(
                            !name.starts_with('/'),
                            "{}: file trigger {name} is not supported",
                            package.name
                        );
                        interests
                            .entry(name.to_owned())
                            .or_default()
                            .push(if awaits {
                                db_name.clone()
                            } else {
                                format!("{db_name}/noawait")
                            });
                    }
                    info.push((
                        format!("{db_name}.triggers"),
                        member.mode,
                        member.data.clone(),
                    ));
                }
                name => info.push((
                    format!("{db_name}.{name}"),
                    member.mode,
                    member.data.clone(),
                )),
            }
        }
        let mut list = String::from("/.\n");
        for member in &data {
            if member.path.is_empty() {
                continue;
            }
            list.push_str(&format!("/{}\n", member.path));
            if package.name == "ca-certificates"
                && member.kind == tar::EntryType::Regular
                && member.path.ends_with(".crt")
                && let Some(name) = member.path.strip_prefix("usr/share/ca-certificates/")
            {
                certificates.insert(name.to_owned(), member.data.clone());
            }
            layer.add(member)?;
        }
        info.push((format!("{db_name}.list"), 0o644, list.into_bytes()));
        ensure!(
            paragraphs
                .insert(db_name.clone(), status_paragraph(&control, &conffiles))
                .is_none(),
            "{db_name} twice"
        );
    }

    // ca-certificates' postinst and update-ca-certificates.
    if !certificates.is_empty() {
        layer.directory("usr/local/share/ca-certificates")?;
        let mut conf = String::from(CA_CONF_HEADER);
        let mut bundle = Vec::new();
        for (name, data) in &certificates {
            conf.push_str(name);
            conf.push('\n');
            bundle.extend_from_slice(data);
            if !data.ends_with(b"\n") {
                bundle.push(b'\n');
            }
        }
        layer.file("etc/ca-certificates.conf", 0o644, conf.as_bytes())?;
        layer.directory("etc/ssl/certs")?;
        for name in certificates.keys() {
            layer.symlink(
                &format!("etc/ssl/certs/{}", pem_name(name)),
                &format!("/usr/share/ca-certificates/{name}"),
            )?;
        }
        layer.file("etc/ssl/certs/ca-certificates.crt", 0o644, &bundle)?;
    }

    // dpkg's database.
    layer.file(
        "var/lib/dpkg/status",
        0o644,
        merge_status(base_status, &paragraphs)?.as_bytes(),
    )?;
    layer.directory("var/lib/dpkg/info")?;
    info.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, mode, data) in &info {
        layer.file(&format!("var/lib/dpkg/info/{name}"), *mode, data)?;
    }
    layer.directory("var/lib/dpkg/triggers")?;
    for (name, packages) in &interests {
        let text: String = packages.iter().map(|p| format!("{p}\n")).collect();
        layer.file(
            &format!("var/lib/dpkg/triggers/{name}"),
            0o644,
            text.as_bytes(),
        )?;
    }
    layer.finish()
}

/// The image's status with the packages' paragraphs, sorted by package as
/// dpkg writes it. A package the image has already is refused: the plan
/// installs only what is new.
fn merge_status(base: &str, added: &BTreeMap<String, String>) -> Result<String> {
    let mut all: BTreeMap<String, String> = BTreeMap::new();
    for paragraph in base.split("\n\n").map(str::trim).filter(|p| !p.is_empty()) {
        let fields = fields(paragraph);
        let name = field(&fields, "Package").context("a status paragraph without Package")?;
        let key = match field(&fields, "Multi-Arch") {
            Some("same") => format!("{name}:{}", field(&fields, "Architecture").unwrap_or("")),
            _ => name.to_owned(),
        };
        all.insert(key, format!("{paragraph}\n"));
    }
    for (name, paragraph) in added {
        let bare = name.split(':').next().unwrap_or(name);
        ensure!(
            !all.keys()
                .any(|k| k == name || k.split(':').next() == Some(bare)),
            "{name} is in the image already"
        );
        all.insert(name.clone(), paragraph.clone());
    }
    // dpkg sorts by name, then architecture.
    let mut ordered: Vec<(&String, &String)> = all.iter().collect();
    ordered.sort_by(|a, b| {
        let split = |k: &str| {
            let (n, a) = k.split_once(':').unwrap_or((k, ""));
            (n.to_owned(), a.to_owned())
        };
        split(a.0).cmp(&split(b.0))
    });
    Ok(ordered.into_iter().map(|(_, p)| format!("{p}\n")).collect())
}

/// The tar being written: GNU headers, root-owned generated entries at
/// time 0, each directory once.
struct Layer<W: Write> {
    builder: tar::Builder<W>,
    directories: HashSet<String>,
    files: BTreeSet<String>,
}

impl<W: Write> Layer<W> {
    fn new(out: W) -> Self {
        let mut builder = tar::Builder::new(out);
        builder.mode(tar::HeaderMode::Complete);
        builder.follow_symlinks(false);
        Self {
            builder,
            directories: HashSet::new(),
            files: BTreeSet::new(),
        }
    }

    fn header(kind: tar::EntryType, mode: u32, size: u64) -> tar::Header {
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(kind);
        header.set_mode(mode);
        header.set_uid(0);
        header.set_gid(0);
        let _ = header.set_username("root");
        let _ = header.set_groupname("root");
        header.set_mtime(0);
        header.set_size(size);
        header
    }

    /// A package's entry, as the package has it (but [`installed_mode`]).
    fn add(&mut self, member: &Member) -> Result<()> {
        if member.kind == tar::EntryType::Directory {
            if !self.directories.insert(member.path.clone()) {
                return Ok(());
            }
        } else {
            ensure!(
                self.files.insert(member.path.clone()),
                "{} is in two packages",
                member.path
            );
        }
        let mut header = Self::header(
            member.kind,
            installed_mode(&member.path, member.mode),
            member.data.len() as u64,
        );
        header.set_uid(member.uid);
        header.set_gid(member.gid);
        header.set_username(&member.user)?;
        header.set_groupname(&member.group)?;
        header.set_mtime(member.mtime);
        match &member.link {
            Some(target) => {
                header.set_size(0);
                self.builder
                    .append_link(&mut header, &member.path, target)?
            }
            None => self
                .builder
                .append_data(&mut header, &member.path, member.data.as_slice())?,
        }
        Ok(())
    }

    /// A directory and its parents, 0755 root, unless a package or an
    /// earlier call wrote them.
    fn directory(&mut self, path: &str) -> Result<()> {
        let mut at = String::new();
        for part in path.split('/') {
            if !at.is_empty() {
                at.push('/');
            }
            at.push_str(part);
            if self.directories.insert(at.clone()) {
                let mut header = Self::header(tar::EntryType::Directory, 0o755, 0);
                self.builder.append_data(&mut header, &at, io::empty())?;
            }
        }
        Ok(())
    }

    fn parent(&mut self, path: &str) -> Result<()> {
        match path.rsplit_once('/') {
            Some((parent, _)) => self.directory(parent),
            None => Ok(()),
        }
    }

    fn file(&mut self, path: &str, mode: u32, data: &[u8]) -> Result<()> {
        self.parent(path)?;
        ensure!(self.files.insert(path.to_owned()), "{path} twice");
        let mut header = Self::header(tar::EntryType::Regular, mode, data.len() as u64);
        self.builder.append_data(&mut header, path, data)?;
        Ok(())
    }

    fn symlink(&mut self, path: &str, target: &str) -> Result<()> {
        self.parent(path)?;
        ensure!(self.files.insert(path.to_owned()), "{path} twice");
        let mut header = Self::header(tar::EntryType::Symlink, 0o777, 0);
        self.builder.append_link(&mut header, path, target)?;
        Ok(())
    }

    fn finish(self) -> Result<W> {
        Ok(self.builder.into_inner()?)
    }
}

#[cfg(test)]
#[path = "debian/tests.rs"]
mod tests;
