# keel

keel is everything cube puts inside a thread machine before the project's
own software: the part the rest is built on, as a ship's keel is laid first.
A runner boots it directly with QEMU, without firmware, on Linux (KVM, x86-64
guests) and macOS (HVF, arm64 guests) alike:

- **the guest kernel** (built here today);
- **`cube-init`**, a small PID 1 in C that brings the machine up, starts the
  guest agent and starts it again if it dies ([`init/`](init), in
  `base.erofs`);
- **`cube-agent`**, the guest agent in Rust: it talks to the runner over a
  virtio-serial control channel, assembles the project's root filesystem from
  the machine's read-only EROFS image layers and its writable disk with
  overlayfs, and runs commands and services, replacing SSH, cloud-init,
  systemd and the Python helper in the guest ([`agent/`](agent): channel,
  `machine_setup`, commands, files, services, the `cube` command,
  generated files, the runner's CA, the clock, hooks, template
  publishing and the snapshot hooks `snapshot_prepare`/`snapshot_done`);
- **the layer format**: OCI images converted to EROFS and stacked as one
  disk, built on the runner by [`layers/`](layers) (`keel-layers`).

keel is designed for fast boot and for QEMU snapshot and resume. It will be
versioned and released on its own, since kernel security fixes do not follow
cubed's releases, and cube will pin a keel version. See
[docs/plans/2026-10-10-vm-base-and-image-layers.md](../../docs/plans/2026-10-10-vm-base-and-image-layers.md)
for the design and the work packages.

keel's runner is `berth vm` ([`../berth`](../berth), runner protocol 4). It
boots keel machines under the QEMU, kernel and `base.erofs` it is given by
absolute path (`--qemu`, `--qemu-img`, `--keel`), with `-sandbox on` on
Linux. cubed talks to it over a RunnerSession (`runner-select.ts`), and a
thread that names no runner is placed only on an enrolled `berth vm`
(`registry.ts` `pooledRunner`). The protocol-3 runner, `cube-runner`
(`packages/node-transport`), does not use keel. Whether a given cubed has a
`berth vm` enrolled is up to its operator.

## Startup, as measured

These are separate series, each with its own interval and setup. They are
not parts of one another, and their numbers do not add up.

- **Test inits, before the agent and berth** (the plan's «Verified so far»,
  arm64/HVF): QEMU start to power-off has a median of 128 ms. Boot to the
  first message on virtio-serial takes 0.07 s, and a suspended 512 MiB guest
  loads again in 0.07–0.15 s.
- **`berth vm` alone, Linux/KVM** (`scripts/berth-hello-timing.ts`; one
  x86-64 host, 2 vCPU, 1024 MiB, network on, release berth over loopback).
  21 starts of one machine; the first, which formats the writable disk, is
  left out. These restart a machine that is already set up, not a new
  thread. Medians of 20:
  - `machineStart` → the agent's `hello`: **470 ms**, in an earlier series
    taken before the script waited for ready.
  - From the later series, `machineStart` → that same session's `ready`
    (after `machine_setup`): **509.5 ms**. Its `hello` → `ready` is
    **32 ms**, and its `hello` is 472.5 ms.
- **Through cubed, Linux/KVM** (a cubed fixture and `berth vm` over loopback
  on the same host; 2 vCPU, 2048 MiB; 20 threads in a row from one prepared
  template). cubed's create → machine ready for the agent (`startup.totalMs`)
  has a median of **4212 ms**. The wall time from the API request to
  `available` has a median of about 5.3 s.

Both Linux/KVM series were taken on 2026-10-17. macOS/HVF has no `berth vm`
numbers yet, because the Mac series wait for host capacity. The splits inside each interval
(QEMU and firmware, kernel, agent start, cubed's own steps) are not measured.

## Kernel

Linux **7.2.9** (stable), built for arm64 (macOS/HVF runners) and x86-64
(Linux/KVM runners). The plan is to move to the next longterm release once
kernel.org announces it.

`kernel/defconfig-<arch>` is the whole configuration, as `make savedefconfig`
writes it (only what differs from the kernel's defaults). It was derived from
[nerdbox](https://github.com/containerd/nerdbox) v0.2.5's kernel config
(`28c86e8e16c62a08079531ebe99e24a7bdad3d62`, Apache-2.0) with these changes:
virtio-rtc (the guest clock after pause or snapshot restore), zstd EROFS
layers, ACPI on x86-64, `VMGENID`, vsock off, and none of nerdbox's libkrun
patches. The kernel is
self-contained: no modules.

```sh
packages/keel/kernel/build.sh                    # both architectures
packages/keel/kernel/build.sh arm64              # one
KEEL_REFRESH=1 packages/keel/kernel/build.sh     # after changing the version
KEEL_CACHE=/path/to/keel-cache packages/keel/kernel/build.sh  # reuse a build
```

The build fails if the defconfig does not describe the kernel exactly, which
is what a version bump that renames or drops an option causes; `KEEL_REFRESH=1`
writes the new defconfig back so the change shows up in review. It also fails
if modules are enabled.

Requirements: Docker (or OrbStack) and network access to cdn.kernel.org.
The source tarball is checked against a pinned SHA-256 and the build runs in a
digest-pinned Debian 13 container with a fixed build time, so the same inputs
give the same `vmlinuz`. Output: `out/<arch>/vmlinuz`, `config` and
`vmlinuz.sha256` (`out/` and `.cache/` are ignored by git).

QEMU needs the `virtio-rtc-pci` device (Homebrew's QEMU 11.1.1 has it).

## cube-init and the base

`base.erofs` is the read-only root every machine boots from (`vda`,
`root=/dev/vda ro rootfstype=erofs init=/sbin/cube-init`): `cube-init`, the
agent, and static `mke2fs`, `e2fsck` and `mkfs.erofs` built from pinned
sources (lz4 1.10.0, e2fsprogs 1.47.3, erofs-utils 1.8.6) in the kernel's
pinned Debian container.

```sh
packages/keel/base/build.sh                      # both architectures
packages/keel/base/build.sh x86_64               # one
KEEL_CACHE=/path/to/keel-cache packages/keel/base/build.sh x86_64
```

Output: `out/<arch>/base.erofs`, `base.erofs.sha256` and `base.txt` (the
files and their digests), and `base-standin.erofs` (below). Two builds of
the same inputs give the same image. `cube-agent` is built in the same
container with the Rust of `rust-toolchain.toml` (rustup-init pinned by
sha256), static musl, linked by the toolchain's `rust-lld`.

[`init/cube-init.c`](init/cube-init.c) is PID 1: proc, sysfs, devtmpfs,
devpts, `/dev/shm`, tmpfs on `/run` and `/tmp`, cgroup2 with `cpu cpuset io
memory pids` in the root's `subtree_control`, loopback up; then it starts
`/sbin/cube-agent`, starts it again when it ends (100 ms, doubling to 5 s
while it keeps failing), reaps every orphan, and on SIGTERM, SIGUSR2 or
SIGPWR powers off (SIGINT, Ctrl-Alt-Del, reboots): SIGTERM to the agent,
then to everything, SIGKILL, sync, unmount, `reboot(2)`. Its messages start
with `cube-init:` on the console, also with `quiet`.

`/sbin/cube-agent` is [`agent/`](agent): protocol 4's `DaemonFrame` on the
`cube.0` port, `machine_setup` (the layer disk's partitions read-only as
EROFS in the runner's order, topmost first; the writable disk formatted when
blank or checked with `e2fsck -p`; the overlay with `upper/`, `work/` on
`vdc` and `state/` at `/var/lib/cube`, in a mount namespace of its own) and
`OPERATIONS`' commands with cube-guest's journal. Its README says what it
does and what later rows add.

`base-standin.erofs` is the same root with the boot check's **stand-in**
([`init/agent-standin.c`](init/agent-standin.c)) as `/sbin/cube-agent`: a
line protocol on `cube.0` that sets up the same disks and runs commands as
root, for `scripts/keel-boot-check.ts` only. It is never a keel asset; a
release ships `base.erofs`.

## Reusing a build across clones

A kernel or base build is slow and its inputs rarely change, so with
`KEEL_CACHE` set to a directory, `kernel/build.sh` and `base/build.sh` keep
what they build there and reuse it from any clone on the same host. The key
is the contents of the build's inputs, not a commit: the same tree on a
branch, in a worktree or in a fresh clone finds the same entry.

```sh
export KEEL_CACHE=/var/cache/keel            # any absolute path you own
packages/keel/kernel/build.sh x86_64        # builds, then stores
packages/keel/base/build.sh x86_64          # builds, then stores
# in another clone, with the same inputs, neither starts Docker:
packages/keel/kernel/build.sh x86_64        # x86_64: keel cache hit <key> <sha256 …
```

Each architecture is looked up by itself. With no argument the scripts build
`arm64 x86_64`, so a cache that holds one of them hits for the other and
builds only the missing one; the hit line ends with the outputs' sha256 (the
base's line has both images'). `KEEL_CACHE` may be relative: it means the
directory the build was started in.

| | keyed on (contents) | invalidated by |
|---|---|---|
| kernel | `cache.sh`, `kernel/build.sh`, `kernel/build-in-container.sh`, `kernel/defconfig-<arch>` | any of those, for that arch |
| base | `cache.sh`, `base/`, `init/`, `agent/`, `runner-protocol/`, `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `packages/*/Cargo.toml` | any of those, for both arches |

The builder's architecture is in the key too. An entry is
`$KEEL_CACHE/v1/<kind>/<arch>/<key>/`: the outputs, `inputs.txt` (the
manifest the key was made from), `provenance.txt` (key, HEAD, builder image,
versions, time) and `SHA256SUMS`, which is written last and means the entry
is complete. Every hit is verified against it; an entry that does not verify
stops the build and is named, and an incomplete one is built again instead.
Storing is atomic, so two builds of one host can run at once: the second
compares only the outputs' hashes with the first, if that one has finished
writing, and warns if they differ.
The pinned sources come from `$KEEL_CACHE/v1/src`, so they are downloaded
once per cache.

Nothing changes when `KEEL_CACHE` is unset. The cache is bypassed, building
as before with one line saying why, when `KEEL_REFRESH=1` or
`DOCKER_DEFAULT_PLATFORM` is set, outside a git work tree, with changed,
untracked or ignored files among the inputs, or with a quoted or non-file
input path. `packages/keel/cache.sh key <kernel|base> [arch ...]` prints the
key a build would use, or the reason it would be bypassed.

## Boot check

`scripts/keel-boot-check.ts` boots `base-standin.erofs` with the kernel on a public
image's layers (default `debian:trixie`, pinned by digest) plus two test
layers (a file shadowed across layers, whiteouts, opaque directories),
converted and stacked with `keel-layers`, and a blank `rw.qcow2`. It checks
the workload root, an agent restart, a second boot on the same disk, an
unclean stop, and snapshots, then measures boot and snapshot times:

```sh
cargo build --release -p keel-layers --example layers
node scripts/keel-boot-check.ts --qemu PATH/qemu-system-x86_64 --qemu-img PATH/qemu-img \
  --kernel packages/keel/out/x86_64/vmlinuz --base packages/keel/out/x86_64/base-standin.erofs \
  --mkfs /usr/bin/mkfs.erofs --layers target/release/examples/layers \
  --out /var/tmp/keel-boot --arch x86_64 --accel tcg|kvm|hvf --boots 20 --snapshots 10
```

QEMU is given by path; the check reads keel's floor from that binary and
refuses one below it. The same arguments run on Linux and macOS (machine
type, console and accelerator aside). Snapshots `stop`, `migrate` to `file:`
with `mapped-ram` in migration mode `cpr-reboot`, `quit`, and load in a new
QEMU with `-incoming defer`: QEMU's vmdk driver blocks migration in mode
`normal`, and the layer disk is a VMDK descriptor. Results go to
`OUT/results.json`, with each boot's argv and console log under `OUT/runs`.

## Agent check

`keel-agent-check` ([`agent-check/`](agent-check)) boots `base.erofs` with
the real agent and talks `DaemonFrame` to it as a VM runner will: hello and
status, setups it refuses and applies, readiness, the workload root, the
journal, an agent restart under a running command, a power-off and a second
boot with no runner connected while it boots, a runner that disconnects and
connects again (the agent must not spin meanwhile), immediate reconnects
and a forced late `hello` recovered by the reset on channel 0, three
restores with the runner connected before `cont`, each after
`snapshot_prepare` with an operation held and never run, a failed save
after which `snapshot_done` lets the held operation run, file operations that
stay in the workload root and act as `agent` out of the workspace,
services started with `cube` (across an agent restart, after a boot, killed,
failing and done), the generated files and the runner's CA, `cube hooks`,
the clock after a pause, and the Workspace contract (leases, files,
commands, services, the resume hook) over the channel. The command
is in [`agent/README.md`](agent/README.md).

## Layers

[`layers/`](layers) is the runner's side of the layer format, a Rust
library: an OCI layer to EROFS with `mkfs.erofs --tar=f`, the layer cache
by `diff_id`, and a machine's layer disk (GPT + VMDK descriptor, `FLAT`
extents only). Its README has the measurements behind `--tar=f`.
