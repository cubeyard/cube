import { Effect, Result, Schema } from "effect";

export class RepositoryRefreshError extends Schema.TaggedError<RepositoryRefreshError>()("RepositoryRefreshError", {
  message: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A bounded batch, with all work drained before the caller can close its
 * registry. Result mode is deliberate: failure must not orphan sibling promises. */
export const prepareRepositories = Effect.fn("prepareRepositories")(
  function*<A>(tasks: ReadonlyArray<Effect.Effect<A, RepositoryRefreshError>>) {
    const results = yield* Effect.all(tasks, { concurrency: 4, mode: "result" });
    const values: A[] = [];
    for (const result of results) {
      if (Result.isFailure(result)) return yield* Effect.fail(result.failure);
      values.push(result.success);
    }
    return values;
  },
);
