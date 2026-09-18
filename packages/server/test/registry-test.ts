import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Registry } from "../src/registry.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-registry-"));
const filename = path.join(root, "registry.sqlite");
let registry = new Registry(filename);
try {
  registry.saveProject({ id: "project", name: "test", status: "ready", error: null, revision: 1,
    checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  const model = { provider: "fixture", id: "selected" };
  assert.throws(() => registry.createThread("project", "request", model, "one"), /no runner available/);
  registry.enrollRunner({ projectId: "project", nodeId: "node-test", environmentId: 7, threadId: "thread-test", configPath: "/private/config.json", configHash: "hash" });
  const thread = registry.createThread("project", "request", model, "one");
  assert.notEqual(thread.id, "thread-test", "thread identity is independent of reusable runner identity");
  assert.equal(registry.availableRunners("project").length, 0);
  registry.close(); registry = new Registry(filename);
  assert.deepEqual(registry.createThread("project", "request", model, "one"), thread);
  assert.throws(() => registry.createThread("project", "request", model, "two"), /conflicts/);
  assert.equal(registry.initialPrompt(thread.id), "one");
  registry.markWorkspaceAvailable(thread.id);
  registry.beginRelease(thread.id);
  registry.finishRelease(thread.id);
  assert.equal(registry.availableRunners("project").length, 1, "release returns runner capacity");
  const next = registry.createThread("project", "next", model, "two");
  assert.notEqual(next.id, thread.id);
  const v100 = path.join(root, "v100.sqlite");
  const previous = new DatabaseSync(v100);
  const oldProject = { id: "old-project", name: "old", status: "ready", error: null, revision: 1,
    checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] };
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
  assert.equal(migrated.availableRunners(oldProject.id).length, 1, "archived v100 bindings become reusable");
  assert.equal(migrated.getThread(oldThread.id)?.runnerId, oldRunner.threadId);
  migrated.close();
  const old = path.join(root, "old.sqlite");
  const db = new DatabaseSync(old); db.exec("CREATE TABLE cube(id INTEGER)"); db.close();
  assert.throws(() => new Registry(old), /fresh CUBED_STATE/);
  console.log("ok: fresh metadata, atomic reusable allocation, restart-safe creation keys, conflicts, v100 migration and legacy schema rejection");
} finally { registry.close(); fs.rmSync(root, { recursive: true, force: true }); }
