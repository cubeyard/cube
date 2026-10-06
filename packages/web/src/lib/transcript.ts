import type { ThreadTranscript } from "./types.ts";

/** One rendered row of a thread transcript. A tool call and its result
 * share one row. */
export type TranscriptRow =
  /** `from`: a thread's report (its short id), shown as the thread's, without the "[id] " prefix. */
  | { kind: "user"; id: string; text: string; from?: string }
  | { kind: "assistant"; id: string; text: string; reasoning: boolean; labelled: boolean }
  /** `callId` outlives `id`: a streamed call is renumbered once its message is saved. */
  | { kind: "tool"; id: string; callId: string; name: string; summary: string; input: string | null; output: string; state: ToolState };
/** `waiting`: called, no result yet while the thread works; `open`: the run
 * ended without a result. */
export type ToolState = "waiting" | "running" | "done" | "error" | "open";

const SUMMARY_KEYS = ["command", "path", "file_path", "code", "pattern", "url"];
const SUMMARY_CHARS = 160;

/** Rows from the neutral event model only; no agent-specific shapes. */
export function transcriptRows(transcript: Pick<ThreadTranscript, "events" | "status">): TranscriptRow[] {
  const working = transcript.status.state === "working";
  const results = new Map<string, Extract<ThreadTranscript["events"][number], { type: "tool-result" }>>();
  const calls = new Set<string>();
  for (const event of transcript.events) {
    if (event.type === "tool-result") results.set(event.callId, event);
    else if (event.type === "tool-call") calls.add(event.callId);
  }
  const rows: TranscriptRow[] = [];
  for (const event of transcript.events) {
    if (event.type === "user-message") {
      const from = event.from;
      rows.push(from ? { kind: "user", id: event.id, text: event.text.replace(`[${from}] `, ""), from } : { kind: "user", id: event.id, text: event.text });
    }
    else if (event.type === "assistant-text") {
      rows.push({ kind: "assistant", id: event.id, text: event.text, reasoning: event.reasoning, labelled: rows.at(-1)?.kind !== "assistant" });
    } else if (event.type === "tool-call") {
      const result = results.get(event.callId);
      const { summary, input } = describeInput(event.input);
      rows.push({
        kind: "tool", id: event.id, callId: event.callId, name: event.name, summary, input, output: result?.output ?? "",
        state: result ? (!result.final ? "running" : result.isError ? "error" : "done") : working ? "waiting" : "open",
      });
    } else if (!calls.has(event.callId)) {
      rows.push({ kind: "tool", id: event.id, callId: event.callId, name: event.name, summary: "", input: null, output: event.output, state: !event.final ? "running" : event.isError ? "error" : "done" });
    }
  }
  return rows;
}

/** Whether a tool strip is unfolded: the reader's own choice, kept by
 * call id, else open while it runs, waits or failed. Every streamed frame
 * renders the strip again, so a choice that is not kept is undone. */
export function toolOpen(row: Extract<TranscriptRow, { kind: "tool" }>, chosen: ReadonlyMap<string, boolean>): boolean {
  return chosen.get(row.callId) ?? (row.state === "running" || row.state === "waiting" || row.state === "error");
}

/** A one-line summary of the call's input and, when that line cannot hold
 * it, the full text worth reading (a multi-line command or script). */
function describeInput(input: unknown): { summary: string; input: string | null } {
  let text: string | undefined;
  let full = false;
  if (typeof input === "string") text = input;
  else if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const key = SUMMARY_KEYS.find(name => typeof record[name] === "string");
    if (key) { text = record[key] as string; full = key === "command" || key === "code"; }
    else if (Object.keys(record).length > 0) text = JSON.stringify(record);
  }
  if (!text) return { summary: "", input: null };
  const firstLine = text.split("\n", 1)[0]!;
  const summary = firstLine.length > SUMMARY_CHARS ? `${firstLine.slice(0, SUMMARY_CHARS - 1)}…` : firstLine;
  return { summary, input: full && summary !== text ? text : null };
}
