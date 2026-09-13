# Node transport bootstrap

**Development-only; not wired into cubed, the agent tools or release artifacts.**
Real iroh 1.2.0, pinned in Cargo.lock, using Rust 1.91.0. This first slice implements
only `node.hello`, not environment binding, durable commands, files or host exec.
It deliberately advertises no execution profiles and no other capabilities.

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
- One QUERY per connection in this bootstrap, on one bidirectional stream.
  Both directions carry a four-byte big-endian payload length, then exactly that
  many UTF-8 JSON bytes and FIN. Empty, oversized, truncated, trailing or unknown
  request fields fail closed. Unsupported methods are not executed.
- Request: `{"method":"node.hello","protocolVersion":1}`.
- Response: `{"type":"Hello","nodeId":"node-development","protocolVersion":1,
  "profiles":[],"capabilities":["node.hello"],"limits":{"maxFrameBytes":65536,
  "requestTimeoutMs":5000}}`.
- Rejections use `type: Error`, `code`, a bounded static `message`, and
  `completionUnknown: false` (this slice has no mutations). Client-side connect,
  identity, frame and deadline failures are local CLI/library errors, not yet the
  control-plane error mapping. No retry and no offline queue.
- At most 16 active handshake/request tasks; each has a five-second deadline.
  Frames are bounded to 64 KiB before allocation. Slow/missing FIN also times out.

Only explicitly bound loopback UDP sockets are enabled. Relay transports, address
lookup/discovery and port mapping are disabled. There is no public socket, VPN,
SSH tunnel, plaintext TCP substitute, or extra network allowlist expansion.
The browser/control-plane boundary is untouched. This proves real transport
between processes on one machine, **not** remote reachability or relay traversal.

## Tests and next boundary

```sh
cargo fetch --locked                 # setup also does this
bash scripts/test-node-transport.sh  # fmt, clippy, real QUIC tests; --offline
```

The separate Rust CI job runs these checks; the existing Node offline/VM suites
remain unchanged because no Rust binary is shipped into those VMs yet.

Tests exercise strict framing, unknown versions/methods, loopback-only binding,
separate CLI processes, authenticated hello, key persistence across restart,
wrong client and server keys, wrong logical identity, key file restrictions,
auth rejection before any application message, and idle-connection expiry.

Next: a durable node-owned operation journal and bounded host exec/output with
restart/uncertain-outcome acceptance, followed by the control-plane transport
adapter. Before accepting mutations, implement immutable environment bindings,
per-environment authorization, durable request IDs/hashes and reconciliation;
do not simply add shell dispatch to this hello handler. External iroh connectivity,
thread communication, cancellation, file/repository transfer and portal streams
remain separate follow-ups. No real remote machine, macOS or Incus acceptance
has been performed.
