import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { Registry, RUNNER_STALE_AFTER_MS } from "../src/registry.ts";

const idleHealth = { lifecycle: "ready" as const, draining: false, error: null, activeVms: 0, runningVms: 0, maxActiveVms: 1,
  retainedVms: 0, retainedBytes: 0, softwareVersion: "test", protocolVersion: 3 as const };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-registry-"));
const filename = path.join(root, "registry.sqlite");
let registry = new Registry(filename);
try {
  registry.saveProject({ id: "project", name: "test", status: "ready", error: null, revision: 1,
    checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  registry.saveProject({ id: "other", name: "other", status: "ready", error: null, revision: 1,
    checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  registry.saveProject({ id: "disposable", name: "disposable", status: "ready", error: null, revision: 1,
    checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  const model = { provider: "fixture", id: "selected" };
  assert.throws(() => registry.createThread("project", "request", model, "one"), /no free thread machine/);
  registry.enrollRunner({ nodeId: "node-test", environmentId: 7, threadId: "thread-test", configPath: "/private/config.json", configHash: "hash" });
  registry.deleteProject("disposable");
  assert.equal(registry.getProject("disposable"), null, "global runners do not block project deletion");
  assert.deepEqual(registry.listRunners().map(runner => runner.nodeId), ["node-test"]);
  const thread = registry.createThread("project", "request", model, "one");
  assert.notEqual(thread.id, "thread-test", "thread identity is independent of reusable runner identity");
  assert.match(thread.vm?.vmId ?? "", /^[0-9a-f]{16}$/, "a thread gets its machine's id at creation");
  assert.match(thread.vm?.placeholders.github ?? "", /^cube_ph_github_[A-Za-z0-9]{22}$/);
  assert.equal(registry.threadByVm(thread.vm!.vmId)?.id, thread.id);
  assert.equal(registry.updateThreadVm(thread.id, { provisionAttempt: 2 }).vm?.provisionAttempt, 2);
  registry.saveThread(thread);
  assert.equal(registry.availableRunners().length, 0);
  assert.throws(() => registry.createThread("other", "racing-project", model, "race"), /no free thread machine/);
  registry.close(); registry = new Registry(filename);
  assert.deepEqual(registry.createThread("project", "request", model, "one"), thread);
  assert.throws(() => registry.createThread("project", "request", model, "two"), /conflicts/);
  assert.equal(registry.initialPrompt(thread.id), "one");
  const base = { remote: "https://github.com/example/project.git", ref: "refs/heads/develop", oid: "a".repeat(40) };
  registry.markWorkspaceAvailable(thread.id, base);
  assert.deepEqual(registry.getThread(thread.id)?.workspaceBase, base, "workspace base survives host restart/recovery");
  registry.beginRelease(thread.id);
  registry.finishRelease(thread.id);
  assert.equal(registry.availableRunners().length, 1, "release returns global runner capacity");
  const next = registry.createThread("other", "next", model, "two");
  assert.notEqual(next.id, thread.id);
  assert.equal(next.projectId, "other", "a runner migrated from one project serves another");
  assert.equal(registry.runnerStatuses().find(row => row.id === "thread-test")?.allocationProjectId, "other",
    "operator status reads the current global allocation snapshot, not runner ownership");
  assert.throws(() => registry.beginRunnerRetirement("thread-test"), /active global allocation/, "global allocation blocks retirement");
  registry.enrollRunner({ nodeId: "node-two", environmentId: 7, threadId: "runner-two", configPath: "/private/two.json", configHash: "two" });
  assert.equal(registry.availableRunners().length, 1, "environment IDs may collide across immutable runner identities");

  registry.beginRunnerRetirement("runner-two");
  assert.equal(registry.runnerCapacity().states.retiring, 1, "global capacity exposes the fail-closed retirement reservation");
  assert.equal(registry.availableRunners().length, 0, "retiring capacity cannot be globally allocated");
  registry.close(); registry = new Registry(filename);
  assert.equal(registry.runnerStatuses().find(row => row.id === "runner-two")?.allocationState, "available",
    "restart reconciles an interrupted read-only retirement check back to global capacity");
  registry.recordRunnerProbe("runner-two", { health: { ...idleHealth, activeVms: 1, runningVms: 1 } }, 10);
  registry.beginRunnerRetirement("runner-two");
  assert.throws(() => registry.finishRunnerRetirement("runner-two", "must not retire", 10, 11), /reachable and idle/,
    "a runner-reported running machine blocks retirement");
  registry.cancelRunnerRetirement("runner-two");
  registry.recordRunnerProbe("runner-two", { health: { ...idleHealth, activeVms: 1 } }, 12);
  registry.beginRunnerRetirement("runner-two");
  assert.throws(() => registry.finishRunnerRetirement("runner-two", "must not retire", 12, 13), /reachable and idle/,
    "a runner-reported allocated machine blocks retirement");
  registry.cancelRunnerRetirement("runner-two");
  registry.recordRunnerProbe("runner-two", { health: idleHealth }, 14);
  registry.beginRunnerRetirement("runner-two");
  registry.finishRunnerRetirement("runner-two", "replacement enrolled", 14, 15);
  assert.equal(registry.runnerCapacity().states.retired, 1);
  assert.equal(registry.availableRunners().length, 0, "retired runners never re-enter the global pool");
  assert.equal(registry.runnerAudit("runner-two").length, 1, "retirement evidence is durable registry metadata");

  registry.enrollRunner({ nodeId: "node-stale", environmentId: 9, threadId: "runner-stale",
    configPath: "/private/stale.json", configHash: "stale" });
  const staleSince = 100;
  registry.recordRunnerProbe("runner-stale", { health: idleHealth }, staleSince);
  registry.recordRunnerProbe("runner-stale", { error: "NODE_UNAVAILABLE" }, staleSince);
  assert.equal(registry.runnerStatuses(staleSince).find(row => row.id === "runner-stale")?.contactStatus, "unreachable",
    "latest outcome, not timestamp equality, determines contact status");
  assert.equal(registry.runnerStatuses(staleSince + RUNNER_STALE_AFTER_MS - 1).find(row => row.id === "runner-stale")?.contactStatus,
    "unreachable", "unreachable is not stale before the full interval");
  const staleAt = staleSince + RUNNER_STALE_AFTER_MS;
  assert.equal(registry.runnerStatuses(staleAt).find(row => row.id === "runner-stale")?.contactStatus, "stale");
  registry.beginRunnerRetirement("runner-stale");
  registry.finishRunnerRetirement("runner-stale", "continuously unreachable", staleSince, staleAt);
  registry.close(); registry = new Registry(filename);
  assert.equal(registry.runnerStatuses().find(row => row.id === "runner-stale")?.contactStatus, "retired",
    "installation-global retirement survives restart");

  registry.saveProject({ id: "retirement-context", name: "retirement context", status: "ready", error: null, revision: 1,
    checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  registry.deleteProject("retirement-context");
  assert.equal(registry.runnerAudit("runner-stale").length, 1, "project deletion cannot erase global retirement evidence");
  assert.throws(() => registry.deleteProject("project"), /retained thread history/);

  const raceFile = path.join(root, "race.sqlite");
  const raceRegistry = new Registry(raceFile);
  for (const id of ["race-one", "race-two"]) raceRegistry.saveProject({ id, name: id, status: "ready", error: null, revision: 1,
    checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  raceRegistry.enrollRunner({ nodeId: "node-race", environmentId: 1, threadId: "runner-race",
    configPath: "/private/race.json", configHash: "race" });
  raceRegistry.close();
  const workerSource = `
    const { parentPort, workerData } = require("node:worker_threads");
    import(workerData.module).then(({ Registry }) => {
      const registry = new Registry(workerData.filename);
      parentPort.postMessage({ ready: true });
      parentPort.once("message", () => {
        try {
          const thread = registry.createThread(workerData.projectId, workerData.projectId, { provider: "fixture", id: "selected" }, workerData.projectId);
          parentPort.postMessage({ ok: true, threadId: thread.id });
        } catch (error) { parentPort.postMessage({ ok: false, error: error.message }); }
        finally { registry.close(); }
      });
    });`;
  const competitors = ["race-one", "race-two"].map(projectId => {
    const worker = new Worker(workerSource, { eval: true, workerData: {
      module: new URL("../src/registry.ts", import.meta.url).href, filename: raceFile, projectId } });
    let ready!: () => void;
    let result!: (value: { ok: boolean; error?: string }) => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const finished = new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
      result = resolve; worker.once("error", reject);
    });
    worker.on("message", message => message.ready ? ready() : result(message));
    return { worker, started, finished };
  });
  await Promise.all(competitors.map(competitor => competitor.started));
  competitors.forEach(competitor => competitor.worker.postMessage("start"));
  const raceResults = await Promise.all(competitors.map(competitor => competitor.finished));
  await Promise.all(competitors.map(competitor => competitor.worker.terminate()));
  assert.equal(raceResults.filter(result => result.ok).length, 1, "simultaneous projects cannot double-allocate one runner");
  assert.match(raceResults.find(result => !result.ok)?.error ?? "", /no free thread machine/);
  const raced = new Registry(raceFile);
  assert.equal(raced.listThreads().length, 1);
  assert.equal(raced.availableRunners().length, 0);
  raced.close();

  // Registries of protocol-2 installations (v100/v101) are not migrated.
  for (const version of [100, 101]) {
    const file = path.join(root, `v${version}.sqlite`);
    const previous = new DatabaseSync(file);
    previous.exec(`PRAGMA user_version=${version}; CREATE TABLE project(id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    previous.close();
    assert.throws(() => new Registry(file), /fresh CUBED_STATE/, `a v${version} registry is refused`);
  }
  const fresh = new DatabaseSync(raceFile);
  assert.equal(fresh.prepare("PRAGMA user_version").get()!.user_version, 102);
  fresh.close();

  const old = path.join(root, "old.sqlite");
  const db = new DatabaseSync(old); db.exec("CREATE TABLE cube(id INTEGER)"); db.close();
  assert.throws(() => new Registry(old), /fresh CUBED_STATE/);
  console.log("ok: global allocation snapshots, thread machines, retirement guards/audit, restart reconcile, project deletion, schema 102 and legacy rejection");
} finally { registry.close(); fs.rmSync(root, { recursive: true, force: true }); }
