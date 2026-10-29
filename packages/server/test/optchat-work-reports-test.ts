/** A report to OptChat is work, not the user's words: offline and disposable,
 * over the real chat and Pi SQLite store with a faux model.
 *
 *   1. Every way a report enters the log (a turn's input, steered into a
 *      tool round, written into a batch, written unanswered at a stop)
 *      stores a `pi.user` entry, as before: the store gains no entry kind,
 *      and the report's Pi submission keeps its `report:` request id. The
 *      provider only ever gets user, assistant and tool result messages.
 *   2. Read from those request ids, the log, zoom, the view and the
 *      compactor's input tag reports `work:` and the user's messages
 *      `user:`. A long report after the stored view (its node held at the
 *      close) is work after a reopen too.
 *   3. The transcript still shows a report as the thread's message.
 *   4. A reader that does not know work (cubed before it) reads the same
 *      store as as many messages with the same text, the reports as user:
 *      no report is lost and no id moves, so neither refuses the other.
 *   5. `entryMessages`: work changes only the kind, pages included. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import type { ConversationId, Cursor, EntryRecord, Page } from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { readStorage } from "../src/durable-agent.ts";
import { entryMessages, OptChat, OptChatEvents, type OptThreads } from "../src/optchat.ts";
import { CAP } from "../src/optchat-memory.ts";
import { PiThreadEvents } from "../src/pi-thread-events.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-work-"));
const blocks = (message: Message) => typeof message.content === "string" ? [message.content]
  : message.content.map(part => part.type === "text" ? part.text : "");
const gate = () => { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; };

type Reply = ReturnType<typeof fauxAssistantMessage>;
let script: Array<(messages: Message[]) => Reply> = [];
const roles = new Set<string>();
const compactorInputs: string[] = [];
let compactorGate: Promise<void> = Promise.resolve();
let projectsGate: Promise<void> = Promise.resolve();
let inProjects = false;
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 200 }, () => async (request: { messages: Message[] }, options?: { signal?: AbortSignal }) => {
  for (const message of request.messages) roles.add(message.role);
  const system = request.messages.find(message => message.role === "system");
  if (system && blocks(system).join("").includes("You write the memory of OptChat")) {
    // A close's cut aborts a held answer, as a provider's request ends.
    await Promise.race([compactorGate, new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }))]);
    compactorInputs.push(request.messages.filter(message => message.role === "user").flatMap(blocks).join("\n"));
    return fauxAssistantMessage("summary");
  }
  const next = script.shift();
  assert.ok(next, "a scripted reply exists");
  return next(request.messages.filter(message => message.role !== "system"));
}));
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, id: faux.getModel().id };

const THREAD = "abcdef12-0000-4000-8000-000000000001";
const threads: OptThreads = { startFailure: () => null, onStartFailure: () => () => {}, onRunFeed: () => () => {},
  async projects() { inProjects = true; await projectsGate; inProjects = false; return "projects:\ncube (id p1; ready)"; },
  async runners() { return ""; }, async describe() { return ""; }, async tell() {}, async history() { return null; },
  async spawn() { return { id: THREAD, title: "fix it" }; },
  async events() { return null; },
};
const directory = path.join(root, "optchat");
const open = () => OptChat.open({ directory, models, model: async () => model, threads, limits: { node: 64, retryMs: 50, watchMs: 50, closeMs: 200 } });
async function until(check: () => boolean, what: string) {
  for (let k = 0; k < 400 && !check(); k++) await delay(10);
  assert.ok(check(), what);
}
const idle = async (chat: OptChat) => {
  await until(() => script.length === 0, "the scripted replies were used");
  await chat.agent.conversation.waitForIdle(context);
};
/** Every record a scan gives. */
async function all<T>(scan: (cursor: Cursor | undefined) => Promise<Page<T, Cursor>>): Promise<T[]> {
  const out: T[] = [];
  let cursor: Cursor | undefined;
  do { const page = await scan(cursor); out.push(...page.items); cursor = page.next; } while (cursor);
  return out;
}
/** A conversation's entries, oldest first, as OptChat's log reads them. */
const entries = async (storage: SqliteStorage, conversationId: ConversationId) => (await all(cursor => storage.scanEntries({ conversationId }, 256, cursor, context))).sort((a, b) => a.id - b.id);
const submissions = (storage: SqliteStorage, conversationId: ConversationId) => all(cursor => storage.scanSubmissions({ conversationId }, 256, cursor, context));
const lastUser = (messages: Message[]) => blocks(messages.findLast(message => message.role === "user")!).at(-1);
const report = (run: string) => `report:${THREAD}:${run}`;
const LONG = `[abcdef12] done: PR #9 merged, tests pass ${"and more detail ".repeat(8)}`;
const LATE = `[abcdef12] late: PR #10 failed CI ${"with its log ".repeat(8)}`;
const REPORTS = ["[abcdef12] done: PR #7", "[abcdef12] steered in", LONG, "[abcdef12] waited, then stopped"];
const USERS = ["start a thread", "list projects", "prepare", "after the report", "prompt"];
const EXPECTED = [
  ["user", USERS[0]], ["work", REPORTS[0]], ["user", USERS[1]], ["work", REPORTS[1]], ["user", USERS[2]], ["work", LONG], ["user", USERS[3]],
  ["user", USERS[4]], ["work", REPORTS[3]], ["work", LATE],
];
const kinds = (chat: OptChat) => chat.memory.messages.filter(message => message.kind === "user" || message.kind === "work").map(message => [message.kind, message.text]);

let chat = await open();
const conversationId = chat.agent.conversation.id;
let view: string;
try {
  // A user message spawns the thread, so the transcript knows it as this chat's.
  script = [
    () => fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ project: "cube", task: "fix it" }] }, { id: "call-spawn" })], { stopReason: "toolUse" }),
    () => fauxAssistantMessage("started"),
  ];
  await chat.send(USERS[0]!, "u-start");
  await idle(chat);

  // A report that starts a turn: Pi's input.
  script = [messages => {
    assert.equal(lastUser(messages), REPORTS[0], "the report reaches the model as a user message");
    return fauxAssistantMessage("noted");
  }];
  await chat.send(REPORTS[0]!, report("run-1"));
  await idle(chat);

  // A report sent during a tool round is steered in.
  const projects = gate();
  projectsGate = projects.promise;
  script = [
    () => fauxAssistantMessage([fauxToolCall("projects", {}, { id: "call-projects" })], { stopReason: "toolUse" }),
    messages => {
      const after = messages.slice(messages.findIndex(message => message.role === "toolResult"));
      assert.deepEqual(after.filter(message => message.role === "user").map(message => blocks(message).join("")), [REPORTS[1]], "the steered report is a user message");
      return fauxAssistantMessage("ok");
    },
  ];
  await chat.send(USERS[1]!, "u-projects");
  await until(() => inProjects, "the projects tool runs");
  await chat.send(REPORTS[1]!, report("run-2"));
  await until(() => script.length === 1, "the steer is placed");
  projects.open();
  projectsGate = Promise.resolve();
  await idle(chat);

  // A report waiting with a user message goes into the batch first, written.
  const compacting = gate();
  compactorGate = compacting.promise;
  script = [
    () => fauxAssistantMessage(`a long enough reply to need the compactor ${"z".repeat(40)}`),
    messages => {
      assert.equal(messages.length, 2, "both waiting messages start one turn");
      assert.equal(blocks(messages[0]!).at(-1), LONG, "the report first, after the view");
      assert.deepEqual(blocks(messages[1]!), [USERS[3]]);
      return fauxAssistantMessage("both read");
    },
  ];
  await chat.send(USERS[2]!, "u-prepare");
  await until(() => script.length === 1, "the long reply is written");
  await delay(100);
  await chat.send(LONG, report("run-3"));
  await chat.send(USERS[3]!, "u-after");
  await delay(150);
  compacting.open();
  compactorGate = Promise.resolve();
  await idle(chat);

  // A report still waiting at a stop is written unanswered.
  const stalled = gate();
  compactorGate = stalled.promise;
  script = [() => fauxAssistantMessage(`another long reply to need the compactor ${"q".repeat(40)}`)];
  await chat.send(USERS[4]!, "u-prompt");
  await idle(chat);
  await chat.send(REPORTS[3]!, report("run-4"));
  await delay(100);
  await chat.stop();
  stalled.open();
  compactorGate = Promise.resolve();
  await delay(200);
  assert.deepEqual(await chat.pending(), [], "nothing waits after the stop");

  // 1. Every message is a pi.user entry; a report's submission says report:.
  const stored = await entries(chat.agent.storage, conversationId);
  const users = stored.filter(entry => entry.model?.[0]?.role === "user");
  const entryOf = (text: string) => users.filter(entry => blocks(entry.model![0]!).join("") === text);
  for (const text of [...REPORTS, ...USERS]) assert.deepEqual(entryOf(text).map(entry => entry.kind), ["pi.user"], `${text.slice(0, 30)}: one pi.user entry`);
  assert.deepEqual([...new Set(stored.map(entry => entry.kind))].sort(), ["optchat.turn", "pi.assistant", "pi.system", "pi.tool-result", "pi.user"], "the store gains no entry kind");
  const placedBy = new Map((await submissions(chat.agent.storage, conversationId)).flatMap(record => record.entry !== undefined ? [[record.entry as number, record.requestId]] : []));
  const requestOf = (text: string) => placedBy.get(entryOf(text)[0]!.id);
  assert.deepEqual(REPORTS.map(requestOf), [report("run-1"), report("run-2"), report("run-3"), `${report("run-4")}:unanswered`], "each report's submission keeps its request id");
  assert.ok(USERS.every(text => !requestOf(text)?.startsWith("report:")), "no user message's does");
  assert.deepEqual([...roles].sort(), ["assistant", "system", "toolResult", "user"], "the provider got only valid roles");

  // 2. The log, zoom, the view and the compactor read reports as work.
  await until(() => chat.memory.settled() && chat.memory.ready(new Set(), 8).length === 0, "the tree is complete");
  assert.deepEqual(kinds(chat), EXPECTED.slice(0, -1), "each message has its kind, in order");
  const first = chat.memory.messages.findIndex(message => message.text === REPORTS[0]);
  assert.equal(chat.memory.zoom(first, 1), `${first}+0|work: ${REPORTS[0]}`, "zoom shows the report as work");
  assert.ok(compactorInputs.some(input => input.includes(`work: ${LONG}`)), "the compactor reads the long report as work");
  assert.ok(compactorInputs.every(input => !input.includes("user: [abcdef12]")), "never as the user's");
  view = chat.memory.render();
  assert.ok(view.includes(`|work: ${REPORTS[0]}`) && !view.includes("user: [abcdef12]"), "the view tags the report as work");

  // 3. The transcript shows each report as the thread's.
  const shown = (await new OptChatEvents(chat, new PiThreadEvents({ agent: chat.agent, owner: () => null, failure: () => null })).read()).events;
  for (const text of REPORTS) {
    assert.deepEqual(shown.filter(event => event.type === "user-message" && event.text === text).map(event => event.type === "user-message" && event.from), ["abcdef12"], `${text.slice(0, 30)}: shown once, from the thread`);
  }
  assert.ok(shown.some(event => event.type === "user-message" && event.text === USERS[0] && !event.from), "the user's message stays the user's");

  // A long report after the stored view, its node held at the close.
  compactorGate = new Promise(() => {});
  script = [() => fauxAssistantMessage("noted late")];
  await chat.send(LATE, report("run-5"));
  await idle(chat);
  assert.deepEqual(kinds(chat).at(-1), ["work", LATE], "the late report is work");
} finally { await chat.close(); }
compactorGate = Promise.resolve();

// A reopen reads the kinds from the store again; the late report's node
// was cut at the close and is held, so it stays after the stored view.
chat = await open();
try {
  assert.deepEqual(kinds(chat), EXPECTED, "a reopen reads each message's kind from the store, the late report too");
  const late = chat.memory.messages.findIndex(message => message.text === LATE);
  assert.match(chat.memory.render(), new RegExp(`\\n${late}\\+1\\|\\(not summarized yet`), "the late report is after the stored view");
  assert.equal(chat.memory.zoom(late, 1), `${late}+0|work: ${LATE}`);
  view = chat.memory.render();
} finally { await chat.close(); }
console.log("ok: a report to the chat, however it enters (input, steered, batch write, unanswered at a stop), stays a pi.user entry whose submission keeps its report: id; the provider gets only valid roles; the log, zoom, the view and the compactor read it as work; the transcript shows it as the thread's; a reopen keeps it, for a report after the stored view too");

// 4. A reader that does not know work reads the same store.
{
  const old = await readStorage(path.join(directory, "pi.sqlite"), async storage => (await entries(storage, conversationId)).flatMap(entry => entryMessages(entry, CAP)));
  chat = await open();
  try {
    const now = chat.memory.messages;
    assert.equal(old!.length, now.length, "as many messages: every id the same");
    assert.deepEqual(old!.map(message => message.text), now.map(message => message.text), "with the same text: no report lost");
    assert.deepEqual(old!.flatMap((message, id) => message.kind !== now[id]!.kind ? [[message.kind, now[id]!.kind]] : []), Array.from({ length: 5 }, () => ["user", "work"]), "only the five reports differ, user to work");
    assert.equal(chat.memory.render(), view, "a reopen restores the view");
  } finally { await chat.close(); fs.rmSync(root, { recursive: true, force: true }); }
  console.log("ok: a reader that does not know work reads the same store as as many messages with the same text, the reports as user: no report lost, no id moved, and the chat reopens with its view");
}

// 5. Work changes only the kind.
{
  const at = (text: string) => ({ id: 1, conversationId: 1, kind: "pi.user", model: [{ role: "user", content: text, timestamp: 1 }] }) as unknown as EntryRecord;
  const long = `[abcdef12] ${"x".repeat(50)}\n${"y".repeat(50)}`;
  assert.deepEqual(entryMessages(at(REPORTS[0]!)).map(message => message.kind), ["user"], "a user entry is user unless a report placed it");
  assert.deepEqual(entryMessages(at(REPORTS[0]!), 0, true).map(message => message.kind), ["work"]);
  const pages = (work: boolean) => entryMessages(at(long), 40, work).map(message => message.text);
  assert.deepEqual(pages(true), pages(false), "a report pages like a user message");
  assert.ok(pages(true).length > 1);
  console.log("ok: entryMessages: work changes only the kind, pages included");
}
process.exit(0);
