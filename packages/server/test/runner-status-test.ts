/** `cubed runners status` against protocol-4 runners (F-G1-1): a one-shot
 * command closes the runner sessions it opened, so it exits by itself after
 * it printed, on success and on every refusal, and each runner sees cubed
 * close its connection (code 0) rather than lose it. The daemon's cached
 * session stays open across health reads. The runners answer from in-process
 * npm iroh endpoints that keep the watch stream open, as berth does. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { create, fromJsonString, toJsonString, type DescMessage, type MessageInitShape } from "@bufbuild/protobuf";
import { Endpoint, SecretKey, type BiStream, type Connection } from "@number0/iroh/index.js";
import { HelloAnswerSchema, OpenSchema, Runner_Kind, Runner_Lifecycle, WatchEventSchema, WatchEvent_Type } from "../src/gen/runner_pb.js";
import { Registry, type Runner } from "../src/registry.ts";
import { runnerHealth } from "../src/runner-select.ts";
import { closeRunnerSessions } from "../src/runner-session.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-runner-status-"));
const cli = path.resolve("packages/server/src/index.ts");
const hex = (bytes: ArrayLike<number>) => Buffer.from(bytes as Uint8Array).toString("hex");
function frame<D extends DescMessage>(schema: D, value: MessageInitShape<D>): number[] {
  const bytes = Buffer.from(toJsonString(schema, create(schema, value)));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Array.from(Buffer.concat([header, bytes]));
}

/** A protocol-4 runner that admits only `controlKey`; it records each
 * connection and the reason it closed with. */
async function fakeRunner(nodeId: string, controlKey: SecretKey) {
  const key = SecretKey.generate();
  const builder = Endpoint.builder();
  builder.applyMinimal();
  builder.secretKey(key.toBytes());
  builder.bindAddr("127.0.0.1:0");
  builder.alpns([Array.from(Buffer.from("cubeyard/runner/4"))]);
  const endpoint = await builder.bind();
  const allowed = hex(controlKey.public().toBytes());
  const connections: { hellos: number; watches: number; closed: Promise<string> }[] = [];
  const serve = async (connection: Connection, seen: (typeof connections)[number]) => {
    for (;;) {
      let stream: BiStream;
      try { stream = await connection.acceptBi(); } catch { return; }
      void (async () => {
        const length = Buffer.from(await stream.recv.readExact(4)).readUInt32BE();
        const opened = fromJsonString(OpenSchema, Buffer.from(await stream.recv.readExact(length)).toString("utf8"), { ignoreUnknownFields: true });
        if (opened.kind.case === "hello") {
          seen.hellos += 1;
          await stream.send.writeAll(frame(HelloAnswerSchema, { protocol: 4, runner: { nodeId, kind: Runner_Kind.VM, softwareVersion: "0.1.0",
            lifecycle: Runner_Lifecycle.READY, platform: { os: "linux", arch: "x86_64" }, network: { mode: "loopback" },
            limits: { maxMachines: 2, maxVcpus: 4, maxMemoryMib: 8192, maxDiskGib: 64 }, capacity: { machinesActive: 0, retained: 0,
              diskFreeBytes: 5n << 30n, diskCommittedBytes: 0n, diskReserveBytes: 2n << 30n, diskReserveInodes: 10_000n } } }));
          await stream.send.finish();
        } else if (opened.kind.case === "watch") {
          // berth answers a watch with RESET and keeps the stream for changes.
          seen.watches += 1;
          await stream.send.writeAll(frame(WatchEventSchema, { type: WatchEvent_Type.RESET }));
        } else await stream.send.finish();
      })().catch(() => {});
    }
  };
  void (async () => {
    for (;;) {
      const incoming = await endpoint.acceptNext();
      if (!incoming) return;
      void (async () => {
        const connection = await (await incoming.accept()).connect();
        if (hex(connection.remoteId().toBytes()) !== allowed) { connection.close(1n, Array.from(Buffer.from("unauthorized"))); return; }
        const seen = { hellos: 0, watches: 0, closed: connection.closed().catch(error => `error: ${error}`) };
        connections.push(seen);
        await serve(connection, seen);
      })().catch(() => {});
    }
  })();
  return { endpoint, peer: hex(key.public().toBytes()), address: endpoint.boundSockets().find(x => x.startsWith("127."))!, connections };
}

function writeConfig(name: string, nodeId: string, controlKey: SecretKey, peer: string, address: string): string {
  const controlFile = path.join(root, `${name}.control.key`);
  fs.writeFileSync(controlFile, Buffer.from(controlKey.toBytes()), { mode: 0o600 });
  const configPath = path.join(root, `${name}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ version: 2, protocol: 4, binding: { nodeId, threadId: nodeId, environmentId: 1 },
    controlKey: controlFile, serverPeer: peer, network: "loopback", address }), { mode: 0o600 });
  return configPath;
}

/** cubed as a child process; `ms` is how long it may take before it counts as hung. */
async function cubed(args: string[], ms = 30_000): Promise<{ status: number | null; signal: string | null; stdout: string; stderr: string; ms: number }> {
  const started = Date.now();
  const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, CUBED_CLAUDE: "off" }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  const timer = setTimeout(() => child.kill("SIGKILL"), ms);
  const [status, signal] = await once(child, "close") as [number | null, string | null];
  clearTimeout(timer);
  return { status, signal, stdout, stderr, ms: Date.now() - started };
}

/** stdout without the runner-session log lines. */
const answers = (stdout: string) => stdout.split("\n").filter(line => line && !/^(debug|info|warn|error) /.test(line));
const within = <T>(work: Promise<T>, ms: number, what: string) => Promise.race([work,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} within ${ms} ms`)), ms).unref())]);

const controlA = SecretKey.generate();
const controlB = SecretKey.generate();
const a = await fakeRunner("node-status-a", controlA);
const b = await fakeRunner("node-status-b", controlB);
const state = path.join(root, "state");
try {
  const configA = writeConfig("a", "node-status-a", controlA, a.peer, a.address);
  const enrolled = await cubed(["runners", "enroll", "--state", state, "--config", configA]);
  assert.equal(enrolled.status, 0, enrolled.stdout + enrolled.stderr);
  const afterEnroll = a.connections.length;

  // Success: the line, exit 0, and the runner sees cubed close the session.
  const ok = await cubed(["runners", "status", "--state", state]);
  assert.equal(ok.signal, null, `runners status did not exit by itself (killed after ${ok.ms} ms): ${ok.stdout}${ok.stderr}`);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.deepEqual(answers(ok.stdout), ["node-status-a: reachable; lifecycle=ready; machines=0 of 2; retained=0"], "the whole answer reached stdout");
  assert.match(ok.stdout, /runner disconnected runner=node-status-a .*reason="the session closed"/);
  assert.equal(a.connections.length, afterEnroll + 1, "one connection per runner");
  const statusConnection = a.connections.at(-1)!;
  assert.equal(statusConnection.hellos, 1);
  assert.match(await within(statusConnection.closed, 5000, "the runner saw the connection close"), /closed by peer: 0/,
    "cubed closed the connection with code 0, not by an idle timeout or a reset");

  // Refusals: an unreachable runner and one that refuses cubed's key. Each
  // is reported, the command exits 1 by itself, and the reachable one still
  // gets its line and its close.
  const configB = writeConfig("b", "node-status-b", controlB, b.peer, b.address);
  assert.equal((await cubed(["runners", "enroll", "--state", state, "--config", configB])).status, 0);
  const registry = new Registry(path.join(state, "registry.sqlite"));
  const runners = registry.listRunners();
  registry.close();
  assert.deepEqual(runners.map(runner => runner.protocol), [4, 4]);
  // B's key changes after enrollment: B refuses the connection.
  fs.writeFileSync(path.join(root, "b.control.key"), Buffer.from(SecretKey.generate().toBytes()), { mode: 0o600 });
  // C: enrolled, then gone (its endpoint closed, the port free).
  const controlC = SecretKey.generate();
  const c = await fakeRunner("node-status-c", controlC);
  const configC = writeConfig("c", "node-status-c", controlC, c.peer, c.address);
  assert.equal((await cubed(["runners", "enroll", "--state", state, "--config", configC])).status, 0);
  await c.endpoint.close();

  const mixed = await cubed(["runners", "status", "--state", state], 60_000);
  assert.equal(mixed.signal, null, `runners status did not exit by itself after refusals (killed after ${mixed.ms} ms): ${mixed.stdout}${mixed.stderr}`);
  assert.equal(mixed.status, 1, mixed.stdout + mixed.stderr);
  const lines = answers(mixed.stdout);
  assert.equal(lines.length, 3, mixed.stdout);
  assert.equal(lines[0], "node-status-a: reachable; lifecycle=ready; machines=0 of 2; retained=0");
  assert.match(lines[1], /^node-status-b: unreachable; /);
  assert.match(lines[2], /^node-status-c: unreachable; .*does not answer/);
  assert.match(await within(a.connections.at(-1)!.closed, 5000, "A saw the connection close"), /closed by peer: 0/);

  // An empty registry and a missing one still end at once.
  const emptyState = path.join(root, "empty");
  fs.mkdirSync(emptyState);
  new Registry(path.join(emptyState, "registry.sqlite")).close();
  const empty = await cubed(["runners", "status", "--state", emptyState]);
  assert.deepEqual([empty.status, empty.signal, answers(empty.stdout)], [0, null, ["no runners enrolled"]]);
  const missing = await cubed(["runners", "status", "--state", path.join(root, "absent")]);
  assert.deepEqual([missing.status, missing.signal], [1, null]);
  assert.match(missing.stderr, /cubed state not found/);

  // The daemon (probeRunner, placement) keeps one cached session per runner:
  // health reads reuse its connection and never close it.
  const runner: Runner = runners[0]!;
  const before = a.connections.length;
  const first = await runnerHealth(runner);
  const second = await runnerHealth(runner);
  assert.deepEqual([first.lifecycle, second.maxActiveVms], ["ready", 2]);
  assert.deepEqual(first.limits, { maxVcpus: 4, maxMemoryMiB: 8192, maxDiskGiB: 64 }, "a VM runner's hello limits are its largest machine");
  assert.deepEqual(first.disk, { freeBytes: 5 * 2 ** 30, freeInodes: null, committedBytes: 0, reserveBytes: 2 * 2 ** 30, reserveInodes: 10_000 },
    "a committed 0 the runner sent stays 0; inodes it did not send are unknown");
  assert.equal(a.connections.length, before + 1, "the cached session is reused, not reopened");
  const daemonConnection = a.connections.at(-1)!;
  await within(new Promise<void>(resolve => { const poll = () => daemonConnection.watches ? resolve() : setTimeout(poll, 10); poll(); }), 5000, "the session watched");
  const open = await Promise.race([daemonConnection.closed.then(() => "closed"), new Promise(resolve => setTimeout(() => resolve("open"), 300))]);
  assert.equal(open, "open", "a health read leaves the daemon's session open");
  await closeRunnerSessions();
  assert.match(await within(daemonConnection.closed, 5000, "the daemon's session closed at shutdown"), /closed by peer: 0/);

  console.log("ok: runners status exits by itself on protocol 4 after an answer and after refusals, closing each session; the daemon's session is kept");
} finally {
  await closeRunnerSessions();
  await Promise.allSettled([a.endpoint.close(), b.endpoint.close()]);
  fs.rmSync(root, { recursive: true, force: true });
}
