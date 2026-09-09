/** Schema validation and dispatch for code mode's host capabilities. The
 * QuickJS bridge is intentionally generic internally; this allowlist is the
 * authorization surface. No operation receives credentials or arbitrary
 * access to the host process. */
import type { CodeModeCapability } from "./code-mode.ts";

interface ExecInput {
  command: string;
  cwd: string | undefined;
  timeoutMs: number;
}

export interface CodeCapabilityHost {
  exec(input: ExecInput, signal: AbortSignal): Promise<unknown>;
  readText(path: string, signal: AbortSignal): Promise<string>;
  writeText(path: string, content: string, signal: AbortSignal): Promise<void>;
  listRepositories(signal: AbortSignal): Promise<unknown[]>;
  readGithub(input: { number: number; type: string; section?: string; page?: number }, signal: AbortSignal): Promise<unknown>;
  reviewPr(repositoryId: number, input: { action: "prepare"; number: number } | { action: "plan" | "verify"; token: string } | { action: "publish"; token: string; plan: string }, signal: AbortSignal): Promise<unknown>;
  syncBase(repositoryId: number, signal: AbortSignal): Promise<unknown>;
  pushBranch(repositoryId: number, signal: AbortSignal): Promise<unknown>;
  pushBase(repositoryId: number, signal: AbortSignal): Promise<unknown>;
  createPr(
    repositoryId: number,
    options: { title?: string; body?: string },
    signal: AbortSignal,
  ): Promise<unknown>;
  ensureServices(signal: AbortSignal): Promise<unknown[]>;
  archiveThread(signal: AbortSignal): Promise<unknown>;
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
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new TypeError("repositoryId must be a positive integer");
  }
  return Number(value);
}

function timeoutMs(args: Record<string, unknown>): number {
  const value = args.timeoutMs ?? 120_000;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 600_000) {
    throw new TypeError("timeoutMs must be an integer from 1 to 600000");
  }
  return Number(value);
}

/** Construct the closed capability dispatcher used by QuickJS. New SDK
 * methods must be added explicitly here and to CODE_MODE_API. */
export function createCodeCapability(host: CodeCapabilityHost): CodeModeCapability {
  return async (operation, rawArgs, signal) => {
    const args = record(rawArgs);
    switch (operation) {
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
      case "git.preparePrUpdate":
        if (!Number.isSafeInteger(args.number) || Number(args.number) < 1) throw new TypeError("number must be a positive integer");
        return host.reviewPr(repositoryId(args), { action: "prepare", number: Number(args.number) }, signal);
      case "git.planPrUpdate":
      case "git.publishPrUpdate":
      case "git.verifyPrUpdate": {
        const token = stringField(args, "token", { maxLength: 32 })!;
        if (!/^[0-9a-f]{32}$/.test(token)) throw new TypeError("invalid review token");
        if (operation === "git.publishPrUpdate") {
          const plan = stringField(args, "plan", { maxLength: 32 })!;
          if (!/^[0-9a-f]{32}$/.test(plan)) throw new TypeError("invalid review plan");
          return host.reviewPr(repositoryId(args), { action: "publish", token, plan }, signal);
        }
        return host.reviewPr(repositoryId(args), { action: operation === "git.planPrUpdate" ? "plan" : "verify", token }, signal);
      }
      case "git.pushBranch":
        return host.pushBranch(repositoryId(args), signal);
      case "git.pushBase":
        return host.pushBase(repositoryId(args), signal);
      case "git.createPr":
        return host.createPr(
          repositoryId(args),
          {
            title: stringField(args, "title", { optional: true, maxLength: 200 }),
            body: stringField(args, "body", { optional: true, maxLength: 64 * 1024 }),
          },
          signal,
        );
      case "services.ensure":
        return host.ensureServices(signal);
      case "thread.archive":
        return host.archiveThread(signal);
      default:
        throw new Error(`unknown code capability: ${operation}`);
    }
  };
}
