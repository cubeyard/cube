/** Cube-owned durable thread delivery domain. SQLite in Registry is the sole
 * authority; this Effect service validates capabilities and exposes no worker
 * or transport identity to callers. */
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";

import { Registry, type ThreadTaskRow } from "./registry.ts";

const TaskSend = Schema.Struct({
  recipient: Schema.String,
  requestKey: Schema.String,
  body: Schema.String,
});

export class ThreadTaskError extends Schema.TaggedError<ThreadTaskError>()("ThreadTaskError", {
  code: Schema.Literals(["INVALID_REQUEST", "NOT_FOUND", "NOT_PERMITTED", "CONFLICT", "CAPACITY_EXCEEDED"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const validText = (value: string, bytes: number, label: string): void => {
  if (!value.trim() || Buffer.byteLength(value, "utf8") > bytes
    || Buffer.from(value, "utf8").toString("utf8") !== value) {
    throw new ThreadTaskError({ code: "INVALID_REQUEST", message: `${label} is empty or too long` });
  }
};

const validId = (value: string, label: string): void => {
  validText(value, 128, label);
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
    throw new ThreadTaskError({ code: "INVALID_REQUEST", message: `${label} is invalid` });
  }
};

const mapError = (cause: unknown): ThreadTaskError => {
  if (cause instanceof ThreadTaskError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = /not found|no such/.test(message) ? "NOT_FOUND"
    : /not permitted|unavailable/.test(message) ? "NOT_PERMITTED"
    : /conflict/.test(message) ? "CONFLICT"
    : /rate|full/.test(message) ? "CAPACITY_EXCEEDED"
    : "INVALID_REQUEST";
  return new ThreadTaskError({ code, message, cause });
};

export class ThreadTasks {
  private readonly registry: Registry;
  constructor(registry: Registry) { this.registry = registry; }

  destinations = Effect.fn("ThreadTasks.destinations")(function*(this: ThreadTasks, actor: string) {
    validId(actor, "thread");
    return yield* Effect.try({ try: () => this.registry.threadTaskDestinations(actor), catch: mapError });
  });

  list = Effect.fn("ThreadTasks.list")(function*(this: ThreadTasks, actor: string) {
    validId(actor, "thread");
    return yield* Effect.try({ try: () => this.registry.listThreadTasks(actor), catch: mapError });
  });

  get = Effect.fn("ThreadTasks.get")(function*(this: ThreadTasks, actor: string, id: string) {
    validId(actor, "thread"); validId(id, "task id");
    const task = yield* Effect.try({ try: () => this.registry.getThreadTask(actor, id), catch: mapError });
    if (!task) return yield* new ThreadTaskError({ code: "NOT_FOUND", message: "task not found" });
    return task;
  });

  send = Effect.fn("ThreadTasks.send")(function*(this: ThreadTasks, actor: string, input: unknown) {
    validId(actor, "thread");
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some((key) => !["recipient", "requestKey", "body"].includes(key))) {
      return yield* new ThreadTaskError({ code: "INVALID_REQUEST", message: "invalid task request" });
    }
    const decoded = yield* Schema.decodeUnknownEffect(TaskSend)(input).pipe(Effect.mapError((cause) =>
      new ThreadTaskError({ code: "INVALID_REQUEST", message: "invalid task request", cause })));
    validId(decoded.recipient, "recipient");
    validId(decoded.requestKey, "request key");
    validText(decoded.body, 16_384, "task body");
    return yield* Effect.try({
      try: () => this.registry.acceptThreadTask({ id: `task-${randomUUID()}`, sender: actor, ...decoded }),
      catch: mapError,
    });
  });

  cancel = Effect.fn("ThreadTasks.cancel")(function*(this: ThreadTasks, actor: string, id: string) {
    validId(actor, "thread"); validId(id, "task id");
    return yield* Effect.try({ try: () => this.registry.cancelThreadTask(actor, id), catch: mapError });
  });

  grant = Effect.fn("ThreadTasks.grant")(function*(this: ThreadTasks, sender: string, recipient: string) {
    validId(sender, "sender"); validId(recipient, "recipient");
    yield* Effect.try({ try: () => this.registry.grantThreadTask(sender, recipient), catch: mapError });
  });

  revoke = Effect.fn("ThreadTasks.revoke")(function*(this: ThreadTasks, sender: string, recipient: string) {
    validId(sender, "sender"); validId(recipient, "recipient");
    yield* Effect.sync(() => this.registry.revokeThreadTask(sender, recipient));
  });

  beginNext = Effect.fn("ThreadTasks.beginNext")(function*(this: ThreadTasks, recipient: string) {
    validId(recipient, "recipient");
    return yield* Effect.try({
      try: () => this.registry.deliverNextThreadTask(recipient, `run-${randomUUID()}`),
      catch: mapError,
    });
  });

  fail = (id: string, error: string): Effect.Effect<void> =>
    Effect.sync(() => this.registry.failThreadTask(id, error));

  acceptedRecipients = (): Effect.Effect<string[]> =>
    Effect.sync(() => this.registry.acceptedTaskRecipients());

  preflightDelete = (threadId: string): Effect.Effect<void, ThreadTaskError> =>
    Effect.try({ try: () => this.registry.assertThreadTaskDeletable(threadId), catch: mapError });
}

export function boundedTaskResult(value: string): string | null {
  return Buffer.byteLength(value, "utf8") <= 16_384
    && Buffer.from(value, "utf8").toString("utf8") === value
    && value.trim() ? value : null;
}

export type { ThreadTaskRow };
