/** P1 on the Codex subscription, v2: where does a Codex prompt-cache read
 * happen? Four requests through
 * OptChat's own wrappers (cachedModels over boundedOutput) on the host's own
 * login (`~/.pi/agent`, as cubed reads it), on the transport cube uses (pi-ai's
 * default). Not part of the repository: copy it to packages/server/ of the
 * pinned checkout and run it from there.
 *
 * Every case has the same ~5.8k-token prefix and sessionId (a fresh nonce
 * per run) and its own last line:
 *   W1 WebSocket (cube's default, "auto"), new connection    cold write
 *   W2 WebSocket, the same connection reused (as v1's C2)    v1 read 0 here
 *   S3 SSE (one HTTP POST)                                   is the entry there?
 *   W4 WebSocket, a new connection (W1/W2's closed first)    reuse vs connection
 * 3 s between cases. All connections are released at the end, so the
 * process exits by itself (v1 held a 5-minute idle socket).
 *
 * One body per case: a second build (cachedModels' retry without
 * all_turns, a transport fallback rebuilding the body) is refused before it
 * is sent and reported. Output is cut at 16 tokens. Nothing is printed but
 * the model, the fields under test, HTTP-level results, usage and redacted
 * error text.
 *
 *   node p1-luna-cache.ts --provider openai-codex --model gpt-6-luna          (dry: builds all four bodies, sends nothing)
 *   node p1-luna-cache.ts --provider openai-codex --model gpt-6-luna --send
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { cleanupSessionResources, type Models } from "@earendil-works/pi-ai";
import { setTimeout as delay } from "node:timers/promises";
import { createModelRuntime } from "./src/models.ts";
import { cachedModels, viewPieces } from "./src/optchat-cache.ts";
import { boundedOutput } from "./src/optchat-output.ts";

const arg = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const send = process.argv.includes("--send");
const provider = arg("--provider") ?? "openai-codex";
const id = arg("--model");
assert.ok(id, "--model <id>, the Luna model cube is configured with");

const redact = (text: string) => text
  .replace(/sk-[A-Za-z0-9_*.\-…]+/g, "sk-[redacted]")
  .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt redacted]")
  .replace(/Bearer\s+\S+/gi, "Bearer [redacted]");

if (!send) {
  // Dry: the same loader on a throwaway agent dir with a stand-in sign-in
  // (a JWT with an account id, never valid), and no network.
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p1-dry-"));
  const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "dry-run" }, exp: 4102444800 })).toString("base64url");
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access: `eyJhbGciOiJub25lIn0.${claims}.x`, refresh: "dry", expires: 4102444800000, accountId: "dry-run" } }));
  process.env.PI_CODING_AGENT_DIR = dir;
  globalThis.fetch = (async () => { throw new Error("dry: nothing is sent"); }) as typeof fetch;
}
const real = await createModelRuntime() as unknown as Models;
const model = real.getModel(provider as never, id);
assert.ok(model, `${provider}/${id} is offered on this login`);

// The shared prefix: a nonce makes it new, so C1 can't read an older entry.
const nonce = randomBytes(8).toString("hex");
const systemPrompt = `P1 cache probe ${nonce}. You answer with the single word the last line asks for.`;
const lines = Array.from({ length: 160 }, (_, i) => `${i} probe ${nonce} line ${i}: the quick brown fox jumps over the lazy dog, then counts ${i * 7} pebbles by the river.`);
const view = `<chat>\n${lines.join("\n")}\n</chat>`;
const blocks = viewPieces(view).map(text => ({ type: "text" as const, text }));
const sessionId = `optchat-p1-luna-${nonce}`;

type Sent = { body?: Record<string, unknown>; builds: number };
const results: Array<Record<string, unknown> & { name: string }> = [];
const cases = [["W1", "Reply with OK.", "auto"], ["W2", "Reply with YES.", "auto"], ["S3", "Reply with NO.", "sse"], ["W4", "Reply with DONE.", "auto"]] as const;
for (const [name, task, transport] of cases) {
  if (name === "W4") cleanupSessionResources(sessionId);
  if (name !== "W1" && send) await delay(3000);
  const sent: Sent = { builds: 0 };
  const inner = new Proxy(real, { get(target, property, receiver) {
    if (property !== "streamSimple") { const value = Reflect.get(target, property, receiver); return typeof value === "function" ? value.bind(target) : value; }
    return (m: never, context: never, options: { onPayload?: (payload: unknown, model: never) => unknown }) => target.streamSimple(m, context, { ...options, maxRetries: 0, transport,
      onPayload: async (payload: unknown, piModel: never) => {
        const next = ((await options.onPayload?.(payload, piModel)) ?? payload) as Record<string, unknown>;
        if (++sent.builds > 1) throw new Error(`${name}: a second body was built; refused, not sent`);
        sent.body = next;
        if (!send) throw new Error("dry: captured");
        return next;
      } } as never);
  } }) as Models;
  const chat = cachedModels(boundedOutput(inner), () => sessionId);
  const reply = await chat.streamSimple(model, { systemPrompt, messages: [{ role: "user", content: [...blocks, { type: "text", text: task }], timestamp: Date.now() }] } as never,
    { reasoning: "low", maxTokens: 16 }).result();
  assert.ok(sent.body, `${name}: a body was built`);
  const body = sent.body as { model?: string; reasoning?: unknown; prompt_cache_key?: string; max_output_tokens?: unknown; input?: unknown[] };
  const fields = { transport, model: body.model, reasoning: body.reasoning, prompt_cache_key: body.prompt_cache_key === sessionId ? "the session id" : body.prompt_cache_key ? "other" : "none",
    max_output_tokens: body.max_output_tokens ?? null, bytes: JSON.stringify(body).length, builds: sent.builds };
  if (!send) { console.log(`${name} (dry, not sent): ${JSON.stringify(fields)}`); continue; }
  const out = { ...fields, stop: reply.stopReason, raw: reply.rawStopReason ?? null,
    usage: { input: reply.usage.input, output: reply.usage.output, cacheRead: reply.usage.cacheRead, cacheWrite: reply.usage.cacheWrite },
    text: reply.content.filter(block => block.type === "text").map(block => (block as { text: string }).text).join("").slice(0, 40),
    error: reply.errorMessage ? redact(reply.errorMessage) : null,
    diagnostics: (reply.diagnostics ?? []).map(diagnostic => `${diagnostic.type}${diagnostic.details?.fallbackTransport ? ` -> ${diagnostic.details.fallbackTransport}` : ""}`) };
  results.push({ name, ...out });
  console.log(`${name} sent: ${JSON.stringify(out)}`);
  if (reply.stopReason === "error") break;
}
cleanupSessionResources(sessionId);
if (send) console.log(`cache reads: ${results.map(result => `${result.name} ${(result.usage as { cacheRead: number }).cacheRead}`).join(", ")}`);
