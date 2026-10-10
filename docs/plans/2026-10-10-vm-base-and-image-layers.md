# VM base and image layers: one guest layout on Linux and macOS

Status 2026-10-10: research and plan. Work package 1 (kernel) is built and
boot-tested on the maintainer's Mac (`packages/vm-base/`); nothing else is
built and the runner does not use it yet. Written with the
maintainer before implementation; it settles the direction and the order of
work, not every interface. The work packages are sized so that cube threads
can build most of them; runner acceptance still needs a Linux host with KVM
and a Mac (see "Where the work can run").

## Why

A thread machine today boots the Debian 13 genericcloud qcow2 with firmware,
is configured on first boot by a cloud-init seed (`vm-seed.ts`), and a project
template is a sealed qcow2 that must be scrubbed of the build machine's
identity (ARCHITECTURE.md, "Templates"). That works, but:

- every boot runs firmware, GRUB and cloud-init before the guest helper is up;
- a template is a whole disk, so its integrity depends on the seal removing
  everything identity-bearing, and a deleted file's bytes may survive in a
  qcow2 cluster;
- the guest is one fixed image: a project cannot choose its own toolchain
  image;
- macOS (HVF, arm64 guests) and Linux (KVM, x86-64 guests) share the layout
  but boot through different firmware paths, and only Linux is verified.

The target is the layout used by containerd's VM runtime
[nerdbox](https://github.com/containerd/nerdbox): a small, versioned **VM
base** (kernel plus an init that cube owns) and the guest's root filesystem
assembled from **read-only EROFS layers** converted from OCI images, with
overlayfs and one writable disk on top. The same layout, QEMU arguments and
guest init run on both platforms; only the kernel and base image are built
per architecture.

## Target layout

```
published by cube (versioned, digest-pinned, per architecture)
  cube-vm-base: kernel + base.erofs (cube-init, cube-guest)

per thread machine
  vda  base.erofs                      read-only, shared by every VM
  vdb  layers.vmdk -> vdb1..vdbN       read-only, one GPT partition per layer
         image layers (OCI, converted to EROFS, cached by digest)
         template layer (the project's setup, EROFS)
  vdc  rw.qcow2 (ext4)                 writable, the thread's own, retained

guest root = overlayfs(lower = template, image layers N..1; upper = vdc)
```

QEMU arguments (both platforms, machine and accelerator as today):

```
-kernel <base>/vmlinuz
-append "console=<ttyS0|ttyAMA0> root=/dev/vda ro rootfstype=erofs init=/sbin/cube-init cube.vm=<id> cube.epoch=<n> ..."
-drive if=virtio,format=raw,readonly=on,file=<base>/base.erofs
-drive if=virtio,format=vmdk,readonly=on,file=<vm>/layers.vmdk
-drive if=virtio,format=qcow2,discard=unmap,file=<vm>/rw.qcow2
```

`-bios` and the seed drive go away once the per-machine data (keys,
placeholders, epoch) has another path in (the kernel command line for small
values, the control channel or a small read-only config disk for the rest).

## How each piece works

**EROFS.** A read-only, compact Linux filesystem (in the kernel since 5.4).
`mkfs.erofs` builds an image from a directory or straight from a tar stream
(`--tar=f`, no root needed, ownership and modes preserved); `--aufs` converts
OCI whiteouts (`.wh.*`) into overlayfs whiteouts so each OCI layer becomes a
valid overlay lower layer. Build every image with `-b4096` (on Apple Silicon
the default block size follows the host's 16 KiB pages and a 4 KiB guest
kernel rejects it; nerdbox documents the same), `-zlz4hc` (or `-zzstd` for
smaller layers; the kernel below has both) and `-T0 --all-time` for
reproducible digests. erofs-utils is in
Homebrew (1.9.4) and Debian.

**Layer disk.** Following nerdbox (`internal/erofs/gpt.go`, `vmdk.go`), the
layers of one machine are presented as one virtual disk: a small file with a
protective MBR and primary GPT (one partition per layer) followed by the layer
files, stitched together by a VMDK descriptor (`twoGbMaxExtentFlat`, one
`FLAT` extent per file). No layer is copied; the descriptor is a few lines of
text in the machine's directory, and every machine reads the same cached layer
files. This avoids one virtio-blk device per layer (nerdbox switches to the
GPT disk above 8 layers because of the `vda`..`vdz` limit; cube uses it
always, so the guest has one code path).

**Guest init.** `cube-init` (static, in `base.erofs`) mounts each layer
partition read-only as EROFS, formats the writable disk on first boot if it
is blank, mounts it, mounts overlayfs with the layers as `lowerdir` (first
listed is topmost) and the writable disk as `upperdir`/`workdir`, makes
`cube-guest` and its configuration available inside the new root (bind mount
from the base, so the image needs none of cube's files) and switches root.
nerdbox's `internal/vminit/ctrfs` is the reference for the mount sequence.

**Images.** The default image is an ordinary OCI image cube publishes (Debian
plus git and the tools threads use today). A project may name its own image;
it is pinned by digest, never by tag. The host fetches manifest and layers,
converts each layer once (`layers/sha256:<diff_id>.erofs`) and reads the
image configuration (Env, User, WorkingDir) for `cube-init`. Minimum image
requirements: `/bin/sh` and `git`; document them.

**Templates become a layer.** A build machine runs pre-setup and setup with an
empty writable disk; its overlay upper directory then contains exactly what
setup changed, already in overlay format. `mkfs.erofs` of that directory is
the template layer. Identity material (host keys, machine id, seed data) is
created at boot in the writable disk and never lands in the base or image
layers; setup must still not write secrets into the upper directory, so the
seal's checks remain for the template layer.

**Kernel.** Linux **7.2.9** (stable) for now, moving to the next longterm
release when kernel.org announces it. 7.x brings what this layout uses next:
order-0 free page reporting (7.1, more memory returned through the balloon),
virtio `IN_ORDER` (7.0) and opt-in fsync after overlayfs metadata copy-up
(7.0); virtio-rtc (6.16) keeps the guest clock right after pause and snapshot
restore. The configuration starts from nerdbox **v0.2.5**
(`28c86e8e16c62a08079531ebe99e24a7bdad3d62`),
`kernel/config-6.12.44-{arm64,x86_64}`. Checked 2026-10-10: both build in,
without modules, everything this layout needs: virtio-pci and -mmio,
virtio-blk, virtio-scsi, virtio-net, virtio-console (virtio-serial),
virtio-rng, virtio-balloon with `PAGE_REPORTING`, EROFS, overlayfs, ext4,
GPT partitions, cgroups, user namespaces, seccomp. Notes:
- `kernel/patches/` (vsock datagrams, "Transparent Socket Impersonation")
  serve nerdbox's libkrun VMM, not QEMU. Drop them and set `CONFIG_TSI` off.
- nerdbox's EROFS has LZ4 only; cube adds zstd.
- nerdbox's x86-64 config has no ACPI; cube enables it for q35.
- cube's additions are fragments merged before `make olddefconfig`; the build
  fails if a requested option does not survive or if modules are enabled
  (`packages/vm-base/README.md`).
- virtio-rtc appears in the guest as a PTP clock (`/dev/ptp0`, "Virtio PTP"),
  not as an RTC device; time sync after restore reads that clock (for example
  chrony's PHC reference clock).

## Verified so far

On the maintainer's Mac (Apple Silicon, QEMU 11.1.1 from Homebrew, HVF),
2026-10-10:

| Question | Result |
|---|---|
| Two EROFS files stacked by a VMDK descriptor with `FLAT` extents | `qemu-img convert` output is byte-identical to layer 1 + padding + layer 2 |
| A `RW <n> ZERO` extent line (nerdbox writes these as padding) | **silently ignored by QEMU**: virtual size dropped from 12 KiB to 8 KiB and layer 2 moved. Use a zero-filled file as a `FLAT` extent instead. |
| `virtio-serial-pci`, `virtserialport`, `virtio-balloon-pci` with `free-page-reporting` | present |
| `memory-backend-shm` | present |
| vsock, vhost-user devices, virtio-pmem | absent in this build |
| `migrate file:` and `-incoming file:` under HVF | completed and restored (paused) for an empty VM without a kernel; not yet with a running Linux guest |
| cube's 7.2.9 kernel, direct boot with `-kernel`/`-initrd`, arm64 under HVF and TCG, x86-64 (q35) under TCG | QEMU start to power-off with the whole smoke: 0.08–0.15 s arm64/HVF, 0.8 s arm64/TCG, 1.6 s x86-64/TCG; virtio-rtc binds; LZ4 and zstd EROFS layers mount from virtio-blk; overlayfs of both with a tmpfs upper reads and writes correctly; clean power-off (`packages/vm-base/smoke/`) |

| Snapshot and resume of a running guest, arm64/HVF, 512 MiB (`packages/vm-base/snapshot/test.py`) | boot to first message 0.07 s; `stop` + `migrate file:` 0.24 s, file 36 MiB (mostly zero pages skipped; 53 MiB on disk with `mapped-ram`); new QEMU loads the state in 0.07–0.15 s; the guest continues with the next message on virtio-serial, EROFS reads keep working. Guest `CLOCK_MONOTONIC` and `CLOCK_REALTIME` do not advance while suspended (realtime is behind by the pause); the virtio-rtc PTP clock is within 1–7 ms of the host. Same result under TCG. |

Not verified: anything on Linux/KVM (x86-64 was only booted under TCG on the
Mac), the layer disk (GPT + VMDK) inside a guest, overlay of real OCI layers,
balloon memory release.

## Built for snapshot and resume

Suspending idle threads to a file and resuming them is the next step after
this layout, so the guest is designed for it from the start (measured above):

- **Clock.** The guest's clocks stop while it is suspended. After every resume
  the guest agent steps `CLOCK_REALTIME` from the virtio-rtc PTP clock
  (`/dev/ptp0`); the host tells it over the control channel that it resumed.
  Timeouts measured on `CLOCK_MONOTONIC` do not count suspended time; decide
  per timeout whether that is wanted.
- **Control channel.** The host end is a new socket after restore and anything
  in flight at the snapshot is lost; a guest write fails until the host is
  connected again. The protocol reconnects and every operation is idempotent
  by key with epoch fencing, as today's operations already are.
- **Disks.** Base and layer disks are read-only and always match. The writable
  disk must be exactly the state saved with the memory: suspend is stop, save,
  quit, and a machine is never booted from that disk while its memory file
  exists (a cold boot deletes the memory file first). Snapshots of a machine
  that keeps running need a qcow2 overlay taken at the same instant (later).
- **Same machine on restore.** Pin the machine type (`virt-11.1`,
  `pc-q35-11.1`) and record the QEMU version with each snapshot; after a QEMU
  upgrade old snapshots are dropped and the machine boots cold. `-cpu host`
  ties a snapshot to its runner, which is where it stays.
- **Memory.** The file holds the pages in use; free page reporting through the
  balloon keeps that small. `mapped-ram` loads faster and gives fixed offsets.
- **Identity after boot, not at boot.** Machine identity (VM id, epoch,
  placeholders, hostname) reaches the agent over the control channel, not the
  kernel command line, so a snapshot of a booted template can later be
  restored as many machines. Clones then also need a fresh random seed: QEMU's
  `vmgenid` exists only for x86 in this build, so the host sends entropy and
  the agent reseeds on arm64.

## Decisions

- One guest layout, one set of QEMU arguments and one `cube-init` for Linux
  and macOS; architecture only selects the kernel and base build.
- QEMU stays the VMM. No vsock dependency, because QEMU on macOS has none; the
  later control channel uses virtio-serial on both platforms.
- The nerdbox v0.2.5 kernel config is the starting point, without its libkrun
  patches, on Linux 7.2.9 until the next longterm release.
- OCI is the build and distribution format for images. The runner never needs
  registry credentials: public images may be fetched by the runner; private
  images are a later decision (cubed or the gateway fetches; credentials never
  reach a runner or guest).
- The layer disk is always the GPT + VMDK form, padded with `FLAT` zero
  files, never `ZERO` extents.

## Work packages

Each package lists where it can be done (see below) and what counts as done.

**0. Reference snapshot.** Add nerdbox v0.2.5 as a subtree under `repos/`,
add its row to `repos/README.md`, and make `pnpm check:references` accept a
reference without a consuming package (today every row has consumers).
Thread. Done: subtree present, check passes.

**1. Kernel build.** Built: `packages/vm-base/kernel/build.sh` (Linux 7.2.9,
pinned source hash, digest-pinned Debian builder, about 2 minutes per
architecture on the Mac) and `packages/vm-base/smoke/`. Done on the Mac (HVF
and TCG). Remaining: the smoke under KVM on the Linux runner host, and a
rebuild check that two builds give the same `vmlinuz` hash.

**2. Layer tooling (Rust, runner side).** OCI layer tar to EROFS by calling
`mkfs.erofs -b4096 -zlz4hc -T0 --all-time --tar=f --aufs`, cache keyed by
diff ID with atomic publish; GPT header and VMDK descriptor writer with
`FLAT` padding. Thread. Done: unit tests, including a `qemu-img convert`
byte comparison and a regression test that no descriptor contains `ZERO`.

**3. cube-init.** Static binary in `base.erofs`: mount sequence above, first
boot formatting, binding `cube-guest` into the new root, clear failure output
on the console. Thread (TCG). Done: the default image boots to a shell from
layers + writable disk under TCG, KVM and HVF; a second boot keeps the
writable disk's changes.

**4. VM base and default image.** CI builds `cube-vm-base` (kernel +
`base.erofs`) and the default OCI image per architecture, with digests.
Publishing to a registry or a release needs explicit authorization. Thread
for the build; publishing by the maintainer. Done: digests reproducible
across two builds.

**5. Runner integration.** `qemu_args` direct boot, per-machine
`layers.vmdk`, writable qcow2 retained like today's disk, image fetch and
layer cache with garbage collection and the journal's retention rules,
templates as an EROFS layer. This changes the runner protocol and state, so
it needs a new `CUBED_STATE` (old registries are not migrated) and updates to
ARCHITECTURE.md, docs/platforms.md and docs/runner-operations.md. Thread for
the code; acceptance on hosts. Done: `CUBE_TEST_VM_IMAGE=... CUBE_TEST_VM=required
bash scripts/test-node-transport.sh` on Linux/KVM and the same smokes on a Mac.

**6. Control channel over virtio-serial** (separate plan). Replaces SSH
through the gateway for workspace commands; keeps epoch fencing and stable
invocation identity; adds a multiplexing layer. Changes the sandbox
description: the channel is not network, but it is a new guest-to-host path
the host must treat as hostile.

**7. Memory.** `virtio-balloon` with `free-page-reporting=on`; measure that
QEMU's resident memory falls after the guest frees memory, on both platforms.

**Later.** Whole-machine snapshots for idle threads (`migrate file:`),
private images, virtio-pmem/DAX on Linux only.

## Where the work can run

Thread machines run with HTTP/HTTPS egress only and, as far as known, without
nested virtualization, so a thread can build kernels and images and boot them
with QEMU's TCG (slow, but enough for boot and mount tests). KVM and HVF
acceptance, runner smokes and `scripts/test-node-transport.sh` need the Linux
host and the Mac. Mocks are not runner acceptance.

## Open questions

- Who fetches private images, and where their credentials live.
- Image allow-listing per installation or project.
- Layer cache size limits and when unused layers are deleted.
- Whether to keep qcow2 templates during a transition or switch at once (a new
  `CUBED_STATE` either way).
- Kernel update policy: when to move from 7.2.y to the next longterm release,
  and who watches stable releases for security fixes until then.
- The small per-machine data that the seed carries today: kernel command line,
  config disk or the control channel.
