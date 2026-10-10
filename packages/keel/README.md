# keel

keel is everything cube puts inside a thread machine before the project's
own software: the part the rest is built on, as a ship's keel is laid first.
A runner boots it directly with QEMU, without firmware, on Linux (KVM, x86-64
guests) and macOS (HVF, arm64 guests) alike:

- **the guest kernel** (built here today);
- **`cube-init`**, a small PID 1 that assembles the root filesystem from the
  machine's read-only EROFS image layers and its writable disk with overlayfs
  (planned);
- **the guest agent** that runs commands and services for cubed over a
  virtio-serial control channel, replacing SSH, cloud-init and systemd in the
  guest (planned);
- the layer format: OCI images converted to EROFS and stacked as one disk.

keel is designed for fast boot and for QEMU snapshot and resume: a guest
starts in about 0.1 s and a suspended one resumes in about the same
(measurements in the plan). It will be versioned and released on its own, since
kernel security fixes do not follow cubed's releases, and cube will pin a keel
version. See
[docs/plans/2026-10-10-vm-base-and-image-layers.md](../../docs/plans/2026-10-10-vm-base-and-image-layers.md)
for the design and the work packages. Nothing in the runner uses keel yet.

## Kernel

Linux **7.2.9** (stable), built for arm64 (macOS/HVF runners) and x86-64
(Linux/KVM runners). The plan is to move to the next longterm release once
kernel.org announces it.

The configuration starts from [nerdbox](https://github.com/containerd/nerdbox)
v0.2.5 (`28c86e8e16c62a08079531ebe99e24a7bdad3d62`, Apache-2.0),
`kernel/config-6.12.44-{arm64,x86_64}`, copied unchanged into
`kernel/nerdbox-v0.2.5/`. nerdbox's kernel patches are for its libkrun VMM and
are not applied. cube's changes are in `kernel/cube.fragment` and
`kernel/cube-<arch>.fragment`: virtio-rtc (the guest clock after pause or
snapshot restore), zstd EROFS layers and, on x86-64, ACPI. The build merges
them, runs `make olddefconfig`, fails if any requested option did not survive
or if modules are enabled, and writes the resolved configuration to
`kernel/config-<version>-<arch>` so every change is visible in review.

```sh
packages/keel/kernel/build.sh            # both architectures
packages/keel/kernel/build.sh arm64      # one
```

Requirements: Docker (or OrbStack) and network access to cdn.kernel.org.
The source tarball is checked against a pinned SHA-256 and the build runs in a
digest-pinned Debian 13 container. Output: `out/<arch>/vmlinuz`, `config`
and `vmlinuz.sha256` (`out/` and `.cache/` are ignored by git).

## Smoke test

`smoke/` boots a kernel under QEMU with a static test init as PID 1 and two
EROFS layers (LZ4 and zstd). The init checks that the virtio-rtc driver binds,
mounts both layers, stacks them with overlayfs on a tmpfs upper, writes through
the overlay and powers off. It prints `cube-smoke: ok` on success.

```sh
packages/keel/smoke/build.sh             # initramfs + layers, both architectures
packages/keel/smoke/run.sh arm64         # hvf on an Apple Silicon Mac
packages/keel/smoke/run.sh x86_64        # kvm on Linux x86-64, tcg elsewhere
packages/keel/smoke/run.sh arm64 tcg     # force software emulation
```

## Snapshot test

`snapshot/test.py` boots the kernel with `snapshot/tick.c` as init (a message
every 200 ms on the virtio-serial port `cube.0`), saves the running machine
with `migrate file:`, quits, waits, restores it in a new QEMU and checks that
the messages continue, the EROFS disk still reads and how the guest clocks
compare with the host's.

```sh
packages/keel/snapshot/test.py arm64                  # hvf on an Apple Silicon Mac
packages/keel/snapshot/test.py arm64 --mapped-ram
packages/keel/snapshot/test.py x86_64                 # kvm on Linux x86-64
```

The QEMU build must have the `virtio-rtc-pci` device (Homebrew's QEMU 11.1.1
has it; check with `qemu-system-aarch64 -device help`).
