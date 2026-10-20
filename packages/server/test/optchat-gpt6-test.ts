/** R-1: what OptChat sends to GPT-6 on the OpenAI platform (an sk- key)
 * through pi-ai 1.3.0's real request builder, with fetch replaced so
 * nothing leaves the process. pi-ai fixes `reasoning.effort` at "medium"
 * and sends the thinking level as a trailing `configuration_update` item;
 * OptChat adds `reasoning.context: "all_turns"` and its own cache key and
 * view breakpoint. Pinned here: that payload, its prefix across thinking
 * levels, and what happens when the provider refuses it: a refusal naming
 * the context is sent again once without it (the configuration item kept),
 * any other refusal is not sent again. Whether OpenAI accepts the pair is
 * untested (a live check, part of P1); this is offline correctness only. */
import assert from "node:assert/strict";
import { createModels, type Message, type Models, type Tool } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { cachedModels, viewPieces } from "../src/optchat-cache.ts";
import { withView } from "../src/optchat.ts";

type Captured = { body: Record<string, unknown> };
const bodies: Captured[] = [];
const refuse = (message: string, param: string | null, code: string) => () =>
  new Response(JSON.stringify({ error: { message, type: "invalid_request_error", param, code } }), { status: 400, headers: { "content-type": "application/json" } });
const captured = refuse("captured", null, "captured");
let respond: () => Response = captured;
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  bodies.push({ body: JSON.parse(String(init?.body ?? "{}")) });
  return respond();
}) as typeof fetch;

process.env.OPENAI_API_KEY = "sk-test";
const platform = createModels();
platform.setProvider(openaiProvider());
const pick = (id: string) => {
  const model = platform.getModels("openai").find(candidate => candidate.id === id);
  assert.ok(model, `pi-ai's catalog has openai/${id}`);
  return model;
};
const GPT6 = ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"];
for (const id of GPT6) {
  assert.equal((pick(id).compat as { supportsMidConvoEffort?: boolean } | undefined)?.supportsMidConvoEffort, true, `${id}: pi-ai sends its level as configuration_update`);
}

const line = (n: number) => `${n}+1|user: ${"x".repeat(240)} ${n}`;
const render = (lines: number) => `<chat>\n${Array.from({ length: lines }, (_, n) => line(n) + "\n").join("")}</chat>`;
const tool: Tool = { name: "zoom", description: "open a line", parameters: { type: "object", properties: {} } as never };
const request = (view: string): Message[] => withView([
  { role: "user", content: "what did I say?", timestamp: 1 },
  { role: "system", content: "", sections: { master: "You are OptChat." }, toolsAdded: [tool], timestamp: 1 },
], viewPieces(view));

type Part = { type: string; prompt_cache_breakpoint?: unknown };
type Item = { type?: string; role?: string; content?: Part[]; reasoning?: unknown };
const input = (body: Record<string, unknown>) => body.input as Item[];
const breakpoints = (body: Record<string, unknown>) => input(body).flatMap((item, at) => (Array.isArray(item.content) ? item.content : []).flatMap((part, k) => part.prompt_cache_breakpoint ? [`${at}:${k}`] : []));
const reasoning = (body: Record<string, unknown>) => body.reasoning as { effort?: string; summary?: string; context?: string };
const send = async (models: Models, id: string, level: "low" | "medium" | "high" | "xhigh", options: object = {}) => {
  bodies.length = 0;
  const reply = await models.completeSimple(pick(id), { messages: request(render(500)) }, { maxRetries: 0, reasoning: level, ...options });
  return { reply, sent: bodies.splice(0).map(entry => entry.body) };
};
const chat = cachedModels(platform, () => "optchat-test");
const compact = cachedModels(platform, () => "optchat-test-compact", { task: false });

{
  // The payload: effort pinned at medium, the level in the last input item,
  // all_turns beside them, the chat's own cache key and view breakpoint;
  // otherwise byte for byte what pi-ai builds.
  for (const id of GPT6) {
    for (const [label, models, key] of [["chat", chat, "optchat-test"], ["compactor", compact, "optchat-test-compact"]] as const) {
      // Pi passes its own per-conversation session id; OptChat's key wins.
      const { sent: [body] } = await send(models, id, "high", { sessionId: "pi-conversation-id" });
      const { sent: [plain] } = await send(platform, id, "high", { sessionId: key });
      assert.ok(body && plain);
      assert.deepEqual(reasoning(body), { effort: "medium", summary: "auto", context: "all_turns" }, `${id} ${label}: effort medium, all_turns`);
      assert.deepEqual(input(body).at(-1), { type: "configuration_update", reasoning: { effort: "high" } }, `${id} ${label}: the level goes last`);
      assert.equal(input(body).filter(item => item.type === "configuration_update").length, 1, "one configuration item, none before it in a fresh turn");
      assert.equal(body.prompt_cache_key, key, `${id} ${label}: OptChat's own cache key`);
      assert.deepEqual(breakpoints(body), ["1:124"], `${id} ${label}: the view's breakpoint`);
      assert.deepEqual(body.prompt_cache_options, label === "chat" ? undefined : { mode: "explicit" });
      assert.equal(JSON.stringify({ ...body, reasoning: plain.reasoning, input: plain.input, prompt_cache_options: plain.prompt_cache_options }), JSON.stringify(plain), `${id} ${label}: otherwise pi-ai's own body`);
      assert.equal(reasoning(plain).context, undefined, "pi-ai itself sends no reasoning.context");
    }
  }
  console.log("ok: GPT-6 on openai: effort medium, configuration_update last, all_turns, OptChat's key and breakpoint");
}

{
  // A change of thinking level changes only the last item: the effort, the
  // context and every input item before it stay byte for byte, so the
  // cached prefix holds across levels.
  const levels: Array<{ level: string; body: Record<string, unknown> }> = [];
  for (const level of ["low", "medium", "high", "xhigh"] as const) levels.push({ level, body: (await send(chat, "gpt-6-sol", level)).sent[0]! });
  const [first] = levels;
  for (const { level, body } of levels) {
    assert.deepEqual(reasoning(body), reasoning(first!.body), `${level}: reasoning unchanged`);
    assert.equal(JSON.stringify(input(body).slice(0, -1)), JSON.stringify(input(first!.body).slice(0, -1)), `${level}: the prefix is byte for byte the same`);
    assert.deepEqual(input(body).at(-1), { type: "configuration_update", reasoning: { effort: level } });
    assert.equal(JSON.stringify(body.tools), JSON.stringify(first!.body.tools));
  }
  console.log("ok: a thinking level change keeps the prefix; only the last item differs");
}

{
  // A ChatGPT sign-in: pi-ai sends the level as reasoning.effort and no
  // configuration item (the sign-in refuses it); all_turns stays.
  const { sent: [body] } = await send(chat, "gpt-6-sol", "high", { apiKey: "chatgpt-oauth-token" });
  assert.ok(body);
  assert.deepEqual(reasoning(body), { effort: "high", summary: "auto", context: "all_turns" });
  assert.ok(!input(body).some(item => item.type === "configuration_update"), "no configuration item for a sign-in");
  console.log("ok: a ChatGPT sign-in gets effort as before and no configuration item");
}

{
  // Refusals. A refusal naming reasoning.context: sent again once, without
  // it; the configuration item and the effort stay, so the retry is the
  // same request but for that field. That model is not sent it again.
  respond = (() => { let n = 0; return () => n++ === 0 ? refuse("Unsupported parameter: 'reasoning.context' is not supported with this model.", "reasoning.context", "unsupported_parameter")() : captured(); })();
  const { sent } = await send(chat, "gpt-6-luna", "high");
  assert.equal(sent.length, 2, "refused by name: one more send, and only one");
  assert.equal(reasoning(sent[0]!).context, "all_turns");
  assert.deepEqual(reasoning(sent[1]!), { effort: "medium", summary: "auto" }, "the retry drops only the context");
  assert.equal(JSON.stringify({ ...sent[1], reasoning: reasoning(sent[0]!) }), JSON.stringify(sent[0]), "and is otherwise the same request");
  assert.deepEqual(input(sent[1]!).at(-1), { type: "configuration_update", reasoning: { effort: "high" } });
  respond = captured;
  const { sent: again } = await send(chat, "gpt-6-luna", "high");
  assert.deepEqual(again.map(body => reasoning(body).context ?? null), [null], "not sent it again");

  // Refused by value only (as Codex words it): the same.
  respond = (() => { let n = 0; return () => n++ === 0 ? refuse("Invalid value: 'all_turns'. Supported values are: 'current_turn'.", null, "invalid_value")() : captured(); })();
  const { sent: byValue } = await send(chat, "gpt-6-astra", "high");
  assert.deepEqual(byValue.map(body => reasoning(body).context ?? null), ["all_turns", null], "refused by value: one more send without it");

  // A refusal that names neither, such as one of the configuration item:
  // not sent again (no blind retry); the turn sees the error. Each turn
  // then fails the same way: whether OpenAI takes this pair is the live
  // check R-1 still owes.
  for (const message of ["Unsupported input item type: 'configuration_update'.", "Invalid value for 'reasoning.effort' with configuration updates."]) {
    respond = refuse(message, null, "invalid_request_error");
    const { reply, sent: refused } = await send(chat, "gpt-6.1-sol", "high");
    assert.equal(refused.length, 1, `${message}: sent once, not again`);
    assert.equal(reasoning(refused[0]!).context, "all_turns");
    assert.equal(reply.stopReason, "error");
    assert.match(reply.errorMessage ?? "", /configuration/);
  }
  // The stream, as Pi calls it: the same single send.
  respond = refuse("Unsupported input item type: 'configuration_update'.", null, "invalid_request_error");
  bodies.length = 0;
  const events: string[] = [];
  const stream = chat.streamSimple(pick("gpt-6.1-sol"), { messages: request(render(500)) }, { maxRetries: 0, reasoning: "high" });
  for await (const event of stream) events.push(event.type);
  assert.equal(bodies.length, 1, "a stream refused for another reason is sent once");
  assert.deepEqual(events, ["error"]);
  // gpt-6.1-sol was never taken as refusing all_turns.
  respond = captured;
  const { sent: still } = await send(chat, "gpt-6.1-sol", "high");
  assert.equal(reasoning(still[0]!).context, "all_turns", "another refusal does not drop all_turns");
  console.log("ok: a context refusal is sent again once without it; any other refusal is not sent again");
}

console.log("optchat gpt-6: ok");
