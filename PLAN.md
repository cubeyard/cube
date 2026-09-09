# Cube — self-hosted cubes on your own VM

## 1. Goal and scope

Build a self-hosted equivalent of [Amp Orbs](https://ampcode.com/what-are-orbs) that
runs entirely on **one VM per user**. No clustering, no shared team platform, no
multi-tenancy. Provider login is handled by [pi](https://pi.dev). The architecture
is **harness outside sandbox**.

### Terminology

| Amp      | Cube    | Actually is                                          |
|----------|---------|------------------------------------------------------|
| thread   | thread  | one pi session (JSONL tree)                           |
| orb      | **cube**| Incus system container + host-persisted workspace     |
| portal   | portal  | service in the cube exposed via cubed's proxy         |

> Naming (2026-08-26): the sandboxed unit is called a **cube** — that is why
> the project is called cube. Code, UI, and these docs say cube throughout
> (rename pass done 2026-08-26). Spike artifacts and spike NOTES keep their
> historical names (`orb-spike01`, `~/cube/orbs/spike01/…`).

### Hard requirements

- Agent can expose a running service as a link the user just opens. No port
  collisions, ever.
- Agent can run a full stack inside the cube (`docker compose up`) and test
  against it. Inner-docker services must be portal-able with no extra steps.
- **Portability**: primary host is a dedicated Hetzner machine, but cube must
  install cleanly on ordinary cloud VMs (GCP, AWS, Azure). Since nested
  virtualization cannot be assumed there (AWS: `.metal` only; GCP: Intel-only,
  opt-in flag), **the primary sandbox backend must not require KVM**.
- **Deploy model: one VM image** (confirmed 2026-08-27 — this was the plan
  from the start). The whole trusted zone — Incus, ZFS pool (file-backed),
  cubed, nftables rules — ships as a small VM image, podman-machine style:
  a thin launcher boots it on a laptop (qemu/KVM on Linux, VZ/qemu on
  macOS), and in the cloud the image IS the machine (no nested virt needed
  — cubes are containers inside). Exactly one forwarded port (7777) covers
  UI + all portals, a consequence of Host-routed portals. OS disk is
  replaced on upgrade; a separate data disk (ZFS pool + ~/cube) survives.
  Host firewall rules become a deterministic artifact baked into the image
  — `scripts/host-firewall.sh` is dev-machine tooling until then and dies
  as a user-facing artifact with Phase 4.

### Out of scope (deliberately)

Multiplayer, Slack, team platform, clustering, per-minute billing, webhooks from
the internet, sub-cubes / agent-to-agent messaging, live terminal (phase 5+),
auth in front of cubed/portals (decided: none for now — Tailnet is the boundary).

## 2. Sandbox backend: Incus (decided, rev 3)

Cubes run as **unprivileged Incus system containers**
([linuxcontainers.org/incus](https://linuxcontainers.org/incus) — Apache-2.0,
community-governed under Linux Containers, led by Stéphane Graber, 200+
contributors, monthly releases, 6.0/7.0 LTS lines supported into the 2030s,
commercial backing via Zabbly). Configuration per cube: `security.nesting=true`,
`security.syscalls.intercept.mknod=true`, `security.syscalls.intercept.setxattr=true`,
`security.idmap.isolated=true`.

Why Incus:

- **Unprivileged docker-in-docker, first-class.** A real dockerd runs inside
  the unprivileged container with native overlay2 (kernel ≥5.11 `userxattr`
  overlayfs-in-userns; ZFS ≥2.2 supports overlayfs upperdirs). This is a
  documented, production-used pattern (Coder ships an Incus+inner-docker
  workspace template). Socket-mounting the host dockerd and privileged DinD
  remain rejected (trivial escape / root-equivalent).
- **Isolation ≥ sysbox.** Same trust model (kernel user namespaces; root in
  cube = unprivileged host uid) plus per-container AppArmor and seccomp, and
  `security.idmap.isolated` gives each cube a non-overlapping uid range.
  Strictly stronger than default runc/Docker.
- **Everything cubed needs is built in**: REST API on a unix socket with
  websocket-streaming exec; managed bridges with per-container static IPs
  (portal proxy hits `cubeIP:port` directly, including ports the *inner*
  dockerd publishes); `shift=true` idmapped host-dir mounts for the
  workspace; **real per-cube disk quotas** via ZFS storage pools.
- **No KVM dependency** → runs on any cloud VM (portability requirement).

### Rejected alternatives (2026-08-26 research pass; details in HANDOFF)

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

## 3. Building blocks we do not need to build

| Need | Solution | Status |
|---|---|---|
| Agent loop, context, compaction, sessions | the pi TUI itself, spawned per thread on a host pty | done |
| Provider auth (Claude Pro/Max, ChatGPT, Copilot, 30+ API providers) | pi `/login` → `~/.pi/agent/auth.json`, auto-refresh | done |
| Isolated exec environment | Incus system containers (unprivileged, userns) | done |
| Docker-in-docker for full-stack testing | `security.nesting` + syscall intercepts, overlay2 inner storage | done |
| Tool routing into sandbox | pi exports `createRead/Write/Edit/BashTool` with pluggable `*Operations` | done |
| Reference for tool override pattern | `gondolin/host/examples/pi-gondolin.ts` (pattern applies to any backend) | done |
| Resource limits (CPU, RAM, pids) | `limits.cpu`, `limits.memory`, `limits.processes` per cube | done |
| Disk caps | ZFS storage pool quotas (root `size=`, custom volume `size=`) | done |
| Streaming exec + lifecycle API | Incus REST over unix socket (exec = websocket) | done |

**Cube is the glue layer:** cube lifecycle, persistence, HTTP/WS API, web UI,
portal proxy, git flow, disk management. Not a new agent and not a new sandbox.

## 4. Architecture

```
┌─ VM (one per user — TRUSTED ZONE) ────────────────────────────────┐
│                                                                   │
│  systemd --user → cubed  (Node/Bun, one process)                  │
│   ├── HTTP/WS :7777 — REST + event stream + web UI                │
│   ├── Portal proxy — Host-routed on the main listener, no ports   │
│   ├── SQLite  ~/cube/cube.db — cubes, threads, events, portals    │
│   ├── GitService — host-side git, OWNS credentials                │
│   ├── DiskService — quotas, df monitoring, LRU pruning            │
│   └── CubeSupervisor                                              │
│        └── Cube (in-process actor, one per cube)                  │
│             ├── pi TUI (pty)           ← THE HARNESS, host-side   │
│             │    └── every tool → the cube (extension-routed)  ↓   │
│             └── cube handle (Incus REST over unix socket)         │
│                                                                   │
│  ~/.pi/agent/auth.json          ← provider creds, NEVER in sandbox│
│  ~/cube/cubes/<id>/workspace     ← host dir, shifted disk device  │
│  incus pool "cube" (ZFS)        ← cube rootfs + capped cache vols │
│  ~/cube/repos/<repo>.git        ← bare mirror                     │
│                                                                   │
│   ┌─ incus container "cube" (UNTRUSTED ZONE) ──────────────────┐  │
│   │  /workspace     ← disk device, shift=true, nosuid          │  │
│   │  /var/lib/docker← capped custom volume (inner images)      │  │
│   │  ~/.gradle etc. ← capped custom volumes (persistent)       │  │
│   │  inner dockerd  → agent runs `docker compose up` here      │  │
│   │  network: per-cube bridge, egress via allowlist proxy      │  │
│   │  no LLM tokens, no git tokens, no session history          │  │
│   └────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────┘
```

### Why harness outside

1. **Blast radius.** If the harness lives inside, the recovery mechanism dies
   with the thing it should recover. Here, thread history, event log, and cube
   state survive any container death — they live in SQLite on the host.
2. **Trust boundary.** Prompt injection is the realistic attack vector.
   Credentials, tool policy, and audit log live outside the agent's reach.
   Permissions enforced *inside* the sandbox are permissions the agent can
   work around.
3. **Lifecycle.** Sleep/wake, portal wake-on-request, and (later) scheduling
   require something that exists when the sandbox does not.

Note the isolation logic: harness-outside means the sandbox only ever contains
code and processes — never secrets. That is what makes container-grade (rather
than VM-grade) isolation an acceptable trade for the practical wins.

## 5. Cube lifecycle

```
creating → ready ⇄ running → idle → asleep → waking → ready
                                       ↓
                                   archived
```

- **The truth lives on the host.** Workspace is a plain host directory,
  attached as a shifted disk device. Caches are capped custom volumes. The
  container is cattle.
- **sleep** = `incus stop` after idle timeout (default **1h**, decided
  2026-08-26). Container rootfs survives (a mid-task `apt install` is not
  lost), costs nothing while stopped.
- **wake** = `incus start` (fast) + `.cube/resume` (if executable) + wake
  hooks from `.cube/cube.toml`. Declared services are NOT bulk-restarted on
  wake — each restarts on demand when its portal is hit or on
  `services_ensure` (processes die on stop; ensure is the self-healing).
- **Lifecycle scripts:** `.cube/setup` installs project tools, dependencies,
  and development fixtures noninteractively and idempotently (1200-second
  execution limit). `.cube/resume` runs after successful initial setup or
  snapshot restoration, and on every wake (10-second execution limit; no
  dependency installation). Timeout cancellation includes process cleanup,
  which can take several more seconds. Services remain in `.cube/cube.toml`.
  Failed setup is shown as a thread error without blocking its repair shell;
  wake does not erase that failure. Non-executable scripts fail explicitly.
- **Prepared environments:** a dedicated builder with no user thread runs
  setup, stops Docker/containerd, stages Docker data in rootfs, stops the
  instance and publishes an Incus image. The workspace is archived and
  restored inside the guest with GNU tar numeric owners, ACLs and xattrs, so
  metadata is never translated through a host-side workspace copy.
  Only successful builds publish. Working threads, including explicit setup
  retries, never populate this cache. Fresh thread Git metadata is retained;
  builder `.git` is excluded, symlinks are not dereferenced and writable
  hardlinks are not shared. Git/model credentials and arbitrary host
  environment variables never enter builders, threads or snapshots.
- **Reuse identity:** project, ordered repository URLs/bases/checkout names
  and exact OIDs, base image fingerprint, architecture, disk quotas, egress
  policy and portal base. Exact hits skip setup; changed revisions can reuse
  a compatible rootfs/Docker image with a fresh checkout and rerun setup.
  Dependencies stored in the old workspace are not carried across revisions.
  Concurrent requests for the same identity share one build. Cache failures
  fall back to normal fresh setup, so a failed setup build may run again in
  the repairable thread. No resume or user-session work runs in the builder.
- **Retention:** `CUBED_ENVIRONMENT_CACHE_BYTES` defaults to 0 (disabled) and
  is opt-in until the real-VM acceptance suite passes. A positive value enables
  reuse. LRU eviction counts two rootfs quotas (compressed + unpacked image)
  plus archived workspace bytes, and respects in-flight consumers. This is a
  retained cache budget, not a peak host-disk quota: active builds and copies require
  additional space. Docker staging must fit in the builder rootfs; failures
  do not publish partial images. Raw Docker snapshots require compatible
  Incus/overlay2 storage semantics; `environment-smoke.ts` tests whiteouts,
  opaque directories, capabilities/xattrs, numeric volume ownership, rootfs,
  workspace and fresh instance identity. Publication attempts are journaled
  durably before the Incus POST; startup reconciliation recovers uniquely
  tagged images after an uncertain response, while ambiguous or conflicting
  results remain quarantined for operator recovery rather than being reused.
- **Diagnostics and repair:** host-owned `.lifecycle/<cube>/` under the cubes
  root keeps status, timestamps and duration, up to 1 MiB of output per
  phase, and the previous attempt. GET `/api/threads/:id/environment` returns
  setup/resume evidence. POST returns 202 and reruns setup then resume in
  place; failures remain inspectable after client disconnects and restarts.
  Agents use `cube.environment.status()` (64 KiB log tails) and
  `cube.environment.retrySetup()`. The bundled `setting-up-cube` skill
  describes repository discovery, cold/warm validation, login-shell and
  supervised-service checks. It is packaged with the trusted extension, not
  dependent on repository-local skill files.
- **recreate** = delete + `incus init` from the cube image on image update or
  explicit `cube rebuild`. Workspace and cache volumes persist across
  recreates. This is the reproducibility boundary: anything not in the image,
  `.cube/cube.toml`, or a persistent volume is expected to vanish on rebuild.
- **Cube images** are Incus images per profile. **One profile for now:
  `cube-node` (decided 2026-08-26)**; more (e.g. `cube-jvm`) when needed.
  Provision: a base `ubuntu/24.04` container with a script
  (inner docker pinned 28.x, systemd-enabled dockerd, dev user uid 1000,
  toolchain), then `incus publish --alias`. Rebuildable from
  `images/<profile>/provision.sh` in this repo.

## 6. Disk management (first-class concern)

The known failure mode: caches (Gradle especially) grow until the disk is full.

- **One ZFS storage pool** (`incus storage create cube zfs`; loop-backed file
  pool on hosts without a spare block device — works on any cloud VM). ZFS
  gives real, filesystem-enforced quotas and overlayfs-compatible upperdirs
  for the inner dockerd (OpenZFS ≥2.2, in Ubuntu 24.04).
- **Capped volumes.** Cube rootfs: root disk device `size=` quota. Caches:
  per-cube custom volumes with `size=` (10–20 GB) attached at `~/.gradle`,
  `~/.m2`, pnpm store, and `/var/lib/docker` (inner images). A quota-full
  volume fails writes inside the cube; the cube itself survives. Caches persist
  across sleep/rebuild → no re-downloading.
- **Monitoring.** DiskService tracks pool + volume usage via the Incus API,
  surfaces it in the UI, warns before caps are hit.
- **Pruning.** LRU pruning inside cache volumes; scheduled
  `docker system prune` (inner); `cube gc` for manual cleanup.
- **Workspace** is a host dir: uncapped but monitored (it is the user's
  actual work).

## 7. Data model (SQLite)

```
cube    (id, name, status, repo, branch, workspace_path, image, size_tier,
         created_at, last_active_at, wake_hooks_json)
thread  (id, cube_id, pi_session_path, title, created_at)
event   (id, thread_id, seq, type, payload_json, ts)   -- append-only
portal  (id, cube_id, name, target_port, hostname, created_at)
volume  (id, cube_id, purpose, pool_volume, cap_bytes)
```

pi owns the conversation itself (JSONL session with tree/branch/fork). `event`
mirrors pi's event stream so the UI can replay a thread instantly **without
waking the cube**. Mirrored events: `agent_start/end`, `turn_start/end`,
`message_update`, `tool_execution_start/end`, `compaction_start/end`,
`auto_retry_*`.

## 8. Package structure (pnpm monorepo, TypeScript)

```
packages/
  sandbox/   Sandbox interface + IncusSandbox; micro-VM backend possible
             later behind the same interface
  server/    cubed: REST + WS + portal proxy + static files; also owns pi's
             binary (spawned per thread as the TUI) + the stored-credential
             check (src/auth.ts)
  web/       UI (Svelte 5 + Vite, plain SPA — no SvelteKit). Desktop + mobile.
             Decision 2026-08-26 after a research pass (React/Preact, Svelte/
             Solid, Elm): runes' fine-grained updates fit the token-append SSE
             workload without memoization ceremony; native streaming-markdown
             components exist (@humanspeak/svelte-markdown, svelte-streamdown);
             prior art at both scales (Open WebUI, Hollama, Sourcegraph's
             React→Svelte migration). Elm and Solid rejected; details in
             HANDOFF.md.
  git/       host-side git: mirror, worktree, diff, branch, PR via gh
  cli/       `cube` — thin client against the daemon
```

`Sandbox` interface stays narrow: `start`, `stop`, `exec` (streaming, pty-capable),
`resolvePortalTarget`, `close`. File I/O deliberately not part of it — see below.

**No official Incus TS client exists** → `IncusSandbox` speaks the REST API
directly over the unix socket (plain HTTP + one websocket lib for exec
streams); `incus` CLI shell-out only as a debugging aid. The API surface we
need is small: instance CRUD, state changes, exec, storage volumes, networks.

## 9. Tool routing (the core)

Pattern from `gondolin/host/examples/pi-gondolin.ts`, simplified by shared mounts:

- **`read`/`write`/`edit`** operate **directly on the host path** of the
  workspace. No exec roundtrip, native speed, and diffs/reads work even while
  the cube sleeps. The shifted (idmapped) mount maps the host uid to the cube's
  `dev` user, so ownership stays clean on both sides.
- **`bash`** routes through Incus exec into the cube (websocket streams,
  timeout, abort, pty when needed). The system prompt is patched so the model
  sees `/workspace`.
- **`services_ensure()`** — custom tool (the only portal-facing one,
  decided 2026-08-27): reads `[services.*]` from `.cube/cube.toml`, starts
  anything missing as a systemd unit inside the cube, waits for readiness,
  and returns each service's state + stable portal URL for the model to
  hand to the user. The agent edits the declaration with its normal file
  tools; logs come via plain bash (`journalctl -u cube-svc-<name>`).
- No git tools needed — `.git` is visible in the workspace; the agent uses
  plain `git` via bash.

## 10. Portals (host-routed, stable names — no port allocator)

- Cubes **never publish ports on the host** (no proxy devices, no `-p`
  anywhere); cubed's proxy is the only way in.
- Each cube gets its own Incus bridge network with a static `ipv4.address`.
  cubed proxies to `cubeIP:targetPort` directly — the bridge is a host
  interface, no NAT hop.
- **No port allocator** (removed 2026-08-27). The main cubed listener routes
  on the Host header: portal hostnames → the cube service, everything else →
  UI/API. Each portal gets a **stable, deterministic hostname** derived from
  (thread, portal name): `<name>--<thread>.{PORTAL_BASE}`. The name lives as
  long as the thread, so OAuth redirect URIs, issuer URLs, and other config
  committed in the repo stay valid across sleep/wake and daemon restarts.
  Distinct hostnames also separate cookie namespaces — mock OAuth + app in
  the same cube get clean, independent origins, with no path-prefix
  rewriting to break dev servers' absolute asset paths. On the real VM the
  proxy can additionally bind :80 for portless URLs.
- `PORTAL_BASE` is one config value, per environment (default
  `cube.internal`):
  - **never a `*.localhost` base**: resolvers special-case the localhost
    TLD to loopback (RFC 6761) even over /etc/hosts, which silently breaks
    the in-cube hairpin (found by services-smoke);
  - dev on the host machine itself: dnsmasq `address=/.cube.internal/<ip>`
    (macOS: pair with `/etc/resolver/internal`);
  - OrbStack: `<machine>.orb.local` (`.orb.local` names are wildcards);
  - other devices / Tailnet (phones): wildcard A record on an owned domain
    → VM IP, or sslip.io (`CUBED_PORTAL_BASE=<lan-ip-dashes>.sslip.io`,
    zero infra), or Tailscale split-DNS to a dnsmasq on the VM.
- Portals are **HTTP(S)/WebSocket only** — Host routing needs a Host header.
  Raw TCP would need a dedicated port again; out of scope until a real need
  appears.
- **Hairpin** (verified in services-smoke): OAuth-style flows need the
  portal origin reachable from *inside* the cube too (server-to-server
  token exchange against the issuer). Four pieces make it work:
  (1) ensure pins every portal hostname to the bridge gateway in the
  cube's /etc/hosts; (2) `NO_PROXY=.{PORTAL_BASE}` everywhere the egress
  proxy env is set (login-shell profile — which services inherit via
  `bash -l` — and the dockerd drop-in) so hairpin
  requests go direct instead of 403ing at the allowlist proxy;
  (3) the host firewall admits cubes to cubed's port (host-firewall.sh —
  cubes are otherwise DNS+proxy only); (4) cubed's cube-source guard keeps
  that admission portal-only: requests from a cube IP get 403 on anything
  but a portal hostname, and only the cube's OWN portals — portals must
  not become a cube-to-cube bridge or an unauthenticated path to the
  thread API. The services_ensure tool tells the agent to use
  PUBLIC_URL/CUBE_SERVICE_<NAME>_URL as issuers, never localhost.
- **Inner compose services**: ports published by the inner dockerd bind on the
  cube's eth0 → same proxy path, zero extra plumbing. Full stack up → link to
  the user.
- **Declared services** (Amp's services.yaml model, decided 2026-08-27,
  in `.cube/cube.toml` — same file, no new dep):

  ```toml
  [services.web]
  command = "pnpm dev --host 0.0.0.0 --port $PORT"  # must listen on $PORT
  cwd = "app"            # relative to /workspace (default: /workspace)
  port = 3000            # optional; omitted = cubed assigns one
  health = "/healthz"    # optional; GET 2xx/3xx = ready, else TCP accept
  [services.web.env]
  API_MODE = "development"
  ```

  cubed assigns/records the port, injects `PORT` and `PUBLIC_URL` (the
  service's own portal origin) plus `CUBE_SERVICE_<NAME>_URL` for every
  declared sibling (the app finds its mock-OAuth issuer this way) and
  `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS` (Vite refuses unknown Host
  headers, and a portal hostname is one), and runs each service as a
  transient systemd unit in the cube (`cube-svc-<name>`) —
  status/restart/logs come from systemd, not new plumbing. **Ensure**
  semantics: start whatever is missing, wait for readiness (a unit whose
  process exits fails fast), leave an active unit started from the SAME
  declaration alone however long it takes to come up, replace one started
  from an edited declaration (the declaration's fingerprint rides in the
  unit's description), and stop + forget services that are no longer
  declared (a renamed service must not inherit the old one's port and be
  "confirmed" by the old process). Runs from the `services_ensure` tool
  and automatically when a request hits a declared service's portal that
  is not up.
- **Bind-address gotcha**: commands must listen on `$PORT` on `0.0.0.0` —
  a `127.0.0.1` bind is unreachable from outside the netns. The health
  probe catches it; the error text tells the agent to rebind (socat
  forwarding stays a documented manual fallback, not automatic).
- **Wake-on-request**: a request hitting a sleeping cube's portal triggers
  the full wake (resume script + wake hooks) plus ensure of the target
  service; the proxy holds the request (self-refreshing 202 page if >2s).
  A service whose last start attempt failed gets a 502 page with the
  failure detail instead — never "starting…" forever — that still retries
  slowly, so a fixed declaration heals without a manual reload. Only a
  request that reaches the service counts as activity for the idle sweep.

## 11. Git and PR flow

Credentials never leave the host.

1. `~/cube/repos/<repo>.git` is a bare mirror. Cube creation does a local clone /
   `git worktree add` → workspace. Fast, no network needed in the cube.
2. `.git` is visible in the workspace — the agent commits locally.
3. `git push` fails inside the cube because egress to GitHub is blocked by
   network policy. That is the boundary, not a bug: push is an explicit host
   action via `GitService`.
4. UI: diff review (host-side `git diff` against base), "Push branch",
   "Create PR" (`gh pr create`, host-side).

**Hostile-workspace model (implemented 3c; sol review 2026-08-27).** The
workspace `.git` is agent- and (with repo-attach) upstream-controlled, so
host-side git there is a cube→host escalation surface. Rules `@cube/git`
enforces:
- Every git invocation runs with `core.hooksPath=/dev/null`,
  `core.fsmonitor=`, and `GIT_ATTR_SOURCE=<empty-tree>` — no hook,
  fsmonitor, or attribute-driven filter/diff/textconv driver from the
  worktree can execute host code (verified: a repo-local `filter.*.clean`
  otherwise runs on `git diff`).
- The review diff is the COMMITTED delta `baseOid..HEAD` — exactly what
  push publishes — against a base OID PINNED at seed time (registry), not
  the agent-writable `refs/remotes/origin/<base>`; a rooted cube cannot
  forge an empty review. Uncommitted/untracked work is flagged, never
  conflated with the pushed patch.
- Push never loads workspace config for the network step: the branch is
  carried to the host-owned mirror as a static bundle (no upload-pack, so
  no `uploadpack.packObjectsHook`) and pushed FROM the mirror — defeating
  repo-local `credential.helper` / `url.*.insteadOf` credential theft and
  origin repointing. `gh` is pinned to `owner/repo` parsed from the
  recorded upstream, in a neutral cwd.
- Seed clones with `--no-hardlinks` (no shared inodes with the mirror);
  inline-credential URLs are rejected; local-path upstreams are gated
  behind `CUBED_ALLOW_LOCAL_REPOS`.
- pi's own project trust is forced OFF for cube sessions (harness), so a
  seeded/agent-written `.pi/extensions` never executes in the cubed host
  process. This is the pi-integration boundary, tracked in risk register.

## 12. Network policy in the cube

- Per-cube bridge with NAT disabled (`ipv4.nat=false`, no default route out) →
  default deny holds even for proxy-ignorant traffic. Incus network ACLs are
  available as an extra layer (note CVE-2025-52890 — ACL/bridge-filtering
  bypass, fixed; keep Incus current).
- An egress proxy (allowlist by hostname) is attached to both the cube's
  bridge and the outside; `HTTP(S)_PROXY` set in the cube. Package managers
  honor it.
- Per-cube allowlist in `.cube/cube.toml`:

```toml
[network]
allow = ["registry.npmjs.org", "pypi.org", "crates.io"]
```

- Default: no secrets enter the cube. (Host-side secret *injection* à la
  gondolin is out of scope for now; revisit if the need appears.)

## 13. Phase plan

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
`@cube/git` (`GitService`), host-side per PLAN §11. A thread can attach a
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

### Later
Rust guest fs-agent in the cube: static musl binary (x86_64 + arm64),
pushed/self-healed like fsops today, held open over one long-lived exec
websocket speaking JSON-RPC — replaces `fsops.mjs`, drops node from the
image floor, and gives file tools gondolin-class latency. The fsops op
set (stat/readdir/glob/grep/resolve) is the v1 protocol.
Raw live terminal into the cube (subsumes into the 3d pty bridge).
Scheduling/cron wake. DOM chat renderer over pi session files, if
dogfooding ever demands richer-than-terminal conversation UI.
Sub-cubes. Auth if the Tailnet stops being a sufficient boundary. Micro-VM
backend (kata/gondolin/boxlite) if container isolation proves insufficient.

## 14. Risk register

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | Container escape reaches host creds (auth.json, git) | Medium | userns + isolated idmap, nosuid workspace, dedicated VM, Tailnet-only; micro-VM backend as plan B |
| 2 | Incus nesting quirks (AppArmor on 24.04, inner-docker version regressions) | Medium | Spike 1 validates E2E; pin inner Docker 28.x; document host sysctls |
| 3 | pi is v0.x — breaking changes | Medium | Pin exact version; the daemon touches pi only in `server/src/auth.ts` and the pty spawn |
| 4 | OAuth refresh fails in long-lived daemon | Medium | Spike 4, explicit re-auth state in UI |
| 5 | Disk fill from inner images / caches | Medium | ZFS quotas per volume, DiskService monitoring, prune schedules (§6) |
| 6 | Egress proxy too coarse (non-HTTP protocols blocked) | Low | Acceptable: default deny is the point; add mapped exceptions per cube |
| 7 | Dev servers bind 127.0.0.1 → portal unreachable | Low | health probe fails fast; error text tells the agent to rebind on $PORT/0.0.0.0 |
| 8 | Resource saturation (N cubes × inner dockerd) | Low | `limits.*` per cube, aggressive sleep timer, cap on awake cubes |
| 9 | No official Incus TS client | Low | REST surface we need is small; own thin client over unix socket |

## 15. Open questions

- Repo source: always via host mirror, or direct clone from GitHub inside the
  cube (requires egress + read token)? Recommendation: always mirror.

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
