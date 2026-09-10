/**
 * Offline test: a host write failure at the very start of a provision or
 * a setup retry (ENOSPC, EACCES on the lifecycle directory) ends the
 * thread in `error` — deletable, explained, recorded — instead of an
 * escaped rejection that strands it in `creating` forever.
 *
 *   node packages/server/test/provision-failure-test.ts
 */
process.env.CUBED_ALLOW_LOCAL_REPOS = "1";

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MockBackend } from "@cube/sandbox";

import type { Lifecycle } from "../src/lifecycle.ts";
import { Registry } from "../src/registry.ts";
import { CubeSupervisor } from "../src/supervisor.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-provision-failure-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const author = ["-c", "user.name=test", "-c", "user.email=test@cube", "-c", "commit.gpgSign=false"];
const bare = path.join(tmp, "primary.git");
git(tmp, "init", "--bare", "-b", "main", bare);
const seed = path.join(tmp, "seed");
git(tmp, "clone", bare, seed);
fs.writeFileSync(path.join(seed, "README.md"), "failure\n");
git(seed, ...author, "add", "-A");
git(seed, ...author, "commit", "-m", "initial");
git(seed, "push", "origin", "main");

async function until(what: string, test: () => boolean, ms = 10_000): Promise<void> {
  for (const deadline = Date.now() + ms; !test(); ) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const registry = new Registry(path.join(tmp, "cubed.db"));
const supervisor = new CubeSupervisor(registry, new MockBackend(), {
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

// The lifecycle store is private; the test reaches in to make exactly one
// write fail the way a full disk does. The second save (the failed result)
// must still be attempted through the same instance.
const lifecycle = (supervisor as unknown as { lifecycle: Lifecycle }).lifecycle;
const realSave = lifecycle.save.bind(lifecycle);
let failNextSave = false;
let saves = 0;
lifecycle.save = (...args: Parameters<Lifecycle["save"]>) => {
  saves += 1;
  if (failNextSave) {
    failNextSave = false;
    throw new Error("ENOSPC: no space left on device, write");
  }
  return realSave(...args);
};

try {
  const project = supervisor.createProject({ name: "failure", repositories: [{ url: bare }] });
  await until("project check", () => supervisor.getProject(project.id).status !== "checking");
  assert.equal(supervisor.getProject(project.id).status, "ready");

  // ---------------------------------------- 1. the first provision write
  failNextSave = true;
  const { id } = await supervisor.createUserThread(project.id);
  const cubeName = supervisor.resolveUserThread(id).cubeName;
  await until("provision to settle", () => registry.getCube(cubeName)!.status !== "creating");
  const cube = registry.getCube(cubeName)!;
  assert.equal(cube.status, "error");
  assert.match(cube.error ?? "", /ENOSPC/, "the raw cause stays in the registry");
  const listed = supervisor.listUserThreads().find((t) => t.id === id)!;
  assert.equal(listed.state, "error");
  assert.match(listed.error ?? "", /out of disk space/, "the list translates it");
  const provision = registry.listEvents({ kind: "provision", cube: cubeName });
  const end = provision.find((e) => e.phase === null)!;
  assert.equal(end.ok, false);
  assert.match(end.detail ?? "", /ENOSPC/);
  assert.equal(end.thread, id);
  // The transition is released: sleep/wake/remove see a free cube, and the
  // delete that a stranded `creating` row could never take succeeds.
  await supervisor.removeUserThread(id);
  assert.equal(registry.getCube(cubeName), null);
  assert.equal(registry.listEvents({ kind: "destroy", cube: cubeName })[0]?.ok, true);
  console.log("1 ok: a failed first lifecycle write ends the thread in error, explained and deletable");

  // ------------------------------------------ 2. the setup retry's write
  const second = await supervisor.createUserThread(project.id);
  const secondCube = supervisor.resolveUserThread(second.id).cubeName;
  await until("second thread ready", () => registry.getCube(secondCube)!.status === "ready");
  const before = saves;
  failNextSave = true;
  await assert.rejects(supervisor.retrySetupForUserThread(second.id), /ENOSPC/);
  assert.equal(saves, before + 1, "the retry's first write is the one that failed");
  assert.equal(registry.getCube(secondCube)!.status, "error");
  assert.match(registry.getCube(secondCube)!.error ?? "", /ENOSPC/);
  const retry = registry.listEvents({ kind: "retry-setup", cube: secondCube });
  assert.equal(retry.length, 1);
  assert.equal(retry[0]!.ok, false);
  assert.match(retry[0]!.detail ?? "", /ENOSPC/);
  // Still repairable in place once the disk has room — the retry path
  // registered and released its transition correctly.
  await supervisor.retrySetupForUserThread(second.id);
  assert.equal(registry.getCube(secondCube)!.status, "ready");
  await supervisor.removeUserThread(second.id);
  assert.equal(registry.getCube(secondCube), null);
  console.log("2 ok: a failed retry write ends in error, is recorded, and the thread stays repairable and deletable");

  // -------------------------- 3. the failure record itself cannot be written
  const third = await supervisor.createUserThread(project.id);
  const thirdCube = supervisor.resolveUserThread(third.id).cubeName;
  await until("third thread ready", () => registry.getCube(thirdCube)!.status === "ready");
  // Every save fails from here: the running record cannot be closed either.
  lifecycle.save = () => { throw new Error("EACCES: permission denied, open"); };
  // The running record from a previous attempt is what the failure path
  // tries to close; plant one so the closing write is exercised.
  realSave(thirdCube, "setup", { state: "running", startedAt: Date.now(), durationMs: null, error: null });
  await assert.rejects(supervisor.retrySetupForUserThread(third.id), /EACCES/);
  assert.equal(registry.getCube(thirdCube)!.status, "error");
  const unrecorded = registry.listEvents({ kind: "lifecycle", cube: thirdCube });
  assert.equal(unrecorded.length, 1);
  assert.equal(unrecorded[0]!.ok, false);
  assert.match(unrecorded[0]!.detail ?? "", /could not be recorded: EACCES/);
  await supervisor.removeUserThread(third.id);
  console.log("3 ok: an unwritable failure record is an event, not an exception");

  await supervisor.close();
  console.log("ALL PASS: provision failure");
} finally {
  registry.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
