/** Thread names ("🦦 calm otter"): drawn at creation from fixed lists, no
 * model asked, unlike every other open thread's, kept in the thread's record
 * and never its title; a rename changes the title only, and a thread older
 * than names stays as it is. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Registry } from "../src/registry.ts";
import { ADJECTIVES, ANIMALS, drawThreadName, newThreadName, threadNameText } from "../src/thread-names.ts";

// The lists: 64 × 64, single lowercase words, every animal its own emoji.
assert.equal(ADJECTIVES.length, 64);
assert.equal(ANIMALS.length, 64);
assert.equal(new Set(ADJECTIVES).size, ADJECTIVES.length, "no adjective twice");
assert.equal(new Set(ANIMALS.map(([animal]) => animal)).size, ANIMALS.length, "no animal twice");
assert.equal(new Set(ANIMALS.map(([, emoji]) => emoji)).size, ANIMALS.length, "no emoji twice");
for (const word of [...ADJECTIVES, ...ANIMALS.map(([animal]) => animal)]) assert.match(word, /^[a-z]+$/, word);
for (const [animal, emoji] of ANIMALS) assert.match(emoji, /^\p{Extended_Pictographic}️?$/u, `${animal}'s emoji is one pictograph`);
// Never a word that reads as a thread's state or a lamp.
for (const word of ["busy", "sleepy", "idle", "ready", "slow", "working", "stuck", "failed", "red", "green", "amber"]) assert.ok(!ADJECTIVES.includes(word), word);

// Drawn from the (random) id: the same id draws the same name, pinned here.
const id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
assert.deepEqual(drawThreadName(id), drawThreadName(id));
assert.deepEqual(["00000000-0000-4000-8000-000000000000", id].map(each => threadNameText(drawThreadName(each))),
  ["🦩 daring flamingo", "🦑 mellow squid"]);
assert.equal(threadNameText(undefined), "");
// A name another open thread has is drawn again.
assert.deepEqual(newThreadName(id, new Set()), drawThreadName(id));
assert.deepEqual(newThreadName(id, new Set(["mellow squid"])), drawThreadName(id, 1));
assert.notEqual(newThreadName(id, new Set(["mellow squid"])).words, "mellow squid");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-thread-names-"));
const filename = path.join(root, "registry.sqlite");
let registry = new Registry(filename);
try {
  registry.saveProject({ id: "project", name: "test", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  registry.enrollRunner({ nodeId: "node-test", environmentId: 7, threadId: "runner", configPath: "/private/config.json", configHash: "hash", protocol: 4, kind: "vm" });
  registry.recordRunnerSlots("runner", 200);
  const model = { provider: "fixture", id: "selected" };
  const raw = (threadId: string) => {
    const db = new DatabaseSync(filename);
    try { return JSON.parse(String((db.prepare("SELECT data FROM thread WHERE id=?").get(threadId) as { data: string }).data)) as Record<string, unknown>; }
    finally { db.close(); }
  };

  // Kept at creation, beside the title, which stays the task.
  const thread = registry.createThread("project", "first", model, "fix the flaky gateway test");
  assert.equal(thread.title, "fix the flaky gateway test");
  assert.ok(thread.name && ANIMALS.some(([animal, emoji]) => thread.name!.words.endsWith(` ${animal}`) && emoji === thread.name!.emoji));
  assert.deepEqual(raw(thread.id).name, thread.name, "the name is in the thread's record");
  // A replayed request finds the same thread, name and all.
  assert.deepEqual(registry.createThread("project", "first", model, "fix the flaky gateway test").name, thread.name);
  // A rename (the user's, or spawn's default title) changes the title only.
  assert.equal(registry.renameThread(thread.id, "deploy fix"), true);
  assert.deepEqual([registry.getThread(thread.id)?.title, registry.getThread(thread.id)?.name], ["deploy fix", thread.name]);
  assert.equal(registry.renameThread(thread.id, "spawned", "fix the flaky gateway test"), false, "the user's name is not written over");
  assert.equal(registry.getThread(thread.id)?.title, "deploy fix");
  // A phase change rewrites the record and keeps the name.
  registry.applyPhase(thread.id, { type: "ready", base: null });
  assert.deepEqual(registry.getThread(thread.id)?.name, thread.name);
  registry.close(); registry = new Registry(filename);
  assert.deepEqual(registry.getThread(thread.id)?.name, thread.name, "the name survives a restart");

  // No two open threads share a name: 120 threads, where drawing by id
  // alone would almost surely give two the same (1 - e^(-120·119/2/4096) ≈ 0.97).
  const created = Array.from({ length: 120 }, (_, index) => registry.createThread("project", `many-${index}`, model, `task ${index}`));
  const open = registry.listThreads().filter(candidate => !candidate.archived);
  assert.equal(new Set(open.map(candidate => candidate.name!.words)).size, open.length, "open threads have distinct names");
  assert.ok(created.every(candidate => raw(candidate.id).name), "each name is kept when the thread is created");

  // A thread older than names has none, reads none and is not rewritten.
  const olderId = "7d444840-9dc0-11d1-b245-5ffdce74fad2";
  const { name: _name, ...unnamed } = raw(thread.id);
  const db = new DatabaseSync(filename);
  db.prepare("INSERT INTO thread VALUES (?,?,?,?)").run(olderId, "project", "runner",
    JSON.stringify({ ...unnamed, id: olderId, title: "an old thread", archived: true, vm: { vmId: "0123456789abcdef", placeholders: {} } }));
  db.close();
  const before = JSON.stringify(raw(olderId));
  assert.equal(registry.getThread(olderId)?.name, undefined);
  assert.equal(registry.getThread(olderId)?.title, "an old thread");
  assert.equal(registry.listThreads().find(candidate => candidate.id === olderId)?.name, undefined);
  assert.equal(JSON.stringify(raw(olderId)), before, "reading an old thread does not rewrite it");
} finally {
  registry.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("thread names: ok");
