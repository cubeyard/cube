# cube

Self-hosted coding-agent threads. The browser talks to cubed; an in-process
[pi-durable](https://github.com/earendil-works/pi) Harness owns the agent loop
and the durable SQLite conversation. Each thread's tools run in its own
virtual machine on an explicitly enrolled Iroh runner, and that machine's only
network is cube's gateway next to cubed. Closing the tab or restarting cubed
does not discard accepted work.

**Experimental software.** A thread's commands run as user `agent` inside a
QEMU guest (Debian 13). QEMU itself runs as the runner account and is hardened
only by its `-sandbox on` option; a guest escape through a QEMU bug would have
that account's authority, so the runner host as a whole is not a sandbox. Use a
dedicated runner account or machine without valuable credentials.

## Laptop-first quickstart

Requires Node 26+, the pnpm version in `package.json`, Git, OpenSSH
(`ssh`, `ssh-keygen`) and a configured model provider. Rust is needed to build
the runner and the gateway. A runner needs Linux with KVM, QEMU 7.2+ and a
Debian 13 genericcloud qcow2 image (macOS/HVF has code paths but is unverified).

```sh
pnpm install --frozen-lockfile
pnpm build
cargo build --locked -p cube-runner -p cube-gateway

# after one-time runner initialization (with --image) and enrollment (linked below):
target/debug/cube-runner run --home "$HOME/.cube/runner"
# in a second terminal:
pnpm cubed --state "$HOME/.cube-host"
```

Both programs are ordinary foreground processes. They create no systemd or
launchd service, do not auto-restart, and stop when their terminal or laptop
stops. cubed starts and supervises `cube-gateway` itself (from a release's
`bin/`, the checkout's `target/`, or `CUBED_GATEWAY`); without it, threads fail
visibly with "gateway unavailable". Check enrolled runners with
`pnpm cubed runners status --state "$HOME/.cube-host"`.

On the first Ctrl-C, the runner refuses new machines and powers the running
guest down; a second Ctrl-C makes QEMU quit at once. Cubed closes admission and
its durable owners cleanly on SIGINT or SIGTERM and leaves thread machines
running; the next cubed attaches to them again. A command survives either
restart in the guest and is found again by its key; nothing replays a command.

Cubed defaults to loopback port 7777. `cubed --help` documents `--state`,
`--host`, `--port`, repeatable `--allowed-host`, and `--log-level`; the existing
`CUBED_*` variables remain supported and flags take precedence. Use your local
browser, an authenticated access proxy, or
[configured private Tailscale access](DEVELOPING.md#product-development)
with `CUBED_HOST` and `CUBED_ALLOWED_HOSTS`; cubed itself has no user authentication.
GitHub login is available in the UI. Open **models** to connect model providers using Pi's supported
browser/device login or API-key prompts, check connection status, or disconnect.
Credentials and configuration use Pi's `~/.pi/agent` directory (or
`PI_CODING_AGENT_DIR`); the CLI is not a prerequisite. Catalog changes take effect
without restarting cubed, and existing threads keep their selected model.
Managed binary installations also expose **system**, where an operator can check
for and install signed cubed releases. Browser updates are opt-in and never update
runners. Source checkouts and externally managed installations remain read-only;
see [the cubed update runbook](docs/cubed-updates.md).

Create a project and enroll runners using
[the operator runbook](docs/trusted-runner-operations.md). Runners form one
global pool for every project in the installation. A new thread gets its own
machine on an available runner: a fresh overlay disk on the runner's base
image, booted with a cloud-init seed from cubed (the first boot installs `git`,
`gh` and `curl` through the gateway and takes a minute or two). The thread
shows "starting the thread's machine" until it is up; then the project's
pinned repositories are checked out at their exact commit IDs. A runner
serves one active thread at a time. Archiving checks the machine: a clean one
is deleted, one with changes, commits of its own or an unknown state is kept
on the runner. There is no automatic fleet provisioning. The global runner
panel records authenticated contact and machine counts, distinguishes a current
failure from seven days of continuous unreachability, and can permanently
retire an idle or stale installation binding without deleting audit or retained
disks. The UI supports prompts, streamed results, reconnect, model selection,
stop, rename and archive.

A thread machine reaches the internet over HTTP and HTTPS only, through the
gateway, which intercepts TLS with an installation CA and asks cubed's policy
about every request; it cannot reach cubed, the runner, the LAN or a metadata
service. `gh` and `git push` work inside it: the machine holds only a
placeholder, and the gateway puts the host's GitHub token (`gh auth token` on
the cubed host, or `CUBED_GITHUB_TOKEN`) into requests to github.com and
api.github.com. The token never enters the machine, its seed or the runner.

The current tools are `read`, `write`, `edit`, bounded `bash` and `codemode`,
which runs one model-written JavaScript script that calls those tools.
A thread can instead run on Claude Code with your own Claude Max login: choose
a model under "claude · max" when you start it. cubed starts the unmodified
`claude` binary with cube's mod, which sends Claude Code's Bash, Read, Write and
Edit to the thread's machine. Install Claude Code on the cubed host and log in
there (`claude /login`); cubed never stores Claude credentials and starts it
without `ANTHROPIC_API_KEY`. These threads are less durable than Pi's: a turn
cut off by a host restart is not continued, though no tool call runs twice.
Workspace transfer, service links, thread-to-thread tasks and machine snapshots
are not yet exposed by this implementation.

**QEMU runs as the runner's account.** Run a runner under a dedicated account
(group `kvm`) or machine without SSH, cloud, browser, Git or provider
credentials. The optional systemd/launchd server profile is documented in the
operator runbook; it is never installed by the direct flow.

## Fresh state, not migration

State schema 102 (thread machines, runner protocol 3) does **not migrate**
older registries or execution stacks: cubed refuses a v100/v101 registry, a
version-1 runner config and a protocol-2 runner. For a fresh start, stop cubed
and choose a different empty `CUBED_STATE` directory; create projects and
enroll freshly initialized VM runners. This does not erase old installations or
runner workspaces. Never copy a live Pi session into two hosts: each session
requires one writable owner.

See [DEVELOPING.md](DEVELOPING.md), [ARCHITECTURE.md](ARCHITECTURE.md),
[CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).
Apache-2.0; dependencies retain their [notices](THIRD_PARTY_NOTICES.md).
