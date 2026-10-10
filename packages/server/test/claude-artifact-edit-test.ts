/** A Claude Code thread revising a large artifact through the mod's Read
 * and Edit, over a real store with a fake registry, the client answering as
 * cubed's /artifacts route does: Read pages the whole text with offset and
 * limit and says when it shows only part, so no tail is out of reach; Edit
 * writes a revision on the one the agent last read, refused when another is
 * newer, once per tool call, keeping the author and the actions. No network. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ARTIFACT_READ_CHARS, editArtifact, readArtifact, type ToolScope } from "../../claude-mod/hooks/tools.ts";
import { WorkspaceClientError } from "../../claude-mod/hooks/workspace.ts";
import { Artifacts } from "../src/artifact-service.ts";
import { ArtifactError, ArtifactStore, type ArtifactAuthor } from "../src/artifacts.ts";
import type { GithubPulls } from "../src/github-pulls.ts";
import type { Registry } from "../src/registry.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-claude-artifact-edit-"));
const projects = [{ id: "p", name: "terra", repositories: [{ url: "https://github.com/cubeyard/demo" }] }, { id: "q", name: "luna", repositories: [] }];
const AUTHOR = "eb809312-0000-4000-8000-000000000002", REVIEWER = "eb809312-0000-4000-8000-000000000003", NEWCOMER = "eb809312-0000-4000-8000-000000000005", OUTSIDER = "eb809312-0000-4000-8000-000000000004";
const registry = {
  getThread: (id: string) => [AUTHOR, REVIEWER, NEWCOMER, OUTSIDER].includes(id) ? { id, projectId: id === OUTSIDER ? "q" : "p", archived: false, createdAt: 0 } : null,
  getProject: (id: string) => projects.find(project => project.id === id) ?? null,
  listProjects: () => projects,
} as unknown as Registry;
const github = { async pull() { throw new Error("no network") }, async merge() { throw new Error("no network") } } as unknown as GithubPulls;
const store = new ArtifactStore(path.join(root, "artifacts.sqlite"));
const artifacts = new Artifacts({ store, registry, github, optchat: async () => null, submit: async () => {} });
const thread = (id: string): ArtifactAuthor => ({ kind: "thread", thread: id });

/** The mod's tools for one thread, its client answering as index.ts's route. */
function claude(id: string): ToolScope {
  const scope = { agent: thread(id), authors: [thread(id)] };
  const provenance = { agent: "claude-code" as const, thread: id };
  const answer = <T>(run: () => T): T => {
    try { return run(); } catch (error) {
      if (error instanceof ArtifactError) throw new WorkspaceClientError(error.status === 404 ? "NOT_FOUND" : "INVALID_REQUEST", error.message);
      throw error;
    }
  };
  const client = {
    artifact: async (_token: string, name?: string) => answer(() => ({ text: artifacts.read(scope, name, undefined, { whole: true }) })),
    editArtifact: async (_token: string, request: { name: string; requestId: string; edit: { oldString: string; newString: string; replaceAll: boolean } }) =>
      answer(() => artifacts.edit(scope, { id: request.name, ...request.edit }, provenance, request.requestId)),
  };
  return { client: client as never, token: "t", root: "/workspace" };
}

// A masterplan past the old 120,000-character cut: 862 lines, 125,573 characters.
const line = (index: number) => `- step ${index}: ${"berth keel phase detail ".repeat(5)}`.slice(0, 145).padEnd(145, ".");
const body = ["# masterplan", "", ...Array.from({ length: 860 }, (_, index) => line(index))].join("\n");
assert.ok(body.length > 125_000);
const action = { kind: "github.merge", repository: "cubeyard/demo", pull: 7, headSha: "a".repeat(40), method: "squash" };
const id = artifacts.write({ agent: thread(AUTHOR), authors: [thread(AUTHOR)] }, { name: "masterplan", body, actions: [action] }, { agent: "claude-code", thread: AUTHOR }, "w-1").id;
const file = `/cube/artifacts/${id}.md`;
const target = { kind: "md" as const, name: id };
const reviewer = claude(REVIEWER);
const read = async (scope: ToolScope, input: { offset?: number; limit?: number } = {}) => {
  const result = await readArtifact(scope, target, { file_path: file, ...input });
  assert.ok(!("deny" in result), JSON.stringify(result));
  return (result as { file: { content: string; startLine: number; numLines: number; totalLines: number } }).file;
};
const edit = (scope: ToolScope, call: string, old_string: string, new_string: string, replace_all?: boolean) =>
  editArtifact(scope, call, target, { file_path: file, old_string, new_string, ...replace_all === undefined ? {} : { replace_all } });
const refusal = (result: unknown) => (result as { deny?: string }).deny ?? "";

try {
  // Read pages: an offset and limit are a window, not the whole document.
  const window = await read(reviewer, { offset: 796, limit: 20 });
  assert.equal(window.startLine, 796);
  assert.equal(window.numLines, 20);
  const total = window.totalLines;
  assert.match(window.content, new RegExp(`^- step ${796 - 1 - 6}: `), "line 796 of the text (header lines first)");
  assert.match(window.content, new RegExp(`\\[lines 796-815 of ${total}; Read with offset 816 for the rest\\. Write replaces the whole document`));
  assert.ok(window.content.length < 3_200, `a 20-line window is small: ${window.content.length}`);
  // Without a window, at most ARTIFACT_READ_CHARS, cut at a line and saying where the rest starts.
  const first = await read(reviewer);
  assert.ok(first.content.length <= ARTIFACT_READ_CHARS + 300, `${first.content.length}`);
  assert.match(first.content, /^artifact .* · revision 1 of 1 · by thread \[eb809312\] · project terra/);
  const next = Number(/Read with offset (\d+) for the rest/.exec(first.content)?.[1]);
  assert.equal(next, first.numLines + 1);
  const tail = await read(reviewer, { offset: next });
  assert.ok(tail.content.endsWith(line(859)), "the last line is reachable");
  assert.doesNotMatch(tail.content, /\[lines|cut at/, "the rest is whole");
  assert.equal(first.numLines + tail.numLines, total, "the two pages are the whole text");
  assert.match((await read(reviewer, { offset: total + 5 })).content, new RegExp(`^\\[the artifact has ${total} lines`));

  // Edit: one line changes, as a new revision by the reviewer; the author and actions stay.
  const done = await edit(reviewer, "toolu_1", "- step 800: ", "- step 800 (done): ");
  assert.ok(!("deny" in done), refusal(done));
  const head = store.get(id)!;
  assert.equal(head.head, 2);
  assert.deepEqual(head.author, thread(AUTHOR), "the author stays the one comments go to");
  const second = store.revision(id, 2)!;
  assert.equal(second.body, body.replace("- step 800: ", "- step 800 (done): "));
  assert.deepEqual(second.editor, thread(REVIEWER));
  assert.deepEqual(second.actions, store.revision(id, 1)!.actions, "actions kept exactly");
  assert.equal(second.title, "masterplan");
  // The same tool call again is the same revision, not a second one or a not-found.
  assert.ok(!("deny" in await edit(reviewer, "toolu_1", "- step 800: ", "- step 800 (done): ")));
  assert.equal(store.get(id)!.head, 2);

  // The author writes revision 3 meanwhile: the reviewer's next Edit is refused, nothing lost.
  const author = claude(AUTHOR);
  await read(author, { offset: 1, limit: 5 });
  assert.ok(!("deny" in await edit(author, "toolu_2", "- step 10: ", "- step 10 (author): ")));
  const stale = await edit(reviewer, "toolu_3", "- step 801: ", "- step 801 (done): ");
  assert.match(refusal(stale), /revision 3 \(by thread \[eb809312\]\) is newer than revision 2 you read; Read the part you change again and redo the Edit/);
  assert.equal(store.get(id)!.head, 3);
  // Read again (a window is enough), then the Edit lands on revision 3 with both changes.
  await read(reviewer, { offset: 800, limit: 5 });
  assert.ok(!("deny" in await edit(reviewer, "toolu_4", "- step 801: ", "- step 801 (done): ")));
  const fourth = store.revision(id, 4)!;
  assert.match(fourth.body, /- step 10 \(author\): /);
  assert.match(fourth.body, /- step 800 \(done\): /);
  assert.match(fourth.body, /- step 801 \(done\): /);

  // Edit refuses what it cannot do exactly, writing nothing.
  assert.match(refusal(await edit(reviewer, "toolu_5", "- step 9999: ", "x")), /String to replace not found in revision 4/);
  assert.match(refusal(await edit(reviewer, "toolu_6", "berth keel", "x")), /Found \d+ matches of the string to replace, but replace_all is false/);
  assert.match(refusal(await edit(reviewer, "toolu_7", "", "x")), /old_string is empty/);
  assert.match(refusal(await editArtifact(reviewer, "toolu_8", { kind: "json", name: id }, { file_path: `/cube/artifacts/${id}.json`, old_string: "a", new_string: "b" })), /Edit reaches/);
  assert.equal(store.get(id)!.head, 4);
  // A thread that has never read it is refused; one of another project finds no artifact at all.
  assert.match(refusal(await edit(claude(NEWCOMER), "toolu_10", "- step 1: ", "x")), /revision 4 of artifact .* was written by thread \[eb809312\]; Read it first, then Edit it/);
  const fresh = claude(OUTSIDER);
  assert.match(refusal(await edit(fresh, "toolu_9", "- step 1: ", "x")), /File does not exist|no artifact/);
  assert.match(refusal(await readArtifact(fresh, target, { file_path: file })), /File does not exist|no artifact/);
  assert.equal(store.get(id)!.head, 4);
  console.log(`ok: a ${body.length}-character artifact pages by offset and limit (a 20-line window is ${window.content.length} characters, was 120,272), and Edit revises it on the newest revision read`);
} finally {
  artifacts.close();
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
