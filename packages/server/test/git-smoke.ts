/**
 * Manual smoke test for the Phase 3c git/PR flow against real Incus: a cube
 * provisioned WITH a repo gets its workspace seeded from the host-side
 * mirror; the agent-side clone looks normal (origin = upstream) but cannot
 * push (that is the boundary, PLAN §11); host-side diff shows in-cube
 * commits AND uncommitted work; host-side push lands the branch on the
 * upstream. Does not prompt a model; `gh` is not exercised (no auth in the
 * VM) — createPr's argv handling is covered offline in git-service-test.
 *
 *   sg incus-admin -c "node packages/server/test/git-smoke.ts"
 */
// High subnet band: never collide with the production daemon's bridges.
process.env.CUBED_SUBNET_MIN ??= "200";
// The fixture upstream is a local bare repo; local repos are gated off by
// default (they let the API clone arbitrary host paths) — opt in for the test.
process.env.CUBED_ALLOW_LOCAL_REPOS = "1";

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { IncusBackend, IncusClient, IncusSandbox } from "@cube/sandbox";

import { Registry } from "../src/registry.ts";
import { CubeSupervisor, DEFAULT_EGRESS_ALLOW } from "../src/supervisor.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-gittest-"));
const incus = new IncusClient();
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// Upstream fixture: bare repo, one commit on main.
const upstream = path.join(tmp, "upstream.git");
git(tmp, "init", "--bare", "-b", "main", upstream);
const seedClone = path.join(tmp, "seed-clone");
git(tmp, "clone", upstream, seedClone);
const cfg = ["-c", "user.name=test", "-c", "user.email=test@cube"];
fs.writeFileSync(path.join(seedClone, "README.md"), "seeded\n");
git(seedClone, ...cfg, "add", "-A");
git(seedClone, ...cfg, "commit", "-m", "init");
git(seedClone, "push", "origin", "main");

const docsUpstream = path.join(tmp, "docs-upstream.git");
git(tmp, "init", "--bare", "-b", "main", docsUpstream);
const docsSeed = path.join(tmp, "docs-seed");
git(tmp, "clone", docsUpstream, docsSeed);
fs.writeFileSync(path.join(docsSeed, "DOCS.md"), "docs seeded\n");
git(docsSeed, ...cfg, "add", "-A");
git(docsSeed, ...cfg, "commit", "-m", "init docs");
git(docsSeed, "push", "origin", "main");

const registry = new Registry(path.join(tmp, "cubed.db"));
const supervisor = new CubeSupervisor(registry, new IncusBackend(incus), {
  cubesRoot: path.join(tmp, "cubes"),
  reposRoot: path.join(tmp, "repos"),
  pool: "cube",
  image: process.env.CUBE_IMAGE ?? "cube-node",
  rootSize: "10GiB",
  dockerVolumeSize: "5GiB",
  egressAllow: DEFAULT_EGRESS_ALLOW,
  idleMs: 0,
  portalBase: "cube.internal",
  publicPort: 7777,
  prefer: [
    ["openai-codex", "gpt-5.6-luna"],
    ["deepseek", "deepseek-v4-pro"],
  ],
});

console.log("== create ready multi-repository project, then start a thread ==");
const project = supervisor.createProject({
  name: "git smoke",
  repositories: [
    { url: upstream },
    { url: docsUpstream, checkoutName: "docs" },
  ],
});
const deadline = Date.now() + 180_000;
for (;;) {
  const current = supervisor.getProject(project.id);
  if (current.status === "ready") break;
  if (current.status === "error") throw new Error(`project check failed: ${current.error}`);
  if (Date.now() > deadline) throw new Error("project check timed out");
  await new Promise((r) => setTimeout(r, 200));
}
const thread = await supervisor.createUserThread(project.id);
const cubeName = supervisor.resolveUserThread(thread.id).cubeName;
const provisionDeadline = Date.now() + 180_000;
for (;;) {
  const current = registry.getCube(cubeName)!;
  if (current.status === "ready") break;
  if (current.status === "error") throw new Error(`provision failed: ${current.error}`);
  if (Date.now() > provisionDeadline) throw new Error("provision timed out");
  await new Promise((r) => setTimeout(r, 2000));
}
const cube = registry.getCube(cubeName)!;
const snapshots = registry.listCubeRepositories(cube.id);
assert.equal(snapshots.length, 2);
assert.equal(snapshots[0]!.base, "main");
assert.equal(snapshots[0]!.branch, `cube/${cubeName.replace(/^t-/, "")}`);
assert.match(snapshots[0]!.baseOid, /^[0-9a-f]{40}$/);
assert.equal(snapshots[1]!.workspacePath, path.join(tmp, "cubes", cubeName, "repos", "docs"));
assert.equal(fs.readFileSync(path.join(cube.workspacePath, "README.md"), "utf8"), "seeded\n");
assert.equal(fs.readFileSync(path.join(path.dirname(cube.workspacePath), "repos", "docs", "DOCS.md"), "utf8"), "docs seeded\n");
assert.ok(fs.existsSync(path.join(cube.workspacePath, ".git")));
console.log("1 ok: project preflight prepared and seeded primary + additional repositories");

const repositories = await supervisor.repositoriesForUserThread(thread.id);
const primary = repositories[0]!;
const docs = repositories[1]!;

// 2. repository state through the thread-first facade
{
  assert.equal(primary.url, upstream);
  assert.equal(primary.base, "main");
  assert.equal(docs.path, "../repos/docs");
  assert.deepEqual(primary.state, { branch: `cube/${cubeName.replace(/^t-/, "")}`, dirty: false, ahead: 0 });
  assert.deepEqual(docs.state, { branch: `cube/${cubeName.replace(/^t-/, "")}`, dirty: false, ahead: 0 });
  console.log("2 ok: repositoriesForUserThread — both checkouts clean and independently addressed");
}

// 3. the agent's view: a normal clone; commit works, push dies at the boundary
const sandbox = new IncusSandbox(`cube-${cubeName}`, incus);
async function cubeExec(cmd: string): Promise<{ exitCode: number | null; out: string }> {
  let out = "";
  const { exitCode } = await sandbox.exec(cmd, {
    cwd: "/workspace",
    onData: (c) => (out += c.toString("utf8")),
  });
  return { exitCode, out };
}
{
  // safe.directory must come from global config (git ignores it via -c);
  // only needed when the shifted mount's ownership reads as another user.
  await cubeExec("git config --global --add safe.directory /workspace");
  const commit = await cubeExec(
    "echo agent-was-here >> README.md && git -c user.name=agent -c user.email=agent@cube commit -am agent-change",
  );
  assert.equal(commit.exitCode, 0, commit.out);
  const push = await cubeExec("git push origin HEAD 2>&1");
  assert.notEqual(push.exitCode, 0, "in-cube push must fail (egress boundary)");
  console.log("3 ok: in-cube commit lands; in-cube push refused");
}

// 4. host-side review separates the in-cube COMMIT from local untracked work.
fs.writeFileSync(path.join(cube.workspacePath, "notes.txt"), "uncommitted\n");
{
  const state = (await supervisor.repositoriesForUserThread(thread.id))[0]!.state!;
  assert.equal(state.ahead, 1);
  assert.equal(state.dirty, true);
  const diff = await supervisor.diffForUserThread(thread.id, primary.id);
  assert.deepEqual(diff.committed.files.map((f) => f.path), ["README.md"]);
  assert.deepEqual(diff.staged.files, []);
  assert.deepEqual(diff.unstaged.files, []);
  assert.deepEqual(diff.untracked, ["notes.txt"]);
  assert.deepEqual(diff.tracked, []);
  assert.equal(diff.dirty, true);
  assert.match(diff.committed.patch, /\+agent-was-here/);
  console.log("4 ok: host diff — in-cube commit in the patch; untracked flags dirty");
}

// 5. host-side push lands the branch on the upstream
{
  const branch = await supervisor.pushUserThread(thread.id, primary.id);
  assert.equal(branch, `cube/${cubeName.replace(/^t-/, "")}`);
  assert.equal(
    git(upstream, "rev-parse", `refs/heads/${branch}`),
    git(cube.workspacePath, "rev-parse", "HEAD"),
  );
  console.log("5 ok: host push — upstream ref at the workspace HEAD");
}

assert.equal(supervisor.listUserThreads()[0]!.project.id, project.id);
assert.equal(supervisor.listUserThreads()[0]!.project.name, "git smoke");
console.log("6 ok: every user thread carries its project in the global list");

console.log("== teardown ==");
await supervisor.removeUserThread(thread.id);
await supervisor.close();
registry.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("git-smoke: all ok");
