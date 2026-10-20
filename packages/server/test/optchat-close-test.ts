/** OptChat's close, offline with a faux model: a close starts no new turn,
 * node, chat request or tool, waits for the model calls already out (summaries being built, a chat
 * request sent) and stores their answers and usage, so the reopened chat
 * sends none of them again. Only a call still out after the close's grace
 * is cut off: counted as unknown, and sent again at most once each. */
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

/** How a call's answer comes: at once, after ms, or only once aborted. */
type Hold = number | "abort";
let hold: { turn: Hold; compaction: Hold } = { turn: 0, compaction: 0 };
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
  open[kind]++;
  try {
    const wait = hold[kind], signal = options?.signal;
    if (wait === "abort") await new Promise(resolve => { if (signal?.aborted) resolve(null); signal?.addEventListener("abort", resolve, { once: true }); });
    else if (wait) await delay(wait, null, { signal }).catch(() => {});
    if (signal?.aborted) aborted[kind]++;
  } finally { open[kind]--; }
  if (kind === "compaction") return fauxAssistantMessage(`summary ${++n} ${"s".repeat(20)}`);
  const user = request.messages.findLast(message => message.role === "user");
  const tool = !!user && textOf(user).includes("#tool") && !request.messages.some(message => message.role === "toolResult");
  return tool ? fauxAssistantMessage([fauxToolCall("projects", {})], { stopReason: "toolUse" }) : fauxAssistantMessage(`reply ${++n} ${"r".repeat(80)}`);
}));
const models = createModels();
models.setProvider(faux.provider);
/** The `projects` tool's runs, by when they started, and how long one takes. */
let phase: "open" | "closing" | "reopened" = "open";
const runs = { open: 0, closing: 0, reopened: 0 };
let toolMs = 0;
const threads: OptThreads = {
  async projects() { runs[phase]++; if (toolMs) await delay(toolMs); return "projects: cube"; }, async runners() { return "no runners"; },
  async spawn() { throw new Error("unused"); }, async tell() {}, async describe() { return ""; },
  async events() { throw new Error("unused"); }, async history() { return null; },
};
const chatAt = (directory: string, closeMs: number) => OptChat.open({ directory, models, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }),
  threads, limits: { view: 1_600, low: 800, compaction: 400, compactionLow: 200, node: 64, retryMs: 50, watchMs: 50, closeMs } });
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
const reset = () => { phase = "open"; Object.assign(runs, { open: 0, closing: 0, reopened: 0 }); sent.length = 0; Object.assign(open, { turn: 0, compaction: 0 }); Object.assign(aborted, { turn: 0, compaction: 0 }); };

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

// 2b. A tool already running when the close begins is not waited for: Pi's
// close joins it, but its result is not stored, so the reopened run starts
// it again (replay "safe"). Unchanged by the gate; recorded here, so a
// change to it is seen. Every tool of the chat must stay safe to run twice.
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
    assert.ok(took >= 200, `the close joined the running tool (${took} ms)`);
    phase = "reopened";
    toolMs = 0;
    chat = await chatAt(directory, 5_000);
    await quiet(chat);
    assert.equal(runs.open, 1);
    assert.equal(runs.reopened, 1, "the reopened run ran it again, once");
    assert.equal(twice("turn"), 0, "no request sent twice");
  } finally { await chat.close(); toolMs = 0; }
}

// 3. Forced: summaries still out after the grace are cut off. The close ends
// soon after its grace, counts each as unknown, and the reopen asks again
// for at most those.
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
    await quiet(chat);
    const again = twice("compaction");
    assert.ok(again <= cut, `the reopen asked again for at most the ${cut} cut off (${again})`);
    assert.ok(sent.slice(0, at).filter(call => call.kind === "compaction").length >= cut);
    const usage = await chat.usage();
    assert.equal(sum(usage.cut?.compactor), cut, "each call cut off is counted as unknown");
    assert.equal(sum(usage.cut?.chat), 0);
  } finally { await chat.close(); }
}

// 4. Forced: a chat request still out after the grace is cut off, counted,
// and sent again once by the reopened run.
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
    chat = await chatAt(directory, 5_000);
    await quiet(chat);
    assert.equal(twice("turn"), 1, "the reopened run sent it again, once");
    const usage = await chat.usage();
    assert.equal(sum(usage.cut?.chat), 1, "and it is counted as unknown");
  } finally { await chat.close(); }
}

fs.rmSync(root, { recursive: true, force: true });
console.log("optchat close: ok");
