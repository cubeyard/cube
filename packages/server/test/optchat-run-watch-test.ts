/** OptChat's watch of a thread's run feed when it cannot begin or its feed
 * closes mid-turn, over real stores: createCubed, Conversations, the fake
 * Claude Code CLI (fake-claude.ts), cubeThreads and a real OptChat on local
 * guests. Offline and disposable.
 *
 *   G2  a Claude Code turn whose first watch could not begin, still running
 *       when its agent closes (its machine booted again) with no reopen (the
 *       resume step fails), reports once, as the turn cut off: by the watch
 *       attached again or by the close's fact (#278), whichever comes first.
 *       It guards #278's close path in this case; it passed before #279's
 *       fix too;
 *   G1  a watch that cannot begin (the feed's first read rejects) leaves no
 *       unhandled rejection and no stuck entry: the thread is attached again
 *       on a later round, once, not in a tight loop.
 *   G3  a watch that ends twice (its onEnd, then its closed later) removes
 *       only its own entry: the thread attached again since keeps its one
 *       watch (OptChat with stand-in threads);
 *   G4  a watch refused again and again is tried once per round, never at
 *       once: the attempts are a round apart, then the watch that begins
 *       stays (OptChat with stand-in threads).
 * Each thread's first live watch is refused, as when its first read throws. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { CLAUDE_PROVIDER } from "../src/claude-agent.ts";
import type { GuestTransport } from "../src/guest-transport.ts";
import { createCubed } from "../src/index.ts";
import { OptChat, type OptThreads } from "../src/optchat.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import type { Thread } from "../src/registry.ts";
import { LocalMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-run-watch-"));
const unhandled: unknown[] = [];
process.on("unhandledRejection", reason => { unhandled.push(reason); });
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
const blocks = (message: Message) => typeof message.content === "string" ? [message.content]
  : message.content.map(part => part.type === "text" ? part.text : "");
const reports: string[] = [];
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 200 }, () => async (request: { messages: Message[] }) => {
  const system = request.messages.find(message => message.role === "system");
  if (system && textOf(system).includes("You write the memory of OptChat")) return fauxAssistantMessage("summary");
  if (request.messages.at(-1)?.role !== "user") return fauxAssistantMessage("noted");
  const taken = request.messages.filter(message => message.role === "user").flatMap(blocks).filter(part => !part.includes("<chat>"));
  for (const part of taken) for (const line of part.split("\n")) if (/^\[[0-9a-f]{8}\] /.test(line)) reports.push(line);
  if (taken.some(part => part.includes("SPAWN"))) {
    return fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ project: "p", task: "CLAUDE_CUT" }, { project: "p", task: "CLAUDE_WATCHED" }] }, { id: "call-spawn" })], { stopReason: "toolUse" });
  }
  return fauxAssistantMessage("noted");
}));
const models = createModels();
models.setProvider(faux.provider);
const piModel = { provider: faux.getModel().provider, id: faux.getModel().id };

/** Local machines whose resume step fails while `failResume` is set: an
 * activation after a reboot closes the agent, then fails before it reopens. */
class Machines extends LocalMachines {
  failResume = false;
  override guest(thread: Thread): ReturnType<LocalMachines["guest"]> {
    const target = super.guest(thread);
    const failing = () => this.failResume;
    return new Proxy(target, {
      get(object, key, receiver) {
        const value = Reflect.get(object, key, receiver) as unknown;
        if (key !== "call" || typeof value !== "function") return value;
        return (op: string, header: unknown, ...rest: unknown[]) => {
          // The resume step's command (resumeScript, vm.ts) prints "cube-resume".
          if (failing() && op === "exec" && String((header as { command?: string }).command ?? "").includes("cube-resume")) {
            return Promise.reject(new Error("the resume step could not run"));
          }
          return (value as GuestTransport["call"]).apply(object, [op, header, ...rest] as Parameters<GuestTransport["call"]>);
        };
      },
    });
  }
}
const machines = new Machines(path.join(root, "machines"));
const app = await createCubed({ state: path.join(root, "state"), models, machines, claude: [process.execPath, path.resolve(import.meta.dirname, "fake-claude.ts")],
  claudeOptions: { stopGraceMs: 2000 }, gateway: null });
app.registry.enrollRunner({ nodeId: "node-r", threadId: "r", environmentId: 1, configPath: "/private/r.json", configHash: "r", maxActiveVms: 4, protocol: 4, kind: "vm" } as never);
app.registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
const base = cubeThreads({ registry: app.registry, conversations: app.conversations, catalog: async () => [piModel], runners: () => ({ runners: [] }) as never,
  latestCommits: async () => ({}) as never });
const gate = path.join(root, "never");
/** By thread: events() asks, watches refused, watches begun. */
const asked = new Map<string, number>(), refused = new Map<string, number>(), watches = new Map<string, number>();
const bump = (counts: Map<string, number>, id: string) => counts.set(id, (counts.get(id) ?? 0) + 1);
const ids = new Map<string, string>();
const threads: OptThreads = {
  ...base,
  async events(id) {
    bump(asked, id);
    const events = await base.events(id);
    if (!events || typeof events !== "object") return events;
    if (!refused.has(id)) return { ...events, watch: async () => { bump(refused, id); throw new Error("the feed could not be read"); } };
    return { ...events, watch: (...args) => { bump(watches, id); return events.watch(...args); } };
  },
  async spawn(task: { task: string }, requestId: string) {
    const thread = app.registry.threadByRequest("p", requestId)
      ?? app.registry.createThread("p", requestId, { provider: CLAUDE_PROVIDER, id: "fable" }, `run while [ ! -e ${gate} ]; do sleep 0.05; done\nsay never`, "claude-code", undefined, { runnerId: "r" });
    app.registry.renameThread(thread.id, task.task);
    ids.set(task.task, thread.id);
    void app.conversations.activate(thread.id);
    return { id: thread.id, title: task.task };
  },
};
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 30_000): Promise<void> {
  for (const deadline = Date.now() + ms; !(await check());) {
    assert.ok(Date.now() < deadline, what);
    await delay(25);
  }
}
const reportsOf = (id: string) => reports.filter(line => line.startsWith(`[${id.slice(0, 8)}] `));
const chat = await OptChat.open({ directory: path.join(root, "optchat"), models, model: async () => piModel, threads, limits: { node: 64, retryMs: 50, watchMs: 50 } });
try {
  await chat.send("SPAWN", "u1");
  await until(() => ids.size === 2, "the chat spawns both threads");
  const [cut, watched] = [ids.get("CLAUDE_CUT")!, ids.get("CLAUDE_WATCHED")!];
  const working = async (id: string) => (await app.conversations.storedHistory(id, { limit: 1 }))?.status.state === "working";
  await until(async () => await working(cut) && await working(watched), "both turns are under way");
  await until(() => refused.get(cut) === 1 && refused.get(watched) === 1, "each thread's first watch was refused");

  // ---------------------------------------------------------------- G2
  machines.failResume = true;
  machines.reboot(app.registry.getThread(cut)!);
  await app.conversations.activate(cut);
  assert.equal(app.conversations.agentOpen(cut), false, "the agent closed and was not opened again");
  assert.match(app.conversations.error(cut) ?? "", /the resume step could not run/, "the activation failed after the close");
  assert.equal((await app.conversations.storedHistory(cut, { limit: 1 }))?.status.state, "failed", "the turn cut off by the close settled in its store");
  await until(() => reportsOf(cut).length === 1, "the cut-off turn reports");
  await delay(600);
  assert.equal(reportsOf(cut).length, 1, "once");
  assert.match(reportsOf(cut)[0]!, /^\[[0-9a-f]{8}\] failed: /);
  machines.failResume = false;
  console.log("ok: G2 a Claude Code turn whose first watch was refused, cut off when its agent closed with no reopen, reports once");

  // ---------------------------------------------------------------- G1
  await until(() => watches.get(watched) === 1, "the refused watch is attached again on a later round");
  const settledAsks = asked.get(watched);
  await delay(600);
  assert.equal(asked.get(watched), settledAsks, "once watched it is not asked again (no tight loop over 12 rounds)");
  assert.deepEqual([refused.get(watched), watches.get(watched), unhandled.length], [1, 1, 0], "one refused watch, one watch since, no unhandled rejection");
  console.log(`ok: G1 a watch that could not begin is attached again on a later round, once (${settledAsks} asks), with no unhandled rejection`);

  // ---------------------------------------------------------------- G3
  {
    const STUCK = "5e5e0000-0000-4000-8000-000000000003";
    let begun = 0;
    const transcript = { agent: "pi" as const, owner: null, status: { state: "working" as const, run: "r1", error: null }, events: [] };
    const stand: OptThreads = {
      startFailure: () => null, onStartFailure: () => () => {}, onRunFeed: () => () => {},
      async projects() { return ""; }, async runners() { return ""; }, async tell() {}, async describe() { return ""; }, async history() { return null; },
      async spawn() { return { id: STUCK, title: "stuck" }; },
      async events() {
        return { async read() { return transcript; }, async watch(listener, options) {
          const n = ++begun;
          await listener(transcript);
          // The first watch ends at once by onEnd, and once more by closed, later.
          if (n === 1) {
            setTimeout(() => options?.onEnd?.(new Error("the stand-in feed ended")), 10);
            return { closed: delay(400).then(() => {}), async stop() {} };
          }
          return { closed: new Promise<void>(() => {}), async stop() {} };
        } };
      },
    };
    const faux3 = fauxProvider({ tokensPerSecond: 100_000 });
    let spawned = false;
    faux3.setResponses(Array.from({ length: 40 }, () => async () => {
      if (spawned) return fauxAssistantMessage("noted");
      spawned = true;
      return fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ project: "p", task: "stuck" }] }, { id: "call-stuck" })], { stopReason: "toolUse" });
    }));
    const models3 = createModels();
    models3.setProvider(faux3.provider);
    const chat3 = await OptChat.open({ directory: path.join(root, "optchat-g3"), models: models3, model: async () => ({ provider: faux3.getModel().provider, id: faux3.getModel().id }),
      threads: stand, limits: { node: 64, retryMs: 50, watchMs: 50 } });
    try {
      await chat3.send("go", "g3");
      await until(() => begun === 2, "the ended watch is attached again");
      await delay(800);
      assert.equal(begun, 2, "the first watch's late second end did not remove the watch begun since");
    } finally { await chat3.close(); }
    console.log("ok: G3 a watch that ends twice removes only its own entry: the thread keeps the one watch begun since");
  }

  // ---------------------------------------------------------------- G4
  {
    const REFUSED = "4ef00000-0000-4000-8000-000000000004";
    const WATCH_MS = 150;
    const attempts: number[] = [];
    const transcript = { agent: "pi" as const, owner: null, status: { state: "working" as const, run: "r1", error: null }, events: [] };
    const stand: OptThreads = {
      startFailure: () => null, onStartFailure: () => () => {}, onRunFeed: () => () => {},
      async projects() { return ""; }, async runners() { return ""; }, async tell() {}, async describe() { return ""; }, async history() { return null; },
      async spawn() { return { id: REFUSED, title: "refused" }; },
      async events() {
        return { async read() { return transcript; }, async watch(listener) {
          attempts.push(Date.now());
          // Refused four times in a row, then it begins and stays.
          if (attempts.length <= 4) throw new Error("the feed could not be read");
          await listener(transcript);
          return { closed: new Promise<void>(() => {}), async stop() {} };
        } };
      },
    };
    const faux4 = fauxProvider({ tokensPerSecond: 100_000 });
    let spawned = false;
    faux4.setResponses(Array.from({ length: 40 }, () => async () => {
      if (spawned) return fauxAssistantMessage("noted");
      spawned = true;
      return fauxAssistantMessage([fauxToolCall("spawn", { tasks: [{ project: "p", task: "refused" }] }, { id: "call-refused" })], { stopReason: "toolUse" });
    }));
    const models4 = createModels();
    models4.setProvider(faux4.provider);
    const chat4 = await OptChat.open({ directory: path.join(root, "optchat-g4"), models: models4, model: async () => ({ provider: faux4.getModel().provider, id: faux4.getModel().id }),
      threads: stand, limits: { node: 64, retryMs: 50, watchMs: WATCH_MS } });
    try {
      await chat4.send("go", "g4");
      await until(() => attempts.length === 5, "the watch refused four times begins on the fifth try");
      await delay(WATCH_MS * 4);
      assert.equal(attempts.length, 5, "once begun it is not tried again");
      const gaps = attempts.slice(1).map((at, index) => at - attempts[index]!);
      // A round apart: never at once (a timer's jitter allowed below a round).
      assert.ok(gaps.every(gap => gap >= WATCH_MS / 2), `each try a round after the last refusal, never at once: gaps ${gaps.join(", ")} ms`);
      assert.equal(unhandled.length, 0, "no unhandled rejection");
    } finally { await chat4.close(); }
    console.log(`ok: G4 a watch refused four times is tried once per round (gaps ≥ ${WATCH_MS / 2} ms), then the watch that begins stays`);
  }
} finally {
  machines.failResume = false;
  await chat.close().catch(() => {});
  fs.writeFileSync(gate, "");
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
}
process.exit(0);
