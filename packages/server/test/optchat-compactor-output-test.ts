/** The compactor's output cap as sent, offline: the real compactNode behind
 * the production wrapper (cachedModels, task off) over pi-ai's own request
 * builders, each body taken at its last onPayload and never sent. Anthropic
 * (adaptive and budget thinking), the OpenAI platform with a key, Gemini:
 * the cap is outputTokens(node), on a budget plus pi-ai's THINKING; never the
 * model's maximum. A ChatGPT sign-in (Codex, the platform signed in) takes
 * no cap, so pi-ai sends none: asserted, so a change in pi-ai is seen. No
 * provider is reached. */
import assert from "node:assert/strict";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { googleProvider } from "@earendil-works/pi-ai/providers/google";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { streamSimple as codexStream } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { cachedModels } from "../src/optchat-cache.ts";
import { compactNode, outputTokens, THINKING } from "../src/optchat-compactor.ts";
import { NODE } from "../src/optchat-memory.ts";

process.env.ANTHROPIC_API_KEY = "sk-ant-test";
process.env.OPENAI_API_KEY = "sk-test";
process.env.GEMINI_API_KEY = "gemini-test";
globalThis.fetch = (async () => { throw new Error("no request may leave this test"); }) as typeof fetch;

const claim = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-test" } })).toString("base64url");
const models = createModels();
for (const provider of [anthropicProvider(), openaiProvider(), openaiCodexProvider(), googleProvider()]) models.setProvider(provider);

/** The body of one compactor call, as it would go out. */
async function body(provider: string, id: string, apiKey?: string): Promise<Record<string, unknown>> {
  const model = models.getModel(provider, id);
  assert.ok(model, `${provider}/${id} in the catalog`);
  let sent: Record<string, unknown> | undefined;
  const inner = new Proxy(models, {
    get(target, property, receiver) {
      if (property !== "completeSimple") { const value = Reflect.get(target, property, receiver); return typeof value === "function" ? value.bind(target) : value; }
      // Codex is OAuth only: its builder is called directly, with a token shaped like ChatGPT's.
      const complete = provider === "openai-codex" ? async (m: never, context: never, options: never) => codexStream(m, context, options).result() : target.completeSimple.bind(target);
      return (m: never, context: never, options: { onPayload?: (payload: unknown, model: never) => unknown }) => complete(m, context, {
        ...options, ...apiKey ? { apiKey } : {}, maxRetries: 0,
        onPayload: async (payload: unknown, piModel: never) => {
          sent = ((await options.onPayload?.(payload, piModel)) ?? payload) as Record<string, unknown>;
          throw new Error("captured");
        },
      } as never);
    },
  }) as Models;
  // A reply that never reached a model holds the node: compactNode throws.
  await assert.rejects(compactNode({ models: cachedModels(inner, () => "optchat-test", { task: false }), model: { provider, id }, context: ["0+0|user: hello"], source: { message: "user: hello" } }), /captured/);
  assert.ok(sent, `${provider}/${id}: a body was built`);
  return sent;
}

const cap = outputTokens(NODE);
assert.equal(cap, THINKING + 1024, "512-byte nodes: pi-ai's medium thinking budget and 1024 answer tokens");
assert.equal(outputTokens(4096), THINKING + 6144, "a larger node gets room for three of its lines");

{
  const opus = models.getModel("anthropic", "claude-opus-5-5")!;
  assert.equal(opus.maxTokens, 128000);
  const adaptive = await body("anthropic", "claude-opus-5-5");
  assert.equal(adaptive.max_tokens, cap, "Anthropic, adaptive thinking: the cap covers thinking and text");
  const budget = await body("anthropic", "claude-haiku-4-5");
  assert.equal(budget.max_tokens, cap + THINKING, "Anthropic, a thinking budget: pi-ai adds the budget on top");
  assert.equal((budget.thinking as { budget_tokens?: number }).budget_tokens, THINKING);
}
{
  const platform = await body("openai", "gpt-6-luna");
  assert.equal(platform.max_output_tokens, cap, "OpenAI platform with a key: max_output_tokens");
  const signedIn = await body("openai", "gpt-6-luna", "chatgpt-oauth-token");
  assert.ok(!("max_output_tokens" in signedIn), "OpenAI platform, ChatGPT sign-in: no cap is sent (it refuses one)");
  const codex = await body("openai-codex", "gpt-6-luna", `x.${claim}.y`);
  assert.ok(!("max_output_tokens" in codex) && !("max_tokens" in codex), "Codex: no cap is sent (it refuses one)");
}
{
  const gemini = await body("google", "gemini-3.5-flash");
  assert.equal((gemini.config as { maxOutputTokens?: number }).maxOutputTokens, cap, "Gemini: maxOutputTokens");
}
console.log("optchat compactor output ok");
