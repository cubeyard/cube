/** scripts/setup-browsers.sh decides from a real launch, with `pnpm` (its
 * only way to download or install) replaced by a recorder: a browser that
 * launches downloads nothing; a missing one is downloaded, then its system
 * libraries installed where apt-get is, and the script fails when it still
 * does not launch. No network. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const repo = path.resolve(import.meta.dirname, "..");
const script = path.join(repo, "scripts/setup-browsers.sh");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-setup-browsers-"));
try {
  const bin = path.join(root, "bin");
  const calls = path.join(root, "calls");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "pnpm"), `#!/bin/sh\necho "$*" >>"${calls}"\n`, { mode: 0o755 });
  const run = (args: string[], env: Record<string, string> = {}) => {
    fs.rmSync(calls, { force: true });
    const result = spawnSync("bash", [script, ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    });
    return { ...result, calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n") : [] };
  };

  const unknown = run(["firefox"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown browser 'firefox'/);
  assert.deepEqual(unknown.calls, []);

  // An empty cache: nothing launches, so Playwright is asked to download
  // (the recorder does not), then for the libraries, then the script fails.
  const empty = path.join(root, "browsers");
  fs.mkdirSync(empty);
  const missing = run(["chromium", "webkit"], { PLAYWRIGHT_BROWSERS_PATH: empty });
  assert.equal(missing.status, 1, missing.stdout + missing.stderr);
  assert.match(missing.stdout, /chromium: not installed/);
  assert.match(missing.stdout, /webkit: not installed/);
  const apt = process.platform === "linux" && spawnSync("sh", ["-c", "command -v apt-get"]).status === 0;
  assert.deepEqual(missing.calls, [
    "--filter @cube/web exec playwright install chromium webkit",
    ...(apt ? ["--filter @cube/web exec playwright install-deps chromium webkit"] : []),
  ]);
  assert.match(missing.stderr, /FAIL: chromium webkit for playwright \d+\.\d+\.\d+ does not launch/);

  // Chromium that is installed and launches (the default cache): nothing.
  const { chromium } = createRequire(path.join(repo, "packages/web/package.json"))("playwright") as { chromium: { executablePath(): string } };
  if (fs.existsSync(chromium.executablePath())) {
    const ready = run([]);
    assert.equal(ready.status, 0, ready.stdout + ready.stderr);
    assert.match(ready.stdout, /chromium: launches/);
    assert.deepEqual(ready.calls, []);
  } else {
    console.log("SKIP: an installed Chromium is left alone (no Chromium here: bash scripts/setup-browsers.sh)");
  }
  console.log("setup-browsers-test: a launching browser downloads nothing; a missing one is downloaded, then its libraries installed, else a failure");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
