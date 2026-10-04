/** Claude Code as a thread agent, for one purpose: to use the person's own
 * Claude Max subscription through the unmodified `claude` binary and its own
 * login. cubed starts `claude -p` with stream-json on stdin and stdout and
 * cube's mod (packages/claude-mod), which sends Bash, Read, Write and Edit to
 * the thread Workspace keyed by tool_use_id.
 *
 * cubed never stores Claude credentials. The child gets an allow-listed
 * environment: no API key, auth token, base URL or Bedrock/Vertex switch, so
 * the subscription is used, not API billing, and none of cubed's provider,
 * Git or cloud credentials. Claude Code's own login is read from its config
 * directory (or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`). The user's
 * settings files and MCP servers are not loaded, and only the mod's allowed
 * tools are offered. Durability is weaker than Pi's: Claude Code keeps
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
import { ALLOWED_TOOLS } from "../../claude-mod/hooks/tools.ts";
import type { ModelSelection } from "./models.ts";
import type { Workspace, WorkspaceLease } from "./workspace.ts";

export const CLAUDE_PROVIDER = "claude-code";
/** Claude Code's own model aliases; it resolves them to current models. */
export const CLAUDE_MODELS: readonly ModelSelection[] = ["opus", "sonnet", "haiku"].map(id => ({ provider: CLAUDE_PROVIDER, id }));
/** The only variables the child inherits from cubed: locale, home and
 * config, proxies and certificates, and Claude Code's own login token. */
const CLAUDE_ENV = /^(HOME|PATH|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TERM|TZ|TMPDIR|XDG_[A-Z_]+|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/;
/** Never passed, not even from ClaudeRuntime.env: each would bill the API or
 * another provider instead of the subscription. */
export const CLAUDE_REMOVED_ENV = /^(ANTHROPIC_[A-Z_]+|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY))$/;
/** What a stop waits after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5000;
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
  /** Extra variables for the child (tests). */
  env?: Readonly<Record<string, string>>;
}

/** The child's environment: the allow-list, the runtime's extras and the
 * cube workspace, never a credential that moves billing. */
export function claudeEnvironment(source: NodeJS.ProcessEnv, extra: Readonly<Record<string, string>>, workspace: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) if (value !== undefined && CLAUDE_ENV.test(name)) env[name] = value;
  Object.assign(env, extra);
  for (const name of Object.keys(env)) if (CLAUDE_REMOVED_ENV.test(name)) delete env[name];
  return { ...env, ...workspace };
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
  private interrupt: { timer: NodeJS.Timeout; kill?: NodeJS.Timeout } | undefined;
  /** Bash calls Claude Code started whose results have not come back, by
   * tool_use_id: the mod runs each as `claude:<id>:bash` on the runner. */
  private readonly commands = new Set<string>();
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
      // no checkpoint to continue it from, so its open runner commands are
      // cancelled too rather than left to finish unseen.
      const interrupted = new Set((db.prepare("SELECT seq FROM submission WHERE state='running'").all() as Array<{ seq: number }>).map(row => row.seq));
      db.prepare("UPDATE submission SET state='failed', error=? WHERE state='running'").run(INTERRUPTED);
      const agent = new ClaudeAgent({ threadId: options.threadId, db, workspace: options.workspace, lease, runtime: options.runtime, cwd });
      for (const message of agent.messages) if (interrupted.has(message.submission)) agent.track(message.data);
      await agent.cancelCommands();
      return agent;
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
    // Claude Code answers an interrupt by rejecting the running tool use
    // without aborting the mod's hook, so the runner command would run on.
    // cubed cancels it itself; the runner admits one command at a time.
    void this.cancelCommands();
    // A child that ignores the interrupt is killed (and cancelled again).
    const interrupt: NonNullable<ClaudeAgent["interrupt"]> = { timer: setTimeout(() => {
      if (this.child !== child) return;
      void this.cancelCommands();
      child.process.kill("SIGTERM");
      interrupt.kill = setTimeout(() => { if (child.process.exitCode === null && child.process.signalCode === null) child.process.kill("SIGKILL"); }, KILL_GRACE_MS);
      interrupt.kill.unref();
    }, this.runtime.stopGraceMs ?? 10000) };
    interrupt.timer.unref();
    this.interrupt = interrupt;
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
    // Claude Code does not continue a turn cut off here: its runner
    // commands are cancelled before the lease goes.
    await this.cancelCommands();
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
    const env = claudeEnvironment(process.env, this.runtime.env ?? {}, {
      CUBE_WORKSPACE_SOCKET: this.runtime.socket,
      CUBE_WORKSPACE_PATH: `/api/threads/${encodeURIComponent(this.threadId)}/workspace`,
      CUBE_WORKSPACE_TOKEN: this.lease.token,
      CUBE_WORKSPACE_ROOT: this.cwd });
    const child = spawn(command!, [...prefix,
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      // Only cube's mod: no user or project settings (their hooks), no MCP
      // servers, and only the tools the mod allows.
      "--setting-sources", "", "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }), "--tools", ALLOWED_TOOLS.join(","),
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
      // A child that died mid-turn leaves its commands to cubed.
      void this.cancelCommands();
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
    this.track(data);
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
      else if (block?.type === "tool_use") {
        this.partial[event.index] = { type: "tool_use", id: block.id ?? "", name: block.name ?? "", json: "" };
        if (block.name === "Bash" && block.id) this.commands.add(block.id);
      }
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

  /** Follow Bash calls from Claude Code's messages, subagents' included:
   * a tool_use opens one, its tool_result closes it, a turn's result ends all. */
  private track(data: Record<string, unknown>): void {
    if (data.type === "result") { this.commands.clear(); return; }
    const content = (data.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<{ type?: string; id?: string; name?: string; tool_use_id?: string }>) {
      if (data.type === "assistant" && block.type === "tool_use" && block.name === "Bash" && block.id) this.commands.add(block.id);
      if (data.type === "user" && block.type === "tool_result" && block.tool_use_id) this.commands.delete(block.tool_use_id);
    }
  }

  /** Cancel the runner commands of Bash calls still open. A key the runner
   * never saw, or one already finished, is no harm. */
  private async cancelCommands(): Promise<void> {
    const ids = [...this.commands];
    this.commands.clear();
    await Promise.all(ids.map(id => this.workspace.cancel(this.lease.token, `claude:${id}:bash`).catch(() => {})));
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
