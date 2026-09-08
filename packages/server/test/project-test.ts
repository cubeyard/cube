/**
 * Offline project integration test: repository preflight happens before a
 * thread starts, every thread snapshots one required project, and thread
 * provisioning consumes only the prepared local mirrors. No Incus or model.
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
supervisor.deleteProject(missing.id);
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

// Advance both upstreams after the readiness snapshot. Thread setup must use
// the checked OIDs, not silently fetch these newer commits.
fs.writeFileSync(path.join(primary.seed, "README.md"), "new upstream revision\n");
git(primary.seed, ...author, "commit", "-am", "advance primary");
git(primary.seed, "push", "origin", "main");
fs.writeFileSync(path.join(docs.seed, "DOCS.md"), "new upstream docs\n");
git(docs.seed, ...author, "commit", "-am", "advance docs");
git(docs.seed, "push", "origin", "main");

// Make the configured upstreams unavailable altogether. Seeding should
// still succeed from the prepared mirrors without hidden network/path I/O.
fs.renameSync(primary.bare, `${primary.bare}.offline`);
fs.renameSync(docs.bare, `${docs.bare}.offline`);

const thread = await supervisor.createUserThread(project.id);
const cubeName = supervisor.resolveUserThread(thread.id).cubeName;
await readyCube(registry, cubeName);
const cube = registry.getCube(cubeName)!;
assert.equal(fs.readFileSync(path.join(cube.workspacePath, "README.md"), "utf8"), "prepared revision\n");
assert.equal(
  fs.readFileSync(path.join(path.dirname(cube.workspacePath), "repos", "docs", "DOCS.md"), "utf8"),
  "prepared docs\n",
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
await assert.rejects(
  () => supervisor.pushBaseForUserThread(thread.id, repositories[1]!.id),
  /read-only references/,
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
assert.throws(() => supervisor.deleteProject(project.id), /still has threads/);
console.log("4 ok: project snapshot scopes repos/services, coalesces cancellation, labels threads, and preserves archived work");

await supervisor.removeUserThread(thread.id);
supervisor.deleteProject(project.id);
assert.equal(supervisor.listProjects().length, 0);
await supervisor.close();
registry.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("5 ok: project deletion is blocked by threads, then succeeds after teardown");
console.log("project-test: all ok");
