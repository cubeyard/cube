/** In-process Pi execution on pi-durable. The host owns activation and the
 * thread's workspace lease; Pi owns every conversation entry, task checkpoint
 * and document. There is no second workflow journal. */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, type Models, type Static } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, defineTool, Harness, ROOT_CONVERSATION_ID, section, type Extension, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { createCodemodeTool, type CodemodeLimits, type NestedTool } from "./codemode.ts";
import type { NodeBinding } from "./iroh-node.ts";
import { settleOperation, WorkspaceError, type Workspace } from "./workspace.ts";
import { WORKSPACE_ROOT, WorkspaceEnv } from "./workspace-env.ts";

const context = BACKGROUND_CONTEXT;
const BASH_OUTPUT_BYTES = 50 * 1024;
const BASH_DEFAULT_TIMEOUT_MS = 120_000;
const BASH_MAX_TIMEOUT_MS = 600_000;
const bashParameters = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  cwd: Type.Optional(Type.String({ description: "Directory relative to the workspace root" })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: BASH_MAX_TIMEOUT_MS })),
});

/** The runner this thread's storage belongs to, plus a random storage
 * identity that scopes every workspace key Pi derives from task ids. */
export const RunnerDoc = defineDoc<{ binding: string; instance: string }>({
  kind: "cube.runner", version: 1, scope: "session", initial: () => ({ binding: "", instance: "" }),
});

/** pi-durable's SQLite storage on cubed's own connection: WAL with
 * synchronous=FULL, so a committed checkpoint survives power loss too. */
async function openStorage(file: string): Promise<SqliteStorage> {
  const database = new DatabaseSync(file, { timeout: 5000 });
  try {
    database.exec("PRAGMA journal_mode=WAL");
    database.exec("PRAGMA synchronous=FULL");
    if ((database.prepare("PRAGMA synchronous").get() as { synchronous: number } | undefined)?.synchronous !== 2) {
      throw new Error("session storage requires synchronous=FULL");
    }
  } catch (error) { database.close(); throw error; }
  return SqliteStorage.open(new NodeSqliteDatabase(database));
}

export async function openAgent(options: {
  directory: string;
  runner: { binding: Readonly<NodeBinding>; configHash: string };
  /** The thread workspace; Pi holds its lease for the whole Harness lifetime. */
  workspace: Workspace;
  models: Models;
  model: { provider: string; id: string };
  /** Tests lower these; production uses CODEMODE_LIMITS. */
  codemodeLimits?: Partial<CodemodeLimits>;
  /** Installed after cube's own extension; tests use this for hooks. */
  extensions?: readonly Extension[];
}) {
  // The lease is the single writable owner of the thread: a competing holder,
  // in this process or another, is refused, and process death releases it.
  // Its epoch fences runner mutations of any older holder. pi-durable has no
  // cross-process storage lock; the lease is that lock.
  const lease = await options.workspace.lease({ owner: "pi" });
  const release = () => options.workspace.release(lease.token).catch(() => {});
  let storage: SqliteStorage | undefined;
  let harness: Harness | undefined;
  let closing = false;
  try {
    fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    storage = await openStorage(path.join(options.directory, "pi.sqlite"));
    const registry = createRegistry();
    // Keys are bound in each tool call; replay of the same task finds the
    // same runner operation instead of executing again. A direct call's key is
    // its task's; a codemode call's nested calls extend the codemode task's
    // key with their sequence number.
    let instance = "";
    const taskKey = (api: ToolExecutionApi) => `pi:${instance}:${api.taskId}`;
    const fileTool = (tool: ToolRegistration, mutates: boolean): NestedTool => ({
      registration: tool, mutates,
      run: (args, api, callContext, key) => tool.execute(args, {
        ...api, env: new WorkspaceEnv({ workspace: options.workspace, token: lease.token, id: `cube-workspace:${instance}`, key }),
      }, callContext),
    });
    const bashTool: NestedTool = {
      registration: defineTool({
        name: "bash",
        description: `Execute a shell command in the thread runner workspace and return combined stdout and stderr. Output is bounded to ${BASH_OUTPUT_BYTES / 1024} KiB. cwd is relative to the workspace root, which is also the default. Timeout defaults to ${BASH_DEFAULT_TIMEOUT_MS / 1000} seconds, at most ${BASH_MAX_TIMEOUT_MS / 1000}.`,
        parameters: bashParameters,
        // The task id is the runner operation key: a rerun after a crash
        // reattaches to the same command and never starts it twice.
        replay: "safe",
        executionMode: "sequential",
        execute: (args, api, callContext) => runBash(args, api, callContext, taskKey(api)),
      }),
      mutates: true,
      run: (args: Static<typeof bashParameters>, api, callContext, key) => runBash(args, api, callContext, key),
    };
    async function runBash(args: Static<typeof bashParameters>, api: ToolExecutionApi, callContext: Context, base: string) {
      const key = `${base}:bash`;
      const signal = callContext.abortSignal;
      try {
        await options.workspace.exec(lease.token, key, {
          command: args.command, timeoutMs: args.timeoutMs ?? BASH_DEFAULT_TIMEOUT_MS, outputLimit: BASH_OUTPUT_BYTES,
          ...(args.cwd === undefined ? {} : { cwd: relative(args.cwd) }),
        });
        const state = await settleOperation(options.workspace, lease.token, key, signal ? { signal } : {});
        if (state.state === "failed") throw new WorkspaceError(state.error, `command failed: ${state.error}`, { completionUnknown: state.completionUnknown });
        if (state.state !== "succeeded") throw new WorkspaceError("COMPLETION_UNKNOWN", "command outcome is unknown; inspect the workspace before retrying");
        await api.details({ operationKey: key, exitCode: state.exitCode, termination: state.termination }, callContext);
        return {
          content: [{ type: "text" as const, text: Buffer.from(state.output).toString("utf8")
            + `\n[exit=${state.exitCode}; ${state.termination}${state.truncated ? "; output truncated" : ""}]` }],
        };
      } catch (error) {
        // A stop aborts the call: kill the runner command. A host shutdown
        // also aborts it, but then the command keeps running and the next
        // process reattaches to it.
        if (signal?.aborted && !closing) await options.workspace.cancel(lease.token, key).catch(() => {});
        throw error;
      }
    }
    const direct = (tool: NestedTool): ToolRegistration => ({
      ...tool.registration,
      execute: (args, api, callContext) => tool.run(args as never, api, callContext, taskKey(api)),
    });
    const read = fileTool({ ...createReadTool(), replay: "safe" }, false);
    const write = fileTool({ ...createWriteTool(), replay: "safe" }, true);
    const edit = fileTool(createEditTool(), true);
    const codemode = createCodemodeTool({ tools: [read, write, edit, bashTool], key: taskKey, ...(options.codemodeLimits ? { limits: options.codemodeLimits } : {}) });
    registry.install(defineExtension({
      name: "cube",
      tools: [direct(read), direct(write), direct(edit), bashTool.registration, codemode],
      sections: [section("preamble", () => `You are a coding agent working in a thread runner workspace. File tools address the workspace root as ${WORKSPACE_ROOT}; bash runs commands with the workspace root as its working directory. codemode runs one JavaScript script that calls these tools, for batching, chaining or filtering their results. The runner executes trusted commands under its own account; it is not a sandbox. Never assume access to control-plane files or credentials.`, { tag: false })],
    }));
    for (const extension of options.extensions ?? []) registry.install(extension);
    harness = await Harness.open(storage, { models: options.models, registry, settings: { toolExecution: "sequential" } }, context);
    const expected = JSON.stringify([options.runner.binding, options.runner.configHash]);
    instance = await harness.commit(async tx => {
      const runner = await tx.doc(RunnerDoc);
      if (runner.binding && runner.binding !== expected) throw new Error("thread runner binding changed");
      if (!runner.binding) { runner.binding = expected; runner.instance = randomUUID(); }
      return runner.instance;
    }, context);
    const existing = await harness.conversation(ROOT_CONVERSATION_ID, context);
    // On an existing conversation its stored agent is the truth, even when the
    // selected model left the catalog; history and explicit selection still work.
    if (!existing && !options.models.getModel(options.model.provider, options.model.id)) {
      throw new Error("model catalog unavailable — connect a provider before starting this thread");
    }
    const conversation = existing ?? await harness.root(context, { agent: { model: { provider: options.model.provider, modelId: options.model.id } } });
    // Continue any run the last process left unfinished.
    harness.resume();
    const opened = harness;
    let closed = false;
    return {
      harness: opened, conversation, storage,
      async close() {
        if (closed) return;
        closed = true; closing = true;
        try { await opened.close(context); }
        finally { await release(); }
      },
    };
  } catch (error) {
    closing = true;
    // A Harness closes its storage; storage without a Harness closes alone.
    try { await (harness ?? storage)?.close(context); }
    finally { await release(); }
    throw error;
  }
}
export type Agent = Awaited<ReturnType<typeof openAgent>>;

function relative(cwd: string): string {
  const resolved = path.posix.resolve(WORKSPACE_ROOT, cwd);
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}/`)) throw new Error("cwd must be inside the workspace");
  return path.posix.relative(WORKSPACE_ROOT, resolved) || ".";
}
