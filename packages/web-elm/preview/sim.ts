/** The public preview: a simulation of cubed's API for the Elm prototype.
 * There is no cubed, model, shell, git, repository or credential behind it.
 * It keeps a small state in memory and plays canned scripts on timers.
 * Whatever a visitor types is stored and shown as text and matched against
 * a few fixed words (`demo work`, `demo slow`, `demo artifact`, `please fail`,
 * `spawn <project>: …`); it is never run, parsed as a tool call or sent
 * anywhere. Every reply and tool step says it is simulated.
 *
 * It imports only node:http, node:fs (to read dist), node:path and
 * node:crypto, and is meant to run under Node's permission model, which
 * denies child processes and file writes whatever this file does:
 *
 * node --permission --allow-fs-read=<packages/web-elm> --allow-net sim.ts --port N [--host H] */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { ThreadEvent, ThreadStatus } from "../../server/src/thread-events.ts";
import { synthetic } from "./synthetic.ts";

const arg = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1]; };
const port = Number(arg("--port") ?? process.env.PORT ?? 7790);
const host = arg("--host") ?? "127.0.0.1";
const DIST = path.resolve(import.meta.dirname, "../dist");
const FILES = new Map(["index.html", "elm.js", "boot.js", "app.css", "archivo-latin.woff2"].map(name => [`/${name}`, fs.readFileSync(path.join(DIST, name))]));
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };

const LIMITS = { text: 2000, body: 32 * 1024, openThreads: 10, archived: 30, events: 300, artifacts: 20, comments: 40, streams: 60 };
const MODEL = { provider: "simulated", id: "no-model" };
const RUNNER = { id: "runner-sim", nodeId: "sim-runner", slots: 4 };
const PROJECTS = [{ id: "sim-demo", name: "demo" }, { id: "sim-atlas", name: "atlas" }];
const born = Date.now();
const fake = synthetic();

class Refused extends Error {
  readonly status: number;
  constructor(message: string, status = 409) { super(message); this.status = status; }
}

type Beat = { kind: "tool"; name: string; input: unknown; ms: number; lines: string[]; effect?: () => string | void } | { kind: "say"; text: string; ms: number };
type Run = { id: string; started: number; beats: Beat[]; fired: number; fail?: string };
/** A conversation: what was said before, and the run playing now. */
type Conv = { prefix: ThreadEvent[]; run: Run | null; status: ThreadStatus; runs: number; onEnd?: (last: string) => void };
type Thread = { id: string; title: string; n: number; projectId: string; createdAt: number; archived: boolean; machine: "queued" | "starting" | "up"; upAt: number; queuedAt: number; first: string; conv: Conv };
type Comment = { id: string; artifact: string; revision: number; anchor: unknown; body: string; createdAt: number; state: "draft" | "queued" | "delivered"; batch: null; note: string | null; deliveredAt: number | null };
type Artifact = { id: string; title: string; body: string; thread: string; projectId: string; createdAt: number; comments: Comment[] };

const threads: Thread[] = [];
const artifacts: Artifact[] = [];
const chat: Conv = { prefix: [], run: null, status: { state: "idle", run: null, error: null }, runs: 0 };
let named = 0;

/** The run's events at this moment: finished beats whole, the current one in part. */
function render(run: Run, now: number, stopped = false): ThreadEvent[] {
  const events: ThreadEvent[] = [];
  let start = 0;
  run.beats.forEach((beat, index) => {
    const elapsed = now - run.started - start;
    start += beat.ms;
    if (elapsed < 0) return;
    const done = elapsed >= beat.ms;
    const part = Math.min(1, elapsed / beat.ms);
    if (beat.kind === "say") {
      events.push({ type: "assistant-text", id: `${run.id}.${index}`, text: done ? beat.text : beat.text.slice(0, Math.ceil(beat.text.length * part)), reasoning: false, final: done || stopped });
      return;
    }
    const callId = `${run.id}-c${index}`;
    events.push({ type: "tool-call", id: `${run.id}.${index}c`, callId, name: beat.name, input: beat.input, final: true });
    const lines = done ? beat.lines : beat.lines.slice(0, Math.ceil(beat.lines.length * part));
    events.push({ type: "tool-result", id: `${run.id}.${index}r`, callId, name: beat.name, isError: false, final: done || stopped,
      output: [...lines, ...stopped && !done ? ["(stopped; simulated)"] : []].join("\n") });
  });
  return events;
}
const total = (run: Run) => run.beats.reduce((sum, beat) => sum + beat.ms, 0);
const eventsOf = (conv: Conv) => [...conv.prefix, ...conv.run ? render(conv.run, Date.now()) : []];
const keep = (conv: Conv, events: ThreadEvent[]) => { conv.prefix = [...conv.prefix, ...events].slice(-LIMITS.events); };

function settle(conv: Conv, now: number): void {
  const run = conv.run;
  if (!run) return;
  let start = 0;
  run.beats.forEach((beat, index) => {
    start += beat.ms;
    if (index >= run.fired && now - run.started >= start) {
      run.fired = index + 1;
      if (beat.kind === "tool" && beat.effect) { const said = beat.effect(); if (said) beat.lines = [said]; }
    }
  });
  if (now - run.started < total(run)) return;
  const events = render(run, now);
  keep(conv, events);
  conv.run = null;
  conv.status = run.fail ? { state: "failed", run: run.id, error: run.fail } : { state: "completed", run: run.id, error: null };
  const last = events.findLast(event => event.type === "assistant-text");
  conv.onEnd?.(run.fail ? `failed: ${run.fail}` : last?.type === "assistant-text" ? last.text : "ended");
}

function begin(conv: Conv, text: string, beats: Beat[], fail?: string): string {
  const id = `sim-run-${++conv.runs}-${randomUUID().slice(0, 6)}`;
  keep(conv, [{ type: "user-message", id: `${id}.u`, text }]);
  conv.run = { id, started: Date.now(), beats, fired: 0, ...fail ? { fail } : {} };
  conv.status = { state: "working", run: id, error: null };
  return id;
}

const say = (text: string): Beat => ({ kind: "say", text, ms: Math.min(4000, 400 + text.length * 12) });
const quote = (text: string) => text.replace(/\s+/g, " ").slice(0, 160);

/** A thread's canned script for a message. The message is only matched, never run. */
function threadScript(thread: Thread, text: string): { beats: Beat[]; fail?: string } {
  if (/please fail/i.test(text)) return { beats: [{ kind: "say", text: "Simulated reply.", ms: 1200 }], fail: "the provider refused (simulated failure)" };
  if (/demo slow/i.test(text)) {
    return { beats: [{ kind: "tool", name: "bash", input: { command: "simulated: a slow command, 60 ticks" }, ms: 60_000, lines: Array.from({ length: 60 }, (_, n) => `tick ${n + 1} (simulated)`) },
      say("Simulated reply. The slow command ended. Nothing ran.")] };
  }
  if (/demo artifact/i.test(text)) {
    return { beats: [{ kind: "tool", name: "artifact_write", input: { title: "Simulated plan" }, ms: 1800, lines: ["writing (simulated)"], effect: () => {
      if (artifacts.length >= LIMITS.artifacts) return "the simulation keeps at most 20 artifacts; none was written";
      const artifact: Artifact = { id: randomUUID(), title: "Simulated plan", thread: thread.id, projectId: thread.projectId, createdAt: Date.now(), comments: [],
        body: "# Simulated plan\n\nThis document is canned. No model wrote it and nothing was read to write it.\n\n## What it shows\n\n- An artifact with a title and a body.\n- Text you can select and comment on.\n\n## A table\n\n| step | state |\n| --- | --- |\n| read the code | simulated |\n| write the change | simulated |\n" };
      artifacts.push(artifact);
      return `artifact ${artifact.id} "Simulated plan" created at revision 1 (simulated)`;
    } }, say("Simulated reply. I wrote the artifact [Simulated plan](#/artifacts). It is canned text.")] };
  }
  if (/demo work/i.test(text)) {
    return { beats: [
      { kind: "tool", name: "bash", input: { command: "simulated: list the workspace" }, ms: 4000, lines: ["README.md (simulated)", "src/ (simulated)"] },
      { kind: "tool", name: "bash", input: { command: "simulated: run 12 checks" }, ms: 9000, lines: Array.from({ length: 12 }, (_, n) => `check ${n + 1} passed (simulated)`) },
      { kind: "tool", name: "edit", input: { file_path: "simulated/file.txt" }, ms: 3000, lines: ["edited (simulated)"] },
      say("Simulated reply. **Done (simulated):** three canned steps played. No command ran, no file changed and no model wrote this.")] };
  }
  return { beats: [say(`Simulated reply. Nothing ran and no model read this. You said: ${quote(text)}`)] };
}

const slotsTaken = () => threads.filter(thread => !thread.archived && thread.machine !== "queued").length;
function createThread(projectId: string, text: string): Thread {
  const project = PROJECTS.find(candidate => candidate.id === projectId);
  if (!project) throw new Refused("the simulation has two projects, demo and atlas; the synthetic states take no threads");
  if (threads.filter(thread => !thread.archived).length >= LIMITS.openThreads) throw new Refused("the simulation keeps at most 10 open threads; archive one first");
  const now = Date.now();
  const thread: Thread = { id: randomUUID(), title: quote(text).slice(0, 80), n: ++named, projectId, createdAt: now, archived: false,
    machine: slotsTaken() < RUNNER.slots ? "starting" : "queued", upAt: now + 2500, queuedAt: now, first: text,
    conv: { prefix: [], run: null, status: { state: "idle", run: null, error: null }, runs: 0 } };
  threads.push(thread);
  return thread;
}

function chatScript(text: string): Beat[] {
  const spawn = text.match(/^spawn (\S+): ([\s\S]+)$/im);
  if (!spawn) return [say(`Simulated reply. Nothing ran and no model read this. You said: ${quote(text)}`)];
  let answer = "";
  return [{ kind: "tool", name: "spawn", input: { tasks: [{ project: spawn[1], task: quote(spawn[2]!) }] }, ms: 1500, lines: ["starting (simulated)"], effect: () => {
    try {
      const project = PROJECTS.find(candidate => candidate.name === spawn[1]);
      if (!project) throw new Refused(`no project named ${quote(spawn[1]!)} in the simulation (demo, atlas)`);
      const thread = createThread(project.id, spawn[2]!.slice(0, LIMITS.text));
      const short = thread.id.slice(0, 8);
      thread.conv.onEnd = last => { keep(chat, [{ type: "user-message", id: `report.${thread.id}.${thread.conv.runs}`, from: short, text: `[${short}] ended its turn (simulated): ${last}` }]); };
      answer = `[${short}] accepted in ${project.name} (simulated)`;
    } catch (error) { answer = `spawn refused: ${(error as Error).message}`; }
    return answer;
  } }, { kind: "say", text: "Simulated reply. The spawn step above shows what happened. The thread's report comes back here when its turn ends.", ms: 1800 }];
}

/** Starts machines, promotes the queue in order, plays runs, delivers queued comments. */
function tick(): void {
  const now = Date.now();
  for (const thread of threads) {
    if (thread.archived) continue;
    if (thread.machine === "queued" && slotsTaken() < RUNNER.slots) { thread.machine = "starting"; thread.upAt = now + 2500; }
    if (thread.machine === "starting" && now >= thread.upAt) {
      thread.machine = "up";
      const script = threadScript(thread, thread.first);
      begin(thread.conv, thread.first, script.beats, script.fail);
    }
    settle(thread.conv, now);
  }
  settle(chat, now);
  for (const artifact of artifacts) {
    const waiting = artifact.comments.filter(comment => comment.state === "queued");
    const author = threads.find(thread => thread.id === artifact.thread);
    if (!waiting.length || !author || author.archived || author.machine !== "up" || author.conv.run) continue;
    for (const comment of waiting) { comment.state = "delivered"; comment.deliveredAt = now; comment.note = null; }
    const text = `[artifact ${artifact.id}] comments (simulated delivery):\n${waiting.map(comment => `- ${quote(comment.body)}`).join("\n")}`;
    begin(author.conv, text, [say("Simulated reply. The comments arrived. Nothing was changed.")]);
  }
}
setInterval(tick, 400);

const row = (thread: Thread) => {
  const project = PROJECTS.find(candidate => candidate.id === thread.projectId)!;
  const at = thread.upAt - 2500;
  const steps = thread.machine === "queued" ? [] : [
    { name: "model", state: "ok", startedAt: at, endedAt: at + 10, detail: "simulated/no-model" },
    { name: "boot", state: thread.machine === "up" ? "ok" : "running", startedAt: at + 10, ...thread.machine === "up" ? { endedAt: thread.upAt } : {}, detail: "simulated: no machine exists" }];
  return { id: thread.id, projectId: thread.projectId, runnerId: RUNNER.id, title: thread.title, name: { emoji: "🎭", words: `simulated ${thread.n}` }, model: MODEL, agent: "pi",
    archived: thread.archived, createdAt: thread.createdAt, state: thread.machine === "up" || thread.archived ? "ready" : "starting", error: null, failureKind: null, waiting: null, project,
    vm: { vmId: `sim${thread.id.slice(0, 13)}`, steps, ...thread.machine === "queued" && !thread.archived
      ? { suspension: { state: "queued", waiting: `runner ${RUNNER.nodeId} has no free slot (${RUNNER.slots} of ${RUNNER.slots} taken); this thread starts when one frees (simulated)`, since: thread.queuedAt } } : {},
      ...thread.machine === "up" ? { startup: { source: "simulated", totalMs: 2500 } } : {} } };
};
const transcriptOf = (conv: Conv) => ({ agent: "pi", owner: null, status: conv.status, events: eventsOf(conv), start: 0 });
const artifactItem = (artifact: Artifact) => {
  const count = (state: string) => artifact.comments.filter(comment => comment.state === state).length;
  const thread = threads.find(candidate => candidate.id === artifact.thread);
  return { id: artifact.id, title: artifact.title, author: { kind: "thread", thread: artifact.thread }, projectId: artifact.projectId, head: 1, createdAt: artifact.createdAt, updatedAt: artifact.createdAt,
    comments: { draft: count("draft"), queued: count("queued"), delivered: count("delivered"), undeliverable: 0 },
    project: PROJECTS.find(candidate => candidate.id === artifact.projectId) ?? null, thread: thread ? { id: thread.id, title: thread.title, archived: thread.archived } : null };
};

let streams = 0;
function stream(response: http.ServerResponse, read: () => unknown): void {
  if (streams >= LIMITS.streams) { response.writeHead(503, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "the simulation serves at most 60 live streams" })); return; }
  streams++;
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  let last = "";
  const frame = () => { const next = JSON.stringify(read()); if (next !== last) { last = next; response.write(`data: ${next}\n\n`); } };
  frame();
  const timer = setInterval(frame, 500);
  response.on("close", () => { clearInterval(timer); streams--; });
}

async function body(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) { size += (chunk as Buffer).length; if (size > LIMITS.body) throw new Refused("the simulation takes at most 32 KiB", 413); chunks.push(chunk as Buffer); }
  if (!size) return {};
  try { const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; }
  catch { throw new Refused("json body required", 400); }
}
const textOf = (input: Record<string, unknown>, key: string): string => {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Refused(`${key} is required`, 400);
  if (value.length > LIMITS.text) throw new Refused(`the simulation takes at most ${LIMITS.text} characters`, 413);
  return value;
};

const NOT_HERE = "not in the simulation: this preview has no cubed behind it, so this does nothing";
const server = http.createServer((request, response) => {
  void (async () => {
    const json = (value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); };
    try {
      const url = new URL(request.url ?? "/", "http://sim");
      const method = request.method ?? "GET";
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (parts[0] !== "api") {
        const file = FILES.get(url.pathname === "/" ? "/index.html" : url.pathname);
        if (method !== "GET" || !file) return json({ error: "not found" }, 404);
        response.writeHead(200, { "content-type": TYPES[path.extname(url.pathname === "/" ? "/index.html" : url.pathname)]!, "x-content-type-options": "nosniff" });
        return response.end(file);
      }
      // The labeled synthetic rows answer for themselves and refuse every action.
      if (parts[1] === "threads" && parts[2]?.startsWith("syn-")) { await fake.route(request, response, url, { json, port }); return; }
      const input = method === "GET" ? {} : await body(request);
      const route = `${method} /${parts.slice(1).join("/")}`;
      switch (route) {
        case "GET /health": return json({ lifecycle: "ready", version: "simulation", commit: "none", gateway: "none", portal: "off",
          preview: "Simulation. Nothing here runs: no shell, no model, no repository, no credentials. Threads, tool steps and replies are canned, and what you type is only shown back." });
        case "GET /models": case "GET /optchat/model": case "PATCH /optchat/model": return json({ models: [MODEL], selected: MODEL });
        case "GET /threads": return json({ threads: [...threads.filter(thread => url.searchParams.has("includeArchived") || !thread.archived).map(row),
          ...fake.rows().filter(item => url.searchParams.has("includeArchived") || !item.archived).map(fake.listed)] });
        case "POST /threads": return json({ id: createThread(textOf(input, "projectId"), textOf(input, "text")).id });
        case "GET /activity": return json(fake.activity({ at: Date.now(), threads: threads.filter(thread => !thread.archived).map(thread => ({ id: thread.id, agentOpen: thread.machine === "up",
          status: thread.machine === "up" ? thread.conv.status : null, events: thread.machine === "up" ? eventsOf(thread.conv).slice(-6) : [], error: null })) }));
        case "GET /projects": return json({ projects: [...PROJECTS.map(project => ({ ...project, status: "ready", error: null, hooks: { preSetup: "", preResume: "" },
          repositories: [{ url: `simulated://${project.name}`, base: "main", status: "ready", error: null, resolvedBase: "main", baseOid: null }],
          threadCount: threads.filter(thread => thread.projectId === project.id).length })),
          { ...fake.project, status: "ready", error: null, hooks: { preSetup: "", preResume: "" }, repositories: [{ url: "synthetic://no-repository", base: "main", status: "ready", error: null, resolvedBase: "main", baseOid: null }], threadCount: fake.rows().length }] });
        case "GET /runners/observed": {
          const taken = slotsTaken();
          const now = Date.now();
          return json({ observedAt: now, probeIntervalMs: 60000, pool: { runners: 3, allocatable: 1, slots: RUNNER.slots + 6, reserved: taken + 6, free: RUNNER.slots - taken },
            runners: [{ id: RUNNER.id, nodeId: RUNNER.nodeId, enrolledAt: born, kind: "vm", protocol: 4, byName: false,
              contact: { status: "reachable", lastAttemptAt: now, lastContactAt: now, unreachableSince: null, error: null },
              report: { at: now, ageMs: 0, fresh: true, softwareVersion: "simulated", lifecycle: "ready", draining: false, activeVms: taken, runningVms: taken, retainedVms: 0, platform: "none (simulated)" },
              slots: { total: RUNNER.slots, reserved: taken, free: RUNNER.slots - taken, allocatable: true }, retirement: "none", unknown: [] }, ...fake.runners()],
            notReported: ["everything: these runners are simulated"] });
        }
        case "GET /optchat/history": return json(transcriptOf(chat));
        case "GET /optchat/stream": return stream(response, () => transcriptOf(chat));
        case "GET /optchat/threads": return json({ threads: [], archived: { shown: 0, total: 0 }, unknown: 0 });
        case "GET /optchat/view": return json({ view: "<chat>\n(simulated: optchat keeps no memory here)\n</chat>", messages: chat.prefix.length, failure: null });
        case "POST /optchat/prompt": {
          const text = textOf(input, "text");
          if (chat.run) throw new Refused("optchat is working (simulated); stop it or wait for the turn to end");
          return json({ runId: begin(chat, text, chatScript(text)) });
        }
        case "POST /optchat/stop": stop(chat); return json({ ok: true });
        case "GET /artifacts": return json({ artifacts: artifacts.map(artifactItem) });
        case "GET /providers": return json({ providers: [{ id: "simulated", name: "no provider (simulated)", connected: false, type: "none", checkError: false, methods: [], flow: null }] });
        case "GET /github/auth": return json({ github: { state: "not connected (simulated)", login: null } });
        case "GET /system/update": case "POST /system/update": return json({ installation: "simulation", enabled: false, current: { version: "simulation" }, available: null, phase: "idle", error: null, message: "a simulation has nothing to update" });
        case "GET /usage": return json({ totals: { spend: { tokens: { total: 0 }, estimatedUsd: 0 }, coverage: "simulated" }, billed: { note: "nothing is spent: no model is called" }, projects: [] });
        case "GET /settings": return json({ chat: MODEL, compactor: { source: "chat", model: MODEL }, error: null });
        case "GET /settings/skills": return json({ resolved: { skills: [] } });
      }
      if (parts[1] === "threads" && parts[2]) {
        const thread = threads.find(candidate => candidate.id === parts[2]);
        if (!thread) return json({ error: "thread not found" }, 404);
        const action = `${method} ${parts.slice(3).join("/")}`;
        if (thread.archived) return action === "GET usage" ? json({ usage: { lines: [] } }) : json({ error: action === "POST discard" ? "nothing to discard: a simulated thread has no disk" : "thread not found" }, action === "POST discard" ? 409 : 404);
        const notUp = thread.machine === "queued" ? row(thread).vm.suspension!.waiting : thread.machine === "starting" ? "the thread's machine is starting (simulated)" : null;
        switch (action) {
          case "GET history": return notUp ? json({ error: notUp }, 409) : json(transcriptOf(thread.conv));
          case "GET stream": return notUp ? json({ error: notUp }, 409) : stream(response, () => transcriptOf(thread.conv));
          case "GET steps": return json({ steps: row(thread).vm.steps });
          case "GET services": return json({ portal: "off", running: thread.machine === "up", services: [] });
          case "GET usage": return json({ usage: { lines: [] } });
          case "GET model": case "PATCH model": return json({ models: [MODEL], selected: MODEL });
          case "GET diagnostics": return json({ diagnostics: "simulated: there is no machine" });
          case "POST prompt": {
            const text = textOf(input, "text");
            if (notUp) throw new Refused(notUp);
            if (thread.conv.run) throw new Refused("thread is already working or message is invalid");
            const script = threadScript(thread, text);
            return json({ runId: begin(thread.conv, text, script.beats, script.fail) });
          }
          case "POST stop": stop(thread.conv); return json({ ok: true });
          case "PATCH ": thread.title = textOf(input, "title").slice(0, 200); return json({ ok: true });
          case "DELETE ":
            if (thread.conv.run) throw new Refused("stop the current run before archiving");
            thread.archived = true;
            for (const old of threads.filter(candidate => candidate.archived).slice(0, -LIMITS.archived)) threads.splice(threads.indexOf(old), 1);
            return json({ ok: true, retained: false, reason: "simulated: there was no disk" });
        }
        return json({ error: NOT_HERE }, 404);
      }
      if (parts[1] === "artifacts" && parts[2]) {
        const artifact = artifacts.find(candidate => candidate.id === parts[2]);
        if (!artifact) return json({ error: "no such artifact" }, 404);
        const action = `${method} ${parts.slice(3).join("/")}`;
        if (action === "GET ") return json({ artifact: artifactItem(artifact), revisions: [{ number: 1, title: artifact.title, createdAt: artifact.createdAt, actions: 0 }], comments: artifact.comments, actionRuns: [], notices: [] });
        if (action === "GET revisions/1") return json({ revision: { artifact: artifact.id, number: 1, title: artifact.title, body: artifact.body, actions: [] } });
        if (action === "POST comments") {
          if (artifact.comments.length >= LIMITS.comments) throw new Refused("the simulation keeps at most 40 comments on an artifact");
          const anchor = input.anchor as Record<string, unknown> | undefined;
          const piece = (key: string) => typeof anchor?.[key] === "string" ? (anchor[key] as string).slice(0, 300) : "";
          const at = (key: string) => typeof anchor?.[key] === "number" ? anchor[key] as number : 0;
          const comment: Comment = { id: randomUUID(), artifact: artifact.id, revision: 1, body: textOf(input, "body"), createdAt: Date.now(), state: "draft", batch: null, note: null, deliveredAt: null,
            anchor: { quote: piece("quote"), prefix: piece("prefix"), suffix: piece("suffix"), start: at("start"), end: at("end"), section: piece("section") } };
          artifact.comments.push(comment);
          return json({ comment });
        }
        if (method === "DELETE" && parts[3] === "comments" && parts[4]) {
          const index = artifact.comments.findIndex(comment => comment.id === parts[4] && comment.state === "draft");
          if (index < 0) throw new Refused("only an unsent comment can be deleted");
          artifact.comments.splice(index, 1);
          return json({ ok: true });
        }
        if (action === "POST send") {
          for (const comment of artifact.comments) if (comment.state === "draft") { comment.state = "queued"; comment.note = "waits until its author is between runs (simulated)"; }
          return json({ batch: null });
        }
        return json({ error: NOT_HERE }, 404);
      }
      // Everything else cubed has (projects to save or check, runner probes,
      // provider and GitHub logins, settings, workspaces) does nothing here.
      return json({ error: NOT_HERE }, method === "GET" ? 404 : 409);
    } catch (error) {
      if (response.headersSent) return response.destroy();
      json({ error: error instanceof Refused ? error.message : "the simulation could not answer that" }, error instanceof Refused ? error.status : 500);
    }
  })();
});

function stop(conv: Conv): void {
  if (!conv.run) return;
  keep(conv, render(conv.run, Date.now(), true));
  conv.status = { state: "stopped", run: conv.run.id, error: null };
  conv.run = null;
}

server.listen(port, host, () => {
  createThread("sim-demo", "demo artifact");
  createThread("sim-atlas", "demo work");
  console.log(`ready http://${host}:${port} (simulation: no cubed, no shell, no model)`);
});
