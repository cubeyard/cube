/** OptChat's reads of its threads cannot start anything, and its reports are
 * not lost; offline and disposable.
 *
 *   1. readThreads (the watcher's `events`, `threads`, `history`, the
 *      overview) gets a ThreadReader: TypeScript refuses `activate`,
 *      `events`, `history`, `agent`, `submit` and `workspace` on it, and over
 *      the real Conversations behind a proxy that records every member read,
 *      reading threads in every state (asleep, waking, awake with its agent
 *      closed or open, failed, starting, archived) touches only the
 *      reader's members, starts no machine and calls no guest.
 *   2. Reports, over OptChat with stand-in threads: a run that settled while
 *      its agent was closed and whose thread was archived before the next
 *      round reports once (L1); a report the chat could not take (its send
 *      failed) is sent again in a later round, once (L2). */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Conversations, type ThreadReader } from "../src/conversation.ts";
import { OptChat, type OptThreads, type ThreadRecord } from "../src/optchat.ts";
import { readThreads } from "../src/optchat-threads.ts";
import type { Registry, Thread } from "../src/registry.ts";
import type { ThreadStatus } from "../src/thread-events.ts";
import type { HistoryPage } from "../src/thread-history.ts";
import { NoMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-reports-"));
const faux = fauxProvider({ tokensPerSecond: 100_000 });
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, id: faux.getModel().id };
const READER = ["live", "storedHistory", "agentOpen", "condition", "owner"];

// ------------------------------------------------ 1. a reader can only read
{
  type Sleep = NonNullable<NonNullable<Thread["vm"]>["suspension"]>;
  const thread = (n: number, extra: Partial<Thread> = {}, suspension?: Sleep) => ({
    id: `c0c0c0c${n}-0000-4000-8000-00000000000${n}`, title: `t${n}`, archived: false, workspaceState: "available", workspaceError: null, runnerId: "r", projectId: "p",
    agent: "pi", model, allocation: { repositories: [], skills: null, hooks: null },
    vm: { vmId: `${n}`.padEnd(16, "0"), placeholders: {}, ...suspension ? { suspension } : {} }, ...extra,
  }) as unknown as Thread;
  const threads = [thread(1, {}, { state: "suspended", at: 1 }), thread(2, {}, { state: "waking", at: 1, waiting: "waiting for a free slot" }),
    thread(3), thread(4), thread(5, { workspaceState: "failed", workspaceError: "workspace allocation failed: boom" }),
    thread(6, { workspaceState: "allocating" }), thread(7, { archived: true })];
  const registry = {
    listThreads: () => threads, getThread: (id: string) => threads.find(t => t.id === id) ?? null, getProject: () => ({ id: "p", name: "cube" }),
    interruptStartupSteps: () => {}, initialPrompt: () => null, runner: () => ({ nodeId: "node", environmentId: 1, configHash: "config" }),
  } as unknown as Registry;
  const machines = new NoMachines();
  const { starts, calls: guests } = machines;
  const conversations = new Conversations({ registry, directory: path.join(root, "threads"), models, machines });
  // Thread 4's agent is open (the UI read it): a reader may watch its events.
  await conversations.events(threads[3]!.id);
  const open = threads.map(t => conversations.agentOpen(t.id));
  starts.length = 0; guests.length = 0;

  const reader: ThreadReader = conversations;
  // @ts-expect-error a reader cannot activate a thread
  void reader.activate;
  // @ts-expect-error nor open its agent's events
  void reader.events;
  // @ts-expect-error nor read its history through the agent
  void reader.history;
  // @ts-expect-error nor open its agent
  void reader.agent;
  // @ts-expect-error nor send it a message
  void reader.submit;
  // @ts-expect-error nor reach its machine
  void reader.workspace;

  const touched = new Set<string>();
  const recorded = new Proxy(conversations, {
    get(target, member, receiver) {
      if (typeof member === "string") touched.add(member);
      const value = Reflect.get(target, member, receiver) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  }) as ThreadReader;
  const reads = readThreads({ registry, conversations: recorded });
  const ids = threads.map(t => t.id);
  await reads.describe(ids);
  await reads.observe!(ids);
  await reads.observe!(ids, { archivedRuns: true });
  for (const id of ids) {
    await reads.history(id);
    await reads.events(id).catch(() => null);
  }
  assert.deepEqual([...touched].filter(member => !READER.includes(member)).sort(), [], "only the reader's members were read");
  assert.ok(touched.has("live") && touched.has("storedHistory"), "and they were read");
  assert.deepEqual([starts, guests], [[], []], "nothing started, no guest called");
  assert.deepEqual(threads.map(t => conversations.agentOpen(t.id)), open, "no agent opened");
  assert.equal(typeof (await reads.events(threads[3]!.id)), "object", "the open agent's events are watched");
  assert.equal(await reads.events(threads[2]!.id), "stored", "an awake thread whose agent is closed is read from its store");
  await conversations.close(500);
  console.log("ok: readThreads gets a ThreadReader: TypeScript refuses activate, events, history, agent, submit and workspace; reading threads in every state reads only the reader's members, starts nothing, calls no guest and opens no agent");
}

// ------------------------------------------------ 2. reports are not lost
{
  const ids = ["d1d1d1d1-0000-4000-8000-000000000001", "d2d2d2d2-0000-4000-8000-000000000002"];
  const [A, B] = ids as [string, string];
  const stored = new Map<string, ThreadStatus>();
  const archived = new Set<string>();
  /** Threads a watch round has seen open (the watcher's `seenOpen`). */
  const watched = new Set<string>();
  const page = (id: string): HistoryPage | null => {
    const status = stored.get(id);
    return status ? { agent: "pi", owner: null, status, total: 2, answer: { index: 1, text: `${id.slice(0, 2)} did it` }, asked: 0, start: 0, events: [] } : null;
  };
  let spawned = 0;
  const threads: OptThreads = {
    projects: async () => "", runners: async () => "", describe: async () => "", tell: async () => {},
    spawn: async () => { const id = ids[spawned++]!; return { id, title: id.slice(0, 8) }; },
    // Their agents never open here: the watcher reads their stores.
    events: async id => { if (!archived.has(id)) watched.add(id); return archived.has(id) ? null : "stored"; },
    history: async id => ({ transcript: page(id) }) as unknown as ThreadRecord,
  };
  const reports: string[] = [];
  const textOf = (message: Message) => typeof message.content === "string" ? [message.content] : message.content.map(part => part.type === "text" ? part.text : "");
  faux.setResponses(Array.from({ length: 200 }, () => (request: { messages: Message[] }) => {
    const system = request.messages.find(message => message.role === "system");
    if (system && textOf(system).join("").includes("You write the memory of OptChat")) return fauxAssistantMessage("summary");
    if (request.messages.at(-1)?.role !== "user") return fauxAssistantMessage("noted");
    const taken = request.messages.filter(message => message.role === "user").flatMap(textOf).filter(part => !part.includes("<chat>"));
    for (const part of taken) for (const line of part.split("\n")) if (/^\[[0-9a-f]{8}\] /.test(line)) reports.push(line);
    if (taken.some(part => part.includes("start two threads"))) {
      return fauxAssistantMessage([fauxToolCall("spawn", { tasks: ids.map((_, n) => ({ project: "cube", task: `task ${n}` })) }, { id: "call-spawn" })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("noted");
  }));
  const chat = await OptChat.open({ directory: path.join(root, "optchat"), models, model: async () => model, threads, limits: { node: 64, retryMs: 50, watchMs: 50 } });
  const reportsOf = (id: string) => reports.filter(line => line.startsWith(`[${id.slice(0, 8)}] `));
  async function until(check: () => boolean, what: string) {
    for (let k = 0; k < 500 && !check(); k++) await delay(10);
    assert.ok(check(), what);
  }
  try {
    await chat.send("start two threads", "u1");
    // chat.send returns before the spawn turn ends: wait for a round to see both.
    await until(() => watched.has(A) && watched.has(B), "watch rounds read both stores: nothing settled yet");

    // L1: A's run settles and A is archived (in the UI) before the next round.
    stored.set(A, { state: "completed", run: "rA", error: null });
    archived.add(A);
    await until(() => reportsOf(A).length === 1, "L1: the run of a thread archived before a round saw it settle reports");

    // L2: B's report cannot be handed to the chat once.
    const send = chat.send.bind(chat);
    let refused = 0;
    chat.send = async (text, requestId, images) => {
      if (requestId.startsWith(`report:${B}:`) && refused++ === 0) throw new Error("the chat's store is busy");
      return send(text, requestId, images);
    };
    stored.set(B, { state: "completed", run: "rB", error: null });
    await until(() => reportsOf(B).length === 1, "L2: a report whose send failed is sent again");
    await delay(400);
    assert.deepEqual([refused >= 2, reportsOf(A).length, reportsOf(B).length], [true, 1, 1], "each run reported exactly once");
  } finally { await chat.close(); fs.rmSync(root, { recursive: true, force: true }); }
  console.log("ok: reports: a run settled just before its thread was archived reports once; a report whose send failed is sent again, once");
}
process.exit(0);
