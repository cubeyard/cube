import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { on, once } from "node:events";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { DatabaseSync } from "node:sqlite";
import type { TrustedRunnerHealth } from "../src/runner-types.ts";

const state = fs.mkdtempSync(path.join(os.tmpdir(), "cube-api-"));
const models = createModels();
const faux = fauxProvider(); models.setProvider(faux.provider);
const runnerHealth = new Map<string, TrustedRunnerHealth>();
// No cube-gateway (the credential proxy): it is reported, never replaced.
const app = await createCubed({ state, models, claude: null, gateway: null, runnerHealth: async runner => {
  const health = runnerHealth.get(runner.nodeId);
  if (!health) throw new Error("NODE_UNAVAILABLE");
  return health;
} });
await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
const address = app.server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;
const write = (route: string, body: unknown, method = "POST") => fetch(`${base}${route}`, {
  method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
try {
  const rejectedHost = await new Promise<number | undefined>((resolve, reject) => {
    http.get(`${base}/api/state`, { headers: { host: "untrusted.example" } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(rejectedHost, 403);
  assert.equal((await fetch(`${base}/api/state`, { headers: { origin: "http://untrusted.example" } })).status, 403);
  assert.equal((await write("/api/models", {})).status, 404);
  assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), {
    lifecycle: "ready", version: "dev", commit: "unknown", stateSchema: 102, gateway: "unavailable", portal: "off",
  });
  // A second cubed on the same state never takes the live workspace socket.
  await assert.rejects(createCubed({ state, models, claude: null, gateway: null }), /another cubed is serving this CUBED_STATE/);
  assert.ok(fs.existsSync(path.join(state, "run/workspace.sock")), "the live instance keeps its workspace socket");
  const unmanagedUpdate = await (await fetch(`${base}/api/system/update`)).json();
  assert.equal(unmanagedUpdate.installation, "unmanaged");
  assert.equal(unmanagedUpdate.enabled, false);
  assert.equal(unmanagedUpdate.runnersUpdated, false);
  assert.equal((await write("/api/system/update", { action: "check" })).status, 409);
  assert.equal((await write("/api/github/auth", {}, "PUT")).status, 404);
  assert.equal((await fetch(`${base}/api/projects`, { method: "POST", body: "{}" })).status, 415);
  for (const repositories of [[null], [{ url: "org/repo", base: {} }], [{ url: "org/repo", checkoutName: "../outside" }],
    [{ url: "org/one" }, { url: "org/two", checkoutName: "workspace" }]]) {
    assert.equal((await write("/api/projects", { name: "invalid", repositories })).status, 409);
  }
  assert.equal(app.registry.listProjects().length, 0, "invalid input must not allocate metadata");
  const created = await write("/api/projects", { name: "fresh", repositories: [] });
  assert.equal(created.status, 200);
  const { project } = await created.json();
  assert.equal(project.availableRunnerCount, 0);
  assert.equal((await fetch(`${base}/api/projects/${project.id}/nonsense`, { method: "DELETE" })).status, 404);
  assert(app.registry.getProject(project.id), "unknown subroute must not delete project");
  const input = { projectId: project.id, requestId: "retry", text: "inspect workspace", model: { provider: faux.getModel().provider, id: faux.getModel().id } };
  assert.equal((await write("/api/threads", input)).status, 409);
  app.registry.enrollRunner({ nodeId: "broken-node", threadId: "broken-thread", environmentId: 1,
    configPath: path.join(state, "absent.json"), configHash: "missing", protocol: 4, kind: "host" });
  // A host runner takes a thread only by name.
  const unnamed = await write("/api/threads", input);
  assert.equal(unnamed.status, 409);
  assert.match((await unnamed.json()).error, /no berth vm runner in the global runner pool: start the thread on a berth host by name/);
  const unknown = await write("/api/threads", { ...input, runner: "node-nobody" });
  assert.equal(unknown.status, 409);
  assert.match((await unknown.json()).error, /no runner node-nobody/);
  assert.equal(app.registry.listThreads().length, 0, "a refused start leaves no thread");
  const named = { ...input, runner: "broken-node" };
  const accepted = await write("/api/threads", named);
  assert.equal(accepted.status, 200, "activation failure must not lose accepted allocation");
  const acceptedBody = await accepted.json();
  assert.equal(typeof acceptedBody.id, "string");
  assert.notEqual(acceptedBody.id, "broken-thread");
  assert.deepEqual(await (await write("/api/threads", named)).json(), acceptedBody);
  assert.deepEqual([app.registry.getThread(acceptedBody.id)!.runnerId, app.registry.getThread(acceptedBody.id)!.pinned], ["broken-thread", true]);
  // The machine starts in the background; the thread reports starting, then the failure.
  const settledThreads = async () => {
    for (let attempt = 0; ; attempt++) {
      const { threads } = await (await fetch(`${base}/api/threads`)).json();
      if (!threads.some((thread: { state: string }) => thread.state === "starting")) return threads;
      assert.ok(attempt < 200, "activation settles");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const threads = await settledThreads();
  assert.equal(threads.length, 1); assert.equal(threads[0].state, "error");
  assert.match(threads[0].error, /workspace allocation failed.*absent\.json/);
  // The polled list: the same list again is a 304 without a body; a changed one is the whole list.
  const first = await fetch(`${base}/api/threads?includeArchived=1`);
  const etag = first.headers.get("etag")!;
  assert.match(etag, /^"[\w-]+"$/);
  assert.deepEqual((await first.json()).threads, threads);
  const same = await fetch(`${base}/api/threads?includeArchived=1`, { headers: { "if-none-match": etag } });
  assert.deepEqual([same.status, await same.text()], [304, ""]);
  app.registry.renameThread(threads[0].id, "renamed");
  const changed = await fetch(`${base}/api/threads?includeArchived=1`, { headers: { "if-none-match": etag } });
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).threads[0].title, "renamed");
  assert.notEqual(changed.headers.get("etag"), etag);
  assert.deepEqual((await (await fetch(`${base}/api/projects`)).json()).projects.map((item: { id: string; threadCount: number; retainedThreadCount: number }) =>
    [item.id, item.threadCount, item.retainedThreadCount]), [[project.id, 1, 1]], "each project's threads, counted");
  const idleHealth: TrustedRunnerHealth = { lifecycle: "ready", draining: false, error: null, activeVms: 0, runningVms: 0, maxActiveVms: 1,
    retainedVms: 1, retainedBytes: 1024, softwareVersion: "test", protocolVersion: 4, kind: "vm" };
  app.registry.enrollRunner({ nodeId: "node-operator", threadId: "operator-binding", environmentId: 2,
    configPath: path.join(state, "operator.json"), configHash: "operator", protocol: 4, kind: "vm" });
  runnerHealth.set("node-operator", { ...idleHealth, activeVms: 1, runningVms: 1 });
  const runnerCheck = await write("/api/runners/operator-binding/check", {});
  assert.equal(runnerCheck.status, 200);
  const checkedRunner = (await runnerCheck.json()).runner;
  assert.equal(checkedRunner.contactStatus, "reachable");
  assert.equal(checkedRunner.health.activeVms, 1);
  assert.equal(checkedRunner.allocationProjectId, null);
  assert.equal(Object.hasOwn(checkedRunner, "projectId"), false, "runner lifecycle is installation-global, never project-owned");
  assert.equal(JSON.stringify(checkedRunner).includes("configPath"), false, "runner API must not expose private adapter paths");
  assert.equal((await write("/api/runners/operator-binding/retire", { confirm: "wrong", reason: "test" })).status, 409,
    "retirement requires exact node confirmation");
  const activeRetire = await write("/api/runners/operator-binding/retire", { confirm: "node-operator", reason: "test" });
  assert.equal(activeRetire.status, 409);
  assert.match((await activeRetire.json()).error, /active thread machine/);
  runnerHealth.set("node-operator", idleHealth);
  const retired = await write("/api/runners/operator-binding/retire", { confirm: "node-operator", reason: "replacement enrolled" });
  assert.equal(retired.status, 200);
  assert.equal((await retired.json()).runner.contactStatus, "retired");
  const projectAfterRetire = (await (await fetch(`${base}/api/projects/${project.id}`)).json()).project;
  assert.equal(projectAfterRetire.availableRunnerCount, 0, "retired runner contributes no available capacity");
  // The system page's view: protocol per runner and capacity by protocol.
  const observed = await (await fetch(`${base}/api/runners/observed`)).json();
  assert.deepEqual(observed.runners.map((runner: { id: string; protocol: number }) => [runner.id, runner.protocol]), [["broken-thread", 4], ["operator-binding", 4]]);
  assert.deepEqual(observed.capacity.p3, { runners: 0, openThreads: 0 });
  assert.deepEqual(observed.capacity.p4.vm, { runners: 0, slots: 0, reserved: 0, free: 0, stale: [], unreported: [] }, "the retired runner is listed, not counted");
  assert.deepEqual([observed.capacity.p4.host.runners, observed.capacity.p4.host.reserved], [1, 1], "the failed thread is open and holds its slot");
  assert.equal((await write("/api/runners/broken-thread/retire", { confirm: "broken-node", reason: "still allocated" })).status, 409,
    "host allocation blocks retirement before a runner probe");
  assert.equal((await fetch(`${base}/api/threads/broken-thread/history/extra`)).status, 404);
  // A protocol-3 runner (retired) with a thread from before: it is never
  // contacted, its thread does not start, says why, archives without the
  // runner and keeps its disk's record; its history stays readable.
  app.registry.enrollRunner({ nodeId: "node-legacy", threadId: "legacy-binding", environmentId: 3, configPath: path.join(state, "legacy-runner.json"),
    configHash: "legacy", protocol: 4, kind: "vm" });
  const legacyThread = await (await write("/api/threads", { ...input, requestId: "legacy", runner: "node-legacy" })).json();
  app.registry.markPlacement(legacyThread.id, "legacy-binding", ["provisional", "requested"], "allocated");
  const sqlite = new DatabaseSync(path.join(state, "registry.sqlite"));
  sqlite.prepare("UPDATE runner SET data=json_remove(data,'$.protocol','$.kind') WHERE id='legacy-binding'").run();
  sqlite.close();
  runnerHealth.set("node-legacy", idleHealth);
  const legacyChecked = (await (await write("/api/runners/legacy-binding/check", {})).json()).runner;
  assert.deepEqual([legacyChecked.lastAttemptAt, legacyChecked.health], [null, null], "a check of a protocol-3 runner contacts nothing and records nothing");
  await app.conversations.activate(legacyThread.id).catch(() => {});
  const legacyListed = (await settledThreads()).find((thread: { id: string }) => thread.id === legacyThread.id);
  assert.equal(legacyListed.state, "error");
  assert.match(legacyListed.error, /this thread's runner uses protocol 3 \(cube-runner\), which cube no longer runs/);
  assert.equal(await app.conversations.storedHistory(legacyThread.id), null, "its stored history reads without the machine (none was written here)");
  const legacyDiagnosed = (await (await fetch(`${base}/api/threads/${legacyThread.id}/diagnostics`)).json()).diagnostics;
  assert.deepEqual([legacyDiagnosed.machine.status, legacyDiagnosed.thread.runnerNode], ["unsupported", "node-legacy"]);
  assert.match(legacyDiagnosed.machine.reason, /protocol 3/);
  const legacyArchived = await (await fetch(`${base}/api/threads/${legacyThread.id}`, { method: "DELETE" })).json();
  assert.equal(legacyArchived.retained, true, "the disk it may have on that runner's host is kept, not deleted");
  assert.equal(app.registry.getThread(legacyThread.id)!.archived, true);
  const discard = await write(`/api/threads/${legacyThread.id}/discard`, {});
  assert.equal(discard.status, 409, "a disk on a protocol-3 runner is not discarded through cubed");
  assert.match((await discard.json()).error, /protocol 3/);
  assert.equal(app.registry.getThread(legacyThread.id)!.vm!.discarded, undefined);
  assert.equal(await app.conversations.storedHistory(legacyThread.id), null, "and after the archive (protocol3-history-test.ts reads a real one)");
  const legacyObserved = (await (await fetch(`${base}/api/runners/observed`)).json()).runners.find((runner: { id: string }) => runner.id === "legacy-binding");
  assert.deepEqual([legacyObserved.protocol, legacyObserved.slots.allocatable, legacyObserved.byName], [3, false, false]);
  // Its stored report is old evidence: a reachable one with an active machine
  // and large limits neither blocks its retirement nor sets the project's
  // machine-size hint (only runners cubed places on do).
  app.registry.recordRunnerProbe("legacy-binding", { health: { ...idleHealth, protocolVersion: 3, kind: undefined, activeVms: 1, runningVms: 1,
    limits: { maxVcpus: 64, maxMemoryMiB: 262144, maxDiskGiB: 512 } } });
  assert.equal(app.registry.runnerStatuses().find(runner => runner.id === "legacy-binding")!.contactStatus, "reachable");
  assert.equal((await (await fetch(`${base}/api/projects/${project.id}`)).json()).project.machineLimits, null, "a protocol-3 report's limits are not shown");
  // Its registration can still be retired, without contacting it (phase 8's step, run by the operator).
  const legacyRetired = await write("/api/runners/legacy-binding/retire", { confirm: "node-legacy", reason: "protocol 3 retired" });
  assert.equal(legacyRetired.status, 200, await legacyRetired.clone().text());
  assert.equal((await legacyRetired.json()).runner.contactStatus, "retired");
  assert.equal(app.registry.getThread(legacyThread.id)!.archived, true, "its thread and history are kept");
  assert.equal(JSON.stringify(legacyDiagnosed).includes("configPath"), false, "no private adapter paths");
  assert.equal((await fetch(`${base}/api/threads/missing-thread/diagnostics`)).status, 404);
  assert.equal((await fetch(`${base}/api/threads/missing-thread/workspace/operations/key`)).status, 404);
  const cli = path.resolve("packages/server/src/index.ts");
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0); assert.match(help.stdout, /--allowed-host/); assert.match(help.stdout, /runners status/);
  const separatedHelp = spawnSync(process.execPath, [cli, "--", "--help"], { encoding: "utf8" });
  assert.equal(separatedHelp.status, 0); assert.equal(separatedHelp.stdout, help.stdout);
  const version = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(version.status, 0); assert.match(version.stdout, /^cubed \d+\.\d+\.\d+/);
  const status = spawnSync(process.execPath, [cli, "runners", "status", "--state", state], { encoding: "utf8" });
  assert.equal(status.status, 1); assert.match(status.stdout, /broken-node: unreachable/);
  assert.match(status.stdout, /node-legacy: protocol 3 \(cube-runner\), no longer supported; not contacted/);
  for (const host of [undefined, "0.0.0.0"]) {
    const directory = path.join(state, host ?? "default");
    fs.mkdirSync(directory);
    const child = spawn(process.execPath, [path.resolve("packages/server/src/index.ts")], {
      env: { PATH: process.env.PATH, HOME: directory, PI_CODING_AGENT_DIR: directory, CUBED_STATE: directory, CUBED_PORT: "0",
        ...(host ? { CUBED_HOST: host, CUBED_ALLOWED_HOSTS: "cube.tailnet.example,100.64.0.2" } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = once(child, "close");
    let output = "";
    child.stderr.on("data", chunk => { output += String(chunk); });
    try {
      let listener: RegExpMatchArray | null = null;
      for await (const [chunk] of on(child.stdout, "data", { signal: AbortSignal.timeout(15000) })) {
        output += String(chunk);
        listener = output.match(/listening: http:\/\/([\d.]+):(\d+)/);
        if (listener) break;
      }
      assert(listener, output);
      child.stdout.on("data", chunk => { output += String(chunk); });
      assert.equal(listener[1], host ?? "127.0.0.1", "CLI must bind the configured address and default to loopback");
      const url = `http://127.0.0.1:${listener[2]}/api/providers`;
      assert.equal((await fetch(url)).status, 200);
      // Node fetch overrides Host; use raw HTTP to exercise the actual header.
      const status = (authority: string, origin?: string) => new Promise<number | undefined>((resolve, reject) => {
        http.get(url, { headers: { host: authority, ...(origin ? { origin } : {}) } }, response => {
          response.resume(); resolve(response.statusCode);
        }).on("error", reject);
      });
      for (const name of ["cube.tailnet.example", "100.64.0.2"]) {
        const authority: string = `${name}:${listener[2]}`;
        assert.equal(await status(authority, `http://${authority}`), host ? 200 : 403);
        assert.equal(await status(authority, "http://untrusted.example"), 403);
      }
      assert.equal(await status("untrusted.example"), 403);
    } finally {
      child.kill(host ? "SIGINT" : "SIGTERM");
      if (host) child.kill("SIGINT");
      const [code] = await closed;
      assert.equal(code, 0, output);
      assert.match(output, /stopping: SIG(?:INT|TERM)/);
      assert.match(output, /stopped/);
    }
  }
  const flagState = path.join(state, "flags"); fs.mkdirSync(flagState);
  const flagChild = spawn(process.execPath, [cli, "--state", flagState, "--host", "127.0.0.1", "--port", "0",
    "--allowed-host", "flag.example", "--log-level", "warn"], {
    env: { PATH: process.env.PATH, HOME: flagState, PI_CODING_AGENT_DIR: flagState, CUBED_STATE: "/must-not-win", CUBED_HOST: "invalid", CUBED_PORT: "not-a-port", CUBED_ALLOWED_HOSTS: "env-must-not-win.example" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let flagOutput = ""; flagChild.stderr.on("data", chunk => { flagOutput += String(chunk); });
  const flagClosed = once(flagChild, "close");
  for await (const [chunk] of on(flagChild.stdout, "data", { signal: AbortSignal.timeout(15000) })) {
    flagOutput += String(chunk);
    if (flagOutput.includes("press Ctrl-C to stop")) break;
  }
  assert.match(flagOutput, new RegExp(`state: ${flagState.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const flagPort = flagOutput.match(/listening: http:\/\/127\.0\.0\.1:(\d+)/)?.[1]; assert(flagPort);
  const flagStatus = (host: string) => new Promise<number | undefined>((resolve, reject) => {
    http.get(`http://127.0.0.1:${flagPort}/api/state`, { headers: { host } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(await flagStatus(`flag.example:${flagPort}`), 200);
  assert.equal(await flagStatus(`env-must-not-win.example:${flagPort}`), 403);
  flagChild.kill("SIGTERM"); assert.equal((await flagClosed)[0], 0);
  console.log("ok: actual CLI loopback default and all-IPv4 opt-in; explicit private hosts allowed, unknown hosts/cross-origin rejected");
  console.log("ok: CLI help/version/flag precedence/live unreachable status and idempotent SIGINT/SIGTERM shutdown");
  console.log("ok: host/origin and JSON guards, method/path routing, repository validation, durable allocation despite failed activation, no gateway reported");
  console.log("ok: a protocol-3 runner's thread: never contacted, refuses to start with the reason, archives keeping its disk record, no discard, history readable");
  console.log("ok: runner status privacy, exact confirmation, active-work/allocation guards, retirement audit path and capacity exclusion");
} finally { await app.close(); fs.rmSync(state, { recursive: true, force: true }); }
