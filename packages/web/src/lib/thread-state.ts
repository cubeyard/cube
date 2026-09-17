import type { ThreadSummary } from "./types.ts";

export const lampClass = (thread: ThreadSummary) => thread.state === "error" ? "on-red" : "on-green";
export const stateLabel = (thread: ThreadSummary) => thread.state === "error" ? "error" : null;
