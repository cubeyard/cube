/** OptChat: the user's one endless chat with cube. It keeps no machine and
 * no code tools of its own; it starts threads and talks to them. Every turn
 * is a fresh model context: the system prompt, the view of the whole chat
 * (one-line summaries from a binary tree over the log) and the new message,
 * then that turn's own tool steps. See docs/optchat.md.
 *
 * Pi owns the state. The log is the root conversation's own entries; each
 * turn starts at an `optchat.turn` head entry; the tree's nodes are entries
 * of a second, model-free conversation in the same storage. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { JsonRepresentation } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { cleanupSessionResources, Type, type AssistantMessage, type Message, type Models, type Usage } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, defineTool, GenerationTask, Harness, hook, LiveDoc, ROOT_CONVERSATION_ID, section, type LiveState, type Conversation, type ConversationId, type Cursor, type Page, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openStorage } from "./durable-agent.ts";
import { createLogger } from "./log.ts";
import { compactNode } from "./optchat-compactor.ts";
import { cachedModels, viewPieces } from "./optchat-cache.ts";
import { capText, Memory, type LogMessage, type Part } from "./optchat-memory.ts";
import type { ThreadEvent, ThreadEvents, ThreadTranscript, ThreadWatch } from "./thread-events.ts";
import { addUsage, type OptChatUsage } from "./usage-service.ts";

const context = BACKGROUND_CONTEXT;
const log = createLogger("optchat");
export const JOBS = 8;
export const RETRY_MS = 10_000;

export const MASTER = `You are OptChat, an AI agent that works for one user in a single chat that
never ends. You are the user's interface to cube. You never write code,
run commands or touch files yourself, and you have no machine: you get
work done by starting threads. A thread is a coding agent with its own
virtual machine and a checkout of one project. It does not see this chat,
so give each one a complete task that stands on its own. Follow the
user's instructions at the end of this prompt: they say who the user is,
how their projects are organized and how they want work done.

You keep no memory between turns. Each turn starts with the view below,
followed by the user's new message. Summaries keep little of tool
output, so say in your reply what you learned that will matter later.
Messages the user sends while you work reach you between tool calls.

Threads run in the background. Each one's report reaches you as a
message starting "[id] ": between your tool calls while you work, or as
a new turn once yours has ended. So never wait for one (no sleep, no
polling): go on, or end your turn and tell the user what is running.
tell(id, message) gives a thread that has reported more to do.
history(id) reads one of your threads without changing it: cubed's state
for it beside its latest answer and conversation. Use it when a report is
missing or short, or contradicts what threads shows; say what disagrees
rather than settle it.`;

export const VIEW_DOC = `The view: the whole chat between OptChat and the user, oldest first, inside
<chat> tags, as one-line summaries. Each line is

  id+n|text   the n messages from id on, summarized (newlines shown as spaces)

A summary tags each item with its kind: user (the user's words), talk
(OptChat's replies), tool (OptChat's tool calls), echo (their results), note
(memories from before this chat), or work (the report of a thread, which
the log holds as a user message starting "[id] "). A short message is its
own line, word for word. Recent lines cover one message each; the older
the messages, the more a line covers. A message not summarized yet shows
as "(not summarized yet: zoom it)". No message appears in full, not even
the last ones.

Navigating: zoom(id, n) opens line id+n into the two lines of n/2
messages it was made from; zoom(id, 1) gives message id in full. Zoom
whenever a summary only mentions something you need, such as what your
last reply said, a decision, a past attempt or where a file is, before
you act, guess or ask. date(id) gives the date and time of message id.`;

/** What a thread report says when the thread started: its final reply is the report. */
export const THREAD_NOTE = "(This thread was started by OptChat, the user's chat agent. Your final reply is your report to it.)";

/** Where OptChat's threads come from: cube's projects and threads. */
export interface OptThreads {
  /** Projects, models and capacity a new thread can use, as text. */
  projects(): Promise<string>;
  /** Each runner's last report (version, platform, machines) and what is unknown, as text. */
  runners(): Promise<string>;
  /** Starts one thread; the same request id finds the same thread again. */
  spawn(task: { project: string; task: string; model?: string | undefined }, requestId: string): Promise<{ id: string; title: string }>;
  /** A message to a thread; refused while it works. */
  tell(id: string, text: string, requestId: string): Promise<void>;
  /** One line per thread: its state and title. */
  describe(ids: readonly string[]): Promise<string>;
  /** The thread's events; null once it is archived or gone. */
  events(id: string): Promise<ThreadEvents | null>;
  /** What cubed has of a thread, read only: its own record beside the
   * agent's stored transcript, which may disagree. null: no such thread. */
  history(id: string): Promise<ThreadRecord | null>;
  /** Usage and estimated cost as text: of everything, a project, or one
   * thread (an id or its first characters). Read-only. */
  usage?(query: { project?: string | undefined; thread?: string | undefined }): Promise<string>;
}

export type ThreadRecord = {
  project: string;
  title: string | null;
  archived: boolean;
  /** The machine as cubed sees it ("ready", "starting its machine",
   * "error: …"); null once archived. */
  machine: string | null;
  /** Other facts of cubed's record: workspace, retained disk, agent, writer. */
  facts: string[];
  /** Whether the agent is open in cubed: a stored run goes on only then. */
  agentOpen: boolean;
  /** The machine or workspace failure cubed records, if any. */
  failure: string | null;
  /** The agent's stored transcript; null when it stored none or `unreadable`. */
  transcript: ThreadTranscript | null;
  unreadable: string | null;
};

export const HISTORY_PAGE = 12;
export const HISTORY_MAX = 40;
/** A page's messages share this many characters; one gets at most HISTORY_TEXT. */
const HISTORY_BUDGET = 24_000;
const HISTORY_TEXT = 2000;
const HISTORY_TOOL = 400;
const HISTORY_ANSWER = 4000;

/** Whether history shows an event: thinking and unfinished output are left out. */
const historyShows = (event: ThreadEvent) => event.type === "user-message" || (event.final && !(event.type === "assistant-text" && event.reasoning));
function historyLine(event: ThreadEvent, cap: number): string {
  if (event.type === "user-message") return `user: ${capText(event.text, cap)}`;
  if (event.type === "assistant-text") return `thread: ${capText(event.text, cap)}`;
  const tool = Math.min(cap, HISTORY_TOOL);
  if (event.type === "tool-call") return `tool ${event.name} ${capText(JSON.stringify(event.input ?? {}), tool)}`;
  return `result ${event.name}${event.isError ? " (error)" : ""}: ${capText(event.output, tool)}`;
}

export type ReportState = "delivered" | "accepted" | "none";
const reportText = (report: ReportState) => report === "delivered" ? "delivered" : report === "accepted" ? "accepted, not in the chat yet" : "not sent yet";

/** The history tool's answer: cubed's record of the thread, the run and the
 * latest answer from its stored transcript, whether this chat got the run's
 * report (or, without a transcript, the failure to start), what disagrees,
 * then one page of messages, numbered from the first, ending before message `before`. */
export function formatHistory(id: string, record: ThreadRecord, report: ReportState, page: { before?: number | undefined; limit?: number | undefined } = {}): string {
  const lines = [`[${short(id)}] ${record.project} · ${record.title ?? "untitled"}`,
    `cubed: ${[record.archived ? "archived" : `machine ${record.machine}`, ...record.facts].join("; ")}`];
  const transcript = record.transcript;
  if (!transcript) {
    lines.push(record.unreadable ? `history: unreadable: ${record.unreadable}`
      : `history: none stored; the agent never opened${record.machine === "starting its machine" ? " (its machine is still starting)" : ""}`);
    if (record.failure) lines.push(`failure to start, reported to this chat: ${reportText(report)}`);
    return lines.join("\n");
  }
  const { state, run, error } = transcript.status;
  lines.push(`run: ${state}${run ? ` (${run})` : ""}${error ? `: ${error}` : ""}`);
  const shown = transcript.events.filter(historyShows);
  const answer = shown.findLastIndex(event => event.type === "assistant-text");
  const asked = shown.findLastIndex(event => event.type === "user-message");
  const text = answer < 0 ? "" : (shown[answer] as { text: string }).text.trim();
  lines.push(answer < 0 ? "latest answer: none" : `latest answer #${answer}${asked > answer ? ` (before the newest message #${asked}, which has none yet)` : ""}: ${capText(text, HISTORY_ANSWER)}`);
  if (state !== "idle" && state !== "working" && run) lines.push(`report of this run to this chat: ${reportText(report)}`);
  // Disagreements are shown as cubed has them; this view does not settle them.
  const notes: string[] = [];
  if (record.failure && state !== "idle") notes.push(`cubed records a failure (${record.failure}) while the stored history shows the agent ${state === "working" ? "working" : `ran (run ${state})`}; the history does not say whether the failure came before, during or after that run`);
  if (state === "working" && record.archived) notes.push("the store shows a run unfinished at archive; it does not go on");
  else if (state === "working" && !record.agentOpen) notes.push(transcript.agent === "claude-code"
    ? "the store shows a turn unfinished, but its agent is not open in cubed: Claude Code does not continue it; it shows as failed once the agent opens again"
    : "the store shows a run unfinished, but its agent is not open in cubed: it goes on only when the agent opens again");
  for (const note of notes) lines.push(`note: ${note}`);
  const total = shown.length;
  const limit = Math.min(Math.max(page.limit ?? HISTORY_PAGE, 1), HISTORY_MAX);
  const end = Math.min(Math.max(page.before ?? total, 0), total);
  const start = Math.max(0, end - limit);
  const cap = Math.min(HISTORY_TEXT, Math.floor(HISTORY_BUDGET / Math.max(1, end - start)));
  if (!total) lines.push("messages: none");
  else if (start === end) lines.push(`messages: none before #${end} (${total} in all)`);
  else {
    lines.push(`messages #${start}–#${end - 1} of ${total}, oldest first${start > 0 ? `; earlier: history("${short(id)}", before: ${start})` : ""}`);
    for (let k = start; k < end; k++) lines.push(`#${k} ${historyLine(shown[k]!, cap)}`);
  }
  return lines.join("\n");
}

/** `cache` names the chat for the providers' prompt caches; it never changes. */
type Settings = { tree: number; cache: string; threads: Record<string, { at: number }> };
const SettingsDoc = defineDoc<Settings>({ kind: "cube.optchat", version: 1, scope: "session", initial: () => ({ tree: 0, cache: "", threads: {} }) });
/** The view parts the current turn started with; the request hook renders them. */
const TurnDoc = defineDoc<{ started: boolean; parts: number[] }>({
  kind: "cube.optchat.turn", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ started: false, parts: [] }),
});
/** A message accepted when the log had `after` as its newest entry. */
type PendingItem = { text: string; requestId: string; after: number };
/** Messages accepted but not yet in the chat: waiting (`items`), going into
 * the next turn (`batch`), or submitted but not placed by Pi yet (`sent`). */
type Pending = { items: PendingItem[]; batch: PendingItem[] | null; sent: PendingItem[] };
const PendingDoc = defineDoc<Pending>({ kind: "cube.optchat.pending", version: 1, scope: "session", initial: () => ({ items: [], batch: null, sent: [] }) });
/** The view as of the newest node, over the first `total` messages: a reopen
 * goes on from it instead of folding a different view. */
const ViewDoc = defineDoc<{ total: number; parts: number[] }>({ kind: "cube.optchat.view", version: 1, scope: "session", initial: () => ({ total: 0, parts: [] }) });
/** The compactor's model calls run beside Pi, so Pi's `pi.usage` does not
 * see them: their usage by `provider/model`, one commit per reply, failed
 * replies included. `since` is when this store began counting; `earlier`
 * says its tree already had compactor-built nodes then, whose calls nobody
 * counted. */
type CompactorUsage = { models: Record<string, JsonRepresentation<Usage>>; calls: Record<string, number>; since: number | null; earlier?: boolean };
const CompactorUsageDoc = defineDoc<CompactorUsage>({ kind: "cube.optchat.usage", version: 1, scope: "session", initial: () => ({ models: {}, calls: {}, since: null }) });
const TURN = "optchat.turn";
const NODE_ENTRY = "optchat.node";

const short = (id: string) => id.slice(0, 8);
/** A zoom result's lines start with their ids. */
const ZOOMED = /^\d+\+\d+\|/;
export const ZOOM_ECHO = "(the zoomed lines: a copy of earlier messages of this chat, not repeated here)";
const userEntry = (text: string) => ({ kind: "pi.user", model: [{ role: "user" as const, content: text, timestamp: Date.now() }] });
const flatParts = (parts: readonly Part[]) => parts.flatMap(part => [part.l, part.i]);
const toParts = (flat: readonly number[]) => {
  const parts: Part[] = [];
  for (let k = 0; k + 1 < flat.length; k += 2) parts.push({ l: flat[k]!, i: flat[k + 1]! });
  return parts;
};
const textOf = (content: Message["content"]) => typeof content === "string" ? content
  : content.map(part => part.type === "text" ? part.text : part.type === "image" ? "[image]" : "").join("\n");

/** The log messages one Pi entry holds. Thoughts are never logged. */
export function entryMessages(entry: EntryRecord): LogMessage[] {
  const out: LogMessage[] = [];
  for (const message of entry.model ?? []) {
    const date = message.timestamp;
    if (entry.kind === "pi.user" && message.role === "user") out.push({ kind: "user", text: textOf(message.content), date });
    else if (entry.kind === "pi.assistant" && message.role === "assistant") {
      // A failed attempt is retried and never reaches the model again; an
      // aborted one ran none of its tool calls.
      if (message.stopReason === "error") continue;
      for (const part of message.content) {
        if (part.type === "text" && part.text.trim()) out.push({ kind: "talk", text: part.text, date });
        else if (part.type === "toolCall" && message.stopReason !== "aborted") out.push({ kind: "tool", text: capText(`${part.name} ${JSON.stringify(part.arguments ?? {})}`), date });
      }
    } else if (entry.kind === "pi.tool-result" && message.role === "toolResult") {
      // A zoom result copies lines of this chat: logged as a pointer, so the
      // compactor neither summarizes the copy again nor reads its ids and
      // "user:" tags as new words of the user.
      const text = textOf(message.content);
      out.push({ kind: "echo", text: message.toolName === "zoom" && ZOOMED.test(text) ? ZOOM_ECHO : capText(text), date });
    }
  }
  return out;
}

/** The report a settled thread run sends: its last reply, or why it ended. */
export function threadReport(transcript: ThreadTranscript): string {
  const events = transcript.events;
  const lastUser = events.findLastIndex(event => event.type === "user-message");
  const reply = events.slice(lastUser + 1).findLast(event => event.type === "assistant-text" && !event.reasoning);
  const text = reply?.type === "assistant-text" ? reply.text.trim() : "";
  const status = transcript.status;
  if (status.state === "completed") return text || "(finished without a reply)";
  if (status.state === "stopped") return `stopped${text ? `; last reply: ${text}` : ""}`;
  return `failed: ${status.error ?? "unknown error"}${text ? `; last reply: ${text}` : ""}`;
}

export type OptChatOptions = {
  directory: string;
  models: Models;
  /** The model a new chat starts with. */
  model: () => Promise<{ provider: string; id: string } | null>;
  /** The compactor's model; default: the chat's own model. */
  compactor?: { provider: string; id: string } | null;
  threads: OptThreads;
  /** Tests lower these. */
  limits?: { view?: number; node?: number; jobs?: number; retryMs?: number; watchMs?: number };
};

export class OptChat {
  readonly memory: Memory;
  private harness!: Harness;
  private conversation!: Conversation;
  private storage!: SqliteStorage;
  private tree = 0 as ConversationId;
  private lastEntry = 0;
  private readonly busy = new Set<string>();
  private readonly failed = new Set<string>();
  private compactorError: string | null = null;
  private readonly watchers = new Map<string, Promise<ThreadWatch | null>>();
  private readonly reported = new Map<string, string>();
  private readonly startReported = new Set<string>();
  private lock: Promise<unknown> = Promise.resolve();
  private cacheKey = "optchat";
  private compactorModels!: Models;
  private readonly waiters = new Set<() => void>();
  private readonly pendingListeners = new Set<() => void>();
  private draining: Promise<void> | null = null;
  private again = false;
  private syncing: Promise<void> | null = null;
  private dirty = false;
  private closing = false;
  private readonly abort = new AbortController();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private watchTimer: ReturnType<typeof setInterval> | undefined;
  private stopWatch: (() => Promise<void>) | undefined;
  private model: { provider: string; id: string } | null = null;
  private readonly options: OptChatOptions;
  private constructor(options: OptChatOptions) {
    this.options = options;
    this.memory = new Memory(options.limits ?? {});
  }

  static async open(options: OptChatOptions): Promise<OptChat> {
    const chat = new OptChat(options);
    try { await chat.start(); }
    catch (error) { await chat.close(); throw error; }
    return chat;
  }

  /** The chat as the Pi adapter of the thread event model reads it. */
  get agent() { return { conversation: this.conversation, storage: this.storage }; }
  /** Why the chat cannot go on right now, if it cannot. */
  failure(): string | null { return this.compactorError ? `summarizing: ${this.compactorError}` : null; }

  /** `listener` runs whenever the pending messages change. */
  onPending(listener: () => void): () => void {
    this.pendingListeners.add(listener);
    return () => { this.pendingListeners.delete(listener); };
  }
  private pendingChanged(): void { for (const listener of [...this.pendingListeners]) listener(); }

  /** Wakes every waiter: the view, the run or the pending messages changed. */
  private notify(): void { for (const waiter of [...this.waiters]) waiter(); }
  /** Resolves once `ready()` holds; rejects when the chat closes. */
  private waitFor(ready: () => boolean | Promise<boolean>): Promise<void> {
    return new Promise((resolve, reject) => {
      let checking = false, again = false;
      const done = (error?: unknown) => { this.waiters.delete(check); if (error) reject(error); else resolve(); };
      const check = async () => {
        if (checking) { again = true; return; }
        checking = true;
        try {
          do {
            again = false;
            if (this.closing) return done(new Error("optchat is closing"));
            if (await ready()) return done();
          } while (again);
        } catch (error) { done(error); }
        finally { checking = false; }
      };
      this.waiters.add(check);
      void check();
    });
  }

  private async start(): Promise<void> {
    const directory = this.options.directory;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.storage = await openStorage(path.join(directory, "pi.sqlite"));
    const registry = createRegistry();
    registry.install(this.extension());
    this.harness = await Harness.open(this.storage, { models: cachedModels(this.options.models, () => this.cacheKey), registry, settings: {
      // The spec's caching: short entries only, never 1-hour ones.
      stream: { cacheRetention: "short" },
      toolExecution: "sequential",
      // Every message steered into a tool round is placed at its boundary,
      // none left over to continue the run after its final answer.
      steeringMode: "all",
      // Every turn is a fresh context; nothing grows to compact.
      compaction: { enabled: false },
    } }, context);
    this.tree = await this.harness.commit(async tx => {
      const settings = await tx.doc(SettingsDoc);
      if (!settings.tree) settings.tree = (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
      settings.cache ||= randomUUID();
      return settings.tree as ConversationId;
    }, context);
    const settings = await this.harness.snapshot(SettingsDoc, context);
    this.cacheKey = `optchat-${settings!.cache}`;
    this.compactorModels = cachedModels(this.options.models, () => `${this.cacheKey}-compact`);
    const existing = await this.harness.conversation(ROOT_CONVERSATION_ID, context);
    if (existing) this.conversation = existing;
    else {
      const model = await this.options.model();
      if (!model) throw new Error("connect a model provider first");
      this.conversation = await this.harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
    }
    const agent = (await this.conversation.agent(context)).model;
    this.model = agent ? { provider: agent.provider, id: agent.modelId } : null;
    this.memory.onChange = () => this.notify();
    // The nodes first, then the stored view over the part of the log it
    // covered, then the messages after it. A view that does not fit is
    // folded again from the log.
    const nodes: Array<{ l: number; i: number }> = [];
    for (const entry of await this.scan(this.tree, 0)) {
      const node = entry.data as { l: number; i: number; text: string } | undefined;
      if (entry.kind === NODE_ENTRY && node) { this.memory.setNode(node.l, node.i, node.text); nodes.push(node); }
    }
    const messages: LogMessage[] = [];
    for (const entry of await this.scan(this.conversation.id, 0)) {
      messages.push(...entryMessages(entry));
      this.lastEntry = entry.id;
    }
    const stored = await this.harness.snapshot(ViewDoc, context);
    const total = stored && stored.total <= messages.length && this.memory.restore(messages.slice(0, stored.total), toParts(stored.parts)) ? stored.total : 0;
    for (const message of messages.slice(total)) this.memory.append(message);
    // The compactor is counted from the first open that knows how. A tree
    // that already holds a node the compactor built (not one whose text fit
    // as it was) had calls nobody counted.
    const compacted = () => nodes.some(({ l, i }) => {
      // A node whose sources are gone cannot be judged: counted as compacted.
      if (l === 0 ? i >= this.memory.length : !this.memory.built(l - 1, 2 * i) || !this.memory.built(l - 1, 2 * i + 1)) return true;
      try { return !("free" in this.memory.source(l, i)); } catch { return true; }
    });
    if ((await this.harness.snapshot(CompactorUsageDoc, context))?.since == null) await this.harness.commit(async tx => {
      const usage = await tx.doc(CompactorUsageDoc);
      if (usage.since !== null) return;
      usage.since = Date.now();
      if (compacted()) usage.earlier = true;
    }, context);
    const watch = await this.conversation.watch(context);
    // Delivery runs again on every change too: a steered message is
    // forgotten once Pi has placed it, which happens after the steer.
    watch.start(async () => { void this.sync(); this.notify(); void this.drain(); });
    this.stopWatch = async () => { await watch.stop(); };
    this.harness.resume();
    this.pump();
    void this.drain();
    await this.watchThreads();
    this.watchTimer = setInterval(() => { void this.watchThreads(); }, this.options.limits?.watchMs ?? 15_000);
    this.watchTimer.unref();
  }

  /** Every entry of a conversation after `after`, oldest first. */
  private async scan(conversationId: ConversationId, after: number): Promise<EntryRecord[]> {
    const items: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page: Page<EntryRecord, Cursor> = await this.harness.commit(tx => tx.scanEntries({ conversationId, minEntryId: (after + 1) as EntryId }, 256, cursor), context);
      items.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return items.filter(entry => entry.id > after).sort((a, b) => a.id - b.id);
  }

  /** Appends the root conversation's new entries to the log. */
  private sync(): Promise<void> {
    if (this.syncing) { this.dirty = true; return this.syncing; }
    this.syncing = (async () => {
      do {
        this.dirty = false;
        for (const entry of await this.scan(this.conversation.id, this.lastEntry)) {
          for (const message of entryMessages(entry)) this.memory.append(message);
          this.lastEntry = entry.id;
        }
      } while (this.dirty && !this.closing);
    })().catch(error => { if (!this.closing) log.warn("log sync failed", { error }); })
      .finally(() => { this.syncing = null; this.pump(); });
    return this.syncing;
  }

  /** Starts every node that may be built now, up to JOBS at once. */
  private pump(): void {
    if (this.closing || !this.conversation) return;
    for (const job of this.memory.ready(this.busy, this.options.limits?.jobs ?? JOBS)) {
      const key = `${job.l}:${job.i}`;
      this.busy.add(key);
      this.build(job.l, job.i).then(() => {
        this.busy.delete(key);
        this.failed.delete(key);
        if (!this.failed.size) this.compactorError = null;
        this.pump();
      }, error => {
        if (this.closing) return;
        const message = error instanceof Error ? error.message : String(error);
        if (!this.failed.has(key)) log.warn("compactor failed", { node: key, error: message });
        this.failed.add(key);
        this.compactorError = message;
        // Retry soon and forever: the next turn waits for this node.
        const timer = setTimeout(() => { this.timers.delete(timer); this.busy.delete(key); this.pump(); }, this.options.limits?.retryMs ?? RETRY_MS);
        this.timers.add(timer);
      });
    }
  }

  private async build(l: number, i: number): Promise<void> {
    const source = this.memory.source(l, i);
    let text: string;
    if ("free" in source) text = source.free;
    else {
      const model = this.options.compactor ?? this.model;
      if (!model) throw new Error("the chat has no model");
      text = await compactNode({ models: this.compactorModels, model, context: this.memory.context(l, i), source, node: this.memory.nodeLimit, signal: this.abort.signal,
        onReply: reply => this.countCompactor(reply) });
    }
    if (this.closing) return;
    // Stored first: memory never holds a node storage lacks. The view it
    // leads to is a cache for the next open, written after.
    await this.harness.commit(tx => tx.appendEntry(this.tree, { kind: NODE_ENTRY, data: { l, i, text } }), context);
    this.memory.setNode(l, i, text);
    const view = { total: this.memory.length, parts: flatParts(this.memory.view) };
    await this.harness.commit(async tx => { Object.assign(await tx.doc(ViewDoc), view); }, context)
      .catch(error => { if (!this.closing) log.warn("view not stored", { error }); });
  }

  /** Adds one compactor reply's usage. Best effort: a failed commit loses
   * that reply's usage, never the node. */
  private async countCompactor(reply: AssistantMessage): Promise<void> {
    const key = `${reply.provider}/${reply.model}`;
    await this.harness.commit(async tx => {
      const usage = await tx.doc(CompactorUsageDoc);
      const total = Object.hasOwn(usage.models, key) ? usage.models[key] : undefined;
      // A key holds a slash, so it is never `__proto__`.
      if (total) addUsage(total as unknown as Usage, reply.usage);
      else usage.models[key] = JSON.parse(JSON.stringify(reply.usage)) as JsonRepresentation<Usage>;
      usage.calls[key] = (Object.hasOwn(usage.calls, key) ? usage.calls[key]! : 0) + 1;
    }, context).catch(error => { if (!this.closing) log.warn("compactor usage not counted", { error }); });
  }

  /** The chat's own usage (its Pi store and its compactor) and the threads it started. */
  async usage(): Promise<OptChatUsage> {
    const compactor = await this.harness.snapshot(CompactorUsageDoc, context);
    const threads = Object.keys((await this.harness.snapshot(SettingsDoc, context))?.threads ?? {});
    return { chat: await this.harness.usage(context) as OptChatUsage["chat"],
      compactor: compactor ? JSON.parse(JSON.stringify(compactor)) as OptChatUsage["compactor"] : { models: {}, calls: {}, since: null, earlier: false }, threads };
  }

  /** Accepts a user message or a thread report and keeps it until it is in
   * the chat. The same request id is accepted once. */
  async send(text: string, requestId: string): Promise<void> {
    const conversation = this.conversation;
    await this.harness.commit(async tx => {
      const pending = await tx.doc(PendingDoc);
      const same = (item: PendingItem) => item.requestId === requestId;
      if (pending.items.some(same) || pending.batch?.some(same) || pending.sent.some(same)) return;
      if (await tx.submissionByRequest(conversation.id, requestId) || await tx.submissionByRequest(conversation.id, `${requestId}:unanswered`)) return;
      pending.items.push({ text, requestId, after: this.lastEntry });
    }, context);
    this.notify();
    this.pendingChanged();
    void this.drain();
  }

  /** The short ids of the threads this chat started. */
  async threadPrefixes(): Promise<Set<string>> {
    return new Set(Object.keys((await this.harness.snapshot(SettingsDoc, context))?.threads ?? {}).map(short));
  }

  /** Messages accepted but not yet shown in the chat, oldest first. */
  async pending(): Promise<PendingItem[]> {
    const pending = await this.harness.snapshot(PendingDoc, context);
    return pending ? [...pending.sent, ...(pending.batch ?? []), ...pending.items] : [];
  }

  private async live() { return this.harness.snapshot(LiveDoc, this.conversation.id, context); }

  /** Runs `action` alone among the steps that move pending messages
   * (steering, a turn's submission, stop). */
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const run = this.lock.catch(() => {}).then(action);
    this.lock = run;
    return run;
  }

  /** Delivers pending messages. During a tool round they are steered in and
   * reach the model between tool calls. During a generation they wait for
   * the run to end, so a turn never continues into the next one. Idle: once
   * every line of the view is a summary, all of them start one fresh turn. */
  private drain(): Promise<void> {
    if (this.draining) { this.again = true; return this.draining; }
    this.draining = (async () => {
      do {
        this.again = false;
        for (;;) {
          if (this.closing) return;
          const pending = await this.harness.snapshot(PendingDoc, context);
          if (pending?.sent.length) await this.exclusive(() => this.pruneSent());
          if (pending?.batch) {
            const head = await this.known(`${pending.batch[0]!.requestId}:turn`);
            if (!head) await this.waitFor(() => this.memory.settled());
            await this.exclusive(() => this.submitBatch());
            continue;
          }
          if (!pending?.items.length) break;
          const toolRound = (live: LiveState | undefined) => !!live?.tools?.some(slot => slot.status !== "done");
          const live = await this.live();
          if (live?.run) {
            if (toolRound(live)) { await this.exclusive(() => this.steer()); continue; }
            await this.waitFor(async () => { const now = await this.live(); return !now?.run || toolRound(now); });
            continue;
          }
          await this.sync();
          await this.waitFor(() => this.memory.settled());
          if ((await this.live())?.run) continue;
          // Everything waiting goes into this turn, as the spec's take_all.
          await this.exclusive(() => this.harness.commit(async tx => {
            const doc = await tx.doc(PendingDoc);
            if (doc.batch || !doc.items.length) return;
            doc.batch = doc.items.map(item => ({ ...item }));
            doc.items = [];
          }, context));
          this.pendingChanged();
        }
      } while (this.again && !this.closing);
    })().catch(error => {
      if (this.closing) return;
      log.warn("delivery failed", { error });
      const timer = setTimeout(() => { this.timers.delete(timer); void this.drain(); }, this.options.limits?.retryMs ?? RETRY_MS);
      this.timers.add(timer);
    }).finally(() => {
      this.draining = null;
      if (this.again && !this.closing) void this.drain();
    });
    return this.draining;
  }

  private async known(requestId: string) {
    return this.conversation.commit(tx => tx.submissionByRequest(this.conversation.id, requestId), context);
  }

  /** Every waiting message, steered into the running tool round. Pi places
   * them all at the round's boundary (steeringMode "all"). */
  private async steer(): Promise<void> {
    const items = (await this.harness.snapshot(PendingDoc, context))?.items ?? [];
    for (const item of items) {
      await this.conversation.submit({ type: "input", content: item.text, requestId: item.requestId, whenBusy: "steer" }, context);
      await this.harness.commit(async tx => {
        const doc = await tx.doc(PendingDoc);
        doc.items = doc.items.filter(other => other.requestId !== item.requestId);
        doc.sent.push({ ...item });
      }, context);
      this.pendingChanged();
    }
  }

  /** Forgets sent messages once Pi has placed them, or a stop withdrew them. */
  private async pruneSent(): Promise<void> {
    const sent = (await this.harness.snapshot(PendingDoc, context))?.sent ?? [];
    const settled: string[] = [];
    for (const item of sent) if ((await this.known(item.requestId))?.status !== "queued") settled.push(item.requestId);
    if (!settled.length) return;
    await this.harness.commit(async tx => {
      const doc = await tx.doc(PendingDoc);
      doc.sent = doc.sent.filter(item => !settled.includes(item.requestId));
    }, context);
    this.pendingChanged();
  }

  /** One fresh turn: its view parts and a head entry, every message but the
   * last as a user entry, then the last as the input that starts the run.
   * Each is its own Pi submission, so after a restart it goes on where it
   * stopped and every request id stays known. */
  private async submitBatch(): Promise<void> {
    const conversation = this.conversation;
    const batch = (await this.harness.snapshot(PendingDoc, context))?.batch;
    if (!batch?.length) return;
    const last = batch.at(-1)!;
    if (!await this.known(last.requestId)) {
      if (!await this.known(`${batch[0]!.requestId}:turn`)) {
        const parts = flatParts(this.memory.view);
        await conversation.commit(async tx => { Object.assign(await tx.doc(TurnDoc, conversation.id), { started: true, parts }); }, context);
        await conversation.submit({ type: "write", entry: { kind: TURN, head: "self" }, requestId: `${batch[0]!.requestId}:turn` }, context);
      }
      for (const item of batch.slice(0, -1)) {
        if (!await this.known(item.requestId)) await conversation.submit({ type: "write", requestId: item.requestId, entry: userEntry(item.text) }, context);
      }
      await conversation.submit({ type: "input", content: last.text, requestId: last.requestId, whenBusy: "steer" }, context);
    }
    await this.harness.commit(async tx => {
      const doc = await tx.doc(PendingDoc);
      if (doc.batch?.at(-1)?.requestId !== last.requestId) return;
      doc.sent.push({ ...last });
      doc.batch = null;
    }, context);
    this.pendingChanged();
  }

  /** Stops the running turn. Messages still waiting, and any the stop
   * withdrew before Pi placed them, stay in the log, unanswered, as the
   * spec's cancelled wait. */
  async stop(): Promise<void> {
    await this.exclusive(async () => {
      await this.conversation.abort(context);
      const pending = await this.harness.snapshot(PendingDoc, context);
      const withdrawn: PendingItem[] = [];
      for (const item of pending?.sent ?? []) {
        const submission = await this.known(item.requestId);
        if (submission?.status === "unanswered" && submission.entry === undefined) withdrawn.push(item);
      }
      for (const item of [...withdrawn, ...(pending?.batch ?? []), ...(pending?.items ?? [])]) {
        if (await this.known(item.requestId) && !withdrawn.includes(item)) continue;
        if (!await this.known(`${item.requestId}:unanswered`)) {
          await this.conversation.submit({ type: "write", requestId: `${item.requestId}:unanswered`, entry: userEntry(item.text) }, context);
        }
      }
      await this.harness.commit(async tx => {
        const doc = await tx.doc(PendingDoc);
        doc.items = [];
        doc.batch = null;
        doc.sent = [];
      }, context);
    });
    this.notify();
    this.pendingChanged();
  }

  async selectModel(selection?: { provider: string; id: string }): Promise<{ provider: string; id: string } | null> {
    if (selection) {
      if (await this.harness.snapshot(LiveDoc, this.conversation.id, context).then(live => live?.run)) throw new Error("wait for the current run before changing model");
      if (!this.options.models.getModel(selection.provider, selection.id)) throw new Error("model unavailable");
      await this.conversation.configure({ model: { provider: selection.provider, modelId: selection.id } }, context);
      this.model = selection;
    }
    return this.model;
  }

  /** Watches every thread this chat started; a settled run sends its report once. */
  private async watchThreads(): Promise<void> {
    if (this.closing) return;
    const settings = await this.harness.snapshot(SettingsDoc, context);
    for (const id of Object.keys(settings?.threads ?? {})) {
      if (this.watchers.has(id)) continue;
      const watching = (async () => {
        let events: ThreadEvents | null;
        try { events = await this.options.threads.events(id); }
        catch (error) {
          // A thread whose machine failed to start reports that once; the
          // next round watches it again.
          // Reported once per thread; it is watched again later.
          const message = error instanceof Error ? error.message : String(error);
          if (!this.startReported.has(id)) void this.send(`[${short(id)}] failed to start: ${message}`, `report:${id}:start`).catch(() => {});
          this.startReported.add(id);
          this.watchers.delete(id);
          return null;
        }
        if (!events || this.closing) return null;
        const watch = await events.watch(transcript => this.observe(id, transcript), { onEnd: () => { this.watchers.delete(id); } });
        // An archived thread's source closes; the next round finds it gone.
        void watch.closed.then(() => { if (!this.closing) this.watchers.delete(id); });
        return watch;
      })();
      this.watchers.set(id, watching);
    }
  }

  private observe(id: string, transcript: ThreadTranscript): void {
    const status = transcript.status;
    if (status.state === "idle" || status.state === "working" || !status.run || this.reported.get(id) === status.run) return;
    this.reported.set(id, status.run);
    void this.send(`[${short(id)}] ${capText(threadReport(transcript))}`, `report:${id}:${status.run}`)
      .catch(error => { if (!this.closing) log.warn("report delivery failed", { thread: id, error }); });
  }

  /** The thread a short id names, among the ones this chat started. */
  private async resolve(id: string): Promise<string> {
    const threads = Object.keys((await this.harness.snapshot(SettingsDoc, context))?.threads ?? {});
    const prefix = id.replace(/^\[|\]$/g, "");
    if (!prefix) throw new Error("name a thread by its id");
    const matches = threads.filter(thread => thread.startsWith(prefix));
    if (matches.length !== 1) throw new Error(matches.length ? `${id} names more than one thread` : `no thread ${id}`);
    return matches[0]!;
  }

  private extension() {
    const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
    const zoom = defineTool({
      name: "zoom",
      description: "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole.",
      parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), n: Type.Integer({ minimum: 1 }) }),
      replay: "safe",
      execute: async args => text(this.memory.zoom(args.id, args.n)),
    });
    const date = defineTool({
      name: "date",
      description: "The date and time of message id (the cube host's local time).",
      parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
      replay: "safe",
      execute: async args => {
        const message = this.memory.messages[args.id];
        return text(message ? new Date(message.date).toString() : `No message ${args.id}.`);
      },
    });
    const projects = defineTool({
      name: "projects",
      description: "The projects a thread can start in, the models it can run and how many thread machines are free.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => text(await this.options.threads.projects()),
    });
    const runners = defineTool({
      name: "runners",
      description: "The runners that host thread machines, as cubed last heard from them: version, platform, contact, machines and slots, "
        + "and what is unknown. Read-only. Report it as it says: a stale or missing report is unknown, not the runner's current state; "
        + "a published release does not mean a runner installed it; slots in use do not mean a runner hosts only that many.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => text(await this.options.threads.runners()),
    });
    const spawn = defineTool({
      name: "spawn",
      description: "Start one thread per task, in parallel, and answer their ids at once. Each thread is a coding agent with its own machine and a checkout of the project; it does not see this chat. Its report comes back later as a message starting \"[id] \".",
      parameters: Type.Object({ tasks: Type.Array(Type.Object({
        project: Type.String({ description: "Project name or id" }),
        task: Type.String({ description: "The whole task, self-contained" }),
        model: Type.Optional(Type.String({ description: "provider/model; default: the host's preferred model" })),
      }), { minItems: 1 }) }),
      // A request id per call and task: a rerun finds the same threads.
      replay: "safe",
      execute: async (args, api, callContext) => {
        const lines: string[] = [];
        for (const [index, task] of args.tasks.entries()) {
          try {
            const thread = await this.options.threads.spawn(task, `optchat:${api.callId}:${index}`);
            await api.commit(async tx => { (await tx.doc(SettingsDoc)).threads[thread.id] ??= { at: Date.now() }; }, callContext);
            lines.push(`[${short(thread.id)}] started in ${task.project}: ${thread.title}`);
          } catch (error) {
            lines.push(`task ${index + 1} (${task.project}) not started: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        void this.watchThreads();
        return text(lines.join("\n"));
      },
    });
    const tell = defineTool({
      name: "tell",
      description: "Send a message to a thread you started, once it has reported: more work, an answer or a correction.",
      parameters: Type.Object({ id: Type.String(), message: Type.String() }),
      replay: "safe",
      execute: async (args, api) => {
        const id = await this.resolve(args.id);
        await this.options.threads.tell(id, args.message, `optchat:${api.callId}`);
        return text(`sent to [${short(id)}]; its report comes back as a message starting "[${short(id)}] "`);
      },
    });
    const threads = defineTool({
      name: "threads",
      description: "The threads you started, with their state.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => {
        const ids = Object.keys((await this.harness.snapshot(SettingsDoc, context))?.threads ?? {});
        return text(ids.length ? await this.options.threads.describe(ids) : "no threads yet");
      },
    });
    const history = defineTool({
      name: "history",
      description: `Read a thread you started, read only: cubed's own state for it, its run and latest answer, whether its report reached you, what disagrees, then its stored conversation, ${HISTORY_PAGE} messages at a time, newest last (before: show the messages before message #before, as its "earlier:" line gives; limit: at most ${HISTORY_MAX}). Archived threads and threads whose machine failed keep theirs.`,
      parameters: Type.Object({
        id: Type.String(),
        before: Type.Optional(Type.Integer({ minimum: 0, description: "Show the messages before message #before" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: HISTORY_MAX })),
      }),
      replay: "safe",
      execute: async args => {
        const id = await this.resolve(args.id);
        const record = await this.options.threads.history(id);
        if (!record) return text(`[${short(id)}] is gone: cubed has no record of it`);
        // A run's report, or without a transcript the failure to start.
        const run = record.transcript ? record.transcript.status.run : "start";
        const requestId = `report:${id}:${run}`;
        const report = !run ? "none" : await this.known(requestId) ? "delivered"
          : (await this.pending()).some(item => item.requestId === requestId) ? "accepted" : "none";
        return text(formatHistory(id, record, report, args));
      },
    });
    const usage = defineTool({
      name: "usage",
      description: "Token usage and estimated cost so far: of everything (by project, model and thread, and your own), of one project, or of one thread (its id). Estimates, not charges; usage without a record is reported as unknown.",
      parameters: Type.Object({
        project: Type.Optional(Type.String({ description: "Project name or id" })),
        thread: Type.Optional(Type.String({ description: "Thread id or its first characters" })),
      }),
      replay: "safe",
      execute: async args => text(this.options.threads.usage ? await this.options.threads.usage(args) : "usage is not available"),
    });
    const instructions = path.join(this.options.directory, "AGENTS.md");
    return defineExtension({
      name: "optchat",
      tools: [zoom, date, projects, runners, spawn, tell, threads, history, usage],
      sections: [
        section("master", () => MASTER, { tag: false }),
        section("view", () => VIEW_DOC, { tag: false }),
        // The user's own instructions; constant unless they edit the file.
        section("user", () => {
          try { return fs.readFileSync(instructions, "utf8").trim() || undefined; }
          catch { return undefined; }
        }, { tag: false }),
      ],
      hooks: [hook(GenerationTask, { beforeRequest: async (request, api, callContext) => {
        const turn = await api.snapshot(TurnDoc, api.conversationId, callContext);
        if (!turn?.started) return undefined;
        const parts: Part[] = [];
        for (let k = 0; k + 1 < turn.parts.length; k += 2) parts.push({ l: turn.parts[k]!, i: turn.parts[k + 1]! });
        return { messages: withView(request.messages, viewPieces(this.memory.render(parts))) };
      } })],
    });
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.abort.abort();
    this.notify();
    for (const timer of this.timers) clearTimeout(timer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    await Promise.allSettled([...this.watchers.values()].map(async watching => (await watching)?.stop()));
    await this.stopWatch?.().catch(() => {});
    await this.syncing;
    await (this.harness ?? this.storage)?.close(context).catch(() => {});
    // pi-ai keeps a provider connection per cache key open for minutes
    // (Codex's WebSocket); it would hold cubed's exit that long.
    for (const key of [this.cacheKey, `${this.cacheKey}-compact`]) {
      try { cleanupSessionResources(key); } catch (error) { log.warn("session resources not released", { error }); }
    }
  }
}

/** The turn's request: the system baseline first (Pi writes it after the
 * turn's first user message), then that message with the view's pieces as
 * its first blocks, then the turn's own steps. */
export function withView(messages: readonly Message[], pieces: readonly string[]): Message[] {
  const index = messages.findIndex(message => message.role === "user");
  if (index < 0) return [...messages];
  const out = messages.map((message, k) => {
    if (k !== index || message.role !== "user") return message;
    const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    return { ...message, content: [...pieces.map(text => ({ type: "text" as const, text })), ...content] };
  });
  const system = out.findIndex((message, k) => k > index && message.role === "system");
  if (system === index + 1 && !out.slice(0, index).some(message => message.role === "system")) {
    const [baseline] = out.splice(system, 1);
    out.splice(index, 0, baseline!);
  }
  return out;
}

/** The chat in the thread event model: Pi's transcript, then the messages
 * still waiting for their turn, shown as working (with the compactor's
 * failure, if it is stuck). */
export class OptChatEvents implements ThreadEvents {
  private readonly chat: OptChat;
  private readonly inner: ThreadEvents;
  constructor(chat: OptChat, inner: ThreadEvents) { this.chat = chat; this.inner = inner; }

  async read(): Promise<ThreadTranscript> { return this.merge(await this.inner.read()); }

  async watch(listener: (transcript: ThreadTranscript) => void | Promise<void>, options?: Parameters<ThreadEvents["watch"]>[1]): Promise<ThreadWatch> {
    let latest: ThreadTranscript | undefined;
    let chain: Promise<void> = Promise.resolve();
    const emit = () => { chain = chain.then(async () => { if (latest) await listener(await this.merge(latest)); }).catch(() => {}); return chain; };
    const unsubscribe = this.chat.onPending(() => { void emit(); });
    try {
      const watch = await this.inner.watch(transcript => { latest = transcript; return emit(); }, options);
      return { closed: watch.closed.finally(unsubscribe), async stop() { unsubscribe(); await watch.stop(); } };
    } catch (error) { unsubscribe(); throw error; }
  }

  private async merge(input: ThreadTranscript): Promise<ThreadTranscript> {
    // A report of a thread this chat started is marked as the thread's.
    const threads = await this.chat.threadPrefixes();
    const report = (text: string) => /^\[([0-9a-f]{8})\] /.exec(text)?.[1];
    const transcript = { ...input, events: input.events.map(event => {
      const from = event.type === "user-message" ? report(event.text) : undefined;
      return from && threads.has(from) ? { ...event, from } : event;
    }) };
    const pending = await this.chat.pending();
    const failure = this.chat.failure();
    if (!pending.length) return transcript;
    // A pending message is shown until the log has it after the point it was accepted.
    const placed = (item: PendingItem) => transcript.events.some(event => event.type === "user-message" && event.text === item.text && Number.parseInt(event.id, 10) > item.after);
    return {
      ...transcript,
      events: [...transcript.events, ...pending.filter(item => !placed(item)).map(item => {
        const from = report(item.text);
        return { type: "user-message" as const, id: `pending.${item.requestId}`, text: item.text, ...(from && threads.has(from) ? { from } : {}) };
      })],
      status: transcript.status.state === "working" ? { ...transcript.status, error: transcript.status.error ?? failure } : { state: "working", run: "pending", error: failure },
    };
  }
}
