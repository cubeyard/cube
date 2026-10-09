/** The startup panel's words: labels, durations, the lamp of each step, the
 * memory advice (only when something ran out of memory) and the note on a
 * step that has run long. */
import assert from "node:assert/strict";
import { duration, longStep, memoryAdvice, startupShown, stepLabel, stepLamp, totalMs } from "../src/lib/startup.ts";
import type { StartupStep } from "../src/lib/types.ts";

const at = 1_000_000;
const step = (name: StartupStep["name"], state: StartupStep["state"], startedAt: number, endedAt?: number, extra: Partial<StartupStep> = {}): StartupStep =>
  ({ name, state, startedAt, ...(endedAt === undefined ? {} : { endedAt }), ...extra });

assert.equal(stepLabel(step("build-prepare", "running", at)), "template build · pre-setup and setup");
assert.equal(stepLabel(step("prepare", "failed", at, at, { attempt: 2 })), "prepare · try 2");
assert.deepEqual([400, 12_400, 185_000].map(duration), ["0.4 s", "12 s", "3 min 05 s"]);
assert.deepEqual((["running", "ok", "failed", "interrupted"] as const).map(state => stepLamp(step("boot", state, at))), ["on-amber blink", "on-green", "on-red", ""]);
console.log("ok: labels, durations and lamps");

const oom = step("prepare", "failed", at, at + 494_000, { attempt: 1, detail: "pre-setup was stopped: the machine ran out of memory",
  memory: { peakBytes: 3758096384, totalBytes: 4013504 * 1024, oomKills: 1 } });
assert.equal(memoryAdvice([oom, step("prepare", "ok", at + 497_000, at + 517_000, { attempt: 2 })]),
  "the machine ran out of memory during prepare · try 1 (it used up to 3.5 GB; the machine has 3.8 GB). new threads get more memory once the project's machine size is raised.");
assert.equal(memoryAdvice([step("prepare", "failed", at, at + 1000, { detail: "pre-setup failed (exit 1)", memory: { peakBytes: 1, totalBytes: 2, oomKills: 0 } })]), null,
  "a failure that is not memory gives no memory advice");
console.log("ok: memory advice only when the machine ran out of memory");

const running = [step("lookup", "ok", at, at + 100), step("build-prepare", "running", at + 100)];
assert.equal(longStep(running, at + 100 + 4 * 60_000), null);
assert.equal(longStep(running, at + 100 + 6 * 60_000), "template build · pre-setup and setup has run for 6 min; its log below shows what it is doing.");
assert.equal(totalMs(running, at + 10_000), 10_000);
assert.equal(totalMs([step("boot", "ok", at, at + 20_000), step("resume", "ok", at + 20_000, at + 25_000)], at + 99_000), 25_000);
assert.equal(startupShown({ state: "starting", vm: { vmId: "v", steps: running } as never }), true);
assert.equal(startupShown({ state: "ready", vm: { vmId: "v", steps: running } as never }), false);
assert.equal(startupShown({ state: "starting", vm: { vmId: "v" } as never }), false, "nothing to show before the first step");
console.log("ok: long steps, totals and when the panel shows itself");
