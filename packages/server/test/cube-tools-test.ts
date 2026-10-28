/** cube's tools (cube-tools.ts) through both adapters, over a real artifact
 * store and real workspace leases, with a fake registry: Pi's (`piTool`,
 * its input checked by Pi's own validator as the harness does) and Claude
 * Code's (the mod's `cubeTool` over a WorkspaceClient whose transport is
 * cubed's `toolsRoute`). The same script gives the same text on both,
 * invalid input is refused before anything is written, a repeated call
 * writes once, a long artifact pages and is edited on the revision read;
 * the route takes only the Claude Code child's lease, and an abandoned call
 * writes nothing. No network. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai/utils/validation";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { CUBE_TOOL_PREFIX, cubeTool, type ToolScope } from "../../claude-mod/hooks/tools.ts";
import { WorkspaceClient } from "../../claude-mod/hooks/workspace.ts";
import { Artifacts } from "../src/artifact-service.ts";
import { ARTIFACT_READ_CHARS, artifactTools } from "../src/artifact-tools.ts";
import { ArtifactStore, type ArtifactAuthor } from "../src/artifacts.ts";
import { manifest, piTool, toolsRoute, type CubeTool } from "../src/cube-tools.ts";
import type { GithubPulls } from "../src/github-pulls.ts";
import type { Registry } from "../src/registry.ts";
import { LeaseStore } from "../src/workspace-lease.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-tools-"));
const projects = [{ id: "p", name: "terra", repositories: [{ url: "https://github.com/cubeyard/demo" }] }, { id: "q", name: "luna", repositories: [] }];
const PI = "eb809312-0000-4000-8000-000000000002", CLAUDE = "eb809312-0000-4000-8000-000000000003", OUTSIDER = "eb809312-0000-4000-8000-000000000004";
const registry = {
  getThread: (id: string) => [PI, CLAUDE, OUTSIDER].includes(id) ? { id, projectId: id === OUTSIDER ? "q" : "p", archived: false, createdAt: 0 } : null,
  getProject: (id: string) => projects.find(project => project.id === id) ?? null,
  listProjects: () => projects,
} as unknown as Registry;
const github = { async pull() { throw new Error("no network") }, async merge() { throw new Error("no network") } } as unknown as GithubPulls;
const store = new ArtifactStore(path.join(root, "artifacts.sqlite"));
const artifacts = new Artifacts({ store, registry, github, optchat: async () => null, submit: async () => {} });
const thread = (id: string): ArtifactAuthor => ({ kind: "thread", thread: id });
const files: Record<string, string> = { "notes.md": "# notes\n\nfrom a file" };
/** A thread's tools as index.ts builds them, for either agent. */
const toolsOf = (id: string, agent: "pi" | "claude-code"): CubeTool[] => artifactTools({ artifacts, author: thread(id), agent, readable: async () => [thread(id)],
  readFile: async file => { if (!(file in files)) throw new Error(`no file ${file}`); return { text: files[file]!, path: `/workspace/${file}`, sha256: "0".repeat(64) }; } });

/** Pi: the harness checks the input with Pi's validator, then runs the tool; `task` is the durable task (its replay key). */
let calls = 0;
const pi = (id: string) => async (name: string, input: Record<string, unknown>, task = `task-${++calls}`, signal?: AbortSignal): Promise<string> => {
  const tool = toolsOf(id, "pi").find(candidate => candidate.name === name);
  if (!tool) return `unknown tool ${name}`;
  const registration = piTool(tool, api => `pi:test:${api.taskId}`);
  let args: Record<string, unknown>;
  try { args = validateToolArguments(registration as never, { type: "toolCall", id: task, name, arguments: input as never }); }
  catch (error) { return `invalid: ${(error as Error).message}`; }
  const result = await registration.execute(args as never, { callId: `call-${task}`, taskId: task } as unknown as ToolExecutionApi, { abortSignal: signal } as never)
    .catch((error: Error) => ({ output: [{ text: `tool error: ${error.message}` }] }));
  return (result as { output: Array<{ text: string }> }).output.map(part => part.text).join("");
};

/** Claude Code: the mod's forwarder over a client whose transport is cubed's route. */
const leases = new LeaseStore(path.join(root, "claude-lease"));
const claudeLease = leases.acquire("claude-code");
const lease = (store: LeaseStore) => async (token: string) => { try { return store.renew(token); } catch { return null; } };
const route = (id: string, held: LeaseStore, signal = new AbortController().signal) => async (request: { method: string; path: string; headers: Record<string, string>; body?: string }) => {
  const name = /\/tools\/([^/]+)$/.exec(request.path)?.[1];
  // As index.ts: a tool's fault is the request's, 409 with its message.
  const result = await toolsRoute({ method: request.method, name: name === undefined ? undefined : decodeURIComponent(name),
    token: /^Bearer (\S+)$/.exec(request.headers.authorization ?? "")?.[1], body: request.body ? JSON.parse(request.body) : {}, signal },
  lease(held), () => toolsOf(id, "claude-code")).catch((error: Error) => ({ status: 409, body: { error: error.message, code: "IO_ERROR", completionUnknown: false } }));
  return { status: result.status, text: JSON.stringify(result.body) };
};
const claude = (id: string, token = claudeLease.token, held = leases) => async (name: string, input: Record<string, unknown>, call = `toolu_${++calls}`, signal?: AbortSignal): Promise<string> => {
  const scope: ToolScope = { client: new WorkspaceClient({ base: `/api/threads/${id}/workspace`, transport: route(id, held) }), token, root: "/workspace", ...signal ? { signal } : {} };
  const result = await cubeTool(scope, call, `${CUBE_TOOL_PREFIX}${name}`, input);
  return typeof result === "string" ? result : `denied: ${result.deny}`;
};

/** One agent's words with what differs by agent alone taken out: ids and thread names. */
const same = (text: string, id: string) => text.replaceAll(id, "<id>").replaceAll(id.slice(0, 8), "<id>").replace(/thread \[[0-9a-f]{8}\]/g, "thread [x]");
const idIn = (text: string) => /^artifact ([0-9a-f-]{36}) /.exec(text)?.[1] ?? assert.fail(`no artifact in: ${text}`);

try {
  // ---- the manifest: what the mod registers is each tool's own schema ----
  const listed = manifest(toolsOf(CLAUDE, "claude-code"));
  assert.deepEqual(listed.map(tool => tool.name), ["artifact_write", "artifact_read", "artifact_edit"]);
  for (const [index, tool] of toolsOf(CLAUDE, "claude-code").entries()) {
    assert.deepEqual(listed[index]!.inputSchema, JSON.parse(JSON.stringify(tool.parameters)), `${tool.name}: the schema as Pi has it`);
    assert.equal(listed[index]!.isDeferred, false);
    assert.ok(listed[index]!.description.length <= 4096, `${tool.name}: Claude Code shows at most 4096 characters of an upfront tool`);
  }
  assert.throws(() => manifest([{ ...toolsOf(CLAUDE, "claude-code")[0]!, name: "Artifact-Write" }]), /cannot be offered/);

  // ---- parity: one script, both adapters, the same words ----
  const viaPi = pi(PI), viaClaude = claude(CLAUDE);
  const script = (id: string): Array<[string, Record<string, unknown>]> => [
    ["artifact_read", { id, offset: 2, limit: 1 }],
    ["artifact_edit", { id, old_string: "two", new_string: "2" }],
    ["artifact_edit", { id, old_string: "zzz", new_string: "x" }],
    ["artifact_edit", { id, old_string: "", new_string: "x" }],
    ["artifact_write", { id, base: 1, body: "# parity\n\nlate" }],
    ["artifact_write", { id, body: "# parity\n\n```mermaid\nnot a diagram\n```" }],
    ["artifact_read", { id, offset: 99 }],
    ["artifact_read", { id }],
    ["artifact_write", { id, path: "notes.md" }],
    ["artifact_read", { id: "eb809312-0000-4000-8000-00000000ffff" }],
  ];
  const created = { pi: await viaPi("artifact_write", { body: "# parity\n\none\ntwo\nthree" }), claude: await viaClaude("artifact_write", { body: "# parity\n\none\ntwo\nthree" }) };
  const ids = { pi: idIn(created.pi), claude: idIn(created.claude) };
  assert.equal(same(created.pi, ids.pi), same(created.claude, ids.claude));
  assert.match(created.claude, /created at revision 1\. The user opens it at #\/a\//);
  const piScript = script(ids.pi), claudeScript = script(ids.claude);
  for (let step = 0; step < piScript.length; step++) {
    const [name, input] = piScript[step]!;
    const said = { pi: same(await viaPi(name, input), ids.pi), claude: same(await viaClaude(name, claudeScript[step]![1]), ids.claude) };
    assert.equal(said.claude, said.pi, `step ${step}: ${name} ${JSON.stringify(input)}`);
  }
  // A fault (no such file) fails the call on both, with the same words.
  assert.equal(await viaPi("artifact_write", { id: ids.pi, path: "missing.md" }), "tool error: no file missing.md");
  assert.equal(await viaClaude("artifact_write", { id: ids.claude, path: "missing.md" }), "denied: artifact_write: no file missing.md");
  assert.equal(store.get(ids.pi)!.head, 3, "revisions 2 (edit) and 3 (from a file)");
  assert.equal(store.get(ids.claude)!.head, 3);
  assert.deepEqual(store.revision(ids.claude, 3)!.provenance.source, { path: "/workspace/notes.md", sha256: "0".repeat(64) }, "Claude Code writes a body from a machine file too");
  assert.deepEqual([store.revision(ids.pi, 2)!.provenance.agent, store.revision(ids.claude, 2)!.provenance.agent], ["pi", "claude-code"]);

  // Invalid input: refused by the same validator, before anything is written.
  for (const [name, input, why] of [
    ["artifact_write", { id: ids.pi, base: "one", body: "# x" }, /base: must be integer/],
    ["artifact_edit", { id: ids.pi }, /must have required properties old_string, new_string/],
    ["artifact_read", { id: ids.pi, revision: 0 }, /revision: must be >= 1/],
    ["artifact_write", { body: "# x", actions: [{ kind: "shell", command: "rm -rf /" }] }, /actions\.0\.kind: must be equal to constant/],
  ] as const) {
    const onPi = await viaPi(name, input), onClaude = await viaClaude(name, { ...input, ...input.id ? { id: ids.claude } : {} });
    assert.match(onPi, why, `pi ${name}`);
    const validator = (text: string) => text.slice(text.indexOf("Validation failed"));
    assert.equal(validator(same(onClaude, ids.claude)), validator(same(onPi, ids.pi)), `the same refusal: ${name}`);
    assert.match(onClaude, /^denied: artifact_\w+: Validation failed/);
  }
  assert.equal(store.get(ids.pi)!.head, 3);
  assert.equal(store.get(ids.claude)!.head, 3, "nothing written by an invalid call");

  // A repeated call (a Pi replay of its task, a Claude Code call by the same tool_use_id) writes once.
  const editTwice = { id: ids.claude, old_string: "from a file", new_string: "from the file" };
  const first = await viaClaude("artifact_edit", editTwice, "toolu_same");
  assert.match(first, /wrote revision 4\./);
  assert.equal(await viaClaude("artifact_edit", editTwice, "toolu_same"), first);
  assert.equal(store.get(ids.claude)!.head, 4);
  const piTwice = { id: ids.pi, old_string: "from a file", new_string: "from the file" };
  assert.equal(await viaPi("artifact_edit", piTwice, "task-same"), await viaPi("artifact_edit", piTwice, "task-same"));
  assert.equal(store.get(ids.pi)!.head, 4);
  const writeTwice = { body: "# once\n\nonly once" };
  assert.equal(idIn(await viaClaude("artifact_write", writeTwice, "toolu_new")), idIn(await viaClaude("artifact_write", writeTwice, "toolu_new")), "a create is not repeated either");

  // Projects stay apart: another project's thread finds nothing, on either adapter.
  assert.equal(await claude(OUTSIDER)("artifact_read", { id: ids.claude }), `no artifact ${ids.claude} you can read`);
  assert.equal(await pi(OUTSIDER)("artifact_edit", { id: ids.pi, old_string: "one", new_string: "1" }), `not written: no artifact ${ids.pi} you can read`);

  // ---- a long artifact pages, and an edit lands on the revision read ----
  const line = (index: number) => `- step ${index}: ${"berth keel phase detail ".repeat(5)}`.slice(0, 145).padEnd(145, ".");
  const body = ["# masterplan", "", ...Array.from({ length: 860 }, (_, index) => line(index))].join("\n");
  assert.ok(body.length > ARTIFACT_READ_CHARS);
  const plan = idIn(await viaPi("artifact_write", { body }));
  const window = await viaClaude("artifact_read", { id: plan, offset: 796, limit: 20 });
  assert.match(window, new RegExp(`^- step ${796 - 1 - 6}: `), "line 796 of the text (header lines first)");
  const total = body.split("\n").length + 4;
  assert.match(window, new RegExp(`\\[lines 796-815 of ${total}; artifact_read with offset 816 for the rest\\. artifact_write replaces the whole document`));
  const whole = await viaClaude("artifact_read", { id: plan });
  assert.ok(whole.length <= ARTIFACT_READ_CHARS + 300, `${whole.length}`);
  const next = Number(/artifact_read with offset (\d+) for the rest/.exec(whole)?.[1]);
  const tail = await viaPi("artifact_read", { id: plan, offset: next });
  assert.ok(tail.endsWith(line(859)), "the last line is reachable");
  assert.equal(await viaPi("artifact_read", { id: plan }), whole, "Pi pages the same");
  assert.match(await viaClaude("artifact_edit", { id: plan, old_string: "- step 800: ", new_string: "- step 800 (done): " }), /wrote revision 2\. .*it stays thread \[eb809312\]'s artifact/);
  await viaPi("artifact_read", { id: plan, offset: 1, limit: 3 });
  assert.match(await viaPi("artifact_edit", { id: plan, old_string: "- step 10: ", new_string: "- step 10 (author): " }), /wrote revision 3\./);
  assert.match(await viaClaude("artifact_edit", { id: plan, old_string: "- step 801: ", new_string: "x" }), /^not written: revision 3 \(by thread \[eb809312\]\) is newer than revision 2 you read; read the part you change again/);
  await viaClaude("artifact_read", { id: plan, offset: 800, limit: 2 });
  assert.match(await viaClaude("artifact_edit", { id: plan, old_string: "berth keel", new_string: "x" }), /Found \d+ matches of the string to replace, but replace_all is false/);
  assert.equal(store.get(plan)!.head, 3);

  // A line over ARTIFACT_READ_CHARS is shown in parts, every part reachable and said to be one.
  const long = `# t\n${"x".repeat(130_000)}END\nlast`;
  const wide = idIn(await viaPi("artifact_write", { body: long }));
  const head = await viaClaude("artifact_read", { id: wide });
  assert.match(head, /\n# t\n\[lines 1-5 of 8; artifact_read with offset 6 for the rest\./, "the first page stops before the long line");
  const part1 = await viaClaude("artifact_read", { id: wide, offset: 6 });
  assert.equal(part1, `${"x".repeat(ARTIFACT_READ_CHARS)}\n[line 6 goes on in line 7 without a line break: a line over ${ARTIFACT_READ_CHARS} characters is shown in parts; join them when you write the document]\n`
    + `[lines 6-6 of 8; artifact_read with offset 7 for the rest. artifact_write replaces the whole document, so read all of it before writing it, or change a part with artifact_edit]`);
  const part2 = await viaPi("artifact_read", { id: wide, offset: 7 });
  assert.equal(part2, `${"x".repeat(10_000)}END\nlast`, "the rest of the line, END included, then the next line");
  assert.equal(`${part1.split("\n")[0]}${part2}`, long.split("\n").slice(1).join("\n"), "the parts joined are the text");
  assert.equal(await viaPi("artifact_read", { id: wide, offset: 6 }), part1, "Pi reads it the same");
  const exact = idIn(await viaClaude("artifact_write", { body: `# e\n${"y".repeat(ARTIFACT_READ_CHARS)}` }));
  assert.equal(await viaClaude("artifact_read", { id: exact, offset: 6 }), "y".repeat(ARTIFACT_READ_CHARS), "a line of exactly the limit is whole, with no note");

  // ---- the route: only the Claude Code child's lease, only cube's tools ----
  const raw = (token: string | undefined, method: string, name?: string, body: Record<string, unknown> = {}, held = leases) =>
    toolsRoute({ method, name, token, body, signal: new AbortController().signal }, lease(held), () => toolsOf(CLAUDE, "claude-code"));
  assert.deepEqual(await raw(undefined, "GET"), { status: 401, body: { error: "workspace lease token required", code: "LEASE_STALE", completionUnknown: false } });
  assert.equal((await raw("0".repeat(64), "GET")).status, 401, "a token that is not the lease's");
  const piLeases = new LeaseStore(path.join(root, "pi-lease"));
  const piLease = piLeases.acquire("pi");
  assert.deepEqual(await raw(piLease.token, "GET", undefined, {}, piLeases), { status: 403, body: { error: "these tools are for claude code threads", code: "WRONG_NODE", completionUnknown: false } });
  assert.equal(await claude(PI, piLease.token, piLeases)("artifact_read", {}), "denied: artifact_read: these tools are for claude code threads");
  assert.equal((await raw(claudeLease.token, "GET")).status, 200);
  assert.equal((await raw(claudeLease.token, "POST", "artifact_delete", { call: "toolu_x", input: {} })).status, 404, "a tool cubed does not offer");
  assert.equal(await viaClaude("artifact_delete", { id: ids.claude }), "denied: artifact_delete: no cube tool artifact_delete");
  assert.equal((await raw(claudeLease.token, "POST", "artifact_read", { input: {} })).status, 400, "a call needs its tool_use_id");
  assert.equal((await raw(claudeLease.token, "GET", "artifact_read")).status, 404);
  const before = store.list({ authors: [thread(CLAUDE)] }).length;
  leases.release(claudeLease.token);
  assert.equal(await viaClaude("artifact_write", { body: "# late" }), "denied: this Claude Code session no longer holds the thread workspace; cube stopped it or another owner took over");
  assert.equal(store.list({ authors: [thread(CLAUDE)] }).length, before, "a released lease writes nothing");
  const again = leases.acquire("claude-code");

  // ---- an abandoned call writes nothing; the mod stops waiting at once ----
  const stopped = new AbortController();
  stopped.abort();
  assert.equal(await pi(PI)("artifact_write", { body: "# stopped" }, "task-stopped", stopped.signal), "not written: the call was stopped");
  const abandoned = await toolsRoute({ method: "POST", name: "artifact_write", token: again.token, body: { call: "toolu_gone", input: { body: "# stopped" } }, signal: stopped.signal },
    lease(leases), () => toolsOf(CLAUDE, "claude-code"));
  assert.deepEqual(abandoned, { status: 200, body: { text: "not written: the call was stopped" } });
  const hanging: ToolScope = { client: new WorkspaceClient({ base: "/x", transport: () => new Promise(() => {}) }), token: again.token, root: "/workspace", signal: stopped.signal };
  assert.deepEqual(await cubeTool(hanging, "toolu_hang", `${CUBE_TOOL_PREFIX}artifact_write`, { body: "# x" }), { deny: "artifact_write was stopped; it may have written, so read before writing again" });
  assert.equal(store.list({ authors: [thread(PI)] }).filter(item => item.title === "stopped").length, 0);
  assert.equal(store.list({ authors: [thread(CLAUDE)] }).filter(item => item.title === "stopped").length, 0);
  piLeases.close();
  console.log("ok: cube tools say the same through Pi and Claude Code, refuse invalid input alike, write once per call, page and edit long artifacts, and admit only the Claude Code child's lease");
} finally {
  leases.close();
  artifacts.close();
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
