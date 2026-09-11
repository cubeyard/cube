# Cube — architecture

The evergreen decisions behind cube. Section numbers are stable: code and
docs cite them as `ARCHITECTURE §N`. Dated history — rejected alternatives,
the phase plan, the decision log — is in [docs/history.md](docs/history.md).

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

The sandboxed unit is called a **cube** — that is why the project is called
cube. Code, UI and these docs say cube throughout; spike artifacts keep their
historical `orb` names.

### Hard requirements

- Agent can expose a running service as a link the user just opens. No port
  collisions, ever.
- Agent can run a full stack inside the cube (`docker compose up`) and test
  against it. Inner-docker services must be portal-able with no extra steps.
- **Portability**: primary host is a dedicated Hetzner machine, but cube must
  install cleanly on ordinary cloud VMs (GCP, AWS, Azure). Since nested
  virtualization cannot be assumed there (AWS: `.metal` only; GCP: Intel-only,
  opt-in flag), **the primary sandbox backend must not require KVM**.
- **Deploy model: one VM image.** The whole trusted zone — Incus, ZFS pool (file-backed),
  cubed, nftables rules — ships as a small VM image, podman-machine style:
  a thin launcher boots it on a laptop (qemu/KVM on Linux, VZ/qemu on
  macOS), and in the cloud the image IS the machine (no nested virt needed
  — cubes are containers inside). Exactly one forwarded port (7777) covers
  UI + all portals, a consequence of Host-routed portals. OS disk is
  replaced on upgrade; a separate data disk (ZFS pool + ~/cube) survives.
  Host firewall rules become a deterministic artifact baked into the image
  — `scripts/host-firewall.sh` remains dev-machine tooling only.

### Out of scope (deliberately)

Multiplayer, Slack, team platform, clustering, per-minute billing, webhooks from
the internet, sub-cubes / agent-to-agent messaging, live terminal (phase 5+),
auth in front of cubed/portals (decided: none for now — Tailnet is the boundary).

## 2. Sandbox backend: Incus

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

The alternatives weighed before this decision are recorded in
[docs/history.md](docs/history.md#rejected-alternatives).

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
- **Fresh thread snapshots:** project checks establish access/configuration;
  each new thread refreshes every repository’s default branch before allocation and
  pins the returned OIDs. Fetch failures stop creation rather than falling back
  to the last checked commits. Existing threads and idempotent replays retain
  their pins. Concurrent duplicate creates share their refresh and allocation;
  a project revision change during the await invalidates the attempt.
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
- **Prepared environments (templates):** a dedicated builder with no user
  thread runs setup once per *environment key*, is stopped, stripped of
  every device but root, and snapshotted together with its docker volume.
  It stays as a stopped instance — the project's template — and every
  thread is created as a copy of that snapshot with a copy of the volume
  snapshot: on ZFS both are clones, instant and block-sharing. No image is
  built or published. The workspace is never part of a template: each
  thread gets a fresh checkout and runs setup itself, warm (an idempotent
  script makes that seconds), then resume. Working threads and explicit
  setup retries never become templates; a failed build is torn down and the
  thread sets up fresh. Git/model credentials and host environment never
  enter builders, templates or threads.
- **Environment key:** the contents of `setup`, `resume` and `cube.toml`,
  the base image fingerprint, architecture, disk quotas, the memory cap and
  the operator's egress list. Repository commits are deliberately absent.
  One template per project: a new key builds a new template and deletes the
  previous one once no clone is in progress (Incus keeps a deleted
  template's datasets alive while clones depend on them). Concurrent first
  threads share one build. `CUBED_ENVIRONMENT_CACHE=0` turns templates off.
  Builders, captures and clones are lifecycle events (`kind=environment`).
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
- Per-cube allowlist in `.cube/cube.toml` (implemented 2026-09-10). It
  extends the built-in package hosts (`DEFAULT_EGRESS_ALLOW`) and the
  operator's `CUBED_EGRESS_ALLOW`; cubed reads it host-side at every proxy
  start (provision, wake, setup retry, boot), so an edited declaration
  applies on the next wake, and a parse error fails that transition naming
  the entry. Names only — exact or `*.suffix` — ports 80/443, public
  addresses: the proxy vets every entry no matter who wrote it.

```toml
[network]
allow = ["repo.maven.apache.org", "*.gradle.org"]
```

- The environment directory (`.cube`: setup, resume, cube.toml) may live
  outside the primary repository. A project's
  `environment = "<checkout>/<folder>"` points at a folder of one of its
  reference repositories, mounted read-only at `/repos/<checkout>`:
  setup/resume run from there with `/workspace` as cwd, `cube.toml` (hooks,
  services, network) is read from there, and the project check verifies
  the folder and parses its `cube.toml` at the pinned commit. This is how a
  repository that does not (yet) carry cube files gets an environment,
  versioned in a repository of the user's own; each thread snapshots the
  choice with its repositories.

- Default: no secrets enter the cube. (Host-side secret *injection* à la
  gondolin is out of scope for now; revisit if the need appears.)

## 13. Roadmap

The phase history (spikes through the installable image) lives in
[docs/history.md](docs/history.md#phase-plan). What remains open, in no
particular order:

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
