/** V9 (masterplan B-6): cubed's real Portal over a protocol-4 runner's
 * `dial` streams, as RunnerMachines.dial opens them (RunnerSession.dial at
 * the machine's fence), to dial-app.pl registered with `cube service`.
 * Shared by runner-dial-test.ts (a fake runner, offline) and
 * runner-vm-test.ts (berth vm and a keel machine). */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { GuestTransport } from "../src/guest-transport.ts";
import { Portal, portalSettings } from "../src/portal.ts";
import type { Thread } from "../src/registry.ts";
import type { MachineRef, RunnerSession } from "../src/runner-session.ts";
import { settleOperation, type Workspace } from "../src/workspace.ts";
import { NoMachines } from "./local-guest.ts";

export const DIAL_APP = path.join(import.meta.dirname, "dial-app.pl");
export const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

export interface DialPortal { portal: Portal; host: (service: string) => string; port: number; running: { value: boolean } }

/** A loopback Portal whose one thread is machine `ref` (`ref.owner`): its
 * services from `guest`, its connections from `session().dial(ref,
 * epoch(), port)`, as RunnerMachines gives them. */
export async function dialPortal(options: { session: () => RunnerSession; guest: () => GuestTransport; ref: MachineRef; epoch: () => number; directory: string }): Promise<DialPortal> {
  const free = net.createServer().listen(0, "127.0.0.1");
  await once(free, "listening");
  const port = (free.address() as net.AddressInfo).port;
  await new Promise(resolve => free.close(resolve));
  const thread = { id: options.ref.owner, archived: false, workspaceState: "available" } as Thread;
  const running = { value: true };
  class Dialed extends NoMachines {
    override running(): boolean { return running.value; }
    override guest(): GuestTransport { return options.guest(); }
    override dial(_thread: Thread, servicePort: number) { return options.session().dial(options.ref, options.epoch(), servicePort); }
  }
  const machines = new Dialed();
  const portal = new Portal({ settings: portalSettings({ CUBED_PORTAL_IP: "127.0.0.1", CUBED_PORTAL_DOMAIN: "localhost", CUBED_PORTAL_PORT: String(port) }),
    directory: options.directory, registry: { listThreads: () => [thread], getThread: (id: string) => id === thread.id ? thread : null } as never, machines, archiving: () => false });
  await portal.listen();
  assert.equal(portal.state, "listening");
  return { portal, port, running, host: service => `${service}-${portal.label(thread.id)}.localhost:${port}` };
}

/** Runs `listener` (a command that keeps running) in the machine, waits
 * until `probe` prints `expect`, runs `during`, then cancels the listener.
 * All under ONE writable lease: a workspace has one writable owner, so the
 * probe runs on the listener's lease, never on a second one. */
export async function withListener(workspace: Workspace, key: string, command: { listener: string; probe: string; expect: string },
  during: () => Promise<void>): Promise<void> {
  const lease = await workspace.lease({ owner: "pi" });
  try {
    await workspace.exec(lease.token, key, { command: command.listener, timeoutMs: 600000 });
    try {
      await workspace.exec(lease.token, `${key}-probe`, { command: command.probe, timeoutMs: 60000 });
      const probed = await settleOperation(workspace, lease.token, `${key}-probe`);
      assert.ok(probed.state === "succeeded" && probed.exitCode === 0, `${key}: the probe: ${JSON.stringify(probed)}`);
      assert.equal(Buffer.from(probed.output).toString("utf8").trim(), command.expect, `${key}: the listener answers inside the machine`);
      await during();
    } finally { await workspace.cancel(lease.token, key).catch(() => {}); }
  } finally { await workspace.release(lease.token).catch(() => {}); }
}

/** One HTTP request to the portal with an exact Host. */
export function request(port: number, host: string, method: string, target: string, body?: Buffer): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: target, agent: false,
      headers: { host, ...(body ? { "content-length": String(body.length) } : {}) } }, response => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** A raw connection to the portal that keeps what it read and says when the other side's FIN came. */
export class Raw {
  readonly socket: net.Socket;
  data = Buffer.alloc(0);
  ended = false;
  closed = false;
  private wake = () => {};
  private constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on("data", (chunk: Buffer) => { this.data = Buffer.concat([this.data, chunk]); this.wake(); });
    socket.on("end", () => { this.ended = true; this.wake(); });
    socket.on("close", () => { this.closed = true; this.wake(); });
    socket.on("error", () => {});
  }
  static async open(port: number, head: string): Promise<Raw> {
    const socket = net.connect({ host: "127.0.0.1", port, allowHalfOpen: true });
    await once(socket, "connect");
    const raw = new Raw(socket);
    socket.write(head);
    return raw;
  }
  async until(what: string, check: (raw: Raw) => boolean, ms = 30000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check(this)) {
      assert.ok(Date.now() < deadline, `${what}: ${this.data.length} bytes, ended=${this.ended}, closed=${this.closed}: ${JSON.stringify(this.data.subarray(0, 300).toString("latin1"))}`);
      await new Promise<void>(resolve => { this.wake = resolve; setTimeout(resolve, 100); });
    }
  }
  /** The answer head (after it came) and what followed it. */
  async head(): Promise<string> {
    await this.until("an answer head", raw => raw.data.includes("\r\n\r\n") || raw.ended);
    const at = this.data.indexOf("\r\n\r\n");
    assert.ok(at >= 0, `no answer head: ${this.data.toString("latin1")}`);
    const head = this.data.subarray(0, at).toString("latin1");
    this.data = this.data.subarray(at + 4);
    return head;
  }
}

function frame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const length = payload.length < 126 ? Buffer.from([0x80 | payload.length])
    : payload.length < 65536 ? Buffer.from([0x80 | 126, payload.length >> 8, payload.length & 255])
      : Buffer.concat([Buffer.from([0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(payload.length)); return b; })()]);
  const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]!));
  return Buffer.concat([Buffer.from([0x80 | opcode]), length, mask, masked]);
}

/** A server frame (unmasked) at the start of `data`, or null while it is incomplete. */
function serverFrame(data: Buffer): { opcode: number; payload: Buffer; size: number } | null {
  if (data.length < 2) return null;
  let length = data[1]! & 127, at = 2;
  if (length === 126) { if (data.length < 4) return null; length = data.readUInt16BE(2); at = 4; }
  else if (length === 127) { if (data.length < 10) return null; length = Number(data.readBigUInt64BE(2)); at = 10; }
  if (data.length < at + length) return null;
  return { opcode: data[0]! & 15, payload: data.subarray(at, at + length), size: at + length };
}

/** The V9 contract through the portal: HTTP 200 with the known body, 1 MiB
 * up and back (sha256), a WebSocket (handshake, a 100 KiB message echoed,
 * close), and FIN from each side on its own. `readState` reads a file the
 * app wrote in its state directory (null while there is none). Returns
 * what it saw, for the test's notes. */
export async function portalContract(target: DialPortal, service: string, readState: (name: string) => Promise<string | null>): Promise<string[]> {
  const host = target.host(service);
  const seen: string[] = [];

  const hello = await request(target.port, host, "GET", "/");
  assert.equal(hello.status, 200, hello.body.toString());
  assert.equal(hello.body.toString(), `dial-app: hello from ${service}\n`);
  seen.push(`HTTP 200 "${hello.body.toString().trim()}"`);

  const mib = randomBytes(1 << 20);
  const t0 = Date.now();
  const echoed = await request(target.port, host, "POST", "/echo", mib);
  assert.equal(echoed.status, 200);
  assert.equal(echoed.body.length, mib.length, "1 MiB back");
  assert.equal(sha256(echoed.body), sha256(mib), "1 MiB up and back, byte for byte");
  seen.push(`1 MiB up and 1 MiB back in ${Date.now() - t0} ms, sha256 ${sha256(mib).slice(0, 16)}… both ways`);

  // A WebSocket: the handshake's accept key is the app's own answer to ours.
  const key = randomBytes(16).toString("base64");
  const ws = await Raw.open(target.port, `GET /ws HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`);
  const wsHead = await ws.head();
  assert.match(wsHead, /^HTTP\/1\.1 101 /);
  const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  assert.match(wsHead, new RegExp(`\r\nsec-websocket-accept: ${accept.replace(/[+/]/g, "\\$&")}`, "i"));
  const message = randomBytes(100 * 1024);
  ws.socket.write(frame(2, message));
  await ws.until("the echoed message", raw => serverFrame(raw.data) !== null);
  const echo = serverFrame(ws.data)!;
  assert.equal(echo.opcode, 2);
  assert.equal(sha256(echo.payload), sha256(message), "the WebSocket message came back");
  ws.data = ws.data.subarray(echo.size);
  ws.socket.write(frame(8, Buffer.alloc(0)));
  await ws.until("the close frame and the end", raw => raw.ended && serverFrame(raw.data)?.opcode === 8);
  ws.socket.end();
  await ws.until("closed", raw => raw.closed);
  seen.push(`WebSocket: 101 with sec-websocket-accept ${accept}, a 100 KiB message echoed (sha256), close frame, then FIN`);

  // FIN from the browser first: the app answers only after it read our FIN.
  const up = randomBytes(256 * 1024);
  const client = await Raw.open(target.port, `GET /fin-client HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: cube-test\r\n\r\n`);
  assert.match(await client.head(), /^HTTP\/1\.1 101 /);
  client.socket.end(up);
  await client.until("the answer after our FIN, then the app's FIN", raw => raw.ended);
  assert.equal(client.data.toString(), `got ${up.length} ${sha256(up)}\n`);
  seen.push(`FIN from the portal's side first: the app read ${up.length} bytes to it, then answered and closed (FIN back)`);

  // FIN from the guest first: our side still sends after it.
  const id = randomBytes(6).toString("hex");
  const guest = await Raw.open(target.port, `GET /fin-guest?${id} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: cube-test\r\n\r\n`);
  assert.match(await guest.head(), /^HTTP\/1\.1 101 /);
  await guest.until("the app's FIN", raw => raw.ended);
  assert.equal(guest.data.toString(), "guest-first\n");
  assert.ok(!guest.closed && guest.socket.writable, "our side is still open after the app's FIN");
  const late = randomBytes(256 * 1024);
  guest.socket.end(late);
  let state: string | null = null;
  for (let i = 0; i < 300 && state === null; i++) { state = await readState(`fin-${id}`); if (state === null) await delay(100); }
  assert.equal(state?.trim(), `${late.length} ${sha256(late)}`, "the app read what we sent after its FIN, to our FIN");
  await guest.until("closed", raw => raw.closed);
  seen.push(`FIN from the app first: ${late.length} bytes sent after it reached the app, then our FIN ended its read`);
  return seen;
}
