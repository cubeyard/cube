/** The thread Workspace over cubed's HTTP routes, written once for both
 * sides: the Claude Code mod (no Node, no DOM; requests go through the
 * engine's `$.http.fetch`) and cubed's own `HttpWorkspace`, which wraps it
 * with Node's fetch. The transport is injected; bytes travel as base64.
 *
 * The shapes mirror `Workspace` in packages/server/src/workspace.ts. This
 * file imports nothing: a Claude Code hooks module may only import files of
 * its own plugin. */

export type WorkspaceOwner = "pi" | "claude-code";
export interface WorkspaceLimits {
  maxFrameBytes: number; requestTimeoutMs: number; maxCommandBytes: number; maxPathBytes: number;
  maxExecTimeoutMs: number; maxOutputBytes: number; outputPageBytes: number; maxReadBytes: number; maxWriteBytes: number;
}
export interface WorkspaceLease { token: string; owner: WorkspaceOwner; epoch: number; expiresAt: number | null }
export interface WorkspaceExecSpec { command: string; cwd?: string; timeoutMs: number; outputLimit?: number }
export type WorkspaceOperation =
  | { key: string; state: "running" }
  | { key: string; state: "succeeded"; exitCode: number | null; termination: "exited" | "signalled" | "timedOut";
    output: Uint8Array; outputOffset: number; retainedBytes: number; outputBytes: number; truncated: boolean }
  | { key: string; state: "written"; sha256: string; size: number }
  | { key: string; state: "failed"; error: string; completionUnknown: boolean }
  | { key: string; state: "interrupted"; completionUnknown: true };
export interface WorkspaceFile { content: Uint8Array; offset: number; size: number; eof: boolean; sha256: string | null }
export interface WorkspaceWriteResult { sha256: string; size: number }
export interface WorkspaceStat { kind: "file" | "directory" | "symlink" | "other"; size: number; mode: number; modifiedMs: number; sha256: string | null }
export interface WorkspaceWrite { expectedSha?: string; createParents?: boolean }

export interface WorkspaceRequest { method: string; path: string; headers: Record<string, string>; body?: string }
export interface WorkspaceReply { status: number; text: string }
/** One HTTP exchange; rejects only when no reply arrived. */
export type WorkspaceTransport = (request: WorkspaceRequest) => Promise<WorkspaceReply>;

/** The longest server-side wait for a running operation, per request. */
export const MAX_OPERATION_WAIT_MS = 30000;

/** A workspace error as the routes report it: `code` is the shared
 * Workspace error code, `completionUnknown` whether a mutation may have run. */
export class WorkspaceClientError extends Error {
  readonly code: string;
  readonly completionUnknown: boolean;
  constructor(code: string, message: string, options: { completionUnknown?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "WorkspaceClientError";
    this.code = code;
    this.completionUnknown = options.completionUnknown ?? code === "COMPLETION_UNKNOWN";
  }
}

const CODES = new Set(["INVALID_REQUEST", "LEASE_STALE", "WRONG_NODE", "NOT_FOUND", "CONFLICT", "LEASE_HELD", "CANCELLED",
  "PRECONDITION_FAILED", "CAPACITY_EXCEEDED", "OPERATION_UNSUPPORTED", "INCOMPATIBLE_PROTOCOL", "COMPLETION_UNKNOWN",
  "NODE_UNAVAILABLE", "DRAINING", "ENVIRONMENT_MISSING", "IO_ERROR"]);

/** `base` is the path of the thread's workspace routes, ending in `/workspace`. */
export class WorkspaceClient {
  private readonly base: string;
  private readonly transport: WorkspaceTransport;
  constructor(options: { base: string; transport: WorkspaceTransport }) {
    this.base = options.base.replace(/\/+$/, ""); this.transport = options.transport;
  }

  lease(request: { owner: WorkspaceOwner; ttlMs?: number } | { token: string }): Promise<WorkspaceLease> {
    if ("token" in request) return this.call("POST", "/lease", { token: request.token, body: {} });
    return this.call("POST", "/lease", { body: request.ttlMs === undefined ? { owner: request.owner } : { owner: request.owner, ttlMs: request.ttlMs } });
  }
  async release(token: string): Promise<void> { await this.call("DELETE", "/lease", { token }); }
  async capabilities(): Promise<string[]> { return (await this.call<{ capabilities: string[] }>("GET", "")).capabilities; }
  async limits(): Promise<WorkspaceLimits> { return (await this.call<{ limits: WorkspaceLimits }>("GET", "")).limits; }
  async exec(token: string, key: string, spec: WorkspaceExecSpec): Promise<WorkspaceOperation> {
    return operation(await this.call("POST", "/exec", { token, body: { key, ...spec } }));
  }
  /** `waitMs` asks cubed to hold the request until the operation leaves
   * `running` or the wait ends, so a caller polls without sleeping. */
  async operation(token: string, key: string, options: { cursor?: number; waitMs?: number } = {}): Promise<WorkspaceOperation> {
    const query = new URLSearchParams();
    if (options.cursor !== undefined) query.set("cursor", String(options.cursor));
    if (options.waitMs !== undefined) query.set("wait", String(Math.min(Math.max(0, Math.floor(options.waitMs)), MAX_OPERATION_WAIT_MS)));
    const suffix = query.toString() ? `?${query}` : "";
    return operation(await this.call("GET", `/operations/${encodeURIComponent(key)}${suffix}`, { token }));
  }
  async cancel(token: string, key: string): Promise<WorkspaceOperation> {
    return operation(await this.call("POST", `/operations/${encodeURIComponent(key)}/cancel`, { token, body: {} }));
  }
  async readFile(token: string, file: string, options: { offset?: number; limit?: number } = {}): Promise<WorkspaceFile> {
    const query = new URLSearchParams({ path: file });
    if (options.offset !== undefined) query.set("offset", String(options.offset));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const result = await this.call<Omit<WorkspaceFile, "content"> & { content: string }>("GET", `/file?${query}`, { token });
    return { ...result, content: fromBase64(result.content) };
  }
  writeFile(token: string, key: string, file: string, content: Uint8Array, options: WorkspaceWrite = {}): Promise<WorkspaceWriteResult> {
    return this.call("PUT", "/file", { token, body: { key, path: file, content: toBase64(content), ...options } });
  }
  /** The thread's own artifacts (cubed's work artifacts, not workspace files):
   * one named artifact as text, or the list without a name. */
  artifact(token: string, name?: string): Promise<{ text: string }> {
    return this.call("GET", `/artifacts${name === undefined ? "" : `?${new URLSearchParams({ name })}`}`, { token });
  }
  /** Writes the named artifact's next revision; the request id makes a repeated call write it once. */
  writeArtifact(token: string, request: { name: string; requestId: string; call: string; body: string; title?: string; actions?: unknown }): Promise<{ text: string; id: string; revision: number }> {
    return this.call("POST", "/artifacts", { token, body: request });
  }
  stat(token: string, file: string): Promise<WorkspaceStat> {
    return this.call("GET", `/stat?${new URLSearchParams({ path: file })}`, { token });
  }

  private async call<T>(method: string, route: string, options: { token?: string; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    let reply: WorkspaceReply;
    try {
      reply = await this.transport({ method, path: `${this.base}${route}`, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
    } catch (cause) {
      // The request may have reached cubed; mutations are safe to repeat by key.
      throw new WorkspaceClientError("NODE_UNAVAILABLE", "cubed workspace is unreachable", { cause, completionUnknown: method !== "GET" });
    }
    let result: Record<string, unknown>;
    try { result = JSON.parse(reply.text); } catch { throw new WorkspaceClientError("IO_ERROR", `unexpected workspace response (${reply.status})`); }
    if (reply.status >= 200 && reply.status < 300) return result as T;
    const code = typeof result.code === "string" && CODES.has(result.code) ? result.code : "IO_ERROR";
    throw new WorkspaceClientError(code, typeof result.error === "string" ? result.error : code, { completionUnknown: result.completionUnknown === true });
  }
}

function operation(value: unknown): WorkspaceOperation {
  const row = value as WorkspaceOperation & { output?: unknown };
  return row.state === "succeeded" ? { ...row, output: fromBase64(String(row.output)) } : row;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
export function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
