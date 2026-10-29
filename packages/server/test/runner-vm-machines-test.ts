/** RunnerMachines on a protocol-4 VM runner (`berth vm`, C-a), over a real
 * Iroh connection on loopback to a fake runner that keeps the calls it was
 * sent and reports its machines in a `watch`: `machine_create` with the
 * thread's size within the runner's limits, `machine_start` every time with
 * the size, the boot documents and the egress policy (its default and lease
 * explicit), the wait for `status.guest.ready`, `machine_diagnose` shown as
 * machine evidence with what the keel agent said of itself in the watch,
 * the startup log (keel's `read` over the guest stream, at the current
 * fence; none on a host runner), a guest that does not get ready (the boot
 * step and the diagnosis give its reason, bounded), release
 * (`machine_delete`, which may take longer than the 15 s of other calls),
 * `machine_discard`, the per-call deadline (a `template_publish` that
 * answers after 16 s still gets its answer), and the session's log of each
 * connection's Iroh path and RTT (K-2b: after hello, on a change at most
 * once per interval, at the close; a read that throws fails no call).
 * The runner's rules are berth's (runner-vm-test.ts runs the real one);
 * this tests what cubed sends and how it reads the answers. Offline. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { clone, create, fromJsonString, toJsonString, type DescMessage, type MessageInitShape } from "@bufbuild/protobuf";
import { Connection, Endpoint, SecretKey, type BiStream, type PathSnapshot } from "@number0/iroh/index.js";
import { CallResultSchema, CallSchema, Code, EgressPolicy_Default, Template_State, GuestInfoSchema, HelloAnswerSchema, MachineSchema, MachineStatusSchema, MetaSchema, MachineStatus_Phase, OpenSchema, Runner_Kind, StreamAnswerSchema,
  WatchEvent_Type, WatchEventSchema, type Machine } from "../src/gen/runner_pb.js";
import { EgressPolicy } from "../src/egress-policy.ts";
import { Registry } from "../src/registry.ts";
import { createLogger } from "../src/log.ts";
import { RunnerMachines } from "../src/runner-machines.ts";
import { callTimeout, PATH_LOG_INTERVAL_MS, RunnerError, RunnerSession, STOP_TIMEOUT_MS, type SessionConfig } from "../src/runner-session.ts";
import { formatDiagnostics } from "../src/vm-diagnostics.ts";
import { RunnerWait } from "../src/vm.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cube-vm-machines-")));
const ALPN = Array.from(Buffer.from("cubeyard/runner/4"));
const builder = Endpoint.builder();
builder.applyMinimal();
builder.secretKey(SecretKey.generate().toBytes());
builder.alpns([ALPN]);
builder.bindAddr("127.0.0.1:0");
// The IPv6 default is the wildcard [::]:0 (the host's every address); both families explicit, as runner-session.ts binds.
builder.bindAddr("[::1]:0");
const runnerEndpoint = await builder.bind();
const address = runnerEndpoint.boundSockets().find(a => a.startsWith("127.0.0.1:"))!;
const controlKey = path.join(root, "control.key");
fs.writeFileSync(controlKey, randomBytes(32), { mode: 0o600 });

function frame<D extends DescMessage>(schema: D, value: MessageInitShape<D>): number[] {
  const bytes = Buffer.from(toJsonString(schema, create(schema, value)));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Array.from(Buffer.concat([header, bytes]));
}
async function readFrame(stream: BiStream): Promise<string> {
  const length = Buffer.from(await stream.recv.readExact(4)).readUInt32BE();
  return Buffer.from(await stream.recv.readExact(length)).toString("utf8");
}

// ---------------------------------------------------------------- the fake runner

const NODE = "node-vm1";
const DOCUMENT = { version: 1, machine: { phase: "running" }, qemu: { path: "/opt/qemu/bin/qemu-system-x86_64", version: "11.1.2", log: { present: true, bytes: 5, complete: true, text: "qemu\n" } },
  qmp: { asked: true, status: { status: "running" } }, guest: { ready: true }, egress: {}, runner: {}, iroh: { paths: [] },
  console: { present: true, bytes: 12, complete: true, text: "keel booted\n" }, events: { present: true, lines: ["t0 started: boot"] } };
/** Every call as the fake got it, by verb. */
const calls: Array<{ verb: string; value: Record<string, unknown> }> = [];
const machines = new Map<string, Machine>();
const watchers = new Set<BiStream>();
let version = 0n;
/** How long machine_delete takes (berth stops the machine first). */
let deleteMs = 0;
/** How long template_publish takes. */
let publishMs = 0;
let boots = 0;
/** What the keel agent says of itself when its machine starts: ready, or
 * (when `ready` is false) not, with its reason. */
const BUILD = "ab".repeat(32);
const READY_AGENT: MessageInitShape<typeof GuestInfoSchema> = { ready: true, version: "0.1.0", build: BUILD, kernel: "6.18.0-keel", bootId: "0f6c2d4e-1b7a-4f3e-9c2d-7a1b3c4d5e6f",
  hooks: { "pre-setup": "ok", setup: "failed:3", "pre-resume": "notrun", unknown: "ok" } };
let agentSays = READY_AGENT;
/** The guest's files for `read` (keel's: `size`, `NOT_FOUND`), and the fence of each guest stream. */
const guestFiles = new Map<string, Buffer>();
const guestFences: bigint[] = [];
const connections = new Set<Connection>();
/** The node id the fake says hello as. */
let hellosAs = NODE;
/** As berth vm restarting: connections gone, machines stopped, and its
 * versions (kept in memory) beginning again. */
function restartRunner(): void {
  for (const connection of connections) connection.close(0n, []);
  connections.clear();
  watchers.clear();
  version = 0n;
  for (const machine of [...machines.values()]) put(withStatus(machine, { phase: MachineStatus_Phase.STOPPED }));
}

/** `machine` with another status. */
function withStatus(machine: Machine, status: MessageInitShape<typeof MachineStatusSchema>): Machine {
  const next = clone(MachineSchema, machine);
  next.status = create(MachineStatusSchema, status);
  return next;
}
function put(machine: Machine): Machine {
  machine.meta = create(MetaSchema, { version: ++version });
  machines.set(`${machine.ref!.owner}/${machine.ref!.id}`, machine);
  for (const watcher of watchers) void watcher.send.writeAll(frame(WatchEventSchema, { type: WatchEvent_Type.PUT, resource: { case: "machine", value: machine } })).catch(() => watchers.delete(watcher));
  return machine;
}

async function answerCall(stream: BiStream, verb: ReturnType<typeof fromJsonString<typeof CallSchema>>["verb"]): Promise<void> {
  const reply = async (result: MessageInitShape<typeof CallResultSchema>["result"]) => {
    await stream.send.writeAll(frame(CallResultSchema, { result }));
    await stream.send.finish();
  };
  const refuse = (code: Code, reason: string, message: string) => reply({ case: "error", value: { code, reason, message } });
  if (!verb.case) return refuse(Code.INVALID_ARGUMENT, "verb", "no verb");
  calls.push({ verb: verb.case, value: verb.value as unknown as Record<string, unknown> });
  const value = verb.value as { ref?: { owner: string; id: string } };
  const key = `${value.ref?.owner}/${value.ref?.id}`;
  const known = machines.get(key);
  switch (verb.case) {
    case "machineGet": return known ? reply({ case: "machine", value: known }) : refuse(Code.NOT_FOUND, "machine", "no such machine");
    case "machineCreate":
      return reply({ case: "machine", value: put(create(MachineSchema, { ref: value.ref, spec: verb.value.spec, status: { phase: MachineStatus_Phase.STOPPED } })) });
    case "machineStart": {
      if (!known) return refuse(Code.NOT_FOUND, "machine", "no such machine");
      const started = put(withStatus(known, { phase: MachineStatus_Phase.RUNNING, bootId: `boot${++boots}`.padEnd(32, "0") }));
      await reply({ case: "machine", value: started });
      // The agent says ready a moment later, in the watch.
      await delay(50);
      put(withStatus(started, { phase: MachineStatus_Phase.RUNNING, bootId: started.status!.bootId,
        guest: create(GuestInfoSchema, { connected: true, ready: true, since: { seconds: 1n, nanos: 0 }, ...agentSays }) }));
      return;
    }
    case "machineDelete": {
      await delay(deleteMs);
      if (!known) return refuse(Code.NOT_FOUND, "machine", "no such machine");
      return reply({ case: "machine", value: put(withStatus(known, { phase: verb.value.retain ? MachineStatus_Phase.RETAINED : MachineStatus_Phase.DELETED })) });
    }
    case "machineDiscard":
      if (!known) return refuse(Code.NOT_FOUND, "machine", "no such machine");
      machines.delete(key);
      return reply({ case: "machine", value: withStatus(known, { phase: MachineStatus_Phase.DELETED }) });
    case "templatePublish":
      // berth gives the build machine's agent up to 600 s (masterplan C4).
      await delay(publishMs);
      return reply({ case: "template", value: { id: verb.value.from!.id, key: verb.value.key, meta: verb.value.meta, state: Template_State.READY } });
    case "machineDiagnose":
      return known ? reply({ case: "diagnosis", value: { json: JSON.stringify(DOCUMENT) } }) : refuse(Code.NOT_FOUND, "machine", "no such machine");
    default: return refuse(Code.UNIMPLEMENTED, "verb", `${verb.case} is not faked`);
  }
}

void (async () => {
  for (;;) {
    const incoming = await runnerEndpoint.acceptNext();
    if (!incoming) return;
    const connection = await (await incoming.accept()).connect();
    connections.add(connection);
    void (async () => {
      for (;;) {
        let stream: BiStream;
        try { stream = await connection.acceptBi(); } catch { return; }
        void (async () => {
          const opened = fromJsonString(OpenSchema, await readFrame(stream), { ignoreUnknownFields: true });
          if (opened.kind.case === "hello") {
            await stream.send.writeAll(frame(HelloAnswerSchema, { protocol: 4, runner: { nodeId: hellosAs, kind: Runner_Kind.VM,
              network: { mode: "loopback", rttToCubed: { seconds: 0n, nanos: 1500000 } }, limits: { maxVcpus: 3, maxMemoryMib: 6144, maxDiskGib: 20, maxMachines: 2, maxBootBytes: 262144 } } }));
            await stream.send.finish();
          } else if (opened.kind.case === "watch") {
            await stream.send.writeAll(frame(WatchEventSchema, { type: WatchEvent_Type.RESET }));
            for (const machine of machines.values()) await stream.send.writeAll(frame(WatchEventSchema, { type: WatchEvent_Type.PUT, resource: { case: "machine", value: machine } }));
            watchers.add(stream);
          } else if (opened.kind.case === "call") await answerCall(stream, opened.kind.value.verb);
          else if (opened.kind.case === "guest") {
            guestFences.push(opened.kind.value.fence?.epoch ?? 0n);
            const request = Buffer.from(await stream.recv.readToEnd(1024 * 1024));
            const header = JSON.parse(request.subarray(0, request.indexOf(10)).toString("utf8")) as { path: string; offset: number; limit: number };
            assert.equal(opened.kind.value.op, "read", "only read is faked");
            const file = guestFiles.get(header.path);
            const answer = file ? { path: header.path, offset: header.offset, size: file.length } : { error: { code: "NOT_FOUND", message: "no such file" } };
            await stream.send.writeAll(frame(StreamAnswerSchema, {}));
            await stream.send.writeAll(Array.from(Buffer.concat([Buffer.from(`${JSON.stringify(answer)}\n`),
              file ? file.subarray(header.offset, header.offset + header.limit) : Buffer.alloc(0)])));
            await stream.send.finish();
          }
        })().catch(error => console.error("FAKE", error));
      }
    })();
  }
})();

// ---------------------------------------------------------------- cubed's side

const config: SessionConfig = { version: 2, protocol: 4, binding: { nodeId: NODE, threadId: NODE, environmentId: 1 }, controlKey,
  serverPeer: runnerEndpoint.id().toString(), network: "loopback", address };
/** A session's log lines, kept and shown; `logged(lines, msg)` gives each line's fields. */
function capture(): { lines: string[]; log: ReturnType<typeof createLogger> } {
  const lines: string[] = [];
  return { lines, log: createLogger("runner-session", line => { lines.push(line); process.stdout.write(line); }) };
}
function logged(lines: string[], msg: string, level = "info"): Array<Record<string, string>> {
  const prefix = `${level} runner-session ${msg} `;
  return lines.filter(line => line.startsWith(prefix)).map(line => Object.fromEntries([...line.slice(prefix.length).matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)]
    .map(([, name, value]) => [name!, value!.startsWith("\"") ? JSON.parse(value!) as string : value!])));
}
async function until(done: () => boolean, ms = 5000): Promise<void> {
  for (const end = Date.now() + ms; !done(); await delay(20)) if (Date.now() > end) throw new Error("timed out");
}
const runnerPorts = runnerEndpoint.boundSockets().map(socket => socket.slice(socket.lastIndexOf(":") + 1));
/** The runner on loopback: Iroh may use its IPv6 socket though cubed dialled 127.0.0.1. */
const loopbackRemote = (remote: string | undefined) => /^(127\.0\.0\.1|\[::1\]):\d+$/.test(remote ?? "") && runnerPorts.includes(remote!.slice(remote!.lastIndexOf(":") + 1));
const sessionLog = capture();
const session = new RunnerSession(config, { log: sessionLog.log });
const registry = new Registry(path.join(root, "registry.sqlite"));
registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [],
  hooks: { preSetup: "echo pre-setup", preResume: "echo pre-resume" }, machine: { vcpus: 4, memoryMiB: 4096 } });
registry.enrollRunner({ nodeId: NODE, threadId: NODE, environmentId: 1, configPath: path.join(root, "vm1.json"), configHash: "vm1", maxActiveVms: 2, protocol: 4, kind: "vm" });
const policy = new EgressPolicy({ vms: { vm: () => null }, secrets: [{ name: "github", hosts: ["github.com", "api.github.com"], value: async () => null }] });
const threads = path.join(root, "threads");
const sizes = { vcpus: 2, memoryMiB: 2048, diskGiB: 32 };
const machinesFor = (withPolicy: boolean) => new RunnerMachines({ registry, threads, session: () => session, sizes, ...(withPolicy ? { policy } : {}) });
const of = (verb: string) => calls.filter(call => call.verb === verb);
try {
  const thread = registry.createThread("p", "r1", { provider: "faux", id: "faux" }, "hi", "pi", { runnerId: NODE });
  assert.equal(thread.pinned, true, "started on the runner by name");
  const placeholder = thread.vm!.placeholders.github!;
  assert.match(placeholder, /^cube_ph_github_/);

  // Without an egress policy cubed sends nothing.
  await assert.rejects(machinesFor(false).start(thread), /no egress policy for protocol-4 VM runners/);
  assert.deepEqual(calls, [], "refused before any call");

  const vms = machinesFor(true);
  const started = Date.now();
  assert.deepEqual(await vms.start(registry.getThread(thread.id)!), { booted: true });
  assert.ok(Date.now() - started < 10000);
  const [created] = of("machineCreate");
  const spec = created!.value.spec as { source: { case: string; value: unknown }; size: Record<string, number>; build: boolean };
  assert.deepEqual(spec.source, { case: "base", value: true });
  assert.equal(spec.build, false, "no templates in C-a");
  assert.deepEqual([spec.size.vcpus, spec.size.memoryMib, spec.size.diskGib], [3, 4096, 20], "the project's size, the runner's limits bounding it");
  const [start] = of("machineStart");
  const value = start!.value as { size: Record<string, number>; boot: { documents: Record<string, Uint8Array>; mac: string };
    policy: { default: number; denyHosts: string[]; rules: Array<{ hosts: string[]; kind: { case: string; value: { credential: { name: string } } } }>; lease: { seconds: bigint } } };
  assert.deepEqual([value.size.vcpus, value.size.memoryMib, value.size.diskGib], [3, 4096, 20], "the size again at start");
  const text = (name: string) => Buffer.from(value.boot.documents[name]!).toString("utf8");
  assert.deepEqual(Object.keys(value.boot.documents).sort(), ["env", "hooks/pre-resume", "hooks/pre-setup", "hostname"]);
  assert.equal(text("hostname"), `cube-${thread.vm!.vmId.slice(0, 8)}\n`);
  assert.equal(text("env"), `GH_TOKEN=${placeholder}\n`);
  assert.equal(text("hooks/pre-setup"), "#!/bin/bash\necho pre-setup\n");
  assert.equal(text("hooks/pre-resume"), "#!/bin/bash\necho pre-resume\n");
  assert.equal(value.policy.default, EgressPolicy_Default.ALLOW_PUBLIC_HTTP, "the default is sent explicitly");
  assert.equal(value.policy.lease.seconds, 900n, "and the 15-minute lease");
  assert.deepEqual(value.policy.rules.map(rule => [rule.hosts, rule.kind.case, rule.kind.value.credential.name]),
    [[["github.com", "api.github.com"], "https", "github"]], "the thread's secret only through the credential stream");
  const steps = registry.getThread(thread.id)!.vm!.steps!;
  assert.deepEqual(steps.map(step => [step.name, step.state]), [["lookup", "ok"], ["boot", "ok"]]);
  assert.equal(steps[0]!.detail, "no template: the runner has no machine templates (template.publish, template.list, template.delete)", "this fake has none");
  assert.deepEqual(registry.getThread(thread.id)!.vm!.preparation, { source: "fresh", reason: "the runner has no machine templates (template.publish, template.list, template.delete)" });
  assert.equal(steps[1]!.detail, `a keel machine on VM runner ${NODE}: 3 vCPU, 4096 MiB memory, 20 GiB disk`);
  assert.equal(registry.getThread(thread.id)!.vm!.placement, "allocated");
  assert.ok(vms.running(registry.getThread(thread.id)!));
  // K-2b: one line for the new connection, after its hello: the path in use, its RTT and the runner's own.
  const [connected, ...moreConnected] = logged(sessionLog.lines, "runner connected");
  assert.ok(connected && moreConnected.length === 0, sessionLog.lines.join(""));
  assert.deepEqual([connected.runner, connected.network, connected.kind, connected.runnerRttMs], [NODE, "loopback", "direct", "1.5"], JSON.stringify(connected));
  assert.ok(loopbackRemote(connected.remote), `the runner's loopback address: ${connected.remote} (its ports ${runnerPorts.join(", ")})`);
  assert.match(connected.rttMs ?? "", /^\d+$/, "whole milliseconds, as the binding gives them");
  assert.match(connected.connection ?? "", /^\d+$/);
  assert.deepEqual(logged(sessionLog.lines, "runner disconnected"), []);
  console.log(`ok: a new connection logs its path after hello: kind=${connected.kind} remote=${connected.remote} rttMs=${connected.rttMs} runnerRttMs=${connected.runnerRttMs}`);

  // Started again (a restart of cubed or of the runner): no create, the same documents and policy again, a later fence.
  const again = await machinesFor(true).start(registry.getThread(thread.id)!);
  assert.deepEqual(again, { booted: true }, "a new process has not seen this boot");
  assert.equal(of("machineCreate").length, 1);
  const [first, second] = of("machineStart").map(call => call.value as { fence: { epoch: bigint }; boot: { documents: Record<string, Uint8Array> }; policy: unknown });
  assert.ok(second!.fence.epoch > first!.fence.epoch);
  assert.deepEqual(Object.keys(second!.boot.documents).sort(), Object.keys(first!.boot.documents).sort());
  assert.deepEqual(second!.policy, first!.policy);

  // berth restarts: its versions begin again, and cubed's view starts over at
  // the new connection (and at the watch's RESET), so it sees the new boot.
  const before = registry.getThread(thread.id)!;
  const bootBefore = boots;
  restartRunner();
  const restarted = await (async () => {
    for (let tries = 0; ; tries++) {
      try { return await vms.start(before); }
      catch (error) { if (tries > 50) throw error; await delay(200); }
    }
  })();
  assert.deepEqual(restarted, { booted: true }, "a new boot after the runner's restart, not the old record");
  assert.equal(boots, bootBefore + 1);
  assert.equal(session.machines.get(`${thread.id}/${thread.vm!.vmId}`)?.status?.bootId, `boot${boots}`.padEnd(32, "0"));
  console.log("ok: after the runner restarts (its versions begin again) cubed sees the machine's new boot");
  // K-2b: the runner's close is logged with its reason and duration, and the new connection with its own line.
  const [gone, ...moreGone] = logged(sessionLog.lines, "runner disconnected");
  assert.ok(gone && moreGone.length === 0, sessionLog.lines.join(""));
  assert.equal(gone.connection, connected.connection);
  assert.match(gone.reason ?? "", /closed by peer/);
  assert.match(gone.durationMs ?? "", /^\d+$/);
  const reconnected = logged(sessionLog.lines, "runner connected");
  assert.equal(reconnected.length, 2);
  assert.notEqual(reconnected[1]!.connection, connected.connection);
  assert.deepEqual([reconnected[1]!.kind, loopbackRemote(reconnected[1]!.remote)], ["direct", true], JSON.stringify(reconnected[1]));
  console.log(`ok: the runner's close is logged (reason ${JSON.stringify(gone.reason)}, ${gone.durationMs} ms) and the new connection again`);
  console.log("ok: a VM runner's machine is created with its size and started with its size, boot documents and policy every time; cubed waits for the guest's ready");

  // The runner's diagnosis is the machine evidence, at the current fence.
  const evidence = await vms.diagnose(registry.getThread(thread.id)!);
  assert.equal(evidence.runner.status, "observed");
  assert.ok(evidence.runner.status === "observed" && evidence.runner.method === "machine_diagnose");
  assert.deepEqual(evidence.runner.status === "observed" && evidence.runner.diagnosis, DOCUMENT);
  assert.equal((of("machineDiagnose")[0]!.value as { fence: { epoch: bigint } }).fence.epoch, (of("machineStart").at(-1)!.value as { fence: { epoch: bigint } }).fence.epoch, "a diagnosis does not move the fence");
  const formatted = formatDiagnostics({ collectedAt: Date.now(), cubed: { version: "test" }, activation: {},
    thread: { id: thread.id, workspaceState: "available", runnerNode: NODE, machine: null }, runnerObservation: {}, machine: evidence });
  assert.match(formatted, /qemu: \{"path":"\/opt\/qemu\/bin\/qemu-system-x86_64","version":"11\.1\.2"\}/, "real paths are shown (B-9 P4)");
  assert.match(formatted, /console: 12 bytes; its last lines:\nkeel booted/);
  assert.match(formatted, /runner events:\n {2}t0 started: boot/);
  console.log("ok: the runner's diagnosis is the machine's evidence and OptChat's text, without moving the fence");

  // keel's own status from the watch: the agent's version, build, kernel, boot and hooks (known names only).
  assert.deepEqual(evidence.guest.status === "observed" && [evidence.guest.ready, evidence.guest.error], [true, null]);
  assert.deepEqual(evidence.guest.status === "observed" && evidence.guest.agent, { version: "0.1.0", build: BUILD, kernel: "6.18.0-keel",
    bootId: "0f6c2d4e-1b7a-4f3e-9c2d-7a1b3c4d5e6f", hooks: { "pre-setup": "ok", setup: "failed:3", "pre-resume": "notrun" } });
  assert.match(formatted, /\nguest agent: 0\.1\.0, build abababababab, kernel 6\.18\.0-keel, boot 0f6c2d4e-1b7a-4f3e-9c2d-7a1b3c4d5e6f; hooks at its last status: pre-setup ok, setup failed:3, pre-resume notrun\n/);
  console.log("ok: the diagnosis shows what the keel agent last said of itself, one line in OptChat's text");

  // The startup log: keel's read of ~/.cache/cube at the current fence, while this process runs the machine.
  const current = registry.getThread(thread.id)!;
  assert.equal(await machinesFor(true).startupLog(current), null, "a process that has not started the machine reads nothing");
  const fences = guestFences.length;
  assert.deepEqual(await vms.startupLog(current), { machine: "thread", hook: null, text: "", bytes: 0, truncated: false }, "no hook runs");
  guestFiles.set("/home/agent/.cache/cube/running", Buffer.from("pre-setup pre-setup.log\n"));
  guestFiles.set("/home/agent/.cache/cube/pre-setup.log", Buffer.from("installing\nC2B-MARKER\n"));
  assert.deepEqual(await vms.startupLog(current), { machine: "thread", hook: "pre-setup", text: "installing\nC2B-MARKER\n", bytes: 22, truncated: false });
  guestFiles.set("/home/agent/.cache/cube/pre-setup.log", Buffer.from(`${"x".repeat(20000)}\nthe last line\n`));
  const long = await vms.startupLog(current);
  assert.deepEqual([long?.hook, long?.truncated, long?.bytes, long?.text.endsWith("the last line\n"), long!.text.length <= 16 * 1024], ["pre-setup", true, 20015, true, true]);
  const epoch = (of("machineStart").at(-1)!.value as { fence: { epoch: bigint } }).fence.epoch;
  assert.ok(guestFences.length > fences && guestFences.slice(fences).every(fence => fence === epoch), "read at the current fence, which it does not move");
  guestFiles.delete("/home/agent/.cache/cube/running");
  assert.equal((await vms.startupLog(current))?.hook, null, "the hook ended");
  console.log("ok: a VM runner's startup log is the running hook and its log's end, read with keel's read at the current fence");

  // The per-call deadline: stop and delete wait for berth's whole stop.
  assert.equal(callTimeout("machineStop"), STOP_TIMEOUT_MS);
  assert.equal(callTimeout("machineDelete"), STOP_TIMEOUT_MS);
  assert.ok(STOP_TIMEOUT_MS >= 60000, "at least berth's worst stop (30 s + 20 s + kill) with room");
  for (const verb of ["machineStart", "machineCreate", "machineGet", "machineDiscard", "machineDiagnose", undefined]) assert.equal(callTimeout(verb), 15000);
  // A release that takes longer than the 15 s of other calls still gets its answer.
  deleteMs = 16000;
  assert.deepEqual(await vms.release(registry.getThread(thread.id)!, true), { retained: true });
  deleteMs = 0;
  assert.equal((of("machineDelete")[0]!.value as { retain: boolean }).retain, true);
  assert.equal(vms.running(registry.getThread(thread.id)!), false);
  console.log("ok: machine_stop and machine_delete get 90 s; a 16 s delete still answers, retained");
  // template_publish gets 600 s through the session's default deadline: 16 s still answers.
  publishMs = 16000;
  const publishing = Date.now();
  const publishedLate = await session.call({ case: "templatePublish", value: { from: { owner: thread.id, id: "0".repeat(16) }, fence: { epoch: 1n }, key: "k", meta: "{}" } });
  publishMs = 0;
  assert.ok(publishedLate.case === "template" && publishedLate.value.id === "0".repeat(16));
  assert.ok(Date.now() - publishing >= 16000);
  console.log("ok: template_publish gets 600 s; a 16 s publication still answers");

  // Discard: the runner deletes the retained disk.
  await vms.discard(registry.getThread(thread.id)!);
  assert.equal(of("machineDiscard").length, 1);
  assert.equal(machines.size, 0);
  await vms.discard(registry.getThread(thread.id)!);
  const evidenceAfter = await vms.diagnose(registry.getThread(thread.id)!);
  assert.deepEqual([evidenceAfter.runner.status, evidenceAfter.runner.status !== "observed" && evidenceAfter.runner.reason], ["none", "the runner has no machine for this thread"]);
  console.log("ok: discard deletes the retained machine on a VM runner; again it finds nothing to do");

  // A host runner keeps its hooks' logs on that host: no startup log.
  registry.enrollRunner({ nodeId: "node-host1", threadId: "node-host1", environmentId: 2, configPath: path.join(root, "host1.json"), configHash: "host1", maxActiveVms: 1, protocol: 4, kind: "host" });
  const onHost = registry.createThread("p", "r3", { provider: "faux", id: "faux" }, "hi", "pi", { runnerId: "node-host1" });
  assert.equal(await vms.startupLog(onHost), null);
  console.log("ok: a host runner's thread has no startup log in cubed");

  // A guest that never gets ready: the boot step and the diagnosis say why, bounded.
  agentSays = { ready: false, reason: `the image has no sudo ${"!".repeat(2000)}`, version: `v${"9".repeat(200)}`, build: "not-a-sha", bootId: "b".repeat(100), hooks: {} };
  const stuck = registry.createThread("p", "r2", { provider: "faux", id: "faux" }, "hi", "pi", { runnerId: NODE });
  const waiting = new RunnerMachines({ registry, threads, session: () => session, sizes, policy, readyTimeoutMs: 1500 });
  await assert.rejects(waiting.start(stuck), (error: Error) => /did not get ready in 2 s: the image has no sudo !+$/.test(error.message));
  const boot = registry.getThread(stuck.id)!.vm!.steps!.find(step => step.name === "boot")!;
  assert.equal(boot.state, "failed");
  assert.match(boot.detail ?? "", new RegExp(`^runner ${NODE}: the guest of machine ${stuck.vm!.vmId} did not get ready in 2 s: the image has no sudo !+$`));
  assert.ok(boot.detail!.length < 700, `the reason is bounded: ${boot.detail!.length}`);
  const stuckEvidence = await waiting.diagnose(registry.getThread(stuck.id)!);
  assert.ok(stuckEvidence.guest.status === "observed");
  assert.equal(stuckEvidence.guest.ready, false);
  assert.match(stuckEvidence.guest.error ?? "", /^the image has no sudo !+$/);
  assert.equal(stuckEvidence.guest.error!.length, 512);
  assert.deepEqual(stuckEvidence.guest.agent, { version: `v${"9".repeat(63)}`, build: "", kernel: "", bootId: "b".repeat(64), hooks: {} }, "every field bounded");
  assert.equal(stuckEvidence.cubed.lastGuestProbe?.error, stuckEvidence.guest.error);
  assert.match(formatDiagnostics({ collectedAt: Date.now(), cubed: { version: "test" }, activation: {}, thread: { id: stuck.id, workspaceState: "failed", runnerNode: NODE, machine: null },
    runnerObservation: {}, machine: stuckEvidence }), /\nguest hello: not ready in 0 ms: the image has no sudo !+\nguest agent: v9+, build \?, kernel \?, boot b+; hooks at its last status: none yet\n/);
  // The runner could not ask it: that, and the runner's reason.
  const key = `${stuck.id}/${stuck.vm!.vmId}`;
  put(withStatus(machines.get(key)!, { phase: MachineStatus_Phase.RUNNING, guest: { connected: false, ready: false, reason: "connecting to the agent again" } }));
  await delay(200);
  const unasked = await waiting.diagnose(registry.getThread(stuck.id)!);
  assert.deepEqual(unasked.guest.status === "observed" && [unasked.guest.error, unasked.guest.agent], ["the runner could not ask the guest: connecting to the agent again", undefined]);
  agentSays = { connected: false, ready: false, reason: "no hello after the reset on channel 0: the machine is unhealthy" };
  await assert.rejects(waiting.start(registry.getThread(stuck.id)!), /did not get ready in 2 s: the runner could not ask the guest: no hello after the reset on channel 0: the machine is unhealthy$/);
  agentSays = READY_AGENT;
  console.log("ok: a guest that does not get ready: the boot step and the diagnosis give the runner's last reason, bounded");

  // K-2b with the binding's reads stubbed (the fake runner and Iroh real).
  assert.equal(PATH_LOG_INTERVAL_MS, 10000);
  const realPaths = Connection.prototype.paths;
  const realStableId = Connection.prototype.stableId;
  const realCloseReason = Connection.prototype.closeReason;
  let paths: (() => PathSnapshot[]) | null = null;
  const fail = (): never => { throw new Error("stub: the binding failed"); };
  const stats = { rttMs: 0, udpTxDatagrams: 0, udpTxBytes: 0, udpRxDatagrams: 0, udpRxBytes: 0, cwnd: 0, congestionEvents: 0, lostPackets: 0, lostBytes: 0, currentMtu: 0 };
  const snapshot = (remoteAddr: string, relay: boolean, rttMs: number): PathSnapshot[] => [{ id: "1", isSelected: false, remoteAddr: "203.0.113.9:1", isIp: true, isRelay: false, rttMs: 1, stats },
    { id: "2", isSelected: true, remoteAddr, isIp: !relay, isRelay: relay, rttMs, stats }];
  const missing = { case: "machineGet" as const, value: { ref: { owner: "k2b", id: "0".repeat(16) } } };
  const answered = (error: unknown) => error instanceof RunnerError && error.code === "NOT_FOUND";
  Connection.prototype.paths = function (this: Connection) { return paths ? paths() : realPaths.call(this); };
  const level = process.env.CUBED_LOG_LEVEL;
  try {
    // Every read throws: the calls are answered; the connected line says unknown, the failure is one debug line.
    process.env.CUBED_LOG_LEVEL = "debug";
    let reads = 0;
    paths = () => { reads++; return fail(); };
    Connection.prototype.stableId = fail;
    Connection.prototype.closeReason = fail;
    const failing = capture();
    const unread = new RunnerSession(config, { log: failing.log, pathLogIntervalMs: 50 });
    await unread.hello();
    await assert.rejects(unread.call(missing), answered);
    await until(() => reads >= 4);
    await assert.rejects(unread.call(missing), answered);
    assert.deepEqual(logged(failing.lines, "runner connected").map(line => [line.kind, line.remote, line.connection]), [["unknown", undefined, undefined]]);
    assert.equal(logged(failing.lines, "runner path unreadable", "debug").length, 1, `once for ${reads} failed reads`);
    assert.deepEqual(logged(failing.lines, "runner path changed"), []);
    restartRunner();
    await until(() => logged(failing.lines, "runner disconnected").length === 1);
    for (let tries = 0; ; tries++) {
      try { await assert.rejects(unread.call(missing), answered); break; } catch (error) { if (tries > 50) throw error; await delay(100); }
    }
    await unread.close();
    assert.equal(logged(failing.lines, "runner connected").length, 2);
    assert.deepEqual(logged(failing.lines, "runner disconnected").map(line => line.reason), ["closed by peer: 0", "the session closed"]);
    if (level === undefined) delete process.env.CUBED_LOG_LEVEL;
    else process.env.CUBED_LOG_LEVEL = level;
    Connection.prototype.stableId = realStableId;
    Connection.prototype.closeReason = realCloseReason;
    console.log("ok: a path read that throws fails no call: the line says kind=unknown and the failure is one debug line");

    // A hello that fails: no line, and nothing logged later.
    paths = null;
    hellosAs = "node-other";
    const refused = capture();
    const wrong = new RunnerSession(config, { log: refused.log, pathLogIntervalMs: 50 });
    await assert.rejects(wrong.hello(), (error: unknown) => error instanceof RunnerError && error.reason === "incompatible_protocol");
    hellosAs = NODE;
    await delay(300);
    await wrong.close();
    assert.deepEqual(refused.lines, [], "nothing is read before a hello is accepted");
    console.log("ok: a refused hello logs no connection and reads no path");

    // The path changes: read every interval, so at most one line per interval and the path then in use wins.
    const changing = capture();
    const watched = new RunnerSession(config, { log: changing.log, pathLogIntervalMs: 100 });
    await watched.hello();
    const [first] = logged(changing.lines, "runner connected");
    assert.equal(first!.kind, "direct");
    // Two paths between reads: only the second is seen.
    paths = () => snapshot("https://relay.example.org./", true, 41);
    paths = () => snapshot("192.0.2.7:4433", false, 12);
    await until(() => logged(changing.lines, "runner path changed").length === 1);
    assert.deepEqual(logged(changing.lines, "runner path changed").map(line => [line.kind, line.remote, line.rttMs, line.connection]),
      [["direct", "192.0.2.7:4433", "12", first!.connection]]);
    // The path flaps every 5 ms for a second while calls go on, one per 25 ms: none waits, at most one line per interval.
    // (Unpaced, one connection stops answering after 99 to 171 calls, as on main: K-2b finding F-K2b-2.)
    const flapping = Date.now();
    let flaps = 0;
    const flapper = setInterval(() => {
      const at = ++flaps % 3;
      const rtt = 40 + flaps;
      paths = () => at === 0 ? snapshot("192.0.2.7:4433", false, 12) : at === 1 ? snapshot("https://relay.example.org./", true, rtt) : [];
    }, 5);
    let slowest = 0;
    let calls = 0;
    while (Date.now() - flapping < 1000) {
      const calling = Date.now();
      await assert.rejects(watched.call(missing), answered);
      slowest = Math.max(slowest, Date.now() - calling);
      calls++;
      await delay(25);
    }
    clearInterval(flapper);
    const flapMs = Date.now() - flapping;
    paths = () => snapshot("198.51.100.4:7777", false, 77);
    await until(() => logged(changing.lines, "runner path changed").at(-1)?.remote === "198.51.100.4:7777");
    const changes = logged(changing.lines, "runner path changed");
    assert.ok(changes.length - 1 <= Math.ceil((Date.now() - flapping) / 100) + 1, `${changes.length - 1} lines for ${flaps} changes in ${flapMs} ms`);
    assert.ok(slowest < 1000, `a call while the path changed took ${slowest} ms`);
    assert.deepEqual([changes.at(-1)!.kind, changes.at(-1)!.rttMs], ["direct", "77"], "the path in use last wins");
    assert.ok(changes.some(line => line.kind === "relay" && line.remote === "https://relay.example.org./"), "a relay path is kind=relay");
    paths = () => snapshot("198.51.100.4:7777", false, 5);
    await delay(300);
    assert.equal(logged(changing.lines, "runner path changed").length, changes.length, "the same path, its RTT changed, logs nothing");
    console.log(`ok: ${flaps} path changes in ${flapMs} ms gave ${changes.length - 1} lines at a 100 ms interval, the last path winning; ${calls} calls meanwhile, the slowest ${slowest} ms`);

    // close(): the close line once, and nothing after it.
    await watched.close();
    const closedAt = changing.lines.length;
    assert.deepEqual(logged(changing.lines, "runner disconnected").map(line => [line.reason, line.connection]), [["the session closed", first!.connection]]);
    paths = () => snapshot("192.0.2.8:4433", false, 3);
    await delay(500);
    assert.equal(changing.lines.length, closedAt, `nothing after close(): ${changing.lines.slice(closedAt).join("")}`);
    console.log("ok: close() logs the close once and stops reading the path");
  } finally {
    paths = null;
    if (level === undefined) delete process.env.CUBED_LOG_LEVEL;
    else process.env.CUBED_LOG_LEVEL = level;
    Connection.prototype.paths = realPaths;
    Connection.prototype.stableId = realStableId;
    Connection.prototype.closeReason = realCloseReason;
  }

  // A berth vm that does not answer: its thread waits there, whether it was
  // placed there from the pool or started there by name.
  {
    const waiting = new Registry(path.join(root, "waiting.sqlite"));
    waiting.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
    waiting.enrollRunner({ nodeId: "node-quiet", threadId: "quiet", environmentId: 1, configPath: path.join(root, "quiet.json"), configHash: "quiet",
      maxActiveVms: 2, protocol: 4, kind: "vm" });
    const quiet = { nodeId: "node-quiet", hello: async () => { throw new RunnerError("UNAVAILABLE", "", "no answer"); } } as unknown as RunnerSession;
    const machines = new RunnerMachines({ registry: waiting, threads: path.join(root, "waiting-threads"), session: () => quiet, sizes, policy });
    const pooled = waiting.createThread("p", "pooled", { provider: "faux", id: "faux" }, "hi");
    const named = waiting.createThread("p", "named", { provider: "faux", id: "faux" }, "hi", "pi", { runnerId: "quiet" });
    assert.deepEqual([pooled.runnerId, pooled.pinned, named.pinned], ["quiet", undefined, true]);
    await assert.rejects(machines.start(pooled), (error: Error) => error instanceof RunnerWait
      && error.message === "waiting for runner node-quiet: it does not answer; this thread was placed on it and stays there");
    await assert.rejects(machines.start(named), (error: Error) => error instanceof RunnerWait
      && error.message === "waiting for runner node-quiet: it does not answer; this thread was started on it by name and stays there");
    waiting.close();
    console.log("ok: a berth vm that does not answer: its thread waits, placed there from the pool or by name");
  }
} finally {
  await session.close();
  registry.close();
  await runnerEndpoint.close();
  fs.rmSync(root, { recursive: true, force: true });
}
