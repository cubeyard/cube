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
import { agents } from "./claude-agent.ts";
import { createLogger } from "./log.ts";
import { compactNode } from "./optchat-compactor.ts";
import { cachedModels, viewPieces } from "./optchat-cache.ts";
import { capText, Memory, type LogMessage, type Part } from "./optchat-memory.ts";
import { MEDIA_LIMITS, MediaError, mediaData, mediaId, MediaStore, UNSENT_MS, type MediaRef } from "./optchat-media.ts";
import { applyTask, LIMITS as TASK_LIMITS, linkLabel, renderTasks, shown, STATUSES, taskLine, TasksDoc, TurnTasksDoc, type ObservedThread, type Task, type TaskList, type TaskView } from "./optchat-tasks.ts";
import type { ThreadEvent, ThreadEvents, ThreadStatus, ThreadTranscript, ThreadWatch } from "./thread-events.ts";
import { HISTORY_MAX, HISTORY_PAGE, type HistoryPage, type HistoryRequest } from "./thread-history.ts";
import { addUsage, type OptChatUsage } from "./usage-service.ts";

const context = BACKGROUND_CONTEXT;
const log = createLogger("optchat");
export const JOBS = 8;
export const RETRY_MS = 10_000;
/** How long a thread's machine must keep failing to start before the chat
 * hears of it: cubed's recovery loop retries every 30 s. */
export const START_GRACE_MS = 2 * 60_000;

/** Tells to one thread between two messages of the user: unattended
 * follow-up is bounded; the user's next message allows more. */
export const TELLS = 8;

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
A report says how the thread's turn ended, never that its task is done;
its reply says that. "ended its turn; nothing of it runs now" means it
does nothing more until told, whatever the reply promises. "waiting on
its background agent" means another report comes when that finishes.
"failed" and "stopped" mean it stopped short. When a thread stopped
before its task is done (it waits for CI, a review or a command nothing
tracks, or it was interrupted) and the next step is clear and within
what the user asked, tell it to go on and to wait for such things
itself; otherwise tell the user what it needs. Between two messages of
the user a thread takes at most ${TELLS} tells from you; once they are
spent, ask the user, and do not start another thread to go on instead.
tell(id, message) gives a thread that has reported more to do.
history(id) reads one of your threads without changing it: cubed's state
for it beside its latest answer and conversation. Use it when a report is
missing or short, or contradicts what threads shows; say what disagrees
rather than settle it. An open thread holds a machine until it is
archived: archive(ids) archives threads of yours that are done, to free
theirs; history still reads them. It never stops a working thread.
Images the user attaches reach you only in the turn they are sent; the
view and zoom keep only "[image]", and threads never see them. So say in
your reply what an image shows that will matter, and put in a thread's
task, in words, whatever it needs from one.`;

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

export const TASKS_DOC = `Now: after the view, each turn shows your task list inside <now> tags. It is
what the user sees first in cube, instead of scrolling this chat, so keep
it true with task(): add a task when the user asks for work that will take
more than this turn, link the threads you start for it, and change it when
a report or the user changes what is next, what blocks it, or whether it is
done (the user's goal is met) or dropped. Keep titles short and say the
next action plainly. A status is your intent; a thread's state beside it is
cube's record. A thread whose turn ended has not necessarily done its task,
and a merged pull request is not released or installed: say only what a
report or the user said. tasks() reads the list with each thread's state.`;

/** What a thread report says when the thread started: its final reply is the report. */
export const THREAD_NOTE = "(This thread was started by OptChat, the user's chat agent. Your final reply is your report to it. "
  + "Once you end your turn nothing wakes you except a background agent of yours finishing, so do not end it to wait for CI, a review or a command: "
  + "wait for those yourself in the foreground (a command runs at most 10 minutes; repeat a bounded wait such as `timeout 590 gh pr checks <n> --watch`), then go on. "
  + "If you stop before the task is done, say plainly what is left and what you are waiting for.)";

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
  /** The thread's events; null once it is archived or gone; "archiving"
   * while its archive (or a release left unfinished) goes on. */
  events(id: string): Promise<ThreadEvents | null | "archiving">;
  /** What cubed has of a thread, read only: its own record beside a page of
   * the agent's stored transcript, which may disagree. null: no such thread. */
  history(id: string, request?: HistoryRequest): Promise<ThreadRecord | null>;
  /** Archives a thread: its agent closes and its machine is released, as
   * the UI's archive does; its stored history stays. Refused, with nothing
   * stopped, while the thread works or its machine starts. An archived
   * thread is left as it is (`already`). null: no such thread. */
  archive?(id: string): Promise<{ already: boolean; disk: string; free: string } | null>;
  /** Usage and estimated cost as text: of everything, a project, or one
   * thread (an id or its first characters). Read-only. */
  usage?(query: { project?: string | undefined; thread?: string | undefined }): Promise<string>;
  /** Each thread's state as cubed records it now, read only; null: no such thread. */
  observe?(ids: readonly string[]): Promise<Map<string, ObservedThread | null>>;
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
  /** A page of the agent's stored transcript; null when it stored none or `unreadable`. */
  transcript: HistoryPage | null;
  unreadable: string | null;
};

export { HISTORY_MAX, HISTORY_PAGE };
/** A page's messages share this many characters; one gets at most HISTORY_TEXT. */
const HISTORY_BUDGET = 24_000;
const HISTORY_TEXT = 2000;
const HISTORY_TOOL = 400;
const HISTORY_ANSWER = 4000;

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
 * then the record's page of messages, numbered from the first. */
export function formatHistory(id: string, record: ThreadRecord, report: ReportState): string {
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
  const waiting = transcript.status.waiting ?? [];
  lines.push(`run: ${state}${run ? ` (${run})` : ""}${error ? `: ${error}` : ""}${waiting.length ? `; still running: ${agents(waiting)}` : ""}`);
  const { answer, asked } = transcript;
  lines.push(!answer ? "latest answer: none" : `latest answer #${answer.index}${asked > answer.index ? ` (before the newest message #${asked}, which has none yet)` : ""}: ${capText(answer.text.trim(), HISTORY_ANSWER)}`);
  if (state !== "idle" && state !== "working" && run) lines.push(`report of this run to this chat: ${reportText(report)}`);
  // Disagreements are shown as cubed has them; this view does not settle them.
  const notes: string[] = [];
  if (record.failure && state !== "idle") notes.push(`cubed records a failure (${record.failure}) while the stored history shows the agent ${state === "working" ? "working" : `ran (run ${state})`}; the history does not say whether the failure came before, during or after that run`);
  if (state === "working" && record.archived) notes.push("the store shows a run unfinished at archive; it does not go on");
  else if (state === "working" && !record.agentOpen) notes.push(transcript.agent === "claude-code"
    ? "the store shows a turn unfinished, but its agent is not open in cubed: Claude Code does not continue it; it shows as failed once the agent opens again"
    : "the store shows a run unfinished, but its agent is not open in cubed: it goes on only when the agent opens again");
  if (waiting.length && (record.archived || !record.agentOpen)) notes.push(`the store shows ${agents(waiting)} running, but its agent is not open in cubed: ${waiting.length === 1 ? "it ended with it and shows" : "they ended with it and show"} as lost once the agent opens again`);
  for (const note of notes) lines.push(`note: ${note}`);
  const { total, start, events } = transcript;
  const end = start + events.length;
  const cap = Math.min(HISTORY_TEXT, Math.floor(HISTORY_BUDGET / Math.max(1, events.length)));
  if (!total) lines.push("messages: none");
  else if (start === end) lines.push(`messages: none before #${end} (${total} in all)`);
  else {
    lines.push(`messages #${start}–#${end - 1} of ${total}, oldest first${start > 0 ? `; earlier: history("${short(id)}", before: ${start})` : ""}`);
    events.forEach((event, k) => lines.push(`#${start + k} ${historyLine(event, cap)}`));
  }
  return lines.join("\n");
}

/** `cache` names the chat for the providers' prompt caches; it never changes. */
/** `tells`: the tell calls to a thread since the user's last message. */
type Settings = { tree: number; cache: string; threads: Record<string, { at: number; tells?: string[] }> };
const SettingsDoc = defineDoc<Settings>({ kind: "cube.optchat", version: 1, scope: "session", initial: () => ({ tree: 0, cache: "", threads: {} }) });
/** The view parts the current turn started with; the request hook renders them. */
const TurnDoc = defineDoc<{ started: boolean; parts: number[] }>({
  kind: "cube.optchat.turn", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ started: false, parts: [] }),
});
/** A message accepted when the log had `after` as its newest entry. */
type PendingItem = { text: string; requestId: string; after: number; images?: MediaRef[] };
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
/** A tool's text result. */
const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
/** A zoom result's lines start with their ids. */
const ZOOMED = /^\d+\+\d+\|/;
export const ZOOM_ECHO = "(the zoomed lines: a copy of earlier messages of this chat, not repeated here)";
/** A message's content for Pi: its text, then its images as references to
 * the media store, which the request hook fills in for the model. */
const userContent = (item: Pick<PendingItem, "text" | "images">) => !item.images?.length ? item.text
  : [...item.text ? [{ type: "text" as const, text: item.text }] : [], ...item.images.map(image => ({ type: "image" as const, mimeType: image.mimeType, data: mediaData(image.id) }))];
const userEntry = (item: Pick<PendingItem, "text" | "images">) => ({ kind: "pi.user", model: [{ role: "user" as const, content: userContent(item), timestamp: Date.now() }] });
/** The store ids an entry's user messages refer to. */
export function entryImages(entry: EntryRecord): string[] {
  if (entry.kind !== "pi.user") return [];
  return (entry.model ?? []).flatMap(message => message.role !== "user" || typeof message.content === "string" ? []
    : message.content.flatMap(part => part.type === "image" ? [mediaId(part.data)].filter(id => id !== null) : []));
}
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
  return runReport(transcript.status, reply?.type === "assistant-text" ? reply.text : "");
}

/** A reply that says its thread waits for something. */
const WAITS = /\b((a)?wait(s|ing)? (for|on|until)|awaiting|once (the )?(ci|checks?|reviews?|builds?|tests?|pipeline)\b|(ci|checks?|reviews?|builds?|tests?|pipeline) (is|are) (still )?(running|pending|queued|in progress)|will (report|follow up|check back|get back|let you know)|still (running|pending|in progress))/i;

/** The report of a run that ended with `status`, whose reply (after the
 * newest message) is `reply`. It says how the turn ended and what of the
 * thread still runs, never that the task is done: only the reply says that. */
export function runReport(status: ThreadStatus, reply: string): string {
  const text = reply.trim();
  const said = text ? `: ${text}` : " without a reply";
  const last = text ? `; last reply: ${text}` : "";
  if (status.state === "completed") {
    const waiting = status.waiting ?? [];
    if (waiting.length) return `ended its turn, waiting on its ${agents(waiting)}; another report comes when ${waiting.length === 1 ? "it finishes" : "they finish"}${said}`;
    if (WAITS.test(text)) return `ended its turn; nothing of it runs now and nothing wakes it, though its reply speaks of waiting: it goes on only when told${said}`;
    return `ended its turn; nothing of it runs now${said}`;
  }
  if (status.state === "stopped") return `stopped${status.error ? `: ${status.error}` : ""}${last}`;
  return `failed: ${status.error ?? "unknown error"}${last}`;
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
  limits?: { view?: number; node?: number; jobs?: number; retryMs?: number; watchMs?: number; startGraceMs?: number };
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
  /** When each thread's machine was first seen failing to start, until it starts. */
  private readonly startFailing = new Map<string, number>();
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
  /** The attached images; `referenced`: the ids the log's messages hold. */
  media!: MediaStore;
  private readonly referenced = new Set<string>();
  private mediaLock: Promise<unknown> = Promise.resolve();
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
    this.media = new MediaStore(path.join(directory, "media"));
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
      for (const id of entryImages(entry)) this.referenced.add(id);
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
    await this.sweepMedia(Date.now() - UNSENT_MS);
    const sweep = setInterval(() => { void this.sweepMedia(Date.now() - UNSENT_MS); }, 60 * 60_000);
    sweep.unref();
    this.timers.add(sweep);
  }

  /** Runs `action` alone among the steps that add or delete images. */
  private withMedia<T>(action: () => Promise<T>): Promise<T> {
    const run = this.mediaLock.catch(() => {}).then(action);
    this.mediaLock = run;
    return run;
  }

  /** Every image a message holds: in the log, or waiting for a turn. */
  private async mediaInUse(): Promise<Set<string>> {
    await this.sync();
    const used = new Set(this.referenced);
    for (const item of await this.pending()) for (const image of item.images ?? []) used.add(image.id);
    return used;
  }

  /** Deletes uploads no message holds that were stored before `before`. */
  private sweepMedia(before: number): Promise<number> {
    return this.withMedia(async () => {
      if (this.closing) return 0;
      const removed = this.media.sweep(await this.mediaInUse(), before);
      if (removed) log.info("unsent images deleted", { removed });
      return removed;
    }).catch(error => { if (!this.closing) log.warn("images not swept", { error }); return 0; });
  }

  /** Whether the chat's model takes images, and if not, why. */
  imageSupport(): { supported: boolean; reason: string | null } {
    const model = this.model && this.options.models.getModel(this.model.provider, this.model.id);
    if (!model) return { supported: false, reason: "the chat's model is unavailable" };
    if (!model.input.includes("image")) return { supported: false, reason: `${model.id} does not take images` };
    return { supported: true, reason: null };
  }

  /** Stores an uploaded image for a message still to be sent. Uploads no
   * message holds are bounded: the oldest are let go first, never one
   * younger than ten minutes, which a draft may be about to send. */
  upload(bytes: Uint8Array): Promise<ReturnType<MediaStore["put"]>> {
    return this.withMedia(async () => {
      const support = this.imageSupport();
      if (!support.supported) throw new MediaError(support.reason!, 422);
      const used = await this.mediaInUse();
      const unsent = this.media.list().filter(item => !used.has(item.id));
      if (unsent.length >= MEDIA_LIMITS.unsent) {
        // Keeps every image in use and the newest unsent ones but one.
        const newest = unsent.slice(unsent.length - MEDIA_LIMITS.unsent + 1).map(item => item.id);
        this.media.sweep(new Set([...used, ...newest]), Date.now() - 10 * 60_000);
        if (this.media.list().filter(item => !used.has(item.id)).length >= MEDIA_LIMITS.unsent) {
          throw new MediaError(`${MEDIA_LIMITS.unsent} images are uploaded and not sent; send or remove some, then try again in a few minutes`, 429);
        }
      }
      return this.media.put(bytes);
    });
  }

  /** An image a message of this chat holds, for the transcript; null for any other id. */
  async image(id: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
    const held = async () => this.referenced.has(id) || (await this.pending()).some(item => item.images?.some(image => image.id === id));
    // A message Pi has just placed may not be in the log yet.
    if (!await held()) { await this.sync(); if (!this.referenced.has(id)) return null; }
    return this.media.get(id);
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
          for (const id of entryImages(entry)) this.referenced.add(id);
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
  async send(text: string, requestId: string, images: readonly string[] = []): Promise<void> {
    if (!images.length) return this.accept(text, requestId, []);
    // Checked and accepted under the media lock: no sweep deletes an image
    // between its check and the message that holds it.
    await this.withMedia(async () => {
      if (images.length > MEDIA_LIMITS.perMessage) throw new MediaError(`at most ${MEDIA_LIMITS.perMessage} images a message`);
      const refs = images.map(id => {
        const image = this.media.get(id);
        if (!image) throw new MediaError("an attached image is not on the host any more; attach it again", 404);
        return { id, mimeType: image.mimeType };
      });
      await this.accept(text, requestId, refs);
    });
  }

  private async accept(text: string, requestId: string, images: MediaRef[]): Promise<void> {
    const conversation = this.conversation;
    await this.harness.commit(async tx => {
      const pending = await tx.doc(PendingDoc);
      const same = (item: PendingItem) => item.requestId === requestId;
      if (pending.items.some(same) || pending.batch?.some(same) || pending.sent.some(same)) return;
      if (await tx.submissionByRequest(conversation.id, requestId) || await tx.submissionByRequest(conversation.id, `${requestId}:unanswered`)) return;
      if (images.length) {
        // Refused, not dropped: the model would never see them.
        const support = this.imageSupport();
        if (!support.supported) throw new MediaError(`not sent: ${support.reason}; choose a model that takes images, or send without them`, 422);
        const waiting = [...pending.sent, ...pending.batch ?? [], ...pending.items].reduce((sum, item) => sum + (item.images?.length ?? 0), 0);
        if (waiting + images.length > MEDIA_LIMITS.waiting) throw new MediaError(`not sent: ${waiting} images are already waiting for the chat; at most ${MEDIA_LIMITS.waiting} wait at once`, 429);
      }
      pending.items.push({ text, requestId, after: this.lastEntry, ...images.length ? { images } : {} });
      // A message of the user (not a report) renews every thread's tells.
      if (!requestId.startsWith("report:")) for (const thread of Object.values((await tx.doc(SettingsDoc)).threads)) delete thread.tells;
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
      await this.conversation.submit({ type: "input", content: userContent(item), requestId: item.requestId, whenBusy: "steer" }, context);
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
        const tasks = await this.renderTasks();
        await conversation.commit(async tx => {
          Object.assign(await tx.doc(TurnDoc, conversation.id), { started: true, parts });
          (await tx.doc(TurnTasksDoc, conversation.id)).text = tasks;
        }, context);
        await conversation.submit({ type: "write", entry: { kind: TURN, head: "self" }, requestId: `${batch[0]!.requestId}:turn` }, context);
      }
      for (const item of batch.slice(0, -1)) {
        if (!await this.known(item.requestId)) await conversation.submit({ type: "write", requestId: item.requestId, entry: userEntry(item) }, context);
      }
      await conversation.submit({ type: "input", content: userContent(last), requestId: last.requestId, whenBusy: "steer" }, context);
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
          await this.conversation.submit({ type: "write", requestId: `${item.requestId}:unanswered`, entry: userEntry(item) }, context);
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
      const model = this.options.models.getModel(selection.provider, selection.id);
      if (!model) throw new Error("model unavailable");
      if (!model.input.includes("image") && (await this.pending()).some(item => item.images?.length)) throw new Error(`${model.id} does not take images, and a message with images is waiting for the chat`);
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
        let events: ThreadEvents | null | "archiving";
        try { events = await this.options.threads.events(id); }
        catch (error) {
          // cubed retries a machine that failed to start (a lost guest, a
          // lease not yet let go), and most come up on a later try: only a
          // failure that lasts is reported, once per thread, as one cubed
          // still retries. The next round watches it again.
          const message = error instanceof Error ? error.message : String(error);
          const since = this.startFailing.get(id) ?? Date.now();
          this.startFailing.set(id, since);
          const lasted = Date.now() - since;
          if (lasted >= (this.options.limits?.startGraceMs ?? START_GRACE_MS) && !this.startReported.has(id) && !this.closing) {
            this.startReported.add(id);
            void this.send(`[${short(id)}] failed to start for ${Math.round(lasted / 1000)} s; cubed keeps retrying: ${message}`, `report:${id}:start`).catch(() => {});
          }
          this.watchers.delete(id);
          return null;
        }
        // Started (or gone): a later failure's grace starts again. Its report
        // keeps the request id, so a thread reports a failure to start once.
        this.startFailing.delete(id);
        // An archive may still be refused: the next round looks again.
        if (events === "archiving") { this.watchers.delete(id); return null; }
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
    this.settle(id, transcript.status, () => threadReport(transcript));
  }

  private settle(id: string, status: ThreadStatus, report: () => string): void {
    if (status.state === "idle" || status.state === "working" || !status.run || this.reported.get(id) === status.run) return;
    this.reported.set(id, status.run);
    void this.send(`[${short(id)}] ${capText(report())}`, `report:${id}:${status.run}`)
      .catch(error => { if (!this.closing) log.warn("report delivery failed", { thread: id, error }); });
  }

  /** After an archive: the thread's last settled run reports to the chat if
   * its watcher had not sent that yet (archiving ends the watch). The report's
   * request id keeps it to one delivery. */
  private async reportArchived(id: string): Promise<void> {
    try {
      const page: HistoryPage | null | undefined = (await this.options.threads.history(id, { limit: 1 }))?.transcript;
      if (page) this.settle(id, page.status, () => runReport(page.status, page.answer && page.answer.index > page.asked ? page.answer.text : ""));
    } catch (error) { log.warn("archived thread's report not checked", { thread: id, error }); }
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

  /** Each linked thread's state as cubed records it now. */
  private async observeThreads(tasks: readonly Task[]): Promise<Map<string, ObservedThread | null>> {
    const ids = [...new Set(tasks.flatMap(task => task.threads))];
    if (!ids.length || !this.options.threads.observe) return new Map();
    try { return await this.options.threads.observe(ids); }
    catch (error) { log.warn("threads not observed", { error }); return new Map(); }
  }

  private async renderTasks(): Promise<string> {
    const list = shown(await this.harness.snapshot(TasksDoc, context), Date.now());
    return renderTasks(list, await this.observeThreads([...list.open, ...list.closed]));
  }

  /** The task list as the UI shows it: open tasks, the few closed lately,
   * and each linked thread's state as cubed records it now. */
  async tasks(): Promise<TaskList> {
    const list = shown(await this.harness.snapshot(TasksDoc, context), Date.now());
    const observed = await this.observeThreads([...list.open, ...list.closed]);
    const view = (task: Task): TaskView => ({
      id: task.id, title: task.title, status: task.status, next: task.next, project: task.project, updated: task.updated, closed: task.closed,
      threads: task.threads.map(id => {
        const thread = observed.get(id);
        return { id, title: thread?.title ?? null, project: thread?.project ?? null, state: thread?.state ?? (observed.has(id) ? "gone" : "unknown") };
      }),
      links: task.links.map(url => ({ url, ...linkLabel(url) })),
    });
    return { open: list.open.map(view), closed: list.closed.map(view), limit: TASK_LIMITS.open };
  }

  private taskTools() {
    const task = defineTool({
      name: "task",
      description: "Add or change one task of your task list, the user's \"now\". Without id: a new task (title required; status active unless given). "
        + "With id: only the fields given change; threads and links replace the task's. status is your intent: done when the user's goal is met, "
        + "never because a thread's turn ended; a merged PR is not a release. Bounded: "
        + `${TASK_LIMITS.open} open tasks, ${TASK_LIMITS.threads} threads and ${TASK_LIMITS.links} https links each.`,
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "The task's id (t1, t2, …); leave out to add one" })),
        title: Type.Optional(Type.String({ description: `What the work is, at most ${TASK_LIMITS.title} characters` })),
        status: Type.Optional(Type.Union(STATUSES.map(status => Type.Literal(status)))),
        next: Type.Optional(Type.String({ description: "The next action, or what blocks a blocked task; one line" })),
        project: Type.Optional(Type.String({ description: "The project it is in, if one" })),
        threads: Type.Optional(Type.Array(Type.String(), { maxItems: TASK_LIMITS.threads, description: "Ids of your threads working on it" })),
        links: Type.Optional(Type.Array(Type.String(), { maxItems: TASK_LIMITS.links, description: "https URLs, such as a pull request" })),
      }),
      // A new task remembers the call that made it; a change sets the same fields again.
      replay: "safe",
      execute: async (args, api, callContext) => {
        try {
          const threads = args.threads && await Promise.all(args.threads.map(id => this.resolve(id)));
          const { task: changed, created } = await api.commit(async tx => {
            const result = applyTask(await tx.doc(TasksDoc), { ...args, threads }, api.callId, Date.now());
            return { task: { ...result.task, threads: [...result.task.threads], links: [...result.task.links] }, created: result.created };
          }, callContext);
          return text(`${created ? "added" : "changed"}: ${taskLine(changed, await this.observeThreads([changed]))}`);
        } catch (error) {
          return text(`not changed: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });
    const tasks = defineTool({
      name: "tasks",
      description: "Your task list: open tasks and those closed lately, with each linked thread's state as cube records it now.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => text(await this.renderTasks()),
    });
    return [task, tasks];
  }

  private extension() {
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
      description: `Send a message to a thread you started, once it has reported: more work, an answer, a correction, or to go on when it stopped short. At most ${TELLS} per thread between two messages of the user.`,
      parameters: Type.Object({ id: Type.String(), message: Type.String() }),
      replay: "safe",
      execute: async (args, api, callContext) => {
        const id = await this.resolve(args.id);
        // Only a tell the thread accepted counts, once per call: a replayed
        // call is not refused (the thread takes its request id once).
        // Checked before and counted after the tell: sound because the
        // chat's tools run one at a time (toolExecution "sequential").
        const tells = (await this.harness.snapshot(SettingsDoc, context))?.threads[id]?.tells ?? [];
        if (!tells.includes(api.callId) && tells.length >= TELLS) return text(`not sent: [${short(id)}] had ${TELLS} tells from you since the user's last message; tell the user what it needs instead`);
        await this.options.threads.tell(id, args.message, `optchat:${api.callId}`);
        await api.commit(async tx => {
          const thread = (await tx.doc(SettingsDoc)).threads[id];
          if (thread && !thread.tells?.includes(api.callId)) thread.tells = [...thread.tells ?? [], api.callId];
        }, callContext);
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
        const record = await this.options.threads.history(id, { before: args.before, limit: args.limit });
        if (!record) return text(`[${short(id)}] is gone: cubed has no record of it`);
        // A run's report, or without a transcript the failure to start.
        const run = record.transcript ? record.transcript.status.run : "start";
        const requestId = `report:${id}:${run}`;
        const report = !run ? "none" : await this.known(requestId) ? "delivered"
          : (await this.pending()).some(item => item.requestId === requestId) ? "accepted" : "none";
        return text(formatHistory(id, record, report));
      },
    });
    const archive = defineTool({
      name: "archive",
      description: "Archive threads you started that are done, to free their machines. Each one's agent closes and its machine is released, as the user's archive in cube does; "
        + "its conversation stays and history still reads it. A thread that is working or whose machine is still starting is not archived and nothing is stopped: "
        + "wait for its report. It cannot be undone from here. Name each thread by its whole 8-character id.",
      parameters: Type.Object({ ids: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }) }),
      // Archiving again finds the thread archived and says so.
      replay: "safe",
      execute: async args => {
        const archiveThread = this.options.threads.archive;
        if (!archiveThread) return text("archiving is not available");
        const lines: string[] = [];
        let free: string | undefined;
        for (const given of args.ids) {
          let name = given;
          try {
            // A destructive call takes no shorter prefix than the ids it is shown.
            if (given.replace(/^\[|\]$/g, "").length < 8) throw new Error("name a thread by its whole 8-character id");
            const id = await this.resolve(given);
            name = `[${short(id)}]`;
            const result = await archiveThread(id);
            if (!result) { lines.push(`${name} is gone: cubed has no record of it`); continue; }
            free = result.free;
            lines.push(`${name} ${result.already ? "was already archived" : "archived"}: ${result.disk}; history still reads it`);
            await this.reportArchived(id);
          } catch (error) {
            lines.push(`${name} not archived: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (free) lines.push(`free thread machines: ${free}`);
        return text(lines.join("\n"));
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
      tools: [zoom, date, projects, runners, spawn, tell, threads, history, archive, usage, ...this.taskTools()],
      sections: [
        section("master", () => MASTER, { tag: false }),
        section("view", () => VIEW_DOC, { tag: false }),
        section("tasks", () => TASKS_DOC, { tag: false }),
        // The user's own instructions; constant unless they edit the file.
        section("user", () => {
          try { return fs.readFileSync(instructions, "utf8").trim() || undefined; }
          catch { return undefined; }
        }, { tag: false }),
      ],
      hooks: [hook(GenerationTask, { beforeRequest: async (request, api, callContext) => {
        // The turn's images, read from the store for this request only.
        const support = this.imageSupport();
        const messages = withImages(request.messages, { load: id => this.media.get(id), refused: support.reason, limit: MEDIA_LIMITS.perTurn, bytes: MEDIA_LIMITS.turnBytes });
        const turn = await api.snapshot(TurnDoc, api.conversationId, callContext);
        if (!turn?.started) return { messages };
        const parts: Part[] = [];
        for (let k = 0; k + 1 < turn.parts.length; k += 2) parts.push({ l: turn.parts[k]!, i: turn.parts[k + 1]! });
        // The task list follows the view, after its cache marks.
        const tasks = (await api.snapshot(TurnTasksDoc, api.conversationId, callContext))?.text;
        return { messages: withView(messages, [...viewPieces(this.memory.render(parts)), ...(tasks ? [tasks] : [])]) };
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

/** The turn's messages with each image reference replaced by the image
 * itself, newest first up to `limit`; an image that cannot go (the model
 * takes none, past the limit, missing from the store) becomes a note the
 * model reads, never a silent gap. */
export function withImages(messages: readonly Message[], options: { load: (id: string) => { bytes: Buffer; mimeType: string } | null; refused: string | null; limit: number; bytes?: number }): Message[] {
  let sent = 0, size = 0;
  const out = [...messages];
  for (let k = out.length - 1; k >= 0; k--) {
    const message = out[k]!;
    if (message.role !== "user" || typeof message.content === "string" || !message.content.some(part => part.type === "image" && mediaId(part.data))) continue;
    const parts = [...message.content];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]!;
      const id = part.type === "image" ? mediaId(part.data) : null;
      if (!id) continue;
      const image = options.refused || sent >= options.limit ? null : options.load(id);
      const full = !!image && size + image.bytes.byteLength > (options.bytes ?? Infinity);
      if (image && !full) { parts[j] = { type: "image", mimeType: image.mimeType, data: image.bytes.toString("base64") }; sent++; size += image.bytes.byteLength; continue; }
      parts[j] = { type: "text", text: options.refused ? `(an image the user attached, not sent: ${options.refused})`
        : sent >= options.limit || full ? `(an earlier image of this turn, not sent again: a turn's requests carry at most ${options.limit} images and ${Math.round((options.bytes ?? 0) / 1_000_000)} MB of them)`
        : "(an image the user attached, missing from cube's store)" };
    }
    out[k] = { ...message, content: parts };
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
    const ids = (images: readonly { id: string }[] | undefined) => (images ?? []).map(image => image.id).join(",");
    const placed = (item: PendingItem) => transcript.events.some(event => event.type === "user-message" && event.text === item.text
      && ids(event.images) === ids(item.images) && Number.parseInt(event.id, 10) > item.after);
    return {
      ...transcript,
      events: [...transcript.events, ...pending.filter(item => !placed(item)).map(item => {
        const from = report(item.text);
        return { type: "user-message" as const, id: `pending.${item.requestId}`, text: item.text, ...(from && threads.has(from) ? { from } : {}),
          ...item.images?.length ? { images: item.images.map(image => ({ ...image })) } : {} };
      })],
      status: transcript.status.state === "working" ? { ...transcript.status, error: transcript.status.error ?? failure } : { state: "working", run: "pending", error: failure },
    };
  }
}
