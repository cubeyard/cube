/** Placement with a host runner (berth host, protocol 4) and a protocol-3
 * runner (retired): neither is ever in the pool (only a berth vm is), a
 * thread gets onto a host runner only by naming it and never onto a
 * protocol-3 runner, and a full pool never falls back to either. Registry
 * only; offline. */
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
  assert.throws(() => registry.createThread("project", "unnamed", model, "x"), /no berth vm runner in the global runner pool/,
    "a thread that names no runner never lands on a host runner");

  const pinned = registry.createThread("project", "named", model, "x", "pi", { runnerId: "node-mac" });
  assert.equal(pinned.runnerId, "node-mac");
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.vm?.placement, "provisional");

  // A protocol-3 runner with free slots: not the pool, and not even by name.
  registry.enrollRunner({ nodeId: "node-p3", environmentId: 3, threadId: "runner-p3", configPath: "/private/p3.json", configHash: "p3", maxActiveVms: 3 });
  assert.deepEqual(registry.runnerSlots(), { free: 0, total: 0, runners: 0 }, "a protocol-3 runner adds nothing to the pool");
  assert.throws(() => registry.createThread("project", "unnamed-p3", model, "x"), /no berth vm runner in the global runner pool: start the thread on a berth host by name/,
    "a thread that names no runner never lands on a protocol-3 runner");
  assert.throws(() => registry.createThread("project", "named-p3", model, "x", "pi", { runnerId: registry.namedRunnerId("node-p3") }),
    /runner node-p3 uses protocol 3 \(cube-runner\), which cube no longer runs; start the thread on a berth runner/);

  registry.enrollRunner({ nodeId: "node-pool", environmentId: 2, threadId: "runner-pool", configPath: "/private/pool.json", configHash: "pool", maxActiveVms: 3,
    protocol: 4, kind: "vm" });
  const pooled = registry.createThread("project", "pooled", model, "x");
  assert.equal(pooled.runnerId, "runner-pool", "the berth vm is the pool");
  assert.equal(pooled.pinned, undefined);
  assert.equal(registry.getThread(pinned.id)!.runnerId, "node-mac");

  registry.createThread("project", "named-2", model, "x", "pi", { runnerId: "node-mac" });
  const named3 = registry.createThread("project", "named-3", model, "x", "pi", { runnerId: "node-mac" });
  assert.deepEqual([named3.runnerId, named3.pinned, named3.vm?.suspension?.state], ["node-mac", true, "queued"], "a full named runner queues the thread on it, pinned");
  assert.throws(() => registry.createThread("project", "nobody", model, "x", "pi", { runnerId: "node-nobody" }), /no enrolled runner node-nobody/);
  assert.throws(() => registry.namedRunnerId("node-nobody"), /no runner node-nobody; runners lists them/);
  // The berth vm full: the pool queues, though the p3 and host runners have free slots.
  for (const name of ["pooled-2", "pooled-3"]) registry.createThread("project", name, model, "x");
  const pooled4 = registry.createThread("project", "pooled-4", model, "x");
  assert.deepEqual([pooled4.runnerId, pooled4.vm?.suspension?.state], ["runner-pool", "queued"], "a full pool queues on its berth vm: never a protocol-3 or host runner");
  assert.equal(registry.listThreads().filter(thread => thread.runnerId === "runner-p3").length, 0, "nothing was placed on the protocol-3 runner");
  // A replayed request finds its thread, wherever it was named to.
  assert.equal(registry.createThread("project", "named", model, "x", "pi", { runnerId: "node-mac" }).id, pinned.id);
  console.log("ok: host and protocol-3 runners stay out of the pool, threads reach a host runner only by name and a protocol-3 runner never, a full berth vm pool or named runner queues");
} finally { registry.close(); fs.rmSync(root, { recursive: true, force: true }); }
