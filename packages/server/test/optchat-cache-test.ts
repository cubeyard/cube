/** OptChat's prompt caching through pi-ai's real Anthropic and Codex request
 * builders: fetch is replaced, so what would go on the wire is captured and
 * nothing leaves the process. A large view gets Anthropic marks on its pieces
 * (at most four in the request, the system and tool marks dropped) and a
 * small one keeps pi-ai's own; Codex gets the chat's prompt_cache_key and the
 * system prompt as its instructions, ahead of the view. */
import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import { createModels, type Message, type Tool } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { streamSimple as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { cachedModels, MARKS, markViewPieces, viewPieces } from "../src/optchat-cache.ts";
import { withView } from "../src/optchat.ts";

// Pieces end at the last line end before each mark and join to the view.
const line = (n: number) => `${n}+1|user: ${"x".repeat(240)} ${n}`;
const render = (lines: number) => `<chat>\n${Array.from({ length: lines }, (_, n) => line(n)).join("\n")}\n</chat>`;
const big = render(500), small = render(20);
const pieces = viewPieces(big);
assert.equal(pieces.join(""), big);
assert.equal(pieces.length, 4, "three marks inside a 128 KB view");
let at = 0;
for (const [k, piece] of pieces.slice(0, -1).entries()) {
  at += piece.length;
  assert.ok(piece.endsWith("\n") && at <= MARKS[k]! && MARKS[k]! - at < 300, "each piece ends at the last line end before its mark");
}
assert.deepEqual(viewPieces(small), [small], "a small view is one piece");
assert.equal(markViewPieces({ messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }] }), undefined, "only a view is marked");

const tool: Tool = { name: "zoom", description: "open a line", parameters: { type: "object", properties: {} } as never };
const request = (view: string): Message[] => withView([
  { role: "user", content: "what did I say?", timestamp: 1 },
  { role: "system", content: "", sections: { master: "You are OptChat." }, toolsAdded: [tool], timestamp: 1 },
], viewPieces(view));
assert.equal(request(small)[0]!.role, "system", "the system baseline leads the request");

const bodies: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const raw = init?.body ?? (input instanceof Request ? await input.text() : "");
  // Codex sends its body zstd-compressed.
  const text = raw instanceof Uint8Array ? (headers.get("content-encoding") === "zstd" ? zstdDecompressSync(raw) : Buffer.from(raw)).toString("utf8") : String(raw);
  bodies.push({ url, headers, body: JSON.parse(text) });
  return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }), { status: 400, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openaiCodexProvider());
const cached = cachedModels(models, () => "optchat-test");
const marks = (body: Record<string, unknown>) => JSON.stringify(body).split('"cache_control"').length - 1;

{
  const model = models.getModels("anthropic").find(candidate => candidate.api === "anthropic-messages")!;
  assert.ok(model, "an Anthropic model in the catalog");
  await cached.completeSimple(model, { messages: request(big) }, { apiKey: "sk-ant-test", maxRetries: 0 });
  const { body } = bodies.pop()!;
  const first = (body.messages as Array<{ role: string; content: Array<{ text?: string; cache_control?: unknown }> }>)[0]!;
  assert.equal(first.role, "user");
  assert.equal(first.content.slice(0, 4).map(block => block.text).join(""), big, "the view goes as its pieces");
  assert.deepEqual(first.content.map(block => !!block.cache_control), [true, true, true, false, true], "three view marks and the end mark");
  assert.equal(marks(body), 4, "within Anthropic's four marks");
  assert.ok(JSON.stringify(body.system).includes("You are OptChat."), "the system prompt is the system prompt");

  await cached.completeSimple(model, { messages: request(small) }, { apiKey: "sk-ant-test", maxRetries: 0 });
  const plain = bodies.pop()!.body;
  assert.ok(marks(plain) >= 2 && marks(plain) <= 4, "a small view keeps pi-ai's own marks");
  assert.ok(JSON.stringify(plain.system).includes("cache_control"));
}

{
  // Codex is an OAuth-only provider: its request builder is called directly,
  // behind the same wrapper, with a token shaped like ChatGPT's.
  const model = models.getModels("openai-codex")[0]!;
  assert.ok(model, "a Codex model in the catalog");
  const direct = { streamSimple: (m: never, c: never, o: never) => codexStream(m, c, o), completeSimple: async (m: never, c: never, o: never) => codexStream(m, c, o).result() } as unknown as typeof models;
  const claim = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } })).toString("base64url");
  await cachedModels(direct, () => "optchat-test").completeSimple(model, { messages: request(big) }, { apiKey: `x.${claim}.y`, transport: "sse", maxRetries: 0 });
  const captured = bodies.pop()!;
  assert.ok(captured, "the Codex request was built");
  assert.equal(captured.body.prompt_cache_key, "optchat-test", "the chat's cache key");
  assert.equal(captured.headers.get("session-id"), "optchat-test");
  assert.match(String(captured.body.instructions), /You are OptChat\./, "the system prompt is Codex's instructions");
  const input = captured.body.input as Array<{ role?: string; content?: Array<{ text?: string }> }>;
  assert.equal(input[0]!.content!.slice(0, 4).map(part => part.text).join(""), big, "the view leads the input, so turns share its prefix");
  assert.equal(captured.body.store, false);
}

console.log("optchat cache: ok");
