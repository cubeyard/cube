---
title: platforms
description: Which operating systems and architectures cubed and the runner support, and what each needs.
---

cubed and the runner have separate releases per platform. A thread machine runs wherever a `berth vm` runs.

## support matrix

| platform | cubed | `berth vm`: thread machines |
|---|---|---|
| macOS, Apple Silicon | signed release (`darwin-arm64`), with Homebrew or `install.sh` | Hypervisor.framework, with Homebrew's QEMU, without `-sandbox` |
| macOS, Intel | no release; source checkout only | no |
| Linux x86-64, glibc | signed release (`linux-x64-gnu`) | KVM, glibc 2.39 or newer, a QEMU that meets keel's floor at an explicit path, run with `-sandbox on` |
| Linux arm64, glibc | signed release (`linux-arm64-gnu`) | no berth release |
| Windows, musl Linux | no | no |

## what else each part needs

- **cubed:** Git and `gh` on the host. Releases bundle their own Node runtime. The bootstrap `install.sh` needs Node 26, and a source checkout runs on Node 26.
- **The runner:** a QEMU that meets keel's floor, its `qemu-img`, `mkfs.erofs` from erofs-utils, and keel's kernel and base of the same release.
- **Pi threads:** a model provider Pi supports, connected under **settings** › **model providers**.
- **Claude Code threads:** Claude Code on the cubed host, and its long-lived token from `claude setup-token` as `CLAUDE_CODE_OAUTH_TOKEN` in cubed's environment.

## keel's QEMU floor

berth checks the QEMU binary it is given for the features keel needs, not for a version number, and refuses one that lacks any of them. It names what is missing. The features are the virtio devices keel's machines use, the balloon's `free-page-reporting`, the `mapped-ram` migration capability and the `cpr-reboot` migration mode that suspend uses, `dgram` network backends, the migration commands, a versioned machine type, the accelerator, and on x86-64 the `vmgenid` device.

QEMU 11.1.2 on Linux and Homebrew's QEMU 11.1 on macOS meet the floor. Ubuntu 24.04's QEMU 8.2.2 does not.

## thread machine images

Thread machines run cube's default image, official Debian trixie pinned by digest, prepared by berth with sudo, git, gh, curl and ca-certificates. An image of your own must be public, pinned by digest, for the runner's platform (`linux/amd64` or `linux/arm64`), and bring bash, sudo with `/etc/sudoers.d`, util-linux's `flock`, git, gh, curl and a CA bundle.

## source checkouts

To run cube from a checkout of the repository, follow [DEVELOPING.md](gh:DEVELOPING.md) and the source section of [platforms.md](gh:docs/platforms.md#linux-and-source-checkouts).

## state is not migrated

The current state schema does not migrate older registries or execution stacks. cubed refuses an older registry, an older runner config and a retired protocol-3 runner. For a fresh start, stop cubed and choose a different, empty `CUBED_STATE` directory. That erases nothing of the old installation.
