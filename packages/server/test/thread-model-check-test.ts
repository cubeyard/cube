/** A thread's model is checked as it starts, not when it is accepted:
 * through cubed's HTTP route and OptChat's spawn, with Pi's own model
 * runtime over a disposable agent directory (PI_OFFLINE: no catalog over
 * the network, and no thread reaches a model request: its project's
 * upstream is gone).
 *
 *   - a provider key stored as a slow `!command` (it leaves a mark when it
 *     runs) is not run while either caller accepts; the thread's start runs
 *     it, and Pi runs it synchronously: the event loop stops for it, once;
 *   - a model not in the catalog, and one whose provider's key command
 *     yields no key, are accepted by both callers and fail the thread's
 *     `model` step with words that say which, holding no runner slot.
 *
 * Disposable state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createCubed } from "../src/index.ts";
import { createModelRuntime } from "../src/models.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import { LocalMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-model-check-"));
const agentDir = path.join(root, "agent");
fs.mkdirSync(agentDir);
fs.writeFileSync(path.join(agentDir, "auth.json"), "{}\n");
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";

// cubed's own model runtime (models.ts), as it makes one without `models`.
const models = await createModelRuntime();
const app = await createCubed({ state: path.join(root, "state"), models, machines: new LocalMachines(path.join(root, "machines")), claude: null, gateway: null });
await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
const address = app.server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;
app.registry.enrollRunner({ nodeId: "node-m", threadId: "m", environmentId: 1, configPath: "/private/m.json", configHash: "m", maxActiveVms: 1, protocol: 4, kind: "vm" });
app.registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [
  { id: "p-r", projectId: "p", position: 0, url: path.join(root, "gone"), base: null, checkoutName: "p", status: "ready", error: null, resolvedBase: "main", baseOid: "0".repeat(40), checkedAt: 1 }] });

// Keys saved after cubed started: a key command Pi has not run yet.
const mark = path.join(root, "ran");
const openai = models.getModels("openai")[0]!.id;
const anthropic = models.getModels("anthropic")[0]!.id;
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
  openai: { type: "api_key", key: `!touch '${mark}'; sleep 1; echo sk-test` },
  anthropic: { type: "api_key", key: "!exit 1" },
}));
// Pi reads the edited file again in the background; listing runs no key command.
assert.deepEqual((await models.listCredentials()).map(each => each.providerId).sort(), ["anthropic", "openai"]);
assert.equal(fs.existsSync(mark), false);

const threads = cubeThreads({ registry: app.registry, conversations: app.conversations, catalog: () => [], runners: () => ({ runners: [] }) as never });
const post = async (model: { provider: string; id: string }, requestId: string) => {
  const response = await fetch(`${base}/api/threads`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ projectId: "p", requestId, text: "hello", model }) });
  return { status: response.status, body: await response.json() as { id?: string; error?: string } };
};
const thread = (id: string) => app.registry.getThread(id)!;
const steps = (id: string) => (thread(id).vm?.steps ?? []).filter(step => step.name === "model" || step.name === "commits").map(step => `${step.name} ${step.state}`);
async function until(what: string, check: () => boolean, ms = 30_000) {
  for (const deadline = Date.now() + ms; !check(); await delay(25)) assert.ok(Date.now() < deadline, what);
}

try {
  // The event loop's longest pause from here on.
  let last = performance.now(), longest = 0;
  const ticker = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 10);

  // A thread that holds the one slot, so both start in their turn, later:
  // nothing but acceptance runs until then.
  const blocker = app.registry.createThread("p", "blocker", { provider: "openai", id: openai }, "hold the slot", "pi", { latest: true }).id;
  const viaPost = await post({ provider: "openai", id: openai }, "slow-post");
  assert.equal(viaPost.status, 200, JSON.stringify(viaPost.body));
  const viaSpawn = await threads.spawn({ project: "p", task: "slow spawn", model: `openai/${openai}` }, "optchat:slow:0");
  await until("both queue", () => [viaPost.body.id!, viaSpawn.id].every(id => thread(id).vm?.suspension?.state === "queued" && !app.conversations.starting(id)));
  assert.equal(fs.existsSync(mark), false, "neither caller ran the key command");
  assert.deepEqual([viaPost.body.id!, viaSpawn.id].map(steps), [[], []]);
  console.log("ok: both callers accept a thread without running its provider's key command");
  // The slot frees (the blocker's commits failed), and the queue goes on.
  app.registry.applyPhase(blocker, { type: "failed", failure: { kind: "allocation", text: "workspace allocation failed: test" } });
  await app.conversations.recover();

  await until("the start checks the model", () => [viaPost.body.id!, viaSpawn.id].every(id => steps(id).includes("commits failed")));
  clearInterval(ticker);
  assert.equal(fs.existsSync(mark), true, "the start ran it");
  for (const id of [viaPost.body.id!, viaSpawn.id]) assert.deepEqual(steps(id), ["model ok", "commits failed"], "the model checked out; the gone upstream stopped the start before any model request");
  assert.ok(longest >= 900, `Pi runs the key command synchronously: the event loop stopped ${Math.round(longest)} ms`);
  console.log(`ok: the start runs the key command; the event loop stopped for ${Math.round(longest)} ms (Pi's execSync), once`);

  // A model not in the catalog, and one whose key command yields no key: accepted, then a failed model step.
  const unknown = await post({ provider: "openai", id: "no-such-model" }, "unknown-post");
  assert.equal(unknown.status, 200);
  const unknownSpawn = await threads.spawn({ project: "p", task: "unknown spawn", model: "openai/no-such-model" }, "optchat:unknown:0");
  const keyless = await post({ provider: "anthropic", id: anthropic }, "keyless-post");
  const keylessSpawn = await threads.spawn({ project: "p", task: "keyless spawn", model: `anthropic/${anthropic}` }, "optchat:keyless:0");
  await assert.rejects(threads.spawn({ project: "p", task: "malformed", model: "no-slash" }, "optchat:malformed:0"), { message: "model no-slash is not provider/id" });
  const failed = (id: string) => thread(id).workspaceState === "failed";
  await until("the model steps fail", () => [unknown.body.id!, unknownSpawn.id, keyless.body.id!, keylessSpawn.id].every(failed));
  for (const id of [unknown.body.id!, unknownSpawn.id]) {
    assert.deepEqual(steps(id), ["model failed"]);
    assert.match(thread(id).workspaceError!, /^workspace allocation failed: model openai\/no-such-model is not in the model catalog; selectable models: openai\/.*; it holds no runner slot until cube tries again$/);
  }
  for (const id of [keyless.body.id!, keylessSpawn.id]) {
    assert.deepEqual(steps(id), ["model failed"]);
    assert.match(thread(id).workspaceError!, new RegExp(`^workspace allocation failed: model anthropic/${anthropic.replace(/[.]/g, "\\.")} is known, but its provider has no working credential \\(its key or key command in Pi's auth\\.json, or its environment\\); selectable models: `));
  }
  const slots = app.registry.runnerSlots();
  assert.equal(slots.total - slots.free, 0, "no failed thread holds a slot");
  console.log("ok: an unknown model and a provider without a working key are accepted by both callers and fail the model step, saying which");
  await until("no start is under way", () => app.registry.listThreads().every(each => !app.conversations.starting(each.id)));
} finally {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
}
