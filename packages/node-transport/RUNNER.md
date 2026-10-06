# Runner (protocol 3)

The production boundary is documented in the
[operator runbook](../../docs/runner-operations.md); the design is
[docs/plans/2026-10-04-vm-runner.md](../../docs/plans/2026-10-04-vm-runner.md).
This file describes the daemon, the wire and the development loop.

## What a runner does

A runner hosts one QEMU VM per active thread, up to `--max-active-vms` at once
(see [thread machines per runner](../../docs/runner-operations.md#thread-machines-per-runner)):
a qcow2 overlay on the operator's
Debian 13 genericcloud base image, a cloud-init NoCloud seed (a FAT `CIDATA`
image written by the runner from documents cubed sends) and a frame pump. It
runs no command for a thread and has no file or Git operations. The agent's
tools run in the guest over SSH, which cubed reaches through `cube-gateway`.

The guest is the thread's sandbox: the agent's commands, files and network
stay inside it. QEMU runs as the runner account and is not hardened beyond
`-sandbox on` (Linux), so a QEMU escape has that account's authority and the
runner host as a whole is not a sandbox. Root is refused.

The runner accepts one enrolled Iroh control peer and one persisted
installation binding (`nodeId`, `threadId`, `environmentId`). Iroh `peerId`
authenticates transport; `nodeId` is domain identity, not authentication.

## Development loop

Needs Linux with a usable `/dev/kvm`, QEMU ≥ 7.2 with `qemu-img`, and a Debian
13 genericcloud image.

```sh
cargo build --locked -j 2 -p cube-runner -p cube-gateway
bin="$PWD/target/debug/cube-runner"
"$bin" keygen --key "$HOME/.cube/control.key"   # public control peer on stdout
"$bin" init --home "$HOME/.cube/runner" --image /path/debian-13-genericcloud-amd64.qcow2 \
  --allow-peer CONTROL_PEER --node-id node-laptop --thread-id thread-laptop --env 1
"$bin" run --home "$HOME/.cube/runner"
```

`run` prints human status on stderr. First Ctrl-C refuses new VMs and powers
the running guests down (30 s); a second Ctrl-C makes QEMU quit at once.
`run` and `runner-serve` take `--max-active-vms auto|N` (or
`CUBE_RUNNER_MAX_ACTIVE_VMS`); `auto` is the default.

Service form: `runner-init --key K --state S --image …` and
`runner-serve --key K --state S [--listen] [--ready-file F] [--stop-policy wait|cancel] [--max-active-vms auto|N]`
(one JSON ready line on stdout: peer, addresses, versions, lifecycle,
`platform`, `baseImageSha256`, `maxActiveVms`). `call --key CONTROL --peer RUNNER
--expect-node N [--address A] --request '<json>'` sends one protocol-3
request and prints the response. `runner-acknowledge-recovery --key K --state S`
ends a restore quarantine.

The whole loop with a real guest and the real gateway is automated in
`scripts/smoke-runner-vm.ts`, run by `scripts/test-node-transport.sh` when
`CUBE_TEST_VM_IMAGE` points at the image.

## Wire

ALPN `cubeyard/node/1`, framing as in [README.md](README.md): a successful
`node.hello` with `protocolVersion: 3`, then one request per connection. Any
other version is `INCOMPATIBLE_PROTOCOL` and the connection ends before a
request is read. After hello, a method protocol 3 does not have (for example
`exec.start`, `fs.read`, `workspace.allocate.v2`) is `UNSUPPORTED`.

Hello (runner profile) adds `binding`, `platform` (`linux-x86_64`,
`macos-aarch64`), `baseImageSha256`, capabilities `node.status vm.allocate
vm.start vm.stop vm.inspect vm.release vm.discard` (`vm.discard` since
0.5.0), and `limits {maxFrameBytes,
requestTimeoutMs, maxVcpus, maxMemoryMiB, maxDiskGiB, maxSeedBytes,
maxActiveVms}`. `maxActiveVms` is the process's bound on active VMs (1 before
0.7.0); `vm.allocate` beyond it is `CAPACITY_EXCEEDED`.

Every `vm.*` request carries `threadId` and `vmId` (16 lowercase hex); every
mutation carries `epoch` ≥ 1, fenced per thread (`LEASE_STALE` below the newest
seen). Requests are idempotent by content: repeating one returns the current
record.

```json
{"method":"vm.allocate","threadId":"t1","vmId":"0123456789abcdef","epoch":1,"diskGiB":16}
{"method":"vm.start","threadId":"t1","vmId":"0123456789abcdef","epoch":1,
 "vcpus":2,"memoryMiB":2048,"mac":"02:12:34:56:78:9a",
 "seed":{"metaData":"…","userData":"#cloud-config\n…","networkConfig":"…"},
 "gateway":{"peer":"<gateway endpoint id>","frameToken":"<64 hex>"}}
{"method":"vm.stop","threadId":"t1","vmId":"0123456789abcdef","epoch":1}
{"method":"vm.inspect","threadId":"t1","vmId":"0123456789abcdef"}
{"method":"vm.release","threadId":"t1","vmId":"0123456789abcdef","epoch":1,"retain":false}
{"method":"vm.discard","threadId":"t1","vmId":"0123456789abcdef","epoch":1}
{"method":"node.status"}
```

Answers are `{"type":"Vm","vm":{vmId, threadId, state, interrupted, error?,
diskBytes, seedSha256?, startedAt?},"consoleTail"?}` (console only for
`vm.inspect`), `Status`, or `{"type":"Error","code","message","completionUnknown"}`.
States: `allocating allocated starting running stopping stopped releasing
released retained failed`. `running` means QEMU answered QMP, not that the
guest is ready. `vm.stop` and `vm.release` of a live VM are asynchronous (ACPI
power-down, 30 s, QMP `quit`, SIGKILL); poll `vm.inspect`. `vm.discard`
deletes a `retained` or `failed` VM's directory (`released` afterwards, and
repeatable); any other state is `CONFLICT`. The first
`vm.start` fixes vcpus, memory, mac and seed; later starts reuse them and
ignore the request's sizes and seed (a different mac is `CONFLICT`). A
mutation runs to completion even when its control connection times out, so a
caller that lost the answer inspects or repeats. The method table with every
rule is in the plan.

## Frame channel `cube/l2/1`

The same endpoint accepts ALPN `cube/l2/1` from the gateway named by the latest
`vm.start` of a VM. The gateway opens one bi-stream and sends
`{vmId, threadId, frameToken}`; the runner compares the token's sha256 in
constant time and answers `{ok: true, mtu: 1500}` or `{ok: false, mtu, error}`.
Unknown peers are closed with `UNAUTHORIZED` before any byte is read. After
that, datagrams in both directions are Ethernet frames split with a 3-byte
fragment header (`cube_node_transport::l2`). One frame connection per VM; a new
grant or a stop closes it. Frames are dropped while none exists.

## State and no replay

- `init`/`runner-init` require a NEW state directory. The installation
  (binding, peers, platform, base image hash and size, QEMU and `qemu-img`
  paths, firmware, limits) is immutable in SQLite (`user_version` 3); a
  protocol-2 journal (version 1) is refused with a clear message.
- One process owns the state through a kernel-released lock. The base image is
  re-hashed at every start; a changed image refuses to serve.
- Startup reconciliation: `allocating`/`releasing` → `failed` (tree kept);
  `starting`/`running`/`stopping` → QMP `quit` if the old QEMU still answers
  with the vmId (macOS), then `stopped` with `interrupted: true`. The runner
  never signals a process it did not spawn. On Linux QEMU has
  `PR_SET_PDEATHSIG(SIGKILL)` from a long-lived spawner thread, so it dies
  with the runner.
- Released VM directories are deleted; retained, interrupted and failed ones
  are kept. Records are never deleted (a vmId is never reused), except an
  allocation whose `qemu-img create` failed before any disk existed.

## Tests

`cargo test -p cube-runner`: unit tests (QEMU command line, seed round trip,
qcow2 header checks, wire shapes) and integration tests with a fake QEMU
(`tests/support/fake-qemu.py`: QMP, frame echo) over the real Iroh wire:
idempotency, conflicts, capacity, epochs, frame authorization and token
rotation, failures, retained evidence, quarantine, reconciliation, and a
process test (runner SIGKILL takes QEMU down; restart marks the VM
interrupted; SIGTERM powers it down) that runs where `/dev/kvm` is usable.
