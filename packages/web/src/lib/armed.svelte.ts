/**
 * Two-step confirmation without a dialog. The first press arms a key
 * (it reads "delete?" and prints what will be destroyed); a second press
 * within the window fires; Escape, blur, or the timer disarm it. One
 * instance per view — `key` names which control is armed, so a list can
 * arm exactly one row.
 */
export function createArmed(windowMs = 6000) {
  let key = $state<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function disarm(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    key = null;
  }

  function arm(id: string): void {
    if (timer) clearTimeout(timer);
    key = id;
    timer = setTimeout(disarm, windowMs);
  }

  return {
    get key() {
      return key;
    },
    is: (id: string) => key === id,
    arm,
    disarm,
    /** First press arms, second press within the window confirms. */
    press(id: string): boolean {
      if (key === id) {
        disarm();
        return true;
      }
      arm(id);
      return false;
    },
    /** Escape on the armed key cancels; the key's blur handler cancels too. */
    onKeydown(event: KeyboardEvent): void {
      if (event.key === "Escape" && key !== null) {
        event.preventDefault();
        event.stopPropagation();
        disarm();
      }
    },
  };
}
