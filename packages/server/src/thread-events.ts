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
}

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
 * current transcript; a 4xx refusal ends the watch. */
export class HttpThreadEvents implements ThreadEvents {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private readonly retryMs: number;
  constructor(options: { base: string; fetch?: typeof fetch; retryMs?: number }) {
    this.base = options.base.replace(/\/$/, "");
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.retryMs = options.retryMs ?? 1000;
  }

  async read(): Promise<ThreadTranscript> {
    const response = await this.fetch(`${this.base}/history`, { headers: { accept: "application/json" } });
    const body = await response.json().catch(() => null) as ThreadTranscript | { error?: unknown } | null;
    if (!response.ok) throw new Error(serverError(body, `thread history unavailable (${response.status})`));
    return body as ThreadTranscript;
  }

  async watch(listener: (transcript: ThreadTranscript) => void | Promise<void>, options: ThreadWatchOptions = {}): Promise<ThreadWatch> {
    const controller = new AbortController();
    let wake: (() => void) | undefined;
    const closed = (async () => {
      while (!controller.signal.aborted) {
        let failure: unknown = new Error("thread stream ended");
        try {
          const response = await this.fetch(`${this.base}/stream`, { headers: { accept: "text/event-stream" }, signal: controller.signal });
          if (response.status >= 400 && response.status < 500) {
            const body = await response.json().catch(() => null) as { error?: unknown } | null;
            options.onEnd?.(new Error(serverError(body, `thread stream unavailable (${response.status})`)));
            return;
          }
          if (!response.ok || !response.body) throw new Error(`thread stream unavailable (${response.status})`);
          await readFrames(response.body, listener);
        } catch (error) { failure = error; }
        if (controller.signal.aborted) break;
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

async function readFrames(body: ReadableStream<Uint8Array>, listener: (transcript: ThreadTranscript) => void | Promise<void>): Promise<void> {
  const reader = body.getReader();
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
        if (data) await listener(JSON.parse(data) as ThreadTranscript);
      }
    }
  } finally { reader.releaseLock(); }
}
