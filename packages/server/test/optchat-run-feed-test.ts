/** OptChat follows its threads' runs by their run feeds (I-5b,
 * `Conversations.onRunFeed`), not by polling, over real stores: createCubed,
 * Conversations, Pi's and Claude Code's thread stores (the fake CLI,
 * fake-claude.ts), cubeThreads and OptChat's own store, on local guests.
 * Offline and disposable.
 *
 *   F1  a Pi and a Claude Code thread the chat started report their runs
 *       once, live; a thread whose agent is not open is read once when the
 *       chat attaches it and not again while its feed stays closed; its
 *       feed's opening attaches it, and its run reports once;
 *   F2  a run that settles and whose thread is archived at once reports
 *       once;
 *   F3  runs that settle while the chat is closed (cubed runs on) report
 *       once when it opens again, the earlier ones not again;
 *   F4  a report the chat could not take is sent again, once. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { CLAUDE_PROVIDER } from "../src/claude-agent.ts";
import { createCubed } from "../src/index.ts";
import { OptChat, type OptThreads } from "../src/optchat.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import { LocalMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-run-feed-"));
const gates = path.join(root, "gates");
fs.mkdirSync(gates);
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
const blocks = (message: Message) => typeof message.content === "string" ? [message.content]
  : message.content.map(part => part.type === "text" ? part.text : "");
/** Every "[id] " report line the chat's model was given, in order. */
const reports: string[] = [];
const held = new Map<string, () => void>();
const hold = (name: string) => new Promise<void>(resolve => { held.set(name, resolve); });
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 400 }, () => async (request: { messages: Message[] }) => {
  const system = request.messages.find(message => message.role === "system");
  if (system && textOf(system).includes("You write the memory of OptChat")) return fauxAssistantMessage("summary");
  const all = JSON.stringify(request.messages);
  if (all.includes("<chat>") || all.includes("SPAWN ")) {
    if (request.messages.at(-1)?.role !== "user") return fauxAssistantMessage("noted");
    const taken = request.messages.filter(message => message.role === "user").flatMap(blocks).filter(part => !part.includes("<chat>"));
    for (const part of taken) for (const line of part.split("\n")) if (/^\[[0-9a-f]{8}\] /.test(line)) reports.push(line);
    const spawn = taken.map(part => /^SPAWN (.+)$/m.exec(part)?.[1]).find(Boolean);
    if (spawn) {
      return fauxAssistantMessage([fauxToolCall("spawn", { tasks: spawn.split(" ").map(task => ({ project: "p", task })) }, { id: `call-${spawn}` })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("noted");
  }
  const task = /PI_[A-Z]+/.exec(all)?.[0] ?? "PI";
  if (task.endsWith("HELD")) await hold(task);
  return fauxAssistantMessage(`${task.toLowerCase()} done`);
}));
const models = createModels();
models.setProvider(faux.provider);
const piModel = { provider: faux.getModel().provider, id: faux.getModel().id };
const claudeModel = { provider: CLAUDE_PROVIDER, id: "fable" };

const app = await createCubed({ state: path.join(root, "state"), models, machines: new LocalMachines(path.join(root, "machines")),
  claude: [process.execPath, path.resolve(import.meta.dirname, "fake-claude.ts")], claudeOptions: { stopGraceMs: 2000 }, gateway: null });
app.registry.enrollRunner({ nodeId: "node-r", threadId: "r", environmentId: 1, configPath: "/private/r.json", configHash: "r", maxActiveVms: 20, protocol: 4, kind: "vm" } as never);
app.registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
/** A thread's events() asks, by thread: a closed feed is not polled. */
const asked = new Map<string, number>();
/** Tasks spawned without a start: their agent opens only when the test says. */
const later = new Set<string>();
const base = cubeThreads({ registry: app.registry, conversations: app.conversations, catalog: () => [piModel], runners: () => ({ runners: [] }) as never });
const threads: OptThreads = {
  ...base,
  async events(id) { asked.set(id, (asked.get(id) ?? 0) + 1); return base.events(id); },
  // A spawn as cubeThreads makes one; CLAUDE_* runs on the fake CLI.
  async spawn(task: { task: string }, requestId: string) {
    const claude = task.task.startsWith("CLAUDE_");
    const text = claude ? (task.task.endsWith("HELD") ? `run while [ ! -e ${path.join(gates, task.task)} ]; do sleep 0.05; done\nsay ${task.task.toLowerCase()} done` : `say ${task.task.toLowerCase()} done`) : task.task;
    const thread = app.registry.threadByRequest("p", requestId)
      ?? app.registry.createThread("p", requestId, claude ? claudeModel : piModel, text, claude ? "claude-code" : "pi", { runnerId: "r" });
    app.registry.renameThread(thread.id, task.task);
    if (!later.has(task.task)) void app.conversations.activate(thread.id);
    return { id: thread.id, title: task.task };
  },
};
const chatDirectory = path.join(root, "optchat");
const open = () => OptChat.open({ directory: chatDirectory, models, model: async () => piModel, threads, limits: { node: 64, retryMs: 50, watchMs: 50 } });
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  for (const deadline = Date.now() + ms; !(await check());) {
    assert.ok(Date.now() < deadline, what);
    await delay(25);
  }
}
const byTitle = (title: string) => app.registry.listThreads().find(thread => thread.title === title)?.id ?? "";
const reportsOf = (id: string) => reports.filter(line => line.startsWith(`[${id.slice(0, 8)}] `));
const settled = async (id: string) => (await app.conversations.storedHistory(id, { limit: 1 }))?.status.state === "completed";

let chat = await open();
try {
  // ---------------------------------------------------------------- F1
  later.add("PI_LATER");
  await chat.send("SPAWN PI_QUICK CLAUDE_QUICK PI_LATER", "u1");
  await until(() => !!byTitle("PI_QUICK") && !!byTitle("CLAUDE_QUICK") && !!byTitle("PI_LATER"), "the chat spawns three threads");
  const [piQuick, claudeQuick, piLater] = ["PI_QUICK", "CLAUDE_QUICK", "PI_LATER"].map(byTitle) as [string, string, string];
  await until(() => reportsOf(piQuick).length === 1 && reportsOf(claudeQuick).length === 1, "the Pi and the Claude Code thread report their runs live");
  assert.match(reportsOf(piQuick)[0]!, /pi_quick done/);
  assert.match(reportsOf(claudeQuick)[0]!, /ended its turn; nothing of it runs now: done with fable/, "the fake CLI ends each turn with its own line");
  await until(() => (asked.get(piLater) ?? 0) >= 1, "the chat attaches the thread whose agent is not open");
  const before = asked.get(piLater);
  await delay(600);
  assert.equal(asked.get(piLater), before, "its closed feed is not polled (12 rounds)");
  assert.equal(app.conversations.agentOpen(piLater), false);
  await app.conversations.activate(piLater);
  await until(() => reportsOf(piLater).length === 1, "its feed's opening attaches it: its run reports");
  await delay(400);
  assert.deepEqual([piQuick, claudeQuick, piLater].map(id => reportsOf(id).length), [1, 1, 1], "each run once");
  console.log("ok: F1 a Pi and a Claude Code thread report live once; a thread with no agent open is read once, not polled; its feed's opening attaches it");

  // ---------------------------------------------------------------- F2
  await chat.send("SPAWN PI_RACE", "u2");
  await until(() => !!byTitle("PI_RACE"), "the chat spawns it");
  const race = byTitle("PI_RACE");
  await until(() => settled(race), "its run settles");
  await app.conversations.archive(race);
  await until(() => reportsOf(race).length === 1, "the run of a thread archived as it settled reports");
  await delay(400);
  assert.equal(reportsOf(race).length, 1, "once");
  console.log("ok: F2 a run that settles and whose thread is archived at once reports once");

  // ---------------------------------------------------------------- F3
  await chat.send("SPAWN PI_HELD CLAUDE_HELD", "u3");
  await until(() => !!byTitle("PI_HELD") && !!byTitle("CLAUDE_HELD"), "the chat spawns them");
  const [piHeld, claudeHeld] = ["PI_HELD", "CLAUDE_HELD"].map(byTitle) as [string, string];
  await until(() => held.has("PI_HELD"), "the Pi run is under way");
  await until(async () => (await app.conversations.storedHistory(claudeHeld, { limit: 1 }))?.status.state === "working", "the Claude Code run is under way");
  await chat.close();
  held.get("PI_HELD")!();
  fs.writeFileSync(path.join(gates, "CLAUDE_HELD"), "");
  await until(async () => await settled(piHeld) && await settled(claudeHeld), "both settle while the chat is closed");
  assert.deepEqual([reportsOf(piHeld).length, reportsOf(claudeHeld).length], [0, 0]);
  chat = await open();
  await until(() => reportsOf(piHeld).length === 1 && reportsOf(claudeHeld).length === 1, "the reopened chat reports both");
  await delay(600);
  assert.deepEqual([piQuick, claudeQuick, piLater, race, piHeld, claudeHeld].map(id => reportsOf(id).length), [1, 1, 1, 1, 1, 1], "the earlier runs not again");
  console.log("ok: F3 runs that settled while the chat was closed report once at its reopen; earlier ones not again");

  // ---------------------------------------------------------------- F4
  const send = chat.send.bind(chat);
  let refused = 0;
  await chat.send("SPAWN PI_RETRY", "u4");
  await until(() => !!byTitle("PI_RETRY"), "the chat spawns it");
  const retry = byTitle("PI_RETRY");
  chat.send = async (text, requestId, images) => {
    if (requestId.startsWith(`report:${retry}:`) && refused++ === 0) throw new Error("the chat's store is busy");
    return send(text, requestId, images);
  };
  await until(() => reportsOf(retry).length === 1, "a report whose send failed is sent again");
  await delay(400);
  assert.deepEqual([refused >= 2, reportsOf(retry).length], [true, 1], "once");
  console.log("ok: F4 a report the chat could not take is sent again, once");
} finally {
  await chat.close().catch(() => {});
  for (const resolve of held.values()) resolve();
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
}
