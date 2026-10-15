# Authorization spikes, 2026-10-15

Throwaway measurement code for the authorization plan. Not product code, not
part of the pnpm workspace or the root Cargo workspace. Thresholds were fixed
before measuring (kept outside the repo, in /tmp/authz/thresholds.md on the
machine that ran them).

Other directories here belong to other spikes of the same plan.

## biscuit-bench (4a, 4b): biscuit-auth in the gate

Rust crate with its own empty `[workspace]` and its own Cargo.lock.

```sh
cd spikes/2026-10-15-authorization/biscuit-bench
export CARGO_TARGET_DIR=/tmp/authz/target
cargo run --release --bin fixtures            # Datalog fixtures, Rust verdicts
cargo run --release --bin shapes              # why the draft approval shape was changed
cargo run --release --bin percentiles 100000  # p50/p99 per action (hdrhistogram)
cargo run --release --bin breakdown           # where one authorization spends its time
cargo bench --bench gate                      # criterion
```

## biscuit-ts (4b): biscuit-wasm in Node 26

Run with Node's type stripping. biscuit-wasm is installed outside the repo:

```sh
npm install --prefix /tmp/authz/node-biscuit @biscuit-auth/biscuit-wasm@0.6.0
cd spikes/2026-10-15-authorization/biscuit-ts
node gen-fixtures.ts               # rewrites packages/runner-protocol/fixtures/authz/datalog
node run-fixtures.ts --warmup      # TS verdicts (see the file header for --warmup)
node run-fixtures.ts --bench 10000 # informational timings
```

Set `BISCUIT_WASM` to another `module/biscuit.js` path if installed elsewhere.

Cross-check (tokens minted in one language, verified and authorized in the
other):

```sh
node run-fixtures.ts --warmup --mint-to /tmp/authz/xcheck/ts
(cd ../biscuit-bench && cargo run --release --bin fixtures -- --mint-to /tmp/authz/xcheck/rust)
(cd ../biscuit-bench && cargo run --release --bin fixtures -- --verify-from /tmp/authz/xcheck/ts)
node run-fixtures.ts --warmup --verify-from /tmp/authz/xcheck/rust
```

The fixtures' keys are TEST ONLY: sha256 of a fixed label, written into
each fixture.

## capture (step 2): traffic at the gate

- `authz-capture-p4.ts`: protocol 4. Copy it to `packages/server/test/` to
  run (it imports cubed's sources); it needs the `CUBE_TEST_BERTH_*`
  environment of `runner-vm-cubed-test.ts`, a `berth` built with
  `berth-gate-record.patch` and a private, disposable GitHub repository:
  `node packages/server/test/authz-capture-p4.ts <berth> <owner/repo> <out.jsonl>`.
  The host's GitHub token (`gh auth token`) is the `github` secret; it never
  enters the guest or the recording.
- `capture.ts`: the same scenarios on protocol 3 (cube-runner and a
  cube-gateway built with `gateway-record.patch`), used only as a control.
- `facts.ts`: what a gate can derive from one request (git pkt-lines,
  GitHub REST by OpenAPI operation, GraphQL with graphql-js); needs
  `graphql@16` installed outside the repository and a `[{method, path, id}]`
  list of GitHub's operations from github/rest-api-description.
- `redact.ts`: the recording as the fixture corpus.
- `replay.ts`: the corpus against the plan's Datalog with biscuit-wasm;
  writes `p4-berth-gate.expected.json`.

## passkeys (4d) and revocation (4c)

See the README in each directory.
