/** A paid model request out when cubed dies is never sent again on its own
 * (pi-sends.ts). Each case runs cubed's chat or a thread agent in a child
 * process (pi-sends-child.ts) that is SIGKILLed while the request is out at
 * a faux provider, a real crash: then reopens the same store here, with a
 * faux provider that answers and counts what it is sent.
 *
 *   - chat: the turn's request is counted once (across a second reopen),
 *     not sent again, its turn ends unanswered and says why; the next
 *     message is answered.
 *   - compactor: the summary's answer is counted once and not asked again;
 *     its node is held, saying why, until a message of the user, which asks
 *     it once; its answer stays taken from the node's.
 *   - thread: the request is counted once in the thread's usage, not sent
 *     again, its run is stopped; the next message is answered.
 *   - fences: settling twice before a resume (a crash during the open)
 *     counts once.
 *   - failed saves: a send whose record cannot be stored is not sent, in
 *     the chat (its Session fails, the chat goes down), in a thread and in
 *     the compactor (its round ends, nothing sent).
 * Faux model and the guest helper in a temporary root (not a VM). */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openAgent, openStorage } from "../src/durable-agent.ts";
import { OptChat } from "../src/optchat.ts";
import { SendsDoc, sendsExtension, settleSends } from "../src/pi-sends.ts";
import { UsageService } from "../src/usage-service.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { LocalGuestTransport } from "./local-guest.ts";
import { CHAT_LIMITS, threadsStub } from "./pi-sends-fixture.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-pi-sends-"));
const textOf = (message: Message) => typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text : "").join("");
const sent: Array<{ kind: "turn" | "compaction"; user: string }> = [];
/** How long a turn's answer takes. */
let turnMs = 0;
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 400 }, () => async (request, options) => {
  // Counted as sent when the provider has it, before its answer.
  const kind = request.messages.some(message => message.role === "system" && textOf(message).includes("You write the memory of OptChat")) ? "compaction" : "turn";
  sent.push({ kind, user: textOf(request.messages.filter(message => message.role === "user").at(-1)!) });
  // An abort (a close) ends the wait, as a provider's stream ends.
  if (turnMs) await delay(turnMs, null, { signal: options?.signal }).catch(() => {});
  if (options?.signal?.aborted) return fauxAssistantMessage("", { stopReason: "aborted" });
  return fauxAssistantMessage(kind === "compaction" ? `summary ${sent.length} ${"s".repeat(20)}` : `reply ${sent.length}`);
}));
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, id: faux.getModel().id };
const count = (kind: "turn" | "compaction") => sent.filter(call => call.kind === kind).length;
const sum = (calls: Record<string, number> | undefined) => Object.values(calls ?? {}).reduce((total, n) => total + n, 0);
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!await check()) { assert.ok(Date.now() < deadline, `waiting for ${what}`); await delay(20); }
}

/** Runs the child until its request is out, then kills it. */
async function crash(kind: "chat" | "compactor" | "thread" | "compaction", directory: string): Promise<void> {
  const signal = path.join(root, `${path.basename(directory)}-${Date.now()}.signal`);
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "pi-sends-child.ts"), kind, directory, signal], { stdio: ["ignore", "ignore", "inherit"] });
  const exited = new Promise(resolve => child.once("exit", resolve));
  await until(() => fs.existsSync(signal), `the ${kind} request is out`, 30_000);
  child.kill("SIGKILL");
  await exited;
}
const chatAt = (directory: string) => OptChat.open({ directory, models, model: async () => model, threads: threadsStub, limits: { ...CHAT_LIMITS, closeMs: 5_000 } });
const talk = (chat: OptChat) => chat.memory.messages.filter(message => message.kind === "talk").length;

// The chat's request.
{
  const directory = path.join(root, "chat");
  await crash("chat", directory);
  sent.length = 0;
  let chat = await chatAt(directory);
  try {
    await chat.agent.conversation.waitForIdle(context);
    await delay(300);
    assert.equal(count("turn"), 0, "the request out at the crash was not sent again");
    // Shown unless a summary out at the kill (held, counted) is shown first.
    assert.match((chat as unknown as { requestError: string | null }).requestError ?? "", /last request was out when cubed stopped, so it was not sent again/);
    assert.equal(sum((await chat.usage()).cut?.chat), 1, "it is counted as one of unknown cost");
    await chat.close();
    chat = await chatAt(directory);
    assert.equal(sum((await chat.usage()).cut?.chat), 1, "a second open counts it no more");
    await chat.send(`message 1: ${"word ".repeat(30)}`, "r1");
    await until(() => talk(chat) >= 1, "the next message is answered");
    assert.equal(count("turn"), 1, "one request: the next message's");
    assert.match(sent.find(call => call.kind === "turn")!.user, /message 1/);
  } finally { await chat.close(); }
  console.log("ok: chat: a request out at a crash is counted once, not sent again; the next message is answered");
}

// A summary's answer.
{
  const directory = path.join(root, "compactor");
  await crash("compactor", directory);
  sent.length = 0;
  let chat = await chatAt(directory);
  try {
    await until(() => /no summary for a message yet \(its summary was out when cubed stopped/.test(chat.failure() ?? ""), "the held node says why");
    await delay(300);
    assert.equal(count("compaction"), 0, "the answer out at the crash was not asked again");
    assert.equal(sum((await chat.usage()).cut?.compactor), 1, "it is counted as one of unknown cost");
    await chat.close();
    chat = await chatAt(directory);
    await delay(300);
    assert.equal(count("compaction"), 0, "nor after another open");
    assert.equal(sum((await chat.usage()).cut?.compactor), 1, "which counts it no more");
    await chat.send(`message 1: ${"word ".repeat(30)}`, "r1");
    await until(() => talk(chat) >= 1, "the user's message releases the node and is answered");
    await until(() => count("compaction") >= 1, "message 0 is summarized");
    assert.equal(sent.filter(call => call.kind === "compaction" && call.user.includes("message 0")).length, 1, "message 0's summary was asked once after the release");
  } finally { await chat.close(); }
  console.log("ok: compactor: an answer out at a crash is counted once and not asked again; its node waits for the user's message");
}

// A thread's request.
{
  const directory = path.join(root, "thread", "thread");
  await crash("thread", directory);
  sent.length = 0;
  const files = path.join(root, "thread", "workspace");
  const guest = new LocalGuestTransport(path.dirname(files));
  const open = () => openAgent({ directory, binding: guest.binding, workspace: new VmWorkspace({ guest, leases: new LeaseStore(directory), owner: "pi", binding: guest.binding }), models, model });
  let agent = await open();
  try {
    await agent.conversation.waitForIdle(context);
    await delay(300);
    assert.equal(count("turn"), 0, "the thread's request was not sent again");
    const first = (await agent.harness.inspect(context)).submissions;
    assert.deepEqual(first, [], "its run is settled");
    assert.deepEqual((await agent.harness.snapshot(SendsDoc, context))?.interrupted, { [`${model.provider}/${model.id}`]: 1 });
    await agent.close();
    agent = await open();
    assert.deepEqual((await agent.harness.snapshot(SendsDoc, context))?.interrupted, { [`${model.provider}/${model.id}`]: 1 }, "counted once across opens");
    const submission = await agent.conversation.submit({ type: "input", content: "second", requestId: "second" }, context);
    assert.equal((await submission.wait(context)).status, "done");
    assert.deepEqual(sent.map(call => call.user), ["second"], "only the next message's request");
  } finally { await agent.close(); }
  // The thread's usage says so (read from its store, as for a closed thread).
  const registry = { getThread: () => ({ id: "thread", title: "t", projectId: "p", archived: true, agent: "pi", createdAt: 0 }) };
  const usage = new UsageService({ file: path.join(root, "usage.sqlite"), registry: registry as never, threads: path.join(root, "thread"), live: async () => null, optchat: async () => null, pricing: () => null });
  const read = await usage.thread("thread");
  assert.equal(read.unknownTurns, 1);
  assert.equal(read.coverage, "partial");
  assert.match(read.notes.join(" "), /1 model requests were out when cubed stopped/);
  console.log("ok: thread: a request out at a crash is counted once (its usage partial), not sent again; the next message is answered");
}

// A thread's close (G1): a request out (the provider has it, its answer
// comes 1.5 s later) is drained, stored, and neither dropped nor sent again
// by the reopen; one whose provider never answers is cut at the drain's
// bound and counted by the reopen, not sent again; one the run would start
// while closing is held back unsent and sent once after the reopen.
{
  const directory = path.join(root, "drain", "thread");
  const files = path.join(root, "drain", "workspace");
  fs.mkdirSync(files, { recursive: true });
  const guest = new LocalGuestTransport(path.dirname(files));
  const open = () => openAgent({ directory, binding: guest.binding, workspace: new VmWorkspace({ guest, leases: new LeaseStore(directory), owner: "pi", binding: guest.binding }), models, model });
  const key = `${model.provider}/${model.id}`;
  sent.length = 0;
  turnMs = 1500;
  let agent = await open();
  try {
    await agent.conversation.submit({ type: "input", content: "out", requestId: "out" }, context);
    await until(() => sent.length === 1, "the provider has the request");
    const draining = Date.now();
    assert.equal(await agent.drain(5_000), true, "it came back within the drain");
    assert.ok(Date.now() - draining >= 1000, "the drain waited for the answer");
  } finally { await agent.close(); }
  turnMs = 0;
  agent = await open();
  try {
    await agent.conversation.waitForIdle(context);
    assert.deepEqual((await agent.harness.snapshot(SendsDoc, context))?.interrupted ?? {}, {}, "nothing was out at the close");
    const answers = (await agent.conversation.context(context)).messages.filter(message => message.role === "assistant");
    assert.deepEqual(answers.map(message => (message as { stopReason: string }).stopReason), ["stop"], "its answer came back whole and was stored");
    assert.deepEqual(sent.map(call => call.user), ["out"], "and nothing is sent again");
    // A provider that does not answer within the drain's bound.
    turnMs = 60_000;
    await agent.conversation.submit({ type: "input", content: "slow", requestId: "slow" }, context);
    await until(() => sent.length === 2, "the provider has the slow request");
    assert.equal(await agent.drain(300), false, "still out at the bound");
  } finally { await agent.close(); }
  turnMs = 0;
  agent = await open();
  try {
    await agent.conversation.waitForIdle(context);
    assert.deepEqual((await agent.harness.snapshot(SendsDoc, context))?.interrupted, { [key]: 1 }, "the one cut at the bound is counted");
    assert.deepEqual(sent.map(call => call.user), ["out", "slow"], "and not sent again");
    // Now the gate: closing before the request is sent.
    assert.equal(await agent.drain(1_000), true);
    await agent.conversation.submit({ type: "input", content: "held", requestId: "held" }, context);
    // Prepared and at its request (the hook), then given time to be sent.
    await until(async () => sent.some(call => call.user === "held") || (await agent.harness.inspect(context)).tasks.some(task => (task.record.state as { checkpoint?: { phase?: string } }).checkpoint?.phase === "request"), "the request is ready to go");
    await delay(300);
    assert.deepEqual(sent.map(call => call.user), ["out", "slow"], "a request is not sent while closing");
  } finally { await agent.close(); }
  agent = await open();
  try {
    await agent.conversation.waitForIdle(context);
    assert.deepEqual(sent.map(call => call.user), ["out", "slow", "held"], "the reopen sends the held request, once");
    assert.deepEqual((await agent.harness.snapshot(SendsDoc, context))?.interrupted, { [key]: 1 }, "never sent before, so not counted");
  } finally { await agent.close(); }
  console.log("ok: a thread's close: a request out is drained and stored; one past the drain's bound is counted, not sent again; one not yet sent is held and sent once after the reopen");
}

// A thread's own context summary (Pi's compaction) out at a kill: counted
// once and not asked again; Pi asks for no new summary on its own after
// the reopen, and no run is left waiting for it.
{
  const directory = path.join(root, "compaction", "thread");
  await crash("compaction", directory);
  const asked: string[] = [];
  const small = fauxProvider({ tokensPerSecond: 100_000, models: [{ id: "faux-small", contextWindow: 60_000 }] });
  small.setResponses(Array.from({ length: 50 }, () => async request => {
    const summary = request.messages.some(message => message.role === "system" && textOf(message).includes("context summarization assistant"));
    asked.push(summary ? "summary" : textOf(request.messages.filter(message => message.role === "user").at(-1)!).slice(0, 20));
    return fauxAssistantMessage(summary ? "## Goal\nsummary" : "ok");
  }));
  const smallModels = createModels();
  smallModels.setProvider(small.provider);
  const files = path.join(root, "compaction", "workspace");
  const guest = new LocalGuestTransport(path.dirname(files));
  const open = () => openAgent({ directory, binding: guest.binding, workspace: new VmWorkspace({ guest, leases: new LeaseStore(directory), owner: "pi", binding: guest.binding }), models: smallModels, model: { provider: small.getModel().provider, id: "faux-small" } });
  let agent = await open();
  try {
    await agent.conversation.waitForIdle(context);
    await delay(500);
    assert.deepEqual(asked, [], "the summary out at the kill was not asked again, nor anything else");
    assert.deepEqual((await agent.harness.snapshot(SendsDoc, context))?.interrupted, { [`${small.getModel().provider}/faux-small`]: 1 }, "it is counted as unknown");
    assert.deepEqual((await agent.harness.inspect(context)).tasks.map(task => task.record.kind), [], "the compaction ended, and nothing waits for it");
    await agent.close();
    agent = await open();
    await agent.conversation.waitForIdle(context);
    assert.deepEqual((await agent.harness.snapshot(SendsDoc, context))?.interrupted, { [`${small.getModel().provider}/faux-small`]: 1 }, "counted once across opens");
    assert.deepEqual(asked, []);
  } finally { await agent.close(); }
  console.log("ok: a thread's context summary out at a crash is counted once and not asked again, nothing left waiting for it");
}

// A compactor reply whose commit fails in cube (not a Session failure): the
// node is not built on it, and the answer stays marked out, so it is
// counted as unknown when the node is asked again.
{
  sent.length = 0;
  const chat = await chatAt(path.join(root, "reply-commit"));
  try {
    const harness = (chat as unknown as { harness: { commit: (change: unknown, commitContext: unknown) => Promise<unknown> } }).harness;
    const commit = harness.commit.bind(harness);
    let failed = 0;
    harness.commit = (change, commitContext) => {
      if (!failed && new Error().stack?.includes("countCompactor")) { failed++; return Promise.reject(new Error("the reply's commit failed (test)")); }
      return commit(change, commitContext);
    };
    await chat.send(`message 0: ${"word ".repeat(30)}`, "r0");
    await until(() => talk(chat) >= 1, "the turn is answered");
    await until(async () => count("compaction") >= 2 && sum((await chat.usage()).cut?.compactor) === 1, "the node asked again, the unstored reply counted as unknown");
    assert.equal(failed, 1, "one reply's commit failed");
  } finally { await chat.close(); }
  console.log("ok: a compactor reply whose commit fails is not used, and counts as unknown when its node is asked again");
}

// A thread's record that fails before storage: the hook aborts the
// generation, then throws, so Pi does not send what it built itself.
{
  sent.length = 0;
  const storage = await openStorage(path.join(root, "record-thread.sqlite"));
  const registry = createRegistry();
  // The hook reads `harness` only once a request runs, after it is set.
  registry.install(sendsExtension(() => harness, () => { throw new Error("the send record failed (test)"); }));
  const harness = await Harness.open(storage, { models, registry }, context);
  try {
    const conversation = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
    const submission = await conversation.submit({ type: "input", content: "refused", requestId: "refused" }, context);
    const settled = await submission.wait(context);
    assert.notEqual(settled.status, "done");
    assert.equal(count("turn"), 0, "the thread's request was not sent");
  } finally { await harness.close(context); }
  console.log("ok: a thread's send record that fails before storage refuses the request: nothing sent");
}

// Settling twice before a resume, as a crash during the open does, counts once.
{
  const directory = path.join(root, "fence");
  await crash("chat", directory);
  for (let k = 0; k < 2; k++) {
    const storage = await openStorage(path.join(directory, "pi.sqlite"));
    const harness = await Harness.open(storage, { models, registry: createRegistry() }, context).catch(async error => { await storage.close(context); throw error; });
    try {
      const { dropped } = await settleSends(harness, context);
      assert.equal(dropped.length, 1, "the request is still live: its abort never ran");
      assert.equal(sum((await harness.snapshot(SendsDoc, context))?.interrupted), 1, `open ${k + 1}: counted once`);
    } finally { await harness.close(context); }
  }
  // The same for a thread's context summary out at the kill (no memo: its
  // count is fenced by `compactions`).
  const summary = path.join(root, "fence-compaction", "thread");
  await crash("compaction", summary);
  for (let k = 0; k < 3; k++) {
    const storage = await openStorage(path.join(summary, "pi.sqlite"));
    const harness = await Harness.open(storage, { models, registry: createRegistry() }, context).catch(async error => { await storage.close(context); throw error; });
    try {
      const { dropped } = await settleSends(harness, context);
      assert.equal(dropped.length, 1, "the summary is still live: its abort never ran");
      assert.equal(sum((await harness.snapshot(SendsDoc, context))?.interrupted), 1, `summary, open ${k + 1}: counted once`);
    } finally { await harness.close(context); }
  }
  console.log("ok: a crash during the open (settled, never resumed) counts the request once, and a thread's summary once");
}
// A send whose record cannot be stored is not sent: the storage fails on
// that commit (a full disk, an I/O error), so Pi's Session fails with it.
type Committing = { commit: (writes: unknown, commitContext: unknown) => Promise<unknown> };
function failOn(storage: unknown, marker: string): () => number {
  const target = storage as Committing;
  const commit = target.commit.bind(target);
  let failed = 0;
  target.commit = async (writes, commitContext) => {
    if (JSON.stringify(writes).includes(marker)) { failed++; throw new Error("disk I/O error (test)"); }
    return commit(writes, commitContext);
  };
  return () => failed;
}
for (const [what, marker, kind] of [["the chat's request", "cube.sent.", "turn"], ["a summary's answer", '"out":{"at"', "compaction"]] as const) {
  sent.length = 0;
  const chat = await chatAt(path.join(root, `failed-${kind}`));
  try {
    const failed = failOn((chat as unknown as { storage: unknown }).storage, marker);
    await chat.send(`message 0: ${"word ".repeat(30)}`, "r0");
    await until(() => /could not be saved/.test(chat.failure() ?? ""), "the chat goes down");
    await delay(300);
    assert.ok(failed() >= 1, "the record's commit failed");
    assert.equal(count(kind), 0, `${what} was not sent`);
  } finally { await chat.close(); }
}
{
  sent.length = 0;
  const directory = path.join(root, "failed-thread", "thread");
  const files = path.join(root, "failed-thread", "workspace");
  fs.mkdirSync(files, { recursive: true });
  const guest = new LocalGuestTransport(path.dirname(files));
  const agent = await openAgent({ directory, binding: guest.binding, workspace: new VmWorkspace({ guest, leases: new LeaseStore(directory), owner: "pi", binding: guest.binding }), models, model });
  try {
    const failed = failOn(agent.storage, "cube.sent.");
    await agent.conversation.submit({ type: "input", content: "first", requestId: "first" }, context).catch(() => {});
    await until(() => agent.failure() !== null, "the thread agent goes down");
    await delay(300);
    assert.ok(failed() >= 1);
    assert.equal(count("turn"), 0, "the thread's request was not sent");
  } finally { await agent.close(); }
}
// A record that fails before storage (not a Session failure): the chat's
// hook refuses the request, so Pi does not send what it built itself.
{
  sent.length = 0;
  const chat = await chatAt(path.join(root, "failed-record"));
  try {
    Object.defineProperty(chat, "epoch", { configurable: true, get() { throw new Error("the send record failed (test)"); } });
    await chat.send(`message 0: ${"word ".repeat(30)}`, "r0");
    await until(() => /a request was not sent: the send record failed/.test(chat.failure() ?? ""), "the chat says the request was not sent");
    await chat.agent.conversation.waitForIdle(context);
    assert.equal(count("turn"), 0, "the request was not sent");
  } finally { await chat.close(); }
}
console.log("ok: a send whose record cannot be stored is not sent: the chat's request, a summary's answer, a thread's request; and a record that fails before storage");
fs.rmSync(root, { recursive: true, force: true });
