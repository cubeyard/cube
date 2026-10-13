# B-6 gate controls (never merge)

Negative controls for PR feat/berth-dial-b6 at `bb1c5a383240681fe8cec7b8a2119604b229c758`. Each diff
applies to that head; each MUST make the gate fail.

| Control | What it breaks | In process (`cargo test -p berth -- dial`) | runner-vm-test.ts V9 |
|---|---|---|---|
| a | ports below 1024 allowed | fails: port tests | fails at the port-80 refusal (the root listener answers) |
| b | the fence skipped in `dial_target` | fails: `a_dial_is_fenced_owned_and_needs_a_running_machine` | fails at the old-fence refusal (the dial goes through) |
| c | FIN replaced by a reset of both directions | fails: `a_dial_carries_a_mebibyte_each_way_and_each_fin_on_its_own` | fails at a FIN step of the portal contract |

Apply with `git apply b6-gate/control-X.diff`, rebuild berth, run, then
`git checkout -- packages`.
