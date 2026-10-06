/** Usage accounting, offline: Claude Code's cumulative stream-json totals
 * become per-turn usage counted once (duplicates, a resumed process with and
 * without carried totals, a reset, turns without a result, unpriced models);
 * Pi's ledger is read from an open agent, kept as it closes and read again
 * from an archived store; OptChat's compactor calls are counted; missing
 * usage and missing prices never read as zero. Disposable state only. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type Usage } from "@earendil-works/pi-ai";
import { createRegistry, Harness, ROOT_CONVERSATION_ID, type UsageState } from "@earendil-works/pi-durable";
import { openStorage } from "../src/durable-agent.ts";
import type { Registry, Thread } from "../src/registry.ts";
import { claudeLines, costState, piSpend, spendText, totals, subject, type ClaudeRecord, type ClaudeTurn } from "../src/usage.ts";
import { threadUsageText, UsageService, usageText } from "../src/usage-service.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-usage-"));

// ---- Claude Code: running totals per process ----
const totalsOf = (input: number, cost: number, model = "claude-opus-4-7", basis = "list") =>
  ({ [model]: { inputTokens: input, outputTokens: input / 10, cacheReadInputTokens: input * 2, cacheCreationInputTokens: 0, costUSD: cost, webSearchRequests: 0, contextWindow: 200000, maxOutputTokens: 32000, costBasis: basis } });
const init = (submission: number, session: string): ClaudeRecord => ({ submission, data: { type: "system", subtype: "init", session_id: session } });
const result = (submission: number, session: string, modelUsage: unknown, extra: Record<string, unknown> = {}): ClaudeRecord =>
  ({ submission, data: { type: "result", subtype: "success", is_error: false, session_id: session, modelUsage, total_cost_usd: 0, usage: { input_tokens: 10 }, ...extra } });
const turn = (seq: number, state: ClaudeTurn["state"] = "completed"): ClaudeTurn => ({ seq, state });
const opus = (lines: ReturnType<typeof claudeLines>["lines"], model = "claude-opus-4-7") => lines.find(line => line.model === model)!;

{
  // One process, two turns, a repeated result line: 100 + 50 input, once.
  const records = [init(1, "s1"), result(1, "s1", totalsOf(100, 1), { uuid: "r1" }), result(1, "s1", totalsOf(100, 1), { uuid: "r1" }),
    result(2, "s1", totalsOf(150, 1.5), { uuid: "r2" })];
  const { lines, unknownTurns } = claudeLines(records, [turn(1), turn(2)]);
  assert.equal(opus(lines).spend.tokens.input, 150, "cumulative totals are differenced, a duplicate counted once");
  assert.equal(opus(lines).spend.tokens.cacheRead, 300);
  assert.ok(Math.abs(opus(lines).spend.estimatedUsd - 1.5) < 1e-9);
  assert.equal(unknownTurns, 0);
  assert.equal(opus(lines).provider, "claude-code");
}
{
  // A resumed process that continued the saved totals: its first result
  // holds them, so only the increase is this turn's.
  const records = [init(1, "s1"), result(1, "s1", totalsOf(100, 1)), init(2, "s1"), result(2, "s1", totalsOf(130, 1.3))];
  const { lines, notes } = claudeLines(records, [turn(1), turn(2)]);
  assert.equal(opus(lines).spend.tokens.input, 130, "carried totals are not counted twice");
  assert.ok(notes.some(note => note.includes("continued the totals of every earlier turn")));
}
{
  // The same with a session id that changed on resume, and reasoning
  // tokens: the store's order decides, and reasoning is carried too.
  const withThinking = (input: number, thinking: number) => {
    const value = totalsOf(input, input / 100);
    return { "claude-opus-4-7": { ...value["claude-opus-4-7"], thinkingTokens: thinking } };
  };
  const records = [init(1, "s1"), result(1, "s1", withThinking(100, 7)), result(2, "s1", withThinking(150, 9)),
    init(3, "s2"), result(3, "s2", withThinking(190, 12))];
  const { lines } = claudeLines(records, [turn(1), turn(2), turn(3)]);
  assert.equal(opus(lines).spend.tokens.input, 190, "a new session id after --resume does not count the carried totals again");
  assert.equal(opus(lines).spend.tokens.reasoning, 12, "reasoning carried across a resumed process is not counted twice");
}
{
  // Three processes; the third carries only its predecessor's totals.
  const records = [init(1, "s1"), result(1, "s1", totalsOf(100, 1)), init(2, "s1"), result(2, "s1", totalsOf(40, 0.4)),
    init(3, "s1"), result(3, "s1", totalsOf(60, 0.6))];
  const { lines, notes } = claudeLines(records, [turn(1), turn(2), turn(3)]);
  assert.equal(opus(lines).spend.tokens.input, 160);
  assert.ok(notes.some(note => note.includes("the previous process's totals")));
}
{
  // A zeroed error_during_execution result without is_error: unknown, not zero.
  const records = [init(1, "s1"), result(1, "s1", totalsOf(100, 1)), result(2, "s1", {}, { subtype: "error_during_execution" })];
  const { unknownTurns } = claudeLines(records, [turn(1), turn(2, "failed")]);
  assert.equal(unknownTurns, 1);
}
{
  // A resumed process that started from zero: its first result is its own.
  const records = [init(1, "s1"), result(1, "s1", totalsOf(100, 1)), init(2, "s1"), result(2, "s1", totalsOf(40, 0.4))];
  const { lines, notes } = claudeLines(records, [turn(1), turn(2)]);
  assert.equal(opus(lines).spend.tokens.input, 140);
  assert.ok(notes.some(note => note.includes("started its totals from zero")));
}
{
  // A turn cut off without a result, a zeroed error result and a running
  // turn: the first two are unknown, not zero; the running one is pending.
  const records = [init(1, "s1"), result(1, "s1", totalsOf(100, 1)),
    { submission: 3, data: { type: "result", subtype: "error_during_execution", is_error: true, session_id: "s1", modelUsage: {}, total_cost_usd: 0 } }];
  const { lines, unknownTurns, notes } = claudeLines(records, [turn(1), turn(2, "failed"), turn(3, "failed"), turn(4, "running")]);
  assert.equal(unknownTurns, 2);
  assert.equal(opus(lines).spend.tokens.input, 100);
  assert.ok(notes.some(note => note.includes("without a usage report")));
  const usage = subject({ subject: "t", kind: "thread", title: null, projectId: "p", agent: "claude-code", archived: false, lines, unknownTurns, read: "store", readAt: 1, notes });
  assert.equal(usage.coverage, "partial");
}
{
  // A running total that goes down (a reset) counts from zero after it;
  // subagent and main-loop calls are both in modelUsage, so assistant
  // messages (here with a parent tool use) are not added again.
  const records = [init(1, "s1"), result(1, "s1", totalsOf(100, 1)),
    { submission: 2, data: { type: "assistant", parent_tool_use_id: "toolu_1", message: { id: "m", usage: { input_tokens: 999 } } } },
    result(2, "s1", totalsOf(30, 0.3))];
  const { lines, notes } = claudeLines(records, [turn(1), turn(2)]);
  assert.equal(opus(lines).spend.tokens.input, 130);
  assert.ok(notes.some(note => note.includes("went down")));
}
{
  // A model Claude Code had no price for: unpriced, never $0. A result
  // without modelUsage (an older Claude Code) is an unknown turn.
  const records = [init(1, "s1"), result(1, "s1", totalsOf(100, 0.5, "mystery-model", "unknown")), result(2, "s1", undefined)];
  const { lines, unknownTurns } = claudeLines(records, [turn(1), turn(2)]);
  const line = opus(lines, "mystery-model");
  assert.equal(costState(line.spend), "unknown");
  assert.equal(line.spend.estimatedUsd, 0);
  assert.equal(line.spend.unpricedTokens, 310);
  assert.match(spendText(line.spend), /cost unknown/);
  assert.equal(unknownTurns, 1);
}

// ---- Pi: catalog estimates ----
{
  const usage = (cost: number): Usage => ({ input: 1000, output: 200, cacheRead: 5000, cacheWrite: 0, totalTokens: 6200, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
  assert.equal(costState(piSpend(usage(0.12))), "estimated");
  assert.equal(costState(piSpend(usage(0))), "unknown", "tokens without a price are unpriced, not free");
  const mixed = piSpend(usage(0.12));
  const unpriced = piSpend(usage(0));
  mixed.estimatedUsd += unpriced.estimatedUsd; mixed.unpricedTokens += unpriced.unpricedTokens;
  assert.equal(costState(mixed), "partial");
  assert.match(spendText(mixed), /≈ \$0\.12 est\. \+ 6\.2k unpriced tokens/);
  const nothing = subject({ subject: "x", kind: "thread", title: null, projectId: "p", agent: "pi", archived: false, lines: [], unknownTurns: 0, read: "none", readAt: null, notes: [] });
  assert.equal(nothing.coverage, "unavailable");
  assert.equal(totals([nothing]).coverage, "unavailable");
  // Calls known to have happened without a record make the subject partial.
  const older = subject({ subject: "optchat", kind: "optchat", title: null, projectId: null, agent: "optchat", archived: false, lines: [], unknownTurns: 0, incomplete: true, read: "live", readAt: 1, notes: [] });
  assert.equal(older.coverage, "partial");
  assert.equal(totals([older]).coverage, "partial");
}

// ---- Pi stores through the service ----
const faux = fauxProvider({ models: [{ id: "priced", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }], tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 20 }, () => () => fauxAssistantMessage("done")));
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();

/** A Pi store with one answered prompt, like a thread's. */
async function piStore(directory: string): Promise<Harness> {
  fs.mkdirSync(directory, { recursive: true });
  const harness = await Harness.open(await openStorage(path.join(directory, "pi.sqlite")), { models, registry: createRegistry() }, context);
  const conversation = await harness.conversation(ROOT_CONVERSATION_ID, context) ?? await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
  await conversation.submit({ type: "input", content: "hello", requestId: `r-${Math.random()}` }, context);
  await harness.waitForIdle(context);
  return harness;
}

const thread = (id: string, archived: boolean): Thread => ({ id, projectId: "p1", title: `thread ${id}`, createdAt: 1, archived, model: { provider: model.provider, id: model.id },
  runnerId: "r", allocation: { repositories: [] } as unknown as Thread["allocation"], workspaceState: "available", workspaceError: null });
const records = new Map<string, Thread>();
const registry = {
  getThread: (id: string) => records.get(id) ?? null,
  listThreads: () => [...records.values()],
  getProject: (id: string) => id === "p1" ? { id, name: "cube" } : null,
  listProjects: () => [{ id: "p1", name: "cube" }],
} as unknown as Registry;
const threads = path.join(root, "threads");
const live = new Map<string, Harness>();
const service = () => new UsageService({ file: path.join(root, "usage.sqlite"), registry, threads, optchatStore: path.join(root, "optchat", "pi.sqlite"),
  live: async id => live.get(id)?.usage(context) as Promise<UsageState> ?? null });

{
  records.set("open", thread("open", false));
  const harness = await piStore(path.join(threads, "open"));
  live.set("open", harness);
  const usage = service();
  const reading = await usage.thread("open");
  assert.equal(reading.read, "live");
  assert.ok(reading.spend.tokens.total > 0);
  // The faux provider reports no cost: Pi's ledger holds tokens without a price.
  assert.equal(costState(reading.spend), "unknown");
  assert.match(threadUsageText(reading), /cost unknown/);
  // The agent closes (archive or shutdown): its reading is kept.
  usage.remember("open", await harness.usage(context) as UsageState);
  await harness.close(context);
  live.delete("open");
  const kept = await usage.thread("open");
  assert.equal(kept.read, "snapshot", "an unopened thread's store is never opened beside its owner");
  assert.deepEqual(kept.spend, reading.spend);
  // Archived: its store is read again (nothing else may open it now).
  records.set("open", thread("open", true));
  const stat = (name: string) => { try { const value = fs.statSync(path.join(threads, "open", name)); return `${value.size}:${value.mtimeMs}`; } catch { return "-"; } };
  const before = [stat("pi.sqlite"), stat("pi.sqlite-wal")];
  const archived = await usage.thread("open");
  assert.deepEqual([stat("pi.sqlite"), stat("pi.sqlite-wal")], before, "an archived store is read from a copy, never changed");
  assert.equal(archived.read, "store");
  assert.equal(archived.archived, true);
  assert.deepEqual(archived.spend, reading.spend);
  usage.close();
  // A new process: the snapshot persists, the unchanged store is a cache hit.
  const again = service();
  assert.deepEqual((await again.thread("open")).spend, reading.spend);
  // A store that cannot be read: the last reading, saying so.
  fs.writeFileSync(path.join(threads, "open", "pi.sqlite"), "not a database");
  fs.rmSync(path.join(threads, "open", "pi.sqlite-wal"), { force: true });
  const fallback = await again.thread("open");
  assert.equal(fallback.read, "snapshot");
  assert.deepEqual(fallback.spend, reading.spend);
  assert.ok(fallback.notes.some(note => note.includes("could not be read now")));
  again.close();
}
{
  // A thread whose agent never opened and has no snapshot: unknown, not zero.
  records.set("cold", thread("cold", false));
  fs.mkdirSync(path.join(threads, "cold"), { recursive: true });
  fs.writeFileSync(path.join(threads, "cold", "pi.sqlite"), "");
  const usage = service();
  const cold = await usage.thread("cold");
  assert.equal(cold.coverage, "unavailable");
  const report = await usage.report();
  assert.equal(report.totals.unavailable, 1);
  assert.equal(report.totals.coverage, "partial");
  assert.equal(report.billed.usd, null);
  assert.match(usageText(report), /not included: 1 thread not readable now/);
  assert.match(usageText(report), /optchat itself: ≈ \$0\.00 est\./, "an optchat that never started used nothing");
  usage.close();
  records.delete("cold");
}
{
  // A claude-code thread's own store (cube's schema), read beside its writer.
  records.set("claude", { ...thread("claude", false), agent: "claude-code" });
  const directory = path.join(threads, "claude");
  fs.mkdirSync(directory, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(directory, "claude.sqlite"));
  db.exec(`CREATE TABLE submission(seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, state TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE message(seq INTEGER PRIMARY KEY AUTOINCREMENT, submission INTEGER NOT NULL, data TEXT NOT NULL);`);
  db.prepare("INSERT INTO submission(request_id, text, state, created_at) VALUES ('a', 'x', 'completed', 1), ('b', 'y', 'failed', 2)").run();
  for (const record of [init(1, "s"), { submission: 1, data: { type: "assistant", message: { usage: { input_tokens: 5 } } } }, result(1, "s", totalsOf(100, 1))]) {
    db.prepare("INSERT INTO message(submission, data) VALUES (?, ?)").run(record.submission, JSON.stringify(record.data));
  }
  const usage = service();
  const reading = await usage.thread("claude");
  assert.equal(reading.lines[0]!.spend.tokens.input, 100);
  assert.equal(reading.unknownTurns, 1);
  assert.equal(reading.coverage, "partial");
  db.close();
  const report = await usage.report({ project: "p1" });
  assert.equal(report.optchat, null);
  assert.ok(report.models.some(line => line.provider === "claude-code"));
  assert.match(usageText(report, { projectName: "cube" }), /claude code's own estimate|claude-code/);
  usage.close();
}

// ---- OptChat's compactor ----
{
  const { OptChat } = await import("../src/optchat.ts");
  faux.setResponses(Array.from({ length: 50 }, () => () => fauxAssistantMessage("a short summary line")));
  const chat = await OptChat.open({ directory: path.join(root, "optchat"), models, model: async () => ({ provider: model.provider, id: model.id }),
    threads: { projects: async () => "", spawn: async () => { throw new Error("no"); }, tell: async () => {}, describe: async () => "", events: async () => null },
    limits: { retryMs: 50, watchMs: 60_000 } });
  try {
    // Longer than a node: the compactor summarizes it.
    await chat.send(`a long message for the log ${"words ".repeat(200)}`, "m1");
    const deadline = Date.now() + 15_000;
    let counted;
    do {
      counted = await chat.usage();
      if (Object.keys(counted.compactor.calls).length && Object.keys(counted.chat.models).length) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    const key = `${model.provider}/${model.id}`;
    assert.ok(counted.compactor.calls[key]! >= 1, JSON.stringify(counted));
    assert.ok(counted.compactor.models[key]!.totalTokens > 0);
    assert.ok(counted.chat.models[key]!.totalTokens > 0, "the chat's own calls are in its Pi ledger");
    const usage = new UsageService({ file: path.join(root, "usage.sqlite"), registry, threads, live: async () => null, optchat: async () => chat.usage() });
    const report = await usage.report();
    assert.ok(report.optchat!.lines.some(line => line.source === "optchat-compactor" && line.calls! >= 1));
    assert.ok(report.optchat!.lines.some(line => line.source === "optchat"));
    assert.match(usageText(report), /optchat itself: .*compactor/);
    assert.ok(!counted.compactor.earlier, "a new chat counts its compactor from its first call");
    assert.equal(report.optchat!.coverage, "complete");
    usage.close();
  } finally { await chat.close(); }
  // Reopened: still counted from its first open, so nothing is unknown.
  const reopened = await OptChat.open({ directory: path.join(root, "optchat"), models, model: async () => ({ provider: model.provider, id: model.id }),
    threads: { projects: async () => "", spawn: async () => { throw new Error("no"); }, tell: async () => {}, describe: async () => "", events: async () => null },
    limits: { retryMs: 50, watchMs: 60_000 } });
  try { assert.ok(!(await reopened.usage()).compactor.earlier); }
  finally { await reopened.close(); }
}
{
  // A chat whose tree was built before the compactor was counted (an older
  // cube): its free nodes cost nothing, its compacted ones are unknown.
  const { OptChat } = await import("../src/optchat.ts");
  const threads = { projects: async () => "", spawn: async () => { throw new Error("no"); }, tell: async () => {}, describe: async () => "", events: async () => null };
  const open = (directory: string) => OptChat.open({ directory, models, model: async () => ({ provider: model.provider, id: model.id }), threads, limits: { retryMs: 50, watchMs: 60_000 } });
  const older = async (directory: string, text: string) => {
    let chat = await open(directory);
    await chat.send(text, "m1");
    for (const deadline = Date.now() + 15_000; Date.now() < deadline && !Object.keys((await chat.usage()).chat.models).length;) await new Promise(resolve => setTimeout(resolve, 50));
    await new Promise(resolve => setTimeout(resolve, 300));
    await chat.close();
    // What an older cube left: no compactor count at all.
    const harness = await Harness.open(await openStorage(path.join(directory, "pi.sqlite")), { models, registry: createRegistry() }, context);
    const { defineDoc } = await import("@earendil-works/pi-durable");
    const doc = defineDoc<{ models: Record<string, never>; calls: Record<string, number>; since: number | null; earlier?: boolean }>({ kind: "cube.optchat.usage", version: 1, scope: "session", initial: () => ({ models: {}, calls: {}, since: null }) });
    await harness.commit(async tx => { const usage = await tx.doc(doc); usage.since = null; delete usage.earlier; }, context);
    await harness.close(context);
    chat = await open(directory);
    try { return (await chat.usage()).compactor.earlier; } finally { await chat.close(); }
  };
  assert.ok(!await older(path.join(root, "optchat-free"), "hi"), "free nodes cost nothing");
  assert.equal(await older(path.join(root, "optchat-compacted"), `long ${"words ".repeat(200)}`), true);
}

fs.rmSync(root, { recursive: true, force: true });
console.log("ok: usage: claude code running totals once per turn (duplicates, resume with and without carried totals, reset, turns without a report, unpriced), pi ledger live, kept at close, archived store, optchat compactor counted, unknown never zero");
