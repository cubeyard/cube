---
name: verify-cube
description: Drive cube the way a user does and keep the evidence. Launches an isolated cubed (real server, OptChat, web UI and guest helper; faux model, no VM, no sandbox of its own) on disposable state, checks it, runs browser and CLI journeys (chat, projects, threads, OptChat spawning a thread, the cubed CLI) in Playwright's Chromium, and cleans up while keeping screenshots, ARIA snapshots, API reads and step logs. Use before reporting a cube UI, API, OptChat, thread lifecycle or CLI change as working, to reproduce a user-visible bug, or to pick which checks a change needs.
metadata:
  cube:
    surface: thread
---

# verify-cube

`.agents/skills/verify-cube/verify-cube` is the helper (it runs `packages/web/test/browser/verify-cube.ts` from the repository root). Every command below runs from the repository root.

## What is real and what is not

Real: cubed's HTTP server and API, OptChat and its tools, Pi's durable agent and its SQLite stores, the registry, project repository checks (git against a seeded local bare repository), the guest helper `cube-guest` running each tool call, the built web UI, Chromium.

Not real, and never claimed as verified by this skill:

- The model is Pi's faux provider, scripted by the message (below). No provider, no paid call, no auth flow.
- The runner is a registry row (`node-verify`) with no config. There is no `berth`, no VM, no keel, no gateway, no egress policy.
- Claude Code threads are off (`claude: null`); cubed's own portal is off; GitHub is never contacted.

Say which of these a claim rests on when you report it.

## Who can run what

The instance has no sandbox of its own. Every tool call of its threads runs as plain processes under `RUN/scratch/machines/<thread>/`, as the account that started the helper. cubed has no login, and the faux model runs any `tool {"name":"bash",…}` line it is sent, so anyone who can reach the instance's port can run any command as that account.

- In a cube thread that account is the thread machine's `agent` (with sudo). The reach is that VM: its files, what `agent` and sudo can do there, and the VM's own network egress. The thread VM is the boundary; the harness adds none.
- Served under `cube service` on `0.0.0.0` with `--allowed-host`, it is reachable through cube's portal, which has no login (docs/services.md): anyone who can reach the portal and knows the URL can run commands as `agent` in this thread's VM. Serve it there only when the user wants to look, and stop it when they are done.
- Outside a thread machine it runs as you, on your host, unsandboxed. Keep it on `127.0.0.1` (the default); any local process that can connect can still run commands as you.

## Pick the scope by risk

Run the journeys the change can break, not all of them. One `run` of all five takes about 20 seconds after `pnpm build`.

| The change touches | Run | Also |
| --- | --- | --- |
| chat UI, composer, transcript, streaming | `chat` | a `pnpm test:browser` scenario for chat or transcript behavior (AGENTS.md) |
| layout or appearance | the journey that shows it | look at its screenshots; `chat` covers phone (390x844) |
| projects, repository checks, project page | `project` | |
| thread start, tools, transcript, archive, guest helper | `thread` | |
| OptChat tools, spawn, reports, delegation | `spawn` | |
| `cubed` flags or subcommands | `cli` | |
| berth, keel, QEMU, gateway, egress, runner protocol, suspend | none: this skill has no VM | the native gate in DEVELOPING.md, on the host where the risk lives |
| real providers, model auth, Claude Code | none: the model is faux | `scripts/check-claude-*.ts`, offline auth tests |

The map in [features/README.md](features/README.md) lists every journey with its user entry points, and the features it does not cover yet.

## Launch, doctor, drive, clean up in one command

Prerequisites: `pnpm install --frozen-lockfile`, `pnpm build` (the helper refuses a missing `packages/web/dist`; rebuild after UI changes), Chromium for Playwright (a thread machine has it; else `bash scripts/setup-browsers.sh`). Linux or macOS.

```sh
pnpm build
.agents/skills/verify-cube/verify-cube run --run /tmp/verify-cube/my-change thread spawn
```

`run` creates `RUN/scratch` (it refuses one that exists) and marks it with an owner file; starts cubed in its own process on `127.0.0.1` and a free port with its state there; seeds a git repository (`main`, one commit `verify-cube seed commit`, `README.md`) and a ready project `demo`; runs doctor; drives the named journeys (default `chat thread`); closes cubed and removes `RUN/scratch`. It prints `ready <url> run=<RUN>`, the doctor lines, each step and `PASS: …` or `FAIL: …`, and exits non-zero on any failure. A launch that fails part way removes what it created. Without `--run` the run directory is `$TMPDIR/verify-cube/<time>`. Set `CUBED_LOG_LEVEL=info` to see cubed's own log.

## A long-lived instance to explore

To look around by hand or drive journeys one at a time, serve it. In a cube thread a server dies with its command, so run it as a service; it must listen on `0.0.0.0` there (read "Who can run what" first):

```sh
cube service start verify-cube --port 7790 -- node packages/web/test/browser/verify-cube.ts serve --run /tmp/verify-cube/explore --port 7790 --host 0.0.0.0
.agents/skills/verify-cube/verify-cube doctor --run /tmp/verify-cube/explore
.agents/skills/verify-cube/verify-cube drive --run /tmp/verify-cube/explore chat project
cube service stop verify-cube
.agents/skills/verify-cube/verify-cube cleanup --run /tmp/verify-cube/explore
```

Drives use `127.0.0.1`. The portal URL `cube service start` prints answers `403 host rejected` (cubed's Host allowlist) until the instance allows that hostname: for the user to open it, stop the service, `cleanup`, and start it again with `--allowed-host <hostname from the url>` after `--host 0.0.0.0`.

Outside a cube thread run `serve` in a second shell with the default host.

`serve` needs `--port` from 1 through 65535 and refuses a run directory that has `instance.json` or `scratch`: clean up first or pick another `--run`. `chat` and `project` expect the seeded baseline, so drive them once per instance.

## Doctor

`doctor --run RUN` reads `RUN/instance.json`, waiting up to `--wait` seconds (default 30) while a `serve` launches and then failing with `FAIL: no RUN/instance.json …`, and prints one `ok:` or `FAIL:` line per check: the pid is alive and is this run (inside `run`, the process itself; for a `serve`, its command is `verify-cube.ts` with exactly this `--run`); scratch holds this launch's owner file; the state is under this run (never `~/.cube*`); `/api/health` says `ready`; `/api/state` has onboarding done and a model; `/api/models` lists `faux/faux-1`; `/api/runners` lists `node-verify`; `/` serves the UI. A process's command comes from `/proc` (Linux) or `ps -ww` (macOS, whole line); when neither answers, doctor fails. Run it before the first drive and after any failed drive. A `FAIL` means relaunch, not drive harder. `run` does this itself.

## Drive

Journeys are functions in `packages/web/test/browser/verify-cube.ts` (`JOURNEYS`), one per feature file. Drive through the UI with ARIA roles and names, or the class names the browser tests use (`.composer textarea`, `.composer button.send-key`, `.conversation-message.user`, `.composer[aria-busy=false]`, `dialog.new-thread-dialog`, `.strip-details-key`, `details.report > summary`). Read the API only for a second view of what the UI did.

The faux model answers the last text of the message:

- a line `tool {"name":"bash","args":{"command":"…"}}` calls that tool (any tool the agent has: `spawn`, `threads`, `tell`, … in OptChat) and then answers `result: <tool output>`;
- `please fail` fails the run with `the provider refused`;
- anything else is answered `ok: <message>`.

A journey the map lacks is added as a function in `JOURNEYS` and a feature file, in the same change. Do not drive it with a throwaway script and report it as mapped.

## Evidence

Each drive of a journey writes a directory of its own under `RUN/evidence`: `<journey>`, then `<journey>-2`, `<journey>-3` on later drives in the same run directory (the helper prints which). Nothing there is overwritten, and cleanup never removes it:

- `steps.log`: each user action and what was observed, then `PASS` or `FAIL: <stack>`.
- `NN-<what>.png` and `NN-<what>.aria.yml`: the page and its accessibility tree after each step that matters.
- `*.json`: API reads that confirm a side effect (`/api/projects`, a thread's history, `/api/threads`, OptChat's history).
- `cubed-*.txt`: each CLI command with exit code, stdout and stderr.
- `failure-N.png` and `failure-N.aria.yml`: every open page at the moment a journey failed (the tree is also printed to stderr).

`scripts/test-browser.sh` puts its run under `$CUBE_SCREENSHOTS/verify-cube` when that is set; CI's `browser` job uploads that directory as the `browser-screenshots` artifact.

Proof is the user action plus its resulting state plus a side effect seen another way (a second turn reading the file the first wrote, the file in the guest's workspace, the API after a UI archive). A status line or a toast alone is not proof. Report the evidence paths with the result.

## Cleanup

`run` cleans up by itself, also after a failure. For a served instance, `cleanup --run RUN`:

- stops the pid in `RUN/instance.json` only when it is alive and its command is this run's `verify-cube.ts serve`, and waits up to 20 s for it to exit; a pid that is now some other program is left alone;
- deletes nothing while that pid is alive and its command cannot be read, is a verify-cube process it cannot match to this run's `serve` (cut short, another run), or has not exited;
- removes `RUN/scratch` only when its owner file holds this launch's token (or, with no `instance.json`, when it has an owner file at all), then `instance.json`;
- prints `kept RUN/evidence`, and exits 1 when it left any of the run in place, saying what and why.

Under `cube service`, stop the service first (it restarts what dies). Check that `RUN/evidence` is still there before you report.

## Gotchas

- Run from a fresh `pnpm build`: the server serves `packages/web/dist` as built, so stale UI passes or fails for the wrong reason.
- Free disk under 2 GB makes cubed log `cubed disk … low=true`; that is a warning, not a failure.
- `cubed runners status` exits 1 here: the stand-in runner has no config to reach. The `cli` journey asserts exactly that.
- The local guest has no machine sleep; the startup steps and sleep states are covered by `packages/web/test/browser/startup-browser-test.ts`.
- Archive keeps a thread's disk when it holds uncommitted work (the `thread` journey's `proof.txt` does), so `scratch/machines/<id>` outlives the archive until cleanup.
- A served instance killed with SIGKILL while a thread command runs can leave that command's processes behind; cleanup removes scratch once the instance's pid is gone, not those processes. Stop it with `cleanup` or `cube service stop`, not `kill -9`.
- macOS is handled (`ps` for process identity) but checked only with stand-ins in `verify-cube-test.ts`, not on a Mac.

Keep the map honest with `/maintain-verification-skill`. `node packages/web/test/browser/verify-cube-test.ts` checks the helper's own safety; `scripts/test-browser.sh` runs it.
