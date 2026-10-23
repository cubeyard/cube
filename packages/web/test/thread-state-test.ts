/** The thread's state words while its machine is suspended or
 * woken (P7-5, B7-2), and the B7-5 notice. */
import assert from "node:assert/strict";
import { composerWaiting, machineLabel, machineNotice, STARTING_TEXT, stateLabel } from "../src/lib/thread-state.ts";
import type { ThreadSummary } from "../src/lib/types.ts";

const thread = (state: ThreadSummary["state"], vm: ThreadSummary["vm"] = { vmId: "0123456789abcdef" }): ThreadSummary =>
  ({ id: "t", title: null, state, error: null, createdAt: 1, archived: false, project: { id: "p", name: "p" }, vm });
const notice = { text: "restarted after an update; running commands were interrupted", at: 2 };

assert.equal(stateLabel(thread("ready")), null, "ready says nothing");
const asleep = thread("ready", { vmId: "0123456789abcdef", suspension: { state: "suspended", at: 1 } });
assert.equal(stateLabel(asleep), "suspended");
const waking = thread("ready", { vmId: "0123456789abcdef", suspension: { state: "waking", at: 1 } });
assert.equal(stateLabel(waking), "waking the thread's machine");
const waiting = thread("ready", { vmId: "0123456789abcdef", suspension: { state: "waking", at: 1, waiting: "waiting for a free slot on runner r" } });
assert.equal(stateLabel(waiting), "waiting for a free slot");
assert.equal(stateLabel(thread("error", { vmId: "0123456789abcdef", suspension: { state: "suspended", at: 1 } })), "error", "an error wins");
// U-207-2: each try of a wake starts the machine (the API says starting);
// the label stays on what the wake waits for.
assert.equal(stateLabel(thread("starting", { vmId: "0123456789abcdef", suspension: { state: "waking", at: 1 } })), "waking the thread's machine");
assert.equal(stateLabel(thread("starting", { vmId: "0123456789abcdef", suspension: { state: "waking", at: 1, waiting: "waiting for a free slot on runner r" } })), "waiting for a free slot");
assert.equal(stateLabel(thread("starting")), "starting the thread's machine");
// The composer: a start or a wait for a slot holds messages, saying why; a suspended machine takes one (it wakes it).
assert.equal(composerWaiting(thread("starting")), STARTING_TEXT);
assert.equal(composerWaiting(asleep), null);
assert.equal(composerWaiting(waking), "waking the thread's machine…");
assert.equal(composerWaiting({ ...waiting, state: "starting" }), "waiting for a free slot…");
assert.equal(composerWaiting(thread("ready")), null);
assert.equal(machineNotice(thread("ready", { vmId: "0123456789abcdef", notice })), notice.text);
assert.equal(machineNotice(thread("ready", { vmId: "0123456789abcdef", notice, suspension: { state: "suspended", at: 3 } })), null, "not while suspended");
// A protocol-3 thread's record from before: a template whose seal failed still reads as it was.
const sealed = machineLabel(thread("ready", { vmId: "0123456789abcdef",
  preparation: { source: "template", templateId: "a000000000000001", sealFailure: "failed: /etc/machine-id" } } as ThreadSummary["vm"]));
assert.match(sealed!.title, /the template's seal failed \(failed: \/etc\/machine-id\); it was removed/);
console.log("ok: suspended, waking and waiting for a free slot in the thread's state (a wake's own starts do not flicker it) and the composer; the restart notice once it runs; an old seal failure still reads");
