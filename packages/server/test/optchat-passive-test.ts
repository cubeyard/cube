/** OptChat's passive observation of its threads never wakes a sleeping
 * machine; offline and disposable.
 *
 *   1. cubeThreads over the real Conversations and fake machines that count
 *      every start and guest call: watching (`events`), listing (`describe`)
 *      and reading (`history`) a suspended or waking thread start nothing,
 *      call no guest and open no agent. The old listing path (the agent's
 *      live history) is checked as it was: it woke no machine, but opened
 *      the agent. Watching an awake thread whose agent is not open starts
 *      nothing either; a start that failed (an explicit one, the counter's
 *      control) is still the watcher's failure to start.
 *   2. The suspend race, over the real Conversations and cubeThreads: an
 *      idle round suspends an awake thread, and the watcher looks at it
 *      while the suspend goes on (the registry does not say suspended yet).
 *      The fake machines wait a start for the suspend under way and then
 *      resume what it saved, as runner-machines.ts does
 *      (runner-suspend-test.ts: "a start that comes during a suspend waits
 *      for it, then resumes the machine"): the watcher starts nothing, so
 *      nothing is resumed.
 *   3. OptChat over cubeThreads with fake Conversations, through a restart:
 *      the watcher activates no thread; a stored run that settled and never
 *      reported reports once (idle is not taken for delivered), also once
 *      its agent opens and it is watched; one already reported does not
 *      report again; a running thread is watched once the recovery loop
 *      opened its agent and reports once; a thread woken by a message is
 *      watched again and reports its new run once. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { Conversations } from "../src/conversation.ts";
import { OptChat } from "../src/optchat.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import { threadCondition } from "../src/thread-condition.ts";
import type { Registry, Thread } from "../src/registry.ts";
import type { RunFeed, ThreadEvents, ThreadStatus, ThreadTranscript } from "../src/thread-events.ts";
import type { HistoryPage } from "../src/thread-history.ts";
import { NoMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-passive-"));
const faux = fauxProvider({ tokensPerSecond: 100_000 });
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, id: faux.getModel().id };
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
const blocks = (message: Message) => typeof message.content === "string" ? [message.content]
  : message.content.map(part => part.type === "text" ? part.text : "");

type Suspension = NonNullable<NonNullable<Thread["vm"]>["suspension"]>;
const makeThread = (id: string, suspension?: Suspension) => ({
  id, title: `thread ${id.slice(0, 8)}`, archived: false, workspaceState: "available", runnerId: "r", projectId: "p", agent: "pi", model,
  allocation: { repositories: [], skills: null, hooks: null },
  vm: { vmId: id.slice(0, 16).padEnd(16, "0"), placeholders: {}, ...suspension ? { suspension } : {} },
}) as unknown as Thread;
const registryOf = (threads: Thread[]) => ({
  listThreads: () => threads, getThread: (id: string) => threads.find(thread => thread.id === id) ?? null,
  getProject: () => ({ id: "p", name: "cube" }), interruptStartupSteps: () => {}, beginStartupStep: () => {}, endStartupStep: () => {}, initialPrompt: () => null,
  runner: () => ({ nodeId: "node", environmentId: 1, configHash: "config" }), runnerSlots: () => ({ free: 0, total: 2 }), slotQueue: () => new Map(),
}) as unknown as Registry;
const noThreads = { catalog: async () => [], runners: () => ({ runners: [] }) as never, latestCommits: async () => ({}) as never };

// ------------------------------------------------ 1. the real Conversations

{
  const asleep = makeThread("a5a5a5a5-0000-4000-8000-000000000001", { state: "suspended", at: 1 });
  const listed = makeThread("a5a5a5a5-0000-4000-8000-000000000002", { state: "suspended", at: 1 });
  const waking = makeThread("a5a5a5a5-0000-4000-8000-000000000003", { state: "waking", at: 1, waiting: "waiting for a free slot on runner node" });
  const awake = makeThread("a5a5a5a5-0000-4000-8000-000000000004");
  const machines = new NoMachines();
  const { starts, calls: guests } = machines;
  const registry = registryOf([asleep, listed, waking, awake]);
  const conversations = new Conversations({ registry, directory: path.join(root, "threads"), models, machines });
  const threads = cubeThreads({ registry, conversations, ...noThreads });

  // The listing path as it was: the agent's live history. It woke nothing,
  // but opened the agent (the workspace lease, the agent's replay).
  await conversations.history(asleep.id);
  assert.deepEqual([starts, guests], [[], []], "the live history of a suspended thread starts no machine and calls no guest");
  assert.equal(conversations.agentOpen(asleep.id), true, "but it opens the agent: a listing must not use it");

  // Listing now: no agent opened, nothing started, the sleep said as it is.
  const listing = await threads.describe([listed.id, waking.id]);
  assert.equal(conversations.agentOpen(listed.id), false, "describe opens no agent");
  assert.equal(conversations.agentOpen(waking.id), false);
  assert.match(listing, /\[a5a5a5a5\] cube · thread a5a5a5a5 · its machine is suspended/);
  assert.match(listing, /its machine is being woken \(waiting for a free slot on runner node\)/);
  // Reading a thread's history (the tool): stored only.
  await threads.history(listed.id, { limit: 1 });
  assert.equal(conversations.agentOpen(listed.id), false, "history opens no agent");
  // Watching: a sleeping machine without its agent is not woken, suspended or waking.
  assert.equal(await threads.events(listed.id), "stored");
  assert.equal(await threads.events(waking.id), "stored");
  assert.equal(conversations.agentOpen(listed.id), false, "watching opens no agent");
  // With its agent open (it stays open while the machine sleeps): its own
  // events, still without a start.
  const own = await threads.events(asleep.id);
  assert.ok(own && typeof own === "object" && "watch" in own, "a sleeping thread with its agent open is watched through it");
  assert.deepEqual([starts, guests], [[], []], "passive observation of suspended and waking threads: zero starts, zero guest calls");

  // An awake thread whose agent is not open: the watcher reads, starts nothing.
  assert.equal(await threads.events(awake.id), "stored");
  assert.equal(conversations.agentOpen(awake.id), false, "watching an awake thread opens no agent");
  assert.deepEqual([starts, guests], [[], []], "watching an awake thread starts nothing");
  // Control: an explicit start is counted, and cubed tells its failure as
  // the thread's start failure; the watcher starts nothing of its own.
  const told: Array<[string, unknown]> = [];
  const unsubscribe = threads.onStartFailure((id, failure) => told.push([id, failure]));
  await conversations.activate(awake.id);
  assert.deepEqual(starts, [awake.id], "the counter counts an explicit start");
  assert.deepEqual(told.at(-1), [awake.id, { failure: "no machine in this test", episode: null, retrying: true, waking: false }], "a failed start is told as the thread's start failure");
  assert.equal(await threads.events(awake.id), "stored", "the watcher reads the stored run");
  assert.deepEqual(starts, [awake.id], "the watcher did not start it again");
  unsubscribe();
  await conversations.close();
  console.log("ok: cubeThreads: watching, listing and reading a suspended, waking or awake thread start no machine, call no guest and open no agent; the old listing opened the agent; a failed explicit start is still reported");
}

// ------------------------------------------------ 2. the suspend race

{
  const thread = makeThread("a5a5a5a5-0000-4000-8000-000000000005");
  const registry = registryOf([thread]);
  const steps: string[] = [];
  let suspending: Promise<void> | null = null;
  let entered!: () => void;
  const inSuspend = new Promise<void>(resolve => { entered = resolve; });
  let save!: () => void;
  const saved = new Promise<void>(resolve => { save = resolve; });
  class Racing extends NoMachines {
    override async start(current: Thread): Promise<{ booted: boolean }> {
      steps.push("start");
      await suspending;
      if (registry.getThread(current.id)?.vm?.suspension) steps.push("resumed what the idle round saved");
      return { booted: false };
    }
    override async suspendIfIdle(current: Thread, busy: () => Promise<string | null>): Promise<boolean> {
      let open!: () => void;
      suspending = new Promise(resolve => { open = resolve; });
      try {
        if (await busy()) return false;
        entered();
        await saved;
        (current as { vm: NonNullable<Thread["vm"]> }).vm = { ...current.vm!, suspension: { state: "suspended", at: 2 } };
        steps.push("suspended");
        return true;
      } finally { suspending = null; open(); }
    }
  }
  const machines = new Racing();
  const conversations = new Conversations({ registry, directory: path.join(root, "race"), models, machines });
  const threads = cubeThreads({ registry, conversations, ...noThreads });
  const round = conversations.suspendIdle();
  await inSuspend;
  assert.equal(registry.getThread(thread.id)!.vm!.suspension, undefined, "mid-suspend the registry still says awake");
  const watched = threads.events(thread.id).catch((error: Error) => `threw: ${error.message}`);
  await delay(20);
  save();
  await round;
  const result = await watched;
  assert.deepEqual(steps, ["suspended"], "no start during the suspend, so nothing is resumed after it");
  assert.equal(result, "stored", "the watcher reads during the suspend");
  assert.equal(await threads.events(thread.id), "stored", "and after it");
  assert.equal(conversations.agentOpen(thread.id), false);
  await conversations.close();
  console.log("ok: the watcher of a thread an idle round is suspending starts nothing: the machine stays suspended");
}

// ------------------------------------------------ 3. OptChat through a restart

{
  const ids = ["aaaaaaa1", "bbbbbbb2", "ccccccc3", "ddddddd4", "eeeeeee5"].map(prefix => `${prefix}-0000-4000-8000-00000000000${prefix[7]}`);
  const [A, B, C, D, E] = ids as [string, string, string, string, string];
  const threadsById = new Map(ids.map(id => [id, makeThread(id)]));
  const registry = registryOf([...threadsById.values()]);
  const setSleep = (id: string, suspension?: Suspension) => {
    const thread = threadsById.get(id)!;
    (thread as { vm: NonNullable<Thread["vm"]> }).vm = { ...thread.vm!, suspension };
  };
  // What each thread's agent stored and shows now.
  const stored = new Map<string, { status: ThreadStatus; reply: string }>();
  /** Threads whose agent is open; opening and closing one tells its run
   * feed, as Conversations does. */
  const feeds = new Set<(fact: RunFeed) => void>();
  const openIds = new Set<string>();
  const tell = (thread: string, isOpen: boolean) => { for (const listener of [...feeds]) listener({ thread, open: isOpen }); };
  const open = {
    has: (id: string) => openIds.has(id),
    add: (id: string) => { openIds.add(id); tell(id, true); },
    clear: () => { const ids = [...openIds]; openIds.clear(); for (const id of ids) tell(id, false); },
  };
  const listeners = new Map<string, (transcript: ThreadTranscript) => void | Promise<void>>();
  const activated: string[] = [];
  const submitted: string[] = [];
  const transcriptOf = (id: string): ThreadTranscript => {
    const { status, reply } = stored.get(id) ?? { status: { state: "idle", run: null, error: null }, reply: "" };
    return { agent: "pi", owner: null, status, events: [
      { type: "user-message", id: "1", text: "the task" }, ...reply ? [{ type: "assistant-text" as const, id: "2", text: reply, reasoning: false, final: true }] : [],
    ] };
  };
  const page = (id: string): HistoryPage | null => {
    const entry = stored.get(id);
    if (!entry) return null;
    return { agent: "pi", owner: null, status: entry.status, total: 2, answer: entry.reply ? { index: 1, text: entry.reply } : null, asked: 0, start: 0, events: [] };
  };
  const conversations = {
    activate: async (id: string) => { activated.push(id); open.add(id); },
    agentOpen: (id: string) => open.has(id),
    condition: (thread: Thread) => threadCondition(thread, { archiving: false, starting: false, agentOpen: open.has(thread.id), failure: null, down: null, waiting: null }),
    startFailure: () => null, onStartFailure: () => () => {},
    onRunFeed: (listener: (fact: RunFeed) => void) => { feeds.add(listener); return () => { feeds.delete(listener); }; },
    owner: () => null,
    storedHistory: async (id: string) => page(id),
    history: async (id: string) => transcriptOf(id),
    submit: async (id: string, text: string, requestId: string) => { submitted.push(`${id}:${text}`); return { runId: requestId, accepted: "started" as const }; },
    live: async (id: string): Promise<ThreadEvents | null> => !open.has(id) ? null : ({
      async read() { return transcriptOf(id); },
      async watch(listener) {
        listeners.set(id, listener);
        await listener(transcriptOf(id));
        return { closed: new Promise(() => {}), async stop() { listeners.delete(id); } };
      },
    }),
  } as unknown as Conversations;
  let nextSpawn = 0;
  // spawn starts its thread and opens its agent (its own activation).
  const threads = { ...cubeThreads({ registry, conversations, ...noThreads }),
    async spawn() { const id = ids[nextSpawn++]!; open.add(id); return { id, title: `thread ${id.slice(0, 8)}` }; } };
  /** Every report the chat's model was given, in order (the message after the view). */
  const reports: string[] = [];
  faux.setResponses(Array.from({ length: 200 }, () => (request: { messages: Message[] }) => {
    const system = request.messages.find(message => message.role === "system");
    if (system && textOf(system).includes("You write the memory of OptChat")) return fauxAssistantMessage("summary");
    // A turn is the view and the messages it takes (one or a batch); a
    // message shows outside a view only in the turn that takes it.
    if (request.messages.at(-1)?.role !== "user") return fauxAssistantMessage("noted");
    const taken = request.messages.filter(message => message.role === "user").flatMap(blocks).filter(part => !part.includes("<chat>"));
    for (const part of taken) for (const line of part.split("\n")) if (/^\[[0-9a-f]{8}\] /.test(line)) reports.push(line);
    if (taken.some(part => part.includes("start five threads"))) {
      return fauxAssistantMessage([fauxToolCall("spawn", { tasks: ids.map((_, n) => ({ project: "cube", task: `task ${n}` })) }, { id: "call-spawn" })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("noted");
  }));
  const directory = path.join(root, "optchat");
  const openChat = () => OptChat.open({ directory, models, model: async () => model, threads, limits: { node: 64, retryMs: 50, watchMs: 50 } });
  async function until(check: () => boolean, what: string) {
    for (let k = 0; k < 500 && !check(); k++) await delay(10);
    assert.ok(check(), what);
  }
  const reportsOf = (id: string) => reports.filter(line => line.startsWith(`[${id.slice(0, 8)}] `));
  const settled = (run: string, reply: string) => ({ status: { state: "completed", run, error: null } as ThreadStatus, reply });

  let chat = await openChat();
  try {
    await chat.send("start five threads", "u1");
    await until(() => ids.every(id => listeners.has(id)), "every spawned thread is watched while awake");
    // A's run ends while it is watched: one report.
    stored.set(A, settled("rA1", "A did its work"));
    await listeners.get(A)!(transcriptOf(A));
    await until(() => reportsOf(A).length === 1, "A reports its run");
  } finally { await chat.close(); }

  // While cubed was away: A, B and E were suspended idle, D is being woken
  // (waiting for a slot), C still works. Agents are closed by the restart;
  // the recovery loop opens C's (its machine runs) and goes on with D's wake.
  open.clear();
  listeners.clear();
  setSleep(A, { state: "suspended", at: 1 });
  setSleep(B, { state: "suspended", at: 1 });
  setSleep(D, { state: "waking", at: 1, waiting: "waiting for a free slot on runner node" });
  setSleep(E, { state: "suspended", at: 1 });
  stored.set(B, settled("rB1", "B finished while nobody watched"));
  stored.set(D, settled("rD1", "D finished before its machine slept"));
  stored.set(C, { status: { state: "working", run: "rC1", error: null }, reply: "" });
  // E never ran a turn: idle, nothing to report.
  activated.length = 0;

  chat = await openChat();
  try {
    await until(() => reportsOf(B).length === 1 && reportsOf(D).length === 1, "the stored runs nobody reported, suspended (B) and waking (D), report");
    await delay(200); // several watch rounds (50 ms each)
    assert.equal(listeners.has(C), false, "a thread whose agent is not open yet is not watched");
    // The recovery loop: C's agent opens (its machine runs); D's wake ends.
    open.add(C);
    await until(() => listeners.has(C), "the running thread is watched once its agent is open");
    setSleep(D, undefined);
    open.add(D);
    await until(() => listeners.has(D), "the woken thread is watched once its agent is open");
    await delay(200);
    assert.deepEqual(activated, [], "the watcher activates no thread: suspended, waking or running");
    assert.equal(reportsOf(D).length, 1, "D's run, reported from its store, is not reported again from its agent");
    assert.equal(reportsOf(A).length, 1, "a run reported before the restart is not reported again");
    assert.equal(reportsOf(B).length, 1, "a stored report goes once, however many rounds read it");
    assert.equal(reportsOf(D).length, 1);
    assert.equal(reportsOf(E).length, 0, "an idle thread that never ran reports nothing");
    assert.match(reportsOf(B)[0]!, /ended its turn; nothing of it runs now: B finished while nobody watched/);
    // The running thread's run ends: it reports, once.
    stored.set(C, settled("rC1", "C is done"));
    await listeners.get(C)!(transcriptOf(C));
    await until(() => reportsOf(C).length === 1, "the running thread reports its run");

    // A message wakes A (the explicit path): its machine runs again with its
    // agent open, it is watched again and its new run reports once.
    await threads.tell(A, "go on", "tell-1");
    assert.deepEqual(submitted, [`${A}:go on`], "the message goes to the thread itself");
    setSleep(A, undefined);
    open.add(A);
    stored.set(A, { status: { state: "working", run: "rA2", error: null }, reply: "" });
    await until(() => listeners.has(A), "the woken thread is watched again");
    assert.deepEqual(activated, [], "nor is A activated by its watcher: the message woke it");
    stored.set(A, settled("rA2", "A went on"));
    await listeners.get(A)!(transcriptOf(A));
    await until(() => reportsOf(A).length === 2, "the woken thread's new run reports");
    await delay(300);
    assert.deepEqual(ids.map(id => reportsOf(id).length), [2, 1, 1, 1, 0], "every settled run reported exactly once");
  } finally { await chat.close(); fs.rmSync(root, { recursive: true, force: true }); }
  console.log("ok: OptChat through a restart: the watcher activates no thread; stored unreported runs report once, also once watched, reported ones not again, an idle one not at all; running and woken threads are watched once their agent is open and report once");
}
