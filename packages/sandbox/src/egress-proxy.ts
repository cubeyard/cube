/**
 * Allowlist egress proxy (PLAN §12). One instance per cube, bound to the
 * cube's bridge gateway; the cube reaches the outside ONLY through it
 * (HTTP(S)_PROXY is set inside the cube; the bridge has no NAT and the cube
 * no default route, so proxy-ignorant traffic cannot leave at all).
 *
 * Threat model: the client is an untrusted agent, and the allowlist itself
 * may come from agent-writable config (.cube/cube.toml). Hence:
 * - hostname allowlist AND port allowlist (default 80/443),
 * - resolved addresses are vetted — an allowed name pointing at loopback /
 *   RFC1918 / link-local (DNS rebinding) must not turn the proxy into an
 *   SSRF tunnel to host services; connections go to the vetted IP, not
 *   through a second resolution,
 * - optional source pinning to the cube's IP, so one cube cannot route to
 *   another cube's (more permissive) proxy across bridges,
 * - all sockets tracked so close() actually closes (CONNECT tunnels are
 *   upgraded sockets that server.closeAllConnections() does not cover).
 *
 * Zero-dependency: plain node:http for absolute-URI requests, CONNECT
 * tunneling for HTTPS.
 */
import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";

export interface EgressPolicy {
  /** Allowed hostnames: "registry.npmjs.org" (exact) or "*.ubuntu.com". */
  allow: string[];
  /** Allowed upstream ports (default 80 + 443 — package traffic only). */
  allowPorts?: number[];
  /** When set, only these client IPs may use the proxy (the cube's IP). */
  allowSource?: string[];
  /** Called on every denied request (surface in the UI / logs). */
  onDeny?: (host: string, kind: "connect" | "http" | "source" | "resolve") => void;
}

export interface EgressProxy {
  readonly port: number;
  close(): Promise<void>;
}

function makeMatcher(allow: string[]): (host: string) => boolean {
  const exact = new Set<string>();
  const suffixes: string[] = [];
  for (const raw of allow) {
    const entry = raw.toLowerCase().replace(/\.$/, "");
    if (entry.startsWith("*.")) suffixes.push(entry.slice(1)); // ".ubuntu.com"
    else if (entry.startsWith(".")) suffixes.push(entry);
    else exact.add(entry);
  }
  return (host) => {
    const h = host.toLowerCase().replace(/\.$/, "");
    return exact.has(h) || suffixes.some((s) => h.endsWith(s));
  };
}

const stripMapped = (ip: string) => ip.replace(/^::ffff:/i, "");

/** Only plain public unicast addresses may be tunneled to. */
export function isPublicAddress(raw: string): boolean {
  const ip = stripMapped(raw);
  if (net.isIPv4(ip)) {
    const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
    if (a === 169 && b === 254) return false; // link-local
    if (a === 172 && b >= 16 && b <= 31) return false; // private 172.16/12
    if (a === 192 && b === 168) return false; // private 192.168/16
    if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
    if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking 198.18/15
    if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
    if (a >= 224) return false; // multicast + reserved + broadcast
    return true;
  }
  if (net.isIPv6(ip)) {
    const h = ip.toLowerCase();
    if (h === "::" || h === "::1") return false;
    if (h.startsWith("fc") || h.startsWith("fd")) return false; // ULA fc00::/7
    if (/^fe[89ab]/.test(h)) return false; // link-local fe80::/10
    if (/^fec/.test(h) || /^fe[def]/.test(h)) return false; // deprecated site-local fec0::/10
    if (h.startsWith("ff")) return false; // multicast
    return true;
  }
  return false;
}

/**
 * Resolve `host` and return an address safe to connect to, or null. If ANY
 * resolved address is non-public the whole name is rejected (round-robin
 * rebinding must not win a retry lottery).
 */
async function resolveVetted(host: string): Promise<string | null> {
  if (net.isIP(host)) return isPublicAddress(host) ? host : null;
  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    return null;
  }
  if (addresses.length === 0) return null;
  if (!addresses.every((a) => isPublicAddress(a.address))) return null;
  return addresses[0]!.address;
}

export function startEgressProxy(
  opts: { listenHost: string; port: number } & EgressPolicy,
): Promise<EgressProxy> {
  const allowed = makeMatcher(opts.allow);
  const portList = opts.allowPorts ?? [80, 443];
  for (const p of portList) {
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      return Promise.reject(new Error(`egress proxy: invalid allowPorts entry ${p}`));
    }
  }
  const ports = new Set(portList);
  const sources = opts.allowSource ? new Set(opts.allowSource.map(stripMapped)) : null;
  const tunnels = new Set<net.Socket>();

  const sourceOk = (socket: net.Socket): boolean => {
    if (!sources) return true;
    const remote = stripMapped(socket.remoteAddress ?? "");
    if (sources.has(remote)) return true;
    opts.onDeny?.(remote, "source");
    return false;
  };

  const server = http.createServer((req, res) => {
    // The request path is async (DNS); an EventEmitter listener that returns
    // a rejected promise would crash the process, so isolate it here.
    handleHttp(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
  });

  const handleHttp = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    if (!sourceOk(req.socket)) {
      res.writeHead(403).end();
      return;
    }
    // Plain-HTTP proxying: clients send an absolute URI.
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("egress proxy: absolute-form URI required\n");
      return;
    }
    const port = Number(url.port) || 80;
    if (!allowed(url.hostname) || !ports.has(port)) {
      opts.onDeny?.(url.hostname, "http");
      res.writeHead(403).end(`egress proxy: ${url.host} is not on the allowlist\n`);
      return;
    }
    const address = await resolveVetted(url.hostname);
    if (!address) {
      opts.onDeny?.(url.hostname, "resolve");
      res.writeHead(403).end(`egress proxy: ${url.hostname} does not resolve to a public address\n`);
      return;
    }
    const upstream = http.request(
      {
        host: address,
        port,
        method: req.method,
        path: url.pathname + url.search,
        headers: { ...req.headers, host: url.host },
        setHost: false,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  };

  // HTTPS: CONNECT host:port -> raw tunnel. The proxy resolves the hostname
  // itself, so cubes need no working DNS for allowed HTTPS traffic.
  server.on("connect", (req, clientSocket, head) => {
    handleConnect(req, clientSocket as net.Socket, head).catch(() => {
      (clientSocket as net.Socket).destroy();
    });
  });

  const handleConnect = async (req: http.IncomingMessage, clientSocket: net.Socket, head: Buffer) => {
    if (!sourceOk(clientSocket)) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const [host = "", portRaw] = (req.url ?? "").split(":");
    const port = Number(portRaw) || 443;
    if (!allowed(host) || !ports.has(port)) {
      opts.onDeny?.(host, "connect");
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const address = await resolveVetted(host);
    if (!address) {
      opts.onDeny?.(host, "resolve");
      clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const upstream = net.connect(port, address, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    // Track both ends and tie their lifetimes together: pipe() alone leaves
    // the peer half-open on abrupt close, and upgraded sockets are invisible
    // to server.closeAllConnections().
    tunnels.add(upstream).add(clientSocket);
    const cleanup = (a: net.Socket, b: net.Socket) => () => {
      tunnels.delete(a);
      b.destroy();
    };
    upstream.on("close", cleanup(upstream, clientSocket));
    clientSocket.on("close", cleanup(clientSocket, upstream));
    upstream.on("error", () => upstream.destroy());
    clientSocket.on("error", () => clientSocket.destroy());
  };

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.listenHost, () => {
      resolve({
        port: opts.port,
        close: () =>
          new Promise<void>((res) => {
            for (const socket of tunnels) socket.destroy();
            tunnels.clear();
            server.closeAllConnections();
            server.close(() => res());
          }),
      });
    });
  });
}
