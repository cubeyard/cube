/** Pi's existing shell operations, routed through the control plane. This
 * module has no local exec, filesystem, iroh key or caller-selected destination. */
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SandboxExecOptions } from "@cube/sandbox";

type Request = (body: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>;
const fail = (code: string, operationId?: string, completionUnknown = false) => Object.assign(
  new Error(`${code}${operationId ? `: operation ${operationId}` : ""}${completionUnknown ? "; remote work was not cancelled; inspect with cube.operations.get before executing again" : ""}`),
  { code, operationId, completionUnknown },
);
export const unsupportedHostFiles = async (): Promise<never> => { throw fail("OPERATION_UNSUPPORTED"); };
export class HostExecSandbox {
  readonly name = "trusted-host";
  private readonly request: Request;
  constructor(request: Request) { this.request = request; }
  async status(signal?: AbortSignal): Promise<void> {
    const result = await this.read({ action: "status" }, signal);
    if (result.status !== "Running" || !Number.isSafeInteger(result.observedAt)) throw fail("NODE_UNAVAILABLE");
  }
  private async read(body: Record<string, unknown>, signal?: AbortSignal) {
    try { return await this.request(body, signal); }
    catch (error) {
      // These POSTs are read-only (prepare only writes an undispatched intent).
      if ((error as { completionUnknown?: boolean })?.completionUnknown) throw fail("NODE_UNAVAILABLE");
      throw error;
    }
  }
  async operation(operationId: string, signal?: AbortSignal) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(operationId)) throw fail("INVALID_REQUEST");
    return this.read({ action: "operation", operationId }, signal);
  }
  async exec(command: string, options: SandboxExecOptions): Promise<{ exitCode: number | null; operationId: string }> {
    options.signal?.throwIfAborted();
    const cwd = path.posix.resolve("/workspace", options.cwd);
    if (cwd !== "/workspace" && !cwd.startsWith("/workspace/")) throw fail("OPERATION_UNSUPPORTED");
    const timeoutMs = options.timeout ? Math.round(options.timeout * 1000) : 60000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw fail("INVALID_REQUEST");
    const spec = { command, guestCwd: path.posix.relative("/workspace", cwd) || ".", timeoutMs, outputLimit: 8192 };
    const prepared = await this.read({ action: "prepare", spec }, options.signal);
    const operationId = prepared.operationId;
    if (typeof operationId !== "string" || !/^op-[a-zA-Z0-9_-]{1,125}$/.test(operationId)) throw fail("NODE_UNAVAILABLE");
    // From here onward every failure contains the previously saved identity.
    if (options.signal?.aborted) throw fail("ABORT_ERR", operationId);
    try {
      const accepted = await this.request({ action: "submit", operationId }, options.signal);
      if (accepted.operationId !== operationId) throw fail("COMPLETION_UNKNOWN", operationId, true);
    } catch (error) {
      const fields = error as { code?: string; completionUnknown?: boolean };
      if (fields.code && !fields.completionUnknown) throw fail(fields.code, operationId);
      throw fail("COMPLETION_UNKNOWN", operationId, true);
    }
    const deadline = AbortSignal.timeout(timeoutMs + 10000);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    let state: Record<string, unknown>;
    try {
      for (;;) {
        state = await this.operation(operationId, signal);
        if (state.state !== "Accepted" && state.state !== "Running") break;
        await delay(100, undefined, { signal }); // read-only polling; never submit again
      }
    } catch { throw fail("COMPLETION_UNKNOWN", operationId, true); }
    if (state.state === "Failed") throw fail(String(state.error), operationId, state.completionUnknown === true);
    if (state.state !== "Succeeded") throw fail("COMPLETION_UNKNOWN", operationId, true);
    const result = state.result as { output: number[]; truncated: boolean; termination: string; exitCode: number | null } | undefined;
    if (!result || !Array.isArray(result.output) || result.output.length > 8192
      || result.output.some(n => !Number.isInteger(n) || n < 0 || n > 255)
      || !(result.exitCode === null || Number.isInteger(result.exitCode))
      || typeof result.truncated !== "boolean" || !["exited", "signalled", "timedOut"].includes(result.termination)) throw fail("COMPLETION_UNKNOWN", operationId, true);
    options.onData(Buffer.from(result.output));
    if (result.truncated) options.onData(Buffer.from("\n[host: output truncated at 8192 bytes; redirect large output to a workspace file]\n"));
    if (result.termination === "timedOut") throw fail("ETIMEDOUT", operationId);
    if (result.termination === "signalled") throw fail("ESIGNALLED", operationId);
    return { exitCode: result.exitCode, operationId };
  }
}
