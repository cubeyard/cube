/** OptChat's watcher and a thread's start, told by cubed as a fact
 * (`onStartFailure`, I-5a): a start that fails and comes up within the
 * grace sends no failure, only the run's report; a failure that lasts past
 * the grace is reported once, saying whether cubed retries; each episode of
 * a wake's failures once; a thread being archived is not a failure to
 * start; failures each ended by a start are never reported; a failure told
 * before a reopen is read at the reopen and still reported once. Faux
 * model, disposable state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { OptChat, type OptThreads } from "../src/optchat.ts";
import type { StartFailure } from "../src/thread-condition.ts";
import type { RunFeed, ThreadEvents, ThreadTranscript } from "../src/thread-events.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-start-"));
const LATE = "1a7e0000-0000-4000-8000-000000000001";
const STUCK = "57ac0000-0000-4000-8000-000000000002";
const LEAVING = "1ea40000-0000-4000-8000-000000000003";
const FLAKY = "f1a40000-0000-4000-8000-000000000004";
const AGAIN = "a9a10000-0000-4000-8000-000000000005";
const done: ThreadTranscript = { agent: "pi", owner: "pi", status: { state: "completed", run: "run-1", error: null },
  events: [{ type: "user-message", id: "1", text: "task" }, { type: "assistant-text", id: "2", text: "all tests pass", reasoning: false, final: true }] };
const events: ThreadEvents = {
  async read() { return done; },
  async watch(listener) { await listener(done); return { stop: async () => {}, closed: new Promise<void>(() => {}) }; },
};

/** cubed's side of the facts, as Conversations has them: the current start
 * failure per thread, told to every listener when it changes; a start that
 * ends opens the thread's run feed, which is told too. */
class Starts {
  readonly now = new Map<string, StartFailure>();
  private readonly listeners = new Set<(id: string, failure: StartFailure | null) => void>();
  private readonly feeds = new Set<(fact: RunFeed) => void>();
  set(id: string, failure: StartFailure | null): void {
    if (failure) this.now.set(id, failure); else this.now.delete(id);
    for (const listener of [...this.listeners]) listener(id, failure);
    if (!failure) for (const listener of [...this.feeds]) listener({ thread: id, open: true });
  }
  readonly onRunFeed = (listener: (fact: RunFeed) => void) => {
    this.feeds.add(listener);
    return () => { this.feeds.delete(listener); };
  };
  readonly startFailure = (id: string) => this.now.get(id) ?? null;
  readonly onStartFailure = (listener: (id: string, failure: StartFailure | null) => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
}
const failing = (failure: string, more: Partial<StartFailure> = {}): StartFailure => ({ failure, episode: null, retrying: true, waking: false, ...more });

/** One chat whose model spawns `ids` and then only notes what reaches it.
 * A thread's events are `events` once it runs, "stored" while it fails. */
async function chat(name: string, ids: string[], starts: Starts, startGraceMs: number, state: (id: string) => ThreadEvents | "stored" | "archiving" = () => "stored") {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  let spawned = false;
  faux.setResponses(Array.from({ length: 40 }, () => async request => {
    const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
    if (system.includes("You write the memory of OptChat")) return fauxAssistantMessage("summary");
    if (spawned || !ids.length) return fauxAssistantMessage("noted");
    spawned = true;
    return fauxAssistantMessage([fauxToolCall("spawn", { tasks: ids.map(() => ({ project: "cube", task: "work" })) }, { id: "call-spawn" })], { stopReason: "toolUse" });
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  let next = 0;
  const threads: OptThreads = {
    startFailure: starts.startFailure, onStartFailure: starts.onStartFailure, onRunFeed: starts.onRunFeed,
    async projects() { return "projects: cube"; },
    async runners() { return "no runners"; },
    async spawn() { return { id: ids[next++]!, title: "work" }; },
    async tell() {},
    async describe() { return ""; },
    async events(id) { return starts.now.has(id) ? "stored" : state(id); },
    async history() { return null; },
  };
  const opened = await OptChat.open({ directory: path.join(root, name), models, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }),
    threads, limits: { node: 64, retryMs: 50, watchMs: 20, startGraceMs } });
  if (ids.length) await opened.send("start", "r1");
  return opened;
}
/** The chat's messages under `requestId`: waiting or placed. */
async function sent(optchat: OptChat, requestId: string): Promise<string[]> {
  const pending = (await optchat.pending()).filter(item => item.requestId === requestId).map(item => item.text);
  const placed = await optchat.agent.conversation.commit(async tx => {
    const submission = await tx.submissionByRequest(optchat.agent.conversation.id, requestId);
    const entry = submission?.type === "input" && submission.entry !== undefined ? await tx.entry(submission.entry) : undefined;
    const content = entry?.model?.[0]?.content;
    return typeof content === "string" ? content : Array.isArray(content) ? content.map(part => part.type === "text" ? part.text : "").join("") : submission ? "" : null;
  }, context);
  return placed === null ? pending : [...pending, placed];
}
async function until(check: () => Promise<boolean>, what: string) {
  for (let k = 0; k < 1500; k++) { if (await check()) return; await delay(10); }
  assert.fail(what);
}

try {
  // A start that fails, then comes up within the grace: the run's report
  // comes, no failure is sent.
  {
    const starts = new Starts();
    const optchat = await chat("late", [LATE], starts, 60_000, () => events);
    try {
      starts.set(LATE, failing("workspace allocation failed: thread workspace already has a writable owner"));
      await delay(100);
      starts.set(LATE, null);
      await until(async () => (await sent(optchat, `report:${LATE}:run-1`)).length > 0, "the run's report reaches the chat");
      assert.deepEqual(await sent(optchat, `report:${LATE}:start`), [], "a failure the next try recovered is not reported");
      assert.equal((await sent(optchat, `report:${LATE}:run-1`)).length, 1);
    } finally { await optchat.close(); }
  }
  // A failure that lasts is reported once and says cubed retries; a thread
  // being archived is never a failure to start.
  {
    const starts = new Starts();
    const optchat = await chat("stuck", [STUCK, LEAVING], starts, 100, id => id === LEAVING ? "archiving" : events);
    try {
      starts.set(STUCK, failing("workspace allocation failed: ssh: the guest is unreachable"));
      await until(async () => (await sent(optchat, `report:${STUCK}:start`)).length > 0, "the lasting failure is reported");
      starts.set(STUCK, failing("workspace allocation failed: ssh: the guest is unreachable"));
      await delay(300);
      const [report, ...more] = await sent(optchat, `report:${STUCK}:start`);
      assert.deepEqual(more, [], "reported once, also when cubed tells it again");
      assert.match(report!, /^\[57ac0000\] failed to start for \d+ s; cubed keeps retrying: workspace allocation failed: ssh: the guest is unreachable$/);
      assert.deepEqual(await sent(optchat, `report:${LEAVING}:start`), [], "an archive under way is not a failure");
      assert.ok(!(await optchat.pending()).some(item => item.text.includes("being archived")));
    } finally { await optchat.close(); }
  }
  // Each episode of a wake's failures (failing, then woken, then failing
  // again) is reported once, by its episode; one cubed no longer retries
  // (it stopped, or the agent is down) does not say it keeps retrying.
  {
    const starts = new Starts();
    const optchat = await chat("again", [AGAIN], starts, 100, () => events);
    try {
      starts.set(AGAIN, failing("INTERNAL: the snapshot could not be restored", { episode: "1000", waking: true }));
      await until(async () => (await sent(optchat, `report:${AGAIN}:failure:1000`)).length > 0, "the first episode is reported");
      starts.set(AGAIN, null);
      await delay(100);
      starts.set(AGAIN, failing("INTERNAL: the snapshot could not be restored; cube stopped retrying after 8 tries in a row, a message to the thread tries once more",
        { episode: "2000", retrying: false, waking: true }));
      await until(async () => (await sent(optchat, `report:${AGAIN}:failure:2000`)).length > 0, "the second episode is reported");
      await delay(300);
      const first = await sent(optchat, `report:${AGAIN}:failure:1000`), second = await sent(optchat, `report:${AGAIN}:failure:2000`);
      assert.deepEqual([first.length, second.length], [1, 1], "each episode once");
      assert.match(first[0]!, /^\[a9a10000\] its machine failed to wake for \d+ s; cubed keeps retrying: INTERNAL: the snapshot could not be restored$/);
      assert.match(second[0]!, /^\[a9a10000\] its machine failed to wake for \d+ s: INTERNAL: the snapshot could not be restored; cube stopped retrying after 8 tries in a row, a message to the thread tries once more$/);
    } finally { await optchat.close(); }
  }
  // Failures that never last the grace, each ended by a start, are never
  // reported: a start begins the grace again.
  {
    const starts = new Starts();
    const optchat = await chat("flaky", [FLAKY], starts, 300, () => events);
    try {
      for (let k = 0; k < 20; k++) {
        starts.set(FLAKY, failing("ssh: the guest is unreachable"));
        await delay(60);
        starts.set(FLAKY, null);
        await delay(20);
      }
      await delay(400);
      assert.deepEqual(await sent(optchat, `report:${FLAKY}:start`), [], "the grace begins again after each start");
    } finally { await optchat.close(); }
  }
  // A failure cubed told while the chat was closed is read when it opens
  // again: reported once, and once only over a further reopen.
  {
    const starts = new Starts();
    const watched = new Set<string>();
    let optchat = await chat("reopen", [STUCK], starts, 60_000, id => { watched.add(id); return events; });
    await until(async () => watched.has(STUCK), "the spawned thread is watched (the chat keeps it)");
    await optchat.close();
    starts.set(STUCK, failing("workspace allocation failed: the runner cannot make its disk", { retrying: false }));
    optchat = await chat("reopen", [], starts, 100);
    try {
      await until(async () => (await sent(optchat, `report:${STUCK}:start`)).length > 0, "the failure read at the reopen is reported");
    } finally { await optchat.close(); }
    optchat = await chat("reopen", [], starts, 100);
    try {
      await delay(400);
      const reports = await sent(optchat, `report:${STUCK}:start`);
      assert.equal(reports.length, 1, "a further reopen does not report it again");
      assert.match(reports[0]!, /^\[57ac0000\] failed to start for \d+ s: workspace allocation failed: the runner cannot make its disk$/);
    } finally { await optchat.close(); }
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("optchat start: ok");
