/** Where the margin's notes go: each as near its anchor row as it can be,
 * in anchor order, never overlapping. A tall note pushes the next ones down;
 * past the end of the conversation they move up instead, so the margin never
 * makes the page longer than the conversation. One note may be held at its
 * anchor (the one the reader opened): the others make room around it. The
 * conversation itself is never moved. */
export type Placed = { anchor: number; height: number };

export function place(notes: readonly Placed[], options: { gap?: number; limit?: number; hold?: number | null } = {}): number[] {
  const gap = options.gap ?? 8;
  const n = notes.length;
  const top = notes.map(note => Math.max(0, note.anchor));
  if (!n) return top;
  const down = (from: number) => {
    for (let i = Math.max(from, 1); i < n; i++) top[i] = Math.max(top[i]!, top[i - 1]! + notes[i - 1]!.height + gap);
  };
  const up = (from: number) => {
    for (let i = from; i >= 0; i--) if (i < n - 1) top[i] = Math.min(top[i]!, top[i + 1]! - gap - notes[i]!.height);
  };
  const hold = options.hold ?? null;
  if (hold !== null && hold >= 0 && hold < n) {
    // The held note stays at its anchor; those after it go down, those
    // before it up, and none above the top.
    down(hold + 1);
    up(hold - 1);
  } else down(1);
  // Past the end: the last note ends there, the ones before it move up.
  if (options.limit !== undefined) {
    const last = n - 1;
    if (top[last]! + notes[last]!.height > options.limit) {
      top[last] = options.limit - notes[last]!.height;
      up(last - 1);
    }
  }
  // Never above the top: a margin taller than its room overflows down.
  if (top[0]! < 0) { top[0] = 0; down(1); }
  else for (let i = 1; i < n; i++) if (top[i]! < top[i - 1]! + notes[i - 1]!.height + gap) { down(i); break; }
  return top;
}
