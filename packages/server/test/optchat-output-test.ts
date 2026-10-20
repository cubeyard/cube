/** OptChat's output bound, offline. The chat's requests carry its cap
 * (CHAT_OUTPUT_TOKENS, O1) through pi-ai's own request builders where the
 * API takes one, behind the production wrappers (cachedModels over
 * boundedOutput); a ChatGPT sign-in (Codex) takes none and gets none. Where
 * a request carries no cap, the guard counts the output as it streams and
 * stops the call at its cap as a `length` stop: a synthetic provider that
 * never stops shows the call aborted and its output bounded, for the chat
 * and through the real compactNode (which never uses such an answer and
 * stops after its answers). A capped request is never cut by the guard.
 * No provider is reached. */
import assert from "node:assert/strict";
import { createAssistantMessageEventStream, createModels, type AssistantMessage, type Models } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { streamSimple as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { cachedModels } from "../src/optchat-cache.ts";
import { compactNode, OutOfRoom, outputTokens, TRIES } from "../src/optchat-compactor.ts";
import { boundedOutput, CHAT_OUTPUT_TOKENS, wireCapped } from "../src/optchat-output.ts";
import { NODE } from "../src/optchat-memory.ts";

process.env.ANTHROPIC_API_KEY = "sk-ant-test";
process.env.OPENAI_API_KEY = "sk-test";
process.env.GEMINI_API_KEY = "gemini-test";
globalThis.fetch = (async () => { throw new Error("no request may leave this test"); }) as typeof fetch;
const claim = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } })).toString("base64url");
const real = createModels();
for (const provider of [anthropicProvider(), openaiProvider(), openaiCodexProvider(), googleProvider()]) real.setProvider(provider);

/** One chat request's body as it would go out (Pi passes no maxTokens). */
async function chatBody(provider: string, id: string, apiKey?: string): Promise<Record<string, unknown>> {
  const model = real.getModel(provider, id);
  assert.ok(model, `${provider}/${id} in the catalog`);
  let sent: Record<string, unknown> | undefined;
  const inner = new Proxy(real, {
    get(target, property, receiver) {
      if (property !== "streamSimple") { const value = Reflect.get(target, property, receiver); return typeof value === "function" ? value.bind(target) : value; }
      // Codex is OAuth only: its builder is called directly, with a token shaped like ChatGPT's.
      const stream = provider === "openai-codex" ? (m: never, context: never, options: never) => codexStream(m, context, options) : target.streamSimple.bind(target);
      return (m: never, context: never, options: { onPayload?: (payload: unknown, model: never) => unknown }) => stream(m, context, {
        ...options, ...apiKey ? { apiKey } : {}, maxRetries: 0,
        onPayload: async (payload: unknown, piModel: never) => {
          sent = ((await options.onPayload?.(payload, piModel)) ?? payload) as Record<string, unknown>;
          throw new Error("captured");
        },
      } as never);
    },
  }) as Models;
  const chat = cachedModels(boundedOutput(inner, CHAT_OUTPUT_TOKENS), () => "optchat-test");
  await chat.streamSimple(model, { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, { reasoning: "medium" }).result();
  assert.ok(sent, `${provider}/${id}: a body was built`);
  return sent;
}

{
  const opus = await chatBody("anthropic", "claude-opus-5-5");
  assert.equal(opus.max_tokens, CHAT_OUTPUT_TOKENS, "Anthropic: the chat's cap, not the model's 128,000");
  assert.ok(wireCapped(opus));
  const platform = await chatBody("openai", "gpt-6-luna");
  assert.equal(platform.max_output_tokens, CHAT_OUTPUT_TOKENS, "OpenAI with a key: max_output_tokens");
  assert.ok(wireCapped(platform));
  const gemini = await chatBody("google", "gemini-3.5-flash");
  assert.equal((gemini.config as { maxOutputTokens?: number }).maxOutputTokens, CHAT_OUTPUT_TOKENS, "Gemini: maxOutputTokens");
  assert.ok(wireCapped(gemini));
  const codex = await chatBody("openai-codex", "gpt-6-luna", `x.${claim}.y`);
  assert.ok(!wireCapped(codex), "Codex: no cap on the wire (it refuses one), so the guard counts");
  const signedIn = await chatBody("openai", "gpt-6-luna", "chatgpt-oauth-token");
  assert.ok(!wireCapped(signedIn), "OpenAI signed in: likewise");
  console.log("ok: the chat's requests carry its cap where the API takes one; Codex and a ChatGPT sign-in carry none");
}

type Stats = { calls: number; aborted: number; chars: number };
/** A provider that streams text until it is aborted (or 3x its cap); `capped` puts the cap on its wire. */
function endless(capped: boolean, stats: Stats): Models {
  const models = createModels();
  return new Proxy(models, {
    get(target, property, receiver) {
      if (property !== "streamSimple") { const value = Reflect.get(target, property, receiver); return typeof value === "function" ? value.bind(target) : value; }
      return (model: { api: string; provider: string; id: string }, _context: unknown, options: { signal?: AbortSignal; maxTokens?: number; onPayload?: (payload: unknown, model: never) => unknown }) => {
        stats.calls++;
        const stream = createAssistantMessageEventStream();
        const message = (stopReason: AssistantMessage["stopReason"], text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id,
          usage: { input: 1, output: Math.ceil(text.length / 4), cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, timestamp: Date.now() });
        void (async () => {
          await options.onPayload?.(capped ? { max_output_tokens: options.maxTokens } : { input: [] }, model as never);
          let text = "";
          stream.push({ type: "start", partial: message("stop", "") });
          stream.push({ type: "text_start", contentIndex: 0, partial: message("stop", "") });
          while (!options.signal?.aborted && text.length < 3 * 2 * (options.maxTokens ?? 1000)) {
            const delta = "word ".repeat(40);
            text += delta;
            stats.chars += delta.length;
            stream.push({ type: "text_delta", contentIndex: 0, delta, partial: message("stop", text) });
            await new Promise(resolve => setImmediate(resolve));
          }
          if (options.signal?.aborted) { stats.aborted++; stream.push({ type: "error", reason: "aborted", error: message("aborted", text) }); }
          else stream.push({ type: "done", reason: "stop", message: message("stop", text) });
          stream.end();
        })();
        return stream;
      };
    },
  }) as Models;
}

{
  const stats: Stats = { calls: 0, aborted: 0, chars: 0 };
  const chat = cachedModels(boundedOutput(endless(false, stats), 1000), () => "optchat-test");
  const reply = await chat.streamSimple({ api: "openai-codex-responses", provider: "openai-codex", id: "gpt-6-luna" } as never, { messages: [] }, {}).result();
  assert.equal(reply.stopReason, "length", "stopped at the cap as a length stop");
  assert.match(reply.errorMessage ?? "", /output cap \(1000 tokens\)/);
  assert.equal(stats.aborted, 1, "the call itself was aborted");
  assert.ok(stats.chars <= 2 * 1000 + 200, `its output was bounded (${stats.chars} characters)`);
  const capped: Stats = { calls: 0, aborted: 0, chars: 0 };
  const plain = await cachedModels(boundedOutput(endless(true, capped), 1000), () => "optchat-test")
    .streamSimple({ api: "openai-responses", provider: "openai", id: "gpt-6-luna" } as never, { messages: [] }, {}).result();
  assert.equal(plain.stopReason, "stop", "a request with a cap on its wire is never cut by the guard");
  assert.equal(capped.aborted, 0);
  console.log("ok: a request without a cap on its wire is stopped at its cap: aborted, a length stop, its output bounded; a capped one is left alone");
}

{
  // The compactor through the guard: each answer stops at outputTokens(node)
  // and is never used; after its answers the node waits (OutOfRoom).
  const stats: Stats = { calls: 0, aborted: 0, chars: 0 };
  const compactor = cachedModels(boundedOutput(endless(false, stats)), () => "optchat-test-compact", { task: false });
  const models = new Proxy(compactor, { get(target, property, receiver) {
    if (property === "getModel") return () => ({ api: "openai-codex-responses", provider: "openai-codex", id: "gpt-6-luna", reasoning: true, contextWindow: 272_000, maxTokens: 128_000 });
    const value = Reflect.get(target, property, receiver); return typeof value === "function" ? value.bind(target) : value;
  } }) as Models;
  await assert.rejects(compactNode({ models, model: { provider: "openai-codex", id: "gpt-6-luna" }, context: ["0+0|user: hello"], source: { message: "user: hello" } }), (error: unknown) => error instanceof OutOfRoom);
  assert.equal(stats.calls, TRIES, "at most its answers");
  assert.equal(stats.aborted, TRIES, "each stopped at the cap");
  assert.ok(stats.chars <= TRIES * (2 * outputTokens(NODE) + 200), `bounded output in all (${stats.chars} characters)`);
  console.log("ok: the compactor on a provider without a wire cap: each answer stopped at its cap, never used, at most TRIES");
}
