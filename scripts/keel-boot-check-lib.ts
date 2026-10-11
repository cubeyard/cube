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
