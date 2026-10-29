/** A new machine berth refuses for want of disk (`RESOURCE_EXHAUSTED
 * disk_space`, disk.rs), offline over the stand-in `berth vm`
 * (lifecycle-fixture.ts): the thread waits saying so, counts no failed
 * start, keeps its slot and its place before a thread that came later,
 * and starts in a recovery round once there is room. Not runner
 * acceptance: berth's own check is tested in berth (vm/template_tests.rs). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { slotWait } from "../src/machine-sleep.ts";
import { lifecycle, Phase, RUNNER, until } from "./lifecycle-fixture.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-disk-wait-"));
const SHORT = "a new machine needs 0.0 GiB and a reserve of 2.0 GiB free in /runner; it has 1.5 GiB free, 0.0 GiB of it committed to template builds (an estimate), and 900000 free inodes (at least 10000)";
const life = lifecycle(root, { slots: 1 });
const { berth, fresh, vmOf, registry } = life;
const cubed = life.start();
try {
  berth.diskShort = SHORT;
  const a = life.thread();
  await cubed.conversations.activate(a.id);
  assert.equal(cubed.conversations.waiting(a.id), `waiting for disk space on runner node-life: ${SHORT}; this thread stays on it and starts once there is room`);
  assert.equal(fresh(a.id).retry, undefined, "a disk wait is no failed start");
  const asked = () => berth.events.filter(event => event.op === "machineCreate" && event.vm === vmOf(a.id)).length;
  assert.equal(asked(), 1, "the runner was asked once");
  assert.equal(berth.phases.get(vmOf(a.id)), undefined, "nothing of the machine was made");
  // Recovery rounds while there is no room: still waiting, still no failure.
  await cubed.conversations.recover();
  await cubed.conversations.recover();
  assert.equal(fresh(a.id).retry, undefined, "rounds of the same wait count nothing");
  assert.equal(asked(), 3, "each round asks the runner again");
  assert.match(cubed.conversations.waiting(a.id) ?? "", /^waiting for disk space on runner node-life: /);
  // a keeps its slot: b, which came later, is queued behind it.
  const b = life.thread();
  assert.equal(fresh(b.id).vm?.suspension?.state, "queued");
  assert.match(slotWait(fresh(b.id).vm?.suspension) ?? "", /^waiting for a free slot on runner node-life: /);
  assert.deepEqual(registry.slotQueue().get(RUNNER)?.waiting, [b.id]);
  // Room again: the next round starts a, and only a.
  berth.diskShort = null;
  await cubed.conversations.recover();
  await until("a starts once there is room", () => fresh(a.id).workspaceState === "available" && berth.phases.get(vmOf(a.id)) === Phase.RUNNING);
  assert.equal(cubed.conversations.waiting(a.id), null);
  assert.equal(fresh(a.id).retry, undefined);
  assert.equal(fresh(b.id).vm?.suspension?.state, "queued", "b still waits for a slot");
  assert.equal(berth.creates(vmOf(b.id)), 0);
  assert.deepEqual(berth.violations, []);
  console.log("ok: a disk refusal waits saying what berth measured, counts no failure, keeps the slot and the queue's order, and starts once there is room");
} finally {
  await cubed.close();
  registry.close();
  fs.rmSync(root, { recursive: true, force: true });
}
