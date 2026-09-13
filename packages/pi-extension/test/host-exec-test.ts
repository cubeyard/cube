/** No native or subprocess needed: prove one-submit semantics at the additional
 * HTTP boundary and preserve inspection IDs through codemode's error envelope. */
import assert from "node:assert/strict";
import { createThreadRequest } from "../src/index.ts";
import { HostExecSandbox, unsupportedHostFiles } from "../src/host-exec.ts";
import { execCode } from "../src/code-io.ts";
import { encodeError } from "../src/code-errors.ts";
import { createCodeCapability } from "../src/code-capabilities.ts";

const operationId = "op-saved-before-dispatch";
let calls: Record<string, unknown>[] = [];
let mode = "ok";
const host = new HostExecSandbox(async body => {
  calls.push(body);
  if (body.action === "prepare") {
    assert.deepEqual(body.spec, { command: "test", guestCwd: "sub", timeoutMs: 60000, outputLimit: 8192 });
    if (mode === "prepare-loss") throw Object.assign(new Error("lost response"), { completionUnknown: true });
    return { operationId };
  }
  if (body.action === "submit") {
    if (mode === "submit-loss") throw Object.assign(new Error("lost response"), { completionUnknown: true });
    if (mode === "rejected") throw Object.assign(new Error("offline"), { code: "NODE_UNAVAILABLE" });
    return { operationId };
  }
  if (mode === "poll-loss") throw Object.assign(new Error("read failed"), { completionUnknown: true });
  if (mode === "unknown") return { state: "Unknown" };
  if (mode === "interrupted") return { state: "Interrupted", completionUnknown: true };
  if (mode === "failed") return { state: "Failed", error: "IO_ERROR", completionUnknown: false };
  return { state: "Succeeded", result: { exitCode: 0, termination: "exited", output: [111, 107], truncated: false } };
});
let output = "";
const options = { cwd: "/workspace/sub", onData: (chunk: Buffer) => { output += chunk; } };
assert.deepEqual(await host.exec("test", options), { exitCode: 0, operationId });
assert.equal(output, "ok");
for (const failure of ["prepare-loss", "submit-loss", "poll-loss", "unknown", "interrupted", "rejected", "failed"]) {
  calls = []; mode = failure;
  await assert.rejects(execCode((command, cwd, options) => host.exec(command, { cwd, ...options }),
    { command: "test", cwd: options.cwd, timeoutMs: 2000 }, "/workspace", new AbortController().signal), error => {
      const encoded = encodeError(error);
      const unknown = ["submit-loss", "poll-loss", "unknown", "interrupted"].includes(failure);
      assert.equal(encoded.completionUnknown === true, unknown);
      assert.equal(encoded.operationId, failure === "prepare-loss" ? undefined : operationId);
      return true;
    });
  assert.equal(calls.filter(row => row.action === "submit").length, failure === "prepare-loss" ? 0 : 1);
}
calls = []; mode = "ok";
for (const cwd of ["/etc", "/workspace/../../etc", "/workspace-other"]) await assert.rejects(host.exec("test", { ...options, cwd }), { code: "OPERATION_UNSUPPORTED" });
await assert.rejects(host.exec("test", { ...options, timeout: 61 }), { code: "INVALID_REQUEST" });
await assert.rejects(host.operation("../escape"), { code: "INVALID_REQUEST" });
await assert.rejects(unsupportedHostFiles(), { code: "OPERATION_UNSUPPORTED" });
assert.equal(calls.length, 0);
mode = "poll-loss";
await assert.rejects(host.operation(operationId), { code: "NODE_UNAVAILABLE" });
// The allowlist cannot smuggle a destination or thread into the new capability.
const capability = createCodeCapability({ operation: async (id: string) => ({ id }) } as any);
await assert.rejects(capability("operations.get", { operationId, nodeId: "other" }, new AbortController().signal), /unknown/);
assert.deepEqual(await capability("operations.get", { operationId }, new AbortController().signal), { id: operationId });
console.log("ok: host HTTP failure cuts, no replay/fallback, read-only recovery and operation IDs across codemode");

const fetchBefore = globalThis.fetch;
try {
  globalThis.fetch = async () => new Response(JSON.stringify({ code: "COMPLETION_UNKNOWN", completionUnknown: true,
    operationId, error: "inspect saved operation" }), { status: 503 });
  await assert.rejects(createThreadRequest({ threadId: "test", cubedUrl: "http://unused.invalid" })("/host-exec", {
    method: "POST", body: { action: "submit", operationId },
  }), error => encodeError(error).operationId === operationId && encodeError(error).completionUnknown === true);
} finally { globalThis.fetch = fetchBefore; }
