/** OptChat over Pi with a faux model and fake threads: each turn is a fresh
 * context holding the view and the new message; the compactor builds the
 * tree in the background and the next turn waits for it; spawn starts
 * threads, their reports arrive as "[id] " messages and start a turn; zoom
 * opens the log; a reopen folds the same view from storage. Offline and
 * disposable. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, registerSessionResourceCleanup, type Message } from "@earendil-works/pi-ai";
import { OptChat, OptChatEvents, TELLS, type OptThreads } from "../src/optchat.ts";
import { COMPACT, SCALE } from "../src/optchat-compactor.ts";
import { PiThreadEvents } from "../src/pi-thread-events.ts";
import type { ThreadEvents, ThreadTranscript } from "../src/thread-events.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-"));
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
const userBlocks = (message: Message) => typeof message.content === "string" ? [message.content]
  : message.content.map(part => part.type === "text" ? part.text : "");

type Turn = { system: string; messages: Message[]; tools: string[] };
const turns: Turn[] = [];
const compactions: string[] = [];
const compactorSystems = new Set<string>();
type Reply = ReturnType<typeof fauxAssistantMessage>;
let script: Array<(turn: Turn) => Reply | Promise<Reply>> = [];
// Closed: the compactor waits, so the next turn waits for it.
let compactorGate: Promise<void> = Promise.resolve();
let projectsGate: Promise<void> = Promise.resolve();
let inProjects = false;
const gate = () => { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; };
const faux = fauxProvider({ tokensPerSecond: 100_000 });
const cacheKeys = new Set<string>();
const released: string[] = [];
registerSessionResourceCleanup(sessionId => { if (sessionId) released.push(sessionId); });
faux.setResponses(Array.from({ length: 200 }, () => async (request, options) => {
  const system = request.messages.find(message => message.role === "system");
  assert.equal(options?.cacheRetention, "short", "short cache entries only");
  cacheKeys.add(String(options?.sessionId));
  if (system && textOf(system).includes("You write the memory of OptChat")) {
    await compactorGate;
    const step = userBlocks(request.messages.find(message => message.role === "user")!).at(-1)!;
    compactions.push(step);
    compactorSystems.add(textOf(system));
    assert.ok(!/\d+\+\d+\|/.test(userBlocks(request.messages[1]!)[0]!), "no ids in the compactor's context");
    // Too long once, so the size feedback is exercised.
    if (request.messages.length === 2 && compactions.length === 1) return fauxAssistantMessage("w".repeat(600));
    return fauxAssistantMessage(`summary ${compactions.length}`);
  }
  const turn: Turn = {
    system: JSON.stringify(system),
    messages: request.messages.filter(message => message.role !== "system"),
    tools: ((system as { toolsAdded?: Array<{ name: string }> } | undefined)?.toolsAdded ?? []).map(tool => tool.name),
  };
  turns.push(turn);
  const next = script.shift();
  assert.ok(next, "a scripted reply exists");
  return next(turn);
}));
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, id: faux.getModel().id };

// Fake threads: spawn records the task; a test emits a thread's transcript.
const spawned: Array<{ task: string; requestId: string }> = [];
const listeners = new Map<string, (transcript: ThreadTranscript) => void | Promise<void>>();
const told: string[] = [];
const THREAD = "abcdef12-0000-4000-8000-000000000001";
const threads: OptThreads = {
  async projects() { inProjects = true; await projectsGate; inProjects = false; return "projects:\ncube (id p1; ready): https://github.com/cubeyard/cube.git@main"; },
  async runners() { return "runners as cubed last heard from them:\n- node-a (id r1)"; },
  async spawn(task, requestId) { spawned.push({ task: task.task, requestId }); return { id: THREAD, title: task.task.slice(0, 20) }; },
  async tell(id, text) { told.push(`${id}:${text}`); },
  async describe(ids) { return ids.map(id => `[${id.slice(0, 8)}] cube · ready`).join("\n"); },
  async history() { return null; },
  async events(id): Promise<ThreadEvents> {
    return {
      async read() { throw new Error("unused"); },
      async watch(listener) {
        listeners.set(id, listener);
        await listener({ agent: "pi", owner: null, status: { state: "idle", run: null, error: null }, events: [] });
        return { closed: new Promise(() => {}), async stop() { listeners.delete(id); } };
      },
    };
  },
};

const directory = path.join(root, "optchat");
const open = () => OptChat.open({ directory, models, model: async () => model, threads, limits: { node: 64, retryMs: 50, watchMs: 50 } });
async function until(check: () => boolean, what: string) {
  for (let k = 0; k < 400 && !check(); k++) await delay(10);
  assert.ok(check(), what);
}
const idle = async (chat: OptChat) => {
  await until(() => script.length === 0, "the scripted replies were used");
  await chat.agent.conversation.waitForIdle(BACKGROUND_CONTEXT);
};

let chat = await open();
let viewBeforeClose: string;
try {
  // Turn 1: the view is empty, the message comes whole; OptChat spawns a thread.
  script = [
    turn => {
      assert.deepEqual(turn.tools.sort(), ["archive", "date", "history", "projects", "runners", "spawn", "tell", "threads", "usage", "zoom"], "no code tools");
      assert.match(turn.system, /You are OptChat/);
      assert.equal(turn.messages.length, 1, "a fresh context: the view and the message only");
      assert.deepEqual(userBlocks(turn.messages[0]!), ["<chat>\n</chat>", `please fix the gateway; ${"long detail ".repeat(20)}`]);
      return fauxAssistantMessage([{ type: "text", text: "starting a thread" },
        fauxToolCall("spawn", { tasks: [{ project: "cube", task: "fix the gateway Host check" }] }, { id: "call-spawn" })], { stopReason: "toolUse" });
    },
    turn => {
      assert.match(textOf(turn.messages.at(-1)!), /\[abcdef12\] started in cube/);
      return fauxAssistantMessage("a thread is fixing the gateway; I will tell you when it reports");
    },
  ];
  await chat.send(`please fix the gateway; ${"long detail ".repeat(20)}`, "r1");
  await idle(chat);
  assert.deepEqual(spawned, [{ task: "fix the gateway Host check", requestId: "optchat:call-spawn:0" }]);
  await until(() => listeners.has(THREAD), "the spawned thread is watched");

  // The thread reports: a new turn starts on its own, with the summarized view.
  script = [
    turn => {
      assert.equal(turn.messages.length, 1, "the report starts a fresh turn");
      const [view, report] = userBlocks(turn.messages[0]!);
      assert.equal(report, "[abcdef12] ended its turn; nothing of it runs now: done: PR #212, tests pass");
      assert.match(view!, /^<chat>\n0\+1\|summary \d+\n/, "the long first message is summarized, not shown");
      assert.ok(!view!.includes("long detail long detail"), "no message appears in full");
      assert.ok(!view!.includes("not summarized yet"), "a turn waits for the compactor");
      assert.match(view!, /\|talk: starting a thread\n/, "a short message is its own line");
      return fauxAssistantMessage([fauxToolCall("zoom", { id: 0, n: 1 }, { id: "call-zoom" })], { stopReason: "toolUse" });
    },
    turn => {
      assert.match(textOf(turn.messages.at(-1)!), /^0\+0\|user: please fix the gateway; long detail/, "zoom gives the message whole");
      return fauxAssistantMessage([fauxToolCall("tell", { id: "abcdef12", message: "also add a test" }, { id: "call-tell" })], { stopReason: "toolUse" });
    },
    () => fauxAssistantMessage("the gateway fix landed in PR #212; I asked for a test too"),
  ];
  await listeners.get(THREAD)!({ agent: "pi", owner: null, status: { state: "completed", run: "run-1", error: null }, events: [
    { type: "user-message", id: "1", text: "fix it" },
    { type: "assistant-text", id: "2", text: "done: PR #212, tests pass", reasoning: false, final: true },
  ] });
  await idle(chat);
  assert.deepEqual(told, [`${THREAD}:also add a test`]);
  // The report is shown as the thread's, the user's own messages as theirs.
  const shown = (await new OptChatEvents(chat, new PiThreadEvents({ agent: chat.agent, owner: () => null, failure: () => null })).read()).events
    .filter(event => event.type === "user-message");
  assert.equal(shown.find(event => event.text.startsWith("[abcdef12] ended"))?.from, "abcdef12", "a report is marked as its thread's");
  assert.ok(shown.filter(event => !event.text.startsWith("[")).every(event => event.from === undefined), "the user's messages are theirs");
  // SCALE beside the step was merged into real lines; it lives in the system
  // prompt, marked as an invented example, and never in a step.
  assert.deepEqual([...compactorSystems], [COMPACT], "one constant compactor system prompt");
  assert.ok(COMPACT.includes(`<example>\n${SCALE}\n</example>`), "the scale line is an invented example in the system prompt");
  assert.ok(compactions.every(step => !step.includes(SCALE) && !step.includes("For scale")), "no step carries the scale line");
  assert.ok(compactions.every(step => /^(Compress this message|Merge these two lines) into one( line)?\. Your line covers (this message|these two lines) only\. Write three versions of it, of about \d+, \d+ and \d+ words/.test(step)), "a step says its line covers its input only");
  assert.ok(compactions.length >= 2, "the oversized line was retried");
  const [chatKey, ...others] = [...cacheKeys].sort();
  assert.match(chatKey!, /^optchat-[0-9a-f-]{36}$/, "the chat has its own cache key");
  assert.deepEqual(others, [`${chatKey}-compact`], "the compactor shares one of its own");

  // The same report again (a watch reconnect) is delivered once.
  await listeners.get(THREAD)!({ agent: "pi", owner: null, status: { state: "completed", run: "run-1", error: null }, events: [] });
  await chat.send("[abcdef12] done: PR #212, tests pass", `report:${THREAD}:run-1`);
  assert.equal(turns.length, 5, "a known request id starts no turn");

  // "go on": a report that arrives while the model writes its final reply
  // waits for the run to end and starts its own fresh turn; it never
  // continues the run.
  script = [
    async () => {
      await listeners.get(THREAD)!({ agent: "pi", owner: null, status: { state: "completed", run: "run-2", error: null }, events: [
        { type: "user-message", id: "3", text: "also add a test" }, { type: "assistant-text", id: "4", text: "second report", reasoning: false, final: true },
      ] });
      await delay(100);
      return fauxAssistantMessage("I asked the thread for a test.");
    },
    turn => {
      assert.equal(turn.messages.length, 1, "the report starts a fresh turn, not a continuation");
      assert.equal(userBlocks(turn.messages[0]!).at(-1), "[abcdef12] ended its turn; nothing of it runs now: second report");
      return fauxAssistantMessage([fauxToolCall("projects", {}, { id: "call-projects" })], { stopReason: "toolUse" });
    },
    // A message sent during a tool round reaches the model between tool calls.
    turn => {
      const after = turn.messages.slice(turn.messages.findIndex(message => message.role === "toolResult"));
      const steered = after.filter(message => message.role === "user").map(textOf);
      assert.deepEqual(steered, ["also note the branch", "and the tag"], "both steered in after the tool result, in order");
      return fauxAssistantMessage("noted the branch");
    },
  ];
  const projectsCall = gate();
  projectsGate = projectsCall.promise;
  await chat.send("go on", "r-go");
  await until(() => inProjects, "the projects tool runs");
  await chat.send("also note the branch", "r-steer");
  await chat.send("and the tag", "r-steer-2");
  await until(() => script.length === 1, "the steer is placed");
  await delay(100);
  projectsCall.open();
  await idle(chat);
  // Once Pi has placed the steered messages, nothing waits and the chat is idle.
  await delay(200);
  assert.deepEqual(await chat.pending(), [], "steered messages are forgotten once placed");
  const steeredTurn = await new OptChatEvents(chat, new PiThreadEvents({ agent: chat.agent, owner: () => null, failure: () => null })).read();
  assert.equal(steeredTurn.status.state, "completed", "a steered turn ends idle, not working");

  // Messages that wait for the compactor go into one turn together.
  const compacting = gate();
  compactorGate = compacting.promise;
  script = [
    () => fauxAssistantMessage(`a long enough reply to need the compactor ${"z".repeat(40)}`),
    turn => {
      assert.equal(turn.messages.length, 2, "everything waiting starts one turn");
      assert.equal(userBlocks(turn.messages[0]!).at(-1), "first", "the view leads the first message");
      assert.ok(userBlocks(turn.messages[0]!)[0]!.startsWith("<chat>"));
      assert.deepEqual(userBlocks(turn.messages[1]!), ["second"], "each message stays its own");
      return fauxAssistantMessage("both done");
    },
  ];
  await chat.send("prepare", "r-prepare");
  await until(() => script.length === 1, "the long reply is written");
  await delay(100);
  await chat.send("first", "r-first");
  await chat.send("second", "r-second");
  await delay(150);
  const waiting = await new OptChatEvents(chat, new PiThreadEvents({ agent: chat.agent, owner: () => null, failure: () => null })).read();
  assert.equal(waiting.status.state, "working", "a waiting message shows as working");
  assert.ok(waiting.events.some(event => event.type === "user-message" && event.text === "second"), "and is shown");
  compacting.open();
  compactorGate = Promise.resolve();
  await idle(chat);

  // A stop while a message waits keeps it in the log, unanswered.
  const stalled = gate();
  compactorGate = stalled.promise;
  script = [() => fauxAssistantMessage(`another long reply to need the compactor ${"q".repeat(40)}`)];
  await chat.send("prompt", "r-prompt");
  await idle(chat);
  const count = turns.length;
  await chat.send("waiting one", "r-wait");
  await delay(100);
  await chat.stop();
  stalled.open();
  compactorGate = Promise.resolve();
  await delay(200);
  assert.equal(turns.length, count, "a stopped wait starts no turn");
  assert.deepEqual(await chat.pending(), []);
  await until(() => chat.memory.settled() && chat.memory.ready(new Set(), 8).length === 0, "the tree is complete");
  await delay(100);
  viewBeforeClose = chat.memory.render();
} finally { await chat.close(); }
// Close releases the provider sessions of both cache keys (Codex keeps a
// WebSocket per key open for minutes, which held cubed's exit).
const [chatKey] = [...cacheKeys].sort();
assert.deepEqual(released.filter(key => key.startsWith("optchat-")).sort(), [chatKey, `${chatKey}-compact`], "close releases the chat's and the compactor's sessions");

// A reopen goes on from the same view and sees the same history.
const before = turns.at(-1)!;
const reopened = await open();
chat = reopened;
try {
  assert.equal(chat.memory.render(), viewBeforeClose, "a reopen restores the view it had");
  script = [turn => {
    const [view, message] = userBlocks(turn.messages[0]!);
    assert.equal(message, "what happened?");
    assert.match(view!, /\|work: |\|summary|\|user: \[abcdef12\]/, "the report is in the view");
    assert.ok(view!.split("\n").length > 5);
    return fauxAssistantMessage("PR #212 fixed the gateway");
  }];
  await chat.send("what happened?", "r2");
  await idle(chat);
  assert.notEqual(turns.at(-1), before);
  const history = await new (await import("../src/pi-thread-events.ts")).PiThreadEvents({ agent: chat.agent, owner: () => null, failure: () => null }).read();
  const users = history.events.filter(event => event.type === "user-message").map(event => event.type === "user-message" ? event.text : "");
  assert.deepEqual(users.map(text => text.slice(0, 20)), ["please fix the gatew", "[abcdef12] ended its turn; nothing of it runs now: done", "go on", "[abcdef12] ended its turn; nothing of it runs now: second", "also note the branch", "and the tag", "prepare", "first", "second", "prompt", "waiting one", "what happened?"].map(text => text.slice(0, 20)), "the transcript keeps every turn");

  // Tells to a thread are bounded between two messages of the user (reports
  // do not count as the user's); the user's next message renews them.
  const toldBefore = told.length;
  script = [
    () => fauxAssistantMessage(Array.from({ length: TELLS + 1 }, (_, k) => fauxToolCall("tell", { id: "abcdef12", message: `go on ${k}` }, { id: `call-budget-${k}` })), { stopReason: "toolUse" }),
    turn => {
      const results = turn.messages.filter(message => message.role === "toolResult").map(textOf);
      assert.equal(results.length, TELLS + 1);
      assert.match(results.at(-1)!, new RegExp(`^not sent: \\[abcdef12\\] had ${TELLS} tells from you since the user's last message`));
      return fauxAssistantMessage("it needs you now");
    },
    () => fauxAssistantMessage([fauxToolCall("tell", { id: "abcdef12", message: "one more" }, { id: "call-budget-after" })], { stopReason: "toolUse" }),
    () => fauxAssistantMessage("sent"),
  ];
  await chat.send("keep it going overnight", "r-budget");
  await until(() => script.length === 2, "the bounded tells ran");
  await chat.agent.conversation.waitForIdle(BACKGROUND_CONTEXT);
  assert.equal(told.length - toldBefore, TELLS, "the tell over the budget was not sent");
  await chat.send("[abcdef12] a report is not the user", `report:${THREAD}:run-budget`);
  await until(() => script.length === 0, "the report's turn and the user's turn ran");
  await chat.agent.conversation.waitForIdle(BACKGROUND_CONTEXT);
  assert.equal(told.length - toldBefore, TELLS, "a report does not renew the budget");
  script = [
    () => fauxAssistantMessage([fauxToolCall("tell", { id: "abcdef12", message: "one more" }, { id: "call-budget-after-2" })], { stopReason: "toolUse" }),
    () => fauxAssistantMessage("sent"),
  ];
  await chat.send("yes, one more", "r-budget-2");
  await idle(chat);
  assert.equal(told.at(-1), `${THREAD}:one more`, "the user's message renews the budget");
} finally { await chat.close(); fs.rmSync(root, { recursive: true, force: true }); }

console.log("optchat: ok");
