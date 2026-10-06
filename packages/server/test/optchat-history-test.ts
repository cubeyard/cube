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
import { render } from "../src/claude-thread-events.ts";
import { openStorage, readStorage } from "../src/durable-agent.ts";
import { formatHistory, HISTORY_MAX, OptChat, type OptThreads, type ThreadRecord } from "../src/optchat.ts";
import { storedPiTranscript } from "../src/pi-thread-events.ts";
import type { ThreadEvent, ThreadTranscript } from "../src/thread-events.ts";
import type { Workspace } from "../src/workspace.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-history-"));
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
const ID = "abcdef12-0000-4000-8000-000000000001";
const OTHER = "99999999-0000-4000-8000-000000000002";
const transcript = (state: ThreadTranscript["status"]["state"], events: ThreadEvent[], error: string | null = null): ThreadTranscript =>
  ({ agent: "pi", owner: null, status: { state, run: state === "idle" ? null : "run-1", error }, events });
const record = (overrides: Partial<ThreadRecord>): ThreadRecord => ({
  project: "cube", title: "fix the gateway", archived: false, machine: "ready", facts: ["workspace available"], agentOpen: true,
  failure: null, transcript: null, unreadable: null, ...overrides,
});

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
    const last = formatHistory(ID, full, "delivered");
    assert.ok(!last.includes("secret thought") && !last.includes("streaming"), "no thinking, no unfinished output");
    assert.match(last, /^\[abcdef12\] cube · fix the gateway\ncubed: machine ready; workspace available\nrun: completed \(run-1\)\nlatest answer #61: done: PR #9\nreport of this run to this chat: delivered\n/);
    assert.match(last, /\nmessages #50–#61 of 62, oldest first; earlier: history\("abcdef12", before: 50\)\n#50 result bash: 24\n\n#51 tool bash \{"command":"echo 25"\}\n/);
    assert.ok(last.endsWith("\n#61 thread: done: PR #9"));
    const first = formatHistory(ID, full, "delivered", { before: 4, limit: 3 });
    assert.match(first, /messages #1–#3 of 62, oldest first; earlier: history\("abcdef12", before: 1\)\n#1 tool bash \{"command":"echo 0"\}\n#2 result bash: 0\n\n#3 tool bash/);
    const capped = formatHistory(ID, full, "delivered", { before: 9, limit: 1 });
    assert.match(capped, /#8 result bash: 3\n/);
    assert.match(capped, /characters cut/, "a long tool result is cut");
    assert.match(formatHistory(ID, full, "none", { before: 7, limit: 2 }), /#5 tool bash \{"command":"echo 2"\}\n#6 result bash \(error\): 2/, "an error result says so");
    assert.equal(formatHistory(ID, full, "none", { limit: 500 }).split("\n").filter(line => /^#\d+ /.test(line)).length, HISTORY_MAX, "the limit is clamped");
    assert.match(formatHistory(ID, full, "none", { before: 0 }), /\nmessages: none before #0 \(62 in all\)$/);
    assert.match(formatHistory(ID, full, "none", { before: 1000, limit: 1 }), /\nmessages #61–#61 of 62/, "before past the end shows the end");
    assert.match(formatHistory(ID, full, "none"), /\nreport of this run to this chat: not sent yet\n/);
    assert.match(formatHistory(ID, full, "accepted"), /\nreport of this run to this chat: accepted, not in the chat yet\n/);
  }

  // The latest answer, and a newer message that has none yet.
  {
    const asked = record({ transcript: transcript("working", [
      { type: "user-message", id: "1", text: "task" },
      { type: "assistant-text", id: "2", text: "first answer", reasoning: false, final: true },
      { type: "user-message", id: "3", text: "more" },
    ]) });
    const shown = formatHistory(ID, asked, "none");
    assert.match(shown, /\nlatest answer #1 \(before the newest message #2, which has none yet\): first answer\n/);
    assert.ok(!shown.includes("report of this run"), "a working run has no report yet");
    assert.match(formatHistory(ID, record({ transcript: transcript("idle", []) }), "none"), /\nrun: idle\nlatest answer: none\nmessages: none$/);
  }

  // Missing and unreadable history are said as such.
  assert.equal(formatHistory(ID, record({ machine: "error: workspace allocation failed: ssh: connection refused", failure: "workspace allocation failed: ssh: connection refused" }), "none"),
    "[abcdef12] cube · fix the gateway\ncubed: machine error: workspace allocation failed: ssh: connection refused; workspace available\nhistory: none stored; the agent never opened");
  assert.match(formatHistory(ID, record({ machine: "starting its machine" }), "none"), /history: none stored; the agent never opened \(its machine is still starting\)$/);
  assert.match(formatHistory(ID, record({ unreadable: "this thread was created by an older cube" }), "none"), /\nhistory: unreadable: this thread was created by an older cube$/);

  // Divergence: cubed records a failure while the store shows the agent ran;
  // both are shown, nothing is settled.
  {
    const failure = "workspace allocation failed: thread workspace already has a writable owner";
    const diverged = formatHistory(ID, record({ machine: `error: ${failure}`, failure, facts: ["workspace failed: x", "agent pi open in cubed", "workspace writer: pi"],
      transcript: transcript("completed", [{ type: "user-message", id: "1", text: "task" }, { type: "assistant-text", id: "2", text: "all tests pass", reasoning: false, final: true }]) }), "none");
    assert.match(diverged, /\ncubed: machine error: workspace allocation failed: thread workspace already has a writable owner; workspace failed: x; agent pi open in cubed; workspace writer: pi\nrun: completed \(run-1\)\nlatest answer #1: all tests pass\nreport of this run to this chat: not sent yet\nnote: cubed records a failure \(workspace allocation failed: thread workspace already has a writable owner\), yet the stored history shows the agent ran; both are shown as cubed has them\n/);
    const archived = formatHistory(ID, record({ archived: true, machine: null, agentOpen: false, facts: ["workspace available", "machine disk retained (the agent ran commands)"],
      transcript: transcript("working", [{ type: "user-message", id: "1", text: "task" }]) }), "none");
    assert.match(archived, /\ncubed: archived; workspace available; machine disk retained \(the agent ran commands\)\nrun: working \(run-1\)\nlatest answer: none\nnote: the store shows a run unfinished at archive; it does not go on\n/);
    assert.match(formatHistory(ID, record({ agentOpen: false, transcript: transcript("working", []) }), "none"),
      /\nnote: the store shows a run unfinished, but its agent is not open in cubed: it goes on only when the agent opens again\n/);
  }

  // Pi's store, read beside its running Harness: the run shows as working
  // while the model streams, then completed with its answer; nothing is
  // created, migrated or written.
  {
    const directory = path.join(root, "pi-thread");
    fs.mkdirSync(directory);
    const file = path.join(directory, "pi.sqlite");
    assert.equal(await readStorage(file), null, "no store: null");
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
      await conversation.submit({ type: "input", content: "the question", requestId: "cube:initial" }, context);
      let working: ThreadTranscript | undefined;
      for (let k = 0; k < 200 && working?.status.state !== "working"; k++) {
        const storage = (await readStorage(file))!;
        try { working = await storedPiTranscript(storage, null, null); } finally { await storage.close(context); }
        if (working.status.state !== "working") await delay(10);
      }
      assert.deepEqual(working!.status, { state: "working", run: "cube:initial", error: null });
      release();
      await conversation.waitForIdle(context);
      const storage = (await readStorage(file))!;
      try {
        const done = await storedPiTranscript(storage, "pi", "a failure cubed records");
        assert.deepEqual(done.status, { state: "completed", run: "cube:initial", error: null });
        assert.equal(done.owner, "pi");
        assert.deepEqual(done.events.map(event => event.type === "user-message" || event.type === "assistant-text" ? event.text : event.type), ["the question", "the answer"]);
        await assert.rejects(storage.commit([{ table: "conversations", value: {} } as never], context), /readonly database/, "the reader cannot write");
      } finally { await storage.close(context); }
      // The Harness goes on writing after the reader closed.
      await conversation.submit({ type: "write", requestId: "after", entry: { kind: "pi.user", model: [{ role: "user", content: "later", timestamp: Date.now() }] } }, context);
    } finally { await harness.close(context); }
    const other = path.join(root, "future.sqlite");
    const future = new DatabaseSync(other);
    future.exec("CREATE TABLE durable_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL); INSERT INTO durable_schema VALUES (1, 999)");
    future.close();
    await assert.rejects(readStorage(other), /schema version 999/, "another schema version is refused, not migrated");
  }

  // Claude Code's store, read from its file without the agent or its lease.
  {
    const directory = path.join(root, "claude-thread");
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
      async history(id) {
        asked.push(id);
        return record({ transcript: transcript("completed", [{ type: "user-message", id: "1", text: "task" }, { type: "assistant-text", id: "2", text: "PR #9", reasoning: false, final: true }]) });
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
        () => fauxAssistantMessage("read"),
      ];
      await chat.send("start one", "r1");
      for (let k = 0; k < 400 && script.length; k++) await delay(10);
      await chat.agent.conversation.waitForIdle(context);
      assert.deepEqual(asked, [ID], "only the chat's own thread is read");
      assert.match(results[1]!, /^\[abcdef12\] cube · fix the gateway\n[\s\S]*\nreport of this run to this chat: not sent yet\n/);
      assert.match(results[2]!, /no thread 99999999/);
      assert.match(results[3]!, new RegExp(`no thread ${OTHER}`));
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
