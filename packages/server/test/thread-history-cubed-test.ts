/** thread_history through the real cubed (local guests, a faux model, the
 * fake `claude`): a Pi thread and a Claude Code thread created now read an
 * archived sibling of their project, redacted and framed as evidence,
 * without starting its machine or opening its agent; another project's
 * thread answers as none; the Claude Code tool route needs the thread's
 * lease. Threads that existed before the tool (no creation stamp, with a
 * memory row) are offered no thread_history by either agent, before and
 * after a restart, and the new threads' tool lists stay the same across it.
 * Faux model only, no network. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { Registry } from "../src/registry.ts";
import { HISTORY_FRAME } from "../src/thread-history-tool.ts";
import { LocalMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-thread-history-cubed-"));
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
const KEY = `ghp_${"d4".repeat(18)}`;
const state = path.join(root, "state");
const repository = path.join(root, "repository");
fs.mkdirSync(repository);
const git = (args: string[]) => execFileSync("git", ["-c", "user.name=Cube Test", "-c", "user.email=cube@example.invalid", "-c", "commit.gpgsign=false", "-C", repository, ...args], { encoding: "utf8" });
git(["init", "-q", "--initial-branch=main"]);
fs.writeFileSync(path.join(repository, "README"), "hello\n");
git(["add", "README"]);
git(["commit", "-qm", "base"]);

/** Every Pi thread request: the tools it was offered and its last message. */
const requests: Array<{ tools: string[]; said: string }> = [];
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 300 }, () => async request => {
  const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
  if (system.includes("You write the memory of OptChat")) return fauxAssistantMessage("summarized line");
  if (system.includes("You are OptChat")) return fauxAssistantMessage("noted");
  const last = request.messages.findLast(message => message.role !== "system")!;
  const said = textOf(last);
  // Pi's tools ride on its system messages, added and removed in order.
  const tools = new Set<string>();
  for (const message of request.messages) {
    if (message.role !== "system") continue;
    for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
  }
  requests.push({ tools: [...tools].sort(), said });
  if (last.role === "toolResult") return fauxAssistantMessage(`result: ${said}`);
  if (said.startsWith("tool ")) {
    const { name, args } = JSON.parse(said.slice(5)) as { name: string; args: Record<string, unknown> };
    return fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1], { id: `t-${requests.length}` })], { stopReason: "toolUse" });
  }
  return fauxAssistantMessage("ok");
}));
const models = createModels();
models.setProvider(faux.provider);
const machines = new LocalMachines(path.join(root, "machines"));
/** Each machine start and reboot, by thread. */
const started: string[] = [];
const start = machines.start.bind(machines);
machines.start = (thread, options) => { started.push(thread.id); return start(thread, options); };
const reboot = machines.reboot.bind(machines);
machines.reboot = thread => { started.push(`reboot:${thread.id}`); reboot(thread); };
const open = () => createCubed({ state, models, machines, gateway: null,
  claude: [process.execPath, path.resolve(import.meta.dirname, "fake-claude.ts")], claudeOptions: { stopGraceMs: 2000 } });
let app = await open();
for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) app.registry.enrollRunner({ nodeId: `node-${n}`, environmentId: n, threadId: `runner-${n}`, configPath: `/private/${n}.json`, configHash: `h${n}`, protocol: 4, kind: "vm" });
let base = "";
const listen = async () => {
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  assert(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
};
const restart = async () => { await app.close(); app = await open(); await listen(); };
await listen();
const call = async (route: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
  const response = await fetch(`${base}${route}`, { method, ...body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } });
  return { status: response.status, body: await response.json() as Record<string, any> };
};
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string, ms = 30_000): Promise<T> {
  let value = await read();
  for (const deadline = Date.now() + ms; !check(value); value = await read()) {
    assert.ok(Date.now() < deadline, `${what}: ${JSON.stringify(value).slice(0, 3000)}`);
    await delay(50);
  }
  return value;
}
/** The thread's stored history once its last run ended with an answer after `text`. */
const settled = (id: string, text: string) => until(() => call(`/api/threads/${id}/history`), value => value.status === 200 && JSON.stringify(value.body).includes(text)
  && value.body.status.state !== "working" && value.body.events.at(-1)?.type === "assistant-text", `thread ${id} answers ${text}`);
const prompt = async (id: string, text: string, requestId: string) => {
  assert.equal((await call(`/api/threads/${id}/prompt`, { text, requestId })).status, 200);
  return settled(id, JSON.stringify(text).slice(1, -1));
};
/** The last tool result a thread's history shows. */
const lastResult = (history: { body: Record<string, any> }) => history.body.events.findLast((event: { type: string }) => event.type === "tool-result").output as string;
const piStep = (args: Record<string, unknown>) => `tool ${JSON.stringify({ name: "thread_history", args })}`;
const toolsOf = (said: string) => requests.filter(request => request.said === said).map(request => request.tools);
/** cubed's workspace socket, as the Claude Code mod reaches it. */
const socket = (route: string, token: string | null, body?: unknown) => new Promise<{ status: number; body: Record<string, any> }>((resolve, reject) => {
  const request = http.request({ socketPath: path.join(state, "run", "workspace.sock"), path: route, method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...token ? { authorization: `Bearer ${token}` } : {} } }, response => {
    let text = "";
    response.on("data", chunk => { text += chunk; });
    response.on("end", () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) as Record<string, any> }));
  });
  request.on("error", reject);
  request.end(body === undefined ? undefined : JSON.stringify(body));
});
const claudeToken = async (id: string) => {
  const claudes = (app.conversations as unknown as { claudes: Map<string, Promise<{ lease: { token: string } }>> }).claudes;
  return (await claudes.get(id)!).lease.token;
};
const toolNames = async (id: string) => (await socket(`/api/threads/${id}/workspace/tools`, await claudeToken(id))).body.tools.map((tool: { name: string }) => tool.name).sort() as string[];
const pi = { provider: faux.getModel().provider, id: faux.getModel().id };
const fable = { provider: "claude-code", id: "fable" };

try {
  const demo = (await call("/api/projects", { name: "demo", repositories: [{ url: repository, base: "main" }] })).body.project;
  const other = (await call("/api/projects", { name: "other", repositories: [{ url: repository, base: "main" }] })).body.project;
  for (const project of [demo, other]) await call(`/api/projects/${project.id}/check`, {});

  // Threads from before the tool: their rows have no creation stamp, but a
  // memory row (every thread since memory has one).
  await app.close();
  const registry = new Registry(path.join(state, "registry.sqlite"));
  const old = registry.createThread(demo.id, "old", pi, "say old").id;
  const oldClaude = registry.createThread(demo.id, "old-claude", fable, "say old claude", "claude-code").id;
  registry.close();
  {
    const db = new DatabaseSync(path.join(state, "registry.sqlite"));
    db.prepare("UPDATE thread SET data = json_remove(data, '$.capabilities') WHERE id IN (?, ?)").run(old, oldClaude);
    assert.equal((db.prepare("SELECT count(*) AS n FROM thread_memory WHERE thread_id IN (?, ?)").get(old, oldClaude) as { n: number }).n, 2);
    db.close();
  }
  app = await open();
  await listen();
  await settled(old, "say old");
  await settled(oldClaude, "say old claude");
  for (const id of [old, oldClaude]) assert.equal(app.registry.getThread(id)!.capabilities, undefined);

  // The thread to read: a key in its task; archived. And one in another project.
  const target = (await call("/api/threads", { projectId: demo.id, requestId: "target", text: `say GITHUB_TOKEN=${KEY} and https://bot:${KEY}@example.com/x` })).body.id as string;
  await settled(target, "GITHUB_TOKEN");
  await until(() => call(`/api/threads/${target}`, undefined, "DELETE"), value => value.status === 200, "archive the target");
  const foreign = (await call("/api/threads", { projectId: other.id, requestId: "foreign", text: "say the other project's plan" })).body.id as string;
  await settled(foreign, "other project's plan");
  const short = target.slice(0, 8);

  // ---- a Pi thread created now ----
  const before = { started: started.length, open: app.conversations.agentOpen(target), owner: app.conversations.owner(target), thread: app.registry.getThread(target) };
  assert.deepEqual([before.open, before.owner, before.thread!.archived], [false, null, true]);
  const reading = piStep({ id: short, limit: 1 });
  const reader = (await call("/api/threads", { projectId: demo.id, requestId: "reader", text: reading })).body.id as string;
  let history = await settled(reader, "result:");
  const piAnswer = lastResult(history);
  assert.ok(piAnswer.startsWith(`${HISTORY_FRAME}\n[${short}] demo · `), piAnswer);
  assert.match(piAnswer, /\ncubed: archived; .*agent pi not open in cubed; workspace writer: none\n/);
  assert.match(piAnswer, new RegExp(`\\nmessages #1–#1 of 2, oldest first; earlier: thread_history\\("${short}", before: 1\\)\\n#1 thread: ok$`));
  assert.deepEqual(started.slice(before.started), [reader], "only the reader's machine starts: the read starts, wakes or reboots none");
  assert.equal(app.conversations.agentOpen(target), false, "the read opens no agent");
  assert.equal(app.conversations.owner(target), null, "and takes no lease");
  assert.deepEqual(app.registry.getThread(target), before.thread, "the target's row is unchanged");
  assert.deepEqual(app.registry.getThread(reader)!.capabilities, ["thread_history"]);
  const piTools = toolsOf(reading)[0]!;
  assert.ok(piTools.includes("thread_history"), piTools.join(", "));

  // Redacted; another project's thread and an unknown id answer alike; a thread reads itself.
  history = await prompt(reader, piStep({ id: short, before: 1 }), "r-2");
  assert.match(lastResult(history), /\n#0 user: say GITHUB_TOKEN=\[redacted\] and https:\/\/bot:\[redacted\]@example\.com\/x$/);
  assert.ok(!JSON.stringify(history.body).includes(KEY), "the key never reaches the reader");
  history = await prompt(reader, piStep({ id: foreign.slice(0, 8) }), "r-3");
  assert.equal(lastResult(history), `no thread ${foreign.slice(0, 8)}`);
  history = await prompt(reader, piStep({ id: foreign }), "r-4");
  assert.equal(lastResult(history), `no thread ${foreign}`, "another project's thread is none");
  history = await prompt(reader, piStep({ id: "0123abcd" }), "r-5");
  assert.equal(lastResult(history), "no thread 0123abcd", "as an id nobody has");
  history = await prompt(reader, piStep({ id: reader.slice(0, 8), before: 1 }), "r-6");
  assert.match(lastResult(history), /\n#0 user: tool \{"name":"thread_history"/, "a thread reads its own history");

  // ---- the old Pi thread: no tool, and a call finds none ----
  const oldStep = piStep({ id: short });
  history = await prompt(old, oldStep, "o-2");
  assert.ok(toolsOf("say old").length && toolsOf(oldStep).length);
  for (const tools of [...toolsOf("say old"), ...toolsOf(oldStep)]) assert.ok(!tools.includes("thread_history"), tools.join(", "));
  assert.ok(toolsOf(oldStep)[0]!.includes("memory_zoom"), "it keeps the tools it had");
  assert.ok(!lastResult(history).includes(HISTORY_FRAME), lastResult(history));
  assert.deepEqual(toolsOf(oldStep)[0], piTools.filter(name => name !== "thread_history"), "its list is the new one without thread_history");

  // ---- a Claude Code thread created now, and the old one ----
  const claudeStep = `tool thread_history ${JSON.stringify({ id: short, limit: 1 })}`;
  const claude = (await call("/api/threads", { projectId: demo.id, requestId: "claude", model: fable, text: claudeStep })).body.id as string;
  history = await until(() => call(`/api/threads/${claude}/history`), value => value.status === 200 && value.body.status.state === "completed", "the claude thread finishes");
  const claudeAnswer = lastResult(history);
  assert.equal(claudeAnswer, piAnswer.replace("earlier: thread_history(", "earlier: mcp__cube__thread_history("), "the same answer, the tool named as Claude Code calls it");
  const claudeTools = await toolNames(claude);
  assert.ok(claudeTools.includes("thread_history"), claudeTools.join(", "));
  const oldClaudeTools = await toolNames(oldClaude);
  assert.deepEqual(oldClaudeTools, claudeTools.filter(name => name !== "thread_history"), "the old Claude Code thread is offered no thread_history");
  history = await until(async () => { await call(`/api/threads/${oldClaude}/prompt`, { text: claudeStep, requestId: "oc-2" }); return call(`/api/threads/${oldClaude}/history`); },
    value => value.body.status.state === "completed" && JSON.stringify(value.body).includes("No such tool available"), "the old Claude Code thread finds no tool", 30_000);
  assert.equal(lastResult(history), "No such tool available: mcp__cube__thread_history");
  // The route needs the lease cubed holds for that thread's Claude Code child.
  const route = `/api/threads/${claude}/workspace/tools/thread_history`;
  assert.equal((await socket(route, null, { call: "x", input: { id: short } })).status, 401);
  assert.equal((await socket(route, "not-a-lease", { call: "x", input: { id: short } })).status, 401);
  assert.equal((await socket(`/api/threads/${claude}/workspace/tools`, await claudeToken(oldClaude))).status, 401, "another thread's lease is not this one's");
  const viaRoute = await socket(route, await claudeToken(claude), { call: "x", input: { id: short, limit: 1 } });
  assert.deepEqual([viaRoute.status, viaRoute.body.text], [200, claudeAnswer]);
  assert.deepEqual([app.conversations.agentOpen(target), app.conversations.owner(target)], [false, null], "still nothing opened for the target");
  assert.ok(!started.slice(before.started).includes(target) && !started.includes(`reboot:${target}`));

  // ---- restart: each thread's tools are what its creation gave it ----
  const rows = (ids: string[]) => ids.map(id => app.registry.getThread(id)!.capabilities ?? null);
  const stamped = rows([old, oldClaude, reader, claude]);
  assert.deepEqual(stamped, [null, null, ["thread_history"], ["thread_history"]]);
  await restart();
  assert.deepEqual(rows([old, oldClaude, reader, claude]), stamped, "the stamps survive a restart");
  await prompt(old, "say old after restart", "o-3");
  await prompt(reader, "say reader after restart", "r-7");
  assert.deepEqual(toolsOf("say old after restart"), [toolsOf(oldStep)[0]], "the old Pi thread's tools, unchanged");
  assert.deepEqual(toolsOf("say reader after restart"), [piTools], "the new Pi thread's tools, unchanged");
  for (const [id, said, tools] of [[claude, "say claude after restart", claudeTools], [oldClaude, "say old claude after restart", oldClaudeTools]] as const) {
    await call(`/api/threads/${id}/prompt`, { text: said, requestId: `${id}-after` });
    await until(() => call(`/api/threads/${id}/history`), value => value.body.status.state === "completed" && JSON.stringify(value.body).includes(said), `${id} answers after the restart`);
    assert.deepEqual(await toolNames(id), tools, "a Claude Code thread's tools, unchanged after the restart");
  }
  history = await prompt(reader, piStep({ id: oldClaude.slice(0, 8), limit: 1 }), "r-8");
  assert.match(lastResult(history), new RegExp(`^${HISTORY_FRAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n\\[${oldClaude.slice(0, 8)}\\] demo · `), "a new thread reads an old one");
  console.log("ok: thread_history through cubed: Pi and Claude Code threads read an archived sibling without waking it, redacted, project-scoped; old threads get no tool, before or after a restart");
} finally {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
}
