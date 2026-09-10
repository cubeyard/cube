/**
 * Offline unit test for Host-header portal routing + the HTTP/upgrade
 * proxy, against a real loopback upstream.
 *
 *   node packages/server/test/portal-proxy-test.ts
 */
import assert from "node:assert";
import http from "node:http";
import net from "node:net";

import stream from "node:stream";

import { guardUpgradeSocket, portalLabel, proxyHttp, proxyUpgrade, refuseUpgrade, respondFailed, respondWaking, upgradeAfterWake, type PortalTarget, type WakeUpgradeOutcome } from "../src/portal-proxy.ts";

const BASE = "cube.internal";

// --- label extraction
assert.equal(portalLabel("web--t-abc.cube.internal", BASE), "web--t-abc");
assert.equal(portalLabel("web--t-abc.cube.internal:7777", BASE), "web--t-abc");
assert.equal(portalLabel("WEB--T-ABC.CUBE.INTERNAL:7777", BASE), "web--t-abc");
assert.equal(portalLabel("cube.internal:7777", BASE), null); // the base itself = UI
assert.equal(portalLabel("localhost:7777", BASE), null);
assert.equal(portalLabel("a.b.cube.internal", BASE), null); // two labels: nobody registers those
assert.equal(portalLabel(".cube.internal", BASE), null);
assert.equal(portalLabel("evil-cube.internal", BASE), null); // suffix must be a label boundary
assert.equal(portalLabel(undefined, BASE), null);
console.log("1 ok: portalLabel");

// --- HTTP proxying end to end (headers, body, status, x-forwarded-*)
const upstream = http.createServer((req, res) => {
  if (req.url === "/dies") {
    // headers + half a body, then the service drops the socket
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("partial");
    setTimeout(() => req.socket.destroy(), 50);
    return;
  }
  if (req.url === "/echo") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(201, { "x-upstream": "yes" });
      res.end(JSON.stringify({
        host: req.headers.host,
        forwardedHost: req.headers["x-forwarded-host"],
        method: req.method,
        body,
      }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});
upstream.on("upgrade", (req, socket) => {
  socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n");
  socket.on("data", (chunk) => socket.write(chunk)); // echo
});
await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamPort = (upstream.address() as net.AddressInfo).port;

const front = http.createServer((req, res) => {
  const label = portalLabel(req.headers.host, BASE);
  if (label === "down--x") {
    return proxyHttp(req, res, { ip: "127.0.0.1", port: 1 }, () => respondWaking(req, res, "Starting…"));
  }
  if (label === "broken--x") {
    return respondFailed(req, res, `web: exited before becoming ready <b>${req.url}</b>`);
  }
  if (label !== null) {
    return proxyHttp(req, res, { ip: "127.0.0.1", port: upstreamPort }, () => {
      res.writeHead(599);
      res.end();
    });
  }
  res.writeHead(200);
  res.end("ui");
});
// Outcomes of the wake-then-upgrade path, by label, for the assertions.
const wakeOutcomes = new Map<string, Promise<WakeUpgradeOutcome>>();
front.on("upgrade", (req, socket, head) => {
  const label = portalLabel(req.headers.host, BASE);
  const live = { ip: "127.0.0.1", port: upstreamPort };
  const hold = (wake: (signal: AbortSignal) => Promise<PortalTarget | null>, timeoutMs?: number) =>
    void wakeOutcomes.set(label!, upgradeAfterWake(req, socket, head, wake, timeoutMs));
  // The thread wakes in 100 ms and the ensure reports the service running.
  if (label === "sleepy--x") return hold(async () => { await new Promise((r) => setTimeout(r, 100)); return live; });
  // A wake that never settles on its own — only the client leaving ends it.
  if (label === "stuck--x" || label === "left--x") {
    return hold(
      (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
      label === "stuck--x" ? 200 : 5_000);
  }
  // The thread woke but the service is not up: reported not running,
  // failed, or "running" on a port nobody listens on.
  if (label === "notrunning--x") return hold(async () => null);
  if (label === "failing--x") return hold(async () => { throw new Error("web: exited before becoming ready"); });
  if (label === "dead--x") return hold(async () => ({ ip: "127.0.0.1", port: 1 }));
  proxyUpgrade(req, socket, head, live);
});
await new Promise<void>((r) => front.listen(0, "127.0.0.1", r));
const frontPort = (front.address() as net.AddressInfo).port;

// fetch() forbids overriding Host — raw http.request it is.
function request(opts: http.RequestOptions, body?: string): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    // agent:false — keep-alive sockets would hold the event loop open
    // after the servers close.
    const req = http.request({ host: "127.0.0.1", port: frontPort, agent: false, ...opts }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const proxied = await request(
  { path: "/echo", method: "POST", headers: { host: `web--t-abc.${BASE}:${frontPort}` } },
  "ping",
);
assert.equal(proxied.status, 201);
assert.equal(proxied.headers["x-upstream"], "yes");
const echoed = JSON.parse(proxied.body);
assert.equal(echoed.method, "POST");
assert.equal(echoed.body, "ping");
// Host preserved end-to-end: dev servers build absolute URLs from it.
assert.equal(echoed.host, `web--t-abc.${BASE}:${frontPort}`);
assert.equal(echoed.forwardedHost, `web--t-abc.${BASE}:${frontPort}`);
console.log("2 ok: http proxy (status/headers/body/host preserved)");

// --- non-portal host falls through to the UI
const ui = await request({ path: "/", headers: { host: "localhost" } });
assert.equal(ui.body, "ui");
console.log("3 ok: non-portal host -> UI");

// --- connect-refused upstream takes the onConnectError path (holding page)
const down = await request({ path: "/", headers: { host: `down--x.${BASE}`, accept: "text/html" } });
assert.equal(down.status, 202);
assert.match(down.body, /Starting…/);
const downPlain = await request({ path: "/", headers: { host: `down--x.${BASE}` } });
assert.equal(downPlain.status, 503);
assert.equal(downPlain.headers["retry-after"], "3");
console.log("4 ok: refused upstream -> waking page (202 html / 503 plain)");

// --- a service that failed to start gets the failure page (escaped, slow
// refresh), not the eternal "starting…"
const broken = await request({ path: "/x", headers: { host: `broken--x.${BASE}`, accept: "text/html" } });
assert.equal(broken.status, 502);
assert.match(broken.body, /content="10"/);
assert.match(broken.body, /exited before becoming ready &#60;b&#62;/);
assert.ok(!broken.body.includes("<b>"), "failure detail must be escaped");
const brokenPlain = await request({ path: "/x", headers: { host: `broken--x.${BASE}` } });
assert.equal(brokenPlain.status, 502);
assert.equal(brokenPlain.headers["retry-after"], "10");
console.log("4b ok: failed service -> failure page (502, escaped, refresh 10)");

// --- upstream dying mid-body ends the client request instead of hanging it
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("client request hung after upstream died")), 3_000);
  const req = http.request(
    { host: "127.0.0.1", port: frontPort, path: "/dies", agent: false, headers: { host: `web--t-abc.${BASE}` } },
    (res) => {
      res.on("data", () => {});
      const done = () => (clearTimeout(timer), resolve());
      res.on("end", done);
      res.on("error", done);
      res.on("close", done);
    },
  );
  req.on("error", () => (clearTimeout(timer), resolve()));
  req.end();
});
console.log("4c ok: upstream death mid-body ends the client request");

// --- upgrade pass-through: handshake + echo both ways
await new Promise<void>((resolve, reject) => {
  const socket = net.connect(frontPort, "127.0.0.1", () => {
    socket.write(
      `GET /ws HTTP/1.1\r\nHost: web--t-abc.${BASE}\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n`,
    );
  });
  let buffer = "";
  let upgraded = false;
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (!upgraded && buffer.includes("\r\n\r\n")) {
      assert.match(buffer, /HTTP\/1\.1 101/);
      upgraded = true;
      buffer = buffer.slice(buffer.indexOf("\r\n\r\n") + 4);
      socket.write("marco");
      return;
    }
    if (upgraded && buffer.includes("marco")) {
      socket.destroy();
      resolve();
    }
  });
  socket.on("error", reject);
  setTimeout(() => reject(new Error("upgrade echo timed out")), 5_000).unref();
});
console.log("5 ok: websocket-style upgrade proxied both ways");

// --- a WebSocket to a sleeping thread's portal is held through the wake,
// then proxied: the handshake completes and the echo works.
function upgrade(label: string): Promise<{ status: string; headers: string; socket: net.Socket }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(frontPort, "127.0.0.1", () => {
      socket.write(`GET /ws HTTP/1.1\r\nHost: ${label}.${BASE}\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n`);
    });
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\r\n\r\n")) return;
      socket.removeListener("data", onData);
      const headers = buffer.slice(0, buffer.indexOf("\r\n\r\n"));
      socket.unshift(Buffer.from(buffer.slice(headers.length + 4)));
      resolve({ status: headers.split("\r\n")[0]!, headers, socket });
    };
    socket.on("data", onData);
    socket.on("error", reject);
    setTimeout(() => reject(new Error(`upgrade to ${label} timed out`)), 5_000).unref();
  });
}
{
  const started = Date.now();
  const { status, socket } = await upgrade("sleepy--x");
  assert.match(status, /HTTP\/1\.1 101/);
  assert.ok(Date.now() - started >= 90, "the upgrade waited for the wake");
  const echoed = await new Promise<string>((resolve) => {
    socket.once("data", (chunk) => resolve(chunk.toString("utf8")));
    socket.write("polo");
  });
  assert.equal(echoed, "polo");
  socket.destroy();
  const outcome = await wakeOutcomes.get("sleepy--x")!;
  assert.equal(outcome.ok, true);
  assert.ok(outcome.ms >= 90 && outcome.ms < 4_000, `recorded ${outcome.ms} ms`);
  assert.match(outcome.detail, /woke; proxied/);
  console.log("5b ok: an upgrade to a sleeping portal is held through the wake, then proxied");
}

// --- a wake that does not make it in time is refused with a real 503 the
// client can retry, not a bare socket close.
{
  const { status, headers, socket } = await upgrade("stuck--x");
  assert.match(status, /HTTP\/1\.1 503 Service Unavailable/);
  assert.match(headers, /\r\nRetry-After: 5\r\n/);
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  const outcome = await wakeOutcomes.get("stuck--x")!;
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /not ready after 0 s; refused with 503/);
  console.log("5c ok: a wake that outlasts the hold is refused with 503 + Retry-After");
}

// --- a client that leaves mid-wake releases its share of the wake (the
// signal it was given fires) and is not answered.
{
  const socket = net.connect(frontPort, "127.0.0.1", () => {
    socket.write(`GET /ws HTTP/1.1\r\nHost: left--x.${BASE}\r\nUpgrade: echo\r\nConnection: Upgrade\r\n\r\n`);
    setTimeout(() => socket.destroy(), 50);
  });
  for (const deadline = Date.now() + 2_000; !wakeOutcomes.has("left--x"); ) {
    if (Date.now() > deadline) throw new Error("the front never saw the upgrade");
    await new Promise((r) => setTimeout(r, 10));
  }
  const outcome = await wakeOutcomes.get("left--x")!;
  assert.equal(outcome.ok, false);
  assert.match(outcome.detail, /client left/);
  assert.ok(outcome.ms < 2_000, "settled as soon as the client left, not at the timeout");
  console.log("5d ok: a client leaving mid-wake cancels its wait");
}

// --- the thread being up is not the service being up: a service the
// ensure reports down, one that failed, and one "running" that nobody can
// connect to are all refused with a 503 — never proxied, never recorded ok.
for (const [label, expected] of [
  ["notrunning--x", /service not running; refused with 503/],
  ["failing--x", /wake failed: web: exited before becoming ready; refused with 503/],
  ["dead--x", /service not answering \(connect ECONNREFUSED [^)]+\); refused with 503/],
] as const) {
  const { status, headers, socket } = await upgrade(label);
  assert.match(status, /HTTP\/1\.1 503 Service Unavailable/, label);
  assert.match(headers, /\r\nRetry-After: 5\r\n/);
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  const outcome = await wakeOutcomes.get(label)!;
  assert.equal(outcome.ok, false, label);
  assert.match(outcome.detail, expected);
}
console.log("5e ok: a service that is down, failed, or not answering is refused with 503, never recorded ok");

// --- a reset while refusing or holding an upgrade must not crash cubed:
// node drops its own socket error listener before 'upgrade', so without a
// guard the ECONNRESET is an unhandled 'error'. Reproduced in memory.
class ResetOnWrite extends stream.Duplex {
  _read(): void {}
  _write(_chunk: unknown, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    callback(Object.assign(new Error("write ECONNRESET"), { code: "ECONNRESET" }));
  }
}
async function uncaughtDuring(run: () => Promise<void>): Promise<unknown> {
  let caught: unknown = null;
  const onUncaught = (error: unknown) => { caught = error; };
  process.on("uncaughtException", onUncaught);
  try {
    await run();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("uncaughtException", onUncaught);
  }
  return caught;
}
{
  // The reproduction: an unguarded socket's write error is uncaught.
  const bare = new ResetOnWrite();
  assert.match(String(await uncaughtDuring(async () => { bare.end("x"); })), /ECONNRESET/);
  // The immediate refusal (the "still setting up" path) is guarded by itself.
  const refused = new ResetOnWrite();
  assert.equal(await uncaughtDuring(async () => {
    refuseUpgrade(refused);
    await new Promise((r) => refused.once("close", r));
  }), null);
  // The held path: the refusal after the wait settles is guarded too.
  const held = new ResetOnWrite();
  const req = { method: "GET", url: "/ws", rawHeaders: [] } as unknown as http.IncomingMessage;
  assert.equal(await uncaughtDuring(async () => {
    const outcome = await upgradeAfterWake(req, held, Buffer.alloc(0), async () => null, 1_000);
    assert.equal(outcome.ok, false);
    await new Promise((r) => (held.destroyed ? r(null) : held.once("close", r)));
  }), null);
  // The handler's own guard covers a socket it only ever destroys.
  const dropped = new ResetOnWrite();
  guardUpgradeSocket(dropped);
  guardUpgradeSocket(dropped); // idempotent: one listener, not two
  assert.equal(dropped.listenerCount("error"), 1);
  assert.equal(await uncaughtDuring(async () => { dropped.end("x"); }), null);
  console.log("6 ok: a reset while refusing, holding or dropping an upgrade is not an unhandled error");
}

upstream.closeAllConnections();
front.closeAllConnections();
upstream.close();
front.close();
console.log("portal-proxy-test: all ok");
