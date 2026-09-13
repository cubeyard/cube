# Host-node development loop

Status: in progress; full development-loop acceptance is not complete.
The standalone [iroh hello probe](../../packages/node-transport/README.md)
implements real loopback transport and peer checks only. Host exec, durable
operations and thread communication are still outstanding.

## Outcome

An explicitly authorized development thread can receive a task from another
thread, edit a repository and run tests on a real host execution node, and
return progress and results to the originating thread. This should provide the
bootstrap path for developing further node support, and later a repeatable
regression-test harness.

This prioritizes usable exec/files and thread communication over portal-first
transport work. The permanent-binding and failure contracts in
[execution-nodes.md](../execution-nodes.md) still apply. The existing local
adapter is the starting point, not proof of remote execution.

## First delivery

1. Real iroh peer authentication, versioned bounded framing, explicit enrollment
   and environment authorization. Logical node IDs are not peer keys.
2. An opt-in `host` profile: permanent environment binding, persistent workspace,
   minimal repository seed/transfer, status, exec/output/cancel, and file IO.
   It executes directly as a dedicated unprivileged OS account, not through
   Incus. Host workspaces are organizational boundaries, not sandboxes. Keep
   control-plane credentials and sessions inaccessible to this account.
3. Durable operation IDs and request hashes before dispatch; Accepted means
   durable registration. Disconnect and restart cannot silently rerun work.
   Reconcile ambiguous results; absence of a journal record alone is not a
   blanket authorization to repeat a possibly delivered mutation.
4. Route the existing agent exec/file tools through the bound node; no fallback
   to control-plane paths. Pi, model access, sessions and publication remain on
   the control plane. Include enough repository transfer for an actual edit /
   test / return-result loop, not merely a remote shell demonstration.
5. Control-plane thread messaging with explicit permitted destinations, sender
   provenance, stable message IDs, task correlation, bounded progress/results,
   and distinct accepted/delivered/completed states. Peer messages are task data,
   not elevated user instructions. No unrestricted access to other threads.

Unsupported host-profile features must return UNSUPPORTED rather than simulate
Incus behavior. In particular, do not claim container isolation, enforced guest
egress policy, image templates, or machine sleep. Removal must never delete an
arbitrary host path. Defer remote Incus provisioning, portals and general fleet
management until this development loop works.

## Pi integration investigation

The pinned reference contains
`repos/pi/packages/coding-agent/src/experimental/services/agent-controller.ts`
and its provider. It exposes prompt, steer, followUp, nextRun and abort through
an experimental worker-owned AgentLane facade. This is a candidate reference,
not evidence that Cube's current real-CLI process exposes that service.

Before choosing an adapter, read the pinned extension / SDK / RPC documentation
and trace Cube's actual CLI startup path. Prefer a supported pi integration;
keep the existing TUI and session semantics. Do not automate PTY keystrokes,
rewrite live session JSONL, import experimental internals without an explicit
compatibility decision, or replace the agent loop to obtain messaging.

Thread delivery and node execution have separate state machines: a task can be
delivered while its node is unavailable, but rejected environment work must not
be silently queued for reconnection. Delivery uncertainty at the pi boundary
must not result in automatic duplicate prompts.

## Acceptance scenario

Use newly created, explicitly disposable development resources, not an existing
shared thread or the node process servicing the test driver.

- Start the host node separately from the control plane and authorize its peer.
- Allocate a new thread/environment with an immutable binding to that node.
- From an authorized originating thread, send a small repository-edit task.
- The target thread reads and edits a file through node tools, runs a real test,
  and reports the result with task ID, commit/tree identity and operation IDs.
- Prove wrong peers, wrong environments and unauthorized thread destinations are
  denied before side effects.
- Disconnect during exec and restart the node: retain the binding, expose the
  real or uncertain outcome, and never execute the task again automatically.
- Reopen the conversation while the node is unavailable; history and messaging
  remain usable without waking or probing the environment as a side effect.
- Preserve the ordinary pi TUI and existing tool isolation regression gates.

Later, turn this scenario into a repeatable regression runner with per-run
workspaces, bounded deadlines, machine-readable artifacts and explicit cleanup.
Start with deterministic exec/file/transport tests; keep model-driven acceptance
separate so provider nondeterminism is not confused with protocol failure.
