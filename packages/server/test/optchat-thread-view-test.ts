/** The view a thread OptChat starts gets (optchat-thread-view.ts): taken once
 * at spawn, after the view's lines are summaries, stored with the thread's
 * first message and sent the same to a Pi thread and a Claude Code thread
 * (the fake `claude`), on every open, whatever the chat says later. A thread
 * started from the UI gets none; another thread's own steps never reach a
 * view. Real cubed over local guests, faux model, disposable state. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { formatHistory, THREAD_NOTE } from "../src/optchat.ts";
import { Memory } from "../src/optchat-memory.ts";
import { splitThreadView, threadViewBlock, THREAD_VIEW_GUIDE } from "../src/optchat-thread-view.ts";
import type { ThreadTranscript } from "../src/thread-events.ts";
import { LocalMachines } from "./local-guest.ts";

// The block, alone: what it holds, how a transcript takes it apart, and
// that a secret the chat named does not reach a thread.
const taken = new Date("2026-10-08T21:30:00Z");
const block = threadViewBlock("<chat>\n0+1|user: deploy with ghp_abcdefghijklmnopqrstuv\n1+1|talk: done\n</chat>", { messages: 2, total: 3 }, taken);
assert.equal(block, `<optchat-view>\n${THREAD_VIEW_GUIDE}\n<chat>\n0+1|user: deploy with ghp_[redacted]\n1+1|talk: done\n</chat>\n`
  + "(the lines cover messages 0 to 1 of the 3 in the chat; taken 2026-10-08T21:30:00.000Z)\n</optchat-view>\n\n");
assert.deepEqual(splitThreadView(`${block}the task\n\n(note)`), { text: "the task\n\n(note)", view: { messages: 2, total: 3, taken: "2026-10-08T21:30:00.000Z" } });
assert.deepEqual(splitThreadView("<optchat-view>\nno footer\n</optchat-view>\n\nthe task"), { text: "<optchat-view>\nno footer\n</optchat-view>\n\nthe task" }, "only a whole block is a view");
assert.deepEqual(splitThreadView("plain"), { text: "plain" });

// Only built lines: the view stops at the first line not summarized yet.
const memory = new Memory();
for (const text of ["one", "two", "three"]) memory.append({ kind: "user", text, date: 0 });
memory.setNode(0, 0, "user: one");
memory.setNode(0, 2, "user: three");
assert.deepEqual(memory.builtView(), { chat: "<chat>\n0+1|user: one\n</chat>", messages: 1 });
memory.setNode(0, 1, "user: two");
assert.deepEqual(memory.builtView(), { chat: "<chat>\n0+1|user: one\n1+1|user: two\n2+1|user: three\n</chat>", messages: 3 });

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-thread-view-"));
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
const state = path.join(root, "state");
const repository = path.join(root, "repository");
fs.mkdirSync(repository);
const git = (args: string[]) => execFileSync("git", ["-c", "user.name=Cube Test", "-c", "user.email=cube@example.invalid", "-c", "commit.gpgsign=false", "-C", repository, ...args], { encoding: "utf8" });
git(["init", "-q", "--initial-branch=main"]);
fs.writeFileSync(path.join(repository, "README"), "hello\n");
git(["add", "README"]);
git(["commit", "-qm", "base"]);

const ASK = "alpha: start the work; the user's own words zebra-7";
const PI_TASK = "count the files in alpha";
// The thread computes PEAR42 itself: only its own step shows it.
const CLAUDE_TASK = "run echo PEAR$((6*7))\nsay claude done";
/** What each Pi thread's model got as its first message, by its task's first line. */
const firstMessages = new Map<string, string>();
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 200 }, () => async request => {
  const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
  if (system.includes("You write the memory of OptChat")) return fauxAssistantMessage("summarized line");
  const last = request.messages.findLast(message => message.role !== "system")!;
  if (system.includes("You are OptChat")) {
    if (last.role === "toolResult") return fauxAssistantMessage(`started: ${textOf(last)}`);
    const said = textOf(last);
    if (said.endsWith(ASK)) {
      return fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ project: "alpha", task: PI_TASK },
        { project: "alpha", task: CLAUDE_TASK, model: "claude-code/sonnet" }] }, { id: "call-alpha" })], { stopReason: "toolUse" });
    }
    if (said.endsWith("alpha: once more")) return fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ project: "alpha", task: "later look" }] }, { id: "call-later" })], { stopReason: "toolUse" });
    if (said.endsWith("beta: no view")) return fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ project: "beta", task: "beta look" }], view: false }, { id: "call-beta" })], { stopReason: "toolUse" });
    return fauxAssistantMessage("noted");
  }
  if (last.role === "toolResult") return fauxAssistantMessage("pi done");
  const first = textOf(request.messages.find(message => message.role === "user")!);
  firstMessages.set(splitThreadView(first).text.split("\n")[0]!, first);
  return fauxAssistantMessage([fauxToolCall("bash", { command: "ls | wc -l" })], { stopReason: "toolUse" });
}));
const models = createModels();
models.setProvider(faux.provider);
const machinesRoot = path.join(root, "machines");
const start = async () => {
  const app = await createCubed({ state, models, machines: new LocalMachines(machinesRoot),
    claude: [process.execPath, path.resolve(import.meta.dirname, "fake-claude.ts")], claudeOptions: { stopGraceMs: 2000 } });
  if (app.registry.runnerCount() === 0) app.registry.enrollRunner({ nodeId: "node-view", environmentId: 1, threadId: "runner-view", configPath: "/private/view.json", configHash: "view", maxActiveVms: 8 });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  assert(address && typeof address === "object");
  return { app, base: `http://127.0.0.1:${address.port}` };
};
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string): Promise<T> {
  let value = await read();
  for (const deadline = Date.now() + 30_000; !check(value); value = await read()) {
    assert.ok(Date.now() < deadline, `${what}: ${JSON.stringify(value).slice(0, 2000)}`);
    await delay(50);
  }
  return value;
}

let { app, base } = await start();
const post = (route: string, body: unknown) => fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const json = async (route: string) => (await fetch(`${base}${route}`)).json();
const history = (id: string) => json(`/api/threads/${id}/history`) as Promise<ThreadTranscript>;
const finished = (id: string) => until(() => history(id), value => value.status.state === "completed", `thread ${id} finishes`);
const chatSettled = (reports: number) => until(() => json("/api/optchat/history"), (value: ThreadTranscript) => value.status.state === "completed"
  && value.events.filter(event => event.type === "user-message" && event.text.startsWith("[")).length >= reports, "the chat takes the reports");
const threadsOf = async (title: string) => (await json("/api/threads")).threads.filter((thread: { title: string }) => thread.title === title) as Array<{ id: string; projectId: string }>;
try {
  const projects: Record<string, string> = {};
  for (const name of ["alpha", "beta"]) {
    const project = await (await post("/api/projects", { name, repositories: [{ url: repository, base: "main" }] })).json();
    assert.equal((await (await post(`/api/projects/${project.project.id}/check`, {})).json()).project.status, "ready");
    projects[name] = project.project.id;
  }
  // A thread started from the UI in beta: its own words are its own.
  const ui = app.registry.createThread(projects.beta!, "ui-beta", { provider: faux.getModel().provider, id: faux.getModel().id }, "beta private plan KIWI-42");
  void app.conversations.activate(ui.id);
  await finished(ui.id);
  assert.equal(app.registry.initialPrompt(ui.id), "beta private plan KIWI-42", "a thread started from the UI gets no view");
  assert.equal(splitThreadView(firstMessages.get("beta private plan KIWI-42")!).view, undefined);

  // OptChat starts a Pi thread and a Claude Code thread in one call: one view for both.
  assert.equal((await post("/api/optchat/prompt", { text: ASK, requestId: "chat-1" })).status, 200);
  const [pi] = await until(() => threadsOf(PI_TASK), list => list.length === 1, "the pi thread starts");
  const [claude] = await until(() => threadsOf("run echo PEAR$((6*7)) say claude done"), list => list.length === 1, "the claude thread starts");
  assert.equal(app.registry.getThread(claude!.id)!.agent, "claude-code");
  const piPrompt = app.registry.initialPrompt(pi!.id), claudePrompt = app.registry.initialPrompt(claude!.id);
  const piSplit = splitThreadView(piPrompt), claudeSplit = splitThreadView(claudePrompt);
  assert.equal(piSplit.text, `${PI_TASK}\n\n${THREAD_NOTE}`, "the task follows the view whole");
  assert.equal(claudeSplit.text, `${CLAUDE_TASK}\n\n${THREAD_NOTE}`);
  assert.equal(piPrompt.slice(0, -piSplit.text.length), claudePrompt.slice(0, -claudeSplit.text.length), "both threads got the same view");
  // Taken after the view settled: the user's own words of this very turn are in it, as a summary line, and no placeholder.
  assert.match(piPrompt, new RegExp(`\\n<chat>\\n0\\+1\\|user: ${ASK}\\n(\\d+\\+\\d+\\|[^\\n]*\\n)*</chat>\\n\\(the lines cover messages 0 to \\d+ of the \\d+ in the chat; taken \\S+\\)\\n</optchat-view>\\n\\n${PI_TASK}`));
  assert.ok(!piPrompt.includes("not summarized yet"), "only summaries");
  assert.ok(!piPrompt.includes("KIWI-42"), "another thread's own words never reach a view");
  assert.equal(piSplit.view!.messages, piSplit.view!.total, "every message the chat had was summarized");

  // The Pi thread's model got exactly those bytes; its transcript names the view apart from the task.
  await finished(pi!.id);
  assert.equal(firstMessages.get(PI_TASK), piPrompt);
  const piFirst = (await history(pi!.id)).events[0]!;
  assert.deepEqual(piFirst, { type: "user-message", id: piFirst.id, text: `${PI_TASK}\n\n${THREAD_NOTE}`, view: piSplit.view });
  // Claude Code got them too, through stream-json, and read the view as context, not steps.
  const claudeDone = await finished(claude!.id);
  assert.deepEqual(claudeDone.events[0], { type: "user-message", id: "s1", text: `${CLAUDE_TASK}\n\n${THREAD_NOTE}`, view: claudeSplit.view });
  const said = claudeDone.events.filter(event => event.type === "assistant-text").map(event => event.type === "assistant-text" ? event.text : "");
  assert.equal(said[0], `read the view of messages 0-${claudeSplit.view!.messages - 1}`);
  assert.ok(said.includes("claude done"), said.join(" | "));
  assert.ok(claudeDone.events.some(event => event.type === "tool-result" && event.output.includes("PEAR42")), "the claude thread ran its own step");
  await chatSettled(2);

  // Later turns change the chat, never a view already given.
  assert.equal((await post("/api/optchat/prompt", { text: "alpha: once more", requestId: "chat-2" })).status, 200);
  const [later] = await until(() => threadsOf("later look"), list => list.length === 1, "the later thread starts");
  await finished(later!.id);
  await chatSettled(3);
  const laterPrompt = app.registry.initialPrompt(later!.id);
  const laterView = splitThreadView(laterPrompt).view!;
  assert.ok(laterView.total > piSplit.view!.total, `a later spawn takes the view as it is then (${laterView.total} > ${piSplit.view!.total})`);
  assert.match(laterPrompt, /\|user: alpha: once more\n/);
  assert.match(laterPrompt, /claude done/, "a report is the chat's own: it is in the view");
  assert.ok(!laterPrompt.includes("PEAR42"), "a thread's own steps are not");
  assert.equal(app.registry.initialPrompt(pi!.id), piPrompt, "the first threads keep theirs");
  assert.equal(app.registry.initialPrompt(claude!.id), claudePrompt);

  // view: false gives the task only.
  assert.equal((await post("/api/optchat/prompt", { text: "beta: no view", requestId: "chat-3" })).status, 200);
  const [quiet] = await until(() => threadsOf("beta look"), list => list.length === 1, "the beta thread starts");
  assert.equal(app.registry.initialPrompt(quiet!.id), `beta look\n\n${THREAD_NOTE}`);
  await finished(quiet!.id);
  await chatSettled(4);

  // OptChat's history of a thread names the view instead of repeating it.
  const record = await (await import("../src/optchat-threads.ts")).cubeThreads({ registry: app.registry, conversations: app.conversations, catalog: async () => [],
    runners: () => ({ runners: [], at: Date.now() }) as never, latestCommits: () => { throw new Error("unused"); } }).history(pi!.id);
  const page = formatHistory(pi!.id, record!, "delivered");
  assert.match(page, new RegExp(`\\n#0 user: \\(with optchat's view of messages 0–${piSplit.view!.messages - 1}, taken ${piSplit.view!.taken}\\) ${PI_TASK}\\n`));
  assert.ok(!page.includes("<optchat-view>") && !page.includes(ASK), "the view's lines stay out of the chat");

  // A restart: every thread opens again with the same first message, sent once.
  const before = { pi: (await history(pi!.id)).events, claude: (await history(claude!.id)).events };
  await app.close();
  ({ app, base } = await start());
  // Every open thread opens again, as cubed does at start.
  await app.conversations.boot();
  assert.ok(app.conversations.agentOpen(pi!.id) && app.conversations.agentOpen(claude!.id), "both agents opened again");
  assert.equal(app.registry.initialPrompt(pi!.id), piPrompt);
  assert.equal(app.registry.initialPrompt(claude!.id), claudePrompt);
  assert.deepEqual((await history(pi!.id)).events, before.pi, "the pi thread resumes as it was");
  assert.deepEqual((await history(claude!.id)).events, before.claude, "the claude thread resumes as it was");
  assert.equal((await app.conversations.claudeAgent(claude!.id)).state().submissions.length, 1, "the first message is not sent again");
} finally {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("optchat thread view: ok");
