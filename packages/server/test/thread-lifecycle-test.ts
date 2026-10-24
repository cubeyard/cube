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
 *       slot (not a failure) and starts once one frees.
 *   R7  a start that keeps failing is tried 8 times over about an hour, at
 *       30 s doubling to 30 min, then shown as stopped (also after a
 *       restart); each new message tries once more, a replayed one does not.
 *   R8  a release that keeps failing is retried with the same pauses past 8
 *       tries until it succeeds: the obligation is never dropped.
 *   R9  a replayed message to a sleeping thread wakes nothing; a new one
 *       wakes it once.
 *   R10 a wake that keeps failing hard leaves no `waking` holding a slot:
 *       not after the starts stopped, not after a restart.
 *   R11 a run on a full runner waits for its sleeping machine once: after
 *       its wait gave up, its later guest calls try once and fail; a new
 *       message, or a machine that ran since (resumed by a call or by its
 *       activation), waits again; a slot that frees resumes it.
 *   R12 a new thread on a runner that does not answer waits 30 min, then
 *       each try counts as a failed start (pauses, the limit of 8, an error
 *       that says why); a new message tries once more. A wait for a slot on
 *       a full runner is not bounded (R6).
 *   R12b a ready thread whose runner does not answer across a restart waits
 *       as long as it takes and is reattached when the runner is back.
 *   R12c a thread on a host runner that is down waits as long as it takes
 *       (AGENTS.md: a host runner's threads wait while it is down).
 *   R13 OptChat's reads of R10's thread say its wake failed (threads,
 *       the overview) and its watcher reports it; an idle sleeping thread
 *       reads as before.
 *   R13b a failed wake not yet given up reads as failed after a restart
 *       too, and its failures in a row are one episode (`retry.since`). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Thread } from "../src/registry.ts";
import { ThreadFailure } from "../src/optchat.ts";
import { readThreads } from "../src/optchat-threads.ts";
import { recoveryStep } from "../src/thread-recovery.ts";
import { lifecycle, Phase, project, RUNNER, until, type Cubed } from "./lifecycle-fixture.ts";

{
  const t = (workspaceState: Thread["workspaceState"], suspension?: "suspended" | "waking", extra: Partial<Thread> = {}) =>
    ({ archived: false, workspaceState, workspaceError: null, vm: { vmId: "v", placeholders: {}, ...suspension ? { suspension: { state: suspension, at: 1 } } : {} }, ...extra }) as unknown as Thread;
  const none = { owned: false, demand: false, now: 1_000_000 };
  const failed = (failures: number, at: number) => ({ retry: { failures, at, error: "boom" } });
  const rows: Array<[string, Thread, { owned: boolean; demand: boolean; now: number }, string]> = [
    ["archived", t("available", undefined, { archived: true }), none, "leave"],
    ["archived and asleep with a stored run", t("available", "suspended", { archived: true }), { ...none, demand: true }, "leave"],
    ["releasing", t("releasing"), none, "release"],
    ["release failed", t("failed", undefined, { workspaceError: "workspace release failed: boom" }), none, "release"],
    ["start failed", t("failed", undefined, { workspaceError: "workspace allocation failed: boom" }), none, "start"],
    ["allocating", t("allocating"), none, "start"],
    ["ready and running", t("available"), none, "check"],
    ["suspended", t("available", "suspended"), none, "leave"],
    ["suspended with a stored run", t("available", "suspended"), { ...none, demand: true }, "start"],
    ["waking, owned here", t("available", "waking"), { ...none, owned: true }, "leave"],
    ["waking, no owner", t("available", "waking"), none, "settle-wake"],
    ["waking, no owner, a stored run", t("available", "waking"), { ...none, demand: true }, "start"],
    ["start failed once, 29 s ago", t("failed", undefined, failed(1, 1_000_000 - 29_000)), none, "leave"],
    ["start failed once, 30 s ago", t("failed", undefined, failed(1, 1_000_000 - 30_000)), none, "start"],
    ["start failed 3 times, 119 s ago", t("failed", undefined, failed(3, 1_000_000 - 119_000)), none, "leave"],
    ["start failed 3 times, 120 s ago", t("failed", undefined, failed(3, 1_000_000 - 120_000)), none, "start"],
    ["start failed 7 times, 30 min ago", t("failed", undefined, failed(7, 1_000_000 - 1_800_000)), none, "start"],
    ["start failed 8 times, long ago", t("failed", undefined, failed(8, 0)), none, "leave"],
    ["check failed 8 times, long ago", t("available", undefined, failed(8, 0)), none, "leave"],
    ["waking, no owner, a stored run, its pause running", t("available", "waking", failed(1, 1_000_000 - 29_000)), { ...none, demand: true }, "settle-wake"],
    ["waking, no owner, starts stopped", t("available", "waking", failed(8, 0)), none, "settle-wake"],
    ["suspended with a stored run, starts stopped", t("available", "suspended", failed(8, 0)), { ...none, demand: true }, "leave"],
    ["release failed 20 times, 30 min ago", t("failed", undefined, { workspaceError: "workspace release failed: boom", ...failed(20, 1_000_000 - 1_800_000) }), none, "release"],
    ["release failed 20 times, 29 min ago", t("failed", undefined, { workspaceError: "workspace release failed: boom", ...failed(20, 1_000_000 - 1_740_000) }), none, "leave"],
  ];
  assert.deepEqual(rows.map(([name, thread, facts]) => [name, recoveryStep(thread, facts)]), rows.map(([name, , , step]) => [name, step]));
  console.log("ok: T recoveryStep: archived threads are left, releases finish, sleeping machines wake only for a stored run, a wake no one owns is read back; a failed try waits 30 s doubling to 30 min, starts stop after 8, releases never");
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
    clock.now += 31 * 60_000;
    await cubed.conversations.recover();
    assert.deepEqual([cubed.conversations.error(d.id), fresh(d.id).retry], [null, undefined], "a wait for a slot is not bounded like a runner that does not answer (R12)");
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
{
  const life = lifecycle(path.join(root, "retry"), { slots: 2 });
  const { registry, berth, clock, fresh, vmOf } = life;
  let cubed = life.start();
  const status = async (id: string) => (await cubed.conversations.storedHistory(id, { limit: 1 }))?.status;
  const done = (id: string) => until(`${id.slice(0, 8)} settles`, async () => { const s = await status(id); return !!s && s.state !== "working" && s.state !== "idle"; });
  /** Recovery rounds every 30 s of the test's clock until `stop` or `ms`. */
  const rounds = async (ms: number, stop: () => boolean = () => false) => {
    for (let spent = 0; spent < ms && !stop(); spent += 30_000) { clock.now += 30_000; await cubed.conversations.recover(); }
  };
  try {
    // ---------------------------------------------------------------- R7
    const e = life.thread();
    berth.failCreates.set(vmOf(e.id), "no room for its disk");
    const creates = () => berth.asked("machineCreate", vmOf(e.id));
    const t0 = clock.now;
    await cubed.conversations.activate(e.id);
    assert.equal(fresh(e.id).workspaceState, "failed");
    const at: number[] = [];
    for (let spent = 0; spent < 2 * 3600_000; spent += 30_000) {
      clock.now += 30_000;
      const before = creates();
      await cubed.conversations.recover();
      if (creates() > before) at.push((clock.now - t0) / 1000);
    }
    assert.equal(creates(), 8, "8 tries in all");
    assert.deepEqual(at, [30, 90, 210, 450, 930, 1890, 3690], "after the first, at pauses of 30 s doubling to 30 min");
    assert.match(cubed.conversations.error(e.id) ?? "", /no room for its disk; cube stopped retrying after 8 tries in a row, a message to the thread tries once more/);
    await cubed.close();
    cubed = life.start();
    await rounds(3600_000);
    assert.equal(creates(), 8, "a restart does not start the tries again");
    assert.match(cubed.conversations.error(e.id) ?? "", /stopped retrying after 8 tries/, "and still says it stopped");
    await assert.rejects(cubed.conversations.submit(e.id, "try again", "tell-e-1"), /no room for its disk/);
    assert.equal(creates(), 9, "a message tries once more");
    await assert.rejects(cubed.conversations.submit(e.id, "try again", "tell-e-1"), /no room for its disk/);
    assert.equal(creates(), 9, "the same message again (a delivery retried) does not");
    berth.failCreates.delete(vmOf(e.id));
    // The machine starts; its first message (the thread's task) runs first.
    await assert.rejects(cubed.conversations.submit(e.id, "now it works", "tell-e-2"), /already working/);
    assert.equal(creates(), 10);
    assert.deepEqual([fresh(e.id).workspaceState, fresh(e.id).retry, cubed.conversations.error(e.id)], ["available", undefined, null], "it runs, and its failed tries are forgotten");
    await done(e.id);
    console.log("ok: R7 a failing start is tried 8 times over about an hour, then shown as stopped across restarts; a new message tries once more, a replayed one does not");

    // ---------------------------------------------------------------- R8
    berth.failDeletes = 10;
    await assert.rejects(cubed.conversations.archive(e.id), /workspace release failed/);
    const deletes = () => berth.asked("machineDelete", vmOf(e.id));
    await rounds(6 * 3600_000, () => fresh(e.id).archived);
    assert.deepEqual([fresh(e.id).archived, deletes()], [true, 11], "the release was retried past 8 failures until it succeeded");
    console.log("ok: R8 a failing release is retried with pauses until it succeeds, never given up");

    // ---------------------------------------------------------------- R9
    const g = life.thread();
    await cubed.conversations.activate(g.id);
    await done(g.id);
    await cubed.conversations.submit(g.id, "first", "tell-g-1");
    await done(g.id);
    clock.now += 40 * 60_000;
    for (let round = 0; round < 3; round++) await cubed.conversations.suspendIdle();
    assert.equal(fresh(g.id).vm?.suspension?.state, "suspended");
    await cubed.close();
    cubed = life.start();
    assert.deepEqual(await cubed.conversations.submit(g.id, "first", "tell-g-1"), { runId: "tell-g-1" });
    assert.equal(berth.resumes(vmOf(g.id)), 0, "a replayed message wakes nothing");
    await assert.rejects(cubed.conversations.submit(g.id, "other text", "tell-g-1"), /conflicts with the previous request/);
    await cubed.conversations.submit(g.id, "second", "tell-g-2");
    await done(g.id);
    assert.equal(berth.resumes(vmOf(g.id)), 1, "a new one wakes it once");
    console.log("ok: R9 a replayed message to a sleeping thread wakes nothing; a new one wakes it once");

    // ---------------------------------------------------------------- R10
    const w = life.thread();
    await cubed.conversations.activate(w.id);
    await done(w.id);
    clock.now += 40 * 60_000;
    for (let round = 0; round < 3; round++) await cubed.conversations.suspendIdle();
    assert.equal(fresh(w.id).vm?.suspension?.state, "suspended");
    berth.failResumes.set(vmOf(w.id), "the snapshot could not be restored");
    for (let tell = 1; tell <= 8; tell++) await cubed.conversations.submit(w.id, `more ${tell}`, `tell-w-${tell}`).catch(() => {});
    assert.ok((fresh(w.id).retry?.failures ?? 0) >= 8, "its starts stopped");
    await rounds(3 * 3600_000);
    assert.deepEqual([fresh(w.id).vm?.suspension?.state, life.held(), berth.holding()], ["suspended", 0, 0], "the failed wake is read back: no slot held");
    registry.updateThreadVm(w.id, { suspension: { ...fresh(w.id).vm!.suspension!, state: "waking" } });
    await cubed.close();
    cubed = life.start();
    await cubed.conversations.recover();
    assert.deepEqual([fresh(w.id).vm?.suspension?.state, life.held()], ["suspended", 0], "also after a restart");
    console.log("ok: R10 a wake that keeps failing leaves no waking holding a slot, after the starts stopped and after a restart");

    // ---------------------------------------------------------------- R13
    const reader = readThreads({ registry, conversations: cubed.conversations });
    assert.match(await reader.describe([w.id]), /its machine is suspended and waking it failed: .*the snapshot could not be restored; cube stopped retrying after \d+ tries in a row/);
    assert.equal((await reader.observe!([w.id])).get(w.id)?.state, "machine error");
    await assert.rejects(reader.events(w.id), /the snapshot could not be restored/, "the watcher reports the failed wake");
    const sleeper = life.thread();
    await cubed.conversations.activate(sleeper.id);
    await done(sleeper.id);
    clock.now += 40 * 60_000;
    for (let round = 0; round < 3; round++) await cubed.conversations.suspendIdle();
    assert.equal(fresh(sleeper.id).vm?.suspension?.state, "suspended");
    assert.match(await reader.describe([sleeper.id]), /its machine is suspended \(idle; it wakes when told\), completed$/);
    assert.equal((await reader.observe!([sleeper.id])).get(sleeper.id)?.state, "completed");
    assert.equal(await reader.events(sleeper.id).then(() => "no failure", (error: Error) => error.message), "no failure", "an idle sleeping thread is no failure");
    console.log("ok: R13 OptChat's threads, overview and watcher say a sleeping thread's wake failed; an idle sleeping thread reads as before");

    // ---------------------------------------------------------------- R13b
    const once = life.thread();
    await cubed.conversations.activate(once.id);
    await done(once.id);
    clock.now += 40 * 60_000;
    for (let round = 0; round < 3; round++) await cubed.conversations.suspendIdle();
    berth.failResumes.set(vmOf(once.id), "the snapshot could not be restored");
    await cubed.conversations.submit(once.id, "more", "tell-once").catch(() => {});
    assert.equal(fresh(once.id).retry?.failures, 1, "one failed wake, cube still retries");
    const episode = fresh(once.id).retry?.since;
    assert.equal(episode, fresh(once.id).retry?.at, "the episode is its first failed try");
    const failure = async (r: typeof reader) => (await r.events(once.id).then(() => null, (error: unknown) => error)) as ThreadFailure | null;
    await cubed.close();
    cubed = life.start();
    const restarted = readThreads({ registry, conversations: cubed.conversations });
    assert.match(await restarted.describe([once.id]), /its machine is suspended and waking it failed: .*the snapshot could not be restored/, "after a restart too");
    assert.equal((await restarted.observe!([once.id])).get(once.id)?.state, "machine error");
    const after = await failure(restarted);
    assert.ok(after instanceof ThreadFailure, "the watcher reports it (no agent open now)");
    assert.match(after.message, /the snapshot could not be restored/);
    assert.deepEqual([after.episode, after.retrying, after.waking], [String(episode), true, true], "its episode, cube still retries, its machine asleep");
    clock.now += 60_000;
    await cubed.conversations.recover();
    assert.ok((fresh(once.id).retry?.failures ?? 0) >= 2, "its stored run tries the wake again");
    assert.equal(fresh(once.id).retry?.since, episode, "failures in a row are one episode");
    berth.failResumes.delete(vmOf(once.id));
    console.log("ok: R13b a failed wake not yet given up reads as failed after a restart too, as one episode of failures in a row");
    assert.deepEqual(berth.violations, []);
  } finally {
    await cubed.close().catch(() => {});
    berth.stopAll();
  }
}
// ---------------------------------------------------------------- R11
{
  const full = lifecycle(path.join(root, "full"), { slots: 1, wakeWaitMs: 600 });
  const { berth, clock, fresh, vmOf } = full;
  const cubed = full.start();
  const status = async (id: string) => (await cubed.conversations.storedHistory(id, { limit: 1 }))?.status;
  const done = (id: string) => until(`${id.slice(0, 8)} settles`, async () => { const s = await status(id); return !!s && s.state !== "working" && s.state !== "idle"; });
  const sleep = async () => { clock.now += 40 * 60_000; for (let round = 0; round < 3; round++) await cubed.conversations.suspendIdle(); };
  /** One guest call of a's run: how often it asked the runner for its machine
   * (one try of the wake, every 50 ms over 600 ms when it waits), and its failure. */
  const call = async (id: string) => {
    const asked = () => berth.asks.get(`machineGet:${vmOf(id)}`) ?? 0;
    const before = asked();
    try { await cubed.machines.guest(fresh(id)).call("stat", { path: "/workspace" }); return { tries: asked() - before, error: null }; }
    catch (error) { return { tries: asked() - before, error: (error as Error).message }; }
  };
  try {
    const a = full.thread();
    await cubed.conversations.activate(a.id);
    await done(a.id);
    await sleep();
    assert.equal(fresh(a.id).vm?.suspension?.state, "suspended");
    const b = full.thread();
    await cubed.conversations.activate(b.id);
    await done(b.id);
    const first = await call(a.id);
    assert.ok(first.tries >= 3 && first.error, `the first call waits its whole time, trying again, then fails: ${first.tries} tries`);
    for (let i = 0; i < 3; i++) {
      const next = await call(a.id);
      assert.equal(next.tries, 1, "a later call of the same run tries once");
      assert.match(next.error ?? "", /waiting for a free slot on runner node-life.*this run already waited its whole time for it, a new message waits again/);
    }
    await cubed.conversations.submit(a.id, "again", "tell-a-again");
    const renewed = await call(a.id);
    assert.ok(renewed.tries >= 3 && renewed.error, `a new message waits its whole time again: ${renewed.tries} tries`);
    // Resumed by its activation, not by a guest call's wake: asleep again
    // on a full runner, its next call waits the whole time.
    await cubed.conversations.archive(b.id);
    await cubed.conversations.activate(a.id);
    assert.equal(fresh(a.id).vm?.suspension, undefined, "with the slot free its activation resumes it");
    await sleep();
    const c = full.thread();
    await cubed.conversations.activate(c.id);
    await done(c.id);
    const afterActivate = await call(a.id);
    assert.ok(afterActivate.tries >= 3 && afterActivate.error, `once it ran, the next wait is whole again: ${afterActivate.tries} tries`);
    await cubed.conversations.archive(c.id);
    const resumed = await call(a.id);
    assert.deepEqual([resumed.error, fresh(a.id).vm?.suspension], [null, undefined], "with the slot free a call resumes the machine");
    assert.equal(berth.resumes(vmOf(a.id)), 2);
    await sleep();
    const d = full.thread();
    await cubed.conversations.activate(d.id);
    await done(d.id);
    const later = await call(a.id);
    assert.ok(later.tries >= 3, `resumed by a call, the next wait is whole again too: ${later.tries} tries`);
    assert.deepEqual(berth.violations, []);
    console.log("ok: R11 a run on a full runner waits once for its sleeping machine; its later guest calls try once; a new message, or a machine that ran (resumed by a call or its activation), waits again");
  } finally {
    await cubed.close().catch(() => {});
    berth.stopAll();
  }
}
// ---------------------------------------------------------------- R12
{
  const down = lifecycle(path.join(root, "down"), { slots: 2 });
  const { berth, clock, fresh } = down;
  const cubed = down.start();
  const round = async (minutes: number) => { clock.now += minutes * 60_000; await cubed.conversations.boot(); };
  try {
    berth.down = true;
    const a = down.thread();
    await cubed.conversations.activate(a.id);
    assert.match(cubed.conversations.waiting(a.id) ?? "", /waiting for runner node-life: it does not answer/);
    assert.equal(cubed.conversations.error(a.id), null, "at first it waits");
    await round(29);
    assert.equal(cubed.conversations.error(a.id), null, "29 min: still waiting");
    assert.equal(fresh(a.id).retry, undefined);
    await round(2);
    assert.match(cubed.conversations.error(a.id) ?? "", /runner node-life has not answered for 30 min/, "past 30 min the wait is a failed start");
    assert.equal(cubed.conversations.waiting(a.id), null);
    assert.equal(fresh(a.id).retry?.failures, 1);
    for (let i = 0; i < 40; i++) await round(10);
    assert.equal(fresh(a.id).retry?.failures, 8, "tried 8 times, then no more");
    assert.match(cubed.conversations.error(a.id) ?? "", /cube stopped retrying after 8 tries in a row, a message to the thread tries once more/);
    const asked = berth.events.length;
    berth.down = false;
    await round(60);
    assert.equal(berth.events.length, asked, "the loop does not try again on its own");
    // The machine starts; its first message (the thread's task) runs first, as in R7.
    await assert.rejects(cubed.conversations.submit(a.id, "go", "tell-a"), /already working/);
    assert.equal(fresh(a.id).workspaceState, "available", "a message tries once more and the runner answers");
    assert.equal(cubed.conversations.error(a.id), null);
    console.log("ok: R12 a new thread on a runner that does not answer waits 30 min, then fails its tries (8, with pauses) saying why; a message tries again");
  } finally {
    await cubed.close().catch(() => {});
    berth.stopAll();
  }
}
// ---------------------------------------------------------------- R12b
{
  const ready = lifecycle(path.join(root, "ready-down"), { slots: 2 });
  const { berth, clock, fresh } = ready;
  let cubed = ready.start();
  const status = async (id: string) => (await cubed.conversations.storedHistory(id, { limit: 1 }))?.status;
  try {
    const a = ready.thread();
    await cubed.conversations.activate(a.id);
    await until("a settles", async () => { const s = await status(a.id); return !!s && s.state !== "working" && s.state !== "idle"; });
    assert.equal(fresh(a.id).workspaceState, "available");
    await cubed.close();
    berth.down = true;
    cubed = ready.start();
    for (let minutes = 0; minutes < 150; minutes += 10) { clock.now += 10 * 60_000; await cubed.conversations.boot(); }
    assert.deepEqual([fresh(a.id).retry, cubed.conversations.error(a.id)], [undefined, null], "a ready thread's wait is no failed start");
    assert.match(cubed.conversations.waiting(a.id) ?? "", /waiting for runner node-life: it does not answer/);
    berth.down = false;
    clock.now += 60_000;
    await cubed.conversations.boot();
    assert.deepEqual([cubed.conversations.waiting(a.id), cubed.conversations.error(a.id), cubed.conversations.agentOpen(a.id)], [null, null, true], "with the runner back it is reattached");
    console.log("ok: R12b a ready thread whose runner does not answer across a restart waits, and is reattached when it is back");
  } finally {
    await cubed.close().catch(() => {});
    berth.stopAll();
  }
}

// ---------------------------------------------------------------- R12c
{
  const host = lifecycle(path.join(root, "host-down"), { slots: 2, kind: "host" });
  const { berth, clock, fresh, registry, model } = host;
  const cubed = host.start();
  try {
    berth.down = true;
    // A host runner is never in the pool: a thread is started on it by name.
    const a = registry.createThread(project.id, "create-host", model, "hello", "pi", undefined, { runnerId: RUNNER });
    await cubed.conversations.activate(a.id);
    for (let minutes = 0; minutes < 150; minutes += 10) { clock.now += 10 * 60_000; await cubed.conversations.boot(); }
    assert.deepEqual([fresh(a.id).retry, cubed.conversations.error(a.id)], [undefined, null], "a host runner's thread waits");
    assert.match(cubed.conversations.waiting(a.id) ?? "", /waiting for runner node-life: it does not answer.*a host runner runs only while someone runs berth host/);
    console.log("ok: R12c a thread on a host runner that is down waits as long as it takes");
  } finally {
    await cubed.close().catch(() => {});
    berth.stopAll();
  }
}
fs.rmSync(root, { recursive: true, force: true });
process.exit(0);
