/** History pages read from large stores: every page equals the same page of
 * the whole transcript; a store's index is built once and extended by the
 * rows written since; rows committed out of order rebuild it; a page parses
 * only its own rows; stores are only read, also beyond the size a snapshot
 * copy allows. Faux model, disposable state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { CURRENT_SQLITE_SCHEMA_VERSION } from "@earendil-works/pi-durable/storage/sqlite";
import { ClaudeAgent } from "../src/claude-agent.ts";
import { render } from "../src/claude-thread-events.ts";
import { openStorage, readStorage } from "../src/durable-agent.ts";
import { storedPiTranscript } from "../src/pi-thread-events.ts";
import type { ThreadTranscript } from "../src/thread-events.ts";
import { HISTORY_MAX, historyIndexed, pageOf, PI_SCHEMA_VERSION, readClaudeHistory, readPiHistory, type HistoryRequest } from "../src/thread-history.ts";
import { claudeStore, output, piStore } from "./history-store-fixture.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-thread-history-"));
const timed = async <T>(read: () => Promise<T>) => { const started = performance.now(); const value = await read(); return { value, ms: performance.now() - started }; };
/** Requests across the whole history: every page boundary of a few sizes. */
function requests(total: number): HistoryRequest[] {
  const all: HistoryRequest[] = [{}, { limit: 1 }, { limit: HISTORY_MAX }, { limit: 500 }, { before: 0 }, { before: total + 9 }, { before: -3, limit: 0 }];
  for (const limit of [1, 7, HISTORY_MAX]) for (let before = 0; before <= total; before += Math.max(1, Math.floor(total / 23))) all.push({ before, limit });
  return all;
}
/** The whole transcript, from a copy opened by pi-durable itself. */
async function piWhole(file: string, failure: string | null = null): Promise<ThreadTranscript> {
  const directory = fs.mkdtempSync(path.join(root, "copy-"));
  fs.copyFileSync(file, path.join(directory, "pi.sqlite"));
  if (fs.existsSync(`${file}-wal`)) fs.copyFileSync(`${file}-wal`, path.join(directory, "pi.sqlite-wal"));
  const storage = await openStorage(path.join(directory, "pi.sqlite"));
  try { return await storedPiTranscript(storage, null, failure); }
  finally { await storage.close(context); fs.rmSync(directory, { recursive: true, force: true }); }
}
/** A WAL reader may add the empty log and shared memory beside a closed store, as any SQLite reader does. */
const files = (directory: string) => fs.readdirSync(directory).filter(name => !/-(shm|wal)$/.test(name) || (name.endsWith("-wal") && fs.statSync(path.join(directory, name)).size)).sort();

try {
  assert.equal(PI_SCHEMA_VERSION, CURRENT_SQLITE_SCHEMA_VERSION, "the page reader knows the pinned pi-durable schema: review it on an upgrade");

  // Pi: a long thread written by a real Harness, with compaction.
  {
    const directory = path.join(root, "pi");
    fs.mkdirSync(directory);
    const file = await piStore(directory, { runs: 6, calls: 30, bytes: 3000 });
    const whole = await piWhole(file, "boom");
    assert.ok(whole.events.length > 300);
    const before = { bytes: fs.readFileSync(file), files: files(directory) };
    const indexed = historyIndexed.rows;
    const first = await timed(() => readPiHistory(file, null, "boom", {}));
    const built = historyIndexed.rows - indexed;
    assert.ok(built > 300, "the first read indexes the store");
    for (const request of requests(whole.events.length)) assert.deepEqual(await readPiHistory(file, null, "boom", request), pageOf(whole, request), JSON.stringify(request));
    assert.equal(historyIndexed.rows - indexed, built, "later reads of an unchanged store index nothing");
    const again = await timed(() => readPiHistory(file, null, "boom", {}));
    console.log(`pi ${(fs.statSync(file).size / 2 ** 20).toFixed(1)} MiB, ${whole.events.length} messages: first page ${first.ms.toFixed(0)} ms, again ${again.ms.toFixed(1)} ms`);
    assert.deepEqual(before, { bytes: fs.readFileSync(file), files: files(directory) }, "reads leave the store and its directory as they were");

    // Reads of one store at once queue: the store is indexed once.
    const copy = path.join(root, "pi-copy");
    fs.mkdirSync(copy);
    fs.copyFileSync(file, path.join(copy, "pi.sqlite"));
    const copied = path.join(copy, "pi.sqlite");
    let mark = historyIndexed.rows;
    const together = await Promise.all([{}, { before: 9 }, { limit: 1 }].map(request => readPiHistory(copied, null, "boom", request)));
    assert.deepEqual(together, [{}, { before: 9 }, { limit: 1 }].map(request => pageOf(whole, request)));
    assert.equal(historyIndexed.rows - mark, built, "indexed once");
    // A failed read drops the index; another file under the same name is indexed anew.
    fs.writeFileSync(copied, "not a database");
    await assert.rejects(readPiHistory(copied, null, null, {}));
    fs.rmSync(copied);
    fs.copyFileSync(file, copied);
    mark = historyIndexed.rows;
    assert.deepEqual(await readPiHistory(copied, null, "boom", {}), pageOf(whole, {}));
    assert.equal(historyIndexed.rows - mark, built, "indexed again");
    fs.rmSync(copied);
    fs.copyFileSync(file, `${copied}.new`);
    fs.renameSync(`${copied}.new`, copied);
    mark = historyIndexed.rows;
    assert.deepEqual(await readPiHistory(copied, null, "boom", {}), pageOf(whole, {}));
    assert.equal(historyIndexed.rows - mark, built, "a replaced file is indexed again");

    // More runs: only the new rows are indexed.
    await piStore(directory, { runs: 1, calls: 5, bytes: 100, from: 6 });
    const more = await piWhole(file);
    const extended = historyIndexed.rows;
    for (const request of requests(more.events.length)) assert.deepEqual(await readPiHistory(file, null, null, request), pageOf(more, request), JSON.stringify(request));
    const added = historyIndexed.rows - extended;
    assert.ok(added > 0 && added < 40, `only the new rows are indexed (${added})`);

    // An entry committed late under a smaller id than ones already read:
    // the index is built again.
    const db = new DatabaseSync(file);
    const held = db.prepare("SELECT * FROM entries WHERE record ->> '$.kind' = 'pi.user' ORDER BY id LIMIT 1 OFFSET 3").get() as Record<string, number | string>;
    db.prepare("DELETE FROM entries WHERE id = ?").run(held.id!);
    const early = await piWhole(file);
    for (const request of [{}, { before: 50, limit: 3 }]) assert.deepEqual(await readPiHistory(file, null, null, request), pageOf(early, request));
    db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?, ?)").run(held.id!, held.conversation_id!, held.head ?? null, held.commit_seq!, held.record!);
    db.close();
    const late = await piWhole(file);
    assert.equal(late.events.length, early.events.length + 1);
    for (const request of requests(late.events.length)) assert.deepEqual(await readPiHistory(file, null, null, request), pageOf(late, request), JSON.stringify(request));
  }

  // Pi: a store larger than a snapshot copy may be is read too.
  {
    const directory = path.join(root, "pi-large");
    fs.mkdirSync(directory);
    const file = await piStore(directory, { runs: 1, calls: 1, bytes: 10 });
    const db = new DatabaseSync(file);
    const template = JSON.parse((db.prepare("SELECT record FROM entries WHERE record ->> '$.kind' = 'pi.tool-result' LIMIT 1").get() as { record: string }).record) as { model: Array<Record<string, unknown>> };
    let id = (db.prepare("SELECT max(id) AS id FROM record_ids").get() as { id: number }).id;
    db.exec("BEGIN");
    for (let k = 0; k < 70; k++) {
      id++;
      db.prepare("INSERT INTO record_ids (id, record_type) VALUES (?, 'entry')").run(id);
      db.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, 1, NULL, 1000000, ?)").run(id,
        JSON.stringify({ ...template, id, model: [{ ...template.model[0], content: [{ type: "text", text: `${k} ${output(1024 * 1024)}` }] }] }));
    }
    db.exec("COMMIT");
    db.close();
    await assert.rejects(readStorage(file, async () => null), /too large to read here/, "a snapshot copy refuses it");
    const page = (await readPiHistory(file, null, null, { limit: 2 }))!;
    assert.deepEqual(page, pageOf(await piWhole(file), { limit: 2 }));
    assert.equal(page.total, 74);
    assert.match((page.events.at(-1) as { output: string }).output, /^69 src\//);
  }

  // Claude Code: a long store, with the shapes render treats specially.
  {
    const directory = path.join(root, "claude");
    fs.mkdirSync(directory);
    await claudeStore(directory, { turns: 8, calls: 40, bytes: 2000 });
    const db = new DatabaseSync(path.join(directory, "claude.sqlite"));
    const insert = db.prepare("INSERT INTO message(submission, data) VALUES (?, ?)");
    const json = (value: unknown) => JSON.stringify(value);
    insert.run(8, json({ type: "assistant", parent_tool_use_id: "t7.0", message: { content: [{ type: "text", text: "a subagent's text" }] } }));
    insert.run(8, json({ type: "assistant", message: { content: [{ type: "text", text: "" }, { type: "thinking", thinking: "" }, { type: "tool_use", name: "NoId" }] } }));
    insert.run(8, json({ type: "assistant", message: { content: "plain text content" } }));
    insert.run(8, json({ type: "system", subtype: "init", tools: ["Bash"] }));
    insert.run(8, json({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t0.0", content: [{ type: "text", text: "late" }, { type: "image" }] }] } }));
    // A result before its call is named "tool", and a reused call id shows the newest name before each result, as render does.
    insert.run(8, json({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "early", content: "before its call" }] } }));
    insert.run(8, json({ type: "assistant", message: { content: [{ type: "tool_use", id: "early", name: "Grep", input: {} }] } }));
    insert.run(8, json({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "early", content: "after it" }] } }));
    insert.run(8, json({ type: "assistant", message: { content: [{ type: "tool_use", id: "early", name: "Glob", input: {} }] } }));
    insert.run(8, json({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "early", content: "after the second" }] } }));
    db.close();
    const stored = () => render(ClaudeAgent.stored(directory)!, null, null, path.join(directory, "claude"));
    const file = path.join(directory, "claude.sqlite");
    const read = (request: HistoryRequest) => readClaudeHistory(file, path.join(directory, "claude"), null, null, request);
    const whole = stored();
    assert.ok(whole.events.length > 600);
    assert.deepEqual(whole.events.filter(event => event.type === "tool-result" && event.callId === "early").map(event => event.type === "tool-result" && event.name), ["tool", "Grep", "Glob"]);
    const before = { bytes: fs.readFileSync(file), files: files(directory) };
    const first = await timed(() => read({}));
    for (const request of requests(whole.events.length)) assert.deepEqual(await read(request), pageOf(whole, request), JSON.stringify(request));
    const again = await timed(() => read({}));
    console.log(`claude ${(fs.statSync(file).size / 2 ** 20).toFixed(1)} MiB, ${whole.events.length} messages: first page ${first.ms.toFixed(0)} ms, again ${again.ms.toFixed(1)} ms`);
    assert.match(JSON.stringify(await read({ before: 600, limit: 3 })), /\/workspace\/out/, "host paths show as /workspace");
    assert.ok(!JSON.stringify(await read({ limit: HISTORY_MAX })).includes(path.join(directory, "claude")));
    assert.deepEqual(before, { bytes: fs.readFileSync(file), files: files(directory) }, "reads leave the store and its directory as they were");

    // A new turn: only it is indexed.
    const writer = new DatabaseSync(file);
    writer.prepare("INSERT INTO submission(request_id, text, state, error, created_at) VALUES ('run-9', 'one more', 'running', NULL, 0)").run();
    writer.prepare("INSERT INTO message(submission, data) VALUES (9, ?)").run(json({ type: "assistant", message: { content: [{ type: "tool_use", id: "n1", name: "Read", input: {} }] } }));
    const extended = historyIndexed.rows;
    const next = stored();
    for (const request of requests(next.events.length)) assert.deepEqual(await read(request), pageOf(next, request), JSON.stringify(request));
    assert.equal(historyIndexed.rows - extended, 2, "the new submission and its message");
    assert.equal((await read({}))!.status.state, "working");

    // A message for an older turn and one for no stored turn: the order is render's.
    writer.prepare("INSERT INTO message(submission, data) VALUES (2, ?)").run(json({ type: "assistant", message: { content: [{ type: "text", text: "written late to turn 2" }] } }));
    writer.prepare("PRAGMA foreign_keys = OFF").run();
    writer.prepare("INSERT INTO message(submission, data) VALUES (99, ?)").run(json({ type: "assistant", message: { content: [{ type: "text", text: "of no turn" }] } }));
    writer.close();
    const reordered = stored();
    assert.ok(reordered.events.some(event => event.type === "assistant-text" && event.text === "written late to turn 2"));
    for (const request of requests(reordered.events.length)) assert.deepEqual(await read(request), pageOf(reordered, request), JSON.stringify(request));
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("thread history: ok");
