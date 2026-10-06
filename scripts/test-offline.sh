#!/usr/bin/env bash
# Offline Node checks. Real Rust/Iroh execution runs in test-node-transport.sh.
OFFLINE_TESTS=(
  scripts/cubed-release-checksum-test.ts
  scripts/cubed-service-test.ts
  scripts/cubed-signing-key-test.ts
  scripts/cubed-update-test.ts
  scripts/runner-production-test.ts
  packages/server/test/log-test.ts
  packages/server/test/registry-test.ts
  packages/server/test/runner-slots-test.ts
  packages/server/test/runner-probe-test.ts
  packages/server/test/runner-observe-test.ts
  packages/server/test/api-test.ts
  packages/server/test/models-test.ts
  packages/server/test/model-auth-test.ts
  packages/server/test/iroh-node-test.ts
  packages/server/test/guest-helper-test.ts
  packages/server/test/workspace-test.ts
  packages/server/test/vm-seed-test.ts
  packages/server/test/egress-policy-test.ts
  packages/server/test/gateway-test.ts
  packages/server/test/vm-workspace-test.ts
  packages/server/test/vm-template-test.ts
  packages/server/test/vm-prepare-test.ts
  packages/server/test/durable-agent-test.ts
  packages/server/test/codemode-test.ts
  packages/server/test/thread-events-test.ts
  packages/server/test/pi-compaction-test.ts
  packages/server/test/optchat-memory-test.ts
  packages/server/test/optchat-test.ts
  packages/server/test/optchat-product-test.ts
  packages/server/test/optchat-cache-test.ts
  packages/server/test/optchat-history-test.ts
  packages/server/test/thread-history-test.ts
  packages/server/test/optchat-archive-test.ts
  packages/server/test/claude-agent-test.ts
  packages/server/test/usage-test.ts
  scripts/smoke-local.ts
  packages/web/test/transcript-test.ts
  packages/web/test/markdown-test.ts
  packages/web/test/ordered-test.ts
  packages/server/test/github-auth-test.ts
  packages/server/test/github-read-test.ts
  packages/server/test/onboarding-test.ts
  packages/git/test/git-service-test.ts
)
# shellcheck disable=SC2034
RUST_OFFLINE_PACKAGES=(cube-runner cube-gateway)
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -uo pipefail
  cd "$(dirname "$0")/.." || exit 1
  # Never start an installed Claude Code from tests; they use a fake.
  export CUBED_CLAUDE=off
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
