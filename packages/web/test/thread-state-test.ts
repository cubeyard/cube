/** The thread's state words and lamp while its machine is suspended or
 * woken (P7-5, B7-2), and the B7-5 notice. */
import assert from "node:assert/strict";
import { lampClass, machineNotice, stateLabel } from "../src/lib/thread-state.ts";
import type { ThreadSummary } from "../src/lib/types.ts";

const thread = (state: ThreadSummary["state"], vm: ThreadSummary["vm"] = { vmId: "0123456789abcdef" }): ThreadSummary =>
  ({ id: "t", title: null, state, error: null, createdAt: 1, archived: false, project: { id: "p", name: "p" }, vm });
const notice = { text: "restarted after an update; running commands were interrupted", at: 2 };

assert.deepEqual([stateLabel(thread("ready")), lampClass(thread("ready"))], [null, "on-green"]);
const asleep = thread("ready", { vmId: "0123456789abcdef", suspension: { state: "suspended", at: 1 } });
assert.deepEqual([stateLabel(asleep), lampClass(asleep)], ["suspended", ""]);
const waking = thread("ready", { vmId: "0123456789abcdef", suspension: { state: "waking", at: 1 } });
assert.deepEqual([stateLabel(waking), lampClass(waking)], ["waking the thread's machine", "on-amber blink"]);
const waiting = thread("ready", { vmId: "0123456789abcdef", suspension: { state: "waking", at: 1, waiting: "waiting for a free slot on runner r" } });
assert.equal(stateLabel(waiting), "waiting for a free slot");
assert.equal(stateLabel(thread("error", { vmId: "0123456789abcdef", suspension: { state: "suspended", at: 1 } })), "error", "an error wins");
assert.equal(stateLabel(thread("starting", { vmId: "0123456789abcdef", suspension: { state: "waking", at: 1 } })), "starting the thread's machine");
assert.equal(machineNotice(thread("ready", { vmId: "0123456789abcdef", notice })), notice.text);
assert.equal(machineNotice(thread("ready", { vmId: "0123456789abcdef", notice, suspension: { state: "suspended", at: 3 } })), null, "not while suspended");
console.log("ok: suspended, waking and waiting for a free slot in the thread's state; the restart notice once it runs");
