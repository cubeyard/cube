/** One log line per archive, saying its outcome and where its time went
 * (docs/thread-lifecycle.md, "Archive timing"), offline over the runtime
 * cubed builds (thread-runtime.ts) and the stand-in berth vm
 * (lifecycle-fixture.ts) with the real guest helper. Each archive below logs
 * exactly one line, with the phases it ran and none it did not:
 *
 *   clean (agent open): archived, disk deleted, the release check's exec and
 *     wait, the release;
 *   a file in the workspace: disk retained, with the check's reason;
 *   agent closed (a restart): the check opened it;
 *   asleep, a slot free: woken for the check; asleep, the runner full: kept
 *     unchecked, no check;
 *   a second archive behind the first: queued, then already;
 *   working: refused, nothing released;
 *   the runner's delete fails: failed, with why, at warn.
 * No line carries the machine's placeholders. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { Registry, type Thread } from "../src/registry.ts";
import { threadRuntime } from "../src/thread-runtime.ts";
import { FakeBerth, NODE, Phase, project, RUNNER, until } from "./lifecycle-fixture.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-archive-timing-"));
// The thread component's lines, as journald gets them (log.ts): `level component msg key=value …`.
const lines: string[] = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
  const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  for (const line of text.split("\n")) if (/^(info|warn) threads archive/.test(line)) lines.push(line);
  return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
}) as typeof process.stdout.write;
/** The fields of a log line (values JSON-quoted when they need it). */
const fields = (line: string) => Object.fromEntries([...line.matchAll(/ ([a-zA-Z]+)=("(?:[^"\\]|\\.)*"|\S+)/g)].map(([, key, value]) => [key!, value!.startsWith("\"") ? JSON.parse(value!) as string : value!]));
const linesOf = (id: string) => lines.filter(line => line.includes(` thread=${id}`));

let release: () => void = () => {};
let held = false;
const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
faux.setResponses(Array.from({ length: 200 }, () => async (request: { messages: unknown[] }) => {
  // The first request of a HOLD thread waits until the test releases it.
  if (!held && JSON.stringify(request.messages).includes("HOLD")) { held = true; await new Promise<void>(resolve => { release = resolve; }); }
  return fauxAssistantMessage("done");
}));
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, id: faux.getModel().id };
const registry = new Registry(path.join(root, "registry.sqlite"));
registry.saveProject(project);
registry.enrollRunner({ nodeId: NODE, threadId: RUNNER, environmentId: 1, configPath: path.join(root, "runner.json"), configHash: RUNNER, maxActiveVms: 3, protocol: 4, kind: "vm" } as never);
const berth = new FakeBerth(path.join(root, "runner"), 3);
const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;
const start = () => threadRuntime({ registry, threads: path.join(root, "threads"), models,
  runner: { session: () => berth.session(), policy: { policyFor: () => ({}) }, log: quiet, templates: { enabled: false, ttlMs: 0 }, idleMs: 60_000 } });
let runtime = start();
const fresh = (id: string) => registry.getThread(id)!;
let requests = 0;
const made = async (text = "hello") => {
  const thread: Thread = registry.createThread(project.id, `t-${++requests}`, model, text);
  await runtime.conversations.activate(thread.id);
  if (text !== "HOLD") {
    await until(`${thread.id.slice(0, 8)} settles`, async () => {
      const status = (await runtime.conversations.storedHistory(thread.id, { limit: 1 }))?.status;
      return !!status && status.state !== "working" && status.state !== "idle";
    });
  }
  return thread.id;
};
const one = (id: string) => {
  const own = linesOf(id);
  assert.equal(own.length, 1, `one archive line for ${id.slice(0, 8)}: ${own.join(" | ")}`);
  return { line: own[0]!, f: fields(own[0]!) };
};
const number = (value: string | undefined) => value === undefined ? undefined : Number(value);
try {
  // Clean, agent open: deleted; the check's exec and wait, then the release.
  const clean = await made();
  await runtime.conversations.archive(clean);
  {
    const { line, f } = one(clean);
    assert.match(line, /^info threads archive /);
    assert.deepEqual([f.outcome, f.disk, f.reason, f.agent, f.wake], ["archived", "deleted", "clean", "open", undefined]);
    for (const key of ["ms", "queueMs", "settleMs", "agentMs", "closeMs", "wakeMs", "checkMs", "checkExecMs", "checkWaitMs", "releaseMs"]) assert.ok(number(f[key])! >= 0, `${key} is measured: ${line}`);
    assert.ok(number(f.ms)! >= number(f.checkMs)! + number(f.releaseMs)! - 1, "the total holds its phases");
    assert.ok(number(f.checkMs)! >= number(f.checkExecMs)! + number(f.checkWaitMs)! - 1, "the check holds its exec and its wait");
    for (const placeholder of Object.values(fresh(clean).vm!.placeholders)) assert.ok(!line.includes(String(placeholder)), "no placeholder in the line");
  }
  console.log("ok: a clean archive logs one line: archived, deleted, each phase it ran (the check's exec and wait, the release)");

  // A file in the empty project's workspace: retained, with the check's reason.
  const dirty = await made();
  fs.writeFileSync(path.join(berth.guestOf(fresh(dirty).vm!.vmId).root, "workspace", "notes.txt"), "work\n");
  await runtime.conversations.archive(dirty);
  assert.deepEqual([one(dirty).f.outcome, one(dirty).f.disk, one(dirty).f.reason], ["archived", "retained", "the workspace is not empty: notes.txt is not a checkout"]);
  console.log("ok: a workspace with a file is retained, and its line says why");

  // Agent closed (cubed restarted): the working check opened it.
  const closed = await made();
  await runtime.conversations.close(2000);
  runtime = start();
  await runtime.conversations.archive(closed);
  assert.deepEqual([one(closed).f.outcome, one(closed).f.agent, one(closed).f.disk], ["archived", "opened", "deleted"]);
  console.log("ok: an archive after a restart says the check opened the agent");

  // Asleep with a slot free: woken for the check. Asleep with the runner full: kept unchecked, no check.
  const woken = await made();
  registry.applySleep(woken, { type: "suspended", at: Date.now() });
  berth.phases.set(fresh(woken).vm!.vmId, Phase.SUSPENDED);
  await runtime.conversations.archive(woken);
  assert.deepEqual([one(woken).f.wake, one(woken).f.disk], ["woken", "deleted"]);
  assert.ok(number(one(woken).f.wakeMs)! >= 0 && number(one(woken).f.checkMs)! >= 0);
  const kept = await made();
  registry.applySleep(kept, { type: "suspended", at: Date.now() });
  berth.phases.set(fresh(kept).vm!.vmId, Phase.SUSPENDED);
  const fill = [await made(), await made(), await made()];
  await runtime.conversations.archive(kept);
  {
    const { f } = one(kept);
    assert.deepEqual([f.wake, f.disk, f.checkMs, f.checkExecMs], ["kept unchecked", "retained", undefined, undefined], "no check of a machine left asleep");
    assert.match(f.reason!, /its machine is suspended and was not woken to check it/);
  }
  for (const id of fill.slice(1)) await runtime.conversations.archive(id);
  console.log("ok: an asleep machine is woken for the check when a slot is free; with the runner full its disk is kept unchecked, and the line says which");

  // A second archive behind the first: queued, then already.
  const twice = fill[0]!;
  await Promise.all([runtime.conversations.archive(twice), runtime.conversations.archive(twice)]);
  {
    const both = linesOf(twice).map(fields);
    assert.deepEqual(both.map(f => f.outcome).sort(), ["already", "archived"], "two lines, one per archive");
    const second = both.find(f => f.outcome === "already")!;
    assert.ok(number(second.queueMs)! >= 0 && second.releaseMs === undefined, "the second waited its turn and released nothing");
  }
  console.log("ok: an archive behind another waits its turn (queueMs) and finds it archived");

  // Working: refused, nothing released.
  const working = await made("HOLD");
  await until("the run works", async () => (await runtime.conversations.storedHistory(working, { limit: 1 }))?.status.state === "working");
  await assert.rejects(runtime.conversations.archive(working), /stop the current run/);
  {
    const { line, f } = one(working);
    assert.match(line, /^info threads archive refused /);
    assert.deepEqual([f.outcome, f.disk, f.releaseMs, f.checkMs], ["refused", undefined, undefined, undefined]);
    assert.equal(fresh(working).archived, false);
  }
  release();
  console.log("ok: archiving a working thread is refused, its line says so, nothing is released");

  // The runner's delete fails: failed, with why, at warn; the disk's fate is not claimed.
  const failing = await made();
  berth.failDeletes = 1;
  await assert.rejects(runtime.conversations.archive(failing), /the disk could not be removed/);
  {
    const { line, f } = one(failing);
    assert.match(line, /^warn threads archive failed /);
    assert.deepEqual([f.outcome, f.disk], ["failed", undefined]);
    assert.match(f.reason!, /workspace release failed: .*the disk could not be removed/);
    assert.ok(number(f.releaseMs)! >= 0 && number(f.checkMs)! >= 0, "it timed the check and the release it got to");
  }
  console.log("ok: a release the runner fails logs a warn line with why, after the check and the release it timed");
} catch (error) {
  // Kept for the reader: every archive line this run logged.
  console.error(lines.join("\n"));
  throw error;
} finally {
  process.stdout.write = write;
  release();
  await runtime.conversations.close(2000).catch(() => {});
  berth.stopAll();
  registry.close();
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(0);
