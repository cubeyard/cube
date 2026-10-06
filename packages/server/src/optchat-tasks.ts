/** OptChat's task list: the small "now" the chat keeps for the user, so
 * ongoing work is read from a list rather than from the endless history.
 *
 * A task is OptChat's (and so the user's) intent: a title, a status, the
 * next action or what blocks it, and optional links to threads and URLs. It
 * is stored word for word in the chat's Pi store (`cube.optchat.tasks`),
 * never derived from the view's summaries. What a linked thread does is
 * observed separately, from cubed's record, when the list is read; a URL
 * is only a link: cube checks no pull request, merge or release state.
 * See docs/optchat.md, "Tasks". */
import { defineDoc } from "@earendil-works/pi-durable";

export const STATUSES = ["active", "pending", "blocked", "done", "dropped"] as const;
export type TaskStatus = typeof STATUSES[number];
const OPEN: readonly TaskStatus[] = ["blocked", "active", "pending"];
export const isOpen = (status: TaskStatus) => OPEN.includes(status);

/** Bounds: the list stays small enough to read at a glance and to send with every turn. */
export const LIMITS = { open: 20, closedKept: 30, closedShown: 5, closedDays: 7, title: 100, next: 280, project: 80, threads: 4, links: 4, url: 300 } as const;

export type Task = {
  /** `t<n>`, never reused. */
  id: string;
  title: string;
  status: TaskStatus;
  /** The next action, or for a blocked task what blocks it. */
  next: string;
  project: string | null;
  /** Full ids of threads this chat started. */
  threads: string[];
  /** https URLs, as given. */
  links: string[];
  created: number;
  updated: number;
  /** When it became done or dropped. */
  closed: number | null;
  /** The tool call that created it: a replayed call finds it again. */
  origin: string;
};
export type Tasks = { seq: number; items: Task[] };
export const TasksDoc = defineDoc<Tasks>({ kind: "cube.optchat.tasks", version: 1, scope: "session", initial: () => ({ seq: 0, items: [] }) });
/** The task list as the current turn started with it: every request of the turn sends the same bytes. */
export const TurnTasksDoc = defineDoc<{ text: string }>({
  kind: "cube.optchat.turn-tasks", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ text: "" }),
});

export type TaskInput = {
  id?: string | undefined;
  title?: string | undefined;
  status?: TaskStatus | undefined;
  next?: string | undefined;
  project?: string | undefined;
  threads?: readonly string[] | undefined;
  links?: readonly string[] | undefined;
};

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
function bounded(name: string, text: string, max: number): string {
  const value = oneLine(text);
  if (value.length > max) throw new Error(`${name} is ${value.length} characters; keep it under ${max}`);
  return value;
}

/** A link as given, if it is an https URL. */
export function checkLink(url: string): string {
  const value = url.trim();
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`not a URL: ${value.slice(0, 80)}`); }
  if (parsed.protocol !== "https:") throw new Error(`only https links: ${value.slice(0, 80)}`);
  if (value.length > LIMITS.url) throw new Error(`a link is longer than ${LIMITS.url} characters`);
  return parsed.href;
}

/** A GitHub pull request link as `owner/repo#n`; any other link as its host and path. */
export function linkLabel(url: string): { label: string; pr: boolean } {
  const parsed = new URL(url);
  const pr = parsed.hostname === "github.com" ? /^\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(parsed.pathname) : null;
  if (pr) return { label: `${pr[1]}/${pr[2]}#${pr[3]}`, pr: true };
  const label = `${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  return { label: label.length > 60 ? `${label.slice(0, 59)}…` : label, pr: false };
}

/** Creates (no `id`) or changes one task in `doc`. `threads` are already
 * resolved to full ids. Fields left out stay as they are; `threads` and
 * `links` replace the task's. */
export function applyTask(doc: Tasks, input: TaskInput, origin: string, now: number): { task: Task; created: boolean } {
  const fields: Partial<Task> = {};
  if (input.title !== undefined) {
    fields.title = bounded("title", input.title, LIMITS.title);
    if (!fields.title) throw new Error("a task needs a title");
  }
  if (input.status !== undefined) {
    if (!STATUSES.includes(input.status)) throw new Error(`status is one of ${STATUSES.join(", ")}`);
    fields.status = input.status;
  }
  if (input.next !== undefined) fields.next = bounded("next", input.next, LIMITS.next);
  if (input.project !== undefined) fields.project = bounded("project", input.project, LIMITS.project) || null;
  if (input.threads !== undefined) {
    if (input.threads.length > LIMITS.threads) throw new Error(`at most ${LIMITS.threads} threads per task`);
    fields.threads = [...new Set(input.threads)];
  }
  if (input.links !== undefined) {
    if (input.links.length > LIMITS.links) throw new Error(`at most ${LIMITS.links} links per task`);
    fields.links = [...new Set(input.links.map(checkLink))];
  }
  const opens = (status: TaskStatus) => isOpen(status) && doc.items.filter(task => isOpen(task.status)).length >= LIMITS.open;
  let task: Task | undefined;
  let created = false;
  if (input.id === undefined) {
    // A replayed call finds the task it made.
    task = doc.items.find(item => item.origin === origin);
    if (!task) {
      if (!fields.title) throw new Error("a new task needs a title");
      const status = fields.status ?? "active";
      if (opens(status)) throw new Error(`${LIMITS.open} tasks are open; close or drop one first`);
      // Whole before it is pushed: the doc records what it is given.
      const fresh: Task = { id: `t${++doc.seq}`, title: fields.title, status, next: "", project: null, threads: [], links: [], created: now, updated: now, closed: null, origin, ...fields };
      fresh.closed = isOpen(fresh.status) ? null : now;
      doc.items.push(fresh);
      task = doc.items.at(-1)!;
      created = true;
    }
  } else {
    const id = input.id.trim().replace(/^#/, "");
    task = doc.items.find(item => item.id === id);
    if (!task) throw new Error(`no task ${input.id}`);
    if (fields.status && !isOpen(task.status) && opens(fields.status)) throw new Error(`${LIMITS.open} tasks are open; close or drop one first`);
  }
  if (!created) {
    const was = task.status;
    Object.assign(task, fields, { updated: now });
    if (isOpen(task.status)) task.closed = null;
    else if (isOpen(was) || task.closed === null) task.closed = now;
  }
  // Old closed tasks leave the list; the chat's log still has every call that made them.
  const closed = doc.items.filter(item => !isOpen(item.status)).sort((a, b) => (b.closed ?? 0) - (a.closed ?? 0));
  const dropped = new Set(closed.slice(LIMITS.closedKept).map(item => item.id));
  if (dropped.size) doc.items = doc.items.filter(item => !dropped.has(item.id));
  return { task, created };
}

const rank = (status: TaskStatus) => OPEN.indexOf(status);
/** Open tasks (blocked first, then active, then pending; the latest change
 * first within each) and the few closed in the last days. */
export function shown(doc: Tasks | undefined, now: number): { open: Task[]; closed: Task[] } {
  const items = doc?.items ?? [];
  const open = items.filter(task => isOpen(task.status)).sort((a, b) => rank(a.status) - rank(b.status) || b.updated - a.updated);
  const since = now - LIMITS.closedDays * 86_400_000;
  const closed = items.filter(task => !isOpen(task.status) && (task.closed ?? 0) >= since)
    .sort((a, b) => (b.closed ?? 0) - (a.closed ?? 0)).slice(0, LIMITS.closedShown);
  return { open, closed };
}

/** A thread as cubed records it when the list is read. `state` is the
 * thread's own, never the task's: a turn that ended is not a task done. */
export type ObservedThread = { id: string; title: string | null; project: string; state: string };
/** How a thread's state reads beside a task. */
export function threadState(state: string): string {
  return state === "completed" ? "turn ended" : state;
}

/** One task as a line for the model. */
export function taskLine(task: Task, observed?: ReadonlyMap<string, ObservedThread | null>): string {
  const parts = [`${task.id} ${task.status}${task.project ? ` · ${task.project}` : ""} · ${task.title}`];
  if (task.next) parts.push(`${task.status === "blocked" ? "blocked on" : "next"}: ${task.next}`);
  for (const id of task.threads) {
    const thread = observed?.get(id);
    parts.push(`thread [${id.slice(0, 8)}]${observed ? ` ${thread ? threadState(thread.state) : "unknown"}` : ""}`);
  }
  for (const link of task.links) parts.push(`link ${linkLabel(link).label}`);
  return parts.join(" · ");
}

/** The list as the model reads it at a turn's start, or after a change. */
export function renderTasks(list: { open: Task[]; closed: Task[] }, observed?: ReadonlyMap<string, ObservedThread | null>): string {
  const lines = ["<now>",
    "Your task list, shown to the user as \"now\". A status is your intent, kept with task(); a thread's state is cube's record of it now; a link is only a link (cube checks no PR, merge or release).",
    ...(list.open.length ? list.open.map(task => taskLine(task, observed)) : ["no open tasks"]),
    ...(list.closed.length ? ["recently closed:", ...list.closed.map(task => taskLine(task, observed))] : []),
    "</now>"];
  return lines.join("\n");
}

/** A task as the UI reads it (`GET /api/optchat/tasks`). A thread's `state`
 * is cube's record now ("gone": cubed has no such thread; "unknown": not read). */
export type TaskView = Pick<Task, "id" | "title" | "status" | "next" | "project" | "updated" | "closed"> & {
  threads: Array<{ id: string; title: string | null; project: string | null; state: string }>;
  links: Array<{ url: string; label: string; pr: boolean }>;
};
export type TaskList = { open: TaskView[]; closed: TaskView[]; limit: number };
