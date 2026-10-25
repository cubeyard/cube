/** OptChat's archive tool: it archives only the threads OptChat started,
 * named by their whole short id; a working thread is refused and nothing is
 * stopped; archiving again says so; the last run's report reaches the chat
 * once even when the watcher never sent it. threads then lists only the
 * chat's threads not archived; archived_threads searches the archived ones,
 * a page at a time; history still reads an archived thread. The archive itself (Conversations)
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
import { allocationFailed } from "../src/thread-failure.ts";
import { ARCHIVED_MAX, OptChat, type OptThreads, type ThreadListRequest, type ThreadRecord } from "../src/optchat.ts";
import { cubeThreads, readThreads } from "../src/optchat-threads.ts";
import { threadCondition } from "../src/thread-condition.ts";
import type { Registry, Thread } from "../src/registry.ts";
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
  const listed: Array<[readonly string[], ThreadListRequest | undefined]> = [];
  let spawns = 0;
  const threads: OptThreads = { startFailure: () => null, onStartFailure: () => () => {}, onRunFeed: () => () => {},
    async projects() { return "projects: cube"; },
    async runners() { return "no runners"; },
    async spawn() { return spawns++ ? { id: BUSY, title: "busy" } : { id: DONE, title: "done" }; },
    async tell() {},
    async describe(ids, request) { listed.push([ids, request]); return ids.map(id => `[${id.slice(0, 8)}] cube · ${archived.has(id) ? "archived" : "ready"}`).join("\n"); },
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
      call("threads", {}, "call-threads"),
      call("archived_threads", {}, "call-archived"),
      call("archived_threads", { query: "fix", offset: 20, limit: 5 }, "call-search"),
      call("history", { id: DONE.slice(0, 8) }, "call-history"),
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
    // threads asks for the default list (no archived ones), archived_threads
    // for a bounded page of the archived; both of the chat's own threads only,
    // newest spawn first.
    assert.deepEqual(listed, [[[BUSY, DONE], undefined], [[BUSY, DONE], { archived: true, query: undefined, offset: 0, limit: 20 }],
      [[BUSY, DONE], { archived: true, query: "fix", offset: 20, limit: 5 }]]);
    assert.match(results.get("call-history") ?? "", /PR #9/, "history still reads an archived thread");

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
    const adapter = cubeThreads({ registry, conversations, catalog: async () => [], runners: () => { throw new Error("unused"); }, latestCommits: () => { throw new Error("unused"); } });
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

  // cubed's side of the lists (readThreads): the default leaves archived
  // threads out and counts them; archived_threads' search matches id, title
  // or project, pages and says where the next page starts. Only the ids the
  // chat passes are read: another chat's thread is never listed. An
  // archived thread's store is never read for a list.
  {
    const make = (n: number, extra: Partial<Thread>) => ({ id: `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`, title: `task ${n}`, projectId: n % 2 ? "web" : "cube",
      archived: false, workspaceState: "available", workspaceError: null, vm: undefined, ...extra }) as unknown as Thread;
    const open = make(1, { title: "running work" }), ended = make(2, { title: "ended work" }), failed = make(3, { title: "broken", workspaceState: "failed" });
    const old = Array.from({ length: 60 }, (_, k) => make(100 + k, { archived: true, title: k === 7 ? "Fix the Cart" : `old ${k}` }));
    const foreign = make(900, { archived: true, title: "fix elsewhere" });
    const all = new Map([open, ended, failed, ...old, foreign].map(thread => [thread.id, thread]));
    const registry = { getThread: (id: string) => all.get(id) ?? null, getProject: (id: string) => ({ name: id }) } as unknown as Registry;
    const stored: string[] = [];
    const reader = {
      condition: (thread: Thread) => threadCondition(thread, { archiving: false, starting: false, agentOpen: false, down: null, waiting: null,
        failure: thread.id === failed.id ? allocationFailed("boom") : null }),
      agentOpen: () => false, live: async () => null, owner: () => null,
      async storedHistory(id: string) { stored.push(id); return { status: { state: id === open.id ? "working" : "completed", run: "r", error: null } }; },
    } as unknown as Parameters<typeof readThreads>[0]["conversations"];
    const reads = readThreads({ registry, conversations: reader });
    const mine = [open.id, ended.id, failed.id, ...old.map(thread => thread.id)];

    const list = await reads.describe(mine);
    assert.deepEqual(list.split("\n"), [`[${open.id.slice(0, 8)}] web · running work · ready, working`, `[${ended.id.slice(0, 8)}] cube · ended work · ready, completed`,
      `[${failed.id.slice(0, 8)}] web · broken · error: workspace allocation failed: boom`, "60 archived threads not listed; archived_threads searches them"]);
    assert.deepEqual(stored, [open.id, ended.id], "only open threads' stores are read");
    assert.equal(await reads.describe(old.slice(0, 1).map(thread => thread.id)), "no threads that are not archived\n1 archived thread not listed; archived_threads searches them");
    assert.equal(await reads.describe([]), "no threads");

    const first = (await reads.describe(mine, { archived: true })).split("\n");
    assert.equal(first[0], "archived threads 1-20 of 60, newest first; next: offset 20");
    assert.deepEqual(first.slice(1), old.slice(0, 20).map(thread => `[${thread.id.slice(0, 8)}] ${thread.projectId} · ${thread.title} · archived`));
    const last = (await reads.describe(mine, { archived: true, offset: 40, limit: ARCHIVED_MAX })).split("\n");
    assert.equal(last[0], "archived threads 41-60 of 60, newest first", "the last page has no next");
    assert.equal(last.length, 21);
    assert.equal((await reads.describe(mine, { archived: true, limit: 500 })).split("\n").length, ARCHIVED_MAX + 1, "a page is bounded");
    assert.equal(await reads.describe(mine, { archived: true, offset: 60 }), "no archived threads from 61 on; there are 60");
    // Title in any case, project and id prefix match; another chat's
    // archived "fix elsewhere" is not among the chat's ids.
    assert.equal(await reads.describe(mine, { archived: true, query: " fix " }), `archived threads matching "fix" 1-1 of 1, newest first\n[${old[7]!.id.slice(0, 8)}] web · Fix the Cart · archived`);
    assert.match(await reads.describe(mine, { archived: true, query: "CUBE" }), /^archived threads matching "CUBE" 1-20 of 30, newest first; next: offset 20\n/);
    assert.match(await reads.describe(mine, { archived: true, query: old[3]!.id.slice(0, 8) }), /^archived threads matching "\d+" 1-1 of 1, newest first\n.* · old 3 · archived$/);
    assert.equal(await reads.describe(mine, { archived: true, query: "nothing like it" }), `no archived threads matching "nothing like it"`);
    assert.equal(await reads.describe([open.id], { archived: true }), "no archived threads", "open threads are not in the archived search");
    assert.deepEqual(stored, [open.id, ended.id], "the archived search reads no store");
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("optchat archive: ok");
