# Cube — history

Dated context that shaped [ARCHITECTURE.md](../ARCHITECTURE.md): the
alternatives rejected, the phase plan as it was executed, and the decision
log. Nothing here is a current checklist; phase statuses are historical.

## Rejected alternatives

- **Sysbox** (rev 2 choice, reversed): technology works, project doesn't —
  bus factor ≈1, 13-month release gap, 2026 issues 40 opened/10 closed,
  Sysbox-EE folded into Docker Desktop's *closed* ECI fork (Docker invests in
  the fork, not the OSS repo), open host-wedging FUSE bug, Ubuntu 24.04/
  containerd-2.x support still shaking out.
- **Kata Containers**: Docker CLI networking broken on Docker 26–29
  (moby#52017 open), needs KVM, ~2 GB floor/guest, virtiofs-overlay
  workarounds for inner dockerd.
- **Rootless podman-in-podman**: works unprivileged but weaker isolation
  (custom seccomp + /dev/fuse), fuse-overlayfs cost, no untrusted-code
  production precedent.
- **Hosted/OSS sandbox platforms**: Modal/Morph/Blaxel/Vercel/Cloudflare/
  Docker Sandboxes closed or managed-only; E2B self-host needs a
  Nomad/Consul cluster and lacks inner docker; Daytona went closed-source
  2026-06; BoxLite/microsandbox (libkrun) can't run inner Docker yet and
  need KVM. Re-check BoxLite in 6–12 months.

Residual risk accepted: a container escape would reach host credentials
(`~/.pi/agent/auth.json`, git creds). Mitigated by userns isolation, a dedicated
single-purpose VM, Tailnet-only exposure, and `nosuid` workspace mounts
(CVE-2025-64507 class; run Incus ≥6.0.6). The `sandbox/` interface stays narrow
so a micro-VM backend (kata/gondolin/boxlite) remains a plan-B swap, not a rewrite.

Known footguns (validated in Spike 1): Ubuntu 24.04 AppArmor userns
restrictions may need host config for inner runc (`pivot_root` denials,
incus#791); inner Docker 29.x has a nesting regression (incus#2757) → **pin
inner Docker to 28.x** until cleared; kernel modules the inner docker needs
(`br_netfilter`, nft/iptables) must be loaded on the host.

## Phase plan

### Phase 0 — Spikes (3–5 days). Do these first.

1. **Incus end-to-end** (`spikes/01-incus-e2e/`) — DONE, PASS (see NOTES.md
   there for the Docker-coexistence and static-IP findings). Install Incus (Zabbly
   6.0 LTS repo, ≥6.0.6) + a loop-backed ZFS pool — note: *no dockerd restart
   needed*, unlike the sysbox install. Build a base cube image (provision +
   publish: Ubuntu 24.04, systemd, inner docker 28.x, node 24, dev uid 1000).
   Launch it unprivileged with nesting + a shifted workspace + a 5 GB capped
   `/var/lib/docker` volume, `docker compose up` a two-service stack inside,
   reach the inner-published port from the host at `cubeIP:port`. Verify
   stop/start persistence, quota behavior when the volume fills (inner pull
   fails, cube survives), concurrent exec while compose runs, and that inner
   docker reports `overlay2` (not vfs). Watch for AppArmor `pivot_root`
   denials on Ubuntu 24.04 (incus#791) and document any host sysctl needed.
2. **pi SDK headless** (`spikes/02-pi-headless/`) — DONE, PASS. Ran
   `createAgentSession` outside the TUI with incus-routed bash + host-FS file
   tools; event stream confirmed rich enough for the UI (tool argument
   deltas, live bash output, edit diffs with unified patch). RPC fallback not
   needed. See NOTES.md there.
3. **Egress allowlist.** FOLDED INTO PHASE 2 (decided 2026-08-26): the
   per-cube bridge is built during the cube-creation slice anyway — validate
   NAT-less bridge + allowlist proxy there (npm install works via proxy,
   git push to GitHub blocked).
4. ~~**Auth in a daemon.**~~ DROPPED 2026-08-26 — answered by reading pi's
   source (0.84.3): auth is resolved per request (never cached per session),
   tokens are proactively refreshed at <5 min validity under a cross-process
   file lock on `auth.json` with the rotated credential persisted, and a
   failed refresh throws an explicit `ModelsError("oauth", …)` — no silent
   env fallback. Caveat: the error code is flattened to a message string in
   session events, so cubed classifies re-auth state via the exported
   `readStoredCredential` (presence/expiry), never by string-matching. The
   interactive-login setup is settled: run `pi` once over ssh; cubed reads
   `auth.json`.

### Phase 1 — Walking skeleton (1–2 weeks)
One cube, one thread, prompt in the browser → answer out, bash runs in the cube.
No sleep, no portals, no git. Prove the boundary holds.
Includes the two items folded in from the dropped auth spike: surface
per-message `errorMessage` in the UI (provider errors don't reject
`prompt()`), and a typed re-auth check via `readStoredCredential`.

### Phase 2 — Lifecycle + UI (2–3 weeks)
Multiple cubes, stop/start with wake hooks (idle default 1h), diff view,
one image profile (`cube-node`), egress allowlist (folded in from Phase 0),
disk monitoring UI, mobile layout. Replay-without-waking is already free:
sessions are host-side; only bash needs the container running.

### Phase 3a — Portals (DONE 2026-08-27, pending sign-off)
Declared services (`[services.*]` in cube.toml) + `services_ensure` tool,
Host-routed proxy + `PORTAL_BASE`, stable per-thread hostnames,
wake-on-request with ensure-on-demand, `.cube/setup`/`.cube/resume`
lifecycle scripts, in-cube hairpin verification.

### Phase 3b — VM image, minimal (DONE 2026-08-27)
Built and accepted: `scripts/vm/` bakes the qcow2 in one ~4.5 min
cloud-init boot, and the full portfolio (9 suites, incl. services-smoke's
in-cube hairpin) runs green INSIDE the VM with the baked nftables rules —
no host sudo anywhere. See HANDOFF for the bake traps found.
Original scope, for the record — validate the deploy model BEFORE
building more on top: the riskiest open
assumption is "the whole stack runs unchanged inside a small VM" (Incus in
VM, file-backed ZFS, inner docker overlay2 in container-in-VM, baked
nftables, hairpin). Scope: qcow2 from Ubuntu cloud-image via cloud-init —
Incus (Zabbly) + ZFS pool on a separate data disk + Node/pnpm + cubed
under systemd + baked nftables (default-deny from cubes; DNS/3128/7777
only) + cube-node image built inside; boot under qemu/KVM on the current
box with one 7777 forward; run the full test portfolio INSIDE the VM,
including services-smoke's hairpin leg (no host sudo involved). Deferred
to Phase 4: macOS launcher, Tailscale, backup, upgrade flow, CLI polish.

### Phase 3c — Git/PR (DONE 2026-08-27, pending sign-off)
`@cube/git` (`GitService`), host-side per ARCHITECTURE §11. A thread can attach a
repo at creation (`POST /api/threads {repo, base}` — `owner/name`, https,
ssh, or a local path): a bare mirror under `~/cube/repos/<name>-<hash>.git`
seeds the workspace as a local clone on branch `cube/<name>` with `origin`
rewritten to the real upstream. The agent commits over bash; its own
`git push` dies on the egress boundary. Host actions: `GET
/api/threads/:id/repo` (branch/dirty/ahead, works while asleep), `GET
/diff` (committed + uncommitted + untracked), `POST /push`, `POST /pr`
(gh, host auth). Registry gained nullable `repo_url/base/branch` columns
(ALTER-in-place migration). HOSTILE-WORKSPACE hardening (the workspace
`.git` is agent-writable): every host-side git forces
`core.hooksPath=/dev/null` + `core.fsmonitor=`; diff runs
`--no-ext-diff --no-textconv`; push relays the branch to the host-owned
mirror as a static bundle and pushes FROM the mirror (no workspace config
loaded → no `credential.helper`/`insteadOf` theft, no origin repoint); gh
is pinned to `owner/repo` from the recorded upstream in a neutral cwd.
Tests: `packages/git` offline suite (incl. a hostile credential-helper +
pre-push-hook case), registry migration case, `git-smoke` (real Incus,
in the VM portfolio). Not yet built: the git/PR SURFACE in the web UI
(diff viewer, Push/PR buttons), and repo-attach entry in the new-thread
UI — queued with the portals UI as the next design thread.

### Phase 3d — Dogfood surface (decided 2026-08-27; step 1 built 2026-08-27)
The locked product surface (see Decided), in build order:
1. **Cube pi-extension** — DONE (accepted 2026-08-28): `@cube/pi-extension`,
   pi on the VM host with read/write/edit/bash/grep/find/ls + `code` + `!`.
   Direct workspace tools route into a thread's cube; `code` runs
   model-authored JavaScript in a fresh, memory/CPU/time-bounded QuickJS
   WASM runtime and exposes only a closed `cube` capability SDK. Git/PR,
   service ensure, and archive operations stay on cubed's thread-scoped,
   credentialed paths; QuickJS receives results, never credentials, Node
   globals, host objects, filesystem, or network. This keeps future
   authenticated APIs behind one composable model-facing tool instead of
   adding a top-level tool per operation. bash/`!` go through IncusSandbox
   exec (`su - dev`, no env passthrough); file content over the Incus files
   API with symlinks re-resolved IN the guest (the API never follows them — a
   hostile workspace link cannot dereference on the host);
   stat/readdir/glob/grep via a helper script pushed into the cube (node
   is in the image), self-healing on loss. Wake-on-first-tool-use prefers
   cubed's wake route (`.cube/resume` + hooks), falls back to direct Incus
   start. Fail-closed guard: unconfigured → shutdown; any active tool not
   registered by this extension (checked via ToolInfo.sourceInfo) →
   notify + shutdown, plus a tool_call blocker. Tests: offline suite
   (pi's real tools against a scripted local guest) + ext-smoke (real
   Incus, in the VM portfolio); guard verified against real pi 0.84.3.
   REQUIRES the `--no-extensions` launch flag (step 2): it keeps a hostile
   workspace `.pi/extensions` and any earlier-loading extension's
   `user_bash` handler from running on the host — the in-process guard
   covers the tool surface but not those two vectors. sol-reviewed;
   findings fixed (output/read/spool caps, symlink-safe walk, mode
   preservation, per-call source re-audit). Code mode's follow-up Oracle
   review is also closed: teardown aborts and drains host calls before
   disposing QuickJS, HTTP disconnects reach filesystem/git/service work
   (coalesced ensures cancel only after their last waiter), and the raw
   bridge rejects bounded non-identifier operation names before tracing.
2. **pty bridge + web shell** — DONE (accepted 2026-08-28): `PiTerminals`
   (packages/server/src/pty.ts) spawns one real `pi` per attached thread
   on a pty (`@lydell/node-pty`, N-API prebuilds — the VM image has no
   compiler) and streams it over WS to an xterm.js pane; pi supplies the
   whole conversation surface, cubed renders no chat. Spawn is
   `pi --no-extensions --no-approve --no-context-files -e <cube
   extension> --session <thread's JSONL>` in the workspace cwd: the
   first two flags keep workspace `.pi/extensions` and a foreign
   `user_bash` off the host, the third keeps pi's context loader from
   reading a workspace `AGENTS.md -> ~/.pi/agent/auth.json` on the
   credentialed host. Spawn-on-first-attach waits out provisioning
   (status frames), clients share one process with a scrollback replay,
   a linger window survives page reloads, and delete/exit reap it.
   Threads no longer build a host-side pi session at creation (no model
   creds needed); titles are read back from pi's session JSONL. Shell:
   thread list + statuses, create with repo attach, delete, rename, the
   per-thread strip (repo/branch/ahead/dirty, diff shelf, Push/PR,
   portal links, files shelf). Code mode can ensure declared services;
   portal links also bootstrap their own portal row on first hit.
   sol-reviewed; findings fixed (context-file leak, second session
   writer on the same JSONL, WS same-origin gate, WS backpressure +
   ping/pong, session-file follow of pi's own `/new`, auto-title caps).
3. **Mock Incus backend** (`CUBED_BACKEND=mock`) — DONE (accepted
   2026-08-28): the sandbox layer is now a swappable `CubeBackend` interface
   (`packages/sandbox/src/cube-backend.ts`) covering exactly what the
   supervisor uses — provision/destroy, get/set run state, wait-for-network,
   egress proxy, and exec. `IncusBackend` is a verbatim pass-through to the
   existing client + provision functions; `MockBackend` keeps instances in
   memory (provision creates the host workspace and marks it Running;
   network is instant; the egress proxy is a no-op stub) and runs
   exec/execSimple LOCALLY with the guest `/workspace` path rebased onto the
   real host workspace, so `.cube/setup`, wake hooks, and service control
   touch real files. `CUBED_BACKEND=mock` selects it (default `incus`); no
   Incus daemon in reach. The tier-1 loop for developing cube inside a
   cube. Verified: offline suite `mock-backend-test.ts` (lifecycle, proxy
   stub, exec rebasing, exit codes, timeout, destroy) + a live host run
   with no VM — thread create→ready, rename, files/diff shelves, delete,
   and a repo-attached thread whose `.cube/setup` ran against the seeded
   workspace. Known limits: the pty/pi terminal still spawns pi with the
   cube extension, which routes into real Incus — the terminal pane is
   inert under the mock (fine: the loop is for server/registry/portals/UI);
   systemd-based service starts fail if the dev cube has no systemd (portal
   REGISTRY logic still exercises).

### Phase 4 — DevEx: installation + minimal image (CURRENT FOCUS, 2026-08-28)
Division of labor (user, 2026-08-28): GUI/product-surface work happens in
a separate line (amp); THIS line owns everything VM/devex. Goal: install
is `brew install … && cube up` on a laptop (brew is the minimum bar),
backed by a minimized, distributable VM image. Slices, in order:

1. **4a — distributable + minimal image** (ACCEPTED 2026-08-28 — see
   HANDOFF; boots run on an overlay so the base artifact stays pristine
   forever).** Kill the baked-trust trap: the
   shipped artifact carries NO authorized key and cloud-init stays enabled
   for first boot — the launcher injects a per-deploy key via its own
   NoCloud seed (the bake's key/seed remain bake-time-only artifacts).
   Minimize + MEASURE each cut (baseline 2.6G actual OS disk):
   fstrim before poweroff so freed blocks stay out of the artifact;
   `qemu-img convert -c` (zstd) for the distributed file; drop devDeps
   after the web build (prod node_modules only); audit apt for
   recommends/docs/locales. Node + Incus + the cube-node image STAY baked
   — first-boot downloads would trade ~300M for a broken offline story.
   ALSO in this slice, the cube-node image sheds its non-runtime weight
   (NodeSource apt source → official node tarball, arch-aware; spike-era
   socat/dnsutils/gnupg dropped). Inner Docker STAYS in the image by user
   decision (2026-08-28): running e.g. postgres via compose is a core
   dev-environment capability.
2. **4b — release pipeline.** Versioned image artifacts (build-id →
   version), checksums, published where the launcher can fetch them
   (GitHub Releases); a bake is reproducible from a tag.
3. **4c — `cube` launcher CLI** (BUILT 2026-08-29, pending sign-off —
   see HANDOFF). Thin client per §1: `cube
   up/down/ssh/status/upgrade` — fetches the versioned image (per-arch
   asset by `uname -m`, verified against `SHA256SUMS.<arch>`, from day
   one — see 4e's multi-machine release layout), creates the
   data disk, generates the per-deploy key + seed, boots qemu (KVM on
   Linux, HVF on macOS), forwards 7777 on loopback (+ optional private
   bind, same rules as CUBE_VM_BIND); upgrade = swap OS disk, keep data
   disk. In the cloud the image still boots as the machine itself.
   Lives at `launcher/cube`, standalone bash (brew packages this one
   file in 4d). The 4c-prerequisite blank-data-disk gap is closed IN
   THE IMAGE: a baked `cube-data-init` oneshot (Before=incus)
   recreates the zpool + dataset skeleton on a blank /dev/vdb, so a
   launcher-created disk initializes itself on first boot — and a
   blank data disk works identically for cloud deploys attaching an
   empty volume.
4. **4d — brew install.** Homebrew tap + formula for the launcher
   (depends on qemu); works on macOS and Linuxbrew. A no-brew Linux path
   (curl|sh or git+node) can trail.
5. **4e — arm64 image + multi-machine release (user, 2026-08-28: the
   release runs across MULTIPLE machines — no TCG cross-bake in the
   release path).** Each arch bakes NATIVELY on its own machine: amd64
   on the Linux box (KVM, as today), arm64 on the user's Apple Silicon
   Mac (HVF). The TAG is the coordination point: the first leg creates
   and pushes `vm-<version>`; every later leg REQUIRES the tag to exist
   and bakes from it, so all artifacts share one source. ONE GitHub
   Release per version holds per-arch assets:
   `cube-vm-<version>-<arch>.qcow2` (name carries arch since 4b) plus
   `SHA256SUMS.<arch>` and `manifest-<arch>.json` — per-arch names so
   the legs cannot overwrite each other. First leg `gh release create`,
   later legs `gh release upload`; the already-published guard becomes
   per-arch (release exists WITH my arch's assets → bump version;
   without → upload mine). The DEV-LOOP half landed 2026-08-28
   (`devex/4e-portable-dev`: scripts/vm portable across Linux/macOS
   with per-host shims, guest arch follows host, arm64
   bake+boot+portfolio green on an M-series mac) — that covered the
   qemu/accel selection, arch-parameterized base cache, node tarball,
   and host-arch artifact naming in `release.sh`. The multi-leg publish
   half landed 2026-08-29 with 4c: per-arch
   `SHA256SUMS.<arch>`/`manifest-<arch>.json` names, first-leg-creates
   / later-leg-uploads coordination pinned to the pushed tag (a later
   leg REQUIRES the tag; local/remote tag divergence refuses), per-arch
   publish guard; the launcher fetches per-arch. REMAINING for this
   slice: a release leg actually exercised on the mac, and the brew
   formula wiring (4d).

LANDED in phase (2026-09-03): 4b, 4c and 4e are DONE — releases are
built and published entirely by GitHub Actions — since 2026-09-04
every push to main that touches shipped files auto-tags and releases
the next patch; a hand-made tag `vX.Y.Z` bumps minor/major — the
launcher ships as a release asset and upgrades in place (app-only
releases apply as a ~31 MB tarball without a reboot; base and cube-node
only when their bytes change, cube-node inherited across releases when
`images/` is unchanged), arm64 is published and boots on the user's
Mac. The base is a NixOS config (systemd-repart, 610 MB compressed) with
a seed unit instead of cloud-init. Only 4d (brew) remains, waiting for
the repo to go public. Current state and next jobs: HANDOFF.md.

LANDED in phase (2026-08-30): the persistence slice — ALL mutable state
(threads/cubed.db, workspaces, /login `~/.pi`, github auth incl. gh's
token store, and incus's own registry `/var/lib/incus`) lives in
`cube/state/*` datasets on the DATA disk, mounted by `cube-data-init`
(early-boot unit, Before=incus.socket) with first-boot seeding from the
OS disk; `cube upgrade` (swap OS disk, keep data disk) is no longer
destructive and no longer asks. This also retires pi's "No models
available / use /login" greeting after upgrades — it still fires on a
true first install (the warning is pi's own, fires only while auth.json
is empty) and after a DEV rebake, which recreates both disks.

Still in phase, after the install story: Tailscale inside the VM (the VM
is the Tailnet node), backup of the data disk + `incus export` of
volumes, structured logging, prune schedules.

## Decided

- Phase 2 scoping (2026-08-26): egress-allowlist spike folded into the
  Phase 2 cube-creation slice; **one image profile** (`cube-node`) for now;
  idle-to-sleep default **1h**.
- Leverage pi maximally (2026-08-26): thread persistence = pi session files
  (`SessionManager.continueRecent`), no SQLite for conversations; SQLite is
  Phase 2, cubed-metadata only (cube registry, portals, volumes).
- The unit is called a **cube**, not an orb (2026-08-26). Code, UI, and docs
  say cube; spike artifacts keep their historical orb names.
- No auth in front of cubed/portals for now; Tailnet is the boundary (2026-08-26).
- Everything in English: code, commits, plans (2026-08-26).
- Gondolin parked (2026-08-26).
- **Rev 3: Incus sandbox backend; sysbox rejected** after research on project
  health/governance (2026-08-26). Socket-mount and privileged DinD remain
  rejected. Primary backend must not require KVM (GCP/AWS portability).
- Portals: no published ports, per-cube networks; Host-header routing with
  stable per-thread hostnames (`<name>--<thread>.{PORTAL_BASE}`) — the port
  allocator is removed entirely (2026-08-27).
- Services are DECLARED (Amp's services.yaml model) in `.cube/cube.toml`
  `[services.*]`, supervised as systemd units in the cube, with
  ensure-on-demand; plus `.cube/setup` / `.cube/resume` lifecycle scripts
  (2026-08-27). The imperative `portal_open` tool is dropped for
  `services_ensure`.
- Disk: ZFS pool with per-volume quotas replaces loopback-ext4 volumes (2026-08-26).
- Lean-ish sandbox image (2026-08-28, revised same day): the harness
  (pi + extension) runs in the VM, so the cube image needs little — but
  **inner Docker STAYS** (user: `docker compose up postgres` in a cube is
  a core dev-environment capability). Lean wins kept: node from the
  official tarball (no NodeSource apt source, arch-aware for arm64) and
  the spike-era debug tools (socat/dnsutils/gnupg) dropped.
- Guest fs-agent in Rust — the endgame (user, 2026-08-28): the node
  `fsops.mjs` helper is an interim. Long-term the cube runs a small
  static Rust agent (musl, per-arch) giving the extension a
  gondolin-style persistent fs-RPC channel (one long-lived Incus exec,
  JSON-RPC over stdio) instead of one exec round trip per op. That lifts
  the hidden node requirement from every future image profile and cuts
  the per-op ~100ms exec cost. Not scheduled; see Later.
- Dogfooding = developing cube WITH cube (2026-08-27). Bench/sacrificial
  second VM parked until needed; a mocked cube/Incus backend is expected
  to carry most in-cube development of cubed itself. Agent-authored code
  never executes on a credentialed host.
- Dev DX (2026-08-27): ONE command — `pnpm vm` — boots the baked VM
  (bakes if missing) and drops into a pi terminal on it; `/login` there
  IS credential provisioning (writes the auth.json cubed reads).
- **Product surface locked (2026-08-27): web shell + pi TUI chat pane in
  the browser.** The thread-first web shell is ours (DOM: thread list
  with product-state statuses, new-thread flow incl. repo attach, delete,
  portal links, diff/Push/PR, disk); the chat pane inside a thread is the
  REAL pi TUI over a pty — cubed spawns `pi` per attached thread with
  that thread's session file, workspace cwd, and the cube tool-routing
  extension (gondolin-shaped, incus-exec ops), bridged to xterm.js over
  WS. pi supplies the whole conversation surface (input, streaming, tool
  rendering, /login, compaction); we do NOT build a chat renderer. The
  extension must shadow ALL built-in tools and `!` commands and refuse to
  start if pi reports tools it does not know — unshadowed = host
  execution. A DOM chat stays possible later over the same session files.
  Bench VM parked until needed; mocked Incus backend carries most in-cube
  dev of cubed itself.
