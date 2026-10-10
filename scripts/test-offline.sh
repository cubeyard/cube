#!/usr/bin/env bash
# Offline Node checks. Real Rust/Iroh execution runs in test-node-transport.sh.
OFFLINE_TESTS=(
  scripts/cubed-release-checksum-test.ts
  scripts/cubed-service-test.ts
  scripts/cubed-signing-key-test.ts
  scripts/ci-test.ts
  scripts/homebrew-formula-test.ts
  scripts/cubed-update-test.ts
  scripts/runner-production-test.ts
  packages/server/test/log-test.ts
  packages/server/test/registry-test.ts
  packages/server/test/runner-slots-test.ts
  packages/server/test/runner-placement-test.ts
  packages/server/test/runner-probe-test.ts
  packages/server/test/runner-observe-test.ts
  packages/server/test/api-test.ts
  packages/server/test/models-test.ts
  packages/server/test/model-auth-test.ts
  packages/server/test/iroh-node-test.ts
  packages/server/test/runner-proto-test.ts
  packages/server/test/runner-enroll-test.ts
  packages/server/test/guest-helper-test.ts
  packages/server/test/workspace-test.ts
  packages/server/test/vm-seed-test.ts
  packages/server/test/egress-policy-test.ts
  packages/server/test/gateway-test.ts
  packages/server/test/vm-workspace-test.ts
  packages/server/test/lifecycle-test.ts
  packages/server/test/vm-template-test.ts
  packages/server/test/vm-prepare-test.ts
  packages/server/test/vm-reattach-test.ts
  packages/server/test/vm-diagnostics-test.ts
  packages/server/test/startup-steps-test.ts
  packages/server/test/thread-start-commits-test.ts
  packages/server/test/durable-agent-test.ts
  packages/server/test/codemode-test.ts
  packages/server/test/pi-read-test.ts
  packages/server/test/thread-events-test.ts
  packages/server/test/transcript-window-test.ts
  packages/server/test/pi-compaction-test.ts
  packages/server/test/optchat-memory-test.ts
  packages/server/test/optchat-view-test.ts
  packages/server/test/optchat-view-reopen-test.ts
  packages/server/test/optchat-compaction-view-test.ts
  packages/server/test/optchat-compaction-reopen-test.ts
  packages/server/test/optchat-test.ts
  packages/server/test/optchat-product-test.ts
  packages/server/test/optchat-cache-test.ts
  packages/server/test/optchat-history-test.ts
  packages/server/test/thread-history-test.ts
  packages/server/test/thread-images-test.ts
  packages/server/test/optchat-archive-test.ts
  packages/server/test/optchat-hooks-test.ts
  packages/server/test/optchat-media-test.ts
  packages/server/test/optchat-start-test.ts
  packages/server/test/optchat-events-test.ts
  packages/server/test/settings-test.ts
  packages/server/test/skills-test.ts
  packages/server/test/claude-agent-test.ts
  packages/server/test/usage-test.ts
  packages/server/test/portal-test.ts
  packages/server/test/artifacts-test.ts
  packages/server/test/artifact-notices-test.ts
  packages/server/test/artifact-tools-test.ts
  packages/server/test/artifact-sharing-test.ts
  scripts/smoke-local.ts
  packages/web/test/transcript-test.ts
  packages/web/test/markdown-test.ts
  packages/web/test/artifact-render-test.ts
  packages/web/test/ordered-test.ts
  packages/web/test/images-test.ts
  packages/web/test/outbox-test.ts
  packages/web/test/startup-test.ts
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
  # CUBE_TEST_SHARD=K/N runs every Nth suite from the Kth (CI runs N shards
  # side by side); --list prints the shard's suites instead of running them.
  shard="${CUBE_TEST_SHARD:-1/1}"
  if ! [[ "$shard" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] || (( BASH_REMATCH[1] > BASH_REMATCH[2] )); then
    echo "FAIL: CUBE_TEST_SHARD must be K/N with 1 <= K <= N, not '$shard'" >&2
    exit 2
  fi
  index=$(( BASH_REMATCH[1] - 1 )) count=${BASH_REMATCH[2]}
  suites=()
  for i in "${!OFFLINE_TESTS[@]}"; do
    (( i % count == index )) && suites+=("${OFFLINE_TESTS[$i]}")
  done
  if [ "${1:-}" = --list ]; then
    printf '%s\n' "${suites[@]}"
    exit 0
  fi
  # Never start an installed Claude Code from tests; they use a fake.
  export CUBED_CLAUDE=off
  failed=()
  for t in "${suites[@]}"; do
    printf '\n==== %s ====\n' "$t"
    node "$t" || failed+=("$t")
  done
  if [ "${#failed[@]}" -gt 0 ]; then
    printf 'FAIL: %s\n' "${failed[@]}"
    exit 1
  fi
  echo "ALL PASS (${#suites[@]} of ${#OFFLINE_TESTS[@]} offline suites, shard $shard)"
fi
