# Spike 4c: revocation propagation cubed -> berth

Not product code. This measures how fast a `grant_revoke` call from cubed's
`RunnerSession` reaches a real `berth host` over Iroh and makes a gate-like
check refuse. The full report is in /tmp/authz/spike-c.md (method,
environment, numbers, proto sketch, disconnected bound).

- `spike.patch`: apply to HEAD 744c91299 (`git worktree add /tmp/authz/wt-c 744c91299 && git -C /tmp/authz/wt-c apply spike.patch`).
  It adds a spike `grant_revoke` verb to runner.proto (with regenerated TS),
  `packages/berth/src/spike_revoke.rs` (a revoked set checked before the real `Policy::decide`,
  a loopback TCP gate behind `BERTH_SPIKE_GATE`, and the microbenchmark), connection and
  stream logging in serve.rs, `BERTH_SPIKE_RELAY_ONLY` for relay-only runs,
  a phase marker in `RunnerSession.call`, and the two scripts.
- Run:
  `CARGO_TARGET_DIR=/tmp/authz/target-c cargo build --release -p berth`, then
  `node scripts/spike-revoke-timing.ts /tmp/authz/target-c/release/berth loopback /tmp/authz/spike-c/x 2000`
  (or `relay` with `BERTH_SPIKE_RELAY_ONLY=1`; this needs outbound access to the n0 relays),
  `node scripts/spike-revoke-disconnect.ts <berth> loopback kill /tmp/authz/spike-c/d`, and
  `cargo test --release -p berth spike_revoke -- --ignored --nocapture`.
- `results.jsonl`: one line per completed run (ms). `bench.txt`: the microbenchmark (ns).
  `disconnect.jsonl`: when berth noticed cubed was gone. `stalls.txt`: runs that ended on a
  15 s `openBi` stall (and two that ended on a fixed bug in the script's own banner parsing).

Result: on loopback, send -> refusal p99 is 0.4-0.9 ms and over the n0 relay 27-56 ms; every
completed run delivered all revokes. Caveat: an intermittent 15 s stall in `openBi` (Node iroh
binding, roughly 1 in 65 000 calls). Disconnected: about 33 s detection + 15 min lease.
