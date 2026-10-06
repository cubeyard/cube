/** The web transcript reads only the neutral thread event model. */
import assert from "node:assert/strict";
import { toolOpen, transcriptRows } from "../src/lib/transcript.ts";
import type { ThreadEvent, ThreadStatus } from "../src/lib/types.ts";

const status = (state: ThreadStatus["state"]): ThreadStatus => ({ state, run: null, error: null });
const events: ThreadEvent[] = [
  { type: "user-message", id: "1", text: "hi" },
  { type: "assistant-text", id: "2", text: "thinking", reasoning: true, final: true },
  { type: "assistant-text", id: "3", text: "on it", reasoning: false, final: true },
  { type: "tool-call", id: "4", callId: "a", name: "bash", input: { command: "ls\npwd" }, final: true },
  { type: "tool-result", id: "5", callId: "a", name: "bash", output: "x", isError: false, final: true },
  { type: "tool-call", id: "6", callId: "b", name: "read", input: { path: "a.txt" }, final: true },
  { type: "tool-result", id: "7", callId: "b", name: "read", output: "missing", isError: true, final: true },
  { type: "tool-call", id: "8", callId: "c", name: "write", input: { path: "b.txt", content: "y" }, final: true },
  { type: "tool-result", id: "9", callId: "c", name: "write", output: "partial", isError: false, final: false },
  { type: "tool-call", id: "10", callId: "d", name: "edit", input: {}, final: true },
  { type: "tool-result", id: "11", callId: "orphan", name: "codemode", output: "z", isError: false, final: true },
];
const rows = transcriptRows({ events, status: status("working") });
assert.deepEqual(rows.map(row => row.kind), ["user", "assistant", "assistant", "tool", "tool", "tool", "tool", "tool"]);
assert.deepEqual(rows.filter(row => row.kind === "assistant").map(row => row.labelled), [true, false], "one agent label per run of text");
const tools = rows.filter(row => row.kind === "tool");
assert.deepEqual(tools.map(row => row.state), ["done", "error", "running", "waiting", "done"]);
assert.deepEqual(tools[0], { kind: "tool", id: "4", callId: "a", name: "bash", summary: "ls", input: "ls\npwd", output: "x", state: "done" }, "a call and its result share one row");
assert.equal(tools[1]!.summary, "a.txt");
assert.equal(tools[2]!.input, null, "file content is not repeated as input");
assert.equal(tools[3]!.summary, "");
assert.equal(tools[4]!.name, "codemode", "a result without a call still shows");
assert.equal(transcriptRows({ events, status: status("stopped") }).filter(row => row.kind === "tool")[3]!.state, "open", "no result after the run ended");
const longCommand = "x".repeat(400);
const summary = transcriptRows({ events: [{ type: "tool-call", id: "1", callId: "a", name: "bash", input: { command: longCommand }, final: true }], status: status("idle") })[0]!;
assert(summary.kind === "tool" && summary.summary.length === 160 && summary.input === longCommand);
const report = transcriptRows({ events: [
  { type: "user-message", id: "1", text: "[abcdef12] done: PR #212", from: "abcdef12" },
  { type: "user-message", id: "2", text: "[abcdef12] typed by the user" },
], status: status("idle") });
assert.deepEqual(report, [
  { kind: "user", id: "1", text: "done: PR #212", from: "abcdef12" },
  { kind: "user", id: "2", text: "[abcdef12] typed by the user" },
], "a thread's report is the thread's; the user's own text stays theirs");

// A strip the reader opened stays open while the run streams on: every frame
// is a new row object, and a streamed call is renumbered once it is saved.
const toolRow = (all: ThreadEvent[], state: ThreadStatus["state"]) => {
  const row = transcriptRows({ events: all, status: status(state) }).find(item => item.kind === "tool");
  assert(row?.kind === "tool");
  return row;
};
const projectsCall: ThreadEvent = { type: "tool-call", id: "live.t1.0", callId: "p", name: "projects", input: {}, final: false };
const projectsDone: ThreadEvent = { type: "tool-result", id: "live.tool.p", callId: "p", name: "projects", output: "ready", isError: false, final: true };
const chosen = new Map<string, boolean>();
const streamed = toolRow([projectsCall, projectsDone], "working");
assert.equal(toolOpen(streamed, chosen), false, "a finished strip folds by default");
chosen.set(streamed.callId, true);
const saved = toolRow([{ ...projectsCall, id: "12.0", final: true }, { ...projectsDone, id: "13.0" },
  { type: "assistant-text", id: "live.t1.1", text: "more", reasoning: false, final: false }], "working");
assert.notEqual(saved.id, streamed.id);
assert.equal(toolOpen(saved, chosen), true, "the reader's open strip stays open through later frames and the save");
assert.equal(toolOpen(toolRow([projectsCall, projectsDone], "idle"), chosen), true, "and after the run");
const running = toolRow([{ ...projectsCall, callId: "r" }], "working");
assert.equal(toolOpen(running, chosen), true, "a waiting strip opens by default");
chosen.set("r", false);
assert.equal(toolOpen(running, chosen), false, "a strip the reader folded stays folded while it runs");
console.log("ok: transcript rows pair calls with results, group agent text, summarize tool input, mark thread reports, and keep the reader's folded and unfolded strips");
