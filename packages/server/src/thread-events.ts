/** The neutral thread event model: what a thread shows, whatever agent runs
 * it. An agent adapter renders its own state into a `ThreadTranscript`; the
 * browser reads only this model. The same `ThreadEvents` interface is
 * implemented in-process by an adapter and over SSE by `HttpThreadEvents`.
 *
 * This module is browser-safe: no Node imports, so packages/web can import
 * the client and the types directly. */

/** The agent a thread was created with; fixed for the thread. */
export type ThreadAgent = "pi" | "claude-code";

/** An image an event shows, served at `<base>/media/<id>`: for OptChat's own
 * messages its id in the chat's media store, for a thread's events its place
 * in the thread's store (thread-images.ts). Events never carry the bytes. */
export type MessageImage = { id: string; mimeType: string };

/** One thing a thread shows, in transcript order. `id` is stable across
 * frames for committed events; an event still streaming (`final: false`) gets
 * a new id once committed, and so does a user message the host accepted but
 * has not put in its log yet (its id starts with `PENDING_ID`). */
export type ThreadEvent =
  /** `from` marks a report from a thread the chat started: its short id.
   * `images`: the images attached to the message, if any. */
  | { type: "user-message"; id: string; text: string; from?: string; images?: MessageImage[] }
  /** Assistant text; `reasoning` marks the model's visible thinking. */
  | { type: "assistant-text"; id: string; text: string; reasoning: boolean; final: boolean }
  /** A tool call; its result, if any, carries the same `callId`. */
  | { type: "tool-call"; id: string; callId: string; name: string; input: unknown; final: boolean }
  /** A tool result, or with `final: false` the running output of a call.
   * `images`: the images it returned (a Read of a screenshot), if any. */
  | { type: "tool-result"; id: string; callId: string; name: string; output: string; isError: boolean; final: boolean; images?: MessageImage[] };

/** The id prefix of a user message accepted but not yet in the log. */
export const PENDING_ID = "pending.";

/** `idle` before the first run; `working` while a run is active; otherwise
 * how the newest run ended. `error` is the failure text, if any. `waiting`
 * names the background work the agent left running and is told about when
 * it finishes (Claude Code's background agents); absent when there is none. */
export type ThreadStatus = {
  state: "idle" | "working" | "completed" | "failed" | "stopped";
  run: string | null;
  error: string | null;
  waiting?: string[];
};

export interface ThreadTranscript {
  agent: ThreadAgent;
  /** The current writable owner of the thread workspace, if any. */
  owner: ThreadAgent | null;
  status: ThreadStatus;
  events: ThreadEvent[];
  /** A window of a longer transcript (transcript-window.ts): the index of
   * `events[0]` in the whole list. Absent: `events` is the whole list. */
  start?: number;
}

/** Events `[start, start + events.length)` of a thread's whole list. */
export interface TranscriptPage { start: number; events: ThreadEvent[] }

export interface ThreadWatch {
  stop(): Promise<void>;
  /** Settles when the watch ends: stopped, or the source closed. */
  readonly closed: Promise<void>;
}

export interface ThreadWatchOptions {
  onInterrupt?: (error: unknown) => void;
  onEnd?: (error: Error) => void;
}

export interface ThreadEvents {
  /** The current transcript. */
  read(): Promise<ThreadTranscript>;
  /** The listener receives the current transcript, then each later one.
   * Calls are serialized; a slow listener sees the newest transcript, not
   * every intermediate one. `onInterrupt` reports a lost connection that the
   * source is retrying; `onEnd` reports a refusal it does not retry, such as
   * an archived thread or an agent that failed to open (transports only). */
  watch(listener: (transcript: ThreadTranscript) => void | Promise<void>, options?: ThreadWatchOptions): Promise<ThreadWatch>;
}

/** `ThreadEvents` over cubed's HTTP routes: `GET <base>/history` and the
 * SSE stream `GET <base>/stream`, whose frames are `ThreadTranscript`s. A
 * lost stream (a network error or a 5xx) reconnects, starting from the
 * current transcript; a 4xx refusal ends the watch.
 *
 * With `tail`, the reader sees a window (transcript-window.ts): the first
 * answer chooses its start among the newest `tail` events, and every later
 * read and frame is asked from that same start, so the window only grows.
 * `older` reads the events before it a page at a time; `advance` moves the
 * start later. A start the host no longer has, or whose event changed, is
 * dropped and the window chosen again from the newest events. */
export class HttpThreadEvents implements ThreadEvents {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly retryMs: number;
  private readonly tail: number | undefined;
  private pin: { start: number; id: string | undefined } | null = null;
  private restart: (() => void) | undefined;
  constructor(options: { base: string; fetch?: typeof fetch; retryMs?: number; tail?: number }) {
    this.base = options.base.replace(/\/$/, "");
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.retryMs = options.retryMs ?? 1000;
    this.tail = options.tail;
  }

  private query(): string {
    return this.tail === undefined ? "" : this.pin ? `?from=${this.pin.start}` : `?tail=${this.tail}`;
  }

  /** The transcript as this reader's window, or null when it must be asked
   * again: it starts after the pin (an answer to a request made before the
   * pin was chosen), or the pinned event is not there any more. */
  private accept(transcript: ThreadTranscript): ThreadTranscript | null {
    if (this.tail === undefined) return transcript;
    const start = transcript.start ?? 0;
    if (!this.pin) { this.pin = { start, id: transcript.events[0]?.id }; return transcript; }
    if (start > this.pin.start) return null;
    const events = start === this.pin.start ? transcript.events : transcript.events.slice(this.pin.start - start);
    if (this.pin.start > 0 && events[0]?.id !== this.pin.id) { this.pin = null; return null; }
    return start === this.pin.start ? transcript : { ...transcript, start: this.pin.start, events };
  }

  async read(): Promise<ThreadTranscript> {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetch(`${this.base}/history${this.query()}`, { headers: { accept: "application/json" } });
      const body = await response.json().catch(() => null) as ThreadTranscript | { error?: unknown; reset?: unknown } | null;
      const retry = attempt < 3;
      if (response.status === 409 && body && "reset" in body && body.reset === true && retry) { this.pin = null; continue; }
      if (!response.ok) throw new Error(serverError(body, `thread history unavailable (${response.status})`));
      const shown = this.accept(body as ThreadTranscript);
      if (shown) return shown;
      if (!retry) throw new Error("thread history unavailable: its window kept moving");
    }
  }

  /** The events before `before` (a window's start), about `limit` of them. */
  async older(before: number, limit: number): Promise<TranscriptPage> {
    const response = await this.fetch(`${this.base}/history?before=${before}&limit=${limit}`, { headers: { accept: "application/json" } });
    const body = await response.json().catch(() => null) as TranscriptPage | { error?: unknown } | null;
    if (!response.ok) throw new Error(serverError(body, `earlier messages unavailable (${response.status})`));
    const page = body as TranscriptPage;
    if (!Number.isSafeInteger(page.start) || !Array.isArray(page.events) || page.start + page.events.length !== before) throw new Error("earlier messages unavailable: the page does not end where the window starts");
    return page;
  }

  /** Starts the window at `start` (later than now; `id` is its event's), as
   * the reader keeps the events before it: the stream starts again there. */
  advance(start: number, id: string): void {
    if (!this.pin || start <= this.pin.start) return;
    this.pin = { start, id };
    this.restart?.();
  }

  async watch(listener: (transcript: ThreadTranscript) => void | Promise<void>, options: ThreadWatchOptions = {}): Promise<ThreadWatch> {
    const controller = new AbortController();
    let wake: (() => void) | undefined;
    const closed = (async () => {
      while (!controller.signal.aborted) {
        // A connection of its own, ended at once to start again (advance,
        // a window to choose again) without reporting an interruption.
        const connection = new AbortController();
        this.restart = () => connection.abort();
        let failure: unknown = new Error("thread stream ended");
        try {
          const response = await this.fetch(`${this.base}/stream${this.query()}`, { headers: { accept: "text/event-stream" }, signal: AbortSignal.any([controller.signal, connection.signal]) });
          if (response.status >= 400 && response.status < 500) {
            const body = await response.json().catch(() => null) as { error?: unknown; reset?: unknown } | null;
            if (response.status === 409 && body?.reset === true && this.pin) { this.pin = null; continue; }
            options.onEnd?.(new Error(serverError(body, `thread stream unavailable (${response.status})`)));
            return;
          }
          if (!response.ok || !response.body) throw new Error(`thread stream unavailable (${response.status})`);
          await readFrames(response.body, async transcript => {
            if (connection.signal.aborted) return;
            const shown = this.accept(transcript);
            if (shown) await listener(shown);
            else connection.abort();
          }, connection.signal);
        } catch (error) {
          if (error instanceof WindowReset) { this.pin = null; continue; }
          failure = error;
        }
        if (controller.signal.aborted) break;
        if (connection.signal.aborted) continue;
        options.onInterrupt?.(failure);
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, this.retryMs);
          wake = () => { clearTimeout(timer); resolve(); };
        });
      }
    })();
    return {
      closed,
      async stop() { controller.abort(); wake?.(); await closed; },
    };
  }
}

function serverError(body: unknown, fallback: string): string {
  return body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : fallback;
}

/** The host ended a window's stream: it no longer has the window's start. */
class WindowReset extends Error {}

/** Reads SSE frames until the body ends or `signal` aborts: the read is
 * cancelled then, as not every engine ends it when the fetch is aborted. */
async function readFrames(body: ReadableStream<Uint8Array>, listener: (transcript: ThreadTranscript) => void | Promise<void>, signal?: AbortSignal): Promise<void> {
  const reader = body.getReader();
  signal?.addEventListener("abort", () => { void reader.cancel().catch(() => {}); }, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(line.startsWith("data: ") ? 6 : 5)).join("\n");
        if (block.split("\n").includes("event: reset")) throw new WindowReset();
        if (data) await listener(JSON.parse(data) as ThreadTranscript);
      }
    }
  } finally { reader.releaseLock(); }
}
