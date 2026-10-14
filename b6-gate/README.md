# B-6 gate controls (never merge)

Negative controls for PR feat/berth-dial-b6 at `eb897f771775b951fde46223546d8d1f2a051116`. Each diff
applies to that head; each MUST make the gate fail. a–c are byte-identical
to `b6-gate-controls` (`7de4dca8`, for the previous head `bb1c5a38`).

| Control | What it breaks | In process | runner-vm-test.ts V9 |
|---|---|---|---|
| a | ports below 1024 allowed | `cargo test -p berth -- dial` fails: port tests | fails at the port-80 refusal |
| b | the fence skipped in `dial_target` | `cargo test -p berth -- dial` fails: the fence unit test | fails at the old-fence refusal |
| c | FIN replaced by a reset of both directions | `cargo test -p berth -- dial` fails: the 1 MiB/FIN test | fails at a portal-contract step |
| d | cubed's `dialStream` as at `bb1c5a38` (destroy() drops queued writes, F-B6-1) | `node packages/server/test/runner-dial-test.ts` fails: 6 of 26 bytes before the FIN | not expected to fail (the window needs queued small writes) |

Apply with `git apply b6-gate/control-X.diff`, rebuild/run, then
`git checkout -- packages`.
