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
instead of a machine; they need `python3`. The helper's
file tools act as the agent's account outside the workspace only as root;
`CUBE_TEST_GUEST_ROOT=1` runs that one test with `sudo -n`, and
`CUBE_TEST_GUEST_ROOT=required` (set in CI) fails without passwordless sudo. Real runner
tests use disposable state, keys and machines; do not point them at an
operator's installation. `scripts/test-node-transport.sh` always runs the
Rust tests, the real `berth host` with cubed (`runner-host-test.ts`,
`runner-host-cubed-test.ts`) and cubed's supervision of the real
cube-gateway (`gateway-test.ts`).

It also runs `berth vm` (runner protocol 4) with keel machines on
Linux with KVM and on macOS with HVF: `runner-vm-test.ts` (the guest channel,
the Workspace contract, network, credentials, portal, templates, diagnosis)
and `runner-vm-cubed-test.ts` (cubed's real code with `berth vm` as the
pool). They need `CUBE_TEST_BERTH_QEMU` and `CUBE_TEST_BERTH_QEMU_IMG`
(absolute paths to a `qemu-system-x86_64` or `qemu-system-aarch64` that meets
keel's floor, which `berth vm` checks, and its `qemu-img`),
`CUBE_TEST_BERTH_KEEL` (`packages/keel/out/x86_64` or `out/arm64` with
`vmlinuz` and `base.erofs`, from `packages/keel/kernel/build.sh <arch>` and
`packages/keel/base/build.sh <arch>`, which build in Docker),
`CUBE_TEST_BERTH_IMAGE` (a public image pinned by digest,
`registry/repository@sha256:…`; `berth vm` pulls it itself. cube's default
image, `docker.io/library/debian@sha256:4c25275446ca371766b8b093c696782eabce06263fccacb8d5d813b3dc44b308`
as `packages/berth/debian/trixie.json` pins it, is the one to use: berth
adds its Debian preparation layer with sudo, git, gh, curl, perl and a CA
bundle. Any other image must bring bash, sudo, flock, git, gh, curl, perl
and a CA bundle itself. `scripts/test-local-berth.ts` without it runs
`init-local` with no `--image`, the normal first install) and `CUBE_TEST_BERTH_MKFS` (an
absolute `mkfs.erofs`). Without them each test prints `SKIP: … did NOT run`,
and `CUBE_TEST_BERTH_VM=required` makes that a failure. Optional:
`CUBE_TEST_BERTH_ACCEL` (default `kvm` on Linux, `hvf` on macOS),
`CUBE_TEST_BERTH_FSCK` (an `fsck.erofs` for the template layer),
`CUBE_TEST_BERTH_IMAGE_B` (a second image pinned by digest; without it the
template-image and layer-cache checks say `NOT checked`),
`CUBE_TEST_BERTH_GATEWAY` (a `cube-gateway` built with `--features
test-hooks`; otherwise the tests build one under `target/test-hooks`),
`CUBE_TEST_BERTH_TMP` (a short directory instead of `/tmp`),
`CUBE_TEST_BERTH_PULLED` (a berth directory the image was pulled into before)
and `CUBE_TEST_KEEP=1` (`runner-vm-cubed-test.ts` keeps its root, with
`berth.log`, and names it in a `kept` line). On Linux:

```sh
packages/keel/kernel/build.sh x86_64 && packages/keel/base/build.sh x86_64
CUBE_TEST_BERTH_VM=required CUBE_TEST_LAYER_TOOLS=required \
  CUBE_TEST_BERTH_QEMU=/path/to/qemu-system-x86_64 CUBE_TEST_BERTH_QEMU_IMG=/path/to/qemu-img \
  CUBE_TEST_BERTH_KEEL="$PWD/packages/keel/out/x86_64" CUBE_TEST_BERTH_MKFS="$(command -v mkfs.erofs)" \
  CUBE_TEST_BERTH_IMAGE='docker.io/library/debian@sha256:4c25275446ca371766b8b093c696782eabce06263fccacb8d5d813b3dc44b308' \
  bash scripts/test-node-transport.sh
```

On macOS use Homebrew's `qemu-system-aarch64`, `qemu-img` and erofs-utils
(`/opt/homebrew/bin`), keel for `arm64`, and
`CUBE_TEST_LAYER_TOOLS=mkfs.erofs,fsck.erofs,dump.erofs` (there is no
`sfdisk`). `scripts/test-local-berth.ts` runs `cubed runners init-local` with
the real `berth vm` (the same `CUBE_TEST_BERTH_*` and an accelerator) and
then again, as after a reinstall. A `berth vm` run passed when the script
exits 0 and prints `ok: berth vm over protocol 4 (kvm|hvf): …`, `ok: cubed
with berth vm: …` and `ok: init-local with the real berth vm: …`; a SKIP line
for a part you meant to run is not a pass.

`keel-layers` (`packages/keel/layers`) tests its conversion and layer disk
with the real erofs-utils (`mkfs.erofs`, `fsck.erofs`, `dump.erofs`) and
`qemu-img` from `PATH` (`scripts/setup-dev.sh` installs them on Linux;
`brew install erofs-utils qemu` on macOS). Without them those tests print a
SKIP notice; `CUBE_TEST_LAYER_TOOLS=required` (set in CI on Linux) makes that
a failure. `keel-agent-check`'s EROFS reader (it reads the template layer
in place) is tested the same way, with `mkfs.erofs`.
`scripts/keel-layer-bench.ts` measures conversion on real public images (its
header has the command).

UI behavior is checked in a real browser: `scripts/test-browser.sh` (the end of
`pnpm test`; `pnpm test:browser` alone) builds the UI and drives Chromium. CI
installs Chromium; elsewhere install it once with `pnpm --filter @cube/web exec
playwright install chromium`, or `pnpm test` prints a SKIP notice
(`CUBE_TEST_BROWSER=required` makes that a failure). `packages/web/test/browser/chat-browser-test.ts` runs the
chat against a scripted host (`scripted-host.ts`) that sets the order and
timing of every answer and frame: a slow send, an older frame after a newer
one, a failed send, a lost stream, a reload. `cubed-browser-test.ts` runs the
real cubed and OptChat over a controlled model (`packages/server/test/chat-fixture.ts`)
with Pi's render slowed as a long chat's is. `monitor.ts` records what the
page paints after every change and checks a send's invariants over the whole
record: the message shows at once and exactly once, never goes and comes
back, and the chat reads busy from the send until the run ends, once. A
change to how the UI reads, reconciles or shows the stream needs a scenario
there; a screenshot or a unit test of a helper is not that evidence.
`long-chat-browser-test.ts` opens a 150-turn chat and thread from a window,
pages up keeping the reader's place, sends while a page loads, reconnects
from the same start and trims a window left open.
`node packages/web/test/browser/long-chat-measure.ts [runs]` (after `pnpm
build`) prints the bytes and times of a synthetic 1,000-turn chat (`TURNS`)
against the built UI; it is a measurement, not a test.

### CI

`ci.yml` is the pull-request gate, all on Linux and side by side: `check`
(references, typecheck, lint, shell syntax, shellcheck), `test (K/4)` (the
offline suites split by `CUBE_TEST_SHARD=K/4`), `browser` and
`node-transport (linux)` (`scripts/test-node-transport.sh`: the Rust crates
and the runner tests; the jobs keep the name of the protocol-3 package they
once tested, which the release gate looks for). A new push to a pull request
cancels its older run.
`platforms.yml` runs `node-transport (macos)` and the `homebrew` formula check
on every push to `main`, on pull requests that touch Rust, berth's scripts,
the Homebrew generator or CI itself, and by hand (`gh workflow run platforms.yml
--ref <branch>`). Rust dependency builds are cached; only `main` saves the
cache. `release.yml` builds nothing until `scripts/release-gate.sh` finds that
the tagged commit passed `ci` and `node-transport (macos)` on `main`.
`scripts/ci-test.ts` checks this layout: every offline suite in exactly one
shard, no check dropped, pinned actions, the gate.

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
2, 4096, 32; clamped to each runner's limits; fixed for a machine's life); a
project's own machine size (memory, processors; the project page) takes
precedence for its new threads.
`CUBED_TEMPLATES=off` turns machine templates off (every machine starts from
the base image); `CUBED_TEMPLATE_TTL_HOURS` sets how long a template is reused
(default 24). See ARCHITECTURE.md, "Machine templates and hooks".
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

Create and check a project through the UI/API, then set up a runner: on the
cubed host `cubed runners init-local` (a local `berth vm`), elsewhere a
`berth vm` from a release ([berth](packages/berth/README.md#install-from-a-release)).
Write its private connection configuration (version 2, `"protocol": 4`,
mode 0600):

```json
{"version":2,"protocol":4,"binding":{"nodeId":"node-…","threadId":"…","environmentId":1},
 "controlKey":"/abs/control.key","serverPeer":"<runner peer>","network":"loopback|direct|relay",
 "address":"host:port"}
```

(no `address` for relay) and register it with `cubed runners enroll --config
/absolute/private-runner.json --state /absolute/fresh-state`; any other
config (a protocol-3 runner's) is refused. Runners are global installation
capacity. A new thread takes a slot on a `berth vm` until archive and gets
its own machine there. The project's checked repository URLs, resolved
branches and exact OIDs are checked out inside the machine; GitHub
repositories authenticate with the placeholder that cube-gateway, through
cubed, replaces by the host's token. Git prompting is disabled.

Useful reads: `/api/threads` (with each machine's startup steps), `/api/projects`,
`/api/threads/<id>/startup-log` (the running hook's log while a machine starts), `/api/threads/<id>/history`,
`/api/threads/<id>/stream`, `/api/usage` and `/api/threads/<id>/usage`
(tokens and estimated cost; see [docs/usage.md](docs/usage.md)). Both return the neutral `ThreadTranscript`
(`packages/server/src/thread-events.ts`); the stream is SSE and starts with the
full transcript on every connection. `/api/threads` reports a thread `starting`
while its machine boots. Stop uses `POST /api/threads/<id>/stop`; DELETE archives
an idle thread, releases runner capacity and answers `{retained, reason}`: a
machine is deleted when its release check reports clean (nothing uncommitted,
every commit pushed; agent work that is committed and pushed is fine); one
with uncommitted changes, unpushed commits, files outside a checkout in an
empty project or an unknown state is retained on the runner with the reason.

`/api/threads/<id>/workspace` exposes the thread's `Workspace` (capabilities,
limits, lease, exec, operations, file and stat; see
`packages/server/src/workspace-http.ts`). Every route except reading
capabilities and acquiring the lease requires `authorization: Bearer <lease
token>`. A Pi thread's lease is held by Pi itself, so these routes admit no second
writable owner. `node packages/server/test/workspace-test.ts` runs the shared
contract offline; `runner-host-test.ts` runs it against a real `berth host`. A running operation can be long-polled with `?wait=<ms>` (at
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
`node scripts/check-claude-subagents.ts` starts the real `claude` with cubed's
arguments against a scripted Messages API on loopback (no login, no model) and
checks that it runs no subagent, fresh or resumed, while Bash still works.
`node scripts/check-claude-fail-closed.ts` does the same with cubed's
`ClaudeAgent` and mods Claude Code cannot load or whose word is refused
(N1-N10: `on` handed on, a second `session.start`, a syntax error, a throw
at load or in `register`, a missing module, no modules, no folder, another
lease's token, the previous child's nonce, too late, and both on
`--resume`): no prompt, no model request and nothing run on the host; and,
the ready gate bypassed, every host tool refused (ARCHITECTURE.md, "Claude
Code threads"). `claude plugin validate --strict` passes a `register` that
throws; `claude plugin test` fails it; the gate refuses it either way. Neither runs in CI (both
need `claude`); run them for any change to the mod, `claudeArguments` or
the Claude Code version.

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
Linux arm64 and macOS arm64 once the tagged commit has passed `ci` and
`node-transport (macos)` on `main` (the release gate, see CI). It requires the protected
`CUBED_UPDATE_SIGNING_KEY` Ed25519 PEM secret and creates a draft release. Review
the generated packages, manifests, signatures and checksums before explicitly
publishing the draft. Publication and deployment are not CI acceptance steps.
The workflow contains no runner artifacts. See [the operator update
runbook](docs/cubed-updates.md) for the manifest and supervisor contracts.

## Homebrew publishing

The macOS tap is `cubeyard/homebrew-tap`: `Formula/cube.rb` (cubed, from the
`darwin-arm64` release bundle, run directly without the update supervisor) and
`Formula/cube-berth.rb` (berth from the `darwin-arm64` berth bundle, keel's
arm64 `vmlinuz` and `base.erofs` as resources, depending on Homebrew's `qemu`
and `erofs-utils`), installed with `brew install cubeyard/tap/cube`. Both are
generated, never edited by hand:

```sh
gh release download vX.Y.Z --pattern 'cubed-darwin-arm64.json*' --pattern 'berth-darwin-arm64.json*' \
  --pattern 'keel-arm64.json*' --dir /tmp/assets
node scripts/homebrew/formula.ts vX.Y.Z --assets /tmp/assets --out /tmp/formula
```

`scripts/homebrew/formula.ts` verifies the three manifests' Ed25519
signatures with the committed key (`scripts/cubed/update-public-key.pem`,
fingerprint checked), requires the stable tag, the `darwin-arm64` platform
(keel: `arm64`), cubed's state contract (102), berth's protocol 4 and one
commit for all three, and writes formulas that pin each asset's release URL
and sha256 (`scripts/homebrew-formula-test.ts`, which also runs both
launchers). The tap's README comes from `scripts/homebrew/tap-README.md`. The
tap's `Formula/cube-runner.rb` (protocol 3) is no longer generated or
changed: it stays at its last release so that an installed `cube-runner` can
still be stopped with `brew services` and uninstalled.

`.github/workflows/homebrew.yml` runs when a release is published (or by hand
with a `version` input): it generates the formulas on a macOS runner, installs
them from the release, runs `brew audit --strict` and `brew test`, then commits
them to the tap with the `HOMEBREW_TAP_TOKEN` secret (a fine-grained token with
contents write on `cubeyard/homebrew-tap`; renew it when it expires). Drafts and
prereleases are refused, and so is a version older than the latest release
unless the `force` input says a downgrade is meant; the push runs in a second
job on Linux so the tap token never reaches the machine that ran the release's
binaries. The `homebrew` job of `platforms.yml` does the same against the latest
published release, without the push, on every push to `main` and on pull
requests that touch the generator, so a formula change is validated on a real
Mac before it is merged; it then goes through the lifecycle: both services
restarted, `brew uninstall` while they are loaded, `brew install` again, the
same restart (a new cubed process, berth's service again at `not set up
yet`), and every file under `~/.cube` unchanged throughout. It checks this
checkout's generator against the latest release's binaries, so its formula
tests assert only what every such release has (`runners status`,
`--self-check`, `berth version`, keel's digests); the generator also requires
the release's state schema and protocols to match the checkout, so a pull
request that changes either fails this job until the next release ships. It
is not a required check. GitHub's macOS runners have no nested
virtualization, so neither job starts a thread machine and berth's service
is never set up there; `cubed runners init-local` itself is tested offline
(`runner-enroll-test.ts`) and with the real berth on a host
(`scripts/test-local-berth.ts`). The tap's previous formula was a different
product (the v0.1 `cube` launcher); the tap README tells those users how to
move over. The cube formula keeps the release bundle as signed except that it
removes the prebuilt native modules a dependency (pi-tui) ships for other
platforms, which `brew audit` refuses in an arm64 keg. A backport release
published after a newer one fails the workflow's latest-release guard;
publish it by hand with `force` only if the tap should go back.

What the Homebrew layout changes against the managed launcher: `bin/cubed` is
a small wrapper that sources `~/.config/cubed/environment`, sets
`CUBE_BERTH`, `CUBE_BERTH_KEEL`, `CUBE_BERTH_QEMU`, `CUBE_BERTH_QEMU_IMG` and
`CUBE_BERTH_MKFS_EROFS` to the files cube-berth's service uses, and runs the
bundle's `bin/node` on `app/packages/server/src/index.ts` directly, so the
**system** page reports an externally managed installation and `brew
upgrade` is the update path. Services are `brew services` user agents
(labelled `sh.brew.cube` and `sh.brew.cube-berth` by current Homebrew)
running `cubed` and
cube-berth's `libexec/service.sh`, which starts `berth vm --dir ~/.cube/berth`
with `berth.env`'s image, slots and listen address, or, until `cubed runners init-local` has
set it up (`berth.json`, `berth.env` and berth's `vm.json` all there), says so and exits after 60 s (see [runner
operations](docs/runner-operations.md#local-runner)). Homebrew never stops a
service on `brew uninstall` (formulae have no uninstall hook), so the
documented step after every install or upgrade is `brew services restart`,
which starts a stopped service and replaces a stale one. Homebrew 7 asks
users to trust a third-party tap once (`brew trust cubeyard/tap`) before a
formula from it, and its dependencies, load; the formulas name the runner
dependency as `cubeyard/tap/cube-berth`. Both formulas take their version
from the release tag in their URL, so every release upgrades both. `brew
upgrade` does not restart the services and removes the previous keg; the
caveats and README say to restart them. The cube formula sets `skip_clean
"libexec"` so Homebrew's cleaner does not walk the bundle's 20,000 files, and
prints one `ohai` at the end of `install`: Homebrew shows nothing else between
`Installing` and the summary without `--verbose` ([install
progress](docs/macos.md#install-progress)).

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
Backups of the host must be taken with cubed stopped; keep Pi databases,
product metadata and `threads/<id>/vm` together (and `gateway/`, where an
installation that ran protocol 3 has it). Never erase a retained machine
disk just to retry a command.

For a runner in the foreground, run `berth vm` (or `berth host`) as in
[berth](packages/berth/README.md). Ctrl-C quits its machines' QEMUs and marks
them interrupted; the next start of a machine boots the same disk, and the
guest marks unfinished commands interrupted, never reexecuting them.
