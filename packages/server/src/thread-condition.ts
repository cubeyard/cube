/** A thread's condition: the one answer to "what is this thread doing, and
 * can its agent go on", from its registry row and what this process knows
 * of it (`Conversations.condition`). Every reader renders it: the API's
 * thread row (`threadRow`), OptChat's `threads`, `history`, overview and
 * watcher (optchat-threads.ts). None ranks the facts itself
 * (docs/thread-lifecycle.md, "Reading a thread"). */
import type { MachineSleep } from "./machine-sleep.ts";
import type { Thread } from "./registry.ts";
import { releaseUnfinished } from "./thread-recovery.ts";

/** What this process knows of a thread beside its row (Conversations' maps). */
export interface ThreadRuntime {
  /** An archive is under way (or deciding). */
  archiving: boolean;
  /** An activation boots, prepares or opens it; a check of a running machine is not one. */
  starting: boolean;
  agentOpen: boolean;
  /** Why the last try failed (also the stop after START_TRIES). */
  error: string | null;
  /** Why the Pi agent is down (its Session failed). */
  down: string | null;
  /** Why the machine waits for a runner. */
  waiting: string | null;
}

/** `failure`: why the last try failed; `waiting`: why it waits for a
 * runner; `sleep`: the machine's sleep, if it sleeps. */
export type ThreadCondition =
  | { kind: "archived"; failure: string | null }
  | { kind: "archiving"; failure: string | null }
  | { kind: "down"; failure: string }
  /** No agent goes on: its machine failed, or failed to wake. */
  | { kind: "failed"; failure: string; sleep: MachineSleep | null }
  | { kind: "starting"; failure: string | null; waiting: string | null; sleep: MachineSleep | null }
  /** Waits for a runner, with no activation under way and no agent open. */
  | { kind: "waiting"; waiting: string; sleep: MachineSleep | null }
  /** Its agent is open, or its machine is ready (or sleeps); `failure`
   * and `waiting` are a later check's, under an open agent. */
  | { kind: "ready"; failure: string | null; waiting: string | null; sleep: MachineSleep | null }
  /** Its machine was never made, and no start is under way. */
  | { kind: "new" };

export function threadCondition(thread: Thread, runtime: ThreadRuntime): ThreadCondition {
  if (thread.archived) return { kind: "archived", failure: thread.workspaceState === "failed" ? thread.workspaceError : null };
  // An unfinished release is retried until it succeeds: the thread is on
  // its way out, whatever else failed.
  if (runtime.archiving || releaseUnfinished(thread)) return { kind: "archiving", failure: runtime.error };
  if (runtime.down) return { kind: "down", failure: runtime.down };
  const sleep = thread.vm?.suspension ?? null;
  // The row keeps a failure across a restart, until a try succeeds.
  const failure = runtime.error ?? (thread.workspaceState === "failed" ? thread.workspaceError ?? "the thread machine failed" : null);
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
export const failureOf = (condition: ThreadCondition): string | null => condition.kind === "new" || condition.kind === "waiting" ? null : condition.failure;

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

/** The condition's part of the API's thread row. */
export const threadRow = (condition: ThreadCondition) =>
  ({ state: rowState(condition), error: failureOf(condition), waiting: waitingOf(condition) });
