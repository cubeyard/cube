/** A sleeping machine's wake through createCubed's own wiring (no test
 * wiring of the machines or Conversations): a stand-in `berth vm`
 * (lifecycle-fixture.ts) is the only seam, with a clock and short waits.
 * Regression for the audit's renewWake finding: a new message must make a
 * run wait for a slot the whole time again after an earlier run's wait gave
 * up; createCubed's machines once dropped that renewal while the lifecycle
 * tests, wired apart, passed (thread-lifecycle-test.ts R11). Also, through
 * the same wiring: a wake of a running machine is a no-op; a run that gave
 * up waits whole again once anything ran the machine; an archive or a close
 * ends a wake that waits, which then asks nothing more. Offline, faux model,
 * disposable state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { PATIENCE } from "../src/conversation.ts";
import { createCubed } from "../src/index.ts";
import { slotWait } from "../src/machine-sleep.ts";
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
  patience: { retryMs: 50, wakeMs: 600 },
  runner: { session: () => berth.session(), log: quiet, templates: { enabled: false, ttlMs: 0 }, idleMs: 60_000 } });
try {
  const { registry, conversations } = app;
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
    try { await conversations.guest(fresh(id)).call("stat", { path: "/workspace" }); return { tries: asked() - before, error: null }; }
    catch (error) { return { tries: asked() - before, error: (error as Error).message }; }
  };

  /** While `work` runs, the runner refuses to suspend `holder` (busy): it
   * keeps the only slot, so a wake waits however idle the holder is. */
  const holding = async <T>(holder: string, work: () => Promise<T>): Promise<T> => {
    berth.busy.add(vmOf(holder));
    try { return await work(); } finally { berth.busy.delete(vmOf(holder)); }
  };

  const a = thread();
  await conversations.activate(a.id);
  await done(a.id);
  await sleep();
  assert.equal(fresh(a.id).vm?.suspension?.state, "suspended", "idle, a's machine sleeps");
  const b = thread();
  await conversations.activate(b.id);
  await done(b.id);
  await holding(b.id, async () => {
    const first = await call(a.id);
    assert.ok(first.tries >= 3 && first.error, `with b on the only slot, a's call waits its whole time, trying again: ${first.tries} tries`);
    const next = await call(a.id);
    assert.equal(next.tries, 1, "a later call of the same run tries once");
    assert.match(next.error ?? "", /this run already waited its whole time for it, a new message waits again/);

    await conversations.submit(a.id, "again", "tell-a-again");
    const renewed = await call(a.id);
    assert.ok(renewed.tries >= 3, `a new message waits its whole time again: ${renewed.tries} tries`);
    assert.doesNotMatch(renewed.error ?? "", /already waited its whole time/);
  });
  assert.equal(fresh(b.id).vm?.suspension, undefined, "the runner refused to suspend busy b throughout");

  await conversations.archive(b.id);
  const resumed = await call(a.id);
  assert.deepEqual([resumed.error, fresh(a.id).vm?.suspension], [null, undefined], "with the slot free a call resumes the machine");
  await done(a.id);
  assert.deepEqual(berth.violations, [], "no guest call reached a machine that did not run");
  console.log("ok: through createCubed, a new message to a thread whose run gave up waiting for its sleeping machine waits again; a freed slot resumes it");

  // A wake of a machine that runs is no wake: it asks the runner nothing.
  const quietFrom = berth.events.length;
  await conversations.wake(a.id);
  assert.deepEqual(berth.events.slice(quietFrom), [], "a wake of a running machine asks the runner nothing");
  assert.equal(PATIENCE.startMs, 30 * 60_000, "one clock: a start waits for its runner 30 min");
  assert.equal(PATIENCE.wakeMs, PATIENCE.startMs, "and so does a wake");
  console.log("ok: a wake of a running machine is a no-op; a start and a wake wait for their runner on one clock");

  // A run that gave up waits whole again once the machine ran, whoever started it.
  await sleep();
  const c = thread();
  await conversations.activate(c.id);
  await done(c.id);
  assert.match((await holding(c.id, () => call(a.id))).error ?? "", /^the thread's machine is suspended and could not be resumed/, "the run gives up");
  await conversations.archive(c.id);
  await conversations.activate(a.id);
  assert.equal(fresh(a.id).vm?.suspension, undefined, "a start (not the run's call) resumed it");
  await sleep();
  const d = thread();
  await conversations.activate(d.id);
  await done(d.id);
  const after = await holding(d.id, () => call(a.id));
  assert.ok(after.tries >= 3, `the machine ran since: a call waits its whole time again: ${after.tries} tries`);
  assert.doesNotMatch(after.error ?? "", /already waited its whole time/);
  console.log("ok: once the machine ran (whoever started it), a run that gave up waits its whole time again");

  // An archive while a call's wake waits for a slot: the archive answers at
  // once, the wake ends, and the archived machine is asked to run no more.
  await sleep();
  assert.equal(fresh(d.id).vm?.suspension?.state, "suspended", "d sleeps now");
  const g = thread();
  await conversations.activate(g.id);
  await done(g.id);
  berth.busy.add(vmOf(g.id));
  const waiting = call(d.id);
  await until("d's wake waits for a slot", () => !!slotWait(fresh(d.id).vm?.suspension) && conversations.owns(fresh(d.id)));
  const began = Date.now();
  await conversations.archive(d.id);
  assert.ok(Date.now() - began < 5_000, `the archive did not wait for the wake: ${Date.now() - began} ms`);
  const archivedAt = berth.events.length;
  assert.ok((await waiting).error, "the call of the archived thread fails");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(berth.touched(vmOf(d.id), archivedAt).filter(e => e.op === "machineStart"), [], "the ended wake asks the archived machine to run no more");
  assert.equal(conversations.owns(fresh(d.id)), false, "no wake is left");
  console.log("ok: an archive during a wake that waits for a slot answers at once; the wake ends and starts nothing more");

  // A close ends a wake that waits: the machine stays asleep, nothing more is asked.
  berth.busy.delete(vmOf(g.id));
  await conversations.archive(g.id);
  const e = thread();
  await conversations.activate(e.id);
  await done(e.id);
  await sleep();
  const f = thread();
  await conversations.activate(f.id);
  await done(f.id);
  berth.busy.add(vmOf(f.id));
  const closing = conversations.guest(fresh(e.id)).call("stat", { path: "/workspace" }).then(() => null, (error: Error) => error.message);
  await until("e's wake waits for a slot", () => !!slotWait(fresh(e.id).vm?.suspension));
  await app.close();
  const closedAt = berth.events.length;
  assert.equal(await closing, "cubed is closing; the thread's machine stays suspended");
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(berth.events.slice(closedAt).filter(e => e.op === "machineStart"), [], "a closed cubed's wake asks nothing more");
  console.log("ok: a close ends a wake that waits for a slot; the machine stays asleep and nothing more is asked");
} finally {
  await app.close().catch(() => {});
  berth.stopAll();
  fs.rmSync(root, { recursive: true, force: true });
}
