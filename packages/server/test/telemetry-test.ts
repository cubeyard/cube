/** Telemetry, offline: Claude Code's stream-json lines and a real Pi store
 * become per-call and per-turn records (frames of one response counted once,
 * a repeated result once, unknown counters null, never zero), reconciled with
 * usage.ts's ledger, exported without any text of the thread. Disposable state only. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { createRegistry, Harness, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { openStorage } from "../src/durable-agent.ts";
import { analysisText, exportTelemetry, readThread } from "../src/telemetry-export.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-telemetry-"));
const threads = path.join(root, "threads");
const SECRET = "SECRET-7f3a";

// ---- Claude Code: a claude.sqlite as claude-agent.ts writes it ----
const claudeThread = "c1aude00-0000-4000-8000-000000000001";
{
  const directory = path.join(threads, claudeThread);
  fs.mkdirSync(directory, { recursive: true });
  const db = new DatabaseSync(path.join(directory, "claude.sqlite"));
  db.exec(`CREATE TABLE submission(seq INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL UNIQUE, text TEXT NOT NULL, state TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE message(seq INTEGER PRIMARY KEY AUTOINCREMENT, submission INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE steer(request_id TEXT PRIMARY KEY, uuid TEXT NOT NULL UNIQUE, text TEXT NOT NULL, submission INTEGER NOT NULL, state TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL);`);
  const submit = db.prepare("INSERT INTO submission(request_id, text, state, created_at) VALUES (?, ?, ?, ?)");
  submit.run("tell:1", `prompt ${SECRET}`, "completed", 1_000);
  submit.run("tell:2", `prompt ${SECRET}`, "failed", 2_000);
  submit.run("tell:3", `prompt ${SECRET}`, "completed", 3_000);
  submit.run("cube:background:x:lost", "", "stopped", 3_500);
  db.prepare("INSERT INTO steer VALUES ('s1', 'u1', ?, 3, 'consumed', NULL, 3100)").run(`steer ${SECRET}`);
  const put = (submission: number, data: unknown) => db.prepare("INSERT INTO message(submission, data) VALUES (?, ?)").run(submission, JSON.stringify(data));
  const frame = (id: string, content: unknown, usage: unknown, extra: Record<string, unknown> = {}) =>
    ({ type: "assistant", parent_tool_use_id: null, uuid: `${id}-${Math.random()}`, timestamp: "2026-10-27T10:00:00.000Z", message: { id, model: "claude-opus-5-5", content: [content], stop_reason: null, usage }, ...extra });
  const totals = (input: number, output: number, cacheRead: number, cacheWrite: number, usd: number) =>
    ({ "claude-opus-5-5": { inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite, costUSD: usd, costBasis: "list" } });
  const usageA = { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 200 } };
  put(1, { type: "user", message: { role: "user", content: SECRET } });
  put(1, { type: "system", subtype: "init", session_id: "s", claude_code_version: "2.1.310", model: "opus", cwd: `/home/${SECRET}` });
  put(1, frame("msg_A", { type: "thinking", thinking: SECRET }, usageA));
  put(1, frame("msg_A", { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: `echo ${SECRET}` } }, usageA));
  put(1, frame("msg_B", { type: "text", text: SECRET }, { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 300 }, { parent_tool_use_id: "toolu_1" }));
  const result1 = { type: "result", subtype: "success", is_error: false, uuid: "r1", result: SECRET, duration_ms: 5000, duration_api_ms: 4000, ttft_ms: 900, num_turns: 2,
    stop_reason: "end_turn", terminal_reason: "completed", total_cost_usd: 0.5,
    usage: { input_tokens: 20, output_tokens: 300, cache_read_input_tokens: 2000, cache_creation_input_tokens: 400, cache_creation: { ephemeral_1h_input_tokens: 400 } },
    modelUsage: totals(30, 350, 2100, 900, 0.5) };
  put(1, result1);
  put(1, result1);
  put(2, { type: "system", subtype: "api_retry", attempt: 1, max_retries: 10, retry_delay_ms: 500, error_status: 529, error: "server_error", uuid: "a1", session_id: "s" });
  put(2, frame("msg_E", { type: "text", text: `API Error: ${SECRET}` }, { input_tokens: 0, output_tokens: 0 }, { error: "rate_limit", message: { id: "msg_E", model: "<synthetic>", content: [], usage: { input_tokens: 0, output_tokens: 0 } } }));
  put(3, { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 150_000, post_tokens: 9_000, duration_ms: 30_000 }, uuid: "c1" });
  put(3, { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning", rateLimitType: "five_hour", utilization: 0.81, isUsingOverage: false }, uuid: "l1" });
  put(3, frame("msg_C", { type: "text", text: SECRET }, { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 500 }));
  put(3, { ...result1, uuid: "r3", duration_ms: 8000, duration_api_ms: 7000, ttft_ms: 1500, num_turns: 1, modelUsage: totals(40, 500, 2200, 1600, 0.8),
    usage: { input_tokens: 3, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 500 } });
  db.close();

  const item = (await readThread(directory))!;
  assert.equal(item.agent, "claude-code");
  assert.deepEqual(item.versions, ["2.1.310"]);
  assert.deepEqual(item.calls.map(call => [call.id, call.source, call.failed]), [
    [`claude:${claudeThread}:msg_A`, "main", false], [`claude:${claudeThread}:msg_B`, "subagent", false],
    [`claude:${claudeThread}:msg_E`, "main", true], [`claude:${claudeThread}:msg_C`, "main", false]], "one call per message id, error frames marked failed");
  assert.deepEqual(item.calls[0]!.tokens, { input: 10, output: null, cacheRead: 1000, cacheWrite: 200, cacheWrite1h: 200, reasoning: null },
    "a streamed frame's output is not final: unknown, not 1");
  assert.deepEqual(item.calls[1]!.tokens.cacheWrite1h, null, "a missing TTL split is unknown");
  assert.deepEqual(item.calls[2]!.tokens, { input: null, output: null, cacheRead: null, cacheWrite: null, cacheWrite1h: null, reasoning: null }, "an error frame's cost is unknown");
  assert.equal(item.calls[0]!.startedAt, Date.parse("2026-10-27T10:00:00.000Z"));
  assert.deepEqual(item.turns.map(turn => [turn.state, turn.results, turn.calls, turn.retries, turn.durationMs, turn.apiDurationMs, turn.ttftMs, turn.error]), [
    ["completed", 1, 2, 0, 5000, 4000, 900, false], ["failed", 0, 1, 1, null, null, null, null], ["completed", 1, 1, 0, 8000, 7000, 1500, false]],
    "a repeated result counts once; a turn without one has unknown times; the lost background row is no turn");
  assert.deepEqual(item.turns[0]!.tokens, { input: 20, output: 300, cacheRead: 2000, cacheWrite: 400, cacheWrite1h: 400, reasoning: null });
  assert.deepEqual(item.turns[2]!.steers, { queued: 0, consumed: 1, dropped: 0 });
  assert.deepEqual(item.events.map(event => event.kind), ["process", "retry", "compaction", "rate-limit"]);
  assert.deepEqual(item.events[2], { kind: "compaction", thread: claudeThread, turn: `claude:${claudeThread}:3`, seq: 10, trigger: "auto", preTokens: 150_000, postTokens: 9_000, durationMs: 30_000 });
  assert.equal(item.ledger.unknownTurns, 1, "the failed turn without a result is unknown in the ledger too");
  // Ledger 40 in / 2200 read / 1600 write; calls 10+5+3 / 1000 / 200+300+500. Output is unknown per call.
  assert.deepEqual(item.gap, { input: 22, output: null, cacheRead: 1200, cacheWrite: 600 }, "the gap is what the per-call frames miss");
}

// ---- Pi: a real store, one failed attempt retried, two prompts ----
const piThread = "9100000-0000-4000-8000-000000000002";
{
  const faux = fauxProvider({ models: [{ id: "priced", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } }], tokensPerSecond: 100_000 });
  faux.setResponses([
    () => fauxAssistantMessage(`answer ${SECRET}`),
    () => fauxAssistantMessage("", { stopReason: "error", errorMessage: `529 overloaded ${SECRET}` }),
    () => fauxAssistantMessage(`answer ${SECRET}`),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel();
  const directory = path.join(threads, piThread);
  fs.mkdirSync(directory, { recursive: true });
  const harness = await Harness.open(await openStorage(path.join(directory, "pi.sqlite")), { models, registry: createRegistry(), settings: { retry: { baseDelayMs: 1 } } }, context);
  const conversation = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
  for (const text of [`first ${SECRET}`, `second ${SECRET}`]) {
    await conversation.submit({ type: "input", content: text, requestId: `r-${text}` }, context);
    await harness.waitForIdle(context);
  }
  const ledger = await harness.usage(context);
  await harness.close(context);
  assert.equal(ROOT_CONVERSATION_ID, conversation.id);

  const item = (await readThread(directory))!;
  assert.equal(item.agent, "pi");
  assert.deepEqual(item.calls.map(call => [call.stopReason, call.failed, call.source, call.model]), [["stop", false, "main", "priced"], ["error", true, "main", "priced"], ["stop", false, "main", "priced"]],
    "every attempt is a call, the failed one marked");
  assert.ok(item.calls.every(call => call.durationMs !== null && call.startedAt !== null), "pi records each request's start and duration");
  assert.deepEqual(item.turns.map(turn => [turn.calls, turn.failedCalls, turn.error]), [[1, 0, false], [2, 1, false]]);
  // The faux provider reports tokens but no cost: unpriced, not free.
  assert.deepEqual(item.calls.map(call => [call.tokens.input, call.tokens.output, call.tokens.cacheRead, call.tokens.cacheWrite, call.estimatedUsd]),
    [[6, 5, 0, 6, null], [14, 0, 6, 14, null], [0, 5, 20, 0, null]], "a failed attempt keeps the tokens pi recorded for it");
  assert.deepEqual(item.ledger.lines.map(line => [line.model, line.spend.unpricedTokens]), [["priced", 76]]);
  assert.deepEqual(item.gap, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, "without compaction the calls are the whole ledger");
  assert.deepEqual(Object.keys(ledger.models), ["faux/priced"]);
  assert.equal(fs.readdirSync(directory).filter(name => name.startsWith(".read-")).length, 0, "the private copy is removed");
}

// ---- Export and analysis ----
{
  const out = path.join(root, "out");
  const { analysis, skipped } = await exportTelemetry(threads, out);
  assert.deepEqual(skipped, []);
  assert.equal(analysis.threads, 2);
  assert.equal(analysis.billedUsd, null);
  const claude = analysis.byAgent["claude-code"], pi = analysis.byAgent.pi;
  assert.deepEqual([claude.calls, claude.turns, claude.turnsWithResult, claude.callsWithOutput, claude.retries, claude.compactions, claude.rateLimits, claude.unknownTurns], [4, 3, 2, 0, 1, 1, 1, 1]);
  assert.deepEqual(claude.turnMs, { n: 2, p50: 5000, p90: 8000, max: 8000 });
  assert.deepEqual(claude.turnTokens, { input: 23, output: 450, cacheRead: 2000, cacheWrite: 900, cacheWrite1h: null, reasoning: null }, "turn tokens over turns with a result; a missing TTL split stays unknown");
  assert.ok(Math.abs(claude.ledgerUsd - 0.8) < 1e-9, "claude code's estimate comes from its running totals");
  assert.deepEqual([pi.calls, pi.turns, pi.callsWithDuration, pi.callsWithOutput, pi.ledgerUnpricedTokens], [3, 2, 3, 3, 76]);
  const faux = analysis.groups.find(group => group.agent === "pi")!;
  assert.deepEqual([faux.calls, faux.failedCalls, faux.coldWrites, faux.estimatedUsd?.pricedCalls, faux.estimatedUsd?.unpricedCalls], [3, 1, 0, 0, 3],
    "only the thread's first call wrote without reading, and a first call is no cold write");
  assert.deepEqual(faux.prompt, { calls: 3, prompt: 66, read: 26, write: 20, uncached: 20 });
  const opus = analysis.groups.find(group => group.model === "claude-opus-5-5")!;
  assert.deepEqual(opus.prompt, { calls: 3, prompt: 2018, read: 1000, write: 1000, uncached: 18 });
  assert.equal(opus.coldWrites, 2, "the subagent's and the third turn's call wrote without reading");
  assert.deepEqual(opus.output, { calls: 0, tokens: 0 });
  assert.equal(opus.estimatedUsd, null, "claude code prices no single call");
  assert.equal(analysis.groups.find(group => group.model === "<synthetic>"), undefined, "an error frame is no model");
  const text = analysisText(analysis);
  assert.match(text, /claude-code claude-opus-5-5: 3 calls in 1 threads, 0 failed/);
  assert.match(text, /output: unknown per call; call time: unknown\n  per-call estimate: not recorded per call/);
  assert.match(text, /pi: 1 threads, 2 turns, 3 calls/);
  assert.match(text, /billed amounts unknown/);

  const manifest = JSON.parse(fs.readFileSync(path.join(out, "MANIFEST.json"), "utf8")) as { files: Record<string, string> };
  assert.deepEqual(Object.keys(manifest.files).sort(), ["analysis.json", "calls.jsonl", "events.jsonl", "threads.jsonl", "turns.jsonl"]);
  for (const [name, hash] of Object.entries(manifest.files)) {
    const body = fs.readFileSync(path.join(out, name), "utf8");
    assert.equal(createHash("sha256").update(body).digest("hex"), hash, `${name} matches its manifest hash`);
    assert.ok(!body.includes(SECRET), `${name} holds no text of the thread`);
  }
  assert.equal(fs.readFileSync(path.join(out, "calls.jsonl"), "utf8").trim().split("\n").length, 7);
  assert.equal(fs.statSync(path.join(out, "calls.jsonl")).mode & 0o777, 0o600);
}

fs.rmSync(root, { recursive: true, force: true });
console.log("telemetry ok");
