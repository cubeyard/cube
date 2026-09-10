/**
 * The last mile between cubed's internals and what a person reads.
 *
 * PRODUCT.md: the user-facing unit is the thread; cubes, Incus, containers
 * and instances are invisible, and every failure states what happened and
 * the real next action. Internals speak in `String(error)`; this module is
 * the one place that translates before anything reaches the thread list,
 * the thread view, a banner or a portal page. Diagnosis keeps the raw text
 * (registry column, journal, events) — only the rendering changes.
 */

/** Cube-vocabulary scrub for anything that reaches the product surface —
 * internal cube names and the word "cube" must read as "thread". */
export function sanitizeMessage(message: string): string {
  return (
    message
      // `cube t-1a2b3c4d`, the Incus instance name `cube-t-1a2b3c4d`, and
      // the daemon's own `cube cube-t-1a2b3c4d` prefix — one "thread" each.
      .replace(/\bcube (?:cube-)?t-[a-z0-9]{8}\b/g, "thread")
      .replace(/\bcube-t-[a-z0-9]{8}\b/g, "thread")
      // Unit names (`journalctl -u cube-svc-web`) are literal — leave them.
      .replace(/\bcube\b(?!-svc-)/g, "thread")
      .replace(/\b(?:incus )?instance\b/gi, "environment")
      .replace(/\bcontainer\b/gi, "environment")
      .replace(/\bincus\b:?\s*/gi, "")
  );
}

/** Raw error text -> one calm sentence with a next step, or null when no
 * rule matches (the caller then falls back to the sanitized raw text). */
// Next steps name only what exists today: opening the thread (which wakes
// it), deleting it, starting a new thread, `cube diagnose`. Nothing here
// promises a control the UI does not have.
const RULES: Array<[RegExp, string | ((m: RegExpMatchArray) => string)]> = [
  [/^\.cube\/setup failed \(exit (\d+)\)/, (m) => `the environment's .cube/setup script failed (exit ${m[1]}) — the environment is usable as it is; fix the script, and start a new thread to run it again`],
  [/^\.cube\/setup failed/, "the environment's .cube/setup script could not run — the environment is usable as it is; check the script, and start a new thread to run it again"],
  [/^\.cube\/resume failed \(exit (\d+)\)/, (m) => `the environment's .cube/resume script failed (exit ${m[1]}) — the environment is up; fix the script, and it runs again the next time the thread wakes`],
  [/^wake hook failed/, "a wake hook in .cube/cube.toml failed — the environment is up; fix the hook, and it runs again the next time the thread wakes"],
  [/^resume interrupted by (?:a )?cubed restart/, "cube restarted while this thread was waking — open it again; if it does not come up, delete it and start a new thread"],
  [/interrupted by (?:a )?cubed restart/, "cube restarted while this thread was being set up — open it to continue; if it does not come up, delete it and start a new thread"],
  [/^wake failed: .*(?:never came up|network|timed out)/i, "the environment did not come up in time — wait a moment and open the thread again; if it keeps failing, delete it and start a new thread"],
  [/^wake failed/, "the environment could not be started — open the thread again; if it keeps failing, delete it and start a new thread"],
  [/^sleep failed/, "the environment could not be stopped cleanly — it may still be running; try again later"],
  [/^destroy failed/, "the environment could not be removed — try deleting the thread again"],
  [/^boot: /, "the environment could not be brought back after cube restarted — open the thread to try again; if that fails, delete it and start a new thread"],
  [/no free (?:cube )?subnets/, "no room for another thread — delete a thread you no longer need, then try again"],
  [/ENOSPC|no space left/i, "the host is out of disk space — free some space, then try again"],
  [/Failed creating instance|image .* not found|no such image/i, "the environment could not be created on the host — try again; if it keeps failing, run cube diagnose"],
  [/seed.*(?:failed|error)|git .*(?:failed|error)/i, "the repository could not be prepared for this thread — re-check the project, then start a new thread"],
];

export function describeThreadError(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  const text = raw.replace(/^Error:\s*/, "");
  for (const [pattern, rendering] of RULES) {
    const match = text.match(pattern);
    if (match) return typeof rendering === "string" ? rendering : rendering(match);
  }
  // Unknown failure: scrub, trim to one line, and always name the way out.
  const oneLine = sanitizeMessage(text).replace(/\s+/g, " ").trim();
  const short = oneLine.length > 160 ? `${oneLine.slice(0, 157)}…` : oneLine;
  return `${short} — try again; if it keeps failing, delete this thread and start a new one`;
}
