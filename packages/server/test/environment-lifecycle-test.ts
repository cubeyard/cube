/**
 * Offline integration test for prepared environments as templates: the
 * first threads of a project share one builder, every thread is cloned
 * from the template and still runs setup itself (warm), a commit does not
 * rebuild but a changed declaration does, a failed setup never becomes a
 * template, and the whole path can be switched off.
 *
 *   node packages/server/test/environment-lifecycle-test.ts
 */
process.env.CUBED_ALLOW_LOCAL_REPOS = "1";

import assert from "node:assert/strict";
import { Effect } from "effect";
import type { EnvironmentProgress } from "../src/environment-progress.ts";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";
import { MockBackend, type CubeProvisionSpec, type CubeTemplateSource } from "@cube/sandbox";
import { Registry } from "../src/registry.ts";
import { Lifecycle } from "../src/lifecycle.ts";
import { CubeSupervisor, type ProjectInfo, type SupervisorConfig } from "../src/supervisor.ts";

class CountingBackend extends MockBackend {
  builders = 0;
  captures = 0;
  trust = new Map<string, string>();
  override async configureCaTrust(name: string, pem: string, signal?: AbortSignal): Promise<void> {
    await super.configureCaTrust(name, pem, signal);
    this.trust.set(name, pem);
  }
  override sandbox(name: string) {
    const sandbox = super.sandbox(name);
    const exec = sandbox.exec.bind(sandbox);
    sandbox.exec = (command, options) => {
      assert.ok(this.trust.has(name), "trust must be reconciled before setup/resume executes");
      return exec(command, options);
    };
    return sandbox;
  }
  override async provision(spec: CubeProvisionSpec): Promise<void> {
    if (spec.name.startsWith("cube-s-")) this.builders++;
    await super.provision(spec);
  }
  override async captureTemplate(spec: CubeProvisionSpec, snapshot: string): Promise<CubeTemplateSource> {
    this.captures++;
    return super.captureTemplate(spec, snapshot);
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
  portalBase: "cube.localhost", publicPort: 7777, cubeMemory: "512MiB",
};
const supervisor = new CubeSupervisor(registry, backend, config);

try {
  const repo = repository("good", "#!/bin/sh\necho setup >> lifecycle\necho prepared > generated\necho setup-output\necho setup-stderr >&2\nsleep 0.7\n");
  const project = supervisor.createProject({ name: "good", repositories: [{ url: repo.bare }] });
  assert.equal((await settled(supervisor, project.id)).status, "ready");

  // Racing first starts share one builder and one capture. Both threads are
  // clones, and each still runs setup (warm) and resume in its own workspace.
  const [a, b] = await Promise.all([supervisor.createUserThread(project.id), supervisor.createUserThread(project.id)]);
  const an = supervisor.resolveUserThread(a.id).cubeName, bn = supervisor.resolveUserThread(b.id).cubeName;
  const streams = [[], []] as EnvironmentProgress[][];
  await Effect.runPromise(Effect.all([a, b].map((thread, index) => Effect.tryPromise(() =>
    supervisor.terminalPlan(thread.id, (_text, progress) => { if (progress) streams[index]!.push(progress); }),
  )), { concurrency: 2 }));
  for (const snapshots of streams) {
    assert.ok(snapshots.some((p) => p.phase.includes("/setup") && p.log.includes("setup-stderr")), "live output before setup finishes");
    assert.ok(snapshots.some((p) => p.phase.startsWith("preparing a reusable environment:") && p.log.includes("setup-stderr")), "each waiter sees the shared builder's output");
    assert.equal(snapshots.at(-1)?.phase, "environment ready");
    assert.ok(snapshots.at(-1)?.log.includes("resume-output"));
  }
  await Promise.all([cubeSettled(registry, an), cubeSettled(registry, bn)]);
  assert.equal(backend.builders, 1); assert.equal(backend.captures, 1);
  assert.equal(backend.templates.size, 1, "the builder lives on as the template");
  const template = [...backend.templates.values()][0]!;
  assert.deepEqual(backend.clones.map((c) => c.template), [template.instance, template.instance]);
  assert.equal(registry.listCubes().some((c) => c.status === "building-environment"), false, "the builder's cube row is released");
  assert.equal(registry.listEnvironmentTemplates(project.id).length, 1);
  for (const name of [an, bn]) {
    const cube = registry.getCube(name)!;
    assert.equal(cube.status, "ready");
    assert.equal(fs.readFileSync(path.join(cube.workspacePath, "lifecycle"), "utf8"), "setup\nresume\n", "setup ran in the thread itself");
    assert.equal(fs.readFileSync(path.join(cube.workspacePath, "generated"), "utf8"), "prepared\n");
    assert.ok(fs.existsSync(path.join(cube.workspacePath, ".git")));
    const environment = supervisor.environmentForUserThread(name === an ? a.id : b.id);
    assert.equal(environment.setup.state, "succeeded"); assert.match(environment.setup.log, /setup-output/);
    assert.equal(environment.resume.state, "succeeded"); assert.match(environment.resume.log, /resume-output/);
    assert.deepEqual(environment.limits, { memory: "512MiB" });
  }
  const provisionEvents = registry.listEvents({ kind: "provision", cube: an });
  assert.ok(provisionEvents.some((e) => e.phase === "instance" && /cloned from a prepared environment/.test(e.detail ?? "")));
  assert.ok(provisionEvents.some((e) => e.phase === "setup" && /warm rerun/.test(e.detail ?? "")));
  assert.ok(registry.listEvents({ kind: "environment" }).some((e) => e.phase === "capture"), "the builder's phases are events");

  // A dirty thread cannot contaminate later ones: every clone gets a fresh checkout.
  fs.writeFileSync(path.join(registry.getCube(an)!.workspacePath, "generated"), "dirty\n");
  fs.writeFileSync(path.join(registry.getCube(an)!.workspacePath, "untracked"), "private\n");
  const c = await supervisor.createUserThread(project.id), cn = supervisor.resolveUserThread(c.id).cubeName;
  await cubeSettled(registry, cn);
  assert.equal(backend.builders, 1, "a ready template is cloned, not rebuilt");
  assert.equal(fs.readFileSync(path.join(registry.getCube(cn)!.workspacePath, "generated"), "utf8"), "prepared\n");
  assert.equal(fs.existsSync(path.join(registry.getCube(cn)!.workspacePath, "untracked")), false);
  assert.notEqual(git(registry.getCube(an)!.workspacePath, "branch", "--show-current"), git(registry.getCube(cn)!.workspacePath, "branch", "--show-current"));

  // A commit is not a new environment: the template stays, the clone gets the new checkout.
  fs.writeFileSync(path.join(repo.seed, "tracked"), "revision-2\n");
  git(repo.seed, ...author, "commit", "-am", "revision two"); git(repo.seed, "push", "origin", "main");
  // No project re-check: creation must see the freshly pushed revision.
  const d = await supervisor.createUserThread(project.id), dn = supervisor.resolveUserThread(d.id).cubeName;
  await cubeSettled(registry, dn);
  assert.equal(backend.builders, 1); assert.equal(backend.captures, 1);
  assert.equal(fs.readFileSync(path.join(registry.getCube(dn)!.workspacePath, "tracked"), "utf8"), "revision-2\n");

  // A changed declaration is: a new builder, a new template, the old one evicted.
  fs.writeFileSync(path.join(repo.seed, ".cube", "setup"), "#!/bin/sh\necho setup >> lifecycle\necho prepared-v2 > generated\necho setup-output\n", { mode: 0o755 });
  git(repo.seed, ...author, "commit", "-am", "new setup"); git(repo.seed, "push", "origin", "main");
  // No project re-check: creation must see the freshly pushed revision.
  const e = await supervisor.createUserThread(project.id), en = supervisor.resolveUserThread(e.id).cubeName;
  await cubeSettled(registry, en);
  assert.equal(backend.builders, 2); assert.equal(backend.captures, 2);
  assert.equal(backend.templates.size, 1, "one template per project");
  assert.ok(!backend.templates.has(template.instance), "the previous template was deleted");
  assert.equal(fs.readFileSync(path.join(registry.getCube(en)!.workspacePath, "generated"), "utf8"), "prepared-v2\n");
  assert.equal(registry.getCube(an)!.status, "ready", "threads cloned from the old template live on");

  // An administrator trust change invalidates templates, reaches builders
  // and clones, and is reconciled on an existing thread's wake/retry.
  const caCertificates = rootCertificates[0]!;
  const withCa = new CubeSupervisor(registry, backend, { ...config, caCertificates });
  try {
    await withCa.boot();
    assert.equal(backend.trust.get(`cube-${dn}`), caCertificates, "boot reconciles running environments");
    const before = backend.builders;
    const added = await withCa.createUserThread(project.id);
    const name = withCa.resolveUserThread(added.id).cubeName;
    await cubeSettled(registry, name);
    assert.equal(backend.builders, before + 1, "CA content is part of the environment cache key");
    assert.equal(backend.trust.get(`cube-${name}`), caCertificates);
    const fresh = registry.listEnvironmentTemplates(project.id)[0]!;
    assert.equal(backend.trust.get(fresh.instance), caCertificates, "builder receives trust before setup");
    await withCa.sleepCube(dn);
    backend.trust.delete(`cube-${dn}`);
    await withCa.wakeCube(dn);
    assert.equal(backend.trust.get(`cube-${dn}`), caCertificates, "existing environments acquire the new roots");
    await withCa.removeUserThread(added.id);
  } finally {
    await withCa.close();
  }
  await supervisor.retrySetupForUserThread(d.id);
  assert.equal(backend.trust.get(`cube-${dn}`), "", "removing the profile revokes managed trust on retry");

  // Lifecycle evidence is host-owned and readable after reconstruction.
  const reconstructed = new CubeSupervisor(registry, backend, config);
  assert.match(reconstructed.environmentForUserThread(d.id).resume.log, /resume-output/);
  await reconstructed.close();

  // Sleep/wake invokes resume and preserves setup evidence.
  await supervisor.sleepCube(dn); await supervisor.wakeCube(dn);
  assert.equal(fs.readFileSync(path.join(registry.getCube(dn)!.workspacePath, "lifecycle"), "utf8"), "setup\nresume\nresume\nsetup\nresume\nresume\n");

  // A failed setup never becomes a template: the builder is torn down, the
  // thread sets up fresh and carries the error; explicit retry repairs in
  // place and captures nothing.
  const badRepo = repository("bad", "#!/bin/sh\necho broken-output\nexit 7\n");
  const badProject = supervisor.createProject({ name: "bad", repositories: [{ url: badRepo.bare }] });
  assert.equal((await settled(supervisor, badProject.id)).status, "ready");
  const captures = backend.captures, builders = backend.builders;
  const bad = await supervisor.createUserThread(badProject.id), badName = supervisor.resolveUserThread(bad.id).cubeName;
  await cubeSettled(registry, badName);
  assert.equal(backend.builders, builders + 1); assert.equal(backend.captures, captures);
  assert.deepEqual(registry.listEnvironmentTemplates(badProject.id), []);
  assert.equal(registry.listCubes().some((c) => c.status === "building-environment"), false, "the failed builder is gone");
  assert.equal(registry.getCube(badName)!.status, "ready");
  assert.equal(supervisor.listUserThreads().find((t) => t.id === bad.id)!.state, "error");
  assert.match(supervisor.environmentForUserThread(bad.id).setup.log, /broken-output/);
  let failedProgress: EnvironmentProgress | undefined;
  await supervisor.terminalPlan(bad.id, (_text, progress) => { failedProgress = progress; });
  assert.equal(failedProgress?.failed, true);
  assert.match(failedProgress!.log, /broken-output/);
  const restoredSetup = new CubeSupervisor(registry, backend, config);
  try {
    const snapshot = restoredSetup.terminalProgressForUserThread(bad.id);
    assert.equal(snapshot?.failed, true);
    assert.match(snapshot!.log, /broken-output/);
  } finally {
    await restoredSetup.close();
  }
  assert.ok(registry.listEvents({ kind: "environment", cube: badName }).some((e) => e.phase === "template-unavailable"));
  await supervisor.sleepCube(badName); await supervisor.wakeCube(badName);
  assert.equal(supervisor.listUserThreads().find((t) => t.id === bad.id)!.state, "error");
  const badWorkspace = registry.getCube(badName)!.workspacePath;
  fs.writeFileSync(path.join(badWorkspace, ".cube", "setup"), "#!/bin/sh\necho repaired >> lifecycle\n", { mode: 0o755 });
  await supervisor.retrySetupForUserThread(bad.id);
  assert.equal(supervisor.listUserThreads().find((t) => t.id === bad.id)!.state, "ready");
  let repairedProgress: EnvironmentProgress | undefined;
  await supervisor.terminalPlan(bad.id, (_text, progress) => { repairedProgress = progress; });
  assert.equal(repairedProgress?.failed, false, "repair clears obsolete failure snapshots");
  assert.equal(backend.captures, captures); assert.match(fs.readFileSync(path.join(badWorkspace, "lifecycle"), "utf8"), /repaired\nresume/);

  // Reconstruct the supervisor to discard in-memory progress, as on restart.
  // Each failed phase must restore its own durable output tail.
  const resumeRepo = repository("bad-resume", "#!/bin/sh\necho setup-success-only\n", "#!/bin/sh\necho resume-failure-evidence\nexit 9\n");
  const resumeProject = supervisor.createProject({ name: "bad resume", repositories: [{ url: resumeRepo.bare }] });
  await settled(supervisor, resumeProject.id);
  const resumeThread = await supervisor.createUserThread(resumeProject.id);
  await cubeSettled(registry, supervisor.resolveUserThread(resumeThread.id).cubeName);
  const restored = new CubeSupervisor(registry, backend, config);
  try {
    let progress: EnvironmentProgress | undefined;
    await restored.terminalPlan(resumeThread.id, (_text, snapshot) => { progress = snapshot; });
    assert.equal(progress?.failed, true);
    assert.match(progress!.log, /resume-failure-evidence/);
    assert.doesNotMatch(progress!.log, /setup-success-only/);
    assert.deepEqual(restored.terminalProgressForUserThread(resumeThread.id), progress);
  } finally {
    await restored.close();
  }
  await supervisor.removeUserThread(resumeThread.id);
  await supervisor.deleteProject(resumeProject.id);

  // Deleting the project deletes its template.
  for (const id of [a.id, b.id, c.id, d.id, e.id]) await supervisor.removeUserThread(id);
  await supervisor.deleteProject(project.id);
  assert.equal(backend.templates.size, 0);
  assert.deepEqual(registry.listEnvironmentTemplates(), []);

  // Templates off: no builder, no capture; setup runs in each thread.
  const noCacheBackend = new CountingBackend();
  const noCacheRegistry = new Registry(path.join(tmp, "no-cache.db"));
  const noCache = new CubeSupervisor(noCacheRegistry, noCacheBackend, { ...config, cubesRoot: path.join(tmp, "no-cache-cubes"), reposRoot: path.join(tmp, "no-cache-mirrors"), environmentCache: false });
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
