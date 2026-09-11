/**
 * Offline project integration test: repository preflight happens before a
 * thread starts, new threads refresh tips and pin them, and provisioning
 * consumes only those prepared local snapshots. No Incus or model.
 *
 *   node packages/server/test/project-test.ts
 */
process.env.CUBED_ALLOW_LOCAL_REPOS = "1";

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MockBackend } from "@cube/sandbox";
import type { PrReviewService, GitService } from "@cube/git";

import { Registry } from "../src/registry.ts";
import { CubeSupervisor, type ProjectInfo } from "../src/supervisor.ts";

class BlockingServiceBackend extends MockBackend {
  blockServices = false;
  serviceExecs = 0;
  serviceAborts = 0;

  override async execSimple(name: string, command: string[], signal?: AbortSignal): Promise<number | null> {
    if (!this.blockServices) return super.execSimple(name, command, signal);
    this.serviceExecs += 1;
    return new Promise((_resolve, reject) => {
      const onAbort = () => {
        this.serviceAborts += 1;
        reject(signal?.reason ?? new Error("service ensure aborted"));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-project-test-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const author = ["-c", "user.name=test", "-c", "user.email=test@cube", "-c", "commit.gpgSign=false"];

function upstream(name: string, file: string, content: string): { bare: string; seed: string } {
  const bare = path.join(tmp, `${name}.git`);
  git(tmp, "init", "--bare", "-b", "main", bare);
  const seed = path.join(tmp, `${name}-seed`);
  git(tmp, "clone", bare, seed);
  fs.writeFileSync(path.join(seed, file), content);
  git(seed, ...author, "add", "-A");
  git(seed, ...author, "commit", "-m", "initial");
  git(seed, "push", "origin", "main");
  return { bare, seed };
}

async function settledProject(supervisor: CubeSupervisor, id: string): Promise<ProjectInfo> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const project = supervisor.getProject(id);
    if (project.status !== "checking") return project;
    if (Date.now() > deadline) throw new Error(`project ${id} check timed out`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readyCube(registry: Registry, name: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const cube = registry.getCube(name);
    if (cube?.status === "ready") return;
    if (cube?.status === "error") throw new Error(`thread setup failed: ${cube.error}`);
    if (Date.now() > deadline) throw new Error(`thread ${name} setup timed out`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const primary = upstream("primary", "README.md", "prepared revision\n");
const docs = upstream("docs", "DOCS.md", "prepared docs\n");
const registry = new Registry(path.join(tmp, "cubed.db"));
const backend = new BlockingServiceBackend();
const supervisor = new CubeSupervisor(registry, backend, {
  cubesRoot: path.join(tmp, "cubes"),
  reposRoot: path.join(tmp, "mirrors"),
  pool: "mock",
  image: "mock",
  rootSize: "1GiB",
  dockerVolumeSize: "1GiB",
  egressAllow: [],
  idleMs: 0,
  portalBase: "cube.localhost",
  publicPort: 7777,
});

const missing = supervisor.createProject({
  name: "missing branch",
  repositories: [{ url: primary.bare, base: "does-not-exist" }],
});
await assert.rejects(supervisor.createUserThread(missing.id), /not ready \(status: checking\)/);
const missingDone = await settledProject(supervisor, missing.id);
assert.equal(missingDone.status, "error");
assert.match(missingDone.repositories[0]!.error ?? "", /does-not-exist|remote ref|revision/i);
await assert.rejects(supervisor.createUserThread(missing.id), /not ready \(status: error\)/);
await supervisor.deleteProject(missing.id);
console.log("1 ok: checking and failed projects cannot start threads; exact repository error retained");

assert.throws(
  () =>
    supervisor.createProject({
      name: "checkout collision",
      repositories: [
        { url: primary.bare },
        { url: docs.bare, checkoutName: "workspace" },
      ],
    }),
  /checkout name "workspace" is used more than once/,
);
console.log("2 ok: checkout paths are collision-checked before persistence");

const project = supervisor.createProject({
  name: "workbench",
  repositories: [
    { url: primary.bare },
    { url: docs.bare, checkoutName: "docs" },
  ],
});
assert.throws(
  () => supervisor.createProject({ name: "WORKBENCH", repositories: [{ url: primary.bare }] }),
  /project "WORKBENCH" already exists/,
);
let ready = await settledProject(supervisor, project.id);
assert.equal(ready.status, "ready", ready.error ?? "project should be ready");
assert.deepEqual(ready.repositories.map((repo) => repo.checkoutName), ["workspace", "docs"]);
assert.deepEqual(ready.repositories.map((repo) => repo.resolvedBase), ["main", "main"]);
assert.ok(ready.repositories.every((repo) => /^[0-9a-f]{40}$/.test(repo.baseOid ?? "")));

supervisor.checkProject(project.id);
await assert.rejects(supervisor.createUserThread(project.id), /not ready \(status: checking\)/);
ready = await settledProject(supervisor, project.id);
assert.equal(ready.status, "ready");
console.log("3 ok: ready state has per-repository evidence; re-check gates thread creation");

// A request key names one user action: replaying it returns the thread the
// first attempt made (no second cube); a different key is a different action.
const firstAttempt = await supervisor.createUserThread(project.id, "action-1");
const replay = await supervisor.createUserThread(project.id, "action-1");
assert.equal(firstAttempt.created, true);
assert.equal(replay.created, false);
assert.equal(replay.id, firstAttempt.id);
const another = await supervisor.createUserThread(project.id, "action-2");
assert.equal(another.created, true);
assert.notEqual(another.id, firstAttempt.id);
assert.equal(registry.listCubes().length, 2, "two keys, two cubes; the replay allocated none");
// The key is scoped to the project it was used with, and a thread that no
// longer exists is not replayed.
const otherProject = supervisor.createProject({ name: "other", repositories: [{ url: primary.bare }] });
await settledProject(supervisor, otherProject.id);
const elsewhere = await supervisor.createUserThread(otherProject.id, "action-1");
assert.equal(elsewhere.created, true);
assert.notEqual(elsewhere.id, firstAttempt.id);
for (const thread of [firstAttempt, another, elsewhere]) {
  await readyCube(registry, supervisor.resolveUserThread(thread.id).cubeName);
  await supervisor.removeUserThread(thread.id);
}
assert.equal((await supervisor.createUserThread(project.id, "action-1")).created, true, "a deleted thread is not replayed");
await supervisor.removeUserThread(supervisor.resolveUserThread((await supervisor.createUserThread(project.id, "action-1")).id).threadId);
await supervisor.deleteProject(otherProject.id);
assert.equal(registry.listCubes().length, 0);
console.log("3b ok: thread creation is idempotent per request key and project");

// The key store is bounded and swept: past the cap the oldest key goes
// first (no scan); the minute sweep drops expired keys and keys whose
// thread was deleted; an expired hit on the request path is not replayed.
{
  const internals = supervisor as unknown as {
    createRequests: Map<string, { threadId: string; at: number }>;
    sweepCreateRequests: () => void;
  };
  const requests = internals.createRequests;
  const scoped = (key: string) => `${project.id}\0${key}`;
  internals.sweepCreateRequests();
  assert.equal(requests.size, 0, "3b's keys all point at deleted threads: swept");
  const kept = await supervisor.createUserThread(project.id, "kept");
  for (let i = 1; i < 1000; i++) requests.set(scoped(`filler-${i}`), { threadId: "no-such-thread", at: Date.now() });
  assert.equal(requests.size, 1000);
  const newest = await supervisor.createUserThread(project.id, "newest");
  assert.equal(requests.size, 1000, "capped at 1000 entries");
  assert.equal(requests.has(scoped("kept")), false, "the oldest key was evicted first");
  assert.equal(requests.has(scoped("newest")), true);
  requests.set(scoped("expired"), { threadId: newest.id, at: Date.now() - 11 * 60_000 });
  await readyCube(registry, supervisor.resolveUserThread(newest.id).cubeName);
  await supervisor.removeUserThread(newest.id);
  internals.sweepCreateRequests();
  assert.equal(requests.has(scoped("expired")), false, "expired keys are swept");
  assert.equal(requests.has(scoped("newest")), false, "a deleted thread's key is swept");
  assert.equal(requests.size, 0, "keys whose thread never existed are swept too");
  await readyCube(registry, supervisor.resolveUserThread(kept.id).cubeName);
  await supervisor.removeUserThread(kept.id);
  const fresh = await supervisor.createUserThread(project.id, "fresh");
  requests.get(scoped("fresh"))!.at = Date.now() - 11 * 60_000;
  const later = await supervisor.createUserThread(project.id, "fresh");
  assert.equal(later.created, true, "an expired key is a new action");
  assert.notEqual(later.id, fresh.id);
  for (const thread of [fresh, later]) {
    await readyCube(registry, supervisor.resolveUserThread(thread.id).cubeName);
    await supervisor.removeUserThread(thread.id);
  }
  assert.equal(registry.listCubes().length, 0);
  console.log("3c ok: the idempotency store is capped, swept on the timer, and never replays an expired key");
}

// The new await must not let an edit/re-check/delete race allocate from an
// obsolete project revision. Hold the real fetch before letting it finish.
for (const change of ["edit", "delete"] as const) {
  const candidate = supervisor.createProject({ name: `racing-${change}`, repositories: [{ url: primary.bare }] });
  await settledProject(supervisor, candidate.id);
  await new Promise(resolve => setImmediate(resolve));
  const service = (supervisor as unknown as { git: GitService }).git;
  const original = service.prepareRepository.bind(service);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  service.prepareRepository = async (...args) => { entered(); await gate; return original(...args); };
  try {
    const attempt = supervisor.createUserThread(candidate.id, "racing");
    const rejected = assert.rejects(attempt, /project changed|not ready|no such project/);
    await started;
    if (change === "edit") supervisor.updateProject(candidate.id, { name: "edited", repositories: [{ url: docs.bare }] });
    else await supervisor.deleteProject(candidate.id);
    release();
    await rejected;
    assert.equal(registry.listCubes().length, 0, "no allocation from obsolete configuration");
    if (change === "edit") {
      await settledProject(supervisor, candidate.id);
      await supervisor.deleteProject(candidate.id);
    }
  } finally { release(); service.prepareRepository = original; }
}
console.log("3d ok: project edits and deletion during refresh cannot allocate stale threads");

// Respect an explicitly configured base, not a hard-coded main.
git(primary.seed, "checkout", "-b", "release");
git(primary.seed, "push", "origin", "release");
const releaseProject = supervisor.createProject({ name: "release branch", repositories: [{ url: primary.bare, base: "release" }] });
await settledProject(supervisor, releaseProject.id);
fs.writeFileSync(path.join(primary.seed, "README.md"), "fresh release tip\n");
git(primary.seed, ...author, "commit", "-am", "advance release");
git(primary.seed, "push", "origin", "release");
const releaseThread = await supervisor.createUserThread(releaseProject.id);
const releaseName = supervisor.resolveUserThread(releaseThread.id).cubeName;
await readyCube(registry, releaseName);
const releaseCube = registry.getCube(releaseName)!;
assert.equal(fs.readFileSync(path.join(releaseCube.workspacePath, "README.md"), "utf8"), "fresh release tip\n");
assert.equal(registry.listCubeRepositories(releaseCube.id)[0]!.base, "release");
await supervisor.removeUserThread(releaseThread.id);
await supervisor.deleteProject(releaseProject.id);
git(primary.seed, "checkout", "main");
console.log("3e ok: configured non-main base is refreshed");

// Existing threads stay pinned. New threads refresh both upstreams rather
// than reusing the old project-check snapshot.
const oldThread = await supervisor.createUserThread(project.id);
const oldName = supervisor.resolveUserThread(oldThread.id).cubeName;
await readyCube(registry, oldName);
const oldCube = registry.getCube(oldName)!;
const checkedOids = ready.repositories.map(repo => repo.baseOid);
fs.writeFileSync(path.join(primary.seed, "README.md"), "new upstream revision\n");
git(primary.seed, ...author, "commit", "-am", "advance primary");
git(primary.seed, "push", "origin", "main");
fs.writeFileSync(path.join(docs.seed, "DOCS.md"), "new upstream docs\n");
git(docs.seed, ...author, "commit", "-am", "advance docs");
git(docs.seed, "push", "origin", "main");

// An offline primary OR reference is a creation failure, not permission to
// use stale mirrors. Concurrent replays share a failure and allocate nothing.
fs.renameSync(primary.bare, `${primary.bare}.offline`);
const attempts = await Promise.allSettled([
  supervisor.createUserThread(project.id, "refresh-retry"),
  supervisor.createUserThread(project.id, "refresh-retry"),
]);
for (const attempt of attempts) {
  assert.equal(attempt.status, "rejected");
  if (attempt.status === "rejected") assert.match(attempt.reason.message, /could not refresh workspace/);
}
assert.equal(registry.listCubes().length, 1, "no allocation when primary refresh fails");
fs.renameSync(`${primary.bare}.offline`, primary.bare);
fs.renameSync(docs.bare, `${docs.bare}.offline`);
await assert.rejects(supervisor.createUserThread(project.id, "refresh-retry"), /could not refresh docs/);
assert.equal(registry.listCubes().length, 1, "no allocation when reference refresh fails");
fs.renameSync(`${docs.bare}.offline`, docs.bare);

const [thread, concurrentReplay] = await Promise.all([
  supervisor.createUserThread(project.id, "refresh-retry"),
  supervisor.createUserThread(project.id, "refresh-retry"),
]);
assert.equal(thread.created, true);
assert.equal(concurrentReplay.created, false);
assert.equal(thread.id, concurrentReplay.id);
assert.equal(registry.listCubes().length, 2, "one allocation after a successful shared refresh");
const cubeName = supervisor.resolveUserThread(thread.id).cubeName;
await readyCube(registry, cubeName);
const cube = registry.getCube(cubeName)!;
assert.equal(fs.readFileSync(path.join(cube.workspacePath, "README.md"), "utf8"), "new upstream revision\n");
assert.equal(fs.readFileSync(path.join(oldCube.workspacePath, "README.md"), "utf8"), "prepared revision\n");
assert.deepEqual(registry.listCubeRepositories(oldCube.id).map(repo => repo.baseOid), checkedOids);
assert.deepEqual(registry.listCubeRepositories(cube.id).map(repo => repo.baseOid), [git(primary.seed, "rev-parse", "HEAD"), git(docs.seed, "rev-parse", "HEAD")]);
assert.deepEqual(supervisor.getProject(project.id).repositories.map(repo => repo.baseOid), checkedOids, "refresh does not rewrite project-check evidence");
await supervisor.removeUserThread(oldThread.id);
assert.equal(
  fs.readFileSync(path.join(path.dirname(cube.workspacePath), "repos", "docs", "DOCS.md"), "utf8"),
  "new upstream docs\n",
);
const repositories = await supervisor.repositoriesForUserThread(thread.id);
assert.deepEqual(repositories.map((repo) => repo.path), ["/workspace", "../repos/docs"]);
assert.deepEqual(repositories.map((repo) => repo.role), ["primary", "additional"]);
assert.equal(
  supervisor.workspaceForUserRepository(thread.id, repositories[1]!.id),
  path.join(path.dirname(cube.workspacePath), "repos", "docs"),
);
assert.throws(
  () => supervisor.workspaceForUserRepository(thread.id, Number.MAX_SAFE_INTEGER),
  /no such repository/,
);
// Reference edits and publication target its own remote, never the primary.
const referencePath = supervisor.workspaceForUserRepository(thread.id, repositories[1]!.id);
const primaryHead = git(cube.workspacePath, "rev-parse", "HEAD");
const primaryRemote = git(primary.bare, "rev-parse", "main");
fs.writeFileSync(path.join(referencePath, "DOCS.md"), "edited in the same thread\n");
git(referencePath, ...author, "add", "DOCS.md");
git(referencePath, ...author, "commit", "-m", "update reference");
assert.equal((await supervisor.syncBaseForUserThread(thread.id, repositories[1]!.id)).base, "main");
await supervisor.pushUserThread(thread.id, repositories[1]!.id);
assert.equal(git(docs.bare, "rev-parse", repositories[1]!.branch), git(referencePath, "rev-parse", "HEAD"));
await supervisor.pushBaseForUserThread(thread.id, repositories[1]!.id);
assert.equal(git(docs.bare, "rev-parse", "main"), git(referencePath, "rev-parse", "HEAD"));
assert.equal(git(cube.workspacePath, "rev-parse", "HEAD"), primaryHead);
assert.equal(git(primary.bare, "rev-parse", "main"), primaryRemote);
// Review preparation keeps the same safe workflow, scoped to this checkout.
const reviews = (supervisor as unknown as { prReviews: PrReviewService }).prReviews;
for (const [action, method] of [["prepare", "prepare"], ["prepare-rebase", "prepareRebase"]] as const) {
  const original = reviews[method];
  const reached = new Error("reference review adapter reached");
  reviews[method] = async (workspace, url, number) => {
    assert.equal(workspace, referencePath);
    assert.equal(url, docs.bare);
    assert.equal(number, 845);
    throw reached;
  };
  try {
    await assert.rejects(supervisor.reviewPrForUserThread(thread.id, repositories[1]!.id, { action, number: 845 }), error => error === reached);
  } finally { reviews[method] = original; }
}
await assert.rejects(supervisor.readGithubForUserThread(thread.id, { number: 1, type: "issue", repositoryId: Number.MAX_SAFE_INTEGER }), /no such repository/);
await assert.rejects(
  () => supervisor.reviewPrForUserThread(thread.id, Number.MAX_SAFE_INTEGER, { action: "prepare", number: 845 }),
  /no such repository/,
);
assert.equal(supervisor.listUserThreads()[0]!.project.id, project.id);
assert.equal(supervisor.listUserThreads()[0]!.project.name, "workbench");
assert.deepEqual(await supervisor.ensureServicesForUserThread(thread.id), []);

// Two callers share one service ensure. The first cancellation detaches only
// that waiter; the underlying root operation is cancelled when the final
// waiter also leaves.
const serviceConfig = path.join(cube.workspacePath, ".cube", "cube.toml");
fs.mkdirSync(path.dirname(serviceConfig), { recursive: true });
fs.writeFileSync(serviceConfig, `[services.web]\ncommand = "serve"\nport = 3000\n`);
backend.blockServices = true;
const firstController = new AbortController();
const secondController = new AbortController();
const firstEnsure = supervisor.ensureServicesForUserThread(thread.id, firstController.signal);
const secondEnsure = supervisor.ensureServicesForUserThread(thread.id, secondController.signal);
let secondSettled = false;
void secondEnsure.then(
  () => (secondSettled = true),
  () => (secondSettled = true),
);
await new Promise((resolve) => setImmediate(resolve));
firstController.abort(new Error("first caller left"));
await assert.rejects(firstEnsure, /first caller left/);
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(secondSettled, false, "one waiter must not cancel a shared ensure");
assert.equal(backend.serviceAborts, 0);
secondController.abort(new Error("second caller left"));
await assert.rejects(secondEnsure, /second caller left/);
assert.equal(backend.serviceExecs, 1, "coalesced ensure should run only once");
assert.equal(backend.serviceAborts, 1, "last waiter cancellation aborts underlying service work");
backend.blockServices = false;
fs.rmSync(path.join(cube.workspacePath, ".cube"), { recursive: true, force: true });

supervisor.archiveUserThread(thread.id);
assert.equal(supervisor.listUserThreads().length, 0);
assert.equal(supervisor.listUserThreads(true)[0]!.archived, true);
await assert.rejects(supervisor.deleteProject(project.id), /still has threads/);
console.log("4 ok: project snapshot scopes repos/services, coalesces cancellation, labels threads, and preserves archived work");

await supervisor.removeUserThread(thread.id);
await supervisor.deleteProject(project.id);
assert.equal(supervisor.listProjects().length, 0);
// Shutdown drains a creation's refresh and prevents its later allocation.
const shutdownProject = supervisor.createProject({ name: "shutdown", repositories: [{ url: primary.bare }] });
await settledProject(supervisor, shutdownProject.id);
const service = (supervisor as unknown as { git: GitService }).git;
const prepare = service.prepareRepository.bind(service);
let releaseShutdown!: () => void;
let enterShutdown!: () => void;
const shutdownEntered = new Promise<void>(resolve => { enterShutdown = resolve; });
const shutdownGate = new Promise<void>(resolve => { releaseShutdown = resolve; });
service.prepareRepository = async (...args) => { enterShutdown(); await shutdownGate; return prepare(...args); };
const creatingAtShutdown = supervisor.createUserThread(shutdownProject.id);
const refusedAtShutdown = assert.rejects(creatingAtShutdown, /server is stopping/);
await shutdownEntered;
let closed = false;
const closing = supervisor.close().then(() => { closed = true; });
await new Promise(resolve => setImmediate(resolve));
assert.equal(closed, false, "close waits for the in-flight refresh");
releaseShutdown();
await refusedAtShutdown;
await closing;
assert.equal(registry.listCubes().length, 0, "shutdown cannot allocate a late thread");
await assert.rejects(supervisor.createUserThread(shutdownProject.id), /server is stopping/);
registry.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("5 ok: project deletion is blocked by threads, then succeeds after teardown");
console.log("project-test: all ok");
