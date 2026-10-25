/** Pi 1.4.0's crash-loop guard against cube's `RESTART_LIMIT` (pi-sends.ts).
 * pi-durable 1.4.0 parks a task that crashes cut off 5 times in a row
 * without a new state; its conversation then stays busy until
 * `retryTask()`, which cube has no control for. Until that limit is decided
 * (D1′), cube keeps 1.3.0's behavior in both its Harnesses: a task cut off at
 * every open runs again. A cut-off here is a failed save (a Storage commit
 * that throws, as a full disk would): the Session fails, its running tasks
 * stay `running` on disk, and the next open counts a restart, as after a
 * crash or a kill. The control shows Pi's default parks at the fifth, so the
 * cut-offs are counted; then a thread agent (openAgent) and OptChat go on
 * after six. Offline: faux model, local guest, disposable state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, Type, type Message } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, defineExtension, defineTool, Harness, LiveDoc, ROOT_CONVERSATION_ID, type ToolRegistration } from "@earendil-works/pi-durable";
import { openAgent, openStorage } from "../src/durable-agent.ts";
import { OptChat, type OptThreads } from "../src/optchat.ts";
import { RESTART_LIMIT } from "../src/pi-sends.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { LocalGuestTransport } from "./local-guest.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-pi-restart-"));
const CUTS = 6;
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("");

/** The blocking tool call: each start waits until it is let go. */
let starts = 0;
let release = () => {};
const blocked = async () => {
  starts++;
  await new Promise<void>(resolve => { release = resolve; });
  return "tool ok";
};
const faux = fauxProvider({ tokensPerSecond: 1e9 });
faux.setResponses(Array.from({ length: 200 }, () => request => {
  const last = request.messages.at(-1)!;
  if (last.role === "toolResult") return fauxAssistantMessage(`answered: ${textOf(last as Message)}`);
  if (request.messages.some(message => message.role === "system" && textOf(message).includes("You write the memory of OptChat"))) return fauxAssistantMessage("summary");
  const tool = /\buse (\w+)\b/.exec(textOf(request.messages.findLast(message => message.role === "user")!))?.[1];
  return tool ? fauxAssistantMessage([fauxToolCall(tool, {})], { stopReason: "toolUse" }) : fauxAssistantMessage("plain answer");
}));
const models = createModels();
models.setProvider(faux.provider);
const model = { provider: faux.getModel().provider, modelId: faux.getModel().id };
const slow = defineTool({ name: "slow", description: "waits", parameters: Type.Object({}), replay: "safe",
  execute: async () => ({ output: [{ type: "text" as const, text: await blocked() }] }) }) as ToolRegistration;
const Poke = defineDoc<{ n: number }>({ kind: "cube.test.poke", version: 1, scope: "session", checkpointWhen: () => false, initial: () => ({ n: 0 }) });

type Commit = { commit: (...args: unknown[]) => Promise<unknown> };
/** From now on every commit of `storage` fails, as on a full disk. */
function breakStorage(storage: unknown): void {
  (storage as Commit).commit = () => Promise.reject(new Error("disk I/O error (test)"));
}
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!await check()) { assert.ok(Date.now() < deadline, `waiting for ${what}`); await delay(10); }
}
const parked = async (harness: Harness) => (await harness.inspect(context)).tasks.filter(task => task.state.kind === "blocked" && task.state.reason === "restart_limit").length;

try {
  {
    // Control, Pi's default limit: the fifth cut-off parks the tool call
    // and its conversation stays busy.
    const file = path.join(root, "control.sqlite");
    starts = 0;
    const registry = createRegistry();
    registry.install(defineExtension({ name: "control", tools: [slow] }));
    for (let open = 0; ; open++) {
      const storage = await openStorage(file);
      const harness = await Harness.open(storage, { models, registry }, context);
      const conversation = await harness.conversation(ROOT_CONVERSATION_ID, context) ?? await harness.root(context, { agent: { model } });
      harness.resume();
      if (open === 0) await conversation.submit({ type: "input", content: "use slow", requestId: "c1" }, context);
      if (open === 5) {
        await delay(300);
        assert.equal(starts, 5, "Pi's default runs it five times");
        assert.equal(await parked(harness), 1, "then parks it (restart_limit)");
        assert.ok((await harness.snapshot(LiveDoc, conversation.id, context))?.run, "and its run stays busy");
        await harness.close(context);
        break;
      }
      await until(() => starts === open + 1, `start ${open + 1}`);
      breakStorage(storage);
      await harness.commit(async tx => { (await tx.doc(Poke)).n++; }, context).catch(() => {});
      // The stand-in tool takes no abort: let it end, so the Session can.
      release();
      assert.equal((await harness.closed).reason, "failed");
      await harness.close(context).catch(() => {});
    }
    console.log("ok: control: Pi 1.4.0's default parks a tool call cut off five times; its run stays busy");
  }

  {
    // A thread agent: cut off six times, its tool call runs again at every
    // open and the run ends answered.
    const files = path.join(root, "agent", "workspace");
    const directory = path.join(root, "agent", "thread");
    fs.mkdirSync(files, { recursive: true });
    const guest = new LocalGuestTransport(path.dirname(files));
    const tools = defineExtension({ name: "restart-test", tools: [slow] });
    starts = 0;
    for (let open = 0; ; open++) {
      const agent = await openAgent({ directory, binding: guest.binding, workspace: new VmWorkspace({ guest, leases: new LeaseStore(directory), owner: "pi", binding: guest.binding }),
        models, model: { provider: model.provider, id: model.modelId }, extensions: [tools] });
      if (open === 0) await agent.conversation.submit({ type: "input", content: "use slow", requestId: "t1" }, context);
      await until(() => starts === open + 1, `the thread's tool call, start ${open + 1}`);
      assert.equal(await parked(agent.harness), 0, "never parked");
      if (open === CUTS) {
        release();
        await agent.conversation.waitForIdle(context);
        const watch = await agent.conversation.watch(context);
        await watch.stop();
        assert.ok(watch.value.entries.some(entry => entry.kind === "pi.assistant" && JSON.stringify(entry).includes("answered: tool ok")), "the run ends answered");
        await agent.close();
        break;
      }
      breakStorage(agent.storage);
      await agent.harness.commit(async tx => { (await tx.doc(Poke)).n++; }, context).catch(() => {});
      release();
      await until(() => agent.failure() !== null, "the agent down");
      await agent.close();
    }
    assert.equal(starts, CUTS + 1);
    console.log(`ok: a thread agent's tool call cut off ${CUTS} times runs again at every open (cube's restartLimit), and its run ends answered`);
  }

  {
    // OptChat: its read-only `projects` call cut off six times runs again
    // at every open; the turn ends answered.
    starts = 0;
    const threads: OptThreads = { startFailure: () => null, onStartFailure: () => () => {}, onRunFeed: () => () => {},
      async projects() { return blocked(); }, async runners() { return "no runners"; },
      async spawn() { throw new Error("unused"); }, async tell() {}, async describe() { return ""; },
      async events() { throw new Error("unused"); }, async history() { return null; },
    };
    const directory = path.join(root, "optchat");
    for (let open = 0; ; open++) {
      const chat = await OptChat.open({ directory, models, model: async () => ({ provider: model.provider, id: model.modelId }), threads, limits: { retryMs: 50, watchMs: 50, closeMs: 1_000 } });
      if (open === 0) await chat.send("please use projects", "o1");
      await until(() => starts === open + 1, `OptChat's tool call, start ${open + 1}`);
      if (open === CUTS) {
        release();
        await until(async () => {
          const page = await chat.agent.conversation.entries({}, 512, undefined, context);
          return page.items.some(entry => entry.kind === "pi.assistant" && JSON.stringify(entry).includes("answered: tool ok"));
        }, "the chat's turn answered");
        await chat.close();
        break;
      }
      breakStorage(chat.agent.storage);
      await chat.send(`poke ${open}`, `poke-${open}`).catch(() => {});
      release();
      await until(() => chat.failure()?.startsWith("the chat stopped") ?? false, "the chat down");
      await chat.close();
    }
    assert.equal(starts, CUTS + 1);
    console.log(`ok: OptChat's tool call cut off ${CUTS} times runs again at every open (cube's restartLimit), and its turn ends answered`);
  }
  assert.equal(RESTART_LIMIT, Number.POSITIVE_INFINITY, "D1′ is open: review this suite when cube sets a limit");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
