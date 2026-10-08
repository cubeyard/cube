/** What agents and the browser do with artifacts (artifacts.ts): agents
 * write and read their own; the user comments, sends comments back to the
 * author, and confirms an artifact's typed actions.
 *
 * Comments reach their author as an ordinary message, the way a person's
 * would: OptChat's own pending queue for the chat's artifacts, a thread's
 * prompt (refused while it works, never queued into a run or interrupting
 * one) for a thread's. A batch that cannot go yet stays queued, with the
 * reason, and is tried again; its request id makes every attempt the same
 * message, accepted once.
 *
 * A confirmed action's outcome goes the same way, as notices written with
 * the outcome: to the author, and to OptChat when it started the author
 * thread (whose answer to its notice also reaches OptChat as its report). */
import { parseGitHubRepo } from "@cube/git";
import { createLogger } from "./log.ts";
import {
  ARTIFACT_LIMITS, ArtifactError, ArtifactStore, authorText, parseActions, sameAuthor,
  type ActionNotice, type ArtifactAction, type ArtifactAuthor, type ArtifactComment, type ArtifactSummary, type CommentBatch, type Provenance,
} from "./artifacts.ts";
import { GithubPullsError, type GithubPulls, type PullState } from "./github-pulls.ts";
import { threadAgent, type Registry } from "./registry.ts";

const log = createLogger("artifacts");
export const DELIVERY_RETRY_MS = 10_000;
/** A notice that could not go for this long stops waiting and says so. */
export const NOTICE_GIVE_UP_MS = 24 * 60 * 60_000;
/** OptChat records a thread it spawned just after the spawn returns (and on
 * a replay after a restart): a thread this young that it has not recorded
 * may still be its own, so its notice waits rather than being skipped. */
export const STARTER_GRACE_MS = 10 * 60_000;
/** How much of a body a read returns to an agent. */
const READ_BODY_CHARS = 120_000;

/** What an agent passes to write an artifact. */
export interface ArtifactWrite { id?: string | undefined; name?: string | undefined; title?: string | undefined; body: string; actions?: unknown; project?: string | undefined }

export interface ActionPreview {
  artifact: string; revision: number; head: number; action: ArtifactAction;
  /** The project's repository the action names, if it is one. */
  project: { id: string; name: string } | null;
  pull: PullState | null;
  /** Why it cannot run now; empty when it can. */
  problems: string[];
  /** What the user confirms: the exact target. */
  confirm: string;
}

/** OptChat as artifacts need it: its own queue, and the threads it started. */
export interface ArtifactChat { send(text: string, requestId: string): Promise<void>; started(thread: string): Promise<boolean> }
/** One message on its way: a comment batch or an action notice. */
type Outgoing = Pick<ActionNotice, "id" | "requestId" | "text" | "target">;

export class Artifacts {
  readonly store: ArtifactStore;
  private readonly registry: Registry;
  private readonly github: GithubPulls;
  private readonly optchat: () => Promise<ArtifactChat | null>;
  private readonly submit: (thread: string, text: string, requestId: string) => Promise<unknown>;
  private readonly inflight = new Set<string>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly giveUpMs: number;
  private readonly starterGraceMs: number;
  private closing = false;

  constructor(options: { store: ArtifactStore; registry: Registry; github: GithubPulls;
    optchat: () => Promise<ArtifactChat | null>;
    submit: (thread: string, text: string, requestId: string) => Promise<unknown>; retryMs?: number; giveUpMs?: number; starterGraceMs?: number }) {
    this.store = options.store; this.registry = options.registry; this.github = options.github;
    this.optchat = options.optchat; this.submit = options.submit;
    this.giveUpMs = options.giveUpMs ?? NOTICE_GIVE_UP_MS;
    this.starterGraceMs = options.starterGraceMs ?? STARTER_GRACE_MS;
    this.store.interruptedActions();
    this.timer = setInterval(() => void this.pump(), options.retryMs ?? DELIVERY_RETRY_MS);
    this.timer.unref();
    void this.pump();
  }
  close(): void { this.closing = true; clearInterval(this.timer); }

  /** The project a thread's artifacts belong to, or the one OptChat names. */
  private project(author: ArtifactAuthor, named: string | undefined): string | null {
    if (author.kind === "thread") {
      const thread = this.registry.getThread(author.thread);
      if (!thread) throw new ArtifactError("thread not found", 404);
      return thread.projectId;
    }
    if (!named?.trim()) return null;
    const projects = this.registry.listProjects();
    const project = projects.find(candidate => candidate.id === named) ?? projects.find(candidate => candidate.name.toLowerCase() === named.trim().toLowerCase());
    if (!project) throw new ArtifactError(`no project ${named}`);
    return project.id;
  }
  /** The GitHub repositories (owner/name, lowercase) of a project. */
  private repositories(projectId: string | null): Set<string> {
    const project = projectId ? this.registry.getProject(projectId) : null;
    return new Set((project?.repositories ?? []).map(repository => parseGitHubRepo(repository.url)?.toLowerCase()).filter((name): name is string => !!name));
  }

  /** Writes a new artifact or a revision of one of `author`'s; answers in words for the agent. */
  write(author: ArtifactAuthor, input: ArtifactWrite, provenance: Provenance, requestId: string): { text: string; id: string; revision: number } {
    const existing = input.id ? this.store.get(input.id) : input.name ? this.store.named(author, input.name) : null;
    if (input.id && (!existing || !sameAuthor(existing.author, author))) throw new ArtifactError(`no artifact ${input.id} of yours`, 404);
    const projectId = existing ? existing.projectId : this.project(author, input.project);
    const actions = parseActions(input.actions);
    if (actions.length) {
      if (!projectId) throw new ArtifactError("an artifact with actions needs a project: name the project whose repository the pull request is in");
      const repositories = this.repositories(projectId);
      for (const action of actions) {
        if (!repositories.has(action.repository.toLowerCase())) throw new ArtifactError(`${action.repository} is not a repository of this artifact's project; an action may only name the project's own repositories`);
      }
    }
    const title = input.title?.trim() || /^#\s+(.+)$/m.exec(input.body ?? "")?.[1]?.trim() || "";
    const written = this.store.write(author, { id: input.id, name: input.name, title, body: input.body, actions, projectId }, provenance, requestId);
    const { revision } = written;
    const verb = written.unchanged ? "unchanged: the same as revision" : written.created ? "created at revision" : "wrote revision";
    return {
      id: revision.artifact, revision: revision.number,
      text: `artifact ${revision.artifact} "${revision.title}" ${verb} ${revision.number}. The user opens it at #/a/${revision.artifact} `
        + `(link it in your reply as [${revision.title}](#/a/${revision.artifact})); their comments come back to you as a message starting "[artifact ${revision.artifact.slice(0, 8)}]".`
        + (actions.length ? ` Actions offered, each run only if the user confirms it: ${actions.map(actionText).join("; ")}.` : ""),
    };
  }

  /** One artifact whole (or a list without `id`) for an agent that may read `authors`' artifacts. */
  read(authors: readonly ArtifactAuthor[], id: string | undefined, revision?: number): string {
    if (!id) {
      const list = this.store.list({ authors });
      if (!list.length) return "no artifacts yet";
      return list.map(item => `${item.id} "${item.title}" · revision ${item.head} · by ${authorText(item.author)} · ${commentCounts(item)}`).join("\n");
    }
    const artifact = this.store.get(id);
    if (!artifact || !authors.some(author => sameAuthor(author, artifact.author))) throw new ArtifactError(`no artifact ${id} you can read`, 404);
    const number = revision ?? artifact.head;
    const shown = this.store.revision(id, number);
    if (!shown) throw new ArtifactError(`no revision ${number}; the artifact has ${artifact.head}`);
    const project = artifact.projectId ? this.registry.getProject(artifact.projectId) : null;
    const comments = this.store.comments(id).filter(comment => comment.state !== "draft");
    const runs = this.store.actionRuns(id);
    const notices = this.store.notices(id).filter(notice => notice.state !== "skipped");
    const body = shown.body.length > READ_BODY_CHARS ? `${shown.body.slice(0, READ_BODY_CHARS)}\n[cut at ${READ_BODY_CHARS} characters]` : shown.body;
    return [
      `artifact ${id} "${shown.title}" · revision ${number} of ${artifact.head} · by ${authorText(artifact.author)}${project ? ` · project ${project.name}` : ""} · open it at #/a/${id}`,
      shown.actions.length ? `actions: ${shown.actions.map(actionText).join("; ")}` : "actions: none",
      ...runs.flatMap(run => [`action ${run.action} (revision ${run.revision}): ${run.state}: ${run.detail}`,
        ...notices.filter(notice => notice.run === run.id).map(notice => `  told ${targetText(notice.target)}: ${notice.state}${notice.note ? ` (${notice.note})` : ""}`)]),
      comments.length ? `comments sent to the author:\n${comments.map(commentLine).join("\n")}` : "comments sent to the author: none",
      `--- body of revision ${number} ---`,
      body,
    ].join("\n");
  }

  /** The user's drafts on `id` go to the author as one message. */
  queue(id: string, requestId: string): CommentBatch | null {
    const batch = this.store.queue(id, requestId, artifact => {
      const thread = artifact.author.kind === "thread" ? this.registry.getThread(artifact.author.thread) : null;
      return thread && threadAgent(thread) === "claude-code" && artifact.name
        ? `Write /cube/artifacts/${artifact.name}.md; Read it for the whole document`
        : `artifact_write with id ${artifact.id}; artifact_read reads it whole`;
    });
    void this.pump();
    return batch;
  }

  /** Tries every queued batch and notice once; one that cannot go yet keeps its reason. */
  async pump(): Promise<void> {
    if (this.closing) return;
    const { store } = this;
    // Never rejects: it runs unawaited, and a failed try stays queued for the next.
    try {
      await Promise.allSettled([
        ...store.queued().map(batch => this.deliver(batch, { settle: (state, note) => store.settle(batch.id, state, note), note: note => store.note(batch.id, note) })),
        ...store.queuedNotices().map(notice => this.deliver(notice, {
          settle: (state, note) => store.settleNotice(notice.id, state, note), note: note => store.noteNotice(notice.id, note),
          skip: note => store.settleNotice(notice.id, "skipped", note),
          giveUp: notice.createdAt + this.giveUpMs <= Date.now() })),
      ]);
    } catch (error) { if (!this.closing) log.warn("artifact delivery round failed", { error: error instanceof Error ? error.message : String(error) }); }
  }
  private async deliver(item: Outgoing, record: { settle(state: "delivered" | "undeliverable", note: string): void; note(note: string): void;
    skip?: (note: string) => void; giveUp?: boolean }): Promise<void> {
    if (this.inflight.has(item.id) || this.closing) return;
    this.inflight.add(item.id);
    // A notice past its bound stops waiting: the last reason is its outcome.
    const wait = (note: string) => this.closing ? undefined : record.giveUp
      ? record.settle("undeliverable", `not delivered in ${Math.round(this.giveUpMs / 3_600_000)} h, so it stopped waiting; last: ${note.replace(/^waiting: /, "")}`)
      : record.note(note);
    try {
      if (item.target.kind !== "thread") {
        const chat = await this.optchat().catch(() => null);
        if (!chat) { wait("waiting: the chat is not open yet"); return; }
        if (item.target.kind === "starter" && !await chat.started(item.target.thread)) {
          const young = (this.registry.getThread(item.target.thread)?.createdAt ?? 0) + this.starterGraceMs > Date.now();
          if (young) wait("waiting: the chat has not recorded this thread as its own yet");
          else record.skip?.("the chat did not start this thread");
          return;
        }
        // The chat's own queue: delivered between its tool calls or as its next turn.
        await chat.send(item.text, item.requestId);
        record.settle("delivered", "in the chat");
        return;
      }
      const thread = this.registry.getThread(item.target.thread);
      if (!thread || thread.archived) {
        record.settle("undeliverable", `${thread ? "the thread was archived" : "cube no longer knows the thread"}, so nothing can reach it; say it in the chat if it still matters`);
        return;
      }
      try {
        await this.submit(thread.id, item.text, item.requestId);
        record.settle("delivered", "sent to the thread");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const busy = /already working/.test(message);
        wait(busy ? "waiting: the thread is working; sent once its turn ends" : `waiting: ${message}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn("artifact delivery failed", { item: item.id, error: message });
      wait(`waiting: ${message}`);
    } finally { this.inflight.delete(item.id); }
  }

  /** The action as it stands now: the document's target, the project's
   * ownership of it and the pull request's live state on GitHub. */
  async preview(id: string, actionId: string, revision: number): Promise<ActionPreview> {
    const artifact = this.store.get(id);
    if (!artifact) throw new ArtifactError("no such artifact", 404);
    const shown = this.store.revision(id, revision);
    if (!shown) throw new ArtifactError("no such revision", 404);
    const action = shown.actions.find(candidate => candidate.id === actionId);
    if (!action) throw new ArtifactError("this revision offers no such action", 404);
    const problems: string[] = [];
    if (revision !== artifact.head) problems.push(`this is revision ${revision}; only the newest revision's (${artifact.head}) actions run`);
    const project = artifact.projectId ? this.registry.getProject(artifact.projectId) : null;
    if (!project) problems.push("the artifact's project no longer exists");
    else if (!this.repositories(project.id).has(action.repository.toLowerCase())) problems.push(`${action.repository} is no longer a repository of project ${project.name}`);
    for (const run of this.store.actionRuns(id)) if (run.action === action.id && run.state !== "failed") problems.push(`already ${run.state === "running" ? "running" : "done"}: ${run.detail}`);
    let pull: PullState | null = null;
    try {
      pull = await this.github.pull(action.repository, action.pull);
      if (pull.merged) problems.push("the pull request is already merged");
      else if (pull.state !== "open") problems.push("the pull request is closed");
      if (pull.draft) problems.push("the pull request is a draft");
      if (pull.headSha !== action.headSha) problems.push(`the pull request's head is now ${pull.headSha.slice(0, 12)}, not ${action.headSha.slice(0, 12)} which this document is about; ask the author for a new revision`);
      if (pull.mergeable === false) problems.push(`github says it cannot be merged (${pull.mergeableState})`);
      else if (pull.mergeable === null && !pull.merged && pull.state === "open") problems.push("github has not computed whether it can be merged yet; check again in a moment");
    } catch (error) {
      problems.push(error instanceof GithubPullsError ? error.message : "could not read the pull request");
    }
    return { artifact: id, revision, head: artifact.head, action, project: project ? { id: project.id, name: project.name } : null, pull, problems,
      confirm: `${action.repository}#${action.pull}` };
  }

  /** Runs a confirmed action: every check again, then the merge, pinned to
   * the head commit the document is about. */
  async run(id: string, actionId: string, input: { revision: unknown; confirm: unknown; requestId: unknown }): Promise<{ preview: ActionPreview; detail: string; state: "running" | "succeeded" }> {
    if (typeof input.revision !== "number") throw new ArtifactError("revision is required");
    if (typeof input.requestId !== "string" || !input.requestId || input.requestId.length > 200) throw new ArtifactError("a request id is required");
    const preview = await this.preview(id, actionId, input.revision);
    if (input.confirm !== preview.confirm) throw new ArtifactError(`confirm with exactly ${preview.confirm}`);
    // A repeated request answers what it did; one that failed is no success
    // to repeat: a new attempt needs a new request id.
    const prior = this.store.actionRuns(id).find(run => run.requestId === input.requestId);
    if (prior?.state === "failed") throw new ArtifactError(`not merged: ${prior.detail}`, 409);
    if (prior) return { preview, detail: prior.detail, state: prior.state as "running" | "succeeded" };
    if (preview.problems.length) throw new ArtifactError(`not run: ${preview.problems.join("; ")}`, 409);
    const { action } = preview;
    const { run, fresh } = this.store.beginAction(id, input.revision, action.id, input.requestId);
    if (!fresh) {
      if (run.state === "failed") throw new ArtifactError(`not merged: ${run.detail}`, 409);
      return { preview, detail: run.detail, state: run.state as "running" | "succeeded" };
    }
    let detail: string;
    try {
      const result = await this.github.merge(action.repository, action.pull, { sha: action.headSha, method: action.method });
      if (!result.merged) throw new GithubPullsError(`github did not merge: ${result.message}`, 409);
      detail = `merged ${action.repository}#${action.pull} at ${action.headSha.slice(0, 12)} (${action.method})${result.sha ? `; merge commit ${result.sha.slice(0, 12)}` : ""}`;
    } catch (error) {
      detail = error instanceof GithubPullsError ? error.message : `failed: ${error instanceof Error ? error.message : String(error)}`;
      this.store.finishAction(run.id, "failed", detail);
      void this.pump();
      throw new ArtifactError(`not merged: ${detail}`, 409);
    }
    // Outside the merge's try: a store failure after GitHub merged is never
    // recorded as a failed merge; the run stays running until a restart
    // records, and tells, that its outcome is unknown.
    this.store.finishAction(run.id, "succeeded", detail);
    log.info("artifact action ran", { artifact: id, action: action.id, repository: action.repository, pull: action.pull });
    void this.pump();
    return { preview, detail, state: "succeeded" };
  }

  /** Everything the browser shows of one artifact. */
  view(id: string) {
    const artifact = this.store.get(id);
    if (!artifact) return null;
    return { artifact: this.summaryView(artifact), revisions: this.store.revisions(id), comments: this.store.comments(id), actionRuns: this.store.actionRuns(id),
      notices: this.store.notices(id).map(({ text: _text, requestId: _request, ...notice }) => notice) };
  }
  summaryView(artifact: ArtifactSummary) {
    const project = artifact.projectId ? this.registry.getProject(artifact.projectId) : null;
    const thread = artifact.author.kind === "thread" ? this.registry.getThread(artifact.author.thread) : null;
    return { ...artifact, project: project ? { id: project.id, name: project.name } : null,
      thread: thread ? { id: thread.id, title: thread.title, archived: thread.archived } : null };
  }
}

const targetText = (target: ActionNotice["target"]) => target.kind === "starter" ? "the chat" : authorText(target);
const actionText = (action: ArtifactAction) => `${action.id}: merge ${action.repository}#${action.pull} at ${action.headSha.slice(0, 12)} (${action.method})`;
const commentCounts = (item: ArtifactSummary) => {
  const { draft, queued, delivered, undeliverable } = item.comments;
  return [delivered && `${delivered} comments sent`, queued && `${queued} waiting`, draft && `${draft} drafts`, undeliverable && `${undeliverable} undeliverable`].filter(Boolean).join(", ") || "no comments";
};
const commentLine = (comment: ArtifactComment) => `- revision ${comment.revision}, "${comment.anchor.quote.slice(0, 200)}": ${comment.body.slice(0, 600)} (${comment.state})`;

export { ARTIFACT_LIMITS };
/** What the browser reads of one artifact. */
export type ArtifactView = NonNullable<ReturnType<Artifacts["view"]>>;
export type ArtifactListItem = ReturnType<Artifacts["summaryView"]>;
