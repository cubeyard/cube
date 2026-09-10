import fs from "node:fs";
import path from "node:path";
import type { Sandbox } from "@cube/sandbox";

export type LifecyclePhase = "setup" | "resume";
export interface LifecycleResult {
  state: "running" | "succeeded" | "failed";
  startedAt: number;
  durationMs: number | null;
  error: string | null;
  cached?: boolean;
}

/** Host-owned, bounded diagnostics. Never put these beside agent-writable
 * files: even a log filename could otherwise redirect a host write. */
export class Lifecycle {
  private readonly root: string;
  constructor(root: string) { this.root = root; }

  read(name: string, phase: LifecyclePhase): LifecycleResult | null {
    try { return JSON.parse(fs.readFileSync(path.join(this.root, name, `${phase}.json`), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }

  log(name: string, phase: LifecyclePhase): string {
    const file = path.join(this.root, name, `${phase}.log`);
    const read = (name: string): Buffer => {
      try { return fs.readFileSync(name); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return Buffer.alloc(0); throw error; }
    };
    return Buffer.concat([read(`${file}.head`), read(file)]).toString("utf8");
  }

  save(name: string, phase: LifecyclePhase, result: LifecycleResult): void {
    const dir = path.join(this.root, name);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${phase}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(result), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }

  forget(name: string): void { fs.rmSync(path.join(this.root, name), { recursive: true, force: true }); }

  adopt(name: string, directory: string): void {
    const result = JSON.parse(fs.readFileSync(path.join(directory, "setup.json"), "utf8")) as LifecycleResult;
    this.save(name, "setup", { ...result, cached: true });
    fs.rmSync(path.join(this.root, name, "setup.log.head"), { force: true });
    fs.copyFileSync(path.join(directory, "setup.log"), path.join(this.root, name, "setup.log"));
  }

  /** `signal` cancels the guest script (the thread is being deleted under
   * it); the result then records the cancellation, not a script failure. */
  async run(name: string, sandbox: Sandbox, phase: LifecyclePhase, signal?: AbortSignal): Promise<string | null> {
    const startedAt = Date.now();
    this.save(name, phase, { state: "running", startedAt, durationMs: null, error: null });
    const file = path.join(this.root, name, `${phase}.log`);
    // Keep the immediately previous attempt, not an unbounded log history.
    if (fs.existsSync(file)) fs.writeFileSync(`${file}.previous`, this.log(name, phase), { mode: 0o600 });
    fs.rmSync(`${file}.head`, { force: true });
    fs.writeFileSync(file, "", { mode: 0o600 });
    // Two rotating half-megabyte segments retain the actual output tail,
    // with bounded disk and O(output) writes even for a noisy guest.
    const segmentBytes = 512 * 1024;
    let segmentUsed = 0;
    const append = (chunk: Buffer) => {
      for (let offset = 0; offset < chunk.length;) {
        if (segmentUsed === segmentBytes) {
          fs.renameSync(file, `${file}.head`);
          fs.writeFileSync(file, "", { mode: 0o600 });
          segmentUsed = 0;
        }
        const part = chunk.subarray(offset, offset + segmentBytes - segmentUsed);
        fs.appendFileSync(file, part);
        offset += part.length;
        segmentUsed += part.length;
      }
    };
    append(Buffer.from(`${phase} started ${new Date(startedAt).toISOString()}\n`));
    let bytes = 0;
    let tail = "";
    let error: string | null = null;
    let loggingError: Error | undefined;
    const abort = new AbortController();
    try {
      // Check executable/presence INSIDE the guest. Host-side access checks
      // would follow an agent-controlled .cube symlink on the host.
      const { exitCode } = await sandbox.exec(
        `if [ -e .cube/${phase} ]; then [ -x .cube/${phase} ] || { echo '.cube/${phase} must be executable'; exit 126; }; ./.cube/${phase}; fi`,
        {
          cwd: "/workspace", timeout: phase === "setup" ? 1200 : 10,
          signal: signal ? AbortSignal.any([abort.signal, signal]) : abort.signal,
          onData: (chunk) => {
            if (loggingError) return;
            tail = (tail + chunk.toString("utf8")).slice(-4096);
            try {
              append(chunk);
              bytes += chunk.length;
            } catch (cause) {
              // Output arrives on a WebSocket event stack, outside the await
              // below. Never let a host disk error escape that event listener.
              loggingError = new Error(`lifecycle log write failed: ${String(cause)}`);
              abort.abort(loggingError);
            }
          },
        },
      );
      if (exitCode !== 0) error = `.cube/${phase} failed (exit ${exitCode}): ${tail.slice(-500).trim()}`;
    } catch (cause) { error = `.cube/${phase} failed: ${String(cause)} — ${tail.slice(-500).trim()}`; }
    if (loggingError) error = `.cube/${phase} failed: ${loggingError.message}`;
    else if (signal?.aborted) error = `.cube/${phase} cancelled: ${String(signal.reason instanceof Error ? signal.reason.message : signal.reason)}`;
    const durationMs = Date.now() - startedAt;
    if (!loggingError) append(Buffer.from(`\n${bytes >= 1024 * 1024 ? '[output truncated; tail retained]\n' : ''}${phase} ${error ? "failed" : "succeeded"} in ${durationMs}ms\n`));
    this.save(name, phase, { state: error ? "failed" : "succeeded", startedAt, durationMs, error });
    return error;
  }
}
