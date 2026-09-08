/**
 * Guest filesystem access for the cube extension. Every operation resolves
 * INSIDE the cube: commands run through the sandbox exec boundary (`su -
 * dev`, no env passthrough), file content moves over the Incus files API
 * (which resolves paths — including symlinks — in the instance's own
 * namespace), and stat/readdir/glob/grep run via a small helper script
 * pushed into the cube. Nothing here ever touches a host path: a workspace
 * symlink pointing at `/home/...` dereferences to the CUBE's filesystem,
 * not the credentialed host's.
 */
import fs from "node:fs";

import type { Sandbox } from "@cube/sandbox";

/** Content transfer into/out of the guest (Incus files API in production,
 * local fs in the offline tests). `pull` must NOT follow symlinks: it
 * reports them so CubeFs can resolve the target inside the guest, and it
 * must stop reading past `maxBytes` so a multi-gigabyte hostile file cannot
 * OOM the host before pi ever truncates it. */
export interface GuestFiles {
  push(guestPath: string, content: Buffer | string, opts?: { mode?: string; signal?: AbortSignal }): Promise<void>;
  pull(
    guestPath: string,
    opts?: { maxBytes?: number; signal?: AbortSignal },
  ): Promise<{ content: Buffer; type: "file" | "symlink" }>;
}

export interface GrepRequest {
  pattern: string;
  path: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

export interface GrepResult {
  lines: string[];
  matchCount: number;
  matchLimitReached: boolean;
  linesTruncated: boolean;
  /** The effective match limit the helper applied. */
  limit: number;
}

const HELPER_SOURCE = fs.readFileSync(new URL("./guest/fsops.mjs", import.meta.url), "utf8");
const SENTINEL_START = "<<<CUBE-FSOPS>>>";
const SENTINEL_END = "<<<CUBE-FSOPS-END>>>";

// A helper response is bounded by the op's own limits (grep caps matches and
// line length, readdir/glob a directory's real size). Anything past this is a
// runaway or hostile-noise dir — abort rather than buffer it into host memory.
const MAX_HELPER_OUTPUT = 32 * 1024 * 1024;
// exec argv is one kernel arg; well under ARG_MAX. Tool inputs (patterns,
// globs, one path) never approach this — a request that does is a bug/attack.
const MAX_REQUEST_BYTES = 64 * 1024;
// Helper ops are quick; a login profile or op that hangs past this is broken.
const HELPER_TIMEOUT_S = 60;
// Read ceiling: pi truncates display to ~50KB but reads the whole file for
// offset/image paths. Files past this must go through bash/grep, not a
// single host-buffered pull.
const MAX_READ_BYTES = 16 * 1024 * 1024;

export interface CubeFsOptions {
  /** Where the helper lives in the guest (dev-writable, survives sleep). */
  helperGuestPath?: string;
  /** Working directory for helper invocations (must exist in the guest). */
  guestCwd?: string;
  /** Awaited before every operation — wake-on-first-tool-use hook. */
  ensure?: (signal?: AbortSignal) => Promise<void>;
  /** Ceiling for a single file read (default MAX_READ_BYTES). */
  maxReadBytes?: number;
}

class OutputLimitError extends Error {}

export class CubeFs {
  private readonly exec: Sandbox;
  private readonly files: GuestFiles;
  private readonly helperPath: string;
  private readonly guestCwd: string;
  private readonly ensure: (signal?: AbortSignal) => Promise<void>;
  private readonly maxReadBytes: number;
  private helperInstalled = false;
  /** isDir answers batched from the last readdir, consumed once by the ls
   * tool's per-entry stat calls (avoids one exec round trip per entry). */
  private readonly pendingStats = new Map<string, boolean>();

  constructor(exec: Sandbox, files: GuestFiles, options: CubeFsOptions = {}) {
    this.exec = exec;
    this.files = files;
    this.helperPath = options.helperGuestPath ?? "/home/dev/.cube/fsops.mjs";
    this.guestCwd = options.guestCwd ?? "/";
    this.ensure = options.ensure ?? (async () => {});
    this.maxReadBytes = options.maxReadBytes ?? MAX_READ_BYTES;
  }

  /**
   * Run a guest command, accumulating stdout+stderr up to a byte ceiling.
   * Past the ceiling the exec is aborted and OutputLimitError thrown, so a
   * hostile command (e.g. `yes` in a login profile) cannot buffer unbounded
   * output into host memory. A hard timeout bounds hangs.
   */
  private async run(command: string, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string }> {
    const chunks: Buffer[] = [];
    let total = 0;
    let overflow = false;
    const limiter = new AbortController();
    const onAbort = () => limiter.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const { exitCode } = await this.exec.exec(command, {
        cwd: this.guestCwd,
        timeout: HELPER_TIMEOUT_S,
        signal: limiter.signal,
        onData: (chunk) => {
          if (overflow) return;
          total += chunk.length;
          if (total > MAX_HELPER_OUTPUT) {
            overflow = true;
            limiter.abort();
            return;
          }
          chunks.push(chunk);
        },
      });
      if (overflow) throw new OutputLimitError(`guest output exceeded ${MAX_HELPER_OUTPUT} bytes`);
      return { exitCode, output: Buffer.concat(chunks).toString("utf8") };
    } catch (err) {
      if (overflow) throw new OutputLimitError(`guest output exceeded ${MAX_HELPER_OUTPUT} bytes`);
      throw err;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async installHelper(signal?: AbortSignal): Promise<void> {
    const dir = this.helperPath.slice(0, this.helperPath.lastIndexOf("/")) || "/";
    await this.run(`mkdir -p ${shQuote(dir)}`, signal);
    await this.files.push(this.helperPath, HELPER_SOURCE, { signal });
    this.helperInstalled = true;
  }

  /** Extract the LAST well-formed sentinel-wrapped payload. Scanning from
   * the end defeats a login profile that prints a spoofed START before the
   * real response. Returns null when no complete pair is present. */
  private static extract(output: string): string | null {
    const end = output.lastIndexOf(SENTINEL_END);
    if (end < 0) return null;
    const start = output.lastIndexOf(SENTINEL_START, end);
    if (start < 0) return null;
    return output.slice(start + SENTINEL_START.length, end);
  }

  /** One helper round trip (ops are all idempotent, so the self-heal retry
   * is safe). ANY unusable response — missing/garbled sentinel, invalid
   * JSON, a lost helper on a fresh cube — triggers exactly one re-push and
   * retry before failing. */
  private async runHelper<T>(request: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    await this.ensure(signal);
    const encoded = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
    if (encoded.length > MAX_REQUEST_BYTES) {
      throw new Error(`cube fs request too large (${encoded.length} bytes) — narrow the pattern or path`);
    }
    const command = `node ${shQuote(this.helperPath)} ${shQuote(encoded)}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (!this.helperInstalled) await this.installHelper(signal);
      let payload: string | null = null;
      try {
        payload = CubeFs.extract((await this.run(command, signal)).output);
      } catch (err) {
        if (err instanceof OutputLimitError) throw err; // not a helper fault
        // exec/transport error — fall through to a re-push + retry
      }
      if (payload !== null) {
        let parsed: T | { error: string };
        try {
          parsed = JSON.parse(payload);
        } catch {
          this.helperInstalled = false; // garbled — reinstall and retry once
          continue;
        }
        if (parsed && typeof parsed === "object" && "error" in parsed) {
          throw new Error(String((parsed as { error: string }).error));
        }
        return parsed as T;
      }
      this.helperInstalled = false; // no sentinel — reinstall and retry once
    }
    throw new Error(`cube fs helper produced no valid response for op ${String(request.op)}`);
  }

  /** Canonicalize inside the guest — symlinks dereference in the cube's
   * namespace, so a hostile workspace link can only reach cube files. Also
   * returns the target's existing mode (or null when it does not yet exist)
   * so a write preserves permissions. */
  async resolvePath(guestPath: string, signal?: AbortSignal): Promise<{ path: string; mode: string | null }> {
    return this.runHelper<{ path: string; mode: string | null }>({ op: "resolve", path: guestPath }, signal);
  }

  async readFile(guestPath: string, signal?: AbortSignal): Promise<Buffer> {
    await this.ensure(signal);
    const { content, type } = await this.files.pull(guestPath, { maxBytes: this.maxReadBytes, signal });
    if (type !== "symlink") return content;
    // Rare path: re-resolve in the guest, then pull the real file. realpath
    // fully flattens chains, so a second symlink answer means a broken fs.
    const { path: real } = await this.resolvePath(guestPath, signal);
    const second = await this.files.pull(real, { maxBytes: this.maxReadBytes, signal });
    if (second.type === "symlink") throw new Error(`unresolvable symlink: ${guestPath}`);
    return second.content;
  }

  async writeFile(guestPath: string, content: string, signal?: AbortSignal): Promise<void> {
    // Writing through a symlink must land on its in-guest target — the files
    // API would otherwise clobber the link itself — and must keep the
    // target's existing mode (e.g. an executable script's +x).
    const { path: real, mode } = await this.resolvePath(guestPath, signal);
    await this.files.push(real, content, { ...(mode ? { mode } : {}), signal });
  }

  async access(guestPath: string, opts: { write?: boolean } = {}): Promise<void> {
    await this.runHelper<Record<string, never>>({ op: "access", path: guestPath, write: opts.write ?? false });
  }

  async statOrNull(guestPath: string): Promise<{ isDir: boolean } | null> {
    const pending = this.pendingStats.get(guestPath);
    if (pending !== undefined) {
      this.pendingStats.delete(guestPath);
      return { isDir: pending };
    }
    const result = await this.runHelper<{ exists: boolean; isDir: boolean }>({ op: "stat", path: guestPath });
    return result.exists ? { isDir: result.isDir } : null;
  }

  /** Lists entry names; batches each entry's isDir for the stat calls the
   * ls tool makes right after. Only the most recent listing is cached (the
   * batch is a one-shot for the immediately-following stats), so the map
   * cannot grow unbounded or answer a later call from a stale listing. */
  async readdir(guestPath: string): Promise<string[]> {
    const { entries } = await this.runHelper<{ entries: Array<{ name: string; isDir: boolean }> }>({
      op: "readdir",
      path: guestPath,
    });
    this.pendingStats.clear();
    const base = guestPath.endsWith("/") ? guestPath.slice(0, -1) : guestPath;
    for (const entry of entries) this.pendingStats.set(`${base}/${entry.name}`, entry.isDir);
    return entries.map((e) => e.name);
  }

  async mkdir(guestPath: string): Promise<void> {
    await this.runHelper<Record<string, never>>({ op: "mkdir", path: guestPath });
  }

  async glob(pattern: string, guestCwd: string, limit: number): Promise<string[]> {
    const { paths } = await this.runHelper<{ paths: string[] }>({ op: "glob", pattern, cwd: guestCwd, limit });
    return paths;
  }

  async grep(request: GrepRequest, signal?: AbortSignal): Promise<GrepResult> {
    return this.runHelper<GrepResult>({ op: "grep", ...request }, signal);
  }
}

export function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}
