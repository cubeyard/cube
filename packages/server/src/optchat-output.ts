/** OptChat's output bound where the wire carries none. pi-ai sends the
 * call's `maxTokens` as `max_tokens` / `max_output_tokens` /
 * `maxOutputTokens`, except where the API refuses the field: a ChatGPT
 * sign-in (Codex, or `openai` signed in). There an answer is bounded only
 * by the model, so the call's cost has no ceiling. This guard, beneath
 * `cachedModels`, looks at the request as it is sent; when it carries no
 * output cap, it counts the output as it streams (text, thinking and tool
 * call arguments, at two characters a token, as the compactor sizes its
 * lines) and, past the call's `maxTokens`, aborts the call and ends it as a
 * `length` stop with what came: the compactor never uses such an answer,
 * and the chat's turn ends there as it would at a wire cap.
 *
 * What it cannot see: reasoning the provider does not stream (Codex sends
 * summaries only). That is bounded by the call's reasoning effort, not
 * here. A call with a cap on the wire is passed through untouched. */
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Models } from "@earendil-works/pi-ai";

/** The chat's output cap per request (O1): the room an answer, its tool
 * calls and adaptive thinking share; pi-ai would otherwise send the model's
 * maximum (128,000 on recent models). */
export const CHAT_OUTPUT_TOKENS = 32_000;
/** Characters of streamed output counted as one token. */
const CHARS_PER_TOKEN = 2;
const WIRE_CAPS = ["max_tokens", "max_output_tokens", "max_completion_tokens"] as const;

type Options = { maxTokens?: number; signal?: AbortSignal; onPayload?: (payload: unknown, model: never) => unknown } & Record<string, unknown>;

/** Whether the request as sent bounds its output. */
export function wireCapped(payload: unknown): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const body = payload as Record<string, unknown> & { config?: { maxOutputTokens?: unknown }; generationConfig?: { maxOutputTokens?: unknown }; inferenceConfig?: { maxTokens?: unknown } };
  // Anthropic, OpenAI and compatible; Gemini (the SDK's config, or the REST
  // generationConfig); Bedrock.
  return WIRE_CAPS.some(key => typeof body[key] === "number") || typeof body.config?.maxOutputTokens === "number"
    || typeof body.generationConfig?.maxOutputTokens === "number" || typeof body.inferenceConfig?.maxTokens === "number";
}

/** `cap`: the cap of a call that names none (the chat's: Pi passes none).
 * No call is capped above its model's own maximum (pi-ai sends that when
 * no cap is given). `onCapped`: a call this guard stopped, by
 * `provider/model`: its provider reports no usage for it, so what it cost
 * is unknown. */
export function boundedOutput(models: Models, cap?: number, onCapped?: (model: string) => void): Models {
  const stream = (target: Models, model: { api: string; provider: string; id: string; maxTokens?: number }, context: unknown, given: Options = {}): AssistantMessageEventStream => {
    const wanted = given.maxTokens || cap;
    const limit = wanted && model.maxTokens && model.maxTokens > 0 ? Math.min(wanted, model.maxTokens) : wanted;
    const options: Options = limit ? { ...given, maxTokens: limit } : given;
    if (!limit) return (target.streamSimple as (...args: unknown[]) => AssistantMessageEventStream).call(target, model, context, options);
    const stop = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, stop.signal]) : stop.signal;
    let guarded = false;
    const inner = (target.streamSimple as (...args: unknown[]) => AssistantMessageEventStream).call(target, model, context, {
      ...options, signal,
      onPayload: async (payload: unknown, piModel: never) => {
        const next = (await options.onPayload?.(payload, piModel)) ?? payload;
        guarded = !wireCapped(next);
        return next;
      },
    });
    const outer = createAssistantMessageEventStream();
    void (async () => {
      let out = 0, tripped = false;
      for await (const event of inner) {
        if (tripped) {
          // The abort's own end, with what came before it: a length stop.
          if (event.type === "error" || event.type === "done") {
            const partial = event.type === "error" ? event.error : event.message;
            const message: AssistantMessage = { ...partial, stopReason: "length", errorMessage: `cube stopped the answer at its output cap (${limit} tokens): the provider takes no cap of its own` };
            outer.push({ type: "done", reason: "length", message });
            try { onCapped?.(`${model.provider}/${model.id}`); } catch { /* counting is the caller's; the stream is done */ }
            break;
          }
          continue;
        }
        outer.push(event);
        if (guarded && (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta")) {
          out += event.delta.length;
          if (out / CHARS_PER_TOKEN > limit) { tripped = true; stop.abort(new Error("output cap")); }
        }
      }
      outer.end();
    })().catch(error => {
      outer.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: String(error), timestamp: Date.now() } as AssistantMessage });
      outer.end();
    });
    return outer;
  };
  return new Proxy(models, {
    get(target, property, receiver) {
      if (property === "streamSimple") return (model: never, context: unknown, options?: object) => stream(target, model, context, options as Options);
      // Through the stream, so the guard sees it.
      if (property === "completeSimple") return (model: never, context: unknown, options?: object) => stream(target, model, context, options as Options).result();
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
