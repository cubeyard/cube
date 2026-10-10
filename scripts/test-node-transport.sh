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
cargo build --locked --offline -p cube-runner -p cube-gateway -j 2
node scripts/runner-production-test.ts
# Runner protocol 4 with the real cube-runner host (loopback, a temporary
# directory, unsandboxed by design): the session, the Workspace contract over
# guest streams, and cubed placing, preparing, waiting for and archiving
# threads named to it.
node packages/server/test/runner-host-test.ts "${CARGO_TARGET_DIR:-target}/debug/cube-runner"
node packages/server/test/runner-host-cubed-test.ts "${CARGO_TARGET_DIR:-target}/debug/cube-runner"
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
