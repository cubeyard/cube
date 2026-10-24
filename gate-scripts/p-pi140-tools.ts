/** #237 live probe: does a provider accept pi-ai 1.4.0's Responses request
 * shape (the tools as a head `additional_tools` item, not top-level `tools`)
 * through OptChat's own wrappers (cachedModels over boundedOutput), on the
 * host's own login (`~/.pi/agent`, as cubed reads it)? Not part of the
 * repository: copy it to packages/server/ of the pinned checkout and run it
 * from there.
 *
 * Two requests, each sent once (maxRetries 0, a second body build is refused):
 *   T1  a ~5.8k-token prefix (fresh nonce) and one tool; the model must call it
 *   T2  the same prefix, T1's answer and the tool's result; the model answers
 *       in text, and should read T1's prefix from the cache
 * Output is capped (64 and 32 tokens). Nothing is printed but the fields under
 * test, usage, cost as pi-ai computes it and redacted error text.
 *
 *   node p-pi140-tools.ts --provider openai-codex --model gpt-6-luna          (dry: builds T1's body, sends nothing)
 *   node p-pi140-tools.ts --provider openai-codex --model gpt-6-luna --send
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cleanupSessionResources, Type, type Message, type Models, type Tool } from "@earendil-works/pi-ai";
import { createModelRuntime } from "./src/models.ts";
import { cachedModels, viewPieces } from "./src/optchat-cache.ts";
import { boundedOutput } from "./src/optchat-output.ts";

const arg = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const send = process.argv.includes("--send");
const provider = arg("--provider") ?? "openai-codex";
const id = arg("--model");
assert.ok(id, "--model <id>");

const redact = (text: string) => text
  .replace(/sk-[A-Za-z0-9_*.\-…]+/g, "sk-[redacted]")
  .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt redacted]")
  .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");

if (!send) {
  // Dry: the same loader on a throwaway agent dir with stand-in sign-ins
  // (never valid), and no network.
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p140-dry-"));
  const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "dry-run" }, exp: 4102444800 })).toString("base64url");
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({
    "openai-codex": { type: "oauth", access: `eyJhbGciOiJub25lIn0.${claims}.x`, refresh: "dry", expires: 4102444800000, accountId: "dry-run" },
    openai: { type: "api_key", key: "sk-dry" },
  }));
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.fetch = (async () => { throw new Error("dry: nothing is sent"); }) as typeof fetch;
}
const real = await createModelRuntime() as unknown as Models;
const model = real.getModel(provider as never, id);
assert.ok(model, `${provider}/${id} is offered on this login`);

const nonce = randomBytes(8).toString("hex");
const systemPrompt = `Pi 1.4.0 probe ${nonce}. Follow the last line exactly.`;
const lines = Array.from({ length: 160 }, (_, i) => `${i} probe ${nonce} line ${i}: the quick brown fox jumps over the lazy dog, then counts ${i * 7} pebbles by the river.`);
const blocks = viewPieces(`<chat>\n${lines.join("\n")}\n</chat>`).map(text => ({ type: "text" as const, text }));
const sessionId = `optchat-p140-${nonce}`;
const tool: Tool = { name: "probe_echo", description: "Echoes its text back.", parameters: Type.Object({ text: Type.String() }) };
const user: Message = { role: "user", content: [...blocks, { type: "text", text: `Call probe_echo once with text "${nonce}". Do not write any text.` }], timestamp: Date.now() };

type Body = { model?: string; tools?: unknown[]; prompt_cache_key?: string; input?: Array<{ type?: string; role?: string; tools?: Array<{ name?: string }> }> };
const shape = (body: Body) => ({
  model: body.model,
  head: (body.input ?? []).slice(0, 3).map(item => item.type ?? item.role),
  headTools: (body.input?.[0]?.tools ?? []).map(entry => entry.name),
  topLevelTools: body.tools?.length ?? 0,
  prompt_cache_key: body.prompt_cache_key === sessionId ? "the session id" : body.prompt_cache_key ? "other" : "none",
  bytes: JSON.stringify(body).length,
});

async function turn(name: string, messages: Message[], maxTokens: number) {
  let body: Body | undefined, builds = 0;
  const inner = new Proxy(real, { get(target, property, receiver) {
    if (property !== "streamSimple") { const value = Reflect.get(target, property, receiver); return typeof value === "function" ? value.bind(target) : value; }
    return (m: never, context: never, options: { onPayload?: (payload: unknown, model: never) => unknown }) => target.streamSimple(m, context, { ...options, maxRetries: 0,
      onPayload: async (payload: unknown, piModel: never) => {
        const next = ((await options.onPayload?.(payload, piModel)) ?? payload) as Body;
        if (++builds > 1) throw new Error(`${name}: a second body was built; refused, not sent`);
        body = next;
        if (!send) throw new Error("dry: captured");
        return next;
      } } as never);
  } }) as Models;
  const chat = cachedModels(boundedOutput(inner), () => sessionId);
  const reply = await chat.streamSimple(model!, { systemPrompt, messages, tools: [tool] } as never, { reasoning: "low", maxTokens }).result();
  assert.ok(body, `${name}: a body was built`);
  const fields = { ...shape(body), builds };
  assert.equal(fields.head[0], "additional_tools", `${name}: the tools lead the input`);
  assert.deepEqual(fields.headTools, ["probe_echo"], `${name}: the head item holds the tool`);
  assert.equal(fields.topLevelTools, 0, `${name}: no top-level tools`);
  if (!send) { console.log(`${name} (dry, not sent): ${JSON.stringify(fields)}`); return null; }
  const calls = reply.content.filter(block => block.type === "toolCall") as Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  console.log(`${name} sent: ${JSON.stringify({ ...fields, stop: reply.stopReason, raw: reply.rawStopReason ?? null,
    usage: { input: reply.usage.input, output: reply.usage.output, cacheRead: reply.usage.cacheRead, cacheWrite: reply.usage.cacheWrite, cost: reply.usage.cost?.total ?? null },
    calls: calls.map(call => ({ name: call.name, echoesNonce: call.arguments.text === nonce })),
    text: reply.content.filter(block => block.type === "text").map(block => (block as { text: string }).text).join("").slice(0, 40),
    error: reply.errorMessage ? redact(reply.errorMessage) : null })}`);
  return { reply, calls };
}

const first = await turn("T1", [user], 64);
if (!first) {
  // Dry T2: a stand-in tool-call answer, so the second body is built too.
  const answer = { role: "assistant", content: [{ type: "toolCall", id: "call_dry|fc_dry", name: tool.name, arguments: { text: nonce } }], api: model.api, provider, model: id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() } as unknown as Message;
  await turn("T2", [user, answer, { role: "toolResult", toolCallId: "call_dry|fc_dry", toolName: tool.name, content: [{ type: "text", text: `echo: ${nonce}` }], isError: false, timestamp: Date.now() } as Message], 32);
} else {
  const call = first.calls[0];
  if (first.reply.stopReason === "error" || !call) console.log("T2 not sent: T1 did not end in a tool call");
  else {
    const second = await turn("T2", [user, first.reply, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: `echo: ${nonce}` }], isError: false, timestamp: Date.now() } as Message], 32);
    const cost = (first.reply.usage.cost?.total ?? 0) + (second!.reply.usage.cost?.total ?? 0);
    console.log(`summary: T1 ${first.reply.stopReason}, T2 ${second!.reply.stopReason}; cache reads T1 ${first.reply.usage.cacheRead}, T2 ${second!.reply.usage.cacheRead}; pi-ai list cost $${cost.toFixed(5)}`);
  }
}
cleanupSessionResources(sessionId);
