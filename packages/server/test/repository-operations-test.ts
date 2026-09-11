import assert from "node:assert/strict";
import { Effect } from "effect";
import { RepositoryOperations, runRepositoryEffect } from "../src/repository-operations.ts";
import type { CubeRepositoryRow, CubeRow } from "../src/registry.ts";

const cube = { name: "thread-one" } as CubeRow;
const repository = { id: 2, workspacePath: "/thread-one/repos/envs" } as CubeRepositoryRow;
let reserved = 0;
let authenticated = 0;
let successes = 0;
let failures = 0;
let removing = false;
let authFailure: Error | undefined;
const operations = RepositoryOperations.make({
  resolve(threadId, id) {
    if (threadId !== "one" || id !== repository.id) throw new Error("no such repository");
    return { cube, repository };
  },
  requireSeeded(target) { assert.equal(target.repository, repository); },
  async authenticate() {
    assert.equal(reserved, 1, "auth is covered by the lifetime reservation too");
    authenticated++;
    if (authFailure) throw authFailure;
  },
  reserve(name) {
    assert.equal(name, cube.name);
    if (removing) throw new Error("being removed");
    reserved++;
    return {
      release() { reserved--; },
      success() { successes++; },
      failure() { failures++; },
    };
  },
});
const run = (online = true) => runRepositoryEffect(RepositoryOperations.use(service => service.run(
  "one", 2, "push", async repo => repo.workspacePath, { online },
)).pipe(Effect.provideService(RepositoryOperations, operations)));
assert.equal(await run(), repository.workspacePath);
assert.equal(reserved, 0);
assert.equal(successes, 1);
await run(false);
assert.equal(authenticated, 1, "local planning/inspection needs no authentication");
for (const id of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 3]) {
  await assert.rejects(runRepositoryEffect(operations.run("one", id, "push", async () => { throw new Error("must not execute"); }, { online: true })));
}
await assert.rejects(runRepositoryEffect(operations.run("other", 2, "push", async () => {}, { online: true })), /no such repository/);
assert.equal(authenticated, 1, "unauthorized and malformed IDs never refresh credentials");
assert.equal(reserved, 0);
removing = true;
await assert.rejects(run(), /being removed/);
removing = false;
authFailure = new Error("expired auth");
await assert.rejects(run(), error => error === authFailure);
assert.equal(reserved, 0);
assert.equal(failures, 1);
authFailure = undefined;

// An aborted git adapter must drain before the deletion reservation is freed.
const controller = new AbortController();
const reason = new Error("request cancelled");
let entered!: () => void;
const started = new Promise<void>(resolve => { entered = resolve; });
let drain!: () => void;
const drained = new Promise<void>(resolve => { drain = resolve; });
const pending = runRepositoryEffect(operations.run("one", 2, "push", async () => {
  entered();
  await drained;
  controller.signal.throwIfAborted();
}, { online: true, signal: controller.signal }));
await started;
controller.abort(reason);
assert.equal(reserved, 1);
drain();
await assert.rejects(pending, error => error === reason);
assert.equal(reserved, 0);
assert.equal(failures, 2);
const before = authenticated;
await assert.rejects(runRepositoryEffect(operations.run("one", 2, "push", async () => {}, { online: true, signal: controller.signal })), error => error === reason);
assert.equal(authenticated, before, "pre-aborted calls never authenticate or publish");
assert.equal(reserved, 0);
console.log("repository operations: scoped authorization, auth, finalization and cancellation pass");
