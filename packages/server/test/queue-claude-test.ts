/** A Claude Code thread's wake on a full runner after a cubed restart,
 * through createCubed with the fake `claude` CLI (fake-claude.ts) over the
 * stand-in `berth vm` (lifecycle-fixture.ts). Offline, disposable state. Not
 * runner acceptance.
 *
 *   C1  the runner restores the snapshot: the message's turn, which waited
 *       for the wake, runs to its end once a slot frees; the next one runs.
 *   C2  the runner boots the machine from its disk instead (review B1′):
 *       every wait for the wake ends (the mod's calls carry no abort signal
 *       of their own), the turn is stopped rather than waited for, the
 *       thread says it restarted from its disk, and the next turns run. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { slotWait } from "../src/machine-sleep.ts";
import { FakeBerth, NODE, Phase, project, RUNNER, until } from "./lifecycle-fixture.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-queue-claude-"));
const quiet = { info() {}, warn() {}, error() {}, debug() {} } as never;
const model = { provider: "claude-code", id: "sonnet" };
const BOUND_MS = 30_000;
const bounded = <T>(what: string, work: Promise<T>) => Promise.race([work,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what} did not finish in ${BOUND_MS / 1000} s`)), BOUND_MS).unref())]);

async function scenario(name: string, drop: boolean): Promise<void> {
  const state = path.join(root, name, "state");
  const berth = new FakeBerth(path.join(root, name, "runner"), 1);
  const clock = { now: Date.now() };
  const open = () => createCubed({ state, models: createModels(), claude: [process.execPath, path.resolve(import.meta.dirname, "fake-claude.ts")],
    claudeOptions: { stopGraceMs: 2000 }, gateway: null, skillSource: null, now: () => clock.now,
    patience: { retryMs: 50, wakeMs: 20_000, restartMs: 0 },
    runner: { session: () => berth.session(), log: quiet, templates: { enabled: false, ttlMs: 0 }, idleMs: 60_000 } });
  let app = await open();
  try {
    app.registry.saveProject(project);
    app.registry.enrollRunner({ nodeId: NODE, threadId: RUNNER, environmentId: 1, configPath: path.join(root, name, "runner.json"), configHash: RUNNER, maxActiveVms: 1,
      protocol: 4, kind: "vm" });
    let requests = 0;
    const thread = (text: string) => app.registry.createThread(project.id, `create-${++requests}`, model, text, "claude-code");
    const fresh = (id: string) => app.registry.getThread(id)!;
    const vmOf = (id: string) => fresh(id).vm!.vmId;
    const status = async (id: string) => (await app.conversations.storedHistory(id, { limit: 1 }))?.status.state;
    const settled = (id: string) => until(`${id.slice(0, 8)} settles`, async () => { const s = await status(id); return !!s && s !== "working" && s !== "idle"; }, BOUND_MS);

    const a = thread("say hello");
    await app.conversations.activate(a.id);
    await settled(a.id);
    clock.now += 61_000;
    await app.conversations.suspendIdle();
    assert.equal(berth.phases.get(vmOf(a.id)), Phase.SUSPENDED, `${name}: a sleeps`);
    const holder = thread("say holding");
    await app.conversations.activate(holder.id);
    await settled(holder.id);
    berth.busy.add(vmOf(holder.id));

    await app.close();
    app = await open();
    await app.conversations.boot();
    const first = app.conversations.submit(a.id, "run sleep 1\nsay ran", `${name}-1`);
    await until("a's turn waits for its wake", () => !!slotWait(fresh(a.id).vm?.suspension) && app.conversations.owns(fresh(a.id)), BOUND_MS);
    if (drop) berth.dropSnapshots.add(vmOf(a.id));
    berth.busy.delete(vmOf(holder.id));
    await bounded("the holder's archive", app.conversations.archive(holder.id));
    await bounded("the first message", first.catch((error: Error) => error.message));
    await settled(a.id);
    const after = await status(a.id);
    if (drop) {
      assert.equal(after, "failed", `${name}: the turn that waited for a machine that booted from its disk ended, cut off, instead of being waited for`);
      assert.match(fresh(a.id).vm?.notice?.text ?? "", /^restarted from its disk/);
    } else {
      assert.equal(after, "completed", `${name}: the turn ran on the resumed machine`);
      assert.equal(fresh(a.id).vm?.notice, undefined);
    }
    await until("no start or wake is left", () => !app.conversations.owns(fresh(a.id)), BOUND_MS);
    for (const n of [2, 3]) {
      await bounded(`message ${n}`, app.conversations.submit(a.id, `say turn ${n}`, `${name}-${n}`));
      await settled(a.id);
      assert.equal(await status(a.id), "completed", `${name}: turn ${n} runs`);
    }
    assert.deepEqual([berth.creates(vmOf(a.id)), berth.resumes(vmOf(a.id)), berth.violations], [1, 1, []], `${name}: the same machine, started once from its sleep`);
    console.log(drop
      ? "ok: C2 a Claude Code turn waiting for a machine that boots from its disk after a restart is stopped, not waited for; the next turns run"
      : "ok: C1 a Claude Code turn waiting for its wake after a restart runs once the snapshot is restored; the next turns run");
  } finally {
    await app.close().catch(() => {});
    berth.stopAll();
  }
}

try {
  await scenario("restored", false);
  await scenario("dropped", true);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(0);
