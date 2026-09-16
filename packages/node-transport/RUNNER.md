# Trusted runner execution

The production boundary is documented in the
[operator runbook](../../docs/trusted-runner-operations.md). This file describes
the lower-level daemon, wire, and development contract.

## Trust boundary

`runner-serve` is explicit opt-in. The daemon and commands execute as the same
dedicated, unprivileged Unix account. This is **not a sandbox**: there is no
same-UID filesystem protection, per-job UID, egress enforcement, or protection
of the journal/key from a hostile command running as that UID. Root is refused.

The runner accepts one enrolled Iroh control peer and exactly one persisted
logical node/thread/environment binding. Iroh `peerId` authenticates transport;
Cube `nodeId` is domain identity and is not authentication.

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

- `runner-init` requires a new state directory and existing workspace. It saves
  immutable binding, both peer identities, and workspace path/device/inode.
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
`LANG=C.UTF-8`. Cwd is relative to the bound workspace and opened with Linux
`openat2` beneath the identity-checked directory. There is no insecure fallback.

Limits: 8-KiB command, 4-KiB cwd, 60-second runtime, 8-KiB retained output, one
active job, 16 connections, 10,000 immutable operation records. Busy/capacity
reject new work; existing IDs remain inspectable.

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
Capabilities are `node.status`, `environment.inspect`, `exec.start`, and
`operation.get`. `nodeId` and field names remain stable on wire.

The canonical thread endpoint is `POST /api/threads/:id/runner-exec`, accepting
only `status`, `prepare {spec}`, `submit {operationId}`, and
`operation {operationId}`. It derives destination and binding from the thread.
The old `/host-exec` path is a temporary alias.

## Tests

```sh
bash scripts/test-node-transport.sh
CUBE_TEST_IROH_RELAY=1 node scripts/smoke-node-adapter.ts target/debug/cube-runner
```

The suite runs fmt, clippy, Rust tests, real Node↔Rust loopback/direct smoke, and
operator enrollment/cubed/Pi routing. Relay is opt-in because it uses public N0.
Release sign-off still requires the separate-machine acceptance matrix from the
operator runbook.
