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
 *   requests sharing the view's start go to the same cache. Where pi-ai
 *   flags a model as taking `prompt_cache_options` (the platform's GPT-5.6+),
 *   the last whole view block gets an explicit `prompt_cache_breakpoint`,
 *   and the compactor's requests set `mode: "explicit"`, which drops the
 *   implicit breakpoint at the request's end: its task is not written, as
 *   uniichat's OpenAI.body. Codex and Azure flag no model, so they go by
 *   prefix only.
 * - Single flight, for both: a call whose prefix through its last whole view
 *   block another call is writing, or any start of that prefix, waits until
 *   that call's response begins (`message_start`, or the Responses APIs'
 *   first `response.output_item.added`: the prompt was read, so the entry
 *   can be), then writes only the rest. No other event counts:
 *   `response.created` comes when the request is accepted, and an `error`
 *   event wrote nothing. So compactions started together pay for what they
 *   share once, as uniichat's AskAI.wait.
 * - OpenAI reasoning: `reasoning.context: "all_turns"` (uniichat sends it),
 *   so a message steered into a tool round keeps the earlier reasoning in
 *   context and the prefix. Sent only to models that take it by default
 *   (GPT-5.6+, the SDK's `Reasoning.context`); older ones are not sent it
 *   until a live check shows they accept it. A refusal naming the field is
 *   retried once without it, and the model is not sent it again.
 *
 * Entries keep pi-ai's default retention ("short"): the spec measured 1-hour
 * entries as not worth it. */
import { createHash } from "node:crypto";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent, type AssistantMessageEventStream, type Models } from "@earendil-works/pi-ai";

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

type Block = { type?: string; text?: string; cache_control?: unknown; prompt_cache_breakpoint?: unknown };
type AnthropicPayload = { model?: string; system?: Block[]; tools?: Block[]; messages?: Array<{ role: string; content: string | Block[] }> };
type ResponsesPayload = { model?: string; instructions?: unknown; tools?: unknown; input?: Array<{ role?: string; content?: unknown }>; prompt_cache_options?: Record<string, unknown>; reasoning?: Record<string, unknown> };

/** Blocks without their marks: where a call puts a mark is not part of what it shares. */
const bare = (blocks: unknown) => Array.isArray(blocks) ? blocks.map(block => { const { cache_control: _, prompt_cache_breakpoint: __, ...rest } = block as Block; return rest; }) : blocks;

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

/** For a model that takes explicit breakpoints: marks the last whole view
 * block of an OpenAI Responses request, and with `task: false` sets
 * `mode: "explicit"`, so the request's end gets no implicit breakpoint. */
export function markResponsesView(payload: unknown, options: { task?: boolean } = {}): void {
  const params = payload as ResponsesPayload;
  if (options.task === false) params.prompt_cache_options = { ...params.prompt_cache_options, mode: "explicit" };
  const content = params.input?.find(item => item.role === "user")?.content;
  const last = viewEnd(content);
  if (last > 0) (content as Block[])[last - 1]!.prompt_cache_breakpoint = { mode: "explicit" };
}

type OpenAIModel = { id: string; api: string; provider: string; baseUrl?: string; compat?: { supportsExplicitPromptCacheMode?: boolean } };

/** pi-ai leaves `prompt_cache_options` out for a ChatGPT sign-in on the
 * platform (it refuses them); so do the breakpoints. */
const signIn = (model: OpenAIModel, apiKey: string | undefined) =>
  model.provider === "openai" && model.baseUrl === "https://api.openai.com/v1" && apiKey !== undefined && !apiKey.startsWith("sk-");

/** A model whose reasoning context is `all_turns` by default (GPT-5.6 and
 * later, or one pi-ai flags as such); older models default to
 * `current_turn` and may refuse the field, so they are not sent it. */
export function takesAllTurns(model: OpenAIModel): boolean {
  if (model.api !== "openai-responses" && model.api !== "openai-codex-responses") return false;
  if (model.compat?.supportsExplicitPromptCacheMode) return true;
  const version = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(model.id);
  if (!version) return false;
  const major = Number(version[1]), minor = Number(version[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 6);
}

/** Models that refused `reasoning.context`, for as long as the process runs. */
const refusedAllTurns = new Set<string>();
const modelKey = (model: OpenAIModel) => `${model.provider}/${model.api}/${model.id}`;
const refusal = (message: AssistantMessage, sent: boolean) => sent && message.stopReason === "error" && /reasoning\.context/i.test(message.errorMessage ?? "");

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
/** Per API, the stream event that says the response began on its prompt
 * (uniichat's `begun`). */
const BEGUN: Record<string, string> = {
  "anthropic-messages": "message_start",
  "openai-responses": "response.output_item.added",
  "openai-codex-responses": "response.output_item.added",
  "azure-openai-responses": "response.output_item.added",
};

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
  const withCache = (callOptions: Options, model: OpenAIModel) => {
    let lead = IDLE;
    const call = { allTurns: false, end: () => lead.end(), options: {
      ...callOptions,
      sessionId: callOptions?.sessionId ?? sessionId(),
      onPayload: async (payload: unknown, piModel: never) => {
        const next = (await callOptions?.onPayload?.(payload, piModel)) ?? payload;
        const api = model.api;
        const keys = api === "anthropic-messages" ? markViewPieces(next, options) : RESPONSES.has(api) ? responsesViewKeys(next) : undefined;
        if (api === "openai-responses" && model.compat?.supportsExplicitPromptCacheMode && !signIn(model, (callOptions as { apiKey?: string } | undefined)?.apiKey)) markResponsesView(next, options);
        const body = next as ResponsesPayload;
        call.allTurns = takesAllTurns(model) && !refusedAllTurns.has(modelKey(model)) && typeof body.reasoning === "object" && body.reasoning !== null;
        if (call.allTurns) body.reasoning = { ...body.reasoning, context: "all_turns" };
        lead.end();
        if (keys?.length) lead = await flight(keys, callOptions?.signal);
        return next;
      },
      // The entry can be read once the writer's response has begun on its
      // prompt: not on its headers, nor on an event that comes before that
      // (`response.created`) or instead of it (`error`).
      onProviderStreamEvent: async (event: unknown, piModel: never) => {
        if ((event as { type?: unknown } | null)?.type === BEGUN[model.api]) lead.begun();
        await callOptions?.onProviderStreamEvent?.(event, piModel);
      },
    } };
    return call;
  };
  const complete = async (target: Models, model: OpenAIModel, context: unknown, options: Options): Promise<AssistantMessage> => {
    for (let attempt = 0; ; attempt++) {
      const call = withCache(options, model);
      const result = (target.completeSimple as (...args: unknown[]) => Promise<AssistantMessage>).call(target, model, context, call.options);
      result.then(call.end, call.end);
      const reply = await result;
      if (attempt > 0 || !refusal(reply, call.allTurns)) return reply;
      refusedAllTurns.add(modelKey(model));
    }
  };
  /** The stream of one call, sent again once without `reasoning.context`
   * when it is refused for it before anything else came. */
  const stream = (target: Models, model: OpenAIModel, context: unknown, options: Options): AssistantMessageEventStream => {
    const once = () => {
      const call = withCache(options, model);
      const inner = (target.streamSimple as (...args: unknown[]) => AssistantMessageEventStream).call(target, model, context, call.options);
      inner.result().then(call.end, call.end);
      return { call, inner };
    };
    const first = once();
    if (!takesAllTurns(model)) return first.inner;
    const outer = createAssistantMessageEventStream();
    void (async () => {
      let { call, inner } = first;
      for (let attempt = 0; ; attempt++) {
        const held: AssistantMessageEvent[] = [];
        let open = false, retry = false;
        for await (const event of inner) {
          if (!open && event.type === "start") { held.push(event); continue; }
          if (!open && attempt === 0 && event.type === "error" && refusal(event.error, call.allTurns)) { retry = true; break; }
          open = true;
          for (const earlier of held.splice(0)) outer.push(earlier);
          outer.push(event);
        }
        if (!retry) { for (const earlier of held) outer.push(earlier); break; }
        refusedAllTurns.add(modelKey(model));
        ({ call, inner } = once());
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
      if (property === "completeSimple") return (model: OpenAIModel, context: unknown, options?: object) => complete(target, model, context, options as Options);
      if (property === "streamSimple") return (model: OpenAIModel, context: unknown, options?: object) => stream(target, model, context, options as Options);
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
