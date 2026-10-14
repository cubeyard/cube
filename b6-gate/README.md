# B-6 gate controls (never merge)

Negative controls for PR feat/berth-dial-b6 at `b5e679653ffc4d81a8ab57a7cb547eb751242fab`. Each diff applies
to that head; each MUST make the gate fail. a–d are byte-identical to
`b6-gate-controls-2` (`57c5123d`).

| Control | What it breaks | In process | runner-vm-test.ts V9 |
|---|---|---|---|
| a | ports below 1024 allowed | `cargo test -p berth -- dial` fails | fails at the port-80 refusal |
| b | the fence skipped in `dial_target` | `cargo test -p berth -- dial` fails | fails at the old-fence refusal |
| c | FIN replaced by a reset of both directions | `cargo test -p berth -- dial` fails | fails at a portal-contract step |
| d | cubed's `dialStream` as at `bb1c5a38` (F-B6-1) | `node packages/server/test/runner-dial-test.ts` fails (6 of 26 bytes) | not expected to fail |
| e | cube-agent reads cube.0 with `pipe::Receiver` again (the stall) | `cargo test -p cube-agent --lib -- a_frame_in_two_port_buffers` fails (no answer in 10 s) | fails at V9's `writeFile` of dial-app.pl (60 s, COMPLETION_UNKNOWN), as the eb897f77 gate did; needs the keel base rebuilt |

Apply with `git apply b6-gate/control-X.diff`, rebuild/run, then
`git checkout -- packages`.
