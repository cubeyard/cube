/** Overlapping thread polls: a slow older answer never replaces a newer one. */
import assert from "node:assert/strict";
import { createOrdered } from "../src/lib/ordered.ts";

const polls = createOrdered();
const first = polls.ask();
const second = polls.ask();
assert.equal(polls.accept(second), true, "the newer answer lands first");
assert.equal(polls.accept(first), false, "the older one is stale: it would put back a state the host left");
assert.equal(polls.current(first), false, "and its failure says nothing about now");

// A slow host: every poll is overtaken by the next before it answers, and
// each answer still shows.
const slow = createOrdered();
let shown = 0;
let previous = slow.ask();
for (let i = 0; i < 5; i += 1) {
  const next = slow.ask();
  if (slow.accept(previous)) shown += 1;
  previous = next;
}
assert.equal(shown, 5, "a newer poll in flight never holds back an answer");
assert.equal(slow.current(previous), true);
console.log("ok: overlapping polls show answers in order and never starve");
