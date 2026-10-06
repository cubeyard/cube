/** OptChat's archive tool: it archives only the threads OptChat started,
 * named by their whole short id; a working thread is refused and nothing is
 * stopped; archiving again says so; the last run's report reaches the chat
 * once even when the watcher never sent it. The archive itself (Conversations)
 * runs against real threads in optchat-product-test.ts. Faux model,
 * disposable state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { ThreadWorking, type Conversations } from "../src/conversation.ts";
import { OptChat, type OptThreads, type ThreadRecord } from "../src/optchat.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import type { Registry } from "../src/registry.ts";
import type { ThreadTranscript } from "../src/thread-events.ts";
import { pageOf } from "../src/thread-history.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-archive-"));
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
const DONE = "abcdef12-0000-4000-8000-000000000001";
const BUSY = "abcdef34-0000-4000-8000-000000000002";
const OTHER = "99999999-0000-4000-8000-000000000003";
const done: ThreadTranscript = { agent: "pi", owner: null, status: { state: "completed", run: "run-1", error: null },
  events: [{ type: "user-message", id: "1", text: "task" }, { type: "assistant-text", id: "2", text: "PR #9", reasoning: false, final: true }] };
const record = (transcript: ThreadTranscript): ThreadRecord => ({ project: "cube", title: "fix", archived: true, machine: null, facts: [], agentOpen: false,
  failure: null, transcript: pageOf(transcript), unreadable: null });

try {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  // Tool results by call id: a report steered in can follow one.
  const results = new Map<string, string>();
  let script: Array<() => ReturnType<typeof fauxAssistantMessage>> = [];
  faux.setResponses(Array.from({ length: 60 }, () => async request => {
    const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
    if (system.includes("You write the memory of OptChat")) return fauxAssistantMessage("summary");
    assert.match(system, /archive\(ids\) archives threads of yours that are done/, "the prompt documents the tool");
    assert.match(system, /It never stops a working thread/);
    for (const message of request.messages) if (message.role === "toolResult") results.set(message.toolCallId, textOf(message));
    // A report that arrives after the scripted turn starts a turn of its own.
    return (script.shift() ?? (() => fauxAssistantMessage("noted")))();
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const archived = new Set<string>();
  const asked: string[] = [];
  let spawns = 0;
  const threads: OptThreads = {
    async projects() { return "projects: cube"; },
    async runners() { return "no runners"; },
    async spawn() { return spawns++ ? { id: BUSY, title: "busy" } : { id: DONE, title: "done" }; },
    async tell() {},
    async describe(ids) { return ids.map(id => `[${id.slice(0, 8)}] cube · ${archived.has(id) ? "archived" : "ready"}`).join("\n"); },
    // The watcher never sees the run: its report is left to the archive.
    async events() { return null; },
    async history(id) { return id === DONE ? record(done) : null; },
    async archive(id) {
      asked.push(id);
      if (id === BUSY) throw new Error("it is working; nothing was stopped");
      const already = archived.has(id);
      archived.add(id);
      return { already, disk: "machine disk deleted", free: "2 of 2" };
    },
  };
  const chat = await OptChat.open({ directory: path.join(root, "optchat"), models, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }), threads, limits: { node: 64, retryMs: 50, watchMs: 50 } });
  try {
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) => () => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
    script = [
      call("spawn", { tasks: [{ project: "cube", task: "one" }, { project: "cube", task: "two" }] }, "call-spawn"),
      call("archive", { ids: [OTHER.slice(0, 8), OTHER, "abcdef", "abcdef1"] }, "call-refused"),
      call("archive", { ids: ["[abcdef12]", "abcdef34"] }, "call-archive"),
      call("archive", { ids: [DONE] }, "call-again"),
      () => fauxAssistantMessage("archived"),
    ];
    await chat.send("start two", "r1");
    for (let k = 0; k < 1500 && script.length; k++) await delay(10);
    await chat.agent.conversation.waitForIdle(context);

    // Another chat's or an unknown thread, and any prefix shorter than the
    // ids the chat is shown, never reach cubed.
    assert.equal(results.get("call-refused"), [`${OTHER.slice(0, 8)} not archived: no thread ${OTHER.slice(0, 8)}`, `${OTHER} not archived: no thread ${OTHER}`,
      "abcdef not archived: name a thread by its whole 8-character id", "abcdef1 not archived: name a thread by its whole 8-character id"].join("\n"));
    // A done thread is archived; a working one is refused, nothing stopped.
    assert.equal(results.get("call-archive"), ["[abcdef12] archived: machine disk deleted; history still reads it",
      "[abcdef34] not archived: it is working; nothing was stopped", "free thread machines: 2 of 2"].join("\n"));
    // Again: the thread is left as it is and says so.
    assert.equal(results.get("call-again"), "[abcdef12] was already archived: machine disk deleted; history still reads it\nfree thread machines: 2 of 2");
    assert.deepEqual(asked, [DONE, BUSY, DONE], "only the chat's own threads reach cubed");

    // The run the watcher never reported reaches the chat once, archived twice or not.
    const reports = async () => {
      const pending = (await chat.pending()).filter(item => item.requestId === `report:${DONE}:run-1`).length;
      const placed = await chat.agent.conversation.commit(tx => tx.submissionByRequest(chat.agent.conversation.id, `report:${DONE}:run-1`), context);
      return pending + (placed ? 1 : 0);
    };
    for (let k = 0; k < 1500 && !await reports(); k++) await delay(10);
    assert.equal(await reports(), 1, "the archived thread's report is accepted once");
    for (let k = 0; k < 1500 && (await chat.pending()).length; k++) await delay(10);
    await chat.agent.conversation.waitForIdle(context);
    assert.equal(await reports(), 1);
  } finally { await chat.close(); }

  // cubed's side: a machine still coming up is refused without waiting for
  // it (one retried after a failure is archived); a working run is refused.
  {
    const thread = { id: DONE, archived: false, workspaceState: "allocating", vm: undefined };
    let starting = true, error: string | null = null, archives = 0, working = false, waiting = false;
    const conversations = { starting: () => starting, error: () => error,
      async archive() { archives++; if (working || waiting) throw new ThreadWorking(waiting); thread.archived = true; return { retained: false, reason: "clean" }; } } as unknown as Conversations;
    const registry = { getThread: () => thread, runnerSlots: () => ({ free: 1, total: 1, runners: 1 }) } as unknown as Registry;
    const adapter = cubeThreads({ registry, conversations, catalog: async () => [], runners: () => { throw new Error("unused"); } });
    await assert.rejects(adapter.archive!(DONE), /^Error: its machine is still starting or reattaching; try again shortly$/);
    assert.equal(archives, 0, "nothing waits for the machine");
    starting = false; working = true;
    await assert.rejects(adapter.archive!(DONE), /^Error: it is working; nothing was stopped$/);
    // Archiving would end its background agents: refused the same way.
    working = false; waiting = true;
    await assert.rejects(adapter.archive!(DONE), /^Error: it is waiting on its background agents; nothing was stopped$/);
    starting = true; waiting = false; error = "workspace allocation failed: boom";
    assert.deepEqual(await adapter.archive!(DONE), { already: false, disk: "no machine disk", free: "1 of 1" });
    assert.deepEqual(await adapter.archive!(DONE), { already: true, disk: "no machine disk", free: "1 of 1" });
    assert.equal(archives, 3, "an archived thread is not archived again (two refusals, one archive)");
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("optchat archive: ok");
