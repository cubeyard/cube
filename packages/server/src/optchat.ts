/** OptChat: the user's one endless chat with cube. It keeps no machine and
 * no code tools of its own; it starts threads and talks to them. Every turn
 * is a fresh model context: the system prompt, the view of the whole chat
 * (one-line summaries from a binary tree over the log) and the new message,
 * then that turn's own tool steps. See docs/optchat.md.
 *
 * Pi owns the state. The log is the root conversation's own entries; each
 * turn starts at an `optchat.turn` head entry; the tree's nodes are entries
 * of a second, model-free conversation in the same storage. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Context, JsonRepresentation } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { cleanupSessionResources, Type, type AssistantMessage, type Message, type Models, type Usage } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, defineTool, GenerationTask, Harness, hook, LiveDoc, ROOT_CONVERSATION_ID, section, ToolTask, type LiveState, type Conversation, type ConversationId, type Cursor, type Page, type EntryId, type EntryRecord, type TaskId, type ToolRegistration, type HookApi, type SessionEnd } from "@earendil-works/pi-durable";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openStorage } from "./durable-agent.ts";
import { agents } from "./claude-agent.ts";
import { createLogger } from "./log.ts";
import { compactNode, Spent, spent, TRIES, type Round } from "./optchat-compactor.ts";
import { cachedModels, viewPieces } from "./optchat-cache.ts";
import { CAP, capText, Memory, pages, type LogMessage, type Part } from "./optchat-memory.ts";
import { checkImage, MEDIA_LIMITS, MediaError, mediaData, mediaId, MediaStore, UNSENT_MS, type MediaRef } from "./optchat-media.ts";
import { imageNote } from "./thread-images.ts";
import { countCut, markSent, RESTART_LIMIT, SendsDoc, settleSends } from "./pi-sends.ts";
import { boundedOutput, CHAT_OUTPUT_TOKENS } from "./optchat-output.ts";
import { piReports, reportText as errorText } from "./pi-report.ts";
import type { ObservedThread, OverviewThread, ThreadOverview } from "./optchat-overview.ts";
import { PENDING_ID, STEER_LOST, type RunFeed, type ThreadAcceptance, type ThreadEvent, type ThreadEvents, type ThreadStatus, type ThreadTranscript, type ThreadWatch } from "./thread-events.ts";
import type { StartFailure } from "./thread-condition.ts";
import { artifactTools, ARTIFACT_GUIDE } from "./artifact-tools.ts";
import type { Artifacts } from "./artifact-service.ts";
import { HISTORY_MAX, HISTORY_PAGE, type HistoryPage, type HistoryRequest } from "./thread-history.ts";
import { addUsage, type OptChatUsage } from "./usage-service.ts";

const context = BACKGROUND_CONTEXT;
const log = createLogger("optchat");
export const JOBS = 8;
export const RETRY_MS = 10_000;
/** The answers (capped replies that spent output) the compactor may spend
 * on one node before it is held: three rounds of TRIES. Counted whatever
 * ended the round, an outage after them included, and kept across
 * restarts. A held node gets one more round of TRIES from a message of the
 * user or from another compactor model, never from a timer. */
export const ANSWERS = 3 * TRIES;
/** How long a thread's machine must keep failing to start before the chat
 * hears of it: cubed's recovery loop retries every 30 s. */
export const START_GRACE_MS = 2 * 60_000;
/** How long a close waits for the model calls already out (summaries being
 * built, a chat request sent) and the tool calls running to come back and be
 * stored, so a reopen does not send or run them again. The supervisor kills
 * cubed 30 s after its SIGTERM (cubed-supervisor.ts), and the rest of its
 * shutdown comes after the chat's. */
export const CLOSE_GRACE_MS = 10_000;
/** After the grace, how long the cut-off calls get to settle before Pi closes. */
const CLOSE_SETTLE_MS = 2_000;
/** How long Pi's own close may take after that: it aborts and joins every
 * task, and a tool cut off returns at once (`guard`). Past it the close goes
 * on without it, so the chat's close ends within CLOSE_GRACE_MS +
 * CLOSE_SETTLE_MS + CLOSE_JOIN_MS whatever a tool or provider does. */
const CLOSE_JOIN_MS = 2_000;

/** How each tool of the chat may run again: a close cuts off a running call
 * and the reopened run executes it again (replay "safe"), and a call cut off
 * at the cut may still be doing its work. `read` only reads. `keyed` does
 * its effect once per request id (the provider's call id or the durable
 * task's, the same on replay) and answers a replay as the first run did.
 * extension() refuses a tool missing here; optchat-replay-test runs each. */
export const TOOL_REPLAY: Readonly<Record<string, "read" | "keyed">> = {
  zoom: "read", date: "read", projects: "read", runners: "read", threads: "read", archived_threads: "read", history: "read", diagnose: "read", usage: "read", project_hooks: "read", artifact_read: "read",
  spawn: "keyed", tell: "keyed", archive: "keyed", project_hooks_write: "keyed", artifact_write: "keyed",
};

/** Tells to one thread between two messages of the user: unattended
 * follow-up is bounded; the user's next message allows more. */
export const TELLS = 8;

/** Archived threads the overview shows, newest first. */
export const ARCHIVED_SHOWN = 8;
/** Archived threads archived_threads lists per page, and at most. */
export const ARCHIVED_PAGE = 20;
export const ARCHIVED_MAX = 50;

export const MASTER = `You are OptChat, an AI agent that works for one user in a single chat that
never ends. You are the user's interface to cube. You never write code,
run commands or touch files yourself, and you have no machine: you get
work done by starting threads. A thread is a coding agent with its own
virtual machine and a checkout of one project. It does not see this chat,
so give each one a complete task that stands on its own. Follow the
user's instructions at the end of this prompt: they say who the user is,
how their projects are organized and how they want work done.

You keep no memory between turns. Each turn starts with the view below,
followed by the user's new message. Summaries keep little of tool
output, so say in your reply what you learned that will matter later.
Messages the user sends while you work reach you between tool calls.

Threads run in the background. Each one's report reaches you as a
message starting "[id] ": between your tool calls while you work, or as
a new turn once yours has ended. So never wait for one (no sleep, no
polling): go on, or end your turn and tell the user what is running.
A report says how the thread's turn ended, never that its task is done;
its reply says that. "ended its turn; nothing of it runs now" means it
does nothing more until told, whatever the reply promises. "waiting on
its background agent" means another report comes when that finishes.
"failed" and "stopped" mean it stopped short. When a thread stopped
before its task is done (it waits for CI, a review or a command nothing
tracks, or it was interrupted) and the next step is clear and within
what the user asked, tell it to go on and to wait for such things
itself; otherwise tell the user what it needs. Between two messages of
the user a thread takes at most ${TELLS} tells from you; once they are
spent, ask the user, and do not start another thread to go on instead.
tell(id, message) gives a thread that has reported more to do. A thread
that is still working gets it after its current tool call, in the same
turn; its next report covers it. Tell a working thread only to correct
or add to its task, not to ask how it is doing.
history(id) reads one of your threads without changing it: cubed's state
for it beside its latest answer and conversation. Use it when a report is
missing or short, or contradicts what threads shows; say what disagrees
rather than settle it. When a thread's machine does not start or its
agent never opened, diagnose(id) collects what cube recorded and observes
about the machine, read only; report what it shows and what it says is
missing before proposing a fix. The user sees every thread you started, with
its state as cube records it, beside this chat. An open thread holds a
machine until it is archived: archive(ids) archives threads of yours that are done, to free
theirs; history still reads them. It never stops a working thread.
threads lists only your threads that are not archived (working, ended
or failed); archived_threads(query) searches the archived ones, a page
at a time.
Images the user attaches reach you only in the turn they are sent; the
view and zoom keep only "[image]", and threads never see them. So say in
your reply what an image shows that will matter, and put in a thread's
task, in words, whatever it needs from one.`;

export const VIEW_DOC = `The view: the whole chat between OptChat and the user, oldest first, inside
<chat> tags, as one-line summaries. Each line is

  id+n|text   the n messages from id on, summarized (newlines shown as spaces)

A summary tags each item with its kind: user (the user's words), talk
(OptChat's replies), tool (OptChat's tool calls), echo (their results), note
(memories from before this chat), or work (the report of a thread, which
the log holds as a user message starting "[id] "). A short message is its
own line, word for word. Recent lines cover one message each; the older
the messages, the more a line covers. A message not summarized yet shows
as "(not summarized yet: zoom it)". No message appears in full, not even
the last ones.

Navigating: zoom(id, n) opens line id+n into the two lines of n/2
messages it was made from; zoom(id, 1) gives message id in full. A long
message is logged as several in a row; one logged before that comes a page
at a time, with the at to go on with. Zoom
whenever a summary only mentions something you need, such as what your
last reply said, a decision, a past attempt or where a file is, before
you act, guess or ask. date(id) gives the date and time of message id.`;

/** OptChat's part in work artifacts: it writes its own and revises its
 * threads'; a thread revises any artifact of its project. */
export const ARTIFACTS_NOTE = `Artifacts: artifact_write makes a document the user reads beside the
chat, with revisions, comments and confirmed actions; artifact_read reads
yours and your threads', and you may revise those. Threads can write their
own (a review of their pull request, say); ask for one in a thread's task
when the result is worth reading at length. A thread can also revise any
artifact of its project, yours included when you named the project: to have
a reviewer update an existing document rather than start another, give it
the artifact's id and tell it to read the newest revision, then write the
whole document on top of it (artifact_write with that id, or in Claude Code
Read and then Write /cube/artifacts/<id>.md). Link an artifact in your reply
as [title](#/a/<id>). Comments the user leaves on yours come to you as a
message starting "[artifact <id>]"; comments on a thread's go to that
thread, whoever wrote the revision. ${ARTIFACT_GUIDE}`;

/** OptChat's part in project hooks (project-hooks.ts, docs/project-hooks.md). */
export const HOOKS_NOTE = `Project hooks: a project in cube's projects has two external hooks,
pre-setup and pre-resume, shell scripts cube runs in each of its thread
machines before the repository's own .agents/setup and .agents/resume.
They live in cube, not in the repository. project_hooks(project) reads
them back with their latest outcomes; project_hooks_write(project, ...)
saves them, only when the user asked for it and named the project, and
answers with what cubed now has; a thread's report never counts as the
user asking, and the tool refuses a turn the user did not write in. Do
these yourself; a thread cannot change hooks. Hooks run commands in
every new thread machine of that project, so show the user the scripts
you saved. Nothing else (a timeout, a working directory, another
trigger) can be set.`;

/** What a thread report says when the thread started: its final reply is the report. */
export const THREAD_NOTE = "(This thread was started by OptChat, the user's chat agent. Your final reply is your report to it. "
  + "Once you end your turn nothing wakes you, so do not end it to wait for CI, a review or a command: "
  + "wait for those yourself in the foreground (a command runs at most 10 minutes; repeat a bounded wait such as `timeout 590 gh pr checks <n> --watch`), then go on. "
  + "If you stop before the task is done, say plainly what is left and what you are waiting for.)";

/** Where OptChat's threads come from: cube's projects and threads. */
/** archived_threads' search: a case-insensitive substring of a thread's id,
 * title or project, and a page of the matches. */
export type ThreadListRequest = { archived?: boolean; query?: string | undefined; offset?: number | undefined; limit?: number | undefined };

export interface OptThreads {
  /** Projects, models and capacity a new thread can use, as text. */
  projects(): Promise<string>;
  /** Each runner's last report (version, platform, machines) and what is unknown, as text. */
  runners(): Promise<string>;
  /** Starts one thread; the same request id finds the same thread again. */
  /** `runner`: a runner's node id or id; the thread starts there and stays
   * (a host runner takes no other threads). Absent: the pool chooses. */
  spawn(task: { project: string; task: string; model?: string | undefined; runner?: string | undefined }, requestId: string, signal?: AbortSignal): Promise<{ id: string; title: string }>;
  /** A message to a thread. One that works gets it steered into its running
   * turn; the answer says what the thread did with it (void: started). */
  tell(id: string, text: string, requestId: string): Promise<ThreadAcceptance | void>;
  /** One line per thread, in the order given: its state and title. By
   * default only threads not archived, then how many archived ones were
   * left out; `archived`: only archived ones matching `query` (id, title or
   * project), `limit` from `offset` on, with where the next page starts. */
  describe(ids: readonly string[], request?: ThreadListRequest): Promise<string>;
  /** The thread's events; null once it is archived or gone; "archiving"
   * while its archive (or a release left unfinished) goes on; "stored"
   * while its agent is not open or is down (its machine starting, failing,
   * suspended or being woken): nothing is started for a watcher, whose
   * report comes from `history`. A start that fails is told by
   * `onStartFailure`, not here. */
  events(id: string): Promise<ThreadEvents | null | "archiving" | "stored">;
  /** The thread's start failure now (its start or wake does not succeed);
   * null: none, or no such thread. */
  startFailure(id: string): StartFailure | null;
  /** `listener` runs whenever a thread's start failure changes (null: it
   * ended); `startFailure` reads what it missed. Returns the unsubscribe. */
  onStartFailure(listener: (id: string, failure: StartFailure | null) => void): () => void;
  /** `listener` runs whenever a thread's run feed opens or closes: a run
   * settles only in an open feed, and a closed feed's stored last run is
   * final until it opens again. Returns the unsubscribe. */
  onRunFeed(listener: (fact: RunFeed) => void): () => void;
  /** What cubed has of a thread, read only: its own record beside a page of
   * the agent's stored transcript, which may disagree. null: no such thread. */
  history(id: string, request?: HistoryRequest): Promise<ThreadRecord | null>;
  /** Archives a thread: its agent closes and its machine is released, as
   * the UI's archive does; its stored history stays. Refused, with nothing
   * stopped, while the thread works or its machine starts. An archived
   * thread is left as it is (`already`). null: no such thread. */
  archive?(id: string): Promise<{ already: boolean; disk: string; free: string } | null>;
  /** Usage and estimated cost as text: of everything, a project, or one
   * thread (an id or its first characters). Read-only. */
  usage?(query: { project?: string | undefined; thread?: string | undefined }): Promise<string>;
  /** Each thread's state as cubed records it now, read only; null: no such
   * thread. An archived thread reads as "archived" unless `archivedRuns`,
   * then as its stored last run. */
  observe?(ids: readonly string[], options?: { archivedRuns?: boolean }): Promise<Map<string, ObservedThread | null>>;
  /** Evidence about the thread's machine as bounded, cleaned text
   * (vm-diagnostics.ts); read only. null: no such thread. */
  diagnose?(id: string): Promise<string | null>;
  /** A project's saved hooks and their latest outcomes, as text
   * (project-hooks.ts); `project` is a name or id. */
  hooks?(project: string): Promise<string>;
  /** Saves a project's hooks (absent: kept, "": removed) and reads them back,
   * as text. The same request id saves once and answers the same text again. */
  writeHooks?(project: string, hooks: { preSetup?: string | undefined; preResume?: string | undefined }, requestId: string): Promise<string>;
}

export type ThreadRecord = {
  project: string;
  title: string | null;
  archived: boolean;
  /** The machine as cubed sees it ("ready", "starting its machine",
   * "error: …"); null once archived. */
  machine: string | null;
  /** Other facts of cubed's record: workspace, retained disk, agent, writer. */
  facts: string[];
  /** Whether the agent is open in cubed: a stored run goes on only then. */
  agentOpen: boolean;
  /** The machine or workspace failure cubed records, if any. */
  failure: string | null;
  /** A page of the agent's stored transcript; null when it stored none or `unreadable`. */
  transcript: HistoryPage | null;
  unreadable: string | null;
};

export { HISTORY_MAX, HISTORY_PAGE };
export type { ObservedThread, OverviewThread, ThreadOverview };
/** A page's messages share this many characters; one gets at most HISTORY_TEXT. */
const HISTORY_BUDGET = 24_000;
const HISTORY_TEXT = 2000;
const HISTORY_TOOL = 400;
const HISTORY_ANSWER = 4000;

function historyLine(event: ThreadEvent, cap: number): string {
  if (event.type === "user-message") return `user: ${capText(event.text, cap)}`;
  if (event.type === "assistant-text") return `thread: ${capText(event.text, cap)}`;
  const tool = Math.min(cap, HISTORY_TOOL);
  if (event.type === "tool-call") return `tool ${event.name} ${capText(JSON.stringify(event.input ?? {}), tool)}`;
  // The images a result shows are named, never sent: the chat sees that there were some.
  const images = imageNote(event.images?.length ?? 0);
  return `result ${event.name}${event.isError ? " (error)" : ""}: ${[images, capText(event.output, tool)].filter(Boolean).join(" ")}`;
}

export type ReportState = "delivered" | "accepted" | "none";
const reportText = (report: ReportState) => report === "delivered" ? "delivered" : report === "accepted" ? "accepted, not in the chat yet" : "not sent yet";

/** The history tool's answer: cubed's record of the thread, the run and the
 * latest answer from its stored transcript, whether this chat got the run's
 * report (or, without a transcript, the failure to start), what disagrees,
 * then the record's page of messages, numbered from the first. */
export function formatHistory(id: string, record: ThreadRecord, report: ReportState): string {
  const lines = [`[${short(id)}] ${record.project} · ${record.title ?? "untitled"}`,
    `cubed: ${[record.archived ? "archived" : `machine ${record.machine}`, ...record.facts].join("; ")}`];
  const transcript = record.transcript;
  if (!transcript) {
    lines.push(record.unreadable ? `history: unreadable: ${record.unreadable}`
      : `history: none stored; the agent never opened${record.machine === "starting its machine" ? " (its machine is still starting)" : ""}`);
    if (record.failure) lines.push(`failure to start, reported to this chat: ${reportText(report)}`);
    return lines.join("\n");
  }
  const { state, run, error } = transcript.status;
  const waiting = transcript.status.waiting ?? [];
  lines.push(`run: ${state}${run ? ` (${run})` : ""}${error ? `: ${error}` : ""}${waiting.length ? `; still running: ${agents(waiting)}` : ""}`);
  const { answer, asked } = transcript;
  lines.push(!answer ? "latest answer: none" : `latest answer #${answer.index}${asked > answer.index ? ` (before the newest message #${asked}, which has none yet)` : ""}: ${capText(answer.text.trim(), HISTORY_ANSWER)}`);
  if (state !== "idle" && state !== "working" && run) lines.push(`report of this run to this chat: ${reportText(report)}`);
  // Disagreements are shown as cubed has them; this view does not settle them.
  const notes: string[] = [];
  if (record.failure && state !== "idle") notes.push(`cubed records a failure (${record.failure}) while the stored history shows the agent ${state === "working" ? "working" : `ran (run ${state})`}; the history does not say whether the failure came before, during or after that run`);
  if (state === "working" && record.archived) notes.push("the store shows a run unfinished at archive; it does not go on");
  else if (state === "working" && !record.agentOpen) notes.push(transcript.agent === "claude-code"
    ? "the store shows a turn unfinished, but its agent is not open in cubed: Claude Code does not continue it; it shows as failed once the agent opens again"
    : "the store shows a run unfinished, but its agent is not open in cubed: it goes on only when the agent opens again");
  if (waiting.length && (record.archived || !record.agentOpen)) notes.push(`the store shows ${agents(waiting)} running, but its agent is not open in cubed: ${waiting.length === 1 ? "it ended with it and shows" : "they ended with it and show"} as lost once the agent opens again`);
  for (const note of notes) lines.push(`note: ${note}`);
  const { total, start, events } = transcript;
  const end = start + events.length;
  const cap = Math.min(HISTORY_TEXT, Math.floor(HISTORY_BUDGET / Math.max(1, events.length)));
  if (!total) lines.push("messages: none");
  else if (start === end) lines.push(`messages: none before #${end} (${total} in all)`);
  else {
    lines.push(`messages #${start}–#${end - 1} of ${total}, oldest first${start > 0 ? `; earlier: history("${short(id)}", before: ${start})` : ""}`);
    events.forEach((event, k) => lines.push(`#${start + k} ${historyLine(event, cap)}`));
  }
  return lines.join("\n");
}

/** `cache` names the chat for the providers' prompt caches; it never changes. */
/** `tells`: the tell calls to a thread since the user's last message. */
/** `archives`: by archive call (its task id), each thread it named and the
 * line it answered, "" while it was out; a replay answers those lines. */
type Settings = { tree: number; cache: string; threads: Record<string, { at: number; tells?: string[] }>; archives?: Record<string, Record<string, string>> };
const SettingsDoc = defineDoc<Settings>({ kind: "cube.optchat", version: 1, checkpointWhen: () => false, scope: "session", initial: () => ({ tree: 0, cache: "", threads: {} }) });
/** The view parts the current turn started with; the request hook renders
 * them. `userInputs`: the latest run inputs that carry a message of the
 * user (not a thread's report); project_hooks_write needs one among the
 * running run's inputs. `images`: the store ids of the images the turn's
 * messages carry, by request id (turns started before it lack it). */
const TurnDoc = defineDoc<{ started: boolean; parts: number[]; userInputs?: number[]; images?: Record<string, string[]> }>({
  kind: "cube.optchat.turn", version: 1, checkpointWhen: () => false, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ started: false, parts: [] }),
});
const isReport = (requestId: string) => requestId.startsWith("report:");
/** A message accepted when the log had `after` as its newest entry. */
type PendingItem = { text: string; requestId: string; after: number; images?: MediaRef[] };
/** Messages accepted but not yet in the chat: waiting (`items`), going into
 * the next turn (`batch`), or submitted but not placed by Pi yet (`sent`). */
type Pending = { items: PendingItem[]; batch: PendingItem[] | null; sent: PendingItem[] };
const PendingDoc = defineDoc<Pending>({ kind: "cube.optchat.pending", version: 1, checkpointWhen: () => false, scope: "session", initial: () => ({ items: [], batch: null, sent: [] }) });
/** The view as of the newest node, over the first `total` messages: a reopen
 * goes on from it instead of folding a different view. `batch` is set while
 * a batch has not yet merged the view down to its low mark; views stored
 * before batching lack it and were never mid-batch. `compaction` and
 * `compactionBatch` are the compactor's view and its batch the same way;
 * views stored before it lack them, and it is merged down from the view. */
const ViewDoc = defineDoc<{ total: number; parts: number[]; batch?: boolean; compaction?: number[]; compactionBatch?: boolean; entry?: number; shape?: string; shapeTotal?: number }>({ kind: "cube.optchat.view", version: 1, checkpointWhen: () => false, scope: "session", initial: () => ({ total: 0, parts: [] }) });
/** How the log is read from Pi's entries: entries from `pagedFrom` on log a
 * long message in pages (spec §1); older ones as they were logged before
 * pages, so their messages keep their ids. Set at the first open that knows it. */
const LogDoc = defineDoc<{ pagedFrom?: number }>({ kind: "cube.optchat.log", version: 1, checkpointWhen: () => false, scope: "session", initial: () => ({}) });
/** The compactor's model calls run beside Pi, so Pi's `pi.usage` does not
 * see them: their usage by `provider/model`, one commit per reply, failed
 * replies included. `since` is when this store began counting; `earlier`
 * says its tree already had compactor-built nodes then, whose calls nobody
 * counted. */
type CompactorUsage = { models: Record<string, JsonRepresentation<Usage>>; calls: Record<string, number>; since: number | null; earlier?: boolean };
const CompactorUsageDoc = defineDoc<CompactorUsage>({ kind: "cube.optchat.usage", version: 1, checkpointWhen: () => false, scope: "session", initial: () => ({ models: {}, calls: {}, since: null }) });
/** What the compactor may still spend on each node it has not built: its
 * answers left and the model (`provider/id`) that spent the last. A node
 * with none left is held; a built node's record goes with it. */
/** `round`: the round a close held before its next answer, which the next
 * build under the same model goes on with (taken once). `out`: an answer
 * is being asked, already taken from `left`, stored before it is sent and
 * cleared with its reply; one found at an open was out at the stop. */
/** `interrupted`: its last answer was out at a stop (counted), so it is held
 * until a message of the user or another model asks again. */
type Spend = { left: number; model: string; round?: JsonRepresentation<Round>; out?: { at: number }; interrupted?: true };
const SpendDoc = defineDoc<{ nodes: Record<string, Spend> }>({ kind: "cube.optchat.spend", version: 1, checkpointWhen: () => false, scope: "session", initial: () => ({ nodes: {} }) });
/** Model calls a close cut off after its grace, by `provider/model`: what
 * they cost is unknown (their usage, if any came, is counted as it came),
 * and the reopened chat may send them again. `tools`: tool calls still
 * running at the cut, by name: what they did is unknown (their work may go
 * on, it is not undone), and the reopened run executes them again, keyed. */
/** `capped`: model calls cube's output guard stopped (optchat-output.ts); their provider reported no usage. */
type Cut = { chat: Record<string, number>; compactor: Record<string, number>; tools?: Record<string, number>; capped?: { chat: Record<string, number>; compactor: Record<string, number> } };
const CutDoc = defineDoc<Cut>({ kind: "cube.optchat.cut", version: 1, checkpointWhen: () => false, scope: "session", initial: () => ({ chat: {}, compactor: {} }) });
const TURN = "optchat.turn";
const NODE_ENTRY = "optchat.node";

const short = (id: string) => id.slice(0, 8);
/** An archive call's record of the free machines it last read: no thread id. */
const FREE = " free";
/** A tool's text result. */
const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
/** A zoom result's lines start with their ids. */
const ZOOMED = /^\d+\+\d+\|/;
export const ZOOM_ECHO = "(the zoomed lines: a copy of earlier messages of this chat, not repeated here)";
/** A message's content for Pi: its text, then its images as references to
 * the media store, which the request hook fills in for the model. */
const userContent = (item: Pick<PendingItem, "text" | "images">) => !item.images?.length ? item.text
  : [...item.text ? [{ type: "text" as const, text: item.text }] : [], ...item.images.map(image => ({ type: "image" as const, mimeType: image.mimeType, data: mediaData(image.id) }))];
const userEntry = (item: Pick<PendingItem, "text" | "images">) => ({ kind: "pi.user", model: [{ role: "user" as const, content: userContent(item), timestamp: Date.now() }] });
/** The store ids an entry's user messages refer to. */
export function entryImages(entry: EntryRecord): string[] {
  if (entry.kind !== "pi.user") return [];
  return (entry.model ?? []).flatMap(message => message.role !== "user" || typeof message.content === "string" ? []
    : message.content.flatMap(part => part.type === "image" ? [mediaId(part.data)].filter(id => id !== null) : []));
}
const flatParts = (parts: readonly Part[]) => parts.flatMap(part => [part.l, part.i]);
const toParts = (flat: readonly number[]) => {
  const parts: Part[] = [];
  for (let k = 0; k + 1 < flat.length; k += 2) parts.push({ l: flat[k]!, i: flat[k + 1]! });
  return parts;
};
const textOf = (content: Message["content"]) => typeof content === "string" ? content
  : content.map(part => part.type === "text" ? part.text : part.type === "image" ? "[image]" : "").join("\n");

/** The log messages one Pi entry holds. Thoughts are never logged. With
 * `page`, a long message or reply is logged in pages of that many
 * characters, never cut; tool results and calls are capped instead. How
 * many messages an entry gives decides every later id: a change to it is
 * caught at the next open (`shape`) and refused. */
export function entryMessages(entry: EntryRecord, page = 0): LogMessage[] {
  const out: LogMessage[] = [];
  const paged = (kind: "user" | "talk", text: string, date: number) => { for (const part of page ? pages(text, page) : [text]) out.push({ kind, text: part, date }); };
  for (const message of entry.model ?? []) {
    const date = message.timestamp;
    if (entry.kind === "pi.user" && message.role === "user") paged("user", textOf(message.content), date);
    else if (entry.kind === "pi.assistant" && message.role === "assistant") {
      // A failed attempt is retried and never reaches the model again; an
      // aborted one ran none of its tool calls.
      if (message.stopReason === "error") continue;
      for (const part of message.content) {
        if (part.type === "text" && part.text.trim()) paged("talk", part.text, date);
        else if (part.type === "toolCall" && message.stopReason !== "aborted") out.push({ kind: "tool", text: capText(`${part.name} ${JSON.stringify(part.arguments ?? {})}`), date });
      }
    } else if (entry.kind === "pi.tool-result" && message.role === "toolResult") {
      // A zoom result copies lines of this chat: logged as a pointer, so the
      // compactor neither summarizes the copy again nor reads its ids and
      // "user:" tags as new words of the user.
      const text = textOf(message.content);
      out.push({ kind: "echo", text: message.toolName === "zoom" && ZOOMED.test(text) ? ZOOM_ECHO : capText(text), date });
    }
  }
  return out;
}

/** The report a settled thread run sends: its last reply, or why it ended. */
export function threadReport(transcript: ThreadTranscript): string {
  const events = transcript.events;
  const lastUser = events.findLastIndex(event => event.type === "user-message");
  const reply = events.slice(lastUser + 1).findLast(event => event.type === "assistant-text" && !event.reasoning);
  return runReport(transcript.status, reply?.type === "assistant-text" ? reply.text : "");
}

/** A reply that says its thread waits for something. */
const WAITS = /\b((a)?wait(s|ing)? (for|on|until)|awaiting|once (the )?(ci|checks?|reviews?|builds?|tests?|pipeline)\b|(ci|checks?|reviews?|builds?|tests?|pipeline) (is|are) (still )?(running|pending|queued|in progress)|will (report|follow up|check back|get back|let you know)|still (running|pending|in progress))/i;

/** The report of a run that ended with `status`, whose reply (after the
 * newest message) is `reply`. It says how the turn ended and what of the
 * thread still runs, never that the task is done: only the reply says that. */
export function runReport(status: ThreadStatus, reply: string): string {
  const text = reply.trim();
  const said = text ? `: ${text}` : " without a reply";
  const last = text ? `; last reply: ${text}` : "";
  if (status.state === "completed") {
    const waiting = status.waiting ?? [];
    // A message steered into the run that never reached its agent.
    const note = status.error && STEER_LOST.test(status.error) ? ` (${status.error})` : "";
    if (waiting.length) return `ended its turn, waiting on its ${agents(waiting)}; another report comes when ${waiting.length === 1 ? "it finishes" : "they finish"}${note}${said}`;
    if (WAITS.test(text)) return `ended its turn; nothing of it runs now and nothing wakes it, though its reply speaks of waiting: it goes on only when told${note}${said}`;
    return `ended its turn; nothing of it runs now${note}${said}`;
  }
  if (status.state === "stopped") return `stopped${status.error ? `: ${status.error}` : ""}${last}`;
  return `failed: ${status.error ?? "unknown error"}${last}`;
}

export type OptChatOptions = {
  directory: string;
  models: Models;
  /** The model a new chat starts with. */
  model: () => Promise<{ provider: string; id: string } | null>;
  /** The compactor's model, asked again before each node it writes (a node
   * already being written keeps its model); null: the chat's own model. */
  compactor?: () => Promise<{ provider: string; id: string } | null>;
  threads: OptThreads;
  /** Work artifacts: the chat writes its own and reads its threads'. */
  artifacts?: Artifacts;
  /** Tests lower these. */
  limits?: { view?: number; low?: number; node?: number; compaction?: number; compactionLow?: number; jobs?: number; retryMs?: number; watchMs?: number; startGraceMs?: number; page?: number; closeMs?: number };
};

/** The log's shape after one more entry: a hash over how many messages each
 * entry gave, so a reopen can tell a log that numbers its messages as the
 * stored view did from one that does not. */
const nextShape = (shape: string, entry: number, count: number) => count ? createHash("sha256").update(`${shape},${entry}:${count}`).digest("hex") : shape;

/** Why a stored view must not be restored over this log, or null. `shape`
 * and `shapeTotal` (`total` before it) are this log's hash and count through
 * the view's `entry`; `checked` is the same read from the log now. A cubed
 * before the shape keeps them as they are while it grows `total`: then the
 * view was numbered without pages, which differs only if `paged` (an entry
 * from `pagedFrom` on that gives more messages in pages). */
export function viewMismatch(stored: { total: number; entry?: number; shape: string; shapeTotal?: number }, checked: { total: number; shape: string }, paged: () => boolean): string | null {
  const own = stored.shapeTotal ?? stored.total;
  if (checked.total !== own || checked.shape !== stored.shape) return `the chat's log numbers its messages differently from its memory (${checked.total} messages through entry ${stored.entry}, ${own} when stored); not opened, so no summary is put on the wrong message`;
  if (stored.total !== own && paged()) return `an older cubed numbered the chat's log without pages since its memory was stored (${stored.total} messages then); not opened, so no summary is put on the wrong message`;
  return null;
}

export class OptChat {
  readonly memory: Memory;
  private harness!: Harness;
  private conversation!: Conversation;
  private storage!: SqliteStorage;
  private tree = 0 as ConversationId;
  private lastEntry = 0;
  /** The log's shape through `lastEntry`, and the first entry logged in pages. */
  private shape = "";
  private pagedFrom = 0;
  private readonly busy = new Set<string>();
  private readonly failed = new Set<string>();
  /** Each unbuilt node's answers left, as SpendDoc stores them. */
  private readonly spend = new Map<string, Spend>();
  /** Nodes held with their answers spent (busy, no timer), and why. */
  private readonly held = new Map<string, string>();
  /** Counts of the user's messages and of compactor model changes, so a
   * node whose last answer was out when one came is not held past it. */
  private asks = 0;
  private changes = 0;
  /** The last error each failing node gave, for the held message. */
  private readonly why = new Map<string, string>();
  private compactorError: string | null = null;
  private readonly watchers = new Map<string, Promise<ThreadWatch | null>>();
  private readonly reported = new Map<string, string>();
  /** Threads whose report could not be handed to the chat: the next round
   * reads their stored run again (the request id keeps it to once). */
  private readonly unsent = new Set<string>();
  /** The threads this chat started (its SettingsDoc's), as this process knows them. */
  private readonly mine = new Set<string>();
  /** Threads to attach again in the next round: a watch that ended, an
   * attach that failed, an archive that may still be refused. */
  private readonly reattach = new Set<string>();
  private unsubscribeFeed: (() => void) | undefined;
  /** Failure reports handed to the chat (by request id) in this process. */
  private readonly startReported = new Set<string>();
  /** When each thread's start was first told failing (`onStartFailure`), until it is told ended. */
  private readonly startFailing = new Map<string, number>();
  /** Each thread's start failure as cubed last told it. */
  private readonly failing = new Map<string, StartFailure>();
  private unsubscribeStart: (() => void) | undefined;
  private lock: Promise<unknown> = Promise.resolve();
  private cacheKey = "optchat";
  private compactorModels!: Models;
  private readonly waiters = new Set<() => void>();
  private readonly pendingListeners = new Set<() => void>();
  private draining: Promise<void> | null = null;
  private again = false;
  private syncing: Promise<void> | null = null;
  private dirty = false;
  /** Set when a close begins: no new work starts (no node, no turn, no
   * request of the chat); what is out is waited for, then cut off. */
  private closing = false;
  private closed: Promise<void> | undefined;
  /** Each node being built, settled either way, so a close can wait for it. */
  private readonly building = new Map<string, Promise<void>>();
  /** The compactor calls out now: node → `provider/model`. */
  private readonly calling = new Map<string, string>();
  /** The nodes whose answer a close cut off and counted. */
  private readonly cutOff = new Set<string>();
  /** Chat requests and tool calls held back by a close, unstarted, until Pi
   * closes. */
  private readonly gated = { requests: 0, tools: 0 };
  /** Tool calls executing now (task → name), and those a close holds back
   * at their execute phase (a replay), whose slot already reads running. */
  private readonly running = new Map<TaskId, string>();
  private readonly heldTools = new Set<TaskId>();
  private readonly abort = new AbortController();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private watchTimer: ReturnType<typeof setInterval> | undefined;
  private stopWatch: (() => Promise<void>) | undefined;
  private model: { provider: string; id: string } | null = null;
  /** Archived threads' last runs, read once each. */
  private readonly archivedRuns = new Map<string, ObservedThread>();
  /** The attached images; `referenced`: the ids the log's messages hold. */
  media!: MediaStore;
  private readonly referenced = new Set<string>();
  private mediaLock: Promise<unknown> = Promise.resolve();
  private readonly options: OptChatOptions;
  private constructor(options: OptChatOptions) {
    this.options = options;
    this.memory = new Memory(options.limits ?? {});
  }

  static async open(options: OptChatOptions): Promise<OptChat> {
    const chat = new OptChat(options);
    try { await chat.start(); }
    catch (error) { await chat.close(); throw error; }
    return chat;
  }

  /** The chat as the Pi adapter of the thread event model reads it. */
  get agent() { return { conversation: this.conversation, storage: this.storage }; }
  /** Why the chat cannot go on right now, if it cannot. */
  failure(): string | null {
    return this.down ?? (this.compactorError ? `summarizing: ${this.compactorError}` : null) ?? this.requestError;
  }
  /** Set when Pi's Session failed (a storage error): the chat is down. */
  private down: string | null = null;
  /** The last request the chat refused to send, until the hook next builds
   * one and hands it to Pi to send. */
  private requestError: string | null = null;
  /** This open's epoch, which each chat request's send record carries (pi-sends.ts). */
  private epoch = 0;

  /** Pi ended the Session by itself: a Storage call failed, so nothing more
   * can be recorded, and every call of the Harness now rejects. The chat
   * closes at once, without the close's grace (nothing it would wait for
   * can be stored): no node, turn or retry starts, the compactor's calls
   * are cut off, and the provider sessions are released. It stays down
   * until cubed restarts; it does not reopen by itself (D2′ is open). */
  private ended(end: SessionEnd): void {
    if (end.reason !== "failed" || this.closing) return;
    this.down = `the chat stopped: its history could not be saved (${errorText(end.error)}); it stays stopped until cubed restarts`;
    log.error("chat session failed; the chat is down until cubed restarts", { error: errorText(end.error) });
    this.notify();
    void this.close();
  }

  /** `listener` runs whenever the pending messages change. */
  onPending(listener: () => void): () => void {
    this.pendingListeners.add(listener);
    return () => { this.pendingListeners.delete(listener); };
  }
  private pendingChanged(): void { for (const listener of [...this.pendingListeners]) listener(); }

  /** Where a message that left the pending ones went: its entry in the log,
   * null when it settled without one; undefined when not known (yet). Kept
   * for the newest few, written before the message leaves the pending ones. */
  loggedAt(requestId: string): number | null | undefined { return this.logged.get(requestId); }
  private readonly logged = new Map<string, number | null>();
  private async remember(requestIds: readonly string[], unanswered = false): Promise<void> {
    for (const requestId of requestIds) {
      const entry = (await this.known(requestId))?.entry ?? (unanswered ? (await this.known(`${requestId}:unanswered`))?.entry : undefined);
      this.logged.delete(requestId);
      this.logged.set(requestId, entry ?? null);
    }
    for (const key of this.logged.keys()) { if (this.logged.size <= 256) break; this.logged.delete(key); }
  }

  /** Wakes every waiter: the view, the run or the pending messages changed. */
  private notify(): void { for (const waiter of [...this.waiters]) waiter(); }
  /** Resolves once `ready()` holds; rejects when the chat closes. */
  private waitFor(ready: () => boolean | Promise<boolean>): Promise<void> {
    return new Promise((resolve, reject) => {
      let checking = false, again = false;
      const done = (error?: unknown) => { this.waiters.delete(check); if (error) reject(error); else resolve(); };
      const check = async () => {
        if (checking) { again = true; return; }
        checking = true;
        try {
          do {
            again = false;
            if (this.closing) return done(new Error("optchat is closing"));
            if (await ready()) return done();
          } while (again);
        } catch (error) { done(error); }
        finally { checking = false; }
      };
      this.waiters.add(check);
      void check();
    });
  }

  private async start(): Promise<void> {
    const directory = this.options.directory;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.media = new MediaStore(path.join(directory, "media"));
    this.storage = await openStorage(path.join(directory, "pi.sqlite"));
    const registry = createRegistry();
    registry.install(this.extension());
    this.harness = await Harness.open(this.storage, { models: cachedModels(boundedOutput(this.options.models, CHAT_OUTPUT_TOKENS, model => this.countCapped("chat", model)), () => this.cacheKey), registry, onReport: piReports(log), settings: {
      // The spec's caching: short entries only, never 1-hour ones. (Every
      // answer is capped, O1: boundedOutput above.)
      stream: { cacheRetention: "short" },
      toolExecution: "sequential",
      // Every message steered into a tool round is placed at its boundary,
      // none left over to continue the run after its final answer.
      steeringMode: "all",
      // Every turn is a fresh context; nothing grows to compact.
      compaction: { enabled: false },
      // A task cut off at every open runs again, as before Pi 1.4 (pi-sends.ts).
      restartLimit: RESTART_LIMIT,
    } }, context);
    void this.harness.closed.then(end => this.ended(end), () => {});
    // Before anything is scheduled: a chat request that was out at the last
    // stop is counted and its turn ends unanswered; it is never sent again
    // on its own (pi-sends.ts). The next message is the user's to send.
    const { epoch, dropped } = await settleSends(this.harness, context);
    this.epoch = epoch;
    if (dropped.length) {
      log.warn("a chat request was out when cubed stopped: not sent again, its cost is unknown, its turn ends unanswered", { models: dropped.map(send => send.model) });
      this.requestError = "the chat's last request was out when cubed stopped, so it was not sent again (what it cost is unknown): send a message to go on";
    }
    this.tree = await this.harness.commit(async tx => {
      const settings = await tx.doc(SettingsDoc);
      if (!settings.tree) settings.tree = (await tx.createConversation({ ownership: { kind: "ownerless" } })).id;
      settings.cache ||= randomUUID();
      return settings.tree as ConversationId;
    }, context);
    const settings = await this.harness.snapshot(SettingsDoc, context);
    this.cacheKey = `optchat-${settings!.cache}`;
    // The compactor's task is its own: its request end is not cached.
    this.compactorModels = cachedModels(boundedOutput(this.options.models, undefined, model => this.countCapped("compactor", model)), () => `${this.cacheKey}-compact`, { task: false });
    const existing = await this.harness.conversation(ROOT_CONVERSATION_ID, context);
    if (existing) this.conversation = existing;
    else {
      const model = await this.options.model();
      if (!model) throw new Error("connect a model provider first");
      this.conversation = await this.harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
    }
    const agent = (await this.conversation.agent(context)).model;
    this.model = agent ? { provider: agent.provider, id: agent.modelId } : null;
    this.memory.onChange = () => this.notify();
    // The nodes first, then the stored view over the part of the log it
    // covered, then the messages after it. A view that does not fit is
    // folded again from the log.
    const nodes: Array<{ l: number; i: number }> = [];
    for (const entry of await this.scan(this.tree, 0)) {
      const node = entry.data as { l: number; i: number; text: string } | undefined;
      if (entry.kind === NODE_ENTRY && node) { this.memory.setNode(node.l, node.i, node.text); nodes.push(node); }
    }
    const entries = await this.scan(this.conversation.id, 0);
    const read = await this.harness.snapshot(LogDoc, context);
    if (read?.pagedFrom !== undefined) this.pagedFrom = read.pagedFrom;
    else {
      // A new chat pages every message; one logged before pages pages
      // only what comes after this open.
      this.pagedFrom = existing ? (entries.at(-1)?.id ?? 0) + 1 : 0;
      await this.harness.commit(async tx => { (await tx.doc(LogDoc)).pagedFrom = this.pagedFrom; }, context);
    }
    const stored = await this.harness.snapshot(ViewDoc, context);
    const messages: LogMessage[] = [];
    let checked = { total: 0, shape: "" };
    for (const entry of entries) {
      const logged = this.messagesOf(entry);
      messages.push(...logged);
      this.shape = nextShape(this.shape, entry.id, logged.length);
      for (const id of entryImages(entry)) this.referenced.add(id);
      this.lastEntry = entry.id;
      if (stored?.entry !== undefined && entry.id <= stored.entry) checked = { total: messages.length, shape: this.shape };
    }
    // The tree's nodes are by message id: a log that numbers its messages
    // otherwise than when the view was stored (a change to how entries are
    // read) would put every summary on the wrong messages. Views stored
    // before the shape are not checked.
    const mismatch = stored?.shape !== undefined
      ? viewMismatch({ ...stored, shape: stored.shape }, checked, () => entries.some(entry => entry.id >= this.pagedFrom && this.messagesOf(entry).length !== entryMessages(entry).length)) : null;
    if (mismatch) throw new Error(mismatch);
    const total = stored && stored.total <= messages.length && this.memory.restore(messages.slice(0, stored.total), toParts(stored.parts), stored.batch === true,
      stored.compaction ? { parts: toParts(stored.compaction), batching: stored.compactionBatch === true } : undefined) ? stored.total : 0;
    for (const message of messages.slice(total)) this.memory.append(message);
    // The compactor is counted from the first open that knows how. A tree
    // that already holds a node the compactor built (not one whose text fit
    // as it was) had calls nobody counted.
    const compacted = () => nodes.some(({ l, i }) => {
      // A node whose sources are gone cannot be judged: counted as compacted.
      if (l === 0 ? i >= this.memory.length : !this.memory.built(l - 1, 2 * i) || !this.memory.built(l - 1, 2 * i + 1)) return true;
      try { return !("free" in this.memory.source(l, i)); } catch { return true; }
    });
    if ((await this.harness.snapshot(CompactorUsageDoc, context))?.since == null) await this.harness.commit(async tx => {
      const usage = await tx.doc(CompactorUsageDoc);
      if (usage.since !== null) return;
      usage.since = Date.now();
      if (compacted()) usage.earlier = true;
    }, context);
    const watch = await this.conversation.watch(context);
    // Delivery runs again on every change too: a steered message is
    // forgotten once Pi has placed it, which happens after the steer.
    watch.start(async () => { void this.sync(); this.notify(); void this.drain(); });
    this.stopWatch = async () => { await watch.stop(); };
    // Answers left are kept across restarts: a restart is no new budget. An
    // answer that was out at the last stop is counted (its cost unknown) and
    // not asked again on its own: its node is held, as a node with its
    // answers spent, until a message of the user or another compactor model.
    const interrupted = await this.harness.commit(async tx => {
      const doc = await tx.doc(SpendDoc);
      const cut = await tx.doc(CutDoc);
      const out: string[] = [];
      for (const [key, spend] of Object.entries(doc.nodes)) {
        if (!spend.out) continue;
        out.push(key);
        cut.compactor[spend.model] = (Object.hasOwn(cut.compactor, spend.model) ? cut.compactor[spend.model]! : 0) + 1;
        doc.nodes[key] = { left: 0, model: spend.model, ...spend.round ? { round: spend.round } : {}, interrupted: true };
      }
      return Object.entries(doc.nodes).filter(([, spend]) => spend.interrupted).map(([key]) => key);
    }, context);
    for (const key of interrupted) this.why.set(key, "its summary was out when cubed stopped (what it cost is unknown), so it was not asked again");
    if (interrupted.length) log.warn("compactor answers were out when cubed stopped: not asked again, their cost is unknown; held until a message of the user", { nodes: interrupted });
    for (const [key, spend] of Object.entries((await this.harness.snapshot(SpendDoc, context))?.nodes ?? {})) {
      const [l, i] = key.split(":").map(Number);
      if (!this.memory.built(l!, i!)) this.spend.set(key, { ...spend });
    }
    this.harness.resume();
    this.pump();
    void this.drain();
    // Start failures are told as they change; what changed before this
    // chat listened is read once.
    this.unsubscribeStart = this.options.threads.onStartFailure((id, failure) => this.startFailureChanged(id, failure));
    // Run feeds too: listening first, then attaching each thread once (its
    // open feed's current state, or its stored last run) catches up on what
    // settled before; an attach twice is one.
    this.unsubscribeFeed = this.options.threads.onRunFeed(fact => this.runFeedChanged(fact));
    for (const id of Object.keys((await this.harness.snapshot(SettingsDoc, context))?.threads ?? {})) this.mine.add(id);
    for (const id of this.mine) this.startFailureChanged(id, this.options.threads.startFailure(id));
    for (const id of this.mine) this.attach(id);
    await this.watchThreads();
    this.watchTimer = setInterval(() => { void this.watchThreads(); }, this.options.limits?.watchMs ?? 15_000);
    this.watchTimer.unref();
    await this.sweepMedia(Date.now() - UNSENT_MS);
    const sweep = setInterval(() => { void this.sweepMedia(Date.now() - UNSENT_MS); }, 60 * 60_000);
    sweep.unref();
    this.timers.add(sweep);
  }

  /** Runs `action` alone among the steps that add or delete images. */
  private withMedia<T>(action: () => Promise<T>): Promise<T> {
    const run = this.mediaLock.catch(() => {}).then(action);
    this.mediaLock = run;
    return run;
  }

  /** Every image a message holds: in the log, or waiting for a turn. */
  private async mediaInUse(): Promise<Set<string>> {
    // Pending first: a message Pi places meanwhile is in the log by the sync.
    const pending = await this.pending();
    await this.sync();
    const used = new Set(this.referenced);
    for (const item of pending) for (const image of item.images ?? []) used.add(image.id);
    return used;
  }

  /** Deletes uploads no message holds that were stored before `before`. */
  private sweepMedia(before: number): Promise<number> {
    return this.withMedia(async () => {
      if (this.closing) return 0;
      const removed = this.media.sweep(await this.mediaInUse(), before);
      if (removed) log.info("unsent images deleted", { removed });
      return removed;
    }).catch(error => { if (!this.closing) log.warn("images not swept", { error }); return 0; });
  }

  /** Whether the chat's model takes images, and if not, why. */
  imageSupport(): { supported: boolean; reason: string | null } {
    const model = this.model && this.options.models.getModel(this.model.provider, this.model.id);
    if (!model) return { supported: false, reason: "the chat's model is unavailable" };
    if (!model.input.includes("image")) return { supported: false, reason: `${model.id} does not take images` };
    return { supported: true, reason: null };
  }

  /** Stores an uploaded image for a message still to be sent. Uploads no
   * message holds are bounded: the oldest are let go first, never one
   * younger than ten minutes, which a draft may be about to send. */
  upload(bytes: Uint8Array): Promise<ReturnType<MediaStore["put"]>> {
    return this.withMedia(async () => {
      const support = this.imageSupport();
      if (!support.supported) throw new MediaError(support.reason!, 422);
      checkImage(bytes);
      const used = await this.mediaInUse();
      const unsent = this.media.list().filter(item => !used.has(item.id));
      if (unsent.length >= MEDIA_LIMITS.unsent) {
        // Keeps every image in use and the newest unsent ones but one.
        const newest = unsent.slice(unsent.length - MEDIA_LIMITS.unsent + 1).map(item => item.id);
        this.media.sweep(new Set([...used, ...newest]), Date.now() - 10 * 60_000);
        if (this.media.list().filter(item => !used.has(item.id)).length >= MEDIA_LIMITS.unsent) {
          throw new MediaError(`${MEDIA_LIMITS.unsent} images are uploaded and not sent; send or remove some, then try again in a few minutes`, 429);
        }
      }
      return this.media.put(bytes);
    });
  }

  /** An image a message of this chat holds, for the transcript; null for any other id. */
  async image(id: string): Promise<{ bytes: Buffer; mimeType: string } | null> {
    const held = async () => this.referenced.has(id) || (await this.pending()).some(item => item.images?.some(image => image.id === id));
    // A message Pi has just placed may not be in the log yet.
    if (!await held()) { await this.sync(); if (!this.referenced.has(id)) return null; }
    return this.media.get(id);
  }

  /** Every entry of a conversation after `after`, oldest first. */
  private async scan(conversationId: ConversationId, after: number): Promise<EntryRecord[]> {
    const items: EntryRecord[] = [];
    let cursor: Cursor | undefined;
    do {
      const page: Page<EntryRecord, Cursor> = await this.harness.commit(tx => tx.scanEntries({ conversationId, minEntryId: (after + 1) as EntryId }, 256, cursor), context);
      items.push(...page.items);
      cursor = page.next;
    } while (cursor);
    return items.filter(entry => entry.id > after).sort((a, b) => a.id - b.id);
  }

  /** Appends the root conversation's new entries to the log. */
  private sync(): Promise<void> {
    if (this.syncing) { this.dirty = true; return this.syncing; }
    this.syncing = (async () => {
      do {
        this.dirty = false;
        for (const entry of await this.scan(this.conversation.id, this.lastEntry)) {
          const logged = this.messagesOf(entry);
          for (const message of logged) this.memory.append(message);
          this.shape = nextShape(this.shape, entry.id, logged.length);
          for (const id of entryImages(entry)) this.referenced.add(id);
          this.lastEntry = entry.id;
        }
      } while (this.dirty && !this.closing);
    })().catch(error => { if (!this.closing) log.warn("log sync failed", { error }); })
      .finally(() => { this.syncing = null; this.pump(); });
    return this.syncing;
  }

  /** One entry's log messages, in pages if it is logged since pages. */
  private messagesOf(entry: EntryRecord): LogMessage[] {
    return entryMessages(entry, entry.id >= this.pagedFrom ? this.options.limits?.page ?? CAP : 0);
  }

  /** Starts every node that may be built now, up to JOBS at once. */
  private pump(): void {
    if (this.closing || !this.conversation) return;
    for (const job of this.memory.ready(this.busy, this.options.limits?.jobs ?? JOBS)) {
      const key = `${job.l}:${job.i}`;
      const { asks, changes } = this;
      this.busy.add(key);
      const built = this.build(job.l, job.i);
      const settled: Promise<void> = built.then(() => {}, () => {}).finally(() => { if (this.building.get(key) === settled) this.building.delete(key); });
      this.building.set(key, settled);
      built.then(() => {
        this.busy.delete(key);
        this.failed.delete(key);
        this.spend.delete(key);
        this.why.delete(key);
        if (!this.failed.size) this.compactorError = null;
        this.pump();
      }, error => {
        if (this.closing) return;
        const message = error instanceof Error ? error.message : String(error);
        if (!this.failed.has(key)) log.warn("compactor failed", { node: key, error: message });
        this.failed.add(key);
        if (!(error instanceof Spent)) this.why.set(key, message);
        // Its answers spent, whatever ended the round: held (busy, no timer,
        // no call) until a message of the user or another compactor model
        // releases it. Never cut: the source is not lost.
        const spend = this.spend.get(key);
        if (spend && spend.left <= 0) {
          // A step that came while its last answer was out is not lost: a
          // message gives the round release() gave the held, another model
          // is looked at as compactorChanged() looks at the held (the same
          // model is held again, no call). Once per step, never a loop.
          if (changes !== this.changes || asks !== this.asks) {
            if (asks !== this.asks) { spend.left = TRIES; void this.saveSpend([key]); }
            this.compactorError = message;
            this.busy.delete(key);
            this.pump();
            return;
          }
          const why = this.why.get(key) ?? message;
          this.held.set(key, why);
          this.compactorError = `no summary for a message yet (${why}); change the compactor model or send a message to try again`;
          return;
        }
        this.compactorError = message;
        // An outage or a setup error: retried soon until it answers; the
        // next turn waits for this node and the chat shows why.
        const timer = setTimeout(() => { this.timers.delete(timer); this.busy.delete(key); this.pump(); }, this.options.limits?.retryMs ?? RETRY_MS);
        this.timers.add(timer);
      });
    }
  }

  private async build(l: number, i: number): Promise<void> {
    const source = this.memory.source(l, i);
    let text: string;
    let cut: string | undefined;
    if ("free" in source) text = source.free;
    else {
      const model = await this.compactorModel();
      if (!model) throw new Error("the chat has no model");
      const key = `${l}:${i}`, name = `${model.provider}/${model.id}`;
      const spend = this.spend.get(key);
      if (spend && spend.left <= 0) {
        // Held under this model: no call. Another model gets a new round.
        if (spend.model === name) throw new Spent("the compactor's answers for this message are spent");
        spend.left = TRIES;
        spend.model = name;
        await this.saveSpend([key]);
      }
      // A round a close held goes on where it stopped, under its model; taken once.
      const held = this.spend.get(key);
      const round = held?.round && held.model === name ? held.round as unknown as Round : undefined;
      if (held?.round) { delete held.round; await this.saveSpend([key]); }
      try {
        text = await compactNode({ models: this.compactorModels, model, context: this.memory.context(l, i), source, node: this.memory.nodeLimit, signal: this.abort.signal,
          answers: this.spend.get(key)?.left ?? ANSWERS, onRequest: () => this.reserve(key, name),
          onReply: reply => { this.calling.delete(key); return this.countCompactor(reply, key, name); }, onCut: why => { cut = why; },
          ...round ? { round } : {}, hold: next => this.holdRound(key, name, next) });
      } finally { this.calling.delete(key); }
    }
    // A node that came back while the chat closes is stored all the same: a
    // close waits for it, and the reopened chat would pay for it again.
    if (cut !== undefined) log.warn("compactor gave no line: node cut short", { node: `${l}:${i}`, error: cut });
    // Stored first: memory never holds a node storage lacks, and its answers
    // left go with it. The view it leads to is a cache for the next open,
    // written after.
    await this.harness.commit(async tx => {
      await tx.appendEntry(this.tree, { kind: NODE_ENTRY, data: { l, i, text, ...cut !== undefined ? { cut } : {} } });
      delete (await tx.doc(SpendDoc)).nodes[`${l}:${i}`];
    }, context);
    this.memory.setNode(l, i, text);
    // The log's shape through the view's last message, checked at the next open.
    const view = { total: this.memory.length, parts: flatParts(this.memory.view), batch: this.memory.batching,
      compaction: flatParts(this.memory.compaction), compactionBatch: this.memory.compactionBatching, entry: this.lastEntry, shape: this.shape, shapeTotal: this.memory.length };
    await this.harness.commit(async tx => { Object.assign(await tx.doc(ViewDoc), view); }, context)
      .catch(error => { if (!this.closing) log.warn("view not stored", { error }); });
  }

  /** While the chat closes, a node's next answer is not asked: after its
   * first answer, its round so far is stored, so the reopened chat asks that
   * answer, once, as this round would have, and none twice. */
  private async holdRound(key: string, model: string, round: Round): Promise<boolean> {
    if (!this.closing) return false;
    if (round.answers <= 1) return true;
    const spend = this.spend.get(key) ?? { left: ANSWERS, model };
    spend.model = model;
    spend.round = JSON.parse(JSON.stringify(round)) as JsonRepresentation<Round>;
    this.spend.set(key, spend);
    await this.harness.commit(async tx => { (await tx.doc(SpendDoc)).nodes[key] = { ...spend }; }, context)
      .catch(error => { log.warn("held summary round not stored: the reopened chat starts it again", { node: key, error }); });
    return true;
  }

  /** Stores the answers left of `nodes` as memory has them. Best effort:
   * memory decides within this open. */
  private async saveSpend(nodes: readonly string[]): Promise<void> {
    await this.harness.commit(async tx => {
      const doc = await tx.doc(SpendDoc);
      for (const node of nodes) {
        const spend = this.spend.get(node);
        // A node key is `l:i`, never `__proto__`.
        if (spend) doc.nodes[node] = { ...spend };
        else delete doc.nodes[node];
      }
    }, context).catch(error => { if (!this.closing) log.warn("compactor answers not stored", { error }); });
  }

  /** A message of the user: every node with its answers spent gets one
   * more round of TRIES. A held one is asked again now; one still being
   * looked at goes to the retry its failure takes with answers left, and
   * one whose last answer is still out gets its round when it fails. */
  private release(): void {
    if (this.closing) return;
    this.asks++;
    const nodes = [...this.spend].filter(([, spend]) => spend.left <= 0).map(([node]) => node);
    if (!nodes.length) return;
    for (const node of nodes) {
      this.spend.get(node)!.left = TRIES;
      if (!this.held.delete(node)) continue;
      this.busy.delete(node);
      this.failed.delete(node);
    }
    if (!this.failed.size) this.compactorError = null;
    void this.saveSpend(nodes);
    this.pump();
  }

  /** The compactor's model may have changed (saved in settings, or the
   * chat's own it follows): every held node is looked at again. One held
   * under another model gets a new round of TRIES answers; the rest are
   * held again without a call. */
  compactorChanged(): void {
    this.changes++;
    if (this.closing || !this.held.size) return;
    for (const node of this.held.keys()) this.busy.delete(node);
    this.held.clear();
    this.pump();
  }

  /** Before a compactor answer is sent: one answer is taken from the
   * node's, and marked out, in one commit. A failed commit sends nothing (it
   * throws, ending the round). An answer marked out before whose reply was
   * never stored is counted now, its cost unknown. */
  private async reserve(node: string, model: string): Promise<void> {
    const spend = this.spend.get(node) ?? { left: ANSWERS, model };
    const next: Spend = { ...spend, model, left: spend.left - 1, out: { at: Date.now() } };
    delete next.interrupted;
    await this.harness.commit(async tx => {
      const doc = await tx.doc(SpendDoc);
      const prior = doc.nodes[node];
      if (prior?.out) {
        const cut = await tx.doc(CutDoc);
        cut.compactor[prior.model] = (Object.hasOwn(cut.compactor, prior.model) ? cut.compactor[prior.model]! : 0) + 1;
      }
      doc.nodes[node] = { ...next };
    }, context);
    this.spend.set(node, next);
    this.calling.set(node, model);
  }

  /** Adds one compactor reply's usage and clears its node's answer out, in
   * one commit; a reply that spent no output gives its answer back. A
   * failed commit throws: the node is not built on a reply whose usage is
   * not stored, and the answer stays marked out, so it is counted (its cost
   * unknown) by the next reserve or open. A reply that comes after a close
   * cut it off adds its usage only (the cut counted it). */
  private async countCompactor(reply: AssistantMessage, node: string, model: string): Promise<void> {
    const key = `${reply.provider}/${reply.model}`;
    const cut = this.cutOff.has(node);
    const spend = this.spend.get(node) ?? { left: ANSWERS, model };
    const next: Spend = { ...spend, model, left: spend.left + (spent(reply) ? 0 : 1) };
    delete next.out;
    await this.harness.commit(async tx => {
      if (!cut) (await tx.doc(SpendDoc)).nodes[node] = { ...next };
      const usage = await tx.doc(CompactorUsageDoc);
      const total = Object.hasOwn(usage.models, key) ? usage.models[key] : undefined;
      // A key holds a slash, so it is never `__proto__`.
      if (total) addUsage(total as unknown as Usage, reply.usage);
      else usage.models[key] = JSON.parse(JSON.stringify(reply.usage)) as JsonRepresentation<Usage>;
      usage.calls[key] = (Object.hasOwn(usage.calls, key) ? usage.calls[key]! : 0) + 1;
    }, context).catch(error => {
      log.warn("compactor reply not stored: its node is not built on it, and its cost counts as unknown", { node, error: errorText(error) });
      throw error;
    });
    if (!cut) this.spend.set(node, next);
  }

  /** A call the output guard stopped: its cost is unknown, counted as such. */
  private countCapped(kind: "chat" | "compactor", model: string): void {
    log.warn("a model call was stopped at its output cap by cube: its provider reported no usage, so its cost is unknown", { kind, model });
    void this.harness.commit(async tx => {
      const doc = await tx.doc(CutDoc);
      doc.capped ??= { chat: {}, compactor: {} };
      // A key holds a slash, so it is never `__proto__`.
      const counts = doc.capped[kind];
      counts[model] = (Object.hasOwn(counts, model) ? counts[model]! : 0) + 1;
    }, context).catch(error => { log.warn("a capped call was not counted", { error: errorText(error) }); });
  }

  /** The chat's own usage (its Pi store and its compactor) and the threads it started. */
  async usage(): Promise<OptChatUsage> {
    const compactor = await this.harness.snapshot(CompactorUsageDoc, context);
    const threads = Object.keys((await this.harness.snapshot(SettingsDoc, context))?.threads ?? {});
    const cut = await this.harness.snapshot(CutDoc, context);
    // Chat requests out at a stop (pi-sends.ts) count with those a close cut before them.
    const interrupted = (await this.harness.snapshot(SendsDoc, context))?.interrupted ?? {};
    const chat: Record<string, number> = { ...cut?.chat };
    for (const [key, n] of Object.entries(interrupted)) chat[key] = (Object.hasOwn(chat, key) ? chat[key]! : 0) + n;
    return { chat: await this.harness.usage(context) as OptChatUsage["chat"],
      compactor: compactor ? JSON.parse(JSON.stringify(compactor)) as OptChatUsage["compactor"] : { models: {}, calls: {}, since: null, earlier: false }, threads,
      cut: { chat, compactor: { ...cut?.compactor }, tools: { ...cut?.tools }, capped: { chat: { ...cut?.capped?.chat }, compactor: { ...cut?.capped?.compactor } } } };
  }

  /** Accepts a user message or a thread report and keeps it until it is in
   * the chat. The same request id is accepted once. */
  async send(text: string, requestId: string, images: readonly string[] = []): Promise<void> {
    if (!images.length) return this.accept(text, requestId, []);
    // Checked and accepted under the media lock: no sweep deletes an image
    // between its check and the message that holds it.
    await this.withMedia(async () => {
      const unique = [...new Set(images)];
      if (unique.length > MEDIA_LIMITS.perMessage) throw new MediaError(`at most ${MEDIA_LIMITS.perMessage} images a message`);
      const refs = unique.map(id => {
        const image = this.media.get(id);
        if (!image) throw new MediaError("an attached image is not on the host any more; attach it again", 404);
        return { id, mimeType: image.mimeType };
      });
      await this.accept(text, requestId, refs);
    });
  }

  private async accept(text: string, requestId: string, images: MediaRef[]): Promise<void> {
    const conversation = this.conversation;
    const fresh = await this.harness.commit(async tx => {
      const pending = await tx.doc(PendingDoc);
      const same = (item: PendingItem) => item.requestId === requestId;
      if (pending.items.some(same) || pending.batch?.some(same) || pending.sent.some(same)) return false;
      if (await tx.submissionByRequest(conversation.id, requestId) || await tx.submissionByRequest(conversation.id, `${requestId}:unanswered`)) return false;
      if (images.length) {
        // Refused, not dropped: the model would never see them.
        const support = this.imageSupport();
        if (!support.supported) throw new MediaError(`not sent: ${support.reason}; choose a model that takes images, or send without them`, 422);
        const waiting = [...pending.sent, ...pending.batch ?? [], ...pending.items].reduce((sum, item) => sum + (item.images?.length ?? 0), 0);
        if (waiting + images.length > MEDIA_LIMITS.waiting) throw new MediaError(`not sent: ${waiting} images are already waiting for the chat; at most ${MEDIA_LIMITS.waiting} wait at once`, 429);
      }
      pending.items.push({ text, requestId, after: this.lastEntry, ...images.length ? { images } : {} });
      // A message of the user (not a report) renews every thread's tells.
      if (!requestId.startsWith("report:")) for (const thread of Object.values((await tx.doc(SettingsDoc)).threads)) delete thread.tells;
      return true;
    }, context);
    // A new message of the user, never a thread's report: one more round
    // for each held node, each paid for by the user's own step.
    if (fresh && !isReport(requestId)) this.release();
    this.notify();
    this.pendingChanged();
    void this.drain();
  }

  /** Whether this chat started the thread `id`. */
  async started(id: string): Promise<boolean> {
    return Object.hasOwn((await this.harness.snapshot(SettingsDoc, context))?.threads ?? {}, id);
  }

  /** The short ids of the threads this chat started. */
  async threadPrefixes(): Promise<Set<string>> {
    return new Set(Object.keys((await this.harness.snapshot(SettingsDoc, context))?.threads ?? {}).map(short));
  }

  /** Messages accepted but not yet shown in the chat, oldest first. */
  async pending(): Promise<PendingItem[]> {
    const pending = await this.harness.snapshot(PendingDoc, context);
    return pending ? [...pending.sent, ...(pending.batch ?? []), ...pending.items] : [];
  }

  private async live() { return this.harness.snapshot(LiveDoc, this.conversation.id, context); }

  /** Records the admitted input `requestId` as carrying a message of the
   * user; it counts for project_hooks_write once placed in a run. The
   * record follows the admission in its own commit (Pi admits on its own),
   * so a tool that runs in between refuses: never the reverse. */
  private async markUser(requestId: string): Promise<void> {
    const input = await this.known(requestId);
    if (input?.type !== "input") return;
    await this.conversation.commit(async tx => {
      const turn = await tx.doc(TurnDoc, this.conversation.id);
      turn.userInputs = [...(turn.userInputs ?? []).filter(id => id !== Number(input.id)), Number(input.id)].slice(-32);
    }, context);
  }

  /** Runs `action` alone among the steps that move pending messages
   * (steering, a turn's submission, stop). */
  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    const run = this.lock.catch(() => {}).then(action);
    this.lock = run;
    return run;
  }

  /** Delivers pending messages. During a tool round they are steered in and
   * reach the model between tool calls. During a generation they wait for
   * the run to end, so a turn never continues into the next one. Idle: once
   * every line of the view is a summary, all of them start one fresh turn. */
  private drain(): Promise<void> {
    if (this.draining) { this.again = true; return this.draining; }
    this.draining = (async () => {
      do {
        this.again = false;
        for (;;) {
          if (this.closing) return;
          const pending = await this.harness.snapshot(PendingDoc, context);
          if (pending?.sent.length) await this.exclusive(() => this.pruneSent());
          if (pending?.batch) {
            const head = await this.known(`${pending.batch[0]!.requestId}:turn`);
            if (!head) await this.waitFor(() => this.memory.settled());
            await this.exclusive(() => this.submitBatch());
            continue;
          }
          if (!pending?.items.length) break;
          const toolRound = (live: LiveState | undefined) => !!live?.tools?.some(slot => slot.status !== "done");
          const live = await this.live();
          if (live?.run) {
            if (toolRound(live)) {
              // What waits for the next turn waits for this run's end.
              if (await this.exclusive(() => this.steer())) await this.waitFor(async () => !(await this.live())?.run);
              continue;
            }
            await this.waitFor(async () => { const now = await this.live(); return !now?.run || toolRound(now); });
            continue;
          }
          await this.sync();
          await this.waitFor(() => this.memory.settled());
          if ((await this.live())?.run) continue;
          // Everything waiting goes into this turn, as the spec's take_all.
          await this.exclusive(() => this.harness.commit(async tx => {
            const doc = await tx.doc(PendingDoc);
            if (doc.batch || !doc.items.length) return;
            doc.batch = doc.items.map(item => ({ ...item }));
            doc.items = [];
          }, context));
          this.pendingChanged();
        }
      } while (this.again && !this.closing);
    })().catch(error => {
      if (this.closing) return;
      log.warn("delivery failed", { error });
      const timer = setTimeout(() => { this.timers.delete(timer); void this.drain(); }, this.options.limits?.retryMs ?? RETRY_MS);
      this.timers.add(timer);
    }).finally(() => {
      this.draining = null;
      if (this.again && !this.closing) void this.drain();
    });
    return this.draining;
  }

  private async known(requestId: string) {
    return this.conversation.commit(tx => tx.submissionByRequest(this.conversation.id, requestId), context);
  }

  /** Every waiting message, steered into the running tool round. Pi places
   * them all at the round's boundary (steeringMode "all"). One whose images
   * would take the turn past its bounds waits for the next turn, and every
   * message after it with it: the turn's next request then carries every
   * image its last one did, so their prefix stays the same, and the model
   * sees the new images one turn later. Returns whether any waits. */
  private async steer(): Promise<boolean> {
    const items = (await this.harness.snapshot(PendingDoc, context))?.items ?? [];
    for (const item of items) {
      if (item.images?.length) {
        const turn = await this.harness.snapshot(TurnDoc, this.conversation.id, context);
        // A turn started before its images were recorded: the next turn.
        if (!turn?.images) return true;
        const ids = item.images.map(image => image.id);
        const carried = Object.entries(turn.images).flatMap(([requestId, images]) => requestId === item.requestId ? [] : images);
        if (!turnFits([...carried, ...ids], id => this.media.get(id)?.bytes.byteLength ?? 0)) return true;
        // Recorded first: after a crash in between it is only counted.
        await this.conversation.commit(async tx => {
          const doc = await tx.doc(TurnDoc, this.conversation.id);
          doc.images = { ...doc.images, [item.requestId]: ids };
        }, context);
      }
      await this.conversation.submit({ type: "input", content: userContent(item), requestId: item.requestId, whenBusy: "steer" }, context);
      if (!isReport(item.requestId)) await this.markUser(item.requestId);
      await this.harness.commit(async tx => {
        const doc = await tx.doc(PendingDoc);
        doc.items = doc.items.filter(other => other.requestId !== item.requestId);
        doc.sent.push({ ...item });
      }, context);
      this.pendingChanged();
    }
    return false;
  }

  /** Forgets sent messages once Pi has placed them, or a stop withdrew them. */
  private async pruneSent(): Promise<void> {
    const sent = (await this.harness.snapshot(PendingDoc, context))?.sent ?? [];
    const settled: string[] = [];
    for (const item of sent) if ((await this.known(item.requestId))?.status !== "queued") settled.push(item.requestId);
    if (!settled.length) return;
    await this.remember(settled);
    await this.harness.commit(async tx => {
      const doc = await tx.doc(PendingDoc);
      doc.sent = doc.sent.filter(item => !settled.includes(item.requestId));
    }, context);
    this.pendingChanged();
  }

  /** One fresh turn: its view parts and a head entry, every message but the
   * last as a user entry, then the last as the input that starts the run.
   * Each is its own Pi submission, so after a restart it goes on where it
   * stopped and every request id stays known. */
  private async submitBatch(): Promise<void> {
    const conversation = this.conversation;
    const batch = (await this.harness.snapshot(PendingDoc, context))?.batch;
    if (!batch?.length) return;
    const last = batch.at(-1)!;
    if (!await this.known(last.requestId)) {
      if (!await this.known(`${batch[0]!.requestId}:turn`)) {
        const parts = flatParts(this.memory.view);
        const images = Object.fromEntries(batch.flatMap(item => item.images?.length ? [[item.requestId, item.images.map(image => image.id)]] : []));
        await conversation.commit(async tx => { Object.assign(await tx.doc(TurnDoc, conversation.id), { started: true, parts, images }); }, context);
        await conversation.submit({ type: "write", entry: { kind: TURN, head: "self" }, requestId: `${batch[0]!.requestId}:turn` }, context);
      }
      for (const item of batch.slice(0, -1)) {
        if (!await this.known(item.requestId)) await conversation.submit({ type: "write", requestId: item.requestId, entry: userEntry(item) }, context);
      }
      await conversation.submit({ type: "input", content: userContent(last), requestId: last.requestId, whenBusy: "steer" }, context);
    }
    // The turn is the user's when the user wrote in it: its last message, or
    // one written into it here (not one an earlier run already took).
    let user = !isReport(last.requestId);
    for (const item of batch.slice(0, -1)) if (!user && !isReport(item.requestId) && (await this.known(item.requestId))?.type === "write") user = true;
    if (user) await this.markUser(last.requestId);
    // The batch's other messages leave the pending ones with this commit; the last is sent.
    await this.remember(batch.slice(0, -1).map(item => item.requestId));
    await this.harness.commit(async tx => {
      const doc = await tx.doc(PendingDoc);
      if (doc.batch?.at(-1)?.requestId !== last.requestId) return;
      doc.sent.push({ ...last });
      doc.batch = null;
    }, context);
    this.pendingChanged();
  }

  /** Stops the running turn. Messages still waiting, and any the stop
   * withdrew before Pi placed them, stay in the log, unanswered, as the
   * spec's cancelled wait. */
  async stop(): Promise<void> {
    await this.exclusive(async () => {
      await this.conversation.abort(context);
      const pending = await this.harness.snapshot(PendingDoc, context);
      const withdrawn: PendingItem[] = [];
      for (const item of pending?.sent ?? []) {
        const submission = await this.known(item.requestId);
        if (submission?.status === "unanswered" && submission.entry === undefined) withdrawn.push(item);
      }
      for (const item of [...withdrawn, ...(pending?.batch ?? []), ...(pending?.items ?? [])]) {
        if (await this.known(item.requestId) && !withdrawn.includes(item)) continue;
        if (!await this.known(`${item.requestId}:unanswered`)) {
          await this.conversation.submit({ type: "write", requestId: `${item.requestId}:unanswered`, entry: userEntry(item) }, context);
        }
      }
      await this.remember([...pending?.sent ?? [], ...pending?.batch ?? [], ...pending?.items ?? []].map(item => item.requestId), true);
      await this.harness.commit(async tx => {
        const doc = await tx.doc(PendingDoc);
        doc.items = [];
        doc.batch = null;
        doc.sent = [];
      }, context);
    });
    this.notify();
    this.pendingChanged();
  }

  async selectModel(selection?: { provider: string; id: string }): Promise<{ provider: string; id: string } | null> {
    if (selection) {
      if (await this.harness.snapshot(LiveDoc, this.conversation.id, context).then(live => live?.run)) throw new Error("wait for the current run before changing model");
      const model = this.options.models.getModel(selection.provider, selection.id);
      if (!model) throw new Error("model unavailable");
      if (!model.input.includes("image") && (await this.pending()).some(item => item.images?.length)) throw new Error(`${model.id} does not take images, and a message with images is waiting for the chat`);
      await this.conversation.configure({ model: { provider: selection.provider, modelId: selection.id } }, context);
      this.model = selection;
      // The compactor follows the chat's model unless one is saved.
      this.compactorChanged();
    }
    return this.model;
  }

  /** The round (every watchMs): reports a start failure that lasted the
   * grace, sends again a report the chat could not take, and attaches again
   * a thread whose watch ended or failed. A thread's runs are not polled:
   * its feed opening and closing is told (`onRunFeed`). */
  private async watchThreads(): Promise<void> {
    if (this.closing) return;
    for (const id of [...this.unsent]) { this.unsent.delete(id); void this.reportStored(id); }
    for (const id of [...this.reattach]) { this.reattach.delete(id); this.attach(id); }
    for (const id of this.mine) this.reportStartFailure(id);
  }

  /** A thread's run feed opened (attach: watch it) or closed (its stored
   * last run is final: report it if no watch did). */
  private runFeedChanged(fact: RunFeed): void {
    if (this.closing || !this.mine.has(fact.thread)) return;
    if (fact.open) this.attach(fact.thread);
    else void this.reportStored(fact.thread);
  }

  /** Follows one thread: its open feed is watched (a settled run sends its
   * report once); without one its stored last run reports, once, and the
   * thread is attached again when its feed opens. */
  private attach(id: string): void {
    if (this.closing || this.watchers.has(id)) return;
    // Only this attach's entry is removed: an older watch that ends after a
    // newer attach leaves the newer one in place.
    const drop = () => { if (this.watchers.get(id) === watching) this.watchers.delete(id); };
    // Looked at again on the next round (every watchMs), never at once.
    const again = (why: string, error?: unknown) => {
      drop();
      if (this.closing) return;
      if (error !== undefined) log.warn(why, { thread: id, error: error instanceof Error ? error.message : String(error) });
      this.reattach.add(id);
    };
    const watching: Promise<ThreadWatch | null> = (async () => {
      let events: ThreadEvents | null | "archiving" | "stored";
      try { events = await this.options.threads.events(id); }
      catch (error) { again("watching a thread failed; the next round looks again", error); return null; }
      // An archive may still be refused: the next round looks again.
      if (events === "archiving") { again("archiving"); return null; }
      // Archived or gone: its feed's close was told, and read, when it closed.
      if (!events) { drop(); return null; }
      // A thread is not started or woken to be watched: its stored run, if
      // it settled, reports (once: the report's request id); its feed's
      // opening attaches it again.
      if (events === "stored") {
        drop();
        await this.reportStored(id);
        return null;
      }
      if (this.closing) { drop(); return null; }
      // A watch that ends (its feed closed, or failed) or cannot begin (its
      // feed could not be read) is attached again on the next round.
      let watch: ThreadWatch;
      try { watch = await events.watch(transcript => this.observe(id, transcript), { onEnd: () => again("ended") }); }
      catch (error) { again("a thread's watch could not begin; the next round looks again", error); return null; }
      void watch.closed.then(() => again("ended"), () => again("ended"));
      return watch;
    })();
    this.watchers.set(id, watching);
    // Nothing above rejects; should it, the thread is looked at again.
    void watching.catch(error => again("watching a thread failed; the next round looks again", error));
  }


  /** cubed told a thread's start failure (null: it ended, by a start, an
   * archive or the thread's end): a later failure's grace starts again. */
  private startFailureChanged(id: string, failure: StartFailure | null): void {
    if (!failure) { this.failing.delete(id); this.startFailing.delete(id); return; }
    this.failing.set(id, failure);
    if (!this.startFailing.has(id)) this.startFailing.set(id, Date.now());
  }

  /** cubed retries a machine that failed to start (a lost guest, a lease
   * not yet let go), and most come up on a later try: only a failure that
   * lasts is reported, once per episode of failed tries (once per thread
   * when cubed names none), saying whether cubed still retries. */
  private reportStartFailure(id: string): void {
    const failure = this.failing.get(id);
    const since = this.startFailing.get(id);
    if (!failure || since === undefined || this.closing) return;
    const lasted = Date.now() - since;
    const requestId = failure.episode ? `report:${id}:failure:${failure.episode}` : `report:${id}:start`;
    if (lasted < (this.options.limits?.startGraceMs ?? START_GRACE_MS) || this.startReported.has(requestId)) return;
    this.startReported.add(requestId);
    const what = failure.waking ? "its machine failed to wake" : "failed to start";
    // Not handed over: a later round says it again (once, by its request id).
    void this.send(`[${short(id)}] ${what} for ${Math.round(lasted / 1000)} s${failure.retrying ? "; cubed keeps retrying" : ""}: ${failure.failure}`, requestId)
      .catch(() => { this.startReported.delete(requestId); });
  }

  private observe(id: string, transcript: ThreadTranscript): void {
    this.settle(id, transcript.status, () => threadReport(transcript));
  }

  private settle(id: string, status: ThreadStatus, report: () => string): void {
    if (status.state === "idle" || status.state === "working" || !status.run || this.reported.get(id) === status.run) return;
    const run = status.run;
    this.reported.set(id, run);
    void this.send(`[${short(id)}] ${capText(report())}`, `report:${id}:${run}`).catch(error => {
      if (this.closing) return;
      // Not handed over: the next round reads the stored run and sends it again.
      log.warn("report delivery failed; it is tried again", { thread: id, error });
      if (this.reported.get(id) === run) this.reported.delete(id);
      this.unsent.add(id);
    });
  }

  /** After an archive, or for a thread whose agent is not open: the thread's
   * last settled run, as stored, reports to the chat if no watcher sent it
   * yet. A run still open (or none) reports nothing. The report's request id
   * keeps it to one delivery. */
  private async reportStored(id: string): Promise<void> {
    try {
      const page: HistoryPage | null | undefined = (await this.options.threads.history(id, { limit: 1 }))?.transcript;
      if (page) this.settle(id, page.status, () => runReport(page.status, page.answer && page.answer.index > page.asked ? page.answer.text : ""));
    } catch (error) { log.warn("stored report not checked", { thread: id, error }); }
  }

  /** The thread a short id names, among the ones this chat started. */
  private async resolve(id: string): Promise<string> {
    const threads = Object.keys((await this.harness.snapshot(SettingsDoc, context))?.threads ?? {});
    const prefix = id.replace(/^\[|\]$/g, "");
    if (!prefix) throw new Error("name a thread by its id");
    const matches = threads.filter(thread => thread.startsWith(prefix));
    if (matches.length !== 1) throw new Error(matches.length ? `${id} names more than one thread` : `no thread ${id}`);
    return matches[0]!;
  }

  /** The threads this chat started, newest first, as cubed records them now:
   * every open one and the newest archived ones (with how their last run
   * ended). Nothing is registered by hand: a spawn adds its thread. The
   * state is the thread's own; an archived thread is not a goal met. */
  async threadOverview(): Promise<ThreadOverview> {
    const spawned = Object.entries((await this.harness.snapshot(SettingsDoc, context))?.threads ?? {}).sort((a, b) => b[1].at - a[1].at);
    const ids = spawned.map(([id]) => id);
    const at = new Map(spawned.map(([id, thread]) => [id, thread.at]));
    const observe = this.options.threads.observe;
    if (!observe) return { threads: [], archived: { shown: 0, total: 0 }, unknown: ids.length };
    const first = await observe(ids);
    const archived = ids.filter(id => first.get(id)?.archived);
    const recent = archived.slice(0, ARCHIVED_SHOWN);
    const runs = new Map<string, ObservedThread>();
    // Only the newest archived threads' stores are read for their last run,
    // once: an archived thread runs no more.
    const unread = recent.filter(id => !this.archivedRuns.has(id));
    for (const [id, thread] of unread.length ? await observe(unread, { archivedRuns: true }) : []) {
      if (thread?.archived && thread.state !== "unknown") this.archivedRuns.set(id, thread);
      else if (thread) runs.set(id, thread);
    }
    for (const id of recent) { const thread = this.archivedRuns.get(id); if (thread) runs.set(id, thread); }
    const threads: OverviewThread[] = [];
    for (const id of ids) {
      const thread = runs.get(id) ?? first.get(id);
      if (!thread || (thread.archived && !runs.has(id))) continue;
      threads.push({ ...thread, spawned: at.get(id) ?? null });
    }
    return { threads, archived: { shown: recent.length, total: archived.length }, unknown: ids.filter(id => !first.get(id)).length };
  }

  /** The model the compactor calls now: its own, else the chat's. */
  private async compactorModel(): Promise<{ provider: string; id: string } | null> {
    return await this.options.compactor?.() ?? this.model;
  }

  private extension() {
    const zoom = defineTool({
      name: "zoom",
      description: "Open the line id+n of the view into the two lines of n/2 under it; n = 1 gives the message whole, one over 30,000 characters a page from character at.",
      parameters: Type.Object({ id: Type.Integer({ minimum: 0 }), n: Type.Integer({ minimum: 1 }), at: Type.Optional(Type.Integer({ minimum: 0 })) }),
      replay: "safe",
      execute: async args => text(this.memory.zoom(args.id, args.n, args.at ?? 0)),
    });
    const date = defineTool({
      name: "date",
      description: "The date and time of message id (the cube host's local time).",
      parameters: Type.Object({ id: Type.Integer({ minimum: 0 }) }),
      replay: "safe",
      execute: async args => {
        const message = this.memory.messages[args.id];
        return text(message ? new Date(message.date).toString() : `No message ${args.id}.`);
      },
    });
    const projects = defineTool({
      name: "projects",
      description: "The projects a thread can start in, the models it can run and how many thread machines are free.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => text(await this.options.threads.projects()),
    });
    const runners = defineTool({
      name: "runners",
      description: "The runners that host thread machines, as cubed last heard from them: version, platform, contact, machines and slots, "
        + "and what is unknown. Read-only. Report it as it says: a stale or missing report is unknown, not the runner's current state; "
        + "a published release does not mean a runner installed it; slots in use do not mean a runner hosts only that many.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => text(await this.options.threads.runners()),
    });
    const spawn = defineTool({
      name: "spawn",
      description: "Start one thread per task, in parallel, and answer their ids at once. Each thread is a coding agent with its own machine and a checkout of the project; it does not see this chat. Its report comes back later as a message starting \"[id] \".",
      parameters: Type.Object({ tasks: Type.Array(Type.Object({
        project: Type.String({ description: "Project name or id" }),
        task: Type.String({ description: "The whole task, self-contained" }),
        model: Type.Optional(Type.String({ description: "provider/model; default: the host's preferred model" })),
        runner: Type.Optional(Type.String({ description: "A runner's node id (see runners), only when the user asks for that runner. "
          + "The thread starts there and never moves; it waits while that runner is down. A HOST runner is unsandboxed and takes only threads named to it; "
          + "a protocol-3 runner (cube-runner) takes none. Absent: the pool places it on a berth vm, and refuses it when none has a free slot." })),
      }), { minItems: 1 }) }),
      // A request id per call and task: a rerun finds the same threads.
      replay: "safe",
      execute: async (args, api, callContext) => {
        const lines: string[] = [];
        const signal = callContext.abortSignal;
        for (const [index, task] of args.tasks.entries()) {
          // Aborted (a close or a stop): no further thread starts, and the
          // call ends aborted rather than reporting the rest "not started".
          signal?.throwIfAborted();
          try {
            const thread = await this.options.threads.spawn(task, `optchat:${api.callId}:${index}`, signal);
            await api.commit(async tx => { (await tx.doc(SettingsDoc)).threads[thread.id] ??= { at: Date.now() }; }, callContext);
            this.mine.add(thread.id);
            this.attach(thread.id);
            lines.push(`[${short(thread.id)}] started in ${task.project}: ${thread.title}`);
          } catch (error) {
            if (signal?.aborted) throw error;
            lines.push(`task ${index + 1} (${task.project}) not started: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return text(lines.join("\n"));
      },
    });
    const tell = defineTool({
      name: "tell",
      description: `Send a message to a thread you started: more work, an answer, a correction, or to go on when it stopped short. A thread still working reads it after its current tool call. At most ${TELLS} per thread between two messages of the user.`,
      parameters: Type.Object({ id: Type.String(), message: Type.String() }),
      replay: "safe",
      execute: async (args, api, callContext) => {
        const id = await this.resolve(args.id);
        // Only a tell the thread accepted counts, once per call: a replayed
        // call is not refused (the thread takes its request id once).
        // Checked before and counted after the tell: sound because the
        // chat's tools run one at a time (toolExecution "sequential").
        const tells = (await this.harness.snapshot(SettingsDoc, context))?.threads[id]?.tells ?? [];
        if (!tells.includes(api.callId) && tells.length >= TELLS) return text(`not sent: [${short(id)}] had ${TELLS} tells from you since the user's last message; tell the user what it needs instead`);
        // A working thread queues it into its running turn (steering).
        const accepted = await this.options.threads.tell(id, args.message, `optchat:${api.callId}`);
        await api.commit(async tx => {
          const thread = (await tx.doc(SettingsDoc)).threads[id];
          if (thread && !thread.tells?.includes(api.callId)) thread.tells = [...thread.tells ?? [], api.callId];
        }, callContext);
        const report = `its report comes back as a message starting "[${short(id)}] "`;
        if (accepted === "queued") return text(`queued for [${short(id)}], which is working: it has not read it yet, and reads it after its current tool call, in this turn; ${report}`);
        if (accepted === "consumed") return text(`[${short(id)}] already has it in its conversation; ${report}`);
        if (accepted === "dropped") return text(`[${short(id)}] took it while working, but it never reached the agent; ${report}, saying why`);
        return text(`sent to [${short(id)}]; ${report}`);
      },
    });
    // Newest first: the threads this chat started, by when it started them
    // (one spawn's threads, started in the same millisecond, last first).
    const spawned = async () => Object.entries((await this.harness.snapshot(SettingsDoc, context))?.threads ?? {}).reverse().sort((a, b) => b[1].at - a[1].at).map(([id]) => id);
    const threads = defineTool({
      name: "threads",
      description: "The threads you started that are not archived (working, ended or failed), newest first, with their state. "
        + "Archived threads are left out and only counted; archived_threads searches them.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async () => {
        const ids = await spawned();
        return text(ids.length ? await this.options.threads.describe(ids) : "no threads yet");
      },
    });
    const archivedThreads = defineTool({
      name: "archived_threads",
      description: "Search the threads you started that are archived, newest first, read only. query: part of a thread's id, title or project "
        + `(any case; absent: every archived thread). offset: skip that many matches, as the "next:" line gives; limit: at most ${ARCHIVED_MAX} (default ${ARCHIVED_PAGE}). `
        + "history(id) reads any of them.",
      parameters: Type.Object({
        query: Type.Optional(Type.String()),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: ARCHIVED_MAX })),
      }),
      replay: "safe",
      execute: async args => {
        const ids = await spawned();
        return text(ids.length ? await this.options.threads.describe(ids, { archived: true, query: args.query, offset: args.offset ?? 0, limit: Math.min(args.limit ?? ARCHIVED_PAGE, ARCHIVED_MAX) }) : "no threads yet");
      },
    });
    const history = defineTool({
      name: "history",
      description: `Read a thread you started, read only: cubed's own state for it, its run and latest answer, whether its report reached you, what disagrees, then its stored conversation, ${HISTORY_PAGE} messages at a time, newest last (before: show the messages before message #before, as its "earlier:" line gives; limit: at most ${HISTORY_MAX}). Archived threads and threads whose machine failed keep theirs.`,
      parameters: Type.Object({
        id: Type.String(),
        before: Type.Optional(Type.Integer({ minimum: 0, description: "Show the messages before message #before" })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: HISTORY_MAX })),
      }),
      replay: "safe",
      execute: async args => {
        const id = await this.resolve(args.id);
        const record = await this.options.threads.history(id, { before: args.before, limit: args.limit });
        if (!record) return text(`[${short(id)}] is gone: cubed has no record of it`);
        // A run's report, or without a transcript the failure to start.
        const run = record.transcript ? record.transcript.status.run : "start";
        const requestId = `report:${id}:${run}`;
        const report = !run ? "none" : await this.known(requestId) ? "delivered"
          : (await this.pending()).some(item => item.requestId === requestId) ? "accepted" : "none";
        return text(formatHistory(id, record, report));
      },
    });
    const diagnose = defineTool({
      name: "diagnose",
      description: "Read-only evidence about the machine of a thread you started, for one that does not start or whose agent never opened: cubed's record, "
        + "its machine events and last runner report, the runner's own evidence (state, QEMU command line, process, QMP, frames, disk, its events, "
        + "console and qemu logs, escaped, secrets redacted), the gateway's link and a guest hello. Starts, stops and attaches nothing. "
        + "Report it as it says: missing, unavailable or stale evidence is unknown, not success.",
      parameters: Type.Object({ id: Type.String() }),
      replay: "safe",
      execute: async args => {
        const diagnoseThread = this.options.threads.diagnose;
        if (!diagnoseThread) return text("diagnostics are not available");
        const id = await this.resolve(args.id);
        return text(await diagnoseThread(id) ?? `[${short(id)}] is gone: cubed has no record of it`);
      },
    });
    const archive = defineTool({
      name: "archive",
      description: "Archive threads you started that are done, to free their machines. Each one's agent closes and its machine is released, as the user's archive in cube does; "
        + "its conversation stays and history still reads it. A thread that is working or whose machine is still starting is not archived and nothing is stopped: "
        + "wait for its report. It cannot be undone from here. Name each thread by its whole 8-character id.",
      parameters: Type.Object({ ids: Type.Array(Type.String(), { minItems: 1, maxItems: 20 }) }),
      // Keyed by the call's task: each thread's line is stored as it is
      // answered, with the free machines it read (FREE), and a replay answers
      // those. A thread this call had sent to archive ("" stored) and finds
      // archived is its own archive.
      replay: "safe",
      execute: async (args, api, callContext) => {
        const archiveThread = this.options.threads.archive;
        if (!archiveThread) return text("archiving is not available");
        const call = String(api.taskId);
        const lines: string[] = [];
        let free: string | undefined;
        const record = (id: string, line: string, read?: string) => api.commit(async tx => {
          const settings = await tx.doc(SettingsDoc);
          // A task id is a number, never `__proto__`; the newest 64 calls are kept.
          (settings.archives ??= {})[call] = { ...settings.archives[call], [id]: line, ...read === undefined ? {} : { [FREE]: read } };
          const calls = Object.keys(settings.archives);
          for (const old of calls.slice(0, Math.max(0, calls.length - 64))) delete settings.archives[old];
        }, callContext);
        for (const given of args.ids) {
          let name = given;
          try {
            // A destructive call takes no shorter prefix than the ids it is shown.
            if (given.replace(/^\[|\]$/g, "").length < 8) throw new Error("name a thread by its whole 8-character id");
            const id = await this.resolve(given);
            name = `[${short(id)}]`;
            const stored = (await api.snapshot(SettingsDoc, callContext))?.archives?.[call];
            const prior = stored && Object.hasOwn(stored, id) ? stored[id] : undefined;
            if (prior) { lines.push(prior); free = stored![FREE] ?? free; continue; }
            if (prior === undefined) await record(id, "");
            const result = await archiveThread(id);
            if (!result) { lines.push(`${name} is gone: cubed has no record of it`); continue; }
            free = result.free;
            const line = `${name} ${result.already && prior === undefined ? "was already archived" : "archived"}: ${result.disk}; history still reads it`;
            await record(id, line, result.free);
            lines.push(line);
            await this.reportStored(id);
          } catch (error) {
            if (callContext.abortSignal?.aborted) throw error;
            lines.push(`${name} not archived: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (free) lines.push(`free thread machines: ${free}`);
        return text(lines.join("\n"));
      },
    });
    const usage = defineTool({
      name: "usage",
      description: "Token usage and estimated cost so far: of everything (by project, model and thread, and your own), of one project, or of one thread (its id). Estimates, not charges; usage without a record is reported as unknown.",
      parameters: Type.Object({
        project: Type.Optional(Type.String({ description: "Project name or id" })),
        thread: Type.Optional(Type.String({ description: "Thread id or its first characters" })),
      }),
      replay: "safe",
      execute: async args => text(this.options.threads.usage ? await this.options.threads.usage(args) : "usage is not available"),
    });
    const hooks = defineTool({
      name: "project_hooks",
      description: "Read a project's external hooks as cubed saved them (the scripts, each with its size and sha256; secret-looking values redacted), "
        + "the latest hook outcomes in its newest threads, and what hooks cube supports. Read-only.",
      parameters: Type.Object({ project: Type.String({ description: "Project name or id" }) }),
      replay: "safe",
      execute: async args => {
        if (!this.options.threads.hooks) return text("project hooks are not available");
        try { return text(await this.options.threads.hooks(args.project)); }
        catch (error) { return text(`not read: ${error instanceof Error ? error.message : String(error)}`); }
      },
    });
    const writeHooks = defineTool({
      name: "project_hooks_write",
      description: "Save a project's external hooks in cube's projects (not its repository) and read them back. Hooks are shell scripts that run in every new thread machine of that project, "
        + "so change them only when the user asked for it, naming the project. A hook not given stays as it is; \"\" removes it. Only preSetup and preResume exist.",
      parameters: Type.Object({
        project: Type.String({ description: "Project name or id" }),
        preSetup: Type.Optional(Type.String({ description: "The whole pre-setup script; \"\" removes it" })),
        preResume: Type.Optional(Type.String({ description: "The whole pre-resume script; \"\" removes it" })),
      }, { additionalProperties: false }),
      // Keyed by the call's task: a replay saves nothing and answers as the
      // first run did, so it never puts back hooks the user changed since.
      replay: "safe",
      execute: async (args, api, callContext) => {
        if (!this.options.threads.writeHooks) return text("project hooks are not available");
        // A thread's report is no request of the user's: its agent reads untrusted content.
        const users = (await api.snapshot(TurnDoc, api.conversationId, callContext))?.userInputs ?? [];
        const inputs = (await api.snapshot(LiveDoc, api.conversationId, callContext))?.run?.inputs ?? [];
        if (!inputs.some(id => users.includes(Number(id)))) {
          return text("not saved: no message of the user in this turn asks for it, and a thread's report cannot change hooks; ask the user to confirm in the chat");
        }
        try { return text(await this.options.threads.writeHooks(args.project, { preSetup: args.preSetup, preResume: args.preResume }, `${this.cacheKey}:hooks:${api.taskId}`)); }
        catch (error) { return text(`not saved: ${error instanceof Error ? error.message : String(error)}`); }
      },
    });
    const instructions = path.join(this.options.directory, "AGENTS.md");
    const artifacts = this.options.artifacts ? artifactTools({
      artifacts: this.options.artifacts, author: { kind: "optchat" }, agent: "optchat", projects: true,
      // The durable task's id within this chat store: the same on replay,
      // unique whatever ids the provider gives tool calls.
      key: api => `${this.cacheKey}:artifact:${api.taskId}`,
      model: () => this.model ? `${this.model.provider}/${this.model.id}` : undefined,
      readable: async () => [{ kind: "optchat" as const }, ...Object.keys((await this.harness.snapshot(SettingsDoc, context))?.threads ?? {}).map(thread => ({ kind: "thread" as const, thread }))],
    }) : [];
    return defineExtension({
      name: "optchat",
      tools: [zoom, date, projects, runners, spawn, tell, threads, archivedThreads, history, diagnose, archive, usage, hooks, writeHooks, ...artifacts].map(tool => this.guard(tool)),
      sections: [
        section("master", () => MASTER, { tag: false }),
        section("hooks", () => HOOKS_NOTE, { tag: false }),
        ...artifacts.length ? [section("artifacts", () => ARTIFACTS_NOTE, { tag: false })] : [],
        section("view", () => VIEW_DOC, { tag: false }),
        // The user's own instructions; constant unless they edit the file.
        section("user", () => {
          try { return fs.readFileSync(instructions, "utf8").trim() || undefined; }
          catch { return undefined; }
        }, { tag: false }),
      ],
      hooks: [hook(ToolTask, { beforeTool: async (_call, _api, callContext) => {
        // A close starts no tool either: the call waits before its intent is
        // recorded, until Pi closes and aborts it (a throw on an aborted
        // invocation is not a block), so the reopened run starts it once.
        if (this.closing) await this.holdBack(callContext.abortSignal, "tools");
        return undefined;
      } }), hook(GenerationTask, { beforeRequest: async (request, api, callContext) => {
        // A close sends no new request: this one waits, unsent, until Pi
        // closes and aborts it; the reopened run sends it then, once.
        if (this.closing) await this.holdBack(callContext.abortSignal, "requests");
        let messages: Message[];
        try {
          messages = await this.request(request.messages, api, callContext);
          // Last: stored before it leaves, so a stop before its answer is
          // counted and never sends it again (pi-sends.ts).
          await markSent(api, this.epoch, callContext);
        } catch (error) { return this.refuse(api.taskId, callContext.abortSignal, error); }
        this.requestError = null;
        return { messages };
      } })],
    });
  }

  /** The request as the chat sends it: the turn's images, read from the
   * store for this request only, and the view in front of the turn. */
  private async request(messages: readonly Message[], api: HookApi, callContext: Context): Promise<Message[]> {
    const support = this.imageSupport();
    const withTurnImages = withImages(messages, { load: id => this.media.get(id), refused: support.reason, limit: MEDIA_LIMITS.perTurn, bytes: MEDIA_LIMITS.turnBytes });
    const turn = await api.snapshot(TurnDoc, api.conversationId, callContext);
    if (!turn?.started) return withTurnImages;
    const parts: Part[] = [];
    for (let k = 0; k + 1 < turn.parts.length; k += 2) parts.push({ l: turn.parts[k]!, i: turn.parts[k + 1]! });
    return withView(withTurnImages, viewPieces(this.memory.render(parts)));
  }

  /** A request whose view or images could not be built is not sent. Pi
   * skips a throwing beforeRequest and sends what it built itself (no view,
   * no images: another prefix and another cost), unless the invocation was
   * aborted, when the throw ends it. So the generation is aborted first, as
   * a stop would: the turn ends unanswered, nothing retries it, and the
   * next message starts a new turn. Its abort comes with the abort commit,
   * or with the Session's end if that commit fails; a close aborts it too.
   * A close that seals admission before the abort commits leaves the task
   * live: the reopened chat builds this request again and sends it once if
   * it builds (it was never sent), or refuses it again. The wait counts as
   * a request held back, so a close neither waits for it nor counts it as
   * a call cut off: it was never sent. */
  private async refuse(task: TaskId, signal: AbortSignal | undefined, error: unknown): Promise<never> {
    if (!signal || signal.aborted) throw error;
    this.requestError = `a request was not sent: ${errorText(error)}`;
    log.warn("request not sent: its view or images failed; the turn ends unanswered", { task, error: errorText(error) });
    this.notify();
    void this.harness.abortTask(task, context).catch(abortError => {
      if (!signal.aborted) log.warn("the unsent request's turn was not aborted; it waits for the close", { task, error: errorText(abortError) });
    });
    this.gated.requests++;
    try { if (!signal.aborted) await new Promise(resolve => { signal.addEventListener("abort", resolve, { once: true }); }); }
    finally { this.gated.requests--; }
    throw error;
  }

  /** Holds a request or a tool call of the chat while it closes, until Pi
   * aborts its invocation; then throws, so it never starts. */
  private async holdBack(signal: AbortSignal | undefined, kind: "requests" | "tools"): Promise<void> {
    if (!signal) return;
    this.gated[kind]++;
    try { if (!signal.aborted) await new Promise(resolve => { signal.addEventListener("abort", resolve, { once: true }); }); }
    finally { this.gated[kind]--; }
    signal.throwIfAborted();
  }

  /** Every tool of the chat runs through this. A close starts none: held
   * as beforeTool holds a call, which also covers a replay's `execute`
   * phase. The close's grace waits for one executing. At the cut, Pi aborts
   * the call and it returns at once, so Pi's close is never held by work
   * that ignores the abort: that work may go on (`spawn` stops at its next
   * task and its git; `tell` and `archive` finish in cubed), which is why
   * every tool is read-only or keyed (TOOL_REPLAY), and the cut counts it. */
  private guard(tool: ToolRegistration): ToolRegistration {
    if (!Object.hasOwn(TOOL_REPLAY, tool.name)) throw new Error(`optchat tool ${tool.name} has no replay rule (TOOL_REPLAY)`);
    return { ...tool, execute: async (args, api, callContext) => {
      const signal = callContext.abortSignal;
      if (this.closing) {
        this.heldTools.add(api.taskId);
        try { await this.holdBack(signal, "tools"); }
        finally { this.heldTools.delete(api.taskId); }
      }
      this.running.set(api.taskId, tool.name);
      const work = (async () => tool.execute(args, api, callContext))();
      void work.then(() => {}, () => {}).finally(() => { this.running.delete(api.taskId); });
      if (!signal) return work;
      return new Promise((resolve, reject) => {
        // Only a close's abort cuts the call loose; a stop waits for it as before.
        const cut = () => { if (this.closing) reject(signal.reason); };
        if (signal.aborted) cut();
        signal.addEventListener("abort", cut, { once: true });
        work.then(resolve, reject).finally(() => { signal.removeEventListener("abort", cut); });
      });
    } };
  }

  /** Closes the chat. No node, turn, chat request, tool call or further
   * summary answer starts; the model calls already out (the nodes being
   * built and a chat request sent) and the tool calls executing get up to
   * `closeMs` to come back and be stored, a node held before its next answer
   * with its round. Only then is what is still out cut off, and counted in
   * CutDoc: a reopen may send those calls and runs those tools again (keyed).
   * The close ends within CLOSE_GRACE_MS + CLOSE_SETTLE_MS + CLOSE_JOIN_MS.
   * A crash has no grace: every call out at it is sent again, uncounted (N2). */
  close(): Promise<void> {
    return this.closed ??= this.shut();
  }

  /** Waits at most `ms` until no model call or tool call of the chat is
   * out: no node being built, no chat request sent whose answer is not
   * stored yet (one held back by the gate in beforeRequest was never sent),
   * and no tool executing or with its result not stored yet (one held back
   * was never started). Answers the nodes still being built, whether a chat
   * request is still out, and the tools still out by name. */
  private async quiesce(ms: number): Promise<{ nodes: string[]; chat: boolean; tools: string[] }> {
    const deadline = Date.now() + ms;
    for (;;) {
      const live = await this.live().catch(() => undefined);
      const generation = live?.generation;
      // Pi keeps `generation` from a request's start until its answer is stored.
      const chat = !!generation && !generation.retry && !generation.deferred && this.gated.requests === 0;
      // A slot reads running from the call's intent until its result is stored.
      const settling = (live?.tools ?? []).filter(slot => slot.status === "running" && slot.taskId !== undefined && !this.running.has(slot.taskId) && !this.heldTools.has(slot.taskId));
      const tools = [...this.running.values(), ...settling.map(slot => slot.name)];
      const left = deadline - Date.now();
      if ((!chat && !this.building.size && !tools.length) || left <= 0) return { nodes: [...this.building.keys()], chat, tools };
      await delay(Math.min(20, left));
    }
  }

  private async shut(): Promise<void> {
    this.closing = true;
    this.notify();
    for (const timer of this.timers) clearTimeout(timer);
    if (this.watchTimer) clearInterval(this.watchTimer);
    this.unsubscribeStart?.();
    this.unsubscribeFeed?.();
    if (this.harness && this.conversation) {
      const out = await this.quiesce(this.down ? 0 : this.options.limits?.closeMs ?? CLOSE_GRACE_MS);
      const calling = [...this.calling];
      const compactor = calling.map(([, model]) => model);
      const chat = out.chat && this.model ? [`${this.model.provider}/${this.model.id}`] : [];
      // Cut off at once, so no node sends another answer after this count.
      for (const [node] of calling) this.cutOff.add(node);
      this.abort.abort();
      if (compactor.length || chat.length || out.tools.length) {
        log.warn("calls cut off at close: the model calls' cost is unknown and the reopened chat does not send them again (a message of the user does); what the tools did is unknown and not undone, and the reopened chat runs them again, keyed",
          { chat, compactor, nodes: out.nodes, tools: out.tools });
        await this.harness.commit(async tx => {
          const doc = await tx.doc(CutDoc);
          // The chat's request: counted once, and not again by the next open.
          if (chat.length) countCut(await tx.doc(SendsDoc), chat[0]!);
          // A node's answer: counted here, not by the next open, which holds the node.
          const spend = await tx.doc(SpendDoc);
          for (const [node, model] of calling) {
            doc.compactor[model] = (Object.hasOwn(doc.compactor, model) ? doc.compactor[model]! : 0) + 1;
            const left = spend.nodes[node];
            if (left) { delete left.out; left.left = 0; left.interrupted = true; }
          }
          if (out.tools.length) doc.tools ??= {};
          // A key holds a slash, so it is never `__proto__`; a tool's name is one of TOOL_REPLAY's.
          for (const name of out.tools) doc.tools![name] = (Object.hasOwn(doc.tools!, name) ? doc.tools![name]! : 0) + 1;
        }, context).catch(error => { log.warn("calls cut off at close not counted", { error }); });
      }
    }
    this.abort.abort();
    // The cut-off calls' replies (usage, if any) are counted before Pi closes.
    await Promise.race([Promise.allSettled(this.building.values()), delay(CLOSE_SETTLE_MS, undefined, { ref: false })]);
    // Pi aborts every task and joins them; a tool cut off returns at once
    // (guard) and a model call on its abort. Bounded all the same: past it
    // the close goes on and the store is left to the process's exit.
    const rest = (async () => {
      await Promise.allSettled([...this.watchers.values()].map(async watching => (await watching)?.stop()));
      await this.stopWatch?.().catch(() => {});
      await this.syncing;
      await (this.harness ?? this.storage)?.close(context).catch(() => {});
      return true;
    })();
    // Held by its timer, so the close ends at the bound and not at the
    // process's exit; let go once the close is done.
    const bound = new AbortController();
    const joined = await Promise.race([rest, delay(CLOSE_JOIN_MS, false, { signal: bound.signal }).catch(() => false)]);
    bound.abort();
    if (!joined) log.warn("the chat did not close in time; cubed's close goes on", { ms: CLOSE_JOIN_MS, tools: [...this.running.values()] });
    // pi-ai keeps a provider connection per cache key open for minutes
    // (Codex's WebSocket); it would hold cubed's exit that long.
    for (const key of [this.cacheKey, `${this.cacheKey}-compact`]) {
      try { cleanupSessionResources(key); } catch (error) { log.warn("session resources not released", { error }); }
    }
  }
}

/** The turn's request: the system baseline first (Pi writes it when the run
 * starts, after the turn's user messages: one, or every one of a batch),
 * then the first of them with the view's pieces as its first blocks, then
 * the rest and the turn's own steps. A later system message, after the
 * model's first step, is an update and stays where it is. */
export function withView(messages: readonly Message[], pieces: readonly string[]): Message[] {
  const index = messages.findIndex(message => message.role === "user");
  if (index < 0) return [...messages];
  const out = messages.map((message, k) => {
    if (k !== index || message.role !== "user") return message;
    const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
    return { ...message, content: [...pieces.map(text => ({ type: "text" as const, text })), ...content] };
  });
  const system = out.findIndex((message, k) => k > index && message.role !== "user");
  if (out[system]?.role === "system" && !out.slice(0, index).some(message => message.role === "system")) {
    const [baseline] = out.splice(system, 1);
    out.splice(index, 0, baseline!);
  }
  return out;
}

/** Whether a turn whose messages carry these images (one id per image
 * part, so a repeat counts again) sends every one of them: no more than
 * withImages takes, by count and by bytes. Then each request of the turn
 * carries the same images, whatever is steered in after. */
export function turnFits(ids: readonly string[], size: (id: string) => number, limits: { count: number; bytes: number } = { count: MEDIA_LIMITS.perTurn, bytes: MEDIA_LIMITS.turnBytes }): boolean {
  return ids.length <= limits.count && ids.reduce((sum, id) => sum + size(id), 0) <= limits.bytes;
}

/** The turn's messages with each image reference replaced by the image
 * itself, newest first up to `limit`; an image that cannot go (the model
 * takes none, past the limit, missing from the store) becomes a note the
 * model reads, never a silent gap. */
export function withImages(messages: readonly Message[], options: { load: (id: string) => { bytes: Buffer; mimeType: string } | null; refused: string | null; limit: number; bytes?: number }): Message[] {
  let sent = 0, size = 0;
  const out = [...messages];
  for (let k = out.length - 1; k >= 0; k--) {
    const message = out[k]!;
    if (message.role !== "user" || typeof message.content === "string" || !message.content.some(part => part.type === "image" && mediaId(part.data))) continue;
    const parts = [...message.content];
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]!;
      const id = part.type === "image" ? mediaId(part.data) : null;
      if (!id) continue;
      const image = options.refused || sent >= options.limit ? null : options.load(id);
      const full = !!image && size + image.bytes.byteLength > (options.bytes ?? Infinity);
      if (image && !full) { parts[j] = { type: "image", mimeType: image.mimeType, data: image.bytes.toString("base64") }; sent++; size += image.bytes.byteLength; continue; }
      parts[j] = { type: "text", text: options.refused ? `(an image the user attached, not sent: ${options.refused})`
        : sent >= options.limit || full ? `(an earlier image of this turn, not sent: a turn's requests carry at most ${options.limit} images${options.bytes ? ` and ${Math.round(options.bytes / 1_000_000)} MB of them` : ""})`
        : "(an image the user attached, missing from cube's store)" };
    }
    out[k] = { ...message, content: parts };
  }
  return out;
}

/** The chat in the thread event model: Pi's transcript, then the messages
 * still waiting for their turn, shown as working (with the compactor's
 * failure, if it is stuck). */
export class OptChatEvents implements ThreadEvents {
  private readonly chat: OptChat;
  private readonly inner: ThreadEvents;
  constructor(chat: OptChat, inner: ThreadEvents) { this.chat = chat; this.inner = inner; }

  // The pending messages are read first: one that left them since is
  // already in the log the read returns.
  async read(): Promise<ThreadTranscript> {
    const pending = await this.chat.pending();
    return this.merge(await this.inner.read(), pending);
  }

  async watch(listener: (transcript: ThreadTranscript) => void | Promise<void>, options?: Parameters<ThreadEvents["watch"]>[1]): Promise<ThreadWatch> {
    let latest: ThreadTranscript | undefined;
    let chain: Promise<void> = Promise.resolve();
    // The transcript a frame merges may be older than the pending messages
    // it is merged with: Pi renders a long chat's frame after OptChat has
    // already taken a placed message out of the pending ones. A message a
    // frame showed stays shown while the transcript is older than its entry,
    // so it never goes and comes back, and the chat never reads idle between
    // a send and its run. One that left without an entry goes.
    const shown = new Map<string, PendingItem>();
    const emit = () => {
      chain = chain.then(async () => {
        if (!latest) return;
        const pending = await this.chat.pending();
        const newest = Math.max(0, ...latest.events.map(event => Number.parseInt(event.id, 10)).filter(Number.isFinite));
        const held = [...shown.values()].filter(item => {
          if (pending.some(other => other.requestId === item.requestId)) return false;
          const entry = this.chat.loggedAt(item.requestId);
          return entry != null && newest < entry;
        });
        const merged = await this.merge(latest, [...held, ...pending]);
        shown.clear();
        for (const event of merged.events) {
          const item = event.id.startsWith(PENDING_ID) ? [...held, ...pending].find(other => `${PENDING_ID}${other.requestId}` === event.id) : undefined;
          if (item) shown.set(item.requestId, item);
        }
        await listener(merged);
      }).catch(() => {});
      return chain;
    };
    const unsubscribe = this.chat.onPending(() => { void emit(); });
    try {
      const watch = await this.inner.watch(transcript => { latest = transcript; return emit(); }, options);
      return { closed: watch.closed.finally(unsubscribe), async stop() { unsubscribe(); await watch.stop(); } };
    } catch (error) { unsubscribe(); throw error; }
  }

  private async merge(input: ThreadTranscript, pending: readonly PendingItem[]): Promise<ThreadTranscript> {
    // A report of a thread this chat started is marked as the thread's.
    const threads = await this.chat.threadPrefixes();
    const report = (text: string) => /^\[([0-9a-f]{8})\] /.exec(text)?.[1];
    const transcript = { ...input, events: input.events.map(event => {
      const from = event.type === "user-message" ? report(event.text) : undefined;
      return from && threads.has(from) ? { ...event, from } : event;
    }) };
    const failure = this.chat.failure();
    if (!pending.length) return transcript;
    // A pending message is shown until the log has it after the point it was
    // accepted. Two of the same words accepted at one point are both taken
    // as placed by the first copy; the browser's own copy covers the second.
    const ids = (images: readonly { id: string }[] | undefined) => (images ?? []).map(image => image.id).join(",");
    const placed = (item: PendingItem) => transcript.events.some(event => event.type === "user-message" && event.text === item.text
      && ids(event.images) === ids(item.images) && Number.parseInt(event.id, 10) > item.after);
    return {
      ...transcript,
      events: [...transcript.events, ...pending.filter(item => !placed(item)).map(item => {
        const from = report(item.text);
        return { type: "user-message" as const, id: `${PENDING_ID}${item.requestId}`, text: item.text, ...(from && threads.has(from) ? { from } : {}),
          ...item.images?.length ? { images: item.images.map(image => ({ ...image })) } : {} };
      })],
      status: transcript.status.state === "working" ? { ...transcript.status, error: transcript.status.error ?? failure } : { state: "working", run: "pending", error: failure },
    };
  }
}
