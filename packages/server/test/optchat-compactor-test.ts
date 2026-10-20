/** OptChat's compactor failures and long messages over Pi, with a faux
 * model and small limits: a refusal, an empty answer or an input too long
 * for the compactor gives its node the source cut short (marked, the
 * message kept whole in the log) after one call, so the next turn runs; an
 * outage holds the node and the turn and never cuts; a long message is
 * logged in pages, numbered the same after a reopen; and a reopen whose log
 * would number its messages differently is refused. Offline and disposable;
 * no real provider. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { defineDoc } from "@earendil-works/pi-durable";
import { OptChat, type OptThreads } from "../src/optchat.ts";
import { compactNode } from "../src/optchat-compactor.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-compactor-"));
const blocks = (message: Message) => typeof message.content === "string" ? [message.content]
  : message.content.map(part => part.type === "text" ? part.text : "");
/** The compactor's message steps by the marker their message holds, and the longest input it got. */
const asked = new Map<string, number>();
let turns = 0, summaries = 0, longest = 0, outage = false;
const TOO_LONG = 40_000;
const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
faux.setResponses(Array.from({ length: 4_000 }, () => async request => {
  const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
  if (!system.includes("You write the memory of OptChat")) return fauxAssistantMessage(`ok ${++turns}`);
  const step = blocks(request.messages.find(message => message.role === "user")!).at(-1)!;
  // Only a message's own step: a merge holds its lines, a cut one too.
  const mark = step.startsWith("Compress") ? /\b(REFUSE|EMPTY|OUTAGE|HUGE)\b/.exec(step)?.[1] ?? "other" : "merge";
  asked.set(mark, (asked.get(mark) ?? 0) + 1);
  longest = Math.max(longest, step.length);
  if (step.length > TOO_LONG) return fauxAssistantMessage([], { stopReason: "error", errorMessage: "prompt is too long: 213462 tokens > 200000 maximum" });
  if (mark === "REFUSE") return fauxAssistantMessage([], { stopReason: "error", errorMessage: "The model refused to complete the request" });
  if (mark === "EMPTY") return fauxAssistantMessage("");
  if (mark === "OUTAGE" && outage) return fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service Unavailable" });
  const n = ++summaries;
  return fauxAssistantMessage([`user: s${n}`, `user: s${n} mid`, `user: summary ${n} long`].join("\n"));
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
const open = (name: string, page?: number) => OptChat.open({ directory: path.join(root, name), models, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }),
  threads, limits: { node: 64, retryMs: 50, watchMs: 50, ...page ? { page } : {} } });
async function until(check: () => boolean, what: string, ms = 4_000) {
  for (let k = 0; k * 10 < ms && !check(); k++) await delay(10);
  assert.ok(check(), what);
}
const busy = (chat: OptChat) => (chat as unknown as { busy: ReadonlySet<string> }).busy;
const quiet = async (chat: OptChat) => {
  await chat.agent.conversation.waitForIdle(BACKGROUND_CONTEXT);
  await until(() => chat.memory.settled() && chat.memory.ready(new Set(), 8).length === 0 && busy(chat).size === 0, "the tree is complete and stored");
};
const CUT = /^\(no summary, cut short: zoom it\) /;
/** The stored view, as optchat.ts defines it. A cubed before the shape
 * stores it with `Object.assign` of the fields it knows: `entry`, `shape`
 * and `shapeTotal` stay as a newer cubed left them while `total` grows. */
const ViewDoc = defineDoc<{ total: number; entry?: number; shape?: string; shapeTotal?: number }>({ kind: "cube.optchat.view", version: 1, scope: "session", initial: () => ({ total: 0 }) });
const view = (chat: OptChat) => chat.agent.conversation.commit(async tx => ({ ...await tx.doc(ViewDoc) }), BACKGROUND_CONTEXT);
/** Leaves the view's shape at `mark`, as an older cubed that wrote since would. */
const olderWrote = (chat: OptChat, mark: { entry?: number; shape?: string; shapeTotal?: number }) =>
  chat.agent.conversation.commit(async tx => { Object.assign(await tx.doc(ViewDoc), { entry: mark.entry, shape: mark.shape, shapeTotal: mark.shapeTotal }); }, BACKGROUND_CONTEXT);

/** An answer that is not three versions or one line (a heading before
 * them, a version broken over two lines, two lines) is never kept: the compactor is
 * told and asked again, and after TRIES such answers the node is its source
 * cut short. */
{
  const steps: string[] = [];
  const answers = fauxProvider({ tokensPerSecond: 1_000_000 });
  const long = (n: number) => `user: deploy to staging, then run the migrations on prod after review by Kari ${"v".repeat(n)}`;
  answers.setResponses([
    () => fauxAssistantMessage(["Here are the three versions, shortest first:", long(1), long(2), long(3)].join("\n")),
    () => fauxAssistantMessage(["user: deploy to staging and", "run the migrations on prod after review by Kari", long(1), long(2)].join("\n")),
    request => {
      steps.push(...request.messages.slice(2).flatMap(message => message.role === "user" ? blocks(message) : []));
      return fauxAssistantMessage(["user: staging, then prod", "user: deploy staging, then prod migrations", "user: deploy to staging, then prod migrations after Kari"].join("\n"));
    },
    ...Array.from({ length: 5 }, () => () => fauxAssistantMessage("I cannot summarize this message.\nPlease send it again.")),
  ]);
  const own = createModels();
  own.setProvider(answers.provider);
  const model = { provider: answers.getModel().provider, id: answers.getModel().id };
  const source = { message: `user: ${"deploy to staging, then run the migrations on prod after review by Kari. ".repeat(3)}` };
  assert.equal(await compactNode({ models: own, model, context: [], source, node: 64 }), "user: deploy to staging, then prod migrations after Kari", "only an answer of three versions is kept");
  assert.equal(steps.length, 2, "both answers not in the form were answered");
  assert.ok(steps.every(step => /not three versions/.test(step)), "and told so");
  assert.match(await compactNode({ models: own, model, context: [], source, node: 64 }), CUT, "after TRIES answers not in the form the source is cut short");
}

/** A message the compactor refuses or answers with nothing: one call, its
 * node the message cut short, and the next turn runs. */
for (const mark of ["REFUSE", "EMPTY"]) {
  const chat = await open(mark.toLowerCase());
  try {
    const before = turns;
    await chat.send(`${mark} ${"word ".repeat(30)}`, `${mark}-1`);
    await until(() => turns === before + 1, `${mark}: turn 1 ran`);
    await chat.send("next", `${mark}-2`);
    await until(() => turns === before + 2, `${mark}: the next turn runs`);
    assert.equal(asked.get(mark), 1, `${mark}: the compactor is asked once, not again and again`);
    const node = chat.memory.node(0, 0)!;
    assert.match(node, CUT, `${mark}: the node says it is cut`);
    assert.ok(node.includes(`user: ${mark} word word`), `${mark}: and holds the message's start`);
    assert.ok(Buffer.byteLength(node) <= 64, `${mark}: within the node limit`);
    assert.equal(chat.memory.zoom(0, 1), `0+0|user: ${mark} ${"word ".repeat(30)}`, `${mark}: the log keeps the message whole`);
    assert.equal(chat.failure(), null, `${mark}: nothing is left failing`);
    await quiet(chat);
  } finally { await chat.close(); }
  // A reopen keeps the cut node and asks nothing again.
  const again = await open(mark.toLowerCase());
  try {
    assert.match(again.memory.node(0, 0)!, CUT);
    await delay(200);
    assert.equal(asked.get(mark), 1, `${mark}: not asked again after a reopen`);
  } finally { await again.close(); }
}

/** An outage holds the node and the turn, never cuts, and both go on after it. */
{
  outage = true;
  const chat = await open("outage");
  try {
    const before = turns;
    await chat.send(`OUTAGE ${"word ".repeat(30)}`, "o-1");
    await until(() => turns === before + 1, "outage: turn 1 ran");
    await chat.send("next", "o-2");
    await until(() => (asked.get("OUTAGE") ?? 0) >= 3, "outage: retried");
    assert.equal(turns, before + 1, "outage: the next turn waits for the summary");
    assert.match(chat.failure() ?? "", /503/, "outage: the chat shows why it waits");
    assert.equal(chat.memory.built(0, 0), false, "outage: nothing is cut");
    outage = false;
    await until(() => turns === before + 2, "outage: the next turn runs once the compactor answers");
    assert.match(chat.memory.node(0, 0)!, /^user: summary \d+ long$/, "outage: a real summary");
    await quiet(chat);
  } finally { await chat.close(); }
}

/** A long message is logged in pages, each its own message and line, none
 * cut: the compactor never gets more than a page, and a reopen numbers
 * every page the same. */
{
  const huge = Array.from({ length: 2_500 }, (_, n) => `HUGE line ${n} ${"x".repeat(30)}`).join("\n");
  assert.ok(huge.length > 2.5 * 40_000);
  let chat = await open("huge");
  let log: string[];
  try {
    const before = turns;
    await chat.send(huge, "h-1");
    await until(() => turns === before + 1, "huge: turn 1 ran");
    await chat.send("next", "h-2");
    await until(() => turns === before + 2, "huge: the next turn runs", 8_000);
    await quiet(chat);
    log = chat.memory.messages.map(message => message.text);
    const pages = chat.memory.messages.filter(message => message.kind === "user" && message.text.includes("HUGE"));
    assert.ok(pages.length >= 4, `huge: logged as ${pages.length} pages`);
    assert.equal(pages.map(page => page.text).join(""), huge, "huge: the pages are the message whole, nothing cut");
    assert.ok(pages.every(page => page.text.length <= 30_000), "huge: each page at most 30,000 characters");
    assert.ok(longest <= TOO_LONG, `huge: the compactor got at most a page (${longest})`);
    for (let id = 0; id < chat.memory.length; id++) assert.doesNotMatch(chat.memory.node(0, id)!, CUT, `huge: line ${id} is a summary`);
  } finally { await chat.close(); }
  chat = await open("huge");
  try {
    assert.deepEqual(chat.memory.messages.map(message => message.text), log, "huge: a reopen numbers every page the same");
    await delay(200);
  } finally { await chat.close(); }
  // Logged in other pages, the log would number its messages differently
  // from its tree: the chat refuses to open rather than mix them up.
  await assert.rejects(open("huge", 10_000), /numbers its messages differently/, "huge: a changed log is refused");
  // An older cubed that wrote since numbered the log without pages, so
  // its view does not fit this log's pages: refused, by its own reason.
  chat = await open("huge");
  try {
    const mark = await view(chat);
    const before = turns;
    await chat.send("after the huge one", "h-3");
    await until(() => turns === before + 1, "huge: one more turn");
    await quiet(chat);
    await olderWrote(chat, mark);
    assert.ok((await view(chat)).total > mark.shapeTotal!, "huge: the view grew past its shape");
  } finally { await chat.close(); }
  await assert.rejects(open("huge"), /an older cubed numbered the chat's log without pages/, "huge: an older cubed's view over pages is refused");
}

/** Rolled back and forward again without a long message: an older cubed
 * grew the view's total and left its shape, and the chat still opens. */
{
  let chat = await open("rollback");
  let log: string[], mark: Awaited<ReturnType<typeof view>>;
  try {
    for (const [k, words] of [[1, 30], [2, 30]] as const) {
      const before = turns;
      await chat.send(`ROLLBACK ${k} ${"word ".repeat(words)}`, `r-${k}`);
      await until(() => turns === before + 1, `rollback: turn ${k} ran`);
    }
    await quiet(chat);
    mark = await view(chat);
    assert.ok(mark.shape !== undefined && mark.shapeTotal === mark.total, "rollback: the view is stored with its shape and count");
    for (const k of [3, 4]) {
      const before = turns;
      await chat.send(`ROLLBACK ${k} ${"word ".repeat(30)}`, `r-${k}`);
      await until(() => turns === before + 1, `rollback: turn ${k} ran`);
    }
    await quiet(chat);
    await olderWrote(chat, mark);
    assert.ok((await view(chat)).total > mark.shapeTotal!, "rollback: the view grew past its shape");
    log = chat.memory.messages.map(message => message.text);
  } finally { await chat.close(); }
  chat = await open("rollback");
  try {
    assert.deepEqual(chat.memory.messages.map(message => message.text), log, "rollback: opens, every message numbered the same");
    const before = turns;
    await chat.send(`ROLLBACK 5 ${"word ".repeat(30)}`, "r-5");
    await until(() => turns === before + 1, "rollback: turn 5 ran");
    await quiet(chat);
    const stored = await view(chat);
    assert.equal(stored.shapeTotal, stored.total, "rollback: the next node stores the shape again");
  } finally { await chat.close(); }
  chat = await open("rollback");
  await chat.close();
}

console.log("optchat compactor: ok");
