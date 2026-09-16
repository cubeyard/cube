/** Actual registered tools, user ! and Monty, without credentials/models. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { once } from "node:events";
import cubeExtension from "../src/index.ts";
import { createLocalEnvironmentAccess } from "../src/environment-access.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-access-test-"));
const workspace = path.join(tmp, "absent-workspace");
let disconnected = true;
const calls: string[] = [];
const server = http.createServer((req, res) => {
  calls.push(`${req.method} ${req.url}`);
  res.setHeader("content-type", "application/json");
  if (req.url?.endsWith("/environment-access")) {
    res.statusCode = disconnected ? 503 : 200;
    return res.end(JSON.stringify(disconnected ? { code: "NODE_UNAVAILABLE", error: "environment unavailable" } : { nodeId: "node-test", local: true }));
  }
  if (req.url?.endsWith("/environment")) return res.end('{"setup":{"log":"recorded evidence"}}');
  if (req.url?.endsWith("/wake")) return res.end('{"ok":true}');
  res.statusCode = 404; res.end('{}');
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const settings = {
  CUBE_NAME: "test", CUBE_THREAD_ID: "thread", CUBE_NODE_ID: "node-test", CUBE_HOST_WORKSPACE: workspace,
  CUBE_BACKEND: "mock", CUBE_AGENT_CWD: tmp, CUBED_URL: url,
};
const saved = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
try {
  Object.assign(process.env, settings);
  const tools = new Map<string, any>();
  const events = new Map<string, any>();
  cubeExtension({ registerTool: (tool: any) => tools.set(tool.name, tool), on: (event: string, handler: any) => events.set(event, handler), registerCommand() {} } as any);
  for (const [name, input] of [
    ["bash", { command: "touch must-not-exist" }],
    ["write", { path: "file", content: "must not be written" }],
    ["read", { path: "file" }],
    ["ls", { path: "." }],
    ["find", { pattern: "**/*" }],
    ["edit", { path: "file", edits: [{ oldText: "x", newText: "y" }] }],
  ] as const) {
    await assert.rejects(() => tools.get(name).execute("test", input), /NODE_UNAVAILABLE/);
  }
  const bang = await events.get("user_bash")({ command: "touch must-not-exist", cwd: tmp }, {});
  await assert.rejects(() => bang.operations.exec("touch must-not-exist", tmp, { onData() {}, signal: new AbortController().signal }), /NODE_UNAVAILABLE/);
  for (const source of [
    'return await cube.exec("touch must-not-exist")',
    'from pathlib import Path\nreturn Path("file").write_text("no")',
    'from pathlib import Path\nreturn Path("file").read_text()',
  ]) {
    const result = await tools.get("code").execute("test", { source });
    assert.equal(result.isError, true);
    assert.equal(result.details.error.code, "NODE_UNAVAILABLE");
  }
  assert.equal(fs.existsSync(workspace), false, "neither pi cwd nor missing workspace becomes a local fallback");
  assert.equal(fs.existsSync(path.join(tmp, "must-not-exist")), false);
  assert.ok(calls.every(call => call.endsWith("/environment-access")), "no rejected action reached wake or another bridge operation");
  const evidence = await tools.get("code").execute("test", { source: "return await cube.environment.status();" });
  assert.ok(!evidence.isError, "control-plane lifecycle evidence remains available");
  assert.match(JSON.stringify(evidence), /recorded evidence/);
  const count = calls.length;
  disconnected = false;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls.length, count, "reconnect itself does not replay any action");
  fs.mkdirSync(workspace);
  const result = await tools.get("code").execute("test", { source: 'return await cube.exec("printf explicit-request");' });
  assert.ok(!result.isError, JSON.stringify(result));
  assert.match(JSON.stringify(result), /explicit-request/);
  let bangOutput = "";
  await bang.operations.exec("pwd", tmp, { onData: (chunk: Buffer) => { bangOutput += chunk.toString(); }, signal: new AbortController().signal });
  assert.equal(bangOutput.trim(), workspace, "user ! cwd maps to the guest workspace, not pi runtime");
  assert.equal(fs.existsSync(path.join(workspace, "must-not-exist")), false);
  // The injected transport gate checks before dispatch and preserves ambiguity
  // after dispatch. There is exactly one execution, never a retry loop.
  const access = createLocalEnvironmentAccess({ nodeId: "node-test", threadId: "thread", cubedUrl: url });
  let executions = 0;
  await assert.rejects(access.run(true, async () => {
    executions++; throw Object.assign(new Error("reply lost"), { code: "ECONNRESET" });
  }), (error: any) => error.code === "COMPLETION_UNKNOWN" && error.completionUnknown);
  await access.check();
  assert.equal(executions, 1);
  const mismatch = createLocalEnvironmentAccess({ nodeId: "node-other", threadId: "thread", cubedUrl: url });
  await assert.rejects(mismatch.run(true, async () => { executions++; }), /binding mismatch/);
  assert.equal(executions, 1, "unknown binding never chooses the local adapter");
  console.log("PASS: offline file/bash/!/Monty gates, control evidence, no replay, binding validation and uncertain outcomes");
} finally {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
}
