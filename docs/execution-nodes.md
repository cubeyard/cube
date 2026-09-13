# Control plane and execution nodes: local boundary

## Product contract (supersedes the single-host premise)

A thread owns exactly one environment (`cube.id`), permanently bound to one
logical node. Allocation is committed before provisioning. No relocation,
replacement environment, failover, ownership generation, or scheduler lease.
A missing environment is an error. Working elsewhere means a new thread.
Future snapshot sharing means explicit copying to a new thread, not migration.

Pi, sessions, credentials, model access, repository mirrors and policy belong to
the control plane. Workspace data and processes belong to the execution node.
Opening a conversation does not wake, provision, or probe its environment.
Loss of contact does not establish that a guest stopped, failed or disappeared.
Rejected environment work is not queued, and reconnect never replays it.
Possible delivery without confirmation is reported as `COMPLETION_UNKNOWN`
(or the existing bridge `ECODE_UNCERTAIN`); inspect before executing again.

**iroh is the selected control-to-node transport.** The released cubed path is
still the local adapter. The separate development implementation in
[`packages/node-transport`](../packages/node-transport/README.md) now includes real
QUIC and opt-in trusted host execution with a permanent binding/durable journal.
`packages/server/src/iroh-node.ts` connects directly through `@number0/iroh` in the
Node process, without a Rust/stdio intermediary. It is not yet enrolled/routed into
cubed's agent tools or acceptance-tested on an external machine. The protocol
must not require Tailscale, WireGuard, SSH, or another VPN. Browser traffic stays
HTTP(S)/WebSocket to the control plane. The existing restrictive loopback/trusted
Tailnet browser access boundary is unchanged; there is no new public gateway.

## Implemented locally

- Registry `execution_node` stores the logical local identity once;
  `environment_node` binds the existing environment ID. Threads reference it
  through their existing `cube_id`, not another node column. SQL triggers reject
  rebinding, identity changes and removal of live bindings; the unique thread
  index permits builders without a user thread. The additive migration adopts
  old local-only rows without moving workspaces or changing sessions or Git pins.
  Once the schema exists, missing identity/binding metadata fails startup rather
  than inventing another node. Copying this database to a different machine is
  **not** a supported node-move procedure.
- Thread, repository snapshots, environment binding and request-key association
  are one SQLite transaction. Request-key replay survives process/cache expiry
  for the lifetime of the thread; failed provisioning retains that association.
- `ExecutionNodes` chooses by stored binding with no local fallback.
  `LocalExecutionNodeClient` uses `CubeBackend` for status and physical wake/sleep,
  and opens a bounded portal stream. It records actual status observations with
  timestamps separately from transient contact (`unobserved`, `available`,
  `unavailable`). Incus 404 is missing, not loss of contact; other backend errors
  do not become `exists=false`. Mock state is still process-local and now reports
  absent instances as missing instead of inventing a stopped guest.
- Portal proxying consumes a `PortalConnector`; the production path receives an
  already resolved portal, not an address it must route to. The local adapter
  still routes to the bridge internally. Source-IP hairpin authorization stays
  before connection opening. A failed connection does not resubmit HTTP or an
  upgrade. Unavailable HTTP responses are bounded 503s without meta-refresh;
  holding pages never auto-refresh POSTs.
- Pi runs in `.agent-runtime/<thread>` under the trusted state root, with the
  existing session directory and isolation flags. Pi 0.85.1 otherwise restores
  the historical cwd from the session header; `pi-session-cwd.ts` is a narrow
  pinned-CLI preload using `SessionManager.open(..., cwdOverride)`. It does not
  rewrite session headers or replace the CLI/chat implementation. `/new` files
  still participate in newest-session reopening. Upgrade this shim with pi.
- File/bash/`!`/QuickJS operations retain guest workspace resolution. Managed
  local adapters must obtain an uncached, validated local binding authorization
  through cubed's environment-access bridge before underlying exec/file calls.
  Missing or mismatched node configuration fails closed. Built-in skill reads,
  repository metadata, GitHub reads, saved review inspection/reconciliation,
  control-plane lifecycle evidence and archiving are not globally
  disabled. Local workspace browser, Git, setup/wake/sleep/delete entries also
  check the bound node. Tool errors do not terminate the agent; the tool audit
  and project-trust denial remain unchanged.
- The thread summary/UI shows contact loss separately from the last confirmed
  environment observation. It leaves the terminal mounted. Workspace APIs
  return structured failures instead of silently showing an empty directory.

## Remaining host couplings / limits

The control plane **cannot be moved to another machine yet**:

1. Provisioning, templates/builders, network/CA/egress setup and lifecycle/service
   implementation remain local Incus/backend operations. They are not an RPC
   catalog. Service readiness still probes a guest IP locally.
2. Git seeding, safe bundle/review workflows, config reads and workspace file
   serving still use local host paths. Their entry guards do not make those
   paths remotely accessible. No network mount or workspace copy was added.
3. Pi still constructs local Incus/mock file/exec adapters, now explicitly gated
   by the registered local binding. Authorization is a preflight, not a promise
   that contact will survive the operation. Transport errors are propagated and
   ambiguous mutations are not retried. There is no general durable node-side
   operation journal/reconciliation protocol in this slice.
4. Local status checks observe the Incus API; they do not authenticate a remote
   machine. Logical node identity is not an endpoint key, and no enrollment,
   remote configuration, key rotation or remote provisioning has shipped.
5. Session files retain their existing control-plane storage paths. Runtime cwd
   isolation is distinct from relocating all persistent control-plane storage.

Local callbacks, AbortSignals and streams are in-process capabilities, **not**
serializable protocol fields. The small environment observation and IDs are
ordinary data. The bridge validates its response/binding at runtime; a future
wire implementation needs authenticated versioned framing and validation too.

Next vertical: the [host-node development loop](plans/host-node-development-loop.md)
over **real iroh**: authenticated contact, durable operations, usable exec/files
and minimal repository transfer, plus authorized control-plane thread messaging.
This supersedes the earlier portal-first ordering so further node development
can be driven from a thread. Portal streams and remote Incus lifecycle follow;
keep browser authorization and hairpin isolation intact when adding them. Do
not add a VPN or claim that a `CubeBackend` serialized wholesale is a node protocol.

## Evidence

`scripts/test-offline.sh` includes execution-node and environment-access suites:
legacy migration twice, SQL immutability, allocation rollback, persistent request
replay, offline status/entry failures with recorded side effects, missing vs
unavailable, real pi PTY startup with a missing historical workspace, local
connector HTTP rejection/reconnect, registered file/bash/`!`/QuickJS gates and
uncertain outcomes. Existing portal HTTP/WS, pi path/tool-audit, containment,
Git review and isolation suites remain regression gates.

These tests use disposable files, explicit disconnect doubles, mock execution
and loopback servers. They prove neither Incus integration nor iroh or macOS.
Real Incus lifecycle/portal/hairpin acceptance must run in an explicitly
disposable instance; never stop the development thread or mount the production
Incus socket to manufacture that evidence.
