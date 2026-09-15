/** Real catalog, HTTP selection, and Pi worker against a local fake provider. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Registry } from "../src/registry.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-models-"));
const agentDir = path.join(root, ".pi/agent");
fs.mkdirSync(agentDir, { recursive: true });
const requests: { model: string }[] = [];
const provider = http.createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body) as { model: string };
  requests.push(request);
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const [delta, finish_reason] of [[{ role: "assistant", content: request.model }, null], [{}, "stop"]]) {
    res.write(`data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", created: 1,
      model: request.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  }
  res.end("data: [DONE]\n\n");
});
provider.listen(0, "127.0.0.1");
await once(provider, "listening");
const providerPort = (provider.address() as net.AddressInfo).port;
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: {
  baseUrl: `http://127.0.0.1:${providerPort}/v1`, api: "openai-completions", apiKey: "fixture-not-a-secret",
  models: ["first", "second"].map((id) => ({ id, name: id, reasoning: false, input: ["text"],
    contextWindow: 32000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
} } }));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "second" }));
fs.writeFileSync(path.join(root, "extension.ts"), "export default function () {}\n");
const registry = new Registry(path.join(root, "cubed.db"));
registry.createProject({ id: "project", name: "model test", repositories: [] });
for (const id of ["alpha", "beta"]) {
  const cube = registry.createCube({ name: id, image: "mock", workspacePath: root });
  registry.addThread({ id, cubeId: cube.id, projectId: "project", piSessionPath: path.join(root, `${id}.jsonl`) });
}
const env = { PATH: process.env.PATH, HOME: root, PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir };
const reserve = net.createServer();
reserve.listen(0, "127.0.0.1");
await once(reserve, "listening");
const port = (reserve.address() as net.AddressInfo).port;
await new Promise<void>((resolve) => reserve.close(() => resolve()));
const daemon = spawn(process.execPath, [path.resolve(import.meta.dirname, "../src/index.ts")], {
  cwd: root, stdio: ["ignore", "pipe", "pipe"],
  env: { ...env, CUBED_BACKEND: "mock", CUBED_DB: path.join(root, "cubed.db"),
    CUBED_CUBES_ROOT: path.join(root, "cubes"), CUBED_REPOS_ROOT: path.join(root, "repos"),
    CUBED_PORT: String(port), CUBED_PORTAL_BASE: "127.0.0.1.sslip.io", CUBED_IDLE_MS: "0", CUBED_ALLOW_LOCAL_REPOS: "1" },
});
let logs = "";
daemon.stdout.on("data", (chunk) => { logs += chunk; });
daemon.stderr.on("data", (chunk) => { logs += chunk; });
const base = `http://127.0.0.1:${port}/api/threads`;
const patch = (body: unknown) => fetch(`${base}/alpha/model`, {
  method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
try {
  for (let n = 0; ; n++) {
    try { if ((await fetch(`${base}/alpha/history`)).ok) break; } catch { /* starting */ }
    assert.ok(n < 200 && daemon.exitCode === null, `daemon did not start: ${logs}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const first = { provider: "fixture", id: "first" };
  const second = { provider: "fixture", id: "second" };
  const initial = await (await fetch(`${base}/alpha/model`)).json();
  assert.deepEqual(initial, { models: [first, second], selected: second }, "Pi's configured default, not the first catalog entry");
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/api/models`)).json(), initial,
    "new-thread catalog uses the same Pi default without requiring a thread");
  assert.equal(requests.length, 0, "reading models must not prompt a provider");
  for (const invalid of [null, {}, { provider: "wrong", id: "first" }, { provider: "fixture", id: "missing" }]) {
    assert.equal((await patch(invalid)).status, 400);
  }
  assert.equal((await fetch(`${base}/missing/model`)).status, 404);
  assert.equal((await patch(first)).status, 200);
  assert.deepEqual((await (await fetch(`${base}/alpha/model`)).json()).selected, first);
  assert.deepEqual((await (await fetch(`${base}/beta/model`)).json()).selected, second, "selection is per thread");
  registry.createAgentRun({ id: "busy", threadId: "alpha", text: "busy fixture" });
  assert.equal((await patch(second)).status, 409);
  assert.deepEqual({ ...registry.getThreadModel("alpha") }, first);
  const prompt = (model: unknown) => fetch(`${base}/alpha/prompt`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "message from another tab", model }),
  });
  assert.equal((await prompt(second)).status, 409, "a busy send cannot change the model");
  assert.deepEqual({ ...registry.getThreadModel("alpha") }, first);
  registry.setAgentRunStatus("busy", "completed");
  assert.equal((await prompt({ provider: "fixture", id: "missing" })).status, 400);
  assert.equal(registry.listConversationMessages("alpha").length, 1, "rejected sends append no message");
  fs.renameSync(path.join(agentDir, "models.json"), path.join(agentDir, "models.saved"));
  assert.deepEqual(await (await fetch(`${base}/beta/model`)).json(), { models: [], selected: null });
  assert.deepEqual(await (await fetch(`${base}/alpha/model`)).json(), { models: [], selected: first },
    "an unavailable saved selection is shown, not silently replaced");
  assert.equal((await prompt(first)).status, 400);
  fs.renameSync(path.join(agentDir, "models.saved"), path.join(agentDir, "models.json"));

  // Exercise the real disposable worker: explicit selection beats Pi settings,
  // and an unavailable selection never silently falls back to the default.
  for (const id of ["first", "second", "missing"]) {
    const child = spawn(process.execPath, [path.resolve(import.meta.dirname, "../src/agent-worker.ts")], {
      cwd: root, env, stdio: ["pipe", "ignore", "pipe", "pipe"],
    });
    let protocol = "";
    let stderr = "";
    child.stdio[3]!.on("data", (chunk) => { protocol += chunk; });
    child.stderr!.on("data", (chunk) => { stderr += chunk; });
    child.stdin!.end(JSON.stringify({ prompt: "respond with the model id", messages: [],
      extension: path.join(root, "extension.ts"), model: { provider: "fixture", id } }));
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const [code] = await once(child, "exit");
    clearTimeout(timeout);
    assert.equal(code, id === "missing" ? 1 : 0, `${protocol}\n${stderr}`);
    assert.match(protocol, id === "missing" ? /selected model is unavailable/ : /"type":"complete"/);
  }
  assert.deepEqual(requests.map((request) => request.model), ["first", "second"]);
  requests.length = 0;

  // Real cubed HTTP + two Cube conversations + real disposable Pi worker.
  // The sender identity comes from the route; only the operator endpoint can
  // create the directed grant.
  const taskPost = (path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await taskPost(`/api/threads/alpha/tasks`, {
    recipient: "beta", requestKey: "blocked", body: "reply with your model",
  })).status, 409);
  assert.equal((await taskPost("/api/thread-task-grants", { sender: "alpha", recipient: "beta" })).status, 200);
  assert.deepEqual(await (await fetch(`${base}/alpha/tasks/destinations`)).json(), {
    destinations: [{ id: "beta", title: null }],
  });
  const acceptedResponse = await taskPost(`/api/threads/alpha/tasks`, {
    recipient: "beta", requestKey: "real-two-conversations", body: "reply with your model",
  });
  assert.equal(acceptedResponse.status, 202);
  const acceptedTask = (await acceptedResponse.json()).task;
  let completedTask: any;
  for (let n = 0; n < 400; n++) {
    completedTask = (await (await fetch(`${base}/alpha/tasks/${acceptedTask.id}`)).json()).task;
    if (["completed", "failed"].includes(completedTask.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(completedTask.status, "completed", JSON.stringify(completedTask));
  assert.equal(completedTask.result, "second");
  assert.equal(requests.at(-1)?.model, "second");
  const betaHistory = await (await fetch(`${base}/beta/history`)).json();
  assert.equal(betaHistory.messages[0].content, "reply with your model");
  assert.equal(betaHistory.messages[0].payload.source.sender, "alpha");
  console.log("models-test: real HTTP thread task crossed two Cube conversations and a disposable Pi worker");

  // Real creation route: invalid input must not allocate; concurrent and late
  // retries must retain one first turn with the explicitly selected model.
  const upstream = path.join(root, "upstream");
  fs.mkdirSync(upstream);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: upstream, stdio: "pipe" });
  git("init", "-b", "main");
  fs.writeFileSync(path.join(upstream, "README.md"), "fixture\n");
  git("add", ".");
  git("-c", "user.name=fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgSign=false", "commit", "-m", "fixture");
  const post = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const projectResponse = await post(`http://127.0.0.1:${port}/api/projects`, { name: "creation", repositories: [{ url: upstream }] });
  assert.ok(projectResponse.ok);
  const { project } = await projectResponse.json();
  for (let n = 0; ; n++) {
    const { project: current } = await (await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}`)).json();
    if (current.status === "ready") break;
    assert.ok(n < 200 && current.status !== "error", JSON.stringify(current));
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const before = registry.listCubes().length;
  for (const fields of [{ text: " " }, { text: "x".repeat(100001) }, { text: "hello", model: { provider: "fixture", id: "missing" } }]) {
    assert.equal((await post(base, { projectId: project.id, requestId: "invalid", ...fields })).status, 400);
  }
  assert.equal(registry.listCubes().length, before, "validation precedes allocation");
  const body = { projectId: project.id, requestId: "first-turn", text: "  create once\nwith this model  ", model: first };
  const responses = await Promise.all([post(base, body), post(base, body)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 201]);
  const [a, b] = await Promise.all(responses.map((response) => response.json()));
  assert.equal(a.id, b.id);
  assert.deepEqual({ ...registry.getThreadModel(a.id) }, first);
  const runId = registry.latestAgentRun(a.id)!.id;
  assert.deepEqual(registry.listConversationMessages(a.id).filter((message) => message.role === "user").map((message) => message.content), ["create once\nwith this model"]);
  assert.equal((await post(base, body)).status, 200);
  assert.equal(registry.latestAgentRun(a.id)!.id, runId, "replay cannot append a new run");
  assert.equal(registry.listCubes().length, before + 1);
  console.log("models-test: new-thread catalog, pre-allocation validation, concurrent creation and first-turn replay all ok");
  console.log("models-test: catalog/default, HTTP validation, per-thread persistence, busy rejection, exact real-worker selection all ok");
} finally {
  daemon.kill("SIGTERM");
  await once(daemon, "exit");
  registry.close();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  fs.rmSync(root, { recursive: true, force: true });
}
