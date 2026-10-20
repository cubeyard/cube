#!/usr/bin/env bash
# Rust runner and gateway, runner packaging, and runner acceptance with a real
# VM. Install locked Node/Cargo dependencies in setup first; no registry
# fetches here.
#
# The real-VM part needs Linux with a usable /dev/kvm, QEMU >= 7.2 (with
# qemu-img) and a Debian 13 genericcloud image in CUBE_TEST_VM_IMAGE. Without
# them it is skipped with a notice (mocks are not runner acceptance);
# CUBE_TEST_VM=required turns the skip into a failure.
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
cargo build --locked --offline -p cube-runner -p cube-gateway -p berth -j 2
node scripts/runner-production-test.ts
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
# cubed's local runner setup with the real cube-runner and the fake QEMU.
node scripts/test-local-runner.ts "${CARGO_TARGET_DIR:-target}/debug/cube-runner"
for script in scripts/runner/*.sh; do bash -n "$script"; done

target="${CARGO_TARGET_DIR:-target}/debug"
missing=()
[ "$(uname -s)" = Linux ] || missing+=("Linux (macOS HVF is not verified yet)")
{ [ -r /dev/kvm ] && [ -w /dev/kvm ]; } || missing+=("a usable /dev/kvm (group kvm)")
command -v qemu-system-x86_64 >/dev/null && command -v qemu-img >/dev/null || missing+=("qemu-system-x86_64 and qemu-img")
command -v ssh >/dev/null && command -v ssh-keygen >/dev/null || missing+=("ssh and ssh-keygen")
{ [ -n "${CUBE_TEST_VM_IMAGE:-}" ] && [ -f "${CUBE_TEST_VM_IMAGE}" ]; } \
  || missing+=("CUBE_TEST_VM_IMAGE=<debian-13-genericcloud-amd64.qcow2>")
if [ "${#missing[@]}" -gt 0 ]; then
  printf '\nSKIP: runner acceptance with a real VM did NOT run; missing:\n' >&2
  printf '  - %s\n' "${missing[@]}" >&2
  [ "${CUBE_TEST_VM:-}" != required ] || exit 1
  exit 0
fi
node scripts/smoke-runner-vm.ts "$target/cube-runner" "$target/cube-gateway" "$CUBE_TEST_VM_IMAGE"
# cubed's side with the same real pieces: protocol-3 client, gateway
# supervision, egress policy, ThreadVms, the Workspace contract over SSH.
node scripts/smoke-node-adapter.ts "$target/cube-runner" "$target/cube-gateway" "$CUBE_TEST_VM_IMAGE"
# The product end to end: a disposable cubed with real VMs (scripts/test-vm-e2e.ts).
node scripts/test-vm-e2e.ts "$target/cube-runner" "$CUBE_TEST_VM_IMAGE"
# Two thread VMs on one runner (--max-active-vms 2): bound, isolation, slots.
node scripts/test-vm-concurrency.ts "$target/cube-runner" "$target/cube-gateway" "$CUBE_TEST_VM_IMAGE"
# Machine templates: a build machine, publication, machines from the template
# side by side, invalidation, resume after a runner restart, a failed build.
node scripts/test-vm-templates.ts "$target/cube-runner" "$target/cube-gateway" "$CUBE_TEST_VM_IMAGE"
