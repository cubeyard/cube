#!/usr/bin/env bash
# Rust transport tests are separate from the released Node/Incus VM portfolio:
# no Rust executable is shipped or wired into cubed yet. Fetch locked crates in
# setup first; these tests themselves must not need registry or relay access.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo fmt --all --check
cargo clippy --locked --offline --all-targets -j 2 -- -D warnings
# shellcheck source=scripts/test-offline.sh
source scripts/test-offline.sh
for package in "${RUST_OFFLINE_PACKAGES[@]}"; do
  cargo test --locked --offline -p "$package" -j 2
done
