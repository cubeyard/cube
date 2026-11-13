/** Reads usage from the agents' own records (usage.ts says what each figure
 * means) and keeps the last reading of every thread and of OptChat in
 * `CUBED_STATE/usage.sqlite`.
 *
 * That file is a derived cache, not a journal: every row can be read again
 * from the thread's own store, which archive keeps. It serves what cannot be
 * read now (a Pi thread whose agent is not open: only its owner may open its
 * store) and spares re-reading an unchanged archived store. Nothing here
 * writes to an agent's store: an archived Pi store is read from a read-only
 * snapshot (durable-agent.ts readStorage). */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Usage } from "@earendil-works/pi-ai";
import { UsageDoc, type ConversationId, type Cursor, type UsageState } from "@earendil-works/pi-durable";
import { SendsDoc, type Sends } from "./pi-sends.ts";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { readStorage } from "./durable-agent.ts";
import { createLogger } from "./log.ts";
import { threadAgent, type Registry, type Thread } from "./registry.ts";
import {
  BILLED_NOTE, CLAUDE_BILLING, claudeLines, gapsText, mergeLines, piInterrupted, piLines, spendText, subject, tokensText, totals, zeroSpend, addSpend,
  type ClaudeRecord, type ClaudeTurn, type Pricing, type SubjectUsage, type UsageLine, type UsageTotals,
} from "./usage.ts";

/** A Pi store's usage and its requests out at a stop (pi-sends.ts), by `provider/model`. */
export type PiUsage = UsageState & { interrupted?: Record<string, number> };
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
  /** Calls a close cut off after its grace, by `provider/model`: their cost
   * is unknown. `tools`: tool calls cut off, by name: what they did is unknown. */
  cut?: { chat: Record<string, number>; compactor: Record<string, number>; tools?: Record<string, number>; capped?: { chat: Record<string, number>; compactor: Record<string, number> } };
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
  /** Each workspace's chat apart (their sum is in `optchat`). */
  chats: SubjectUsage[];
  /** What the one chat had used before each workspace got its own; in
   * `optchat` of a report of everything, and in no workspace's. */
  beforeWorkspaces: SubjectUsage | null;
  notes: string[];
}

export class UsageService {
  private readonly db: DatabaseSync;
  private readonly registry: Registry;
  private readonly threads: string;
  private readonly live: (id: string) => Promise<PiUsage | null>;
  private readonly chats: () => Promise<Array<{ workspace: string; usage: OptChatUsage }>>;
  private readonly chatStore: ((workspace: string) => string) | null;
  private readonly before: () => OptChatUsage | null;
  private readonly pricing: (provider: string, model: string) => Pricing | null;
  /** Readings under way, by subject: concurrent requests share one. */
  private readonly reading = new Map<string, Promise<SubjectUsage>>();

  constructor(options: {
    file: string; registry: Registry; threads: string;
    /** The open Pi agent's usage, or null when it is not open. */
    live: (id: string) => Promise<PiUsage | null>;
    /** The usage of each workspace's chat that is open now, since its store
     * was copied if it was (`OptChat.usage`). */
    chats?: () => Promise<Array<{ workspace: string; usage: OptChatUsage }>>;
    /** A workspace's chat store: while it does not exist, that chat has used nothing. */
    chatStore?: (workspace: string) => string;
    /** What the chat before workspaces had used when it was copied into
     * them (workspace-migration.ts): counted once, in no workspace. */
    before?: () => OptChatUsage | null;
    /** A model's current catalog rates. */
    pricing?: (provider: string, model: string) => Pricing | null;
  }) {
    this.registry = options.registry; this.threads = options.threads; this.live = options.live;
    this.chats = options.chats ?? (async () => []);
    this.chatStore = options.chatStore ?? null;
    this.before = options.before ?? (() => null);
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
  remember(id: string, state: PiUsage): void {
    const thread = this.registry.getThread(id);
    if (!thread) return;
    try { this.store(this.piThread(thread, state, "live", Date.now()), null); }
    catch (error) { log.warn("usage snapshot not stored", { thread: id, error }); }
  }

  private base(thread: Thread): Pick<SubjectUsage, "subject" | "kind" | "title" | "projectId" | "agent" | "archived"> {
    return { subject: thread.id, kind: "thread", title: thread.title, projectId: thread.projectId, agent: threadAgent(thread), archived: thread.archived };
  }

  private piThread(thread: Thread, state: PiUsage, read: SubjectUsage["read"], readAt: number): SubjectUsage {
    const { unknownTurns, notes } = piInterrupted(state.interrupted);
    return subject({ ...this.base(thread), lines: piLines(state, "pi", this.pricing), unknownTurns, ...unknownTurns ? { incomplete: true } : {}, read, readAt, notes });
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
    // A read-only reader may leave an empty log beside the store: key it as it is now.
    this.store(usage, fileKey(file));
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
      turns = db.prepare("SELECT seq, state FROM submission WHERE request_id NOT LIKE 'cube:background:%:lost' ORDER BY seq").all() as unknown as ClaudeTurn[];
      records = (db.prepare("SELECT submission, data FROM message WHERE json_extract(data, '$.type') IN ('system', 'result') ORDER BY seq").all() as Array<{ submission: number; data: string }>)
        .map(row => ({ submission: row.submission, data: JSON.parse(row.data) as Record<string, unknown> }));
    } finally { db.close(); }
    const { lines, unknownTurns, notes } = claudeLines(records, turns);
    const usage = subject({ ...this.base(thread), lines, unknownTurns, read: "store", readAt: Date.now(), notes });
    // A running turn reports later: keep only settled readings as cache hits.
    this.store(usage, turns.at(-1)?.state === "running" ? null : key);
    return usage;
  }

  /** The chats' own usage (each chat and its compactor): every workspace's,
   * or only `only`'s. `usage` is their sum, with the chat before workspaces
   * in a report of everything; `chats` has each workspace's apart. */
  async optchatUsage(only: string | null = null): Promise<{ usage: SubjectUsage; threads: string[]; chats: SubjectUsage[]; before: SubjectUsage | null }> {
    let open = new Map<string, OptChatUsage>(), failure: string | null = null;
    try { open = new Map((await this.chats()).map(item => [item.workspace, item.usage])); }
    catch (error) { failure = error instanceof Error ? error.message : String(error); }
    const chats: SubjectUsage[] = [], threads: string[] = [];
    for (const workspace of this.registry.listProjects()) {
      if (only && workspace.id !== only) continue;
      const base = { subject: `chat:${workspace.id}`, kind: "optchat" as const, title: `chat of ${workspace.name}`, projectId: workspace.id, agent: "optchat" as const, archived: !!workspace.archivedAt };
      const live = open.get(workspace.id);
      if (live) {
        const usage = this.chatSubject(base, live);
        this.store(usage, null);
        chats.push(usage);
        threads.push(...live.threads);
        continue;
      }
      const prior = this.stored(base.subject);
      const note = failure ? `the chat is not open (${failure})` : "the chat is not open";
      if (prior) chats.push({ ...prior.usage, read: "snapshot", notes: [...prior.usage.notes, `${note}; this is the last reading`] });
      else if (this.chatStore && !fs.existsSync(this.chatStore(workspace.id))) chats.push(subject({ ...base, lines: [], unknownTurns: 0, read: "store", readAt: Date.now(), notes: ["the chat has not started"] }));
      else chats.push(subject({ ...base, lines: [], unknownTurns: 0, read: "none", readAt: null, notes: [note] }));
    }
    const source = only ? null : this.before();
    const before = source ? this.chatSubject({ subject: "chat:before-workspaces", kind: "optchat", title: "the chat before workspaces", projectId: null, agent: "optchat", archived: true }, source, "store") : null;
    const all = before ? [...chats, before] : chats;
    const read = all.some(item => item.read === "live") ? "live" : all.some(item => item.read === "snapshot") ? "snapshot" : all.some(item => item.read === "store") ? "store" : all.length ? "none" : "store";
    const usage = subject({ subject: OPTCHAT_SUBJECT, kind: "optchat", title: "optchat", projectId: only, agent: "optchat", archived: false,
      lines: mergeLines(all.flatMap(item => item.lines)), unknownTurns: all.reduce((sum, item) => sum + item.unknownTurns, 0),
      incomplete: all.some(item => item.incomplete || item.coverage === "unavailable") && read !== "none", read, readAt: read === "none" ? null : Date.now(),
      notes: all.length === 1 ? all[0]!.notes : all.flatMap(item => item.notes.map(text => `${item.title}: ${text}`)) });
    return { usage, threads, chats, before };
  }

  /** One chat's usage as a subject: its Pi store's lines and its compactor's. */
  private chatSubject(base: Pick<SubjectUsage, "subject" | "kind" | "title" | "projectId" | "agent" | "archived">, chat: OptChatUsage, read: SubjectUsage["read"] = "live"): SubjectUsage {
    const compactor = piLines({ models: chat.compactor.models }, "optchat-compactor", this.pricing)
      .map(line => ({ ...line, calls: chat.compactor.calls[`${line.provider}/${line.model}`] ?? null }));
    const notes = chat.compactor.earlier ? [`compactor calls before ${chat.compactor.since === null ? "now" : new Date(chat.compactor.since).toISOString()} were not counted (an older cube): their usage is unknown`] : [];
    const count = (calls: Record<string, number> | undefined) => Object.values(calls ?? {}).reduce((sum, n) => sum + n, 0);
    const cutChat = count(chat.cut?.chat), cutCompactor = count(chat.cut?.compactor);
    if (cutChat + cutCompactor) notes.push(`${cutChat + cutCompactor} model calls (chat ${cutChat}, compactor ${cutCompactor}) were out when cubed stopped (a crash, a kill, a close past its grace, a failed save): what the provider billed for them is unknown, and they were not sent again on their own`);
    const capped = count(chat.cut?.capped?.chat) + count(chat.cut?.capped?.compactor);
    if (capped) notes.push(`${capped} model calls (chat ${count(chat.cut?.capped?.chat)}, compactor ${count(chat.cut?.capped?.compactor)}) were stopped at their output cap by cube: their provider reports no usage for a call cut off, so what it billed is unknown`);
    const cutTools = Object.entries(chat.cut?.tools ?? {});
    if (cutTools.length) notes.push(`${count(chat.cut?.tools)} tool calls (${cutTools.map(([name, n]) => `${name} ${n}`).join(", ")}) were cut off by a close of cubed: what they did is unknown and was not undone; the reopened chat ran them again under the same request ids`);
    return subject({ ...base, lines: [...piLines(chat.chat, "optchat", this.pricing), ...compactor], unknownTurns: cutChat + cutCompactor + capped, incomplete: !!chat.compactor.earlier || cutChat + cutCompactor + capped > 0, read, readAt: Date.now(), notes });
  }

  /** Usage of every thread (archived included) or of one project's, by
   * project and model, with the chats' own: every workspace's and the chat
   * before workspaces, or the one workspace's. */
  async report(options: { project?: string | null } = {}): Promise<UsageReport> {
    const project = options.project ?? null;
    if (project && !this.registry.getProject(project)) throw new Error("project not found");
    const threads: SubjectUsage[] = [];
    for (const thread of this.registry.listThreads()) {
      if (project && thread.projectId !== project) continue;
      threads.push(await this.thread(thread.id));
    }
    const chat = await this.optchatUsage(project);
    const subjects = [...threads, chat.usage];
    const byProject = new Map<string, SubjectUsage[]>();
    for (const item of threads) byProject.set(item.projectId!, [...byProject.get(item.projectId!) ?? [], item]);
    const spawned = new Set(chat.threads);
    const optchatThreads = threads.filter(item => spawned.has(item.subject));
    const notes = [BILLED_NOTE];
    if (subjects.some(item => item.lines.some(line => line.source === "claude-code"))) notes.push(CLAUDE_BILLING);
    if (subjects.some(item => item.read === "snapshot")) notes.push("some threads are not open now: their last reading is shown");
    notes.push("a model request out when cubed stopped (a crash, a kill, a close past its grace, a failed save) is counted as one without a usage report and is not sent again; what the provider billed for it is unknown");
    return {
      generatedAt: Date.now(), project, totals: totals(subjects), billed: { usd: null, note: BILLED_NOTE },
      projects: [...byProject].map(([id, items]) => ({ id, name: this.registry.getProject(id)?.name ?? id, totals: totals(items) }))
        .sort((a, b) => b.totals.spend.estimatedUsd - a.totals.spend.estimatedUsd),
      models: mergeLines(subjects.flatMap(item => item.lines)).sort((a, b) => b.spend.estimatedUsd - a.spend.estimatedUsd || b.spend.tokens.total - a.spend.tokens.total),
      threads: threads.sort((a, b) => b.spend.estimatedUsd - a.spend.estimatedUsd || b.spend.tokens.total - a.spend.tokens.total),
      optchat: chat.usage,
      optchatThreads: { count: optchatThreads.length, totals: totals(optchatThreads) },
      chats: chat.chats,
      beforeWorkspaces: chat.before,
      notes,
    };
  }
}

/** Size and modification time of a store and its log: changes when it is written. */
function fileKey(file: string): string {
  return [file, `${file}-wal`].map(name => { try { const stat = fs.statSync(name); return `${stat.size}:${stat.mtimeMs}`; } catch { return "-"; } }).join("/");
}

/** Every conversation's `pi.usage` in a store no agent has open (an
 * archived thread's), summed as Harness.usage() does. Read through
 * durable-agent's readStorage: a read-only snapshot, so the retained store is
 * never migrated or checkpointed. */
async function readPiStore(file: string): Promise<PiUsage> {
  const state = await readStorage(file, sumUsage);
  if (!state) throw new Error("the store is gone");
  return state;
}

export async function sumUsage(storage: SqliteStorage): Promise<PiUsage> {
  const sum: { models: Record<string, Usage>; tools: Record<string, Usage> } = { models: {}, tools: {} };
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
  const sends = await storage.findDocument({ kind: SendsDoc.definition.kind, scope: { kind: "session" } }, "current", context);
  const interrupted = sends ? ((await storage.document(sends.id, "current", context))?.value as Sends | undefined)?.interrupted : undefined;
  return { ...sum as UsageState, ...interrupted && Object.keys(interrupted).length ? { interrupted } : {} };
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
