# Working on cube as an agent

The operating manual for any coding agent (Claude Code, Codex, pi, …) that
has to build, deploy, drive, debug or fix cube. Everything here is
reproducible from a shell; nothing needs a human at a browser. Product and
design contracts live in [PRODUCT.md](PRODUCT.md) and [DESIGN.md](DESIGN.md);
open work and traps in [HANDOFF.md](HANDOFF.md); the dev loops in detail in
[DEVELOPING.md](DEVELOPING.md). Read those before changing behaviour. This
file is the short path to *doing*.

## The shape of the system

| Layer | Where | How it runs |
|---|---|---|
| Launcher | `launcher/cube` | one bash file on the user's host; downloads/boots the VM under QEMU, `cube up/down/status/upgrade/logs/ssh/diagnose` |
| VM | NixOS image built by `scripts/vm/base/` | UEFI, five virtio disks; state on the ZFS data disk |
| cubed | `packages/server` | the daemon: HTTP/WS API + web UI + portal proxy on :7777, `systemctl status cubed` in the VM, runs from source |
| sandbox | `packages/sandbox` | Incus system containers, one per thread, egress through a per-cube allowlist proxy |
| pi + extension | `packages/pi-extension` | the real pi TUI, spawned per thread on the VM host; the extension routes tools into the cube |
| git | `packages/git` | host-side clone/seed/diff/push/PR with credentials that never enter a cube |
| web | `packages/web` | Svelte 5 + Vite SPA, hash routing, built to `packages/web/dist` |

The user-facing unit is the **thread**; a thread's backing **cube** is
invisible in the product. `/api/threads/*` is the product API; `/api/cubes/*`
is plumbing you may use for diagnosis and explicit sleep/wake.

## Host toolchain

Node ≥ 26 and the pnpm pinned in `package.json`. On this development host:

```sh
export PATH=/home/diz/.asdf/installs/nodejs/26.8.1/bin:$PATH   # node 26 + pnpm 10.34.5
pnpm install --frozen-lockfile
pnpm typecheck          # tsc + svelte-check
pnpm test               # every offline suite (scripts/test-offline.sh); no VM needed
pnpm build              # packages/web/dist
```

Tests are plain node scripts that exit non-zero on failure; add new ones to
`scripts/test-offline.sh` (CI runs that list on every push).

## Two kinds of VM, and how to reach them

1. **The launcher VM** in `~/.cube` — the product as a user has it. Reach it
   with the installed launcher: `cube status`, `cube ssh`, `cube logs`,
   `cube diagnose`. SSH directly with
   `ssh -p 2222 -i ~/.cube/id_ed25519 cube@127.0.0.1` (ports from
   `~/.cube/config`). The `cube` user has passwordless sudo.
2. **The dev VM** in `~/cube/vm` — built from the working tree by
   `scripts/vm/build.sh`, driven by `scripts/vm/{up,down,ssh,sync,test}.sh`.
   Needed only for base-image, Incus, network or storage changes.

Inside either VM:

| What | Where |
|---|---|
| app tree (cubed, extension, web dist) | `/opt/cube/app` |
| node + pnpm | `/opt/cube/node/bin` |
| registry (SQLite, WAL) | `/home/cube/cube/cubed.db` |
| per-thread workspace + pi sessions | `/home/cube/cube/cubes/<cube>/{workspace,sessions}` |
| project repository mirrors | `/home/cube/cube/repos` |
| daemon log | `journalctl -u cubed -f` |
| containers | `incus list`, `incus exec cube-<name> -- bash` |
| identity sentinels | `/opt/cube/app/build-id`, `/opt/cube/app/.deployed-tree` |

## The inner loop: change → deploy → prove

```sh
bash scripts/vm/deploy-tree.sh            # working tree -> the launcher VM, web built on the host, cubed restarted
bash scripts/vm/deploy-tree.sh --install  # when package.json / pnpm-lock.yaml changed
bash scripts/vm/deploy-tree.sh --dev      # target the dev VM instead
node scripts/smoke-live.ts                # one whole thread life through the API, with timings
cube logs                                 # or: cube ssh journalctl -u cubed -n 200 --no-pager
```

`deploy-tree.sh` ships tracked files as they are on disk (uncommitted edits
included) and never touches `build-id`, so `cube status`/`cube upgrade`
keep working. Files deleted in the tree linger in the VM until the next
release. To put the released app back: `bash scripts/vm/deploy-tree.sh
--restore` re-applies the installed release's app tarball.

`smoke-live.ts` needs a **ready project** (create one in the UI or with
`POST /api/projects`) and creates then deletes exactly one thread of its
own. Add `--keep` to leave it for inspection, `--json` for one machine
readable line, `--skip-sleep` to skip the sleep/wake leg. Provisioning a
thread takes minutes: clone, container create, `.cube/setup`.

### Driving the UI without a human

Any Playwright-style browser works; on this host `agent-browser` is installed:

```sh
export AGENT_BROWSER_EXECUTABLE_PATH=$(find ~/.cache/ms-playwright -path '*chromium_headless_shell*' -type f -name 'chrome-headless-shell' | head -1)
agent-browser open http://127.0.0.1:7777/          # then: snapshot, click @ref, type, screenshot /tmp/x.png
agent-browser set viewport 390 844                 # phone check; PRODUCT.md: phone must be usable
```

`agent-browser snapshot` prints the accessibility tree with refs, which is
also the fastest way to see whether copy, states and labels match the
product contract. Portal URLs resolve via sslip.io:
`http://<service>--<cube>.<host-ip>.sslip.io:7777`.

### Reading state directly

```sh
curl -s localhost:7777/api/threads | jq          # what the UI sees
curl -s localhost:7777/api/cubes | jq             # backing environments and their raw status/error
curl -s 'localhost:7777/api/events?limit=50'      # lifecycle events with durations (see below)
cube ssh 'node -e "const {DatabaseSync}=require(\"node:sqlite\");const db=new DatabaseSync(\"/home/cube/cube/cubed.db\",{readOnly:true});console.log(db.prepare(\"select name,status,error from cube\").all())"'
```

No `sqlite3` CLI ships in the VM; `node:sqlite` does the same job.

## Observability

cubed records every lifecycle transition (provision stages, wake, sleep,
delete, terminal spawn, ship steps, portal failures) as an **event** in the
registry: `{ts, kind, phase, cube, thread, ok, ms, detail, version}`.
`GET /api/events` returns them newest first (`?since=<ms>`, `?cube=`,
`?thread=`, `?kind=`, `?limit=`); `cube events` prints the same from the
host. `node scripts/events-report.ts` summarises p50/p95 per kind and
version so a change can be compared against the previous release — that
is the hill-climbing loop: run `smoke-live`, read the report, change, repeat.

`cube diagnose` bundles the journal, events, Incus state and an optional
model-written root-cause analysis; `cube diagnose --collect-only` for the
bundle alone.

## Guardrails (do not cross without an explicit instruction)

- Never push to `main` or create tags; a shipped-file push to main can mint
  a release. Work on branches and open PRs.
- Never commit credentials, `~/.cube`, `~/.pi`, or anything from a VM's
  `/home/cube`. Commit as `Didrik A. Rognstad <3679075+dizk@users.noreply.github.com>`
  when authoring for the maintainer.
- Never delete or open other people's threads on a shared VM; the smoke
  creates its own. Deleting a thread destroys its container and workspace.
- Keep pi's isolation flags (`--no-extensions --no-approve --no-context-files`)
  and the extension's fail-closed tool audit; keep credentials out of cubes.
- Never use a `*.localhost` portal base and never bind cubed to a public
  address; it has no authentication.
- English in the repository; keep user-facing copy in the lowercase, calm
  register of README.md and the UI; thread vocabulary only (no "cube",
  "incus", "container", "instance" in anything a user reads).
- Mock success is not sandbox acceptance: Incus, network and storage
  changes need the VM portfolio (`scripts/vm/test.sh`).

## Where to look when something is wrong

| Symptom | First look |
|---|---|
| thread stuck in `setting up` | `curl /api/cubes` for the raw status; `journalctl -u cubed`; `incus list`; `/api/events?kind=provision` |
| thread `error` | the cube's `error` column via `/api/cubes/<name>`; provisioning rolls the instance back, so `incus list` may not show it |
| terminal shows `connecting…` forever | `journalctl -u cubed | grep -i pty`; is the cube `asleep`/`waking`? `/api/cubes/<name>/wake` |
| portal holding page | `/api/threads/<id>/services`; `incus exec cube-<name> -- systemctl --user status`; the service's declared port in `.cube/cube.toml` |
| launcher fails | `~/.cube/console.log` (serial console), `cube status`, `cube diagnose` |
| VM boots but cubed is down | `cube ssh systemctl status cubed cube-data-init incus` |
