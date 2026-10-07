#!/usr/bin/env bash
# The chat in a real browser (Chromium through Playwright): see DEVELOPING.md.
# CI installs Chromium and runs it; elsewhere a missing Chromium is a SKIP
# notice, and CUBE_TEST_BROWSER=required makes that a failure.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -n "${CI:-}" ]; then
  pnpm --filter @cube/web exec playwright install --with-deps chromium
fi
if ! (cd packages/web && node -e 'const fs = require("node:fs"); process.exit(fs.existsSync(require("playwright").chromium.executablePath()) ? 0 : 1)'); then
  if [ "${CUBE_TEST_BROWSER:-}" = required ]; then
    echo "FAIL: Chromium for Playwright is missing: pnpm --filter @cube/web exec playwright install chromium" >&2
    exit 1
  fi
  echo "SKIP: browser tests (install Chromium: pnpm --filter @cube/web exec playwright install chromium)"
  exit 0
fi
pnpm build
export CUBED_CLAUDE=off
node packages/web/test/browser/chat-browser-test.ts
node packages/web/test/browser/cubed-browser-test.ts
