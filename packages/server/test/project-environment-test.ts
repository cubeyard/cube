/**
 * Offline integration test: a project keeps its environment (.cube: setup,
 * resume, cube.toml) in a folder of a reference repository, for a primary
 * repository that ships none. Validation, the project check against the
 * pinned commit, the lifecycle scripts running from /repos with /workspace
 * as cwd, services and `[network] allow` read from there, and the proxy
 * following an edited declaration. No Incus or model.
 *
 *   node packages/server/test/project-environment-test.ts
 */
process.env.CUBED_ALLOW_LOCAL_REPOS = "1";

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MockBackend, type EgressProxyOptions } from "@cube/sandbox";

import { Registry } from "../src/registry.ts";
import { CubeSupervisor, type ProjectInfo } from "../src/supervisor.ts";

class RecordingBackend extends MockBackend {
  proxies: EgressProxyOptions[] = [];
  closed = 0;
  override async startEgressProxy(opts: EgressProxyOptions) {
    this.proxies.push(opts);
    const proxy = await super.startEgressProxy(opts);
    return { ...proxy, close: async () => { this.closed += 1; await proxy.close(); } };
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-project-environment-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const author = ["-c", "user.name=test", "-c", "user.email=test@cube", "-c", "commit.gpgSign=false"];

function upstream(name: string, files: Record<string, { content: string; mode?: number }>): string {
  const bare = path.join(tmp, `${name}.git`);
  git(tmp, "init", "--bare", "-b", "main", bare);
  const seed = path.join(tmp, `${name}-seed`);
  git(tmp, "clone", bare, seed);
  for (const [file, { content, mode }] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.writeFileSync(path.join(seed, file), content, { mode: mode ?? 0o644 });
  }
  git(seed, ...author, "add", "-A");
  git(seed, ...author, "commit", "-m", "initial");
  git(seed, "push", "origin", "main");
  return bare;
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
    const status = registry.getCube(name)?.status;
    if (status !== "creating" && status !== "waking") return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`cube ${name} timed out`);
}

// The primary carries no .cube at all — the team has not adopted cube.
const app = upstream("app", { "README.md": { content: "an app\n" } });
// The user's own environments repository: one folder per project.
const envs = upstream("envs", {
  "gradle-app/.cube/setup": {
    content: "#!/bin/sh\nprintf '%s\\n%s\\n' \"$(pwd)\" \"$0\" > environment-marker\necho setup >> lifecycle\n",
    mode: 0o755,
  },
  "gradle-app/.cube/resume": { content: "#!/bin/sh\necho resume >> lifecycle\n", mode: 0o755 },
  "gradle-app/.cube/cube.toml": {
    content: '[network]\nallow = ["services.gradle.org", "*.gradle.org"]\n\n[services.web]\ncommand = "sleep 1000"\n',
  },
  "broken/.cube/cube.toml": { content: '[network]\nallow = ["https://github.com"]\n' },
  "nocube/README.md": { content: "nothing here\n" },
});

const registry = new Registry(path.join(tmp, "cubed.db"));
const backend = new RecordingBackend();
const supervisor = new CubeSupervisor(registry, backend, {
  cubesRoot: path.join(tmp, "cubes"), reposRoot: path.join(tmp, "mirrors"), pool: "mock", image: "mock",
  rootSize: "1MiB", dockerVolumeSize: "1MiB", egressAllow: ["registry.npmjs.org"], idleMs: 0,
  portalBase: "cube.localhost", publicPort: 7777,
});

try {
  // --- 1. validation: the environment names a reference, never the primary
  const reference = { url: envs, checkoutName: "envs" };
  assert.throws(
    () => supervisor.createProject({ name: "p", repositories: [{ url: app }], environment: "envs/gradle-app" }),
    /needs a reference repository to live in/,
  );
  assert.throws(
    () => supervisor.createProject({ name: "p", repositories: [{ url: app }, reference], environment: "workspace/x" }),
    /must start with a reference checkout name \(envs\)/,
  );
  assert.throws(
    () => supervisor.createProject({ name: "p", repositories: [{ url: app }, reference], environment: "envs/../x" }),
    /letters, numbers, dot, dash, or underscore/,
  );
  assert.throws(
    () => supervisor.createProject({ name: "p", repositories: [{ url: app }, reference], environment: "envs/.git" }),
    /letters, numbers, dot, dash, or underscore/,
  );
  assert.equal(registry.listProjects().length, 0);
  console.log("1 ok: environment must be <reference checkout>/<plain folders>");

  // --- 2. the project check verifies the folder and its cube.toml at the pinned commit
  const project = supervisor.createProject({
    name: "gradle app", repositories: [{ url: app }, reference], environment: "/envs/nocube/",
  });
  assert.equal(project.environment, "envs/nocube", "canonical form: no surrounding slashes");
  let checked = await settled(supervisor, project.id);
  assert.equal(checked.status, "error");
  assert.match(checked.error ?? "", /environment: no nocube\/\.cube in envs at main @ [0-9a-f]{8}/);
  assert.ok(checked.repositories.every((repo) => repo.status === "ready"), "the repositories themselves passed");
  await assert.rejects(supervisor.createUserThread(project.id), /not ready/);

  supervisor.updateProject(project.id, { name: "gradle app", repositories: [{ url: app }, reference], environment: "envs/broken" });
  checked = await settled(supervisor, project.id);
  assert.equal(checked.status, "error");
  assert.match(checked.error ?? "", /environment: envs\/broken\/\.cube\/cube\.toml: network\.allow entry "https:\/\/github\.com" must be a hostname/);
  console.log("2 ok: a missing folder or a broken cube.toml is a project error, not a thread that fails later");

  // --- 3. a good environment: setup/resume run from /repos with /workspace as cwd
  supervisor.updateProject(project.id, { name: "gradle app", repositories: [{ url: app }, reference], environment: "envs/gradle-app" });
  checked = await settled(supervisor, project.id);
  assert.equal(checked.status, "ready", checked.error ?? "");
  assert.equal(checked.environment, "envs/gradle-app");

  // A once-valid declaration can disappear or become invalid upstream.
  // Refresh must revalidate the newly fetched reference before allocation.
  const envSeed = path.join(tmp, "envs-seed");
  const tomlPath = path.join(envSeed, "gradle-app/.cube/cube.toml");
  const originalToml = fs.readFileSync(tomlPath, "utf8");
  fs.writeFileSync(tomlPath, '[network]\nallow = ["https://invalid.example"]\n');
  git(envSeed, ...author, "commit", "-am", "break environment declaration");
  git(envSeed, "push", "origin", "main");
  await assert.rejects(supervisor.createUserThread(project.id), /environment:.*must be a hostname/);
  assert.equal(registry.listCubes().length, 0);
  git(envSeed, "rm", "-r", "gradle-app/.cube");
  git(envSeed, ...author, "commit", "-m", "remove environment");
  git(envSeed, "push", "origin", "main");
  await assert.rejects(supervisor.createUserThread(project.id), /environment: no gradle-app\/\.cube/);
  assert.equal(registry.listCubes().length, 0);
  git(envSeed, "checkout", "HEAD~2", "--", "gradle-app/.cube");
  fs.writeFileSync(tomlPath, originalToml);
  git(envSeed, ...author, "commit", "-m", "restore environment");
  git(envSeed, "push", "origin", "main");

  const thread = await supervisor.createUserThread(project.id);
  const cubeName = supervisor.resolveUserThread(thread.id).cubeName;
  await cubeSettled(registry, cubeName);
  const cube = registry.getCube(cubeName)!;
  assert.equal(cube.status, "ready", cube.error ?? "");
  assert.equal(cube.environment, "envs/gradle-app", "the cube snapshots the project's choice");
  assert.equal(fs.existsSync(path.join(cube.workspacePath, ".cube")), false, "nothing was copied into the primary checkout");
  const [cwd, script] = fs.readFileSync(path.join(cube.workspacePath, "environment-marker"), "utf8").split("\n");
  assert.equal(cwd, fs.realpathSync(cube.workspacePath), "setup ran with the workspace as cwd");
  assert.equal(script, "./../repos/envs/gradle-app/.cube/setup", "from the reference folder, relative to the workspace");
  assert.equal(fs.readFileSync(path.join(cube.workspacePath, "lifecycle"), "utf8"), "setup\nresume\n");
  const environment = supervisor.environmentForUserThread(thread.id);
  assert.equal(environment.setup.state, "succeeded");
  assert.equal(environment.resume.state, "succeeded");
  assert.equal(environment.directory, "/repos/envs/gradle-app/.cube");
  console.log("3 ok: setup and resume run from the reference folder; status names the directory");

  // --- 4. cube.toml is read from there too: services, and [network] allow on the proxy
  assert.deepEqual(supervisor.listServicesForUserThread(thread.id).map((service) => service.name), ["web"]);
  const provisionProxy = backend.proxies.at(-1)!;
  assert.deepEqual(provisionProxy.allow, ["registry.npmjs.org", "services.gradle.org", "*.gradle.org"],
    "defaults/operator list first, then the declaration");
  console.log("4 ok: services and the egress allowlist come from the environment folder");

  // --- 5. an edited declaration applies on the next wake; a broken one fails the wake loudly
  const proxiesBefore = backend.proxies.length;
  const closedBefore = backend.closed;
  const declaration = path.join(path.dirname(cube.workspacePath), "repos", "envs", "gradle-app", ".cube", "cube.toml");
  await supervisor.sleepCube(cubeName);
  await supervisor.wakeCube(cubeName);
  assert.equal(backend.proxies.length, proxiesBefore, "same policy: the proxy that survived the sleep is kept");
  fs.writeFileSync(declaration, '[network]\nallow = ["services.gradle.org", "*.gradle.org", "repo.maven.apache.org"]\n');
  await supervisor.sleepCube(cubeName);
  await supervisor.wakeCube(cubeName);
  assert.equal(backend.closed, closedBefore + 1, "changed policy: the old proxy is closed");
  assert.deepEqual(backend.proxies.at(-1)!.allow, ["registry.npmjs.org", "services.gradle.org", "*.gradle.org", "repo.maven.apache.org"]);
  fs.writeFileSync(declaration, '[network]\nallow = ["not a host"]\n');
  await supervisor.sleepCube(cubeName);
  await assert.rejects(supervisor.wakeCube(cubeName), /network\.allow entry "not a host" must be a hostname/);
  assert.equal(registry.getCube(cubeName)!.status, "error");
  assert.match(registry.getCube(cubeName)!.error ?? "", /network\.allow entry "not a host"/);
  fs.writeFileSync(declaration, '[network]\nallow = ["services.gradle.org"]\n');
  await supervisor.wakeCube(cubeName);
  assert.equal(registry.getCube(cubeName)!.status, "ready");
  assert.deepEqual(backend.proxies.at(-1)!.allow, ["registry.npmjs.org", "services.gradle.org"]);
  console.log("5 ok: the proxy follows the declaration at wake; a parse error fails the wake with the entry");

  // --- 6. clearing the environment: new threads use the primary's own .cube; old ones keep their snapshot
  supervisor.updateProject(project.id, { name: "gradle app", repositories: [{ url: app }, reference], environment: null });
  checked = await settled(supervisor, project.id);
  assert.equal(checked.status, "ready");
  assert.equal(checked.environment, null);
  const plain = await supervisor.createUserThread(project.id);
  const plainCube = supervisor.resolveUserThread(plain.id).cubeName;
  await cubeSettled(registry, plainCube);
  assert.equal(registry.getCube(plainCube)!.status, "ready");
  assert.equal(registry.getCube(plainCube)!.environment, null);
  assert.equal(fs.existsSync(path.join(registry.getCube(plainCube)!.workspacePath, "environment-marker")), false);
  assert.equal(supervisor.environmentForUserThread(plain.id).directory, "/workspace/.cube");
  assert.equal(supervisor.environmentForUserThread(thread.id).directory, "/repos/envs/gradle-app/.cube");
  assert.deepEqual(supervisor.listServicesForUserThread(plain.id), []);
  console.log("6 ok: the environment is snapshotted per thread");

  for (const id of [thread.id, plain.id]) await supervisor.removeUserThread(id);
  await supervisor.deleteProject(project.id);
  console.log("project-environment-test: all ok");
} finally {
  await supervisor.close();
  registry.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
