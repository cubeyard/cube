# Authorized thread-to-thread tasks

Status: journal foundation implemented; **not a usable messaging tool yet**.
The maintainer selected this as the next slice before file/repository transfer
and external-host acceptance. Those remain required for the full development loop.

## Implemented foundation

`packages/server/src/thread-tasks.ts` is an opt-in control-plane SQLite journal
against the registry schema. It is deliberately not constructed by cubed yet.
No HTTP API, Pi hook, model call, remote execution or new agent capability is
introduced. Tests use disposable real registry databases, never live threads.

- Operator-owned directed grants between existing, active threads in the same
  project. No implicit reverse/transitive permission or cross-project delivery.
- Immutable task ID and sender provenance; a sender-scoped request key chosen
  before acceptance deduplicates identical requests and rejects changed data.
- `accepted`: only the task record is durably stored, not queued execution.
- `delivery_unknown`: durable one-shot reservation before calling Pi. Even a
  crash before the actual call leaves uncertainty. Never reset or automatically
  redeliver. Read-only inspection does not reserve delivery.
- `delivered`: receiving integration explicitly acknowledged the handoff, not
  merely a successful socket write. A late acknowledgement resolves uncertainty.
- `completed`: recipient explicitly supplied its bounded result. Not inferred
  from a model turn ending, a terminal becoming quiet or a process exiting.
- SQLite FULL synchronous commits; competing connections cannot both reserve
  delivery. Restart never changes a reservation back to accepted.
- Task/result text is UTF-8, at most 16 KiB each; IDs/keys at most 128 bytes;
  at most 10,000 retained task records, no eviction that permits duplicate IDs.
- Explicit recipient progress after acknowledged delivery: 4 KiB per record,
  100 retained records per task, stable task-scoped request keys and sequences.
  Exact retries survive completion/restart; changed bodies conflict. New progress
  after completion is rejected. Participant-only read pages contain at most 20
  records with an exclusive sequence cursor. Progress is peer data, not proof of
  tests passing, a delivery acknowledgement, an automatic prompt or a result.
- Revocation/archive stop new acceptance and delivery. Participants can still
  inspect records; already delivered work can report a late result. Completion
  does not automatically prompt the originating thread.
- Retained records reference thread identities with restrictive foreign keys.
  Enabling this requires an explicit preflight before destructive thread removal;
  do not discover the constraint after deleting the environment. Archive remains
  the non-destructive option. This is one reason it is not wired into cubed yet.

The journal is not an authentication layer. Actor arguments must come from the
trusted control-plane thread capability; never let payloads claim a sender or
recipient identity. Grant/revoke and delivery reservation are internal/operator
operations, not agent APIs. Task text and results are peer task data, never user
or system authority, publication permission, or authorization to expand grants.

## Next implementation steps

1. Trace the pinned real Pi CLI and supported extension/SDK APIs. Preserve the
   interactive TUI, session persistence and tool-isolation audit. No PTY input
   automation, session JSONL rewriting or experimental internal imports.
2. Choose a receiving acknowledgement boundary that can honestly establish
   delivery. If Pi persistence cannot be proven, retain uncertainty; never claim
   exactly-once prompt execution. Handle restart and session changes explicitly.
3. Wire operator grants, deletion preflights and thread-scoped capabilities with
   provenance derived outside the agent sandbox. Expose permitted destinations
   only, bounded/paginated task inspection, and no access to another transcript.
4. Expose the implemented bounded, idempotent progress records and explicit
   result submission through scoped capabilities. A result may include test
   evidence, operation IDs and commit/tree identities, but is not permission to
   publish or proof of externally verified success.
5. Add real two-Pi-session delivery tests with no model calls first; separately
   test the model-driven delegation loop on disposable resources. Cover busy
   recipients, archive/revoke races, duplicate sends, lost acknowledgements,
   cubed/Pi restart and no duplicate prompts.

No automatic node wake, execution replay, file transfer or Git publishing belongs
in task acceptance. Node execution and conversation delivery are separate state
machines; receiving a task while a node is offline must not queue node commands.
