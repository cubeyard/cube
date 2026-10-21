/**
 * runner-vm-cubed-test's G1 step (cubed closes while a thread's command runs
 * in its keel machine; the reopened cubed reattaches the command): its
 * evidence, and the offline guards for it. Run directly, this is an offline
 * test; runner-vm-cubed-test imports the evidence half. It is not the native
 * gate: only a real `berth vm` run of runner-vm-cubed-test exercises the
 * close and the reattach.
 *
 * The step's first native run (server1 S4, candidate 8a434535) prompted a
 * thread it had archived earlier and failed with `404 thread not found`
 * before cubed was closed; its wait also took a model's tool call for the
 * command running. So the step prompts a live thread of its own, waits for
 * evidence from the guest itself that the command started, and
 * `checkReattach` rejects a command that started after the close, started
 * twice, or ran anew after the reopen.
 *
 * Offline (run directly): an archived thread answers 404 to prompt, history
 * and stop with no model call (what the first run tripped on); every
 * evidence `checkReattach` must refuse is refused; and runner-vm-cubed-test's
 * G1 step still uses this evidence (a guard against the checks being
 * dropped from the native step, read from its source).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The command's sleep: a command started after the reopen cannot finish
 * sooner than this after it. */
export const REATTACH_SLEEP_MS = 60_000;
/** The bash call's own timeout: above the sleep and the start request. */
export const REATTACH_TIMEOUT_MS = 180_000;

/** The command the step runs. Each start appends one `x` to ca-started and
 * sends one request to the fake GitHub through the guest's own network
 * (berth, cubed's gateway, its test upstream), before the sleep; the effect
 * (ca-reattach) and the output come after it. */
export function reattachCommand(nonce: string): string {
  assert.match(nonce, /^[0-9a-f]{8,}$/, "a hex nonce");
  return `printf x >> ca-started; curl -s -m 10 -o /dev/null 'https://github.com/cube-test/echo?ca-start=${nonce}' || true; `
    + `sleep ${REATTACH_SLEEP_MS / 1000}; printf once >> ca-reattach; printf reattached`;
}

/** How many of the command's start requests the fake GitHub saw (its
 * `requests` lines: `METHOD host/path?query auth=...`). */
export function startRequests(requests: readonly string[], nonce: string): number {
  return requests.filter(line => line.split(" ")[1]?.endsWith(`/cube-test/echo?ca-start=${nonce}`)).length;
}

export interface ReattachEvidence {
  /** The start requests the fake GitHub saw over the whole step, after the run. */
  starts: number;
  /** Host clock: when the first start request was seen (before the close). */
  startedAt: number;
  /** Host clock: when cubed's close began. */
  closingAt: number;
  /** Host clock: when the reopened cubed listened. */
  reopenedAt: number;
  /** Host clock: when the run was seen settled after the reopen. */
  completedAt: number;
  /** `cat ca-started` in the machine after the run. */
  startMarker: string;
  /** `cat ca-reattach` in the machine after the run. */
  effect: string;
  /** The run's tool results. */
  results: ReadonlyArray<{ output?: string; isError?: boolean }>;
}

/** Throws unless the command started in the guest before the close, started
 * once, ran across the close (not anew after the reopen), finished its
 * sleep, had its effect once and gave its own result. Answers a summary. */
export function checkReattach(evidence: ReattachEvidence): string {
  const { starts, startedAt, closingAt, reopenedAt, completedAt, startMarker, effect, results } = evidence;
  assert.ok(startedAt < closingAt && closingAt < reopenedAt && reopenedAt < completedAt, `host times in order: ${JSON.stringify(evidence)}`);
  assert.equal(starts, 1, `the command started once in the guest: ${starts} start requests reached the fake GitHub`);
  assert.equal(startMarker, "x", `the command started once in the guest: ca-started is ${JSON.stringify(startMarker)}`);
  // Its sleep begins after the start request was answered, so it cannot end
  // sooner after it was seen (one 250 ms poll of slack).
  assert.ok(completedAt - startedAt >= REATTACH_SLEEP_MS - 250, `the command ran its whole sleep: settled ${completedAt - startedAt} ms after its start`);
  // A command started after the reopen needs its whole sleep after it; one
  // that ran across the close ends sooner (it started before the close).
  const afterReopen = completedAt - reopenedAt;
  assert.ok(afterReopen < REATTACH_SLEEP_MS, `the command ran across the close, not anew after the reopen: settled ${afterReopen} ms after the reopen (a new start needs ${REATTACH_SLEEP_MS} ms)`);
  assert.equal(effect, "once", "its effect happened once");
  assert.ok(results.some(result => !result.isError && result.output?.includes("reattached")), `the command was reattached: ${JSON.stringify(results.slice(-2))}`);
  return `started in the guest ${((closingAt - startedAt) / 1000).toFixed(1)} s before the close, once; settled ${(afterReopen / 1000).toFixed(1)} s after the reopen (a new start needs ${REATTACH_SLEEP_MS / 1000} s)`;
}

if (import.meta.main) {
  // 1. Every evidence checkReattach must refuse is refused, each for its own reason.
  const nonce = "0123abcd4567";
  const command = reattachCommand(nonce);
  const first = (text: string) => command.indexOf(text);
  assert.ok(first("printf x >> ca-started") >= 0 && first("printf x >> ca-started") < first("curl ") && first("curl ") < first("sleep 60")
    && first("sleep 60") < first("printf once >> ca-reattach"), `marker and start request before the sleep, the effect after it: ${command}`);
  assert.equal(command.split("ca-started").length, 2, "one start marker per start");
  assert.equal(startRequests([
    `GET github.com/cube-test/echo?ca-start=${nonce} auth=none`,
    "GET github.com/cube-test/echo?ca-start=ffffffffffff auth=none",
    `POST github.com/cube-e2e/repo.git/git-receive-pack?ca-start=${nonce}x auth=Basic`,
  ], nonce), 1, "only this step's start requests count");

  const t = 1_000_000;
  const good: ReattachEvidence = { starts: 1, startedAt: t, closingAt: t + 5_000, reopenedAt: t + 8_000, completedAt: t + 61_000,
    startMarker: "x", effect: "once", results: [{ output: "reattached\n[exit=0; exited]", isError: false }] };
  assert.match(checkReattach(good), /^started in the guest 5\.0 s before the close, once; settled 53\.0 s after the reopen/);
  const refused: Array<[string, Partial<ReattachEvidence>, RegExp]> = [
    ["started after the close", { startedAt: t + 6_000 }, /host times in order/],
    ["a second start request (a new start after the reopen)", { starts: 2 }, /started once in the guest: 2 start requests/],
    ["no start request", { starts: 0 }, /started once in the guest: 0 start requests/],
    ["a second start marker", { startMarker: "xx" }, /ca-started is "xx"/],
    ["settled before its sleep could end", { completedAt: t + 30_000 }, /ran its whole sleep/],
    ["a fresh run after the reopen", { reopenedAt: t + 8_000, completedAt: t + 8_000 + REATTACH_SLEEP_MS + 500 }, /not anew after the reopen/],
    ["its effect twice", { effect: "onceonce" }, /its effect happened once/],
    ["no effect", { effect: "" }, /its effect happened once/],
    ["its result an error", { results: [{ output: "reattached", isError: true }] }, /the command was reattached/],
    ["no result of its own", { results: [{ output: "command outcome is unknown", isError: false }] }, /the command was reattached/],
  ];
  for (const [what, change, reason] of refused) assert.throws(() => checkReattach({ ...good, ...change }), reason, `refused: ${what}`);

  // 2. The native step still uses this evidence: its G1 block, from its source.
  const source = fs.readFileSync(path.join(import.meta.dirname, "runner-vm-cubed-test.ts"), "utf8");
  const block = source.slice(source.indexOf("cubed closes while a thread's command runs in its machine (G1)"), source.indexOf("console.log(\"ok: cubed with berth vm"));
  assert.ok(block.length > 0, "runner-vm-cubed-test has its G1 step");
  for (const use of ["from \"./reattach-step-test.ts\"", "threads.spawn(", "reattachCommand(nonce)", "startRequests(github.requests, nonce)", "until(\"the command runs in the machine", "checkReattach({"]) {
    assert.ok((use.startsWith("from ") ? source : block).includes(use), `runner-vm-cubed-test's G1 step uses ${use}`);
  }
  assert.ok(block.indexOf("startRequests(github.requests, nonce)") < block.indexOf("app.close()"), "it waits for the guest's start request before the close");
  assert.ok(!/api\(`\/api\/threads\/\$\{(second|third|id)\}\/prompt`/.test(block), "it prompts none of the threads archived or discarded before it");

  // 3. What the first native run tripped on: an archived thread takes no new work.
  const { createModels, fauxProvider } = await import("@earendil-works/pi-ai");
  const { createCubed } = await import("../src/index.ts");
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "cube-archived-"));
  const models = createModels();
  const faux = fauxProvider(); models.setProvider(faux.provider);
  const app = await createCubed({ state, models, claude: null, gateway: null });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  assert(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (route: string, method = "GET", body?: unknown) => {
    const response = await fetch(`${base}${route}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  try {
    app.registry.enrollRunner({ nodeId: "node-archived", threadId: "runner-archived", environmentId: 1, configPath: "/private/archived.json", configHash: "archived", protocol: 4, kind: "vm" });
    const project = (await call("/api/projects", "POST", { name: "archived", repositories: [] })).body.project as { id: string };
    const model = { provider: faux.getModel().provider, id: faux.getModel().id };
    // Archived first: that frees the runner's one slot for the live thread.
    const gone = app.registry.createThread(project.id, "gone", model, "hello", "pi");
    app.registry.finishRelease(gone.id);
    const live = app.registry.createThread(project.id, "live", model, "hello", "pi");
    // A live thread's routes are found (whatever its machine is doing).
    assert.notEqual((await call(`/api/threads/${live.id}/history`)).status, 404, "a live thread's history is found");
    // The archived one: the exact answer S4 got, for every route a turn uses.
    const prompt = await call(`/api/threads/${gone.id}/prompt`, "POST", { text: "tool {}", requestId: "ca-1" });
    assert.deepEqual([prompt.status, prompt.body], [404, { error: "thread not found" }], "an archived thread takes no prompt");
    assert.deepEqual((await call(`/api/threads/${gone.id}/history`)).status, 404, "nor gives its history to a turn");
    assert.deepEqual((await call(`/api/threads/${gone.id}/stop`, "POST", {})).status, 404, "nor a stop");
    assert.equal(faux.state.callCount, 0, "no model call for an archived thread");
  } finally {
    app.server.closeAllConnections();
    await app.close();
    fs.rmSync(state, { recursive: true, force: true });
  }
  console.log(`ok: G1 reattach step (offline guards, not the native gate): checkReattach refuses ${refused.length} kinds of evidence `
    + "(a start after the close, a second start, a fresh run after the reopen, a short sleep, no or a double effect, no result of its own); "
    + "runner-vm-cubed-test's step waits for the guest's start request and checks it; an archived thread answers 404 to prompt, history and stop");
}
