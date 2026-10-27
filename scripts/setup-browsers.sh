#!/usr/bin/env bash
# The browsers the browser tests use (scripts/test-browser.sh), for the
# Playwright packages/web pins: `bash scripts/setup-browsers.sh [chromium]
# [webkit]`, Chromium alone without arguments. .agents/setup runs it, so a
# thread machine (and its template) has Chromium; CI runs it for both.
#
# Idempotent. A browser counts as usable only when it launches and renders a
# page: then nothing is downloaded or installed. Otherwise Playwright
# downloads what this version lacks into its cache (~/.cache/ms-playwright on
# Linux, ~/Library/Caches/ms-playwright on macOS, or PLAYWRIGHT_BROWSERS_PATH)
# and removes the revisions no installed Playwright uses any more. Only if
# the browser still does not launch, on Linux with apt-get, are its system
# libraries installed (`playwright install-deps`, through sudo); macOS needs
# none.
set -euo pipefail
cd "$(dirname "$0")/.."

browsers=("$@")
((${#browsers[@]})) || browsers=(chromium)
for name in "${browsers[@]}"; do
  case "$name" in
    chromium | webkit) ;;
    *) echo "setup-browsers: unknown browser '$name' (chromium, webkit)" >&2; exit 2 ;;
  esac
done

if ! (cd packages/web && node -e 'require.resolve("playwright")' 2>/dev/null); then
  echo "setup-browsers: playwright is not installed: pnpm install --frozen-lockfile" >&2
  exit 1
fi
version="$(cd packages/web && node -p 'require("playwright/package.json").version')"

# Launches each browser named in the arguments headless and renders a page;
# says why one is not usable.
usable() {
  (cd packages/web && node --input-type=module -e '
    import fs from "node:fs";
    import * as pw from "playwright";
    let ok = true;
    for (const name of process.argv.slice(1)) {
      const type = pw[name];
      if (!fs.existsSync(type.executablePath())) {
        console.log(`${name}: not installed (${type.executablePath()})`);
        ok = false;
        continue;
      }
      try {
        const browser = await type.launch({ timeout: 60_000 });
        const page = await browser.newPage();
        await page.setContent("<p>ok</p>");
        if ((await page.textContent("p")) !== "ok") throw new Error("the page did not render");
        await browser.close();
        console.log(`${name}: launches (${type.executablePath()})`);
      } catch (error) {
        console.log(`${name}: does not launch: ${String(error instanceof Error ? error.message : error).split("\n").slice(0, 8).join("\n  ")}`);
        ok = false;
      }
    }
    process.exit(ok ? 0 : 1);
  ' "$@")
}

echo "setup-browsers: ${browsers[*]} for playwright $version (${PLAYWRIGHT_BROWSERS_PATH:-default cache})"
if usable "${browsers[@]}"; then
  exit 0
fi

pnpm --filter @cube/web exec playwright install "${browsers[@]}"
if usable "${browsers[@]}"; then
  exit 0
fi

if [ "$(uname -s)" = Linux ] && command -v apt-get >/dev/null 2>&1; then
  pnpm --filter @cube/web exec playwright install-deps "${browsers[@]}"
  if usable "${browsers[@]}"; then
    exit 0
  fi
fi
echo "setup-browsers: FAIL: ${browsers[*]} for playwright $version does not launch" >&2
exit 1
