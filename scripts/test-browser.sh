#!/usr/bin/env bash
# The chat in a real browser (Chromium through Playwright): see DEVELOPING.md.
# Elsewhere a missing Chromium is a SKIP notice, and CUBE_TEST_BROWSER=required
# makes that a failure. The phone layout also runs in WebKit, Safari's engine,
# when Playwright has it; in CI both are required. CI's browser job runs in
# Playwright's own image, which has both browsers and their system libraries;
# CI without them installs them here (scripts/setup-browsers.sh). A thread
# machine has Chromium from .agents/setup.
set -euo pipefail
cd "$(dirname "$0")/.."
if ! (cd packages/web && node -e 'require.resolve("playwright")' 2>/dev/null); then
  echo "FAIL: playwright is not installed: pnpm install --frozen-lockfile" >&2
  exit 1
fi
# Whether this Playwright's browsers named in the arguments are all installed.
has_browsers() {
  (cd packages/web && node -e 'const fs = require("node:fs"); const pw = require("playwright");
    process.exit(process.argv.slice(1).every((name) => fs.existsSync(pw[name].executablePath())) ? 0 : 1)' "$@")
}
if [ -n "${CI:-}" ]; then
  bash scripts/setup-browsers.sh chromium webkit
fi
if ! has_browsers chromium; then
  if [ "${CUBE_TEST_BROWSER:-}" = required ]; then
    echo "FAIL: Chromium for Playwright $(cd packages/web && node -p 'require("playwright/package.json").version') is missing: bash scripts/setup-browsers.sh" >&2
    exit 1
  fi
  echo "SKIP: browser tests (install Chromium: bash scripts/setup-browsers.sh)"
  exit 0
fi
pnpm build
export CUBED_CLAUDE=off
node packages/web/test/browser/chat-browser-test.ts
node packages/web/test/browser/composer-focus-browser-test.ts
node packages/web/test/browser/chat-sheet-browser-test.ts
node packages/web/test/browser/loading-browser-test.ts
node packages/web/test/browser/panel-browser-test.ts
node packages/web/test/browser/reports-browser-test.ts
node packages/web/test/browser/thread-links-browser-test.ts
node packages/web/test/browser/thread-names-browser-test.ts
node packages/web/test/browser/tool-groups-browser-test.ts
node packages/web/test/browser/thread-tool-groups-browser-test.ts
node packages/web/test/browser/long-chat-browser-test.ts
node packages/web/test/browser/mobile-browser-test.ts
node packages/web/test/browser/cubed-browser-test.ts
node packages/web/test/browser/artifact-browser-test.ts
node packages/web/test/browser/diagram-browser-test.ts
node packages/web/test/browser/settings-browser-test.ts
node packages/web/test/browser/runners-browser-test.ts
node packages/web/test/browser/skills-browser-test.ts
node packages/web/test/browser/startup-browser-test.ts
# The verify-cube skill's safety and its recipe, every journey
# (.agents/skills/verify-cube). With CUBE_SCREENSHOTS (CI uploads it) the
# evidence stays there; otherwise in a temporary directory removed on success.
node packages/web/test/browser/verify-cube-test.ts
if [ -n "${CUBE_SCREENSHOTS:-}" ]; then
  verify="$CUBE_SCREENSHOTS/verify-cube"
else
  verify=$(mktemp -d)
fi
.agents/skills/verify-cube/verify-cube run --run "$verify/run" chat project thread spawn cli
if [ -z "${CUBE_SCREENSHOTS:-}" ]; then rm -rf "$verify"; fi
