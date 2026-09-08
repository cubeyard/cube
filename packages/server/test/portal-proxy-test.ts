/**
 * Offline unit test for Host-header portal routing + the HTTP/upgrade
 * proxy, against a real loopback upstream.
 *
 *   node packages/server/test/portal-proxy-test.ts
 */
import assert from "node:assert";
import http from "node:http";
import net from "node:net";

import { portalLabel, proxyHttp, proxyUpgrade, respondFailed, respondWaking } from "../src/portal-proxy.ts";

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
front.on("upgrade", (req, socket, head) => {
  proxyUpgrade(req, socket, head, { ip: "127.0.0.1", port: upstreamPort });
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

upstream.closeAllConnections();
front.closeAllConnections();
upstream.close();
front.close();
console.log("portal-proxy-test: all ok");
