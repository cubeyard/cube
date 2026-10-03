# Trusted runner execution

The production boundary is documented in the
[operator runbook](../../docs/trusted-runner-operations.md). This file describes
the lower-level daemon, wire, and development contract.

## Trust boundary

The runner and commands execute as the same
dedicated, unprivileged Unix account. This is **not a sandbox**: there is no
same-UID filesystem protection, per-job UID, egress enforcement, or protection
of the journal/key from a hostile command running as that UID. Root is refused.

The runner accepts one enrolled Iroh control peer and one persisted installation
binding. Enrollment is global to the Cube installation; it leases at most one
active thread workspace across all projects. The historical
`threadId` in the installation binding remains the protocol-v1 identity and
legacy-workspace key; new product thread IDs are allocated separately. Iroh
`peerId` authenticates transport; Cube `nodeId` is domain identity and is not
authentication.

## Foreground laptop loop

`init` creates a private home, identity key, immutable state and a small network
manifest. `run` reopens that home as a normal foreground process:

```sh
bin="$PWD/target/debug/cube-runner"
mkdir -p "$HOME/work/cube-workspace" "$HOME/.cube/control-intents"
chmod 700 "$HOME/.cube/control-intents"
"$bin" keygen --key "$HOME/.cube/control.key"
# Read the public control peer from that JSON output.
"$bin" init --home "$HOME/.cube/runner" \
  --workspace "$HOME/work/cube-workspace" --allow-peer CONTROL_PEER \
  --node-id node-laptop --thread-id thread-laptop --env 1
"$bin" run --home "$HOME/.cube/runner"
```

`run` prints human lifecycle status to stderr and leaves stdout quiet.
`network ready / waiting for cubed` means the authenticated Iroh endpoint is
listening; it does not claim a permanent cubed connection. Its peer and current
addresses are shown so the private cubed adapter configuration can be created and enrolled.
Use relay mode at initialization when the runner is not directly reachable.

First Ctrl-C enters drain, rejects new operation IDs, and waits up to the active
command's 600-second bound. Second Ctrl-C cancels and reaps the active
process group, then durably records `CANCELLED`. An idle Ctrl-C exits immediately.
SIGTERM follows the same drain-first path. Restart with the same home; do not
reinitialize it.

## Low-level automation interface

```sh
cargo build --locked -j 2 -p cube-runner
bin="$PWD/target/debug/cube-runner"
scratch=$(mktemp -d)
mkdir "$scratch/workspace"
control_peer=$("$bin" keygen --key "$scratch/control.key" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).peerId')
runner_peer=$("$bin" keygen --key "$scratch/runner.key" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).peerId')
"$bin" runner-init --key "$scratch/runner.key" --state "$scratch/state" \
  --workspace "$scratch/workspace" --allow-peer "$control_peer" \
  --node-id node-development --thread-id thread-development --env 1
"$bin" runner-serve --key "$scratch/runner.key" --state "$scratch/state"
```

The existing `runner-init`, `runner-serve`, recovery, intent and diagnostic
commands remain the automation boundary. Their one-line JSON stdout is
unchanged; bounded lifecycle diagnostics use stderr. `host-init` and
`host-serve` remain deprecated protocol-v1 compatibility aliases.

Prepare/submit from another terminal with the control key and pinned runner peer.
Preparation fsyncs a create-only intent. Submit fsyncs its consumed marker before
the first network dispatch. A failed dial stays consumed; never remove `.sent`.

## Permanent state and no replay

- `runner-init` requires a new state directory and existing repository template.
  It saves immutable binding, both peer identities, and template path/device/inode.
- `runner-serve` opens existing state only. Wrong key, corrupt metadata, missing
  journal/lock, unsupported schema, or replaced workspace fails closed.
- SQLite uses FULL synchronous durability and rollback journal. One process owns
  the state through a kernel-released file lock.
- Operation IDs and canonical request hashes are immutable. Same ID/content
  resolves the existing record; changed content is `CONFLICT`. `fs.write`
  idempotency keys share this namespace, so a key is never executed twice and
  never reused by a command.
- `Accepted` commits before dispatch and `Running` before spawn. Startup changes
  unfinished records to `Interrupted { completionUnknown: true }`; it never
  queues, retries, signals restored PIDs, or reruns them.
- `Unknown` means no retained record, not permission to repeat a possibly
  delivered mutation. Keep the journal for the installation's lifetime.

Commands run through `/bin/bash --noprofile --norc -c` with closed stdin and a
cleared environment containing only bounded `PATH`, workspace `HOME`, and
`LANG=C.UTF-8`. Cwd is relative to the identity-checked workspace. Linux opens
it with `openat2` beneath/no-symlink resolution. macOS walks each component with
descriptor-relative `openat(O_DIRECTORY|O_NOFOLLOW)`; absolute paths, `..`,
symlink components and workspace replacement fail closed. Neither mechanism
sandboxes arbitrary command filesystem access from the runner UID.

`workspace.allocate.v2` carries a project/revision and normalized repository list
with resolved branches and exact checked OIDs. After strict validation it creates
a new allocation root, fetches each declared branch without interactive prompts or
command-running transports, verifies the supplied commit is available from that
fetch, and checks out that exact OID (primary `workspace`, references under
`repos/`). A v2 allocation without repositories creates a fresh empty `workspace`;
it never copies the installation template. Only the legacy v1 allocation uses that
template via `git worktree add --detach`, or recursively copies a non-Git template. The journal
commits `allocating/available/releasing/released/failed` with path device/inode
anchors. Startup changes interrupted transitions to `failed` and preserves the
tree. Release removes checkouts still clean at every pinned OID (or a clean legacy
Git worktree still at the template HEAD), but
retains changed or independently committed Git worktrees and
all copy fallbacks because there is no trustworthy clean oracle for a plain
directory. A retained tree does not consume the one active-workspace slot.
This prevents accidental active-thread collisions; it is not filesystem or
process confinement.

Commands run in a new process group. Timeout/cancel reaps normal descendants.
On macOS a hostile descendant can escape by creating a new session/process
group, and a hard daemon crash cannot provide cgroup-style cleanup.

Limits: 8-KiB command, 4-KiB cwd and file paths, 600-second runtime, 256-KiB
retained output read in 64-KiB pages, 512-KiB file read pages and writes,
1-MiB frames, one active job, one active workspace, 16 connections, 100,000
immutable operation records (commands and file writes), and a 50-GiB
managed-workspace admission threshold. `node.hello` advertises these bounds in
`limits`. Status reports
active/retained workspace counts and bytes. Busy/capacity rejects new work;
existing IDs remain inspectable.

## Control-plane adapter

`packages/server/src/iroh-node.ts` uses pinned `@number0/iroh` directly in the
Node process. No Rust subprocess, stdio bridge, fallback, reconnect queue, or
automatic command resubmission exists. Private config schema remains protocol v1:

```json
{
  "version": 1,
  "binding": { "nodeId": "node-development", "threadId": "thread-development", "environmentId": 17 },
  "controlKey": "/absolute/private/control.key",
  "serverPeer": "64_CHARACTER_LOWERCASE_HEX_IROH_PEER",
  "network": "relay",
  "intentDirectory": "/absolute/private/intents"
}
```

Loopback/direct configs also include an explicit unicast `address`. Relay omits
it and uses the pinned peer through public N0 discovery/relay. N0 can observe IPs
and traffic metadata. The npm binding's minimal mode does not disable its built-in
NAT portmapper; do not claim packet-level loopback confinement.

Every RPC checks config bytes, peer, protocol version 2, the advertised limits,
the method's capability, and the full immutable binding before request bytes.
`prepareExec` persists only; `submitExec` dispatches once; `operation` is read-only.
`describe`, `startOperation`, `inspectOperation`, `cancelOperation`,
`collectOutput`, `readFile`, `writeFile` and `stat` are the protocol-2 calls a
workspace layer builds on. Caller cancellation or malformed/lost replies after
possible delivery return `COMPLETION_UNKNOWN` with the saved ID; only
`cancelOperation` cancels remote work. Wake, sleep, portals, repositories,
services, and remote provisioning remain unsupported.

## Wire contract

ALPN remains `cubeyard/node/1`. This is transport terminology and is not renamed.
Frames are four-byte big-endian length plus bounded UTF-8 JSON and FIN. A
connection performs hello then at most one request. Protocol version 2 is the
only accepted version in both directions (`protocolVersion` and
`minimumProtocolVersion` are 2): a protocol-1 peer is answered with
`INCOMPATIBLE_PROTOCOL` and must be upgraded. There is no shell or protocol-1
fallback. New daemons advertise profiles `["runner", "host"]`; `host` is the
historical compatibility alias. Capabilities, one per operation, are
`node.status`, `environment.inspect`, `workspace.allocate`,
`workspace.fresh-base`, `workspace.allocate.v2`, `workspace.release`,
`exec.start`, `exec.cancel`, `operation.get`, `fs.read`, `fs.write`, and
`fs.stat`. Hello `limits` carries `maxFrameBytes`, `requestTimeoutMs`,
`maxCommandBytes`, `maxPathBytes`, `maxExecTimeoutMs`, `maxOutputBytes`,
`outputPageBytes`, `maxReadBytes`, and `maxWriteBytes`.

Protocol-2 operations (all take `env` and an optional `threadId`; without it the
installation workspace is used):

| Operation | Contract |
|---|---|
| `exec.start` | `operationId`, `spec`, optional `epoch`; up to `maxExecTimeoutMs` |
| `operation.get` | optional byte `cursor`; a `Succeeded` result carries one page of `output` from `outputOffset` plus `retainedBytes` |
| `exec.cancel` | `operationId`, optional `epoch`; SIGKILLs the active command's process group, which ends `Failed { CANCELLED }`; returns the state seen right after the request |
| `fs.read` | `path`, optional `offset`/`limit`; base64 `content`, `size`, `eof`, whole-file `sha256` up to 16 MiB |
| `fs.write` | `idempotencyKey`, `path`, base64 `content`, optional `expectedSha` and `createParents`, optional `epoch`; temporary file, fsync, rename, directory fsync |
| `fs.stat` | `path` (`.` is the workspace root); `kind`, `size`, `mode`, `modifiedMs`, `sha256` for regular files up to 16 MiB |

File paths are relative; absolute paths, `..`, NUL and paths outside the
workspace fail with `INVALID_REQUEST`. Linux resolves them with
`openat2(RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS)` below the identity-checked
workspace descriptor, so a symlink may be read only while it stays beneath the
workspace; macOS walks components with `openat(O_NOFOLLOW)` and refuses every
symlink. `fs.write` never follows or replaces a symlink at the final component,
preserves an existing file's mode, and leaves no temporary file on failure.
`expectedSha` is the SHA-256 of the whole current file; a mismatch or missing
file is `PRECONDITION_FAILED`. Missing files are `NOT_FOUND`.

`fs.write` is retained under its idempotency key exactly like a command: the
same key and request returns the original result without touching the file, a
different request is `CONFLICT`, and a recorded failure replays the same code.
The record commits before the first filesystem change; a crash leaves it
`Interrupted`, replayed as `OUTCOME_UNKNOWN` with `completionUnknown: true`.

Lease epochs fence `exec.start`, `exec.cancel` and `fs.write` per thread. The
runner durably keeps the newest epoch it has seen for each thread and rejects a
lower one with `LEASE_STALE` before deduplication; a call without `epoch` counts
as 0, so it is refused once any epoch has been seen for that thread. The epoch
is not part of the request identity. Epochs never decrease and are retained for
the journal's lifetime.

Journal schema stays version 1. Retained output and epochs live in additive
tables, and command records keep the protocol-1 result shape, so a rolled-back
binary can still open the journal (it shows empty output for newer records and
speaks protocol 1, which current cubed reports as incompatible).
The original `workspace.allocate` has no allocation metadata and remains only for
wire compatibility. Cubed uses v2 for every new global allocation and rejects an
older runner as `UNSUPPORTED` after authenticated hello but before sending mutation
bytes. Upgrade runner binaries before allocating new threads; existing requests
without `threadId` continue to use the legacy template workspace and preserve their
operation hashes. `nodeId` and existing field names remain stable on wire.

Product threads reach the enrolled runner through Pi's `bash` tool and
`IrohExecutionNodeClient.resumeExec`. Pi supplies the stable invocation identity;
the adapter derives and retains the runner operation identity and collects every
output page. Until cubed's thread lease exists, these calls carry no epoch. There is no
standalone HTTP runner-exec endpoint or legacy host-exec alias. Operator canaries
use `IrohExecutionNodeClient` directly with the private pinned configuration;
ordinary users submit prompts through the thread UI/API.

## Tests

```sh
bash scripts/test-node-transport.sh
CUBE_TEST_IROH_RELAY=1 node scripts/smoke-node-adapter.ts target/debug/cube-runner
```

The suite runs fmt, clippy, Rust tests, real Node↔Rust loopback/direct smoke, and
operator enrollment/cubed/Pi routing. Relay is opt-in because it uses public N0.
Release sign-off still requires the separate-machine acceptance matrix from the
operator runbook.
