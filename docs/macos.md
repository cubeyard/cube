# macOS with Homebrew

One Apple Silicon Mac runs everything: cubed, the runner and the thread
machines. The runner, QEMU and the machines run as your user; see the
[support matrix](platforms.md#support-matrix) and [security](security.md).
The tap formulas are generated from each published stable release's signed
manifests and pushed to `cubeyard/homebrew-tap` by the `homebrew` workflow
([DEVELOPING.md](../DEVELOPING.md#homebrew-publishing)).

What `brew install` does, and what stays yours to do:

| `brew install cubeyard/tap/cube` | you |
|---|---|
| `cubed`: the control plane with its own Node runtime, `cube-gateway` and the web UI (the signed `darwin-arm64` release bundle, verified by its pinned sha256, minus other platforms' prebuilt native modules) | download a Debian 13 genericcloud **arm64** image |
| `cube-runner` and QEMU (Homebrew's `qemu`, which carries the arm64 UEFI firmware) | run the one-time `cubed runners init-local` |
| `gh`, so threads can use your GitHub access | `gh auth login`; connect a model in the UI |
| user services (`brew services`) for both daemons, loopback only | optional: Claude Code login, Tailscale access |

## Install

```sh
brew trust cubeyard/tap          # Homebrew asks you once to trust a third-party tap
brew install cubeyard/tap/cube

# one time: downloads Debian's cloud image (~340 MB, checksum-verified), sets up
# the runner's key, state and image copy under ~/.cube, loopback on
# 127.0.0.1:7778, and enrolls it in cubed's state (~/.cube-host)
cubed runners init-local

brew services start cubeyard/tap/cube-runner
brew services start cubeyard/tap/cube
open http://127.0.0.1:7777
```

`init-local` checks QEMU, fetches `debian-13-genericcloud-arm64.qcow2` (the
bytes come from whichever Debian mirror
[cloud.debian.org](https://cloud.debian.org/images/cloud/trixie/latest/) sends
you to) and checks it against the `SHA512SUMS` fetched over HTTPS from
cloud.debian.org itself; that catches a corrupt or tampered download, not a
compromised cloud.debian.org, and Debian signs no checksum file for these
images. `--image` takes a file you already have; `CUBE_DEBIAN_IMAGE_BASE` names
another https site with the same layout. It hands the image to the runner,
which keeps its own copy, starts the runner once to enroll it and stops it
again; the services then keep both running and restart them
after a crash or a login. Run it before starting the `cube-runner` service,
and keep the default `--home` (`~/.cube`): the service starts the runner
there. The runner needs Hypervisor.framework (`sysctl kern.hv_support` prints
1). Nothing asks for `sudo`. Do not combine this with a `install.sh`
installation of cubed on the same Mac: both would use `~/.cube-host`,
`~/.config/cubed/environment` and port 7777.

### Install progress

`brew install` and `brew upgrade` download everything first, with progress,
under `==> Fetching downloads`: QEMU's bottles and cube's release bundle
(about 100 MB). Dependencies then install one by one, each ending in a 🍺
line. After `==> Installing cubeyard/tap/cube` Homebrew prints nothing until
the summary line (`20,148 files, … built in N seconds`). That stretch took
14 to 32 seconds on GitHub's macOS runners. It is Homebrew's own work on
the bundle's 20,000 files: it unpacks the archive into a sandbox, runs the
formula, then scans every file of the keg for Mach-O binaries to fix their
linkage. The formula prints one line of its own (`==> cube: …`) between
those steps. Homebrew decides the rest, and shows each step only with
`--verbose`.

To see where the time goes on your Mac, timestamp each line:

```sh
brew upgrade --verbose cubeyard/tap/cube 2>&1 | while IFS= read -r line; do printf '%s %s\n' "$(date +%T)" "$line"; done
```

## First run

1. **GitHub.** `gh auth login` in a terminal. cubed reads the token with
   `gh auth token` when a thread talks to github.com; the token never enters a
   thread machine (the machine holds a placeholder the gateway replaces).
   Without it, threads can still clone public repositories.
2. **A model.** Open **models** in the UI and connect a provider with Pi's
   browser or device login, or an API key. Credentials stay in `~/.pi/agent`
   on this Mac. For Claude Code threads ("claude · max"), install Claude Code,
   run `claude /login`, and tell cubed where it is (below).
3. **A project.** Name it and give it the repositories (GitHub URLs or local
   paths) its threads check out. Repositories are pinned at their current
   commit when each thread starts.
4. **A thread.** From the chat or the project page. The first machine of a
   project takes a minute or two: it boots the base image, installs `git`,
   `gh` and `curl` through the gateway and runs the repository's
   `.agents/setup`, then that prepared disk becomes the project's template and
   later threads start from it in seconds. The thread shows "starting the
   thread's machine" until then.

## Settings

cubed reads `~/.config/cubed/environment` (shell syntax, keep it mode 600):

```sh
# CUBED_STATE=/Users/me/.cube-host          # default
# CUBED_CLAUDE=/Users/me/.local/bin/claude  # Claude Code, if it is not on the service's PATH
# CUBED_HOST=100.64.0.2                     # a Tailscale IP; see security
# CUBED_ALLOWED_HOSTS=mymac.tailnet.ts.net,100.64.0.2
# CUBED_PORTAL_IP=100.64.0.2                # serve threads' `cube service` web servers to the tailnet (docs/services.md)
# CUBED_PORTAL_IP=                          # or: no URLs for them at all
# CUBED_VM_MEMORY_MIB=4096 CUBED_VM_VCPUS=2 # size of new thread machines
```

Web servers a thread runs with `cube service` get URLs such as
`http://web-<label>.localhost:7780/` out of the box: the Homebrew launcher
starts cubed's service portal on loopback (`127.0.0.1:7780`) under
`*.localhost` names, which browsers and curl resolve to the machine they run
on, without DNS. They open only in a browser on this Mac. Any
`CUBED_PORTAL_IP`, `CUBED_PORTAL_LISTEN` or `CUBED_PORTAL_DOMAIN` of yours is
kept as it is; for other devices set a Tailscale IP as above.

`brew services restart cubeyard/tap/cube` after a change. The runner takes its options at
`init-local` (`--max-vcpus`, `--max-memory-mib`, `--max-disk-gib`, `--listen`,
`--qemu`, `--firmware`); it hosts as many machines as fit its host at those
sizes (`cube-runner run --max-active-vms` to override; see
[runner operations](runner-operations.md#thread-machines-per-runner)).

## Where things are

| Path | Holds |
|---|---|
| `~/.cube-host` | cubed's state: projects, threads and their transcripts, OptChat, artifacts, the gateway's installation CA |
| `~/.cube/runner` | the runner's key, journal, the copied base image, machine disks and templates |
| `~/.cube/control.key`, `~/.cube/runner.json` | cubed's key and config for reaching the local runner |
| `~/.pi/agent` | model credentials (Pi's) |
| `/opt/homebrew/var/log/cubed.log`, `cube-runner.log` | the services' logs |

## Updating and removing

```sh
brew update
brew upgrade cubeyard/tap/cube cubeyard/tap/cube-runner
brew services restart cubeyard/tap/cube-runner cubeyard/tap/cube

brew services stop cubeyard/tap/cube cubeyard/tap/cube-runner
brew uninstall cubeyard/tap/cube cubeyard/tap/cube-runner    # keeps ~/.cube-host and ~/.cube; delete them yourself
```

`brew update` first: before `brew upgrade` Homebrew refreshes its taps by
itself only when the last refresh is older than `HOMEBREW_AUTO_UPDATE_SECS`,
24 hours by default for short names such as `cube` (5 minutes when a command
names `cubeyard/tap/cube` in full). Without it a release published since then
looks absent and `brew upgrade` says the old version is already installed.

Restart the services right after an upgrade: `brew upgrade` does not restart
them, and it removes the old version's files from under the still-running
processes. Restarting the runner powers its thread machines down; cubed boots
them again from the same disks when it needs them. Under Homebrew the
**system** page reports cubed as managed externally: the browser never
updates it, `brew upgrade` does. The runner's own self-updater is not
installed either. `brew upgrade qemu` is expected to keep working: the runner
records the launcher paths it was given (`/opt/homebrew/bin/...`), not the
versioned ones behind them; restart the runner afterwards.

## The tap's old v0.1 launcher

If this tap's earlier product, the v0.1 `cube` launcher (`cube up`, its VM
under `~/.cube`), is installed, retire it before installing: `cube down`,
then move `~/.cube` aside to keep the old VM's data (`cube destroy --yes`
deletes it), then `brew uninstall cube`. If `brew upgrade` already replaced it,
`bin/cube` is gone: the old VM may still run and hold port 7777 (or the
`CUBE_PORT` in `~/.cube/config`); if `ps -p "$(cat ~/.cube/vm.pid)" -o command=`
shows a qemu process, `kill` that pid (a forced stop; the old disk is kept as
is), then move `~/.cube` aside.

## If something does not work

- **`brew upgrade` says the old version is already installed.** Its tap copy
  is older than the release: `brew update`, then upgrade again (see above).
- **`init-local` says "set up but not enrolled".** The runner could not
  start here: the message carries its error (no Hypervisor.framework, QEMU
  missing). Fix that, `brew services start cubeyard/tap/cube-runner`, then run the
  `cubed runners enroll` line it printed.
- **A thread stays "starting".** Fetch its diagnostics bundle (read only):
  `curl -fsS http://127.0.0.1:7777/api/threads/<id>/diagnostics`, or ask the
  chat to diagnose the thread. [Runner operations](runner-operations.md#diagnosing-a-machine-that-does-not-start)
  explains the fields; `cubed runners status` shows whether the runner answers.
- **"gateway unavailable".** cubed did not find or could not start
  `cube-gateway`; the Homebrew bundle has it next to `release.json`. Check
  `cubed.log`.
- **The runner's log says the base image changed.** The runner refuses a base
  image whose size or hash differs from what it copied at `init-local`; it
  never re-reads the download. Nothing to do unless `~/.cube/runner` was
  edited.
- **A machine's console prints `ArmTrngLib could not be correctly
  initialized`, `Tpm2...`.** Noise from Homebrew's edk2 firmware on a healthy
  boot.
- **Port 7777 or 7778 is taken.** `CUBED_PORT` in the environment file;
  `--listen` at `init-local` for the runner (the enrollment records it).
