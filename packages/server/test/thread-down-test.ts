/** A thread agent whose Pi Session failed (a storage error with a request
 * out) through Conversations, on a local guest: it is down in cubed's
 * record, in the thread's status and in OptChat's thread record; and it
 * stays down when its machine boots again (a runner restart or a guest
 * crash) and on every recovery round: nothing reopens it, so the request
 * out at the failure is not sent again. Its archive still runs the release
 * check, and the release ends the mark. Offline: faux model, local guest,
 * disposable state; real VMs run in scripts/test-vm-e2e.ts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import { LocalMachines } from "./local-guest.ts";

const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-thread-down-"));
const machines = new LocalMachines(path.join(root, "machines"));
/** Every request the model got, by its last user text. */
const sends: string[] = [];
const sent = (user: string) => sends.filter(send => send === user).length;
let onSend: (user: string) => void = () => {};
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 40 }, () => (request: { messages: Message[] }) => {
  const user = textOf(request.messages.filter(message => message.role === "user").at(-1)!);
  sends.push(user);
  onSend(user);
  return fauxAssistantMessage(`reply to ${user}`);
}));
const models = createModels();
models.setProvider(faux.provider);
const state = path.join(root, "state");
fs.mkdirSync(state);
const app = await createCubed({ state, models, claude: null, machines });
const conversations = app.conversations;
await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
const address = app.server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;
const adapter = cubeThreads({ registry: app.registry, conversations, catalog: async () => [], runners: () => { throw new Error("unused"); }, latestCommits: () => { throw new Error("unused"); } });
async function until<T>(read: () => T | Promise<T>, check: (value: T) => boolean, what: string): Promise<T> {
  for (let k = 0; ; k++) {
    const value = await read();
    if (check(value)) return value;
    assert.ok(k < 400, `${what}: ${JSON.stringify(value)}`);
    await delay(25);
  }
}
const listed = async (id: string) => (await (await fetch(`${base}/api/threads`)).json()).threads.find((row: { id: string }) => row.id === id);
const DOWN = /^the thread's agent stopped: its history could not be saved \(disk I\/O error \(test\)\); it stays stopped until cubed restarts$/;

try {
  for (const index of [1, 2]) {
    app.registry.enrollRunner({ nodeId: `node-down-${index}`, threadId: `runner-down-${index}`, environmentId: index, configPath: `/private/runner-down-${index}.json`, configHash: `hash-down-${index}`, protocol: 4, kind: "vm" });
  }
  const project = (await (await fetch(`${base}/api/projects`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "empty", repositories: [] }) })).json()).project;
  const id = app.registry.createThread(project.id, "down", { provider: faux.getModel().provider, id: faux.getModel().id }, "hello", "pi").id;
  await conversations.activate(id);
  await until(async () => (await conversations.history(id)).status.state, value => value === "completed", "the first run finishes");
  assert.equal(conversations.down(id), null);

  // The Session fails while a request is out: the reply cannot be saved.
  const agent = await conversations.agent(id);
  const storage = agent.storage as unknown as { commit: (...args: unknown[]) => Promise<unknown> };
  const commit = storage.commit.bind(storage);
  let broken = false;
  storage.commit = (...args) => broken ? Promise.reject(new Error("disk I/O error (test)")) : commit(...args);
  onSend = user => { if (user === "t2") broken = true; };
  await conversations.submit(id, "t2", "t2");
  assert.equal((await agent.harness.closed).reason, "failed");
  onSend = () => {};
  assert.equal(sent("t2"), 1);

  // Down in cubed's record, in the thread's status and in OptChat's record.
  const down = await until(() => conversations.down(id), value => value !== null, "cubed records the agent down");
  assert.match(down!, DOWN);
  // The thread's status: its row is an error with why, and its transcript
  // is not read from the failed Harness; a reader is told why instead.
  let row = await listed(id);
  assert.equal(row.state, "error", "the thread's status shows it");
  assert.equal(row.error, down);
  await assert.rejects(conversations.history(id), (error: Error) => error.message === down, "a reader is told why");
  const history = await fetch(`${base}/api/threads/${id}/history`);
  assert.equal((await history.json()).error, down);
  const record = (await adapter.history(id))!;
  assert.equal(record.failure, down, "OptChat's thread record shows it");
  assert.equal(record.transcript?.status.error, down, "with its stored transcript");

  // Before its machine boots again (its failed Harness still cached), every
  // caller is told why, not Pi's "close and reopen it", and nothing is sent.
  assert.equal(conversations.agentOpen(id), true, "its failed Harness is still cached");
  const why = (error: Error) => error.message === down;
  await assert.rejects(conversations.submit(id, "t3", "t3"), why, "a message is refused with why");
  await assert.rejects(adapter.tell(id, "t3", "t3-tell"), why, "OptChat's tell is refused with why");
  await assert.rejects(conversations.stop(id), why, "stop is refused with why");
  await assert.rejects(conversations.model(id), why, "the model is not read from the failed Harness");
  await assert.rejects(conversations.model(id, { provider: faux.getModel().provider, id: faux.getModel().id }), why, "nor changed");
  for (const [method, route, body] of [["POST", "prompt", { text: "t4", requestId: "t4" }], ["POST", "stop", {}], ["GET", "model", undefined], ["PATCH", "model", { provider: faux.getModel().provider, id: faux.getModel().id }]] as const) {
    const answer = await fetch(`${base}/api/threads/${id}/${route}`, { method, ...body ? { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {} });
    assert.equal(answer.status, 409, `${method} /${route}`);
    assert.equal((await answer.json()).error, down, `${method} /${route} says why`);
  }
  await delay(200);
  assert.equal(sent("t2"), 1);
  assert.equal(sent("t3"), 0);
  assert.equal(sent("t4"), 0);
  console.log("ok: before a reboot a down thread refuses submit, tell, stop, model and HTTP prompt/stop/model with why: 0 sends");

  // Its machine boots again: the agent closes for the resume hooks and is
  // not opened again, so the request out at the failure is not sent again.
  machines.reboot(app.registry.getThread(id)!);
  await conversations.activate(id);
  await delay(500);
  assert.equal(sent("t2"), 1, "a reboot sends nothing again");
  assert.equal(conversations.agentOpen(id), false, "the down agent is not reopened");
  assert.equal(conversations.down(id), down, "and stays down");
  assert.equal(conversations.error(id), down, "the activation fails with why");
  await assert.rejects(conversations.agent(id), (error: Error) => error.message === down, "nothing opens it");
  await assert.rejects(conversations.submit(id, "t3", "t3"), (error: Error) => error.message === down, "a message is refused");
  assert.equal((await adapter.history(id))!.failure, down);
  row = await listed(id);
  assert.equal(row.state, "error");
  assert.equal(row.error, down);
  // Nor does a recovery round, or a second reboot.
  await conversations.boot();
  machines.reboot(app.registry.getThread(id)!);
  await conversations.boot();
  await delay(500);
  assert.equal(sent("t2"), 1, "no recovery round sends it");
  assert.equal(sent("t3"), 0);
  assert.equal(conversations.agentOpen(id), false);
  assert.equal(conversations.down(id), down);
  console.log("ok: a down thread agent is shown down and stays down across reboots and recovery rounds: 0 further sends");

  // A reboot that closes the agent while its failed Session is still
  // closing (before Pi says it failed): the thread is down all the same.
  const raced = app.registry.createThread(project.id, "raced", { provider: faux.getModel().provider, id: faux.getModel().id }, "hello", "pi").id;
  await conversations.activate(raced);
  await until(async () => (await conversations.history(raced)).status.state, value => value === "completed", "the raced thread's first run finishes");
  const racing = await conversations.agent(raced);
  const racedStorage = racing.storage as unknown as { commit: (...args: unknown[]) => Promise<unknown>; close: (...args: unknown[]) => Promise<unknown> };
  const racedCommit = racedStorage.commit.bind(racedStorage), racedClose = racedStorage.close.bind(racedStorage);
  let racedBroken = false;
  let closing!: () => void;
  const closeHeld = new Promise<void>(resolve => { closing = resolve; });
  let closeAsked = false;
  racedStorage.commit = (...args) => racedBroken ? Promise.reject(new Error("disk I/O error (test)")) : racedCommit(...args);
  racedStorage.close = async (...args) => { closeAsked = true; await closeHeld; return racedClose(...args); };
  onSend = user => { if (user === "r2") racedBroken = true; };
  await conversations.submit(raced, "r2", "r2");
  await until(() => closeAsked, value => value, "the failed Session closes its storage");
  assert.equal(conversations.down(raced), null, "not known yet");
  machines.reboot(app.registry.getThread(raced)!);
  const rebooted = conversations.activate(raced);
  await delay(200);
  closing();
  await rebooted;
  onSend = () => {};
  assert.equal((await racing.harness.closed).reason, "failed");
  await delay(500);
  assert.equal(sent("r2"), 1, "a reboot during the failure sends nothing again");
  assert.equal(conversations.agentOpen(raced), false);
  assert.match(conversations.down(raced) ?? "", DOWN, "the thread is down");
  console.log("ok: a reboot while the Session is failing leaves the thread down: 0 further sends");

  // Its archive runs the release check (nothing is open to ask), and the
  // release ends the mark.
  const archived = await conversations.archive(id);
  assert.deepEqual(archived, { retained: false, reason: "clean" });
  assert.equal(app.registry.getThread(id)!.archived, true);
  assert.equal(conversations.down(id), null, "the release clears it");
  assert.equal(sent("t2"), 1);
  console.log("ok: a down thread is archived after its release check, and the release clears the mark");
} finally {
  await app.close();
  await machines.close();
  fs.rmSync(root, { recursive: true, force: true });
}
