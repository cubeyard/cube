import { smokeDurableAgent } from "./smoke-durable-agent.ts";
import { smokeProduct } from "./smoke-product.ts";
/** Real TypeScript -> @number0/iroh (in process) -> Rust runner acceptance.
 * Disposable keys, journals, workspaces and processes only. No existing host
 * or model service is contacted. Loopback/direct stay offline; CUBE_TEST_IROH_RELAY=1
 * adds an external N0 discovery/relay acceptance pass. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { IrohExecutionNodeClient, IrohNodeError, type RunnerExecSpec } from "../packages/server/src/iroh-node.ts";
import { Registry } from "../packages/server/src/registry.ts";

const binary = path.resolve(process.argv[2] ?? "target/debug/cube-runner");
assert.ok(fs.existsSync(binary), "build cube-runner first; no simulated success or automatic cargo build");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-real-node-adapter-"));
const children = new Set<ChildProcess>();
const cli = (args: string[], input?: string): string => execFileSync(binary, args, { encoding: "utf8", input, timeout: 30000, maxBuffer: 65537, env: { PATH: "/usr/bin:/bin" } });
const git = (cwd: string, args: string[]): string => execFileSync("git", ["-c", "user.name=Cube Test", "-c", "user.email=cube@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args],
  { encoding: "utf8", timeout: 30000, env: { PATH: process.env.PATH } }).trim();
const code = (expected: string, unknown = false) => (error: unknown) => error instanceof IrohNodeError && error.code === expected && error.completionUnknown === unknown;
async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    const closed = once(child, "close");
    child.kill("SIGKILL");
    await closed;
  }
  children.delete(child);
}
async function start(key: string, state: string, network: string, listen = "127.0.0.1:0"): Promise<{ child: ChildProcess; address?: string; relayUrl?: string }> {
  const args = ["runner-serve", "--key", key, "--state", state, "--network", network];
  if (network !== "relay") args.push("--listen", listen);
  const child = spawn(binary, args, { env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  const ready = await new Promise<{ addresses: string[]; relayUrl?: string }>((resolve, reject) => {
    let output = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("node ready timeout")); }, network === "relay" ? 30000 : 10000);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("exit", () => { clearTimeout(timer); reject(new Error(`node exited before ready: ${stderr}`)); });
    child.stderr!.on("data", (data: Buffer) => { stderr = (stderr + data.toString()).slice(-2048); });
    child.stdout!.on("data", (data: Buffer) => {
      output += data.toString();
      if (output.length > 8192) { child.kill("SIGKILL"); clearTimeout(timer); reject(new Error("oversized ready response")); return; }
      const end = output.indexOf("\n");
      if (end !== -1) { clearTimeout(timer); try { resolve(JSON.parse(output.slice(0, end))); } catch (error) { reject(error); } }
    });
  });
  if (network === "relay") assert.match(ready.relayUrl ?? "", /^https:\/\//);
  else assert.equal(ready.addresses.length, 1);
  return { child, address: ready.addresses[0], relayUrl: ready.relayUrl };
}
try {
  const networks = process.env.CUBE_TEST_IROH_RELAY === "1" ? ["loopback", "direct", "relay"] : ["loopback", "direct"];
  for (const network of networks) {
    const directory = path.join(root, network);
    fs.mkdirSync(directory, { mode: 0o700 });
    const workspace = path.join(directory, "workspace");
    const intents = path.join(directory, "intents");
    fs.mkdirSync(workspace);
    fs.mkdirSync(intents, { mode: 0o700 });
    git(workspace, ["init", "-q", "--initial-branch=develop"]);
    fs.writeFileSync(path.join(workspace, "remote-base"), "fresh base\n");
    git(workspace, ["add", "remote-base"]);
    git(workspace, ["commit", "-qm", "remote base"]);
    const remote = path.join(directory, "remote.git");
    git(workspace, ["clone", "--bare", ".", remote]);
    git(workspace, ["remote", "add", "origin", remote]);
    const key = path.join(directory, "node.key");
    const controlKey = path.join(directory, "control.key");
    const serverPeer: string = JSON.parse(cli(["keygen", "--key", key])).peerId;
    const controlPeer: string = JSON.parse(cli(["keygen", "--key", controlKey])).peerId;
    const state = path.join(directory, "state");
    cli(["runner-init", "--key", key, "--state", state, "--workspace", workspace, "--allow-peer", controlPeer, "--node-id", "node-test", "--thread-id", "thread-test", "--env", "17"]);
    let daemon = await start(key, state, network);
    const config = { version: 1, binding: { nodeId: "node-test", threadId: "thread-test", environmentId: 17 }, controlKey, serverPeer,
      ...(network === "relay" ? {} : { address: daemon.address }), network, intentDirectory: intents };
    const configPath = path.join(directory, "control.json");
    const original = JSON.stringify(config);
    fs.writeFileSync(configPath, original, { mode: 0o600 });
    const observations: unknown[] = [];
    const client = new IrohExecutionNodeClient({ configPath, observe: (environmentId, observation) => observations.push({ environmentId, observation }) });
    assert.equal(client.contact, "unobserved");
    await client.check(17);
    assert.equal(client.contact, "available");
    assert.equal((await client.status(17)).status, "Running");
    const spec: RunnerExecSpec = { command: "printf once >> count; printf hello", guestCwd: ".", timeoutMs: 1000, outputLimit: 100 };
    const result = await client.exec(17, spec);
    assert.equal(Buffer.from(result.output).toString(), "hello");
    assert.equal(result.exitCode, 0);
    assert.equal(fs.readFileSync(path.join(workspace, "count"), "utf8"), "once");
    await assert.rejects(client.submitExec(17, result.operationId), code("COMPLETION_UNKNOWN", true));
    assert.equal((await client.operation(17, result.operationId)).state, "Succeeded");
    const bad = await client.prepareExec(17, { ...spec, guestCwd: ".." });
    await assert.rejects(client.submitExec(17, bad.operationId), code("INVALID_REQUEST"));
    assert.equal((await client.operation(17, bad.operationId)).state, "Unknown");

    // Pi identities are stable across caller loss, but scoped to the Session.
    const piSpec = { ...spec, command: "printf once >> pi-count; sleep 0.4; printf 74" };
    const lost = new AbortController();
    const piWatcher = setInterval(() => {
      if (fs.existsSync(path.join(workspace, "pi-count"))) lost.abort();
    }, 10);
    try { await assert.rejects(client.resumeExec("session-a", "invocation-a", piSpec, lost.signal)); }
    finally { clearInterval(piWatcher); }
    const piResult = await new IrohExecutionNodeClient({ configPath }).resumeExec("session-a", "invocation-a", piSpec);
    assert.equal(Buffer.from(piResult.output).toString(), "74");
    assert.equal(fs.readFileSync(path.join(workspace, "pi-count"), "utf8"), "once");
    const again = await client.resumeExec("session-a", "invocation-a", piSpec);
    assert.equal(again.operationId, piResult.operationId);
    await assert.rejects(client.resumeExec("session-a", "invocation-a", { ...piSpec, command: "touch must-not-run" }), code("CONFLICT"));
    const separate = await client.resumeExec("session-b", "invocation-a", { ...spec, command: "printf separate" });
    assert.notEqual(separate.operationId, piResult.operationId);
    assert.ok(!fs.existsSync(path.join(workspace, "must-not-run")));

    // Aborting a caller after the actual runner command starts cannot cancel or
    // replay its side effects. The saved operation remains inspectable.
    const controller = new AbortController();
    const startedFile = path.join(workspace, "cancel-count");
    const watcher = setInterval(() => { if (fs.existsSync(startedFile)) controller.abort(); }, 10);
    let interruptedId: string | undefined;
    try {
      await assert.rejects(client.exec(17, { ...spec, command: "printf once >> cancel-count; sleep 0.4; printf recovered" }, controller.signal), error => {
        if (!(error instanceof IrohNodeError) || !error.completionUnknown) return false;
        interruptedId = error.operationId;
        return !!interruptedId;
      });
    } finally { clearInterval(watcher); }
    assert.ok(interruptedId);
    let recovered;
    for (let attempt = 0; attempt < 30; attempt++) {
      recovered = await client.operation(17, interruptedId);
      if (recovered.state === "Succeeded") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(recovered?.state, "Succeeded");
    assert.equal(fs.readFileSync(startedFile, "utf8"), "once");
    await assert.rejects(client.submitExec(17, interruptedId), code("COMPLETION_UNKNOWN", true));

    // Same peer/node/environment but wrong thread: deny before any command bytes.
    const wrongConfigPath = path.join(directory, "wrong-thread.json");
    fs.writeFileSync(wrongConfigPath, JSON.stringify({ ...config, binding: { ...config.binding, threadId: "other-thread" } }), { mode: 0o600 });
    const wrong = new IrohExecutionNodeClient({ configPath: wrongConfigPath });
    const denied = await wrong.prepareExec(17, { ...spec, command: "touch must-not-run" });
    await assert.rejects(wrong.submitExec(17, denied.operationId), code("WRONG_NODE"));
    await assert.rejects(client.operation(17, denied.operationId), code("WRONG_NODE"));
    assert.ok(!fs.existsSync(path.join(workspace, "must-not-run")));

    // Config is operator-owned, not an RPC override. Once loaded its exact bytes
    // are pinned, including the destination key/address and intent directory.
    fs.writeFileSync(configPath, JSON.stringify({ ...config, serverPeer: "b".repeat(64) }));
    await assert.rejects(client.status(17), code("CONFLICT"));
    assert.equal(observations.length, 1);
    fs.writeFileSync(configPath, original);
    await assert.rejects(client.prepareExec(17, { ...spec, address: "203.0.113.1:443" } as RunnerExecSpec), code("INVALID_REQUEST"));
    const restartedClient = new IrohExecutionNodeClient({ configPath });
    await assert.rejects(restartedClient.submitExec(17, result.operationId), code("COMPLETION_UNKNOWN", true));
    assert.equal((await restartedClient.operation(17, result.operationId)).state, "Succeeded");
    // The independent Rust diagnostic CLI can read the same saved intent. It
    // is not part of the control-plane call path and never submits this job.
    const diagnosticArgs = ["operation", "--key", controlKey, "--intent", path.join(intents, `${result.operationId}.json`), "--network", network];
    if (network !== "relay") diagnosticArgs.push("--address", daemon.address!);
    const inspected = JSON.parse(cli(diagnosticArgs));
    assert.equal(inspected.operation.state, "Succeeded");

    // Result retrieval does not require the workspace to still exist. Binding
    // verification happens in authenticated hello, not filesystem inspect.
    fs.renameSync(workspace, path.join(directory, "old-workspace"));
    await assert.rejects(client.status(17), code("ENVIRONMENT_MISSING"));
    assert.equal((await client.operation(17, result.operationId)).state, "Succeeded");
    fs.renameSync(path.join(directory, "old-workspace"), workspace);
    const lastObservation = structuredClone(observations);
    await stop(daemon.child);
    await assert.rejects(client.status(17), code("NODE_UNAVAILABLE"));
    assert.equal(client.contact, "unavailable");
    assert.deepEqual(observations, lastObservation);
    daemon = await start(key, state, network, daemon.address);
    assert.equal((await client.operation(17, result.operationId)).state, "Succeeded");
    assert.equal((await client.status(17)).status, "Running");
    assert.equal(fs.readFileSync(path.join(workspace, "count"), "utf8"), "once");
    if (network === "loopback") {
      const hostState = path.join(directory, "status-host");
      const registry = new Registry(path.join(hostState, "registry.sqlite"));
      registry.saveProject({ id: "status", name: "status", status: "ready", error: null, revision: 1,
        checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
      registry.enrollRunner({ ...client.binding, configPath, configHash: client.configHash });
      registry.close();
      const statusOutput = execFileSync(process.execPath,
        [path.resolve("packages/server/src/index.ts"), "runners", "status", "--state", hostState],
        { encoding: "utf8", timeout: 15000, env: { PATH: process.env.PATH } });
      assert.match(statusOutput, /node-test: reachable; lifecycle=ready; active=false/);
    }
    if (network === "loopback") await smokeDurableAgent(directory, configPath, workspace);
    if (network === "loopback") await smokeProduct(directory, configPath);
    await stop(daemon.child);
    console.log(`ok: ${network} mode, real TS/native/iroh/exec, exact binding, durable intent, rejection, config pinning, offline observations and restart`);
  }
} finally {
  await Promise.all([...children].map(stop));
  fs.rmSync(root, { recursive: true, force: true });
}
