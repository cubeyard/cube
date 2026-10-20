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
| `cubed`: the control plane with its own Node runtime, `cube-gateway` and the web UI (the signed `darwin-arm64` release bundle, verified by its pinned sha256, minus other platforms' prebuilt native modules) | choose the image thread machines are built on, pinned by digest |
| `cube-berth`: the runner, `berth vm`, with keel's arm64 guest kernel and base of the same release (each pinned by sha256); Homebrew's `qemu` and `erofs-utils` | run `cubed runners init-local` (the first time with `--image`) |
| `gh`, so threads can use your GitHub access | `gh auth login`; connect a model in the UI |
| user services (`brew services`) for both daemons, loopback only | optional: Claude Code login, Tailscale access |

## Install

```sh
brew trust cubeyard/tap          # Homebrew asks you once to trust a third-party tap
brew install cubeyard/tap/cube

# sets up the runner under ~/.cube (loopback on 127.0.0.1:7779) and enrolls
# it in cubed's state (~/.cube-host); the first time it pulls the image
cubed runners init-local --image <registry/repository@sha256:…>

brew services restart cubeyard/tap/cube-berth cubeyard/tap/cube
open http://127.0.0.1:7777
```

**The same three commands work every time**: for a first install, after
`brew upgrade`, and after `brew uninstall` followed by `brew install`.
`brew uninstall` keeps `~/.cube` and `~/.cube-host`; `init-local` then finds
everything in place, says `already set up and enrolled` and changes nothing
(`--image` may be left out then). `restart` starts a stopped service, and
replaces one that `brew uninstall` left running (Homebrew never stops a
service when it uninstalls a formula).

`--image` names the image every thread machine is built on, pinned by digest
(`<registry>/<repository>@sha256:<64 hex>`); it needs bash, sudo,
coreutils, util-linux, git, gh, curl and ca-certificates. cube publishes no
default image yet. It is
recorded in `~/.cube/berth.env` once berth has pulled it and listens; a later
`init-local` with another image is then refused rather than changing it.
A digest that does not exist fails the first run and is recorded nowhere:
run `init-local` again with the right one. berth pulls it the first time it
starts, before it listens, so the first `init-local` takes as long as the pull.

`init-local` creates cubed's control key for the runner, starts berth once
(it binds `~/.cube/berth` to that key, pulls the image and prints its peer),
writes `berth.env` and `berth.json`, enrolls the runner and stops it; the services then keep both running and restart them after a crash
or a login. It never overwrites, deletes or rebinds a file: a run that
disagrees with what is there is refused with the path, and a run after a
failure (for example no Hypervisor.framework, or an image that could not be
pulled) continues where it stopped.
Keep the default `--home` (`~/.cube`): the service starts berth there. The
runner needs Hypervisor.framework (`sysctl kern.hv_support` prints 1).
Nothing asks for `sudo`. Do not combine this with a `install.sh` installation
of cubed on the same Mac: both would use `~/.cube-host`,
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
   project takes a minute or two: it boots keel with your image and runs the
   repository's `.agents/setup`, then what that setup wrote becomes the
   project's template and later threads start from it in seconds. The thread shows "starting the
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

`brew services restart cubeyard/tap/cube` after a change. The runner takes
its options at the first `init-local`: `--max-machines` (machines at once,
2 by default), `--listen` and `--node-id`; later runs refuse other values
rather than change them. New machines get the project's size, else
`CUBED_VM_VCPUS` and `CUBED_VM_MEMORY_MIB` (2 vCPUs and 4096 MiB by default).

## Where things are

| Path | Holds |
|---|---|
| `~/.cube-host` | cubed's state: projects, threads and their transcripts, OptChat, artifacts, the gateway's installation CA |
| `~/.cube/berth` | the runner's key, journal, machine disks, templates and layer cache |
| `~/.cube/berth.json`, `~/.cube/berth.control.key` | cubed's config and key for reaching the runner |
| `~/.cube/berth.env` | the image and the machines at once the service starts the runner with |
| `~/.pi/agent` | model credentials (Pi's) |
| `/opt/homebrew/var/log/cubed.log`, `cube-berth.log` | the services' logs |

## Updating and removing

```sh
brew update
brew upgrade cubeyard/tap/cube cubeyard/tap/cube-berth
brew services restart cubeyard/tap/cube-berth cubeyard/tap/cube

brew services stop cubeyard/tap/cube cubeyard/tap/cube-berth
brew uninstall cubeyard/tap/cube cubeyard/tap/cube-berth    # keeps ~/.cube-host and ~/.cube
```

`brew update` first: before `brew upgrade` Homebrew refreshes its taps by
itself only when the last refresh is older than `HOMEBREW_AUTO_UPDATE_SECS`,
24 hours by default for short names such as `cube` (5 minutes when a command
names `cubeyard/tap/cube` in full). Without it a release published since then
looks absent and `brew upgrade` says the old version is already installed.

Restart the services right after an upgrade: `brew upgrade` does not restart
them, and it removes the old version's files from under the still-running
processes. Restarting the runner stops its machines' QEMUs (their disks are
kept); cubed starts them again when it needs them. A machine suspended by
the old version starts from its disk instead (its snapshot does not fit the
new keel), with the notice `restarted after an update; running commands
were interrupted`. Under Homebrew the **system** page reports cubed as
managed externally: the browser never updates it, `brew upgrade` does.
`brew upgrade qemu` keeps working: the service names QEMU and mkfs.erofs by
their `opt` paths, which stay the same; restart the runner afterwards.

**Installing again.** `brew uninstall` keeps everything under `~/.cube` and
`~/.cube-host`, and it does not stop a running service. Install and set up
with the commands from [Install](#install): `init-local` says the runner is
already set up and changes nothing, and `brew services restart` replaces any
process the uninstall left running. To start over from nothing instead,
stop the services and move `~/.cube` and `~/.cube-host` aside yourself;
nothing in cube deletes them.

**`cube-runner` from an earlier release.** Earlier releases installed the
protocol-3 runner `cube-runner`, with its state in `~/.cube/runner`,
`~/.cube/runner.json` and `~/.cube/control.key`. It is no longer updated and
`cube` no longer depends on it; `init-local` and `cube-berth` never read or
touch its files. Archive its threads and retire it ([runner
operations](runner-operations.md#status-drain-and-stop)), then `brew services
stop cubeyard/tap/cube-runner` and `brew uninstall cubeyard/tap/cube-runner`.
Its files stay until you delete them.

## The runner and this Mac

- The runner is `berth vm` with Homebrew's QEMU 11.1.x and
  Hypervisor.framework (HVF); it checks keel's QEMU floor when it starts.
- macOS QEMU has no `-sandbox`: on a Mac the guest is held by HVF and by
  what berth checks on its channel and network, and a QEMU escape has your
  account's authority ([security](security.md)).
- It is in the pool, so threads that name no runner are placed on it.
- Suspend is off, as for every `berth vm` started without
  `--suspend-disk-margin-gib` ([runner
  operations](runner-operations.md#berth-vm-runner-protocol-4)).

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
- **`init-local` says "not enrolled".** berth could not start here: the
  message carries its error (no Hypervisor.framework, a QEMU below keel's
  floor, an image pull that failed). Fix that and run `init-local` again; it
  continues with what it already made. Until berth has listened once, that
  run may give another `--image`, `--max-machines` or `--listen`.
- **`init-local` says "another berth vm runs in".** Something holds
  `~/.cube/berth` before `init-local` wrote `berth.json` (a second
  `init-local`, or a `berth vm` started by hand; the service does not start
  berth without `berth.json`): stop that one, then run `init-local` again.
- **`init-local` refuses with "init-local changes nothing that is there".**
  An option disagrees with what `~/.cube` already records (another image,
  `--listen`, `--node-id` or `--max-machines`). Leave the option out to keep
  the recorded value. To change the image, edit `~/.cube/berth.env` yourself
  and restart the runner; existing machines keep the image they were made
  with and are refused on another one (`image_changed`).
- **`cube-berth.log` says "not set up yet".** The service started before
  `init-local`: run it, then `brew services restart cubeyard/tap/cube-berth`.
- **A thread stays "starting".** Fetch its diagnostics bundle (read only):
  `curl -fsS http://127.0.0.1:7777/api/threads/<id>/diagnostics`, or ask the
  chat to diagnose the thread. [Runner operations](runner-operations.md#diagnosing-a-machine-that-does-not-start)
  explains the fields; `cubed runners status` shows whether the runner answers.
- **"gateway unavailable".** cubed did not find or could not start
  `cube-gateway`; the Homebrew bundle has it next to `release.json`. Check
  `cubed.log`.
- **Port 7777 or 7779 is taken.** `CUBED_PORT` in the environment file;
  `--listen 127.0.0.1:<port>` for the runner. `init-local` checks the UDP
  port before it writes anything and says `(UDP) is in use: give another
  --listen`. If the port is taken only while berth pulls, berth fails to
  bind and the run says "not enrolled": run `init-local` again with another
  `--listen`; nothing has to be moved or deleted. The address is fixed once
  berth has listened on it (`berth.env`, `berth.json`).
