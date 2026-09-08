#!/usr/bin/env bash
# The offline test suites — every test that needs neither Incus nor a
# VM. ONE list, used by CI (.github/workflows/ci.yml) on every push and
# by the VM portfolio (scripts/vm/run-tests.sh), which sources this file
# and appends the real-Incus smokes.
#
#   bash scripts/test-offline.sh        # run them all, from any host
OFFLINE_TESTS=(
  scripts/release-contract-test.ts
  packages/server/test/cube-toml-test.ts
  packages/server/test/portal-config-test.ts
  packages/server/test/portal-proxy-test.ts
  packages/server/test/registry-test.ts
  packages/server/test/services-test.ts
  packages/server/test/workspace-files-test.ts
  packages/server/test/github-auth-test.ts
  packages/server/test/onboarding-test.ts
  packages/server/test/pty-test.ts
  packages/server/test/terminal-guards-test.ts
  packages/server/test/project-test.ts
  packages/sandbox/test/mock-backend-test.ts
  packages/git/test/git-service-test.ts
  packages/pi-extension/test/code-mode-test.ts
  packages/pi-extension/test/pi-extension-test.ts
  packages/pi-extension/test/diagnostics-test.ts
)

# Executed (not sourced): run the list.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -uo pipefail
  cd "$(dirname "$0")/.."
  # No model credentials anywhere near tests. Some suites read pi's model
  # catalog (never prompt); a placeholder key makes the deepseek models
  # "available" and its value is never sent anywhere.
  export DEEPSEEK_API_KEY="${DEEPSEEK_API_KEY:-placeholder-cube-tests}"
  failed=()
  for t in "${OFFLINE_TESTS[@]}"; do
    echo
    echo "==== $t ===="
    node "$t" || failed+=("$t")
  done
  echo
  if [ "${#failed[@]}" -gt 0 ]; then
    printf 'FAIL: %s\n' "${failed[@]}"
    exit 1
  fi
  echo "ALL PASS (${#OFFLINE_TESTS[@]} offline suites)"
fi
