//! A read-only EROFS reader, so the driver can look into a published
//! template layer without extracting it. Extraction writes the layer's
//! whiteouts (0/0 character devices) with `mknod`, which a macOS host refuses
//! unless root, and which drops `trusted.*` xattrs; reading the image itself
//! needs neither, and sees each entry's type, device number, owner, mode,
//! time, xattrs and data as the guest kernel will.
//!
//! It reads what `mkfs.erofs` writes from a directory or a tar: compact and
//! extended inodes, inline and shared xattrs, flat and inline data, and
//! LZ4-compressed files with full or compact indexes (plain, interlaced and
//! big pclusters). Anything else (chunked files, tail packing, fragments,
//! other algorithms, extra devices, long xattr prefixes) is an error, never
//! a skipped file. `fsck.erofs` still checks the image; this reader only
//! has to be exact for what it accepts.

use std::collections::HashSet;

use anyhow::{Context, Result, bail, ensure};

const MAGIC: u32 = 0xE0F5_E1E2;
const INCOMPAT_ZERO_PADDING: u32 = 0x1;
const INCOMPAT_KNOWN: u32 = 0x1 | 0x2 | 0x8;

const ADVISE_COMPACTED_2B: u16 = 0x1;
const ADVISE_BIG_PCLUSTER_1: u16 = 0x2;
const ADVISE_BIG_PCLUSTER_2: u16 = 0x4;
const ADVISE_KNOWN: u16 = 0x1 | 0x2 | 0x4 | 0x10;
const ADVISE_INTERLACED: u16 = 0x10;

const TYPE_PLAIN: u8 = 0;
const TYPE_HEAD1: u8 = 1;
const TYPE_NONHEAD: u8 = 2;
const TYPE_HEAD2: u8 = 3;
const D0_CBLKCNT: u32 = 1 << 11;

/// Caps on what one image may make the driver hold.
const MAX_FILE: u64 = 64 << 20;
const MAX_TOTAL: u64 = 512 << 20;
const MAX_DEPTH: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    File,
    Dir,
    Symlink,
    /// A character device and its number as EROFS stores it
    /// (`new_encode_dev`); 0 is overlayfs' whiteout.
    Char(u32),
    Block(u32),
    Fifo,
    Socket,
}

#[derive(Clone, Debug)]
pub struct Entry {
    /// Below the root, without a leading slash; "" is the root.
    pub path: String,
    pub kind: Kind,
    /// The permission bits (`mode & 0o7777`).
    pub mode: u16,
    pub uid: u32,
    pub gid: u32,
    pub mtime: u64,
    pub xattrs: Vec<(String, Vec<u8>)>,
    /// A file's contents or a link's target; empty otherwise.
    pub data: Vec<u8>,
}

impl Entry {
    pub fn is_whiteout(&self) -> bool {
        self.kind == Kind::Char(0)
    }

    pub fn xattr(&self, name: &str) -> Option<&[u8]> {
        self.xattrs
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_slice())
    }
}

/// Every entry of the image, the root first, each directory before what
/// it holds.
pub fn read_tree(image: &[u8]) -> Result<Vec<Entry>> {
    let fs = Fs::new(image)?;
    let mut out = vec![];
    let mut seen = HashSet::new();
    let mut total = 0u64;
    ensure!(
        fs.inode(fs.root)?.kind == Kind::Dir,
        "the root is not a directory"
    );
    let mut stack = vec![(fs.root, String::new(), 0usize)];
    while let Some((nid, path, depth)) = stack.pop() {
        let at = if path.is_empty() { "/" } else { &path };
        let inode = fs.inode(nid).with_context(|| format!("{at} (nid {nid})"))?;
        if inode.kind == Kind::Dir {
            ensure!(seen.insert(nid), "{at}: directory nid {nid} seen twice");
            ensure!(depth < MAX_DEPTH, "{at}: deeper than {MAX_DEPTH}");
        }
        ensure!(
            inode.size <= MAX_FILE,
            "{at}: {} bytes is over the reader's limit",
            inode.size
        );
        total += inode.size;
        ensure!(total <= MAX_TOTAL, "the image holds over {MAX_TOTAL} bytes");
        let data = match inode.kind {
            Kind::File | Kind::Dir | Kind::Symlink => fs
                .data(&inode)
                .with_context(|| format!("{at} (nid {nid})"))?,
            _ => vec![],
        };
        if inode.kind == Kind::Dir {
            let entries = dirents(&data, fs.blksz).with_context(|| at.to_string())?;
            let mut children = vec![];
            for (name, child, ftype) in entries {
                if name == "." || name == ".." {
                    continue;
                }
                ensure!(
                    !name.contains('/') && !name.is_empty(),
                    "{at}: a bad name {name:?}"
                );
                let kind = fs.inode(child).map(|i| i.kind).ok();
                ensure!(
                    kind.map(ftype_of) == Some(ftype),
                    "{at}/{name}: the directory says type {ftype}, the inode {kind:?}"
                );
                let child_path = if path.is_empty() {
                    name
                } else {
                    format!("{path}/{name}")
                };
                children.push((child, child_path, depth + 1));
            }
            // Popped in name order.
            children.reverse();
            stack.extend(children);
        }
        out.push(Entry {
            path,
            kind: inode.kind,
            mode: inode.mode & 0o7777,
            uid: inode.uid,
            gid: inode.gid,
            mtime: inode.mtime,
            xattrs: inode.xattrs,
            data: if inode.kind == Kind::Dir {
                vec![]
            } else {
                data
            },
        });
    }
    Ok(out)
}

fn ftype_of(kind: Kind) -> u8 {
    match kind {
        Kind::File => 1,
        Kind::Dir => 2,
        Kind::Char(_) => 3,
        Kind::Block(_) => 4,
        Kind::Fifo => 5,
        Kind::Socket => 6,
        Kind::Symlink => 7,
    }
}

struct Fs<'a> {
    image: &'a [u8],
    blkbits: u32,
    blksz: u64,
    root: u64,
    build_time: u64,
    meta: u64,
    xattr: u64,
    zero_padding: bool,
}

struct Inode {
    nid: u64,
    kind: Kind,
    layout: u8,
    mode: u16,
    size: u64,
    uid: u32,
    gid: u32,
    mtime: u64,
    /// raw_blkaddr, rdev or compressed_blocks.
    u: u32,
    /// Where the inode ends with its xattrs: inline data or the map header.
    end: u64,
    xattrs: Vec<(String, Vec<u8>)>,
}

fn le16(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}

fn le32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}

fn le64(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().unwrap())
}

impl<'a> Fs<'a> {
    fn new(image: &'a [u8]) -> Result<Self> {
        ensure!(image.len() >= 1024 + 128, "too short for a superblock");
        let sb = &image[1024..1024 + 128];
        ensure!(le32(sb, 0) == MAGIC, "no EROFS superblock");
        let blkbits = u32::from(sb[12]);
        ensure!((9..=16).contains(&blkbits), "block size bits {blkbits}");
        let incompat = le32(sb, 80);
        ensure!(
            incompat & !INCOMPAT_KNOWN == 0,
            "unsupported incompatible features {incompat:#x}"
        );
        ensure!(le16(sb, 86) == 0, "extra devices");
        ensure!(
            sb[90] == 0,
            "a directory block size apart from the block size"
        );
        ensure!(sb[91] == 0, "long xattr name prefixes");
        let fs = Fs {
            image,
            blkbits,
            blksz: 1 << blkbits,
            root: u64::from(le16(sb, 14)),
            build_time: le64(sb, 24),
            meta: u64::from(le32(sb, 40)) << blkbits,
            xattr: u64::from(le32(sb, 44)) << blkbits,
            zero_padding: incompat & INCOMPAT_ZERO_PADDING != 0,
        };
        let blocks = u64::from(le32(sb, 36)) << blkbits;
        ensure!(
            blocks <= image.len() as u64,
            "the superblock says {blocks} bytes, the image has {}",
            image.len()
        );
        Ok(fs)
    }

    fn bytes(&self, at: u64, len: u64) -> Result<&'a [u8]> {
        let end = at
            .checked_add(len)
            .filter(|&e| e <= self.image.len() as u64);
        match end {
            Some(end) => Ok(&self.image[at as usize..end as usize]),
            None => bail!("{len} bytes at {at} are past the image's end"),
        }
    }

    fn inode(&self, nid: u64) -> Result<Inode> {
        let at = self.meta + (nid << 5);
        let head = self.bytes(at, 32)?;
        let format = le16(head, 0);
        ensure!(format & !0xf == 0, "inode format {format:#x}");
        let extended = format & 1 == 1;
        let layout = ((format >> 1) & 7) as u8;
        let icount = le16(head, 2);
        let mode = le16(head, 4);
        let (isize, size, u, uid, gid, mtime) = if extended {
            let b = self.bytes(at, 64)?;
            (
                64,
                le64(b, 8),
                le32(b, 16),
                le32(b, 24),
                le32(b, 28),
                le64(b, 32),
            )
        } else {
            (
                32,
                u64::from(le32(head, 8)),
                le32(head, 16),
                u32::from(le16(head, 24)),
                u32::from(le16(head, 26)),
                self.build_time,
            )
        };
        let kind = match mode & 0o170000 {
            0o100000 => Kind::File,
            0o040000 => Kind::Dir,
            0o120000 => Kind::Symlink,
            0o020000 => Kind::Char(u),
            0o060000 => Kind::Block(u),
            0o010000 => Kind::Fifo,
            0o140000 => Kind::Socket,
            other => bail!("file type {other:#o}"),
        };
        let xsize = if icount == 0 {
            0
        } else {
            12 + 4 * (u64::from(icount) - 1)
        };
        let xattrs = self.xattrs(at + isize, xsize)?;
        Ok(Inode {
            nid,
            kind,
            layout,
            mode,
            size,
            uid,
            gid,
            mtime,
            u,
            end: at + isize + xsize,
            xattrs,
        })
    }

    fn xattrs(&self, at: u64, size: u64) -> Result<Vec<(String, Vec<u8>)>> {
        if size == 0 {
            return Ok(vec![]);
        }
        let body = self.bytes(at, size)?;
        let shared = u64::from(body[4]);
        ensure!(12 + 4 * shared <= size, "{shared} shared xattrs do not fit");
        let mut out = vec![];
        for i in 0..shared {
            let id = u64::from(le32(body, 12 + 4 * i as usize));
            let entry = self.bytes(self.xattr + id * 4, 4)?;
            let len = 4 + u64::from(entry[0]) + u64::from(le16(entry, 2));
            out.push(xattr_entry(self.bytes(self.xattr + id * 4, len)?)?.0);
        }
        let mut rest = &body[12 + 4 * shared as usize..];
        while !rest.is_empty() {
            let (xattr, used) = xattr_entry(rest)?;
            out.push(xattr);
            rest = &rest[used.min(rest.len())..];
        }
        Ok(out)
    }

    /// A file's, directory's or link's bytes.
    fn data(&self, inode: &Inode) -> Result<Vec<u8>> {
        let size = inode.size;
        match inode.layout {
            0 => {
                if size == 0 {
                    return Ok(vec![]);
                }
                Ok(self
                    .bytes(u64::from(inode.u) << self.blkbits, size)?
                    .to_vec())
            }
            2 => {
                if size == 0 {
                    return Ok(vec![]);
                }
                let tail_start = (size - 1) / self.blksz * self.blksz;
                // With no whole blocks the address is EROFS_NULL_ADDR.
                let mut out = match tail_start {
                    0 => vec![],
                    _ => self
                        .bytes(u64::from(inode.u) << self.blkbits, tail_start)?
                        .to_vec(),
                };
                let tail = size - tail_start;
                ensure!(
                    inode.end % self.blksz + tail <= self.blksz,
                    "the inline tail crosses a block"
                );
                out.extend_from_slice(self.bytes(inode.end, tail)?);
                Ok(out)
            }
            1 | 3 => self.compressed(inode),
            other => bail!("data layout {other} (chunked or unknown) is not read here"),
        }
    }

    fn compressed(&self, inode: &Inode) -> Result<Vec<u8>> {
        let size = inode.size;
        if size == 0 {
            return Ok(vec![]);
        }
        let map = inode.end.div_ceil(8) * 8;
        let h = self.bytes(map, 8)?;
        ensure!(h[7] & 0x80 == 0, "a fragment inode");
        let advise = le16(h, 4);
        ensure!(
            advise & !ADVISE_KNOWN == 0,
            "compression advise {advise:#x} (tail packing or fragments)"
        );
        let algorithms = [h[6] & 15, h[6] >> 4];
        ensure!(h[7] & 7 == 0, "logical clusters larger than a block");
        if inode.layout == 3 {
            ensure!(
                (advise & ADVISE_BIG_PCLUSTER_1 == 0) == (advise & ADVISE_BIG_PCLUSTER_2 == 0),
                "compact indexes with big pcluster HEAD1 and HEAD2 apart"
            );
        }
        let z = Z {
            fs: self,
            inode,
            map,
            advise,
        };
        let total = size.div_ceil(self.blksz);
        // Each HEAD or PLAIN lcluster starts an extent that runs to the next.
        let mut heads = vec![];
        for lcn in 0..total {
            let l = z.lcluster(lcn)?;
            // A head at or past the end only ends the extent before it.
            if l.kind != TYPE_NONHEAD && (lcn << self.blkbits) | u64::from(l.clusterofs) < size {
                heads.push((lcn, l));
            }
        }
        ensure!(
            heads
                .first()
                .is_some_and(|(lcn, l)| *lcn == 0 && l.clusterofs == 0),
            "the first lcluster is not a head at 0"
        );
        let mut out = Vec::with_capacity(size as usize);
        for (i, (lcn, l)) in heads.iter().enumerate() {
            let la = (lcn << self.blkbits) | u64::from(l.clusterofs);
            let end = heads.get(i + 1).map_or(size, |(n, next)| {
                (n << self.blkbits) | u64::from(next.clusterofs)
            });
            ensure!(
                la == out.len() as u64 && la < end && end <= size,
                "extent {la}..{end} at lcn {lcn}"
            );
            let llen = (end - la) as usize;
            let big = match l.kind {
                TYPE_HEAD1 => advise & ADVISE_BIG_PCLUSTER_1 != 0,
                _ => advise & ADVISE_BIG_PCLUSTER_2 != 0,
            };
            let blocks = if big && (lcn + 1) < total {
                let next = z.lcluster(lcn + 1)?;
                match next.kind {
                    TYPE_NONHEAD if next.cblkcnt.is_some() => next.cblkcnt.unwrap_or(1),
                    TYPE_NONHEAD => bail!("no CBLKCNT after lcn {lcn}"),
                    _ => 1,
                }
            } else {
                1
            };
            ensure!(blocks > 0, "an empty pcluster at lcn {lcn}");
            let raw = self.bytes(l.pblk << self.blkbits, u64::from(blocks) << self.blkbits)?;
            match l.kind {
                TYPE_PLAIN => {
                    ensure!(llen <= raw.len(), "a plain extent longer than its pcluster");
                    if advise & ADVISE_INTERLACED != 0 {
                        ensure!(raw.len() as u64 == self.blksz, "an interlaced big pcluster");
                        let skip = (la % self.blksz) as usize;
                        let right = (raw.len() - skip).min(llen);
                        out.extend_from_slice(&raw[skip..skip + right]);
                        out.extend_from_slice(&raw[..llen - right]);
                    } else {
                        out.extend_from_slice(&raw[..llen]);
                    }
                }
                kind => {
                    let algorithm = algorithms[usize::from(kind == TYPE_HEAD2)];
                    ensure!(
                        algorithm == 0,
                        "compression algorithm {algorithm} (not LZ4)"
                    );
                    let start = if self.zero_padding {
                        raw.iter().position(|&b| b != 0).unwrap_or(raw.len())
                    } else {
                        0
                    };
                    ensure!(start < raw.len(), "an all-zero pcluster at lcn {lcn}");
                    out.extend(lz4(&raw[start..], llen).with_context(|| format!("lcn {lcn}"))?);
                }
            }
        }
        ensure!(out.len() as u64 == size, "{} of {size} bytes", out.len());
        Ok(out)
    }
}

/// One xattr entry: its full name, its value, and the aligned bytes it uses.
fn xattr_entry(b: &[u8]) -> Result<((String, Vec<u8>), usize)> {
    ensure!(b.len() >= 4, "a short xattr entry");
    let (name_len, index, value_len) = (usize::from(b[0]), b[1], usize::from(le16(b, 2)));
    let used = (4 + name_len + value_len).div_ceil(4) * 4;
    ensure!(
        4 + name_len + value_len <= b.len(),
        "an xattr past its body"
    );
    let prefix = match index {
        0 => "",
        1 => "user.",
        2 => "system.posix_acl_access",
        3 => "system.posix_acl_default",
        4 => "trusted.",
        5 => "lustre.",
        6 => "security.",
        other => bail!("xattr name index {other}"),
    };
    let name = format!("{prefix}{}", String::from_utf8_lossy(&b[4..4 + name_len]));
    Ok((
        (name, b[4 + name_len..4 + name_len + value_len].to_vec()),
        used,
    ))
}

/// A directory's entries: name, nid, file type.
fn dirents(data: &[u8], blksz: u64) -> Result<Vec<(String, u64, u8)>> {
    let mut out = vec![];
    for block in data.chunks(blksz as usize) {
        ensure!(block.len() >= 12, "a short directory block");
        let first = usize::from(le16(block, 8));
        ensure!(
            first >= 12 && first % 12 == 0 && first <= block.len(),
            "the first name at {first}"
        );
        let count = first / 12;
        for i in 0..count {
            let d = &block[i * 12..i * 12 + 12];
            let start = usize::from(le16(d, 8));
            let end = if i + 1 < count {
                usize::from(le16(block, (i + 1) * 12 + 8))
            } else {
                block.len()
            };
            ensure!(
                start <= end && end <= block.len(),
                "name {i} at {start}..{end}"
            );
            let mut name = &block[start..end];
            if i + 1 == count {
                name = &name[..name.iter().position(|&b| b == 0).unwrap_or(name.len())];
            }
            out.push((
                String::from_utf8_lossy(name).into_owned(),
                le64(d, 0),
                d[10],
            ));
        }
    }
    Ok(out)
}

struct Z<'a, 'b> {
    fs: &'b Fs<'a>,
    inode: &'b Inode,
    map: u64,
    advise: u16,
}

#[derive(Clone, Copy, Debug)]
struct Lcluster {
    kind: u8,
    clusterofs: u32,
    pblk: u64,
    cblkcnt: Option<u32>,
}

impl Z<'_, '_> {
    fn lcluster(&self, lcn: u64) -> Result<Lcluster> {
        if self.inode.layout == 1 {
            self.full(lcn)
        } else {
            self.compact(lcn)
        }
        .with_context(|| format!("lcluster {lcn} of nid {}", self.inode.nid))
    }

    fn full(&self, lcn: u64) -> Result<Lcluster> {
        let at = self.map + 8 + 8 + lcn * 8;
        let d = self.fs.bytes(at, 8)?;
        let advise = le16(d, 0);
        let kind = (advise & 3) as u8;
        if kind == TYPE_NONHEAD {
            let d0 = u32::from(le16(d, 4));
            ensure!(
                d0 & D0_CBLKCNT == 0
                    || self.advise & (ADVISE_BIG_PCLUSTER_1 | ADVISE_BIG_PCLUSTER_2) != 0,
                "CBLKCNT without big pclusters"
            );
            return Ok(Lcluster {
                kind,
                clusterofs: 0,
                pblk: 0,
                cblkcnt: (d0 & D0_CBLKCNT != 0).then_some(d0 & !D0_CBLKCNT),
            });
        }
        ensure!(advise & (1 << 15) == 0, "a partial reference (dedupe)");
        let clusterofs = u32::from(le16(d, 2));
        ensure!(
            u64::from(clusterofs) < self.fs.blksz,
            "cluster offset {clusterofs}"
        );
        Ok(Lcluster {
            kind,
            clusterofs,
            pblk: u64::from(le32(d, 4)),
            cblkcnt: None,
        })
    }

    /// z_erofs_load_compact_lcluster in erofs-utils' lib/zmap.c.
    fn compact(&self, lcn: u64) -> Result<Lcluster> {
        let fs = self.fs;
        let ebase = self.map + 8;
        let lclusterbits = fs.blkbits;
        let total = self.inode.size.div_ceil(fs.blksz);
        let big = self.advise & ADVISE_BIG_PCLUSTER_1 != 0;
        let initial_4b = ((32 - ebase % 32) / 4) & 7;
        let compacted_2b = if self.advise & ADVISE_COMPACTED_2B != 0 && initial_4b < total {
            (total - initial_4b) / 16 * 16
        } else {
            0
        };
        let (mut pos, mut i, mut shift) = (ebase, lcn, 2u32);
        if i >= initial_4b {
            pos += initial_4b * 4;
            i -= initial_4b;
            if i < compacted_2b {
                shift = 1;
            } else {
                pos += compacted_2b * 2;
                i -= compacted_2b;
            }
        }
        pos += i << shift;
        let vcnt: u64 = match (shift, lclusterbits) {
            (2, ..=14) => 2,
            (1, ..=12) => 16,
            _ => bail!("compact indexes for {lclusterbits}-bit lclusters"),
        };
        let pack = vcnt << shift;
        let base = pos / pack * pack;
        let in_ = fs.bytes(base, pack)?;
        let lobits = lclusterbits.max(12);
        let encodebits = ((pack - 4) * 8 / vcnt) as u32;
        let decode = |i: i64| -> (u32, u8) {
            let bit = encodebits as usize * i as usize;
            let mut word = [0u8; 4];
            let from = bit / 8;
            let n = (in_.len() - from).min(4);
            word[..n].copy_from_slice(&in_[from..from + n]);
            let v = u32::from_le_bytes(word) >> (bit & 7);
            (v & ((1 << lobits) - 1), ((v >> lobits) & 3) as u8)
        };
        let mut i = ((pos - base) >> shift) as i64;
        let (lo, kind) = decode(i);
        if kind == TYPE_NONHEAD {
            ensure!(big || lo & D0_CBLKCNT == 0, "CBLKCNT without big pclusters");
            return Ok(Lcluster {
                kind,
                clusterofs: 0,
                pblk: 0,
                cblkcnt: (lo & D0_CBLKCNT != 0).then_some(lo & !D0_CBLKCNT),
            });
        }
        ensure!(u64::from(lo) < fs.blksz, "cluster offset {lo}");
        let mut nblk: u64 = if big { 0 } else { 1 };
        if !big {
            while i > 0 {
                i -= 1;
                let (lo, kind) = decode(i);
                if kind == TYPE_NONHEAD {
                    i -= i64::from(lo);
                }
                if i >= 0 {
                    nblk += 1;
                }
            }
        } else {
            while i > 0 {
                i -= 1;
                let (lo, kind) = decode(i);
                if kind == TYPE_NONHEAD {
                    if lo & D0_CBLKCNT != 0 {
                        i -= 1;
                        nblk += u64::from(lo & !D0_CBLKCNT);
                        continue;
                    }
                    ensure!(lo > 1, "a big pcluster with delta {lo}");
                    i -= i64::from(lo) - 2;
                    continue;
                }
                nblk += 1;
            }
        }
        let first = u64::from(le32(in_, (pack - 4) as usize));
        Ok(Lcluster {
            kind,
            clusterofs: lo,
            pblk: first + nblk,
            cblkcnt: None,
        })
    }
}

/// The first `want` bytes an LZ4 block decodes to (as
/// LZ4_decompress_safe_partial); an error if it holds fewer or is broken.
pub fn lz4(src: &[u8], want: usize) -> Result<Vec<u8>> {
    let mut out: Vec<u8> = Vec::with_capacity(want);
    let mut i = 0;
    let byte = |i: &mut usize| -> Result<u8> {
        let b = *src.get(*i).context("the LZ4 block ends early")?;
        *i += 1;
        Ok(b)
    };
    while out.len() < want {
        let token = byte(&mut i)?;
        let mut literals = usize::from(token >> 4);
        if literals == 15 {
            loop {
                let b = byte(&mut i)?;
                literals += usize::from(b);
                if b != 255 {
                    break;
                }
            }
        }
        ensure!(i + literals <= src.len(), "LZ4 literals past the block");
        out.extend_from_slice(&src[i..i + literals]);
        i += literals;
        if out.len() >= want || i == src.len() {
            break;
        }
        let offset = usize::from(byte(&mut i)?) | usize::from(byte(&mut i)?) << 8;
        ensure!(
            offset > 0 && offset <= out.len(),
            "an LZ4 match {offset} back at {}",
            out.len()
        );
        let mut length = usize::from(token & 15) + 4;
        if token & 15 == 15 {
            loop {
                let b = byte(&mut i)?;
                length += usize::from(b);
                if b != 255 {
                    break;
                }
            }
        }
        let from = out.len() - offset;
        for k in 0..length.min(want - out.len()) {
            out.push(out[from + k]);
        }
    }
    ensure!(out.len() >= want, "LZ4 gave {} of {want} bytes", out.len());
    out.truncate(want);
    Ok(out)
}

/// Real images for the tests: tars written here (so a device or a
/// `trusted.*` xattr needs no `mknod` or root, on macOS too), turned into
/// EROFS by the `mkfs.erofs` in `PATH`, as keel-layers' tool tests do.
#[cfg(test)]
pub(crate) mod testing {
    use std::path::PathBuf;
    use std::process::Command;

    /// An erofs-utils tool from `PATH`; None, with a notice, when it is not
    /// there and `CUBE_TEST_LAYER_TOOLS` does not require it (`required`,
    /// or a list naming it).
    pub fn tool(name: &str) -> Option<PathBuf> {
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

    #[derive(Clone)]
    pub enum T {
        File(Vec<u8>),
        Dir,
        Link(&'static str),
        Char(u32, u32),
        Fifo,
    }

    #[derive(Clone)]
    pub struct E {
        pub path: String,
        pub t: T,
        pub mode: u32,
        pub uid: u32,
        pub gid: u32,
        pub mtime: u64,
        pub xattrs: Vec<(&'static str, Vec<u8>)>,
    }

    pub fn e(path: &str, t: T) -> E {
        let mode = match t {
            T::Dir => 0o755,
            T::Link(_) => 0o777,
            _ => 0o644,
        };
        E {
            path: path.into(),
            t,
            mode,
            uid: 0,
            gid: 0,
            mtime: 1_650_000_000,
            xattrs: vec![],
        }
    }

    fn pax(records: &[(String, Vec<u8>)]) -> Vec<u8> {
        let mut out = vec![];
        for (key, value) in records {
            let body = key.len() + value.len() + 3;
            let mut len = body + 1;
            while len.to_string().len() + body != len {
                len = len.to_string().len() + body;
            }
            out.extend_from_slice(format!("{len} {key}=").as_bytes());
            out.extend_from_slice(value);
            out.push(b'\n');
        }
        out
    }

    fn header(name: &str, kind: u8, size: usize, entry: Option<&E>) -> [u8; 512] {
        let mut h = [0u8; 512];
        let name = &name.as_bytes()[..name.len().min(100)];
        h[..name.len()].copy_from_slice(name);
        let (mode, uid, gid, mtime) =
            entry.map_or((0o644, 0, 0, 0), |e| (e.mode, e.uid, e.gid, e.mtime));
        h[100..107].copy_from_slice(format!("{mode:07o}").as_bytes());
        h[108..115].copy_from_slice(format!("{uid:07o}").as_bytes());
        h[116..123].copy_from_slice(format!("{gid:07o}").as_bytes());
        h[124..135].copy_from_slice(format!("{size:011o}").as_bytes());
        h[136..147].copy_from_slice(format!("{mtime:011o}").as_bytes());
        h[156] = kind;
        match entry.map(|e| &e.t) {
            Some(T::Link(target)) => h[157..157 + target.len()].copy_from_slice(target.as_bytes()),
            Some(T::Char(major, minor)) => {
                h[329..336].copy_from_slice(format!("{major:07o}").as_bytes());
                h[337..344].copy_from_slice(format!("{minor:07o}").as_bytes());
            }
            _ => {}
        }
        h[257..263].copy_from_slice(b"ustar\0");
        h[263..265].copy_from_slice(b"00");
        h[148..156].fill(b' ');
        let sum: u32 = h.iter().map(|&b| u32::from(b)).sum();
        h[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
        h
    }

    /// A pax tar of `entries`, in order; xattrs as `SCHILY.xattr.*`.
    pub fn tar(entries: &[E]) -> Vec<u8> {
        let mut out = vec![];
        for entry in entries {
            let mut records: Vec<(String, Vec<u8>)> = entry
                .xattrs
                .iter()
                .map(|(k, v)| (format!("SCHILY.xattr.{k}"), v.clone()))
                .collect();
            let name = match entry.t {
                T::Dir => format!("{}/", entry.path),
                _ => entry.path.clone(),
            };
            if name.len() > 100 {
                records.push(("path".into(), name.clone().into_bytes()));
            }
            if !records.is_empty() {
                let body = pax(&records);
                out.extend_from_slice(&header("pax", b'x', body.len(), None));
                out.extend_from_slice(&body);
                out.resize(out.len().next_multiple_of(512), 0);
            }
            let (kind, data): (u8, &[u8]) = match &entry.t {
                T::File(data) => (b'0', data),
                T::Dir => (b'5', b""),
                T::Link(_) => (b'2', b""),
                T::Char(..) => (b'3', b""),
                T::Fifo => (b'6', b""),
            };
            out.extend_from_slice(&header(&name, kind, data.len(), Some(entry)));
            out.extend_from_slice(data);
            out.resize(out.len().next_multiple_of(512), 0);
        }
        out.resize(out.len() + 1024, 0);
        out
    }

    /// `mkfs.erofs ARGUMENTS --tar=f` of `entries`, or None without the tool.
    pub fn image(name: &str, arguments: &[&str], entries: &[E]) -> Option<Vec<u8>> {
        let mkfs = tool("mkfs.erofs")?;
        let dir = std::env::temp_dir().join(format!("kac-erofs-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("in.tar"), tar(entries)).unwrap();
        let output = Command::new(mkfs)
            .args(arguments)
            .arg("--tar=f")
            .arg(dir.join("out.erofs"))
            .arg(dir.join("in.tar"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "mkfs.erofs {arguments:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let image = std::fs::read(dir.join("out.erofs")).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        Some(image)
    }

    /// `len` bytes that compress in some places and not in others.
    pub fn mixed(len: usize, seed: u64) -> Vec<u8> {
        let mut state = seed | 1;
        let mut next = move || {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state
        };
        let mut out = Vec::with_capacity(len);
        while out.len() < len {
            let r = next();
            if r % 3 == 0 {
                for _ in 0..(r >> 8) % 3000 {
                    out.push(next() as u8);
                }
            } else {
                let line = format!("line {} of the text, again {}\n", out.len(), r % 7);
                for _ in 0..(r >> 16) % 40 {
                    out.extend_from_slice(line.as_bytes());
                }
            }
        }
        out.truncate(len);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{E, T, e, image, mixed};
    use super::*;

    #[test]
    fn lz4_literals_matches_and_overlaps() {
        // "abc", then a match 3 back for 9 bytes (overlapping), then "!".
        let block = [0x35, b'a', b'b', b'c', 3, 0, 0x10, b'!'];
        assert_eq!(lz4(&block, 13).unwrap(), b"abcabcabcabc!");
        // A partial read stops where asked.
        assert_eq!(lz4(&block, 5).unwrap(), b"abcab");
        // Long literal and match lengths (15 + extension bytes).
        let mut long = vec![0xff, 255, 1];
        long.extend(std::iter::repeat_n(b'x', 271));
        long.extend([1, 0, 255, 6, 0x00]);
        let out = lz4(&long, 271 + 15 + 4 + 255 + 6).unwrap();
        assert!(out.iter().all(|&b| b == b'x'));
    }

    #[test]
    fn lz4_refuses_broken_blocks() {
        // A match before the start, a zero offset, literals past the end,
        // and a block that decodes to fewer bytes than asked.
        assert!(lz4(&[0x10, b'a', 2, 0], 10).is_err());
        assert!(lz4(&[0x10, b'a', 0, 0], 10).is_err());
        assert!(lz4(&[0x50, b'a'], 5).is_err());
        assert!(lz4(&[0x20, b'a', b'b'], 3).is_err());
        assert!(lz4(&[], 1).is_err());
    }

    #[test]
    fn no_superblock_is_an_error() {
        assert!(read_tree(&[]).is_err());
        assert!(read_tree(&[0u8; 8192]).is_err());
    }

    /// A tree with every kind of entry the driver looks at, and files that
    /// make plain, compressed and multi-lcluster extents.
    fn sample() -> Vec<E> {
        let mut out_txt = e("workspace/app/out.txt", T::File(b"built".to_vec()));
        (out_txt.uid, out_txt.gid, out_txt.mtime) = (1000, 1000, 1_700_000_000);
        let mut apt = e("etc/apt/apt.conf.d", T::Dir);
        apt.xattrs.push(("trusted.overlay.opaque", b"y".to_vec()));
        let mut setuid = e("opt/mode", T::File(b"x".to_vec()));
        setuid.mode = 0o4750;
        let noise: Vec<u8> = mixed(70_000, 3).iter().map(|b| b ^ 0x5a).collect();
        let deep = format!("opt/{}", "d".repeat(120));
        let mut all = vec![
            e("etc", T::Dir),
            e("etc/issue", T::Char(0, 0)),
            e("etc/null", T::Char(1, 3)),
            e("etc/apt", T::Dir),
            apt,
            e("etc/apt/apt.conf.d/only", T::File(b"mine\n".to_vec())),
            e("etc/link", T::Link("../opt/target")),
            e("etc/fifo", T::Fifo),
            e("workspace", T::Dir),
            e("workspace/app", T::Dir),
            out_txt,
            e("workspace/app/empty", T::File(vec![])),
            e("workspace/app/block", T::File(vec![7; 4096])),
            e("workspace/app/mixed", T::File(mixed(400_000, 7))),
            e("workspace/app/noise", T::File(noise)),
            e("workspace/app/zeros", T::File(vec![0; 200_000])),
            e("opt", T::Dir),
            setuid,
            e("opt/tagged", T::Dir),
            e(&deep, T::Dir),
            e(&format!("{deep}/name"), T::File(b"long".to_vec())),
        ];
        for i in 0..6u8 {
            let mut f = e(
                &format!("opt/tagged/{i}"),
                T::File(vec![b'a' + i; usize::from(i)]),
            );
            f.xattrs.push(("user.same", b"shared value".to_vec()));
            f.xattrs.push(("trusted.overlay.origin", vec![0, 0xfb, i]));
            all.push(f);
        }
        // Enough names for directories of several blocks.
        for i in 0..300 {
            let name = format!("opt/many-{i:03}-{}", "n".repeat(i % 40));
            all.push(e(&name, T::File(vec![])));
        }
        all
    }

    /// Every entry read back is what the tar held, and nothing else is there.
    fn same(tree: &[Entry], entries: &[E], forced_mtime: Option<u64>) {
        let root = tree.first().unwrap();
        assert_eq!((root.path.as_str(), root.kind), ("", Kind::Dir));
        assert_eq!(tree.len(), entries.len() + 1);
        for want in entries {
            let got = tree
                .iter()
                .find(|g| g.path == want.path)
                .unwrap_or_else(|| panic!("{} is missing", want.path));
            let (kind, data) = match &want.t {
                T::File(data) => (Kind::File, data.clone()),
                T::Dir => (Kind::Dir, vec![]),
                T::Link(target) => (Kind::Symlink, target.as_bytes().to_vec()),
                T::Char(major, minor) => (
                    Kind::Char((minor & 0xff) | (major << 8) | ((minor & !0xff) << 12)),
                    vec![],
                ),
                T::Fifo => (Kind::Fifo, vec![]),
            };
            assert_eq!(got.kind, kind, "{}", want.path);
            assert!(
                got.data == data,
                "{}: {} bytes differ",
                want.path,
                data.len()
            );
            let mtime = forced_mtime.unwrap_or(want.mtime);
            assert_eq!(
                (u32::from(got.mode), got.uid, got.gid, got.mtime),
                (want.mode, want.uid, want.gid, mtime),
                "{}",
                want.path
            );
            for (name, value) in &want.xattrs {
                assert_eq!(
                    got.xattr(name),
                    Some(value.as_slice()),
                    "{} {name}",
                    want.path
                );
            }
            assert_eq!(
                got.xattrs.len(),
                want.xattrs.len(),
                "{}: {:?}",
                want.path,
                got.xattrs
            );
        }
    }

    #[test]
    fn reads_what_mkfs_erofs_writes_as_the_agent_does_and_in_other_forms() {
        let entries = sample();
        for (name, arguments, mtime) in [
            // The agent's own form (template.rs).
            ("agent", &["-b4096", "-zlz4hc"][..], None),
            ("lz4", &["-b4096", "-zlz4"], None),
            ("big-pcluster", &["-b4096", "-zlz4hc", "-C65536"], None),
            ("plain", &["-b4096"], None),
            // One time for all: compact inodes, which carry no time.
            (
                "compact",
                &["-b4096", "-zlz4hc", "-T1600000000"],
                Some(1_600_000_000),
            ),
        ] {
            let Some(image) = image(name, arguments, &entries) else {
                return;
            };
            let tree = read_tree(&image).unwrap_or_else(|e| panic!("{name}: {e:#}"));
            same(&tree, &entries, mtime);
            let at = |p: &str| tree.iter().find(|e| e.path == p).unwrap();
            assert!(at("etc/issue").is_whiteout(), "{name}");
            assert!(!at("etc/null").is_whiteout(), "{name}");
        }
    }

    /// The agent builds from a directory (its `upper/`), not a tar.
    #[test]
    fn reads_an_image_mkfs_erofs_builds_from_a_directory() {
        use std::os::unix::fs::{MetadataExt, symlink};
        use std::time::{Duration, UNIX_EPOCH};
        let Some(mkfs) = testing::tool("mkfs.erofs") else {
            return;
        };
        let dir = std::env::temp_dir().join(format!("kac-erofs-dir-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let src = dir.join("upper");
        let files: [(&str, Vec<u8>); 5] = [
            ("workspace/app/out.txt", b"built".to_vec()),
            ("workspace/app/mixed", mixed(500_000, 9)),
            ("workspace/app/block", vec![1; 4096]),
            ("workspace/app/empty", vec![]),
            ("etc/apt/apt.conf.d/only", b"mine\n".to_vec()),
        ];
        for (rel, data) in &files {
            let path = src.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, data).unwrap();
        }
        let out_txt = std::fs::File::options()
            .write(true)
            .open(src.join("workspace/app/out.txt"))
            .unwrap();
        out_txt
            .set_modified(UNIX_EPOCH + Duration::from_secs(1_700_000_000))
            .unwrap();
        drop(out_txt);
        symlink("../../workspace/app/out.txt", src.join("etc/apt/link")).unwrap();
        let image = dir.join("layer.erofs");
        let status = std::process::Command::new(mkfs)
            .args(["--quiet", "-b4096", "-zlz4hc"])
            .arg(&image)
            .arg(&src)
            .status()
            .unwrap();
        assert!(status.success());
        let tree = read_tree(&std::fs::read(&image).unwrap()).unwrap();
        let mut walked = 0;
        for entry in &tree {
            let path = src.join(&entry.path);
            let meta = std::fs::symlink_metadata(&path).unwrap();
            let kind = if meta.is_dir() {
                Kind::Dir
            } else if meta.is_symlink() {
                Kind::Symlink
            } else {
                Kind::File
            };
            assert_eq!(entry.kind, kind, "{}", entry.path);
            assert_eq!(
                (u32::from(entry.mode), entry.uid, entry.gid, entry.mtime),
                (
                    meta.mode() & 0o7777,
                    meta.uid(),
                    meta.gid(),
                    meta.mtime() as u64
                ),
                "{}",
                entry.path
            );
            match kind {
                Kind::File => assert!(entry.data == std::fs::read(&path).unwrap()),
                Kind::Symlink => assert_eq!(
                    entry.data,
                    std::fs::read_link(&path)
                        .unwrap()
                        .into_os_string()
                        .into_encoded_bytes()
                ),
                _ => {}
            }
            walked += 1;
        }
        // The root, 5 directories, 5 files and a link.
        assert_eq!(walked, 12);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn what_it_does_not_read_is_an_error_not_a_skipped_file() {
        let entries = sample();
        for (name, arguments) in [
            ("ztailpacking", &["-b4096", "-zlz4hc", "-Eztailpacking"][..]),
            ("fragments", &["-b4096", "-zlz4hc", "-Efragments"]),
        ] {
            let Some(image) = image(name, arguments, &entries) else {
                return;
            };
            assert!(read_tree(&image).is_err(), "{name} was read");
        }
    }

    #[test]
    fn a_damaged_image_is_an_error() {
        let entries = sample();
        let Some(image) = image("damaged", &["-b4096", "-zlz4hc"], &entries) else {
            return;
        };
        assert!(read_tree(&image).is_ok());
        // Cut short: the superblock's size no longer fits.
        assert!(read_tree(&image[..image.len() - 4096]).is_err());
        // Another magic.
        let mut bad = image.clone();
        bad[1024] ^= 1;
        assert!(read_tree(&bad).is_err());
        // The root's inode made a regular file.
        let mut bad = image.clone();
        let sb = &image[1024..];
        let at = ((le32(sb, 40) as usize) << sb[12]) + ((le16(sb, 14) as usize) << 5);
        bad[at + 5] = (bad[at + 5] & 0x0f) | 0x80;
        assert!(read_tree(&bad).is_err());
        // Bytes flipped all over the image: an error or a tree, never a panic
        // or a hang.
        for i in (1024..image.len()).step_by(image.len() / 600) {
            let mut bad = image.clone();
            bad[i] ^= 0xa5;
            let _ = read_tree(&bad);
        }
    }
}
