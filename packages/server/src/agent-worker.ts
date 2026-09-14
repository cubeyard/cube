/**
 * One replaceable Pi worker. Cubed sends the authoritative conversation on
 * stdin; this process keeps no session file and emits normalized events on
 * fd 3. stdout is intentionally not protocol because dependencies may write
 * diagnostics there.
 */
import fs from "node:fs";

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Effect, Schema } from "effect";

const WorkerRequest = Schema.Struct({
  prompt: Schema.String,
  messages: Schema.Array(Schema.Unknown),
  extension: Schema.String,
});

const emit = (event: unknown): void => {
  fs.writeSync(3, `${JSON.stringify(event)}\n`);
};

const readRequest = Effect.fn("AgentWorker.readRequest")(function*() {
  const body = yield* Effect.tryPromise({
    try: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    },
    catch: (cause) => new Error(`could not read worker request: ${String(cause)}`),
  });
  const raw = yield* Effect.try({
    try: () => JSON.parse(body),
    catch: (cause) => new Error(`invalid worker request: ${String(cause)}`),
  });
  return yield* Schema.decodeUnknownEffect(WorkerRequest)(raw);
});

const run = Effect.fn("AgentWorker.run")(function*() {
  const request = yield* readRequest();
  const cwd = process.cwd();
  const agentDir = process.env.HOME ? `${process.env.HOME}/.pi/agent` : undefined;
  if (!agentDir) return yield* Effect.fail(new Error("HOME is not set"));

  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [request.extension],
    noExtensions: true,
    noContextFiles: true,
  });
  yield* Effect.tryPromise({ try: () => loader.reload(), catch: (cause) => new Error(String(cause)) });
  const created = yield* Effect.tryPromise({
    try: () => createAgentSession({
      cwd,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager,
    }),
    catch: (cause) => new Error(String(cause)),
  });
  const { session } = created;
  session.agent.state.messages = request.messages as typeof session.agent.state.messages;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") emit({ type: "text_delta", delta: update.delta });
      if (update.type === "thinking_delta") emit({ type: "thinking_delta", delta: update.delta });
    } else if (event.type === "message_end" && event.message.role !== "user") {
      emit({ type: "message", message: event.message });
    }
  });
  yield* Effect.tryPromise({
    try: () => session.prompt(request.prompt),
    catch: (cause) => new Error(String(cause)),
  }).pipe(Effect.ensuring(Effect.sync(() => {
    unsubscribe();
    session.dispose();
  })));
  emit({ type: "complete" });
});

Effect.runPromise(run()).catch((error) => {
  emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
