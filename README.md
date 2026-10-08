# cube

Self-hosted coding-agent threads, each in its own virtual machine. You talk to
a chat in your browser; it starts threads in your projects; every thread's
agent works in a fresh Debian machine of its own, with only HTTP and HTTPS
through cube's gateway, and reports back. Closing the tab or restarting cube
does not discard accepted work.

**Experimental software.** It runs agents with real tools against your
repositories and your GitHub token. Read [security and the private
network](#security-and-the-private-network) before exposing it to anything
but your own browser.

- **cubed** is the control plane: the web UI, [OptChat](docs/optchat.md) (one
  endless chat that starts and steers threads), the agents (Pi, or Claude Code
  with your own login), projects, and the gateway every thread machine's
  traffic goes through.
- **cube-runner** hosts the thread machines: one QEMU VM per active thread,
  several per runner, on Linux with KVM or on an Apple Silicon Mac with
  Hypervisor.framework.
- Threads run `read`, `write`, `edit`, bounded `bash`, `codemode` (one
  model-written script calling those tools) and `cube service` (web servers
  with a URL for you). They write [artifacts](docs/artifacts.md): documents
  you read beside the chat, comment on, and act from (a confirmed pull request
  merge).

## macOS quickstart (Homebrew)

One Apple Silicon Mac runs everything: cubed, the runner and the thread
machines. The runner, QEMU and the machines run as your user; see the
[support matrix](#support-matrix) and [security](#security-and-the-private-network).

> **Availability.** The tap formulas are generated from each published
> stable release's signed manifests and pushed to `cubeyard/homebrew-tap` by
> the `homebrew` workflow ([DEVELOPING.md](DEVELOPING.md#homebrew-publishing);
> the workflow is staged in `scripts/homebrew/workflows/` until a maintainer
> installs it). The first release that carries `cubed runners init-local` is
> the one after v0.3.18; until it is published and the tap updated, this
> quickstart does not work yet, and the same-Mac setup has not been run on
> real hardware.

What `brew install` does, and what stays yours to do:

| `brew install cubeyard/tap/cube` | you |
|---|---|
| `cubed`: the control plane with its own Node runtime, `cube-gateway` and the web UI (the signed `darwin-arm64` release bundle, verified by its pinned sha256) | download a Debian 13 genericcloud **arm64** image |
| `cube-runner` and QEMU (Homebrew's `qemu`, which carries the arm64 UEFI firmware) | run the one-time `cubed runners init-local` |
| `gh`, so threads can use your GitHub access | `gh auth login`; connect a model in the UI |
| user services (`brew services`) for both daemons, loopback only | optional: Claude Code login, Tailscale access |

```sh
brew trust cubeyard/tap          # Homebrew asks you once to trust a third-party tap
brew install cubeyard/tap/cube

# the base image every thread machine starts from (~400 MB); keep it anywhere
curl -fLO https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-arm64.qcow2

# one time: the runner's key, state and a copy of the image under ~/.cube,
# loopback on 127.0.0.1:7778, enrolled in cubed's state (~/.cube-host)
cubed runners init-local --image "$PWD/debian-13-genericcloud-arm64.qcow2"

brew services start cube-runner
brew services start cube
open http://127.0.0.1:7777
```

`init-local` checks QEMU, copies the image, starts the runner once to enroll
it and stops it again; the services then keep both running and restart them
after a crash or a login. Run it before starting the `cube-runner` service,
and keep the default `--home` (`~/.cube`): the service starts the runner
there. The runner needs Hypervisor.framework (`sysctl kern.hv_support` prints
1). Nothing asks for `sudo`. Do not combine this with a `install.sh`
installation of cubed on the same Mac: both would use `~/.cube-host`,
`~/.config/cubed/environment` and port 7777.

### First run

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

### Settings

cubed reads `~/.config/cubed/environment` (shell syntax, keep it mode 600):

```sh
# CUBED_STATE=/Users/me/.cube-host          # default
# CUBED_CLAUDE=/Users/me/.local/bin/claude  # Claude Code, if it is not on the service's PATH
# CUBED_HOST=100.64.0.2                     # a Tailscale IP; see security below
# CUBED_ALLOWED_HOSTS=mymac.tailnet.ts.net,100.64.0.2
# CUBED_PORTAL_IP=100.64.0.2                # URLs for threads' `cube service` web servers (docs/services.md)
# CUBED_VM_MEMORY_MIB=4096 CUBED_VM_VCPUS=2 # size of new thread machines
```

`brew services restart cube` after a change. The runner takes its options at
`init-local` (`--max-vcpus`, `--max-memory-mib`, `--max-disk-gib`, `--listen`,
`--qemu`, `--firmware`); it hosts as many machines as fit its host at those
sizes (`cube-runner run --max-active-vms` to override; see
[runner operations](docs/runner-operations.md#thread-machines-per-runner)).

### Where things are

| Path | Holds |
|---|---|
| `~/.cube-host` | cubed's state: projects, threads and their transcripts, OptChat, artifacts, the gateway's installation CA |
| `~/.cube/runner` | the runner's key, journal, the copied base image, machine disks and templates |
| `~/.cube/control.key`, `~/.cube/runner.json` | cubed's key and config for reaching the local runner |
| `~/.pi/agent` | model credentials (Pi's) |
| `/opt/homebrew/var/log/cubed.log`, `cube-runner.log` | the services' logs |

### Updating and removing

```sh
brew upgrade cube cube-runner && brew services restart cube-runner cube
brew services stop cube cube-runner
brew uninstall cube cube-runner    # keeps ~/.cube-host and ~/.cube; delete them yourself
```

Restart the services right after an upgrade: `brew upgrade` does not restart
them, and it removes the old version's files from under the still-running
processes. Restarting the runner powers its thread machines down; cubed boots
them again from the same disks when it needs them. Under Homebrew the
**system** page reports cubed as managed externally: the browser never
updates it, `brew upgrade` does. The runner's own self-updater is not
installed either. `brew upgrade qemu` is expected to keep working: the runner
records the launcher paths it was given (`/opt/homebrew/bin/...`), not the
versioned ones behind them; restart the runner afterwards.

### If something does not work

- **`init-local` says "set up but not enrolled".** The runner could not
  start here: the message carries its error (no Hypervisor.framework, QEMU
  missing). Fix that, `brew services start cube-runner`, then run the
  `cubed runners enroll` line it printed.
- **A thread stays "starting".** Fetch its diagnostics bundle (read only):
  `curl -fsS http://127.0.0.1:7777/api/threads/<id>/diagnostics`, or ask the
  chat to diagnose the thread. [Runner operations](docs/runner-operations.md#diagnosing-a-machine-that-does-not-start)
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

## Support matrix

| | cubed | cube-runner (thread machines) |
|---|---|---|
| macOS, Apple Silicon | signed release (`darwin-arm64`), Homebrew or `install.sh` | HVF; Homebrew QEMU. Verified as a remote runner in production; the same-Mac loopback setup above is unverified on real hardware |
| macOS, Intel | no release; source checkout only | not supported: the runner refuses `x86_64` macOS |
| Linux x86-64 (glibc) | signed release | KVM, QEMU 7.2+; verified with real guests |
| Linux arm64 (glibc) | signed release | no runner release |
| Windows, musl | no | no |

Everything needs Node 26 only when running from source (releases bundle it),
Git, OpenSSH (`ssh`, `ssh-keygen`), and a Debian 13 genericcloud image for the
runner's architecture. Pi-based threads need a model provider Pi supports;
Claude Code threads need Claude Code and a Claude Max login on the cubed host.

## Linux and source checkouts

On a Linux laptop with KVM the same local-runner flow works from a checkout
or from the signed release (`install.sh`, [cubed updates](docs/cubed-updates.md)):

```sh
pnpm install --frozen-lockfile && pnpm build
cargo build --locked -p cube-runner -p cube-gateway
CUBE_RUNNER=target/debug/cube-runner pnpm cubed runners init-local \
  --image /absolute/debian-13-genericcloud-amd64.qcow2 --state "$HOME/.cube-host"
target/debug/cube-runner run --home "$HOME/.cube/runner"     # terminal 1
pnpm cubed --state "$HOME/.cube-host"                          # terminal 2
```

Both are foreground processes; `init-local` enrolls the runner while it runs
it once. Runners on other machines (relay or direct mode), always-on service
profiles with a dedicated account, drain, backup and restore are in [runner
operations](docs/runner-operations.md); `cubed runners enroll --config` admits
one. Development checks: [DEVELOPING.md](DEVELOPING.md).

## Security and the private network

- **The thread machine is the sandbox.** A thread's commands run as user
  `agent` (with sudo) inside its QEMU guest. Its files, processes and network
  are its own; it holds no real credential; its only network is cube's
  gateway, which allows HTTP and HTTPS to public addresses and asks cubed's
  policy about every request. It cannot reach cubed, the runner, your LAN or
  a metadata service.
- **The host is not.** QEMU runs as the runner's account, hardened only by
  `-sandbox on` on Linux and not at all on macOS. A QEMU escape has that
  account's authority. On the one-Mac setup above that account is yours: the
  runner can read every machine disk it hosts, and a guest escape would run as
  you. Give a runner that matters a dedicated account or machine without SSH,
  cloud, browser, Git or provider credentials.
- **cubed's own processes are not sandboxed either.** Pi, codemode's worker
  and Claude Code run on the cubed host as the user who runs cubed, with that
  user's files and the model credentials; only the tools they call run in the
  thread's machine.
- **The agent can act with what it is given.** It can push to GitHub with
  your token through the gateway (github.com and api.github.com only) and send
  what it reads to any public HTTPS host. Give projects the repositories you
  mean it to touch.
- **cubed has no user authentication.** It binds `127.0.0.1:7777`. Anyone
  who reaches it is you. For access from other devices use an authenticated
  reverse proxy, or Tailscale: set `CUBED_HOST` to the Mac's Tailscale IP and
  list the exact MagicDNS name and IP in `CUBED_ALLOWED_HOSTS` (DNS-rebinding
  protection, not access control). Never bind `0.0.0.0` on a network you do
  not control. [SECURITY.md](SECURITY.md) has the reporting process.
- **Updates are signed, Homebrew's by proxy.** Release bundles carry
  Ed25519-signed manifests (trust anchor `scripts/cubed/update-public-key.pem`)
  that the managed launcher and the runner's updater verify. The Homebrew
  formulas are generated from those manifests and pin each asset's sha256,
  but a Homebrew user trusts the tap's commits: whoever can write the tap
  (the `homebrew` workflow's token, the tap's maintainers) can publish a
  formula.

## Fresh state, not migration

State schema 102 (thread machines, runner protocol 3) does **not migrate**
older registries or execution stacks: cubed refuses a v100/v101 registry, a
version-1 runner config and a protocol-2 runner. For a fresh start, stop cubed
and choose a different empty `CUBED_STATE` directory; create projects and
enroll freshly initialized VM runners. This does not erase old installations or
runner workspaces. Never copy a live Pi session into two hosts: each session
requires one writable owner.

## More

- [ARCHITECTURE.md](ARCHITECTURE.md): how the pieces fit; [DESIGN.md](DESIGN.md),
  [PRODUCT.md](PRODUCT.md); [HANDOFF.md](HANDOFF.md) for the current status.
- [docs/runner-operations.md](docs/runner-operations.md): runners, machines
  per runner, diagnostics, service profiles, backup and restore.
- [docs/cubed-updates.md](docs/cubed-updates.md): signed releases, the managed
  launcher and its user service, browser updates.
- [docs/optchat.md](docs/optchat.md), [docs/artifacts.md](docs/artifacts.md),
  [docs/services.md](docs/services.md), [docs/usage.md](docs/usage.md).
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md). Apache-2.0;
  dependencies retain their [notices](THIRD_PARTY_NOTICES.md).
