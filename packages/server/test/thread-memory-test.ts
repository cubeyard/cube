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
import { setTimeout as delay } from "node:timers/promises";
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

  // ---- OptChat cannot open: a Pi thread freezes a fallback at once, and keeps it ----
  // Its baseline holds whatever its first request froze; a later capture
  // would be a patch that rewrites the cached prompt.
  const failed = registry.createThread("p", "failed", model, "while the chat is down");
  opening = async () => { throw new Error("connect a model provider first"); };
  const fallback = `${memoryDoc(name => name)}\nThe chat could not be read when this thread started (connect a model provider first), so there is no view of it here; memory_zoom and memory_date read all of it once OptChat is open.`;
  assert.equal(await threads.text(failed.id, "pi"), fallback);
  assert.deepEqual(registry.threadMemory(failed.id), { chat: null, length: null, capturedAt: CAPTURED, text: fallback }, "frozen, without a chat");
  assert.equal(await pi(failed.id)("memory_zoom", { id: 0, n: 1 }), "chat memory unavailable now: connect a model provider first");
  opening = async () => chat;
  assert.equal(await threads.text(failed.id, "pi"), fallback, "OptChat open again: the fallback stays");
  assert.equal(await pi(failed.id)("memory_zoom", { id: 3, n: 1 }), "3+0|user: newer: ship it on friday", "and the tools read the live chat");
  assert.equal(await pi(failed.id)("memory_date", { id: 3 }), new Date(T0 + 600_000).toString());

  // ---- a Claude Code thread's block is read for each prompt: said, not frozen, captured later ----
  const routedDown = registry.createThread("p", "claude-down", model, "a claude code thread while the chat is down");
  opening = async () => { throw new Error("connect a model provider first"); };
  assert.equal(await threads.text(routedDown.id, "claude-code"), `${memoryDoc(name => `mcp__cube__${name}`)}\nThe chat cannot be read right now (connect a model provider first); a later prompt tries again, and mcp__cube__memory_zoom reads it once OptChat is open.`);
  assert.equal(registry.threadMemory(routedDown.id)!.text, null, "nothing frozen");
  opening = async () => chat;
  assert.match((await threads.text(routedDown.id, "claude-code"))!, /through message 3 \(/, "captured once OptChat opens");

  // ---- a hung open: a Pi thread's own wait runs out, it freezes the fallback ----
  const hung = registry.createThread("p", "hung", model, "while the chat hangs");
  threads = memory(registry, 300);
  opening = () => new Promise<never>(() => {});
  opens = 0;
  let at = performance.now();
  const timedOut = (await threads.text(hung.id, "pi"))!;
  const first = performance.now() - at;
  assert.match(timedOut, /could not be read when this thread started \(OptChat is still opening\), so there is no view of it here/);
  assert.equal(registry.threadMemory(hung.id)!.text, timedOut);
  at = performance.now();
  assert.equal(await threads.text(hung.id, "pi"), timedOut, "the next request: the same bytes, at once");
  assert.equal(await pi(hung.id)("memory_date", { id: 0 }), "chat memory unavailable now: OptChat is still opening");
  assert.equal(await claude(hung.id)("memory_zoom", { id: 0, n: 1 }), "chat memory unavailable now: OptChat is still opening");
  const again = performance.now() - at;
  assert.ok(first >= 290 && first < 2_000, `the first wait runs its bound: ${first} ms`);
  assert.ok(again < 150, `later ones do not wait it out again: ${again} ms`);
  assert.equal(opens, 1, "one open, shared");
  console.log(`hung open: first wait ${first.toFixed(0)} ms, the next request and two calls ${again.toFixed(0)} ms`);
  // A stop aborts the wait at once (a fresh process, so a fresh open): the request rejects, nothing is frozen.
  const stopped = registry.createThread("p", "stopped", model, "stopped while waiting");
  threads = memory();
  const stop = new AbortController();
  at = performance.now();
  const waiting = threads.text(stopped.id, "pi", { signal: stop.signal });
  setTimeout(() => stop.abort(new Error("stopped by the user")), 50);
  await assert.rejects(waiting, /stopped by the user/);
  assert.ok(performance.now() - at < 1_000, "the stop did not wait for OptChat");
  assert.equal(registry.threadMemory(stopped.id)!.text, null, "a stop freezes nothing");
  // The Claude Code route's own, shorter wait freezes nothing either.
  at = performance.now();
  assert.match((await threads.text(stopped.id, "claude-code", { waitMs: 50 }))!, /cannot be read right now \(OptChat is still opening\); a later prompt tries again, and mcp__cube__memory_zoom/);
  assert.ok(performance.now() - at < 1_000, "the route's wait is its own");
  assert.equal(registry.threadMemory(stopped.id)!.text, null);

  // ---- a Claude Code thread's route gives up while a Pi thread shares the open ----
  // The Pi thread waits its own bound and its first request captures: its
  // baseline holds the view, not a fallback. The Claude Code thread captures
  // at its next prompt, from the same open.
  const routed = registry.createThread("p", "shared-claude", model, "a claude code thread");
  const waiting2 = registry.createThread("p", "shared-pi", model, "a pi thread");
  let release!: (value: ChatMemory) => void;
  // As openOptchat: one open, memoized.
  let shared = new Promise<ChatMemory>(resolve => { release = resolve; });
  opening = () => shared;
  threads = memory(registry, 5_000);
  assert.match((await threads.text(routed.id, "claude-code", { waitMs: 50 }))!, /cannot be read right now \(OptChat is still opening\)/);
  at = performance.now();
  const piFirst = threads.text(waiting2.id, "pi");
  await delay(150);
  release(chat);
  const piText = (await piFirst)!;
  assert.ok(performance.now() - at >= 140, "the pi request waited past the route's give-up");
  assert.doesNotMatch(piText, /could not be read|cannot be read/, "the pi thread's first request has the view, not a fallback");
  assert.match(piText, /^Chat memory:[^]*through message 3 \(/);
  assert.equal(registry.threadMemory(waiting2.id)!.text, piText, "and it is what was frozen");
  const routedNext = (await threads.text(routed.id, "claude-code", { waitMs: 50 }))!;
  assert.match(routedNext, /mcp__cube__memory_zoom[^]*through message 3 \(/, "the claude code thread captures at its next prompt");
  assert.equal(registry.threadMemory(routed.id)!.text, routedNext);

  // ---- a capture and a fallback race for one thread: the first frozen wins, both callers get it ----
  // The fallback first (a request whose wait ran out), then a capture from the same open.
  const raced = registry.createThread("p", "raced", model, "two requests at once");
  shared = new Promise<ChatMemory>(resolve => { release = resolve; });
  threads = memory(registry, 5_000);
  const capturing = threads.text(raced.id, "pi");
  const short = await memory(registry, 50).text(raced.id, "pi");
  release(chat);
  assert.match(short!, /could not be read when this thread started/);
  assert.equal(await capturing, short, "the capture after it changes nothing: the same bytes");
  assert.equal(registry.threadMemory(raced.id)!.text, short);
  // The capture first: a failed open after it changes nothing.
  opening = async () => chat;
  const racedToo = registry.createThread("p", "raced-too", model, "two requests at once, the other way");
  const capturedFirst = (await memory().text(racedToo.id, "pi"))!;
  assert.match(capturedFirst, /through message 3 \(/);
  opening = async () => { throw new Error("the store failed"); };
  assert.equal(await memory().text(racedToo.id, "pi"), capturedFirst, "a failed open after a capture keeps the capture");
  opening = async () => chat;
  threads = memory();

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

  // ---- a Claude Code thread's gate before its first prompt (final): the same rules as Pi ----
  // Its own wait runs out: the fallback is frozen, and the mod's route reads it at every prompt.
  const ccHung = registry.createThread("p", "cc-hung", model, "a claude code thread, the chat hung");
  opening = () => new Promise<never>(() => {});
  threads = memory(registry, 100);
  const ccFallback = (await threads.text(ccHung.id, "claude-code", { final: true }))!;
  assert.equal(ccFallback, `${memoryDoc(name => `mcp__cube__${name}`)}\nThe chat could not be read when this thread started (OptChat is still opening), so there is no view of it here; mcp__cube__memory_zoom and mcp__cube__memory_date read all of it once OptChat is open.`);
  opening = async () => chat;
  threads = memory();
  assert.equal(await threads.text(ccHung.id, "claude-code", { waitMs: 50 }), ccFallback, "the route, OptChat open: the same fallback");
  assert.equal(await claude(ccHung.id)("memory_zoom", { id: 3, n: 1 }), "3+0|user: newer: ship it on friday", "its tools read the live chat");
  // The open fails, then recovers: the fallback stays.
  const ccFailed = registry.createThread("p", "cc-failed", model, "a claude code thread, the chat down");
  opening = async () => { throw new Error("the store failed"); };
  const ccDown = (await threads.text(ccFailed.id, "claude-code", { final: true }))!;
  assert.match(ccDown, /could not be read when this thread started \(the store failed\)/);
  opening = async () => chat;
  assert.equal(await threads.text(ccFailed.id, "claude-code", { final: true }), ccDown);
  // The route gives up first (not final: nothing frozen) while the gate still waits on the same open; the gate captures.
  const ccRace = registry.createThread("p", "cc-race", model, "the route and the gate at once");
  shared = new Promise<ChatMemory>(resolve => { release = resolve; });
  opening = () => shared;
  threads = memory(registry, 5_000);
  const gate = threads.text(ccRace.id, "claude-code", { final: true });
  assert.match((await threads.text(ccRace.id, "claude-code", { waitMs: 50 }))!, /cannot be read right now/);
  assert.equal(registry.threadMemory(ccRace.id)!.text, null, "the route's give-up froze nothing");
  release(chat);
  const ccView = (await gate)!;
  assert.match(ccView, /mcp__cube__memory_zoom[^]*through message 3 \(/);
  assert.equal(await threads.text(ccRace.id, "claude-code", { waitMs: 50 }), ccView, "the route reads the gate's capture");
  // The gate's fallback first: a capture from the route after it changes nothing.
  const ccRaceToo = registry.createThread("p", "cc-race-too", model, "the gate gives up first");
  shared = new Promise<ChatMemory>(resolve => { release = resolve; });
  const routeLater = memory(registry, 5_000).text(ccRaceToo.id, "claude-code", { waitMs: 5_000 });
  const gateFallback = (await memory(registry, 50).text(ccRaceToo.id, "claude-code", { final: true }))!;
  release(chat);
  assert.match(gateFallback, /could not be read when this thread started/);
  assert.equal(await routeLater, gateFallback, "the same bytes for both");
  opening = async () => chat;
  threads = memory();

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
  assert.equal(await threads.text(failed.id, "pi"), fallback, "a frozen fallback stays after a restart, with OptChat open");
  assert.equal(await threads.text(hung.id, "pi"), timedOut);
  assert.equal(await threads.text(ccHung.id, "claude-code", { waitMs: 50 }), ccFallback, "a claude code thread's fallback too");
  assert.equal(await threads.text(ccRace.id, "claude-code", { final: true }), ccView, "and its view");
  assert.equal(opens, 0, "none asks OptChat");
  assert.equal(await pi(failed.id)("memory_zoom", { id: 0, n: 1 }), "0+0|user: plan the release of cube 0.4", "its tools read the chat");
  assert.equal(threads.has(registry.createThread("p", "after-restart", model, "next").id), true);
  console.log("thread memory: new threads only, frozen redacted view, live read-only tools, both adapters");
} finally {
  registry.close();
  leases.close();
  piLeases.close();
  fs.rmSync(root, { recursive: true, force: true });
}
