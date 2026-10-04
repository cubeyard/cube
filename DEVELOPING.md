# Developing cube

Read [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and
[docs/runner-operations.md](docs/runner-operations.md) for runner
operations. No deployment is necessary for the local development loop.

## Checks

Node 26+, pnpm pinned in `package.json`, Rust pinned in `rust-toolchain.toml`.
On Linux `bash scripts/setup-dev.sh` installs development prerequisites and
fetches locked dependencies. On macOS install the pinned toolchains and Xcode
command-line tools, then install/fetch dependencies explicitly.

```sh
pnpm install --frozen-lockfile
cargo fetch --locked
pnpm typecheck
pnpm lint
pnpm test
pnpm build
bash scripts/test-node-transport.sh
```

The Node test list is `scripts/test-offline.sh`. Add tests there. Offline tests
run the real guest helper under a temporary root (`packages/server/test/local-guest.ts`)
instead of a VM; they need `python3` and OpenSSH's `ssh-keygen`. Real runner
tests use disposable state, keys and VMs; do not point them at an operator's
installation. With Linux, a usable `/dev/kvm`, QEMU 7.2+ and a Debian 13
genericcloud image, `CUBE_TEST_VM_IMAGE=/path/debian-13-genericcloud-amd64.qcow2
bash scripts/test-node-transport.sh` also runs the real-VM acceptance
(`smoke-runner-vm.ts`, `smoke-node-adapter.ts`, `test-vm-e2e.ts`); without them
it prints a SKIP notice, and `CUBE_TEST_VM=required` makes that a failure. To
run one of them after building:
`node scripts/smoke-node-adapter.ts target/debug/cube-runner target/debug/cube-gateway <image>` or
`node scripts/test-vm-e2e.ts target/debug/cube-runner <image>` (it builds a
`test-hooks` gateway under `target/test-hooks`). `CUBE_SMOKE_KEEP=1` keeps their
work directories.

## Product development

```sh
pnpm build
pnpm cubed --state /absolute/fresh-state --host 127.0.0.1 --port 7777
```

The host binds `CUBED_HOST` (default `127.0.0.1`) on `CUBED_PORT` (default 7777).
`CUBED_STATE` defaults to `~/.cube-host`. Model configuration uses
`PI_CODING_AGENT_DIR` or `~/.pi/agent`;
model requests and credentials stay in the host. Never mount that directory in
a runner account. Run runners with a dedicated unprivileged account (group
`kvm`) or machine; the guest is a VM, but QEMU runs as that account.

cubed starts `cube-gateway` itself: `CUBED_GATEWAY` names the binary, otherwise
a release's `bin/cube-gateway` or the checkout's `target/{release,debug}/cube-gateway`
is used (`cargo build -p cube-gateway`). Its network mode is the widest of the
enrolled runners' (relay > direct > loopback). `CUBED_VM_VCPUS`,
`CUBED_VM_MEMORY_MIB` and `CUBED_VM_DISK_GIB` size new thread machines (default
2, 4096, 32; clamped to each runner's limits; fixed for a machine's life).
`CUBED_GITHUB_TOKEN` gives the egress policy a GitHub token instead of
`gh auth token`. `CUBED_GATEWAY_TEST_ARGS` (a JSON array) is for tests with a
`test-hooks` gateway build only.

CLI flags override their matching environment variables. Use repeatable
`--allowed-host` flags instead of `CUBED_ALLOWED_HOSTS` when both are present;
`--log-level` accepts `debug`, `info`, `warn`, or `error`. `--help` and
`--version` do not open state. Startup and shutdown status goes to stdout;
errors go to stderr. SIGINT and SIGTERM share one idempotent close operation.

Open **models** in the GUI for provider login, API keys, cancellation and logout.
Pi owns the provider flows, credential persistence and token refresh. For browser
flows opened away from the host, paste the final redirect URL/code if Pi offers
that prompt. Providers without an interactive Pi flow are marked as requiring
host configuration. Logout removes saved credentials, not environment variables
or other ambient host credentials. Pending login interactions expire after 15
minutes and are cancelled on host shutdown; restart the login after a host crash.
Connecting or disconnecting refreshes availability without a cubed restart.
An unavailable selected model stays selected until explicitly changed; its
transcript remains readable. Use **refresh models** after a catalog fetch error.
Offline auth acceptance uses a controlled provider and real Pi credential storage
in disposable state; it never signs in to a live account.

For direct Tailscale access, set `CUBED_HOST` to the host's Tailscale IP and list
its exact MagicDNS name/IP in comma-separated `CUBED_ALLOWED_HOSTS`. Binding
`0.0.0.0` listens on every IPv4 interface: use it only when firewall/network
controls restrict access to the intended private clients. Tailnet access grants
full Cube access; there is no application-level user authentication.
Host headers default to loopback names. An authenticated private reverse proxy
is also supported; allow its exact hostname and preserve Host/Origin consistently.
The host allowlist prevents DNS rebinding; it does not restrict network ingress
or authorize public exposure.

Create and check a project through the UI/API, then initialize an immutable runner
binding (with its base image) using `packages/node-transport/RUNNER.md`. Write its
private connection configuration (version 2, mode 0600):

```json
{"version":2,"binding":{"nodeId":"node-…","threadId":"…","environmentId":1},
 "controlKey":"/abs/control.key","serverPeer":"<runner peer>","network":"loopback|direct|relay",
 "address":"host:port"}
```

(no `address` for relay) and register it with `scripts/enroll-runner.ts --state
/absolute/fresh-state --config /absolute/private-runner.json --trusted-runner`;
the script refuses a protocol-2 runner. Runners are global installation
capacity. A new thread atomically leases any available runner until archive and
gets its own VM there. The project's checked repository URLs, resolved branches
and exact OIDs are checked out inside the VM through the gateway; GitHub
repositories authenticate with the placeholder the gateway replaces by the
host's token. Git prompting is disabled.

Useful reads: `/api/threads`, `/api/projects`, `/api/threads/<id>/history`,
`/api/threads/<id>/stream`. Both return the neutral `ThreadTranscript`
(`packages/server/src/thread-events.ts`); the stream is SSE and starts with the
full transcript on every connection. `/api/threads` reports a thread `starting`
while its machine boots. Stop uses `POST /api/threads/<id>/stop`; DELETE archives
an idle thread, releases runner capacity and answers `{retained, reason}`: a
machine is deleted only when the agent never ran a command or wrote a file in
it (cubed's own record) and its release check reports clean; one with agent
commands, changes, commits of its own or an unknown state is retained on the
runner. The guest is agent-controlled, so its own report never alone deletes a
disk.

`/api/threads/<id>/workspace` exposes the thread's `Workspace` (capabilities,
limits, lease, exec, operations, file and stat; see
`packages/server/src/workspace-http.ts`). Every route except reading
capabilities and acquiring the lease requires `authorization: Bearer <lease
token>`. A Pi thread's lease is held by Pi itself, so these routes admit no second
writable owner. `node packages/server/test/workspace-test.ts` runs the shared
contract offline; `scripts/smoke-node-adapter.ts` runs it against a real VM. A running operation can be long-polled with `?wait=<ms>` (at
most 30000).

A claude-code thread holds its lease in cubed for the Claude Code child, which
reaches the same routes on `CUBED_STATE/run/workspace.sock` through the mod in
`packages/claude-mod`. cubed finds `claude` on `PATH`; `CUBED_CLAUDE=<path>`
names another binary and `CUBED_CLAUDE=off` disables claude · max. Tests never
start the real CLI: `packages/server/test/claude-agent-test.ts` and the product
smoke use `packages/server/test/fake-claude.ts`, which speaks stream-json and
runs the mod's tool functions over the socket. `bash scripts/check-claude-mod.sh`
runs `claude plugin validate`, `claude plugin test` (the mod's tests against the
engine with the routes answered in memory; no model call) and, with
`CLAUDE_CODE_TYPES` pointing at Claude Code's `claude-code.d.ts`, tsc.

Runner operations are installation-global. `GET /api/runners` returns persisted
contact and the current global allocation snapshot without private adapter paths;
`POST /api/runners/<id>/check` performs a fresh authenticated check. Retirement
uses `POST /api/runners/<id>/retire` with the exact node ID in `confirm` and a
non-empty audit `reason`. It is unavailable while the global snapshot contains an
active thread/workspace, while a reachable runner reports active work, or while an
unreachable binding has not yet been continuously unreachable for seven days.
Retirement removes global capacity but does not delete runner state or evidence.

For UI changes use the existing browser workflow: build, run cubed on disposable
state, check desktop and phone (390×844), exercise affected interactions and
inspect screenshots. In an Amp orb use supervised orb services and portal URLs,
not an unmanaged background shell. Never expose unauthenticated cubed publicly.

## cubed release acceptance

`node scripts/cubed-update-test.ts` exercises the real foreground supervisor with
a disposable signed feed. It verifies capability authorization, the single-owner
lock, checksum/signature enforcement, atomic activation, state preservation,
readiness rollback and interrupted-update recovery. It is part of
`scripts/test-offline.sh`. A local packaging acceptance can use a disposable
Ed25519 key with `scripts/cubed/build-release.ts`, then run `install.sh` against
the resulting archive and manifest. Never use the production signing key locally.

Pushing a stable `vX.Y.Z` tag runs `.github/workflows/release.yml` on Linux x64,
Linux arm64 and macOS arm64. It requires the protected
`CUBED_UPDATE_SIGNING_KEY` Ed25519 PEM secret and creates a draft release. Review
the generated packages, manifests, signatures and checksums before explicitly
publishing the draft. Publication and deployment are not CI acceptance steps.
The workflow contains no runner artifacts. See [the operator update
runbook](docs/cubed-updates.md) for the manifest and supervisor contracts.

## Fresh start and recovery

State schema 102 (thread machines) adopts no older registry (v100/v101 are
refused), runner config (version 1) or runner (protocol 2). Stop cubed and set
`CUBED_STATE` to a new empty directory to reset the product. Create projects,
initialize fresh VM runners and enroll them. Do not delete an unspecified live
installation. Archive recycles runner capacity, not the archived Pi storage or
retained user changes. Threads created before the move to pi-durable 1.0.1 are
not migrated: reset to a new `CUBED_STATE` as above. cubed refuses to open such a
thread (its directory still has `session/` or `owner.sqlite`) rather than run its
first message again, and the state schema is 102, so a managed schema 100 or 101
installation is not updated in place.

Restart cubed against the same state to resume accepted Pi tasks; thread
machines keep running meanwhile. Do not run two writable owners for a session.
Backups of the host must be taken with cubed stopped; keep Pi databases, product
metadata, `threads/<id>/vm` keys and `gateway/` (the installation CA) together.
Runner backup, restore quarantine, drain and recovery acknowledgement follow the
runbook. Never erase a retained machine disk just to retry a command.

For the runner's foreground development profile, use `cube-runner init` once
and `cube-runner run --home ...` thereafter as described in
[`packages/node-transport/RUNNER.md`](packages/node-transport/RUNNER.md). Human
runner lifecycle output is on stderr and stdout stays quiet; low-level commands
retain JSON stdout. First Ctrl-C refuses new machines and powers the guest down,
a second makes QEMU quit at once. A restart marks a machine that was running
stopped and interrupted; its next start boots the same disk, and the guest
marks unfinished commands interrupted, never reexecuting them.
