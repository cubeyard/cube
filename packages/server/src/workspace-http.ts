/** Workspace over HTTP: the routes are a thin transport over `Workspace`, and
 * `HttpWorkspace` implements the same interface against them. The lease token,
 * sent as `authorization: Bearer <token>`, is the authorization for every
 * route except reading capabilities and acquiring the lease.
 *
 *   GET    …/workspace                       capabilities and limits
 *   POST   …/workspace/lease                 acquire {owner, ttlMs?}; with a token: heartbeat
 *   DELETE …/workspace/lease                 release
 *   POST   …/workspace/exec                  {key, command, cwd?, timeoutMs, outputLimit?}
 *   GET    …/workspace/operations/:key       ?cursor=
 *   POST   …/workspace/operations/:key/cancel
 *   GET    …/workspace/file                  ?path=&offset=&limit=
 *   PUT    …/workspace/file                  {key, path, content (base64), expectedSha?, createParents?}
 *   GET    …/workspace/stat                  ?path=
 *
 * Bytes travel as base64. Errors are `{error, code, completionUnknown}`. */
import type { IncomingHttpHeaders } from "node:http";
import { DEFAULT_LEASE_TTL_MS } from "./workspace-lease.ts";
import {
  WorkspaceError, type Workspace, type WorkspaceErrorCode, type WorkspaceExecSpec, type WorkspaceFile, type WorkspaceLease,
  type WorkspaceLeaseRequest, type WorkspaceLimits, type WorkspaceOperation, type WorkspaceOwner, type WorkspaceStat,
  type WorkspaceWrite, type WorkspaceWriteResult,
} from "./workspace.ts";

export interface WorkspaceResponse { status: number; body: unknown }

const STATUS: Partial<Record<WorkspaceErrorCode, number>> = {
  INVALID_REQUEST: 400, LEASE_STALE: 401, WRONG_NODE: 403, NOT_FOUND: 404, CONFLICT: 409, LEASE_HELD: 409, CANCELLED: 409,
  PRECONDITION_FAILED: 412, CAPACITY_EXCEEDED: 429, OPERATION_UNSUPPORTED: 501, INCOMPATIBLE_PROTOCOL: 501,
  COMPLETION_UNKNOWN: 502, NODE_UNAVAILABLE: 503, DRAINING: 503, ENVIRONMENT_MISSING: 503,
};
const CODES = new Set<string>([...Object.keys(STATUS), "IO_ERROR"]);

/** `parts` are the path segments after `…/workspace`. */
export async function workspaceRoute(workspace: Workspace, request: {
  method: string; parts: string[]; query: URLSearchParams; headers: IncomingHttpHeaders; body: Record<string, unknown>;
}): Promise<WorkspaceResponse> {
  const { method, parts, query, body } = request;
  try {
    const token = () => {
      const match = /^Bearer ([^\s]+)$/.exec(request.headers.authorization ?? "");
      if (!match) throw new WorkspaceError("LEASE_STALE", "workspace lease token required");
      return match[1];
    };
    const route = parts.join("/");
    if (route === "" && method === "GET") return ok({ capabilities: await workspace.capabilities(), limits: await workspace.limits() });
    if (route === "lease" && method === "POST") {
      if (request.headers.authorization) return ok(await workspace.lease({ token: token() }));
      const ttlMs = body.ttlMs === undefined ? DEFAULT_LEASE_TTL_MS : body.ttlMs;
      if (typeof ttlMs !== "number") throw invalid("ttlMs must be a number");
      // Remote holders always heartbeat; only in-process agents hold without one.
      return ok(await workspace.lease({ owner: body.owner as WorkspaceOwner, ttlMs }));
    }
    if (route === "lease" && method === "DELETE") { await workspace.release(token()); return ok({ ok: true }); }
    if (route === "exec" && method === "POST") {
      const spec: WorkspaceExecSpec = { command: body.command as string, timeoutMs: body.timeoutMs as number,
        ...(body.cwd === undefined ? {} : { cwd: body.cwd as string }),
        ...(body.outputLimit === undefined ? {} : { outputLimit: body.outputLimit as number }) };
      return ok(operationJson(await workspace.exec(token(), body.key as string, spec)));
    }
    if (parts[0] === "operations" && parts.length === 2 && method === "GET") {
      const cursor = query.get("cursor");
      return ok(operationJson(await workspace.operation(token(), parts[1], cursor === null ? {} : { cursor: integer(cursor) })));
    }
    if (parts[0] === "operations" && parts.length === 3 && parts[2] === "cancel" && method === "POST") {
      return ok(operationJson(await workspace.cancel(token(), parts[1])));
    }
    if (route === "file" && method === "GET") {
      const offset = query.get("offset"), limit = query.get("limit");
      const file = await workspace.readFile(token(), required(query, "path"), {
        ...(offset === null ? {} : { offset: integer(offset) }), ...(limit === null ? {} : { limit: integer(limit) }) });
      return ok({ ...file, content: Buffer.from(file.content).toString("base64") });
    }
    if (route === "file" && method === "PUT") {
      if (typeof body.content !== "string") throw invalid("content must be base64");
      const content = Buffer.from(body.content, "base64");
      if (content.toString("base64") !== body.content) throw invalid("content must be base64");
      const options: WorkspaceWrite = { ...(body.expectedSha === undefined ? {} : { expectedSha: body.expectedSha as string }),
        ...(body.createParents === undefined ? {} : { createParents: body.createParents as boolean }) };
      return ok(await workspace.writeFile(token(), body.key as string, body.path as string, content, options));
    }
    if (route === "stat" && method === "GET") return ok(await workspace.stat(token(), required(query, "path")));
    return { status: 404, body: { error: "not found", code: "NOT_FOUND", completionUnknown: false } };
  } catch (error) {
    if (!(error instanceof WorkspaceError)) throw error;
    return { status: STATUS[error.code] ?? 500, body: { error: error.message, code: error.code, completionUnknown: error.completionUnknown } };
  }
}

function ok(body: unknown): WorkspaceResponse { return { status: 200, body }; }
function invalid(message: string): WorkspaceError { return new WorkspaceError("INVALID_REQUEST", message); }
function integer(value: string): number {
  if (!/^\d{1,16}$/.test(value)) throw invalid("expected a non-negative integer");
  return Number(value);
}
function required(query: URLSearchParams, name: string): string {
  const value = query.get(name);
  if (value === null) throw invalid(`${name} is required`);
  return value;
}
function operationJson(operation: WorkspaceOperation): unknown {
  return operation.state === "succeeded" ? { ...operation, output: Buffer.from(operation.output).toString("base64") } : operation;
}

/** Workspace client for out-of-process agents. `url` ends in `/workspace`. */
export class HttpWorkspace implements Workspace {
  private readonly url: string;
  constructor(options: { url: string }) { this.url = options.url.replace(/\/+$/, ""); }

  async lease(request: WorkspaceLeaseRequest | { token: string }): Promise<WorkspaceLease> {
    if ("token" in request) return this.call("POST", "/lease", { token: request.token, body: {} });
    return this.call("POST", "/lease", { body: request.ttlMs === undefined ? { owner: request.owner } : { owner: request.owner, ttlMs: request.ttlMs } });
  }
  async release(token: string): Promise<void> { await this.call("DELETE", "/lease", { token }); }
  async capabilities(): Promise<string[]> { return (await this.call<{ capabilities: string[] }>("GET", "")).capabilities; }
  async limits(): Promise<WorkspaceLimits> { return (await this.call<{ limits: WorkspaceLimits }>("GET", "")).limits; }
  async exec(token: string, key: string, spec: WorkspaceExecSpec): Promise<WorkspaceOperation> {
    return operation(await this.call("POST", "/exec", { token, body: { key, ...spec } }));
  }
  async operation(token: string, key: string, options: { cursor?: number } = {}): Promise<WorkspaceOperation> {
    const query = options.cursor === undefined ? "" : `?cursor=${options.cursor}`;
    return operation(await this.call("GET", `/operations/${encodeURIComponent(key)}${query}`, { token }));
  }
  async cancel(token: string, key: string): Promise<WorkspaceOperation> {
    return operation(await this.call("POST", `/operations/${encodeURIComponent(key)}/cancel`, { token, body: {} }));
  }
  async readFile(token: string, file: string, options: { offset?: number; limit?: number } = {}): Promise<WorkspaceFile> {
    const query = new URLSearchParams({ path: file });
    if (options.offset !== undefined) query.set("offset", String(options.offset));
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    const result = await this.call<Omit<WorkspaceFile, "content"> & { content: string }>("GET", `/file?${query}`, { token });
    return { ...result, content: Buffer.from(result.content, "base64") };
  }
  async writeFile(token: string, key: string, file: string, content: Uint8Array, options: WorkspaceWrite = {}): Promise<WorkspaceWriteResult> {
    return this.call("PUT", "/file", { token, body: { key, path: file, content: Buffer.from(content).toString("base64"), ...options } });
  }
  async stat(token: string, file: string): Promise<WorkspaceStat> {
    return this.call("GET", `/stat?${new URLSearchParams({ path: file })}`, { token });
  }

  private async call<T>(method: string, route: string, options: { token?: string; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await fetch(`${this.url}${route}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    } catch (cause) {
      // The request may have reached cubed; mutations are safe to repeat by key.
      throw new WorkspaceError("NODE_UNAVAILABLE", "cubed workspace is unreachable", { cause, completionUnknown: method !== "GET" });
    }
    const text = await response.text();
    let result: Record<string, unknown>;
    try { result = JSON.parse(text); } catch { throw new WorkspaceError("IO_ERROR", `unexpected workspace response (${response.status})`); }
    if (response.ok) return result as T;
    const code = typeof result.code === "string" && CODES.has(result.code) ? result.code as WorkspaceErrorCode : "IO_ERROR";
    throw new WorkspaceError(code, typeof result.error === "string" ? result.error : code, { completionUnknown: result.completionUnknown === true });
  }
}

function operation(value: unknown): WorkspaceOperation {
  const row = value as WorkspaceOperation & { output?: unknown };
  return row.state === "succeeded" ? { ...row, output: Buffer.from(String(row.output), "base64") } : row;
}
