import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { on, once } from "node:events";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import type { TrustedRunnerHealth } from "../src/iroh-node.ts";

const state = fs.mkdtempSync(path.join(os.tmpdir(), "cube-api-"));
const models = createModels();
const faux = fauxProvider(); models.setProvider(faux.provider);
const runnerHealth = new Map<string, TrustedRunnerHealth>();
const app = await createCubed({ state, models, runnerHealth: async runner => {
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
    lifecycle: "ready", version: "dev", commit: "unknown", stateSchema: 100,
  });
  const unmanagedUpdate = await (await fetch(`${base}/api/system/update`)).json();
  assert.equal(unmanagedUpdate.installation, "unmanaged");
  assert.equal(unmanagedUpdate.enabled, false);
  assert.equal(unmanagedUpdate.runnersUpdated, false);
  assert.equal((await write("/api/system/update", { action: "check" })).status, 409);
  assert.deepEqual(await (await fetch(`${base}/api/jev`)).json(), { configured: false });
  const jevSecret = "jev-secret-not-for-responses";
  const savedJev = await write("/api/jev", { apiKey: jevSecret }, "PUT");
  const savedJevText = await savedJev.text();
  assert.equal(savedJev.status, 200); assert(!savedJevText.includes(jevSecret));
  assert.deepEqual(JSON.parse(savedJevText), { configured: true });
  assert.equal(fs.statSync(path.join(state, "jev-key.json")).mode & 0o777, 0o600);
  assert.deepEqual(await (await write("/api/jev", {}, "DELETE")).json(), { configured: false });
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
    configPath: path.join(state, "absent.json"), configHash: "missing" });
  const accepted = await write("/api/threads", input);
  assert.equal(accepted.status, 200, "activation failure must not lose accepted allocation");
  const acceptedBody = await accepted.json();
  assert.equal(typeof acceptedBody.id, "string");
  assert.notEqual(acceptedBody.id, "broken-thread");
  assert.deepEqual(await (await write("/api/threads", input)).json(), acceptedBody);
  const { threads } = await (await fetch(`${base}/api/threads`)).json();
  assert.equal(threads.length, 1); assert.equal(threads[0].state, "error");
  assert.match(threads[0].error, /workspace allocation failed.*IO_ERROR/);
  const idleHealth: TrustedRunnerHealth = { lifecycle: "ready", active: false, operationRecords: 2, operationCapacity: 100,
    error: null, softwareVersion: "test", protocolVersion: 1, activeWorkspaces: 0, retainedWorkspaces: 1,
    workspaceBytes: 1024, workspaceCapacity: 1, workspaceByteLimit: 2048 };
  app.registry.enrollRunner({ nodeId: "node-operator", threadId: "operator-binding", environmentId: 2,
    configPath: path.join(state, "operator.json"), configHash: "operator" });
  runnerHealth.set("node-operator", { ...idleHealth, active: true });
  const runnerCheck = await write("/api/runners/operator-binding/check", {});
  assert.equal(runnerCheck.status, 200);
  const checkedRunner = (await runnerCheck.json()).runner;
  assert.equal(checkedRunner.contactStatus, "reachable");
  assert.equal(checkedRunner.health.active, true);
  assert.equal(checkedRunner.allocationProjectId, null);
  assert.equal(Object.hasOwn(checkedRunner, "projectId"), false, "runner lifecycle is installation-global, never project-owned");
  assert.equal(JSON.stringify(checkedRunner).includes("configPath"), false, "runner API must not expose private adapter paths");
  assert.equal((await write("/api/runners/operator-binding/retire", { confirm: "wrong", reason: "test" })).status, 409,
    "retirement requires exact node confirmation");
  const activeRetire = await write("/api/runners/operator-binding/retire", { confirm: "node-operator", reason: "test" });
  assert.equal(activeRetire.status, 409);
  assert.match((await activeRetire.json()).error, /active work/);
  runnerHealth.set("node-operator", idleHealth);
  const retired = await write("/api/runners/operator-binding/retire", { confirm: "node-operator", reason: "replacement enrolled" });
  assert.equal(retired.status, 200);
  assert.equal((await retired.json()).runner.contactStatus, "retired");
  const projectAfterRetire = (await (await fetch(`${base}/api/projects/${project.id}`)).json()).project;
  assert.equal(projectAfterRetire.availableRunnerCount, 0, "retired runner contributes no available capacity");
  assert.equal((await write("/api/runners/broken-thread/retire", { confirm: "broken-node", reason: "still allocated" })).status, 409,
    "host allocation blocks retirement before a runner probe");
  assert.equal((await fetch(`${base}/api/threads/broken-thread/history/extra`)).status, 404);
  const cli = path.resolve("packages/server/src/index.ts");
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0); assert.match(help.stdout, /--allowed-host/); assert.match(help.stdout, /runners status/);
  const separatedHelp = spawnSync(process.execPath, [cli, "--", "--help"], { encoding: "utf8" });
  assert.equal(separatedHelp.status, 0); assert.equal(separatedHelp.stdout, help.stdout);
  const version = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(version.status, 0); assert.match(version.stdout, /^cubed \d+\.\d+\.\d+/);
  const status = spawnSync(process.execPath, [cli, "runners", "status", "--state", state], { encoding: "utf8" });
  assert.equal(status.status, 1); assert.match(status.stdout, /broken-node: unreachable/);
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
  console.log("ok: host/origin and JSON guards, method/path routing, repository validation, durable allocation despite failed activation");
  console.log("ok: runner status privacy, exact confirmation, active-work/allocation guards, retirement audit path and capacity exclusion");
} finally { await app.close(); fs.rmSync(state, { recursive: true, force: true }); }
