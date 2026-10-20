/** Checks that a real `claude` never runs a tool on the cubed host, mod or
 * no mod. Like scripts/check-claude-subagents.ts it talks to a scripted
 * Messages API on loopback instead of a model, with a placeholder key and
 * its own config directory, so no login, model or provider is used. The
 * API answers every request with one tool call (`touch HOST-RAN; pwd` in
 * Bash, or a Read of the host's /etc/hostname), then a closing text.
 *
 * Part 1 runs cubed's own ClaudeAgent (its arguments, environment and
 * ready gate) over the workspace routes and the real guest helper in a
 * temporary root (test/local-guest.ts, which stands in for a thread VM; not
 * runner acceptance). A `/usr/bin/env` prefix in its command gives the child
 * the scripted API, which cubed's environment never passes:
 *   - the mod as cubed lays it: the tools run in the workspace, also after
 *     a resume;
 *   - a mod Claude Code cannot load (no folder, a syntax error, a throw at
 *     load, no hooks module): the turn fails and the API gets no request.
 * Part 2 starts `claude` with cubed's arguments and a mod that does not
 * load, and writes the prompt anyway (the gate bypassed): the `--settings`
 * hook and dontAsk refuse every host tool. Its control, the same without
 * those two flags (cubed's arguments before them), runs `pwd` on the host.
 * Part 3 makes the mod's Bash hook throw: its `.catch` refuses the call.
 *
 *   node scripts/check-claude-fail-closed.ts   (CLAUDE=<path> names the binary) */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { ClaudeAgent, claudeArguments, type ClaudeRuntime } from "../packages/server/src/claude-agent.ts";
import { VmWorkspace } from "../packages/server/src/vm-workspace.ts";
import { workspaceRoute } from "../packages/server/src/workspace-http.ts";
import { LeaseStore } from "../packages/server/src/workspace-lease.ts";
import { LocalGuestTransport } from "../packages/server/test/local-guest.ts";

const claude = process.env.CLAUDE ?? "claude";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-claude-closed-"));
const MARK = "HOST-RAN";

let requests = 0;
let tool: "Bash" | "Read" = "Bash";
const api = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const sent = JSON.parse(body) as { tools?: unknown[]; messages: unknown[] };
    if (sent.tools?.length) requests++;
    // One call for each prompt: while the prompts outnumber the results.
    const text = JSON.stringify(sent.messages);
    const call = sent.tools?.length && text.split('"text":"check"').length > text.split('"type":"tool_result"').length
      ? tool === "Bash" ? { name: "Bash", input: { command: `touch ${MARK}; pwd`, description: "where am I" } } : { name: "Read", input: { file_path: "/etc/hostname" } }
      : undefined;
    const events: Array<[string, Record<string, unknown>]> = [["message_start", { message: { id: `msg_${requests}`, type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }]];
    if (call) {
      events.push(["content_block_start", { index: 0, content_block: { type: "tool_use", id: `toolu_check_${requests}`, name: call.name, input: {} } }],
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
await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
const port = (api.address() as { port: number }).port;
const apiEnv = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "sk-check", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };

const guest = new LocalGuestTransport(path.join(temp, "guest"));
const workspace = new VmWorkspace({ guest, leases: new LeaseStore(path.join(temp, "thread")), owner: "claude-code", binding: guest.binding });
const BASE = "/api/threads/t1/workspace";
const socket = path.join(temp, "workspace.sock");
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url!, "http://localhost");
  let raw = "";
  for await (const chunk of request) raw += chunk;
  if (!url.pathname.startsWith(BASE)) return response.writeHead(404).end("{}");
  const parts = url.pathname.slice(BASE.length).split("/").filter(Boolean).map(decodeURIComponent);
  const result = await workspaceRoute(workspace, { method: request.method!, parts, query: url.searchParams, headers: request.headers, body: raw ? JSON.parse(raw) as Record<string, unknown> : {} });
  response.writeHead(result.status, { "content-type": "application/json" }).end(JSON.stringify(result.body));
});
await new Promise<void>(resolve => server.listen(socket, resolve));

/** A copy of cube's mod, as cubed lays it, then broken as named. */
function mod(kind: "cube" | "missing" | "syntax" | "throws" | "nomodules" | "bash-throws"): string {
  const target = path.join(temp, `mod-${kind}`);
  if (kind === "missing") return target;
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(path.resolve(import.meta.dirname, "../packages/claude-mod"), target, { recursive: true, filter: source => !source.includes(`${path.sep}.claude-plugin${path.sep}types`) });
  const register = path.join(target, "hooks/register.ts");
  const source = fs.readFileSync(register, "utf8");
  if (kind === "syntax") fs.appendFileSync(register, "\nexport const = ;\n");
  if (kind === "throws") fs.appendFileSync(register, "\nthrow new Error('cube check: load fails')\n");
  if (kind === "nomodules") fs.writeFileSync(path.join(target, "hooks/hooks.json"), "{}");
  if (kind === "bash-throws") {
    const hook = "const result = await bash(scope, e.tool_use_id, e)";
    assert.ok(source.includes(hook));
    fs.writeFileSync(register, source.replace(hook, "if (scope) throw new Error('cube check: the hook fails'); const result = await bash(scope, e.tool_use_id, e)"));
  }
  return target;
}
const hostRan = (cwd: string) => fs.existsSync(path.join(cwd, MARK));

// Part 1: cubed's ClaudeAgent.
const runtime = (modDir: string): ClaudeRuntime => ({
  command: ["/usr/bin/env", ...Object.entries(apiEnv).map(([name, value]) => `${name}=${value}`), `CLAUDE_CONFIG_DIR=${path.join(temp, "config")}`, `HOME=${temp}`, claude],
  mod: modDir, socket, modReadyMs: 20000,
});
async function turn(agent: ClaudeAgent, requestId: string): Promise<{ state: string; error: string | null; results: string[] }> {
  await agent.submit(requestId, "check");
  const deadline = Date.now() + 60000;
  for (;;) {
    const submission = agent.state().submissions.find(item => item.requestId === requestId)!;
    if (submission.state !== "running") {
      const results = agent.state().messages.filter(message => message.submission === submission.seq && message.data.type === "user")
        .flatMap(message => ((message.data.message as { content?: unknown[] })?.content ?? []) as Array<{ type: string; content?: unknown }>)
        .filter(block => block.type === "tool_result").map(block => typeof block.content === "string" ? block.content : JSON.stringify(block.content));
      return { state: submission.state, error: submission.error, results };
    }
    assert.ok(Date.now() < deadline, `${requestId} settles`);
    await delay(50);
  }
}

try {
  {
    tool = "Bash";
    const before = requests;
    const agent = await ClaudeAgent.open({ directory: path.join(temp, "agent-cube"), threadId: "t1", workspace, runtime: runtime(mod("cube")), model: "sonnet" });
    try {
      let result = await turn(agent, "c1");
      assert.equal(result.state, "completed", result.error ?? "");
      assert.deepEqual(result.results, [guest.workspace], "Bash ran in the workspace (pwd is the guest's)");
      assert.ok(fs.existsSync(path.join(guest.workspace, MARK)) && !hostRan(agent.root), "the file is in the workspace, not on the host");
      // A new child resumes the session; its mod says it is in again.
      await agent.setModel("opus");
      tool = "Read";
      result = await turn(agent, "c2");
      assert.equal(result.state, "completed", result.error ?? "");
      assert.ok(result.results.length === 1 && !result.results[0]!.includes(os.hostname()), `Read is the machine's /etc/hostname, not the host's: ${result.results[0]}`);
      assert.ok(requests - before >= 4, "the model was asked");
    } finally { await agent.close(); }
    console.log("ok: cube's mod as cubed loads it: Bash and Read reach the workspace, on a start and a resume");
  }
  for (const kind of ["missing", "syntax", "throws", "nomodules"] as const) {
    tool = "Bash";
    const before = requests;
    const agent = await ClaudeAgent.open({ directory: path.join(temp, `agent-${kind}`), threadId: "t1", workspace, runtime: runtime(mod(kind)), model: "sonnet" });
    try {
      const result = await turn(agent, "c1");
      assert.equal(result.state, "failed");
      assert.match(result.error ?? "", /started without cube's mod, so nothing was sent to it/);
      assert.equal(requests, before, `${kind}: the model was never asked`);
      assert.ok(!hostRan(agent.root), `${kind}: nothing ran on the host`);
    } finally { await agent.close(); }
  }
  console.log("ok: a mod claude code does not load (no folder, a syntax error, a throw at load, no hooks module): no prompt, no model request, nothing on the host");

  // Part 2: the gate bypassed, the prompt written to a modless child.
  async function direct(modDir: string, step: "Bash" | "Read", flags: "cubed" | "before"): Promise<{ results: string[]; cwd: string }> {
    tool = step;
    const cwd = fs.mkdtempSync(path.join(temp, "direct-"));
    const args = claudeArguments(modDir, "sonnet", null);
    if (flags === "before") {
      args.splice(args.indexOf("--permission-mode"), 2);
      args.splice(args.indexOf("--settings"), 2);
    }
    const child = spawn(claude, args, { cwd, stdio: ["pipe", "pipe", "inherit"], env: {
      PATH: process.env.PATH, HOME: temp, CLAUDE_CONFIG_DIR: path.join(temp, "config"), ...apiEnv,
      CUBE_WORKSPACE_SOCKET: socket, CUBE_WORKSPACE_PATH: BASE, CUBE_WORKSPACE_TOKEN: "0".repeat(64), CUBE_WORKSPACE_ROOT: cwd, CUBE_WORKSPACE_REAL_ROOT: fs.realpathSync(cwd) } });
    child.stdin.end(`${JSON.stringify({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "check" }] } })}\n`);
    const results: string[] = [];
    for await (const line of createInterface({ input: child.stdout })) {
      if (!line.trim()) continue;
      const data = JSON.parse(line) as { type?: string; message?: { content?: Array<{ type: string; content?: unknown }> } };
      if (data.type === "user") for (const block of data.message?.content ?? []) if (block.type === "tool_result") results.push(typeof block.content === "string" ? block.content : JSON.stringify(block.content));
    }
    return { results, cwd };
  }
  for (const kind of ["missing", "syntax", "throws"] as const) {
    for (const step of ["Bash", "Read"] as const) {
      const { results, cwd } = await direct(mod(kind), step, "cubed");
      assert.equal(results.length, 1, `${kind} ${step}: one tool result`);
      assert.match(results[0]!, new RegExp(`PreToolUse:${step} hook error`), `${kind} ${step}: refused by the settings hook: ${results[0]}`);
      assert.ok(!hostRan(cwd) && !results[0]!.includes(cwd), `${kind} ${step}: nothing ran on the host`);
    }
  }
  console.log("ok: the gate bypassed, a modless claude code refuses Bash and Read (settings hook, dontAsk)");

  // The control: read-only Bash on the host without those flags.
  {
    tool = "Bash";
    const cwd = fs.mkdtempSync(path.join(temp, "control-"));
    const args = claudeArguments(mod("missing"), "sonnet", null);
    args.splice(args.indexOf("--permission-mode"), 2);
    args.splice(args.indexOf("--settings"), 2);
    const pwdApi = http.createServer((request, response) => {
      let body = "";
      request.on("data", chunk => { body += chunk; });
      request.on("end", () => {
        if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 1 }));
        const sent = JSON.parse(body) as { tools?: unknown[]; messages: unknown[] };
        const call = sent.tools?.length && !JSON.stringify(sent.messages).includes("tool_result");
        const events: Array<[string, Record<string, unknown>]> = [["message_start", { message: { id: "msg_c", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }]];
        events.push(call ? ["content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_control", name: "Bash", input: {} } }] : ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }],
          call ? ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command: "pwd", description: "where" }) } }] : ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } }],
          ["content_block_stop", { index: 0 }], ["message_delta", { delta: { stop_reason: call ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } }], ["message_stop", {}]);
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const [type, data] of events) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
        response.end();
      });
    });
    await new Promise<void>(resolve => pwdApi.listen(0, "127.0.0.1", resolve));
    const child = spawn(claude, args, { cwd, stdio: ["pipe", "pipe", "inherit"], env: {
      PATH: process.env.PATH, HOME: temp, CLAUDE_CONFIG_DIR: path.join(temp, "config"), ...apiEnv, ANTHROPIC_BASE_URL: `http://127.0.0.1:${(pwdApi.address() as { port: number }).port}` } });
    child.stdin.end(`${JSON.stringify({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "check" }] } })}\n`);
    const results: string[] = [];
    for await (const line of createInterface({ input: child.stdout })) {
      const data = JSON.parse(line) as { type?: string; message?: { content?: Array<{ type: string; content?: unknown }> } };
      if (data.type === "user") for (const block of data.message?.content ?? []) if (block.type === "tool_result") results.push(String(block.content));
    }
    pwdApi.close();
    assert.deepEqual(results, [fs.realpathSync(cwd)], "control: without the flags a modless claude code runs pwd on the host");
  }
  console.log("ok: control: without --settings and dontAsk, a modless claude code runs a read-only Bash on the host");

  // Part 3: a mod hook that throws refuses instead of handing the call on.
  {
    tool = "Bash";
    const { results, cwd } = await direct(mod("bash-throws"), "Bash", "before");
    assert.equal(results.length, 1);
    assert.match(results[0]!, /the mod failed on this call, so it is refused rather than run on the cubed host/, results[0]);
    assert.ok(!hostRan(cwd));
  }
  console.log("ok: a mod hook that throws refuses the call (its .catch), even without the settings hook");
} finally {
  api.close();
  server.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
