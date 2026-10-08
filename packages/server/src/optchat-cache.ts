/** Prompt caching for OptChat's model calls (spec §3.3). The view is cut
 * into blocks of BLOCK lines, so consecutive turns (and compactor calls)
 * share its start up to the last whole block.
 *
 * - Anthropic: pi-ai marks the system prompt, the last tool and the request
 *   end. Here the last system block keeps its mark (it covers the tools and
 *   any system block before it), the others are dropped, and the last whole
 *   view block gets one: three marks. Anthropic looks back up to 20 blocks
 *   from a mark for an earlier entry, so the next call finds this one and
 *   writes only the lines after it. A call whose marked prefix another call
 *   is writing waits until that call's response starts, so concurrent
 *   compactions pay for the prefix once.
 * - OpenAI (Responses, ChatGPT/Codex): caching is by prefix. A stable
 *   `sessionId` becomes `prompt_cache_key` (and Codex's session header), so
 *   requests sharing the view's start go to the same cache.
 *
 * Entries keep pi-ai's default retention ("short"): the spec measured 1-hour
 * entries as not worth it. */
import { createHash } from "node:crypto";
import type { Models } from "@earendil-works/pi-ai";

export const BLOCK = 4;

/** The rendered view in pieces of BLOCK lines; `<chat>` rides with the first
 * and `</chat>` with the remainder, which is the last piece. */
export function viewPieces(view: string): string[] {
  const pieces: string[] = [];
  let from = 0, lines = 0;
  for (let at = view.indexOf("\n", view.indexOf("\n") + 1); at >= 0; at = view.indexOf("\n", at + 1)) {
    if (++lines % BLOCK) continue;
    pieces.push(view.slice(from, at + 1));
    from = at + 1;
  }
  pieces.push(view.slice(from));
  return pieces;
}

type Block = { type?: string; text?: string; cache_control?: unknown };
type AnthropicPayload = { model?: string; system?: Block[]; tools?: Block[]; messages?: Array<{ role: string; content: string | Block[] }> };

/** Marks the last whole view block in an Anthropic Messages request and
 * keeps only the last system mark; returns the marked prefix's key. The view
 * is the leading run of text blocks of the first user message, from `<chat>`
 * to the block that ends with `</chat>`. */
export function markViewPieces(payload: unknown): string | undefined {
  const params = payload as AnthropicPayload;
  const first = params.messages?.find(message => message.role === "user");
  if (!first || !Array.isArray(first.content) || !first.content[0]?.text?.startsWith("<chat>")) return undefined;
  const last = first.content.findIndex(block => block.type === "text" && block.text?.endsWith("</chat>"));
  if (last <= 0) return undefined;
  const marker = findMarker(params);
  if (!marker) return undefined;
  for (const tool of params.tools ?? []) delete tool.cache_control;
  for (const block of params.system ?? []) delete block.cache_control;
  if (params.system?.length) params.system.at(-1)!.cache_control = marker;
  first.content[last - 1]!.cache_control = marker;
  return createHash("sha256")
    .update(JSON.stringify([params.model, params.tools, params.system, first.content.slice(0, last)]))
    .digest("hex");
}

/** pi-ai's own mark (it knows the retention), wherever it put one. */
function findMarker(params: AnthropicPayload): unknown {
  const blocks = [...(params.system ?? []), ...(params.tools ?? []),
    ...(params.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : [])];
  return blocks.find(block => block.cache_control)?.cache_control;
}

type Options = {
  sessionId?: string;
  signal?: AbortSignal;
  onPayload?: (payload: unknown, model: never) => unknown;
  onResponse?: (response: unknown, model: never) => unknown;
} | undefined;

/** `models` with OptChat's cache options on every simple request. */
export function cachedModels(models: Models, sessionId: () => string): Models {
  // Marked prefixes being written, until their writer's response starts.
  const writing = new Map<string, Promise<void>>();
  const withCache = (options: Options, api: string) => {
    let release = () => {};
    return { release: () => release(), options: {
      ...options,
      sessionId: options?.sessionId ?? sessionId(),
      onPayload: async (payload: unknown, model: never) => {
        const next = (await options?.onPayload?.(payload, model)) ?? payload;
        if (api !== "anthropic-messages") return next;
        const key = markViewPieces(next);
        if (key === undefined) return next;
        const writer = writing.get(key);
        if (writer) {
          const signal = options?.signal;
          if (!signal?.aborted) {
            let stop = () => {};
            await Promise.race([writer, new Promise<void>(resolve => { stop = resolve; signal?.addEventListener("abort", stop, { once: true }); })]);
            signal?.removeEventListener("abort", stop);
          }
        } else {
          let done = () => {};
          const written = new Promise<void>(resolve => { done = resolve; });
          writing.set(key, written);
          release = () => {
            release = () => {};
            if (writing.get(key) === written) writing.delete(key);
            done();
          };
        }
        return next;
      },
      onResponse: async (response: unknown, model: never) => {
        release();
        await options?.onResponse?.(response, model);
      },
    } };
  };
  return new Proxy(models, {
    get(target, property, receiver) {
      if (property === "streamSimple" || property === "completeSimple") {
        return (model: { api: string }, context: unknown, options?: object) => {
          const call = withCache(options as Options, model.api);
          const result = (target[property] as (...args: unknown[]) => unknown).call(target, model, context, call.options);
          const end = property === "completeSimple" ? result as Promise<unknown> : (result as { result(): Promise<unknown> }).result();
          end.then(call.release, call.release);
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
