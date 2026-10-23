/** What the chat's own log says it started and named: the threads a spawn
 * started (its result lines), the artifacts a reply links, a tool wrote or
 * a comment message came back from. Each is placed at the row that says
 * so, once, at its first mention among the rows shown. Nothing here is
 * inferred from prose or kept by hand: a row that does not name a thread or
 * an artifact in these forms gives none. */
import type { ArtifactListItem, OverviewThread, ThreadSummary } from "./types.ts";
import type { TranscriptRow } from "./transcript.ts";

/** A thread a spawn line started: its short id and what the line printed. */
export type ThreadRef = { short: string; project: string | null; title: string | null };
/** A spawn task that did not start, as its line says. */
export type Unstarted = { task: number; project: string; reason: string };
export type Mention = {
  /** The row's stable key (`rowKey`). */
  row: string;
  threads: ThreadRef[];
  /** Artifact ids or 8-character prefixes. */
  artifacts: string[];
  unstarted: Unstarted[];
};

/** A row's key for anchoring: a tool call keeps its call id while its
 * streamed message is renumbered. */
export const rowKey = (row: TranscriptRow): string => row.kind === "tool" ? `call:${row.callId}` : row.id;

/** `[aaaaaaa1] started in cube: title`; older records print no title, a
 * newer cubed may print the thread's name (` as 🦦 calm otter`) before it. */
const STARTED = /^\[([0-9a-f]{8})\] started in (.+?)(?: as [^:]+)?(?:: (.*))?$/;
const UNSTARTED = /^task (\d+) \((.+?)\) not started: (.*)$/;
const WRITTEN = /^artifact ([0-9a-f-]{36}) "/;
const LINKED = /#\/a\/([0-9a-f][0-9a-f-]{7,35})(?![0-9a-f-])/g;
const COMMENTS = /^\[artifact ([0-9a-f]{8})\]/;

/** The spawn lines of a spawn call's result. */
export function spawnLines(output: string): { threads: ThreadRef[]; unstarted: Unstarted[] } {
  const threads: ThreadRef[] = [];
  const unstarted: Unstarted[] = [];
  for (const line of output.split("\n")) {
    const started = STARTED.exec(line.trim());
    if (started) { threads.push({ short: started[1]!, project: started[2] ?? null, title: started[3]?.trim() || null }); continue; }
    const failed = UNSTARTED.exec(line.trim());
    if (failed) unstarted.push({ task: Number(failed[1]), project: failed[2]!, reason: failed[3]! });
  }
  return { threads, unstarted };
}

/** The mentions in rows, in row order; each thread and artifact once, at its first row. */
export function mentionsOf(rows: readonly TranscriptRow[]): Mention[] {
  const out: Mention[] = [];
  const seenThreads = new Set<string>();
  const seenArtifacts = new Set<string>();
  const artifact = (key: string, into: string[]) => {
    // A prefix and a whole id name one artifact; compare by the prefix.
    const prefix = key.slice(0, 8);
    if (seenArtifacts.has(prefix)) return;
    seenArtifacts.add(prefix);
    into.push(key);
  };
  for (const row of rows) {
    const mention: Mention = { row: rowKey(row), threads: [], artifacts: [], unstarted: [] };
    if (row.kind === "tool" && row.name === "spawn" && row.state !== "error") {
      const lines = spawnLines(row.output);
      for (const thread of lines.threads) if (!seenThreads.has(thread.short)) { seenThreads.add(thread.short); mention.threads.push(thread); }
      mention.unstarted = lines.unstarted;
    } else if (row.kind === "tool" && /^artifact_(write|edit)$/.test(row.name) && row.state === "done") {
      const written = WRITTEN.exec(row.output);
      if (written) artifact(written[1]!, mention.artifacts);
    } else if (row.kind === "assistant" && !row.reasoning) {
      for (const match of row.text.matchAll(LINKED)) artifact(match[1]!, mention.artifacts);
    } else if (row.kind === "user" && !row.from) {
      const comments = COMMENTS.exec(row.text);
      if (comments) artifact(comments[1]!, mention.artifacts);
    }
    if (mention.threads.length || mention.artifacts.length || mention.unstarted.length) out.push(mention);
  }
  return out;
}

/** A thread a note shows: cubed's overview first (it has the run state),
 * else the thread list (archived ones the overview no longer lists), else
 * only what the spawn line said, as not known to cube. */
export type NoteThread = {
  short: string; id: string | null; title: string | null; project: string | null;
  /** cubed's state words; null when only the list or nothing knows it. */
  state: string | null; archived: boolean; known: "overview" | "list" | "none";
  /** When the chat started it, as cubed recorded it. */
  spawned: number | null;
};
/** What the margin shows beside one row. */
export type NoteGroup = { row: string; threads: NoteThread[]; artifacts: ArtifactListItem[]; unstarted: Unstarted[] };

export function resolveThread(ref: Pick<ThreadRef, "short" | "project" | "title">, overview: readonly OverviewThread[] | null, threads: readonly ThreadSummary[]): NoteThread {
  const seen = overview?.find(thread => thread.id.startsWith(ref.short));
  if (seen) return { short: ref.short, id: seen.id, title: seen.title, project: seen.project.name, state: seen.state, archived: seen.archived, known: "overview", spawned: seen.spawned };
  const listed = threads.find(thread => thread.id.startsWith(ref.short));
  if (listed) return { short: ref.short, id: listed.id, title: listed.title, project: listed.project.name, state: listed.archived ? "archived" : null, archived: listed.archived, known: "list", spawned: null };
  return { short: ref.short, id: null, title: ref.title, project: ref.project, state: null, archived: false, known: "none", spawned: null };
}

/** The artifact a key names, when exactly one readable artifact has it. */
export function resolveArtifact(key: string, artifacts: readonly ArtifactListItem[] | null): ArtifactListItem | null {
  if (!artifacts) return null;
  const matches = artifacts.filter(item => key.length >= 36 ? item.id === key : item.id.startsWith(key));
  return matches.length === 1 ? matches[0]! : null;
}

/** The newest report of each thread among the rows, by short id. */
export function latestReports(rows: readonly TranscriptRow[]): Map<string, { row: string; text: string }> {
  const out = new Map<string, { row: string; text: string }>();
  for (const row of rows) if (row.kind === "user" && row.from) out.set(row.from, { row: row.id, text: row.text });
  return out;
}

/** Markdown cut to plain words for a one-paragraph excerpt. */
export function excerpt(markdown: string, chars = 220): string {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#{1,6}\s+.*$/m, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:[-*+]|\d+\.|>|#{1,6})\s+/gm, "")
    .replace(/[*_`|]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > chars ? `${text.slice(0, chars - 1).trimEnd()}…` : text;
}

const WROTE = /^artifact \S+ "(.*)" (created at revision|wrote revision|unchanged: the same as revision) (\d+)\./;
const VERB: Record<string, string> = { "created at revision": "created", "wrote revision": "revised", "unchanged: the same as revision": "unchanged" };

/** The chat's own tools in plain words (`name` gives a thread's title by
 * its short id); null keeps the raw tool line: a call still being written,
 * an error, or a tool these words do not cover. */
export function chatToolLine(row: Extract<TranscriptRow, { kind: "tool" }>, name: (short: string) => string | null): string | null {
  if (row.name === "spawn") {
    if (row.state === "waiting" || row.state === "running") return "starting threads…";
    if (row.state !== "done") return null;
    const { threads, unstarted } = spawnLines(row.output);
    if (!threads.length && !unstarted.length) return null;
    const started = threads.length === 1 ? "started 1 thread" : `started ${threads.length} threads`;
    return unstarted.length ? `${started} · ${unstarted.length} not started` : started;
  }
  // The thread a tell named: its answer says it, else its input does.
  const told = row.name === "tell" ? (/\[([0-9a-f]{8})\]/.exec(row.output) ?? /"id":"\[?([0-9a-f]{8})/.exec(row.summary))?.[1] : undefined;
  if (told) {
    const who = name(told) ?? `[${told}]`;
    return row.state === "done" && row.output.startsWith("not sent") ? `not sent to ${who}` : `told ${who}`;
  }
  if (/^artifact_(write|edit)$/.test(row.name) && row.state === "done") {
    const wrote = WROTE.exec(row.output);
    return wrote ? `${VERB[wrote[2]!]} ${wrote[1]} · revision ${wrote[3]}` : null;
  }
  return null;
}
