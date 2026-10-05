# Handoff

Status of cube as of 2026-10-05, release **v0.3.2**. Start here; the plans
in `docs/plans/` hold the reasoning and the detailed evidence.

## What cube is now

- **cubed** runs the agents on the host. Pi uses pi-durable 1.0.1 with
  SQLite; Claude Code threads use the unmodified `claude` with the user's own
  login. Both work on the thread's `Workspace`.
- **Every thread has its own VM on a runner** (runner protocol 3; see
  `docs/plans/2026-10-04-vm-runner.md`):
  - one QEMU VM per active thread;
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
- **Archive keeps the disk** of any thread whose agent ran a command or wrote
  a file. The operator deletes retained disks from the project page
  ("retained machines") or with `POST /api/threads/<id>/discard`
  (`vm.discard`, cube-runner 0.5.0+).

## How an installation runs

- One cubed host: the managed launcher with a user service and the signed
  update feed (`docs/cubed-updates.md`).
- Any number of runners, each with its own control key (enrollment refuses a
  shared key). Each runner hosts one active VM. Runners:
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

## Known gaps and next steps

- **Machine templates (snapshots):** not built. The proposal is in
  `docs/plans/2026-10-05-machine-templates.md` and needs three decisions:
  whether `.agents/setup` goes into the template, 72 h or per push, and a disk
  budget. They would save about 45 s per new thread.
- Macaroons for finer GitHub authorization, and a separate download exit, need
  design decisions.
- **Gateway limits:** HTTP/2, WebSocket and CONNECT are refused. Clients that
  pin certificates fail. There is no IPv6.
- **Not verified:**
  - more than one active VM per runner (one, by design);
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
