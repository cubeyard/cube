/**
 * Offline test: environment resources that boot could not clean up —
 * builders whose teardown failed, cache publications that never resolved
 * — are retried by the supervisor's periodic maintenance, recorded as
 * events, and stop the cache admitting new builds past a limit (the
 * thread then sets up fresh instead of adding to the pile).
 *
 *   node packages/server/test/environment-maintenance-test.ts
 */
process.env.CUBED_ALLOW_LOCAL_REPOS = "1";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MockBackend, type CubeProvisionSpec, type DestroySpec } from "@cube/sandbox";

import { Registry } from "../src/registry.ts";
import { CubeSupervisor, type SupervisorConfig } from "../src/supervisor.ts";

class FlakyBackend extends MockBackend {
  builders = 0;
  failBuilderCleanup = false;
  reconcileAvailable = false;
  override async provision(spec: CubeProvisionSpec): Promise<void> {
    if (spec.name.startsWith("cube-s-")) this.builders++;
    await super.provision(spec);
  }
  override async destroy(spec: DestroySpec): Promise<void> {
    if (this.failBuilderCleanup && spec.name.startsWith("cube-s-")) throw new Error("incus: instance is busy");
    await super.destroy(spec);
  }
  /** The mock has no publication reconciliation; a stand-in that can be
   * switched on stands for Incus becoming reachable again. */
  async reconcileEnvironment(alias: string): Promise<string> {
    if (!this.reconcileAvailable) throw new Error("incus unreachable");
    return `mock-environment:${alias}:reconciled`;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-environment-maintenance-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const author = ["-c", "user.name=test", "-c", "user.email=test@cube", "-c", "commit.gpgSign=false"];
const bare = path.join(tmp, "repo.git"), seed = path.join(tmp, "repo-seed");
git(tmp, "init", "--bare", "-b", "main", bare);
git(tmp, "clone", bare, seed);
fs.mkdirSync(path.join(seed, ".cube"));
fs.writeFileSync(path.join(seed, ".cube", "setup"), "#!/bin/sh\necho setup-ran > generated\necho setup-output\n", { mode: 0o755 });
fs.writeFileSync(path.join(seed, "tracked"), "revision-1\n");
git(seed, ...author, "add", "-A"); git(seed, ...author, "commit", "-m", "initial"); git(seed, "push", "origin", "main");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The maintenance passes themselves (span ends), newest first. */
const passesRecorded = () => registry.listEvents({ kind: "environment" }).filter((e) => e.phase === null);
async function until(what: string, test: () => boolean, ms = 10_000): Promise<void> {
  for (const deadline = Date.now() + ms; !test(); ) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const cubesRoot = path.join(tmp, "cubes");
const registry = new Registry(path.join(tmp, "cubed.db"));
const backend = new FlakyBackend();
const config: SupervisorConfig = {
  cubesRoot, reposRoot: path.join(tmp, "mirrors"), pool: "mock", image: "mock",
  rootSize: "1MiB", dockerVolumeSize: "1MiB", egressAllow: [], idleMs: 0,
  portalBase: "cube.localhost", publicPort: 7777, environmentCacheBytes: 100 * 1024 * 1024,
};
const supervisor = new CubeSupervisor(registry, backend, config);

async function advance(marker: string): Promise<void> {
  fs.writeFileSync(path.join(seed, "tracked"), `${marker}\n`);
  git(seed, ...author, "commit", "-am", marker); git(seed, "push", "origin", "main");
  supervisor.updateProject(project.id, { name: "maintained", repositories: [{ url: bare }] });
  await until("project re-check", () => supervisor.getProject(project.id).status !== "checking");
  assert.equal(supervisor.getProject(project.id).status, "ready");
}

async function startThread(): Promise<string> {
  const { id } = await supervisor.createUserThread(project.id);
  const cubeName = supervisor.resolveUserThread(id).cubeName;
  await until(`thread ${id} to settle`, () => registry.getCube(cubeName)!.status !== "creating");
  assert.equal(registry.getCube(cubeName)!.status, "ready", registry.getCube(cubeName)!.error ?? "");
  return id;
}

const project = supervisor.createProject({ name: "maintained", repositories: [{ url: bare }] });
await until("project check", () => supervisor.getProject(project.id).status !== "checking");
assert.equal(supervisor.getProject(project.id).status, "ready");
await supervisor.boot();

try {
  // --------------------------- 1. a builder whose cleanup failed is retried
  backend.failBuilderCleanup = true;
  const first = await startThread();
  assert.equal(backend.builders, 1);
  const pending = registry.listCubes().filter((c) => c.status === "building-environment");
  assert.equal(pending.length, 1, "the builder row is kept as a quarantine");
  assert.match(pending[0]!.error ?? "", /^cleanup pending: .*instance is busy/);
  assert.equal(supervisor.listCubes().some((c) => c.name === pending[0]!.name), false, "hidden from the plumbing list");
  assert.equal(supervisor.listUserThreads().length, 1, "and from the product");
  const failed = registry.listEvents({ kind: "environment", cube: pending[0]!.name });
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.phase, "builder-cleanup");
  assert.equal(failed[0]!.ok, false);
  assert.equal(supervisor.environmentForUserThread(first).setup.cached, true, "the thread still restored the snapshot");

  // Still failing: the pass records that it is pending, and the row stays.
  await supervisor.maintainEnvironments();
  assert.equal(registry.getCube(pending[0]!.name)?.status, "building-environment");
  let passes = passesRecorded();
  assert.equal(passes.length, 1);
  assert.equal(passes[0]!.ok, false);
  assert.match(passes[0]!.detail ?? "", /1 builder cleanup\(s\) retried, 1 still pending/);

  // Pending builders are unresolved resources too: past the limit no new
  // build is admitted, and the thread sets up fresh instead of adding a
  // fifth stuck instance/volume/tree/subnet to the pile.
  for (const revision of ["revision-1b", "revision-1c", "revision-1d"]) {
    await advance(revision);
    await startThread();
  }
  assert.equal(backend.builders, 4);
  assert.equal(registry.listCubes().filter((c) => c.status === "building-environment").length, 4, "four builders await cleanup");
  await advance("revision-1e");
  const refused = await startThread();
  assert.equal(backend.builders, 4, "no fifth build was admitted");
  const refusedEvent = registry.listEvents({ kind: "environment" }).find((e) => e.phase === "suspended")!;
  assert.equal(refusedEvent.thread, refused);
  assert.match(refusedEvent.detail ?? "", /4 unresolved entries/);
  assert.notEqual(supervisor.environmentForUserThread(refused).setup.cached, true, "set up fresh");

  backend.failBuilderCleanup = false;
  await supervisor.maintainEnvironments();
  assert.equal(registry.getCube(pending[0]!.name), null, "the builder row is gone");
  assert.equal(fs.existsSync(path.join(cubesRoot, pending[0]!.name)), false, "and its host tree");
  assert.equal(registry.listCubes().filter((c) => c.status === "building-environment").length, 0, "all four were retried in one batch");
  passes = passesRecorded();
  assert.equal(passes.length, 2);
  assert.equal(passes[0]!.ok, true);
  assert.match(passes[0]!.detail ?? "", /4 builder cleanup\(s\) retried, 0 still pending; 0 cache entries unresolved/);
  await advance("revision-1f");
  await startThread();
  assert.equal(backend.builders, 5, "builds are admitted again once the builders are gone");
  console.log("1 ok: a failed builder cleanup is quarantined, recorded, counted against admission, and retried by maintenance");

  // --------------- 2. unresolved publications are counted, retried, capped
  const environments = path.join(cubesRoot, ".environments");
  for (const digit of ["1", "2", "3", "4"]) {
    const key = digit.repeat(64);
    fs.mkdirSync(path.join(environments, key), { recursive: true });
    fs.writeFileSync(path.join(environments, key, "publication.json"), "{}");
  }
  await supervisor.maintainEnvironments();
  const unresolved = registry.listEvents({ kind: "environment" }).filter((e) => e.phase === "maintenance");
  assert.equal(unresolved.length, 4, "each failed reconciliation is an event");
  assert.ok(unresolved.every((e) => !e.ok && /incus unreachable/.test(e.detail ?? "")));
  assert.match(passesRecorded()[0]!.detail ?? "", /4 cache entries unresolved/);

  // A new revision would need a new build: refused, fresh setup instead.
  await advance("revision-2");
  const fresh = await startThread();
  assert.equal(backend.builders, 5, "no build was admitted");
  const suspended = registry.listEvents({ kind: "environment" }).filter((e) => e.phase === "suspended" && e.thread === fresh);
  assert.equal(suspended.length, 1);
  assert.equal(suspended[0]!.ok, false);
  assert.match(suspended[0]!.detail ?? "", /fresh setup instead: environment cache suspended: 4 unresolved/);
  const environment = supervisor.environmentForUserThread(fresh);
  assert.equal(environment.setup.state, "succeeded");
  assert.notEqual(environment.setup.cached, true, "setup ran in the thread itself");
  assert.match(environment.setup.log, /setup-output/);
  const freshCube = registry.getCube(supervisor.resolveUserThread(fresh).cubeName)!;
  assert.equal(fs.readFileSync(path.join(freshCube.workspacePath, "generated"), "utf8"), "setup-ran\n");
  console.log("2 ok: unresolved publications are recorded, and past the limit new builds fall back to fresh setup");

  // ---------------------------- 3. once cleanup works again, builds resume
  backend.reconcileAvailable = true;
  await supervisor.maintainEnvironments();
  assert.deepEqual(fs.readdirSync(environments).filter((name) => /^[1-4]{64}$/.test(name)), []);
  assert.match(passesRecorded()[0]!.detail ?? "", /0 cache entries unresolved/);
  await advance("revision-3");
  await startThread();
  assert.equal(backend.builders, 6, "a build is admitted again");
  console.log("3 ok: maintenance clears the quarantine and builds are admitted again");

  console.log("ALL PASS: environment maintenance");
} finally {
  await supervisor.close();
  registry.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
