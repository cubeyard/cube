/** A report's one line: cube's state word for each form cubed sends, the
 * thread's own words after it, failures marked so they stand open. */
import assert from "node:assert/strict";
import { reportLine } from "../src/lib/report-line.ts";

assert.deepEqual(reportLine("ended its turn; nothing of it runs now: Pushed #285, ci 7/7."),
  { state: "turn ended", failed: false, summary: "Pushed #285, ci 7/7." });
assert.deepEqual(reportLine("ended its turn; nothing of it runs now without a reply"),
  { state: "turn ended", failed: false, summary: "" });
assert.deepEqual(reportLine("ended its turn, waiting on its background agent; another report comes when it finishes: Started the build."),
  { state: "turn ended · waiting", failed: false, summary: "Started the build." });
assert.deepEqual(reportLine("ended its turn; nothing of it runs now and nothing wakes it, though its reply speaks of waiting: it goes on only when told: I will check CI later."),
  { state: "turn ended", failed: false, summary: "I will check CI later." });
assert.deepEqual(reportLine("failed: the provider refused; last reply: half done"),
  { state: "failed", failed: true, summary: "the provider refused; last reply: half done" });
assert.deepEqual(reportLine("failed to start for 95 s; cubed keeps retrying: no runner answered"),
  { state: "failed to start", failed: true, summary: "no runner answered" });
assert.deepEqual(reportLine("its machine failed to wake for 40 s: out of memory"),
  { state: "machine failed to wake", failed: true, summary: "out of memory" });
assert.deepEqual(reportLine("stopped; last reply: got halfway"), { state: "stopped", failed: false, summary: "got halfway" });
assert.deepEqual(reportLine("turn ended. The test waited on a **140ms** settle-in."), { state: "turn ended", failed: false, summary: "The test waited on a 140ms settle-in." });
assert.deepEqual(reportLine("something else entirely"), { state: null, failed: false, summary: "something else entirely" });
assert.ok(reportLine(`ended its turn; nothing of it runs now: ${"long words ".repeat(40)}`).summary.length <= 160, "the summary is cut to one line's worth");
console.log("ok: a report's state, its words and whether it stands open");
