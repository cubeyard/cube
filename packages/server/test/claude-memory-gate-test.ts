/** A Claude Code thread's OptChat memory (thread-memory.ts) through cubed's
 * gate before each prompt (ClaudeAgent `beforePrompt`, as index.ts wires it)
 * and the mod's memory route, with the fake `claude` reading that route as
 * the mod's prompt.context does, over a real registry: the first prompt
 * freezes the view, or, when the gate's own wait runs out or OptChat's open
 * fails, an honest fallback; every later prompt, a recovery of OptChat and a
 * restart (registry and agent opened again) give the same bytes; a stop
 * during the gate's wait ends the turn at once and freezes nothing.
 * Offline: fake claude, local guest. */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ClaudeAgent, type ClaudeRuntime } from "../src/claude-agent.ts";
import { claudeCodeOnly, toolsRoute } from "../src/cube-tools.ts";
import { Memory } from "../src/optchat-memory.ts";
import { Registry } from "../src/registry.ts";
import { MEMORY_PROMPT_WAIT_MS, ThreadMemory, type ChatMemory } from "../src/thread-memory.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { workspaceRoute } from "../src/workspace-http.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { LocalGuestTransport } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-claude-memory-"));
const file = path.join(root, "registry.sqlite");
let registry = new Registry(file);
registry.saveProject({ id: "p", name: "demo", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
for (const n of [1, 2, 3, 4]) registry.enrollRunner({ nodeId: `node-${n}`, environmentId: n, threadId: `runner-${n}`, configPath: `/private/${n}.json`, configHash: `h${n}`, protocol: 4, kind: "vm" });
const chatMemory = new Memory();
chatMemory.append({ kind: "user", text: "the release codename is HERON", date: Date.UTC(2026, 9, 29) });
chatMemory.setNode(0, 0, "user names the release HERON");
const chat: ChatMemory = { identity: "optchat-a", memory: chatMemory };
let opening: () => Promise<ChatMemory> = async () => chat;
const GATE_MS = 300;
let threads = new ThreadMemory({ registry, chat: () => opening(), waitMs: GATE_MS });

const files = path.join(root, "workspace");
fs.mkdirSync(files, { recursive: true });
const guest = new LocalGuestTransport(path.dirname(files));
const workspace = new VmWorkspace({ guest, leases: new LeaseStore(path.join(root, "lease")), owner: "claude-code", binding: guest.binding });
const socket = path.join(root, "workspace.sock");
// As cubed's socket: the workspace, the cube tools (none here) and the memory route.
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url!, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const token = /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1];
  const lease = (held: string) => workspace.lease({ token: held }).catch(() => null);
  const send = (status: number, body: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); };
  if (parts[0] !== "api" || parts[1] !== "threads" || parts[3] !== "workspace") return send(404, {});
  if (parts[4] === "memory") {
    const refused = await claudeCodeOnly(token, lease);
    return refused ? send(refused.status, refused.body) : send(200, { text: await threads.text(parts[2]!, "claude-code", { waitMs: MEMORY_PROMPT_WAIT_MS }) });
  }
  const result = parts[4] === "tools"
    ? await toolsRoute({ method: request.method!, name: parts[5], token, body: raw ? JSON.parse(raw) : {}, signal: new AbortController().signal }, lease, () => [])
    : await workspaceRoute(workspace, { method: request.method!, parts: parts.slice(4), query: url.searchParams, headers: request.headers, body: raw ? JSON.parse(raw) : {}, thread: parts[2]! });
  send(result.status, result.body);
});
await new Promise<void>(resolve => server.listen(socket, resolve));
const runtime: ClaudeRuntime = { command: [process.execPath, path.join(import.meta.dirname, "fake-claude.ts")], mod: path.resolve(import.meta.dirname, "../../claude-mod"), socket, stopGraceMs: 1000 };
/** The agent as conversation.ts opens it, its gate as index.ts wires it. */
const open = (thread: string) => ClaudeAgent.open({ directory: path.join(root, thread), threadId: thread, workspace, runtime, model: "sonnet",
  beforePrompt: signal => threads.text(thread, "claude-code", { signal, final: true }) });
/** One turn: its state and the memory text the fake read as the mod's prompt.context would. */
async function turn(agent: ClaudeAgent, requestId: string, text = "memory"): Promise<{ state: string; memory: string | undefined; ms: number }> {
  const at = performance.now();
  await agent.submit(requestId, text);
  for (const deadline = Date.now() + 20_000; ;) {
    const submission = agent.state().submissions.find(item => item.requestId === requestId)!;
    if (submission.state !== "running") {
      const said = agent.state().messages.filter(message => message.submission === submission.seq && message.data.type === "assistant")
        .flatMap(message => ((message.data.message as { content?: Array<{ type: string; text?: string }> }).content ?? []).flatMap(part => part.type === "text" && part.text ? [part.text] : []));
      return { state: submission.state, memory: said.find(line => line.startsWith("memory: "))?.slice("memory: ".length), ms: performance.now() - at };
    }
    assert.ok(Date.now() < deadline, `${requestId} settles`);
    await delay(20);
  }
}
const model = { provider: "claude-code", id: "sonnet" };

try {
  // ---- OptChat's open hangs: the gate's own wait runs out, the fallback is frozen before the first prompt ----
  const hung = registry.createThread("p", "hung", model, "x").id;
  opening = () => new Promise<never>(() => {});
  let agent = await open(hung);
  const first = await turn(agent, "h1");
  assert.equal(first.state, "completed");
  const fallback = registry.threadMemory(hung)!.text!;
  assert.match(fallback, /^Chat memory:[^]*\nThe chat could not be read when this thread started \(OptChat is still opening\), so there is no view of it here; mcp__cube__memory_zoom and mcp__cube__memory_date read all of it once OptChat is open\.$/);
  assert.equal(registry.threadMemory(hung)!.chat, null);
  assert.equal(first.memory, fallback, "the first prompt's block is the frozen fallback");
  // OptChat opens: the next prompt's block is the same bytes, not the view.
  opening = async () => chat;
  const second = await turn(agent, "h2");
  assert.equal(second.memory, fallback, "OptChat open: the same fallback");
  await agent.close();
  // Restart: the registry and the agent open again (a resumed child).
  registry.close();
  registry = new Registry(file);
  threads = new ThreadMemory({ registry, chat: () => opening(), waitMs: GATE_MS });
  agent = await open(hung);
  assert.equal((await turn(agent, "h3")).memory, fallback, "after a restart: the same fallback");
  await agent.close();

  // ---- OptChat's open fails, then recovers: the fallback stays ----
  const failed = registry.createThread("p", "failed", model, "y").id;
  opening = async () => { throw new Error("the chat store could not be read"); };
  agent = await open(failed);
  const down = await turn(agent, "f1");
  assert.match(down.memory!, /could not be read when this thread started \(the chat store could not be read\)/);
  opening = async () => chat;
  assert.equal((await turn(agent, "f2")).memory, down.memory, "recovered: the same fallback");
  await agent.close();

  // ---- the open succeeds: the view, frozen, the same at every prompt and after a restart ----
  const good = registry.createThread("p", "good", model, "z").id;
  agent = await open(good);
  const viewed = await turn(agent, "g1");
  assert.match(viewed.memory!, /\n<chat>\n0\+1\|user names the release HERON\n<\/chat>$/);
  assert.equal(registry.threadMemory(good)!.text, viewed.memory);
  opening = async () => { throw new Error("down again"); };
  assert.equal((await turn(agent, "g2")).memory, viewed.memory, "OptChat down later: the same view");
  await agent.close();
  registry.close();
  registry = new Registry(file);
  threads = new ThreadMemory({ registry, chat: () => opening(), waitMs: GATE_MS });
  agent = await open(good);
  assert.equal((await turn(agent, "g3")).memory, viewed.memory, "after a restart: the same view");
  await agent.close();

  // ---- a stop while the gate waits: the turn ends at once, no prompt is written, nothing is frozen ----
  const stopped = registry.createThread("p", "stopped", model, "w").id;
  opening = () => new Promise<never>(() => {});
  threads = new ThreadMemory({ registry, chat: () => opening(), waitMs: 2_000 });
  agent = await open(stopped);
  await agent.submit("s1", "memory");
  await delay(1_000);
  const at = performance.now();
  await agent.stop();
  let state = "running";
  for (const deadline = Date.now() + 10_000; state === "running"; await delay(20)) {
    state = agent.state().submissions.find(item => item.requestId === "s1")!.state;
    assert.ok(Date.now() < deadline, "the stopped turn settles");
  }
  const stopMs = performance.now() - at;
  assert.equal(state, "stopped");
  assert.ok(stopMs < 500, `the stop ended the turn at once, not after the gate or the interrupt's grace (${stopMs.toFixed(0)} ms)`);
  assert.ok(!agent.state().messages.some(message => JSON.stringify(message.data).includes("memory: ")), "no prompt reached claude code");
  await delay(1_500);
  assert.equal(registry.threadMemory(stopped)!.text, null, "a stop freezes nothing, also once the gate's wait would have run out");
  // The next prompt waits again and freezes then.
  threads = new ThreadMemory({ registry, chat: () => opening(), waitMs: GATE_MS });
  opening = async () => chat;
  assert.match((await turn(agent, "s2")).memory!, /<chat>\n0\+1\|user names the release HERON/);
  await agent.close();
  console.log(`ok: claude code memory: frozen before the first prompt (the view, or a fallback at the gate's own timeout or a failed open), the same bytes at later prompts, after OptChat recovers and after a restart; a stop during the gate ends the turn in ${stopMs.toFixed(0)} ms and freezes nothing`);
} finally {
  server.close();
  registry.close();
  guest.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
