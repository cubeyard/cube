//! Conversion and the layer disk with the real tools: erofs-utils
//! (`mkfs.erofs`, `fsck.erofs`, `dump.erofs`) and `qemu-img`. A test whose
//! tool is not in `PATH` is skipped with a notice. `CUBE_TEST_LAYER_TOOLS`
//! turns the skip into a failure: `required` for every tool (CI on Linux),
//! or a comma-separated list of tool names (CI on macOS, without QEMU).

use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

use keel_layers::DiffId;
use keel_layers::cache::LayerCache;
use keel_layers::convert::{self, Compression, Mkfs, TarMode};
use keel_layers::disk;
use sha2::{Digest, Sha256};

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

fn run(program: &Path, arguments: &[&str]) -> String {
    let output = Command::new(program).args(arguments).output().unwrap();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.status.success(),
        "{} {arguments:?}: {text}",
        program.display()
    );
    text
}

/// A ustar archive, written here so the bytes do not depend on a host's tar.
fn tar(entries: &[(&str, Option<&[u8]>)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, data) in entries {
        let mut header = [0u8; 512];
        header[..name.len()].copy_from_slice(name.as_bytes());
        let (mode, size, kind) = match data {
            Some(data) => (0o644, data.len(), b'0'),
            None => (0o755, 0, b'5'),
        };
        header[100..107].copy_from_slice(format!("{mode:07o}").as_bytes());
        header[108..115].copy_from_slice(b"0000000");
        header[116..123].copy_from_slice(b"0000000");
        header[124..135].copy_from_slice(format!("{size:011o}").as_bytes());
        // 2023-11-14: conversion must set it to 0 (see `files_have_time_0`).
        header[136..147].copy_from_slice(format!("{:011o}", 1_700_000_000).as_bytes());
        header[156] = kind;
        header[257..263].copy_from_slice(b"ustar\0");
        header[263..265].copy_from_slice(b"00");
        header[148..156].fill(b' ');
        let sum: u32 = header.iter().map(|&b| b as u32).sum();
        header[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
        out.extend_from_slice(&header);
        if let Some(data) = data {
            out.extend_from_slice(data);
            out.resize(out.len().next_multiple_of(512), 0);
        }
    }
    out.resize(out.len() + 1024, 0);
    out.resize(out.len().next_multiple_of(10240), 0);
    out
}

fn diff_id(tar: &[u8]) -> DiffId {
    DiffId::from_bytes(Sha256::digest(tar).into())
}

fn gzip(data: &[u8]) -> Vec<u8> {
    let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}

/// 300 000 bytes that do not compress to nothing.
fn noise() -> Vec<u8> {
    let mut state = 0x2545_f491_4f6c_dd1du64;
    (0..300_000)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state as u8
        })
        .collect()
}

fn files_layer() -> Vec<u8> {
    let noise = noise();
    tar(&[
        ("etc/", None),
        ("etc/hello", Some(b"hello from a layer\n")),
        ("usr/", None),
        ("usr/noise", Some(&noise)),
    ])
}

fn whiteout_layer() -> Vec<u8> {
    tar(&[
        ("etc/", None),
        ("etc/.wh.hello", Some(b"")),
        ("added", Some(b"upper\n")),
    ])
}

const EROFS_MAGIC: [u8; 4] = [0xe2, 0xe1, 0xf5, 0xe0];

#[test]
fn full_mode_gives_the_same_verified_image_from_any_compression() {
    let (Some(mkfs), Some(fsck)) = (tool("mkfs.erofs"), tool("fsck.erofs")) else {
        return;
    };
    let mkfs = Mkfs::new(mkfs);
    let dir = tempfile::tempdir().unwrap();
    let layer = files_layer();
    let id = diff_id(&layer);

    let mut images = BTreeMap::new();
    for (name, compression, blob) in [
        ("tar", Compression::None, layer.clone()),
        ("gzip", Compression::Gzip, gzip(&layer)),
        // Two zstd frames back to back, as a chunked layer has.
        (
            "zstd",
            Compression::Zstd,
            [
                zstd::encode_all(&layer[..5120], 3).unwrap(),
                zstd::encode_all(&layer[5120..], 3).unwrap(),
            ]
            .concat(),
        ),
    ] {
        let cache = LayerCache::open(dir.path().join(name)).unwrap();
        let (path, converted) = cache
            .get_or_convert(&id, &mkfs, TarMode::Full, compression, || Ok(&blob[..]))
            .unwrap();
        let converted = converted.unwrap();
        assert_eq!(converted.tar_bytes, layer.len() as u64);
        assert_eq!(path, cache.path(&id));
        let image = fs::read(&path).unwrap();
        assert_eq!(converted.image_bytes, image.len() as u64);
        images.insert(name, image);
        // Cached now: the blob is not read again.
        let (again, converted) = cache
            .get_or_convert(
                &id,
                &mkfs,
                TarMode::Full,
                compression,
                || -> anyhow::Result<&[u8]> { panic!("converted twice") },
            )
            .unwrap();
        assert_eq!((again, converted), (path, None));
    }
    let image = &images["tar"];
    assert_eq!(&images["gzip"], image);
    assert_eq!(&images["zstd"], image);
    assert_eq!(&image[1024..1028], &EROFS_MAGIC);
    assert_eq!(image.len() % 4096, 0);
    // LZ4HC: smaller than the incompressible data plus the rest.
    assert!(
        image.len() < layer.len(),
        "{} >= {}",
        image.len(),
        layer.len()
    );

    let out = dir.path().join("extracted");
    run(
        &fsck,
        &[
            &format!("--extract={}", out.display()),
            dir.path()
                .join("tar")
                .join(format!("{id}.erofs"))
                .to_str()
                .unwrap(),
        ],
    );
    assert_eq!(
        fs::read(out.join("etc/hello")).unwrap(),
        b"hello from a layer\n"
    );
    assert_eq!(fs::read(out.join("usr/noise")).unwrap(), noise());
}

#[test]
fn whiteouts_become_overlayfs_whiteouts() {
    let (Some(mkfs), Some(dump)) = (tool("mkfs.erofs"), tool("dump.erofs")) else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let layer = whiteout_layer();
    let out = dir.path().join("layer.erofs");
    convert::convert(
        &Mkfs::new(mkfs),
        TarMode::Full,
        &layer[..],
        Compression::None,
        &diff_id(&layer),
        &out,
    )
    .unwrap();
    let image = out.to_str().unwrap();
    // `.wh.hello` is now `hello`, a 0:0 character device; `added` is a file.
    assert!(run(&dump, &["--path=/etc/hello", image]).contains("char dev"));
    assert!(run(&dump, &["--path=/added", image]).contains("regular file"));
    let missing = Command::new(&dump)
        .args(["--path=/etc/.wh.hello", image])
        .output()
        .unwrap();
    assert!(
        !missing.status.success() || String::from_utf8_lossy(&missing.stderr).contains("failed")
    );
}

#[test]
fn files_have_time_0_and_conversion_is_reproducible() {
    let (Some(mkfs), Some(dump)) = (tool("mkfs.erofs"), tool("dump.erofs")) else {
        return;
    };
    let mkfs = Mkfs::new(mkfs);
    let dir = tempfile::tempdir().unwrap();
    let layer = files_layer();
    let mut images = Vec::new();
    for (i, mode) in [TarMode::Full, TarMode::Full, TarMode::Index, TarMode::Index]
        .into_iter()
        .enumerate()
    {
        if i % 2 == 1 {
            // A clock that leaked into the image would differ by now.
            std::thread::sleep(std::time::Duration::from_millis(1100));
        }
        let out = dir.path().join(format!("{i}.erofs"));
        convert::convert(
            &mkfs,
            mode,
            &layer[..],
            Compression::None,
            &diff_id(&layer),
            &out,
        )
        .unwrap();
        images.push(fs::read(&out).unwrap());
        let image = out.to_str().unwrap();
        let shown = Command::new(&dump)
            .env("TZ", "UTC")
            .args(["--path=/etc/hello", image])
            .output()
            .unwrap();
        let shown = String::from_utf8_lossy(&shown.stdout);
        assert!(
            shown.contains("Timestamp: 1970-01-01 00:00:00"),
            "{mode:?}: {shown}"
        );
    }
    assert!(images[0] == images[1], "--tar=f is not reproducible");
    assert!(images[2] == images[3], "--tar=i is not reproducible");
}

#[test]
fn index_mode_is_the_index_followed_by_the_tar() {
    let Some(mkfs) = tool("mkfs.erofs") else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let layer = files_layer();
    let out = dir.path().join("layer.erofs");
    let converted = convert::convert(
        &Mkfs::new(mkfs),
        TarMode::Index,
        &gzip(&layer)[..],
        Compression::Gzip,
        &diff_id(&layer),
        &out,
    )
    .unwrap();
    let image = fs::read(&out).unwrap();
    assert_eq!(converted.image_bytes, image.len() as u64);
    assert_eq!(&image[1024..1028], &EROFS_MAGIC);
    let index = image.len() - layer.len();
    assert_eq!(index % 512, 0);
    assert!(index > 0 && index < 64 * 1024, "index of {index} bytes");
    assert_eq!(&image[index..], &layer[..]);
    // Only the image is left: the kept tar was appended and removed.
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn a_layer_that_does_not_match_its_diff_id_is_not_cached() {
    let Some(mkfs) = tool("mkfs.erofs") else {
        return;
    };
    let mkfs = Mkfs::new(mkfs);
    let dir = tempfile::tempdir().unwrap();
    let cache = LayerCache::open(dir.path()).unwrap();
    let layer = files_layer();
    let wrong = diff_id(&whiteout_layer());
    for mode in [TarMode::Full, TarMode::Index] {
        let error = cache
            .get_or_convert(&wrong, &mkfs, mode, Compression::None, || Ok(&layer[..]))
            .unwrap_err();
        assert!(
            format!("{error:#}").contains(&format!("the image says {wrong}")),
            "{error:#}"
        );
        assert_eq!(cache.get(&wrong).unwrap(), None);
        assert_eq!(
            fs::read_dir(dir.path()).unwrap().count(),
            0,
            "{mode:?} left files behind"
        );
    }
    // A corrupt blob is refused too.
    let mut blob = gzip(&layer);
    let middle = blob.len() / 2;
    blob[middle] ^= 0xff;
    assert!(
        cache
            .get_or_convert(
                &diff_id(&layer),
                &mkfs,
                TarMode::Full,
                Compression::Gzip,
                || Ok(&blob[..])
            )
            .is_err()
    );
    assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 0);
}

#[test]
fn qemu_reads_the_layer_disk_as_head_layers_padding_and_tail() {
    let (Some(mkfs), Some(qemu_img)) = (tool("mkfs.erofs"), tool("qemu-img")) else {
        return;
    };
    let mkfs = Mkfs::new(mkfs);
    let dir = tempfile::tempdir().unwrap();
    // The cache's own names (`sha256:...`), absolute, as the runner uses them.
    let cache = LayerCache::open(dir.path().join("layers")).unwrap();
    let lower = whiteout_layer();
    let upper = files_layer();
    let (lower_path, _) = cache
        .get_or_convert(
            &diff_id(&lower),
            &mkfs,
            TarMode::Full,
            Compression::None,
            || Ok(&lower[..]),
        )
        .unwrap();
    // An index-mode image is whole 512-byte sectors but not 4 KiB, so the
    // disk needs padding after it.
    let (upper_path, _) = cache
        .get_or_convert(
            &diff_id(&upper),
            &mkfs,
            TarMode::Index,
            Compression::None,
            || Ok(&upper[..]),
        )
        .unwrap();
    let upper_bytes = fs::read(&upper_path).unwrap();
    assert_ne!(
        upper_bytes.len() % 4096,
        0,
        "the test needs a layer that is not 4 KiB aligned"
    );

    let machine = dir.path().join("machine");
    let layers: Vec<disk::Layer> = [&upper_path, &lower_path]
        .into_iter()
        .map(|path| disk::Layer {
            path: path.clone(),
            name: path.file_name().unwrap().to_str().unwrap()[..36].to_string(),
        })
        .collect();
    let written = disk::write(&machine, &layers).unwrap();
    let descriptor = fs::read_to_string(&written.descriptor).unwrap();
    assert!(!descriptor.contains("ZERO"), "{descriptor}");
    assert!(descriptor.contains(" FLAT \"") && machine.join(disk::ZERO).exists());

    let info = run(
        &qemu_img,
        &[
            "info",
            "--output=json",
            written.descriptor.to_str().unwrap(),
        ],
    );
    assert!(
        info.contains(&format!("\"virtual-size\": {}", written.sectors * 512)),
        "{info}"
    );
    let raw = dir.path().join("disk.raw");
    run(
        &qemu_img,
        &[
            "convert",
            "-f",
            "vmdk",
            "-O",
            "raw",
            written.descriptor.to_str().unwrap(),
            raw.to_str().unwrap(),
        ],
    );
    let raw = fs::read(&raw).unwrap();

    let mut expected = fs::read(machine.join(disk::HEAD)).unwrap();
    expected.extend(&upper_bytes);
    expected.resize(expected.len().next_multiple_of(4096), 0);
    expected.extend(fs::read(&lower_path).unwrap());
    expected.extend(fs::read(machine.join(disk::TAIL)).unwrap());
    assert_eq!(raw.len(), expected.len());
    assert!(
        raw == expected,
        "qemu-img's view of the disk differs from head + layers + padding + tail"
    );
    for partition in &written.partitions {
        let start = (partition.first_lba * 512) as usize;
        assert_eq!(
            &raw[start + 1024..start + 1028],
            &EROFS_MAGIC,
            "partition {}",
            partition.number
        );
    }

    // util-linux reads the same table, primary and backup.
    if let Some(sfdisk) = tool("sfdisk") {
        let raw_path = dir.path().join("disk.raw");
        let verify = run(&sfdisk, &["--verify", raw_path.to_str().unwrap()]);
        assert!(verify.contains("No errors detected."), "{verify}");
        let table = run(&sfdisk, &["--dump", raw_path.to_str().unwrap()]);
        assert!(table.contains("label: gpt"), "{table}");
        let read: Vec<(u64, u64)> = table
            .lines()
            .filter_map(|line| line.split_once(" : "))
            .map(|(_, fields)| {
                let field = |name: &str| -> u64 {
                    let value = fields
                        .split(',')
                        .find_map(|f| f.trim().strip_prefix(name))
                        .unwrap();
                    value.trim().parse().unwrap()
                };
                (field("start="), field("size="))
            })
            .collect();
        let wanted: Vec<(u64, u64)> = written
            .partitions
            .iter()
            .map(|p| (p.first_lba, p.sectors))
            .collect();
        assert_eq!(read, wanted, "{table}");
        assert_eq!(
            table
                .matches("type=0FC63DAF-8483-4772-8E79-3D69D8477DE4")
                .count(),
            2,
            "{table}"
        );
    }
}
