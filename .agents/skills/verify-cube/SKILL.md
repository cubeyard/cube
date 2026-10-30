---
name: verify-cube
description: Drive cube the way a user does and keep the evidence. Launches an isolated cubed (real server, OptChat, web UI and guest helper; faux model, no VM) on disposable state, checks it, runs browser and CLI journeys (chat, projects, threads, OptChat spawning a thread, the cubed CLI) in Playwright's Chromium, and cleans up while keeping screenshots, ARIA snapshots, API reads and step logs. Use before reporting a cube UI, API, OptChat, thread lifecycle or CLI change as working, to reproduce a user-visible bug, or to pick which checks a change needs.
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
- The runner is a registry row (`node-verify`) with no config. There is no `berth`, no VM, no keel, no gateway, no egress policy. Tool commands run as your own user in `scratch/machines/<thread>/`, unsandboxed.
- Claude Code threads are off (`claude: null`); the portal is off; GitHub is never contacted.

Say which of these a claim rests on when you report it.

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

Prerequisites: `pnpm install --frozen-lockfile`, `pnpm build` (the helper refuses a missing `packages/web/dist`; rebuild after UI changes), Chromium for Playwright (a thread machine has it; else `bash scripts/setup-browsers.sh`).

```sh
pnpm build
.agents/skills/verify-cube/verify-cube run --run /tmp/verify-cube/my-change thread spawn
```

`run` starts cubed in its own process on `127.0.0.1` and a free port, with state under `RUN/scratch`; seeds a git repository (`main`, one commit `seed`, `README.md`) and a ready project `demo` from it; runs doctor; drives the named journeys (default `chat thread`); closes cubed and removes `RUN/scratch`. It prints `ready <url> run=<RUN>`, the doctor lines, each step and `PASS: …` or `FAIL: …`, and exits non-zero on any failure. Without `--run` the run directory is `$TMPDIR/verify-cube/<time>`. Set `CUBED_LOG_LEVEL=info` to see cubed's own log.

## A long-lived instance to explore

To look around by hand or drive journeys one at a time, serve it. In a cube thread a server dies with its command, so run it as a service; it must listen on `0.0.0.0` there (the state is disposable and the model faux):

```sh
cube service start verify-cube --port 7790 -- node packages/web/test/browser/verify-cube.ts serve --run /tmp/verify-cube/explore --port 7790 --host 0.0.0.0
.agents/skills/verify-cube/verify-cube doctor --run /tmp/verify-cube/explore
.agents/skills/verify-cube/verify-cube drive --run /tmp/verify-cube/explore chat project
cube service stop verify-cube
.agents/skills/verify-cube/verify-cube cleanup --run /tmp/verify-cube/explore
```

Drives use `127.0.0.1`. The portal URL `cube service start` prints answers `403 host rejected` (cubed's Host allowlist) until the instance allows that hostname: for the user to open it, stop the service, `cleanup`, and start it again with `--allowed-host <hostname from the url>` after `--host 0.0.0.0`.

Outside a cube thread run `serve` in a second shell on `127.0.0.1` (the default host). Never bind `0.0.0.0` on a host network.

`serve` refuses a run directory that already has `instance.json`: clean up first or pick another `--run`. Drive each journey once per instance; `chat` and `project` expect the seeded baseline, so a second drive of them needs a fresh instance.

## Doctor

`doctor --run RUN` reads `RUN/instance.json` and prints one `ok:` or `FAIL:` line per check: the pid is alive and is `verify-cube.ts`; the state is under this run (never `~/.cube*`); `/api/health` says `ready`; `/api/state` has onboarding done and a model; `/api/models` lists `faux/faux-1`; `/api/runners` lists `node-verify`; `/` serves the UI. Run it before the first drive and after any failed drive. A `FAIL` means relaunch, not drive harder. `run` does this itself.

## Drive

Journeys are functions in `packages/web/test/browser/verify-cube.ts` (`JOURNEYS`), one per feature file. Drive through the UI with ARIA roles and names, or the class names the browser tests use (`.composer textarea`, `.conversation-message.user`, `.composer[aria-busy=false]`, `dialog.new-thread-dialog`, `.strip-details-key`). Read the API only for a second view of what the UI did.

The faux model answers the last text of the message:

- a line `tool {"name":"bash","args":{"command":"…"}}` calls that tool (any tool the agent has: `spawn`, `threads`, `tell`, … in OptChat) and then answers `result: <tool output>`;
- `please fail` fails the run with `the provider refused`;
- anything else is answered `ok: <message>`.

A journey the map lacks is added as a function in `JOURNEYS` and a feature file, in the same change. Do not drive it with a throwaway script and report it as mapped.

## Evidence

Everything goes to `RUN/evidence/<journey>/` and survives cleanup:

- `steps.log`: each user action and what was observed, then `PASS` or `FAIL: <stack>`.
- `NN-<what>.png` and `NN-<what>.aria.yml`: the page and its accessibility tree after each step that matters.
- `*.json`: API reads that confirm a side effect (`/api/projects`, a thread's history, `/api/threads` after archive, OptChat's history).
- `cubed-*.txt`: each CLI command with exit code, stdout and stderr.
- `failure-N.png` and `failure-N.aria.yml`: every open page at the moment a journey failed.

Proof is the user action plus its resulting state plus a side effect seen another way (a second turn reading the file the first wrote, the file in the guest's workspace, the API after a UI archive). A status line or a toast alone is not proof. Report the evidence paths with the result.

## Cleanup

`run` cleans up by itself, also after a failure. For a served instance, `cleanup --run RUN` stops only the pid in `RUN/instance.json`, and only when that pid is a `verify-cube.ts serve`; anything else is left alone and named. It then removes `RUN/scratch` (state, guest machines, seeded repository) and `instance.json`, and prints `kept RUN/evidence`. Under `cube service`, stop the service first (it restarts what dies). Check that `RUN/evidence` is still there before you report.

## Gotchas

- Run from a fresh `pnpm build`: the server serves `packages/web/dist` as built, so stale UI passes or fails for the wrong reason.
- Free disk under 2 GB makes cubed log `cubed disk … low=true`; that is a warning, not a failure.
- `cubed runners status` exits 1 here: the stand-in runner has no config to reach. The `cli` journey asserts exactly that.
- The local guest has no machine sleep; the startup steps and sleep states are covered by `packages/web/test/browser/startup-browser-test.ts`.
- Archive keeps a thread's disk when it holds uncommitted work (the `thread` journey's `proof.txt` does), so `scratch/machines/<id>` outlives the archive until cleanup.

Keep the map honest with `/maintain-verification-skill`.
