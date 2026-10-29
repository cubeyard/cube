/** A thread is accepted at once and starts at its repositories' latest
 * commits, not at the project's last check: through cubed's HTTP route and
 * over a local guest (the real guest helper under a temporary root). The
 * upstream advances after the check, its default branch moves, a request
 * is replayed, a started thread is activated again, the upstream cannot be
 * fetched, and an upstream held mid-answer (real git over an ssh stand-in
 * that waits while a hold file exists) accepts five threads that share one
 * fetch, keeps a thread accepted across a project edit and across a cubed
 * restart (those threads are followed to their resolved commits: the local
 * guest's checkout has no ssh stand-in). Disposable state. */
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

// The same upstream over ssh://: the stand-in logs each connection and
// answers once the hold file is gone, as a server that has not answered yet.
const hold = path.join(root, "hold");
const sshLog = path.join(root, "ssh.log");
const ssh = path.join(root, "ssh");
fs.writeFileSync(ssh, `#!/bin/sh\necho "$2" >> "${sshLog}"\nwhile [ -e "${hold}" ]; do sleep 0.02; done\nexec sh -c "$2"\n`, { mode: 0o755 });
process.env.GIT_SSH_COMMAND = ssh;
process.env.GIT_SSH_VARIANT = "simple";
const held = `ssh://stand-in${upstream}`;
const connections = () => fs.existsSync(sshLog) ? fs.readFileSync(sshLog, "utf8").split("\n").filter(Boolean).length : 0;

const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 40 }, () => fauxAssistantMessage("done")));
const models = createModels();
models.setProvider(faux.provider);
const machines = new LocalMachines(path.join(root, "machines"));
const state = path.join(root, "state");
const open = async () => {
  const app = await createCubed({ state, models, machines, claude: null, gateway: null });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  assert(address && typeof address === "object");
  return { app, base: `http://127.0.0.1:${address.port}` };
};
let { app, base } = await open();
for (let index = 0; index < 16; index++) {
  app.registry.enrollRunner({ nodeId: `node-${index}`, threadId: `runner-${index}`, environmentId: index + 1,
    configPath: `/private/runner-${index}.json`, configHash: `hash-${index}`, protocol: 4, kind: "vm" });
}
const post = (route: string, body: unknown) => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const model = { provider: faux.getModel().provider, id: faux.getModel().id };
const start = async (projectId: string, requestId: string) => {
  const response = await post("/api/threads", { projectId, requestId, text: "hello", model });
  return { status: response.status, body: await response.json() as { id?: string; error?: string } };
};
const thread = (id: string) => app.registry.getThread(id)!;
const pins = (id: string) => thread(id).allocation.repositories.map(repository => [repository.base, repository.baseOid]);
const commitSteps = (id: string) => (thread(id).vm?.steps ?? []).filter(step => step.name === "commits").map(step => step.state);
async function until(what: string, check: () => boolean, ms = 30_000) {
  for (const deadline = Date.now() + ms; !check(); await delay(25)) assert.ok(Date.now() < deadline, what);
}
const ready = (id: string) => until(`thread ${id} becomes ready`, () => {
  assert.notEqual(thread(id).workspaceState, "failed", `thread ${id}: ${thread(id).workspaceError}`);
  return thread(id).workspaceState === "available";
});
const resolved = (id: string) => until(`thread ${id} resolves its commits`, () => commitSteps(id).at(-1) === "ok");
const head = (id: string) => git(path.join(machines.root, id, "workspace"), "rev-parse", "HEAD");

try {
  const created = await (await post("/api/projects", { name: "advancing", repositories: [{ url: upstream }] })).json();
  const project = created.project as { id: string; repositories: Array<{ baseOid: string }> };
  assert.equal(project.repositories[0].baseOid, first, "the check resolved the first commit");

  // 1. The upstream advances after the check: the thread starts at the new
  //    commit, and its machine checks out that commit.
  const second = commit("second");
  const one = await start(project.id, "one");
  assert.equal(one.status, 200, JSON.stringify(one.body));
  await ready(one.body.id!);
  assert.deepEqual(pins(one.body.id!), [["main", second]], "pinned to the commit upstream has now, not the last check's");
  assert.equal(thread(one.body.id!).allocation.latest, undefined, "its commits are resolved");
  assert.deepEqual(commitSteps(one.body.id!), ["ok"]);
  assert.equal(head(one.body.id!), second, "the machine's checkout is the pinned commit");
  assert.deepEqual(thread(one.body.id!).workspaceBase, { remote: upstream, ref: "refs/heads/main", oid: second });
  console.log("ok: a new thread starts at the upstream's latest commit, not at the project's last check");

  // 2. A replayed request, a later activation and the agent's own edits
  //    keep the thread at its original commit while upstream moves on.
  const third = commit("third");
  fs.writeFileSync(path.join(machines.root, one.body.id!, "workspace", "README"), "the agent's edit\n");
  const replay = await start(project.id, "one");
  assert.deepEqual(replay.body, one.body, "a replay returns the same thread");
  await app.conversations.activate(one.body.id!);
  assert.deepEqual(pins(one.body.id!), [["main", second]], "a replay or reactivation resolves nothing again");
  assert.deepEqual(commitSteps(one.body.id!), ["ok"], "and runs no second commits step");
  assert.equal(head(one.body.id!), second);
  assert.equal(fs.readFileSync(path.join(machines.root, one.body.id!, "workspace", "README"), "utf8"), "the agent's edit\n", "the agent's edit is kept");
  const two = await start(project.id, "two");
  await ready(two.body.id!);
  assert.deepEqual(pins(two.body.id!), [["main", third]], "the next new thread starts at the newest commit");
  console.log("ok: replays and reactivation keep a thread's commit and edits; the next new thread takes the newest");

  // 3. The default branch is asked of the remote again: a project without
  //    a configured branch follows the remote's HEAD when it moves.
  git(upstream, "checkout", "-q", "-b", "trunk");
  const trunk = commit("trunk");
  const three = await start(project.id, "three");
  await ready(three.body.id!);
  assert.deepEqual(pins(three.body.id!), [["trunk", trunk]], "the default branch the remote advertises now");
  git(upstream, "checkout", "-q", "main");
  console.log("ok: the default branch is discovered again at each thread start");

  // 4. An upstream that cannot be fetched: the thread is accepted, its
  //    start fails in its commits step (a failed try, retried), and it
  //    never starts at the commits cubed already had. Once upstream answers,
  //    the next try starts it.
  fs.renameSync(upstream, `${upstream}.away`);
  const four = await start(project.id, "four");
  assert.equal(four.status, 200, "accepted: the fetch is the start's, not the request's");
  await until("the start fails", () => thread(four.body.id!).workspaceState === "failed");
  assert.match(thread(four.body.id!).workspaceError!, /^workspace allocation failed: fetching the latest default branch of .*upstream failed: /);
  assert.equal(thread(four.body.id!).retry?.failures, 1, "a failed try the recovery loop retries");
  assert.deepEqual(commitSteps(four.body.id!), ["failed"]);
  assert.deepEqual(thread(four.body.id!).allocation.latest, { bases: [null] }, "still to resolve: no commit was pinned");
  assert.equal(fs.existsSync(path.join(machines.root, four.body.id!)), false, "no machine was made");
  fs.renameSync(`${upstream}.away`, upstream);
  await app.conversations.activate(four.body.id!);
  await ready(four.body.id!);
  assert.deepEqual(pins(four.body.id!), [["main", third]]);
  assert.deepEqual(commitSteps(four.body.id!), ["failed", "ok"]);
  console.log("ok: an upstream that cannot be fetched fails the accepted thread's start, which a later try completes");

  // 5. A configured branch is followed the same way.
  const branched = (await (await post("/api/projects", { name: "branched", repositories: [{ url: upstream, base: "trunk" }] })).json()).project as { id: string };
  git(upstream, "checkout", "-q", "trunk");
  const later = commit("trunk later");
  git(upstream, "checkout", "-q", "main");
  const five = await start(branched.id, "five");
  await ready(five.body.id!);
  assert.deepEqual(pins(five.body.id!), [["trunk", later]]);
  console.log("ok: a configured branch is resolved again at thread start");

  // 6. An upstream held mid-answer: five requests are accepted while it has
  //    not answered, their starts share one fetch, and each starts at the
  //    commit upstream has once it answers.
  const remote = (await (await post("/api/projects", { name: "held", repositories: [{ url: held }] })).json()).project as { id: string; status: string; error?: string };
  assert.equal(remote.status, "ready", JSON.stringify(remote));
  const fourth = commit("fourth");
  fs.writeFileSync(hold, "");
  const before = connections();
  const accepting = performance.now();
  const accepted = [];
  for (let k = 0; k < 5; k++) accepted.push(await start(remote.id, `held-${k}`));
  const acceptMs = performance.now() - accepting;
  assert.deepEqual(accepted.map(each => each.status), [200, 200, 200, 200, 200]);
  const heldIds = accepted.map(each => each.body.id!);
  await until("the first start reaches upstream", () => connections() > before);
  assert.deepEqual(heldIds.map(id => [thread(id).workspaceState, commitSteps(id)]), Array(5).fill(["allocating", ["running"]]),
    "every thread is accepted and waits in its commits step");
  assert.deepEqual(heldIds.map(id => thread(id).allocation.latest), Array(5).fill({ bases: [null] }));
  console.log(`five requests accepted while upstream held its answer: ${Math.round(acceptMs)} ms in all`);

  // 7. Meanwhile the project is edited: a thread accepted before keeps the
  //    repositories of its revision; one accepted after has its own fetch.
  const saved = app.registry.getProject(remote.id)!;
  app.registry.saveProject({ ...saved, revision: saved.revision + 1, repositories: saved.repositories.map(repository => ({ ...repository, base: "trunk" })) });
  const edited = await start(remote.id, "held-edited");
  fs.rmSync(hold);
  for (const id of [...heldIds, edited.body.id!]) await resolved(id);
  assert.deepEqual(heldIds.map(pins), Array(5).fill([["main", fourth]]), "the five start at the commit upstream answered with");
  assert.deepEqual(pins(edited.body.id!), [["trunk", later]], "the thread accepted after the edit follows the edit");
  assert.equal(connections() - before, 3, "ls-remote and fetch for the five threads' shared fetch, a fetch of the configured trunk for the edited revision's");
  console.log("ok: threads of one revision share a fetch; a project edit after acceptance changes no accepted thread");

  // 8. cubed stops while a start waits on upstream: the thread stays
  //    accepted, not failed, and the next cubed starts it once.
  fs.writeFileSync(hold, "");
  const restart = await start(remote.id, "restart");
  const restartId = restart.body.id!;
  await until("its start waits on upstream", () => commitSteps(restartId)[0] === "running");
  await until("no other start is under way at the close", () => app.registry.listThreads().every(each => each.id === restartId || !app.conversations.starting(each.id)));
  await app.close();
  {
    const stored = new Registry(path.join(state, "registry.sqlite"));
    const after = stored.getThread(restartId)!;
    assert.equal(after.workspaceState, "allocating", "not failed by the close");
    assert.equal(after.retry, undefined, "no failed try counted");
    assert.deepEqual(after.allocation.latest, { bases: ["trunk"] });
    stored.close();
  }
  fs.rmSync(hold);
  git(upstream, "checkout", "-q", "trunk");
  const meanwhile = commit("trunk while cubed was down");
  git(upstream, "checkout", "-q", "main");
  ({ app, base } = await open());
  await resolved(restartId);
  assert.deepEqual(pins(restartId), [["trunk", meanwhile]], "at what upstream has when the next cubed starts it");
  assert.deepEqual(commitSteps(restartId), ["interrupted", "ok"], "the cut step, then one that completed");
  console.log("ok: a start cut off by cubed's close is no failure; the next cubed resolves and starts the thread once");
  await until("no start is under way at the close", () => app.registry.listThreads().every(each => !app.conversations.starting(each.id)));
} finally {
  fs.rmSync(hold, { force: true });
  await app.close();
}

// 9. Two resolutions of one thread converge: the first write wins.
{
  const registry = new Registry(path.join(root, "registry.db"));
  registry.enrollRunner({ nodeId: "node-race", threadId: "runner-race", environmentId: 1, configPath: "/private/race.json", configHash: "race", protocol: 4, kind: "vm" });
  const repository = { id: "r", projectId: "p", position: 0, url: "/srv/a", base: null, checkoutName: "workspace", status: "ready" as const,
    error: null, resolvedBase: "main", baseOid: "a".repeat(40), checkedAt: 1 };
  registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 2, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [repository] });
  const accepted = registry.createThread("p", "new", model, "hi", "pi", { latest: true });
  assert.deepEqual(accepted.allocation.latest, { bases: [null] });
  const winner = registry.resolveCommits(accepted.id, { repositories: [{ url: "/srv/a", base: "main", baseOid: "b".repeat(40) }] });
  const loser = registry.resolveCommits(accepted.id, { repositories: [{ url: "/srv/a", base: "main", baseOid: "c".repeat(40) }] });
  assert.deepEqual(winner.allocation.repositories, [{ url: "/srv/a", base: "main", baseOid: "b".repeat(40), checkoutName: "workspace" }]);
  assert.deepEqual(loser, winner, "a second resolution returns the first's, unchanged");
  assert.throws(() => registry.resolveCommits(registry.createThread("p", "other", model, "hi", "pi", { latest: true }).id,
    { repositories: [{ url: "/srv/b", base: "main", baseOid: "b".repeat(40) }] }), /not the thread's/);
  registry.close();
  console.log("ok: concurrent resolutions of a thread's commits converge on the first");
}
fs.rmSync(root, { recursive: true, force: true });
