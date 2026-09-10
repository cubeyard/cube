/**
 * Offline unit test for EnvironmentTemplates: one build per (project, key)
 * shared by concurrent callers, a failed build leaves nothing behind, a new
 * key evicts the old template unless a clone is in progress, recovery and
 * pruning clean what a crash or an operator left, and a project takes its
 * template with it.
 *
 *   node packages/server/test/environment-templates-test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CubeTemplateSource } from "@cube/sandbox";

import { EnvironmentTemplates, environmentKey } from "../src/environment-templates.ts";
import { Registry } from "../src/registry.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-environment-templates-"));
const registry = new Registry(path.join(tmp, "cubed.db"));
const project = registry.createProject({ id: "p1", name: "one", repositories: [] });
const other = registry.createProject({ id: "p2", name: "two", repositories: [] });

const deleted: string[] = [];
const missing = new Set<string>();
const errors: string[] = [];
const backend = {
  async deleteTemplate(_pool: string, template: CubeTemplateSource) { deleted.push(template.instance); },
  async getState(name: string) { if (missing.has(name)) throw new Error("not found"); return { status: "Stopped" }; },
};
const templates = new EnvironmentTemplates(registry, backend, "pool", { onError: (context, error) => errors.push(`${context}: ${String(error)}`) });
const capture = (instance: string): CubeTemplateSource => ({ instance, snapshot: "env", volume: `${instance}-docker`, volumeSnapshot: "env" });

try {
  // --- 1. keys are content hashes; concurrent acquires share one build
  const key = environmentKey({ declaration: { setup: "#!/bin/sh\n" }, image: "img" });
  assert.equal(key, environmentKey({ declaration: { setup: "#!/bin/sh\n" }, image: "img" }));
  assert.notEqual(key, environmentKey({ declaration: { setup: "#!/bin/sh\necho x\n" }, image: "img" }));
  let builds = 0;
  let release!: (value: CubeTemplateSource) => void;
  const build = (instance: string) => { builds += 1; return new Promise<CubeTemplateSource>((resolve) => { release = (v) => resolve({ ...v, instance }); }); };
  const a = templates.acquire(project.id, key, build);
  const b = templates.acquire(project.id, key, build);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(builds, 1, "the second caller waits on the first build");
  assert.equal(registry.listEnvironmentTemplates(project.id)[0]!.status, "building");
  release(capture("cube-s-x"));
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.id, rb.id);
  assert.equal(ra.status, "ready");
  assert.match(ra.instance, /^cube-s-[0-9a-f]{8}$/);
  assert.equal(ra.volume, `${ra.instance}-docker`);
  const again = await templates.acquire(project.id, key, build);
  assert.equal(again.id, ra.id);
  assert.equal(builds, 1, "a ready template is served without a build");
  console.log("1 ok: one build per key, shared and then served");

  // --- 2. a new key builds a new template; the old one is evicted only when not leased
  const key2 = environmentKey({ declaration: { setup: "changed" } });
  const second = await templates.acquire(project.id, key2, async (instance) => capture(instance));
  assert.notEqual(second.id, ra.id);
  assert.deepEqual([...deleted], [], "the first template is leased by three acquires: kept");
  templates.release(ra.id); templates.release(ra.id); templates.release(ra.id);
  await templates.prune();
  assert.deepEqual([...deleted], [ra.instance], "released: the previous key's template goes at the next prune");
  assert.deepEqual(registry.listEnvironmentTemplates(project.id).map((row) => row.id), [second.id]);
  templates.release(second.id);
  const third = await templates.acquire(project.id, environmentKey({ declaration: "third" }), async (instance) => capture(instance));
  assert.deepEqual([...deleted], [ra.instance, second.instance], "unleased: evicted as soon as the new template is ready");
  templates.release(third.id);
  console.log("2 ok: one template per project; eviction respects leases");

  // --- 3. a failed build rejects every waiter and leaves no row
  const failing = (): Promise<CubeTemplateSource> => Promise.reject(new Error("setup exploded"));
  const failKey = environmentKey({ declaration: "fails" });
  await assert.rejects(Promise.all([
    templates.acquire(other.id, failKey, failing),
    templates.acquire(other.id, failKey, failing),
  ]), /setup exploded/);
  assert.deepEqual(registry.listEnvironmentTemplates(other.id), []);
  const recovered = await templates.acquire(other.id, failKey, async (instance) => capture(instance));
  assert.equal(recovered.status, "ready", "the next acquire tries again");
  templates.release(recovered.id);
  console.log("3 ok: a failed build leaves nothing and does not poison the key");

  // --- 4. recovery: `building` leftovers are removed, vanished instances forgotten
  const stale = registry.createEnvironmentTemplate({ id: "stale", projectId: other.id, key: "k-stale", status: "building", instance: "cube-s-stale", snapshot: "env", volume: "cube-s-stale-docker", volumeSnapshot: "env" });
  missing.add(recovered.instance);
  await templates.recover();
  assert.ok(deleted.includes(stale.instance), "an interrupted capture's instance is deleted");
  assert.equal(registry.getEnvironmentTemplate(stale.id), null);
  assert.equal(registry.getEnvironmentTemplate(recovered.id), null, "a template whose instance is gone is forgotten, not deleted again");
  assert.ok(!deleted.includes(recovered.instance));
  console.log("4 ok: boot recovery cleans building rows and forgets vanished instances");

  // --- 5. a project takes its template with it; a leased one refuses
  const leased = await templates.acquire(other.id, environmentKey({ declaration: "leased" }), async (instance) => capture(instance));
  await assert.rejects(templates.forgetProject(other.id), /still being prepared/);
  templates.release(leased.id);
  await templates.forgetProject(other.id);
  assert.deepEqual(registry.listEnvironmentTemplates(other.id), []);
  assert.ok(deleted.includes(leased.instance));
  registry.deleteProject(other.id);
  assert.deepEqual(errors, [], `no maintenance errors expected: ${errors.join("; ")}`);
  console.log("5 ok: forgetProject deletes the template first");

  // --- 6. a failing delete keeps the row for the next prune and reports it
  const keep = await templates.acquire(project.id, environmentKey({ declaration: "keep" }), async (instance) => capture(instance));
  templates.release(keep.id);
  backend.deleteTemplate = async () => { throw new Error("incus busy"); };
  const next = await templates.acquire(project.id, environmentKey({ declaration: "next" }), async (instance) => capture(instance));
  templates.release(next.id);
  assert.equal(registry.getEnvironmentTemplate(keep.id)?.status, "ready", "a template the backend could not delete stays known");
  assert.match(errors.at(-1) ?? "", /evict template .*incus busy/);
  backend.deleteTemplate = async (_pool, template) => { deleted.push(template.instance); };
  await templates.prune();
  assert.equal(registry.getEnvironmentTemplate(keep.id), null);
  assert.deepEqual(registry.listEnvironmentTemplates(project.id).map((row) => row.id), [next.id]);
  console.log("6 ok: cleanup failures are retried by prune, never leaked silently");

  // --- 7. two keys building at once (the declaration changed mid-build) never
  // evict each other; the older one goes at the next prune
  {
    let finishA!: (v: CubeTemplateSource) => void;
    const slowA = (instance: string) => new Promise<CubeTemplateSource>((resolve) => { finishA = (v) => resolve({ ...v, instance }); });
    const before = deleted.length;
    const a = templates.acquire(project.id, environmentKey({ declaration: "A" }), slowA);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const b = await templates.acquire(project.id, environmentKey({ declaration: "B" }), async (instance) => capture(instance));
    assert.equal(registry.listEnvironmentTemplates(project.id).filter((row) => row.status === "building").length, 1, "A is still building");
    assert.equal(deleted.length - before, 1, "B evicted only the finished template from step 6, not the build in flight");
    finishA(capture("x"));
    const ra = await a;
    assert.equal(ra.status, "ready");
    assert.equal(registry.getEnvironmentTemplate(b.id)?.status, "ready", "A finishing later does not evict the newer B");
    templates.release(ra.id); templates.release(b.id);
    await templates.prune();
    assert.deepEqual(registry.listEnvironmentTemplates(project.id).map((row) => row.id), [b.id], "prune keeps the newest");
    assert.ok(deleted.includes(ra.instance));
    console.log("7 ok: concurrent builds of different keys leave each other alone; prune settles them");
  }

  console.log("environment-templates-test: all ok");
} finally {
  registry.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
