/** cube's own tools, defined once for every agent that calls them: a name,
 * a description, a TypeBox schema (which is JSON Schema) and `run`. Two thin
 * adapters offer them: `piTool` to Pi (OptChat and Pi threads) and the
 * workspace socket's tool routes to Claude Code, whose mod registers the
 * `manifest` and forwards each call (packages/claude-mod/hooks/register.ts).
 * Both check a call's input with Pi's own validator, so a call means the
 * same whichever agent made it. What a caller may reach is decided where the
 * list is built and inside `run`, never in an adapter. */
import type { Static, TSchema } from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import { defineTool, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import type { WorkspaceLease } from "./workspace.ts";

/** One call of a cube tool. */
export interface ToolCall {
  /** Stable for the call, the same on a replay or a repeated request: a write is done once. */
  key: string;
  /** The agent's own id for the call (Pi's call id, Claude Code's tool_use_id), kept as provenance. */
  id: string;
  /** Aborts when the call is abandoned (the person stopped the thread). */
  signal?: AbortSignal | undefined;
}

export interface CubeTool<P extends TSchema = TSchema> {
  /** The same for every agent; Claude Code shows it as mcp__cube__<name>. */
  name: string;
  description: string;
  parameters: P;
  /** The answer the model reads; a refusal is an answer too. Throws only on a fault. */
  run(input: Static<P>, call: ToolCall): Promise<string>;
}

/** Types `run`'s input from the schema; the list holds them as `CubeTool`. */
export function cubeTool<P extends TSchema>(tool: CubeTool<P>): CubeTool {
  return tool as unknown as CubeTool;
}

/** Claude Code's limit for a tool name; and an argument may not take the
 * name of a field Claude Code adds to the call (`tool`, `tool_use_id`). */
const NAME = /^[a-z][a-z0-9_]{0,47}$/;
const RESERVED = new Set(["tool", "tool_use_id"]);

/** A call's input as the tool's schema has it (Pi's validator, with its
 * coercion), or why not. */
export function parseInput(tool: CubeTool, input: unknown): { input: Static<TSchema> } | { invalid: string } {
  try {
    return { input: validateToolArguments(tool as never, { type: "toolCall", id: "", name: tool.name, arguments: input as never }) };
  } catch (error) {
    return { invalid: error instanceof Error ? error.message : String(error) };
  }
}

/** The tools as Claude Code registers them, in their order. */
export function manifest(tools: readonly CubeTool[]): Array<{ name: string; description: string; inputSchema: unknown; isDeferred: false }> {
  return tools.map(tool => {
    const properties = Object.keys((tool.parameters as { properties?: object }).properties ?? {});
    if (!NAME.test(tool.name) || properties.some(name => RESERVED.has(name))) throw new Error(`cube tool ${tool.name} cannot be offered to Claude Code`);
    return { name: tool.name, description: tool.description, inputSchema: JSON.parse(JSON.stringify(tool.parameters)), isDeferred: false };
  });
}

/** A cube tool for Pi, which validates the input itself. Every cube tool
 * is replay-safe: it reads, or writes once by the call's key. */
export function piTool(tool: CubeTool, key: (api: ToolExecutionApi) => string): ToolRegistration {
  return defineTool({
    name: tool.name, description: tool.description, parameters: tool.parameters,
    replay: "safe",
    execute: async (args, api, context) => ({
      output: [{ type: "text" as const, text: await tool.run(args as never, { key: key(api), id: api.callId, signal: context?.abortSignal }) }],
    }),
  });
}

/** Claude Code's half, on cubed's workspace socket: `GET …/workspace/tools`
 * lists the tools (the mod registers them), `POST …/workspace/tools/<name>`
 * `{ call, input }` answers one call `{ text }`. The lease token cubed holds
 * for the thread's Claude Code child is the authorization; `tools` builds the
 * list for a held token, and `signal` aborts when the request is abandoned. */
export async function toolsRoute(request: { method: string; name: string | undefined; token: string | undefined; body: Record<string, unknown>; signal: AbortSignal },
  lease: (token: string) => Promise<WorkspaceLease | null>, tools: (token: string) => readonly CubeTool[]): Promise<{ status: number; body: unknown }> {
  const refuse = (status: number, code: string, error: string) => ({ status, body: { error, code, completionUnknown: false } });
  if (!request.token) return refuse(401, "LEASE_STALE", "workspace lease token required");
  const held = await lease(request.token);
  if (!held) return refuse(401, "LEASE_STALE", "workspace lease is not held by this token");
  if (held.owner !== "claude-code") return refuse(403, "WRONG_NODE", "these tools are for claude code threads");
  const offered = tools(request.token);
  if (request.name === undefined && request.method === "GET") return { status: 200, body: { tools: manifest(offered) } };
  const tool = offered.find(candidate => candidate.name === request.name);
  if (!tool || request.method !== "POST") return refuse(404, "NOT_FOUND", `no cube tool ${request.name ?? ""}`);
  const { call, input } = request.body;
  if (typeof call !== "string" || !call || call.length > 200) return refuse(400, "INVALID_REQUEST", "call (the tool_use_id) is required");
  const parsed = parseInput(tool, input ?? {});
  if ("invalid" in parsed) return refuse(400, "INVALID_REQUEST", parsed.invalid);
  return { status: 200, body: { text: await tool.run(parsed.input, { key: `claude:${call}:tool`, id: call, signal: request.signal }) } };
}
