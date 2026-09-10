/**
 * A keyboard command the shell hands to whichever view is meant to act
 * on it (`n` → new thread). Each press is one command with its own id;
 * the view takes it synchronously — `onConsume(id)` clears it in the
 * shell before the view awaits anything — so a completion, a failure or
 * a later mount can never replay it. An unconsumed command expires.
 */
export type Command = { kind: "new-thread"; id: number; at: number };

export const COMMAND_TTL_MS = 2000;
