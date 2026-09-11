/**
 * PiTerminals — the pty bridge (ARCHITECTURE §13 Phase 3d, step 2). The chat pane
 * IS the real pi TUI: per thread, cubed spawns one `pi` process on a pty
 * (host-side, with the cube tool-routing extension) and streams it to the
 * browser's xterm.js pane over WebSocket. pi supplies the entire
 * conversation surface — cubed never renders chat.
 *
 * Lifecycle: spawned on first attach (after the host resolves a spawn plan,
 * which may wait out provisioning), shared by every attached client
 * (mirrored output, last-resize-wins), kept alive for a linger period after
 * the last client detaches (a page reload must not kill an in-flight agent
 * turn), reaped on linger expiry, pi exit, or thread deletion.
 *
 * This module is transport- and supervisor-agnostic: the WS layer adapts
 * sockets to TerminalClient, the supervisor side provides TerminalHost.
 * Protocol to clients: binary frames = raw pty output; text frames = JSON
 * control ({t:"status"|"spawned"|"attached"|"exit"|"error", ...}); an
 * `attached` frame precedes the scrollback replay to a late attacher.
 */
import type { EnvironmentProgress } from "./environment-progress.ts";
import { spawn, type IPty } from "@lydell/node-pty";

import { createLogger } from "./log.ts";

const log = createLogger("pty");

/** What the bridge needs from a connected socket. */
export interface TerminalClient {
  /** string = JSON control frame, Buffer = raw terminal output. */
  send(data: string | Buffer): void;
  close(): void;
}

export interface TerminalSpawnPlan {
  /** argv[0] is the executable. */
  argv: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface TerminalHost {
  /**
   * Thread id -> pi spawn plan. Runs once per spawn, on the attach that
   * starts the process; may take a while (it settles on provisioning) and
   * report progress via `onStatus`. Throwing refuses the terminal — the
   * message is shown to the user, so it must speak thread vocabulary.
   */
  plan(threadId: string, onStatus: (text: string, progress?: EnvironmentProgress) => void): Promise<TerminalSpawnPlan>;
  /** Activity signal (throttled by the bridge): terminal I/O counts like a
   * prompt for idle-sleep purposes. */
  activity(threadId: string): void;
  /** Lifecycle record (events.ts): spawn timing, exit code, reaps. */
  event?(input: { thread: string; phase: "spawn" | "exit" | "reap"; ok: boolean; ms?: number; detail?: string }): void;
}

export interface TerminalHandle {
  input(data: string): void;
  resize(cols: number, rows: number): void;
  detach(): void;
}

interface TerminalSession {
  threadId: string;
  proc: IPty | null;
  /** plan() in flight — a second attach must not double-spawn. */
  starting: boolean;
  clients: Set<TerminalClient>;
  /** Rolling raw-output tail, replayed to late attachers. */
  scrollback: Buffer[];
  scrollbackBytes: number;
  /** Last pre-spawn status line, replayed to late attachers. */
  lastStatus: { text: string; progress?: EnvironmentProgress } | null;
  cols: number;
  rows: number;
  linger: NodeJS.Timeout | null;
  lastActivity: number;
  /** Last pty output (ms epoch): the linger reap waits for this much silence. */
  lastOutput: number;
}

const SCROLLBACK_CAP = 512 * 1024;
const ACTIVITY_THROTTLE_MS = 60_000;

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : min;

export class PiTerminals {
  private readonly host: TerminalHost;
  private readonly lingerMs: number;
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(host: TerminalHost, options: { lingerMs?: number } = {}) {
    this.host = host;
    this.lingerMs = options.lingerMs ?? 1_800_000;
  }

  /** A live (or starting) pi process owns this thread's conversation —
   * the HTTP prompt routes 409 on it (one writer per session file). */
  isLive(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  attach(threadId: string, client: TerminalClient, cols: number, rows: number): TerminalHandle {
    let session = this.sessions.get(threadId);
    if (!session) {
      session = {
        threadId,
        proc: null,
        starting: false,
        clients: new Set(),
        scrollback: [],
        scrollbackBytes: 0,
        lastStatus: null,
        cols: clamp(cols, 2, 500),
        rows: clamp(rows, 2, 500),
        linger: null,
        lastActivity: 0,
        lastOutput: 0,
      };
      this.sessions.set(threadId, session);
    }
    session.clients.add(client);
    if (session.linger) {
      clearTimeout(session.linger);
      session.linger = null;
    }
    if (session.proc) {
      // Late attacher: say so first — the client keeps its own buffer across
      // a transport drop and must clear it before a replay lands, or the
      // tail would be drawn twice — then replay the tail and adopt this
      // client's size (the TUI redraws on the resize, squaring the frame).
      if (session.lastStatus?.progress?.failed) client.send(control({ t: "status", ...session.lastStatus }));
      client.send(control({ t: "attached", replay: session.scrollback.length > 0 }));
      for (const chunk of session.scrollback) client.send(chunk);
      this.resize(session, clamp(cols, 2, 500), clamp(rows, 2, 500));
    } else if (session.starting) {
      if (session.lastStatus) client.send(control({ t: "status", ...session.lastStatus }));
    } else {
      void this.start(session);
    }
    return {
      input: (data) => {
        if (typeof data !== "string" || !session.clients.has(client)) return;
        session.proc?.write(data);
        this.touch(session);
      },
      resize: (c, r) => {
        if (!session.clients.has(client)) return;
        this.resize(session, clamp(c, 2, 500), clamp(r, 2, 500));
      },
      detach: () => this.detach(session, client),
    };
  }

  /** Thread deleted (or cubed shutting down): kill pi now, no linger. */
  kill(threadId: string): void {
    const session = this.sessions.get(threadId);
    if (!session) return;
    if (session.proc) {
      // onExit tears the session down (broadcast + delete).
      session.proc.kill();
      return;
    }
    // Still starting: drop the session so the pending plan's spawn is
    // abandoned (start() re-checks membership after the await).
    this.teardown(session, { t: "exit", code: null });
  }

  close(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }

  // ---------------------------------------------------------------- private

  private async start(session: TerminalSession): Promise<void> {
    session.starting = true;
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const plan = await this.host.plan(session.threadId, (text, progress) => {
        session.lastStatus = { text, progress };
        this.broadcast(session, control({ t: "status", text, progress }));
      });
      // Everyone left, or the thread was killed, while the plan settled.
      if (this.sessions.get(session.threadId) !== session) return;
      if (session.clients.size === 0) {
        // The detach armed a linger reap; it must not outlive this session
        // and kill the pi a later attach spawns.
        if (session.linger) clearTimeout(session.linger);
        this.sessions.delete(session.threadId);
        return;
      }
      const [command, ...args] = plan.argv;
      const proc = spawn(command!, args, {
        name: "xterm-256color",
        cwd: plan.cwd,
        env: plan.env,
        cols: session.cols,
        rows: session.rows,
      });
      session.proc = proc;
      if (!session.lastStatus?.progress?.failed) session.lastStatus = null;
      log.info("pi spawned", { thread: session.threadId, pid: proc.pid });
      this.host.event?.({ thread: session.threadId, phase: "spawn", ok: true, ms: elapsed() });
      this.broadcast(session, control({ t: "spawned" }));
      proc.onData((chunk) => {
        const buf = Buffer.from(chunk, "utf8");
        session.scrollback.push(buf);
        session.scrollbackBytes += buf.length;
        while (session.scrollbackBytes > SCROLLBACK_CAP && session.scrollback.length > 1) {
          session.scrollbackBytes -= session.scrollback.shift()!.length;
        }
        this.broadcast(session, buf);
        session.lastOutput = Date.now();
        this.touch(session);
      });
      proc.onExit(({ exitCode }) => {
        log.warn("pi exited", { thread: session.threadId, pid: proc.pid, code: exitCode });
        if (this.sessions.get(session.threadId) !== session) return;
        this.host.event?.({
          thread: session.threadId,
          phase: "exit",
          ok: exitCode === 0,
          ms: elapsed(),
          detail: `exit ${exitCode}`,
        });
        this.teardown(session, { t: "exit", code: exitCode });
      });
    } catch (error) {
      log.warn("pi spawn failed", { thread: session.threadId, error });
      if (this.sessions.get(session.threadId) !== session) return;
      const text = error instanceof Error ? error.message : String(error);
      this.host.event?.({ thread: session.threadId, phase: "spawn", ok: false, ms: elapsed(), detail: text });
      this.teardown(session, { t: "error", text });
    } finally {
      session.starting = false;
    }
  }

  private teardown(session: TerminalSession, frame: object): void {
    this.sessions.delete(session.threadId);
    if (session.linger) clearTimeout(session.linger);
    this.broadcast(session, control(frame));
    for (const client of session.clients) client.close();
    session.clients.clear();
  }

  private detach(session: TerminalSession, client: TerminalClient): void {
    if (!session.clients.delete(client)) return;
    if (session.clients.size > 0 || this.sessions.get(session.threadId) !== session) return;
    // Last client gone: give pi a linger window (page reloads, sleeping
    // laptops, in-flight agent turns), then reap.
    if (session.linger) clearTimeout(session.linger);
    this.armLinger(session);
  }

  /** (Re)start the reap timer for a session with no clients. Output resets
   * it (see onData): a closed tab must never kill an agent that is still
   * working — the product promises "close the tab, come back to the
   * result". The timer only fires after the linger window of silence. */
  private armLinger(session: TerminalSession, delay = this.lingerMs): void {
    if (session.linger) clearTimeout(session.linger);
    session.linger = setTimeout(() => {
      if (this.sessions.get(session.threadId) !== session) return;
      // Still producing output (an agent turn in progress): wait out the
      // remainder of a full linger window of silence before reaping.
      const quietFor = Date.now() - session.lastOutput;
      if (quietFor < this.lingerMs) return this.armLinger(session, this.lingerMs - quietFor);
      this.host.event?.({ thread: session.threadId, phase: "reap", ok: true, detail: `no client and no output for ${Math.round(this.lingerMs / 60_000)} min` });
      this.kill(session.threadId);
    }, delay);
    session.linger.unref();
  }

  private resize(session: TerminalSession, cols: number, rows: number): void {
    session.cols = cols;
    session.rows = rows;
    try {
      session.proc?.resize(cols, rows);
    } catch {
      // The pty can be mid-exit; the exit frame is the client's truth.
    }
  }

  private broadcast(session: TerminalSession, data: string | Buffer): void {
    for (const client of session.clients) {
      try {
        client.send(data);
      } catch {
        // A dying socket must not take the broadcast loop down.
      }
    }
  }

  private touch(session: TerminalSession): void {
    const now = Date.now();
    if (now - session.lastActivity < ACTIVITY_THROTTLE_MS) return;
    session.lastActivity = now;
    this.host.activity(session.threadId);
  }
}

const control = (frame: object) => JSON.stringify(frame);
