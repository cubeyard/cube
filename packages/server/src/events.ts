/**
 * Lifecycle events: the one lightweight trace cubed keeps of what it did
 * and how long it took. Every transition (provision, wake, sleep, destroy,
 * terminal spawn/exit, service ensure, git push/PR, portal failure, project
 * check, API 500) lands as a row in the registry's `event` table, stamped
 * with the running version, so `GET /api/events`, `cube events`,
 * `cube diagnose` and `scripts/events-report.ts` all read one source.
 *
 * A **span** groups the phases of one operation under an `op` id: each
 * `phase()` records the time since the previous mark, `end()` records the
 * whole. Failures carry the error text in `detail` — raw, for diagnosis;
 * the product surface never renders events verbatim.
 */
import crypto from "node:crypto";

export interface EventInput {
  kind: string;
  phase?: string | null;
  op?: string | null;
  cube?: string | null;
  thread?: string | null;
  ok: boolean;
  ms?: number | null;
  detail?: string | null;
}

export interface EventSink {
  recordEvent(input: EventInput): void;
}

const DETAIL_CAP = 1000;

export const describeError = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, DETAIL_CAP);

/** `thread` may be a getter: a provision span starts before the thread row
 * exists, so the id is resolved at each record, not at span creation. */
export interface SpanBase {
  kind: string;
  cube?: string | null;
  thread?: string | null | (() => string | null);
}

export class Span {
  private readonly sink: EventSink;
  private readonly base: SpanBase;
  private readonly started = performance.now();
  private last = this.started;
  private ended = false;
  readonly op = crypto.randomBytes(4).toString("hex");

  // Explicit fields, not parameter properties: cubed runs on node's
  // strip-only TypeScript, which rejects the `constructor(private x)` form.
  constructor(sink: EventSink, base: SpanBase) {
    this.sink = sink;
    this.base = base;
  }

  private record(phase: string | null, ok: boolean, ms: number, detail?: string | null): void {
    const thread = typeof this.base.thread === "function" ? this.base.thread() : this.base.thread;
    this.sink.recordEvent({
      kind: this.base.kind,
      cube: this.base.cube ?? null,
      thread: thread ?? null,
      phase,
      op: this.op,
      ok,
      ms,
      detail: detail?.slice(0, DETAIL_CAP) ?? null,
    });
  }

  /** Record one phase: the time since the previous mark (or the start). */
  phase(name: string, detail?: string | null, ok = true): void {
    const now = performance.now();
    this.record(name, ok, Math.round(now - this.last), detail);
    this.last = now;
  }

  /** Record the whole operation. Idempotent: a span ends once. */
  end(ok: boolean, detail?: string | null): void {
    if (this.ended) return;
    this.ended = true;
    this.record(null, ok, Math.round(performance.now() - this.started), detail);
  }

  fail(error: unknown): void {
    this.end(false, describeError(error));
  }
}

/** A point event with no duration of its own. */
export function recordPoint(sink: EventSink, input: Omit<EventInput, "ok"> & { ok?: boolean }): void {
  sink.recordEvent({ ok: true, ...input, detail: input.detail?.slice(0, DETAIL_CAP) ?? null });
}

/** Text rendering shared by `GET /api/events?format=text` and `cube events`. */
export function formatEventLine(event: {
  ts: number;
  kind: string;
  phase: string | null;
  cube: string | null;
  thread: string | null;
  ok: boolean;
  ms: number | null;
  detail: string | null;
  version: string;
}): string {
  const when = new Date(event.ts).toISOString().replace("T", " ").slice(0, 19);
  const what = event.phase ? `${event.kind}.${event.phase}` : event.kind;
  const who = event.thread ? `thread=${event.thread.slice(0, 8)}` : event.cube ? `cube=${event.cube}` : "";
  const took = event.ms === null ? "" : `${event.ms} ms`;
  const mark = event.ok ? "ok " : "ERR";
  const detail = event.detail ? ` — ${event.detail.replace(/\s+/g, " ").slice(0, 160)}` : "";
  return [when, mark, what.padEnd(22), who.padEnd(15), took.padStart(9), detail].join(" ").trimEnd();
}
