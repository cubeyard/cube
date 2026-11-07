---
title: configuration
description: Every setting cubed, its launcher and the local runner read, with defaults.
---

cubed reads its settings from the environment. The release launcher and the Homebrew service load `~/.config/cubed/environment` first: shell syntax, mode 600, writable only by the account that runs cubed. Restart cubed after a change. Command-line options of `cubed` override the variables they name; see the [command-line reference](/cube/reference/cli/).

## cubed

| variable | default | meaning |
|---|---|---|
| `CUBED_STATE` | `~/.cube-host` | the state directory: projects, threads, transcripts, the chat, artifacts, settings |
| `CUBED_HOST` | `127.0.0.1` | the address cubed listens on; see [reach cube from other devices](/cube/run/private-network/) |
| `CUBED_PORT` | `7777` | the port cubed listens on |
| `CUBED_ALLOWED_HOSTS` | none | comma-separated host names accepted in requests, besides `localhost`, `127.0.0.1` and `[::1]`; protects against DNS rebinding, not access control |
| `CUBED_LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `CUBED_CLAUDE` | the first `claude` on `PATH` | the Claude Code program for Claude Code threads, or `off` |
| `CLAUDE_CODE_OAUTH_TOKEN` | none | the long-lived token from `claude setup-token`; the gateway gives it to Claude Code threads' model requests, and Claude Code itself gets a placeholder |
| `CUBED_GITHUB_TOKEN` | `gh auth token` | the GitHub token the gateway gives threads' requests to GitHub |
| `CUBED_GATEWAY` | the release's `bin/cube-gateway` | the `cube-gateway` program |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's directory: model logins (`auth.json`), custom models (`models.json`) and default model |

## thread machines

| variable | default | meaning |
|---|---|---|
| `CUBED_VM_VCPUS` | `2` | processors of a new thread machine, when its project sets none |
| `CUBED_VM_MEMORY_MIB` | `4096` | memory of a new thread machine in MiB, when its project sets none |
| `CUBED_VM_DISK_GIB` | `32` | disk size of a new thread machine in GiB |
| `CUBED_TEMPLATES` | `on` | `off` prepares every machine from the image and keeps no template |

Each runner clamps a machine's size to its own limits.

## the portal

| variable | default | meaning |
|---|---|---|
| `CUBED_PORTAL_IP` | off (Homebrew: `127.0.0.1`) | the private or loopback address browsers use for thread web servers |
| `CUBED_PORTAL_PORT` | `7780` | the portal's port |
| `CUBED_PORTAL_LISTEN` | `CUBED_PORTAL_IP` | the address the portal binds; private or loopback IPv4 only |
| `CUBED_PORTAL_DOMAIN` | `sslip.io` (Homebrew: `localhost`) | `sslip.io`, `nip.io`, a wildcard domain of your own, or `localhost` |

Under Homebrew, the launcher sets `CUBED_PORTAL_IP=127.0.0.1` and `CUBED_PORTAL_DOMAIN=localhost` only when you set none of the three portal address variables. `CUBED_PORTAL_IP=` (empty) turns the portal off.

## updates and installation

| variable | default | meaning |
|---|---|---|
| `CUBED_GUI_UPDATES` | unset | `1` lets the **system** page install signed releases; unset, it shows status only |
| `CUBED_UPDATE_FEED_URL` | none | the signed manifest to check, such as `https://github.com/cubeyard/cube/releases/latest/download/cubed-linux-x64-gnu.json` |
| `CUBED_CONFIG_FILE` | `~/.config/cubed/environment` | the environment file the launcher and `service.sh` read |
| `CUBED_INSTALL_ROOT` | `~/.local/share/cubed` | where `install.sh` puts releases |
| `CUBED_BIN_DIR` | `~/.local/bin` | where `install.sh` puts the `cubed` launcher |

Homebrew installs ignore the update variables: `brew upgrade` updates cubed there.

## the local runner

`cubed runners init-local` writes `~/.cube/berth.env`, which the Homebrew runner service starts berth with:

| variable | meaning |
|---|---|
| `CUBE_BERTH_IMAGE` | `default` for cube's default image, or an image of your own pinned by digest |
| `CUBE_BERTH_MAX_MACHINES` | machines at once |
| `CUBE_BERTH_LISTEN` | the runner's loopback address |
| `CUBE_BERTH_SUSPEND_DISK_MARGIN_GIB` | yours to add: `off`, or 1 to 9999 GiB kept free besides a machine's memory; the Homebrew service uses 2 without it |

`init-local` finds its programs from its options, else from these variables, which Homebrew's launcher sets, else from `PATH`:

| variable | the program |
|---|---|
| `CUBE_BERTH` | `berth` |
| `CUBE_BERTH_KEEL` | the directory with keel's `vmlinuz` and `base.erofs`; no default |
| `CUBE_BERTH_QEMU` | `qemu-system-<arch>` |
| `CUBE_BERTH_QEMU_IMG` | `qemu-img` |
| `CUBE_BERTH_MKFS_EROFS` | `mkfs.erofs` |

## files in the state directory

| path | holds |
|---|---|
| `<CUBED_STATE>/optchat/AGENTS.md` | your standing instructions for the chat, if you create it |
| `<CUBED_STATE>/settings.json` | settings saved in the UI: the chat-memory model and skill sources |
| `<CUBED_STATE>/threads/<id>/` | each thread's stored conversation |
