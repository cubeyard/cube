/** A thread's phase (`workspaceState`, `workspaceError`, `workspaceBase`,
 * `retry`, `archived`): the one place its transitions live
 * (docs/thread-lifecycle.md, "Thread"). Conversations reports what happened
 * as a `PhaseEvent`; only `Registry.applyPhase` writes the result, in its
 * IMMEDIATE transaction, with the runner's summary. The persisted shape is
 * the one cubed always wrote. */
import type { Thread } from "./registry.ts";
import type { Failure } from "./thread-failure.ts";

export type ThreadPhase = Pick<Thread, "workspaceState" | "workspaceError" | "workspaceBase" | "retry" | "archived">;

/** What happened to the thread:
 * - `ready`: its machine is made and prepared, its agent may open;
 * - `failed`: making or releasing it failed (the row keeps the words);
 * - `tryFailed`: a start or release try failed, counted for the recovery
 *   loop's pause and limit;
 * - `trySucceeded`: a try succeeded; the failed ones before no longer count;
 * - `releaseBegan`: an archive decided the disk and releases the machine
 *   (its own tries count from here);
 * - `released`: the release finished: archived, its slot free;
 * - `retaken`: a thread whose commits failed before it had a machine (it
 *   held no slot since, Registry) took a slot again for its next try. */
export type PhaseEvent =
  | { type: "ready"; base: Thread["workspaceBase"] }
  | { type: "failed"; failure: Failure }
  | { type: "tryFailed"; failure: Failure; at: number }
  | { type: "trySucceeded" }
  | { type: "releaseBegan" }
  | { type: "released" }
  | { type: "retaken" };

/** The phase after `event`. `archived` is terminal: nothing changes it. */
export function nextPhase(phase: ThreadPhase, event: PhaseEvent): ThreadPhase {
  if (phase.archived) return phase;
  switch (event.type) {
    case "ready": return { ...phase, workspaceState: "available", workspaceError: null, workspaceBase: event.base };
    case "failed": return { ...phase, workspaceState: "failed", workspaceError: event.failure.text };
    case "tryFailed": {
      // A row older than `since` takes its last try's time as the first.
      const since = phase.retry ? phase.retry.since ?? phase.retry.at : event.at;
      return { ...phase, retry: { failures: (phase.retry?.failures ?? 0) + 1, at: event.at, since, error: event.failure.text.slice(0, 1024) } };
    }
    case "trySucceeded": return withoutRetry(phase);
    case "retaken": return { ...phase, workspaceState: "allocating", workspaceError: null };
    case "releaseBegan": return { ...withoutRetry(phase), workspaceState: "releasing", workspaceError: null };
    case "released": return { ...phase, archived: true };
  }
}

function withoutRetry(phase: ThreadPhase): ThreadPhase {
  const { retry: _, ...rest } = phase;
  return rest;
}
