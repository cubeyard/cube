import type { ThreadName } from "../../../server/src/thread-names.ts";
export type { ThreadName };

/** "🦦 calm otter", for text; empty for a thread older than names. */
export const nameText = (name: ThreadName | null | undefined): string => name ? `${name.emoji} ${name.words}` : "";

/** A thread in one line of text: its name before its title ("🦦 calm otter ·
 * fix the deploy"), whichever it has, else `fallback`. */
export function threadText(thread: { name?: ThreadName | null | undefined; title: string | null }, fallback = "untitled"): string {
  return [nameText(thread.name), thread.title].filter(Boolean).join(" · ") || fallback;
}
