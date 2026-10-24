/** OptChat's reports and its threads' machines through a cubed restart, over
 * real stores: createCubed, Conversations, Pi's and Claude Code's thread
 * stores, OptChat's own store, cubeThreads, on local guests (the real guest
 * helper under temporary roots) whose starts and guest calls are counted.
 * Offline and disposable; Claude Code is the fake CLI (fake-claude.ts).
 *
 *   Before the restart: a Pi thread (Q) settles and reports while watched.
 *   A Pi thread (H) and a Claude Code thread (C) settle while the chat is
 *   closed, so their reports never go out. The idle round suspends all
 *   three (recorded as RunnerMachines records it) and cubed stops.
 *
 *   After it: many watch rounds and a recovery round start no machine, call
 *   no guest and open no agent; H's and C's stored runs report once, Q's
 *   not again. A message to H and to C wakes each (one start), the watcher
 *   follows the live agent, the earlier run is not reported again and the
 *   new one reports once.
 *
 * Real berth suspend and wake run in runner-vm-cubed-suspend-test.ts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { CLAUDE_PROVIDER } from "../src/claude-agent.ts";
import { createCubed } from "../src/index.ts";
import { OptChat } from "../src/optchat.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import type { Thread } from "../src/registry.ts";
import type { StartOptions } from "../src/vm.ts";
import { LocalMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-restart-"));
const state = path.join(root, "state");
const chatDirectory = path.join(root, "optchat");
const claudeGate = path.join(root, "claude-may-finish");
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
const blocks = (message: Message) => typeof message.content === "string" ? [message.content]
  : message.content.map(part => part.type === "text" ? part.text : "");

let releasePi!: () => void;
const piHeld = new Promise<void>(resolve => { releasePi = resolve; });
/** Every "[id] " report line the chat's model was given, in order. */
const reports: string[] = [];
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 300 }, () => async (request: { messages: Message[] }) => {
  const system = request.messages.find(message => message.role === "system");
  if (system && textOf(system).includes("You write the memory of OptChat")) return fauxAssistantMessage("summary");
  const all = JSON.stringify(request.messages);
  if (all.includes("<chat>") || all.includes("SPAWN_THREE")) {
    if (request.messages.at(-1)?.role !== "user") return fauxAssistantMessage("noted");
    const taken = request.messages.filter(message => message.role === "user").flatMap(blocks).filter(part => !part.includes("<chat>"));
    for (const part of taken) for (const line of part.split("\n")) if (/^\[[0-9a-f]{8}\] /.test(line)) reports.push(line);
    if (taken.some(part => part.includes("SPAWN_THREE"))) {
      return fauxAssistantMessage([fauxToolCall("spawn", { tasks: ["PI_QUICK", "PI_HELD", "CLAUDE_HELD"].map(task => ({ project: "p", task })) }, { id: "call-spawn" })],
        { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("noted");
  }
  if (all.includes("PI_GO_ON")) return fauxAssistantMessage("pi went on");
  if (all.includes("PI_HELD")) { await piHeld; return fauxAssistantMessage("pi held done"); }
  return fauxAssistantMessage("pi quick done");
}));
const models = createModels();
models.setProvider(faux.provider);
const piModel = { provider: faux.getModel().provider, id: faux.getModel().id };
const claudeModel = { provider: CLAUDE_PROVIDER, id: "fable" };

/** Local machines that count starts and guest calls by thread. A start of
 * a suspended machine clears its suspension, as a resume does
 * (runner-machines.ts `resumed`). */
class CountedMachines extends LocalMachines {
  readonly startsOf = new Map<string, number>();
  readonly callsOf = new Map<string, number>();
  override async start(thread: Thread, options: StartOptions = {}): Promise<{ booted: boolean }> {
    this.startsOf.set(thread.id, (this.startsOf.get(thread.id) ?? 0) + 1);
    const started = await super.start(thread, options);
    if (thread.vm?.suspension) this.onResume?.(thread.id);
    return started;
  }
  onResume: ((id: string) => void) | null = null;
  override guest(thread: Thread): ReturnType<LocalMachines["guest"]> {
    const target = super.guest(thread);
    const calls = this.callsOf;
    return new Proxy(target, {
      get(object, key, receiver) {
        const value = Reflect.get(object, key, receiver) as unknown;
        if (typeof value !== "function" || key === "close") return value;
        return (...args: unknown[]) => { calls.set(thread.id, (calls.get(thread.id) ?? 0) + 1); return (value as (...a: unknown[]) => unknown).apply(object, args); };
      },
    });
  }
}

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  for (const deadline = Date.now() + ms; !(await check());) {
    assert.ok(Date.now() < deadline, what);
    await delay(25);
  }
}
const reportsOf = (id: string) => reports.filter(line => line.startsWith(`[${id.slice(0, 8)}] `));

const runnerOf: Record<string, string> = { PI_QUICK: "a", PI_HELD: "b", CLAUDE_HELD: "c" };
async function open(machines: CountedMachines) {
  const app = await createCubed({ state, models, machines, claude: [process.execPath, path.resolve(import.meta.dirname, "fake-claude.ts")],
    claudeOptions: { stopGraceMs: 2000 }, gateway: null });
  const threads = {
    ...cubeThreads({ registry: app.registry, conversations: app.conversations, catalog: async () => [piModel], runners: () => ({ runners: [] }) as never,
      latestCommits: async () => ({}) as never }),
    // A spawn as cubeThreads makes one, on a runner of its own (one slot each).
    async spawn(task: { task: string }, requestId: string) {
      const claude = task.task === "CLAUDE_HELD";
      const text = claude ? `run while [ ! -e ${claudeGate} ]; do sleep 0.05; done\nsay claude held done` : task.task;
      const thread = app.registry.threadByRequest("p", requestId)
        ?? app.registry.createThread("p", requestId, claude ? claudeModel : piModel, text, claude ? "claude-code" : "pi", undefined, { runnerId: runnerOf[task.task]! });
      app.registry.renameThread(thread.id, task.task);
      void app.conversations.activate(thread.id);
      return { id: thread.id, title: task.task };
    },
  };
  const chat = await OptChat.open({ directory: chatDirectory, models, model: async () => piModel, threads, limits: { node: 64, retryMs: 50, watchMs: 50 } });
  return { app, chat, threads };
}

const machinesRoot = path.join(root, "machines");
const before = new CountedMachines(machinesRoot);
let { app, chat } = await open(before);
let Q = "", H = "", C = "";
try {
  for (const runner of ["a", "b", "c"]) {
    app.registry.enrollRunner({ nodeId: `node-${runner}`, threadId: runner, environmentId: 1, configPath: `/private/${runner}.json`, configHash: runner, protocol: 4, kind: "vm" });
  }
  app.registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  await chat.send("SPAWN_THREE", "u1");
  await until(() => app.registry.listThreads().length === 3, "the chat spawns three threads");
  const byTitle = (title: string) => app.registry.listThreads().find(thread => thread.title === title)!.id;
  [Q, H, C] = [byTitle("PI_QUICK"), byTitle("PI_HELD"), byTitle("CLAUDE_HELD")];
  await until(() => reportsOf(Q).length === 1, "Q settles and reports while watched");
  assert.match(reportsOf(Q)[0]!, /pi quick done/);
  await until(async () => (await app.conversations.storedHistory(C, { limit: 1 }))?.status.state === "working", "C's run is under way");
  assert.deepEqual([reportsOf(H).length, reportsOf(C).length], [0, 0], "H and C have not settled yet");
} finally { await chat.close(); }

try {
  releasePi();
  fs.writeFileSync(claudeGate, "");
  const settledRun = async (id: string) => {
    const status = (await app.conversations.storedHistory(id, { limit: 1 }))?.status;
    return status?.state === "completed" ? status.run : null;
  };
  await until(async () => !!(await settledRun(H)) && !!(await settledRun(C)), "H and C settle while the chat is closed");
  // The live feed names the run as the store does: the report's request id
  // (report:<thread>:<run>) is one id for both.
  for (const id of [H, C]) assert.equal((await app.conversations.history(id)).status.run, await settledRun(id), "live and stored run ids agree");
  for (const id of [Q, H, C]) app.registry.applySleep(id, { type: "suspended", at: Date.now() });
} finally { await app.close(); }
assert.deepEqual([Q, H, C].map(id => reportsOf(id).length), [1, 0, 0], "before the restart only Q reported");

const after = new CountedMachines(machinesRoot);
({ app, chat } = await open(after));
after.onResume = id => { app.registry.applySleep(id, { type: "running" }); };
const threads = cubeThreads({ registry: app.registry, conversations: app.conversations, catalog: async () => [piModel], runners: () => ({ runners: [] }) as never,
  latestCommits: async () => ({}) as never });
try {
  await until(() => reportsOf(H).length === 1 && reportsOf(C).length === 1, "H's and C's stored runs report after the restart");
  await delay(1500);
  await app.conversations.recover();
  await delay(300);
  const counts = (id: string) => [after.startsOf.get(id) ?? 0, after.callsOf.get(id) ?? 0, app.conversations.agentOpen(id)];
  assert.deepEqual([Q, H, C].map(counts), [[0, 0, false], [0, 0, false], [0, 0, false]],
    "suspended threads through a restart, ~30 watch rounds and a recovery round: no start, no guest call, no agent");
  assert.deepEqual([Q, H, C].map(id => reportsOf(id).length), [1, 1, 1], "each settled run reported once: Q not again, H and C from their stores");
  assert.match(reportsOf(H)[0]!, /pi held done/);
  assert.match(reportsOf(C)[0]!, /ended its turn; nothing of it runs now: done with fable/, "the fake CLI ends each turn with its own line");
  assert.match(await threads.describe([Q, H, C]), /PI_QUICK · its machine is suspended \(idle; it wakes when told\), completed\n.*PI_HELD · its machine is suspended.*, completed\n.*CLAUDE_HELD · its machine is suspended.*, completed$/);

  // Explicit work still starts: a message wakes its thread, once.
  await threads.tell(H, "PI_GO_ON", "tell-h");
  await threads.tell(C, "say claude went on", "tell-c");
  assert.deepEqual([after.startsOf.get(H), after.startsOf.get(C)], [1, 1], "a message starts its thread's machine once");
  await until(() => reportsOf(H).length === 2 && reportsOf(C).length === 2, "the woken threads' new runs report");
  await delay(1000);
  assert.deepEqual([Q, H, C].map(id => reportsOf(id).length), [1, 2, 2], "the live feed does not report the stored run again; the new run once");
  assert.match(reportsOf(H)[1]!, /pi went on/);
  assert.match(reportsOf(C)[1]!, /done with fable/);
  assert.deepEqual([after.startsOf.get(Q) ?? 0, after.startsOf.get(H), after.startsOf.get(C)], [0, 1, 1], "the watcher started nothing of its own");
} finally {
  await chat.close();
  await app.close();
  await before.close();
  await after.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("ok: through a cubed restart over real Pi and Claude Code stores: suspended threads get no start, guest call or agent from OptChat; stored runs report once, live and stored once together; a message wakes its thread once");
