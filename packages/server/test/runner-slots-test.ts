/** Several threads on one runner: slot accounting in the registry (spread,
 * limits, failed machines, archive, a lowered bound, one-machine runners,
 * a race between processes) and the product over local guests: two threads
 * on one runner run commands at the same time, each in its own machine, a
 * third is refused, a failed machine holds its slot until it is archived.
 * Local guests stand in for VMs here; the real runner's bound and isolation
 * are tested in cube-runner's runner_vm.rs. Not runner acceptance. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { Registry, type Project, type Thread } from "../src/registry.ts";
import type { GatewaySupervisor } from "../src/gateway.ts";
import { IrohNodeError, type IrohRunnerClient } from "../src/iroh-node.ts";
import { ThreadVms } from "../src/vm.ts";
import { LocalMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-runner-slots-"));
const health = { lifecycle: "ready" as const, draining: false, error: null, activeVms: 0, runningVms: 0, maxActiveVms: 1,
  retainedVms: 0, retainedBytes: 0, softwareVersion: "test", protocolVersion: 3 as const };
const project = (id: string): Project => ({ id, name: id, status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
const model = { provider: "fixture", id: "selected" };
const runner = (id: string, maxActiveVms?: number) => ({ nodeId: `node-${id}`, environmentId: 1, threadId: id,
  configPath: `/private/${id}.json`, configHash: id, ...(maxActiveVms ? { maxActiveVms } : {}) });
const archive = (registry: Registry, id: string) => { registry.beginRelease(id); registry.finishRelease(id); };

try {
  // --- registry ---
  const registry = new Registry(path.join(root, "registry.sqlite"));
  registry.saveProject(project("p"));
  registry.enrollRunner(runner("wide", 2));
  const status = () => registry.runnerStatuses().find(row => row.id === "wide")!;
  const slots = () => { const { free, total } = registry.runnerSlots(); return { free, total }; };
  assert.deepEqual(slots(), { free: 2, total: 2 });
  const a = registry.createThread("p", "a", model, "a");
  assert.equal(status().allocationState, "available", "a runner with a free slot stays allocatable");
  assert.equal(status().threadId, a.id);
  assert.throws(() => registry.beginRunnerRetirement("wide"), /active global allocation/, "an open thread blocks retirement");
  const b = registry.createThread("p", "b", model, "b");
  assert.equal(b.runnerId, "wide");
  assert.deepEqual([status().activeThreads, status().maxActiveVms, status().allocationState], [2, 2, "allocating"]);
  assert.deepEqual(status().threadIds, [a.id, b.id]);
  assert.throws(() => registry.createThread("p", "c", model, "c"), /no free thread machine/);
  assert.deepEqual(slots(), { free: 0, total: 2 });

  // A failed machine keeps its slot (its disk may exist) until archived.
  registry.markWorkspaceAvailable(a.id);
  registry.markWorkspaceFailed(b.id, "workspace allocation failed: boom");
  assert.deepEqual(registry.runnerCapacity().errors, ["workspace allocation failed: boom"]);
  assert.equal(status().allocationState, "failed");
  assert.throws(() => registry.createThread("p", "c", model, "c"), /no free thread machine/);
  archive(registry, b.id);
  assert.deepEqual(slots(), { free: 1, total: 2 }, "archive returns exactly one slot");
  assert.deepEqual(registry.runnerCapacity().errors, []);
  const c = registry.createThread("p", "c", model, "c");
  assert.equal(c.runnerId, "wide");

  // Spread: a second runner takes the next thread; one with a failed machine comes last.
  registry.enrollRunner(runner("other", 2));
  const d = registry.createThread("p", "d", model, "d");
  assert.equal(d.runnerId, "other", "the least loaded runner is chosen");
  archive(registry, a.id); archive(registry, c.id);
  registry.markWorkspaceFailed(d.id, "workspace allocation failed: runner broken");
  assert.equal(registry.createThread("p", "e", model, "e").runnerId, "wide", "a runner with a failed machine is chosen last");

  // The runner's own bound wins: lowering it stops new allocations only.
  registry.recordRunnerProbe("other", { health: { ...health, maxActiveVms: 1 } });
  assert.equal(registry.runnerStatuses().find(row => row.id === "other")!.maxActiveVms, 1);
  assert.equal(registry.createThread("p", "f", model, "f").runnerId, "wide");
  assert.throws(() => registry.createThread("p", "g", model, "g"), /no free thread machine/, "other is full at its new bound of one");
  registry.recordRunnerSlots("other", 3);
  assert.equal(registry.createThread("p", "g", model, "g").runnerId, "other");
  assert.throws(() => registry.recordRunnerSlots("other", 0), /positive integer/);

  // A runner without an advertised bound (before 0.7.0) hosts one machine, as always.
  registry.saveProject(project("q"));
  registry.enrollRunner(runner("single"));
  const only = registry.createThread("q", "only", model, "only");
  assert.equal(only.runnerId, "single");
  assert.equal(registry.runnerStatuses().find(row => row.id === "single")!.allocationState, "allocating",
    "a one-machine runner is exclusive to its thread, as before");
  assert.equal(registry.runnerStatuses().find(row => row.id === "single")!.maxActiveVms, 1);
  registry.close();

  // A race between processes never oversubscribes: capacity 2, three creators.
  const raceFile = path.join(root, "race.sqlite");
  const race = new Registry(raceFile);
  for (const id of ["r1", "r2", "r3"]) race.saveProject(project(id));
  race.enrollRunner(runner("raced", 2));
  race.close();
  const source = `
    const { parentPort, workerData } = require("node:worker_threads");
    import(workerData.module).then(({ Registry }) => {
      const registry = new Registry(workerData.filename);
      parentPort.postMessage({ ready: true });
      parentPort.once("message", () => {
        try { registry.createThread(workerData.projectId, "race", { provider: "fixture", id: "selected" }, "race"); parentPort.postMessage({ ok: true }); }
        catch (error) { parentPort.postMessage({ ok: false, error: error.message }); }
        finally { registry.close(); }
      });
    });`;
  const workers = ["r1", "r2", "r3"].map(projectId => {
    const worker = new Worker(source, { eval: true, workerData: { module: new URL("../src/registry.ts", import.meta.url).href, filename: raceFile, projectId } });
    let ready!: () => void, done!: (value: { ok: boolean; error?: string }) => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const finished = new Promise<{ ok: boolean; error?: string }>((resolve, reject) => { done = resolve; worker.once("error", reject); });
    worker.on("message", message => message.ready ? ready() : done(message));
    return { worker, started, finished };
  });
  await Promise.all(workers.map(worker => worker.started));
  workers.forEach(worker => worker.worker.postMessage("go"));
  const results = await Promise.all(workers.map(worker => worker.finished));
  await Promise.all(workers.map(worker => worker.worker.terminate()));
  assert.equal(results.filter(result => result.ok).length, 2, JSON.stringify(results));
  assert.match(results.find(result => !result.ok)!.error!, /no free thread machine/);
  const raced = new Registry(raceFile);
  assert.equal(raced.listThreads().length, 2);
  raced.close();

  // --- a full runner: an unbound thread moves to a runner with room ---
  {
    const file = path.join(root, "relocate.sqlite");
    const moving = new Registry(file);
    moving.saveProject(project("m"));
    moving.enrollRunner(runner("full", 2));
    moving.enrollRunner(runner("roomy", 1));
    const first = moving.createThread("m", "first", model, "first");
    assert.equal(first.runnerId, "full", "enrollment order breaks the tie");
    const calls: string[] = [];
    const vmRecord = (ref: { threadId: string; vmId: string }, state: string) => ({ vmId: ref.vmId, threadId: ref.threadId, state, interrupted: false, diskBytes: 0 });
    const fake = (name: string) => ({
      target: { peer: "0".repeat(64), network: "loopback" as const, address: "127.0.0.1:1" },
      nodeId: `node-${name}`,
      describe: async () => ({ softwareVersion: "0.7.0", capabilities: [], platform: "linux-x86_64", baseImageSha256: "0".repeat(64),
        limits: { maxFrameBytes: 1048576, requestTimeoutMs: 5000, maxVcpus: 2, maxMemoryMiB: 4096, maxDiskGiB: 32, maxSeedBytes: 65536, maxActiveVms: name === "full" ? 2 : 1 } }),
      vmInspect: async () => { throw new IrohNodeError("NOT_FOUND"); },
      vmAllocate: async (ref: { threadId: string; vmId: string }) => {
        calls.push(`${name}:allocate`);
        if (name === "full") throw new IrohNodeError("CAPACITY_EXCEEDED", false, "the runner's disk has less than 4 GiB free");
        return vmRecord(ref, "allocated");
      },
      vmStart: async () => { calls.push(`${name}:start`); throw new Error("fixture stops here"); },
    });
    const gateway = { binary: "/bin/false", unavailable: null, control: "/nonexistent", onRestart: () => {},
      ensureNetwork: async () => {}, ready: async () => ({ client: {}, hello: { peer: "0".repeat(64), caPem: "" } }) };
    const vms = new ThreadVms({ registry: moving, threads: path.join(root, "relocate-threads"), run: path.join(root, "relocate-run"),
      gateway: gateway as unknown as GatewaySupervisor, runnerClient: admission => fake(admission.configHash) as unknown as IrohRunnerClient });
    await assert.rejects(vms.start(first), /fixture stops here/);
    assert.deepEqual(calls, ["full:allocate", "roomy:allocate", "roomy:start"]);
    assert.equal(moving.getThread(first.id)!.runnerId, "roomy", "the thread moved to the runner with room");
    assert.equal(moving.runner(first.id)!.threadId, "roomy");
    assert.deepEqual(moving.runnerStatuses().map(row => [row.id, row.activeThreads]), [["full", 0], ["roomy", 1]]);

    // Bound to its runner (the agent's storage exists): it stays and says why.
    const second = moving.createThread("m", "second", model, "second");
    assert.equal(second.runnerId, "full");
    fs.mkdirSync(path.join(root, "relocate-threads", second.id), { recursive: true });
    fs.writeFileSync(path.join(root, "relocate-threads", second.id, "pi.sqlite"), "");
    calls.length = 0;
    await assert.rejects(vms.start(second), /no room for this thread's machine \(the runner's disk has less than 4 GiB free\); cube tries again/);
    assert.deepEqual(calls, ["full:allocate"]);
    assert.equal(moving.getThread(second.id)!.runnerId, "full");
    await vms.close();
    moving.close();
  }

  // --- product: two threads on one runner at once ---
  const textOf = (message: Message) => typeof message.content === "string" ? message.content
    : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses(Array.from({ length: 20 }, () => async request => {
    const last = request.messages.findLast(message => message.role !== "system")!;
    if (last.role === "toolResult") return fauxAssistantMessage(`listing: ${textOf(last).trim().replace(/\n/g, " ")}`);
    const name = /work as (\w+)/.exec(textOf(last))![1];
    // Each command takes four seconds and records when it ran.
    return fauxAssistantMessage([fauxToolCall("bash", { command: `touch mine-${name}; s=$(date +%s%N); sleep 4; echo "$s $(date +%s%N)" > span; ls` })], { stopReason: "toolUse" });
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  class FlakyMachines extends LocalMachines {
    failing = new Set<string>();
    override async start(thread: Thread): Promise<void> {
      if (this.failing.has(thread.title ?? "")) throw new Error("the thread machine did not start: fixture");
      return super.start(thread);
    }
  }
  const machines = new FlakyMachines(path.join(root, "machines"));
  const app = await createCubed({ state: path.join(root, "state"), models, machines, claude: null, gateway: null });
  app.registry.enrollRunner(runner("shared", 2));
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (route: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${base}${route}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const until = async <T>(read: () => Promise<T>, check: (value: T) => boolean, what: string): Promise<T> => {
    let value = await read();
    for (const deadline = Date.now() + 30_000; !check(value); value = await read()) {
      assert.ok(Date.now() < deadline, `${what}: ${JSON.stringify(value).slice(0, 2000)}`);
      await delay(50);
    }
    return value;
  };
  try {
    const created = await call("/api/projects", { name: "demo", repositories: [] });
    const projectId = created.body.project.id;
    assert.equal((await call(`/api/projects/${projectId}/check`, {})).body.project.status, "ready");
    const selected = { provider: faux.getModel().provider, id: faux.getModel().id };
    const start = (name: string) => call("/api/threads", { projectId, requestId: name, text: `work as ${name}`, model: selected });
    const [one, two] = await Promise.all([start("one"), start("two")]);
    assert.equal(one.status, 200, JSON.stringify(one.body)); assert.equal(two.status, 200, JSON.stringify(two.body));
    const third = await start("three");
    assert.notEqual(third.status, 200);
    assert.match(third.body.error, /no free thread machine/);
    const view = (await call("/api/projects")).body.projects[0];
    assert.deepEqual([view.availableSlotCount, view.availableRunnerCount, view.runnerCapacity.slots], [0, 0, { free: 0, total: 2 }]);
    const runners = (await call("/api/runners")).body.runners;
    assert.deepEqual([runners[0].activeThreads, runners[0].maxActiveVms], [2, 2]);

    const finished = async (id: string) => until(async () => (await call(`/api/threads/${id}/history`)).body,
      history => history.status.state === "completed", `thread ${id} finishes`);
    const histories = await Promise.all([finished(one.body.id), finished(two.body.id)]);
    const listing = (history: { events: Array<{ type: string; text?: string }> }) => history.events.filter(event => event.type === "assistant-text").map(event => event.text).join(" ");
    assert.match(listing(histories[0]), /mine-one/); assert.doesNotMatch(listing(histories[0]), /mine-two/, "machines are separate");
    assert.match(listing(histories[1]), /mine-two/); assert.doesNotMatch(listing(histories[1]), /mine-one/, "machines are separate");
    const span = (id: string) => fs.readFileSync(path.join(machines.guest(app.registry.getThread(id)!).workspace, "span"), "utf8").trim().split(" ").map(BigInt);
    const [s1, s2] = [span(one.body.id), span(two.body.id)];
    assert.ok(s1[0] < s2[1] && s2[0] < s1[1], "both threads' commands ran at the same time");

    // Archiving one frees its slot; a machine that fails to start holds the
    // freed slot until it is archived too.
    assert.equal((await call(`/api/threads/${one.body.id}`, undefined, "DELETE")).status, 200);
    machines.failing.add("work as broken");
    const broken = await start("broken");
    assert.equal(broken.status, 200, JSON.stringify(broken.body));
    await until(async () => app.registry.getThread(broken.body.id)!.workspaceState, state => state === "failed", "the broken machine fails");
    assert.match((await start("four")).body.error, /no free thread machine/);
    assert.match((await call("/api/projects")).body.projects[0].runnerCapacity.errors[0], /did not start: fixture/);
    assert.equal((await call(`/api/threads/${broken.body.id}`, undefined, "DELETE")).status, 200);
    const four = await start("four");
    assert.equal(four.status, 200, JSON.stringify(four.body));
    await finished(four.body.id);
  } finally {
    await app.close();
    await machines.close();
  }
  console.log("ok: runner slots (spread, bound, failed machines, archive, one-machine runners, process race, full-runner relocation) and two concurrent threads on one runner over local guests");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
