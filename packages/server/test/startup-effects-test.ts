import assert from "node:assert/strict";
import { Effect, Result } from "effect";
import { makeEnvironmentProgress, STARTUP_LOG_LIMIT } from "../src/environment-progress.ts";
import { prepareRepositories, RepositoryRefreshError } from "../src/thread-preparation.ts";

await Effect.runPromise(Effect.gen(function*() {
  const progress = yield* makeEnvironmentProgress();
  yield* progress.update("thread", "preparing checkouts…");
  const first = (yield* progress.get("thread"))!;
  yield* progress.update("thread", "running .cube/setup…", "\x1b[31mstdout\x1b[0m\nstderr\n");
  const live = (yield* progress.get("thread"))!;
  assert.equal(first.startedAt, live.startedAt);
  assert.ok(live.updatedAt >= first.updatedAt);
  assert.ok(live.log.includes("stdout\nstderr"));
  assert.ok(!live.log.includes("\x1b"));
  assert.equal(yield* progress.get("other"), undefined);
  yield* progress.update("builder", "running shared setup…", "x".repeat(STARTUP_LOG_LIMIT * 2) + "final-output\n");
  yield* progress.copy("builder", "thread");
  const relayed = (yield* progress.get("thread"))!;
  assert.equal(relayed.startedAt, first.startedAt);
  assert.equal(relayed.log.length, STARTUP_LOG_LIMIT);
  assert.equal(relayed.truncated, true);
  assert.ok(relayed.log.endsWith("final-output\n"));
  yield* progress.copy("builder", "thread");
  assert.equal(yield* progress.get("thread"), relayed, "quiet copies do not create fake activity");
  yield* progress.forget("builder");
  assert.ok((yield* progress.get("thread"))!.log.endsWith("final-output\n"), "builder cleanup retains the displayed tail");
  yield* progress.update("thread", "setup failed", "exit 7", true);
  assert.equal((yield* progress.get("thread"))!.failed, true);
  yield* progress.forget("thread");
  assert.equal(yield* progress.get("thread"), undefined);

  let active = 0, peak = 0, completed = 0;
  const job = Effect.fnUntraced(function*(index: number, fail: boolean) {
    active++;
    peak = Math.max(peak, active);
    return yield* Effect.gen(function*() {
      yield* Effect.sleep(`${(8 - index) * 5} millis`);
      completed++;
      if (fail) return yield* new RepositoryRefreshError({ message: `failed ${index}`, cause: null });
      return index;
    }).pipe(Effect.ensuring(Effect.sync(() => { active--; })));
  });
  const values = yield* prepareRepositories(Array.from({ length: 8 }, (_, i) => job(i, false)));
  assert.deepEqual(values, [0, 1, 2, 3, 4, 5, 6, 7], "completion order does not reorder repositories");
  assert.equal(peak, 4);
  assert.equal(active, 0);
  completed = 0;
  const failed = yield* Effect.result(prepareRepositories(Array.from({ length: 8 }, (_, i) => job(i, i === 0))));
  assert.ok(Result.isFailure(failed));
  assert.equal(completed, 8, "failure drains all queued and running work before returning");
  assert.equal(active, 0);
}));
console.log("startup-effects-test: bounded snapshots, shared logs, ordered concurrency and failure draining pass");
