/** Pi's compaction and reset through cubed's thread history. A faux model
 * with a small context window makes pi-durable's own threshold compactions
 * (blocking and background) run; cube exposes no reset, so one goes through
 * Pi's conversation API, as Pi's handoff control would. The model context loses
 * the hidden entries, the thread transcript keeps them, the thread keeps
 * working and a reopen from the same state shows the same history. Offline:
 * faux model, local guest (the real guest helper under a temporary root), disposable state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { LiveDoc, type LiveState } from "@earendil-works/pi-durable";
import { openAgent, type Agent } from "../src/durable-agent.ts";
import { PiThreadEvents } from "../src/pi-thread-events.ts";
import type { ThreadTranscript } from "../src/thread-events.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { LocalGuestTransport } from "./local-guest.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-pi-compaction-"));
const files = path.join(root, "workspace");
const directory = path.join(root, "thread");
fs.mkdirSync(files, { recursive: true });
const guest = new LocalGuestTransport(path.dirname(files));
const leases = new LeaseStore(directory);
const workspace = new VmWorkspace({ guest, leases, owner: "pi", binding: guest.binding });

// Pi's default policy keeps 20000 recent tokens verbatim and blocks to compact
// above contextWindow - 16384. Two 25000-token messages (100000 characters,
// estimated at four per token) exceed a 60000-token window; one does not.
const CONTEXT_WINDOW = 60_000;
const big = (label: string) => `${label}: ${"x".repeat(100_000)}`;
const SUMMARY = "the user sent a long first message and got reply one";
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
/** Every model request: summarization or a turn, with its user texts. */
const requests: Array<{ summary: boolean; users: string[] }> = [];
function models() {
  const faux = fauxProvider({ models: [{ id: "tiny", contextWindow: CONTEXT_WINDOW }], tokensPerSecond: 100_000 });
  faux.setResponses(Array.from({ length: 20 }, () => request => {
    const summary = request.messages.some(message => message.role === "system" && /context summarization assistant/.test(JSON.stringify(message)));
    const users = request.messages.filter(message => message.role === "user").map(textOf);
    requests.push({ summary, users });
    if (summary) return fauxAssistantMessage(SUMMARY);
    const last = users.at(-1)!;
    return fauxAssistantMessage(`reply to ${last.slice(0, last.indexOf(":"))}`);
  }));
  const catalog = createModels();
  catalog.setProvider(faux.provider);
  return { models: catalog, model: { provider: faux.getModel().provider, id: faux.getModel().id } };
}
const open = () => openAgent({ directory, binding: guest.binding, workspace, ...models() });
const feed = (agent: Agent) => new PiThreadEvents({ agent, owner: () => leases.holder(), failure: () => null });
async function turn(agent: Agent, content: string, requestId: string) {
  const submission = await agent.conversation.submit({ type: "input", content, requestId }, context);
  assert.equal((await submission.wait(context)).status, "done", `${requestId} settles done`);
  // A background compaction outlives the run; let it place its summary so
  // the next turn starts from a settled context.
  await until(async () => !((await agent.harness.snapshot(LiveDoc, agent.conversation.id, context)) as LiveState | undefined)?.compactions?.length, "compactions to settle");
}
/** The transcript as short lines: user label or assistant text. */
const lines = (transcript: ThreadTranscript) => transcript.events.map(event =>
  event.type === "user-message" ? `user ${event.text.slice(0, event.text.indexOf(":"))}`
    : event.type === "assistant-text" ? `assistant ${event.text}` : event.type);
async function view(agent: Agent) {
  const watch = await agent.conversation.watch(context);
  await watch.stop();
  return watch.value;
}
async function until(check: () => boolean | Promise<boolean>, what: string) {
  const deadline = Date.now() + 10000;
  while (!await check()) { assert(Date.now() < deadline, `waiting for ${what}`); await delay(20); }
}

let agent = await open();
try {
  let afterCompaction: ThreadTranscript;
  {
    const events = feed(agent);
    await turn(agent, big("first"), "first");
    assert.equal(requests.filter(request => request.summary).length, 0, "one large message fits");
    // A watch open across the compaction sees the hidden entries too.
    const frames: ThreadTranscript[] = [];
    const watch = await events.watch(value => { frames.push(value); });
    await turn(agent, big("second"), "second");
    const summaries = requests.filter(request => request.summary);
    assert.equal(summaries.length, 1, "pi-durable's threshold compaction summarized once");
    assert.deepEqual(summaries[0]!.users.length, 1, "the summarizer reads one serialized transcript");
    assert.match(summaries[0]!.users[0]!, /\[User\]: first: x+/);
    assert.doesNotMatch(summaries[0]!.users[0]!, /second: /, "the newest message is kept verbatim");
    const answered = requests.at(-1)!;
    assert.equal(answered.summary, false);
    assert.equal(answered.users.length, 2, "the model sees the summary and the kept message");
    assert.match(answered.users[0]!, new RegExp(SUMMARY));
    assert.match(answered.users[1]!, /^second: /);
    const compacted = await view(agent);
    const marker = compacted.entries[0]!;
    assert.equal(marker.kind, "pi.compaction");
    assert(marker.head !== undefined && marker.head < marker.id, "the summary's head is an earlier entry");
    assert(!compacted.entries.some(entry => entry.model?.some(message => message.role === "user" && textOf(message).startsWith("first:"))), "the first message left Pi's view");

    const transcript = await events.read();
    assert.deepEqual(lines(transcript), ["user first", "assistant reply to first", "user second", "assistant reply to second"]);
    assert.deepEqual(transcript.events[0], { type: "user-message", id: transcript.events[0]!.id, text: big("first") }, "hidden entries keep their full text");
    assert(!JSON.stringify(transcript.events).includes(SUMMARY), "the summary is model context, not a transcript message");
    assert.deepEqual(transcript.status, { state: "completed", run: "second", error: null });
    assert.equal(new Set(transcript.events.map(event => event.id)).size, transcript.events.length, "event ids are unique");
    await until(() => JSON.stringify(frames.at(-1)) === JSON.stringify(transcript), "the watch's final frame");
    assert(frames.every(frame => lines(frame)[0] === "user first"), "no frame dropped the earlier messages");
    await watch.stop();

    // The thread keeps working after the compaction.
    await turn(agent, "third: short", "third");
    assert.equal(requests.filter(request => request.summary).length, 1, "no second compaction");
    assert.deepEqual(requests.at(-1)!.users.map(text => text.slice(0, 12)), [answered.users[0]!.slice(0, 12), "second: xxxx", "third: short"]);
    afterCompaction = await events.read();
    assert.deepEqual(lines(afterCompaction), ["user first", "assistant reply to first", "user second", "assistant reply to second", "user third", "assistant reply to third"]);
    assert.deepEqual(afterCompaction.status, { state: "completed", run: "third", error: null });
    console.log("ok: pi-durable's own compaction hides the first exchange from the model; the transcript and a live watch keep it; the thread keeps working");
  }
  {
    // A reopen from the same state reads the same history and continues.
    await agent.close();
    agent = await open();
    const events = feed(agent);
    assert.deepEqual(await events.read(), afterCompaction);
    await turn(agent, "fourth: after reopen", "fourth");
    assert.equal(requests.at(-1)!.users[0]!.includes(SUMMARY), true, "the reopened model context starts at the summary");
    assert.deepEqual(lines(await events.read()).slice(-2), ["user fourth", "assistant reply to fourth"]);
    console.log("ok: a reopen from the same state reads the same compacted history and the thread continues");
  }
  {
    // A reset starts a new model context; the transcript keeps everything.
    const events = feed(agent);
    const before = await events.read();
    await agent.conversation.reset(undefined, context);
    await agent.conversation.waitForIdle(context);
    const reset = await view(agent);
    assert.equal(reset.entries[0]!.kind, "pi.reset");
    assert.equal(reset.entries[0]!.head, reset.entries[0]!.id, "a reset is its own head");
    assert.deepEqual((await events.read()).events, before.events, "a reset hides nothing from the transcript");
    await turn(agent, "fifth: fresh context", "fifth");
    assert.deepEqual(requests.at(-1)!.users, ["fifth: fresh context"], "the model sees only the new context");
    // Compactions inside the reset context chain their heads: a background
    // one after the sixth message, a blocking one before the seventh.
    await turn(agent, big("sixth"), "sixth");
    await turn(agent, big("seventh"), "seventh");
    const summaries = requests.filter(request => request.summary).slice(1).map(request => request.users[0]!);
    assert.equal(summaries.length, 2, "the reset context compacted on its own");
    assert.match(summaries[0]!, /^<conversation>\n\[User\]: fifth: fresh context/, "the first summary starts at the reset");
    assert.doesNotMatch(summaries.join("\n"), /first: |second: |third: |fourth: /, "nothing before the reset is summarized");
    assert.match(summaries[1]!, /^<conversation>\n\[User\]: The conversation history before this point was compacted[\s\S]*\[User\]: sixth: /, "the second summary folds in the first");
    assert.deepEqual(requests.at(-1)!.users.map(text => text.slice(0, 16)), ["The conversation", "seventh: xxxxxxx"]);
    assert.equal((await view(agent)).entries[0]!.kind, "pi.compaction");
    const transcript = await events.read();
    assert.deepEqual(lines(transcript), [
      "user first", "assistant reply to first", "user second", "assistant reply to second", "user third", "assistant reply to third",
      "user fourth", "assistant reply to fourth", "user fifth", "assistant reply to fifth",
      "user sixth", "assistant reply to sixth", "user seventh", "assistant reply to seventh",
    ]);
    assert.equal(new Set(transcript.events.map(event => event.id)).size, transcript.events.length, "event ids are unique");
    await agent.close();
    agent = await open();
    assert.deepEqual(await feed(agent).read(), transcript, "a reopen after the reset and second compaction reads the same history");
    console.log("ok: a reset starts a new model context; a later compaction chains on it; the transcript keeps everything across a reopen");
  }
} finally {
  await agent.close();
  guest.stop();
  leases.close();
  fs.rmSync(root, { recursive: true, force: true });
}
