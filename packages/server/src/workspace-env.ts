/** Pi's ExecutionEnv over the thread Workspace, for pi-durable's file tools.
 * The runner owns every file semantic; this only maps paths and errors.
 *
 * One environment serves one tool call. Every write carries a key derived from
 * the call's task id, so a replayed call never writes twice, and a write after
 * a read in the same call is conditional on the content that was read. */
import path from "node:path";
import type { Context } from "@earendil-works/chord";
import { err, ExecutionError, FileError, ok, type ExecutionEnv, type FileErrorCode, type FileInfo, type Result, type ShellExecResult, type TextLineReader } from "@earendil-works/pi-durable/env";
import { WorkspaceError, type Workspace } from "./workspace.ts";

/** Paths the model sees: the workspace root is this virtual directory. */
export const WORKSPACE_ROOT = "/workspace";
/** The largest file the file tools read whole, as the Claude Code mod does;
 * bash reads past it. */
export const MAX_FILE_READ_BYTES = 2 * 1024 * 1024;

export class WorkspaceEnv implements ExecutionEnv {
  readonly id: string;
  cwd = WORKSPACE_ROOT;
  private readonly workspace: Workspace;
  private readonly token: string;
  private readonly key: string;
  private writes = 0;
  /** Whole-file sha of what this call read, per workspace-relative path. */
  private readonly read = new Map<string, string | null>();

  constructor(options: { workspace: Workspace; token: string; id: string; key: string }) {
    this.workspace = options.workspace; this.token = options.token; this.id = options.id; this.key = options.key;
  }

  async absolutePath(file: string): Promise<Result<string, FileError>> {
    const resolved = path.posix.resolve(this.cwd, file);
    if (resolved !== WORKSPACE_ROOT && !resolved.startsWith(`${WORKSPACE_ROOT}/`)) {
      return err(new FileError("invalid", `${file} is outside the workspace; use a path relative to the workspace root`, file));
    }
    return ok(resolved);
  }
  async joinPath(parts: string[]): Promise<Result<string, FileError>> { return ok(path.posix.join(...parts)); }
  async canonicalPath(file: string): Promise<Result<string, FileError>> { return err(new FileError("not_supported", "canonical paths are resolved by the runner", file)); }

  async readBinaryFile(file: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    return this.attempt(file, context, async relative => {
      const { maxReadBytes } = await this.workspace.limits();
      const pages: Uint8Array[] = [];
      let offset = 0;
      let sha: string | null | undefined;
      for (;;) {
        context.abortSignal?.throwIfAborted();
        const page = await this.workspace.readFile(this.token, relative, { offset, limit: maxReadBytes });
        // Each page reports the whole-file sha; a change between pages is not one file.
        if (sha !== undefined && page.sha256 !== sha) throw new FileError("unknown", `${file} changed while it was read`, file);
        if (offset === 0 && page.size > MAX_FILE_READ_BYTES) {
          throw new FileError("invalid", `${file} is ${page.size} bytes; the file tools read at most ${MAX_FILE_READ_BYTES} bytes — use bash (head, sed -n, rg) for larger files`, file);
        }
        sha = page.sha256;
        pages.push(page.content);
        offset += page.content.length;
        if (page.eof || !page.content.length) break;
      }
      this.read.set(relative, sha ?? null);
      return Buffer.concat(pages);
    });
  }
  async readTextFile(file: string, context: Context): Promise<Result<string, FileError>> {
    const bytes = await this.readBinaryFile(file, context);
    return bytes.ok ? ok(new TextDecoder().decode(bytes.value)) : bytes;
  }
  async writeFile(file: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    return this.attempt(file, context, async relative => {
      const bytes = typeof content === "string" ? Buffer.from(content) : content;
      const { maxWriteBytes } = await this.workspace.limits();
      if (bytes.length > maxWriteBytes) throw new FileError("invalid", `${file} would be ${bytes.length} bytes; the workspace writes at most ${maxWriteBytes} bytes at once — use bash for larger files`, file);
      const expectedSha = this.read.get(relative) ?? undefined;
      const written = await this.workspace.writeFile(this.token, `${this.key}:write:${++this.writes}`, relative, bytes, { createParents: true, ...(expectedSha ? { expectedSha } : {}) });
      this.read.set(relative, written.sha256);
    });
  }
  async fileInfo(file: string, context: Context): Promise<Result<FileInfo, FileError>> {
    return this.attempt(file, context, async relative => {
      const stat = await this.workspace.stat(this.token, relative);
      return { name: path.posix.basename(relative), path: path.posix.join(WORKSPACE_ROOT, relative), kind: stat.kind === "other" ? "file" : stat.kind, size: stat.size, mtimeMs: stat.modifiedMs };
    });
  }
  async exists(file: string, context: Context): Promise<Result<boolean, FileError>> {
    const info = await this.fileInfo(file, context);
    return info.ok ? ok(true) : info.error.code === "not_found" ? ok(false) : info;
  }

  async openTextLineReader(file: string): Promise<Result<TextLineReader, FileError>> { return unsupported(file); }
  async readTextLines(file: string): Promise<Result<string[], FileError>> { return unsupported(file); }
  async appendFile(file: string): Promise<Result<void, FileError>> { return unsupported(file); }
  async truncateFile(file: string): Promise<Result<void, FileError>> { return unsupported(file); }
  async flushFile(file: string): Promise<Result<void, FileError>> { return unsupported(file); }
  async renameFile(file: string): Promise<Result<void, FileError>> { return unsupported(file); }
  async listDir(file: string): Promise<Result<FileInfo[], FileError>> { return unsupported(file); }
  async createDir(file: string): Promise<Result<void, FileError>> { return unsupported(file); }
  async remove(file: string): Promise<Result<void, FileError>> { return unsupported(file); }
  async createTempDir(): Promise<Result<string, FileError>> { return unsupported(); }
  async createTempFile(): Promise<Result<string, FileError>> { return unsupported(); }
  /** Commands go through cube's bash tool, keyed by its task id. */
  async exec(): Promise<Result<ShellExecResult, ExecutionError>> { return err(new ExecutionError("shell_unavailable", "use the bash tool to run commands")); }
  async cleanup(): Promise<void> {}

  private async attempt<T>(file: string, context: Context, action: (relative: string) => Promise<T>): Promise<Result<T, FileError>> {
    if (context.abortSignal?.aborted) return err(new FileError("aborted", "operation aborted", file));
    const absolute = await this.absolutePath(file);
    if (!absolute.ok) return absolute;
    try { return ok(await action(path.posix.relative(WORKSPACE_ROOT, absolute.value) || ".")); }
    catch (error) { return err(fileError(file, error)); }
  }
}

function unsupported<T>(file?: string): Result<T, FileError> {
  return err(new FileError("not_supported", "not supported by the workspace", file));
}
function fileError(file: string, error: unknown): FileError {
  if (error instanceof FileError) return error;
  if (!(error instanceof WorkspaceError)) return new FileError("unknown", error instanceof Error ? error.message : String(error), file);
  const codes: Partial<Record<string, FileErrorCode>> = { NOT_FOUND: "not_found", INVALID_REQUEST: "invalid", OPERATION_UNSUPPORTED: "not_supported" };
  const message = error.code === "PRECONDITION_FAILED" ? `${file} changed since it was read; read it again`
    : error.code === "NOT_FOUND" ? `${file} does not exist`
    : error.completionUnknown ? `the outcome of changing ${file} is unknown; read it again before retrying`
    : `${file}: ${error.message}`;
  return new FileError(codes[error.code] ?? "unknown", message, file, error);
}
