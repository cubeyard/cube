import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { piStore, claudeStore } from "../test/history-store-fixture.ts";
import { storedPiTranscript } from "../src/pi-thread-events.ts";
import { ClaudeAgent } from "../src/claude-agent.ts";
import { render } from "../src/claude-thread-events.ts";
import { formatHistory } from "../src/optchat.ts";

const context = BACKGROUND_CONTEXT;
const dir = process.argv[2] ?? "/workspace/packages/server/.bench/data";
const t = () => performance.now();
fs.mkdirSync(dir, { recursive: true });
const pi = path.join(dir, "pi");
if (!fs.existsSync(path.join(pi, "pi.sqlite"))) {
  fs.mkdirSync(pi, { recursive: true });
  const s = t(); await piStore(pi, { runs: Number(process.env.RUNS ?? 20), calls: Number(process.env.CALLS ?? 50), bytes: Number(process.env.BYTES ?? 20000) });
  console.log("pi gen ms", (t() - s).toFixed(0));
}
const claude = path.join(dir, "claude");
if (!fs.existsSync(path.join(claude, "claude.sqlite"))) {
  fs.mkdirSync(claude, { recursive: true });
  await claudeStore(claude, { turns: 20, calls: 100, bytes: 20000 });
}
const file = path.join(pi, "pi.sqlite");
const src = new DatabaseSync(file, { readOnly: true });
const counts = Object.fromEntries(["entries", "submissions", "documents", "document_revisions", "tasks"].map(table => [table, (src.prepare(`SELECT count(*) n, sum(length(${table === "document_revisions" ? "content" : "record"})) b FROM ${table}`).get() as any)]));
const size = (src.prepare("SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()").get() as any).size;
src.close();
console.log("pi size MiB", (size / 2 ** 20).toFixed(1), JSON.stringify(counts));
if (process.env.ONLYGEN) process.exit(0);
for (let round = 0; round < 3; round++) {
  const tmp = fs.mkdtempSync(path.join(pi, ".read-"));
  let s = t();
  const source = new DatabaseSync(file, { readOnly: true });
  source.prepare("VACUUM INTO ?").run(path.join(tmp, "pi.sqlite"));
  source.close();
  const vac = t() - s; s = t();
  const storage = await SqliteStorage.open(new NodeSqliteDatabase(new DatabaseSync(path.join(tmp, "pi.sqlite"))));
  const open = t() - s; s = t();
  let n = 0, cursor;
  do { const p = await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 256, cursor, context); n += p.items.length; cursor = p.next; } while (cursor);
  const scanE = t() - s; s = t();
  do { const p = await storage.scanSubmissions({ conversationId: ROOT_CONVERSATION_ID }, 256, cursor, context); cursor = p.next; } while (cursor);
  const scanS = t() - s; s = t();
  const tr = await storedPiTranscript(storage, null, null);
  const whole = t() - s; s = t();
  const out = formatHistory("abcdef12-x", { project: "p", title: "t", archived: false, machine: "ready", facts: [], agentOpen: false, failure: null, transcript: tr, unreadable: null }, "none", { limit: 5 });
  const fmt = t() - s; s = t();
  await storage.close(context);
  fs.rmSync(tmp, { recursive: true, force: true });
  const cl = t() - s;
  console.log(`pi round ${round}: vacuum ${vac.toFixed(0)} open ${open.toFixed(0)} scanEntries(${n}) ${scanE.toFixed(0)} scanSubs ${scanS.toFixed(0)} storedPiTranscript ${whole.toFixed(0)} (events ${tr.events.length}) format ${fmt.toFixed(1)} close+rm ${cl.toFixed(0)} ms; out ${out.length}`);
}
for (let round = 0; round < 3; round++) {
  let s = t();
  const state = ClaudeAgent.stored(claude)!;
  const load = t() - s; s = t();
  const tr = render(state, null, null, path.join(claude, "claude"));
  const ren = t() - s;
  console.log(`claude round ${round}: stored ${load.toFixed(0)} render ${ren.toFixed(0)} ms (messages ${state.messages.length}, events ${tr.events.length}) file MiB ${(fs.statSync(path.join(claude, "claude.sqlite")).size / 2 ** 20).toFixed(1)}`);
}
