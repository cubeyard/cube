/** OptChat's compactor budget in the service, over Pi with faux models and
 * small limits: a node spends at most ANSWERS answers (replies that spent
 * output, capped), whatever ended each round (running out of output, a
 * rate limit or an outage after answers, answers not in the form), then is
 * held: busy, no timer, no call, never cut, the chat saying why. Only a
 * new message of the user (one more round of TRIES) or another compactor
 * model (settings, or the chat's model it follows) asks again; a thread's
 * report, a repeated request, an idle wait and a restart do not, and the
 * budget is kept across a restart. A message or another model that comes
 * while the node's last answer is out counts once that answer is in, the
 * same model still asking nothing. Every compactor request for a node
 * starts with the same system prompt and view pieces, and no message is
 * lost. Offline and disposable; no real provider. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxThinking, type Message } from "@earendil-works/pi-ai";
import { ANSWERS, OptChat, type OptThreads } from "../src/optchat.ts";
import { outputTokens, TRIES } from "../src/optchat-compactor.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-hold-"));
const RETRY = 20;
type Call = { mark: string; model: string; kind: "length" | "429" | "503" | "form" | "lines"; cap: number | undefined; prefix: string };
const calls: Call[] = [];
let turns = 0;
const LINES = ["user: s", "user: s mid", "user: summary long"].join("\n");
const faux = fauxProvider({ tokensPerSecond: 1_000_000, models: [{ id: "faux-chat" }, { id: "faux-other" }] });
const counts = new Map<string, number>();
/** Holds the answer `at` (0-based) of `mark` until opened. */
let gate: { mark: string; at: number; reached: () => void; opened: Promise<void> } | null = null;
function gateAt(mark: string, at: number) {
  let reach!: () => void, open!: () => void;
  const reached = new Promise<void>(resolve => { reach = resolve; }), opened = new Promise<void>(resolve => { open = resolve; });
  gate = { mark, at, reached: reach, opened };
  return { reached, open: () => { gate = null; open(); } };
}
faux.setResponses(Array.from({ length: 2_000 }, () => async (request, options, _state, model) => {
  const system = request.messages.filter(message => message.role === "system");
  if (!JSON.stringify(system).includes("You write the memory of OptChat")) return fauxAssistantMessage(`ok ${++turns}`);
  const user = request.messages.find(message => message.role === "user") as Extract<Message, { role: "user" }>;
  const texts = typeof user.content === "string" ? [user.content] : user.content.map(part => part.type === "text" ? part.text : "");
  const at = texts.findLastIndex(text => /^(Compress|Merge) /.test(text));
  const step = texts[at]!;
  const mark = step.startsWith("Compress") ? /\b(LONG|MIXED|FORM|GATE|SAME|ASK)\b/.exec(step)?.[1] ?? "other" : "merge";
  // What a provider caches: the system prompt and the view pieces before the step.
  const prefix = JSON.stringify([system.map(message => message.content), texts.slice(0, at)]);
  const k = counts.get(mark) ?? 0;
  counts.set(mark, k + 1);
  const call = (kind: Call["kind"]) => { calls.push({ mark, model: model.id, kind, cap: options?.maxTokens, prefix }); };
  // The node's last answer waits at the gate while a step comes.
  if (model.id === "faux-chat" && gate?.mark === mark && k === gate.at) { gate.reached(); await gate.opened; }
  if (model.id === "faux-chat" && (mark === "LONG" || mark === "GATE" || mark === "SAME" || mark === "ASK")) { call("length"); return fauxAssistantMessage([fauxThinking("Weighing every word. ".repeat(40))], { stopReason: "length" }); }
  // Four answers that ran out, then a rate limit on output tokens.
  if (model.id === "faux-chat" && mark === "MIXED") {
    if (k % 5 < 4) { call("length"); return fauxAssistantMessage([fauxThinking("Weighing every word. ".repeat(40))], { stopReason: "length" }); }
    call("429");
    return fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 rate_limit_error: output tokens per minute" });
  }
  // Four answers not in the form, then an outage.
  if (model.id === "faux-chat" && mark === "FORM") {
    if (k % 5 < 4) { call("form"); return fauxAssistantMessage("I cannot summarize this message.\nPlease send it again."); }
    call("503");
    return fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service Unavailable" });
  }
  call("lines");
  return fauxAssistantMessage(LINES);
}));
const models = createModels();
models.setProvider(faux.provider);
const threads: OptThreads = { startFailure: () => null, onStartFailure: () => () => {},
  async projects() { return "projects: cube"; },
  async runners() { return "no runners"; },
  async spawn() { throw new Error("unused"); },
  async tell() {},
  async describe() { return ""; },
  async events() { throw new Error("unused"); },
  async history() { return null; },
};
const chatModel = { provider: "faux", id: "faux-chat" };
const other = { provider: "faux", id: "faux-other" };
/** The compactor model saved in settings; null follows the chat's. */
let saved: { provider: string; id: string } | null = null;
const open = (name: string) => OptChat.open({ directory: path.join(root, name), models, model: async () => chatModel, compactor: async () => saved,
  threads, limits: { node: 64, retryMs: RETRY, watchMs: 50 } });
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 6_000) {
  for (let k = 0; k * 10 < ms && !(await check()); k++) await delay(10);
  assert.ok(await check(), what);
}
const of = (mark: string, kind?: Call["kind"]) => calls.filter(call => call.mark === mark && (!kind || call.kind === kind));
const spentOn = (mark: string) => of(mark).filter(call => call.kind === "length" || call.kind === "form" || call.kind === "lines").length;
const HELD = /^summarizing: no summary for a message yet \(.+\); change the compactor model or send a message to try again$/;
const held = (chat: OptChat) => HELD.test(chat.failure() ?? "");
const CUT = /^\(no summary, cut short: zoom it\) /;
/** Idle for many retry periods: no call may happen. */
const idle = () => delay(25 * RETRY);
const requestIds = async (chat: OptChat) => (await chat.pending()).map(item => item.requestId);

/** Running out of output: held after ANSWERS, never cut; idle, a report,
 * a repeated request, the same model and a restart ask nothing; a message
 * of the user gives one round of TRIES; another model gives a summary. */
{
  let chat = await open("long");
  try {
    const before = turns;
    await chat.send(`LONG ${"word ".repeat(30)}`, "l-1");
    await until(() => turns === before + 1, "long: turn 1 ran");
    await chat.send("next", "l-2");
    await until(() => held(chat), "long: held");
    assert.equal(spentOn("LONG"), ANSWERS, `long: ${ANSWERS} answers`);
    assert.ok(of("LONG").every(call => call.cap === outputTokens(64)), "long: every answer capped");
    await idle();
    assert.equal(spentOn("LONG"), ANSWERS, "long: no call while held and idle (no timer)");
    assert.equal(chat.memory.built(0, 0), false, "long: nothing is cut");
    assert.equal(turns, before + 1, "long: the next turn waits for the summary");
    await chat.send("[abcd1234] done: ok", "report:abcd1234:1");
    await idle();
    assert.equal(spentOn("LONG"), ANSWERS, "long: a thread's report asks nothing");
    await chat.send("next", "l-2");
    await idle();
    assert.equal(spentOn("LONG"), ANSWERS, "long: a repeated request asks nothing");
    chat.compactorChanged();
    await idle();
    assert.equal(spentOn("LONG"), ANSWERS, "long: the same model asks nothing");
    assert.ok(held(chat), "long: still held");
    await chat.send("try again", "l-3");
    await until(() => spentOn("LONG") === ANSWERS + TRIES && held(chat), "long: one round for the user's message");
    await idle();
    assert.equal(spentOn("LONG"), ANSWERS + TRIES, `long: exactly ${TRIES} more`);
    for (const id of ["l-2", "l-3", "report:abcd1234:1"]) assert.ok((await requestIds(chat)).includes(id), `long: ${id} waits, not lost`);
  } finally { await chat.close(); }
  // A restart is no new budget: held again without a call.
  chat = await open("long");
  try {
    await until(() => held(chat), "long: held after a restart");
    await idle();
    assert.equal(spentOn("LONG"), ANSWERS + TRIES, "long: a restart asks nothing");
    for (const id of ["l-2", "l-3"]) assert.ok((await requestIds(chat)).includes(id), `long: ${id} kept over the restart`);
    // Another compactor model, saved: a new round, and a real summary.
    const before = turns;
    saved = other;
    chat.compactorChanged();
    await until(() => chat.memory.built(0, 0), "long: built by the other model");
    assert.doesNotMatch(chat.memory.node(0, 0)!, CUT, "long: a summary, not the source cut short");
    assert.equal(of("LONG").filter(call => call.model === "faux-other").length, 1, "long: the other model asked once");
    assert.equal(spentOn("LONG"), ANSWERS + TRIES + 1);
    await until(() => turns > before, "long: the waiting messages reach the chat");
    await until(async () => (await requestIds(chat)).length === 0, "long: nothing left waiting");
    assert.equal(chat.failure(), null);
    assert.equal(chat.memory.zoom(0, 1), `0+0|user: LONG ${"word ".repeat(30)}`, "long: the log keeps the message whole");
    await chat.agent.conversation.waitForIdle(BACKGROUND_CONTEXT);
  } finally { await chat.close(); saved = null; }
  assert.equal(new Set(of("LONG").map(call => call.prefix)).size, 1, "long: every request for the node starts alike (rounds, release, restart, model)");
}

/** Answers that ran out, each round ended by a 429: the answers are
 * counted, not the error; at most ANSWERS, then held with no call. */
{
  const chat = await open("mixed");
  try {
    await chat.send(`MIXED ${"word ".repeat(30)}`, "m-1");
    await until(() => held(chat), "mixed: held");
    assert.equal(of("MIXED", "length").length, ANSWERS, `mixed: ${ANSWERS} capped answers`);
    assert.equal(of("MIXED", "429").length, Math.floor(ANSWERS / 4), "mixed: one 429 per round of four");
    assert.match(chat.failure() ?? "", /429 rate_limit_error/, "mixed: the chat says why");
    await idle();
    assert.equal(of("MIXED").length, ANSWERS + Math.floor(ANSWERS / 4), "mixed: nothing while held, not even a retry of the 429");
    await chat.send("again", "m-2");
    await until(() => of("MIXED", "length").length === ANSWERS + TRIES && held(chat), "mixed: one round for the message");
    await idle();
    assert.equal(of("MIXED", "length").length, ANSWERS + TRIES, `mixed: at most ${TRIES} more answers`);
    assert.equal(chat.memory.built(0, 0), false, "mixed: nothing is cut");
    assert.equal(new Set(of("MIXED").map(call => call.prefix)).size, 1, "mixed: every request starts alike");
  } finally { await chat.close(); }
}

/** Answers not in the form, each round ended by an outage: counted the
 * same, then held; the chat's model changing asks again, under it. */
{
  const chat = await open("form");
  try {
    await chat.send(`FORM ${"word ".repeat(30)}`, "f-1");
    await until(() => held(chat), "form: held");
    assert.equal(of("FORM", "form").length, ANSWERS, `form: ${ANSWERS} answers`);
    await idle();
    assert.equal(of("FORM").length, ANSWERS + Math.floor(ANSWERS / 4), "form: nothing while held");
    await chat.agent.conversation.waitForIdle(BACKGROUND_CONTEXT);
    await chat.selectModel(other);
    await until(() => chat.memory.built(0, 0), "form: built under the chat's new model");
    assert.doesNotMatch(chat.memory.node(0, 0)!, CUT, "form: a summary");
    assert.equal(chat.failure(), null);
  } finally { await chat.close(); }
}

/** Another model saved while the node's last answer is out (N1): that
 * answer still spends the budget, then the node is asked under the new
 * model at once, not held under the old one; the messages wait and reach
 * the chat, nothing more is asked, and a restart finds it built. */
{
  let chat = await open("gate");
  try {
    const at = gateAt("GATE", ANSWERS - 1);
    const before = turns;
    await chat.send(`GATE ${"word ".repeat(30)}`, "g-1");
    await until(() => turns === before + 1, "gate: turn 1 ran");
    await chat.send("next", "g-2");
    await at.reached;
    assert.equal(spentOn("GATE"), ANSWERS - 1, "gate: the last answer is out");
    saved = other;
    chat.compactorChanged();
    assert.ok((await requestIds(chat)).includes("g-2"), "gate: g-2 waits");
    at.open();
    await until(() => chat.memory.built(0, 0), "gate: built under the model saved while the last answer was out");
    assert.doesNotMatch(chat.memory.node(0, 0)!, CUT, "gate: a summary");
    assert.equal(of("GATE").filter(call => call.model === "faux-other").length, 1, "gate: the new model asked once");
    assert.equal(of("GATE").filter(call => call.model === "faux-chat").length, ANSWERS, "gate: the old model's budget, no more");
    await until(async () => (await requestIds(chat)).length === 0, "gate: g-2 reaches the chat");
    assert.equal(chat.failure(), null);
    await idle();
    assert.equal(of("GATE").length, ANSWERS + 1, "gate: nothing more is asked");
    await chat.agent.conversation.waitForIdle(BACKGROUND_CONTEXT);
  } finally { await chat.close(); }
  chat = await open("gate");
  try {
    assert.ok(chat.memory.built(0, 0), "gate: built after a restart");
    await idle();
    assert.equal(of("GATE").length, ANSWERS + 1, "gate: a restart asks nothing");
    assert.equal(chat.failure(), null, "gate: no stale hold after a restart");
  } finally { await chat.close(); saved = null; }
  assert.equal(new Set(of("GATE").map(call => call.prefix)).size, 1, "gate: every request starts alike");
}

/** The same model saved while the last answer is out: held after it, with
 * no call; repeated saves ask nothing either. A message still releases. */
{
  const chat = await open("same");
  try {
    const at = gateAt("SAME", ANSWERS - 1);
    await chat.send(`SAME ${"word ".repeat(30)}`, "s-1");
    await at.reached;
    chat.compactorChanged();
    at.open();
    await until(() => held(chat), "same: held under the same model");
    for (let k = 0; k < 3; k++) chat.compactorChanged();
    await idle();
    assert.equal(spentOn("SAME"), ANSWERS, "same: the same model asks nothing, even saved again");
    await chat.send("again", "s-2");
    await until(() => spentOn("SAME") === ANSWERS + TRIES && held(chat), "same: one round for the message");
    await idle();
    assert.equal(spentOn("SAME"), ANSWERS + TRIES, `same: exactly ${TRIES} more`);
  } finally { await chat.close(); }
}

/** A message of the user while the last answer is out: one round of TRIES
 * after it, then held; no more. */
{
  const chat = await open("ask");
  try {
    const at = gateAt("ASK", ANSWERS - 1);
    await chat.send(`ASK ${"word ".repeat(30)}`, "a-1");
    await at.reached;
    await chat.send("again", "a-2");
    at.open();
    await until(() => spentOn("ASK") === ANSWERS + TRIES && held(chat), "ask: one round for the message sent while the last answer was out");
    await idle();
    assert.equal(spentOn("ASK"), ANSWERS + TRIES, `ask: exactly ${TRIES} more`);
    assert.ok((await requestIds(chat)).includes("a-2"), "ask: a-2 waits, not lost");
    assert.equal(chat.memory.built(0, 0), false, "ask: nothing is cut");
  } finally { await chat.close(); }
}

fs.rmSync(root, { recursive: true, force: true });
console.log("optchat compactor hold: ok");
