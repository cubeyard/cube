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
and its release machinery have been removed. The current cubed-only release path
is described below and does not provision or update runners.

## cubed process lifecycle and updates

A managed installation starts a stable foreground supervisor, which owns one
cubed child and an exclusive installation lock. This is the direct execution
contract; optional systemd-user and launchd-user profiles only invoke the same
launcher. The supervisor passes a private capability over a mode-0600 local Unix
socket, plus a lifeline descriptor that makes cubed exit if the supervisor dies.
The HTTP process can request lifecycle actions but never receives signing keys or
filesystem paths, and a source checkout has no update capability.

Signed, platform-specific manifests bind the version, commit, artifact SHA-256,
size, supervisor floor and state-schema rollback contract. The supervisor stages
an immutable release, rejects unsafe archive paths and escaping symlinks, runs the
candidate's offline self-check, drains cubed, then atomically swaps `current` and
retains `previous`. Readiness checks require the signed version and commit, followed
by a probation interval. Startup recovery and failed readiness restore `previous`.
State and credentials live outside release directories and are never copied or
migrated by the updater. Schema 100 is currently accepted only by releases that
declare exact, rollback-safe schema 100 compatibility.

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
the tree. New Git repositories fetch the primary repository's checked branch
into a runner-owned bare control repository, journal the remote/ref/exact OID,
and create detached worktrees from that OID. The template branch, HEAD, index,
and working tree are not used as the base or mutated. Fetch/auth/network errors
fail closed; there is no stale-template fallback. Non-Git templates use a copy
fallback. Archive releases logical capacity; clean Git worktrees still at
their journaled base OID are removed, while changed or independently committed
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
