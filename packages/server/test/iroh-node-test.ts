/** Real in-process npm iroh, with an authenticated protocol fixture (no shell
 * executor). Real Rust host interoperability lives in smoke-node-adapter.ts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { Endpoint, SecretKey, type BiStream } from "@number0/iroh/index.js";
import { IrohExecutionNodeClient, IrohNodeError, type HostExecSpec } from "../src/iroh-node.ts";
import { Registry } from "../src/registry.ts";
import { CubeSupervisor, type SupervisorConfig } from "../src/supervisor.ts";
import { MockBackend } from "@cube/sandbox";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "iroh-adapter-test-"));
const configPath = path.join(root, "config.json");
const nodeBinding = { nodeId: "node-test", environmentId: 1, threadId: "thread-test" };
const key = SecretKey.generate();
const controlKey = SecretKey.generate();
const builder = Endpoint.builder();
builder.applyMinimal();
builder.secretKey(key.toBytes());
builder.bindAddr("127.0.0.1:0");
builder.bindAddr("[::1]:0");
builder.alpns([Array.from(Buffer.from("cubeyard/node/1"))]);
const server = await builder.bind();
const config = { version: 1, binding: nodeBinding, controlKey: path.join(root, "control.key"), serverPeer: Buffer.from(key.public().toBytes()).toString("hex"), address: server.boundSockets().find(x => x.startsWith("127."))!, network: "loopback", intentDirectory: root };
const spec: HostExecSpec = { command: "printf '; $(touch not-local)'", guestCwd: ".", timeoutMs: 1000, outputLimit: 8 };
fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
const calls: Array<Record<string, unknown>> = [];
let scenario = "normal";
let onCall: ((request: Record<string, unknown>) => void) | undefined;
const tasks = new Set<Promise<void>>();
const fixtureFailures: Error[] = [];
const frame = (value: unknown) => {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Array.from(Buffer.concat([header, payload]));
};
async function receive(stream: BiStream): Promise<Record<string, unknown>> {
  const bytes = Buffer.from(await stream.recv.readToEnd(65540));
  assert.equal(bytes.readUInt32BE(), bytes.length - 4);
  const request = JSON.parse(bytes.subarray(4).toString());
  calls.push(request);
  onCall?.(request);
  return request;
}
const accept = (async () => {
  while (true) {
    const incoming = await server.acceptNext();
    if (!incoming) return;
    const task = (async () => {
      const connection = await (await incoming.accept()).connect();
      assert.ok(connection.remoteId().equals(controlKey.public()), "fixture authorizes only its control peer");
      const mode = scenario;
      let stream = await connection.acceptBi();
      const hello = await receive(stream);
      assert.deepEqual(hello, { method: "node.hello", protocolVersion: 1 });
      if (mode === "hello-hold") { await connection.closed(); return; }
      const binding = mode === "wrong-thread" ? { ...nodeBinding, threadId: "other" }
        : mode === "wrong-node" ? { ...nodeBinding, nodeId: "node-other" }
        : mode === "wrong-environment" ? { ...nodeBinding, environmentId: 2 } : nodeBinding;
      await stream.send.writeAll(frame({ type: "Hello", nodeId: binding.nodeId, protocolVersion: 1, binding,
        profiles: ["host"], capabilities: mode === "unsupported" ? ["node.hello"] : ["node.hello", "exec.start", "environment.inspect", "operation.get"],
        limits: { maxFrameBytes: 65536, requestTimeoutMs: 5000 } }));
      await stream.send.finish();
      stream = await connection.acceptBi();
      const query = await receive(stream);
      if (mode === "disconnect") { connection.close(0n, []); return; }
      if (mode === "hold") { await connection.closed(); return; }
      if (mode === "oversized") { await stream.send.writeAll([0, 1, 0, 1]); await stream.send.finish(); return; }
      if (mode === "truncated") { await stream.send.writeAll([0, 0]); await stream.send.finish(); return; }
      if (mode === "garbage") { await stream.send.writeAll([0, 0, 0, 1, 255]); await stream.send.finish(); return; }
      const id = mode === "wrong-id" ? "op-other" : query.operationId;
      const result = mode === "reject" ? { type: "Error", code: "INVALID_REQUEST", message: "bad cwd", completionUnknown: false, operationId: id }
        : mode === "missing" ? { type: "Error", code: "ENVIRONMENT_MISSING", message: "gone", completionUnknown: false }
        : query.method === "environment.inspect" ? { type: "Environment", binding: mode === "wrong-binding" ? { ...binding, threadId: "other" } : binding, state: "ready" }
        : query.method === "exec.start" ? { type: "Accepted", operationId: id }
        : { type: "Operation", operationId: id, operation: mode === "running" ? { state: "Running" } : mode === "unknown" ? { state: "Unknown" }
          : mode === "interrupted" ? { state: "Interrupted", completionUnknown: true } : mode === "failed" ? { state: "Failed", error: "IO_ERROR", completionUnknown: false }
          : { state: "Succeeded", result: { exitCode: 0, termination: "exited", output: [111, 107], outputBytes: 2, truncated: false } } };
      await stream.send.writeAll(mode === "trailing" ? [...frame(result), 1] : frame(result));
      if (mode === "no-fin") { await connection.closed(); return; }
      await stream.send.finish();
    })().catch(error => {
      // Contact-only, cancellation and deliberately bad replies close native
      // IO. Assertion failures are fixture bugs, never expected disconnects.
      if (error instanceof assert.AssertionError) fixtureFailures.push(error);
    });
    tasks.add(task);
    void task.finally(() => tasks.delete(task)).catch(() => {});
  }
})();
const errorCode = (code: string, unknown = false) => (error: unknown) => error instanceof IrohNodeError && error.code === code && error.completionUnknown === unknown;
const processAPIs = { spawn: childProcess.spawn, spawnSync: childProcess.spawnSync, exec: childProcess.exec, execSync: childProcess.execSync, execFile: childProcess.execFile, execFileSync: childProcess.execFileSync, fork: childProcess.fork };
Object.assign(childProcess, Object.fromEntries(Object.keys(processAPIs).map(name => [name, () => { throw new Error(`adapter must not call child_process.${name}`); }])));
syncBuiltinESMExports();
try {
  const observations: unknown[] = [];
  const client = new IrohExecutionNodeClient({ configPath, observe: (id, value) => observations.push({ id, value }) });
  assert.equal(client.locality, "remote");
  assert.equal(client.contact, "unobserved");
  assert.equal(calls.length, 0);
  assert.ok(!fs.existsSync(config.controlKey));
  assert.deepEqual(client.binding, nodeBinding);
  await assert.rejects(client.status(2), errorCode("ENVIRONMENT_MISSING"));
  await assert.rejects(client.wake(1), errorCode("OPERATION_UNSUPPORTED"));
  await assert.rejects(client.sleep(1), errorCode("OPERATION_UNSUPPORTED"));
  await assert.rejects(client.openPortal(1, 3000), errorCode("OPERATION_UNSUPPORTED"));
  assert.equal(calls.length, 0, "unsupported operations cannot fall back or probe");
  fs.writeFileSync(config.controlKey, Buffer.from(controlKey.toBytes()), { mode: 0o600 });
  assert.equal((await client.status(1)).status, "Running");
  assert.equal(observations.length, 1);
  await client.check(1);
  scenario = "missing";
  await assert.rejects(client.status(1), errorCode("ENVIRONMENT_MISSING"));
  assert.equal(client.contact, "available");
  assert.equal((observations[1] as { value: { status: string } }).value.status, "missing");
  scenario = "wrong-binding";
  await assert.rejects(client.status(1), errorCode("NODE_UNAVAILABLE"));
  assert.equal(observations.length, 2);
  scenario = "normal";
  const beforePrepare = calls.length;
  const prepared = await client.prepareExec(1, spec);
  assert.equal(calls.length, beforePrepare, "preparation persists locally, never contacts a node");
  const intentPath = path.join(root, `${prepared.operationId}.json`);
  const saved = JSON.parse(fs.readFileSync(intentPath, "utf8"));
  assert.deepEqual(saved.spec, spec);
  assert.equal(saved.threadId, nodeBinding.threadId);
  assert.equal(fs.statSync(intentPath).mode & 0o777, 0o600);
  await client.submitExec(1, prepared.operationId);
  const restarted = new IrohExecutionNodeClient({ configPath });
  await assert.rejects(restarted.submitExec(1, prepared.operationId), errorCode("COMPLETION_UNKNOWN", true));
  assert.equal((await restarted.operation(1, prepared.operationId)).state, "Succeeded");
  const result = await client.exec(1, spec);
  assert.deepEqual(result.output, [111, 107]);
  assert.equal(calls.filter(row => row.method === "exec.start" && row.operationId === result.operationId).length, 1);
  const firstQueued = await client.prepareExec(1, spec);
  const secondQueued = await client.prepareExec(1, spec);
  const firstController = new AbortController();
  scenario = "hold";
  const firstOperation = client.operation(1, firstQueued.operationId, firstController.signal);
  while (!calls.some(row => row.operationId === firstQueued.operationId)) await delay(5);
  const secondOperation = client.operation(1, secondQueued.operationId);
  await delay(50);
  assert.ok(!calls.some(row => row.operationId === secondQueued.operationId), "one Iroh identity has only one live endpoint");
  scenario = "normal";
  firstController.abort();
  await assert.rejects(firstOperation, errorCode("NODE_UNAVAILABLE"));
  assert.equal((await secondOperation).state, "Succeeded");
  const count = calls.length;
  fs.chmodSync(config.controlKey, 0o644);
  await assert.rejects(client.prepareExec(1, spec), errorCode("INVALID_REQUEST"));
  fs.chmodSync(config.controlKey, 0o600);
  const link = path.join(root, "config-link.json");
  fs.symlinkSync(configPath, link);
  assert.throws(() => new IrohExecutionNodeClient({ configPath: link }), errorCode("IO_ERROR"));
  fs.unlinkSync(link);
  const corrupted = await client.prepareExec(1, spec);
  const corruptedPath = path.join(root, `${corrupted.operationId}.json`);
  const foreignIntent = JSON.parse(fs.readFileSync(corruptedPath, "utf8"));
  fs.writeFileSync(corruptedPath, JSON.stringify({ ...foreignIntent, controlPeer: "0".repeat(64) }));
  await assert.rejects(client.submitExec(1, corrupted.operationId), errorCode("WRONG_NODE"));
  assert.ok(!fs.existsSync(`${corruptedPath}.sent`));
  for (const bad of [{ ...spec, timeoutMs: 60001 }, { ...spec, outputLimit: 8193 }, { ...spec, address: "203.0.113.1:443" }]) {
    await assert.rejects(client.prepareExec(1, bad), errorCode("INVALID_REQUEST"));
  }
  await assert.rejects(client.submitExec(1, "../escape"), errorCode("INVALID_REQUEST"));
  assert.equal(calls.length, count);
  for (const mode of ["wrong-id", "garbage", "oversized", "truncated", "trailing", "disconnect"]) {
    scenario = mode;
    const intent = await client.prepareExec(1, spec);
    await assert.rejects(client.submitExec(1, intent.operationId), errorCode("COMPLETION_UNKNOWN", true));
    await assert.rejects(client.submitExec(1, intent.operationId), errorCode("COMPLETION_UNKNOWN", true));
    assert.equal(calls.filter(row => row.operationId === intent.operationId).length, 1);
  }
  for (const mode of ["wrong-thread", "wrong-node", "wrong-environment", "unsupported"]) {
    scenario = mode;
    const intent = await client.prepareExec(1, spec);
    await assert.rejects(client.submitExec(1, intent.operationId), errorCode(mode === "unsupported" ? "OPERATION_UNSUPPORTED" : "WRONG_NODE"));
    assert.ok(!calls.some(row => row.operationId === intent.operationId), "binding/capability rejected before command bytes");
  }
  scenario = "reject";
  await assert.rejects(client.exec(1, spec), errorCode("INVALID_REQUEST"));
  const beforeAbort = calls.length;
  await assert.rejects(client.exec(1, spec, AbortSignal.abort()));
  assert.equal(calls.length, beforeAbort);
  // Cancel pending hello, command read and stream FIN. Closing native endpoint
  // must release the read/connect, not just abandon a Promise.race loser.
  for (const mode of ["hello-hold", "hold", "no-fin"]) {
    scenario = mode;
    const controller = new AbortController();
    const intent = await client.prepareExec(1, spec);
    onCall = request => {
      if ((mode === "hello-hold" && request.method === "node.hello") || request.operationId === intent.operationId) setTimeout(() => controller.abort(), 30);
    };
    const started = Date.now();
    await assert.rejects(client.submitExec(1, intent.operationId, controller.signal), errorCode(mode === "hello-hold" ? "NODE_UNAVAILABLE" : "COMPLETION_UNKNOWN", mode !== "hello-hold"));
    assert.ok(Date.now() - started < 3000, "native IO cancellation was not released promptly");
    onCall = undefined;
  }
  scenario = "no-fin";
  const timed = await client.prepareExec(1, spec);
  const timedStart = Date.now();
  await assert.rejects(client.submitExec(1, timed.operationId), errorCode("COMPLETION_UNKNOWN", true));
  assert.ok(Date.now() - timedStart >= 4500 && Date.now() - timedStart < 9000, "RPC deadline must end a missing FIN without a caller abort");
  assert.equal(calls.filter(row => row.operationId === timed.operationId).length, 1);
  // A pending dial to an owned UDP sink must stop too, not keep retrying after
  // the caller's abort. No arbitrary offline/public address is contacted.
  const sink = createSocket("udp4");
  let packets = 0;
  sink.on("message", () => packets++);
  sink.bind(0, "127.0.0.1");
  await once(sink, "listening");
  try {
    const offlinePath = path.join(root, "offline.json");
    fs.writeFileSync(offlinePath, JSON.stringify({ ...config, address: `127.0.0.1:${sink.address().port}` }), { mode: 0o600 });
    const offline = new IrohExecutionNodeClient({ configPath: offlinePath });
    const intent = await offline.prepareExec(1, spec);
    const start = calls.length;
    const started = Date.now();
    await assert.rejects(offline.submitExec(1, intent.operationId, AbortSignal.timeout(150)), errorCode("NODE_UNAVAILABLE"));
    assert.ok(Date.now() - started < 5000, `native dial shutdown took ${Date.now() - started}ms`);
    assert.equal(calls.length, start);
    const stoppedPackets = packets;
    await delay(200);
    assert.equal(packets, stoppedPackets);
    assert.ok(packets > 0);
  } finally { sink.close(); }
  // Abort while the native bind promise is still pending: any late endpoint
  // must be closed without proceeding to connect or dispatch.
  scenario = "normal";
  const early = new AbortController();
  const earlyIntent = await client.prepareExec(1, spec);
  const earlyCalls = calls.length;
  const earlyWork = client.submitExec(1, earlyIntent.operationId, early.signal);
  queueMicrotask(() => early.abort());
  await assert.rejects(earlyWork, errorCode("NODE_UNAVAILABLE"));
  await delay(100);
  assert.equal(calls.length, earlyCalls);
  scenario = "running";
  const controller = new AbortController();
  const start = calls.length;
  onCall = query => { if (query.method === "operation.get") controller.abort(); };
  await assert.rejects(client.exec(1, spec, controller.signal), errorCode("COMPLETION_UNKNOWN", true));
  onCall = undefined;
  assert.equal(calls.slice(start).filter(row => row.method === "exec.start").length, 1);
  for (const mode of ["unknown", "interrupted"]) {
    scenario = mode;
    await assert.rejects(client.exec(1, spec), errorCode("COMPLETION_UNKNOWN", true));
  }
  scenario = "failed";
  await assert.rejects(client.exec(1, spec), errorCode("IO_ERROR"));
  for (const address of ["0.0.0.0:1", "255.255.255.255:1", "224.0.0.1:1", "[::]:1", "[ff02::1]:1", "[::ffff:127.0.0.1]:1", "example.com:1", "127.0.0.1:0", "127.0.0.1:65536", "203.0.113.1:443"]) {
    fs.writeFileSync(configPath, JSON.stringify({ ...config, address }));
    assert.throws(() => new IrohExecutionNodeClient({ configPath }), errorCode("INVALID_REQUEST"));
  }
  fs.writeFileSync(configPath, JSON.stringify({ ...config, network: "direct", address: "203.0.113.1:443" }));
  assert.equal(new IrohExecutionNodeClient({ configPath }).contact, "unobserved", "explicit direct config is not a probe");
  const { address: _address, ...relayConfig } = config;
  fs.writeFileSync(configPath, JSON.stringify({ ...relayConfig, network: "relay" }));
  assert.equal(new IrohExecutionNodeClient({ configPath }).contact, "unobserved", "relay config uses the pinned peer with N0 lookup");
  fs.writeFileSync(configPath, JSON.stringify({ ...config, network: "relay" }));
  assert.throws(() => new IrohExecutionNodeClient({ configPath }), errorCode("INVALID_REQUEST"), "relay config rejects a stale direct target");
  await assert.rejects(client.status(1), errorCode("CONFLICT"));
  fs.writeFileSync(configPath, JSON.stringify(config));
  console.log("1 ok: in-process npm iroh, no subprocess APIs, strict bounded frames, durable intent, one submission, cancellation and read-only polling");
  // The existing local-only registry cannot enroll remote environments yet.
  // Even a deliberately misconfigured remote client with the LOCAL node ID
  // must not authorize filesystem/Git/Incus adapter access on the control plane.
  const registry = new Registry(path.join(root, "registry.db"));
  registry.createProject({ id: "p", name: "test", repositories: [] });
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const cube = registry.createCube({ name: "bound", workspacePath: workspace, image: "mock" });
  registry.addThread({ id: "t", cubeId: cube.id, projectId: "p", piSessionPath: path.join(root, "sessions") });
  registry.setCubeStatus("bound", "ready");
  fs.writeFileSync(configPath, JSON.stringify({ ...config, binding: { nodeId: registry.localNodeId, threadId: "t", environmentId: cube.id } }));
  const remote = new IrohExecutionNodeClient({ configPath });
  const supervisorConfig: SupervisorConfig = { cubesRoot: root, reposRoot: path.join(root, "repos"), pool: "mock", image: "mock", rootSize: "1GiB", dockerVolumeSize: "1GiB", idleMs: 0, portalBase: "cube.internal", publicPort: 7777, egressAllow: [], environmentCache: false };
  const supervisor = new CubeSupervisor(registry, new MockBackend(), supervisorConfig, [remote]);
  const noProbes = calls.length;
  for (const action of [() => supervisor.requireLocalEnvironment("bound"), () => supervisor.accessForUserThread("t"), () => supervisor.workspaceForUserThread("t"), () => supervisor.wakeCube("bound"), () => supervisor.sleepCube("bound")]) {
    await assert.rejects(action(), error => (error as { code?: string }).code === "OPERATION_UNSUPPORTED");
  }
  assert.equal(calls.length, noProbes);
  assert.equal(registry.getCube("bound")?.status, "ready");
  registry.close();
  console.log("2 ok: remote transport cannot authorize local adapters even with a matching local node ID");
} finally {
  Object.assign(childProcess, processAPIs);
  syncBuiltinESMExports();
  await server.close();
  await accept;
  await Promise.all(tasks);
  fs.rmSync(root, { recursive: true, force: true });
  assert.deepEqual(fixtureFailures, []);
}
