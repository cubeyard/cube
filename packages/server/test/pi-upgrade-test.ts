/** What cube relies on in pi-durable 1.4.0, pinned so a later Pi upgrade
 * that changes it fails here first: the SQLite schema (2: a store of
 * schema 1 is migrated one way on open, and cube's read-only readers take
 * both without migrating the original), documents with `checkpointWhen:
 * () => false` (1.3.0's default, now required), a throwing `beforeRequest`
 * (reported and skipped: the request still goes out), a hook held until a
 * close aborts it (nothing sent, sent once after reopen), a real storage
 * failure (it ends the Harness: no send, no paid retry in the same process;
 * the reopened Harness sends again, so nothing is exactly-once), a stop
 * (never sent again), and the provider session id (Pi's per conversation;
 * OptChat's own keys win; a thread agent releases Pi's on close). And what
 * cube builds on it: a hook fails closed by aborting its own generation
 * before it throws (OptChat's beforeRequest), Pi's reports reach cubed's
 * log redacted, with their type, and a thread agent whose Session failed is
 * down at once, its provider sessions released, with no retry. Pi's
 * crash-loop guard is in pi-restart-test.ts.
 * Offline: faux model, local guest, disposable state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, registerSessionResourceCleanup, type Message } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, GenerationTask, Harness, hook, ROOT_CONVERSATION_ID, type Conversation } from "@earendil-works/pi-durable";
import { CURRENT_SQLITE_SCHEMA_VERSION, SQLITE_MIGRATIONS, type SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openAgent, openStorage, readStorage } from "../src/durable-agent.ts";
import { reportText } from "../src/pi-report.ts";
import { readPiHistory } from "../src/thread-history.ts";
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
let mode: "pass" | "replace" | "throw" | "hold" | "memo" | "refuse" = "pass";
/** The Harness the hook runs in, for `refuse`. */
let current: Harness | undefined;
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
  if (mode === "refuse") {
    // As OptChat's refuse: abort the generation, wait for the abort, then
    // throw; a throw on an aborted invocation ends it instead of being skipped.
    const signal = callContext.abortSignal!;
    void current!.abortTask(api.taskId, context);
    if (!signal.aborted) await new Promise(resolve => { signal.addEventListener("abort", resolve, { once: true }); });
    throw new Error("the view failed");
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
  current = harness;
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
    // What cubed logs of a report: name, code and message, one line,
    // redacted, bounded; never a stack, a cause or other fields.
    const error = Object.assign(new TypeError("fetch https://user:hunter2@api.example/v1?key=AIzaSecret&x=1 failed\nwith Bearer abcdefghijkl and sk-abcdefghijklmnopqrstuv"), { code: "E_TEST", body: "sk-body-secret", cause: new Error("sk-cause-secret") });
    const text = reportText(error);
    assert.equal(text, "TypeError: fetch https://user:[redacted]@api.example/v1?key=[redacted]&x=1 failed with Bearer [redacted] and sk-[redacted] (E_TEST)");
    assert.equal(reportText("plain"), "plain");
    assert.equal(reportText({ apiKey: "sk-abcdefghijklmnopqrstuv" }), "non-error object", "an object's fields are never rendered");
    assert.equal(reportText(new Error("x".repeat(5000))).length, 1000, "bounded");
    console.log("ok: reports are logged redacted and bounded, without fields");
  }

  {
    // The schema: Pi 1.4.0 writes SQLite schema 2, which adds the `sleeping`
    // task status by rebuilding the task table; entries and documents are
    // as in 1, which 1.0.1 to 1.3.0 wrote. Opening a schema-1 store migrates
    // it one way, in one transaction: 1.3.0 refuses it after that ("Durable
    // SQLite schema version 2 is newer than supported version 1"), so a
    // cubed rolled back past this upgrade cannot open its Pi stores.
    assert.equal(CURRENT_SQLITE_SCHEMA_VERSION, 2, "Pi's SQLite schema moved again: review the one-way migration, the readers and rollback before this upgrade");
    // A schema-1 store as 1.3.0 left it: a conversation with a turn, then
    // its task table rebuilt with migration 1's own statements (no task
    // sleeps in it). Its schema is checked against a store migration 1 alone
    // builds.
    const v1 = path.join(root, "v1.sqlite");
    {
      const storage = await openStorage(v1);
      const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
      const conversation = await harness.root(context, { agent: { model } });
      harness.resume();
      assert.equal((await turn(conversation, "s1")).status, "done");
      await harness.close(context);
      const migration1 = SQLITE_MIGRATIONS[0]!.statements;
      const db = new DatabaseSync(v1);
      try {
        db.exec("BEGIN; ALTER TABLE tasks RENAME TO tasks_v2;");
        for (const index of db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks_v2' AND sql IS NOT NULL").all() as Array<{ name: string }>) db.exec(`DROP INDEX ${index.name}`);
        for (const statement of migration1.filter(sql => /^CREATE (TABLE|INDEX) \S+ ON tasks\b|^CREATE TABLE tasks\b/.test(sql.replace(/\s+/g, " ").trim()))) db.exec(statement);
        db.exec("INSERT INTO tasks SELECT * FROM tasks_v2; DROP TABLE tasks_v2; UPDATE durable_schema SET version = 1; COMMIT;");
      } finally { db.close(); }
      const fresh = new DatabaseSync(":memory:");
      fresh.exec("CREATE TABLE durable_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL CHECK (version >= 0)) STRICT");
      for (const statement of migration1) fresh.exec(statement);
      const ddl = (database: DatabaseSync) => (database.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name").all() as Array<{ sql: string }>).map(row => ({ ...row, sql: row.sql.replace(/\s+/g, "") }));
      const built = new DatabaseSync(v1, { readOnly: true });
      try { assert.deepEqual(ddl(built), ddl(fresh), "the schema-1 store has migration 1's schema exactly"); }
      finally { built.close(); fresh.close(); }
    }
    const version = (file: string) => {
      const database = new DatabaseSync(file, { readOnly: true });
      try { return (database.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get() as { version: number }).version; }
      finally { database.close(); }
    };
    // cube's read-only readers take it and leave it as it was: the history
    // pages (an archived thread's store is never migrated) and the usage
    // snapshot, whose private copy pi-durable migrates.
    const bytes = fs.readFileSync(v1);
    const page = await readPiHistory(v1, null, null, {});
    assert.ok(page && JSON.stringify(page).includes("reply to s1"), "the history reader pages a schema-1 store");
    const conversations = async (storage: SqliteStorage) => (await storage.scanConversations({}, 16, undefined, context)).items.length;
    assert.equal(await readStorage(v1, conversations), 1, "the usage snapshot reads a schema-1 store");
    assert.deepEqual(fs.readFileSync(v1), bytes, "and neither changes it");
    assert.equal(version(v1), 1);
    // The Harness's open migrates it and the conversation goes on.
    {
      const storage = await openStorage(v1);
      const harness = await Harness.open(storage, { models, registry: createRegistry() }, context);
      const conversation = (await harness.conversation(ROOT_CONVERSATION_ID, context))!;
      harness.resume();
      assert.equal((await turn(conversation, "s2")).status, "done", "a migrated store's conversation goes on");
      assert.deepEqual((await answers(conversation)).slice(-2), ["reply to s1", "reply to s2"]);
      await harness.close(context);
    }
    assert.equal(version(v1), 2, "opening migrates it to 2");
    assert.ok(JSON.stringify(await readPiHistory(v1, null, null, {})).includes("reply to s2"), "the history reader pages schema 2");
    assert.equal(await readStorage(v1, conversations), 1, "so does the usage snapshot");
    // A newer schema than this Pi knows is refused by both readers.
    const v3 = path.join(root, "v3.sqlite");
    fs.copyFileSync(v1, v3);
    { const database = new DatabaseSync(v3); database.exec("UPDATE durable_schema SET version = 3"); database.close(); }
    await assert.rejects(readPiHistory(v3, null, null, {}), /schema version 3/);
    await assert.rejects(readStorage(v3, async () => "read"), /schema version 3/);
    sends.length = 0;
    console.log("ok: Pi 1.4.0 migrates a schema-1 store to 2 on open; cube's readers take 1 and 2 without migrating, and refuse 3");
  }

  {
    // checkpointWhen is required since 1.4.0. Cube's documents say
    // `() => false`, 1.3.0's default when it was absent: every change a
    // delta, never a base.
    const Doc = defineDoc<{ n: number }>({ kind: "cube.test.counter", version: 1, scope: "session", checkpointWhen: () => false, initial: () => ({ n: 0 }) });
    let { harness } = await open();
    await harness.commit(async tx => { (await tx.doc(Doc)).n += 41; return undefined; }, context);
    await harness.commit(async tx => { (await tx.doc(Doc)).n += 1; return undefined; }, context);
    await harness.close(context);
    ({ harness } = await open());
    assert.equal((await harness.snapshot(Doc, context))?.n, 42, "a document with checkpointWhen () => false commits and reads back after a reopen");
    await harness.close(context);
    console.log("ok: documents with checkpointWhen () => false commit and survive a reopen");
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
    // The fail-closed primitive OptChat's beforeRequest uses: abortTask on
    // its own generation, then the throw once aborted. Nothing is sent, the
    // turn ends unanswered, nothing is reported (it is no hook failure Pi
    // skipped), and neither a later turn nor a reopen sends it.
    let { harness, conversation } = await open();
    mode = "refuse";
    reports.length = 0;
    const settled = await turn(conversation, "r1");
    assert.equal(settled.status, "unanswered", "the turn ends unanswered");
    assert.equal(sent("r1"), 0, "a refused request is not sent");
    assert.deepEqual(reports, [], "and the throw is not skipped and reported");
    mode = "pass";
    assert.equal((await turn(conversation, "r2")).status, "done");
    assert.equal(sent("r1"), 0, "nor sent with the next turn");
    await harness.close(context);
    ({ harness, conversation } = await open());
    await conversation.waitForIdle(context);
    await delay(200);
    assert.equal(sent("r1"), 0, "nor after a reopen");
    await harness.close(context);
    console.log("ok: abortTask then throw in beforeRequest fails closed: nothing sent, now or after a reopen");
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

    // Its hook's throw is reported to cubed's log, one redacted line without
    // a stack; and a failed Session takes it down at once: no retry, its
    // provider sessions released before any close, the failure shown.
    const SECRET = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
    let throwing = true;
    const extension = defineExtension({ name: "agent-test", hooks: [hook(GenerationTask, { beforeRequest: () => {
      if (throwing) throw new Error(`hook failed: Authorization: Bearer abcdefghijklmnop ${SECRET}`);
      return undefined;
    } })] });
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => { lines.push(String(chunk)); return (write as (...args: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stdout.write;
    const released2: string[] = [];
    const unregister2 = registerSessionResourceCleanup(id => { if (id) released2.push(id); });
    try {
      const agent = await openAgent({ directory: path.join(root, "agent2", "thread"), binding: guest.binding, workspace: new VmWorkspace({ guest, leases: new LeaseStore(path.join(root, "agent2", "thread")), owner: "pi", binding: guest.binding }),
        models, model: { provider: model.provider, id: model.modelId }, extensions: [extension] });
      assert.equal((await turn(agent.conversation, "t2")).status, "done");
      const report = lines.find(line => line.startsWith("warn pi pi reported an error"));
      assert.ok(report, "the hook's throw is logged");
      assert.match(report, /thread=thread /);
      assert.match(report, / report=extension_error /, "with what Pi says it is about");
      assert.ok(!report.includes(SECRET) && !report.includes("abcdefghijklmnop") && !report.includes("stack="), "redacted, without a stack");
      throwing = false;
      assert.equal(agent.failure(), null);
      const storage = agent.storage as unknown as { commit: (...args: unknown[]) => Promise<unknown> };
      const commit = storage.commit.bind(storage);
      let broken = false;
      storage.commit = (...args) => broken ? Promise.reject(new Error(`disk I/O error (test) ${SECRET}`)) : commit(...args);
      onSend = user => { if (user === "t3") broken = true; };
      const submission = await agent.conversation.submit({ type: "input", content: "t3", requestId: "t3" }, context);
      assert.equal((await agent.harness.closed).reason, "failed");
      await submission.wait(context).catch(() => {});
      await until(() => agent.failure() !== null, "the agent shown down");
      onSend = () => {};
      const id = sends.find(send => send.user === "t3")!.session;
      assert.ok(released2.includes(id!), "its provider session is released at the failure, before any close");
      await delay(200);
      assert.equal(sent("t3"), 1, "no retry is sent in the failed process");
      await assert.rejects(agent.conversation.submit({ type: "input", content: "t4", requestId: "t4" }, context));
      assert.equal(sent("t4"), 0);
      assert.match(agent.failure()!, /^the thread's agent stopped: its history could not be saved/);
      assert.ok(!agent.failure()!.includes(SECRET));
      assert.ok(lines.some(line => line.startsWith("error pi thread session failed")), "the failure is logged");
      assert.ok(!lines.join("").includes(SECRET), "nowhere with the secret");
      await agent.close();
    } finally { process.stdout.write = write; unregister2(); }
    console.log("ok: a thread agent logs Pi's reports redacted, and a failed Session takes it down with no retry");
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
