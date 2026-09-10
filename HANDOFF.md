# Handoff

Short operational context for the next session, not a release log. Updated
2026-09-10; live verification below is the last recorded evidence, not a fresh
launch sign-off. Completed phase reports and review histories remain in Git.

## Start here

- [AGENTS.md](AGENTS.md): how an agent builds, deploys a working tree into
  the VM, drives the browser, reads state and events, and what not to cross.
- [README.md](README.md): product, installation and everyday commands.
- [DEVELOPING.md](DEVELOPING.md): mock/VM loops, releases, launcher and env vars.
- [PRODUCT.md](PRODUCT.md), [DESIGN.md](DESIGN.md), [.impeccable/](.impeccable/):
  product and design contracts. The quieter, more machined rendition wins.
- [SECURITY.md](SECURITY.md): deployment boundary and vulnerability reporting.
- [ARCHITECTURE.md](ARCHITECTURE.md): the evergreen decisions (cited as
  `ARCHITECTURE §N`); [docs/history.md](docs/history.md): rejected
  alternatives, the phase plan and the decision log — historical, not a
  checklist.

Leverage pi rather than rebuilding it: pi owns the agent loop, JSONL session
history, compaction, provider auth/refresh, model catalog and tool definitions.
Development credentials and account status are machine-local; never record
them here.

## Before launch: unresolved verification

These were still open in the last handoff. Confirm or close them with explicit
evidence; do not infer acceptance from a successful build.

1. **Real thread on arm64:** on the Mac, connect GitHub, create/check a project
   and start a thread, proving cube-node import and nested container execution.
   Install and app-only upgrade were user-tested; this path was not recorded.
2. **Real-Incus UI acceptance:** use a fresh disposable registry to create a
   two-repository project, start a thread, prove both guest mounts, the additional
   repository's read-only access and the primary repository diff. Automated
   multi-repo smokes passed; the complete UI path remained a follow-up.
3. **macOS launcher edge paths:** destroy, base-changing reboot upgrade and a
   collision on SSH port 2222 were not recorded as verified.
4. **Automatic-release failure cleanup:** draft/tag removal was reviewed and
   lint-checked, but not exercised. Cancellation cleanup cannot make GitHub's
   unconditional DELETE atomic against a concurrent human undraft.
5. **First-run onboarding:** the earlier handoff queued an empty-state setup
   checklist (connect GitHub → create project → open thread and `/login`), an
   actionable GitHub badge and a repository picker. Confirm current completion;
   GitHub is needed for push/PR even when anonymous public-repo reads work.
   The repository picker exists on the `feat/repo-autocomplete` branch (#20);
   its cold path is slow and its failure states conflate "signed out" with
   "GitHub unreachable" — see the review on the PR and the fix branch.
6. **The 2026-09-10 release (#27)**: the overnight stack plus #20, #21 and
   the fixes to every review finding, assembled on one branch. The
   assembled tree was deployed to the amd64 launcher VM and passed
   `scripts/smoke-live.ts`, a delete during setup (cancel in 130 ms, nothing
   left behind), an idempotent replay, and the browser checks; the launcher
   rollback was exercised in an isolated `CUBE_HOME`; the bounded Incus
   waits are proven against a fake daemon only. Not verified: arm64, the
   release build after the package fold (`build-app.sh` stages the whole
   tree; unchanged by inspection), the macOS HVF preflight, and the
   `?timeout=` wait slices against a live Incus (needs the VM portfolio).

Pushes, PRs, releases and destructive acceptance steps require explicit
authorization. A shipped-file push to main triggers a release only when the
repository Actions variable `CUBE_RELEASES_ENABLED` is `true`; leave it unset
through the public repository import and source-only launch.
Do not expose cubed publicly: it has no application-level authentication.

## Last recorded live evidence

- **2026-09-10:** the overnight stack on the v0.1.11 launcher VM (amd64):
  `deploy-tree.sh` + `smoke-live` passed five times across the branches
  (provision ≈ 3–4 s with a cached image, wake ≈ 1 s, terminal first byte
  ≈ 0.6–0.9 s); `/api/events` recorded every phase; a thread driven through
  provision → sleep → wake showed `setting-up` with staged status lines and
  `sleeping → waking → ready`; the deleted thread's host tree was gone.
  #21 merged with the events work resolved eight `supervisor.ts` hunks; the
  combined tree passed the same smoke. Eight orphaned host trees from earlier
  test threads were found under `~/cube/cubes` and removed by hand; boot now
  names such trees in an event. PR #20 (repository autocomplete) tested in
  the browser: list, filter, keyboard select and name autofill work; cold
  load 6 s, warm 0.8 s.
- **2026-09-09:** bug-hunt branch verified against the public v0.1.3 VM on
  Linux/KVM, driven from a headless browser: thread creation, the pi TUI,
  declared services with portals (bootstrap, wake-on-request, heal after a
  service crash, rename retiring the old unit, a failing service's 502 page,
  in-cube hairpin), thread deletion. Offline suites: 17/17. Traps found:
  cubed served `index.html` without cache headers, so an in-place app update
  left tabs on assets that no longer existed (now `no-cache` + immutable
  assets); a renamed service inherited the old unit's port and was
  "confirmed" by the old process (ensure now retires undeclared units and
  fingerprints declarations in the unit description).
- **2026-09-04:** private pre-public release v0.6.2 completed the automatic
  main-push release path on both architectures, with amd64 boot verification.
  This is a historical checkpoint, not a claim about today's latest release;
  public releases in this repository start at `v0.1.0`.
- The user installed v0.6.0 on Apple Silicon and upgraded to v0.6.1 in place
  (`changed: app`, ~32 MB, no reboot). Linux launcher install, app-only/reboot
  upgrades, down/up and destroy passed; the dev VM portfolio passed 19 suites.
- Projects and GitHub device auth were live-tested on the tailnet build on
  2026-08-28. Automated real-Incus multi-repository coverage passed.
- Persistence acceptance (2026-08-30) preserved projects, threads, credentials
  and Incus instances through an upgrade simulation; foreign ext4 data disks
  were refused. A live model-driven hostile-symlink read resolved in the cube's
  namespace, not the host's. When repeating this check, require actual tool calls
  in the transcript, not an answer from conversation memory.

## Current architecture and contracts

### Projects and threads

Projects prepare access, branch and exact base OIDs before work starts. New
threads require `ready` and seed only those OIDs: no provisioning-time
network/auth lookup. The primary checkout is `/workspace`; optional reference
repositories mount at `/repos/<checkout-name>` and are read-only. Review and
ship operate on the immutable primary repository snapshot.

A project may declare `environment = "<checkout>/<folder>"`: its `.cube`
(setup, resume, cube.toml) then comes from that folder of a reference
repository instead of the primary checkout — read-only in the thread, verified
and parsed at the pinned commit by the project check, snapshotted per cube
(`cube.environment`). `supervisor.ts` `environmentDirs` is the one place that
maps it to host and guest paths. `[network] allow` in `cube.toml` extends the
egress allowlist and is re-read at every proxy start (`startProxy`).

Threads are the home, newest-first across projects, with a URL-backed project
filter and explicit project/name attribution. Do not use a pre-project populated
database: startup refuses to invent project ownership.

GitHub device auth is owned by cubed (`/api/github/auth`); tokens stay on the VM
host and are installed into `gh`. The UI receives only public flow state.
Project checks refresh auth, not thread provisioning.

### VM, persistence and upgrades

The VM is NixOS, boots UEFI on both architectures and uses these artifact roles:

| Role | Source / purpose |
|---|---|
| base | `scripts/vm/base/`; built with Nix + systemd-repart, no build VM required |
| app disk | `/opt/cube/{bin/cubed,node/,runtime-id,app/}`; built by `build-app.sh` |
| app tarball | Same staged `app/`; applied in place by `cube-app-apply` |
| cube-node | Read-only inner image; inherited when the `images/` tree is unchanged |
| data | Persistent ZFS pool `cube`, with `cube/incus` and `cube/state/*` |

OS is vda, data is vdb; other disks mount by label. The `CUBESEED` seed injects
per-deploy SSH trust. Mutable registry, Incus, pi and gh state lives on the data
disk. Launcher upgrades preserve it; a dev rebake recreates both disks.

Manifest schema 2 binds per-arch artifacts, hashes and sizes plus `runtime_id`
and `images_tree`. Adding an artifact role requires a schema bump. The app disk
and tarball runtime IDs must match. Base/node/runtime changes take the reboot
path; compatible app-only upgrades swap the tarball around a cubed restart.
Overlay `.runtime`/`.build` sidecars support recovery; pruning must retain each
overlay's backing file, even after tarball updates.

`launcher/cube` owns install, upgrade and host preflight. State is in `~/.cube`;
downloads are content-addressed and verified. Preflight (tools, accelerator,
firmware, ports) runs before the first download; boot prerequisites apply to
`upgrade` only when it will boot. An app-only upgrade fetches the previous
release's tarball first and rolls back when cubed never answers; the version
file is written only after the new release proved itself. Unclaimed busy
ports move to the next free port and are remembered. `scripts/vm/sync.sh`
deploys `origin/main`; `scripts/vm/deploy-tree.sh` deploys the working tree
into the launcher VM (or `--dev`) without touching `build-id`; image-level
changes need a rebuild.

### Observability

cubed records every lifecycle transition as an event in the registry
(`packages/server/src/events.ts`): provision/wake/sleep/destroy spans with
phases, boot reconciliation, project checks, service ensures, git ops,
terminal spawn/exit/reap, setup retries, environment maintenance (builder
cleanups, quarantined cache entries, a suspended cache), portal failures and
WebSocket wakes, API 500s, and egress allow/deny per host aggregated per
minute (bounded per cube). Events are raw and stamped
with the running version; `GET /api/events`, `cube events` and
`scripts/events-report.ts` read them; retention 30 days / 200k rows. The
journal (`packages/server/src/log.ts`, `CUBED_LOG_LEVEL`) carries every error
column write with the thread/cube id; `cube diagnose` bundles 24 h of it.
Firewall-level (nftables) drops are not recorded yet.

### Release and validation

`.github/workflows/release.yml` pins one commit for both native-architecture
builds. Shipped-file pushes to main mint patch tags; push a manual version tag
before main for a minor/major bump. Publishing waits for both architecture legs
and the launcher asset. The amd64 gate boots a blank-data-disk install, runs a
nested container and applies the app tarball; arm64 remains build-verified in CI.
Runs are serialized with `queue: max` to avoid dropping pending releases.

Use `pnpm typecheck` and `pnpm test` for offline checks; the suite list lives in
`scripts/test-offline.sh`. Use the real VM portfolio for Incus/network/storage
changes; mock success is not sandbox acceptance. See DEVELOPING.md for commands.

## Load-bearing invariants

- Credentials stay on the host. Agent push cannot reach the network; push/PR
  are explicit host actions. No host environment passthrough into cubes.
- Keep pi's isolation flags and the extension's fail-closed tool audit. Host-side
  context/extension loading through workspace symlinks can expose credentials.
  File-tool symlinks must resolve inside the guest namespace.
- Cubes have no default route/NAT; egress goes through a source-pinned allowlist
  proxy that resolves and vets public IPs. NIC IP/MAC filtering and bridge-forward
  drops are essential. Upstream DNS forwarding remains an accepted exfil channel.
- Loopback or a trusted Tailnet is the access boundary; terminal WebSockets are
  same-origin and portals are cube-source-guarded. Never use a `*.localhost`
  portal base: it breaks in-cube hairpin access.
- Wake waits for network readiness, not merely Incus `Running`, and restarts
  the egress proxy. Reserve per-cube transitions synchronously; set busy before
  wake and guard deletion against in-flight transitions.
- Thread row IDs remain stable across session changes. Hook failures report an
  error without bricking the cube; hooks must tolerate re-runs.
- Internals speak in `String(error)`; the product surface never renders it.
  `packages/server/src/user-facing.ts` is the one translation point (thread
  vocabulary, one sentence, a next step); the raw text stays in the registry,
  journal and events for diagnosis. `waking` is a thread state of its own.
- Sleep and boot demotions keep the cube's error text. A wake request is
  activity (the extension asks before every tool call), so the idle sweep
  cannot sleep a long quiet tool. The pty linger waits for a full window of
  output silence, not merely of no clients.
- Deleting a thread removes its host tree (`removeStoppedTree` on the cube
  directory) after the instance is destroyed; boot only names orphan trees.
  A delete mid-setup cancels the provision (abort, await the transition,
  then tear down) — the removal is reserved before the abort, and a
  builder (`building-environment`) is never cancelled through a thread.
- `POST /api/threads` is idempotent per project and request key
  (`Idempotency-Key` / body `requestId`, ten minutes, in memory); the web
  client sends one key per user action.
- Plain HTTP over the Tailnet is an insecure browser context. Feature-detect
  clipboard/crypto APIs; use the existing UID fallback, not `crypto.randomUUID`
  unconditionally. UI is Svelte 5 + Vite, not SvelteKit; freeze completed
  transcript blocks and update only the live tail while streaming.

## VM traps worth retaining

- Keep `profiles/qemu-guest.nix`: it supplies the virtio initrd modules. Serial
  consoles are `ttyAMA0` on arm64 and `ttyS0` on amd64.
- Pair UEFI code/vars by arch; arm64 `virt` requires both at exactly 64 MiB.
  Pad private copies. Use the pflash pair, not `-bios`.
- Mount data before Incus sockets start; ordinary systemd dependencies can
  create a sockets/basic-target cycle. Refuse foreign data disks, never wipe.
- Hosted arm64 runners lack KVM: do not replace repart with nixos-generators'
  VM build. Ubuntu AppArmor can block repart's unprivileged user namespaces.
- GitHub runners' Docker firewall can block Incus bridges; use
  `scripts/host-firewall.sh`. Incus list output uses short fingerprints;
  `incus image info` supplies the full one.
- Build scripts need `CI=true` for pnpm's non-TTY dev/prod purge, a pnpm wrapper
  on PATH and Linux node-pty prebuilds even when staging on macOS.
- `incus-container-only.nix` forks nixpkgs' module with an upstream hash guard.
  A nixpkgs bump requires rebasing the fork and re-measuring the closure.

## Follow-ups, not recorded launch blockers

- The interrupted-provision instance that can never wake (missing static
  network config) must be re-audited on top of #21's recovery path.
- A thread deleted while waiting on a shared environment build leaves the
  build running for the next thread — by design, a builder has no thread.
  The environment cache's unresolved-entry limit (3) and the ten-minute
  maintenance cadence are constants, not configuration.
- Every Incus wait is bounded and cancellable (`IncusTimeoutError`), but a
  streaming exec without a caller timeout still has only the liveness bound;
  every current caller passes one.
- Launcher: reboot-path upgrades get recovery instructions, not a rollback;
  the macOS HVF preflight is by inspection.
- Add an arm64 boot gate; distribute UEFI firmware (requires manifest schema 3).
- Pin cube-node inputs (Ubuntu alias, Docker apt key, Node checksums).
- Further base-size reduction and a Homebrew formula.
- Mock service starts are best-effort and mock instances are process-lifetime.
- Guest find/grep ignore only `.git`/`node_modules`, not `.gitignore`.
- Previously recorded UI gaps: stop/cancel, larger-list search/sort and HEAD
  requests on file endpoints. Re-check current implementation before taking on
  one of these; SSE buffers remain process-local in the recorded design.

Keep this file focused on unresolved work and contracts that prevent mistakes.
Put command reference in DEVELOPING.md and completed narratives in Git history.
