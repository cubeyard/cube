/** OptChat through cubed's HTTP routes and its real threads over a local
 * guest (the real guest helper under a temporary root): a message makes
 * OptChat spawn a thread in a project, the thread runs bash in its own
 * machine, its final reply comes back to the chat as a "[id] " report and
 * starts a turn. Faux model, disposable state. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { formatHistory, THREAD_NOTE } from "../src/optchat.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import { observeRunners } from "../src/runner-observe.ts";
import { LocalMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-product-"));
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
const state = path.join(root, "state");
const repository = path.join(root, "repository");
fs.mkdirSync(repository);
const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "user.name=Cube Test", "-c", "user.email=cube@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" });
git(repository, ["init", "-q", "--initial-branch=main"]);
fs.writeFileSync(path.join(repository, "README"), "hello\n");
git(repository, ["add", "README"]);
git(repository, ["commit", "-qm", "base"]);

const chatTurns: string[][] = [];
let release!: () => void;
const held = new Promise<void>(resolve => { release = resolve; });
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 100 }, () => async request => {
  const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
  if (system.includes("You write the memory of OptChat")) return fauxAssistantMessage("summarized line");
  const last = request.messages.findLast(message => message.role !== "system")!;
  if (system.includes("You are OptChat")) {
    const first = request.messages.find(message => message.role === "user")!;
    const blocks = typeof first.content === "string" ? [first.content] : first.content.map(part => part.type === "text" ? part.text : "");
    chatTurns.push(blocks);
    const said = blocks.at(-1)!;
    if (last.role === "toolResult") return fauxAssistantMessage(`started: ${textOf(last)}`);
    if (said.includes("count the files")) {
      return fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ project: "demo", task: "count the files in the repository with bash" }] }, { id: "call-spawn" })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage(`noted: ${said}`);
  }
  // A thread that works until the test lets it finish.
  if (JSON.stringify(request.messages).includes("hold until released")) { await held; return fauxAssistantMessage("released"); }
  // The spawned thread: one command in its own machine, then the report.
  if (last.role === "toolResult") return fauxAssistantMessage(`the repository has ${textOf(last).trim().split("\n")[0]} file`);
  assert.match(textOf(last), new RegExp(`count the files in the repository with bash\\n\\n${THREAD_NOTE.replace(/[().]/g, "\\$&")}`));
  return fauxAssistantMessage([fauxToolCall("bash", { command: "ls | wc -l" })], { stopReason: "toolUse" });
}));
const models = createModels();
models.setProvider(faux.provider);
const machines = new LocalMachines(path.join(root, "machines"));
const app = await createCubed({ state, models, machines, claude: null, gateway: null });
app.registry.enrollRunner({ nodeId: "node-optchat", environmentId: 1, threadId: "runner-optchat", configPath: "/private/optchat.json", configHash: "optchat" });
await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
const address = app.server.address();
assert(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;
const post = (route: string, body: unknown, method = "POST") => fetch(`${base}${route}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string): Promise<T> {
  let value = await read();
  for (const deadline = Date.now() + 30_000; !check(value); value = await read()) {
    assert.ok(Date.now() < deadline, `${what}: ${JSON.stringify(value).slice(0, 2000)}`);
    await delay(50);
  }
  return value;
}
try {
  const project = await (await post("/api/projects", { name: "demo", repositories: [{ url: repository, base: "main" }] })).json();
  assert.ok(project.project?.id, JSON.stringify(project));
  const checked = await (await post(`/api/projects/${project.project.id}/check`, {})).json();
  assert.equal(checked.project.status, "ready", JSON.stringify(checked));

  const models = await (await fetch(`${base}/api/optchat/model`)).json();
  assert.deepEqual(models.selected, { provider: faux.getModel().provider, id: faux.getModel().id });
  const sent = await post("/api/optchat/prompt", { text: "please count the files in demo", requestId: "chat-1" });
  assert.equal(sent.status, 200, await sent.clone().text());

  // The thread exists, in the project, started by the chat.
  const thread = (await until(async () => (await (await fetch(`${base}/api/threads`)).json()).threads as Array<{ id: string; title: string; projectId: string; state: string }>,
    threads => threads.length === 1 && threads[0]!.state === "ready", "the spawned thread starts"))[0]!;
  assert.equal(thread.projectId, project.project.id);
  assert.equal(thread.title, "count the files in the repository with bash", "the title is the task's, without the note");
  await until(async () => (await (await fetch(`${base}/api/threads/${thread.id}/history`)).json()), history => history.status.state === "completed", "the thread finishes");

  // Its report comes back to the chat as a message and starts a turn.
  const report = `[${thread.id.slice(0, 8)}] the repository has 1 file`;
  const history = await until(async () => (await (await fetch(`${base}/api/optchat/history`)).json()),
    value => value.status.state === "completed" && value.events.some((event: { type: string; text?: string }) => event.type === "assistant-text" && event.text?.startsWith("noted:")),
    "the report reaches the chat");
  const users = history.events.filter((event: { type: string }) => event.type === "user-message").map((event: { text: string }) => event.text);
  assert.deepEqual(users, ["please count the files in demo", report]);
  assert.ok(history.events.some((event: { type: string; name?: string }) => event.type === "tool-call" && event.name === "spawn"));
  const reportTurn = chatTurns.find(blocks => blocks.at(-1) === report)!;
  assert.match(reportTurn[0]!, /^<chat>\n0\+1\|user: please count the files in demo\n/, "the report turn sees the view");
  assert.ok(!reportTurn[0]!.includes("not summarized yet"));

  // A replayed spawn finds its thread, even with another model or none left.
  const adapter = cubeThreads({ registry: app.registry, conversations: app.conversations, catalog: async () => [],
    runners: () => observeRunners(app.registry, 60_000) });
  assert.match(await adapter.runners(), /^runners as cubed last heard from them[^]*unknown for every runner/, "OptChat's runners tool reads cubed's registry");
  assert.deepEqual(await adapter.spawn({ project: "demo", task: "count the files in the repository with bash" }, "optchat:call-spawn:0"), { id: thread.id, title: thread.title });

  // History reads the thread's stored transcript beside cubed's record,
  // without its agent or lease: while the agent is open, with a failure
  // recorded beside a finished run, once archived, and for a thread whose
  // agent never opened.
  const open = (await adapter.history(thread.id))!;
  assert.equal(open.machine, "ready");
  assert.equal(open.agentOpen, true);
  assert.equal(open.failure, null);
  assert.equal(open.transcript?.status.state, "completed");
  assert.equal(open.transcript?.owner, "pi", "the agent still holds its workspace");
  assert.match(formatHistory(thread.id, open, "delivered"), /\nlatest answer #3: the repository has 1 file\n/);
  const workspaceBase = app.registry.getThread(thread.id)!.workspaceBase;
  const failure = "workspace allocation failed: thread workspace already has a writable owner";
  app.registry.markWorkspaceFailed(thread.id, failure);
  const diverged = (await adapter.history(thread.id))!;
  assert.equal(diverged.failure, failure);
  assert.match(formatHistory(thread.id, diverged, "delivered"), /\nnote: cubed records a failure \(workspace allocation failed: thread workspace already has a writable owner\) while the stored history shows the agent ran \(run completed\);/);
  app.registry.markWorkspaceAvailable(thread.id, workspaceBase);
  // OptChat's archive is the UI's: the agent closes, the machine is
  // released, its slot is free again; history still reads the thread.
  const before = app.registry.runnerSlots().free;
  assert.deepEqual(await adapter.archive!(thread.id), { already: false, disk: `machine disk retained (${app.registry.getThread(thread.id)!.vm!.retainReason})`, free: `${before + 1} of ${app.registry.runnerSlots().total}` });
  assert.equal(app.registry.getThread(thread.id)!.archived, true);
  assert.equal(app.conversations.agentOpen(thread.id), false);
  // Archiving again changes nothing: not the slots, not the retained disk.
  const vm = app.registry.getThread(thread.id)!.vm;
  assert.equal((await adapter.archive!(thread.id))?.already, true);
  assert.equal(app.registry.runnerSlots().free, before + 1, "a repeated archive frees no second slot");
  assert.deepEqual(app.registry.getThread(thread.id)!.vm, vm);
  assert.equal((await fetch(`${base}/api/threads/${thread.id}`, { method: "DELETE" })).status, 404, "the UI's archive finds it archived");
  assert.equal(await adapter.archive!("no-such-thread"), null);
  const archived = (await adapter.history(thread.id))!;
  assert.deepEqual([archived.archived, archived.machine, archived.agentOpen], [true, null, false]);
  assert.ok(archived.facts.some(fact => fact.startsWith("machine disk retained")), archived.facts.join("; "));
  assert.deepEqual(archived.transcript?.events, open.transcript?.events, "an archived thread keeps its history");
  assert.match(formatHistory(thread.id, archived, "delivered"), /\ncubed: archived; machine disk retained [^\n]*; agent pi not open in cubed; workspace writer: none\nrun: completed/);
  const quiet = app.registry.createThread(project.project.id, "quiet", { provider: faux.getModel().provider, id: faux.getModel().id }, "never opened");
  const none = (await adapter.history(quiet.id))!;
  assert.deepEqual([none.machine, none.transcript, none.unreadable], ["not started", null, null], "no agent, no history");
  assert.ok(!fs.existsSync(path.join(state, "threads", quiet.id, "pi.sqlite")), "reading created no store");
  assert.equal(await adapter.history("no-such-thread"), null);

  // A thread whose machine failed is archived too, its disk kept; that
  // frees the slot the next thread takes.
  app.registry.markWorkspaceFailed(quiet.id, "workspace allocation failed: boom");
  const failed = (await adapter.archive!(quiet.id))!;
  assert.equal(failed.already, false);
  assert.equal(failed.disk, "machine disk retained (workspace allocation failed: boom)");
  assert.equal(app.registry.getThread(quiet.id)!.archived, true);

  // A working thread is refused and keeps working; once it finishes it can
  // be archived, and two archives at once archive it once.
  const busy = app.registry.createThread(project.project.id, "busy", { provider: faux.getModel().provider, id: faux.getModel().id }, "hold until released");
  void app.conversations.activate(busy.id);
  await until(async () => app.conversations.starting(busy.id) || app.registry.getThread(busy.id)!.workspaceState !== "available" ? null
    : (await app.conversations.history(busy.id)).status.state, value => value === "working", "the busy thread works");
  await assert.rejects(adapter.archive!(busy.id), /^Error: it is working; nothing was stopped$/);
  assert.equal(app.registry.getThread(busy.id)!.archived, false);
  assert.equal((await app.conversations.history(busy.id)).status.state, "working", "nothing was stopped");
  release();
  await until(async () => (await app.conversations.history(busy.id)).status.state, value => value === "completed", "the busy thread finishes");
  const free = app.registry.runnerSlots().free;
  const both = await Promise.all([adapter.archive!(busy.id), adapter.archive!(busy.id)]);
  assert.deepEqual(both.map(result => result?.already).sort(), [false, true], "one archives, the other finds it archived");
  assert.equal(app.registry.runnerSlots().free, free + 1);
  assert.equal((await adapter.history(busy.id))?.transcript?.status.state, "completed", "its history stays");

  // An agent that cannot open runs nothing: its thread is archived, its disk kept.
  const stuck = app.registry.createThread(project.project.id, "stuck", { provider: "claude-code", id: "opus" }, "never runs", "claude-code");
  await app.conversations.activate(stuck.id);
  assert.match(app.conversations.error(stuck.id) ?? "", /claude code is not installed/);
  assert.equal(app.registry.getThread(stuck.id)!.workspaceState, "available");
  // Its release fails once: archiving again releases it and keeps the
  // first decision about the disk, not the release's error.
  const releaseMachine = machines.release.bind(machines);
  machines.release = async () => { machines.release = releaseMachine; throw new Error("runner unreachable"); };
  await assert.rejects(adapter.archive!(stuck.id), /workspace release failed: runner unreachable/);
  assert.equal(app.registry.getThread(stuck.id)!.archived, false, "a failed release archives nothing");
  assert.match((await adapter.archive!(stuck.id))!.disk, /^machine disk retained \(the agent could not open: claude code is not installed/);
  assert.equal(app.registry.getThread(stuck.id)!.archived, true);

  const { view, messages } = await (await fetch(`${base}/api/optchat/view`)).json();
  assert.ok(messages >= 5, `the log holds the turns (${messages})`);
  assert.match(view, /^<chat>\n/);
  assert.equal((await fetch(`${base}/api/optchat/nonsense`)).status, 404);
} finally {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
}

// A malformed CUBED_OPTCHAT_COMPACTOR leaves the chat unavailable; cubed
// starts and answers, it never throws out of startup.
{
  const badRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-bad-"));
  process.env.CUBED_OPTCHAT_COMPACTOR = "no-slash";
  try {
    const bad = await createCubed({ state: path.join(badRoot, "state"), models, machines: new LocalMachines(path.join(badRoot, "machines")), claude: null, gateway: null });
    try {
      await new Promise<void>(resolve => bad.server.listen(0, "127.0.0.1", resolve));
      const port = (bad.server.address() as { port: number }).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/optchat/view`);
      assert.ok(response.status >= 400, "the chat is unavailable");
      assert.match(await response.text(), /CUBED_OPTCHAT_COMPACTOR must be provider\/model/);
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/projects`)).status, 200, "the rest of cubed still answers");
    } finally { await bad.close(); }
  } finally {
    delete process.env.CUBED_OPTCHAT_COMPACTOR;
    fs.rmSync(badRoot, { recursive: true, force: true });
  }
}
console.log("optchat product: ok");
