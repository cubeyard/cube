import { onDestroy } from "svelte";

/**
 * A short-lived piece of text: "saved", "renamed", "checked" printed next
 * to the control that just succeeded, then gone. Setting a new value
 * restarts the clock; `clear()` removes it at once. Created during
 * component init: the clock stops with the component, and a late async
 * completion after unmount sets nothing.
 */
export function createTransient(ms = 3000) {
  let value = $state<string | null>(null);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function clear(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    value = null;
  }

  onDestroy(() => {
    disposed = true;
    clear();
  });

  return {
    get value() {
      return value;
    },
    set(text: string, holdMs = ms): void {
      if (disposed) return;
      if (timer) clearTimeout(timer);
      value = text;
      timer = setTimeout(clear, holdMs);
    },
    clear,
  };
}
