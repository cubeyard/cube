/** OptChat's tree and view, without a model: the fold keeps the view under
 * its budget, tiles the whole chat, never splits, changes mostly at its end,
 * and the compactor only ever gets summaries. */
import assert from "node:assert/strict";
import { bytes, capText, CUT_MARK, cutBytes, cutNode, end, Memory, pages, PLACEHOLDER, start, type Part } from "../src/optchat-memory.ts";
import { createModels, fauxAssistantMessage, fauxProvider, type AssistantMessage } from "@earendil-works/pi-ai";
import { candidates, compactNode, failure, lengths, SCALE, versions } from "../src/optchat-compactor.ts";
import { entryMessages, runReport, threadReport, ZOOM_ECHO } from "../src/optchat.ts";

assert.equal(bytes(SCALE), 512, "the scale line is exactly NODE bytes");
assert.equal(cutBytes("aé", 2), "a", "a cut never splits a character");
assert.match(capText("x".repeat(100), 80), /characters cut/);

const tiles = (view: readonly Part[], total: number) => {
  let at = 0;
  for (const part of view) { assert.equal(start(part), at, "the view is contiguous"); at = end(part); }
  assert.equal(at, total, "the view covers the whole chat");
};

// Building everything the pump allows, in its order, with a fake compactor.
function drain(memory: Memory, seen: string[][] = []): void {
  for (;;) {
    const jobs = memory.ready(new Set(), 8);
    if (!jobs.length) return;
    for (const { l, i } of jobs) {
      const context = memory.context(l, i);
      assert.ok(!context.includes(PLACEHOLDER), "the compactor never sees a placeholder");
      assert.ok(context.every(line => !/^\d+\+\d+\|/.test(line)), "no ids reach the compactor");
      seen.push(context);
      const source = memory.source(l, i);
      memory.setNode(l, i, "free" in source ? source.free : `s${l}.${i} ${"y".repeat(40)}`);
    }
  }
}

{
  const memory = new Memory({ view: 2_000, node: 120 });
  let previous: Part[] = [];
  let sharedTotal = 0;
  for (let n = 0; n < 300; n++) {
    memory.append({ kind: n % 2 ? "talk" : "user", text: n % 7 === 0 ? `long ${"z".repeat(400)} ${n}` : `m${n}`, date: n });
    // Only the newest message may be unsummarized while the compactor works.
    assert.ok(memory.view.slice(0, -1).every(part => memory.built(part.l, part.i)), "older lines are summaries");
    drain(memory);
    assert.ok(memory.settled());
    tiles(memory.view, memory.length);
    const size = memory.view.reduce((sum, part) => sum + bytes(memory.node(part.l, part.i)!), 0);
    assert.ok(size <= 2_000, `the view fits its budget (${size})`);
    // Never split: every earlier part lies inside one current part.
    for (const part of previous) {
      assert.ok(memory.view.some(now => start(now) <= start(part) && end(part) <= end(now)), "a merged part is never split");
    }
    let shared = 0;
    while (shared < previous.length && shared < memory.view.length && previous[shared]!.l === memory.view[shared]!.l && previous[shared]!.i === memory.view[shared]!.i) shared++;
    sharedTotal += previous.length ? shared / previous.length : 1;
    previous = memory.view.map(part => ({ ...part }));
  }
  assert.ok(memory.view.some(part => part.l >= 3), "old messages fade into coarse lines");
  assert.equal(memory.view.at(-1)!.l, 0, "the newest message keeps its own line");
  assert.ok(sharedTotal / 300 > 0.6, `consecutive views share most of their start (${(sharedTotal / 300).toFixed(2)})`);
  const rendered = memory.render();
  assert.match(rendered, /^<chat>\n0\+\d+\|/);
  assert.match(rendered, /\n299\+1\|talk: m299\n<\/chat>$/);
}

{
  // Order: messages start while fewer than 8 lines before them are unbuilt,
  // in order; a merge once both halves are built (optchat-compaction-view-test.ts).
  const memory = new Memory({ node: 20 });
  for (const text of ["a".repeat(50), "b".repeat(50), "short"]) memory.append({ kind: "user", text, date: 0 });
  assert.deepEqual(memory.ready(new Set(), 8), [{ l: 0, i: 0 }, { l: 0, i: 1 }, { l: 0, i: 2 }], "messages in order, beside each other");
  assert.deepEqual(memory.ready(new Set(["0:0"]), 2), [{ l: 0, i: 1 }], "busy nodes count against the limit");
  memory.setNode(0, 0, "u: a");
  assert.deepEqual(memory.ready(new Set(), 8), [{ l: 0, i: 1 }, { l: 0, i: 2 }]);
  assert.deepEqual(memory.source(0, 2), { free: "user: short" }, "a short message is its own line");
  assert.deepEqual(memory.source(0, 1), { message: `user: ${"b".repeat(50)}` });
  memory.setNode(0, 1, "u: b");
  assert.deepEqual(memory.ready(new Set(), 8), [{ l: 0, i: 2 }, { l: 1, i: 0 }], "merges run beside the next message");
  assert.deepEqual(memory.ready(new Set(["0:2"]), 2), [{ l: 1, i: 0 }], "busy nodes count against the limit");
  assert.deepEqual(memory.source(1, 0), { free: "u: a\nu: b" });
  memory.setNode(0, 2, "user: short");
  memory.setNode(1, 0, "u: a\nu: b");
  assert.equal(memory.zoom(0, 1), `0+0|user: ${"a".repeat(50)}`, "n = 1 gives the message whole");
  assert.equal(memory.zoom(0, 2), "0+1|u: a\n1+1|u: b");
  for (const [id, n] of [[1, 2], [0, 3], [2, 2], [0, 4], [-1, 1]] as const) assert.equal(memory.zoom(id, n), `No line ${id}+${n}.`);
}

{
  // The log holds replies, tool calls and capped results; thoughts are never logged.
  const assistant = { id: 2, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", timestamp: 5, content: [
    { type: "thinking", thinking: "secret plan" }, { type: "text", text: "on it" }, { type: "toolCall", id: "c", name: "zoom", arguments: { id: 0, n: 1 } },
  ] }] } as never;
  assert.deepEqual(entryMessages(assistant), [{ kind: "talk", text: "on it", date: 5 }, { kind: "tool", text: 'zoom {"id":0,"n":1}', date: 5 }]);
  const result = { id: 3, conversationId: 1, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "c", toolName: "threads", isError: false, timestamp: 6,
    content: [{ type: "text", text: "x".repeat(40_000) }] }] } as never;
  assert.ok(entryMessages(result)[0]!.text.length <= 30_000, "tool results are capped");
  const bigCall = { id: 7, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", timestamp: 5, content: [
    { type: "toolCall", id: "d", name: "spawn", arguments: { tasks: [{ project: "cube", task: "y".repeat(40_000) }] } },
  ] }] } as never;
  assert.ok(entryMessages(bigCall)[0]!.text.length <= 30_000, "tool call arguments are capped too");
  // A zoom result copies the chat: its ids and "user:" tags must not reach
  // the compactor as new words of the user, nor be summarized again.
  const zoomed = (text: string) => entryMessages({ id: 6, conversationId: 1, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "c", toolName: "zoom", isError: false, timestamp: 6,
    content: [{ type: "text", text }] }] } as never);
  assert.deepEqual(zoomed("2+0|user: here are my notes\n...6 KB..."), [{ kind: "echo", text: ZOOM_ECHO, date: 6 }], "a zoom result is logged as a pointer");
  assert.deepEqual(zoomed("No line 5+2."), [{ kind: "echo", text: "No line 5+2.", date: 6 }], "a refused zoom stays as it was");
  assert.deepEqual(entryMessages({ id: 4, conversationId: 1, kind: "optchat.turn" } as never), [], "turn markers are not messages");
  const attempt = (stopReason: string) => ({ id: 5, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", timestamp: 7, stopReason, content: [
    { type: "text", text: "half a reply" }, { type: "toolCall", id: "d", name: "spawn", arguments: {} },
  ] }] }) as never;
  assert.deepEqual(entryMessages(attempt("error")), [], "a failed attempt is not logged");
  assert.deepEqual(entryMessages(attempt("aborted")), [{ kind: "talk", text: "half a reply", date: 7 }], "an aborted reply ran none of its calls");
}

{
  const transcript = (state: "completed" | "failed", events: unknown[]) => ({ agent: "pi" as const, owner: null, status: { state, run: "r", error: state === "failed" ? "boom" : null }, events: events as never });
  assert.equal(threadReport(transcript("completed", [
    { type: "user-message", id: "1", text: "do it" }, { type: "assistant-text", id: "2", text: "thinking", reasoning: true, final: true },
    { type: "assistant-text", id: "3", text: "done: PR #1", reasoning: false, final: true },
  ])), "ended its turn; nothing of it runs now: done: PR #1", "a report says how the turn ended, never that the task is done");
  assert.equal(threadReport(transcript("failed", [{ type: "user-message", id: "1", text: "do it" }])), "failed: boom");
  // A tracked wait, an untracked one, an empty reply, a stop with its reason.
  const status = (state: "completed" | "stopped", extra: object = {}) => ({ state, run: "r", error: null, ...extra });
  assert.equal(runReport(status("completed", { waiting: ["fable review"] }), "PR #3 is open; waiting for the review"),
    "ended its turn, waiting on its background agent \"fable review\"; another report comes when it finishes: PR #3 is open; waiting for the review");
  assert.match(runReport(status("completed", { waiting: ["a", "b"] }), ""), /waiting on its 2 background agents \("a", "b"\); another report comes when they finish without a reply$/);
  for (const reply of ["PR #3 is open, awaiting review.", "PR #3 is open. Waiting for CI to finish.", "pushed; the checks are still running", "I'll report back once CI is green"]) {
    assert.match(runReport(status("completed"), reply), /^ended its turn; nothing of it runs now and nothing wakes it, though its reply speaks of waiting: it goes on only when told: /, reply);
  }
  assert.equal(runReport(status("completed"), "merged as abc123; nothing left"), "ended its turn; nothing of it runs now: merged as abc123; nothing left");
  assert.equal(runReport(status("completed"), " "), "ended its turn; nothing of it runs now without a reply");
  assert.equal(runReport(status("stopped", { error: "background agent \"x\" did not finish: stopped in cube" }), "half"), "stopped: background agent \"x\" did not finish: stopped in cube; last reply: half");
}

{
  // A stored view restores exactly, then the log goes on from it.
  const live = new Memory({ view: 600, node: 60 });
  const log = Array.from({ length: 40 }, (_, n) => ({ kind: "user" as const, text: `message ${n} ${"p".repeat(n % 3 ? 5 : 70)}`, date: n }));
  for (const message of log.slice(0, 30)) { live.append(message); drain(live); }
  const parts = live.view.map(part => ({ ...part }));
  const nodes: Array<[number, number, string]> = [];
  for (let l = 0; l < 6; l++) for (let i = 0; i < 40; i++) { const text = live.node(l, i); if (text !== undefined) nodes.push([l, i, text]); }
  const reopened = new Memory({ view: 600, node: 60 });
  for (const [l, i, text] of nodes) reopened.setNode(l, i, text);
  assert.ok(reopened.restore(log.slice(0, 30), parts));
  assert.equal(reopened.render(), live.render(), "the restored view is the stored one");
  for (const message of log.slice(30)) { live.append(message); reopened.append(message); }
  assert.equal(reopened.render(), live.render(), "and goes on the same way");
  const gap = new Memory({ view: 600, node: 60 });
  assert.equal(gap.restore(log.slice(0, 30), parts), false, "unbuilt parts are refused");
}

// One compactor answer brings three lengths; the longest that fits is kept
// without another call. Word counts, not bytes: Luna overshot byte limits
// on 2.7 calls per node, and one call per node with three lengths.
assert.deepEqual(lengths(512), [26, 48, 69], "about 26, 48 and 69 words around 512 bytes");
assert.deepEqual(candidates("1. user: a\n\n- user: b\nuser: c"), ["user: a", "user: b", "user: c"], "list markers and blank lines go");
{
  const replies: string[][] = [];
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses([
    () => fauxAssistantMessage(["user: short", `user: middle ${"m".repeat(40)}`, `user: long ${"l".repeat(80)}`].join("\n")),
    () => fauxAssistantMessage(["user: ".concat("a".repeat(70)), "user: ".concat("b".repeat(80)), "user: ".concat("c".repeat(90))].join("\n")),
    request => { replies.push(request.messages.map(message => JSON.stringify(message.content))); return fauxAssistantMessage(["user: tiny", "user: fits", "user: fits now"].join("\n")); },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: faux.getModel().provider, id: faux.getModel().id };
  assert.equal(await compactNode({ models, model, context: [], source: { message: "x".repeat(200) }, node: 64 }), `user: middle ${"m".repeat(40)}`, "the longest line that fits");
  assert.equal(await compactNode({ models, model, context: [], source: { merge: ["a", "b"] }, node: 64 }), "user: fits now", "none fits: told, then the longest that fits");
  assert.match(replies[0]!.at(-1)!, /All three are over 64 bytes; the shortest is 76 bytes/, "the feedback names the shortest");
}

// Only an answer of exactly three versions (or the one line) counts; a
// heading or a version broken in two is not one.
assert.deepEqual(versions("1. user: a\n\n- user: b\nuser: c"), ["user: a", "user: b", "user: c"]);
assert.equal(versions("Here are three versions:\nuser: a\nuser: b"), null, "a heading is not a version");
assert.equal(versions("user: a\nuser: b\nuser: c and\nd"), null, "nor half a line");
assert.equal(versions("user: a\nuser: b"), null, "two are not three");
assert.deepEqual(versions("user: the one line"), ["user: the one line"], "one line is the spec's own answer");
assert.equal(versions("Here they are:"), null);

// A failed reply cuts its node only when the failure is the input's doing.
{
  const reply = (errorMessage: string, input: number, stopReason: "error" | "aborted" = "error") => ({ role: "assistant", content: [], api: "x", provider: "x", model: "x", stopReason, errorMessage, timestamp: 0,
    usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: input, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }) as AssistantMessage;
  assert.equal(failure(reply("prompt is too long: 213500 tokens > 200000 maximum", 0)), "cut", "an input too long (its digits are no 500)");
  assert.equal(failure(reply("The model refused to complete the request", 812)), "cut", "a refusal the model began");
  assert.equal(failure(reply("Provider stopped with: sensitive", 812)), "cut", "a safety stop");
  assert.equal(failure(reply("503 Service Unavailable", 0)), "hold", "an outage");
  assert.equal(failure(reply("overloaded_error: Overloaded", 812)), "hold", "an outage mid-answer");
  assert.equal(failure(reply("429 rate limit exceeded", 0)), "hold", "a rate limit");
  assert.equal(failure(reply("401 invalid x-api-key", 0)), "hold", "a setup error never reached the model");
  assert.equal(failure(reply("You exceeded your current quota (insufficient_quota)", 0)), "hold", "nor a quota");
  assert.equal(failure(reply("", 812, "aborted")), "hold", "a stop is not the input's doing");
}

// A node cut short says so, keeps the start of its message (or of both
// halves of a merge) and fits.
{
  const cut = cutNode({ message: `user: ${"é".repeat(400)}` }, 512);
  assert.ok(cut.startsWith(CUT_MARK + "user: éé") && bytes(cut) <= 512 && !cut.includes("�"));
  const merged = cutNode({ merge: [`user: first ${"a".repeat(600)}`, `talk: second ${"b".repeat(600)}`] }, 512);
  assert.ok(merged.startsWith(CUT_MARK + "user: first") && merged.includes(" talk: second") && bytes(merged) <= 512, "both halves stay findable");
}

// A long text in pages: never cut, split after a newline where there is one,
// never inside a character.
{
  const text = Array.from({ length: 300 }, (_, n) => `line ${n} ${"x".repeat(n % 50)}`).join("\n");
  const split = pages(text, 1_000);
  assert.equal(split.join(""), text);
  assert.ok(split.length > 5 && split.every(page => page.length <= 1_000) && split.slice(0, -1).every(page => page.endsWith("\n")));
  const emoji = "😀".repeat(30);
  const odd = pages(emoji, 7);
  assert.equal(odd.join(""), emoji);
  assert.ok(odd.every(page => !/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(page)), "a page never splits a surrogate pair");
  assert.deepEqual(pages(""), [""], "an empty message is one");
}

// A message longer than a page, logged before pages, zooms a page at a time.
{
  const memory = new Memory({ node: 64 });
  const long = Array.from({ length: 4_000 }, (_, n) => `row ${n}`).join("\n");
  memory.append({ kind: "user", text: long, date: 0 });
  const line = `user: ${long}`;
  let at = 0, joined = "";
  for (let k = 0; k < 10; k++) {
    const page = memory.zoom(0, 1, at);
    assert.ok(page.startsWith("0+0|") && page.length <= 30_000 + 100, "a page at most 30,000 characters");
    const [, body = "", next] = /^0\+0\|([^]*?)(?:\n\[characters \d+-(\d+) of \d+; go on with at = \d+\])?$/.exec(page)!;
    joined += body;
    if (!next) break;
    at = Number(next);
  }
  assert.equal(joined, line, "the pages are the message whole");
  assert.match(memory.zoom(0, 1, line.length), /^No characters from/);
  memory.append({ kind: "talk", text: "short", date: 1 });
  assert.equal(memory.zoom(1, 1), "1+0|talk: short", "a short one comes whole as before");
}

// How many messages each entry gives decides every later id; this locks it.
// A change here must keep old entries' counts (see "shape" in optchat.ts).
{
  const user = (text: string) => ({ id: 1, conversationId: 1, kind: "pi.user", model: [{ role: "user", timestamp: 1, content: text }] }) as never;
  const reply = (stopReason: string, texts: string[], calls: number) => ({ id: 2, conversationId: 1, kind: "pi.assistant", model: [{ role: "assistant", timestamp: 2, stopReason, content: [
    { type: "thinking", thinking: "t" }, ...texts.map(text => ({ type: "text", text })), ...Array.from({ length: calls }, (_, k) => ({ type: "toolCall", id: `c${k}`, name: "zoom", arguments: { id: 0, n: 1, x: "y".repeat(40_000) } })),
  ] }] }) as never;
  const result = (text: string) => ({ id: 3, conversationId: 1, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "c", toolName: "threads", isError: false, timestamp: 3, content: [{ type: "text", text }] }] }) as never;
  const long = "z".repeat(70_000);
  const counts = (page?: number) => [user("hi"), user(long), reply("stop", ["a", " ", long], 2), reply("aborted", ["a"], 2), reply("error", ["a"], 2), result(long), { id: 4, conversationId: 1, kind: "optchat.turn" } as never]
    .map(entry => entryMessages(entry, page).length);
  assert.deepEqual(counts(), [1, 1, 4, 1, 0, 1, 0], "before pages: one message per text, call and result");
  assert.deepEqual(counts(30_000), [1, 3, 6, 1, 0, 1, 0], "in pages: a long message or reply is 3 pages of 30,000; results and calls stay capped");
}

console.log("optchat memory: ok");
