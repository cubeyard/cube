import type { ThreadSummary } from "./types.ts";

/** Lamp colour for a thread row (DESIGN.md: one lamp per module). */
export const lampClass = (thread: ThreadSummary) =>
  thread.busy || thread.state === "setting-up" ? "on-amber blink"
  : thread.state === "error" ? "on-red"
  : thread.state === "sleeping" ? "off"
  : "on-green";

/** Silkscreen state word; null for the quiet default (ready). */
export const stateLabel = (thread: ThreadSummary) =>
  thread.busy ? "working"
  : thread.state === "setting-up" ? "setting up"
  : thread.state === "sleeping" ? "sleeping"
  : thread.state === "error" ? "error"
  : null;
