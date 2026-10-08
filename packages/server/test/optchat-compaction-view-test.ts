/** OptChat's compaction view and build order, after spec §4 (gist revision
 * 3c190e06): a compaction reads its own view, the chat's view merged further
 * to 16-32 KB in the same sawtooth (merged down to 16 KB, appended to, merged
 * again once past 32 KB or when the chat's view merges), ending at the node
 * and at the first unbuilt line; a message's node starts once fewer than 8
 * lines before it are unbuilt, a merge once both halves are built. Pure,
 * offline and deterministic. */
import assert from "node:assert/strict";
import { bytes, COMPACTION, COMPACTION_LOW, end, Memory, PLACEHOLDER, start, UNBUILT, VIEW, type Part } from "../src/optchat-memory.ts";

const flat = (text: string) => text.replace(/\s*\n\s*/g, " ");
const same = (a: readonly Part[], b: readonly Part[]) => a.length === b.length && a.every((part, k) => part.l === b[k]!.l && part.i === b[k]!.i);
const prefix = (before: readonly Part[], after: readonly Part[]) => before.length <= after.length && same(before, after.slice(0, before.length));
const tiles = (parts: readonly Part[], total: number) => {
  let at = 0;
  for (const part of parts) { assert.equal(start(part), at, "contiguous"); at = end(part); }
  assert.equal(at, total, "covers the whole chat");
};
/** Each compaction part is a run of whole view parts. */
const coarsens = (memory: Memory) => {
  const starts = new Set(memory.view.map(start));
  return memory.compaction.every(part => starts.has(start(part)));
};
/** The compaction view's size from scratch: built lines, bare, with newlines. */
const measured = (memory: Memory) => memory.compaction.reduce((sum, part) => {
  const text = memory.node(part.l, part.i);
  return sum + (text === undefined ? 0 : bytes(flat(text)) + 1);
}, 0);
/** A node's text for the workload: about 300 bytes, a few longer. */
const summary = (l: number, i: number) => `s${l}.${i} ${"y".repeat(280 + (i * 37 + l * 11) % 200)}`;
function drain(memory: Memory, text = summary): void {
  for (;;) {
    const jobs = memory.ready(new Set(), 8);
    if (!jobs.length) return;
    for (const { l, i } of jobs) {
      const context = memory.context(l, i);
      assert.ok(!context.includes(PLACEHOLDER), "a compaction never sees a placeholder");
      memory.setNode(l, i, text(l, i));
    }
  }
}

assert.equal(COMPACTION, 32_000);
assert.equal(COMPACTION_LOW, 16_000);
assert.equal(UNBUILT, 8);

{
  // The start rule at its boundary: fewer than 8 unbuilt lines before a
  // message, not 8. Twenty messages, nothing built yet.
  const memory = new Memory({ node: 8 });
  for (let n = 0; n < 20; n++) memory.append({ kind: "user", text: `message ${n} is long`, date: n });
  const ids = (jobs: Array<{ l: number; i: number }>) => jobs.map(job => `${job.l}:${job.i}`);
  assert.deepEqual(ids(memory.ready(new Set(), 100)), ["0:0", "0:1", "0:2", "0:3", "0:4", "0:5", "0:6", "0:7"],
    "message 7 has 7 unbuilt lines before it and starts; message 8 has 8 and waits");
  const busy = new Set(["0:0", "0:1", "0:2", "0:3", "0:4", "0:5", "0:6", "0:7"]);
  assert.deepEqual(memory.ready(busy, 100), [], "lines being built still count as unbuilt");
  memory.setNode(0, 3, "m3");
  assert.deepEqual(ids(memory.ready(new Set(), 100)).filter(id => id.startsWith("0:")), ["0:0", "0:1", "0:2", "0:4", "0:5", "0:6", "0:7", "0:8"],
    "out of order: 7 unbuilt before message 8, 8 before message 9");
  memory.setNode(0, 0, "m0");
  assert.ok(ids(memory.ready(new Set(), 100)).includes("0:9"), "the oldest one built lets the next start");
  assert.ok(!ids(memory.ready(new Set(), 100)).includes("0:10"));
  // A merge starts once both its halves are built, gaps before it or not.
  memory.setNode(0, 5, "m5");
  assert.ok(!ids(memory.ready(new Set(), 100)).includes("1:2"), "one half is not enough");
  memory.setNode(0, 4, "m4");
  assert.ok(ids(memory.ready(new Set(), 100)).includes("1:2"), "both halves: merges while messages 1 and 2 still wait");
  // A compaction's view stops at the first unbuilt line.
  assert.deepEqual(memory.context(0, 9), ["m0"], "message 9 reads line 0, then stops at the unbuilt line 1");
  assert.deepEqual(memory.context(1, 2), ["m0"], "so does a merge");
  memory.setNode(0, 1, "m1"); memory.setNode(0, 2, "m2");
  assert.deepEqual(memory.context(1, 2), ["m0", "m1", "m2", "m3", "m4", "m5"], "a merge's view runs up to its last message");
  assert.deepEqual(memory.context(0, 6), ["m0", "m1", "m2", "m3", "m4", "m5"], "a message's view holds the lines before it");
}

{
  // The sawtooth at its marks, with the chat's view never merging: 8-byte
  // lines ("user: a" and its newline) and 2-byte merged lines.
  const memory = new Memory({ view: 1e9, compaction: 80, compactionLow: 40, node: 512 });
  const text = (l: number) => l === 0 ? "user: a" : "m";
  const add = () => { memory.append({ kind: "user", text: "a", date: 0 }); drain(memory, text); };
  assert.equal(memory.compactionBytes, 0);
  memory.append({ kind: "user", text: "a", date: 0 });
  assert.equal(memory.compactionBytes, 0, "an unbuilt line counts nothing: a compaction never reads it");
  drain(memory, text);
  assert.equal(memory.compactionBytes, 8, "a built line: its bare text and newline");
  for (let n = 1; n < 10; n++) add();
  assert.equal(memory.compactionBytes, 80, "at the high mark");
  assert.equal(memory.compaction.length, 10, "at the high mark nothing merges");
  add();
  assert.ok(memory.compactionBytes <= 40, `past it, one batch down to the low mark (${memory.compactionBytes})`);
  assert.ok(memory.compactionBytes > 40 - 14, "and no further than the merge that reached it");
  assert.equal(memory.compactionBatching, false);
  assert.equal(memory.compactionBytes, measured(memory), "the size is what the compactor reads");
  assert.equal(memory.view.length, 11, "the chat's view did not merge");
  tiles(memory.compaction, 11);
  // Between batches it only grows at its end.
  let before = memory.compaction.map(part => ({ ...part }));
  while (memory.compactionBytes + 8 <= 80) {
    add();
    assert.ok(prefix(before, memory.compaction), "append only between batches");
    before = memory.compaction.map(part => ({ ...part }));
  }
  add();
  assert.ok(!prefix(before, memory.compaction) && memory.compactionBytes <= 40, "the next batch");
}

{
  // A batch that cannot reach its low mark yet: unbuilt parents. It goes on
  // at a later node, and when the chat's view merges it starts again from it.
  const memory = new Memory({ view: 1e9, compaction: 40, compactionLow: 20, node: 512 });
  for (let n = 0; n < 8; n++) { memory.append({ kind: "user", text: "a", date: 0 }); memory.setNode(0, n, "user: a"); }
  assert.equal(memory.compactionBytes, 64);
  assert.equal(memory.compactionBatching, true, "past the high mark, with no parent built");
  assert.equal(memory.compaction.length, 8);
  memory.setNode(1, 3, "m");
  assert.equal(memory.compaction.length, 7, "one parent built: one merge");
  assert.equal(memory.compactionBatching, true, "still over the low mark: the batch stays open");
  memory.setNode(1, 0, "m"); memory.setNode(1, 1, "m");
  assert.equal(memory.compactionBytes, 22);
  assert.equal(memory.compactionBatching, true, "still over the low mark: the batch stays open");
  memory.setNode(1, 2, "m");
  assert.ok(memory.compactionBytes <= 20 && !memory.compactionBatching, `it closes once it reaches the low mark (${memory.compactionBytes})`);
}

{
  // The spec's marks over a long chat: the compaction view stays a
  // coarsening of the view and runs its own 16-32 KB sawtooth.
  const memory = new Memory();
  let before: Part[] = [], viewBefore: Part[] = [], viewMerges = memory.merges;
  let own = 0, refolds = 0, total = 0, steps = 0, sum = 0, min = Infinity, max = 0, contexts = 0, contextMax = 0;
  for (let n = 0; n < 6_000; n++) {
    memory.append({ kind: n % 2 ? "talk" : "user", text: `message ${n} ${"w".repeat(600)}`, date: n });
    drain(memory, (l, i) => {
      if (l > 0 || i % 50 === 0) {
        const bare = memory.context(l, i).reduce((size, line) => size + bytes(line) + 1, 0);
        contexts++; contextMax = Math.max(contextMax, bare);
      }
      return summary(l, i);
    });
    assert.ok(memory.settled());
    tiles(memory.compaction, memory.length);
    assert.ok(coarsens(memory), "every compaction line is a run of whole view lines");
    assert.equal(memory.compactionBytes, measured(memory), "size accounting");
    assert.ok(memory.compactionBytes <= COMPACTION, `at most 32 KB once settled (${memory.compactionBytes})`);
    const viewMerged = memory.merges !== viewMerges;
    if (viewMerged) {
      refolds++;
      assert.ok(memory.compactionBytes <= COMPACTION_LOW + 600, `the chat's view merged: merged down from it again, then the new line (${memory.compactionBytes})`);
    } else if (!prefix(before, memory.compaction)) {
      own++;
      assert.ok(memory.compactionBytes <= COMPACTION_LOW + 600, `its own batch ends at 16 KB, then the new line (${memory.compactionBytes})`);
    }
    assert.ok(viewMerged || prefix(viewBefore, memory.view));
    if (memory.bytes > 2 * COMPACTION) {
      steps++; sum += memory.compactionBytes;
      min = Math.min(min, memory.compactionBytes); max = Math.max(max, memory.compactionBytes);
    }
    before = memory.compaction.map(part => ({ ...part }));
    viewBefore = memory.view.map(part => ({ ...part }));
    viewMerges = memory.merges;
    total += memory.compaction.length;
  }
  assert.ok(memory.bytes > VIEW / 2, "the chat's view went through its own sawtooth");
  assert.ok(refolds >= 2 && own >= 10, `own batches (${own}) and merges from the chat's view (${refolds})`);
  const average = sum / steps;
  assert.ok(min > COMPACTION_LOW - 1_000 && max <= COMPACTION && average > 20_000 && average < 28_000,
    `a 16-32 KB sawtooth (min ${min}, max ${max}, average ${Math.round(average)})`);
  assert.ok(contextMax <= COMPACTION, `a compaction reads at most 32 KB of view (${contextMax} over ${contexts} calls)`);
  assert.ok(total / 6_000 < memory.view.length, "fewer lines than the chat's view");
  console.log(`optchat compaction view (6,000 messages, simulated): ${own} own batches, ${refolds} from the chat's view, size ${min}..${max} average ${Math.round(average)}, longest compaction view read ${contextMax} bytes`);
}

{
  // A reopen restores the compaction view and an open batch exactly; one
  // stored before it, or one that does not coarsen the view, is merged down
  // from the view again. A message's own line may be stored unbuilt.
  const options = { view: 3_000, compaction: 800, compactionLow: 400, node: 120 };
  const live = new Memory(options);
  const log = Array.from({ length: 80 }, (_, n) => ({ kind: "user" as const, text: `message ${n} ${"p".repeat(n % 3 ? 5 : 150)}`, date: n }));
  const text = (l: number, i: number) => `s${l}.${i} ${"z".repeat(60)}`;
  for (const message of log.slice(0, 60)) { live.append(message); drain(live, text); }
  live.append(log[60]!); live.append(log[61]!);
  const nodes: Array<[number, number, string]> = [];
  for (let l = 0; l < 8; l++) for (let i = 0; i < 80; i++) { const node = live.node(l, i); if (node !== undefined) nodes.push([l, i, node]); }
  const stored = { parts: live.view.map(part => ({ ...part })), batching: live.batching,
    compaction: { parts: live.compaction.map(part => ({ ...part })), batching: live.compactionBatching } };
  assert.ok(!live.built(0, 61), "the stored view ends in unbuilt messages");
  const reopen = (compaction?: { parts: readonly Part[]; batching: boolean }) => {
    const memory = new Memory(options);
    for (const [l, i, node] of nodes) memory.setNode(l, i, node);
    assert.ok(memory.restore(log.slice(0, 62), stored.parts, stored.batching, compaction), "restored, unbuilt messages and all");
    return memory;
  };
  const again = reopen(stored.compaction);
  assert.ok(same(again.compaction, live.compaction), "the compaction view restores as it was");
  assert.equal(again.compactionBytes, live.compactionBytes);
  assert.deepEqual(again.context(0, 61), live.context(0, 61));
  for (const message of log.slice(62)) { live.append(message); again.append(message); }
  drain(live, text); drain(again, text);
  assert.ok(same(again.compaction, live.compaction) && same(again.view, live.view), "and goes on the same way");
  // An open batch stays open across a reopen.
  const stalled = new Memory({ view: 1e9, compaction: 40, compactionLow: 20 });
  const eight = Array.from({ length: 8 }, () => ({ kind: "user" as const, text: "a", date: 0 }));
  for (let n = 0; n < 8; n++) { stalled.append(eight[n]!); stalled.setNode(0, n, "user: a"); }
  stalled.setNode(1, 3, "m"); stalled.setNode(1, 2, "m");
  assert.ok(stalled.compactionBatching && stalled.compactionBytes === 36, "between the marks, mid-batch");
  const resumed = new Memory({ view: 1e9, compaction: 40, compactionLow: 20 });
  for (let n = 0; n < 8; n++) resumed.setNode(0, n, "user: a");
  resumed.setNode(1, 3, "m"); resumed.setNode(1, 2, "m");
  assert.ok(resumed.restore(eight, stalled.view, false, { parts: stalled.compaction, batching: true }));
  assert.ok(resumed.compactionBatching && same(resumed.compaction, stalled.compaction), "mid-batch, as it was");
  for (const memory of [stalled, resumed]) { memory.setNode(1, 0, "m"); memory.setNode(1, 1, "m"); }
  assert.ok(same(resumed.compaction, stalled.compaction) && !resumed.compactionBatching, "and closes the same way");
  // Stored before the compaction view: merged down from the view.
  const old = reopen();
  assert.ok(coarsens(old) && old.compactionBytes <= options.compactionLow, `an old doc: merged down from the view (${old.compactionBytes})`);
  assert.ok(same(reopen({ parts: [{ l: 6, i: 0 }], batching: false }).compaction, old.compaction), "a stored one that does not tile is ignored");
  assert.ok(stored.parts[0]!.l > 0);
  const finer = stored.parts.flatMap(part => part.l > 0 && stored.parts.indexOf(part) === 0 ? [{ l: part.l - 1, i: 2 * part.i }, { l: part.l - 1, i: 2 * part.i + 1 }] : [part]);
  assert.ok(same(reopen({ parts: finer, batching: false }).compaction, old.compaction), "nor one finer than the view");
  // A merged line must be built to restore.
  const gap = new Memory(options);
  assert.equal(gap.restore(log.slice(0, 62), stored.parts), false, "an unbuilt merged line is refused");
}

console.log("optchat compaction view: ok");
