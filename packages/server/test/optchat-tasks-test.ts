/** OptChat's task list: tasks are kept word for word in the chat's store
 * and bounded; a replayed call finds its task; the list leads each turn
 * after the view; a linked thread's state is cubed's record, read only,
 * and never stands for the task's; a link is only a link. Faux model,
 * disposable state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import type { Conversations } from "../src/conversation.ts";
import { OptChat, type OptThreads } from "../src/optchat.ts";
import { applyTask, checkLink, LIMITS, linkLabel, renderTasks, shown, type Tasks } from "../src/optchat-tasks.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import type { Registry } from "../src/registry.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-tasks-"));
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
const blocks = (message: Message) => typeof message.content === "string" ? [message.content]
  : message.content.flatMap(part => part.type === "text" ? [part.text] : []);
const ONE = "abcdef12-0000-4000-8000-000000000001";
const TWO = "abcdef34-0000-4000-8000-000000000002";
const PR = "https://github.com/cubeyard/cube/pull/96";

try {
  // The list itself: create, change, close, bounds, replay, order.
  {
    const doc: Tasks = { seq: 0, items: [] };
    const first = applyTask(doc, { title: "  ship the   now panel ", threads: [ONE], links: [PR] }, "call-1", 1000);
    assert.equal(first.created, true);
    assert.deepEqual({ ...first.task }, { id: "t1", title: "ship the now panel", status: "active", next: "", project: null, threads: [ONE], links: [PR],
      created: 1000, updated: 1000, closed: null, origin: "call-1" });
    assert.equal(applyTask(doc, { title: "ship the now panel" }, "call-1", 2000).created, false, "a replayed call finds its task");
    assert.equal(doc.items.length, 1);
    applyTask(doc, { id: "t1", status: "blocked", next: "review" }, "call-2", 3000);
    assert.equal(doc.items[0]!.title, "ship the now panel", "fields left out stay");
    assert.equal(doc.items[0]!.next, "review");
    applyTask(doc, { id: "#t1", links: [] }, "call-3", 3500);
    assert.deepEqual(doc.items[0]!.links, [], "links replace the task's");
    assert.throws(() => applyTask(doc, { id: "t9", status: "done" }, "x", 0), /no task t9/);
    assert.throws(() => applyTask(doc, {}, "x", 0), /a new task needs a title/);
    assert.throws(() => applyTask(doc, { title: "  " }, "x", 0), /a task needs a title/);
    assert.throws(() => applyTask(doc, { title: "x".repeat(LIMITS.title + 1) }, "x", 0), /keep it to 100/);
    assert.throws(() => applyTask(doc, { title: "x", links: ["http://example.com"] }, "x", 0), /only https links/);
    assert.throws(() => applyTask(doc, { title: "x", links: ["not a url"] }, "x", 0), /not a URL/);
    assert.throws(() => applyTask(doc, { title: "x", threads: [ONE, TWO, "c", "d", "e"] }, "x", 0), /at most 4 threads/);
    assert.throws(() => applyTask(doc, { title: "x", status: "merged" as never }, "x", 0), /status is one of/);
    assert.equal(doc.items.length, 1, "a refused call adds nothing");

    applyTask(doc, { id: "t1", status: "done" }, "call-4", 4000);
    assert.equal(doc.items[0]!.closed, 4000);
    applyTask(doc, { id: "t1", next: "nothing" }, "call-5", 5000);
    assert.equal(doc.items[0]!.closed, 4000, "changing a closed task keeps when it closed");
    applyTask(doc, { id: "t1", status: "active" }, "call-6", 6000);
    assert.equal(doc.items[0]!.closed, null, "reopened");

    // At most LIMITS.open open tasks; closed ones beyond LIMITS.closedKept leave.
    for (let k = 2; k <= LIMITS.open; k++) applyTask(doc, { title: `task ${k}`, status: k % 2 ? "pending" : "active" }, `open-${k}`, 6000 + k);
    assert.throws(() => applyTask(doc, { title: "one too many" }, "x", 7000), /20 tasks are open/);
    assert.ok(applyTask(doc, { title: "already closed", status: "done" }, "closed-0", 7000).created, "a closed task does not count");
    assert.throws(() => applyTask(doc, { id: "t21", status: "active" }, "x", 7000), /20 tasks are open/, "nor reopens past the bound");
    for (let k = 1; k <= LIMITS.closedKept + 5; k++) applyTask(doc, { title: `old ${k}`, status: "dropped" }, `closed-${k}`, 8000 + k);
    assert.equal(doc.items.filter(task => task.status === "done" || task.status === "dropped").length, LIMITS.closedKept);
    assert.ok(!doc.items.some(task => task.title === "already closed"), "the oldest closed task left");
    assert.ok(new Set(doc.items.map(task => task.id)).size === doc.items.length, "ids are never reused");

    applyTask(doc, { id: "t3", status: "blocked", next: "a login" }, "b", 9000);
    const list = shown(doc, 9000);
    assert.equal(list.open.length, LIMITS.open);
    assert.deepEqual(list.open.slice(0, 2).map(task => task.status), ["blocked", "active"], "blocked first");
    assert.equal(list.open[0]!.id, "t3");
    assert.equal(list.closed.length, LIMITS.closedShown);
    assert.equal(list.closed[0]!.title, `old ${LIMITS.closedKept + 5}`, "the latest closed first");
    assert.equal(shown(doc, 9000 + 8 * 86_400_000).closed.length, 0, "closed more than a week ago is not shown");

    assert.deepEqual(linkLabel(PR), { label: "cubeyard/cube#96", pr: true });
    assert.deepEqual(linkLabel("https://example.com/a/b"), { label: "example.com/a/b", pr: false });
    assert.equal(checkLink(" https://example.com "), "https://example.com/");

    // The model reads a thread's state as the thread's, and a link as a link.
    const one = { seq: 1, items: [{ id: "t1", title: "panel", status: "active" as const, next: "wait for CI", project: "cube", threads: [ONE, TWO], links: [PR],
      created: 0, updated: 0, closed: null, origin: "c" }] };
    const text = renderTasks(shown(one, 0), new Map([[ONE, { id: ONE, title: "x", project: "cube", state: "completed" }], [TWO, null]]));
    assert.match(text, /^<now>\n.*a link is only a link \(cube checks no PR, merge or release\)\.\nt1 active · cube · panel · next: wait for CI · thread \[abcdef12\] turn ended · thread \[abcdef34\] unknown · link cubeyard\/cube#96\n<\/now>$/);
    assert.match(renderTasks({ open: [], closed: [] }), /\nno open tasks\n/);
  }

  // OptChat: the tools keep the list in its store, the next turn leads with
  // it after the view, and a reopen keeps it.
  {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const results = new Map<string, string>();
    const firstUsers: string[][] = [];
    let script: Array<() => ReturnType<typeof fauxAssistantMessage>> = [];
    faux.setResponses(Array.from({ length: 80 }, () => async request => {
      const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
      if (system.includes("You write the memory of OptChat")) return fauxAssistantMessage("summary");
      assert.match(system, /each turn shows your task list inside <now> tags/, "the prompt explains the list");
      assert.match(system, /a merged pull request is not released or installed/);
      for (const message of request.messages) if (message.role === "toolResult") results.set(message.toolCallId, textOf(message));
      firstUsers.push(blocks(request.messages.find(message => message.role === "user")!));
      return (script.shift() ?? (() => fauxAssistantMessage("noted")))();
    }));
    const models = createModels();
    models.setProvider(faux.provider);
    const observed: string[][] = [];
    let state = "working";
    const threads: OptThreads = {
      async projects() { return "projects: cube"; },
      async runners() { return "no runners"; },
      async spawn(_task, requestId) { return requestId.endsWith(":0") ? { id: ONE, title: "one" } : { id: TWO, title: "two" }; },
      async tell() {},
      async describe() { return ""; },
      async events() { return null; },
      async history() { return null; },
      async observe(ids) {
        observed.push([...ids]);
        return new Map(ids.map(id => [id, id === ONE ? { id, title: "one", project: "cube", state } : null]));
      },
    };
    const open = () => OptChat.open({ directory: path.join(root, "optchat"), models, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }), threads, limits: { node: 64, retryMs: 50, watchMs: 50 } });
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) => () => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
    const settle = async (chat: OptChat) => {
      for (let k = 0; k < 1500 && (script.length || (await chat.pending()).length); k++) await delay(10);
      await chat.agent.conversation.waitForIdle(context);
    };
    let chat = await open();
    try {
      script = [
        call("spawn", { tasks: [{ project: "cube", task: "one" }, { project: "cube", task: "two" }] }, "call-spawn"),
        call("task", { title: "ship the now panel", project: "cube", next: "review", threads: ["abcdef12"], links: [PR] }, "call-add"),
        call("task", { title: "nope", threads: ["99999999"] }, "call-unknown"),
        call("task", { id: "t1", status: "done" }, "call-early"),
        call("task", { id: "t1", status: "active" }, "call-reopen"),
        call("tasks", {}, "call-read"),
        () => fauxAssistantMessage("tracking it"),
      ];
      await chat.send("ship the panel", "r1");
      await settle(chat);
      assert.equal(results.get("call-add"), `added: t1 active · cube · ship the now panel · next: review · thread [abcdef12] working · link cubeyard/cube#96`);
      assert.equal(results.get("call-unknown"), "not changed: no thread 99999999", "only the chat's own threads");
      assert.match(results.get("call-read")!, /^<now>\n.*\nt1 active · cube · ship the now panel · next: review · thread \[abcdef12\] working · link cubeyard\/cube#96\n<\/now>$/);
      // The first turn started with an empty list, after the view.
      assert.equal(firstUsers[0]![0]!.startsWith("<chat>"), true);
      assert.match(firstUsers[0]![1]!, /^<now>\n[^]*\nno open tasks\n<\/now>$/);
      assert.equal(firstUsers[0]![2], "ship the panel");
      assert.ok(firstUsers.slice(0, 7).every(user => user[1] === firstUsers[0]![1]), "every request of a turn sends the same list");

      // The UI's view: intent beside cubed's record; the thread's state is not the task's.
      state = "completed";
      const list = await chat.tasks();
      assert.deepEqual(list.open.map(task => ({ ...task, updated: 0 })), [{ id: "t1", title: "ship the now panel", status: "active", next: "review", project: "cube", updated: 0, closed: null,
        threads: [{ id: ONE, title: "one", project: "cube", state: "completed" }], links: [{ url: PR, label: "cubeyard/cube#96", pr: true }] }]);
      assert.equal(list.limit, LIMITS.open);

      script = [() => fauxAssistantMessage("ok")];
      const before = firstUsers.length;
      await chat.send("anything new?", "r2");
      await settle(chat);
      assert.match(firstUsers[before]![1]!, /\nt1 active · cube · ship the now panel · next: review · thread \[abcdef12\] turn ended · link cubeyard\/cube#96\n/, "the next turn leads with the list");
    } finally { await chat.close(); }

    // Reopened: the list is the store's, word for word.
    chat = await open();
    try {
      const list = await chat.tasks();
      assert.equal(list.open[0]?.title, "ship the now panel");
      assert.ok(observed.every(ids => ids.length <= LIMITS.threads * (LIMITS.open + LIMITS.closedShown)), "reads are bounded by the list");
    } finally { await chat.close(); }
  }

  // cubed's side: observe reads the stored state only, and says what it cannot know.
  {
    const threads = new Map<string, { id: string; projectId: string; title: string; archived: boolean; workspaceState?: string }>([
      [ONE, { id: ONE, projectId: "p", title: "one", archived: false }],
      [TWO, { id: TWO, projectId: "p", title: "two", archived: true }],
      ["c", { id: "c", projectId: "p", title: "c", archived: false }],
      ["d", { id: "d", projectId: "p", title: "d", archived: false }],
      ["e", { id: "e", projectId: "p", title: "e", archived: false }],
      ["f", { id: "f", projectId: "p", title: "f", archived: false, workspaceState: "failed" }],
    ]);
    const stored: string[] = [];
    const conversations = {
      archivingNow: () => false, starting: (id: string) => id === "c", error: (id: string) => id === "d" ? "boom" : null, agentOpen: (id: string) => id === "e",
      async storedHistory(id: string, request: { limit?: number }) {
        stored.push(`${id}:${request.limit}`);
        return { status: id === "e" ? { state: "completed", run: "r", error: null, waiting: ["review"] } : { state: "working", run: "r", error: null } };
      },
      async activate() { throw new Error("observing never activates a thread"); },
    } as unknown as Conversations;
    const registry = { getThread: (id: string) => threads.get(id), getProject: () => ({ name: "cube" }) } as unknown as Registry;
    const adapter = cubeThreads({ registry, conversations, catalog: async () => [], runners: () => { throw new Error("unused"); } });
    const seen = await adapter.observe!([ONE, TWO, "c", "d", "e", "f", "gone"]);
    assert.deepEqual(Object.fromEntries([...seen].map(([id, thread]) => [id, thread?.state ?? null])),
      { [ONE]: "working", [TWO]: "archived", c: "starting", d: "machine error", e: "waiting on a background agent", f: "machine failed", gone: null });
    assert.deepEqual(stored, [`${ONE}:1`, "e:1"], "only a ready thread's store is read, one message");
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("optchat tasks: ok");
