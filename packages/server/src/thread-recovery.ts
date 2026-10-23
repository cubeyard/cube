/** What cubed's recovery loop does with one open thread in a round: the one
 * place its rules live (docs/thread-lifecycle.md). A round acts on
 * what an owner still needs, never on a passive read: a sleeping machine is
 * woken only when the thread's agent has a run to go on with. */
import type { Thread } from "./registry.ts";

/** `release`: finish a release a crash or a failure left; `check`: the
 * machine of a ready thread is attached (and started when its runner
 * restarted); `start`: start or prepare the machine, or wake one whose agent
 * has a run to go on with; `settle-wake`: a wake no one in this process owns
 * (one a restart cut short) is read back from the runner, never continued;
 * `leave`: nothing this round (also while a failed try's pause runs, and
 * once START_TRIES starts failed). */
export type RecoveryStep = "release" | "check" | "start" | "settle-wake" | "leave";

/** Automatic tries of a start before the recovery loop stops: the pauses
 * between them (30 s doubling to 30 min) add up to about an hour. A message
 * to the thread tries once more; a release is tried for as long as it fails. */
export const START_TRIES = 8;
const FIRST_PAUSE_MS = 30_000;
const LONGEST_PAUSE_MS = 30 * 60_000;

/** The pause after `failures` failed tries in a row. */
export const retryPause = (failures: number) => Math.min(FIRST_PAUSE_MS * 2 ** Math.max(0, failures - 1), LONGEST_PAUSE_MS);

/** The recovery loop no longer starts the thread: START_TRIES tries failed in
 * a row. Never true of a release, which is an obligation. */
export const retriesExhausted = (thread: Thread) => !thread.archived && (thread.retry?.failures ?? 0) >= START_TRIES && !releaseUnfinished(thread);

export interface RecoveryFacts {
  /** An activation or a wake of the thread is under way in this process. */
  owned: boolean;
  /** The thread's agent has a run to go on with that no open agent drives:
   * a submission its stored conversation has not finished. */
  demand: boolean;
  /** Now, for the pause after a failed try (`thread.retry`). */
  now: number;
}

/** A release that failed or was cut short: only the release is retried. */
export const releaseUnfinished = (thread: Thread) => thread.workspaceState === "releasing"
  || (thread.workspaceState === "failed" && !!thread.workspaceError?.startsWith("workspace release failed:"));

export function recoveryStep(thread: Thread, facts: RecoveryFacts): RecoveryStep {
  if (thread.archived) return "leave";
  // After a failed try, the next one waits its pause.
  const due = !thread.retry || facts.now >= thread.retry.at + retryPause(thread.retry.failures);
  if (releaseUnfinished(thread)) return due ? "release" : "leave";
  if (retriesExhausted(thread)) return "leave";
  const sleep = thread.vm?.suspension;
  if (sleep) {
    if (facts.owned) return "leave";
    if (facts.demand) return due ? "start" : "leave";
    return sleep.state === "waking" ? "settle-wake" : "leave";
  }
  if (!due) return "leave";
  return thread.workspaceState === "available" ? "check" : "start";
}

/** Whether `recoveryStep` needs to know the thread's demand: only a sleeping
 * machine no one in this process wakes. */
export const needsDemand = (thread: Thread, owned: boolean) => !thread.archived && !owned && !!thread.vm?.suspension && !releaseUnfinished(thread)
  && !retriesExhausted(thread);
