/** In-process Pi execution. The host owns activation and the exclusive writer
 * lock; Pi owns every conversation entry and execution checkpoint. */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentHarness, BACKGROUND_CONTEXT, value, type AgentHarnessOptions, type LaneConfiguration } from "@earendil-works/pi-agent-core";
import { createNodeSqliteFactory, SqliteSessionRepo } from "@earendil-works/pi-session-backend-sqlite-node";
import { Type } from "typebox";
import type { IrohExecutionNodeClient } from "./iroh-node.ts";

const context = BACKGROUND_CONTEXT;

export async function openAgent(options: {
  directory: string;
  runner: IrohExecutionNodeClient;
  models: AgentHarnessOptions["models"];
  model: { provider: string; id: string };
}) {
  fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  // A dedicated SQLite connection holds an OS-backed writer lock for the
  // entire Session lifetime. Process death releases it without stale PID files.
  // It contains no workflow state and never contends with Pi's transactions.
  const owner = new DatabaseSync(path.join(options.directory, "owner.sqlite"));
  try { owner.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); }
  catch (cause) {
    owner.close();
    throw new Error("thread session already has a writable owner", { cause });
  }
  const databaseFactory = createNodeSqliteFactory();
  for (const method of ["open", "openExisting"] as const) {
    const open = databaseFactory[method];
    databaseFactory[method] = async filename => {
      const db = await open(filename);
      db.exec("PRAGMA synchronous=FULL");
      if (db.prepare("PRAGMA synchronous").get<{ synchronous: number }>()?.synchronous !== 2) {
        throw new Error("session storage requires synchronous=FULL");
      }
      return db;
    };
  }
  const repo = new SqliteSessionRepo({ directory: path.join(options.directory, "session"), databaseFactory });
  let session: Awaited<ReturnType<typeof repo.create>> | undefined;
  try {
    const existing = await repo.list(undefined, context);
    if (existing.length > 1) throw new Error("thread has multiple sessions");
    session = existing.length ? await repo.open(existing[0], context) : await repo.create({}, context);
    const sessionId = session.metadata.id;
    const binding = value<string>("cube.runner");
    const expected = JSON.stringify([options.runner.binding, options.runner.configHash]);
    const saved = await session.getValue(binding, context);
    if (saved && saved.value !== expected) throw new Error("thread runner binding changed");
    if (!saved) await session.setValue(binding, expected, context);
    // Pi 0.85.1 exposes typed values, but no pre-create lane-config accessor.
    // Existing lane configuration, not the registry's initial choice, is truth.
    const configured = await session.getValue(value<LaneConfiguration>("pi.lane.config", "main"), context);
    const identity = configured?.value.model;
    const model = identity ? options.models.getModel(identity.provider, identity.modelId) ?? options.models.getModels()[0]
      : options.models.getModel(options.model.provider, options.model.id);
    if (!model) throw new Error("model catalog unavailable — connect a provider before starting this thread");
    // On an existing lane Pi ignores this seed entirely, even if the configured
    // model disappeared. History and explicit model selection must still work.
    const { harness, open } = await AgentHarness.create({
      session,
      models: options.models,
      model,
      toolExecution: "sequential",
      systemPrompt: "You are a coding agent. Use bash to inspect and edit the runner workspace. The runner executes trusted commands under its own account; it is not a sandbox. Never assume access to control-plane files or credentials.",
      tools: [{
        name: "bash",
        label: "bash",
        description: "Execute a shell command in the thread runner workspace. Results are bounded to 8192 bytes. Relative cwd defaults to the workspace root. Timeout is at most 60 seconds.",
        parameters: Type.Object({ command: Type.String(), cwd: Type.Optional(Type.String()), timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 60000 })) }),
        replay: "safe",
        async execute(_id, args, _update, _toolContext, invocation, callContext) {
          // AgentHarness validates tool arguments against parameters first.
          const input = args as { command: string; cwd?: string; timeoutMs?: number };
          const result = await options.runner.resumeExec(sessionId, invocation.invocationId, {
            command: input.command,
            guestCwd: input.cwd ?? ".",
            timeoutMs: input.timeoutMs ?? 60000,
            outputLimit: 8192,
          }, callContext.abortSignal);
          return {
            content: [{ type: "text", text: Buffer.from(result.output).toString("utf8")
              + `\n[exit=${result.exitCode}; ${result.termination}${result.truncated ? "; output truncated" : ""}]` }],
            details: { operationId: result.operationId, exitCode: result.exitCode, termination: result.termination },
          };
        },
      }],
    }, context);
    const lane = await harness.lane("main", context);
    let closed = false;
    return {
      harness, lane, open,
      async close() {
        if (closed) return;
        closed = true;
        try { await harness.close(context); }
        finally {
          try { await session!.close(context); }
          finally { owner.close(); }
        }
      },
    };
  } catch (error) {
    try { await session?.close(context); }
    finally { owner.close(); }
    throw error;
  }
}
