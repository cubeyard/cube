/**
 * Live end-to-end smoke against a RUNNING cubed, through the product API
 * only — the same calls the web UI makes. Exercises one whole thread life:
 *
 *   state -> ready project -> create thread -> provision to ready ->
 *   rename -> repositories/files/services -> terminal WebSocket spawns and
 *   streams -> sleep -> wake -> delete
 *
 * Zero dependencies (node 26: fetch + WebSocket are global). Creates ONE
 * thread of its own and deletes it; never touches other threads. Prints a
 * timing table (and `--json` one line) so runs can be compared across
 * releases — the same numbers cubed records in its events table.
 *
 *   node scripts/smoke-live.ts                       # http://127.0.0.1:7777
 *   node scripts/smoke-live.ts --url http://host:7777 --project cube
 *   node scripts/smoke-live.ts --keep                # leave the thread for inspection
 *   node scripts/smoke-live.ts --skip-sleep          # skip the sleep/wake leg
 *   node scripts/smoke-live.ts --ready-timeout 900   # seconds to wait for provisioning
 *
 * Exit 0 only when every step passed. On failure the created thread is
 * deleted unless --keep, and the failing step + the server's message are
 * printed last.
 */

interface Args {
  url: string;
  project: string | null;
  keep: boolean;
  skipSleep: boolean;
  readyTimeout: number;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    url: process.env.CUBED_URL ?? "http://127.0.0.1:7777",
    project: null,
    keep: false,
    skipSleep: false,
    readyTimeout: 900,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--url") args.url = next().replace(/\/$/, "");
    else if (a === "--project") args.project = next();
    else if (a === "--keep") args.keep = true;
    else if (a === "--skip-sleep") args.skipSleep = true;
    else if (a === "--ready-timeout") args.readyTimeout = Number(next());
    else if (a === "--json") args.json = true;
    else if (a === "-h" || a === "--help") {
      console.log("usage: node scripts/smoke-live.ts [--url U] [--project NAME|ID] [--keep] [--skip-sleep] [--ready-timeout S] [--json]");
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

interface ThreadSummary {
  id: string;
  title: string | null;
  state: "setting-up" | "ready" | "sleeping" | "error";
  error: string | null;
  project: { id: string; name: string };
}
interface Project { id: string; name: string; status: string; error: string | null }
interface CubeSummary { name: string; status: string; error: string | null }

async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(`${args.url}${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (res.ok) return (await res.json()) as T;
  let message = `${method} ${path} -> ${res.status}`;
  try {
    message = String(((await res.json()) as { error?: unknown }).error ?? message);
  } catch {
    // keep the status line
  }
  throw new Error(message);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t = () => performance.now();
const ms = (from: number) => Math.round(t() - from);

const timings: Record<string, number> = {};
const notes: string[] = [];
let step = "start";
let threadId: string | null = null;

function begin(name: string): number {
  step = name;
  process.stderr.write(`… ${name}\n`);
  return t();
}
function done(name: string, from: number, extra = ""): void {
  timings[name] = ms(from);
  process.stderr.write(`✓ ${name} ${timings[name]} ms${extra ? ` — ${extra}` : ""}\n`);
}

async function pollThread(id: string, want: (s: ThreadSummary) => boolean, timeoutMs: number, what: string): Promise<ThreadSummary> {
  const from = t();
  for (;;) {
    const threads = await api<{ threads: ThreadSummary[] }>("/api/threads?includeArchived=1");
    const me = threads.threads.find((x) => x.id === id);
    if (!me) throw new Error(`thread ${id} vanished from the list while waiting for ${what}`);
    if (me.state === "error") throw new Error(`thread entered error while waiting for ${what}: ${me.error ?? "no message"}`);
    if (want(me)) return me;
    if (ms(from) > timeoutMs) throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${what} (state=${me.state}${me.error ? `, error=${me.error}` : ""})`);
    await sleep(2000);
  }
}

async function pollCube(name: string, want: string[], timeoutMs: number): Promise<CubeSummary> {
  const from = t();
  for (;;) {
    const cube = await api<CubeSummary>(`/api/cubes/${encodeURIComponent(name)}`);
    if (want.includes(cube.status)) return cube;
    if (cube.status === "error") throw new Error(`backing environment errored: ${cube.error ?? "no message"}`);
    if (ms(from) > timeoutMs) throw new Error(`timed out waiting for status ${want.join("|")} (now ${cube.status})`);
    await sleep(1000);
  }
}

/** The cube behind a thread — via the plumbing route, only to drive sleep/wake explicitly. */
async function cubeForThread(id: string): Promise<string> {
  const { cubes } = await api<{ cubes: CubeSummary[] }>("/api/cubes");
  for (const cube of cubes) {
    const detail = await api<CubeSummary & { threads: Array<{ id: string }> }>(`/api/cubes/${encodeURIComponent(cube.name)}`);
    if (detail.threads.some((th) => th.id === id)) return cube.name;
  }
  throw new Error(`no backing environment lists thread ${id}`);
}

/** Open the terminal WebSocket, wait for the spawn frame and the first
 * output bytes, then close. Returns ms to first byte. */
function terminalSmoke(id: string, timeoutMs: number): Promise<{ spawnedMs: number; firstByteMs: number; bytes: number }> {
  return new Promise((resolve, reject) => {
    const wsUrl = `${args.url.replace(/^http/, "ws")}/api/threads/${encodeURIComponent(id)}/pty?cols=100&rows=30`;
    const from = t();
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    let spawnedMs = -1;
    let firstByteMs = -1;
    let bytes = 0;
    const statuses: string[] = [];
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`terminal: no output within ${timeoutMs / 1000}s (spawned=${spawnedMs >= 0}, statuses=${JSON.stringify(statuses)})`));
    }, timeoutMs);
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`terminal: websocket error on ${wsUrl}`));
    };
    ws.onclose = (ev) => {
      if (firstByteMs < 0) {
        clearTimeout(timer);
        reject(new Error(`terminal: socket closed before output (code ${ev.code}, statuses=${JSON.stringify(statuses)})`));
      }
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        const frame = JSON.parse(ev.data) as { t: string; text?: string; code?: number | null };
        if (frame.t === "status" && frame.text) statuses.push(frame.text);
        if (frame.t === "spawned") spawnedMs = ms(from);
        if (frame.t === "error") {
          clearTimeout(timer);
          ws.close();
          reject(new Error(`terminal: ${frame.text ?? "error frame"}`));
        }
        if (frame.t === "exit") {
          clearTimeout(timer);
          ws.close();
          reject(new Error(`terminal: pi exited (code ${frame.code}) before producing output`));
        }
        return;
      }
      bytes += (ev.data as ArrayBuffer).byteLength;
      if (firstByteMs < 0) firstByteMs = ms(from);
      // Enough evidence: the TUI is drawing. Give it a moment for more bytes.
      if (bytes > 64) {
        clearTimeout(timer);
        setTimeout(() => {
          ws.close();
          resolve({ spawnedMs, firstByteMs, bytes });
        }, 500);
      }
    };
  });
}

async function main(): Promise<void> {
  let from = begin("state");
  const state = await api<{ auth: { state: string; provider?: string }; onboardingComplete: boolean }>("/api/state");
  done("state", from, `auth=${state.auth.state}${state.auth.provider ? `:${state.auth.provider}` : ""} onboarding=${state.onboardingComplete}`);
  if (state.auth.state !== "ok") notes.push("model provider is signed out on the host — the TUI will show a login prompt, which is fine for this smoke");

  from = begin("project");
  const { projects } = await api<{ projects: Project[] }>("/api/projects");
  const project = args.project
    ? projects.find((p) => p.id === args.project || p.name === args.project)
    : projects.find((p) => p.status === "ready");
  if (!project) throw new Error(args.project ? `no project named ${args.project}` : "no ready project — create and check one first");
  if (project.status !== "ready") throw new Error(`project ${project.name} is ${project.status}${project.error ? `: ${project.error}` : ""}`);
  done("project", from, project.name);

  from = begin("create");
  threadId = (await api<{ id: string }>("/api/threads", "POST", { projectId: project.id })).id;
  done("create", from, threadId);

  from = begin("provision");
  const ready = await pollThread(threadId, (s) => s.state === "ready", args.readyTimeout * 1000, "ready");
  done("provision", from, ready.error ? `ready with setup complaint: ${ready.error}` : "ready");
  if (ready.error) notes.push(`setup complaint: ${ready.error}`);

  from = begin("rename");
  const title = `smoke ${new Date().toISOString().slice(0, 16)}`;
  await api(`/api/threads/${threadId}`, "PATCH", { title });
  const renamed = await pollThread(threadId, (s) => s.title === title, 10_000, "rename to land");
  done("rename", from, renamed.title ?? "");

  from = begin("inspect");
  const repos = await api<{ repositories: Array<{ role: string; branch: string; state: unknown }> }>(`/api/threads/${threadId}/repositories`);
  if (!repos.repositories.some((r) => r.role === "primary")) throw new Error("no primary repository on the thread");
  const files = await api<{ files: unknown[]; totalBytes: number }>(`/api/threads/${threadId}/files`);
  const services = await api<{ services: Array<{ name: string; url: string }> }>(`/api/threads/${threadId}/services`);
  done("inspect", from, `${repos.repositories.length} repo(s) on ${repos.repositories[0]!.branch}, ${files.files.length} files, ${services.services.length} service(s)`);

  from = begin("terminal");
  const term = await terminalSmoke(threadId, 90_000);
  timings["terminal.spawned"] = term.spawnedMs;
  timings["terminal.firstByte"] = term.firstByteMs;
  done("terminal", from, `spawned ${term.spawnedMs} ms, first byte ${term.firstByteMs} ms, ${term.bytes} bytes`);

  if (!args.skipSleep) {
    const cube = await cubeForThread(threadId);
    from = begin("sleep");
    await api(`/api/cubes/${encodeURIComponent(cube)}/sleep`, "POST");
    await pollCube(cube, ["asleep"], 60_000);
    await pollThread(threadId, (s) => s.state === "sleeping", 10_000, "sleeping");
    done("sleep", from);

    from = begin("wake");
    await api(`/api/cubes/${encodeURIComponent(cube)}/wake`, "POST");
    await pollCube(cube, ["ready"], 180_000);
    done("wake", from);
  }

  if (!args.keep) {
    from = begin("delete");
    await api(`/api/threads/${threadId}`, "DELETE");
    const gone = await api<{ threads: ThreadSummary[] }>("/api/threads?includeArchived=1");
    if (gone.threads.some((x) => x.id === threadId)) throw new Error("thread still listed after DELETE");
    done("delete", from);
    threadId = null;
  } else {
    notes.push(`kept thread ${threadId} (${title}) — delete it from the UI when done`);
  }
}

main()
  .then(() => report(true))
  .catch(async (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (threadId && !args.keep) {
      // A thread mid-provision or mid-transition refuses DELETE (409 busy);
      // keep trying for a bounded while so a failed run leaves nothing behind.
      const deadline = Date.now() + 10 * 60_000;
      for (;;) {
        try {
          await api(`/api/threads/${threadId}`, "DELETE");
          notes.push(`cleaned up thread ${threadId}`);
          break;
        } catch (cleanup) {
          const text = cleanup instanceof Error ? cleanup.message : String(cleanup);
          if (/busy|setting up|not ready/.test(text) && Date.now() < deadline) {
            await sleep(5000);
            continue;
          }
          notes.push(`could not delete thread ${threadId}: ${text} — delete it from the UI`);
          break;
        }
      }
    }
    report(false, message);
  });

function report(ok: boolean, failure?: string): void {
  const width = Math.max(...Object.keys(timings).map((k) => k.length), 10);
  console.log(`\nsmoke-live against ${args.url}`);
  for (const [name, value] of Object.entries(timings)) {
    console.log(`  ${name.padEnd(width)}  ${String(value).padStart(7)} ms`);
  }
  for (const note of notes) console.log(`  note: ${note}`);
  if (args.json) {
    console.log(JSON.stringify({ ok, url: args.url, at: new Date().toISOString(), timings, notes, failedStep: ok ? null : step, error: failure ?? null }));
  }
  if (ok) {
    console.log("ALL PASS: smoke-live");
    process.exit(0);
  }
  console.log(`FAIL at ${step}: ${failure}`);
  process.exit(1);
}
