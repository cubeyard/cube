/** The thread lifecycle across restarts, offline, over a stand-in `berth vm`
 * (lifecycle-fixture.ts: the real Registry, RunnerMachines and
 * Conversations, Pi on a faux model, the real guest helper). Counts what
 * reached the runner.
 *
 *   R0  an explicit start runs the thread; idle, it is suspended; a message
 *       resumes it once.
 *   R1  a restart over suspended machines and a wake a restart cut short
 *       (`waking`, nobody asking), then every read: nothing is started; the
 *       wake is read back as suspended and its slot is free again.
 *   R2  a restart over a suspended machine whose agent has a stored run that
 *       did not finish: it is woken once and the run finishes.
 *   R2b a restart over a `waking` whose machine the runner already runs: the
 *       suspension is cleared, nothing is started.
 *   T   recoveryStep, the recovery round's rule, over every kind of thread. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Thread } from "../src/registry.ts";
import { recoveryStep } from "../src/thread-recovery.ts";
import { lifecycle, until, type Cubed } from "./lifecycle-fixture.ts";

{
  const t = (workspaceState: Thread["workspaceState"], suspension?: "suspended" | "waking", extra: Partial<Thread> = {}) =>
    ({ archived: false, workspaceState, workspaceError: null, vm: { vmId: "v", placeholders: {}, ...suspension ? { suspension: { state: suspension, at: 1 } } : {} }, ...extra }) as unknown as Thread;
  const none = { owned: false, demand: false };
  const rows: Array<[string, Thread, { owned: boolean; demand: boolean }, string]> = [
    ["archived", t("available", undefined, { archived: true }), none, "leave"],
    ["archived and asleep with a stored run", t("available", "suspended", { archived: true }), { owned: false, demand: true }, "leave"],
    ["releasing", t("releasing"), none, "release"],
    ["release failed", t("failed", undefined, { workspaceError: "workspace release failed: boom" }), none, "release"],
    ["start failed", t("failed", undefined, { workspaceError: "workspace allocation failed: boom" }), none, "start"],
    ["allocating", t("allocating"), none, "start"],
    ["ready and running", t("available"), none, "check"],
    ["suspended", t("available", "suspended"), none, "leave"],
    ["suspended with a stored run", t("available", "suspended"), { owned: false, demand: true }, "start"],
    ["waking, owned here", t("available", "waking"), { owned: true, demand: false }, "leave"],
    ["waking, no owner", t("available", "waking"), none, "settle-wake"],
    ["waking, no owner, a stored run", t("available", "waking"), { owned: false, demand: true }, "start"],
  ];
  assert.deepEqual(rows.map(([name, thread, facts]) => [name, recoveryStep(thread, facts)]), rows.map(([name, , , step]) => [name, step]));
  console.log("ok: T recoveryStep: archived threads are left, releases finish, sleeping machines wake only for a stored run, a wake no one owns is read back");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-lifecycle-"));
const life = lifecycle(root, { slots: 3 });
const { registry, berth, clock, fresh, vmOf, held } = life;
const stored = async (cubed: Cubed, id: string) => (await cubed.conversations.storedHistory(id, { limit: 1 }))?.status;
const settled = (cubed: Cubed, id: string) => until(`${id.slice(0, 8)} settles`, async () => {
  const status = await stored(cubed, id);
  return !!status && status.state !== "working" && status.state !== "idle";
});
/** Idle long enough for any machine, then idle rounds (one suspend per runner a round). */
const idle = async (cubed: Cubed) => { clock.now += 40 * 60_000; for (let round = 0; round < 4; round++) await cubed.conversations.suspendIdle(); };

let cubed = life.start();
try {
  // ---------------------------------------------------------------- R0
  const a = life.thread(), b = life.thread(), c = life.thread();
  await Promise.all([a, b, c].map(t => cubed.conversations.activate(t.id)));
  for (const t of [a, b, c]) {
    assert.equal(fresh(t.id).workspaceState, "available", `${t.id}: ${cubed.conversations.error(t.id)}`);
    await settled(cubed, t.id);
  }
  assert.deepEqual([berth.creates(), berth.starts(), berth.running()], [3, 3, 3], "three explicit starts, one machine each");
  await idle(cubed);
  assert.deepEqual([a, b, c].map(t => fresh(t.id).vm?.suspension?.state), ["suspended", "suspended", "suspended"], "idle machines are suspended");
  assert.equal(berth.running(), 0);
  await cubed.conversations.submit(a.id, "more", "tell-a-1");
  await settled(cubed, a.id);
  assert.equal(berth.resumes(vmOf(a.id)), 1, "a message resumes its machine once");
  assert.equal(fresh(a.id).vm?.suspension, undefined);
  await idle(cubed);
  assert.equal(fresh(a.id).vm?.suspension?.state, "suspended");
  console.log("ok: R0 an explicit start runs a thread, an idle machine is suspended, a message resumes it once");

  // ---------------------------------------------------------------- R1
  // A wake a restart cut short: the registry says waking (holding a slot),
  // the runner still holds the machine suspended.
  registry.updateThreadVm(c.id, { suspension: { ...fresh(c.id).vm!.suspension!, state: "waking" } });
  assert.equal(held(), 1, "the cut-short wake holds a slot in the registry");
  await cubed.close();
  const before = berth.events.length;
  cubed = life.start();
  await cubed.conversations.boot();
  await cubed.conversations.recover();
  // Every read a user or OptChat makes.
  for (const t of [a, b, c]) {
    await cubed.conversations.storedHistory(t.id, { limit: 5 });
    await cubed.conversations.history(t.id);
    await cubed.conversations.model(t.id);
  }
  await cubed.conversations.recover();
  assert.deepEqual(berth.events.slice(before).filter(e => e.op !== "machineGet"), [], "a restart, its rounds and every read change nothing on the runner");
  assert.deepEqual([a, b, c].map(t => fresh(t.id).vm?.suspension?.state), ["suspended", "suspended", "suspended"], "the cut-short wake is read back as suspended");
  assert.equal(held(), 0, "and its slot is free again");
  assert.deepEqual(berth.violations, []);
  console.log("ok: R1 a restart and every read start nothing; a wake no one owns is read back as suspended and frees its slot");

  // ---------------------------------------------------------------- R2
  // A message comes while the runner does not answer: the agent takes it
  // (its run waits on its first guest call), then cubed stops.
  await cubed.close();
  cubed = life.start();
  berth.down = true;
  cubed.machines["options"].wakeWaitMs = 60_000;
  await cubed.conversations.submit(b.id, "go on", "tell-b-1");
  await until("b's run waits for its machine", async () => (await stored(cubed, b.id))?.state === "working");
  await cubed.close();
  assert.equal((await stored(cubed, b.id))?.state, "working", "the run is stored unfinished");
  assert.equal(fresh(b.id).vm?.suspension?.state, "suspended");
  berth.down = false;
  const resumesBefore = berth.resumes();
  cubed = life.start();
  await cubed.conversations.boot();
  await settled(cubed, b.id);
  assert.equal(berth.resumes() - resumesBefore, 1, "the stored run wakes its machine once");
  assert.equal(berth.resumes(vmOf(b.id)), 1);
  assert.equal(berth.resumes(vmOf(a.id)) + berth.resumes(vmOf(c.id)), 1, "and nothing else (a's one resume is R0's)");
  assert.equal((await stored(cubed, b.id))?.state, "completed", "the run finished");
  console.log("ok: R2 after a restart a stored unfinished run wakes its machine once and finishes; idle threads stay asleep");

  // ---------------------------------------------------------------- R2b
  // The wake went through on the runner but cubed stopped before it recorded it.
  await idle(cubed);
  assert.equal(fresh(b.id).vm?.suspension?.state, "suspended");
  registry.updateThreadVm(b.id, { suspension: { ...fresh(b.id).vm!.suspension!, state: "waking" } });
  berth.phases.set(vmOf(b.id), 4 /* RUNNING */);
  await cubed.close();
  const startsBefore = berth.starts();
  cubed = life.start();
  await cubed.conversations.boot();
  assert.equal(fresh(b.id).vm?.suspension, undefined, "a wake the runner finished is recorded as running");
  await cubed.conversations.boot();
  assert.equal(berth.starts(), startsBefore, "nothing was started: the next round only checks it");
  assert.equal(fresh(b.id).workspaceState, "available");
  console.log("ok: R2b a wake the runner finished before the restart is read back as running, not started again");
  assert.deepEqual(berth.violations, [], "no guest call reached a machine that did not run");
} finally {
  await cubed.close().catch(() => {});
  berth.stopAll();
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(0);
