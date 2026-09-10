/** Functional codemode I/O regressions: mocked boundaries and real local
 * process cancellation, never Incus or authenticated operations. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MockSandbox } from "@cube/sandbox";
import { codeFile, execCode, MAX_CODE_EXEC_OUTPUT, type CodeExec } from "../src/code-io.ts";
import { runCodeMode } from "../src/code-mode.ts";

const signal = new AbortController().signal;
const input = { command: "unused", cwd: undefined, timeoutMs: 5000 };

// Chunk boundaries must not change which bytes survive the overflow.
for (const size of [MAX_CODE_EXEC_OUTPUT, MAX_CODE_EXEC_OUTPUT + 1]) {
  const exec: CodeExec = async (_command, _cwd, { onData, signal }) => {
    onData(Buffer.alloc(size - 1, "a"));
    onData(Buffer.from("b"));
    if (signal.aborted) throw new Error("aborted");
    return { exitCode: 7 };
  };
  if (size === MAX_CODE_EXEC_OUTPUT) {
    const result = await execCode(exec, input, "/workspace", signal);
    assert.equal(result.output.length, MAX_CODE_EXEC_OUTPUT);
    assert.equal(result.exitCode, 7);
  } else {
    await assert.rejects(execCode(exec, input, "/workspace", signal), (error: any) => {
      assert.equal(error.code, "EOUTPUTLIMIT");
      assert.match(error.message, /1048576 bytes/);
      assert.equal(error.output.length, MAX_CODE_EXEC_OUTPUT);
      assert.equal(error.outputBytes, MAX_CODE_EXEC_OUTPUT);
      assert.equal(error.truncated, true);
      return true;
    });
  }
}
console.log("output ok: exact ceiling succeeds; overflow retains bounded prefix and explicit error");

for (const timeoutMs of [100, 1000]) {
  let stopped = false;
  const exec: CodeExec = async (_command, _cwd, { signal, onData }) => {
    onData(Buffer.from("early stdout\nearly stderr\n"));
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => {
      stopped = true;
      // Simulate backend process-tree/stream teardown latency.
      setTimeout(resolve, 20);
    }, { once: true }));
    throw new Error("aborted");
  };
  await assert.rejects(execCode(exec, { ...input, timeoutMs }, "/workspace", signal), (error: any) => {
    assert.equal(error.code, "ETIMEDOUT");
    assert.equal(error.timeoutMs, timeoutMs);
    assert.ok(error.durationMs >= timeoutMs - 5 && error.durationMs < timeoutMs + 1000);
    assert.equal(error.output, "early stdout\nearly stderr\n");
    assert.equal(stopped, true, "cancellation settled before return");
    return true;
  });
}
console.log("timeout ok: millisecond deadline, actual duration, partial output, awaited cancellation");

// Structured failures survive both crossings, not just direct helper tests.
const bridged = await runCodeMode({
  source: 'try { await cube.exec("unused"); } catch (e) { return { code:e.code, output:e.output, durationMs:e.durationMs }; }',
  call: async () => execCode(async (_command, _cwd, { onData, signal }) => {
    onData(Buffer.from("partial"));
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    throw new Error("aborted");
  }, { ...input, timeoutMs: 20 }, "/workspace", signal),
});
assert.equal((bridged.value as any).code, "ETIMEDOUT");
assert.equal((bridged.value as any).output, "partial");

// Caller cancellation must also preserve the first exec's bounded output,
// even though the guest worker is stopped before the backend finishes draining.
{
  const controller = new AbortController();
  const pending = runCodeMode({
    source: 'return await cube.exec("unused");', signal: controller.signal,
    call: async (_operation, _args, hostSignal) => execCode(async (_command, _cwd, { onData, signal }) => {
      onData(Buffer.from("before cancellation\0😀"));
      setTimeout(() => controller.abort(new Error("caller stopped")), 10);
      await new Promise<void>(resolve => signal.addEventListener("abort", () => setTimeout(resolve, 10), { once: true }));
      throw new Error("aborted");
    }, input, "/workspace", hostSignal),
  });
  await assert.rejects(pending, (error: any) => error.code === "ABORT_ERR" &&
    error.message === "caller stopped" && error.output === "before cancellation\0😀");
}

for (const operation of ["fs.readText", "fs.writeText"] as const) {
  await assert.rejects(codeFile(operation, "missing/file", async () => {
    throw Object.assign(new Error("incus: Not Found (404)"), { errorCode: 404 });
  }), (error: any) => error.code === "ENOENT" && error.operation === operation && error.path === "missing/file");
}
await assert.rejects(codeFile("fs.readText", "private", async () => {
  throw Object.assign(new Error("permission denied"), { code: "EACCES" });
}), (error: any) => error.code === "EACCES");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "cube-code-io-"));
try {
  const sandbox = new MockSandbox("code-io", "/workspace", root);
  const exec: CodeExec = (command, cwd, options) => sandbox.exec(command, { cwd, ...options });
  await assert.rejects(execCode(exec, {
    command: "printf stdout; printf stderr >&2; sleep 0.4; printf should-not-run > late.txt",
    cwd: undefined, timeoutMs: 100,
  }, "/workspace", signal), (error: any) => {
    assert.equal(error.code, "ETIMEDOUT");
    assert.match(error.output, /stdout/);
    assert.match(error.output, /stderr/);
    return true;
  });
  await new Promise(resolve => setTimeout(resolve, 450));
  await assert.rejects(fs.access(path.join(root, "late.txt")), { code: "ENOENT" });
  const after = await execCode(exec, { ...input, command: "printf alive; exit 7" }, "/workspace", signal);
  assert.equal(after.output, "alive");
  assert.equal(after.exitCode, 7);
  const filename = path.join(root, "unicode.txt");
  const text = "æøå😀\u0000";
  await codeFile("fs.writeText", filename, () => fs.writeFile(filename, text));
  assert.equal(await codeFile("fs.readText", filename, () => fs.readFile(filename, "utf8")), text);
  await assert.rejects(codeFile("fs.writeText", "missing/file", () => fs.writeFile(path.join(root, "missing/file"), text)), { code: "ENOENT" });
} finally { await fs.rm(root, { recursive: true, force: true }); }
console.log("files/process ok: no delayed write, subsequent exec succeeds, Unicode/NUL intact, ENOENT contextualized");
console.log("ALL PASS");
