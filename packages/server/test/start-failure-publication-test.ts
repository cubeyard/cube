/** When Conversations tell a thread's start failure (I-5a,
 * `onStartFailure`), offline over the runtime cubed builds
 * (lifecycle-fixture.ts):
 *
 *   P1  an archive tells the end of a thread's start failure as it begins,
 *       not once its release check and release are done: a slow archive is
 *       never reported as a start that failed;
 *   P2  a listener that subscribes later in the same process is told a
 *       failure that came back, even if an earlier listener was told the
 *       same failure before it went away;
 *   P3  while a wake waits for a slot (after a restart, its agent closed, a
 *       failed wake on its row), what a listener was told, from its
 *       subscription on, is the thread's start failure now between the
 *       wake's rounds, and at its end. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunnerSession } from "../src/runner-session.ts";
import type { StartFailure } from "../src/thread-condition.ts";
import { allocationFailed } from "../src/thread-failure.ts";
import { lifecycle, until } from "./lifecycle-fixture.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-start-failure-publication-"));
const life = lifecycle(root, { slots: 2 });
const { registry, berth, fresh, vmOf } = life;
// A release that waits until the test lets it go.
let letGo: () => void = () => {};
let held = false;
const session = berth.session.bind(berth);
berth.session = () => {
  const inner = session();
  return { ...inner, machine: async (request: Parameters<RunnerSession["machine"]>[0]) => {
    if (held && request.case === "machineDelete") await new Promise<void>(resolve => { letGo = resolve; });
    return inner.machine(request);
  } } as RunnerSession;
};
let cubed = life.start();
let { conversations } = cubed;
try {
  // ---------------------------------------------------------------- P1
  {
    const told: Array<StartFailure | null> = [];
    const thread = life.thread();
    const unsubscribe = conversations.onStartFailure((id, failure) => { if (id === thread.id) told.push(failure); });
    berth.failCreates.set(vmOf(thread.id), "the runner cannot make its disk");
    await conversations.activate(thread.id);
    assert.equal(told.at(-1)?.failure, "workspace allocation failed: INTERNAL: the runner cannot make its disk", "the failed start is told");
    held = true;
    const archiving = conversations.archive(thread.id);
    await until("the archive's release waits", () => fresh(thread.id).workspaceState === "releasing");
    assert.equal(told.at(-1), null, "the start failure's end is told while the archive still runs");
    assert.equal(fresh(thread.id).archived, false, "the archive has not finished");
    held = false;
    letGo();
    await archiving;
    assert.deepEqual([fresh(thread.id).archived, told.at(-1)], [true, null]);
    unsubscribe();
    console.log("ok: P1 an archive tells a failing thread's start failure ended as it begins, before its release finishes");
  }

  // ---------------------------------------------------------------- P2
  const p2 = life.thread();
  {
    const thread = p2;
    registry.applyPhase(thread.id, { type: "failed", failure: allocationFailed("the guest is unreachable") });
    const failure = { failure: "workspace allocation failed: the guest is unreachable", episode: null, retrying: true, waking: false };
    // An idle round tells every thread's start failure that changed.
    const first: Array<StartFailure | null> = [];
    const unsubscribe = conversations.onStartFailure((id, told) => { if (id === thread.id) first.push(told); });
    await conversations.suspendIdle();
    assert.deepEqual(first, [failure], "the first listener is told the failure");
    unsubscribe();
    // With no listener the failure ends, unseen.
    registry.applyPhase(thread.id, { type: "ready", base: null });
    await conversations.suspendIdle();
    // A second listener subscribes and reads what it missed: no failure now.
    const second: Array<StartFailure | null> = [];
    conversations.onStartFailure((id, told) => { if (id === thread.id) second.push(told); });
    assert.equal(conversations.startFailure(thread.id), null, "reconciled: no failure now");
    // The same failure comes back: the second listener is told it.
    registry.applyPhase(thread.id, { type: "failed", failure: allocationFailed("the guest is unreachable") });
    await conversations.suspendIdle();
    assert.deepEqual(second.at(-1), failure, "a failure that came back is told to a listener that subscribed since");
    console.log("ok: P2 a listener that subscribed later in the same process is told a failure that came back, though an earlier one was told it");
  }

  // ---------------------------------------------------------------- P3
  {
    const c = life.thread();
    await conversations.activate(c.id);
    await until("c settles", async () => {
      const status = (await conversations.storedHistory(c.id, { limit: 1 }))?.status;
      return !!status && status.state !== "working" && status.state !== "idle";
    });
    life.clock.now += 40 * 60_000;
    for (let round = 0; round < 3; round++) await conversations.suspendIdle();
    assert.equal(fresh(c.id).vm?.suspension?.state, "suspended", "c sleeps");
    berth.failResumes.set(vmOf(c.id), "the snapshot could not be restored");
    await conversations.submit(c.id, "more", "tell-c").catch(() => {});
    assert.equal(fresh(c.id).retry?.failures, 1, "one failed wake on c's row");
    berth.failResumes.delete(vmOf(c.id));
    await cubed.close();
    cubed = life.start();
    ({ conversations } = cubed);
    // The wake the restart cut short is read back, as the recovery loop does.
    await cubed.machines.settleWake(fresh(c.id));
    assert.equal(fresh(c.id).vm?.suspension?.state, "suspended");
    // The runner is full: two new threads hold its two slots.
    await conversations.archive(p2.id);
    await conversations.activate(life.thread().id);
    await conversations.activate(life.thread().id);
    let told: string | undefined;
    conversations.onStartFailure((id, failure) => { if (id === c.id) told = JSON.stringify(failure); });
    told = JSON.stringify(conversations.startFailure(c.id));
    assert.match(told, /the snapshot could not be restored/, "after the restart c's row says its wake failed");
    const waking = conversations.wake(c.id).then(() => "resumed", (error: Error) => error.message);
    let compared = 0;
    for (const deadline = Date.now() + 300; Date.now() < deadline;) {
      await new Promise(resolve => setTimeout(resolve, 15));
      if (conversations.starting(c.id)) continue;
      assert.equal(told, JSON.stringify(conversations.startFailure(c.id)), "between the wake's rounds the told start failure is the one now");
      compared++;
    }
    assert.ok(compared >= 5, `compared between rounds: ${compared}`);
    assert.ok(conversations.owns(fresh(c.id)) && fresh(c.id).vm?.suspension, "the wake still waits for a slot");
    // Its patience ends (600 ms here): the wake gives up, the machine asleep.
    assert.match(await waking, /^the thread's machine is suspended and could not be resumed: waiting for a free slot/);
    assert.equal(told, JSON.stringify(conversations.startFailure(c.id)), "at the wake's end too");
    console.log(`ok: P3 a wake that waits for a slot keeps what a listener was told the thread's start failure now (${compared} reads between rounds) and at its end`);
  }
} finally {
  letGo();
  await cubed.close().catch(() => {});
  berth.stopAll();
  fs.rmSync(root, { recursive: true, force: true });
}
