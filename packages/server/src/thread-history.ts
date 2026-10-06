/** A page of a thread's stored conversation, read without its agent, for
 * OptChat's history tool. Messages are numbered from the first, so a page
 * needs to know how many messages each stored row shows: an index of that
 * is kept per store and extended by the rows written since it was last read
 * (stored rows are only ever appended). A page then parses and renders only
 * its own rows and the newest answer's, never the whole history again.
 *
 * Stores are read through a read-only connection inside one read
 * transaction: a consistent snapshot of the store that never writes it,
 * migrates it, checkpoints it or waits for its writer, and needs no copy. */
import fs from "node:fs";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { EntryRecord, SubmissionRecord } from "@earendil-works/pi-durable";
import { messageEvents, status as claudeStatus, submissionEvent, virtualize } from "./claude-thread-events.ts";
import type { ClaudeSubmission } from "./claude-agent.ts";
import { entryEvents, settlement } from "./pi-thread-events.ts";
import type { ThreadAgent, ThreadEvent, ThreadStatus, ThreadTranscript } from "./thread-events.ts";

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
  /** Row keys, in transcript order, and the running count through each. */
  readonly keys: number[] = [];
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

/** The page from an index; `shownOf` renders one row's shown events. */
function assemble(index: Index, base: Pick<HistoryPage, "agent" | "owner" | "status">, request: HistoryRequest, shownOf: (key: number) => ThreadEvent[]): HistoryPage {
  const { start, end } = pageRange(index.total, request);
  const events: ThreadEvent[] = [];
  for (let row = start < end ? index.row(start) : index.keys.length; row < index.keys.length && index.begin(row) < end; row++) {
    const shown = shownOf(index.keys[row]!);
    const begin = index.begin(row);
    if (shown.length !== index.ends[row]! - begin) throw new Error("the stored history changed under its index");
    events.push(...shown.slice(Math.max(0, start - begin), end - begin));
  }
  let answer: HistoryPage["answer"] = null;
  if (index.answer) {
    const { index: number, row } = index.answer;
    const event = shownOf(index.keys[row]!)[number - index.begin(row)];
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
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
  try {
    const stat = fs.statSync(file);
    db.exec("BEGIN");
    try { return await read(db, `${stat.dev}:${stat.ino}`); }
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

/** The pi-durable SQLite schema this reader knows; another is refused. */
export const PI_SCHEMA_VERSION = 1;
const ROOT = 1;
type PiIndex = Index & { last: number };

/** A page of a Pi thread's root conversation from its store, as
 * storedPiTranscript renders it whole. null: no store. */
export async function readPiHistory(file: string, owner: ThreadAgent | null, failure: string | null, request: HistoryRequest): Promise<HistoryPage | null> {
  return locked(file, () => snapshot(file, async (db, identity) => {
    const row = db.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get() as { version: number } | undefined;
    if (row?.version !== PI_SCHEMA_VERSION) throw new Error(`the stored history has schema version ${row?.version ?? "none"}, not ${PI_SCHEMA_VERSION}`);
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
    let last: SubmissionRecord | undefined;
    for (const { record } of db.prepare("SELECT record FROM submissions WHERE conversation_id = ? ORDER BY id DESC").iterate(ROOT) as Iterable<{ record: string }>) {
      const submission = JSON.parse(record) as SubmissionRecord;
      if (submission.type === "input") { last = submission; break; }
    }
    const status: ThreadStatus = !last ? { state: "idle", run: null, error: null }
      : last.status === "queued" || last.status === "placed" ? { state: "working", run: last.requestId ?? String(last.id), error: failure }
      : { run: last.requestId ?? String(last.id), ...settlement(last) };
    const entry = db.prepare("SELECT record FROM entries WHERE id = ?");
    return assemble(growing, { agent: "pi", owner, status }, request,
      id => entryEvents([parse((entry.get(id) as { record: string }).record)]).filter(historyShows));
  }));
}

// --- Claude Code -------------------------------------------------------------

/** Rows are a submission (key -seq), then its messages (key seq), as render orders them. */
type ClaudeIndex = Index & { submission: number; message: number; names: Map<string, string> };
const claudeIndex = (): ClaudeIndex => Object.assign(new Index(), { submission: 0, message: 0, names: new Map<string, string>() });

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
    if (message.submission === index.submission) index.add(message.seq, messageEvents(message.seq, JSON.parse(message.data) as Record<string, unknown>, index.names));
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
    const names = index.names;
    const message = db.prepare("SELECT data FROM message WHERE seq = ?");
    const submission = db.prepare("SELECT seq, text FROM submission WHERE seq = ?");
    return assemble(index, { agent: "claude-code", owner, status: claudeStatus(newest, failure) }, request, key => (key < 0
      ? [submissionEvent(submission.get(-key) as { seq: number; text: string })]
      : messageEvents(key, JSON.parse((message.get(key) as { data: string }).data) as Record<string, unknown>, names, shown)).filter(historyShows));
  }));
}
