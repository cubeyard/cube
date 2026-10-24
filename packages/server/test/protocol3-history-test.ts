/** Threads across the removal of protocol 3 (phase 9), offline: a thread
 * that ran on a runner enrolled with protocol 3 before the upgrade keeps its
 * history, and cubed never contacts that runner again: no probe, no runner
 * session asked for, no machine start, an archive that keeps the record of
 * its disk and leaves the disk where it is, no discard. Threads on
 * protocol-4 runners (a berth vm and a berth host) in the same cubed go on
 * as before. cubed's own machines (thread-runtime.ts) over a stand-in berth
 * per runner (lifecycle-fixture.ts), faux model, disposable state; real
 * berth runs are in runner-host-cubed-test.ts and runner-vm-cubed-test.ts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { PROTOCOL_3_RETIRED } from "../src/runner-select.ts";
import type { TrustedRunnerHealth } from "../src/runner-types.ts";
import { FakeBerth, Phase } from "./lifecycle-fixture.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-p3-history-"));
const state = path.join(root, "state");
/** One stand-in runner per enrolled runner, by its id (the config hash). */
const berths: Record<string, FakeBerth> = {
  old: new FakeBerth(path.join(root, "old"), 4), vm: new FakeBerth(path.join(root, "vm"), 4), host: new FakeBerth(path.join(root, "host"), 4, "host"),
};
/** Every runner session cubed asked for, by runner id. */
const sessions: string[] = [];
const faux = fauxProvider({ tokensPerSecond: 100_000 });
let answers = 0;
faux.setResponses(Array.from({ length: 12 }, () => () => fauxAssistantMessage(`answer ${++answers}`)));
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, id: faux.getModel().id };
const health: TrustedRunnerHealth = { lifecycle: "ready", draining: false, error: null, activeVms: 0, runningVms: 0, maxActiveVms: 4,
  retainedVms: 0, retainedBytes: 0, softwareVersion: "test", protocolVersion: 4 };
const asked: string[] = [];
const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;
const open = () => createCubed({ state, models, claude: null, gateway: null, skillSource: null, runnerProbeIntervalMs: 20,
  runnerHealth: async runner => { asked.push(runner.nodeId); return { ...health, kind: runner.kind ?? "vm" }; },
  runner: { log: quiet, templates: { enabled: false, ttlMs: 0 },
    session: admission => { sessions.push(admission.configHash); return berths[admission.configHash]!.session(); } } });
/** A stored history page's transcript: its status and events (not which agent holds it now). */
const texts = (page: { status?: unknown; total?: number; events?: unknown[] } | null) => JSON.stringify(page ? { status: page.status, total: page.total, events: page.events } : null);

let app = await open();
try {
  // Before the upgrade: a thread on the runner that is protocol 3 after it
  // (here still a protocol-4 row, so this cubed runs it), one on a berth vm
  // and one on a berth host.
  const enroll = (id: string, kind: "vm" | "host") => app.registry.enrollRunner({ nodeId: `node-${id}`, threadId: id, environmentId: 1,
    configPath: path.join(root, `${id}.json`), configHash: id, maxActiveVms: 4, protocol: 4, kind });
  enroll("old", "vm");
  enroll("vm", "vm");
  enroll("host", "host");
  app.registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  const done = async (id: string) => {
    for (let k = 0; (await app.conversations.history(id)).status.state !== "completed"; k++) { assert.ok(k < 400, `thread ${id} completes`); await delay(25); }
  };
  const create = async (request: string, runnerId: string) => {
    const thread = app.registry.createThread("p", request, model, `${request} task`, "pi", undefined, { runnerId });
    await app.conversations.activate(thread.id);
    await done(thread.id);
    return thread;
  };
  const old = await create("old", "old");
  const onVm = await create("vm", "vm");
  const onHost = await create("host", "host");
  const oldVm = app.registry.getThread(old.id)!.vm!.vmId;
  assert.equal(berths.old!.phases.get(oldVm), Phase.RUNNING, "its machine runs on its runner, as every protocol-3 thread's did");
  const before = texts(await app.conversations.storedHistory(old.id));
  assert.match(before, /old task/);
  assert.match(before, /answer 1/);
  await app.close();

  // The upgrade: the row is a protocol-3 runner's, as an older cubed wrote it.
  const sqlite = new DatabaseSync(path.join(state, "registry.sqlite"));
  sqlite.prepare("UPDATE runner SET data=json_remove(data,'$.protocol','$.kind') WHERE id='old'").run();
  sqlite.close();
  const oldEvents = berths.old!.events.length;
  asked.length = 0;
  sessions.length = 0;
  app = await open();
  await app.conversations.activate(old.id).catch(() => {});
  assert.match(app.conversations.error(old.id) ?? "", new RegExp(PROTOCOL_3_RETIRED.slice(0, 60).replace(/[()]/g, "\\$&")));
  assert.equal(app.machines.running(app.registry.getThread(old.id)!), false, "the protocol-3 thread's machine is not started");
  // Its history reads as it was, without its machine.
  assert.equal(texts(await app.conversations.storedHistory(old.id)), before);
  // The protocol-4 threads go on: each answers a new message.
  for (const thread of [onVm, onHost]) {
    await app.conversations.activate(thread.id);
    await app.conversations.submit(thread.id, `again on ${thread.runnerId}`, `again-${thread.id}`);
    await done(thread.id);
    assert.match(texts(await app.conversations.storedHistory(thread.id)), new RegExp(`again on ${thread.runnerId}[^]*answer`));
  }
  await delay(200);
  assert.ok(asked.includes("node-vm") && asked.includes("node-host"), "the berth runners are probed");
  assert.ok(!asked.includes("node-old"), "the protocol-3 runner is never probed");

  // Archive: no contact, the disk's record kept, the history still readable; no discard.
  const archived = await app.conversations.archive(old.id);
  assert.equal(archived.retained, true, JSON.stringify(archived));
  const record = app.registry.getThread(old.id)!;
  assert.deepEqual([record.archived, record.vm!.retain, record.vm!.discarded], [true, true, undefined]);
  await assert.rejects(app.conversations.discard(old.id), /protocol 3/);
  assert.equal(app.registry.getThread(old.id)!.vm!.discarded, undefined, "a refused discard records nothing");
  await assert.rejects(app.machines.diagnose(app.registry.getThread(old.id)!), /protocol 3/);
  assert.equal(texts(await app.conversations.storedHistory(old.id)), before, "an archived thread's history stays readable");
  assert.ok(sessions.includes("vm") && sessions.includes("host"), "the berth runners' sessions are used");
  assert.ok(!sessions.includes("old"), `no session to the protocol-3 runner was asked for: ${sessions.join(", ")}`);
  assert.equal(berths.old!.events.length, oldEvents, "nothing reached the protocol-3 runner: no start, no release, no discard");
  assert.equal(berths.old!.phases.get(oldVm), Phase.RUNNING, "the machine is where it was, as its runner last had it");
  console.log("ok: a protocol-3 thread keeps its history across the upgrade, is never started or probed, archives keeping its disk's record, refuses discard; berth vm and host threads go on");
} finally {
  await app.close();
  for (const berth of Object.values(berths)) berth.stopAll();
  fs.rmSync(root, { recursive: true, force: true });
}
