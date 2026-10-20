/** G4: a node's commit stored, its view's commit failed (as a crash
 * between the two would leave it). A reopen restores the older stored view
 * and goes on from it with the nodes stored since: the turns after it send
 * the very views the uninterrupted chat sends, so the fault costs no cache
 * write (the review's bound was one). Faux model, small marks, disposable
 * state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { OptChat, type OptThreads } from "../src/optchat.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-fault-"));
const blocks = (message: Message) => typeof message.content === "string" ? [message.content]
  : message.content.map(part => part.type === "text" ? part.text : "");
const views: string[] = [];
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 4_000 }, () => async request => {
  const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
  // The summary depends only on what it summarizes, so both chats build the same nodes.
  if (system.includes("You write the memory of OptChat")) return fauxAssistantMessage(`summary of ${JSON.stringify(request.messages.at(-1)).length} ${"s".repeat(30)}`);
  const user = blocks(request.messages.find(message => message.role === "user")!);
  views.push(user.slice(0, user.findIndex(block => block.endsWith("</chat>")) + 1).join(""));
  return fauxAssistantMessage(`reply to ${/message (\d+):/.exec(JSON.stringify(request.messages.at(-1)))?.[1]}`);
}));
const models = createModels();
models.setProvider(faux.provider);
const threads: OptThreads = {
  async projects() { return "projects: cube"; }, async runners() { return "no runners"; },
  async spawn() { throw new Error("unused"); }, async tell() {}, async describe() { return ""; },
  async events() { throw new Error("unused"); }, async history() { return null; },
};
const open = (name: string) => OptChat.open({ directory: path.join(root, name), models, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }),
  threads, limits: { view: 1_600, low: 800, node: 64, retryMs: 50, watchMs: 50 } });
async function until(check: () => boolean, what: string) {
  for (let k = 0; k < 1500 && !check(); k++) await delay(10);
  assert.ok(check(), what);
}
const quiet = async (chat: OptChat, messages: number) => {
  await chat.agent.conversation.waitForIdle(BACKGROUND_CONTEXT);
  const busy = (chat as unknown as { busy: ReadonlySet<string> }).busy;
  await until(() => chat.memory.length === messages && chat.memory.settled() && chat.memory.ready(new Set(), 8).length === 0 && busy.size === 0, "the tree is complete");
};
const lines = (view: string) => view.split("\n").slice(1, -1);
const prefixOf = (before: string, after: string) => lines(after).slice(0, lines(before).length).join("\n") === lines(before).join("\n");

/** Makes every commit that writes the stored view fail while `failing()`. */
function failViews(chat: OptChat, failing: () => boolean): () => number {
  type Tx = { doc: (token: { definition: { kind: string } }, ...rest: unknown[]) => unknown };
  const harness = (chat as unknown as { harness: { commit: (fn: (tx: Tx) => unknown, context: unknown) => Promise<unknown> } }).harness;
  const commit = harness.commit.bind(harness);
  // Transactions keep private fields: their methods run on the transaction itself.
  const bound = (target: Tx, key: string | symbol) => { const value = Reflect.get(target, key); return typeof value === "function" ? value.bind(target) : value; };
  let failed = 0;
  harness.commit = (fn, context) => commit(tx => fn(new Proxy(tx, { get: (target, key) => key !== "doc" ? bound(target, key) : (token: { definition: { kind: string } }, ...rest: unknown[]) => {
    if (failing() && token.definition.kind === "cube.optchat.view") { failed++; throw new Error("injected: the view's commit fails"); }
    return target.doc(token, ...rest);
  } })), context);
  return () => failed;
}

const TURNS = 24, CUT = 16, AFTER = 6;
/** Runs turns `from`..`to` - 1; returns their views. */
async function turns(chat: OptChat, from: number, to: number): Promise<string[]> {
  const start = views.length;
  for (let n = from; n < to; n++) {
    await chat.send(`message ${n}: ${"word ".repeat(20)}`, `r${n}`);
    await until(() => views.length === start + n - from + 1, `turn ${n} ran`);
    await quiet(chat, 2 * (n + 1));
  }
  return views.slice(start);
}

try {
  // The chat without a fault, for comparison.
  let chat = await open("clean");
  const clean = await turns(chat, 0, TURNS + AFTER);
  await chat.close();

  // The same chat, whose view's commits fail from turn CUT on, then reopened.
  chat = await open("fault");
  let failing = false;
  const failed = failViews(chat, () => failing);
  const before = await turns(chat, 0, CUT);
  assert.deepEqual(before, clean.slice(0, CUT), "the same turns as the clean chat");
  failing = true;
  const during = await turns(chat, CUT, TURNS);
  assert.deepEqual(during, clean.slice(CUT, TURNS), "a failed view commit changes nothing while the chat runs");
  assert.ok(failed() > 0, `nodes were built while the view's commit failed (${failed()})`);
  await chat.close();

  chat = await open("fault");
  try {
    const after = await turns(chat, TURNS, TURNS + AFTER);
    assert.deepEqual(after, clean.slice(TURNS), "after the reopen, every turn sends the view the clean chat sent: no view is written again");
    assert.ok(after.some((view, k) => !prefixOf(k ? after[k - 1]! : during.at(-1)!, view)) || lines(after.at(-1)!).length > lines(during.at(-1)!).length, "the turns after the reopen went on growing or merging the view");
    console.log(`optchat view fault: ok (${failed()} view commits failed, then a reopen; the next ${AFTER} turns sent the clean chat's views)`);
  } finally { await chat.close(); }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
