/** A thread's machine through cubed's real API, on local guests (the real
 * guest helper under temporary roots): background activation, provisioning
 * of the pinned checkouts once, the release check at archive (a clean
 * machine is deleted, anything else retained with its reason), a failed
 * provisioning shown on the thread and retried under a new key. Real VMs run
 * in scripts/test-vm-e2e.ts. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { provisionScript, releaseCheckScript } from "../src/vm.ts";
import { LocalMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-vm-workspace-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Cube Test", "-c", "user.email=cube@example.invalid",
  "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" }).trim();
function repository(name: string, branch: string, file: string): string {
  const work = path.join(root, `${name}-work`);
  fs.mkdirSync(work);
  git(work, "init", "-q", `--initial-branch=${branch}`);
  fs.writeFileSync(path.join(work, file), `${name}\n`);
  git(work, "add", file);
  git(work, "commit", "-qm", "base");
  const bare = path.join(root, `${name}.git`);
  git(root, "clone", "-q", "--bare", work, bare);
  return bare;
}
const primary = repository("primary", "develop", "README.md");
const reference = repository("reference", "main", "LIB.md");
const machines = new LocalMachines(path.join(root, "machines"));
const faux = fauxProvider({ tokensPerSecond: 10000 });
faux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("ready")));
const models = createModels();
models.setProvider(faux.provider);
const state = path.join(root, "state");
fs.mkdirSync(state);
const app = await createCubed({ state, models, claude: null, machines });
await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
const address = app.server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;
const post = (route: string, body: unknown, method = "POST") => fetch(`${base}${route}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
type ThreadRow = { id: string; state: string; error: string | null; workspaceState: string; workspaceBase: { oid: string } | null };
async function thread(id: string, until: (row: ThreadRow) => boolean): Promise<ThreadRow> {
  for (let attempt = 0; ; attempt++) {
    const row = (await (await fetch(`${base}/api/threads`)).json()).threads.find((item: ThreadRow) => item.id === id) as ThreadRow;
    if (row && until(row)) return row;
    assert.ok(attempt < 600, `thread ${id}: ${JSON.stringify(row)}`);
    await delay(25);
  }
}
async function idle(id: string) {
  for (let attempt = 0; ; attempt++) {
    const history = await (await fetch(`${base}/api/threads/${id}/history`)).json();
    if (history.status?.state === "completed") return;
    assert.ok(attempt < 400, JSON.stringify(history.status));
    await delay(25);
  }
}
try {
  for (let index = 0; index < 5; index++) {
    app.registry.enrollRunner({ nodeId: `node-${index}`, threadId: `runner-${index}`, environmentId: index + 1,
      configPath: `/private/runner-${index}.json`, configHash: `hash-${index}` });
  }
  const project = (await (await post("/api/projects", { name: "pinned", repositories: [{ url: primary, base: "develop" }, { url: reference, checkoutName: "lib" }] })).json()).project;
  assert.equal(project.status, "ready", JSON.stringify(project));
  const empty = (await (await post("/api/projects", { name: "empty", repositories: [] })).json()).project;
  const create = async (projectId: string, requestId: string) => (await (await post("/api/threads", { projectId, requestId, text: "hello",
    model: { provider: faux.getModel().provider, id: faux.getModel().id } })).json()).id as string;

  // Creation returns at once; the machine starts in the background.
  const clean = await create(project.id, "clean");
  const ready = await thread(clean, row => row.state !== "starting");
  assert.equal(ready.state, "ready", ready.error ?? "");
  assert.equal(ready.workspaceState, "available");
  const guest = machines.guests.get(clean)!;
  assert.equal(git(guest.workspace, "rev-parse", "HEAD"), project.repositories[0].baseOid, "the primary checkout is at its pinned commit");
  assert.equal(fs.readFileSync(path.join(guest.workspace, "README.md"), "utf8"), "primary\n");
  assert.equal(git(path.join(guest.root, "repos", "lib"), "rev-parse", "HEAD"), project.repositories[1].baseOid, "references live in ../repos");
  assert.equal(app.registry.getThread(clean)?.vm?.provisionAttempt, 1);
  await idle(clean);
  // A clean machine is deleted at archive.
  const archived = await (await fetch(`${base}/api/threads/${clean}`, { method: "DELETE" })).json();
  assert.deepEqual(archived, { ok: true, retained: false, reason: "clean" });
  assert.equal(machines.released.get(clean), false);
  assert.equal(app.registry.getThread(clean)?.archived, true);

  // The guest is agent-controlled: a machine reporting clean is still kept
  // when cubed's records show the agent ran a command in it.
  faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" }),
    ...Array.from({ length: 20 }, () => fauxAssistantMessage("ready"))]);
  const ran = await create(project.id, "ran");
  await thread(ran, row => row.state === "ready");
  await idle(ran);
  const ranArchive = await (await fetch(`${base}/api/threads/${ran}`, { method: "DELETE" })).json();
  assert.deepEqual(ranArchive, { ok: true, retained: true, reason: "the agent ran commands or wrote files in the machine" });
  assert.equal(machines.released.get(ran), true);
  // The operator discards the retained disk; only archived threads, once.
  assert.equal((await post(`/api/threads/${ran}/discard`, {})).status, 200);
  assert.ok(machines.discarded.has(ran));
  assert.equal(app.registry.getThread(ran)!.vm!.discarded, true);
  assert.equal((await post(`/api/threads/${ran}/discard`, {})).status, 200, "repeatable");

  // While an archive runs, nothing reopens the thread's agent or workspace.
  const raced = await create(project.id, "raced");
  await thread(raced, row => row.state === "ready");
  await idle(raced);
  let finished = false;
  const archiving = app.conversations.archive(raced).finally(() => { finished = true; });
  let refused = "";
  while (!finished && !refused) {
    try { await app.conversations.agent(raced); }
    catch (error) { refused = (error as Error).message; }
    void app.conversations.activate(raced);
    void app.conversations.boot();
    await delay(1);
  }
  assert.deepEqual(await archiving, { retained: false, reason: "clean" });
  assert.equal(refused, "thread is being archived");
  await app.conversations.boot();
  assert.equal(app.conversations.owner(raced), null, "no lease was taken for the archived thread");
  assert.equal(app.conversations.error(raced), null);

  // Changed work is retained, with the reason.
  const dirty = await create(project.id, "dirty");
  await thread(dirty, row => row.state === "ready");
  await idle(dirty);
  fs.writeFileSync(path.join(machines.guests.get(dirty)!.workspace, "notes.txt"), "work in progress\n");
  const kept = await (await fetch(`${base}/api/threads/${dirty}`, { method: "DELETE" })).json();
  assert.equal(kept.retained, true);
  assert.match(kept.reason, /has changes/);
  assert.equal(app.registry.getThread(dirty)?.vm?.retain, true);
  assert.match(app.registry.getThread(dirty)?.vm?.retainReason ?? "", /has changes/);

  // A commit of its own is retained even when the tree is clean again.
  const committed = await create(project.id, "committed");
  await thread(committed, row => row.state === "ready");
  await idle(committed);
  const committedWorkspace = machines.guests.get(committed)!.workspace;
  fs.writeFileSync(path.join(committedWorkspace, "README.md"), "changed\n");
  git(committedWorkspace, "commit", "-qam", "own");
  git(committedWorkspace, "-c", "advice.detachedHead=false", "checkout", "-q", project.repositories[0].baseOid);
  const own = await (await fetch(`${base}/api/threads/${committed}`, { method: "DELETE" })).json();
  assert.equal(own.retained, true);
  assert.match(own.reason, /commits of its own/);

  // An empty project gets an empty workspace; anything left in it is retained.
  const blank = await create(empty.id, "blank");
  await thread(blank, row => row.state === "ready");
  assert.deepEqual(fs.readdirSync(machines.guests.get(blank)!.workspace), []);
  await idle(blank);
  fs.writeFileSync(path.join(machines.guests.get(blank)!.workspace, "scratch"), "x");
  assert.match((await (await fetch(`${base}/api/threads/${blank}`, { method: "DELETE" })).json()).reason, /not empty/);

  // A pinned commit that vanished: provisioning fails visibly and is retried
  // under a new key; nothing falls back to another commit.
  const gone = await create(project.id, "gone");
  git(primary, "update-ref", "refs/heads/develop", git(primary, "commit-tree", "-m", "rewritten", `${project.repositories[0].baseOid}^{tree}`));
  git(primary, "reflog", "expire", "--expire=now", "--all");
  git(primary, "gc", "-q", "--prune=now");
  const failed = await thread(gone, row => row.state === "error");
  assert.match(failed.error ?? "", /workspace allocation failed: checking out the project failed/);
  assert.equal(failed.workspaceState, "failed");
  // (Created before the rewrite, the first try may have checked out in time; force a second try.)
  const attempts = app.registry.getThread(gone)?.vm?.provisionAttempt ?? 0;
  await app.conversations.activate(gone);
  assert.equal(app.registry.getThread(gone)?.vm?.provisionAttempt, attempts + 1, "a failed try is never rerun under its key");
  const failedArchive = await (await fetch(`${base}/api/threads/${gone}`, { method: "DELETE" })).json();
  assert.equal(failedArchive.retained, true, "a failed machine is retained");

  // Project hooks: kept with the project, fixed for each thread at creation,
  // run in order; resume hooks again when the machine boots again, with the
  // open agent closed first and reopened afterwards.
  const hooked = (await (await post(`/api/projects/${empty.id}`, { name: "empty", repositories: [],
    hooks: { preSetup: "echo pre-setup >> \"$HOME/order\"", preResume: "echo pre-resume >> \"$HOME/order\"" } }, "PUT")).json()).project;
  assert.deepEqual(hooked.hooks, { preSetup: "echo pre-setup >> \"$HOME/order\"", preResume: "echo pre-resume >> \"$HOME/order\"" });
  const kept2 = (await (await post(`/api/projects/${empty.id}`, { name: "empty", repositories: [] }, "PUT")).json()).project;
  assert.deepEqual(kept2.hooks, hooked.hooks, "a save without hooks keeps them");
  assert.equal((await post(`/api/projects/${empty.id}`, { name: "empty", repositories: [], hooks: { preSetup: 3 } }, "PUT")).status, 409);
  const withHooks = await create(empty.id, "hooks");
  await thread(withHooks, row => row.state === "ready");
  await idle(withHooks);
  const order = () => fs.readFileSync(path.join(machines.guests.get(withHooks)!.root, "home", "order"), "utf8").trim().split("\n");
  assert.deepEqual(order(), ["pre-setup", "pre-resume"]);
  const hooksRecord = app.registry.getThread(withHooks)!.vm!;
  assert.deepEqual(Object.fromEntries(Object.entries(hooksRecord.hooks!).map(([name, hook]) => [name, hook.status])),
    { "pre-setup": "ok", setup: "absent", "pre-resume": "ok", resume: "absent" });
  assert.equal(hooksRecord.startup?.source, "fresh");
  assert.ok(hooksRecord.startup!.totalMs > 0 && hooksRecord.startup!.phases.prepare >= 0 && hooksRecord.startup!.phases.resume >= 0);
  await app.conversations.activate(withHooks);
  assert.deepEqual(order(), ["pre-setup", "pre-resume"], "an activation of the same boot resumes nothing");
  const before = await app.conversations.agent(withHooks);
  machines.reboot(app.registry.getThread(withHooks)!);
  await app.conversations.activate(withHooks);
  assert.deepEqual(order(), ["pre-setup", "pre-resume", "pre-resume"], "a new boot resumes again, setup does not run again");
  assert.notEqual(await app.conversations.agent(withHooks), before, "the agent was closed for the hooks and reopened");
  assert.equal(app.conversations.error(withHooks), null);
  await (await fetch(`${base}/api/threads/${withHooks}/history`)).json();

  // The scripts quote what they are given.
  assert.match(provisionScript({ projectId: "p", projectRevision: 1, repositories: [{ url: "https://example.com/a'b.git", base: "main", baseOid: "a".repeat(40), checkoutName: "workspace" }] }),
    /checkout '\.' 'https:\/\/example\.com\/a'\\''b\.git' 'refs\/heads\/main'/);
  assert.match(releaseCheckScript({ projectId: "p", projectRevision: 1, repositories: [] }), /the workspace is not empty/);
  console.log("ok: thread machines: background activation, pinned checkouts provisioned once, release check (clean deleted; agent commands, changes, own commits, leftovers and failures retained with reasons), no reopening while archiving, failed provisioning retried under a new key");
} finally {
  await app.close();
  await machines.close();
  fs.rmSync(root, { recursive: true, force: true });
}
