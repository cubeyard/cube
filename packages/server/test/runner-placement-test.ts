/** Placing a thread's machine on runners that fail, against fake runner
 * clients that keep the real runner's rules (cube-runner's runner.rs):
 * `vm.allocate` fences the thread's epoch before anything else, returns a
 * machine that exists whatever was asked, then refuses a draining or full
 * runner. Faults are injected per runner: no answer before a request is
 * sent, an allocation applied whose answer is lost, an allocation that
 * arrives late. Every case checks that a thread's machine exists on at most
 * one runner, starts only there, and that cubed's slot count matches its
 * open threads. Then cubed's own view: a thread waiting for a runner is
 * starting, not failed, in the API and in OptChat. No VM; not runner
 * acceptance (scripts/test-node-transport.sh runs the real runner). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { GatewaySupervisor } from "../src/gateway.ts";
import { createCubed } from "../src/index.ts";
import { IrohNodeError, type IrohRunnerClient, type TrustedRunnerHealth } from "../src/iroh-node.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import { placement, Registry, RUNNER_FRESH_MS, runnerFitness, type Thread } from "../src/registry.ts";
import { RunnerWait, ThreadVms } from "../src/vm.ts";
import { LocalMachines } from "./local-guest.ts";

type Ref = { threadId: string; vmId: string };
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-placement-"));
const model = { provider: "faux", id: "faux" };
const ready = (maxActiveVms: number): TrustedRunnerHealth => ({ lifecycle: "ready", draining: false, error: null, activeVms: 0, runningVms: 0,
  maxActiveVms, retainedVms: 0, retainedBytes: 0, softwareVersion: "test", protocolVersion: 3 });
const silent = { info() {}, warn() {}, error() {}, debug() {} } as never;

/** One fake runner: its journal, fence and faults. */
class FakeRunner {
  readonly vms = new Map<string, { threadId: string; state: string }>();
  readonly epochs = new Map<string, number>();
  readonly calls: string[] = [];
  /** Every request fails before it is sent. */
  down = false;
  accepting = true;
  lifecycle: TrustedRunnerHealth["lifecycle"] = "ready";
  /** The next allocation is applied, but its answer is lost. */
  loseAck = false;
  /** The next allocation is lost on the way and delivered when the test says. */
  hold: Array<() => Promise<unknown>> | null = null;
  readonly name: string;
  readonly max: number;
  constructor(name: string, max: number) { this.name = name; this.max = max; }
  private contact(method: string) {
    this.calls.push(method);
    if (this.down) throw new IrohNodeError("NODE_UNAVAILABLE");
  }
  private fence(threadId: string, epoch: number) {
    if (epoch < (this.epochs.get(threadId) ?? 0)) throw new IrohNodeError("LEASE_STALE", false, "LEASE_STALE");
    this.epochs.set(threadId, epoch);
  }
  private record(ref: Ref) { return { vmId: ref.vmId, threadId: ref.threadId, state: this.vms.get(ref.vmId)!.state, interrupted: false, diskBytes: 0 }; }
  /** runner.rs `allocate`: fence, existing machine, accepting, capacity, insert. */
  allocateNow(ref: Ref, epoch: number) {
    this.fence(ref.threadId, epoch);
    if (this.vms.has(ref.vmId)) return this.record(ref);
    if (!this.accepting) throw new IrohNodeError("DRAINING", false, "DRAINING");
    if ([...this.vms.values()].filter(vm => vm.state !== "released").length >= this.max) throw new IrohNodeError("CAPACITY_EXCEEDED", false, "CAPACITY_EXCEEDED");
    this.vms.set(ref.vmId, { threadId: ref.threadId, state: "allocated" });
    return this.record(ref);
  }
  client() {
    return {
      nodeId: `node-${this.name}`,
      target: { peer: "0".repeat(64), network: "loopback" as const, address: "127.0.0.1:1" },
      health: async () => {
        this.contact("health");
        return { ...ready(this.max), lifecycle: this.lifecycle, draining: !this.accepting, activeVms: [...this.vms.values()].filter(vm => vm.state !== "released").length };
      },
      describe: async () => {
        this.contact("describe");
        return { softwareVersion: "test", capabilities: [], platform: "linux-x86_64", baseImageSha256: "0".repeat(64),
          limits: { maxFrameBytes: 1048576, requestTimeoutMs: 5000, maxVcpus: 2, maxMemoryMiB: 4096, maxDiskGiB: 32, maxSeedBytes: 65536, maxActiveVms: this.max } };
      },
      vmInspect: async (ref: Ref) => {
        this.contact("inspect");
        if (!this.vms.has(ref.vmId)) throw new IrohNodeError("NOT_FOUND");
        return { vm: this.record(ref), consoleTail: null };
      },
      vmAllocate: async (ref: Ref, epoch: number) => {
        this.contact("allocate");
        if (this.hold) {
          const held = this.hold;
          this.hold = null;
          held.push(async () => this.allocateNow(ref, epoch));
          throw new IrohNodeError("OUTCOME_UNKNOWN", true);
        }
        const record = this.allocateNow(ref, epoch);
        if (this.loseAck) { this.loseAck = false; throw new IrohNodeError("OUTCOME_UNKNOWN", true); }
        return record;
      },
      vmStart: async (ref: Ref, epoch: number) => {
        this.contact("start");
        this.fence(ref.threadId, epoch);
        this.vms.get(ref.vmId)!.state = "running";
        throw new Error("fixture stops here");
      },
      vmRelease: async (ref: Ref, epoch: number) => {
        this.contact("release");
        this.fence(ref.threadId, epoch);
        if (!this.vms.has(ref.vmId)) throw new IrohNodeError("NOT_FOUND");
        this.vms.get(ref.vmId)!.state = "released";
        return this.record(ref);
      },
      templateList: async () => { this.contact("templates"); return []; },
    };
  }
}

const gateway = { binary: "/bin/false", unavailable: null, control: "/nonexistent", onRestart: () => {},
  ensureNetwork: async () => {}, ready: async () => ({ client: { detach: async () => {} }, hello: { peer: "0".repeat(64), caPem: "" } }) };

/** A registry, runners and ThreadVms over them. */
function world(name: string, runners: Array<{ name: string; max: number }>) {
  const file = path.join(root, `${name}.sqlite`);
  const registry = new Registry(file);
  registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  const fakes = new Map<string, FakeRunner>();
  const enroll = (spec: { name: string; max: number }) => {
    registry.enrollRunner({ nodeId: `node-${spec.name}`, threadId: spec.name, environmentId: fakes.size + 1, configPath: `/private/${spec.name}.json`, configHash: spec.name, maxActiveVms: spec.max });
    fakes.set(spec.name, new FakeRunner(spec.name, spec.max));
  };
  runners.forEach(enroll);
  const vms = () => new ThreadVms({ registry, threads: path.join(root, `${name}-threads`), run: path.join(root, `${name}-run`),
    gateway: gateway as unknown as GatewaySupervisor, sizes: { vcpus: 1, memoryMiB: 1024, diskGiB: 8 }, templates: { enabled: false, ttlMs: 1 },
    runnerClient: admission => fakes.get(admission.configHash)!.client() as unknown as IrohRunnerClient, log: silent });
  let requests = 0;
  const create = () => registry.createThread("p", `r${++requests}`, model, "hello");
  const get = (id: string) => registry.getThread(id)!;
  /** Each machine exists on at most one runner and runs only there; cubed's
   * slots are exactly its open threads. */
  const invariants = () => {
    const open = registry.listThreads().filter(thread => !thread.archived);
    for (const thread of registry.listThreads()) {
      const holders = [...fakes.values()].filter(fake => fake.vms.has(thread.vm!.vmId) && fake.vms.get(thread.vm!.vmId)!.state !== "released");
      assert.ok(holders.length <= 1, `thread ${thread.id} has a machine on ${holders.map(fake => fake.name)}`);
      if (holders.length) {
        assert.equal(holders[0]!.name, thread.runnerId, "a machine exists only on the thread's own runner");
        assert.notEqual(placement(thread), "provisional", "a thread with a machine somewhere never counts as free to move");
      }
    }
    for (const status of registry.runnerStatuses()) {
      assert.equal(status.activeThreads, open.filter(thread => thread.runnerId === status.id).length);
      assert.ok(status.activeThreads <= status.maxActiveVms, `${status.id} is not oversubscribed`);
    }
  };
  return { registry, fakes, enroll, vms, create, get, invariants, file };
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

  // --- an unreachable runner before anything was sent: the thread moves ---
  {
    const w = world("unreachable", [{ name: "mac", max: 2 }, { name: "linux", max: 2 }]);
    const thread = w.create();
    assert.equal(thread.runnerId, "mac", "neither was asked yet: enrollment order");
    w.fakes.get("mac")!.down = true;
    const vms = w.vms();
    await assert.rejects(vms.start(thread), /fixture stops here/);
    assert.equal(w.get(thread.id).runnerId, "linux");
    assert.equal(placement(w.get(thread.id)), "allocated");
    assert.deepEqual(w.fakes.get("mac")!.calls, ["health"], "the unreachable runner was asked once, for its status only");
    assert.deepEqual(w.fakes.get("linux")!.calls, ["health", "describe", "inspect", "allocate", "start"], "an unverified runner is asked first");
    const mac = w.registry.runnerStatuses().find(status => status.id === "mac")!;
    assert.equal(mac.contactStatus, "unreachable");
    assert.ok(mac.unreachableSince, "the failed contact is recorded with its time");
    w.invariants();

    // The next thread does not ask the failed runner again before its retry is due.
    const next = w.create();
    assert.equal(next.runnerId, "linux");
    w.fakes.get("mac")!.calls.length = 0;
    w.fakes.get("linux")!.calls.length = 0;
    await assert.rejects(vms.start(next), /fixture stops here/);
    assert.deepEqual(w.fakes.get("linux")!.calls, ["describe", "inspect", "allocate", "start"], "a runner that answered ready lately is not asked again");
    assert.deepEqual(w.fakes.get("mac")!.calls, []);
    w.invariants();
    await vms.close();
    w.registry.close();
    console.log("ok: an unreachable runner is detected before anything is sent and the thread moves to a ready one; the failure is recorded and not retried before its time");
  }

  // --- stale health is verified; draining and faulted runners are left before any allocation ---
  {
    const w = world("stale", [{ name: "a", max: 2 }, { name: "b", max: 2 }]);
    w.registry.recordRunnerProbe("a", { health: ready(2) }, Date.now() - RUNNER_FRESH_MS - 1000);
    w.registry.recordRunnerProbe("b", { health: ready(2) }, Date.now() - RUNNER_FRESH_MS - 1000);
    const thread = w.create();
    assert.equal(thread.runnerId, "a");
    w.fakes.get("a")!.accepting = false; // draining since its last report
    const vms = w.vms();
    await assert.rejects(vms.start(thread), /fixture stops here/);
    assert.deepEqual(w.fakes.get("a")!.calls, ["health"], "the stale report was checked first; nothing was allocated on a draining runner");
    assert.equal(w.get(thread.id).runnerId, "b");
    const a = w.registry.runnerFitness("a")!;
    assert.equal(a.fitness, "down", "a draining runner is not used until its retry");
    assert.equal(a.health?.draining, true);

    w.fakes.get("b")!.lifecycle = "faulted";
    w.registry.recordRunnerProbe("b", { health: ready(2) }, Date.now() - RUNNER_FRESH_MS - 1000);
    const second = w.create();
    assert.equal(second.runnerId, "b");
    await assert.rejects(vms.start(second), (error: Error) => error instanceof RunnerWait
      && /waiting for a runner: node-b is faulted, and no other runner with a free thread machine is ready/.test(error.message));
    assert.equal(w.get(second.id).runnerId, "b", "nowhere to go: it keeps its slot and waits");
    assert.equal(placement(w.get(second.id)), "provisional");
    w.invariants();
    await vms.close();
    w.registry.close();
    console.log("ok: a stale report is verified before use; draining and faulted runners get no allocation; with no alternative the thread waits, provisional");
  }

  // --- no answer to the allocation itself, before it was sent ---
  {
    const w = world("before-send", [{ name: "a", max: 1 }, { name: "b", max: 1 }]);
    w.registry.recordRunnerProbe("a", { health: ready(1) });
    w.registry.recordRunnerProbe("b", { health: ready(1) });
    const thread = w.create();
    const a = w.fakes.get("a")!;
    const client = a.client();
    // a answers the questions before, then goes away just as the allocation leaves.
    a.client = () => ({ ...client, vmAllocate: async () => { a.calls.push("allocate"); throw new IrohNodeError("NODE_UNAVAILABLE"); } });
    const vms = w.vms();
    await assert.rejects(vms.start(thread), /fixture stops here/);
    assert.equal(w.get(thread.id).runnerId, "b", "an allocation that never left does not hold the thread");
    assert.equal(a.vms.size, 0);
    w.invariants();
    await vms.close();
    w.registry.close();
    console.log("ok: an allocation that could not be sent leaves the thread provisional and it moves");
  }

  // --- the allocation was made, its answer lost: the thread stays and the machine is adopted ---
  {
    const w = world("ack-lost", [{ name: "a", max: 2 }, { name: "b", max: 2 }]);
    w.registry.recordRunnerProbe("a", { health: ready(2) });
    const thread = w.create();
    assert.equal(thread.runnerId, "a");
    const a = w.fakes.get("a")!;
    a.loseAck = true;
    const vms = w.vms();
    await assert.rejects(vms.start(thread), (error: Error) => error instanceof RunnerWait && /may have reached it/.test(error.message));
    assert.equal(placement(w.get(thread.id)), "requested");
    assert.equal(a.vms.size, 1, "the runner made the machine");
    // The runner goes away now: the thread waits for it, it does not start a second machine elsewhere.
    a.down = true;
    for (let round = 0; round < 3; round++) {
      await assert.rejects(vms.start(thread), (error: Error) => error instanceof RunnerWait
        && /waiting for runner node-a: it does not answer, and a request for this thread's machine may have reached it/.test(error.message));
    }
    assert.equal(w.get(thread.id).runnerId, "a");
    assert.deepEqual(w.fakes.get("b")!.calls, [], "the other runner is never asked");
    w.invariants();
    // It answers again (its retry due): the lost allocation is found and used, never repeated.
    a.down = false;
    w.registry.recordRunnerProbe("a", { error: "NODE_UNAVAILABLE" }, Date.now() - 120_000);
    a.calls.length = 0;
    await assert.rejects(vms.start(thread), /fixture stops here/);
    assert.deepEqual(a.calls, ["health", "describe", "inspect", "start"], "inspect finds the machine; no second allocation");
    assert.equal(placement(w.get(thread.id)), "allocated");
    w.invariants();
    await vms.close();
    w.registry.close();
    console.log("ok: an allocation whose answer was lost pins the thread to its runner, which it waits for, and the machine is adopted once it answers");
  }

  // --- a lost allocation that arrives after a retry was refused: the fence stops it ---
  {
    const w = world("late", [{ name: "a", max: 2 }, { name: "b", max: 2 }]);
    w.registry.recordRunnerProbe("a", { health: ready(2) });
    w.registry.recordRunnerProbe("b", { health: ready(2) });
    const thread = w.create();
    const a = w.fakes.get("a")!;
    const late: Array<() => Promise<unknown>> = [];
    a.hold = late;
    const vms = w.vms();
    await assert.rejects(vms.start(thread), RunnerWait);
    assert.equal(placement(w.get(thread.id)), "requested");
    // The lost answer counts as a failed contact; once its retry is due the
    // runner, now draining, refuses under a newer epoch and has no machine: the thread moves.
    w.registry.recordRunnerProbe("a", { error: "NODE_UNAVAILABLE" }, Date.now() - 120_000);
    a.accepting = false;
    await assert.rejects(vms.start(thread), /fixture stops here/);
    assert.equal(w.get(thread.id).runnerId, "b");
    assert.equal(placement(w.get(thread.id)), "allocated");
    // The first allocation arrives now: stale, refused, nothing made.
    a.accepting = true;
    await assert.rejects(late[0]!(), /LEASE_STALE/);
    assert.equal(a.vms.size, 0);
    w.invariants();

    // Arriving before the retry instead, the late allocation is adopted where it landed.
    const other = w.create();
    w.fakes.get("b")!.hold = late;
    const before = await (async () => {
      await assert.rejects(vms.start(w.get(other.id)), RunnerWait);
      return late.length;
    })();
    await late[before - 1]!();
    w.registry.recordRunnerProbe(w.get(other.id).runnerId, { error: "NODE_UNAVAILABLE" }, Date.now() - 120_000);
    await assert.rejects(vms.start(w.get(other.id)), /fixture stops here/);
    assert.equal(w.get(other.id).runnerId, "b");
    assert.equal(placement(w.get(other.id)), "allocated");
    w.invariants();
    await vms.close();
    w.registry.close();
    console.log("ok: a late allocation is either adopted where it landed or fenced off after the thread moved; never two machines");
  }

  // --- several threads leave a dead runner for one free slot at once ---
  {
    const w = world("capacity", [{ name: "a", max: 3 }]);
    const threads = [w.create(), w.create(), w.create()];
    w.enroll({ name: "b", max: 1 });
    w.registry.recordRunnerProbe("b", { health: ready(1) });
    w.fakes.get("a")!.down = true;
    const vms = w.vms();
    const results = await Promise.allSettled(threads.map(thread => vms.start(thread)));
    assert.equal(results.filter(result => result.status === "rejected" && /fixture stops here/.test(String(result.reason))).length, 1, "one thread took the free slot");
    const waiting = results.filter(result => result.status === "rejected" && result.reason instanceof RunnerWait);
    assert.equal(waiting.length, 2);
    assert.match(String((waiting[0] as PromiseRejectedResult).reason.message), /waiting for a runner: node-a does not answer, and no other runner with a free thread machine is ready/);
    assert.deepEqual(w.fakes.get("a")!.calls, ["health"], "one status question for every thread waiting on the runner");
    assert.deepEqual(w.registry.runnerStatuses().map(status => [status.id, status.activeThreads]), [["a", 2], ["b", 1]]);
    w.invariants();
    // Waiting threads are not retried against the dead runner before its time.
    for (const thread of threads.filter(thread => w.get(thread.id).runnerId === "a")) await assert.rejects(vms.start(w.get(thread.id)), RunnerWait);
    assert.deepEqual(w.fakes.get("a")!.calls, ["health"]);
    // Archiving a waiting thread frees its slot without its runner: nothing of it exists anywhere.
    const queued = threads.find(thread => w.get(thread.id).runnerId === "a")!;
    w.registry.beginRelease(queued.id);
    assert.deepEqual(await vms.release(w.get(queued.id), false), { retained: false });
    w.registry.finishRelease(queued.id);
    assert.deepEqual(w.fakes.get("a")!.calls, ["health"], "the release asked the dead runner nothing");
    // The moved thread is archived: its slot on b frees and the last waiting thread takes it.
    const moved = threads.find(thread => w.get(thread.id).runnerId === "b")!;
    w.registry.beginRelease(moved.id);
    await vms.release(w.get(moved.id), false);
    w.registry.finishRelease(moved.id);
    const last = threads.find(thread => !w.get(thread.id).archived && w.get(thread.id).runnerId === "a")!;
    await assert.rejects(vms.start(w.get(last.id)), /fixture stops here/);
    assert.equal(w.get(last.id).runnerId, "b");
    assert.deepEqual(w.registry.runnerStatuses().map(status => [status.id, status.activeThreads]), [["a", 0], ["b", 1]], "no slot leaked");
    w.invariants();
    await vms.close();
    w.registry.close();
    console.log("ok: concurrent moves for one free slot: one wins, the rest wait with their slots; one shared status question; archives free slots without the dead runner");
  }

  // --- a cubed restart in the middle of an allocation ---
  {
    const w = world("restart", [{ name: "a", max: 2 }, { name: "b", max: 2 }]);
    w.registry.recordRunnerProbe("a", { health: ready(2) });
    w.registry.recordRunnerProbe("b", { health: ready(2) });
    const thread = w.create();
    // cubed kept "requested" and sent the allocation, the runner made the machine, cubed died.
    assert.ok(w.registry.markPlacement(thread.id, "a", ["provisional"], "requested"));
    w.fakes.get("a")!.allocateNow({ threadId: thread.id, vmId: thread.vm!.vmId }, 1);
    w.registry.close();
    const registry = new Registry(w.file);
    const restarted = { ...w, registry, get: (id: string) => registry.getThread(id)! };
    assert.equal(placement(restarted.get(thread.id)), "requested", "the placement outlives the process");
    const a = w.fakes.get("a")!;
    a.down = true;
    const vms = new ThreadVms({ registry, threads: path.join(root, "restart-threads"), run: path.join(root, "restart-run"),
      gateway: gateway as unknown as GatewaySupervisor, sizes: { vcpus: 1, memoryMiB: 1024, diskGiB: 8 }, templates: { enabled: false, ttlMs: 1 },
      runnerClient: admission => w.fakes.get(admission.configHash)!.client() as unknown as IrohRunnerClient, log: silent });
    await assert.rejects(vms.start(restarted.get(thread.id)), (error: Error) => error instanceof RunnerWait && /may have reached it/.test(error.message));
    assert.equal(restarted.get(thread.id).runnerId, "a");
    assert.deepEqual(w.fakes.get("b")!.calls, []);
    a.down = false;
    registry.recordRunnerProbe("a", { health: ready(2) });
    a.calls.length = 0;
    await assert.rejects(vms.start(restarted.get(thread.id)), /fixture stops here/);
    assert.deepEqual(a.calls, ["describe", "inspect", "start"], "the machine made before the restart is used");
    assert.equal(a.vms.size, 1);
    await vms.close();
    registry.close();
    console.log("ok: a restart mid-allocation keeps the thread on its runner until it answers, then adopts the machine");
  }

  // --- a runner lost after the machine started: no relocation ---
  {
    const w = world("pinned", [{ name: "a", max: 2 }, { name: "b", max: 2 }]);
    w.registry.recordRunnerProbe("a", { health: ready(2) });
    w.registry.recordRunnerProbe("b", { health: ready(2) });
    const thread = w.create();
    const vms = w.vms();
    await assert.rejects(vms.start(thread), /fixture stops here/);
    w.registry.markWorkspaceAvailable(thread.id);
    w.fakes.get("a")!.down = true;
    for (let round = 0; round < 2; round++) {
      await assert.rejects(vms.start(w.get(thread.id)), (error: Error) => error instanceof RunnerWait
        && error.message === "waiting for runner node-a: it does not answer; this thread's machine is on it and stays there");
    }
    assert.equal(w.get(thread.id).runnerId, "a");
    assert.deepEqual(w.fakes.get("b")!.calls, []);
    assert.equal(w.registry.relocateThread(thread.id), null, "the registry refuses to move an allocated thread");
    // A thread allocated but never ready (a failed first boot) stays too.
    const failed = w.create();
    await assert.rejects(vms.start(failed), /fixture stops here/);
    w.registry.markWorkspaceFailed(failed.id, "workspace allocation failed: boot");
    assert.equal(w.registry.relocateThread(failed.id), null);
    w.invariants();
    await vms.close();
    w.registry.close();
    console.log("ok: a started (or allocated) thread whose runner is lost waits for it and never moves");
  }

  // --- every runner down, then one recovers ---
  {
    const w = world("all-down", [{ name: "a", max: 1 }, { name: "b", max: 1 }]);
    const thread = w.create();
    w.fakes.get("a")!.down = true;
    w.fakes.get("b")!.down = true;
    const vms = w.vms();
    await assert.rejects(vms.start(thread), (error: Error) => error instanceof RunnerWait
      && /^waiting for a runner: node-b does not answer, and no other runner with a free thread machine is ready; cube tries again$/.test(error.message));
    assert.deepEqual([w.fakes.get("a")!.calls, w.fakes.get("b")!.calls], [["health"], ["health"]], "each runner asked once");
    for (let round = 0; round < 5; round++) await assert.rejects(vms.start(w.get(thread.id)), RunnerWait);
    assert.deepEqual([w.fakes.get("a")!.calls.length, w.fakes.get("b")!.calls.length], [1, 1], "no retry before the backoff");
    assert.equal(placement(w.get(thread.id)), "provisional");
    w.invariants();
    // b recovers; once its retry is due it is asked again and takes the thread.
    w.fakes.get("b")!.down = false;
    w.registry.recordRunnerProbe("b", { error: "NODE_UNAVAILABLE" }, Date.now() - 120_000);
    await assert.rejects(vms.start(w.get(thread.id)), /fixture stops here/);
    assert.equal(w.get(thread.id).runnerId, "b");
    assert.equal(w.fakes.get("a")!.calls.length, 1, "the runner still down was not asked again");
    w.invariants();
    await vms.close();
    w.registry.close();
    console.log("ok: with every runner down the thread waits with bounded contact; the first runner to recover takes it");
  }

  // --- what the user and OptChat see while a thread waits ---
  {
    class Waiting extends LocalMachines {
      waits = 2;
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
      app.registry.enrollRunner({ nodeId: "node-a", threadId: "a", environmentId: 1, configPath: "/private/a.json", configHash: "a" });
      app.registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
      const thread = app.registry.createThread("p", "view", { provider: faux.getModel().provider, id: faux.getModel().id }, "hello");
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
      await assert.rejects(adapter.events(thread.id), /waiting for a runner/, "OptChat's watcher counts it as a start not made yet");
      // The runner comes back: the next try starts the thread and the wait is gone.
      await app.conversations.activate(thread.id);
      assert.equal(app.conversations.waiting(thread.id), null);
      assert.equal(app.registry.getThread(thread.id)!.workspaceState, "available");
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
