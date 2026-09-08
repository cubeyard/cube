/**
 * Manual smoke test for CubeSupervisor: registry-driven provisioning, egress
 * proxy on the cube's gateway, thread creation + reopen, sleep/wake (with
 * wake hooks from .cube/cube.toml), teardown. Needs Incus + the cube-node
 * image; does NOT prompt a model (thread creation only reads the model
 * catalog).
 *
 *   sg incus-admin -c "node packages/server/test/supervisor-smoke.ts"
 */
// High subnet band: never collide with the production daemon's bridges.
process.env.CUBED_SUBNET_MIN ??= "200";
process.env.CUBED_ALLOW_LOCAL_REPOS = "1";

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { IncusBackend, IncusClient, IncusSandbox } from "@cube/sandbox";

import { Registry, networkForCube } from "../src/registry.ts";
import { CubeSupervisor, DEFAULT_EGRESS_ALLOW, EGRESS_PROXY_PORT } from "../src/supervisor.ts";

const NAME = "suptest";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-suptest-"));
const incus = new IncusClient();
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const upstream = path.join(tmp, "upstream.git");
git(tmp, "init", "--bare", "-b", "main", upstream);
const seed = path.join(tmp, "seed");
git(tmp, "clone", upstream, seed);
fs.writeFileSync(path.join(seed, "README.md"), "supervisor smoke\n");
git(seed, "-c", "user.name=test", "-c", "user.email=test@cube", "add", "-A");
git(seed, "-c", "user.name=test", "-c", "user.email=test@cube", "commit", "-m", "init");
git(seed, "push", "origin", "main");

function makeSupervisor(registry: Registry): CubeSupervisor {
  return new CubeSupervisor(registry, new IncusBackend(incus), {
    cubesRoot: path.join(tmp, "cubes"),
    reposRoot: path.join(tmp, "repos"),
    pool: "cube",
    image: process.env.CUBE_IMAGE ?? "cube-node",
    rootSize: "10GiB",
    dockerVolumeSize: "5GiB",
    egressAllow: DEFAULT_EGRESS_ALLOW,
    idleMs: 0, // the smoke drives sleep/wake explicitly
    portalBase: "cube.localhost",
    publicPort: 7777,
    prefer: [
      ["openai-codex", "gpt-5.6-luna"],
      ["deepseek", "deepseek-v4-pro"],
    ],
  });
}

let registry = new Registry(path.join(tmp, "cubed.db"));
let supervisor = makeSupervisor(registry);
const project = supervisor.createProject({
  name: "supervisor smoke",
  repositories: [{ url: upstream }],
});
for (;;) {
  const current = supervisor.getProject(project.id);
  if (current.status === "ready") break;
  if (current.status === "error") throw new Error(`project check failed: ${current.error}`);
  await new Promise((resolve) => setTimeout(resolve, 100));
}

// Clean slate from previous aborted runs (instance may exist outside the
// fresh registry).
const { destroyCube } = await import("@cube/sandbox");
await destroyCube(
  incus,
  { name: `cube-${NAME}`, pool: "cube", network: { bridge: `cbr-${NAME}` } },
  { deleteVolume: true, deleteBridge: true },
);

console.log("== createCube (async provision) ==");
const row = supervisor.createCube(NAME);
assert.equal(row.status, "creating");
const deadline = Date.now() + 180_000;
for (;;) {
  const cube = registry.getCube(NAME)!;
  if (cube.status === "ready") break;
  if (cube.status === "error") throw new Error(`provision failed: ${cube.error}`);
  if (Date.now() > deadline) throw new Error("provision timed out");
  await new Promise((r) => setTimeout(r, 2000));
}
console.log("1 ok: cube provisioned to ready");

const cube = registry.getCube(NAME)!;
const network = networkForCube(NAME, cube.subnetIndex);

// 2. egress proxy is listening on the bridge gateway
await new Promise<void>((resolve, reject) => {
  const socket = net.connect(EGRESS_PROXY_PORT, network.gateway, () => {
    socket.destroy();
    resolve();
  });
  socket.on("error", reject);
});
console.log(`2 ok: egress proxy listening on ${network.gateway}:${EGRESS_PROXY_PORT}`);

// 3. volume registered
const volumes = registry.listVolumes(cube.id);
assert.equal(volumes.length, 1);
assert.equal(volumes[0]!.poolVolume, `cube/cube-${NAME}-docker`);
console.log("3 ok: docker volume registered");

// 4. exec works in the provisioned cube
{
  const sandbox = new IncusSandbox(`cube-${NAME}`, incus);
  let out = "";
  const { exitCode } = await sandbox.exec("hostname && id -un", {
    cwd: "/workspace",
    onData: (c) => (out += c.toString("utf8")),
  });
  assert.equal(exitCode, 0, out);
  assert.match(out, /cube-suptest/);
  assert.match(out, /dev/);
  console.log("4 ok: exec as dev in the cube");
}

// 5. restart simulation: a fresh supervisor rediscovers the admin cube and
// restarts its host-side proxy without creating a projectless thread.
await supervisor.close();
supervisor = makeSupervisor(registry);
await supervisor.boot();
assert.equal(registry.getCube(NAME)!.status, "ready");
// proxy came back too
await new Promise<void>((resolve, reject) => {
  const socket = net.connect(EGRESS_PROXY_PORT, network.gateway, () => {
    socket.destroy();
    resolve();
  });
  socket.on("error", reject);
});
console.log("5 ok: supervisor restart — admin cube ready and proxy back, no thread invented");

// 6. sleep: instance stops
await supervisor.sleepCube(NAME);
assert.equal(registry.getCube(NAME)!.status, "asleep");
assert.equal((await incus.getInstanceState(`cube-${NAME}`)).status, "Stopped");
await supervisor.sleepCube(NAME); // idempotent
console.log("6 ok: sleepCube stopped the instance");

// 7. restart while asleep: boot leaves it asleep (no proxy start, no error)
await supervisor.close();
supervisor = makeSupervisor(registry);
await supervisor.boot();
assert.equal(registry.getCube(NAME)!.status, "asleep");
console.log("7 ok: cubed restart while asleep — cube stays asleep");

// 8. wake: gated on the cube network, proxy re-created (old one died with
// the previous supervisor), wake hook from .cube/cube.toml runs in the cube
const workspace = registry.getCube(NAME)!.workspacePath;
fs.mkdirSync(path.join(workspace, ".cube"), { recursive: true });
fs.writeFileSync(
  path.join(workspace, ".cube", "cube.toml"),
  `[wake]\nhooks = [\n  "echo woke-$(id -un) >> .cube/woke-marker",\n]\n`,
);
// Concurrent wakes must coalesce on one transition — the appending hook
// runs exactly once (double `incus start` + double hooks was a sol finding).
await Promise.all([supervisor.wakeCube(NAME), supervisor.wakeCube(NAME)]);
const woken = registry.getCube(NAME)!;
assert.equal(woken.status, "ready");
assert.equal(woken.error, null, `wake hook failed: ${woken.error}`);
// hook ran as dev in /workspace -> marker is visible host-side; one line only
assert.equal(fs.readFileSync(path.join(workspace, ".cube", "woke-marker"), "utf8").trim(), "woke-dev");
await new Promise<void>((resolve, reject) => {
  const socket = net.connect(EGRESS_PROXY_PORT, network.gateway, () => {
    socket.destroy();
    resolve();
  });
  socket.on("error", reject);
});
await supervisor.wakeCube(NAME); // idempotent on ready
{
  const sandbox = new IncusSandbox(`cube-${NAME}`, incus);
  let out = "";
  const { exitCode } = await sandbox.exec("getent hosts registry.npmjs.org >/dev/null && echo dns-ok", {
    cwd: "/workspace",
    onData: (c) => (out += c.toString("utf8")),
  });
  assert.equal(exitCode, 0, out);
  assert.match(out, /dns-ok/);
}
console.log("8 ok: wakeCube — ready, hook ran, proxy re-created, gateway DNS up");

// 9. a failing wake hook leaves the cube ready but records the error
await supervisor.sleepCube(NAME);
fs.writeFileSync(path.join(workspace, ".cube", "cube.toml"), `[wake]\nhooks = ["exit 7"]\n`);
await supervisor.wakeCube(NAME);
const hookFailed = registry.getCube(NAME)!;
assert.equal(hookFailed.status, "ready");
assert.match(hookFailed.error ?? "", /exit 7/);
console.log("9 ok: failing wake hook -> ready with error recorded");

// 10. thread-first facade: the thread exists (and is addressable) before
// its sandbox does; wakeCube settles on the provisioning transition — the
// exact path prompt-before-ready takes.
const ut = await supervisor.createUserThread(project.id);
const utCube = supervisor.resolveUserThread(ut.id).cubeName;
assert.match(utCube, /^t-[a-z0-9]{8}$/);
assert.equal(registry.getCube(utCube)!.status, "creating");
{
  const entry = supervisor.listUserThreads().find((t) => t.id === ut.id)!;
  assert.equal(entry.state, "setting-up");
  assert.equal(entry.title, null);
}
await assert.rejects(supervisor.removeUserThread(ut.id), /busy provisioning/);
await supervisor.wakeCube(utCube); // resolves once provisioning completes
assert.equal(registry.getCube(utCube)!.status, "ready");
assert.equal(supervisor.listUserThreads().find((t) => t.id === ut.id)!.state, "ready");
console.log("10 ok: facade — thread before sandbox, wake settled on provisioning");

// 11. thread states follow the invisible cube; delete destroys it
await supervisor.sleepCube(utCube);
assert.equal(supervisor.listUserThreads().find((t) => t.id === ut.id)!.state, "sleeping");
await supervisor.removeUserThread(ut.id);
assert.equal(registry.getCube(utCube), null);
assert.ok(!supervisor.listUserThreads().some((t) => t.id === ut.id));
console.log("11 ok: facade — sleeping state surfaced, delete removed thread + cube");

// 12. explicit admin-cube teardown
await supervisor.removeCube(NAME, { deleteVolume: true });
assert.equal(registry.getCube(NAME), null);
console.log("12 ok: admin cube torn down without ever creating a thread");

await supervisor.close();
registry.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("supervisor-smoke: all ok");
process.exit(0);
