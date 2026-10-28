/** An artifact is handed on by its whole id and link, never a short id, at
 * each boundary an agent reports it across: over a real store with a fake
 * registry and stand-in threads, no network.
 *
 *   1. A Claude Code thread's artifact_write and artifact_edit through the
 *      workspace socket's tool route (cube-tools.ts): the text the model
 *      reads names the artifact by its whole id and link, and its comments
 *      by "[artifact <id>]".
 *   2. OptChat's artifact_read and artifact_write given a short id, a link
 *      or a path instead of the id: refused, naming the artifact by its id
 *      and link, nothing written; a title, a too short prefix or another
 *      project's artifact names nothing. The list links each artifact.
 *   3. A thread's report to OptChat, from its live transcript and from its
 *      stored history, ends with the artifacts the run wrote by id and link,
 *      as cube recorded the writes, whatever the reply called them; the link
 *      opens the artifact in its project. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { Artifacts } from "../src/artifact-service.ts";
import { ArtifactStore, type ArtifactAuthor } from "../src/artifacts.ts";
import { artifactTools } from "../src/artifact-tools.ts";
import { piTool, toolsRoute, type CubeTool } from "../src/cube-tools.ts";
import type { GithubPulls } from "../src/github-pulls.ts";
import { OptChat, type OptThreads, type ThreadRecord } from "../src/optchat.ts";
import type { Registry } from "../src/registry.ts";
import type { ThreadEvent, ThreadStatus, ThreadTranscript } from "../src/thread-events.ts";
import type { HistoryPage } from "../src/thread-history.ts";
import type { WorkspaceLease } from "../src/workspace.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-artifact-links-"));
const projects = [{ id: "p", name: "cube", repositories: [] }, { id: "q", name: "luna", repositories: [] }];
const LIVE = "f1f1f1f1-0000-4000-8000-000000000001", STORED = "f2f2f2f2-0000-4000-8000-000000000002", OUTSIDER = "f3f3f3f3-0000-4000-8000-000000000003";
const registry = {
  getThread: (id: string) => [LIVE, STORED, OUTSIDER].includes(id) ? { id, title: id.slice(0, 8), projectId: id === OUTSIDER ? "q" : "p", archived: false, createdAt: 0 } : null,
  getProject: (id: string) => projects.find(project => project.id === id) ?? null,
  listProjects: () => projects,
} as unknown as Registry;
const github = { async pull() { throw new Error("no network") }, async merge() { throw new Error("no network") } } as unknown as GithubPulls;
const store = new ArtifactStore(path.join(root, "artifacts.sqlite"));
const artifacts = new Artifacts({ store, registry, github, optchat: async () => null, submit: async () => {} });
const thread = (id: string): ArtifactAuthor => ({ kind: "thread", thread: id });

/** A Claude Code thread's cube tools, called as its mod calls them: over the socket's tool route. */
function claude(id: string) {
  const tools: CubeTool[] = artifactTools({ artifacts, author: thread(id), agent: "claude-code", readable: async () => [thread(id)] });
  const lease = async () => ({ token: "t", owner: "claude-code", epoch: 1, expiresAt: null }) as WorkspaceLease;
  return async (name: string, call: string, input: Record<string, unknown>) => {
    const answer = await toolsRoute({ method: "POST", name, token: "t", body: { call, input }, signal: new AbortController().signal }, lease, () => tools);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    return (answer.body as { text: string }).text;
  };
}
/** OptChat's artifact tools as Pi offers them, reading its own and its threads' artifacts. */
let calls = 0;
const chatTools = Object.fromEntries(artifactTools({ artifacts, author: { kind: "optchat" }, agent: "optchat", projects: true,
  readable: async () => [{ kind: "optchat" }, thread(LIVE), thread(STORED)] }).map(tool => [tool.name, piTool(tool, api => `chat-${api.callId}`)]));
const chat = async (name: string, args: Record<string, unknown>) => {
  const result = await chatTools[name]!.execute(args as never, { callId: `c${++calls}` } as unknown as ToolExecutionApi, {} as never);
  return (result as { output: Array<{ text: string }> }).output.map(part => part.text).join("");
};
const createdId = (said: string) => /^artifact ([0-9a-f-]{36}) /.exec(said)![1]!;

// ------------------------------------------------ 1. a Claude Code thread's write and edit
const live = claude(LIVE);
const wrote = await live("artifact_write", "toolu_live_write", { body: "# import av samtaler\n\nsynthetic plan" });
const id = createdId(wrote);
assert.equal(wrote, `artifact ${id} "import av samtaler" created at revision 1. The user opens it at #/a/${id} (link it in your reply as [import av samtaler](#/a/${id})); `
  + `their comments come back to you as a message starting "[artifact ${id}]".`);
assert.match(await live("artifact_edit", "toolu_live_edit", { id, old_string: "synthetic plan", new_string: "synthetic plan, revised" }),
  new RegExp(`^artifact ${id} "import av samtaler" wrote revision 2\\. The user opens it at #/a/${id} `));
assert.equal(store.revision(id, 2)!.provenance.call, "toolu_live_edit");
console.log("ok: a Claude Code thread's artifact_write and artifact_edit answer the whole id and link, comments by [artifact <id>]");

// ------------------------------------------------ 2. OptChat given a short id, a link or a path
const stored = claude(STORED);
const notes = createdId(await stored("artifact_write", "toolu_stored_notes", { body: "# stored notes\n\nsynthetic" }));
const plan = createdId(await stored("artifact_write", "toolu_stored_plan", { body: "# another plan\n\nsynthetic" }));
const matches = (artifact: string, title: string, by: string) => `${artifact} "${title}" by thread [${by.slice(0, 8)}] (#/a/${artifact})`;
assert.equal(await chat("artifact_read", { id: id.slice(0, 8) }),
  `no artifact ${id.slice(0, 8)} you can read: an artifact's id is its whole uuid, not a short id or a link. ${id.slice(0, 8)} matches ${matches(id, "import av samtaler", LIVE)}. Ask again with that id.`);
for (const form of [`#/a/${id}`, `#/a/${id}?rev=1`, `/cube/artifacts/${id}.md`, id.slice(0, 13).toUpperCase()]) {
  assert.match(await chat("artifact_read", { id: form }), new RegExp(`matches ${id} "import av samtaler" .*Ask again with that id\\.$`), form);
}
assert.equal(await chat("artifact_read", { id: "import av samtaler" }), "no artifact import av samtaler you can read", "a title names nothing");
assert.equal(await chat("artifact_read", { id: "f1f1" }), "no artifact f1f1 you can read", "too short a prefix names nothing");
// Written by a short id: refused with the id, nothing written.
const head = store.get(id)!.head;
assert.match(await chat("artifact_write", { id: id.slice(0, 8), body: "# overwritten" }), new RegExp(`^not written: no artifact ${id.slice(0, 8)} you can read: .* matches ${id} `));
assert.match(await chat("artifact_edit", { id: id.slice(0, 8), old_string: "plan", new_string: "x" }), new RegExp(`^not written: no artifact ${id.slice(0, 8)} you can read: .* matches ${id} `));
assert.equal(store.get(id)!.head, head);
assert.equal(store.list().filter(item => item.title === "overwritten").length, 0, "nothing created");
// Another project's artifact is not named to a thread of this one: as if there were none.
const luna = createdId(await claude(OUTSIDER)("artifact_write", "toolu_outsider", { body: "# luna notes" }));
assert.equal(await live("artifact_read", "toolu_live_read", { id: luna.slice(0, 8) }), `no artifact ${luna.slice(0, 8)} you can read`);
assert.equal(await live("artifact_read", "toolu_live_read2", { id: `#/a/${luna}` }), `no artifact #/a/${luna} you can read`);
// The id reads; the list links every artifact.
assert.match(await chat("artifact_read", { id }), new RegExp(`^artifact ${id} "import av samtaler" · revision 2 of 2 · by thread \\[f1f1f1f1\\] · project cube · open it at #/a/${id}\\n`));
const list = (await chat("artifact_read", {})).split("\n");
for (const [artifact, title] of [[id, "import av samtaler"], [notes, "stored notes"], [plan, "another plan"]] as const) {
  assert.ok(list.some(line => line.startsWith(`${artifact} "${title}" · revision `) && line.endsWith(` · #/a/${artifact}`)), list.join("\n"));
}
console.log("ok: OptChat given a short id, a link or a path is told the artifact's whole id and link and reads or writes nothing; a title, a short prefix or another project's artifact names nothing; the list links each");

// ------------------------------------------------ 3. a thread's report hands OptChat the ids
{
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const model = { provider: faux.getModel().provider, id: faux.getModel().id };
  const done: ThreadStatus = { state: "completed", run: "run-1", error: null };
  const call = (callId: string, name: string): ThreadEvent => ({ type: "tool-call", id: callId, callId, name, input: {}, final: true });
  const reply = (text: string): ThreadEvent => ({ type: "assistant-text", id: `a-${text.length}`, text, reasoning: false, final: true });
  // LIVE's open feed: its run wrote revisions 1 and 2; the reply names it by a short id.
  const transcript: ThreadTranscript = { agent: "claude-code", owner: "claude-code", status: done, events: [
    { type: "user-message", id: "u", text: "write the plan" }, call("toolu_live_write", "mcp__cube__artifact_write"), call("toolu_live_edit", "mcp__cube__artifact_edit"),
    reply(`Done: the plan is artifact ${id.slice(0, 8)}.`)] };
  // STORED's agent is closed: its stored history, the message it answered first.
  const history: ThreadEvent[] = [{ type: "user-message", id: "u", text: "write notes" }, call("toolu_stored_notes", "mcp__cube__artifact_write"),
    call("toolu_stored_plan", "mcp__cube__artifact_write"), reply("notes written")];
  const page = (request?: { limit?: number }): HistoryPage => {
    const events = history.slice(-(request?.limit ?? history.length));
    return { agent: "claude-code", owner: null, status: done, total: history.length, answer: { index: 3, text: "notes written" }, asked: 0, start: history.length - events.length, events };
  };
  const ids = [LIVE, STORED];
  let spawned = 0;
  const threads: OptThreads = { startFailure: () => null, onStartFailure: () => () => {}, onRunFeed: () => () => {},
    projects: async () => "", runners: async () => "", describe: async () => "", tell: async () => {},
    spawn: async () => { const next = ids[spawned++]!; return { id: next, title: next.slice(0, 8) }; },
    events: async thread => thread === STORED ? "stored" : {
      read: async () => transcript,
      watch: async listener => { await listener(transcript); return { stop: async () => {}, closed: new Promise<void>(() => {}) }; },
    },
    history: async (_thread, request) => ({ transcript: page(request) }) as unknown as ThreadRecord,
  };
  const reports: string[] = [];
  const textOf = (message: Message) => typeof message.content === "string" ? [message.content] : message.content.map(part => part.type === "text" ? part.text : "");
  faux.setResponses(Array.from({ length: 100 }, () => (request: { messages: Message[] }) => {
    const system = request.messages.find(message => message.role === "system");
    if (system && textOf(system).join("").includes("You write the memory of OptChat")) return fauxAssistantMessage("summary");
    if (request.messages.at(-1)?.role !== "user") return fauxAssistantMessage("noted");
    const taken = request.messages.filter(message => message.role === "user").flatMap(textOf).filter(part => !part.includes("<chat>"));
    for (const part of taken) if (/^\[[0-9a-f]{8}\] /.test(part) && !reports.includes(part)) reports.push(part);
    if (taken.some(part => part.includes("start two threads"))) {
      return fauxAssistantMessage([fauxToolCall("spawn", { tasks: ids.map((_, n) => ({ project: "cube", task: `task ${n}` })) }, { id: "call-spawn" })], { stopReason: "toolUse" });
    }
    return fauxAssistantMessage("noted");
  }));
  const optchat = await OptChat.open({ directory: path.join(root, "optchat"), models, model: async () => model, threads, artifacts, limits: { node: 64, retryMs: 50, watchMs: 50 } });
  const reportOf = (thread: string) => reports.find(part => part.startsWith(`[${thread.slice(0, 8)}] `));
  try {
    await optchat.send("start two threads", "u1");
    for (let k = 0; k < 500 && !(reportOf(LIVE) && reportOf(STORED)); k++) await delay(10);
    assert.equal(reportOf(LIVE), `[f1f1f1f1] ended its turn; nothing of it runs now: Done: the plan is artifact ${id.slice(0, 8)}.
artifacts it wrote in this turn, as cube recorded them (link these, by id):
- [import av samtaler](#/a/${id}): artifact ${id}, revision 2`);
    assert.equal(reportOf(STORED), `[f2f2f2f2] ended its turn; nothing of it runs now: notes written
artifacts it wrote in this turn, as cube recorded them (link these, by id):
- [another plan](#/a/${plan}): artifact ${plan}, revision 1
- [stored notes](#/a/${notes}): artifact ${notes}, revision 1`);
    // The handed-over link opens the artifact, in its project, for the chat.
    const linked = /#\/a\/([0-9a-f-]{36})/.exec(reportOf(LIVE)!)![1]!;
    assert.match(await chat("artifact_read", { id: linked }), new RegExp(`^artifact ${id} "import av samtaler" · revision 2 of 2 · by thread \\[f1f1f1f1\\] · project cube · open it at #/a/${id}\\n`));
    assert.equal(artifacts.view(linked)?.artifact.project?.name, "cube");
  } finally { await optchat.close(); }
  console.log("ok: a thread's report, live or stored, ends with the artifacts its run wrote by id and link, and the link opens the artifact in its project");
}
store.close();
fs.rmSync(root, { recursive: true, force: true });
process.exit(0);
