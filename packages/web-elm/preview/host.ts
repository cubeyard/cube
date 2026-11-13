/** The Elm prototype's preview host: a real cubed (server, OptChat, Pi's
 * durable agent, the guest helper as plain processes) on disposable state
 * under `--scratch`, serving packages/web-elm/dist, with a scripted model
 * and no VM. Like the verify host (packages/server/test/verify-host.ts) it
 * has no sandbox and no login of its own: whoever reaches the port can run
 * commands as this account.
 *
 * Two things are not cubed's:
 * - `GET /api/activity`, the read the redesign needs and cubed lacks: every
 *   open thread's run state and newest events in one answer, read without
 *   opening an agent or waking a machine.
 * - synthetic.ts: rows for states a host without runners cannot reach.
 *
 * node packages/web-elm/preview/host.ts --scratch DIR --port N [--host H] [--allowed-host NAME] */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import { parseArgs } from "node:util";
import { createCubed } from "../../server/src/index.ts";
import { LocalMachines } from "../../server/test/local-guest.ts";
import type { ThreadEvent, ThreadTranscript } from "../../server/src/thread-events.ts";
import { synthetic } from "./synthetic.ts";

// This directory is no pnpm package: Pi's model library is the server's own copy.
const { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } = await import(
  path.resolve(import.meta.dirname, "../../server/node_modules/@earendil-works/pi-ai/dist/index.js")) as typeof import("../../server/node_modules/@earendil-works/pi-ai/dist/index.js");

const { values } = parseArgs({ options: { scratch: { type: "string" }, port: { type: "string" }, host: { type: "string" }, "allowed-host": { type: "string", multiple: true } } });
if (!values.scratch || !values.port) throw new Error("usage: host.ts --scratch DIR --port N [--host H] [--allowed-host NAME]");
const scratch = path.resolve(values.scratch);
const WEB = path.resolve(import.meta.dirname, "../dist");
if (!fs.existsSync(path.join(WEB, "index.html"))) throw new Error("no built UI: bash packages/web-elm/build.sh");
if (fs.existsSync(scratch)) throw new Error(`${scratch} exists: the preview host uses only a scratch directory it creates`);
fs.mkdirSync(scratch, { recursive: true });

const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "user.name=Cube Preview", "-c", "user.email=preview@example.invalid",
  "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" });
function seedRepository(name: string, readme: string): string {
  const seed = path.join(scratch, `seed-${name}`);
  fs.mkdirSync(seed);
  git(seed, ["init", "-q", "--initial-branch=main"]);
  fs.writeFileSync(path.join(seed, "README.md"), readme);
  git(seed, ["add", "-A"]);
  git(seed, ["commit", "-qm", `${name}: seed commit`]);
  const bare = path.join(scratch, `${name}.git`);
  git(scratch, ["clone", "-q", "--bare", seed, bare]);
  return bare;
}

const text = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? (content as { type?: string; text?: string }[]).filter(part => part.type === undefined || part.type === "text").map(part => part.text ?? "").join("") : "";

/** The newest text part: OptChat's messages carry context parts before the user's words. */
const lastText = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? (content as { type?: string; text?: string }[]).flatMap(part => part.type === "text" ? [part.text ?? ""] : []).at(-1) ?? "" : "";

const ARTIFACT = `# Preview plan (synthetic)

This document was written by the scripted model of the preview host. No real model wrote it.

## What it shows

- An artifact with a title, a body and revisions.
- Text you can select and comment on.

## A table

| step | state |
| --- | --- |
| read the code | done |
| write the change | scripted |

\`\`\`text
plan
├── read
└── write
\`\`\`
`;

/** The scripted steps of "demo work": each is one tool call. */
const WORK: Array<[string, Record<string, unknown>]> = [
  ["bash", { command: "sleep 4; ls -la" }],
  ["bash", { command: "cat README.md; git log --oneline | head -3" }],
  ["bash", { command: "sleep 6; printf 'running 12 scripted checks\\n'; sleep 5; echo '12 passed, 0 failed'" }],
  ["bash", { command: "date > preview-note.txt; sleep 3; cat preview-note.txt" }],
];

const faux = fauxProvider({ tokensPerSecond: 60, tokenSize: { min: 3, max: 6 } });
let calls = 0;
const call = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1], { id: `call-${Date.now()}-${calls++}` })], { stopReason: "toolUse" });
faux.setResponses(Array.from({ length: 5000 }, () => async request => {
  if (JSON.stringify(request.messages.find(message => message.role === "system") ?? "").includes("You write the memory of OptChat")) return fauxAssistantMessage("a summary (scripted)");
  const lastUser = request.messages.findLastIndex(message => message.role === "user");
  const asked = lastUser < 0 ? "" : lastText(request.messages[lastUser]!.content).trim();
  const results = request.messages.slice(lastUser + 1).filter(message => message.role === "toolResult");
  const last = request.messages.at(-1)!;
  if (/please fail/.test(asked)) throw new Error("the provider refused (scripted failure)");
  const tool = asked.match(/^tool (\{.*\})$/m);
  if (tool) {
    if (last.role === "toolResult") return fauxAssistantMessage(`scripted reply. the tool answered:\n\n${text(last.content).trim()}`);
    const { name, args } = JSON.parse(tool[1]!) as { name: string; args: Record<string, unknown> };
    return call(name, args);
  }
  const spawn = asked.match(/^spawn (\S+): ([\s\S]+)$/m);
  if (spawn) {
    if (last.role === "toolResult") return fauxAssistantMessage(`scripted reply. spawn answered:\n\n${text(last.content).trim()}`);
    return call("spawn", { tasks: [{ project: spawn[1], task: spawn[2] }] });
  }
  if (/demo work/.test(asked)) {
    const step = WORK[results.length];
    if (step) return call(step[0], step[1]);
    return fauxAssistantMessage("scripted reply. **Done (scripted):** four shell commands ran in this thread's workspace, for real. The plan and these words are canned; no model chose them.");
  }
  if (/demo slow/.test(asked)) {
    if (!results.length) return call("bash", { command: "for i in $(seq 1 60); do echo tick $i; sleep 1; done" });
    return fauxAssistantMessage("scripted reply. the slow command ended.");
  }
  if (/demo artifact/.test(asked)) {
    if (!results.length) return call("artifact_write", { title: "Preview plan (synthetic)", body: ARTIFACT });
    return fauxAssistantMessage(`scripted reply. artifact written:\n\n${text(last.content).trim()}`);
  }
  return fauxAssistantMessage(`scripted reply (no real model is connected). you said: ${asked.slice(0, 300)}`);
}));

const models = createModels();
models.setProvider(faux.provider);
const machines = new LocalMachines(path.join(scratch, "machines"));
const app = await createCubed({ state: path.join(scratch, "state"), models, machines, claude: null, gateway: null, portal: null, skillSource: null, web: WEB,
  ...values["allowed-host"] ? { allowedHosts: values["allowed-host"] } : {} });
app.registry.enrollRunner({ nodeId: "preview-local", environmentId: 1, threadId: "runner-preview", configPath: "/private/preview.json",
  configHash: "preview", maxActiveVms: 4, protocol: 4, kind: "vm" });

/** What a list row needs of a transcript: the run and its newest events, cut short. */
const cut = (value: string, max = 400) => value.length > max ? `${value.slice(0, max)}…` : value;
const brief = (event: ThreadEvent): ThreadEvent => event.type === "tool-call" ? { ...event, input: JSON.parse(cut(JSON.stringify(event.input ?? null), 2000).endsWith("…") ? "null" : JSON.stringify(event.input ?? null)) }
  : event.type === "tool-result" ? { ...event, output: cut(event.output.slice(-400)) } : { ...event, text: cut(event.text.slice(-400)) };
async function activity() {
  const threads = await Promise.all(app.registry.listThreads().filter(thread => !thread.archived).map(async thread => {
    try {
      const live = await app.conversations.live(thread.id);
      const transcript: Pick<ThreadTranscript, "status" | "events"> | null = live ? await live.read() : await app.conversations.storedHistory(thread.id, { limit: 6 });
      return { id: thread.id, agentOpen: app.conversations.agentOpen(thread.id), status: transcript?.status ?? null, events: (transcript?.events ?? []).slice(-6).map(brief), error: null };
    } catch (error) {
      return { id: thread.id, agentOpen: false, status: null, events: [], error: error instanceof Error ? error.message : String(error) };
    }
  }));
  return { at: Date.now(), threads };
}

const server = app.server;
const cubed = server.listeners("request")[0] as http.RequestListener;
server.removeAllListeners("request");
const fake = synthetic();
server.on("request", (request, response) => {
  void (async () => {
    const url = new URL(request.url!, "http://host");
    const json = (body: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(body)); };
    try {
      if (await fake.route(request, response, url, { json, activity, port: Number(values.port) })) return;
      if (url.pathname === "/api/activity" && request.method === "GET") return json(fake.activity(await activity()));
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
    cubed(request, response);
  })();
});

await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(Number(values.port), values.host ?? "127.0.0.1", () => resolve()); });
const url = `http://127.0.0.1:${values.port}`;
const post = async (route: string, body: unknown) => {
  const response = await fetch(`${url}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${route}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<any>;
};
await post("/api/onboarding", {});
for (const name of ["demo", "atlas"]) {
  const repository = seedRepository(name, `# ${name}\n\nseeded by the preview host; synthetic.\n`);
  const { project } = await post("/api/projects", { name, repositories: [{ url: repository, base: "main" }] });
  if (project.status !== "ready") throw new Error(`seeded project ${name}: ${JSON.stringify(project)}`);
}
console.log(`ready ${url} scratch=${scratch} pid=${process.pid}`);

const stop = async () => {
  server.closeAllConnections();
  await app.close().catch(() => {});
  for (const guest of machines.guests.values()) guest.stop();
  process.exit(0);
};
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
