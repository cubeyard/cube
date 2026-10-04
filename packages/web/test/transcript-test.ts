/** The web transcript reads only the neutral thread event model. */
import assert from "node:assert/strict";
import { transcriptRows } from "../src/lib/transcript.ts";
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
assert.deepEqual(tools[0], { kind: "tool", id: "4", name: "bash", summary: "ls", input: "ls\npwd", output: "x", state: "done" }, "a call and its result share one row");
assert.equal(tools[1]!.summary, "a.txt");
assert.equal(tools[2]!.input, null, "file content is not repeated as input");
assert.equal(tools[3]!.summary, "");
assert.equal(tools[4]!.name, "codemode", "a result without a call still shows");
assert.equal(transcriptRows({ events, status: status("stopped") }).filter(row => row.kind === "tool")[3]!.state, "open", "no result after the run ended");
const longCommand = "x".repeat(400);
const summary = transcriptRows({ events: [{ type: "tool-call", id: "1", callId: "a", name: "bash", input: { command: longCommand }, final: true }], status: status("idle") })[0]!;
assert(summary.kind === "tool" && summary.summary.length === 160 && summary.input === longCommand);
console.log("ok: transcript rows pair calls with results, group agent text, and summarize tool input");
