/** Per-call and per-turn telemetry from the records the agents already keep,
 * content-free, for offline cost and performance analysis.
 *
 * The same stores usage.ts reads, at a finer grain: Pi's `pi.assistant`
 * entries (one per response, failed attempts included) and Claude Code's
 * stream-json lines in claude.sqlite (assistant frames by `message.id`, the
 * `result` that ends a turn, `api_retry`, `compact_boundary`,
 * `rate_limit_event`). Thread totals stay usage.ts's: a thread's `ledger` is
 * its reading, and the gap between it and the calls says what the calls miss.
 *
 * Only counters, ids, times, model names and fixed reasons leave here: never
 * text, tool arguments, error messages or paths. A figure no record gives is
 * null, never zero. Money is an estimate (`estimatedUsd`); billed amounts are
 * not known to cube. A cache read says the provider served part of a prompt
 * from its cache, not which bytes were the same as before. This file is pure;
 * telemetry-export.ts reads the stores. */
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { claudeLines, piLines, type ClaudeTurn, type UsageLine } from "./usage.ts";

export const TELEMETRY_SCHEMA = "cube.telemetry/1";

export type Agent = "pi" | "claude-code";
/** A counter, or null when no record gives it. */
type Known = number | null;

export interface Tokens { input: Known; output: Known; cacheRead: Known; cacheWrite: Known; cacheWrite1h: Known; reasoning: Known }

/** One model request: one Pi response or attempt, one Claude Code `message.id`. */
export interface ModelCall {
  kind: "call";
  /** Stable across re-reads: `pi:<thread>:<conversation>:<entry>` or `claude:<thread>:<message id>`. */
  id: string;
  thread: string;
  agent: Agent;
  /** The turn it belongs to (a Turn's id). */
  turn: string | null;
  /** main loop, a Claude Code subagent, or another Pi conversation. */
  source: "main" | "subagent" | "other";
  provider: string | null;
  model: string | null;
  responseModel: string | null;
  responseId: string | null;
  /** Epoch ms. Pi: when the request started. Claude Code: its first frame's
   * `timestamp`, which Claude Code calls display-only. */
  startedAt: Known;
  /** Pi only: request start to end, monotonic, provider retries inside it. */
  durationMs: Known;
  /** Claude Code's streamed frames carry input and cache counts but not the final output: output is null there. */
  tokens: Tokens;
  /** Pi: the catalog price when the response was recorded, null when unpriced. Claude Code prices only per process. */
  estimatedUsd: Known;
  stopReason: string | null;
  /** An error response (Pi stopReason "error", a Claude Code error frame). */
  failed: boolean;
}

/** One cube turn: a Claude Code submission, or a Pi user input and the responses after it. */
export interface Turn {
  kind: "turn";
  id: string;
  thread: string;
  agent: Agent;
  /** Claude Code: the submission's state; Pi: null. */
  state: string | null;
  /** Epoch ms: when cubed took the turn (Claude Code) or its first request started (Pi). */
  startedAt: Known;
  calls: number;
  failedCalls: number;
  /** Claude Code `api_retry` lines in the turn; Pi: null (its failed attempts are calls). */
  retries: Known;
  /** Claude Code `result` fields; null without a result. */
  results: number;
  durationMs: Known;
  apiDurationMs: Known;
  ttftMs: Known;
  modelRounds: Known;
  stopReason: string | null;
  terminalReason: string | null;
  error: boolean | null;
  /** Claude Code: `result.usage`, the main loop only; Pi: the sum of its calls. */
  tokens: Tokens;
  steers: { queued: number; consumed: number; dropped: number } | null;
}

export type TelemetryEvent =
  | { kind: "retry"; thread: string; turn: string | null; seq: number; attempt: Known; maxRetries: Known; delayMs: Known; status: Known; error: string | null }
  | { kind: "compaction"; thread: string; turn: string | null; seq: number; trigger: string | null; preTokens: Known; postTokens: Known; durationMs: Known }
  | { kind: "rate-limit"; thread: string; turn: string | null; seq: number; status: string | null; limit: string | null; utilization: Known; overage: boolean | null }
  | { kind: "process"; thread: string; turn: string | null; seq: number; version: string | null; model: string | null }
  | { kind: "tool"; thread: string; turn: string | null; seq: number; name: string; durationMs: Known; failed: boolean };

/** One thread: what its records cover, and usage.ts's totals beside the calls'. */
export interface ThreadTelemetry {
  kind: "thread";
  schema: typeof TELEMETRY_SCHEMA;
  thread: string;
  agent: Agent;
  versions: string[];
  calls: ModelCall[];
  turns: Turn[];
  events: TelemetryEvent[];
  /** usage.ts's reading of the same store. */
  ledger: { lines: UsageLine[]; unknownTurns: number; notes: string[] };
  /** Ledger minus the sum of the calls, per counter; null when a call lacks it. */
  gap: Omit<Tokens, "cacheWrite1h" | "reasoning">;
}

const num = (value: unknown): Known => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
/** A fixed reason or name, never free text. */
const word = (value: unknown): string | null => typeof value === "string" && /^[A-Za-z0-9_.:/<>-]{1,80}$/.test(value) ? value : null;
const time = (value: unknown): Known => typeof value === "string" ? num(Date.parse(value)) : null;
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const unknownTokens = (): Tokens => ({ input: null, output: null, cacheRead: null, cacheWrite: null, cacheWrite1h: null, reasoning: null });

/** Adds counters; a sum is null once any part is. */
function sumTokens(items: readonly Tokens[]): Tokens {
  const sum = (key: keyof Tokens) => items.length && items.every(item => item[key] !== null) ? items.reduce((total, item) => total + item[key]!, 0) : null;
  return { input: sum("input"), output: sum("output"), cacheRead: sum("cacheRead"), cacheWrite: sum("cacheWrite"), cacheWrite1h: sum("cacheWrite1h"), reasoning: sum("reasoning") };
}

/** An error frame without counters is no response the ledger counts either. */
const counted = (call: ModelCall) => !(call.failed && call.tokens.input === null);

function gap(lines: readonly UsageLine[], all: readonly ModelCall[]): ThreadTelemetry["gap"] {
  const calls = all.filter(counted);
  const ledger = lines.reduce((total, line) => ({ input: total.input + line.spend.tokens.input, output: total.output + line.spend.tokens.output,
    cacheRead: total.cacheRead + line.spend.tokens.cacheRead, cacheWrite: total.cacheWrite + line.spend.tokens.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const summed = sumTokens(calls.map(call => call.tokens));
  const less = (key: keyof ThreadTelemetry["gap"]) => calls.length === 0 ? ledger[key] : summed[key] === null ? null : ledger[key] - summed[key];
  return { input: less("input"), output: less("output"), cacheRead: less("cacheRead"), cacheWrite: less("cacheWrite") };
}

/** Anthropic-shaped usage (a Claude Code frame or result). */
function anthropicTokens(value: unknown, output: boolean): Tokens {
  const usage = record(value), created = record(usage.cache_creation);
  return { input: num(usage.input_tokens), output: output ? num(usage.output_tokens) : null, cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite: num(usage.cache_creation_input_tokens), cacheWrite1h: num(created.ephemeral_1h_input_tokens), reasoning: null };
}

export interface ClaudeStore {
  thread: string;
  /** submission rows: seq, state, created_at. */
  turns: ReadonlyArray<ClaudeTurn & { createdAt: number }>;
  /** message rows in store order. */
  messages: ReadonlyArray<{ seq: number; submission: number; data: Record<string, unknown> }>;
  steers: ReadonlyArray<{ submission: number; state: string }>;
}

/** A Claude Code thread from its claude.sqlite rows. */
export function claudeTelemetry(store: ClaudeStore): ThreadTelemetry {
  const { thread } = store;
  const turnId = (submission: number) => `claude:${thread}:${submission}`;
  const calls = new Map<string, ModelCall>();
  const results = new Map<number, Record<string, unknown>[]>();
  const retries = new Map<number, number>();
  const events: TelemetryEvent[] = [];
  const seen = new Set<string>();
  const versions = new Set<string>();
  for (const { seq, submission, data } of store.messages) {
    const turn = turnId(submission);
    if (data.type === "assistant") {
      const message = record(data.message);
      const key = typeof message.id === "string" ? message.id : typeof data.uuid === "string" ? data.uuid : `seq${seq}`;
      const failed = data.error !== undefined && data.error !== null;
      // One response streams as one frame per content block, each with the same id and usage.
      const prior = calls.get(key);
      const call: ModelCall = prior ?? { kind: "call", id: `claude:${thread}:${key}`, thread, agent: "claude-code", turn,
        source: data.parent_tool_use_id == null ? "main" : "subagent", provider: "anthropic", model: word(message.model), responseModel: null,
        responseId: typeof message.id === "string" ? word(message.id) : null, startedAt: time(data.timestamp), durationMs: null,
        tokens: unknownTokens(), estimatedUsd: null, stopReason: null, failed: false };
      // An error frame is not a response: what it cost is unknown.
      if (!failed && message.usage) call.tokens = anthropicTokens(message.usage, false);
      call.stopReason = word(message.stop_reason) ?? call.stopReason;
      call.failed ||= failed;
      calls.set(key, call);
    } else if (data.type === "result") {
      if (typeof data.uuid === "string") { if (seen.has(data.uuid)) continue; seen.add(data.uuid); }
      results.set(submission, [...results.get(submission) ?? [], data]);
    } else if (data.type === "system" && data.subtype === "api_retry") {
      retries.set(submission, (retries.get(submission) ?? 0) + 1);
      events.push({ kind: "retry", thread, turn, seq, attempt: num(data.attempt), maxRetries: num(data.max_retries), delayMs: num(data.retry_delay_ms), status: num(data.error_status), error: word(data.error) });
    } else if (data.type === "system" && data.subtype === "compact_boundary") {
      const meta = record(data.compact_metadata);
      events.push({ kind: "compaction", thread, turn, seq, trigger: word(meta.trigger), preTokens: num(meta.pre_tokens), postTokens: num(meta.post_tokens), durationMs: num(meta.duration_ms) });
    } else if (data.type === "rate_limit_event") {
      const info = record(data.rate_limit_info);
      events.push({ kind: "rate-limit", thread, turn, seq, status: word(info.status), limit: word(info.rateLimitType), utilization: num(info.utilization),
        overage: typeof info.isUsingOverage === "boolean" ? info.isUsingOverage : null });
    } else if (data.type === "system" && data.subtype === "init") {
      const version = word(data.claude_code_version);
      if (version) versions.add(version);
      events.push({ kind: "process", thread, turn, seq, version, model: word(data.model) });
    }
  }
  const all = [...calls.values()];
  const steers = (submission: number) => {
    const rows = store.steers.filter(steer => steer.submission === submission);
    return { queued: rows.filter(row => row.state === "queued").length, consumed: rows.filter(row => row.state === "consumed").length, dropped: rows.filter(row => row.state === "dropped").length };
  };
  const turns = store.turns.map((row): Turn => {
    const own = all.filter(call => call.turn === turnId(row.seq));
    const ended = results.get(row.seq) ?? [];
    const last = ended.at(-1);
    return { kind: "turn", id: turnId(row.seq), thread, agent: "claude-code", state: row.state, startedAt: num(row.createdAt), calls: own.length,
      failedCalls: own.filter(call => call.failed).length, retries: retries.get(row.seq) ?? 0, results: ended.length,
      durationMs: num(last?.duration_ms), apiDurationMs: num(last?.duration_api_ms), ttftMs: num(last?.ttft_ms), modelRounds: num(last?.num_turns),
      stopReason: word(last?.stop_reason), terminalReason: word(last?.terminal_reason),
      error: last ? last.is_error === true || last.subtype !== "success" : null,
      // A turn's main-loop usage, split over its results when there are several.
      tokens: ended.length ? sumTokens(ended.map(result => anthropicTokens(result.usage, true))) : unknownTokens(), steers: steers(row.seq) };
  });
  const ledger = claudeLines(store.messages.filter(row => row.data.type === "system" || row.data.type === "result"), store.turns);
  return { kind: "thread", schema: TELEMETRY_SCHEMA, thread, agent: "claude-code", versions: [...versions], calls: all, turns, events, ledger, gap: gap(ledger.lines, all) };
}

export interface PiStore {
  thread: string;
  /** Every conversation's entries, oldest first. */
  conversations: ReadonlyArray<{ id: string; root: boolean; entries: readonly EntryRecord[] }>;
  /** The summed `pi.usage` ledger (usage-service.ts sumUsage). */
  usage: Parameters<typeof piLines>[0];
}

/** A Pi thread from its store's entries. */
export function piTelemetry(store: PiStore): ThreadTelemetry {
  const { thread } = store;
  const calls: ModelCall[] = [], turns: Turn[] = [], events: TelemetryEvent[] = [];
  for (const conversation of store.conversations) {
    let turn: Turn | null = null;
    const own: ModelCall[] = [];
    const close = () => {
      if (!turn) return;
      turn.calls = own.length; turn.failedCalls = own.filter(call => call.failed).length;
      turn.tokens = own.length ? sumTokens(own.map(call => call.tokens)) : unknownTokens();
      turn.startedAt = own[0]?.startedAt ?? null;
      const ends = own.map(call => call.startedAt !== null && call.durationMs !== null ? call.startedAt + call.durationMs : null);
      turn.durationMs = turn.startedAt !== null && ends.length && ends.every(end => end !== null) ? Math.max(...ends as number[]) - turn.startedAt : null;
      own.length = 0;
    };
    for (const entry of conversation.entries) {
      const message = entry.model?.[0];
      if (entry.kind === "pi.user") {
        close();
        turn = { kind: "turn", id: `pi:${thread}:${conversation.id}:${entry.id}`, thread, agent: "pi", state: null, startedAt: null, calls: 0, failedCalls: 0,
          retries: null, results: 0, durationMs: null, apiDurationMs: null, ttftMs: null, modelRounds: null, stopReason: null, terminalReason: null,
          error: null, tokens: unknownTokens(), steers: null };
        turns.push(turn);
      } else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
        const response = message as AssistantMessage, usage = response.usage;
        const priced = num(usage?.cost?.total);
        const call: ModelCall = { kind: "call", id: `pi:${thread}:${conversation.id}:${entry.id}`, thread, agent: "pi", turn: turn?.id ?? null,
          source: conversation.root ? "main" : "other", provider: word(response.provider), model: word(response.model),
          responseModel: word(response.responseModel), responseId: word(response.responseId), startedAt: num(response.timestamp), durationMs: num(response.durationMs),
          tokens: usage ? { input: num(usage.input), output: num(usage.output), cacheRead: num(usage.cacheRead), cacheWrite: num(usage.cacheWrite),
            cacheWrite1h: num(usage.cacheWrite1h), reasoning: num(usage.reasoning) } : unknownTokens(),
          // A response with tokens and no cost had no price: unknown, not free.
          estimatedUsd: priced !== null && (priced > 0 || !usage?.totalTokens) ? priced : null,
          stopReason: word(response.stopReason), failed: response.stopReason === "error" };
        calls.push(call); own.push(call);
        if (turn) { turn.stopReason = call.stopReason; turn.error = call.failed; }
      } else if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
        const result = message as ToolResultMessage;
        events.push({ kind: "tool", thread, turn: turn?.id ?? null, seq: entry.id, name: word(result.toolName) ?? "other", durationMs: num(result.durationMs), failed: result.isError === true });
      } else if (entry.kind === "pi.compaction") {
        events.push({ kind: "compaction", thread, turn: turn?.id ?? null, seq: entry.id, trigger: word(record(entry.data).reason), preTokens: null, postTokens: null, durationMs: null });
      }
    }
    close();
  }
  const lines = piLines(store.usage, "pi");
  return { kind: "thread", schema: TELEMETRY_SCHEMA, thread, agent: "pi", versions: [], calls, turns, events, ledger: { lines, unknownTurns: 0, notes: [] }, gap: gap(lines, calls) };
}

// ---- analysis ----

export interface Distribution { n: number; p50: number; p90: number; max: number }

function distribution(values: readonly Known[]): Distribution | null {
  const known = values.filter((value): value is number => value !== null).sort((a, b) => a - b);
  if (!known.length) return null;
  const at = (q: number) => known[Math.min(known.length - 1, Math.ceil(q * known.length) - 1)]!;
  return { n: known.length, p50: at(0.5), p90: at(0.9), max: known.at(-1)! };
}

/** Of the calls whose input, cache read and cache write are all known. */
function cacheShare(calls: readonly ModelCall[]): { calls: number; prompt: number; read: number; write: number; uncached: number } {
  const known = calls.filter(call => call.tokens.input !== null && call.tokens.cacheRead !== null && call.tokens.cacheWrite !== null);
  const read = known.reduce((sum, call) => sum + call.tokens.cacheRead!, 0), write = known.reduce((sum, call) => sum + call.tokens.cacheWrite!, 0);
  const uncached = known.reduce((sum, call) => sum + call.tokens.input!, 0);
  return { calls: known.length, prompt: read + write + uncached, read, write, uncached };
}

export interface Group {
  agent: Agent;
  model: string;
  threads: number;
  calls: number;
  failedCalls: number;
  /** Prompt tokens of the calls with all three counters known: read from cache, written to it, neither. */
  prompt: ReturnType<typeof cacheShare>;
  /** Calls after a thread's first that read nothing from the cache and wrote to it. */
  coldWrites: number;
  /** Calls whose output is known, and its sum. */
  output: { calls: number; tokens: number };
  callMs: Distribution | null;
  /** Pi's per-call estimates; null for Claude Code, which prices only its running totals (byAgent.ledgerUsd). */
  estimatedUsd: { usd: number; pricedCalls: number; unpricedCalls: number } | null;
}

export interface Analysis {
  schema: typeof TELEMETRY_SCHEMA;
  threads: number;
  byAgent: Record<Agent, { threads: number; versions: string[]; calls: number; turns: number; turnsWithResult: number;
    callsWithDuration: number; callsWithOutput: number; retries: number; compactions: number; rateLimits: number;
    turnMs: Distribution | null; turnApiMs: Distribution | null; turnTtftMs: Distribution | null; toolMs: Distribution | null;
    /** Turn tokens (Claude Code: main loop) where the result gave them. */
    turnTokens: Tokens;
    /** usage.ts's estimate for these threads, every call included; never billed. */
    ledgerUsd: number; ledgerUnpricedTokens: number; unknownTurns: number }>;
  groups: Group[];
  billedUsd: null;
}

/** Aggregates over threads, every figure over what its records cover. */
export function analyze(items: readonly ThreadTelemetry[]): Analysis {
  const agents: Agent[] = ["pi", "claude-code"];
  const byAgent = Object.fromEntries(agents.map(agent => {
    const threads = items.filter(item => item.agent === agent);
    const calls = threads.flatMap(item => item.calls), turns = threads.flatMap(item => item.turns), events = threads.flatMap(item => item.events);
    const ledger = threads.flatMap(item => item.ledger.lines);
    const ended = turns.filter(turn => agent === "pi" || turn.results > 0);
    return [agent, { threads: threads.length, versions: [...new Set(threads.flatMap(item => item.versions))].sort(), calls: calls.length, turns: turns.length,
      turnsWithResult: turns.filter(turn => turn.results > 0).length, callsWithDuration: calls.filter(call => call.durationMs !== null).length,
      callsWithOutput: calls.filter(call => call.tokens.output !== null).length,
      retries: events.filter(event => event.kind === "retry").length, compactions: events.filter(event => event.kind === "compaction").length,
      rateLimits: events.filter(event => event.kind === "rate-limit").length,
      turnMs: distribution(ended.map(turn => turn.durationMs)), turnApiMs: distribution(ended.map(turn => turn.apiDurationMs)), turnTtftMs: distribution(ended.map(turn => turn.ttftMs)),
      toolMs: distribution(events.map(event => event.kind === "tool" ? event.durationMs : null)),
      turnTokens: sumTokens(ended.filter(turn => turn.tokens.input !== null).map(turn => turn.tokens)),
      ledgerUsd: ledger.reduce((sum, line) => sum + line.spend.estimatedUsd, 0), ledgerUnpricedTokens: ledger.reduce((sum, line) => sum + line.spend.unpricedTokens, 0),
      unknownTurns: threads.reduce((sum, item) => sum + item.ledger.unknownTurns, 0) }];
  })) as Analysis["byAgent"];
  const keys = new Map<string, ModelCall[]>();
  for (const call of items.flatMap(item => item.calls)) {
    if (!counted(call)) continue;
    const key = `${call.agent}\u0000${call.model ?? "unknown"}`;
    keys.set(key, [...keys.get(key) ?? [], call]);
  }
  const firsts = new Set(items.map(item => item.calls.find(call => call.source === "main" && !call.failed)?.id));
  const groups = [...keys].map(([key, calls]): Group => {
    const [agent, model] = key.split("\u0000") as [Agent, string];
    const output = calls.filter(call => call.tokens.output !== null);
    return { agent, model, threads: new Set(calls.map(call => call.thread)).size, calls: calls.length, failedCalls: calls.filter(call => call.failed).length,
      prompt: cacheShare(calls), coldWrites: calls.filter(call => !firsts.has(call.id) && call.tokens.cacheRead === 0 && (call.tokens.cacheWrite ?? 0) > 0).length,
      output: { calls: output.length, tokens: output.reduce((sum, call) => sum + call.tokens.output!, 0) }, callMs: distribution(calls.map(call => call.durationMs)),
      estimatedUsd: agent === "claude-code" ? null : { usd: calls.reduce((sum, call) => sum + (call.estimatedUsd ?? 0), 0), pricedCalls: calls.filter(call => call.estimatedUsd !== null).length,
        unpricedCalls: calls.filter(call => call.estimatedUsd === null).length } };
  }).sort((a, b) => b.calls - a.calls);
  return { schema: TELEMETRY_SCHEMA, threads: items.length, byAgent, groups, billedUsd: null };
}
