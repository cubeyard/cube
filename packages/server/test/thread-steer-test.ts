/** OptChat's tell to a working thread is steering, through the production
 * wiring (cubeThreads().tell -> Conversations.submit -> Pi's Harness or
 * ClaudeAgent and the fake `claude`): the message is queued, never a
 * second turn beside the running one, and reaches the agent after the
 * current tool call, which runs to its end. A message that arrives as the
 * run ends continues it; a stop withdraws it and says so; an idle thread
 * still starts a run; an archived one refuses; a run that fails withdraws
 * Pi's queued message and says so; a tell during a Claude stop is refused;
 * a cubed restart keeps Pi's queued message and ends Claude Code's with
 * its reason. Offline: faux model, local guests,
 * the fake CLI (fake-claude.ts), disposable state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { LiveDoc } from "@earendil-works/pi-durable";
import { createCubed } from "../src/index.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import type { ThreadStatus } from "../src/thread-events.ts";
import { LocalMachines } from "./local-guest.ts";

const context = BACKGROUND_CONTEXT;
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-thread-steer-"));

/** Every Pi model request, by the thread's first message: its messages. */
const requests = new Map<string, Message[][]>();
const gates = new Map<string, Promise<void>>();
const release: Record<string, () => void> = {};
const hold = (name: string) => { gates.set(name, new Promise(resolve => { release[name] = resolve; })); };
const faux = fauxProvider({ tokensPerSecond: 1_000_000 });
faux.setResponses(Array.from({ length: 200 }, () => async (request: { messages: Message[] }) => {
  const first = textOf(request.messages.find(message => message.role === "user")!);
  const list = requests.get(first) ?? [];
  list.push(request.messages);
  requests.set(first, list);
  const n = list.length;
  // A tool round first (a command that takes a while), then text.
  if ((first === "pi-tool" || first === "pi-stop" || first === "pi-restart") && n === 1) {
    return fauxAssistantMessage([fauxToolCall("bash", { command: first === "pi-tool" ? "sleep 1.5; echo slept" : "sleep 4; echo slept" })], { stopReason: "toolUse" });
  }
  // A generation held open: a message sent meanwhile arrives as the run ends.
  if (first === "pi-finish" && n === 1) await gates.get("pi-finish");
  // A provider that fails (every retry too) until a later message comes.
  if (first === "pi-fail" && !request.messages.some(message => textOf(message) === "later")) {
    await gates.get("pi-fail");
    return fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider down" });
  }
  return fauxAssistantMessage(`reply ${n} to ${textOf(request.messages.at(-1)!)}`);
}));
const models = createModels();
models.setProvider(faux.provider);
const piModel = { provider: faux.getModel().provider, id: faux.getModel().id };
const claudeModel = { provider: "claude-code", id: "sonnet" };
const state = path.join(root, "state");
fs.mkdirSync(state);

async function open(machines: LocalMachines) {
  const app = await createCubed({ state, models, machines, claude: [process.execPath, path.resolve(import.meta.dirname, "fake-claude.ts")],
    claudeOptions: { stopGraceMs: 2000 }, gateway: null });
  const threads = cubeThreads({ registry: app.registry, conversations: app.conversations, catalog: async () => [piModel], runners: () => ({ runners: [] }) as never,
    latestCommits: async () => ({}) as never });
  return { app, threads };
}
async function until<T>(read: () => T | Promise<T>, check: (value: T) => boolean, what: string, ms = 20_000): Promise<T> {
  for (const deadline = Date.now() + ms; ;) {
    const value = await read();
    if (check(value)) return value;
    assert.ok(Date.now() < deadline, `${what}: ${JSON.stringify(value)?.slice(0, 2000)}`);
    await delay(20);
  }
}

const machinesRoot = path.join(root, "machines");
let machines = new LocalMachines(machinesRoot);
let { app, threads } = await open(machines);
const history = (id: string) => app.conversations.history(id);
const settled = (id: string, run?: string) => until(() => history(id), value => value.status.state !== "working" && value.status.state !== "idle" && (!run || value.status.run === run), `${id.slice(0, 8)} settles`);
/** Every status a thread's watcher sees from now on. */
async function statuses(id: string): Promise<{ seen: ThreadStatus[]; stop(): Promise<void> }> {
  const seen: ThreadStatus[] = [];
  const watch = await (await app.conversations.events(id)).watch(transcript => { seen.push(transcript.status); });
  return { seen, stop: () => watch.stop() };
}
let runners = 0;
const create = (title: string, text: string, model = piModel) => {
  const thread = app.registry.createThread("p", title, model, text, model === piModel ? "pi" : "claude-code", undefined, { runnerId: `r${++runners}` });
  void app.conversations.activate(thread.id);
  return thread.id;
};
const toolRunning = async (id: string) => !!(await (await app.conversations.agent(id)).harness.snapshot(LiveDoc, (await app.conversations.agent(id)).conversation.id, context))?.tools?.some(slot => slot.status === "running");

try {
  // One machine slot each: a thread of its own per runner.
  for (const n of [1, 2, 3, 4, 5, 6]) app.registry.enrollRunner({ nodeId: `node-r${n}`, threadId: `r${n}`, environmentId: n, configPath: `/private/r${n}.json`, configHash: `r${n}`, protocol: 4, kind: "vm" });
  app.registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });

  // --- Pi -------------------------------------------------------------------
  {
    // During a tool call: queued, the tool runs to its end, and the model's
    // next request carries the message right after the tool's result, in
    // the same run.
    const id = create("pi-tool", "pi-tool");
    await until(() => toolRunning(id).catch(() => false), Boolean, "the pi thread's tool runs");
    const run = (await history(id)).status.run;
    assert.equal(await threads.tell(id, "steer A", "optchat:a"), "queued");
    // Another text under the same request id while it waits in Pi's inbox: a conflict.
    await assert.rejects(threads.tell(id, "other", "optchat:a"), /conflicts/);
    assert.equal((await history(id)).status.state, "working", "still the one run");
    const done = await settled(id);
    assert.equal(done.status.state, "completed");
    const sent = requests.get("pi-tool")!;
    assert.equal(sent.length, 2, "one request after the tool round, no second turn");
    const [result, steer] = sent[1]!.slice(-2);
    assert.equal(result!.role, "toolResult");
    assert.match(textOf(result!), /slept/, "the tool ran to its end, not interrupted");
    assert.equal(steer!.role, "user");
    assert.equal(textOf(steer!), "steer A");
    assert.notEqual(run, null);
    // The same tell again (a replayed tool call): the thread has it, nothing is sent again.
    assert.equal(await threads.tell(id, "steer A", "optchat:a"), "consumed");
    await assert.rejects(threads.tell(id, "other", "optchat:a"), /conflicts/);
    await delay(100);
    assert.equal(requests.get("pi-tool")!.length, 2);
    // An idle thread: the tell starts a run, as before.
    assert.equal(await threads.tell(id, "again", "optchat:b"), "started");
    await until(() => history(id), value => value.status.state === "completed" && requests.get("pi-tool")!.length === 3, "the idle thread runs the tell");
    assert.equal(textOf(requests.get("pi-tool")![2]!.at(-1)!), "again");
    // An archived thread refuses it.
    await app.conversations.archive(id);
    await assert.rejects(threads.tell(id, "late", "optchat:c"));
    assert.equal(requests.get("pi-tool")!.length, 3);
  }
  {
    // As the run ends (its last generation out, no tool round left): Pi
    // places it at the final boundary and the same run goes on with it;
    // the thread never shows idle in between.
    hold("pi-finish");
    const id = create("pi-finish", "pi-finish");
    await until(() => requests.get("pi-finish")?.length ?? 0, n => n === 1, "the generation is out");
    const watch = await statuses(id);
    assert.equal(await threads.tell(id, "steer B", "optchat:d"), "queued");
    release["pi-finish"]!();
    const done = await settled(id);
    await watch.stop();
    assert.equal(done.status.state, "completed");
    assert.deepEqual([...new Set(watch.seen.map(status => status.state))], ["working", "completed"], "working until the steered message is answered");
    const sent = requests.get("pi-finish")!;
    assert.equal(sent.length, 2);
    assert.equal(textOf(sent[1]!.at(-1)!), "steer B");
    assert.equal(sent[1]!.at(-2)!.role, "assistant", "after the first answer, in the same run");
  }
  {
    // A stop while one is queued withdraws it, and the run's outcome says so.
    const id = create("pi-stop", "pi-stop");
    await until(() => toolRunning(id).catch(() => false), Boolean, "the pi thread's tool runs");
    assert.equal(await threads.tell(id, "steer C", "optchat:e"), "queued");
    await app.conversations.stop(id);
    const done = await settled(id);
    assert.equal(done.status.state, "stopped");
    assert.equal(done.status.run, "cube:initial", "the stopped run is the one reported, not the withdrawn message");
    assert.equal(done.status.error, "a message sent while it worked never reached it (the stop withdrew it); send it again if still needed");
    assert.equal(await threads.tell(id, "steer C", "optchat:e"), "dropped", "a replay says it never reached the agent");
    await delay(200);
    assert.ok(requests.get("pi-stop")!.every(messages => !messages.some(message => textOf(message) === "steer C")), "the model never got it");
  }

  {
    // A run that fails before a tool boundary (the provider fails, every
    // retry too): the queued message is withdrawn, not kept for a later
    // one, and the run's outcome keeps the provider's error and names it.
    hold("pi-fail");
    const id = create("pi-fail", "pi-fail");
    await until(() => requests.get("pi-fail")?.length ?? 0, n => n >= 1, "the generation is out");
    assert.equal(await threads.tell(id, "steer X", "optchat:x"), "queued");
    release["pi-fail"]!();
    const done = await settled(id);
    assert.equal(done.status.state, "failed");
    assert.equal(done.status.run, "cube:initial", "the failed run, not the withdrawn message");
    assert.match(done.status.error ?? "", /^provider down; a message sent while it worked never reached it \(the run failed before it read it\); send it again if still needed$/);
    assert.equal(await threads.tell(id, "steer X", "optchat:x"), "dropped", "a replay says it never reached the agent");
    // The stored record (OptChat's history, a reader without the agent) says the same, not working.
    const stored = await app.conversations.storedHistory(id, { limit: 5 });
    assert.deepEqual(stored?.status, done.status);
    const before = requests.get("pi-fail")!.length;
    assert.equal(await threads.tell(id, "later", "optchat:y"), "started", "a new message starts a run of its own");
    await until(() => history(id), value => value.status.state === "completed" && value.status.run === "optchat:y", "the later run");
    const sent = requests.get("pi-fail")!.slice(before);
    assert.ok(sent.length >= 1 && sent.every(messages => !messages.some(message => textOf(message) === "steer X")), "the withdrawn message never rides along");
    assert.ok(requests.get("pi-fail")!.every(messages => !messages.some(message => textOf(message) === "steer X")), "the model never got it");
  }
  {
    // cubed stops with one queued in Pi's inbox: after the restart the run
    // goes on, and the model gets the message once, after the tool's result.
    const id = create("pi-restart", "pi-restart");
    await until(() => toolRunning(id).catch(() => false), Boolean, "the pi thread's tool runs");
    assert.equal(await threads.tell(id, "steer D", "optchat:o"), "queued");
    await app.close();
    await machines.close();
    machines = new LocalMachines(machinesRoot);
    ({ app, threads } = await open(machines));
    await app.conversations.activate(id);
    const done = await settled(id);
    assert.equal(done.status.state, "completed", JSON.stringify(done.status));
    const sent = requests.get("pi-restart")!;
    const steered = sent.filter(messages => messages.some(message => message.role === "user" && textOf(message) === "steer D"));
    assert.ok(steered.length >= 1, "the model got it after the restart");
    assert.equal(steered[0]!.filter(message => message.role === "user" && textOf(message) === "steer D").length, 1, "once");
    assert.equal(steered[0]!.at(-2)!.role, "toolResult", "after the tool's result");
    assert.equal(await threads.tell(id, "steer D", "optchat:o"), "consumed");
  }

  // --- Claude Code ------------------------------------------------------------
  const transcriptOf = async (id: string) => (await history(id)).events.flatMap(event => event.type === "user-message" ? [`user: ${event.text}`] : event.type === "assistant-text" && !event.reasoning ? [`says: ${event.text}`] : event.type === "tool-result" ? [`result: ${event.name}`] : []);
  let claude = "";
  {
    // During a tool call: Claude Code queues it and takes it in after the
    // tool's result, in the same turn; the transcript shows it there.
    claude = create("claude-tool", "slow sleep 1\nsay first part", claudeModel);
    await until(() => history(claude).catch(() => null), value => !!value?.events.some(event => event.type === "tool-call" && event.name === "Bash"), "the claude thread's Bash runs");
    const run = (await history(claude)).status.run;
    assert.equal(await threads.tell(claude, "say steered part", "optchat:f"), "queued");
    const done = await settled(claude);
    assert.equal(done.status.state, "completed");
    assert.equal(done.status.run, run, "one run");
    assert.deepEqual(await transcriptOf(claude), ["user: slow sleep 1\nsay first part", "result: Bash", "user: say steered part", "says: first part", "says: steered part", "says: done with sonnet"]);
    assert.equal(await threads.tell(claude, "say steered part", "optchat:f"), "consumed", "a replay changes nothing");
    assert.equal((await transcriptOf(claude)).filter(line => line === "user: say steered part").length, 1);
    // From the stored record as well (OptChat's history, an archived thread's reader).
    const stored = await app.conversations.storedHistory(claude, { limit: 50 });
    assert.ok(stored?.events.some(event => event.type === "user-message" && event.text === "say steered part"));
  }
  {
    // As the turn ends (a model call with no tool left): Claude Code starts
    // it as the next turn, which cubed records as the message's own run at
    // once, so the thread never shows idle in between.
    assert.equal(await threads.tell(claude, "think 700\nsay thought", "optchat:g"), "started");
    await until(() => history(claude), value => value.status.state === "working" && value.status.run === "optchat:g", "the turn thinks");
    const watch = await statuses(claude);
    assert.equal(await threads.tell(claude, "say late steer", "optchat:h"), "queued");
    const done = await settled(claude, "optchat:h");
    await watch.stop();
    assert.equal(done.status.state, "completed");
    assert.ok(watch.seen.every(status => status.state === "working" || status.run === "optchat:h"), `never idle between the runs: ${JSON.stringify(watch.seen)}`);
    assert.deepEqual((await transcriptOf(claude)).slice(-6), ["user: think 700\nsay thought", "says: thought", "says: done with sonnet", "user: say late steer", "says: late steer", "says: done with sonnet"]);
    assert.equal(await threads.tell(claude, "say late steer", "optchat:h"), "consumed");
  }
  {
    // A stop withdraws a queued one (interrupt with cancel_queued): it never runs, and the outcome says so.
    assert.equal(await threads.tell(claude, "slow sleep 3", "optchat:i"), "started");
    await until(() => history(claude), value => value.status.run === "optchat:i" && value.events.some(event => event.type === "tool-call" && event.name === "Bash" && JSON.stringify(event.input).includes("sleep 3")), "the Bash runs");
    assert.equal(await threads.tell(claude, "say never", "optchat:j"), "queued");
    await app.conversations.stop(claude);
    const done = await settled(claude, "optchat:i");
    assert.equal(done.status.state, "stopped");
    assert.match(done.status.error ?? "", /a message sent while it worked never reached it \(the stop withdrew it\)/);
    assert.equal(await threads.tell(claude, "say never", "optchat:j"), "dropped");
    await delay(300);
    assert.ok(!(await transcriptOf(claude)).some(line => line.includes("never")), "it never ran");
  }
  {
    // A tell while a stop is under way (the interrupt not answered yet) is
    // refused, not queued to run past the stop.
    assert.equal(await threads.tell(claude, "ignore-interrupt\nslow sleep 5", "optchat:p"), "started");
    await until(() => history(claude), value => value.status.run === "optchat:p" && value.events.some(event => event.type === "tool-call" && JSON.stringify(event.input).includes("sleep 5")), "the Bash runs");
    await app.conversations.stop(claude);
    await assert.rejects(threads.tell(claude, "say past the stop", "optchat:q"), /the thread is being stopped/);
    const done = await settled(claude, "optchat:p");
    assert.equal(done.status.state, "stopped");
    assert.ok(!(await transcriptOf(claude)).some(line => line.includes("past the stop")));
  }
  {
    // Claude Code ends before it took one in: the failed run says so.
    assert.equal(await threads.tell(claude, "think 600\ncrash", "optchat:k"), "started");
    await until(() => history(claude), value => value.status.run === "optchat:k", "the turn runs");
    assert.equal(await threads.tell(claude, "say lost", "optchat:l"), "queued");
    const done = await settled(claude, "optchat:k");
    assert.equal(done.status.state, "failed");
    assert.match(done.status.error ?? "", /claude code exited \(3\).*a message sent while it worked never reached it \(claude code ended before it took it in\)/);
  }
  {
    // cubed stops with one queued: the turn is over after the restart and
    // says the message never reached Claude Code; nothing is resent.
    assert.equal(await threads.tell(claude, "slow sleep 5", "optchat:m"), "started");
    await until(() => history(claude), value => value.status.run === "optchat:m" && value.events.some(event => event.type === "tool-call" && JSON.stringify(event.input).includes("sleep 5")), "the Bash runs");
    assert.equal(await threads.tell(claude, "say after restart", "optchat:n"), "queued");
    await app.close();
    await machines.close();
    machines = new LocalMachines(machinesRoot);
    ({ app, threads } = await open(machines));
    await app.conversations.activate(claude);
    const done = await settled(claude, "optchat:m");
    assert.equal(done.status.state, "failed");
    assert.match(done.status.error ?? "", /^cubed stopped during this turn.*a message sent while it worked never reached it \(cubed closed claude code before it took it in\)/);
    assert.equal(await threads.tell(claude, "say after restart", "optchat:n"), "dropped");
    await delay(300);
    assert.ok(!(await transcriptOf(claude)).some(line => line.includes("after restart")));
  }
  console.log("thread steering ok");
} finally {
  await app.close();
  await machines.close();
  fs.rmSync(root, { recursive: true, force: true });
}
