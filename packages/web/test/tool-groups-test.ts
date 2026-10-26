/** The chat folds each run of consecutive tool calls into one line: it
 * never moves, hides or reorders prose, and never reaches across a user
 * message or a report. */
import assert from "node:assert/strict";
import { groupChoiceKey, groupLine, groupOpen, groupTools, type Shown } from "../src/lib/tool-groups.ts";
import { transcriptRows } from "../src/lib/transcript.ts";
import type { ThreadEvent, ThreadStatus } from "../src/lib/types.ts";

const status = (state: ThreadStatus["state"]): ThreadStatus => ({ state, run: null, error: null });
const user = (id: string, text: string): ThreadEvent => ({ type: "user-message", id, text });
const report = (id: string, text: string): ThreadEvent => ({ type: "user-message", id, text: `[aaaaaaa1] ${text}`, from: "aaaaaaa1" });
const said = (id: string, text: string, reasoning = false, final = true): ThreadEvent => ({ type: "assistant-text", id, text, reasoning, final });
const call = (id: string, callId: string, name: string, input: unknown = {}): ThreadEvent => ({ type: "tool-call", id, callId, name, input, final: true });
const result = (id: string, callId: string, name: string, output: string, isError = false, final = true): ThreadEvent => ({ type: "tool-result", id, callId, name, output, isError, final });
const shape = (shown: Shown[]) => shown.map(item => item.kind === "row" ? item.row.kind === "tool" ? `tool:${item.row.callId}` : item.row.id : `group[${item.rows.map(row => row.kind === "tool" ? row.callId : row.id).join(",")}]`);
const rowsOf = (events: ThreadEvent[], state: ThreadStatus["state"] = "completed") => transcriptRows({ events, status: status(state) });

// several calls in a row fold; prose and user messages stay where they are
const history: ThreadEvent[] = [
  user("1", "what runs?"),
  said("2", "Looking."),
  call("3", "a", "threads"), result("4", "a", "threads", "3 threads"),
  call("5", "b", "zoom", { id: 4 }), result("6", "b", "zoom", "…"),
  call("7", "c", "artifacts"), result("8", "c", "artifacts", "2 artifacts"),
  said("9", "Three threads run."),
  call("10", "d", "tell", { id: "aaaaaaa1" }), result("11", "d", "tell", "sent to [aaaaaaa1]"),
  said("12", "Told it."),
  report("13", "turn ended. done."),
  call("14", "e", "threads"), result("15", "e", "threads", "…"),
  user("16", "and?"),
  call("17", "f", "zoom"), result("18", "f", "zoom", "…"),
];
const folded = groupTools(rowsOf(history));
assert.deepEqual(shape(folded), ["1", "2", "group[a,b,c]", "9", "tool:d", "12", "13", "tool:e", "16", "tool:f"],
  "three calls in a row fold; one call stays its own line; prose, a report and a user message end a run");
assert.deepEqual(folded.flatMap(item => item.kind === "row" ? [item.row.id] : item.rows.map(row => row.id)), rowsOf(history).map(row => row.id),
  "every row is drawn once, in its order");
const group = folded[2] as Extract<Shown, { kind: "tools" }>;
assert.equal(group.key, "a", "a group is known by its first call");
assert.deepEqual(groupLine(group.tools), { count: "3 tools called", failed: null, state: null, named: group.tools[2] }, "all done: the count and the last call");

// a run's failures are on its line, in its words; the first failed call is named
const failing = groupTools(rowsOf([
  call("1", "a", "tell"), result("2", "a", "tell", "no thread [zzzzzzzz]", true),
  call("3", "b", "threads"), result("4", "b", "threads", "…"),
  call("5", "c", "spawn"), result("6", "c", "spawn", "boom", true),
]))[0] as Extract<Shown, { kind: "tools" }>;
const failedLine = groupLine(failing.tools);
assert.equal(failedLine.failed, "2 failed");
assert.equal(failedLine.named.callId, "a", "the first failed call is named");
assert.equal(groupOpen(failing, new Map()), false, "a run that failed stays folded; its line says so");

// streaming: a run grows a call at a time and keeps its key; the moving call is named
const live: ThreadEvent[] = [user("1", "go"), call("2", "a", "threads"), result("3", "a", "threads", "…")];
assert.deepEqual(shape(groupTools(rowsOf(live, "working"))), ["1", "tool:a"], "one call: no group yet");
live.push(call("4", "b", "zoom"));
const growing = groupTools(rowsOf(live, "working"))[1] as Extract<Shown, { kind: "tools" }>;
assert.equal(growing.key, "a");
assert.deepEqual([groupLine(growing.tools).state, groupLine(growing.tools).named.callId], ["waiting", "b"], "a call without its result yet: waiting, and named");
live.push(result("5", "b", "zoom", "partial", false, false));
assert.equal(groupLine((groupTools(rowsOf(live, "working"))[1] as Extract<Shown, { kind: "tools" }>).tools).state, "running", "a partial result: running");
live.push(said("6", "thinking about it", true, false));
assert.deepEqual(shape(groupTools(rowsOf(live, "working"))), ["1", "group[a,b]", "6"], "reasoning after the last call stands outside the run");
live.push(call("7", "c", "spawn"));
assert.deepEqual(shape(groupTools(rowsOf(live, "working"))), ["1", "group[a,b,6,c]"], "reasoning between calls is part of the run, in its place");
assert.equal(groupLine((groupTools(rowsOf([call("1", "a", "x"), result("2", "a", "x", "…"), call("3", "b", "y")], "stopped"))[0] as Extract<Shown, { kind: "tools" }>).tools).state, "no result", "the run ended without a result");

// the reader's choice holds as the run grows, and when an earlier page reaches back into it
const choices = new Map<string, boolean>();
for (const tool of growing.tools) choices.set(groupChoiceKey(tool.callId), true);
const grown = groupTools(rowsOf(live, "working"))[1] as Extract<Shown, { kind: "tools" }>;
assert.equal(groupOpen(grown, choices), true, "opened, it stays open as a call joins");
const reached = groupTools(rowsOf([call("0", "z", "threads"), result("0r", "z", "threads", "…"), ...live.slice(1)], "working"))[0] as Extract<Shown, { kind: "tools" }>;
assert.equal(reached.key, "z", "an earlier call now starts the run");
assert.equal(groupOpen(reached, choices), true, "and the choice its later calls hold still holds");
choices.set(groupChoiceKey("c"), false);
assert.equal(groupOpen(grown, choices), false, "the newest call's choice wins");

// a call that returned images is shown on its own line: it ends a run
const pictured = rowsOf([
  call("1", "a", "threads"), result("2", "a", "threads", "…"),
  call("3", "b", "Read", { file_path: "/workspace/shot.png" }), { type: "tool-result", id: "4", callId: "b", name: "Read", output: "", isError: false, final: true, images: [{ id: "i", mimeType: "image/png" }] },
  call("5", "c", "zoom"), result("6", "c", "zoom", "…"),
  call("7", "d", "zoom"), result("8", "d", "zoom", "…"),
]);
assert.deepEqual(shape(groupTools(pictured)), ["tool:a", "tool:b", "group[c,d]"]);

// an echo (a message being sent) ends a run too: only rows decide
assert.deepEqual(shape(groupTools([...rowsOf([call("1", "a", "x"), call("2", "b", "y")]), { kind: "user", id: "echo", text: "hi", sending: true }])),
  ["group[a,b]", "echo"]);

console.log("tool groups: ok");
