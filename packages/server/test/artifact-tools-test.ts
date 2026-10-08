/** `artifact_write` as the two Pi adapters build it (a thread's, with path,
 * and OptChat's, with project) over a real store with a fake registry: a
 * blank id, path or body counts as left out, as models often send them, so
 * creating still creates; a real body with a real path is still refused;
 * a nonempty id still only revises the caller's own artifact. No network. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { Artifacts } from "../src/artifact-service.ts";
import { ArtifactStore, type ArtifactAuthor } from "../src/artifacts.ts";
import { artifactTools } from "../src/artifact-tools.ts";
import type { GithubPulls } from "../src/github-pulls.ts";
import type { Registry } from "../src/registry.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-artifact-tools-"));
const project = { id: "p", name: "terra", repositories: [{ url: "https://github.com/cubeyard/demo" }] };
const THREAD = "eb809312-0000-4000-8000-000000000002", OTHER = "eb809312-0000-4000-8000-000000000003";
const registry = {
  getThread: (id: string) => id === THREAD || id === OTHER ? { id, projectId: "p", archived: false, createdAt: 0 } : null,
  getProject: (id: string) => id === project.id ? project : null,
  listProjects: () => [project],
} as unknown as Registry;
const github = { async pull() { throw new Error("no network") }, async merge() { throw new Error("no network") } } as unknown as GithubPulls;
const store = new ArtifactStore(path.join(root, "artifacts.sqlite"));
const artifacts = new Artifacts({ store, registry, github, optchat: async () => null, submit: async () => {} });
const files: Record<string, string> = { "notes.md": "# notes\n\nfrom a file" };
const reads: string[] = [];

let calls = 0;
const adapter = (author: ArtifactAuthor, thread: boolean) => {
  const [write] = artifactTools({
    artifacts, author, agent: thread ? "pi" : "optchat", readable: async () => [author], key: api => `req-${api.callId}`,
    ...thread ? { readFile: async (file: string) => {
      reads.push(file);
      if (!(file in files)) throw new Error(`no file ${file}`);
      return { text: files[file]!, path: file, sha256: "0".repeat(64) };
    } } : { projects: true },
  }) as [ToolRegistration];
  return async (args: Record<string, unknown>) => {
    const result = await write.execute(args as never, { callId: `c${++calls}` } as unknown as ToolExecutionApi, {} as never);
    return (result as { content: Array<{ text: string }> }).content.map(part => part.text).join("");
  };
};
const created = (said: string) => {
  const match = /^artifact ([0-9a-f-]{36}) ".*" created at revision 1\./.exec(said);
  assert.ok(match, `created: ${said}`);
  return match[1]!;
};

const thread = adapter({ kind: "thread", thread: THREAD }, true);
const other = adapter({ kind: "thread", thread: OTHER }, true);
const optchat = adapter({ kind: "optchat" }, false);

try {
  // The reported calls: a thread's path:"" with body, OptChat's id:"" with body.
  const fromThread = created(await thread({ path: "", body: "# review\n\nok" }));
  assert.equal(store.revision(fromThread, 1)!.body, "# review\n\nok");
  assert.equal(store.revision(fromThread, 1)!.provenance.source, undefined, "no file was read");
  const fromChat = created(await optchat({ id: "", body: "# plan\n\none" }));
  assert.equal(store.get(fromChat)!.author.kind, "optchat");

  // Omitted and blank ids and paths create alike, in both adapters.
  for (const args of [{}, { id: "" }, { id: "  " }, { path: "" }, { path: " " }, { id: "", path: "" }]) {
    created(await thread({ ...args, body: "# t" }));
  }
  for (const args of [{}, { id: "" }, { id: " " }, { path: "" }, { id: "", path: "", project: "" }]) {
    created(await optchat({ ...args, body: "# o" }));
  }
  // A real path with a blank body reads the file.
  reads.length = 0;
  for (const body of [undefined, "", "  "]) {
    const id = created(await thread({ id: "", path: "notes.md", ...body === undefined ? {} : { body } }));
    assert.equal(store.revision(id, 1)!.body, files["notes.md"]);
    assert.deepEqual(store.revision(id, 1)!.provenance.source, { path: "notes.md", sha256: "0".repeat(64) });
  }
  assert.deepEqual(reads, ["notes.md", "notes.md", "notes.md"]);

  // A real body with a real path is still ambiguous, and nothing is read or written.
  reads.length = 0;
  const before = store.list({ authors: [{ kind: "thread", thread: THREAD }] }).length;
  assert.equal(await thread({ path: "notes.md", body: "# x" }), "not written: give body or path, not both");
  assert.equal(await thread({ id: "", path: "notes.md", body: "# x" }), "not written: give body or path, not both");
  assert.deepEqual(reads, [], "a refused write reads no file");
  // OptChat has no workspace: a real path is refused there, a blank one ignored.
  assert.equal(await optchat({ path: "notes.md" }), "not written: path is not available here");
  // Nothing to write is still an error, blanks or not.
  assert.equal(await thread({}), "not written: body (or path) is required");
  assert.equal(await thread({ id: "", path: "" }), "not written: body (or path) is required");
  assert.equal(await optchat({ id: "" }), "not written: body (or path) is required");
  assert.equal(await optchat({ id: "", body: "" }), "not written: body (or path) is required");
  assert.equal(await thread({ body: " ", path: "" }), "not written: body (or path) is required");
  files["empty.md"] = "\n";
  assert.equal(await thread({ path: "empty.md" }), "not written: empty.md is empty");
  assert.equal(store.list({ authors: [{ kind: "thread", thread: THREAD }] }).length, before);

  // A nonempty id revises only the caller's own artifact.
  assert.match(await thread({ id: fromThread, body: "# review\n\ntwo" }), /^artifact .* wrote revision 2\./);
  assert.match(await thread({ id: fromThread, path: "", body: "# review\n\nthree" }), /wrote revision 3\./);
  assert.match(await thread({ id: fromThread, path: "notes.md" }), /wrote revision 4\./);
  assert.match(await optchat({ id: fromChat, body: "# plan\n\ntwo" }), /wrote revision 2\./);
  assert.equal(await other({ id: fromThread, body: "# mine" }), `not written: no artifact ${fromThread} of yours`);
  assert.equal(await optchat({ id: fromThread, body: "# mine" }), `not written: no artifact ${fromThread} of yours`);
  assert.equal(await thread({ id: fromChat, body: "# mine" }), `not written: no artifact ${fromChat} of yours`);
  assert.equal(await thread({ id: "not-an-id", body: "# x" }), "not written: no artifact not-an-id of yours");
  assert.equal(store.get(fromThread)!.head, 4);
  assert.equal(store.get(fromChat)!.head, 2);

  // The service itself treats a blank id as none, for any caller.
  const direct = artifacts.write({ kind: "optchat" }, { id: "", body: "# direct" }, { agent: "optchat" }, "direct-1");
  assert.equal(direct.revision, 1);
  assert.equal(store.get(direct.id)!.author.kind, "optchat");
  console.log("artifact tools: ok");
} finally {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
