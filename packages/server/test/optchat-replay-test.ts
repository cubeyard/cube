/** Every tool OptChat exposes may run again: a close cuts off a running
 * call, the reopened run executes it again (replay "safe"), and the work of
 * the call cut off may go on. TOOL_REPLAY says how each is safe: `read`
 * changes nothing, `keyed` does its effect once per request id and answers
 * a replay as it answered the first run. Each tool is run twice under the
 * same call and task ids, as a replay is, and must say the same and do its
 * effect at most once. A tool missing from the table fails here and is
 * refused when the chat builds its tools. Production paths (the registry's
 * hooks requests, the artifact store) are real; threads are fakes. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import type { Harness, TaskId, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { Artifacts } from "../src/artifact-service.ts";
import { ArtifactStore } from "../src/artifacts.ts";
import type { GithubPulls } from "../src/github-pulls.ts";
import { OptChat, TOOL_REPLAY, type OptThreads } from "../src/optchat.ts";
import { latestCommitsOf } from "../src/index.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import { Registry } from "../src/registry.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-replay-"));
const context = BACKGROUND_CONTEXT;
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 50 }, () => fauxAssistantMessage("ok")));
const models = createModels();
models.setProvider(faux.provider);

const registry = new Registry(path.join(root, "registry.sqlite"));
registry.saveProject({ id: "demo", name: "demo", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
const real = cubeThreads({ registry, conversations: {} as never, catalog: () => [], runners: () => ({ runners: [] }) as never });
const store = new ArtifactStore(path.join(root, "artifacts.sqlite"));
const artifacts = new Artifacts({ store, registry, github: {} as GithubPulls, optchat: async () => null, submit: async () => {} });

const THREAD = "0123456789abcdef-thread";
/** The effects the fakes record; a read-only tool must leave all of them as they were. */
const made = new Map<string, string>();
const tells = new Set<string>();
const archived = new Set<string>();
/** Threads moved to archived, each time one was; and, when set, a close that
 * cuts the archive call off after cubed archived the thread. */
let archivings = 0;
let cutArchive: AbortController | undefined;
const effects = () => ({
  threads: made.size, tells: tells.size, archived: archived.size, hooks: JSON.stringify(registry.getProject("demo")!.hooks ?? null),
  revisions: store.list().reduce((sum, artifact) => sum + store.revisions(artifact.id).length, 0),
});
const threads: OptThreads = { startFailure: () => null, onStartFailure: () => () => {}, onRunFeed: () => () => {},
  async projects() { return "projects: demo"; }, async runners() { return "no runners"; },
  async spawn(task, requestId) {
    // As the registry's creation table: one thread per request id.
    if (!made.has(requestId)) made.set(requestId, made.size ? `${made.size}${THREAD.slice(1)}` : THREAD);
    return { id: made.get(requestId)!, title: task.task };
  },
  // As Pi's submissions and Claude's table: a request id is taken once.
  async tell(_id, _text, requestId) { tells.add(requestId); },
  async describe(ids) { return ids.map(id => `[${id.slice(0, 8)}] demo`).join("\n"); },
  async events() { return null; },
  async history() { return null; },
  async archive(id) {
    const already = archived.has(id);
    if (!already) archivings++;
    archived.add(id);
    if (cutArchive) { cutArchive.abort(new Error("optchat is closing")); throw cutArchive.signal.reason; }
    return { already, disk: "machine disk deleted", free: "1 of 1" };
  },
  async usage() { return "usage: none"; },
  async observe(ids) { return new Map(ids.map(id => [id, null])); },
  async diagnose() { return "diagnostics: none"; },
  async hooks(project) { return real.hooks!(project); },
  async writeHooks(project, hooks, requestId) { return real.writeHooks!(project, hooks, requestId); },
};

async function until(check: () => boolean, what: string) {
  for (let k = 0; k < 500 && !check(); k++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(check(), what);
}

const skills = { current: () => ({ key: "skills", skills: [], settled: Promise.resolve() }), async read(name: string, file = "SKILL.md") { return `${name}/${file}`; } };
const chat = await OptChat.open({ directory: path.join(root, "chat"), models, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }), threads, artifacts, skills });
try {
  const inner = chat as unknown as { harness: Harness; extension(): { tools: ToolRegistration[] }; guard(tool: ToolRegistration): ToolRegistration };
  const harness = inner.harness;
  const tools = inner.extension().tools;
  const names = tools.map(tool => tool.name).sort();
  assert.deepEqual(names, Object.keys(TOOL_REPLAY).sort(), "every tool the chat exposes has a replay rule, and every rule a tool");
  assert.throws(() => inner.guard({ ...tools[0]!, name: "unlisted" }), /no replay rule/, "a tool without one is refused");

  const conversationId = chat.agent.conversation.id;
  const api = (taskId: number, callId: string) => ({
    taskId: taskId as TaskId, callId, conversationId,
    commit: (change: (tx: never) => unknown, commitContext: typeof context) => harness.commit(async tx => change(tx as never), commitContext),
    // project_hooks_write needs a message of the user in the running run.
    snapshot: async (doc: { definition: { kind: string } }, ...rest: unknown[]) => doc.definition.kind === "cube.optchat.turn" ? { started: false, parts: [], userInputs: [1] }
      : doc.definition.kind === "pi.live" ? { run: { taskId: 0, inputs: ["1"] } }
      : (harness.snapshot as (...args: unknown[]) => Promise<unknown>)(doc, ...rest),
  }) as unknown as ToolExecutionApi;
  const run = async (name: string, args: object, taskId: number, callId: string) => {
    const tool = tools.find(each => each.name === name)!;
    return JSON.stringify(await tool.execute(args as never, api(taskId, callId), context));
  };

  // spawn first: the other thread tools name the thread it starts.
  type Case = { args: object; between?: () => void | Promise<void>; check?: (before: ReturnType<typeof effects>, after: ReturnType<typeof effects>) => void };
  const cases: Record<string, Case> = {
    spawn: { args: { tasks: [{ project: "demo", task: "one" }, { project: "demo", task: "two" }] } },
    zoom: { args: { id: 0, n: 1 } },
    date: { args: { id: 0 } },
    skill: { args: { name: "delegating", path: "notes.md" } },
    projects: { args: {} },
    runners: { args: {} },
    threads: { args: {} },
    archived_threads: { args: { query: "one", limit: 5 } },
    history: { args: { id: THREAD.slice(0, 8) } },
    diagnose: { args: { id: THREAD.slice(0, 8) } },
    usage: { args: {} },
    project_hooks: { args: { project: "demo" } },
    tell: { args: { id: THREAD.slice(0, 8), message: "go on" } },
    archive: { args: { ids: [THREAD.slice(0, 8)] } },
    project_hooks_write: {
      args: { project: "demo", preSetup: "echo from-chat" },
      // The user edits the hooks between the cut and the replay.
      between: () => { registry.saveProjectHooks("demo", { preSetup: "echo users-edit", preResume: "" }); },
      check: (_before, after) => assert.equal(after.hooks, JSON.stringify({ preSetup: "echo users-edit", preResume: "" }), "the replay leaves the user's edit"),
    },
    artifact_write: { args: { title: "Report", body: "# Report\n\nbody" } },
    artifact_read: { args: {} },
    // The report artifact_write wrote.
    artifact_edit: { get args() { return { id: store.list({ authors: [{ kind: "optchat" }] })[0]!.id, old_string: "body", new_string: "edited" }; } },
  };
  assert.deepEqual(Object.keys(cases).sort(), names, "the table covers every tool");
  let task = 100;
  for (const [name, test] of Object.entries(cases)) {
    task++;
    const before = effects();
    const first = await run(name, test.args, task, `call-${task}`);
    const once = effects();
    await test.between?.();
    const again = await run(name, test.args, task, `call-${task}`);
    const after = effects();
    assert.equal(again, first, `${name}: a replay answers as the first run did`);
    if (TOOL_REPLAY[name] === "read") assert.deepEqual(after, before, `${name}: reads only`);
    else {
      assert.notDeepEqual(once, before, `${name}: its first run does its effect`);
      if (test.check) test.check(before, after);
      else assert.deepEqual(after, once, `${name}: a replay does it no more`);
    }
    // A new call is a new request: it may act again (spawn makes new threads).
    if (name === "spawn") {
      await run(name, test.args, ++task, `call-${task}`);
      assert.equal(made.size, 4, "spawn: another call starts other threads");
    }
  }
  // archive cut off after cubed archived the thread and before its line was
  // stored: the replay finds the thread archived by its own first run, so it
  // says "archived", as that run would have; another call says "already".
  const victim = `1${THREAD.slice(1)}`;
  const cut = new AbortController();
  const archive = tools.find(tool => tool.name === "archive")!;
  cutArchive = cut;
  const before = archivings;
  await assert.rejects(archive.execute({ ids: [victim.slice(0, 8)] } as never, api(800, "call-800"), withAbortSignal(cut.signal, context)), /optchat is closing/);
  cutArchive = undefined;
  assert.ok(archived.has(victim) && archivings === before + 1, "the first run archived the thread before the cut");
  const replayed = await run("archive", { ids: [victim.slice(0, 8)] }, 800, "call-800");
  assert.match(replayed, new RegExp(`\\[${victim.slice(0, 8)}\\] archived: machine disk deleted`), "the replay says archived");
  assert.doesNotMatch(replayed, /already/, "not already archived: the archive was its own");
  assert.equal(archivings, before + 1, "and the thread was archived once");
  assert.equal(await run("archive", { ids: [victim.slice(0, 8)] }, 800, "call-800"), replayed, "a second replay says the same");
  assert.match(await run("archive", { ids: [victim.slice(0, 8)] }, 801, "call-801"), /was already archived/, "another call finds it already archived");

  // A close holds every tool at its start, also one Pi starts at its
  // execute phase (a replay after a restart), until Pi aborts it; then it
  // throws, so it never ran and the next open runs it once.
  const inside = chat as unknown as { closing: boolean };
  let ran = 0;
  const probe = inner.guard({ ...tools.find(tool => tool.name === "projects")!, execute: async () => { ran++; return { output: [] }; } });
  inside.closing = true;
  const sealing = new AbortController();
  const heldCall = probe.execute({} as never, api(900, "call-900"), withAbortSignal(sealing.signal, context));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(ran, 0, "a tool does not start while the chat closes");
  sealing.abort(new Error("sealed"));
  await assert.rejects(heldCall, /sealed/);
  assert.equal(ran, 0, "nor after Pi aborts it");
  inside.closing = false;

  // cubed's own latestCommits over a fake git, cut off in each fetch it
  // makes: the repository's (prepareRepository), the installed skills'
  // source and the repository's own skills (ensureMirror). The abort (a
  // closing cubed's, Conversations) reaches the git of each and is rethrown
  // as it came, not as a failed fetch that names it.
  const REPO = "https://github.com/x/fetch.git", SKILLS = "https://github.com/x/skills.git";
  let stall: "prepare" | "skills" | "project" = "prepare";
  const reached = new Map<string, AbortSignal | undefined>();
  // A git that never ends: it stops only on its signal, and fails at once without one.
  const hang = (step: string, signal?: AbortSignal) => {
    reached.set(step, signal);
    if (!signal) return Promise.reject(new Error(`${step} was given no signal`));
    return new Promise<never>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const fetchGit = {
    async prepareRepository(_url: string, _base?: string | null, signal?: AbortSignal) { return stall === "prepare" ? hang("prepare", signal) : { base: "main", baseOid: "a".repeat(40) }; },
    async ensureMirror(url: string, signal?: AbortSignal) { return hang(url === SKILLS ? "skills" : "project", signal); },
    async listFilesAtCommit() { return null; }, async readFileAtCommit() { return null; },
  };
  const allocation = { projectId: "fetch", projectRevision: 1, repositories: [{ url: REPO, base: "main", baseOid: "0".repeat(40), checkoutName: "workspace" }], latest: { bases: ["main"] } };
  for (const step of ["prepare", "skills", "project"] as const) {
    stall = step;
    const latest = latestCommitsOf({ git: fetchGit, skills: () => ({ sources: [], disabled: [] }),
      skillSource: step === "skills" ? { url: SKILLS, commit: "b".repeat(40), path: "skills" } : null });
    const cutting = new AbortController();
    const resolving = latest(allocation, cutting.signal);
    await until(() => reached.has(step), `the ${step} fetch is under way`);
    cutting.abort(new Error("cubed is closing"));
    await assert.rejects(resolving, error => error === cutting.signal.reason, `${step}: the abort is rethrown as it came`);
    assert.equal(reached.get(step), cutting.signal, `${step}: the abort reaches its git`);
  }
  // spawn itself fetches nothing: with every git hanging it accepts the thread.
  stall = "prepare";
  reached.clear();
  registry.enrollRunner({ nodeId: "node-replay", threadId: "replay", environmentId: 1, configPath: "/private/replay.json", configHash: "replay", protocol: 4, kind: "vm" });
  registry.saveProject({ id: "fetch", name: "fetch", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [
    { id: "r1", projectId: "fetch", position: 0, url: REPO, base: "main", checkoutName: "fetch", status: "ready", error: null, resolvedBase: "main", baseOid: "a".repeat(40), checkedAt: 1 }] });
  const activated: string[] = [];
  const accepting = cubeThreads({ registry, conversations: { activate: async (id: string) => { activated.push(id); } } as never, runners: () => ({ runners: [] }) as never,
    catalog: () => [{ provider: "faux", id: "faux-1" }] as never });
  const accepted = await accepting.spawn({ project: "fetch", task: "accept" }, "optchat:accept:0");
  assert.deepEqual(registry.getThread(accepted.id)!.allocation.latest, { bases: ["main"] }, "accepted with its commits still to resolve");
  assert.deepEqual(activated, [accepted.id], "and its start set off");
  assert.equal(reached.size, 0, "no git was asked");
  assert.deepEqual(await accepting.spawn({ project: "fetch", task: "accept" }, "optchat:accept:0"), accepted, "a replay finds the same thread");
  assert.deepEqual(activated, [accepted.id], "and sets off no second start");
  assert.equal(tells.size, 1, "the tell was taken once");
  // And counted once against the thread's TELLS (8): seven other calls go, the next is refused.
  for (let k = 0; k < 7; k++) assert.match(await run("tell", { id: THREAD.slice(0, 8), message: `more ${k}` }, ++task, `call-${task}`), /sent to/);
  assert.match(await run("tell", { id: THREAD.slice(0, 8), message: "one more" }, ++task, `call-${task}`), /not sent: .* had 8 tells/);
} finally {
  await chat.close();
  artifacts.close();
  store.close();
  registry.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("optchat replay: ok");
