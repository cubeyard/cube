/** End to end: OptChat's history tool over real stores via Conversations.storedHistory. */
import fs from "node:fs";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { Conversations } from "../src/conversation.ts";
import type { Registry } from "../src/registry.ts";
import type { ThreadMachines } from "../src/vm.ts";
import { OptChat, type OptThreads } from "../src/optchat.ts";
import { cubeThreads } from "../src/optchat-threads.ts";

const context = BACKGROUND_CONTEXT;
const data = "/workspace/packages/server/.bench/data";
const PI = "abcdef12-0000-4000-8000-000000000001", CL = "bbcdef12-0000-4000-8000-000000000002";
const root = fs.mkdtempSync("/workspace/packages/server/.bench/run-");
const threadsDir = path.join(root, "threads");
fs.mkdirSync(threadsDir);
fs.symlinkSync(path.join(data, "pi"), path.join(threadsDir, PI));
fs.symlinkSync(path.join(data, "claude"), path.join(threadsDir, CL));
const thread = (id: string, agent: string) => ({ id, projectId: "p", agent, archived: true, title: "t", workspaceState: "releasing", vm: { retain: true } });
const records: Record<string, unknown> = { [PI]: thread(PI, "pi"), [CL]: thread(CL, "claude-code") };
const registry = { getThread: (id: string) => records[id] ?? null, getProject: () => ({ name: "cube" }), runnerSlots: () => ({ free: 1, total: 1 }) } as unknown as Registry;
const conversations = new Conversations({ registry, directory: threadsDir, models: createModels(), machines: {} as ThreadMachines });
const real = cubeThreads({ registry, conversations, catalog: async () => [], runners: () => ({}) as never });
const timings: string[] = [];
const threads: OptThreads = { ...real, async spawn(task) { return task.task === "pi" ? { id: PI, title: "pi" } : { id: CL, title: "claude" }; },
  async history(id) { const s = performance.now(); const r = await real.history(id); timings.push(`threads.history ${id.slice(0, 2)} ${(performance.now() - s).toFixed(0)}ms`); return r; } };
const faux = fauxProvider({ tokensPerSecond: 1e9 });
const marks: number[] = [];
let script: Array<() => ReturnType<typeof fauxAssistantMessage>> = [];
faux.setResponses(Array.from({ length: 60 }, () => async request => {
  const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
  if (system.includes("You write the memory of OptChat")) return fauxAssistantMessage("summary");
  marks.push(performance.now());
  return script.shift()!();
}));
const models = createModels();
models.setProvider(faux.provider);
const chat = await OptChat.open({ directory: path.join(root, "optchat"), models, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }), threads, limits: { node: 64, retryMs: 50, watchMs: 50 } });
try {
  const call = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) => () => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
  script = [
    call("spawn", { tasks: [{ project: "cube", task: "pi" }, { project: "cube", task: "claude" }] }, "s"),
    call("history", { id: "abcdef12", limit: 5 }, "h1"),
    call("history", { id: "bbcdef12", limit: 5 }, "h2"),
    call("history", { id: "abcdef12", limit: 5 }, "h3"),
    call("history", { id: "bbcdef12", limit: 5 }, "h4"),
    () => fauxAssistantMessage("done"),
  ];
  await chat.send("go", "r1");
  for (let k = 0; k < 2000 && script.length; k++) await new Promise(resolve => setTimeout(resolve, 10));
  await chat.agent.conversation.waitForIdle(context);
  console.log(timings.join("\n"));
  console.log("model-call gaps (tool round trips):", marks.slice(1).map((mark, k) => (mark - marks[k]!).toFixed(0)).join(" "));
} finally { await chat.close(); fs.rmSync(root, { recursive: true, force: true }); }
