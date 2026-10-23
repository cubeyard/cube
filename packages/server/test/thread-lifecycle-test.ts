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
 *   T   recoveryStep, the recovery round's rule, over every kind of thread.
 *   R4  one slot: a wake does not take the slot the registry gave a new
 *       thread; it waits, and resumes once that thread is archived.
 *   R5  one slot taken: archiving a suspended thread keeps its disk
 *       unchecked at once (no wait for a slot); with a slot free its machine
 *       is woken, checked and deleted. Nothing starts an archived thread.
 *   R6  a runner fuller than the registry knows: a new machine waits for a
 *       slot (not a failure) and starts once one frees. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Thread } from "../src/registry.ts";
import { recoveryStep } from "../src/thread-recovery.ts";
import { lifecycle, Phase, until, type Cubed } from "./lifecycle-fixture.ts";

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
  berth.phases.set(vmOf(b.id), Phase.RUNNING);
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
}

// One slot, a fresh cubed for each of R4–R6.
{
  const one = lifecycle(path.join(root, "one"), { slots: 1, wakeWaitMs: 20_000 });
  const { registry, berth, clock, fresh, vmOf, held } = one;
  const cubed = one.start();
  const status = async (id: string) => (await cubed.conversations.storedHistory(id, { limit: 1 }))?.status;
  const done = (id: string) => until(`${id.slice(0, 8)} settles`, async () => { const s = await status(id); return !!s && s.state !== "working" && s.state !== "idle"; });
  const idle = async () => { clock.now += 40 * 60_000; for (let round = 0; round < 3; round++) await cubed.conversations.suspendIdle(); };
  /** I4: the registry never counts fewer machines than the runner holds, nor more than its slots. */
  const slots = (what: string) => {
    assert.ok(berth.holding() <= held() && held() <= berth.slots, `${what}: runner holds ${berth.holding()}, registry ${held()}, slots ${berth.slots}`);
  };
  try {
    // ---------------------------------------------------------------- R4
    const a = one.thread();
    await cubed.conversations.activate(a.id);
    await done(a.id);
    await idle();
    assert.equal(fresh(a.id).vm?.suspension?.state, "suspended");
    const b = one.thread();
    slots("a new thread reserved the slot a freed");
    // A message to a while b's machine does not exist yet.
    const told = cubed.conversations.submit(a.id, "wake up", "tell-a");
    await until("a's wake waits", () => fresh(a.id).vm?.suspension?.waiting !== undefined);
    assert.equal(berth.resumes(vmOf(a.id)), 0, "the wake did not take b's slot");
    slots("a waits");
    await cubed.conversations.activate(b.id);
    assert.equal(fresh(b.id).workspaceState, "available", `b starts in its slot: ${cubed.conversations.error(b.id)}`);
    slots("b runs");
    await told;
    await done(b.id);
    const archived = await cubed.conversations.archive(b.id);
    assert.equal(archived.retained, false);
    await done(a.id);
    assert.equal(berth.resumes(vmOf(a.id)), 1, "a resumed once b's slot was free");
    assert.equal((await status(a.id))?.state, "completed", "and its run finished");
    slots("a runs");
    console.log("ok: R4 a wake waits for the slot a new thread was given, and resumes once it frees");

    // ---------------------------------------------------------------- R5
    await idle();
    const c = one.thread();
    await cubed.conversations.activate(c.id);
    await done(c.id);
    assert.equal(berth.running(), 1, "c holds the only slot");
    const began = Date.now();
    const kept = await cubed.conversations.archive(a.id);
    const took = Date.now() - began;
    assert.ok(took < 5_000, `the archive did not wait for a slot (${took} ms)`);
    assert.equal(kept.retained, true);
    assert.match(kept.reason, /suspended and was not woken to check it \(waiting for a free slot on runner node-life.*\); its disk is kept unchecked/);
    assert.equal(berth.resumes(vmOf(a.id)), 1, "a was not woken for the archive");
    assert.equal(berth.phases.get(vmOf(a.id)), Phase.RETAINED, "its disk is kept on the runner");
    const after = berth.events.length;
    await assert.rejects(cubed.machines.start(fresh(a.id)), /thread not found/, "nothing starts an archived thread's machine");
    await assert.rejects(cubed.conversations.submit(a.id, "again", "tell-a-2"), /thread not found/);
    await cubed.conversations.recover();
    assert.deepEqual(berth.touched(vmOf(a.id), after), [], "the archived machine was not asked for anything");
    slots("a archived");
    // With a slot free the machine is woken, checked and deleted.
    await idle();
    const resumes = berth.resumes(vmOf(c.id));
    const clean = await cubed.conversations.archive(c.id);
    assert.deepEqual([clean.retained, berth.resumes(vmOf(c.id)) - resumes, berth.phases.has(vmOf(c.id))], [false, 1, false], `c was woken for its check and deleted (${clean.reason})`);
    slots("c archived");
    console.log("ok: R5 archiving a suspended thread on a full runner keeps its disk unchecked at once; with a slot free it is checked and deleted; nothing starts an archived thread");

    // ---------------------------------------------------------------- R6
    berth.slots = 0;
    const d = one.thread();
    await cubed.conversations.activate(d.id);
    assert.equal(fresh(d.id).workspaceState, "allocating", `d waits, it did not fail: ${fresh(d.id).workspaceError}`);
    assert.match(cubed.conversations.waiting(d.id) ?? "", /waiting for a free slot on runner node-life/);
    assert.equal(cubed.conversations.error(d.id), null);
    assert.equal(fresh(d.id).vm?.steps?.find(step => step.name === "boot")?.state, "interrupted", "its boot step says it was interrupted, not failed");
    berth.slots = 1;
    await cubed.conversations.recover();
    assert.equal(fresh(d.id).workspaceState, "available", "it starts once the runner has room");
    slots("d runs");
    console.log("ok: R6 a new machine on a runner fuller than the registry knows waits for a slot, then starts");
    assert.deepEqual(berth.violations, []);
  } finally {
    await cubed.close().catch(() => {});
    berth.stopAll();
    void registry;
  }
}
fs.rmSync(root, { recursive: true, force: true });
process.exit(0);
