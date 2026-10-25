/** A thread's condition (thread-condition.ts) and every reader that renders
 * it, offline: for each kind of thread, the API's row (`threadRow`, what
 * index.ts serves) and OptChat's `threads`, `history`, overview and watcher
 * (`readThreads`, over a reader whose `condition` is the real
 * `threadCondition`) say these literal words. The rows marked "was" are
 * where the readers disagreed before each ranked the facts itself. */
import assert from "node:assert/strict";
import { ThreadFailure } from "../src/optchat.ts";
import { readThreads } from "../src/optchat-threads.ts";
import type { Registry, Thread } from "../src/registry.ts";
import { threadCondition, threadRow, type ThreadRuntime } from "../src/thread-condition.ts";

const E = "the runner cannot make its disk";
const W = "its runner does not answer";
const D = "the thread's agent stopped: its history could not be saved";
const R = "workspace release failed: the runner did not answer";

type Expect = { kind: string; row: ReturnType<typeof threadRow>; threads: string; machine: string | null; overview: string; watcher: string | null | { failure: string; waking: boolean; episode: string | null; retrying: boolean } };
const cases: Array<{ name: string; thread?: Partial<Thread>; runtime?: Partial<ThreadRuntime>; expect: Expect }> = [
  { name: "ready", expect: { kind: "ready", row: { state: "ready", error: null, waiting: null }, threads: "ready, completed", machine: "ready", overview: "completed", watcher: "stored" } },
  { name: "new, never started", thread: { workspaceState: "allocating" },
    // was: `threads` said "ready", `history` "not started"
    expect: { kind: "new", row: { state: "ready", error: null, waiting: null }, threads: "not started", machine: "not started", overview: "not started", watcher: "stored" } },
  { name: "starting", runtime: { starting: true },
    expect: { kind: "starting", row: { state: "starting", error: null, waiting: null }, threads: "starting its machine", machine: "starting its machine", overview: "starting", watcher: "stored" } },
  { name: "starting again after a failed try", runtime: { starting: true, error: E },
    expect: { kind: "starting", row: { state: "error", error: E, waiting: null }, threads: `starting its machine again (the last try failed: ${E})`,
      machine: `starting its machine again (the last try failed: ${E})`, overview: "starting", watcher: { failure: E, waking: false, episode: null, retrying: true } } },
  { name: "waiting for a runner, no agent open", runtime: { waiting: W },
    expect: { kind: "waiting", row: { state: "starting", error: null, waiting: W }, threads: `starting its machine, ${W}`, machine: `starting its machine, ${W}`,
      overview: "waiting for a runner", watcher: { failure: W, waking: false, episode: null, retrying: true } } },
  { name: "agent open, its runner does not answer", runtime: { agentOpen: true, waiting: W },
    expect: { kind: "ready", row: { state: "ready", error: null, waiting: W }, threads: `ready (its runner does not answer now: ${W}), completed`,
      machine: `ready (its runner does not answer now: ${W})`, overview: "completed", watcher: "stored" } },
  { name: "agent open, a later check failed", runtime: { agentOpen: true, error: E },
    expect: { kind: "ready", row: { state: "error", error: E, waiting: null }, threads: `ready (a later check of its machine failed: ${E}), completed`,
      machine: `ready (a later check of its machine failed: ${E})`, overview: "completed", watcher: "stored" } },
  { name: "failed", runtime: { error: E },
    expect: { kind: "failed", row: { state: "error", error: E, waiting: null }, threads: `error: ${E}`, machine: `error: ${E}`, overview: "machine error",
      watcher: { failure: E, waking: false, episode: null, retrying: true } } },
  { name: "failed, known only from its row", thread: { workspaceState: "failed", workspaceError: "workspace allocation failed: boom" },
    // was: the row said "ready", `threads` "ready", the overview "machine failed"
    expect: { kind: "failed", row: { state: "error", error: "workspace allocation failed: boom", waiting: null }, threads: "error: workspace allocation failed: boom",
      machine: "error: workspace allocation failed: boom", overview: "machine error", watcher: { failure: "workspace allocation failed: boom", waking: false, episode: null, retrying: true } } },
  { name: "agent open, its row records a failure", thread: { workspaceState: "failed", workspaceError: "workspace allocation failed: boom" }, runtime: { agentOpen: true },
    // was: history's failure said it, the row and `threads` did not
    expect: { kind: "ready", row: { state: "error", error: "workspace allocation failed: boom", waiting: null },
      threads: "ready (a later check of its machine failed: workspace allocation failed: boom), completed",
      machine: "ready (a later check of its machine failed: workspace allocation failed: boom)", overview: "completed", watcher: "stored" } },
  { name: "agent down", runtime: { agentOpen: true, down: D },
    // was: the row said "error", `threads` "ready", the overview the stored run
    expect: { kind: "down", row: { state: "error", error: D, waiting: null }, threads: `error: ${D}`, machine: `error: ${D}`, overview: "agent error", watcher: "stored" } },
  { name: "agent down, after a reboot", runtime: { down: D, error: D },
    expect: { kind: "down", row: { state: "error", error: D, waiting: null }, threads: `error: ${D}`, machine: `error: ${D}`, overview: "agent error",
      // was: the watcher said cubed keeps retrying; nothing retries a down agent before a restart
      watcher: { failure: D, waking: false, episode: null, retrying: false } } },
  { name: "suspended", thread: { vm: { suspension: { state: "suspended", at: 1 } } as Thread["vm"] },
    // was: `history` said "ready"
    expect: { kind: "ready", row: { state: "ready", error: null, waiting: null }, threads: "its machine is suspended (idle; it wakes when told), completed",
      machine: "its machine is suspended (idle; it wakes when told)", overview: "completed", watcher: "stored" } },
  { name: "waking, waiting for a slot", thread: { vm: { suspension: { state: "waking", at: 1, waiting: "the runner is full" } } as Thread["vm"] },
    expect: { kind: "ready", row: { state: "ready", error: null, waiting: null }, threads: "its machine is being woken (the runner is full), completed",
      machine: "its machine is being woken (the runner is full)", overview: "completed", watcher: "stored" } },
  { name: "a wake that failed", thread: { vm: { suspension: { state: "suspended", at: 1 } } as Thread["vm"], retry: { failures: 2, at: 5, since: 3, error: E } },
    runtime: { error: E },
    expect: { kind: "failed", row: { state: "error", error: E, waiting: null }, threads: `its machine is suspended and waking it failed: ${E}`,
      machine: `its machine is suspended and waking it failed: ${E}`, overview: "machine error", watcher: { failure: E, waking: true, episode: "3", retrying: true } } },
  { name: "being archived", runtime: { archiving: true },
    expect: { kind: "archiving", row: { state: "ready", error: null, waiting: null }, threads: "being archived", machine: "being archived", overview: "being archived", watcher: "archiving" } },
  { name: "being archived, its machine asleep", thread: { vm: { suspension: { state: "suspended", at: 1 } } as Thread["vm"] }, runtime: { archiving: true },
    // was: `threads` said "its machine is suspended"
    expect: { kind: "archiving", row: { state: "ready", error: null, waiting: null }, threads: "being archived", machine: "being archived", overview: "being archived", watcher: "archiving" } },
  { name: "a release that failed, retried", thread: { workspaceState: "failed", workspaceError: R }, runtime: { error: R },
    // was: `threads` said "error: …", the overview "machine error"
    expect: { kind: "archiving", row: { state: "error", error: R, waiting: null }, threads: `being archived (the last try failed: ${R})`,
      machine: `being archived (the last try failed: ${R})`, overview: "being archived", watcher: "archiving" } },
  // Ranking cases between kinds (review 7ed05705).
  { name: "agent down, being archived", runtime: { archiving: true, agentOpen: true, down: D },
    expect: { kind: "archiving", row: { state: "ready", error: null, waiting: null }, threads: "being archived", machine: "being archived", overview: "being archived", watcher: "archiving" } },
  { name: "never started, waiting for a runner", thread: { workspaceState: "allocating" }, runtime: { waiting: W },
    expect: { kind: "waiting", row: { state: "starting", error: null, waiting: W }, threads: `starting its machine, ${W}`, machine: `starting its machine, ${W}`,
      overview: "waiting for a runner", watcher: { failure: W, waking: false, episode: null, retrying: true } } },
  { name: "agent open, its machine asleep, a wake failed", thread: { vm: { suspension: { state: "suspended", at: 1 } } as Thread["vm"] }, runtime: { agentOpen: true, error: E },
    expect: { kind: "failed", row: { state: "error", error: E, waiting: null }, threads: `its machine is suspended and waking it failed: ${E}`,
      machine: `its machine is suspended and waking it failed: ${E}`, overview: "machine error", watcher: "stored" } },
  { name: "a release that failed, known only from its row", thread: { workspaceState: "failed", workspaceError: R },
    // was: the row said "ready" and `threads` "being archived": a restart lost the release's failure
    expect: { kind: "archiving", row: { state: "error", error: R, waiting: null }, threads: `being archived (the last try failed: ${R})`,
      machine: `being archived (the last try failed: ${R})`, overview: "being archived", watcher: "archiving" } },
];

const model = { provider: "faux", id: "faux" };
const thread = (n: number, extra: Partial<Thread> = {}) => ({
  id: `c0c0c0c0-0000-4000-8000-${String(n).padStart(12, "0")}`, title: `t${n}`, archived: false, workspaceState: "available", workspaceError: null, runnerId: "r",
  projectId: "p", agent: "pi", model, allocation: { repositories: [], skills: null, hooks: null }, vm: { vmId: `${n}`.padEnd(16, "0"), placeholders: {} }, ...extra,
}) as unknown as Thread;
const idle: ThreadRuntime = { archiving: false, starting: false, agentOpen: false, error: null, down: null, waiting: null };

for (const [n, item] of cases.entries()) {
  const t = thread(n, item.thread);
  const runtime = { ...idle, ...item.runtime };
  const registry = { getThread: (id: string) => id === t.id ? t : null, getProject: () => ({ name: "web" }) } as unknown as Registry;
  const reader = {
    condition: (row: Thread) => threadCondition(row, runtime), agentOpen: () => runtime.agentOpen, owner: () => null, live: async () => null,
    async storedHistory() { return t.workspaceState === "allocating" ? null : { status: { state: "completed", run: "r", error: null } }; },
  } as unknown as Parameters<typeof readThreads>[0]["conversations"];
  const reads = readThreads({ registry, conversations: reader });
  const condition = threadCondition(t, runtime);
  assert.equal(condition.kind, item.expect.kind, `${item.name}: kind`);
  assert.deepEqual(threadRow(condition), item.expect.row, `${item.name}: the API's row`);
  assert.equal(await reads.describe([t.id]), `[${t.id.slice(0, 8)}] web · ${t.title} · ${item.expect.threads}`, `${item.name}: threads`);
  const record = (await reads.history(t.id))!;
  assert.equal(record.machine, item.expect.machine, `${item.name}: history's machine`);
  assert.equal(record.failure, item.expect.row.error, `${item.name}: history's failure is the row's error`);
  assert.equal((await reads.observe([t.id])).get(t.id)?.state, item.expect.overview, `${item.name}: the overview`);
  const watched = await reads.events(t.id).then(events => events === "stored" || events === "archiving" || events === null ? events : "live",
    (error: unknown) => error instanceof ThreadFailure ? { failure: error.message, waking: error.waking, episode: error.episode, retrying: error.retrying } : String(error));
  assert.deepEqual(watched, item.expect.watcher, `${item.name}: the watcher`);
}
console.log(`ok: ${cases.length} kinds of thread: the API's row, threads, history, the overview and the watcher render one condition, in these words`);

{
  const t = thread(99, { archived: true, workspaceState: "failed", workspaceError: R });
  const registry = { getThread: () => t, getProject: () => ({ name: "web" }) } as unknown as Registry;
  const reads = readThreads({ registry, conversations: { condition: (row: Thread) => threadCondition(row, idle), agentOpen: () => false, owner: () => null,
    async storedHistory() { return null; } } as unknown as Parameters<typeof readThreads>[0]["conversations"] });
  assert.deepEqual(threadCondition(t, { ...idle, error: "an old try's failure" }), { kind: "archived", failure: R });
  assert.equal((await reads.history(t.id))!.machine, null);
  assert.equal((await reads.history(t.id))!.failure, R, "an archived thread's failure is its release's");
  assert.equal((await reads.observe([t.id])).get(t.id)?.state, "archived");
  assert.equal(await reads.events(t.id), null, "the watcher of an archived thread stops");
  console.log("ok: an archived thread reads as archived, with its release's failure only");
}
