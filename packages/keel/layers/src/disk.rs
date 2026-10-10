//! A machine's layer disk (`vdb`): one GPT partition per layer, without
//! copying a layer. Following nerdbox (`internal/erofs/gpt.go`, `vmdk.go`),
//! the disk is a VMDK descriptor (`twoGbMaxExtentFlat`) whose extents are, in
//! order:
//!
//! ```text
//! layers.head   protective MBR, primary GPT header and entries, zeros up to
//!               the first partition (LBA 40, 4 KiB aligned)
//! <layer 1>     the cached EROFS file, read where it is
//! layers.zero   zeros up to the next 4 KiB boundary, only where needed
//! <layer 2> ...
//! layers.tail   backup GPT entries and header (the disk's last 33 sectors)
//! ```
//!
//! Every extent is `FLAT`, padding included. QEMU silently ignores `ZERO`
//! extent lines (nerdbox writes them for padding), which shrinks the disk and
//! moves every later layer; [`write`] refuses to write a descriptor with one.
//!
//! The bytes depend only on the layers' names and sizes, so the same layer
//! list always gives the same disk.

use std::fmt::Write as _;
use std::fs::{self, File};
use std::io::Write as _;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use sha2::{Digest, Sha256};

pub const SECTOR: u64 = 512;
/// Partitions start on 4 KiB boundaries, EROFS's block size.
const ALIGN: u64 = 8;
const ENTRIES: u64 = 128;
const ENTRY_SIZE: u64 = 128;
const ENTRY_SECTORS: u64 = ENTRIES * ENTRY_SIZE / SECTOR;
const FIRST_PARTITION: u64 = 40;
/// GPT type "Linux filesystem data", 0FC63DAF-8483-4772-8E79-3D69D8477DE4.
const LINUX_DATA: [u8; 16] = guid_bytes(
    0x0FC6_3DAF,
    0x8483,
    0x4772,
    [0x8E, 0x79, 0x3D, 0x69, 0xD8, 0x47, 0x7D, 0xE4],
);

pub const DESCRIPTOR: &str = "layers.vmdk";
pub const HEAD: &str = "layers.head";
pub const ZERO: &str = "layers.zero";
pub const TAIL: &str = "layers.tail";

/// One layer on the disk.
#[derive(Clone, Debug)]
pub struct Layer {
    /// The EROFS file, absolute (the descriptor refers to it by this path).
    pub path: PathBuf,
    /// The partition's GPT name, at most 36 printable ASCII characters, for
    /// example the first 29 hex digits of the `diff_id` after `sha256:`.
    pub name: String,
}

/// Where each layer landed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Partition {
    /// 1 for the first layer, as `runner.proto`'s `Layer.partition` (vdb1).
    pub number: u32,
    pub first_lba: u64,
    pub sectors: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LayerDisk {
    pub descriptor: PathBuf,
    pub partitions: Vec<Partition>,
    /// The virtual disk's size in sectors.
    pub sectors: u64,
}

enum Extent {
    Head,
    Layer(usize),
    Zero(u64),
    Tail,
}

/// Writes the layer disk for `layers` (in partition order) into `dir`,
/// replacing what a previous call wrote there. Each file is written under a
/// temporary name and renamed; call it while no QEMU has the disk open.
pub fn write(dir: &Path, layers: &[Layer]) -> Result<LayerDisk> {
    ensure!(
        layers.len() as u64 <= ENTRIES,
        "{} layers; a GPT holds at most {ENTRIES}",
        layers.len()
    );
    let mut extents = vec![Extent::Head];
    let mut partitions = Vec::new();
    let mut lba = FIRST_PARTITION;
    let mut largest_gap = 0;
    for (i, layer) in layers.iter().enumerate() {
        ensure!(
            layer.path.is_absolute(),
            "layer path {} is not absolute",
            layer.path.display()
        );
        let text = layer
            .path
            .to_str()
            .with_context(|| format!("layer path {} is not UTF-8", layer.path.display()))?;
        ensure!(
            !text.contains(['"', '\n', '\r']),
            "layer path {text:?} cannot be named in a VMDK descriptor"
        );
        ensure!(
            layer.name.len() <= 36 && layer.name.bytes().all(|b| (0x20..0x7f).contains(&b)),
            "partition name {:?} is not at most 36 printable ASCII characters",
            layer.name
        );
        let bytes = fs::metadata(&layer.path)
            .with_context(|| format!("read {}", layer.path.display()))?
            .len();
        ensure!(
            bytes > 0 && bytes % SECTOR == 0,
            "{} is {bytes} bytes, not whole sectors",
            layer.path.display()
        );
        let sectors = bytes / SECTOR;
        partitions.push(Partition {
            number: i as u32 + 1,
            first_lba: lba,
            sectors,
        });
        extents.push(Extent::Layer(i));
        lba += sectors;
        let gap = lba.next_multiple_of(ALIGN) - lba;
        if gap > 0 {
            extents.push(Extent::Zero(gap));
            largest_gap = largest_gap.max(gap);
            lba += gap;
        }
    }
    extents.push(Extent::Tail);
    let last_usable = lba.max(FIRST_PARTITION) - 1;
    let backup_entries = last_usable + 1;
    let last_lba = backup_entries + ENTRY_SECTORS;
    let sectors = last_lba + 1;

    let disk_guid = guid(&layers.iter().zip(&partitions).fold(
        Sha256::new_with_prefix(b"keel layer disk"),
        |hash, (layer, partition)| {
            hash.chain_update(layer.name.as_bytes())
                .chain_update([0])
                .chain_update(partition.sectors.to_le_bytes())
        },
    ));
    let mut entries = vec![0u8; (ENTRIES * ENTRY_SIZE) as usize];
    for (partition, layer) in partitions.iter().zip(layers) {
        let entry = &mut entries[(partition.number as usize - 1) * ENTRY_SIZE as usize..]
            [..ENTRY_SIZE as usize];
        entry[0..16].copy_from_slice(&LINUX_DATA);
        let unique =
            Sha256::new_with_prefix(disk_guid).chain_update(partition.number.to_le_bytes());
        entry[16..32].copy_from_slice(&guid(&unique));
        entry[32..40].copy_from_slice(&partition.first_lba.to_le_bytes());
        entry[40..48].copy_from_slice(&(partition.first_lba + partition.sectors - 1).to_le_bytes());
        for (j, unit) in layer.name.encode_utf16().enumerate() {
            entry[56 + 2 * j..58 + 2 * j].copy_from_slice(&unit.to_le_bytes());
        }
    }
    let entries_crc = crc32fast::hash(&entries);
    let header = |mine: u64, other: u64, entries_lba: u64| {
        let mut h = vec![0u8; SECTOR as usize];
        h[0..8].copy_from_slice(b"EFI PART");
        h[8..12].copy_from_slice(&0x0001_0000u32.to_le_bytes());
        h[12..16].copy_from_slice(&92u32.to_le_bytes());
        h[24..32].copy_from_slice(&mine.to_le_bytes());
        h[32..40].copy_from_slice(&other.to_le_bytes());
        h[40..48].copy_from_slice(&FIRST_PARTITION.to_le_bytes());
        h[48..56].copy_from_slice(&last_usable.to_le_bytes());
        h[56..72].copy_from_slice(&disk_guid);
        h[72..80].copy_from_slice(&entries_lba.to_le_bytes());
        h[80..84].copy_from_slice(&(ENTRIES as u32).to_le_bytes());
        h[84..88].copy_from_slice(&(ENTRY_SIZE as u32).to_le_bytes());
        h[88..92].copy_from_slice(&entries_crc.to_le_bytes());
        let crc = crc32fast::hash(&h[..92]);
        h[16..20].copy_from_slice(&crc.to_le_bytes());
        h
    };

    let mut head = vec![0u8; (FIRST_PARTITION * SECTOR) as usize];
    // Protective MBR: one partition of type 0xEE over the whole disk.
    let mbr = &mut head[446..462];
    mbr[1..4].copy_from_slice(&[0x00, 0x02, 0x00]);
    mbr[4] = 0xEE;
    mbr[5..8].copy_from_slice(&[0xFF, 0xFF, 0xFF]);
    mbr[8..12].copy_from_slice(&1u32.to_le_bytes());
    mbr[12..16].copy_from_slice(&u32::try_from(sectors - 1).unwrap_or(u32::MAX).to_le_bytes());
    head[510..512].copy_from_slice(&[0x55, 0xAA]);
    head[512..1024].copy_from_slice(&header(1, last_lba, 2));
    head[1024..1024 + entries.len()].copy_from_slice(&entries);

    let mut tail = entries.clone();
    tail.extend(header(last_lba, 1, backup_entries));

    let mut descriptor = String::from(
        "# Disk DescriptorFile\n# keel layer disk, written by keel-layers\nversion=1\nCID=fffffffe\n\
         parentCID=ffffffff\ncreateType=\"twoGbMaxExtentFlat\"\n\n# Extent description\n",
    );
    let dir_path = |name: &str| dir.join(name);
    for extent in &extents {
        let (sectors, path) = match extent {
            Extent::Head => (FIRST_PARTITION, dir_path(HEAD)),
            Extent::Layer(i) => (partitions[*i].sectors, layers[*i].path.clone()),
            Extent::Zero(sectors) => (*sectors, dir_path(ZERO)),
            Extent::Tail => (ENTRY_SECTORS + 1, dir_path(TAIL)),
        };
        writeln!(descriptor, "RW {sectors} FLAT \"{}\" 0", path.display())?;
    }
    write!(
        descriptor,
        "\n# The Disk Data Base\n#DDB\n\nddb.virtualHWVersion = \"4\"\nddb.adapterType = \"lsilogic\"\n\
         ddb.geometry.cylinders = \"{}\"\nddb.geometry.heads = \"16\"\nddb.geometry.sectors = \"63\"\n",
        (sectors / (16 * 63)).clamp(1, 16383)
    )?;
    check_descriptor(&descriptor)?;

    fs::create_dir_all(dir)?;
    replace(&dir_path(HEAD), &head)?;
    replace(&dir_path(TAIL), &tail)?;
    if largest_gap > 0 {
        replace(&dir_path(ZERO), &vec![0u8; (ALIGN * SECTOR) as usize])?;
    }
    let descriptor_path = dir_path(DESCRIPTOR);
    replace(&descriptor_path, descriptor.as_bytes())?;
    Ok(LayerDisk {
        descriptor: descriptor_path,
        partitions,
        sectors,
    })
}

/// Every extent line must be `FLAT`; see the module comment.
fn check_descriptor(descriptor: &str) -> Result<()> {
    for line in descriptor.lines() {
        let mut words = line.split_whitespace();
        if matches!(words.next(), Some("RW" | "RDONLY" | "NOACCESS"))
            && words.nth(1) != Some("FLAT")
        {
            bail!("VMDK extent {line:?} is not FLAT");
        }
    }
    Ok(())
}

/// A version 4 GUID in GPT's on-disk byte order from a hash.
fn guid(hash: &Sha256) -> [u8; 16] {
    let digest: [u8; 32] = hash.clone().finalize().into();
    let mut b: [u8; 16] = digest[..16].try_into().unwrap();
    b[7] = (b[7] & 0x0f) | 0x40; // high byte of the little-endian third field
    b[8] = (b[8] & 0x3f) | 0x80;
    b
}

const fn guid_bytes(a: u32, b: u16, c: u16, d: [u8; 8]) -> [u8; 16] {
    let a = a.to_le_bytes();
    let b = b.to_le_bytes();
    let c = c.to_le_bytes();
    [
        a[0], a[1], a[2], a[3], b[0], b[1], c[0], c[1], d[0], d[1], d[2], d[3], d[4], d[5], d[6],
        d[7],
    ]
}

fn replace(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut temporary = path.as_os_str().to_owned();
    temporary.push(".new");
    let temporary = PathBuf::from(temporary);
    let mut file =
        File::create(&temporary).with_context(|| format!("create {}", temporary.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(&temporary, path).with_context(|| format!("replace {}", path.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn layer(dir: &Path, name: &str, bytes: usize, fill: u8) -> Layer {
        let path = dir.join(format!("{name}.erofs"));
        fs::write(&path, vec![fill; bytes]).unwrap();
        Layer {
            path,
            name: name.to_string(),
        }
    }

    fn u32_at(b: &[u8], at: usize) -> u32 {
        u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
    }

    fn u64_at(b: &[u8], at: usize) -> u64 {
        u64::from_le_bytes(b[at..at + 8].try_into().unwrap())
    }

    /// The disk as QEMU reads it, from the descriptor's extents.
    fn assemble(descriptor: &str) -> Vec<u8> {
        let mut disk = Vec::new();
        for line in descriptor.lines().filter(|l| l.starts_with("RW ")) {
            let sectors: usize = line.split(' ').nth(1).unwrap().parse().unwrap();
            let path = line.split('"').nth(1).unwrap();
            let bytes = fs::read(path).unwrap();
            assert!(bytes.len() >= sectors * 512, "{line}");
            disk.extend_from_slice(&bytes[..sectors * 512]);
        }
        disk
    }

    #[test]
    fn writes_a_valid_gpt_with_one_partition_per_layer() {
        let dir = tempfile::tempdir().unwrap();
        let layers = vec![
            layer(dir.path(), "sha256:aaaa", 8192, 0xA1),
            // 4 KiB plus one sector: the next layer needs padding.
            layer(dir.path(), "sha256:bbbb", 4096 + 512, 0xB2),
            layer(dir.path(), "template-1", 4096, 0xC3),
        ];
        let machine = dir.path().join("machine");
        let disk = write(&machine, &layers).unwrap();
        assert_eq!(
            disk.partitions,
            vec![
                Partition {
                    number: 1,
                    first_lba: 40,
                    sectors: 16
                },
                Partition {
                    number: 2,
                    first_lba: 56,
                    sectors: 9
                },
                Partition {
                    number: 3,
                    first_lba: 72,
                    sectors: 8
                },
            ]
        );
        assert_eq!(disk.sectors, 80 + 33);

        let descriptor = fs::read_to_string(&disk.descriptor).unwrap();
        assert!(!descriptor.contains("ZERO"), "{descriptor}");
        let extents: Vec<&str> = descriptor
            .lines()
            .filter(|l| l.starts_with("RW "))
            .collect();
        assert_eq!(extents.len(), 6);
        assert_eq!(
            extents[0],
            format!("RW 40 FLAT \"{}\" 0", machine.join(HEAD).display())
        );
        assert_eq!(
            extents[3],
            format!("RW 7 FLAT \"{}\" 0", machine.join(ZERO).display())
        );
        assert_eq!(
            extents[5],
            format!("RW 33 FLAT \"{}\" 0", machine.join(TAIL).display())
        );

        let image = assemble(&descriptor);
        assert_eq!(image.len() as u64, disk.sectors * 512);
        // Layers are where the table says, padding is zeros.
        assert!(image[40 * 512..56 * 512].iter().all(|&b| b == 0xA1));
        assert!(image[56 * 512..65 * 512].iter().all(|&b| b == 0xB2));
        assert!(image[65 * 512..72 * 512].iter().all(|&b| b == 0));
        assert!(image[72 * 512..80 * 512].iter().all(|&b| b == 0xC3));

        // Protective MBR.
        assert_eq!(&image[510..512], &[0x55, 0xAA]);
        assert_eq!(image[446 + 4], 0xEE);
        assert_eq!(u32_at(&image, 446 + 8), 1);
        assert_eq!(u32_at(&image, 446 + 12), (disk.sectors - 1) as u32);

        let last = disk.sectors - 1;
        for (header_lba, other, entries_lba) in [(1, last, 2), (last, 1, last - 32)] {
            let h = &image[(header_lba * 512) as usize..][..512];
            assert_eq!(&h[0..8], b"EFI PART");
            let mut zeroed = h[..92].to_vec();
            zeroed[16..20].fill(0);
            assert_eq!(
                u32_at(h, 16),
                crc32fast::hash(&zeroed),
                "header CRC at LBA {header_lba}"
            );
            assert_eq!(u64_at(h, 24), header_lba);
            assert_eq!(u64_at(h, 32), other);
            assert_eq!(u64_at(h, 40), 40);
            assert_eq!(u64_at(h, 48), 79);
            assert_eq!(u64_at(h, 72), entries_lba);
            let entries = &image[(entries_lba * 512) as usize..][..128 * 128];
            assert_eq!(u32_at(h, 88), crc32fast::hash(entries));
            for (i, p) in disk.partitions.iter().enumerate() {
                let e = &entries[i * 128..][..128];
                assert_eq!(&e[0..16], &LINUX_DATA);
                assert_eq!(u64_at(e, 32), p.first_lba);
                assert_eq!(u64_at(e, 40), p.first_lba + p.sectors - 1);
                let name: Vec<u16> = e[56..128]
                    .chunks(2)
                    .map(|c| u16::from_le_bytes([c[0], c[1]]))
                    .take_while(|&u| u != 0)
                    .collect();
                assert_eq!(String::from_utf16(&name).unwrap(), layers[i].name);
            }
            assert!(entries[3 * 128..].iter().all(|&b| b == 0));
        }
        // Partition GUIDs differ from each other and from the disk's.
        let entries = &image[1024..1024 + 3 * 128];
        let guids: std::collections::HashSet<&[u8]> = (0..3)
            .map(|i| &entries[i * 128 + 16..i * 128 + 32])
            .collect();
        assert_eq!(guids.len(), 3);
        assert!(!guids.contains(&image[512 + 56..512 + 72]));

        // The same layers give the same disk.
        let again = write(&dir.path().join("other"), &layers).unwrap();
        assert_eq!(
            assemble(&fs::read_to_string(again.descriptor).unwrap()),
            image
        );
    }

    #[test]
    fn no_padding_file_when_layers_are_aligned() {
        let dir = tempfile::tempdir().unwrap();
        let layers = vec![layer(dir.path(), "one", 4096, 1)];
        let disk = write(dir.path(), &layers).unwrap();
        assert!(!dir.path().join(ZERO).exists());
        assert_eq!(
            disk.partitions,
            vec![Partition {
                number: 1,
                first_lba: 40,
                sectors: 8
            }]
        );
    }

    #[test]
    fn refuses_what_it_cannot_describe() {
        let dir = tempfile::tempdir().unwrap();
        let odd = layer(dir.path(), "odd", 1000, 1);
        assert!(
            write(dir.path(), &[odd])
                .unwrap_err()
                .to_string()
                .contains("not whole sectors")
        );
        let relative = Layer {
            path: PathBuf::from("sha256:abc.erofs"),
            name: "x".into(),
        };
        assert!(
            write(dir.path(), &[relative])
                .unwrap_err()
                .to_string()
                .contains("not absolute")
        );
        let long = Layer {
            name: "x".repeat(37),
            ..layer(dir.path(), "long", 4096, 1)
        };
        assert!(
            write(dir.path(), &[long])
                .unwrap_err()
                .to_string()
                .contains("36 printable")
        );
        let quoted = layer(dir.path(), "a\"b", 4096, 1);
        assert!(
            write(dir.path(), &[quoted])
                .unwrap_err()
                .to_string()
                .contains("VMDK descriptor")
        );
        let many: Vec<Layer> = (0..129)
            .map(|i| layer(dir.path(), &format!("l{i}"), 512, 1))
            .collect();
        assert!(
            write(dir.path(), &many)
                .unwrap_err()
                .to_string()
                .contains("at most 128")
        );
    }

    #[test]
    fn descriptor_check_refuses_zero_extents() {
        assert!(check_descriptor("RW 8 FLAT \"/a\" 0\nRW 8 FLAT \"/b\" 0\n").is_ok());
        let error =
            check_descriptor("RW 8 FLAT \"/a\" 0\nRW 7 ZERO\nRW 8 FLAT \"/b\" 0\n").unwrap_err();
        assert_eq!(error.to_string(), "VMDK extent \"RW 7 ZERO\" is not FLAT");
        assert!(check_descriptor("RDONLY 8 SPARSE \"/a\"\n").is_err());
    }
}
