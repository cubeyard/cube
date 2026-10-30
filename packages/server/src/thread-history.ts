/** A page of a thread's stored conversation, read without its agent, for
 * OptChat's history tool and a thread's thread_history, and its text. Messages are numbered from the first, so a page
 * needs to know how many messages each stored row shows: an index of that
 * is kept per store and extended by the rows written since it was last read
 * (stored rows are only ever appended), with Claude Code's tool names by
 * call. A page then parses and renders only its own rows and the newest
 * answer's, never the whole history again.
 *
 * Stores are read through a read-only connection inside one read
 * transaction: a consistent snapshot of the store that never writes it,
 * migrates it or checkpoints it, and needs no copy. In WAL a reader never
 * waits for a write transaction; it may wait briefly for a checkpoint or a
 * recovery. */
import fs from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { EntryRecord, SubmissionRecord } from "@earendil-works/pi-durable";
import { messageEvents, status as claudeStatus, submissionEvent, virtualize } from "./claude-thread-events.ts";
import { agents, storedBackground, type ClaudeSubmission } from "./claude-agent.ts";
import { capText } from "./optchat-memory.ts";
import { entryEvents, runStatus, withDropped } from "./pi-thread-events.ts";
import { DROPPED_ENTRY } from "./pi-sends.ts";
import type { ThreadAgent, ThreadEvent, ThreadStatus, ThreadTranscript } from "./thread-events.ts";
import { imageNote } from "./thread-images.ts";
import { threadNameText, type ThreadName } from "./thread-names.ts";

export const HISTORY_PAGE = 12;
export const HISTORY_MAX = 40;

/** Whether history shows an event: thinking and unfinished output are left out. */
export const historyShows = (event: ThreadEvent) => event.type === "user-message" || (event.final && !(event.type === "assistant-text" && event.reasoning));

export type HistoryRequest = { before?: number | undefined; limit?: number | undefined };

/** One page of the messages history shows, numbered from the first. */
export type HistoryPage = {
  agent: ThreadAgent;
  owner: ThreadAgent | null;
  status: ThreadStatus;
  /** How many messages history shows in all. */
  total: number;
  /** The newest assistant text and its number. */
  answer: { index: number; text: string } | null;
  /** The number of the newest user message; -1 without one. */
  asked: number;
  /** Messages #start… of the page, ending before the request's `before`. */
  start: number;
  events: ThreadEvent[];
};

/** The page a request names: `limit` messages (clamped) ending before `before`. */
export function pageRange(total: number, request: HistoryRequest): { start: number; end: number } {
  const limit = Math.min(Math.max(request.limit ?? HISTORY_PAGE, 1), HISTORY_MAX);
  const end = Math.min(Math.max(request.before ?? total, 0), total);
  return { start: Math.max(0, end - limit), end };
}

/** The same page from a whole transcript in memory. */
export function pageOf(transcript: ThreadTranscript, request: HistoryRequest = {}): HistoryPage {
  const shown = transcript.events.filter(historyShows);
  const answer = shown.findLastIndex(event => event.type === "assistant-text");
  const { start, end } = pageRange(shown.length, request);
  return {
    agent: transcript.agent, owner: transcript.owner, status: transcript.status, total: shown.length,
    answer: answer < 0 ? null : { index: answer, text: (shown[answer] as { text: string }).text },
    asked: shown.findLastIndex(event => event.type === "user-message"), start, events: shown.slice(start, end),
  };
}

/** Rows indexed since cubed started; tests read it to see what a read parsed. */
export const historyIndexed = { rows: 0 };

/** How many messages each stored row shows, for the rows that show any. */
class Index {
  /** Row keys, in transcript order, each row's place among all rows read,
   * and the running count through each. */
  readonly keys: number[] = [];
  readonly at: number[] = [];
  readonly ends: number[] = [];
  /** Rows read, including those that show nothing. */
  rows = 0;
  answer: { index: number; row: number } | null = null;
  asked = -1;
  get total() { return this.ends.at(-1) ?? 0; }
  add(key: number, events: ThreadEvent[]): void {
    this.rows++;
    historyIndexed.rows++;
    const shown = events.filter(historyShows);
    if (!shown.length) return;
    const total = this.total;
    const answer = shown.findLastIndex(event => event.type === "assistant-text");
    if (answer >= 0) this.answer = { index: total + answer, row: this.keys.length };
    const asked = shown.findLastIndex(event => event.type === "user-message");
    if (asked >= 0) this.asked = total + asked;
    this.keys.push(key);
    this.at.push(this.rows - 1);
    this.ends.push(total + shown.length);
  }
  /** The position of the row that shows message `index`. */
  row(index: number): number {
    let low = 0, high = this.ends.length - 1;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (this.ends[middle]! > index) high = middle; else low = middle + 1;
    }
    return low;
  }
  begin(row: number): number { return row ? this.ends[row - 1]! : 0; }
}

/** The page from an index; `shownOf` renders the shown events of the row at a position. */
function assemble(index: Index, base: Pick<HistoryPage, "agent" | "owner" | "status">, request: HistoryRequest, shownOf: (row: number) => ThreadEvent[]): HistoryPage {
  const { start, end } = pageRange(index.total, request);
  const events: ThreadEvent[] = [];
  for (let row = start < end ? index.row(start) : index.keys.length; row < index.keys.length && index.begin(row) < end; row++) {
    const shown = shownOf(row);
    const begin = index.begin(row);
    if (shown.length !== index.ends[row]! - begin) throw new Error("the stored history changed under its index");
    events.push(...shown.slice(Math.max(0, start - begin), end - begin));
  }
  let answer: HistoryPage["answer"] = null;
  if (index.answer) {
    const { index: number, row } = index.answer;
    const event = shownOf(row)[number - index.begin(row)];
    if (event?.type !== "assistant-text") throw new Error("the stored history changed under its index");
    answer = { index: number, text: event.text };
  }
  return { ...base, total: index.total, answer, asked: index.asked, start, events };
}

/** Lets other work run while a long history is indexed. */
const pause = () => new Promise<void>(resolve => setImmediate(resolve));
const SLICE_MS = 20;

type Cached<T> = { identity: string; state: T };
/** Indexes of the stores read lately, by file; reads of one store queue. */
const CACHED = 32;
const indexes = new Map<string, Cached<unknown>>();
const locks = new Map<string, Promise<unknown>>();

/** Runs `read` after the store's earlier reads; a read that fails drops the
 * store's index, so the next one builds it again. */
async function locked<T>(file: string, read: () => Promise<T>): Promise<T> {
  const previous = locks.get(file) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(read).catch((error: unknown) => { indexes.delete(file); throw error; });
  const tail = run.catch(() => {});
  locks.set(file, tail);
  try { return await run; }
  finally { if (locks.get(file) === tail) locks.delete(file); }
}

function cached<T>(file: string, identity: string): T | undefined {
  const entry = indexes.get(file);
  if (!entry) return undefined;
  indexes.delete(file);
  if (entry.identity !== identity) return undefined;
  indexes.set(file, entry);
  return entry.state as T;
}

function keep(file: string, identity: string, state: unknown): void {
  indexes.delete(file);
  indexes.set(file, { identity, state });
  while (indexes.size > CACHED) indexes.delete(indexes.keys().next().value!);
}

/** Opens `file` read-only and runs `read` inside one read transaction. */
async function snapshot<T>(file: string, read: (db: DatabaseSync, identity: string) => Promise<T>): Promise<T | null> {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  try {
    // The file opened is the one whose identity the index is kept under.
    // An inode can be reused by a new file; its birth time tells them apart.
    const identity = (of: fs.Stats) => `${of.dev}:${of.ino}:${of.birthtimeMs}`;
    if (identity(fs.statSync(file)) !== identity(stat)) throw new Error("the stored history was replaced while it was read");
    db.exec("BEGIN");
    try { return await read(db, identity(stat)); }
    finally { db.exec("ROLLBACK"); }
  } finally { db.close(); }
}

/** Runs `each` over a statement's rows, pausing now and then. */
async function scan<R>(statement: StatementSync, params: Array<number | string>, each: (row: R) => void): Promise<void> {
  let since = performance.now();
  for (const row of statement.iterate(...params)) {
    each(row as R);
    if (performance.now() - since > SLICE_MS) { await pause(); since = performance.now(); }
  }
}

// --- Pi ----------------------------------------------------------------------

/** The pi-durable SQLite schemas this reader knows; another is refused.
 * pi-durable 1.4.0 migrates a store it opens from 1 to 2, which rebuilds
 * only its task table; the entries read here are the same in both. A store
 * no Harness opened since (an archived thread's) stays at 1. */
export const PI_SCHEMA_VERSIONS: readonly number[] = [1, 2];
const ROOT = 1;
type PiIndex = Index & { last: number };

/** A page of a Pi thread's root conversation from its store, as
 * storedPiTranscript renders it whole. null: no store. */
export async function readPiHistory(file: string, owner: ThreadAgent | null, failure: string | null, request: HistoryRequest): Promise<HistoryPage | null> {
  return locked(file, () => snapshot(file, async (db, identity) => {
    const row = db.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get() as { version: number } | undefined;
    if (row === undefined || !PI_SCHEMA_VERSIONS.includes(row.version)) throw new Error(`the stored history has schema version ${row?.version ?? "none"}, not ${PI_SCHEMA_VERSIONS.join(" or ")}`);
    const parse = (record: string) => JSON.parse(record) as EntryRecord;
    // An entry committed late under a smaller id than the index has read
    // changes the order: the index is built again.
    let index = cached<PiIndex>(file, identity);
    if (index) {
      const { rows } = db.prepare("SELECT count(*) AS rows FROM entries WHERE conversation_id = ? AND id <= ?").get(ROOT, index.last) as { rows: number };
      if (rows !== index.rows) index = undefined;
    }
    if (!index) index = Object.assign(new Index(), { last: 0 });
    const growing = index;
    await scan<{ id: number; record: string }>(db.prepare("SELECT id, record FROM entries WHERE conversation_id = ? AND id > ? ORDER BY id"), [ROOT, growing.last], entry => {
      growing.add(entry.id, entryEvents([parse(entry.record)]));
      growing.last = entry.id;
    });
    keep(file, identity, growing);
    // The newest inputs up to the newest one Pi placed or holds (runStatus).
    const inputs: SubmissionRecord[] = [];
    for (const { record } of db.prepare("SELECT record FROM submissions WHERE conversation_id = ? ORDER BY id DESC").iterate(ROOT) as Iterable<{ record: string }>) {
      const submission = JSON.parse(record) as SubmissionRecord;
      if (submission.type !== "input") continue;
      inputs.push(submission);
      if (submission.status !== "unanswered" || submission.entry !== undefined) break;
    }
    const status: ThreadStatus = withDropped(runStatus(inputs, failure),
        (db.prepare("SELECT id, json_extract(record, '$.kind') AS kind FROM entries WHERE conversation_id = ? AND json_extract(record, '$.kind') IN ('pi.user', ?) ORDER BY id DESC LIMIT 2").all(ROOT, DROPPED_ENTRY) as Array<{ id: number; kind: string }>));
    const entry = db.prepare("SELECT record FROM entries WHERE id = ?");
    return assemble(growing, { agent: "pi", owner, status }, request,
      row => entryEvents([parse((entry.get(growing.keys[row]!) as { record: string }).record)]).filter(historyShows));
  }));
}

// --- Claude Code -------------------------------------------------------------

/** Rows are a submission (key -seq), then its messages (key seq), as render
 * orders them. `names` holds each tool use id's names by the row that named
 * it: a result shows the name of the newest call before it, as in render. */
type ClaudeIndex = Index & { submission: number; message: number; names: Map<string, Array<{ at: number; name: string }>> };
const claudeIndex = (): ClaudeIndex => Object.assign(new Index(), { submission: 0, message: 0, names: new Map<string, Array<{ at: number; name: string }>>() });

/** The tool names the calls before row `at` gave; while indexing, the row being read adds its own. */
function namesBefore(index: ClaudeIndex, at: number, indexing = false): Pick<Map<string, string>, "get" | "set"> {
  const names = {
    get: (id: string) => index.names.get(id)?.findLast(entry => entry.at < at)?.name,
    set: (id: string, name: string) => {
      if (indexing) index.names.set(id, [...index.names.get(id) ?? [], { at, name }]);
      return names as unknown as Map<string, string>;
    },
  };
  return names;
}

/** Extends `index` by the submissions and messages after it, in render's
 * order; false when a message joins a submission before the newest one
 * read, which `sorted` reads in that order. */
async function extend(db: DatabaseSync, index: ClaudeIndex, sorted = false): Promise<boolean> {
  const submissions = db.prepare("SELECT seq, text FROM submission WHERE seq > ? ORDER BY seq").all(index.submission) as Array<{ seq: number; text: string }>;
  let next = 0;
  const submit = (upTo: number) => {
    for (; next < submissions.length && submissions[next]!.seq <= upTo; next++) {
      index.add(-submissions[next]!.seq, [submissionEvent(submissions[next]!)]);
      index.submission = submissions[next]!.seq;
    }
  };
  let ordered = true;
  await scan<{ seq: number; submission: number; data: string }>(db.prepare(`SELECT seq, submission, data FROM message WHERE seq > ? ORDER BY ${sorted ? "submission, seq" : "seq"}`), [index.message], message => {
    if (!ordered) return;
    if (message.submission < index.submission) { ordered = false; return; }
    submit(message.submission);
    // A message of no stored submission is not shown, as in render.
    if (message.submission === index.submission) index.add(message.seq, messageEvents(message.seq, JSON.parse(message.data) as Record<string, unknown>, namesBefore(index, index.rows, true)));
    index.message = Math.max(index.message, message.seq);
  });
  if (ordered) submit(Infinity);
  return ordered;
}

/** A page of a Claude Code thread from its store, as render shows it whole
 * (with `root` shown as /workspace). null: no store. */
export async function readClaudeHistory(file: string, root: string, owner: ThreadAgent | null, failure: string | null, request: HistoryRequest): Promise<HistoryPage | null> {
  return locked(file, () => snapshot(file, async (db, identity) => {
    const newest = db.prepare("SELECT seq, request_id AS requestId, text, state, error FROM submission ORDER BY seq DESC LIMIT 1").get() as ClaudeSubmission | undefined;
    let index = cached<ClaudeIndex>(file, identity);
    if (index && (newest?.seq ?? 0) < index.submission) index = undefined;
    if (!index || !await extend(db, index)) {
      index = claudeIndex();
      if (!await extend(db, index)) {
        index = claudeIndex();
        if (!await extend(db, index, true)) throw new Error("the stored history could not be ordered");
      }
    }
    keep(file, identity, index);
    const shown = virtualize(root);
    const message = db.prepare("SELECT data FROM message WHERE seq = ?");
    const submission = db.prepare("SELECT seq, text FROM submission WHERE seq = ?");
    const read = index;
    return assemble(read, { agent: "claude-code", owner, status: claudeStatus(newest, failure, storedBackground(db).map(row => row.description)) }, request, row => {
      const key = read.keys[row]!;
      return (key < 0 ? [submissionEvent(submission.get(-key) as { seq: number; text: string })]
        : messageEvents(key, JSON.parse((message.get(key) as { data: string }).data) as Record<string, unknown>, namesBefore(read, read.at[row]!), shown)).filter(historyShows);
    });
  }));
}

/** What cubed has of a thread, read only: its own record beside a page of
 * the agent's stored transcript, which may disagree. */
export type ThreadRecord = {
  project: string;
  title: string | null;
  /** Its name ("🦦 calm otter"); absent or null on threads older than names. */
  name?: ThreadName | null;
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


const short = (id: string) => id.slice(0, 8);
/** A page's messages share this many characters; one gets at most HISTORY_TEXT. */
const HISTORY_BUDGET = 24_000;
const HISTORY_TEXT = 2000;
const HISTORY_TOOL = 400;
const HISTORY_ANSWER = 4000;

function historyLine(event: ThreadEvent, cap: number, clean: (text: string) => string): string {
  if (event.type === "user-message") return `user: ${capText(clean(event.text), cap)}`;
  if (event.type === "assistant-text") return `thread: ${capText(clean(event.text), cap)}`;
  const tool = Math.min(cap, HISTORY_TOOL);
  if (event.type === "tool-call") return `tool ${event.name} ${capText(clean(JSON.stringify(event.input ?? {})), tool)}`;
  // The images a result shows are named, never sent: the chat sees that there were some.
  const images = imageNote(event.images?.length ?? 0);
  return `result ${event.name}${event.isError ? " (error)" : ""}: ${[images, capText(clean(event.output), tool)].filter(Boolean).join(" ")}`;
}

export type ReportState = "delivered" | "accepted" | "none";
const reportText = (report: ReportState) => report === "delivered" ? "delivered" : report === "accepted" ? "accepted, not in the chat yet" : "not sent yet";

/** The record with `clean` applied to every string it shows (the page's
 * messages are cleaned where they are shown, before they are shortened). */
function cleanRecord(record: ThreadRecord, clean: (text: string) => string): ThreadRecord {
  const page = record.transcript;
  const status = page?.status;
  return { ...record, project: clean(record.project), title: record.title === null ? null : clean(record.title), machine: record.machine === null ? null : clean(record.machine),
    facts: record.facts.map(clean), failure: record.failure === null ? null : clean(record.failure), unreadable: record.unreadable === null ? null : clean(record.unreadable),
    transcript: page && status ? { ...page, status: { ...status, error: status.error === null ? null : clean(status.error),
      ...status.waiting ? { waiting: status.waiting.map(clean) } : {} } } : page };
}

/** A history tool's answer: cubed's record of the thread, the run and the
 * latest answer from its stored transcript, whether this chat got the run's
 * report (or, without a transcript, the failure to start; OptChat's
 * `history` only, null leaves it out), what disagrees, then the record's
 * page of messages, numbered from the first. `tool` is the tool as its
 * caller names it, for the "earlier:" line; `clean` (thread_history's
 * redaction) runs on each text before it is shortened, so a cut never
 * leaves a secret without the prefix or name that marks it. */
export function formatHistory(id: string, given: ThreadRecord, report: ReportState | null, options: { tool?: string; clean?: (text: string) => string } = {}): string {
  const { tool = "history", clean = (text: string) => text } = options;
  const record = cleanRecord(given, clean);
  const lines = [`[${short(id)}] ${record.project} · ${record.name ? `${threadNameText(record.name)} · ` : ""}${record.title ?? "untitled"}`,
    `cubed: ${[record.archived ? "archived" : `machine ${record.machine}`, ...record.facts].join("; ")}`];
  const transcript = record.transcript;
  if (!transcript) {
    lines.push(record.unreadable ? `history: unreadable: ${record.unreadable}`
      : `history: none stored; the agent never opened${record.machine === "starting its machine" ? " (its machine is still starting)" : ""}`);
    if (record.failure && report) lines.push(`failure to start, reported to this chat: ${reportText(report)}`);
    return lines.join("\n");
  }
  const { state, run, error } = transcript.status;
  const waiting = transcript.status.waiting ?? [];
  lines.push(`run: ${state}${run ? ` (${run})` : ""}${error ? `: ${error}` : ""}${waiting.length ? `; still running: ${agents(waiting)}` : ""}`);
  const { answer, asked } = transcript;
  lines.push(!answer ? "latest answer: none" : `latest answer #${answer.index}${asked > answer.index ? ` (before the newest message #${asked}, which has none yet)` : ""}: ${capText(clean(answer.text.trim()), HISTORY_ANSWER)}`);
  if (report && state !== "idle" && state !== "working" && run) lines.push(`report of this run to this chat: ${reportText(report)}`);
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
    lines.push(`messages #${start}–#${end - 1} of ${total}, oldest first${start > 0 ? `; earlier: ${tool}("${short(id)}", before: ${start})` : ""}`);
    events.forEach((event, k) => lines.push(`#${start + k} ${historyLine(event, cap, clean)}`));
  }
  return lines.join("\n");
}
