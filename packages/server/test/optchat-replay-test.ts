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
const real = cubeThreads({ registry, conversations: {} as never, catalog: async () => [], runners: () => ({ runners: [] }) as never,
  latestCommits: () => { throw new Error("unused"); } });
const store = new ArtifactStore(path.join(root, "artifacts.sqlite"));
const artifacts = new Artifacts({ store, registry, github: {} as GithubPulls, optchat: async () => null, submit: async () => {} });

const THREAD = "0123456789abcdef-thread";
/** The effects the fakes record; a read-only tool must leave all of them as they were. */
const made = new Map<string, string>();
const tells = new Set<string>();
const archived = new Set<string>();
const effects = () => ({
  threads: made.size, tells: tells.size, archived: archived.size, hooks: JSON.stringify(registry.getProject("demo")!.hooks ?? null),
  revisions: store.list().reduce((sum, artifact) => sum + store.revisions(artifact.id).length, 0),
});
const threads: OptThreads = {
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
  async archive(id) { const already = archived.has(id); archived.add(id); return { already, disk: "machine disk deleted", free: "1 of 1" }; },
  async usage() { return "usage: none"; },
  async observe(ids) { return new Map(ids.map(id => [id, null])); },
  async diagnose() { return "diagnostics: none"; },
  async hooks(project) { return real.hooks!(project); },
  async writeHooks(project, hooks, requestId) { return real.writeHooks!(project, hooks, requestId); },
};

const chat = await OptChat.open({ directory: path.join(root, "chat"), models, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }), threads, artifacts });
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
    projects: { args: {} },
    runners: { args: {} },
    threads: { args: {} },
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
  // A close holds every tool at its start, also one Pi starts at its
  // execute phase (a replay after a restart), until Pi aborts it; then it
  // throws, so it never ran and the next open runs it once.
  const inside = chat as unknown as { closing: boolean };
  let ran = 0;
  const probe = inner.guard({ ...tools.find(tool => tool.name === "projects")!, execute: async () => { ran++; return { content: [] }; } });
  inside.closing = true;
  const sealing = new AbortController();
  const heldCall = probe.execute({} as never, api(900, "call-900"), withAbortSignal(sealing.signal, context));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(ran, 0, "a tool does not start while the chat closes");
  sealing.abort(new Error("sealed"));
  await assert.rejects(heldCall, /sealed/);
  assert.equal(ran, 0, "nor after Pi aborts it");
  inside.closing = false;

  // cube's own spawn, cut off while it resolves the latest commits (git):
  // the abort reaches that step, and no thread is made after it.
  let seen: AbortSignal | undefined;
  const spawning = cubeThreads({ registry, conversations: {} as never, runners: () => ({ runners: [] }) as never,
    catalog: async () => [{ provider: "faux", id: "faux-1" }] as never,
    // Its git ends as the abort comes, with commits: the abort still decides.
    latestCommits: (_project, signal) => { seen = signal; return new Promise(resolve => { signal?.addEventListener("abort", () => resolve({ projectRevision: 1, repositories: [] } as never), { once: true }); }); } });
  const cutting = new AbortController();
  const started = spawning.spawn({ project: "demo", task: "cut" }, "optchat:cut:0", cutting.signal);
  await new Promise(resolve => setImmediate(resolve));
  cutting.abort(new Error("optchat is closing"));
  await assert.rejects(started, /optchat is closing/);
  assert.equal(seen, cutting.signal, "spawn gives its signal to the git step");
  assert.equal(registry.threadByRequest("demo", "optchat:cut:0"), null, "and makes no thread after the abort");
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
