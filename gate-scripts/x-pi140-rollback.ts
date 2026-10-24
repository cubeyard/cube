/** #237, option A: Pi 1.4.0's one-way store migration and what a rollback
 * does, over real cubed stores (createCubed, Conversations, OptChat, a Pi
 * thread's store) on a local guest with a faux model. Not part of the
 * repository: copy it to packages/server/test/ of a checkout and run one
 * phase from there; every phase works on the same <root>.
 *
 *   old-write  (a Pi 1.3.0 tree)  OptChat answers HELLO_1, a Pi thread runs ONE
 *   new        (a Pi 1.4.0 tree)  both stores move to schema 2; the history
 *                                 is all there; HELLO_2 and TWO go on
 *   old-again  (the 1.3.0 tree)   cubed starts, OptChat does not open, the
 *                                 thread's transcript is refused, its agent
 *                                 does not open; nothing is written
 *   new-again  (the 1.4.0 tree)   everything is readable again; HELLO_3 and
 *                                 THREE go on after the earlier runs
 *
 *   node test/x-pi140-rollback.ts <phase> <root> */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { OptChat } from "../src/optchat.ts";
import { LocalMachines } from "./local-guest.ts";

const [phase, root] = process.argv.slice(2);
assert.ok(phase && root, "<phase> <root>");
const state = path.join(root, "state");
const chatDirectory = path.join(root, "optchat");
const chatStore = path.join(chatDirectory, "pi.sqlite");
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");

const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 100 }, () => async (request: { messages: Message[] }) => {
  const system = request.messages.find(message => message.role === "system");
  if (system && textOf(system).includes("You write the memory of OptChat")) return fauxAssistantMessage("summary");
  const last = textOf(request.messages.filter(message => message.role === "user").at(-1)!);
  // The newest message is the last word asked (OptChat's view repeats earlier ones).
  const word = [...last.matchAll(/\b(HELLO_\d|ONE|TWO|THREE)\b/g)].filter(match => !last.slice(Math.max(0, match.index - 10), match.index).includes("answer to")).at(-1)?.[1] ?? "other";
  return fauxAssistantMessage(`answer to ${word}`);
}));
const models = createModels();
models.setProvider(faux.provider);
const piModel = { provider: faux.getModel().provider, id: faux.getModel().id };

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  for (const deadline = Date.now() + ms; !(await check());) {
    assert.ok(Date.now() < deadline, what);
    await delay(25);
  }
}
const schema = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return (db.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get() as { version: number }).version; } finally { db.close(); }
};
// An empty WAL (left by a clean close, removed by the next one) holds nothing.
const digest = (file: string) => fs.existsSync(file) && fs.statSync(file).size > 0 ? createHash("sha256").update(fs.readFileSync(file)).digest("hex").slice(0, 16) : "empty";
const files = (name: string, store: string) => Object.fromEntries(["", "-wal"].map(suffix => [`${name}${suffix}`, digest(store + suffix)]));

const machines = new LocalMachines(path.join(root, "machines"));
const app = await createCubed({ state, models, machines, claude: null, gateway: null } as never);
const threadStore = (id: string) => path.join(state, "threads", id, "pi.sqlite");
const openChat = () => OptChat.open({ directory: chatDirectory, models, model: async () => piModel, threads: {} as never, limits: { node: 64, retryMs: 50, watchMs: 50 } });
const said = (chat: OptChat) => chat.memory.render();
const runs = async (id: string) => app.conversations.storedHistory(id, {});
/** The live transcript while the agent is open, else the stored one. */
const transcript = async (id: string) => app.conversations.agentOpen(id) ? app.conversations.history(id) : runs(id);
const answered = async (id: string, word: string) => JSON.stringify(await transcript(id)).includes(`answer to ${word}`);
const thread = () => app.registry.listThreads()[0];

try {
  if (phase === "old-write") {
    app.registry.enrollRunner({ nodeId: "node-a", threadId: "a", environmentId: 1, configPath: "/private/a.json", configHash: "a", protocol: 4, kind: "vm" });
    app.registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
    const created = app.registry.createThread("p", "r1", piModel, "ONE", "pi", undefined, { runnerId: "a" });
    void app.conversations.activate(created.id);
    const chat = await openChat();
    try {
      await chat.send("HELLO_1", "u1");
      await until(() => said(chat).includes("answer to HELLO_1"), "OptChat answers HELLO_1");
    } finally { await chat.close(); }
    await until(() => answered(created.id, "ONE"), "the thread answers ONE");
    console.log(`old-write: schemas chat ${schema(chatStore)}, thread ${schema(threadStore(created.id))}`);
  } else if (phase === "new" || phase === "new-again") {
    const id = thread()!.id;
    const n = phase === "new" ? 2 : 3;
    const word = phase === "new" ? "TWO" : "THREE";
    const chat = await openChat();
    try {
      assert.equal(schema(chatStore), 2, "OptChat's store is at schema 2 once opened");
      for (let k = 1; k < n; k++) assert.ok(said(chat).includes(`answer to HELLO_${k}`), `OptChat still has HELLO_${k}`);
      await chat.send(`HELLO_${n}`, `u${n}`);
      await until(() => said(chat).includes(`answer to HELLO_${n}`), `OptChat answers HELLO_${n}`);
    } finally { await chat.close(); }
    for (const earlier of phase === "new" ? ["ONE"] : ["ONE", "TWO"]) assert.ok(await answered(id, earlier), `the thread's transcript still has ${earlier}`);
    void app.conversations.activate(id);
    await until(() => app.conversations.agentOpen(id), "the thread's agent opens");
    await app.conversations.submit(id, word, `t-${word}`);
    await until(() => answered(id, word), `the thread answers ${word}`);
    assert.equal(schema(threadStore(id)), 2, "the thread's store is at schema 2");
    console.log(`${phase}: schemas chat ${schema(chatStore)}, thread ${schema(threadStore(id))}; OptChat and the thread go on after their earlier runs`);
  } else if (phase === "old-again") {
    const id = thread()!.id;
    // Closed cleanly by the 1.4.0 phase: no WAL content to lose or replay.
    const before = { ...files("chat", chatStore), ...files("thread", threadStore(id)) };
    const chatError = await openChat().then(async chat => { await chat.close(); return null; }, (error: unknown) => (error as Error).message);
    console.log(`old-again: OptChat open: ${chatError ?? "OPENED"}`);
    assert.match(chatError ?? "", /schema version 2/, "1.3.0's OptChat refuses the migrated store");
    const historyError = await runs(id).then(() => null, (error: unknown) => (error as Error).message);
    console.log(`old-again: thread transcript: ${historyError ?? "READ"}`);
    assert.match(historyError ?? "", /schema version 2/, "1.3.0's history reader refuses the migrated store");
    await app.conversations.activate(id).catch(() => {});
    await delay(3000);
    console.log(`old-again: thread agent open: ${app.conversations.agentOpen(id)}; error: ${app.conversations.error(id) ?? "none"}`);
    assert.equal(app.conversations.agentOpen(id), false, "1.3.0 opens no agent on the migrated store");
    await app.close();
    const after = { ...files("chat", chatStore), ...files("thread", threadStore(id)) };
    console.log(`old-again: store files before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
    assert.deepEqual(after, before, "the refused stores are not written");
    assert.deepEqual([schema(chatStore), schema(threadStore(id))], [2, 2]);
  } else throw new Error(`unknown phase ${phase}`);
} finally {
  await app.close().catch(() => {});
  await machines.close();
}
console.log(`ok: ${phase}`);
