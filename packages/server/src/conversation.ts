/** Cube-owned conversation orchestration. Pi processes are disposable
 * workers hydrated from the durable transcript for each accepted run. */
import crypto from "node:crypto";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Effect, Fiber, Schema } from "effect";

import type { ConversationMessageRow } from "./registry.ts";
import { Registry } from "./registry.ts";
import type { ModelSelection } from "./models.ts";
import { boundedTaskResult, ThreadTasks, type ThreadTaskRow } from "./thread-tasks.ts";

const WorkerEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text_delta"), delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thinking_delta"), delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("message"), message: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("complete") }),
  Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
]);
type WorkerEvent = typeof WorkerEvent.Type;

export class ConversationError extends Schema.TaggedError<ConversationError>()("ConversationError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface ConversationHost {
  plan(threadId: string): Effect.Effect<{ cwd: string; env: Record<string, string | undefined> }, ConversationError>;
  activity(threadId: string): Effect.Effect<void>;
  defaultModel?(): Effect.Effect<ModelSelection | null, ConversationError>;
}

const WORKER = path.resolve(import.meta.dirname, "agent-worker.ts");
const EXTENSION = path.resolve(import.meta.dirname, "../../pi-extension/src/index.ts");

export class Conversations {
  private readonly registry: Registry;
  private readonly host: ConversationHost;
  private readonly worker: string;
  private readonly extension: string;
  private readonly tasks: ThreadTasks | null;
  private readonly fibers = new Map<string, Fiber.Fiber<void, never>>();
  private readonly dispatching = new Set<string>();
  private readonly pendingDispatch = new Set<string>();

  constructor(registry: Registry, host: ConversationHost, options: { worker?: string; extension?: string; tasks?: ThreadTasks } = {}) {
    this.registry = registry;
    this.host = host;
    this.worker = options.worker ?? WORKER;
    this.extension = options.extension ?? EXTENSION;
    this.tasks = options.tasks ?? null;
    registry.failInterruptedAgentRuns();
    if (this.tasks) queueMicrotask(() => {
      void Effect.runPromise(this.tasks!.acceptedRecipients()).then((recipients) => recipients.forEach((id) => this.kickTasks(id)));
    });
  }

  history(threadId: string, after = 0): {
    messages: ConversationMessageRow[];
    run: ReturnType<Registry["activeAgentRun"]>;
  } {
    if (!this.registry.getThread(threadId)) throw new Error(`no such thread: ${threadId}`);
    return {
      messages: this.registry.listConversationMessages(threadId, after),
      run: this.registry.activeAgentRun(threadId) ?? this.registry.latestAgentRun(threadId),
    };
  }

  submit(threadId: string, text: string): Effect.Effect<{ runId: string }, ConversationError> {
    return Effect.gen({ self: this }, function*() {
      if (!this.registry.getThread(threadId)) {
        return yield* new ConversationError({ message: `no such thread: ${threadId}` });
      }
      if (this.registry.activeAgentRun(threadId)) {
        return yield* new ConversationError({ message: "thread is already working" });
      }
      const model = this.registry.getThreadModel(threadId);
      if (!model) return yield* new ConversationError({ message: "choose an available model before sending" });
      const runId = crypto.randomUUID();
      yield* Effect.try({
        try: () => {
          const thread = this.registry.getThread(threadId)!;
          this.registry.createAgentRun({ id: runId, threadId, text });
          if (thread.title === null) this.registry.setThreadTitle(threadId, text.replace(/\s+/g, " ").slice(0, 80));
        },
        catch: (cause) => new ConversationError({ message: "could not accept prompt", cause }),
      });
      this.startRun(threadId, runId, text, model);
      return { runId };
    });
  }

  sendTask(sender: string, input: unknown): Effect.Effect<ThreadTaskRow, import("./thread-tasks.ts").ThreadTaskError> {
    if (!this.tasks) return Effect.die("thread tasks are unavailable");
    return this.tasks.send(sender, input).pipe(Effect.tap((task) => Effect.sync(() => this.kickTasks(task.recipient))));
  }

  taskDestinations(actor: string) { return this.tasks ? this.tasks.destinations(actor) : Effect.die("thread tasks are unavailable"); }
  listTasks(actor: string) { return this.tasks ? this.tasks.list(actor) : Effect.die("thread tasks are unavailable"); }
  getTask(actor: string, id: string) { return this.tasks ? this.tasks.get(actor, id) : Effect.die("thread tasks are unavailable"); }

  cancelTask(sender: string, id: string): Effect.Effect<ThreadTaskRow, import("./thread-tasks.ts").ThreadTaskError> {
    if (!this.tasks) return Effect.die("thread tasks are unavailable");
    return Effect.gen({ self: this }, function*() {
      const task = yield* this.tasks!.cancel(sender, id);
      if (task.runId) {
        const fiber = this.fibers.get(task.runId);
        if (fiber) yield* Fiber.interrupt(fiber);
        this.registry.cancelAgentRun(task.runId);
      }
      this.kickTasks(task.recipient);
      return this.registry.getThreadTask(sender, id)!;
    });
  }

  kickTasks(recipient: string): void {
    if (!this.tasks) return;
    if (this.dispatching.has(recipient)) {
      this.pendingDispatch.add(recipient);
      return;
    }
    this.dispatching.add(recipient);
    void Effect.runPromise(this.dispatchTasks(recipient)).finally(() => {
      this.dispatching.delete(recipient);
      if (this.pendingDispatch.delete(recipient)) this.kickTasks(recipient);
    });
  }

  private readonly dispatchTasks = Effect.fn("Conversations.dispatchTasks")(function*(this: Conversations, recipient: string) {
    if (!this.tasks || this.registry.activeAgentRun(recipient)) return;
    let selected = this.registry.getThreadModel(recipient);
    if (!selected && this.host.defaultModel) {
      selected = yield* this.host.defaultModel();
      if (selected) this.registry.setThreadModel(recipient, selected);
    }
    if (!selected) return;
    for (;;) {
      const delivery = yield* this.tasks.beginNext(recipient);
      if (!delivery) return;
      if (delivery.task.status === "failed") continue;
      const model = this.registry.getThreadModel(recipient);
      if (!model) {
        yield* this.tasks.fail(delivery.task.id, "recipient has no available model");
        return;
      }
      this.startRun(recipient, delivery.task.runId!, delivery.prompt, model);
      return;
    }
  });

  private startRun(threadId: string, runId: string, prompt: string, model: ModelSelection): void {
    const fiber = Effect.runFork(this.execute(threadId, runId, prompt, model));
    this.fibers.set(runId, fiber);
    void Effect.runPromise(Fiber.await(fiber)).finally(() => {
      this.fibers.delete(runId);
      this.kickTasks(threadId);
    });
  }

  close(): Effect.Effect<void> {
    return Effect.forEach(this.fibers.values(), (fiber) => Fiber.interrupt(fiber), { discard: true });
  }

  cancelThread(threadId: string): Effect.Effect<void> {
    const run = this.registry.activeAgentRun(threadId);
    const fiber = run && this.fibers.get(run.id);
    return fiber ? Fiber.interrupt(fiber) : Effect.void;
  }

  private readonly execute = Effect.fn("Conversations.execute")(function*(
    this: Conversations,
    threadId: string,
    runId: string,
    prompt: string,
    model: ModelSelection,
  ) {
    const program = Effect.gen({ self: this }, function*() {
      this.registry.setAgentRunStatus(runId, "running");
      yield* this.host.activity(threadId);
      const plan = yield* this.host.plan(threadId);
      const history = this.registry.listConversationMessages(threadId)
        .filter((message) => !(message.runId === runId && message.role === "user"))
        .filter((message) => message.finalized)
        .map((message) => message.payload);
      const result = yield* this.runWorker(plan, { prompt, messages: history, extension: this.extension, model }, threadId, runId);
      this.registry.settleAgentRun(runId, "completed", null, boundedTaskResult(result));
      yield* this.host.activity(threadId);
    });
    yield* program.pipe(Effect.catch((error) => Effect.sync(() => {
      const message = error instanceof Error ? error.message : String(error);
      try { this.registry.settleAgentRun(runId, "failed", message, null); } catch { /* deleted or cancelled */ }
    })));
  });

  private runWorker(
    plan: { cwd: string; env: Record<string, string | undefined> },
    request: unknown,
    threadId: string,
    runId: string,
  ): Effect.Effect<string, ConversationError> {
    return Effect.callback<string, ConversationError>((resume) => {
      const child = spawn(process.execPath, [this.worker], {
        cwd: plan.cwd,
        env: plan.env,
        stdio: ["pipe", "ignore", "pipe", "pipe"],
      });
      let protocol = "";
      let stderr = "";
      let settled = false;
      let draft: ConversationMessageRow | null = null;
      let draftText = "";
      let draftThinking = "";
      let lastAssistant = "";
      const taskRun = this.registry.threadTaskForRun(runId) !== null;

      const finish = (effect: Effect.Effect<string, ConversationError>): void => {
        if (settled) return;
        settled = true;
        resume(effect);
      };
      const onEvent = (event: WorkerEvent): void => {
        if (event.type === "error") return finish(Effect.fail(new ConversationError({ message: event.message })));
        if (event.type === "complete") return finish(Effect.succeed(lastAssistant));
        if (event.type === "text_delta" || event.type === "thinking_delta") {
          if (event.type === "text_delta") draftText += event.delta;
          else draftThinking += event.delta;
          const content = draftThinking ? `${draftThinking}\n\n${draftText}`.trim() : draftText;
          if (taskRun && Buffer.byteLength(content, "utf8") > 16_384) {
            return finish(Effect.fail(new ConversationError({ message: "task result exceeded 16384 bytes" })));
          }
          const payload = { role: "assistant", content: [
            ...(draftThinking ? [{ type: "thinking", thinking: draftThinking }] : []),
            ...(draftText ? [{ type: "text", text: draftText }] : []),
          ], timestamp: Date.now() };
          if (draft) this.registry.updateConversationMessage(draft.seq, content, payload);
          else draft = this.registry.appendConversationMessage({
            threadId, runId, role: "assistant", content, payload, finalized: false,
          });
          return;
        }
        const message = event.message as {
          role?: unknown;
          content?: unknown;
          toolName?: unknown;
          stopReason?: unknown;
          errorMessage?: unknown;
        };
        if (message.role === "assistant" && message.stopReason === "error") {
          const detail = typeof message.errorMessage === "string" && message.errorMessage.trim()
            ? message.errorMessage.trim().slice(0, 8192)
            : "the model provider returned an error";
          return finish(Effect.fail(new ConversationError({ message: detail })));
        }
        const role = message.role === "toolResult" ? "tool" : "assistant";
        const content = messageText(message.content);
        if (taskRun && role === "assistant" && Buffer.byteLength(content, "utf8") > 16_384) {
          return finish(Effect.fail(new ConversationError({ message: "task result exceeded 16384 bytes" })));
        }
        if (role === "assistant") lastAssistant = content;
        if (role === "assistant" && draft) {
          this.registry.updateConversationMessage(draft.seq, content, message, true);
          draft = null;
        } else {
          this.registry.appendConversationMessage({ threadId, runId, role, content, payload: message });
        }
        if (role === "assistant") {
          draftText = "";
          draftThinking = "";
        }
      };

      const events = child.stdio[3];
      if (!events) return finish(Effect.fail(new ConversationError({ message: "agent worker protocol unavailable" })));
      events.on("data", (chunk: Buffer) => {
        protocol += chunk.toString("utf8");
        for (;;) {
          const newline = protocol.indexOf("\n");
          if (newline < 0) break;
          const line = protocol.slice(0, newline);
          protocol = protocol.slice(newline + 1);
          try { onEvent(Schema.decodeUnknownSync(WorkerEvent)(JSON.parse(line))); }
          catch (cause) { finish(Effect.fail(new ConversationError({ message: "agent worker sent an invalid event", cause }))); }
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 32_768) stderr += chunk.toString("utf8").slice(0, 32_768 - stderr.length);
      });
      child.once("error", (cause) => finish(Effect.fail(new ConversationError({ message: "could not start agent worker", cause }))));
      child.once("exit", (code) => {
        if (!settled) finish(code === 0
          ? Effect.fail(new ConversationError({ message: "agent worker ended before completing" }))
          : Effect.fail(new ConversationError({ message: stderr.trim() || `agent worker exited ${code}` })));
      });
      child.stdin!.end(JSON.stringify(request));
      return Effect.sync(() => stopChild(child));
    });
  }
}

function stopChild(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (!part || typeof part !== "object") return "";
    const value = part as { type?: unknown; text?: unknown; thinking?: unknown };
    return typeof value.text === "string" ? value.text
      : typeof value.thinking === "string" ? value.thinking
      : "";
  }).filter(Boolean).join("\n");
}
