/** Checks that a real `claude`, started with cubed's arguments (its
 * allow-list in --tools, --strict-mcp-config with no servers, stream-json
 * both ways), offers and runs the tools cube's mod registers with
 * `$.tool.register`. Like scripts/check-claude-subagents.ts it talks to a
 * scripted Messages API on loopback instead of a model, with a placeholder
 * key and its own config directory, so no login, model or provider is used.
 *
 * The workspace socket is cubed's own routes over disposable state: the
 * artifact route (claude-artifacts.ts) with a real Artifacts service and
 * store, and the workspace routes over the real guest helper in a temporary
 * root (test/local-guest.ts, which stands in for a thread VM; not runner
 * acceptance). The registry is a fake with three threads in two projects;
 * the socket holds one artifact read open (`hold`) and answers one with a
 * broken reply (`broken`), labelled below.
 *
 * The mod is cube's (cubeHooks) with the proof tools of
 * packages/claude-mod/tests/check-tools.ts instead of CUBE_TOOLS, which
 * offers none yet; a last session runs the mod as cubed loads it.
 *
 *   node scripts/check-claude-tools.ts   (CLAUDE=<path> names the binary) */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Artifacts } from "../packages/server/src/artifact-service.ts";
import { ArtifactStore, type ArtifactAuthor } from "../packages/server/src/artifacts.ts";
import { claudeArguments } from "../packages/server/src/claude-agent.ts";
import { claudeArtifactRoute } from "../packages/server/src/claude-artifacts.ts";
import type { GithubPulls } from "../packages/server/src/github-pulls.ts";
import type { Registry } from "../packages/server/src/registry.ts";
import { VmWorkspace } from "../packages/server/src/vm-workspace.ts";
import { workspaceRoute } from "../packages/server/src/workspace-http.ts";
import { LeaseStore } from "../packages/server/src/workspace-lease.ts";
import { LocalGuestTransport } from "../packages/server/test/local-guest.ts";

const claude = process.env.CLAUDE ?? "claude";
const READ = "mcp__cube__check_artifact_read", LIST = "mcp__cube__check_artifact_list";
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-claude-tools-"));

// cubed's side: the thread, its lease and the artifacts it can read.
const THREAD = "c1a0de00-0000-4000-8000-000000000001", PEER = "c1a0de00-0000-4000-8000-000000000002", OUTSIDER = "c1a0de00-0000-4000-8000-000000000003";
const projects = [{ id: "p", name: "terra", repositories: [] }, { id: "q", name: "luna", repositories: [] }];
const registry = {
  getThread: (id: string) => [THREAD, PEER, OUTSIDER].includes(id) ? { id, projectId: id === OUTSIDER ? "q" : "p", archived: false, createdAt: 0 } : null,
  getProject: (id: string) => projects.find(project => project.id === id) ?? null,
  listProjects: () => projects,
} as unknown as Registry;
const github = { async pull() { throw new Error("no network"); }, async merge() { throw new Error("no network"); } } as unknown as GithubPulls;
const artifacts = new Artifacts({ store: new ArtifactStore(path.join(temp, "artifacts.sqlite")), registry, github, optchat: async () => null, submit: async () => {} });
const author = (thread: string): ArtifactAuthor => ({ kind: "thread", thread });
const publish = (thread: string, name: string, body: string) => artifacts.write({ agent: author(thread), authors: [author(thread)] }, { name, body }, { agent: "claude-code", thread }, `seed-${name}`).id;
publish(THREAD, "plan", "# plan\n\nstep one: register the tools");
const peer = publish(PEER, "notes", "# notes\n\nwritten by another thread of the project");
const outsider = publish(OUTSIDER, "secret-plan", "# another project's plan");
const guest = new LocalGuestTransport(path.join(temp, "guest"));
const workspace = new VmWorkspace({ guest, leases: new LeaseStore(path.join(temp, "thread")), owner: "claude-code", binding: guest.binding });
const token = (await workspace.lease({ owner: "claude-code" })).token;

const BASE = `/api/threads/${THREAD}/workspace`;
const socket = path.join(temp, "workspace.sock");
const checks: string[] = [];
let held: http.ServerResponse | undefined;
let heldClosed = false;
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url!, "http://localhost");
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const json = (status: number, body: unknown) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  // The proof module's tool.check hook says it ran.
  if (url.pathname === "/check/tool.check") { checks.push(`${url.searchParams.get("tool")}:${url.searchParams.get("decision")}`); return json(200, {}); }
  if (!url.pathname.startsWith(BASE)) return json(404, { error: "not found", code: "NOT_FOUND", completionUnknown: false });
  const parts = url.pathname.slice(BASE.length).split("/").filter(Boolean).map(decodeURIComponent);
  const body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  if (parts[0] === "artifacts" && parts.length === 1) {
    // The check's own answers, not cubed's: one read never answered (a
    // stop must not wait for it) and one reply without its text.
    if (url.searchParams.get("name") === "hold") { held = response; response.on("close", () => { heldClosed = true; }); return; }
    if (url.searchParams.get("name") === "broken") return json(200, {});
    const result = await claudeArtifactRoute(artifacts, workspace, THREAD, { method: request.method!, query: url.searchParams, headers: request.headers, body });
    return json(result.status, result.body);
  }
  const result = await workspaceRoute(workspace, { method: request.method!, parts, query: url.searchParams, headers: request.headers, body });
  return json(result.status, result.body);
});
await new Promise<void>(resolve => server.listen(socket, resolve));

// The model's side: each step is one prompt, answered with these calls in
// turn (one per response), then a closing text.
type Call = { name: string; input: Record<string, unknown> };
const STEPS: Record<string, Call[]> = {
  read: [{ name: READ, input: { name: "plan" } }],
  search: [{ name: "ToolSearch", input: { query: "select:mcp__cube__check_artifact_list", max_results: 5 } }, { name: LIST, input: {} }],
  scope: [{ name: READ, input: { name: peer } }, { name: READ, input: { name: outsider } }, { name: READ, input: { name: "missing" } }],
  refused: [{ name: "mcp__cube__check_artifact_write", input: { name: "plan", body: "x" } }, { name: "mcp__other__read", input: {} }, { name: "Agent", input: { description: "look", prompt: "list the files" } }],
  invalid: [{ name: READ, input: {} }, { name: READ, input: { name: "plan", extra: 1 } }],
  broken: [{ name: READ, input: { name: "broken" } }],
  vm: [{ name: "Bash", input: { command: "printf 'from the guest' > note.txt && cat note.txt", description: "write a note" } }, { name: "Read", input: { file_path: "/workspace/note.txt" } }],
  hold: [{ name: READ, input: { name: "hold" } }],
  stale: [{ name: READ, input: { name: "plan" } }],
  none: [{ name: "Bash", input: { command: "echo hello", description: "say hello" } }],
};
type Sent = { step: string; tools: Array<{ name: string; [field: string]: unknown }>; raw: string };
const requests: Sent[] = [];
const api = http.createServer((request, response) => {
  let raw = "";
  request.on("data", chunk => { raw += chunk; });
  request.on("end", () => {
    if (!request.url?.startsWith("/v1/messages") || request.url.includes("count_tokens")) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ input_tokens: 1 }));
      return;
    }
    const sent = JSON.parse(raw) as { tools?: Sent["tools"]; messages: Array<{ role: string; content: unknown }> };
    const messages = JSON.stringify(sent.messages);
    const step = [...messages.matchAll(/STEP (\w+)/g)].at(-1)?.[1] ?? "";
    // Side requests (titles and the like) carry no tools and get text.
    if (sent.tools?.length) requests.push({ step, tools: sent.tools, raw });
    const since = messages.slice(messages.lastIndexOf(`STEP ${step}`));
    const made = since.split('"type":"tool_use"').length - 1;
    const call = sent.tools?.length ? STEPS[step]?.[made] : undefined;
    const id = `toolu_${step}_${made}_${requests.length}`;
    const events: Array<[string, Record<string, unknown>]> = [["message_start", { message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } }]];
    if (call) {
      events.push(["content_block_start", { index: 0, content_block: { type: "tool_use", id, name: call.name, input: {} } }],
        ["content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.input) } }]);
    } else {
      events.push(["content_block_start", { index: 0, content_block: { type: "text", text: "" } }], ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "done" } }]);
    }
    events.push(["content_block_stop", { index: 0 }], ["message_delta", { delta: { stop_reason: call ? "tool_use" : "end_turn" }, usage: { output_tokens: 1 } }], ["message_stop", {}]);
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const [type, data] of events) response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    response.end();
  });
});
await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
const port = (api.address() as { port: number }).port;

type Line = { type?: string; subtype?: string; session_id?: string; tools?: string[]; parent_tool_use_id?: string | null; message?: { content?: Array<{ type: string; name?: string; content?: unknown; is_error?: boolean }> } };
type Result = { error: boolean; text: string };
/** One prompt in a fresh copy of the mod; what Claude Code printed. */
async function prompt(step: string, options: { session?: string | null; production?: boolean; token?: string } = {}): Promise<{ session: string; offered: string[]; results: Result[]; lines: string[]; ms: number }> {
  const mod = path.join(temp, "mod");
  fs.rmSync(mod, { recursive: true, force: true });
  fs.cpSync(path.resolve(import.meta.dirname, "../packages/claude-mod"), mod, { recursive: true, filter: source => !source.includes(`${path.sep}.claude-plugin${path.sep}types`) });
  if (!options.production) fs.writeFileSync(path.join(mod, "hooks", "hooks.json"), JSON.stringify({ modules: ["../tests/check-tools.ts"] }));
  const cwd = path.join(temp, "claude");
  fs.mkdirSync(cwd, { recursive: true });
  const started = Date.now();
  const child = spawn(claude, claudeArguments(mod, "sonnet", options.session ?? null), { cwd, stdio: ["pipe", "pipe", "inherit"], env: {
    PATH: process.env.PATH, HOME: temp, CLAUDE_CONFIG_DIR: path.join(temp, "config"), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: "sk-check",
    CUBE_WORKSPACE_SOCKET: socket, CUBE_WORKSPACE_PATH: BASE, CUBE_WORKSPACE_TOKEN: options.token ?? token, CUBE_WORKSPACE_ROOT: cwd, CUBE_WORKSPACE_REAL_ROOT: fs.realpathSync(cwd) } });
  // stdin stays open as cubed keeps it, so a stop can be sent mid-turn.
  child.stdin.write(`${JSON.stringify({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: `STEP ${step}` }] } })}\n`);
  const lines: string[] = [];
  const parsed: Line[] = [];
  const stop = step === "hold" ? setInterval(() => {
    if (!held) return;
    clearInterval(stop);
    child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "stop-1", request: { subtype: "interrupt" } })}\n`);
  }, 50) : undefined;
  const limit = setTimeout(() => child.kill("SIGKILL"), 90_000);
  for await (const line of createInterface({ input: child.stdout })) {
    if (!line.trim()) continue;
    lines.push(line);
    const value = JSON.parse(line) as Line;
    parsed.push(value);
    if (value.type === "result") child.stdin.end();
  }
  clearTimeout(limit);
  if (stop) clearInterval(stop);
  const init = parsed.find(line => line.type === "system" && line.subtype === "init");
  assert.ok(init?.session_id, `${step}: claude code started a session`);
  assert.ok(parsed.some(line => line.type === "result"), `${step}: the turn ended`);
  const results = parsed.filter(line => line.type === "user" && !line.parent_tool_use_id).flatMap(line => line.message?.content ?? []).filter(block => block.type === "tool_result")
    .map(block => ({ error: block.is_error === true, text: typeof block.content === "string" ? block.content : JSON.stringify(block.content) }));
  return { session: init.session_id, offered: init.tools ?? [], results, lines, ms: Date.now() - started };
}
const firstTools = (step: string) => requests.find(request => request.step === step)!.tools;
const cubeTools = (tools: Sent["tools"]) => tools.filter(tool => tool.name.startsWith("mcp__"));

try {
  // Discovery: the registered tool is offered with its schema despite
  // --tools and --strict-mcp-config; the deferred one only by name.
  const read = await prompt("read");
  assert.ok(read.offered.includes(READ) && read.offered.includes(LIST), `init lists both proof tools: ${read.offered.join(",")}`);
  const sent = cubeTools(firstTools("read"));
  const loaded = sent.find(tool => tool.name === READ) as { description?: string; input_schema?: unknown } | undefined;
  assert.ok(loaded, `the model is sent ${READ}: ${JSON.stringify(sent)}`);
  assert.match(String(loaded.description), /^Proof tool: the newest revision of a cube artifact/);
  assert.deepEqual(loaded.input_schema, { type: "object", properties: { name: { type: "string", description: "the artifact name or id" } }, required: ["name"], additionalProperties: false });
  const deferred = sent.find(tool => tool.name === LIST) as { defer_loading?: boolean } | undefined;
  assert.ok(!deferred || deferred.defer_loading === true, `${LIST} is deferred: ${JSON.stringify(deferred)}`);
  // Invocation: the mod answers in tool.call over the real artifact route.
  assert.equal(read.results.length, 1);
  assert.equal(read.results[0]!.error, false, read.results[0]!.text);
  assert.match(read.results[0]!.text, /^artifact \S+ "plan" · revision 1 of 1 · by thread \[c1a0de00\] · project terra/);
  assert.match(read.results[0]!.text, /step one: register the tools/);
  assert.deepEqual(checks, [], "tool.check never ran: tool.call answered first");
  console.log(`ok: ${READ} offered with its schema under cubed's arguments; ${LIST} ${deferred ? "deferred (defer_loading)" : "behind tool search"}; the call is answered in tool.call (no tool.check)`);

  // The deferred tool, found through ToolSearch and called.
  const search = await prompt("search", { session: read.session });
  assert.equal(search.session, read.session, "resumed");
  assert.equal(search.results.length, 2, JSON.stringify(search.results));
  assert.equal(search.results[0]!.error, false, `ToolSearch: ${search.results[0]!.text}`);
  assert.equal(search.results[1]!.error, false, `${LIST}: ${search.results[1]!.text}`);
  assert.match(search.results[1]!.text, /plan/);
  assert.match(search.results[1]!.text, /notes/);
  assert.doesNotMatch(search.results[1]!.text, /secret-plan/, "the list is the project's");
  console.log(`ok: ${LIST} found through ToolSearch and called, resumed`);

  // cubed's scope: another thread's artifact of the project by id, not
  // another project's, and an unknown name, refused as the route refuses it.
  const scope = await prompt("scope", { session: read.session });
  assert.equal(scope.results[0]!.error, false, scope.results[0]!.text);
  assert.match(scope.results[0]!.text, /written by another thread of the project/);
  assert.equal(scope.results[1]!.error, true, scope.results[1]!.text);
  assert.doesNotMatch(scope.results[1]!.text, /another project's plan/);
  assert.equal(scope.results[2]!.error, true);
  assert.match(scope.results[2]!.text, /NOT_FOUND: no artifact named missing/);
  console.log(`ok: cubed's scope holds: the project's artifacts by id, not another project's (${JSON.stringify(scope.results[1]!.text)}), an unknown name refused`);

  // Tools the mod did not register, another plugin's, and a subagent.
  const refused = await prompt("refused", { session: read.session });
  assert.deepEqual(refused.results.map(result => result.error), [true, true, true], JSON.stringify(refused.results));
  assert.match(refused.results[0]!.text, /No such tool available: mcp__cube__check_artifact_write/);
  assert.match(refused.results[1]!.text, /No such tool available: mcp__other__read/);
  assert.match(refused.results[2]!.text, /No such tool available: Agent/);
  console.log("ok: an unregistered cube tool, another plugin's tool and Agent are refused");

  // Claude Code does not hold the input to the registered schema: the
  // tool's own check refuses it, before cubed is asked.
  const before = requests.length;
  const invalid = await prompt("invalid", { session: read.session });
  assert.deepEqual(invalid.results, [{ error: true, text: "<tool_use_error>invalid input: name (a string) only</tool_use_error>" },
    { error: true, text: "<tool_use_error>invalid input: name (a string) only, not extra</tool_use_error>" }]);
  assert.ok(requests.length > before);
  console.log("ok: input outside the schema reaches the tool (claude code does not check it); the tool's own check refuses it");

  // A failure the tool does not expect is a refusal, not a pass to the engine.
  const broken = await prompt("broken", { session: read.session });
  assert.equal(broken.results[0]!.error, true);
  assert.equal(broken.results[0]!.text, "<tool_use_error>check_artifact_read: cubed answered without a text</tool_use_error>");
  console.log(`ok: a thrown failure comes back as the tool's error: ${JSON.stringify(broken.results[0]!.text)}`);

  // The file and shell tools still go to the thread's machine.
  const vm = await prompt("vm", { session: read.session });
  assert.deepEqual(vm.results.map(result => result.error), [false, false], JSON.stringify(vm.results));
  assert.match(vm.results[0]!.text, /from the guest/);
  assert.match(vm.results[1]!.text, /from the guest/);
  assert.equal(fs.readFileSync(path.join(guest.workspace, "note.txt"), "utf8"), "from the guest");
  console.log("ok: Bash and Read still reach the workspace beside the registered tools");

  // A stop while cubed has not answered: the turn ends without waiting.
  const hold = await prompt("hold", { session: read.session });
  assert.ok(held, "the read reached cubed");
  assert.ok(hold.ms < 30_000, `the stopped turn ended in ${hold.ms} ms`);
  console.log(`ok: an interrupt during a registered call ends the turn in ${hold.ms} ms (results ${JSON.stringify(hold.results)}; the open request ${heldClosed ? "was closed by the child" : "stayed open until the child exited"})`);
  held?.end(JSON.stringify({ text: "too late" }));

  // A token cubed does not hold for this thread is refused by the route.
  const stale = await prompt("stale", { session: read.session, token: "b".repeat(64) });
  assert.equal(stale.results[0]!.error, true);
  assert.match(stale.results[0]!.text, /LEASE_STALE: workspace lease is not held by this token/);
  console.log("ok: a session without the thread's lease is refused by cubed");

  // The same tools, in the same order and shape, on a second fresh start.
  const again = await prompt("read");
  assert.notEqual(again.session, read.session);
  assert.equal(again.results[0]!.error, false);
  const starts = requests.filter(request => request.step === "read").map(request => request.tools);
  assert.ok(starts.length >= 3, "two fresh starts sent their tools");
  assert.deepEqual(starts.at(-1), starts[0], "the tools sent on two fresh starts are identical");
  // The rest of the prefix too: the system prompt and the messages of the
  // first request, where Claude Code names the deferred tools and adds the
  // mod's MCP server instructions; only the session id differs.
  const prefix = (raw: string) => { const sent = JSON.parse(raw) as { system: unknown; messages: unknown[] }; return JSON.stringify([sent.system, sent.messages]).replaceAll(read.session, "S").replaceAll(again.session, "S"); };
  const fresh = requests.filter(request => request.step === "read");
  assert.equal(prefix(fresh.at(-2)!.raw), prefix(fresh[0]!.raw), "the first request is identical on two fresh starts");
  assert.match(prefix(fresh[0]!.raw), /available via ToolSearch[^#]*\\nmcp__cube__check_artifact_list\\n/, `the first request names the deferred ${LIST}`);
  assert.match(prefix(fresh[0]!.raw), /## cube\\nTools registered by the cube plugin through \$\.tool\.register\./);
  const resumed = requests.filter(request => request.step !== "read" && request.step !== "none").map(request => cubeTools(request.tools).filter(tool => tool.name === READ));
  for (const tools of resumed) assert.deepEqual(tools, cubeTools(starts[0]!).filter(tool => tool.name === READ), "resumed starts send the same registered tool");
  console.log(`ok: the first request (tools, system, messages) is identical across fresh starts (${starts[0]!.map(tool => tool.name).join(",")}) and the registered tool across resumes`);

  // The mod as cubed loads it registers nothing; Bash still runs in the machine.
  const none = await prompt("none", { production: true });
  assert.deepEqual(none.offered.filter(name => name.startsWith("mcp__")), [], "no mcp tool in init");
  assert.deepEqual(cubeTools(firstTools("none")), [], "no mcp tool sent to the model");
  assert.ok(!requests.find(request => request.step === "none")!.raw.includes("Tools registered by the cube plugin"), "no mcp server instructions");
  assert.deepEqual(none.results, [{ error: false, text: "hello" }]);
  // The same tools otherwise, each the same; Claude Code orders them anew.
  const byName = (tools: Sent["tools"]) => [...tools].sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(byName(firstTools("none")), byName(starts[0]!.filter(tool => !tool.name.startsWith("mcp__"))), "the production tools are the proof's without its tools");
  console.log(`ok: cube's mod as cubed loads it offers no registered tool; the other tools are the same (order ${firstTools("none").map(tool => tool.name).join(",")} without, ${starts[0]!.map(tool => tool.name).join(",")} with)`);

  // Nothing the model sees or Claude Code prints carries the lease token.
  for (const request of requests) assert.ok(!request.raw.includes(token), `the lease token reached the model in step ${request.step}`);
  for (const turn of [read, search, scope, refused, invalid, broken, vm, hold, stale, again, none]) assert.ok(!turn.lines.some(line => line.includes(token)), "the lease token in Claude Code's output");
  console.log(`ok: the lease token is in no model request (${requests.length}) and no output line`);
} finally {
  held?.destroy();
  api.close();
  server.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
