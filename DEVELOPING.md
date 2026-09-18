# Developing cube

Read [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and
[docs/trusted-runner-operations.md](docs/trusted-runner-operations.md) for runner
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

The Node test list is `scripts/test-offline.sh`. Add tests there. Real runner
tests use disposable state, keys and workspaces; do not point them at an
operator's installation. The runner suite runs on Linux and macOS in CI. To run
only integration after building: `node scripts/smoke-node-adapter.ts target/debug/cube-runner`.
N0 relay testing is opt-in via `CUBE_TEST_IROH_RELAY=1` and contacts public services.

## Product development

```sh
pnpm build
pnpm cubed --state /absolute/fresh-state --host 127.0.0.1 --port 7777
```

The host binds `CUBED_HOST` (default `127.0.0.1`) on `CUBED_PORT` (default 7777).
`CUBED_STATE` defaults to `~/.cube-host`. Model configuration uses
`PI_CODING_AGENT_DIR` or `~/.pi/agent`;
model requests and credentials stay in the host. Never mount that directory in
a runner account. Run runners with a dedicated unprivileged account or machine.
The trust profile is not a security sandbox.

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

JEV memory is a separate optional host capability at the top of **models**.
Saving its key writes `CUBED_STATE/jev-key.json` with mode `0600`; API responses
expose only whether it is configured. With no saved key, the recall tool is
inactive and Cube makes no JEV requests. When enabled, selected prompts,
responses and tool-output excerpts are sent to TypeSafe AI. Durable notes use
Pi's thread session values, while full compressed tool output stays in the Pi
tool-result details for exact recall. Ordinary history/SSE omits that retained
original; opening a compressed tool result fetches it on demand so the inspector
can switch between **sent to model** and **original**. Removing the key disables
new classification and compression immediately without deleting prior session
evidence.

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
binding using `packages/node-transport/RUNNER.md`. Register its private connection
configuration with `scripts/enroll-runner.ts --state /absolute/fresh-state
--config /absolute/private-runner.json --trusted-runner`.
Runners are global installation capacity. A new thread atomically leases any
available runner until archive. The runner receives the checked project revision,
repository URLs, resolved branches and exact OIDs and creates fresh primary/reference
checkouts. It never receives host Git credentials and Git prompting is disabled;
repositories therefore need credential-free runner access. The initialization
workspace remains the compatibility template for empty legacy plans.

Useful reads: `/api/threads`, `/api/projects`, `/api/threads/<id>/history`,
`/api/threads/<id>/stream`. The last endpoint is SSE and starts with a full
snapshot on every connection. Stop uses `POST /api/threads/<id>/stop`; DELETE
archives an idle thread and releases runner capacity. Changed or independently
committed Git worktrees and fallback copies are retained; a clean Git worktree
still at the template HEAD is removed.

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

Registry v100/v101 receives the rollback-compatible global-pool extension in place. There is no adoption of older registries or
terminal sessions. Stop cubed and set `CUBED_STATE` to a new empty directory to reset the product. Create
projects and enroll fresh runner identities. Do not delete an unspecified live
installation. Archive recycles runner capacity, not the archived Pi session or
retained user changes.

Restart cubed against the same state to resume accepted Pi operations. Do not
run two writable owners for a session. Backups of the host must be taken with
cubed stopped; keep Pi databases and product metadata together. Runner backup,
restore quarantine, drain and recovery acknowledgement follow the runbook.
Never erase a runner's retained operation evidence just to retry a command.

For the runner's foreground development profile, use `cube-runner init` once
and `cube-runner run --home ...` thereafter as described in
[`packages/node-transport/RUNNER.md`](packages/node-transport/RUNNER.md). Human
runner lifecycle output is on stderr and stdout stays quiet; low-level commands
retain JSON stdout. First Ctrl-C drains, second Ctrl-C cancels active work and
persists `CANCELLED`. A restart marks any crash-interrupted accepted/running
record completion-unknown and never reexecutes it.
