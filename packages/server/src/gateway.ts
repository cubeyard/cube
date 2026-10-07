/** cube-gateway, supervised by cubed. The gateway is every thread VM's only
 * network: per VM a small LAN (DHCP, DNS, TCP termination), HTTP/HTTPS to
 * public addresses only, TLS interception with the installation CA, and a
 * decision from cubed's egress policy for every request. cubed starts it
 * with a stdin lifeline (it exits when cubed does), waits for its ready
 * line, restarts it with backoff and attaches every active VM again after a
 * restart. There is no fallback: without the binary, VM threads fail
 * visibly with "gateway unavailable". */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { createLogger, type Logger } from "./log.ts";
import type { RunnerNetwork, RunnerTarget } from "./iroh-node.ts";

export interface GatewayHello { version: string; peer: string; network: RunnerNetwork; caPem: string; caSha256: string }
export interface GatewayAttach { threadId: string; runner: RunnerTarget; frameToken: string; mac: string }
export interface GatewayVmStatus {
  vmId: string; threadId: string; link: "connecting" | "up" | "down"; leased: boolean; guestIp: string | null;
  flows: number; rxBytes: number; txBytes: number; lastError: string | null;
}

const NETWORK_RANK: Record<RunnerNetwork, number> = { loopback: 0, direct: 1, relay: 2 };
/** The widest of the modes (relay > direct > loopback). */
export function widestNetwork(modes: Iterable<RunnerNetwork>): RunnerNetwork {
  let widest: RunnerNetwork = "loopback";
  for (const mode of modes) if (NETWORK_RANK[mode] > NETWORK_RANK[widest]) widest = mode;
  return widest;
}

export class GatewayUnavailable extends Error {
  constructor(reason: string) { super(`gateway unavailable: ${reason}`); this.name = "GatewayUnavailable"; }
}
export class GatewayRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = "GatewayRequestError"; this.status = status; }
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

/** A TCP connection to a guest port through the gateway's dial route (the
 * gateway allows 22 and 1024-65535); bytes that came with the 101 are put
 * back in front of the stream. */
export function dialGuest(control: string, vmId: string, port: number, timeoutMs = 15000): Promise<net.Socket> {
  if (!/^[0-9a-f]{16}$/.test(vmId)) return Promise.reject(new Error("invalid vm id"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.reject(new Error("invalid port"));
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: control, method: "POST", path: `/v1/vms/${vmId}/dial?port=${port}`,
      headers: { host: "cube-gateway", connection: "Upgrade", upgrade: "cube-tcp", "content-length": 0 } });
    const timer = setTimeout(() => request.destroy(new Error("the gateway did not dial in time")), timeoutMs);
    request.on("upgrade", (_response, socket: net.Socket, head: Buffer) => {
      clearTimeout(timer);
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.on("response", response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        clearTimeout(timer);
        let message = Buffer.concat(chunks).toString("utf8").slice(0, 300);
        try { message = String((JSON.parse(message) as { error?: unknown }).error ?? message); } catch { /* as is */ }
        reject(new GatewayRequestError(response.statusCode ?? 0, message));
      });
    });
    request.on("error", error => { clearTimeout(timer); reject(error instanceof GatewayRequestError ? error : new GatewayUnavailable(error.message)); });
    request.end();
  });
}

/** cubed's side of the gateway's control API (HTTP on a 0600 unix socket). */
export class GatewayClient {
  readonly binary: string;
  readonly control: string;
  constructor(binary: string, control: string) { this.binary = binary; this.control = control; }

  async hello(): Promise<GatewayHello> { return await this.request("GET", "/v1/hello") as GatewayHello; }
  async attach(vmId: string, spec: GatewayAttach): Promise<GatewayVmStatus> {
    return await this.request("PUT", `/v1/vms/${vmId}`, spec) as GatewayVmStatus;
  }
  async detach(vmId: string): Promise<void> { await this.request("DELETE", `/v1/vms/${vmId}`); }
  async status(vmId: string): Promise<GatewayVmStatus | null> {
    try { return await this.request("GET", `/v1/vms/${vmId}`) as GatewayVmStatus; }
    catch (error) { if (error instanceof GatewayRequestError && error.status === 404) return null; throw error; }
  }
  async list(): Promise<GatewayVmStatus[]> { return (await this.request("GET", "/v1/vms") as { vms: GatewayVmStatus[] }).vms; }
  /** argv for OpenSSH's ProxyCommand: stdio spliced to the guest's port 22. */
  dialCommand(vmId: string): string[] { return [this.binary, "dial", "--control", this.control, "--vm", vmId, "--port", "22"]; }

  private request(method: string, url: string, body?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
      const request = http.request({ socketPath: this.control, method, path: url, timeout: 10000,
        headers: { host: "cube-gateway", ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}) } }, response => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = undefined;
          try { parsed = text ? JSON.parse(text) : undefined; } catch { /* reported below */ }
          const status = response.statusCode ?? 0;
          if (status >= 200 && status < 300) { resolve(parsed); return; }
          const message = (parsed as { error?: unknown } | undefined)?.error;
          reject(new GatewayRequestError(status, `gateway ${method} ${url}: ${status} ${typeof message === "string" ? message : text.slice(0, 200)}`));
        });
      });
      request.on("timeout", () => request.destroy(new Error("gateway did not answer in time")));
      request.on("error", error => reject(new GatewayUnavailable(error.message)));
      request.end(payload);
    });
  }
}

export interface GatewaySupervisorOptions {
  /** CUBED_STATE/gateway: the gateway's Iroh key and the installation CA. */
  state: string;
  /** The control socket the gateway serves. */
  control: string;
  /** cubed's egress decision socket the gateway calls. */
  decide: string;
  network: RunnerNetwork;
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
  private network: RunnerNetwork;
  private child: ChildProcess | undefined;
  private current: { client: GatewayClient; hello: GatewayHello } | undefined;
  private waiters: Array<{ resolve: (value: { client: GatewayClient; hello: GatewayHello }) => void; reject: (error: Error) => void }> = [];
  private restartHandlers: Array<(client: GatewayClient) => Promise<void>> = [];
  private delayMs: number;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private starts = 0;
  private lastError: string | null = null;
  private readyAt = 0;

  constructor(options: GatewaySupervisorOptions) {
    this.options = options;
    this.binary = options.binary === undefined ? locateGateway() : options.binary;
    this.network = options.network;
    this.delayMs = options.backoff?.minMs ?? 1000;
    this.log = options.log ?? createLogger("gateway");
  }

  /** Why no gateway is available, or null while one is (or may be soon). */
  get unavailable(): string | null {
    if (!this.binary) return "cube-gateway was not found (set CUBED_GATEWAY, or build it with cargo build -p cube-gateway)";
    return this.current ? null : this.lastError;
  }
  /** The control socket the gateway serves (for `cube-gateway dial`). */
  get control(): string { return this.options.control; }
  get restarts(): number { return Math.max(0, this.starts - 1); }
  get pid(): number | undefined { return this.child?.pid; }

  start(): void {
    if (this.stopping || this.child || !this.binary) return;
    this.spawn();
  }

  /** Called after every restart with the new gateway, to attach VMs again. */
  onRestart(handler: (client: GatewayClient) => Promise<void>): void { this.restartHandlers.push(handler); }

  /** The running gateway, waiting for its ready line if it is (re)starting. */
  async ready(timeoutMs = this.options.readyTimeoutMs ?? 30000): Promise<{ client: GatewayClient; hello: GatewayHello }> {
    if (!this.binary) throw new GatewayUnavailable(this.unavailable!);
    if (this.stopping) throw new GatewayUnavailable("cubed is stopping");
    if (this.current) return this.current;
    this.start();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(waiter => waiter.resolve !== done);
        reject(new GatewayUnavailable(this.lastError ?? "cube-gateway did not become ready"));
      }, timeoutMs);
      const done = (value: { client: GatewayClient; hello: GatewayHello }) => { clearTimeout(timer); resolve(value); };
      this.waiters.push({ resolve: done, reject: error => { clearTimeout(timer); reject(error); } });
    });
  }

  /** A runner wider than the gateway's network mode restarts it wider. */
  async ensureNetwork(mode: RunnerNetwork): Promise<void> {
    if (NETWORK_RANK[mode] <= NETWORK_RANK[this.network]) return;
    this.log.info("network mode widened; restarting", { from: this.network, to: mode });
    this.network = mode;
    this.child?.kill("SIGTERM");
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
    fs.mkdirSync(this.options.state, { recursive: true, mode: 0o700 });
    const args = ["serve", "--state", this.options.state, "--control", this.options.control, "--decide", this.options.decide,
      "--network", this.network, ...(this.options.extraArgs ?? [])];
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
      void this.ready_(line, restart).catch(error => {
        this.lastError = `cube-gateway is not usable: ${error instanceof Error ? error.message : String(error)}`;
        this.log.error("not ready", { error });
        child.kill("SIGTERM");
      });
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

  private async ready_(line: string, restart: boolean): Promise<void> {
    const ready = JSON.parse(line) as { ready?: unknown; peer?: unknown };
    if (ready.ready !== true || typeof ready.peer !== "string") throw new Error("unexpected ready line");
    const client = new GatewayClient(this.binary!, this.options.control);
    const hello = await client.hello();
    this.current = { client, hello };
    this.lastError = null;
    this.readyAt = Date.now();
    this.log.info("ready", { version: hello.version, peer: hello.peer, network: hello.network, restart });
    if (restart) {
      for (const handler of this.restartHandlers) {
        await handler(client).catch(error => this.log.error("reattach after restart failed", { error }));
      }
    }
    for (const waiter of this.waiters.splice(0)) waiter.resolve(this.current);
  }
}
