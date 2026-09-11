import { DateTime, Effect, Ref, Schema } from "effect";

export const STARTUP_LOG_LIMIT = 32_768;
export const EnvironmentProgress = Schema.Struct({
  phase: Schema.String,
  startedAt: Schema.Number,
  updatedAt: Schema.Number,
  log: Schema.String,
  truncated: Schema.Boolean,
  failed: Schema.Boolean,
});
export type EnvironmentProgress = typeof EnvironmentProgress.Type;

/** Bounded UI snapshots, not another log store. Durable setup/resume evidence
 * still belongs to Lifecycle. Only plain text crosses into the browser. */
export const makeEnvironmentProgress = Effect.fnUntraced(function*() {
  const state = yield* Ref.make(new Map<string, EnvironmentProgress>());
  const get = (name: string) => Ref.get(state).pipe(Effect.map((rows) => rows.get(name)));
  const update = Effect.fnUntraced(function*(name: string, phase?: string, output = "", failed = false) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    yield* Ref.update(state, (rows) => {
      const previous = rows.get(name);
      const text = output.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
        .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
      const log = (previous?.log ?? "") + (phase ? `\n> ${phase}\n` : "") + text;
      return new Map(rows).set(name, {
        phase: phase ?? previous?.phase ?? "creating the environment…",
        startedAt: previous?.startedAt ?? now,
        updatedAt: now,
        log: log.slice(-STARTUP_LOG_LIMIT),
        truncated: (previous?.truncated ?? false) || log.length > STARTUP_LOG_LIMIT,
        failed: failed || (previous?.failed ?? false),
      });
    });
  });
  // A shared template builder has no user thread. Relay its snapshot to each
  // waiting thread without resetting that thread's elapsed/activity clocks.
  const copy = Effect.fnUntraced(function*(from: string, to: string) {
    const source = yield* get(from);
    if (!source) return;
    yield* Ref.update(state, (rows) => {
      const previous = rows.get(to);
      const phase = `preparing a reusable environment: ${source.phase}`;
      if (previous?.log === source.log && previous.phase === phase) return rows;
      return new Map(rows).set(to, { ...source, phase, startedAt: previous?.startedAt ?? source.startedAt, failed: false });
    });
  });
  const forget = (name: string) => Ref.update(state, (rows) => {
    const next = new Map(rows);
    next.delete(name);
    return next;
  });
  return { get, update, copy, forget };
});
