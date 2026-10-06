/** Usage and cost accounting: what the agents' own records say a thread,
 * a project or OptChat consumed, read-only and derived from those records.
 *
 * Every figure keeps its provenance. Tokens are what the provider reported
 * to the agent. Money is an estimate, never a charge: Pi prices each response
 * at its model catalog's rates when the response is recorded, Claude Code
 * prices its own calls at its built-in list prices. No provider reports
 * billed amounts to cube, so `billedUsd` is always null. Usage that no record
 * covers (a Claude Code turn without a result, a thread that cannot be read)
 * is counted as unknown, never as zero, and tokens no price covers are
 * counted as unpriced, never as free. This file is pure; usage-service.ts
 * reads the stores. */
import type { Usage } from "@earendil-works/pi-ai";

export type UsageSource = "pi" | "claude-code" | "optchat" | "optchat-compactor";

export interface TokenCounts {
  input: number; output: number; cacheRead: number; cacheWrite: number;
  /** Reasoning tokens, a part of `output`; null when no record split them out. */
  reasoning: number | null;
  total: number;
}

/** Tokens and their estimated cost. Every token is either priced (in
 * `estimatedUsd`) or unpriced. */
export interface Spend {
  tokens: TokenCounts;
  /** USD estimate of the priced tokens. */
  estimatedUsd: number;
  pricedTokens: number;
  /** Tokens no price covered: their cost is unknown, not zero. */
  unpricedTokens: number;
  /** Always null: providers do not report charges to cube. */
  billedUsd: null;
}

/** The current catalog rates of a model, USD per million tokens. */
export interface Pricing { input: number; output: number; cacheRead: number; cacheWrite: number; source: string; asOf: number }

export interface UsageLine {
  source: UsageSource;
  provider: string;
  model: string;
  spend: Spend;
  /** Model requests, where the record counts them. */
  calls: number | null;
  /** How the estimate was made. */
  basis: string;
  /** The catalog's rates now (Pi models), for reference: the estimate used
   * the rates when each response was recorded. */
  pricing?: Pricing | null;
}

export type Coverage = "complete" | "partial" | "unavailable";

/** One thread's (or OptChat's) usage. */
export interface SubjectUsage {
  subject: string;
  kind: "thread" | "optchat";
  title: string | null;
  projectId: string | null;
  agent: UsageSource | null;
  archived: boolean;
  lines: UsageLine[];
  spend: Spend;
  /** complete: every model call cube knows of has a usage record; partial:
   * some turns have none; unavailable: no record could be read. */
  coverage: Coverage;
  /** Claude Code turns that ended without a usage report. */
  unknownTurns: number;
  /** Some model calls of the subject were never recorded (see notes). */
  incomplete?: boolean;
  /** How the figures were read: from the open agent, its store, or the last
   * snapshot cubed kept (the agent is not open now). */
  read: "live" | "store" | "snapshot" | "none";
  readAt: number | null;
  notes: string[];
}

export interface UsageTotals {
  spend: Spend;
  coverage: Coverage;
  unknownTurns: number;
  /** Subjects whose usage could not be read at all. */
  unavailable: number;
  subjects: number;
}

export const BILLED_NOTE = "billed amounts are not available: providers do not report charges to cube, so every amount is an estimate";
export const PI_BASIS = "pi-ai catalog price when each response was recorded";
export const CLAUDE_BASIS = "claude code's own estimate";
export const CLAUDE_BILLING = "claude · max runs on the user's subscription; the estimate is what the calls would cost at claude code's prices, not a charge";

export function zeroTokens(): TokenCounts { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null, total: 0 }; }
export function zeroSpend(): Spend { return { tokens: zeroTokens(), estimatedUsd: 0, pricedTokens: 0, unpricedTokens: 0, billedUsd: null }; }

export function addTokens(total: TokenCounts, more: TokenCounts): void {
  total.input += more.input; total.output += more.output; total.cacheRead += more.cacheRead; total.cacheWrite += more.cacheWrite; total.total += more.total;
  if (more.reasoning !== null) total.reasoning = (total.reasoning ?? 0) + more.reasoning;
}

export function addSpend(total: Spend, more: Spend): void {
  addTokens(total.tokens, more.tokens);
  total.estimatedUsd += more.estimatedUsd; total.pricedTokens += more.pricedTokens; total.unpricedTokens += more.unpricedTokens;
}

/** How much of a spend has a price: none of it, all of it, or a part. */
export function costState(spend: Spend): "estimated" | "partial" | "unknown" {
  if (spend.unpricedTokens === 0) return "estimated";
  return spend.pricedTokens === 0 ? "unknown" : "partial";
}

const count = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

/** A Pi usage record (one `pi.usage` bucket): its cost is pi-ai's catalog
 * price at record time. A record with tokens but no cost had no price. */
export function piSpend(usage: Pick<Usage, "input" | "output" | "cacheRead" | "cacheWrite" | "reasoning" | "totalTokens" | "cost">): Spend {
  const tokens: TokenCounts = { input: count(usage.input), output: count(usage.output), cacheRead: count(usage.cacheRead),
    cacheWrite: count(usage.cacheWrite), reasoning: typeof usage.reasoning === "number" ? count(usage.reasoning) : null, total: 0 };
  tokens.total = count(usage.totalTokens) || tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  const usd = count(usage.cost?.total);
  return usd > 0 || tokens.total === 0
    ? { tokens, estimatedUsd: usd, pricedTokens: tokens.total, unpricedTokens: 0, billedUsd: null }
    : { tokens, estimatedUsd: 0, pricedTokens: 0, unpricedTokens: tokens.total, billedUsd: null };
}

/** `pi.usage` state (or Harness.usage()): one line per `provider/model` key.
 * Pi writes it in the commit that records each response, retried errors
 * and aborted partials included, so it counts each response once. */
export function piLines(state: { models: Record<string, Usage> } | undefined, source: UsageSource, pricing?: (provider: string, model: string) => Pricing | null): UsageLine[] {
  const lines: UsageLine[] = [];
  for (const [key, usage] of Object.entries(state?.models ?? {})) {
    const slash = key.indexOf("/");
    const provider = slash > 0 ? key.slice(0, slash) : key, model = slash > 0 ? key.slice(slash + 1) : "";
    lines.push({ source, provider, model, spend: piSpend(usage), calls: null, basis: PI_BASIS, pricing: pricing?.(provider, model) ?? null });
  }
  return lines;
}

/** Claude Code's per-model running totals in a stream-json `result`. */
type ModelTotals = Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number | null; usd: number; basis: string }>;

function modelTotals(value: unknown): ModelTotals | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const totals: ModelTotals = new Map();
  for (const [model, raw] of Object.entries(value as Record<string, Record<string, unknown>>)) {
    if (!raw || typeof raw !== "object") continue;
    totals.set(model, { input: count(raw.inputTokens), output: count(raw.outputTokens), cacheRead: count(raw.cacheReadInputTokens),
      cacheWrite: count(raw.cacheCreationInputTokens), reasoning: typeof raw.thinkingTokens === "number" ? count(raw.thinkingTokens) : null,
      usd: count(raw.costUSD), basis: typeof raw.costBasis === "string" ? raw.costBasis : "list" });
  }
  return totals;
}

const totalTokens = (totals: ModelTotals) => [...totals.values()].reduce((sum, item) => sum + item.input + item.output + item.cacheRead + item.cacheWrite, 0);

/** `a` holds at least `b` in every counter of every model. */
function covers(a: ModelTotals, b: ModelTotals): boolean {
  for (const [model, before] of b) {
    const after = a.get(model);
    if (!after || after.input < before.input || after.output < before.output || after.cacheRead < before.cacheRead || after.cacheWrite < before.cacheWrite) return false;
  }
  return true;
}

export interface ClaudeRecord { submission: number; data: Record<string, unknown> }
export interface ClaudeTurn { seq: number; state: "running" | "completed" | "failed" | "stopped" }

/** Claude Code's usage from the stream-json messages cubed kept.
 *
 * A `result` carries `modelUsage`: per model, running totals for every model
 * call of the process (main loop, subagents, compaction), cumulative across
 * the turns of one process. A turn's usage is the difference to the previous
 * result of the same process. Every process after a store's first is started
 * with --resume and may begin from the totals the session's transcript saved
 * or from zero: its first result continues the largest earlier total it holds
 * in every counter whose increase still covers the turn's own main-loop usage,
 * otherwise it starts from zero (so a wrong choice undercounts). A turn that
 * ends without a result (killed, cubed stopped) or with zeroed totals after a
 * failure has unknown usage. Results are counted once by uuid. */
export function claudeLines(records: readonly ClaudeRecord[], turns: readonly ClaudeTurn[]): { lines: UsageLine[]; unknownTurns: number; notes: string[] } {
  const perModel = new Map<string, { spend: Spend; bases: Set<string> }>();
  const reported = new Set<number>();
  const seen = new Set<string>();
  const notes = new Set<string>();
  /** Every counted increase in this store, and the last totals of the process before the current one. */
  const counted: ModelTotals = new Map();
  let previous: ModelTotals | null = null;
  let processes = 0;
  let child: { resumed: boolean; last: ModelTotals | null } | null = null;
  const add = (model: string, input: number, output: number, cacheRead: number, cacheWrite: number, reasoning: number | null, usd: number, basis: string) => {
    let entry = perModel.get(model);
    if (!entry) perModel.set(model, entry = { spend: zeroSpend(), bases: new Set() });
    const total = input + output + cacheRead + cacheWrite;
    const priced = basis !== "unknown";
    addSpend(entry.spend, { tokens: { input, output, cacheRead, cacheWrite, reasoning, total },
      estimatedUsd: priced ? usd : 0, pricedTokens: priced ? total : 0, unpricedTokens: priced ? 0 : total, billedUsd: null });
    entry.bases.add(basis);
    const prior = counted.get(model);
    counted.set(model, { input: (prior?.input ?? 0) + input, output: (prior?.output ?? 0) + output, cacheRead: (prior?.cacheRead ?? 0) + cacheRead,
      cacheWrite: (prior?.cacheWrite ?? 0) + cacheWrite, reasoning: prior?.reasoning == null && reasoning === null ? null : (prior?.reasoning ?? 0) + (reasoning ?? 0),
      usd: (prior?.usd ?? 0) + usd, basis });
  };
  // A new process: cubed starts every process after the first with --resume.
  const start = () => {
    if (child?.last) previous = child.last;
    child = { resumed: processes > 0, last: null };
    processes++;
    return child;
  };
  for (const { submission, data } of records) {
    if (data.type === "system" && data.subtype === "init") { start(); continue; }
    if (data.type !== "result") continue;
    if (typeof data.uuid === "string") { if (seen.has(data.uuid)) continue; seen.add(data.uuid); }
    const current = child ?? start();
    const totals = modelTotals(data.modelUsage);
    if (!totals) { notes.add("a claude code result had no modelUsage (an older claude code?); that turn's usage is unknown"); continue; }
    // As claude-agent.ts decides a failed turn. A zeroed failure, or zeroed
    // totals after real ones (cube never sends /clear), report nothing.
    const failed = data.is_error === true || data.subtype !== "success";
    const zeroed = totalTokens(totals) === 0 && count(data.total_cost_usd) === 0;
    if (zeroed && (failed || (current.last && totalTokens(current.last) > 0))) continue;
    let base: ModelTotals = current.last ?? new Map();
    if (!current.last && current.resumed) {
      // A resumed process may continue the totals its transcript saved (all
      // earlier turns, or its predecessor's) or start from zero: take the
      // largest base it holds in every counter whose increase still covers
      // this turn's own main-loop usage. Larger bases undercount, never overcount.
      const main = data.usage as Record<string, unknown> | undefined;
      const turn = count(main?.input_tokens) + count(main?.output_tokens) + count(main?.cache_read_input_tokens) + count(main?.cache_creation_input_tokens);
      const candidates: Array<[ModelTotals, string]> = [[counted, "the totals of every earlier turn"], ...(previous ? [[previous, "the previous process's totals"] as [ModelTotals, string]] : [])];
      const fits = candidates.filter(([candidate]) => totalTokens(candidate) > 0 && covers(totals, candidate) && totalTokens(totals) - totalTokens(candidate) >= turn)
        .sort((a, b) => totalTokens(b[0]) - totalTokens(a[0]))[0];
      if (fits) {
        base = fits[0];
        notes.add(`a resumed claude code process continued ${fits[1]}; its first turn is the increase over them`);
      } else if (totalTokens(counted) > 0) notes.add("a resumed claude code process started its totals from zero");
    }
    if (!covers(totals, base)) {
      // A running total went down (a reset): count this result from zero.
      notes.add("a claude code running total went down; counted from zero after it");
      base = new Map();
    }
    for (const [model, now] of totals) {
      const before = base.get(model);
      const d = { input: now.input - (before?.input ?? 0), output: now.output - (before?.output ?? 0), cacheRead: now.cacheRead - (before?.cacheRead ?? 0),
        cacheWrite: now.cacheWrite - (before?.cacheWrite ?? 0), reasoning: now.reasoning === null ? null : Math.max(0, now.reasoning - (before?.reasoning ?? 0)),
        usd: Math.max(0, now.usd - (before?.usd ?? 0)) };
      if (d.input + d.output + d.cacheRead + d.cacheWrite === 0 && d.usd === 0) continue;
      add(model, d.input, d.output, d.cacheRead, d.cacheWrite, d.reasoning, d.usd, now.basis);
    }
    current.last = totals;
    reported.add(submission);
  }
  // A turn still running has not reported yet; that is not unknown.
  const unknownTurns = turns.filter(turn => turn.state !== "running" && !reported.has(turn.seq)).length;
  if (unknownTurns) notes.add(`${unknownTurns} claude code ${unknownTurns === 1 ? "turn" : "turns"} ended without a usage report (stopped, killed or failed before its result); their usage is unknown`);
  const lines = [...perModel].map(([model, { spend, bases }]): UsageLine => ({
    source: "claude-code", provider: "claude-code", model, spend, calls: null,
    basis: `${CLAUDE_BASIS} (${[...bases].map(basis => basis === "unknown" ? "no price matched the model: unpriced" : basis === "managed" ? "managed prices" : "list prices").join(", ")})`,
  }));
  return { lines, unknownTurns, notes: [...notes] };
}

/** One line per source/provider/model, spends added. */
export function mergeLines(lines: readonly UsageLine[]): UsageLine[] {
  const merged = new Map<string, UsageLine>();
  for (const line of lines) {
    const key = `${line.source}\u0000${line.provider}\u0000${line.model}`;
    const prior = merged.get(key);
    if (!prior) { merged.set(key, { ...line, spend: structuredClone(line.spend) }); continue; }
    addSpend(prior.spend, line.spend);
    prior.calls = prior.calls === null || line.calls === null ? null : prior.calls + line.calls;
  }
  return [...merged.values()];
}

/** A subject's own spend and coverage from its lines. */
export function subject(base: Omit<SubjectUsage, "spend" | "coverage">): SubjectUsage {
  const spend = zeroSpend();
  for (const line of base.lines) addSpend(spend, line.spend);
  const coverage: Coverage = base.read === "none" ? "unavailable" : base.unknownTurns > 0 || base.incomplete ? "partial" : "complete";
  return { ...base, spend, coverage };
}

export function totals(subjects: readonly SubjectUsage[]): UsageTotals {
  const spend = zeroSpend();
  let unknownTurns = 0, unavailable = 0, partial = false;
  for (const item of subjects) {
    addSpend(spend, item.spend);
    unknownTurns += item.unknownTurns;
    if (item.coverage === "unavailable") unavailable++;
    if (item.coverage === "partial") partial = true;
  }
  const coverage: Coverage = subjects.length && unavailable === subjects.length ? "unavailable" : unavailable || partial ? "partial" : "complete";
  return { spend, coverage, unknownTurns, unavailable, subjects: subjects.length };
}

/** "$0.42", "$12.30", "<$0.01". */
export function usd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  return `$${value < 100 ? value.toFixed(2) : Math.round(value).toLocaleString("en-US")}`;
}

/** 1234 → "1.2k", 3_400_000 → "3.4M". */
export function tokenCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
}

/** A spend in one phrase, never a missing figure as zero: "≈ $1.20 est.",
 * "≈ $1.20 est. + 30k unpriced tokens", "cost unknown (30k tokens)". */
export function spendText(spend: Spend): string {
  const state = costState(spend);
  if (state === "unknown") return `cost unknown (${tokenCount(spend.unpricedTokens)} unpriced tokens)`;
  const estimate = `≈ ${usd(spend.estimatedUsd)} est.`;
  return state === "partial" ? `${estimate} + ${tokenCount(spend.unpricedTokens)} unpriced tokens` : estimate;
}

export function tokensText(tokens: TokenCounts): string {
  return `${tokenCount(tokens.input)} in · ${tokenCount(tokens.output)} out${tokens.reasoning ? ` (${tokenCount(tokens.reasoning)} reasoning)` : ""} · ${tokenCount(tokens.cacheRead)} cache read · ${tokenCount(tokens.cacheWrite)} cache write`;
}

/** What a total leaves out, or "". */
export function gapsText(total: Pick<UsageTotals, "unknownTurns" | "unavailable">): string {
  const gaps: string[] = [];
  if (total.unknownTurns) gaps.push(`${total.unknownTurns} ${total.unknownTurns === 1 ? "turn" : "turns"} without a usage report`);
  if (total.unavailable) gaps.push(`${total.unavailable} ${total.unavailable === 1 ? "thread" : "threads"} not readable now`);
  return gaps.length ? `not included: ${gaps.join(", ")}` : "";
}
