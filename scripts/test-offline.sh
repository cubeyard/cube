#!/usr/bin/env bash
# Offline Node checks. Real Rust/Iroh execution runs in test-node-transport.sh.
OFFLINE_TESTS=(
  scripts/host-production-test.ts
  scripts/runner-production-test.ts
  packages/server/test/log-test.ts
  packages/server/test/registry-test.ts
  packages/server/test/api-test.ts
  packages/server/test/models-test.ts
  packages/server/test/jev-memory-test.ts
  packages/server/test/model-auth-test.ts
  packages/server/test/iroh-node-test.ts
  packages/server/test/github-auth-test.ts
  packages/server/test/github-read-test.ts
  packages/server/test/onboarding-test.ts
  packages/git/test/git-service-test.ts
)
# shellcheck disable=SC2034
RUST_OFFLINE_PACKAGES=(cube-runner)
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -uo pipefail
  cd "$(dirname "$0")/.." || exit 1
  failed=()
  for t in "${OFFLINE_TESTS[@]}"; do
    printf '\n==== %s ====\n' "$t"
    node "$t" || failed+=("$t")
  done
  if [ "${#failed[@]}" -gt 0 ]; then
    printf 'FAIL: %s\n' "${failed[@]}"
    exit 1
  fi
  echo "ALL PASS (${#OFFLINE_TESTS[@]} offline suites)"
fi
