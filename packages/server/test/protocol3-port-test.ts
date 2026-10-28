/** Every ThreadMachines member on a thread whose runner is protocol 3
 * (retired), offline: no runner session is asked for and the thread's
 * registry row is unchanged, whatever the member answers. The table is
 * typed by the port's keys, so a new member does not compile until it has
 * a row here.
 *
 *   gated     RunnerMachines as cubed runs it: each member's own answer
 *             (refused with PROTOCOL_3_RETIRED, or as a machine that never
 *             ran; release keeps the disk's record).
 *   ungated   the same members with their own check forgotten
 *             (`retired` answers false): `session` alone must refuse, so
 *             removing that last check fails this test.
 *
 * The row is `waking` (the hardest case: settleWake, wakeNow and dial
 * all act on it; a wake is Conversations', by start) and its machine was allocated. Real Registry,
 * disposable state; the session seam only counts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { Registry, type Thread } from "../src/registry.ts";
import { RunnerMachines, type RunnerMachinesOptions } from "../src/runner-machines.ts";
import { PROTOCOL_3_RETIRED } from "../src/runner-select.ts";
import type { RunnerSession } from "../src/runner-session.ts";
import type { ThreadMachines } from "../src/vm.ts";
import { project } from "./lifecycle-fixture.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-p3-port-"));
const file = path.join(root, "registry.sqlite");
const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;
const faux = fauxProvider();
createModels().setProvider(faux.provider);
const model = { provider: faux.getModel().provider, id: faux.getModel().id };

/** What each member returns or throws, by member. */
type Outcome = { value: unknown } | { error: string };
const P3 = { error: PROTOCOL_3_RETIRED };
/** One call of every member, in the port's own terms. */
const members = {
  guest: (m, t) => m.guest(t).call("stat", { path: "/workspace" }),
  start: (m, t) => m.start(t),
  invalidateTemplate: (m, t) => m.invalidateTemplate(t, "template-1"),
  release: (m, t) => m.release(t, false),
  discard: (m, t) => m.discard(t),
  close: m => m.close(),
  running: (m, t) => m.running(t),
  dial: (m, t) => m.dial(t, 8080),
  suspended: (m, t) => m.suspended(t),
  suspendIfIdle: (m, t) => m.suspendIfIdle(t, async () => null),
  touch: (m, t) => m.touch(t),
  idleMs: (m, t) => m.idleMs?.(t),
  wakeInFlight: (m, t) => m.wakeInFlight(t),
  wakeNow: (m, t) => m.wakeNow(t),
  settleWake: (m, t) => m.settleWake(t),
  diagnose: (m, t) => m.diagnose(t),
  startupLog: (m, t) => m.startupLog(t),
} satisfies Record<keyof ThreadMachines, (machines: ThreadMachines, thread: Thread) => unknown>;
/** RunnerMachines' own answers on a retired runner (the old RetiredProtocolMachines'). */
const gated: Record<keyof typeof members, Outcome> = {
  guest: P3, start: P3, invalidateTemplate: { value: undefined }, release: { value: { retained: true } }, discard: P3, close: { value: undefined },
  running: { value: false }, dial: P3, suspended: { value: false }, suspendIfIdle: { value: false }, touch: { value: undefined }, idleMs: { value: 0 },
  wakeInFlight: { value: false }, wakeNow: { value: null }, settleWake: { value: undefined }, diagnose: P3,
  startupLog: { value: null },
};

/** A thread on runner `old`: enrolled with protocol 4, its machine allocated
 * and waking, then the row rewritten as an older cubed's protocol-3 row. */
function retiredThread(): { registry: Registry; thread: Thread } {
  let registry = new Registry(file);
  registry.saveProject(project);
  registry.enrollRunner({ nodeId: "node-old", threadId: "old", environmentId: 1, configPath: path.join(root, "old.json"), configHash: "old", maxActiveVms: 4,
    protocol: 4, kind: "vm" });
  const created = registry.createThread(project.id, "p3", model, "hello", "pi", undefined, { runnerId: "old" });
  registry.markPlacement(created.id, "old", ["provisional"], "allocated");
  registry.applySleep(created.id, { type: "wakeAsked", waiting: "unused" }, 1);
  registry.close();
  const sqlite = new DatabaseSync(file);
  sqlite.prepare("UPDATE runner SET data=json_remove(data,'$.protocol','$.kind') WHERE id='old'").run();
  sqlite.close();
  registry = new Registry(file);
  return { registry, thread: registry.getThread(created.id)! };
}

const { registry, thread } = retiredThread();
const sessions: string[] = [];
const options: RunnerMachinesOptions = { registry, threads: path.join(root, "threads"), log: quiet, templates: { enabled: false, ttlMs: 0 },
  session: admission => { sessions.push(admission.configHash); return {} as RunnerSession; } };
/** A RunnerMachines whose members forgot to ask whether the runner is retired. */
class Ungated extends RunnerMachines { protected override retired(): boolean { return false; } }

const outcome = async (call: () => unknown): Promise<Outcome> => {
  try { return { value: await call() }; } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
};
try {
  const row = JSON.stringify(registry.getThread(thread.id));
  for (const [name, machines] of [["gated", new RunnerMachines(options)], ["ungated", new Ungated(options)]] as const) {
    const seen: Partial<Record<keyof typeof members, Outcome>> = {};
    for (const [member, call] of Object.entries(members) as Array<[keyof typeof members, (m: ThreadMachines, t: Thread) => unknown]>) {
      seen[member] = await outcome(() => call(machines, registry.getThread(thread.id)!));
      assert.deepEqual(sessions, [], `${name} ${member}: no session to the protocol-3 runner is asked for`);
      assert.equal(JSON.stringify(registry.getThread(thread.id)), row, `${name} ${member}: the thread's row is unchanged`);
    }
    if (name === "gated") assert.deepEqual(seen, gated, "each member answers as a machine on a retired runner");
    else {
      // Every member that would reach the runner is refused by `session`
      // itself; discard (a row without `kind` reads as a host runner's) stops
      // at its own refusal before it.
      // dial no longer wakes (Conversations does): a machine not running is
      // refused before any session.
      assert.deepEqual(seen.dial, { error: "the thread's machine is not running" });
      const refused = Object.entries(seen).filter(([member, seen]) => member !== "dial" && "error" in seen).map(([member, seen]) => [member, (seen as { error: string }).error]);
      assert.deepEqual(refused.map(([member, error]) => [member, member === "discard" ? /never deletes a machine's directory/.test(error) : error === PROTOCOL_3_RETIRED]),
        ["guest", "start", "release", "discard", "wakeNow", "settleWake", "diagnose"].map(member => [member, true]));
    }
  }
  console.log(`ok: all ${Object.keys(members).length} ThreadMachines members on a protocol-3 thread: no session, no registry change; gated they answer as before, ungated session() refuses`);
} finally {
  registry.close();
  fs.rmSync(root, { recursive: true, force: true });
}
