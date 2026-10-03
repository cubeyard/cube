# Cube architecture

## Ownership

- **pi-durable Harness + SQLite:** accepted prompts and their request IDs,
  transcript, model stream checkpoints, tool tasks/results, run status and
  resumption policy.
- **cubed:** projects, immutable runner admission, thread metadata, request
  allocation, access boundary, HTTP/SSE and activation of Pi's open operations.
  For a claude-code thread, the Claude Code child process and the thread record
  (accepted prompts, printed messages, session ID); Claude Code owns its session.
- **runner:** workspace execution and durable deduplication/result retention for
  commands. It cannot read Pi sessions or model credentials through the protocol.
- **web:** rendering and user actions, from the neutral thread event model
  only. SSE reconnect starts with a complete transcript; the browser is never a
  workflow owner.

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
before activation. Each thread is one pi-durable Harness over its own storage;
the thread transcript is the Harness's root conversation. The host submits the
first message under a fixed request ID; afterwards Pi owns execution. On startup
cubed opens nonarchived threads and resumes Pi's unfinished tasks. Followup
request IDs are Pi submission request IDs, committed atomically with admission,
so a repeated HTTP action does not append another turn; a busy thread rejects a
new prompt instead of queueing it. The product registry stores no model or tool
progress. The thread's runner binding and a random storage identity live in a
session-scoped Pi document, `cube.runner`; a changed binding refuses to open.

Cube opens pi-durable's `SqliteStorage` on its own `node:sqlite` connection in
WAL mode and sets and checks `synchronous=FULL` on every open. pi-durable has no
cross-process storage lock; the thread's workspace lease is that lock.

Pi's tools reach the runner only through the thread `Workspace`. `read`,
`write` and `edit` are pi-durable's own file tools over an `ExecutionEnv`
(`workspace-env.ts`) that maps the virtual root `/workspace` to workspace-relative
runner paths; a write after a read in the same call carries the read content's
`expectedSha`. `bash` is cube's own tool. Every mutation key is derived from the
storage identity and the Pi tool task ID, so a replayed task finds the same
runner operation: a repeated `exec.start` retrieves retained work; changed
arguments conflict. `read`, `write` and `bash` are replay-safe; `edit` is not and
is reported as interrupted after a crash.

`codemode` (`codemode.ts`) runs one model-written JavaScript script in
pi-codemode's QuickJS VM, a fresh worker per script whose only capabilities are
the same four tools. It is one pi-durable tool with replay `unsafe`: a script
interrupted by a crash is reported as possibly partially run and never rerun;
its running output names each nested call that had started. Nested calls run one
at a time in call order, and each reaches the Workspace under the codemode task
key plus its sequence number (`pi:<instance>:<task>:code:<n>`), so every nested
call has a stable identity. The host enforces strict limits modelled on cube's
earlier codemode: 64 KiB source, 64 MiB VM memory, a 15-minute wall deadline,
64 nested calls, 1 MiB arguments per call (both stop the script), 4 MiB per
nested result handed to the script and a 256 KiB final result, cut with a
notice. A mutating call stopped while running, or one whose runner outcome is
unknown, makes the result an error that lists it as uncertain; a call that does
not settle within 10 seconds of the script ending blocks the next script until
it does. Nothing is retried automatically. The worker is fault containment, not
a sandbox, and the runner stays trusted.

Stop aborts Pi's tasks and cancels a
running runner command; a host shutdown leaves the command running and the next
process reattaches to it. The runner never silently reexecutes Interrupted operations or evicts
IDs to create room. A lost response therefore does not imply a second effect.
Diagnostic runner CLI intents remain separate from Pi's production call path.
Runner protocol 2 adds paged command output, `exec.cancel` (process-group
SIGKILL), `fs.read`/`fs.write`/`fs.stat` beneath the workspace, idempotency keys
for writes and per-thread lease-epoch fencing of mutations. A protocol-1 runner
is incompatible and must be upgraded; see
[RUNNER.md](packages/node-transport/RUNNER.md).

Pi recovery is a durable task state machine, not complete-history replay. Partial
model responses can be interrupted and retried under Pi policy; a provider may
bill both attempts. SIGKILL tests are not proof of power-loss durability.

## Workspace and lease

`Workspace` (`packages/server/src/workspace.ts`) is the one contract for a
thread's workspace: `lease`, `exec`, `operation`, `cancel`, `readFile`,
`writeFile`, `stat`, `capabilities()` and `limits()`. `RunnerWorkspace`
implements it over the Iroh runner client; workspace semantics stay on the
runner and cubed only translates, checks capabilities and limits, and enforces
the lease. The HTTP routes under `/api/threads/:id/workspace` are a thin
transport over the same interface, and `HttpWorkspace` implements it again for
out-of-process agents. One contract suite runs against both.

Each thread has one writable owner, `pi` or `claude-code`, fixed for the thread.
The lease (`workspace-lease.ts`) has a random token, which is the authorization
for every lease-scoped call, the owner, a fencing epoch and, for remote holders,
a heartbeat deadline. While a lease is held, a dedicated SQLite connection keeps
a write transaction open on the thread's `lease.lock`; a competing process or
instance cannot take it, and process death releases it at once without stale PID
files. Pi holds the lease for its whole Harness lifetime. The epoch is the only
durable lease state: it never decreases and is at least the wall-clock time in
milliseconds, so it stays increasing even if the thread directory is lost. Every
runner mutation carries it, and the runner refuses an older epoch than the
newest it has seen for the thread.

Mutations carry a caller-chosen idempotency key, scoped to the runner binding
and hashed into the runner operation ID. A key already seen is never executed
again; the same key with a different request is `CONFLICT`. No shell fallback
exists: a runner lacking a workspace capability is incompatible.

## Thread event model

`thread-events.ts` defines what a thread shows, whatever agent runs it: a
`ThreadTranscript` with the thread's `agent`, the workspace's current writable
`owner`, a `status` (`idle`, `working`, `completed`, `failed`, `stopped`) and an
ordered list of events: user message, assistant text (with a reasoning flag),
tool call and tool result (paired by `callId`). An event still streaming carries
`final: false`: the in-flight model partial and a running tool's output.

`ThreadEvents` has the same interface in-process and over HTTP: `read()` and a
serialized, coalescing `watch()`. `PiThreadEvents` renders pi-durable's
conversation view (entries plus `pi.live`); `GET …/history` returns `read()` and
`GET …/stream` (`thread-events-http.ts`) sends one transcript per SSE frame and
ends the stream when the source closes. `HttpThreadEvents` is the client; it is
browser-safe and the web UI uses it directly. An agent adapter is the only code
that knows its agent's shapes; the UI never reads Pi messages.
`ClaudeThreadEvents` renders a claude-code thread into the same transcript.

## Claude Code threads

Claude Code is an alternative thread agent for one purpose: to use the person's
own Claude Max subscription through the unmodified `claude` binary and its own
login (`claude /login` or `claude setup-token`). Choosing a model under
"claude · max" at thread creation makes a `claude-code` thread; the agent is
fixed for the thread, and within it only Claude Code's own models (`opus`,
`sonnet`, `haiku`) can be chosen. Claude Code is not a provider in cube's model
settings, and Pi does not offer Anthropic's Claude Pro/Max OAuth login: Pi
reaches Anthropic models with an API key.

`ClaudeAgent` (`claude-agent.ts`) takes the thread's `claude-code` lease for its
lifetime and starts `claude -p --input-format stream-json --output-format
stream-json --verbose --include-partial-messages --plugin-dir
packages/claude-mod --model <model>` on the first prompt, in a stable per-thread
directory, with `--resume <session-id>` once Claude Code has reported a session.
Prompts go to stdin under their request ID (a repeated ID is accepted once), stop
is a stream-json `interrupt` control request with a kill after a grace period,
and a model change closes the idle child so the next prompt resumes with the new
`--model`. An idle child is closed after ten minutes. cubed never stores or
forwards Claude credentials and removes `ANTHROPIC_API_KEY` and
`ANTHROPIC_AUTH_TOKEN` from the child's environment, so the subscription is used
instead of API billing. `findClaude()` locates the binary (`CUBED_CLAUDE` names
it, or `off`); without one, claude · max is not offered.

The mod (`packages/claude-mod`) is a Claude Code plugin of function hooks. Its
`tool.call` hooks answer Bash, Read, Write and Edit from the thread Workspace,
keyed by `tool_use_id`, in each tool's own output shape; Edit is read, replace,
then a write conditional on the sha it read. It refuses background Bash,
`NotebookEdit`, worktrees, subagents with worktree or remote isolation and tools
that would act on the cubed host (Glob, Grep, LSP, Monitor, PowerShell), and its
`prompt.context` hook adds the workspace's `AGENTS.md` and `CLAUDE.md`. The mod
reaches cubed on a private Unix socket (`CUBED_STATE/run/workspace.sock`, mode
0600) that serves only workspace routes; the lease token cubed holds for the
child is the authorization. A Claude Code hook's own time is budgeted, so it
waits on a running command with the route's long poll (`?wait=`) instead of
sleeping. `HttpWorkspace` wraps the mod's portable client, so the shared
contract suite covers both.

Durability is weaker than Pi's, and the UI says so: Claude Code keeps its own
session but has no task checkpoints, so a turn cut off by a cubed restart is
marked failed and not continued. Workspace keys still keep the runner from
executing any tool call twice. Repository skills reach Claude Code only as text.

## Product state and limitations

`CUBED_STATE/registry.sqlite` contains projects, globally registered runners,
operator contact observations and retirement audit, thread metadata and creation
request keys. `CUBED_STATE/threads/<id>/pi.sqlite` is
the thread's pi-durable storage (`claude.sqlite` and the `claude/` working
directory for a claude-code thread); `threads/<id>/lease.sqlite` keeps the thread's lease epoch and
owner, and `lease.lock` is only held while a lease is. Registry v100/v101 receives the rollback-compatible global-pool extension in place; older execution stacks are
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
deduplication, and a claude · max thread through a fake `claude` that runs the
mod's tool functions over the workspace socket. `scripts/check-claude-mod.sh`
validates and tests the mod with the installed `claude` CLI without calling a
model; the real CLI is never started by tests. These use controlled models and disposable data, never live users.
Separate-machine Linux/macOS lifecycle and paid-model acceptance remain separate
release checks. The pinned reference snapshots are under `repos/`.
