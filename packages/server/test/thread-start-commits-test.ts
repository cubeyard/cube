/** A new thread starts at its repositories' latest commits, not at the
 * project's last check: through cubed's HTTP route and over a local guest
 * (the real guest helper under a temporary root), with the upstream
 * advancing after the check, its default branch moving, a replayed request,
 * a second activation of a started thread, an unreachable upstream and a
 * project edited while its commits were fetched. Disposable state. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { Registry } from "../src/registry.ts";
import { LocalMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-thread-start-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Cube Test", "-c", "user.email=cube@example.invalid",
  "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" }).trim();
const upstream = path.join(root, "upstream");
fs.mkdirSync(upstream);
git(upstream, "init", "-q", "--initial-branch=main");
const commit = (text: string) => {
  fs.writeFileSync(path.join(upstream, "README"), `${text}\n`);
  git(upstream, "add", "README");
  git(upstream, "commit", "-qm", text);
  return git(upstream, "rev-parse", "HEAD");
};
const first = commit("first");

const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("done")));
const models = createModels();
models.setProvider(faux.provider);
const machines = new LocalMachines(path.join(root, "machines"));
const app = await createCubed({ state: path.join(root, "state"), models, machines, claude: null, gateway: null });
for (let index = 0; index < 6; index++) {
  app.registry.enrollRunner({ nodeId: `node-${index}`, threadId: `runner-${index}`, environmentId: index + 1,
    configPath: `/private/runner-${index}.json`, configHash: `hash-${index}` });
}
await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
const address = app.server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;
const post = (route: string, body: unknown, method = "POST") => fetch(`${base}${route}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const model = { provider: faux.getModel().provider, id: faux.getModel().id };
const start = async (projectId: string, requestId: string) => {
  const response = await post("/api/threads", { projectId, requestId, text: "hello", model });
  return { status: response.status, body: await response.json() as { id?: string; error?: string } };
};
const pins = (id: string) => app.registry.getThread(id)!.allocation.repositories.map(repository => [repository.base, repository.baseOid]);
async function ready(id: string) {
  for (const deadline = Date.now() + 30_000; app.registry.getThread(id)!.workspaceState !== "available"; await delay(25)) {
    assert.ok(Date.now() < deadline, `thread ${id} becomes ready: ${app.conversations.error(id)}`);
  }
}
const head = (id: string) => git(path.join(machines.root, id, "workspace"), "rev-parse", "HEAD");

try {
  const created = await (await post("/api/projects", { name: "advancing", repositories: [{ url: upstream }] })).json();
  const project = created.project as { id: string; repositories: Array<{ baseOid: string }> };
  assert.equal(project.repositories[0].baseOid, first, "the check resolved the first commit");

  // 1. The upstream advances after the check: a new thread starts at the
  //    new commit, and its machine checks out that commit.
  const second = commit("second");
  const one = await start(project.id, "one");
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.deepEqual(pins(one.body.id!), [["main", second]], "pinned to the commit upstream has now, not the last check's");
  await ready(one.body.id!);
  assert.equal(head(one.body.id!), second, "the machine's checkout is the pinned commit");
  assert.deepEqual(app.registry.getThread(one.body.id!)!.workspaceBase, { remote: upstream, ref: "refs/heads/main", oid: second });
  console.log("ok: a new thread starts at the upstream's latest commit, not at the project's last check");

  // 2. A replayed request, a later activation and the agent's own edits
  //    keep the thread at its original commit while upstream moves on.
  const third = commit("third");
  fs.writeFileSync(path.join(machines.root, one.body.id!, "workspace", "README"), "the agent's edit\n");
  const replay = await start(project.id, "one");
  assert.deepEqual(replay.body, one.body, "a replay returns the same thread");
  await app.conversations.activate(one.body.id!);
  assert.deepEqual(pins(one.body.id!), [["main", second]], "a replay or reactivation resolves nothing again");
  assert.equal(head(one.body.id!), second);
  assert.equal(fs.readFileSync(path.join(machines.root, one.body.id!, "workspace", "README"), "utf8"), "the agent's edit\n", "the agent's edit is kept");
  const two = await start(project.id, "two");
  assert.deepEqual(pins(two.body.id!), [["main", third]], "the next new thread starts at the newest commit");
  console.log("ok: replays and reactivation keep a thread's commit and edits; the next new thread takes the newest");

  // 3. The default branch is asked of the remote again: a project without
  //    a configured branch follows the remote's HEAD when it moves.
  git(upstream, "checkout", "-q", "-b", "trunk");
  const trunk = commit("trunk");
  const three = await start(project.id, "three");
  assert.deepEqual(pins(three.body.id!), [["trunk", trunk]], "the default branch the remote advertises now");
  git(upstream, "checkout", "-q", "main");
  console.log("ok: the default branch is discovered again at each thread start");

  // 4. An upstream that cannot be fetched starts no thread; it is not
  //    started at the commits cubed already had.
  const threads = app.registry.listThreads().length;
  fs.renameSync(upstream, `${upstream}.away`);
  const failed = await start(project.id, "four");
  assert.equal(failed.status, 502, "an upstream failure, not a conflict");
  assert.match(failed.body.error!, /fetching the latest default branch of .* failed, so no thread was started/);
  assert.equal(app.registry.listThreads().length, threads, "no thread was created");
  assert.equal(app.registry.threadByRequest(project.id, "four"), null);
  fs.renameSync(`${upstream}.away`, upstream);
  const four = await start(project.id, "four");
  assert.equal(four.status, 200, "the same request succeeds once upstream answers");
  assert.deepEqual(pins(four.body.id!), [["main", third]]);
  console.log("ok: an upstream that cannot be fetched fails the start explicitly");

  // 5. A configured branch is followed the same way.
  const branched = (await (await post("/api/projects", { name: "branched", repositories: [{ url: upstream, base: "trunk" }] })).json()).project as { id: string };
  git(upstream, "checkout", "-q", "trunk");
  const later = commit("trunk later");
  git(upstream, "checkout", "-q", "main");
  const five = await start(branched.id, "five");
  assert.equal(five.status, 200, JSON.stringify(five.body));
  assert.deepEqual(pins(five.body.id!), [["trunk", later]]);
  console.log("ok: a configured branch is resolved again at thread start");
  for (const thread of app.registry.listThreads()) await ready(thread.id);
} finally {
  await app.close();
}

// 6. A project edited while its commits were being fetched starts no thread
//    at commits resolved for its earlier revision.
{
  const registry = new Registry(path.join(root, "registry.db"));
  registry.enrollRunner({ nodeId: "node-race", threadId: "runner-race", environmentId: 1, configPath: "/private/race.json", configHash: "race" });
  const repository = { id: "r", projectId: "p", position: 0, url: "/srv/a", base: null, checkoutName: "workspace", status: "ready" as const,
    error: null, resolvedBase: "main", baseOid: "a".repeat(40), checkedAt: 1 };
  registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 2, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [repository] });
  const fresh = { url: "/srv/a", base: "main", baseOid: "b".repeat(40) };
  assert.throws(() => registry.createThread("p", "old", model, "hi", "pi", { projectRevision: 1, repositories: [fresh] }), /project changed/);
  assert.throws(() => registry.createThread("p", "moved", model, "hi", "pi", { projectRevision: 2, repositories: [{ ...fresh, url: "/srv/b" }] }), /project changed/);
  assert.equal(registry.listThreads().length, 0);
  const thread = registry.createThread("p", "new", model, "hi", "pi", { projectRevision: 2, repositories: [fresh] });
  assert.deepEqual(thread.allocation.repositories, [{ url: "/srv/a", base: "main", baseOid: "b".repeat(40), checkoutName: "workspace" }]);
  registry.close();
  console.log("ok: commits resolved for an earlier project revision start no thread");
}
fs.rmSync(root, { recursive: true, force: true });
