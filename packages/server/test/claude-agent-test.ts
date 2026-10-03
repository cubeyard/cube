/** Claude Code threads, offline: ClaudeAgent starts a fake `claude` that
 * speaks stream-json and runs the Claude Code mod's own tool functions over
 * cubed's workspace socket (routes -> RunnerWorkspace -> fake runner), keyed
 * by tool_use_id. The real `claude` CLI is never started. */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Models } from "@earendil-works/pi-ai";
import { ClaudeAgent, ClaudeBusy, claudeEnvironment, type ClaudeRuntime } from "../src/claude-agent.ts";
import { ClaudeThreadEvents } from "../src/claude-thread-events.ts";
import { ModelAuth } from "../src/model-auth.ts";
import type { ThreadTranscript } from "../src/thread-events.ts";
import { RunnerWorkspace, WorkspaceError } from "../src/workspace.ts";
import { workspaceRoute } from "../src/workspace-http.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { WorkspaceClient } from "../../claude-mod/hooks/workspace.ts";
import { bash, edit, read, write, workspacePath } from "../../claude-mod/hooks/tools.ts";
import { FakeRunner } from "./workspace-fake-runner.ts";
import { unixTransport } from "./unix-transport.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-claude-"));
const files = path.join(root, "workspace");
fs.mkdirSync(files, { recursive: true });
const runner = new FakeRunner(files);
const leases = new LeaseStore(path.join(root, "thread"));
const workspace = new RunnerWorkspace({ runner, leases, owner: "claude-code" });
const socket = path.join(root, "workspace.sock");
const server = http.createServer(async (request, response) => {
  const url = new URL(request.url!, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  let raw = "";
  for await (const chunk of request) raw += chunk;
  if (parts.slice(0, 4).join("/") !== "api/threads/t1/workspace") { response.writeHead(404); response.end("{}"); return; }
  const result = await workspaceRoute(workspace, { method: request.method!, parts: parts.slice(4), query: url.searchParams, headers: request.headers, body: raw ? JSON.parse(raw) : {} });
  response.writeHead(result.status, { "content-type": "application/json" });
  response.end(JSON.stringify(result.body));
});
await new Promise<void>(resolve => server.listen(socket, resolve));
const log = path.join(root, "claude.log");
// The child must never see API credentials: the subscription is what Claude Code uses.
process.env.ANTHROPIC_API_KEY = "sk-ant-api-must-not-reach-claude";
process.env.ANTHROPIC_AUTH_TOKEN = "bearer-must-not-reach-claude";
// Nor anything else of cubed's: other providers' keys, Git and cloud
// tokens, or a switch that moves billing off the subscription.
process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9/must-not-reach-claude";
process.env.CLAUDE_CODE_USE_BEDROCK = "1";
process.env.OPENAI_API_KEY = "sk-openai-must-not-reach-claude";
process.env.GITHUB_TOKEN = "ghp-must-not-reach-claude";
process.env.CLAUDE_CODE_OAUTH_TOKEN = "the-person's-own-claude-login";
const mod = path.resolve(import.meta.dirname, "../../claude-mod");
const runtime: ClaudeRuntime = { command: [process.execPath, path.join(import.meta.dirname, "fake-claude.ts")], mod, socket, stopGraceMs: 1000, env: { FAKE_CLAUDE_LOG: log } };
const leaseToken = (holder: ClaudeAgent) => (holder as unknown as { lease: { token: string } }).lease.token;
async function cancelled(holder: ClaudeAgent, key: string): Promise<void> {
  await until(async () => { const state = await workspace.operation(leaseToken(holder), key); return state.state === "failed" && state.error === "CANCELLED"; }, `${key} cancelled on the runner`);
}
const directory = path.join(root, "thread");
const starts = () => fs.readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line) as { args: string[]; cwd: string; session: string; apiKey: boolean; authToken: boolean; env: string[] });
async function until<T>(check: () => T | undefined | false | Promise<T | undefined | false>, what: string, ms = 15000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    assert(Date.now() < deadline, `waiting for ${what}`);
    await delay(20);
  }
}

let agent = await ClaudeAgent.open({ directory, threadId: "t1", workspace, runtime, model: "sonnet" });
try {
  // The lease: claude-code is the thread's one writable owner.
  assert.equal(leases.holder(), "claude-code");
  await assert.rejects(workspace.lease({ owner: "claude-code" }), (error: unknown) => error instanceof WorkspaceError && error.code === "LEASE_HELD");
  await assert.rejects(workspace.lease({ owner: "pi" }), (error: unknown) => error instanceof WorkspaceError && error.code === "CONFLICT");

  let events = new ClaudeThreadEvents({ agent, owner: () => leases.holder(), failure: () => null });
  const frames: ThreadTranscript[] = [];
  const watch = await events.watch(frame => { frames.push(frame); });
  assert.equal(frames[0]!.status.state, "idle");
  const settled = async (run: string) => until(async () => { const value = await events.read(); return value.status.run === run && value.status.state !== "working" && value; }, `run ${run}`);

  // One prompt, every mapped tool, the runner doing the work.
  await agent.submit("r1", ["run printf hello > a.txt; printf 7", "write notes/b.txt alpha beta", "edit notes/b.txt beta gamma", "read notes/b.txt"].join("\n"));
  let transcript = await settled("r1");
  assert.equal(transcript.status.state, "completed", JSON.stringify(transcript.status));
  assert.equal(transcript.agent, "claude-code");
  assert.equal(transcript.owner, "claude-code");
  assert.equal(fs.readFileSync(path.join(files, "a.txt"), "utf8"), "hello");
  assert.equal(fs.readFileSync(path.join(files, "notes/b.txt"), "utf8"), "alpha gamma");
  const types = transcript.events.map(event => event.type === "tool-call" || event.type === "tool-result" ? `${event.type}:${event.name}` : event.type);
  assert.deepEqual(types, ["user-message", "tool-call:Bash", "tool-result:Bash", "tool-call:Write", "tool-result:Write", "tool-call:Edit", "tool-result:Edit", "tool-call:Read", "tool-result:Read", "assistant-text"]);
  const results = transcript.events.filter(event => event.type === "tool-result");
  assert.equal(results[0]!.type === "tool-result" && results[0]!.output, "7");
  assert.equal(results[3]!.type === "tool-result" && results[3]!.output, "alpha gamma");
  assert.ok(transcript.events.every(event => !("final" in event) || event.final));
  await until(() => frames.some(frame => frame.events.some(event => event.type === "assistant-text" && !event.final)), "a streaming frame");
  assert.ok(frames.some(frame => frame.status.state === "working"));
  const [first] = starts();
  assert.equal(first!.apiKey, false, "ANTHROPIC_API_KEY is removed from the child");
  assert.equal(first!.authToken, false, "ANTHROPIC_AUTH_TOKEN is removed from the child");
  for (const name of ["ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "OPENAI_API_KEY", "GITHUB_TOKEN"]) assert.ok(!first!.env.includes(name), `${name} does not reach the child`);
  assert.ok(first!.env.includes("CLAUDE_CODE_OAUTH_TOKEN") && first!.env.includes("HOME") && first!.env.includes("CUBE_WORKSPACE_TOKEN"));
  assert.ok(first!.env.every(name => /^(HOME|PATH|USER|LOGNAME|SHELL|LANG|LANGUAGE|LC_\w+|TERM|TZ|TMPDIR|XDG_\w+|CLAUDE_CONFIG_DIR|CLAUDE_CODE_OAUTH_TOKEN|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|CUBE_WORKSPACE_\w+|FAKE_CLAUDE_LOG)$/.test(name)), `only allow-listed variables: ${first!.env.join(" ")}`);
  assert.deepEqual(Object.keys(claudeEnvironment({ PATH: "/bin", AWS_SECRET_ACCESS_KEY: "x" }, { ANTHROPIC_BASE_URL: "x", CLAUDE_CODE_USE_VERTEX: "1", EXTRA: "y" }, { CUBE_WORKSPACE_TOKEN: "t" })).sort(), ["CUBE_WORKSPACE_TOKEN", "EXTRA", "PATH"]);
  assert.equal(first!.args[first!.args.indexOf("--setting-sources") + 1], "");
  assert.ok(first!.args.includes("--strict-mcp-config"));
  assert.deepEqual(first!.args.slice(0, 7), ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"]);
  assert.equal(first!.args[first!.args.indexOf("--plugin-dir") + 1], mod);
  assert.equal(first!.args[first!.args.indexOf("--model") + 1], "sonnet");
  assert.ok(!first!.args.includes("--resume"));
  assert.equal(first!.cwd, path.join(directory, "claude"));

  // Prompts are accepted once per request id.
  await agent.submit("r1", ["run printf hello > a.txt; printf 7", "write notes/b.txt alpha beta", "edit notes/b.txt beta gamma", "read notes/b.txt"].join("\n"));
  await assert.rejects(agent.submit("r1", "different"), /conflicts/);
  assert.equal(agent.state().submissions.length, 1);

  // A tool_use_id is a workspace key: the same call never runs twice, even
  // after a model change restarts Claude Code with --resume.
  await agent.submit("r2", "id toolu_fixed run printf x >> count; printf counted");
  assert.equal((await settled("r2")).status.state, "completed");
  await agent.setModel("opus");
  assert.equal(agent.model, "opus");
  await agent.submit("r3", "id toolu_fixed run printf x >> count; printf counted");
  transcript = await settled("r3");
  assert.equal(transcript.status.state, "completed");
  assert.equal(fs.readFileSync(path.join(files, "count"), "utf8"), "x", "the runner executed the keyed command once");
  assert.match(JSON.stringify(transcript.events.at(-1)), /done with opus/);
  const second = starts()[1]!;
  assert.equal(second.args[second.args.indexOf("--resume") + 1], first!.session, "a restarted child resumes the Claude Code session");
  assert.equal(second.args[second.args.indexOf("--model") + 1], "opus");
  await assert.rejects(agent.setModel("gpt-5"), /model unavailable/);

  // Stop interrupts the turn and kills the runner command.
  await agent.submit("r4", "slow sleep 2; touch late");
  await until(() => agent.state().messages.some(message => JSON.stringify(message.data).includes("touch late")), "the slow tool call");
  await delay(200);
  await assert.rejects(agent.submit("r5", "say busy"), (error: unknown) => error instanceof ClaudeBusy);
  const stopped = Date.now();
  await agent.stop();
  transcript = await settled("r4");
  assert.equal(transcript.status.state, "stopped");
  assert.ok(Date.now() - stopped < 3000, "stop does not wait for the command");
  await delay(2500);
  assert.ok(!fs.existsSync(path.join(files, "late")), "the runner command was killed");

  // A child that ignores the interrupt is killed after the grace period, and
  // cubed cancels its runner command itself: the mod never saw an abort.
  await agent.submit("r6", "ignore-interrupt\nid toolu_ignored slow sleep 3; touch late-ignored");
  await until(() => agent.state().messages.some(message => JSON.stringify(message.data).includes("toolu_ignored")), "the ignored tool call");
  await delay(200);
  await agent.stop();
  assert.equal((await settled("r6")).status.state, "stopped");
  await cancelled(agent, "claude:toolu_ignored:bash");
  // One that ignores SIGTERM as well is killed.
  await agent.submit("r6b", "ignore-interrupt\nignore-term\nhang");
  await delay(300);
  await agent.stop();
  assert.equal((await settled("r6b")).status.state, "stopped");

  // A child that exits mid-turn fails the turn with what it said.
  await agent.submit("r7", "crash");
  transcript = await settled("r7");
  assert.equal(transcript.status.state, "failed");
  assert.match(transcript.status.error ?? "", /fake claude crashed/);
  await agent.submit("r8", "fail");
  transcript = await settled("r8");
  assert.equal(transcript.status.state, "failed");
  assert.match(transcript.status.error ?? "", /Please run \/login/);

  // A cubed stop during a turn: the turn is over after reopen, honestly,
  // and the transcript is kept.
  await agent.submit("r9", "id toolu_close slow sleep 30");
  await until(() => agent.state().messages.some(message => JSON.stringify(message.data).includes("sleep 30")), "the long tool call");
  const before = (await events.read()).events.length;
  await agent.close();
  await watch.closed;
  assert.equal(leases.holder(), null, "closing releases the lease");
  agent = await ClaudeAgent.open({ directory, threadId: "t1", workspace, runtime, model: "sonnet" });
  events = new ClaudeThreadEvents({ agent, owner: () => leases.holder(), failure: () => null });
  transcript = await events.read();
  assert.equal(transcript.status.state, "failed");
  assert.match(transcript.status.error ?? "", /does not continue an interrupted turn/);
  assert.equal(transcript.events.length, before);
  assert.equal(agent.model, "opus", "the chosen model survives a reopen");
  // Closing cancelled the turn's runner command: it would never be continued.
  await cancelled(agent, "claude:toolu_close:bash");
  assert.ok(!fs.existsSync(path.join(files, "late-ignored")), "the ignored stop's command never finished");
  await agent.submit("r10", "say back again");
  transcript = await settled("r10");
  assert.equal(transcript.status.state, "completed");
  assert.equal(starts().at(-1)!.args[starts().at(-1)!.args.indexOf("--resume") + 1], first!.session);
  console.log("ok: claude code thread over the fake claude: mod tools on the workspace, keyed calls once, env without api credentials, resume, model change");
  console.log("ok: stop as interrupt with runner cancel and kill fallback, crash and api failure, interrupted turn after reopen, lease held and released");

  // The mod's workspace functions against the real routes: paths, Edit's
  // sha condition and refusals.
  const lease = await workspace.lease({ owner: "claude-code" }).catch(() => null);
  assert.equal(lease, null, "the reopened agent holds the lease");
  const token = leaseToken(agent);
  const client = new WorkspaceClient({ base: "/api/threads/t1/workspace", transport: unixTransport(socket) });
  // cubed's own lease cannot be released or renewed over the routes, even
  // with its token (which the child and its processes can see).
  await assert.rejects(client.release(token), /held by cubed/);
  await assert.rejects(client.lease({ token }), /held by cubed/);
  assert.equal(leases.holder(), "claude-code");
  const scope = { client, token, root: "/home/cube/thread" };
  assert.deepEqual(workspacePath(scope.root, "/home/cube/thread/src/../x"), { deny: "/home/cube/thread/src/../x leaves the thread workspace" });
  assert.equal(workspacePath(scope.root, "/workspace/src/a.ts"), "src/a.ts");
  assert.equal(workspacePath(scope.root, "src//./a.ts"), "src/a.ts");
  assert.match(String((await read(scope, { file_path: "/etc/hosts" }) as { deny: string }).deny), /outside the thread workspace/);
  assert.deepEqual(await write(scope, "t-w1", { file_path: "/home/cube/thread/c.txt", content: "one two" }), { type: "create", filePath: "/home/cube/thread/c.txt", content: "one two", structuredPatch: [], originalFile: null });
  assert.equal((await write(scope, "t-w2", { file_path: "/home/cube/thread/c.txt", content: "one two" }) as { type: string }).type, "update");
  fs.writeFileSync(path.join(files, "d.txt"), "same same\n");
  assert.match((await edit(scope, "t-e1", { file_path: "d.txt", old_string: "same", new_string: "new" }) as { deny: string }).deny, /Found 2 matches/);
  assert.equal((await edit(scope, "t-e2", { file_path: "d.txt", old_string: "same", new_string: "new", replace_all: true }) as { replaceAll: boolean }).replaceAll, true);
  assert.equal(fs.readFileSync(path.join(files, "d.txt"), "utf8"), "new new\n");
  assert.deepEqual(await read(scope, { file_path: "d.txt", offset: 1, limit: 5 }), { type: "text", file: { filePath: "d.txt", content: "new new", numLines: 1, startLine: 1, totalLines: 1 } });
  assert.match((await edit(scope, "t-e3", { file_path: "missing.txt", old_string: "a", new_string: "b" }) as { deny: string }).deny, /does not exist/);
  assert.match((await bash(scope, "t-b1", { command: "sleep 1", run_in_background: true }) as { deny: string }).deny, /background commands/);
  assert.deepEqual(await bash(scope, "t-b2", { command: "printf out; exit 3" }), { stdout: "out", stderr: "exit code 3", interrupted: false });
  assert.deepEqual(await bash(scope, "t-b2", { command: "printf out; exit 3" }), { stdout: "out", stderr: "exit code 3", interrupted: false }, "a repeated tool_use_id returns the original result");
  assert.match((await bash(scope, "t-b2", { command: "printf other" }) as { deny: string }).deny, /CONFLICT|conflict/i);
  fs.writeFileSync(path.join(files, "binary"), Buffer.from([0, 1, 2]));
  assert.match((await read(scope, { file_path: "binary" }) as { deny: string }).deny, /not UTF-8/);
  assert.match((await bash({ ...scope, token: "f".repeat(64) }, "t-b3", { command: "true" }) as { deny: string }).deny, /no longer holds the thread workspace/);
  const aborting = new AbortController();
  const slow = bash({ ...scope, signal: aborting.signal }, "t-b4", { command: "sleep 3; touch late-2" });
  await delay(300);
  aborting.abort();
  assert.deepEqual(await slow, { stdout: "", stderr: "command stopped", interrupted: true });
  await delay(3200);
  assert.ok(!fs.existsSync(path.join(files, "late-2")), "an abandoned Bash call cancels its runner command");
  console.log("ok: claude mod tools over the workspace socket: path mapping, write/edit with sha, refusals, keyed replay, conflict, cancel on abort");

  // Pi never offers Anthropic's Claude Pro/Max OAuth login.
  const provider = (id: string) => ({ id, name: id, auth: { apiKey: { login: async () => ({ type: "api_key", key: "k" }) }, oauth: { loginLabel: `sign in to ${id}` } } });
  const models = { getProviders: () => [provider("anthropic"), provider("other")], getProvider: (id: string) => provider(id), checkAuth: async () => undefined } as unknown as Models;
  const auth = new ModelAuth(models);
  const listed = await auth.list();
  assert.deepEqual(listed.find(entry => entry.id === "anthropic")!.methods.map(method => method.type), ["api_key"]);
  assert.deepEqual(listed.find(entry => entry.id === "other")!.methods.map(method => method.type), ["api_key", "oauth"]);
  assert.throws(() => auth.start("anthropic", "oauth"), /not supported/);
  console.log("ok: anthropic pro/max oauth is not offered to pi");
} finally {
  await agent.close().catch(() => {});
  leases.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  runner.close();
  fs.rmSync(root, { recursive: true, force: true });
}
