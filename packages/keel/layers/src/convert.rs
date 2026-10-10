//! One OCI layer to one EROFS file, the way containerd's EROFS differ does
//! it: decompress the blob as a stream, hash the uncompressed tar on the way
//! to check the `diff_id`, and pipe it into `mkfs.erofs` with `--aufs`, so
//! OCI whiteouts become overlayfs whiteouts and each file is a valid
//! overlayfs lower layer. `-T0` and a UUID derived from the `diff_id` make
//! the same layer give the same bytes every time: with a tar as input, `-T0`
//! sets the build time and every file's time to 0 on erofs-utils 1.7 and
//! later. (1.8 added `--all-time` for the same; 1.7.1, Ubuntu 24.04's, does
//! not know it, and on 1.8.6 the image is byte-identical without it.)
//!
//! Two forms (U5 in the masterplan; the numbers are in this package's
//! README):
//!
//! - [`TarMode::Full`] (`--tar=f`): a complete image, LZ4HC-compressed, 4 KiB
//!   blocks. Always `-b4096`: on Apple Silicon the default follows the host's
//!   16 KiB pages and a 4 KiB guest kernel rejects it.
//! - [`TarMode::Index`] (`--tar=i`): only the metadata, with 512-byte blocks
//!   that point into the tar; the tar itself is appended after it, so the
//!   file is the index followed by the uncompressed tar.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufWriter, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::thread::{self, JoinHandle};

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};

use crate::DiffId;

/// How a layer blob is compressed, from its OCI or Docker media type.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Compression {
    None,
    Gzip,
    Zstd,
}

impl Compression {
    pub fn from_media_type(media_type: &str) -> Result<Self> {
        Ok(match media_type {
            "application/vnd.oci.image.layer.v1.tar" => Self::None,
            "application/vnd.oci.image.layer.v1.tar+gzip"
            | "application/vnd.docker.image.rootfs.diff.tar.gzip" => Self::Gzip,
            "application/vnd.oci.image.layer.v1.tar+zstd" => Self::Zstd,
            other => bail!("unsupported layer media type {other:?}"),
        })
    }

    fn reader<'a>(self, blob: impl Read + 'a) -> Result<Box<dyn Read + 'a>> {
        Ok(match self {
            Self::None => Box::new(blob),
            // An OCI gzip layer may be several members back to back.
            Self::Gzip => Box::new(flate2::read::MultiGzDecoder::new(blob)),
            // Several frames and skippable frames (zstd:chunked) are allowed.
            Self::Zstd => Box::new(zstd::stream::read::Decoder::new(blob)?),
        })
    }
}

/// `mkfs.erofs --tar=f` or `--tar=i`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TarMode {
    Full,
    Index,
}

/// The `mkfs.erofs` the runner was given. Like QEMU, it is a path the caller
/// chooses; this crate never searches for one.
#[derive(Clone, Debug)]
pub struct Mkfs {
    program: PathBuf,
}

impl Mkfs {
    pub fn new(program: impl Into<PathBuf>) -> Self {
        Self {
            program: program.into(),
        }
    }

    pub fn program(&self) -> &Path {
        &self.program
    }

    /// The arguments for one conversion, without the output path.
    pub fn arguments(mode: TarMode, diff_id: &DiffId) -> Vec<String> {
        let mode_arguments: &[&str] = match mode {
            TarMode::Full => &["-b4096", "-zlz4hc", "--tar=f"],
            TarMode::Index => &["--tar=i"],
        };
        let mut arguments: Vec<String> = mode_arguments.iter().map(|a| a.to_string()).collect();
        arguments.extend(["-T0", "--aufs", "-U"].map(String::from));
        arguments.push(uuid(diff_id));
        arguments
    }
}

/// What one conversion read and wrote.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Converted {
    /// Bytes of the uncompressed tar.
    pub tar_bytes: u64,
    /// Bytes of the EROFS file (for [`TarMode::Index`], index and tar).
    pub image_bytes: u64,
}

/// Converts one layer blob into an EROFS file at `out`, which must not exist.
/// Fails, leaving nothing at `out`, if the uncompressed tar's digest is not
/// `diff_id` or `mkfs.erofs` fails. The caller publishes the file (see
/// [`crate::cache::LayerCache`]).
pub fn convert(
    mkfs: &Mkfs,
    mode: TarMode,
    blob: impl Read,
    compression: Compression,
    diff_id: &DiffId,
    out: &Path,
) -> Result<Converted> {
    let result = convert_inner(mkfs, mode, blob, compression, diff_id, out);
    if result.is_err() {
        let _ = fs::remove_file(out);
        let _ = fs::remove_file(sidecar(out));
    }
    result
}

fn convert_inner(
    mkfs: &Mkfs,
    mode: TarMode,
    blob: impl Read,
    compression: Compression,
    diff_id: &DiffId,
    out: &Path,
) -> Result<Converted> {
    if out.exists() {
        bail!("{} already exists", out.display());
    }
    // `--tar=i` writes only the index; the tar it points into is kept here
    // and appended once mkfs.erofs is done.
    let mut tar_copy = match mode {
        TarMode::Full => None,
        TarMode::Index => Some(BufWriter::new(create_new(&sidecar(out))?)),
    };
    let mut child = Command::new(mkfs.program())
        .args(Mkfs::arguments(mode, diff_id))
        .arg(out)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("start {}", mkfs.program().display()))?;
    let output = Output::collect(&mut child);
    let mut stdin = child.stdin.take();

    let mut tar = compression.reader(blob)?;
    let mut hasher = Sha256::new();
    let mut tar_bytes = 0u64;
    let mut buffer = vec![0u8; 1 << 20];
    let read_result: Result<()> = (|| {
        loop {
            let n = match tar.read(&mut buffer) {
                Ok(0) => return Ok(()),
                Ok(n) => n,
                Err(e) if e.kind() == ErrorKind::Interrupted => continue,
                Err(e) => return Err(e).context("read the layer"),
            };
            let chunk = &buffer[..n];
            hasher.update(chunk);
            tar_bytes += n as u64;
            if let Some(copy) = tar_copy.as_mut() {
                copy.write_all(chunk).context("keep the tar")?;
            }
            if let Some(pipe) = stdin.as_mut() {
                // mkfs.erofs may stop reading at the end-of-archive blocks;
                // the rest of the stream still counts for the digest.
                if let Err(e) = pipe.write_all(chunk) {
                    if e.kind() != ErrorKind::BrokenPipe {
                        return Err(e).context("write to mkfs.erofs");
                    }
                    stdin = None;
                }
            }
        }
    })();
    drop(stdin);
    let status = child.wait().context("wait for mkfs.erofs")?;
    let log = output.finish();
    read_result?;
    if !status.success() {
        bail!(
            "{} failed ({status}): {}",
            mkfs.program().display(),
            log.trim()
        );
    }
    let digest: [u8; 32] = hasher.finalize().into();
    if &digest != diff_id.as_bytes() {
        bail!(
            "layer digest is {} but the image says {diff_id}",
            DiffId::from_bytes(digest)
        );
    }

    if let Some(copy) = tar_copy {
        let copy = copy
            .into_inner()
            .map_err(|e| e.into_error())
            .context("keep the tar")?;
        drop(copy);
        let index_bytes = fs::metadata(out)?.len();
        if index_bytes % 512 != 0 {
            bail!("mkfs.erofs --tar=i wrote {index_bytes} bytes, not whole 512-byte blocks");
        }
        let mut image = OpenOptions::new().append(true).open(out)?;
        io::copy(&mut File::open(sidecar(out))?, &mut image).context("append the tar")?;
        fs::remove_file(sidecar(out))?;
    }
    let image_bytes = fs::metadata(out)
        .with_context(|| format!("{} was not written", out.display()))?
        .len();
    Ok(Converted {
        tar_bytes,
        image_bytes,
    })
}

/// A version 4 UUID from the first 16 bytes of the `diff_id`.
fn uuid(diff_id: &DiffId) -> String {
    let mut b: [u8; 16] = diff_id.as_bytes()[..16].try_into().unwrap();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = crate::hex(&b);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}

fn sidecar(out: &Path) -> PathBuf {
    let mut name = out.as_os_str().to_owned();
    name.push(".tar");
    PathBuf::from(name)
}

fn create_new(path: &Path) -> Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .with_context(|| format!("create {}", path.display()))
}

/// mkfs.erofs's stdout and stderr, drained on threads so it never blocks on
/// a full pipe; only the end is kept for error messages.
struct Output(Vec<JoinHandle<Vec<u8>>>);

impl Output {
    const KEEP: usize = 4096;

    fn collect(child: &mut Child) -> Self {
        let readers: Vec<Box<dyn Read + Send>> = [
            child
                .stdout
                .take()
                .map(|r| Box::new(r) as Box<dyn Read + Send>),
            child
                .stderr
                .take()
                .map(|r| Box::new(r) as Box<dyn Read + Send>),
        ]
        .into_iter()
        .flatten()
        .collect();
        Self(
            readers
                .into_iter()
                .map(|mut reader| {
                    thread::spawn(move || {
                        let mut kept = Vec::new();
                        let mut buffer = [0u8; 8192];
                        while let Ok(n) = reader.read(&mut buffer) {
                            if n == 0 {
                                break;
                            }
                            kept.extend_from_slice(&buffer[..n]);
                            if kept.len() > 2 * Self::KEEP {
                                kept.drain(..kept.len() - Self::KEEP);
                            }
                        }
                        kept
                    })
                })
                .collect(),
        )
    }

    fn finish(self) -> String {
        self.0
            .into_iter()
            .filter_map(|handle| handle.join().ok())
            .map(|bytes| {
                let start = bytes.len().saturating_sub(Self::KEEP);
                String::from_utf8_lossy(&bytes[start..]).into_owned()
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_types() {
        assert_eq!(
            Compression::from_media_type("application/vnd.oci.image.layer.v1.tar").unwrap(),
            Compression::None
        );
        assert_eq!(
            Compression::from_media_type("application/vnd.oci.image.layer.v1.tar+gzip").unwrap(),
            Compression::Gzip
        );
        assert_eq!(
            Compression::from_media_type("application/vnd.docker.image.rootfs.diff.tar.gzip")
                .unwrap(),
            Compression::Gzip
        );
        assert_eq!(
            Compression::from_media_type("application/vnd.oci.image.layer.v1.tar+zstd").unwrap(),
            Compression::Zstd
        );
        // Foreign (non-distributable) layers and anything else are refused.
        assert!(
            Compression::from_media_type(
                "application/vnd.oci.image.layer.nondistributable.v1.tar+gzip"
            )
            .is_err()
        );
        assert!(Compression::from_media_type("application/vnd.oci.image.config.v1+json").is_err());
    }

    #[test]
    fn arguments_follow_the_plan() {
        let id: DiffId = "sha256:00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
            .parse()
            .unwrap();
        assert_eq!(
            Mkfs::arguments(TarMode::Full, &id).join(" "),
            "-b4096 -zlz4hc --tar=f -T0 --aufs -U 00112233-4455-4677-8899-aabbccddeeff"
        );
        assert_eq!(
            Mkfs::arguments(TarMode::Index, &id).join(" "),
            "--tar=i -T0 --aufs -U 00112233-4455-4677-8899-aabbccddeeff"
        );
    }
}
