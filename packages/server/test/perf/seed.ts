/** Seeds a disposable cube state with synthetic data through cubed's own
 * routes and agents: projects (local git repositories), a long OptChat
 * history with tool calls and thread reports, threads OptChat spawned
 * (most archived), one long thread, artifacts with revisions and comments.
 * The controlled model answers every call (packages/server/test/perf/lib.ts); nothing
 * leaves this machine. Content is deterministic for a seed; ids and times
 * are not.
 *
 *   node packages/server/test/perf/seed.ts <small|medium|large> <root> [seed]
 *
 * Writes <root>/state (CUBED_STATE), <root>/machines (local guests),
 * <root>/repos and <root>/manifest.json (counts, sizes, timings). */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { between, hash, logCommand, markdown, openCubed, paragraph, pick, prng, sentence } from "./lib.ts";

const SCALES = {
  small: { projects: 2, threads: 12, archived: 0.5, chatTurns: 60, artifacts: 6, revisions: 3, longThread: 10, batch: 4 },
  medium: { projects: 6, threads: 150, archived: 0.8, chatTurns: 1000, artifacts: 60, revisions: 6, longThread: 120, batch: 6 },
  large: { projects: 12, threads: 480, archived: 0.875, chatTurns: 3000, artifacts: 200, revisions: 12, longThread: 300, batch: 8 },
} as const;
type Scale = keyof typeof SCALES;

const scaleName = process.argv[2] as Scale;
const root = path.resolve(process.argv[3] ?? "");
const seed = Number(process.argv[4] ?? 20261023);
if (!(scaleName in SCALES) || !process.argv[3]) { console.error("usage: node packages/server/test/perf/seed.ts <small|medium|large> <root> [seed]"); process.exit(2); }
if (fs.existsSync(path.join(root, "state"))) { console.error(`${root}/state exists; seed a fresh root`); process.exit(2); }
const scale = SCALES[scaleName];
const random = prng(seed);
const started = Date.now();
const log = (...args: unknown[]) => console.log(`[${((Date.now() - started) / 1000).toFixed(0)}s]`, ...args);

// Projects: local repositories with a little history each.
const NAMES = ["cube", "berth", "keel", "gateway", "web", "docs", "netstack", "billing", "infra", "mobile", "search", "notes"];
const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "user.name=Perf Seed", "-c", "user.email=perf@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" });
const repos: Array<{ name: string; dir: string }> = [];
for (let p = 0; p < scale.projects; p++) {
  const name = NAMES[p]!;
  const dir = path.join(root, "repos", name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "--initial-branch=main"]);
  for (let c = 0; c < 5; c++) {
    fs.writeFileSync(path.join(dir, `file${c}.md`), `${paragraph(random, 4, 10)}\n`);
    git(dir, ["add", "."]);
    git(dir, ["commit", "-qm", sentence(random, 3, 8)]);
  }
  repos.push({ name, dir });
}

const { app, calls } = await openCubed(root, seed);
await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
const request = async (route: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
  const response = await fetch(`${base}${route}`, { method, ...body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } });
  const text = await response.text();
  assert.ok(response.ok, `${method} ${route}: ${response.status} ${text.slice(0, 500)}`);
  return JSON.parse(text);
};
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string, ms = 600_000): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!check(value)) {
    assert.ok(Date.now() < deadline, `timed out: ${what}`);
    await delay(100);
    value = await read();
  }
  return value;
}
type Event = { type: string; id: string; text?: string; from?: string };
type History = { status: { state: string }; events: Event[] };

try {
  await request("/api/onboarding", {});
  // Two pool runners; local guests stand in for their machines. No runner is contacted.
  for (const name of ["perf-a", "perf-b"]) {
    app.registry.enrollRunner({ nodeId: `node-${name}`, environmentId: 1, threadId: `runner-${name}`, configPath: path.join(root, `${name}.json`), configHash: name, maxActiveVms: 256, protocol: 4, kind: "vm" });
  }
  for (const repo of repos) {
    const created = await request("/api/projects", { name: repo.name, repositories: [{ url: repo.dir, base: "main" }] });
    const checked = await request(`/api/projects/${created.project.id}/check`, {});
    assert.equal(checked.project.status, "ready", JSON.stringify(checked));
  }
  log(`${repos.length} projects`);

  // OptChat is idle: nothing pending, no run working, twice in a row.
  const chatIdle = async (expect?: (events: Event[]) => boolean) => {
    let quiet = 0;
    await until(() => request("/api/optchat/history?tail=40") as Promise<History>, history => {
      const pending = history.events.some(event => event.id.startsWith("pending."));
      const ok = history.status.state !== "working" && !pending && (!expect || expect(history.events));
      quiet = ok ? quiet + 1 : 0;
      return quiet >= 2;
    }, "OptChat settles");
  };
  let userTurns = 0, sentBytes = 0;
  const say = async (text: string) => {
    userTurns++;
    sentBytes += Buffer.byteLength(text);
    await request("/api/optchat/prompt", { text, requestId: `seed-${userTurns}` });
    await chatIdle(events => events.some(event => event.type === "user-message" && event.text === text && !event.id.startsWith("pending.")));
  };
  const userMessage = () => {
    const roll = random();
    if (roll < 0.03) return `here is the log:\n\n\`\`\`\n${Array.from({ length: between(random, 80, 300) }, (_, i) => `${i} ${sentence(random, 4, 10)}`).join("\n")}\n\`\`\``;
    if (roll < 0.35) return sentence(random, 4, 14).toLowerCase();
    if (roll < 0.85) return paragraph(random, 1, 3).toLowerCase();
    return markdown(random, 0.6);
  };

  // The schedule: spawn batches and artifact writes spread over the chat's turns.
  const batches = Math.ceil(scale.threads / scale.batch);
  const plan: Array<"chat" | "spawn" | "artifact" | "revise"> = Array.from({ length: scale.chatTurns }, () => "chat");
  const place = (kind: "spawn" | "artifact" | "revise", count: number, offset: number) => {
    for (let k = 0; k < count; k++) {
      let at = Math.min(scale.chatTurns - 1, Math.floor(((k + offset) / count) * scale.chatTurns));
      while (plan[at] !== "chat" && at < scale.chatTurns - 1) at++;
      plan[at] = kind;
    }
  };
  place("spawn", batches, 0.1);
  place("artifact", Math.ceil(scale.artifacts * 0.7), 0.3);
  place("revise", Math.ceil(scale.artifacts * 0.7 * (scale.revisions - 1) / 2), 0.6);

  const spawned: Array<{ id: string; project: string }> = [];
  const allTasks: string[] = [];
  let longThread: string | null = null;
  let threadsLeft: number = scale.threads;
  const archive = async (ids: string[]) => {
    for (const id of ids) {
      if (random() < 0.1) await say(`archive [${id.slice(0, 8)}] it is done`);
      else await request(`/api/threads/${id}`, undefined, "DELETE");
    }
  };
  for (let turn = 0; turn < plan.length; turn++) {
    const kind = plan[turn]!;
    if (kind === "spawn" && threadsLeft > 0) {
      const count = Math.min(scale.batch, threadsLeft);
      threadsLeft -= count;
      const project = pick(random, repos).name;
      const tasks = Array.from({ length: count }, () => `${pick(random, ["fix", "review", "measure", "document", "refactor", "test"])} ${sentence(random, 5, 16).toLowerCase().slice(0, -1)}`);
      allTasks.push(...tasks);
      const before = new Set(app.registry.listThreads().map(thread => thread.id));
      await say(`please start these in ${project}:\n${tasks.map(task => `- ${task}`).join("\n")}`);
      const fresh = app.registry.listThreads().filter(thread => !before.has(thread.id)).map(thread => thread.id);
      assert.equal(fresh.length, count, `spawned ${fresh.length} of ${count}`);
      // Each thread runs, settles and reports; the chat takes every report.
      for (const id of fresh) await until(() => request(`/api/threads/${id}/history?tail=1`) as Promise<History>, history => ["completed", "failed", "stopped"].includes(history.status.state), `thread ${id} settles`);
      await chatIdle(events => fresh.every(id => events.some(event => event.type === "user-message" && event.from === id.slice(0, 8))));
      spawned.push(...fresh.map(id => ({ id, project })));
      longThread ??= fresh[0]!;
      const toArchive = fresh.filter(id => id !== longThread && random() < scale.archived / (1 - 1 / scale.threads));
      await archive(toArchive);
      log(`turn ${turn}: ${spawned.length} threads, ${app.registry.listThreads().filter(thread => thread.archived).length} archived, ${calls()} model calls`);
    } else if (kind === "artifact") {
      await say(`write an artifact about ${sentence(random, 4, 10).toLowerCase().slice(0, -1)}`);
    } else if (kind === "revise") {
      const mine = ((await request("/api/artifacts")).artifacts as Array<{ id: string; author: { kind: string } }>).filter(item => item.author.kind === "optchat");
      if (mine.length) await say(`revise artifact ${pick(random, mine).id} with ${sentence(random, 4, 10).toLowerCase()}`);
      else await say(userMessage());
    } else {
      await say(userMessage());
    }
    if (turn % 100 === 99) log(`turn ${turn + 1}/${plan.length}, ${calls()} model calls`);
  }

  // One long thread kept open: many follow-ups, each with commands.
  if (longThread) {
    for (let k = 0; k < scale.longThread; k++) {
      await request(`/api/threads/${longThread}/prompt`, { text: `long: ${paragraph(random, 1, 3).toLowerCase()}`, requestId: `long-${k}` });
      await until(() => request(`/api/threads/${longThread}/history?tail=1`) as Promise<History>, history => ["completed", "failed", "stopped"].includes(history.status.state) && !history.events.some(event => event.id.startsWith("pending.")), "long thread turn");
      if (k % 50 === 49) log(`long thread: ${k + 1}/${scale.longThread}`);
    }
  }
  // Comments on about a third of the artifacts; those of OptChat's are sometimes sent.
  const artifacts = (await request("/api/artifacts")).artifacts as Array<{ id: string; author: { kind: string } }>;
  let comments = 0, sent = 0;
  for (const artifact of artifacts) {
    if (random() > 0.4) continue;
    const view = await request(`/api/artifacts/${artifact.id}`);
    const number: number = view.artifact.head;
    const body: string = (await request(`/api/artifacts/${artifact.id}/revisions/${number}`)).revision.body;
    const words = body.split(/\s+/).filter(word => /^[a-z]{4,}$/.test(word));
    const count = words.length ? between(random, 1, 3) : 0;
    for (let c = 0; c < count; c++) {
      const quote = pick(random, words);
      await request(`/api/artifacts/${artifact.id}/comments`, { revision: number, anchor: { quote, prefix: "", suffix: "", start: 0, end: quote.length, section: "" }, body: sentence(random, 4, 14), requestId: `c-${artifact.id}-${c}` });
      comments++;
    }
    if (count && artifact.author.kind === "optchat" && random() < 0.4) {
      await request(`/api/artifacts/${artifact.id}/send`, { requestId: `s-${artifact.id}` });
      sent++;
      await delay(200);
      await chatIdle();
    }
  }
  await chatIdle();

  // What is there now, read the way the UI reads it.
  const threads = (await request("/api/threads?includeArchived=1")).threads as Array<{ archived: boolean }>;
  const chat = await request("/api/optchat/history") as History;
  const longHistory = longThread ? await request(`/api/threads/${longThread}/history`) as History : null;
  const finalArtifacts = (await request("/api/artifacts")).artifacts as Array<{ id: string; author: { kind: string } }>;
  let revisions = 0, threadArtifacts = 0;
  for (const artifact of finalArtifacts) {
    revisions += ((await request(`/api/artifacts/${artifact.id}`)).revisions as unknown[]).length;
    if (artifact.author.kind === "thread") threadArtifacts++;
  }
  const countBy = (events: Event[]) => Object.fromEntries([...new Set(events.map(event => event.type))].map(type => [type, events.filter(event => event.type === type).length]));
  const manifest = {
    scale: scaleName, seed, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.join(import.meta.dirname, "../../../.."), encoding: "utf8" }).trim(),
    parameters: scale, seconds: Math.round((Date.now() - started) / 1000), modelCalls: calls(),
    counts: {
      projects: (await request("/api/projects")).projects.length,
      threads: threads.length, archived: threads.filter(thread => thread.archived).length, active: threads.filter(thread => !thread.archived).length,
      chatUserTurnsSent: userTurns, chatUserBytesSent: sentBytes,
      chatEvents: chat.events.length, chatEventsByType: countBy(chat.events),
      chatReports: chat.events.filter(event => event.type === "user-message" && event.from).length,
      chatTranscriptBytes: Buffer.byteLength(JSON.stringify(chat)),
      longThread, longThreadEvents: longHistory?.events.length ?? 0, longThreadBytes: longHistory ? Buffer.byteLength(JSON.stringify(longHistory)) : 0,
      artifacts: finalArtifacts.length, threadArtifacts, revisions, comments, commentBatchesSent: sent,
    },
  };
  await app.close();
  const sizes: Record<string, number> = {};
  const walk = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, entry.name); if (entry.isDirectory()) walk(file); else sizes[path.relative(root, file)] = fs.statSync(file).size; } };
  walk(path.join(root, "state"));
  const total = (prefix: RegExp) => Object.entries(sizes).filter(([file]) => prefix.test(file)).reduce((sum, [, size]) => sum + size, 0);
  Object.assign(manifest, { bytes: {
    state: total(/^state\//), registry: total(/^state\/registry\.sqlite/), optchat: total(/^state\/optchat\//),
    artifacts: total(/^state\/artifacts\.sqlite/), threads: total(/^state\/threads\//), usage: total(/^state\/usage\.sqlite/),
  } });
  fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  log(JSON.stringify(manifest, null, 2));
  process.exit(0);
} catch (error) {
  console.error(error);
  await app.close().catch(() => {});
  process.exit(1);
}
void logCommand;
void hash;
