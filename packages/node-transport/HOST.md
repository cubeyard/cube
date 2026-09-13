# Trusted host execution bootstrap

Development-only, Linux-only, one permanently bound environment, loopback iroh.
This is a real executor with a durable journal, but is **not yet connected to
cubed, thread tools or project provisioning, or built as a release binary**.

## Trust boundary

`host-serve` is explicit opt-in. Use a dedicated unprivileged development account
with **no control-plane, provider or GitHub credentials**, on a disposable machine
or inside a development sandbox. Root is refused. The host daemon and executed
commands run as that same account. There is no container, filesystem isolation,
per-environment UID, egress enforcement, or protection of the journal/transport
keys against a hostile command with that UID. SQL guards prevent accidental
rebinding in normal code paths, not arbitrary local tampering.

The caller is one enrolled control peer; the node accepts work for exactly its
persisted environment ID. It authenticates the peer before reading application
data, and requires hello on that same connection before an environment request.
The client verifies both the pinned peer key and expected logical node ID before
sending a command. No repository or agent tool can enroll a host through cubed
in this slice; only the operator's local CLI creates this installation.

## Try it

Run from the repository after setup, using a fresh disposable directory:

```sh
cargo build --locked -j 2 -p cube-node-transport
bin="$PWD/target/debug/cube-node-transport"
scratch=$(mktemp -d)
mkdir "$scratch/workspace"
control_peer=$("$bin" keygen --key "$scratch/control.key" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).peerId')
node_peer=$("$bin" keygen --key "$scratch/node.key" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).peerId')
"$bin" host-init --key "$scratch/node.key" --state "$scratch/state" \
  --workspace "$scratch/workspace" --allow-peer "$control_peer" \
  --node-id node-development --thread-id thread-development --env 1
"$bin" prepare-exec --key "$scratch/control.key" --intent "$scratch/task.json" \
  --peer "$node_peer" --expect-node node-development --env 1 \
  --command 'printf once >> count; printf hello' --timeout-ms 1000
"$bin" host-serve --key "$scratch/node.key" --state "$scratch/state"
```

The server prints one ready JSON line with its public peer ID, logical node ID
and bound address. In another terminal, restore `bin` and `scratch` to those
same paths and use that address:

```sh
"$bin" submit --key "$scratch/control.key" --intent "$scratch/task.json" \
  --address 127.0.0.1:PORT
"$bin" operation --key "$scratch/control.key" --intent "$scratch/task.json" \
  --address 127.0.0.1:PORT
```

Submission returns `Accepted { operationId }`, not the command result. Poll
`operation` for the result. Output is a JSON byte array (binary-safe), not a
UTF-8 assumption. `Succeeded` means execution produced a confirmed result; an
exit code of 7 is still an execution result, not a successful user task.
A second `submit` of that intent is refused locally. Ctrl-C closes the endpoint
and waits for accepted work to settle within its execution deadline; client
closure/disconnection does not cancel work. A hard daemon kill instead requires
reconciliation after restart. Never remove an intent's `.sent` marker to retry.

## Permanent binding and durable operations

- `host-init` requires a NEW private state directory and an existing workspace.
  It records thread/environment/logical-node identity, the node peer key and
  allowed control peer, plus the workspace's canonical path and device/inode.
  State must be outside the workspace. This is local adoption, not an RPC for
  reserve/provision, and does not import or move a thread's workspace.
- `host-serve` only opens existing state. Wrong keys, missing/corrupt metadata,
  missing journal or owner-lock files and an unsupported schema fail startup.
  There is no automatic initialization, rebinding or key replacement.
- A kernel-released file lock gives one process journal ownership. It is not a
  distributed scheduler lease. SQLite uses FULL synchronous durability and a
  rollback journal. Don't copy, unlink or edit the state of a running node.
- Operation IDs are node-wide, immutable and retained for the installation's
  lifetime. Canonical typed request JSON includes method, permanent binding,
  command, cwd, timeout and output limit; a SHA-256 hash and the exact request
  bytes are both compared. Same ID/content returns the existing operation;
  changed content is `CONFLICT`. There is no automatic operation expiry.
- `Accepted` is committed before dispatch; `Running` before spawn. Completion
  and bounded output are persisted before readers observe `Succeeded`.
  One command may run at a time. Busy nodes and journals with 10,000 records
  reject NEW work with `CAPACITY_EXCEEDED`; they never enqueue it. Replays of
  existing IDs still resolve at capacity.
- On exclusive startup, unfinished `Accepted`/`Running` records become
  `Interrupted { completionUnknown: true }`, never a runnable queue. A command
  may have completed side effects, or its descendants may still be alive.
  Restart never signals stored PIDs or reruns these records. There is no
  automatic remediation API or claim of exactly-once completion.
- `operation.get` remains usable after workspace loss. `Unknown` means no saved
  record, **not permission to repeat a possibly delivered mutation**. Same-ID
  deduplication prevents reexecution only while the journal is retained intact.
- The CLI persists an immutable intent with operation ID and both peer IDs, then
  fsyncs a create-only consumed marker before any network dispatch. Even failed
  dialing leaves it consumed. After possible delivery without a valid response,
  the client reports `OUTCOME_UNKNOWN`, with operation ID and
  `completionUnknown: true`. It never retries. Use `operation` to inspect.

## Wire subset and execution limits

The [base framing](README.md) now permits two bidirectional streams per
connection: successful hello, then one additional request. Connection lifetime
remains bounded to five seconds; accepted jobs are independent of this deadline.
An initialized host advertises `host`, `environment.inspect`, `exec.start` and
`operation.get`; it advertises no file, stream-output or cancellation capability.

```text
environment.inspect { env }
    → Environment { binding, state: "ready" } or ENVIRONMENT_MISSING
exec.start { operationId, env,
             spec: { command, guestCwd, timeoutMs, outputLimit } }
    → Accepted { operationId } or Error
operation.get { operationId, env }
    → Operation { operationId, operation:
         Accepted | Running | Succeeded { result } |
         Failed { error, completionUnknown } |
         Interrupted { completionUnknown: true } | Unknown }
result = { exitCode, termination: "exited" | "signalled" | "timedOut",
           output: byte[], outputBytes, truncated }
```

This is a deliberately smaller bootstrap than the proposed full node protocol:
`spec` groups exec fields; inspect exposes binding/directory readiness, not setup
or resume state; output is available in the terminal result, not `exec.output`.
There are no events/cursors, cancel, blobs, file APIs, services or portals yet.

Commands use `/bin/bash --noprofile --norc -c`, closed stdin and a cleared
environment with only `PATH=/usr/local/bin:/usr/bin:/bin`, `HOME=<workspace>` and
`LANG=C.UTF-8`. No parent credentials or arbitrary environment variables are
forwarded. This does not prevent filesystem access under the same account.
The PATH is intentionally not a full project setup environment yet.

Cwd is relative to the bound workspace, opened with Linux `openat2` beneath an
opened, identity-checked workspace directory, then `fchdir` in the child. It does
not rely on a preflight symlink check. Missing or replaced workspaces fail; no
replacement directory is created. A kernel without openat2 is unsupported for
host cwd resolution; there is no insecure fallback.

Maximum command length is 8 KiB, cwd length 4 KiB, timeout 60 seconds and retained
output 8 KiB (zero is allowed). Stdout/stderr are drained concurrently with
bounded buffers; byte order is observation order across the two pipes. Extra
output is counted and discarded. Timeout drops unread output and sets truncated;
`outputBytes` counts observed bytes, not unread bytes still in pipes.
Timeout cleanup kills the current unreaped child process group, with a bounded
wait for confirmation. Descendants that detach themselves are not contained;
there is no cgroup supervisor. Hard daemon death also cannot guarantee process
termination. Failed cleanup/storage is an uncertain outcome, never safe replay.

## Evidence and next steps

`bash scripts/test-node-transport.sh` runs fmt/clippy and all offline Rust tests.
New cases execute real shell processes over real iroh, including simultaneous
same-ID requests, conflicts, busy rejection without records, output truncation,
binary bytes, nonzero exits, closed stdin, clean environment, both timeout paths,
cwd escape/replacement denial, immutable records, exclusive ownership, durable
CLI intent, lost Accepted response, and crashes before spawn/during execution.

Next is the control-plane transport/tool adapter and explicitly configured
external iroh connectivity. File/repository transfer, richer output/cancellation,
and thread communication remain required before this can drive the complete
thread-to-host development loop. No real remote machine or shared live thread
was touched; this is local multi-process acceptance, not remote-node sign-off.
