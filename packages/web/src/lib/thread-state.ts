import type { ThreadSummary } from "./types.ts";

/** Lamp colour for a thread row (DESIGN.md: one lamp per module). Waiting
 * states — setting up, waking — share the blinking amber: the machine is
 * doing something on your behalf, which is never the red lamp. */
export const lampClass = (thread: ThreadSummary) =>
  thread.state === "setting-up" || thread.state === "waking" ? "on-amber blink"
  : thread.state === "error" ? "on-red"
  : thread.state === "sleeping" ? "off"
  : "on-green";

/** Silkscreen state word; null for the quiet default (ready). */
export const stateLabel = (thread: ThreadSummary) =>
  thread.state === "setting-up" ? "setting up"
  : thread.state === "waking" ? "waking"
  : thread.state === "sleeping" ? "sleeping"
  : thread.state === "error" ? "error"
  : null;

/** True while the environment is being prepared or started — the thread
 * exists, the terminal will follow. Waiting is a state, not a failure. */
export const isWaiting = (thread: ThreadSummary | null | undefined) =>
  thread?.state === "setting-up" || thread?.state === "waking";

/** The strip line printed while a thread waits; null otherwise. */
export const waitingText = (thread: ThreadSummary | null | undefined) =>
  thread?.state === "setting-up" ? "setting up this thread's environment…"
  : thread?.state === "waking" ? "waking this thread's environment…"
  : null;
