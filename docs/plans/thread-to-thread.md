# Authorized thread-to-thread tasks

Status: smallest production slice implemented.

Cubed and its SQLite registry own every identity and transition. A Pi process is
only a replaceable worker hydrated from the recipient's Cube-owned transcript.
There is no terminal-session authority and no worker-to-worker channel.

## State and acknowledgement semantics

- `accepted`: outbound intent is committed and bounded, but no recipient turn
  exists. This is the only state cubed may resume after restart.
- `delivered`: one recipient `agent_run` and its peer-authored user transcript
  message were committed atomically with the transition. This is the durable
  acknowledgement; it does not claim Pi started or finished.
- `completed`: the worker emitted its protocol completion and the final bounded
  assistant response was committed atomically with the completed run.
- `failed`: terminal. Delivery authorization disappeared, the worker failed,
  output exceeded the bound, or restart made the outcome uncertain.
- `cancelled`: terminal sender cancellation. A delivered worker is interrupted;
  no replacement is started.

On startup, cubed marks every delivered task whose run was queued/running as
failed with an explicit unknown-outcome/no-replay error. Reconciliation only
reads prior state and records that terminal conclusion. It never dispatches the
same delivered turn again. Accepted intents are safe to dequeue because they
have never entered a recipient transcript or worker.

## Authority and bounds

Operator-owned grants are directed, same-project, non-transitive and non-reverse.
The agent can list only its active granted destinations and can send, inspect or
cancel only through its own thread-scoped capability. Sender identity always
comes from `CUBE_THREAD_ID` and the route, never request data. Peer text and
responses are untrusted data and cannot create grants or expand host/node access.

Task bodies and results are valid UTF-8 capped at 16 KiB. Keys and identities are
128 bytes; a sender may create 30 tasks/minute, a recipient may retain 32 active
tasks, the journal retains at most 10,000 immutable request identities, and reads
return the newest 50 participant records. Task workers are serialized with every
other run in the recipient conversation. Retained task identities deliberately
block destructive thread deletion; archive is the safe lifecycle operation.

Operator grant example (cubed's trusted loopback/Tailnet boundary):

```sh
curl -sS -X POST localhost:7777/api/thread-task-grants \
  -H 'content-type: application/json' \
  -d '{"sender":"<source-thread>","recipient":"<target-thread>"}'
```

The agent surface is `cube.tasks.destinations/send/get/list/cancel`. Results are
reported through task status and the web task bank; completion does not
automatically prompt the sender.
