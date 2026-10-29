/** OptChat's spawn with cubed's own pieces (real registry, latestCommitsOf,
 * cubeThreads and a real GitService over local upstreams) and a git whose
 * network commands take DELAY_MS, as GitHub's do: one call's tasks fetch a
 * project's latest commits once, not once per task, and a new call fetches
 * again. The first two take the runner's two slots and the rest queue in
 * the order asked; a replay fetches nothing; a failed fetch fails that
 * project's tasks only. The timing lines say where the time went. Only the
 * threads' machines are fakes (activate is recorded, never run). */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { Harness, TaskId, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { defaultRunner, GitService, type ProcessRunner } from "@cube/git";
import { Artifacts } from "../src/artifact-service.ts";
import { ArtifactStore } from "../src/artifacts.ts";
import type { GithubPulls } from "../src/github-pulls.ts";
import { latestCommitsOf } from "../src/index.ts";
import { OptChat, type OptThreads } from "../src/optchat.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import { Registry } from "../src/registry.ts";

const DELAY_MS = 100;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-spawn-batch-"));
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function upstream(name: string) {
  const dir = path.join(root, `${name}.git`);
  sh(root, "init", "-q", "--bare", "-b", "main", dir);
  const work = path.join(root, `${name}-work`);
  sh(root, "clone", "-q", dir, work);
  sh(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one");
  sh(work, "push", "-q", "origin", "HEAD:main");
  return { url: dir, work, head: () => sh(dir, "rev-parse", "main") };
}
const a = upstream("a"), b = upstream("b");

// The network commands, each held DELAY_MS; how many run on one mirror at once.
const network: string[] = [];
let running = 0, most = 0;
const runner: ProcessRunner = async (file, args, opts) => {
  const command = args[4] === "--git-dir" ? args[6]! : args[4]!;
  if (command === "ls-remote" || command === "remote" || command === "clone") {
    network.push(command);
    most = Math.max(most, ++running);
    try {
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
      return await defaultRunner(file, args, opts);
    } finally { running--; }
  }
  return defaultRunner(file, args, opts);
};
const git = new GitService(path.join(root, "repos"), runner);

// cubed's log lines, read back for their timing fields.
const lines: string[] = [];
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
  lines.push(String(chunk));
  return write(chunk, ...rest);
}) as typeof process.stdout.write;
const field = (line: string, key: string) => Number(new RegExp(` ${key}=(\\d+)`).exec(line)?.[1] ?? NaN);

const registry = new Registry(path.join(root, "registry.sqlite"));
registry.enrollRunner({ nodeId: "node-a", threadId: "a", environmentId: 1, configPath: "/private/a.json", configHash: "a", maxActiveVms: 2, protocol: 4, kind: "vm" });
const project = (id: string, url: string) => registry.saveProject({ id, name: id, status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [
  { id: `${id}-r`, projectId: id, position: 0, url, base: null, checkoutName: id, status: "ready", error: null, resolvedBase: "main", baseOid: "0".repeat(40), checkedAt: 1 }] });
project("a", a.url);
project("b", b.url);
project("gone", path.join(root, "missing.git"));
// The project check that made the projects ready cloned their mirrors.
await git.prepareRepository(a.url);
await git.prepareRepository(b.url);

const activated: string[] = [];
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage("ok")));
const models = createModels();
models.setProvider(faux.provider);
const threads = {
  ...cubeThreads({ registry, conversations: { activate: async (id: string) => { activated.push(id); } } as never,
    catalog: async () => [{ provider: "faux", id: "faux-1" }] as never, runners: () => ({ runners: [] }) as never,
    latestCommits: latestCommitsOf({ registry, git, skills: () => ({ sources: [], disabled: [] }), skillSource: null }) }),
  // The watcher OptChat sets on each thread reads nothing here.
  events: async () => null, startFailure: () => null, onStartFailure: () => () => {}, onRunFeed: () => () => {},
} as unknown as OptThreads;
const store = new ArtifactStore(path.join(root, "artifacts.sqlite"));
const artifacts = new Artifacts({ store, registry, github: {} as GithubPulls, optchat: async () => null, submit: async () => {} });
const chat = await OptChat.open({ directory: path.join(root, "chat"), models, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }), threads, artifacts });
try {
  const inner = chat as unknown as { harness: Harness; extension(): { tools: ToolRegistration[] } };
  const spawn = inner.extension().tools.find(tool => tool.name === "spawn")!;
  const conversationId = chat.agent.conversation.id;
  let task = 0;
  const call = async (tasks: Array<{ project: string; task: string }>, callId = `call-${++task}`) => {
    network.length = 0;
    lines.length = 0;
    const api = { taskId: task as TaskId, callId, conversationId,
      commit: (change: (tx: never) => unknown, context: typeof BACKGROUND_CONTEXT) => inner.harness.commit(async tx => change(tx as never), context) } as unknown as ToolExecutionApi;
    const started = performance.now();
    const result = await spawn.execute({ tasks } as never, api, BACKGROUND_CONTEXT) as { output: Array<{ text: string }> };
    return { text: result.output.map(part => part.text).join(""), ms: performance.now() - started };
  };
  const ids = (text: string) => [...text.matchAll(/^\[([0-9a-f]{8})\] started/gm)].map(match => match[1]!);
  const thread = (short: string) => registry.listThreads().find(each => each.id.startsWith(short))!;

  // Five tasks in one project, as on Oct 29: one ls-remote and one fetch.
  const five = await call(Array.from({ length: 5 }, (_, k) => ({ project: "a", task: `task ${k + 1}` })), "five");
  const started = ids(five.text);
  assert.equal(started.length, 5, five.text);
  assert.deepEqual(network, ["ls-remote", "remote"], "one call fetches a project once, not once per task");
  assert.deepEqual(started.map(id => thread(id).allocation.repositories[0]!.baseOid), Array(5).fill(a.head()), "every thread starts at the commit fetched");
  assert.deepEqual(activated.map(id => id.slice(0, 8)), started, "each thread's start is set off, in order, not awaited");
  assert.deepEqual(started.map(id => !!thread(id).vm?.suspension), [false, false, true, true, true], "two take the runner's slots, three queue in the order asked");
  const fetched = lines.filter(line => line.includes("threads repository fetched"));
  assert.equal(fetched.length, 1);
  for (const key of ["lockMs", "lsRemoteMs", "fetchMs", "resolveMs"]) assert.ok(Number.isFinite(field(fetched[0]!, key)), `repository fetched has ${key}`);
  assert.ok(field(fetched[0]!, "lsRemoteMs") >= DELAY_MS - 5 && field(fetched[0]!, "fetchMs") >= DELAY_MS - 5, "the network stages carry the delay");
  const created = lines.filter(line => line.includes("threads thread created"));
  assert.deepEqual(created.map(line => / sharedCommits=(\w+)/.exec(line)?.[1]), ["false", "true", "true", "true", "true"]);
  assert.match(lines.find(line => line.includes("optchat spawn answered"))!, / tasks=5 fetches=1 commitMs=\d+ ms=\d+/);
  console.log(`spawn of 5 tasks, ${DELAY_MS} ms per network git command: ${Math.round(five.ms)} ms, network ${JSON.stringify(network)}`);

  // A replay of the call finds its threads and fetches nothing.
  const replay = await call(Array.from({ length: 5 }, (_, k) => ({ project: "a", task: `task ${k + 1}` })), "five");
  assert.deepEqual(ids(replay.text), started);
  assert.deepEqual(network, [], "a replay fetches nothing");

  // A new call fetches again: it starts at what was pushed since.
  sh(a.work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "two");
  sh(a.work, "push", "-q", "origin", "HEAD:main");
  const again = await call([{ project: "a", task: "later 1" }, { project: "a", task: "later 2" }]);
  assert.deepEqual(network, ["ls-remote", "remote"]);
  assert.deepEqual(ids(again.text).map(id => thread(id).allocation.repositories[0]!.baseOid), [a.head(), a.head()], "a new call starts at the new commit");

  // Projects in one call: each fetched once; a failed fetch fails its own tasks, once.
  const mixed = await call([{ project: "a", task: "m1" }, { project: "gone", task: "m2" }, { project: "b", task: "m3" }, { project: "gone", task: "m4" }, { project: "a", task: "m5" }]);
  assert.deepEqual(network.filter(command => command === "ls-remote").length, 3, "a, gone and b: one discovery each");
  assert.equal(ids(mixed.text).length, 3, mixed.text);
  assert.equal(mixed.text.match(/not started: fetching the latest default branch of .*missing\.git failed, so no thread was started/g)?.length, 2, mixed.text);

  // A project check (or the UI's new thread) on the same mirror waits its
  // turn behind a spawn's fetch: one network git at a time, and its lock wait is logged.
  most = 0;
  const spawning = call([{ project: "a", task: "c1" }, { project: "a", task: "c2" }]);
  while (!(network as string[]).includes("ls-remote")) await new Promise(resolve => setTimeout(resolve, 1));
  const checked = latestCommitsOf({ registry, git, skills: () => ({ sources: [], disabled: [] }), skillSource: null })("a");
  await Promise.all([spawning, checked]);
  assert.equal(most, 1, "one network git at a time on a mirror");
  const waits = lines.filter(line => line.includes("threads repository fetched")).map(line => field(line, "lockMs"));
  assert.equal(waits.length, 2);
  assert.ok(waits[1]! >= DELAY_MS - 5, `the second waited for the first's fetch: ${waits.join(", ")} ms`);
  console.log("spawn batch ok: one fetch per project per call, fresh per call, replay fetches nothing, failures per project, FIFO queue and lock kept");
} finally {
  process.stdout.write = write;
  await chat.close();
  registry.close();
  fs.rmSync(root, { recursive: true, force: true });
}
