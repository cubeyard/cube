/** Model-based test of the thread lifecycle, offline (lifecycle-fixture.ts):
 * seeded random runs of what users, OptChat and cubed itself do (create a
 * thread, a message and its replay, every read, idle rounds, recovery
 * rounds, a cubed restart with a wake cut short, an archive), with these
 * checked after every step:
 *
 *   I1  a read changes nothing on the runner;
 *   I2  a replayed message changes nothing on the runner;
 *   I3  an archived thread's machine is never asked for anything again but
 *       its release;
 *   I4  the runner never holds more machines than the registry counts, nor
 *       the registry more than the runner's slots (a wake is reserved like
 *       a new thread);
 *   I5  after a restart's first round no `waking` is left without an owner;
 *   I6  a restart wakes exactly the sleeping threads with a stored run that
 *       did not finish;
 *   I8  a machine whose create keeps failing is asked for at most 8 times;
 *   I9  an archive answers within seconds, also for a sleeping machine on a
 *       full runner;
 *   G   no guest call reaches a machine that does not run;
 *
 * and at the end, every message request id is in its thread's store once.
 * LIFECYCLE_SEEDS (comma-separated) picks the seeds; LIFECYCLE_STEPS the
 * length of a run. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { START_TRIES } from "../src/thread-recovery.ts";
import { lifecycle, until, Phase, type Cubed } from "./lifecycle-fixture.ts";

const seeds = (process.env.LIFECYCLE_SEEDS ?? "1,2").split(",").map(Number);
const steps = Number(process.env.LIFECYCLE_STEPS ?? 28);

function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, pick: <T>(items: readonly T[]): T | undefined => items.length ? items[Math.floor(next() * items.length)] : undefined };
}

for (const seed of seeds) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `cube-lifecycle-model-${seed}-`));
  const life = lifecycle(root, { slots: 2 });
  const { registry, berth, clock, fresh, vmOf, held } = life;
  const rng = random(seed);
  let cubed: Cubed = life.start();
  const tells: Array<{ id: string; requestId: string; text: string }> = [];
  const archivedAt = new Map<string, number>();
  const broken = new Set<string>();
  const trace: string[] = [];
  const open = () => registry.listThreads().filter(t => !t.archived);
  const stored = async (id: string) => (await cubed.conversations.storedHistory(id, { limit: 1 }).catch(() => null))?.status;
  const quiet = async () => {
    for (const t of open()) await until(`${t.id.slice(0, 8)} quiet`, async () => (await stored(t.id))?.state !== "working", 15_000).catch(() => {});
  };
  const actions: Record<string, () => Promise<void>> = {
    async create() {
      let thread;
      try { thread = life.thread(); } catch { trace.push("create refused: no free slot"); return; }
      await cubed.conversations.activate(thread.id);
      trace.push(`create ${thread.id.slice(0, 8)} -> ${fresh(thread.id).workspaceState}`);
    },
    async broken() {
      let thread;
      try { thread = life.thread(); } catch { trace.push("broken create refused: no free slot"); return; }
      berth.failCreates.set(vmOf(thread.id), "the runner cannot make its disk");
      broken.add(vmOf(thread.id));
      await cubed.conversations.activate(thread.id);
      trace.push(`broken ${thread.id.slice(0, 8)} -> ${fresh(thread.id).workspaceState}`);
    },
    async replay() {
      const tell = rng.pick(tells.filter(t => !fresh(t.id).archived));
      if (!tell) return;
      const since = berth.events.length;
      await cubed.conversations.submit(tell.id, tell.text, tell.requestId);
      assert.deepEqual(berth.events.slice(since).filter(e => e.op !== "machineGet"), [], `I2: replaying ${tell.requestId} changed nothing on the runner`);
      trace.push(`replay ${tell.requestId}`);
    },
    async tell() {
      const t = rng.pick(open().filter(t => t.workspaceState === "available"));
      if (!t) return;
      const tell = { id: t.id, requestId: `tell-${seed}-${tells.length}`, text: `step ${tells.length}` };
      const result = await cubed.conversations.submit(t.id, tell.text, tell.requestId).then(() => "accepted", (error: Error) => error.message);
      if (result === "accepted") tells.push(tell);
      trace.push(`tell ${t.id.slice(0, 8)}: ${result}`);
      await quiet();
    },
    async read() {
      const t = rng.pick(open());
      if (!t) return;
      const since = berth.events.length;
      await cubed.conversations.storedHistory(t.id, { limit: 3 });
      if (t.workspaceState === "available") {
        await cubed.conversations.history(t.id).catch(() => null);
        await cubed.conversations.model(t.id).catch(() => null);
      }
      assert.deepEqual(berth.events.slice(since).filter(e => e.op !== "machineGet"), [], `I1: reading ${t.id.slice(0, 8)} changed nothing on the runner`);
      trace.push(`read ${t.id.slice(0, 8)}`);
    },
    async idle() {
      clock.now += 40 * 60_000;
      for (let round = 0; round < 3; round++) await cubed.conversations.suspendIdle();
      trace.push(`idle (${berth.running()} running)`);
    },
    async recover() {
      // Recovery rounds over a few minutes of the clock.
      const minutes = 1 + Math.floor(rng.next() * 20);
      for (let spent = 0; spent < minutes; spent++) { clock.now += 60_000; await cubed.conversations.recover(); }
      trace.push(`recover ${minutes} min`);
    },
    async restart() {
      // Sometimes cubed stops in the middle of a wake.
      const cut = rng.next() < 0.5 ? rng.pick(open().filter(t => t.vm?.suspension?.state === "suspended")) : undefined;
      if (cut) registry.updateThreadVm(cut.id, { suspension: { ...cut.vm!.suspension!, state: "waking" } });
      await cubed.close();
      const asleep = open().filter(t => t.vm?.suspension);
      const demand = new Set<string>();
      for (const t of asleep) if ((await stored(t.id))?.state === "working") demand.add(vmOf(t.id));
      const since = berth.events.length;
      cubed = life.start();
      await cubed.conversations.boot();
      for (const t of asleep) {
        const resumed = berth.touched(vmOf(t.id), since).filter(e => e.op === "machineStart" && e.from === Phase.SUSPENDED && e.to === Phase.RUNNING).length;
        assert.equal(resumed, demand.has(vmOf(t.id)) ? 1 : 0, `I6: ${t.id.slice(0, 8)} is woken by the restart only for a stored unfinished run`);
      }
      for (const t of open()) {
        const sleep = fresh(t.id).vm?.suspension;
        assert.ok(!(sleep?.state === "waking" && !sleep.waiting && !cubed.machines.wakeInFlight(fresh(t.id))), `I5: ${t.id.slice(0, 8)} has no waking without an owner`);
      }
      trace.push(`restart${cut ? ` (wake of ${cut.id.slice(0, 8)} cut short)` : ""}`);
      await quiet();
    },
    async archive() {
      const t = rng.pick(open().filter(t => t.workspaceState === "available" || t.workspaceState === "failed"));
      if (!t) return;
      const began = Date.now();
      const result = await cubed.conversations.archive(t.id).then(r => `retained=${r.retained}`, (error: Error) => error.message);
      assert.ok(Date.now() - began < 5_000, `I9: archiving ${t.id.slice(0, 8)} took ${Date.now() - began} ms`);
      if (fresh(t.id).archived) archivedAt.set(vmOf(t.id), berth.events.length);
      trace.push(`archive ${t.id.slice(0, 8)}: ${result}`);
    },
  };
  const weights: Array<[string, number]> = [["create", 3], ["broken", 1], ["tell", 4], ["replay", 2], ["read", 4], ["idle", 3], ["recover", 2], ["restart", 2], ["archive", 1]];
  const choose = () => {
    let roll = rng.next() * weights.reduce((sum, [, w]) => sum + w, 0);
    for (const [name, w] of weights) { roll -= w; if (roll < 0) return name; }
    return weights[0]![0];
  };
  try {
    await actions.create!();
    for (let step = 0; step < steps; step++) {
      const name = choose();
      await actions[name]!();
      assert.deepEqual(berth.violations, [], `G after ${name}`);
      assert.ok(berth.holding() <= held() && held() <= berth.slots, `I4 after ${name}: the runner holds ${berth.holding()}, the registry counts ${held()}, of ${berth.slots} slots`);
      for (const vm of broken) assert.ok(berth.asked("machineCreate", vm) <= START_TRIES, `I8: ${vm}'s create was asked for ${berth.asked("machineCreate", vm)} times`);
      for (const [vm, at] of archivedAt) {
        assert.deepEqual(berth.touched(vm, at).filter(e => e.op !== "machineGet" && e.op !== "machineDelete" && e.op !== "machineDiscard"), [],
          `I3: archived machine ${vm} was not asked to run again`);
      }
    }
    await quiet();
    for (const tell of tells) {
      const db = new DatabaseSync(path.join(root, "threads", tell.id, "pi.sqlite"), { readOnly: true });
      const { n } = db.prepare("SELECT count(*) AS n FROM submissions WHERE json_extract(record, '$.requestId') = ?").get(tell.requestId) as { n: number };
      db.close();
      assert.equal(n, 1, `${tell.requestId} is in its thread's store once`);
    }
    console.log(`ok: lifecycle model seed ${seed}: ${steps} steps (${trace.filter(line => line.startsWith("restart")).length} restarts, ${tells.length} messages, ${archivedAt.size} archives, ${berth.starts()} starts on the runner); I1–I6, I8, I9 and G held`);
  } catch (error) {
    console.error(`seed ${seed} trace:\n  ${trace.join("\n  ")}`);
    throw error;
  } finally {
    await cubed.close().catch(() => {});
    berth.stopAll();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
process.exit(0);
