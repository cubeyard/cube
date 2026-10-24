/** A sleeping machine's wake through createCubed's own wiring (no test
 * wiring of the machines or Conversations): a stand-in `berth vm`
 * (lifecycle-fixture.ts) is the only seam, with a clock and short waits.
 * Regression for the audit's renewWake finding: a new message must make a
 * run wait for a slot the whole time again after an earlier run's wait gave
 * up; createCubed's machines once dropped that renewal while the lifecycle
 * tests, wired apart, passed (thread-lifecycle-test.ts R11). Offline, faux
 * model, disposable state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import type { TrustedRunnerHealth } from "../src/runner-types.ts";
import { FakeBerth, NODE, project, RUNNER, until } from "./lifecycle-fixture.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-cubed-wake-"));
const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
faux.setResponses(Array.from({ length: 50 }, () => fauxAssistantMessage("done")));
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, id: faux.getModel().id };
const berth = new FakeBerth(path.join(root, "runner"), 1);
const clock = { now: Date.now() };
const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;
const health: TrustedRunnerHealth = { lifecycle: "ready", draining: false, error: null, activeVms: 0, runningVms: 0, maxActiveVms: 1,
  retainedVms: 0, retainedBytes: 0, softwareVersion: "stand-in", protocolVersion: 4, kind: "vm" };
const app = await createCubed({ state: path.join(root, "state"), models, claude: null, gateway: null, skillSource: null, now: () => clock.now,
  runnerHealth: async () => health,
  runner: { session: () => berth.session(), log: quiet, templates: { enabled: false, ttlMs: 0 }, idleMs: 60_000, wakeRetryMs: 50, wakeWaitMs: 600 } });
try {
  const { registry, conversations, machines } = app;
  registry.saveProject(project);
  registry.enrollRunner({ nodeId: NODE, threadId: RUNNER, environmentId: 1, configPath: path.join(root, "runner.json"), configHash: RUNNER, maxActiveVms: 1,
    protocol: 4, kind: "vm" });
  let requests = 0;
  const thread = () => registry.createThread(project.id, `create-${++requests}`, model, "hello");
  const fresh = (id: string) => registry.getThread(id)!;
  const vmOf = (id: string) => fresh(id).vm!.vmId;
  const done = (id: string) => until(`${id.slice(0, 8)} settles`, async () => {
    const status = (await conversations.storedHistory(id, { limit: 1 }))?.status;
    return !!status && status.state !== "working" && status.state !== "idle";
  });
  const sleep = async () => { clock.now += 40 * 60_000; for (let round = 0; round < 3; round++) await conversations.suspendIdle(); };
  /** One guest call to the thread's machine: how often it asked the runner
   * for the machine (each try of a wake), and its failure. */
  const call = async (id: string) => {
    const asked = () => berth.asks.get(`machineGet:${vmOf(id)}`) ?? 0;
    const before = asked();
    try { await machines.guest(fresh(id)).call("stat", { path: "/workspace" }); return { tries: asked() - before, error: null }; }
    catch (error) { return { tries: asked() - before, error: (error as Error).message }; }
  };

  const a = thread();
  await conversations.activate(a.id);
  await done(a.id);
  await sleep();
  assert.equal(fresh(a.id).vm?.suspension?.state, "suspended", "idle, a's machine sleeps");
  const b = thread();
  await conversations.activate(b.id);
  await done(b.id);
  const first = await call(a.id);
  assert.ok(first.tries >= 3 && first.error, `with b on the only slot, a's call waits its whole time, trying again: ${first.tries} tries`);
  const next = await call(a.id);
  assert.equal(next.tries, 1, "a later call of the same run tries once");
  assert.match(next.error ?? "", /this run already waited its whole time for it, a new message waits again/);

  await conversations.submit(a.id, "again", "tell-a-again");
  const renewed = await call(a.id);
  assert.ok(renewed.tries >= 3, `a new message waits its whole time again: ${renewed.tries} tries`);
  assert.doesNotMatch(renewed.error ?? "", /already waited its whole time/);

  await conversations.archive(b.id);
  const resumed = await call(a.id);
  assert.deepEqual([resumed.error, fresh(a.id).vm?.suspension], [null, undefined], "with the slot free a call resumes the machine");
  await done(a.id);
  assert.deepEqual(berth.violations, [], "no guest call reached a machine that did not run");
  console.log("ok: through createCubed, a new message to a thread whose run gave up waiting for its sleeping machine waits again; a freed slot resumes it");
} finally {
  await app.close();
  berth.stopAll();
  fs.rmSync(root, { recursive: true, force: true });
}
