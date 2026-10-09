/** Checks that a real `claude` started as cubed starts it never runs a
 * subagent. It talks to a scripted Messages API on loopback instead of a
 * model (ANTHROPIC_BASE_URL, which cubed itself never passes) and to a
 * workspace socket that answers `exec`, so no login or model is used.
 *
 * Each step is one prompt in one session, the first started fresh and the
 * rest with --resume: the API answers it with one tool call (Agent, its
 * older name Task, a background Agent, a fork, Workflow, then Bash) and the
 * check reads what Claude Code returned. With cubed's arguments Claude Code
 * itself refuses the subagent tools; with Agent, Task and Workflow forced
 * back into --tools (an older cubed's arguments) the mod refuses them.
 *
 *   node scripts/check-claude-subagents.ts   (CLAUDE=<path> names the binary) */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { NO_SUBAGENTS } from "../packages/claude-mod/hooks/tools.ts";
import { claudeArguments } from "../packages/server/src/claude-agent.ts";

const claude = process.env.CLAUDE ?? "claude";
const CALLS: Record<string, { name: string; input: Record<string, unknown> }> = {
  agent: { name: "Agent", input: { description: "look", prompt: "list the files" } },
  task: { name: "Task", input: { description: "look", prompt: "list the files", subagent_type: "general-purpose" } },
  background: { name: "Agent", input: { description: "look", prompt: "list the files", run_in_background: true } },
  fork: { name: "Agent", input: { description: "look", prompt: "list the files", subagent_type: "fork" } },
  workflow: { name: "Workflow", input: { script: "export const meta = { name: 'w', description: 'w', phases: [] }\nawait agent('list the files')" } },
  bash: { name: "Bash", input: { command: "echo hello", description: "say hello" } },
};

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-claude-subagents-"));
const offered: string[][] = [];
const served = new Set<string>();
const api = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const sent = JSON.parse(body) as { tools?: Array<{ name: string }>; messages: unknown[] };
    const steps = [...JSON.stringify(sent.messages).matchAll(/STEP (\w+)/g)];
    const step = steps.at(-1)?.[1];
    const key = `${step}:${steps.length}`;
    if (sent.tools?.length) offered.push(sent.tools.map(tool => tool.name));
    // A tool call once per prompt, then a closing text; side requests get text.
    const call = step && sent.tools?.length && !served.has(key) ? CALLS[step] : undefined;
    if (call) served.add(key);
    const events: Array<[string, Record<string, unknown>]> = [["message_start", { message: { id: `msg_${served.size}_${offered.length}`, type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }]];
    if (call) {
      events.push(["content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_${step}_${steps.length}`, name: call.name, input: {} } }],
        ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } }]);
    } else {
      events.push(["content_block_start", { index: 0, content_block: { type: "text", text: "" } }], ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } }]);
    }
    events.push(["content_block_stop", { index: 0 }], ["message_delta", { delta: { stop_reason: call ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } }], ["message_stop", {}]);
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [type, data] of events) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    response.end();
  });
});
const LIMITS = { maxFrameBytes: 1048576, requestTimeoutMs: 30000, maxCommandBytes: 65536, maxPathBytes: 4096, maxExecTimeoutMs: 600000, maxOutputBytes: 262144, outputPageBytes: 65536, maxReadBytes: 524288, maxWriteBytes: 524288 };
const BASE = "/api/threads/t1/workspace";
const socket = path.join(temp, "workspace.sock");
const workspace = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    const route = (request.url ?? "").slice(BASE.length).split("?")[0];
    const json = (status: number, value: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (route === "") return json(200, { capabilities: [], limits: LIMITS });
    if (route === "/exec") {
      const exec = JSON.parse(body) as { key: string; command: string };
      const output = Buffer.from(`guest ran: ${exec.command}\n`);
      return json(200, { key: exec.key, state: "succeeded", exitCode: 0, termination: "exited", output: output.toString("base64"), outputOffset: 0, retainedBytes: output.length, outputBytes: output.length, truncated: false });
    }
    return json(404, { error: "not found", code: "NOT_FOUND", completionUnknown: false });
  });
});
await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
await new Promise<void>(resolve => workspace.listen(socket, resolve));
const port = (api.address() as { port: number }).port;

type Line = { type?: string; subtype?: string; session_id?: string; tools?: string[]; parent_tool_use_id?: string | null; message?: { content?: Array<{ type: string; content?: unknown; is_error?: boolean }> } };
/** One prompt in a fresh copy of the mod; the tool results Claude Code returned. */
async function prompt(step: string, session: string | null, tools?: string): Promise<{ session: string; offered: string[]; results: Array<{ error: boolean; text: string }>; tasks: number; subagent: number }> {
  const mod = path.join(temp, "mod");
  fs.rmSync(mod, { recursive: true, force: true });
  fs.cpSync(path.resolve(import.meta.dirname, "../packages/claude-mod"), mod, { recursive: true, filter: source => !source.includes(`${path.sep}.claude-plugin${path.sep}types`) });
  const cwd = path.join(temp, "claude");
  fs.mkdirSync(cwd, { recursive: true });
  const args = claudeArguments(mod, "sonnet", session);
  if (tools) args[args.indexOf("--tools") + 1] = tools;
  const child = spawn(claude, args, { cwd, stdio: ["pipe", "pipe", "inherit"], env: {
    PATH: process.env.PATH, HOME: temp, CLAUDE_CONFIG_DIR: path.join(temp, "config"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "sk-check",
    CUBE_WORKSPACE_SOCKET: socket, CUBE_WORKSPACE_PATH: BASE, CUBE_WORKSPACE_TOKEN: "a".repeat(64), CUBE_WORKSPACE_ROOT: cwd, CUBE_WORKSPACE_REAL_ROOT: fs.realpathSync(cwd) } });
  child.stdin.end(`${JSON.stringify({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: `STEP ${step}` }] } })}\n`);
  const lines: Line[] = [];
  for await (const line of createInterface({ input: child.stdout })) if (line.trim()) lines.push(JSON.parse(line) as Line);
  const init = lines.find(line => line.type === "system" && line.subtype === "init");
  assert.ok(init?.session_id, `${step}: claude code started a session`);
  assert.equal(lines.find(line => line.type === "result")?.subtype, "success", `${step}: the turn ended`);
  const results = lines.filter(line => line.type === "user" && !line.parent_tool_use_id).flatMap(line => line.message?.content ?? []).filter(block => block.type === "tool_result")
    .map(block => ({ error: block.is_error === true, text: typeof block.content === "string" ? block.content : JSON.stringify(block.content) }));
  return { session: init.session_id, offered: init.tools ?? [], results, tasks: lines.filter(line => line.type === "system" && line.subtype?.startsWith("task_")).length, subagent: lines.filter(line => line.parent_tool_use_id).length };
}

try {
  let session: string | null = null;
  for (const step of ["agent", "task", "background", "fork", "workflow", "bash"]) {
    const turn = await prompt(step, session);
    assert.deepEqual(turn.offered.filter(name => ["Agent", "Task", "Workflow", "SendMessage"].includes(name)), [], `${step}: no subagent tool in init`);
    assert.deepEqual([turn.tasks, turn.subagent], [0, 0], `${step}: no task or subagent messages`);
    const name = CALLS[step]!.name;
    assert.deepEqual(turn.results, [step === "bash" ? { error: false, text: "guest ran: echo hello" }
      : { error: true, text: `<tool_use_error>Error: No such tool available: ${name}. ${name} is disabled for this session, in subagents as well as here.</tool_use_error>` }], `${step}: the tool result`);
    if (session) assert.equal(turn.session, session, `${step}: the session resumed`);
    session = turn.session;
  }
  assert.deepEqual(offered.filter(tools => tools.some(name => ["Agent", "Task", "Workflow", "SendMessage"].includes(name))), [], "the model was never offered a subagent tool");
  console.log("ok: cubed's arguments: claude code offers and runs no subagent tool, fresh or resumed; Bash reaches the workspace");

  session = null;
  served.clear();
  for (const step of ["agent", "task", "background", "workflow"]) {
    const turn = await prompt(step, session, "Bash,Read,Write,Edit,Agent,Task,Workflow,SendMessage,WebSearch");
    assert.deepEqual([turn.tasks, turn.subagent], [0, 0], `${step}: no task or subagent messages`);
    // The engine hands Task to the hook under its current name, Agent.
    const name = step === "workflow" ? "Workflow" : "Agent";
    assert.deepEqual(turn.results, [{ error: true, text: `<tool_use_error>${name}: ${NO_SUBAGENTS}</tool_use_error>` }], `${step}: the mod's refusal`);
    session = turn.session;
  }
  console.log("ok: subagent tools forced into --tools: the mod refuses each, fresh or resumed");
} finally {
  api.close();
  workspace.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
