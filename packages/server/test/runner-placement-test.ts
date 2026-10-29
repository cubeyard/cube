/** Placing a thread: runner fitness from cubed's timestamped observations,
 * the pool (the `berth vm` runners), a host runner only by name, and a
 * protocol-3 runner (retired) never; then cubed's own view of a thread
 * waiting for a runner: starting, not failed, in the API and in OptChat.
 * Registry and local guests only; RunnerMachines' waits on a protocol-4
 * runner are in runner-vm-machines-test.ts. Not runner acceptance. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import { placement, Registry, RUNNER_FRESH_MS, runnerFitness, type Thread } from "../src/registry.ts";
import type { TrustedRunnerHealth } from "../src/runner-types.ts";
import { RunnerWait } from "../src/vm.ts";
import { LocalMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-placement-"));
const model = { provider: "faux", id: "faux" };
const ready = (maxActiveVms: number): TrustedRunnerHealth => ({ lifecycle: "ready", draining: false, error: null, activeVms: 0, runningVms: 0,
  maxActiveVms, retainedVms: 0, retainedBytes: 0, softwareVersion: "test", protocolVersion: 4, kind: "vm" });

/** A registry with a project and runners: berth vms unless `protocol3`. */
function world(name: string, runners: Array<{ name: string; max: number }>, protocol3 = false) {
  const registry = new Registry(path.join(root, `${name}.sqlite`));
  registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  let environment = 0;
  const enroll = (spec: { name: string; max: number }, kind?: "vm" | "host" | "p3") => {
    const which = kind ?? (protocol3 ? "p3" : "vm");
    registry.enrollRunner({ nodeId: `node-${spec.name}`, threadId: spec.name, environmentId: ++environment, configPath: `/private/${spec.name}.json`,
      configHash: spec.name, maxActiveVms: spec.max, ...(which === "p3" ? {} : { protocol: 4 as const, kind: which }) });
  };
  runners.forEach(spec => enroll(spec));
  let requests = 0;
  const create = (runnerId?: string) => registry.createThread("p", `r${++requests}`, model, "hello", "pi", runnerId ? { runnerId } : undefined);
  const get = (id: string) => registry.getThread(id)!;
  return { registry, enroll, create, get };
}

try {
  // --- choosing a runner at creation ---
  {
    const now = Date.now();
    assert.equal(runnerFitness({ lastAttemptAt: null, lastContactAt: null, unreachableSince: null, error: null, health: null }, now).fitness, "unverified");
    assert.equal(runnerFitness({ lastAttemptAt: now, lastContactAt: now, unreachableSince: null, error: null, health: ready(1) }, now).fitness, "ready");
    assert.equal(runnerFitness({ lastAttemptAt: now - RUNNER_FRESH_MS - 1, lastContactAt: now - RUNNER_FRESH_MS - 1, unreachableSince: null, error: null, health: ready(1) }, now).fitness,
      "unverified", "a ready report too old to trust is verified again, never taken as ready");
    const failing = (since: number, attempt: number) => runnerFitness({ lastAttemptAt: attempt, lastContactAt: null, unreachableSince: since, error: "NODE_UNAVAILABLE", health: null }, now);
    assert.deepEqual(failing(now - 1000, now - 1000), { fitness: "down", retryAt: now + 4000 }, "a first failure is retried after 5 s");
    assert.equal(failing(now - 600_000, now - 30_000).retryAt, now + 30_000, "a long failure is retried after at most 60 s");
    assert.equal(failing(now - 600_000, now - 61_000).fitness, "unverified", "a due retry is verification, not trust");
    const draining = runnerFitness({ lastAttemptAt: now, lastContactAt: now, unreachableSince: null, error: null, health: { ...ready(1), lifecycle: "draining", draining: true } }, now);
    assert.equal(draining.fitness, "down");

    // An empty runner never heard from does not beat a busier one that answered ready.
    const w = world("choose", [{ name: "mac", max: 4 }, { name: "linux", max: 4 }]);
    w.registry.recordRunnerProbe("linux", { health: ready(4) });
    const busy = w.create();
    assert.equal(busy.runnerId, "linux");
    assert.equal(w.create().runnerId, "linux", "a fresh ready runner first, even with more load");
    // A ready report older than the freshness window ranks with never-asked runners.
    w.registry.recordRunnerProbe("linux", { health: ready(4) }, Date.now() - RUNNER_FRESH_MS - 1000);
    assert.equal(w.create().runnerId, "mac", "a stale report is no longer trusted; the less loaded runner wins");
    // A runner that just failed comes last.
    w.registry.recordRunnerProbe("mac", { error: "NODE_UNAVAILABLE" });
    assert.equal(w.create().runnerId, "linux");
    w.registry.close();
    console.log("ok: runner fitness from timestamped observations; creation prefers fresh ready runners, stale reports are unverified, failed runners last");
  }

  // --- a runner that reports refusing new machines for want of disk ---
  {
    const GiB = 2 ** 30;
    const disk = (freeBytes: number | null) => ({ freeBytes, freeInodes: null, committedBytes: 0, reserveBytes: 2 * GiB, reserveInodes: 10_000 });
    const full = { ...ready(4), disk: disk(GiB) };
    const roomy = { ...ready(4), disk: disk(100 * GiB) };
    // full answers ready but refuses new machines; roomy has room and already one thread: roomy.
    const w = world("disk", [{ name: "full", max: 4 }, { name: "roomy", max: 4 }]);
    w.registry.recordRunnerProbe("full", { health: full });
    w.registry.recordRunnerProbe("roomy", { health: roomy });
    assert.equal(w.create("roomy").runnerId, "roomy");
    assert.deepEqual([w.create().runnerId, w.create().runnerId], ["roomy", "roomy"], "a disk-refusing runner is ranked after one with room, though less loaded");
    // By name the thread stays on the runner it names, disk or not.
    const pinned = w.create("full");
    assert.deepEqual([pinned.runnerId, pinned.pinned], ["full", true]);
    // roomy full (4 of 4) and full with the only free slots: the thread queues on roomy, first come first served.
    assert.equal(w.create().runnerId, "roomy");
    const queued = w.create();
    assert.deepEqual([queued.runnerId, queued.vm?.suspension?.state], ["roomy", "queued"], "a refusing runner's free slot is not taken while another can take a machine");
    const next = w.create();
    assert.deepEqual([next.runnerId, next.vm?.suspension?.state], ["roomy", "queued"]);
    assert.deepEqual(w.registry.slotQueue().get("roomy")?.waiting, [queued.id, next.id], "in the order they came");
    assert.equal(w.get(pinned.id).runnerId, "full", "a thread already placed stays");
    // Its next report says there is room: its free slots take threads again.
    w.registry.recordRunnerProbe("full", { health: { ...ready(4), disk: disk(100 * GiB) } });
    const spill = w.create();
    assert.deepEqual([spill.runnerId, spill.vm?.suspension], ["full", undefined]);
    // Only refusing runners: a thread still gets one (it waits for disk there), not refused.
    const only = world("disk-only", [{ name: "a", max: 2 }, { name: "b", max: 2 }]);
    only.registry.recordRunnerProbe("a", { health: full });
    only.registry.recordRunnerProbe("b", { health: full });
    assert.deepEqual([only.create().runnerId, only.create().runnerId], ["a", "b"]);

    // Behind a runner never heard from (unverified), ahead of one that is down.
    const v = world("disk-fitness", [{ name: "full", max: 4 }, { name: "unheard", max: 4 }, { name: "gone", max: 4 }]);
    v.registry.recordRunnerProbe("full", { health: full });
    v.registry.recordRunnerProbe("gone", { error: "NODE_UNAVAILABLE" });
    assert.equal(v.create().runnerId, "unheard", "an unverified runner beats one that refuses for disk");
    v.registry.recordRunnerProbe("unheard", { error: "NODE_UNAVAILABLE" });
    assert.equal(v.create().runnerId, "full", "a disk-refusing runner that answers beats runners that are down");

    // Unknown is no refusal: an older berth (no disk) and an unmeasured disk rank by load as before.
    const u = world("disk-unknown", [{ name: "old", max: 4 }, { name: "unmeasured", max: 4 }, { name: "ok", max: 4 }]);
    u.registry.recordRunnerProbe("old", { health: ready(4) });
    u.registry.recordRunnerProbe("unmeasured", { health: { ...ready(4), disk: disk(null) } });
    u.registry.recordRunnerProbe("ok", { health: roomy });
    for (const id of ["ok", "ok"]) assert.equal(u.create(id).runnerId, id);
    assert.equal(u.create("unmeasured").runnerId, "unmeasured");
    // Loads old 0, unmeasured 1, ok 2: old, then old again (a tie goes to enrollment order), then unmeasured before ok.
    assert.deepEqual([u.create().runnerId, u.create().runnerId, u.create().runnerId], ["old", "old", "unmeasured"], "unknown disk keeps the load order");
    console.log("ok: placement ranks a runner that reports refusing new machines for disk after runners that can take one, before runners that are down; never its free slot while another can take a machine (that thread queues); by name and unknown disk as before");
  }

  // --- the pool is the berth vm runners; a host runner only by name; a protocol-3 runner never ---
  {
    const w = world("pool", [{ name: "a", max: 2 }], true);
    w.registry.recordRunnerProbe("a", { health: { ...ready(2), protocolVersion: 3, kind: undefined } });
    // Only a protocol-3 runner enrolled: nothing takes a thread, named or not.
    assert.deepEqual(w.registry.runnerSlots(), { free: 0, total: 0, runners: 0 }, "a protocol-3 runner adds nothing to the pool");
    assert.throws(() => w.create(), /no berth vm runner in the global runner pool: start the thread on a berth host by name, or enroll a berth vm/);
    assert.throws(() => w.create(w.registry.namedRunnerId("node-a")), /runner node-a uses protocol 3 \(cube-runner\), which cube no longer runs/);
    assert.equal(w.registry.listThreads().length, 0, "a refused start writes no thread");
    w.enroll({ name: "berth", max: 2 }, "vm");
    w.registry.recordRunnerProbe("berth", { health: ready(2) });
    assert.deepEqual(w.registry.runnerSlots(), { free: 2, total: 2, runners: 1 }, "the berth vm is the pool");
    assert.deepEqual(w.registry.availableRunners().map(runner => runner.threadId), ["berth"]);
    const pooled = w.create();
    assert.deepEqual([pooled.runnerId, pooled.pinned, placement(pooled)], ["berth", undefined, "provisional"]);
    const named = w.create("berth");
    assert.deepEqual([named.runnerId, named.pinned], ["berth", true]);
    // The pool is full: neither a free host runner nor the protocol-3 runner takes the thread.
    w.enroll({ name: "host", max: 4 }, "host");
    const queued = w.create();
    assert.deepEqual([queued.runnerId, queued.vm?.suspension?.state], ["berth", "queued"], "a full pool queues the thread on its berth vm: never a host or p3 runner");
    w.registry.applyPhase(queued.id, { type: "releaseBegan" });
    w.registry.applyPhase(queued.id, { type: "released" });
    const onHost = w.create(w.registry.namedRunnerId("node-host"));
    assert.deepEqual([onHost.runnerId, onHost.pinned], ["host", true], "a host runner by name, pinned");
    // The berth vm is down with a free slot: the thread is placed there and
    // waits for it (runner-machines.ts).
    w.registry.applyPhase(named.id, { type: "releaseBegan" });
    w.registry.applyPhase(named.id, { type: "released" });
    w.registry.recordRunnerProbe("berth", { error: "UNAVAILABLE" });
    assert.equal(w.registry.runnerFitness("berth")!.fitness, "down");
    const waiting = w.create();
    assert.deepEqual([waiting.runnerId, waiting.pinned], ["berth", undefined], "an unavailable berth vm never falls back to a host or p3 runner");
    w.registry.close();
    console.log("ok: the pool is the berth vm runners: no host or p3 fallback when there is none, when it is full (queued) or down; a host runner by name, pinned; a protocol-3 runner refused even by name");
  }

  // --- what the user and OptChat see while a thread waits ---
  {
    class Waiting extends LocalMachines {
      // One try waits; OptChat's watcher tries nothing of its own.
      waits = 1;
      override async start(thread: Thread): Promise<{ booted: boolean }> {
        if (this.waits-- > 0) throw new RunnerWait("waiting for a runner: node-a does not answer, and no other runner with a free thread machine is ready; cube tries again");
        return super.start(thread);
      }
    }
    const machines = new Waiting(path.join(root, "view-machines"));
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("done")));
    const models = createModels();
    models.setProvider(faux.provider);
    const app = await createCubed({ state: path.join(root, "view-state"), models, claude: null, machines });
    try {
      app.registry.enrollRunner({ nodeId: "node-a", threadId: "a", environmentId: 1, configPath: "/private/a.json", configHash: "a", protocol: 4, kind: "vm" });
      app.registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
      const thread = app.registry.createThread("p", "view", { provider: faux.getModel().provider, id: faux.getModel().id }, "hello", "pi", { runnerId: "a" });
      await app.conversations.activate(thread.id);
      assert.equal(app.conversations.error(thread.id), null, "a wait is not a failure");
      assert.match(app.conversations.waiting(thread.id)!, /node-a does not answer/);
      assert.equal(app.registry.getThread(thread.id)!.workspaceState, "allocating", "the workspace is not marked failed");
      await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
      const { port } = app.server.address() as { port: number };
      const listed = (await (await fetch(`http://127.0.0.1:${port}/api/threads`)).json()).threads[0];
      assert.deepEqual([listed.state, listed.error], ["starting", null]);
      assert.match(listed.waiting, /waiting for a runner/);
      const adapter = cubeThreads({ registry: app.registry, conversations: app.conversations, catalog: async () => [], runners: () => { throw new Error("unused"); } });
      assert.match(await adapter.describe([thread.id]), /starting its machine, waiting for a runner: node-a does not answer/);
      assert.equal((await adapter.observe!([thread.id])).get(thread.id)!.state, "waiting for a runner");
      assert.match(adapter.startFailure(thread.id)?.failure ?? "", /waiting for a runner/, "cubed tells OptChat a start not made yet");
      assert.equal(adapter.startFailure(thread.id)?.retrying, true);
      assert.equal(await adapter.events(thread.id), "stored");
      // The runner comes back: the next try starts the thread and the wait is gone.
      await app.conversations.activate(thread.id);
      assert.equal(app.conversations.waiting(thread.id), null);
      assert.equal(app.registry.getThread(thread.id)!.workspaceState, "available");
      assert.equal(adapter.startFailure(thread.id), null, "and its start failure ended");
      for (let k = 0; (await app.conversations.history(thread.id)).status.state !== "completed"; k++) { assert.ok(k < 400); await delay(25); }
    } finally {
      await app.close();
      await machines.close();
    }
    console.log("ok: a thread waiting for a runner reads as starting with its reason (API, OptChat), never as failed, and starts once a runner answers");
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
