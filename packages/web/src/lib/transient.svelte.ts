/**
 * A short-lived piece of text: "saved", "renamed", "checked" printed next
 * to the control that just succeeded, then gone. Setting a new value
 * restarts the clock; `clear()` removes it at once.
 */
export function createTransient(ms = 3000) {
  let value = $state<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clear(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    value = null;
  }

  return {
    get value() {
      return value;
    },
    set(text: string, holdMs = ms): void {
      if (timer) clearTimeout(timer);
      value = text;
      timer = setTimeout(clear, holdMs);
    },
    clear,
  };
}
