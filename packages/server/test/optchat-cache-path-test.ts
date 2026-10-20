/** OptChat's cache path end to end, offline: the real OptChat over pi-ai's
 * real Anthropic request builder, with fetch replaced by a fake Anthropic
 * that caches by the rules uniichat's cache.test.ts models (an entry is
 * written only at a mark, keyed by the prefix up to it, read walking back at
 * most 20 blocks from a mark, readable once its writer's response began).
 * Checks what would be sent: a turn's steps only append; a turn starts with
 * the last turn's view through its mark unless the memory merged since; a
 * reopen (idle, or with summaries running) changes nothing of it; the
 * system prompt changing rewrites once; turns mark the system, the view and
 * the end, compactions only the system and the view; no two calls write the
 * same prefix at once. The shares read are this model's, not a provider's:
 * no real cache is hit here. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { OptChat, type OptThreads } from "../src/optchat.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-cache-path-"));
process.env.ANTHROPIC_API_KEY = "sk-ant-test";
const LOOK = 20, FIRST_MS = 10;
const hash = (text: string) => crypto.createHash("sha256").update(text).digest("hex");
let seed = 11;
const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
const span = (a: number, b: number) => a * (b / a) ** rand();
const random = (bytes: number) => crypto.createHash("sha512").update(String(rand())).digest("base64").repeat(Math.ceil(bytes / 88)).slice(0, Math.ceil(bytes));

type Block = Record<string, unknown> & { cache_control?: unknown };
type Request = { kind: "turn" | "compaction"; blocks: string[]; marks: number[]; read: number; total: number; task: number; system: number; view: number; steps: number; merges: number };
const requests: Request[] = [];
/** Entries readable from, by key; and keys being written by a call whose response has not begun. */
const cache = new Map<string, number>();
const writing = new Map<string, number>();
let twice = 0;

function use(body: { model: string; tools?: unknown; thinking?: unknown; output_config?: unknown; system?: Block[]; messages: Array<{ role: string; content: string | Block[] }> }) {
  // A mark is where an entry ends, not part of what it holds.
  const bare = (blocks: unknown) => Array.isArray(blocks) ? blocks.map(({ cache_control: _, ...block }) => block) : blocks;
  const head = JSON.stringify([body.model, bare(body.tools), body.thinking, body.output_config]);
  const blocks: Block[] = [...body.system ?? [], ...body.messages.flatMap(message => (typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content).map(block => ({ ...block, role: message.role })))];
  const marks = blocks.flatMap((block, k) => block.cache_control ? [k] : []);
  assert.ok(marks.length <= 4, "a request takes at most four marks");
  const texts: string[] = [], keys: string[] = [], ends: number[] = [];
  for (const { cache_control: _, ...block } of blocks) {
    const text = JSON.stringify(block);
    texts.push(text);
    keys.push(hash((keys.at(-1) ?? head) + text));
    ends.push((ends.at(-1) ?? 0) + text.length);
  }
  const now = Date.now();
  const live = (k: number) => (cache.get(keys[k]!) ?? Infinity) <= now;
  let hit = -1;
  for (const mark of marks) for (let k = mark; k > mark - LOOK && k >= 0; k--) if (live(k)) { hit = Math.max(hit, k); break; }
  const written = marks.filter(mark => mark > hit && !live(mark));
  // A block another call is writing now, written again by this one.
  for (const mark of written) for (let k = mark; k > hit; k--) if (writing.has(keys[k]!)) { twice++; break; }
  for (const mark of written) writing.set(keys[mark]!, (writing.get(keys[mark]!) ?? 0) + 1);
  const view = blocks.findIndex(block => typeof block.text === "string" && block.text.endsWith("</chat>"));
  return {
    texts, marks, read: hit < 0 ? 0 : ends[hit]!, total: ends.at(-1)!, task: texts.at(-1)!.length, system: body.system?.length ?? 0, view,
    begun: () => {
      for (const mark of written) {
        const left = writing.get(keys[mark]!)! - 1;
        if (left) writing.set(keys[mark]!, left); else writing.delete(keys[mark]!);
        if (!cache.has(keys[mark]!)) cache.set(keys[mark]!, Date.now());
      }
    },
  };
}

const sse = (events: Array<{ type: string }>) => new TextEncoder().encode(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
const textOf = (content: string | Block[]) => typeof content === "string" ? content : content.map(block => typeof block.text === "string" ? block.text : "").join("");
let calls = 0;
globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init!.body));
  const compaction = JSON.stringify(body.system ?? "").includes("You write the memory of OptChat");
  const { begun, texts, ...measured } = use(body);
  // The turn's own input follows the view: "#steps=n" asks for n tool calls first.
  const input = textOf(body.messages.find((message: { role: string }) => message.role === "user").content).split("</chat>").at(-1)!;
  const steps = Number(/#steps=(\d+)/.exec(input)?.[1] ?? 0);
  const done = body.messages.filter((message: { role: string }) => message.role === "assistant").length;
  // The memory's merges so far, across opens, as this request is sent.
  requests.push({ kind: compaction ? "compaction" : "turn", blocks: texts, ...measured, steps: done, merges: base + (chat?.memory.merges ?? 0) });
  const tool = !compaction && done < steps;
  const n = ++calls;
  const line = (words: number) => `s${n} ${"word ".repeat(words)}`.trim();
  const block = tool ? { type: "tool_use", id: `toolu_${n}`, name: "projects", input: {} } : { type: "text", text: "" };
  const delta = tool ? { type: "input_json_delta", partial_json: "{}" }
    : { type: "text_delta", text: compaction ? [line(12), line(30), line(48 + n % 20)].join("\n") : `reply ${n} ${random(span(100, 2500))}` };
  const events = [
    { type: "message_start", message: { id: `msg_${n}`, model: body.model, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: block },
    { type: "content_block_delta", index: 0, delta },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } },
    { type: "message_stop" },
  ];
  return new Response(new ReadableStream<Uint8Array>({ start: async out => {
    await delay(FIRST_MS);
    begun();
    out.enqueue(sse(events.slice(0, 1)));
    await delay(span(10, 40));
    out.enqueue(sse(events.slice(1)));
    out.close();
  } }), { status: 200, headers: { "content-type": "text/event-stream" } });
}) as typeof fetch;

const models = createModels();
models.setProvider(anthropicProvider());
const threads: OptThreads = {
  async projects() { return `projects: ${random(span(80, 6000))}`; }, async runners() { return "no runners"; },
  async spawn() { throw new Error("unused"); }, async tell() {}, async describe() { return ""; },
  async events() { throw new Error("unused"); }, async history() { return null; },
};
const directory = path.join(root, "optchat");
const MODEL = process.env.CUBE_TEST_OPTCHAT_MODEL ?? "claude-opus-5-5";
const open = () => OptChat.open({ directory, models, model: async () => ({ provider: "anthropic", id: MODEL }), threads,
  limits: { view: 24_000, low: 12_000, compaction: 8_000, compactionLow: 4_000, retryMs: 50, watchMs: 50 } });
async function until(check: () => boolean, what: string) {
  for (let k = 0; k < 4000 && !check(); k++) await delay(5);
  assert.ok(check(), what);
}
const busy = (chat: OptChat) => (chat as unknown as { busy: ReadonlySet<string> }).busy;
const quiet = (chat: OptChat) => until(() => chat.memory.settled() && chat.memory.ready(new Set(), 8).length === 0 && busy(chat).size === 0, "the tree is complete");

/** Each turn's first request and what came before it. */
type Turn = { at: number; after: "turn" | "reopen" | "reopen-busy" | "system" };
const turns: Turn[] = [];
let chat!: OptChat;
let base = 0, sent = 0;
let middle: Request | undefined;
chat = await open();
const firsts = () => requests.flatMap((request, k) => request.kind === "turn" && request.steps === 0 ? [k] : []);
async function send(after: Turn["after"] = "turn") {
  const steps = Math.floor(rand() * 4);
  const count = firsts().length;
  await chat.send(`message ${sent++}: ${random(span(40, 1500))} #steps=${steps}`, `r${sent}`);
  await until(() => firsts().length > count, "the turn ran");
  turns.push({ at: firsts().at(-1)!, after });
  await chat.agent.conversation.waitForIdle(BACKGROUND_CONTEXT);
}
const reopen = async () => { base += chat.memory.merges; await chat.close(); chat = await open(); };
try {
  for (let k = 0; k < 60; k++) { await send(); await quiet(chat); }
  // Closed at rest, then while the turn's summaries run.
  await reopen();
  await send("reopen");
  await reopen();
  await send("reopen-busy");
  // Closed between a turn's tool steps: the run goes on after the reopen.
  {
    const count = requests.length;
    await chat.send(`message ${sent++}: ${random(400)} #steps=3`, `r${sent}`);
    await until(() => requests.slice(count).filter(request => request.kind === "turn").length >= 2, "two steps ran");
    middle = requests.slice(count).findLast(request => request.kind === "turn");
    await reopen();
    await until(() => requests.slice(count).filter(request => request.kind === "turn").length >= 4, "the turn went on after the reopen");
    await chat.agent.conversation.waitForIdle(BACKGROUND_CONTEXT);
  }
  for (let k = 0; k < 4; k++) await send();
  await quiet(chat);
  // A genuine edit: the user's instructions join the system prompt.
  fs.writeFileSync(path.join(directory, "AGENTS.md"), "Answer in English.\n");
  await send("system");
  for (let k = 0; k < 40; k++) { await send(); await quiet(chat); }
  await quiet(chat);
} finally { await chat.close(); }

const strip = (request: Request) => request.blocks;
const prefixOf = (a: string[], b: string[], n = a.length) => n <= b.length && a.slice(0, n).every((text, k) => text === b[k]);
const viewLines = (request: Request) => request.blocks.slice(request.system, request.view + 1).map(text => JSON.parse(text).text as string).join("").split("\n").slice(1, -1);

// Marks: a turn's request on the system, the last whole view block and its
// end; a compaction's on the system and the last whole view block only.
for (const request of requests) {
  const whole = request.view > request.system;
  if (!whole) continue;
  const expected = request.kind === "turn" ? [request.system - 1, request.view - 1, request.blocks.length - 1] : [request.system - 1, request.view - 1];
  assert.deepEqual(request.marks, expected, `${request.kind} marks`);
}

// A turn's steps only append to its first request.
for (let k = 1; k < requests.length; k++) {
  const request = requests[k]!;
  if (request.kind !== "turn" || request.steps === 0) continue;
  const previous = requests.slice(0, k).findLast(other => other.kind === "turn")!;
  assert.ok(prefixOf(strip(previous), strip(request)), "a tool step's request starts with the step before it, byte for byte");
  assert.equal(request.read, previous.total, "and reads all of it");
}

{
  const resumed = requests.slice(requests.indexOf(middle!) + 1).find(request => request.kind === "turn")!;
  // The step in flight is sent again as it was, or the next one follows it.
  assert.ok(resumed.steps >= middle!.steps && prefixOf(strip(middle!), strip(resumed)) && resumed.read === middle!.total, "a turn reopened between its steps goes on from the same bytes, read whole");
}

// A turn starts with the last turn's view through its mark, byte for byte
// (system prompt, tools and view blocks), and reads it, unless the memory
// merged in between or the system prompt changed; a reopen changes nothing.
/** Whether `next` is `last` with lines merged (never split) and lines after it. */
const spans = (lines: string[]) => lines.map(line => { const [id, n] = line.slice(0, line.indexOf("|")).split("+").map(Number); return [id!, id! + n!] as const; });
const coarsens = (last: string[], next: string[]) => {
  const outer = spans(next);
  return spans(last).every(([a, b]) => outer.some(([c, d]) => c <= a && b <= d)) && outer.every(([c], k) => k === 0 ? c === 0 : c === outer[k - 1]![1]);
};
let rewrites = 0;
for (let k = 1; k < turns.length; k++) {
  const turn = turns[k]!, request = requests[turn.at]!, previous = requests[turns[k - 1]!.at]!;
  // Its last whole view block, or (a view under one block) its system prompt.
  const mark = previous.view > previous.system ? previous.view - 1 : previous.system - 1;
  const extends_ = prefixOf(viewLines(previous), viewLines(request));
  if (turn.after === "system") {
    assert.ok(!prefixOf(strip(previous), strip(request), previous.system), "the new instructions are in the system prompt");
    assert.ok(request.read === 0 && extends_, "a changed system prompt rewrites the request once, the view is as it was");
    continue;
  }
  if (!extends_) {
    assert.ok(coarsens(viewLines(previous), viewLines(request)), `turn ${k}: a rewritten view only merges the last one's lines`);
    rewrites++;
    continue;
  }
  assert.ok(prefixOf(strip(previous), strip(request), mark + 1), `turn ${k} (${turn.after}): the last turn's marked prefix leads, byte for byte`);
  assert.ok(request.read >= strip(previous).slice(0, mark + 1).reduce((sum, text) => sum + text.length, 0), `turn ${k} (${turn.after}): and is read`);
}
assert.ok(requests.at(-1)!.merges > 0, "batches happened");
assert.ok(rewrites >= 1 && rewrites <= turns.length / 8, `a batch rewrote the view, rarely (${rewrites} of ${turns.length} turns)`);
assert.equal(twice, 0, "no two calls wrote the same prefix at once");

const share = (kind: Request["kind"]) => {
  const list = requests.filter(request => request.kind === kind);
  const task = (request: Request) => kind === "compaction" ? request.task : 0;
  return list.reduce((sum, request) => sum + Math.min(request.read, request.total - task(request)), 0) / list.reduce((sum, request) => sum + request.total - task(request), 0);
};
const turnShare = share("turn"), compactionShare = share("compaction");
console.log(`optchat cache path: ${turns.length} turns (${rewrites} rewritten by a batch), ${requests.length} requests, read ${(100 * turnShare).toFixed(1)}% of turns and ${(100 * compactionShare).toFixed(1)}% of compactions but their task (modelled, not measured)`);
// At these small marks a batch rewrites a larger share; at the real ones (128 KB) the same model reads about 97%.
assert.ok(turnShare >= 0.85, "turns read at least 85% of their input in this model");
assert.ok(compactionShare >= 0.85, "compactions read at least 85% of their input but their task in this model");
fs.rmSync(root, { recursive: true, force: true });
console.log("optchat cache path: ok");
