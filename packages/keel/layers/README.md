# keel-layers

keel's image layers on the runner side, work package 3 of
[the keel plan](../../../docs/plans/2026-10-10-vm-base-and-image-layers.md).
A library; no runner calls it yet (`berth vm` will, from B-7 on).

```text
registry blob (tar, tar+gzip, tar+zstd)
  convert  decompress as a stream, check the diff_id, pipe into
           mkfs.erofs -b4096 -zlz4hc --tar=f -T0 --all-time --aufs -U <uuid from diff_id>
  cache    <dir>/sha256:<diff_id>.erofs, built under .tmp-*, made read-only,
           synced, renamed into place; LRU eviction over unreferenced layers
  disk     <machine>/layers.vmdk: layers.head (MBR + GPT) | layer files |
           layers.zero (4 KiB alignment) | layers.tail (backup GPT),
           every extent FLAT, partition N = layer N
```

- **Same layer, same bytes.** `-T0 --all-time` and a UUID derived from the
  `diff_id` make conversion reproducible: a layer gives the same file from
  plain, gzip or zstd blobs (tested). The layer disk depends only on the
  layers' names and sizes.
- **Checked input.** The uncompressed tar's SHA-256 must equal the
  `diff_id`; otherwise, or if `mkfs.erofs` fails, nothing is published.
  gzip may have several members and zstd several frames (zstd:chunked).
- **`mkfs.erofs` by path.** The caller passes the program, as it passes
  QEMU's (A17 in the masterplan); nothing here searches `PATH`.
- **No `ZERO` extents.** QEMU silently ignores `RW <n> ZERO` lines, which
  would shrink the disk and move every later layer; padding is a zero file
  as a `FLAT` extent, and the writer refuses a descriptor with anything but
  `FLAT`.
- **Eviction (U6).** `LayerCache::evict(limit, in_use)` removes the least
  recently used layers no machine references until the cache fits the
  limit; `get` and `publish` mark a layer used. The limit's place in
  `host.json` and when to call it are the runner's (B-7).
- **Not here:** fetching (index, manifest per platform, anonymous tokens,
  public images only: B-7), deduplicating concurrent conversions of one
  layer, template layers (K-5e, B-8).

## `--tar=f` or `--tar=i` (U5)

Measured with `scripts/keel-layer-bench.ts` on 2026-10-10, through this
crate's code path (`examples/layers.rs`), in a cube thread VM: x86-64, 2
vCPUs, 3 GiB, Debian 13, erofs-utils 1.8.6, `linux/amd64` manifests from
Docker Hub. Three runs per mode, interleaved, each into an empty cache;
times are medians (min–max) for the whole image.

| image (manifest) | layers | gzip MiB | tar MiB | `--tar=f` s | `--tar=f` MiB | `--tar=i` s | `--tar=i` MiB |
|---|---|---|---|---|---|---|---|
| `debian:trixie` (`sha256:bcf83fd8af41…`) | 1 | 47.1 | 118.3 | 2.07 (2.07–2.09) | 70.0 | 1.21 (1.19–1.21) | 118.8 |
| `buildpack-deps:trixie` (`sha256:b9f4efdac77b…`) | 4 | 362.2 | 996.5 | 17.18 (17.02–17.24) | 529.0 | 9.62 (9.60–9.71) | 999.3 |
| `node:24-trixie` (`sha256:34f08d4a9e30…`) | 8 | 420.4 | 1197.8 | 20.29 (20.23–20.30) | 624.1 | 11.62 (11.56–11.88) | 1201.0 |

Where the time goes, for the largest layer (638 MiB tar, 226 MiB gzip):
`zcat` alone 3.4 s; `mkfs.erofs --tar=f` alone on the plain tar 6.7 s wall,
11.5 s CPU (LZ4HC on two workers); `--tar=i` alone 0.13 s. Both modes are
CPU-bound on two vCPUs: `--tar=i` by decompression and hashing in this
crate, `--tar=f` by LZ4HC sharing the cores with them.

Reading it back: `node:24-trixie`'s eight layers as one layer disk, served by
`qemu-nbd -r -f vmdk` (QEMU's own VMDK driver), partitions found by the
kernel (6.12), mounted as EROFS, overlaid, and the whole root read with
`tar -c` after dropping caches (1,250,027,520 bytes, three runs each):
`--tar=f` 3.52 s (3.47–3.65), `--tar=i` 3.68 s (3.67–3.68). `node --version`
ran from both roots (`v24.21.0`).

**Choice: `--tar=f`.** It takes about half the disk (624 against 1201 MiB
for `node:24-trixie`) and the same time to read, and its extra conversion
time (1.7–1.8×) is paid once per layer per runner. `--tar=i` stays in the
crate (`TarMode::Index`) so the measurement can be repeated; runners use
`TarMode::Full`. Not measured: a Mac (Apple Silicon, Homebrew erofs-utils),
reads inside a keel guest (K-4), more than one run per idle host.
