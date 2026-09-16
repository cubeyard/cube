/** End-to-end durable delivery between two Cube conversations and replaceable
 * worker processes. No model credentials, network, or Incus are required. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";

import { Conversations } from "../src/conversation.ts";
import { Registry, type ThreadTaskRow } from "../src/registry.ts";
import { ThreadTasks } from "../src/thread-tasks.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-thread-tasks-"));
const dbPath = path.join(root, "cubed.db");
const worker = path.join(root, "worker.mjs");
const starts = path.join(root, "worker-starts");
fs.writeFileSync(starts, "0");
fs.writeFileSync(worker, `
import fs from "node:fs";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
fs.writeFileSync(${JSON.stringify(starts)}, String(Number(fs.readFileSync(${JSON.stringify(starts)}, "utf8")) + 1));
const emit = event => fs.writeSync(3, JSON.stringify(event) + "\\n");
if (request.prompt.includes("CRASH")) process.exit(19);
if (request.prompt.includes("SLOW")) await new Promise(resolve => setTimeout(resolve, 30000));
const text = request.prompt.includes("OVERSIZE") ? "x".repeat(17000) : "reply:" + request.prompt.split("\\n\\n").at(-1);
emit({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() } });
emit({ type: "complete" });
`);

const createRegistry = () => {
  const registry = new Registry(dbPath);
  if (!registry.getProject("project")) {
    registry.createProject({ id: "project", name: "project", repositories: [] });
    registry.createProject({ id: "other", name: "other", repositories: [] });
    for (const [id, project] of [["source", "project"], ["target", "project"], ["third", "project"], ["foreign", "other"]] as const) {
      const cube = registry.createCube({ name: id, image: "test", workspacePath: root });
      registry.addThread({ id, cubeId: cube.id, projectId: project, piSessionPath: path.join(root, `${id}.jsonl`) });
      registry.setCubeStatus(id, "ready");
      registry.setThreadModel(id, { provider: "fixture", id: "fixture" });
    }
  }
  return registry;
};

const makeConversations = (registry: Registry, tasks: ThreadTasks) => new Conversations(registry, {
  plan: () => Effect.succeed({ cwd: root, env: { ...process.env } }),
  activity: () => Effect.void,
}, { worker, extension: "/unused", tasks });

const waitTask = async (tasks: ThreadTasks, actor: string, id: string, states: ThreadTaskRow["status"][]) => {
  for (let n = 0; n < 500; n++) {
    const task = await Effect.runPromise(tasks.get(actor, id));
    if (states.includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`task ${id} did not reach ${states.join("/")}`);
};

let registry = createRegistry();
let tasks = new ThreadTasks(registry);
let conversations = makeConversations(registry, tasks);
try {
  await assert.rejects(Effect.runPromise(conversations.sendTask("source", {
    recipient: "target", requestKey: "unauthorized", body: "no",
  })), /not permitted/);
  await assert.rejects(Effect.runPromise(tasks.grant("source", "foreign")), /not permitted/);
  await assert.rejects(Effect.runPromise(tasks.grant("source", "source")), /not permitted/);
  await Effect.runPromise(tasks.grant("source", "target"));
  assert.deepEqual(await Effect.runPromise(tasks.destinations("source")), [{ id: "target", title: null }]);
  assert.deepEqual(await Effect.runPromise(tasks.destinations("target")), [], "grants are directed");

  for (const body of ["", " ", "é".repeat(8193), "\ud800"]) {
    await assert.rejects(Effect.runPromise(conversations.sendTask("source", {
      recipient: "target", requestKey: "invalid", body,
    })), /empty or too long/);
  }
  const first = await Effect.runPromise(conversations.sendTask("source", {
    recipient: "target", requestKey: "first", body: "inspect the host node",
  }));
  const duplicate = await Effect.runPromise(conversations.sendTask("source", {
    recipient: "target", requestKey: "first", body: "inspect the host node",
  }));
  assert.equal(duplicate.id, first.id);
  await assert.rejects(Effect.runPromise(conversations.sendTask("source", {
    recipient: "target", requestKey: "first", body: "changed",
  })), /conflict/);
  const completed = await waitTask(tasks, "source", first.id, ["completed"]);
  assert.equal(completed.result, "reply:inspect the host node");
  assert.equal(registry.listConversationMessages("target")[0]?.content, "inspect the host node");
  assert.deepEqual((registry.listConversationMessages("target")[0]?.payload as any).source,
    { type: "thread-task", taskId: first.id, sender: "source" });
  assert.equal(Number(fs.readFileSync(starts, "utf8")), 1, "idempotent retry starts one worker");

  // Concurrent sends serialize through the recipient's one active run and all
  // receive independent durable replies.
  const parallel = await Promise.all(Array.from({ length: 8 }, (_, n) =>
    Effect.runPromise(conversations.sendTask("source", {
      recipient: "target", requestKey: `parallel-${n}`, body: `parallel ${n}`,
    }))));
  const parallelDone = await Promise.all(parallel.map((task) => waitTask(tasks, "source", task.id, ["completed"])));
  assert.deepEqual(parallelDone.map((task) => task.result).sort(), parallel.map((_, n) => `reply:parallel ${n}`).sort());

  const crashed = await Effect.runPromise(conversations.sendTask("source", {
    recipient: "target", requestKey: "crash", body: "CRASH",
  }));
  assert.match((await waitTask(tasks, "source", crashed.id, ["failed"])).error!, /exited 19/);
  const oversized = await Effect.runPromise(conversations.sendTask("source", {
    recipient: "target", requestKey: "oversize", body: "OVERSIZE",
  }));
  assert.match((await waitTask(tasks, "source", oversized.id, ["failed"])).error!, /result exceeded/);

  const slow = await Effect.runPromise(conversations.sendTask("source", {
    recipient: "target", requestKey: "cancel", body: "SLOW",
  }));
  await waitTask(tasks, "source", slow.id, ["delivered"]);
  const cancelled = await Effect.runPromise(conversations.cancelTask("source", slow.id));
  assert.equal(cancelled.status, "cancelled");
  await assert.rejects(Effect.runPromise(conversations.cancelTask("third", slow.id)), /not found/);

  // An interrupted delivered turn is failed on restart. Reopening performs
  // read-only reconciliation and never starts a replacement worker.
  const ambiguous = await Effect.runPromise(conversations.sendTask("source", {
    recipient: "target", requestKey: "restart", body: "SLOW ambiguous side effect",
  }));
  await waitTask(tasks, "source", ambiguous.id, ["delivered"]);
  const startsBeforeRestart = Number(fs.readFileSync(starts, "utf8"));
  await Effect.runPromise(conversations.close());
  registry.close();
  registry = createRegistry();
  tasks = new ThreadTasks(registry);
  conversations = makeConversations(registry, tasks);
  const reconciled = await waitTask(tasks, "source", ambiguous.id, ["failed"]);
  assert.match(reconciled.error!, /outcome unknown and not replayed/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(Number(fs.readFileSync(starts, "utf8")), startsBeforeRestart);

  // Accepted means no worker handoff occurred and is the only state safe to
  // resume after restart. A busy direct turn leaves the task accepted.
  const busy = await Effect.runPromise(conversations.submit("target", "SLOW direct"));
  const queued = await Effect.runPromise(conversations.sendTask("source", {
    recipient: "target", requestKey: "accepted-restart", body: "safe queued delivery",
  }));
  assert.equal((await Effect.runPromise(tasks.get("source", queued.id))).status, "accepted");
  await Effect.runPromise(conversations.close());
  registry.close();
  registry = createRegistry();
  tasks = new ThreadTasks(registry);
  conversations = makeConversations(registry, tasks);
  assert.equal(registry.getAgentRun(busy.runId)?.status, "failed");
  assert.equal((await waitTask(tasks, "source", queued.id, ["completed"])).result, "reply:safe queued delivery");

  // Revocation/archive stop not-yet-delivered work; retained identities make
  // destructive delete fail before environment teardown.
  const hold = await Effect.runPromise(conversations.submit("target", "SLOW hold"));
  const revoked = await Effect.runPromise(conversations.sendTask("source", {
    recipient: "target", requestKey: "revoked", body: "must not run",
  }));
  const recent = (await Effect.runPromise(tasks.list("source"))).length;
  for (let n = recent; n < 30; n++) {
    await Effect.runPromise(tasks.send("source", {
      recipient: "target", requestKey: `rate-${n}`, body: `bounded ${n}`,
    }));
  }
  await assert.rejects(Effect.runPromise(tasks.send("source", {
    recipient: "target", requestKey: "rate-overflow", body: "must be refused",
  })), /rate exceeded/);
  await Effect.runPromise(tasks.revoke("source", "target"));
  await Effect.runPromise(conversations.cancelThread("target"));
  registry.cancelAgentRun(hold.runId);
  conversations.kickTasks("target");
  assert.equal((await waitTask(tasks, "source", revoked.id, ["failed"])).result, null);
  await assert.rejects(Effect.runPromise(tasks.preflightDelete("source")), /archive it instead/);
  assert.throws(() => registry.deleteCube("source"), /FOREIGN KEY/);
  registry.archiveThread("source");
  await assert.rejects(Effect.runPromise(conversations.sendTask("source", {
    recipient: "target", requestKey: "archived", body: "no",
  })), /not permitted/);

  console.log("thread-tasks-test: delivery, replies, idempotency, concurrency, bounds, auth, cancellation, crash, restart/no-replay and deletion all ok");
} finally {
  await Effect.runPromise(conversations.close()).catch(() => {});
  registry.close();
  fs.rmSync(root, { recursive: true, force: true });
}
