import type { OverviewThread } from "./types.ts";

/** A thread's own state as cubed records it (optchat-threads observe):
 * moving while it works, starts, waits or is being archived. */
export const moving = (state: string): boolean =>
  state === "working" || state === "starting" || state === "being archived" || state.startsWith("waiting");

/** Failed: its run or its machine; read from cubed's own words, never inferred. */
export const failing = (state: string): boolean =>
  state === "failed" || state.includes("error") || state.includes("failed");

/** The lamp for a thread state: blinking amber while it moves, steady red
 * when it failed, the unlit lens otherwise (a turn that ended is not done). */
export const stateLamp = (state: string): string => moving(state) ? "on-amber blink" : failing(state) ? "on-red" : "";

/** A thread's state in the chat's words: a finished turn is "turn ended", never "done". */
export const stateText = (state: string): string => state === "completed" ? "turn ended" : state;

/** What the work key counts: threads moving and threads that failed. */
export function workCounts(threads: readonly Pick<OverviewThread, "state" | "archived">[]): { running: number; failed: number; open: number } {
  const open = threads.filter(thread => !thread.archived);
  return { running: open.filter(thread => moving(thread.state)).length, failed: open.filter(thread => failing(thread.state)).length, open: open.length };
}
