/** What the chat page shows of OptChat's threads (`GET /api/optchat/threads`):
 * every thread the chat started, found from its own spawns, never kept by
 * hand. Types only, shared with the web app. */

/** A thread as cubed records it when the overview is read. `state` is the
 * thread's own run or machine state, never a goal's: a turn that ended is
 * not work done, and an archived thread is not a goal met. For an archived
 * thread it is how its last run ended, when that was read. */
export type ObservedThread = { id: string; title: string | null; project: { id: string; name: string }; state: string; archived: boolean };
export type OverviewThread = ObservedThread & { spawned: number | null };
/** The chat's threads, newest first: every open one and the newest
 * archived; `unknown`: threads it started that cubed no longer has. */
export type ThreadOverview = { threads: OverviewThread[]; archived: { shown: number; total: number }; unknown: number };
