#!/usr/bin/env bash
# Offline Node checks. Real Rust/Iroh execution runs in test-node-transport.sh.
OFFLINE_TESTS=(
  scripts/cubed-release-checksum-test.ts
  scripts/cubed-service-test.ts
  scripts/cubed-signing-key-test.ts
  scripts/ci-test.ts
  scripts/homebrew-formula-test.ts
  scripts/cubed-update-test.ts
  scripts/keel-boot-check-test.ts
  scripts/keel-release-test.ts
  scripts/berth-release-test.ts
  scripts/fake-github-test.ts
  packages/server/test/log-test.ts
  packages/server/test/registry-test.ts
  packages/server/test/thread-names-test.ts
  packages/server/test/runner-slots-test.ts
  packages/server/test/machine-sleep-test.ts
  packages/server/test/thread-condition-test.ts
  packages/server/test/thread-failure-test.ts
  packages/server/test/thread-phase-test.ts
  packages/server/test/start-failure-publication-test.ts
  packages/server/test/wake-guards-test.ts
  packages/server/test/optchat-run-feed-test.ts
  packages/server/test/optchat-run-watch-test.ts
  packages/server/test/archive-timing-test.ts
  packages/server/test/runner-suspend-test.ts
  packages/server/test/thread-lifecycle-test.ts
  packages/server/test/lifecycle-model-test.ts
  packages/server/test/cubed-wake-test.ts
  packages/server/test/runner-placement-test.ts
  packages/server/test/runner-host-placement-test.ts
  packages/server/test/berth-banner-test.ts
  packages/server/test/gateway-pids-test.ts
  packages/server/test/protocol3-history-test.ts
  packages/server/test/protocol3-port-test.ts
  packages/server/test/runner-probe-test.ts
  packages/server/test/runner-observe-test.ts
  packages/server/test/api-test.ts
  packages/server/test/reattach-step-test.ts
  packages/server/test/models-test.ts
  packages/server/test/model-auth-test.ts
  packages/server/test/runner-proto-test.ts
  packages/server/test/runner-enroll-test.ts
  packages/server/test/runner-status-test.ts
  packages/server/test/guest-helper-test.ts
  packages/server/test/workspace-test.ts
  packages/server/test/vm-seed-test.ts
  packages/server/test/egress-policy-test.ts
  packages/server/test/runner-credentials-test.ts
  packages/server/test/runner-dial-test.ts
  packages/server/test/runner-vm-machines-test.ts
  packages/server/test/runner-vm-templates-test.ts
  packages/server/test/leak-scan-test.ts
  packages/server/test/gateway-test.ts
  packages/server/test/vm-workspace-test.ts
  packages/server/test/lifecycle-test.ts
  packages/server/test/thread-down-test.ts
  packages/server/test/thread-steer-test.ts
  packages/server/test/cubed-boot-close-test.ts
  packages/server/test/vm-template-test.ts
  packages/server/test/vm-diagnostics-test.ts
  packages/server/test/startup-steps-test.ts
  packages/server/test/thread-start-commits-test.ts
  packages/server/test/durable-agent-test.ts
  packages/server/test/codemode-test.ts
  packages/server/test/pi-read-test.ts
  packages/server/test/pi-upgrade-test.ts
  packages/server/test/pi-restart-test.ts
  packages/server/test/thread-events-test.ts
  packages/server/test/transcript-window-test.ts
  packages/server/test/pi-compaction-test.ts
  packages/server/test/optchat-memory-test.ts
  packages/server/test/optchat-view-test.ts
  packages/server/test/optchat-view-reopen-test.ts
  packages/server/test/optchat-compaction-view-test.ts
  packages/server/test/optchat-compaction-reopen-test.ts
  packages/server/test/optchat-compactor-test.ts
  packages/server/test/optchat-compactor-output-test.ts
  packages/server/test/optchat-compactor-hold-test.ts
  packages/server/test/optchat-test.ts
  packages/server/test/optchat-fail-closed-test.ts
  packages/server/test/pi-sends-test.ts
  packages/server/test/cubed-close-test.ts
  packages/server/test/cubed-drain-test.ts
  packages/server/test/optchat-output-test.ts
  scripts/gate-close.ts
  packages/server/test/optchat-product-test.ts
  packages/server/test/optchat-cache-test.ts
  packages/server/test/optchat-gpt6-test.ts
  packages/server/test/optchat-cache-path-test.ts
  packages/server/test/optchat-close-test.ts
  packages/server/test/optchat-replay-test.ts
  packages/server/test/optchat-view-fault-test.ts
  packages/server/test/optchat-history-test.ts
  packages/server/test/thread-history-test.ts
  packages/server/test/thread-images-test.ts
  packages/server/test/optchat-archive-test.ts
  packages/server/test/optchat-passive-test.ts
  packages/server/test/optchat-restart-test.ts
  packages/server/test/optchat-reports-test.ts
  packages/server/test/optchat-hooks-test.ts
  packages/server/test/optchat-media-test.ts
  packages/server/test/optchat-start-test.ts
  packages/server/test/optchat-events-test.ts
  packages/server/test/optchat-delegation-test.ts
  packages/server/test/settings-test.ts
  packages/server/test/skills-test.ts
  packages/server/test/claude-agent-test.ts
  packages/server/test/usage-test.ts
  packages/server/test/telemetry-test.ts
  packages/server/test/portal-test.ts
  packages/server/test/artifacts-test.ts
  packages/server/test/artifact-notices-test.ts
  packages/server/test/artifact-tools-test.ts
  packages/server/test/artifact-sharing-test.ts
  packages/server/test/artifact-diagrams-test.ts
  packages/server/test/claude-artifact-edit-test.ts
  scripts/smoke-local.ts
  packages/web/test/transcript-test.ts
  packages/web/test/markdown-test.ts
  packages/web/test/artifact-render-test.ts
  packages/web/test/ordered-test.ts
  packages/web/test/images-test.ts
  packages/web/test/outbox-test.ts
  packages/web/test/startup-test.ts
  packages/web/test/thread-state-test.ts
  packages/web/test/thinking-cube-test.ts
  packages/web/test/report-line-test.ts
  packages/web/test/tool-groups-test.ts
  packages/web/test/provenance-test.ts
  packages/web/test/thread-list-poll-test.ts
  packages/server/test/github-auth-test.ts
  packages/server/test/github-read-test.ts
  packages/server/test/onboarding-test.ts
  packages/git/test/git-service-test.ts
)
# shellcheck disable=SC2034
RUST_OFFLINE_PACKAGES=(cube-gateway cube-netstack cube-runner-protocol berth keel-layers cube-agent keel-agent-check)
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
