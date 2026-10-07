/** A sent message is shown at once and kept until the transcript shows it:
 * never gone in between, never twice, whatever the transcript's ids. */
import assert from "node:assert/strict";
import { echo, echoRows, unanswered, unlogged } from "../src/lib/outbox.ts";
import type { ThreadEvent, ThreadStatus } from "../src/lib/types.ts";

const working: ThreadStatus = { state: "working", run: "r", error: null };
const idle: ThreadStatus = { state: "completed", run: "r", error: null };

const at = (...events: ThreadEvent[]) => ({ events, status: idle });
const said = (id: string, text: string, extra: Partial<Extract<ThreadEvent, { type: "user-message" }>> = {}): ThreadEvent => ({ type: "user-message", id, text, ...extra });
const before = at(said("1.0", "hi"), { type: "assistant-text", id: "2.0.0", text: "hello", reasoning: false, final: true });

// Sent: shown as the user's, sending.
const one = echo(before, [], "a", "fix it", []);
assert.deepEqual(echoRows([one]), [{ kind: "user", id: "echo.a", text: "fix it", sending: true }]);
assert.deepEqual(unanswered(before, [one]), [one], "a transcript without it keeps it");

// The host's pending copy, then the log's copy: either answers it.
assert.deepEqual(unanswered(at(...before.events, said("pending.a", "fix it")), [one]), []);
assert.deepEqual(unanswered(at(...before.events, said("3.0", "fix it")), [one]), []);

// The same words again: the earlier copy does not answer the new one.
const again = echo(at(...before.events, said("3.0", "fix it")), [], "b", "fix it", []);
assert.deepEqual(unanswered(at(...before.events, said("3.0", "fix it")), [again]), [again]);
assert.deepEqual(unanswered(at(...before.events, said("3.0", "fix it"), said("5.0", "fix it")), [again]), []);

// Sent twice before the host shows either: one copy answers one of them only.
const first = echo(before, [], "c", "go", []);
const second = echo(before, [first], "d", "go", []);
assert.deepEqual(unanswered(at(...before.events, said("pending.c", "go")), [first, second]), [second]);
assert.deepEqual(unanswered(at(...before.events, said("pending.c", "go"), said("pending.d", "go")), [first, second]), []);

// Images count: the same text with other images is another message.
const image = { id: "a".repeat(64), mimeType: "image/png" };
const pictured = echo(before, [], "e", "", [image]);
assert.deepEqual(echoRows([pictured])[0]!.images, [image]);
assert.deepEqual(unanswered(at(...before.events, said("pending.e", "")), [pictured]), [pictured]);
assert.deepEqual(unanswered(at(...before.events, said("pending.e", "", { images: [image] })), [pictured]), []);

// A thread's report with the same words is not the user's message.
assert.deepEqual(unanswered(at(...before.events, said("6.0", "fix it", { from: "abcdef12" })), [one]), [one]);
console.log("outbox: ok");

// Kept until the log has it: an older frame without the accepted copy shows
// the echo again; the log's copy retires it for good.
const kept = echo(before, [], "f", "stay", []);
const pendingCopy = at(...before.events, said("pending.f", "stay"));
assert.deepEqual(unanswered(pendingCopy, [kept]), [], "the accepted copy stands in for it");
assert.deepEqual(unlogged({ ...pendingCopy, status: working }, [kept]), [kept], "kept while only accepted");
assert.deepEqual(unanswered(before, unlogged({ ...before, status: idle }, [kept])), [kept], "an older frame shows it again");
assert.deepEqual(unlogged({ ...at(...before.events, said("7.0", "stay")), status: working }, [kept]), []);

// A message the transcript never shows as the user's (a text that reads as
// a thread's report) holds nothing once a newer run ended; an older frame,
// naming the run it was sent after, does not count.
const odd = { ...echo({ ...before, status: idle }, [], "g", "[abcdef12] hi", []), accepted: true };
assert.equal(odd.after, "r");
assert.deepEqual(unlogged({ ...before, status: working }, [odd]), [odd]);
assert.deepEqual(unlogged({ ...before, status: idle }, [odd]), [odd], "an older frame");
assert.deepEqual(unlogged({ ...before, status: { ...idle, run: "r2" } }, [{ ...odd, accepted: false }]), [{ ...odd, accepted: false }], "not before the host took it");
assert.deepEqual(unlogged({ ...before, status: { ...idle, run: "r2" } }, [odd]), []);
console.log("outbox keep: ok");
