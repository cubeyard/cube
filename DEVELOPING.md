# Developing cube

Two loops, by what you're changing. The **mock loop** develops cubed's own
logic and UI from inside an ordinary cube (fast, no Incus). The **VM loop**
validates the real sandbox and the live pi TUI (slow, real Incus).

See `PLAN.md` for the architecture and `HANDOFF.md` for current state.

---

## Backends (`CUBED_BACKEND`)

cubed talks to a swappable `CubeBackend` (`packages/sandbox/src/cube-backend.ts`).

- **`incus`** (default) — real cubes over the local Incus socket. The cube IS
  the sandbox. This is production.
- **`mock`** — cube ops simulated in memory; no Incus daemon needed. Cube
  commands (a repo's `.cube/setup`, wake hooks, service control, pi tools and
  `!` commands) run LOCALLY with cubed's own uid — there is **no nested
  isolation**. That is safe *only because this mode is meant to run inside a
  real cube*: the outer cube is the sandbox. cubed prints a loud banner to say
  so. Never point `CUBED_BACKEND=mock` at an untrusted repo on a host you care
  about.

---

## The mock loop — develop cube with cube

The tier-1 loop (PLAN §13 3d.3). You're inside a cube (or any trusted box),
running cubed against the cube repo with the backend mocked, iterating on the
server / registry / portals / web UI with real git, real files, and fast
feedback.

```bash
pnpm install
pnpm build                      # builds the web UI into packages/web/dist
                                # (cubed serves API-only without it)

# From a throwaway state dir so you never touch a real cube tree:
CUBED_BACKEND=mock \
CUBED_ALLOW_LOCAL_REPOS=1 \
CUBED_DB=/tmp/dev/cubed.db \
CUBED_CUBES_ROOT=/tmp/dev/cubes \
CUBED_REPOS_ROOT=/tmp/dev/repos \
CUBED_IDLE_MS=0 \
pnpm cubed                      # → http://localhost:7777
```

Create and check a project, then start a thread from it (a local path needs
`CUBED_ALLOW_LOCAL_REPOS=1`):

```bash
PROJECT_ID=$(curl -sX POST localhost:7777/api/projects \
  -H 'content-type: application/json' \
  -d '{"name":"demo","repositories":[{"url":"/abs/path/to/some/repo"}]}' \
  | jq -r .project.id)

curl -sX POST "localhost:7777/api/projects/$PROJECT_ID/check" >/dev/null
while [ "$(curl -s "localhost:7777/api/projects/$PROJECT_ID" | jq -r .project.status)" = checking ]; do
  sleep 0.2
done
[ "$(curl -s "localhost:7777/api/projects/$PROJECT_ID" | jq -r .project.status)" = ready ] || exit 1

curl -sX POST localhost:7777/api/threads \
  -H 'content-type: application/json' \
  -d "{\"projectId\":\"$PROJECT_ID\"}"
```

The project check prepares an exact repository snapshot. The thread provisions
instantly (mock), seeds that snapshot under
`$CUBED_CUBES_ROOT/<name>/workspace`, and runs the repo's `.cube/setup` there.

**What works under the mock:** the HTTP API, the registry (SQLite), thread
lifecycle + statuses, git seeding / diff / Push / PR, the files shelf, portal
registry + proxy routing, the whole web shell, and the real pi TUI. The cube
extension receives `CUBE_BACKEND=mock`; its file tools and bash/`!` commands
execute locally against the thread workspace through the same bounded tool
adapters used by the Incus path. `.cube/setup`, resume, and wake hooks also
execute for real (under `bash -lc`, matching the Incus `su - dev -c` login
shell), rebased onto the host workspace.

**What does NOT work under the mock** (by design — use the VM loop):
- **Real isolation and systemd service *starts*.** `execSimple` is not root and
  there's no per-cube systemd, so declared services stay best-effort; the
  portal registry/proxy logic still exercises.

Mock instance state is **process-lifetime**: a cubed restart forgets its cubes,
so waking a stale thread fails loudly rather than running its hooks in the wrong
directory. Recreate threads after a restart.

---

## The VM loop — validate the real sandbox

To build from source, install the host requirements described below, then:

```sh
git clone https://github.com/cubeyard/cube.git
cd cube
bash scripts/vm/dev.sh      # build what's missing, boot, open pi on the VM
```

A single VM is the Incus host, assembled from three build products plus
your data disk:

| disk | contents | built by |
|---|---|---|
| base (`cube-vm-base.qcow2`) | NixOS: incus + ZFS + firewall + data-init + the seed unit (`scripts/vm/base/`), assembled by systemd-repart — no VM, no KVM, so CI can build it on any runner | `build.sh` (`nix build`) |
| app (`cube-vm-app.qcow2`, ext4 `LABEL=cubed`) | `/opt/cube`: `bin/cubed`, the app's own node runtime (`node/`), and the app tree (`app/`: cubed from source, built web UI, prod deps, `build-id`) | `build-app.sh` |
| app tarball (`cube-vm-app.tar.zst`) | `app/` alone, ~30 MB — what an in-place upgrade streams into a running VM (`cube-app-apply`) | `build-app.sh` (same staged tree) |
| cube-node (`cube-vm-node.qcow2`, ext4 `LABEL=cube-node`) | inner container image, imported by the base at boot | `build-cube-node.sh`, or inherited from a release (`inherit-cube-node.sh`) |
| data (`cube-vm-data.qcow2`) | ZFS pool: ALL mutable state | created blank; never replaced |

Boots never open a pristine disk read-write: base and app ride on qcow2
overlays (`cube-vm-live.qcow2`, `cube-vm-app-live.qcow2`), cube-node is
attached read-only. `build.sh`/`build-app.sh` replace a disk together
with its overlay and touch nothing else.

`pnpm vm` builds what's missing on first run, brings the VM up, and drops
you into a pi terminal on the VM as the user cubed runs as (so `/login`
there writes the `~/.pi/agent/auth.json` cubed reads). The VM is the
Tailnet node; cubed has no auth, so the Tailnet is the boundary (PLAN §15) —
`0.0.0.0`/public binds are refused.

GitHub auth for the VM is connected from the web UI by relaying the normal
`gh auth login --web` device flow. `GET /api/github/auth` reports the state,
including credentials created manually with `gh auth login`. GitHub CLI's
credential store is the sole source of truth; cubed stores no access or
refresh tokens. Disconnect runs `gh auth logout` on the VM.

Before projects or threads appear, the first-run wizard offers GitHub login
or a skip. Finishing writes `onboarding.json` alongside `cubed.db` (normally
`~/cube/onboarding.json`). This is VM-wide state, not browser storage.

### Review fixes on native GitHub PR stacks

The agent's code-mode API supports existing PR updates through
`preparePrUpdate`, `planPrUpdate`, `publishPrUpdate`, and `verifyPrUpdate`.
These use GitHub's native Stack REST API and GraphQL queue state via the
host's authenticated `gh api`; installing `gh-stack` is not required.
See [GitHub's stack reference](https://docs.github.com/en/pull-requests/reference/stacked-prs-cli-commands).

1. Read the PR and all relevant review/comment pages with `cube.github.read`.
2. Call `cube.git.preparePrUpdate(repositoryId, prNumber)`. Cube reads and
   validates the entire ordered stack, fetches the actual head objects into
   a host-owned repository, and imports them through a static bundle. It
   returns a fresh local branch at the exact remote PR head. Switch to that
   branch before editing. Existing local branches and worktrees are never
   reset; a dirty worktree must be dealt with first.
3. Make and test the scoped fix, adding commits without rewriting the PR's
   existing history. Call `cube.git.planPrUpdate(repositoryId, token)`.
   Cube freezes those commits, rebases each descendant onto its updated
   parent in the host-owned repository, and returns compact per-PR summaries
   with before/after SHAs, diffstats, UTF-8 byte counts, and SHA-256 hashes.
   Repeating this call with the same candidate reuses the saved plan ID and
   descendant SHAs, including after restart. Planning and inspection are
   entirely local: they use the prepared snapshot without GitHub calls or
   credential refresh. A plan may therefore be stale; publication rechecks
   the complete remote snapshot and rejects it before push if anything changed.
   Read each PR's diff from the saved commit IDs with
   `cube.git.inspectPrUpdatePlan(repositoryId, token, plan, { number, section, page })`.
   Read both `patch` (incremental change) and `prDiff` (resulting PR diff),
   following `nextPage` until null. Pages contain at most 16000 UTF-16 code
   units, so even long lines and JSON escaping fit the output limit. Hashes
   cover the complete UTF-8 diff, not individual pages. Inspection does not
   replan or check remote freshness. Each call computes only the requested
   diff from pinned commits in the host repository, even after local or remote
   changes. Diff text and summaries are not cached or persisted; the stored
   plan still contains only its ID, candidate SHA, and layer SHAs. A new
   candidate replaces the plan and invalidates its
   old ID. Review all pages before publishing; summaries and hashes do not
   replace content inspection. Conflicts or incomplete diff capture produce
   no publishable plan. Git's per-command 4 MiB capture limit still applies.
4. When publication is authorized, call
   `cube.git.publishPrUpdate(repositoryId, token, plan)`. Cube rechecks the
   snapshot, then pushes all changed branches with `--atomic` and explicit
   original-SHA leases. It never uses mutable local tracking refs as leases
   or falls back to a partial/non-atomic push. It preserves PR numbers,
   base branches, and stack membership rather than recreating or relinking
   PRs. Verification requires the planned head SHAs and unchanged stack
   order/bases, checked through both GitHub and the Git transport.
5. After a disconnect or uncertain result, call
   `cube.git.verifyPrUpdate(repositoryId, token)`. The host persists intent
   before pushing and refuses to repeat a consumed plan, including after a
   restart. It never automatically rolls back potentially newer remote work.

Direct push/PR creation cannot publish a detected existing PR; use the
review workflow instead. `syncBase` still refreshes only the configured
repository base and is not a PR-head or stack synchronization operation.
Standalone PRs use the same review workflow when GitHub explicitly reports
no native stack. A contiguous merged prefix is retained in
`stack.mergedPrefix` as historical membership; `stack.layers` contains only
the open suffix. Cube verifies each prefix PR's `merge_commit_sha` is an
ancestor of the fetched trunk, including squash/rebase results and shared
native group-merge commits. Old PR head SHAs need not be ancestors of trunk,
and merged branch refs need not exist. Only active heads are fetched,
restacked, leased, and published; merged branch refs are never recreated.
GitHub owns partial-merge retargeting: the first open PR must already target
the native stack's trunk. Retained merged members need no unstacking or
metadata cleanup. If retargeting has not completed, preparation stops with
an explicit native-reconciliation message rather than guessing a base.
Closed-but-unmerged, queued, forked, inconsistent, or inaccessible layers,
non-prefix merges, unverified merge results, and nonlinear descendant
histories still stop before publication.
Review snapshots and their Git objects live under `reposRoot/pr-reviews/`
on the host, not in the guest, and survive cubed restarts.

GitHub does not expose a transaction spanning Git refs and stack metadata.
Atomic leases prevent overwriting concurrent changes to the updated refs;
pre/post checks detect concurrent membership, base, or predecessor changes,
but cannot lock those relationships during the push. A post-check failure
means refs may already have changed and requires reconciliation, not retry
or rollback. The agent still needs to judge whether the review patch is
within the user's requested scope; ancestry alone cannot prove that.

### VM host requirements and persistent state

**Hosts:** Linux (KVM) and macOS (HVF). The dev loop needs qemu, UEFI
firmware for the guest arch (Linux: `apt install ovmf`; macOS: brew's
qemu ships the edk2 files), node ≥ 26 with npm (pnpm is installed at the
version `package.json` pins — no host pnpm needed), e2fsprogs
(`mke2fs -d`; keg-only on macOS: add `$(brew --prefix e2fsprogs)/sbin`
to PATH), `zstd`, and — for building the BASE image — nix with a Linux
builder. On macOS, skip building the base: point `CUBE_BASE_IMAGE` at a
base qcow2 from a release (or any Linux-built one) and `build.sh`
installs it instead. The app's dependencies are always installed for
the GUEST platform (linux/<arch>), whatever the host is — node-pty's
prebuilds are per-platform optional deps, and a darwin one on the disk
would kill every thread's terminal at spawn. The guest arch always
follows the host arch (arm64 mac ⇒ arm64 VM); hardware acceleration is
required — cross-arch TCG emulation is not a supported loop.
`scripts/vm/lib.sh` shims the host-tool differences (`flock`→`shlock`,
`genisoimage`→`hdiutil`, `sha256sum`→`shasum`); disks under
`~/cube/vm/` are per-arch and per-machine.

The base image carries **no trust** (a nix-built image has never booted,
so it never HAD keys): every boot attaches a tiny seed disk
(`LABEL=CUBESEED`) holding `authorized_keys` for the `cube` user, and the
base's `cube-seed` unit installs it on every boot as an exact replace —
rotating the key revokes the old one. `run.sh`/`up.sh` build it from
`~/cube/vm/id_ed25519`, the `cube` launcher does the same per deploy.
There is no cloud-init (dropped 2026-09-02: python + cloud-init were
~140 MB for one file copy). Host keys are sshd's, generated on the base
overlay's first boot and stable until the overlay is reset.

**State persistence (the data disk).** All mutable product state lives in
`cube/state/*` ZFS datasets on the DATA disk, mounted by the baked
`cube-data-init` oneshot before incus and cubed start (legacy mountpoints,
mounted explicitly by the oneshot — no auto-mount races):

| dataset           | mountpoint             | holds                                    |
|-------------------|------------------------|------------------------------------------|
| `cube/state/incus`| `/var/lib/incus`       | incus DB, images, per-install server cert|
| `cube/state/cubed`| `/home/cube/cube`      | `cubed.db`, `onboarding.json`, cubes/repos workspaces |
| `cube/state/pi`   | `/home/cube/.pi`       | `/login` credential, pi session files    |
| `cube/state/gh`   | `/home/cube/.config/gh`| GitHub CLI credential store |

A missing dataset is created and seeded from whatever the OS disk holds
at that path. incus ships NO baked state: it starts empty and its NixOS
preseed adopts the pool on first boot (layout: `cube/incus` is incus's
world, `cube/state/*` is ours). Swapping any of the base/app/cube-node
disks therefore keeps threads, `/login`, github auth AND incus's
instance registry — no path in the loop destroys the data disk anymore;
delete `~/cube/vm/build/cube-vm-data.qcow2` yourself if you truly want a
blank slate.

```bash
pnpm vm                                   # up + pi terminal (builds base+app
                                          # on first run)
bash scripts/vm/up.sh                      # boot without opening pi
bash scripts/vm/ssh.sh                     # shell on the VM
CUBE_VM_BIND=tailscale bash scripts/vm/up.sh   # reach cubed from another
                                               # machine (adds a 2nd hostfwd on
                                               # this node's 100.x address)
bash scripts/vm/down.sh                    # stop the VM
bash scripts/vm/sync.sh                    # deploy latest ORIGIN/MAIN into the
                                           # running VM + restart cubed —
                                           # threads//login survive
bash scripts/vm/build.sh                   # rebuild the BASE image (nix; OS
                                           # only — data disk untouched)
bash scripts/vm/build-app.sh               # rebuild the app disk from the
                                           # WORKING TREE (boot to pick up)
bash scripts/vm/build-cube-node.sh         # rebuild the inner image (needs
                                           # the VM up; rarely changes)
bash scripts/vm/test.sh                    # full portfolio inside the VM
                                           # (offline suites + real-Incus smokes)
```

The app disk builds from the **working tree** (tracked +
untracked-unignored), so an in-progress slice tests itself. After a
build+run in a harness worktree, the LOCAL main checkout is behind —
`git pull` in `~/repos/cube` before running cubed from there.

**cubed moves faster than the disks — sync instead of rebuilding.** cubed
runs straight from source in the VM (no server build step; only the web
UI builds), so `sync.sh` upgrades a running VM to the latest landed code
in seconds: fetch `origin/main`, `git archive` it over `/opt/cube/app` (on the
app overlay), `pnpm install && pnpm build` with the disk's own
node, restart cubed. Threads, `/login`, github auth and the data disk
survive. It deliberately deploys origin/main (what landed), not your
working tree — the working tree's loop is the mock backend, and OS-level
changes (`scripts/vm/base/`, incus, firewall) still need `build.sh`.
The first sync after an app-disk build re-downloads dev deps (~a
minute); after that the store is warm.

Tests: run offline suites directly with `node packages/**/test/*.ts` on any
host; the real-Incus smokes (`*-smoke.ts`) need the VM and run via
`scripts/vm/test.sh` (guest `run-tests.sh`). `pnpm lint` (ESLint,
correctness rules only — `eslint.config.js`) runs in CI between
`pnpm typecheck` and the offline suites.

## Releasing

Publishing is disabled unless the repository Actions variable
`CUBE_RELEASES_ENABLED` is exactly `true`. Leave it unset during initial import
and source-only publication. Manual dry runs remain available and publish
nothing; `dry_run` defaults to `true`. Enable publishing only after artifact
license review and VM acceptance. The first release needs a manually chosen
`vX.Y.Z` tag; a new repository has no prior version to increment. For this
repository, start with `v0.1.0`.

Once publishing is enabled, create the first release explicitly:

```sh
git tag -a v0.1.0 -m 'cube release v0.1.0'
git push origin v0.1.0
```

After that, ordinary shipped-file changes release the next patch when pushed:

```sh
git push origin HEAD:main
```

That is the release. Trunk-based: main is the sign-off point, and every
push to it that touches shipped files (anything but `*.md`, `docs/`,
`.claude/`, `spikes/`) becomes the next PATCH release on its own.
`.github/workflows/release.yml` tags main's commit `vX.Y.(Z+1)`,
builds every artifact for both architectures natively (amd64 on
`ubuntu-latest`, arm64 on `ubuntu-24.04-arm`), verifies the amd64 set by
installing it with the launcher on a blank data disk, running a nested
container and applying the app tarball in place, and only then
publishes. ~12 min. The launcher itself is uploaded as the asset `cube`,
so the install line never changes. A release is an offer, not a rollout:
nothing upgrades until `cube upgrade`, and `cube upgrade vX.Y.Z` walks
back. Runs queue one at a time and every pending run waits its turn.
An automatic release that fails takes back its own tag and draft — only
those, checked by tag object id and a run marker in the notes — so the
next push mints a fresh number; whatever it cannot take back fails the
`cleanup` job visibly. Release notes list the commits since the
previous release (`docs:` excluded).

Minor/major bumps are a hand-made tag, pushed BEFORE main — a main push
whose commit already carries a `vX.Y.Z` tag does nothing, while the other
order builds the same bytes twice:

```sh
git tag -a v0.7.0 -m 'cube release v0.7.0' && git push origin v0.7.0
git push origin HEAD:main
```

The next automatic release counts on from it.

Manual runs (Actions → release → Run workflow) take three inputs:
`version` (an existing tag — the workflow checks out THAT tag, not the
branch the form shows), `prerelease` (publish hidden from `cube up`'s
"latest"; promote later with `gh release edit vX.Y.Z
--prerelease=false`), and `dry_run` (build + package + verify from the
chosen branch, publish nothing — how to test the pipeline itself:
`gh workflow run release.yml --ref <branch> -f dry_run=true`).

What a release contains, per arch: `cube-base-<v>-<arch>.qcow2`,
`cube-app-<v>-<arch>.qcow2`, `cube-app-<v>-<arch>.tar.zst`,
`cube-node-<v>-<arch>.qcow2`, `manifest-<arch>.json` (flat, schema 2:
version, build_id, commit, `runtime_id`, `images_tree`, per-artifact
file/sha256/bytes, `node_inherited_from`) and `SHA256SUMS.<arch>`.

**Only what changed is new.** The base is a pure function of
`scripts/vm/base/` (nix), so two releases with the same config produce
byte-identical base images. cube-node is built from mutable inputs, so
`inherit-cube-node.sh` reuses the published artifact whenever the
`images/` git tree is unchanged (recorded as `images_tree`), copying the
exact bytes into the new release. The app changes every release; its
tarball is ~30 MB. Net effect: a typical app-only release costs the
user a 30 MB download and no reboot.

`scripts/vm/release.sh vX.Y.Z [--no-publish]` is the one-machine escape
hatch. It shares the workflow's steps (`build*.sh`,
`inherit-cube-node.sh`, `package-release.sh`, `verify-release.sh`) so
the two cannot drift, runs in an isolated build dir
(`~/cube/vm/release/<version>`, ports 2422/7977) and builds from a clean
worktree of the tag. Do not run it AND let the workflow run for the same
tag — they would race the same draft.

## Diagnostics

The release launcher runs diagnostics inside the VM:

```bash
cube diagnose                         # collect a bundle, then open interactive Pi RCA
cube diagnose --collect-only          # collect without calling a model
cube diagnose --export <bundle-id> > cube-diagnostics.tar.gz
```

From a VM shell, the equivalent entry point is
`sh /opt/cube/app/scripts/diagnose.sh`. This entry point ships in app-only
updates too; it does not require a new base image. Model-assisted diagnosis
requires existing Pi authentication in the VM and sends collected evidence
to the selected model provider when you submit a message. Pi opens with no
automatic prompt: describe the issue, paste the failing tool output, and ask
follow-up questions. Use `/model` to choose a model (before or during the
analysis), and `/quit` to exit. The launcher allocates an SSH terminal for
this session; direct SSH callers should use `ssh -t`. Collection and export
remain non-interactive. Pi has only a
`read` tool restricted to the package; it reports likely causes and does not
attempt repairs. Collection and Pi write only their diagnostic output/session.
Review every bundle before sharing it; log redaction reduces exposure but
is not perfect. Host logs can include information from multiple workspaces.

Packages are retained under `~/cube/diagnostics/<id>/` on the VM. The export
contains `bundle/` and `report.md` (the latest successfully completed Pi
answer, when present), not terminal output or the full Pi session. Ask Pi
for a consolidated report before exiting if the last answer was a follow-up.
Interrupted or failed answers do not replace the last completed report. There
is no automatic upload or deletion. Collection remains usable without cubed,
Incus, or model access: unavailable checks are recorded individually. This
first version covers the VM/control plane, not workspace contents or the
original tool process's environment. Its HTTP probe uses VM port 7777.
The cubed journal check covers the last 24 hours (at most 2000 entries);
cubed's own lines are `level component msg key=value …`, so
`grep thread=<id>` in `cubed-journal.txt` follows one thread.

## The launcher (`launcher/cube`)

The user-facing lifecycle CLI: `up/down/status/upgrade/ssh/logs/diagnose/
version/destroy` against a released artifact set — standalone bash, no repo
checkout, state in `~/.cube`. Before the first download it checks the
host (hypervisor, UEFI firmware, ISO tool, ssh, curl, free space, ports;
an unclaimed busy port moves to the next free one and is remembered in
`~/.cube/config`). Downloads go through the GitHub API with `gh`'s token
(`curl`, progress bar, resumable), are verified against the manifest +
`SHA256SUMS.<arch>`, and land content-addressed in `~/.cube/images`.

`cube upgrade` compares the installed and target manifests and does the
least that is correct:

- **app only** (base, cube-node and `runtime_id` unchanged — the common
  case): fetch the ~30 MB tarball, stream it into the RUNNING VM
  (`cube-app-apply` unpacks beside the live tree, checks the runtime
  contract, swaps directories around a cubed restart). Seconds, no
  reboot, containers keep running.
- **anything else**: stop, reset exactly the overlays whose backing
  bytes changed (the app overlay only when the runtime changed), boot,
  then apply the tarball if the app also moved. The data disk is never
  touched.

Afterwards it prunes the store to the current + one previous release
and replaces itself with the release's `cube` asset. `cube up` and
`cube status` print a one-line hint when a newer release exists
(4-second budget, silent offline; `CUBE_NO_UPDATE_CHECK=1` disables).
A manifest with a schema this launcher does not understand is refused
with the download line for the matching launcher.

Smoke-test it against a packaged-but-unpublished release, on ports that
dodge the dev VM:

```bash
bash scripts/vm/release.sh vX.Y.Z --no-publish
CUBE_HOME=/tmp/cube-smoke CUBE_RELEASE_DIR=~/cube/vm/release/vX.Y.Z/dist \
  CUBE_SSH_PORT=2722 CUBE_PORT=7877 launcher/cube up
```

`CUBE_LIB_ONLY=1 . launcher/cube` sources its functions without running
a command (what `verify-release.sh` and ad-hoc tests use).

---

## Environment variables

**cubed** (`packages/server/src/index.ts`):

| var | default | meaning |
| --- | --- | --- |
| `CUBED_BACKEND` | `incus` | `incus` or `mock` |
| `CUBED_PORT` | `7777` | HTTP listener (UI + API + portals) |
| `CUBED_DB` | `~/cube/cubed.db` | SQLite registry path |
| `CUBED_CUBES_ROOT` | `~/cube/cubes` | per-cube `{workspace,sessions}` root |
| `CUBED_REPOS_ROOT` | `~/cube/repos` | bare-mirror root for checked project repositories |
| `CUBED_ALLOW_LOCAL_REPOS` | off | set `1` to allow `file://` / local-path repos |
| `CUBED_IDLE_MS` | 1h | idle-to-sleep; `0` disables the sweep |
| `CUBED_AUTH_PROVIDER` | `openai-codex` | provider whose host auth state appears in the UI |
| `CUBED_SUBNET_MIN` | `10` | first per-cube subnet index; tests reserve higher bands |
| `CUBED_PORTAL_BASE` | `<tailscale-ip>.sslip.io`, else `127.0.0.1.sslip.io` | portal hostname base (`<svc>--<cube>.<base>`); VM seed supplies the host address |
| `CUBED_PUBLIC_PORT` | `CUBED_PORT` | port in portal URLs; VM seed supplies the host's forwarded port |
| `CUBED_PTY_LINGER_MS` | 30m | keep a pi TUI alive this long after the last detach |
| `CUBED_IMAGE` / `CUBED_POOL` | `cube-node` / `cube` | Incus image + storage pool |
| `CUBED_ROOT_SIZE` / `CUBED_DOCKER_VOLUME_SIZE` | `10GiB` / `5GiB` | per-cube disk |
| `CUBED_EGRESS_ALLOW` | — | extra allowed egress hosts (extends the defaults) |
| `CUBED_LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error`; one `level component msg key=value` line per event on stdout (`journalctl -u cubed`); `debug` adds stacks to every error field |

**VM scripts** (`scripts/vm/lib.sh`): `CUBE_VM_BIND` (`tailscale` or an explicit
private IP; defaults to detected Tailscale IPv4, else loopback; `127.0.0.1`
forces local-only use; loopback always kept), `CUBE_VM_MEM` (`8G`),
`CUBE_VM_CPUS` (`6`), `CUBE_VM_SSH_PORT` (`2222`), `CUBE_VM_CUBED_PORT` (`7777`),
`CUBE_VM_DIR` (`~/cube/vm`), `CUBE_VM_DATA_SIZE` (`40G`), `CUBE_BASE_IMAGE`
(install a prebuilt base instead of `nix build`).

**Launcher** (`launcher/cube`; env beats `~/.cube/config` beats defaults):
`CUBE_HOME` (`~/.cube`), `CUBE_REPO` (`cubeyard/cube`), `CUBE_RELEASE_DIR`
(local assets instead of GitHub), `CUBE_PORT` (`7777`), `CUBE_SSH_PORT`
(`2222`), `CUBE_BIND` (same rules as `CUBE_VM_BIND`), `CUBE_MEM` (`8G`),
`CUBE_CPUS` (`6`), `CUBE_DATA_SIZE` (`40G`), `CUBE_NO_UPDATE_CHECK`.

**Toolchain pins:** Node 26 (`build-app.sh` `NODE_VERSION`, CI
`node-version`, `package.json` engines) and pnpm via `packageManager` in
`package.json` — build-app.sh, CI and the app disk all install exactly
that version; a different local pnpm still works for the mock loop.

## Homebrew publishing

The macOS tap is `cubeyard/homebrew-tap` (`Formula/cube.rb`), installed
with `brew install cubeyard/tap/cube`. It packages only the Bash launcher
and depends on QEMU; VM downloads remain an explicit `cube up` operation.
The formula sets `INSTALL_METHOD=homebrew` so `cube upgrade` never replaces
Homebrew's launcher or symlink. `brew upgrade cube` owns launcher updates.
Uninstalling the formula does not stop or delete the VM: run `cube down`
first, or `cube destroy --yes` if the user wants to delete their data too.

One-time setup (requires repository-owner authorization):

1. Create the public `cubeyard/homebrew-tap` repository with an initial
   README commit and a default branch.
2. Create a fine-grained token restricted to that repository with Contents:
   read/write. Store it as `HOMEBREW_TAP_TOKEN` in `cubeyard/cube` Actions
   secrets. The normal `GITHUB_TOKEN` cannot push to the other repository.
3. Set the `cubeyard/cube` Actions variable `CUBE_HOMEBREW_ENABLED=true`.
4. Publish a stable release containing the Homebrew-aware launcher. Older
   releases (including v0.1.1) cannot be used: formula generation rejects
   launchers without the install-method marker.
5. After the Homebrew job succeeds, remove the pending-publication notice
   from README and make Homebrew the primary macOS install instructions.

The release workflow calls `.github/workflows/homebrew.yml` directly after
publication (not via a `release` event, which `GITHUB_TOKEN` would not
trigger). It downloads the exact stable release's `cube` asset, generates
the versioned URL and SHA-256 using `scripts/homebrew-formula.ts`, runs
`brew install`, `brew audit --strict`, and `brew test` on macOS, then commits
the formula to the tap. Prereleases and dry runs do not update the tap.
The job is opt-in; without the variable, existing releases are unaffected.

To retry a failed tap update or publish a promoted stable release, run
the `homebrew` workflow manually with its `version` input. Choose the
latest supported stable release; an older input would downgrade the tap.
The formula tests do not boot a VM. Before announcing support, verify
`cube up`, `cube upgrade`, and `cube down` on real Apple Silicon and Intel
Macs, including a Homebrew upgrade with existing VM data.
