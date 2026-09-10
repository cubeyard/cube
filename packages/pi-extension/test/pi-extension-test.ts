/**
 * Offline test for the cube pi-extension: pi's REAL tool implementations
 * (read/write/edit/ls/find) run against CubeFs, with the guest played by a
 * local temp directory — exec is a local `sh -c`, file transfer is local
 * fs, and the fsops helper genuinely gets pushed and invoked as a child
 * node process. Plus units for path mapping, the grep executor/formatter,
 * the unshadowed-tool guard, and config resolution. No Incus, no model.
 *
 *   node packages/pi-extension/test/pi-extension-test.ts
 */
import assert from "node:assert";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import type { Sandbox, SandboxExecOptions } from "@cube/sandbox";
import {
  createEditTool,
  createFindTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";

import { CubeFs, type GuestFiles } from "../src/cube-fs.ts";
import { formatGrepResult } from "../src/grep-format.ts";
import { auditTools } from "../src/guard.ts";
import cubeExtension, { mockFiles, resolveConfig, Waker } from "../src/index.ts";
import { createGuestOperations } from "../src/ops.ts";
import { toGuestPath } from "../src/paths.ts";

// ---- fakes: the "guest" is a local temp dir ------------------------------

class LocalExec implements Sandbox {
  readonly name = "local";
  exec(command: string, { cwd, onData }: SandboxExecOptions): Promise<{ exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn("sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", reject);
      child.on("close", (code) => resolve({ exitCode: code }));
    });
  }
}

// Production mock mode uses this same local files adapter; these tests keep
// exercising its symlink and bounded-read parity with the Incus files API.
const localFiles = mockFiles();

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-ext-test-"));
process.on("exit", () => fs.rmSync(root, { recursive: true, force: true }));

// The "workspace" as seen from host and guest: distinct paths so the
// host→guest mapping is actually exercised.
const guestWs = path.join(root, "guest-ws");
const hostWs = path.join(root, "host-view");
fs.mkdirSync(guestWs, { recursive: true });
const helperPath = path.join(root, "helper", "fsops.mjs");

let ensured = 0;
const cubeFs = new CubeFs(new LocalExec(), localFiles, {
  helperGuestPath: helperPath,
  guestCwd: guestWs,
  ensure: async () => {
    ensured++;
  },
});
const ops = createGuestOperations(cubeFs, hostWs, guestWs);
const signal = new AbortController().signal;
const noUpdate = () => {};

function text(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

// ---- 1. path mapping -----------------------------------------------------

assert.equal(toGuestPath("/host/ws", "/workspace", "/host/ws"), "/workspace");
assert.equal(toGuestPath("/host/ws", "/workspace", "/host/ws/a/b.ts"), "/workspace/a/b.ts");
assert.equal(toGuestPath("/host/ws", "/workspace", "a/b.ts"), "/workspace/a/b.ts");
assert.equal(toGuestPath("/host/ws", "/workspace", "@a/b.ts"), "/workspace/a/b.ts");
assert.equal(toGuestPath("/host/ws", "/workspace", "./a/../c.ts"), "/workspace/c.ts");
assert.equal(toGuestPath("/host/ws", "/workspace", "/etc/hostname"), "/etc/hostname");
assert.equal(toGuestPath("/host/ws", "/workspace", "/host/ws-sibling/x"), "/host/ws-sibling/x");
assert.equal(toGuestPath("/host/ws", "/workspace", ""), "/workspace");
console.log("1 ok: path mapping");

// ---- 2. helper push + fs ops through CubeFs ------------------------------

await cubeFs.mkdir(path.join(guestWs, "src/deep"));
assert.ok(fs.existsSync(helperPath), "helper was pushed on first use");
await cubeFs.writeFile(path.join(guestWs, "src/deep/a.txt"), "hello cube\nsecond line\n");
const readBack = await cubeFs.readFile(path.join(guestWs, "src/deep/a.txt"));
assert.equal(readBack.toString("utf8"), "hello cube\nsecond line\n");
assert.ok(ensured > 0, "ensure hook ran");

const stat = await cubeFs.statOrNull(path.join(guestWs, "src"));
assert.deepEqual(stat, { isDir: true });
assert.equal(await cubeFs.statOrNull(path.join(guestWs, "missing")), null);
await assert.rejects(() => cubeFs.access(path.join(guestWs, "missing")), /ENOENT|no such/i);

// helper self-heals: delete it, next op re-pushes and retries
fs.rmSync(helperPath);
const names = await cubeFs.readdir(path.join(guestWs, "src"));
assert.deepEqual(names, ["deep"]);
assert.ok(fs.existsSync(helperPath), "helper re-pushed after loss");

// symlinks resolve in the GUEST namespace: read follows to the target,
// write lands on the target instead of clobbering the link
fs.symlinkSync("src/deep/a.txt", path.join(guestWs, "link.txt"));
assert.equal(
  (await cubeFs.readFile(path.join(guestWs, "link.txt"))).toString("utf8"),
  "hello cube\nsecond line\n",
);
// writing an EXECUTABLE file preserves its mode (does not flatten to 0644)
fs.chmodSync(path.join(guestWs, "src/deep/a.txt"), 0o755);
await cubeFs.writeFile(path.join(guestWs, "link.txt"), "rewritten\n");
assert.ok(fs.lstatSync(path.join(guestWs, "link.txt")).isSymbolicLink(), "link survives the write");
assert.equal(fs.readFileSync(path.join(guestWs, "src/deep/a.txt"), "utf8"), "rewritten\n");
assert.equal(fs.statSync(path.join(guestWs, "src/deep/a.txt")).mode & 0o777, 0o755, "exec bit preserved");
const resolvedMissing = await cubeFs.resolvePath(path.join(guestWs, "missing/new.txt"));
assert.equal(resolvedMissing.path, path.join(guestWs, "missing/new.txt"));
assert.equal(resolvedMissing.mode, null, "new file has no prior mode");

// oversized read is refused rather than buffered
fs.writeFileSync(path.join(guestWs, "big.bin"), Buffer.alloc(1024));
const smallReadFs = new CubeFs(new LocalExec(), localFiles, {
  helperGuestPath: helperPath,
  guestCwd: guestWs,
  maxReadBytes: 512,
});
await assert.rejects(() => smallReadFs.readFile(path.join(guestWs, "big.bin")), /exceeds 512 bytes/);

let fileSignal: AbortSignal | undefined;
const cancellationFiles: GuestFiles = {
  push: async () => {},
  pull: async (_path, opts) =>
    new Promise((_resolve, reject) => {
      fileSignal = opts?.signal;
      const onAbort = () => reject(opts?.signal?.reason);
      if (opts?.signal?.aborted) onAbort();
      else opts?.signal?.addEventListener("abort", onAbort, { once: true });
    }),
};
const cancellationFs = new CubeFs(new LocalExec(), cancellationFiles);
const fileController = new AbortController();
const cancelledRead = cancellationFs.readFile("/slow", fileController.signal);
fileController.abort(new Error("read cancelled"));
await assert.rejects(cancelledRead, /read cancelled/);
assert.equal(fileSignal, fileController.signal);
console.log("2 ok: CubeFs ops + helper self-heal + symlink/mode/size guards + cancellation");

// ---- 3. pi's real tools over the guest ops -------------------------------

const write = createWriteTool(guestWs, { operations: ops.writeOps });
await write.execute("t1", { path: "notes/hi.md", content: "# hi\n" }, signal, noUpdate);
assert.equal(fs.readFileSync(path.join(guestWs, "notes/hi.md"), "utf8"), "# hi\n");

const read = createReadTool(guestWs, { operations: ops.readOps });
// A host-workspace-absolute path must be re-rooted into the guest.
const readResult = await read.execute("t2", { path: path.join(hostWs, "notes/hi.md") }, signal, noUpdate);
assert.match(text(readResult), /# hi/);

const edit = createEditTool(guestWs, { operations: ops.editOps });
await edit.execute(
  "t3",
  { path: "notes/hi.md", edits: [{ oldText: "# hi", newText: "# hello" }] },
  signal,
  noUpdate,
);
assert.equal(fs.readFileSync(path.join(guestWs, "notes/hi.md"), "utf8"), "# hello\n");

const ls = createLsTool(guestWs, { operations: ops.lsOps });
const lsResult = await ls.execute("t4", {}, signal, noUpdate);
assert.match(text(lsResult), /notes/);
assert.match(text(lsResult), /src/);

const find = createFindTool(guestWs, { operations: ops.findOps });
const findResult = await find.execute("t5", { pattern: "*.txt" }, signal, noUpdate);
assert.match(text(findResult), /src\/deep\/a\.txt/);
console.log("3 ok: pi read/write/edit/ls/find tools run against the guest");

// ---- 4. grep executor + formatting ---------------------------------------

fs.mkdirSync(path.join(guestWs, "node_modules/dep"), { recursive: true });
fs.writeFileSync(path.join(guestWs, "node_modules/dep/skip.txt"), "needle\n");
fs.writeFileSync(path.join(guestWs, "src/deep/b.txt"), "one\nneedle here\nthree\nNEEDLE again\n");
fs.writeFileSync(path.join(guestWs, "binary.bin"), Buffer.from([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0x00, 0x01]));

const hit = await cubeFs.grep({ pattern: "needle", path: guestWs });
assert.equal(hit.matchCount, 1, "case-sensitive, node_modules and binary skipped");
assert.match(hit.lines[0]!, /^src\/deep\/b\.txt:2: needle here$/);

const insensitive = await cubeFs.grep({ pattern: "needle", path: guestWs, ignoreCase: true, context: 1 });
assert.equal(insensitive.matchCount, 2);
assert.ok(insensitive.lines.some((l) => l.endsWith("-1- one")), "context line present");

const limited = await cubeFs.grep({ pattern: "needle", path: guestWs, ignoreCase: true, limit: 1 });
assert.equal(limited.matchLimitReached, true);
const formatted = formatGrepResult(limited);
assert.match(text(formatted), /\[1 matches limit reached\]/);
assert.equal(formatted.details?.matchLimitReached, 1);

const miss = formatGrepResult(await cubeFs.grep({ pattern: "no-such-string", path: guestWs }));
assert.equal(text(miss), "No matches found");

const gloved = await cubeFs.grep({ pattern: "needle", path: guestWs, ignoreCase: true, glob: "*.md" });
assert.equal(gloved.matchCount, 0, "glob filter respected");

// A symlinked directory is NOT traversed (fd/rg default): a link to an
// out-of-tree dir full of matches must not pull them into the search.
const outside = fs.mkdtempSync(path.join(os.tmpdir(), "cube-outside-"));
fs.writeFileSync(path.join(outside, "leak.txt"), "needle needle needle\n");
fs.symlinkSync(outside, path.join(guestWs, "escapedir"));
const afterLink = await cubeFs.grep({ pattern: "needle", path: guestWs });
assert.equal(afterLink.matchCount, 1, "symlinked dir not descended into");
const globAfterLink = await cubeFs.glob("*.txt", guestWs, 100);
assert.ok(!globAfterLink.some((p) => p.includes("leak.txt")), "glob does not follow the dir symlink");
fs.rmSync(outside, { recursive: true, force: true });

await assert.rejects(() => cubeFs.grep({ pattern: "(", path: guestWs }), /Invalid regular expression/);
console.log("4 ok: grep semantics + formatting");

// ---- 5. the unshadowed-tool guard ----------------------------------------

const ownRoot = path.resolve("packages/pi-extension");
const ours = (name: string) => ({ name, sourcePath: path.join(ownRoot, "src/index.ts") });

assert.deepEqual(
  auditTools(["read", "bash", "code"], [ours("read"), ours("bash"), ours("code")], ownRoot),
  [],
  "all shadowed by us → clean",
);
assert.match(
  auditTools(["git_push_base"], [ours("git_push_base")], ownRoot)[0]!,
  /unknown tool "git_push_base"/,
  "authenticated operations live behind code mode rather than adding top-level tools",
);
assert.match(
  auditTools(["read", "todo"], [ours("read"), { name: "todo", sourcePath: "/elsewhere/ext.ts" }], ownRoot)[0]!,
  /unknown tool "todo"/,
);
assert.match(
  auditTools(["bash"], [{ name: "bash", sourcePath: "<builtin>" }], ownRoot)[0]!,
  /not backed by the cube extension/,
);
assert.match(
  auditTools(["bash"], [], ownRoot)[0]!,
  /not backed by the cube extension/,
  "active but unregistered → refused",
);
// -e pointing at the package dir itself is also ours
assert.deepEqual(auditTools(["read"], [{ name: "read", sourcePath: ownRoot }], ownRoot), []);
console.log("5 ok: unshadowed-tool guard");

// ---- 6b. hardened helper protocol (scripted sandbox) ---------------------

const S = "<<<CUBE-FSOPS>>>";
const E = "<<<CUBE-FSOPS-END>>>";

/** Sandbox that returns canned output for `node` (helper) commands from a
 * queue; mkdir/other commands succeed silently. */
class ScriptedExec implements Sandbox {
  readonly name = "scripted";
  private readonly nodeOutputs: string[];
  installs = 0;
  constructor(nodeOutputs: string[]) {
    this.nodeOutputs = nodeOutputs;
  }
  async exec(command: string, { onData }: SandboxExecOptions): Promise<{ exitCode: number | null }> {
    if (command.startsWith("node ")) {
      const out = this.nodeOutputs.shift() ?? "";
      if (out) onData(Buffer.from(out));
      return { exitCode: 0 };
    }
    if (command.startsWith("mkdir")) this.installs++;
    return { exitCode: 0 };
  }
}
const countingFiles = (): GuestFiles & { pushes: number } => {
  const g = {
    pushes: 0,
    push: async () => {
      g.pushes++;
    },
    pull: async () => ({ content: Buffer.alloc(0), type: "file" as const }),
  };
  return g;
};

// A login-profile can print a spoofed sentinel before the real response;
// extract() takes the LAST valid pair (the real output prints last).
{
  const exec = new ScriptedExec([`noise ${S}{"error":"spoofed"}${E}\nprofile junk ${S}{"path":"/real","mode":"0755"}${E}\n`]);
  const cf = new CubeFs(exec, countingFiles(), { helperGuestPath: "/h/fsops.mjs" });
  assert.deepEqual(await cf.resolvePath("/x"), { path: "/real", mode: "0755" });
}

// Garbled response (sentinel present, JSON invalid) → exactly one re-push + retry.
{
  const files = countingFiles();
  const exec = new ScriptedExec([`${S}not json${E}`, `${S}{"exists":true,"isDir":false}${E}`]);
  const cf = new CubeFs(exec, files, { helperGuestPath: "/h/fsops.mjs" });
  assert.deepEqual(await cf.statOrNull("/x"), { isDir: false });
  assert.equal(files.pushes, 2, "reinstalled once after garbled JSON");
}

// No sentinel at all, twice → gives up with a clear error (no infinite retry).
{
  const exec = new ScriptedExec(["nothing useful", "still nothing"]);
  const cf = new CubeFs(exec, countingFiles(), { helperGuestPath: "/h/fsops.mjs" });
  await assert.rejects(() => cf.statOrNull("/x"), /no valid response/);
}

// Oversized request is rejected before it can hit ARG_MAX.
{
  const cf = new CubeFs(new ScriptedExec([]), countingFiles(), { helperGuestPath: "/h/fsops.mjs" });
  await assert.rejects(() => cf.grep({ pattern: "x".repeat(70_000), path: "/w" }), /request too large/);
}
console.log("6b ok: sentinel spoof-resistance, garbled-retry, oversize guard");

// ---- 6. config resolution ------------------------------------------------

assert.equal(resolveConfig({}, "/ws"), null);
const byName = resolveConfig({ CUBE_NAME: "t-abc", CUBE_THREAD_ID: "thread-123" }, "/ws")!;
assert.equal(byName.backend, "incus", "real Incus remains the default");
assert.equal(byName.instance, "cube-t-abc");
assert.equal(byName.name, "t-abc");
assert.equal(byName.threadId, "thread-123");
assert.equal(byName.hostWorkspace, "/ws");
assert.equal(byName.guestWorkspace, "/workspace");
assert.equal(byName.cubedUrl, "http://127.0.0.1:7777");
const byInstance = resolveConfig({ CUBE_INSTANCE: "cube-xyz", CUBED_URL: "http://10.0.0.1:7777/" }, "/ws")!;
assert.equal(byInstance.name, "xyz");
assert.equal(byInstance.cubedUrl, "http://10.0.0.1:7777");
const foreign = resolveConfig({ CUBE_INSTANCE: "orb-spike01" }, "/ws")!;
assert.equal(foreign.name, undefined, "non-cube instance name → no cubed wake route");
const mocked = resolveConfig(
  {
    CUBE_NAME: "t-mock",
    CUBE_BACKEND: "mock",
    CUBE_HOST_WORKSPACE: "/host/mock-workspace",
    CUBE_GUEST_WORKSPACE: "/workspace",
  },
  "/fallback",
)!;
assert.equal(mocked.backend, "mock");
assert.equal(mocked.guestWorkspace, "/host/mock-workspace", "mock paths reflect the real local namespace");
assert.equal(resolveConfig({ CUBE_NAME: "t-bad", CUBE_BACKEND: "typo" }, "/ws"), null, "unknown backend fails closed");
console.log("6 ok: config resolution");

// ---- 7. mock lifecycle stays owned by cubed ------------------------------

{
  let state = "asleep";
  let wakes = 0;
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/cubes/t-mock") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ status: state }));
    }
    if (req.method === "POST" && req.url === "/api/cubes/t-mock/wake") {
      state = "ready";
      wakes++;
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end('{"ok":true}');
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const cfg = resolveConfig(
    {
      CUBE_NAME: "t-mock",
      CUBE_BACKEND: "mock",
      CUBE_HOST_WORKSPACE: "/host/mock-workspace",
      CUBED_URL: `http://127.0.0.1:${address.port}`,
    },
    "/fallback",
  )!;
  const waker = new Waker(cfg);
  await waker.ensure();
  assert.equal(state, "ready", "sleeping mock environment wakes through cubed");
  assert.equal(wakes, 1);
  await waker.ensure();
  assert.equal(wakes, 1, "ready mock environment is not woken twice");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  console.log("7 ok: mock sleep/wake goes through cubed");
}

// A cancelled capability must tear down an in-flight wake fetch instead of
// leaving Waker work attached after QuickJS has exited.
{
  let startWake!: () => void;
  const wakeStarted = new Promise<void>((resolve) => (startWake = resolve));
  let closeWake!: () => void;
  const wakeClosed = new Promise<void>((resolve) => (closeWake = resolve));
  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end('{"status":"asleep"}');
    }
    startWake();
    res.on("close", closeWake);
    // Intentionally never answer; the caller's AbortSignal must close it.
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const cfg = resolveConfig(
    {
      CUBE_NAME: "t-cancel",
      CUBE_BACKEND: "mock",
      CUBE_HOST_WORKSPACE: "/host/mock-workspace",
      CUBED_URL: `http://127.0.0.1:${address.port}`,
    },
    "/fallback",
  )!;
  const controller = new AbortController();
  const pending = new Waker(cfg).ensure(undefined, controller.signal);
  await wakeStarted;
  controller.abort(new Error("wake cancelled"));
  await assert.rejects(pending, /wake cancelled/);
  await wakeClosed;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  console.log("7b ok: cancellation closes an in-flight wake request");
}

// Exercise the registered code tool as well as the independent I/O helpers:
// errors must remain structured when pi formats them, and cancelled mutation
// requests must not claim that the remote side effect was rolled back.
{
  let mutationStarted!: () => void;
  const started = new Promise<void>(resolve => { mutationStarted = resolve; });
  const server = http.createServer((req, res) => {
    if (req.url?.endsWith("/services")) {
      mutationStarted();
      return; // simulate a remote mutation whose completion is unknown
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"status":"ready"}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const settings = {
    CUBE_NAME: "t-code-contract", CUBE_BACKEND: "mock", CUBE_HOST_WORKSPACE: guestWs,
    CUBE_THREAD_ID: "t-code-contract", CUBED_URL: `http://127.0.0.1:${address.port}`,
  };
  const saved = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, settings);
    const tools = new Map<string, any>();
    cubeExtension({ registerTool: (tool: any) => tools.set(tool.name, tool), on() {}, registerCommand() {} } as any);
    const code = tools.get("code");
    assert.ok(code);
    const timed = await code.execute("test", {
      source: 'return await cube.exec("printf partial; sleep 1", {timeoutMs: 200});',
    });
    assert.equal(timed.isError, true);
    assert.equal(timed.details.error.code, "ETIMEDOUT");
    assert.equal(timed.details.error.output, "partial");
    assert.match(text(timed), /ETIMEDOUT/);
    const overflow = await code.execute("test", {
      source: `return await cube.exec("head -c 1048577 /dev/zero");`,
    });
    assert.equal(overflow.isError, true);
    assert.equal(overflow.details.error.code, "EOUTPUTLIMIT");
    assert.ok(overflow.details.error.output.length > 0, "JSON escaping must not discard all partial output");
    assert.equal(overflow.details.error.truncated, true);
    const missing = await code.execute("test", { source: 'return await cube.fs.readText("does-not-exist");' });
    assert.equal(missing.details.error.code, "ENOENT");
    assert.equal(missing.details.error.path, "does-not-exist");
    const controller = new AbortController();
    const mutation = code.execute("test", { source: "return await cube.services.ensure();" }, controller.signal);
    await started;
    controller.abort(new Error("test stopped"));
    const cancelled = await mutation;
    assert.equal(cancelled.isError, true);
    assert.equal(cancelled.details.error.code, "ECODE_UNCERTAIN");
    assert.equal(cancelled.details.error.completionUnknown, true);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  console.log("8 ok: registered code tool preserves structured errors and reports uncertain remote completion");
}

console.log("ALL PASS");
