/** Suspend in cubed (masterplan S-7a, phase 7 P7-5; B7-1…B7-5, K-5, K-6,
 * K-8), offline:
 *
 *   1. machine-idle.ts: a command is busy from its `exec` until a `get`
 *      says it ended, also between polls with no call open; one no one asks
 *      about counts until its timeout and the grace; a portal connection
 *      until it closes; idle time runs from the last of them.
 *   2. conversation.ts: the recovery loop leaves a suspended machine alone
 *      (and does not continue a wake no one owns); an idle round asks the machines with the
 *      conversation's own busy check (a start, an archive, the agent's run
 *      or its background agents); a message to a suspended thread wakes it
 *      before the agent gets it.
 *   3. runner-machines.ts against a fake `berth vm` over Iroh on loopback:
 *      no `machine_suspend` without the runner's `machine.suspend`, before
 *      the idle time, while a command runs between polls, or while the
 *      conversation is busy; then one, and the thread holds no slot; a guest
 *      call wakes it (the same boot), waiting while the runner is full
 *      (`RESOURCE_EXHAUSTED/capacity`), and a guest call that comes during a
 *      suspend waits for it; a dropped snapshot leaves the B7-5 notice; the
 *      runner's refusals (`disk`, `busy`) keep the machine running, a
 *      runner without the verb (K-6) is not asked again until it runs
 *      another version, and a suspend with no answer in time is read back
 *      with `machine_get`, waiting while it says SUSPENDING (K-8); a
 *      registered service keeps it running (N-207-8); a start during a
 *      suspend waits for it; one suspend per runner at a time (B-207-3);
 *      the recovery loop's own ticks with real Conversations suspend an idle
 *      machine once (B-207-1); a restarted cubed does not suspend a running
 *      machine before the guest's longest command and the grace (B-207-2).
 *
 * The runner's own rules are berth's (runner-vm-suspend-test.ts runs the
 * real one); this tests what cubed decides and sends. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { clone, create, fromJsonString, toJsonString, type DescMessage, type MessageInitShape } from "@bufbuild/protobuf";
import { Endpoint, SecretKey, type BiStream } from "@number0/iroh/index.js";
import { CallResultSchema, CallSchema, Code, GuestInfoSchema, HelloAnswerSchema, MachineSchema, MachineStatusSchema, MetaSchema, MachineStatus_Phase,
  OpenSchema, Runner_Kind, StreamAnswerSchema, WatchEvent_Type, WatchEventSchema, type Machine } from "../src/gen/runner_pb.js";
import { Conversations } from "../src/conversation.ts";
import { EgressPolicy } from "../src/egress-policy.ts";
import { DEFAULT_EXEC_TIMEOUT_MS, EXEC_GRACE_MS, IDLE_MS, MachineActivity } from "../src/machine-idle.ts";
import type { GuestTransport } from "../src/guest-transport.ts";
import { createModels } from "@earendil-works/pi-ai";
import { Registry, type Thread } from "../src/registry.ts";
import { slotWait } from "../src/machine-sleep.ts";
import { RunnerMachines } from "../src/runner-machines.ts";
import { RunnerSession, type SessionConfig } from "../src/runner-session.ts";
import { NoMachines } from "./local-guest.ts";

// ------------------------------------------------ 1. machine-idle.ts

{
  let now = 1_000_000;
  const activity = new MachineActivity(() => now);
  const answers: Record<string, string> = {};
  const fake: GuestTransport = {
    call: async (op, header) => ({ header: { state: answers[`${op}:${String(header.id)}`] ?? "Running" }, body: Buffer.alloc(0) }),
    close: async () => {},
  };
  // B-207-2: a machine first seen running (a cubed that restarted) may run
  // commands cubed started before: busy for the guest's longest command and
  // the grace. (d6b10971 said idle here, and suspended it after 5 minutes.)
  const before = DEFAULT_EXEC_TIMEOUT_MS + EXEC_GRACE_MS;
  assert.equal(activity.busy("r"), "commands may still run from before cubed restarted");
  now += before - 1;
  assert.equal(activity.idleMs("r"), 0, "not idle for 32 minutes after a restart");
  now += 2;
  assert.equal(activity.busy("r"), null, "past the longest command and the grace");
  now += IDLE_MS;
  assert.equal(activity.idleMs("r"), IDLE_MS + 2, "idle from the last time it was seen busy");
  // A machine cubed started or resumed itself runs nothing from before.
  const guest = activity.guest("t", fake);
  activity.started("t");
  assert.equal(activity.busy("t"), null);
  assert.equal(activity.idleMs("t"), 0, "a machine started now has been idle for no time");
  now += IDLE_MS;
  assert.equal(activity.idleMs("t"), IDLE_MS, "idle since it was started");
  // A command: busy from its exec, between polls (no call open), until a get says it ended.
  await guest.call("exec", { id: "k1", timeoutMs: 600000, command: "sleep 100" });
  now += 60_000;
  assert.equal(activity.busy("t"), "1 command(s) running", "between polls");
  assert.equal(activity.idleMs("t"), 0);
  await guest.call("get", { id: "k1" });
  now += 60_000;
  assert.equal(activity.busy("t"), "1 command(s) running", "a get that says Running keeps it");
  answers["get:k1"] = "Succeeded";
  await guest.call("get", { id: "k1" });
  assert.equal(activity.busy("t"), null, "a get that says it ended ends it");
  now += IDLE_MS - 1;
  assert.equal(activity.idleMs("t"), IDLE_MS - 1, "idle from the last call");
  // A command cubed sees only in a get (after a restart) counts too.
  await guest.call("get", { id: "k2" });
  assert.equal(activity.busy("t"), "1 command(s) running");
  answers["get:k2"] = "Interrupted";
  await guest.call("get", { id: "k2" });
  assert.equal(activity.busy("t"), null);
  // N-207-3: no operation with that key (Unknown) runs nothing.
  answers["get:gone"] = "Unknown";
  await guest.call("get", { id: "gone" });
  assert.equal(activity.busy("t"), null, "Unknown is not a running command");
  // N-207-3: a get that says Running counts on the command's own timeout.
  await guest.call("exec", { id: "k4", timeoutMs: 1000 });
  now += 500;
  await guest.call("get", { id: "k4" });
  now += 1000 + EXEC_GRACE_MS + 1;
  assert.equal(activity.busy("t"), null, "re-armed with its own timeout, not the guest's longest");
  // One no one asks about again counts until its timeout and the grace.
  await guest.call("exec", { id: "k3", timeoutMs: 1000 });
  now += 1000 + EXEC_GRACE_MS - 1;
  assert.equal(activity.busy("t"), "1 command(s) running");
  now += 2;
  assert.equal(activity.busy("t"), null, "past its timeout and the grace");
  // A call open is busy while it lasts.
  let release = () => {};
  const slow: GuestTransport = { call: () => new Promise(resolve => { release = () => resolve({ header: {}, body: Buffer.alloc(0) }); }), close: async () => {} };
  activity.started("u");
  const pending = activity.guest("u", slow).call("read", { path: "x" });
  assert.equal(activity.busy("u"), "1 guest call(s) open");
  release();
  await pending;
  assert.equal(activity.busy("u"), null);
  // A portal connection while it is open.
  activity.started("v");
  const socket = activity.dial("v", new PassThrough());
  assert.equal(activity.busy("v"), "1 portal connection(s) open");
  socket.destroy();
  await delay(10);
  assert.equal(activity.busy("v"), null);
  // A call waits for `before` (a wake).
  const order: string[] = [];
  await activity.guest("w", { call: async () => { order.push("call"); return { header: {}, body: Buffer.alloc(0) }; }, close: async () => {} },
    async () => { order.push("before"); }).call("hello", {});
  assert.deepEqual(order, ["before", "call"]);
  console.log("ok: machine-idle: a machine first seen running is busy for the longest command and the grace (B-207-2); a command is busy from exec until a get says it ended (also between polls), or until its own timeout and the grace; calls and portal connections while open");
}

// ------------------------------------------------ 2. conversation.ts

{
  const thread = (id: string, vm: Partial<NonNullable<Thread["vm"]>> = {}) => ({ id, archived: false, workspaceState: "available", runnerId: "r",
    vm: { vmId: id.padEnd(16, "0"), placeholders: {}, ...vm } }) as unknown as Thread;
  const threads = [thread("idle"), thread("asleep", { suspension: { state: "suspended", at: 1 } }), thread("waking", { suspension: { state: "waking", at: 1 } }),
    thread("claude"), thread("working")];
  const asked: Array<{ id: string; busy: string | null }> = [];
  class Asked extends NoMachines {
    override async suspendIfIdle(t: Thread, busy: () => Promise<string | null>): Promise<boolean> { asked.push({ id: t.id, busy: await busy() }); return false; }
  }
  const machines = new Asked();
  const started = machines.starts;
  const registry = { listThreads: () => threads, getThread: (id: string) => threads.find(t => t.id === id) ?? null, interruptStartupSteps: () => {} } as unknown as Registry;
  const conversations = new Conversations({ registry, directory: fs.mkdtempSync(path.join(os.tmpdir(), "cube-suspend-conv-")), models: createModels(), machines });
  await conversations.boot();
  assert.deepEqual(started.sort(), ["claude", "idle", "working"], "the recovery loop leaves the suspended machine alone, and a wake no one owns (thread-lifecycle-test.ts R1) is not continued");
  // The conversation's own busy check: the agent's run, its background agents.
  const inside = conversations as unknown as { claudes: Map<string, Promise<unknown>>; activations: Map<string, Promise<void>> };
  inside.claudes.set("claude", Promise.resolve({ running: false, waiting: ["a background agent"] }));
  inside.claudes.set("working", Promise.resolve({ running: true, waiting: [] }));
  await conversations.suspendIdle();
  assert.deepEqual(asked.sort((a, b) => a.id.localeCompare(b.id)), [
    { id: "claude", busy: "the agent's background agents run" }, { id: "idle", busy: null }, { id: "working", busy: "the agent is working" },
  ], "suspended and waking threads are not asked; busy ones say why");
  // A start under way: not even asked.
  asked.length = 0;
  inside.activations.set("idle", new Promise(() => {}));
  await conversations.suspendIdle();
  assert.ok(!asked.some(entry => entry.id === "idle"), "a thread whose machine starts is not asked");
  inside.activations.delete("idle");
  // B-207-1: the recovery loop's check of a running machine is not a start:
  // the idle round waits for it, then asks.
  asked.length = 0;
  const checks = (conversations as unknown as { checks: Set<string> }).checks;
  let finish = () => {};
  inside.activations.set("idle", new Promise<void>(resolve => { finish = () => { inside.activations.delete("idle"); checks.delete("idle"); resolve(); }; }));
  checks.add("idle");
  const round = conversations.suspendIdle();
  await delay(20);
  assert.ok(!asked.some(entry => entry.id === "idle"), "not while the check runs");
  finish();
  await round;
  assert.deepEqual(asked.find(entry => entry.id === "idle"), { id: "idle", busy: null }, "asked once the check ended");
  // A message to a suspended thread wakes it before the agent gets it.
  started.length = 0;
  await (conversations as unknown as { wakeFor(id: string): Promise<void> }).wakeFor("asleep");
  assert.deepEqual(started, ["asleep"], "woken through the thread's activation");
  console.log("ok: conversation: the recovery loop leaves a suspended machine alone; idle rounds carry the agent's run, background agents and starts as busy; a message wakes a suspended thread first");
}

// ------------------------------------------------ 3. runner-machines.ts against a fake berth vm

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cube-suspend-")));
const ALPN = Array.from(Buffer.from("cubeyard/runner/4"));
const builder = Endpoint.builder();
builder.applyMinimal();
builder.secretKey(SecretKey.generate().toBytes());
builder.alpns([ALPN]);
builder.bindAddr("127.0.0.1:0");
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

const NODE = "node-vm-suspend";
const calls: string[] = [];
const machines = new Map<string, Machine>();
const watchers = new Set<BiStream>();
let version = 0n;
let boots = 0;
/** What the fake runner does next. */
const fake = {
  capabilities: ["machine.suspend"],
  /** `machine_suspend`: suspend, or refuse with this. */
  suspend: null as null | { code: Code; reason: string },
  /** `machine_suspend` answers after this long (K-8). */
  suspendMs: 0,
  /** `machine_start` on a suspended machine: refused with capacity this many more times. */
  full: 0,
  /** `machine_start` on a suspended machine answers after this long. */
  startMs: 0,
  /** `machine_start` on a suspended machine: the snapshot is dropped. */
  drop: false,
  /** `get` answers (by operation id) for guest streams. */
  states: {} as Record<string, string>,
  /** What `services` answers: the registered services. */
  services: [] as Array<{ name: string; port: number; kind: string }>,
  /** The runner's software version in its hello. */
  version: "0.1.0",
  /** `machine_suspend` answers that it has no such verb, though the runner
   * says machine.suspend (K-6). */
  noVerb: false,
  /** `machine_suspend` shows SUSPENDING this long before it ends (K-8). */
  savingMs: 0,
  /** …and then is undone: RUNNING, UNAVAILABLE/snapshot. */
  undo: false,
};
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
const ready = (machine: Machine) => put(withStatus(machine, { phase: MachineStatus_Phase.RUNNING, bootId: machine.status?.bootId ?? "",
  conditions: machine.status?.conditions ?? [], guest: create(GuestInfoSchema, { connected: true, ready: true, since: { seconds: 1n, nanos: 0 } }) }));

async function answerCall(stream: BiStream, verb: ReturnType<typeof fromJsonString<typeof CallSchema>>["verb"]): Promise<void> {
  const reply = async (result: MessageInitShape<typeof CallResultSchema>["result"]) => {
    await stream.send.writeAll(frame(CallResultSchema, { result }));
    await stream.send.finish();
  };
  const refuse = (code: Code, reason: string, message: string) => reply({ case: "error", value: { code, reason, message } });
  if (!verb.case) return refuse(Code.INVALID_ARGUMENT, "verb", "no verb");
  calls.push(verb.case);
  const value = verb.value as { ref?: { owner: string; id: string } };
  const key = `${value.ref?.owner}/${value.ref?.id}`;
  const known = machines.get(key);
  switch (verb.case) {
    case "machineGet": return known ? reply({ case: "machine", value: known }) : refuse(Code.NOT_FOUND, "machine", "no such machine");
    case "machineCreate":
      return reply({ case: "machine", value: put(create(MachineSchema, { ref: value.ref, spec: verb.value.spec, status: { phase: MachineStatus_Phase.STOPPED } })) });
    case "machineStart": {
      if (!known) return refuse(Code.NOT_FOUND, "machine", "no such machine");
      if (known.status?.phase === MachineStatus_Phase.RUNNING) return reply({ case: "machine", value: known });
      if (known.status?.phase === MachineStatus_Phase.SUSPENDED) {
        await delay(fake.startMs);
        if (fake.full > 0) { fake.full--; return refuse(Code.RESOURCE_EXHAUSTED, "capacity", "the runner hosts as many machines as it may; the machine stays suspended"); }
        const dropped = fake.drop;
        fake.drop = false;
        const resumed = put(withStatus(known, { phase: MachineStatus_Phase.STARTING, bootId: dropped ? `boot${++boots}`.padEnd(32, "0") : known.status.bootId,
          conditions: dropped ? [{ type: "SnapshotDropped", status: true, reason: "version", message: "saved under another runner setup: berth 0.1.0 → 0.1.1" }] : [] }));
        await reply({ case: "machine", value: resumed });
        await delay(30);
        ready(resumed);
        return;
      }
      const started = put(withStatus(known, { phase: MachineStatus_Phase.STARTING, bootId: `boot${++boots}`.padEnd(32, "0") }));
      await reply({ case: "machine", value: started });
      await delay(30);
      ready(started);
      return;
    }
    case "machineSuspend": {
      if (!fake.capabilities.includes("machine.suspend") || fake.noVerb) return refuse(Code.INVALID_ARGUMENT, "verb", "unknown or missing verb");
      if (fake.suspend) return refuse(fake.suspend.code, fake.suspend.reason, "refused by the fake");
      if (!known) return refuse(Code.NOT_FOUND, "machine", "no such machine");
      if (fake.savingMs) {
        put(withStatus(known, { phase: MachineStatus_Phase.SUSPENDING, bootId: known.status?.bootId ?? "", conditions: known.status?.conditions ?? [] }));
        await delay(fake.savingMs);
        if (fake.undo) {
          ready(known);
          return refuse(Code.UNAVAILABLE, "snapshot", "the machine was not suspended and keeps running: the fake undid it");
        }
      }
      const suspended = put(withStatus(known, { phase: MachineStatus_Phase.SUSPENDED, bootId: known.status?.bootId ?? "",
        suspended: { savedAt: { seconds: 1n, nanos: 0 }, memoryBytes: 123n << 20n } }));
      await delay(fake.suspendMs);
      return reply({ case: "machine", value: suspended });
    }
    default: return refuse(Code.UNIMPLEMENTED, "verb", `${verb.case} is not faked`);
  }
}

void (async () => {
  for (;;) {
    const incoming = await runnerEndpoint.acceptNext();
    if (!incoming) return;
    const connection = await (await incoming.accept()).connect();
    void (async () => {
      for (;;) {
        let stream: BiStream;
        try { stream = await connection.acceptBi(); } catch { return; }
        void (async () => {
          const opened = fromJsonString(OpenSchema, await readFrame(stream), { ignoreUnknownFields: true });
          if (opened.kind.case === "hello") {
            await stream.send.writeAll(frame(HelloAnswerSchema, { protocol: 4, capabilities: fake.capabilities, runner: { nodeId: NODE, softwareVersion: fake.version, kind: Runner_Kind.VM,
              network: { mode: "loopback" }, limits: { maxVcpus: 2, maxMemoryMib: 2048, maxDiskGib: 8, maxMachines: 1, maxBootBytes: 262144 } } }));
            await stream.send.finish();
          } else if (opened.kind.case === "watch") {
            await stream.send.writeAll(frame(WatchEventSchema, { type: WatchEvent_Type.RESET }));
            for (const machine of machines.values()) await stream.send.writeAll(frame(WatchEventSchema, { type: WatchEvent_Type.PUT, resource: { case: "machine", value: machine } }));
            watchers.add(stream);
          } else if (opened.kind.case === "call") await answerCall(stream, opened.kind.value.verb);
          else if (opened.kind.case === "guest") {
            const op = opened.kind.value.op;
            calls.push(`guest:${op}`);
            const request = Buffer.from(await stream.recv.readToEnd(1024 * 1024));
            const header = JSON.parse(request.subarray(0, request.indexOf(10)).toString("utf8")) as { id?: string };
            const machine = machines.get(`${opened.kind.value.ref!.owner}/${opened.kind.value.ref!.id}`);
            if (machine?.status?.phase !== MachineStatus_Phase.RUNNING) {
              await stream.send.writeAll(frame(StreamAnswerSchema, { error: { code: Code.UNAVAILABLE, reason: "suspended", message: "the machine is suspended" } }));
              await stream.send.finish();
              return;
            }
            const answer = op === "exec" || op === "get" ? { state: fake.states[header.id ?? ""] ?? "Running" }
              : op === "services" ? { services: fake.services } : { ok: true };
            await stream.send.writeAll(frame(StreamAnswerSchema, {}));
            await stream.send.writeAll(Array.from(Buffer.from(`${JSON.stringify(answer)}\n`)));
            await stream.send.finish();
          }
        })().catch(error => console.error("FAKE", error));
      }
    })();
  }
})();

const config: SessionConfig = { version: 2, protocol: 4, binding: { nodeId: NODE, threadId: NODE, environmentId: 1 }, controlKey,
  serverPeer: runnerEndpoint.id().toString(), network: "loopback", address };
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as never;
const registry = new Registry(path.join(root, "registry.sqlite"));
registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [],
  hooks: { preSetup: "", preResume: "" } });
registry.enrollRunner({ nodeId: NODE, threadId: NODE, environmentId: 1, configPath: path.join(root, "vm.json"), configHash: "vm", maxActiveVms: 2, protocol: 4, kind: "vm" });
const policy = new EgressPolicy({ vms: { vm: () => null }, secrets: [] });
const IDLE = 300;
const sessionNow = () => new RunnerSession(config, { log: quiet });
let session = sessionNow();
const vms = new RunnerMachines({ registry, threads: path.join(root, "threads"), session: () => session, policy, idleMs: IDLE, wakeRetryMs: 50, wakeWaitMs: 10000,
  suspendTimeoutMs: 400, log: quiet });
const count = (verb: string) => calls.filter(call => call === verb).length;
const fresh = (thread: Thread) => registry.getThread(thread.id)!;
const idle = () => Promise.resolve(null);
try {
  const thread = registry.createThread("p", "t1", { provider: "faux", id: "faux" }, "hi", "pi", undefined, { runnerId: NODE });
  await vms.start(fresh(thread));
  registry.applyPhase(thread.id, { type: "ready", base: null });
  assert.ok(vms.running(fresh(thread)));
  assert.equal(registry.runnerSlots().free, 1, "the thread holds one of the runner's two slots");
  const boot = session.machines.get(`${thread.id}/${thread.vm!.vmId}`)?.status?.bootId;

  // Not before the idle time.
  assert.equal(await vms.suspendIfIdle(fresh(thread), idle), false);
  assert.equal(count("machineSuspend"), 0, "not idle yet");
  // K-5: a command running between polls (no call open) keeps it.
  const guest = vms.guest(fresh(thread));
  await guest.call("exec", { id: "cmd", epoch: 1, command: "sleep 600", timeoutMs: 600000 });
  await delay(IDLE * 2);
  assert.equal(await vms.suspendIfIdle(fresh(thread), idle), false);
  assert.equal(count("machineSuspend"), 0, "never with a command running, even between polls");
  fake.states.cmd = "Succeeded";
  await guest.call("get", { id: "cmd" });
  await delay(IDLE * 2);
  // The conversation's own busy (the agent's run): no suspend.
  assert.equal(await vms.suspendIfIdle(fresh(thread), () => Promise.resolve("the agent is working")), false);
  assert.equal(count("machineSuspend"), 0, "never while the agent works");
  await delay(IDLE * 2);
  // Idle: suspended; it holds no slot; it is not running.
  assert.equal(await vms.suspendIfIdle(fresh(thread), idle), true);
  assert.equal(count("machineSuspend"), 1);
  assert.equal(fresh(thread).vm!.suspension?.state, "suspended");
  assert.equal(fresh(thread).vm!.suspension?.memoryBytes, 123 * 2 ** 20);
  assert.equal(vms.running(fresh(thread)), false);
  assert.equal(registry.runnerSlots().free, 2, "B7-2: a suspended machine frees its slot");
  console.log("ok: suspended only after the idle time, never while a command runs between polls or the agent works; then it holds no slot");

  // A guest call wakes it: the same boot.
  const starts = count("machineStart");
  await vms.guest(fresh(thread)).call("hello", {});
  assert.equal(count("machineStart"), starts + 1, "woken with machine_start");
  assert.equal(fresh(thread).vm!.suspension, undefined);
  assert.ok(vms.running(fresh(thread)));
  assert.equal(session.machines.get(`${thread.id}/${thread.vm!.vmId}`)?.status?.bootId, boot, "a resume is not a boot");
  assert.equal(registry.runnerSlots().free, 1);
  console.log("ok: a guest call to a suspended machine wakes it first (machine_start), on the same boot");

  // B7-2: a full runner: the thread waits, saying so, and resumes once it can.
  await delay(IDLE * 2);
  assert.equal(await vms.suspendIfIdle(fresh(thread), idle), true);
  fake.full = 3;
  // While a try is with the runner the slot is reserved (waking, no
  // waiting); each refusal says it waits.
  fake.startMs = 100;
  const woken = vms.guest(fresh(thread)).call("hello", {});
  for (const deadline = Date.now() + 5000; !slotWait(fresh(thread).vm!.suspension);) {
    assert.ok(Date.now() < deadline, "a refused try says the wake waits");
    await delay(10);
  }
  assert.equal(fresh(thread).vm!.suspension?.state, "waking");
  assert.match(slotWait(fresh(thread).vm!.suspension) ?? "", /^waiting for a free slot on runner node-vm-suspend/);
  await woken;
  assert.equal(fake.full, 0);
  assert.equal(fresh(thread).vm!.suspension, undefined, "resumed once a slot was free");
  fake.startMs = 0;
  console.log("ok: with the runner full the wake waits (the thread says it waits for a free slot) and resumes once it can");

  // A call that comes during a suspend waits for it, then wakes the machine.
  await delay(IDLE * 2);
  fake.suspendMs = 200;
  const suspending = vms.suspendIfIdle(fresh(thread), idle);
  await delay(50);
  const during = calls.length;
  await vms.guest(fresh(thread)).call("hello", {});
  assert.deepEqual(calls.slice(during).filter(call => call !== "machineGet"), ["machineStart", "guest:hello"], "the call waited for the suspend and woke the machine");
  assert.equal(await suspending, true);
  fake.suspendMs = 0;
  console.log("ok: a guest call that comes during a suspend waits for its end, then wakes the machine");

  // B7-5: a snapshot the runner could not use: started from its disk, with the notice.
  await delay(IDLE * 2);
  assert.equal(await vms.suspendIfIdle(fresh(thread), idle), true);
  fake.drop = true;
  await vms.guest(fresh(thread)).call("hello", {});
  assert.deepEqual(fresh(thread).vm!.notice?.text, "restarted after an update; running commands were interrupted");
  assert.notEqual(session.machines.get(`${thread.id}/${thread.vm!.vmId}`)?.status?.bootId, boot, "a new boot");
  console.log("ok: a dropped snapshot (SnapshotDropped/version) starts the machine from its disk with the B7-5 notice");

  // A wake the conversation declines (an archive holds the thread) still
  // resumes the machine, by a start, for the archive's check of its disk.
  await delay(IDLE * 2);
  assert.equal(await vms.suspendIfIdle(fresh(thread), idle), true);
  vms.onWake = async () => {};
  await vms.guest(fresh(thread)).call("hello", {});
  assert.equal(fresh(thread).vm!.suspension, undefined, "resumed though the conversation did not wake it");
  assert.equal(fresh(thread).vm!.notice, undefined, "N-207-6: a resume clears the notice of an earlier cold start");
  vms.onWake = null;
  console.log("ok: a wake the conversation declines (an archive under way) resumes the machine by a start");

  // Refusals keep it running: low disk (not asked again soon), busy.
  await delay(IDLE * 2);
  fake.suspend = { code: Code.FAILED_PRECONDITION, reason: "busy" };
  assert.equal(await vms.suspendIfIdle(fresh(thread), idle), false);
  assert.ok(vms.running(fresh(thread)) && !fresh(thread).vm!.suspension);
  await delay(IDLE * 2);
  fake.suspend = { code: Code.RESOURCE_EXHAUSTED, reason: "disk" };
  const before = count("machineSuspend");
  assert.equal(await vms.suspendIfIdle(fresh(thread), idle), false);
  assert.ok(vms.running(fresh(thread)), "low disk: the machine keeps running");
  await delay(IDLE * 2);
  assert.equal(await vms.suspendIfIdle(fresh(thread), idle), false);
  assert.equal(count("machineSuspend"), before + 1, "and is not asked again soon");
  fake.suspend = null;
  console.log("ok: the runner's refusals (busy, low disk) keep the machine running; low disk is not asked again soon");
  const retry = (vms as unknown as { suspendRetry: Map<string, number> }).suspendRetry;

  // N-207-8, until the user decides: a registered service keeps it running.
  retry.delete(thread.id);
  await delay(IDLE * 2);
  fake.services = [{ name: "web", port: 8080, kind: "command" }];
  const withService = count("machineSuspend");
  assert.equal(await vms.suspendIfIdle(fresh(thread), idle), false);
  assert.equal(count("machineSuspend"), withService, "a registered service: never asked");
  assert.ok(vms.running(fresh(thread)));
  fake.services = [];
  console.log("ok: a machine with a registered service is not suspended (N-207-8: until the user decides)");

  // K-8: still SUSPENDING when cubed's wait runs out: the gate stays up (a
  // guest call waits) until the runner says SUSPENDED.
  await delay(IDLE * 2);
  fake.savingMs = 600;
  const saving = vms.suspendIfIdle(fresh(thread), idle);
  await delay(450);
  const atTimeout = calls.length;
  const waiting = vms.guest(fresh(thread)).call("hello", {});
  await delay(50);
  assert.ok(!calls.slice(atTimeout).some(call => call.startsWith("guest:") || call === "machineStart"), "nothing reaches the machine while it saves");
  assert.equal(await saving, true, "SUSPENDING, then SUSPENDED: suspended");
  await waiting;
  assert.equal(fresh(thread).vm!.suspension, undefined, "the waiting call woke it after the save");
  // …and an undo (SUSPENDING, then RUNNING): not suspended, still running.
  await delay(IDLE * 2);
  fake.undo = true;
  assert.equal(await vms.suspendIfIdle(fresh(thread), idle), false);
  assert.ok(vms.running(fresh(thread)) && !fresh(thread).vm!.suspension);
  fake.savingMs = 0;
  fake.undo = false;
  retry.delete(thread.id);
  console.log("ok: K-8: a machine still SUSPENDING past cubed's wait keeps the gate up until the runner says SUSPENDED or RUNNING");

  // A start during a suspend waits for its end, then resumes it (B-207-1).
  await delay(IDLE * 2);
  fake.suspendMs = 200;
  const asleep = vms.suspendIfIdle(fresh(thread), idle);
  await delay(50);
  const saveStart = calls.length;
  const restart = vms.start(fresh(thread));
  assert.equal(await asleep, true);
  const saveEnd = calls.length;
  assert.ok(!calls.slice(saveStart, saveEnd).includes("machineStart"), `no machine_start during the save: ${calls.slice(saveStart, saveEnd).join(", ")}`);
  await restart;
  assert.equal(fresh(thread).vm!.suspension, undefined, "then resumed");
  fake.suspendMs = 0;
  console.log("ok: a start that comes during a suspend waits for it, then resumes the machine");

  // K-8: no answer in time; the runner says it is suspended.
  await vms.release(fresh(thread), false).catch(() => {});
  registry.applyPhase(thread.id, { type: "releaseBegan" });
  registry.applyPhase(thread.id, { type: "released" });
  const second = registry.createThread("p", "t2", { provider: "faux", id: "faux" }, "hi", "pi", undefined, { runnerId: NODE });
  machines.clear();
  await vms.start(fresh(second));
  registry.applyPhase(second.id, { type: "ready", base: null });
  await delay(IDLE * 2);
  fake.suspendMs = 1000;
  assert.equal(await vms.suspendIfIdle(fresh(second), idle), true, "read back with machine_get");
  assert.equal(fresh(second).vm!.suspension?.state, "suspended");
  fake.suspendMs = 0;
  await vms.guest(fresh(second)).call("hello", {});
  console.log("ok: K-8: a suspend with no answer in time is read back with machine_get");

  // B-207-1: the recovery loop as index.ts runs it (Conversations.recover
  // every tick, without waiting for the last), with an open agent: the
  // machine is suspended once, and the loop does not wake it again. (On
  // d6b10971 each tick's check touched it: no machine_suspend at all.)
  const conversations = new Conversations({ registry, directory: fs.mkdtempSync(path.join(root, "conv-")), models: createModels(), machines: vms });
  (conversations as unknown as { agents: Map<string, Promise<unknown>> }).agents.set(second.id,
    Promise.resolve({ harness: { snapshot: async () => null }, conversation: { id: "c" } }));
  const loopBefore = count("machineSuspend");
  const startsBefore = count("machineStart");
  const ticks = setInterval(() => void conversations.recover(), IDLE / 3);
  await delay(IDLE * 6);
  clearInterval(ticks);
  await conversations.recover();
  assert.ok(count("machineStart") > startsBefore, "the loop did check the machine");
  assert.equal(count("machineSuspend") - loopBefore, 1, "suspended exactly once by the loop");
  assert.equal(fresh(second).vm!.suspension?.state, "suspended", "and the loop leaves it suspended");
  await vms.guest(fresh(second)).call("hello", {});
  console.log("ok: B-207-1: the recovery loop's own ticks (checks and idle rounds together) suspend an idle machine once and leave it so");

  // B-207-2: a cubed that restarted sees the machine running: it may run
  // commands that cubed started; no suspend before the longest command and
  // the grace (32 min). (On d6b10971: suspended after 5 min.)
  let clock = Date.now();
  const restarted = new RunnerMachines({ registry, threads: path.join(root, "threads"), session: () => session, policy, idleMs: IDLE, now: () => clock,
    suspendTimeoutMs: 400, log: quiet });
  await restarted.start(fresh(second));
  clock += IDLE_MS;
  const restartBefore = count("machineSuspend");
  assert.equal(await restarted.suspendIfIdle(fresh(second), idle), false, "after 5 min: not suspended");
  clock += DEFAULT_EXEC_TIMEOUT_MS + EXEC_GRACE_MS - IDLE_MS - 1;
  assert.equal(await restarted.suspendIfIdle(fresh(second), idle), false, "just before 32 min: not suspended");
  assert.equal(count("machineSuspend"), restartBefore);
  clock += 2 + IDLE_MS;
  assert.equal(await restarted.suspendIfIdle(fresh(second), idle), true, "past 32 min and idle: suspended");
  await vms.guest(fresh(second)).call("hello", {});
  console.log("ok: B-207-2: after a cubed restart a running machine is not suspended before the guest's longest command and the grace");

  // B-207-3: one suspend per runner at a time.
  const third = registry.createThread("p", "t3", { provider: "faux", id: "faux" }, "hi", "pi", undefined, { runnerId: NODE });
  await vms.start(fresh(third));
  registry.applyPhase(third.id, { type: "ready", base: null });
  await delay(IDLE * 2);
  fake.suspendMs = 300;
  const firstSave = vms.suspendIfIdle(fresh(second), idle);
  await delay(50);
  const serial = count("machineSuspend");
  assert.equal(await vms.suspendIfIdle(fresh(third), idle), false, "another machine on the runner waits for the next round");
  assert.equal(count("machineSuspend"), serial);
  assert.equal(await firstSave, true);
  fake.suspendMs = 0;
  assert.equal(await vms.suspendIfIdle(fresh(third), idle), true, "then it is suspended");
  console.log("ok: B-207-3: one machine_suspend per runner at a time");

  // N-207-2: a machine being woken holds its slot; one waiting for a slot does not.
  const slots = registry.runnerSlots().free;
  const saved = fresh(third).vm!.suspension!;
  assert.deepEqual(registry.applySleep(third.id, { type: "wakeAsked", waiting: "waiting for a free slot" }), { ...saved, state: "waking" });
  assert.equal(registry.runnerSlots().free, slots - 1, "waking: its QEMU may be starting");
  assert.deepEqual(registry.applySleep(third.id, { type: "slotTaken", waiting: "waiting for a free slot" }), { ...saved, state: "waking", waiting: "waiting for a free slot" });
  assert.equal(registry.runnerSlots().free, slots, "waiting for a slot: none held");
  assert.deepEqual(registry.applySleep(third.id, { type: "wakeDropped" }), saved, "a dropped wake is the same sleep again");
  assert.equal(registry.runnerSlots().free, slots);
  console.log("ok: N-207-2: a machine being woken holds its slot, one waiting for a slot does not");

  // N-207-4, K-6: a runner that says machine.suspend but has no such verb
  // is not asked again, until it runs another version.
  await vms.guest(fresh(second)).call("hello", {});
  await delay(IDLE * 2);
  fake.noVerb = true;
  const noVerb = count("machineSuspend");
  assert.equal(await vms.suspendIfIdle(fresh(second), idle), false);
  await delay(IDLE * 2);
  assert.equal(await vms.suspendIfIdle(fresh(second), idle), false);
  assert.equal(count("machineSuspend"), noVerb + 1, "asked once");
  fake.noVerb = false;
  fake.version = "0.2.0";
  session = sessionNow();
  await session.hello();
  await delay(IDLE * 2);
  assert.equal(await vms.suspendIfIdle(fresh(second), idle), true, "a new runner version is asked again");
  await vms.guest(fresh(second)).call("hello", {});
  console.log("ok: K-6: a runner without the verb is not asked again until it runs another version");

  // K-6: a runner without the verb is not asked again; nor one that does not say machine.suspend.
  fake.capabilities = [];
  session = sessionNow();
  await session.hello();
  assert.deepEqual(session.capabilities, [], "the runner said hello without machine.suspend");
  await delay(IDLE * 2);
  const asked = count("machineSuspend");
  assert.equal(await vms.suspendIfIdle(fresh(second), idle), false);
  assert.equal(count("machineSuspend"), asked, "no machine.suspend: never asked");
  console.log("ok: K-6: a runner that does not say machine.suspend is never asked");
} finally {
  await runnerEndpoint.close();
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(0);
