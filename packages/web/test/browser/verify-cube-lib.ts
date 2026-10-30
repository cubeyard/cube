/** verify-cube's decisions that must hold on Linux and macOS alike: whose
 * process a pid is, and what a cleanup may stop and delete. Tested by
 * verify-cube-test.ts with stand-ins for the system. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const OWNER_FILE = ".verify-cube-owner";

export type System = {
  /** Whether a process with this pid exists. */
  alive(pid: number): boolean;
  /** Its command line, or null when it cannot be read. */
  command(pid: number): string | null;
};

const procCommand = (pid: number): string | null => {
  try { return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim() || null; } catch { return null; }
};
const psCommand = (pid: number): string | null => {
  try { return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() || null; } catch { return null; }
};

/** /proc where it exists (Linux), else `ps` (macOS); null when neither answers. */
export function readCommand(pid: number, readers: Array<(pid: number) => string | null> = [procCommand, psCommand]): string | null {
  for (const read of readers) {
    const command = read(pid);
    if (command) return command;
  }
  return null;
}

export const system: System = {
  alive(pid) {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
  },
  command: pid => readCommand(pid),
};

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a command line is the helper given exactly this `--run` (not one
 * that merely starts with it: `/tmp/r` is not `/tmp/r2`). */
export const ranWith = (command: string, runArg: string) =>
  command.includes("verify-cube.ts") && new RegExp(`(^|\\s)--run\\s+${escape(runArg)}(\\s|$)`).test(command);

/** The command a served instance runs under: the helper's `serve` with its own `--run`. */
export const isServeOf = (command: string, runArg: string) => ranWith(command, runArg) && /(^|\s)serve(\s|$)/.test(command);

/** The owner token in `scratch`, or null when it is not verify-cube's. */
export function ownerOf(scratch: string): string | null {
  try { return fs.readFileSync(path.join(scratch, OWNER_FILE), "utf8").trim() || null; } catch { return null; }
}

/** `ok` is false when cleanup leaves something of this run in place. */
export type CleanupPlan = { stop: boolean; removeScratch: boolean; removeInstance: boolean; ok: boolean; notes: string[] };

/** What a cleanup may do. It stops only a live `serve` of this run, deletes
 * scratch only when its owner file names this run's token (or, with no
 * instance file, when it has an owner file at all), and deletes nothing
 * while a process it cannot identify may still use it. */
export function planCleanup(input: { instance: { pid: number; runArg: string; owner: string } | null; scratchOwner: string | null; scratchExists: boolean },
  sys: System): CleanupPlan {
  const notes: string[] = [];
  let stop = false;
  let blocked = false;
  const { instance } = input;
  if (instance && sys.alive(instance.pid)) {
    const command = sys.command(instance.pid);
    if (command === null) {
      blocked = true;
      notes.push(`pid ${instance.pid} is alive and its command cannot be read: not stopped, nothing deleted; stop it yourself, then clean up again`);
    } else if (isServeOf(command, instance.runArg)) {
      stop = true;
    } else {
      notes.push(`pid ${instance.pid} is now another process (${command}): left alone`);
    }
  }
  const expected = instance?.owner ?? null;
  let removeScratch = false;
  let leftAlone = false;
  if (input.scratchExists && !blocked) {
    if (input.scratchOwner === null) notes.push("scratch has no verify-cube owner file: left alone");
    else if (expected !== null && input.scratchOwner !== expected) notes.push("scratch belongs to another verify-cube launch: left alone");
    else removeScratch = true;
    leftAlone = !removeScratch;
  }
  return { stop, removeScratch, removeInstance: instance !== null && !blocked, ok: !blocked && !leftAlone, notes };
}

/** `<base>/<name>`, or `<name>-2`, `<name>-3`, … when taken: a drive never overwrites evidence. */
export function freshDirectory(base: string, name: string): string {
  fs.mkdirSync(base, { recursive: true });
  for (let n = 1; ; n++) {
    const directory = path.join(base, n === 1 ? name : `${name}-${n}`);
    try { fs.mkdirSync(directory); return directory; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
}

/** A listen port: an integer from `min` through 65535, written as one. */
export function parsePort(raw: string, min: number): number {
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(port) || port < min || port > 65535) throw new Error(`--port must be an integer from ${min} through 65535, not ${JSON.stringify(raw)}`);
  return port;
}
