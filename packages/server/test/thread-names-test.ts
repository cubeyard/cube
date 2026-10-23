/** Thread names ("🦦 calm otter"): drawn from fixed lists by the thread's
 * id, kept in its record once at creation, unlike every other open
 * thread's, never its title; a thread created before names reads the one
 * its id gives, and reading it writes nothing. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Registry } from "../src/registry.ts";
import { ADJECTIVES, ANIMALS, identityText, newThreadIdentity, threadIdentity } from "../src/thread-names.ts";

// The lists: 64 × 64, single lowercase words, every animal its own emoji.
assert.equal(ADJECTIVES.length, 64);
assert.equal(ANIMALS.length, 64);
assert.equal(new Set(ADJECTIVES).size, ADJECTIVES.length, "no adjective twice");
assert.equal(new Set(ANIMALS.map(([animal]) => animal)).size, ANIMALS.length, "no animal twice");
assert.equal(new Set(ANIMALS.map(([, emoji]) => emoji)).size, ANIMALS.length, "no emoji twice");
for (const word of [...ADJECTIVES, ...ANIMALS.map(([animal]) => animal)]) assert.match(word, /^[a-z]+$/, word);
for (const [animal, emoji] of ANIMALS) assert.match(emoji, /^\p{Extended_Pictographic}\uFE0F?$/u, `${animal}'s emoji is one pictograph`);
// Never a word that reads as a thread's state or a lamp.
for (const word of ["busy", "sleepy", "idle", "ready", "slow", "working", "stuck", "failed", "red", "green", "amber"]) assert.ok(!ADJECTIVES.includes(word), word);

// The same id gives the same name, wherever it is drawn. These are fixed:
// threads created before names read theirs from these lists, so a change
// to a list (which renames them) fails here.
assert.deepEqual(threadIdentity("00000000-0000-4000-8000-000000000000"), threadIdentity("00000000-0000-4000-8000-000000000000"));
assert.deepEqual(
  ["00000000-0000-4000-8000-000000000000", "3f2504e0-4f89-41d3-9a0c-0305e82c3301", "7d444840-9dc0-11d1-b245-5ffdce74fad2"].map(id => identityText(threadIdentity(id))),
  ["🦩 daring flamingo", "🦑 mellow squid", "🦘 bright kangaroo"]);
assert.equal(identityText(undefined), "");

// A name another open thread has is drawn again; one draw is enough most times.
const id = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
assert.deepEqual(newThreadIdentity(id, new Set()), threadIdentity(id));
assert.deepEqual(newThreadIdentity(id, new Set(["mellow squid"])), threadIdentity(id, 1));
assert.notEqual(newThreadIdentity(id, new Set(["mellow squid"])).name, "mellow squid");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-thread-names-"));
const filename = path.join(root, "registry.sqlite");
let registry = new Registry(filename);
try {
  registry.saveProject({ id: "project", name: "test", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  registry.enrollRunner({ nodeId: "node-test", environmentId: 7, threadId: "runner", configPath: "/private/config.json", configHash: "hash", protocol: 4, kind: "vm" });
  registry.recordRunnerSlots("runner", 200);
  const model = { provider: "fixture", id: "selected" };
  const raw = (threadId: string) => JSON.parse(String((new DatabaseSync(filename).prepare("SELECT data FROM thread WHERE id=?").get(threadId) as { data: string }).data)) as Record<string, unknown>;

  // Kept once at creation, beside the title, which stays the task.
  const thread = registry.createThread("project", "first", model, "fix the flaky gateway test");
  assert.equal(thread.title, "fix the flaky gateway test");
  assert.ok(thread.identity && ANIMALS.some(([animal, emoji]) => thread.identity!.name.endsWith(` ${animal}`) && emoji === thread.identity!.emoji));
  assert.deepEqual(raw(thread.id).identity, thread.identity, "the name is in the thread's record");
  // A replayed request finds the same thread, name and all; a rename leaves the name.
  assert.deepEqual(registry.createThread("project", "first", model, "fix the flaky gateway test").identity, thread.identity);
  registry.saveThread({ ...registry.getThread(thread.id)!, title: "renamed" });
  assert.equal(registry.getThread(thread.id)?.title, "renamed");
  assert.deepEqual(registry.getThread(thread.id)?.identity, thread.identity, "a rename keeps the name");
  registry.close(); registry = new Registry(filename);
  assert.deepEqual(registry.getThread(thread.id)?.identity, thread.identity, "the name survives a restart");

  // No two open threads share a name: 120 threads, where drawing by id
  // alone would almost surely give two the same (1 - e^(-120·119/2/4096) ≈ 0.97).
  const created = Array.from({ length: 120 }, (_, index) => registry.createThread("project", `many-${index}`, model, `task ${index}`));
  const open = registry.listThreads().filter(candidate => !candidate.archived);
  assert.equal(new Set(open.map(candidate => candidate.identity!.name)).size, open.length, "open threads have distinct names");
  assert.ok(created.every(candidate => raw(candidate.id).identity), "each name is kept when the thread is created");

  // A thread created before names: its record has none. It reads the one
  // its id gives, everywhere a thread is read, and reading writes nothing.
  const legacyId = "7d444840-9dc0-11d1-b245-5ffdce74fad2";
  const { identity: _named, ...unnamed } = raw(thread.id);
  const legacy = { ...unnamed, id: legacyId, title: "an old thread", archived: true, vm: { vmId: "0123456789abcdef", placeholders: {} } };
  const db = new DatabaseSync(filename);
  db.prepare("INSERT INTO thread VALUES (?,?,?,?)").run(legacyId, "project", "runner", JSON.stringify(legacy));
  db.close();
  const before = JSON.stringify(raw(legacyId));
  assert.deepEqual(registry.getThread(legacyId)?.identity, { name: "bright kangaroo", emoji: "🦘" });
  assert.equal(registry.getThread(legacyId)?.title, "an old thread", "its title stays");
  assert.deepEqual(registry.listThreads().find(candidate => candidate.id === legacyId)?.identity, { name: "bright kangaroo", emoji: "🦘" });
  assert.deepEqual(registry.threadByVm("0123456789abcdef")?.identity, { name: "bright kangaroo", emoji: "🦘" });
  assert.equal(JSON.stringify(raw(legacyId)), before, "reading an old thread does not rewrite it");
} finally {
  registry.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("thread names: ok");
