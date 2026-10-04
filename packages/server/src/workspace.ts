/** One contract for a thread's workspace, end to end: thread VM -> cubed ->
 * agents. In-process agents call `Workspace` directly; the HTTP routes are
 * only a transport over the same interface and `HttpWorkspace` implements it
 * again for out-of-process agents. `VmWorkspace` (vm-workspace.ts) is the
 * one implementation over a thread's machine.
 *
 * Workspace semantics live in the guest helper inside the VM. cubed
 * translates, checks capabilities and limits, and enforces the lease; it has
 * no file logic. */
import { setTimeout as delay } from "node:timers/promises";
import type { NodeErrorCode } from "./execution-node-contract.ts";
import type { ThreadAgent } from "./thread-events.ts";

/** The lease owner is the thread's agent. */
export type WorkspaceOwner = ThreadAgent;
export const WORKSPACE_OWNERS: readonly WorkspaceOwner[] = ["pi", "claude-code"];
/** Every operation the contract needs. A guest lacking one is incompatible. */
export const WORKSPACE_CAPABILITIES = ["exec.start", "exec.cancel", "operation.get", "fs.read", "fs.write", "fs.stat"] as const;
export type WorkspaceErrorCode = NodeErrorCode | "LEASE_HELD";
/** Advertised by the guest helper's hello; every bound is enforced there. */
export interface WorkspaceLimits {
  maxFrameBytes: number;
  requestTimeoutMs: number;
  maxCommandBytes: number;
  maxPathBytes: number;
  maxExecTimeoutMs: number;
  maxOutputBytes: number;
  outputPageBytes: number;
  maxReadBytes: number;
  maxWriteBytes: number;
}
export const WORKSPACE_LIMIT_KEYS = ["maxFrameBytes", "requestTimeoutMs", "maxCommandBytes", "maxPathBytes", "maxExecTimeoutMs",
  "maxOutputBytes", "outputPageBytes", "maxReadBytes", "maxWriteBytes"] as const;

export interface WorkspaceLease { token: string; owner: WorkspaceOwner; epoch: number; expiresAt: number | null }
export interface WorkspaceLeaseRequest {
  owner: WorkspaceOwner;
  /** Remote holders heartbeat within this; in-process holders omit it. */
  ttlMs?: number;
}
export interface WorkspaceExecSpec { command: string; cwd?: string; timeoutMs: number; outputLimit?: number }
export type WorkspaceOperation =
  | { key: string; state: "running" }
  | { key: string; state: "succeeded"; exitCode: number | null; termination: "exited" | "signalled" | "timedOut";
    /** One page of retained output starting at outputOffset. */
    output: Uint8Array; outputOffset: number; retainedBytes: number; outputBytes: number; truncated: boolean }
  | { key: string; state: "written"; sha256: string; size: number }
  | { key: string; state: "failed"; error: WorkspaceErrorCode; completionUnknown: boolean }
  | { key: string; state: "interrupted"; completionUnknown: true };
export interface WorkspaceFile { content: Uint8Array; offset: number; size: number; eof: boolean; sha256: string | null }
export interface WorkspaceWriteResult { sha256: string; size: number }
export interface WorkspaceStat { kind: "file" | "directory" | "symlink" | "other"; size: number; mode: number; modifiedMs: number; sha256: string | null }
export interface WorkspaceWrite { expectedSha?: string; createParents?: boolean }
export interface WorkspaceOperationOptions { cursor?: number; waitMs?: number; signal?: AbortSignal }

/** Every lease-scoped call takes the lease token; mutations also carry a
 * caller-chosen idempotency key. A key already seen is never executed again;
 * the same key with a different request is CONFLICT. */
export interface Workspace {
  /** Acquire, or renew when `token` is given. Holding is exclusive. */
  lease(request: WorkspaceLeaseRequest | { token: string }): Promise<WorkspaceLease>;
  release(token: string): Promise<void>;
  capabilities(): Promise<string[]>;
  limits(): Promise<WorkspaceLimits>;
  /** Start under `key` and return the current state; poll `operation`. */
  exec(token: string, key: string, spec: WorkspaceExecSpec): Promise<WorkspaceOperation>;
  /** `waitMs` holds a running operation up to that long (a long poll);
   * `signal` ends the wait early. */
  operation(token: string, key: string, options?: WorkspaceOperationOptions): Promise<WorkspaceOperation>;
  /** Real cancellation of a running command; poll for the final state. */
  cancel(token: string, key: string): Promise<WorkspaceOperation>;
  readFile(token: string, file: string, options?: { offset?: number; limit?: number }): Promise<WorkspaceFile>;
  writeFile(token: string, key: string, file: string, content: Uint8Array, options?: WorkspaceWrite): Promise<WorkspaceWriteResult>;
  stat(token: string, file: string): Promise<WorkspaceStat>;
}

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;
  readonly completionUnknown: boolean;
  constructor(code: WorkspaceErrorCode, message?: string, options?: { cause?: unknown; completionUnknown?: boolean }) {
    super(message ?? code, { cause: options?.cause });
    this.name = "WorkspaceError";
    this.code = code;
    this.completionUnknown = options?.completionUnknown ?? code === "COMPLETION_UNKNOWN";
  }
}

const KEY = /^[\x21-\x7e]{1,512}$/;
const SETTLE_WAIT_MS = 10000;
export function validKey(key: unknown): key is string { return typeof key === "string" && KEY.test(key); }

/** Wait for a terminal state and return it with the complete output. */
export async function settleOperation(workspace: Workspace, token: string, key: string, options: { signal?: AbortSignal; intervalMs?: number } = {}): Promise<Exclude<WorkspaceOperation, { state: "running" }>> {
  for (;;) {
    options.signal?.throwIfAborted();
    // A long poll: an implementation that cannot wait answers at once and
    // the loop sleeps instead.
    const state = await workspace.operation(token, key, { waitMs: SETTLE_WAIT_MS, ...(options.signal ? { signal: options.signal } : {}) });
    if (state.state === "running") { await delay(options.intervalMs ?? 100, undefined, { signal: options.signal }); continue; }
    if (state.state !== "succeeded") return state;
    const pages = [state.output];
    let received = state.output.length;
    while (state.outputOffset + received < state.retainedBytes) {
      const page = await workspace.operation(token, key, { cursor: state.outputOffset + received });
      if (page.state !== "succeeded" || page.outputOffset !== state.outputOffset + received || !page.output.length) {
        throw new WorkspaceError("IO_ERROR", "operation output changed while paging");
      }
      pages.push(page.output);
      received += page.output.length;
    }
    return { ...state, output: Buffer.concat(pages) };
  }
}

export function invalid(message: string): WorkspaceError { return new WorkspaceError("INVALID_REQUEST", message); }
export function filePath(file: unknown, limits: WorkspaceLimits): string {
  if (typeof file !== "string" || !file || file.includes("\0") || file.startsWith("/") || Buffer.byteLength(file) > limits.maxPathBytes
    || file.split("/").includes("..")) {
    throw invalid("path must be relative to the workspace");
  }
  return file;
}
/** Validates a command against the limits; returns it with every default filled in. */
export function execSpec(spec: WorkspaceExecSpec, limits: WorkspaceLimits): Required<WorkspaceExecSpec> {
  if (!spec || typeof spec !== "object" || typeof spec.command !== "string" || !spec.command) throw invalid("command is required");
  if (Buffer.byteLength(spec.command) > limits.maxCommandBytes) throw invalid(`command is at most ${limits.maxCommandBytes} bytes`);
  if (spec.cwd !== undefined && spec.cwd !== ".") filePath(spec.cwd, limits);
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > limits.maxExecTimeoutMs) {
    throw invalid(`timeout is 1-${limits.maxExecTimeoutMs} ms`);
  }
  const outputLimit = spec.outputLimit ?? limits.maxOutputBytes;
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 0 || outputLimit > limits.maxOutputBytes) {
    throw invalid(`output limit is at most ${limits.maxOutputBytes} bytes`);
  }
  return { command: spec.command, cwd: spec.cwd ?? ".", timeoutMs: spec.timeoutMs, outputLimit };
}

/** The guest helper's operation states, protocol 2's vocabulary. */
export type GuestOperationState =
  | { state: "Accepted" | "Running" | "Unknown" }
  | { state: "Succeeded"; result: { exitCode: number | null; termination: "exited" | "signalled" | "timedOut"; outputBytes: number;
    truncated: boolean; outputOffset: number; retainedBytes: number }; output: Uint8Array }
  | { state: "Written"; result: WorkspaceWriteResult }
  | { state: "Failed"; error: string; completionUnknown: boolean }
  | { state: "Interrupted"; completionUnknown: true };

/** A guest operation state in the Workspace vocabulary. */
export function operation(key: string, state: GuestOperationState): WorkspaceOperation {
  switch (state.state) {
    case "Accepted": case "Running": return { key, state: "running" };
    case "Unknown": throw new WorkspaceError("NOT_FOUND", "no operation has this key");
    case "Interrupted": return { key, state: "interrupted", completionUnknown: true };
    case "Written": return { key, state: "written", ...state.result };
    case "Failed": return { key, state: "failed", error: errorCode(state.error, state.completionUnknown), completionUnknown: state.completionUnknown };
    case "Succeeded": return { key, state: "succeeded", ...state.result, output: Buffer.from(state.output) };
  }
}
/** Wire codes in the shared NodeErrorCode vocabulary. */
export function errorCode(remote: string, completionUnknown = false): WorkspaceErrorCode {
  return completionUnknown || remote === "OUTCOME_UNKNOWN" ? "COMPLETION_UNKNOWN"
    : remote === "UNSUPPORTED" || remote === "ENVIRONMENT_STOPPED" ? "OPERATION_UNSUPPORTED"
    : remote === "UNAUTHORIZED" ? "WRONG_NODE"
    : remote as WorkspaceErrorCode;
}
