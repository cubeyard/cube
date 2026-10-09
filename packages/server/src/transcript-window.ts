/** Windows of a thread's transcript for the browser: the newest part of a
 * long thread first, older parts a page at a time as the reader scrolls up.
 *
 * A position is an event's index in the thread's whole event list. Committed
 * events (logged user messages, final agent events) keep their index and id;
 * only events still streaming and messages waiting for the log sit at the
 * end and change. A window therefore starts at a committed event (a user
 * message where there is one, so a turn is not cut) and a reader pins that
 * start: every later frame of its stream holds the same events from there
 * on, plus whatever came since, so counting messages in it never goes down.
 *
 * Browser-safe: no Node imports. */
import { PENDING_ID, type ThreadEvent, type ThreadTranscript, type TranscriptPage } from "./thread-events.ts";

/** Events in a reader's first window, and in a page of older ones. */
export const WINDOW_EVENTS = 120;
export const MAX_WINDOW_EVENTS = 2000;

/** `tail`: the newest events, from a start the window chooses; `from`: every
 * event from that index on (a pinned start); null: the whole transcript. */
export type WindowQuery = { tail: number } | { from: number } | null;
export interface PageQuery { before: number; limit: number }

/** A request the transcript cannot answer: a malformed query (400), or a
 * pinned start the transcript no longer has (409, `reset`: start again
 * from the newest events). */
export class TranscriptWindowError extends Error {
  readonly status: 400 | 409;
  constructor(status: 400 | 409, message: string) { super(message); this.name = "TranscriptWindowError"; this.status = status; }
  get body(): { error: string; reset?: true } { return this.status === 409 ? { error: this.message, reset: true } : { error: this.message }; }
}

/** Whether an event keeps its index and id from now on. */
export function committed(event: ThreadEvent): boolean {
  return event.type === "user-message" ? !event.id.startsWith(PENDING_ID) : event.final;
}
const turn = (event: ThreadEvent) => event.type === "user-message" && committed(event);

/** Where a window of about the newest `size` events starts: the first
 * logged user message among them, else their first committed event, else
 * (all of them still stream) the newest committed event before them. */
export function tailStart(events: readonly ThreadEvent[], size: number): number {
  const floor = events.length - size;
  if (floor <= 0) return 0;
  let first = -1;
  for (let index = floor; index < events.length; index++) {
    if (turn(events[index]!)) return index;
    if (first < 0 && committed(events[index]!)) first = index;
  }
  if (first >= 0) return first;
  for (let index = floor - 1; index > 0; index--) if (committed(events[index]!)) return index;
  return 0;
}

/** The transcript as the query asks for it; `start` is set on a window. */
export function windowOf(transcript: ThreadTranscript, query: WindowQuery): ThreadTranscript {
  if (!query) return transcript;
  const { events } = transcript;
  const start = "tail" in query ? tailStart(events, query.tail) : query.from;
  if (start > events.length) throw new TranscriptWindowError(409, "the transcript no longer has that start; read it again from the newest events");
  return { ...transcript, start, events: events.slice(start) };
}

/** A stream's windows: the first frame chooses the start (`tail`) and
 * every later frame keeps it, so a window only grows. */
export function streamWindow(query: WindowQuery): (transcript: ThreadTranscript) => ThreadTranscript {
  let current = query;
  return transcript => {
    const shown = windowOf(transcript, current);
    if (current && "tail" in current) current = { from: shown.start! };
    return shown;
  };
}

/** About `limit` events before `before`, starting at a logged user message
 * when one is near (at most twice the limit back). */
export function olderPage(transcript: Pick<ThreadTranscript, "events">, query: PageQuery): TranscriptPage {
  const { events } = transcript;
  if (query.before > events.length) throw new TranscriptWindowError(409, "the transcript no longer has that start; read it again from the newest events");
  const floor = Math.max(0, query.before - query.limit);
  let start = floor;
  for (let index = Math.min(floor, query.before - 1); index >= Math.max(0, query.before - 2 * query.limit); index--) {
    if (turn(events[index]!)) { start = index; break; }
  }
  return { start, events: events.slice(start, query.before) };
}

const count = (value: string | null, name: string, min: number, max: number): number | undefined => {
  if (value === null) return undefined;
  const number = /^\d{1,9}$/.test(value) ? Number(value) : NaN;
  if (!(number >= min && number <= max)) throw new TranscriptWindowError(400, `${name} must be an integer from ${min} to ${max}`);
  return number;
};

/** `?tail=N` or `?from=I`; neither is the whole transcript. */
export function windowQuery(query: URLSearchParams): WindowQuery {
  const tail = count(query.get("tail"), "tail", 1, MAX_WINDOW_EVENTS);
  const from = count(query.get("from"), "from", 0, Number.MAX_SAFE_INTEGER);
  if (tail !== undefined && from !== undefined) throw new TranscriptWindowError(400, "give tail or from, not both");
  return tail !== undefined ? { tail } : from !== undefined ? { from } : null;
}

/** `?before=I[&limit=N]`. */
export function pageQuery(query: URLSearchParams): PageQuery {
  const before = count(query.get("before"), "before", 0, Number.MAX_SAFE_INTEGER);
  if (before === undefined) throw new TranscriptWindowError(400, "before is required");
  return { before, limit: count(query.get("limit"), "limit", 1, MAX_WINDOW_EVENTS) ?? WINDOW_EVENTS };
}

/** A history request: a page before `?before=`, else the window `windowQuery` names. */
export function windowed(transcript: ThreadTranscript, query: URLSearchParams): ThreadTranscript | TranscriptPage {
  return query.has("before") ? olderPage(transcript, pageQuery(query)) : windowOf(transcript, windowQuery(query));
}
