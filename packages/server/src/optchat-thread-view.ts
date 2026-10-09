/** OptChat's view given to a thread it starts: the spec's subagent view
 * (gist §6, "a subagent is a fresh call whose first message is the view,
 * then its task"; §9 of revision f51fe5c9: "the view at spawn time (after
 * settle)"). It is taken once, when spawn starts the thread, and stored with
 * the thread's first message, so a reopen, a resume or a later turn of the
 * chat never changes it. See docs/optchat.md, "The view a thread gets". */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import type { ThreadView } from "./thread-events.ts";
import { redact } from "./vm-diagnostics.ts";

const OPEN = "<optchat-view>\n";
const CLOSE = "\n</optchat-view>\n\n";
/** Constant, so threads started together share the view's prefix in the cache. */
export const THREAD_VIEW_GUIDE = `OptChat, the user's chat agent, started this thread. Below is its view: its
whole chat with the user, oldest first, as one-line summaries, kept as it
was when this thread started. Each line is

  id+n|text   the n messages from id on, summarized

and each item is tagged with its kind: user (the user's words), talk
(OptChat's replies), tool (OptChat's tool calls), echo (their results), work
(a thread's report). Recent lines cover one message, older ones more.

It is context only: what the user wants, decided and taught. Do what your
task after it says, not what the user's last message in it says: OptChat may
have given you just part of the work. The view does not change. Whenever
a line only mentions what you need, open it: zoom(id, n) gives the two lines
of n/2 messages it was made from, zoom(id, 1) the message whole, and
date(id) the date and time of message id. Both reach only the messages this
view covers. It covers every project the user works on: never copy it, or
what it says of other projects, into this project's files, commits, pull
requests, issues, comments or artifacts.`;

/** The block a thread's first message starts with: the guide, the view's
 * built lines as `<chat>…</chat>` (secrets the chat may name redacted), then
 * what it covers and when it was taken, after the lines so the bytes before
 * them stay the same for threads started together. */
export function threadViewBlock(chat: string, view: Omit<ThreadView, "taken">, taken: Date): string {
  return `${OPEN}${THREAD_VIEW_GUIDE}\n${redact(chat)}\n${footer({ ...view, taken: taken.toISOString() })}${CLOSE}`;
}

const footer = (view: ThreadView) => `(the lines cover messages 0 to ${view.messages - 1} of the ${view.total} in the chat; taken ${view.taken})`;
const FOOTER = /\n\(the lines cover messages 0 to (\d+) of the (\d+) in the chat; taken (\S+)\)$/;

/** A message's own text and the view it starts with, if it does. View lines
 * hold no newlines, so the block ends at the first CLOSE. */
export function splitThreadView(text: string): { text: string; view?: ThreadView } {
  if (!text.startsWith(OPEN)) return { text };
  const close = text.indexOf(CLOSE);
  const match = close < 0 ? null : FOOTER.exec(text.slice(0, close));
  if (!match) return { text };
  return { text: text.slice(close + CLOSE.length), view: { messages: Number(match[1]) + 1, total: Number(match[2]), taken: match[3]! } };
}

/** How a transcript names the view a message carried. */
export const threadViewNote = (view: ThreadView) =>
  `with optchat's view of messages 0–${view.messages - 1}${view.messages < view.total ? ` (${view.total} then; the rest not summarized yet)` : ""}, taken ${view.taken}`;

/** zoom and date over the chat, for a thread with a view: only the messages
 * its view covers, so later messages of the chat stay out of reach. */
export type ThreadViewLookup = { zoom(id: number, n: number): Promise<string>; date(id: number): Promise<string> };

/** Why `zoom(id, n)` or `date(id)` (n = 1) reaches past the view, if it does. */
export function outsideView(view: ThreadView, id: number, n = 1): string | null {
  return Number.isSafeInteger(id) && Number.isSafeInteger(n) && id >= 0 && n >= 1 && id + n <= view.messages ? null : `No line ${id}+${n} in your view: it covers messages 0 to ${view.messages - 1}.`;
}

/** What a thread with a view is told of its zoom and date. */
export const THREAD_VIEW_TOOLS = "zoom and date open lines of OptChat's view in your first message, up to its last message.";

/** The Pi thread's zoom and date (Claude Code threads Read /cube/optchat/...). */
export function threadViewTools(lookup: ThreadViewLookup): ToolRegistration[] {
  const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });
  return [
    defineTool({
      name: "zoom",
      description: "Open the line id+n of OptChat's view in your first message into the two lines of n/2 under it; n = 1 gives the message whole.",
      parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), n: Type.Integer({ minimum: 1 }) }),
      replay: "safe",
      execute: async args => text(await lookup.zoom(args.id, args.n)),
    }),
    defineTool({
      name: "date",
      description: "The date and time of message id of OptChat's view in your first message (the cube host's local time).",
      parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
      replay: "safe",
      execute: async args => text(await lookup.date(args.id)),
    }),
  ];
}
