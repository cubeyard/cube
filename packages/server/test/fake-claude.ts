/** A stand-in for the `claude` CLI in `-p` stream-json mode. It never calls
 * a model: each prompt line is a script step, and tool steps run the Claude
 * Code mod's own tool functions (packages/claude-mod/hooks/tools.ts) over
 * cubed's workspace socket, keyed by a tool_use_id, as the mod does inside
 * Claude Code. Messages follow Claude Code's stream-json output.
 *
 * Steps, one per line: `run <command>`, `slow <command>`, `write <file> <text>`,
 * `edit <file> <old> <new>`, `read <file>`, `say <text>`, `crash`, `fail`,
 * `id <tool_use_id> run <command>`, `ignore-interrupt`, `ignore-term`.
 * FAKE_CLAUDE_LOG names a file that receives one JSON line per start.
 *
 * Every result carries `modelUsage` as Claude Code's does: running totals
 * per model for the process, each turn adding TURN_USAGE under
 * `claude-<model>`; a process started with --resume continues the totals
 * the session saved (in its working directory). */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { WorkspaceClient } from "../../claude-mod/hooks/workspace.ts";
import { bash, edit, read, write, type ToolScope } from "../../claude-mod/hooks/tools.ts";
import { unixTransport } from "./unix-transport.ts";

const args = process.argv.slice(2);
const flag = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const fail = (message: string) => { process.stderr.write(`fake claude: ${message}\n`); process.exit(2); };
if (!args.includes("-p") || flag("--input-format") !== "stream-json" || flag("--output-format") !== "stream-json" || !args.includes("--verbose")) fail("expected -p with stream-json input and output and --verbose");
const mod = flag("--plugin-dir");
if (!mod || !fs.existsSync(`${mod}/.claude-plugin/plugin.json`) || !fs.existsSync(`${mod}/hooks/hooks.json`)) fail("expected --plugin-dir with cube's mod");
const model = flag("--model") ?? fail("expected --model");
// Only cube's mod: no settings files, no MCP servers, only the allowed tools.
if (flag("--setting-sources") !== "" || !args.includes("--strict-mcp-config") || flag("--mcp-config") !== JSON.stringify({ mcpServers: {} })) fail("expected no setting sources and an empty strict MCP config");
const tools = (flag("--tools") ?? "").split(",");
if (!["Bash", "Read", "Write", "Edit"].every(name => tools.includes(name)) || tools.some(name => name.startsWith("mcp__") || name === "WebFetch")) fail("expected --tools with the mod's allow-list");
const session = flag("--resume") ?? randomUUID();
if (process.env.FAKE_CLAUDE_LOG) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, `${JSON.stringify({ args, cwd: process.cwd(), session,
    apiKey: "ANTHROPIC_API_KEY" in process.env, authToken: "ANTHROPIC_AUTH_TOKEN" in process.env, env: Object.keys(process.env).sort(), pid: process.pid })}\n`);
}
const env = process.env;
if (!env.CUBE_WORKSPACE_SOCKET || !env.CUBE_WORKSPACE_PATH || !env.CUBE_WORKSPACE_TOKEN || !env.CUBE_WORKSPACE_ROOT) fail("expected the cube workspace environment");
const client = new WorkspaceClient({ base: env.CUBE_WORKSPACE_PATH!, transport: unixTransport(env.CUBE_WORKSPACE_SOCKET!) });

const TURN_USAGE = { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 50, cacheCreationInputTokens: 10, costUSD: 0.01 };
type Totals = Record<string, typeof TURN_USAGE & { webSearchRequests: number; contextWindow: number; maxOutputTokens: number; costBasis: string }>;
const saved = `.fake-usage-${session}.json`;
const totals: Totals = fs.existsSync(saved) ? JSON.parse(fs.readFileSync(saved, "utf8")) as Totals : {};
/** One turn's model calls: added to the running totals, which the session saves. */
function spend(): Totals {
  const key = `claude-${model}`;
  const prior = totals[key] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0, webSearchRequests: 0, contextWindow: 200000, maxOutputTokens: 32000, costBasis: "list" };
  totals[key] = { ...prior, inputTokens: prior.inputTokens + TURN_USAGE.inputTokens, outputTokens: prior.outputTokens + TURN_USAGE.outputTokens,
    cacheReadInputTokens: prior.cacheReadInputTokens + TURN_USAGE.cacheReadInputTokens, cacheCreationInputTokens: prior.cacheCreationInputTokens + TURN_USAGE.cacheCreationInputTokens,
    costUSD: prior.costUSD + TURN_USAGE.costUSD };
  fs.writeFileSync(saved, JSON.stringify(totals));
  return totals;
}
const usage = () => {
  const modelUsage = spend();
  return { modelUsage, total_cost_usd: Object.values(modelUsage).reduce((sum, item) => sum + item.costUSD, 0),
    usage: { input_tokens: TURN_USAGE.inputTokens, output_tokens: TURN_USAGE.outputTokens, cache_read_input_tokens: TURN_USAGE.cacheReadInputTokens, cache_creation_input_tokens: TURN_USAGE.cacheCreationInputTokens },
    uuid: randomUUID() };
};
const emit = (message: Record<string, unknown>) => process.stdout.write(`${JSON.stringify({ ...message, session_id: session })}\n`);
emit({ type: "system", subtype: "init", model, cwd: process.cwd(), tools: ["Bash", "Read", "Write", "Edit"], plugins: [{ name: "cube", path: mod }] });

let calls = 0;
let current: AbortController | undefined;
let ignoreInterrupt = false;
let queue = Promise.resolve();
const input = createInterface({ input: process.stdin });
input.on("line", line => {
  const message = JSON.parse(line) as { type: string; request_id?: string; request?: { subtype: string }; message?: { content: Array<{ type: string; text: string }> } };
  if (message.type === "control_request") {
    emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id } });
    if (message.request?.subtype === "interrupt" && !ignoreInterrupt) current?.abort();
    return;
  }
  if (message.type !== "user") return;
  const text = message.message!.content.map(part => part.text).join("");
  queue = queue.then(() => turn(text));
});
input.on("close", () => { void queue.then(() => process.exit(0)); });

async function say(text: string): Promise<void> {
  const id = `msg_${randomUUID()}`;
  emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id } } });
  emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });
  const half = Math.ceil(text.length / 2);
  for (const piece of [text.slice(0, half), text.slice(half)]) {
    emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } } });
    await delay(30);
  }
  emit({ type: "assistant", parent_tool_use_id: null, message: { id, role: "assistant", model, content: [{ type: "text", text }] } });
}

async function tool(id: string, name: string, toolInput: Record<string, unknown>, signal: AbortSignal): Promise<void> {
  emit({ type: "assistant", parent_tool_use_id: null, message: { id: `msg_${randomUUID()}`, role: "assistant", model, content: [{ type: "tool_use", id, name, input: toolInput }] } });
  const scope: ToolScope = { client, token: env.CUBE_WORKSPACE_TOKEN!, root: env.CUBE_WORKSPACE_ROOT!, signal };
  const result = name === "Bash" ? await bash(scope, id, toolInput as never)
    : name === "Write" ? await write(scope, id, toolInput as never)
    : name === "Edit" ? await edit(scope, id, toolInput as never)
    : await read(scope, toolInput as never);
  const content = "deny" in result ? result.deny
    : name === "Bash" ? [(result as { stdout: string }).stdout, (result as { stderr: string }).stderr].filter(Boolean).join("\n")
    : name === "Read" ? (result as { file: { content: string } }).file.content
    : `${name} ok: ${String(toolInput.file_path)}`;
  emit({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: "deny" in result }] } });
}

async function turn(text: string): Promise<void> {
  const controller = new AbortController();
  current = controller;
  const started = Date.now();
  try {
    for (const raw of text.split("\n")) {
      if (controller.signal.aborted) break;
      let line = raw.trim();
      let id = `toolu_${session.slice(0, 8)}_${process.pid}_${++calls}`;
      const fixed = /^id (\S+) (.*)$/.exec(line);
      if (fixed) { id = fixed[1]!; line = fixed[2]!; }
      const [verb, ...rest] = line.split(" ");
      if (verb === "crash") { process.stderr.write("fake claude crashed\n"); process.exit(3); }
      if (verb === "fail") { emit({ type: "result", subtype: "success", is_error: true, result: "API Error: 401 · Please run /login", duration_ms: Date.now() - started, ...usage() }); return; }
      if (verb === "ignore-interrupt") { ignoreInterrupt = true; continue; }
      if (verb === "ignore-term") { process.on("SIGTERM", () => {}); continue; }
      if (verb === "say") await say(rest.join(" "));
      else if (verb === "run" || verb === "slow") await tool(id, "Bash", { command: rest.join(" "), description: "run it" }, controller.signal);
      else if (verb === "write") await tool(id, "Write", { file_path: `${env.CUBE_WORKSPACE_ROOT}/${rest[0]}`, content: rest.slice(1).join(" ") }, controller.signal);
      else if (verb === "edit") await tool(id, "Edit", { file_path: `${env.CUBE_WORKSPACE_ROOT}/${rest[0]}`, old_string: rest[1], new_string: rest[2] }, controller.signal);
      else if (verb === "read") await tool(id, "Read", { file_path: `${env.CUBE_WORKSPACE_ROOT}/${rest[0]}` }, controller.signal);
      else if (verb === "hang") await new Promise(() => {});
      else if (verb) await say(`unknown step ${verb}`);
    }
    if (controller.signal.aborted) {
      emit({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
      emit({ type: "result", subtype: "error_during_execution", is_error: true, duration_ms: Date.now() - started, ...usage() });
      return;
    }
    await say(`done with ${model}`);
    emit({ type: "result", subtype: "success", is_error: false, result: `done with ${model}`, duration_ms: Date.now() - started, ...usage() });
  } finally { if (current === controller) current = undefined; }
}
