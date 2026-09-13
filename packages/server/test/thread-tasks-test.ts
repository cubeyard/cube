import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Registry } from "../src/registry.ts";
import { ThreadTaskJournal } from "../src/thread-tasks.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "thread-tasks-"));
const dbPath = path.join(root, "registry.db");
let registry: Registry | undefined;
let db: DatabaseSync | undefined;
try {
  registry = new Registry(dbPath);
  for (const id of ["project", "other"]) {
    registry.createProject({ id, name: id, repositories: [{ id: `${id}-repo`, url: "https://example.com/repo.git", base: null, checkoutName: "workspace" }] });
  }
  for (const name of ["source", "target", "third", "foreign"]) {
    const cube = registry.createCube({ name, image: "test", workspacePath: path.join(root, name) });
    registry.addThread({ id: name, cubeId: cube.id, projectId: name === "foreign" ? "other" : "project", piSessionPath: path.join(root, `${name}.jsonl`) });
  }
  db = new DatabaseSync(dbPath);
  let journal = new ThreadTaskJournal(db);
  assert.equal(db.prepare("PRAGMA synchronous").get()!.synchronous, 2);
  assert.throws(() => journal.accept("source", "target", "key", "task"), /not permitted/);
  assert.throws(() => journal.grant("source", "source"), /not permitted/);
  assert.throws(() => journal.grant("source", "foreign"), /not permitted/);
  assert.throws(() => journal.grant("source", "missing"), /unavailable/);
  journal.grant("source", "target");
  journal.grant("source", "target");
  assert.throws(() => journal.accept("target", "source", "reverse", "task"), /not permitted/);
  assert.throws(() => journal.accept("source", "third", "third", "task"), /not permitted/);
  for (const body of ["", " ", "a".repeat(16_385), "é".repeat(8193), "\ud800"]) {
    assert.throws(() => journal.accept("source", "target", "invalid", body), /invalid/);
  }
  const task = journal.accept("source", "target", "key", "edit a file and report the test result");
  assert.equal(task.state, "accepted");
  assert.deepEqual(journal.accept("source", "target", "key", task.body), task);
  assert.throws(() => journal.accept("source", "target", "key", "changed"), /conflict/);
  assert.throws(() => journal.accept("source", "third", "key", task.body), /conflict/);
  assert.throws(() => journal.get("third", task.id), /not found/);
  assert.throws(() => journal.acknowledge("source", task.id), /recipient/);
  assert.throws(() => journal.acknowledge("target", task.id), /not started/);
  assert.throws(() => journal.complete("target", task.id, "done"), /not acknowledged/);
  assert.throws(() => journal.beginDelivery("source", task.id), /recipient/);

  // Two control-plane connections share the durable delivery reservation.
  const second = new DatabaseSync(dbPath);
  try {
    const competitor = new ThreadTaskJournal(second);
    assert.equal(journal.beginDelivery("target", task.id)!.state, "delivery_unknown");
    assert.equal(competitor.beginDelivery("target", task.id), null);
  } finally { second.close(); }
  // Crash cutpoint: reserved but no proof Pi received it. Restart does not reset.
  db.close();
  db = new DatabaseSync(dbPath);
  journal = new ThreadTaskJournal(db);
  assert.equal(journal.get("source", task.id).state, "delivery_unknown");
  assert.equal(journal.beginDelivery("target", task.id), null);
  assert.equal(journal.accept("source", "target", "key", task.body).id, task.id);
  assert.equal(journal.acknowledge("target", task.id).state, "delivered");
  assert.equal(journal.acknowledge("target", task.id).state, "delivered");
  assert.equal(journal.beginDelivery("target", task.id), null);

  const pending = journal.accept("source", "target", "pending", "another task");
  journal.revoke("source", "target");
  assert.throws(() => journal.beginDelivery("target", pending.id), /not permitted/);
  assert.equal(journal.get("source", pending.id).state, "accepted");
  assert.throws(() => journal.accept("source", "target", "new", "task"), /not permitted/);
  assert.equal(journal.accept("source", "target", "pending", pending.body).id, pending.id);
  // Revocation/archive stop dispatch, not read-only recovery or in-flight results.
  journal.grant("source", "target");
  registry.archiveThread("target");
  assert.throws(() => journal.beginDelivery("target", pending.id), /unavailable/);
  assert.throws(() => journal.grant("source", "target"), /unavailable/);
  assert.throws(() => journal.complete("source", task.id, "done"), /recipient/);
  assert.equal(journal.complete("target", task.id, "test passed; operation op-1").state, "completed");
  assert.equal(journal.complete("target", task.id, "test passed; operation op-1").state, "completed");
  assert.throws(() => journal.complete("target", task.id, "different"), /conflict/);
  assert.equal(journal.acknowledge("target", task.id).state, "completed");
  assert.equal(journal.get("source", task.id).result, "test passed; operation op-1");
  assert.throws(() => registry!.deleteCube("source"), /FOREIGN KEY/);
  assert.ok(registry.getThread("source"));

  db.close();
  db = new DatabaseSync(dbPath);
  journal = new ThreadTaskJournal(db);
  assert.equal(journal.get("source", task.id).state, "completed");
  assert.equal(journal.beginDelivery("target", task.id), null);
  assert.equal(journal.get("source", pending.id).state, "accepted");
  assert.throws(() => journal.complete("target", task.id, "é".repeat(8193)), /invalid/);
  assert.throws(() => journal.get("third", task.id), /not found/);

  // Retention is a hard bound, not an eviction window for idempotency keys.
  journal.grant("source", "third");
  db.exec("BEGIN IMMEDIATE");
  const fill = db.prepare("INSERT INTO thread_task VALUES (?, 'source', 'third', ?, 'fixture', 'accepted', NULL, 1)");
  for (let n = 0; n < 9998; n++) fill.run(`fixture-${n}`, `fixture-${n}`);
  db.exec("COMMIT");
  assert.throws(() => journal.accept("source", "third", "over-cap", "task"), /journal full/);
  assert.equal(journal.accept("source", "target", "key", task.body).id, task.id);
  assert.equal(db.prepare("SELECT count(*) AS n FROM thread_task").get()!.n, 10_000);
  console.log("ok: durable thread tasks, directed authorization, bounded fields, no replay, late results and restart recovery");
} finally {
  db?.close();
  registry?.close();
  fs.rmSync(root, { recursive: true, force: true });
}
