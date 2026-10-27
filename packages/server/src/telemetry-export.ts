/** Exports content-free per-call and per-turn telemetry from thread stores
 * (telemetry.ts says what each figure means) and prints an aggregate
 * analysis. It never changes a store's contents or schema: claude.sqlite is
 * opened read-only (SQLite may leave its `-shm` and `-wal` files beside it),
 * a Pi store is read from a private copy (durable-agent.ts readStorage, which
 * writes and removes a `.read-*` directory beside it), so the threads
 * directory must be writable. Point it at a copy of `CUBED_STATE/threads`, or
 * at cubed's own while cubed is stopped: an open Pi store belongs to its agent.
 *
 *   node packages/server/src/telemetry-export.ts <threads directory> <output directory> */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ROOT_CONVERSATION_ID, type ConversationId, type Cursor, type EntryRecord } from "@earendil-works/pi-durable";
import { readStorage } from "./durable-agent.ts";
import { analyze, claudeTelemetry, piTelemetry, TELEMETRY_SCHEMA, type Analysis, type Distribution, type PiStore, type ThreadTelemetry } from "./telemetry.ts";
import { sumUsage } from "./usage-service.ts";

const context = BACKGROUND_CONTEXT;

/** One thread directory's telemetry, or null when it holds no store. */
export async function readThread(directory: string): Promise<ThreadTelemetry | null> {
  const thread = path.basename(directory);
  const claude = path.join(directory, "claude.sqlite"), pi = path.join(directory, "pi.sqlite");
  if (fs.existsSync(claude)) {
    const db = new DatabaseSync(claude, { readOnly: true, timeout: 5000 });
    try {
      // As usage-service.ts: a lost background turn is not a turn.
      const turns = db.prepare("SELECT seq, state, created_at AS createdAt FROM submission WHERE request_id NOT LIKE 'cube:background:%:lost' ORDER BY seq").all() as Array<{ seq: number; state: "running" | "completed" | "failed" | "stopped"; createdAt: number }>;
      const messages = (db.prepare("SELECT seq, submission, data FROM message WHERE json_extract(data, '$.type') IN ('assistant', 'system', 'result', 'rate_limit_event') ORDER BY seq").all() as Array<{ seq: number; submission: number; data: string }>)
        .map(row => ({ seq: row.seq, submission: row.submission, data: JSON.parse(row.data) as Record<string, unknown> }));
      // A store claude-agent.ts has not opened since steering came has no steer table; it is read as it is, never migrated.
      const steering = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steer'").get() !== undefined;
      const steers = steering ? db.prepare("SELECT submission, state FROM steer").all() as Array<{ submission: number; state: string }> : null;
      return claudeTelemetry({ thread, turns, messages, steers });
    } finally { db.close(); }
  }
  if (fs.existsSync(pi)) {
    const store = await readStorage(pi, async (storage): Promise<PiStore> => {
      const conversations: PiStore["conversations"][number][] = [];
      let cursor: Cursor | undefined;
      do {
        const page = await storage.scanConversations({}, 256, cursor, context);
        for (const conversation of page.items) {
          const entries: EntryRecord[] = [];
          let next: Cursor | undefined;
          do {
            const batch = await storage.scanEntries({ conversationId: conversation.id as ConversationId, order: "ascending" }, 256, next, context);
            entries.push(...batch.items);
            next = batch.next;
          } while (next);
          conversations.push({ id: String(conversation.id), root: conversation.id === ROOT_CONVERSATION_ID, entries });
        }
        cursor = page.next;
      } while (cursor);
      return { thread, conversations, usage: await sumUsage(storage) };
    });
    return store ? piTelemetry(store) : null;
  }
  return null;
}

/** A thread that could not be read: its error's code only, never its message. */
export interface Skipped { thread: string; error: string; message: string }

/** Reads every thread directory under `threads` and writes the export to
 * `out`, which must not exist yet: a fresh 0700 directory, each file created
 * 0600 and never through an existing name or link. */
export async function exportTelemetry(threads: string, out: string): Promise<{ analysis: Analysis; skipped: Skipped[] }> {
  const names = fs.readdirSync(threads).sort();
  fs.mkdirSync(out, { mode: 0o700 });
  const items: ThreadTelemetry[] = [], skipped: Skipped[] = [];
  for (const name of names) {
    const directory = path.join(threads, name);
    try {
      if (!fs.statSync(directory).isDirectory()) continue;
      const item = await readThread(directory);
      if (item) items.push(item);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      skipped.push({ thread: name, error: typeof code === "string" && /^[A-Z0-9_]{1,40}$/.test(code) ? code : "unreadable", message: error instanceof Error ? error.message : String(error) });
    }
  }
  const analysis = analyze(items);
  const files: Record<string, string> = {
    "calls.jsonl": items.flatMap(item => item.calls).map(row => JSON.stringify(row)).join("\n"),
    "turns.jsonl": items.flatMap(item => item.turns).map(row => JSON.stringify(row)).join("\n"),
    "events.jsonl": items.flatMap(item => item.events).map(row => JSON.stringify(row)).join("\n"),
    "threads.jsonl": items.map(({ calls, turns, events, ...thread }) => JSON.stringify({ ...thread, calls: calls.length, turns: turns.length, events: events.length })).join("\n"),
    "analysis.json": JSON.stringify(analysis, null, 2),
  };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(out, name), text ? `${text}\n` : "", { mode: 0o600, flag: "wx" });
  const manifest = { schema: TELEMETRY_SCHEMA, generatedAt: new Date().toISOString(), threads: items.length, skipped: skipped.map(({ thread, error }) => ({ thread, error })),
    files: Object.fromEntries(Object.keys(files).map(name => [name, createHash("sha256").update(fs.readFileSync(path.join(out, name))).digest("hex")])) };
  fs.writeFileSync(path.join(out, "MANIFEST.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return { analysis, skipped };
}

const pct = (part: number, whole: number) => whole ? `${(100 * part / whole).toFixed(1)}%` : "n/a";
const ms = (value: Distribution | null) => value ? `p50 ${value.p50} ms, p90 ${value.p90} ms, max ${value.max} ms (n=${value.n})` : "unknown";

/** The analysis as text. */
export function analysisText(analysis: Analysis): string {
  const lines = [`${analysis.threads} threads (${TELEMETRY_SCHEMA}); billed amounts unknown, every amount is an estimate`];
  for (const [agent, a] of Object.entries(analysis.byAgent)) {
    if (!a.threads) continue;
    lines.push(`${agent}: ${a.threads} threads${a.versions.length ? ` (versions ${a.versions.join(", ")})` : ""}, ${a.turns} turns${agent === "claude-code" ? ` (${a.turnsWithResult} with a result)` : ""}, ${a.calls} calls`,
      `  coverage: duration ${pct(a.callsWithDuration, a.calls)} of calls, output ${pct(a.callsWithOutput, a.calls)} of calls`,
      `  retries seen ${a.retries}, compactions ${a.compactions}, rate-limit events ${a.rateLimits}, turns without a usage report ${a.unknownTurns}`,
      `  turn time: ${ms(a.turnMs)}; api: ${ms(a.turnApiMs)}; first token: ${ms(a.turnTtftMs)}; tools: ${ms(a.toolMs)}`,
      `  estimate (usage ledger): $${a.ledgerUsd.toFixed(2)}${a.ledgerUnpricedTokens ? ` + ${a.ledgerUnpricedTokens} unpriced tokens` : ""}`);
  }
  for (const g of analysis.groups) {
    lines.push(`${g.agent} ${g.model}: ${g.calls} calls in ${g.threads} threads, ${g.failedCalls} failed`,
      `  prompt tokens (${g.prompt.calls} calls): cache read ${pct(g.prompt.read, g.prompt.prompt)}, cache write ${pct(g.prompt.write, g.prompt.prompt)}, uncached ${pct(g.prompt.uncached, g.prompt.prompt)}; cold writes after the first call ${g.coldWrites}`,
      `  output: ${g.output.calls ? `${g.output.tokens} tokens over ${g.output.calls} calls` : "unknown per call"}; call time: ${ms(g.callMs)}`,
      `  per-call estimate: ${!g.estimatedUsd ? "not recorded per call (see the agent's estimate above)"
        : `${g.estimatedUsd.pricedCalls ? `$${g.estimatedUsd.usd.toFixed(4)} over ${g.estimatedUsd.pricedCalls} priced calls` : "none"}${g.estimatedUsd.unpricedCalls ? `, ${g.estimatedUsd.unpricedCalls} calls without a price` : ""}`}`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const [threads, out] = process.argv.slice(2);
  if (!threads || !out) { console.error("usage: node packages/server/src/telemetry-export.ts <threads directory> <output directory>"); process.exit(2); }
  try {
    const { analysis, skipped } = await exportTelemetry(path.resolve(threads), path.resolve(out));
    console.log(analysisText(analysis));
    // The message stays on this terminal; the export keeps only its code.
    for (const item of skipped) console.log(`skipped ${item.thread}: ${item.message}`);
  } catch (error) {
    console.error(`telemetry export failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
