/** Claude Code's Bash, Read, Write and Edit over the thread Workspace. Each
 * call is keyed by its tool_use_id, so the machine never executes the same
 * call twice: a repeated key returns the original outcome, and the same key
 * with a different request is CONFLICT. Results take each built-in tool's own
 * output shape, so Claude Code renders them for the model as its own.
 *
 * Plain functions over `WorkspaceClient`, with no engine imports: the hooks
 * module binds them to `$`, and cubed's offline tests drive them directly. */
import { toBase64, WorkspaceClientError, type WorkspaceClient, type WorkspaceOperation } from "./workspace.ts";

/** The only Claude Code tools a cube thread offers: Bash, Read, Write and
 * Edit go to the workspace, the rest plan or search the web through the model
 * provider. Everything else, MCP tools and built-ins this list does not know
 * included, would act on the cubed host as the cubed user and is refused.
 * cubed also passes this list as --tools. */
export const ALLOWED_TOOLS: readonly string[] = ["Bash", "Read", "Write", "Edit", "TodoWrite", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TaskStop", "ToolSearch", "WebSearch", "EnterPlanMode", "ExitPlanMode"];

/** Claude Code's tools that start or continue its own agents (`Task` is
 * Agent's older name), whose work the thread's transcript would not show. */
export const SUBAGENT_TOOLS: readonly string[] = ["Agent", "Task", "Workflow", "SendMessage"];
export const NO_SUBAGENTS = "subagents are not available in cube threads: do the work in this thread, or ask in your reply for another cube thread, which OptChat starts with its own visible history";

/** The workspace root in the machine, as Pi names it; accepted here as an alias too. */
export const VIRTUAL_ROOT = "/workspace";
/** The agent account's home in the machine (vm-seed.ts): `~` in a path. */
export const GUEST_HOME = "/home/agent";
export const BASH_DEFAULT_TIMEOUT_MS = 120000;
/** What a Bash result shows of the output; the rest is cut with a note. */
export const BASH_OUTPUT_CHARS = 30000;
/** The largest file Read and Edit load; larger files are for bash. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** The largest image Read returns: 5 MiB as base64, the smallest per-image
 * limit a model provider sets (Bedrock and Vertex; Anthropic's API takes 10 MB). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024 / 4 * 3;
/** The largest image side Read returns, the size Claude Code's own Read resizes to. */
export const MAX_IMAGE_SIDE = 2000;
const READ_DEFAULT_LINES = 2000;
const POLL_WAIT_MS = 20000;

export interface ToolScope {
  client: WorkspaceClient;
  token: string;
  /** The local directory Claude Code runs in; its absolute paths map onto the workspace root. */
  root: string;
  /** The same directory with its symlinks resolved, an alias of `root`. */
  realRoot?: string;
  /** Aborts when the call is abandoned (the person stopped the thread). */
  signal?: AbortSignal;
}
export type Denied = { deny: string };

export interface BashInput { command: string; timeout?: number; run_in_background?: boolean }
export interface BashResult { stdout: string; stderr: string; interrupted: boolean }
export interface ReadInput { file_path: string; offset?: number; limit?: number; pages?: string }
export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
export type ReadResult =
  | { type: "text"; file: { filePath: string; content: string; numLines: number; startLine: number; totalLines: number } }
  | { type: "image"; file: { base64: string; type: ImageType; originalSize: number; dimensions: { originalWidth: number; originalHeight: number; displayWidth: number; displayHeight: number } } };
export interface WriteInput { file_path: string; content: string }
export interface WriteResult { type: "create" | "update"; filePath: string; content: string; structuredPatch: []; originalFile: string | null }
export interface EditInput { file_path: string; old_string: string; new_string: string; replace_all?: boolean }
export interface EditResult { filePath: string; oldString: string; newString: string; originalFile: string | null; structuredPatch: []; userModified: false; replaceAll: boolean }

/** Map a Claude Code path to a Workspace path, or explain why not: the
 * local directory Claude Code runs in and /workspace (and relative paths)
 * are the workspace, given relative to its root; any other absolute path is
 * a file in the thread's machine, never one on the cubed host. */
export function workspacePath(root: string, file: string, realRoot?: string): string | Denied {
  if (typeof file !== "string" || !file || file.includes("\0")) return { deny: "a file path is required" };
  if (file.startsWith("~") && file !== "~" && !file.startsWith("~/")) return { deny: `${file}: only ~ and ~/ name a home, the agent's (${GUEST_HOME})` };
  const absolute = file === "~" || file.startsWith("~/") ? `${GUEST_HOME}${file.slice(1)}` : file.startsWith("/") ? file : `${VIRTUAL_ROOT}/${file}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  const normal = `/${parts.join("/")}`;
  const base = [root, realRoot ?? ""].map(alias => alias.replace(/\/+$/, "")).find(alias => alias && (normal === alias || normal.startsWith(`${alias}/`)));
  const resolved = base ? `${VIRTUAL_ROOT}${normal.slice(base.length)}` : normal;
  // cube's artifacts are not the machine's, however the path reaches /cube.
  if (resolved === "/cube" || resolved.startsWith("/cube/")) return { deny: `${file} is not in the machine: cube keeps artifacts at ${ARTIFACT_ROOT}/<name>.md, written whole with Write` };
  if (resolved === VIRTUAL_ROOT) return { deny: `${file} is the workspace root, not a file` };
  if (resolved === "/") return { deny: `${file} is the machine's root directory, not a file` };
  return resolved.startsWith(`${VIRTUAL_ROOT}/`) ? resolved.slice(VIRTUAL_ROOT.length + 1) : resolved;
}

/** What a thread's agent learns about the project's hooks (docs/project-hooks.md). */
export const PROJECT_HOOKS_NOTE = "The project's external hooks (pre-setup and pre-resume, which run before the repository's .agents/setup and .agents/resume) are kept in cube's projects, not in the repository: "
  + "`cube hooks` shows the ones this machine runs, with their last outcomes and logs (read only). A thread cannot change them; the user does, in cube's projects or by asking OptChat.";

/** How an agent should write one, after the show-me skill
 * (https://www.humanlayer.com/blog/show-me-skill): compact visuals beside
 * short text, never walls of prose. */
export const ARTIFACT_GUIDE = "An artifact is a document the user reads beside the chat, selects text in and comments on; every write is a new revision and older ones stay. "
  + "Use one for what the user will read and discuss at length (a review, a plan, a report, a design), not for a short reply. "
  + "Write it as GitHub Markdown and show rather than tell: keep prose brief and put each visual next to the short text it supports. "
  + "Pick the smallest view that makes the point: a call tree or file tree in a text fence, a ```mermaid sequence, state or flow diagram, "
  + "a ```diff of the shape that changes (a component tree, a call stack, a file layout, real code), a short table, pseudocode. "
  + "Raw HTML is shown as text, scripts never run, images are links, and only http(s) and #/ links work. "
  + "Comments come back to you as a message starting \"[artifact <id>]\" with the exact text they are about; answer them, and write a new revision of the same artifact when they call for changes. "
  + "You may revise an artifact someone else wrote when you can read it (a thread reads every artifact of its project): read its newest revision first, then write the whole document with its id. "
  + "A write on an older revision than the newest is refused rather than overwriting someone's newer one: read again and redo it on top. It stays its author's: the user's comments on it still go to the author. "
  + "actions offer the user a button; the only kind is github.merge of a pull request in the project's own repository, pinned to its exact 40-character head commit. "
  + "A revision that leaves actions out keeps the newest revision's as they are; give actions to change them (a new head needs a new headSha), [] to remove them. "
  + "Nothing runs unless the user confirms it on the artifact's page, after cube checks the pull request again; never claim an action ran.";

/** Where Read and Write reach work artifacts instead of the workspace:
 * `<name>.md` is a document, `<name>.json` is `{title?, body, actions?,
 * base?}`, the folder itself lists them; a name in the form of an artifact
 * id is that artifact, the thread's or another one it can read. cubed keeps
 * them, not the machine. */
export const ARTIFACT_ROOT = "/cube/artifacts";
export type ArtifactPath = { kind: "list" } | { kind: "md" | "json"; name: string };
export function artifactPath(file: unknown): ArtifactPath | Denied | null {
  if (typeof file !== "string" || (file !== "/cube" && !file.startsWith("/cube/"))) return null;
  if (file === ARTIFACT_ROOT || file === `${ARTIFACT_ROOT}/`) return { kind: "list" };
  const match = /^\/cube\/artifacts\/([a-z0-9][a-z0-9._-]{0,63})\.(md|json)$/.exec(file);
  if (!match || match[1]!.includes("..")) return { deny: `${file} is not an artifact path: use ${ARTIFACT_ROOT}/<name>.md (or .json), the name in lowercase letters, digits, dots, dashes or underscores` };
  return { kind: match[2] as "md" | "json", name: match[1]! };
}

export async function readArtifact(scope: ToolScope, target: ArtifactPath, input: ReadInput): Promise<ReadResult | Denied> {
  try {
    const { text } = await scope.client.artifact(scope.token, target.kind === "list" ? undefined : target.name);
    const lines = text.split("\n");
    return { type: "text", file: { filePath: input.file_path, content: text, numLines: lines.length, startLine: 1, totalLines: lines.length } };
  } catch (error) { return denied(error, input.file_path); }
}

export async function writeArtifact(scope: ToolScope, toolUseId: string, target: ArtifactPath, input: WriteInput): Promise<WriteResult | Denied> {
  if (target.kind === "list") return { deny: `write ${ARTIFACT_ROOT}/<name>.md, not the folder` };
  if (typeof input.content !== "string") return { deny: "content is required" };
  let document: { body: string; title?: string; actions?: unknown; base?: number } = { body: input.content };
  if (target.kind === "json") {
    let parsed: unknown;
    try { parsed = JSON.parse(input.content); } catch { return { deny: `${input.file_path} must be JSON: {"title"?: string, "body": string, "actions"?: [...], "base"?: number}` }; }
    const record = parsed as Record<string, unknown> | null;
    if (!record || typeof record !== "object" || Array.isArray(record) || typeof record.body !== "string" || (record.title !== undefined && typeof record.title !== "string")
      || (record.base !== undefined && typeof record.base !== "number")) {
      return { deny: `${input.file_path} must be JSON: {"title"?: string, "body": string, "actions"?: [...], "base"?: number}` };
    }
    const extra = Object.keys(record).filter(name => !["title", "body", "actions", "base"].includes(name));
    if (extra.length) return { deny: `${input.file_path}: unknown field ${extra.join(", ")}` };
    document = { body: record.body, ...typeof record.title === "string" ? { title: record.title } : {}, ...record.actions === undefined ? {} : { actions: record.actions },
      ...typeof record.base === "number" ? { base: record.base } : {} };
  }
  try {
    const written = await scope.client.writeArtifact(scope.token, { name: target.name, requestId: key(toolUseId, "artifact"), call: toolUseId, ...document });
    // The tool's own shape; what cubed said reaches the model as the content.
    return { type: "update", filePath: input.file_path, content: written.text, structuredPatch: [], originalFile: null };
  } catch (error) { return denied(error, input.file_path); }
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
        // A stop kills the guest command at once; its key stays spent.
        await scope.client.cancel(scope.token, operationKey).catch(() => {});
        return { stdout: "", stderr: "command stopped", interrupted: true };
      }
      state = next;
    }
    if (state.state === "failed") {
      return { deny: state.completionUnknown ? `the command's outcome is unknown (${state.error}); inspect the workspace before running it again` : `command failed: ${state.error}` };
    }
    if (state.state !== "succeeded") return { deny: "the command's outcome is unknown (the thread's machine or cubed restarted while it ran); inspect the workspace before running it again" };
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
    else if (state.truncated) stdout += `\n[output cut by the machine at ${state.retainedBytes} bytes]`;
    const stderr = state.termination === "timedOut" ? `command timed out after ${timeoutMs} ms`
      : state.termination === "signalled" ? "command was terminated by a signal"
      : state.exitCode ? `exit code ${state.exitCode}` : "";
    return { stdout, stderr, interrupted: state.termination === "timedOut" };
  } catch (error) { return denied(error, "the command"); }
}

export async function read(scope: ToolScope, input: ReadInput): Promise<ReadResult | Denied> {
  const target = workspacePath(scope.root, input.file_path, scope.realRoot);
  if (typeof target !== "string") return target;
  if (input.pages !== undefined) return { deny: "PDF pages are not available in cube threads; use bash to inspect the file" };
  try {
    if (IMAGE_EXTENSION.test(target)) return await readImage(scope, target);
    const file = await loadText(scope, target);
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
  const target = workspacePath(scope.root, input.file_path, scope.realRoot);
  if (typeof target !== "string") return target;
  if (typeof input.content !== "string") return { deny: "content is required" };
  try {
    let existed = true;
    await scope.client.stat(scope.token, target).catch(error => {
      if (error instanceof WorkspaceClientError && error.code === "NOT_FOUND") existed = false;
      else throw error;
    });
    const bytes = new TextEncoder().encode(input.content);
    const { maxWriteBytes } = await scope.client.limits();
    if (bytes.length > maxWriteBytes) return { deny: `${input.file_path} would be ${bytes.length} bytes; the workspace writes at most ${maxWriteBytes} bytes at once — use bash for larger files` };
    await scope.client.writeFile(scope.token, key(toolUseId, "write"), target, bytes, { createParents: true });
    return { type: existed ? "update" : "create", filePath: input.file_path, content: input.content, structuredPatch: [], originalFile: null };
  } catch (error) { return denied(error, input.file_path); }
}

/** Edit is read, replace, then a write conditional on the content read. */
export async function edit(scope: ToolScope, toolUseId: string, input: EditInput): Promise<EditResult | Denied> {
  const target = workspacePath(scope.root, input.file_path, scope.realRoot);
  if (typeof target !== "string") return target;
  if (typeof input.old_string !== "string" || typeof input.new_string !== "string") return { deny: "old_string and new_string are required" };
  if (input.old_string === input.new_string) return { deny: "No changes to make: old_string and new_string are exactly the same." };
  const replaceAll = input.replace_all === true;
  try {
    let original: { text: string; sha256: string } | null;
    try {
      const file = await loadText(scope, target);
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
    await scope.client.writeFile(scope.token, key(toolUseId, "edit"), target, bytes,
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

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i;
const CONVERT = "with bash (`sudo apt-get install -y imagemagick` if convert is missing)";

/** An image in Claude Code's own Read result shape, so the model sees the
 * picture. The bytes must be the format their header claims, look whole and
 * fit the model API as they are: this module cannot decode or resize, so a
 * larger image is refused with a way out. An image the API still rejects
 * (corrupt inside, or lying about its size) Claude Code replaces with a note. */
async function readImage(scope: ToolScope, target: string): Promise<ReadResult | Denied> {
  const file = await loadBytes(scope, target, MAX_IMAGE_BYTES, size => `${target} is ${size} bytes, over the ${MAX_IMAGE_BYTES} bytes an image may be; write a smaller JPEG copy ${CONVERT}, for example \`convert in.png -resize ${MAX_IMAGE_SIDE}x${MAX_IMAGE_SIDE}\\> -quality 85 out.jpg\`, and read that`);
  if ("deny" in file) return file;
  const { bytes } = file;
  const image = imageInfo(bytes);
  if (!image) return { deny: `${target} is not a PNG, JPEG, GIF or WebP image; inspect it with bash` };
  const { type, width, height } = image;
  if (!isWhole(type, bytes)) return { deny: `${target} looks truncated (it may still be being written); read it again later or inspect it with bash` };
  if (width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE) return { deny: `${target} is ${width}x${height} pixels; write a copy at most ${MAX_IMAGE_SIDE} pixels a side ${CONVERT}, for example \`convert in.png -resize ${MAX_IMAGE_SIDE}x${MAX_IMAGE_SIDE}\\> out.png\`, and read that` };
  const dimensions = { originalWidth: width, originalHeight: height, displayWidth: width, displayHeight: height };
  return { type: "image", file: { base64: toBase64(bytes), type, originalSize: bytes.length, dimensions } };
}

/** Whether the file ends the way its format ends. A JPEG cut short still
 * decodes, and some carry bytes after their end marker, so it is not checked. */
function isWhole(type: ImageType, bytes: Uint8Array): boolean {
  const end = bytes.length;
  if (type === "image/png") return [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82].every((byte, index) => bytes[end - 8 + index] === byte);
  if (type === "image/gif") return bytes[end - 1] === 0x3b;
  if (type === "image/webp") return end >= 8 + (bytes[4]! | (bytes[5]! << 8) | (bytes[6]! << 16)) + bytes[7]! * 0x1000000;
  return true;
}

/** The format and pixel size an image's header declares, or null when the
 * bytes do not start with a PNG, JPEG, GIF or WebP header. */
export function imageInfo(bytes: Uint8Array): { type: ImageType; width: number; height: number } | null {
  const at = (offset: number, text: string) => [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  const u16be = (offset: number) => (bytes[offset]! << 8) | bytes[offset + 1]!;
  const u16le = (offset: number) => bytes[offset]! | (bytes[offset + 1]! << 8);
  const u24le = (offset: number) => u16le(offset) + bytes[offset + 2]! * 0x10000;
  const u32be = (offset: number) => u16be(offset) * 0x10000 + u16be(offset + 2);
  const sized = (type: ImageType, width: number, height: number) => width > 0 && height > 0 ? { type, width, height } : null;
  if (bytes.length >= 24 && at(0, "\x89PNG\r\n\x1a\n") && at(12, "IHDR")) return sized("image/png", u32be(16), u32be(20));
  if (bytes.length >= 10 && (at(0, "GIF87a") || at(0, "GIF89a"))) return sized("image/gif", u16le(6), u16le(8));
  if (bytes.length >= 30 && at(0, "RIFF") && at(8, "WEBP")) {
    if (at(12, "VP8 ") && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) return sized("image/webp", u16le(26) & 0x3fff, u16le(28) & 0x3fff);
    if (at(12, "VP8L") && bytes[20] === 0x2f) return sized("image/webp", 1 + (u16le(21) & 0x3fff), 1 + ((u24le(22) >> 6) & 0x3fff));
    if (at(12, "VP8X")) return sized("image/webp", 1 + u24le(24), 1 + u24le(27));
    return null;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    // The size is in the first start-of-frame segment; step over the segments before it.
    let offset = 2;
    while (offset + 9 <= bytes.length && bytes[offset] === 0xff) {
      const marker = bytes[offset + 1]!;
      if (marker === 0xff) { offset++; continue; }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return sized("image/jpeg", u16be(offset + 7), u16be(offset + 5));
      if (marker === 0xd9 || marker === 0xda) return null;
      offset += 2 + u16be(offset + 2);
    }
  }
  return null;
}

/** The whole file as text. */
async function loadText(scope: ToolScope, target: string): Promise<{ text: string; sha256: string | null } | Denied> {
  const file = await loadBytes(scope, target, MAX_FILE_BYTES, size => `${target} is ${size} bytes; read and change files over ${MAX_FILE_BYTES} bytes with bash (head, sed -n, rg)`);
  if ("deny" in file) return file;
  const { bytes } = file;
  const text = new TextDecoder().decode(bytes);
  // Invalid UTF-8 decodes to U+FFFD, which re-encodes to a different length.
  if (bytes.includes(0) || (text.includes("\uFFFD") && new TextEncoder().encode(text).length !== bytes.length)) {
    return { deny: `${target} is not UTF-8 text; inspect it with bash` };
  }
  return { text, sha256: file.sha256 };
}

/** The whole file, read page by page; every page must report the same whole-file sha. */
async function loadBytes(scope: ToolScope, target: string, maxBytes: number, tooLarge: (size: number) => string): Promise<{ bytes: Uint8Array; sha256: string | null } | Denied> {
  const { maxReadBytes } = await scope.client.limits();
  const pages: Uint8Array[] = [];
  let offset = 0;
  let sha: string | null | undefined;
  for (;;) {
    const page = await scope.client.readFile(scope.token, target, { offset, limit: maxReadBytes });
    if (sha !== undefined && page.sha256 !== sha) return { deny: `${target} changed while it was read; read it again` };
    if (page.size > maxBytes) return { deny: tooLarge(page.size) };
    sha = page.sha256;
    pages.push(page.content);
    offset += page.content.length;
    if (page.eof || !page.content.length) break;
  }
  const bytes = concat(pages);
  if (bytes.length > maxBytes) return { deny: tooLarge(bytes.length) };
  return { bytes, sha256: sha ?? null };
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
