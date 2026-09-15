#!/usr/bin/env bash
# Rust host plus in-process npm iroh interoperability. Separate from the
# released Node/Incus VM portfolio: no Rust host binary is shipped there yet.
# Install locked Node/Cargo dependencies in setup first; no registry fetches here.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo fmt --all --check
cargo clippy --locked --offline --all-targets -j 2 -- -D warnings
# shellcheck source=scripts/test-offline.sh
source scripts/test-offline.sh
for package in "${RUST_OFFLINE_PACKAGES[@]}"; do
  cargo test --locked --offline -p "$package" -j 2
done

# Build explicitly: cargo test's internal artifacts are not the smoke's binary.
cargo build --locked --offline -p cube-node-transport -j 2
node scripts/smoke-node-adapter.ts "${CARGO_TARGET_DIR:-target}/debug/cube-node-transport"
