/** OptChat's watcher and a thread's start: a machine that fails a try and
 * comes up on a later one (a lease not yet let go, a guest not reachable
 * yet) sends no failure, only the run's report; a failure that lasts past
 * the grace is reported once, as one cubed keeps retrying; a thread being
 * archived is not a failure to start. Faux model, disposable state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { OptChat, type OptThreads } from "../src/optchat.ts";
import type { ThreadEvents, ThreadTranscript } from "../src/thread-events.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-start-"));
const LATE = "1a7e0000-0000-4000-8000-000000000001";
const STUCK = "57ac0000-0000-4000-8000-000000000002";
const LEAVING = "1ea40000-0000-4000-8000-000000000003";
const FLAKY = "f1a40000-0000-4000-8000-000000000004";
const done: ThreadTranscript = { agent: "pi", owner: "pi", status: { state: "completed", run: "run-1", error: null },
  events: [{ type: "user-message", id: "1", text: "task" }, { type: "assistant-text", id: "2", text: "all tests pass", reasoning: false, final: true }] };
const events: ThreadEvents = {
  async read() { return done; },
  async watch(listener) { await listener(done); return { stop: async () => {}, closed: new Promise<void>(() => {}) }; },
};
/** Events whose watch ends at once: the next round asks for them again. */
const brief: ThreadEvents = { ...events, async watch(listener) { await listener(done); return { stop: async () => {}, closed: Promise.resolve() }; } };

/** One chat whose model spawns `ids` and then only notes what reaches it. */
async function chat(name: string, ids: string[], threadEvents: OptThreads["events"], startGraceMs: number) {
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  let spawned = false;
  faux.setResponses(Array.from({ length: 40 }, () => async request => {
    const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
    if (system.includes("You write the memory of OptChat")) return fauxAssistantMessage("summary");
    if (spawned) return fauxAssistantMessage("noted");
    spawned = true;
    return fauxAssistantMessage([fauxToolCall("spawn", { tasks: ids.map(() => ({ project: "cube", task: "work" })) }, { id: "call-spawn" })], { stopReason: "toolUse" });
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  let next = 0;
  const threads: OptThreads = {
    async projects() { return "projects: cube"; },
    async runners() { return "no runners"; },
    async spawn() { return { id: ids[next++]!, title: "work" }; },
    async tell() {},
    async describe() { return ""; },
    events: threadEvents,
    async history() { return null; },
  };
  const opened = await OptChat.open({ directory: path.join(root, name), models, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }),
    threads, limits: { node: 64, retryMs: 50, watchMs: 20, startGraceMs } });
  await opened.send("start", "r1");
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
  // A try that fails, then a later one that brings the machine up: the
  // run's report comes, no failure is sent.
  {
    let tries = 0;
    const optchat = await chat("late", [LATE], async () => {
      if (++tries <= 3) throw new Error("workspace allocation failed: thread workspace already has a writable owner");
      return events;
    }, 60_000);
    try {
      await until(async () => (await sent(optchat, `report:${LATE}:run-1`)).length > 0, "the run's report reaches the chat");
      assert.ok(tries > 3, "the watcher tried again");
      assert.deepEqual(await sent(optchat, `report:${LATE}:start`), [], "a failed try the next one recovered is not reported");
      assert.equal((await sent(optchat, `report:${LATE}:run-1`)).length, 1);
    } finally { await optchat.close(); }
  }
  // A failure that lasts is reported once and says cubed retries; a thread
  // being archived (no events) is never a failure to start.
  {
    let stuck = 0, leaving = 0;
    const optchat = await chat("stuck", [STUCK, LEAVING], async id => {
      if (id === LEAVING) { leaving++; return "archiving"; }
      stuck++;
      throw new Error("workspace allocation failed: ssh: the guest is unreachable");
    }, 100);
    try {
      await until(async () => (await sent(optchat, `report:${STUCK}:start`)).length > 0, "the lasting failure is reported");
      const tries = stuck;
      await until(async () => stuck > tries + 3 && leaving > 3, "both are watched again");
      const [report, ...more] = await sent(optchat, `report:${STUCK}:start`);
      assert.deepEqual(more, [], "reported once");
      assert.match(report!, /^\[57ac0000\] failed to start for \d+ s; cubed keeps retrying: workspace allocation failed: ssh: the guest is unreachable$/);
      assert.deepEqual(await sent(optchat, `report:${LEAVING}:start`), [], "an archive under way is not a failure");
      assert.ok(!(await optchat.pending()).some(item => item.text.includes("being archived")));
    } finally { await optchat.close(); }
  }
  // Failures that never last the grace, each ended by a start, are never
  // reported: a start begins the grace again.
  {
    let tries = 0;
    const optchat = await chat("flaky", [FLAKY], async () => {
      tries++;
      if (tries % 4 === 0) return brief;
      await delay(60);
      throw new Error("ssh: the guest is unreachable");
    }, 1000);
    try {
      await until(async () => tries > 40, "many rounds");
      assert.deepEqual(await sent(optchat, `report:${FLAKY}:start`), [], "the grace begins again after each start");
    } finally { await optchat.close(); }
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("optchat start: ok");
