/**
 * Answers to overlapping polls, kept in the order they were asked. An
 * answer older than one already accepted is stale: showing it would put
 * back what the host has moved past. A newer poll still in flight does not
 * hold an answer back; on a slow host that would show nothing at all.
 */
export function createOrdered() {
  let asked = 0;
  let accepted = 0;
  return {
    /** A poll leaves: its ticket. */
    ask(): number {
      return ++asked;
    },
    /** Whether the answer to this ticket may be shown; showing it makes older ones stale. */
    accept(ticket: number): boolean {
      if (ticket < accepted) return false;
      accepted = ticket;
      return true;
    },
    /** Whether a failure of this ticket still speaks for the current state. */
    current(ticket: number): boolean {
      return ticket >= accepted;
    },
  };
}
