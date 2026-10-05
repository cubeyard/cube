/** Prompt caching for OptChat's model calls (spec §8). The view is cut into
 * pieces at the last line end before 50,000, 80,000 and 100,000 characters,
 * so consecutive turns (and compactor calls) share its start.
 *
 * - Anthropic: pi-ai marks the system prompt, the last tool and the last user
 *   message. Here each view piece but the last also gets a mark, and the system
 *   and tool marks are dropped, since the first view mark covers them. That
 *   keeps the request within Anthropic's four marks: three in the view plus
 *   the request end.
 * - OpenAI (Responses, ChatGPT/Codex): caching is by prefix. A stable
 *   `sessionId` becomes `prompt_cache_key` (and Codex's session header), so
 *   requests sharing the view's start go to the same cache.
 *
 * Entries keep pi-ai's default retention ("short"): the spec measured 1-hour
 * entries as not worth it. */
import type { Models } from "@earendil-works/pi-ai";

export const MARKS = [50_000, 80_000, 100_000] as const;

/** The rendered view as pieces that end at a line end before each mark. */
export function viewPieces(view: string, marks: readonly number[] = MARKS): string[] {
  const pieces: string[] = [];
  let from = 0;
  for (const mark of marks) {
    if (mark >= view.length) break;
    const cut = view.lastIndexOf("\n", mark - 1) + 1;
    if (cut <= from) continue;
    pieces.push(view.slice(from, cut));
    from = cut;
  }
  pieces.push(view.slice(from));
  return pieces;
}

type Block = { type?: string; text?: string; cache_control?: unknown };
type AnthropicPayload = { system?: Block[]; tools?: Block[]; messages?: Array<{ role: string; content: string | Block[] }> };

/** Marks the view's pieces in an Anthropic Messages request. The view is the
 * leading run of text blocks of the first user message, from `<chat>` to the
 * block that ends with `</chat>`; its last piece is left to the end mark. */
export function markViewPieces(payload: unknown): unknown {
  const params = payload as AnthropicPayload;
  const first = params.messages?.find(message => message.role === "user");
  if (!first || !Array.isArray(first.content) || !first.content[0]?.text?.startsWith("<chat>")) return undefined;
  const last = first.content.findIndex(block => block.type === "text" && block.text?.endsWith("</chat>"));
  if (last <= 0) return undefined;
  const marker = findMarker(params);
  if (!marker) return undefined;
  for (const block of params.system ?? []) delete block.cache_control;
  for (const tool of params.tools ?? []) delete tool.cache_control;
  for (let k = 0; k < last; k++) first.content[k]!.cache_control = marker;
  return params;
}

/** pi-ai's own mark (it knows the retention), wherever it put one. */
function findMarker(params: AnthropicPayload): unknown {
  const blocks = [...(params.system ?? []), ...(params.tools ?? []),
    ...(params.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content : [])];
  return blocks.find(block => block.cache_control)?.cache_control;
}

/** `models` with OptChat's cache options on every simple request. */
export function cachedModels(models: Models, sessionId: () => string): Models {
  const withCache = <O extends { sessionId?: string; onPayload?: (payload: unknown, model: never) => unknown } | undefined>(options: O, api: string) => ({
    ...options,
    sessionId: options?.sessionId ?? sessionId(),
    onPayload: async (payload: unknown, model: never) => {
      const next = (await options?.onPayload?.(payload, model)) ?? payload;
      return api === "anthropic-messages" ? (markViewPieces(next) ?? next) : next;
    },
  });
  return new Proxy(models, {
    get(target, property, receiver) {
      if (property === "streamSimple" || property === "completeSimple") {
        return (model: { api: string }, context: unknown, options?: object) =>
          (target[property] as (...args: unknown[]) => unknown).call(target, model, context, withCache(options as never, model.api));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
