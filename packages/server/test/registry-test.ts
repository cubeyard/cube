/**
 * Offline unit test for the SQLite registry: subnet + portal allocation,
 * name validation, thread rebind, volume upsert, cascade delete.
 *
 *   node packages/server/test/registry-test.ts
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { Registry, networkForCube } from "../src/registry.ts";

const registry = new Registry(":memory:");

const project = registry.createProject({
  id: "project-1",
  name: "cube",
  repositories: [
    {
      id: "project-repo-1",
      url: "https://github.com/cubeyard/cube.git",
      base: null,
      checkoutName: "workspace",
    },
  ],
});
registry.setProjectRepositoryCheck("project-repo-1", {
  status: "ready",
  resolvedBase: "main",
  baseOid: "deadbeef",
  checkedAt: 1,
});
registry.finishProjectCheck(project.id, project.revision, "ready", null, 1);
assert.equal(registry.getProject(project.id)!.status, "ready");
assert.equal(registry.listProjectRepositories(project.id)[0]!.resolvedBase, "main");
console.log("0 ok: project + repository readiness round-trip");

// --- cube creation, subnet allocation, derived network
const a = registry.createCube({ name: "alpha", image: "cube-node", workspacePath: "/w/alpha" });
const b = registry.createCube({ name: "beta", image: "cube-node", workspacePath: "/w/beta" });
assert.equal(a.status, "creating");
assert.equal(a.subnetIndex, 10);
assert.equal(b.subnetIndex, 11);
const netA = networkForCube(a.name, a.subnetIndex);
assert.deepEqual(netA, {
  bridge: "cbr-alpha",
  subnet: "10.90.10.1/24",
  gateway: "10.90.10.1",
  ip: "10.90.10.10",
});
console.log("1 ok: subnet allocation + derived network");

// --- name validation (IFNAMSIZ: cbr-<name> must fit)
for (const bad of ["", "UPPER", "über", "a".repeat(12), "-lead", "1lead", "sp ace"]) {
  assert.throws(() => registry.createCube({ name: bad, image: "i", workspacePath: "/w" }), /invalid cube name/);
}
assert.throws(() => registry.createCube({ name: "alpha", image: "i", workspacePath: "/w" }), /UNIQUE/);
console.log("2 ok: name validation + uniqueness");

// --- freed subnets are reused (lowest-first)
registry.deleteCube("alpha");
const c = registry.createCube({ name: "gamma", image: "cube-node", workspacePath: "/w/gamma" });
assert.equal(c.subnetIndex, 10);
console.log("3 ok: freed subnet reused");

// --- status transitions
registry.setCubeStatus("beta", "error", "boom");
assert.equal(registry.getCube("beta")!.status, "error");
assert.equal(registry.getCube("beta")!.error, "boom");
registry.setCubeStatus("beta", "ready");
assert.equal(registry.getCube("beta")!.error, null);
console.log("4 ok: status transitions");

// --- threads: required project + one thread per cube
registry.addThread({ id: "t1", cubeId: c.id, projectId: project.id, piSessionPath: "/s/t1.jsonl" });
assert.throws(
  () => registry.addThread({ id: "duplicate", cubeId: c.id, projectId: project.id, piSessionPath: "/s/dup.jsonl" }),
  /UNIQUE/,
);
registry.addThread({ id: "t2", cubeId: b.id, projectId: project.id, piSessionPath: "/s/t2.jsonl" });
assert.deepEqual(registry.listThreads(c.id).map((t) => t.id), ["t1"]);
assert.equal(registry.getThread("t1")!.archivedAt, null);
registry.archiveThread("t1");
assert.ok(registry.getThread("t1")!.archivedAt);
assert.equal(registry.countThreadsForProject(project.id), 2);
registry.deleteCube("beta");
assert.equal(registry.getThread("t2"), null);
assert.equal(registry.countThreadsForProject(project.id), 1);
console.log("5 ok: threads require a project and are one-per-cube");

// --- immutable per-cube repository snapshots
registry.addCubeRepositories(c.id, [
  {
    url: "https://github.com/cubeyard/cube.git",
    base: "main",
    branch: "cube/gamma",
    baseOid: "deadbeef",
    checkoutName: "workspace",
    workspacePath: "/w/gamma",
  },
  {
    url: "https://github.com/cubeyard/docs.git",
    base: "main",
    branch: "cube/gamma",
    baseOid: "feedface",
    checkoutName: "docs",
    workspacePath: "/w/repos/docs",
  },
]);
assert.deepEqual(
  registry.listCubeRepositories(c.id).map((repo) => [repo.checkoutName, repo.workspacePath]),
  [["workspace", "/w/gamma"], ["docs", "/w/repos/docs"]],
);
console.log("5b ok: cube repository snapshots preserve order and paths");

// --- portals: idempotent per (cube, name), hostname routing, release
const p1 = registry.upsertPortal(c.id, "web", 3000, "web--gamma");
const p1again = registry.upsertPortal(c.id, "web", 3100, "web--gamma");
const p2 = registry.upsertPortal(c.id, "api", 8080, "api--gamma");
assert.equal(p1.targetPort, 3000);
assert.equal(p1again.id, p1.id); // same row, updated target
assert.equal(p1again.targetPort, 3100);
assert.equal(registry.getPortalByHostname("web--gamma")!.targetPort, 3100);
assert.equal(registry.getPortalByHostname("api--gamma")!.name, "api");
assert.equal(registry.getPortalByHostname("nope--gamma"), null);
assert.deepEqual(registry.listPortals(c.id).map((r) => r.name), ["api", "web"]);
registry.releasePortal(c.id, "web");
assert.equal(registry.getPortalByHostname("web--gamma"), null);
assert.equal(p2.hostname, "api--gamma");
console.log("6 ok: portal upsert + hostname lookup");

// --- volumes: upsert per (cube, purpose)
registry.addVolume({ cubeId: c.id, purpose: "docker", poolVolume: "cube/cube-gamma-docker", capBytes: 5 * 2 ** 30 });
registry.addVolume({ cubeId: c.id, purpose: "docker", poolVolume: "cube/cube-gamma-docker", capBytes: 6 * 2 ** 30 });
const volumes = registry.listVolumes(c.id);
assert.equal(volumes.length, 1);
assert.equal(volumes[0]!.capBytes, 6 * 2 ** 30);
console.log("7 ok: volume upsert");

// --- cascade delete
registry.deleteCube("gamma");
assert.equal(registry.getThread("t1"), null);
assert.equal(registry.listVolumes(c.id).length, 0);
assert.equal(registry.listPortals(c.id).length, 0);
assert.equal(registry.listCubeRepositories(c.id).length, 0);
registry.deleteProject(project.id);
assert.equal(registry.getProject(project.id), null);
console.log("8 ok: cascade delete");

registry.close();

// --- phase-2 DB migration: old host_port portal schema is dropped clean
{
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cube-registry-test-")), "cubed.db");
  const old = new DatabaseSync(dbFile);
  old.exec(`
    CREATE TABLE cube (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
      error TEXT, image TEXT NOT NULL, workspace_path TEXT NOT NULL,
      subnet_index INTEGER NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL);
    INSERT INTO cube VALUES (1, 'old', 'ready', NULL, 'cube-node', '/w', 10, 1, 1);
    CREATE TABLE portal (id INTEGER PRIMARY KEY, cube_id INTEGER NOT NULL, name TEXT NOT NULL,
      target_port INTEGER NOT NULL, host_port INTEGER NOT NULL UNIQUE, created_at INTEGER NOT NULL,
      UNIQUE(cube_id, name));
    INSERT INTO portal VALUES (1, 1, 'web', 3000, 20000, 1);
  `);
  old.close();
  const migrated = new Registry(dbFile);
  assert.deepEqual(migrated.listPortals(1), []); // pre-proxy rows are meaningless
  const row = migrated.upsertPortal(1, "web", 3000, "web--old");
  assert.equal(row.hostname, "web--old");
  assert.equal(migrated.getPortalByHostname("web--old")!.targetPort, 3000);
  // Empty pre-project registries get the required thread.project_id schema.
  const inspected = new DatabaseSync(dbFile);
  const columns = inspected.prepare("PRAGMA table_info(thread)").all() as { name: string }[];
  inspected.close();
  assert.ok(columns.some((column) => column.name === "project_id"));
  assert.ok(columns.some((column) => column.name === "archived_at"));
  migrated.close();
  console.log("9 ok: host_port schema migrated (dropped + recreated)");
  console.log("10 ok: empty pre-project thread schema upgraded");
}

// A populated pre-project registry is never silently assigned to invented
// projects. Startup fails without modifying the old thread row.
{
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cube-registry-legacy-")), "cubed.db");
  const old = new DatabaseSync(dbFile);
  old.exec(`
    CREATE TABLE cube (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
      error TEXT, image TEXT NOT NULL, workspace_path TEXT NOT NULL,
      subnet_index INTEGER NOT NULL UNIQUE, created_at INTEGER NOT NULL, last_active_at INTEGER NOT NULL);
    INSERT INTO cube VALUES (1, 'old', 'ready', NULL, 'cube-node', '/w', 10, 1, 1);
    CREATE TABLE thread (id TEXT PRIMARY KEY, cube_id INTEGER NOT NULL, pi_session_path TEXT NOT NULL,
      title TEXT, created_at INTEGER NOT NULL);
    INSERT INTO thread VALUES ('legacy', 1, '/s/legacy.jsonl', NULL, 1);
  `);
  old.close();
  assert.throws(() => new Registry(dbFile), /pre-project threads/);
  console.log("11 ok: populated pre-project registry is rejected explicitly");
}
console.log("registry-test: all ok");
