/** In-process Pi execution on pi-durable. The host owns activation and the
 * thread's workspace lease; Pi owns every conversation entry, task checkpoint
 * and document. There is no second workflow journal. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Type, type Models, type Static } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, defineTool, Harness, ROOT_CONVERSATION_ID, section, type Extension, type ToolExecutionApi, type ToolRegistration } from "@earendil-works/pi-durable";
import { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CURRENT_SQLITE_SCHEMA_VERSION, SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createEditTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { createPiReadTool } from "./pi-read.ts";
import { createCodemodeTool, type CodemodeLimits, type NestedTool } from "./codemode.ts";
import { settleOperation, WorkspaceError, type Workspace } from "./workspace.ts";
import { expandHome, WORKSPACE_ROOT, WorkspaceEnv, workspacePath } from "./workspace-env.ts";

const context = BACKGROUND_CONTEXT;
const BASH_OUTPUT_BYTES = 50 * 1024;
const BASH_DEFAULT_TIMEOUT_MS = 120_000;
const BASH_MAX_TIMEOUT_MS = 600_000;
const bashParameters = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  cwd: Type.Optional(Type.String({ description: "Directory relative to the workspace root" })),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1, maximum: BASH_MAX_TIMEOUT_MS })),
});

/** The machine this thread's storage belongs to (runner and VM), plus a
 * random storage identity that scopes every workspace key Pi derives from
 * task ids. */
export const RunnerDoc = defineDoc<{ binding: string; instance: string }>({
  kind: "cube.runner", version: 1, scope: "session", initial: () => ({ binding: "", instance: "" }),
});

/** pi-durable's SQLite storage on cubed's own connection: WAL with
 * synchronous=FULL, so a committed checkpoint survives power loss too. */
export async function openStorage(file: string): Promise<SqliteStorage> {
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

const READ_BYTES = 64 * 2 ** 20;

/** Reads a Pi store, beside its Harness or without one, from a snapshot;
 * null when there is none. The store is only read, through a read-only
 * connection (a WAL reader never waits for the writer): it is never created,
 * migrated or locked for writing. pi-durable's open, which checks its schema
 * in a write transaction, and its close, which checkpoints, run on the
 * private copy, deleted afterwards. A store of another schema version is
 * refused. */
export async function readStorage<T>(file: string, read: (storage: SqliteStorage) => Promise<T>): Promise<T | null> {
  if (!fs.existsSync(file)) return null;
  const directory = fs.mkdtempSync(path.join(path.dirname(file), ".read-"));
  try {
    const copy = path.join(directory, "pi.sqlite");
    const source = new DatabaseSync(file, { readOnly: true });
    try {
      const row = source.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get() as { version: number } | undefined;
      if (row?.version !== CURRENT_SQLITE_SCHEMA_VERSION) throw new Error(`the stored history has schema version ${row?.version ?? "none"}, not ${CURRENT_SQLITE_SCHEMA_VERSION}`);
      // The copy is synchronous: a store too large to copy at once is refused.
      const { size } = source.prepare("SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()").get() as { size: number };
      if (size > READ_BYTES) throw new Error(`the stored history is too large to read here (${Math.ceil(size / 2 ** 20)} MiB)`);
      source.prepare("VACUUM INTO ?").run(copy);
    } finally { source.close(); }
    const storage = await SqliteStorage.open(new NodeSqliteDatabase(new DatabaseSync(copy)));
    try { return await read(storage); }
    finally { await storage.close(context); }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

/** Files the Pi store before pi-durable 1.0.1 left in a thread directory. */
const LEGACY_STORE = ["session", "owner.sqlite"];
export const LEGACY_THREAD = "this thread was created by an older cube and is not migrated — reset to a new CUBED_STATE (see DEVELOPING.md)";

/** Refuses a thread directory with the old Pi store: opening it would start
 * an empty conversation and submit the first message again in its machine. */
export function assertCurrentThreadStore(directory: string): void {
  if (LEGACY_STORE.some(name => fs.existsSync(path.join(directory, name)))) throw new Error(LEGACY_THREAD);
}

export async function openAgent(options: {
  directory: string;
  /** The thread's machine binding (runner and VM); fixed for the storage. */
  binding: string;
  /** The thread workspace; Pi holds its lease for the whole Harness lifetime. */
  workspace: Workspace;
  models: Models;
  model: { provider: string; id: string };
  /** Tests lower these; production uses CODEMODE_LIMITS. */
  codemodeLimits?: Partial<CodemodeLimits>;
  /** Installed after cube's own extension; tests use this for hooks. */
  extensions?: readonly Extension[];
  /** Host tools beside the workspace tools (artifacts), with a line for the
   * preamble. `readFile` reads a workspace file under the agent's lease;
   * `key` is a call's stable request id. */
  hostTools?: (host: { readFile(file: string, limit: number): Promise<{ text: string; path: string; sha256: string }>; key(api: ToolExecutionApi): string }) => { tools: ToolRegistration[]; note: string };
}) {
  // The lease is the single writable owner of the thread: a competing holder,
  // in this process or another, is refused, and process death releases it.
  // Its epoch fences guest mutations of any older holder. pi-durable has no
  // cross-process storage lock; the lease is that lock.
  assertCurrentThreadStore(options.directory);
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
    // same guest operation instead of executing again. A direct call's key is
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
        description: `Execute a shell command in the thread's VM and return combined stdout and stderr. Output is bounded to ${BASH_OUTPUT_BYTES / 1024} KiB. cwd is relative to the workspace root, which is also the default. Timeout defaults to ${BASH_DEFAULT_TIMEOUT_MS / 1000} seconds, at most ${BASH_MAX_TIMEOUT_MS / 1000}.`,
        parameters: bashParameters,
        // The task id is the guest operation key: a rerun after a crash
        // reattaches to the same command and never starts it twice.
        replay: "safe",
        executionMode: "sequential",
        execute: (args, api, callContext) => runBash(args, api, callContext, taskKey(api)),
      }),
      mutates: true,
      // Codemode is replay "unsafe": its nested commands are never reattached,
      // so a host shutdown cancels them too.
      run: (args: Static<typeof bashParameters>, api, callContext, key) => runBash(args, api, callContext, key, false),
    };
    async function runBash(args: Static<typeof bashParameters>, api: ToolExecutionApi, callContext: Context, base: string, reattached = true) {
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
        // A stop aborts the call: kill the guest command. A host shutdown
        // also aborts it, but then a direct command keeps running and the
        // next process reattaches to it.
        if (signal?.aborted && (!closing || !reattached)) await options.workspace.cancel(lease.token, key).catch(() => {});
        throw error;
      }
    }
    const direct = (tool: NestedTool): ToolRegistration => ({
      ...tool.registration,
      execute: (args, api, callContext) => tool.run(args as never, api, callContext, taskKey(api)),
    });
    const read = fileTool(createPiReadTool(options.models), false);
    const write = fileTool({ ...createWriteTool(), replay: "safe" }, true);
    const edit = fileTool(createEditTool(), true);
    const codemode = createCodemodeTool({ tools: [read, write, edit, bashTool], key: taskKey, ...(options.codemodeLimits ? { limits: options.codemodeLimits } : {}) });
    const host = options.hostTools?.({
      key: taskKey,
      async readFile(file, limit) {
        const expanded = expandHome(file);
        if (expanded === null) throw new Error(`${file}: only ~ and ~/ name a home, the agent's`);
        const target = workspacePath(path.posix.resolve(WORKSPACE_ROOT, expanded));
        if (target === ".") throw new Error("path must name a file");
        const read = await options.workspace.readFile(lease.token, target, { limit: limit + 1 });
        if (!read.eof || read.content.byteLength > limit) throw new Error(`${file} is larger than ${limit} bytes`);
        const bytes = Buffer.from(read.content);
        return { text: bytes.toString("utf8"), path: path.posix.resolve(WORKSPACE_ROOT, target), sha256: createHash("sha256").update(bytes).digest("hex") };
      },
    });
    registry.install(defineExtension({
      name: "cube",
      tools: [direct(read), direct(write), direct(edit), bashTool.registration, codemode, ...host?.tools ?? []],
      sections: [section("preamble", () => `You are a coding agent working in this thread's own Debian virtual machine. File tools address the workspace root as ${WORKSPACE_ROOT} and take relative paths there; an absolute path elsewhere (/home/agent, /tmp) is a file in the same machine, reached with the agent's own permissions (use sudo in bash for root-owned files; /proc, /sys and /dev only through bash). bash runs commands as the user agent (with passwordless sudo) with the workspace root as its working directory. codemode runs one JavaScript script that calls these tools, for batching, chaining or filtering their results. The machine reaches the internet over HTTP and HTTPS only, through cube's gateway, which decides every request; other connections are refused. git and gh are installed and authenticated for GitHub where the host allows it (GH_TOKEN holds a placeholder the gateway replaces; never print or copy it elsewhere). Never assume access to control-plane files or credentials. A server a command starts ends with that command: to keep a web server running and give the user a URL, run "cube service start NAME --port PORT -- COMMAND" (it must listen on 0.0.0.0; "cube service --help" lists status, logs and stop).${host ? ` ${host.note}` : ""}`, { tag: false }),
        // The repository's own instructions live in the VM, as they do
        // for Claude Code threads; rendered each generation, so edits apply.
        section("repository", async () => {
          const parts: string[] = [];
          for (const file of INSTRUCTION_FILES) {
            const text = await instructionFile(options.workspace, lease.token, file);
            if (text) parts.push(`Contents of ${file} in the thread workspace (project instructions, checked into the codebase):\n\n${text}`);
          }
          return parts.length ? parts.join("\n\n") : undefined;
        }, { tag: false })],
    }));
    for (const extension of options.extensions ?? []) registry.install(extension);
    harness = await Harness.open(storage, { models: options.models, registry, settings: { toolExecution: "sequential" } }, context);
    const expected = options.binding;
    instance = await harness.commit(async tx => {
      const runner = await tx.doc(RunnerDoc);
      if (runner.binding && runner.binding !== expected) throw new Error("thread machine binding changed");
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

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];
const INSTRUCTION_BYTES = 64 * 1024;

/** A repository instruction file from the workspace root, or null when absent. */
async function instructionFile(workspace: Workspace, token: string, file: string): Promise<string | null> {
  try {
    const read = await workspace.readFile(token, file, { limit: INSTRUCTION_BYTES });
    const text = Buffer.from(read.content).toString("utf8").trim();
    if (!text) return null;
    return !read.eof ? `${text}\n\n[truncated at ${INSTRUCTION_BYTES / 1024} KiB]` : text;
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

function relative(cwd: string): string {
  const resolved = path.posix.resolve(WORKSPACE_ROOT, cwd);
  if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}/`)) throw new Error("cwd must be inside the workspace");
  return path.posix.relative(WORKSPACE_ROOT, resolved) || ".";
}
