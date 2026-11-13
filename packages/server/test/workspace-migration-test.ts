/** From one chat to one chat per workspace, over real stores; offline and
 * disposable. The registry, the artifact store, the chats (OptChat over a
 * faux model) and the migration are the product's; threads are stand-ins
 * that record what a chat did to them and report as Conversations does.
 *
 *   1. A chat from before workspaces with threads in two projects, a report
 *      it already took, images, instructions and artifacts.
 *   2. The migration: stopped at each kind of point and run again, then run
 *      twice more, it ends the same; the original is not written; a
 *      workspace made after it began gets no copy.
 *   3. A turn under way: not copied; copied once the chat has ended it.
 *   4. A store opens only for its own workspace.
 *   5. Reports: none again after the copy or a restart; a new one in one chat.
 *   6. A chat reaches its own workspace only (spawn, tell, history, archive).
 *   7. Thread memory: a view frozen before the copy still reads; no other chat's.
 *   8. Artifacts: each chat its own, the same request key in two chats, the
 *      old chat's without a project deleted after a backup.
 *   9. Usage: each chat since its copy, the past once.
 *  10. Archive: refused with an open thread, no thread after it, the chat
 *      read-only, restored as it was. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Artifacts, type ArtifactScope } from "../src/artifact-service.ts";
import { ArtifactStore, type ArtifactAuthor } from "../src/artifacts.ts";
import type { GithubPulls } from "../src/github-pulls.ts";
import { OptChat, type OptThreads, type ThreadRecord } from "../src/optchat.ts";
import { Registry } from "../src/registry.ts";
import type { RunFeed } from "../src/thread-events.ts";
import type { HistoryPage } from "../src/thread-history.ts";
import { ThreadMemory } from "../src/thread-memory.ts";
import { UsageService, type OptChatUsage } from "../src/usage-service.ts";
import { WorkspaceChatError, WorkspaceChats, workspaceThreads } from "../src/workspace-chats.ts";
import { chatDirectory, migrateWorkspaces, MigrationNotIdle, migrationRecord, type MigrationOptions } from "../src/workspace-migration.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-workspaces-"));
const state = path.join(root, "state");
fs.mkdirSync(state, { recursive: true });
const faux = fauxProvider({ tokensPerSecond: 100_000 });
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, id: faux.getModel().id };
const textOf = (message: Message) => typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text : "").join("");
let hung: (() => void) | null = null;
faux.setResponses(Array.from({ length: 2000 }, () => async (request: { messages: Message[] }) => {
  if (request.messages.some(message => message.role === "system" && textOf(message).includes("You write the memory of OptChat"))) return fauxAssistantMessage("a summary");
  const last = request.messages.at(-1)!;
  if (last.role !== "user") return fauxAssistantMessage("noted");
  // The turn's message is the last block; the ones before it are the chat's view.
  const said = typeof last.content === "string" ? last.content : last.content.flatMap(part => part.type === "text" ? [part.text] : []).at(-1) ?? "";
  if (said.includes("please hang")) await new Promise<void>(resolve => { hung = resolve; });
  // `project` is what a model that remembers the old tool might still send.
  if (said.startsWith("spawn:")) return fauxAssistantMessage([fauxToolCall("spawn", { tasks: said.slice(6).split(",").map(project => ({ project, task: `work in ${project}` })) }, { id: `call-${said}` })], { stopReason: "toolUse" });
  if (said.startsWith("tell:")) return fauxAssistantMessage([fauxToolCall("tell", { id: said.slice(5), message: "go on" }, { id: `call-${said}` })], { stopReason: "toolUse" });
  return fauxAssistantMessage(`answer: ${said.slice(0, 40)}`);
}));

const registry = new Registry(path.join(state, "registry.sqlite"));
for (const n of [1, 2, 3]) registry.enrollRunner({ nodeId: `node-${n}`, environmentId: 1, threadId: `runner-${n}`, configPath: `/private/${n}.json`, configHash: `h${n}`, protocol: 4, kind: "vm" });
const workspace = (id: string) => registry.saveProject({ id, name: id, status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
const [W1, W2, W3] = ["w1", "w2", "w3"];
workspace(W1); workspace(W2);

// The threads as every chat sees them before scoping: what a chat did, and each thread's stored last run.
const runs = new Map<string, string>();
const feeds = new Set<(fact: RunFeed) => void>();
const told: string[] = [];
const page = (id: string): HistoryPage | null => runs.has(id)
  ? { agent: "pi", owner: null, status: { state: "completed", run: runs.get(id)! } as HistoryPage["status"], total: 2, answer: { index: 1, text: `${id.slice(0, 8)} did ${runs.get(id)}` }, asked: 0, start: 0, events: [] } : null;
const base: OptThreads = { startFailure: () => null, onStartFailure: () => () => {},
  onRunFeed: listener => { feeds.add(listener); return () => { feeds.delete(listener); }; },
  projects: async only => `projects ${only ?? "all"}`, runners: async () => "", describe: async ids => ids.map(id => id.slice(0, 8)).join(","),
  spawn: async (task, requestId) => { const thread = registry.createThread(task.project, requestId, model, task.task); return { id: thread.id, title: thread.title ?? "" }; },
  tell: async id => { told.push(id); },
  events: async id => registry.getThread(id) ? "stored" : null,
  history: async id => registry.getThread(id) ? { transcript: page(id) } as unknown as ThreadRecord : null,
  archive: async id => registry.getThread(id) ? { already: false, disk: "none", free: "1 of 3" } : null,
};
/** A thread's run settles: its feed closes, as Conversations tells it. */
const settle = (id: string, run: string) => { runs.set(id, run); for (const feed of [...feeds]) feed({ thread: id, open: false }); };
const limits = { retryMs: 50, watchMs: 50, closeMs: 300 };
const open = (directory: string, bound?: string, readOnly = false) => OptChat.open({ directory, models, model: async () => model, limits, artifacts,
  ...bound ? { workspace: bound, readOnly, threads: workspaceThreads(base, registry, bound) } : { threads: base } });
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  for (const deadline = Date.now() + ms; !await check();) { assert.ok(Date.now() < deadline, what); await delay(20); }
}
const say = async (chat: OptChat, text: string, requestId: string) => {
  const before = chat.memory.length;
  await chat.send(text, requestId);
  await until(async () => chat.memory.length > before && await chat.idle(), `the chat answers ${text}`);
};
const quiet = async (chat: OptChat) => { await delay(300); await until(() => chat.idle(), "the chat is idle"); };
const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const tokens = (usage: OptChatUsage) => [...Object.values(usage.chat.models), ...Object.values(usage.compactor.models)].reduce((sum, item) => sum + item.totalTokens, 0);

const store = new ArtifactStore(path.join(state, "artifacts.sqlite"));
const chatsByWorkspace = new Map<string, OptChat>();
const artifacts = new Artifacts({ store, registry, github: {} as GithubPulls, optchat: async id => chatsByWorkspace.get(id) ?? null, submit: async () => {}, retryMs: 50 });
const original = path.join(state, "optchat");

try {
  // ---- 1. the chat before workspaces
  const old = await open(original);
  await say(old, "hello from before workspaces", "u1");
  await say(old, `spawn:${W1},${W2}`, "u2");
  const [T1, T2] = [W1, W2].map(id => registry.listThreads().find(thread => thread.projectId === id)!.id) as [string, string];
  assert.deepEqual((await old.usage()).threads.sort(), [T1, T2].sort());
  const reported = old.memory.length;
  settle(T1, "run-1");
  await until(() => old.memory.render().includes(`[${T1.slice(0, 8)}]`), "the old chat takes T1's report");
  await quiet(old);
  const legacy = { identity: old.identity, messages: old.memory.length, view: old.memory.render(), usage: await old.usage() };
  assert.ok(legacy.messages > reported && tokens(legacy.usage) > 0);
  const before: ArtifactAuthor = { kind: "optchat", workspace: null };
  const unowned = store.write(before, { title: "notes for no project", body: "# old", actions: [], projectId: null }, { agent: "optchat", call: "a" }, "old-1").revision.artifact;
  const owned = store.write(before, { title: "plan for w1", body: "# w1", actions: [], projectId: W1 }, { agent: "optchat", call: "b" }, "old-2").revision.artifact;
  const threadsOwn = store.write({ kind: "thread", thread: T2 }, { title: "thread notes", body: "# t2", actions: [], projectId: W2 }, { agent: "pi", thread: T2 }, "old-3").revision.artifact;
  store.comment(unowned, { revision: 1, anchor: { quote: "old", prefix: "# ", suffix: "", start: 2, end: 5, section: "" }, body: "a comment" }, "old-c1");
  // T1 froze its memory from the old chat.
  registry.captureMemory(T1, { chat: legacy.identity, length: legacy.messages, capturedAt: 1, text: "frozen view" });
  await old.close();
  fs.mkdirSync(path.join(original, "media"), { recursive: true });
  fs.writeFileSync(path.join(original, "media", "image.bin"), "image bytes");
  fs.writeFileSync(path.join(original, "AGENTS.md"), "the user's instructions\n");
  const originalDigest = digest(path.join(original, "pi.sqlite"));

  // ---- 2. the migration, interrupted and repeated
  const options: MigrationOptions = { state, registry, models, artifacts: store, settle: async () => { throw new Error("the store is idle: no settling is needed"); } };
  // Stopped after the first copy: the second workspace's threads cannot be read.
  let reads = 0;
  await assert.rejects(migrateWorkspaces({ ...options, registry: { listProjects: () => registry.listProjects(), listThreads: () => { if (++reads === 2) throw new Error("crash after one copy"); return registry.listThreads(); } } }), /crash after one copy/);
  assert.equal(migrationRecord(state)!.state, "copying");
  assert.ok(fs.existsSync(chatDirectory(state, W1)) && !fs.existsSync(chatDirectory(state, W2)), "one copy is in place, the other not begun");
  const firstCopy = digest(path.join(chatDirectory(state, W1), "pi.sqlite"));
  // A copy a crash left half made, and a workspace made since the migration began.
  fs.mkdirSync(path.join(state, "workspaces", W2, ".chat-copy-left"), { recursive: true });
  fs.writeFileSync(path.join(state, "workspaces", W2, ".chat-copy-left", "pi.sqlite"), "half a copy");
  workspace(W3);
  // Stopped after the copies, before the artifacts.
  await assert.rejects(migrateWorkspaces({ ...options, artifacts: { ...store, countUnownedChatArtifacts: () => { throw new Error("crash before the artifacts"); } } as never }), /crash before the artifacts/);
  assert.equal(migrationRecord(state)!.state, "copying");
  assert.ok(store.get(unowned), "nothing is deleted before the copies are done and the backup is made");
  const done = await migrateWorkspaces(options);
  assert.equal(done.state, "done");
  assert.deepEqual(done.workspaces, [W1, W2], "the workspaces that existed when it began");
  assert.equal(done.source!.identity, legacy.identity);
  assert.equal(tokens(done.source!.usage), tokens(legacy.usage));
  assert.equal(digest(path.join(chatDirectory(state, W1), "pi.sqlite")), firstCopy, "a finished copy is not made again");
  assert.ok(fs.existsSync(chatDirectory(state, W2)) && !fs.existsSync(path.join(state, "workspaces", W2, ".chat-copy-left")), "the half copy is gone, the whole one in place");
  assert.ok(!fs.existsSync(chatDirectory(state, W3)), "a workspace made after the migration began gets no copy");
  for (const id of [W1, W2]) {
    assert.equal(fs.readFileSync(path.join(chatDirectory(state, id), "media", "image.bin"), "utf8"), "image bytes");
    assert.equal(fs.readFileSync(path.join(chatDirectory(state, id), "AGENTS.md"), "utf8"), "the user's instructions\n");
  }
  assert.equal(digest(path.join(original, "pi.sqlite")), originalDigest, "the original is not written");
  // Artifacts: the old chat's without a project is gone with its comment, after a copy of the file; the rest stay.
  assert.equal(store.get(unowned), null);
  assert.ok(store.get(owned) && store.get(threadsOwn));
  assert.equal(done.deletedArtifacts, 1);
  const saved = new DatabaseSync(done.artifactsBackup!, { readOnly: true });
  assert.equal((saved.prepare("SELECT count(*) AS n FROM artifacts").get() as { n: number }).n, 3, "the backup holds every artifact from before");
  assert.equal((saved.prepare("SELECT count(*) AS n FROM comments WHERE artifact = ?").get(unowned) as { n: number }).n, 1);
  saved.close();
  // Again, twice: nothing changes.
  const digests = () => [W1, W2].map(id => digest(path.join(chatDirectory(state, id), "pi.sqlite")));
  const [settledDigests, record] = [digests(), fs.readFileSync(path.join(state, "workspaces", "migration.json"), "utf8")];
  await migrateWorkspaces(options); await migrateWorkspaces(options);
  assert.deepEqual(digests(), settledDigests);
  assert.equal(fs.readFileSync(path.join(state, "workspaces", "migration.json"), "utf8"), record);
  assert.ok(store.get(owned));
  console.log("ok: migration: interrupted after one copy and before the artifacts, then run to the end and twice more: the same end; the original unwritten; a later workspace starts empty; artifacts without a project deleted after a backup");

  // ---- 3. a turn under way is not copied
  {
    const other = path.join(root, "state-busy");
    fs.mkdirSync(other, { recursive: true });
    const busy = new Registry(path.join(other, "registry.sqlite"));
    busy.saveProject({ id: "b1", name: "b1", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
    const chat = await open(path.join(other, "optchat"));
    await say(chat, "before the hang", "b-u1");
    await chat.send("please hang", "b-u2");
    await until(() => hung !== null, "the turn's request is out");
    assert.equal(await chat.idle(), false);
    const busyStore = new ArtifactStore(path.join(other, "artifacts.sqlite"));
    const copying = (settleChat: MigrationOptions["settle"]) => migrateWorkspaces({ state: other, registry: busy, models, artifacts: busyStore, settle: settleChat });
    // The chat was killed mid-turn (its store read as it is, the process still holding it).
    await assert.rejects(copying(async () => { throw new MigrationNotIdle("still working after the wait"); }), MigrationNotIdle);
    assert.ok(!fs.existsSync(chatDirectory(other, "b1")), "nothing is copied while a turn is under way");
    assert.deepEqual(fs.readdirSync(path.join(other, "workspaces", "b1")), [], "and no half copy is left");
    assert.equal(migrationRecord(other)!.state, "copying");
    // Its turn ends; the next try settles the chat and copies it.
    hung!(); hung = null;
    await until(() => chat.idle(), "the turn ends");
    await chat.close();
    let settledOnce = 0;
    assert.equal((await copying(async () => { settledOnce++; })).state, "done");
    assert.equal(settledOnce, 0, "an idle store needs no settling");
    assert.ok(fs.existsSync(chatDirectory(other, "b1")));
    busyStore.close(); busy.close();
    console.log("ok: a turn under way: not copied, nothing left behind; copied once it has ended");
  }

  // ---- 4. a store opens only for its own workspace
  await assert.rejects(open(chatDirectory(state, W1), W2), /belongs to workspace w1, not w2/);
  await assert.rejects(open(chatDirectory(state, W1)), /belongs to workspace w1, not the chat before workspaces/);
  await assert.rejects(open(original, W1), /belongs to no workspace; not opened for workspace w1/);
  // A refused open adopts nothing: the old chat still opens as itself, unbound.
  const still = await open(original);
  assert.deepEqual([still.identity, still.memory.length, still.origin], [legacy.identity, legacy.messages, null]);
  await still.close();

  // ---- 5. reports
  const [c1, c2] = await Promise.all([open(chatDirectory(state, W1), W1), open(chatDirectory(state, W2), W2)]) as [OptChat, OptChat];
  chatsByWorkspace.set(W1, c1); chatsByWorkspace.set(W2, c2);
  assert.ok(c1.identity !== legacy.identity && c2.identity !== legacy.identity && c1.identity !== c2.identity, "each copy has its own identity");
  assert.deepEqual([c1.origin, c2.origin], [legacy.identity, legacy.identity]);
  assert.deepEqual([c1.memory.render(), c2.memory.render()], [legacy.view, legacy.view], "each has the whole chat: log and summaries");
  assert.deepEqual([(await c1.usage()).threads, (await c2.usage()).threads], [[T1], [T2]], "each watches its own workspace's threads");
  // T1's run was reported before the copy: both chats hold that report, neither takes it again.
  for (const feed of [...feeds]) feed({ thread: T1, open: false });
  await delay(400);
  assert.deepEqual([c1.memory.length, c2.memory.length], [legacy.messages, legacy.messages], "a run reported before the copy is not reported again");
  settle(T2, "run-2");
  await until(() => c2.memory.render().includes("did run-2"), "T2's chat takes its report");
  await quiet(c2); await quiet(c1);
  assert.equal(c1.memory.length, legacy.messages, "the other workspace's chat hears nothing of it");
  const afterReport = c2.memory.length;
  assert.equal(c2.memory.render().split("did run-2").length - 1, 1, "once");
  console.log("ok: reports: none again after the copy; a new run reports in its own workspace's chat, once");

  // ---- 6. a chat reaches its own workspace only
  await say(c1, `spawn:${W2}`, "c1-spawn");
  const inW1 = registry.listThreads().filter(thread => thread.projectId === W1).map(thread => thread.id);
  assert.equal(inW1.length, 2, "the thread starts in the chat's own workspace, whatever project the call named");
  assert.equal(registry.listThreads().filter(thread => thread.projectId === W2).length, 1);
  const T3 = inW1.find(id => id !== T1)!;
  assert.deepEqual((await c1.usage()).threads.sort(), [T1, T3].sort());
  await say(c1, `tell:${T2.slice(0, 8)}`, "c1-tell");
  assert.deepEqual(told, [], "a thread of another workspace is no thread to this chat");
  const scoped = workspaceThreads(base, registry, W1);
  await assert.rejects(scoped.tell(T2, "x", "r"), /no thread .* in this workspace/);
  assert.equal(await scoped.history(T2), null);
  assert.equal(await scoped.events(T2), null);
  assert.equal(await scoped.archive!(T2), null);
  assert.equal(await scoped.describe([T1, T2]), T1.slice(0, 8));
  assert.equal(await scoped.projects(), "projects w1");
  await scoped.tell(T1, "x", "r");
  assert.deepEqual(told, [T1]);
  console.log("ok: scoping: spawn lands in the chat's workspace; another workspace's thread cannot be told, read, watched or archived");

  // ---- 7. thread memory
  const memory = new ThreadMemory({ registry, chat: async id => chatsByWorkspace.get(id)!, waitMs: 500 });
  const zoom = async (thread: string, id: number) => String(await memory.tools(thread).find(tool => tool.name === "memory_zoom")!.run({ id, n: 1 }, { id: "call", key: "key" } as never));
  assert.match(await zoom(T1, 0), /hello from before workspaces/, "a view frozen from the old chat reads its workspace's copy");
  assert.doesNotMatch(await zoom(T1, afterReport - 1), /did run-2/, "and never the other workspace's chat");
  assert.match(await zoom(T2, legacy.messages), /did run-2/, "a thread reads its own workspace's chat, newer messages too");
  registry.captureMemory(T3, { chat: "optchat-of-some-other-store", length: 1, capturedAt: 1, text: "frozen" });
  assert.match(await zoom(T3, 0), /this thread's view came from an earlier chat/, "a view from a chat that is neither this one nor its original is refused");
  console.log("ok: memory: a thread frozen before the copy zooms old messages in its workspace's chat; no thread reads another workspace's");

  // ---- 8. artifacts
  const scopeOf = (id: string): ArtifactScope => ({ agent: { kind: "optchat", workspace: id }, authors: [{ kind: "optchat", workspace: id }] });
  // The same tool-call key in both chats (their task ids are the same numbers): the identity keeps them apart.
  const a1 = await artifacts.write(scopeOf(W1), { title: "new plan", body: "# from w1" }, { agent: "optchat", call: "x" }, `${c1.identity}:artifact:7`);
  const a2 = await artifacts.write(scopeOf(W2), { title: "new plan", body: "# from w2" }, { agent: "optchat", call: "x" }, `${c2.identity}:artifact:7`);
  assert.notEqual(a1.id, a2.id);
  assert.deepEqual([store.get(a1.id)!.projectId, store.get(a2.id)!.projectId], [W1, W2], "a chat's artifact belongs to its workspace");
  assert.throws(() => artifacts.read(scopeOf(W1), a2.id), /no artifact .* you can read/);
  assert.match(artifacts.read(scopeOf(W1), owned), /plan for w1/, "the old chat's artifact for this workspace is this chat's now");
  assert.throws(() => artifacts.read(scopeOf(W2), owned), /no artifact .* you can read/);
  // The user's comments on it reach that workspace's chat, and only it.
  store.comment(owned, { revision: 1, anchor: { quote: "w1", prefix: "# ", suffix: "", start: 2, end: 4, section: "" }, body: "please revise" }, "c-owned");
  const lengths = [c1.memory.length, c2.memory.length];
  artifacts.queue(owned, "send-owned");
  await until(() => c1.memory.render().includes("please revise") || c1.memory.length > lengths[0]!, "the comment reaches w1's chat");
  await quiet(c1); await quiet(c2);
  assert.equal(c2.memory.length, lengths[1], "not the other chat");
  console.log("ok: artifacts: one per chat under the same call key; a chat reads its workspace's only; comments go to the artifact's own chat");

  // ---- 9. usage
  const [u1, u2] = [await c1.usage(), await c2.usage()];
  assert.ok(tokens(u1) > 0, "w1's chat has worked since its copy");
  const service = new UsageService({ file: path.join(state, "usage.sqlite"), registry, threads: path.join(state, "threads"), live: async () => null,
    chats: async () => [{ workspace: W1, usage: await c1.usage() }, { workspace: W2, usage: await c2.usage() }],
    chatStore: id => path.join(chatDirectory(state, id), "pi.sqlite"), before: () => migrationRecord(state)!.source!.usage });
  const everything = await service.optchatUsage();
  const sum = (lines: Array<{ spend: { tokens: { total: number } } }>) => lines.reduce((total, line) => total + line.spend.tokens.total, 0);
  assert.equal(sum(everything.usage.lines), tokens(legacy.usage) + tokens(u1) + tokens(u2), "everything: the past once, and each chat since its copy");
  assert.equal(sum(everything.before!.lines), tokens(legacy.usage));
  const own = await service.optchatUsage(W1);
  assert.equal(sum(own.usage.lines), tokens(u1), "a workspace: its own chat since the copy");
  assert.equal(own.before, null);
  assert.deepEqual(everything.chats.find(item => item.projectId === W3)!.notes, ["the chat has not started"]);
  service.close();
  console.log("ok: usage: the chat before workspaces counted once; each workspace's chat from its copy on");

  // ---- restart: nothing is reported or counted again
  await Promise.all([c1.close(), c2.close()]);
  const [r1, r2] = await Promise.all([open(chatDirectory(state, W1), W1), open(chatDirectory(state, W2), W2)]) as [OptChat, OptChat];
  chatsByWorkspace.set(W1, r1); chatsByWorkspace.set(W2, r2);
  for (const feed of [...feeds]) { feed({ thread: T1, open: false }); feed({ thread: T2, open: false }); }
  await delay(400);
  assert.deepEqual([r1.identity, r2.identity], [c1.identity, c2.identity]);
  assert.equal(r2.memory.render().split("did run-2").length - 1, 1, "a restart reports nothing again");
  assert.equal(tokens(await r2.usage()), tokens(u2));
  await Promise.all([r1.close(), r2.close()]);

  // ---- 10. archive
  assert.throws(() => registry.archiveProject(W1), /has 2 open threads/);
  assert.equal(registry.getProject(W1)!.archivedAt, undefined);
  const chats = new WorkspaceChats({ registry, ready: async () => {}, open: async (item, readOnly) => ({ chat: await open(chatDirectory(state, item.id), item.id, readOnly) }) });
  const live = (await chats.get(W3, "write")).chat;
  assert.equal(live.memory.length, 0, "a workspace made after the migration starts with an empty chat");
  await say(live, "first words in w3", "w3-u1");
  const identity = live.identity;
  // Of an archive and a thread creation, the first wins.
  const T4 = registry.createThread(W3, "w3-thread", model, "a thread").id;
  await assert.rejects(chats.archive(W3), /has 1 open thread/);
  registry.applyPhase(T4, { type: "released" });
  assert.ok((await chats.archive(W3)).archivedAt);
  assert.throws(() => registry.createThread(W3, "w3-late", model, "too late"), /the workspace is archived/);
  await assert.rejects(workspaceThreads(base, registry, W3).spawn({ project: W3, task: "late" }, "w3-late-2"), /the workspace is archived/);
  await assert.rejects(chats.get(W3, "write"), (error: unknown) => error instanceof WorkspaceChatError && error.status === 409);
  const kept = (await chats.get(W3)).chat;
  assert.match(kept.memory.render(), /first words in w3/, "an archived workspace's chat stays readable");
  await assert.rejects(kept.send("more", "w3-u2"), /the workspace is archived/);
  assert.equal(await chats.peek(W3), null, "and is not one of the chats that work");
  await chats.unarchive(W3);
  const back = (await chats.get(W3, "write")).chat;
  assert.equal(back.identity, identity, "restored: the same store");
  await say(back, "back again", "w3-u3");
  await chats.closeAll();
  console.log("ok: archive: refused with an open thread; then no thread starts, the chat is read-only and readable; restored as it was");
} finally {
  artifacts.close(); store.close(); registry.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("workspace migration: ok");
