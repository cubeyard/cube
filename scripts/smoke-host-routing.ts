/** Real cubed HTTP and registered pi tools against the smoke's disposable Rust
 * host. No model call, shared registry, or live user thread is used. */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { Registry } from "../packages/server/src/registry.ts";
import cubeExtension from "../packages/pi-extension/src/index.ts";

export async function smokeHostRouting(root: string, configPath: string, workspace: string, node: { disconnect(): Promise<void>; reconnect(): Promise<void> }) {
  const database = path.join(root, "routing.db");
  const cubesRoot = path.join(root, "control-cubes");
  const registry = new Registry(database);
  registry.createProject({ id: "routing", name: "disposable", repositories: [] });
  registry.close();
  const env = { PATH: process.env.PATH, HOME: root, PI_OFFLINE: "1" };
  const enrolled = JSON.parse(execFileSync(process.execPath, ["scripts/enroll-host-node.ts", "--database", database,
    "--project", "routing", "--config", configPath, "--cubes-root", cubesRoot, "--trusted-host", "--server-stopped"],
  { env, encoding: "utf8", timeout: 20000 }));
  assert.equal(enrolled.threadId, "thread-test");
  const socket = net.createServer();
  await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
  const port = (socket.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => socket.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  let daemon: ChildProcess | undefined;
  let logs = "";
  const stop = async () => {
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      const closed = once(daemon, "close"); daemon.kill("SIGKILL"); await closed;
    }
  };
  const start = async () => {
    daemon = spawn(process.execPath, ["--input-type=module", "-e", `
      import { MockBackend } from '@cube/sandbox';
      for (const method of ['sandbox','getState','setState','provision','destroy','execSimple','waitForNetwork']) {
        MockBackend.prototype[method] = () => { throw new Error('FORBIDDEN_LOCAL_BACKEND:' + method); };
      }
      await import('./src/index.ts');
    `], { cwd: path.resolve("packages/server"), stdio: ["ignore", "pipe", "pipe"], env: { ...env,
      CUBED_BACKEND: "mock", CUBED_DB: database, CUBED_CUBES_ROOT: cubesRoot, CUBED_REPOS_ROOT: path.join(root, "mirrors"),
      CUBED_PORT: String(port), CUBED_IDLE_MS: "0", CUBED_ENVIRONMENT_CACHE: "0" } });
    daemon.stdout!.on("data", data => { logs = (logs + data).slice(-16000); });
    daemon.stderr!.on("data", data => { logs = (logs + data).slice(-16000); });
    for (let n = 0; ; n++) {
      try { if ((await fetch(`${base}/api/threads`, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* bounded boot wait */ }
      assert.ok(n < 100 && daemon.exitCode === null, `cubed startup failed: ${logs}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  const settings = { CUBE_BACKEND: "host", CUBE_THREAD_ID: enrolled.threadId, CUBE_NODE_ID: enrolled.nodeId,
    CUBE_NAME: enrolled.name, CUBE_HOST_WORKSPACE: path.join(cubesRoot, enrolled.name, "workspace"),
    CUBE_GUEST_WORKSPACE: "/workspace", CUBED_URL: base };
  const saved = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  try {
    await start();
    Object.assign(process.env, settings);
    const tools = new Map<string, any>();
    const events = new Map<string, (...args: any[]) => any>();
    cubeExtension({ registerTool: (tool: any) => tools.set(tool.name, tool),
      on: (name: string, handler: (...args: any[]) => any) => events.set(name, handler), registerCommand() {} } as any);
    const text = (result: any) => result.content.map((row: any) => row.text ?? "").join("\n");
    const code = (source: string, signal?: AbortSignal) => tools.get("code").execute("routing", { source }, signal);
    const executed = await code('return await cube.exec("printf once >> routed-count; printf routed", {timeoutMs: 2000});');
    assert.notEqual(executed.isError, true, text(executed));
    const result = JSON.parse(text(executed).split("\n\n").slice(1).join("\n\n"));
    assert.equal(result.output, "routed");
    assert.match(result.operationId, /^op-/);
    assert.equal(fs.readFileSync(path.join(workspace, "routed-count"), "utf8"), "once");
    assert.ok(!fs.existsSync(settings.CUBE_HOST_WORKSPACE), "no local shadow workspace");
    await node.disconnect();
    const offline = await code('return await cube.exec("touch must-not-fallback");');
    assert.equal(offline.details.error.code, "NODE_UNAVAILABLE", text(offline));
    assert.equal((await fetch(`${base}/api/threads`)).status, 200, "conversation metadata stays available offline");
    await node.reconnect();
    const observed = await code(`return await cube.operations.get(${JSON.stringify(result.operationId)});`);
    assert.match(text(observed), /Succeeded/);
    assert.ok(!fs.existsSync(path.join(workspace, "must-not-fallback")));
    assert.equal(fs.readFileSync(path.join(workspace, "routed-count"), "utf8"), "once");
    const bash = await tools.get("bash").execute("routing-bash", { command: "printf bash-routed" });
    assert.match(text(bash), /bash-routed/);
    const user = await events.get("user_bash")!({});
    let userOutput = "";
    await user.operations.exec("printf user-routed", "/workspace", { onData: (chunk: Buffer) => { userOutput += chunk; } });
    assert.equal(userOutput, "user-routed");
    const read = await code('return await cube.fs.readText("missing");');
    assert.equal(read.details.error.code, "OPERATION_UNSUPPORTED");
    const signalled = await code('return await cube.exec("kill -TERM $$", {timeoutMs: 2000});');
    assert.equal(signalled.details.error.code, "ESIGNALLED", text(signalled));
    assert.match(signalled.details.error.operationId, /^op-/);
    const overflow = await code('return await cube.exec("head -c 9000 /dev/zero", {timeoutMs: 2000});');
    assert.match(text(overflow), /output truncated at 8192 bytes/);
    const controller = new AbortController();
    const marker = path.join(workspace, "routed-cancel");
    const watcher = setInterval(() => { if (fs.existsSync(marker)) controller.abort(); }, 10);
    let cancelled;
    try { cancelled = await code('return await cube.exec("printf once >> routed-cancel; sleep .4", {timeoutMs: 3000});', controller.signal); }
    finally { clearInterval(watcher); }
    assert.equal(cancelled.details.error.completionUnknown, true, text(cancelled));
    const operationId = cancelled.details.error.operationId;
    assert.match(operationId, /^op-/);
    await new Promise(resolve => setTimeout(resolve, 600));
    await stop(); await start();
    const recovered = await code(`return await cube.operations.get(${JSON.stringify(operationId)});`);
    assert.match(text(recovered), /Succeeded/);
    assert.equal(fs.readFileSync(marker, "utf8"), "once");
    const submit = await fetch(`${base}/api/threads/thread-test/host-exec`, { method: "POST", body: JSON.stringify({ action: "submit", operationId }) });
    const rejected = await submit.json() as Record<string, unknown>;
    assert.equal(rejected.code, "COMPLETION_UNKNOWN");
    assert.equal(rejected.operationId, operationId, "HTTP errors preserve inspection identity");
    const invalid = await fetch(`${base}/api/threads/thread-test/host-exec`, { method: "POST", body: JSON.stringify({ action: "status", address: "203.0.113.1:443" }) });
    assert.equal((await invalid.json() as Record<string, unknown>).code, "INVALID_REQUEST");
    const original = fs.readFileSync(configPath);
    try {
      fs.appendFileSync(configPath, "\n");
      await stop(); await start();
      const pinned = await code('return await cube.exec("touch must-not-route");');
      assert.equal(pinned.details.error.code, "CONFLICT", text(pinned));
      assert.ok(!fs.existsSync(path.join(workspace, "must-not-route")));
    } finally { fs.writeFileSync(configPath, original); }
    await stop(); await start();
    assert.equal((await fetch(`${base}/api/threads/thread-test/archive`, { method: "POST" })).status, 200);
    const archived = await code('return await cube.exec("touch must-not-archive");');
    assert.equal(archived.details.error.code, "OPERATION_UNSUPPORTED", text(archived));
    assert.match(text(await code(`return await cube.operations.get(${JSON.stringify(operationId)});`)), /Succeeded/);
    assert.ok(!fs.existsSync(path.join(workspace, "must-not-archive")));
    assert.doesNotMatch(logs, /FORBIDDEN_LOCAL_BACKEND/);
    console.log("ok: operator enrollment, real cubed HTTP, registered pi bash/code/! tools, cancellation identity, restart inspection and pinned admission");
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await stop();
  }
}
