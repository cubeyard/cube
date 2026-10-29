/** Checks, with a real `claude`, that OptChat's memory never costs a Claude
 * Code thread its workspace context. Like scripts/check-claude-fail-closed.ts
 * it runs cubed's ClaudeAgent with cube's mod against a scripted Messages API
 * on loopback (a placeholder key, its own config directory: no login, model
 * or provider) over the workspace routes and the real guest helper in a
 * temporary root (test/local-guest.ts, not runner acceptance). Here the
 * socket's `…/workspace/memory` route answers in five ways, and each turn's
 * first model request is read:
 *   - with memory: the `cubeMemory` block comes before the workspace's, with
 *     the same bytes on a second turn and on a resume;
 *   - none, failing (500), slower than the mod waits, hung: no memory, and
 *     the workspace block whole (the VM orientation, the repository's
 *     AGENTS.md, the skills), the hung and slow ones within the mod's bound.
 *
 *   node scripts/check-claude-memory.ts   (CLAUDE=<path> names the binary) */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ClaudeAgent, type ClaudeRuntime } from "../packages/server/src/claude-agent.ts";
import { claudeCodeOnly, toolsRoute } from "../packages/server/src/cube-tools.ts";
import { VmWorkspace } from "../packages/server/src/vm-workspace.ts";
import { workspaceRoute } from "../packages/server/src/workspace-http.ts";
import { LeaseStore } from "../packages/server/src/workspace-lease.ts";
import { LocalGuestTransport } from "../packages/server/test/local-guest.ts";

const claude = process.env.CLAUDE ?? "claude";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-claude-memory-"));
const MEMORY = "Chat memory: check view\n<chat>\n0+1|user: the release codename is HERON\n</chat>";
const RULE = "cube-check-rule: run the tests before every push";
const SKILLS = "<available_skills>\n  <skill>\n    <name>cube-check-skill</name>\n  </skill>\n</available_skills>";
/** The mod waits 8 s for the route (register.ts MEMORY_WAIT_MS). */
const MOD_WAIT_MS = 8000;

/** Every model request's body, as text, with when it came. */
const requests: Array<{ at: number; text: string }> = [];
const api = http.createServer((request, response) => {
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const sent = JSON.parse(body) as { tools?: unknown[] };
    if (sent.tools?.length) requests.push({ at: Date.now(), text: body });
    const events: Array<[string, Record<string, unknown>]> = [
      ["message_start", { message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
      ["content_block_start", { index: 0, content_block: { type: "text", text: "" } }], ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } }],
      ["content_block_stop", { index: 0 }], ["message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }], ["message_stop", {}]];
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [type, data] of events) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    response.end();
  });
});
await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
const port = (api.address() as { port: number }).port;
const apiEnv = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "sk-check", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };

const guest = new LocalGuestTransport(path.join(temp, "guest"));
fs.writeFileSync(path.join(guest.workspace, "AGENTS.md"), `# Working on the check\n\n${RULE}\n`);
const workspace = new VmWorkspace({ guest, leases: new LeaseStore(path.join(temp, "thread")), owner: "claude-code", binding: guest.binding });
const BASE = "/api/threads/t1/workspace";
const socket = path.join(temp, "workspace.sock");
type Mode = "memory" | "none" | "failing" | "slow" | "hung";
let mode: Mode = "memory";
/** Requests the route left unanswered (hung), answered at the end. */
const held: http.ServerResponse[] = [];
let memoryAsks = 0;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url!, "http://localhost");
  let raw = "";
  for await (const chunk of request) raw += chunk;
  if (!url.pathname.startsWith(BASE)) return response.writeHead(404).end("{}");
  const parts = url.pathname.slice(BASE.length).split("/").filter(Boolean).map(decodeURIComponent);
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1];
  const send = (status: number, value: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  if (parts[0] === "memory") {
    memoryAsks++;
    const refused = await claudeCodeOnly(token, held => workspace.lease({ token: held }).catch(() => null));
    if (refused) return send(refused.status, refused.body);
    if (mode === "memory") return send(200, { text: MEMORY });
    if (mode === "none") return send(200, { text: null });
    if (mode === "failing") return send(500, { error: "cube check: the memory route fails", code: "IO_ERROR", completionUnknown: false });
    if (mode === "slow") { await delay(MOD_WAIT_MS + 4000); return send(200, { text: MEMORY }); }
    held.push(response);
    return;
  }
  const result = parts[0] === "tools"
    ? await toolsRoute({ method: request.method!, name: parts[1], token, body, signal: new AbortController().signal }, held => workspace.lease({ token: held }).catch(() => null), () => [])
    : await workspaceRoute(workspace, { method: request.method!, parts, query: url.searchParams, headers: request.headers, body, thread: "t1" });
  send(result.status, result.body);
});
await new Promise<void>(resolve => server.listen(socket, resolve));

const mod = path.join(temp, "mod");
fs.cpSync(path.resolve(import.meta.dirname, "../packages/claude-mod"), mod, { recursive: true, filter: source => !source.includes(`${path.sep}.claude-plugin${path.sep}types`) });
const runtime: ClaudeRuntime = {
  command: ["/usr/bin/env", ...Object.entries(apiEnv).map(([name, value]) => `${name}=${value}`), `CLAUDE_CONFIG_DIR=${path.join(temp, "config")}`, `HOME=${temp}`, claude],
  mod, socket, modReadyMs: 15000,
};
/** One turn: its first model request's body, and how long after the submit it came. */
async function turn(agent: ClaudeAgent, requestId: string): Promise<{ text: string; ms: number }> {
  const before = requests.length;
  const at = Date.now();
  await agent.submit(requestId, "check");
  for (const deadline = Date.now() + 90000; ;) {
    const submission = agent.state().submissions.find(item => item.requestId === requestId)!;
    if (submission.state !== "running") {
      assert.equal(submission.state, "completed", `${requestId}: ${submission.error}`);
      assert.ok(requests.length > before, `${requestId}: the model was asked`);
      return { text: requests[before]!.text, ms: requests[before]!.at - at };
    }
    assert.ok(Date.now() < deadline, `${requestId} settles`);
    await delay(50);
  }
}
/** The workspace block whole: orientation, the repository's AGENTS.md, the skills. */
function workspaceWhole(text: string, what: string) {
  assert.match(text, /You are working in a cube thread\./, `${what}: the VM orientation`);
  assert.ok(text.includes(RULE), `${what}: the repository's AGENTS.md`);
  assert.ok(text.includes("cube-check-skill"), `${what}: the skills`);
}
/** The memory as the request body carries it (JSON-escaped), byte for byte. */
const memoryIn = (text: string) => text.includes(JSON.stringify(MEMORY).slice(1, -1));

try {
  {
    mode = "memory";
    const agent = await ClaudeAgent.open({ directory: path.join(temp, "agent-memory"), threadId: "t1", workspace, runtime, model: "sonnet", skills: SKILLS });
    try {
      const first = await turn(agent, "m1");
      workspaceWhole(first.text, "with memory");
      assert.ok(memoryIn(first.text), "the memory reaches the prompt");
      assert.ok(first.text.indexOf("Chat memory: check view") < first.text.indexOf("You are working in a cube thread."), "cubeMemory comes before cubeWorkspace");
      const second = await turn(agent, "m2");
      workspaceWhole(second.text, "second turn");
      assert.ok(memoryIn(second.text), "the second turn has the same memory bytes");
      await agent.setModel("opus");
      const resumed = await turn(agent, "m3");
      workspaceWhole(resumed.text, "resumed");
      assert.ok(memoryIn(resumed.text), "a resumed child has the same memory bytes");
      console.log(`ok: with memory: cubeMemory before cubeWorkspace, the same bytes on a second turn and a resume (first request ${first.ms} ms after the submit)`);
    } finally { await agent.close(); }
  }
  for (const kind of ["none", "failing", "slow", "hung"] as const) {
    mode = kind;
    const asked = memoryAsks;
    const agent = await ClaudeAgent.open({ directory: path.join(temp, `agent-${kind}`), threadId: "t1", workspace, runtime, model: "sonnet", skills: SKILLS });
    try {
      const result = await turn(agent, `${kind}-1`);
      assert.ok(memoryAsks > asked, `${kind}: the mod asked for the memory`);
      workspaceWhole(result.text, kind);
      assert.ok(!result.text.includes("Chat memory: check view"), `${kind}: no memory this time`);
      if (kind === "slow" || kind === "hung") assert.ok(result.ms < MOD_WAIT_MS + 6000, `${kind}: bounded by the mod's wait (${result.ms} ms)`);
      console.log(`ok: memory ${kind}: the workspace block whole (orientation, AGENTS.md, skills), the first request ${result.ms} ms after the submit`);
    } finally { await agent.close(); }
  }
} finally {
  for (const response of held) response.destroy();
  api.close();
  server.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
console.log("claude memory: the workspace context stays whole whatever the memory route does");
