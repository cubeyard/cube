/** A thread's phase changes by typed events through one writer
 * (thread-phase.ts, Registry.applyPhase), offline:
 *
 *   T1  every PhaseEvent from each phase gives the literal phase the table
 *       says; `archived` is terminal;
 *   T2  through a real Registry, each event writes the fields and words the
 *       old writers wrote (an older cubed reads the row) and the runner's
 *       allocation state, frees the slot on `released` and writes nothing
 *       when nothing changes;
 *   T3  (typecheck) the old phase writers are gone. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Registry } from "../src/registry.ts";
import { allocationFailed, releaseFailed } from "../src/thread-failure.ts";
import { nextPhase, type PhaseEvent, type ThreadPhase } from "../src/thread-phase.ts";

const base = { remote: "https://github.com/o/r", ref: "refs/heads/main", oid: "a".repeat(40) };
const allocating: ThreadPhase = { workspaceState: "allocating", workspaceError: null, workspaceBase: null, archived: false };
const retried: ThreadPhase = { ...allocating, workspaceState: "failed", workspaceError: "workspace allocation failed: boom",
  retry: { failures: 2, at: 20, since: 10, error: "workspace allocation failed: boom" } };
const archived: ThreadPhase = { workspaceState: "releasing", workspaceError: null, workspaceBase: base, archived: true };

// ------------------------------------------------ T1: the table
const table: Array<[string, ThreadPhase, PhaseEvent, ThreadPhase]> = [
  ["allocating, ready", allocating, { type: "ready", base }, { ...allocating, workspaceState: "available", workspaceBase: base }],
  ["failed, ready (the retry stays until trySucceeded)", retried, { type: "ready", base: null }, { ...retried, workspaceState: "available", workspaceError: null }],
  ["allocating, failed", allocating, { type: "failed", failure: allocationFailed("boom") }, { ...allocating, workspaceState: "failed", workspaceError: "workspace allocation failed: boom" }],
  ["allocating, tryFailed (the first)", allocating, { type: "tryFailed", failure: allocationFailed("boom"), at: 5 },
    { ...allocating, retry: { failures: 1, at: 5, since: 5, error: "workspace allocation failed: boom" } }],
  ["failed, tryFailed (counts on)", retried, { type: "tryFailed", failure: allocationFailed("again"), at: 30 },
    { ...retried, retry: { failures: 3, at: 30, since: 10, error: "workspace allocation failed: again" } }],
  ["an older retry without since, tryFailed", { ...retried, retry: { failures: 1, at: 7, error: "x" } }, { type: "tryFailed", failure: allocationFailed("y"), at: 9 },
    { ...retried, retry: { failures: 2, at: 9, since: 7, error: "workspace allocation failed: y" } }],
  ["failed, trySucceeded", retried, { type: "trySucceeded" }, { workspaceState: "failed", workspaceError: "workspace allocation failed: boom", workspaceBase: null, archived: false }],
  ["failed, releaseBegan (its own tries count from here)", retried, { type: "releaseBegan" }, { workspaceState: "releasing", workspaceError: null, workspaceBase: null, archived: false }],
  ["releasing, failed (a release that failed)", { ...allocating, workspaceState: "releasing" }, { type: "failed", failure: releaseFailed("gone") },
    { ...allocating, workspaceState: "failed", workspaceError: "workspace release failed: gone" }],
  ["releasing, released", { ...allocating, workspaceState: "releasing", workspaceBase: base }, { type: "released" }, { ...allocating, workspaceState: "releasing", workspaceBase: base, archived: true }],
  ["failed, retaken (the retry stays until trySucceeded)", retried, { type: "retaken" }, { ...retried, workspaceState: "allocating", workspaceError: null }],
];
for (const [name, from, event, to] of table) assert.deepEqual(nextPhase(from, event), to, name);
const every: PhaseEvent[] = [{ type: "ready", base: null }, { type: "failed", failure: allocationFailed("x") }, { type: "tryFailed", failure: allocationFailed("x"), at: 1 },
  { type: "trySucceeded" }, { type: "releaseBegan" }, { type: "released" }, { type: "retaken" }];
for (const event of every) assert.deepEqual(nextPhase(archived, event), archived, `archived is terminal: ${event.type}`);
console.log(`ok: T1 ${table.length} transitions and every event on an archived thread match the table`);

// ------------------------------------------------ T2: through a real Registry
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-thread-phase-"));
try {
  const file = path.join(root, "registry.sqlite");
  const registry = new Registry(file);
  registry.saveProject({ id: "p", name: "p", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1, repositories: [] });
  registry.enrollRunner({ nodeId: "n", threadId: "r", environmentId: 1, configPath: "/private/r.json", configHash: "h", maxActiveVms: 1, protocol: 4, kind: "vm" } as never);
  const model = { provider: "faux", id: "faux" };
  const db = new DatabaseSync(file);
  const raw = (id: string) => JSON.parse((db.prepare("SELECT data FROM thread WHERE id = ?").get(id) as { data: string }).data) as Record<string, unknown>;
  const changed = (before: Record<string, unknown>, after: Record<string, unknown>) =>
    Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map(key => [key, key in after ? after[key] : "(gone)"]));

  const thread = registry.createThread("p", "a", model, "a");
  assert.equal(registry.createThread("p", "b", model, "b").vm?.suspension?.state, "queued", "one slot, held by the new thread: the next is queued");
  // The runner's row (its allocation state over its one slot) is updated in the same transaction.
  const steps: Array<[PhaseEvent, Record<string, unknown>, string]> = [
    [{ type: "tryFailed", failure: allocationFailed("boom"), at: 5 }, { retry: { failures: 1, at: 5, since: 5, error: "workspace allocation failed: boom" } }, "allocating"],
    [{ type: "failed", failure: allocationFailed("boom") }, { workspaceState: "failed", workspaceError: "workspace allocation failed: boom" }, "failed"],
    [{ type: "ready", base }, { workspaceState: "available", workspaceError: null, workspaceBase: base }, "busy"],
    [{ type: "trySucceeded" }, { retry: "(gone)" }, "busy"],
    [{ type: "trySucceeded" }, {}, "busy"],
    [{ type: "failed", failure: releaseFailed("gone") }, { workspaceState: "failed", workspaceError: "workspace release failed: gone" }, "failed"],
    [{ type: "releaseBegan" }, { workspaceState: "releasing", workspaceError: null }, "releasing"],
    [{ type: "released" }, { archived: true }, "available"],
    [{ type: "ready", base: null }, {}, "available"],
  ];
  for (const [event, expected, allocation] of steps) {
    const before = raw(thread.id);
    const written = registry.applyPhase(thread.id, event);
    assert.deepEqual(changed(before, raw(thread.id)), expected, `${event.type}: the row's changed fields`);
    assert.deepEqual(written, registry.getThread(thread.id), `${event.type}: returns the thread as written`);
    assert.equal(registry.runnerStatuses().find(row => row.id === "r")!.allocationState, allocation, `${event.type}: the runner's row`);
  }
  assert.equal(registry.createThread("p", "b", model, "b").runnerId, "r", "released frees the slot");
  db.close();
  registry.close();
  console.log("ok: T2 each event writes the old writers' fields and words and the runner's state, frees the slot on release, and writes nothing when nothing changes");
} finally { fs.rmSync(root, { recursive: true, force: true }); }

// ------------------------------------------------ T3: one writer
{
  const registry = null as unknown as Registry;
  if (registry) {
    // @ts-expect-error the phase changes only by applyPhase
    registry.markWorkspaceAvailable("x");
    // @ts-expect-error nor by markWorkspaceFailed
    registry.markWorkspaceFailed("x");
    // @ts-expect-error nor by recordFailure
    registry.recordFailure("x");
    // @ts-expect-error nor by clearFailures
    registry.clearFailures("x");
    // @ts-expect-error nor by beginRelease
    registry.beginRelease("x");
    // @ts-expect-error nor by finishRelease
    registry.finishRelease("x");
  }
}
