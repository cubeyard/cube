/** Offline stand-in for the runner client behind RunnerWorkspace. It follows
 * the protocol-2 semantics closely enough for the shared contract suite; the
 * same suite runs against the real Rust runner in smoke-node-adapter.ts.
 * Mocks are not runner acceptance. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { IrohNodeError, type NodeBinding, type RunnerDescription, type RunnerExecSpec, type RunnerFile, type RunnerFileStat, type RunnerOperation, type RunnerWriteResult } from "../src/iroh-node.ts";
import type { WorkspaceRunner } from "../src/workspace.ts";

const LIMITS = { maxFrameBytes: 1048576, requestTimeoutMs: 5000, maxCommandBytes: 8192, maxPathBytes: 4096, maxExecTimeoutMs: 600000,
  maxOutputBytes: 262144, outputPageBytes: 65536, maxReadBytes: 524288, maxWriteBytes: 524288 };
const CAPABILITIES = ["node.hello", "node.status", "workspace.allocate.v2", "workspace.release", "exec.start", "exec.cancel",
  "environment.inspect", "operation.get", "fs.read", "fs.write", "fs.stat"];

type Record_ =
  | { kind: "exec"; hash: string; state: RunnerOperation; output: Buffer; child?: ChildProcess; cancelled?: boolean }
  | { kind: "write"; hash: string; result?: RunnerWriteResult; error?: string };

export class FakeRunner implements WorkspaceRunner {
  readonly binding: Readonly<NodeBinding>;
  readonly root: string;
  capabilities = [...CAPABILITIES];
  private epoch = 0;
  private readonly records = new Map<string, Record_>();

  constructor(root: string, binding: NodeBinding = { nodeId: "node-fake", environmentId: 1, threadId: "thread-fake" }) {
    this.root = fs.realpathSync(root);
    this.binding = Object.freeze({ ...binding });
  }
  async describe(): Promise<RunnerDescription> {
    return { softwareVersion: "0.0.0-fake", capabilities: [...this.capabilities], limits: { ...LIMITS } };
  }
  async startOperation(id: string, spec: RunnerExecSpec, options: { epoch?: number } = {}): Promise<void> {
    this.fence(options.epoch);
    const hash = JSON.stringify(spec);
    const existing = this.records.get(id);
    if (existing) {
      if (existing.kind !== "exec" || existing.hash !== hash) throw new IrohNodeError("CONFLICT");
      return;
    }
    const cwd = this.resolve(spec.guestCwd);
    const record: Record_ = { kind: "exec", hash, state: { state: "Running" }, output: Buffer.alloc(0) };
    this.records.set(id, record);
    const child = spawn("/bin/sh", ["-c", spec.command], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    record.child = child;
    const chunks: Buffer[] = [];
    let total = 0;
    const take = (chunk: Buffer) => { total += chunk.length; if (Buffer.concat(chunks).length < spec.outputLimit) chunks.push(chunk); };
    child.stdout!.on("data", take);
    child.stderr!.on("data", take);
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* exited */ } }, spec.timeoutMs);
    child.on("close", code => {
      clearTimeout(timer);
      record.child = undefined;
      if (record.cancelled) { record.state = { state: "Failed", error: "CANCELLED", completionUnknown: false }; return; }
      const output = Buffer.concat(chunks).subarray(0, spec.outputLimit);
      record.output = output;
      record.state = { state: "Succeeded", result: { exitCode: code, termination: code === null ? "signalled" : "exited",
        output: [], outputBytes: total, truncated: total > output.length, outputOffset: 0, retainedBytes: output.length } };
    });
  }
  async inspectOperation(id: string, options: { cursor?: number } = {}): Promise<RunnerOperation> {
    const record = this.records.get(id);
    if (!record) return { state: "Unknown" };
    if (record.kind === "write") {
      if (record.error) return { state: "Failed", error: record.error, completionUnknown: false };
      return { state: "Written", result: record.result! };
    }
    if (record.state.state !== "Succeeded") return record.state;
    const cursor = Math.min(options.cursor ?? 0, record.output.length);
    return { state: "Succeeded", result: { ...record.state.result, outputOffset: cursor,
      output: [...record.output.subarray(cursor, cursor + LIMITS.outputPageBytes)] } };
  }
  async cancelOperation(id: string, options: { epoch?: number } = {}): Promise<RunnerOperation> {
    this.fence(options.epoch);
    const record = this.records.get(id);
    if (record?.kind === "exec" && record.child) {
      record.cancelled = true;
      try { process.kill(-record.child.pid!, "SIGKILL"); } catch { /* exited */ }
    }
    return this.inspectOperation(id);
  }
  async readFile(file: string, options: { offset?: number; limit?: number } = {}): Promise<RunnerFile> {
    const target = this.resolve(file);
    if (!fs.existsSync(target)) throw new IrohNodeError("NOT_FOUND");
    const bytes = fs.readFileSync(target);
    const offset = options.offset ?? 0;
    const content = bytes.subarray(offset, offset + Math.min(options.limit ?? LIMITS.maxReadBytes, LIMITS.maxReadBytes));
    return { content, offset, size: bytes.length, eof: offset + content.length >= bytes.length, sha256: sha(bytes) };
  }
  async writeFile(file: string, content: Uint8Array, options: { idempotencyKey: string; expectedSha?: string; createParents?: boolean; epoch?: number }): Promise<RunnerWriteResult> {
    this.fence(options.epoch);
    const hash = JSON.stringify([file, sha(content), options.expectedSha ?? null, options.createParents ?? false]);
    const existing = this.records.get(options.idempotencyKey);
    if (existing) {
      if (existing.kind !== "write" || existing.hash !== hash) throw new IrohNodeError("CONFLICT");
      if (existing.error) throw new IrohNodeError(existing.error);
      return existing.result!;
    }
    const target = this.resolve(file);
    const record: Record_ = { kind: "write", hash };
    try {
      if (options.expectedSha !== undefined && (!fs.existsSync(target) || sha(fs.readFileSync(target)) !== options.expectedSha)) {
        throw new IrohNodeError("PRECONDITION_FAILED");
      }
      if (options.createParents) fs.mkdirSync(path.dirname(target), { recursive: true });
      else if (!fs.existsSync(path.dirname(target))) throw new IrohNodeError("NOT_FOUND");
      fs.writeFileSync(`${target}.tmp`, content);
      fs.renameSync(`${target}.tmp`, target);
      record.result = { sha256: sha(content), size: content.length };
      this.records.set(options.idempotencyKey, record);
      return record.result;
    } catch (error) {
      record.error = error instanceof IrohNodeError ? error.remoteCode : "IO_ERROR";
      this.records.set(options.idempotencyKey, record);
      throw error instanceof IrohNodeError ? error : new IrohNodeError("IO_ERROR");
    }
  }
  async stat(file: string): Promise<RunnerFileStat> {
    const target = this.resolve(file);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(target); } catch { throw new IrohNodeError("NOT_FOUND"); }
    const kind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other";
    return { kind, size: stat.size, mode: stat.mode & 0o7777, modifiedMs: Math.floor(stat.mtimeMs),
      sha256: kind === "file" ? sha(fs.readFileSync(target)) : null };
  }
  /** Kill anything still running; the test process must not leak children. */
  close(): void {
    for (const record of this.records.values()) {
      if (record.kind === "exec" && record.child) { try { process.kill(-record.child.pid!, "SIGKILL"); } catch { /* exited */ } }
    }
  }

  private fence(epoch = 0): void {
    if (epoch < this.epoch) throw new IrohNodeError("LEASE_STALE");
    this.epoch = epoch;
  }
  private resolve(file: string): string {
    // Like the runner: relative, and no parent components at all.
    if (!file || path.isAbsolute(file) || file.split("/").includes("..")) throw new IrohNodeError("INVALID_REQUEST");
    const target = path.resolve(this.root, file);
    if (target !== this.root && !target.startsWith(`${this.root}${path.sep}`)) throw new IrohNodeError("INVALID_REQUEST");
    return target;
  }
}

function sha(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
