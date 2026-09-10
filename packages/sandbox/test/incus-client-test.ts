/**
 * Offline units for the Incus client's deadlines against a fake daemon on a
 * unix socket: every wait ends — with an IncusTimeoutError when Incus stops
 * answering or the work outlives its deadline, with the signal's reason on
 * abort — and provisioning/publication keep their failure contracts when
 * that happens. No Incus, no VM.
 *
 *   node packages/sandbox/test/incus-client-test.ts
 */
import assert from "node:assert";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";

import {
  IncusBackend,
  IncusClient,
  IncusSandbox,
  IncusTimeoutError,
  provisionCube,
  type CubeProvisionSpec,
} from "../src/index.ts";

// ---------------------------------------------------------------- fake Incus

interface FakeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: string;
}
type Handler = (req: FakeRequest, res: http.ServerResponse) => void;

const envelope = (res: http.ServerResponse, body: Record<string, unknown>) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ type: "sync", status: "Success", status_code: 200, operation: "", error_code: 0, error: "", metadata: null, ...body }));
};
const operationBody = (id: string, status_code: number, metadata: Record<string, unknown> | null = null) => ({
  id, class: "task", status: status_code < 200 ? "Running" : status_code === 200 ? "Success" : "Failure",
  status_code, err: "", metadata,
});

/** Sync 200 with `metadata`. */
const sync = (metadata: unknown): Handler => (_req, res) => envelope(res, { metadata });
/** Incus error envelope. */
const failure = (code: number, message: string): Handler => (_req, res) =>
  envelope(res, { type: "error", status: message, status_code: code, error_code: code, error: message });
/** Async acceptance naming `operation`. */
const accepted = (operation: string, metadata: Record<string, unknown> | null = null): Handler => (_req, res) =>
  envelope(res, {
    type: "async", status: "Operation created", status_code: 100, operation,
    metadata: operationBody(path.basename(operation), 103, metadata),
  });
/** A finished operation (what `/wait` returns once the work is done). */
const finished = (id: string, metadata: Record<string, unknown> | null = null, status_code = 200): Handler =>
  (_req, res) => envelope(res, { metadata: operationBody(id, status_code, metadata) });
/** A healthy daemon whose operation never finishes: honours `?timeout=`
 * then renders the operation still Running, exactly as Incus does. */
const stillRunning = (id: string): Handler => (req, res) => {
  const seconds = Number(req.query.get("timeout") ?? "-1");
  assert.ok(seconds > 0, `/wait must carry a positive ?timeout= (got ${req.query.get("timeout")})`);
  setTimeout(() => envelope(res, { metadata: operationBody(id, 103) }), seconds * 1000);
};

class FakeIncus {
  readonly socketPath: string;
  readonly requests: FakeRequest[] = [];
  private readonly routes = new Map<string, Handler>();
  private readonly server: http.Server;
  private readonly websockets = new WebSocketServer({ noServer: true });
  private readonly held = new Set<http.ServerResponse>();
  private readonly directory: string;

  private constructor() {
    this.directory = fs.mkdtempSync(path.join(os.tmpdir(), "cube-incus-"));
    this.socketPath = path.join(this.directory, "incus.sock");
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://incus");
        const request = { method: req.method ?? "GET", path: url.pathname, query: url.searchParams, body: Buffer.concat(chunks).toString("utf8") };
        this.requests.push(request);
        const handler = this.routes.get(`${request.method} ${request.path}`);
        if (!handler) return failure(404, `no route ${request.method} ${request.path}`)(request, res);
        handler(request, res);
      });
    });
    // Exec fds: accept every websocket and keep it open (the daemon holds
    // them until the process exits — which, in these tests, never happens).
    this.server.on("upgrade", (req, socket, head) => this.websockets.handleUpgrade(req, socket, head, () => {}));
  }

  static listen(): Promise<FakeIncus> {
    const fake = new FakeIncus();
    return new Promise((resolve) => fake.server.listen(fake.socketPath, () => resolve(fake)));
  }

  route(method: string, apiPath: string, handler: Handler): this {
    this.routes.set(`${method} ${apiPath}`, handler);
    return this;
  }

  /** Never answer: the daemon has hung on this request. */
  hold(): Handler {
    return (_req, res) => { this.held.add(res); };
  }

  seen(method: string, apiPath: string): FakeRequest[] {
    return this.requests.filter((r) => r.method === method && r.path === apiPath);
  }

  async close(): Promise<void> {
    for (const client of this.websockets.clients) client.terminate();
    this.websockets.close();
    for (const res of this.held) res.destroy();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    fs.rmSync(this.directory, { recursive: true, force: true });
  }
}

/** Test clients poll in 1 s slices and call the daemon unresponsive 200 ms
 * past a slice's own timeout, so a hung `/wait` fails in ~1.2 s. */
const fastClient = (fake: FakeIncus, timeouts: Record<string, number> = {}) =>
  new IncusClient(fake.socketPath, { pollMs: 1000, graceMs: 200, timeouts });

const elapsed = async <T>(work: Promise<T>): Promise<[number, PromiseSettledResult<T>]> => {
  const started = Date.now();
  const [result] = await Promise.allSettled([work]);
  return [Date.now() - started, result];
};
const rejection = <T>(result: PromiseSettledResult<T>): unknown => {
  assert.equal(result.status, "rejected", "expected a rejection");
  return (result as PromiseRejectedResult).reason;
};

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cube-incus-client-"));
process.on("exit", () => fs.rmSync(workspace, { recursive: true, force: true }));
const spec: CubeProvisionSpec = {
  name: "builder",
  image: "cube-node",

  pool: "cube",
  rootSize: "10GiB",
  dockerVolumeSize: "5GiB",
  hostWorkspace: path.join(workspace, "workspace"),
  guestWorkspace: "/workspace",
  network: { bridge: "cbr-test", subnet: "10.90.8.1/24", gateway: "10.90.8.1", ip: "10.90.8.2", nat: false },
};

// ------------------------------- 1. a hung /wait ends within the liveness bound
{
  const fake = await FakeIncus.listen();
  fake.route("POST", "/1.0/instances", accepted("/1.0/operations/op-create"))
    .route("GET", "/1.0/operations/op-create/wait", fake.hold())
    .route("DELETE", "/1.0/operations/op-create", sync({}));
  const client = fastClient(fake, { create: 60_000 });
  const [ms, result] = await elapsed(client.createInstance({ name: "builder", source: { type: "image", alias: "cube-node" } }));
  const error = rejection(result);
  assert.ok(error instanceof IncusTimeoutError, `expected IncusTimeoutError, got ${String(error)}`);
  assert.equal(error.name, "IncusTimeoutError");
  assert.equal(error.kind, "create");
  assert.equal(error.instance, "builder");
  assert.equal(error.operation, "/1.0/operations/op-create");
  assert.equal(error.unresponsive, true, "a slice Incus never answered is an unresponsive daemon");
  assert.equal(error.seconds, 1.2);
  assert.match(error.message, /create of builder: the daemon did not answer within 1\.2s/);
  assert.ok(ms >= 1000 && ms < 3000, `fired at ${ms}ms, expected ~1200ms`);
  assert.equal(fake.seen("GET", "/1.0/operations/op-create/wait")[0]!.query.get("timeout"), "1", "the slice is bounded on the Incus side too");
  assert.equal(fake.seen("DELETE", "/1.0/operations/op-create").length, 1, "an abandoned wait cancels the operation (bounded, best-effort)");
  await fake.close();
  console.log("1 ok: hung /wait -> IncusTimeoutError(create) within the liveness bound");
}

// ------------------------------- 2. a slow operation ends at the kind's deadline
{
  const fake = await FakeIncus.listen();
  fake.route("POST", "/1.0/instances", accepted("/1.0/operations/op-create"))
    .route("GET", "/1.0/operations/op-create/wait", stillRunning("op-create"))
    .route("DELETE", "/1.0/operations/op-create", sync({}));
  const client = fastClient(fake, { create: 1500 });
  const [ms, result] = await elapsed(client.createInstance({ name: "builder", source: { type: "image", alias: "cube-node" } }));
  const error = rejection(result);
  assert.ok(error instanceof IncusTimeoutError, `expected IncusTimeoutError, got ${String(error)}`);
  assert.equal(error.kind, "create");
  assert.equal(error.unresponsive, false, "Incus kept answering; the work outlived its deadline");
  assert.equal(error.seconds, 1.5);
  assert.match(error.message, /create of builder did not finish within 1\.5s \(operation \/1\.0\/operations\/op-create\)/);
  assert.ok(ms >= 1500 && ms < 4000, `fired at ${ms}ms, expected ~2000ms (two 1 s slices)`);
  assert.equal(fake.seen("GET", "/1.0/operations/op-create/wait").length, 2, "polled in slices until the deadline");
  await fake.close();
  console.log("2 ok: still-running operation -> IncusTimeoutError(create) at the deadline");
}

// ------------------------------- 3. abort rejects promptly with the reason
{
  const fake = await FakeIncus.listen();
  fake.route("POST", "/1.0/instances", accepted("/1.0/operations/op-create"))
    .route("GET", "/1.0/operations/op-create/wait", fake.hold())
    .route("DELETE", "/1.0/operations/op-create", sync({}));
  const client = fastClient(fake, { create: 60_000 });
  const controller = new AbortController();
  const reason = new Error("thread deleted while setting up");
  setTimeout(() => controller.abort(reason), 50);
  const [ms, result] = await elapsed(client.createInstance(
    { name: "builder", source: { type: "image", alias: "cube-node" } }, { signal: controller.signal },
  ));
  assert.strictEqual(rejection(result), reason, "rejects with the signal's own reason");
  assert.ok(ms < 500, `abort took ${ms}ms`);
  assert.equal(fake.seen("DELETE", "/1.0/operations/op-create").length, 1, "the operation is cancelled on abort");
  // An already-aborted signal never reaches the socket.
  const dead = new AbortController();
  dead.abort(reason);
  const before = fake.requests.length;
  await assert.rejects(client.getInstanceState("builder", dead.signal), (error) => error === reason);
  assert.equal(fake.requests.length, before);
  await fake.close();
  console.log("3 ok: abort -> rejects with the reason, cancels the operation");
}

// ------------------------------- 4. sync requests are bounded as well
{
  const fake = await FakeIncus.listen();
  fake.route("GET", "/1.0/instances/builder/state", fake.hold());
  const client = fastClient(fake, { request: 200 });
  const [ms, result] = await elapsed(client.getInstanceState("builder"));
  const error = rejection(result);
  assert.ok(error instanceof IncusTimeoutError);
  assert.equal(error.kind, "request");
  assert.equal(error.unresponsive, true);
  assert.match(error.message, /request GET \/1\.0\/instances\/builder\/state: the daemon did not answer within 0\.2s/);
  assert.ok(ms < 1000, `fired at ${ms}ms`);
  await fake.close();
  console.log("4 ok: a hung sync request -> IncusTimeoutError(request)");
}

// ------------------------------- 5. a stop's graceful phase fits its deadline
{
  const fake = await FakeIncus.listen();
  fake.route("PUT", "/1.0/instances/builder/state", accepted("/1.0/operations/op-stop"))
    .route("GET", "/1.0/operations/op-stop/wait", finished("op-stop"));
  // A huge poll slice makes the first `?timeout=` equal the whole deadline.
  const client = new IncusClient(fake.socketPath, { pollMs: 3_600_000, graceMs: 30_000, timeouts: { state: 120_000 } });
  await client.setInstanceState("builder", "stop", { timeout: 600 });
  const waits = fake.seen("GET", "/1.0/operations/op-stop/wait");
  assert.equal(waits[0]!.query.get("timeout"), "630", "deadline stretched to the graceful phase (600 s) plus grace (30 s)");
  assert.deepEqual(JSON.parse(fake.seen("PUT", "/1.0/instances/builder/state")[0]!.body), { action: "stop", force: false, timeout: 600 });
  await client.setInstanceState("builder", "stop", { force: true });
  assert.equal(fake.seen("GET", "/1.0/operations/op-stop/wait")[1]!.query.get("timeout"), "120", "default stop keeps the 30 s graceful phase inside the 2 min deadline");
  await fake.close();
  console.log("5 ok: state deadline covers Incus's own graceful timeout");
}

// ------------------------------- 6. streaming exec: a hung daemon cannot hang the agent
{
  const fake = await FakeIncus.listen();
  fake.route("POST", "/1.0/instances/builder/exec", accepted("/1.0/operations/op-exec", { fds: { "0": "a", "1": "b", "2": "c", control: "d" } }))
    .route("GET", "/1.0/operations/op-exec/wait", fake.hold());
  const sandbox = new IncusSandbox("builder", fastClient(fake));
  const [ms, result] = await elapsed(sandbox.exec("sleep 1000", { cwd: "/workspace", onData: () => {} }));
  const error = rejection(result);
  assert.ok(error instanceof IncusTimeoutError, `expected IncusTimeoutError, got ${String(error)}`);
  assert.equal(error.kind, "exec");
  assert.equal(error.instance, "builder");
  assert.equal(error.unresponsive, true);
  assert.ok(ms < 4000, `exec without a caller timeout ended at ${ms}ms once the daemon stopped answering`);
  await fake.close();
  console.log("6 ok: streaming exec without a timeout still detects a hung daemon");
}

// ------------------------------- 7. provisionCube rolls a timed-out create back
const provisionRoutes = (fake: FakeIncus) => fake
  .route("GET", "/1.0/networks/cbr-test", failure(404, "not found"))
  .route("POST", "/1.0/networks", sync({}))
  .route("GET", "/1.0/storage-pools/cube/volumes/custom/builder-docker", failure(404, "not found"))
  .route("POST", "/1.0/storage-pools/cube/volumes/custom", sync({}))
  .route("POST", "/1.0/instances", accepted("/1.0/operations/op-create"))
  .route("DELETE", "/1.0/operations/op-create", sync({}))
  .route("GET", "/1.0/instances/builder/state", sync({ status: "Stopped", network: null }))
  .route("DELETE", "/1.0/instances/builder", accepted("/1.0/operations/op-delete"));
{
  const fake = await FakeIncus.listen();
  provisionRoutes(fake)
    .route("GET", "/1.0/operations/op-create/wait", fake.hold())
    .route("GET", "/1.0/operations/op-delete/wait", finished("op-delete"));
  const [ms, result] = await elapsed(provisionCube(fastClient(fake), spec));
  const error = rejection(result);
  assert.ok(error instanceof IncusTimeoutError, `expected IncusTimeoutError, got ${String(error)}`);
  assert.equal(error.kind, "create");
  assert.equal(error.instance, "builder", "the error names the instance");
  assert.doesNotMatch(error.message, /may still exist/, "a confirmed rollback adds no warning");
  assert.equal(fake.seen("DELETE", "/1.0/instances/builder").length, 1, "the half-made instance was deleted");
  assert.ok(ms < 4000, `provision failed at ${ms}ms`);
  await fake.close();
  console.log("7 ok: timed-out create -> rolled back, error names the instance");
}

// ------------------------------- 8. a rollback that cannot confirm says so, bounded
{
  const fake = await FakeIncus.listen();
  provisionRoutes(fake)
    .route("GET", "/1.0/operations/op-create/wait", fake.hold())
    .route("GET", "/1.0/operations/op-delete/wait", fake.hold())
    .route("DELETE", "/1.0/operations/op-delete", sync({}));
  const [ms, result] = await elapsed(provisionCube(fastClient(fake), spec, { rollbackTimeoutMs: 5000 }));
  const error = rejection(result);
  assert.ok(error instanceof IncusTimeoutError, "the original failure is what surfaces");
  assert.equal(error.kind, "create");
  assert.match(error.message, /create of builder: the daemon did not answer/);
  assert.match(error.message, /instance builder may still exist \(rollback failed: IncusTimeoutError: incus: delete of builder: the daemon did not answer/);
  assert.ok(ms < 6000, `provision plus bounded rollback took ${ms}ms`);
  await fake.close();
  console.log("8 ok: unconfirmed rollback is named in the error and bounded");
}

// ------------------------------- 9. a cancelled provision still rolls back
{
  const fake = await FakeIncus.listen();
  provisionRoutes(fake)
    .route("GET", "/1.0/operations/op-create/wait", fake.hold())
    .route("GET", "/1.0/operations/op-delete/wait", finished("op-delete"));
  const controller = new AbortController();
  const reason = new Error("thread deleted while setting up");
  setTimeout(() => controller.abort(reason), 100);
  const [ms, result] = await elapsed(provisionCube(fastClient(fake), spec, { signal: controller.signal }));
  assert.strictEqual(rejection(result), reason);
  assert.equal(fake.seen("DELETE", "/1.0/instances/builder").length, 1, "rollback runs after an abort, signal-free");
  assert.ok(ms < 1500, `cancel took ${ms}ms`);
  await fake.close();
  console.log("9 ok: aborted provision -> rejects with the reason, instance rolled back");
}

// ------------------------------- 10. a template capture is bounded by the snapshot deadline
const captureRoutes = (fake: FakeIncus) => fake
  .route("GET", "/1.0/instances/builder/state", sync({ status: "Stopped", network: null }))
  .route("GET", "/1.0/instances/builder", sync({
    name: "builder", architecture: "x86_64", description: "", ephemeral: false, profiles: ["default"],
    config: { "security.nesting": "true" },
    devices: {
      root: { type: "disk", path: "/", pool: "cube" },
      eth0: { type: "nic", network: "cbr-test" },
      workspace: { type: "disk", source: "/x", path: "/workspace" },
      dockerlib: { type: "disk", pool: "cube", source: "builder-docker", path: "/var/lib/docker" },
    },
  }))
  .route("PUT", "/1.0/instances/builder", accepted("/1.0/operations/op-update"))
  .route("GET", "/1.0/operations/op-update/wait", finished("op-update"))
  .route("POST", "/1.0/instances/builder/files", sync({}))
  .route("POST", "/1.0/instances/builder/snapshots", accepted("/1.0/operations/op-snap"))
  .route("DELETE", "/1.0/operations/op-snap", sync({}));
{
  const fake = await FakeIncus.listen();
  captureRoutes(fake).route("GET", "/1.0/operations/op-snap/wait", stillRunning("op-snap"));
  const backend = new IncusBackend(fastClient(fake));
  const [ms, result] = await elapsed(backend.captureTemplate(spec, "env", { timeoutMs: 500 }));
  const error = rejection(result);
  assert.ok(error instanceof IncusTimeoutError, `expected IncusTimeoutError, got ${String(error)}`);
  assert.equal(error.kind, "snapshot");
  assert.equal(error.instance, "builder");
  assert.equal(error.operation, "/1.0/operations/op-snap");
  assert.ok(ms < 3000, `capture gave up at ${ms}ms`);
  const put = JSON.parse(fake.seen("PUT", "/1.0/instances/builder")[0]!.body);
  assert.deepEqual(Object.keys(put.devices), ["root"], "every device but root is stripped before the snapshot");
  assert.equal(fake.seen("POST", "/1.0/instances/builder/files").length, 1, "machine-id is reset before the snapshot");
  await fake.close();
  console.log("10 ok: snapshot deadline -> IncusTimeoutError(snapshot), devices stripped first");
}

// ------------------------------- 11. a cancelled capture releases the waiter
{
  const fake = await FakeIncus.listen();
  captureRoutes(fake).route("GET", "/1.0/operations/op-snap/wait", fake.hold());
  const controller = new AbortController();
  const reason = new Error("environment build abandoned");
  setTimeout(() => controller.abort(reason), 100);
  const [ms, result] = await elapsed(new IncusBackend(fastClient(fake)).captureTemplate(spec, "env", { signal: controller.signal }));
  assert.strictEqual(rejection(result), reason);
  assert.ok(ms < 1000, `cancel took ${ms}ms`);
  await fake.close();
  console.log("11 ok: aborted snapshot wait -> rejects with the reason");
}

console.log("incus-client: all ok");
