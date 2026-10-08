/** OptChat's view, after the spec's two corrections (gist revision 3c190e06):
 * a pair is due by how long ago its LAST message was, in its own line size,
 * `(T - last) / 2^l`; and the view merges in batches, from past its high
 * mark (128 KB) down to its low mark (64 KB), and only grows at its end in
 * between. Pure, offline and deterministic. */
import assert from "node:assert/strict";
import { bytes, due, end, Memory, mostDue, start, VIEW, VIEW_LOW, type Part } from "../src/optchat-memory.ts";

const all = () => true;
const shape = (view: readonly Part[]) => view.map(part => `${start(part)}+${2 ** part.l}`).join(" ");
const tiles = (view: readonly Part[], total: number) => {
  let at = 0;
  for (const part of view) { assert.equal(start(part), at, "the view is contiguous"); at = end(part); }
  assert.equal(at, total, "the view covers the whole chat");
};
/** A node's text for this workload: about 300 bytes, a few longer. */
const summary = (l: number, i: number) => `s${l}.${i} ${"y".repeat(280 + (i * 37 + l * 11) % 200)}`;
function drain(memory: Memory): void {
  for (;;) {
    const jobs = memory.ready(new Set(), 8);
    if (!jobs.length) return;
    for (const { l, i } of jobs) memory.setNode(l, i, summary(l, i));
  }
}
/** The size each batch ended at, seen when its last merge is made: lines
 * built after it still grow from their placeholder to their summary. */
function batchEnds(memory: Memory): number[] {
  const ends: number[] = [];
  let merges = 0;
  memory.onChange = () => {
    if (memory.merges !== merges && !memory.batching) ends.push(memory.bytes);
    merges = memory.merges;
  };
  return ends;
}
/** Lines a call must write past the cached prefix of the previous view. */
const rewritten = (before: readonly Part[], after: readonly Part[]) => {
  let shared = 0;
  while (shared < before.length && shared < after.length && before[shared]!.l === after[shared]!.l && before[shared]!.i === after[shared]!.i) shared++;
  return after.length - shared;
};

assert.equal(VIEW, 128_000);
assert.equal(VIEW_LOW, 64_000);

{
  // Units: a pair's due is (T - last) / 2^l, with `last` its last message.
  assert.equal(due({ l: 0, i: 8 }, 10), 1, "8+1, 9+1 ended at 9: one line ago");
  assert.equal(due({ l: 2, i: 0 }, 10), 0.75, "0+4, 4+4 ended at 7: three messages, 3/4 of its line size");
  // The spec's example: 1-message lines that ended 3 messages ago are as due
  // as 1024-message lines that ended 3072 messages ago.
  assert.equal(due({ l: 0, i: 0 }, 1 + 3), 3);
  assert.equal(due({ l: 10, i: 0 }, 2047 + 3072), 3);
  // The spec's example: at T=10 the push merges 8-9, never the older 0-7.
  const view = [{ l: 2, i: 0 }, { l: 2, i: 1 }, { l: 0, i: 8 }, { l: 0, i: 9 }];
  assert.equal(mostDue(view, 10, all), 2, "the newest pair merges, as push does");
  // Equal pairs: the oldest first.
  assert.equal(mostDue([{ l: 0, i: 0 }, { l: 0, i: 1 }, { l: 1, i: 1 }, { l: 2, i: 1 }, { l: 2, i: 2 }, { l: 2, i: 3 }], 16, all), 0, "of equally due pairs the oldest");
  // Only siblings whose parent is built, never a pair across two parents.
  assert.equal(mostDue(view, 10, (l, i) => !(l === 1 && i === 4)), 0, "an unbuilt parent is skipped");
  assert.equal(mostDue([{ l: 0, i: 1 }, { l: 0, i: 2 }], 3, all), -1, "1 and 2 are not siblings");
  assert.equal(mostDue([{ l: 0, i: 0 }], 1, all), -1, "a single line has no pair");
}

{
  // With his list's length as the budget, the most due merges are exactly
  // Taelin's rollback push at every step (the spec checked t = 0..20,000).
  type List = { keep: number; state: number; older: List } | null;
  const push = (state: number, list: List): List => list === null ? { keep: 0, state, older: null }
    : list.keep === 0 ? { ...list, keep: 1 } : { keep: 0, state, older: push(list.state, list.older) };
  const states = (list: List) => { const out: number[] = []; for (let at = list; at; at = at.older) out.unshift(at.state); return out; };
  let list: List = null;
  const view: Part[] = [];
  for (let t = 0; t <= 20_000; t++) {
    list = push(t, list);
    view.push({ l: 0, i: t });
    const want = states(list);
    while (view.length > want.length) {
      const k = mostDue(view, t + 1, all);
      const a = view[k]!;
      view.splice(k, 2, { l: a.l + 1, i: a.i / 2 });
    }
    if (view.map(start).join() !== want.join()) assert.fail(`at t=${t} the view ${shape(view)} is not push's ${want.join(", ")}`);
  }
}

{
  // The sawtooth: each message appends its line and nothing else changes;
  // once the view passes its high mark, one batch merges the most due pairs
  // until it is at most its low mark. Small marks keep the test quick.
  const high = 12_000, low = 6_000;
  const memory = new Memory({ view: high, low, node: 512 });
  const ends = batchEnds(memory);
  let previous: Part[] = [];
  let batches = 0, merges = 0;
  for (let n = 0; n < 3_000; n++) {
    const before = memory.view.map(part => ({ ...part }));
    const peak = memory.bytes;
    memory.append({ kind: n % 2 ? "talk" : "user", text: `message ${n} ${"z".repeat(600)}`, date: n });
    drain(memory);
    assert.ok(memory.settled());
    tiles(memory.view, memory.length);
    assert.equal(memory.bytes, bytes(memory.render()) - bytes("<chat>\n</chat>"), "size is the rendered lines, ids and newlines included");
    assert.ok(memory.bytes <= high, `never past the high mark once built (${memory.bytes})`);
    if (memory.merges === merges) {
      assert.deepEqual(memory.view.slice(0, before.length), before, "between batches the view only grows at its end");
      assert.equal(memory.view.length, before.length + 1);
    } else {
      batches++;
      assert.ok(ends.length === batches && ends.at(-1)! <= low && ends.at(-1)! > low - 1_000, `a batch ends just under its low mark (${ends.at(-1)})`);
      assert.ok(memory.bytes < low + 1_000, `and the lines built after it add little (${memory.bytes})`);
      assert.ok(peak + 600 > high, "a batch starts only past the high mark");
      assert.equal(memory.batching, false);
      for (const part of previous) assert.ok(memory.view.some(now => start(now) <= start(part) && end(part) <= end(now)), "a merged part is never split");
    }
    merges = memory.merges;
    previous = memory.view.map(part => ({ ...part }));
  }
  assert.ok(batches >= 10, `the view went through many batches (${batches})`);
  assert.ok(memory.view.some(part => part.l >= 6), "old messages fade into coarse lines");
  assert.equal(memory.view.at(-1)!.l, 0, "the newest message keeps its own line");
}

{
  // A batch that cannot reach its low mark (parents not built yet) merges
  // what it can, and goes on at each later message or node until it does.
  const memory = new Memory({ view: 1_000, low: 500, node: 512 });
  for (let n = 0; n < 16; n++) {
    memory.append({ kind: "user", text: `m${n}`, date: n });
    memory.setNode(0, n, `leaf ${n} ${"a".repeat(60)}`);
  }
  assert.ok(memory.bytes > 1_000);
  assert.equal(memory.batching, true, "past the high mark a batch starts");
  assert.equal(memory.merges, 0, "but no parent is built");
  assert.equal(memory.view.length, 16);
  memory.setNode(1, 7, "pair 7");
  assert.equal(shape(memory.view).split(" ").at(-1), "14+2", "a built parent merges at once while the batch is open");
  assert.equal(memory.batching, true, "and the batch stays open");
  memory.append({ kind: "user", text: "m16", date: 16 });
  for (let i = 0; i < 7; i++) memory.setNode(1, i, `pair ${i}`);
  assert.ok(memory.bytes <= 500, `the batch reaches its low mark (${memory.bytes})`);
  assert.equal(memory.batching, false, "and closes");
  const merges = memory.merges;
  memory.setNode(0, 16, "leaf 16");
  memory.append({ kind: "user", text: "m17", date: 17 });
  assert.equal(memory.merges, merges, "a closed batch leaves the view alone below the high mark");
}

{
  // Restart: a stored view (and an open batch with it) restores exactly and
  // goes on the same way as the live one. Without the flag it would not.
  const log = Array.from({ length: 64 }, (_, n) => ({ kind: "user" as const, text: `m${n}`, date: n }));
  const fill = (memory: Memory, upto: number, from = 0) => {
    for (let n = from; n < upto; n++) { memory.append(log[n]!); memory.setNode(0, n, `leaf ${n} ${"a".repeat(60)}`); }
  };
  const live = new Memory({ view: 1_000, low: 500, node: 512 });
  fill(live, 16);
  // The batch merges what it can and stalls between the marks.
  live.setNode(1, 7, "pair 7");
  live.setNode(1, 6, "pair 6");
  assert.ok(live.bytes > 500 && live.bytes <= 1_000, `between the marks (${live.bytes})`);
  assert.equal(live.batching, true);
  const nodes: Array<[number, number, string]> = [];
  for (let l = 0; l < 7; l++) for (let i = 0; i < 64; i++) { const text = live.node(l, i); if (text !== undefined) nodes.push([l, i, text]); }
  const reopen = (batching: boolean) => {
    const memory = new Memory({ view: 1_000, low: 500, node: 512 });
    for (const [l, i, text] of nodes) memory.setNode(l, i, text);
    assert.ok(memory.restore(log.slice(0, 16), live.view, batching));
    return memory;
  };
  const resumed = reopen(live.batching), forgot = reopen(false);
  assert.equal(resumed.render(), live.render(), "the restored view is the stored one");
  for (const memory of [live, resumed, forgot]) { for (let i = 0; i < 4; i++) memory.setNode(1, i, `pair ${i}`); }
  assert.equal(resumed.render(), live.render(), "an open batch goes on after a restart");
  assert.notEqual(forgot.render(), live.render(), "a forgotten batch would leave the view past its low mark");
  fill(live, 40, 16);
  fill(resumed, 40, 16);
  assert.equal(resumed.render(), live.render(), "and the log goes on the same way");
}

{
  // An existing view, folded by the old code (merged at every message to
  // stay under 128 KB, oldest-first due), restores as it was: no line is
  // lost, nothing is rebuilt. The first message past the high mark starts
  // the first batch, down to the low mark, then the sawtooth.
  const oldDue = (view: readonly Part[], total: number) => {
    let best = -1, most = -Infinity;
    for (let k = 0; k + 1 < view.length; k++) {
      const a = view[k]!, b = view[k + 1]!;
      if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1) continue;
      const weight = (total - start(a)) / 2 ** (a.l + 2);
      if (weight > most) { most = weight; best = k; }
    }
    return best;
  };
  const text = (l: number, i: number) => `s${l}.${i} ${"o".repeat(400)}`;
  const line = (part: Part) => bytes(`${start(part)}+${2 ** part.l}|${text(part.l, part.i)}`) + 1;
  const total = 2_000;
  const old: Part[] = [];
  for (let n = 0; n < total; n++) {
    old.push({ l: 0, i: n });
    while (old.reduce((sum, part) => sum + line(part), 0) > 120_000) {
      const k = oldDue(old, n + 1), a = old[k]!;
      old.splice(k, 2, { l: a.l + 1, i: a.i / 2 });
    }
  }
  const memory = new Memory({ node: 512 });
  const ends = batchEnds(memory);
  for (let l = 0; 2 ** l <= total; l++) for (let i = 0; (i + 1) * 2 ** l <= total; i++) memory.setNode(l, i, text(l, i));
  const log = Array.from({ length: total }, (_, n) => ({ kind: "user" as const, text: `m${n}`, date: n }));
  assert.ok(memory.restore(log, old), "an old stored view, without a batch flag, restores");
  assert.equal(shape(memory.view), shape(old), "as it was");
  assert.equal(memory.bytes, bytes(memory.render()) - bytes("<chat>\n</chat>"), "a restore counts the rendered lines too");
  assert.equal(memory.merges, 0);
  let n = total;
  while (memory.merges === 0) {
    memory.append({ kind: "user", text: `m${n}`, date: n });
    memory.setNode(0, n, text(0, n));
    for (let l = 1; (n + 1) % 2 ** l === 0; l++) memory.setNode(l, (n + 1) / 2 ** l - 1, text(l, (n + 1) / 2 ** l - 1));
    n++;
  }
  assert.equal(ends.length, 1);
  assert.ok(ends[0]! <= VIEW_LOW && ends[0]! > VIEW_LOW - 1_000, `the first batch ends just under the low mark (${ends[0]})`);
  tiles(memory.view, memory.length);
  // Navigation after compaction: every line still opens down to its message.
  for (const part of memory.view) {
    let at: Part = part;
    while (at.l > 0) {
      const halves = memory.zoom(start(at), 2 ** at.l).split("\n");
      assert.equal(halves.length, 2);
      assert.ok(!halves.some(half => half.includes("not summarized")), "both halves are built");
      at = { l: at.l - 1, i: 2 * at.i + 1 };
    }
    assert.equal(memory.zoom(start(at), 1), `${start(at)}+0|user: m${start(at)}`, "down to the message, word for word");
    assert.equal(memory.messages[start(at)]!.date, start(at), "with its date");
  }
}

{
  // The representative workload: 10,000 messages of mixed size, nodes about
  // 300-500 bytes, the spec's marks. Batching keeps the same merges in the
  // same order and only changes their timing; it rewrites far fewer lines
  // per message than merging at every message (high mark = low mark).
  const run = (low: number) => {
    const memory = new Memory({ view: VIEW, low, node: 512 });
    const ends = batchEnds(memory);
    let previous: Part[] = [], lines = 0, rewrites = 0, peak = 0;
    for (let n = 0; n < 10_000; n++) {
      const merges = memory.merges;
      memory.append({ kind: n % 3 ? "talk" : "user", text: `message ${n} ${"q".repeat(n % 7 ? 100 : 900)}`, date: n });
      drain(memory);
      lines += rewritten(previous, memory.view);
      if (memory.merges !== merges) rewrites++;
      peak = Math.max(peak, memory.bytes);
      previous = memory.view.map(part => ({ ...part }));
    }
    return { memory, lines: lines / 10_000, rewrites, merges: memory.merges, peak, trough: Math.max(...ends) };
  };
  const batched = run(VIEW_LOW), every = run(VIEW);
  assert.ok(batched.peak <= VIEW, `the view stays at most 128 KB (${batched.peak})`);
  assert.ok(batched.trough <= VIEW_LOW, `and every batch ends at most at 64 KB (${batched.trough})`);
  assert.ok(batched.rewrites * 50 < every.rewrites, `batches are rare (${batched.rewrites} vs ${every.rewrites} messages that changed old lines)`);
  assert.ok(batched.lines * 4 < every.lines, `and rewrite far fewer lines per message (${batched.lines.toFixed(1)} vs ${every.lines.toFixed(1)})`);
  console.log(`optchat view workload (10,000 messages, simulated): batched ${batched.rewrites} rewrites, ${batched.merges} merges, ${batched.lines.toFixed(1)} lines written per message; every message ${every.rewrites} rewrites, ${every.merges} merges, ${every.lines.toFixed(1)} lines`);
}

console.log("optchat view: ok");
