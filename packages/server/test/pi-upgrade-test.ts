/** What cube relies on in pi-durable 1.3.0, pinned so a later Pi upgrade
 * that changes it fails here first: the SQLite schema (still version 1, so
 * no one-way migration), documents without `checkpointWhen`, a throwing
 * `beforeRequest` (reported and skipped: the request still goes out), a
 * hook held until a close aborts it (nothing sent, sent once after reopen),
 * a real storage failure (it ends the Harness: no send, no paid retry in
 * the same process; the reopened Harness sends again, so nothing is
 * exactly-once), a stop (never sent again), and the provider session id
 * (Pi's per conversation; OptChat's own keys win; a thread agent releases
 * Pi's on close). Offline: faux model, local guest, disposable state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, registerSessionResourceCleanup, type Message } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, GenerationTask, Harness, hook, ROOT_CONVERSATION_ID, type Conversation } from "@earendil-works/pi-durable";
import { CURRENT_SQLITE_SCHEMA_VERSION, type SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openAgent, openStorage, readStorage } from "../src/durable-agent.ts";
import { cachedModels } from "../src/optchat-cache.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { LocalGuestTransport } from "./local-guest.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-pi-upgrade-"));
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Every request the model got: its last user text and its session id. */
const sends: Array<{ user: string; session: string | undefined }> = [];
const sent = (user: string) => sends.filter(send => send.user === user).length;
/** Runs in the model, after the request was sent. */
let onSend: (user: string, signal: AbortSignal | undefined) => Promise<void> | void = () => {};
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 200 }, () => async (request, options) => {
  const user = textOf(request.messages.filter(message => message.role === "user").at(-1)!);
  sends.push({ user, session: options?.sessionId });
  await onSend(user, options?.signal);
  return fauxAssistantMessage(`reply to ${user}`);
}));
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };

/** What the hook does before each request. */
let mode: "pass" | "replace" | "throw" | "hold" | "memo" = "pass";
let held = false;
const reports: unknown[] = [];
let failing: { armed: boolean } = { armed: false };
const Hooks = defineExtension({ name: "upgrade-test", hooks: [hook(GenerationTask, { beforeRequest: async (request, api, callContext) => {
  if (mode === "throw") throw new Error("the hook failed");
  if (mode === "replace") return { messages: [...request.messages.slice(0, -1), { role: "user", content: "REPLACED", timestamp: Date.now() }] };
  if (mode === "hold") {
    // As OptChat's holdBack: wait until the close aborts, then throw.
    held = true;
    const signal = callContext.abortSignal!;
    if (!signal.aborted) await new Promise(resolve => { signal.addEventListener("abort", resolve, { once: true }); });
    signal.throwIfAborted();
  }
  if (mode === "memo") {
    // A record committed right before the send, on a storage that fails.
    failing.armed = true;
    await api.memo("cube.test.out", { at: Date.now() }, callContext);
  }
  return undefined;
} })] });

/** Cube's SQLite storage, whose commit throws while armed, as a full disk or
 * an I/O error would: a storage error, not a throw in a commit callback. */
function failable(storage: SqliteStorage, state: { armed: boolean }): SqliteStorage {
  return new Proxy(storage, {
    get(target, property, receiver) {
      if (property === "commit") return (...args: Parameters<SqliteStorage["commit"]>) => {
        if (state.armed) return Promise.reject(new Error("disk I/O error (test)"));
        return target.commit(...args);
      };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const file = path.join(root, "pi.sqlite");
async function open(): Promise<{ harness: Harness; conversation: Conversation }> {
  failing = { armed: false };
  const registry = createRegistry();
  registry.install(Hooks);
  const harness = await Harness.open(failable(await openStorage(file), failing), { models, registry, onReport: error => { reports.push(error); } }, context);
  const conversation = await harness.conversation(ROOT_CONVERSATION_ID, context) ?? await harness.root(context, { agent: { model } });
  harness.resume();
  return { harness, conversation };
}
async function turn(conversation: Conversation, content: string) {
  const submission = await conversation.submit({ type: "input", content, requestId: content }, context);
  return submission.wait(context);
}
async function until(check: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 10_000;
  while (!await check()) { assert(Date.now() < deadline, `waiting for ${what}`); await delay(10); }
}
/** The conversation's assistant texts, in order. */
async function answers(conversation: Conversation): Promise<string[]> {
  const watch = await conversation.watch(context);
  await watch.stop();
  return watch.value.entries.flatMap(entry => entry.kind === "pi.assistant" ? (entry.model ?? []).map(textOf) : []);
}

try {
  {
    // The schema: Pi 1.3.0 still writes SQLite schema 1, as 1.0.1 did, so
    // opening an older store migrates nothing and an older cubed can open
    // a newer one. A Pi with schema 2 (upstream main) migrates one way:
    // upgrading to it needs a backup and a rollback plan first.
    assert.equal(CURRENT_SQLITE_SCHEMA_VERSION, 1, "Pi's SQLite schema moved: its migration is one-way; plan backup and rollback before this upgrade");
    const { harness } = await open();
    await harness.close(context);
    const database = new DatabaseSync(file, { readOnly: true });
    try { assert.deepEqual({ ...database.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get() }, { version: 1 }); }
    finally { database.close(); }
    assert.equal(await readStorage(file, async () => "read"), "read", "cube's read-only snapshot takes the store");
    console.log("ok: Pi 1.3.0 keeps SQLite schema 1; nothing is migrated on open");
  }

  {
    // checkpointWhen is optional in 1.3.0 (upstream main requires it on
    // every defineDoc): cube's documents have none and keep working.
    const Doc = defineDoc<{ n: number }>({ kind: "cube.test.counter", version: 1, scope: "session", initial: () => ({ n: 0 }) });
    let { harness } = await open();
    await harness.commit(async tx => { (await tx.doc(Doc)).n += 41; return undefined; }, context);
    await harness.commit(async tx => { (await tx.doc(Doc)).n += 1; return undefined; }, context);
    await harness.close(context);
    ({ harness } = await open());
    assert.equal((await harness.snapshot(Doc, context))?.n, 42, "a document without checkpointWhen commits and reads back after a reopen");
    await harness.close(context);
    console.log("ok: documents without checkpointWhen commit and survive a reopen");
  }

  let session: string | undefined;
  {
    // beforeRequest: its result replaces the request's messages; its throw
    // is reported and skipped, and the request goes out unchanged. A hook
    // cannot refuse a send by throwing.
    const { harness, conversation } = await open();
    mode = "replace";
    assert.equal((await turn(conversation, "c1")).status, "done");
    assert.deepEqual(sends.map(send => send.user), ["REPLACED"], "the hook's messages are what is sent");
    mode = "throw";
    reports.length = 0;
    assert.equal((await turn(conversation, "c2")).status, "done", "a throwing hook does not fail the turn");
    assert.equal(sent("c2"), 1, "the request is sent anyway, with the messages Pi built");
    assert.ok(reports.some(error => error instanceof Error && error.message === "the hook failed"), "and the throw is reported");
    session = sends[0]!.session;
    assert.match(session ?? "", UUID, "Pi sends its own provider session id");
    assert.ok(sends.every(send => send.session === session), "the same one on every request of the conversation");
    mode = "pass";
    await harness.close(context);
    console.log("ok: beforeRequest replaces messages; a throw in it is reported and the request is still sent");
  }

  {
    // A request held in beforeRequest while the Harness closes (OptChat's
    // close gate): the close aborts it and nothing is sent; the reopened
    // Harness sends it once. Pi's session id survives the reopen.
    let { harness, conversation } = await open();
    mode = "hold";
    held = false;
    const submission = await conversation.submit({ type: "input", content: "d1", requestId: "d1" }, context);
    await until(() => held, "the request to be held");
    await harness.close(context);
    void submission.wait(context).catch(() => {});
    assert.equal(sent("d1"), 0, "a held request is not sent at a close");
    mode = "pass";
    ({ harness, conversation } = await open());
    await until(async () => (await answers(conversation)).includes("reply to d1"), "d1 answered after the reopen");
    await conversation.waitForIdle(context);
    assert.equal(sent("d1"), 1, "the reopened Harness sends it once");
    assert.equal(sends.at(-1)!.session, session, "with the same provider session id");
    await harness.close(context);
    console.log("ok: a request held at a close is not sent, and is sent once after the reopen");
  }

  {
    // A storage failure after the request went out (its answer's commit
    // fails): the Harness ends (closed: failed), the wait rejects, and no
    // retry is sent in this process. The reopened Harness finds the
    // generation still at its request and sends it again: a send is not
    // exactly-once, and its first cost is unknown.
    let { harness, conversation } = await open();
    const state = failing;
    onSend = user => { if (user === "e1") state.armed = true; };
    const submission = await conversation.submit({ type: "input", content: "e1", requestId: "e1" }, context);
    const end = await harness.closed;
    assert.equal(end.reason, "failed", "a storage error ends the Harness");
    await assert.rejects(submission.wait(context), "the turn's wait rejects");
    await assert.rejects(conversation.submit({ type: "input", content: "after", requestId: "after" }, context), "and so does every later call");
    await delay(200);
    assert.equal(sent("e1"), 1, "no retry is sent in the failed process");
    assert.equal(sent("after"), 0);
    onSend = () => {};
    ({ harness, conversation } = await open());
    await until(async () => (await answers(conversation)).includes("reply to e1"), "e1 answered after the reopen");
    await conversation.waitForIdle(context);
    assert.equal(sent("e1"), 2, "the reopened Harness sends it again: twice in all");
    assert.equal((await answers(conversation)).filter(text => text === "reply to e1").length, 1, "one answer is stored");
    await harness.close(context);
    console.log("ok: a storage failure after a send ends the Harness; the reopen sends it again (not exactly-once)");
  }

  {
    // A storage failure in the hook's own record before the send: the
    // Session fails, the invocation is aborted, the hook's throw then
    // propagates, and nothing is sent. Reopened, it is sent once.
    let { harness, conversation } = await open();
    mode = "memo";
    const submission = await conversation.submit({ type: "input", content: "e2", requestId: "e2" }, context);
    assert.equal((await harness.closed).reason, "failed");
    await submission.wait(context).catch(() => {});
    await delay(200);
    assert.equal(sent("e2"), 0, "a request whose pre-send record failed is not sent");
    mode = "pass";
    ({ harness, conversation } = await open());
    await until(async () => (await answers(conversation)).includes("reply to e2"), "e2 answered after the reopen");
    await conversation.waitForIdle(context);
    assert.equal(sent("e2"), 1, "sent once, by the reopened Harness");
    await harness.close(context);
    console.log("ok: a storage failure before a send fails closed: nothing is sent until the reopen");
  }

  {
    // A stop while the request streams: the turn ends, and the request is
    // never sent again, here or after a reopen.
    let { harness, conversation } = await open();
    let streaming = false;
    onSend = async (user, signal) => {
      if (user !== "g1" || !signal) return;
      streaming = true;
      if (!signal.aborted) await new Promise(resolve => { signal.addEventListener("abort", resolve, { once: true }); });
    };
    const submission = await conversation.submit({ type: "input", content: "g1", requestId: "g1" }, context);
    await until(() => streaming, "g1 to be sent");
    await conversation.abort(context);
    await submission.wait(context).catch(() => {});
    onSend = () => {};
    await harness.close(context);
    ({ harness, conversation } = await open());
    await conversation.waitForIdle(context);
    await delay(200);
    assert.equal(sent("g1"), 1, "a stopped request is not sent again after a reopen");
    assert.ok(!(await answers(conversation)).includes("reply to g1"), "and has no stored answer");
    // Another conversation has a provider session id of its own.
    const other = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model } }, context);
    assert.equal((await (await other.submit({ type: "input", content: "h1", requestId: "h1" }, context)).wait(context)).status, "done");
    const otherSession = sends.find(send => send.user === "h1")!.session;
    assert.match(otherSession ?? "", UUID);
    assert.notEqual(otherSession, session, "each conversation has its own provider session id");
    await harness.close(context);
    console.log("ok: a stopped request is never sent again; each conversation has its own session id");
  }

  {
    // OptChat's cache keys win over Pi's session id: the chat and the
    // compactor keep their own caches, and a close releases those keys.
    const chat = cachedModels(models, () => "optchat-key");
    await chat.completeSimple(faux.getModel(), { messages: [{ role: "user", content: "k1", timestamp: Date.now() }] }, { sessionId: "pi-conversation-id" });
    assert.equal(sends.at(-1)!.session, "optchat-key", "OptChat's own key, not the one Pi passes");
    console.log("ok: OptChat's cache key replaces Pi's provider session id");
  }

  {
    // A thread agent sends Pi's id (its own prompt cache key per
    // conversation) and releases pi-ai's session resources for it on
    // close, so a cached provider connection (Codex's WebSocket, five
    // minutes) does not hold cubed's exit.
    const files = path.join(root, "agent", "workspace");
    const directory = path.join(root, "agent", "thread");
    fs.mkdirSync(files, { recursive: true });
    const guest = new LocalGuestTransport(path.dirname(files));
    const leases = new LeaseStore(directory);
    const workspace = new VmWorkspace({ guest, leases, owner: "pi", binding: guest.binding });
    const released: string[] = [];
    const unregister = registerSessionResourceCleanup(id => { if (id) released.push(id); });
    try {
      const agent = await openAgent({ directory, binding: guest.binding, workspace, models, model: { provider: model.provider, id: model.modelId } });
      assert.equal((await turn(agent.conversation, "t1")).status, "done");
      const id = sends.find(send => send.user === "t1")!.session;
      assert.match(id ?? "", UUID, "a thread agent's request carries Pi's session id");
      assert.deepEqual(released, [], "nothing is released while the agent is open");
      await agent.close();
      assert.deepEqual(released, [id], "its close releases that id's resources");
    } finally { unregister(); }
    console.log("ok: a thread agent releases Pi's provider session on close");
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
