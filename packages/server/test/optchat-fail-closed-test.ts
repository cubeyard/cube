/** OptChat fails closed, offline with a faux model and disposable state.
 * P-A: when the request's view or images cannot be built (beforeRequest
 * throws), nothing is sent: Pi would skip the throw and send its own
 * messages (no view, no images: another prefix and cost), so OptChat aborts
 * the generation first. The turn ends unanswered, the failure is logged and
 * shown, and nothing sends it again: not a retry, not the next turn, not a
 * reopen. If the abort's commit fails, the Session's end aborts it: the
 * chat goes down, nothing sent. A close that comes before the abort
 * commits neither waits for the refused request nor counts it as cut off
 * (it was never sent); the reopened chat sends it once. H1: when Pi's Session fails (a storage error), the chat goes down
 * at once: no further send or retry in the process, the compactor cut off
 * without the close's grace, provider sessions released, the failure shown
 * and logged without secrets. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, registerSessionResourceCleanup, type Message } from "@earendil-works/pi-ai";
import { LiveDoc } from "@earendil-works/pi-durable";
import { OptChat, type OptThreads } from "../src/optchat.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-fail-closed-"));
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("");

/** Every chat request the model got, by the message it answers; and the compactor's calls. */
const turns: string[] = [];
let compactions = 0;
/** Runs in the model once a chat request was sent. */
let onTurn: (message: string) => Promise<void> | void = () => {};
const faux = fauxProvider({ tokensPerSecond: 100_000 });
let holdCompactor = false, compactorAborted = 0;
faux.setResponses(Array.from({ length: 2_000 }, () => async (request, options) => {
  if (request.messages.some(message => message.role === "system" && textOf(message).includes("You write the memory of OptChat"))) {
    compactions++;
    // A provider that answers only once the call is aborted.
    if (holdCompactor && options?.signal) {
      await new Promise(resolve => { if (options.signal!.aborted) resolve(null); options.signal!.addEventListener("abort", resolve, { once: true }); });
      compactorAborted++;
    }
    return fauxAssistantMessage(`summary ${"s".repeat(20)}`);
  }
  // The user's words come after the view, which quotes earlier messages.
  const message = [...textOf(request.messages.findLast(message => message.role === "user")!).matchAll(/\b(m\d+) (?:first|refused|next|out|after)\b/g)].at(-1)?.[1] ?? "?";
  turns.push(message);
  await onTurn(message);
  return fauxAssistantMessage(`reply to ${message}`);
}));
const models = createModels();
models.setProvider(faux.provider);
const threads: OptThreads = { startFailure: () => null, onStartFailure: () => () => {}, onRunFeed: () => () => {},
  async projects() { return "projects: cube"; }, async runners() { return "no runners"; },
  async spawn() { throw new Error("unused"); }, async tell() {}, async describe() { return ""; },
  async events() { throw new Error("unused"); }, async history() { return null; },
};
const RETRY_MS = 50;
const open = (name: string, closeMs = 5_000, small = false) => OptChat.open({ directory: path.join(root, name), models, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }),
  threads, limits: { retryMs: RETRY_MS, watchMs: 50, closeMs, ...small ? { view: 1_600, low: 800, node: 64 } : {} } });
async function until(check: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 10_000;
  while (!await check()) { assert.ok(Date.now() < deadline, `waiting for ${what}`); await delay(10); }
}
const sent = (message: string) => turns.filter(turn => turn === message).length;
const idle = async (chat: OptChat) => !(await chat.agent.conversation.commit(async tx => !!(await tx.doc(LiveDoc, chat.agent.conversation.id)).run, context)) && !(await chat.pending()).length;
const answered = async (chat: OptChat, message: string) => {
  const page = await chat.agent.conversation.entries({}, 512, undefined, context);
  return page.items.some(entry => entry.kind === "pi.assistant" && JSON.stringify(entry).includes(`reply to ${message}`));
};

/** cubed's log lines while `run` runs. */
async function logged<T>(run: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    lines.push(String(chunk));
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stdout.write;
  try { return { value: await run(), lines }; }
  finally { process.stdout.write = write; }
}

const SECRET = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
type Inner = { memory: { render: (...args: unknown[]) => string }; imageSupport: () => unknown };

try {
  for (const [label, fault] of [
    ["the view (memory.render)", (chat: OptChat) => { const inner = chat as unknown as Inner; const render = inner.memory.render.bind(inner.memory); return (armed: () => boolean) => { inner.memory.render = (...args) => { if (armed()) throw new Error(`render failed (key ${SECRET})`); return render(...args); }; }; }],
    ["the images (imageSupport)", (chat: OptChat) => { const inner = chat as unknown as Inner; const support = inner.imageSupport.bind(chat); return (armed: () => boolean) => { inner.imageSupport = () => { if (armed()) throw new Error(`images failed (key ${SECRET})`); return support(); }; }; }],
  ] as const) {
    // P-A: a hook failure sends nothing, ends the turn, shows and logs it.
    const name = label.startsWith("the view") ? "view" : "images";
    turns.length = 0;
    let chat = await open(name);
    let armed = false;
    fault(chat)(() => armed);
    await chat.send("m1 first", "r1");
    await until(() => answered(chat, "m1"), "m1 answered");
    await until(() => idle(chat), "idle after m1");
    assert.equal(sent("m1"), 1);

    armed = true;
    const { lines } = await logged(async () => {
      await chat.send("m2 refused", "r2");
      await until(() => chat.failure()?.startsWith("a request was not sent") ?? false, "the refusal shown");
      await until(() => idle(chat), "the turn ended");
    });
    // Long enough for drain's retry timer (RETRY_MS) and Pi's own retry.
    await delay(10 * RETRY_MS);
    assert.equal(sent("m2"), 0, `${label}: a request whose ${label} failed is not sent`);
    assert.ok(!await answered(chat, "m2"), "and has no answer");
    const warning = lines.find(line => line.includes("request not sent"));
    assert.ok(warning, `${label}: the refusal is logged`);
    assert.ok(!warning.includes(SECRET) && warning.includes("[redacted]"), "without the secret in its message");
    assert.ok(!lines.join("").includes(SECRET), "nowhere in the log");
    assert.ok(!lines.join("").includes("stack="), "and without a stack");
    assert.ok(!chat.failure()!.includes(SECRET), "nor in what the chat shows");
    const unanswered = await chat.agent.conversation.commit(tx => tx.submissionByRequest(chat.agent.conversation.id, "r2"), context);
    assert.equal(unanswered?.status, "unanswered", "the turn ends unanswered, as a stop");

    // The next message is a new turn, sent once with its view; m2 is not
    // sent with it or after it.
    armed = false;
    await chat.send("m3 next", "r3");
    await until(() => answered(chat, "m3"), "m3 answered");
    await until(() => idle(chat), "idle after m3");
    assert.equal(sent("m3"), 1);
    assert.equal(sent("m2"), 0, "the refused turn is not sent with the next one");
    assert.equal(chat.failure(), null, "a sent request clears the refusal");

    // A reopen sends nothing again: the refused turn is settled.
    await chat.close();
    chat = await open(name);
    await delay(10 * RETRY_MS);
    await until(() => idle(chat), "idle after the reopen");
    assert.deepEqual([sent("m1"), sent("m2"), sent("m3")], [1, 0, 1], "no send again after a reopen");
    await chat.close();
    console.log(`ok: a failure building ${label} sends nothing, ends the turn unanswered, is logged without secrets, and is never sent again`);
  }

  {
    // The abort's commit fails (as every commit from then on): the
    // Session's end aborts the generation. The wait ends at once, the chat
    // goes down, and nothing is sent or retried.
    turns.length = 0;
    const chat = await open("abort-commit", 30_000);
    await chat.send("m1 first", "r1");
    await until(() => answered(chat, "m1"), "m1 answered");
    await until(() => idle(chat), "idle after m1");
    const inner = chat as unknown as Inner;
    const render = inner.memory.render.bind(inner.memory);
    const storage = chat.agent.storage as unknown as { commit: (...args: unknown[]) => Promise<unknown> };
    const commit = storage.commit.bind(storage);
    let broken = false;
    storage.commit = (...args) => broken ? Promise.reject(new Error("disk I/O error (test)")) : commit(...args);
    inner.memory.render = (...args) => {
      // The request's view fails; so does every commit after it, the abort's first.
      if (turns.includes("m1")) { broken = true; throw new Error("render failed"); }
      return render(...args);
    };
    const started = Date.now();
    await chat.send("m2 refused", "r2");
    await until(() => chat.failure()?.startsWith("the chat stopped") ?? false, "the chat down");
    await chat.close();
    const ms = Date.now() - started;
    await delay(10 * RETRY_MS);
    assert.ok(broken, "the view failed");
    assert.ok(ms < 6_000, `the wait ends with the Session, not the 30 s grace (${ms} ms)`);
    assert.equal(sent("m2"), 0, "the refused request is not sent");
    assert.deepEqual(turns, ["m1"], "nor anything else, no retry");
    console.log(`ok: an abort whose commit fails ends with the Session: the chat goes down in ${ms} ms, nothing sent`);
  }

  {
    // A close before the abort commits (the abort is held off here): the
    // close does not wait for the refused request or count it as cut off,
    // since it was never sent. Its task stays live, so the reopened chat
    // builds it again and sends it once.
    turns.length = 0;
    let chat = await open("close-race", 30_000);
    await chat.send("m1 first", "r1");
    await until(() => answered(chat, "m1"), "m1 answered");
    await until(() => idle(chat), "idle after m1");
    const inner = chat as unknown as Inner & { harness: { abortTask: (...args: unknown[]) => Promise<void> } };
    const render = inner.memory.render.bind(inner.memory);
    let armed = true;
    inner.memory.render = (...args) => { if (armed && turns.includes("m1")) throw new Error("render failed"); return render(...args); };
    inner.harness.abortTask = async () => {};
    await chat.send("m2 refused", "r2");
    await until(() => chat.failure()?.startsWith("a request was not sent") ?? false, "the refusal shown");
    const started = Date.now();
    const { lines } = await logged(() => chat.close());
    const ms = Date.now() - started;
    assert.ok(ms < 6_000, `the close does not wait the grace for it (${ms} ms)`);
    assert.equal(sent("m2"), 0, "not sent before the close");
    assert.ok(!lines.some(line => line.includes("calls cut off at close")), "and not counted as a call cut off");
    armed = false;
    chat = await open("close-race", 30_000);
    await until(() => answered(chat, "m2"), "the reopened chat sends it");
    await until(() => idle(chat), "idle after the reopen");
    assert.equal(sent("m2"), 1, "once");
    await chat.close();
    console.log(`ok: a close before the abort commits ends in ${ms} ms without counting the unsent request; the reopen sends it once`);
  }

  {
    // H1: Pi's Session fails while the chat's request is out: its answer
    // cannot be stored. The chat goes down: no retry or new turn in this
    // process, provider sessions released, the close without its grace.
    turns.length = 0;
    const chat = await open("down", 30_000);
    const released: string[] = [];
    const unregister = registerSessionResourceCleanup(id => { if (id) released.push(id); });
    try {
      const storage = chat.agent.storage as unknown as { commit: (...args: unknown[]) => Promise<unknown> };
      const commit = storage.commit.bind(storage);
      let broken = false;
      storage.commit = (...args) => broken ? Promise.reject(new Error(`disk I/O error (test) ${SECRET}`)) : commit(...args);
      onTurn = message => { if (message === "m1") broken = true; };
      const { lines } = await logged(async () => {
        const started = Date.now();
        await chat.send("m1 out", "r1");
        await until(() => chat.failure()?.startsWith("the chat stopped") ?? false, "the chat shown down");
        // The chat closes by itself, without the grace (30 s here): its
        // provider sessions are released before anyone calls close().
        await until(() => released.some(id => id.startsWith("optchat-")) && released.some(id => id.endsWith("-compact")), "the chat's and the compactor's provider sessions released");
        assert.ok(Date.now() - started < 6_000);
      });
      onTurn = () => {};
      await chat.close();
      const before = { turns: turns.length, compactions };
      await assert.rejects(chat.send("m2 after", "r2"), "the down chat takes no message");
      await delay(10 * RETRY_MS);
      assert.equal(sent("m1"), 1, "no retry is sent in the failed process");
      assert.deepEqual({ turns: turns.length, compactions }, before, "nothing is sent after the failure");
      assert.ok(lines.some(line => line.startsWith("error optchat chat session failed")), "the failure is logged");
      assert.ok(lines.some(line => line.startsWith("warn optchat pi reported an error")), "and Pi's own report of it reaches the log");
      assert.ok(!lines.join("").includes(SECRET), "without the secret");
      assert.ok(!chat.failure()!.includes(SECRET));
    } finally { unregister(); }
    console.log("ok: a failed Session takes the chat down at once: no retry, sessions released, logged without secrets");
  }

  {
    // A failure while the compactor's call is out (a provider that answers
    // only on the abort): the close cuts it off at once, without the grace
    // (30 s here), since nothing it answers could be stored.
    turns.length = 0;
    const chat = await open("down-bound", 30_000, true);
    holdCompactor = true;
    const held = compactions;
    for (let n = 10; compactions === held; n++) {
      assert.ok(n < 60, "the compactor was called");
      await chat.send(`m${n} out ${"word ".repeat(30)}`, `r${n}`);
      await until(async () => compactions > held || (await answered(chat, `m${n}`) && await idle(chat)), `m${n} answered`);
    }
    const storage = chat.agent.storage as unknown as { commit: (...args: unknown[]) => Promise<unknown> };
    storage.commit = () => Promise.reject(new Error("disk I/O error (test)"));
    const out = { turns: turns.length, compactions };
    const started = Date.now();
    await chat.send("m99 out", "r99").catch(() => {});
    await until(() => chat.failure()?.startsWith("the chat stopped") ?? false, "down");
    await chat.close();
    const ms = Date.now() - started;
    holdCompactor = false;
    assert.ok(ms < 6_000, `the failed chat closes within the settle and join bounds, not the 30 s grace (${ms} ms)`);
    assert.ok(compactorAborted > 0, "the compactor's call was cut off");
    await delay(10 * RETRY_MS);
    assert.equal(sent("m99"), 0, "a message whose acceptance failed is not sent");
    assert.deepEqual({ turns: turns.length, compactions }, out, "and nothing else is sent after the failure: no compactor retry");
    console.log(`ok: the failed chat's close cuts the compactor off at once (${ms} ms)`);
  }
  console.log("optchat fail closed: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
