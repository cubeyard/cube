/**
 * The cube pi-extension (ARCHITECTURE §13 Phase 3d, step 1): pi runs on the
 * credentialed host (the VM), but every built-in tool and user `!` command
 * executes inside one thread's cube. The workspace is the shared truth —
 * bind-mounted host↔cube — so file tools go through the cube's namespace
 * (a hostile workspace symlink can only dereference to cube files, never
 * host credentials), bash goes through the sandbox exec boundary, and the
 * first tool use of a sleeping thread wakes it (via cubed, so `.cube/resume`
 * and wake hooks run; direct Incus start as the fallback).
 *
 * Fail-closed: without configuration, or with any active tool this
 * extension did not itself register, pi refuses to run rather than let a
 * tool execute on the host.
 *
 * In CUBE_BACKEND=mock, the surrounding development machine is the sandbox:
 * tools use MockSandbox + local file operations against the thread workspace.
 * There is deliberately no nested isolation in that mode; cubed's mock-mode
 * warning is the security boundary. The default remains real Incus.
 *
 * LAUNCH POSTURE (required): cubed MUST spawn pi with `--no-extensions` so
 * ONLY this `-e` extension loads. That closes two host-execution vectors
 * the in-extension guard cannot: (a) a hostile workspace `.pi/extensions`
 * auto-loading in-process, and (b) another extension whose `user_bash`
 * handler runs earlier than ours (pi uses the FIRST handler that returns,
 * so an earlier one would execute `!` on the host while our tool audit
 * still passes). The guard remains as defense in depth.
 *
 * Accepted residual: pi's read tool probes the model-supplied path with a
 * host `fs.access` (existence only) before our guest ops run — a boolean
 * host-path oracle, never host file CONTENT (that always crosses into the
 * cube). Not worth reimplementing the read tool to close.
 *
 * Spawned by cubed (Phase 3d step 2) per attached thread; manual use:
 *
 *   CUBE_NAME=<thread's cube> CUBE_BACKEND=incus pi --no-extensions -e packages/pi-extension/src/index.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { IncusClient, IncusSandbox, MockSandbox } from "@cube/sandbox";
import type {
  BashOperations,
  ExtensionAPI,
  ExtensionContext,
  GrepToolInput,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { encodeError, type CodeErrorData } from "./code-errors.ts";
import { execCode, codeFile } from "./code-io.ts";
import { createCodeCapability } from "./code-capabilities.ts";
import { CODE_MODE_API, runCodeMode, type CodeModeTrace } from "./code-mode.ts";
import { CubeFs, type GuestFiles } from "./cube-fs.ts";
import { formatGrepResult } from "./grep-format.ts";
import { SHADOWED_TOOLS, auditTools } from "./guard.ts";
import { createGuestOperations } from "./ops.ts";

export interface CubeConfig {
  backend: "incus" | "mock";
  /** Registry name — enables wake through cubed. */
  name: string | undefined;
  /** User-facing thread id — authorizes repository-scoped host git tools. */
  threadId: string | undefined;
  /** Incus instance name (default: cube-<name>). */
  instance: string;
  hostWorkspace: string;
  guestWorkspace: string;
  cubedUrl: string;
}

/** Ceiling on bash output forwarded to pi (which spools the overflow to a
 * host /tmp file) — bounds host disk against a runaway cube command. */
const MAX_BASH_OUTPUT = 32 * 1024 * 1024;
interface CodeToolDetails {
  operations: CodeModeTrace[];
  error?: CodeErrorData;
  truncation?: ReturnType<typeof truncateHead>;
}

/** Cube-owned skills ship with the extension rather than relying on a
 * workspace's (untrusted and optional) project-skill directory. */
export const BUILTIN_SKILL_PATHS = [
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "setting-up-cube"),
];

// Only these packaged, public instruction bytes may bypass guest reads.
// Cache them at extension load; never resolve model-supplied host paths.
const BUILTIN_SKILLS = new Map(BUILTIN_SKILL_PATHS.map((directory) => {
  const file = path.join(directory, "SKILL.md");
  return [file, fs.readFileSync(file)] as const;
}));

export function withBuiltinSkillReads(operations: import("@earendil-works/pi-coding-agent").ReadOperations) {
  return {
    ...operations,
    access: async (file: string) => { if (!BUILTIN_SKILLS.has(file)) await operations.access(file); },
    readFile: async (file: string) => BUILTIN_SKILLS.get(file) ?? operations.readFile(file),
  };
}

function codeTraceText(traces: CodeModeTrace[]): string {
  return traces
    .map((trace) => {
      const duration = trace.durationMs === undefined ? "" : ` (${trace.durationMs}ms)`;
      if (trace.status === "running") return `… ${trace.operation}`;
      if (trace.status === "ok") return `✓ ${trace.operation}${duration}`;
      return `✗ ${trace.operation}${duration}: ${trace.error ?? "failed"}`;
    })
    .join("\n");
}

function codeValueText(value: unknown): string {
  if (value === undefined) return "Code completed.";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function throwIfCodeAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new Error("code execution aborted");
}

export function resolveConfig(env: NodeJS.ProcessEnv, cwd: string): CubeConfig | null {
  const backend = env.CUBE_BACKEND?.trim() || "incus";
  if (backend !== "incus" && backend !== "mock") return null;
  const name = env.CUBE_NAME?.trim() || undefined;
  const instance = env.CUBE_INSTANCE?.trim() || (name ? `cube-${name}` : undefined);
  if (!instance) return null;
  const hostWorkspace = env.CUBE_HOST_WORKSPACE?.trim() || cwd;
  return {
    backend,
    name: name ?? (instance.startsWith("cube-") ? instance.slice("cube-".length) : undefined),
    threadId: env.CUBE_THREAD_ID?.trim() || undefined,
    instance,
    hostWorkspace,
    // There is no nested filesystem namespace in mock mode. Present the
    // real workspace path to pi so absolute tool paths and bash commands
    // remain truthful instead of pretending an unmapped /workspace exists.
    guestWorkspace: backend === "mock" ? hostWorkspace : env.CUBE_GUEST_WORKSPACE?.trim() || "/workspace",
    cubedUrl: (env.CUBED_URL?.trim() || "http://127.0.0.1:7777").replace(/\/+$/, ""),
  };
}

/** Wake-on-first-tool-use. Managed threads gate on cubed's readiness and
 * wake route (which runs `.cube/resume` + wake hooks); standalone Incus use
 * falls back to a bare start when cubed is unavailable. Exported for the
 * Incus smoke. */
export class Waker {
  private inflight:
    | { promise: Promise<void>; controller: AbortController; waiters: number; settled: boolean }
    | undefined;
  private readonly cfg: CubeConfig;
  private readonly client: IncusClient | undefined;

  constructor(cfg: CubeConfig, client?: IncusClient) {
    this.cfg = cfg;
    this.client = client;
  }

  ensure = (ctx?: ExtensionContext, signal?: AbortSignal): Promise<void> => {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("wake aborted"));
    if (!this.inflight) {
      const controller = new AbortController();
      const entry = {
        controller,
        waiters: 0,
        settled: false,
        promise: undefined as unknown as Promise<void>,
      };
      entry.promise = this.check(ctx, controller.signal).finally(() => {
        entry.settled = true;
        if (this.inflight === entry) this.inflight = undefined;
      });
      this.inflight = entry;
    }
    const entry = this.inflight;
    entry.waiters += 1;
    return new Promise<void>((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        entry.waiters -= 1;
        return true;
      };
      const onAbort = () => {
        if (!finish()) return;
        const reason = signal?.reason ?? new Error("wake aborted");
        reject(reason);
        if (entry.waiters === 0 && !entry.settled) entry.controller.abort(reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        () => {
          if (finish()) resolve();
        },
        (error) => {
          if (finish()) reject(error);
        },
      );
    });
  };

  private async check(ctx: ExtensionContext | undefined, signal: AbortSignal): Promise<void> {
    const supervisorManaged = this.cfg.backend === "mock" || !!this.cfg.threadId;
    if (supervisorManaged && !this.cfg.name) throw new Error("cube extension: managed environment requires CUBE_NAME");
    // A registry row can be stale after an out-of-band guest shutdown. The
    // supervisor wake barrier checks both physical state and setup readiness.
    if (!supervisorManaged && await this.state(signal) === "Running") return;
    ctx?.ui.setStatus("cube", "setting up environment…");
    try {
      await this.wake(signal);
    } finally {
      ctx?.ui.setStatus("cube", undefined);
    }
  }

  async state(signal?: AbortSignal): Promise<string> {
    // A managed Incus instance may already be Running while cubed is still
    // retrying setup. Its registry status, not raw Incus state, is the tool
    // readiness authority. Standalone Incus has no such supervisor contract.
    if (this.cfg.backend === "incus" && !this.cfg.threadId) {
      if (!this.client) throw new Error("cube extension: Incus client is unavailable");
      return (await this.client.getInstanceState(this.cfg.instance, signal)).status;
    }
    if (!this.cfg.name) throw new Error("cube extension: managed environment requires CUBE_NAME");
    const res = await fetch(`${this.cfg.cubedUrl}/api/cubes/${encodeURIComponent(this.cfg.name)}`, {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
        : AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`cubed could not read managed environment ${this.cfg.name} (${res.status})`);
    const body = (await res.json()) as { status?: unknown };
    if (typeof body.status !== "string") throw new Error("cubed returned an invalid managed environment status");
    return body.status;
  }

  private async wake(signal: AbortSignal): Promise<void> {
    if (this.cfg.name) {
      let res: Response;
      try {
        res = await fetch(`${this.cfg.cubedUrl}/api/cubes/${encodeURIComponent(this.cfg.name)}/wake`, {
          method: "POST",
          signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)]),
        });
      } catch (error) {
        if (signal.aborted) throw error;
        if (this.cfg.threadId) throw error;
        // cubed unreachable (standalone/dogfood use) — a bare Incus start
        // is the only option; fall through.
        res = undefined as unknown as Response;
      }
      if (res) {
        // cubed IS present. Trust its verdict rather than starting the
        // instance behind its back: a bare start would bypass its resume
        // hooks and activity tracking, letting the idle sweep sleep the
        // cube mid-tool. Exceptions: 404 means cubed does not manage this
        // cube (standalone/dogfood — provisioned outside cubed), so an
        // unmanaged instance may fall through to a direct start. Managed
        // threads never bypass the supervisor, including on 404.
        if (res.ok) return;
        if (res.status !== 404 || this.cfg.threadId) {
          throw new Error(`cubed refused to wake ${this.cfg.name} (${res.status})`);
        }
      }
    }
    if (!this.client) {
      throw new Error("cube extension: mock backend requires a reachable cubed wake endpoint");
    }
    await this.client.setInstanceState(this.cfg.instance, "start", {}, signal).catch((error) => {
      if (signal.aborted) throw error;
      // "already running" race with another waker — the poll below decides.
    });
    const deadline = Date.now() + 60_000;
    for (;;) {
      signal.throwIfAborted();
      const code = await this.client.execSimple(this.cfg.instance, ["true"], signal).catch((error) => {
        if (signal.aborted) throw error;
        return null;
      });
      if (code === 0) return;
      if (Date.now() > deadline) {
        throw new Error(`environment did not come up: ${this.cfg.instance}`);
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        }, 1000);
        const onAbort = () => {
          clearTimeout(timer);
          reject(signal.reason ?? new Error("wake aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  }
}

function incusFiles(client: IncusClient, instance: string): GuestFiles {
  return {
    // uid/gid 1000 = the cube's dev user, same identity bash runs as. Mode
    // defaults to 0644 for a fresh file but preserves an existing file's
    // permissions (CubeFs passes the resolved target's mode).
    push: (p, content, opts) =>
      client.pushInstanceFile(instance, p, content, {
        uid: 1000,
        gid: 1000,
        mode: opts?.mode ?? "0644",
        signal: opts?.signal,
      }),
    pull: (p, opts) => client.pullInstanceFile(instance, p, opts),
  };
}

/** Local counterpart to the Incus files API for mock mode. It preserves the
 * same symlink and bounded-read contract CubeFs relies on. */
export function mockFiles(): GuestFiles {
  return {
    push: async (p, content, opts) => {
      await fs.promises.writeFile(p, content, { signal: opts?.signal });
      if (opts?.mode) await fs.promises.chmod(p, parseInt(opts.mode, 8));
    },
    pull: async (p, opts) => {
      const stat = await fs.promises.lstat(p);
      if (stat.isSymbolicLink()) {
        return { content: Buffer.from(await fs.promises.readlink(p)), type: "symlink" };
      }
      if (opts?.maxBytes !== undefined && stat.size > opts.maxBytes) {
        throw new Error(`file exceeds ${opts.maxBytes} bytes: ${p}`);
      }
      return { content: await fs.promises.readFile(p, { signal: opts?.signal }), type: "file" };
    },
  };
}

/** Build the fixed thread HTTP bridge. QuickJS never receives this generic
 * function, the cubed URL, request headers, or host credentials. */
export function createThreadRequest(cfg: { threadId?: string; cubedUrl: string }) {
  return async (
    requestPath: string,
    options: { method?: "GET" | "POST" | "DELETE"; body?: unknown; timeoutMs?: number } = {},
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> => {
    if (!cfg.threadId) throw new Error("cube extension: CUBE_THREAD_ID is not set");
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 600_000)])
      : AbortSignal.timeout(options.timeoutMs ?? 600_000);
    requestSignal.throwIfAborted();
    try {
      const response = await fetch(
        `${cfg.cubedUrl}/api/threads/${encodeURIComponent(cfg.threadId)}${requestPath}`,
        {
          method: options.method ?? "GET",
          ...(options.body === undefined
            ? {}
            : { headers: { "content-type": "application/json" }, body: JSON.stringify(options.body) }),
          signal: requestSignal,
        },
      );
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      requestSignal.throwIfAborted();
      if (!response.ok) throw new Error(String(body.error ?? `cubed request failed (${response.status})`));
      return body;
    } catch (error) {
      if (requestSignal.aborted && options.method && options.method !== "GET") {
        throw Object.assign(new Error(`request cancelled; ${options.method} ${requestPath} may have completed remotely; reconcile before retrying`), {
          code: "ECODE_UNCERTAIN", completionUnknown: true,
        });
      }
      throw error;
    }
  };
}

function boundedEnvironmentStatus(body: Record<string, unknown>): Record<string, unknown> {
  const bounded = { ...body };
  for (const phase of ["setup", "resume"] as const) {
    const value = bounded[phase];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const result = { ...(value as Record<string, unknown>) };
    if (typeof result.log === "string") {
      const log = Buffer.from(result.log, "utf8");
      result.log = log.subarray(Math.max(0, log.length - 64 * 1024)).toString("utf8");
    }
    bounded[phase] = result;
  }
  return bounded;
}

export default function cubeExtension(pi: ExtensionAPI) {
  pi.on("resources_discover", async () => ({ skillPaths: BUILTIN_SKILL_PATHS }));

  const cfg = resolveConfig(process.env, process.cwd());

  if (!cfg) {
    // Fail closed: never fall back to host execution.
    pi.on("tool_call", async () => ({
      block: true,
      reason: "cube extension is unconfigured (set CUBE_NAME or CUBE_INSTANCE) — refusing host execution",
    }));
    pi.on("user_bash", async () => ({
      result: {
        output: "cube extension is unconfigured (set CUBE_NAME or CUBE_INSTANCE) — refusing host execution",
        exitCode: 1,
        cancelled: false,
        truncated: false,
      },
    }));
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify("cube extension: CUBE_NAME (or CUBE_INSTANCE) is not set — shutting down", "error");
      ctx.shutdown();
    });
    return;
  }

  const client = cfg.backend === "incus" ? new IncusClient() : undefined;
  const sandbox = client
    ? new IncusSandbox(cfg.instance, client)
    : new MockSandbox(cfg.instance, cfg.guestWorkspace, cfg.hostWorkspace);
  const waker = new Waker(cfg, client);
  const files = client ? incusFiles(client, cfg.instance) : mockFiles();
  const cubeFs = new CubeFs(sandbox, files, {
    guestCwd: cfg.guestWorkspace,
    ensure: (signal) => waker.ensure(undefined, signal),
    ...(cfg.backend === "mock"
      ? {
          helperGuestPath: path.join(
            os.tmpdir(),
            "cube-pi-extension",
            cfg.instance.replace(/[^A-Za-z0-9._-]/g, "_"),
            "fsops.mjs",
          ),
        }
      : {}),
  });
  // Operations for the file-shaped tools — everything resolves inside the
  // cube (ops.ts; shared with the offline test).
  const { guest, readOps, writeOps, editOps, lsOps, findOps } = createGuestOperations(
    cubeFs,
    cfg.hostWorkspace,
    cfg.guestWorkspace,
  );
  const bashOps: BashOperations = {
    // Deliberately no env passthrough. On Incus this keeps host credentials
    // out of the cube; on the mock it keeps the local approximation aligned
    // with the production command environment.
    exec: async (command, cwd, { onData, signal, timeout }) => {
      await waker.ensure(undefined, signal); // Esc during a wake must cancel it too
      // Cap total forwarded output: pi's bash tool spools everything past
      // its display limit to a host /tmp file, so a cube command like `yes`
      // would otherwise fill the credentialed host's disk. Past the ceiling
      // we stop forwarding and abort the remote command, handing pi a final
      // notice + the "aborted" path (which formats the partial output).
      let total = 0;
      let capped = false;
      const limiter = new AbortController();
      const onAbort = () => limiter.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      const boundedOnData = (chunk: Buffer) => {
        if (capped) return;
        total += chunk.length;
        if (total > MAX_BASH_OUTPUT) {
          capped = true;
          onData(Buffer.from(`\n[cube: output exceeded ${MAX_BASH_OUTPUT >> 20} MiB — command aborted; redirect large output to a file]\n`));
          limiter.abort();
          return;
        }
        onData(chunk);
      };
      try {
        return await sandbox.exec(command, { cwd: guest(cwd), onData: boundedOnData, signal: limiter.signal, timeout });
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };

  /** Thread-scoped cubed RPC. QuickJS receives only the parsed response,
   * never this URL, fetch, headers, credentials, or a generic request API. */
  const threadRequest = createThreadRequest(cfg);

  const codeCapability = createCodeCapability({
    exec: (input, signal) => execCode(async (command, cwd, options) => {
      await waker.ensure(undefined, options.signal);
      options.signal.throwIfAborted();
      return sandbox.exec(command, { cwd: guest(cwd), ...options });
    }, input, cfg.guestWorkspace, signal),
    readText: (inputPath, signal) => codeFile("fs.readText", inputPath, async () => {
      throwIfCodeAborted(signal);
      const content = await cubeFs.readFile(guest(inputPath), signal);
      throwIfCodeAborted(signal);
      return content.toString("utf8");
    }),
    writeText: (inputPath, content, signal) => codeFile("fs.writeText", inputPath, async () => {
      throwIfCodeAborted(signal);
      await cubeFs.writeFile(guest(inputPath), content, signal);
      throwIfCodeAborted(signal);
    }),
    async listRepositories(signal) {
      const body = await threadRequest("/repositories", { timeoutMs: 30_000 }, signal);
      if (!Array.isArray(body.repositories)) throw new Error("cubed returned invalid repositories");
      return body.repositories;
    },
    syncBase: (repositoryId, signal) =>
      threadRequest(`/repositories/${repositoryId}/sync`, { method: "POST" }, signal),
    reviewPr: (repositoryId, input, signal) =>
      threadRequest(`/repositories/${repositoryId}/pr-review`, { method: "POST", body: input }, signal),
    readGithub: (input, signal) => {
      const query = new URLSearchParams({ number: String(input.number), type: input.type });
      if (input.section !== undefined) query.set("section", input.section);
      if (input.page !== undefined) query.set("page", String(input.page));
      return threadRequest(`/github?${query}`, { timeoutMs: 40_000 }, signal);
    },
    pushBranch: (repositoryId, signal) =>
      threadRequest(`/repositories/${repositoryId}/push`, { method: "POST" }, signal),
    pushBase: (repositoryId, signal) =>
      threadRequest(`/repositories/${repositoryId}/push-base`, { method: "POST" }, signal),
    createPr: (repositoryId, options, signal) =>
      threadRequest(`/repositories/${repositoryId}/pr`, { method: "POST", body: options }, signal),
    async ensureServices(signal) {
      const body = await threadRequest("/services", { method: "POST" }, signal);
      if (!Array.isArray(body.services)) throw new Error("cubed returned invalid services");
      return body.services;
    },
    exposePortal: (input, signal) =>
      threadRequest("/portals", { method: "POST", body: input }, signal),
    async listPortals(signal) {
      const body = await threadRequest("/portals", {}, signal);
      if (!Array.isArray(body.portals)) throw new Error("cubed returned invalid portals");
      return body.portals;
    },
    removePortal: (port, signal) =>
      threadRequest(`/portals/${port}`, { method: "DELETE" }, signal),
    archiveThread: (signal) => threadRequest("/archive", { method: "POST", timeoutMs: 10_000 }, signal),
    environmentStatus: async (signal) => boundedEnvironmentStatus(await threadRequest("/environment", {}, signal)),
    retryEnvironmentSetup: async (signal) => boundedEnvironmentStatus(await threadRequest(
      "/environment",
      { method: "POST", timeoutMs: 20 * 60_000 },
      signal,
    )),
  });

  // ---- shadow the complete model-facing tool surface ----

  const guestRead = createReadTool(cfg.guestWorkspace, { operations: withBuiltinSkillReads(readOps) });
  const guestWrite = createWriteTool(cfg.guestWorkspace, { operations: writeOps });
  const guestEdit = createEditTool(cfg.guestWorkspace, { operations: editOps });
  const guestBash = createBashTool(cfg.guestWorkspace, { operations: bashOps });
  const guestLs = createLsTool(cfg.guestWorkspace, { operations: lsOps });
  const guestFind = createFindTool(cfg.guestWorkspace, { operations: findOps });
  const guestGrep = createGrepTool(cfg.guestWorkspace);

  // The guest walker skips .git and node_modules but does not parse
  // .gitignore (unlike pi's local fd/rg backends). Correct the model-facing
  // description so it does not over-trust the result set.
  const IGNORE_NOTE = " Skips .git and node_modules; does NOT honor .gitignore, so generated/ignored files may appear.";
  const noGitignore = (desc: string) => desc.replace(/\s*\(respects \.gitignore\)/i, ".") + IGNORE_NOTE;

  const shadow = <T extends { description: string; execute: (...args: never[]) => unknown }>(
    tool: T,
    description = tool.description,
  ): void => {
    pi.registerTool({
      ...tool,
      description,
      async execute(id: string, params: never, signal: AbortSignal, onUpdate: never, ctx: ExtensionContext) {
        await waker.ensure(ctx, signal);
        return (tool.execute as (...args: unknown[]) => unknown)(id, params, signal, onUpdate);
      },
    } as unknown as ToolDefinition);
  };
  shadow(guestRead);
  shadow(guestWrite);
  shadow(guestEdit);
  shadow(guestBash);
  shadow(guestLs);
  shadow(guestFind, noGitignore(guestFind.description));

  pi.registerTool({
    ...guestGrep,
    description: noGitignore(guestGrep.description),
    async execute(_id: string, params: GrepToolInput, signal: AbortSignal, _onUpdate: never, ctx: ExtensionContext) {
      await waker.ensure(ctx, signal);
      const result = await cubeFs.grep(
        {
          pattern: params.pattern,
          path: guest(params.path ?? "."),
          glob: params.glob,
          ignoreCase: params.ignoreCase,
          literal: params.literal,
          context: params.context,
          limit: params.limit,
        },
        signal,
      );
      return formatGrepResult(result);
    },
  } as unknown as ToolDefinition);

  pi.registerTool({
    name: "code",
    label: "Code mode",
    description:
      "Execute a JavaScript workflow in isolated QuickJS. Use this to compose sandbox and authenticated " +
      "Cube operations with loops, filtering, and conditional control flow without repeated model turns.\n\n" +
      CODE_MODE_API,
    promptSnippet: "code: compose Cube, git, service, and sandbox operations in isolated JavaScript",
    promptGuidelines: [
      "Use code for multi-step workflows or when intermediate results should be filtered before entering context. Direct read/edit/bash tools remain appropriate for simple coding operations.",
      "Code mode has capabilities, never credentials: do not attempt to access process, fetch, require, environment variables, or host paths.",
      "Return a concise JSON-serializable result. Redirect large command output to workspace files.",
    ],
    executionMode: "sequential",
    parameters: Type.Object({
      source: Type.String({
        maxLength: 64 * 1024,
        description: "JavaScript function body. Top-level await and return are supported; cube is the only host API.",
      }),
    }),
    async execute(
      _id: string,
      params: { source: string },
      signal: AbortSignal | undefined,
      onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: CodeToolDetails }) => void) | undefined,
    ) {
      const operationEvents: CodeModeTrace[] = [];
      let result;
      try {
        result = await runCodeMode({
          source: params.source,
          call: codeCapability,
          signal,
          onTrace: (trace) => {
            operationEvents.push(trace);
            onUpdate?.({
              content: [{ type: "text", text: codeTraceText(operationEvents) }],
              details: { operations: [...operationEvents] },
            });
          },
        });
      } catch (error) {
        const data = encodeError(error);
        const truncation = truncateHead(JSON.stringify(data, null, 2));
        return {
          isError: true,
          content: [{ type: "text", text: truncation.content + (truncation.truncated
            ? "\n[error output truncated for display; catch the error in code to inspect its bounded output]" : "") }],
          details: { operations: operationEvents, error: data, ...(truncation.truncated ? { truncation } : {}) },
        };
      }
      const completed = result.traces.filter((trace) => trace.status !== "running");
      const prefix = completed.length > 0 ? `${codeTraceText(completed)}\n\n` : "";
      const truncation = truncateHead(prefix + codeValueText(result.value));
      const suffix = truncation.truncated
        ? `\n\n[${formatSize(truncation.maxBytes)} result limit reached; write large results to a workspace file]`
        : "";
      return {
        content: [{ type: "text", text: truncation.content + suffix }],
        details: {
          operations: result.traces,
          ...(truncation.truncated ? { truncation } : {}),
        },
      };
    },
  } as unknown as ToolDefinition);

  // User `!` commands run in the cube too.
  pi.on("user_bash", async () => ({ operations: bashOps }));

  // ---- the unshadowed-tool guard (fail closed) ----

  const ownRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  let refused = false;
  const runGuard = (ctx: ExtensionContext): void => {
    const violations = auditTools(
      pi.getActiveTools(),
      pi.getAllTools().map((t) => ({ name: t.name, sourcePath: t.sourceInfo?.path })),
      ownRoot,
    );
    if (violations.length > 0 && !refused) {
      refused = true;
      ctx.ui.notify(`cube extension: refusing to run — ${violations.join("; ")}`, "error");
      ctx.shutdown();
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    runGuard(ctx);
  });

  pi.on("tool_call", async (event) => {
    if (refused || !SHADOWED_TOOLS.has(event.toolName)) {
      return { block: true, reason: "cube extension: tools may only run inside the sandboxed environment" };
    }
    // Re-audit THIS tool's effective definition at call time, not just its
    // name: a tool dynamically re-registered under a shadowed name after
    // the startup audit would otherwise run its foreign/host implementation.
    const bad = auditTools(
      [event.toolName],
      pi.getAllTools().map((t) => ({ name: t.name, sourcePath: t.sourceInfo?.path })),
      ownRoot,
    );
    if (bad.length > 0) {
      return { block: true, reason: `cube extension: ${bad[0]}` };
    }
    return undefined;
  });

  pi.on("before_agent_start", async (event, ctx) => {
    runGuard(ctx);
    const hostLine = `Current working directory: ${cfg.hostWorkspace}`;
    const guestLine =
      cfg.backend === "mock"
        ? `Current working directory: ${cfg.guestWorkspace} (mock environment; commands run locally with no nested isolation)`
        : `Current working directory: ${cfg.guestWorkspace} (sandboxed environment; the workspace is shared with ${cfg.hostWorkspace})`;
    let systemPrompt = event.systemPrompt.includes(hostLine)
      ? event.systemPrompt.replace(hostLine, guestLine)
      : `${event.systemPrompt}\n\n${guestLine}`;
    if (cfg.threadId) {
      systemPrompt += "\n\nUse the code tool's cube.git capabilities for authenticated repository network operations; ordinary git fetch/push in bash intentionally has no host credentials. Call cube.thread.archive() only when the user's current instruction explicitly requires archival after all other work is done.";
    }
    return { systemPrompt };
  });

  pi.registerCommand("cube", {
    description: "Show which environment tools run in",
    handler: async (_args, ctx) => {
      const state = await waker.state().catch(() => "unreachable");
      ctx.ui.notify(
        [
          `instance: ${cfg.instance} (${state})`,
          `backend: ${cfg.backend}`,
          `workspace: ${cfg.hostWorkspace} ↔ ${cfg.guestWorkspace}`,
          `wake: ${cfg.name ? `cubed ${cfg.cubedUrl}` : "direct incus start only"}`,
        ].join("\n"),
        "info",
      );
    },
  });
}
