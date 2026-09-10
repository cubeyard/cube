/**
 * Host-header portal routing (ARCHITECTURE §10). Portals share cubed's main
 * listener: a request whose Host is `<label>.<PORTAL_BASE>` is proxied to
 * the owning cube; everything else falls through to the UI/API. Plain
 * node:http/net — HTTP(S)/WebSocket only, by design (no port allocator,
 * nothing raw-TCP to route on).
 */
import http from "node:http";
import net from "node:net";
import stream from "node:stream";

import { createLogger } from "./log.ts";

const log = createLogger("portal");

/** The path without its query: OAuth callbacks and websocket tickets carry
 * codes/tokens in the query string, which must not land in the journal. */
const pathOnly = (url: string | undefined): string => (url ?? "").split("?", 1)[0] ?? "";

/** Hop-by-hop headers never forwarded (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "proxy-connection",
]);

/**
 * `Host: web--t-abc.cube.internal:7777` -> "web--t-abc" (null = not a
 * portal host — serve the UI/API). One label only: dots inside the label
 * would make `a.b.<base>` route on a hostname nobody registered.
 */
export function portalLabel(hostHeader: string | undefined, base: string): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.replace(/:\d+$/, "").toLowerCase();
  const suffix = `.${base.toLowerCase()}`;
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (label === "" || label.includes(".")) return null;
  return label;
}

export interface PortalTarget {
  ip: string;
  port: number;
}

/** Forward one HTTP exchange to the cube service. The original Host header
 * is preserved (dev servers build absolute URLs from it — that is the whole
 * point of hostname portals); X-Forwarded-* record the hop. */
export function proxyHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  target: PortalTarget,
  onConnectError: () => void,
): void {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(key)) headers[key] = value;
  }
  headers["x-forwarded-proto"] = "http";
  headers["x-forwarded-host"] = req.headers.host ?? "";
  headers["x-forwarded-for"] = req.socket.remoteAddress ?? "";
  const upstream = http.request(
    // agent:false — pooled keep-alive sockets to a service that then
    // sleeps/crashes would error on reuse and read as spurious downtime.
    { host: target.ip, port: target.port, method: req.method, path: req.url, headers, agent: false },
    (upstreamRes) => {
      const out: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.has(key)) out[key] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, out);
      // pipeline, not pipe: a service dying mid-body must end the client's
      // request too, or the browser waits on it forever.
      stream.pipeline(upstreamRes, res, () => {
        if (!res.writableEnded) res.destroy();
      });
    },
  );
  upstream.on("error", (error: NodeJS.ErrnoException) => {
    log.warn("upstream error", { target: `${target.ip}:${target.port}`, method: req.method, path: pathOnly(req.url), error: error.code ?? error.message });
    if (res.headersSent) return void res.destroy();
    if (error.code === "ECONNREFUSED" || error.code === "EHOSTUNREACH" || error.code === "ETIMEDOUT") {
      return onConnectError();
    }
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream error: ${error.code ?? error.message}`);
  });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
}

/** Forward a WebSocket (or any Upgrade) handshake + both raw streams. */
export function proxyUpgrade(
  req: http.IncomingMessage,
  socket: stream.Duplex,
  head: Buffer,
  target: PortalTarget,
  hooks: UpgradeHooks = {},
): void {
  guardUpgradeSocket(socket); // the teardown below is the working listener; this one outlives it
  let connected = false;
  let answered = false;
  let lastError: Error | null = null;
  const upstream = net.connect(target.port, target.ip, () => {
    connected = true;
    hooks.connected?.();
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    // rawHeaders preserves the exact handshake (casing, duplicates,
    // Connection/Upgrade themselves — hop-by-hop filtering would break the
    // upgrade, which is the one hop-by-hop exchange we DO forward).
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", (error: NodeJS.ErrnoException) => {
    lastError = error;
    log.warn("upstream error", { target: `${target.ip}:${target.port}`, upgrade: pathOnly(req.url), error: error.code ?? error.message });
  });
  const teardown = (side: "upstream" | "client") => () => {
    upstream.destroy();
    // An upstream that never came up is the caller's to answer when it
    // asked (a 503 beats a bare close); otherwise, or once connected,
    // both sides go.
    if (side === "upstream" && !connected && hooks.connectError) {
      if (!answered) {
        answered = true;
        hooks.connectError(lastError ?? new Error("upstream closed before connecting"));
      }
      return;
    }
    socket.destroy();
  };
  // end/close, not just error: http.Server sockets are allowHalfOpen, so a
  // peer's FIN emits only 'end' and the pair would idle half-open forever.
  // A WebSocket has no meaningful half-close — either side ending tears
  // down both.
  for (const [side, drop] of [[upstream, teardown("upstream")], [socket, teardown("client")]] as const) {
    side.on("error", drop);
    side.on("end", drop);
    side.on("close", drop);
  }
}

export interface UpgradeHooks {
  /** The upstream accepted the connection; the handshake is on its way. */
  connected?: () => void;
  /** The upstream could not be connected. When given, the client socket
   * is left to the caller (to refuse honestly); otherwise it is dropped. */
  connectError?: (error: Error) => void;
}

const guarded = new WeakSet<stream.Duplex>();

/**
 * An upgraded socket is nobody's: node removes its own error listener
 * before emitting `upgrade`, so an ECONNRESET while we refuse, hold or
 * hand the socket on is an unhandled 'error' — a crash of the daemon.
 * Install one listener for the socket's whole life the moment the
 * handler takes it (idempotent). Resets are the client's business, not
 * the journal's: debug level, then the socket is dropped.
 */
export function guardUpgradeSocket(socket: stream.Duplex): void {
  if (guarded.has(socket)) return;
  guarded.add(socket);
  socket.on("error", (error: NodeJS.ErrnoException) => {
    log.debug("upgrade socket error", { error: error.code ?? error.message });
    socket.destroy();
  });
}

/** Refuse an upgrade honestly: a complete HTTP response on the raw socket
 * (503 + Retry-After) instead of a bare close, which a browser reports as
 * a network failure and a dev-server client never retries. */
export function refuseUpgrade(socket: stream.Duplex, retryAfterSeconds = 5): void {
  guardUpgradeSocket(socket); // the write below may be the reset that crashes
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 503 Service Unavailable\r\nRetry-After: ${retryAfterSeconds}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    () => socket.destroy(),
  );
}

export interface WakeUpgradeOutcome {
  ok: boolean;
  ms: number;
  detail: string;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * A WebSocket to a portal whose thread is not up (asleep, waking, the
 * service down): run `wake` — the caller's coalesced wake+ensure, which
 * resolves to the target once the ensure reports THIS service running,
 * null when it does not, and throws when it failed — hold the upgrade up
 * to `timeoutMs`, then proxy it; otherwise refuse with a 503 the client
 * can retry. The thread being up is never taken for the service being
 * up, and only a connected upstream is a success: a "running" service
 * nobody can connect to is refused the same way. Without this a
 * WebSocket-only page (Vite HMR, a WS app) on a sleeping thread died
 * until someone reloaded it over HTTP. A client that leaves mid-wait
 * releases its share of the wake; a wake that outlives the timeout runs
 * on for the client's next attempt. Returns what happened, for the
 * event record.
 */
export async function upgradeAfterWake(
  req: http.IncomingMessage,
  socket: stream.Duplex,
  head: Buffer,
  wake: (signal: AbortSignal) => Promise<PortalTarget | null>,
  timeoutMs = 15_000,
): Promise<WakeUpgradeOutcome> {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  guardUpgradeSocket(socket); // for the hold and the refusal after it
  const controller = new AbortController();
  const leave = () => controller.abort(new Error("client left"));
  // end as well as close: server sockets allow half-open, so a client's
  // FIN alone is 'end' — 'close' would wait for our side, i.e. forever.
  const leaving = ["close", "end", "error"] as const;
  for (const event of leaving) socket.once(event, leave);
  let timer: NodeJS.Timeout | undefined;
  try {
    const outcome = await Promise.race([
      wake(controller.signal).then(
        (target) => ({ kind: "woke" as const, target }),
        (error: unknown) => ({ kind: controller.signal.aborted ? "left" as const : "failed" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
      }),
    ]);
    if (outcome.kind === "left" || controller.signal.aborted) {
      socket.destroy();
      return { ok: false, ms: elapsed(), detail: "client left before the environment was up" };
    }
    if (outcome.kind !== "woke" || !outcome.target) {
      refuseUpgrade(socket);
      const why =
        outcome.kind === "timeout" ? `not ready after ${Math.round(timeoutMs / 1000)} s`
        : outcome.kind === "failed" ? `wake failed: ${describe(outcome.error)}`
        : "service not running";
      return { ok: false, ms: elapsed(), detail: `${why}; refused with 503` };
    }
    const target = outcome.target;
    return await new Promise<WakeUpgradeOutcome>((resolve) => {
      let settled = false;
      const settle = (result: WakeUpgradeOutcome) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      socket.once("close", () => settle({ ok: false, ms: elapsed(), detail: "client left while connecting" }));
      proxyUpgrade(req, socket, head, target, {
        connected: () => settle({ ok: true, ms: elapsed(), detail: "woke; proxied" }),
        connectError: (error) => {
          refuseUpgrade(socket);
          settle({ ok: false, ms: elapsed(), detail: `service not answering (${describe(error)}); refused with 503` });
        },
      });
    });
  } finally {
    clearTimeout(timer);
    for (const event of leaving) socket.removeListener(event, leave);
  }
}

/** Holding page while a wake/ensure runs: HTML gets a self-refreshing 202
 * (thread vocabulary only — cubes are invisible), everything else a plain
 * 503 with Retry-After so API-ish clients back off politely. */
export function respondWaking(req: http.IncomingMessage, res: http.ServerResponse, message: string): void {
  holdingPage(req, res, { html: 202, plain: 503, title: "Starting…", refreshSeconds: 3 }, message);
}

/** The service is down and its last start attempt said why: show that
 * instead of "starting…" forever. Still self-refreshing, slowly — a fixed
 * declaration heals without anyone reloading by hand. */
export function respondFailed(req: http.IncomingMessage, res: http.ServerResponse, message: string): void {
  holdingPage(req, res, { html: 502, plain: 502, title: "Not running", refreshSeconds: 10 }, message);
}
/** No service behind this address at all: a 404 page in thread vocabulary,
 * no auto-refresh (nothing is coming). */
export function respondMissing(req: http.IncomingMessage, res: http.ServerResponse, message: string): void {
  holdingPage(req, res, { html: 404, plain: 404, title: "Not here", refreshSeconds: 0 }, message);
}

function holdingPage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  page: { html: number; plain: number; title: string; refreshSeconds: number },
  message: string,
): void {
  // refreshSeconds 0 means "nothing is coming": no meta refresh (a 0 there
  // would reload continuously) and no Retry-After.
  const refresh = page.refreshSeconds > 0;
  if ((req.headers.accept ?? "").includes("text/html")) {
    res.writeHead(page.html, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><meta charset="utf-8">` +
      (refresh ? `<meta http-equiv="refresh" content="${page.refreshSeconds}">` : "") +
      `<title>${page.title}</title>` +
      `<body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0">` +
      `<p style="max-width:60ch;white-space:pre-wrap">${escapeHtml(message)}</p></body>`);
    return;
  }
  res.writeHead(page.plain, { ...(refresh ? { "retry-after": String(page.refreshSeconds) } : {}), "content-type": "text/plain" });
  res.end(`${message}\n`);
}

/** Failure detail can quote the workspace's cube.toml — never raw HTML on a
 * portal origin. */
const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Anti-CSWSH gate for cubed's OWN WebSocket (the thread terminal): a
 * WebSocket is exempt from the browser same-origin policy, so a terminal
 * that opens on a bare thread id would let any page attach, read the
 * transcript, and inject keystrokes. Accept only a same-origin browser
 * (Origin host == request Host) or a client that sends no Origin at all
 * (CLI, tests); a present-but-mismatched Origin is a cross-site attach.
 */
export function sameOriginUpgrade(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false; // unparseable/opaque Origin — treat as hostile
  }
}
