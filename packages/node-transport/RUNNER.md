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
command's existing 60-second bound. Second Ctrl-C cancels and reaps the active
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
  resolves the existing record; changed content is `CONFLICT`.
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

Limits: 8-KiB command, 4-KiB cwd, 60-second runtime, 8-KiB retained output, one
active job, one active workspace, 16 connections, 10,000 immutable operation
records, and a 50-GiB managed-workspace admission threshold. Status reports
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

Every RPC checks config bytes, peer, protocol range, and full immutable binding.
`prepareExec` persists only; `submitExec` dispatches once; `operation` is read-only.
Cancellation or malformed/lost replies after possible delivery return
`COMPLETION_UNKNOWN` with the saved ID. Wake, sleep, portals, files, repositories,
services, and remote provisioning remain unsupported.

## Wire contract

ALPN remains `cubeyard/node/1`. This is transport terminology and is not renamed.
Frames are four-byte big-endian length plus bounded UTF-8 JSON and FIN. A
connection performs hello then at most one request. New daemons advertise
profiles `["runner", "host"]`; `host` is the protocol-v1 compatibility alias.
Capabilities are `node.status`, `environment.inspect`, `workspace.allocate`,
`workspace.allocate.v2`, `workspace.release`, `exec.start`, and `operation.get`.
The original `workspace.allocate` has no allocation metadata and remains only for
wire compatibility. Cubed uses v2 for every new global allocation and rejects an
older runner as `UNSUPPORTED` after authenticated hello but before sending mutation
bytes. Upgrade runner binaries before allocating new threads; existing requests
without `threadId` continue to use the legacy template workspace and preserve their
operation hashes. `nodeId` and existing field names remain stable on wire.

Product threads reach the enrolled runner through Pi's `bash` tool and
`IrohExecutionNodeClient.resumeExec`. Pi supplies the stable invocation identity;
the adapter derives and retains the runner operation identity. There is no
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
