/** A report to OptChat is work, not the user's words: offline and disposable,
 * over the real chat and Pi store with a faux model.
 *
 *   1. Every way a report enters the log (a turn's input, steered into a
 *      tool round, written into a batch, written unanswered at a stop) is
 *      an `optchat.work` entry whose model message keeps the user role; the
 *      user's own messages stay `pi.user`. The provider only ever gets
 *      user, assistant and tool result messages.
 *   2. The log, zoom, the view and the compactor's input read reports as
 *      `work:` and the user's messages as `user:`; a reopen keeps them so.
 *   3. The transcript still shows a report as the thread's message.
 *   4. A report logged before (a `pi.user` entry) stays user and gives as
 *      many messages, so no id moves. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import type { Cursor, EntryRecord, Page } from "@earendil-works/pi-durable";
import { entryMessages, OptChat, OptChatEvents, type OptThreads } from "../src/optchat.ts";
import { WORK_ENTRY } from "../src/optchat-memory.ts";
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
faux.setResponses(Array.from({ length: 200 }, () => async (request: { messages: Message[] }) => {
  for (const message of request.messages) roles.add(message.role);
  const system = request.messages.find(message => message.role === "system");
  if (system && blocks(system).join("").includes("You write the memory of OptChat")) {
    await compactorGate;
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
const open = () => OptChat.open({ directory, models, model: async () => model, threads, limits: { node: 64, retryMs: 50, watchMs: 50 } });
async function until(check: () => boolean, what: string) {
  for (let k = 0; k < 400 && !check(); k++) await delay(10);
  assert.ok(check(), what);
}
const idle = async (chat: OptChat) => {
  await until(() => script.length === 0, "the scripted replies were used");
  await chat.agent.conversation.waitForIdle(context);
};
async function entries(chat: OptChat): Promise<EntryRecord[]> {
  const out: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page: Page<EntryRecord, Cursor> = await chat.agent.storage.scanEntries({ conversationId: chat.agent.conversation.id }, 256, cursor, context);
    out.push(...page.items);
    cursor = page.next;
  } while (cursor);
  return out;
}
const lastUser = (messages: Message[]) => blocks(messages.findLast(message => message.role === "user")!).at(-1);
const report = (run: string) => `report:${THREAD}:${run}`;
const LONG = `[abcdef12] done: PR #9 merged, tests pass ${"and more detail ".repeat(8)}`;
const REPORTS = ["[abcdef12] done: PR #7", "[abcdef12] steered in", LONG, "[abcdef12] waited, then stopped"];
const USERS = ["start a thread", "list projects", "prepare", "after the report", "prompt"];

let chat = await open();
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

  // 1. The entries: reports are work entries with a user message.
  const users = (await entries(chat)).filter(entry => entry.model?.[0]?.role === "user");
  const kindOf = (text: string) => users.filter(entry => blocks(entry.model![0]!).join("") === text).map(entry => entry.kind);
  for (const text of REPORTS) assert.deepEqual(kindOf(text), [WORK_ENTRY], `${text.slice(0, 30)}: one ${WORK_ENTRY} entry`);
  for (const text of USERS) assert.deepEqual(kindOf(text), ["pi.user"], `${text}: one pi.user entry`);
  assert.deepEqual([...roles].sort(), ["assistant", "system", "toolResult", "user"], "the provider got only valid roles");

  // 2. The log, zoom, the view and the compactor read reports as work.
  await until(() => chat.memory.settled() && chat.memory.ready(new Set(), 8).length === 0, "the tree is complete");
  const logged = chat.memory.messages.flatMap((message, id) => message.kind === "user" || message.kind === "work" ? [{ id, ...message }] : []);
  assert.deepEqual(logged.map(message => [message.kind, message.text]), [
    ["user", USERS[0]], ["work", REPORTS[0]], ["user", USERS[1]], ["work", REPORTS[1]], ["user", USERS[2]], ["work", LONG], ["user", USERS[3]],
    ["user", USERS[4]], ["work", REPORTS[3]],
  ], "each message has its kind, in order");
  const first = logged.find(message => message.text === REPORTS[0])!;
  assert.equal(chat.memory.zoom(first.id, 1), `${first.id}+0|work: ${REPORTS[0]}`, "zoom shows the report as work");
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
} finally { await chat.close(); }

// A reopen reads the same kinds from the store and restores the same view.
chat = await open();
try {
  assert.equal(chat.memory.render(), view, "a reopen restores the view");
  assert.deepEqual(chat.memory.messages.filter(message => message.kind === "user" || message.kind === "work").map(message => [message.kind, message.text]), [
    ["user", USERS[0]], ["work", REPORTS[0]], ["user", USERS[1]], ["work", REPORTS[1]], ["user", USERS[2]], ["work", LONG], ["user", USERS[3]],
    ["user", USERS[4]], ["work", REPORTS[3]],
  ], "and reads each message's kind from the store");
} finally { await chat.close(); fs.rmSync(root, { recursive: true, force: true }); }
console.log("ok: a report to the chat, however it enters (input, steered, batch write, unanswered at a stop), is an optchat.work entry with a user-role message: the provider gets only valid roles, the log, zoom, the view and the compactor read it as work, the transcript shows it as the thread's, and a reopen keeps it");

// 4. A report logged before stays user, with as many messages.
{
  const at = (kind: string, text: string) => ({ id: 1, conversationId: 1, kind, model: [{ role: "user", content: text, timestamp: 1 }] }) as unknown as EntryRecord;
  const long = `[abcdef12] ${"x".repeat(50)}\n${"y".repeat(50)}`;
  assert.deepEqual(entryMessages(at("pi.user", REPORTS[0]!)).map(message => message.kind), ["user"], "an old report entry is still logged as user");
  assert.deepEqual(entryMessages(at(WORK_ENTRY, REPORTS[0]!)).map(message => message.kind), ["work"]);
  const pages = (kind: string) => entryMessages(at(kind, long), 40).map(message => message.text);
  assert.deepEqual(pages(WORK_ENTRY), pages("pi.user"), "a work entry pages like a user one: no id moves");
  assert.ok(pages(WORK_ENTRY).length > 1);
  console.log("ok: a report logged before is a pi.user entry and stays user; a work entry gives the same messages and pages, so the log's ids and shape do not change");
}
process.exit(0);
