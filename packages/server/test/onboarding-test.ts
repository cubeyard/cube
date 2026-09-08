import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { completeOnboarding, isOnboardingComplete } from "../src/onboarding.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cube-onboarding-"));
try {
  const file = path.join(dir, "state", "onboarding.json");
  assert.equal(isOnboardingComplete(file), false);
  completeOnboarding(file);
  assert.equal(isOnboardingComplete(file), true, "completion is read from disk, not process memory");
  completeOnboarding(file);
  assert.equal(isOnboardingComplete(file), true, "completion is idempotent");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { completed: true });
  fs.writeFileSync(file, "{");
  assert.equal(isOnboardingComplete(file), false, "incomplete state does not skip onboarding");
  assert.throws(() => completeOnboarding(dir), "failed persistence must not report success");
  console.log("onboarding: first run, persisted completion, repeat, corrupt state, write failure passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
