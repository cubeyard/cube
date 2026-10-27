/** An artifact's ```mermaid diagrams are checked with Pele before a
 * revision is written: the fences found as the page finds them, every
 * problem told with where it is and Pele's own words, a body that does not
 * draw refused before anything is written (no new artifact, no revision,
 * the newest valid revision left as it was), a replayed call still answered,
 * and the check bounded by count, size and a deadline. Over a real store
 * with a fake registry; Pele runs locally, no network. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Artifacts, type ArtifactScope } from "../src/artifact-service.ts";
import { checkDiagrams, DIAGRAM_CHARS, DIAGRAM_EDGES, DIAGRAMS_PER_BODY, diagramProblemsText, mermaidFences } from "../src/artifact-diagrams.ts";
import { ArtifactError, ArtifactStore, type ArtifactAuthor } from "../src/artifacts.ts";
import type { GithubPulls } from "../src/github-pulls.ts";
import type { Registry } from "../src/registry.ts";
import { DIAGRAM_CHARS as PAGE_CHARS, DIAGRAM_EDGES as PAGE_EDGES } from "../../web/src/lib/diagram.ts";

const fence = (source: string, info = "mermaid") => `\`\`\`${info}\n${source}\n\`\`\``;
const FLOW = "flowchart LR\n  A[draft] --> B[published]";
const SEQUENCE = "sequenceDiagram\n  A->>B: hi\n  B-->>A: hello";

// The page draws what cubed checks: the same bounds.
assert.equal(DIAGRAM_CHARS, PAGE_CHARS);
assert.equal(DIAGRAM_EDGES, PAGE_EDGES);

// Fences as the page finds them: by the info string's first word, in document order, nested ones too; other code is not a diagram.
const body = [
  "# notes", "", fence(FLOW), "", "- a list", "", "  ```mermaid", "  sequenceDiagram", "    A->>B", "  ```", "",
  "> ~~~Mermaid title", "> pie", ">   \"a\" : 1", "> ~~~", "", fence("flowchart LR\n  A --> B", "js"), "", "    ```mermaid\n    indented code", "",
  fence("not a diagram"),
].join("\n");
assert.deepEqual(mermaidFences(body).map(({ index, line, source }) => [index, line, source.split("\n")[0]]),
  [[1, 3, "flowchart LR"], [2, 10, "sequenceDiagram"], [3, 15, "pie"], [4, 28, "not a diagram"]]);
assert.deepEqual(mermaidFences("no diagrams\n\n```ts\nx\n```"), []);

// Every problem, in order, with Pele's code, position and marked line; valid diagrams pass.
assert.deepEqual(await checkDiagrams(`# ok\n\n${fence(FLOW)}\n\n${fence(SEQUENCE)}`), []);
const problems = await checkDiagrams(body);
assert.deepEqual(problems.map(({ diagram, code, line, column, fenceLine, bodyLine }) => ({ diagram, code, line, column, fenceLine, bodyLine })), [
  { diagram: 2, code: "syntax", line: 2, column: 8, fenceLine: 10, bodyLine: 12 },
  { diagram: 4, code: "unsupported-diagram", line: 0, column: 0, fenceLine: 28, bodyLine: null },
]);
assert.equal(problems[0]!.snippet, "  A->>B\n-------^");
const text = diagramProblemsText(problems, 4);
assert.match(text, /^2 ```mermaid diagrams do not draw, so nothing was written; fix each and write again:\n/);
assert.match(text, /\n- diagram 2 of 4, fence at body line 10, diagram line 2, column 8 \(body line 12\): syntax: Parse error on line 2: Expecting 'TXT', got 'NEWLINE'\n {6}A->>B\n {4}-{7}\^\n/);
assert.match(text, /\n- diagram 4 of 4, fence at body line 28: unsupported-diagram: No diagram type detected for the given text\.\n/);

// Bounds: a source too long is refused without drawing; too many diagrams; a deadline the check cannot meet.
const long = await checkDiagrams(fence(`flowchart LR\n${"  A --> B\n".repeat(2100)}`));
assert.equal(long[0]!.code, "limit");
assert.match(long[0]!.message, /characters; at most 20000/);
const many = await checkDiagrams(Array.from({ length: DIAGRAMS_PER_BODY + 1 }, () => fence(FLOW)).join("\n\n"));
assert.equal(many.length, 1);
assert.match(many[0]!.message, /51 diagrams; a revision holds at most 50/);
const edges = await checkDiagrams(fence(`flowchart LR\n${Array.from({ length: DIAGRAM_EDGES + 1 }, (_, index) => `  n${index} --> n${index + 1}`).join("\n")}`));
assert.equal(edges[0]!.code, "limit", "Pele's edge limit");
await assert.rejects(checkDiagrams(fence(FLOW), { deadlineMs: 1 }), /took longer than 0\.001 s to check/);
assert.deepEqual(await checkDiagrams(fence(FLOW)), [], "a check after a deadline runs again");
// Hostile sources are only checked, never run: links and callbacks are off.
assert.deepEqual(await checkDiagrams(fence("flowchart LR\n  A[\"<img src=x onerror=alert(1)>\"] --> B\n  click A call alert(1)\n  click B \"javascript:alert(2)\"")), []);

// Through the service: refused before anything is written, the newest valid revision kept.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-artifact-diagrams-"));
const registry = { getThread: () => null, getProject: () => null, listProjects: () => [] } as unknown as Registry;
const store = new ArtifactStore(path.join(root, "artifacts.sqlite"));
const artifacts = new Artifacts({ store, registry, github: {} as GithubPulls, optchat: async () => null, submit: async () => {} });
const optchat: ArtifactAuthor = { kind: "optchat" };
const scope: ArtifactScope = { agent: optchat, authors: [optchat] };
const write = (input: { id?: string; name?: string; body: string }, requestId: string) => artifacts.write(scope, input, { agent: "optchat", call: requestId }, requestId);
const refusedFor = async (run: () => Promise<unknown>, diagram: number) => {
  let caught: unknown;
  await run().catch(error => { caught = error; });
  assert.ok(caught instanceof ArtifactError, String(caught));
  assert.equal(caught.status, 422);
  assert.equal(caught.diagrams?.[0]?.diagram, diagram, "the problems as data");
  assert.match(caught.message, /do(es)? not draw, so nothing was written/);
};
try {
  await refusedFor(() => write({ name: "plan", body: `# plan\n\n${fence("flowchart LR\n  A[x --> B")}` }, "w-0"), 1);
  assert.equal(store.named(optchat, "plan"), null, "a refused first write creates no artifact");

  const valid = `# plan\n\n${fence(FLOW)}\n\ntext between\n\n${fence(SEQUENCE)}`;
  const first = await write({ name: "plan", body: valid }, "w-1");
  assert.equal(first.revision, 1);
  await refusedFor(() => write({ id: first.id, body: valid.replace("B-->>A: hello", "B-->>A") }, "w-2"), 2);
  await refusedFor(() => artifacts.edit(scope, { id: first.id, oldString: "A[draft] --> B[published]", newString: "A[draft --> B" }, { agent: "optchat" }, "e-1"), 1);
  assert.equal(store.get(first.id)!.head, 1, "a refused write or Edit writes no revision");
  assert.equal(store.revision(first.id, 1)!.body, valid, "the valid revision is kept as it was");

  // A fixed diagram is written; a replayed call answers with its revision even if Pele would refuse its body now.
  const fixed = await artifacts.edit(scope, { id: first.id, oldString: "published", newString: "live" }, { agent: "optchat" }, "e-2");
  assert.equal(fixed.revision, 2);
  assert.equal((await write({ id: first.id, body: "# plan\n\n```mermaid\nnot now\n```" }, "w-1")).revision, 1, "a replay is answered, not checked");
  assert.equal(store.get(first.id)!.head, 2);

  // An existing revision written before the check stays readable as it is.
  store.write(optchat, { id: first.id, base: 2, title: "plan", body: "# plan\n\n```mermaid\nlegacy\n```", projectId: null }, { agent: "optchat" }, "legacy");
  assert.match(artifacts.read(scope, first.id), /```mermaid\nlegacy\n```/);
  console.log("ok: artifact diagrams: fences found as the page finds them, problems with place and Pele's words, refused writes write nothing, replays answered, check bounded");
} finally {
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
