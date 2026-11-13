/** Synthetic rows for the preview: thread, runner and project states a host
 * with no runner cannot reach (a machine starting, queued for a slot, failed,
 * suspended; a runner that stopped answering). Nothing runs behind them.
 * Every one says "synthetic" in its title or name, lives in the project
 * `synthetic-states`, and refuses every message and action with a 409 that
 * says why, so no control looks like it worked. */
import type http from "node:http";
import type { ThreadEvent, ThreadStatus } from "../../server/src/thread-events.ts";

const PROJECT = { id: "synthetic-states", name: "synthetic-states" };
const SERVER = "runner-syn-server";
const MAC = "runner-syn-mac";
const REFUSAL = "this is a synthetic thread of the preview: nothing runs behind it, so it takes no messages or actions";
const MIN = 60_000;

type Row = { id: string; title: string; words: string; emoji: string; runner: string; state: "starting" | "ready" | "error"; error?: string; failureKind?: string;
  vm?: Record<string, unknown>; archived?: boolean; status: () => ThreadStatus | null; events: () => ThreadEvent[]; agentOpen?: boolean };

export function synthetic() {
  const born = Date.now();
  const said = (id: string, text: string): ThreadEvent => ({ type: "assistant-text", id, text, reasoning: false, final: true });
  const asked = (id: string, text: string): ThreadEvent => ({ type: "user-message", id, text });
  const done = (run: string): ThreadStatus => ({ state: "completed", run, error: null });
  const okSteps = (at: number) => [
    { name: "model", state: "ok", startedAt: at, endedAt: at + 20, detail: "faux/faux-1" },
    { name: "commits", state: "ok", startedAt: at + 20, endedAt: at + 900, detail: "main 4f1c2aa90b11" },
    { name: "lookup", state: "ok", startedAt: at + 900, endedAt: at + 1000, detail: "template found" },
    { name: "boot", state: "ok", startedAt: at + 1000, endedAt: at + 2600 },
    { name: "resume", state: "ok", startedAt: at + 2600, endedAt: at + 4100, detail: "pre-resume absent, resume ok" },
  ];
  const readyVm = (vmId: string, at: number, more: Record<string, unknown> = {}) =>
    ({ vmId, steps: okSteps(at), preparation: { source: "template" }, startup: { totalMs: 4100 }, ...more });

  /** A run that loops every 44 s: a test command whose output grows, then an edit, then words. */
  const working = (): ThreadEvent[] => {
    const t = Math.floor((Date.now() - born) / 1000) % 44;
    const events: ThreadEvent[] = [asked("w.1", "synthetic: move the importer to streaming and keep the tests green"),
      { type: "assistant-text", id: "w.2", text: "The importer reads whole files. Checking the tests first.", reasoning: true, final: true },
      { type: "tool-call", id: "w.3", callId: "w-c1", name: "bash", input: { command: "pnpm test --filter importer" }, final: true }];
    const lines = Array.from({ length: Math.min(12, Math.floor(t / 1.5) + 1) }, (_, n) => `✓ importer case ${n + 1} (synthetic)`);
    if (t < 18) return [...events, { type: "tool-result", id: "w.4", callId: "w-c1", name: "bash", output: lines.join("\n"), isError: false, final: false }];
    events.push({ type: "tool-result", id: "w.4", callId: "w-c1", name: "bash", output: `${lines.join("\n")}\n12 passed (synthetic)`, isError: false, final: true },
      { type: "tool-call", id: "w.5", callId: "w-c2", name: "edit", input: { file_path: "src/importer/stream.ts", old_string: "readFileSync(path)", new_string: "createReadStream(path)" }, final: true });
    if (t < 24) return events;
    events.push({ type: "tool-result", id: "w.6", callId: "w-c2", name: "edit", output: "edited src/importer/stream.ts (synthetic)", isError: false, final: true },
      { type: "tool-call", id: "w.7", callId: "w-c3", name: "bash", input: { command: "pnpm typecheck" }, final: true });
    if (t < 34) return [...events, { type: "tool-result", id: "w.8", callId: "w-c3", name: "bash", output: `checking ${Math.min(214, (t - 23) * 22)} of 214 files (synthetic)`, isError: false, final: false }];
    const words = "The importer now streams. Tests and types pass. Next I will measure memory on the large fixture.";
    return [...events, { type: "tool-result", id: "w.8", callId: "w-c3", name: "bash", output: "214 files, no errors (synthetic)", isError: false, final: true },
      { type: "assistant-text", id: "w.9", text: words.slice(0, (t - 33) * 12), reasoning: false, final: false }];
  };

  const rows = (): Row[] => {
    const now = Date.now();
    return [
      { id: "syn-working", title: "synthetic: streaming importer", words: "synthetic runner", emoji: "🧪", runner: SERVER, state: "ready", vm: readyVm("syn0000000000001", born - 30 * MIN),
        agentOpen: true, status: () => ({ state: "working", run: "syn-run-1", error: null }), events: working },
      { id: "syn-background", title: "synthetic: waits on its background agent", words: "synthetic waiter", emoji: "🧪", runner: SERVER, state: "ready", vm: readyVm("syn0000000000002", born - 50 * MIN),
        agentOpen: true, status: () => ({ state: "completed", run: "syn-run-2", error: null, waiting: ["integration tests (background agent)"] }),
        events: () => [asked("b.1", "synthetic: run the integration suite in the background and tell me when it ends"), said("b.2", "Started the integration suite as a background agent. I will be told when it ends.")] },
      { id: "syn-reported", title: "synthetic: report ready to read", words: "synthetic reporter", emoji: "🧪", runner: SERVER, state: "ready", vm: readyVm("syn0000000000003", born - 80 * MIN),
        agentOpen: true, status: () => done("syn-run-3"),
        events: () => [asked("r.1", "synthetic: find why the nightly export is slow"),
          { type: "tool-call", id: "r.2", callId: "r-c1", name: "bash", input: { command: "node scripts/profile-export.js" }, final: true },
          { type: "tool-result", id: "r.3", callId: "r-c1", name: "bash", output: "export: 412 s, 96% in serializeRow (synthetic)", isError: false, final: true },
          said("r.4", "**Outcome: found.** The export spends 96% of its time in `serializeRow`, which re-parses the schema per row.\n\n- Evidence: the profile above (synthetic).\n- Fix: parse the schema once per export.\n\nDecision for you: should I open a pull request?")] },
      { id: "syn-starting", title: "synthetic: machine is being prepared", words: "synthetic starter", emoji: "🧪", runner: SERVER, state: "starting",
        vm: { vmId: "syn0000000000004", steps: [
          { name: "model", state: "ok", startedAt: now - 3 * MIN, endedAt: now - 3 * MIN + 20, detail: "faux/faux-1" },
          { name: "commits", state: "ok", startedAt: now - 3 * MIN + 20, endedAt: now - 3 * MIN + 1200, detail: "main 4f1c2aa90b11" },
          { name: "lookup", state: "ok", startedAt: now - 3 * MIN + 1200, endedAt: now - 3 * MIN + 1300, detail: "no template for these setup inputs: building one" },
          { name: "build-boot", state: "ok", startedAt: now - 3 * MIN + 1300, endedAt: now - 3 * MIN + 3400 },
          { name: "build-prepare", attempt: 1, state: "running", startedAt: now - 3 * MIN + 3400, detail: "setup: pnpm install" }] },
        status: () => null, events: () => [asked("s.1", "synthetic: add a health endpoint")] },
      { id: "syn-queued", title: "synthetic: waits for a free slot", words: "synthetic queuer", emoji: "🧪", runner: SERVER, state: "starting",
        vm: { vmId: "syn0000000000005", suspension: { state: "queued", waiting: "runner server-synthetic has no free slot (4 of 4 machines run)", since: born - 4 * MIN } },
        status: () => null, events: () => [asked("q.1", "synthetic: update the changelog")] },
      { id: "syn-failed", title: "synthetic: setup hook failed", words: "synthetic failure", emoji: "🧪", runner: SERVER, state: "error", failureKind: "allocation",
        error: "workspace allocation failed: the setup hook exited with status 1 (synthetic)",
        vm: { vmId: "syn0000000000006", steps: [
          { name: "model", state: "ok", startedAt: born - 20 * MIN, endedAt: born - 20 * MIN + 20 },
          { name: "boot", state: "ok", startedAt: born - 20 * MIN + 20, endedAt: born - 20 * MIN + 1900 },
          { name: "prepare", attempt: 3, state: "failed", startedAt: born - 20 * MIN + 1900, endedAt: born - 19 * MIN, detail: "setup failed (exit 1)",
            log: "+ pnpm install --frozen-lockfile\n ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with \"frozen-lockfile\" because pnpm-lock.yaml is not up to date (synthetic log)" }] },
        status: () => null, events: () => [asked("f.1", "synthetic: bump the dependencies")] },
      { id: "syn-run-failed", title: "synthetic: the model provider refused", words: "synthetic refusal", emoji: "🧪", runner: SERVER, state: "ready", vm: readyVm("syn0000000000007", born - 40 * MIN),
        agentOpen: true, status: () => ({ state: "failed", run: "syn-run-7", error: "the provider answered 529: overloaded (synthetic)" }),
        events: () => [asked("x.1", "synthetic: summarize the open pull requests")] },
      { id: "syn-suspended", title: "synthetic: idle, machine suspended", words: "synthetic sleeper", emoji: "🧪", runner: SERVER, state: "ready",
        vm: readyVm("syn0000000000008", born - 300 * MIN, { suspension: { state: "suspended", at: born - 120 * MIN, memoryBytes: 1_200_000_000 } }),
        agentOpen: false, status: () => done("syn-run-8"), events: () => [asked("z.1", "synthetic: tidy the README"), said("z.2", "The README is tidied and pushed (synthetic).")] },
      { id: "syn-unreachable", title: "synthetic: its runner stopped answering", words: "synthetic orphan", emoji: "🧪", runner: MAC, state: "error", failureKind: "start",
        error: "runner mac-synthetic has not answered for 10 d; the thread waits for it and cannot move (synthetic)",
        vm: readyVm("syn0000000000009", born - 15_000 * MIN), status: () => null, events: () => [asked("u.1", "synthetic: build the macOS package")] },
      { id: "syn-archived", title: "synthetic: archived with its disk kept", words: "synthetic keeper", emoji: "🧪", runner: SERVER, state: "ready", archived: true,
        vm: { vmId: "syn0000000000010", retain: true, retainReason: "2 files are uncommitted (synthetic)", steps: [] }, status: () => null, events: () => [] },
    ];
  };
  const listed = (row: Row) => ({ id: row.id, projectId: PROJECT.id, runnerId: row.runner, title: row.title, name: { emoji: row.emoji, words: row.words }, model: { provider: "faux", id: "faux-1" },
    agent: "pi", archived: !!row.archived, createdAt: born - 60 * MIN, vm: row.vm, state: row.state, error: row.error ?? null, failureKind: row.failureKind ?? null, waiting: null, project: PROJECT });
  const transcript = (row: Row) => ({ agent: "pi", owner: null, status: row.status() ?? { state: "idle", run: null, error: null }, events: row.events(), start: 0 });
  const runner = (id: string, nodeId: string, reachable: boolean, taken: number) => {
    const now = Date.now();
    const report = { at: reachable ? now - 20_000 : now - 14_500 * MIN, ageMs: reachable ? 20_000 : 14_500 * MIN, fresh: reachable, softwareVersion: "0.3.47 (synthetic)", protocolVersion: 4,
      lifecycle: "ready", draining: false, error: null, activeVms: taken, runningVms: taken, maxActiveVms: 4, retainedVms: 1, retainedBytes: 0, platform: reachable ? "linux-x86_64" : "macos-aarch64" };
    return { id, nodeId, enrolledAt: born - 40_000 * MIN, kind: "vm", protocol: 4, byName: false,
      contact: { status: reachable ? "reachable" : "unreachable", lastAttemptAt: now - 20_000, lastContactAt: report.at, unreachableSince: reachable ? null : report.at,
        error: reachable ? null : "connect ETIMEDOUT (synthetic)" },
      report, slots: { total: 4, totalSource: "reported", reserved: taken, free: reachable ? 4 - taken : 0, allocatable: reachable }, retirement: "none",
      unknown: reachable ? [] : ["its machines now: the last report is 10 d old (synthetic)"] };
  };

  return {
    activity<T extends { threads: unknown[] }>(real: T): T {
      return { ...real, threads: [...real.threads, ...rows().filter(row => !row.archived).map(row => ({ id: row.id, agentOpen: row.agentOpen ?? false, status: row.status(), events: row.events().slice(-6), error: null }))] };
    },
    /** Answers what is synthetic and merges synthetic rows into cubed's lists; false: cubed's own. */
    async route(request: http.IncomingMessage, response: http.ServerResponse, url: URL, tools: { json(body: unknown, status?: number): void; port: number }): Promise<boolean> {
      if (request.headers["x-preview-raw"]) return false;
      const { json } = tools;
      const method = request.method ?? "GET";
      const real = async () => (await fetch(`http://127.0.0.1:${tools.port}${url.pathname}${url.search}`, { headers: { "x-preview-raw": "1" } })).json() as Promise<any>;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "api") return false;
      if (parts[1] === "threads" && parts[2]?.startsWith("syn-")) {
        const row = rows().find(candidate => candidate.id === parts[2]);
        if (!row) { json({ error: "thread not found" }, 404); return true; }
        if (method !== "GET") { json({ error: REFUSAL }, 409); return true; }
        if (row.archived) { json({ error: "thread not found" }, 404); return true; }
        switch (parts[3]) {
          case "history": json(transcript(row)); return true;
          case "steps": json({ steps: (row.vm?.steps as unknown[] | undefined) ?? [] }); return true;
          case "services": json({ portal: "off", running: row.state === "ready" && !(row.vm as { suspension?: unknown } | undefined)?.suspension, services: [] }); return true;
          case "usage": json({ usage: { lines: [{ spend: { tokens: { total: 48_200 }, estimatedUsd: 0 } }] } }); return true;
          case "model": json({ models: [{ provider: "faux", id: "faux-1" }], selected: { provider: "faux", id: "faux-1" } }); return true;
          case "stream": {
            response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            const frame = () => {
              const fresh = rows().find(candidate => candidate.id === row.id)!;
              response.write(`data: ${JSON.stringify(transcript(fresh))}\n\n`);
            };
            frame();
            const timer = setInterval(frame, 1000);
            response.on("close", () => clearInterval(timer));
            return true;
          }
          default: json({ error: "not in the preview's synthetic data" }, 404); return true;
        }
      }
      if (method === "POST" && url.pathname === "/api/threads") return false;
      if (method !== "GET") return false;
      if (url.pathname === "/api/health") {
        json({ ...await real(), preview: "preview instance · disposable state · scripted model, no real one · threads named “synthetic” have nothing behind them" });
        return true;
      }
      if (url.pathname === "/api/threads") {
        const body = await real();
        json({ threads: [...body.threads, ...rows().filter(row => url.searchParams.has("includeArchived") || !row.archived).map(listed)] });
        return true;
      }
      if (url.pathname === "/api/projects") {
        const body = await real();
        json({ projects: [...body.projects, { id: PROJECT.id, name: PROJECT.name, status: "ready", error: null, hooks: { preSetup: "", preResume: "" },
          repositories: [{ url: "synthetic://no-repository", base: "main", status: "ready", error: null, resolvedBase: "main", baseOid: null }], threadCount: rows().length }] });
        return true;
      }
      if (url.pathname === "/api/runners/observed") {
        const body = await real();
        json({ ...body, pool: { ...body.pool, slots: body.pool.slots + 4, reserved: body.pool.reserved + 4, runners: body.pool.runners + 2 },
          runners: [...body.runners, runner(SERVER, "server-synthetic", true, 4), runner(MAC, "mac-synthetic", false, 1)] });
        return true;
      }
      return false;
    },
  };
}
