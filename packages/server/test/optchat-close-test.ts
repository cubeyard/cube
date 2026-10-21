/** OptChat's close, offline with a faux model: a close starts no new turn,
 * node, chat request, tool or further summary answer, waits for the model
 * calls and tool calls already out (summaries being built, a chat request
 * sent, a tool running) and stores their answers, results and usage, so the
 * reopened chat sends and runs none of them again; a summary round held
 * before its next answer goes on after the reopen as it would have. Only
 * what is still out after the close's grace is cut off: counted as unknown;
 * a model call is not sent again until a message of the user (pi-sends.ts),
 * a tool runs again at most once, keyed; the close is bounded whatever a
 * tool does. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { OptChat, type OptThreads } from "../src/optchat.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-close-"));
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : part.type === "toolCall" ? `${part.name}()` : "").join("");

/** How a call's answer comes: at once, after ms, only once aborted, or
 * never (a provider that ignores the abort). */
type Hold = number | "abort" | "never";
let hold: { turn: Hold; compaction: Hold; marked?: number } = { turn: 0, compaction: 0 };
/** A message marked so: its summary's first answer is not three versions,
 * so the round asks again with feedback. Each answer asked for it, in order:
 * whether the first or a follow-up, and its messages as sent. */
const MARK = "FEEDBACK-ME";
const markedCalls: Array<{ follow: boolean; messages: string; phase: string }> = [];
/** Follow-ups of a marked summary to fail, as an overloaded provider does. */
let failFollow = 0;
const wire = (messages: readonly Message[]) => JSON.stringify(messages.map(message => [message.role, message.content]));
type Sent = { kind: "turn" | "compaction"; key: string };
const sent: Sent[] = [];
const open = { turn: 0, compaction: 0 };
const aborted = { turn: 0, compaction: 0 };
let n = 0;
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 4_000 }, () => async (request, options) => {
  const kind = request.messages.some(message => message.role === "system" && textOf(message).includes("You write the memory of OptChat")) ? "compaction" : "turn";
  // A call is the same call when it carries the same messages.
  sent.push({ kind, key: crypto.createHash("sha256").update(JSON.stringify(request.messages.map(message => [message.role, textOf(message)]))).digest("hex") });
  // The step is the first user message's last block; its context comes before it.
  const step = request.messages.find(message => message.role === "user")?.content;
  const marked = kind === "compaction" && Array.isArray(step) && step.at(-1)?.type === "text" && (step.at(-1) as { text: string }).text.includes(MARK);
  const follow = request.messages.length > 2;
  if (marked) markedCalls.push({ follow, messages: wire(request.messages), phase });
  open[kind]++;
  try {
    const wait = marked && !follow && hold.marked !== undefined ? hold.marked : hold[kind], signal = options?.signal;
    if (wait === "never") await new Promise(() => {});
    if (wait === "abort") await new Promise(resolve => { if (signal?.aborted) resolve(null); signal?.addEventListener("abort", resolve, { once: true }); });
    else if (typeof wait === "number" && wait) await delay(wait, null, { signal }).catch(() => {});
    if (signal?.aborted) aborted[kind]++;
  } finally { open[kind]--; }
  if (marked && follow && failFollow > 0) { failFollow--; return fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded" }); }
  if (marked) return fauxAssistantMessage(follow ? "marked a\nmarked ab\nmarked abc" : "one\ntwo\nthree\nfour");
  if (kind === "compaction") return fauxAssistantMessage(`summary ${++n} ${"s".repeat(20)}`);
  const user = request.messages.findLast(message => message.role === "user");
  const called = request.messages.some(message => message.role === "toolResult");
  if (user && textOf(user).includes("#spawn") && !called) {
    return fauxAssistantMessage([fauxToolCall("spawn", { tasks: [1, 2, 3].map(k => ({ project: "cube", task: `task ${k}` })) })], { stopReason: "toolUse" });
  }
  const tool = !!user && textOf(user).includes("#tool") && !called;
  return tool ? fauxAssistantMessage([fauxToolCall("projects", {})], { stopReason: "toolUse" }) : fauxAssistantMessage(`reply ${++n} ${"r".repeat(80)}`);
}));
const models = createModels();
models.setProvider(faux.provider);
/** The `projects` tool's runs, by when they started, and how long one
 * takes (-1: it never ends, and ignores the abort). */
let phase: "open" | "closing" | "reopened" = "open";
const runs = { open: 0, closing: 0, reopened: 0 };
let toolMs = 0;
/** `spawn`'s tasks as the threads see them: each asked request id, and the
 * threads made, by request id (a request id makes one thread, as the
 * registry's creation table does). Each task takes spawnMs, as its git
 * fetch, and stops on the abort, as git does. */
let spawnMs = 0;
const spawned = { asked: [] as string[], made: new Map<string, string>() };
const threads: OptThreads = {
  async projects() { runs[phase]++; if (toolMs < 0) await new Promise(() => {}); if (toolMs) await delay(toolMs); return "projects: cube"; }, async runners() { return "no runners"; },
  async spawn(task, requestId, signal) {
    spawned.asked.push(requestId);
    const made = spawned.made.get(requestId);
    if (made) return { id: made, title: task.task };
    if (spawnMs) await delay(spawnMs, null, { signal });
    signal?.throwIfAborted();
    const id = crypto.randomUUID();
    spawned.made.set(requestId, id);
    return { id, title: task.task };
  },
  async tell() {}, async describe() { return ""; },
  async events() { return null; }, async history() { return null; },
};
const chatAt = (directory: string, closeMs: number, compactor?: () => Promise<null>) => OptChat.open({ directory, models, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }),
  threads, ...compactor ? { compactor } : {}, limits: { view: 1_600, low: 800, compaction: 400, compactionLow: 200, node: 64, retryMs: 50, watchMs: 50, closeMs } });
async function until(check: () => boolean, what: string) {
  for (let k = 0; k < 1500 && !check(); k++) await delay(10);
  assert.ok(check(), what);
}
const quiet = async (chat: OptChat) => {
  await chat.agent.conversation.waitForIdle(BACKGROUND_CONTEXT);
  const busy = (chat as unknown as { busy: ReadonlySet<string> }).busy;
  await until(() => chat.memory.settled() && chat.memory.ready(new Set(), 8).length === 0 && busy.size === 0, "the tree is complete and stored");
};
/** Calls sent more than once since `from`, of `kind`. */
const twice = (kind: Sent["kind"], from = 0) => {
  const keys = sent.slice(from).filter(call => call.kind === kind).map(call => call.key);
  return keys.length - new Set(keys).size;
};
const sum = (calls: Record<string, number> | undefined) => Object.values(calls ?? {}).reduce((total, count) => total + count, 0);
const reset = () => { failFollow = 0; markedCalls.length = 0; spawned.asked.length = 0; spawned.made.clear(); spawnMs = 0; phase = "open"; Object.assign(runs, { open: 0, closing: 0, reopened: 0 }); sent.length = 0; Object.assign(open, { turn: 0, compaction: 0 }); Object.assign(aborted, { turn: 0, compaction: 0 }); };

// 1. Summaries out at a close come back within its grace and are stored,
// with their usage; the reopened chat asks for none of them again.
{
  reset();
  const directory = path.join(root, "drain");
  let chat = await chatAt(directory, 5_000);
  try {
    await chat.send(`message 0: ${"word ".repeat(30)}`, "r0");
    await quiet(chat);
    hold = { turn: 0, compaction: 300 };
    await chat.send(`message 1: ${"word ".repeat(30)}`, "r1");
    await until(() => open.compaction > 0, "a summary is out");
    const started = Date.now();
    await chat.close();
    const took = Date.now() - started;
    assert.equal(open.compaction, 0, "the close waited for every summary out");
    assert.equal(aborted.compaction, 0, "and cut none off");
    assert.ok(took < 5_000, `within its grace (${took} ms)`);
    hold = { turn: 0, compaction: 0 };
    const before = sent.filter(call => call.kind === "compaction").length;
    chat = await chatAt(directory, 5_000);
    await quiet(chat);
    assert.equal(twice("compaction"), 0, "no summary was asked for twice");
    const usage = await chat.usage();
    assert.equal(sum(usage.compactor.calls), sent.filter(call => call.kind === "compaction").length, "every compactor call's usage is stored, those that came back during the close too");
    assert.ok(before > 0 && sum(usage.compactor.calls) >= before);
    assert.equal(sum(usage.cut?.compactor) + sum(usage.cut?.chat), 0, "nothing is counted as cut off");
  } finally { await chat.close(); }
}

// 2. A chat request out at a close comes back and is stored; the tool it
// calls is not started, nor the run's next request sent, until the reopen,
// and then each once. With a quick tool and a slow one.
for (const ms of [0, 200]) {
  reset();
  toolMs = ms;
  const directory = path.join(root, `turn-${ms}`);
  let chat = await chatAt(directory, 5_000);
  try {
    hold = { turn: 300, compaction: 0 };
    await chat.send(`message 0: ${"word ".repeat(30)} #tool`, "r0");
    await until(() => open.turn > 0, "the turn's first request is out");
    phase = "closing";
    await chat.close();
    assert.equal(open.turn, 0, "the close waited for the chat's request");
    assert.equal(aborted.turn, 0, "and did not cut it off");
    assert.equal(runs.closing, 0, `the tool it called was not started while closing (${ms} ms tool)`);
    assert.equal(sent.filter(call => call.kind === "turn").length, 1, "the step after it was not sent while closing");
    hold = { turn: 0, compaction: 0 };
    phase = "reopened";
    chat = await chatAt(directory, 5_000);
    await quiet(chat);
    assert.equal(runs.reopened, 1, "the reopened run started the tool, once");
    assert.equal(runs.open + runs.closing + runs.reopened, 1, "and it ran once in all");
    assert.equal(sent.filter(call => call.kind === "turn").length, 2, "the reopened run sent its next step");
    assert.equal(twice("turn"), 0, "and no step twice");
    assert.equal(twice("compaction"), 0, "nor any summary");
    const usage = await chat.usage();
    assert.equal(sum(usage.cut?.chat), 0, "nothing is counted as cut off");
  } finally { await chat.close(); toolMs = 0; }
}

// 2b. A tool already running when the close begins and ending within its
// grace is waited for: its result is stored and the reopened run does not
// run it again.
{
  reset();
  toolMs = 300;
  const directory = path.join(root, "tool-running");
  let chat = await chatAt(directory, 5_000);
  try {
    await chat.send(`message 0: ${"word ".repeat(30)} #tool`, "r0");
    await until(() => runs.open > 0, "the tool is running");
    phase = "closing";
    const started = Date.now();
    await chat.close();
    const took = Date.now() - started;
    assert.equal(runs.closing, 0, "no tool started while closing");
    assert.ok(took >= 200 && took < 5_000, `the close waited for the running tool, within its grace (${took} ms)`);
    phase = "reopened";
    toolMs = 0;
    chat = await chatAt(directory, 5_000);
    await quiet(chat);
    assert.equal(runs.open, 1);
    assert.equal(runs.reopened, 0, "the reopened run did not run it again: its result was stored");
    assert.equal(twice("turn"), 0, "no request sent twice");
    const usage = await chat.usage();
    assert.equal(sum(usage.cut?.tools) + sum(usage.cut?.chat), 0, "nothing is counted as cut off");
  } finally { await chat.close(); toolMs = 0; }
}

// 2c. Forced: a tool still running after the grace is cut off. It is
// counted as cut off by name, and the reopened run executes it again, once.
{
  reset();
  toolMs = 1_000;
  const directory = path.join(root, "tool-forced");
  let chat = await chatAt(directory, 150);
  try {
    await chat.send(`message 0: ${"word ".repeat(30)} #tool`, "r0");
    await until(() => runs.open > 0, "the tool is running");
    phase = "closing";
    const started = Date.now();
    await chat.close();
    const took = Date.now() - started;
    assert.ok(took < 1_000, `the close did not wait for the tool past its grace (${took} ms)`);
    phase = "reopened";
    toolMs = 0;
    chat = await chatAt(directory, 5_000);
    await quiet(chat);
    assert.equal(runs.open + runs.closing + runs.reopened, 2, "the tool cut off ran again, once");
    const usage = await chat.usage();
    assert.deepEqual(usage.cut?.tools, { projects: 1 }, "and is counted as cut off, by name");
    assert.equal(twice("turn"), 0);
  } finally { await chat.close(); toolMs = 0; }
}

// 2d. A tool that never ends and ignores the abort does not hold the close:
// it ends within the grace, the settle and Pi's join bound (CLOSE_SETTLE_MS
// and CLOSE_JOIN_MS, 2 s each).
{
  reset();
  toolMs = -1;
  const directory = path.join(root, "tool-stuck");
  let chat = await chatAt(directory, 150);
  try {
    await chat.send(`message 0: ${"word ".repeat(30)} #tool`, "r0");
    await until(() => runs.open > 0, "the tool is running");
    const started = Date.now();
    await chat.close();
    const took = Date.now() - started;
    assert.ok(took < 150 + 2_000 + 2_000 + 500, `the close is bounded (${took} ms)`);
    // The tool's call returned at the cut, so Pi's close joined at once: the
    // join bound (CLOSE_JOIN_MS) is a backstop, not reached.
    assert.ok(took < 150 + 1_000, `Pi's close was not held by the tool (${took} ms)`);
    toolMs = 0;
    chat = await chatAt(directory, 5_000);
    await quiet(chat);
    assert.equal(runs.open + runs.reopened, 2, "the reopened run executed it again, once");
    assert.deepEqual((await chat.usage()).cut?.tools, { projects: 1 });
  } finally { await chat.close(); toolMs = 0; }
}

// 2e. spawn cut off at the close: its task under way stops on the abort (as
// its git fetch does) and no later task is started; the reopened run asks
// again under the same request ids, so every task makes one thread.
{
  reset();
  spawnMs = 400;
  const directory = path.join(root, "spawn-cut");
  let chat = await chatAt(directory, 150);
  try {
    await chat.send(`message 0: ${"word ".repeat(30)} #spawn`, "r0");
    await until(() => spawned.asked.length >= 1, "spawn is under way");
    await chat.close();
    // The call returned at the cut; its work, if it went on, would by now.
    await delay(spawnMs + 300);
    assert.ok(spawned.asked.length <= 1, `no task started after the cut (${spawned.asked.length} asked)`);
    const before = spawned.made.size;
    assert.equal(before, 0, "the task under way made no thread after the abort");
    spawnMs = 0;
    chat = await chatAt(directory, 5_000);
    await quiet(chat);
    assert.equal(spawned.made.size, 3, "after the reopen, each task made one thread");
    assert.equal(new Set(spawned.asked).size, 3, "under three request ids");
    for (const id of spawned.made.values()) assert.ok(await chat.started(id), "and the chat records each thread");
    assert.equal((await chat.threadPrefixes()).size, 3, "once");
    assert.equal((await chat.usage()).cut?.tools?.spawn, 1, "the cut spawn is counted");
  } finally { await chat.close(); }
}

// 2f. A tool that returned but whose result is not stored yet (its slot
// reads running until Pi commits it) is waited for too: the grace ends only
// after that commit, so the result is kept and the tool not run again.
{
  reset();
  toolMs = 100;
  const directory = path.join(root, "tool-settling");
  let chat = await chatAt(directory, 5_000);
  try {
    // Pi's commit of the tool's result waits 600 ms, as a slow disk would.
    const storage = (chat as unknown as { storage: { commit: (writes: unknown, context: unknown) => Promise<unknown> } }).storage;
    const commit = storage.commit.bind(storage);
    let stored = 0;
    storage.commit = async (writes, commitContext) => {
      if (!JSON.stringify(writes).includes("projects: cube")) return commit(writes, commitContext);
      await delay(600);
      const seq = await commit(writes, commitContext);
      stored ||= Date.now();
      return seq;
    };
    let cutAt = 0;
    (chat as unknown as { abort: AbortController }).abort.signal.addEventListener("abort", () => { cutAt = Date.now(); }, { once: true });
    await chat.send(`message 0: ${"word ".repeat(30)} #tool`, "r0");
    await until(() => runs.open > 0, "the tool is running");
    phase = "closing";
    await chat.close();
    assert.ok(stored > 0 && cutAt >= stored, `the grace ended after the result was stored (stored ${stored}, cut ${cutAt})`);
    phase = "reopened";
    toolMs = 0;
    chat = await chatAt(directory, 5_000);
    await quiet(chat);
    assert.equal(runs.open + runs.closing + runs.reopened, 1, "the tool ran once in all");
    const usage = await chat.usage();
    assert.equal(sum(usage.cut?.tools) + sum(usage.cut?.chat), 0, "nothing is counted as cut off");
  } finally { await chat.close(); toolMs = 0; }
}

// 3. Forced: summaries still out after the grace are cut off. The close ends
// soon after its grace and counts each as unknown; the reopen asks none of
// them again (their nodes are held) until a message of the user, which asks
// again for at most those.
{
  reset();
  const directory = path.join(root, "forced-summary");
  let chat = await chatAt(directory, 150);
  try {
    await chat.send(`message 0: ${"word ".repeat(30)}`, "r0");
    await quiet(chat);
    hold = { turn: 0, compaction: "abort" };
    await chat.send(`message 1: ${"word ".repeat(30)}`, "r1");
    await until(() => open.compaction > 0, "a summary is out");
    const at = sent.length;
    const started = Date.now();
    await chat.close();
    const took = Date.now() - started;
    const cut = aborted.compaction;
    assert.ok(cut > 0, "the summaries out were cut off");
    assert.ok(took < 150 + 2_000 + 1_000, `the close ends soon after its grace (${took} ms)`);
    hold = { turn: 0, compaction: 0 };
    chat = await chatAt(directory, 5_000);
    await until(() => /no summary for a message yet \(its summary was out when cubed stopped/.test(chat.failure() ?? ""), "the held nodes say why");
    await delay(300);
    assert.equal(twice("compaction"), 0, "the reopen asked none again on its own (another node may be asked)");
    await chat.send(`message 2: ${"word ".repeat(30)}`, "r2");
    await quiet(chat);
    const again = twice("compaction");
    assert.ok(again <= cut, `the user's message asked again for at most the ${cut} cut off (${again})`);
    assert.ok(sent.slice(0, at).filter(call => call.kind === "compaction").length >= cut);
    const usage = await chat.usage();
    assert.equal(sum(usage.cut?.compactor), cut, "each call cut off is counted as unknown");
    assert.equal(sum(usage.cut?.chat), 0);
  } finally { await chat.close(); }
}

// 4. Forced: a chat request still out after the grace is cut off and
// counted; the reopened run does not send it again (its turn ends
// unanswered, and says why) and the next message is answered.
{
  reset();
  const directory = path.join(root, "forced-turn");
  let chat = await chatAt(directory, 150);
  try {
    hold = { turn: "abort", compaction: 0 };
    await chat.send(`message 0: ${"word ".repeat(30)}`, "r0");
    await until(() => open.turn > 0, "the turn's request is out");
    await chat.close();
    assert.equal(aborted.turn, 1, "the chat's request was cut off");
    hold = { turn: 0, compaction: 0 };
    const before = sent.filter(call => call.kind === "turn").length;
    chat = await chatAt(directory, 5_000);
    await quiet(chat);
    assert.equal(sent.filter(call => call.kind === "turn").length, before, "the reopened run did not send it again");
    assert.match(chat.failure() ?? "", /last request was out when cubed stopped, so it was not sent again/);
    let usage = await chat.usage();
    assert.equal(sum(usage.cut?.chat), 1, "it is counted as unknown, once");
    await chat.close();
    chat = await chatAt(directory, 5_000);
    await quiet(chat);
    usage = await chat.usage();
    assert.equal(sum(usage.cut?.chat), 1, "a second reopen counts it no more");
    await chat.send(`message 1: ${"word ".repeat(30)}`, "r1");
    await until(() => chat.memory.messages.filter(message => message.kind === "talk").length >= 1, "the next message is answered");
    assert.equal(twice("turn"), 0, "no request was sent twice");
  } finally { await chat.close(); }
}

// 5. A summary whose first answer needs feedback, closed while that answer
// is out: the answer comes back in the grace and is stored, the follow-up is
// not sent while closing, and the reopened chat sends it once, as the
// uninterrupted round sends it, and keeps the same summary.
{
  const marked = `message 0: ${MARK} ${"word ".repeat(30)}`;
  /** Until the chat has answered `k` turns, then at rest. */
  const answered = async (chat: OptChat, k: number) => {
    await until(() => chat.memory.messages.filter(message => message.kind === "talk").length >= k, `turn ${k} answered`);
    await quiet(chat);
  };
  const node = (chat: OptChat) => chat.memory.render([{ l: 0, i: chat.memory.messages.findIndex(message => message.text.includes(MARK)) }]);
  // The uninterrupted round.
  reset();
  const reference = await chatAt(path.join(root, "round-reference"), 5_000);
  let expected: { follow: string; node: string };
  try {
    await reference.send(marked, "r0");
    await answered(reference, 1);

    const follow = markedCalls.filter(call => call.follow);
    assert.equal(follow.length, 1);
    expected = { follow: follow[0]!.messages, node: node(reference) };
    assert.match(expected.node, /marked abc/);
  } finally { await reference.close(); }
  reset();
  hold = { turn: 0, compaction: 0, marked: 300 };
  const directory = path.join(root, "round-held");
  let chat = await chatAt(directory, 5_000);
  try {
    await chat.send(marked, "r0");
    await until(() => markedCalls.length === 1 && open.compaction > 0, "the marked summary's first answer is out");
    phase = "closing";
    await chat.close();
    assert.equal(aborted.compaction, 0, "its first answer came back in the grace");
    assert.equal(markedCalls.filter(call => call.follow).length, 0, "no follow-up was sent while closing");
    hold = { turn: 0, compaction: 0 };
    phase = "reopened";
    chat = await chatAt(directory, 5_000);
    await answered(chat, 1);
    assert.equal(markedCalls.filter(call => !call.follow).length, 1, "the first answer was asked once in all");
    const follow = markedCalls.filter(call => call.follow);
    assert.equal(follow.length, 1, "the follow-up was sent once, after the reopen");
    assert.equal(follow[0]!.messages, expected.follow, "byte for byte as the uninterrupted round sends it");
    assert.equal(node(chat), expected.node, "and the summary is the same");
    assert.equal(twice("compaction"), 0, "no summary answer was asked twice");
    const usage = await chat.usage();
    assert.equal(sum(usage.compactor.calls), sent.filter(call => call.kind === "compaction").length, "every answer's usage is stored");
    assert.equal(sum(usage.cut?.compactor), 0, "nothing was cut off");
  } finally { await chat.close(); hold = { turn: 0, compaction: 0 }; }

  // 5b. A held round is taken once: when its resumed answer fails (an
  // overloaded provider), the node's retry starts a new round from its first
  // answer and does not ask the held answer again from the round kept.
  reset();
  hold = { turn: 0, compaction: 0, marked: 300 };
  const failing = path.join(root, "round-taken-once");
  chat = await chatAt(failing, 5_000);
  try {
    await chat.send(marked, "r0");
    await until(() => markedCalls.length === 1 && open.compaction > 0, "the marked summary's first answer is out");
    await chat.close();
    assert.equal(markedCalls.filter(call => call.follow).length, 0, "the round was held before its follow-up");
    hold = { turn: 0, compaction: 0 };
    failFollow = 1;
    chat = await chatAt(failing, 5_000);
    await answered(chat, 1);
    const calls = markedCalls.map(call => call.follow ? "follow" : "first");
    assert.deepEqual(calls, ["first", "follow", "first", "follow"], "the resumed follow-up failed once; the retry asked the first answer again, not the held round");
    assert.equal(node(chat), expected.node, "and the summary is the same");
  } finally { await chat.close(); hold = { turn: 0, compaction: 0 }; failFollow = 0; }
}

// 5c. A node whose round starts while the chat closes is held before its
// first answer: no summary answer at all is asked while closing, and the
// reopened chat asks each once.
{
  reset();
  let stalled = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const directory = path.join(root, "round-first");
  // The compactor's model is looked up as a node's round starts: held there
  // until the close has begun.
  let chat = await chatAt(directory, 5_000, async () => { if (phase === "open") { stalled++; await gate; } return null; });
  try {
    await chat.send(`message 0: ${"word ".repeat(30)}`, "r0");
    await until(() => stalled > 0, "a node's round is starting");
    const closing = chat.close();
    phase = "closing";
    const at = sent.length;
    release();
    await closing;
    assert.equal(sent.slice(at).filter(call => call.kind === "compaction").length, 0, "no summary answer, not even a round's first, was asked while closing");
    phase = "reopened";
    chat = await chatAt(directory, 5_000);
    await quiet(chat);
    assert.ok(sent.some(call => call.kind === "compaction"), "the reopened chat built the nodes");
    assert.equal(twice("compaction"), 0, "and asked no answer twice");
    const usage = await chat.usage();
    assert.equal(sum(usage.compactor.calls), sent.filter(call => call.kind === "compaction").length, "every answer's usage is stored");
    assert.equal(sum(usage.cut?.compactor) + sum(usage.cut?.chat), 0, "nothing was cut off");
  } finally { await chat.close(); }
}

// 6. A chat request whose provider never answers and ignores the abort:
// Pi's close cannot join it, and the chat's close still ends within the
// grace, the settle and the join bound.
{
  reset();
  const directory = path.join(root, "never");
  const chat = await chatAt(directory, 150);
  hold = { turn: "never", compaction: 0 };
  await chat.send(`message 0: ${"word ".repeat(30)}`, "r0");
  await until(() => open.turn > 0, "the turn's request is out");
  const started = Date.now();
  await chat.close();
  const took = Date.now() - started;
  assert.ok(took >= 150 + 2_000 && took < 150 + 2_000 + 2_000 + 500, `the close ended at its join bound (${took} ms)`);
  hold = { turn: 0, compaction: 0 };
}

fs.rmSync(root, { recursive: true, force: true });
console.log("optchat close: ok");
