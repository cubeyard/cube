/** Claude Code's Bash, Read, Write and Edit over the thread Workspace. Each
 * call is keyed by its tool_use_id, so the runner never executes the same
 * call twice: a repeated key returns the original outcome, and the same key
 * with a different request is CONFLICT. Results take each built-in tool's own
 * output shape, so Claude Code renders them for the model as its own.
 *
 * Plain functions over `WorkspaceClient`, with no engine imports: the hooks
 * module binds them to `$`, and cubed's offline tests drive them directly. */
import { WorkspaceClientError, type WorkspaceClient, type WorkspaceOperation } from "./workspace.ts";

/** The virtual workspace root Pi uses; accepted here as an alias too. */
export const VIRTUAL_ROOT = "/workspace";
export const BASH_DEFAULT_TIMEOUT_MS = 120000;
/** What a Bash result shows of the output; the rest is cut with a note. */
export const BASH_OUTPUT_CHARS = 30000;
/** The largest file Read and Edit load; larger files are for bash. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
const READ_DEFAULT_LINES = 2000;
const POLL_WAIT_MS = 20000;

export interface ToolScope {
  client: WorkspaceClient;
  token: string;
  /** The local directory Claude Code runs in; its absolute paths map onto the workspace root. */
  root: string;
  /** Aborts when the call is abandoned (the person stopped the thread). */
  signal?: AbortSignal;
}
export type Denied = { deny: string };

export interface BashInput { command: string; timeout?: number; run_in_background?: boolean }
export interface BashResult { stdout: string; stderr: string; interrupted: boolean }
export interface ReadInput { file_path: string; offset?: number; limit?: number; pages?: string }
export interface ReadResult { type: "text"; file: { filePath: string; content: string; numLines: number; startLine: number; totalLines: number } }
export interface WriteInput { file_path: string; content: string }
export interface WriteResult { type: "create" | "update"; filePath: string; content: string; structuredPatch: []; originalFile: string | null }
export interface EditInput { file_path: string; old_string: string; new_string: string; replace_all?: boolean }
export interface EditResult { filePath: string; oldString: string; newString: string; originalFile: string | null; structuredPatch: []; userModified: false; replaceAll: boolean }

/** Map a Claude Code path to a workspace-relative one, or explain why not. */
export function workspacePath(root: string, file: string): string | Denied {
  if (typeof file !== "string" || !file || file.includes("\0")) return { deny: "a file path is required" };
  const base = root.replace(/\/+$/, "");
  let rest: string;
  if (file === base || file === VIRTUAL_ROOT) rest = "";
  else if (base && file.startsWith(`${base}/`)) rest = file.slice(base.length + 1);
  else if (file.startsWith(`${VIRTUAL_ROOT}/`)) rest = file.slice(VIRTUAL_ROOT.length + 1);
  else if (file.startsWith("/") || file.startsWith("~")) return { deny: `${file} is outside the thread workspace; use a path under ${base || VIRTUAL_ROOT}` };
  else rest = file;
  const parts: string[] = [];
  for (const part of rest.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") return { deny: `${file} leaves the thread workspace` };
    parts.push(part);
  }
  if (!parts.length) return { deny: `${file} is the workspace root, not a file` };
  return parts.join("/");
}

export function key(toolUseId: string, suffix: string): string {
  return `claude:${toolUseId}:${suffix}`;
}

export async function bash(scope: ToolScope, toolUseId: string, input: BashInput): Promise<BashResult | Denied> {
  if (input.run_in_background) return { deny: "background commands are not available in cube threads; run the command in the foreground (it may take up to the timeout)" };
  if (typeof input.command !== "string" || !input.command.trim()) return { deny: "a command is required" };
  const operationKey = key(toolUseId, "bash");
  try {
    const limits = await scope.client.limits();
    const timeoutMs = Math.min(Math.max(1, Math.floor(input.timeout ?? BASH_DEFAULT_TIMEOUT_MS)), limits.maxExecTimeoutMs);
    let state: WorkspaceOperation = await scope.client.exec(scope.token, operationKey, { command: input.command, timeoutMs, outputLimit: limits.maxOutputBytes });
    while (state.state === "running") {
      const next = await abortable(scope.client.operation(scope.token, operationKey, { waitMs: POLL_WAIT_MS }), scope.signal);
      if (!next) {
        // A stop kills the runner command at once; its key stays spent.
        await scope.client.cancel(scope.token, operationKey).catch(() => {});
        return { stdout: "", stderr: "command stopped", interrupted: true };
      }
      state = next;
    }
    if (state.state === "failed") {
      return { deny: state.completionUnknown ? `the command's outcome is unknown (${state.error}); inspect the workspace before running it again` : `command failed: ${state.error}` };
    }
    if (state.state !== "succeeded") return { deny: "the command's outcome is unknown (the runner restarted while it ran); inspect the workspace before running it again" };
    const pages = [state.output];
    let received = state.output.length;
    while (state.outputOffset + received < state.retainedBytes) {
      const page = await scope.client.operation(scope.token, operationKey, { cursor: state.outputOffset + received });
      if (page.state !== "succeeded" || !page.output.length) break;
      pages.push(page.output);
      received += page.output.length;
    }
    let stdout = new TextDecoder().decode(concat(pages));
    if (stdout.length > BASH_OUTPUT_CHARS) stdout = `${stdout.slice(0, BASH_OUTPUT_CHARS)}\n[output cut at ${BASH_OUTPUT_CHARS} characters]`;
    else if (state.truncated) stdout += `\n[output cut by the runner at ${state.retainedBytes} bytes]`;
    const stderr = state.termination === "timedOut" ? `command timed out after ${timeoutMs} ms`
      : state.termination === "signalled" ? "command was terminated by a signal"
      : state.exitCode ? `exit code ${state.exitCode}` : "";
    return { stdout, stderr, interrupted: state.termination === "timedOut" };
  } catch (error) { return denied(error, "the command"); }
}

export async function read(scope: ToolScope, input: ReadInput): Promise<ReadResult | Denied> {
  const relative = workspacePath(scope.root, input.file_path);
  if (typeof relative !== "string") return relative;
  if (input.pages !== undefined) return { deny: "PDF pages are not available in cube threads; use bash to inspect the file" };
  try {
    const file = await loadText(scope, relative);
    if ("deny" in file) return file;
    const lines = file.text.split("\n");
    if (lines.length > 1 && lines.at(-1) === "") lines.pop();
    const startLine = Math.max(1, Math.floor(input.offset ?? 1));
    const count = Math.max(1, Math.floor(input.limit ?? READ_DEFAULT_LINES));
    const shown = lines.slice(startLine - 1, startLine - 1 + count);
    return { type: "text", file: { filePath: input.file_path, content: shown.join("\n"), numLines: shown.length, startLine, totalLines: lines.length } };
  } catch (error) { return denied(error, input.file_path); }
}

export async function write(scope: ToolScope, toolUseId: string, input: WriteInput): Promise<WriteResult | Denied> {
  const relative = workspacePath(scope.root, input.file_path);
  if (typeof relative !== "string") return relative;
  if (typeof input.content !== "string") return { deny: "content is required" };
  try {
    let existed = true;
    await scope.client.stat(scope.token, relative).catch(error => {
      if (error instanceof WorkspaceClientError && error.code === "NOT_FOUND") existed = false;
      else throw error;
    });
    const bytes = new TextEncoder().encode(input.content);
    const { maxWriteBytes } = await scope.client.limits();
    if (bytes.length > maxWriteBytes) return { deny: `${input.file_path} would be ${bytes.length} bytes; the workspace writes at most ${maxWriteBytes} bytes at once — use bash for larger files` };
    await scope.client.writeFile(scope.token, key(toolUseId, "write"), relative, bytes, { createParents: true });
    return { type: existed ? "update" : "create", filePath: input.file_path, content: input.content, structuredPatch: [], originalFile: null };
  } catch (error) { return denied(error, input.file_path); }
}

/** Edit is read, replace, then a write conditional on the content read. */
export async function edit(scope: ToolScope, toolUseId: string, input: EditInput): Promise<EditResult | Denied> {
  const relative = workspacePath(scope.root, input.file_path);
  if (typeof relative !== "string") return relative;
  if (typeof input.old_string !== "string" || typeof input.new_string !== "string") return { deny: "old_string and new_string are required" };
  if (input.old_string === input.new_string) return { deny: "No changes to make: old_string and new_string are exactly the same." };
  const replaceAll = input.replace_all === true;
  try {
    let original: { text: string; sha256: string } | null;
    try {
      const file = await loadText(scope, relative);
      if ("deny" in file) return file;
      if (!file.sha256) return { deny: `${input.file_path} is too large to edit safely; use bash` };
      original = { text: file.text, sha256: file.sha256 };
    } catch (error) {
      if (!(error instanceof WorkspaceClientError && error.code === "NOT_FOUND")) throw error;
      original = null;
    }
    let updated: string;
    if (original === null) {
      // Claude Code's convention: an empty old_string creates a new file.
      if (input.old_string !== "") return { deny: `File does not exist: ${input.file_path}` };
      updated = input.new_string;
    } else {
      if (input.old_string === "") return { deny: `Cannot create new file - file already exists: ${input.file_path}` };
      const matches = original.text.split(input.old_string).length - 1;
      if (!matches) return { deny: `String to replace not found in file.\nString: ${input.old_string}` };
      if (matches > 1 && !replaceAll) return { deny: `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${input.old_string}` };
      updated = replaceAll ? original.text.split(input.old_string).join(input.new_string) : original.text.replace(input.old_string, () => input.new_string);
    }
    const bytes = new TextEncoder().encode(updated);
    const { maxWriteBytes } = await scope.client.limits();
    if (bytes.length > maxWriteBytes) return { deny: `${input.file_path} would be ${bytes.length} bytes; the workspace writes at most ${maxWriteBytes} bytes at once — use bash for larger files` };
    await scope.client.writeFile(scope.token, key(toolUseId, "edit"), relative, bytes,
      original === null ? { createParents: true } : { expectedSha: original.sha256 });
    return { filePath: input.file_path, oldString: input.old_string, newString: input.new_string, originalFile: original?.text ?? null, structuredPatch: [], userModified: false, replaceAll };
  } catch (error) { return denied(error, input.file_path); }
}

/** A workspace instruction file, or null when the workspace has none. */
export async function instructions(scope: Pick<ToolScope, "client" | "token">, file: string): Promise<string | null> {
  try {
    const loaded = await loadText({ ...scope, root: "" }, file);
    return "deny" in loaded ? null : loaded.text;
  } catch (error) {
    if (error instanceof WorkspaceClientError && error.code === "NOT_FOUND") return null;
    throw error;
  }
}

/** The whole file as text, read page by page; every page must report the same whole-file sha. */
async function loadText(scope: ToolScope, relative: string): Promise<{ text: string; sha256: string | null } | Denied> {
  const { maxReadBytes } = await scope.client.limits();
  const pages: Uint8Array[] = [];
  let offset = 0;
  let sha: string | null | undefined;
  for (;;) {
    const page = await scope.client.readFile(scope.token, relative, { offset, limit: maxReadBytes });
    if (sha !== undefined && page.sha256 !== sha) return { deny: `${relative} changed while it was read; read it again` };
    if (page.size > MAX_FILE_BYTES) return { deny: `${relative} is ${page.size} bytes; read and change files over ${MAX_FILE_BYTES} bytes with bash (head, sed -n, rg)` };
    sha = page.sha256;
    pages.push(page.content);
    offset += page.content.length;
    if (page.eof || !page.content.length) break;
  }
  const bytes = concat(pages);
  const text = new TextDecoder().decode(bytes);
  // Invalid UTF-8 decodes to U+FFFD, which re-encodes to a different length.
  if (bytes.includes(0) || (text.includes("\uFFFD") && new TextEncoder().encode(text).length !== bytes.length)) {
    return { deny: `${relative} is not UTF-8 text; inspect it with bash` };
  }
  return { text, sha256: sha ?? null };
}

/** The promise's value, or undefined as soon as `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | undefined> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    const abort = () => resolve(undefined);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

function concat(pages: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(pages.reduce((total, page) => total + page.length, 0));
  let offset = 0;
  for (const page of pages) { out.set(page, offset); offset += page.length; }
  return out;
}

function denied(error: unknown, subject: string): Denied {
  if (!(error instanceof WorkspaceClientError)) return { deny: `${subject}: ${error instanceof Error ? error.message : String(error)}` };
  if (error.code === "NOT_FOUND") return { deny: `File does not exist: ${subject}` };
  if (error.code === "PRECONDITION_FAILED") return { deny: `${subject} changed since it was read; read it again` };
  if (error.code === "LEASE_STALE" || error.code === "LEASE_HELD") return { deny: "this Claude Code session no longer holds the thread workspace; cube stopped it or another owner took over" };
  if (error.completionUnknown) return { deny: `the outcome of ${subject} is unknown (${error.code}); inspect the workspace before retrying` };
  return { deny: `${subject}: ${error.message}` };
}
