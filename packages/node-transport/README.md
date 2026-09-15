# Node transport bootstrap

**Opt-in development host profile. No Rust host binary is built into release
artifacts; ordinary threads still use the local backend.**
Real iroh 1.2.0, pinned in Cargo.lock, using Rust 1.91.0. The `serve` command
remains a hello-only probe and advertises no execution profiles. The separate,
explicitly opted-in [trusted host profile](HOST.md) now adds a permanent local
binding, durable operation journal, bounded host exec and result retrieval.
Operator-created host threads now route pi exec through cubed; see
[enrollment](HOST.md#operator-enrollment-and-thread-tools). The control-plane adapter in
`packages/server/src/iroh-node.ts` now calls pinned `@number0/iroh` 1.1.0 **inside
Node**, directly over this protocol. There is no Rust subprocess/stdio bridge
between TypeScript and the host node; the CLI remains independent diagnostic
and host-enrollment tooling. See [HOST.md](HOST.md#in-process-control-plane-client).

## Run locally

Run as an unprivileged development user. Use a new disposable directory; key
files are private, are never overwritten automatically, and must not be committed.
These are node-transport keys, not provider or GitHub credentials.

```sh
cargo build --locked -j 2 -p cube-node-transport
bin="$PWD/target/debug/cube-node-transport"
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
- Request: `{"method":"node.hello","protocolVersion":1}`.
- Response: `{"type":"Hello","nodeId":"node-development","protocolVersion":1,
  "profiles":[],"capabilities":["node.hello"],"limits":{"maxFrameBytes":65536,
  "requestTimeoutMs":5000}}`.
- Rejections use `type: Error`, `code`, a bounded static `message`,
  `completionUnknown` and optional `operationId`. Hello-only errors have no
  mutation uncertainty; host commands distinguish possible delivery and journal
  uncertainty. See [HOST.md](HOST.md) for the durable command contract. The Node
  adapter maps `OUTCOME_UNKNOWN` to `COMPLETION_UNKNOWN`, retaining the operation
  ID. No retry and no offline execution queue.
- At most 16 active handshake/request tasks; each has a five-second deadline.
  Frames are bounded to 64 KiB before allocation. Slow/missing FIN also times out.

Loopback is the default. Rust network commands accept `--network direct` for an
operator-selected unicast IP/port; a direct server additionally requires an
explicit `--listen` interface and rejects wildcard listeners. `--network relay`
instead enables Iroh's N0 preset on both peers: the host waits for a usable home
relay, publishes its address, and callers locate the pinned peer ID through N0
discovery. Iroh attempts direct UDP hole-punching and falls back to end-to-end
encrypted relay traffic. Relay mode has no static `--address` or `--listen`.
It depends on the public N0 discovery/relay service unless a custom relay is added
later. The Rust build disables the portmapper feature. The npm binding has a
separate NAT-portmapping limitation documented in [HOST.md](HOST.md#in-process-control-plane-client).

This is not a VPN, SSH tunnel or plaintext TCP substitute. No browser listener or
network-policy exception is added. Loopback/direct tests remain offline. The
opt-in relay smoke uses the public N0 service; separate-machine acceptance is
still required before calling the host profile production-ready.

## Tests and next boundary

```sh
pnpm install --frozen-lockfile       # includes the native npm addon
cargo fetch --locked                 # setup also does this
bash scripts/test-node-transport.sh  # fmt, clippy, Rust tests + real Node/Rust smoke
CUBE_TEST_IROH_RELAY=1 node scripts/smoke-node-adapter.ts target/debug/cube-node-transport
```

The separate transport CI job installs Node 26, pinned pnpm and Rust, then runs
these checks. The ordinary Node offline list additionally tests the in-process
adapter against a real npm iroh protocol fixture, without building Rust. The
trusted-host binary is packaged separately with `scripts/host/package.sh`; it is
not part of the Incus VM artifacts.

Tests exercise strict framing, unknown versions/methods, loopback-only binding,
separate CLI processes, authenticated hello, key persistence across restart,
wrong client and server keys, wrong logical identity, key file restrictions,
auth rejection before any application message, and idle-connection expiry.

The [host tests](HOST.md) additionally exercise the durable operation/binding
boundary and bounded real shell execution, including crashes and response loss.
The opt-in N0 smoke additionally exercises discovery/relay bootstrap, control-plane
enrollment, registered pi tools, disconnect, host restart and read-only operation
reconciliation. Next: separate-NAT connectivity acceptance and file/repository
transfer. The production profile adds local drain/cancel lifecycle, systemd
packaging, rollback and restore quarantine. File/repository transfer and portal
streams remain unsupported for trusted hosts. Separate-machine acceptance is
required for each release; macOS and Incus execution nodes are not this profile.
