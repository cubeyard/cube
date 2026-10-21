/** cube-gateway, supervised by cubed: the credential proxy of runner
 * protocol 4. A `berth vm` runner sends each guest request a credential rule
 * matches over a `credential` stream; cubed checks the machine and carries
 * the stream to the gateway's credential socket (runner-credentials.ts),
 * where cubed's egress policy decides the request and the real secret is
 * substituted (packages/gateway). cubed starts it with a stdin lifeline (it
 * exits when cubed does), waits for its ready line and restarts it with
 * backoff. There is no fallback: without the binary, a credential stream is
 * refused and the guest's request fails visibly. */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createLogger, type Logger } from "./log.ts";

export interface GatewayHello { version: string }

export class GatewayUnavailable extends Error {
  constructor(reason: string) { super(`gateway unavailable: ${reason}`); this.name = "GatewayUnavailable"; }
}

/** The gateway binary: CUBED_GATEWAY, else `bin/cube-gateway` of a release,
 * else `target/{release,debug}/cube-gateway` of a source checkout. */
export function locateGateway(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.CUBED_GATEWAY?.trim();
  const root = path.resolve(import.meta.dirname, "../../..");
  // A release unpacks the server under app/ next to bin/ and release.json.
  const release = fs.existsSync(path.resolve(root, "../release.json"));
  const candidates = configured ? [configured]
    : release ? [path.resolve(root, "../bin/cube-gateway")]
    : [path.join(root, "target/release/cube-gateway"), path.join(root, "target/debug/cube-gateway")];
  for (const candidate of candidates) {
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch { /* next */ }
  }
  return null;
}

export interface GatewaySupervisorOptions {
  /** cubed's egress decision socket the gateway calls. */
  decide: string;
  /** The credential proxy's socket the gateway serves for protocol-4
   * runners' `credential` streams (runner-credentials.ts). */
  credential: string;
  /** null: no gateway on this host. Default: locateGateway(). */
  binary?: string | null;
  /** Test builds only (`test-hooks`): extra `serve` arguments. */
  extraArgs?: readonly string[];
  /** Added to the gateway's otherwise minimal environment (tests). */
  env?: Record<string, string>;
  /** Restart delay doubles from minMs to maxMs; a gateway that stayed up
   * for stableMs starts over at minMs. */
  backoff?: { minMs: number; maxMs: number; stableMs?: number };
  readyTimeoutMs?: number;
  log?: Logger;
}

/** Spawns, watches and restarts cube-gateway. */
export class GatewaySupervisor {
  readonly binary: string | null;
  private readonly options: GatewaySupervisorOptions;
  private readonly log: Logger;
  private child: ChildProcess | undefined;
  private current: GatewayHello | undefined;
  private waiters: Array<{ resolve: (value: GatewayHello) => void; reject: (error: Error) => void }> = [];
  private delayMs: number;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private starts = 0;
  private lastError: string | null = null;
  private readyAt = 0;

  constructor(options: GatewaySupervisorOptions) {
    this.options = options;
    this.binary = options.binary === undefined ? locateGateway() : options.binary;
    this.delayMs = options.backoff?.minMs ?? 1000;
    this.log = options.log ?? createLogger("gateway");
  }

  /** Why no gateway is available, or null while one is (or may be soon). */
  get unavailable(): string | null {
    if (!this.binary) return "cube-gateway was not found (set CUBED_GATEWAY, or build it with cargo build -p cube-gateway)";
    return this.current ? null : this.lastError;
  }
  get restarts(): number { return Math.max(0, this.starts - 1); }
  get pid(): number | undefined { return this.child?.pid; }

  start(): void {
    if (this.stopping || this.child || !this.binary) return;
    this.spawn();
  }

  /** The running gateway, if one is ready now; never starts one. */
  get running(): GatewayHello | undefined { return this.current; }

  /** The running gateway, waiting for its ready line if it is (re)starting. */
  async ready(timeoutMs = this.options.readyTimeoutMs ?? 30000): Promise<GatewayHello> {
    if (!this.binary) throw new GatewayUnavailable(this.unavailable!);
    if (this.stopping) throw new GatewayUnavailable("cubed is stopping");
    if (this.current) return this.current;
    this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(waiter => waiter.resolve !== done);
        reject(new GatewayUnavailable(this.lastError ?? "cube-gateway did not become ready"));
      }, timeoutMs);
      const done = (value: GatewayHello) => { clearTimeout(timer); resolve(value); };
      this.waiters.push({ resolve: done, reject: error => { clearTimeout(timer); reject(error); } });
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.timer);
    for (const waiter of this.waiters.splice(0)) waiter.reject(new GatewayUnavailable("cubed is stopping"));
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    child.stdin?.end();
    child.kill("SIGTERM");
    const killer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(killer);
  }

  private spawn(): void {
    const binary = this.binary!;
    const args = ["serve", "--decide", this.options.decide, "--credential", this.options.credential, ...(this.options.extraArgs ?? [])];
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/", ...this.options.env } });
    this.child = child;
    this.starts++;
    const restart = this.starts > 1;
    child.stdin!.on("error", () => {});
    const lines = readline.createInterface({ input: child.stdout! });
    let readyLine = false;
    lines.on("line", line => {
      if (readyLine) { this.log.debug("output", { line }); return; }
      readyLine = true;
      try { this.ready_(line, restart); }
      catch (error) {
        this.lastError = `cube-gateway is not usable: ${error instanceof Error ? error.message : String(error)}`;
        this.log.error("not ready", { error });
        child.kill("SIGTERM");
      }
    });
    readline.createInterface({ input: child.stderr! }).on("line", line => this.log.info("stderr", { line }));
    child.on("error", error => { this.lastError = `cube-gateway could not start: ${error.message}`; });
    child.on("exit", (code, signal) => {
      if (this.child === child) this.child = undefined;
      this.current = undefined;
      if (this.stopping) return;
      this.lastError ??= `cube-gateway exited (${signal ?? code})`;
      const stableMs = this.options.backoff?.stableMs ?? 60000;
      if (this.readyAt && Date.now() - this.readyAt >= stableMs) this.delayMs = this.options.backoff?.minMs ?? 1000;
      this.readyAt = 0;
      this.log.warn("exited; restarting", { code, signal, inMs: this.delayMs });
      clearTimeout(this.timer);
      this.timer = setTimeout(() => { this.timer = undefined; if (!this.stopping) this.spawn(); }, this.delayMs);
      this.timer.unref();
      this.delayMs = Math.min(this.delayMs * 2, this.options.backoff?.maxMs ?? 30000);
    });
  }

  private ready_(line: string, restart: boolean): void {
    const ready = JSON.parse(line) as { ready?: unknown; version?: unknown };
    if (ready.ready !== true || typeof ready.version !== "string") throw new Error("unexpected ready line");
    this.current = { version: ready.version };
    this.lastError = null;
    this.readyAt = Date.now();
    this.log.info("ready", { version: ready.version, restart });
    for (const waiter of this.waiters.splice(0)) waiter.resolve(this.current);
  }
}
