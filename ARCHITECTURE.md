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

`CUBED_STATE/registry.sqlite` contains projects, globally registered runners,
operator contact observations and retirement audit, thread metadata and creation
request keys. `CUBED_STATE/threads/<id>/session` contains
Pi's databases. Registry v100/v101 receives the rollback-compatible global-pool extension in place; older execution stacks are
not migrated. See the reset workflow in README.

A runner has one permanent node/environment admission and belongs to the Cube
installation, not a project. It admits one active thread workspace at a time. Cubed
persists `available/allocating/busy/releasing/failed`; the runner journal persists
the physical allocation and reconciles interrupted transitions without deleting
the tree. Thread creation captures the checked project revision and each repository's
normalized URL, resolved branch and exact base OID. `workspace.allocate.v2` sends that
immutable plan to the authenticated runner, which creates `/workspace` plus reference
checkouts under `../repos`. The runner fetches only each declared branch, verifies the
supplied OID is an available commit, and checks out that immutable OID; it never
rediscovers the default branch or substitutes a newer tip. Git prompts and
command-running transports are disabled.
Projects without repositories receive a fresh empty workspace rather than the
installation's legacy template, preventing state carryover during project switches.
Archive releases logical capacity; checkouts still clean at every pinned OID are
removed, while changed, independently committed or transition-interrupted trees are
retained under runner state. Empty legacy project plans continue through the immutable
installation template so migrated evidence remains usable.

Registry allocation uses `BEGIN IMMEDIATE` and a conditional `available` update, so
two project requests cannot claim one runner. v100/v101 project bindings become
`legacyProjectId` audit metadata; runner IDs, node admission, thread rows, creation
keys and archived evidence are preserved. Numeric environment IDs need only be unique
inside their immutable node binding, so collisions across runners are preserved rather
than rewritten. Existing active threads keep their runner and pinned allocation.
Project deletion never owns or deletes a runner and remains blocked while any thread
history references the project. Runner contact is authenticated `node.status`
evidence. A failed latest check is `unreachable`; it becomes `stale` only after seven
continuous days without a successful check. Success clears that interval.
Retirement is installation-global and first reserves the runner against allocation.
Both reservation and commit read the global runner/thread allocation snapshot and
require no active allocation. A reachable runner must also report no active command
or workspace; an unreachable runner must be stale. Changed status or allocation fails
closed. The permanent tombstone removes global capacity while retaining immutable
identity, thread links, reason, probe evidence, runner journals, operation records and
retained workspaces.
The extension preserves the v101 runner column order and stores an idempotent marker;
an older rollback release can still open the registry. Its scheduler ignores newly
enrolled global runners rather than rebinding or deleting them.

The repository plan is the integration boundary for fresh-remote-default-branch work:
`GitService.prepareRepository` must resolve the remote branch and OID before allocation,
and future changes must keep emitting `resolvedBase` + `baseOid`. The scheduler does not
depend on unpublished branch-selection work and never asks a runner to rediscover a
moving default branch. If a force-push makes the pinned object unavailable when the
runner fetches the declared branch, allocation fails closed rather than using stale state.

The original `workspace.allocate` remains a metadata-free compatibility operation.
Cubed requires the separately advertised `workspace.allocate.v2` capability for new
global allocations, so an older runner fails with `UNSUPPORTED` before request bytes
or filesystem mutation. Upgrade runner binaries before relying on the global pool;
existing active work and retained evidence remain inspectable during a rolling upgrade.

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
