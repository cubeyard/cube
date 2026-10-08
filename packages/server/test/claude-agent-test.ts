/** Claude Code threads, offline: ClaudeAgent starts a fake `claude` that
 * speaks stream-json and runs the Claude Code mod's own tool functions over
 * cubed's workspace socket (routes -> VmWorkspace -> local guest), keyed
 * by tool_use_id. The real `claude` CLI is never started. */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type { Models } from "@earendil-works/pi-ai";
import { ClaudeAgent, ClaudeBusy, claudeEnvironment, type ClaudeRuntime } from "../src/claude-agent.ts";
import { ClaudeThreadEvents } from "../src/claude-thread-events.ts";
import { ModelAuth } from "../src/model-auth.ts";
import type { ThreadTranscript } from "../src/thread-events.ts";
import { WorkspaceError } from "../src/workspace.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { workspaceRoute } from "../src/workspace-http.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { WorkspaceClient } from "../../claude-mod/hooks/workspace.ts";
import { bash, edit, imageInfo, MAX_IMAGE_BYTES, read, write, workspacePath } from "../../claude-mod/hooks/tools.ts";
import { LocalGuestTransport } from "./local-guest.ts";
import { unixTransport } from "./unix-transport.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-claude-"));
const files = path.join(root, "workspace");
fs.mkdirSync(files, { recursive: true });
const guest = new LocalGuestTransport(path.dirname(files));
const leases = new LeaseStore(path.join(root, "thread"));
const workspace = new VmWorkspace({ guest, leases, owner: "claude-code", binding: guest.binding });
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
  await until(async () => { const state = await workspace.operation(leaseToken(holder), key).catch(e => ({ state: String(e) })); return state.state === "failed" && (state as { error?: string }).error === "CANCELLED"; }, `${key} cancelled on the guest`);
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

  // One prompt, every mapped tool, the guest doing the work.
  await agent.submit("r1", ["run printf hello > a.txt; printf 7", "write notes/b.txt alpha beta", "edit notes/b.txt beta gamma", "read notes/b.txt"].join("\n"));
  let transcript = await settled("r1");
  assert.equal(transcript.status.state, "completed", JSON.stringify(transcript.status));
  assert.equal(transcript.agent, "claude-code");
  assert.equal(transcript.owner, "claude-code");
  assert.equal(fs.readFileSync(path.join(files, "a.txt"), "utf8"), "hello");
  assert.equal(fs.readFileSync(path.join(files, "notes/b.txt"), "utf8"), "alpha gamma");
  const types = transcript.events.map(event => event.type === "tool-call" || event.type === "tool-result" ? `${event.type}:${event.name}` : event.type);
  assert.deepEqual(types, ["user-message", "tool-call:Bash", "tool-result:Bash", "tool-call:Write", "tool-result:Write", "tool-call:Edit", "tool-result:Edit", "tool-call:Read", "tool-result:Read", "assistant-text"]);
  // The transcript shows the workspace as /workspace, never Claude Code's host directory.
  assert.ok(!JSON.stringify(transcript).includes(agent.root), "no host path in the transcript");
  assert.match(JSON.stringify(transcript.events.find(event => event.type === "tool-call" && event.name === "Write")), /"\/workspace\//);
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
  assert.ok(first!.env.includes("CUBE_WORKSPACE_REAL_ROOT"), "the mod also knows the root with its symlinks resolved");
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
  assert.equal(fs.readFileSync(path.join(files, "count"), "utf8"), "x", "the guest executed the keyed command once");
  assert.match(JSON.stringify(transcript.events.at(-1)), /done with opus/);
  const second = starts()[1]!;
  assert.equal(second.args[second.args.indexOf("--resume") + 1], first!.session, "a restarted child resumes the Claude Code session");
  assert.equal(second.args[second.args.indexOf("--model") + 1], "opus");
  await assert.rejects(agent.setModel("gpt-5"), /model unavailable/);

  // Stop interrupts the turn and kills the guest command.
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
  assert.ok(!fs.existsSync(path.join(files, "late")), "the guest command was killed");

  // A child that ignores the interrupt is killed after the grace period, and
  // cubed cancels its guest command itself: the mod never saw an abort.
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
  // Closing cancelled the turn's guest command: it would never be continued.
  await cancelled(agent, "claude:toolu_close:bash");
  assert.ok(!fs.existsSync(path.join(files, "late-ignored")), "the ignored stop's command never finished");
  await agent.submit("r10", "say back again");
  transcript = await settled("r10");
  assert.equal(transcript.status.state, "completed");
  assert.equal(starts().at(-1)!.args[starts().at(-1)!.args.indexOf("--resume") + 1], first!.session);
  console.log("ok: claude code thread over the fake claude: mod tools on the workspace, keyed calls once, env without api credentials, resume, model change");
  console.log("ok: stop as interrupt with guest cancel and kill fallback, crash and api failure, interrupted turn after reopen, lease held and released");

  // cubed itself dies mid-turn (no close): the reopen finds the turn's open
  // Bash call in the stored transcript and cancels its guest command.
  await agent.close();
  {
    const crashed = path.join(root, "crashed");
    const opened = await ClaudeAgent.open({ directory: crashed, threadId: "t1", workspace, runtime, model: "sonnet" });
    const token = leaseToken(opened);
    await workspace.exec(token, "claude:toolu_crash:bash", { command: "sleep 3; touch late-crash", timeoutMs: 10000, outputLimit: 1024 });
    const db = new DatabaseSync(path.join(crashed, "claude.sqlite"));
    db.prepare("INSERT INTO submission(request_id, text, state, error, created_at) VALUES ('crash', 'run it', 'running', NULL, 0)").run();
    db.prepare("INSERT INTO message(submission, data) VALUES ((SELECT seq FROM submission WHERE request_id='crash'), ?)")
      .run(JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "toolu_crash", name: "Bash", input: { command: "sleep 3; touch late-crash" } }] } }));
    db.close();
    // The lease's process is gone; the reopened agent is the next holder.
    await opened.close();
    const reopened = await ClaudeAgent.open({ directory: crashed, threadId: "t1", workspace, runtime, model: "sonnet" });
    try {
      await cancelled(reopened, "claude:toolu_crash:bash");
      await delay(3500);
      assert.ok(!fs.existsSync(path.join(files, "late-crash")), "the interrupted turn's command never finished");
    } finally { await reopened.close(); }
  }
  console.log("ok: a reopen after cubed died mid-turn cancels the interrupted turn's guest commands");

  // Background agents. A turn that ends with one running leaves the thread
  // waiting: the child stays open past the idle close, and the turn Claude
  // Code takes for the notification is a run of its own.
  {
    const background = path.join(root, "background");
    const fast: ClaudeRuntime = { ...runtime, idleMs: 200, continueGraceMs: 400 };
    let bg = await ClaudeAgent.open({ directory: background, threadId: "t1", workspace, runtime: fast, model: "sonnet" });
    const read = () => new ClaudeThreadEvents({ agent: bg, owner: () => leases.holder(), failure: () => null }).read();
    const ran = (run: string) => until(async () => { const value = await read(); return value.status.run === run && value.status.state !== "working" && value; }, `run ${run}`);
    const before = starts().length;
    await bg.submit("b1", "background task_a 1200 fable review\nsay waiting for the review");
    let shown = await ran("b1");
    assert.equal(shown.status.state, "completed");
    assert.deepEqual(shown.status.waiting, ["fable review"]);
    assert.deepEqual(ClaudeAgent.stored(background)!.waiting, ["fable review"], "the store shows the wait too");
    await delay(500);
    assert.equal((await read()).status.run, "b1", "a background agent's own messages start no run");
    shown = await ran("cube:background:task_a");
    assert.equal(shown.status.state, "completed");
    assert.equal(shown.status.waiting, undefined);
    assert.ok(shown.events.some(event => event.type === "user-message" && event.text === "cube: background agent \"fable review\" finished; claude code goes on"));
    assert.match(JSON.stringify(shown.events.at(-1)), /task_a reviewed: nothing to fix/);
    assert.ok(!JSON.stringify(shown.events).includes("task_a working"), "the background agent's messages stay inside its call");
    assert.equal(starts().length, before + 1, "one child: the idle close waited for the background agent");
    assert.ok(!bg.state().submissions.some(submission => submission.requestId.startsWith("cube:continued:")));

    // A notification Claude Code takes no turn for fails its run after the grace.
    await bg.submit("b2", "background-quiet task_b 300 quiet check");
    assert.deepEqual((await ran("b2")).status.waiting, ["quiet check"]);
    shown = await ran("cube:background:task_b");
    assert.equal(shown.status.state, "failed");
    assert.match(shown.status.error ?? "", /but did not — send a message to go on/);

    // Stop between turns ends the background agents, recorded as stopped;
    // a model change would end them too and is refused.
    await bg.submit("b3", "background task_c 30000 long audit");
    assert.deepEqual((await ran("b3")).status.waiting, ["long audit"]);
    await assert.rejects(bg.setModel("opus"), /background agents/);
    await bg.stop();
    shown = await ran("cube:background:task_c:lost");
    assert.equal(shown.status.state, "stopped");
    assert.match(shown.status.error ?? "", /background agent "long audit" did not finish: stopped in cube/);
    assert.deepEqual(bg.waiting, []);

    // cubed stops while one runs: the close records it as lost.
    await bg.submit("b4", "background task_d 30000 ci watch");
    await ran("b4");
    await bg.close();
    let stored = ClaudeAgent.stored(background)!;
    assert.deepEqual(stored.waiting, []);
    assert.equal(stored.submissions.at(-1)!.requestId, "cube:background:task_d:lost");
    assert.equal(stored.submissions.at(-1)!.state, "failed");
    assert.match(stored.submissions.at(-1)!.error ?? "", /cubed closed claude code while it ran.*send a message to go on/);
    // cubed dies while one runs (no close): the next open records it.
    const db = new DatabaseSync(path.join(background, "claude.sqlite"));
    db.prepare("INSERT INTO background(task_id, submission, description, state, started_at) VALUES ('task_e', (SELECT MAX(seq) FROM submission), 'crashed audit', 'running', 0)").run();
    db.close();
    assert.deepEqual(ClaudeAgent.stored(background)!.waiting, ["crashed audit"]);
    bg = await ClaudeAgent.open({ directory: background, threadId: "t1", workspace, runtime: { ...fast, backgroundMs: 700 }, model: "sonnet" });
    stored = ClaudeAgent.stored(background)!;
    assert.equal(stored.submissions.at(-1)!.requestId, "cube:background:task_e:lost");
    assert.equal(stored.submissions.at(-1)!.state, "failed");
    assert.deepEqual(stored.waiting, []);

    // One that runs past backgroundMs is ended with Claude Code, never waited for forever.
    await bg.submit("b5", "background task_f 30000 endless");
    await ran("b5");
    shown = await ran("cube:background:task_f:lost");
    assert.equal(shown.status.state, "failed");
    assert.match(shown.status.error ?? "", /still running 1 s after it started; cubed ended claude code/);

    // Backgrounded later (task_updated): waited for, and its turn is a run.
    await bg.submit("b6", "background-later task_g 300 slow review");
    assert.deepEqual((await ran("b6")).status.waiting, ["slow review"]);
    assert.equal((await ran("cube:background:task_g")).status.state, "completed");
    // A notification during a running turn is taken in by that turn: no run of its own.
    await bg.submit("b7", "background task_h 150 quick look\nslow sleep 1");
    shown = await ran("b7");
    assert.equal(shown.status.state, "completed");
    assert.equal(shown.status.waiting, undefined);
    await delay(300);
    assert.ok(!bg.state().submissions.some(submission => submission.requestId === "cube:background:task_h"));
    // Another kind of backgrounded task (it may never notify) is not waited for.
    await bg.submit("b8", "monitor task_k");
    assert.equal((await ran("b8")).status.waiting, undefined);
    // Two lost together are one run that names both.
    await bg.submit("b9", "background task_i 30000 one\nbackground task_j 30000 two");
    assert.deepEqual((await ran("b9")).status.waiting, ["one", "two"]);
    shown = await ran("cube:background:task_i:lost");
    assert.match(shown.status.error ?? "", /^2 background agents \("one", "two"\) did not finish: .*claude code does not continue them/);
    await bg.close();
  }
  agent = await ClaudeAgent.open({ directory, threadId: "t1", workspace, runtime, model: "sonnet" });
  console.log("ok: background agents: waiting past the idle close, their own turn as a run, a missing turn, stop, close, crash and the time limit as lost runs");

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
  assert.equal(workspacePath(scope.root, "/home/cube/thread/src/../x"), "x");
  assert.equal(workspacePath(scope.root, "/workspace/src/a.ts"), "src/a.ts");
  assert.equal(workspacePath(scope.root, "src//./a.ts"), "src/a.ts");
  assert.equal(workspacePath(scope.root, "/etc/../home/cube/thread/a.ts"), "a.ts");
  // Every other path is one in the thread's machine, normalised there.
  assert.equal(workspacePath(scope.root, "/home/agent/portal-runtime/start-portal.sh"), "/home/agent/portal-runtime/start-portal.sh");
  assert.equal(workspacePath(scope.root, "/home/cube/thread-other/x"), "/home/cube/thread-other/x", "a sibling of the root is not the workspace");
  assert.equal(workspacePath(scope.root, "../../tmp/./x.png"), "/tmp/x.png");
  assert.equal(workspacePath(scope.root, "~/notes.md"), "/home/agent/notes.md");
  assert.equal(workspacePath(scope.root, "/real/cube/thread/src/a.ts", "/real/cube/thread"), "src/a.ts", "the root with its symlinks resolved is the workspace too");
  assert.equal(workspacePath(scope.root, "/real/cube/thread/src/a.ts"), "/real/cube/thread/src/a.ts");
  assert.match(String((workspacePath(scope.root, "/workspace/../cube/artifacts/plan.md") as { deny: string }).deny), /cube keeps artifacts at \/cube\/artifacts/);
  assert.deepEqual(workspacePath(scope.root, "~bob/notes.md"), { deny: "~bob/notes.md: only ~ and ~/ name a home, the agent's (/home/agent)" });
  assert.equal(workspacePath(scope.root, "/workspace/../etc/hosts"), "/etc/hosts");
  assert.deepEqual(workspacePath(scope.root, "/home/cube/thread"), { deny: "/home/cube/thread is the workspace root, not a file" });
  assert.deepEqual(workspacePath(scope.root, "/.."), { deny: "/.. is the machine's root directory, not a file" });
  assert.match(String((await read(scope, { file_path: "/etc/hosts" }) as { deny: string }).deny), /does not exist/, "the machine's /etc/hosts, not the host's");
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
  // Images come back in Read's image shape, whole across pages, or refused.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
  fs.mkdirSync(path.join(files, ".shots"));
  fs.writeFileSync(path.join(files, ".shots/dot.png"), png);
  assert.deepEqual(await read(scope, { file_path: "/home/cube/thread/.shots/dot.png" }), { type: "image", file: { base64: png.toString("base64"), type: "image/png", originalSize: png.length, dimensions: { originalWidth: 1, originalHeight: 1, displayWidth: 1, displayHeight: 1 } } });
  const paged = Buffer.concat([png.subarray(0, -12), crypto.randomBytes(1_500_000), png.subarray(-12)]);
  assert.ok(paged.length > (await client.limits()).maxReadBytes);
  fs.writeFileSync(path.join(files, ".shots/paged.png"), paged);
  assert.equal((await read(scope, { file_path: ".shots/paged.png" }) as { file: { base64: string } }).file.base64, paged.toString("base64"), "an image larger than one read page arrives whole");
  fs.writeFileSync(path.join(files, ".shots/huge.png"), Buffer.concat([png, Buffer.alloc(MAX_IMAGE_BYTES)]));
  assert.match((await read(scope, { file_path: ".shots/huge.png" }) as { deny: string }).deny, /over the \d+ bytes an image may be/);
  fs.writeFileSync(path.join(files, ".shots/cut.png"), png.subarray(0, -5));
  assert.match((await read(scope, { file_path: ".shots/cut.png" }) as { deny: string }).deny, /looks truncated/);
  fs.writeFileSync(path.join(files, ".shots/text.png"), "not a picture\n");
  assert.match((await read(scope, { file_path: ".shots/text.png" }) as { deny: string }).deny, /not a PNG, JPEG, GIF or WebP image/);
  assert.equal((await read(scope, { file_path: "/etc/../home/cube/thread/.shots/dot.png" }) as { type: string }).type, "image");
  const riff = (chunk: string, body: number[]) => Buffer.concat([Buffer.from("RIFF"), Buffer.from([22, 0, 0, 0]), Buffer.from(`WEBP${chunk}`), Buffer.from([10, 0, 0, 0, ...body])]);
  const headers: [string, Buffer, { type: string; width: number; height: number } | null][] = [
    ["png", png, { type: "image/png", width: 1, height: 1 }],
    ["gif", Buffer.from([...Buffer.from("GIF89a"), 3, 0, 2, 0, 0, 0, 0, 0x3b]), { type: "image/gif", width: 3, height: 2 }],
    ["webp lossy", riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x80, 0x02, 0x90, 0x01]), { type: "image/webp", width: 640, height: 400 }],
    ["webp lossless", riff("VP8L", [0x2f, 0, 0, 0, 0, 0, 0, 0, 0, 0]), { type: "image/webp", width: 1, height: 1 }],
    ["webp extended", riff("VP8X", [0, 0, 0, 0, 0x7f, 0x02, 0, 0x8f, 0x01, 0]), { type: "image/webp", width: 640, height: 400 }],
    ["jpeg with fill bytes", Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xff, 0xc2, 0, 0x11, 8, 0, 10, 0, 20, 3, 1, 0x22, 0]), { type: "image/jpeg", width: 20, height: 10 }],
    ["jpeg scan before frame", Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 8, 1, 2, 3, 4, 5, 6, 7]), null],
    ["zero width", Buffer.from([...Buffer.from("GIF87a"), 0, 0, 2, 0]), null],
  ];
  for (const [name, bytes, expected] of headers) {
    assert.deepEqual(imageInfo(bytes), expected, name);
    // A header cut short has no size or its whole one, never a wrong one.
    for (let cut = 0; cut < bytes.length; cut++) {
      const prefix = imageInfo(bytes.subarray(0, cut));
      if (prefix !== null) assert.deepEqual(prefix, expected, `${name} cut at ${cut}`);
    }
  }
  // Outside the workspace: the files of the thread's own machine (here its
  // root, guest.root), read, written and edited by the same tools.
  const script = "/home/agent/portal-runtime/start-portal.sh";
  assert.deepEqual(await write(scope, "t-m1", { file_path: script, content: "#!/bin/sh\nexec node portal.js\n" }),
    { type: "create", filePath: script, content: "#!/bin/sh\nexec node portal.js\n", structuredPatch: [], originalFile: null });
  assert.equal(fs.readFileSync(path.join(guest.root, script), "utf8"), "#!/bin/sh\nexec node portal.js\n");
  assert.equal((await edit(scope, "t-m2", { file_path: script, old_string: "node", new_string: "bun" }) as { originalFile: string }).originalFile, "#!/bin/sh\nexec node portal.js\n");
  assert.equal((await read(scope, { file_path: "~/portal-runtime/start-portal.sh" }) as { file: { content: string } }).file.content, "#!/bin/sh\nexec bun portal.js");
  fs.mkdirSync(path.join(guest.root, "tmp/screens"), { recursive: true });
  fs.writeFileSync(path.join(guest.root, "tmp/screens/shot.png"), png);
  assert.equal((await read(scope, { file_path: "/tmp/screens/shot.png" }) as { file: { base64: string } }).file.base64, png.toString("base64"));
  // Never a file of the host Claude Code runs on, whatever path names it.
  const hostFile = path.join(root, "host-secret.txt");
  fs.writeFileSync(hostFile, "host only");
  assert.match((await read(scope, { file_path: hostFile }) as { deny: string }).deny, /does not exist/);
  assert.equal((await write(scope, "t-m3", { file_path: hostFile, content: "from the thread" }) as { type: string }).type, "create");
  assert.equal(fs.readFileSync(hostFile, "utf8"), "host only", "the host file is untouched");
  assert.equal(fs.readFileSync(path.join(guest.root, hostFile), "utf8"), "from the thread", "the machine got its own file");
  fs.symlinkSync(import.meta.dirname, path.join(guest.root, "tmp/host-link"));
  assert.match((await read(scope, { file_path: "/tmp/host-link/claude-agent-test.ts" }) as { deny: string }).deny, /leaves the machine/, "a link out of the machine leads nowhere");
  assert.match((await read(scope, { file_path: "/proc/self/environ" }) as { deny: string }).deny, /kernel or device filesystem/);
  assert.match((await bash({ ...scope, token: "f".repeat(64) }, "t-b3", { command: "true" }) as { deny: string }).deny, /no longer holds the thread workspace/);
  assert.match((await read({ ...scope, token: "f".repeat(64) }, { file_path: script }) as { deny: string }).deny, /no longer holds the thread workspace/, "another lease's token reaches no machine path");
  const aborting = new AbortController();
  const slow = bash({ ...scope, signal: aborting.signal }, "t-b4", { command: "sleep 3; touch late-2" });
  await delay(300);
  aborting.abort();
  assert.deepEqual(await slow, { stdout: "", stderr: "command stopped", interrupted: true });
  await delay(3200);
  assert.ok(!fs.existsSync(path.join(files, "late-2")), "an abandoned Bash call cancels its guest command");
  console.log("ok: claude mod tools over the workspace socket: path mapping, machine paths outside the workspace, never host files, write/edit with sha, images, refusals, keyed replay, conflict, cancel on abort");

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
  guest.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
