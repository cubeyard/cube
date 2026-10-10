# Working on cube

Read README.md, ARCHITECTURE.md, PRODUCT.md, DESIGN.md, HANDOFF.md and
DEVELOPING.md before changing behavior.

## Ownership

- `packages/server`: product API, projects, runner admission and activation.
- `packages/server/src/durable-agent.ts`: in-process Pi AgentHarness + published
  SQLite backend. Pi owns execution state; never add a second workflow journal.
- `packages/server/src/optchat*.ts`: OptChat, the user's endless chat; a
  second Pi store whose entries are its log and summary tree. It only starts
  and tells threads (docs/optchat.md).
- `packages/server/src/vm*.ts`, `guest-ssh.ts`, `egress-policy.ts`, `guest/`:
  thread machines, tool execution over SSH, the egress policy and the guest
  helper `cube-guest`.
- `packages/node-transport`: Linux/macOS VM runner (protocol 3), the `cube/l2/1`
  frame channel and the Iroh protocol.
- `packages/gateway`: `cube-gateway`, supervised by cubed; each VM's only
  network (LAN, HTTP/HTTPS egress, TLS interception, secret substitution).
- `packages/git`: host-side repository capabilities; credentials stay here.
- `packages/web`: Svelte 5/Vite UI, built to `packages/web/dist`.
- `packages/keel`: keel, what runs inside a thread machine: the guest kernel
  (nerdbox's config plus cube's fragments), and planned `cube-init`, guest
  agent over virtio-serial and EROFS image layers. Booted directly by QEMU,
  built for fast boot and snapshot/resume, versioned apart from cubed. Not
  used by the runner yet (docs/plans/2026-10-10-vm-base-and-image-layers.md).

A thread's tools run in its own QEMU VM, never as the runner account. The
guest is a sandbox for the agent's commands, files and network; the runner
host as a whole is not (QEMU runs as the runner account, hardened only by
`-sandbox on`). Never invent an optional legacy backend, a same-UID shell path
or a local execution fallback. One session has one writable owner; preserve
lifetime locking, stable invocation identity, epoch fencing and retained VM
disks.

## Development

Node ≥26, pnpm pinned in package.json, Rust pinned in rust-toolchain.toml.
`bash scripts/setup-dev.sh` bootstraps a Linux development account. Run
`pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`. New offline Node tests
belong in `scripts/test-offline.sh`. Runner, gateway and VM changes also need
`CUBE_TEST_VM_IMAGE=<debian-13-genericcloud.qcow2> CUBE_TEST_VM=required bash
scripts/test-node-transport.sh` on Linux with KVM; mocks are not runner
acceptance.
keel changes need `packages/keel/kernel/build.sh` when the kernel or its
fragments change, then `packages/keel/smoke/run.sh` and
`packages/keel/snapshot/test.py` for both architectures (KVM/HVF where
available; TCG is not acceptance for timing).
Inspect rendered UI at desktop/phone sizes for appearance changes; behavior
changes to the chat or transcript need a `pnpm test:browser` scenario.

`repos/` contains pinned upstream reference snapshots, not application code.
Use published package imports; do not modify upstream snapshots except for
explicit upgrades. Read `repos/effect/LLMS.md` before writing Effect code and use
the pinned v4 APIs. For Pi study the matching AgentHarness/session sources.
Upgrade consuming pins, lockfile and reference subtree together, update
`repos/README.md`, then run `pnpm check:references`.

## Guardrails

- Never push to main, tag, deploy or release without explicit authorization.
- Never commit credentials, private runner configuration, model auth or runtime
  state. For maintainer commits use Didrik A. Rognstad
  <3679075+dizk@users.noreply.github.com>.
- Never operate on other people's threads or shared data for tests. Use
  disposable state. A fresh schema does not authorize wiping a live installation.
- Keep cubed private: loopback, an authenticated proxy, or an explicit
  access-controlled private-network binding. It has no application-level user
  authentication; HTTP host validation does not replace network access controls.
- Call only the thread's VM a sandbox, and say what it covers: not QEMU or
  the runner host, not cubed's own processes (Pi, codemode's worker, Claude
  Code), and not where the guest may send data over HTTPS. Keep runner
  accounts separate from host/provider/Git/cloud credentials; real secrets
  never enter a guest, its seed or a runner (placeholders only).
- English in repository files; calm lowercase user copy and thread vocabulary.

Old registries are not migrated. The explicit reset workflow selects a new
`CUBED_STATE` directory; see DEVELOPING.md. Preserve Linux/macOS runner lifecycle,
retained operation evidence and backup quarantine when changing architecture.
