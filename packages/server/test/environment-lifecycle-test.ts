/** Targeted offline integration coverage for project environment lifecycle. */
process.env.CUBED_ALLOW_LOCAL_REPOS = "1";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MockBackend, type CubeProvisionSpec } from "@cube/sandbox";
import { Registry } from "../src/registry.ts";
import { Lifecycle } from "../src/lifecycle.ts";
import { CubeSupervisor, type ProjectInfo, type SupervisorConfig } from "../src/supervisor.ts";

class CountingBackend extends MockBackend {
  captures = 0;
  builders = 0;
  override async provision(spec: CubeProvisionSpec): Promise<void> {
    if (spec.name.startsWith("cube-s-")) this.builders++;
    await super.provision(spec);
  }
  override async captureEnvironment(spec: CubeProvisionSpec, alias: string, directory?: string): Promise<string> {
    this.captures++;
    return super.captureEnvironment(spec, alias, directory);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-environment-lifecycle-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const author = ["-c", "user.name=test", "-c", "user.email=test@cube", "-c", "commit.gpgSign=false"];

function repository(name: string, setup: string, resume = "#!/bin/sh\necho resume >> lifecycle\necho resume-output\n"): { bare: string; seed: string } {
  const bare = path.join(tmp, `${name}.git`), seed = path.join(tmp, `${name}-seed`);
  git(tmp, "init", "--bare", "-b", "main", bare);
  git(tmp, "clone", bare, seed);
  fs.mkdirSync(path.join(seed, ".cube"));
  fs.writeFileSync(path.join(seed, ".cube", "setup"), setup, { mode: 0o755 });
  fs.writeFileSync(path.join(seed, ".cube", "resume"), resume, { mode: 0o755 });
  fs.writeFileSync(path.join(seed, "tracked"), "revision-1\n");
  git(seed, ...author, "add", "-A"); git(seed, ...author, "commit", "-m", "initial"); git(seed, "push", "origin", "main");
  return { bare, seed };
}

async function settled(supervisor: CubeSupervisor, id: string): Promise<ProjectInfo> {
  for (let n = 0; n < 500; n++) {
    const project = supervisor.getProject(id);
    if (project.status !== "checking") return project;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("project check timed out");
}

async function cubeSettled(registry: Registry, name: string): Promise<void> {
  for (let n = 0; n < 500; n++) {
    if (registry.getCube(name)?.status !== "creating") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`cube ${name} timed out`);
}

const registry = new Registry(path.join(tmp, "cubed.db"));
const backend = new CountingBackend();
const config: SupervisorConfig = {
  cubesRoot: path.join(tmp, "cubes"), reposRoot: path.join(tmp, "mirrors"), pool: "mock", image: "mock",
  rootSize: "1MiB", dockerVolumeSize: "1MiB", egressAllow: [], idleMs: 0,
  portalBase: "cube.localhost", publicPort: 7777, environmentCacheBytes: 100 * 1024 * 1024,
};
const supervisor = new CubeSupervisor(registry, backend, config);

try {
  const repo = repository("good", "#!/bin/sh\necho setup >> lifecycle\necho prepared > generated\necho setup-output\n");
  const project = supervisor.createProject({ name: "good", repositories: [{ url: repo.bare }] });
  assert.equal((await settled(supervisor, project.id)).status, "ready");

  // Racing first starts share one dedicated builder/capture. Every actual
  // thread still runs resume, and receives setup output but no builder .git.
  const [a, b] = await Promise.all([supervisor.createUserThread(project.id), supervisor.createUserThread(project.id)]);
  const an = supervisor.resolveUserThread(a.id).cubeName, bn = supervisor.resolveUserThread(b.id).cubeName;
  await Promise.all([cubeSettled(registry, an), cubeSettled(registry, bn)]);
  assert.equal(backend.builders, 1); assert.equal(backend.captures, 1);
  for (const name of [an, bn]) {
    const cube = registry.getCube(name)!;
    assert.equal(cube.status, "ready");
    assert.equal(fs.readFileSync(path.join(cube.workspacePath, "lifecycle"), "utf8"), "setup\nresume\n");
    assert.ok(fs.existsSync(path.join(cube.workspacePath, ".git")));
    const environment = supervisor.environmentForUserThread(name === an ? a.id : b.id);
    assert.equal(environment.setup.state, "succeeded"); assert.equal(environment.setup.cached, true);
    assert.match(environment.setup.log, /setup-output/);
    assert.equal(environment.resume.state, "succeeded"); assert.match(environment.resume.log, /resume-output/);
  }

  // A dirty thread cannot contaminate the immutable environment, while each
  // checkout keeps its own branch and .git directory.
  fs.writeFileSync(path.join(registry.getCube(an)!.workspacePath, "generated"), "dirty\n");
  fs.writeFileSync(path.join(registry.getCube(an)!.workspacePath, "untracked"), "private\n");
  const c = await supervisor.createUserThread(project.id), cn = supervisor.resolveUserThread(c.id).cubeName;
  await cubeSettled(registry, cn);
  assert.equal(fs.readFileSync(path.join(registry.getCube(cn)!.workspacePath, "generated"), "utf8"), "prepared\n");
  assert.equal(fs.existsSync(path.join(registry.getCube(cn)!.workspacePath, "untracked")), false);
  assert.notEqual(git(registry.getCube(an)!.workspacePath, "branch", "--show-current"), git(registry.getCube(cn)!.workspacePath, "branch", "--show-current"));
  assert.notEqual(fs.statSync(path.join(registry.getCube(an)!.workspacePath, ".git")).ino, fs.statSync(path.join(registry.getCube(cn)!.workspacePath, ".git")).ino);

  // A new project revision warms from the old family but reruns setup once.
  fs.writeFileSync(path.join(repo.seed, "tracked"), "revision-2\n");
  git(repo.seed, ...author, "commit", "-am", "revision two"); git(repo.seed, "push", "origin", "main");
  supervisor.updateProject(project.id, { name: "good", repositories: [{ url: repo.bare }] });
  assert.equal((await settled(supervisor, project.id)).status, "ready");
  const d = await supervisor.createUserThread(project.id), dn = supervisor.resolveUserThread(d.id).cubeName;
  await cubeSettled(registry, dn);
  assert.equal(backend.builders, 2); assert.equal(backend.captures, 2);
  assert.equal(fs.readFileSync(path.join(registry.getCube(dn)!.workspacePath, "tracked"), "utf8"), "revision-2\n");

  // Lifecycle evidence is host-owned and remains readable after supervisor
  // reconstruction without booting it.
  const reconstructed = new CubeSupervisor(registry, backend, config);
  assert.match(reconstructed.environmentForUserThread(d.id).resume.log, /resume-output/);
  await reconstructed.close();

  // Sleep/wake invokes resume and preserves setup evidence.
  await supervisor.sleepCube(dn); await supervisor.wakeCube(dn);
  assert.equal(fs.readFileSync(path.join(registry.getCube(dn)!.workspacePath, "lifecycle"), "utf8"), "setup\nresume\nresume\n");

  // Failed setup is never captured; its thread remains usable/error-labelled
  // across wake. Editing the guest script then explicit retry runs setup and
  // resume in place and does not publish that working tree.
  const badRepo = repository("bad", "#!/bin/sh\necho broken-output\nexit 7\n");
  const badProject = supervisor.createProject({ name: "bad", repositories: [{ url: badRepo.bare }] });
  assert.equal((await settled(supervisor, badProject.id)).status, "ready");
  const captures = backend.captures;
  const bad = await supervisor.createUserThread(badProject.id), badName = supervisor.resolveUserThread(bad.id).cubeName;
  await cubeSettled(registry, badName);
  assert.equal(backend.captures, captures); assert.equal(registry.getCube(badName)!.status, "ready");
  assert.equal(supervisor.listUserThreads().find((t) => t.id === bad.id)!.state, "error");
  assert.match(supervisor.environmentForUserThread(bad.id).setup.log, /broken-output/);
  await supervisor.sleepCube(badName); await supervisor.wakeCube(badName);
  assert.equal(supervisor.listUserThreads().find((t) => t.id === bad.id)!.state, "error");
  const badWorkspace = registry.getCube(badName)!.workspacePath;
  fs.writeFileSync(path.join(badWorkspace, ".cube", "setup"), "#!/bin/sh\necho repaired >> lifecycle\n", { mode: 0o755 });
  await supervisor.retrySetupForUserThread(bad.id);
  assert.equal(supervisor.listUserThreads().find((t) => t.id === bad.id)!.state, "ready");
  assert.equal(backend.captures, captures); assert.match(fs.readFileSync(path.join(badWorkspace, "lifecycle"), "utf8"), /repaired\nresume/);

  // Non-executable lifecycle files fail loudly. Cache disabled means no
  // builder/capture path at all and setup executes in each working thread.
  const noCacheBackend = new CountingBackend();
  const noCacheRegistry = new Registry(path.join(tmp, "no-cache.db"));
  const noCache = new CubeSupervisor(noCacheRegistry, noCacheBackend, { ...config, cubesRoot: path.join(tmp, "no-cache-cubes"), reposRoot: path.join(tmp, "no-cache-mirrors"), environmentCacheBytes: 0 });
  const nx = repository("nonexec", "#!/bin/sh\necho should-not-run\n"); fs.chmodSync(path.join(nx.seed, ".cube", "setup"), 0o644);
  git(nx.seed, ...author, "add", ".cube/setup"); git(nx.seed, ...author, "commit", "-m", "non executable"); git(nx.seed, "push", "origin", "main");
  const np = noCache.createProject({ name: "nonexec", repositories: [{ url: nx.bare }] }); await settled(noCache, np.id);
  const nt = await noCache.createUserThread(np.id), nn = noCache.resolveUserThread(nt.id).cubeName; await cubeSettled(noCacheRegistry, nn);
  assert.equal(noCacheBackend.builders, 0); assert.equal(noCacheBackend.captures, 0);
  assert.match(noCache.environmentForUserThread(nt.id).setup.error ?? "", /must be executable|exit 126/);
  const lifecycle = new Lifecycle(path.join(tmp, "no-cache-cubes", ".lifecycle"));
  lifecycle.save(nn, "setup", { state: "running", startedAt: Date.now() - 100, durationMs: null, error: null });
  noCacheRegistry.setCubeStatus(nn, "creating");
  await noCache.boot();
  assert.equal(noCache.environmentForUserThread(nt.id).setup.state, "failed");
  assert.match(noCache.environmentForUserThread(nt.id).setup.error!, /interrupted/);
  await noCache.wakeCube(nn);
  assert.equal(noCache.listUserThreads().find((t) => t.id === nt.id)!.state, "error");
  await noCache.close(); noCacheRegistry.close();

  console.log("PASS: environment lifecycle integration");
} finally {
  await supervisor.close(); registry.close(); fs.rmSync(tmp, { recursive: true, force: true });
}
