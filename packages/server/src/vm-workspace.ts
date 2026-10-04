/** The thread Workspace over the guest helper in the thread's VM.
 *
 * Workspace semantics (journaled keys, epoch fencing, retained output, paths
 * beneath /workspace) live in the helper; this class checks limits, enforces
 * the lease and translates. Every helper operation is idempotent by its key
 * (or read-only), so a transport failure — a gateway restart, a dead SSH
 * master — is retried for a bounded time. When that runs out, a read is
 * NODE_UNAVAILABLE and a mutation's outcome is unknown (COMPLETION_UNKNOWN);
 * the key can be inspected again. */
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { GuestTransportError, type GuestAnswer, type GuestCallOptions, type GuestOp, type GuestTransport } from "./guest-ssh.ts";
import type { LeaseStore } from "./workspace-lease.ts";
import {
  WORKSPACE_CAPABILITIES, WORKSPACE_LIMIT_KEYS, WORKSPACE_OWNERS, WorkspaceError, errorCode, execSpec, filePath, invalid, operation, validKey,
  type GuestOperationState, type Workspace, type WorkspaceExecSpec, type WorkspaceFile, type WorkspaceLease,
  type WorkspaceLeaseRequest, type WorkspaceLimits, type WorkspaceOperation, type WorkspaceOperationOptions, type WorkspaceOwner,
  type WorkspaceStat, type WorkspaceWrite, type WorkspaceWriteResult,
} from "./workspace.ts";

/** The guest helper's own long poll bound. */
const MAX_GUEST_WAIT_MS = 20000;
/** How long transport failures are retried (a gateway restart takes seconds;
 * a dead SSH master is noticed within 30 s). */
const DEFAULT_RETRY_MS = 90000;
const SHA = /^[0-9a-f]{64}$/;
const STATES = new Set(["Accepted", "Running", "Unknown", "Succeeded", "Written", "Failed", "Interrupted"]);

export interface GuestDescription { version: string; ready: boolean; capabilities: string[]; limits: WorkspaceLimits; epoch: number }

/** The helper's hello, validated. */
export function guestDescription(header: Record<string, unknown>): GuestDescription {
  const limits = header.limits as Record<string, unknown> | undefined;
  if (typeof header.version !== "string" || typeof header.ready !== "boolean" || !Array.isArray(header.capabilities)
    || !header.capabilities.every(item => typeof item === "string") || !limits || typeof limits !== "object"
    || WORKSPACE_LIMIT_KEYS.some(key => !Number.isSafeInteger(limits[key]) || (limits[key] as number) < 1)
    || !Number.isSafeInteger(header.epoch)) {
    throw new GuestTransportError("the guest helper's hello is malformed");
  }
  return { version: header.version, ready: header.ready, capabilities: [...header.capabilities as string[]],
    limits: Object.fromEntries(WORKSPACE_LIMIT_KEYS.map(key => [key, limits[key]])) as unknown as WorkspaceLimits, epoch: header.epoch as number };
}

export class VmWorkspace implements Workspace {
  readonly owner: WorkspaceOwner;
  private readonly guest: GuestTransport;
  private readonly leases: LeaseStore;
  private readonly binding: string;
  private readonly retryMs: number;
  private description: Promise<GuestDescription> | undefined;

  /** `binding` scopes every key: it names the thread and its VM, whose
   * journal outlives any one cubed process. */
  constructor(options: { guest: GuestTransport; leases: LeaseStore; owner: WorkspaceOwner; binding: string; retryMs?: number }) {
    this.guest = options.guest; this.leases = options.leases; this.owner = options.owner; this.binding = options.binding;
    this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
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

  /** The agent's commands; each one marks the workspace as changed by the
   * agent, which keeps its disk at archive (see `agentChanged`). */
  async exec(token: string, key: string, spec: WorkspaceExecSpec): Promise<WorkspaceOperation> {
    return this.start(token, key, spec, true);
  }
  /** cubed's own commands (provisioning, the release check): they do not
   * count as the agent's changes. */
  async execOwn(token: string, key: string, spec: WorkspaceExecSpec): Promise<WorkspaceOperation> {
    return this.start(token, key, spec, false);
  }
  /** Whether the agent ever ran a command or wrote a file here, from cubed's
   * own records. The guest is agent-controlled (root via sudo), so its own
   * report can keep a disk but never alone justify deleting one. */
  agentChanged(): boolean { return this.leases.agentChanged(); }
  private async start(token: string, key: string, spec: WorkspaceExecSpec, agent: boolean): Promise<WorkspaceOperation> {
    const { epoch } = this.leases.verify(token);
    const limits = await this.require("exec.start");
    const checked = execSpec(spec, limits);
    const id = this.operationId(key);
    if (agent) this.leases.recordAgentChange();
    return operation(key, await this.state("exec", { id, epoch, ...checked }, true));
  }
  async operation(token: string, key: string, options: WorkspaceOperationOptions = {}): Promise<WorkspaceOperation> {
    this.leases.verify(token);
    await this.require("operation.get");
    if (!(options.cursor === undefined || (Number.isSafeInteger(options.cursor) && options.cursor >= 0))) throw invalid("invalid output cursor");
    const waitMs = Math.max(0, Math.min(options.waitMs ?? 0, MAX_GUEST_WAIT_MS));
    return operation(key, await this.state("get", { id: this.operationId(key), ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(waitMs ? { waitMs } : {}) }, false, options.signal));
  }
  async cancel(token: string, key: string): Promise<WorkspaceOperation> {
    const { epoch } = this.leases.verify(token);
    await this.require("exec.cancel");
    return operation(key, await this.state("cancel", { id: this.operationId(key), epoch }, true));
  }
  async readFile(token: string, file: string, options: { offset?: number; limit?: number } = {}): Promise<WorkspaceFile> {
    this.leases.verify(token);
    const limits = await this.require("fs.read");
    filePath(file, limits);
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > limits.maxReadBytes)) {
      throw invalid(`read limit is at most ${limits.maxReadBytes} bytes`);
    }
    if (options.offset !== undefined && (!Number.isSafeInteger(options.offset) || options.offset < 0)) throw invalid("invalid offset");
    const { header, body } = await this.call("read", { path: file, ...options }, false);
    if (!Number.isSafeInteger(header.size) || header.offset !== (options.offset ?? 0) || typeof header.eof !== "boolean"
      || header.length !== body.length || typeof header.sha256 !== "string" || !SHA.test(header.sha256)) throw malformed();
    return { content: body, offset: header.offset as number, size: header.size as number, eof: header.eof, sha256: header.sha256 };
  }
  async writeFile(token: string, key: string, file: string, content: Uint8Array, options: WorkspaceWrite = {}): Promise<WorkspaceWriteResult> {
    const { epoch } = this.leases.verify(token);
    const limits = await this.require("fs.write");
    filePath(file, limits);
    if (!(content instanceof Uint8Array)) throw invalid("file content must be bytes");
    if (content.length > limits.maxWriteBytes) throw invalid(`file content is at most ${limits.maxWriteBytes} bytes`);
    if (options.expectedSha !== undefined && (typeof options.expectedSha !== "string" || !SHA.test(options.expectedSha))) throw invalid("expectedSha must be a sha256");
    this.leases.recordAgentChange();
    const { header } = await this.call("write", { id: this.operationId(key), epoch, path: file,
      ...(options.expectedSha === undefined ? {} : { expectedSha: options.expectedSha }), createParents: options.createParents ?? false },
    true, undefined, content);
    if (typeof header.sha256 !== "string" || !SHA.test(header.sha256) || !Number.isSafeInteger(header.size)) throw malformed();
    return { sha256: header.sha256, size: header.size as number };
  }
  async stat(token: string, file: string): Promise<WorkspaceStat> {
    this.leases.verify(token);
    filePath(file, await this.require("fs.stat"));
    const { header } = await this.call("stat", { path: file }, false);
    if (!["file", "directory", "symlink", "other"].includes(String(header.kind)) || !Number.isSafeInteger(header.size)
      || !Number.isSafeInteger(header.mode) || !Number.isSafeInteger(header.modifiedMs)
      || !(header.sha256 === null || (typeof header.sha256 === "string" && SHA.test(header.sha256)))) throw malformed();
    return { kind: header.kind as WorkspaceStat["kind"], size: header.size as number, mode: header.mode as number,
      modifiedMs: header.modifiedMs as number, sha256: header.sha256 as string | null };
  }

  /** The helper's hello, once per workspace (again after a failure). */
  describe(): Promise<GuestDescription> {
    this.description ??= this.call("hello", {}, false).then(answer => guestDescription(answer.header))
      .catch(error => { this.description = undefined; throw error; });
    return this.description;
  }

  private async require(capability: typeof WORKSPACE_CAPABILITIES[number]): Promise<WorkspaceLimits> {
    const description = await this.describe();
    if (!description.capabilities.includes(capability)) {
      throw new WorkspaceError("OPERATION_UNSUPPORTED", `the thread machine's guest helper lacks ${capability}`);
    }
    return description.limits;
  }
  /** Keys are scoped to the thread and its VM. */
  private operationId(key: string): string {
    if (!validKey(key)) throw invalid("invalid idempotency key");
    return `ws-${createHash("sha256").update(JSON.stringify([this.binding, key])).digest("hex")}`;
  }
  private async call(op: GuestOp, header: Record<string, unknown>, mutation: boolean, signal?: AbortSignal, body?: Uint8Array): Promise<GuestAnswer> {
    let answer: GuestAnswer;
    const options: GuestCallOptions = { ...(signal ? { signal } : {}), ...(body ? { body } : {}),
      timeoutMs: 60000 + (typeof header.waitMs === "number" ? header.waitMs : 0) };
    const deadline = Date.now() + this.retryMs;
    for (let attempt = 0; ; attempt++) {
      try { answer = await this.guest.call(op, header, options); break; }
      catch (error) {
        if (!(error instanceof GuestTransportError)) throw error;
        if (signal?.aborted) throw signal.reason ?? error;
        const pause = Math.min(500 * 2 ** attempt, 5000);
        if (Date.now() + pause < deadline) { await delay(pause, undefined, signal ? { signal } : {}); continue; }
        throw new WorkspaceError(mutation ? "COMPLETION_UNKNOWN" : "NODE_UNAVAILABLE",
          `the thread machine did not answer: ${error.message}${mutation ? "; inspect the key before retrying" : ""}`, { cause: error, completionUnknown: mutation });
      }
    }
    // A helper error is an object; a Failed operation state names its code as a string.
    const failure = answer.header.error as { code?: unknown; message?: unknown } | string | undefined;
    if (failure !== undefined && typeof failure === "object") {
      const code = typeof failure?.code === "string" ? failure.code : "IO_ERROR";
      const message = typeof failure?.message === "string" && failure.message !== code ? `${code}: ${failure.message}` : code;
      throw new WorkspaceError(errorCode(code), message);
    }
    return answer;
  }
  private async state(op: GuestOp, header: Record<string, unknown>, mutation: boolean, signal?: AbortSignal): Promise<GuestOperationState> {
    const { header: answer, body } = await this.call(op, header, mutation, signal);
    if (!STATES.has(String(answer.state))) throw malformed();
    if (answer.state === "Succeeded") {
      const result = answer.result as Record<string, unknown> | undefined;
      if (!result || !(result.exitCode === null || (Number.isSafeInteger(result.exitCode) && (result.exitCode as number) >= 0 && (result.exitCode as number) <= 255))
        || !["exited", "signalled", "timedOut"].includes(String(result.termination))
        || !Number.isSafeInteger(result.retainedBytes) || !Number.isSafeInteger(result.outputOffset) || !Number.isSafeInteger(result.outputBytes)
        || typeof result.truncated !== "boolean" || result.outputLength !== body.length
        || (result.outputOffset as number) + body.length > (result.retainedBytes as number)) throw malformed();
      return { state: "Succeeded", output: body, result: { exitCode: result.exitCode as number | null,
        termination: result.termination as "exited" | "signalled" | "timedOut", outputBytes: result.outputBytes as number,
        truncated: result.truncated, outputOffset: result.outputOffset as number, retainedBytes: result.retainedBytes as number } };
    }
    if (answer.state === "Failed") {
      if (typeof answer.error !== "string" || typeof answer.completionUnknown !== "boolean") throw malformed();
      return { state: "Failed", error: answer.error, completionUnknown: answer.completionUnknown };
    }
    if (answer.state === "Written") {
      const result = answer.result as Record<string, unknown> | undefined;
      if (!result || typeof result.sha256 !== "string" || !Number.isSafeInteger(result.size)) throw malformed();
      return { state: "Written", result: { sha256: result.sha256, size: result.size as number } };
    }
    if (answer.state === "Interrupted") return { state: "Interrupted", completionUnknown: true };
    return { state: answer.state as "Accepted" | "Running" | "Unknown" };
  }
}

function malformed(): WorkspaceError {
  return new WorkspaceError("IO_ERROR", "the guest helper's answer is malformed");
}
