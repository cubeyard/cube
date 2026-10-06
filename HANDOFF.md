# Handoff

Status of cube as of 2026-10-05, release **v0.3.2**. Start here; the plans
in `docs/plans/` hold the reasoning and the detailed evidence.

## What cube is now

- **cubed** runs the agents on the host. Pi uses pi-durable 1.0.1 with
  SQLite; Claude Code threads use the unmodified `claude` with the user's own
  login. Both work on the thread's `Workspace`.
- **Every thread has its own VM on a runner** (runner protocol 3; see
  `docs/plans/2026-10-04-vm-runner.md`):
  - one QEMU VM per active thread, several per runner (`--max-active-vms`);
  - Debian 13 genericcloud, with a qcow2 overlay per thread;
  - a cloud-init seed written by the runner.

  The guest is the thread's sandbox. The runner host as a whole is not (see
  ARCHITECTURE.md for what the boundary covers).
- **cube-gateway**, supervised by cubed, is each VM's only network:
  - Frames travel runner → Iroh datagrams → gateway, which runs a smoltcp LAN
    with DHCP and DNS.
  - Only HTTP/HTTPS to public addresses gets out. HTTPS is intercepted with the
    installation CA, and cubed decides each request (`egress-policy.ts`).
  - The guest holds a GitHub placeholder; the gateway puts in the host's token
    for github.com and api.github.com only, so `gh` and `git push` work
    normally in a thread.
- **Tools** (Pi's read/write/edit/bash/codemode, the Claude Code mod) run in
  the guest through the guest helper `cube-guest`. cubed reaches it with
  OpenSSH via `cube-gateway dial`, with pinned host keys.
- **A new thread runs the repository's `.agents/setup`** after the checkout.
  For cube that installs Node 26, pnpm, Rust and build-essential, then runs
  `pnpm install` and builds the web app. The log is `~/.cache/cube/setup.log`
  in the guest. A failed setup still leaves the thread usable.
- **Machine templates and hooks** (branch `vm-snapshots`, cube-runner 0.8.0,
  not released): a project has external pre-setup and pre-resume hooks; a
  project's first thread on a runner builds a template in a build machine
  (checkout, pre-setup, `.agents/setup`, seal, power-off, publish) and later
  threads start from it, skipping setup; resume hooks run on every machine
  boot. Semantics and defaults: ARCHITECTURE.md, "Machine templates and
  hooks"; decisions: `docs/plans/2026-10-05-machine-templates.md`.
- **Archive keeps the disk** of any thread whose agent ran a command or wrote
  a file. The operator deletes retained disks from the project page
  ("retained machines") or with `POST /api/threads/<id>/discard`
  (`vm.discard`, cube-runner 0.5.0+).

## How an installation runs

- One cubed host: the managed launcher with a user service and the signed
  update feed (`docs/cubed-updates.md`).
- Any number of runners, each with its own control key (enrollment refuses a
  shared key). Each runner hosts up to `--max-active-vms` thread VMs at once
  (`auto` by default: what fits at the per-VM maximum, 1 to 4; a new VM
  needs 4 GiB free disk; cube-runner 0.7.0+, older runners host one). A
  self-update to 0.7.0 applies `auto` on its own. Runners:
  - **Linux x86-64:** `cube-runner.service`, a dedicated account in group
    `kvm`;
  - **macOS arm64:** the per-user LaunchAgent profile from
    `install.sh --service`, using HVF.

  Install, enroll, drain and upgrade: `docs/runner-operations.md`.
- State schema 102 adopts no older state. Moving from v0.2.x means a fresh
  `CUBED_STATE` and re-initialized runners (DEVELOPING.md, "Fresh start").

## Shipping a change

1. Merge to `main` after CI (`check`, `node-transport` on Linux and macOS).
2. Push a `vX.Y.Z` tag. `release.yml` builds and signs cubed for three
   platforms and cube-runner bundles for `linux-x64-gnu` and `darwin-arm64`,
   all into a draft release.
3. Publishing the draft makes it `latest`:
   - cubed updates through its feed (browser, or `install.sh` with the
     downloaded assets);
   - **runners update themselves.** An hourly job (root systemd timer on
     Linux, launchd job on macOS) verifies the signed manifest with the pinned
     key, waits while a thread VM is active, and runs the bundle's
     `upgrade.sh` (drain, switch, readiness, rollback).

   No sudo is needed per release once a runner is on 0.6.0.

Released on 2026-10-04/05:

| release | content |
|---|---|
| v0.2.2 | Claude Code's `fable` model |
| v0.3.0 | VM runners, cube-gateway, tools over SSH, `.agents/setup` |
| v0.3.1 | discard retained machine disks |
| v0.3.2 | runner self-update (cube-runner 0.6.0) |

## Developing cube in cube

A thread on the cube project gets a VM with the toolchain installed, ready in
about 60-100 s. Verified inside the VM on 2026-10-05:
- `pnpm typecheck` takes about 15 s;
- `pnpm test` passes all 28 offline suites in about 2 min;
- `cargo build -p cube-runner -p cube-gateway` takes about 1.5 min;
- `cargo test -p cube-gateway` passes.

The guest has no KVM, so `scripts/test-node-transport.sh` with a real VM
(`CUBE_TEST_VM=required`) has to run on a runner-capable host, not inside a
thread.

## Verified

- Every release above: `pnpm typecheck`, `pnpm lint`, `pnpm test`,
  `pnpm build`, and `test-node-transport.sh` with a real VM. That covers
  `smoke-runner-vm`, `smoke-node-adapter` and `test-vm-e2e`: Pi and Claude
  Code tools in the guest, cubed and gateway SIGKILL, egress refusals,
  `gh`/`git push` through placeholder substitution, retain, discard, and
  reinstalling packages after a broken first boot.
- **Production on 2026-10-05:** one Linux runner and one macOS runner (arm64,
  HVF, relay mode, 17 ms from cubed). Smoke threads with a real model on both
  were ready in 91 s and 101 s with the full toolchain. Retained disks were
  discarded on both. The Linux runner's updater ran against the real feed.
- **Remote runner throughput:** HTTPS downloads in the macOS guest run at
  14-21 MB/s; the Mac itself does 50 MB/s. Testing that runner fixed:
  - congestion control in the gateway (Cubic);
  - dropping whole frames when the datagram queue is full;
  - macOS unix-datagram buffers (QEMU gets a socketpair with 4 MiB buffers);
  - 2 MiB flow windows;
  - a race where a late QMP wait killed the next start's QEMU.

  Guest MTU 1140 was measured 6 % slower than 1500 and was not adopted.

## OptChat (branch `feat/optchat`)

The user's one endless chat at
`#/chat`, built on a second pi-durable store under `CUBED_STATE/optchat`. It
follows the OptChat spec's log, tree, view, compactor and turn loop. Its only
actions are spawning, telling and archiving its own ordinary threads (archive
refuses a working thread and never stops one); their reports come back as
`[id] ` messages. Verified offline only: `optchat-memory-test.ts` (fold,
order, zoom, log mapping), `optchat-test.ts` (Pi turns with a faux model:
fresh context, compactor feedback, report turns, zoom/tell, reopen) and
`optchat-product-test.ts` (cubed's routes, a real thread on a local guest
running bash, its report back in the chat, and the archive tool against real
threads), `optchat-history-test.ts` and `optchat-archive-test.ts` (the
history and archive tools: ownership, busy refusal, repeats, reports). The chat strip and memory panel
were measured in headless Chromium at 1440×900 and 390×844 (no overflow, one
strip row on the phone). Not verified: a real model as chat or compactor, a
real VM thread. Two review rounds then made delivery
durable and idempotent. It now has a persisted pending queue, one turn for
everything waiting with each message its own Pi submission, steering of every
waiting message only during a tool round, a lock across steer, submit and
stop, and unanswered messages on stop. The rounds also stopped logging failed
attempts, restored the view on reopen and made spawn replay find its thread.
These are tested offline, except a restart in the middle of a turn's
submission, which is idempotent by construction but untested. Prompt caching follows spec §8 through pi-ai's
`onPayload` and `sessionId`: three Anthropic marks in the view and a stable
OpenAI `prompt_cache_key`. It is checked against pi-ai's real request builders
offline, but hit rates on a live provider are not measured. Deviations (no
OpenAI breakpoint field, a small steering window, threads do not get the view)
are listed in docs/optchat.md.

## Usage and cost (branch `feat/usage-accounting`)

Read-only usage accounting over the agents' own records: Pi's `pi.usage`
ledger, Claude Code's `modelUsage` totals per turn (counted once across
resumed processes), OptChat's chat and compactor. Tokens and estimated cost
per thread, project and model at `GET /api/usage`, per thread at
`/api/threads/<id>/usage`, in OptChat's `usage` tool, on the thread strip and
in usage panels on the project and system pages. Estimates only; billed
amounts are not available; unpriced or unrecorded usage is reported as
unknown. Verified offline (`usage-test.ts`, the product smoke with the fake
`claude`); not verified against a real provider or a real Claude Code's
stream. Next: capture a real `claude -p` stream across a model change and a
`--resume` to confirm how its `modelUsage` carries totals (the resume
inference undercounts, never overcounts, if it guesses wrong). Details and
gaps: docs/usage.md.

## Known gaps and next steps

- **Machine templates:** built on `vm-snapshots`, verified on Linux/KVM only
  (`scripts/test-vm-templates.ts`); macOS/HVF templates are not verified. Not
  done: building in the background on idle capacity, adopting a failed build
  machine as the thread's machine (a failed build costs a second cold boot),
  a template's checkout refresh against a real remote in a VM test (covered
  offline), per-project TTLs.
- Macaroons for finer GitHub authorization, and a separate download exit, need
  design decisions.
- **Gateway limits:** HTTP/2, WebSocket and CONNECT are refused. Clients that
  pin certificates fail. There is no IPv6.
- **Not verified:**
  - more than one active VM per runner on production hosts, macOS/HVF and
    load (verified: two guests on one Linux/KVM runner in
    `scripts/test-vm-concurrency.ts`, on a small nested-KVM host);
  - load;
  - a guest that ignores ACPI power-down;
  - a real model driving `gh`/`git` on its own initiative in a long task;
  - the macOS updater's first scheduled run.
- **Other:**
  - pi-codemode 1.0.1 has no CPU-slice limit;
  - there is no manual compaction or reset in the UI;
  - pi-durable's `onReport` is not wired to logs;
  - AGENTS.md still calls Pi an AgentHarness;
  - `docs/architecture-tour-notes.md` is historical.
