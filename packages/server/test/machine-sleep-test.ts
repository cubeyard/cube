/** A thread machine's sleep (machine-sleep.ts), offline: every event from
 * every sleep, the slot rule in SQL against `holdsSlot`, and the persisted
 * shape, through a real Registry on disposable state.
 *
 *   T1  each event from each sleep gives the one sleep the table names, and
 *       no `suspended` sleep carries a `waiting`;
 *   T2  for every sleep the registry's slot count (HOLDS_SLOT_SQL) equals
 *       `holdsSlot`, and the runner's summary follows in the same write;
 *   T3  `wakeAsked` reserves a slot only when one is free, as a new thread's
 *       placement does, and refuses an archived thread;
 *   T4  rows keep the shape older cubeds wrote and read, both ways;
 *   T5  `updateThreadVm` cannot write a sleep (a compile error). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { holdsSlot, nextSleep, slotWait, type MachineSleep, type SleepEvent } from "../src/machine-sleep.ts";
import { Registry } from "../src/registry.ts";
import { project } from "./lifecycle-fixture.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-machine-sleep-"));
const file = path.join(root, "registry.sqlite");
const model = { provider: "faux", id: "faux" };
const WAIT = "waiting for a free slot on runner node-sleep";
const NOW = 5000;

// ---------------------------------------------------------------- T1
const sleeps: Record<string, MachineSleep | undefined> = {
  running: undefined,
  suspended: { state: "suspended", at: 1, memoryBytes: 64 },
  waking: { state: "waking", at: 1, memoryBytes: 64 },
  waiting: { state: "waking", at: 1, memoryBytes: 64, waiting: WAIT },
};
/** One of each event, typed by the event's kinds: a new kind does not
 * compile until it has a row here and in `expected`. */
const events: { [K in SleepEvent["type"]]: Extract<SleepEvent, { type: K }> } = {
  suspended: { type: "suspended", at: 9, memoryBytes: 128 },
  wakeAsked: { type: "wakeAsked", waiting: WAIT },
  slotTaken: { type: "slotTaken", waiting: WAIT },
  wakeDropped: { type: "wakeDropped" },
  running: { type: "running" },
  resumed: { type: "resumed", notice: null },
};
/** The sleep after each event, from a sleep saved at 1 with 64 bytes (from
 * running: saved now, with none), with and without a free slot. */
const kept = (from: MachineSleep | undefined) => from ? { at: 1, memoryBytes: 64 } : { at: NOW };
const expected: Record<SleepEvent["type"], (from: MachineSleep | undefined, slotFree: boolean) => MachineSleep | undefined> = {
  suspended: () => ({ state: "suspended", at: 9, memoryBytes: 128 }),
  wakeAsked: (from, slotFree) => ({ state: "waking", ...kept(from), ...slotFree ? {} : { waiting: WAIT } }),
  slotTaken: from => ({ state: "waking", ...kept(from), waiting: WAIT }),
  wakeDropped: from => ({ state: "suspended", ...kept(from) }),
  running: () => undefined,
  resumed: () => undefined,
};
let cases = 0;
for (const [name, from] of Object.entries(sleeps)) {
  for (const event of Object.values(events)) {
    for (const slotFree of [true, false]) {
      const after = nextSleep(from, event, { now: NOW, slotFree });
      assert.deepEqual(after, expected[event.type](from, slotFree), `${event.type} from ${name} (slot ${slotFree ? "free" : "taken"})`);
      if (after?.state === "suspended") assert.ok(!("waiting" in after), `${event.type} from ${name}: a suspended machine waits for nothing`);
      cases++;
    }
  }
}
console.log(`ok: T1 every event from every sleep (${cases} cases) gives the table's sleep; none suspended and waiting`);

// ---------------------------------------------------------------- T2, T3
let registry = new Registry(file);
registry.saveProject(project);
registry.enrollRunner({ nodeId: "node-sleep", threadId: "sleep", environmentId: 1, configPath: path.join(root, "runner.json"), configHash: "h", maxActiveVms: 2,
  protocol: 4, kind: "vm" });
const a = registry.createThread(project.id, "a", model, "hello").id;
const b = registry.createThread(project.id, "b", model, "hello").id;
const runnerId = registry.getThread(a)!.runnerId;
const sleepOf = (id: string) => registry.getThread(id)!.vm?.suspension;
/** The slots the registry counts as held (SQL), against `holdsSlot` (TS). */
const agree = (why: string) => {
  const { free, total } = registry.runnerSlots();
  const held = [a, b].filter(id => holdsSlot(sleepOf(id))).length;
  assert.equal(total - free, held, `${why}: the registry counts ${total - free} held, holdsSlot ${held}`);
  assert.equal(registry.runnerStatuses().find(row => row.id === runnerId)!.allocationState, held < 2 ? "available" : "allocating", `${why}: the runner's summary follows`);
};
agree("both running");
const steps: Array<[string, string, SleepEvent]> = [
  ["a suspended", a, events.suspended],
  ["a woken: a slot is free", a, events.wakeAsked],
  ["a's runner full after all", a, events.slotTaken],
  ["a's wake dropped", a, events.wakeDropped],
  ["b suspended", b, events.suspended],
  ["a woken again", a, events.wakeAsked],
  ["a resumed", a, { type: "resumed", notice: { text: "restarted", at: 2 } }],
  ["b woken", b, events.wakeAsked],
  ["b read back running", b, events.running],
];
for (const [why, id, event] of steps) {
  registry.applySleep(id, event, NOW);
  agree(why);
}
assert.equal(registry.getThread(a)!.vm?.notice?.text, "restarted", "resumed from its disk: the notice is kept");
registry.applySleep(a, { type: "suspended", at: NOW });
assert.equal(registry.getThread(a)!.vm?.notice?.text, "restarted", "a sleep keeps the notice");
registry.applySleep(a, { type: "resumed", notice: null });
assert.equal(registry.getThread(a)!.vm?.notice, undefined, "a later resume clears it");
console.log("ok: T2 for every sleep the registry's slot count equals holdsSlot, and the runner's summary follows");

registry.applySleep(a, events.suspended, NOW);
// A third thread takes the slot a freed: a's wake then waits and holds none.
registry.createThread(project.id, "c", model, "hello");
assert.equal(slotWait(registry.applySleep(a, events.wakeAsked, NOW)), WAIT, "no slot free: the wake waits");
assert.equal(registry.runnerSlots().free, 0);
assert.throws(() => registry.createThread(project.id, "d", model, "hello"), /no free thread machine/, "and no placement counts on a's slot");
console.log("ok: T3 a wake reserves a slot only when one is free");

// ---------------------------------------------------------------- T4
registry.applySleep(b, { type: "suspended", at: 7, memoryBytes: 32 }, NOW);
registry.close();
const raw = new DatabaseSync(file);
const stored = (id: string) => JSON.parse(String((raw.prepare("SELECT data FROM thread WHERE id=?").get(id) as { data: string }).data)).vm.suspension;
assert.deepEqual(stored(b), { state: "suspended", at: 7, memoryBytes: 32 }, "the shape v0.3.37 writes");
assert.deepEqual(stored(a), { state: "waking", at: 9, memoryBytes: 128, waiting: WAIT });
// A row as v0.3.37 wrote it (waking, no memory) reads and changes as any other.
raw.prepare("UPDATE thread SET data=json_set(data,'$.vm.suspension',json(?)) WHERE id=?").run(JSON.stringify({ state: "waking", at: 3 }), b);
raw.close();
registry = new Registry(file);
assert.deepEqual(registry.getThread(b)!.vm?.suspension, { state: "waking", at: 3 });
assert.deepEqual(registry.applySleep(b, events.wakeDropped, NOW), { state: "suspended", at: 3 });
registry.close();
console.log("ok: T4 rows keep the shape older cubeds write and read");

// ---------------------------------------------------------------- T5
/** Never called: it only has to fail to compile without the expectation. */
export function onlyApplySleepWritesASleep(r: Registry) {
  // @ts-expect-error the sleep changes only by applySleep
  r.updateThreadVm("t", { suspension: { state: "suspended", at: 1 } });
  // @ts-expect-error a suspended machine waits for nothing
  const contradiction: MachineSleep = { state: "suspended", at: 1, waiting: WAIT };
  return contradiction;
}
console.log("ok: T5 updateThreadVm cannot write a sleep, and a suspended sleep cannot wait (typecheck)");
fs.rmSync(root, { recursive: true, force: true });
