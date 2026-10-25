/** Unsent drafts by conversation (its API base), for the session: a thread
 * opened in the panel over the chat leaves the page when the panel closes,
 * and its draft must be there when it opens again. Only text: images being
 * attached are not kept. Nothing is written to storage; a reload starts clean. */
const drafts = new Map<string, string>();

export const draftOf = (base: string): string => drafts.get(base) ?? "";
export function keepDraft(base: string, text: string): void {
  if (text.trim()) drafts.set(base, text);
  else drafts.delete(base);
}
