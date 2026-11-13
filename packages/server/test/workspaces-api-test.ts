/** Workspaces through the real cubed over HTTP; offline and disposable (a
 * faux model, no machine).
 *
 *   1. A state from before workspaces (one chat, two projects) started by
 *      this cubed: each project is a workspace whose chat has the old chat;
 *      a new workspace's chat is empty and shows the fixed welcome.
 *   2. Two chats at once: a message in one is in that one only.
 *   3. The routes of the UI from before workspaces (/api/optchat,
 *      /api/projects) reach the same things and no further: a chat only by
 *      naming its workspace once there are several.
 *   4. Lists by workspace: threads, artifacts, usage.
 *   5. Archive and restore over HTTP.
 *   7. A chat's store has one owner at a time: a read or a restore during
 *      an archive waits for the archive's close.
 *      A chat whose close returned at its bound with its Harness still
 *      closing keeps the store: nothing opens it until it has let go.
 *      A workspace deleted while its closed chat still holds the store
 *      keeps its directory until that chat has let go.
 *   6b. The old chat, opened to end its turn and closed, still holding its
 *      store: no copy is taken and no workspace chat opens; once it has
 *      let go, the migration runs.
 *   8. An archived workspace's chat usage is what its store holds, whether
 *      or not usage was read before, under the workspace as it is now.
 *   9. A workspace's artifact list is its own however many newer artifacts
 *      other workspaces have.
 *   6. A chat still working when cubed starts: after the wait, no workspace
 *      chat opens and every chat route says why; the next start goes on. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { createModels, fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { OptChat, type OptThreads } from "../src/optchat.ts";
import { Registry } from "../src/registry.ts";
import { ArtifactStore } from "../src/artifacts.ts";
import { CHAT_WELCOME } from "../src/workspace-chats.ts";
import { chatDirectory, migrationRecord } from "../src/workspace-migration.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-workspaces-api-"));
const faux = fauxProvider({ tokensPerSecond: 100_000 });
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, id: faux.getModel().id };
let hung: (() => void) | null = null;
faux.setResponses(Array.from({ length: 2000 }, () => async (request: { messages: Message[] }) => {
  const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
  if (system.includes("You write the memory of OptChat")) return fauxAssistantMessage("a summary");
  const last = request.messages.at(-1)!;
  const said = last.role !== "user" ? "" : typeof last.content === "string" ? last.content : last.content.flatMap(part => part.type === "text" ? [part.text] : []).at(-1) ?? "";
  if (said.includes("please hang")) await new Promise<void>(resolve => { hung = resolve; });
  return fauxAssistantMessage(`answer: ${said.slice(0, 40)}`);
}));
const none = { startFailure: () => null, onStartFailure: () => () => {}, onRunFeed: () => () => {}, projects: async () => "", runners: async () => "",
  spawn: async () => { throw new Error("no threads here"); }, tell: async () => {}, describe: async () => "", events: async () => null, history: async () => null } as unknown as OptThreads;
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string, ms = 30_000): Promise<T> {
  let value = await read();
  for (const deadline = Date.now() + ms; !check(value); value = await read()) { assert.ok(Date.now() < deadline, `${what}: ${JSON.stringify(value).slice(0, 600)}`); await delay(30); }
  return value;
}
/** A state as a cubed before workspaces left it: projects and one chat with `messages`. */
async function before(state: string, projects: string[], messages: string[], hang = false): Promise<void> {
  fs.mkdirSync(state, { recursive: true });
  const registry = new Registry(path.join(state, "registry.sqlite"));
  registry.enrollRunner({ nodeId: "node-1", environmentId: 1, threadId: "runner-1", configPath: "/private/1.json", configHash: "h1", protocol: 4, kind: "vm" });
  for (const id of projects) registry.saveProject({ id, name: id, status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  registry.close();
  const chat = await OptChat.open({ directory: path.join(state, "optchat"), models, model: async () => model, threads: none, limits: { closeMs: 100 } });
  for (const [index, text] of messages.entries()) {
    const had = chat.memory.length;
    await chat.send(text, `old-${index}`);
    await until(async () => chat.memory.length > had && await chat.idle(), Boolean, `the old chat answers ${text}`);
  }
  if (hang) {
    await chat.send("please hang", "old-hang");
    await until(async () => hung !== null, Boolean, "the old chat's request is out");
    // And a message still waiting behind it: the chat has work left whenever it is opened.
    await chat.send("please hang too", "old-hang-2");
    hung = null;
  }
  // Closed as a stop of cubed closes it: a turn under way is cut off, in the store as it was.
  await chat.close();
}
async function start(state: string, options: { workspaceIdleMs?: number; chatReleaseWaitMs?: number } = {}) {
  const app = await createCubed({ state, models, claude: null, gateway: null, ...options });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const call = async (route: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
    const response = await fetch(`${base}${route}`, { method, ...body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } });
    return { status: response.status, body: await response.json() as any };
  };
  const ready = () => until(() => call("/api/workspaces"), listed => listed.body.chats.state !== "preparing", "the workspaces' chats are decided");
  const say = async (chat: string, text: string, requestId: string) => {
    assert.equal((await call(`${chat}/prompt`, { text, requestId })).status, 200);
    await until(() => call(`${chat}/history`), history => history.body.status.state !== "working" && JSON.stringify(history.body).includes(`answer: ${text.slice(0, 40)}`), `the chat answers ${text}`);
  };
  return { app, call, ready, say, close: async () => { app.server.closeAllConnections(); await app.close(); } };
}
const chatOf = (id: string) => `/api/workspaces/${id}/chat`;
/** Holds a chat's Harness close until `letGo` (the one seam these tests
 * use): its `close()` then returns at its bound with the store still its own. */
function hold(chat: OptChat): { letGo(): void; closed(): boolean } {
  const harness = (chat as unknown as { harness: { close(...args: unknown[]): Promise<unknown> } }).harness;
  const close = harness.close.bind(harness);
  let letGo!: () => void, closed = false;
  const held = new Promise<void>(resolve => { letGo = resolve; });
  harness.close = async (...args) => { await held; try { return await close(...args); } finally { closed = true; } };
  return { letGo, closed: () => closed };
}

try {
  // ---- 1. a state from before workspaces
  const state = path.join(root, "state");
  await before(state, ["alpha", "beta"], ["the plan is ORCHID", "and then HERON"]);
  let cubed = await start(state);
  let { call, say } = cubed;
  const listed = await cubed.ready();
  assert.deepEqual([listed.body.chats.state, listed.body.workspaces.map((item: any) => item.id).sort()], ["ready", ["alpha", "beta"]]);
  assert.equal(migrationRecord(state)!.state, "done");
  const views = await Promise.all(["alpha", "beta"].map(id => call(`${chatOf(id)}/view`)));
  for (const view of views) {
    assert.match(view.body.view, /ORCHID|a summary/);
    assert.equal(view.body.messages, 4);
    assert.equal(view.body.welcome, null);
  }
  const created = await call("/api/workspaces", { name: "gamma", repositories: [] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const gamma = created.body.workspace.id as string;
  const empty = await call(`${chatOf(gamma)}/view`);
  assert.deepEqual([empty.body.messages, empty.body.welcome], [0, CHAT_WELCOME], "a new workspace's chat is empty and asks what to build, with no model call");
  assert.equal((await call(`${chatOf(gamma)}/history`)).body.events.length, 0);
  console.log("ok: started on a state from before workspaces: each project's chat has the old chat; a new workspace's is empty with the fixed welcome");

  // ---- 2. two chats at once
  await Promise.all([say(chatOf("alpha"), "only alpha hears FALCON", "a-1"), say(chatOf("beta"), "only beta hears MAGPIE", "b-1")]);
  const [alpha, beta] = await Promise.all(["alpha", "beta"].map(async id => JSON.stringify((await call(`${chatOf(id)}/history`)).body)));
  assert.ok(alpha!.includes("FALCON") && !alpha!.includes("MAGPIE") && beta!.includes("MAGPIE") && !beta!.includes("FALCON"), "each message is in its own workspace's chat only");
  assert.ok(alpha!.includes("ORCHID") && beta!.includes("ORCHID"), "over the same past");

  // ---- 3. the routes from before workspaces
  const projects = await call("/api/projects");
  assert.deepEqual(projects.body.projects.map((item: any) => item.id).sort(), ["alpha", "beta", gamma].sort());
  assert.equal((await call(`/api/projects/${gamma}`)).body.project.name, "gamma");
  const unnamed = await call("/api/optchat/view");
  assert.equal(unnamed.status, 409, "with several workspaces the old chat route names none");
  assert.match(unnamed.body.error, /name one with \?workspace=/);
  assert.equal((await call("/api/optchat/prompt", { text: "to nobody", requestId: "nobody" })).status, 409);
  assert.equal((await call("/api/optchat/view?workspace=nope")).status, 404);
  assert.equal((await call("/api/workspaces/nope/chat/view")).status, 404);
  await say("/api/optchat", "unreachable", "skip").then(() => assert.fail("an unnamed chat took a message"), () => {});
  const viaOld = async (text: string, requestId: string) => {
    assert.equal((await call("/api/optchat/prompt?workspace=beta", { text, requestId })).status, 200);
    await until(() => call("/api/optchat/history?workspace=beta"), history => JSON.stringify(history.body).includes(`answer: ${text}`), "the old route's chat answers");
  };
  await viaOld("through the old route WREN", "b-2");
  assert.ok(JSON.stringify((await call(`${chatOf("beta")}/history`)).body).includes("WREN"), "the old route with a workspace is that workspace's chat");
  assert.ok(!JSON.stringify((await call(`${chatOf("alpha")}/history`)).body).includes("WREN"), "and no other's");
  console.log("ok: two chats work side by side; /api/projects and /api/optchat reach the same workspaces, a chat only when its workspace is named");

  // ---- 4. lists by workspace
  const registry = cubed.app.registry;
  const thread = registry.createThread("alpha", "ui-1", model, "a thread in alpha");
  registry.createThread("beta", "ui-2", model, "a thread in beta");
  const inAlpha = await call("/api/threads?workspace=alpha");
  assert.deepEqual(inAlpha.body.threads.map((item: any) => [item.id, item.workspace.id, item.project.id]), [[thread.id, "alpha", "alpha"]]);
  assert.equal((await call("/api/threads")).body.threads.length, 2);
  const usage = await call("/api/usage?workspace=alpha");
  assert.deepEqual(usage.body.chats.map((item: any) => item.projectId), ["alpha"]);
  assert.equal(usage.body.beforeWorkspaces, null);
  const all = await call("/api/usage");
  assert.ok(all.body.beforeWorkspaces.spend.tokens.total > 0, "the old chat's usage is reported once, apart");
  assert.ok(usage.body.optchat.spend.tokens.total > 0 && usage.body.optchat.spend.tokens.total < all.body.optchat.spend.tokens.total);
  assert.equal((await call("/api/usage?workspace=nope")).status, 404);
  assert.deepEqual((await call(`/api/artifacts?workspace=alpha`)).body.artifacts, []);

  // ---- 5. archive and restore
  const refused = await call("/api/workspaces/alpha/archive", {});
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /has 1 open thread/);
  const archived = await call(`/api/workspaces/${gamma}/archive`, {});
  assert.ok(archived.body.workspace.archivedAt);
  assert.equal((await call(`${chatOf(gamma)}/prompt`, { text: "anyone?", requestId: "g-1" })).status, 409);
  assert.equal((await call(`/api/optchat/prompt?workspace=${gamma}`, { text: "anyone?", requestId: "g-2" })).status, 409, "nor through the old route");
  assert.equal((await call(`${chatOf(gamma)}/view`)).status, 200, "an archived workspace's chat stays readable");
  assert.match((await call("/api/threads", { projectId: gamma, requestId: "g-thread", text: "start" })).body.error, /the workspace is archived/);
  const renamed = await call(`/api/workspaces/${gamma}`, { name: "gamma two", repositories: [] }, "PUT");
  assert.ok(renamed.body.workspace.archivedAt, "editing an archived workspace keeps it archived");
  assert.equal((await call(`/api/workspaces/${gamma}/unarchive`, {})).body.workspace.archivedAt, undefined);
  await say(chatOf(gamma), "back in gamma", "g-3");
  await cubed.close();

  // A restart: the migration is not run again, and the chats are as they were.
  cubed = await start(state);
  ({ call, say } = cubed);
  await cubed.ready();
  assert.ok(JSON.stringify((await call(`${chatOf("beta")}/history`)).body).includes("WREN"));
  assert.equal((await call(`${chatOf(gamma)}/view`)).body.messages, 2);
  assert.equal((await call(`${chatOf("alpha")}/view`)).body.messages, 6);
  await cubed.close();
  console.log("ok: lists by workspace; archive refused with an open thread, then read-only and restored; a restart changes nothing");

  // ---- 7. one owner of a chat's store at a time
  {
    const life = path.join(root, "life");
    cubed = await start(life);
    ({ call, say } = cubed);
    await cubed.ready();
    const { chats, usage: usageService, registry: lifeRegistry } = cubed.app;
    const made = async (name: string) => (await call("/api/workspaces", { name, repositories: [] })).body.workspace.id as string;
    const tokensOf = (report: { optchat: { spend: { tokens: { total: number } } } | null }) => report.optchat!.spend.tokens.total;
    const stored = async (id: string) => {
      const used = await (await chats.get(id)).chat.usage();
      return [...Object.values(used.chat.models), ...Object.values(used.compactor.models)].reduce((sum, item) => sum + item.totalTokens, 0);
    };
    const busy = await made("busy");
    await say(chatOf(busy), "a first message", "l-1");
    const working = (await chats.get(busy, "write")).chat;
    hung = null;
    assert.equal((await call(`${chatOf(busy)}/prompt`, { text: "please hang", requestId: "l-2" })).status, 200);
    await until(async () => hung !== null, Boolean, "the chat's request is out");
    // The archive closes the chat, which waits out its grace for the request that is out.
    let closed = false;
    const archiving = call(`/api/workspaces/${busy}/archive`, {}).then(answer => { closed = true; return answer; });
    await delay(50);
    assert.equal(closed, false, "the archive is still closing the chat");
    assert.equal(await chats.peek(busy), null, "a chat that is closing takes no more work");
    // A read and a restore that arrive meanwhile.
    const order: string[] = [];
    void archiving.then(() => order.push("archived"));
    const reading = call(`${chatOf(busy)}/history`).then(answer => { order.push("read"); return answer; });
    const restoring = call(`/api/workspaces/${busy}/unarchive`, {}).then(answer => { order.push("restored"); return answer; });
    // The model's answer comes at last, so the closing chat's Harness can end
    // (until it has, the store is still that chat's: 7b holds it longer).
    await delay(100);
    (hung as (() => void) | null)?.(); hung = null;
    const [archived, read, restored] = await Promise.all([archiving, reading, restoring]);
    assert.deepEqual([archived.status, read.status, restored.status], [200, 200, 200]);
    assert.equal(order[0], "archived", `nothing else opens the store before the archive's close has ended: ${order.join(", ")}`);
    const again = (await chats.get(busy, "write")).chat;
    assert.notEqual(again, working, "restored: opened anew");
    assert.equal(again.identity, working.identity, "on the same store");
    const cut = (await again.usage()).cut!.chat;
    assert.deepEqual(Object.values(cut), [], `the request was answered during the close, so no owner counts it as cut off: ${JSON.stringify(cut)}`);
    assert.ok(JSON.stringify((await call(`${chatOf(busy)}/history`)).body).includes("answer: please hang"), "and its answer is in the chat");
    assert.equal(lifeRegistry.getProject(busy)!.archivedAt, undefined);
    (hung as (() => void) | null)?.(); hung = null;
    await say(chatOf(busy), "after the restore", "l-3");
    console.log("ok: a read and a restore during an archive wait until the closing chat has let go; its request out is answered once and counted as cut off by nobody");

    // ---- 8. an archived workspace's usage
    const quiet = await made("quiet");
    await say(chatOf(quiet), "used, and usage never read", "q-1");
    const usedQuiet = await stored(quiet);
    await call(`/api/workspaces/${quiet}/archive`, {});
    const neverRead = await usageService.report({ project: quiet });
    assert.deepEqual([tokensOf(neverRead), neverRead.optchat!.coverage, neverRead.chats[0]!.archived], [usedQuiet, "complete", true], "archived without a usage read before: what its store holds");
    const seen = await made("seen");
    await say(chatOf(seen), "used, and read", "s-1");
    const early = tokensOf(await usageService.report({ project: seen }));
    await say(chatOf(seen), "used some more after the read", "s-2");
    const usedSeen = await stored(seen);
    assert.ok(early > 0 && usedSeen > early);
    await call(`/api/workspaces/${seen}/archive`, {});
    const late = await usageService.report({ project: seen });
    assert.deepEqual([tokensOf(late), late.chats[0]!.archived, late.chats[0]!.read], [usedSeen, true, "store"], "archived after an earlier read: its final usage, not the earlier reading");
    const everything = await usageService.report();
    assert.equal(everything.chats.find(item => item.projectId === seen)!.spend.tokens.total, usedSeen);
    await call(`/api/workspaces/${seen}/unarchive`, {});
    assert.equal((await usageService.report({ project: seen })).chats[0]!.archived, false, "restored: reported as open again");
    console.log("ok: an archived workspace's chat usage is its store's final usage, read or not before, under the workspace's state now");

    // ---- 9. a workspace's artifacts, whatever the others have
    const artifactsOf = new ArtifactStore(path.join(life, "artifacts.sqlite"));
    const write = (workspace: string, n: number) => artifactsOf.write({ kind: "optchat", workspace }, { title: `${workspace} ${n}`, body: `# ${n}`, actions: [], projectId: workspace },
      { agent: "optchat", workspace }, `${workspace}-${n}`).revision.artifact;
    const own = write(quiet, 0);
    await delay(5);
    for (let n = 0; n < 201; n++) write(seen, n);
    artifactsOf.close();
    const mine = await call(`/api/artifacts?workspace=${quiet}`);
    assert.deepEqual(mine.body.artifacts.map((item: any) => item.id), [own], "the older artifact of this workspace is listed under 201 newer ones of another");
    assert.equal((await call(`/api/artifacts?workspace=${seen}`)).body.artifacts.length, 200);
    assert.ok((await call("/api/artifacts")).body.artifacts.every((item: any) => item.project.id === seen), "the list of everything is the newest 200, as before");
    await cubed.close();
    console.log("ok: a workspace's artifact list is chosen before the limit");
  }

  // ---- 7b. a shutdown held past the close's bound
  {
    // A shutdown held past the close's bound. The chat's Harness close is
    // held here (the one seam: nothing else is replaced), so `close()`
    // returns at its bound, as the product's does, with the store still the
    // old chat's. Every Harness open and close on the store is counted.
    const stuckState = await start(path.join(root, "stuck"), { chatReleaseWaitMs: 300 });
    const { call, say } = stuckState;
    await stuckState.ready();
    const { chats, usage: usageService } = stuckState.app;
    const stuck = (await call("/api/workspaces", { name: "stuck", repositories: [] })).body.workspace.id as string;
    await say(chatOf(stuck), "before the stuck close", "k-1");
    const first = (await chats.get(stuck, "write")).chat;
    const harness = (first as unknown as { harness: { close(...args: unknown[]): Promise<unknown> } }).harness;
    const closeHarness = harness.close.bind(harness);
    let letGo!: () => void;
    const held = new Promise<void>(resolve => { letGo = resolve; });
    let owners = 1, most = 1, harnessClosed = false;
    harness.close = async (...args) => { await held; try { return await closeHarness(...args); } finally { harnessClosed = true; owners--; } };
    const opens: string[] = [];
    const open = OptChat.open;
    OptChat.open = async options => {
      if (options.workspace !== stuck) return open.call(OptChat, options);
      opens.push(harnessClosed ? "after the old owner let go" : "WHILE THE OLD OWNER HELD THE STORE");
      const chat = await open.call(OptChat, options);
      most = Math.max(most, ++owners);
      void chat.released.then(() => { owners--; });
      return chat;
    };
    try {
      const beganAt = Date.now();
      const archive = await call(`/api/workspaces/${stuck}/archive`, {});
      assert.equal(archive.status, 200, "the archive itself ends at the close's bound");
      assert.ok(Date.now() - beganAt >= 1_900, "the close waited out its join bound");
      assert.equal(harnessClosed, false, "and returned with the old Harness still closing");
      // Reads, a restore and the reopen it starts, while the old owner holds the store.
      const [read, view, restore, usageRead] = await Promise.all([call(`${chatOf(stuck)}/history`), call(`${chatOf(stuck)}/view`),
        call(`/api/workspaces/${stuck}/unarchive`, {}), usageService.report({ project: stuck })]);
      assert.deepEqual([read.status, view.status], [503, 503], "a read is refused while the store is not free");
      assert.match(read.body.error, /still closing: its store is not free yet/);
      assert.equal(restore.status, 200, "the restore is recorded");
      assert.equal(usageRead.chats[0]!.read, "none", "usage does not open the store either");
      assert.equal((await call(`${chatOf(stuck)}/prompt`, { text: "too early", requestId: "k-2" })).status, 503);
      assert.equal(await chats.peek(stuck), null);
      await call(`/api/workspaces/${stuck}/archive`, {});
      assert.equal((await call(`${chatOf(stuck)}/history`)).status, 503, "archived again: still refused");
      await call(`/api/workspaces/${stuck}/unarchive`, {});
      await delay(700);
      assert.deepEqual([opens, most, harnessClosed], [[], 1, false], "nothing opened the store in all that time");
      // The old owner's shutdown really ends: the store is free and the chat comes back.
      letGo();
      await first.released;
      await say(chatOf(stuck), "after the old owner let go", "k-3");
      const back = (await chats.get(stuck, "write")).chat;
      assert.notEqual(back, first);
      assert.equal(back.identity, first.identity, "the same store");
      assert.ok(JSON.stringify((await call(`${chatOf(stuck)}/history`)).body).includes("before the stuck close"), "with its chat as it was");
      assert.ok(opens.length >= 1 && opens.every(when => when === "after the old owner let go"), `every open came after the release: ${opens.join("; ")}`);
      assert.equal(most, 1, "the store never had two owners");

      // Deleted while its closed chat still holds the store.
      const gone = (await call("/api/workspaces", { name: "gone", repositories: [] })).body.workspace.id as string;
      await say(chatOf(gone), "soon deleted", "g-1");
      const leaving = (await chats.get(gone, "write")).chat;
      const grip = hold(leaving);
      const directory = path.dirname(chatDirectory(path.join(root, "stuck"), gone));
      const database = path.join(directory, "chat", "pi.sqlite");
      const opened: string[] = [];
      const wrapped = OptChat.open;
      OptChat.open = async options => { if (options.workspace === gone) opened.push("opened"); return wrapped.call(OptChat, options); };
      try {
        assert.equal((await call(`/api/workspaces/${gone}`, undefined, "DELETE")).status, 200);
        assert.equal(grip.closed(), false, "the delete returned with the old chat's Harness still closing");
        assert.equal((await call(`/api/workspaces/${gone}`)).status, 404, "the workspace is gone");
        assert.equal((await call(`${chatOf(gone)}/view`)).status, 404, "and has no chat to open");
        await delay(600);
        assert.ok(fs.existsSync(database), "its directory is kept while the old chat holds the store");
        assert.deepEqual(opened, [], "nothing opened the store meanwhile");
        grip.letGo();
        await leaving.released;
        await until(async () => fs.existsSync(directory), gone => !gone, "the directory is removed once the old chat has let go");
        assert.deepEqual(opened, []);
      } finally { OptChat.open = wrapped; grip.letGo(); }
    } finally { OptChat.open = open; letGo(); await stuckState.close(); }
    console.log("ok: a close that returns at its bound with its Harness still closing keeps the store: reads, restore and reopen are refused, then the chat recovers once it has let go; a deleted workspace's directory stays until then");
  }

  // ---- 6b. the old chat, settled and closed, still holding its store
  {
    const heldState = path.join(root, "held");
    await before(heldState, ["solo"], ["before the held close"], true);
    const originalFile = path.join(heldState, "optchat", "pi.sqlite");
    let old: OptChat | undefined, grip: ReturnType<typeof hold> | undefined;
    const copies: string[] = [];
    const open = OptChat.open;
    OptChat.open = async options => {
      if (options.workspace === "solo") copies.push(grip && !grip.closed() ? "WHILE THE OLD CHAT HELD ITS STORE" : "after the old chat let go");
      const chat = await open.call(OptChat, options);
      if (!options.workspace && options.directory === path.join(heldState, "optchat")) { old = chat; grip = hold(chat); }
      return chat;
    };
    cubed = await start(heldState, { workspaceIdleMs: 20_000, chatReleaseWaitMs: 300 });
    ({ call } = cubed);
    try {
      // cubed opens the old chat to end its waiting message's turn; the answer comes, the chat is idle and is closed.
      await until(async () => hung !== null, Boolean, "the old chat goes on with its waiting message");
      (hung as (() => void) | null)?.(); hung = null;
      const failed = await cubed.ready();
      assert.equal(grip!.closed(), false, "its close returned with its Harness still closing");
      assert.equal(failed.body.chats.state, "failed");
      assert.match(failed.body.chats.error, /has not let go of its store yet, so it was not copied/);
      const nothingCopied = () => {
        assert.ok(!fs.existsSync(chatDirectory(heldState, "solo")), "no workspace chat was made");
        assert.deepEqual(fs.readdirSync(path.join(heldState, "workspaces", "solo")), [], "and no copy, whole or half, was left");
        assert.equal(migrationRecord(heldState)!.state, "copying");
        assert.deepEqual(copies, [], "no workspace chat was opened");
      };
      nothingCopied();
      const refused = await call(`${chatOf("solo")}/view`);
      assert.equal(refused.status, 503);
      assert.match(refused.body.error, /workspaces are not available: .*has not let go of its store/);
      await delay(700);
      assert.equal((await call(`${chatOf("solo")}/view`)).status, 503, "still refused, and not tried again, while the store is held");
      nothingCopied();
      // The old chat's Harness closes at last: the next request runs the migration.
      grip!.letGo();
      await old!.released;
      const view = await until(() => call(`${chatOf("solo")}/view`), answer => answer.status === 200, "the workspace's chat opens once the old chat has let go");
      assert.ok(view.body.messages >= 2);
      assert.ok(JSON.stringify((await call(`${chatOf("solo")}/history`)).body).includes("before the held close"), "with the old chat in it");
      assert.equal(migrationRecord(heldState)!.state, "done");
      assert.equal((await call("/api/workspaces")).body.chats.state, "ready");
      assert.ok(copies.length >= 1 && copies.every(when => when === "after the old chat let go"), copies.join("; "));
      assert.ok(fs.existsSync(originalFile), "the original stays");
    } finally { OptChat.open = open; grip?.letGo(); await cubed.close(); }
    console.log("ok: the old chat closed but still holding its store: nothing is copied or opened, every chat route says why; once it has let go the migration runs");
  }

  // ---- 6. the old chat still working when cubed starts
  const busy = path.join(root, "busy");
  await before(busy, ["solo"], ["before the hang"], true);
  cubed = await start(busy, { workspaceIdleMs: 400 });
  ({ call } = cubed);
  const failed = await cubed.ready();
  assert.ok(hung, "the old chat was opened once more and went on with its waiting message");
  assert.equal(failed.body.chats.state, "failed");
  assert.match(failed.body.chats.error, /was still working after 0 s, so it was not copied/);
  const refusedChat = await call(`${chatOf("solo")}/view`);
  assert.equal(refusedChat.status, 503);
  assert.match(refusedChat.body.error, /workspaces are not available: the chat from before workspaces was still working/);
  assert.equal((await call("/api/optchat/prompt", { text: "hello?", requestId: "s-1" })).status, 503);
  assert.ok(!fs.existsSync(chatDirectory(busy, "solo")), "no workspace chat was made");
  assert.equal((await call("/api/workspaces")).status, 200, "the rest of cubed works");
  await cubed.close();
  // The next start: the cut-off turn is settled as after any stop, and the copy is made.
  (hung as (() => void) | null)?.(); hung = null;
  cubed = await start(busy, { workspaceIdleMs: 20_000 });
  ({ call } = cubed);
  assert.equal((await cubed.ready()).body.chats.state, "ready");
  assert.match((await call("/api/optchat/view")).body.view, /before the hang|a summary/, "one workspace: the old route needs no name");
  await cubed.close();
  console.log("ok: a chat still working at start: workspaces stay closed with the reason on every chat route; the next start copies it");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("workspaces api: ok");
