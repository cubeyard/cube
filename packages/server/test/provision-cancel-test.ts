/**
 * Offline test: deleting a thread that is still setting up cancels the
 * provision instead of being refused for the whole setup window. The mock
 * backend runs `.cube/setup` locally, so a script that sleeps stands in for
 * a twenty-minute dependency install.
 *
 *   node packages/server/test/provision-cancel-test.ts
 */
process.env.CUBED_ALLOW_LOCAL_REPOS = "1";

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MockBackend, type CubeProvisionSpec, type DestroySpec } from "@cube/sandbox";

import { Registry } from "../src/registry.ts";
import { CubeSupervisor, type ProjectInfo, type SupervisorConfig } from "../src/supervisor.ts";

class RecordingBackend extends MockBackend {
  destroyed: string[] = [];
  builders = 0;
  /** While set, publication reconciliation (cache maintenance) blocks on it. */
  reconcileGate: Promise<void> | null = null;
  override async provision(spec: CubeProvisionSpec): Promise<void> {
    if (spec.name.startsWith("cube-s-")) this.builders++;
    await super.provision(spec);
  }
  override async destroy(spec: DestroySpec): Promise<void> {
    this.destroyed.push(spec.name);
    await super.destroy(spec);
  }
  async reconcileEnvironment(alias: string): Promise<string> {
    if (this.reconcileGate) await this.reconcileGate;
    return `mock-environment:${alias}:reconciled`;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-provision-cancel-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const author = ["-c", "user.name=test", "-c", "user.email=test@cube", "-c", "commit.gpgSign=false"];

function repository(name: string, setup: string): string {
  const bare = path.join(tmp, `${name}.git`);
  const seed = path.join(tmp, `${name}-seed`);
  git(tmp, "init", "--bare", "-b", "main", bare);
  git(tmp, "clone", bare, seed);
  fs.mkdirSync(path.join(seed, ".cube"));
  fs.writeFileSync(path.join(seed, ".cube", "setup"), setup, { mode: 0o755 });
  fs.writeFileSync(path.join(seed, "README.md"), "cancel\n");
  git(seed, ...author, "add", "-A");
  git(seed, ...author, "commit", "-m", "initial");
  git(seed, "push", "origin", "main");
  return bare;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, test: () => boolean, ms = 10_000): Promise<void> {
  for (const deadline = Date.now() + ms; !test(); ) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

async function readyProject(supervisor: CubeSupervisor, id: string): Promise<ProjectInfo> {
  await until("project check", () => supervisor.getProject(id).status !== "checking");
  const project = supervisor.getProject(id);
  assert.equal(project.status, "ready", project.error ?? "project should be ready");
  return project;
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const config = (cubesRoot: string, environmentCacheBytes = 0): SupervisorConfig => ({
  cubesRoot,
  reposRoot: path.join(tmp, "mirrors"),
  pool: "mock",
  image: "mock",
  rootSize: "1MiB",
  dockerVolumeSize: "1MiB",
  egressAllow: [],
  idleMs: 0,
  portalBase: "cube.localhost",
  publicPort: 7777,
  environmentCacheBytes,
});

// The script records its pid so the test can prove the guest process died
// with the thread, then sleeps far longer than any test may take. The
// `slow` marker lets the same script run instantly on the first provision
// and slowly on an explicit retry.
const slowSetup = "#!/bin/sh\necho $$ > setup.pid\nif [ -f slow ] || [ ! -f fast ]; then sleep 30; fi\n";

try {
  // ------------------------------------------------- 1. delete mid-setup
  {
    const registry = new Registry(path.join(tmp, "one.db"));
    const backend = new RecordingBackend();
    const supervisor = new CubeSupervisor(registry, backend, config(path.join(tmp, "one-cubes")));
    const project = supervisor.createProject({ name: "slow", repositories: [{ url: repository("slow", slowSetup) }] });
    await readyProject(supervisor, project.id);

    const { id } = await supervisor.createUserThread(project.id);
    const cubeName = supervisor.resolveUserThread(id).cubeName;
    const cube = registry.getCube(cubeName)!;
    const pidFile = path.join(cube.workspacePath, "setup.pid");
    await until("setup to start", () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "");
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    assert.ok(alive(pid), "the setup script is running");
    assert.equal(supervisor.listUserThreads()[0]!.state, "setting-up");

    const started = Date.now();
    await supervisor.removeUserThread(id);
    const took = Date.now() - started;
    assert.ok(took < 2_000, `delete during setup returned in ${took} ms`);
    assert.equal(registry.getCube(cubeName), null, "the row is gone");
    assert.equal(supervisor.listUserThreads().length, 0);
    assert.ok(backend.destroyed.includes(`cube-${cubeName}`), "the instance was destroyed");
    assert.equal(fs.existsSync(path.dirname(cube.workspacePath)), false, "the host tree is gone");
    await until("the setup script to die", () => !alive(pid), 6_000);

    const provision = registry.listEvents({ kind: "provision", cube: cubeName });
    const end = provision.find((e) => e.phase === null)!;
    assert.equal(end.ok, false);
    assert.equal(end.detail, "cancelled: thread deleted");
    assert.equal(end.thread, id, "the cancelled provision keeps its thread id");
    const setupPhase = provision.find((e) => e.phase === "setup");
    assert.ok(setupPhase && !setupPhase.ok && /cancelled: thread deleted/.test(setupPhase.detail ?? ""), "the setup phase records the cancellation");
    const destroy = registry.listEvents({ kind: "destroy", cube: cubeName });
    assert.equal(destroy.length, 1);
    assert.equal(destroy[0]!.ok, true);
    assert.equal(destroy[0]!.thread, id);
    await assert.rejects(supervisor.removeUserThread(id), /no such thread/);
    console.log("1 ok: deleting a thread mid-setup cancels the script, tears down and records it");

    // ------------------------------------------ 2. delete during a retry
    fs.writeFileSync(path.join(tmp, "slow-seed", "fast"), "");
    git(path.join(tmp, "slow-seed"), ...author, "add", "-A");
    git(path.join(tmp, "slow-seed"), ...author, "commit", "-m", "fast");
    git(path.join(tmp, "slow-seed"), "push", "origin", "main");
    supervisor.updateProject(project.id, { name: "slow", repositories: [{ url: path.join(tmp, "slow.git") }] });
    await readyProject(supervisor, project.id);
    const second = await supervisor.createUserThread(project.id);
    const secondCube = supervisor.resolveUserThread(second.id).cubeName;
    await until("second thread ready", () => registry.getCube(secondCube)?.status === "ready");
    fs.writeFileSync(path.join(registry.getCube(secondCube)!.workspacePath, "slow"), "");
    const retry = supervisor.retrySetupForUserThread(second.id);
    retry.catch(() => {});
    await until("retry setup to start", () => registry.getCube(secondCube)?.status === "creating");
    await sleep(100);
    const retryStart = Date.now();
    await supervisor.removeUserThread(second.id);
    assert.ok(Date.now() - retryStart < 2_000, "delete during a setup retry returns promptly");
    await assert.rejects(retry, /thread deleted/);
    assert.equal(registry.getCube(secondCube), null);
    console.log("2 ok: a setup retry is cancelled by delete too");

    await supervisor.close();
    registry.close();
  }

  // ------------------------- 3. a shared environment build is not cancelled
  {
    const registry = new Registry(path.join(tmp, "two.db"));
    const backend = new RecordingBackend();
    const supervisor = new CubeSupervisor(registry, backend, config(path.join(tmp, "two-cubes"), 100 * 1024 * 1024));
    const bare = repository("shared", "#!/bin/sh\nsleep 1\necho built > generated\n");
    const project = supervisor.createProject({ name: "shared", repositories: [{ url: bare }] });
    await readyProject(supervisor, project.id);

    const { id } = await supervisor.createUserThread(project.id);
    const cubeName = supervisor.resolveUserThread(id).cubeName;
    await until("the builder to start", () => backend.builders === 1);
    const builder = registry.listCubes().find((c) => c.status === "building-environment");
    assert.ok(builder, "a builder cube exists while the environment is prepared");
    const started = Date.now();
    await supervisor.removeUserThread(id);
    assert.ok(Date.now() - started < 2_000, "delete while waiting on a shared build returns promptly");
    assert.equal(registry.getCube(cubeName), null);
    assert.ok(!backend.destroyed.includes(`cube-${builder.name}`), "the builder was not torn down by the thread's delete");
    // The build runs on and publishes: the next thread restores it.
    await until("the builder to finish", () => registry.getCube(builder.name) === null, 10_000);
    const cached = await supervisor.createUserThread(project.id);
    const cachedCube = supervisor.resolveUserThread(cached.id).cubeName;
    await until("cached thread ready", () => registry.getCube(cachedCube)?.status === "ready");
    assert.equal(backend.builders, 1, "no second build");
    assert.equal(fs.readFileSync(path.join(registry.getCube(cachedCube)!.workspacePath, "generated"), "utf8"), "built\n");
    assert.equal(supervisor.environmentForUserThread(cached.id).setup.cached, true);
    await supervisor.removeUserThread(cached.id);
    console.log("3 ok: a thread deleted while waiting on a shared build leaves the build to finish");

    // ---- 4. a delete while the cache still waits on maintenance cannot
    // poison the build: the abandoned wait later runs the build with the
    // repository snapshot taken before, not with the deleted thread's rows.
    const second = repository("second", "#!/bin/sh\nsleep 1\necho built-late > generated\n");
    const late = supervisor.createProject({ name: "second", repositories: [{ url: second }] });
    await readyProject(supervisor, late.id);
    // Maintenance holds the cache: a quarantined publication whose
    // reconciliation blocks until the test releases it.
    const stuck = "9".repeat(64);
    fs.mkdirSync(path.join(tmp, "two-cubes", ".environments", stuck), { recursive: true });
    fs.writeFileSync(path.join(tmp, "two-cubes", ".environments", stuck, "publication.json"), "{}");
    let release!: () => void;
    backend.reconcileGate = new Promise<void>((resolve) => { release = resolve; });
    const pass = supervisor.maintainEnvironments();
    const waiting = await supervisor.createUserThread(late.id);
    const waitingCube = supervisor.resolveUserThread(waiting.id).cubeName;
    // Seeded, and now inside use() waiting for maintenance — no builder yet.
    await until("the provision to reach the cache", () =>
      registry.listEvents({ kind: "provision", cube: waitingCube }).some((e) => e.phase === "seed"));
    await sleep(50);
    assert.equal(backend.builders, 1, "no build has started while maintenance holds the cache");
    await supervisor.removeUserThread(waiting.id);
    assert.equal(registry.getCube(waitingCube), null);
    release();
    await pass;
    await until("the build to finish", () => registry.listCubes().every((c) => c.status !== "building-environment") && backend.builders === 2, 15_000);
    const restored = await supervisor.createUserThread(late.id);
    const restoredCube = supervisor.resolveUserThread(restored.id).cubeName;
    await until("restored thread ready", () => registry.getCube(restoredCube)?.status === "ready");
    assert.equal(backend.builders, 2, "the abandoned wait's build was published; no rebuild");
    assert.equal(supervisor.environmentForUserThread(restored.id).setup.cached, true);
    assert.equal(fs.readFileSync(path.join(registry.getCube(restoredCube)!.workspacePath, "generated"), "utf8"), "built-late\n",
      "the snapshot carries the deleted thread's repositories, not an empty workspace");
    await supervisor.removeUserThread(restored.id);
    console.log("4 ok: a build queued behind maintenance uses the repository snapshot, not the deleted thread's rows");

    await supervisor.close();
    registry.close();
  }
  console.log("ALL PASS: provision cancel");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
