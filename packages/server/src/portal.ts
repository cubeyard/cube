/** The portal: plain HTTP and WebSocket from a browser on the private
 * network to a web server a thread's agent runs with `cube service`.
 *
 * Every service has its own origin, `http://<service>-<thread label>.<suffix>:<port>/`,
 * where the suffix resolves to cubed's private address (by default
 * `<ip with dashes>.sslip.io`). The portal listens on its own port, apart
 * from cube's UI and API: it serves nothing of cube's, sets no cookie of its
 * own and answers only Host values of exactly that form. A request goes
 * browser → portal → the gateway's dial route → the runner's frame channel →
 * the guest's registered port; nothing else is reachable through it: the
 * service and its port come from the guest's own registrations, never from
 * the request, and only while cubed has the thread's machine running (the
 * portal never starts one). The thread label is an HMAC of the thread id
 * under a key in CUBED_STATE/portal, so labels cannot be enumerated from
 * thread ids. There is no user authentication: the portal is as private as
 * the network it listens on. See docs/services.md. */
import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import { guestServices, SERVICE_NAME, type GuestPortal, type GuestService } from "./vm-workspace.ts";
import type { ThreadMachines } from "./vm.ts";
import type { Registry, Thread } from "./registry.ts";
import { createLogger, type Logger } from "./log.ts";

export const DEFAULT_PORTAL_PORT = 7780;
/** Wildcard DNS services that answer `<anything>.<a-b-c-d>.<domain>` with a.b.c.d. */
const IP_DOMAINS = new Set(["sslip.io", "nip.io"]);
const DOMAIN = /^(?=.{3,150}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
/** How long the guest's registrations are trusted before asking again. */
const SERVICES_TTL_MS = 2000;
/** Open connections per thread; the gateway gives each machine 256 flows in all. */
const MAX_CONNECTIONS_PER_THREAD = 64;
const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade"]);
const FORWARDED = new Set(["forwarded", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"]);

export interface PortalSettings {
  /** The private address browsers reach the portal at (CUBED_PORTAL_IP). */
  ip: string;
  port: number;
  /** The address the portal listens on (default: `ip`). */
  listen: string;
  domain: string;
  /** What every service host ends with. */
  suffix: string;
}

/** Private, CGNAT (Tailscale) and loopback IPv4 addresses. */
export function privateIpv4(address: string): boolean {
  if (!net.isIPv4(address)) return false;
  const [a, b] = address.split(".").map(Number) as [number, number];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** The portal's settings from CUBED_PORTAL_IP (off without it),
 * CUBED_PORTAL_PORT (7780), CUBED_PORTAL_LISTEN (the IP) and
 * CUBED_PORTAL_DOMAIN (sslip.io; nip.io, or a wildcard domain of the
 * operator's own that resolves to the IP). */
export function portalSettings(env: NodeJS.ProcessEnv = process.env): PortalSettings | null {
  const ip = env.CUBED_PORTAL_IP?.trim();
  if (!ip) return null;
  if (!privateIpv4(ip)) throw new Error("CUBED_PORTAL_IP must be a private IPv4 address (Tailscale 100.64.0.0/10, 10/8, 172.16/12, 192.168/16 or loopback)");
  const rawPort = env.CUBED_PORTAL_PORT?.trim() || String(DEFAULT_PORTAL_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== rawPort) throw new Error("CUBED_PORTAL_PORT must be an integer from 1 through 65535");
  const listen = env.CUBED_PORTAL_LISTEN?.trim() || ip;
  if (!privateIpv4(listen)) throw new Error("CUBED_PORTAL_LISTEN must be a private or loopback IPv4 address; the portal never listens on every interface");
  const domain = (env.CUBED_PORTAL_DOMAIN?.trim() || "sslip.io").toLowerCase();
  if (!DOMAIN.test(domain)) throw new Error("CUBED_PORTAL_DOMAIN must be a DNS name such as sslip.io");
  return { ip, port, listen, domain, suffix: IP_DOMAINS.has(domain) ? `${ip.replaceAll(".", "-")}.${domain}` : domain };
}

class Refusal extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export interface PortalOptions {
  settings: PortalSettings | null;
  /** CUBED_STATE/portal: the key thread labels derive from. */
  directory: string;
  registry: Registry;
  machines: ThreadMachines;
  /** Whether an archive of the thread is under way (or deciding). */
  archiving: (id: string) => boolean;
  log?: Logger;
}

export class Portal {
  readonly settings: PortalSettings | null;
  private readonly options: PortalOptions;
  private readonly log: Logger;
  private key: Buffer | undefined;
  private labels = new Map<string, string>();
  private labelsAt = 0;
  private readonly cache = new Map<string, { at: number; services: Promise<GuestService[]> }>();
  private readonly open = new Map<string, number>();
  private server: http.Server | undefined;
  /** `off`, `listening` or why it is not. */
  state = "off";

  constructor(options: PortalOptions) {
    this.options = options;
    this.settings = options.settings;
    this.log = options.log ?? createLogger("portal");
  }

  /** The thread's label in its services' hosts. */
  label(threadId: string): string {
    if (!this.key) {
      const file = path.join(this.options.directory, "key");
      fs.mkdirSync(this.options.directory, { recursive: true, mode: 0o700 });
      try { fs.writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      const text = fs.readFileSync(file, "utf8").trim();
      if (!/^[0-9a-f]{64}$/.test(text)) throw new Error(`${file} is not a portal key`);
      this.key = Buffer.from(text, "hex");
    }
    return createHmac("sha256", this.key).update(threadId).digest("hex").slice(0, 10);
  }

  /** What `cube service` in the thread's machine shows as its URLs. */
  guest(thread: Thread): GuestPortal {
    const settings = this.settings;
    if (!settings) return { reason: "this cube installation has no portal (CUBED_PORTAL_IP is not set)" };
    return { urlTemplate: `http://{name}-${this.label(thread.id)}.${settings.suffix}${settings.port === 80 ? "" : `:${settings.port}`}/` };
  }

  /** The services registered in a running thread machine (cached briefly). */
  services(thread: Thread, fresh = false): Promise<GuestService[]> {
    const cached = this.cache.get(thread.id);
    if (cached && !fresh && Date.now() - cached.at < SERVICES_TTL_MS) return cached.services;
    // Expired entries go, so archived threads leave nothing behind.
    for (const [id, entry] of this.cache) if (Date.now() - entry.at >= SERVICES_TTL_MS) this.cache.delete(id);
    const services = this.options.machines.guest(thread).call("services", {}, { timeoutMs: 15000 }).then(answer => {
      const failure = answer.header.error as { message?: unknown } | undefined;
      if (failure) throw new Error(typeof failure.message === "string" ? failure.message : "the guest refused");
      return guestServices(answer.header);
    });
    this.cache.set(thread.id, { at: Date.now(), services });
    services.catch(() => { if (this.cache.get(thread.id)?.services === services) this.cache.delete(thread.id); });
    return services;
  }

  async listen(): Promise<void> {
    const settings = this.settings;
    if (!settings) return;
    const server = http.createServer((request, response) => void this.handle(request, response));
    server.on("upgrade", (request: http.IncomingMessage, socket: Duplex, head: Buffer) => void this.upgrade(request, socket, head));
    server.on("clientError", (_error, socket) => { if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n"); else socket.destroy(); });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(settings.port, settings.listen, () => { server.off("error", reject); resolve(); });
      });
    } catch (error) {
      this.state = `failed: ${error instanceof Error ? error.message : String(error)}`;
      this.log.error("the portal could not listen", { listen: `${settings.listen}:${settings.port}`, error });
      return;
    }
    this.server = server;
    this.state = "listening";
    this.log.info("listening", { listen: `${settings.listen}:${settings.port}`, hosts: `http://<service>-<thread>.${settings.suffix}:${settings.port}/` });
  }

  /** Open connections to the thread's services. */
  connections(threadId: string): number { return this.open.get(threadId) ?? 0; }

  address(): net.AddressInfo | null { return (this.server?.address() as net.AddressInfo | null) ?? null; }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  /** The thread and service a Host names; refuses anything else. */
  private async resolve(host: string | undefined): Promise<{ thread: Thread; service: GuestService }> {
    const settings = this.settings!;
    const unknown = new Refusal(404, "no cube service at this address");
    const match = /^([a-z0-9-]+)-([0-9a-f]{10})\.([a-z0-9.-]+?)(?::([0-9]{1,5}))?$/.exec((host ?? "").toLowerCase());
    if (!match || match[3] !== settings.suffix || (match[4] === undefined ? settings.port !== 80 : Number(match[4]) !== settings.port)
      || !SERVICE_NAME.test(match[1]!)) throw unknown;
    const thread = this.thread(match[2]!);
    if (!thread) throw unknown;
    if (thread.workspaceState !== "available" || this.options.archiving(thread.id) || !this.options.machines.running?.(thread)) {
      this.cache.delete(thread.id);
      throw new Refusal(503, "this thread's machine is not running; open the thread in cube to start it");
    }
    let services: GuestService[];
    try { services = await this.services(thread); }
    catch (error) { throw new Refusal(502, `cube could not ask the thread's machine for its services: ${error instanceof Error ? error.message : String(error)}`); }
    const service = services.find(item => item.name === match[1]);
    if (!service) throw new Refusal(404, `this thread has no service ${match[1]}; start one with cube service start`);
    return { thread, service };
  }

  private thread(label: string): Thread | null {
    const find = () => {
      const id = this.labels.get(label);
      const thread = id ? this.options.registry.getThread(id) : null;
      if (thread?.archived) this.cache.delete(thread.id);
      return thread && !thread.archived ? thread : null;
    };
    const found = find();
    if (found || Date.now() - this.labelsAt < 1000) return found;
    this.labels = new Map(this.options.registry.listThreads().filter(thread => !thread.archived).map(thread => [this.label(thread.id), thread.id]));
    this.labelsAt = Date.now();
    return find();
  }

  /** Counts a connection against the thread's share; returns its release. */
  private hold(threadId: string): () => void {
    const count = this.open.get(threadId) ?? 0;
    if (count >= MAX_CONNECTIONS_PER_THREAD) throw new Refusal(503, "too many open connections to this thread's services");
    this.open.set(threadId, count + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      const left = (this.open.get(threadId) ?? 1) - 1;
      if (left > 0) this.open.set(threadId, left); else this.open.delete(threadId);
    };
  }

  private async connect(thread: Thread, service: GuestService): Promise<net.Socket> {
    try { return await this.options.machines.dial!(thread, service.port); }
    catch (error) {
      // The registration may be stale (stopped, replaced): ask again next time.
      this.cache.delete(thread.id);
      throw new Refusal(502, `service ${service.name} did not answer on port ${service.port}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    let release = () => {};
    try {
      if (!request.url?.startsWith("/")) throw new Refusal(400, "bad request");
      const { thread, service } = await this.resolve(request.headers.host);
      release = this.hold(thread.id);
      response.once("close", release);
      const socket = await this.connect(thread, service);
      if (response.destroyed) { socket.destroy(); return; }
      const upstream = http.request({ method: request.method, path: request.url, headers: forwardHeaders(request, false), setHost: false,
        createConnection: () => socket });
      upstream.on("response", answer => {
        // The service is agent-controlled: its reason phrase is not passed on
        // (Node refuses some), and nothing it sends may throw out of here.
        try { response.writeHead(answer.statusCode ?? 502, responseHeaders(answer.rawHeaders)); }
        catch (error) {
          answer.destroy(); socket.destroy();
          refuse(response, new Refusal(502, `service ${service.name} sent a response the portal cannot pass on: ${error instanceof Error ? error.message : String(error)}`));
          return;
        }
        answer.pipe(response);
        answer.on("error", () => response.destroy());
      });
      upstream.on("error", error => {
        if (!response.headersSent) refuse(response, new Refusal(502, `service ${service.name} broke off: ${error.message}`));
        else response.destroy();
      });
      // The browser went away: so does the request to the service.
      response.once("close", () => { if (!response.writableFinished) upstream.destroy(); socket.destroy(); });
      request.pipe(upstream);
    } catch (error) {
      release();
      if (error instanceof Refusal) refuse(response, error);
      else { this.log.warn("portal request failed", { error }); refuse(response, new Refusal(500, "the portal failed")); }
    }
  }

  /** A WebSocket (or other HTTP/1.1 upgrade): the request goes to the
   * service as it came and the two connections are joined. */
  private async upgrade(request: http.IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    let release = () => {};
    try {
      if (!request.url?.startsWith("/")) throw new Refusal(400, "bad request");
      const { thread, service } = await this.resolve(request.headers.host);
      release = this.hold(thread.id);
      client.once("close", release);
      const socket = await this.connect(thread, service);
      if (client.destroyed) { socket.destroy(); return; }
      const headers = forwardHeaders(request, true);
      const lines = [`${request.method} ${request.url} HTTP/1.1`];
      for (let index = 0; index < headers.length; index += 2) lines.push(`${headers[index]}: ${headers[index + 1]}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) socket.write(head);
      socket.on("error", () => client.destroy());
      client.on("error", () => socket.destroy());
      socket.on("close", () => client.destroy());
      client.on("close", () => socket.destroy());
      socket.pipe(client);
      client.pipe(socket);
    } catch (error) {
      release();
      const refusal = error instanceof Refusal ? error : new Refusal(500, "the portal failed");
      if (!(error instanceof Refusal)) this.log.warn("portal upgrade failed", { error });
      if (client.writable) {
        const body = `${refusal.message}\n`;
        client.end(`HTTP/1.1 ${refusal.status} ${http.STATUS_CODES[refusal.status] ?? ""}\r\ncontent-type: text/plain; charset=utf-8\r\n`
          + `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
      } else client.destroy();
    }
  }
}

function refuse(response: http.ServerResponse, refusal: Refusal): void {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(refusal.status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  response.end(`${refusal.message}\n`);
}

/** The request's headers for the service, as raw name/value pairs: without
 * hop-by-hop headers (an upgrade keeps Connection and Upgrade) and without
 * forwarding headers the browser sent, then the portal's own. */
function forwardHeaders(request: http.IncomingMessage, upgrade: boolean): string[] {
  const named = new Set((request.headers.connection ?? "").split(",").map(item => item.trim().toLowerCase()).filter(Boolean));
  const headers: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!, lower = name.toLowerCase();
    if (FORWARDED.has(lower)) continue;
    if (upgrade ? lower === "proxy-authorization" || lower === "proxy-connection" : HOP_BY_HOP.has(lower) || named.has(lower)) continue;
    headers.push(name, request.rawHeaders[index + 1]!);
  }
  if (!upgrade) headers.push("connection", "close");
  headers.push("x-forwarded-for", request.socket.remoteAddress ?? "", "x-forwarded-host", request.headers.host ?? "", "x-forwarded-proto", "http");
  return headers;
}

/** The service's response headers for the browser: without hop-by-hop
 * headers, and its cookies made host-only (a Domain attribute would share
 * them with other services under the same suffix). */
export function responseHeaders(raw: string[]): string[] {
  const named = new Set<string>();
  for (let index = 0; index < raw.length; index += 2) {
    if (raw[index]!.toLowerCase() === "connection") for (const item of raw[index + 1]!.split(",")) named.add(item.trim().toLowerCase());
  }
  const headers: string[] = [];
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]!, lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || named.has(lower)) continue;
    headers.push(name, lower === "set-cookie" ? raw[index + 1]!.replace(/;\s*domain\s*=[^;]*/gi, "") : raw[index + 1]!);
  }
  return headers;
}
