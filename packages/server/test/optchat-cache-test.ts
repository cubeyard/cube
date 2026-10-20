/** OptChat's prompt caching through pi-ai's real Anthropic and Codex request
 * builders: fetch is replaced, so what would go on the wire is captured and
 * nothing leaves the process. The view goes in blocks of four lines; an
 * Anthropic request marks the last system block, the last whole view block
 * and its end, and a call waits while another writes its marked prefix.
 * Codex gets the chat's prompt_cache_key and the system prompt as its
 * instructions, ahead of the view. A waiter goes on the begun event only
 * (message_start, response.output_item.added), never on response.created or
 * an error. The OpenAI platform's GPT-5.6+ gets an explicit breakpoint on the
 * view and, for the compactor, mode explicit; 5.6+ gets reasoning.context
 * all_turns with a one-time fallback; the rest is sent as pi-ai builds it. */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { zstdDecompressSync } from "node:zlib";
import { createModels, InMemoryCredentialStore, type Message, type Models, type Tool } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { streamSimple as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { azureOpenAIResponsesProvider } from "@earendil-works/pi-ai/providers/azure-openai-responses";
import { streamSimple as responsesStream } from "@earendil-works/pi-ai/api/openai-responses";
import { GITHUB_COPILOT_MODELS } from "@earendil-works/pi-ai/providers/github-copilot.models";
import { OPENCODE_MODELS } from "@earendil-works/pi-ai/providers/opencode.models";
import { OPENCODE_GO_MODELS } from "@earendil-works/pi-ai/providers/opencode-go.models";
import { CLOUDFLARE_AI_GATEWAY_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-ai-gateway.models";
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
const sse = (event: object) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
const added = { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } };
const until = async (test: () => boolean) => { for (let k = 0; k < 200 && !test(); k++) await sleep(5); assert.ok(test()); };
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

  // Single flight holds for Codex too. A compaction whose view starts with
  // one being written waits until that one's response begins on its prompt
  // (response.output_item.added, uniichat's begun), not when it is accepted
  // (response.created).
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
  await until(() => order.length >= 1);
  await sleep(30);
  assert.deepEqual(order, ["fetch 27"], "the longer view waits while the shorter is written");
  streams[0]!.enqueue(sse({ type: "response.created", response: { id: "resp_1" } }));
  await sleep(50);
  assert.deepEqual(order, ["fetch 27"], "response.created does not let it go: the prompt is not read yet");
  streams[0]!.enqueue(sse(added));
  await until(() => order.length >= 2);
  assert.deepEqual(order, ["fetch 27", "fetch 29"], "it goes once the writer's response begins on its prompt");
  for (const stream of streams.splice(0)) stream.error(new Error("done"));
  await Promise.all([a, b]);
  order.length = 0;

  // A writer whose first event is an error wrote nothing: two calls of its
  // prefix after it still go one at a time.
  const c = compactor.completeSimple(model, { messages: request(render(100, 7)) }, options);
  await until(() => order.length >= 1);
  streams[0]!.enqueue(sse({ type: "error", code: "server_error", message: "boom" }));
  assert.equal((await c).stopReason, "error");
  streams.length = 0;
  order.length = 0;
  const d = compactor.completeSimple(model, { messages: request(render(100, 7)) }, options);
  const e = compactor.completeSimple(model, { messages: request(render(100, 7)) }, options);
  await until(() => order.length >= 1);
  await sleep(50);
  assert.deepEqual(order, ["fetch 27"], "after an error-first writer, its prefix is not taken as cached");
  streams[0]!.enqueue(sse(added));
  await until(() => order.length >= 2);
  for (const stream of streams.splice(0)) stream.error(new Error("done"));
  await Promise.all([d, e]);
  bodies.length = 0;
  respond = () => new Response("{}", { status: 400 });

  // reasoning.context all_turns only for 5.6 and later (the SDK's default
  // there); gpt-5.5 and older are not sent it (no live check yet).
  const codexBody = async (id: string) => {
    const pick = models.getModels("openai-codex").find(candidate => candidate.id === id)!;
    const options = { apiKey: `x.${claim}.y`, transport: "sse" as const, maxRetries: 0, reasoning: "high" as const };
    await cachedModels(direct, () => "optchat-test").completeSimple(pick, { messages: request(big) }, options);
    const wrapped = bodies.pop()!.body;
    await direct.completeSimple(pick, { messages: request(big) }, { ...options, sessionId: "optchat-test" });
    return { wrapped, plain: bodies.pop()!.body };
  };
  const old = await codexBody("gpt-5.5");
  assert.equal(JSON.stringify(old.wrapped), JSON.stringify(old.plain), "Codex gpt-5.5: byte for byte what pi-ai sends");
  const sol = await codexBody("gpt-5.6-sol");
  assert.deepEqual(sol.wrapped.reasoning, { ...sol.plain.reasoning as object, context: "all_turns" }, "Codex gpt-5.6-sol: all_turns");
  assert.equal(JSON.stringify({ ...sol.wrapped, reasoning: sol.plain.reasoning }), JSON.stringify(sol.plain), "and nothing else differs");
  assert.ok(!JSON.stringify(sol.wrapped).includes("prompt_cache_breakpoint") && !("prompt_cache_options" in sol.wrapped), "Codex gets no explicit breakpoints");

  // Codex keeps only a refusal's message, not its param: one that names only
  // the value is sent again once without it, and that model not again.
  const invalid = () => new Response(JSON.stringify({ error: { message: "Invalid value: 'all_turns'. Supported values are: 'current_turn'.", type: "invalid_request_error", param: "reasoning.context", code: "invalid_value" } }), { status: 400, headers: { "content-type": "application/json" } });
  const sent: Array<string | null> = [];
  const context = (captured: Captured) => (captured.body.reasoning as { context?: string } | undefined)?.context ?? null;
  respond = captured => { sent.push(context(captured)); return invalid(); };
  const pick = (id: string) => models.getModels("openai-codex").find(candidate => candidate.id === id)!;
  const codexOptions = { apiKey: `x.${claim}.y`, transport: "sse" as const, maxRetries: 0, reasoning: "high" as const };
  const refused = await cachedModels(direct, () => "optchat-test").completeSimple(pick("gpt-6-sol"), { messages: request(small(3)) }, codexOptions);
  assert.match(refused.errorMessage ?? "", /Invalid value: 'all_turns'/, "the message names only the value");
  assert.doesNotMatch(refused.errorMessage ?? "", /reasoning\.context/);
  assert.deepEqual(sent, ["all_turns", null], "Codex: refused by value, sent once more without it, and only once");
  await cachedModels(direct, () => "optchat-test").completeSimple(pick("gpt-6-sol"), { messages: request(small(3)) }, codexOptions);
  assert.deepEqual(sent, ["all_turns", null, null], "and not sent it again");
  sent.length = 0;
  const events: string[] = [];
  const stream = cachedModels(direct, () => "optchat-test").streamSimple(pick("gpt-6-astra"), { messages: request(small(3)) }, codexOptions);
  for await (const event of stream) events.push(event.type);
  assert.deepEqual([sent, events], [["all_turns", null], ["error"]], "a stream too: one retry, and only its end is seen");
  sent.length = 0;
  respond = captured => { sent.push(context(captured)); return new Response(JSON.stringify({ error: { message: "Invalid value: 'xhigh' for reasoning.effort.", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } }); };
  await cachedModels(direct, () => "optchat-test").completeSimple(pick("gpt-6-luna"), { messages: request(small(3)) }, codexOptions);
  assert.deepEqual(sent, ["all_turns"], "an invalid value of another field is not sent again");
  bodies.length = 0;
  respond = () => new Response("{}", { status: 400 });
}

{
  // An API-compatible third party on openai-responses is sent what pi-ai
  // builds: no reasoning.context, so no refusal can come of it.
  const direct = { streamSimple: (m: never, c: never, o: never) => responsesStream(m, c, o), completeSimple: async (m: never, c: never, o: never) => responsesStream(m, c, o).result() } as unknown as Models;
  const later = (id: string) => { const version = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(id); return !!version && (Number(version[1]) > 5 || (Number(version[1]) === 5 && Number(version[2] ?? 0) >= 6)); };
  const thirdParty = [GITHUB_COPILOT_MODELS, OPENCODE_MODELS, OPENCODE_GO_MODELS, CLOUDFLARE_AI_GATEWAY_MODELS].flatMap(catalog => Object.values(catalog)).filter(candidate => candidate.api === "openai-responses" && later(candidate.id));
  assert.equal(thirdParty.length, 22, "the catalog's GPT-5.6+ models on openai-responses outside OpenAI");
  const options = { apiKey: "third-party-key", maxRetries: 0, reasoning: "high" as const, sessionId: "optchat-test" };
  for (const pick of thirdParty) {
    await cachedModels(direct, () => "optchat-test").completeSimple(pick, { messages: request(render(100)) }, options);
    const wrapped = bodies.pop()!.body;
    await direct.completeSimple(pick, { messages: request(render(100)) }, options);
    const plain = bodies.pop()!.body;
    assert.equal(JSON.stringify(wrapped), JSON.stringify(plain), `${pick.provider} ${pick.id}: byte for byte what pi-ai sends`);
  }
  // A generic refusal there is one call, as without OptChat.
  respond = () => new Response(JSON.stringify({ message: "Bad Request" }), { status: 400, headers: { "content-type": "application/json" } });
  const sol = thirdParty.find(candidate => candidate.provider === "opencode" && candidate.id === "gpt-5.6-sol")!;
  const reply = await cachedModels(direct, () => "optchat-test").completeSimple(sol, { messages: request(small(3)) }, options);
  assert.equal(reply.stopReason, "error");
  assert.equal(bodies.splice(0).length, 1, "opencode: one call");
  respond = () => new Response("{}", { status: 400 });
}

{
  // The OpenAI platform. GPT-5.6+ (pi-ai's supportsExplicitPromptCacheMode)
  // marks its last whole view block with an explicit breakpoint; the
  // compactor sets mode explicit, so its task gets no implicit breakpoint.
  // gpt-5.5 and Azure are sent what pi-ai builds.
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.AZURE_OPENAI_API_KEY = "azure-test";
  process.env.AZURE_OPENAI_RESOURCE_NAME = "cube-test";
  const platform = createModels();
  platform.setProvider(openaiProvider());
  platform.setProvider(azureOpenAIResponsesProvider());
  const pick = (provider: string, id: string) => platform.getModels(provider).find(candidate => candidate.id === id)!;
  const sol = pick("openai", "gpt-5.6-sol"), five = pick("openai", "gpt-5.5"), azure = pick("azure-openai-responses", "gpt-5.6-sol");
  const flagged = (model: typeof sol) => (model.compat as { supportsExplicitPromptCacheMode?: boolean } | undefined)?.supportsExplicitPromptCacheMode === true;
  assert.ok(flagged(sol) && !flagged(five) && !flagged(azure), "pi-ai flags the platform's 5.6+ only");
  type Part = { type: string; text?: string; prompt_cache_breakpoint?: unknown };
  type Input = Array<{ role?: string; content?: Part[] }>;
  const breakpoints = (body: Record<string, unknown>) => (body.input as Input).flatMap((item, at) => (Array.isArray(item.content) ? item.content : []).flatMap((part, k) => part.prompt_cache_breakpoint ? [`${at}:${k}`] : []));
  const send = async (models: Models, model: typeof sol, messages: Message[], options: object = {}) => {
    await models.completeSimple(model, { messages }, { maxRetries: 0, reasoning: "high", sessionId: "optchat-test", ...options });
    return bodies.pop()!.body;
  };
  const chat = cachedModels(platform, () => "optchat-test");
  const compact = cachedModels(platform, () => "optchat-test", { task: false });

  const turn = await send(chat, sol, request(render(500)));
  assert.deepEqual(breakpoints(turn), ["1:124"], "gpt-5.6-sol turn: one breakpoint, the last whole view block");
  assert.equal(turn.prompt_cache_options, undefined, "a turn keeps the implicit breakpoint at its end");
  assert.deepEqual(turn.reasoning, { effort: "high", summary: "auto", context: "all_turns" });
  const compaction = await send(compact, sol, request(render(500)));
  assert.deepEqual(breakpoints(compaction), ["1:124"]);
  assert.deepEqual(compaction.prompt_cache_options, { mode: "explicit" }, "the compactor's task gets no implicit breakpoint");
  const tiny = await send(compact, sol, request(small(3)));
  assert.deepEqual(breakpoints(tiny), [], "a view under one whole block has no breakpoint");
  assert.deepEqual(tiny.prompt_cache_options, { mode: "explicit" });
  const signedIn = await send(compact, sol, request(render(500)), { apiKey: "chatgpt-oauth-token" });
  assert.deepEqual([breakpoints(signedIn), signedIn.prompt_cache_options], [[], undefined], "a ChatGPT sign-in, which refuses them, gets neither");
  // The chat and the compactor pass no apiKey: pi-ai resolves the credential
  // in the registry. A ChatGPT sign-in stored there (cube's openai login),
  // or a non-sk- key in the call's env, gets neither field, while
  // OPENAI_API_KEY is still an sk- key; a stored sk- key gets both.
  const registry = async (credential: object) => {
    const credentials = new InMemoryCredentialStore();
    await credentials.modify("openai", async () => credential as never);
    const registry = createModels({ credentials });
    registry.setProvider(openaiProvider());
    return registry;
  };
  const oauth = await registry({ type: "oauth", access: "chatgpt-access-token", refresh: "chatgpt-refresh-token", expires: Date.now() + 3_600_000 });
  const raw = await send(oauth, sol, request(render(500)));
  assert.ok(!("max_output_tokens" in raw) && !("prompt_cache_options" in raw), "pi-ai takes the stored credential as a sign-in");
  for (const [label, wrapped] of [["chat", cachedModels(oauth, () => "optchat-test")], ["compactor", cachedModels(oauth, () => "optchat-test", { task: false })]] as const) {
    const body = await send(wrapped, sol, request(render(500)));
    assert.deepEqual([breakpoints(body), body.prompt_cache_options], [[], undefined], `${label}, a stored ChatGPT sign-in: neither field`);
    assert.equal(JSON.stringify({ ...body, reasoning: raw.reasoning }), JSON.stringify(raw), `${label}: otherwise pi-ai's body, but for all_turns`);
    assert.ok(!JSON.stringify(body).includes("chatgpt-access-token"), "the credential is not in the body");
  }
  for (const [label, wrapped] of [["chat", chat], ["compactor", compact]] as const) {
    const body = await send(wrapped, sol, request(render(500)), { env: { OPENAI_API_KEY: "chatgpt-env-token" } });
    assert.deepEqual([breakpoints(body), body.prompt_cache_options], [[], undefined], `${label}, a sign-in in the call's env: neither field`);
  }
  const keyed = await registry({ type: "api_key", key: "sk-stored" });
  const keyedTurn = await send(cachedModels(keyed, () => "optchat-test"), sol, request(render(500)));
  assert.deepEqual(breakpoints(keyedTurn), ["1:124"], "a stored sk- key keeps the breakpoint");
  const keyedCompaction = await send(cachedModels(keyed, () => "optchat-test", { task: false }), sol, request(render(500)));
  assert.deepEqual([breakpoints(keyedCompaction), keyedCompaction.prompt_cache_options], [["1:124"], { mode: "explicit" }], "and the compactor's explicit mode");
  // Consecutive turns: the marked prefix is byte for byte the same, and a
  // longer view marks its own block within the lookback.
  const prefix = (body: Record<string, unknown>, upto: number) => JSON.stringify([(body.input as Input)[0], (body.input as Input)[1]!.content!.slice(0, upto).map(part => ({ ...part, prompt_cache_breakpoint: undefined }))]);
  for (const k of [1, 4, 40, 80]) {
    const next = await send(chat, sol, request(render(500 + k)));
    const at = Number(breakpoints(next)[0]!.split(":")[1]);
    assert.equal(prefix(next, 125), prefix(turn, 125), `500 + ${k} lines: the marked prefix leads byte for byte`);
    assert.ok(at >= 124 && at - 124 <= 20);
    assert.equal(JSON.stringify(next.tools), JSON.stringify(turn.tools));
  }
  for (const [label, model] of [["gpt-5.5", five], ["azure gpt-5.6-sol", azure]] as const) {
    for (const models of [chat, compact]) {
      const wrapped = await send(models, model, request(render(500)));
      const plain = await send(platform, model, request(render(500)));
      assert.equal(JSON.stringify(wrapped), JSON.stringify(plain), `${label}: byte for byte what pi-ai sends`);
    }
  }

  // The platform's begun event, as on Codex; an error first lets go and
  // leaves nothing cached.
  const order: string[] = [];
  const streams: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  respond = captured => {
    order.push(`fetch ${(captured.body.input as Input)[1]!.content!.length}`);
    return new Response(new ReadableStream<Uint8Array>({ start: controller => { streams.push(controller); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const a = compact.completeSimple(sol, { messages: request(render(100, 8)) }, { maxRetries: 0 });
  const b = compact.completeSimple(sol, { messages: request(render(108, 8)) }, { maxRetries: 0 });
  await until(() => order.length >= 1);
  streams[0]!.enqueue(sse({ type: "response.created", response: { id: "resp_2", status: "in_progress", output: [] } }));
  await sleep(50);
  assert.deepEqual(order, ["fetch 27"], "platform: response.created does not let it go");
  streams[0]!.enqueue(sse(added));
  await until(() => order.length >= 2);
  assert.deepEqual(order, ["fetch 27", "fetch 29"], "platform: output_item.added does");
  for (const stream of streams.splice(0)) stream.error(new Error("done"));
  await Promise.all([a, b]);
  order.length = 0;
  const c = compact.completeSimple(sol, { messages: request(render(100, 9)) }, { maxRetries: 0 });
  await until(() => order.length >= 1);
  streams[0]!.enqueue(sse({ type: "error", code: "server_error", message: "boom" }));
  assert.equal((await c).stopReason, "error");
  streams.length = 0;
  order.length = 0;
  const d = compact.completeSimple(sol, { messages: request(render(100, 9)) }, { maxRetries: 0 });
  const e = compact.completeSimple(sol, { messages: request(render(100, 9)) }, { maxRetries: 0 });
  await until(() => order.length >= 1);
  await sleep(50);
  assert.deepEqual(order, ["fetch 27"], "platform: after an error-first writer, one writer again");
  streams[0]!.enqueue(sse(added));
  await until(() => order.length >= 2);
  for (const stream of streams.splice(0)) stream.error(new Error("done"));
  await Promise.all([d, e]);
  bodies.length = 0;

  // A refusal naming reasoning.context is sent again once without it, and
  // that model is not sent it again; through completeSimple and the stream.
  const refuse = () => new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'reasoning.context' is not supported with this model.", type: "invalid_request_error", param: "reasoning.context", code: "unsupported_parameter" } }), { status: 400, headers: { "content-type": "application/json" } });
  const sent: Array<string | null> = [];
  const context = (captured: Captured) => (captured.body.reasoning as { context?: string } | undefined)?.context ?? null;
  respond = captured => { sent.push(context(captured)); return sent.length === 1 ? refuse() : new Response("{}", { status: 400 }); };
  const luna = pick("openai", "gpt-5.6-luna"), terra = pick("openai", "gpt-5.6-terra");
  await chat.completeSimple(luna, { messages: request(small(3)) }, { maxRetries: 0, reasoning: "high" });
  assert.deepEqual(sent, ["all_turns", null], "refused, then sent once without it");
  await chat.completeSimple(luna, { messages: request(small(3)) }, { maxRetries: 0, reasoning: "high" });
  assert.deepEqual(sent, ["all_turns", null, null], "the model is not sent it again");
  sent.length = 0;
  respond = captured => { sent.push(context(captured)); return refuse(); };
  const events: string[] = [];
  const stream = chat.streamSimple(terra, { messages: request(small(3)) }, { maxRetries: 0, reasoning: "high" });
  for await (const event of stream) events.push(event.type);
  assert.deepEqual(sent, ["all_turns", null], "a stream is sent again once, and only once, even when refused again");
  assert.deepEqual(events, ["error"], "the caller sees only the second try's end");
  assert.match((await stream.result()).errorMessage ?? "", /reasoning\.context/);
  sent.length = 0;
  respond = captured => { sent.push(context(captured)); return new Response(JSON.stringify({ error: { message: "rate limited", type: "rate_limit" } }), { status: 400, headers: { "content-type": "application/json" } }); };
  await chat.completeSimple(sol, { messages: request(small(3)) }, { maxRetries: 0, reasoning: "high" });
  assert.deepEqual(sent, ["all_turns"], "another error is not sent again");
  bodies.length = 0;
  respond = () => new Response("{}", { status: 400 });
}

console.log("optchat cache: ok");
