/** Large thread stores for the history read tests: a Pi store written by a
 * real Harness (faux model, a stand-in bash tool with long output, Pi's own
 * live document, submissions and compaction), and a Claude Code store in
 * the agent's own schema. Disposable state only. */
import { randomBytes } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { ClaudeAgent } from "../src/claude-agent.ts";
import { openStorage } from "../src/durable-agent.ts";
import type { Workspace } from "../src/workspace.ts";

const context = BACKGROUND_CONTEXT;
/** Output that looks like a build log: varied lines, not one repeated byte. */
export const output = (bytes: number) => {
  const lines: string[] = [];
  let size = 0;
  while (size < bytes) {
    const line = `src/${randomBytes(4).toString("hex")}.ts:${size % 997}: ${randomBytes(24).toString("base64")}`;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n");
};

/** `runs` inputs, each answered after `calls` bash calls of `bytes` output;
 * `from` numbers the first run (another call adds more runs). */
export async function piStore(directory: string, options: { runs: number; calls: number; bytes: number; from?: number }): Promise<string> {
  const file = path.join(directory, "pi.sqlite");
  const faux = fauxProvider({ tokensPerSecond: 1e9 });
  let step = 0;
  // Pi compacts as the context fills, as in a long real thread.
  faux.setResponses(Array.from({ length: options.runs * (options.calls + 1) * 2 }, () => request => {
    if (request.messages.some(message => message.role === "system" && /context summarization assistant/.test(JSON.stringify(message)))) return fauxAssistantMessage("summary of the work so far");
    const k = step++ % (options.calls + 1);
    if (k < options.calls) return fauxAssistantMessage([fauxToolCall("bash", { command: `pnpm test --filter step-${step}` })], { stopReason: "toolUse" });
    return fauxAssistantMessage(`run done after ${options.calls} commands: answer ${step}`);
  }));
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(defineExtension({ name: "bench", tools: [defineTool({
    name: "bash", description: "stand-in bash", parameters: Type.Object({ command: Type.String() }), replay: "safe",
    async execute() { return { content: [{ type: "text" as const, text: output(options.bytes) }] }; },
  })] }));
  const harness = await Harness.open(await openStorage(file), { models, registry }, context);
  try {
    const conversation = await harness.root(context, { agent: { model: { provider: faux.getModel().provider, modelId: faux.getModel().id } } });
    for (let run = options.from ?? 0; run < (options.from ?? 0) + options.runs; run++) {
      const submission = await conversation.submit({ type: "input", content: `task ${run}: ${output(400)}`, requestId: `run-${run}` }, context);
      const settled = await submission.wait(context);
      if (settled.status !== "done") throw new Error(`run ${run} settled ${settled.status}`);
    }
  } finally { await harness.close(context); }
  return file;
}

/** A Claude Code store: `turns` submissions, each with `calls` Bash calls. */
export async function claudeStore(directory: string, options: { turns: number; calls: number; bytes: number }): Promise<void> {
  const workspace = { lease: async () => ({ token: "t" }), release: async () => {}, cancel: async () => {} } as unknown as Workspace;
  await (await ClaudeAgent.open({ directory, threadId: "bench", workspace, runtime: { command: ["false"], mod: "", socket: "" }, model: "opus" })).close();
  const db = new DatabaseSync(path.join(directory, "claude.sqlite"));
  const root = path.join(directory, "claude");
  try {
    db.exec("BEGIN");
    const submit = db.prepare("INSERT INTO submission(request_id, text, state, error, created_at) VALUES (?, ?, 'completed', NULL, 0)");
    const message = db.prepare("INSERT INTO message(submission, data) VALUES (?, ?)");
    for (let turn = 0; turn < options.turns; turn++) {
      const seq = Number(submit.run(`run-${turn}`, `task ${turn}`).lastInsertRowid);
      for (let k = 0; k < options.calls; k++) {
        const id = `t${turn}.${k}`;
        message.run(seq, JSON.stringify({ type: "assistant", message: { content: [
          { type: "thinking", thinking: output(300) }, { type: "tool_use", id, name: "Bash", input: { command: `cd ${root} && pnpm test ${k}` } }] } }));
        message.run(seq, JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: `${root}/out\n${output(options.bytes)}` }] } }));
      }
      message.run(seq, JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `turn ${turn} done` }] } }));
    }
    db.exec("COMMIT");
  } finally { db.close(); }
}
