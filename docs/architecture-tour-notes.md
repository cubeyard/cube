# Architecture tour notes

Notes and decisions collected during the guided architecture walkthrough.
These distinguish the current implementation from the intended direction;
they are not an implementation plan.

Keep unresolved questions for the end of the tour. All direction recorded here
remains revisable as further parts of the system are explored.

## Direction agreed during the tour

- The Incus environment and VM-based execution architecture are legacy.
- Runners are the execution architecture to develop further.
- Runners should manage native, platform-appropriate sandboxing on the platform
  where they run.
- The sandboxing technology is not decided. Do not treat Incus or any specific
  replacement as a requirement for the future runner architecture.

## Current implementation versus direction

- Current trusted runners execute commands as the daemon's Unix user and do not
  provide a sandbox boundary.
- Runner-managed sandboxing is the intended direction, not a capability already
  implemented.

## Tour progress

- First stop accepted: distinguish the browser, cubed and the agent runtime,
  and the environment that executes commands, subject to the legacy direction
  recorded above.
- Stops 2 and 3 covered the message and tool-call paths, with unresolved
  integration questions retained below.
- Stop 4 covered durable state and established durable execution as the desired
  direction.
- Current stop: failures and recovery. Open questions remain for discussion
  after this stop.

## Stop 2: a message reaches the agent (current implementation)

- The browser submits text to `POST /api/threads/:id/prompt`.
- Cubed records an agent run and starts a worker process for that run.
- The worker receives the prompt, finalized conversation history, and selected
  model. It creates an in-memory Pi session and calls `session.prompt()`.
- Cubed owns the durable conversation; the Pi session is disposable, rather
  than a permanently running agent process for each thread.
- This describes current behavior, not a newly agreed architectural constraint.

## Stop 2: agreed ownership and lifecycle direction

- A durable conversation does not require a persistent worker dedicated to it.
  Follow Pi's recommended integration and lifecycle model rather than treating
  Cube's current worker-per-run design as a requirement. A worker model is
  acceptable if that is Pi's recommendation; this recommendation has not yet
  been verified during the tour. Currently a worker is an OS process for one
  agent run, not a language-level thread or one process per model request.
- Cubed should coordinate work in response to requests and events, rather than
  implement the agent loop itself.
- Delegate model interaction and the model/tool iteration loop to the Pi SDK.
- Cube should focus on reliable remote calls, execution lifecycle and state,
  and streaming updates back to the user over HTTP, not building its own agent.
- Event-driven coordination does not imply that cubed exits while idle or that
  the active worker exits while waiting for a model or tool response.

## Stop 3: a tool call reaches the runner (current implementation)

- Pi's bash tool uses Cube's extension to route execution through the
  thread-scoped cubed HTTP endpoint, rather than executing on the worker host.
- Pi SDK currently runs in cubed's child worker process on the same host, not
  inside the cubed server process. The extension makes an actual HTTP fetch
  back to cubed. Worker input and agent events instead use process pipes.
- Cubed resolves the fixed runner binding; the call cannot select its own node.
- The extension orchestrates prepare, submit once, and read-only status polling.
  Cubed's adapter persists intent and dispatches to the runner over Iroh.
- The runner executes the command and retains its bounded result. The extension
  returns that result to Pi so the agent loop can continue.
- Command output on this path is delivered after completion, not streamed live.
  Streaming model text and streaming remote command output are distinct paths.

## Stop 4: durable state and ownership (current implementation)

- Cubed's SQLite registry holds conversations, agent runs, and runner bindings.
- Cubed also persists remote operation intents and sent markers as files, not
  in the runner's SQLite journal.
- Pi's worker session is in memory and receives finalized history from cubed.
- The runner's SQLite journal holds installation identity and operation
  requests/states/results, not conversation history.
- Project files live in the runner workspace, separate from either database.
- Durable history does not imply automatic resumption of an interrupted run.

## Stop 4: desired durable execution model

- The whole agent run should be a durable execution workflow inside the
  application: conceptually a small internal Restate/Temporal, not just a
  conversation log plus independent command journals.
- Include LLM requests and results, tool calls and results, and workflow
  progress so interrupted runs can resume using already persisted results.
- This is a desired capability, not a claim about the current implementation
  or a decision to use a particular engine, storage layout, or replay technique.
- Preserve the earlier goal of delegating agent behavior to Pi. How Pi can
  participate in resumable execution remains an integration question.
- External effects whose outcomes were not persisted still need idempotency,
  reconciliation, or an explicit unresolved state; durability alone cannot
  guarantee exactly-once effects in an external system.

## Stop 5: failures and recovery (current versus desired)

- Today, losing the runner connection does not cancel an accepted command.
  Its result can be inspected later using the saved operation ID if retained.
- On cubed restart, queued/running agent runs are marked failed rather than
  automatically resumed.
- On runner restart, Accepted/Running operations become Interrupted with
  unknown completion; the runner does not rerun them.
- The desired workflow should reuse persisted results and reconcile pending
  operations by identity before continuing, rather than treating every lost
  response as a reason to repeat an operation.
- Separate an unknown outcome from a known failure. Automatic resumption must
  not turn uncertain external side effects into unconditional retries.

## Stop 5: scope and priority agreed during discussion

- The essential model is to persist an action and its result so execution is
  traceable and can resume or retry. Keep this model central rather than
  designing every failure edge case during the tour.
- Runner calls should carry stable idempotency keys. Repeated calls should
  return a durably stored result when available instead of repeating execution.
- Retry and reconciliation behavior is action-specific and will be decided
  when designing each call, not through a blanket prohibition on retries.
- The agent can help inspect remote state and recover from errors or partially
  completed work. This is a recovery mechanism, not an exactly-once guarantee.
- Defer detailed unknown-outcome policies; they should not block agreement on
  the action/result workflow model.

## Reference check: Restate / Temporal core

- Checked the official [Restate key concepts](https://docs.restate.dev/foundations/key-concepts)
  and [Temporal workflow execution](https://docs.temporal.io/workflow-execution)
  documentation during the tour.
- The proposed action/result model matches their core when it also includes
  durable workflow progress and automatic recovery: persist execution history,
  reuse recorded results, and resume pending work after failure.
- A log or result cache alone is not durable execution. The runtime must use
  that history to reconstruct progress and drive the workflow forward.
- Both systems use journal/history replay. An internal lightweight design may
  instead persist explicit workflow state; the recovery model is not selected.
- "Restate/Temporal light" describes the intended core semantics, not feature
  parity or a claim that Cube already implements them.

## Pi verification: pinned version 0.85.1

- `pnpm check:references` confirmed Cube's installed coding-agent dependency and
  reference subtree match version 0.85.1. Findings below were checked against
  that subtree, not only upstream main.
- Cube currently calls `createAgentSession` with `SessionManager.inMemory` in
  `packages/server/src/agent-worker.ts`. It does not use the durable harness.
- Pi's `pi-agent-core` exports `AgentHarness`, a durable agent runtime already
  present in this version. Its implementation persists operation state, model
  intent/settlement and tool outcomes, and resumes from explicit stored state
  rather than replaying a Temporal-style history.
- `AgentHarness.create` restores a session and reports open operations. The
  host schedules `drive` calls; Pi retains the agent loop and recovery logic.
- Tools receive a stable `invocationId` and durable invocation memos, suitable
  for connecting retries to runner operation identities. Recovery follows
  tool-specific `safe`/`never` replay policy.
- The SDK documentation favors direct embedding for same-process Node use;
  process isolation is a reason to choose RPC. No per-prompt OS worker
  requirement was found. The harness requires one writable session owner,
  which Cube must enforce.
- This substantially overlaps the desired internal durable engine: evaluate
  using it before building another agent workflow engine. Host scheduling,
  runner execution, UI transport and ownership remain Cube responsibilities.
- It is not a drop-in replacement for Cube's existing extension/session path.
  The harness documents incomplete areas (including `watchSession`), does not
  resume an interrupted provider stream, and is not a permanent audit log of
  every replaced operation-state value. Integration and acceptance testing
  remain necessary; no runtime recovery test was performed during this review.
- Evidence: `repos/pi/packages/agent/docs/harness.md` sections 0.1–0.9;
  `src/harness/runtime/harness.ts`, `runtime/drive.ts`, `runtime/drive/tools.ts`
  and `src/harness/types.ts` under that package; coding-agent `docs/sdk.md`
  section "RPC Mode Alternative".

## Orb spike: process recovery verified

- The disposable spike has been removed. Current integration checks run with
  `bash scripts/test-node-transport.sh`; see `ARCHITECTURE.md` for their scope.
- Four real SIGKILL/restart scenarios pass against published Pi 0.85.1:
  accepted-but-not-started work, tool effect committed before result delivery,
  tool result settled before the next model request, and partial model output.
- Pi reuses settled results; an interrupted replay-safe tool receives the same
  invocation ID and returns its cached result. The test observes two attempts
  but one effect in the lost-result case.
- The partial model response survives as a committed prefix; Pi records an
  interrupted response and retries according to policy, then completes.
- A loopback HTTP client receives a restored lane snapshot and subsequent SSE
  text/events. Final transcript and operation result survive another reopen.
- The test host embeds Pi in-process. Its parent only drives tests and kills
  processes. No separate production worker requirement follows from this.
- No real LLM, remote runner, Cube UI, or sandbox was involved. Pi's JSONL
  adapter does not explicitly fsync these appends; process recovery is proven,
  power-loss durability is not. Production storage remains a decision.
- Recommendation: use Pi's durable runtime for the agent loop; next validate
  a harness-native tool against the actual runner transport.

## Storage integration: replace JSONL at the Session boundary

- Pi 0.85.1 publishes `@earendil-works/pi-session-backend-sqlite-node`.
  Its `SqliteSessionRepo` can replace `JsonlSessionRepo`; the resulting Session
  is passed to `AgentHarness.create` without changing the agent loop.
- Prefer this existing backend before writing a custom adapter. For a custom
  store, implement the exported `Storage` interface and pass it to
  `StorageBackedSession(metadata, storage)`. `commit(writes)` must atomically
  persist the whole write batch, not independently mirror emitted events.
- SQLite supports per-session files or a shared container via `databasePath`.
  Physical layout remains open; keep Pi's execution-state ownership distinct
  from Cube's project/runner registry rather than duplicating workflow state.
- The shipped SQLite adapter enables WAL and uses BEGIN IMMEDIATE for writes,
  but does not explicitly set synchronous. Configure/verify FULL on writable
  connections through the database factory for the intended durability policy.
- The spike now uses the published SQLite adapter instead of JSONL, with one
  database per session and explicit FULL synchronous on create/reopen. The same
  four SIGKILL/recovery tests pass, including restored HTTP/SSE state and stable
  tool IDs. Additional checks verify WAL mode, database integrity, and no JSONL
  files. Typecheck also passes. Actual power-loss testing remains out of scope.
- No custom Pi storage schema or adapter was added. The separate test effect
  cache remains because it models runner-side idempotency, not Pi's workflow.

## Implementation mandate after the tour

The user has authorized starting the implementation in a new thread. This is
an architectural replacement, not an additional optional backend.

- Build the execution core on Pi AgentHarness, SQLite, and runners. Pi owns the
  agent loop and its durable execution state. Cubed owns the product, access,
  scheduling/recovery activation, and runner communication.
- Remove all VM/Incus-specific implementation: VM images/builds, QEMU, the
  VM launcher/install/upgrade/deploy path, Incus provisioning/network/storage,
  and APIs, states, tests, and documentation that exist only for that stack.
  Do not preserve it as a fallback or compatibility architecture.
- Preserve useful product capabilities such as the web UI, projects, model
  authentication, and runner transport where they still serve the new design.
  Their existing implementation is not a constraint if it depends on legacy.
- Runners will manage native platform-appropriate sandboxing. The technology
  remains undecided; do not silently select one or call trusted execution a
  sandbox. The initial integration can expose that limitation honestly.
- First map what to keep, replace, and delete, then implement reviewable stages
  toward a working runner-based thread and removal of the legacy core. Do not
  stop at another planning document or start a fresh general architecture tour.
- The spike is disposable evidence, not a template that must be retained. Its
  useful conclusions are Pi-owned recovery, stable tool identities, SQLite
  storage injection, and lane snapshot/event delivery. No further mock-only
  spike is required before proceeding with integration.
- Keep explanations concise and defer action-specific retry edge cases until
  implementing the relevant call. No external deployment, push, or release has
  been authorized. Removing code does not authorize deleting existing user data.

## Open questions to revisit

- Decide the host lifecycle around Pi's durable harness and single-writer rule.
- Reassess the separate worker process and HTTP callback boundary versus an
  in-process SDK integration. The current boundary is not an agreed requirement.
- Revisit remote command output streaming versus current polling and final output.
- Evaluate migrating Cube's tools/extensions and conversation storage to the
  durable harness without duplicating its execution state or agent loop.
- Define recovery for partial streams and external operations with unknown
  outcomes, and the ownership boundary between workflow and runner journals.
