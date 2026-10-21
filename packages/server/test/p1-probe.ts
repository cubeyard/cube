/** P1: does the OpenAI platform take the reasoning fields cube sends? Four
 * one-line requests built by pi-ai's own OpenAI Responses builder behind
 * OptChat's production wrappers (cachedModels over boundedOutput), with
 * `max_output_tokens` 16 (the API's minimum, which pi-ai clamps to):
 *
 *   A1 gpt-5.5     as cube sends it today (no reasoning.context)
 *   A2 gpt-5.5     with reasoning.context "all_turns" (what enabling it would send)
 *   B1 gpt-6-luna  as cube sends it (configuration_update + all_turns)
 *   B2 gpt-6-luna  configuration_update only (all_turns taken out)
 *
 * Pass: no 4xx naming reasoning.context, all_turns or configuration_update.
 * A reasoning model may stop at 16 tokens as `incomplete` (HTTP 200): that
 * is a pass, the fields were taken.
 *
 * By default nothing is sent: it prints each body's fields and size. With
 * `--send` (and OPENAI_API_KEY) it sends the cases named in
 * CUBE_P1_CASES (e.g. "B1,B2"), one request each, no retry, and prints
 * only the HTTP status, the stop reason, the usage and the error's text;
 * never the key. Cost at pi-ai's catalog prices, about 15 input and at most
 * 16 output tokens a call: gpt-5.5 about $0.0006, gpt-6-luna about $0.00001.
 *
 *   node packages/server/test/p1-probe.ts                       (offline)
 *   CUBE_P1_CASES=B1,B2 node packages/server/test/p1-probe.ts --send */
import assert from "node:assert/strict";
import { createModels, type Models } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { cachedModels } from "../src/optchat-cache.ts";
import { boundedOutput } from "../src/optchat-output.ts";

const send = process.argv.includes("--send");
const cases = { A1: ["gpt-5.5", "plain"], A2: ["gpt-5.5", "all_turns"], B1: ["gpt-6-luna", "plain"], B2: ["gpt-6-luna", "no_all_turns"] } as const;
type Case = keyof typeof cases;
const chosen = send ? (process.env.CUBE_P1_CASES ?? "").split(",").filter(Boolean) as Case[] : Object.keys(cases) as Case[];
if (send) {
  assert.ok(chosen.length && chosen.every(name => name in cases), "--send needs CUBE_P1_CASES, e.g. B1,B2");
  assert.ok(process.env.OPENAI_API_KEY?.startsWith("sk-"), "--send needs the platform's OPENAI_API_KEY (an sk- key, not a ChatGPT sign-in)");
} else {
  process.env.OPENAI_API_KEY = "sk-probe-offline";
  globalThis.fetch = (async () => { throw new Error("offline: nothing is sent"); }) as typeof fetch;
}
const real = createModels();
real.setProvider(openaiProvider());

for (const name of chosen) {
  const [id, variant] = cases[name];
  const model = real.getModel("openai", id);
  assert.ok(model, `openai/${id} is in pi-ai's catalog`);
  let body: Record<string, unknown> | undefined;
  const inner = new Proxy(real, { get(target, property, receiver) {
    if (property !== "streamSimple") { const value = Reflect.get(target, property, receiver); return typeof value === "function" ? value.bind(target) : value; }
    return (m: never, context: never, options: { onPayload?: (payload: unknown, model: never) => unknown }) => target.streamSimple(m, context, { ...options, maxRetries: 0,
      onPayload: async (payload: unknown, piModel: never) => {
        const next = ((await options.onPayload?.(payload, piModel)) ?? payload) as Record<string, unknown> & { reasoning?: Record<string, unknown> };
        // A2/B2 change only the field under test, after cube built the rest.
        if (variant === "all_turns") next.reasoning = { ...next.reasoning, context: "all_turns" };
        if (variant === "no_all_turns" && next.reasoning) { const { context: _context, ...rest } = next.reasoning; next.reasoning = rest; }
        body = next;
        if (!send) throw new Error("captured");
        return next;
      } } as never);
  } }) as Models;
  const chat = cachedModels(boundedOutput(inner), () => "optchat-p1-probe");
  const reply = await chat.streamSimple(model, { messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }] }, { reasoning: "low", maxTokens: 16 }).result();
  assert.ok(body, `${name}: a body was built`);
  const input = body.input as Array<{ type?: string; role?: string }>;
  const fields = { model: body.model, max_output_tokens: body.max_output_tokens, reasoning: body.reasoning, last_input: input.at(-1)?.type ?? input.at(-1)?.role, bytes: JSON.stringify(body).length };
  if (!send) { console.log(`${name} (offline, not sent): ${JSON.stringify(fields)}`); continue; }
  console.log(`${name} sent: ${JSON.stringify({ ...fields, stop: reply.stopReason, raw: reply.rawStopReason, usage: { input: reply.usage.input, output: reply.usage.output }, error: reply.errorMessage ?? null })}`);
}
