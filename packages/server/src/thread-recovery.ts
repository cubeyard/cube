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
 * `leave`: nothing this round. */
export type RecoveryStep = "release" | "check" | "start" | "settle-wake" | "leave";

export interface RecoveryFacts {
  /** An activation or a wake of the thread is under way in this process. */
  owned: boolean;
  /** The thread's agent has a run to go on with that no open agent drives:
   * a submission its stored conversation has not finished. */
  demand: boolean;
}

/** A release that failed or was cut short: only the release is retried. */
export const releaseUnfinished = (thread: Thread) => thread.workspaceState === "releasing"
  || (thread.workspaceState === "failed" && !!thread.workspaceError?.startsWith("workspace release failed:"));

export function recoveryStep(thread: Thread, facts: RecoveryFacts): RecoveryStep {
  if (thread.archived) return "leave";
  if (releaseUnfinished(thread)) return "release";
  const sleep = thread.vm?.suspension;
  if (sleep) {
    if (facts.owned) return "leave";
    if (facts.demand) return "start";
    return sleep.state === "waking" ? "settle-wake" : "leave";
  }
  return thread.workspaceState === "available" ? "check" : "start";
}

/** Whether `recoveryStep` needs to know the thread's demand: only a sleeping
 * machine no one in this process wakes. */
export const needsDemand = (thread: Thread, owned: boolean) => !thread.archived && !owned && !!thread.vm?.suspension && !releaseUnfinished(thread);
