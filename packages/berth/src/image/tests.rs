//! A registry served from a test, so every way a registry or the network can
//! be wrong can be served on purpose. Conversion uses the real `mkfs.erofs`
//! when it is in `PATH` (skipped with a notice otherwise, unless
//! `CUBE_TEST_LAYER_TOOLS` requires it, as in keel-layers' tests); the
//! integrity tests use a stand-in that records being started, to show a bad
//! blob never reaches conversion.

use std::{
    collections::BTreeMap,
    io::Write as _,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
};

use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

use super::*;

/// One answer: status, headers and body.
#[derive(Clone)]
struct Answer {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Answer {
    fn ok(content_type: &str, body: Vec<u8>) -> Self {
        Self {
            status: 200,
            headers: vec![("Content-Type".into(), content_type.into())],
            body,
        }
    }
}

#[derive(Default)]
struct Served {
    routes: BTreeMap<String, Answer>,
    /// The bearer token the registry wants; none means it is open.
    token: Option<String>,
    /// Each request: path (with query) and its `Authorization`, if any.
    requests: Vec<(String, Option<String>)>,
}

/// An HTTP/1.1 registry on 127.0.0.1; one request per connection.
struct FakeRegistry {
    port: u16,
    served: Arc<Mutex<Served>>,
}

impl FakeRegistry {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let served = Arc::new(Mutex::new(Served::default()));
        let shared = served.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let served = shared.clone();
                tokio::spawn(async move {
                    let mut request = Vec::new();
                    let mut buffer = [0u8; 4096];
                    while !request.windows(4).any(|w| w == b"\r\n\r\n") {
                        match stream.read(&mut buffer).await {
                            Ok(0) | Err(_) => return,
                            Ok(n) => request.extend_from_slice(&buffer[..n]),
                        }
                    }
                    let text = String::from_utf8_lossy(&request).into_owned();
                    let path = text.split(' ').nth(1).unwrap_or_default().to_owned();
                    let authorization = text
                        .lines()
                        .find_map(|l| {
                            l.strip_prefix("authorization: ")
                                .or(l.strip_prefix("Authorization: "))
                        })
                        .map(str::to_owned);
                    let answer = {
                        let mut served = served.lock().unwrap();
                        served.requests.push((path.clone(), authorization.clone()));
                        let route = path.split('?').next().unwrap_or_default();
                        if route == "/token" && !served.routes.contains_key(route) {
                            let token = served.token.clone().unwrap_or_default();
                            Answer::ok(
                                "application/json",
                                format!("{{\"token\":\"{token}\"}}").into_bytes(),
                            )
                        } else if route.starts_with("/v2/")
                            && served.token.is_some()
                            && authorization != served.token.as_ref().map(|t| format!("Bearer {t}"))
                        {
                            Answer {
                                status: 401,
                                headers: vec![(
                                    "WWW-Authenticate".into(),
                                    format!(
                                        "Bearer realm=\"http://127.0.0.1:{port}/token\",service=\"fake\""
                                    ),
                                )],
                                body: Vec::new(),
                            }
                        } else {
                            served.routes.get(route).cloned().unwrap_or(Answer {
                                status: 404,
                                headers: Vec::new(),
                                body: Vec::new(),
                            })
                        }
                    };
                    let mut head = format!(
                        "HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n",
                        answer.status,
                        answer.body.len()
                    );
                    for (name, value) in &answer.headers {
                        head.push_str(&format!("{name}: {value}\r\n"));
                    }
                    head.push_str("\r\n");
                    let _ = stream.write_all(head.as_bytes()).await;
                    let _ = stream.write_all(&answer.body).await;
                    let _ = stream.shutdown().await;
                });
            }
        });
        Self { port, served }
    }

    fn base(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn route(&self, path: &str, answer: Answer) {
        self.served
            .lock()
            .unwrap()
            .routes
            .insert(path.into(), answer);
    }

    fn blob(&self, body: &[u8]) -> Descriptor {
        let digest = sha256(body);
        self.route(
            &format!("/v2/test/image/blobs/{digest}"),
            Answer::ok("application/octet-stream", body.to_vec()),
        );
        Descriptor {
            media_type: String::new(),
            digest,
            size: body.len() as u64,
        }
    }

    fn manifest(&self, media_type: &str, body: &[u8]) -> Descriptor {
        let digest = sha256(body);
        self.route(
            &format!("/v2/test/image/manifests/{digest}"),
            Answer::ok(media_type, body.to_vec()),
        );
        Descriptor {
            media_type: media_type.into(),
            digest,
            size: body.len() as u64,
        }
    }

    fn requests(&self) -> Vec<(String, Option<String>)> {
        self.served.lock().unwrap().requests.clone()
    }
}

fn sha256(body: &[u8]) -> String {
    Digest::from_bytes(Sha256::digest(body).into()).to_string()
}

const OCI_MANIFEST: &str = "application/vnd.oci.image.manifest.v1+json";
const OCI_INDEX: &str = "application/vnd.oci.image.index.v1+json";
const GZIP_LAYER: &str = "application/vnd.oci.image.layer.v1.tar+gzip";
const AMD64: Platform = Platform {
    os: "linux",
    architecture: "amd64",
};
const ARM64: Platform = Platform {
    os: "linux",
    architecture: "arm64",
};

enum Entry<'a> {
    Dir(&'a str),
    File(&'a str, u32, &'a [u8]),
    Symlink(&'a str, &'a str),
    Hardlink(&'a str, &'a str),
}

/// A ustar archive, owner 1000:1001, so the bytes do not depend on a host's
/// tar and ownership has something to keep.
fn tar(entries: &[Entry]) -> Vec<u8> {
    let mut out = Vec::new();
    for entry in entries {
        let (name, mode, kind, link, data): (&str, u32, u8, &str, &[u8]) = match entry {
            Entry::Dir(name) => (name, 0o755, b'5', "", b""),
            Entry::File(name, mode, data) => (name, *mode, b'0', "", data),
            Entry::Symlink(name, target) => (name, 0o777, b'2', target, b""),
            Entry::Hardlink(name, target) => (name, 0o644, b'1', target, b""),
        };
        let mut header = [0u8; 512];
        header[..name.len()].copy_from_slice(name.as_bytes());
        header[100..107].copy_from_slice(format!("{mode:07o}").as_bytes());
        header[108..115].copy_from_slice(b"0001750");
        header[116..123].copy_from_slice(b"0001751");
        header[124..135].copy_from_slice(format!("{:011o}", data.len()).as_bytes());
        header[136..147].copy_from_slice(format!("{:011o}", 1_700_000_000).as_bytes());
        header[156] = kind;
        header[157..157 + link.len()].copy_from_slice(link.as_bytes());
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        header[148..156].fill(b' ');
        let sum: u32 = header.iter().map(|&b| b as u32).sum();
        header[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
        out.extend_from_slice(&header);
        out.extend_from_slice(data);
        out.resize(out.len().next_multiple_of(512), 0);
    }
    out.resize(out.len() + 1024, 0);
    out.resize(out.len().next_multiple_of(10240), 0);
    out
}

fn gzip(data: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}

fn base_layer() -> Vec<u8> {
    tar(&[
        Entry::Dir("etc/"),
        Entry::File("etc/hello", 0o644, b"hello from the base\n"),
        Entry::File("etc/gone", 0o644, b"removed by the upper layer\n"),
        Entry::Dir("opaque/"),
        Entry::File("opaque/old", 0o644, b"hidden by the upper layer\n"),
        Entry::Dir("bin/"),
        Entry::File("bin/tool", 0o4755, b"#!/bin/sh\n"),
        Entry::Symlink("bin/link", "tool"),
        Entry::Hardlink("bin/hard", "bin/tool"),
    ])
}

fn upper_layer() -> Vec<u8> {
    tar(&[
        Entry::Dir("etc/"),
        Entry::File("etc/.wh.gone", 0o644, b""),
        Entry::Dir("opaque/"),
        Entry::File("opaque/.wh..wh..opq", 0o644, b""),
        Entry::File("opaque/new", 0o644, b"only this one\n"),
        Entry::File("etc/hello", 0o600, b"hello from the upper layer\n"),
    ])
}

/// An image with the given layers (tar bytes), as an OCI index with an
/// attestation and an arm64 entry beside the amd64 manifest; returns the
/// index's digest and the amd64 manifest's descriptor.
fn image(registry: &FakeRegistry, layers: &[Vec<u8>]) -> (Digest, Descriptor) {
    image_with(registry, layers, |_| {})
}

/// [`image`], with the manifest's JSON changed before it is served.
fn image_with(
    registry: &FakeRegistry,
    layers: &[Vec<u8>],
    edit: impl FnOnce(&mut serde_json::Value),
) -> (Digest, Descriptor) {
    let blobs: Vec<serde_json::Value> = layers
        .iter()
        .map(|tar| {
            let blob = gzip(tar);
            let d = registry.blob(&blob);
            serde_json::json!({"mediaType": GZIP_LAYER, "digest": d.digest, "size": d.size})
        })
        .collect();
    let diff_ids: Vec<String> = layers.iter().map(|tar| sha256(tar)).collect();
    let config = serde_json::to_vec(&serde_json::json!({
        "os": "linux", "architecture": "amd64",
        "rootfs": {"type": "layers", "diff_ids": diff_ids},
        "config": {"Env": ["PATH=/usr/bin:/bin", "LANG=C.UTF-8"]},
    }))
    .unwrap();
    let config = registry.blob(&config);
    let mut manifest = serde_json::json!({
        "schemaVersion": 2, "mediaType": OCI_MANIFEST,
        "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": config.digest, "size": config.size},
        "layers": blobs,
    });
    edit(&mut manifest);
    let manifest = registry.manifest(OCI_MANIFEST, &serde_json::to_vec(&manifest).unwrap());
    let other = registry.manifest(OCI_MANIFEST, b"{\"mediaType\":\"not fetched\"}");
    let index = serde_json::to_vec(&serde_json::json!({
        "schemaVersion": 2, "mediaType": OCI_INDEX,
        "manifests": [
            {"mediaType": OCI_MANIFEST, "digest": other.digest, "size": other.size,
             "platform": {"os": "linux", "architecture": "arm64", "variant": "v8"}},
            {"mediaType": OCI_MANIFEST, "digest": manifest.digest, "size": manifest.size,
             "platform": {"os": "linux", "architecture": "amd64"}},
            {"mediaType": OCI_MANIFEST, "digest": other.digest, "size": other.size,
             "platform": {"os": "unknown", "architecture": "unknown"}},
        ],
    }))
    .unwrap();
    let index = registry.manifest(OCI_INDEX, &index);
    (index.digest.parse().unwrap(), manifest)
}

struct Quiet;
impl Progress for Quiet {
    fn line(&self, _: &str) {}
}

/// More free space than any test needs, whatever the disk running it has.
fn plenty(_: &Path) -> std::io::Result<u64> {
    Ok(u64::MAX)
}

fn reference(digest: &Digest) -> Reference {
    Reference {
        registry: "registry.test".into(),
        repository: "test/image".into(),
        digest: *digest,
    }
}

async fn pull(
    registry: &FakeRegistry,
    directory: &Path,
    mkfs: &Path,
    digest: &Digest,
) -> Result<ImageRecord> {
    let store = Store::open(directory)?;
    Pull {
        store: &store,
        mkfs,
        platform: AMD64,
        progress: &Quiet,
        cancel: Arc::new(AtomicBool::new(false)),
        time_limits: TimeLimits::default(),
        free_space: &plenty,
    }
    .run_at(&reference(digest), client(false)?, registry.base())
    .await
}

fn tool(name: &str) -> Option<PathBuf> {
    let found = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(name))
            .find(|p| p.is_file())
    });
    if found.is_none() {
        let required = std::env::var("CUBE_TEST_LAYER_TOOLS").unwrap_or_default();
        assert!(
            required != "required" && !required.split(',').any(|t| t == name),
            "{name} is required (CUBE_TEST_LAYER_TOOLS={required}) but not in PATH"
        );
        eprintln!("SKIP: {name} not in PATH; this test did NOT run");
    }
    found
}

/// A `mkfs.erofs` that answers `--version` and otherwise only records that it ran.
fn standin_mkfs(directory: &Path) -> (PathBuf, PathBuf) {
    let marker = directory.join("mkfs-ran");
    let program = directory.join("mkfs.erofs");
    fs::write(
        &program,
        format!(
            "#!/bin/sh\n[ \"$1\" = --version ] && {{ echo 'mkfs.erofs (stand-in)'; exit 0; }}\ntouch '{}'\nexit 1\n",
            marker.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
    (program, marker)
}

/// Every file under `directory`, relative.
fn files(directory: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut pending = vec![directory.to_owned()];
    while let Some(dir) = pending.pop() {
        for item in fs::read_dir(&dir).unwrap() {
            let item = item.unwrap();
            if item.file_type().unwrap().is_dir() {
                pending.push(item.path());
            } else {
                found.push(
                    item.path()
                        .strip_prefix(directory)
                        .unwrap()
                        .display()
                        .to_string(),
                );
            }
        }
    }
    found.sort();
    found
}

/// `dump.erofs` prints times in the local zone, so it runs in UTC whatever
/// zone the tests run in (set on the subprocess, not on this process).
fn dump(dump: &Path, image: &Path, arguments: &[&str]) -> String {
    dump_in_zone(dump, image, arguments, "UTC")
}

fn dump_in_zone(dump: &Path, image: &Path, arguments: &[&str], zone: &str) -> String {
    let output = Command::new(dump)
        .env("TZ", zone)
        .args(arguments)
        .arg(image)
        .output()
        .unwrap();
    assert!(output.status.success(), "{arguments:?}: {output:?}");
    String::from_utf8_lossy(&output.stdout).into_owned()
}

#[test]
fn references_are_pinned_and_name_a_registry() {
    let digest = "sha256:7b3ccabffc97de872a30dfd234fd972a66d247c8cfc69b0550f276481852627c";
    let parsed = Reference::parse(&format!("ghcr.io/containerd/busybox:1.36@{digest}")).unwrap();
    assert_eq!(
        (
            parsed.registry.as_str(),
            parsed.repository.as_str(),
            parsed.digest.to_string()
        ),
        ("ghcr.io", "containerd/busybox", digest.to_owned())
    );
    assert_eq!(
        parsed.to_string(),
        format!("ghcr.io/containerd/busybox@{digest}")
    );
    let hub = Reference::parse(&format!("docker.io/debian@{digest}")).unwrap();
    assert_eq!(
        (hub.repository.as_str(), hub.api_host()),
        ("library/debian", "registry-1.docker.io")
    );
    let local = Reference::parse(&format!("localhost:5000/a/b-c__d.e@{digest}")).unwrap();
    assert_eq!(local.repository, "a/b-c__d.e");
    for bad in [
        "ghcr.io/containerd/busybox:1.36".to_owned(),
        "ghcr.io/containerd/busybox@sha256:abc".to_owned(),
        format!("containerd/busybox@{digest}"),
        format!("busybox@{digest}"),
        format!("ghcr.io/Containerd/busybox@{digest}"),
        format!("ghcr.io/containerd/../busybox@{digest}"),
        format!("ghcr.io/containerd//busybox@{digest}"),
        format!("ghcr.io/containerd/busybox:@{digest}"),
        format!("gh/cr.io/x@{digest}"),
        format!("ghcr.io/x@sha512:{}", "0".repeat(128)),
    ] {
        assert!(Reference::parse(&bad).is_err(), "{bad}");
    }
}

#[test]
fn platforms_match_variants_carefully() {
    assert!(AMD64.matches("linux", "amd64", None));
    assert!(!AMD64.matches("linux", "amd64", Some("v3")));
    assert!(!AMD64.matches("linux", "arm64", None));
    assert!(!AMD64.matches("windows", "amd64", None));
    assert!(ARM64.matches("linux", "arm64", Some("v8")));
    assert!(ARM64.matches("linux", "arm64", None));
    assert!(!ARM64.matches("linux", "arm", Some("v7")));
}

#[test]
fn bearer_challenges_are_read_by_name() {
    let challenge =
        "Bearer realm=\"https://ghcr.io/token\",service=\"ghcr.io\",scope=\"repository:a/b:pull\"";
    assert_eq!(
        challenge_field(challenge, "realm"),
        Some("https://ghcr.io/token")
    );
    assert_eq!(challenge_field(challenge, "service"), Some("ghcr.io"));
    assert_eq!(challenge_field("Bearer service=\"x\"", "realm"), None);
}

#[tokio::test]
async fn a_pull_converts_each_layer_once_and_keeps_its_provenance() {
    let Some(mkfs) = tool("mkfs.erofs") else {
        return;
    };
    let (Some(dump_erofs), Some(fsck_erofs)) = (tool("dump.erofs"), tool("fsck.erofs")) else {
        return;
    };
    let registry = FakeRegistry::start().await;
    registry.served.lock().unwrap().token = Some("anonymous-123".into());
    let layers = [base_layer(), upper_layer()];
    let (index, manifest) = image(&registry, &layers);
    let directory = tempfile::tempdir().unwrap();
    let record = pull(&registry, directory.path(), &mkfs, &index)
        .await
        .unwrap();

    assert_eq!(record.digest, index.to_string());
    assert_eq!(record.platform, "linux/amd64");
    assert_eq!(record.manifest, manifest);
    assert_eq!(record.env, ["PATH=/usr/bin:/bin", "LANG=C.UTF-8"]);
    assert_eq!(record.layer_format, LAYER_FORMAT);
    assert!(
        record.mkfs_version.contains("erofs"),
        "{}",
        record.mkfs_version
    );
    assert_eq!(record.layers.len(), 2);
    for (layer, tar) in record.layers.iter().zip(&layers) {
        assert_eq!(layer.diff_id, sha256(tar));
        assert_eq!(layer.blob.digest, sha256(&gzip(tar)));
        assert_eq!(layer.blob.media_type, GZIP_LAYER);
        assert_eq!(layer.tar_bytes, Some(tar.len() as u64));
        assert_eq!(layer.file, format!("layers/1/{}.erofs", layer.diff_id));
        let file = directory.path().join(&layer.file);
        assert_eq!(fs::metadata(&file).unwrap().len(), layer.erofs_bytes);
        assert!(fs::metadata(&file).unwrap().permissions().readonly());
    }
    // The record on disk is the one returned; nothing temporary is left.
    let written: ImageRecord = serde_json::from_slice(
        &fs::read(directory.path().join(format!("images/{index}.json"))).unwrap(),
    )
    .unwrap();
    assert_eq!(written, record);
    let mut expected = vec![format!("images/{index}.json")];
    expected.extend(record.layers.iter().map(|l| l.file.clone()));
    expected.sort();
    assert_eq!(files(directory.path()), expected);
    // The token went to the registry only; the arm64 manifest was not read.
    let requests = registry.requests();
    assert!(requests.iter().any(|(path, _)| path.starts_with("/token?")
        && path.contains("scope=repository%3Atest%2Fimage%3Apull")));
    assert!(
        requests
            .iter()
            .filter(|(path, _)| path.starts_with("/v2/"))
            .any(|(_, auth)| auth.as_deref() == Some("Bearer anonymous-123"))
    );
    assert!(
        !requests
            .iter()
            .any(|(path, _)| path.contains("not fetched"))
    );

    // Metadata as the tar had it, and the upper layer's OCI whiteouts as
    // overlayfs ones (a 0:0 character device; an opaque directory carries
    // its xattr). Mounting them in order is keel's guest (K-4).
    let base = directory.path().join(&record.layers[0].file);
    let tool_info = dump(&dump_erofs, &base, &["--path=/bin/tool"]);
    assert!(tool_info.contains("Uid: 1000   Gid: 1001"), "{tool_info}");
    assert!(tool_info.contains("Links: 2"), "{tool_info}");
    assert!(
        tool_info.contains("Timestamp: 1970-01-01 00:00:00"),
        "{tool_info}"
    );
    let nid = |info: &str| {
        info.lines()
            .find(|l| l.starts_with("NID:"))
            .unwrap()
            .split_whitespace()
            .nth(1)
            .unwrap()
            .to_owned()
    };
    assert_eq!(
        nid(&tool_info),
        nid(&dump(&dump_erofs, &base, &["--path=/bin/hard"]))
    );
    let extracted = directory.path().join("extracted");
    let extract = |image: &Path, name: &str| {
        fs::create_dir_all(&extracted).unwrap();
        let out = extracted.join(name);
        let status = Command::new(&fsck_erofs)
            .arg(format!("--extract={}", out.display()))
            .arg(image)
            .status()
            .unwrap();
        assert!(status.success());
        out
    };
    let base_tree = extract(&base, "base");
    assert_eq!(
        fs::read_link(base_tree.join("bin/link")).unwrap(),
        Path::new("tool")
    );
    assert_eq!(
        fs::read(base_tree.join("bin/tool")).unwrap(),
        b"#!/bin/sh\n"
    );
    let upper = directory.path().join(&record.layers[1].file);
    assert!(dump(&dump_erofs, &upper, &["--path=/etc/gone"]).contains("char dev"));
    assert_eq!(
        fs::read(extract(&upper, "upper").join("etc/hello")).unwrap(),
        b"hello from the upper layer\n"
    );
    fs::remove_dir_all(&extracted).unwrap();
    let opaque = dump(&dump_erofs, &upper, &["--path=/opaque"]);
    assert!(!opaque.contains("Xattr size: 0"), "{opaque}");
    let listing = dump(&dump_erofs, &upper, &["--path=/opaque", "--ls"]);
    assert!(
        listing.contains("new") && !listing.contains(".wh."),
        "{listing}"
    );

    // Again: every layer is cached, no blob is fetched, the record is the
    // same apart from what this pull converted and when.
    let before = registry.requests().len();
    let again = pull(&registry, directory.path(), &mkfs, &index)
        .await
        .unwrap();
    assert!(again.layers.iter().all(|l| l.tar_bytes.is_none()));
    assert!(
        !registry.requests()[before..]
            .iter()
            .any(|(path, _)| path.contains("/blobs/sha256:")
                && record.layers.iter().any(|l| path.ends_with(&l.blob.digest)))
    );
}

#[tokio::test]
async fn a_layer_shared_by_two_images_is_converted_once() {
    let Some(mkfs) = tool("mkfs.erofs") else {
        return;
    };
    let registry = FakeRegistry::start().await;
    let (first, _) = image(&registry, &[base_layer()]);
    let (second, _) = image(&registry, &[base_layer(), upper_layer()]);
    let directory = tempfile::tempdir().unwrap();
    pull(&registry, directory.path(), &mkfs, &first)
        .await
        .unwrap();
    let record = pull(&registry, directory.path(), &mkfs, &second)
        .await
        .unwrap();
    assert_eq!(record.layers[0].tar_bytes, None);
    assert!(record.layers[1].tar_bytes.is_some());
}

/// A registry that answers wrongly in one place; the pull fails, the stand-in
/// mkfs never runs, and nothing is left but empty directories.
async fn refused(change: impl FnOnce(&FakeRegistry, Digest, &Descriptor), expected: &str) {
    let registry = FakeRegistry::start().await;
    let (index, manifest) = image(&registry, &[base_layer()]);
    change(&registry, index, &manifest);
    let directory = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let (mkfs, ran) = standin_mkfs(tools.path());
    let error = pull(&registry, directory.path(), &mkfs, &index)
        .await
        .unwrap_err();
    assert!(format!("{error:#}").contains(expected), "{error:#}");
    assert!(!ran.exists(), "mkfs.erofs ran on unverified data");
    assert_eq!(files(directory.path()), Vec::<String>::new());
}

fn layer_path(registry: &FakeRegistry, manifest: &Descriptor) -> (String, Descriptor) {
    let served = registry.served.lock().unwrap();
    let body = &served.routes[&format!("/v2/test/image/manifests/{}", manifest.digest)].body;
    let document: serde_json::Value = serde_json::from_slice(body).unwrap();
    let layer: Descriptor = serde_json::from_value(document["layers"][0].clone()).unwrap();
    (format!("/v2/test/image/blobs/{}", layer.digest), layer)
}

#[tokio::test]
async fn an_index_whose_bytes_do_not_match_its_digest_is_refused() {
    refused(
        |registry, index, _| {
            let path = format!("/v2/test/image/manifests/{index}");
            let mut answer = registry.served.lock().unwrap().routes[&path].clone();
            answer.body.push(b' ');
            registry.route(&path, answer);
        },
        "the registry's bytes hash to",
    )
    .await;
}

#[tokio::test]
async fn a_manifest_whose_bytes_do_not_match_the_index_is_refused() {
    refused(
        |registry, _, manifest| {
            let path = format!("/v2/test/image/manifests/{}", manifest.digest);
            registry.route(
                &path,
                Answer::ok(OCI_MANIFEST, b"{\"mediaType\":\"x\"}".to_vec()),
            );
        },
        "the registry's bytes hash to",
    )
    .await;
}

#[tokio::test]
async fn a_layer_blob_with_other_bytes_is_refused_before_conversion() {
    refused(
        |registry, _, manifest| {
            let (path, layer) = layer_path(registry, manifest);
            let mut body = registry.served.lock().unwrap().routes[&path].body.clone();
            let middle = body.len() / 2;
            body[middle] ^= 0xff;
            assert_eq!(body.len() as u64, layer.size);
            registry.route(&path, Answer::ok("application/octet-stream", body));
        },
        "the bytes received hash to",
    )
    .await;
}

#[tokio::test]
async fn a_layer_blob_longer_than_its_descriptor_is_refused() {
    refused(
        |registry, _, manifest| {
            let (path, _) = layer_path(registry, manifest);
            let mut answer = registry.served.lock().unwrap().routes[&path].clone();
            answer.body.extend_from_slice(&[0; 100]);
            registry.route(&path, answer);
        },
        "the descriptor says",
    )
    .await;
}

#[tokio::test]
async fn a_layer_whose_tar_is_not_its_diff_id_is_not_published() {
    let Some(mkfs) = tool("mkfs.erofs") else {
        return;
    };
    let registry = FakeRegistry::start().await;
    // The config claims the upper layer's diff_id for the base layer's blob:
    // every blob checks out, the uncompressed tar does not.
    let blob = gzip(&base_layer());
    let layer = registry.blob(&blob);
    let config = serde_json::to_vec(&serde_json::json!({
        "os": "linux", "architecture": "amd64",
        "rootfs": {"type": "layers", "diff_ids": [sha256(&upper_layer())]},
    }))
    .unwrap();
    let config = registry.blob(&config);
    let manifest = serde_json::to_vec(&serde_json::json!({
        "schemaVersion": 2, "mediaType": OCI_MANIFEST,
        "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": config.digest, "size": config.size},
        "layers": [{"mediaType": GZIP_LAYER, "digest": layer.digest, "size": layer.size}],
    }))
    .unwrap();
    let manifest = registry.manifest(OCI_MANIFEST, &manifest);
    let directory = tempfile::tempdir().unwrap();
    let error = pull(
        &registry,
        directory.path(),
        &mkfs,
        &manifest.digest.parse().unwrap(),
    )
    .await
    .unwrap_err();
    assert!(
        format!("{error:#}").contains("but the image says"),
        "{error:#}"
    );
    assert_eq!(files(directory.path()), Vec::<String>::new());
}

#[tokio::test]
async fn a_manifest_for_another_platform_is_refused() {
    let registry = FakeRegistry::start().await;
    let (_, manifest) = image(&registry, &[base_layer()]);
    // The manifest pinned directly: its configuration says amd64.
    let directory = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let (mkfs, ran) = standin_mkfs(tools.path());
    let store = Store::open(directory.path()).unwrap();
    let error = Pull {
        store: &store,
        mkfs: &mkfs,
        platform: ARM64,
        progress: &Quiet,
        cancel: Arc::new(AtomicBool::new(false)),
        time_limits: TimeLimits::default(),
        free_space: &plenty,
    }
    .run_at(
        &reference(&manifest.digest.parse().unwrap()),
        client(false).unwrap(),
        registry.base(),
    )
    .await
    .unwrap_err();
    assert!(
        format!("{error:#}").contains("this runner needs linux/arm64"),
        "{error:#}"
    );
    assert!(!ran.exists());
}

#[tokio::test]
async fn an_index_without_this_platform_or_with_two_is_refused() {
    let registry = FakeRegistry::start().await;
    let (_, manifest) = image(&registry, &[base_layer()]);
    let entry = |arch: &str, variant: Option<&str>| {
        serde_json::json!({"mediaType": OCI_MANIFEST, "digest": manifest.digest, "size": manifest.size,
            "platform": {"os": "linux", "architecture": arch, "variant": variant}})
    };
    for (entries, expected) in [
        (
            vec![entry("arm64", Some("v8")), entry("amd64", Some("v3"))],
            "has no linux/amd64 image",
        ),
        (
            vec![entry("amd64", None), entry("amd64", None)],
            "has 2 linux/amd64 images",
        ),
    ] {
        let index = serde_json::to_vec(
            &serde_json::json!({"schemaVersion": 2, "mediaType": OCI_INDEX, "manifests": entries}),
        )
        .unwrap();
        let index = registry.manifest(OCI_INDEX, &index);
        let directory = tempfile::tempdir().unwrap();
        let tools = tempfile::tempdir().unwrap();
        let (mkfs, _) = standin_mkfs(tools.path());
        let error = pull(
            &registry,
            directory.path(),
            &mkfs,
            &index.digest.parse().unwrap(),
        )
        .await
        .unwrap_err();
        assert!(format!("{error:#}").contains(expected), "{error:#}");
    }
}

#[tokio::test]
async fn foreign_layers_and_unknown_media_types_are_refused() {
    for (field, value, expected) in [
        (
            "urls",
            serde_json::json!(["https://elsewhere.test/layer"]),
            "foreign layer",
        ),
        (
            "mediaType",
            serde_json::json!("application/vnd.oci.image.layer.nondistributable.v1.tar+gzip"),
            "unsupported layer media type",
        ),
    ] {
        let registry = FakeRegistry::start().await;
        let (index, _) = image_with(&registry, &[base_layer()], |manifest| {
            manifest["layers"][0][field] = value.clone();
        });
        let directory = tempfile::tempdir().unwrap();
        let tools = tempfile::tempdir().unwrap();
        let (mkfs, ran) = standin_mkfs(tools.path());
        let error = pull(&registry, directory.path(), &mkfs, &index)
            .await
            .unwrap_err();
        assert!(format!("{error:#}").contains(expected), "{error:#}");
        assert!(!ran.exists());
        // Refused before any layer blob was asked for.
        assert!(
            !registry
                .requests()
                .iter()
                .any(|(path, _)| path.contains(&sha256(&gzip(&base_layer()))))
        );
    }
}

#[tokio::test]
async fn a_private_image_is_reported_as_one() {
    let registry = FakeRegistry::start().await;
    let (index, _) = image(&registry, &[base_layer()]);
    // The anonymous token the registry hands out does not open the image.
    registry.served.lock().unwrap().token = Some("only-with-credentials".into());
    registry.route(
        "/token",
        Answer::ok("application/json", b"{\"token\":\"anonymous\"}".to_vec()),
    );
    let directory = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let (mkfs, _) = standin_mkfs(tools.path());
    let error = pull(&registry, directory.path(), &mkfs, &index)
        .await
        .unwrap_err();
    assert!(
        format!("{error:#}").contains("only public images"),
        "{error:#}"
    );
    assert!(!format!("{error:#}").contains("anonymous\""), "{error:#}");
}

#[tokio::test]
async fn the_token_does_not_follow_a_redirect_to_another_host() {
    let Some(mkfs) = tool("mkfs.erofs") else {
        return;
    };
    let registry = FakeRegistry::start().await;
    registry.served.lock().unwrap().token = Some("anonymous-456".into());
    let (index, manifest) = image(&registry, &[base_layer()]);
    // The layer blob is a redirect to "localhost", another host than
    // 127.0.0.1, as registries send blobs to a CDN.
    let (path, _) = layer_path(&registry, &manifest);
    let answer = registry.served.lock().unwrap().routes[&path].clone();
    registry.route("/cdn/layer", answer);
    registry.route(
        &path,
        Answer {
            status: 307,
            headers: vec![(
                "Location".into(),
                format!("http://localhost:{}/cdn/layer", registry.port),
            )],
            body: Vec::new(),
        },
    );
    let directory = tempfile::tempdir().unwrap();
    pull(&registry, directory.path(), &mkfs, &index)
        .await
        .unwrap();
    let requests = registry.requests();
    let cdn: Vec<_> = requests.iter().filter(|(p, _)| p == "/cdn/layer").collect();
    assert_eq!(cdn.len(), 1);
    assert_eq!(cdn[0].1, None, "the token went to the CDN");
}

#[tokio::test]
async fn production_pulls_refuse_plain_http() {
    let registry = FakeRegistry::start().await;
    let (index, _) = image(&registry, &[base_layer()]);
    let directory = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let (mkfs, _) = standin_mkfs(tools.path());
    let store = Store::open(directory.path()).unwrap();
    let error = Pull {
        store: &store,
        mkfs: &mkfs,
        platform: AMD64,
        progress: &Quiet,
        cancel: Arc::new(AtomicBool::new(false)),
        time_limits: TimeLimits::default(),
        free_space: &plenty,
    }
    .run_at(&reference(&index), client(true).unwrap(), registry.base())
    .await
    .unwrap_err();
    assert!(registry.requests().is_empty(), "{error:#}");
}

#[tokio::test]
async fn a_crashed_pull_leaves_nothing_the_next_one_trusts() {
    let Some(mkfs) = tool("mkfs.erofs") else {
        return;
    };
    let registry = FakeRegistry::start().await;
    let (index, _) = image(&registry, &[base_layer()]);
    let directory = tempfile::tempdir().unwrap();
    // What a crash leaves: a partial blob and a partial layer.
    let store = Store::open(directory.path()).unwrap();
    fs::write(store.images().join(".tmp-0123-99"), b"partial").unwrap();
    fs::write(
        layer_dir(directory.path()).join(".tmp-0123-99-0"),
        b"partial",
    )
    .unwrap();
    drop(store);
    let record = pull(&registry, directory.path(), &mkfs, &index)
        .await
        .unwrap();
    let mut expected = vec![
        format!("images/{index}.json"),
        record.layers[0].file.clone(),
    ];
    expected.sort();
    assert_eq!(files(directory.path()), expected);
}

#[tokio::test]
async fn a_cancelled_pull_stops_and_leaves_nothing() {
    let registry = FakeRegistry::start().await;
    let (index, _) = image(&registry, &[base_layer()]);
    let directory = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let (mkfs, ran) = standin_mkfs(tools.path());
    let store = Store::open(directory.path()).unwrap();
    let error = Pull {
        store: &store,
        mkfs: &mkfs,
        platform: AMD64,
        progress: &Quiet,
        cancel: Arc::new(AtomicBool::new(true)),
        time_limits: TimeLimits::default(),
        free_space: &plenty,
    }
    .run_at(&reference(&index), client(false).unwrap(), registry.base())
    .await
    .unwrap_err();
    assert!(format!("{error:#}").contains("cancelled"), "{error:#}");
    assert!(!ran.exists());
    assert_eq!(files(directory.path()), Vec::<String>::new());
}

#[tokio::test]
async fn layer_times_are_read_as_0_in_utc_in_any_local_zone() {
    let (Some(mkfs), Some(dump_erofs)) = (tool("mkfs.erofs"), tool("dump.erofs")) else {
        return;
    };
    let registry = FakeRegistry::start().await;
    let (index, _) = image(&registry, &[base_layer()]);
    let directory = tempfile::tempdir().unwrap();
    let record = pull(&registry, directory.path(), &mkfs, &index)
        .await
        .unwrap();
    let layer = directory.path().join(&record.layers[0].file);
    // The same time 0 shown in a zone one hour east (POSIX TZ, no tzdata
    // needed), as on a host in CET: the helper reads it in UTC anyway.
    let east = dump_in_zone(&dump_erofs, &layer, &["--path=/etc/hello"], "CET-1");
    assert!(east.contains("Timestamp: 1970-01-01 01:00:00"), "{east}");
    let shown = dump(&dump_erofs, &layer, &["--path=/etc/hello"]);
    assert!(shown.contains("Timestamp: 1970-01-01 00:00:00"), "{shown}");
}

// ---------------------------------------------------------------- B-7

/// A pull with these free-space answers; everything else as `pull`.
async fn pull_with(
    registry: &FakeRegistry,
    directory: &Path,
    mkfs: &Path,
    digest: &Digest,
    time_limits: TimeLimits,
    free_space: &dyn Fn(&Path) -> std::io::Result<u64>,
) -> Result<ImageRecord> {
    let store = Store::open(directory)?;
    let mut pull = Pull::new(
        &store,
        mkfs,
        AMD64,
        &Quiet,
        Arc::new(AtomicBool::new(false)),
    );
    pull.time_limits = time_limits;
    pull.free_space = free_space;
    pull.run_at(&reference(digest), client(false)?, registry.base())
        .await
}

/// `berth vm`'s start: [`Pull::ensure`] against the fake registry.
async fn ensure(
    registry: &FakeRegistry,
    directory: &Path,
    mkfs: &Path,
    digest: &Digest,
) -> Result<ImageRecord> {
    let store = Store::open(directory)?;
    let mut pull = Pull::new(
        &store,
        mkfs,
        AMD64,
        &Quiet,
        Arc::new(AtomicBool::new(false)),
    );
    pull.free_space = &plenty;
    pull.ensure_at(&reference(digest), client(false)?, registry.base())
        .await
}

fn blob_requests(registry: &FakeRegistry) -> Vec<String> {
    registry
        .requests()
        .into_iter()
        .map(|(path, _)| path)
        .filter(|path| path.contains("/blobs/"))
        .collect()
}

#[test]
fn a_blob_needs_three_times_its_size_and_2_gib_free() {
    assert_eq!(free_needed(0), 2 << 30);
    assert_eq!(free_needed(1 << 30), 5 << 30);
    assert_eq!(free_needed(100), 300 + (2 << 30));
    assert_eq!(free_needed(u64::MAX), u64::MAX);
}

#[test]
fn free_space_is_read_from_the_file_system() {
    let directory = tempfile::tempdir().unwrap();
    let free = free_bytes(directory.path()).unwrap();
    assert!(free > 0, "{free}");
    assert!(free_bytes(&directory.path().join("missing")).is_err());
}

#[tokio::test]
async fn a_blob_without_room_is_refused_before_it_is_fetched() {
    let registry = FakeRegistry::start().await;
    let (index, manifest) = image(&registry, &[base_layer()]);
    let (blob_path, layer) = layer_path(&registry, &manifest);
    let needed = free_needed(layer.size);
    let directory = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let (mkfs, ran) = standin_mkfs(tools.path());
    for short in ["images", "1"] {
        let asked = Mutex::new(Vec::new());
        let free = |path: &Path| {
            asked.lock().unwrap().push(path.to_owned());
            let name = path.file_name().unwrap().to_str().unwrap();
            Ok(if name == short { needed - 1 } else { needed })
        };
        let error = pull_with(
            &registry,
            directory.path(),
            &mkfs,
            &index,
            TimeLimits::default(),
            &free,
        )
        .await
        .unwrap_err();
        let message = format!("{error:#}");
        assert!(
            message.contains(&format!("{} bytes free", needed - 1))
                && message.contains("3 × its size + 2 GiB"),
            "{message}"
        );
        assert!(!asked.lock().unwrap().is_empty());
        assert!(!ran.exists(), "mkfs.erofs ran");
        assert!(
            !registry
                .requests()
                .iter()
                .any(|(path, _)| path == &blob_path),
            "the blob was fetched"
        );
        assert_eq!(files(directory.path()), Vec::<String>::new());
    }
    // Exactly enough in both: the blob is fetched (and the stand-in fails).
    let asked = Mutex::new(Vec::new());
    let exactly = |path: &Path| {
        asked.lock().unwrap().push(path.to_owned());
        Ok(needed)
    };
    let error = pull_with(
        &registry,
        directory.path(),
        &mkfs,
        &index,
        TimeLimits::default(),
        &exactly,
    )
    .await
    .unwrap_err();
    assert!(ran.exists(), "{error:#}");
    assert!(
        registry
            .requests()
            .iter()
            .any(|(path, _)| path == &blob_path)
    );
    let asked: Vec<String> = asked
        .lock()
        .unwrap()
        .iter()
        .map(|p| {
            p.strip_prefix(directory.path())
                .unwrap()
                .display()
                .to_string()
        })
        .collect();
    assert_eq!(asked, ["images", "layers/1"], "both places are checked");
    assert_eq!(files(directory.path()), Vec::<String>::new());
}

#[tokio::test]
async fn a_pull_stops_at_the_first_layer_without_room_and_the_next_one_goes_on() {
    let Some(mkfs) = tool("mkfs.erofs") else {
        return;
    };
    let registry = FakeRegistry::start().await;
    let (index, _) = image(&registry, &[base_layer(), upper_layer()]);
    let directory = tempfile::tempdir().unwrap();
    // Room for the first layer's blob only (both places are asked per blob).
    let calls = Mutex::new(0);
    let shrinking = |_: &Path| {
        let mut calls = calls.lock().unwrap();
        *calls += 1;
        Ok(if *calls <= 2 { u64::MAX } else { 0 })
    };
    let error = pull_with(
        &registry,
        directory.path(),
        &mkfs,
        &index,
        TimeLimits::default(),
        &shrinking,
    )
    .await
    .unwrap_err();
    assert!(format!("{error:#}").contains("layer 2"), "{error:#}");
    let after_first = files(directory.path());
    assert_eq!(
        after_first.len(),
        1,
        "one layer, no record: {after_first:?}"
    );
    assert!(after_first[0].starts_with("layers/1/sha256:"));
    let layer_blobs = |record: Option<&ImageRecord>| {
        let all = blob_requests(&registry);
        record.map_or(all.len(), |record| {
            let layers: Vec<String> = record
                .layers
                .iter()
                .map(|l| format!("/v2/test/image/blobs/{}", l.blob.digest))
                .collect();
            all.iter().filter(|path| layers.contains(path)).count()
        })
    };
    assert_eq!(layer_blobs(None), 2, "the config and the first layer");
    // With room, the next pull fetches only the second layer.
    let record = pull(&registry, directory.path(), &mkfs, &index)
        .await
        .unwrap();
    assert_eq!(layer_blobs(Some(&record)), 2, "each layer once");
    assert!(record.layers[0].tar_bytes.is_none() && record.layers[1].tar_bytes.is_some());
}

/// The record and two layers, written by hand (no mkfs.erofs needed): what
/// [`Store::cached`] reads.
fn fake_pulled(directory: &Path) -> (Reference, ImageRecord) {
    let store = Store::open(directory).unwrap();
    let digest: Digest = sha256(b"index").parse().unwrap();
    let mut layers = Vec::new();
    for n in [1u8, 2] {
        let diff_id = DiffId::from_bytes([n; 32]);
        let path = store
            .cache
            .publish(&diff_id, |out| Ok(fs::write(out, [n; 64])?))
            .unwrap();
        layers.push(LayerRecord {
            diff_id: diff_id.to_string(),
            blob: Descriptor {
                media_type: GZIP_LAYER.into(),
                digest: sha256(&[n]),
                size: 1,
            },
            file: path.strip_prefix(directory).unwrap().display().to_string(),
            erofs_bytes: 64,
            tar_bytes: None,
        });
    }
    let descriptor = Descriptor {
        media_type: OCI_MANIFEST.into(),
        digest: sha256(b"manifest"),
        size: 8,
    };
    let record = ImageRecord {
        version: RECORD_VERSION,
        reference: reference(&digest).to_string(),
        registry: "registry.test".into(),
        repository: "test/image".into(),
        digest: digest.to_string(),
        platform: AMD64.to_string(),
        manifest: descriptor.clone(),
        config: descriptor,
        env: Vec::new(),
        layers,
        layer_format: LAYER_FORMAT,
        mkfs: "/m".into(),
        mkfs_version: "mkfs.erofs 1".into(),
        resolved_at: 0,
    };
    write_record(&store.record_path(&digest), &record).unwrap();
    (reference(&digest), record)
}

#[test]
fn an_image_is_cached_only_with_its_record_and_every_layer() {
    let directory = tempfile::tempdir().unwrap();
    let (reference, record) = fake_pulled(directory.path());
    let store = Store::open(directory.path()).unwrap();
    assert_eq!(store.cached(&reference, AMD64).unwrap(), Ok(record));
    // Another platform's runner, the same directory: not this image.
    let other = store.cached(&reference, ARM64).unwrap().unwrap_err();
    assert!(other.contains("linux/amd64"), "{other}");
    // A layer the cache lost (an eviction, a hand): pulled again.
    let lost = directory
        .path()
        .join(format!("layers/1/{}.erofs", DiffId::from_bytes([2; 32])));
    fs::remove_file(&lost).unwrap();
    let missing = store.cached(&reference, AMD64).unwrap().unwrap_err();
    assert!(
        missing.contains(&format!("layer {}", DiffId::from_bytes([2; 32]))),
        "{missing}"
    );
    // A layer named outside the cache is not trusted.
    let path = store.record_path(&reference.digest);
    let mut text: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    text["layers"][1]["file"] = "../elsewhere.erofs".into();
    fs::write(&path, text.to_string()).unwrap();
    let outside = store.cached(&reference, AMD64).unwrap().unwrap_err();
    assert!(outside.contains("not in the cache"), "{outside}");
    // A record that is not one, and none.
    fs::write(&path, b"{").unwrap();
    let broken = store.cached(&reference, AMD64).unwrap().unwrap_err();
    assert!(broken.contains("is not an image record"), "{broken}");
    fs::remove_file(&path).unwrap();
    let none = store.cached(&reference, AMD64).unwrap().unwrap_err();
    assert!(none.starts_with("no record of"), "{none}");
}

#[tokio::test]
async fn a_start_with_everything_cached_asks_the_registry_nothing() {
    let registry = FakeRegistry::start().await;
    let directory = tempfile::tempdir().unwrap();
    let (reference, record) = fake_pulled(directory.path());
    let tools = tempfile::tempdir().unwrap();
    let (mkfs, ran) = standin_mkfs(tools.path());
    let store = Store::open(directory.path()).unwrap();
    let mut pull = Pull::new(
        &store,
        &mkfs,
        AMD64,
        &Quiet,
        Arc::new(AtomicBool::new(false)),
    );
    pull.free_space = &plenty;
    let ensured = pull
        .ensure_at(&reference, client(false).unwrap(), registry.base())
        .await
        .unwrap();
    assert_eq!(ensured, record);
    assert!(registry.requests().is_empty(), "{:?}", registry.requests());
    assert!(!ran.exists());
}

#[tokio::test]
async fn a_start_fetches_again_only_the_layer_the_cache_lost() {
    let Some(mkfs) = tool("mkfs.erofs") else {
        return;
    };
    let registry = FakeRegistry::start().await;
    let (index, _) = image(&registry, &[base_layer(), upper_layer()]);
    let directory = tempfile::tempdir().unwrap();
    // A cold start pulls everything.
    let first = ensure(&registry, directory.path(), &mkfs, &index)
        .await
        .unwrap();
    assert_eq!(blob_requests(&registry).len(), 3, "config and two layers");
    let bytes: Vec<Vec<u8>> = first
        .layers
        .iter()
        .map(|l| fs::read(directory.path().join(&l.file)).unwrap())
        .collect();
    // A warm one asks nothing.
    let before = registry.requests().len();
    let warm = ensure(&registry, directory.path(), &mkfs, &index)
        .await
        .unwrap();
    assert_eq!(registry.requests().len(), before);
    assert_eq!(warm, first);
    // Without the bottom layer's file: that blob again, the same bytes.
    fs::remove_file(directory.path().join(&first.layers[0].file)).unwrap();
    let again = ensure(&registry, directory.path(), &mkfs, &index)
        .await
        .unwrap();
    let new_blobs: Vec<String> = blob_requests(&registry).split_off(3);
    assert_eq!(
        new_blobs,
        [
            format!("/v2/test/image/blobs/{}", first.config.digest),
            format!("/v2/test/image/blobs/{}", first.layers[0].blob.digest),
        ]
    );
    assert!(again.layers[0].tar_bytes.is_some() && again.layers[1].tar_bytes.is_none());
    for (layer, bytes) in again.layers.iter().zip(&bytes) {
        assert_eq!(
            &fs::read(directory.path().join(&layer.file)).unwrap(),
            bytes
        );
    }
}

/// A server that answers a GET with headers for 100 bytes, then sends one
/// byte every 100 ms; or, with `silent`, accepts and never answers.
async fn slow_server(silent: bool) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            tokio::spawn(async move {
                let mut buffer = [0u8; 4096];
                let _ = stream.read(&mut buffer).await;
                if silent {
                    tokio::time::sleep(Duration::from_secs(600)).await;
                    return;
                }
                let _ = stream
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n")
                    .await;
                for _ in 0..100 {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    if stream.write_all(b"x").await.is_err() {
                        return;
                    }
                }
            });
        }
    });
    format!("http://127.0.0.1:{port}")
}

#[tokio::test]
async fn a_document_that_drips_is_stopped_by_its_deadline_or_a_cancel() {
    let base = slow_server(false).await;
    let client = client(false).unwrap();
    // The deadline: well before the drip would end (10 s).
    let response = client.get(&base).send().await.unwrap();
    let started = Instant::now();
    let cancel = AtomicBool::new(false);
    let error = read_bounded(
        response,
        1000,
        "the doc",
        &cancel,
        Duration::from_millis(300),
    )
    .await
    .unwrap_err();
    assert!(
        format!("{error:#}").contains("the doc: not all of it arrived within 0.3 s"),
        "{error:#}"
    );
    assert!(started.elapsed() < Duration::from_secs(3));
    // A cancel: at once, though the deadline and read timeout are far.
    let response = client.get(&base).send().await.unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let setter = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        setter.store(true, Ordering::SeqCst);
    });
    let started = Instant::now();
    let error = read_bounded(response, 1000, "the doc", &cancel, DOCUMENT_DEADLINE)
        .await
        .unwrap_err();
    assert_eq!(format!("{error:#}"), "cancelled");
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn a_cancel_stops_a_pull_waiting_on_a_silent_registry() {
    let base = slow_server(true).await;
    let directory = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    let (mkfs, ran) = standin_mkfs(tools.path());
    let store = Store::open(directory.path()).unwrap();
    let cancel = Arc::new(AtomicBool::new(false));
    let setter = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(300)).await;
        setter.store(true, Ordering::SeqCst);
    });
    let digest: Digest = sha256(b"index").parse().unwrap();
    let started = Instant::now();
    let error = Pull::new(&store, &mkfs, AMD64, &Quiet, cancel)
        .run_at(&reference(&digest), client(false).unwrap(), base)
        .await
        .unwrap_err();
    assert_eq!(format!("{error:#}"), "cancelled");
    // READ_TIMEOUT is 60 s; the cancel needs no read to end.
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(!ran.exists());
    assert_eq!(files(directory.path()), Vec::<String>::new());
}

#[test]
fn runner_pulls_give_mkfs_60_s_and_60_s_per_gib() {
    assert_eq!(RUNNER_TIME_LIMITS.finish, Duration::from_secs(60));
    assert_eq!(RUNNER_TIME_LIMITS.finish_per_gib, Duration::from_secs(60));
    assert_eq!(RUNNER_TIME_LIMITS.stall, TimeLimits::default().stall);
    assert!(TimeLimits::default().finish > RUNNER_TIME_LIMITS.finish);
}

#[tokio::test]
async fn a_pull_kills_mkfs_at_its_time_limit_and_publishes_nothing() {
    let registry = FakeRegistry::start().await;
    let (index, _) = image(&registry, &[base_layer()]);
    let directory = tempfile::tempdir().unwrap();
    let tools = tempfile::tempdir().unwrap();
    // Reads its whole input, then never exits (as erofs-utils < 1.9.1 on a
    // crafted tar).
    let pid = tools.path().join("pid");
    let mkfs = tools.path().join("mkfs.erofs");
    fs::write(
        &mkfs,
        format!(
            "#!/bin/sh\n[ \"$1\" = --version ] && {{ echo 'mkfs.erofs (stand-in)'; exit 0; }}\necho $$ > '{}'\ncat > /dev/null\nexec sleep 600\n",
            pid.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&mkfs, fs::Permissions::from_mode(0o755)).unwrap();
    let limits = TimeLimits {
        finish: Duration::from_secs(1),
        finish_per_gib: Duration::ZERO,
        ..RUNNER_TIME_LIMITS
    };
    let started = Instant::now();
    let error = tokio::time::timeout(
        Duration::from_secs(30),
        pull_with(&registry, directory.path(), &mkfs, &index, limits, &plenty),
    )
    .await
    .expect("the pull's time limit was not used")
    .unwrap_err();
    assert!(
        format!("{error:#}").contains("did not finish within 1 s after its input ended"),
        "{error:#}"
    );
    assert!(started.elapsed() < Duration::from_secs(20));
    let pid: i32 = fs::read_to_string(&pid).unwrap().trim().parse().unwrap();
    // SAFETY: signal 0 only asks whether the process exists.
    assert_ne!(
        unsafe { libc::kill(pid, 0) },
        0,
        "mkfs.erofs {pid} still runs"
    );
    assert_eq!(files(directory.path()), Vec::<String>::new());
}
