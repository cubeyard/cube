/** Phase 0 probes for same-VM subagents in claude-code threads
 * (artifact dae1c362, revision 5). Runs the real `claude` with cubed's
 * arguments, the subagent tools let back in and a probe mod
 * (scripts/fixtures/claude-subagent-probe/register.ts) that reports every
 * tool.call and agent.spawn to this script. A scripted Messages API on
 * loopback stands in for the model and a fake workspace socket for the
 * thread's machine, so no login, model or money is used.
 *
 * Every model turn is scripted by a marker `@@name@@` in the newest user
 * text: the main session's prompts and each child's prompt carry one, and
 * the number of assistant messages after it picks the step. A Bash command
 * `hold:<name>` stays running in the fake machine until the probe releases
 * or cancels it, which is how a child is kept busy.
 *
 *   node scripts/probe-claude-subagents.ts [scenario...]   (CLAUDE=<path>, PROBE_OUT=<dir>) */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { ALLOWED_TOOLS } from "../packages/claude-mod/hooks/tools.ts";
import { claudeArguments } from "../packages/server/src/claude-agent.ts";

const claude = process.env.CLAUDE ?? "claude";
const SUBAGENT_TOOLS = ["Agent", "Task", "SendMessage", "Workflow", "TaskOutput"];
const TOOLS = [...ALLOWED_TOOLS, ...SUBAGENT_TOOLS];
/** cubed's own --settings guard, with the subagent tools added to what may reach Claude Code itself. */
const SETTINGS = JSON.stringify({ hooks: { PreToolUse: [{ matcher: `^(?!(${TOOLS.filter(name => !["Bash", "Read", "Write", "Edit"].includes(name)).join("|")})$).*`, hooks: [{ type: "command", command: "exit 2" }] }] } });

type Block = { type: "tool_use"; name: string; input: Record<string, unknown> } | { type: "text"; text: string };
/** A scripted conversation: one entry per model turn after its marker. */
type Script = Record<string, Block[][]>;
type Entry = { t: number; source: string; [key: string]: unknown };

const started = Date.now();
const out = process.env.PROBE_OUT ?? fs.mkdtempSync(path.join(os.tmpdir(), "claude-subagent-probe-out-"));
fs.mkdirSync(out, { recursive: true });
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "claude-subagent-probe-"));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

let script: Script = {};
let log: Entry[] = [];
const note = (source: string, data: Record<string, unknown>) => { const entry = { t: Date.now() - started, source, ...data }; log.push(entry); return entry; };
const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map(block => (block as { text?: string; content?: unknown }).text ?? textOf((block as { content?: unknown }).content)).join(" ") : "";

const api = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const sent = JSON.parse(body) as { model?: string; tools?: Array<{ name: string; description?: string; input_schema?: unknown }>; messages: Array<{ role: string; content: unknown }> };
    let marker: string | undefined;
    let after = 0;
    for (let index = sent.messages.length - 1; index >= 0; index--) {
      const message = sent.messages[index]!;
      const found = message.role === "user" ? [...textOf(message.content).matchAll(/@@([\w-]+)@@/g)].at(-1)?.[1] : undefined;
      if (found) { marker = found; break; }
      if (message.role === "assistant") after++;
    }
    const steps = marker && sent.tools?.length ? script[marker] : undefined;
    const blocks: Block[] = steps?.[after] ?? [{ type: "text", text: `done ${marker ?? "side"}` }];
    const results = sent.messages.flatMap(message => message.role === "user" && Array.isArray(message.content) ? message.content as Array<{ type: string; tool_use_id?: string; content?: unknown }> : [])
      .filter(block => block.type === "tool_result").map(block => ({ id: block.tool_use_id, text: textOf(block.content).slice(0, 1500) }));
    note("api", { marker: marker ?? null, step: after, messages: sent.messages.length, hostPath: /\/tasks\/[0-9a-f]+\.output/.exec(JSON.stringify(sent.messages)) ? JSON.stringify(sent.messages).slice(Math.max(0, /\/tasks\/[0-9a-f]+\.output/.exec(JSON.stringify(sent.messages))!.index - 400), /\/tasks\/[0-9a-f]+\.output/.exec(JSON.stringify(sent.messages))!.index + 60) : false, markers: [...new Set([...JSON.stringify(sent.messages).matchAll(/@@([\w-]+)@@/g)].map(found => found[1]))], model: sent.model, tools: sent.tools?.map(tool => tool.name) ?? [], results, reply: blocks.map(block => block.type === "text" ? `text:${block.text}` : `${block.name}`) });
    if (sent.tools?.length && !fs.existsSync(path.join(out, "tool-schemas.json"))) fs.writeFileSync(path.join(out, "tool-schemas.json"), JSON.stringify(sent.tools.filter(tool => SUBAGENT_TOOLS.includes(tool.name) || tool.name === "TaskStop"), null, 2));
    const events: Array<[string, Record<string, unknown>]> = [["message_start", { message: { id: `msg_${randomUUID().slice(0, 8)}`, type: "message", role: "assistant", model: sent.model ?? "claude-sonnet-4-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }]];
    blocks.forEach((block, index) => {
      if (block.type === "tool_use") {
        events.push(["content_block_start", { index, content_block: { type: "tool_use", id: `toolu_${marker}_${after}_${index}`.replace(/-/g, "_"), name: block.name, input: {} } }],
          ["content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }]);
      } else {
        events.push(["content_block_start", { index, content_block: { type: "text", text: "" } }], ["content_block_delta", { index, delta: { type: "text_delta", text: block.text } }]);
      }
      events.push(["content_block_stop", { index }]);
    });
    events.push(["message_delta", { delta: { stop_reason: blocks.some(block => block.type === "tool_use") ? "tool_use" : "end_turn" }, usage: { output_tokens: 5 } }], ["message_stop", {}]);
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [type, data] of events) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    response.end();
  });
});

type Op = { key: string; command: string; state: "running" | "succeeded" | "cancelled"; waiters: Array<() => void> };
const ops = new Map<string, Op>();
let verdicts: { spawn?: (event: Record<string, unknown>) => Record<string, unknown>; answer?: (event: Record<string, unknown>) => Record<string, unknown> } = {};
const LIMITS = { maxFrameBytes: 1048576, requestTimeoutMs: 30000, maxCommandBytes: 65536, maxPathBytes: 4096, maxExecTimeoutMs: 600000, maxOutputBytes: 262144, outputPageBytes: 65536, maxReadBytes: 524288, maxWriteBytes: 524288 };
const BASE = "/api/threads/t1/workspace";
const socket = path.join(temp, "workspace.sock");
const opJson = (op: Op) => {
  if (op.state === "running") return { key: op.key, state: "running" };
  if (op.state === "cancelled") return { key: op.key, state: "failed", error: "cancelled", completionUnknown: false };
  const output = Buffer.from(`guest ran: ${op.command}\n`);
  return { key: op.key, state: "succeeded", exitCode: 0, termination: "exited", output: output.toString("base64"), outputOffset: 0, retainedBytes: output.length, outputBytes: output.length, truncated: false };
};
const settle = (op: Op, state: Op["state"]) => { op.state = state; for (const wake of op.waiters.splice(0)) wake(); };
function release(name: string) { for (const op of ops.values()) if (op.command === `hold:${name}` && op.state === "running") { note("probe", { release: op.key }); settle(op, "succeeded"); } }
const workspace = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", async () => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const json = (status: number, value: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (url.pathname.startsWith("/probe/")) {
      const kind = url.pathname.slice("/probe/".length);
      const event = JSON.parse(body || "null") as Record<string, unknown>;
      note("hook", { kind, event });
      const verdict = kind === "agent.spawn" ? verdicts.spawn?.(event) : kind === "tool.answer" ? verdicts.answer?.(event) : undefined;
      if (verdict) note("hook", { kind: `${kind}.verdict`, verdict });
      return json(200, verdict ?? {});
    }
    const route = url.pathname.slice(BASE.length);
    if (route === "") return json(200, { capabilities: [], limits: LIMITS });
    if (route === "/exec") {
      const exec = JSON.parse(body) as { key: string; command: string };
      const known = ops.get(exec.key);
      note("ws", { exec: exec.key, command: exec.command, repeat: Boolean(known) });
      if (known) return json(200, opJson(known));
      const op: Op = { key: exec.key, command: exec.command, state: exec.command.startsWith("hold:") ? "running" : "succeeded", waiters: [] };
      ops.set(exec.key, op);
      return json(200, opJson(op));
    }
    const match = /^\/operations\/([^/]+)(\/cancel)?$/.exec(route);
    if (match) {
      const op = ops.get(decodeURIComponent(match[1]!));
      if (!op) return json(404, { error: "not found", code: "NOT_FOUND", completionUnknown: false });
      if (match[2]) { note("ws", { cancel: op.key }); if (op.state === "running") settle(op, "cancelled"); return json(200, opJson(op)); }
      const wait = Number(url.searchParams.get("wait") ?? 0);
      note("ws", { poll: op.key, wait, state: op.state });
      if (op.state === "running" && wait > 0) await Promise.race([new Promise<void>(resolve => op.waiters.push(resolve)), sleep(wait)]);
      return json(200, opJson(op));
    }
    if (route === "/tools") return json(200, { tools: [] });
    if (route === "/memory") return json(200, { text: null });
    if (route === "/claude-ready") return json(200, {});
    return json(404, { error: "not found", code: "NOT_FOUND", completionUnknown: false });
  });
});
await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
await new Promise<void>(resolve => workspace.listen(socket, resolve));
const port = (api.address() as { port: number }).port;

type Line = Record<string, unknown> & { type?: string; subtype?: string };
class Session {
  readonly child: ChildProcessWithoutNullStreams;
  readonly lines: Line[] = [];
  private wakers: Array<() => void> = [];
  readonly exited: Promise<number | null>;
  constructor(env: Record<string, string> = {}, extraArgs: string[] = []) {
    const mod = path.join(temp, "mod");
    fs.rmSync(mod, { recursive: true, force: true });
    fs.cpSync(path.resolve(import.meta.dirname, "../packages/claude-mod"), mod, { recursive: true, filter: source => !source.includes(`${path.sep}.claude-plugin${path.sep}types`) });
    fs.copyFileSync(path.resolve(import.meta.dirname, "fixtures/claude-subagent-probe/register.ts"), path.join(mod, "hooks/register.ts"));
    const cwd = path.join(temp, "claude");
    fs.mkdirSync(cwd, { recursive: true });
    const args = claudeArguments(mod, "sonnet", null);
    args[args.indexOf("--tools") + 1] = TOOLS.join(",");
    args[args.indexOf("--settings") + 1] = SETTINGS;
    const child = spawn(claude, [...args, ...extraArgs], { cwd, stdio: ["pipe", "pipe", "pipe"], env: {
      PATH: process.env.PATH!, HOME: temp, CLAUDE_CONFIG_DIR: path.join(temp, "config"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "sk-probe",
      CUBE_WORKSPACE_SOCKET: socket, CUBE_WORKSPACE_PATH: BASE, CUBE_WORKSPACE_TOKEN: "a".repeat(64), CUBE_WORKSPACE_ROOT: cwd, ...env } });
    this.child = child;
    child.stderr.on("data", chunk => note("stderr", { text: String(chunk).slice(0, 500) }));
    this.exited = new Promise(resolve => child.on("exit", code => resolve(code)));
    void (async () => {
      for await (const raw of createInterface({ input: child.stdout })) {
        if (!raw.trim()) continue;
        const line = JSON.parse(raw) as Line;
        if (line.type === "stream_event") continue;
        this.lines.push(line);
        note("out", { line });
        for (const wake of this.wakers.splice(0)) wake();
      }
      for (const wake of this.wakers.splice(0)) wake();
    })();
  }
  write(value: unknown) { note("in", { value }); this.child.stdin.write(`${JSON.stringify(value)}\n`); }
  prompt(text: string) { this.write({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text }] } }); }
  control(request: Record<string, unknown>): string { const id = randomUUID(); this.write({ type: "control_request", request_id: id, request }); return id; }
  async until<T>(find: (lines: Line[]) => T | undefined, ms: number, what: string): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const found = find(this.lines);
      if (found !== undefined && found !== false) return found;
      if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
      await Promise.race([new Promise<void>(resolve => this.wakers.push(resolve)), sleep(200)]);
    }
  }
  results(): Line[] { return this.lines.filter(line => line.type === "result"); }
  tasks(subtype?: string): Line[] { return this.lines.filter(line => line.type === "system" && String(line.subtype).startsWith("task_") && (!subtype || line.subtype === subtype)); }
  async close() {
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 15000);
    await this.exited;
    clearTimeout(timer);
  }
}

const untilLog = async <T>(find: () => T | undefined, ms: number, what: string): Promise<T> => {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found !== undefined && found !== false) return found;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleep(100);
  }
};
const held = (name: string) => untilLog(() => [...ops.values()].find(op => op.command === `hold:${name}` && op.state === "running"), 30000, `hold:${name} to run`);
const agent = (name: string, background: boolean, extra: Record<string, unknown> = {}): Block => ({ type: "tool_use", name: "Agent", input: { description: `probe ${name}`, prompt: `@@${name}@@ do the probe step`, name, run_in_background: background, ...extra } });
const bashStep = (command: string): Block[] => [{ type: "tool_use", name: "Bash", input: { command, description: "probe step" } }];
const say = (text: string): Block[] => [{ type: "text", text }];

/** Process count and RSS of the claude process and its descendants, from /proc. */
function tree(pid: number): { processes: number; rssKiB: number; names: string[] } {
  const parents = new Map<number, number>();
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try { const stat = fs.readFileSync(`/proc/${entry}/stat`, "utf8"); parents.set(Number(entry), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1])); } catch { /* gone */ }
  }
  const members = [pid];
  for (let index = 0; index < members.length; index++) for (const [child, parent] of parents) if (parent === members[index]) members.push(child);
  let rssKiB = 0;
  const names: string[] = [];
  for (const member of members) {
    try {
      const status = fs.readFileSync(`/proc/${member}/status`, "utf8");
      rssKiB += Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0);
      names.push(/Name:\s+(\S+)/.exec(status)?.[1] ?? "?");
    } catch { /* gone */ }
  }
  return { processes: members.length, rssKiB, names };
}

type Outcome = { status: "pass" | "fail" | "unknown"; facts: Record<string, unknown> };
const scenarios: Record<string, () => Promise<Outcome>> = {};

/** 1: a foreground and a background Agent in one message; their Bash reaches the machine under their own ids. */
scenarios.fgbg = async () => {
  script = {
    "main-fgbg": [[agent("fg1", false), agent("bg1", true)], say("main turn done")],
    fg1: [bashStep("echo fg1"), say("fg1 finished")],
    bg1: [bashStep("echo bg1"), say("bg1 finished")],
  };
  const session = new Session();
  session.prompt("@@main-fgbg@@ start two agents");
  await session.until(lines => session.tasks("task_notification").length >= 2 && lines.findLastIndex(line => line.type === "result") > lines.findLastIndex(line => line.subtype === "task_notification"), 60000, "both agents notified and a turn ended after");
  await sleep(500);
  await session.close();
  const execs = log.filter(entry => entry.source === "ws" && entry.exec).map(entry => entry.exec);
  const calls = log.filter(entry => entry.source === "hook" && entry.kind === "tool.call").map(entry => { const event = entry.event as Record<string, unknown>; return { tool: event.tool, tool_use_id: event.tool_use_id, keys: Object.keys(event).sort() }; });
  const spawns = log.filter(entry => entry.source === "hook" && entry.kind === "agent.spawn").map(entry => entry.event);
  const childLines = session.lines.filter(line => line.parent_tool_use_id).map(line => ({ type: line.type, parent: line.parent_tool_use_id }));
  return { status: execs.length === 2 ? "pass" : "fail", facts: { execs, calls, spawns, tasks: session.tasks(), childLines, results: session.results().map(line => ({ subtype: line.subtype, num_turns: line.num_turns })) } };
};

const toolResult = (session: Session, id: string) => session.lines.filter(line => line.type === "user" && !line.parent_tool_use_id)
  .flatMap(line => ((line.message as { content?: unknown })?.content as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }> | undefined) ?? [])
  .find(block => block.type === "tool_result" && block.tool_use_id === id);
const taskOf = (session: Session, toolUseId: string) => session.tasks("task_started").find(line => line.tool_use_id === toolUseId)?.task_id as string | undefined;
const notified = (session: Session, taskId: string) => session.tasks("task_notification").find(line => line.task_id === taskId);
const controlReply = (session: Session, id: string) => session.lines.find(line => line.type === "control_response" && (line.response as { request_id?: string })?.request_id === id);
/** The Bash calls still open for one agent (null: the main loop), from stdout alone, as cubed would track them. */
const openBash = (session: Session, agentId: string | null | "all") => {
  const open = new Set<string>();
  for (const line of session.lines) {
    const owner = (line.agent_id as string | undefined) ?? null;
    for (const block of ((line.message as { content?: unknown })?.content as Array<{ type: string; id?: string; name?: string; tool_use_id?: string }> | undefined) ?? []) {
      if (!Array.isArray((line.message as { content?: unknown })?.content)) break;
      if (line.type === "assistant" && block.type === "tool_use" && block.name === "Bash" && (agentId === "all" || owner === agentId)) open.add(`claude:${block.id}:bash`);
      if (line.type === "user" && block.type === "tool_result" && block.tool_use_id) open.delete(`claude:${block.tool_use_id}:bash`);
    }
  }
  return [...open];
};
const wsEntries = (field: "exec" | "cancel" | "poll") => log.filter(entry => entry.source === "ws" && entry[field]).map(entry => ({ t: entry.t, key: entry[field], repeat: entry.repeat }));
const short = (value: unknown, length = 400) => { const text = typeof value === "string" ? value : JSON.stringify(value); return text.length > length ? `${text.slice(0, length)}…` : text; };

/** 2: SendMessage to a finished background agent resumes it from its transcript. */
scenarios.send = async () => {
  script = { "main-send1": [[agent("bg2", true)], say("launched")], bg2: [bashStep("echo bg2"), say("bg2 first answer")], "bg2-again": [bashStep("echo bg2 again"), say("bg2 second answer")] };
  const session = new Session();
  session.prompt("@@main-send1@@ start one");
  const first = await session.until(() => { const id = taskOf(session, "toolu_main_send1_0_0"); return id && notified(session, id) && id; }, 60000, "bg2 to finish");
  await session.until(lines => lines.findLastIndex(line => line.type === "result") > lines.findLastIndex(line => line.subtype === "task_notification") || undefined, 60000, "the turn after bg2");
  script["main-send2"] = [[{ type: "tool_use", name: "SendMessage", input: { to: first, summary: "probe resume", message: "@@bg2-again@@ continue the work" } }], say("sent")];
  session.prompt("@@main-send2@@ continue bg2");
  await session.until(() => wsEntries("exec").some(entry => entry.key === "claude:toolu_bg2_again_0_0:bash") || undefined, 60000, "bg2's second Bash");
  await session.until(lines => lines.findLastIndex(line => line.type === "result") > lines.findLastIndex(line => line.subtype === "task_notification") && session.tasks("task_notification").length >= 2 || undefined, 60000, "bg2's second notification and the turn after");
  await session.close();
  const resumed = log.find(entry => entry.source === "api" && entry.marker === "bg2-again" && entry.step === 0)!;
  const sendResult = toolResult(session, "toolu_main_send2_0_0");
  return { status: resumed && (resumed.markers as string[]).includes("bg2") ? "pass" : "fail", facts: {
    agentId: first, resumedRequest: { messages: resumed?.messages, markers: resumed?.markers }, sendMessageResult: short(sendResult?.content), sendMessageError: sendResult?.is_error ?? false,
    tasks: session.tasks().map(line => ({ subtype: line.subtype, task_id: line.task_id, tool_use_id: line.tool_use_id, status: line.status, is_backgrounded: line.is_backgrounded, patch: line.patch })), execs: wsEntries("exec") } };
};

/** 3a: a host moves a running foreground agent to the background with the background_tasks control request. */
scenarios.fg2bg = async () => {
  script = { "main-fg2bg": [[agent("slow", false)], say("main went on")], slow: [bashStep("hold:slow"), say("slow finished")] };
  const session = new Session();
  session.prompt("@@main-fg2bg@@ start a foreground agent");
  await held("slow");
  const asked = Date.now();
  const request = session.control({ subtype: "background_tasks", tool_use_id: "toolu_main_fg2bg_0_0" });
  const reply = await session.until(() => controlReply(session, request), 15000, "the control response");
  const result = await session.until(() => toolResult(session, "toolu_main_fg2bg_0_0"), 15000, "the Agent tool result");
  const returnedMs = Date.now() - asked;
  await session.until(lines => lines.some(line => line.type === "result") || undefined, 30000, "the main turn to end while the child is held");
  const turnEndedWhileHeld = [...ops.values()].some(op => op.command === "hold:slow" && op.state === "running");
  release("slow");
  const taskId = taskOf(session, "toolu_main_fg2bg_0_0")!;
  const notice = await session.until(() => notified(session, taskId), 30000, "the child's notification");
  await session.until(lines => lines.findLastIndex(line => line.type === "result") > lines.findLastIndex(line => line.subtype === "task_notification") || undefined, 30000, "the follow-up turn");
  await session.close();
  const holdExecs = wsEntries("exec").filter(entry => String(entry.key).includes("toolu_slow_0_0"));
  return { status: result && !result.is_error && turnEndedWhileHeld && notice.status === "completed" && holdExecs.filter(entry => !entry.repeat).length === 1 && wsEntries("cancel").length === 0 ? "pass" : "fail", facts: {
    controlResponse: reply.response, toolResultMs: returnedMs, toolResult: short(result?.content, 700), turnEndedWhileHeld, notification: { status: notice.status, summary: notice.summary },
    updates: session.tasks("task_updated").map(line => line.patch), holdExecs, cancels: wsEntries("cancel"), results: session.results().length } };
};

/** 3b: whether Claude Code backgrounds a foreground agent by itself in -p (CLAUDE_AUTO_BACKGROUND_TASKS). */
scenarios.autobg = async () => {
  script = { "main-autobg": [[agent("auto", false)], say("main went on")], auto: [bashStep("hold:auto"), say("auto finished")] };
  const session = new Session({ CLAUDE_AUTO_BACKGROUND_TASKS: "1", CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS: "5000" });
  session.prompt("@@main-autobg@@ start a foreground agent");
  await held("auto");
  const since = Date.now();
  let result: ReturnType<typeof toolResult>;
  try { result = await session.until(() => toolResult(session, "toolu_main_autobg_0_0"), 150000, "an automatic move to the background"); } catch { result = undefined; }
  const waitedMs = Date.now() - since;
  release("auto");
  await session.until(lines => lines.findLastIndex(line => line.type === "result") > lines.findLastIndex(line => line.subtype === "task_notification") && session.tasks("task_notification").length > 0 || undefined, 30000, "the end");
  await session.close();
  return { status: result ? "pass" : "fail", facts: { env: "CLAUDE_AUTO_BACKGROUND_TASKS=1 CLAUDE_CODE_AUTO_BACKGROUND_TIMEOUT_MS=5000", backgroundedAfterMs: result ? waitedMs : null, waitedMs, toolResult: short(result?.content, 500), updates: session.tasks("task_updated").map(line => line.patch) } };
};

/** 3c: the default (-p, no CLAUDE_AUTO_BACKGROUND_TASKS): a foreground agent held 150 s is not moved to the background. */
scenarios.autobgoff = async () => {
  script = { "main-autobgoff": [[agent("noauto", false)], say("main went on")], noauto: [bashStep("hold:noauto"), say("noauto finished")] };
  const session = new Session();
  session.prompt("@@main-autobgoff@@ start a foreground agent");
  await held("noauto");
  await sleep(150000);
  const early = toolResult(session, "toolu_main_autobgoff_0_0");
  release("noauto");
  const result = await session.until(() => toolResult(session, "toolu_main_autobgoff_0_0"), 30000, "the foreground result");
  await session.until(lines => lines.some(line => line.type === "result") || undefined, 30000, "the turn");
  await session.close();
  return { status: early === undefined ? "pass" : "fail", facts: { backgroundedWithin150s: early !== undefined, updates: session.tasks("task_updated").map(line => line.patch), finalResult: short(result.content, 300) } };
};

/** 8b: with Workflow explicitly allowed (cubed's dontAsk refuses it otherwise), do its agents pass agent.spawn, which refuses them all here? */
scenarios.workflow = async () => {
  const body = "export const meta = { name: 'probe', description: 'probe', phases: [] }\nconst answers = await parallel([() => agent('@@wf1@@ go'), () => agent('@@wf2@@ go')])\nreturn answers";
  script = { "main-wf": [[{ type: "tool_use", name: "Workflow", input: { script: body } }], say("workflow done")], wf1: [bashStep("echo wf1"), say("wf1 finished")], wf2: [bashStep("echo wf2"), say("wf2 finished")] };
  verdicts.spawn = () => ({ deny: "cube: probe refuses every spawn" });
  const session = new Session({}, ["--allowedTools", "Workflow"]);
  session.prompt("@@main-wf@@ run a workflow");
  await session.until(lines => lines.some(line => line.type === "result") || undefined, 90000, "the workflow turn");
  await sleep(2000);
  await session.close();
  const spawnHooks = log.filter(entry => entry.source === "hook" && entry.kind === "agent.spawn").map(entry => short(entry.event, 400));
  const childRequests = log.filter(entry => entry.source === "api" && String(entry.marker).startsWith("wf")).map(entry => entry.marker);
  const execs = wsEntries("exec").map(entry => entry.key);
  const childCalls = log.filter(entry => entry.source === "hook" && entry.kind === "tool.call" && (entry.event as Record<string, unknown>).tool === "Bash").map(entry => short(entry.event, 300));
  return { status: childRequests.length === 0 ? "pass" : "fail", facts: { spawnHooks, childModelRequests: childRequests, execs, childToolCalls: childCalls,
    toolResult: short(toolResult(session, "toolu_main_wf_0_0")?.content, 800), tasks: session.tasks().map(line => short({ subtype: line.subtype, task_type: line.task_type, tool_use_id: line.tool_use_id, status: line.status, spawn_depth: line.spawn_depth }, 300)) } };
};

/** 8c: Workflow agents admitted: what stdout says about each one, which a running cap counted by cubed needs. */
scenarios.workflowrun = async () => {
  const body = "export const meta = { name: 'probe', description: 'probe', phases: [] }\nconst answers = await parallel([() => agent('@@wr1@@ go'), () => agent('@@wr2@@ go')])\nreturn answers";
  script = { "main-wr": [[{ type: "tool_use", name: "Workflow", input: { script: body } }], say("workflow done")], wr1: [bashStep("echo wr1"), say("wr1 finished")], wr2: [bashStep("echo wr2"), say("wr2 finished")] };
  const session = new Session({}, ["--allowedTools", "Workflow"]);
  session.prompt("@@main-wr@@ run a workflow");
  await session.until(() => session.tasks("task_notification").length > 0 || undefined, 90000, "the workflow's notification");
  await session.until(lines => lines.findLastIndex(line => line.type === "result") > lines.findLastIndex(line => line.subtype === "task_notification") || undefined, 60000, "the turn after");
  await session.close();
  const childCalls = log.filter(entry => entry.source === "hook" && entry.kind === "tool.call" && (entry.event as Record<string, unknown>).tool === "Bash").map(entry => entry.event);
  const childLines = session.lines.filter(line => line.agent_id || line.parent_tool_use_id).map(line => ({ type: line.type, parent: line.parent_tool_use_id, agent: line.agent_id }));
  return { status: wsEntries("exec").length === 2 ? "pass" : "fail", facts: { execs: wsEntries("exec").map(entry => entry.key), childToolCalls: childCalls, stdoutChildLines: childLines.length, sampleChildLine: childLines[0] ?? null,
    tasks: session.tasks().map(line => ({ subtype: line.subtype, task_id: line.task_id, task_type: line.task_type, status: line.status, summary: short(line.summary ?? line.description ?? "", 80) })) } };
};

/** 4: stop_task on a background agent, then on a foreground one: each stops alone, and stdout attributes each open Bash to its agent. */
scenarios.stop = async () => {
  script = { "main-stop": [[agent("sfg", false), agent("sbg", true)], say("after stops")], sfg: [bashStep("hold:sfg"), say("sfg finished")], sbg: [bashStep("hold:sbg"), say("sbg finished")] };
  const session = new Session();
  session.prompt("@@main-stop@@ start two");
  await held("sfg"); await held("sbg");
  const bg = taskOf(session, "toolu_main_stop_0_1")!; const fg = taskOf(session, "toolu_main_stop_0_0")!;
  const attribution = { [bg]: openBash(session, bg), [fg]: openBash(session, fg), main: openBash(session, null) };
  const stopBg = session.control({ subtype: "stop_task", task_id: bg });
  const bgNotice = await session.until(() => notified(session, bg), 20000, "the background agent's stop");
  const fgStillRunning = [...ops.values()].some(op => op.command === "hold:sfg" && op.state === "running");
  await sleep(500);
  const cancelsAfterBg = wsEntries("cancel");
  const stopFg = session.control({ subtype: "stop_task", task_id: fg });
  const fgNotice = await session.until(() => notified(session, fg), 20000, "the foreground agent's stop");
  const fgResult = await session.until(() => toolResult(session, "toolu_main_stop_0_0"), 20000, "the foreground Agent result");
  await session.until(lines => lines.some(line => line.type === "result") || undefined, 20000, "the main turn");
  await sleep(500);
  await session.close();
  return { status: bgNotice.status === "stopped" && fgNotice.status === "stopped" && fgStillRunning ? "pass" : "fail", facts: {
    openBashByAgentFromStdout: attribution, taskIdEqualsAgentId: session.lines.filter(line => line.agent_id).every(line => [bg, fg].includes(line.agent_id as string)),
    replies: [controlReply(session, stopBg)?.response, controlReply(session, stopFg)?.response], bgNotice: { status: bgNotice.status, summary: bgNotice.summary }, fgStillRunningAfterBgStop: fgStillRunning,
    cancelsAfterBgStop: cancelsAfterBg, fgNotice: { status: fgNotice.status, summary: fgNotice.summary }, fgToolResult: short(fgResult.content), cancels: wsEntries("cancel"),
    stillHeldAtEnd: [...ops.values()].filter(op => op.state === "running").map(op => op.key) } };
};

/** 5: an interrupt (cubed's stop: cancel_queued, no perTaskStopAffordance) stops foreground and background agents; stdout names every open Bash for cubed to cancel. */
scenarios.interrupt = async () => {
  script = { "main-interrupt": [[agent("ifg", false), agent("ibg", true)], say("after interrupt")], ifg: [bashStep("hold:ifg"), say("ifg finished")], ibg: [bashStep("hold:ibg"), say("ibg finished")] };
  const session = new Session();
  session.prompt("@@main-interrupt@@ start two");
  await held("ifg"); await held("ibg");
  const openAtInterrupt = openBash(session, "all");
  const request = session.control({ subtype: "interrupt", cancel_queued: true });
  await session.until(lines => lines.some(line => line.type === "result") || undefined, 20000, "the interrupted turn");
  const bg = taskOf(session, "toolu_main_interrupt_0_1")!; const fg = taskOf(session, "toolu_main_interrupt_0_0")!;
  await session.until(() => (notified(session, bg) && notified(session, fg)) || undefined, 20000, "both notifications").catch(() => undefined);
  await sleep(1000);
  const running = [...ops.values()].filter(op => op.state === "running").map(op => op.key);
  await session.close();
  return { status: notified(session, bg)?.status === "stopped" && notified(session, fg)?.status === "stopped" ? "pass" : "fail", facts: {
    guestCommandsCancelledByClaudeCode: wsEntries("cancel").length > 0, openBashFromStdoutAtInterrupt: openAtInterrupt, reply: controlReply(session, request)?.response, fg: notified(session, fg) && { status: notified(session, fg)!.status }, bg: notified(session, bg) && { status: notified(session, bg)!.status },
    cancels: wsEntries("cancel"), stillHeld: running, result: session.results().map(line => ({ subtype: line.subtype, is_error: line.is_error })), updates: session.tasks("task_updated").map(line => ({ task: line.task_id, patch: line.patch })) } };
};

/** 6: whether the mod can rewrite the Agent tool's result (drop the host outputFile) and force a spawn into the background. */
scenarios.rewrite = async () => {
  script = { "main-rewrite": [[agent("rbg", true, { model: "opus" }), agent("rforced", false)], say("after rewrite")], rbg: [say("rbg finished")], rforced: [bashStep("hold:rforced"), say("rforced finished")] };
  const REPLACED = "cube: agent rbg runs in the background; its answer arrives as a message. agent.list shows it.";
  verdicts.answer = event => {
    const answer = event.answer as { result?: Record<string, unknown>; text?: string } | undefined;
    if (event.tool !== "Agent" || answer?.result?.status !== "async_launched") return {};
    return { result: { ...answer, result: { ...answer.result, outputFile: "(not readable in cube)", canReadOutputFile: false }, text: `${REPLACED} id ${answer.result.agentId}` } };
  };
  verdicts.spawn = event => event.name === "rforced" ? { rewrite: { background: true } } : {};
  const session = new Session();
  session.prompt("@@main-rewrite@@ start two");
  await session.until(() => toolResult(session, "toolu_main_rewrite_0_0") && toolResult(session, "toolu_main_rewrite_0_1"), 30000, "both Agent results");
  await held("rforced");
  release("rforced");
  await session.until(lines => session.tasks("task_notification").length >= 2 && lines.findLastIndex(line => line.type === "result") > lines.findLastIndex(line => line.subtype === "task_notification") || undefined, 30000, "both notifications and a turn after");
  await session.close();
  const seen = log.filter(entry => entry.source === "api" && entry.marker === "main-rewrite").flatMap(entry => entry.results as Array<{ id: string; text: string }>);
  const rbgSeen = seen.find(result => result.id === "toolu_main_rewrite_0_0")?.text ?? "";
  const forcedStart = session.tasks("task_started").find(line => line.tool_use_id === "toolu_main_rewrite_0_1");
  const outputPathsToModel = log.filter(entry => entry.source === "api" && entry.hostPath).map(entry => ({ marker: entry.marker, context: entry.hostPath }));
  return { status: rbgSeen && !/output_file/.test(rbgSeen) ? "pass" : "fail", facts: {
    childModels: Object.fromEntries(log.filter(entry => entry.source === "api" && ["rbg", "rforced", "main-rewrite"].includes(String(entry.marker))).map(entry => [entry.marker, entry.model])),
    spawnModelField: log.filter(entry => entry.kind === "agent.spawn").map(entry => ({ name: (entry.event as Record<string, unknown>).name, model: (entry.event as Record<string, unknown>).model ?? null })),
    launchResultHasOutputFile: /output_file/.test(rbgSeen), replacementTextUsed: rbgSeen.includes("cube: agent rbg"),
    modelSawForRbg: short(rbgSeen, 500), streamToolResultForRbg: short(toolResult(session, "toolu_main_rewrite_0_0")?.content, 300), forcedSpawnStartedBackgrounded: forcedStart?.is_backgrounded, forcedToolResult: short(toolResult(session, "toolu_main_rewrite_0_1")?.content, 300),
    apiRequestsWithHostOutputPath: outputPathsToModel, notificationsOutputFile: session.tasks("task_notification").map(line => line.output_file) } };
};

/** 7 and 8: the running cap and depth 1 held by agent.spawn, and processes/RSS per agent. */
scenarios.limits = async () => {
  const CAP = 8;
  const names = Array.from({ length: CAP + 1 }, (_, index) => `cap${index}`);
  script = { "main-limits": [names.map(name => agent(name, true)), say("spawned")] };
  for (const name of names) script[name] = [[agent(`deep-${name}`, true)], bashStep(`hold:${name}`), say(`${name} finished`)];
  const admitted = new Set<string>();
  const mainCalls = (session: Session) => new Set(session.lines.filter(line => line.type === "assistant" && !line.parent_tool_use_id).flatMap(line => ((line.message as { content?: Array<{ type: string; id?: string }> }).content ?? []).filter(block => block.type === "tool_use").map(block => block.id!)));
  const session = new Session();
  verdicts.spawn = event => {
    const id = String(event.tool_use_id ?? "");
    if (!mainCalls(session).has(id)) return { deny: "cube: depth 1, a child starts no agents" };
    const ended = new Set(session.tasks("task_notification").map(line => line.tool_use_id as string));
    const running = [...admitted].filter(call => !ended.has(call)).length;
    if (running >= CAP) return { deny: `cube: ${CAP} agents are running in this thread; wait for one or stop one` };
    admitted.add(id);
    return {};
  };
  session.prompt("@@main-idle@@ warm up");
  await session.until(lines => lines.some(line => line.type === "result") || undefined, 30000, "the warm-up turn");
  await sleep(1500);
  const idle = tree(session.child.pid!);
  session.prompt("@@main-limits@@ start nine");
  await untilLog(() => [...ops.values()].filter(op => op.state === "running").length >= CAP || undefined, 30000, `${CAP} held agents`);
  await sleep(1500);
  const loaded = tree(session.child.pid!);
  const launches = await session.until(() => { const all = names.map((_, index) => toolResult(session, `toolu_main_limits_0_${index}`)); return all.every(Boolean) ? all : undefined; }, 15000, "all nine Agent results");
  const refused = launches.filter(result => result!.is_error);
  const deeps = log.filter(entry => entry.source === "hook" && entry.kind === "agent.spawn" && String((entry.event as Record<string, unknown>).name).startsWith("deep-"));
  for (const name of names) release(name);
  await session.until(() => session.tasks("task_notification").length >= CAP || undefined, 60000, "eight notifications");
  await session.close();
  const deepRan = log.some(entry => entry.source === "api" && String(entry.marker).startsWith("deep-"));
  const depthRefusals = log.filter(entry => entry.kind === "agent.spawn.verdict" && JSON.stringify(entry.verdict).includes("depth")).length;
  return { status: refused.length === 1 && deeps.length === CAP && depthRefusals === CAP && !deepRan ? "pass" : "fail", facts: {
    refusedLaunches: refused.map(result => short(result!.content)), nestedSpawns: deeps.length, depthRefusals, nestedSpawnEvent: short(deeps[0]?.event, 600),
    deepRan, processes: { idle, withEightAgents: loaded }, rssPerAgentKiB: Math.round((loaded.rssKiB - idle.rssKiB) / CAP) } };
};

/** Confirms cubed's premise for children: neither an interrupt nor stop_task aborts the mod's Bash hook, so no cancel reaches the machine and the hook stops polling. */
scenarios.cancel = async () => {
  script = { "main-cancel1": [bashStep("hold:top"), say("after top")], "main-cancel2": [[agent("cbg", true)], say("launched")], cbg: [bashStep("hold:cbg"), say("cbg finished")] };
  const session = new Session();
  session.prompt("@@main-cancel1@@ run a long command");
  await held("top");
  const interrupted = Date.now();
  session.control({ subtype: "interrupt", cancel_queued: true });
  await session.until(lines => lines.some(line => line.type === "result") || undefined, 20000, "the interrupted turn");
  const topCancel = await untilLog(() => wsEntries("cancel").find(entry => String(entry.key).includes("toolu_main_cancel1")), 10000, "the top-level cancel").catch(() => undefined);
  const topCancelMs = topCancel ? Date.now() - interrupted : null;
  session.prompt("@@main-cancel2@@ start one");
  await held("cbg");
  const taskId = await session.until(() => taskOf(session, "toolu_main_cancel2_0_0"), 10000, "cbg's task");
  const stopAt = log.length;
  session.control({ subtype: "stop_task", task_id: taskId });
  await session.until(() => notified(session, taskId), 20000, "cbg stopped");
  await sleep(25000);
  const after = log.slice(stopAt).filter(entry => entry.source === "ws" || entry.source === "hook").map(entry => ({ t: entry.t, poll: entry.poll, cancel: entry.cancel, kind: entry.kind, state: entry.state }));
  const stillHeld = [...ops.values()].filter(op => op.state === "running").map(op => op.key);
  release("cbg");
  await sleep(2000);
  const lateResult = log.slice(stopAt).filter(entry => entry.source === "hook" && entry.kind === "tool.workspace");
  await session.close();
  return { status: !topCancel && stillHeld.length === 2 && after.length === 0 ? "pass" : "fail", facts: { claim: "claude code rejects a stopped tool use without aborting the mod's hook, so cubed must cancel guest commands itself (claude-agent.ts:444), for stop_task on a child as for an interrupt", topLevelCancelled: Boolean(topCancel), topCancelMs, childGuestTrafficIn25sAfterStop: after, childStillHeldAfter25s: stillHeld, childHookFinishedAfterRelease: lateResult.map(entry => entry.event) } };
};

const runOnly = process.argv.slice(2);
const report: Record<string, Outcome | { status: "error"; error: string }> = {};
try {
  const version = await new Promise<string>(resolve => { const p = spawn(claude, ["--version"]); let text = ""; p.stdout.on("data", chunk => { text += chunk; }); p.on("exit", () => resolve(text.trim())); });
  note("probe", { claude, version });
  for (const [name, run] of Object.entries(scenarios)) {
    if (runOnly.length && !runOnly.includes(name)) continue;
    log = []; ops.clear(); verdicts = {}; script = {};
    note("probe", { scenario: name });
    try {
      report[name] = await run();
    } catch (error) {
      report[name] = { status: "error", error: error instanceof Error ? error.stack ?? error.message : String(error) };
    }
    fs.writeFileSync(path.join(out, `${name}.jsonl`), log.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    console.log(`${name}: ${JSON.stringify(report[name], null, 1).slice(0, 4000)}`);
  }
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify({ claude: version, report }, null, 2));
  console.log(`claude ${version}; logs in ${out}`);
} finally {
  api.close();
  workspace.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
