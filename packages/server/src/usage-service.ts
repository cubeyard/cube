/** Reads usage from the agents' own records (usage.ts says what each figure
 * means) and keeps the last reading of every thread and of OptChat in
 * `CUBED_STATE/usage.sqlite`.
 *
 * That file is a derived cache, not a journal: every row can be read again
 * from the thread's own store, which archive keeps. It serves what cannot be
 * read now (a Pi thread whose agent is not open: only its owner may open its
 * store) and spares re-reading an unchanged archived store. Nothing here
 * writes to an agent's store: an archived Pi store is read from a copy,
 * because opening pi-durable storage migrates and checkpoints it. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import { UsageDoc, type ConversationId, type Cursor, type UsageState } from "@earendil-works/pi-durable";
import { openStorage } from "./durable-agent.ts";
import { createLogger } from "./log.ts";
import { threadAgent, type Registry, type Thread } from "./registry.ts";
import {
  BILLED_NOTE, CLAUDE_BILLING, claudeLines, gapsText, mergeLines, piLines, spendText, subject, tokensText, totals, zeroSpend, addSpend,
  type ClaudeRecord, type ClaudeTurn, type Pricing, type SubjectUsage, type UsageLine, type UsageTotals,
} from "./usage.ts";

const context = BACKGROUND_CONTEXT;
const log = createLogger("usage");
/** Bump when a snapshot's meaning changes: older rows are read again. */
const LEDGER_VERSION = 1;
export const OPTCHAT_SUBJECT = "optchat";

/** What OptChat reports about itself (optchat.ts). */
export interface OptChatUsage {
  /** Its Pi store: the chat's own model calls. */
  chat: UsageState;
  /** The compactor's model calls, which run beside Pi. */
  compactor: { models: Record<string, Usage>; calls: Record<string, number>; since: number | null; earlier?: boolean };
  /** The threads it started. */
  threads: string[];
}

export interface UsageReport {
  generatedAt: number;
  project: string | null;
  totals: UsageTotals;
  billed: { usd: null; note: string };
  projects: Array<{ id: string; name: string; totals: UsageTotals }>;
  models: UsageLine[];
  threads: SubjectUsage[];
  /** OptChat's own model calls (not its threads'); global reports only. */
  optchat: SubjectUsage | null;
  /** The threads OptChat started, in this report's threads already: not
   * added to the totals a second time. */
  optchatThreads: { count: number; totals: UsageTotals } | null;
  notes: string[];
}

export class UsageService {
  private readonly db: DatabaseSync;
  private readonly registry: Registry;
  private readonly threads: string;
  private readonly live: (id: string) => Promise<UsageState | null>;
  private readonly optchat: () => Promise<OptChatUsage | null>;
  private readonly optchatStore: string | null;
  private readonly pricing: (provider: string, model: string) => Pricing | null;
  /** Readings under way, by subject: concurrent requests share one. */
  private readonly reading = new Map<string, Promise<SubjectUsage>>();

  constructor(options: {
    file: string; registry: Registry; threads: string;
    /** The open Pi agent's usage, or null when it is not open. */
    live: (id: string) => Promise<UsageState | null>;
    /** OptChat's own usage, or null when it is not open. */
    optchat?: () => Promise<OptChatUsage | null>;
    /** OptChat's store: while it does not exist, OptChat has used nothing. */
    optchatStore?: string;
    /** A model's current catalog rates. */
    pricing?: (provider: string, model: string) => Pricing | null;
  }) {
    this.registry = options.registry; this.threads = options.threads; this.live = options.live;
    this.optchat = options.optchat ?? (async () => null);
    this.optchatStore = options.optchatStore ?? null;
    this.pricing = options.pricing ?? (() => null);
    this.db = new DatabaseSync(options.file, { timeout: 5000 });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS snapshot(subject TEXT PRIMARY KEY, version INTEGER NOT NULL, key TEXT, data TEXT NOT NULL, read_at INTEGER NOT NULL);`);
  }

  close(): void { this.db.close(); }

  private stored(subject: string): { key: string | null; usage: SubjectUsage; readAt: number } | null {
    const row = this.db.prepare("SELECT key, data, read_at AS readAt FROM snapshot WHERE subject=? AND version=?").get(subject, LEDGER_VERSION) as
      { key: string | null; data: string; readAt: number } | undefined;
    return row ? { key: row.key, usage: JSON.parse(row.data) as SubjectUsage, readAt: row.readAt } : null;
  }

  /** Keeps a reading unless a newer one is kept already (a reading taken
   * before an agent closed must not replace the one taken as it closed). */
  private store(usage: SubjectUsage, key: string | null): void {
    this.db.prepare(`INSERT INTO snapshot(subject, version, key, data, read_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(subject) DO UPDATE SET version=excluded.version, key=excluded.key, data=excluded.data, read_at=excluded.read_at
      WHERE excluded.read_at >= snapshot.read_at OR snapshot.version != excluded.version`)
      .run(usage.subject, LEDGER_VERSION, key, JSON.stringify(usage), usage.readAt ?? Date.now());
  }

  /** Keeps a Pi agent's usage as it closes (archive, shutdown): until it
   * opens again only this reading is available. */
  remember(id: string, state: UsageState): void {
    const thread = this.registry.getThread(id);
    if (!thread) return;
    try { this.store(this.piThread(thread, state, "live", Date.now()), null); }
    catch (error) { log.warn("usage snapshot not stored", { thread: id, error }); }
  }

  private base(thread: Thread): Pick<SubjectUsage, "subject" | "kind" | "title" | "projectId" | "agent" | "archived"> {
    return { subject: thread.id, kind: "thread", title: thread.title, projectId: thread.projectId, agent: threadAgent(thread), archived: thread.archived };
  }

  private piThread(thread: Thread, state: UsageState, read: SubjectUsage["read"], readAt: number): SubjectUsage {
    return subject({ ...this.base(thread), lines: piLines(state, "pi", this.pricing), unknownTurns: 0, read, readAt, notes: [] });
  }

  /** One thread's usage; archived threads included. */
  thread(id: string): Promise<SubjectUsage> {
    const pending = this.reading.get(id);
    if (pending) return pending;
    const reading = this.readThread(id).finally(() => this.reading.delete(id));
    this.reading.set(id, reading);
    return reading;
  }

  private async readThread(id: string): Promise<SubjectUsage> {
    const thread = this.registry.getThread(id);
    if (!thread) throw new Error("thread not found");
    try { return threadAgent(thread) === "claude-code" ? this.claudeThread(thread) : await this.piUsage(thread); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("usage not readable", { thread: id, error: message });
      const prior = this.stored(id);
      if (prior) return { ...prior.usage, ...this.base(thread), read: "snapshot", notes: [...prior.usage.notes, `the store could not be read now (${message}); this is the last reading`] };
      return subject({ ...this.base(thread), lines: [], unknownTurns: 0, read: "none", readAt: null, notes: [`usage could not be read: ${message}`] });
    }
  }

  private async piUsage(thread: Thread): Promise<SubjectUsage> {
    // Stamped before the read: see store().
    const readAt = Date.now();
    const live = await this.live(thread.id);
    if (live) {
      const usage = this.piThread(thread, live, "live", readAt);
      this.store(usage, null);
      return usage;
    }
    const directory = path.join(this.threads, thread.id);
    const file = path.join(directory, "pi.sqlite");
    if (!fs.existsSync(file)) return subject({ ...this.base(thread), lines: [], unknownTurns: 0, read: "store", readAt: Date.now(), notes: ["the agent has not run yet"] });
    const prior = this.stored(thread.id);
    // Only the agent may open the store of an open thread (its lease is the
    // store's lock); its last reading stands in until it opens.
    if (!thread.archived) {
      if (prior) return { ...prior.usage, ...this.base(thread), read: "snapshot" };
      return subject({ ...this.base(thread), lines: [], unknownTurns: 0, read: "none", readAt: null,
        notes: ["the thread's agent is not open; its usage is read once it is"] });
    }
    const key = fileKey(file);
    if (prior && prior.key === key) return { ...prior.usage, ...this.base(thread), read: "store" };
    const usage = this.piThread(thread, await readPiStore(file), "store", readAt);
    this.store(usage, key);
    return usage;
  }

  private claudeThread(thread: Thread): SubjectUsage {
    const file = path.join(this.threads, thread.id, "claude.sqlite");
    if (!fs.existsSync(file)) return subject({ ...this.base(thread), lines: [], unknownTurns: 0, read: "store", readAt: Date.now(), notes: ["the agent has not run yet"] });
    const key = fileKey(file);
    const prior = this.stored(thread.id);
    if (prior && prior.key === key) return { ...prior.usage, ...this.base(thread), read: "store" };
    // cube's own schema (claude-agent.ts); a read-only connection beside the writer.
    const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
    let turns: ClaudeTurn[], records: ClaudeRecord[];
    try {
      turns = db.prepare("SELECT seq, state FROM submission ORDER BY seq").all() as unknown as ClaudeTurn[];
      records = (db.prepare("SELECT submission, data FROM message WHERE json_extract(data, '$.type') IN ('system', 'result') ORDER BY seq").all() as Array<{ submission: number; data: string }>)
        .map(row => ({ submission: row.submission, data: JSON.parse(row.data) as Record<string, unknown> }));
    } finally { db.close(); }
    const { lines, unknownTurns, notes } = claudeLines(records, turns);
    const usage = subject({ ...this.base(thread), lines, unknownTurns, read: "store", readAt: Date.now(), notes });
    // A running turn reports later: keep only settled readings as cache hits.
    this.store(usage, turns.at(-1)?.state === "running" ? null : key);
    return usage;
  }

  /** OptChat's own usage: the chat and its compactor. */
  async optchatUsage(): Promise<{ usage: SubjectUsage; threads: string[] }> {
    let chat: OptChatUsage | null = null, failure: string | null = null;
    try { chat = await this.optchat(); }
    catch (error) { failure = error instanceof Error ? error.message : String(error); }
    const base = { subject: OPTCHAT_SUBJECT, kind: "optchat" as const, title: "optchat", projectId: null, agent: "optchat" as const, archived: false };
    if (!chat) {
      if (this.optchatStore && !fs.existsSync(this.optchatStore)) {
        return { usage: subject({ ...base, lines: [], unknownTurns: 0, read: "store", readAt: Date.now(), notes: ["optchat has not started"] }), threads: [] };
      }
      const prior = this.stored(OPTCHAT_SUBJECT);
      const note = failure ? `optchat is not open (${failure})` : "optchat is not open";
      if (prior) return { usage: { ...prior.usage, read: "snapshot", notes: [...prior.usage.notes, `${note}; this is the last reading`] }, threads: [] };
      return { usage: subject({ ...base, lines: [], unknownTurns: 0, read: "none", readAt: null, notes: [note] }), threads: [] };
    }
    const compactor = piLines({ models: chat.compactor.models }, "optchat-compactor", this.pricing)
      .map(line => ({ ...line, calls: chat.compactor.calls[`${line.provider}/${line.model}`] ?? null }));
    const notes = chat.compactor.earlier ? [`compactor calls before ${chat.compactor.since === null ? "now" : new Date(chat.compactor.since).toISOString()} were not counted (an older cube): their usage is unknown`] : [];
    const usage = subject({ ...base, lines: [...piLines(chat.chat, "optchat", this.pricing), ...compactor], unknownTurns: 0, incomplete: !!chat.compactor.earlier, read: "live", readAt: Date.now(), notes });
    this.store(usage, null);
    return { usage, threads: chat.threads };
  }

  /** Usage of every thread (archived included) or of one project's, by
   * project and model; a global report adds OptChat's own. */
  async report(options: { project?: string | null } = {}): Promise<UsageReport> {
    const project = options.project ?? null;
    if (project && !this.registry.getProject(project)) throw new Error("project not found");
    const threads: SubjectUsage[] = [];
    for (const thread of this.registry.listThreads()) {
      if (project && thread.projectId !== project) continue;
      threads.push(await this.thread(thread.id));
    }
    const chat = project ? null : await this.optchatUsage();
    const subjects = chat ? [...threads, chat.usage] : threads;
    const byProject = new Map<string, SubjectUsage[]>();
    for (const item of threads) byProject.set(item.projectId!, [...byProject.get(item.projectId!) ?? [], item]);
    const spawned = chat ? new Set(chat.threads) : null;
    const optchatThreads = spawned ? threads.filter(item => spawned.has(item.subject)) : null;
    const notes = [BILLED_NOTE];
    if (subjects.some(item => item.lines.some(line => line.source === "claude-code"))) notes.push(CLAUDE_BILLING);
    if (subjects.some(item => item.read === "snapshot")) notes.push("some threads are not open now: their last reading is shown");
    notes.push("a model response cut off by a cubed crash before pi recorded it is not counted; the provider may still have billed it");
    return {
      generatedAt: Date.now(), project, totals: totals(subjects), billed: { usd: null, note: BILLED_NOTE },
      projects: [...byProject].map(([id, items]) => ({ id, name: this.registry.getProject(id)?.name ?? id, totals: totals(items) }))
        .sort((a, b) => b.totals.spend.estimatedUsd - a.totals.spend.estimatedUsd),
      models: mergeLines(subjects.flatMap(item => item.lines)).sort((a, b) => b.spend.estimatedUsd - a.spend.estimatedUsd || b.spend.tokens.total - a.spend.tokens.total),
      threads: threads.sort((a, b) => b.spend.estimatedUsd - a.spend.estimatedUsd || b.spend.tokens.total - a.spend.tokens.total),
      optchat: chat?.usage ?? null,
      optchatThreads: optchatThreads ? { count: optchatThreads.length, totals: totals(optchatThreads) } : null,
      notes,
    };
  }
}

/** Size and modification time of a store and its log: changes when it is written. */
function fileKey(file: string): string {
  return [file, `${file}-wal`].map(name => { try { const stat = fs.statSync(name); return `${stat.size}:${stat.mtimeMs}`; } catch { return "-"; } }).join("/");
}

/** Every conversation's `pi.usage` in a store no agent has open (an
 * archived thread's), summed as Harness.usage() does. Read from a private
 * copy: opening pi-durable storage migrates and checkpoints it, and an
 * archived store is retained evidence. */
async function readPiStore(file: string): Promise<UsageState> {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "cube-usage-"));
  try {
    for (const suffix of ["", "-wal"]) {
      if (fs.existsSync(`${file}${suffix}`)) fs.copyFileSync(`${file}${suffix}`, path.join(copy, `pi.sqlite${suffix}`));
    }
    return await readStorage(path.join(copy, "pi.sqlite"));
  } finally { fs.rmSync(copy, { recursive: true, force: true }); }
}

async function readStorage(file: string): Promise<UsageState> {
  const storage = await openStorage(file);
  const sum: { models: Record<string, Usage>; tools: Record<string, Usage> } = { models: {}, tools: {} };
  try {
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanConversations({}, 256, cursor, context);
      for (const conversation of page.items) {
        const record = await storage.findDocument({ kind: UsageDoc.definition.kind, scope: { kind: "conversation", conversationId: conversation.id as ConversationId } }, "current", context);
        if (!record) continue;
        const state = (await storage.document(record.id, "current", context))?.value as UsageState | undefined;
        for (const bucket of ["models", "tools"] as const) {
          for (const [key, usage] of Object.entries(state?.[bucket] ?? {})) {
            const total = Object.hasOwn(sum[bucket], key) ? sum[bucket][key] : undefined;
            if (!total) Object.defineProperty(sum[bucket], key, { value: structuredClone(usage), enumerable: true, writable: true });
            else addUsage(total, usage);
          }
        }
      }
      cursor = page.next;
    } while (cursor);
  } finally { await storage.close(context); }
  return sum as UsageState;
}

/** Adds `usage` into `total`, as pi-durable's ledger does. */
export function addUsage(total: Usage, usage: Usage): void {
  total.input += usage.input; total.output += usage.output; total.cacheRead += usage.cacheRead; total.cacheWrite += usage.cacheWrite;
  total.totalTokens += usage.totalTokens;
  if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
  total.cost.input += usage.cost.input; total.cost.output += usage.cost.output; total.cost.cacheRead += usage.cost.cacheRead;
  total.cost.cacheWrite += usage.cost.cacheWrite; total.cost.total += usage.cost.total;
}

/** A report as text, for OptChat's `usage` tool. */
export function usageText(report: UsageReport, options: { limit?: number; projectName?: string } = {}): string {
  const total = report.totals;
  const lines = [
    `usage${options.projectName ? ` in ${options.projectName}` : ""} (estimates, not charges; ${report.billed.note}):`,
    `total: ${spendText(total.spend)} · ${tokensText(total.spend.tokens)}${gapsText(total) ? ` · ${gapsText(total)}` : ""}`,
  ];
  if (report.optchat) {
    const chat = report.optchat.lines.filter(line => line.source === "optchat"), compactor = report.optchat.lines.filter(line => line.source === "optchat-compactor");
    const sum = (items: UsageLine[]) => { const spend = zeroSpend(); for (const item of items) addSpend(spend, item.spend); return spend; };
    lines.push(report.optchat.coverage === "unavailable" ? `optchat itself: unknown (${report.optchat.notes.join("; ")})`
      : `optchat itself: ${spendText(report.optchat.spend)} (chat ${spendText(sum(chat))}, compactor ${spendText(sum(compactor))})${report.optchat.read === "snapshot" ? " · last reading" : ""}`);
    if (report.optchatThreads?.count) lines.push(`threads optchat started: ${report.optchatThreads.count}, ${spendText(report.optchatThreads.totals.spend)} (inside the total above, not added again)`);
  }
  if (!report.project && report.projects.length) {
    lines.push("by project:");
    for (const project of report.projects) lines.push(`- ${project.name}: ${spendText(project.totals.spend)} · ${project.totals.subjects} threads${gapsText(project.totals) ? ` · ${gapsText(project.totals)}` : ""}`);
  }
  if (report.models.length) {
    lines.push("by model:");
    for (const model of report.models) lines.push(`- ${model.provider}/${model.model} (${model.source}): ${spendText(model.spend)} · ${tokensText(model.spend.tokens)}`);
  }
  const shown = report.threads.slice(0, options.limit ?? 10);
  if (shown.length) {
    lines.push(`threads${report.threads.length > shown.length ? ` (top ${shown.length} of ${report.threads.length})` : ""}:`);
    for (const item of shown) lines.push(`- ${threadLine(item, report.projects)}`);
  }
  lines.push(...report.notes.filter(note => note !== BILLED_NOTE).map(note => `note: ${note}`));
  return lines.join("\n");
}

function threadLine(item: SubjectUsage, projects: UsageReport["projects"]): string {
  const project = projects.find(candidate => candidate.id === item.projectId)?.name;
  const cost = item.coverage === "unavailable" ? "usage unknown" : spendText(item.spend);
  const gaps = item.unknownTurns ? ` · ${item.unknownTurns} turns without a usage report` : "";
  return `[${item.subject.slice(0, 8)}] ${item.title ?? "untitled"}${project ? ` · ${project}` : ""}${item.archived ? " · archived" : ""} · ${item.agent} · ${cost}${gaps}`;
}

/** One thread in detail, for OptChat's `usage` tool. */
export function threadUsageText(item: SubjectUsage): string {
  const lines = [`[${item.subject.slice(0, 8)}] ${item.title ?? "untitled"} · ${item.agent}${item.archived ? " · archived" : ""}`,
    item.coverage === "unavailable" ? "usage unknown" : `total: ${spendText(item.spend)} · ${tokensText(item.spend.tokens)}`];
  for (const line of item.lines) lines.push(`- ${line.provider}/${line.model}: ${spendText(line.spend)} · ${tokensText(line.spend.tokens)}${line.calls !== null ? ` · ${line.calls} calls` : ""} · basis: ${line.basis}`);
  if (item.read === "snapshot") lines.push(`last reading: ${item.readAt ? new Date(item.readAt).toISOString() : "unknown"}`);
  lines.push(...item.notes.map(note => `note: ${note}`), ...(item.agent === "claude-code" ? [`note: ${CLAUDE_BILLING}`] : []), `note: ${BILLED_NOTE}`);
  return lines.join("\n");
}
