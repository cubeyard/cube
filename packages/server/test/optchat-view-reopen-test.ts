/** OptChat's batched view over Pi, with a faux model and small marks: turns
 * between batches see the last turn's view as a prefix of theirs, a batch
 * merges the view down to its low mark at once, and a reopen goes on from
 * the view it had and zooms every line down to its message. Offline and
 * disposable. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { OptChat, type OptThreads } from "../src/optchat.ts";
import { bytes } from "../src/optchat-memory.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-view-"));
const blocks = (message: Message) => typeof message.content === "string" ? [message.content]
  : message.content.map(part => part.type === "text" ? part.text : "");
const views: string[] = [];
let compactions = 0;
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 4_000 }, () => async request => {
  const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
  if (system.includes("You write the memory of OptChat")) return fauxAssistantMessage(`summary ${++compactions} ${"s".repeat(30)}`);
  const user = blocks(request.messages.find(message => message.role === "user")!);
  const view = user.slice(0, user.findIndex(block => block.endsWith("</chat>")) + 1).join("");
  assert.match(view, /^<chat>\n/);
  views.push(view);
  return fauxAssistantMessage(`reply ${views.length}`);
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
const HIGH = 1_600, LOW = 800;
const open = () => OptChat.open({ directory: path.join(root, "optchat"), models, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }),
  threads, limits: { view: HIGH, low: LOW, node: 64, retryMs: 50, watchMs: 50 } });
async function until(check: () => boolean, what: string) {
  for (let k = 0; k < 1500 && !check(); k++) await delay(10);
  assert.ok(check(), what);
}
/** The chat is quiet: its turn ended, its log holds `messages`, and every
 * node build has finished, the stored view's commit included (a build
 * leaves the busy set only after it). No sleeps. */
const quiet = async (chat: OptChat, messages: number) => {
  await chat.agent.conversation.waitForIdle(BACKGROUND_CONTEXT);
  const busy = (chat as unknown as { busy: ReadonlySet<string> }).busy;
  await until(() => chat.memory.length === messages && chat.memory.settled() && chat.memory.ready(new Set(), 8).length === 0 && busy.size === 0, "the tree is complete and stored");
};
const lines = (view: string) => view.split("\n").slice(1, -1);

/** Counts batches as they close, beside the service's own listener. */
function countBatches(chat: OptChat): () => number {
  let closed = 0, merges = chat.memory.merges;
  const notify = chat.memory.onChange;
  chat.memory.onChange = () => {
    if (chat.memory.merges !== merges && !chat.memory.batching) closed++;
    merges = chat.memory.merges;
    notify();
  };
  return () => closed;
}

let chat = await open();
let rendered: string;
try {
  const batches = countBatches(chat);
  let rewrites = 0;
  for (let n = 0; n < 40; n++) {
    await chat.send(`message ${n}: ${"word ".repeat(20)}`, `r${n}`);
    await until(() => views.length === n + 1, `turn ${n} ran`);
    await quiet(chat, 2 * (n + 1));
    assert.ok(bytes(lines(views[n]!).join("\n")) < HIGH, "a turn's view is at most the high mark");
    if (n === 0) continue;
    const [before, after] = [lines(views[n - 1]!), lines(views[n]!)];
    if (after.slice(0, before.length).join("\n") === before.join("\n")) continue;
    // Not a prefix: a batch merged the view down to its low mark, plus the
    // lines of the last turn.
    rewrites++;
    assert.ok(bytes(after.join("\n")) < LOW + 400, `a batch leaves the view at its low mark (${bytes(after.join("\n"))})`);
  }
  assert.ok(rewrites >= 2, `the chat went through batches (${rewrites})`);
  assert.ok(rewrites <= batches(), `only a batch rewrites the view (${rewrites} rewrites, ${batches()} batches)`);
  assert.ok(chat.memory.bytes <= HIGH);
  rendered = chat.memory.render();
} finally { await chat.close(); }

chat = await open();
try {
  assert.equal(chat.memory.render(), rendered, "a reopen restores the view it had");
  assert.ok(chat.memory.view.some(part => part.l >= 2), "with coarse lines");
  // Every line opens down to its message, word for word.
  for (const part of chat.memory.view) {
    const id = part.i * 2 ** part.l;
    let n = 2 ** part.l;
    while (n > 1) {
      const halves = chat.memory.zoom(id, n).split("\n");
      assert.equal(halves.length, 2);
      assert.ok(!halves.some(half => half.includes("not summarized")));
      n /= 2;
    }
    assert.match(chat.memory.zoom(id, 1), new RegExp(`^${id}\\+0\\|(user: message \\d+:|talk: reply \\d+)`));
  }
  const count = views.length;
  await chat.send("after the reopen", "r-after");
  await until(() => views.length === count + 1, "a turn after the reopen ran");
  assert.deepEqual(lines(views.at(-1)!).slice(0, lines(rendered).length), lines(rendered), "the first turn after a reopen reads the stored view as its prefix");
  await quiet(chat, 82);
} finally { await chat.close(); fs.rmSync(root, { recursive: true, force: true }); }

console.log("optchat view reopen: ok");
