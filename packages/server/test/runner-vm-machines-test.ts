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
 * `machine_discard`, and the per-call deadline.
 * The runner's rules are berth's (runner-vm-test.ts runs the real one);
 * this tests what cubed sends and how it reads the answers. Offline. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { clone, create, fromJsonString, toJsonString, type DescMessage, type MessageInitShape } from "@bufbuild/protobuf";
import { Endpoint, SecretKey, type BiStream, type Connection } from "@number0/iroh/index.js";
import { CallResultSchema, CallSchema, Code, EgressPolicy_Default, GuestInfoSchema, HelloAnswerSchema, MachineSchema, MachineStatusSchema, MetaSchema, MachineStatus_Phase, OpenSchema, Runner_Kind, StreamAnswerSchema,
  WatchEvent_Type, WatchEventSchema, type Machine } from "../src/gen/runner_pb.js";
import { EgressPolicy } from "../src/egress-policy.ts";
import { Registry } from "../src/registry.ts";
import { RunnerMachines } from "../src/runner-machines.ts";
import { callTimeout, RunnerSession, STOP_TIMEOUT_MS, type SessionConfig } from "../src/runner-session.ts";
import { formatDiagnostics } from "../src/vm-diagnostics.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cube-vm-machines-")));
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
            await stream.send.writeAll(frame(HelloAnswerSchema, { protocol: 4, runner: { nodeId: NODE, kind: Runner_Kind.VM,
              limits: { maxVcpus: 3, maxMemoryMib: 6144, maxDiskGib: 20, maxMachines: 2, maxBootBytes: 262144 } } }));
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
const session = new RunnerSession(config);
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
  const thread = registry.createThread("p", "r1", { provider: "faux", id: "faux" }, "hi", "pi", undefined, { runnerId: NODE });
  assert.equal(thread.pinned, true, "only by name (C-a decision 1)");
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
  assert.deepEqual(steps.map(step => [step.name, step.state]), [["boot", "ok"]]);
  assert.equal(steps[0]!.detail, `a keel machine on VM runner ${NODE}: 3 vCPU, 4096 MiB memory, 20 GiB disk`);
  assert.equal(registry.getThread(thread.id)!.vm!.placement, "allocated");
  assert.ok(vms.running(registry.getThread(thread.id)!));

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
  console.log("ok: a VM runner's machine is created with its size and started with its size, boot documents and policy every time; cubed waits for the guest's ready");

  // The runner's diagnosis is the machine evidence, at the current fence.
  const evidence = await vms.diagnose(registry.getThread(thread.id)!);
  assert.equal(evidence.runner.status, "observed");
  assert.ok(evidence.runner.status === "observed" && evidence.runner.method === "machine_diagnose");
  assert.deepEqual(evidence.runner.status === "observed" && evidence.runner.diagnosis, DOCUMENT);
  assert.equal((of("machineDiagnose")[0]!.value as { fence: { epoch: bigint } }).fence.epoch, (of("machineStart").at(-1)!.value as { fence: { epoch: bigint } }).fence.epoch, "a diagnosis does not move the fence");
  assert.equal(evidence.gateway.status, "none");
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
  const onHost = registry.createThread("p", "r3", { provider: "faux", id: "faux" }, "hi", "pi", undefined, { runnerId: "node-host1" });
  assert.equal(await vms.startupLog(onHost), null);
  console.log("ok: a host runner's thread has no startup log in cubed");

  // A guest that never gets ready: the boot step and the diagnosis say why, bounded.
  agentSays = { ready: false, reason: `the image has no sudo ${"!".repeat(2000)}`, version: `v${"9".repeat(200)}`, build: "not-a-sha", bootId: "b".repeat(100), hooks: {} };
  const stuck = registry.createThread("p", "r2", { provider: "faux", id: "faux" }, "hi", "pi", undefined, { runnerId: NODE });
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
} finally {
  await session.close();
  registry.close();
  await runnerEndpoint.close();
  fs.rmSync(root, { recursive: true, force: true });
}
