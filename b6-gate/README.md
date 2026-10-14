# B-6 gate controls (never merge)

Negative controls for PR feat/berth-dial-b6 at `b822cdd2c1d9b2ec220cef9563ce2134c9bf808d`. Each diff applies
to that head; each MUST make the gate fail. a–e are byte-identical to
`b6-gate-controls-3` (`32b06f56`).

| Control | What it breaks | In process | runner-vm-test.ts V9 |
|---|---|---|---|
| a | ports below 1024 allowed | `cargo test -p berth -- dial` fails | fails at the port-80 refusal |
| b | the fence skipped in `dial_target` | `cargo test -p berth -- dial` fails | fails at the old-fence refusal |
| c | FIN replaced by a reset of both directions | `cargo test -p berth -- dial` fails | fails at a portal-contract step |
| d | cubed's `dialStream` as at `bb1c5a38` (F-B6-1) | `node packages/server/test/runner-dial-test.ts` fails (6 of 26 bytes) | not expected to fail |
| e | cube-agent reads cube.0 with `pipe::Receiver` again | `cargo test -p cube-agent --lib -- a_frame_in_two_port_buffers` fails | fails at V9's `writeFile` (needs the keel base rebuilt) |
| f | `withListener`'s probe on a second lease (V9 at `b5e67965`) | `node packages/server/test/runner-dial-test.ts` fails with LEASE_HELD | fails at the port-80 probe with LEASE_HELD (as the b5e67965 gate) |

Apply with `git apply b6-gate/control-X.diff`, rebuild/run, then
`git checkout -- packages`.
