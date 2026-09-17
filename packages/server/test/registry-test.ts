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
  assert.equal(registry.availableRunners("project").length, 0);
  registry.close(); registry = new Registry(filename);
  assert.deepEqual(registry.createThread("project", "request", model, "one"), thread);
  assert.throws(() => registry.createThread("project", "request", model, "two"), /conflicts/);
  assert.equal(registry.initialPrompt(thread.id), "one");
  registry.saveThread({ ...thread, archived: true });
  assert.equal(registry.availableRunners("project").length, 0, "archiving never reuses runner identities");
  const old = path.join(root, "old.sqlite");
  const db = new DatabaseSync(old); db.exec("CREATE TABLE cube(id INTEGER)"); db.close();
  assert.throws(() => new Registry(old), /fresh CUBED_STATE/);
  console.log("ok: fresh metadata, atomic allocation, restart-safe creation keys, conflict and non-reuse, legacy schema rejection");
} finally { registry.close(); fs.rmSync(root, { recursive: true, force: true }); }
