/** OptChat's tree and view, without a model: the fold keeps the view under
 * its budget, tiles the whole chat, never splits, changes mostly at its end,
 * and the compactor only ever gets summaries. */
import assert from "node:assert/strict";
import { bytes, capText, cutBytes, end, Memory, PLACEHOLDER, start, type Part } from "../src/optchat-memory.ts";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { candidates, compactNode, lengths, SCALE } from "../src/optchat-compactor.ts";
import { entryMessages, threadReport, ZOOM_ECHO } from "../src/optchat.ts";

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
  // Order: message i is compressed only after every line before it is a summary.
  const memory = new Memory({ node: 20 });
  for (const text of ["a".repeat(50), "b".repeat(50), "short"]) memory.append({ kind: "user", text, date: 0 });
  assert.deepEqual(memory.ready(new Set(), 8), [{ l: 0, i: 0 }], "one message at a time, in order");
  memory.setNode(0, 0, "u: a");
  assert.deepEqual(memory.ready(new Set(), 8), [{ l: 0, i: 1 }]);
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
  ])), "done: PR #1");
  assert.equal(threadReport(transcript("failed", [{ type: "user-message", id: "1", text: "do it" }])), "failed: boom");
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
    request => { replies.push(request.messages.map(message => JSON.stringify(message.content))); return fauxAssistantMessage(["user: tiny", "user: fits now"].join("\n")); },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: faux.getModel().provider, id: faux.getModel().id };
  assert.equal(await compactNode({ models, model, context: [], source: { message: "x".repeat(200) }, node: 64 }), `user: middle ${"m".repeat(40)}`, "the longest line that fits");
  assert.equal(await compactNode({ models, model, context: [], source: { merge: ["a", "b"] }, node: 64 }), "user: fits now", "none fits: told, then the longest that fits");
  assert.match(replies[0]!.at(-1)!, /All three are over 64 bytes; the shortest is 76 bytes/, "the feedback names the shortest");
}

console.log("optchat memory: ok");
