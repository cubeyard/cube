/** cubed's side of runner protocol 4's `dial` streams (masterplan B-6):
 * RunnerSession.dial over a real Iroh connection on loopback to a fake
 * runner that speaks the protocol (hello, then `dial`: its refusal, or
 * `StreamAnswer` and then a TCP connection to dial-app.pl on this host, as
 * berth vm's LAN would give), RunnerMachines.dial, and cubed's real Portal
 * over it (portal-dial.ts: HTTP, 1 MiB each way, a WebSocket, FIN from each
 * side). The refusals are the fake's: berth's rules are tested in berth
 * (vm/mod.rs, vm/egress/tests/dial.rs) and on a keel machine in
 * runner-vm-test.ts (V9). */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf";
import { Endpoint, SecretKey, type BiStream, type Connection } from "@number0/iroh/index.js";
import { Code, HelloAnswerSchema, OpenSchema, StreamAnswerSchema } from "../src/gen/runner_pb.js";
import type { Thread } from "../src/registry.ts";
import { RunnerMachines } from "../src/runner-machines.ts";
import { RunnerError, RunnerSession, type SessionConfig } from "../src/runner-session.ts";
import { nextMachineEpoch } from "../src/vm.ts";
import { DIAL_APP, dialPortal, portalContract, Raw, request, sha256 } from "./portal-dial.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cube-dial-")));

// ---------------------------------------------------------------- the app

const free = net.createServer().listen(0, "127.0.0.1");
await once(free, "listening");
const appPort = (free.address() as net.AddressInfo).port;
await new Promise(resolve => free.close(resolve));
const state = path.join(root, "app");
fs.mkdirSync(state);
const app = spawn("perl", [DIAL_APP], { env: { ...process.env, HOST: "127.0.0.1", PORT: String(appPort), CUBE_SERVICE: "dialapp", CUBE_APP_STATE: state },
  stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((resolve, reject) => {
  app.stdout!.on("data", (chunk: Buffer) => { if (chunk.toString().includes("listening on")) resolve(); });
  app.once("exit", code => reject(new Error(`dial-app.pl exited (${code})`)));
});

// ---------------------------------------------------------------- the fake runner

const ALPN = Array.from(Buffer.from("cubeyard/runner/4"));
const builder = Endpoint.builder();
builder.applyMinimal();
builder.secretKey(SecretKey.generate().toBytes());
builder.alpns([ALPN]);
builder.bindAddr("127.0.0.1:0");
const runnerEndpoint = await builder.bind();
const address = runnerEndpoint.boundSockets().find(a => a.startsWith("127.0.0.1:"))!;
const controlKey = path.join(root, "control.key");
fs.writeFileSync(controlKey, randomBytes(32), { mode: 0o600 });

function frame(payload: string): number[] {
  const bytes = Buffer.from(payload);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Array.from(Buffer.concat([header, bytes]));
}
async function readFrame(stream: BiStream): Promise<string> {
  const length = Buffer.from(await stream.recv.readExact(4)).readUInt32BE();
  return Buffer.from(await stream.recv.readExact(length)).toString("utf8");
}
const answer = (error?: { code: Code; reason: string; message: string }) => frame(toJsonString(StreamAnswerSchema, create(StreamAnswerSchema, error ? { error } : {})));

/** What the fake runner saw of each dial. */
interface Dialed { port: number; epoch: bigint; ref: string; fin: boolean; reset: boolean; done: Promise<void> }
const dials: Dialed[] = [];
let machineRunning = true;
const MACHINE = { owner: "thread-1", id: "0123456789abcdef" };

/** The runner's half: the stream and a TCP connection to the app, each
 * direction ending on its own; a reset from cubed drops the connection. */
function carry(stream: BiStream, socket: net.Socket, seen: Dialed): Promise<void> {
  const toApp = (async () => {
    for (;;) {
      let chunk: number[];
      try { chunk = await stream.recv.read(256 * 1024); } catch { seen.reset = true; socket.destroy(); return; }
      if (chunk.length === 0) { seen.fin = true; socket.end(); return; }
      if (!socket.write(Buffer.from(chunk))) await Promise.race([once(socket, "drain"), once(socket, "close")]);
    }
  })();
  const toCubed = (async () => {
    try {
      // Not a plain `for await`: it would destroy the socket at the app's FIN.
      for await (const chunk of socket.iterator({ destroyOnReturn: false }) as AsyncIterable<Buffer>) await stream.send.writeAll(Array.from(chunk));
      await stream.send.finish();
    } catch { void stream.send.reset(0n).catch(() => {}); }
  })();
  return Promise.all([toApp, toCubed]).then(() => {});
}

let fromCubed: Connection | undefined;
void (async () => {
  for (;;) {
    const incoming = await runnerEndpoint.acceptNext();
    if (!incoming) return;
    const connection = await (await incoming.accept()).connect();
    fromCubed = connection;
    void (async () => {
      for (;;) {
        let stream: BiStream;
        try { stream = await connection.acceptBi(); } catch { return; }
        void (async () => {
          const opened = fromJsonString(OpenSchema, await readFrame(stream));
          if (opened.kind.case === "hello") {
            await stream.send.writeAll(frame(toJsonString(HelloAnswerSchema, create(HelloAnswerSchema, { protocol: 4, runner: { nodeId: "node-r1" } }))));
            await stream.send.finish();
            return;
          }
          if (opened.kind.case !== "dial") return;
          const header = opened.kind.value;
          let finish = () => {};
          const seen: Dialed = { port: header.port, epoch: header.fence?.epoch ?? 0n, ref: `${header.ref?.owner}/${header.ref?.id}`, fin: false, reset: false,
            done: new Promise<void>(resolve => { finish = resolve; }) };
          dials.push(seen);
          const refuse = async (code: Code, reason: string, message: string) => { await stream.send.writeAll(answer({ code, reason, message })); await stream.send.finish(); finish(); };
          if (header.port < 1024) return refuse(Code.PERMISSION_DENIED, "port", `dialling port ${header.port} is not allowed; only 1024 to 65535`);
          if (seen.ref !== `${MACHINE.owner}/${MACHINE.id}`) return refuse(Code.NOT_FOUND, "machine", "no such machine");
          if (seen.epoch < 7n) return refuse(Code.FAILED_PRECONDITION, "stale_epoch", "a newer epoch has been used for this machine");
          if (!machineRunning) return refuse(Code.UNAVAILABLE, "not_running", "the machine is stopped");
          const socket = net.connect({ port: header.port, host: "127.0.0.1", allowHalfOpen: true });
          socket.setNoDelay(true);
          try { await Promise.race([once(socket, "connect"), once(socket, "error").then(([error]) => { throw error; })]); }
          catch { return refuse(Code.UNAVAILABLE, "dial_failed", `guest refused port ${header.port}`); }
          await stream.send.writeAll(answer());
          await carry(stream, socket, seen);
          finish();
        })().catch(() => {});
      }
    })();
  }
})();

const config: SessionConfig = { version: 2, protocol: 4, binding: { nodeId: "node-r1", threadId: "node-r1", environmentId: 1 }, controlKey,
  serverPeer: runnerEndpoint.id().toString(), network: "loopback", address };
let session = new RunnerSession(config);
const refusedAs = (code: string, reason: string) => (error: unknown) => error instanceof RunnerError && error.code === code && error.reason === reason;
try {
  await session.hello();

  // Refusals come back as RunnerError, and nothing follows them.
  await assert.rejects(session.dial(MACHINE, 7, 80), refusedAs("PERMISSION_DENIED", "port"));
  await assert.rejects(session.dial(MACHINE, 7, 22), refusedAs("PERMISSION_DENIED", "port"));
  await assert.rejects(session.dial(MACHINE, 6, appPort), refusedAs("FAILED_PRECONDITION", "stale_epoch"));
  await assert.rejects(session.dial({ ...MACHINE, owner: "thread-2" }, 7, appPort), refusedAs("NOT_FOUND", "machine"));
  const unused = net.createServer().listen(0, "127.0.0.1");
  await once(unused, "listening");
  const closedPort = (unused.address() as net.AddressInfo).port;
  await new Promise(resolve => unused.close(resolve));
  await assert.rejects(session.dial(MACHINE, 7, closedPort), refusedAs("UNAVAILABLE", "dial_failed"));
  assert.deepEqual(dials.map(d => [d.port, d.epoch]), [[80, 7n], [22, 7n], [appPort, 6n], [appPort, 7n], [closedPort, 7n]], "the header as cubed sent it");
  console.log("ok: dial refusals (port, stale epoch, another machine, nothing listening) are RunnerErrors");

  // The Duplex: bytes both ways, our FIN reaches the app while its answer still comes.
  const raw = await session.dial(MACHINE, 7, appPort);
  const body = randomBytes(512 * 1024);
  const got: Buffer[] = [];
  raw.on("data", (chunk: Buffer) => got.push(chunk));
  const ended = once(raw, "end");
  const closed = once(raw, "close");
  raw.end(Buffer.concat([Buffer.from(`POST /echo HTTP/1.1\r\nhost: x\r\ncontent-length: ${body.length}\r\n\r\n`), body]));
  await ended;
  const all = Buffer.concat(got);
  const at = all.indexOf("\r\n\r\n") + 4;
  assert.match(all.subarray(0, at).toString(), /^HTTP\/1\.1 200 OK\r\n/);
  assert.equal(sha256(all.subarray(at)), sha256(body), "512 KiB up, and back after our FIN");
  await closed;
  await dials.at(-1)!.done;
  assert.equal(dials.at(-1)!.reset, false, "a dial both sides ended is not reset");

  // destroy() is a socket's close: what was written still goes, then FIN.
  const closing = await session.dial(MACHINE, 7, appPort);
  closing.write(`POST /echo HTTP/1.1\r\nhost: x\r\ncontent-length: ${body.length}\r\n\r\n`);
  closing.write(body);
  closing.destroy();
  await dials.at(-1)!.done;
  assert.deepEqual([dials.at(-1)!.fin, dials.at(-1)!.reset], [true, false], "destroy() finishes the stream after what was written");
  // F-B6-1: destroy() after the app half-closed, with small writes queued
  // behind one whose writeAll is still pending (the binding cannot resolve
  // it before this synchronous code ends): every accepted write reaches the
  // app, in order, before the FIN.
  const tail = await session.dial(MACHINE, 7, appPort);
  const tailId = randomBytes(6).toString("hex");
  const head: Buffer[] = [];
  tail.on("data", (chunk: Buffer) => head.push(chunk));
  const appFin = once(tail, "end");
  tail.write(`GET /fin-guest?${tailId} HTTP/1.1\r\nhost: x\r\nconnection: Upgrade\r\nupgrade: cube-test\r\n\r\n`);
  await appFin;
  assert.match(Buffer.concat(head).toString(), /^HTTP\/1\.1 101 [^]*\r\n\r\nguest-first\n$/, "the app closed its side first");
  const parts = ["first;", "second;", "third;", "fourth."].map(text => Buffer.from(text));
  for (const part of parts) assert.equal(tail.write(part), true, "small writes are accepted (below the high-water mark)");
  assert.ok(tail.writableLength > parts[0]!.length, "writes are queued behind the pending one");
  tail.destroy();
  await dials.at(-1)!.done;
  assert.deepEqual([dials.at(-1)!.fin, dials.at(-1)!.reset], [true, false], "destroy() after the app's FIN ends with FIN");
  const tailFile = path.join(state, `fin-${tailId}`);
  for (let i = 0; i < 100 && !fs.existsSync(tailFile); i++) await delay(50);
  const sent = Buffer.concat(parts);
  assert.equal(fs.readFileSync(tailFile, "utf8").trim(), `${sent.length} ${sha256(sent)}`, "every queued write, in order, before the FIN");
  console.log(`ok: destroy() after the app's FIN: ${parts.length} queued writes (${sent.length} bytes) reached the app in order, then FIN`);

  // destroy(error) resets it.
  const aborted = await session.dial(MACHINE, 7, appPort);
  aborted.write("GET / HTTP/1.1\r\n");
  aborted.destroy(new Error("the browser went away"));
  aborted.on("error", () => {});
  await dials.at(-1)!.done;
  assert.deepEqual([dials.at(-1)!.fin, dials.at(-1)!.reset], [false, true], "destroy(error) resets the stream");
  console.log("ok: RunnerSession.dial carries bytes both ways with half close; destroy() closes (written bytes, then FIN), destroy(error) resets");

  // RunnerMachines.dial: only for a machine this process runs, at the machine's current epoch.
  const threads = path.join(root, "threads");
  const thread = { id: MACHINE.owner, vm: { vmId: MACHINE.id }, runnerId: "node-r1" } as unknown as Thread;
  const epochs = Array.from({ length: 7 }, () => nextMachineEpoch(path.join(threads, thread.id, "vm")));
  const admission = { configPath: "/private/r1.json", configHash: "r1" };
  const registry = { runner: () => admission, getRunner: () => null };
  const stopped = new RunnerMachines({ registry: registry as never, threads, session: () => session });
  await assert.rejects(stopped.dial(thread, appPort), /the thread's machine is not running/);
  class Running extends RunnerMachines { override running(): boolean { return true; } }
  const machines = new Running({ registry: registry as never, threads, session: () => session });
  const before = dials.length;
  const viaMachines = await machines.dial(thread, appPort);
  viaMachines.end("GET / HTTP/1.1\r\nhost: x\r\n\r\n");
  const hello: Buffer[] = [];
  for await (const chunk of viaMachines as AsyncIterable<Buffer>) { hello.push(chunk); if (Buffer.concat(hello).includes("hello from dialapp")) break; }
  viaMachines.destroy();
  assert.equal(dials.length, before + 1);
  assert.equal(dials.at(-1)!.epoch, BigInt(epochs.at(-1)!), "RunnerMachines dials at the machine's current epoch");
  console.log("ok: RunnerMachines.dial refuses a machine it does not run and dials at the machine's current epoch");

  // The real Portal over it.
  const services = { call: async () => ({ header: { services: [{ name: "dialapp", port: appPort, kind: "command" }] }, body: Buffer.alloc(0) }), close: async () => {} };
  const target = await dialPortal({ session: () => session, guest: () => services as never, ref: MACHINE, epoch: () => 7, directory: path.join(root, "portal") });
  try {
    const seen = await portalContract(target, "dialapp", async name => fs.existsSync(path.join(state, name)) ? fs.readFileSync(path.join(state, name), "utf8") : null);
    for (const line of seen) console.log(`ok: portal: ${line}`);
    // A stopped machine: the runner refuses and the portal says so.
    machineRunning = false;
    const refused = await request(target.port, target.host("dialapp"), "GET", "/");
    assert.equal(refused.status, 502);
    assert.match(refused.body.toString(), /did not answer on port \d+: UNAVAILABLE\/not_running/);
    machineRunning = true;
    // cubed goes (the session closes): an open connection through the portal ends.
    const held = await Raw.open(target.port, `GET /fin-client HTTP/1.1\r\nHost: ${target.host("dialapp")}\r\nConnection: Upgrade\r\nUpgrade: cube-test\r\n\r\n`);
    assert.match(await held.head(), /^HTTP\/1\.1 101 /);
    await session.close();
    await held.until("the connection ends when the session closes", r => r.ended, 15000);
    session = new RunnerSession(config);
    assert.equal((await request(target.port, target.host("dialapp"), "GET", "/")).status, 200, "a new session dials again");
    await delay(50);
    console.log("ok: portal: a stopped machine 502 (not_running); an open connection ends with the session; a new session dials again");
  } finally { await target.portal.close(); }
} finally {
  await session.close();
  fromCubed?.close(0n, []);
  await runnerEndpoint.close();
  app.kill();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("ok: runner dial streams: refusals, bytes both ways with half close, reset, RunnerMachines and the portal");
process.exit(0);
