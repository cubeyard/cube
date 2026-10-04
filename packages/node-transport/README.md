# Node transport and runner

**A runner hosts one QEMU VM per active thread; the guest is the isolation
boundary, QEMU runs as the runner account (see [RUNNER.md](RUNNER.md)).**
Real iroh 1.2.0, pinned in Cargo.lock, using Rust 1.91.0. The `serve` command
remains a hello-only probe and advertises no profiles. The [runner
profile](RUNNER.md) adds a permanent local binding, a durable VM journal, the
`vm.*` lifecycle (protocol 3) and the `cube/l2/1` frame channel to
`cube-gateway` (`src/l2.rs`, shared with `packages/gateway`). cubed's adapter
(`packages/server/src/iroh-node.ts`) calls pinned `@number0/iroh` inside Node,
directly over this protocol; its protocol-3 client is the SERVER work package
of the VM-runner plan. The CLI is enrollment, diagnostic and operator tooling.

## Run locally

Run as an unprivileged development user. Use a new disposable directory; key
files are private, are never overwritten automatically, and must not be committed.
These are node-transport keys, not provider or GitHub credentials.

```sh
cargo build --locked -j 2 -p cube-runner
bin="$PWD/target/debug/cube-runner"
state=$(mktemp -d)
"$bin" keygen --key "$state/control.key" # prints public peerId only
"$bin" keygen --key "$state/node.key"    # prints public peerId only

# In one terminal; replace CONTROL_PEER with the first public peerId:
"$bin" serve --key "$state/node.key" --allow-peer CONTROL_PEER \
  --node-id node-development --listen 127.0.0.1:0

# In another terminal, use the server's printed address and NODE_PEER from
# key generation. Enroll/verify the key independently, not through hello:
"$bin" hello --key "$state/control.key" --peer NODE_PEER \
  --address 127.0.0.1:PORT --expect-node node-development
```

Keep the generated paths available in both terminals. Ctrl-C closes the server
endpoint and its connections. Restarting with the same key retains its peer ID;
a missing, corrupted, symlinked or group/world-accessible key fails startup.
The logical node ID is explicitly configured for this stateless probe; this is
not the durable node registry/enrollment or an environment allocation mechanism.

## Wire contract

- ALPN `cubeyard/node/1`; iroh's authenticated QUIC peer key is checked before
  reading application bytes. `nodeId` is not authentication. No 0-RTT/replay.
- The accepting side has one explicitly allowed control peer. The caller pins
  the server key and checks the expected logical node ID in the response.
- At most two streams per connection: successful hello, then one optional
  request. Each stream carries one request/response. Both directions carry a
  four-byte big-endian payload length, then exactly that
  many UTF-8 JSON bytes and FIN. Empty, oversized, truncated, trailing or unknown
  request fields fail closed. Unsupported methods are not executed.
- Request: `{"method":"node.hello","protocolVersion":3}`. Any other version is
  `INCOMPATIBLE_PROTOCOL`.
- Response: `{"type":"Hello","nodeId":"node-development","protocolVersion":3,
  "minimumProtocolVersion":3,"profiles":[],"capabilities":["node.hello"],
  "limits":{"maxFrameBytes":1048576,"requestTimeoutMs":5000,...}}`; see
  [RUNNER.md](RUNNER.md) for every advertised limit.
- Rejections use `type: Error`, `code`, a bounded `message` and
  `completionUnknown`. A lost answer to a `vm.*` mutation is `OUTCOME_UNKNOWN`;
  every mutation is idempotent by content, so the caller repeats it or inspects
  the VM. No automatic retry and no offline queue.
- At most 16 active handshake/request tasks; each has a five-second deadline.
  Frames are bounded to 1 MiB before allocation. Slow/missing FIN also times out.

Loopback is the default. Rust network commands accept `--network direct` for an
operator-selected unicast IP/port; a direct server additionally requires an
explicit `--listen` interface and rejects wildcard listeners. `--network relay`
instead enables Iroh's N0 preset on both peers: the runner waits for a usable home
relay, publishes its address, and callers locate the pinned peer ID through N0
discovery. Iroh attempts direct UDP hole-punching and falls back to end-to-end
encrypted relay traffic. Relay mode has no static `--address` or `--listen`.
It depends on the public N0 discovery/relay service unless a custom relay is added
later. The Rust build disables the portmapper feature. The npm binding has a
separate NAT-portmapping limitation documented in [RUNNER.md](RUNNER.md).

This is not a VPN, SSH tunnel or plaintext TCP substitute. No browser listener or
network-policy exception is added. Loopback/direct tests remain offline. The
opt-in relay smoke uses the public N0 service; separate-machine acceptance is
still required before calling the runner profile production-ready.

## Tests

```sh
cargo fetch --locked                 # setup also does this
bash scripts/test-node-transport.sh  # fmt, clippy, Rust tests, packaging, real VM
CUBE_TEST_VM_IMAGE=/path/debian-13-genericcloud-amd64.qcow2 CUBE_TEST_VM=required \
  bash scripts/test-node-transport.sh
```

The CI transport job runs the same script on Linux and macOS; without KVM and an
image it skips the real-VM part with a notice. The runner is packaged with
`scripts/runner/package.sh`.

Tests exercise strict framing, unknown versions and methods, loopback-only
binding, separate CLI processes, authenticated hello, key persistence across
restart, wrong client and server keys, wrong logical identity, key file
restrictions and auth rejection before any application message. The [runner
tests](RUNNER.md) add the VM lifecycle with a fake QEMU, and
`scripts/smoke-runner-vm.ts` a real Debian guest with the real gateway.
Separate-machine (direct/relay) acceptance and macOS remain to be done.
