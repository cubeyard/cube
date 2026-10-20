/** OptChat's prompt caching through pi-ai's real Anthropic and Codex request
 * builders: fetch is replaced, so what would go on the wire is captured and
 * nothing leaves the process. The view goes in blocks of four lines; an
 * Anthropic request marks the last system block, the last whole view block
 * and its end, and a call waits while another writes its marked prefix.
 * Codex gets the chat's prompt_cache_key and the system prompt as its
 * instructions, ahead of the view. */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";
import { createModels, type Message, type Tool } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { streamSimple as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { cachedModels, markViewPieces, viewPieces } from "../src/optchat-cache.ts";
import { compactNode } from "../src/optchat-compactor.ts";
import { withView } from "../src/optchat.ts";

const line = (n: number) => `${n}+1|user: ${"x".repeat(240)} ${n}`;
const render = (lines: number, from = 0) => `<chat>\n${Array.from({ length: lines }, (_, n) => line(from + n) + "\n").join("")}</chat>`;
const short = (n: number) => `${n}+1|l${n}`;
const small = (lines: number) => `<chat>\n${Array.from({ length: lines }, (_, n) => short(n) + "\n").join("")}</chat>`;

assert.deepEqual(viewPieces(small(10)), [
  "<chat>\n0+1|l0\n1+1|l1\n2+1|l2\n3+1|l3\n",
  "4+1|l4\n5+1|l5\n6+1|l6\n7+1|l7\n",
  "8+1|l8\n9+1|l9\n</chat>",
]);
assert.deepEqual(viewPieces(small(8)), ["<chat>\n0+1|l0\n1+1|l1\n2+1|l2\n3+1|l3\n", "4+1|l4\n5+1|l5\n6+1|l6\n7+1|l7\n", "</chat>"]);
assert.deepEqual(viewPieces(small(3)), [small(3)]);
assert.deepEqual(viewPieces(small(0)), ["<chat>\n</chat>"]);
for (const lines of [0, 3, 4, 10, 500]) assert.equal(viewPieces(render(lines)).join(""), render(lines));
assert.equal(markViewPieces({ messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }), undefined, "only a view is marked");

const tool: Tool = { name: "zoom", description: "open a line", parameters: { type: "object", properties: {} } as never };
const request = (view: string): Message[] => withView([
  { role: "user", content: "what did I say?", timestamp: 1 },
  { role: "system", content: "", sections: { master: "You are OptChat." }, toolsAdded: [tool], timestamp: 1 },
], viewPieces(view));
assert.equal(request(small(3))[0]!.role, "system", "the system baseline leads the request");

type Captured = { url: string; headers: Headers; body: Record<string, unknown> };
const bodies: Captured[] = [];
let respond: (captured: Captured, signal?: AbortSignal | null) => Response | Promise<Response> = () =>
  new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }), { status: 400, headers: { "content-type": "application/json" } });
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const raw = init?.body ?? (input instanceof Request ? await input.text() : "");
  // Codex sends its body zstd-compressed.
  const text = raw instanceof Uint8Array ? (headers.get("content-encoding") === "zstd" ? zstdDecompressSync(raw) : Buffer.from(raw)).toString("utf8") : String(raw);
  const captured = { url, headers, body: JSON.parse(text) };
  bodies.push(captured);
  return respond(captured, init?.signal);
}) as typeof fetch;

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openaiCodexProvider());
const cached = cachedModels(models, () => "optchat-test");
const model = models.getModels("anthropic").find(candidate => candidate.api === "anthropic-messages")!;
assert.ok(model, "an Anthropic model in the catalog");

type Body = { system: Array<{ text: string; cache_control?: unknown }>; tools: Array<{ cache_control?: unknown }>; messages: Array<{ role: string; content: Array<{ text?: string; cache_control?: unknown }> }> };
const anthropic = async (messages: Message[], apiKey = "sk-ant-test") => {
  await cached.completeSimple(model, { messages }, { apiKey, maxRetries: 0 });
  return bodies.pop()!.body as unknown as Body;
};
const marked = (blocks: Array<{ cache_control?: unknown }>) => blocks.flatMap((block, k) => block.cache_control ? [k] : []);
const marks = (body: Body) => JSON.stringify(body).split('"cache_control"').length - 1;

{
  const body = await anthropic(request(render(500)));
  const first = body.messages[0]!;
  assert.equal(first.role, "user");
  assert.equal(first.content.length, 127);
  assert.equal(first.content.slice(0, 126).map(block => block.text).join(""), render(500), "the view goes as its blocks");
  assert.equal(first.content[125]!.text, "</chat>");
  assert.deepEqual(marked(first.content), [124, 126], "the last whole block and the request end");
  assert.deepEqual(marked(body.system), [0]);
  assert.deepEqual(marked(body.tools), []);
  assert.equal(marks(body), 3);
  assert.ok(body.system[0]!.text.includes("You are OptChat."), "the system prompt is the system prompt");

  const oauth = await anthropic(request(render(500)), "sk-ant-oat01-test");
  assert.equal(oauth.system.length, 2);
  assert.match(oauth.system[0]!.text, /Claude Code/);
  assert.deepEqual(marked(oauth.system), [1], "only the last system block");
  assert.deepEqual(marked(oauth.tools), []);
  assert.deepEqual(marked(oauth.messages[0]!.content), [124, 126]);
  assert.equal(marks(oauth), 3);

  const plain = await anthropic(request(small(3)));
  assert.deepEqual(marked(plain.system), [0], "a view without a whole block keeps pi-ai's own marks");
  assert.deepEqual(marked(plain.tools), [0]);
  assert.deepEqual(marked(plain.messages[0]!.content), [1]);
}

for (const lines of [9, 100, 500]) {
  const turn = await anthropic(request(render(lines)));
  const mark = marked(turn.messages[0]!.content)[0]!;
  for (const k of [1, 3, 4, 40, 79, 80]) {
    const next = await anthropic(request(render(lines + k)));
    assert.deepEqual(next.tools, turn.tools);
    assert.deepEqual(next.system, turn.system);
    const texts = (body: Body) => body.messages[0]!.content.slice(0, mark + 1).map(block => block.text);
    assert.deepEqual(texts(next), texts(turn), `${lines} lines: the marked prefix leads ${lines + k}`);
    assert.ok(marked(next.messages[0]!.content)[0]! - mark <= 20, `${lines} + ${k} lines: within 20 blocks of the earlier mark`);
  }
}

{
  process.env.ANTHROPIC_API_KEY = "sk-ant-test";
  await assert.rejects(compactNode({ models: cachedModels(models, () => "optchat-test-compact", { task: false }), model, context: Array.from({ length: 100 }, (_, n) => line(n)), source: { message: "hello" } }), /captured/);
  const body = bodies.pop()!.body as unknown as Body;
  const content = body.messages[0]!.content;
  assert.equal(content.slice(0, 26).map(block => block.text).join(""), render(100));
  assert.deepEqual(marked(content), [24], "the compactor's context carries a view mark; its task none");
  assert.deepEqual(marked(body.system), [0]);
  assert.equal(marks(body), 2);
}

{
  type Held = { body: Captured; release: (response: Response | Error) => void };
  const held: Held[] = [];
  const order: string[] = [];
  const view = (body: Captured) => ((body.body as unknown as Body).messages[0]!.content[0]!.text ?? "").slice(7, 20);
  respond = captured => new Promise<Response>((resolve, reject) => {
    order.push(`fetch ${view(captured)}`);
    held.push({ body: captured, release: response => response instanceof Error ? reject(response) : resolve(response) });
  });
  const until = async (test: () => boolean) => { for (let k = 0; k < 200 && !test(); k++) await sleep(5); assert.ok(test()); };
  const call = (view: string, signal?: AbortSignal) =>
    cached.completeSimple(model, { messages: request(view) }, { apiKey: "sk-ant-test", maxRetries: 0, ...(signal ? { signal } : {}) }).then(reply => { order.push(`end ${view.slice(7, 20)}`); return reply; });
  let body!: ReadableStreamDefaultController<Uint8Array>;
  const open = () => new Response(new ReadableStream<Uint8Array>({ start: controller => { body = controller; } }), { status: 200, headers: { "content-type": "text/event-stream" } });

  const a = call(render(100)), b = call(render(101));
  await until(() => held.length === 1);
  await sleep(30);
  assert.deepEqual(order, ["fetch 0+1|user: xxx"], "the second call waits for the writer");
  held.shift()!.release(open());
  await sleep(30);
  assert.deepEqual(order, ["fetch 0+1|user: xxx"], "the writer's headers alone do not let it go: the entry is not readable yet");
  body.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_1", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`));
  await until(() => held.length === 1);
  assert.deepEqual(order, ["fetch 0+1|user: xxx", "fetch 0+1|user: xxx"], "it goes once the writer's response begins, before its end");
  body.close();
  held.shift()!.release(new Response("{}", { status: 400 }));
  await Promise.all([a, b]);
  order.length = 0;

  const c = call(render(100)), d = call(render(100, 1));
  await until(() => held.length === 2);
  assert.deepEqual(order, ["fetch 0+1|user: xxx", "fetch 1+1|user: xxx"], "different prefixes do not wait");
  for (const { release } of held.splice(0)) release(new Response("{}", { status: 400 }));
  await Promise.all([c, d]);
  order.length = 0;

  // A prefix whose writer began is cached for a while: other views below.
  const e = call(render(100, 2)), f = call(render(100, 2));
  await until(() => held.length === 1);
  held.shift()!.release(new Error("connection reset"));
  await until(() => held.length === 1);
  assert.deepEqual(order, ["fetch 2+1|user: xxx", "end 2+1|user: xxx", "fetch 2+1|user: xxx"], "a failed writer releases the waiter, which then leads");
  held.shift()!.release(new Response("{}", { status: 400 }));
  await Promise.all([e, f]);
  order.length = 0;

  const abort = new AbortController();
  const g = call(render(100, 3)), h = call(render(100, 3), abort.signal);
  await until(() => held.length === 1);
  abort.abort();
  const aborted = await h;
  assert.equal(aborted.stopReason, "aborted", "an aborted waiter stops waiting");
  assert.equal(held.length, 1, "while the writer still holds the prefix");
  held.shift()!.release(new Response("{}", { status: 400 }));
  await g;
  order.length = 0;

  // A call whose prefix starts with one being written waits for it as well
  // (uniichat's AskAI.wait), then writes only the rest; another prefix does not.
  const begin = () => body.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_2", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`));
  const i = call(render(100, 4)), j = call(render(108, 4)), k = call(render(100, 5));
  await until(() => held.length === 2);
  await sleep(30);
  assert.deepEqual(order, ["fetch 4+1|user: xxx", "fetch 5+1|user: xxx"], "the longer view waits on the writer of its start");
  for (const other of held.splice(1)) other.release(new Response("{}", { status: 400 }));
  held.shift()!.release(open());
  begin();
  await until(() => held.length === 1);
  const longer = held[0]!.body.body as unknown as Body;
  assert.deepEqual(marked(longer.messages[0]!.content), [26, 28], "it marks its own last whole block, within 20 blocks of the written one");
  body.close();
  held.shift()!.release(new Response("{}", { status: 400 }));
  await Promise.all([i, j, k]);
  order.length = 0;

  // Once a prefix is written, a call of it or of a start of it does not wait.
  const m = call(render(100, 4)), n = call(render(100, 4));
  await until(() => held.length === 2);
  for (const other of held.splice(0)) other.release(new Response("{}", { status: 400 }));
  await Promise.all([m, n]);
  respond = () => new Response("{}", { status: 400 });
}

{
  // While the compactor's system prompt is not cached, a call of a view
  // under one whole block waits for a call writing it too (Anthropic writes
  // an entry at the system mark), and keeps no mark on its task.
  const order: string[] = [];
  const streams: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  respond = captured => {
    const body = captured.body as unknown as Body;
    order.push(`fetch ${body.messages[0]!.content.length} marks ${JSON.stringify(marked(body.messages[0]!.content))}`);
    return new Response(new ReadableStream<Uint8Array>({ start: controller => { streams.push(controller); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const compactor = cachedModels(models, () => "optchat-test-cold", { task: false });
  const options = { apiKey: "sk-ant-test", maxRetries: 0 };
  const a = compactor.completeSimple(model, { messages: request(render(9)) }, options);
  const b = compactor.completeSimple(model, { messages: request(small(2)) }, options);
  for (let k = 0; k < 200 && order.length < 1; k++) await sleep(5);
  await sleep(30);
  assert.deepEqual(order, ["fetch 4 marks [1]"], "the short view waits while the system prompt is written");
  streams[0]!.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_3", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`));
  for (let k = 0; k < 200 && order.length < 2; k++) await sleep(5);
  assert.deepEqual(order, ["fetch 4 marks [1]", "fetch 2 marks []"], "then goes, its task unmarked");
  for (const stream of streams) stream.error(new Error("done"));
  await Promise.all([a, b]);
  bodies.length = 0;
  respond = () => new Response("{}", { status: 400 });
}

{
  // Codex is an OAuth-only provider: its request builder is called directly,
  // behind the same wrapper, with a token shaped like ChatGPT's.
  const model = models.getModels("openai-codex")[0]!;
  assert.ok(model, "a Codex model in the catalog");
  const direct = { streamSimple: (m: never, c: never, o: never) => codexStream(m, c, o), completeSimple: async (m: never, c: never, o: never) => codexStream(m, c, o).result() } as unknown as typeof models;
  const claim = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } })).toString("base64url");
  const big = render(500);
  await cachedModels(direct, () => "optchat-test").completeSimple(model, { messages: request(big) }, { apiKey: `x.${claim}.y`, transport: "sse", maxRetries: 0 });
  const captured = bodies.pop()!;
  assert.ok(captured, "the Codex request was built");
  assert.equal(captured.body.prompt_cache_key, "optchat-test", "the chat's cache key");
  assert.equal(captured.headers.get("session-id"), "optchat-test");
  assert.match(String(captured.body.instructions), /You are OptChat\./, "the system prompt is Codex's instructions");
  const input = captured.body.input as Array<{ role?: string; content?: Array<{ text?: string }> }>;
  assert.equal(input[0]!.content!.slice(0, 126).map(part => part.text).join(""), big, "the view leads the input, so turns share its prefix");
  assert.equal(captured.body.store, false);
  assert.ok(!JSON.stringify(captured.body).includes("cache_control"));

  // Single flight holds for Codex too: a compaction whose view starts with
  // one being written waits until that one's first stream event.
  const order: string[] = [];
  const streams: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  respond = captured => {
    const input = (captured.body.input as Array<{ content?: Array<{ text?: string }> }>)[0]!.content!;
    order.push(`fetch ${input.length}`);
    return new Response(new ReadableStream<Uint8Array>({ start: controller => { streams.push(controller); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const compactor = cachedModels(direct, () => "optchat-test-compact", { task: false });
  const options = { apiKey: `x.${claim}.y`, transport: "sse" as const, maxRetries: 0 };
  const a = compactor.completeSimple(model, { messages: request(render(100, 6)) }, options);
  const b = compactor.completeSimple(model, { messages: request(render(108, 6)) }, options);
  for (let k = 0; k < 200 && order.length < 1; k++) await sleep(5);
  await sleep(30);
  assert.deepEqual(order, ["fetch 27"], "the longer view waits while the shorter is written");
  streams[0]!.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.created", response: { id: "resp_1" } })}\n\n`));
  for (let k = 0; k < 200 && order.length < 2; k++) await sleep(5);
  assert.deepEqual(order, ["fetch 27", "fetch 29"], "it goes once the writer's response begins");
  for (const stream of streams) stream.error(new Error("done"));
  await Promise.all([a, b]);
  bodies.length = 0;
  respond = () => new Response("{}", { status: 400 });
}

console.log("optchat cache: ok");
