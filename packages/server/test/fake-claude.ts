/** A stand-in for the `claude` CLI in `-p` stream-json mode. It never calls
 * a model: each prompt line is a script step, and tool steps run the Claude
 * Code mod's own tool functions (packages/claude-mod/hooks/tools.ts) over
 * cubed's workspace socket, keyed by a tool_use_id, as the mod does inside
 * Claude Code. Messages follow Claude Code's stream-json output.
 *
 * Steps, one per line: `run <command>`, `slow <command>`, `write <file> <text>`,
 * `edit <file> <old> <new>`, `read <file>`, `write-at <absolute path> <text>` and
 * `read-at <absolute path>` (the mod's /cube/artifacts paths too), `say <text>`, `crash`, `fail`,
 * `id <tool_use_id> run <command>`, `ignore-interrupt`, `ignore-term`,
 * `background <task_id> <ms> <description>` (a background Agent that
 * finishes after ms: Claude Code's task_started and task_notification
 * messages, then the turn it takes by itself, or none when a turn is
 * running, which sees the notification), `background-quiet …` (finishes
 * without a turn of its own), `background-later …` (started in the
 * foreground, then backgrounded by task_updated), `monitor <task_id>` (a
 * backgrounded task of another kind that never notifies).
 * A leading OptChat view (optchat-thread-view.ts) is not steps: it is
 * answered with one `say`.
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
import { splitThreadView } from "../src/optchat-thread-view.ts";
import { artifactPath, bash, edit, read, readArtifact, write, writeArtifact, type ToolScope } from "../../claude-mod/hooks/tools.ts";
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
  const scope: ToolScope = { client, token: env.CUBE_WORKSPACE_TOKEN!, root: env.CUBE_WORKSPACE_ROOT!,
    ...(env.CUBE_WORKSPACE_REAL_ROOT ? { realRoot: env.CUBE_WORKSPACE_REAL_ROOT } : {}), signal };
  // As register.ts: /cube/artifacts paths are the thread's artifacts.
  const artifact = name === "Read" || name === "Write" ? artifactPath(toolInput.file_path) : null;
  const result = artifact && "deny" in artifact ? artifact
    : artifact ? name === "Write" ? await writeArtifact(scope, id, artifact, toolInput as never) : await readArtifact(scope, artifact, toolInput as never)
    : name === "Bash" ? await bash(scope, id, toolInput as never)
    : name === "Write" ? await write(scope, id, toolInput as never)
    : name === "Edit" ? await edit(scope, id, toolInput as never)
    : await read(scope, toolInput as never);
  // Read's image result reaches the model, and stream-json, as Claude Code
  // 2.1.293 prints it: an image block in the tool result, the typed result beside it.
  const image = name === "Read" && !("deny" in result) && (result as { type?: string }).type === "image" ? (result as { file: { base64: string; type: string } }).file : null;
  const content = "deny" in result ? result.deny
    : image ? [{ type: "image", source: { type: "base64", data: image.base64, media_type: image.type } }]
    : name === "Bash" ? [(result as { stdout: string }).stdout, (result as { stderr: string }).stderr].filter(Boolean).join("\n")
    : name === "Read" ? (result as { file: { content: string } }).file.content
    : artifact ? (result as { content: string }).content
    : `${name} ok: ${String(toolInput.file_path)}`;
  emit({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: "deny" in result }] }, ...image ? { tool_use_result: result } : {} });
}

/** A background Agent: launched within the turn, its own messages carry
 * its tool use id, and its notification comes when it finishes. */
function background(toolUseId: string, task: string, ms: number, description: string, goOn: boolean, later = false): void {
  emit({ type: "assistant", parent_tool_use_id: null, message: { id: `msg_${randomUUID()}`, role: "assistant", model, content: [{ type: "tool_use", id: toolUseId, name: "Agent", input: { description, prompt: description } }] } });
  emit({ type: "system", subtype: "task_started", task_id: task, tool_use_id: toolUseId, description, ...(later ? {} : { task_type: "local_agent" }), is_backgrounded: !later });
  if (later) emit({ type: "system", subtype: "task_updated", task_id: task, patch: { is_backgrounded: true } });
  emit({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: `Async agent launched: ${task}` }] } });
  setTimeout(() => emit({ type: "assistant", parent_tool_use_id: toolUseId, message: { id: `msg_${randomUUID()}`, role: "assistant", model, content: [{ type: "text", text: `${task} working` }] } }), Math.min(50, ms / 2));
  setTimeout(() => {
    emit({ type: "system", subtype: "task_notification", task_id: task, tool_use_id: toolUseId, status: "completed", summary: `${description} found nothing` });
    // A running turn takes the notification in; between turns it gets one.
    if (goOn && !current) queue = queue.then(() => turn(`say ${task} reviewed: nothing to fix`, false));
  }, ms);
}

async function turn(text: string, prompted = true): Promise<void> {
  const controller = new AbortController();
  current = controller;
  const started = Date.now();
  try {
    // OptChat's view is context, not steps: named once.
    const { text: steps, view } = splitThreadView(text);
    if (view) await say(`read the view of messages 0-${view.messages - 1}`);
    for (const raw of steps.split("\n")) {
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
      // An absolute path (the mod's /cube/artifacts); "\n" in the text is a line break.
      else if (verb === "write-at") await tool(id, "Write", { file_path: rest[0], content: rest.slice(1).join(" ").replace(/\\n/g, "\n") }, controller.signal);
      else if (verb === "read-at") await tool(id, "Read", { file_path: rest[0] }, controller.signal);
      else if (verb === "hang") await new Promise(() => {});
      else if (verb === "background" || verb === "background-quiet" || verb === "background-later") background(id, rest[0]!, Number(rest[1]), rest.slice(2).join(" "), verb !== "background-quiet", verb === "background-later");
      else if (verb === "monitor") emit({ type: "system", subtype: "task_started", task_id: rest[0], description: "watch a log", task_type: "monitor", is_backgrounded: true });
      else if (verb) await say(`unknown step ${verb}`);
    }
    if (controller.signal.aborted) {
      emit({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } });
      emit({ type: "result", subtype: "error_during_execution", is_error: true, duration_ms: Date.now() - started, ...usage() });
      return;
    }
    if (prompted) await say(`done with ${model}`);
    emit({ type: "result", subtype: "success", is_error: false, result: prompted ? `done with ${model}` : "", duration_ms: Date.now() - started, ...usage() });
  } finally { if (current === controller) current = undefined; }
}
