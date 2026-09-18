import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT, type AgentMessage, type Session } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { JevMemory, jevOutputComparison, redactJevDetails, toolViews, type JevAsk } from "../src/jev-memory.ts";

interface Note { text: string; source: "user" | "assistant"; createdAt: number }
const notes: Note[] = [];
const session = {
  async readList<T>() { return notes.map((value, seq) => ({ value: value as T, seq })); },
  async appendList<T>(_address: unknown, value: T) { notes.push(value as Note); },
} as unknown as Pick<Session, "readList" | "appendList">;

let key: string | null = null;
let calls = 0;
const ask: JevAsk = async (_apiKey, request) => {
  calls += 1;
  if ("view" in request.questions) return { view: { choice: "signals" }, needs_full: { noul: 0.1 } } as Record<string, { choice?: string; noul?: number }>;
  return { user: { noul: 0.8 }, assistant: { noul: 0.9 } } as Record<string, { noul?: number }>;
};
const memory = await JevMemory.create(session, () => key, BACKGROUND_CONTEXT, ask);
const full = Array.from({ length: 180 }, (_, index) => index === 90 ? `line ${index}: ERROR actionable failure` : `line ${index}: ordinary diagnostic output`).join("\n");
const event = { toolCallId: "call-1", toolName: "bash", args: { command: "test" }, content: [{ type: "text" as const, text: full }], details: { operationId: "op" }, isError: false };

assert(toolViews(full).some(view => view.name === "signals" && view.text.includes("ERROR actionable failure")));
assert.equal(await memory.afterTool(event), undefined, "missing key leaves the full result untouched");
assert.equal(calls, 0, "missing key makes no JEV request");
assert.equal(memory.transform([{ role: "user", content: "A sufficiently long user preference that should be remembered for future work.", timestamp: 1 }], "base"), undefined);
await memory.turnEnd(fauxAssistantMessage("A sufficiently long agent conclusion that should be durable in this thread."), BACKGROUND_CONTEXT);
assert.equal(calls, 0, "disabled memory neither classifies messages nor tool output");

key = "configured-key"; memory.setActive(true);
memory.transform([{ role: "user", content: "A sufficiently long user preference that should be remembered for future work.", timestamp: 1 }], "base");
const compressed = await memory.afterTool(event);
assert(compressed);
assert.match(compressed.content[0]!.type === "text" ? compressed.content[0].text : "", /jev memory: showing the signals view/);
assert.equal((compressed.details as { jevMemory: { full: string } }).jevMemory.full, full, "the exact output remains durable for recall");
assert.equal(memory.recall("call-1"), full);
assert.match(memory.recall("call-1", "89-92"), /91: line 90: ERROR actionable failure/);
assert.match(memory.recall("call-1", undefined, "actionable"), /ERROR actionable failure/);
const redacted = redactJevDetails({ role: "toolResult", toolCallId: "call-1", toolName: "bash", content: compressed.content, details: compressed.details, isError: false, timestamp: 1 });
assert(!JSON.stringify(redacted).includes("line 50: ordinary diagnostic output"), "HTTP payloads omit retained lines that were not in the compact view");
const comparison = jevOutputComparison({ role: "toolResult", toolCallId: "call-1", toolName: "bash", content: compressed.content, details: compressed.details, isError: false, timestamp: 1 });
assert.equal(comparison?.original, full);
assert.equal(comparison?.compressed, compressed.content[0]!.type === "text" ? compressed.content[0].text : "");
assert.deepEqual({ view: comparison?.view, sentLines: comparison?.sentLines, totalLines: comparison?.totalLines }, { view: "signals", sentLines: 17, totalLines: 180 });

await memory.turnEnd(fauxAssistantMessage("A sufficiently long agent conclusion that should be durable in this thread."), BACKGROUND_CONTEXT);
assert.equal(notes.length, 2, "JEV-selected user and assistant notes use Pi session storage");
const reopened = await JevMemory.create(session, () => key, BACKGROUND_CONTEXT, ask);
const prompt = reopened.transform([] as AgentMessage[], "base");
assert.match(prompt?.systemPrompt ?? "", /Memory from earlier turns/);
assert.match(prompt?.systemPrompt ?? "", /user preference/);
assert.match(prompt?.systemPrompt ?? "", /agent conclusion/);

let failures = 0;
const failing = await JevMemory.create(session, () => key, BACKGROUND_CONTEXT, async () => { failures += 1; throw new Error("network down"); });
failing.setActive(true);
assert.equal(await failing.afterTool(event), undefined, "JEV failure keeps the original tool result");
assert.equal(failures, 1);

console.log("jev-memory: strict opt-in, deterministic compression, recall, durable notes, redaction and fail-open behavior passed");
