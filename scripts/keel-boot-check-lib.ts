// Pieces of keel's boot check (keel-boot-check.ts) that are tested offline
// in keel-boot-check-test.ts.
import { rmSync } from "node:fs";
import type { ChildProcess } from "node:child_process";

/** A shell command that prints the /proc stat line of every zombie and
 * nothing else. A process can exit between the glob and the read; the
 * braces make the failed redirection itself quiet (dash opens `< $f`
 * before a `2>/dev/null` on the same command), and the process is skipped.
 * FILES is the list to scan (tests add a stat file that does not exist). */
export const zombieScan = (files = "/proc/[0-9]*/stat") =>
  `for f in ${files}; do { read -r s < "$f"; } 2>/dev/null || continue; case "\${s##*) }" in Z*) echo "$s";; esac; done; true`;
export const ZOMBIE_SCAN = zombieScan();

/** Kills the processes this script started (and only those) and removes
 * its own directories when the script ends: normally, on an error, or on
 * SIGINT, SIGTERM or SIGHUP. A failed check must not leave a guest running. */
export class Owned {
  children = new Set<ChildProcess>();
  dirs = new Set<string>();
  constructor() {
    process.on("exit", () => this.release());
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.on(signal, () => {
        this.release();
        process.exit(128 + ({ SIGINT: 2, SIGTERM: 15, SIGHUP: 1 } as const)[signal]);
      });
    }
  }
  child<T extends ChildProcess>(child: T): T {
    this.children.add(child);
    child.on("exit", () => this.children.delete(child));
    return child;
  }
  dir(path: string): string {
    this.dirs.add(path);
    return path;
  }
  release() {
    for (const child of this.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    this.children.clear();
    for (const dir of this.dirs) rmSync(dir, { recursive: true, force: true });
    this.dirs.clear();
  }
}

/** After a restore: reads the workload's counter until it has moved `need`
 * ticks past `after` (its value right after `cont`) or `limitMs` have passed
 * since `resumedAt`. Returns the last value read and how long after
 * `resumedAt` it first moved past `before` (its value at the save), -1 if it
 * never did. A frozen workload returns `after` itself, and the boot check
 * fails it. */
export async function awaitProgress(read: () => Promise<number>, o: {
  before: number; after: number; resumedAt: number; limitMs: number; need?: number;
  now?: () => number; sleep?: (ms: number) => Promise<unknown>;
}): Promise<{ tick: number; progressMs: number }> {
  const now = o.now ?? (() => performance.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const need = o.need ?? 5;
  let tick = o.after;
  let progressMs = o.after > o.before ? now() - o.resumedAt : -1;
  while (tick < o.after + need && now() - o.resumedAt < o.limitMs) {
    await sleep(50);
    tick = await read();
    if (progressMs < 0 && tick > o.before) progressMs = now() - o.resumedAt;
  }
  return { tick, progressMs };
}
