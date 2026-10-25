/** A sleeping machine's wake (Conversations.wake) beside the rest of
 * cubed, offline over the runtime cubed builds (lifecycle-fixture.ts):
 *
 *   W1  an idle round while a wake's start is under way (the machine
 *       resumed, its start still waiting for the guest) suspends nothing:
 *       the start guards it, not a separate wake check;
 *   W2  a guest call to a sleeping machine answers within a bound: the
 *       wake's own activation makes guest calls once it resumed the
 *       machine, and they do not wait for the wake (no re-entrancy hang).
 * Both after a restart: with no agent open a wake is a whole activation,
 * not a check (which an idle round waits for and which calls no guest). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunnerSession } from "../src/runner-session.ts";
import { lifecycle, until } from "./lifecycle-fixture.ts";

const BOUND_MS = 10_000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-wake-guards-"));
const life = lifecycle(root, { slots: 2 });
const { berth, clock, fresh, vmOf } = life;
// A start that, once the runner resumed the machine, waits for the test
// before its guest says ready.
let holdReady: string | null = null;
let letGo: () => void = () => {};
const session = berth.session.bind(berth);
berth.session = () => {
  const inner = session();
  return { ...inner, until: async (...args: Parameters<RunnerSession["until"]>) => {
    if (holdReady && args[0].id === holdReady) await new Promise<void>(resolve => { letGo = resolve; });
    return inner.until(...args);
  } } as RunnerSession;
};
let cubed = life.start();
let { conversations } = cubed;
const settled = (id: string) => until(`${id.slice(0, 8)} settles`, async () => {
  const status = (await conversations.storedHistory(id, { limit: 1 }))?.status;
  return !!status && status.state !== "working" && status.state !== "idle";
});
const sleep = async () => { clock.now += 40 * 60_000; for (let round = 0; round < 3; round++) await conversations.suspendIdle(); };
/** A cubed restarted: no agent open, so a wake is a whole activation (not a check). */
const restart = async () => { await cubed.close(); cubed = life.start(); ({ conversations } = cubed); };
/** A guest call of the thread, or "unanswered" past the bound. */
const call = async (id: string) => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      conversations.guest(fresh(id)).call("stat", { path: "/workspace" }).then(() => "answered", (error: Error) => `failed: ${error.message}`),
      new Promise<string>(resolve => { timer = setTimeout(() => resolve("unanswered"), BOUND_MS); }),
    ]);
  } finally { clearTimeout(timer); }
};
try {
  const a = life.thread();
  await conversations.activate(a.id);
  await settled(a.id);

  // ---------------------------------------------------------------- W1
  await sleep();
  assert.equal(fresh(a.id).vm?.suspension?.state, "suspended", "a sleeps");
  await restart();
  assert.equal(conversations.agentOpen(a.id), false, "no agent open after the restart");
  holdReady = vmOf(a.id);
  const woken = call(a.id);
  await until("the runner resumed it, its start waits for the guest", () => !fresh(a.id).vm?.suspension && conversations.owns(fresh(a.id)));
  const suspends = berth.asked("machineSuspend", vmOf(a.id));
  clock.now += 40 * 60_000;
  await conversations.suspendIdle();
  assert.equal(berth.asked("machineSuspend", vmOf(a.id)), suspends, "the idle round asked no suspend while the wake's start was under way");
  holdReady = null;
  letGo();
  assert.equal(await woken, "answered", "the call answers once the start goes on");
  assert.equal(fresh(a.id).vm?.suspension, undefined, "and the machine runs");
  console.log("ok: W1 an idle round while a wake's start is under way suspends nothing");

  // ---------------------------------------------------------------- W2
  await settled(a.id);
  await sleep();
  assert.equal(fresh(a.id).vm?.suspension?.state, "suspended", "a sleeps again");
  await restart();
  const starts = berth.asked("machineStart", vmOf(a.id));
  assert.equal(await call(a.id), "answered", `a call to a sleeping machine answers within ${BOUND_MS} ms`);
  assert.equal(fresh(a.id).vm?.suspension, undefined, "the wake resumed it");
  assert.ok(berth.asked("machineStart", vmOf(a.id)) > starts, "by a start");
  assert.equal(conversations.agentOpen(a.id), true, "the wake's activation opened the agent (its guest calls ran inside the wake)");
  console.log("ok: W2 a call to a sleeping machine answers within the bound: the wake's own activation's guest calls do not wait for the wake");
} finally {
  letGo();
  await cubed.close().catch(() => {});
  berth.stopAll();
  fs.rmSync(root, { recursive: true, force: true });
}
