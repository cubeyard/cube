/** A thread whose commits cannot be fetched gives up its runner slot, so the
 * threads queued behind it start: through createCubed on a two-slot runner
 * over local guests, with real git. The failed threads hold no slot while
 * their retries go on, nor once they stop; a retry takes a slot only behind
 * the threads waiting for one, then starts; a reopened registry counts the
 * same. Disposable state. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { Registry } from "../src/registry.ts";
import { retriesExhausted } from "../src/thread-recovery.ts";
import { LocalMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-commits-capacity-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", cwd, ...args], { encoding: "utf8" }).trim();
const repository = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "--initial-branch=main");
  git(dir, "commit", "-q", "--allow-empty", "-m", "one");
  return git(dir, "rev-parse", "HEAD");
};
const good = path.join(root, "good");
repository(good);
const gone = path.join(root, "gone");

const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 40 }, () => fauxAssistantMessage("done")));
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, id: faux.getModel().id };
const state = path.join(root, "state");
const app = await createCubed({ state, models, machines: new LocalMachines(path.join(root, "machines")), claude: null, gateway: null });
app.registry.enrollRunner({ nodeId: "node-two", threadId: "two", environmentId: 1, configPath: "/private/two.json", configHash: "two", maxActiveVms: 2, protocol: 4, kind: "vm" });
const project = (id: string, url: string) => app.registry.saveProject({ id, name: id, status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [
  { id: `${id}-r`, projectId: id, position: 0, url, base: null, checkoutName: id, status: "ready", error: null, resolvedBase: "main", baseOid: "0".repeat(40), checkedAt: 1 }] });
project("ok", good);
project("gone", gone);

const accept = (projectId: string, requestId: string) => {
  const thread = app.registry.createThread(projectId, requestId, model, "hello", "pi", { latest: true });
  void app.conversations.activate(thread.id);
  return thread.id;
};
const thread = (id: string) => app.registry.getThread(id)!;
const queued = (id: string) => thread(id).vm?.suspension?.state === "queued";
const commitSteps = (id: string) => (thread(id).vm?.steps ?? []).filter(step => step.name === "commits").map(step => step.state);
const held = () => { const slots = app.registry.runnerSlots(); return slots.total - slots.free; };
async function until(what: string, check: () => boolean | Promise<boolean>, ms = 30_000) {
  for (const deadline = Date.now() + ms; !(await check()); await delay(25)) assert.ok(Date.now() < deadline, what);
}
/** Archives a thread once its first run ended (a working one is refused). */
const archive = async (id: string) => {
  await until(`${id}'s run ends`, async () => (await app.conversations.storedHistory(id, { limit: 1 }))?.status.state === "completed");
  await app.conversations.archive(id);
};
const settled = () => until("no start is under way", () => app.registry.listThreads().every(each => !app.conversations.starting(each.id)));

try {
  // Two threads of the gone project take both slots; two good ones queue.
  const gone1 = accept("gone", "gone-1");
  const gone2 = accept("gone", "gone-2");
  const ok1 = accept("ok", "ok-1");
  const ok2 = accept("ok", "ok-2");
  assert.deepEqual([gone1, gone2, ok1, ok2].map(queued), [false, false, true, true], "the gone ones hold the slots, the good ones queue");
  // Their fetches fail; the slots go to the queue at once, without a recovery round.
  await until("the good threads start", () => [ok1, ok2].every(id => thread(id).workspaceState === "available"));
  for (const id of [gone1, gone2]) {
    assert.equal(thread(id).workspaceState, "failed");
    assert.match(thread(id).workspaceError!, /^workspace allocation failed: fetching the latest default branch of .*gone failed: [^]*; it holds no runner slot until cube tries again$/);
    assert.deepEqual(commitSteps(id), ["failed"]);
    assert.equal(thread(id).retry?.failures, 1);
  }
  assert.equal(held(), 2, "the two good threads hold the slots; the failed ones none");
  console.log("ok: threads whose commits fail give up their slots, and the queued threads behind them start");

  // Once its retries stop, a failed thread still holds nothing: a thread
  // queued after it gets the next free slot.
  for (let k = 1; k < 8; k++) app.registry.applyPhase(gone1, { type: "tryFailed", failure: { kind: "allocation", text: thread(gone1).workspaceError! }, at: Date.now() });
  assert.ok(retriesExhausted(thread(gone1)), "its retries stopped");
  const ok3 = accept("ok", "ok-3");
  assert.equal(queued(ok3), true, "the runner is full");
  await settled();
  await archive(ok1);
  await app.conversations.recover();
  await until("the next queued thread starts", () => thread(ok3).workspaceState === "available");
  assert.equal(held(), 2);
  console.log("ok: a failed thread whose retries stopped holds no slot; the queue goes on");

  // Upstream is back. A retry takes a slot only behind the threads waiting.
  const oid = repository(gone);
  const ok4 = accept("ok", "ok-4");
  assert.equal(queued(ok4), true);
  await settled();
  await archive(ok2);
  await app.conversations.activate(gone2);
  assert.equal(thread(gone2).workspaceState, "failed", "no slot for it while a thread waits");
  assert.equal(thread(gone2).retry?.failures, 1, "and no failed try counted");
  assert.deepEqual(commitSteps(gone2), ["failed"], "nor a fetch tried");
  await app.conversations.recover();
  await until("the waiting thread takes the slot", () => thread(ok4).workspaceState === "available");
  await settled();
  await archive(ok3);
  await app.conversations.activate(gone2);
  await until("the retry starts once a slot is free", () => thread(gone2).workspaceState === "available");
  assert.deepEqual(commitSteps(gone2), ["failed", "ok"]);
  assert.equal(thread(gone2).allocation.repositories[0]!.baseOid, oid);
  assert.equal(thread(gone2).retry, undefined, "its retries are reset by the start");
  assert.equal(held(), 2, "ok-4 and the retried thread");
  assert.equal(thread(gone1).workspaceState, "failed", "the exhausted one is left as it was");
  console.log("ok: a retry takes a slot behind the waiting threads, then starts at the upstream's commit");
  await settled();
} finally {
  await app.close();
}
{
  const registry = new Registry(path.join(state, "registry.sqlite"));
  const slots = registry.runnerSlots();
  assert.equal(slots.total - slots.free, registry.listThreads().filter(each => !each.archived && each.workspaceState === "available").length,
    "a reopened registry counts the running threads only, not the failed one");
  registry.close();
  console.log("ok: after a restart the failed thread still holds no slot");
}
fs.rmSync(root, { recursive: true, force: true });
