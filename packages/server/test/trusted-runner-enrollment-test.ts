/** Disposable registry migration/admission tests. No live nodes or workspaces. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Registry } from "../src/registry.ts";
import { CubeSupervisor } from "../src/supervisor.ts";
import { MockBackend } from "@cube/sandbox";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "trusted-runner-enrollment-"));
const dbPath = path.join(root, "registry.db");
let registry = new Registry(dbPath);
let supervisor: CubeSupervisor | undefined;
try {
  registry.createProject({ id: "project", name: "test", repositories: [] });
  const local = registry.createCube({ name: "local", image: "mock", workspacePath: path.join(root, "local") });
  registry.addThread({ id: "local", cubeId: local.id, projectId: "project", piSessionPath: path.join(root, "local.jsonl") });
  const identity = registry.localNodeId;
  const prior = { cube: registry.getCube("local"), thread: registry.getThread("local") };
  try { registry.close(); } catch { /* may already be closed for migration */ }
  // Recreate exactly the previously shipped local-only execution_node schema.
  const old = new DatabaseSync(dbPath);
  for (const row of old.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as { name: string }[]) old.exec(`DROP TRIGGER ${row.name}`);
  old.exec(`PRAGMA foreign_keys=OFF;
    DROP TABLE host_node_admission;
    CREATE TABLE old_node (id TEXT PRIMARY KEY, local INTEGER NOT NULL UNIQUE CHECK(local = 1));
    INSERT INTO old_node SELECT * FROM execution_node;
    DROP TABLE execution_node;
    ALTER TABLE old_node RENAME TO execution_node;`);
  old.close();
  registry = new Registry(dbPath);
  assert.equal(registry.localNodeId, identity);
  assert.deepEqual({ cube: registry.getCube("local"), thread: registry.getThread("local") }, prior);
  const admission = { nodeId: "node-runner", environmentId: 123, threadId: "runner", projectId: "project",
    configPath: path.join(root, "intentionally-missing.json"), configHash: "a".repeat(64), name: "runner",
    workspacePath: path.join(root, "runner", "workspace"), piSessionPath: path.join(root, "runner", "sessions", "runner.jsonl") };
  assert.throws(() => registry.enrollTrustedRunner({ ...admission, environmentId: local.id }), /fresh/);
  assert.throws(() => registry.enrollTrustedRunner({ ...admission, threadId: "local" }), /fresh/);
  assert.throws(() => registry.enrollTrustedRunner({ ...admission, projectId: "missing" }), /FOREIGN KEY/);
  assert.deepEqual(registry.trustedRunnerAdmissions(), [], "failed enrollment is wholly rolled back");
  registry.enrollTrustedRunner(admission);
  assert.equal(registry.nodeForCube(123), "node-runner");
  assert.equal(registry.nodeForCube(local.id), identity);
  assert.throws(() => registry.enrollTrustedRunner(admission), /fresh/);
  assert.throws(() => registry.enrollTrustedRunner({ ...admission, environmentId: 124, threadId: "different", name: "different" }), /UNIQUE/);
  const raw = new DatabaseSync(dbPath);
  raw.exec("PRAGMA recursive_triggers=ON");
  for (const sql of ["UPDATE host_node_admission SET config_hash='different'", "DELETE FROM host_node_admission",
    "UPDATE environment_node SET node_id='node-runner'", "DELETE FROM thread WHERE id='runner'", "DELETE FROM cube WHERE id=123",
    "DELETE FROM execution_node WHERE id='node-runner'", "UPDATE thread SET cube_id=123 WHERE id='local'"]) {
    assert.throws(() => raw.exec(sql), /immutable|permanent/);
  }
  assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
  raw.close();
  try { registry.close(); } catch { /* may already be closed for migration */ }
  registry = new Registry(dbPath);
  assert.equal(registry.trustedRunnerAdmissions().length, 1);
  assert.equal(registry.nodeForCube(123), "node-runner");
  const backend = new MockBackend();
  backend.getState = async () => { throw new Error("must not probe local backend"); };
  backend.sandbox = () => { throw new Error("must not create local sandbox"); };
  supervisor = new CubeSupervisor(registry, backend, { cubesRoot: root, reposRoot: path.join(root, "repos"),
    image: "mock", pool: "mock", rootSize: "1GiB", dockerVolumeSize: "1GiB", idleMs: 0,
    portalBase: "cube.localhost", publicPort: 7777, egressAllow: [], environmentCache: false });
  const plan = await supervisor.terminalPlan("runner", () => {});
  assert.equal(plan.env.CUBE_BACKEND, "runner");
  assert.equal(plan.env.CUBE_NODE_ID, "node-runner");
  assert.equal(fs.existsSync(admission.workspacePath), false);
  assert.deepEqual(await supervisor.repositoriesForUserThread("runner"), [], "a repository-free runner thread needs no unsupported local probe");
  for (const action of [() => supervisor!.wakeCube("runner"), () => supervisor!.sleepCube("runner"),
    () => supervisor!.removeCube("runner"), () => supervisor!.workspaceForUserThread("runner")]) {
    await assert.rejects(action(), { code: "OPERATION_UNSUPPORTED" });
  }
  await assert.rejects(supervisor.runnerExecForUserThread("local", { action: "prepare", spec: {} }), { code: "OPERATION_UNSUPPORTED" });
  for (const value of [null, [], {}, { action: "status", nodeId: "node-other" }, { action: "submit", operationId: "../escape" }]) {
    await assert.rejects(supervisor.runnerExecForUserThread("runner", value), { code: "INVALID_REQUEST" });
  }
  await assert.rejects(supervisor.runnerExecForUserThread("runner", { action: "status" }));
  const workerPlan = await supervisor.terminalPlan("runner", () => {});
  assert.equal(workerPlan.env.CUBE_BACKEND, "runner", "configuration loss does not stop conversation startup");
  assert.equal(workerPlan.env.CUBE_RUNNER_WORKSPACE, admission.workspacePath);
  assert.equal(workerPlan.env.CUBE_HOST_WORKSPACE, admission.workspacePath, "legacy extension env alias remains during migration");
  registry.archiveThread("runner");
  await assert.rejects(supervisor.runnerExecForUserThread("runner", { action: "prepare", spec: {} }), { code: "OPERATION_UNSUPPORTED" });
  const replacement = { ...admission, nodeId: "node-runner-replacement", environmentId: 124,
    threadId: "runner-replacement", name: "runner-new", configPath: path.join(root, "replacement.json"),
    configHash: "b".repeat(64), workspacePath: path.join(root, "replacement", "workspace"),
    piSessionPath: path.join(root, "replacement", "sessions", "runner.jsonl") };
  registry.enrollTrustedRunner(replacement);
  assert.deepEqual(registry.trustedRunnerAdmissions().map(row => row.nodeId).sort(), ["node-runner", "node-runner-replacement"]);
  assert.equal(registry.getThread("runner")!.archivedAt !== null, true, "replacement preserves retired immutable binding");
  console.log("ok: local migration, permanent admission, rollback, restart, replace/re-enroll and no local fallback");
} finally {
  await supervisor?.close();
  try { registry.close(); } catch { /* may already be closed for migration */ }
  fs.rmSync(root, { recursive: true, force: true });
}
