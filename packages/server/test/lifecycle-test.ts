/** A thread's lifecycle under races, on local guests (the real guest helper
 * under temporary roots) with machine starts and releases held or failed
 * on demand: a failed try retried into a ready machine, an archive beside a
 * start under way, an archive no reader or recovery round restarts or
 * reports as a failure, a release that failed is only retried as a release,
 * concurrent archives, and OptChat's view of each (cubeThreads). Real VMs
 * run in scripts/test-vm-e2e.ts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import type { Thread } from "../src/registry.ts";
import type { StartOptions } from "../src/vm.ts";
import { LocalMachines } from "./local-guest.ts";

/** Local machines whose next starts or releases fail, or wait for the test. */
class HeldMachines extends LocalMachines {
  /** By thread: the errors its next starts fail with. */
  readonly failStarts = new Map<string, string[]>();
  failReleases: string[] = [];
  startGate: Promise<void> | null = null;
  releaseGate: Promise<void> | null = null;
  /** Holds a start once it boots (past the check of a running machine). */
  bootGate: Promise<void> | null = null;
  booting = 0;
  startsWaiting = 0;
  /** Every start asked for, failed or not, by thread. */
  readonly attempts = new Map<string, number>();
  override async start(thread: Thread, options: StartOptions = {}): Promise<{ booted: boolean }> {
    this.attempts.set(thread.id, (this.attempts.get(thread.id) ?? 0) + 1);
    this.startsWaiting++;
    try { await this.startGate; } finally { this.startsWaiting--; }
    const failure = this.failStarts.get(thread.id)?.shift();
    if (failure) throw new Error(failure);
    const gate = this.bootGate;
    return super.start(thread, { onBoot: () => { options.onBoot?.(); if (gate) this.booting++; } }).then(async started => {
      if (gate) { await gate; this.booting--; }
      return started;
    });
  }
  override async release(thread: Thread, retain: boolean): Promise<{ retained: boolean }> {
    await this.releaseGate;
    const failure = this.failReleases.shift();
    if (failure) throw new Error(failure);
    return super.release(thread, retain);
  }
}
function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  return { promise: new Promise<void>(resolve => { open = resolve; }), open };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-lifecycle-"));
const machines = new HeldMachines(path.join(root, "machines"));
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 40 }, () => fauxAssistantMessage("done")));
const models = createModels();
models.setProvider(faux.provider);
const state = path.join(root, "state");
fs.mkdirSync(state);
const app = await createCubed({ state, models, claude: null, machines });
const conversations = app.conversations;
await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
const address = app.server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;
const adapter = cubeThreads({ registry: app.registry, conversations, catalog: async () => [], runners: () => { throw new Error("unused"); } });
async function until<T>(read: () => T | Promise<T>, check: (value: T) => boolean, what: string): Promise<T> {
  for (let k = 0; ; k++) {
    const value = await read();
    if (check(value)) return value;
    assert.ok(k < 800, `${what}: ${JSON.stringify(value)}`);
    await delay(25);
  }
}
const workspaceState = (id: string) => app.registry.getThread(id)!.workspaceState;
async function idle(id: string) {
  await until(async () => (await conversations.history(id)).status.state, value => value === "completed", `${id} finishes its first run`);
}
/** Readers and recovery rounds as they arrive while something else goes
 * on; what OptChat's watcher got from the ones asked during an archive. */
async function meanwhile(id: string, done: () => boolean) {
  const seen: Promise<string>[] = [];
  while (!done()) {
    const during = conversations.archivingNow(id);
    void conversations.activate(id);
    void conversations.boot();
    const events = adapter.events(id).then(value => value === "archiving" ? value : value ? "events" : "gone", (error: Error) => `error: ${error.message}`);
    if (during) seen.push(events);
    await delay(2);
  }
  return Promise.all(seen);
}
try {
  for (let index = 0; index < 4; index++) {
    app.registry.enrollRunner({ nodeId: `node-${index}`, threadId: `runner-${index}`, environmentId: index + 1,
      configPath: `/private/runner-${index}.json`, configHash: `hash-${index}` });
  }
  const project = (await (await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "empty", repositories: [] }) })).json()).project;
  assert.equal(project.status, "ready");
  const create = (requestId: string) => {
    const thread = app.registry.createThread(project.id, requestId, { provider: faux.getModel().provider, id: faux.getModel().id }, "hello", "pi");
    return thread.id;
  };

  // A try that fails (the guest not reachable yet) is shown as failed, the
  // next try starts the machine again and the thread comes up: the failure
  // is gone from cubed's record and from what OptChat reads.
  const late = create("late");
  machines.failStarts.set(late, ["ssh: the guest is unreachable"]);
  await conversations.activate(late);
  assert.equal(conversations.error(late), "workspace allocation failed: ssh: the guest is unreachable");
  assert.equal(workspaceState(late), "failed");
  await assert.rejects(conversations.history(late), /guest is unreachable/, "a reader gets the failure, nothing opens");
  assert.equal(conversations.owner(late), null);
  // The next try, seen while it runs: starting again, the last failure beside it.
  const held = gate();
  machines.startGate = held.promise;
  const retry = conversations.activate(late);
  await until(() => machines.startsWaiting, value => value === 1, "the retry waits in its start");
  assert.match(await adapter.describe([late]), /starting its machine again \(the last try failed: workspace allocation failed: ssh: the guest is unreachable\)$/);
  machines.startGate = null;
  held.open();
  await retry;
  assert.equal(conversations.error(late), null, "a later success clears the failure");
  assert.equal(workspaceState(late), "available");
  assert.equal(app.registry.getThread(late)!.workspaceError, null);
  assert.equal(conversations.owner(late), "pi");
  assert.ok(await adapter.events(late), "OptChat watches it");
  await idle(late);
  assert.match(await adapter.describe([late]), /· ready, completed$/);

  // A later check of the machine that fails while the agent runs on it: the
  // agent stays open and OptChat still watches it.
  machines.failStarts.set(late, ["ssh: the guest is unreachable"]);
  await conversations.activate(late);
  assert.match(conversations.error(late) ?? "", /unreachable/);
  assert.equal(conversations.agentOpen(late), true);
  assert.match(await adapter.describe([late]), /ready \(a later check of its machine failed: ssh: the guest is unreachable\), completed$/);
  machines.failStarts.set(late, ["ssh: the guest is unreachable"]);
  assert.ok(await adapter.events(late), "an open agent is watched whatever a later check found");
  await conversations.activate(late);
  assert.equal(conversations.error(late), null);

  // The recovery loop's check of a running machine under an open agent is
  // not a start: cubed and OptChat keep calling the thread ready. A check
  // that finds the machine booted again is one: the agent closes for the
  // resume hooks and the thread is starting until it reopens.
  const checking = gate();
  machines.startGate = checking.promise;
  const check = conversations.boot();
  await until(() => machines.startsWaiting, value => value >= 1, "the check waits in its start");
  assert.equal(conversations.starting(late), false, "a check is not a start");
  const listed = (await (await fetch(`${base}/api/threads`)).json()).threads.find((row: { id: string }) => row.id === late);
  assert.equal(listed.state, "ready");
  machines.startGate = null;
  checking.open();
  await check;
  assert.match(await adapter.describe([late]), /· ready, completed$/);
  // The check finds the machine stopped and boots it: starting from the
  // boot on, before the start returns (a real boot takes minutes).
  machines.reboot(app.registry.getThread(late)!);
  const booting = gate();
  machines.bootGate = booting.promise;
  const rebooting = conversations.activate(late);
  await until(() => machines.booting, value => value === 1, "the check boots the machine");
  assert.equal(conversations.starting(late), true, "a machine that boots again is starting");
  assert.equal((await (await fetch(`${base}/api/threads`)).json()).threads.find((row: { id: string }) => row.id === late).state, "starting");
  machines.bootGate = null;
  booting.open();
  await rebooting;
  assert.equal(conversations.starting(late), false);
  assert.equal(conversations.error(late), null);
  assert.equal(conversations.agentOpen(late), true);

  // An archive asked while a retry is starting the machine waits for it;
  // meanwhile no reader or recovery round starts the machine again, and the
  // archive is not reported as a failure.
  const raced = create("raced");
  machines.failStarts.set(raced, ["ssh: the guest is unreachable"]);
  await conversations.activate(raced);
  assert.equal(workspaceState(raced), "failed");
  const racing = gate();
  machines.startGate = racing.promise;
  machines.failStarts.set(raced, ["ssh: the guest is unreachable"]);
  void conversations.activate(raced);
  await until(() => machines.startsWaiting, value => value === 1, "the retry waits in its start");
  const starts = machines.attempts.get(raced);
  let archived = false;
  const archive = adapter.archive!(raced).finally(() => { archived = true; });
  const watching = meanwhile(raced, () => archived);
  await delay(50);
  assert.equal(machines.attempts.get(raced), starts, "no second start beside the archive");
  machines.startGate = null;
  racing.open();
  const result = await archive;
  const seen = await watching;
  assert.ok(seen.length > 0);
  assert.equal(result!.already, false);
  assert.match(result!.disk, /machine disk retained/);
  assert.equal(machines.attempts.get(raced), starts, "nothing started the machine during the archive");
  assert.equal(app.registry.getThread(raced)!.archived, true);
  assert.equal(conversations.error(raced), null, "no failure is left on the archived thread");
  assert.equal(conversations.owner(raced), null);
  assert.ok(seen.every(value => value === "archiving" || value === "gone"), `OptChat saw ${JSON.stringify(seen)}`);

  // An archive of a ready thread: while its release check and release run,
  // readers and recovery rounds start nothing, take no lease and record no
  // failure; OptChat finds the thread gone, not failed.
  const ready = create("ready");
  await conversations.activate(ready);
  await idle(ready);
  const releasing = gate();
  machines.releaseGate = releasing.promise;
  archived = false;
  const archiveReady = conversations.archive(ready).finally(() => { archived = true; });
  const watchingReady = meanwhile(ready, () => archived);
  // A round that came before the archive is waited for; from its release
  // check on, nothing starts the machine.
  await until(() => conversations.archivingNow(ready) && conversations.agentOpen(ready) === false, value => value, "the archive closed the agent");
  const before = machines.attempts.get(ready);
  await delay(50);
  machines.releaseGate = null;
  releasing.open();
  assert.deepEqual(await archiveReady, { retained: false, reason: "clean" });
  const readySeen = await watchingReady;
  assert.ok(readySeen.length > 0 && readySeen.every(value => value === "archiving" || value === "gone"), `OptChat saw ${JSON.stringify(readySeen)}`);
  assert.equal(machines.attempts.get(ready), before, "no start beside the archive");
  assert.equal(conversations.error(ready), null);
  assert.equal(conversations.owner(ready), null);
  assert.equal(await adapter.events(ready), null);

  // Two archives at once: one archives, the other finds it archived; one slot freed.
  const twice = create("twice");
  await conversations.activate(twice);
  await idle(twice);
  const free = app.registry.runnerSlots().free;
  const [first, second] = await Promise.all([conversations.archive(twice), conversations.archive(twice)]);
  assert.deepEqual(first, { retained: false, reason: "clean" });
  assert.deepEqual(second, { retained: false, reason: "clean", already: true });
  assert.equal(app.registry.runnerSlots().free, free + 1, "one slot freed");

  // A release that failed is retried as a release only: no reader or
  // activation starts the machine again or replaces its failure.
  const stuck = create("stuck");
  await conversations.activate(stuck);
  await idle(stuck);
  machines.failReleases = ["the runner is unreachable"];
  await assert.rejects(conversations.archive(stuck), /workspace release failed: the runner is unreachable/);
  const startsBefore = machines.attempts.get(stuck);
  await conversations.activate(stuck);
  assert.equal(await adapter.events(stuck), "archiving", "an unfinished archive is not a failure to start");
  await assert.rejects(conversations.history(stuck), /workspace release failed/, "a reader is told the release failed");
  assert.equal(machines.attempts.get(stuck), startsBefore, "a release to finish is never a start");
  assert.equal(conversations.error(stuck), "workspace release failed: the runner is unreachable");
  await conversations.boot();
  assert.equal(app.registry.getThread(stuck)!.archived, true, "the recovery round finishes the release");
  assert.equal(conversations.error(stuck), null);

  console.log("lifecycle: failed try then ready, later check failure beside an open agent, a check is not a start but a reboot is, archive beside a start under way, no restart or failure during an archive, concurrent archives, release retried as a release: ok");
} finally {
  await app.close();
  await machines.close();
  fs.rmSync(root, { recursive: true, force: true });
}
