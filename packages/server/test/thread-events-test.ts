/** The neutral thread event model: the Pi adapter renders pi-durable's view
 * into user messages, assistant text, tool calls and results, status, owner
 * and agent; the same `ThreadEvents` interface answers in-process and over
 * SSE through `HttpThreadEvents`. Offline: faux model and a fake runner. */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai";
import { openAgent } from "../src/durable-agent.ts";
import { PiThreadEvents } from "../src/pi-thread-events.ts";
import { HttpThreadEvents, type ThreadEvents, type ThreadTranscript } from "../src/thread-events.ts";
import { serveThreadEvents } from "../src/thread-events-http.ts";
import { RunnerWorkspace } from "../src/workspace.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { FakeRunner } from "./workspace-fake-runner.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-thread-events-"));
const files = path.join(root, "workspace");
fs.mkdirSync(files, { recursive: true });
const runner = new FakeRunner(files);
const leases = new LeaseStore(path.join(root, "thread"));
const workspace = new RunnerWorkspace({ runner, leases, owner: "pi" });
const long = Array.from({ length: 80 }, (_, index) => `word${index}`).join(" ");
const faux = fauxProvider({ tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } });
faux.setResponses([
  fauxAssistantMessage([fauxThinking("plan it"), fauxText("running it"), fauxToolCall("bash", { command: "printf hi" })], { stopReason: "toolUse" }),
  fauxAssistantMessage("all done"),
  fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 0.4; printf slow" })], { stopReason: "toolUse" }),
  fauxAssistantMessage(long),
  fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 5; touch late" })], { stopReason: "toolUse" }),
  fauxAssistantMessage("unreachable"),
]);
const models = createModels();
models.setProvider(faux.provider);
async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 10000;
  while (!check()) { assert(Date.now() < deadline, `waiting for ${what}`); await delay(20); }
}

const agent = await openAgent({ directory: path.join(root, "thread"), runner: { binding: runner.binding, configHash: "fake" }, workspace, models, model: { provider: faux.getModel().provider, id: faux.getModel().id } });
const events: ThreadEvents = new PiThreadEvents({ agent, owner: () => leases.holder(), failure: () => null });
const server = http.createServer((request, response) => {
  const route = request.url?.replace(/^\/api\/threads\/t1/, "");
  if (route === "/history") {
    void events.read().then(value => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value)); });
  } else if (route === "/stream") {
    serveThreadEvents(events, response).catch(() => { if (!response.headersSent) response.writeHead(409); response.end(); });
  }
  else { response.writeHead(404); response.end(); }
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as { port: number };
const remote: ThreadEvents = new HttpThreadEvents({ base: `http://127.0.0.1:${address.port}/api/threads/t1`, retryMs: 50 });

try {
  {
    assert.deepEqual(await events.read(), { agent: "pi", owner: "pi", status: { state: "idle", run: null, error: null }, events: [] });
    const submission = await agent.conversation.submit({ type: "input", content: "run it", requestId: "first" }, context);
    assert.equal((await submission.wait(context)).status, "done");
    const transcript = await events.read();
    assert.equal(transcript.agent, "pi");
    assert.equal(transcript.owner, "pi", "Pi holds the workspace lease");
    assert.deepEqual(transcript.status, { state: "completed", run: "first", error: null });
    const shape = transcript.events.map(event => event.type === "assistant-text" ? `${event.type}${event.reasoning ? ":reasoning" : ""}` : event.type);
    assert.deepEqual(shape, ["user-message", "assistant-text:reasoning", "assistant-text", "tool-call", "tool-result", "assistant-text"]);
    const [user, thinking, said, call, result, done] = transcript.events;
    assert.deepEqual(user, { type: "user-message", id: user!.id, text: "run it" });
    assert.equal(thinking!.type === "assistant-text" && thinking.text, "plan it");
    assert.equal(said!.type === "assistant-text" && said.final, true);
    assert(call!.type === "tool-call" && result!.type === "tool-result");
    assert.equal(call.name, "bash");
    assert.deepEqual(call.input, { command: "printf hi" });
    assert.equal(result.callId, call.callId);
    assert.equal(result.output, "hi\n[exit=0; exited]");
    assert.equal(result.isError, false);
    assert.equal(done!.type === "assistant-text" && done.text, "all done");
    assert.equal(new Set(transcript.events.map(event => event.id)).size, transcript.events.length, "event ids are unique");
    // The same interface over SSE and the history route: the same value.
    assert.deepEqual(await remote.read(), transcript);
    console.log("ok: Pi adapter renders user message, reasoning, assistant text, paired tool call and result, status, owner and agent; HTTP read is identical");
  }
  {
    // Live frames: one watch in-process and one over SSE see the same model.
    const local: ThreadTranscript[] = [];
    const overHttp: ThreadTranscript[] = [];
    let interrupts = 0;
    const localWatch = await events.watch(value => { local.push(value); });
    const httpWatch = await remote.watch(value => { overHttp.push(value); }, { onInterrupt: () => { interrupts++; } });
    await until(() => overHttp.length > 0, "first SSE frame");
    assert.deepEqual(overHttp[0], local[0], "both watches start from the current transcript");
    const submission = await agent.conversation.submit({ type: "input", content: "slowly", requestId: "second" }, context);
    assert.equal((await submission.wait(context)).status, "done");
    const final = await events.read();
    await until(() => JSON.stringify(overHttp.at(-1)) === JSON.stringify(final) && JSON.stringify(local.at(-1)) === JSON.stringify(final), "final frames");
    for (const frames of [local, overHttp]) {
      assert(frames.some(frame => frame.status.state === "working"), "a working status was published");
      assert(frames.some(frame => frame.events.some(event => event.type === "tool-result" && !event.final)), "running tool output was published");
      assert(frames.some(frame => frame.events.some(event => event.type === "assistant-text" && !event.final)), "streaming assistant text was published");
    }
    assert.equal(final.events.filter(event => !("final" in event) || event.final).length, final.events.length, "settled transcripts hold only final events");
    // A dropped connection reconnects and resumes from the current transcript.
    const before = overHttp.length;
    server.closeAllConnections();
    await until(() => interrupts > 0 && overHttp.length > before, "SSE reconnect");
    assert.deepEqual(overHttp.at(-1), final);
    await httpWatch.stop();
    await localWatch.stop();
    await localWatch.closed;
    console.log("ok: in-process and SSE watches publish the same frames: working status, running tool output, streaming text; SSE reconnects");
  }
  {
    // Stop is a calm status, not a failure.
    await agent.conversation.submit({ type: "input", content: "wait", requestId: "third" }, context);
    let latest: ThreadTranscript | undefined;
    const watch = await events.watch(value => { latest = value; });
    await until(() => latest?.events.some(event => event.type === "tool-result" && !event.final) ?? false, "running bash");
    await agent.conversation.abort(context);
    await until(() => latest?.status.state === "stopped", "stopped status");
    assert.deepEqual(latest!.status, { state: "stopped", run: "third", error: null });
    // Closing the agent ends every watch; the SSE transport ends its stream.
    let ended = 0;
    let frames = 0;
    let refused: Error | undefined;
    const closedOverHttp = await remote.watch(() => { frames++; }, { onInterrupt: () => { ended++; }, onEnd: error => { refused = error; } });
    await until(() => frames > 0, "SSE frame");
    await agent.close();
    await watch.closed;
    await until(() => ended > 0, "SSE stream end");
    // The reconnect is refused (409): the watch ends instead of retrying forever.
    await closedOverHttp.closed;
    assert.match(String(refused?.message), /409/);
    await closedOverHttp.stop();
    // A thread that is gone (404) ends the watch at once, without retries.
    let missing: Error | undefined;
    let retries = 0;
    const gone = await new HttpThreadEvents({ base: `http://127.0.0.1:${address.port}/api/threads/missing`, retryMs: 50 })
      .watch(() => {}, { onInterrupt: () => { retries++; }, onEnd: error => { missing = error; } });
    await gone.closed;
    assert.match(String(missing?.message), /404/);
    assert.equal(retries, 0);
    assert.equal(leases.holder(), null, "the lease is released with the agent");
    assert.equal(fs.existsSync(path.join(files, "late")), false, "stop cancelled the command");
    console.log("ok: stop shows a stopped status; closing the agent ends watches and releases the owner; a 4xx ends an SSE watch without retrying");
  }
} finally {
  await agent.close();
  server.closeAllConnections();
  server.close();
  leases.close();
  fs.rmSync(root, { recursive: true, force: true });
}
