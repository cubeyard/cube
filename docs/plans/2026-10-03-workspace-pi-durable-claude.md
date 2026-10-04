# Workspace contract, pi-durable and Claude Code (Max)

Status: approved by the maintainer on 2026-10-03; implemented on branch
`feat/workspace-pi-durable-claude` as one PR.

## Goals

- One contract for a thread's workspace, `Workspace`, end to end: runner →
  cubed → agents.
- Move Pi to pi-durable 1.0.1 and use Pi's own codemode.
- Claude Code as an alternative thread agent whose only purpose is to use the
  maintainer's own Claude Max subscription within Anthropic's terms ("if we could
  do it in Pi we would"). Keep Claude-specific surface minimal.
- One thread experience in the browser regardless of agent.

## Principles

- Same interface in-process and over HTTP. Pi inside cubed calls `Workspace`
  directly; the HTTP routes are only a transport over the same interface;
  `HttpWorkspace` is a client implementing the same interface for Claude Code.
- Workspace semantics live on the runner. cubed translates, checks
  capabilities and enforces the lease; it has no file logic.
- One writable owner per thread (`pi` or `claude-code`) through a lease. The
  agent is chosen at thread creation and is fixed for the thread.
- Every mutating operation carries an idempotency key; a key already seen is
  never executed again (same key + different request → `CONFLICT`).
- No shell fallback and no extra backend. A runner lacking the required
  capabilities is incompatible and must be upgraded.
- Runners remain trusted, not sandboxes. Never call them sandboxed.

## Step 0 — remove JEV memory entirely

Remove the `recall` tool, `jev-memory.ts`, `jev-settings.ts`, `/api/jev`, the
web settings, tests (`jev-memory-test.ts`, its line in
`scripts/test-offline.sh`, fixtures) and every mention in README, DESIGN,
DEVELOPING and SECURITY.

## Step 1 — Workspace end to end

Runner (`packages/node-transport`, protocol version 2, one capability per
operation, limits advertised in `node.hello`):

| Operation | Notes |
|---|---|
| `exec.start` | exists; longer timeout than 60 s (advertised limit) |
| `operation.get` | output cursor, paged output beyond 8 KiB |
| `exec.cancel` | real cancellation: SIGKILL the process group; wired to stop |
| `fs.read` | offset/limit, `openat2(RESOLVE_BENEATH)` |
| `fs.write` | `expectedSha`, atomic temp file + rename, idempotency key |
| `fs.stat` | |

Lease epoch as a fence: the runner rejects mutating calls carrying an older
epoch than the newest it has seen for the thread.

cubed (`packages/server`):

- `Workspace` interface: `lease`, `exec`, `operation`, `cancel`, `readFile`,
  `writeFile`, `stat`, `capabilities()`, `limits()`.
- `RunnerWorkspace` over `IrohExecutionNodeClient`; the key becomes the
  runner operation id as `resumeExec` does today.
- The lease lives in cubed and replaces the `owner.sqlite` lock in
  `durable-agent.ts` (token, heartbeat, owner, epoch).
- HTTP: `POST/DELETE …/workspace/lease`, `GET …/workspace` (capabilities and
  limits), `POST …/exec`, `GET …/operations/:key`, `POST …/operations/:key/cancel`,
  `GET/PUT …/file`, `GET …/stat`. The lease token is the authorization.
- `HttpWorkspace` client.

Verification: one contract suite runs against `RunnerWorkspace` and against
`HttpWorkspace` → routes → `RunnerWorkspace` (lease conflict, repeated key,
`expectedSha` conflict, cancel, limits, paths outside the workspace);
`scripts/test-node-transport.sh` with real Iroh and SIGKILL boundaries.

## Step 2 — Pi on pi-durable 1.0.1

- Upgrade `@earendil-works/pi-ai`, `pi-coding-agent` (and `pi-agent-core` only if
  still needed) to 1.0.1, add `@earendil-works/pi-durable@1.0.1` and
  `@earendil-works/chord`, remove `pi-session-backend-sqlite-node`. Exact pins.
- `Harness.open` with cubed's own `DatabaseSync` (`synchronous=FULL`) →
  `SqliteStorage`.
- Lanes → conversations; the `cube.runner` binding → a `defineDoc`.
- Tools: an `ExecutionEnv` over `Workspace` for `read`/`write`/`edit`
  (`CodingTools`); cube's own `bash` keyed by `api.taskId` (pi-durable's
  `Shell.exec` gets no task id).
- Pi takes the lease when it opens a conversation.
- `repos/pi` subtree to `v1.0.1`; update `repos/README.md`; `pnpm check:references`.
- Fresh `CUBED_STATE` via the reset workflow in DEVELOPING.md; no migration.

## Step 3 — codemode

`pi-codemode` as one tool with `replay: "unsafe"`. Nested calls go to
`Workspace` with key `taskId + sequence` so every nested call has a stable
identity. Strict limits taken from cube's earlier codemode (source size,
memory, stack, call count, response sizes) and an honest uncertain-outcome
result.

## Step 4 — neutral thread event model

User message, assistant text, tool call and result, status, owner and agent.
Same interface in-process and over SSE. Pi adapter first; the UI reads only the
model.

## Step 5 — Claude Code (variant 1 only)

- UI: "claude · max" is a choice at thread creation; within the thread the
  Claude model can change (`--model`).
- cubed spawns `claude -p --input-format stream-json --output-format
  stream-json --plugin-dir <cube mod>`. Prompts on stdin, events through a
  Claude adapter into the event model, stop as an interrupt, `--resume
  <session-id>` after a crash.
- The mod (Claude Code function hooks): Bash/Read/Write/Edit → `HttpWorkspace`
  keyed by `tool_use_id` (Edit = read, replace, write with `expectedSha`); deny
  background Bash, `NotebookEdit`, `EnterWorktree` and subagents with worktree or
  remote isolation; `prompt.context` loads `AGENTS.md`/`CLAUDE.md` from the runner.
- Auth: the unmodified `claude` binary with the user's own Max login
  (`claude /login` or `claude setup-token`). cubed never stores or forwards
  Claude tokens, spawns the child without `ANTHROPIC_API_KEY` so the Max quota is
  used, and Claude Code is not added to cube's provider settings.
- Show weaker durability than Pi honestly in the UI (no task checkpoints; keys
  still prevent re-executing a tool call).

## Out of scope

Attach/mirroring of a terminal Claude Code, `/cube attach`, status line,
pi-server CBOR attach, native sandboxing, reporting installed runner programs.

## Risks and open points

- pi-durable is experimental; pin exactly.
- Repository skills are only injected as text for Claude Code.
- Check whether cube's provider settings expose Pi's Anthropic Pro/Max OAuth
  login; if so remove it (Pi threads use an API key for Anthropic models).
- Runners must be upgraded to protocol 2.
- Not yet verified: that hooks see subagent tool calls.
