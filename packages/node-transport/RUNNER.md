# Trusted runner execution

The production boundary is documented in the
[operator runbook](../../docs/trusted-runner-operations.md). This file describes
the lower-level daemon, wire, and development contract.

## Trust boundary

`runner-serve` is explicit opt-in. The daemon and commands execute as the same
dedicated, unprivileged Unix account. This is **not a sandbox**: there is no
same-UID filesystem protection, per-job UID, egress enforcement, or protection
of the journal/key from a hostile command running as that UID. Root is refused.

The runner accepts one enrolled Iroh control peer and one persisted installation
binding. It leases at most one active thread workspace. The historical
`threadId` in the installation binding remains the protocol-v1 identity and
legacy-workspace key; new product thread IDs are allocated separately. Iroh
`peerId` authenticates transport; Cube `nodeId` is domain identity and is not
authentication.

## Disposable development loop

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

`workspace.allocate` creates `state/workspaces/<thread-id>` after strict ID
validation. A repository-root Git template uses `git worktree add --detach`;
other templates are recursively copied without following symlinks. The journal
commits `allocating/available/releasing/released/failed` with path device/inode
anchors. Startup changes interrupted transitions to `failed` and preserves the
tree. Release removes a clean Git worktree still at the template HEAD, but
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
`workspace.release`, `exec.start`, and `operation.get`. Existing requests without
`threadId` continue to use the legacy template workspace and preserve their
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
