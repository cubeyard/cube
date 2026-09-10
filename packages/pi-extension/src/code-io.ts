/** Codemode's bounded I/O contract, independent of pi tool formatting. */
import type { ExecInput } from "./code-capabilities.ts";
import { encodeError } from "./code-errors.ts";

export const MAX_CODE_EXEC_OUTPUT = 1024 * 1024;
export type CodeExec = (command: string, cwd: string, options: {
  onData: (chunk: Buffer) => void;
  signal: AbortSignal;
}) => Promise<{ exitCode: number | null }>;

export async function execCode(exec: CodeExec, input: ExecInput, defaultCwd: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const started = performance.now();
  const limiter = new AbortController();
  const combined = AbortSignal.any([signal, limiter.signal]);
  const chunks: Buffer[] = [];
  let retained = 0;
  let observed = 0;
  let stopCode: "EOUTPUTLIMIT" | "ETIMEDOUT" | "ABORT_ERR" | undefined;
  const stop = (code: typeof stopCode) => {
    if (stopCode) return;
    stopCode = code;
    limiter.abort(new Error(code));
  };
  const onAbort = () => stop("ABORT_ERR");
  signal.addEventListener("abort", onAbort, { once: true });
  // Millisecond precision, including wake/setup. Backend cancellation still
  // waits for the process tree and trailing streams; that latency is reported.
  const timer = setTimeout(() => stop("ETIMEDOUT"), input.timeoutMs);
  let result: { exitCode: number | null } | undefined;
  let failure: unknown;
  try {
    result = await exec(input.command, input.cwd ?? defaultCwd, {
      signal: combined,
      onData: (chunk) => {
        if (stopCode === "EOUTPUTLIMIT") return;
        observed += chunk.length;
        const take = Math.min(chunk.length, MAX_CODE_EXEC_OUTPUT - retained);
        if (take > 0) { chunks.push(Buffer.from(chunk.subarray(0, take))); retained += take; }
        if (observed > MAX_CODE_EXEC_OUTPUT) stop("EOUTPUTLIMIT");
      },
    });
  } catch (error) { failure = error; }
  finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
  const elapsed = performance.now() - started;
  const durationMs = Math.round(elapsed);
  if (!stopCode && elapsed >= input.timeoutMs) stopCode = "ETIMEDOUT";
  const output = Buffer.concat(chunks).toString("utf8");
  if (stopCode || failure !== undefined) {
    const code = stopCode ?? "EEXEC";
    const message = code === "EOUTPUTLIMIT"
      ? `command output exceeded ${MAX_CODE_EXEC_OUTPUT} bytes; redirect large output to a workspace file`
      : code === "ETIMEDOUT"
        ? `command timed out after ${input.timeoutMs}ms (completed cancellation after ${durationMs}ms)`
        : code === "ABORT_ERR" ? `command aborted after ${durationMs}ms` : encodeError(failure).message;
    throw Object.assign(new Error(message), {
      code, operation: "exec", timeoutMs: input.timeoutMs, durationMs,
      output, outputBytes: retained, outputLimitBytes: MAX_CODE_EXEC_OUTPUT,
      truncated: observed > retained,
    });
  }
  return { exitCode: result!.exitCode, output, durationMs };
}

/** Normalize file-operation errors without hiding cancellation or inventing
 * an ENOENT for unrelated transport failures. Incus 404 can also mean that
 * the sandbox itself disappeared, so retain that distinction in the message. */
export async function codeFile<T>(operation: "fs.readText" | "fs.writeText", path: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    const data = encodeError(error);
    const status = error && typeof error === "object" && "errorCode" in error ? error.errorCode : undefined;
    const missing = status === 404 || data.code === "ENOENT" || /\bENOENT\b/.test(data.message);
    const code = missing ? "ENOENT" : data.code ?? "EFILE";
    const message = `${code}: ${operation} ${JSON.stringify(path)}: ${
      status === 404 ? "file, parent directory, or sandbox not found" : data.message
    }`;
    throw Object.assign(new Error(message), data, { code, operation, path, message });
  }
}
