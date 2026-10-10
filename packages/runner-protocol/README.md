# runner-protocol

Runner protocol 4 (`cubeyard/runner/4`): how cubed and a runner
([berth](../berth)) talk over one Iroh connection, one QUIC stream per call.

- `proto/runner.proto` is the only schema. Every stream starts with an
  `Open` frame (u32 length, proto3 JSON); see the file's header.
- The `cube-runner-protocol` crate generates the Rust types at build time
  (protox, prost, pbjson; no system protoc) and holds the framing.
- The same file defines the guest channel of a keel machine: `DaemonFrame`s
  on the virtio-serial port `cube.0`, framed the same way, with
  `machine_setup` (`Boot.documents`, layers, image, the runner's CA) and the
  snapshot operations. `read_daemon_frame` holds a frame to the channel's
  rules.
- cubed's TypeScript types are generated into `packages/server/src/gen`
  (`pnpm proto:generate`); `pnpm proto:check` fails when they differ.
- `proto/fixtures` has one proto3-JSON document per message and oneof case,
  every field set. `packages/server/test/runner-proto-test.ts` derives and
  round-trips them in TypeScript (`--write` after a schema change), and
  `tests/proto_round_trip.rs` round-trips the same files in Rust.
