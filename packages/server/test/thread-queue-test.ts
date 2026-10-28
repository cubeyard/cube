/** A full runner's queue (machine-sleep.ts `queued`, Registry.slotQueue,
 * Conversations' idle round), offline over the stand-in `berth vm`
 * (lifecycle-fixture.ts: the real Registry, RunnerMachines and
 * Conversations, Pi on a faux model, the real guest helper). Counts what
 * reached the runner. Not runner acceptance: no real berth suspends here.
 *
 *   Q1  with no thread waiting, machines idle less than idleMs keep running;
 *       a new thread on the full runner is queued, not refused, and the
 *       idlest machine is suspended at once (not after idleMs) so it starts;
 *       the other machines keep running.
 *   Q2  under that pressure nothing busy is suspended: an agent at work, a
 *       command not seen to end, an open portal connection, a registered
 *       service; the one idle machine is, in the same round.
 *   Q3  one slot: a wake waiting since before a new thread gets the freed
 *       slot first; the new thread is not starved: it starts next.
 *   Q4  queued threads: a message or a steer is refused with the wait's
 *       words (no failure, no runner asked, the place kept); a restart keeps
 *       the order; archiving a queued thread asks the runner nothing; a freed
 *       slot goes to the oldest, then the next.
 *   Q5  after a cubed restart, a message to a suspended thread on a full
 *       runner: its run waits for the wake; once a slot frees the runner
 *       resumes the snapshot (the same boot), the run goes on without its
 *       agent being closed, and a later message runs too (review B1: the
 *       resume was taken for a new boot, whose closing of the agent waited
 *       for the run that waited for the wake).
 *   Q6  the same wait where the runner cannot use the snapshot and boots the
 *       machine from its disk (a real new boot): the waiting run is stopped
 *       rather than waited for, the thread says it restarted from its disk,
 *       and the next message runs.
 *   Q7  a wake on a full runner just after cubed started (when no machine
 *       running from before may be suspended yet) does not give up before
 *       that protection ends: its patience counts from then; later it
 *       gives up after its patience, as before (review S2). */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fauxAssistantMessage, fauxToolCall, type Context, type Message } from "@earendil-works/pi-ai";
import { slotWait } from "../src/machine-sleep.ts";
import type { RunnerMachines } from "../src/runner-machines.ts";
import { lifecycle, Phase, RUNNER, until, type Cubed } from "./lifecycle-fixture.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-thread-queue-"));
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
/** "work slowly" runs `sleep 4` in the machine; anything else is answered at once. */
const responses = Array.from({ length: 400 }, () => (request: Context) => {
  const last = request.messages.findLast(message => message.role !== "system")!;
  return last.role === "user" && textOf(last).includes("work slowly")
    ? fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 4" })], { stopReason: "toolUse" })
    : fauxAssistantMessage("done");
});

function world(name: string, slots: number, wakeWaitMs = 600, restartMs = 0) {
  const life = lifecycle(path.join(root, name), { slots, wakeWaitMs, restartMs, responses });
  const { berth, fresh, vmOf } = life;
  let cubed: Cubed = life.start();
  const phase = (id: string) => berth.phases.get(vmOf(id));
  const settled = (id: string) => until(`${id.slice(0, 8)} settles`, async () => {
    const status = (await cubed.conversations.storedHistory(id, { limit: 1 }))?.status;
    return !!status && status.state !== "working" && status.state !== "idle";
  });
  /** A new thread, started, its first turn done. */
  const running = async () => {
    const thread = life.thread();
    await cubed.conversations.activate(thread.id);
    await settled(thread.id);
    assert.equal(phase(thread.id), Phase.RUNNING);
    return thread;
  };
  const ready = (id: string) => until(`${id.slice(0, 8)} is ready`, () => fresh(id).workspaceState === "available" && phase(id) === Phase.RUNNING);
  const queue = () => life.registry.slotQueue().get(RUNNER)?.waiting ?? [];
  const sound = (what: string) => {
    assert.deepEqual(berth.violations, [], `${what}: no guest call reached a machine that does not run`);
    assert.ok(berth.holding() <= berth.slots, `${what}: the runner holds ${berth.holding()} of ${berth.slots}`);
  };
  return { ...life, get cubed() { return cubed; }, restart: async () => { await cubed.close(); cubed = life.start(); return cubed; },
    phase, settled, running, ready, queue, sound };
}

const worlds: Array<ReturnType<typeof world>> = [];
try {
  // ---------------------------------------------------------------- Q1
  {
    const w = world("q1", 3);
    worlds.push(w);
    const a = await w.running();
    w.clock.now += 10_000;
    const b = await w.running();
    w.clock.now += 10_000;
    const c = await w.running();
    w.clock.now += 10_000;
    await w.cubed.conversations.suspendIdle();
    assert.deepEqual([a, b, c].map(t => w.phase(t.id)), [Phase.RUNNING, Phase.RUNNING, Phase.RUNNING], "no thread waits: 30 s idle is not 60 s (idleMs)");
    const d = w.thread();
    assert.equal(w.fresh(d.id).vm?.suspension?.state, "queued", "the runner is full: d is queued, not refused");
    assert.match(slotWait(w.fresh(d.id).vm?.suspension) ?? "", /^waiting for a free slot on runner node-life: /);
    assert.equal(w.berth.creates(w.vmOf(d.id)), 0, "and its machine is not asked for");
    await w.cubed.conversations.activate(d.id);
    await w.ready(d.id);
    assert.deepEqual([a, b, c].map(t => w.phase(t.id)), [Phase.SUSPENDED, Phase.RUNNING, Phase.RUNNING], "the idlest (a) was suspended for d, the others run");
    assert.equal(w.fresh(d.id).vm?.suspension, undefined);
    w.sound("Q1");
    console.log("ok: Q1 no queue: idle machines keep running until idleMs; a full runner queues a new thread and suspends its idlest machine at once for it");
  }

  // ---------------------------------------------------------------- Q2
  {
    const w = world("q2", 5);
    worlds.push(w);
    const machines = w.cubed.machines as RunnerMachines;
    const [agent, command, portal, service] = [await w.running(), await w.running(), await w.running(), await w.running()];
    w.clock.now += 10_000;
    const idle = await w.running();
    // The idlest four are busy, each its own way; the newest is idle.
    await w.cubed.conversations.submit(agent.id, "work slowly", "slow-1");
    await until("the agent works", async () => (await w.cubed.conversations.storedHistory(agent.id, { limit: 1 }))?.status.state === "working");
    // A command the guest said runs (MachineActivity's own count; the
    // answer is the stand-in's, as a long `exec` would get).
    await machines.activity.guest(command.id, { call: async () => ({ header: { state: "Running" }, body: Buffer.alloc(0) }), close: async () => {} })
      .call("exec", { id: "long", timeoutMs: 600_000 });
    // A portal connection, counted as RunnerMachines' `dial` counts one.
    const socket = machines.activity.dial(portal.id, new PassThrough());
    // A registered `cube service`, by the guest's own command.
    const port = await new Promise<number>(resolve => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
    const guest = w.berth.guestOf(w.vmOf(service.id));
    const started = spawnSync("python3", [path.join(import.meta.dirname, "local-guest.py"), guest.root, "cli", "service", "start", "app", "--port", String(port), "--",
      "python3", "-m", "http.server", String(port), "--bind", "127.0.0.1"], { cwd: guest.workspace, encoding: "utf8" });
    assert.equal(started.status, 0, started.stdout + started.stderr);
    const queued = w.thread();
    await w.cubed.conversations.activate(queued.id);
    await w.ready(queued.id);
    assert.deepEqual([agent, command, portal, service, idle].map(t => w.phase(t.id)), [Phase.RUNNING, Phase.RUNNING, Phase.RUNNING, Phase.RUNNING, Phase.SUSPENDED],
      "the agent at work, the command, the portal and the service keep their machines; the idle one was suspended");
    for (const t of [agent, command, portal, service]) assert.equal(w.berth.asked("machineSuspend", w.vmOf(t.id)), 0, `${t.id.slice(0, 8)}: no suspend was asked`);
    socket.destroy();
    await w.settled(agent.id);
    w.sound("Q2");
    console.log("ok: Q2 under a queue's pressure an agent at work, a running command, a portal connection and a registered service keep their machines; the idle one is suspended");
  }

  // ---------------------------------------------------------------- Q3
  {
    const w = world("q3", 1, 20_000);
    worlds.push(w);
    const a = await w.running();
    w.clock.now += 61_000;
    await w.cubed.conversations.suspendIdle();
    assert.equal(w.phase(a.id), Phase.SUSPENDED, "idle past idleMs, with no queue: suspended as always");
    const holder = await w.running();
    w.berth.busy.add(w.vmOf(holder.id));
    const call = w.cubed.conversations.guest(w.fresh(a.id)).call("stat", { path: "/workspace" }).then(() => "answered", (error: Error) => error.message);
    await until("a's wake waits for the slot", () => !!slotWait(w.fresh(a.id).vm?.suspension));
    const c = w.thread();
    await w.cubed.conversations.activate(c.id);
    assert.deepEqual(w.queue(), [a.id, c.id], "a waits since before c");
    w.berth.busy.delete(w.vmOf(holder.id));
    await w.cubed.conversations.suspendIdle();
    assert.equal(w.phase(holder.id), Phase.SUSPENDED, "the holder, idle, is suspended for the queue");
    assert.equal(await call, "answered", "a's wake got the slot");
    assert.deepEqual([w.phase(a.id), w.berth.creates(w.vmOf(c.id)), w.queue()], [Phase.RUNNING, 0, [c.id]], "a resumed; c, behind it, still waits");
    await w.cubed.conversations.recover();
    await w.ready(c.id);
    assert.equal(w.phase(a.id), Phase.SUSPENDED, "then a, idle, made room for c: c is not starved");
    w.sound("Q3");
    console.log("ok: Q3 a wake waiting since before a new thread gets the freed slot first; the new thread starts next");
  }

  // ---------------------------------------------------------------- Q4
  {
    const w = world("q4", 1);
    worlds.push(w);
    const holder = await w.running();
    w.berth.busy.add(w.vmOf(holder.id));
    const [q1, q2, q3] = [w.thread(), w.thread(), w.thread()];
    for (const q of [q1, q2, q3]) await w.cubed.conversations.activate(q.id);
    assert.deepEqual(w.queue(), [q1.id, q2.id, q3.id]);
    const since = JSON.stringify(w.fresh(q2.id).vm?.suspension);
    for (const steer of [false, true]) {
      const refused = await w.cubed.conversations.submit(q2.id, "are you there", `while-queued-${steer}`, { steer }).then(() => "accepted", (error: Error) => error.message);
      assert.match(refused, /^waiting for a free slot on runner node-life: /, `a ${steer ? "steer" : "message"} to a queued thread says why it waits`);
    }
    assert.deepEqual([w.cubed.conversations.error(q2.id), JSON.stringify(w.fresh(q2.id).vm?.suspension), w.queue()], [null, since, [q1.id, q2.id, q3.id]],
      "no failure, and q2 keeps its place");
    await w.restart();
    await w.cubed.conversations.boot();
    assert.deepEqual(w.queue(), [q1.id, q2.id, q3.id], "a restart keeps the order");
    const archived = await w.cubed.conversations.archive(q2.id);
    assert.deepEqual([archived.retained, w.fresh(q2.id).archived], [false, true]);
    for (const q of [q1, q2, q3]) assert.deepEqual(w.berth.touched(w.vmOf(q.id)), [], `${q.id.slice(0, 8)}: its runner was never asked, archive included`);
    assert.deepEqual(w.queue(), [q1.id, q3.id]);
    w.berth.busy.delete(w.vmOf(holder.id));
    await w.cubed.conversations.archive(holder.id);
    await w.ready(q1.id);
    assert.deepEqual([w.berth.creates(w.vmOf(q3.id)), w.queue()], [0, [q3.id]], "the freed slot went to the oldest");
    await w.settled(q1.id);
    await w.cubed.conversations.recover();
    await w.ready(q3.id);
    assert.equal(w.phase(q1.id), Phase.SUSPENDED, "then q1, idle, made room for q3");
    w.sound("Q4");
    console.log("ok: Q4 a queued thread refuses a message or a steer with its wait, keeps its place across a restart, is archived without its runner; the oldest gets the freed slot, then the next");
  }
  // ---------------------------------------------------------------- Q5
  {
    const w = world("q5", 1, 20_000);
    worlds.push(w);
    const a = await w.running();
    w.clock.now += 61_000;
    await w.cubed.conversations.suspendIdle();
    assert.equal(w.phase(a.id), Phase.SUSPENDED);
    const holder = await w.running();
    w.berth.busy.add(w.vmOf(holder.id));
    await w.restart();
    await w.cubed.conversations.boot();
    const bounded = <T>(what: string, work: Promise<T>) => Promise.race([work,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish in 20 s`)), 20_000).unref())]);
    const status = async () => (await w.cubed.conversations.storedHistory(a.id, { limit: 1 }))?.status.state;
    const first = w.cubed.conversations.submit(a.id, "work slowly", "after-restart-1");
    await until("a's run waits for its wake", () => !!slotWait(w.fresh(a.id).vm?.suspension) && w.cubed.conversations.owns(w.fresh(a.id)));
    w.berth.busy.delete(w.vmOf(holder.id));
    assert.deepEqual((await bounded("the holder's archive", w.cubed.conversations.archive(holder.id))).retained, false);
    await bounded("the first message", first);
    await w.settled(a.id);
    assert.equal(await status(), "completed", "the message's run finished on the resumed machine");
    assert.equal(w.berth.resumes(w.vmOf(a.id)), 1, "resumed once, from its snapshot");
    assert.equal(w.cubed.conversations.owns(w.fresh(a.id)), false, "no activation or wake is left");
    await bounded("the second message", w.cubed.conversations.submit(a.id, "again", "after-restart-2"));
    await w.settled(a.id);
    assert.equal(await status(), "completed", "a later message runs too");
    w.sound("Q5");
    console.log("ok: Q5 after a restart, a message to a suspended thread on a full runner waits for its wake, then runs once a slot frees; the next message runs too");
  }
  // ---------------------------------------------------------------- Q6
  {
    const w = world("q6", 1, 20_000);
    worlds.push(w);
    const a = await w.running();
    w.clock.now += 61_000;
    await w.cubed.conversations.suspendIdle();
    const holder = await w.running();
    w.berth.busy.add(w.vmOf(holder.id));
    const status = async () => (await w.cubed.conversations.storedHistory(a.id, { limit: 1 }))?.status.state;
    const first = w.cubed.conversations.submit(a.id, "work slowly", "dropped-1");
    await until("a's run waits for its wake", () => !!slotWait(w.fresh(a.id).vm?.suspension) && w.cubed.conversations.owns(w.fresh(a.id)));
    w.berth.dropSnapshots.add(w.vmOf(a.id));
    w.berth.busy.delete(w.vmOf(holder.id));
    await w.cubed.conversations.archive(holder.id);
    await first;
    await w.settled(a.id);
    assert.equal(await status(), "stopped", "the run that waited for a machine that booted again was stopped, not waited for");
    assert.match(w.fresh(a.id).vm?.notice?.text ?? "", /^restarted from its disk/);
    await until("the agent reopened", () => !w.cubed.conversations.owns(w.fresh(a.id)));
    await w.cubed.conversations.submit(a.id, "again", "dropped-2");
    await w.settled(a.id);
    assert.equal(await status(), "completed", "the next message runs");
    w.sound("Q6");
    console.log("ok: Q6 a machine that boots from its disk under a run waiting for its wake stops that run instead of waiting for it; the next message runs");
  }
  // ---------------------------------------------------------------- Q7
  {
    const WAKE = 600, RESTART = 2_500;
    const w = world("q7", 1, WAKE, RESTART);
    worlds.push(w);
    const a = await w.running();
    w.clock.now += 61_000;
    await w.cubed.conversations.suspendIdle();
    const holder = await w.running();
    w.berth.busy.add(w.vmOf(holder.id));
    await w.restart();
    const call = async () => {
      const began = Date.now();
      const result = await w.cubed.conversations.guest(w.fresh(a.id)).call("stat", { path: "/workspace" }).then(() => "answered", (error: Error) => error.message);
      return { result, ms: Date.now() - began };
    };
    const early = call();
    await new Promise(resolve => setTimeout(resolve, WAKE * 2));
    assert.ok(slotWait(w.fresh(a.id).vm?.suspension) && w.cubed.conversations.owns(w.fresh(a.id)), "past its own patience, within the restart protection, the wake still waits in the queue");
    w.berth.busy.delete(w.vmOf(holder.id));
    await w.cubed.conversations.archive(holder.id);
    const { result, ms } = await early;
    assert.equal(result, "answered", "and gets the freed slot");
    assert.ok(ms > WAKE, `it waited past ${WAKE} ms: ${ms} ms`);
    await w.settled(a.id);
    // Past the protection a wake is bounded by its patience alone.
    await new Promise(resolve => setTimeout(resolve, RESTART));
    w.clock.now += 61_000;
    await w.cubed.conversations.suspendIdle();
    assert.equal(w.phase(a.id), Phase.SUSPENDED);
    const other = await w.running();
    w.berth.busy.add(w.vmOf(other.id));
    const late = await call();
    assert.match(late.result, /^the thread's machine is suspended and could not be resumed: waiting for a free slot/);
    assert.ok(late.ms >= WAKE && late.ms < WAKE + 2_000, `it gave up after its patience: ${late.ms} ms`);
    w.sound("Q7");
    console.log("ok: Q7 a wake just after a cubed restart keeps its place until the restart protection ends, then is bounded by its patience as before");
  }
} finally {
  for (const w of worlds) { await w.cubed.close().catch(() => {}); w.berth.stopAll(); }
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(0);
