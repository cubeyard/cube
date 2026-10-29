import type { ToolState, TranscriptRow } from "./transcript.ts";

type ToolRow = Extract<TranscriptRow, { kind: "tool" }>;

/** What a conversation draws (the chat's and a thread's): a row as it is,
 * or a run of tool calls folded to one line. Rows keep their order; a group
 * only wraps rows that stand next to each other. */
export type Shown =
  | { kind: "row"; row: TranscriptRow }
  /** `key`: the first call's id (`callId` outlives a renumbered row id);
   * `rows`: the run in order, the tool rows and the transient reasoning
   * between them; `tools`: its tool rows. */
  | { kind: "tools"; key: string; rows: TranscriptRow[]; tools: ToolRow[] };

/** The fewest calls a run folds: a single call is already one line. */
export const GROUP_MIN = 2;

/** A call that returned images (a screenshot it read) is shown, not folded:
 * its strip stands open on its own line, as before. */
const folds = (row: TranscriptRow): row is ToolRow => row.kind === "tool" && !row.images?.length;

/** Folds each run of consecutive tool calls into one group. A run is tool
 * rows with nothing between them but the model's reasoning (which streams
 * and is never saved, so a saved run and the same run live fold alike);
 * prose, a user message, a report, a message being sent or a call that
 * returned images ends it, as does reasoning after the last call. Runs of
 * fewer than `GROUP_MIN` calls stay rows. */
export function groupTools(rows: readonly TranscriptRow[]): Shown[] {
  const out: Shown[] = [];
  let index = 0;
  while (index < rows.length) {
    const row = rows[index]!;
    if (!folds(row)) { out.push({ kind: "row", row }); index++; continue; }
    // the run: from this call to the last call reached through calls and reasoning only
    let end = index;
    for (let next = index + 1; next < rows.length; next++) {
      const candidate = rows[next]!;
      if (folds(candidate)) end = next;
      else if (candidate.kind !== "assistant" || !candidate.reasoning) break;
    }
    const run = rows.slice(index, end + 1);
    const tools = run.filter((item): item is ToolRow => item.kind === "tool");
    if (tools.length >= GROUP_MIN) out.push({ kind: "tools", key: tools[0]!.callId, rows: run, tools });
    else for (const item of run) out.push({ kind: "row", row: item });
    index = end + 1;
  }
  return out;
}

/** The key a reader's choice for a group is kept under, per call: a run
 * that grows (a new call) or reaches back (an earlier page read) keeps the
 * choice any of its calls holds. */
export const groupChoiceKey = (callId: string) => `tools:${callId}`;

/** Whether a group is unfolded: the reader's newest choice for any of its
 * calls, else folded. A failure does not unfold it: its line says so. */
export function groupOpen(group: Extract<Shown, { kind: "tools" }>, chosen: ReadonlyMap<string, boolean>): boolean {
  for (const tool of group.tools.toReversed()) {
    const choice = chosen.get(groupChoiceKey(tool.callId));
    if (choice !== undefined) return choice;
  }
  return false;
}

/** What a group's folded line says: how many calls, the ones that failed,
 * the run's state while it moves, and the call worth naming (the one that
 * moves, else the first that failed, else the last). */
export type GroupLine = {
  count: string;
  /** `n failed`, in error ink, or null. */
  failed: string | null;
  /** The run's state in the tool strips' words (`running`, `waiting`, `no
   * result`), or null when every call has its result. */
  state: string | null;
  /** The call the line names. */
  named: ToolRow;
};

const STATE_WORD: Partial<Record<ToolState, string>> = { running: "running", waiting: "waiting", open: "no result" };

export function groupLine(tools: readonly ToolRow[]): GroupLine {
  const failed = tools.filter(tool => tool.state === "error");
  const moving = tools.findLast(tool => tool.state === "running" || tool.state === "waiting");
  const open = tools.find(tool => tool.state === "open");
  return {
    count: `${tools.length} tools called`,
    failed: failed.length ? `${failed.length} failed` : null,
    state: STATE_WORD[(moving ?? open)?.state ?? "done"] ?? null,
    named: moving ?? failed[0] ?? tools.at(-1)!,
  };
}
