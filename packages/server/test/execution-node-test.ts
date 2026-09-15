/** Disposable local-only boundary tests. No Incus socket or model calls. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { execFileSync } from "node:child_process";
import { MockBackend } from "@cube/sandbox";
import { IncusHttpError } from "../../sandbox/src/incus-client.ts";
import { Registry } from "../src/registry.ts";
import { CubeSupervisor, type SupervisorConfig } from "../src/supervisor.ts";
import { ExecutionNodeError, ExecutionNodes, LocalExecutionNodeClient } from "../src/execution-node.ts";
import { PiTerminals, type TerminalClient } from "../src/pty.ts";
import { proxyHttp, proxyUpgrade, respondUnavailable } from "../src/portal-proxy.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-node-test-"));
const dbPath = path.join(tmp, "registry.db");
const config: SupervisorConfig = {
  cubesRoot: path.join(tmp, "cubes"), reposRoot: path.join(tmp, "repos"),
  pool: "mock", image: "mock", rootSize: "1GiB", dockerVolumeSize: "1GiB",
  idleMs: 0, portalBase: "cube.internal", publicPort: 7777, egressAllow: [], environmentCache: false,
};
let registry = new Registry(dbPath);
registry.createProject({ id: "project", name: "test", repositories: [] });
const workspace = path.join(config.cubesRoot, "legacy", "workspace");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(path.join(workspace, "marker"), "untouched");
const sessionPath = path.join(config.cubesRoot, "legacy", "sessions", "legacy.jsonl");
fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
const sessionBytes = JSON.stringify({ type: "session", version: 3, id: "12345678-1234-4234-8234-123456789abc", timestamp: new Date().toISOString(), cwd: workspace }) + "\n";
fs.writeFileSync(sessionPath, sessionBytes);
const environment = registry.createCube({ name: "legacy", workspacePath: workspace, image: "mock" });
registry.addThread({ id: "legacy", cubeId: environment.id, projectId: "project", piSessionPath: sessionPath });
registry.setCubeStatus("legacy", "ready");
const before = { cube: registry.getCube("legacy"), thread: registry.getThread("legacy") };
registry.close();
// Reconstruct the pre-node schema, keeping the actual old rows and bytes.
const old = new DatabaseSync(dbPath);
for (const row of old.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]) old.exec(`DROP TRIGGER ${row.name}`);
old.exec("DROP TABLE environment_node; DROP TABLE environment_observation; DROP TABLE thread_create_request; DROP TABLE execution_node");
old.close();
registry = new Registry(dbPath);
const nodeId = registry.localNodeId;
assert.equal(registry.nodeForCube(environment.id), nodeId);
registry.close();
registry = new Registry(dbPath);
assert.equal(registry.localNodeId, nodeId);
assert.deepEqual({ cube: registry.getCube("legacy"), thread: registry.getThread("legacy") }, before);
assert.equal(fs.readFileSync(sessionPath, "utf8"), sessionBytes);
assert.equal(fs.readFileSync(path.join(workspace, "marker"), "utf8"), "untouched");
const raw = new DatabaseSync(dbPath);
raw.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON");
assert.throws(() => raw.exec(`UPDATE environment_node SET node_id='other'`), /immutable/);
assert.throws(() => raw.exec(`UPDATE thread SET cube_id=999`), /immutable/);
assert.throws(() => raw.exec(`UPDATE cube SET name='replacement'`), /immutable/);
assert.throws(() => raw.exec(`DELETE FROM environment_node`), /permanent/);
assert.throws(() => registry.addThread({ id: "second", cubeId: environment.id, projectId: "project", piSessionPath: "/unused" }), /UNIQUE/);
const count = registry.listCubes().length;
assert.throws(() => registry.allocateThread({ cube: { name: "rollback", image: "mock", workspacePath: "/unused" }, repositories: [], thread: { id: "legacy", projectId: "project", piSessionPath: "/unused" } }), /UNIQUE/);
assert.equal(registry.listCubes().length, count, "allocation rolls back the binding too");
raw.close();
console.log("1 ok: repeated legacy migration, byte preservation, immutable and unique bindings, atomic allocation");

/** Explicit test-only disconnect switch; all actual backend effects recorded. */
class RecordingBackend extends MockBackend {
  disconnected = false;
  loseReply = false;
  missing = false;
  effects: string[] = [];
  probes = 0;
  override async getState(_name: string) {
    this.probes++;
    if (this.disconnected) throw Object.assign(new Error("test disconnect"), { code: "ECONNRESET" });
    if (this.missing) throw new IncusHttpError(404, "gone");
    return { status: "Running" };
  }
  override async setState(_name: string) {
    this.effects.push("setState");
    if (this.loseReply) { this.disconnected = true; throw Object.assign(new Error("reply lost"), { code: "ECONNRESET" }); }
  }
  override async destroy() { this.effects.push("destroy"); }
  override async provision() { this.effects.push("provision"); throw new Error("test provision failure"); }
}
const backend = new RecordingBackend();
const local = new LocalExecutionNodeClient(registry, backend);
const supervisor = new CubeSupervisor(registry, backend, config, [local]);
assert.equal(local.contact, "unobserved");
await local.status(environment.id);
const observation = registry.environmentObservation(environment.id);
backend.disconnected = true;
const unavailable = (error: unknown) => error instanceof ExecutionNodeError && error.code === "NODE_UNAVAILABLE";
await assert.rejects(local.status(environment.id), unavailable);
assert.equal(local.contact, "unavailable");
assert.deepEqual(registry.environmentObservation(environment.id), observation);
await assert.rejects(supervisor.wakeCube("legacy"), unavailable);
await assert.rejects(supervisor.sleepCube("legacy"), unavailable);
await assert.rejects(supervisor.workspaceForUserThread("legacy"), unavailable);
await assert.rejects(supervisor.listServicesForUserThread("legacy"), unavailable);
await assert.rejects(supervisor.retrySetupForUserThread("legacy"), unavailable);
await assert.rejects(supervisor.removeCube("legacy"), unavailable);
await assert.rejects(local.openPortal(environment.id, 3000), unavailable);
assert.deepEqual(backend.effects, []);
assert.equal(registry.getCube("legacy")?.status, "ready");
assert.equal(supervisor.listUserThreads()[0]?.nodeContact, "unavailable");
assert.ok(supervisor.environmentForUserThread("legacy")); // control-plane evidence
registry.addCubeRepositories(environment.id, [{ url: "https://github.com/cubeyard/cube.git", base: "main", branch: "thread", baseOid: "a".repeat(40), checkoutName: "workspace", workspacePath: workspace }]);
const noProbe = backend.probes;
const metadata = await supervisor.repositoriesForUserThread("legacy", false);
assert.equal(metadata.length, 1);
assert.equal(metadata[0]?.state, null);
assert.equal(backend.probes, noProbe, "pure control-plane reads never probe execution");
assert.throws(() => new ExecutionNodes(registry, []).forEnvironment(environment.id), unavailable);
console.log("2 ok: offline entry points reject without effects, observations and control-plane evidence survive");

fs.rmSync(workspace, { recursive: true });
for (const status of ["creating", "error", "asleep", "ready"]) {
  registry.setCubeStatus("legacy", status);
  const probes = backend.probes;
  const plan = await supervisor.terminalPlan("legacy", () => assert.fail("no provisioning status barrier"));
  assert.ok(fs.statSync(plan.cwd).isDirectory());
  assert.notEqual(plan.cwd, workspace);
  assert.equal(plan.env.CUBE_NODE_ID, nodeId);
  for (const flag of ["--no-extensions", "--no-approve", "--no-context-files"]) assert.ok(plan.argv.includes(flag));
  assert.equal(backend.probes, probes, "plan does not even probe node status");
  assert.equal(fs.existsSync(workspace), false);
}
// Real pi CLI: the historical session header names a now-nonexistent cwd.
// The shim must override runtime cwd WITHOUT editing that session header.
const plan = await supervisor.terminalPlan("legacy", () => {});
const env = Object.fromEntries(Object.entries(plan.env).filter(([key, value]) => (key.startsWith("CUBE_") || key === "CUBED_URL") && value !== undefined)) as Record<string, string>;
Object.assign(env, { PATH: process.env.PATH!, HOME: tmp, PI_CODING_AGENT_DIR: path.join(tmp, "agent"), TERM: "xterm-256color" });
const originalBytes = fs.readFileSync(sessionPath, "utf8");
const shim = plan.argv[2]!;
const result = execFileSync(process.execPath, ["--import", shim, "--input-type=module", "-e", `
  import { SessionManager } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
  const session = SessionManager.open(${JSON.stringify(sessionPath)});
  console.log(JSON.stringify({cwd: session.getCwd(), id: session.getSessionId()}));
`], { cwd: plan.cwd, env, encoding: "utf8" });
assert.equal(JSON.parse(result).cwd, plan.cwd);
assert.equal(fs.readFileSync(sessionPath, "utf8"), originalBytes);
class Client implements TerminalClient {
  output = ""; frames: string[] = []; closed = false;
  send(data: string | Buffer) { if (typeof data === "string") this.frames.push(data); else this.output += data.toString(); }
  close() { this.closed = true; }
}
const terminals = new PiTerminals({ plan: async () => ({ ...plan, env }), activity: () => {} });
const client = new Client();
const probes = backend.probes;
const attachment = terminals.attach("legacy", client, 100, 30);
try {
  const deadline = Date.now() + 15_000;
  while (!client.output.includes("cube") && !client.closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(!client.closed, client.output);
  assert.ok(client.frames.some(frame => JSON.parse(frame).t === "spawned"));
  assert.ok(client.output.length > 0, "real pi TUI produced output");
  assert.doesNotMatch(client.output, /Stored session working directory does not exist|invalid control-plane|shutting down/);
  attachment.input("\r"); // empty conversation input: no model call
  assert.equal(backend.probes, probes);
} finally { terminals.close(); }
assert.equal(fs.existsSync(workspace), false);
console.log("3 ok: offline plans and real pi PTY reopen the old session without its workspace");

backend.disconnected = false;
backend.loseReply = true;
await assert.rejects(local.sleep(environment.id), (error: unknown) => error instanceof ExecutionNodeError && error.completionUnknown);
assert.deepEqual(backend.effects, ["setState"]);
backend.disconnected = false;
backend.loseReply = false;
await local.status(environment.id);
assert.deepEqual(backend.effects, ["setState"], "reconnect probes never replay mutations");
await local.sleep(environment.id); // new explicit operation after inspection
assert.deepEqual(backend.effects, ["setState", "setState"]);
backend.missing = true;
await assert.rejects(local.status(environment.id), (error: unknown) => error instanceof ExecutionNodeError && error.code === "ENVIRONMENT_MISSING");
assert.equal(local.contact, "available");
assert.equal(registry.getThread("legacy")?.piSessionPath, sessionPath);
assert.equal(registry.nodeForCube(environment.id), nodeId);
backend.missing = false;
console.log("4 ok: uncertain dispatch, no replay, reconnect identity, missing != unavailable");

// Durable keyed retry is answered before project preparation and after restart.
registry.addThread({ id: "retry", cubeId: registry.createCube({ name: "retry", image: "mock", workspacePath: "/not-created" }).id,
  projectId: "project", piSessionPath: path.join(tmp, "retry.jsonl"), requestKey: "project\0request" });
await supervisor.close();
registry.close();
registry = new Registry(dbPath);
const restarted = new CubeSupervisor(registry, backend, config);
assert.deepEqual(await restarted.createUserThread("project", "request"), { id: "retry", created: false });
assert.equal(registry.localNodeId, nodeId);
await restarted.close();

// HTTP goes through a stream connector, no routable guest address needed.
let requests = 0;
const upstream = http.createServer((_req, res) => { requests++; res.end("same environment"); });
upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
const port = (upstream.address() as { port: number }).port;
const portalNode = new LocalExecutionNodeClient(registry, backend);
const target = { port, connect: () => portalNode.openPortal(environment.id, port) };
const proxy = http.createServer((req, res) => proxyHttp(req, res, target, () => respondUnavailable(req, res)));
const wss = new WebSocketServer({ noServer: true });
let upgrades = 0;
upstream.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
  upgrades++;
  ws.on("message", data => ws.send(data));
}));
proxy.on("upgrade", (req, socket, head) => proxyUpgrade(req, socket, head, target));
proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}/stable`;
try {
  backend.disconnected = true;
  const response = await fetch(url, { method: "POST", body: "must not replay", signal: AbortSignal.timeout(2_000) });
  assert.equal(response.status, 503);
  assert.equal(requests, 0);
  const rejected = new WebSocket(url.replace("http:", "ws:"));
  const refusal = await new Promise<number>((resolve, reject) => {
    rejected.once("unexpected-response", (_req, response) => { response.resume(); resolve(response.statusCode!); });
    rejected.once("error", reject);
    setTimeout(() => reject(new Error("websocket refusal timed out")), 2_000).unref();
  });
  rejected.on("error", () => {}); rejected.terminate();
  assert.equal(refusal, 503);
  assert.equal(upgrades, 0);
  backend.disconnected = false;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(requests, 0);
  assert.equal(await (await fetch(url)).text(), "same environment");
  assert.equal(requests, 1);
  const ws = new WebSocket(url.replace("http:", "ws:"));
  await once(ws, "open");
  ws.send("same portal websocket");
  const [echo] = await once(ws, "message");
  assert.equal(echo.toString(), "same portal websocket");
  assert.equal(upgrades, 1, "only the new explicit upgrade reached the same environment");
  ws.close(); await once(ws, "close");
} finally {
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  proxy.closeAllConnections(); upstream.closeAllConnections();
  await Promise.all([new Promise<void>(r => proxy.close(() => r())), new Promise<void>(r => upstream.close(() => r()))]);
  registry.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log("5 ok: bounded unavailable HTTP/WS, no POST or upgrade replay, same portal after reconnect");
