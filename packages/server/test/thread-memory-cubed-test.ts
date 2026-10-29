/** OptChat's memory in threads through the real cubed (local guests, a faux
 * model, the fake `claude`): a thread from the UI and one OptChat spawns
 * both get the chat's view, redacted, in their prompt (Pi's `memory`
 * section, the Claude Code mod's memory route) and read the chat with
 * memory_zoom, newer messages too; nobody opens the chat in that cubed
 * process (no browser, no turn) before the first thread's capture; the
 * view's bytes stay the same across a later message, a restart and a
 * resumed thread; a thread created before memory existed gets none, also
 * after a restart; archiving keeps it. Faux model only, no network. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { Registry } from "../src/registry.ts";
import { LocalMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-thread-memory-"));
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
const KEY = `ghp_${"b2".repeat(18)}`;
const state = path.join(root, "state");
const repository = path.join(root, "repository");
fs.mkdirSync(repository);
const git = (args: string[]) => execFileSync("git", ["-c", "user.name=Cube Test", "-c", "user.email=cube@example.invalid", "-c", "commit.gpgsign=false", "-C", repository, ...args], { encoding: "utf8" });
git(["init", "-q", "--initial-branch=main"]);
fs.writeFileSync(path.join(repository, "README"), "hello\n");
git(["add", "README"]);
git(["commit", "-qm", "base"]);

/** Every thread request: its memory section as Pi's system entries replay
 * to it (null without one), how many entries wrote it, and its last message. */
const requests: Array<{ memory: string | null; writes: number; said: string }> = [];
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 300 }, () => async request => {
  // Pi's sections ride on its system messages (a baseline, then patches) until the provider joins them.
  const sections = request.messages.filter(message => message.role === "system").map(message => (message as { sections?: Record<string, string | null> }).sections ?? {});
  const system = JSON.stringify(sections);
  if (system.includes("You write the memory of OptChat")) return fauxAssistantMessage("summarized line");
  const last = request.messages.findLast(message => message.role !== "system")!;
  const said = textOf(last);
  if (system.includes("You are OptChat")) {
    if (last.role === "toolResult") return fauxAssistantMessage(`done: ${said}`);
    if (said.includes("spawn the memory thread")) {
      return fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ project: "demo", task: "tool {\"name\":\"memory_zoom\",\"args\":{\"id\":0,\"n\":1}}" }] }, { id: "call-spawn" })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("noted");
  }
  const writes = sections.filter(section => "memory" in section);
  requests.push({ memory: writes.at(-1)?.memory ?? null, writes: writes.length, said });
  if (last.role === "toolResult") return fauxAssistantMessage(`result: ${said}`);
  // A spawned thread's task has OptChat's note after it: the step is its first line.
  const step = said.trim().split("\n")[0]!;
  if (step.startsWith("tool ")) {
    const { name, args } = JSON.parse(step.slice(5)) as { name: string; args: Record<string, unknown> };
    return fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1], { id: `t-${requests.length}` })], { stopReason: "toolUse" });
  }
  return fauxAssistantMessage("ok");
}));
const models = createModels();
models.setProvider(faux.provider);
const machines = new LocalMachines(path.join(root, "machines"));
const open = () => createCubed({ state, models, machines, gateway: null,
  claude: [process.execPath, path.resolve(import.meta.dirname, "fake-claude.ts")], claudeOptions: { stopGraceMs: 2000 } });
let app = await open();
for (const n of [1, 2, 3, 4, 5, 6]) app.registry.enrollRunner({ nodeId: `node-${n}`, environmentId: n, threadId: `runner-${n}`, configPath: `/private/${n}.json`, configHash: `h${n}`, protocol: 4, kind: "vm" });
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
const chatSays = async (text: string, requestId: string) => {
  assert.equal((await call("/api/optchat/prompt", { text, requestId })).status, 200);
  return until(() => call("/api/optchat/history"), history => history.body.status.state !== "working" && JSON.stringify(history.body).includes(text)
    && history.body.events.at(-1)?.type === "assistant-text", `the chat answers ${text}`);
};
const settled = (id: string, text: string) => until(() => call(`/api/threads/${id}/history`), value => value.status === 200 && JSON.stringify(value.body).includes(text)
  && value.body.status.state !== "working" && value.body.events.at(-1)?.type === "assistant-text", `thread ${id} answers ${text}`);
const zoom = (id: number) => `tool ${JSON.stringify({ name: "memory_zoom", args: { id, n: 1 } })}`;
const memoryOf = (said: string) => requests.filter(request => request.said === said).map(request => request.memory);

try {
  const project = (await call("/api/projects", { name: "demo", repositories: [{ url: repository, base: "main" }] })).body.project;
  await call(`/api/projects/${project.id}/check`, {});

  // A thread from before memory existed: created while cubed is stopped,
  // in a registry that then had no thread_memory table (an upgrade).
  await app.close();
  const registry = new Registry(path.join(state, "registry.sqlite"));
  const old = registry.createThread(project.id, "old", { provider: faux.getModel().provider, id: faux.getModel().id }, "say old").id;
  registry.close();
  { const db = new DatabaseSync(path.join(state, "registry.sqlite")); db.exec("DROP TABLE thread_memory"); db.close(); }
  app = await open();
  await listen();
  await settled(old, "say old");

  // The chat, with a key in it.
  await chatSays(`remember: the release codename is HERON and the mirror key is ${KEY}`, "u1");
  // A new cubed process: the chat is opened by cubed, never by a browser or a turn, before the thread's first request.
  await restart();

  // ---- a thread from the UI ----
  const accepted = performance.now();
  const created = await call("/api/threads", { projectId: project.id, requestId: "ui", text: zoom(0) });
  const acceptMs = performance.now() - accepted;
  const ui = created.body.id as string;
  assert.equal(created.status, 200);
  console.log(`POST /api/threads answered in ${acceptMs.toFixed(1)} ms`);
  let history = await settled(ui, "result:");
  const view = memoryOf(zoom(0))[0]!;
  assert.ok(view, "the UI thread's first request carries the memory section");
  assert.match(view, /^Chat memory: the user's chat with OptChat/);
  assert.match(view, /\nThe view below is the chat through message 1 \(.*\), captured .* when this thread started\.\n<chat>\n0\+1\|user: remember: the release codename is HERON and the mirror key is ghp_\[redacted\]\n1\+1\|talk: noted\n<\/chat>$/);
  assert.ok(!view.includes(KEY), "the key never reaches the thread's prompt");
  assert.match(JSON.stringify(history.body), /result: 0\+0\|user: remember: the release codename is HERON and the mirror key is ghp_\[redacted\]/);

  // The chat goes on: the thread reads the newer message; its view keeps its bytes.
  await chatSays("newer: the codename is now EGRET", "u2");
  await call(`/api/threads/${ui}/prompt`, { text: zoom(2), requestId: "ui-2" });
  history = await settled(ui, "EGRET");
  assert.match(JSON.stringify(history.body), /result: 2\+0\|user: newer: the codename is now EGRET/);
  for (const memory of [...memoryOf(zoom(2)), ...memoryOf(zoom(0))]) assert.equal(memory, view, "every request of the thread carries the same bytes");
  const writes = (said: string) => requests.filter(request => request.said === said).map(request => request.writes);
  assert.deepEqual(writes(zoom(2)), [1], "written once, in the baseline: no patch, so the cached prefix holds");

  // ---- a thread OptChat spawns ----
  await chatSays("spawn the memory thread", "u3");
  const spawned = app.registry.listThreads().find(thread => thread.id !== ui && thread.id !== old && thread.agent === "pi")!;
  await settled(spawned.id, "result:");
  const spawnedView = requests.find(request => request.said.includes("This thread was started by OptChat"))?.memory;
  assert.ok(spawnedView, "the spawned thread's prompt carries the memory section");
  assert.match(spawnedView, /through message \d+ /);
  assert.match(spawnedView, /EGRET/, "captured at its own start, after the newer message");

  // ---- a Claude Code thread: the mod's memory route and mcp__cube__memory_zoom ----
  const claude = (await call("/api/threads", { projectId: project.id, requestId: "claude", model: { provider: "claude-code", id: "fable" },
    text: `memory\n${zoom(2).replace(/^tool \{"name":"memory_zoom","args":(.*)\}$/, "tool memory_zoom $1")}` })).body.id as string;
  history = await until(() => call(`/api/threads/${claude}/history`), value => value.status === 200 && value.body.status.state === "completed", "the claude thread finishes");
  const claudeText = JSON.stringify(history.body);
  assert.match(claudeText, /memory: Chat memory: the user's chat with OptChat/);
  assert.match(claudeText, /mcp__cube__memory_zoom\(id, n\)/);
  assert.match(claudeText, /2\+0\|user: newer: the codename is now EGRET/);
  assert.doesNotMatch(claudeText, new RegExp(KEY));

  // ---- the old thread: no memory, before and after the restart ----
  await call(`/api/threads/${old}/prompt`, { text: "say old again", requestId: "old-2" });
  await settled(old, "say old again");
  await call(`/api/threads/${old}/prompt`, { text: zoom(0), requestId: "old-3" });
  history = await settled(old, "memory_zoom");
  assert.deepEqual([...memoryOf("say old"), ...memoryOf("say old again")], [null, null], "no memory section for a thread from before memory");
  assert.match(JSON.stringify(history.body), /memory_zoom/);
  assert.doesNotMatch(JSON.stringify(history.body), /HERON/, "no memory tool for an old thread");

  // ---- restart: the same bytes, without a turn of the chat; archive keeps it ----
  const captured = app.registry.threadMemory(ui)!.text;
  await restart();
  await call(`/api/threads/${ui}/prompt`, { text: "say after restart", requestId: "ui-3" });
  await settled(ui, "say after restart");
  assert.deepEqual(memoryOf("say after restart"), [view], "the same bytes after a restart");
  assert.deepEqual(writes("say after restart"), [1], "and still no patch");
  await until(() => call(`/api/threads/${ui}`, undefined, "DELETE"), value => value.status === 200, "archive the UI thread");
  assert.equal(app.registry.getThread(ui)!.archived, true);
  assert.equal(app.registry.threadMemory(ui)!.text, captured, "archiving deletes no memory");
  assert.equal(app.registry.threadMemory(old), null);
  console.log("ok: thread memory through cubed: UI, spawn and Claude Code threads, newer messages, redaction, same bytes across a restart, old threads without, archive keeps it");
} finally {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
}
