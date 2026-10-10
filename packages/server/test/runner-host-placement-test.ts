/** Placement with a host runner (berth host, protocol 4): it is never
 * in the pool, a thread gets there only by naming it, and a thread started
 * on a runner by name never moves. Registry only; offline. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Registry } from "../src/registry.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-host-placement-"));
const registry = new Registry(path.join(root, "registry.sqlite"));
try {
  registry.saveProject({ id: "project", name: "test", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  const model = { provider: "fixture", id: "selected" };
  registry.enrollRunner({ nodeId: "node-mac", environmentId: 1, threadId: "node-mac", configPath: "/private/mac.json", configHash: "mac",
    maxActiveVms: 2, protocol: 4, kind: "host" });
  assert.deepEqual(registry.runnerSlots(), { free: 0, total: 0, runners: 0 }, "a host runner adds nothing to the pool");
  assert.throws(() => registry.createThread("project", "unnamed", model, "x"), /no free thread machine in the global runner pool/,
    "a thread that names no runner never lands on a host runner");

  const pinned = registry.createThread("project", "named", model, "x", "pi", undefined, { runnerId: "node-mac" });
  assert.equal(pinned.runnerId, "node-mac");
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.vm?.placement, "provisional");

  registry.enrollRunner({ nodeId: "node-pool", environmentId: 2, threadId: "runner-pool", configPath: "/private/pool.json", configHash: "pool", maxActiveVms: 3 });
  const pooled = registry.createThread("project", "pooled", model, "x");
  assert.equal(pooled.runnerId, "runner-pool");
  assert.equal(pooled.pinned, undefined);
  assert.equal(registry.relocateThread(pinned.id), null, "a pinned thread never moves, even while provisional");
  assert.equal(registry.getThread(pinned.id)!.runnerId, "node-mac");

  registry.createThread("project", "named-2", model, "x", "pi", undefined, { runnerId: "node-mac" });
  assert.throws(() => registry.createThread("project", "named-3", model, "x", "pi", undefined, { runnerId: "node-mac" }),
    /runner node-mac has no free thread machine \(2 of 2 in use\)/);
  assert.throws(() => registry.createThread("project", "nobody", model, "x", "pi", undefined, { runnerId: "node-nobody" }), /no enrolled runner node-nobody/);
  // A replayed request finds its thread, wherever it was named to.
  assert.equal(registry.createThread("project", "named", model, "x", "pi", undefined, { runnerId: "node-mac" }).id, pinned.id);
  console.log("ok: host runners stay out of the pool, threads reach them only by name, pinned threads never move, named capacity");
} finally { registry.close(); fs.rmSync(root, { recursive: true, force: true }); }
