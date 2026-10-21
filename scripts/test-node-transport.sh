#!/usr/bin/env bash
# The Rust crates (berth, keel's, cube-gateway, cube-netstack, the runner
# protocol) and runner acceptance with the real `berth host` and `berth vm`.
# Install locked Node/Cargo dependencies in setup first; no registry fetches
# here.
#
# The `berth vm` parts need KVM or HVF and CUBE_TEST_BERTH_* (DEVELOPING.md);
# without them they are skipped with a notice (mocks are not runner
# acceptance), and CUBE_TEST_BERTH_VM=required makes that a failure.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo fmt --all --check
cargo clippy --locked --offline --all-targets -j 2 -- -D warnings
# shellcheck source=scripts/test-offline.sh
source scripts/test-offline.sh
for package in "${RUST_OFFLINE_PACKAGES[@]}"; do
  cargo test --locked --offline -p "$package" -j 2
done

# Build explicitly: cargo test's internal artifacts are not the smoke's binaries.
cargo build --locked --offline -p cube-gateway -p berth -j 2
# cubed's supervision of the real cube-gateway (the credential proxy).
node packages/server/test/gateway-test.ts "${CARGO_TARGET_DIR:-target}/debug/cube-gateway"
# Runner protocol 4 with the real `berth host` (loopback, a temporary
# directory, unsandboxed by design): the session, the Workspace contract over
# guest streams, and cubed placing, preparing, waiting for and archiving
# threads named to it.
node packages/server/test/runner-host-test.ts "${CARGO_TARGET_DIR:-target}/debug/berth"
node packages/server/test/runner-host-cubed-test.ts "${CARGO_TARGET_DIR:-target}/debug/berth"
# runner-vm-test's host-side token scan, without grep (macOS's BSD grep
# exits 2 on a machine's sockets): here so the macOS job runs it too.
node packages/server/test/leak-scan-test.ts
# `berth vm` (masterplan B-1, B-2): it refuses to start without QEMU by path
# and refuses CUBE_TEST_BERTH_OLD_QEMU (below keel's floor); with
# CUBE_TEST_BERTH_{QEMU,QEMU_IMG,KEEL,IMAGE,MKFS} it pulls the image and runs
# keel machines over the guest channel (else skipped).
node packages/server/test/runner-vm-test.ts "${CARGO_TARGET_DIR:-target}/debug/berth"
# cubed's real code with `berth vm` (C-a): a thread started on it by name,
# with the same environment (else skipped).
node packages/server/test/runner-vm-cubed-test.ts "${CARGO_TARGET_DIR:-target}/debug/berth"
# V3 through cubed on `berth vm`: cubed, its gateway and the guest agent killed mid-command (else skipped).
node packages/server/test/runner-vm-cubed-v3-test.ts "${CARGO_TARGET_DIR:-target}/debug/berth"
# V13: two machines on one `berth vm` kept apart: placeholders, LANs, a flood (else skipped).
node packages/server/test/runner-vm-v13-test.ts "${CARGO_TARGET_DIR:-target}/debug/berth"
# S-7a (G-F): a machine suspended while a command runs and resumed, then a
# snapshot of another berth booted cold (else skipped).
node packages/server/test/runner-vm-suspend-test.ts "${CARGO_TARGET_DIR:-target}/debug/berth"
# #208: machine_suspend waits at most 5 s for another operation on the
# runner, then is refused busy and never runs later (else skipped).
node packages/server/test/runner-vm-suspend-ops-test.ts "${CARGO_TARGET_DIR:-target}/debug/berth"
# P7-5 (N1–N7): cubed's real 30 s loop suspends an idle machine on `berth vm`,
# never during a command, a dial or a registered service, and wakes it by a
# message, a guest call or the portal; one slot, a cold start (else skipped).
node packages/server/test/runner-vm-cubed-suspend-test.ts "${CARGO_TARGET_DIR:-target}/debug/berth"
# cubed's local runner setup (runners init-local) with the real berth vm, and
# a second run that changes nothing (else skipped).
node scripts/test-local-berth.ts "${CARGO_TARGET_DIR:-target}/debug/berth"
