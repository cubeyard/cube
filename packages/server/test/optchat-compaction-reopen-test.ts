/** OptChat's compaction view over Pi, with a faux model and small marks: the
 * compactor reads its own view (never a placeholder, at most its high mark),
 * a turn's messages are compressed side by side, and a reopen restores the
 * stored compaction view. Offline and disposable. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { OptChat, type OptThreads } from "../src/optchat.ts";
import { bytes, PLACEHOLDER, type Part } from "../src/optchat-memory.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-compaction-"));
const blocks = (message: Message) => typeof message.content === "string" ? [message.content]
  : message.content.map(part => part.type === "text" ? part.text : "");
const contexts: string[][] = [];
let turns = 0, compactions = 0, running = 0, side = 0;
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 4_000 }, () => async request => {
  const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
  if (!system.includes("You write the memory of OptChat")) return fauxAssistantMessage(`reply ${++turns} ${"r".repeat(80)}`);
  const parts = blocks(request.messages.find(message => message.role === "user")!);
  const chat = parts.slice(0, -1).join("");
  assert.match(chat, /^<chat>\n[^]*<\/chat>$/);
  contexts.push(chat.split("\n").slice(1, -1));
  if (parts.at(-1)!.startsWith("Compress this message")) {
    // Until two have met, each waits up to a second for another to start.
    running++;
    side = Math.max(side, running);
    for (let k = 0; k < 100 && side < 2; k++) { await delay(10); side = Math.max(side, running); }
    running--;
  }
  return fauxAssistantMessage(`summary ${++compactions} ${"s".repeat(30)}`);
}));
const models = createModels();
models.setProvider(faux.provider);
const threads: OptThreads = {
  async projects() { return "projects: cube"; },
  async runners() { return "no runners"; },
  async spawn() { throw new Error("unused"); },
  async tell() {},
  async describe() { return ""; },
  async events() { throw new Error("unused"); },
  async history() { return null; },
};
const HIGH = 400, LOW = 200;
const open = () => OptChat.open({ directory: path.join(root, "optchat"), models, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }),
  threads, limits: { view: 1_600, low: 800, compaction: HIGH, compactionLow: LOW, node: 64, retryMs: 50, watchMs: 50 } });
async function until(check: () => boolean, what: string) {
  for (let k = 0; k < 1500 && !check(); k++) await delay(10);
  assert.ok(check(), what);
}
const quiet = async (chat: OptChat, messages: number) => {
  await chat.agent.conversation.waitForIdle(BACKGROUND_CONTEXT);
  const busy = (chat as unknown as { busy: ReadonlySet<string> }).busy;
  await until(() => chat.memory.length === messages && chat.memory.settled() && chat.memory.ready(new Set(), 8).length === 0 && busy.size === 0, "the tree is complete and stored");
};
const copy = (parts: readonly Part[]) => parts.map(part => ({ ...part }));

let chat = await open();
let compaction: Part[], view: Part[];
try {
  for (let n = 0; n < 30; n++) {
    await chat.send(`message ${n}: ${"word ".repeat(20)}`, `r${n}`);
    await until(() => turns === n + 1, `turn ${n} ran`);
    await quiet(chat, 2 * (n + 1));
    assert.ok(chat.memory.compactionBytes <= HIGH, `the compaction view is at most its high mark (${chat.memory.compactionBytes})`);
  }
  assert.ok(chat.memory.merges > 0, "the chat's view went through a batch");
  assert.ok(chat.memory.compaction.length < chat.memory.view.length, "the compaction view is coarser than the chat's");
  compaction = copy(chat.memory.compaction);
  view = copy(chat.memory.view);
} finally { await chat.close(); }
assert.ok(contexts.every(lines => !lines.includes(PLACEHOLDER)), "a compaction never sees a placeholder");
assert.ok(contexts.every(lines => bytes(lines.join("\n")) + 1 <= HIGH), "nor reads more than the compaction view's high mark");
assert.ok(side >= 2, `a turn's messages are compressed side by side (${side} at once)`);

chat = await open();
try {
  assert.deepEqual(chat.memory.view, view, "a reopen restores the view");
  assert.deepEqual(chat.memory.compaction, compaction, "and the compaction view as it was stored");
  await chat.send("after the reopen", "r-after");
  await until(() => turns === 31, "a turn after the reopen ran");
  await quiet(chat, 62);
} finally { await chat.close(); fs.rmSync(root, { recursive: true, force: true }); }

console.log("optchat compaction reopen: ok");
