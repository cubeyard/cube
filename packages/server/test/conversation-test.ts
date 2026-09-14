/** Durable Cube transcript across replaceable agent worker processes. */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect } from "effect";

import { Conversations } from "../src/conversation.ts";
import { Registry } from "../src/registry.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-conversation-"));
const worker = path.join(root, "worker.mjs");
fs.writeFileSync(worker, `
import fs from "node:fs";
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const text = "history:" + request.messages.length + " prompt:" + request.prompt;
const emit = (event) => fs.writeSync(3, JSON.stringify(event) + "\\n");
if (request.prompt === "provider failure") {
  emit({ type: "message", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "provider rejected the request" } });
  emit({ type: "complete" });
  process.exit(0);
}
emit({ type: "text_delta", delta: "checking" });
emit({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "checking" }], timestamp: Date.now() } });
emit({ type: "message", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "tool output" }], timestamp: Date.now() } });
emit({ type: "text_delta", delta: text.slice(0, 8) });
emit({ type: "text_delta", delta: text.slice(8) });
emit({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], model: request.model, timestamp: Date.now() } });
emit({ type: "complete" });
`);

const registry = new Registry(path.join(root, "cubed.db"));
const project = registry.createProject({
  id: "project",
  name: "project",
  repositories: [{ id: "repo", url: "https://example.test/repo", base: null, checkoutName: "workspace" }],
});
const cube = registry.createCube({ name: "threadtest", image: "image", workspacePath: root });
registry.addThread({ id: "thread", cubeId: cube.id, projectId: project.id, piSessionPath: path.join(root, "unused.jsonl") });

let activity = 0;
const conversations = new Conversations(registry, {
  plan: () => Effect.succeed({ cwd: root, env: { ...process.env } }),
  activity: () => Effect.sync(() => { activity++; }),
}, { worker, extension: "/unused-extension.ts" });

const waitForRun = Effect.fnUntraced(function*(id: string) {
  for (;;) {
    const run = registry.getAgentRun(id)!;
    if (run.status === "completed" || run.status === "failed") return run;
    yield* Effect.sleep("10 millis");
  }
});

await Effect.runPromise(Effect.gen(function*() {
  assert.equal((yield* conversations.submit("thread", "no model").pipe(Effect.result))._tag, "Failure");
  assert.equal(conversations.history("thread").messages.length, 0);
  registry.setThreadModel("thread", { provider: "first-provider", id: "shared-model-id" });
  const first = yield* conversations.submit("thread", "first\nmultiline");
  // Selection is captured before asynchronous planning, not when the worker starts.
  registry.setThreadModel("thread", { provider: "second-provider", id: "shared-model-id" });
  assert.equal((yield* conversations.submit("thread", "overlap").pipe(Effect.result))._tag, "Failure");
  assert.equal((yield* waitForRun(first.runId)).status, "completed");
  assert.deepEqual((conversations.history("thread").messages.at(-1)!.payload as { model: unknown }).model,
    { provider: "first-provider", id: "shared-model-id" });
  assert.deepEqual(
    conversations.history("thread").messages.map((message) => [message.role, message.content]),
    [
      ["user", "first\nmultiline"],
      ["assistant", "checking"],
      ["tool", "tool output"],
      ["assistant", "history:0 prompt:first\nmultiline"],
    ],
  );

  const second = yield* conversations.submit("thread", "second");
  assert.equal((yield* waitForRun(second.runId)).status, "completed");
  assert.deepEqual((conversations.history("thread").messages.at(-1)!.payload as { model: unknown }).model,
    { provider: "second-provider", id: "shared-model-id" });
  assert.deepEqual(
    conversations.history("thread").messages.map((message) => [message.role, message.content]),
    [
      ["user", "first\nmultiline"],
      ["assistant", "checking"],
      ["tool", "tool output"],
      ["assistant", "history:0 prompt:first\nmultiline"],
      ["user", "second"],
      ["assistant", "checking"],
      ["tool", "tool output"],
      ["assistant", "history:4 prompt:second"],
    ],
  );
  assert.equal(activity, 4, "each worker run marks activity before and after");

  const failed = yield* conversations.submit("thread", "provider failure");
  const failedRun = yield* waitForRun(failed.runId);
  assert.equal(failedRun.status, "failed");
  assert.equal(failedRun.error, "provider rejected the request");
  assert.deepEqual(
    conversations.history("thread").messages.slice(-1).map((message) => [message.role, message.content]),
    [["user", "provider failure"]],
    "provider failures surface on the run instead of creating an empty assistant message",
  );
  assert.equal(activity, 5, "a failed worker marks activity before the attempt");
  yield* conversations.close();
}));

registry.close();
const reopened = new Registry(path.join(root, "cubed.db"));
assert.deepEqual({ ...reopened.getThreadModel("thread") }, { provider: "second-provider", id: "shared-model-id" });
reopened.close();
fs.rmSync(root, { recursive: true, force: true });
console.log("conversation-test: all ok");
