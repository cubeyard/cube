/** Claude Code as a thread agent, for one purpose: to use the person's own
 * Claude Max subscription through the unmodified `claude` binary and its own
 * login. cubed starts `claude -p` with stream-json on stdin and stdout and
 * cube's mod (packages/claude-mod), which sends Bash, Read, Write and Edit to
 * the thread Workspace keyed by tool_use_id.
 *
 * cubed never stores or forwards Claude credentials, and starts the child
 * without ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN so the subscription is
 * used, not API billing. Durability is weaker than Pi's: Claude Code keeps
 * its own session (resumed with --resume) but has no task checkpoints, so a
 * turn cut off by a cubed restart is not continued. Workspace keys still
 * keep the runner from executing any tool call twice.
 *
 * What cubed keeps is the thread record only: prompts by request id, the
 * messages Claude Code printed, and its session id. */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import type { ModelSelection } from "./models.ts";
import type { Workspace, WorkspaceLease } from "./workspace.ts";

export const CLAUDE_PROVIDER = "claude-code";
/** Claude Code's own model aliases; it resolves them to current models. */
export const CLAUDE_MODELS: readonly ModelSelection[] = ["opus", "sonnet", "haiku"].map(id => ({ provider: CLAUDE_PROVIDER, id }));
/** Credentials that would bill the API instead of the subscription. */
export const CLAUDE_REMOVED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;
const INTERRUPTED = "cubed stopped during this turn; claude code does not continue an interrupted turn — send a message to go on";

export interface ClaudeRuntime {
  /** The argv that starts the `claude` binary (tests use a fake). */
  command: readonly string[];
  /** cube's mod, loaded with --plugin-dir. */
  mod: string;
  /** cubed's workspace socket, which serves only workspace routes. */
  socket: string;
  /** Close an idle child after this long; the next prompt resumes it. */
  idleMs?: number;
  /** How long a stop waits for Claude Code to end the turn before killing it. */
  stopGraceMs?: number;
}

export interface ClaudeSubmission {
  seq: number; requestId: string; text: string;
  state: "running" | "completed" | "failed" | "stopped"; error: string | null;
}
export interface ClaudeMessage { seq: number; submission: number; data: Record<string, unknown> }
/** The newest assistant message while it streams, by content block index. */
export type ClaudePartial = Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string } | { type: "tool_use"; id: string; name: string; json: string }>;
export interface ClaudeState { submissions: ClaudeSubmission[]; messages: ClaudeMessage[]; partial: ClaudePartial }

export class ClaudeBusy extends Error {}

export class ClaudeAgent {
  readonly threadId: string;
  private readonly db: DatabaseSync;
  private readonly workspace: Workspace;
  private readonly lease: WorkspaceLease;
  private readonly runtime: ClaudeRuntime;
  private readonly cwd: string;
  private readonly submissions: ClaudeSubmission[];
  private readonly messages: ClaudeMessage[];
  private partial: ClaudePartial = [];
  private child: { process: ChildProcessWithoutNullStreams; exited: Promise<void>; stderr: string[] } | undefined;
  private interrupt: { timer: NodeJS.Timeout } | undefined;
  private idle: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<() => void>();
  private closing = false;
  private closedResolve!: () => void;
  /** Settles when the agent closes. */
  readonly closed = new Promise<void>(resolve => { this.closedResolve = resolve; });

  private constructor(options: { threadId: string; db: DatabaseSync; workspace: Workspace; lease: WorkspaceLease; runtime: ClaudeRuntime; cwd: string }) {
    this.threadId = options.threadId; this.db = options.db; this.workspace = options.workspace;
    this.lease = options.lease; this.runtime = options.runtime; this.cwd = options.cwd;
    this.submissions = (this.db.prepare("SELECT seq, request_id AS requestId, text, state, error FROM submission ORDER BY seq").all() as unknown as ClaudeSubmission[]);
    this.messages = (this.db.prepare("SELECT seq, submission, data FROM message ORDER BY seq").all() as Array<{ seq: number; submission: number; data: string }>)
      .map(row => ({ seq: row.seq, submission: row.submission, data: JSON.parse(row.data) as Record<string, unknown> }));
  }

  /** Takes the thread's `claude-code` lease for the agent's lifetime: the
   * one writable owner. The token goes to the child's mod and nowhere else. */
  static async open(options: { directory: string; threadId: string; workspace: Workspace; runtime: ClaudeRuntime; model: string }): Promise<ClaudeAgent> {
    const lease = await options.workspace.lease({ owner: "claude-code" });
    let db: DatabaseSync | undefined;
    try {
      fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
      // Claude Code keys its sessions by working directory: keep it stable.
      const cwd = path.join(options.directory, "claude");
      fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
      db = new DatabaseSync(path.join(options.directory, "claude.sqlite"), { timeout: 5000 });
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS submission(seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, text TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('running','completed','failed','stopped')), error TEXT, created_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS message(seq INTEGER PRIMARY KEY AUTOINCREMENT, submission INTEGER NOT NULL REFERENCES submission(seq), data TEXT NOT NULL);`);
      db.prepare("INSERT OR IGNORE INTO meta VALUES ('model', ?)").run(options.model);
      // A turn that was running when cubed stopped is over: Claude Code has
      // no checkpoint to continue it from.
      db.prepare("UPDATE submission SET state='failed', error=? WHERE state='running'").run(INTERRUPTED);
      return new ClaudeAgent({ threadId: options.threadId, db, workspace: options.workspace, lease, runtime: options.runtime, cwd });
    } catch (error) {
      db?.close();
      await options.workspace.release(lease.token).catch(() => {});
      throw error;
    }
  }

  get model(): string { return this.meta("model")!; }
  get sessionId(): string | null { return this.meta("session"); }
  get running(): boolean { return this.submissions.at(-1)?.state === "running"; }
  state(): ClaudeState { return { submissions: [...this.submissions], messages: [...this.messages], partial: this.partial.map(block => ({ ...block })) }; }
  /** Called after every change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Accept a prompt once per request id. A different text under a seen
   * request id is a conflict; a prompt while a turn runs is refused. */
  async submit(requestId: string, text: string): Promise<void> {
    if (this.closing) throw new Error("host is stopping");
    const prior = this.submissions.find(submission => submission.requestId === requestId);
    if (prior) {
      if (prior.text !== text) throw new Error("message request conflicts with the previous request");
      return;
    }
    if (this.running) throw new ClaudeBusy("thread is already working");
    const child = this.spawn();
    const seq = Number(this.db.prepare("INSERT INTO submission(request_id, text, state, created_at) VALUES (?, ?, 'running', ?)").run(requestId, text, Date.now()).lastInsertRowid);
    this.submissions.push({ seq, requestId, text, state: "running", error: null });
    clearTimeout(this.idle);
    this.write(child.process, { type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text }] } });
    this.changed();
  }

  /** Stop is an interrupt; a child that does not end the turn in time is killed. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!this.running || !child || this.interrupt) return;
    this.write(child.process, { type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
    const timer = setTimeout(() => { if (this.child === child) child.process.kill("SIGTERM"); }, this.runtime.stopGraceMs ?? 10000);
    timer.unref();
    this.interrupt = { timer };
  }

  /** The model for the next turn: an idle child is closed and the next
   * prompt resumes the session with --model. */
  async setModel(model: string): Promise<void> {
    if (!CLAUDE_MODELS.some(candidate => candidate.id === model)) throw new Error("model unavailable");
    if (this.running) throw new Error("wait for the current run before changing model");
    this.db.prepare("UPDATE meta SET value=? WHERE key='model'").run(model);
    await this.endChild();
    this.changed();
  }

  async close(): Promise<void> {
    if (this.closing) return this.closed;
    this.closing = true;
    clearTimeout(this.idle);
    await this.endChild();
    this.settle("failed", INTERRUPTED);
    await this.workspace.release(this.lease.token).catch(() => {});
    this.db.close();
    this.listeners.clear();
    this.closedResolve();
  }

  private meta(key: string): string | null {
    return (this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value ?? null;
  }

  private spawn(): NonNullable<ClaudeAgent["child"]> {
    if (this.child) return this.child;
    const session = this.sessionId;
    const [command, ...prefix] = this.runtime.command;
    const env: NodeJS.ProcessEnv = { ...process.env,
      CUBE_WORKSPACE_SOCKET: this.runtime.socket,
      CUBE_WORKSPACE_PATH: `/api/threads/${encodeURIComponent(this.threadId)}/workspace`,
      CUBE_WORKSPACE_TOKEN: this.lease.token,
      CUBE_WORKSPACE_ROOT: this.cwd };
    for (const name of CLAUDE_REMOVED_ENV) delete env[name];
    const child = spawn(command!, [...prefix,
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--plugin-dir", this.runtime.mod, "--model", this.model, ...(session ? ["--resume", session] : [])],
      { cwd: this.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const stderr: string[] = [];
    child.once("error", error => stderr.push(error.message));
    const exited = new Promise<void>(resolve => { child.once("close", () => resolve()); child.once("error", () => resolve()); });
    const current = { process: child, exited, stderr };
    this.child = current;
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr.push(chunk); while (stderr.join("").length > 4096) stderr.shift(); });
    createInterface({ input: child.stdout }).on("line", line => this.receive(line));
    void exited.then(() => {
      if (this.child !== current) return;
      this.child = undefined;
      this.partial = [];
      const detail = stderr.join("").trim().split("\n").slice(-3).join(" ").trim();
      if (this.closing) this.settle("failed", INTERRUPTED);
      else if (this.interrupt) this.settle("stopped", null);
      else this.settle("failed", `claude code exited${child.exitCode === null ? "" : ` (${child.exitCode})`}${detail ? `: ${detail}` : ""}`);
      this.changed();
    });
    return current;
  }

  private receive(line: string): void {
    if (this.closing || !line.trim()) return;
    let data: Record<string, unknown>;
    try { data = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (data.type === "control_response" || data.type === "keep_alive") return;
    if (data.type === "stream_event") { if (data.parent_tool_use_id == null) this.stream(data.event as StreamEvent); return; }
    if (data.type === "system" && data.subtype === "init" && typeof data.session_id === "string") {
      this.db.prepare("INSERT INTO meta VALUES ('session', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(data.session_id);
    }
    const current = this.submissions.at(-1);
    if (current) {
      const seq = Number(this.db.prepare("INSERT INTO message(submission, data) VALUES (?, ?)").run(current.seq, line).lastInsertRowid);
      this.messages.push({ seq, submission: current.seq, data });
    }
    if (data.type === "assistant" && data.parent_tool_use_id == null) this.partial = [];
    if (data.type === "result" && this.running) {
      const failed = data.is_error === true || data.subtype !== "success";
      const detail = typeof data.result === "string" && data.result ? data.result
        : Array.isArray(data.errors) && data.errors.length ? data.errors.map(String).join("; ") : String(data.subtype ?? "claude code reported an error");
      this.settle(this.interrupt ? "stopped" : failed ? "failed" : "completed", this.interrupt || !failed ? null : detail);
      this.partial = [];
      this.scheduleIdle();
    }
    this.changed();
  }

  private stream(event: StreamEvent | undefined): void {
    if (!event) return;
    if (event.type === "message_start") this.partial = [];
    else if (event.type === "content_block_start") {
      const block = event.content_block;
      if (block?.type === "text") this.partial[event.index] = { type: "text", text: block.text ?? "" };
      else if (block?.type === "thinking") this.partial[event.index] = { type: "thinking", thinking: block.thinking ?? "" };
      else if (block?.type === "tool_use") this.partial[event.index] = { type: "tool_use", id: block.id ?? "", name: block.name ?? "", json: "" };
    } else if (event.type === "content_block_delta") {
      const block = this.partial[event.index];
      const delta = event.delta;
      if (block?.type === "text" && delta?.type === "text_delta") block.text += delta.text ?? "";
      else if (block?.type === "thinking" && delta?.type === "thinking_delta") block.thinking += delta.thinking ?? "";
      else if (block?.type === "tool_use" && delta?.type === "input_json_delta") block.json += delta.partial_json ?? "";
      else return;
    } else return;
    this.changed();
  }

  private settle(state: Exclude<ClaudeSubmission["state"], "running">, error: string | null): void {
    const current = this.submissions.at(-1);
    if (!current || current.state !== "running") return;
    this.db.prepare("UPDATE submission SET state=?, error=? WHERE seq=?").run(state, error, current.seq);
    current.state = state; current.error = error;
    if (this.interrupt) { clearTimeout(this.interrupt.timer); this.interrupt = undefined; }
  }

  private scheduleIdle(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => { if (!this.running) void this.endChild(); }, this.runtime.idleMs ?? 10 * 60_000);
    this.idle.unref();
  }

  /** End the child: close stdin, then terminate if it lingers. */
  private async endChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    child.process.stdin.end();
    const kill = setTimeout(() => child.process.kill("SIGTERM"), 2000);
    const force = setTimeout(() => child.process.kill("SIGKILL"), 7000);
    try { await child.exited; } finally { clearTimeout(kill); clearTimeout(force); }
  }

  private write(child: ChildProcessWithoutNullStreams, message: unknown): void {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private changed(): void {
    for (const listener of this.listeners) {
      try { listener(); } catch { /* a listener failure does not stop the agent */ }
    }
  }
}

type StreamEvent = {
  type: string; index: number;
  content_block?: { type: string; text?: string; thinking?: string; id?: string; name?: string };
  delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
};
