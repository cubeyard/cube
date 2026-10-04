import type { ThreadSummary } from "./types.ts";

export const lampClass = (thread: ThreadSummary) => thread.state === "error" ? "on-red" : thread.state === "starting" ? "on-amber blink" : "on-green";
export const stateLabel = (thread: ThreadSummary) => thread.state === "error" ? "error" : thread.state === "starting" ? "starting the thread's machine" : null;
/** Composer and transcript copy while a thread's machine boots (minutes the first time). */
export const STARTING_TEXT = "starting the thread's machine…";
