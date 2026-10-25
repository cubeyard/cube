/** A conversation's unsent draft, by its API base, for the session: a thread
 * opened in the panel over the chat leaves the page when the panel closes,
 * and its draft must be there when it opens again. Kept with it: a send
 * that failed, with its note and its request id and count (so a retry of
 * the same words is the same request, as in a view that stayed). A send
 * still on its way is never kept: a later view must not reuse its id once
 * it has gone through, or a repeat of the same words would read as a replay. A send that fails after its view has gone is recovered: into the
 * view open now, if one is (before what was typed there since), else into
 * the kept text. Only text: images being attached are not kept. Memory
 * only; a reload starts clean. */
export type Pending = { key: string; requestId: string; seen: number | null };
export type Kept = { text: string; pending: Pending | null; note: string | null };
export type Recovery = { text: string; note: string; pending: Pending | null };

const kept = new Map<string, Kept>();
const views = new Map<string, Set<(recovery: Recovery) => void>>();
const EMPTY: Kept = { text: "", pending: null, note: null };

export const keptOf = (base: string): Kept => kept.get(base) ?? EMPTY;
export function keep(base: string, change: Partial<Kept>): void {
  const next = { ...keptOf(base), ...change };
  if (next.text.trim() || next.pending || next.note) kept.set(base, next);
  else kept.delete(base);
}
/** Words whose send failed after their view went. */
export function recover(base: string, recovery: Recovery): void {
  const open = views.get(base);
  if (open?.size) { for (const view of open) view(recovery); return; }
  const now = keptOf(base);
  keep(base, { text: now.text.trim() ? `${recovery.text}\n${now.text}` : recovery.text, note: recovery.note, pending: recovery.pending });
}
/** A view open on `base` takes recoveries while it stays. */
export function listen(base: string, view: (recovery: Recovery) => void): () => void {
  const open = views.get(base) ?? new Set();
  views.set(base, open);
  open.add(view);
  return () => { open.delete(view); if (!open.size) views.delete(base); };
}
