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

## In-process control-plane client

`packages/server/src/iroh-node.ts` uses exact `@number0/iroh` 1.1.0 native Node
bindings. TypeScript opens QUIC streams directly: **no child process, shell,
stdio envelope or bridge binary** in this call path. The Rust host and its journal
are unchanged. There is no implicit local backend, migration or automatic replay.

Provision a private config file (0600), raw 32-byte control key (0600), and an
existing intent directory (0700) on the control plane, outside guest reach:

```json
{
  "version": 1,
  "binding": { "nodeId": "node-development", "threadId": "thread-development", "environmentId": 17 },
  "controlKey": "/absolute/private/control.key",
  "serverPeer": "REPLACE_WITH_THE_ENROLLED_64_CHARACTER_LOWERCASE_HEX_PEER",
  "address": "127.0.0.1:4444",
  "network": "loopback",
  "intentDirectory": "/absolute/private/intents"
}
```

Operator code constructs `new IrohExecutionNodeClient({ configPath })`. There is
no `binary` option. Construction reads only config, not the key/workspace, and
never probes or binds sockets. Config bytes are pinned for the client's lifetime;
edits cause `CONFLICT`, not retargeting. Request specs cannot override destinations,
identity, thread, environment or host paths. Every connection authenticates the
pinned peer, checks the complete immutable binding in hello, then optionally sends
one request on the **same connection**. `locality: "remote"` cannot grant access to
control-plane filesystem/Git/Incus adapters even if a local node ID is supplied.

- `check` is contact only; `status` records an observation only after a validated
  environment response. Failed contact does not overwrite the last observation.
- `prepareExec` fsyncs a create-only intent, including thread and both peer IDs;
  it does not contact the node. `submitExec` fsyncs the create-only `.sent` marker
  before dialing. There is no startup scanner, reconnect queue or resubmission.
- `operation` is read-only. Saved intents can also be inspected with the standalone
  Rust `operation` CLI, which checks their optional thread binding.
- `exec` prepares/submits once, then polls results. Cancellation, malformed replies
  or transport loss after possible command delivery return `COMPLETION_UNKNOWN`
  with the durable operation ID. They do **not** cancel the remote command.
- Frames/outputs remain bounded. Each RPC owns a native endpoint object within the
  Node process, so aborting its connect/read does not close a sibling's endpoint.
  IO has a five-second deadline; awaited QUIC drain can add roughly three seconds
  for an unreachable peer. Late native completions are closed, never dispatched.
- Wake/sleep/portals remain unsupported. No remote registry enrollment or production
  agent-tool routing is installed by this module.

**Dependency constraints before external deployment:** 1.1.0 publishes its entry
files at package root but points `main`/`types` at a missing `iroh-js/` directory.
We use the published `@number0/iroh/index.js` subpath, with the exact lockfile pin;
no fork or custom addon is built. Linux x64 GNU interoperability with Rust iroh
1.2.0 is tested; other addon platforms are not acceptance-tested. Loopback mode
binds both IPv4 and IPv6 explicitly, requiring IPv6 loopback support because this
binding cannot clear one family's default transport.

`applyMinimal()` avoids n0 relays and peer address lookup, **but does not disable
the addon's built-in NAT portmapper**. The published API exposes no portmapper
switch; the upstream implementation can probe/map a LAN gateway even with an empty
relay map. Therefore this is not a packet-level loopback-only guarantee. External
deployment requires an explicit operator decision or upstream portmapper controls;
do not silently treat the old Rust build's disabled-portmapper guarantee as applying
to this npm addon. No network policy/firewall rules are changed here. No server
application ALPN is registered on the caller endpoint, and browser HTTP remains
within its existing private boundary. Native crashes now share the Node process,
like other native addons; there is intentionally no process-isolation wrapper.

## Wire subset and execution limits

The [base framing](README.md) now permits two bidirectional streams per
connection: successful hello, then one additional request. Connection lifetime
remains bounded to five seconds; accepted jobs are independent of this deadline.
An initialized host includes its immutable binding in hello and advertises
`host`, `environment.inspect`, `exec.start` and `operation.get`; it advertises no file, stream-output or cancellation capability.

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

The runner also builds the host binary and executes `scripts/smoke-node-adapter.ts`:
real npm iroh → Rust host exec, both network modes with loopback targets, caller
cancellation/result recovery, wrong thread denial, immutable config/intents, missing
workspace, restart and no resubmission. Only test-owned keys/state/workspaces and
host processes are fixtures. The npm NAT limitation above still applies.

Next are explicit registry enrollment/tool routing and external connectivity
acceptance, then file/repository transfer and thread communication. No real remote
machine or shared live thread was used as an execution target. This is not full
thread-to-host or external-network sign-off.
