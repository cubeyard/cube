/** OptChat's memory in threads (thread-memory.ts) over a real registry and
 * a real Memory, with OptChat stood in by its identity and memory: only
 * threads created since memory exists get it, also after a restart; the
 * start view is captured once, redacted, bounded and kept word for word;
 * memory_zoom and memory_date read the live chat, newer messages too, with
 * the same words through Pi's adapter and Claude Code's route; nothing
 * they do writes to the chat; an absent, slow, empty or replaced chat says
 * so; archiving keeps the memory; creating a thread never waits for OptChat.
 * No network, no model. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { CUBE_TOOL_PREFIX, cubeTool as forward, type ToolScope } from "../../claude-mod/hooks/tools.ts";
import { WorkspaceClient } from "../../claude-mod/hooks/workspace.ts";
import { piTool, toolsRoute } from "../src/cube-tools.ts";
import { Memory } from "../src/optchat-memory.ts";
import { Registry } from "../src/registry.ts";
import { memoryDoc, ThreadMemory, type ChatMemory } from "../src/thread-memory.ts";
import { LeaseStore } from "../src/workspace-lease.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-thread-memory-"));
const file = path.join(root, "registry.sqlite");
const model = { provider: "fixture", id: "m" };
const T0 = Date.UTC(2026, 9, 29, 10, 0, 0);
const CAPTURED = Date.UTC(2026, 9, 29, 12, 0, 0);
const KEY = `ghp_${"a1".repeat(18)}`;

let registry = new Registry(file);
registry.saveProject({ id: "p", name: "demo", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
registry.enrollRunner({ nodeId: "node-1", environmentId: 1, threadId: "runner-1", configPath: "/private/1.json", configHash: "h", protocol: 4, kind: "vm" });
for (let n = 2; n <= 9; n++) registry.enrollRunner({ nodeId: `node-${n}`, environmentId: n, threadId: `runner-${n}`, configPath: `/private/${n}.json`, configHash: `h${n}`, protocol: 4, kind: "vm" });

// A thread created before memory existed: its registry had no thread_memory table.
const before = registry.createThread("p", "before", model, "an old task");
registry.close();
{ const db = new DatabaseSync(file); db.exec("DROP TABLE thread_memory"); db.close(); }
registry = new Registry(file);

// The chat: three messages, two summarized; one carries a key.
const chatMemory = new Memory();
const log = (kind: "user" | "talk", text: string, at: number) => chatMemory.append({ kind, text, date: at });
log("user", "plan the release of cube 0.4", T0);
log("talk", `use the deploy key ${KEY} for the mirror`, T0 + 60_000);
log("user", "and password=hunter2 for the staging box", T0 + 120_000);
chatMemory.setNode(0, 0, "user asks for a release plan for cube 0.4");
chatMemory.setNode(0, 1, `OptChat names the deploy key ${KEY}`);
let chat: ChatMemory = { identity: "optchat-a", memory: chatMemory };
let opens = 0;
let opening: () => Promise<ChatMemory> = async () => chat;
const memory = (on = registry, waitMs = 60_000) => new ThreadMemory({ registry: on, chat: () => { opens++; return opening(); }, waitMs, now: () => CAPTURED });
let threads = memory();

const leases = new LeaseStore(path.join(root, "leases"));
const claudeLease = leases.acquire("claude-code");
const piLeases = new LeaseStore(path.join(root, "pi-leases"));
const piLease = piLeases.acquire("pi");
/** A call through Pi's adapter, as the harness makes it. */
const pi = (id: string) => async (name: string, input: Record<string, unknown>): Promise<string> => {
  const tool = threads.tools(id).find(candidate => candidate.name === name);
  if (!tool) return `unknown tool ${name}`;
  const registration = piTool(tool, api => `pi:${api.taskId}`);
  const args = validateToolArguments(registration as never, { type: "toolCall", id: "c", name, arguments: input as never });
  const result = await registration.execute(args as never, { callId: "c", taskId: "t" } as unknown as ToolExecutionApi, {} as never);
  return (result as { output: Array<{ text: string }> }).output.map(part => part.text).join("");
};
/** A call through the Claude Code mod's forwarder, over cubed's route. */
const claude = (id: string, token = claudeLease.token, held = leases) => async (name: string, input: Record<string, unknown>): Promise<string> => {
  const transport = async (request: { method: string; path: string; headers: Record<string, string>; body?: string }) => {
    const named = /\/tools\/([^/]+)$/.exec(request.path)?.[1];
    const result = await toolsRoute({ method: request.method, name: named && decodeURIComponent(named), token: /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1],
      body: request.body ? JSON.parse(request.body) : {}, signal: new AbortController().signal },
    async given => { try { return held.renew(given); } catch { return null; } }, () => threads.tools(id));
    return { status: result.status, text: JSON.stringify(result.body) };
  };
  const scope: ToolScope = { client: new WorkspaceClient({ base: `/api/threads/${id}/workspace`, transport }), token, root: "/workspace" };
  const result = await forward(scope, `toolu_${name}`, `${CUBE_TOOL_PREFIX}${name}`, input);
  return typeof result === "string" ? result : `denied: ${result.deny}`;
};

try {
  // ---- only threads created since memory exists, durably ----
  const startedAt = performance.now();
  const thread = registry.createThread("p", "new", model, "a new task");
  const acceptMs = performance.now() - startedAt;
  assert.equal(opens, 0, "creating a thread does not open or wait for OptChat");
  assert.deepEqual(registry.threadMemory(thread.id), { chat: null, length: null, capturedAt: null, text: null });
  assert.equal(registry.threadMemory(before.id), null, "a thread from before memory has none");
  assert.equal(threads.has(before.id), false);
  assert.equal(await threads.text(before.id, "pi"), null);
  assert.deepEqual(threads.tools(before.id), []);
  assert.equal(opens, 0);
  console.log(`createThread with its memory row: ${acceptMs.toFixed(2)} ms`);

  // ---- the start view: captured once, redacted, with where it came from ----
  const expected = `${memoryDoc(name => name)}
The view below is the chat through message 2 (2026-10-29T10:02:00.000Z), captured 2026-10-29T12:00:00.000Z when this thread started.
<chat>
0+1|user asks for a release plan for cube 0.4
1+1|OptChat names the deploy key ghp_[redacted]
2+1|(not summarized yet: zoom it)
</chat>`;
  assert.equal(await threads.text(thread.id, "pi"), expected);
  assert.deepEqual(registry.threadMemory(thread.id), { chat: "optchat-a", length: 3, capturedAt: CAPTURED, text: expected });
  assert.ok(!expected.includes(KEY), "the key is not in the prompt");

  // The chat goes on: the text stays word for word (the prompt's cache),
  // and the tools read the newer messages.
  log("user", "newer: ship it on friday", T0 + 600_000);
  chatMemory.setNode(0, 2, "user gives the staging password=hunter2");
  assert.equal(await threads.text(thread.id, "pi"), expected);
  const viaPi = pi(thread.id), viaClaude = claude(thread.id);
  const script: Array<[string, Record<string, unknown>, string]> = [
    ["memory_zoom", { id: 3, n: 1 }, "3+0|user: newer: ship it on friday"],
    ["memory_zoom", { id: 1, n: 1 }, "1+0|talk: use the deploy key ghp_[redacted] for the mirror"],
    ["memory_zoom", { id: 2, n: 2 }, "2+1|user gives the staging password=[redacted]\n3+1|(not summarized yet: zoom it)"],
    ["memory_zoom", { id: 9, n: 1 }, "No line 9+1. The chat has messages 0-3 now."],
    ["memory_date", { id: 3 }, new Date(T0 + 600_000).toString()],
    ["memory_date", { id: 7 }, "No message 7."],
  ];
  for (const [name, input, said] of script) {
    assert.equal(await viaPi(name, input), said, `pi ${name} ${JSON.stringify(input)}`);
    assert.equal(await viaClaude(name, input), said, `claude code ${name} ${JSON.stringify(input)}`);
  }
  assert.match(await viaClaude("memory_zoom", { id: "x", n: 1 }), /^denied: memory_zoom: Validation failed[^]*id: must be integer/);

  // Read only: the two tools are all a thread gets, and nothing they did reached the chat.
  assert.deepEqual(threads.tools(thread.id).map(tool => tool.name), ["memory_zoom", "memory_date"]);
  assert.equal(chatMemory.length, 4, "no message was added by a thread");
  // Claude Code's route takes only the Claude Code child's lease.
  assert.equal(await claude(thread.id, piLease.token, piLeases)("memory_zoom", { id: 0, n: 1 }), "denied: memory_zoom: these tools are for claude code threads");
  assert.match(await claude(thread.id, "forged")("memory_zoom", { id: 0, n: 1 }), /^denied: this Claude Code session no longer holds the thread workspace/);

  // ---- once at a time: two first requests capture one view ----
  const twin = registry.createThread("p", "twin", model, "two at once");
  opens = 0;
  const [one, two] = await Promise.all([threads.text(twin.id, "claude-code"), threads.text(twin.id, "claude-code")]);
  assert.equal(one, two);
  assert.equal(opens, 1);
  assert.match(one!, /mcp__cube__memory_zoom\(id, n\)/, "a Claude Code thread is told the tool's name as it calls it");
  assert.match(one!, /through message 3 \(/);

  // ---- OptChat cannot open: said, not frozen; the next request captures ----
  const later = registry.createThread("p", "later", model, "while the chat is down");
  opening = async () => { throw new Error("connect a model provider first"); };
  const down = await threads.text(later.id, "pi");
  assert.equal(down, `${memoryDoc(name => name)}\nThe chat cannot be read right now (connect a model provider first); the next request tries again, and memory_zoom reads it once OptChat is open.`);
  assert.equal(registry.threadMemory(later.id)!.text, null, "nothing frozen");
  assert.equal(await pi(later.id)("memory_zoom", { id: 0, n: 1 }), "chat memory unavailable now: connect a model provider first");
  // Still opening (a long log): bounded, then the same.
  threads = memory(registry, 50);
  opening = () => new Promise<never>(() => {});
  const waited = performance.now();
  assert.match((await threads.text(later.id, "pi"))!, /cannot be read right now \(OptChat is still opening\)/);
  assert.equal(await pi(later.id)("memory_date", { id: 0 }), "chat memory unavailable now: OptChat is still opening");
  assert.ok(performance.now() - waited < 2_000, "the wait is bounded");
  threads = memory();
  opening = async () => chat;
  assert.match((await threads.text(later.id, "pi"))!, /through message 3 \(/, "captured once OptChat opens");

  // ---- an empty chat, and a long run the compactor has not summarized ----
  const empty = registry.createThread("p", "empty", model, "first ever");
  chat = { identity: "optchat-a", memory: new Memory() };
  assert.equal(await threads.text(empty.id, "pi"), `${memoryDoc(name => name)}\nThe chat had no messages yet when this thread started (2026-10-29T12:00:00.000Z).`);
  assert.equal(await pi(empty.id)("memory_zoom", { id: 0, n: 1 }), "No line 0+1. The chat has no messages yet.");
  const behind = new Memory();
  for (let k = 0; k < 20; k++) behind.append({ kind: "user", text: `message ${k}`, date: T0 + k });
  behind.setNode(0, 0, "the first message");
  chat = { identity: "optchat-a", memory: behind };
  const run = registry.createThread("p", "behind", model, "compactor down");
  assert.match((await threads.text(run.id, "pi"))!, /\n<chat>\n0\+1\|the first message\n1-19\|\(19 messages not summarized yet: zoom each with n = 1\)\n<\/chat>$/);

  // ---- another chat (OptChat's store replaced): a captured thread's ids are not its ----
  chat = { identity: "optchat-b", memory: chatMemory };
  assert.equal(await pi(thread.id)("memory_zoom", { id: 0, n: 1 }), "chat memory unavailable: this thread's view came from an earlier chat, which cubed no longer has");
  assert.equal(await threads.text(thread.id, "pi"), expected, "the start view stays");
  chat = { identity: "optchat-a", memory: chatMemory };

  // ---- archive and restart: nothing is deleted, the same bytes come back without OptChat ----
  registry.applyPhase(thread.id, { type: "released" });
  assert.equal(registry.getThread(thread.id)!.archived, true);
  registry.close();
  registry = new Registry(file);
  threads = memory();
  opens = 0;
  assert.equal(await threads.text(thread.id, "pi"), expected);
  assert.equal(opens, 0, "a captured view is read from the registry");
  assert.equal(registry.threadMemory(before.id), null, "the old thread still has none after a restart");
  assert.equal(threads.has(registry.createThread("p", "after-restart", model, "next").id), true);
  console.log("thread memory: new threads only, frozen redacted view, live read-only tools, both adapters");
} finally {
  registry.close();
  leases.close();
  piLeases.close();
  fs.rmSync(root, { recursive: true, force: true });
}
