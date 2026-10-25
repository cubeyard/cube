/** A failure's kind is data, and its stored words are the ones every cubed
 * version wrote (thread-failure.ts), offline: a row written by this version
 * reads the same in an older one, and a row an older version wrote is read
 * back with its kind (a release left unfinished is still retried). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Registry } from "../src/registry.ts";
import { allocationFailed, readFailure, releaseFailed, startFailed } from "../src/thread-failure.ts";
import { recoveryStep, releaseUnfinished } from "../src/thread-recovery.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-thread-failure-"));
try {
  assert.deepEqual(allocationFailed(new Error("boom")), { kind: "allocation", text: "workspace allocation failed: boom" });
  assert.deepEqual(releaseFailed("the runner did not answer"), { kind: "release", text: "workspace release failed: the runner did not answer" });
  assert.deepEqual(startFailed(new Error("ssh: the guest is unreachable")), { kind: "start", text: "ssh: the guest is unreachable" });
  for (const failure of [allocationFailed("boom"), releaseFailed("gone"), startFailed("lost")]) assert.deepEqual(readFailure(failure.text), failure, `${failure.kind} reads back`);
  assert.deepEqual(readFailure("workspace release failed"), { kind: "start", text: "workspace release failed" }, "only the exact prefix is a release");
  console.log("ok: each kind's words are the ones cubed always wrote, and read back to the same kind");

  const file = path.join(root, "registry.sqlite");
  const registry = new Registry(file);
  registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  registry.enrollRunner({ nodeId: "n", threadId: "r", environmentId: 1, configPath: "/private/r.json", configHash: "h", maxActiveVms: 4, protocol: 4, kind: "vm" } as never);
  const model = { provider: "faux", id: "faux" };
  const released = registry.createThread("p", "a", model, "a");
  registry.applyPhase(released.id, { type: "failed", failure: releaseFailed("the runner did not answer") });
  registry.applyPhase(released.id, { type: "tryFailed", failure: releaseFailed("the runner did not answer"), at: 10 });
  const allocated = registry.createThread("p", "b", model, "b");
  registry.applyPhase(allocated.id, { type: "failed", failure: allocationFailed("boom") });
  registry.close();

  // What an older cubed reads: the same JSON fields, the same words.
  const db = new DatabaseSync(file, { readOnly: true });
  const stored = (id: string) => JSON.parse((db.prepare("SELECT data FROM thread WHERE id = ?").get(id) as { data: string }).data) as Record<string, unknown>;
  assert.deepEqual([stored(released.id).workspaceState, stored(released.id).workspaceError, (stored(released.id).retry as { error: string }).error],
    ["failed", "workspace release failed: the runner did not answer", "workspace release failed: the runner did not answer"]);
  assert.deepEqual([stored(allocated.id).workspaceState, stored(allocated.id).workspaceError], ["failed", "workspace allocation failed: boom"]);
  assert.ok(!("failureKind" in stored(released.id)), "no new field in the row");
  db.close();
  console.log("ok: a row this version writes has the fields and words an older version reads");

  // A row an older version wrote: only words, read back with their kind.
  const older = { ...released, workspaceState: "failed" as const, workspaceError: "workspace release failed: runner n does not answer", retry: undefined };
  assert.equal(releaseUnfinished(older), true, "an older row's failed release is still unfinished");
  assert.equal(recoveryStep(older, { owned: false, demand: false, now: 0 }), "release", "and the recovery loop retries it");
  assert.equal(releaseUnfinished({ ...older, workspaceError: "workspace allocation failed: boom" }), false);
  console.log("ok: an older row's failed release is still retried; its failed allocation is not a release");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
