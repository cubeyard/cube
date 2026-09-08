/**
 * Host-header portal routing (PLAN §10). Portals share cubed's main
 * listener: a request whose Host is `<label>.<PORTAL_BASE>` is proxied to
 * the owning cube; everything else falls through to the UI/API. Plain
 * node:http/net — HTTP(S)/WebSocket only, by design (no port allocator,
 * nothing raw-TCP to route on).
 */
import http from "node:http";
import net from "node:net";
import type stream from "node:stream";

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
      upstreamRes.pipe(res);
    },
  );
  upstream.on("error", (error: NodeJS.ErrnoException) => {
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
): void {
  const upstream = net.connect(target.port, target.ip, () => {
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
  const drop = () => {
    upstream.destroy();
    socket.destroy();
  };
  // end/close, not just error: http.Server sockets are allowHalfOpen, so a
  // peer's FIN emits only 'end' and the pair would idle half-open forever.
  // A WebSocket has no meaningful half-close — either side ending tears
  // down both.
  for (const side of [upstream, socket] as const) {
    side.on("error", drop);
    side.on("end", drop);
    side.on("close", drop);
  }
}

/** Holding page while a wake/ensure runs: HTML gets a self-refreshing 202
 * (thread vocabulary only — cubes are invisible), everything else a plain
 * 503 with Retry-After so API-ish clients back off politely. */
export function respondWaking(req: http.IncomingMessage, res: http.ServerResponse, message: string): void {
  if ((req.headers.accept ?? "").includes("text/html")) {
    res.writeHead(202, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3">` +
      `<title>Starting…</title>` +
      `<body style="font-family:system-ui;display:grid;place-items:center;min-height:100vh;margin:0">` +
      `<p>${message}</p></body>`);
    return;
  }
  res.writeHead(503, { "retry-after": "3", "content-type": "text/plain" });
  res.end(`${message}\n`);
}

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
