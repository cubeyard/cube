# VM base

The guest kernel (and later the base image with `cube-init`) that thread
machines boot directly, without firmware. See
[docs/plans/2026-10-10-vm-base-and-image-layers.md](../../docs/plans/2026-10-10-vm-base-and-image-layers.md)
for the design. Nothing in the runner uses this yet.

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
packages/vm-base/kernel/build.sh            # both architectures
packages/vm-base/kernel/build.sh arm64      # one
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
packages/vm-base/smoke/build.sh             # initramfs + layers, both architectures
packages/vm-base/smoke/run.sh arm64         # hvf on an Apple Silicon Mac
packages/vm-base/smoke/run.sh x86_64        # kvm on Linux x86-64, tcg elsewhere
packages/vm-base/smoke/run.sh arm64 tcg     # force software emulation
```

## Snapshot test

`snapshot/test.py` boots the kernel with `snapshot/tick.c` as init (a message
every 200 ms on the virtio-serial port `cube.0`), saves the running machine
with `migrate file:`, quits, waits, restores it in a new QEMU and checks that
the messages continue, the EROFS disk still reads and how the guest clocks
compare with the host's.

```sh
packages/vm-base/snapshot/test.py arm64                  # hvf on an Apple Silicon Mac
packages/vm-base/snapshot/test.py arm64 --mapped-ram
packages/vm-base/snapshot/test.py x86_64                 # kvm on Linux x86-64
```

The QEMU build must have the `virtio-rtc-pci` device (Homebrew's QEMU 11.1.1
has it; check with `qemu-system-aarch64 -device help`).
