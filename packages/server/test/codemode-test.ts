/** Offline codemode checks: limits, nested keys, uncertain outcomes, and
 * replay. Limit checks call the tool directly with stand-in nested tools; the
 * agent checks run pi-durable with cube's real workspace tools over a fake
 * runner. Real runner acceptance stays in smoke-node-adapter.ts. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type, type Message } from "@earendil-works/pi-ai";
import { defineTool, LiveDoc, type LiveState, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { CODEMODE_LIMITS, createCodemodeTool, type CodemodeDetails, type CodemodeLimits, type NestedTool } from "../src/codemode.ts";
import { openAgent, type Agent } from "../src/durable-agent.ts";
import { RunnerWorkspace, WorkspaceError } from "../src/workspace.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { FakeRunner } from "./workspace-fake-runner.ts";

const context = BACKGROUND_CONTEXT;
const text = (message: { content?: ReadonlyArray<{ type: string; text?: string }> }) => (message.content ?? []).map(part => part.text ?? "").join("");

// --- the tool alone, with stand-in nested tools -----------------------------

type Seen = { key: string; args: unknown };
function stand(name: string, behaviour: (args: { value?: string }, signal: AbortSignal | undefined, key: string) => Promise<string>, seen: Seen[], mutates = true): NestedTool {
  const registration = defineTool({
    name, description: `stand-in ${name}`,
    parameters: Type.Object({ value: Type.Optional(Type.String()) }),
    async execute() { throw new Error("direct calls are not used here"); },
  });
  return {
    registration, mutates,
    run: async (args: { value?: string }, _api, callContext, key) => {
      seen.push({ key, args });
      return { content: [{ type: "text", text: await behaviour(args, callContext.abortSignal, key) }] };
    },
  };
}
function harnessApi(taskId = 7) {
  const outputs: string[] = [];
  const details: unknown[] = [];
  const api = {
    taskId, conversationId: "c", callId: "call",
    output: (chunk: string) => { outputs.push(chunk); },
    diagnostic: () => {},
    details: async (value: unknown) => { details.push(value); },
  } as unknown as ToolExecutionApi;
  return { api, outputs, details };
}
async function run(code: string, tools: NestedTool[], limits: Partial<CodemodeLimits> = {}, taskId = 7) {
  const tool = createCodemodeTool({ tools, key: api => `pi:test:${api.taskId}`, limits });
  const { api, outputs } = harnessApi(taskId);
  const result = await tool.execute({ code }, api as never, context);
  return { result, body: text(result), details: result.details as CodemodeDetails, outputs, tool };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-codemode-"));
const runners: FakeRunner[] = [];
const stores: LeaseStore[] = [];
try {
  {
    // Nested keys are the codemode task key plus the call's sequence number,
    // and nested calls run one at a time in call order.
    const seen: Seen[] = [];
    let active = 0, most = 0;
    const echo = stand("echo", async args => { active++; most = Math.max(most, active); await delay(10); active--; return `got ${args.value}`; }, seen);
    const { result, body, details, outputs } = await run(`
      const [a, b] = await Promise.all([tools.echo({ value: "a" }), tools.echo({ value: "b" })]);
      text(a); console.log(b);
      return { last: await tools.echo({ value: "c" }) };
    `, [echo]);
    assert.equal(result.isError, false);
    assert.deepEqual(seen.map(each => each.key), ["pi:test:7:code:1", "pi:test:7:code:2", "pi:test:7:code:3"]);
    assert.deepEqual(seen.map(each => (each.args as { value: string }).value), ["a", "b", "c"]);
    assert.equal(most, 1, "nested calls never overlap");
    assert.match(body, /^Script completed\.\n\ngot a\ngot b\n\nReturn value:\n\{"last":"got c"\}$/);
    assert.deepEqual(details.calls.map(call => [call.n, call.status, call.key]), [[1, "ok", "pi:test:7:code:1"], [2, "ok", "pi:test:7:code:2"], [3, "ok", "pi:test:7:code:3"]]);
    assert.equal(details.completionUnknown, false);
    assert.match(outputs.join(""), /call 2 echo started \(key pi:test:7:code:2\)/);
    // The schema description renders for the model.
    const tool = createCodemodeTool({ tools: [echo], key: () => "k" });
    assert.match(tool.description, /declare const tools: \{[\s\S]*echo\(args: \{[\s\S]*value\?: string/);
    assert.equal(tool.replay, "unsafe");
    console.log("ok: nested keys are task key + sequence; one call at a time; declarations rendered; replay unsafe");
  }
  {
    // Source size and the options line are checked before anything runs.
    const seen: Seen[] = [];
    const echo = stand("echo", async () => "x", seen);
    const big = await run(`return 1;${" ".repeat(CODEMODE_LIMITS.sourceBytes)}`, [echo]);
    assert.equal(big.result.isError, true);
    assert.match(big.body, /^Script not run: the source is \d+ bytes; codemode accepts at most 65536/);
    assert.equal(big.details.limit, "sourceBytes");
    const exact = await run(`return 1;`.padEnd(CODEMODE_LIMITS.sourceBytes, " "), [echo]);
    assert.equal(exact.result.isError, false, "exactly the source limit runs");
    const options = await run(`// @options: {"nope": 1}\nreturn 1`, [echo]);
    assert.match(options.body, /^Script not run: /);
    // The options line can lower the deadline but never raise it.
    const spin = await run(`// @options: {"timeout_ms": 300}\nwhile (true) {}`, [echo]);
    assert.match(spin.body, /^Script failed \(timeout\)/);
    const capped = await run(`// @options: {"timeout_ms": 999999999}\nwhile (true) {}`, [echo], { timeoutMs: 300 });
    assert.match(capped.body, /^Script failed \(timeout\)/);
    assert.equal(seen.length, 0);
    console.log("ok: source size, options line and wall deadline");
  }
  {
    // Call count and argument size stop the whole script; a large nested
    // result is a catchable rejection.
    const seen: Seen[] = [];
    const echo = stand("echo", async args => args.value ?? "", seen);
    const atLimit = await run(`for (let i = 0; i < ${CODEMODE_LIMITS.maxCalls}; i++) await tools.echo({}); return "fine"`, [echo]);
    assert.equal(atLimit.result.isError, false, "exactly maxCalls calls are allowed");
    seen.length = 0;
    const tooMany = await run(`for (let i = 0; ; i++) { try { await tools.echo({}); } catch {} }`, [echo]);
    assert.equal(tooMany.result.isError, true);
    assert.match(tooMany.body, /^Script stopped by the maxCalls limit: more than 64 nested calls\./);
    assert.equal(seen.length, CODEMODE_LIMITS.maxCalls, "the call over the limit never runs");
    assert.equal(tooMany.details.limit, "maxCalls");
    seen.length = 0;
    const wide = await run(`await tools.echo({ value: "x".repeat(${CODEMODE_LIMITS.maxArgumentBytes}) }); return "unreachable"`, [echo]);
    assert.match(wide.body, /^Script stopped by the maxArgumentBytes limit: call 1 has \d+ bytes of arguments/);
    assert.equal(seen.length, 0);
    const large = stand("large", async () => "y".repeat(2000), []);
    const caught = await run(`try { await tools.large({}); } catch (error) { return error.message }`, [large], { maxCallResultBytes: 1000 });
    assert.equal(caught.result.isError, false);
    assert.match(caught.body, /large returned 2000 bytes; codemode hands at most 1000 bytes/);
    // Invalid arguments are refused before the nested tool runs.
    const invalid = await run(`try { await tools.echo({ value: { not: "a string" } }); } catch (error) { return "refused" }`, [echo]);
    assert.match(invalid.body, /"refused"/);
    assert.equal(seen.length, 0);
    console.log("ok: call count, argument size, nested result size and argument validation");
  }
  {
    // Memory and stack failures are script errors, not crashes; the final
    // result is cut with a notice.
    const oom = await run(`const parts = []; for (;;) parts.push("x".repeat(1 << 20) + parts.length);`, [], { memoryBytes: 8 * 1024 * 1024 });
    assert.match(oom.body, /^Script failed \(script\): out of memory/);
    const deep = await run(`function f(n) { return f(n + 1) + 1 } try { f(0) } catch (error) { return error.name }`, []);
    assert.match(deep.body, /"RangeError"/);
    const loud = await run(`text("z".repeat(5000)); return 1`, [], { maxResultBytes: 1000 });
    assert.equal(Buffer.byteLength(loud.body), 1000);
    assert.match(loud.body, /\[result cut at 1000 bytes; write large output to a workspace file/);
    const tokens = await run(`// @options: {"max_output_tokens": 50}\ntext("z".repeat(5000))`, []);
    assert.equal(Buffer.byteLength(tokens.body), 200);
    console.log("ok: memory limit, deep recursion and result bounds");
  }
  {
    // A mutating call stopped while running is reported as uncertain, a
    // queued call as not started, and an uncertain error the script caught
    // still marks the result.
    const seen: Seen[] = [];
    const slow = stand("slow", async (_args, signal) => { await delay(5000, undefined, { signal }); return "late"; }, seen);
    const quick = stand("quick", async () => "quick", seen);
    const stopped = await run(`tools.slow({}); tools.quick({}); return "left early"`, [slow, quick]);
    assert.equal(stopped.result.isError, true);
    assert.match(stopped.body, /^Script completed, but the outcome of some nested calls is uncertain\./);
    assert.match(stopped.body, /- call 1 slow \(key pi:test:7:code:1\)/);
    assert.deepEqual(stopped.details.calls.map(call => call.status), ["uncertain", "not started"]);
    assert.equal(stopped.details.completionUnknown, true);
    assert.deepEqual(seen.map(each => each.key), ["pi:test:7:code:1"], "the queued call never ran");
    const reader = stand("reader", async (_args, signal) => { await delay(5000, undefined, { signal }); return "late"; }, [], false);
    const readOnly = await run(`tools.reader({}); return 1`, [reader]);
    assert.equal(readOnly.result.isError, false, "a stopped read changes nothing");
    assert.deepEqual(readOnly.details.calls.map(call => call.status), ["error"]);
    const unknown = stand("unknown", async () => { throw new Error("wrapped", { cause: new WorkspaceError("COMPLETION_UNKNOWN") }); }, []);
    const swallowed = await run(`try { await tools.unknown({}) } catch {} return "ok"`, [unknown]);
    assert.equal(swallowed.result.isError, true);
    assert.match(swallowed.body, /Outcome uncertain: [\s\S]*call 1 unknown/);
    console.log("ok: uncertain, not started and caught unknown outcomes are reported honestly");
  }
  {
    // A nested call that ignores cancellation is uncertain after the grace,
    // and the next script is refused until it settles.
    let release!: () => void;
    const stuck = stand("stuck", () => new Promise<string>(resolve => { release = () => resolve("finally"); }), []);
    const tool = createCodemodeTool({ tools: [stuck], key: api => `pi:test:${api.taskId}`, limits: { settleMs: 100 } });
    const first = await tool.execute({ code: `tools.stuck({}); return 1` }, harnessApi(1).api as never, context);
    const details = first.details as CodemodeDetails;
    assert.equal(details.calls[0]!.status, "uncertain");
    assert.match(details.calls[0]!.error ?? "", /still running 100 ms after the script ended/);
    const refused = await tool.execute({ code: `return 2` }, harnessApi(2).api as never, context);
    assert.equal(refused.isError, true);
    assert.match(text(refused), /^Script not run: nested calls of an earlier codemode script are still running/);
    release();
    await delay(20);
    const again = await tool.execute({ code: `return 3` }, harnessApi(3).api as never, context);
    assert.equal(again.isError, false);
    console.log("ok: a call ignoring cancellation is uncertain and blocks the next script until it settles");
  }

  // --- the agent: cube's workspace tools through pi-durable ---------------
  const thread = (name: string) => {
    const files = path.join(root, name, "workspace");
    fs.mkdirSync(files, { recursive: true });
    const runner = new FakeRunner(files);
    const leases = new LeaseStore(path.join(root, name, "thread"));
    runners.push(runner); stores.push(leases);
    return { files, directory: path.join(root, name, "thread"), runner, workspace: new RunnerWorkspace({ runner, leases, owner: "pi" }) };
  };
  const model = (steps: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]) => {
    const faux = fauxProvider({ tokensPerSecond: 10000 });
    faux.setResponses(steps);
    const models = createModels();
    models.setProvider(faux.provider);
    return { models, model: { provider: faux.getModel().provider, id: faux.getModel().id } };
  };
  const codemode = (code: string) => fauxAssistantMessage([fauxToolCall("codemode", { code })], { stopReason: "toolUse" });
  const results = async (agent: Agent): Promise<Extract<Message, { role: "toolResult" }>[]> => {
    const watch = await agent.conversation.watch(context);
    await watch.stop();
    return watch.value.entries.flatMap(entry => (entry.model ?? []).filter(message => message.role === "toolResult"));
  };
  const until = async (check: () => Promise<boolean>, what: string) => {
    const deadline = Date.now() + 10000;
    while (!await check()) { assert(Date.now() < deadline, `waiting for ${what}`); await delay(20); }
  };
  const live = async (agent: Agent) => (await agent.harness.snapshot(LiveDoc, agent.conversation.id, context)) as LiveState | undefined;
  {
    const { files, directory, runner, workspace } = thread("agent");
    const agent = await openAgent({ directory, runner: { binding: runner.binding, configHash: "fake" }, workspace, ...model([
      codemode(`
        await tools.write({ path: "notes/a.txt", content: "one\\n" });
        await tools.edit({ path: "notes/a.txt", edits: [{ oldText: "one", newText: "two" }] });
        const listed = await tools.bash({ command: "cat notes/a.txt; printf more >> notes/a.txt" });
        const read = await tools.read({ path: "/workspace/notes/a.txt" });
        let outside;
        try { await tools.read({ path: "../escape" }) } catch (error) { outside = error.message }
        return { listed, read, outside };
      `),
      fauxAssistantMessage("done"),
    ]) });
    try {
      const submission = await agent.conversation.submit({ type: "input", content: "batch it" }, context);
      assert.equal((await submission.wait(context)).status, "done");
      assert.equal(fs.readFileSync(path.join(files, "notes/a.txt"), "utf8"), "two\nmore");
      const [result] = await results(agent);
      assert.equal(result!.isError, false, text(result!));
      const value = JSON.parse(text(result!).split("Return value:\n")[1]!);
      assert.equal(value.listed, "two\n\n[exit=0; exited]");
      assert.equal(value.read, "two\nmore");
      assert.match(value.outside, /outside the workspace/);
      const details = result!.details as CodemodeDetails;
      const base = details.calls[0]!.key.replace(/:code:1$/, "");
      assert.match(base, /^pi:[0-9a-f-]+:\d+$/);
      assert.deepEqual(details.calls.map(call => [call.name, call.key, call.status]), [
        ["write", `${base}:code:1`, "ok"], ["edit", `${base}:code:2`, "ok"], ["bash", `${base}:code:3`, "ok"],
        ["read", `${base}:code:4`, "ok"], ["read", `${base}:code:5`, "error"],
      ]);
    } finally { await agent.close(); }
    console.log("ok: codemode drives write/edit/bash/read through the Workspace with stable nested keys");
  }
  {
    // Stop reaches a nested command: it is killed on the runner.
    const { files, directory, runner, workspace } = thread("stop");
    const agent = await openAgent({ directory, runner: { binding: runner.binding, configHash: "fake" }, workspace, ...model([
      codemode(`await tools.bash({ command: "sleep 1; touch late" })`),
      fauxAssistantMessage("unreachable"),
    ]) });
    try {
      await agent.conversation.submit({ type: "input", content: "wait" }, context);
      await until(async () => (await live(agent))?.tools?.some(slot => slot.status === "running") ?? false, "running codemode");
      await delay(200);
      await agent.conversation.abort(context);
      await delay(1300);
      assert.equal(fs.existsSync(path.join(files, "late")), false, "the nested command was killed");
    } finally { await agent.close(); }
    console.log("ok: stop cancels a nested runner command");
  }
  {
    // A crash or shutdown mid-script is never rerun: the call is reported as
    // interrupted with the nested calls that had started, and the running
    // command is not started a second time.
    const { files, directory, runner, workspace } = thread("replay");
    let agent = await openAgent({ directory, runner: { binding: runner.binding, configHash: "fake" }, workspace, ...model([
      codemode(`await tools.bash({ command: "printf x >> count; sleep 0.5; printf z >> count" }); await tools.bash({ command: "printf y >> count" }); return "finished"`),
      fauxAssistantMessage("first"),
    ]) });
    const submission = await agent.conversation.submit({ type: "input", content: "count" }, context);
    await until(async () => (await live(agent))?.tools?.some(slot => slot.status === "running") ?? false, "running codemode");
    await until(async () => fs.existsSync(path.join(files, "count")), "first nested command");
    await agent.close();
    await delay(800);
    agent = await openAgent({ directory, runner: { binding: runner.binding, configHash: "fake" }, workspace, ...model([fauxAssistantMessage("recovered")]) });
    try {
      const settled = await (await agent.harness.submission(submission.id, context))!.wait(context);
      assert.equal(settled.status, "done");
      const [result] = await results(agent);
      assert.equal(result!.isError, true);
      assert.match(text(result!), /\[codemode\] call 1 bash started \(key pi:[0-9a-f-]+:\d+:code:1\)/);
      assert.match(JSON.stringify(result), /codemode was interrupted and may have partially run/);
      await delay(200);
      // Codemode is never reattached, so shutdown cancelled its nested command.
      assert.equal(fs.readFileSync(path.join(files, "count"), "utf8"), "x", "the nested command was cancelled, nothing ran twice and the script did not continue");
    } finally { await agent.close(); }
    console.log("ok: shutdown cancels nested commands; an interrupted codemode call is reported as possibly partially run, never replayed");
  }
} finally {
  for (const runner of runners) runner.close();
  for (const store of stores) store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
