/** Schema validation and dispatch for code mode's host capabilities. The
 * QuickJS bridge is intentionally generic internally; this allowlist is the
 * authorization surface. No operation receives credentials or arbitrary
 * access to the host process. */
import type { CodeModeCapability } from "./code-mode.ts";

export interface ExecInput {
  command: string;
  cwd: string | undefined;
  timeoutMs: number;
}

export interface ExposePortalInput {
  port: number;
  name: string;
  lifetime: "thread";
}

export interface CodeCapabilityHost {
  operation?(operationId: string, signal: AbortSignal): Promise<unknown>;
  exec(input: ExecInput, signal: AbortSignal): Promise<unknown>;
  readText(path: string, signal: AbortSignal): Promise<string>;
  writeText(path: string, content: string, signal: AbortSignal): Promise<void>;
  listRepositories(signal: AbortSignal): Promise<unknown[]>;
  readGithub(input: { number: number; type: string; section?: string; page?: number }, signal: AbortSignal): Promise<unknown>;
  syncBase(repositoryId: number, signal: AbortSignal): Promise<unknown>;
  syncBranch(repositoryId: number, branch: string, signal: AbortSignal): Promise<unknown>;
  pushBranch(repositoryId: number, options: { forceWithLease?: string }, signal: AbortSignal): Promise<unknown>;
  pushBase(repositoryId: number, signal: AbortSignal): Promise<unknown>;
  createPr(
    repositoryId: number,
    options: { title?: string; body?: string },
    signal: AbortSignal,
  ): Promise<unknown>;
  ensureServices(signal: AbortSignal): Promise<unknown[]>;
  exposePortal(input: ExposePortalInput, signal: AbortSignal): Promise<unknown>;
  listPortals(signal: AbortSignal): Promise<unknown[]>;
  removePortal(port: number, signal: AbortSignal): Promise<unknown>;
  archiveThread(signal: AbortSignal): Promise<unknown>;
  environmentStatus(signal: AbortSignal): Promise<unknown>;
  retryEnvironmentSetup(signal: AbortSignal): Promise<unknown>;
  taskDestinations?(signal: AbortSignal): Promise<unknown[]>;
  listTasks?(signal: AbortSignal): Promise<unknown[]>;
  getTask?(id: string, signal: AbortSignal): Promise<unknown>;
  sendTask?(input: { recipient: string; requestKey: string; body: string }, signal: AbortSignal): Promise<unknown>;
  cancelTask?(id: string, signal: AbortSignal): Promise<unknown>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("capability arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function stringField(
  args: Record<string, unknown>,
  name: string,
  options: { optional?: boolean; maxLength?: number } = {},
): string | undefined {
  const value = args[name];
  if (value === undefined && options.optional) return undefined;
  if (typeof value !== "string") throw new TypeError(`${name} must be a string`);
  if (value.length > (options.maxLength ?? 64 * 1024)) {
    throw new Error(`${name} exceeds ${options.maxLength ?? 64 * 1024} characters`);
  }
  return value;
}

function repositoryId(args: Record<string, unknown>): number {
  const value = args.repositoryId;
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError("repositoryId must be a positive integer");
  }
  return Number(value);
}

function timeoutMs(args: Record<string, unknown>): number {
  const value = args.timeoutMs ?? 120_000;
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 600_000) {
    throw new TypeError("timeoutMs must be an integer from 1 to 600000");
  }
  return Number(value);
}

function portalPort(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new TypeError("port must be an integer from 1 to 65535");
  }
  return Number(value);
}

/** Construct the closed capability dispatcher used by QuickJS. New SDK
 * methods must be added explicitly here and to CODE_MODE_API. */
export function createCodeCapability(
  host: CodeCapabilityHost,
  confirmCreatePr: (signal: AbortSignal) => Promise<boolean>,
  confirmForcePush: (signal: AbortSignal) => Promise<boolean>,
): CodeModeCapability {
  return async (operation, rawArgs, signal) => {
    const args = record(rawArgs);
    const fields: Record<string, readonly string[]> = {
      exec: ["command", "cwd", "timeoutMs"],
      "github.read": ["number", "type", "section", "page"],
      "operations.get": ["operationId"],
      "environment.status": [], "environment.retrySetup": [],
      "fs.readText": ["path"], "fs.writeText": ["path", "content"],
      "repositories.list": [], "services.ensure": [], "thread.archive": [],
      "tasks.destinations": [], "tasks.list": [], "tasks.get": ["id"],
      "tasks.send": ["recipient", "requestKey", "body"], "tasks.cancel": ["id"],
      "portals.expose": ["port", "name", "lifetime"],
      "portals.list": [], "portals.remove": ["port"],
      "git.syncBase": ["repositoryId"], "git.pushBranch": ["repositoryId", "forceWithLease"],
      "git.syncBranch": ["repositoryId", "branch"],
      "git.pushBase": ["repositoryId"], "git.createPr": ["repositoryId", "title", "body"],
    };
    const allowed = Object.hasOwn(fields, operation) ? fields[operation] : undefined;
    if (!allowed) throw new Error(`unknown code capability: ${operation}`);
    for (const key of Object.keys(args)) {
      if (!allowed.includes(key)) throw new TypeError(`unknown ${operation} option: ${key}`);
    }
    signal.throwIfAborted();
    switch (operation) {
      case "operations.get": {
        const id = stringField(args, "operationId", { maxLength: 128 })!;
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new TypeError("invalid operationId");
        if (!host.operation) throw new Error("OPERATION_UNSUPPORTED");
        return host.operation(id, signal);
      }
      case "exec":
        return host.exec(
          {
            command: stringField(args, "command", { maxLength: 64 * 1024 })!,
            cwd: stringField(args, "cwd", { optional: true, maxLength: 4 * 1024 }),
            timeoutMs: timeoutMs(args),
          },
          signal,
        );
      case "fs.readText":
        return host.readText(stringField(args, "path", { maxLength: 4 * 1024 })!, signal);
      case "fs.writeText": {
        const path = stringField(args, "path", { maxLength: 4 * 1024 })!;
        const content = stringField(args, "content", { maxLength: 1024 * 1024 })!;
        await host.writeText(path, content, signal);
        return { ok: true };
      }
      case "repositories.list":
        return host.listRepositories(signal);
      case "github.read": {
        if (!Number.isSafeInteger(args.number) || Number(args.number) < 1) throw new TypeError("number must be a positive integer");
        if (args.type !== "issue" && args.type !== "pr") throw new TypeError("type must be issue or pr");
        if (args.page !== undefined && (!Number.isSafeInteger(args.page) || Number(args.page) < 1)) {
          throw new TypeError("page must be a positive integer");
        }
        return host.readGithub({
          number: args.number as number,
          type: args.type,
          section: stringField(args, "section", { optional: true, maxLength: 32 }),
          page: args.page as number | undefined,
        }, signal);
      }
      case "git.syncBase":
        return host.syncBase(repositoryId(args), signal);
      case "git.syncBranch":
        return host.syncBranch(repositoryId(args), stringField(args, "branch", { maxLength: 255 })!, signal);
      case "git.pushBranch": {
        const id = repositoryId(args);
        const forceWithLease = stringField(args, "forceWithLease", { optional: true, maxLength: 64 });
        if (forceWithLease !== undefined && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(forceWithLease)) {
          throw new TypeError("forceWithLease must be a full commit ID");
        }
        if (forceWithLease !== undefined) {
          const confirmed = await confirmForcePush(signal);
          signal.throwIfAborted();
          if (!confirmed) throw new Error("force-with-lease push cancelled by user");
        }
        return host.pushBranch(id, { forceWithLease }, signal);
      }
      case "git.pushBase":
        return host.pushBase(repositoryId(args), signal);
      case "git.createPr": {
        const id = repositoryId(args);
        const options = {
          title: stringField(args, "title", { optional: true, maxLength: 200 }),
          body: stringField(args, "body", { optional: true, maxLength: 64 * 1024 }),
        };
        const confirmed = await confirmCreatePr(signal);
        signal.throwIfAborted();
        if (!confirmed) throw new Error("pull request creation cancelled by user");
        return host.createPr(id, options, signal);
      }
      case "services.ensure":
        return host.ensureServices(signal);
      case "portals.expose": {
        const name = stringField(args, "name", { maxLength: 80 })!;
        if (!name.trim()) throw new TypeError("name must not be blank");
        const lifetime = args.lifetime === undefined ? "thread" : args.lifetime;
        if (lifetime !== "thread") throw new TypeError("lifetime must be thread");
        return host.exposePortal({ port: portalPort(args.port), name, lifetime }, signal);
      }
      case "portals.list":
        return host.listPortals(signal);
      case "portals.remove":
        return host.removePortal(portalPort(args.port), signal);
      case "thread.archive":
        return host.archiveThread(signal);
      case "tasks.destinations":
        if (!host.taskDestinations) throw new Error("OPERATION_UNSUPPORTED");
        return host.taskDestinations(signal);
      case "tasks.list":
        if (!host.listTasks) throw new Error("OPERATION_UNSUPPORTED");
        return host.listTasks(signal);
      case "tasks.get":
        if (!host.getTask) throw new Error("OPERATION_UNSUPPORTED");
        return host.getTask(stringField(args, "id", { maxLength: 128 })!, signal);
      case "tasks.send":
        if (!host.sendTask) throw new Error("OPERATION_UNSUPPORTED");
        return host.sendTask({
          recipient: stringField(args, "recipient", { maxLength: 128 })!,
          requestKey: stringField(args, "requestKey", { maxLength: 128 })!,
          body: stringField(args, "body", { maxLength: 16_384 })!,
        }, signal);
      case "tasks.cancel":
        if (!host.cancelTask) throw new Error("OPERATION_UNSUPPORTED");
        return host.cancelTask(stringField(args, "id", { maxLength: 128 })!, signal);
      case "environment.status":
        return host.environmentStatus(signal);
      case "environment.retrySetup":
        return host.retryEnvironmentSetup(signal);
      default:
        throw new Error(`unknown code capability: ${operation}`);
    }
  };
}
