/** OptChat's spawn answers once its threads are accepted, with cubed's own
 * pieces (createCubed, its Conversations, latestCommitsOf over a real
 * GitService, cubeThreads and OptChat's store) on local guests:
 *
 *   - five tasks in a project whose upstream holds its answer (real git
 *     over an ssh stand-in that waits while a hold file exists) are
 *     answered while it still holds: two take the runner's two slots and
 *     share one fetch, three queue in the order asked and fetch nothing;
 *   - a replay answers the same threads and starts nothing;
 *   - one call mixing a working project on a named runner, a project whose
 *     upstream is gone, an unknown project and an unknown model: the
 *     unknown project is refused, the rest accepted; the working ones start,
 *     the gone one fails in its commits step, the unknown model's in its
 *     model step;
 *   - a start failure that lasts reaches the chat once, also after the
 *     chat is opened again.
 *
 * The timing lines say where the time went. Disposable state. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { Harness, TaskId, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { createCubed } from "../src/index.ts";
import { OptChat } from "../src/optchat.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import { LocalMachines } from "./local-guest.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-spawn-accept-"));
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function upstream(name: string) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir);
  sh(dir, "init", "-q", "--initial-branch=main");
  sh(dir, "commit", "-q", "--allow-empty", "-m", "one");
  return { url: dir, head: () => sh(dir, "rev-parse", "main") };
}
const a = upstream("a"), b = upstream("b");

const hold = path.join(root, "hold");
const sshLog = path.join(root, "ssh.log");
const ssh = path.join(root, "ssh");
fs.writeFileSync(ssh, `#!/bin/sh\necho "$2" >> "${sshLog}"\nwhile [ -e "${hold}" ]; do sleep 0.02; done\nexec sh -c "$2"\n`, { mode: 0o755 });
process.env.GIT_SSH_COMMAND = ssh;
process.env.GIT_SSH_VARIANT = "simple";
const connections = () => fs.existsSync(sshLog) ? fs.readFileSync(sshLog, "utf8").split("\n").filter(Boolean).length : 0;

// cubed's log lines, read back for their timing fields.
const lines: string[] = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
  lines.push(String(chunk));
  return write(chunk, ...rest);
}) as typeof process.stdout.write;
const field = (line: string | undefined, key: string) => Number(new RegExp(` ${key}=(\\d+)`).exec(line ?? "")?.[1] ?? NaN);

const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 100 }, () => fauxAssistantMessage("noted")));
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, id: faux.getModel().id };
const app = await createCubed({ state: path.join(root, "state"), models, machines: new LocalMachines(path.join(root, "machines")), claude: null, gateway: null });
app.registry.enrollRunner({ nodeId: "node-pool", threadId: "pool", environmentId: 1, configPath: "/private/pool.json", configHash: "pool", maxActiveVms: 2, protocol: 4, kind: "vm" });
app.registry.enrollRunner({ nodeId: "node-named", threadId: "named", environmentId: 2, configPath: "/private/named.json", configHash: "named", maxActiveVms: 10, protocol: 4, kind: "host" });
const project = (id: string, url: string) => app.registry.saveProject({ id, name: id, status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [
  { id: `${id}-r`, projectId: id, position: 0, url, base: null, checkoutName: id, status: "ready", error: null, resolvedBase: "main", baseOid: "0".repeat(40), checkedAt: 1 }] });
project("a", `ssh://stand-in${a.url}`);
project("b", b.url);
project("gone", path.join(root, "missing"));

const threads = cubeThreads({ registry: app.registry, conversations: app.conversations, catalog: () => [model], runners: () => ({ runners: [] }) as never });
const chatAt = () => OptChat.open({ directory: path.join(root, "chat"), models, model: async () => model, threads, limits: { node: 64, retryMs: 50, watchMs: 20, startGraceMs: 200 } });
let chat = await chatAt();
const thread = (short: string) => app.registry.listThreads().find(each => each.id.startsWith(short))!;
const commitSteps = (short: string) => (thread(short).vm?.steps ?? []).filter(step => step.name === "commits").map(step => step.state);
async function until(what: string, check: () => boolean | Promise<boolean>, ms = 30_000) {
  for (const deadline = Date.now() + ms; !(await check()); await delay(25)) assert.ok(Date.now() < deadline, what);
}
/** The chat's messages under `requestId`: waiting or placed. */
async function sent(requestId: string): Promise<number> {
  const pending = (await chat.pending()).filter(item => item.requestId === requestId).length;
  const placed = await chat.agent.conversation.commit(async tx => !!await tx.submissionByRequest(chat.agent.conversation.id, requestId), context);
  return pending + (placed ? 1 : 0);
}
let calls = 0;
const call = async (tasks: Array<{ project: string; task: string; model?: string; runner?: string }>, callId = `call-${++calls}`) => {
  const inner = chat as unknown as { harness: Harness; extension(): { tools: ToolRegistration[] } };
  const spawn = inner.extension().tools.find(tool => tool.name === "spawn")!;
  const api = { taskId: calls as TaskId, callId, conversationId: chat.agent.conversation.id,
    commit: (change: (tx: never) => unknown, at: typeof context) => inner.harness.commit(async tx => change(tx as never), at) } as unknown as ToolExecutionApi;
  lines.length = 0;
  const started = performance.now();
  const result = await spawn.execute({ tasks } as never, api, context) as { output: Array<{ text: string }> };
  return { text: result.output.map(part => part.text).join(""), ms: performance.now() - started };
};
const ids = (text: string) => [...text.matchAll(/^\[([0-9a-f]{8})\] accepted in /gm)].map(match => match[1]!);

try {
  // Five tasks while upstream holds its answer.
  fs.writeFileSync(hold, "");
  const five = await call(Array.from({ length: 5 }, (_, k) => ({ project: "a", task: `task ${k + 1}` })), "five");
  const accepted = ids(five.text);
  assert.deepEqual(five.text.split("\n").map(line => line.replace(/^\[[0-9a-f]{8}\]/, "[id]")), [1, 2, 3, 4, 5].map(k => `[id] accepted in a: task ${k}`));
  assert.ok(fs.existsSync(hold), "answered while upstream still holds");
  assert.deepEqual(accepted.map(id => !!thread(id).vm?.suspension), [false, false, true, true, true], "two take the runner's slots, three queue in the order asked");
  const since = accepted.slice(2).map(id => { const sleep = thread(id).vm!.suspension!; assert.equal(sleep.state, "queued"); return sleep.since; });
  assert.deepEqual(since, [...since].sort((x, y) => x - y), "queued in the order asked");
  for (const id of accepted) assert.equal(await chat.started(thread(id).id), true, "the chat records each thread");
  const answered = lines.find(line => line.includes("optchat spawn answered"));
  assert.match(answered ?? "", / tasks=5 commitMs=\d+ ms=\d+/);
  const acceptedLines = lines.filter(line => line.includes("threads thread accepted"));
  assert.equal(acceptedLines.length, 5);
  for (const line of acceptedLines) for (const key of ["validateMs", "createMs"]) assert.ok(Number.isFinite(field(line, key)), `thread accepted has ${key}`);
  await until("the two with slots wait in their commits step", () => accepted.slice(0, 2).every(id => commitSteps(id)[0] === "running"));
  await delay(300);
  assert.deepEqual(accepted.map(commitSteps), [["running"], ["running"], [], [], []], "the queued three have not fetched");
  assert.equal(connections(), 1, "one connection under way, shared by both starts");
  console.log(`spawn of 5 tasks while upstream held its answer: ${Math.round(five.ms)} ms (tool), spawn answered ms=${field(answered, "ms")}`);

  // A replay answers the same threads and starts nothing more.
  const replay = await call(Array.from({ length: 5 }, (_, k) => ({ project: "a", task: `task ${k + 1}` })), "five");
  assert.deepEqual(ids(replay.text), accepted);
  assert.equal(app.registry.listThreads().length, 5);

  fs.rmSync(hold);
  await until("the two resolve their commits", () => accepted.slice(0, 2).every(id => commitSteps(id).at(-1) === "ok"));
  assert.deepEqual(accepted.slice(0, 2).map(id => thread(id).allocation.repositories[0]!.baseOid), [a.head(), a.head()]);
  assert.equal(connections(), 2, "ls-remote and fetch, once for both");
  const resolvedLines = lines.filter(line => line.includes("threads commits resolved"));
  assert.equal(resolvedLines.length, 2);
  for (const line of resolvedLines) for (const key of ["ms", "sinceAcceptedMs"]) assert.ok(Number.isFinite(field(line, key)), `commits resolved has ${key}`);
  for (const key of ["repositoriesMs", "skillsMs", "ms"]) assert.ok(Number.isFinite(field(lines.find(line => line.includes("threads latest commits")), key)), `latest commits has ${key}`);
  console.log("ok: five tasks are accepted while upstream holds; two starts share one fetch; three queue and fetch nothing yet; a replay answers the same");

  // One call, mixed tasks.
  const mixed = await call([
    { project: "b", task: "m1", runner: "node-named" }, { project: "gone", task: "m2", runner: "node-named" }, { project: "nowhere", task: "m3" },
    { project: "b", task: "m4", model: "faux/none", runner: "node-named" }, { project: "b", task: "m5", runner: "node-named" }]);
  const mixedLines = mixed.text.split("\n");
  assert.equal(mixedLines.length, 5, mixed.text);
  assert.match(mixedLines[2]!, /^task 3 \(nowhere\) not started: no project nowhere$/);
  assert.match(mixedLines[3]!, /^\[[0-9a-f]{8}\] accepted in b: m4$/, "a model the catalog lacks is the start's to refuse, not the call's");
  const [m1, m2, m4, m5] = ids(mixed.text);
  assert.deepEqual([m1, m2, m5].map(id => thread(id!).runnerId), ["named", "named", "named"], "on the runner named");
  assert.deepEqual([m1, m2, m5].map(id => thread(id!).pinned), [true, true, true]);
  for (const id of [m1!, m5!]) await until(`${id} becomes ready`, () => thread(id).workspaceState === "available");
  assert.deepEqual([m1, m5].map(id => thread(id!).allocation.repositories[0]!.baseOid), [b.head(), b.head()], "started at the latest commit");
  await until("the gone project's start fails", () => thread(m2!).workspaceState === "failed");
  assert.match(thread(m2!).workspaceError!, /^workspace allocation failed: fetching the latest default branch of .*missing failed: /);
  assert.deepEqual(commitSteps(m2!), ["failed"]);
  await until("the unknown model's start fails", () => thread(m4!).workspaceState === "failed");
  assert.match(thread(m4!).workspaceError!, /^workspace allocation failed: model faux\/none is not in the model catalog; selectable models: faux\/faux-1; it holds no runner slot until cube tries again$/);
  console.log("ok: a mixed call refuses an unknown project at once; its working threads start on the runner named; the gone project's fails in the commits step, the unknown model's in the model step");

  // The lasting failure reaches the chat once, and not again from a reopened chat.
  const m2Id = thread(m2!).id;
  await until("the failure is reported", async () => await sent(`report:${m2Id}:start`) === 1);
  await chat.close();
  chat = await chatAt();
  await delay(600);
  assert.equal(await sent(`report:${m2Id}:start`), 1, "once, also after the chat opened again");
  const report = (await chat.pending()).find(item => item.requestId === `report:${m2Id}:start`)?.text
    ?? await chat.agent.conversation.commit(async tx => {
      const submission = await tx.submissionByRequest(chat.agent.conversation.id, `report:${m2Id}:start`);
      const entry = submission?.type === "input" && submission.entry !== undefined ? await tx.entry(submission.entry) : undefined;
      const content = entry?.model?.[0]?.content;
      return typeof content === "string" ? content : Array.isArray(content) ? content.map(part => part.type === "text" ? part.text : "").join("") : "";
    }, context);
  assert.match(report, new RegExp(`^\\[${m2}\\] failed to start for \\d+ s; cubed keeps retrying: workspace allocation failed: fetching the latest default branch of .*missing failed: `));
  console.log("spawn accept ok: answered on acceptance while upstream holds, starts in the background, FIFO, runner named, refusals per task, failures reported once");
} finally {
  fs.rmSync(hold, { force: true });
  process.stdout.write = write;
  await until("no start is under way at the close", () => app.registry.listThreads().every(each => !app.conversations.starting(each.id))).catch(() => {});
  await chat.close();
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
}
