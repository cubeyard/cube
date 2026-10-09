/** Work artifacts: documents OptChat and threads write for the user to read,
 * comment on and act on. An artifact is a persistent, linked work surface
 * with numbered revisions, never a task list: the chat stays the only place
 * to talk, and a comment goes back to the artifact's author as an ordinary
 * message. Product data in `CUBED_STATE/artifacts.sqlite`; Pi's stores keep
 * no copy and cubed keeps no second workflow journal.
 *
 * A revision's body is Markdown (with Mermaid and diff fences), rendered in
 * the browser as data: nothing in it runs. The only side effects a document
 * can name are typed actions from a fixed list (`github.merge`), stored apart
 * from the body, checked against the artifact's project when written and
 * against live state when the user confirms one (artifact-service.ts). A
 * run's outcome is told to the author, and to OptChat for a thread it
 * started, as notices recorded with the outcome itself. */
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const ARTIFACT_LIMITS = {
  title: 200,
  body: 256 * 1024,
  actions: 8,
  revisions: 500,
  /** Artifacts one author may hold. */
  perAuthor: 500,
  comment: 4000,
  quote: 2000,
  context: 160,
  section: 200,
  /** Drafts waiting on one artifact. */
  drafts: 50,
} as const;
const SCHEMA = 1;

export type ArtifactAuthor = { kind: "optchat" } | { kind: "thread"; thread: string };
/** A merge the user may confirm: the pull request and the exact head commit
 * the document is about. GitHub refuses the merge if the head has moved. */
export interface MergeAction {
  kind: "github.merge"; id: string; label: string;
  repository: string; pull: number; headSha: string; method: "merge" | "squash" | "rebase";
}
export type ArtifactAction = MergeAction;
/** Where a revision came from: who wrote it, through what, from which file. */
export interface Provenance {
  agent: "optchat" | "pi" | "claude-code";
  thread?: string;
  /** The tool call (Pi task or Claude Code tool_use id) that wrote it. */
  call?: string;
  model?: string;
  source?: { path: string; sha256: string };
}
export interface ArtifactSummary {
  id: string; title: string; name: string | null; author: ArtifactAuthor; projectId: string | null;
  head: number; createdAt: number; updatedAt: number;
  comments: { draft: number; queued: number; delivered: number; undeliverable: number };
}
export interface Revision {
  artifact: string; number: number; title: string; body: string; actions: ArtifactAction[];
  provenance: Provenance; createdAt: number;
  /** Who wrote this revision, from its provenance; the artifact's author never changes. */
  editor: ArtifactAuthor;
}
/** A selection in one revision's rendered text: the quote with what
 * surrounds it, its offsets in that text and the heading it falls under. */
export interface Anchor { quote: string; prefix: string; suffix: string; start: number; end: number; section: string }
export type CommentState = "draft" | "queued" | "delivered" | "undeliverable";
export interface ArtifactComment {
  id: string; artifact: string; revision: number; anchor: Anchor; body: string; createdAt: number;
  state: CommentState; batch: string | null;
  /** Why a queued batch still waits, or why it cannot be delivered. */
  note: string | null; deliveredAt: number | null;
}
export interface CommentBatch {
  id: string; artifact: string; requestId: string; text: string; target: ArtifactAuthor;
  state: "queued" | "delivered" | "undeliverable"; note: string | null; createdAt: number; deliveredAt: number | null;
}
export interface ActionRun {
  id: string; artifact: string; revision: number; action: string; requestId: string;
  state: "running" | "succeeded" | "failed"; detail: string; createdAt: number;
}
/** Who hears of a finished action run: the artifact's author, or OptChat
 * when it started the thread that wrote the artifact (checked when it goes). */
export type NoticeTarget = ArtifactAuthor | { kind: "starter"; thread: string };
/** One message telling a run's outcome, written with the outcome and
 * delivered like a comment batch: the same text under the same request id
 * on every try, accepted once. */
export interface ActionNotice {
  id: string; artifact: string; run: string; requestId: string; text: string; target: NoticeTarget;
  /** `skipped`: OptChat did not start the author thread, so it is not told. */
  state: "queued" | "delivered" | "undeliverable" | "skipped"; note: string | null; createdAt: number; deliveredAt: number | null;
}

export const isArtifactName = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value) && !value.includes("..");
export class ArtifactError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = "ArtifactError"; this.status = status; }
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isArtifactId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
export const authorKey = (author: ArtifactAuthor) => author.kind === "optchat" ? "optchat" : `thread:${author.thread}`;
const parseAuthor = (key: string): ArtifactAuthor => key === "optchat" ? { kind: "optchat" } : { kind: "thread", thread: key.slice("thread:".length) };
const targetKey = (target: NoticeTarget) => target.kind === "starter" ? `starter:${target.thread}` : authorKey(target);
const parseTarget = (key: string): NoticeTarget => key.startsWith("starter:") ? { kind: "starter", thread: key.slice("starter:".length) } : parseAuthor(key);
export const sameAuthor = (a: ArtifactAuthor, b: ArtifactAuthor) => authorKey(a) === authorKey(b);
export const authorText = (author: ArtifactAuthor) => author.kind === "optchat" ? "optchat" : `thread [${author.thread.slice(0, 8)}]`;
export const editorOf = (provenance: Provenance): ArtifactAuthor => provenance.agent === "optchat" ? { kind: "optchat" } : { kind: "thread", thread: provenance.thread ?? "" };

/** The typed action list as an agent wrote it, checked field by field:
 * unknown kinds and fields are refused, never ignored. */
export function parseActions(raw: unknown): ArtifactAction[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ArtifactError("actions must be a list");
  if (raw.length > ARTIFACT_LIMITS.actions) throw new ArtifactError(`at most ${ARTIFACT_LIMITS.actions} actions`);
  const ids = new Set<string>();
  return raw.map((item, index) => {
    const where = `action ${index + 1}`;
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ArtifactError(`${where} must be an object`);
    const record = item as Record<string, unknown>;
    if (record.kind !== "github.merge") throw new ArtifactError(`${where}: kind must be "github.merge", the only action an artifact can offer`);
    const allowed = new Set(["kind", "id", "label", "repository", "pull", "headSha", "method"]);
    const extra = Object.keys(record).filter(key => !allowed.has(key));
    if (extra.length) throw new ArtifactError(`${where}: unknown field ${extra.join(", ")}`);
    const repository = record.repository;
    if (typeof repository !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9_.-]+$/.test(repository) || repository.includes("..")) {
      throw new ArtifactError(`${where}: repository must be owner/name of a GitHub repository`);
    }
    const pull = record.pull;
    if (typeof pull !== "number" || !Number.isSafeInteger(pull) || pull < 1) throw new ArtifactError(`${where}: pull must be a pull request number`);
    const headSha = record.headSha;
    if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/.test(headSha)) throw new ArtifactError(`${where}: headSha must be the pull request's full 40-character head commit`);
    const method = record.method ?? "merge";
    if (method !== "merge" && method !== "squash" && method !== "rebase") throw new ArtifactError(`${where}: method must be merge, squash or rebase`);
    const id = record.id ?? `merge-${pull}`;
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) throw new ArtifactError(`${where}: id must be lowercase letters, digits and dashes`);
    if (ids.has(id)) throw new ArtifactError(`${where}: id ${id} is used twice`);
    ids.add(id);
    const label = record.label ?? `merge ${repository}#${pull}`;
    if (typeof label !== "string" || !label.trim() || label.length > 80 || /[\u0000-\u001f]/.test(label)) throw new ArtifactError(`${where}: label must be one line of at most 80 characters`);
    return { kind: "github.merge" as const, id, label: label.trim(), repository, pull, headSha, method };
  });
}

/** The comments as the message their author receives: each with its exact
 * quote, the text around it, the heading it falls under and the revision it
 * was written on, so the author can find it without guessing. */
export function commentMessage(artifact: { id: string; title: string; head: number }, comments: readonly ArtifactComment[], hint: string, editedBy?: ArtifactAuthor): string {
  const edited = editedBy ? `; ${authorText(editedBy)} wrote that revision` : "";
  const lines = [`[artifact ${artifact.id.slice(0, 8)}] The user commented on your artifact "${artifact.title}" (${artifact.id}, now at revision ${artifact.head}${edited}): ${comments.length} comment${comments.length === 1 ? "" : "s"}.`];
  comments.forEach((comment, index) => {
    const { anchor } = comment;
    const stale = comment.revision !== artifact.head ? ` (written on revision ${comment.revision}; the current one is ${artifact.head})` : "";
    lines.push("", `${index + 1}. On revision ${comment.revision}${stale}${anchor.section ? `, under "${anchor.section}"` : ""}, the user selected:`);
    lines.push(`   > ${anchor.quote.replace(/\n/g, "\n   > ")}`);
    const flat = (text: string) => text.replace(/\s+/g, " ");
    const quoted = anchor.quote.length > 120 ? `${anchor.quote.slice(0, 60)}…${anchor.quote.slice(-60)}` : anchor.quote;
    if (anchor.prefix || anchor.suffix) lines.push(`   in context: …${flat(anchor.prefix)}[[${flat(quoted)}]]${flat(anchor.suffix)}…`);
    lines.push(`   comment: ${comment.body.replace(/\n/g, "\n   ")}`);
  });
  lines.push("", `Answer in your reply. If the comments call for changes to the document, write a new revision of the same artifact (${hint}).`);
  return lines.join("\n");
}

/** What a finished run tells `target`: the action, its exact target and
 * what the run recorded, nothing more. */
export function actionMessage(artifact: { id: string; title: string; author: ArtifactAuthor }, action: ArtifactAction | null,
  run: { action: string; revision: number; state: "succeeded" | "failed" | "unknown"; detail: string }, target: NoticeTarget): string {
  const what = action ? `"${action.label}" (github.merge ${action.repository}#${action.pull} at ${action.headSha.slice(0, 12)}, ${action.method})` : `action ${run.action}`;
  const whose = target.kind === "starter" && artifact.author.kind === "thread" ? `the artifact "${artifact.title}" of thread [${artifact.author.thread.slice(0, 8)}]` : `your artifact "${artifact.title}"`;
  // One line: text from GitHub cannot start a line of its own.
  const detail = run.detail.replace(/\s+/g, " ").trim().replace(/\.$/, "");
  const outcome = run.state === "succeeded" ? `Done: ${detail}.`
    : run.state === "unknown" ? `Its outcome is unknown: ${detail}. Check the pull request on GitHub before saying either way.`
    : `It did not succeed: ${detail}. Nothing says it merged; check the pull request on GitHub before saying otherwise.`;
  const next = target.kind === "thread"
    ? "Nothing more is asked of you. If the outcome calls for follow-up, say what; otherwise answer in one line."
    : "Tell the user only what this changes for them.";
  return `[artifact ${artifact.id.slice(0, 8)}] The user confirmed ${what} on ${whose} (${artifact.id}, revision ${run.revision}; #/a/${artifact.id}). ${outcome} ${next}`;
}

type Row = Record<string, unknown>;

export class ArtifactStore {
  private readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file, { timeout: 5000 });
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=FULL");
    this.db.exec("PRAGMA foreign_keys=ON");
    const version = (this.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (version !== 0 && version !== SCHEMA) throw new Error(`artifacts.sqlite has schema ${version}, not ${SCHEMA}`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, project_id TEXT,
        head INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, create_request TEXT NOT NULL UNIQUE, name TEXT);
      CREATE INDEX IF NOT EXISTS artifacts_author ON artifacts(author);
      CREATE UNIQUE INDEX IF NOT EXISTS artifacts_name ON artifacts(author, name);
      CREATE TABLE IF NOT EXISTS revisions (artifact TEXT NOT NULL REFERENCES artifacts(id), number INTEGER NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, actions TEXT NOT NULL, provenance TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL, PRIMARY KEY (artifact, number));
      CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, artifact TEXT NOT NULL REFERENCES artifacts(id), request_id TEXT NOT NULL UNIQUE,
        text TEXT NOT NULL, target TEXT NOT NULL, state TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL, delivered_at INTEGER);
      CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, artifact TEXT NOT NULL REFERENCES artifacts(id), revision INTEGER NOT NULL,
        anchor TEXT NOT NULL, body TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
        batch TEXT REFERENCES batches(id));
      CREATE INDEX IF NOT EXISTS comments_artifact ON comments(artifact);
      CREATE TABLE IF NOT EXISTS action_runs (id TEXT PRIMARY KEY, artifact TEXT NOT NULL REFERENCES artifacts(id), revision INTEGER NOT NULL,
        action TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notices (id TEXT PRIMARY KEY, artifact TEXT NOT NULL REFERENCES artifacts(id), run TEXT NOT NULL REFERENCES action_runs(id),
        target TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, state TEXT NOT NULL, note TEXT, created_at INTEGER NOT NULL,
        delivered_at INTEGER, UNIQUE (run, target));
      PRAGMA user_version=${SCHEMA};`);
  }
  close(): void { this.db.close(); }

  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = action(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  /** A new artifact by `editor`, or a new revision of any artifact (who may
   * revise which is artifact-service.ts's to decide). A revision must be
   * written on the newest one: on `base`, or without it on the editor's own
   * newest revision; anything else is refused, never merged or overwritten.
   * Actions left out keep the newest revision's, exactly. The same request
   * id finds the revision it wrote (a replayed tool call); the same content
   * as the current revision writes nothing. */
  write(editor: ArtifactAuthor, input: { id?: string | undefined; name?: string | undefined; base?: number | undefined; title: string; body: string;
    actions?: ArtifactAction[] | undefined; projectId: string | null },
  provenance: Provenance, requestId: string): { revision: Revision; created: boolean; unchanged: boolean; actionsKept: boolean } {
    const title = input.title.trim().replace(/\s+/g, " ");
    if (!title || title.length > ARTIFACT_LIMITS.title) throw new ArtifactError(`title is required and must be at most ${ARTIFACT_LIMITS.title} characters`);
    if (typeof input.body !== "string" || !input.body.trim()) throw new ArtifactError("body is required");
    if (Buffer.byteLength(input.body) > ARTIFACT_LIMITS.body) throw new ArtifactError(`body is ${Buffer.byteLength(input.body)} bytes; at most ${ARTIFACT_LIMITS.body}`);
    if (!requestId || requestId.length > 300) throw new ArtifactError("a request id is required");
    if (input.name !== undefined && !isArtifactName(input.name)) throw new ArtifactError("a name is 1 to 64 lowercase letters, digits, dots, dashes or underscores");
    // The editor is read back from the provenance, so it names the editor's thread.
    if (editor.kind === "thread") provenance = { ...provenance, thread: editor.thread };
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT artifact, number, provenance FROM revisions WHERE request_id = ?").get(requestId) as Row | undefined;
      // Another editor's request id is a clash, never that editor's revision.
      if (prior && !sameAuthor(editorOf(JSON.parse(String(prior.provenance)) as Provenance), editor)) throw new ArtifactError("this request id belongs to another author's write", 409);
      if (prior) return { revision: this.revision(String(prior.artifact), Number(prior.number))!, created: false, unchanged: false, actionsKept: false };
      const now = Date.now();
      const named = input.id === undefined && input.name !== undefined
        ? this.db.prepare("SELECT id FROM artifacts WHERE author = ? AND name = ?").get(authorKey(editor), input.name) as Row | undefined : undefined;
      if (named) input = { ...input, id: String(named.id) };
      if (input.id === undefined) {
        const count = (this.db.prepare("SELECT count(*) AS n FROM artifacts WHERE author = ?").get(authorKey(editor)) as { n: number }).n;
        if (count >= ARTIFACT_LIMITS.perAuthor) throw new ArtifactError(`at most ${ARTIFACT_LIMITS.perAuthor} artifacts per author`);
        const id = randomUUID();
        this.db.prepare("INSERT INTO artifacts (id, title, author, project_id, head, created_at, updated_at, create_request, name) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)")
          .run(id, title, authorKey(editor), input.projectId, now, now, requestId, input.name ?? null);
        this.db.prepare("INSERT INTO revisions (artifact, number, title, body, actions, provenance, request_id, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)")
          .run(id, title, input.body, JSON.stringify(input.actions ?? []), JSON.stringify(provenance), requestId, now);
        return { revision: this.revision(id, 1)!, created: true, unchanged: false, actionsKept: false };
      }
      const artifact = this.row(input.id);
      if (!artifact) throw new ArtifactError(`no artifact ${input.id}`, 404);
      const head = this.revision(input.id, Number(artifact.head))!;
      const actions = JSON.stringify(input.actions ?? head.actions);
      if (head.title === title && head.body === input.body && JSON.stringify(head.actions) === actions) return { revision: head, created: false, unchanged: true, actionsKept: false };
      const base = input.base ?? (sameAuthor(head.editor, editor) ? head.number : undefined);
      if (base === undefined) {
        throw new ArtifactError(`revision ${head.number} of artifact ${input.id} was written by ${authorText(head.editor)}; read its newest revision first, then write the whole document on top of it`, 409);
      }
      if (base !== head.number) {
        throw new ArtifactError(`revision ${head.number} (by ${authorText(head.editor)}) is newer than revision ${base} this write is based on; read the newest revision again and write the whole document on top of it`, 409);
      }
      if (head.number >= ARTIFACT_LIMITS.revisions) throw new ArtifactError(`at most ${ARTIFACT_LIMITS.revisions} revisions; start a new artifact`);
      const number = head.number + 1;
      this.db.prepare("INSERT INTO revisions (artifact, number, title, body, actions, provenance, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(input.id, number, title, input.body, actions, JSON.stringify(provenance), requestId, now);
      this.db.prepare("UPDATE artifacts SET head = ?, title = ?, updated_at = ? WHERE id = ?").run(number, title, now, input.id);
      return { revision: this.revision(input.id, number)!, created: false, unchanged: false, actionsKept: input.actions === undefined && head.actions.length > 0 };
    });
  }

  private row(id: string): Row | undefined {
    return isArtifactId(id) ? this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Row | undefined : undefined;
  }
  private summary(row: Row): ArtifactSummary {
    const counts = { draft: 0, queued: 0, delivered: 0, undeliverable: 0 };
    for (const comment of this.comments(String(row.id))) counts[comment.state]++;
    return { id: String(row.id), title: String(row.title), name: row.name === null ? null : String(row.name), author: parseAuthor(String(row.author)), projectId: row.project_id === null ? null : String(row.project_id),
      head: Number(row.head), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), comments: counts };
  }
  /** The artifact an author named so (the Claude Code mod's paths). */
  named(author: ArtifactAuthor, name: string): ArtifactSummary | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE author = ? AND name = ?").get(authorKey(author), name) as Row | undefined;
    return row ? this.summary(row) : null;
  }
  get(id: string): ArtifactSummary | null {
    const row = this.row(id);
    return row ? this.summary(row) : null;
  }
  /** Newest first; with `authors` (or `author`), only theirs and, with `project` too, every artifact of that project. */
  list(options: { author?: ArtifactAuthor; authors?: readonly ArtifactAuthor[]; project?: string | null; limit?: number } = {}): ArtifactSummary[] {
    const keys = options.authors ? options.authors.map(authorKey) : options.author ? [authorKey(options.author)] : null;
    const limit = options.limit ?? 200;
    if (!keys) return (this.db.prepare("SELECT * FROM artifacts ORDER BY updated_at DESC LIMIT ?").all(limit) as Row[]).map(row => this.summary(row));
    const clauses = [...keys.length ? [`author IN (${keys.map(() => "?").join(",")})`] : [], ...options.project ? ["project_id = ?"] : []];
    if (!clauses.length) return [];
    return (this.db.prepare(`SELECT * FROM artifacts WHERE ${clauses.join(" OR ")} ORDER BY updated_at DESC LIMIT ?`)
      .all(...keys, ...options.project ? [options.project] : [], limit) as Row[]).map(row => this.summary(row));
  }
  revision(id: string, number: number): Revision | null {
    if (!isArtifactId(id) || !Number.isSafeInteger(number)) return null;
    const row = this.db.prepare("SELECT * FROM revisions WHERE artifact = ? AND number = ?").get(id, number) as Row | undefined;
    if (!row) return null;
    const provenance = JSON.parse(String(row.provenance)) as Provenance;
    return { artifact: id, number, title: String(row.title), body: String(row.body), actions: JSON.parse(String(row.actions)) as ArtifactAction[],
      provenance, createdAt: Number(row.created_at), editor: editorOf(provenance) };
  }
  /** Every revision without its body, oldest first. */
  revisions(id: string): Array<Omit<Revision, "body" | "actions"> & { bytes: number; actions: number }> {
    return (this.db.prepare("SELECT number, title, length(CAST(body AS BLOB)) AS bytes, actions, provenance, created_at FROM revisions WHERE artifact = ? ORDER BY number").all(id) as Row[])
      .map(row => {
        const provenance = JSON.parse(String(row.provenance)) as Provenance;
        return { artifact: id, number: Number(row.number), title: String(row.title), bytes: Number(row.bytes),
          actions: (JSON.parse(String(row.actions)) as unknown[]).length, provenance, createdAt: Number(row.created_at), editor: editorOf(provenance) };
      });
  }

  comments(id: string): ArtifactComment[] {
    const rows = this.db.prepare(`SELECT c.*, b.state AS batch_state, b.note AS batch_note, b.delivered_at AS batch_delivered
      FROM comments c LEFT JOIN batches b ON b.id = c.batch WHERE c.artifact = ? ORDER BY c.created_at, c.rowid`).all(id) as Row[];
    return rows.map(row => ({
      id: String(row.id), artifact: id, revision: Number(row.revision), anchor: JSON.parse(String(row.anchor)) as Anchor, body: String(row.body),
      createdAt: Number(row.created_at), batch: row.batch === null ? null : String(row.batch),
      state: row.batch === null ? "draft" : String(row.batch_state) as CommentState,
      note: row.batch_note === null || row.batch_note === undefined ? null : String(row.batch_note),
      deliveredAt: row.batch_delivered === null || row.batch_delivered === undefined ? null : Number(row.batch_delivered),
    }));
  }

  /** A draft comment on a selection of one revision; nothing is sent until
   * the user sends the drafts. The same request id adds it once. */
  comment(id: string, input: { revision: unknown; anchor: unknown; body: unknown }, requestId: string): ArtifactComment {
    const artifact = this.row(id);
    if (!artifact) throw new ArtifactError("no such artifact", 404);
    if (typeof input.revision !== "number" || !this.revision(id, input.revision)) throw new ArtifactError("no such revision");
    const body = typeof input.body === "string" ? input.body.trim() : "";
    if (!body || body.length > ARTIFACT_LIMITS.comment) throw new ArtifactError(`a comment needs text of at most ${ARTIFACT_LIMITS.comment} characters`);
    const anchor = parseAnchor(input.anchor);
    if (!requestId || requestId.length > 200) throw new ArtifactError("a request id is required");
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT id FROM comments WHERE request_id = ?").get(requestId) as Row | undefined;
      if (!prior) {
        const drafts = (this.db.prepare("SELECT count(*) AS n FROM comments WHERE artifact = ? AND batch IS NULL").get(id) as { n: number }).n;
        if (drafts >= ARTIFACT_LIMITS.drafts) throw new ArtifactError(`at most ${ARTIFACT_LIMITS.drafts} unsent comments; send or delete some first`, 429);
        this.db.prepare("INSERT INTO comments (id, artifact, revision, anchor, body, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(randomUUID(), id, input.revision as number, JSON.stringify(anchor), body, requestId, Date.now());
      }
      const row = (prior ?? this.db.prepare("SELECT id FROM comments WHERE request_id = ?").get(requestId)) as Row;
      return this.comments(id).find(comment => comment.id === row.id)!;
    });
  }
  /** Deletes a draft; a comment already sent stays. */
  deleteDraft(id: string, comment: string): boolean {
    const result = this.db.prepare("DELETE FROM comments WHERE id = ? AND artifact = ? AND batch IS NULL").run(comment, id);
    return result.changes > 0;
  }

  /** Every draft of the artifact becomes one batch, its message fixed now,
   * so every delivery attempt sends the same text under the same request id.
   * The same request id finds the batch it made. */
  queue(id: string, requestId: string, hint: (artifact: ArtifactSummary) => string): CommentBatch | null {
    const artifact = this.row(id);
    if (!artifact) throw new ArtifactError("no such artifact", 404);
    if (!requestId || requestId.length > 200) throw new ArtifactError("a request id is required");
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT id FROM batches WHERE id = ?").get(batchId(requestId)) as Row | undefined;
      if (prior) return this.batch(String(prior.id));
      const drafts = this.comments(id).filter(comment => comment.state === "draft");
      if (!drafts.length) return null;
      const summary = this.summary(artifact);
      const idOf = batchId(requestId);
      // Comments go to the artifact's author whoever wrote its newest revision.
      const { editor } = this.revision(id, summary.head)!;
      this.db.prepare("INSERT INTO batches (id, artifact, request_id, text, target, state, note, created_at) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?)")
        .run(idOf, id, `artifact:${id}:comments:${idOf}`, commentMessage(summary, drafts, hint(summary), sameAuthor(editor, summary.author) ? undefined : editor),
          authorKey(summary.author), "waiting to be delivered", Date.now());
      const assign = this.db.prepare("UPDATE comments SET batch = ? WHERE id = ? AND batch IS NULL");
      for (const draft of drafts) assign.run(idOf, draft.id);
      return this.batch(idOf);
    });
  }
  batch(id: string): CommentBatch | null {
    const row = this.db.prepare("SELECT * FROM batches WHERE id = ?").get(id) as Row | undefined;
    return row ? batchOf(row) : null;
  }
  /** Batches still waiting for their author, oldest first. */
  queued(): CommentBatch[] {
    return (this.db.prepare("SELECT * FROM batches WHERE state = 'queued' ORDER BY created_at").all() as Row[]).map(batchOf);
  }
  settle(id: string, state: CommentBatch["state"], note: string | null): void {
    this.db.prepare("UPDATE batches SET state = ?, note = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END WHERE id = ? AND state = 'queued'")
      .run(state, note, state, Date.now(), id);
  }
  /** Updates why a queued batch still waits. */
  note(id: string, note: string): void {
    this.db.prepare("UPDATE batches SET note = ? WHERE id = ? AND state = 'queued'").run(note, id);
  }

  /** Starts an action run once per request id; a second run of an action
   * that already succeeded is refused. */
  beginAction(id: string, revision: number, action: string, requestId: string): { run: ActionRun; fresh: boolean } {
    return this.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM action_runs WHERE request_id = ?").get(requestId) as Row | undefined;
      if (prior) return { run: runOf(prior), fresh: false };
      const done = this.db.prepare("SELECT * FROM action_runs WHERE artifact = ? AND action = ? AND state IN ('running', 'succeeded') ORDER BY created_at DESC").get(id, action) as Row | undefined;
      if (done) throw new ArtifactError(done.state === "running" ? "this action is already running" : `this action already ran: ${String(done.detail)}`, 409);
      const run = { id: randomUUID(), artifact: id, revision, action, requestId, state: "running" as const, detail: "started", createdAt: Date.now() };
      this.db.prepare("INSERT INTO action_runs (id, artifact, revision, action, request_id, state, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(run.id, id, revision, action, requestId, run.state, run.detail, run.createdAt);
      return { run, fresh: true };
    });
  }
  /** Records a running run's outcome and, in the same transaction, the
   * notices that tell it: a restart finds both or neither. */
  finishAction(run: string, state: "succeeded" | "failed", detail: string): void {
    this.transaction(() => this.finish(run, state, detail));
  }
  /** `unknown` is kept as failed (a new try is allowed) and told as unknown. */
  private finish(run: string, state: "succeeded" | "failed" | "unknown", detail: string): void {
    const updated = this.db.prepare("UPDATE action_runs SET state = ?, detail = ? WHERE id = ? AND state = 'running'").run(state === "unknown" ? "failed" : state, detail.slice(0, 2000), run);
    if (!updated.changes) return;
    const finished = runOf(this.db.prepare("SELECT * FROM action_runs WHERE id = ?").get(run) as Row);
    const artifact = this.summary(this.row(finished.artifact)!);
    const action = this.revision(finished.artifact, finished.revision)?.actions.find(candidate => candidate.id === finished.action) ?? null;
    const targets: NoticeTarget[] = artifact.author.kind === "optchat" ? [artifact.author] : [artifact.author, { kind: "starter", thread: artifact.author.thread }];
    const insert = this.db.prepare("INSERT OR IGNORE INTO notices (id, artifact, run, target, request_id, text, state, note, created_at) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)");
    for (const target of targets) {
      const key = targetKey(target);
      // A report to OptChat, not a message of the user: it renews no thread's tells.
      insert.run(randomUUID(), artifact.id, run, key, `report:artifact:${artifact.id}:action:${run}:${key}`,
        actionMessage(artifact, action, { action: finished.action, revision: finished.revision, state, detail: finished.detail }, target), "waiting to be delivered", Date.now());
    }
  }
  actionRuns(id: string): ActionRun[] {
    return (this.db.prepare("SELECT * FROM action_runs WHERE artifact = ? ORDER BY created_at").all(id) as Row[]).map(runOf);
  }
  /** Runs a process stop left unfinished: their outcome is unknown, and is told so. */
  interruptedActions(): void {
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT id FROM action_runs WHERE state = 'running'").all() as Row[]) {
        this.finish(String(row.id), "unknown", "cubed stopped while this ran, so whether GitHub merged it is unknown; check the pull request on GitHub before trying again");
      }
    });
  }

  /** The notices of an artifact's runs, oldest first. */
  notices(id: string): ActionNotice[] {
    return (this.db.prepare("SELECT * FROM notices WHERE artifact = ? ORDER BY created_at, rowid").all(id) as Row[]).map(noticeOf);
  }
  /** Notices still waiting, oldest first. */
  queuedNotices(): ActionNotice[] {
    return (this.db.prepare("SELECT * FROM notices WHERE state = 'queued' ORDER BY created_at, rowid").all() as Row[]).map(noticeOf);
  }
  settleNotice(id: string, state: Exclude<ActionNotice["state"], "queued">, note: string | null): void {
    this.db.prepare("UPDATE notices SET state = ?, note = ?, delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END WHERE id = ? AND state = 'queued'")
      .run(state, note, state, Date.now(), id);
  }
  /** Updates why a queued notice still waits. */
  noteNotice(id: string, note: string): void {
    this.db.prepare("UPDATE notices SET note = ? WHERE id = ? AND state = 'queued'").run(note, id);
  }
}

const batchId = (requestId: string) => createHash("sha256").update(requestId).digest("hex").slice(0, 24);
const batchOf = (row: Row): CommentBatch => ({
  id: String(row.id), artifact: String(row.artifact), requestId: String(row.request_id), text: String(row.text), target: parseAuthor(String(row.target)),
  state: String(row.state) as CommentBatch["state"], note: row.note === null ? null : String(row.note), createdAt: Number(row.created_at),
  deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
});
const noticeOf = (row: Row): ActionNotice => ({
  id: String(row.id), artifact: String(row.artifact), run: String(row.run), requestId: String(row.request_id), text: String(row.text), target: parseTarget(String(row.target)),
  state: String(row.state) as ActionNotice["state"], note: row.note === null ? null : String(row.note), createdAt: Number(row.created_at),
  deliveredAt: row.delivered_at === null ? null : Number(row.delivered_at),
});
const runOf = (row: Row): ActionRun => ({
  id: String(row.id), artifact: String(row.artifact), revision: Number(row.revision), action: String(row.action), requestId: String(row.request_id),
  state: String(row.state) as ActionRun["state"], detail: String(row.detail), createdAt: Number(row.created_at),
});

function parseAnchor(raw: unknown): Anchor {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ArtifactError("a comment needs the selected text");
  const record = raw as Record<string, unknown>;
  const string = (key: string, max: number, required = false) => {
    const value = record[key] ?? "";
    if (typeof value !== "string" || value.length > max || (required && !value.trim())) throw new ArtifactError(`anchor ${key} must be text of at most ${max} characters`);
    return value;
  };
  const quote = string("quote", ARTIFACT_LIMITS.quote, true);
  const start = record.start, end = record.end;
  if (typeof start !== "number" || typeof end !== "number" || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end - start !== quote.length) {
    throw new ArtifactError("anchor start and end must be offsets in the revision's text");
  }
  return { quote, prefix: string("prefix", ARTIFACT_LIMITS.context), suffix: string("suffix", ARTIFACT_LIMITS.context), start, end, section: string("section", ARTIFACT_LIMITS.section) };
}
