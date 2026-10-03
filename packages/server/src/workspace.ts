/** One contract for a thread's workspace, end to end: runner -> cubed ->
 * agents. In-process agents call `Workspace` directly; the HTTP routes are
 * only a transport over the same interface and `HttpWorkspace` implements it
 * again for out-of-process agents.
 *
 * Workspace semantics live on the runner. cubed translates, checks
 * capabilities and limits, and enforces the lease; it has no file logic.
 * Runners are trusted, not sandboxes. */
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutionNodeError, type NodeErrorCode } from "./execution-node-contract.ts";
import type { NodeBinding, RunnerDescription, RunnerExecSpec, RunnerFile, RunnerFileStat, RunnerLimits, RunnerOperation, RunnerWriteResult } from "./iroh-node.ts";
import type { ThreadAgent } from "./thread-events.ts";
import type { LeaseStore } from "./workspace-lease.ts";

/** The lease owner is the thread's agent. */
export type WorkspaceOwner = ThreadAgent;
export const WORKSPACE_OWNERS: readonly WorkspaceOwner[] = ["pi", "claude-code"];
/** Every operation the contract needs. A runner lacking one is incompatible. */
export const WORKSPACE_CAPABILITIES = ["exec.start", "exec.cancel", "operation.get", "fs.read", "fs.write", "fs.stat"] as const;
export type WorkspaceErrorCode = NodeErrorCode | "LEASE_HELD";
export type WorkspaceLimits = RunnerLimits;

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
export type WorkspaceFile = Omit<RunnerFile, "content"> & { content: Uint8Array };
export type WorkspaceWriteResult = RunnerWriteResult;
export type WorkspaceStat = RunnerFileStat;
export interface WorkspaceWrite { expectedSha?: string; createParents?: boolean }

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
  operation(token: string, key: string, options?: { cursor?: number }): Promise<WorkspaceOperation>;
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
export function validKey(key: unknown): key is string { return typeof key === "string" && KEY.test(key); }

/** Wait for a terminal state and return it with the complete output. */
export async function settleOperation(workspace: Workspace, token: string, key: string, options: { signal?: AbortSignal; intervalMs?: number } = {}): Promise<Exclude<WorkspaceOperation, { state: "running" }>> {
  for (;;) {
    options.signal?.throwIfAborted();
    const state = await workspace.operation(token, key);
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

/** The runner client surface RunnerWorkspace needs. */
export interface WorkspaceRunner {
  readonly binding: Readonly<NodeBinding>;
  describe(signal?: AbortSignal): Promise<RunnerDescription>;
  startOperation(operationId: string, spec: RunnerExecSpec, options?: { epoch?: number }): Promise<void>;
  inspectOperation(operationId: string, options?: { cursor?: number }): Promise<RunnerOperation>;
  cancelOperation(operationId: string, options?: { epoch?: number }): Promise<RunnerOperation>;
  readFile(file: string, options?: { offset?: number; limit?: number }): Promise<RunnerFile>;
  writeFile(file: string, content: Uint8Array, options: { idempotencyKey: string; expectedSha?: string; createParents?: boolean; epoch?: number }): Promise<RunnerWriteResult>;
  stat(file: string): Promise<RunnerFileStat>;
}

/** The in-process Workspace over the thread's runner. */
export class RunnerWorkspace implements Workspace {
  readonly owner: WorkspaceOwner;
  private readonly runner: WorkspaceRunner;
  private readonly leases: LeaseStore;
  private description: Promise<RunnerDescription> | undefined;

  constructor(options: { runner: WorkspaceRunner; leases: LeaseStore; owner: WorkspaceOwner }) {
    this.runner = options.runner; this.leases = options.leases; this.owner = options.owner;
  }

  async lease(request: WorkspaceLeaseRequest | { token: string }): Promise<WorkspaceLease> {
    if ("token" in request) return this.leases.renew(request.token);
    if (!WORKSPACE_OWNERS.includes(request.owner)) throw new WorkspaceError("INVALID_REQUEST", "unknown workspace owner");
    // The agent is chosen at thread creation and is fixed for the thread.
    if (request.owner !== this.owner) throw new WorkspaceError("CONFLICT", `thread workspace belongs to ${this.owner}`);
    return this.leases.acquire(request.owner, request.ttlMs);
  }
  async release(token: string): Promise<void> { this.leases.release(token); }
  async capabilities(): Promise<string[]> { return [...(await this.describe()).capabilities]; }
  async limits(): Promise<WorkspaceLimits> { return { ...(await this.describe()).limits }; }

  async exec(token: string, key: string, spec: WorkspaceExecSpec): Promise<WorkspaceOperation> {
    const { epoch } = this.leases.verify(token);
    const limits = await this.require("exec.start");
    const runnerSpec = execSpec(spec, limits);
    const id = this.operationId(key);
    await translate(() => this.runner.startOperation(id, runnerSpec, { epoch }));
    return this.inspect(key, id);
  }
  async operation(token: string, key: string, options: { cursor?: number } = {}): Promise<WorkspaceOperation> {
    this.leases.verify(token);
    await this.require("operation.get");
    if (!(options.cursor === undefined || (Number.isSafeInteger(options.cursor) && options.cursor >= 0))) throw invalid("invalid output cursor");
    return this.inspect(key, this.operationId(key), options.cursor);
  }
  async cancel(token: string, key: string): Promise<WorkspaceOperation> {
    const { epoch } = this.leases.verify(token);
    await this.require("exec.cancel");
    const id = this.operationId(key);
    return operation(key, await translate(() => this.runner.cancelOperation(id, { epoch })));
  }
  async readFile(token: string, file: string, options: { offset?: number; limit?: number } = {}): Promise<WorkspaceFile> {
    this.leases.verify(token);
    const limits = await this.require("fs.read");
    filePath(file, limits);
    if (options.limit !== undefined && options.limit > limits.maxReadBytes) throw invalid(`read limit is at most ${limits.maxReadBytes} bytes`);
    return translate(() => this.runner.readFile(file, options));
  }
  async writeFile(token: string, key: string, file: string, content: Uint8Array, options: WorkspaceWrite = {}): Promise<WorkspaceWriteResult> {
    const { epoch } = this.leases.verify(token);
    const limits = await this.require("fs.write");
    filePath(file, limits);
    if (!(content instanceof Uint8Array)) throw invalid("file content must be bytes");
    if (content.length > limits.maxWriteBytes) throw invalid(`file content is at most ${limits.maxWriteBytes} bytes`);
    const idempotencyKey = this.operationId(key);
    return translate(() => this.runner.writeFile(file, content, { idempotencyKey, epoch,
      ...(options.expectedSha === undefined ? {} : { expectedSha: options.expectedSha }),
      ...(options.createParents === undefined ? {} : { createParents: options.createParents }) }));
  }
  async stat(token: string, file: string): Promise<WorkspaceStat> {
    this.leases.verify(token);
    filePath(file, await this.require("fs.stat"));
    return translate(() => this.runner.stat(file));
  }

  private describe(): Promise<RunnerDescription> {
    this.description ??= translate(() => this.runner.describe()).catch(error => { this.description = undefined; throw error; });
    return this.description;
  }
  private async require(capability: typeof WORKSPACE_CAPABILITIES[number]): Promise<WorkspaceLimits> {
    const description = await this.describe();
    if (!description.capabilities.includes(capability)) {
      throw new WorkspaceError("OPERATION_UNSUPPORTED", `runner lacks ${capability}; upgrade cube-runner`);
    }
    return description.limits;
  }
  /** Keys are scoped to the thread binding: runner journals outlive threads. */
  private operationId(key: string): string {
    if (!validKey(key)) throw invalid("invalid idempotency key");
    return `ws-${createHash("sha256").update(JSON.stringify([this.runner.binding, key])).digest("hex")}`;
  }
  private async inspect(key: string, id: string, cursor?: number): Promise<WorkspaceOperation> {
    return operation(key, await translate(() => this.runner.inspectOperation(id, cursor ? { cursor } : {})));
  }
}

function invalid(message: string): WorkspaceError { return new WorkspaceError("INVALID_REQUEST", message); }
function filePath(file: unknown, limits: WorkspaceLimits): void {
  if (typeof file !== "string" || !file || file.includes("\0") || file.startsWith("/") || Buffer.byteLength(file) > limits.maxPathBytes) {
    throw invalid("path must be relative to the workspace");
  }
}
function execSpec(spec: WorkspaceExecSpec, limits: WorkspaceLimits): RunnerExecSpec {
  if (!spec || typeof spec !== "object" || typeof spec.command !== "string" || !spec.command) throw invalid("command is required");
  if (Buffer.byteLength(spec.command) > limits.maxCommandBytes) throw invalid(`command is at most ${limits.maxCommandBytes} bytes`);
  if (spec.cwd !== undefined) filePath(spec.cwd, limits);
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > limits.maxExecTimeoutMs) {
    throw invalid(`timeout is 1-${limits.maxExecTimeoutMs} ms`);
  }
  const outputLimit = spec.outputLimit ?? limits.maxOutputBytes;
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 0 || outputLimit > limits.maxOutputBytes) {
    throw invalid(`output limit is at most ${limits.maxOutputBytes} bytes`);
  }
  return { command: spec.command, guestCwd: spec.cwd ?? ".", timeoutMs: spec.timeoutMs, outputLimit };
}
function operation(key: string, state: RunnerOperation): WorkspaceOperation {
  switch (state.state) {
    case "Accepted": case "Running": return { key, state: "running" };
    case "Unknown": throw new WorkspaceError("NOT_FOUND", "no operation has this key");
    case "Interrupted": return { key, state: "interrupted", completionUnknown: true };
    case "Written": return { key, state: "written", ...state.result };
    case "Failed": return { key, state: "failed", error: errorCode(state.error, state.completionUnknown), completionUnknown: state.completionUnknown };
    case "Succeeded": {
      const { output, ...result } = state.result;
      return { key, state: "succeeded", ...result, output: Buffer.from(output) };
    }
  }
}
/** Runner wire codes in the shared NodeErrorCode vocabulary, as IrohNodeError maps them. */
function errorCode(remote: string, completionUnknown = false): WorkspaceErrorCode {
  return completionUnknown || remote === "OUTCOME_UNKNOWN" ? "COMPLETION_UNKNOWN"
    : remote === "UNSUPPORTED" || remote === "ENVIRONMENT_STOPPED" ? "OPERATION_UNSUPPORTED"
    : remote === "UNAUTHORIZED" ? "WRONG_NODE"
    : remote as WorkspaceErrorCode;
}
async function translate<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (error instanceof WorkspaceError) throw error;
    if (error instanceof ExecutionNodeError) {
      throw new WorkspaceError(error.code, error.message, { cause: error, completionUnknown: error.completionUnknown });
    }
    throw error;
  }
}
