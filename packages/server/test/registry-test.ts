import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { Registry, RUNNER_STALE_AFTER_MS } from "../src/registry.ts";

const idleHealth = { lifecycle: "ready" as const, active: false, operationRecords: 0, operationCapacity: 100,
  error: null, softwareVersion: "test", protocolVersion: 1 as const, activeWorkspaces: 0, retainedWorkspaces: 0,
  workspaceBytes: 0, workspaceCapacity: 1, workspaceByteLimit: 1024 };

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
  assert.throws(() => registry.createThread("project", "request", model, "one"), /no runner available/);
  registry.enrollRunner({ nodeId: "node-test", environmentId: 7, threadId: "thread-test", configPath: "/private/config.json", configHash: "hash" });
  registry.deleteProject("disposable");
  assert.equal(registry.getProject("disposable"), null, "global runners do not block project deletion");
  assert.deepEqual(registry.listRunners().map(runner => runner.nodeId), ["node-test"]);
  const thread = registry.createThread("project", "request", model, "one");
  assert.notEqual(thread.id, "thread-test", "thread identity is independent of reusable runner identity");
  assert.equal(registry.availableRunners().length, 0);
  assert.throws(() => registry.createThread("other", "racing-project", model, "race"), /global pool/);
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
  registry.recordRunnerProbe("runner-two", { health: { ...idleHealth, active: true } }, 10);
  registry.beginRunnerRetirement("runner-two");
  assert.throws(() => registry.finishRunnerRetirement("runner-two", "must not retire", 10, 11), /reachable and idle/,
    "runner-reported active work blocks retirement");
  registry.cancelRunnerRetirement("runner-two");
  registry.recordRunnerProbe("runner-two", { health: { ...idleHealth, activeWorkspaces: 1 } }, 12);
  registry.beginRunnerRetirement("runner-two");
  assert.throws(() => registry.finishRunnerRetirement("runner-two", "must not retire", 12, 13), /reachable and idle/,
    "runner-reported active workspace blocks retirement");
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
  assert.match(raceResults.find(result => !result.ok)?.error ?? "", /global pool/);
  const raced = new Registry(raceFile);
  assert.equal(raced.listThreads().length, 1);
  assert.equal(raced.availableRunners().length, 0);
  raced.close();

  const v100 = path.join(root, "v100.sqlite");
  const previous = new DatabaseSync(v100);
  const oldProject = { id: "old-project", name: "old", status: "ready", error: null, revision: 1,
    checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [{ id: "old-repo", projectId: "old-project", position: 0,
      url: "file:///old.git", base: null, checkoutName: "repo-1", status: "ready", error: null,
      resolvedBase: "main", baseOid: "a".repeat(40), checkedAt: 1 }] };
  const oldRunner = { projectId: "old-project", nodeId: "node-old", environmentId: 3, threadId: "thread-old", configPath: "/private/old.json", configHash: "old" };
  const oldThread = { id: "thread-old", projectId: "old-project", title: "done", model, archived: true, createdAt: 1 };
  previous.exec(`PRAGMA user_version=100;
    CREATE TABLE project(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE runner(thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id), node_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
    CREATE TABLE thread(id TEXT PRIMARY KEY REFERENCES runner(thread_id), project_id TEXT NOT NULL REFERENCES project(id), data TEXT NOT NULL);
    CREATE TABLE creation(project_id TEXT NOT NULL, request_id TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES thread(id), payload TEXT NOT NULL, PRIMARY KEY(project_id, request_id));`);
  previous.prepare("INSERT INTO project VALUES (?,?)").run(oldProject.id, JSON.stringify(oldProject));
  previous.prepare("INSERT INTO runner VALUES (?,?,?,?)").run(oldRunner.threadId, oldRunner.projectId, oldRunner.nodeId, JSON.stringify(oldRunner));
  previous.prepare("INSERT INTO thread VALUES (?,?,?)").run(oldThread.id, oldThread.projectId, JSON.stringify(oldThread));
  previous.prepare("INSERT INTO creation VALUES (?,?,?,?)").run(oldProject.id, "old-request", oldThread.id, JSON.stringify({ model, text: "done" }));
  previous.close();
  const migrated = new Registry(v100);
  assert.equal(migrated.availableRunners().length, 1, "archived v100 bindings become globally reusable");
  assert.equal(migrated.getThread(oldThread.id)?.runnerId, oldRunner.threadId);
  assert.equal(migrated.getThread(oldThread.id)?.allocation.repositories[0]?.checkoutName, "workspace",
    "legacy primary repositories migrate to the isolated workspace path");
  assert.equal(migrated.listRunners()[0]?.legacyProjectId, oldProject.id, "legacy binding remains audit metadata");
  assert.equal(migrated.runnerStatuses()[0]?.contactStatus, "unknown", "migration adds global observations without inventing contact history");
  migrated.close();
  const rollback = new DatabaseSync(v100);
  assert.equal(rollback.prepare("PRAGMA user_version").get()!.user_version, 101, "global migration retains the rollback-compatible registry version");
  assert.deepEqual(rollback.prepare("PRAGMA table_info(runner)").all().map(column => column.name),
    ["id", "project_id", "node_id", "data", "state", "thread_id", "error"], "previous releases retain their expected runner table contract");
  assert(rollback.prepare("SELECT 1 FROM global_pool WHERE schema_version=1").get(), "global migration is durably marked and idempotent");
  assert.deepEqual(rollback.prepare("PRAGMA foreign_key_check").all(), [], "migration preserves registry references");
  rollback.close();

  const v101 = path.join(root, "v101.sqlite");
  const current = new DatabaseSync(v101);
  current.exec(`PRAGMA user_version=101;
    CREATE TABLE project(id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE runner(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id), node_id TEXT NOT NULL UNIQUE,
      data TEXT NOT NULL, state TEXT NOT NULL, thread_id TEXT, error TEXT);
    CREATE TABLE thread(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id), runner_id TEXT NOT NULL REFERENCES runner(id), data TEXT NOT NULL);
    CREATE TABLE creation(project_id TEXT NOT NULL, request_id TEXT NOT NULL, thread_id TEXT NOT NULL REFERENCES thread(id), payload TEXT NOT NULL, PRIMARY KEY(project_id, request_id));`);
  current.prepare("INSERT INTO project VALUES (?,?)").run(oldProject.id, JSON.stringify(oldProject));
  current.prepare("INSERT INTO runner VALUES (?,?,?,?,?,?,?)").run(oldRunner.threadId, oldRunner.projectId, oldRunner.nodeId,
    JSON.stringify(oldRunner), "available", null, null);
  current.close();
  const upgraded = new Registry(v101);
  assert.equal(upgraded.runnerStatuses()[0]?.contactStatus, "unknown", "v101 gains global observation metadata without invented contact history");
  assert.equal(upgraded.availableRunners().length, 1, "v101 project binding migrates to global capacity");
  upgraded.recordRunnerProbe(oldRunner.threadId, { health: idleHealth }, 20);
  upgraded.beginRunnerRetirement(oldRunner.threadId);
  upgraded.finishRunnerRetirement(oldRunner.threadId, "legacy host removed", 20, 21);
  upgraded.deleteProject(oldProject.id);
  assert.equal(upgraded.runnerStatuses()[0]?.contactStatus, "retired", "project deletion preserves a migrated global tombstone");
  assert.equal(upgraded.runnerAudit(oldRunner.threadId).length, 1, "project deletion preserves migrated retirement evidence");
  upgraded.close();

  const old = path.join(root, "old.sqlite");
  const db = new DatabaseSync(old); db.exec("CREATE TABLE cube(id INTEGER)"); db.close();
  assert.throws(() => new Registry(old), /fresh CUBED_STATE/);
  console.log("ok: global allocation snapshots, retirement guards/audit, restart reconcile, project deletion, rollback-compatible migration and legacy rejection");
} finally { registry.close(); fs.rmSync(root, { recursive: true, force: true }); }
