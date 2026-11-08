---
title: install on macOS
description: Install cube and its runner on an Apple Silicon Mac with Homebrew, and what the install leaves for you to do.
---

One Apple Silicon Mac runs everything: cubed, the runner and the thread machines. The runner, QEMU and the machines run as your user. Read the [security model](/cube/concepts/security-model/) for what that means.

## install

```sh
brew trust cubeyard/tap          # Homebrew asks once to trust a third-party tap
brew install cubeyard/tap/cube
cubed runners init-local
brew services restart cubeyard/tap/cube-berth cubeyard/tap/cube
open http://127.0.0.1:7777
```

`cubed runners init-local` sets up the runner under `~/.cube`, listening on loopback at `127.0.0.1:7779`, and enrolls it in cubed's state in `~/.cube-host`. The first time, berth pulls cube's default image and prepares it, so that run takes as long as the pull.

The same commands work every time: for a first install, after `brew upgrade`, and after `brew uninstall` followed by `brew install`. `init-local` finds what is already there, says `already set up and enrolled` and changes nothing. `brew services restart` starts a stopped service and replaces one that is still running.

The runner needs Hypervisor.framework: `sysctl kern.hv_support` prints `1`. Nothing asks for `sudo`.

:::caution
Do not combine the Homebrew install with an `install.sh` install of cubed on the same Mac. Both use `~/.cube-host`, `~/.config/cubed/environment` and port 7777.
:::

## what the install does and what is yours

| `brew install cubeyard/tap/cube` installs | you do |
|---|---|
| `cubed`, the control plane, with its own Node runtime, `cube-gateway` and the web UI, from the signed `darwin-arm64` release, checked against its pinned sha256 | run `cubed runners init-local` |
| `cube-berth`, the runner (`berth vm`), with keel's arm64 kernel and base of the same release, and Homebrew's `qemu` and `erofs-utils` | connect GitHub, in the setup or with `gh auth login` |
| `gh`, so threads can use your GitHub access | connect a model under **settings** › **model providers** |
| user services for both daemons, on loopback only | optional: a Claude Code token ([models](/cube/use/models/#claude-code-threads)), [access from other devices](/cube/run/private-network/) |

## install progress

`brew install` and `brew upgrade` download everything first, with progress, under `==> Fetching downloads`: QEMU's bottles and cube's release bundle (about 100 MB). After `==> Installing cubeyard/tap/cube`, Homebrew prints nothing until the summary line. That stretch took 14 to 32 seconds on GitHub's macOS runners. Homebrew unpacks the bundle's 20,000 files and checks each one for binaries to relink.

To see where the time goes on your Mac, timestamp each line:

```sh
brew upgrade --verbose cubeyard/tap/cube 2>&1 | while IFS= read -r line; do printf '%s %s\n' "$(date +%T)" "$line"; done
```

## the image

Thread machines run cube's default image: official Debian trixie, pinned by digest in berth. Official Debian lacks sudo, git, gh, curl and a CA bundle, which a machine needs, so berth adds them. Before it first listens, it fetches pinned Debian packages (each checked by sha256), unpacks them into one more layer whose sha256 is pinned too, and keeps that layer in its cache. This takes seconds, once.

`init-local` writes `CUBE_BERTH_IMAGE=default` to `~/.cube/berth.env`, so the runner follows berth's default. A newer cube can pin a newer Debian. Existing machines keep the image they were made on.

To use an image of your own, pass `--image <registry/repository@sha256:…>` to the first `init-local`. berth does not prepare it. It must bring bash, sudo with `/etc/sudoers.d`, util-linux's `flock`, git, gh, curl and a CA bundle. Otherwise no thread machine becomes ready.

A thread machine reaches the network over HTTP and HTTPS only, so git over SSH does not work there. Use HTTPS remotes. `gh` and the git credential helper use your GitHub login through cube's gateway.

## settings

cubed reads `~/.config/cubed/environment` in shell syntax. Keep it mode 600.

```sh
# CUBED_STATE=/Users/me/.cube-host          # default
# CUBED_CLAUDE=/Users/me/.local/bin/claude  # Claude Code, if it is not on the service's PATH
# CUBED_VM_MEMORY_MIB=4096 CUBED_VM_VCPUS=2 # size of new thread machines
```

After a change, run `brew services restart cubeyard/tap/cube`. Every variable is in the [configuration reference](/cube/reference/configuration/).

The runner takes its options at the first `init-local`: `--max-machines` (machines at once, 2 by default), `--listen` and `--node-id`. Later runs refuse other values rather than change them.

## suspend

The Homebrew runner service starts berth with suspend on. cube saves a machine that nothing has used for 5 minutes to `~/.cube/berth` and frees its slot. The thread resumes where it was when it is needed again.

A save needs the machine's memory (4 GiB by default) plus 2 GiB more free on that disk. With less, the machine keeps running and nothing is deleted. Each suspended thread keeps its memory file until it resumes or is archived. The file is sparse, so it often takes much less disk than the machine's memory, but many idle threads add up. `du -sh ~/.cube/berth` shows the total. To free space, archive the threads you are done with.

To turn suspend off, or keep another margin, set `CUBE_BERTH_SUSPEND_DISK_MARGIN_GIB` in `~/.cube/berth.env` to `off` or a number of GiB from 1 to 9999, then run `brew services restart cubeyard/tap/cube-berth`.

## where things are

| Path | Holds |
|---|---|
| `~/.cube-host` | cubed's state: projects, threads and their transcripts, the chat, artifacts |
| `~/.cube/berth` | the runner's key, journal, machine disks, templates and layer cache |
| `~/.cube/berth.json`, `~/.cube/berth.control.key` | cubed's config and key for reaching the runner |
| `~/.cube/berth.env` | the image, the machines at once and the suspend margin the runner service starts with |
| `~/.pi/agent` | model credentials |
| `/opt/homebrew/var/log/cubed.log`, `cube-berth.log` | the services' logs |

## remove cube

```sh
brew services stop cubeyard/tap/cube cubeyard/tap/cube-berth
brew uninstall cubeyard/tap/cube cubeyard/tap/cube-berth
```

`brew uninstall` keeps `~/.cube` and `~/.cube-host`. To start over from nothing, stop the services and move both directories aside yourself. Nothing in cube deletes them.

## next

- [Your first thread](/cube/start/first-thread/#open-cube) continues from here.
- [Update cube](/cube/start/update/) when a release comes out.
- [Troubleshooting](/cube/run/troubleshooting/) if a step fails.
