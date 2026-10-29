/** A Pi thread's memory section (thread-memory.ts) as Pi's requests carry
 * it, over a real registry: when its first request cannot read OptChat (its
 * own wait runs out on a hung open), the fallback it freezes is written once,
 * in the baseline, and never patched: not when OptChat opens, not after the
 * agent and the registry are opened again. A thread whose first request
 * captures writes its view once the same way. A patch would be a later
 * system entry, which pi-ai folds into the leading prompt for a model without
 * mid-conversation system messages (getCurrentSystemMessage): the whole
 * conversation written to the cache again. Offline: faux model, local guest. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, type Message } from "@earendil-works/pi-ai";
import { openAgent, type Agent } from "../src/durable-agent.ts";
import { Memory } from "../src/optchat-memory.ts";
import { Registry } from "../src/registry.ts";
import { ThreadMemory, type ChatMemory } from "../src/thread-memory.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { LocalGuestTransport } from "./local-guest.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-pi-memory-"));
const file = path.join(root, "registry.sqlite");
let registry = new Registry(file);
registry.saveProject({ id: "p", name: "demo", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
for (const n of [1, 2]) registry.enrollRunner({ nodeId: `node-${n}`, environmentId: n, threadId: `runner-${n}`, configPath: `/private/${n}.json`, configHash: `h${n}`, protocol: 4, kind: "vm" });
const chatMemory = new Memory();
chatMemory.append({ kind: "user", text: "plan the release", date: Date.UTC(2026, 9, 29) });
chatMemory.setNode(0, 0, "user asks for a release plan");
const chat: ChatMemory = { identity: "optchat-a", memory: chatMemory };
let opening: () => Promise<ChatMemory> = () => new Promise<never>(() => {});
let threads = new ThreadMemory({ registry, chat: () => opening(), waitMs: 200 });

/** Each request's system entries' memory writes, by thread directory. */
const writes = new Map<string, Array<Array<string | null | undefined>>>();
let current = "";
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 20 }, () => request => {
  const entries = request.messages.filter((message: Message) => message.role === "system").map(message => (message as { sections?: Record<string, string | null> }).sections ?? {});
  writes.get(current)!.push(entries.filter(sections => "memory" in sections).map(sections => sections.memory));
  return fauxAssistantMessage("ok");
}));
const models = createModels();
models.setProvider(faux.provider);
const guest = new LocalGuestTransport(path.join(root, "guest"));
const open = (name: string, thread: string): Promise<Agent> => {
  const directory = path.join(root, name);
  const workspace = new VmWorkspace({ guest, leases: new LeaseStore(directory), owner: "pi", binding: guest.binding });
  return openAgent({ directory, binding: guest.binding, workspace, models, model: { provider: faux.getModel().provider, id: faux.getModel().id },
    hostTools: () => ({ tools: [], note: "", memory: signal => threads.text(thread, "pi", signal ? { signal } : {}) }) });
};
const turn = async (agent: Agent, name: string, content: string) => {
  current = name;
  if (!writes.has(name)) writes.set(name, []);
  const submission = await agent.conversation.submit({ type: "input", content, requestId: content }, context);
  assert.equal((await submission.wait(context)).status, "done");
};

const model = { provider: "fixture", id: "m" };
const timedOut = registry.createThread("p", "timed-out", model, "x").id;
const captured = registry.createThread("p", "captured", model, "y").id;
let agent = await open("timed-out", timedOut);
try {
  // Its own wait runs out on a hung open: the fallback is the baseline.
  await turn(agent, "timed-out", "first");
  const fallback = String(writes.get("timed-out")![0]![0]);
  assert.match(fallback, /could not be read when this thread started \(OptChat is still opening\)/, "the first request's baseline holds the fallback");
  // OptChat opens: no patch.
  opening = async () => chat;
  await turn(agent, "timed-out", "second");
  // The agent and the registry open again, as after a restart: no patch.
  await agent.close();
  registry.close();
  registry = new Registry(file);
  threads = new ThreadMemory({ registry, chat: () => opening(), waitMs: 200 });
  agent = await open("timed-out", timedOut);
  await turn(agent, "timed-out", "third");
  assert.deepEqual(writes.get("timed-out")!, [[fallback], [fallback], [fallback]], "written once, in the baseline; never patched");
  assert.equal(registry.threadMemory(timedOut)!.text, fallback, "frozen");
  await agent.close();

  // A first request that captures: its view the same way.
  agent = await open("captured", captured);
  await turn(agent, "captured", "first");
  await turn(agent, "captured", "second");
  const view = registry.threadMemory(captured)!.text!;
  assert.match(view, /<chat>\n0\+1\|user asks for a release plan\n<\/chat>$/);
  assert.deepEqual(writes.get("captured")!, [[view], [view]], "the view written once, in the baseline");
  console.log("ok: a pi thread's memory section is written once in its baseline and never patched: a fallback frozen at its own timeout stays through OptChat opening and a restart, a captured view stays");
} finally {
  await agent.close();
  registry.close();
  guest.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
