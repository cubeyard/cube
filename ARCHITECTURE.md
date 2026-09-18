# Cube architecture

## Ownership

- **Pi AgentHarness + SQLite:** accepted prompts, transcript, model stream
  checkpoints, tool invocations/results, operation status and resumption policy.
- **cubed:** projects, immutable runner admission, thread metadata, request
  allocation, access boundary, HTTP/SSE and activation of Pi's open operations.
- **runner:** workspace execution and durable deduplication/result retention for
  commands. It cannot read Pi sessions or model credentials through the protocol.
- **web:** rendering and user actions. SSE reconnect starts with a complete Pi
  snapshot; the browser is never a workflow owner.

There is one execution core, in process. No worker transcript hydration, second
agent-run journal or fallback backend. The old virtual-machine/container stack
and its installation/release machinery have been removed.

## Action, result, resume

Thread allocation and its first message are committed in the product registry
before activation. The host accepts that first message into an empty Pi lane;
afterwards Pi owns execution. On startup cubed opens nonarchived threads and
drives Pi's current operations. Followup request IDs are stored in their Pi user
messages, atomically with admission, so a repeated HTTP action does not append
another turn. The product registry stores no model or tool progress.

The published `@earendil-works/pi-session-backend-sqlite-node` backend uses WAL.
Cube sets and checks `synchronous=FULL` on creation and reopening. A separate
SQLite connection holds a lifetime write lock for each session owner. It stores
no execution state. Process death releases the lock; competing writers fail.

Pi's stable session/invocation identity maps deterministically to an Iroh runner
operation ID. A repeated `exec.start` retrieves retained work; changed arguments
conflict. The runner never silently reexecutes Interrupted operations or evicts
IDs to create room. A lost response therefore does not imply a second effect.
Diagnostic runner CLI intents remain separate from Pi's production call path.

Pi recovery is a durable state machine, not complete-history replay. Partial
model responses can be interrupted and retried under Pi policy; a provider may
bill both attempts. SIGKILL tests are not proof of power-loss durability.

## Product state and limitations

`CUBED_STATE/registry.sqlite` contains projects, registered runners, thread
metadata and creation request keys. `CUBED_STATE/threads/<id>/session` contains
Pi's databases. Registry v100 is upgraded in place; older execution stacks are
not migrated. See the reset workflow in README.

A runner has one permanent node/environment admission and one operator-prepared
repository template. It admits one active thread workspace at a time. Cubed
persists `available/allocating/busy/releasing/failed`; the runner journal persists
the physical allocation and reconciles interrupted transitions without deleting
the tree. New Git repositories use detached worktrees. Non-Git templates use a
copy fallback. Archive releases logical capacity; clean Git worktrees still at
the template HEAD are removed, while changed or independently committed
worktrees and fallback copies are retained under runner state.
Registry v100 is upgraded in place; existing bound threads continue on their
original workspace. There is no relocation, automatic remote provisioning or
implicit local execution.

These directories prevent active threads from colliding by default; they do not
constrain an absolute path or a command running as the runner UID. Current
Linux/macOS runners are trusted same-account execution, **not sandboxes**.
Platform-specific sandbox technology remains undecided. The supported operation
is bounded shell execution; remote file transfer, portals and authenticated Git
mutation are not implemented. Keep host Git/model credentials out of runner
accounts. Browser access is loopback, an access-controlled private network, or
an authenticated private proxy; Iroh authenticates runner communication, not
browser users.

## Verification

`scripts/test-node-transport.sh` runs Rust checks and actual Node/Iroh/runner
integration. `smoke-durable-agent.ts` covers four SIGKILL boundaries; `smoke-product.ts`
covers ordinary API creation, startup activation, streaming/reconnect and prompt
deduplication. These use controlled models and disposable data, never live users.
Separate-machine Linux/macOS lifecycle and paid-model acceptance remain separate
release checks. The pinned reference snapshots are under `repos/`.
