# keel

keel is everything cube puts inside a thread machine before the project's
own software: the part the rest is built on, as a ship's keel is laid first.
A runner boots it directly with QEMU, without firmware, on Linux (KVM, x86-64
guests) and macOS (HVF, arm64 guests) alike:

- **the guest kernel** (built here today);
- **`cube-init`**, a small PID 1 in C that brings the machine up, starts the
  guest agent and starts it again if it dies (planned);
- **`cube-agent`**, the guest agent in Rust: it talks to the runner over a
  virtio-serial control channel, assembles the project's root filesystem from
  the machine's read-only EROFS image layers and its writable disk with
  overlayfs, and runs commands and services, replacing SSH, cloud-init,
  systemd and the Python helper in the guest (planned);
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
