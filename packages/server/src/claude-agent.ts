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
 * keep the thread machine from executing any tool call twice.
 *
 * What cubed keeps is the thread record only: prompts by request id, the
 * messages Claude Code printed, its session id and the background agents a
 * turn left running.
 *
 * A background agent (the Agent tool runs in the background by default) goes
 * on after its turn's result. While one runs the child stays open, past the
 * idle close, for at most `backgroundMs`; when it finishes Claude Code takes
 * a turn of its own, which cubed records as a run (`cube:background:<task>`).
 * Background work that can no longer finish (the child ended, cubed stopped,
 * the time ran out) is recorded as a failed run (`…:lost`), so a thread's
 * watchers hear of it once instead of waiting for a turn that never comes. */
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
export const CLAUDE_MODELS: readonly ModelSelection[] = ["fable", "opus", "sonnet", "haiku"].map(id => ({ provider: CLAUDE_PROVIDER, id }));
/** The only variables the child inherits from cubed: locale, home and
 * config, proxies and certificates, and Claude Code's own login token. */
const CLAUDE_ENV = /^(HOME|PATH|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_[A-Z_]+|TERM|TZ|TMPDIR|XDG_[A-Z_]+|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/;
/** Never passed, not even from ClaudeRuntime.env: each would bill the API or
 * another provider instead of the subscription. */
export const CLAUDE_REMOVED_ENV = /^(ANTHROPIC_[A-Z_]+|CLAUDE_CODE_USE_(BEDROCK|VERTEX|FOUNDRY))$/;
/** What a stop waits after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5000;
const INTERRUPTED = "cubed stopped during this turn; claude code does not continue an interrupted turn — send a message to go on";
/** How long background agents may run after their turn before cubed ends
 * Claude Code, and them with it: unattended work never waits forever. */
export const BACKGROUND_MS = 4 * 60 * 60_000;
/** How long a finished background agent's follow-up turn may take to start. */
const CONTINUE_GRACE_MS = 2 * 60_000;
/** Why background agents are lost when cubed closes the agent. */
const CLOSED = "cubed closed claude code while it ran (cubed stopped or restarted, or the thread was archived)";

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
  /** How long background agents may run after their turn (BACKGROUND_MS). */
  backgroundMs?: number;
  /** How long a finished background agent's follow-up turn may take to start. */
  continueGraceMs?: number;
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
/** `waiting`: the background agents running now, by description. */
export interface ClaudeState { submissions: ClaudeSubmission[]; messages: ClaudeMessage[]; partial: ClaudePartial; waiting: string[] }

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
   * tool_use_id: the mod runs each as `claude:<id>:bash` in the thread VM. */
  private readonly commands = new Set<string>();
  /** The top-level tasks Claude Code started (by task_id), and the background
   * ones still running, which the thread is not done with. */
  private readonly tasks = new Map<string, string>();
  /** Agent tool calls by tool_use_id: only an agent's task is waited for. */
  private readonly agentCalls = new Set<string>();
  private readonly background = new Map<string, string>();
  private deadline: NodeJS.Timeout | undefined;
  private grace: NodeJS.Timeout | undefined;
  /** When the child last printed a line of the main conversation. */
  private heard = 0;
  /** Why cubed ends a child that still runs background agents. */
  private ending: { state: "failed" | "stopped"; reason: string } | undefined;
  private idle: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<() => void>();
  private closing = false;
  private closedResolve!: () => void;
  /** Settles when the agent closes. */
  readonly closed = new Promise<void>(resolve => { this.closedResolve = resolve; });

  private constructor(options: { threadId: string; db: DatabaseSync; workspace: Workspace; lease: WorkspaceLease; runtime: ClaudeRuntime; cwd: string }) {
    this.threadId = options.threadId; this.db = options.db; this.workspace = options.workspace;
    this.lease = options.lease; this.runtime = options.runtime; this.cwd = options.cwd;
    ({ submissions: this.submissions, messages: this.messages } = record(this.db));
  }

  /** The thread record from a thread directory alone, through a read-only
   * connection, without the agent or its lease; null when there is none. A
   * turn it shows as running runs only while the agent is open: an open
   * marks it failed. */
  static stored(directory: string): ClaudeState | null {
    const file = path.join(directory, "claude.sqlite");
    if (!fs.existsSync(file)) return null;
    const db = new DatabaseSync(file, { readOnly: true, timeout: 5000 });
    try { return { ...record(db), partial: [], waiting: storedBackground(db).map(row => row.description) }; }
    finally { db.close(); }
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
        CREATE TABLE IF NOT EXISTS message(seq INTEGER PRIMARY KEY AUTOINCREMENT, submission INTEGER NOT NULL REFERENCES submission(seq), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS background(task_id TEXT PRIMARY KEY, submission INTEGER NOT NULL REFERENCES submission(seq), description TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('running','ended','lost')), detail TEXT, started_at INTEGER NOT NULL, ended_at INTEGER);`);
      db.prepare("INSERT OR IGNORE INTO meta VALUES ('model', ?)").run(options.model);
      // A turn that was running when cubed stopped is over: Claude Code has
      // no checkpoint to continue it from, so its open guest commands are
      // cancelled too rather than left to finish unseen.
      const interrupted = new Set((db.prepare("SELECT seq FROM submission WHERE state='running'").all() as Array<{ seq: number }>).map(row => row.seq));
      db.prepare("UPDATE submission SET state='failed', error=? WHERE state='running'").run(INTERRUPTED);
      const agent = new ClaudeAgent({ threadId: options.threadId, db, workspace: options.workspace, lease, runtime: options.runtime, cwd });
      for (const message of agent.messages) if (interrupted.has(message.submission)) agent.track(message.data);
      // Background agents ran in a child that ended with the cubed before.
      agent.lose(CLOSED);
      await agent.cancelCommands();
      return agent;
    } catch (error) {
      db?.close();
      await options.workspace.release(lease.token).catch(() => {});
      throw error;
    }
  }

  /** The host directory Claude Code runs in; its tools address the
   * workspace through it. */
  get root(): string { return this.cwd; }
  get model(): string { return this.meta("model")!; }
  get sessionId(): string | null { return this.meta("session"); }
  get running(): boolean { return this.submissions.at(-1)?.state === "running"; }
  /** The background agents running now, by description: no turn runs, but
   * the thread is not done with them. */
  get waiting(): string[] { return [...this.background.values()]; }
  state(): ClaudeState { return { submissions: [...this.submissions], messages: [...this.messages], partial: this.partial.map(block => ({ ...block })), waiting: this.waiting }; }
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
    // Between turns, stop ends the background agents: Claude Code ends them
    // with the child, and they are recorded as stopped.
    if (!this.running && child && this.background.size) {
      this.ending = { state: "stopped", reason: "stopped in cube" };
      await this.endChild();
      return;
    }
    if (!this.running || !child || this.interrupt) return;
    this.write(child.process, { type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
    // Claude Code answers an interrupt by rejecting the running tool use
    // without aborting the mod's hook, so the guest command would run on.
    // cubed cancels it itself.
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
    // A new model needs a new child, which would end the background agents.
    if (this.background.size) throw new Error("wait for the thread's background agents, or stop them, before changing model");
    this.db.prepare("UPDATE meta SET value=? WHERE key='model'").run(model);
    await this.endChild();
    this.changed();
  }

  async close(): Promise<void> {
    if (this.closing) return this.closed;
    this.closing = true;
    clearTimeout(this.idle); clearTimeout(this.deadline); clearTimeout(this.grace);
    // Claude Code does not continue a turn cut off here: its guest
    // commands are cancelled before the lease goes.
    await this.cancelCommands();
    await this.endChild();
    this.settle("failed", INTERRUPTED);
    this.lose(CLOSED);
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
      CUBE_WORKSPACE_ROOT: this.cwd,
      // The same directory as the kernel names it (Claude Code's own cwd)
      // when the state path has a symlink in it.
      CUBE_WORKSPACE_REAL_ROOT: fs.realpathSync(this.cwd) });
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
      const exit = `claude code exited${child.exitCode === null ? "" : ` (${child.exitCode})`}${detail ? `: ${detail}` : ""}`;
      const ending = this.ending;
      this.ending = undefined;
      if (this.closing) this.settle("failed", INTERRUPTED);
      else if (this.interrupt || ending?.state === "stopped") this.settle("stopped", null);
      else this.settle("failed", ending?.reason ?? exit);
      // Claude Code's background agents end with it.
      this.lose(ending?.reason ?? (this.closing ? CLOSED : exit), ending?.state);
      this.changed();
    });
    return current;
  }

  private receive(line: string): void {
    if (this.closing || !line.trim()) return;
    let data: Record<string, unknown>;
    try { data = JSON.parse(line) as Record<string, unknown>; } catch { return; }
    if (data.type === "control_response" || data.type === "keep_alive") return;
    // A turn nobody sent (Claude Code going on after a background agent's
    // notification) is a run of its own.
    const main = data.parent_tool_use_id == null;
    if (main && (data.type === "assistant" || data.type === "stream_event" || data.type === "result")) this.heard = Date.now();
    if (main && !this.running && (data.type === "assistant" || (data.type === "stream_event" && (data.event as StreamEvent | undefined)?.type === "message_start"))) {
      this.continued(`cube:continued:${randomUUID()}`, "cube: claude code went on by itself", this.heard);
    }
    if (data.type === "stream_event") { if (main) this.stream(data.event as StreamEvent); return; }
    if (data.type === "system") this.task(data);
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
      this.armDeadline();
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
    clearTimeout(this.grace);
  }

  /** A run nobody sent: Claude Code going on by itself. `since`: when its
   * turn showed (now, for a notification whose turn has yet to show). */
  private continued(requestId: string, text: string, since = Date.now()): void {
    if (this.running || this.submissions.some(submission => submission.requestId === requestId)) return;
    const seq = Number(this.db.prepare("INSERT INTO submission(request_id, text, state, created_at) VALUES (?, ?, 'running', ?)").run(requestId, text, Date.now()).lastInsertRowid);
    this.submissions.push({ seq, requestId, text, state: "running", error: null });
    clearTimeout(this.idle);
    this.armGrace(since);
  }

  /** Claude Code's task messages: a backgrounded top-level task is waited
   * for; its notification ends the wait and, between turns, starts the run
   * of the turn Claude Code takes for it. Subagents' own tasks report to
   * their agent, not to the thread. */
  private task(data: Record<string, unknown>): void {
    const id = typeof data.task_id === "string" ? data.task_id : null;
    if (!id) return;
    if (data.subtype === "task_started") {
      if (data.owned_by_subagent || data.parent_task_id || data.ambient) return;
      const description = [data.description, data.subagent_type, data.task_type].find(value => typeof value === "string" && value.trim()) as string | undefined;
      this.tasks.set(id, description?.trim() ?? "task");
      // Only an agent's task: other kinds (monitors, shells) may never notify.
      const agent = data.task_type === "local_agent" || (typeof data.tool_use_id === "string" && this.agentCalls.has(data.tool_use_id));
      if (!agent) { this.tasks.delete(id); return; }
      if (data.is_backgrounded === true) this.wait(id);
    } else if (data.subtype === "task_updated") {
      const patch = data.patch as { is_backgrounded?: unknown; description?: unknown } | undefined;
      if (!this.tasks.has(id)) return;
      if (typeof patch?.description === "string" && patch.description.trim()) this.tasks.set(id, patch.description.trim());
      if (patch?.is_backgrounded === true) this.wait(id);
    } else if (data.subtype === "task_notification") {
      const description = this.background.get(id);
      if (description === undefined) return;
      this.background.delete(id);
      this.tasks.delete(id);
      const detail = [data.status, data.summary].filter(value => typeof value === "string" && value).join(": ");
      this.db.prepare("UPDATE background SET state='ended', detail=?, ended_at=? WHERE task_id=?").run(detail || null, Date.now(), id);
      this.armDeadline();
      if (this.running || !this.child) return;
      // Claude Code takes a turn for the notification; a prompt is refused
      // meanwhile, as during any turn.
      this.continued(`cube:background:${id}`, `cube: ${agents([description])} finished; claude code goes on`);
    }
  }

  private wait(id: string): void {
    const current = this.submissions.at(-1);
    if (this.background.has(id) || !current) return;
    const description = this.tasks.get(id) ?? "task";
    this.background.set(id, description);
    this.db.prepare(`INSERT INTO background(task_id, submission, description, state, started_at) VALUES (?, ?, ?, 'running', ?)
      ON CONFLICT(task_id) DO UPDATE SET submission=excluded.submission, description=excluded.description, state='running', detail=NULL, started_at=excluded.started_at, ended_at=NULL`)
      .run(id, current.seq, description, Date.now());
    this.armDeadline();
  }

  /** A follow-up turn that never shows is a failed run, not a silent wait. */
  private armGrace(since: number): void {
    clearTimeout(this.grace);
    const current = this.submissions.at(-1);
    this.grace = setTimeout(() => {
      if (this.submissions.at(-1) !== current || !this.running || this.heard >= since) return;
      this.settle("failed", "claude code was to go on by itself (a background agent finished), but did not — send a message to go on");
      this.scheduleIdle();
      this.armDeadline();
      this.changed();
    }, this.runtime.continueGraceMs ?? CONTINUE_GRACE_MS);
    this.grace.unref();
  }

  /** Background agents get `backgroundMs` from their start. Then cubed ends
   * Claude Code between turns, which ends them, and records them as lost. */
  private armDeadline(): void {
    clearTimeout(this.deadline);
    if (!this.background.size || this.closing) return;
    const limit = this.runtime.backgroundMs ?? BACKGROUND_MS;
    const oldest = (this.db.prepare("SELECT MIN(started_at) AS at FROM background WHERE state='running'").get() as { at: number | null }).at ?? Date.now();
    this.deadline = setTimeout(() => {
      if (!this.background.size || this.closing) return;
      // A running turn is never cut off here: look again in a minute (its
      // result arms this again too).
      if (this.running) { this.deadline = setTimeout(() => this.armDeadline(), 60_000); this.deadline.unref(); return; }
      this.ending = { state: "failed", reason: `it was still running ${duration(limit)} after it started; cubed ended claude code, which ends it` };
      void this.endChild();
    }, Math.max(0, oldest + limit - Date.now()));
    this.deadline.unref();
  }

  /** Background agents that can no longer finish become a run of their own,
   * failed (or stopped), so the thread's watchers hear of them once. */
  private lose(reason: string, state: "failed" | "stopped" = "failed"): void {
    const rows = storedBackground(this.db);
    this.background.clear();
    clearTimeout(this.deadline);
    if (!rows.length) return;
    this.db.prepare("UPDATE background SET state='lost', detail=?, ended_at=? WHERE state='running'").run(reason, Date.now());
    // A task id Claude Code used again gets a lost run of its own too.
    const base = `cube:background:${rows[0]!.taskId}:lost`;
    const requestId = this.submissions.some(submission => submission.requestId === base) ? `${base}:${randomUUID()}` : base;
    if (this.running) return;
    const what = agents(rows.map(row => row.description));
    const text = `cube: ${what} did not finish`;
    const error = `${what} did not finish: ${reason}; claude code does not continue ${rows.length === 1 ? "it" : "them"} — send a message to go on`;
    const seq = Number(this.db.prepare("INSERT INTO submission(request_id, text, state, error, created_at) VALUES (?, ?, ?, ?, ?)").run(requestId, text, state, error, Date.now()).lastInsertRowid);
    this.submissions.push({ seq, requestId, text, state, error });
  }

  /** Follow Bash calls from Claude Code's messages, subagents' included:
   * a tool_use opens one, its tool_result closes it, a turn's result ends all. */
  private track(data: Record<string, unknown>): void {
    // A background agent's Bash calls outlive the turn's result.
    if (data.type === "result") { if (!this.background.size) this.commands.clear(); return; }
    const content = (data.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content as Array<{ type?: string; id?: string; name?: string; tool_use_id?: string }>) {
      if (data.type === "assistant" && block.type === "tool_use" && block.name === "Bash" && block.id) this.commands.add(block.id);
      if (data.type === "assistant" && block.type === "tool_use" && block.name === "Agent" && block.id && data.parent_tool_use_id == null) this.agentCalls.add(block.id);
      if (data.type === "user" && block.type === "tool_result" && block.tool_use_id) this.commands.delete(block.tool_use_id);
    }
  }

  /** Cancel the guest commands of Bash calls still open. A key the guest
   * never saw, or one already finished, is no harm. */
  private async cancelCommands(): Promise<void> {
    const ids = [...this.commands];
    this.commands.clear();
    await Promise.all(ids.map(id => this.workspace.cancel(this.lease.token, `claude:${id}:bash`).catch(() => {})));
  }

  private scheduleIdle(): void {
    clearTimeout(this.idle);
    // Never while background agents run: ending the child ends them.
    this.idle = setTimeout(() => { if (!this.running && !this.background.size) void this.endChild(); }, this.runtime.idleMs ?? 10 * 60_000);
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

/** The background agents a store shows running, oldest first (a store from
 * before cubed tracked them has none). */
export function storedBackground(db: DatabaseSync): Array<{ taskId: string; description: string }> {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='background'").get()) return [];
  return db.prepare("SELECT task_id AS taskId, description FROM background WHERE state='running' ORDER BY rowid").all() as Array<{ taskId: string; description: string }>;
}

/** `background agent "review"`, or `2 background agents ("a", "b")`. */
export function agents(descriptions: readonly string[]): string {
  const quoted = descriptions.map(description => `"${description.replace(/\s+/g, " ").slice(0, 80)}"`);
  return quoted.length === 1 ? `background agent ${quoted[0]}` : `${quoted.length} background agents (${quoted.join(", ")})`;
}

function duration(ms: number): string {
  return ms >= 3_600_000 ? `${+(ms / 3_600_000).toFixed(1)} h` : ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`;
}

function record(db: DatabaseSync): Pick<ClaudeState, "submissions" | "messages"> {
  return {
    submissions: db.prepare("SELECT seq, request_id AS requestId, text, state, error FROM submission ORDER BY seq").all() as unknown as ClaudeSubmission[],
    messages: (db.prepare("SELECT seq, submission, data FROM message ORDER BY seq").all() as Array<{ seq: number; submission: number; data: string }>)
      .map(row => ({ seq: row.seq, submission: row.submission, data: JSON.parse(row.data) as Record<string, unknown> })),
  };
}

type StreamEvent = {
  type: string; index: number;
  content_block?: { type: string; text?: string; thinking?: string; id?: string; name?: string };
  delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
};
