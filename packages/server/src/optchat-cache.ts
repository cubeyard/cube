/** Prompt caching for OptChat's model calls (spec §3.3). The view is cut
 * into blocks of BLOCK lines, so consecutive turns (and compactor calls)
 * share its start up to the last whole block.
 *
 * - Anthropic: pi-ai marks the system prompt, the last tool and the request
 *   end. Here the last system block keeps its mark (it covers the tools and
 *   any system block before it), the others are dropped, and the last whole
 *   view block gets one: three marks, two for the compactor, whose task is
 *   its own and never read again (uniichat leaves it unmarked too).
 *   Anthropic looks back up to 20 blocks from a mark for an earlier entry,
 *   so the next call finds this one and writes only the lines after it.
 * - OpenAI (Responses, ChatGPT/Codex): caching is by prefix. A stable
 *   `sessionId` becomes `prompt_cache_key` (and Codex's session header), so
 *   requests sharing the view's start go to the same cache.
 * - Single flight, for both: a call whose prefix through its last whole view
 *   block another call is writing, or any start of that prefix, waits until
 *   that call's response begins (its first stream event, when the entry can
 *   be read), then writes only the rest. So compactions started together
 *   pay for what they share once, as uniichat's AskAI.wait.
 *
 * Entries keep pi-ai's default retention ("short"): the spec measured 1-hour
 * entries as not worth it. */
import { createHash } from "node:crypto";
import type { Models } from "@earendil-works/pi-ai";

export const BLOCK = 4;
/** How long a written prefix is taken as cached: the short retention. A
 * guess either way only decides whether a call leads, never what it sends. */
export const TTL_MS = 5 * 60_000;

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
type ResponsesPayload = { model?: string; instructions?: unknown; tools?: unknown; input?: Array<{ role?: string; content?: unknown }> };

/** Blocks without their marks: where a call puts a mark is not part of what it shares. */
const bare = (blocks: unknown) => Array.isArray(blocks) ? blocks.map(block => { const { cache_control: _, ...rest } = block as Block; return rest; }) : blocks;

/** The keys of a prefix: first what precedes the view (the system prompt
 * and tools), then each view block's end through its last whole one, each
 * seeded by the one before. */
function chain(head: unknown, blocks: readonly unknown[]): string[] {
  let key = createHash("sha256").update(JSON.stringify(head)).digest("hex");
  const keys = [key];
  for (const block of bare(blocks) as unknown[]) keys.push(key = createHash("sha256").update(key).update(JSON.stringify(block)).digest("hex"));
  return keys;
}

/** Where a message's view is: the index of its block ending in `</chat>`
 * (0: a view under one whole block), if its first block opens one. */
function viewEnd(content: unknown): number {
  if (!Array.isArray(content) || typeof content[0]?.text !== "string" || !content[0].text.startsWith("<chat>")) return -1;
  return (content as Block[]).findIndex(block => typeof block.text === "string" && block.text.endsWith("</chat>"));
}

/** Marks the last whole view block in an Anthropic Messages request and
 * keeps only the last system mark; with `task: false` the request's end
 * keeps no mark either. A view under one whole block keeps pi-ai's marks
 * (but the end's with `task: false`). Returns the keys of what is marked
 * through the view: the system prompt and tools, then each view block. The
 * view is the leading run of text blocks of the first user message, from
 * `<chat>` to the block that ends with `</chat>`. */
export function markViewPieces(payload: unknown, options: { task?: boolean } = {}): string[] | undefined {
  const params = payload as AnthropicPayload;
  const first = params.messages?.find(message => message.role === "user");
  if (!first) return undefined;
  const last = viewEnd(first.content);
  if (last < 0) return undefined;
  const marker = findMarker(params);
  if (!marker) return undefined;
  const content = first.content as Block[];
  if (options.task === false) {
    for (const message of params.messages ?? []) if (Array.isArray(message.content)) for (const block of message.content) delete block.cache_control;
  }
  if (last > 0) {
    for (const tool of params.tools ?? []) delete tool.cache_control;
    for (const block of params.system ?? []) delete block.cache_control;
    if (params.system?.length) params.system.at(-1)!.cache_control = marker;
    content[last - 1]!.cache_control = marker;
  }
  return chain([params.model, bare(params.tools), bare(params.system)], content.slice(0, last));
}

/** The keys of an OpenAI Responses request's prefix through its last whole
 * view block (no marks: OpenAI caches by prefix). */
export function responsesViewKeys(payload: unknown): string[] | undefined {
  const params = payload as ResponsesPayload;
  const at = params.input?.findIndex(item => item.role === "user") ?? -1;
  if (at < 0) return undefined;
  const content = params.input![at]!.content;
  const last = viewEnd(content);
  if (last < 0) return undefined;
  return chain([params.model, params.tools, params.instructions, params.input!.slice(0, at)], (content as unknown[]).slice(0, last));
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
  onProviderStreamEvent?: (event: unknown, model: never) => unknown;
} | undefined;

/** A prefix written: until when it is taken as cached, or, while its
 * writer's response has not begun, what its waiters wait on. */
type Written = { until: number; ready: Promise<void> | null };

type Flight = { begun: () => void; end: () => void };
const IDLE: Flight = { begun: () => {}, end: () => {} };

const RESPONSES = new Set(["openai-responses", "openai-codex-responses", "azure-openai-responses"]);

/** `models` with OptChat's cache options on every simple request. `task:
 * false` (the compactor) leaves a request's end unmarked. */
export function cachedModels(models: Models, sessionId: () => string, options: { task?: boolean } = {}): Models {
  // Prefixes written, least lately used first.
  const written = new Map<string, Written>();
  /** Waits while another call writes this call's prefix or a start of it;
   * then leads, unless its whole prefix is cached. `begun`: its response
   * began, so the prefix can be read; `end`: it ended, begun or not (one that
   * never began wrote nothing). */
  const flight = async (keys: readonly string[], signal: AbortSignal | undefined): Promise<Flight> => {
    for (;;) {
      if (signal?.aborted) return IDLE;
      const now = Date.now();
      const live = (key: string) => { const entry = written.get(key); return !!entry && (entry.ready !== null || entry.until > now); };
      const k = keys.findLastIndex(live);
      const got = k < 0 ? undefined : written.get(keys[k]!)!;
      if (got?.ready) {
        let stop = () => {};
        await Promise.race([got.ready, new Promise<void>(resolve => { stop = resolve; signal?.addEventListener("abort", stop, { once: true }); })]);
        signal?.removeEventListener("abort", stop);
        continue;
      }
      if (got) { got.until = now + TTL_MS; written.delete(keys[k]!); written.set(keys[k]!, got); }
      if (k === keys.length - 1) return IDLE;
      for (const [key, entry] of written) { if (entry.ready !== null || entry.until >= now) break; written.delete(key); }
      // It writes its last key and, if that is not cached, the system
      // prompt's (Anthropic writes an entry there too): a call of a shorter
      // view waits for it as well.
      const own: Written = { until: 0, ready: null };
      const mine = [...new Set(k < 0 ? [keys[0]!, keys.at(-1)!] : [keys.at(-1)!])];
      let free = () => {};
      own.ready = new Promise<void>(resolve => { free = resolve; });
      for (const key of mine) written.set(key, own);
      return {
        begun: () => { if (own.ready === null) return; own.ready = null; own.until = Date.now() + TTL_MS; free(); },
        end: () => {
          if (own.ready === null) return;
          for (const key of mine) if (written.get(key) === own) written.delete(key);
          own.ready = null;
          free();
        },
      };
    }
  };
  const withCache = (callOptions: Options, api: string) => {
    let lead = IDLE;
    return { end: () => lead.end(), options: {
      ...callOptions,
      sessionId: callOptions?.sessionId ?? sessionId(),
      onPayload: async (payload: unknown, model: never) => {
        const next = (await callOptions?.onPayload?.(payload, model)) ?? payload;
        const keys = api === "anthropic-messages" ? markViewPieces(next, options) : RESPONSES.has(api) ? responsesViewKeys(next) : undefined;
        lead.end();
        if (keys?.length) lead = await flight(keys, callOptions?.signal);
        return next;
      },
      // The entry can be read once the writer's response begins: its first
      // stream event, not its headers.
      onProviderStreamEvent: async (event: unknown, model: never) => {
        lead.begun();
        await callOptions?.onProviderStreamEvent?.(event, model);
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
          end.then(call.end, call.end);
          return result;
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
