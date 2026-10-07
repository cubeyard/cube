/** OptChat's frames when its two sources disagree: Pi's transcript arrives
 * after OptChat already took a placed message out of the pending ones (a
 * long chat renders slowly). A message a frame showed stays shown, and the
 * chat stays working, until the log has it. Offline; no model, no timers. */
import assert from "node:assert/strict";
import { OptChat, OptChatEvents } from "../src/optchat.ts";
import type { ThreadEvent, ThreadEvents, ThreadTranscript } from "../src/thread-events.ts";

type Item = Awaited<ReturnType<OptChat["pending"]>>[number];
let pending: Item[] = [];
let notify = () => {};
const chat = {
  async threadPrefixes() { return new Set<string>(); },
  async pending() { return [...pending]; },
  failure() { return null; },
  onPending(listener: () => void) { notify = listener; return () => { notify = () => {}; }; },
} as unknown as OptChat;

let push: (transcript: ThreadTranscript) => Promise<void> = async () => {};

const inner: ThreadEvents = {
  async read() { return stored; },
  async watch(listener) {
    push = async transcript => { await listener(transcript); };
    await listener(stored);
    return { closed: new Promise(() => {}), async stop() {} };
  },
};
const transcript = (state: ThreadTranscript["status"]["state"], events: ThreadEvent[]): ThreadTranscript =>
  ({ agent: "pi", owner: null, status: { state, run: state === "idle" ? null : "r", error: null }, events });
const before: ThreadEvent[] = [{ type: "user-message", id: "3.0", text: "earlier" }, { type: "assistant-text", id: "5.0.0", text: "ok", reasoning: false, final: true }];
const placed: ThreadEvent = { type: "user-message", id: "8.0", text: "hello" };
const item: Item = { text: "hello", requestId: "send-1", after: 5 };

const events = new OptChatEvents(chat, inner);
const frames: ThreadTranscript[] = [];
const stored = transcript("completed", before);
const watch = await events.watch(frame => { frames.push(frame); });
const settle = () => new Promise(resolve => setImmediate(resolve));
const users = (frame: ThreadTranscript) => frame.events.flatMap(event => event.type === "user-message" ? [`${event.id}:${event.text}`] : []);

// Accepted: shown as pending, working.
pending = [item];
notify();
await settle();
assert.deepEqual(users(frames.at(-1)!), ["3.0:earlier", "pending.send-1:hello"]);
assert.equal(frames.at(-1)!.status.state, "working");

// Pi placed it and OptChat pruned it, but Pi's frame has not come yet: the
// frame merged from the older transcript still shows it, still working.
pending = [];
notify();
await settle();
assert.deepEqual(users(frames.at(-1)!), ["3.0:earlier", "pending.send-1:hello"], "a shown message never leaves before the log has it");
assert.equal(frames.at(-1)!.status.state, "working", "no idle frame between a send and its run");

// An older frame of Pi (still without it) changes nothing.
await push(transcript("completed", before));
assert.deepEqual(users(frames.at(-1)!), ["3.0:earlier", "pending.send-1:hello"]);
assert.equal(frames.at(-1)!.status.state, "working");

// Pi's frame with the placed message: the log's copy, once, and Pi's status.
await push(transcript("working", [...before, placed]));
assert.deepEqual(users(frames.at(-1)!), ["3.0:earlier", "8.0:hello"]);
assert.equal(frames.at(-1)!.status.state, "working");

// Held no longer: the run's end is shown as it is.
await push(transcript("completed", [...before, placed, { type: "assistant-text", id: "9.0.0", text: "hi", reasoning: false, final: true }]));
assert.deepEqual(users(frames.at(-1)!), ["3.0:earlier", "8.0:hello"]);
assert.equal(frames.at(-1)!.status.state, "completed");

// Every frame of the send, in order: once shown, the message is never missing.
const first = frames.findIndex(frame => users(frame).some(line => line.endsWith(":hello")));
assert.ok(frames.slice(first).every(frame => users(frame).filter(line => line.endsWith(":hello")).length === 1), "shown exactly once from the first frame on");
assert.ok(frames.slice(first, -1).every(frame => frame.status.state === "working"), "working from the send until the run ends");
await watch.stop();

// A read takes the pending messages before the transcript: one pruned in
// between is in the transcript it reads.
const racing: ThreadEvents = { ...inner, async read() { pending = []; return transcript("working", [...before, placed]); } };
pending = [item];
assert.deepEqual(users(await new OptChatEvents(chat, racing).read()), ["3.0:earlier", "8.0:hello"]);
console.log("optchat events: ok");
