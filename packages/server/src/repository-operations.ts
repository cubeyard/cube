import { Context, Effect, Schema } from "effect";
import type { CubeRepositoryRow, CubeRow } from "./registry.ts";

const decodeRepositoryId = Schema.decodeUnknownEffect(
  Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
);

type Target = { cube: CubeRow; repository: CubeRepositoryRow };
type Reservation = {
  release(): void;
  success(): void;
  failure(cause: unknown): void;
};

export class RepositoryOperationError extends Schema.TaggedError<RepositoryOperationError>()(
  "RepositoryOperationError", { cause: Schema.Defect() },
) {}
const failure = (cause: unknown) => new RepositoryOperationError({ cause });

interface Dependencies {
  resolve(threadId: string, repositoryId: number): Target;
  requireSeeded(target: Target): void;
  authenticate(): Promise<void>;
  reserve(cubeName: string, label: string | null): Reservation;
}

interface Operations {
  guard<A>(cubeName: string, label: string | null, work: Effect.Effect<A, RepositoryOperationError>): Effect.Effect<A, RepositoryOperationError>;
  run<A>(threadId: string, repositoryId: number, label: string, work: (repository: CubeRepositoryRow) => Promise<A>, options: { signal?: AbortSignal; online: boolean }): Effect.Effect<A, RepositoryOperationError>;
}

/** Thread-scoped authorization and lifetime for every checkout. Credentials
 * remain behind the Promise adapters on the host; no operation is retried. */
export class RepositoryOperations extends Context.Service<RepositoryOperations, Operations>()(
  "@cube/server/RepositoryOperations",
) {
  static make(deps: Dependencies): Operations {
    const guard = Effect.fn("RepositoryOperations.guard")(<A>(cubeName: string, label: string | null, work: Effect.Effect<A, RepositoryOperationError>) =>
      Effect.acquireUseRelease(
        Effect.try({ try: () => deps.reserve(cubeName, label), catch: failure }),
        (reservation) => work.pipe(
          Effect.tap(() => Effect.sync(() => reservation.success())),
          Effect.tapError((error) => Effect.sync(() => reservation.failure(error.cause))),
        ),
        (reservation) => Effect.sync(() => reservation.release()),
      ).pipe(
        // The legacy git adapters settle only after their subprocesses drain.
        // Forward request cancellation to them, but never release the deletion
        // guard early by interrupting a still-running publication Promise.
        Effect.uninterruptible,
      ),
    );
    const run = Effect.fn("RepositoryOperations.run")(function*<A>(
      threadId: string, repositoryId: number, label: string,
      work: (repository: CubeRepositoryRow) => Promise<A>,
      options: { signal?: AbortSignal; online: boolean },
    ) {
      const id = yield* decodeRepositoryId(repositoryId).pipe(Effect.mapError(failure));
      const target = yield* Effect.try({ try: () => deps.resolve(threadId, id), catch: failure });
      return yield* guard(target.cube.name, label, Effect.gen(function*() {
        yield* Effect.try({
          try: () => { options.signal?.throwIfAborted(); deps.requireSeeded(target); },
          catch: failure,
        });
        if (options.online) yield* Effect.tryPromise({ try: () => deps.authenticate(), catch: failure });
        yield* Effect.try({ try: () => options.signal?.throwIfAborted(), catch: failure });
        return yield* Effect.tryPromise({ try: () => work(target.repository), catch: failure });
      }));
    });
    return RepositoryOperations.of({ guard, run });
  }
}

/** Keep the existing HTTP/Promise error contract at the application edge. */
export const runRepositoryEffect = <A>(effect: Effect.Effect<A, RepositoryOperationError>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.mapError((error) => error.cause)));
