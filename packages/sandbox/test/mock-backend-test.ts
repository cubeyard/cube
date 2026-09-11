/**
 * Offline units for the mock cube backend (CUBED_BACKEND=mock, ARCHITECTURE §13
 * 3d.3): the in-memory instance table, the no-op egress proxy, and local
 * exec with the guest workspace path rebased onto the real host workspace.
 * No Incus, no daemon.
 *
 *   node packages/sandbox/test/mock-backend-test.ts
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MockBackend } from "../src/index.ts";
import type { CubeProvisionSpec } from "../src/index.ts";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "cube-mock-"));
const hostWorkspace = path.join(base, "workspace");
const hostRepositories = path.join(base, "repos");
const NAME = "cube-mocktest";

const spec: CubeProvisionSpec = {
  name: NAME,
  image: "cube-node",
  pool: "cube",
  rootSize: "10GiB",
  dockerVolumeSize: "5GiB",
  hostWorkspace,
  guestWorkspace: "/workspace",
  hostRepositories,
  guestRepositories: "/repos",
  network: {
    bridge: "cbr-mocktest",
    subnet: "10.90.9.1/24",
    gateway: "10.90.9.1",
    ip: "10.90.9.2",
    nat: true,
  },
};

// ------------------------------------------------- 1. provision + lifecycle
{
  const backend = new MockBackend();
  assert.equal(backend.kind, "mock");
  assert.equal((await backend.getState(NAME)).status, "Stopped", "unknown instance reads Stopped");

  await backend.provision(spec);
  assert.ok(fs.existsSync(hostWorkspace), "provision creates the host workspace");
  assert.equal((await backend.getState(NAME)).status, "Running", "provisioned cube is Running");
  await backend.waitForNetwork(NAME, spec.network.ip); // resolves instantly

  await backend.setState(NAME, "stop");
  assert.equal((await backend.getState(NAME)).status, "Stopped", "stop -> Stopped");
  await backend.setState(NAME, "start");
  assert.equal((await backend.getState(NAME)).status, "Running", "start -> Running");
  console.log("1 ok: provision / state / network");
}

// ------------------------------------------------- 2. egress proxy is a stub
{
  const backend = new MockBackend();
  const proxy = await backend.startEgressProxy({
    listenHost: "10.90.9.1",
    port: 3128,
    allow: ["registry.npmjs.org"],
  });
  assert.equal(proxy.port, 3128, "proxy reports the requested port");
  await proxy.close(); // no throw
  console.log("2 ok: egress proxy stub");
}

// ------------------------------------------------- 3. exec rebases the cwd
{
  const backend = new MockBackend();
  await backend.provision(spec);
  fs.writeFileSync(path.join(hostWorkspace, "marker.txt"), "hello");

  const sandbox = backend.sandbox(NAME);
  let out = "";
  // cwd "/workspace" (guest) must resolve to hostWorkspace and see the file.
  const r = await sandbox.exec("cat marker.txt", {
    cwd: "/workspace",
    onData: (c) => (out += c.toString("utf8")),
  });
  assert.equal(r.exitCode, 0, "exec succeeds");
  assert.ok(out.includes("hello"), "exec runs in the host workspace");

  // a guest subpath rebases too
  fs.mkdirSync(path.join(hostWorkspace, "sub"));
  fs.writeFileSync(path.join(hostWorkspace, "sub", "f"), "deep");
  let out2 = "";
  await sandbox.exec("cat f", { cwd: "/workspace/sub", onData: (c) => (out2 += c.toString("utf8")) });
  assert.ok(out2.includes("deep"), "guest subpath rebases onto the host workspace");

  fs.mkdirSync(path.join(hostRepositories, "docs"), { recursive: true });
  fs.writeFileSync(path.join(hostRepositories, "docs", "README.md"), "additional");
  let reposOut = "";
  await sandbox.exec("cat README.md", {
    cwd: "/repos/docs",
    onData: (c) => (reposOut += c.toString("utf8")),
  });
  assert.ok(reposOut.includes("additional"), "additional repository cwd rebases onto /repos");

  // bash login-shell semantics, not sh: a bash-ism the Incus path allows must
  // work here too (else the mock gives a false dev signal).
  let out3 = "";
  const bashism = await sandbox.exec("[[ 1 == 1 ]] && echo yes", {
    cwd: "/workspace",
    onData: (c) => (out3 += c.toString("utf8")),
  });
  assert.equal(bashism.exitCode, 0, "bash-ism succeeds");
  assert.ok(out3.includes("yes"), "runs under bash, not sh");
  console.log("3 ok: exec rebases primary + additional repositories (bash semantics)");
}

// ---------------------------------------- 3b. unmapped cube fails loudly
{
  const backend = new MockBackend();
  // No provision: sandbox() has no workspace mapping. Running a hook must
  // throw, not silently run in the server repo (sol finding 3).
  const sandbox = backend.sandbox("cube-never-provisioned");
  await assert.rejects(
    () => sandbox.exec("pwd", { cwd: "/workspace", onData: () => {} }),
    /no workspace mapping/,
    "an un-provisioned cube throws instead of running in process.cwd()",
  );
  console.log("3b ok: unmapped cube exec fails loudly");
}

// ------------------------------------------------- 4. exit codes + missing bin
{
  const backend = new MockBackend();
  await backend.provision(spec);
  const sandbox = backend.sandbox(NAME);
  const bad = await sandbox.exec("exit 7", { cwd: "/workspace", onData: () => {} });
  assert.equal(bad.exitCode, 7, "non-zero exit is surfaced");

  // execSimple runs argv; a missing binary reads as a failed exec (null), no throw.
  const missing = await backend.execSimple(NAME, ["definitely-not-a-real-binary-xyz"]);
  assert.equal(missing, null, "missing binary -> null, not a throw");
  const ok = await backend.execSimple(NAME, ["true"]);
  assert.equal(ok, 0, "argv exec returns the exit code");
  console.log("4 ok: exit codes and missing binaries");
}

// ------------------------------------------------- 5. timeout kills the tree
{
  const backend = new MockBackend();
  await backend.provision(spec);
  const sandbox = backend.sandbox(NAME);
  // A hook that backgrounds a sleep and writes a marker AFTER it: if the
  // timeout only killed the immediate shell, the backgrounded sleep would
  // survive and the marker would appear. The process-group kill must stop it.
  const marker = path.join(hostWorkspace, "SURVIVED.txt");
  await assert.rejects(
    () =>
      sandbox.exec("(sleep 3 && touch SURVIVED.txt) & sleep 5", {
        cwd: "/workspace",
        onData: () => {},
        timeout: 1,
      }),
    /timeout:1/,
    "a command past its timeout rejects",
  );
  // Give any surviving descendant longer than its own sleep to prove it's dead.
  await new Promise((r) => setTimeout(r, 3500));
  assert.ok(!fs.existsSync(marker), "backgrounded descendant was killed with the tree");
  console.log("5 ok: exec timeout kills the whole process group");
}

// ------------------------------------------------- 5b. abort settles + kills
{
  const backend = new MockBackend();
  await backend.provision(spec);
  const sandbox = backend.sandbox(NAME);
  const ac = new AbortController();
  const p = sandbox.exec("sleep 30", { cwd: "/workspace", onData: () => {}, signal: ac.signal });
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(() => p, /aborted/, "an aborted command rejects (does not hang)");
  console.log("5b ok: abort rejects and terminates");
}

// ------------------------------------------------- 6. destroy
{
  const backend = new MockBackend();
  await backend.provision(spec);
  await backend.destroy({ name: NAME, pool: "cube", network: { bridge: "cbr-mocktest" } });
  assert.equal((await backend.getState(NAME)).status, "Stopped", "destroyed cube reads Stopped");
  assert.ok(fs.existsSync(hostWorkspace), "destroy leaves the host workspace (parity with Incus)");
  console.log("6 ok: destroy drops the instance, keeps the workspace");
}

// --------------------------------------- 7. templates
{
  const backend = new MockBackend();
  assert.equal(await backend.resolveImage("cube-node"), "mock-image:cube-node");
  const template = { instance: NAME, snapshot: "env", volume: `${NAME}-docker`, volumeSnapshot: "env" };
  await assert.rejects(backend.provision({ ...spec, name: "clone", template }), /template .* does not exist/);
  await backend.provision(spec);
  assert.deepEqual(await backend.captureTemplate(spec, "env"), template);
  assert.equal((await backend.getState(NAME)).status, "Stopped", "capture stops the builder");
  await backend.provision({ ...spec, name: "clone", hostWorkspace: path.join(base, "clone"), template });
  assert.deepEqual(backend.clones, [{ name: "clone", template: NAME }]);
  assert.equal((await backend.getState("clone")).status, "Running");
  await backend.deleteTemplate("mock", template);
  assert.equal(backend.templates.size, 0);
  assert.equal((await backend.getState(NAME)).status, "Stopped", "the template instance is gone; the clone lives on");
  assert.equal((await backend.getState("clone")).status, "Running");
  console.log("7 ok: template capture, clone bookkeeping and deletion");
}

// ------------------------------------ 8. the cube's own home
{
  // `bash -lc` mirrors the real cube's `su - dev`. With HOME unset bash falls
  // back to the host passwd entry and sources the DEVELOPER's ~/.profile:
  // its output would appear in the cube's command output (breaking every
  // exact-output assertion) and its exports would leak into the cube.
  const backend = new MockBackend();
  await backend.provision(spec);
  let output = "";
  const { exitCode } = await backend.sandbox(NAME).exec('printf "%s" "$HOME"', {
    cwd: "/workspace",
    onData: (chunk) => { output += chunk.toString(); },
  });
  assert.equal(exitCode, 0);
  assert.notEqual(output, os.homedir(), "a mock cube must not run in the host developer's home");
  assert.ok(output.startsWith(os.tmpdir()), `cube home under the temp dir, got ${output}`);
  assert.ok(!fs.existsSync(path.join(output, ".profile")), "the cube's home holds no host login profile");
  let quiet = "";
  await backend.sandbox(NAME).exec("printf alive", {
    cwd: "/workspace",
    onData: (chunk) => { quiet += chunk.toString(); },
  });
  assert.equal(quiet, "alive", "no host profile noise in combined output");
  console.log("8 ok: mock cubes get their own empty home, not the host developer's");
}

fs.rmSync(base, { recursive: true, force: true });
console.log("mock-backend: all ok");
