# Handoff

The ordinary HTTP conversation path uses an in-process pi-durable 1.0.1 Harness
+ SQLite, with startup activation and snapshot SSE. On branch `feat/vm-runner`
every thread now works in its own QEMU virtual machine on a runner
([plan](docs/plans/2026-10-04-vm-runner.md)):

- **Runner (protocol 3):** one VM per active thread (Debian 13 genericcloud
  overlay, cloud-init seed written by the runner as a FAT `CIDATA` image),
  VM lifecycle only; same-UID command execution, runner file operations and
  runner-side Git are gone.
- **cube-gateway:** started and supervised by cubed; each VM's only network.
  Frames travel runner → Iroh datagrams → gateway; per VM a smoltcp LAN with
  DHCP and DNS; only HTTP/HTTPS to public addresses; TLS interception with the
  installation CA; a decision from cubed's egress policy per request; the
  GitHub placeholder replaced by the host's token for github.com and
  api.github.com only.
- **Tools:** Pi's read/write/edit/bash/codemode and the Claude Code mod keep
  calling the thread `Workspace`; `VmWorkspace` implements it over the guest
  helper `cube-guest` (journaled keys, epoch fencing, commands in transient
  systemd units as user `agent`), reached with the system OpenSSH client
  through `cube-gateway dial` with pinned host keys.

The guest is the isolation boundary between a thread and the runner; QEMU runs
as the runner account and is hardened only by `-sandbox on`, so the runner host
as a whole is not a sandbox. State schema 102 and runner config version 2: no
migration; a fresh `CUBED_STATE` and re-enrolled runners (DEVELOPING.md).

Verified on server1 (Linux, KVM, QEMU 8.2, Debian 13 genericcloud, disposable
state, loopback Iroh, 2026-10-04):

- `CUBE_TEST_VM_IMAGE=… CUBE_TEST_VM=required bash scripts/test-node-transport.sh`
  (fmt, clippy, both crates' tests, runner packaging, and the three live
  smokes below in one run).
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm test` (offline suites, including the
  guest helper's unit tests, the Workspace contract over the real helper under a
  temporary root, gateway supervision with a fake gateway, egress policy, seed,
  thread machine lifecycle and the process-level smokes over local guests).
- `scripts/smoke-runner-vm.ts` (runner + gateway + guest).
- `scripts/smoke-node-adapter.ts` (cubed's side, 50 s): protocol-3 client,
  gateway supervision, `ThreadVms` boot to a ready guest helper in ~25 s
  (packages installed through the gateway), the Workspace contract over real SSH
  in process and over HTTP, egress probes, runner SIGKILL → interrupted → boot
  again from the same disk, a retained release.
- `scripts/test-vm-e2e.ts` (the product, 151 s): a disposable cubed with a faux
  model and a fake `claude`; Pi write/read/edit/bash/codemode in the guest;
  cubed SIGKILL mid-command (the gateway exits with its lifeline, the next
  cubed reattaches, the command ran once); gateway SIGKILL mid-command (restart,
  re-attach, SSH back, result retrieved); egress (public HTTPS 200; cubed's port,
  the gateway, RFC 1918, metadata and outbound ssh refused); `gh api user` and
  `git clone`/`git push` against a local GitHub fake through placeholder
  substitution (a foreign placeholder and another host denied; the token absent
  from the guest file system and process environments, the seed, the runner
  state and the logs); a Claude Code thread's Write/Read/Edit/Bash in the guest
  and a stop that cancelled the guest command; clean archive deletes the disk,
  changed ones are retained; every process stopped.

Not verified: macOS (HVF, arm64 guest), runner and cubed on separate machines
(direct and relay modes), more than one active VM per runner (by design one),
many VMs and flows under load, a real `gh auth token` against github.com from a
guest with a real model (manual check, only with the maintainer's consent), a
guest that ignores ACPI power-down, and the release tarball built by CI (a
local build with a disposable key carries `bin/cube-gateway`, and its
`--self-check` fails without it). The web UI's "starting the thread's machine"
state and the runner panel's machine counts were inspected in headless
Chromium at 1440×900 and 390×844 against a disposable cubed with local guests,
not with a real VM. HTTP/2, WebSocket and CONNECT are refused
by the gateway this round; clients that pin certificates fail against the
interception. Snapshots, `.agents/setup`/resume and macaroons are next round.

Earlier evidence that still holds for the parts this branch did not change:
provider auth (Pi's Models login/logout/refresh, key entry, OAuth
browser/device flows, cancellation) and Claude Code thread handling (the
unmodified `claude` with the user's own login, the mod's tool allow-list,
interrupt, resume, model switch) were exercised live on 2026-10-03/04 against
the protocol-2 runner; their workspace side now runs in VMs and is covered by
the e2e with a fake `claude` only.

Known gaps: pi-codemode 1.0.1 has no stack or CPU-slice limit, so a spinning
script holds a cubed CPU core until its wall deadline (15 minutes by default);
cube exposes no reset or manual compaction (Pi's reset is covered through its
API only), and an overflow compaction has no test; pi-durable's `onReport` is
not wired to any log; the first boot of every thread machine installs packages
through the gateway (about 25 s on server1; the known 30 s `apt-get update`
stall applies) until snapshots exist. AGENTS.md still describes Pi as an
AgentHarness and needs the maintainer's update to pi-durable;
docs/architecture-tour-notes.md is marked historical.

No push, deployment, release or destruction of an existing installation was
performed. Review the diff before shipping; this is implementation evidence, not
production sign-off.
