/** Workspace over HTTP: the routes are a thin transport over `Workspace`, and
 * `HttpWorkspace` implements the same interface against them. The lease token,
 * sent as `authorization: Bearer <token>`, is the authorization for every
 * route except reading capabilities and acquiring the lease.
 *
 *   GET    …/workspace                       capabilities and limits
 *   POST   …/workspace/lease                 acquire {owner, ttlMs?}; with a token: heartbeat
 *   DELETE …/workspace/lease                 release
 *   POST   …/workspace/exec                  {key, command, cwd?, timeoutMs, outputLimit?}
 *   GET    …/workspace/operations/:key       ?cursor=&wait=  (wait: hold up to 30 s while running)
 *   POST   …/workspace/operations/:key/cancel
 *   GET    …/workspace/file                  ?path=&offset=&limit=
 *   PUT    …/workspace/file                  {key, path, content (base64), expectedSha?, createParents?}
 *   GET    …/workspace/stat                  ?path=
 *
 * Bytes travel as base64. Errors are `{error, code, completionUnknown}`. */
import type { IncomingHttpHeaders } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { MAX_OPERATION_WAIT_MS, WorkspaceClient, WorkspaceClientError } from "../../claude-mod/hooks/workspace.ts";
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
const WAIT_POLL_MS = 100;

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
      const cursor = query.get("cursor"), wait = query.get("wait");
      const read = () => workspace.operation(token(), parts[1], cursor === null ? {} : { cursor: integer(cursor) });
      // A long poll is transport only: callers that cannot sleep cheaply (a
      // Claude Code hook's own time is budgeted) wait here instead.
      const deadline = Date.now() + (wait === null ? 0 : Math.min(integer(wait), MAX_OPERATION_WAIT_MS));
      let state = await read();
      while (state.state === "running" && Date.now() < deadline) {
        await delay(Math.min(WAIT_POLL_MS, Math.max(1, deadline - Date.now())));
        state = await read();
      }
      return ok(operationJson(state));
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

/** Workspace client for out-of-process agents over Node's fetch. The
 * protocol lives in the Claude Code mod's portable client, which this wraps;
 * `url` ends in `/workspace`. */
export class HttpWorkspace implements Workspace {
  private readonly client: WorkspaceClient;
  constructor(options: { url: string }) {
    const url = new URL(options.url.replace(/\/+$/, ""));
    this.client = new WorkspaceClient({ base: url.pathname, transport: async request => {
      const response = await fetch(new URL(request.path, url), { method: request.method, headers: request.headers, ...(request.body === undefined ? {} : { body: request.body }) });
      return { status: response.status, text: await response.text() };
    } });
  }

  lease(request: WorkspaceLeaseRequest | { token: string }): Promise<WorkspaceLease> { return translate(() => this.client.lease(request)); }
  release(token: string): Promise<void> { return translate(() => this.client.release(token)); }
  capabilities(): Promise<string[]> { return translate(() => this.client.capabilities()); }
  limits(): Promise<WorkspaceLimits> { return translate(() => this.client.limits()); }
  exec(token: string, key: string, spec: WorkspaceExecSpec): Promise<WorkspaceOperation> {
    return translate(() => this.client.exec(token, key, spec)) as Promise<WorkspaceOperation>;
  }
  operation(token: string, key: string, options: { cursor?: number } = {}): Promise<WorkspaceOperation> {
    return translate(() => this.client.operation(token, key, options)) as Promise<WorkspaceOperation>;
  }
  cancel(token: string, key: string): Promise<WorkspaceOperation> {
    return translate(() => this.client.cancel(token, key)) as Promise<WorkspaceOperation>;
  }
  readFile(token: string, file: string, options: { offset?: number; limit?: number } = {}): Promise<WorkspaceFile> {
    return translate(() => this.client.readFile(token, file, options));
  }
  writeFile(token: string, key: string, file: string, content: Uint8Array, options: WorkspaceWrite = {}): Promise<WorkspaceWriteResult> {
    return translate(() => this.client.writeFile(token, key, file, content, options));
  }
  stat(token: string, file: string): Promise<WorkspaceStat> { return translate(() => this.client.stat(token, file)); }
}

async function translate<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) {
    if (!(error instanceof WorkspaceClientError)) throw error;
    throw new WorkspaceError(error.code as WorkspaceErrorCode, error.message, { cause: error.cause, completionUnknown: error.completionUnknown });
  }
}
