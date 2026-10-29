/** cubed's side of runner protocol 4's `credential` streams (masterplan
 * B-5): the registry's checks (the runner owns the machine at the thread's
 * current epoch), and RunnerSession taking the streams a runner opens over
 * a real Iroh connection on loopback. The runner here is a fake that speaks
 * the protocol (hello, then a `credential` or `report` stream); the
 * credential proxy is a fake on a unix socket that records what it got and
 * answers. cubed must pass the header on unchanged, then carry the bytes
 * both ways untouched, and refuse what the route refuses before anything
 * reaches the proxy. The real chain (berth, cube-gateway, a keel machine)
 * is runner-vm-test.ts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { create, fromJsonString, toJsonString, type MessageInitShape } from "@bufbuild/protobuf";
import { Endpoint, SecretKey, type BiStream, type Connection } from "@number0/iroh/index.js";
import { CredentialHeaderSchema, EgressReportSchema, HelloAnswerSchema, OpenSchema, StreamAnswerSchema, type CredentialHeader } from "../src/gen/runner_pb.js";
import { Registry } from "../src/registry.ts";
import { registryCredentialRoute, type CredentialRoute } from "../src/runner-credentials.ts";
import { RunnerSession, type SessionConfig } from "../src/runner-session.ts";
import { nextMachineEpoch } from "../src/vm.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cube-cred-")));
const lines: string[] = [];
const log = { debug: (msg: string, fields?: object) => lines.push(`debug ${msg} ${JSON.stringify(fields)}`),
  info: (msg: string, fields?: object) => lines.push(`info ${msg} ${JSON.stringify(fields)}`),
  warn: (msg: string, fields?: object) => lines.push(`warn ${msg} ${JSON.stringify(fields)}`), error: () => {}, child() { return this; } };

// ---------------------------------------------------------------- the registry's route

const registry = new Registry(path.join(root, "registry.sqlite"));
const threads = path.join(root, "threads");
registry.saveProject({ id: "project", name: "test", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
const model = { provider: "fixture", id: "selected" };
const r1 = { nodeId: "node-r1", environmentId: 1, threadId: "node-r1", configPath: "/private/r1.json", configHash: "r1", maxActiveVms: 4, protocol: 4 as const, kind: "host" as const };
const r2 = { ...r1, nodeId: "node-r2", environmentId: 2, threadId: "node-r2", configPath: "/private/r2.json", configHash: "r2" };
registry.enrollRunner(r1);
registry.enrollRunner(r2);
const mine = registry.createThread("project", "mine", model, "x", "pi", { runnerId: "node-r1" });
const other = registry.createThread("project", "other", model, "x", "pi", { runnerId: "node-r2" });
const gone = registry.createThread("project", "gone", model, "x", "pi", { runnerId: "node-r1" });
registry.applyPhase(gone.id, { type: "releaseBegan" });
registry.applyPhase(gone.id, { type: "released" });
const epoch = nextMachineEpoch(path.join(threads, mine.id, "vm"));
const route = registryCredentialRoute({ registry, threads, socket: () => null });
const runner1 = { nodeId: "node-r1", admission: { configPath: r1.configPath, configHash: r1.configHash } };
const ref = { owner: mine.id, id: mine.vm!.vmId };
assert.equal(route.refuse(runner1, ref, BigInt(epoch)), null, "the runner owns the machine at the current epoch");
assert.equal(route.refuse(runner1, ref, BigInt(epoch) + 5n), null, "a newer epoch than cubed's (the runner raised it) is fine");
const reason = (refusal: ReturnType<CredentialRoute["refuse"]>) => refusal ? `${refusal.code}/${refusal.reason}` : "allowed";
assert.equal(reason(route.refuse(runner1, ref, BigInt(epoch) - 1n)), "FAILED_PRECONDITION/stale_epoch");
assert.equal(reason(route.refuse(runner1, { owner: other.id, id: other.vm!.vmId }, BigInt(epoch))), "PERMISSION_DENIED/wrong_machine", "another runner's thread");
assert.equal(reason(route.refuse(runner1, { owner: mine.id, id: other.vm!.vmId }, BigInt(epoch))), "PERMISSION_DENIED/wrong_machine", "another thread's machine id");
assert.equal(reason(route.refuse(runner1, { owner: gone.id, id: gone.vm!.vmId }, BigInt(epoch))), "PERMISSION_DENIED/wrong_machine", "an archived thread");
assert.equal(reason(route.refuse(runner1, { owner: "nobody", id: mine.vm!.vmId }, BigInt(epoch))), "PERMISSION_DENIED/wrong_machine");
assert.equal(reason(route.refuse({ nodeId: "node-r2", admission: { configPath: r2.configPath, configHash: r2.configHash } }, ref, BigInt(epoch))),
  "PERMISSION_DENIED/wrong_machine", "a runner that is not the thread's");
assert.equal(reason(route.refuse({ ...runner1, admission: { ...runner1.admission, configHash: "changed" } }, ref, BigInt(epoch))), "PERMISSION_DENIED/wrong_machine");
assert.equal(reason(route.refuse({ ...runner1, admission: null }, ref, BigInt(epoch))), "PERMISSION_DENIED/wrong_machine");
// The thread's unfinished template build machine (C-5): its machine too, on its runner at its current epoch; nothing else.
const buildId = "b".repeat(16);
const buildRef = { owner: mine.id, id: buildId };
assert.equal(reason(route.refuse(runner1, buildRef, BigInt(epoch))), "PERMISSION_DENIED/wrong_machine", "no build machine yet");
registry.updateThreadVm(mine.id, { build: { vmId: buildId, placeholders: { github: "cube_ph_github_AbCdEfGhIjKlMnOpQrStUv" }, key: "k", runnerId: "node-r1" } });
assert.equal(route.refuse(runner1, buildRef, BigInt(epoch)), null, "the build machine at the thread's runner and current epoch");
assert.equal(route.refuse(runner1, ref, BigInt(epoch)), null, "the thread's own machine still");
assert.equal(reason(route.refuse(runner1, buildRef, BigInt(epoch) - 1n)), "FAILED_PRECONDITION/stale_epoch");
assert.equal(reason(route.refuse(runner1, { owner: mine.id, id: "c".repeat(16) }, BigInt(epoch))), "PERMISSION_DENIED/wrong_machine", "another id");
assert.equal(reason(route.refuse(runner1, { owner: other.id, id: buildId }, BigInt(epoch))), "PERMISSION_DENIED/wrong_machine", "the id under another thread");
assert.equal(reason(route.refuse({ nodeId: "node-r2", admission: { configPath: r2.configPath, configHash: r2.configHash } }, buildRef, BigInt(epoch))),
  "PERMISSION_DENIED/wrong_machine", "another runner");
registry.updateThreadVm(mine.id, { build: { vmId: buildId, placeholders: {}, key: "k", runnerId: "node-r2" } });
assert.equal(reason(route.refuse(runner1, buildRef, BigInt(epoch))), "PERMISSION_DENIED/wrong_machine", "a build machine made on another runner");
registry.updateThreadVm(mine.id, { build: { vmId: buildId, placeholders: {}, key: "k", runnerId: "node-r1" } });
assert.equal(route.refuse(runner1, buildRef, BigInt(epoch)), null);
// Published or deleted: forgotten, and refused.
registry.updateThreadVm(mine.id, { build: undefined });
assert.equal(reason(route.refuse(runner1, buildRef, BigInt(epoch))), "PERMISSION_DENIED/wrong_machine", "after the publication");
registry.updateThreadVm(gone.id, { build: { vmId: buildId, placeholders: {}, key: "k", runnerId: "node-r1" } });
assert.equal(reason(route.refuse(runner1, { owner: gone.id, id: buildId }, BigInt(epoch))), "PERMISSION_DENIED/wrong_machine", "an archived thread's build machine");
registry.close();
console.log("ok: route: owner, machine id, archive, runner admission and epoch checked; the unfinished build machine allowed only as the thread's, and refused once forgotten");

// ---------------------------------------------------------------- the fake proxy

interface Proxied { header: CredentialHeader; request: Buffer }
const proxied: Proxied[] = [];
const socketPath = path.join(root, "credential.sock");
/** Reads the frame and the request until the client's FIN; answers with
 * the request's sha256 and `answerBytes` bytes of pattern. */
let answerBytes = 0;
const proxy = net.createServer(socket => {
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.on("end", () => {
    const all = Buffer.concat(chunks);
    const length = all.readUInt32BE(0);
    const header = fromJsonString(CredentialHeaderSchema, all.subarray(4, 4 + length).toString("utf8"));
    const request = all.subarray(4 + length);
    proxied.push({ header, request });
    const body = Buffer.alloc(answerBytes, "abcdefgh");
    socket.write(`HTTP/1.1 200 OK\r\nx-sha256: ${createHash("sha256").update(request).digest("hex")}\r\ncontent-length: ${body.length}\r\n\r\n`);
    socket.end(body);
  });
});
await new Promise<void>(resolve => proxy.listen(socketPath, resolve));

// ---------------------------------------------------------------- the fake runner

const ALPN = Array.from(Buffer.from("cubeyard/runner/4"));
const runnerKey = SecretKey.generate();
const builder = Endpoint.builder();
builder.applyMinimal();
builder.secretKey(runnerKey.toBytes());
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
/** The runner side: hello answered; every other stream cubed opens held. */
let fromCubed: Connection | undefined;
const connected = (async () => {
  const incoming = await runnerEndpoint.acceptNext();
  const connection = await (await incoming!.accept()).connect();
  fromCubed = connection;
  void (async () => {
    for (;;) {
      let stream: BiStream;
      try { stream = await connection.acceptBi(); } catch { return; }
      const opened = fromJsonString(OpenSchema, await readFrame(stream));
      if (opened.kind.case === "hello") {
        await stream.send.writeAll(frame(toJsonString(HelloAnswerSchema, create(HelloAnswerSchema, { protocol: 4, runner: { nodeId: "node-r1" } }))));
        await stream.send.finish();
      }
    }
  })();
  return connection;
})();

function credentialHeader(patch: Partial<MessageInitShape<typeof CredentialHeaderSchema>> = {}): CredentialHeader {
  return create(CredentialHeaderSchema, { ref: { owner: "thread-1", id: "0123456789abcdef" }, credential: "github", sni: "api.github.com",
    host: "api.github.com", port: 443, fence: { epoch: 7n }, ...patch } as MessageInitShape<typeof CredentialHeaderSchema>);
}
/** One credential stream from the runner: header, answer, then (if no
 * error) `request` and FIN, and the answer bytes to FIN. */
async function credentialStream(header: CredentialHeader, request: Buffer, raw?: number[]) {
  const connection = await connected;
  const stream = await connection.openBi();
  await stream.send.writeAll(raw ?? frame(toJsonString(OpenSchema, create(OpenSchema, { kind: { case: "credential", value: header } }))));
  const answer = fromJsonString(StreamAnswerSchema, await readFrame(stream));
  if (answer.error) { assert.deepEqual(Buffer.from(await stream.recv.readToEnd(1024)), Buffer.alloc(0), "nothing after a refusal"); return { answer, bytes: Buffer.alloc(0) }; }
  const sent = (async () => {
    for (let at = 0; at < request.length; at += 1 << 20) await stream.send.writeAll(Array.from(request.subarray(at, at + (1 << 20))));
    await stream.send.finish();
  })();
  const chunks: Buffer[] = [];
  for (;;) { const chunk = await stream.recv.read(1 << 20); if (!chunk.length) break; chunks.push(Buffer.from(chunk)); }
  await sent;
  return { answer, bytes: Buffer.concat(chunks) };
}

const testRoute: CredentialRoute = {
  refuse: (runner, machine, fenceEpoch) => {
    assert.deepEqual(runner, { nodeId: "node-r1", admission: null });
    if (machine.owner !== "thread-1" || machine.id !== "0123456789abcdef") return { code: "PERMISSION_DENIED", reason: "wrong_machine", message: "not yours" };
    return fenceEpoch < 7n ? { code: "FAILED_PRECONDITION", reason: "stale_epoch", message: "old" } : null;
  },
  socket: () => socketPath,
};
const config: SessionConfig = { version: 2, protocol: 4, binding: { nodeId: "node-r1", threadId: "node-r1", environmentId: 1 }, controlKey,
  serverPeer: runnerEndpoint.id().toString(), network: "loopback", address };
const session = new RunnerSession(config, { credentials: testRoute, log: log as never });
try {
  await session.hello();
  const request = Buffer.from("POST /x HTTP/1.1\r\nhost: api.github.com\r\nauthorization: Bearer cube_ph_github_AbCdEfGhIjKlMnOpQrStUv\r\ncontent-length: 2\r\n\r\nhi");
  const carried = await credentialStream(credentialHeader(), request);
  assert.equal(carried.answer.error, undefined);
  assert.equal(proxied.length, 1);
  assert.deepEqual(proxied[0]!.header, credentialHeader(), "the header reaches the proxy unchanged");
  assert.deepEqual(proxied[0]!.request, request, "the request's bytes, untouched");
  assert.match(carried.bytes.toString(), new RegExp(`^HTTP/1.1 200 OK\r\nx-sha256: ${createHash("sha256").update(request).digest("hex")}\r\n`));

  // Refused before the proxy: another machine, an old epoch, no fence, a header over 64 KiB.
  const refusal = async (header: CredentialHeader, raw?: number[]) => {
    const before = proxied.length;
    const { answer } = await credentialStream(header, Buffer.alloc(0), raw);
    assert.equal(proxied.length, before, "nothing reached the proxy");
    return `${answer.error?.code}/${answer.error?.reason}`;
  };
  assert.equal(await refusal(credentialHeader({ ref: { owner: "thread-2", id: "0123456789abcdef" } })), "6/wrong_machine");
  assert.equal(await refusal(credentialHeader({ fence: { epoch: 6n } })), "3/stale_epoch");
  assert.equal(await refusal(credentialHeader({ fence: undefined })), "7/fence");
  assert.equal(await refusal(credentialHeader({ ref: undefined })), "7/ref");
  assert.equal(await refusal(credentialHeader(), frame(toJsonString(OpenSchema, create(OpenSchema, { kind: { case: "credential",
    value: credentialHeader({ credential: "x".repeat(64 * 1024) }) } })))), "7/size");
  console.log("ok: refused before the proxy: wrong machine, stale epoch, no fence, no ref, a header over 64 KiB");

  // Bytes both ways, large: 24 MiB up, 24 MiB down, unchanged.
  answerBytes = 24 << 20;
  const big = randomBytes(24 << 20);
  const t0 = Date.now();
  const large = await credentialStream(credentialHeader(), big);
  const ms = Date.now() - t0;
  assert.equal(proxied.at(-1)!.request.length, big.length);
  assert.ok(proxied.at(-1)!.request.equals(big), "24 MiB up, byte for byte");
  const head = large.bytes.indexOf("\r\n\r\n") + 4;
  assert.equal(large.bytes.length - head, 24 << 20, "24 MiB down");
  assert.ok(large.bytes.subarray(head).equals(Buffer.alloc(24 << 20, "abcdefgh")));
  console.log(`ok: 24 MiB each way through cubed, unchanged, in ${ms} ms (both ends in this process)`);
  answerBytes = 0;

  // No proxy: UNAVAILABLE, at once.
  proxy.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(await refusal(credentialHeader()), "5/credential_proxy");

  // A report stream: read and logged, never answered.
  const connection = await connected;
  const reports = await connection.openBi();
  await reports.send.writeAll(frame(toJsonString(OpenSchema, create(OpenSchema, { kind: { case: "report", value: {} } }))));
  await reports.send.writeAll(frame(toJsonString(EgressReportSchema, create(EgressReportSchema, { ref: { owner: "thread-1", id: "0123456789abcdef" },
    host: "example.net", reason: "deny_host", droppedBefore: 3n }))));
  await reports.send.finish();
  for (let i = 0; i < 50 && !lines.some(line => line.includes("egress refused")); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(lines.some(line => line.startsWith("info egress refused") && line.includes("\"host\":\"example.net\"") && line.includes("\"droppedBefore\":3")), lines.join("\n"));
  // A stream kind a runner does not open: refused.
  const wrong = await connection.openBi();
  await wrong.send.writeAll(frame(toJsonString(OpenSchema, create(OpenSchema, { kind: { case: "watch", value: {} } }))));
  assert.equal(fromJsonString(StreamAnswerSchema, await readFrame(wrong)).error?.reason, "open");
  assert.ok(lines.some(line => line.startsWith("info credential request refused") && line.includes("stale_epoch")));
  assert.ok(!lines.some(line => line.includes("cube_ph_") || line.includes("hi\"")), "no request bytes in the log");
  console.log("ok: report streams read and logged, other kinds refused");
} finally {
  await session.close();
  fromCubed?.close(0n, []);
  await runnerEndpoint.close();
  proxy.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("ok: runner credential streams: route checks, header passed on, bytes carried both ways, refusals before the proxy");
process.exit(0);
