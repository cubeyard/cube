/** OptChat's history tool: it reads the threads OptChat started, never
 * others; it shows cubed's record beside the agent's stored transcript and
 * says what disagrees; it pages; and the stores are read without the agent,
 * its lease or a write (Pi's beside a running Harness, Claude Code's from
 * its file). Faux models, disposable state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { ClaudeAgent } from "../src/claude-agent.ts";
import { Conversations } from "../src/conversation.ts";
import type { Registry } from "../src/registry.ts";
import type { ThreadMachines } from "../src/vm.ts";
import { render } from "../src/claude-thread-events.ts";
import { openStorage, readStorage } from "../src/durable-agent.ts";
import { formatHistory, HISTORY_MAX, OptChat, type OptThreads, type ReportState, type ThreadRecord } from "../src/optchat.ts";
import { storedPiTranscript } from "../src/pi-thread-events.ts";
import type { ThreadEvent, ThreadTranscript } from "../src/thread-events.ts";
import { pageOf, readPiHistory, type HistoryRequest } from "../src/thread-history.ts";
import type { Workspace } from "../src/workspace.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-history-"));
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
const ID = "abcdef12-0000-4000-8000-000000000001";
const OTHER = "99999999-0000-4000-8000-000000000002";
const transcript = (state: ThreadTranscript["status"]["state"], events: ThreadEvent[], error: string | null = null): ThreadTranscript =>
  ({ agent: "pi", owner: null, status: { state, run: state === "idle" ? null : "run-1", error }, events });
/** A record whose transcript is whole; `show` pages it as the reader would. */
type Whole = Omit<ThreadRecord, "transcript"> & { transcript: ThreadTranscript | null };
const record = (overrides: Partial<Whole>): Whole => ({
  project: "cube", title: "fix the gateway", archived: false, machine: "ready", facts: ["workspace available"], agentOpen: true,
  failure: null, transcript: null, unreadable: null, ...overrides,
});
const show = (whole: Whole, report: ReportState, request: HistoryRequest = {}) =>
  formatHistory(ID, paged(whole, request), report);
const paged = (whole: Whole, request: HistoryRequest = {}): ThreadRecord => ({ ...whole, transcript: whole.transcript && pageOf(whole.transcript, request) });

const claudeThreads = path.join(root, "threads", "claude");
let claudeConversations!: Conversations;
try {
  // Pagination: numbered from the first message, newest last; thinking and
  // unfinished output are left out; `before` pages back; the limit is clamped.
  {
    const events: ThreadEvent[] = [
      { type: "user-message", id: "u", text: "task" },
      { type: "assistant-text", id: "t", text: "secret thought", reasoning: true, final: true },
    ];
    for (let k = 0; k < 30; k++) {
      events.push({ type: "tool-call", id: `c${k}`, callId: `c${k}`, name: "bash", input: { command: `echo ${k}` }, final: true });
      events.push({ type: "tool-result", id: `r${k}`, callId: `c${k}`, name: "bash", output: `${k}\n${"x".repeat(k === 3 ? 2000 : 0)}`, isError: k === 2, final: true });
    }
    events.push({ type: "assistant-text", id: "a", text: "done: PR #9", reasoning: false, final: true });
    events.push({ type: "assistant-text", id: "live", text: "streaming", reasoning: false, final: false });
    const full = record({ transcript: transcript("completed", events) });
    const last = show(full, "delivered");
    assert.ok(!last.includes("secret thought") && !last.includes("streaming"), "no thinking, no unfinished output");
    assert.match(last, /^\[abcdef12\] cube · fix the gateway\ncubed: machine ready; workspace available\nrun: completed \(run-1\)\nlatest answer #61: done: PR #9\nreport of this run to this chat: delivered\n/);
    assert.match(last, /\nmessages #50–#61 of 62, oldest first; earlier: history\("abcdef12", before: 50\)\n#50 result bash: 24\n\n#51 tool bash \{"command":"echo 25"\}\n/);
    assert.ok(last.endsWith("\n#61 thread: done: PR #9"));
    const first = show(full, "delivered", { before: 4, limit: 3 });
    assert.match(first, /messages #1–#3 of 62, oldest first; earlier: history\("abcdef12", before: 1\)\n#1 tool bash \{"command":"echo 0"\}\n#2 result bash: 0\n\n#3 tool bash/);
    const capped = show(full, "delivered", { before: 9, limit: 1 });
    assert.match(capped, /#8 result bash: 3\n/);
    assert.match(capped, /characters cut/, "a long tool result is cut");
    assert.match(show(full, "none", { before: 7, limit: 2 }), /#5 tool bash \{"command":"echo 2"\}\n#6 result bash \(error\): 2/, "an error result says so");
    assert.equal(show(full, "none", { limit: 500 }).split("\n").filter(line => /^#\d+ /.test(line)).length, HISTORY_MAX, "the limit is clamped");
    const long = record({ transcript: transcript("completed", Array.from({ length: 50 }, (_, k): ThreadEvent => ({ type: "assistant-text", id: `${k}`, text: "y".repeat(5000), reasoning: false, final: true }))) });
    assert.ok(show(long, "none", { limit: HISTORY_MAX }).length < 30_000, "a full page stays within its budget");
    assert.match(show(long, "none", { limit: 1 }), /\n#49 thread: y{900}/, "a short page gives each message more");
    assert.match(show(record({ transcript: transcript("completed", long.transcript!.events.slice(0, 2)) }), "none", { limit: HISTORY_MAX }), /\n#1 thread: y{900}/, "the budget is shared by the messages shown");
    assert.match(show(full, "none", { before: 0 }), /\nmessages: none before #0 \(62 in all\)$/);
    assert.match(show(full, "none", { before: 1000, limit: 1 }), /\nmessages #61–#61 of 62/, "before past the end shows the end");
    assert.match(show(full, "none"), /\nreport of this run to this chat: not sent yet\n/);
    assert.match(show(full, "accepted"), /\nreport of this run to this chat: accepted, not in the chat yet\n/);
  }

  // The latest answer, and a newer message that has none yet.
  {
    const asked = record({ transcript: transcript("working", [
      { type: "user-message", id: "1", text: "task" },
      { type: "assistant-text", id: "2", text: "first answer", reasoning: false, final: true },
      { type: "user-message", id: "3", text: "more" },
    ]) });
    const shown = show(asked, "none");
    assert.match(shown, /\nlatest answer #1 \(before the newest message #2, which has none yet\): first answer\n/);
    assert.ok(!shown.includes("report of this run"), "a working run has no report yet");
    assert.match(show(record({ transcript: transcript("idle", []) }), "none"), /\nrun: idle\nlatest answer: none\nmessages: none$/);
  }

  // Missing and unreadable history are said as such.
  assert.equal(show(record({ machine: "error: workspace allocation failed: ssh: connection refused", failure: "workspace allocation failed: ssh: connection refused" }), "none"),
    "[abcdef12] cube · fix the gateway\ncubed: machine error: workspace allocation failed: ssh: connection refused; workspace available\nhistory: none stored; the agent never opened\nfailure to start, reported to this chat: not sent yet");
  assert.match(show(record({ machine: "starting its machine" }), "none"), /history: none stored; the agent never opened \(its machine is still starting\)$/);
  assert.match(show(record({ machine: "error: boom", failure: "boom" }), "delivered"), /\nhistory: none stored; the agent never opened\nfailure to start, reported to this chat: delivered$/);
  assert.match(show(record({ unreadable: "this thread was created by an older cube" }), "none"), /\nhistory: unreadable: this thread was created by an older cube$/);

  // Divergence: cubed records a failure while the store shows the agent ran;
  // both are shown, nothing is settled.
  {
    const failure = "workspace allocation failed: thread workspace already has a writable owner";
    const diverged = show(record({ machine: `error: ${failure}`, failure, facts: ["workspace failed: x", "agent pi open in cubed", "workspace writer: pi"],
      transcript: transcript("completed", [{ type: "user-message", id: "1", text: "task" }, { type: "assistant-text", id: "2", text: "all tests pass", reasoning: false, final: true }]) }), "none");
    assert.match(diverged, /\ncubed: machine error: workspace allocation failed: thread workspace already has a writable owner; workspace failed: x; agent pi open in cubed; workspace writer: pi\nrun: completed \(run-1\)\nlatest answer #1: all tests pass\nreport of this run to this chat: not sent yet\nnote: cubed records a failure \(workspace allocation failed: thread workspace already has a writable owner\) while the stored history shows the agent ran \(run completed\); the history does not say whether the failure came before, during or after that run\n/);
    const archived = show(record({ archived: true, machine: null, agentOpen: false, facts: ["workspace available", "machine disk retained (the agent ran commands)"],
      transcript: transcript("working", [{ type: "user-message", id: "1", text: "task" }]) }), "none");
    assert.match(archived, /\ncubed: archived; workspace available; machine disk retained \(the agent ran commands\)\nrun: working \(run-1\)\nlatest answer: none\nnote: the store shows a run unfinished at archive; it does not go on\n/);
    assert.match(show(record({ agentOpen: false, transcript: transcript("working", []) }), "none"),
      /\nnote: the store shows a run unfinished, but its agent is not open in cubed: it goes on only when the agent opens again\n/);
    assert.match(show(record({ agentOpen: false, transcript: { ...transcript("working", []), agent: "claude-code" } }), "none"),
      /\nnote: the store shows a turn unfinished, but its agent is not open in cubed: Claude Code does not continue it; it shows as failed once the agent opens again\n/);
    // A turn that ended with a background agent running: shown as still
    // running while the agent is open, as lost-on-open when it is not.
    const waiting = { ...transcript("completed", [{ type: "user-message", id: "1", text: "task" }]), agent: "claude-code" as const };
    waiting.status = { ...waiting.status, waiting: ["fable review"] };
    assert.match(show(record({ transcript: waiting }), "delivered"), /\nrun: completed \(run-1\); still running: background agent "fable review"\n/);
    assert.ok(!show(record({ transcript: waiting }), "delivered").includes("note:"));
    assert.match(show(record({ agentOpen: false, transcript: waiting }), "delivered"),
      /\nnote: the store shows background agent "fable review" running, but its agent is not open in cubed: it ended with it and shows as lost once the agent opens again\n/);
  }

  // Pi's store, read beside its running Harness: the run shows as working
  // while the model streams, then completed with its answer; nothing is
  // created, migrated or written, and reads never wait for the writer.
  {
    const directory = path.join(root, "pi-thread");
    fs.mkdirSync(directory);
    const file = path.join(directory, "pi.sqlite");
    const read = (failure: string | null = null) => readPiHistory(file, "pi", failure, { limit: HISTORY_MAX });
    const whole = () => readStorage(file, storage => storedPiTranscript(storage, "pi", null));
    assert.equal(await read(), null, "no store: null");
    assert.equal(await whole(), null, "no store: null");
    assert.ok(!fs.existsSync(file), "and none is created");
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    faux.setResponses([async () => { await held; return fauxAssistantMessage("the answer"); }]);
    const models = createModels();
    models.setProvider(faux.provider);
    const harness = await Harness.open(await openStorage(file), { models, registry: createRegistry() }, context);
    try {
      const conversation = await harness.root(context, { agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id } } });
      assert.deepEqual((await read("a failure cubed records"))!.status, { state: "idle", run: null, error: null }, "an idle run carries no failure");
      await conversation.submit({ type: "input", content: "the question", requestId: "cube:initial" }, context);
      let working: ThreadTranscript | null = null;
      for (let k = 0; k < 200 && working?.status.state !== "working"; k++) {
        working = await read();
        if (working?.status.state !== "working") await delay(10);
      }
      assert.deepEqual(working!.status, { state: "working", run: "cube:initial", error: null });
      release();
      await conversation.waitForIdle(context);
      const done = (await read("a failure cubed records"))!;
      assert.deepEqual(done.status, { state: "completed", run: "cube:initial", error: null }, "the failure is cubed's, not the run's");
      assert.equal(done.owner, "pi");
      assert.deepEqual(done.events.map(event => event.type === "user-message" || event.type === "assistant-text" ? event.text : event.type), ["the question", "the answer"]);
      // Reads while the Harness commits: none fails or waits for the writer.
      const before = fs.statSync(file).mtimeMs;
      let writing = true;
      const writes = (async () => {
        for (let k = 0; writing && k < 2000; k++) await conversation.submit({ type: "write", requestId: `w${k}`, entry: { kind: "pi.user", model: [{ role: "user", content: `w${k}`, timestamp: Date.now() }] } }, context);
      })();
      let slowest = 0;
      for (let k = 0; k < 30; k++) {
        const started = Date.now();
        const transcript = await read();
        slowest = Math.max(slowest, Date.now() - started);
        assert.equal(transcript?.status.state, "completed");
      }
      writing = false;
      await writes;
      assert.ok(slowest < 1000, `a read never waits for the writer (slowest ${slowest} ms)`);
      // A writer holding its transaction open: the read neither waits nor sees it.
      const writer = new DatabaseSync(file, { timeout: 0 });
      writer.exec("BEGIN IMMEDIATE; UPDATE durable_schema SET version = version WHERE singleton = 1");
      try {
        const started = Date.now();
        assert.equal((await read())?.status.state, "completed");
        assert.ok(Date.now() - started < 1000, "the read does not wait for an open write transaction");
      } finally { writer.exec("ROLLBACK"); writer.close(); }
      assert.ok(fs.statSync(file).mtimeMs >= before);
      assert.equal((await read())!.events.at(-1)?.type === "user-message", true, "the writer's entries are readable");
    } finally { await harness.close(context); }
    // The page is the same one the whole transcript gives.
    const all = (await whole())!;
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.startsWith(".read-")), [], "readStorage leaves no snapshot behind");
    assert.ok(all.events.length > 3);
    for (const request of [{}, { limit: HISTORY_MAX }, { before: 3, limit: 2 }, { before: 0 }]) assert.deepEqual(await readPiHistory(file, "pi", null, request), pageOf(all, request));
    const other = path.join(root, "future", "pi.sqlite");
    fs.mkdirSync(path.dirname(other));
    const future = new DatabaseSync(other);
    future.exec("CREATE TABLE durable_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO durable_schema VALUES (1, 999)");
    future.close();
    const bytes = fs.readFileSync(other);
    await assert.rejects(readStorage(other, async () => "read"), /schema version 999/, "another schema version is refused, not migrated");
    await assert.rejects(readPiHistory(other, null, null, {}), /schema version 999/, "by the page reader too");
    assert.deepEqual(fs.readFileSync(other), bytes, "and left as it was");
  }

  // Conversations.storedHistory picks the thread's store by its agent and
  // refuses a store from an older cube; it needs no machine.
  {
    const directory = path.join(root, "threads");
    const threads: Record<string, { id: string; agent?: string }> = { pi: { id: "pi" }, legacy: { id: "legacy" }, quiet: { id: "quiet" }, claude: { id: "claude", agent: "claude-code" } };
    const conversations = new Conversations({ registry: { getThread: (id: string) => threads[id] ?? null } as unknown as Registry, directory, models: createModels(), machines: {} as ThreadMachines });
    fs.mkdirSync(path.join(directory, "legacy", "session"), { recursive: true });
    await assert.rejects(conversations.storedHistory("legacy"), /created by an older cube/);
    assert.equal(await conversations.storedHistory("quiet"), null);
    await assert.rejects(conversations.storedHistory("gone"), /thread not found/);
    fs.cpSync(path.join(root, "pi-thread"), path.join(directory, "pi"), { recursive: true });
    assert.equal((await conversations.storedHistory("pi"))?.status.state, "completed");
    assert.equal(conversations.agentOpen("pi"), false);
    claudeConversations = conversations;
  }

  // Claude Code's store, read from its file without the agent or its lease.
  {
    const directory = claudeThreads;
    assert.equal(ClaudeAgent.stored(directory), null, "no store: null");
    const leases: string[] = [];
    const workspace = { lease: async () => { leases.push("taken"); return { token: "t" }; }, release: async () => {}, cancel: async () => {} } as unknown as Workspace;
    await (await ClaudeAgent.open({ directory, threadId: ID, workspace, runtime: { command: ["false"], mod: "", socket: "" }, model: "opus" })).close();
    const db = new DatabaseSync(path.join(directory, "claude.sqlite"));
    db.prepare("INSERT INTO submission(request_id, text, state, error, created_at) VALUES ('cube:initial', 'the question', 'completed', NULL, 0)").run();
    db.prepare("INSERT INTO message(submission, data) VALUES (1, ?)").run(JSON.stringify({ type: "assistant", message: { content: [
      { type: "tool_use", id: "u1", name: "Bash", input: { command: `ls ${path.join(directory, "claude")}/out.txt` } }, { type: "text", text: "the answer" }] } }));
    db.close();
    const state = ClaudeAgent.stored(directory)!;
    assert.equal(leases.length, 1, "reading takes no lease");
    const shown = render(state, null, null, path.join(directory, "claude"));
    assert.deepEqual(shown.status, { state: "completed", run: "cube:initial", error: null });
    assert.deepEqual(shown.events.map(event => event.type === "tool-call" ? event.input : event.type === "tool-result" ? event.output : event.text),
      ["the question", { command: "ls /workspace/out.txt" }, "the answer"], "host paths are shown as /workspace");
    assert.deepEqual(await claudeConversations.storedHistory("claude"), pageOf({ ...shown, owner: null }), "a claude code thread is read from its own store");
  }

  // The tool: OptChat reads its own threads only; whether a run's report
  // reached the chat comes from the chat's own submissions.
  {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const results: string[] = [];
    let script: Array<() => ReturnType<typeof fauxAssistantMessage>> = [];
    faux.setResponses(Array.from({ length: 60 }, () => async request => {
      const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
      if (system.includes("You write the memory of OptChat")) return fauxAssistantMessage("summary");
      assert.match(system, /history\(id\) reads one of your threads without changing it/, "the prompt documents the tool");
      const last = request.messages.at(-1)!;
      if (last.role === "toolResult") results.push(textOf(last));
      return script.shift()!();
    }));
    const models = createModels();
    models.setProvider(faux.provider);
    const asked: string[] = [];
    const threads: OptThreads = {
      async projects() { return "projects: cube"; },
      async runners() { return "no runners"; },
      async spawn() { return { id: ID, title: "fix the gateway" }; },
      async tell() {},
      async describe(ids) { return ids.map(id => `[${id.slice(0, 8)}] cube · ready`).join("\n"); },
      async events() { return null; },
      async history(id, request) {
        asked.push(id);
        return paged(record({ transcript: transcript("completed", [{ type: "user-message", id: "1", text: "task" }, { type: "assistant-text", id: "2", text: "PR #9", reasoning: false, final: true }]) }), request);
      },
    };
    const chat = await OptChat.open({ directory: path.join(root, "optchat"), models, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }), threads, limits: { node: 64, retryMs: 50, watchMs: 50 } });
    try {
      const call = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) => () => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
      script = [
        call("spawn", { tasks: [{ project: "cube", task: "fix the gateway" }] }, "call-spawn"),
        call("history", { id: "abcdef12" }, "call-own"),
        call("history", { id: "99999999" }, "call-other"),
        call("history", { id: OTHER }, "call-other-full"),
        call("history", { id: "[]" }, "call-empty"),
        () => fauxAssistantMessage("read"),
      ];
      await chat.send("start one", "r1");
      for (let k = 0; k < 400 && script.length; k++) await delay(10);
      await chat.agent.conversation.waitForIdle(context);
      assert.deepEqual(asked, [ID], "only the chat's own thread is read");
      assert.match(results[1]!, /^\[abcdef12\] cube · fix the gateway\n[\s\S]*\nreport of this run to this chat: not sent yet\n/);
      assert.match(results[2]!, /no thread 99999999/);
      assert.match(results[3]!, new RegExp(`no thread ${OTHER}`));
      assert.match(results[4]!, /name a thread by its id/, "an empty id names no thread");
      // The run's report reaches the chat; history then says so.
      script = [() => fauxAssistantMessage("noted"), call("history", { id: "abcdef12", before: 1 }, "call-again"), () => fauxAssistantMessage("read again")];
      await chat.send("[abcdef12] PR #9", `report:${ID}:run-1`);
      for (let k = 0; k < 400 && script.length > 2; k++) await delay(10);
      await chat.agent.conversation.waitForIdle(context);
      await chat.send("and now?", "r2");
      for (let k = 0; k < 400 && script.length; k++) await delay(10);
      await chat.agent.conversation.waitForIdle(context);
      assert.match(results.at(-1)!, /\nreport of this run to this chat: delivered\nmessages #0–#0 of 2, oldest first\n#0 user: task$/);
    } finally { await chat.close(); }
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("optchat history: ok");
