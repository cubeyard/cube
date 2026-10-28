/** A thread's condition: the one answer to "what is this thread doing, and
 * can its agent go on", from its registry row and what this process knows
 * of it (`Conversations.condition`). Every reader renders it: the API's
 * thread row (`threadRow`), OptChat's `threads`, `history`, overview and
 * watcher (optchat-threads.ts). None ranks the facts itself
 * (docs/thread-lifecycle.md, "Reading a thread"). */
import type { MachineSleep } from "./machine-sleep.ts";
import type { Thread } from "./registry.ts";
import { readFailure, type Failure } from "./thread-failure.ts";
import { releaseUnfinished, retriesExhausted } from "./thread-recovery.ts";

/** What this process knows of a thread beside its row (Conversations' maps). */
export interface ThreadRuntime {
  /** An archive is under way (or deciding). */
  archiving: boolean;
  /** An activation boots, prepares or opens it; a check of a running machine is not one. */
  starting: boolean;
  agentOpen: boolean;
  /** Why the last try failed (also the stop after START_TRIES). */
  failure: Failure | null;
  /** Why the Pi agent is down (its Session failed). */
  down: string | null;
  /** Why the machine waits for a runner. */
  waiting: string | null;
}

/** `failure`: why the last try failed; `waiting`: why it waits for a
 * runner; `sleep`: the machine's sleep, if it sleeps. */
export type ThreadCondition =
  | { kind: "archived"; failure: Failure | null }
  | { kind: "archiving"; failure: Failure | null }
  | { kind: "down"; failure: Failure }
  /** No agent goes on: its machine failed, or failed to wake. */
  | { kind: "failed"; failure: Failure; sleep: MachineSleep | null }
  | { kind: "starting"; failure: Failure | null; waiting: string | null; sleep: MachineSleep | null }
  /** Waits for a runner, with no activation under way and no agent open. */
  | { kind: "waiting"; waiting: string; sleep: MachineSleep | null }
  /** Its agent is open, or its machine is ready (or sleeps); `failure`
   * and `waiting` are a later check's, under an open agent. */
  | { kind: "ready"; failure: Failure | null; waiting: string | null; sleep: MachineSleep | null }
  /** Its machine was never made, and no start is under way. */
  | { kind: "new" };

export function threadCondition(thread: Thread, runtime: ThreadRuntime): ThreadCondition {
  if (thread.archived) return { kind: "archived", failure: thread.workspaceState === "failed" && thread.workspaceError ? readFailure(thread.workspaceError) : null };
  // The row keeps a failure across a restart, until a try succeeds.
  const failure = runtime.failure ?? (thread.workspaceState === "failed" ? readFailure(thread.workspaceError ?? "the thread machine failed") : null);
  // An unfinished release is retried until it succeeds: the thread is on
  // its way out, whatever else failed.
  if (runtime.archiving || releaseUnfinished(thread)) return { kind: "archiving", failure };
  // A down agent is the whole story until cubed restarts: no try or wait
  // of its machine lets it go on.
  if (runtime.down) return { kind: "down", failure: { kind: "down", text: runtime.down } };
  const sleep = thread.vm?.suspension ?? null;
  // A queued thread waits in its runner's queue, whether this process is
  // asking for its slot now or has not yet: its row says so.
  if (sleep?.state === "queued") return { kind: "waiting", waiting: sleep.waiting, sleep };
  if (runtime.starting) return { kind: "starting", failure, waiting: runtime.waiting, sleep };
  // An open agent goes on with its run after a later check failed; a
  // machine that failed to wake cannot.
  if (failure && (!runtime.agentOpen || sleep)) return { kind: "failed", failure, sleep };
  if (runtime.agentOpen) return { kind: "ready", failure, waiting: runtime.waiting, sleep };
  if (runtime.waiting) return { kind: "waiting", waiting: runtime.waiting, sleep };
  if (thread.workspaceState === "allocating") return { kind: "new" };
  return { kind: "ready", failure: null, waiting: null, sleep };
}

/** Why the thread's last try failed, or its agent is down. */
export const failureOf = (condition: ThreadCondition): Failure | null => condition.kind === "new" || condition.kind === "waiting" ? null : condition.failure;

/** Why the thread's machine waits for a runner. */
export const waitingOf = (condition: ThreadCondition): string | null =>
  condition.kind === "starting" || condition.kind === "waiting" || condition.kind === "ready" ? condition.waiting : null;

/** The API's thread row state (packages/web's `ThreadState`): `error` while
 * a failure stands, `starting` while a start is under way or waits. */
export function rowState(condition: ThreadCondition): "error" | "starting" | "ready" {
  if (failureOf(condition)) return "error";
  switch (condition.kind) {
    case "starting": case "waiting": return "starting";
    case "archived": case "archiving": case "ready": case "new": return "ready";
    case "down": case "failed": return "error";
  }
}

/** The condition's part of the API's thread row: `error` in words, and
 * `failureKind` for a reader that decides by it (the web). */
export const threadRow = (condition: ThreadCondition) => {
  const failure = failureOf(condition);
  return { state: rowState(condition), error: failure?.text ?? null, failureKind: failure?.kind ?? null, waiting: waitingOf(condition) };
};

/** A thread whose start or wake does not succeed now, as OptChat reports it
 * once it lasts: the fact Conversations publishes (`onStartFailure`) when
 * it changes. `episode`: the first failed try of a sleeping machine's
 * failed wakes in a row (one report each); null: one report per thread.
 * `retrying`: cubed tries it again (not a down agent, nor once the
 * recovery loop stopped). `waking`: its machine sleeps. */
export interface StartFailure { failure: string; episode: string | null; retrying: boolean; waking: boolean }

/** The thread's start failure now, or null. A thread whose agent is open
 * goes on with its run whatever a later check found, so it has none,
 * unless its agent is down. A wait for a runner counts as a start not made
 * yet; a sleeping machine's wait for a slot does not; a wake that failed
 * does. An archive (or a release left unfinished) is not one. */
export function startFailureOf(thread: Thread, condition: ThreadCondition, agentOpen: boolean): StartFailure | null {
  if (condition.kind !== "down" && agentOpen) return null;
  const failure = startFailureText(condition);
  if (!failure) return null;
  const sleep = "sleep" in condition ? condition.sleep : null;
  const since = sleep && failureOf(condition) && thread.retry?.since;
  return { failure, episode: since ? String(since) : null, retrying: condition.kind !== "down" && !retriesExhausted(thread), waking: !!sleep };
}

function startFailureText(condition: ThreadCondition): string | null {
  switch (condition.kind) {
    case "down": case "failed": return condition.failure.text;
    case "starting": return condition.failure?.text ?? (condition.sleep ? null : condition.waiting);
    case "waiting": return condition.sleep ? null : condition.waiting;
    case "archived": case "archiving": case "ready": case "new": return null;
  }
}
