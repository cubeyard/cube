---
title: platforms
description: Which operating systems and architectures cubed and the runner support, and what each needs.
---

## support matrix

| | cubed | `berth vm`: thread machines |
|---|---|---|
| macOS, Apple Silicon | signed release (`darwin-arm64`), with Homebrew or `install.sh` | Hypervisor.framework, with Homebrew's QEMU 11.1.x, without `-sandbox` |
| macOS, Intel | no release; source checkout only | no |
| Linux x86-64, glibc | signed release (`linux-x64-gnu`) | KVM, glibc 2.39 or newer, QEMU 11.1.2 or newer at an explicit path, run with `-sandbox on` |
| Linux arm64, glibc | signed release (`linux-arm64-gnu`) | no berth release |
| Windows, musl Linux | no | no |

## what else each part needs

- **cubed:** Git and `gh` on the host. Releases bundle their own Node runtime. The bootstrap `install.sh` needs Node 26, and a source checkout runs on Node 26.
- **The runner:** a QEMU at or above keel's floor, its `qemu-img`, `mkfs.erofs` from erofs-utils, and keel's kernel and base of the same release. keel refuses an older QEMU, such as Ubuntu 24.04's 8.2.2.
- **Pi threads:** a model provider Pi supports, connected under **settings** › **model providers**.
- **Claude Code threads:** Claude Code and a Claude login on the cubed host.

## thread machine images

Thread machines run cube's default image, official Debian trixie pinned by digest, prepared by berth with sudo, git, gh, curl and ca-certificates. An image of your own must be public, pinned by digest, for the runner's platform (`linux/amd64` or `linux/arm64`), and bring bash, sudo with `/etc/sudoers.d`, util-linux's `flock`, git, gh, curl and a CA bundle.

## source checkouts

To run cube from a checkout of the repository, follow [DEVELOPING.md](gh:DEVELOPING.md) and the source section of [platforms.md](gh:docs/platforms.md#linux-and-source-checkouts).

## state is not migrated

The current state schema does not migrate older registries or execution stacks. cubed refuses an older registry, an older runner config and a retired protocol-3 runner. For a fresh start, stop cubed and choose a different, empty `CUBED_STATE` directory. That erases nothing of the old installation.
