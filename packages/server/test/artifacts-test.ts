/** Work artifacts end to end through cubed's routes, with disposable state:
 * OptChat, a Pi thread (over a local guest) and a Claude Code thread (the
 * fake `claude` running the mod's own tools over the workspace socket) write
 * artifacts; revisions and provenance persist across a restart; authors are
 * kept apart; hostile action declarations are refused; comments are anchored
 * to a revision, wait while a thread works and reach it once; a confirmed
 * merge is checked against the project and the pull request's live state
 * (a fake GitHub) and runs once. Faux model only. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { ArtifactError, ArtifactStore, commentMessage, parseActions } from "../src/artifacts.ts";
import { GithubPullsError, type GithubPulls, type PullState } from "../src/github-pulls.ts";
import { LocalMachines } from "./local-guest.ts";

process.env.CUBED_OPTCHAT_WISHES = "off";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-artifacts-"));
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
const SHA = "a".repeat(40), MOVED = "b".repeat(40);

// ---- the store alone: limits, idempotency, anchors, persistence ----
{
  const file = path.join(root, "unit.sqlite");
  let store = new ArtifactStore(file);
  const optchat = { kind: "optchat" } as const;
  const first = store.write(optchat, { title: "plan", body: "# plan\none", actions: [], projectId: null }, { agent: "optchat", call: "c1" }, "r1");
  assert.equal(first.created, true);
  const id = first.revision.artifact;
  assert.equal(store.write(optchat, { title: "plan", body: "# plan\none", actions: [], projectId: null }, { agent: "optchat" }, "r1").revision.number, 1, "a replayed request finds its revision");
  assert.equal(store.write(optchat, { id, title: "plan", body: "# plan\none", actions: [], projectId: null }, { agent: "optchat" }, "r2").unchanged, true, "the same content writes nothing");
  assert.equal(store.write(optchat, { id, title: "plan", body: "# plan\ntwo", actions: [], projectId: null }, { agent: "optchat" }, "r3").revision.number, 2);
  assert.throws(() => store.write({ kind: "thread", thread: "t1" }, { id, title: "x", body: "y", actions: [], projectId: null }, { agent: "pi" }, "r4"), /no artifact .* of yours/, "another author cannot revise it");
  assert.throws(() => store.write({ kind: "thread", thread: "t1" }, { title: "x", body: "y", actions: [], projectId: null }, { agent: "pi" }, "r1"), /another author/, "another author's request id is no replay");
  assert.throws(() => store.write(optchat, { title: "", body: "", actions: [], projectId: null }, { agent: "optchat" }, "r5"), ArtifactError);
  assert.throws(() => store.write(optchat, { title: "big", body: "x".repeat(256 * 1024 + 1), actions: [], projectId: null }, { agent: "optchat" }, "r6"), /at most/);
  // Anchors: the quote must match its offsets' length and fit the bounds.
  assert.throws(() => store.comment(id, { revision: 1, anchor: { quote: "one", prefix: "", suffix: "", start: 0, end: 7 }, body: "hm" }, "c-a"), /offsets/);
  assert.throws(() => store.comment(id, { revision: 9, anchor: { quote: "one", prefix: "", suffix: "", start: 0, end: 3 }, body: "hm" }, "c-b"), /no such revision/);
  assert.throws(() => store.comment(id, { revision: 1, anchor: { quote: "x".repeat(2001), prefix: "", suffix: "", start: 0, end: 2001 }, body: "hm" }, "c-c"), /quote/);
  const comment = store.comment(id, { revision: 1, anchor: { quote: "one", prefix: "plan ", suffix: "", start: 5, end: 8, section: "plan" }, body: "why one?" }, "c1");
  assert.equal(store.comment(id, { revision: 1, anchor: { quote: "one", prefix: "", suffix: "", start: 5, end: 8 }, body: "why one?" }, "c1").id, comment.id, "a repeated comment is added once");
  assert.equal(comment.state, "draft");
  const batch = store.queue(id, "send-1", () => "artifact_write with id")!;
  assert.equal(store.queue(id, "send-1", () => "x")!.id, batch.id, "a repeated send finds its batch");
  assert.equal(store.queue(id, "send-2", () => "x"), null, "nothing left to send");
  assert.match(batch.text, /On revision 1 \(written on revision 1; the current one is 2\), under "plan", the user selected:\n {3}> one/);
  assert.equal(store.deleteDraft(id, comment.id), false, "a sent comment stays");
  store.close();
  store = new ArtifactStore(file);
  assert.equal(store.get(id)!.head, 2, "revisions persist");
  assert.equal(store.revisions(id).length, 2);
  assert.equal(store.comments(id)[0]!.state, "queued", "comments persist with their batch");
  assert.equal(store.revision(id, 1)!.provenance.call, "c1", "provenance persists");
  store.close();
  // A message of several comments keeps each one's own revision and context.
  const text = commentMessage({ id, title: "plan", head: 3 }, [
    { id: "1", artifact: id, revision: 3, anchor: { quote: "a\nb", prefix: "x", suffix: "y", start: 1, end: 4, section: "" }, body: "first", createdAt: 0, state: "draft", batch: null, note: null, deliveredAt: null },
  ], "hint");
  assert.match(text, / {3}> a\n {3}> b/);
  assert.match(text, /in context: …x\[\[a b\]\]y…/);
}

// ---- hostile action declarations are refused, field by field ----
{
  const valid = { kind: "github.merge", repository: "cubeyard/demo", pull: 7, headSha: SHA };
  assert.deepEqual(parseActions([valid]), [{ ...valid, id: "merge-7", label: "merge cubeyard/demo#7", method: "merge" }]);
  for (const [bad, why] of [
    [{ ...valid, kind: "shell", command: "rm -rf /" }, /only action/],
    [{ ...valid, kind: "github.merge", run: "curl evil" }, /unknown field run/],
    [{ ...valid, repository: "../../etc" }, /repository/],
    [{ ...valid, repository: "-x/y" }, /repository/],
    [{ ...valid, headSha: "main" }, /headSha/],
    [{ ...valid, pull: -1 }, /pull/],
    [{ ...valid, method: "force" }, /method/],
    [{ ...valid, label: "<script>alert(1)</script>\nsecond line" }, /label/],
    [{ ...valid, id: "Merge Now" }, /id/],
  ] as const) assert.throws(() => parseActions([bad]), why, JSON.stringify(bad));
  assert.throws(() => parseActions([valid, valid]), /used twice/);
  assert.throws(() => parseActions("merge"), /list/);
}

// ---- the product: cubed's routes, three authors, delivery, actions ----
const state = path.join(root, "state");
const repository = path.join(root, "repository");
fs.mkdirSync(repository);
const git = (cwd: string, args: string[]) => execFileSync("git", ["-c", "user.name=Cube Test", "-c", "user.email=cube@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" });
git(repository, ["init", "-q", "--initial-branch=main"]);
fs.writeFileSync(path.join(repository, "README"), "hello\n");
git(repository, ["add", "README"]);
git(repository, ["commit", "-qm", "base"]);

// A fake GitHub: one pull request whose head and state the test moves.
const pulls = new Map<string, PullState>();
const merges: Array<{ repository: string; number: number; sha: string; method: string }> = [];
let failMerge = false;
pulls.set("cubeyard/demo#7", { repository: "cubeyard/demo", number: 7, url: "https://github.com/cubeyard/demo/pull/7", title: "Add the thing", author: "someone",
  state: "open", merged: false, draft: false, headSha: SHA, headRef: "feat/thing", baseRef: "main", mergeable: true, mergeableState: "clean" });
const github: GithubPulls = {
  async pull(repo, number) {
    const pull = pulls.get(`${repo}#${number}`);
    if (!pull) throw new GithubPullsError("github: Not Found", 404);
    return { ...pull };
  },
  async merge(repo, number, { sha, method }) {
    const pull = pulls.get(`${repo}#${number}`)!;
    if (failMerge) { failMerge = false; throw new GithubPullsError("could not reach github", 502); }
    if (pull.headSha !== sha) throw new GithubPullsError("github: Head branch was modified. Review and try the merge again.", 409);
    merges.push({ repository: repo, number, sha, method });
    pull.merged = true; pull.state = "closed";
    return { merged: true, sha: "c".repeat(40), message: "Pull Request successfully merged" };
  },
};

const prompts: string[] = [];
let releaseHold!: () => void;
const hold = new Promise<void>(resolve => { releaseHold = resolve; });
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 200 }, () => async request => {
  const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
  if (system.includes("You write the memory of OptChat")) return fauxAssistantMessage("summarized line");
  const last = request.messages.findLast(message => message.role !== "system")!;
  const said = textOf(last);
  if (system.includes("You are OptChat")) {
    if (last.role === "toolResult") return fauxAssistantMessage(`done: ${said}`);
    const words = said.split("\n").at(-1)!;
    if (words.includes("write the review")) {
      return fauxAssistantMessage([fauxToolCall("artifact_write", { title: "post-merge review", project: "gh", body: HOSTILE,
        actions: [{ kind: "github.merge", repository: "cubeyard/demo", pull: 7, headSha: SHA, method: "squash" }] }, { id: "call-review" })], { stopReason: "toolUse" });
    }
    if (words.includes("revise the review")) {
      const id = /id (\S+)/.exec(words)![1];
      return fauxAssistantMessage([fauxToolCall("artifact_write", { id, body: `${HOSTILE}\n\nrevised`,
        actions: [{ kind: "github.merge", repository: "cubeyard/demo", pull: 7, headSha: SHA, method: "squash" }] }, { id: "call-revise" })], { stopReason: "toolUse" });
    }
    if (words.includes("list artifacts")) return fauxAssistantMessage([fauxToolCall("artifact_read", {}, { id: "call-list" })], { stopReason: "toolUse" });
    if (said.includes("[artifact ")) { prompts.push(`optchat:${said}`); return fauxAssistantMessage("noted the comment"); }
    return fauxAssistantMessage(`noted: ${words}`);
  }
  // A Pi thread.
  if (last.role === "toolResult") return fauxAssistantMessage(`tool said: ${said}`);
  prompts.push(said);
  if (said.includes("hold until released")) { await hold; return fauxAssistantMessage("released"); }
  if (said.includes("publish the notes")) {
    return fauxAssistantMessage([fauxToolCall("bash", { command: "printf '# thread notes\\n\\nthe guest wrote this\\n' > notes.md" }, { id: "t-bash" }),
      fauxToolCall("artifact_write", { path: "notes.md" }, { id: "t-art" })], { stopReason: "toolUse" });
  }
  if (said.includes("steal")) {
    const id = /steal (\S+)/.exec(said)![1];
    return fauxAssistantMessage([fauxToolCall("artifact_write", { id, body: "# mine now" }, { id: "t-steal" }), fauxToolCall("artifact_read", { id }, { id: "t-peek" })], { stopReason: "toolUse" });
  }
  if (said.includes("escape")) return fauxAssistantMessage([fauxToolCall("artifact_write", { path: "../../etc/passwd" }, { id: "t-esc" })], { stopReason: "toolUse" });
  if (said.includes("bad action")) {
    return fauxAssistantMessage([fauxToolCall("artifact_write", { body: "# x", actions: [{ kind: "github.merge", repository: "cubeyard/demo", pull: 7, headSha: SHA }] }, { id: "t-act" })], { stopReason: "toolUse" });
  }
  return fauxAssistantMessage("ok");
}));
const HOSTILE = [
  "# post-merge review",
  "<script>alert('x')</script><img src=x onerror=alert(1)>",
  "[click](javascript:alert(1)) and [ok](https://example.com)",
  "```mermaid\nsequenceDiagram\n  A->>B: hi\n  click A call alert(1)\n```",
  "```diff\n-old\n+new\n```",
  "The summary line to comment on.",
].join("\n\n");

const models = createModels();
models.setProvider(faux.provider);
const machines = new LocalMachines(path.join(root, "machines"));
const open = () => createCubed({ state, models, machines, gateway: null, githubPulls: github, artifactRetryMs: 100,
  claude: [process.execPath, path.resolve(import.meta.dirname, "fake-claude.ts")], claudeOptions: { stopGraceMs: 2000 } });
let app = await open();
for (const n of [1, 2, 3]) app.registry.enrollRunner({ nodeId: `node-${n}`, environmentId: 1, threadId: `runner-${n}`, configPath: `/private/${n}.json`, configHash: `h${n}` });
// A project whose repository is on GitHub (never checked here: no network).
app.registry.saveProject({ id: "gh", name: "gh", status: "ready", error: null, revision: 1, checkedAt: 1, createdAt: 1, updatedAt: 1,
  repositories: [{ id: "r", projectId: "gh", position: 0, url: "https://github.com/cubeyard/demo", base: "main", checkoutName: "workspace",
    status: "ready", error: null, resolvedBase: "main", baseOid: SHA, checkedAt: 1 }] });
let base = "";
const listen = async () => {
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  assert(address && typeof address === "object");
  base = `http://127.0.0.1:${address.port}`;
};
await listen();
const call = async (route: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
  const response = await fetch(`${base}${route}`, { method, ...body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } });
  return { status: response.status, body: await response.json() as Record<string, any> };
};
async function until<T>(read: () => Promise<T>, check: (value: T) => boolean, what: string, ms = 30_000): Promise<T> {
  let value = await read();
  for (const deadline = Date.now() + ms; !check(value); value = await read()) {
    assert.ok(Date.now() < deadline, `${what}: ${JSON.stringify(value).slice(0, 3000)}`);
    await delay(50);
  }
  return value;
}
const chatSays = async (text: string, requestId: string) => {
  assert.equal((await call("/api/optchat/prompt", { text, requestId })).status, 200);
  return until(() => call("/api/optchat/history"), history => history.body.status.state !== "working" && JSON.stringify(history.body).includes(text)
    && history.body.events.at(-1)?.type === "assistant-text", `the chat answers ${text}`);
};
const anchorOf = (quote: string, start = 10) => ({ quote, prefix: "before ", suffix: " after", start, end: start + quote.length, section: "post-merge review" });

try {
  const project = await call("/api/projects", { name: "demo", repositories: [{ url: repository, base: "main" }] });
  await call(`/api/projects/${project.body.project.id}/check`, {});

  // OptChat writes an artifact with a merge action for its project's repository.
  await chatSays("please write the review", "u1");
  let list = await call("/api/artifacts");
  assert.equal(list.body.artifacts.length, 1);
  const review = list.body.artifacts[0];
  assert.deepEqual(review.author, { kind: "optchat" });
  assert.equal(review.project.name, "gh");
  let view = await call(`/api/artifacts/${review.id}`);
  assert.equal(view.body.revisions[0].provenance.agent, "optchat");
  assert.equal(view.body.revisions[0].provenance.call, "call-review");
  const revision = await call(`/api/artifacts/${review.id}/revisions/1`);
  assert.equal(revision.body.revision.body, HOSTILE, "the body is kept as data, word for word");
  assert.equal(revision.body.revision.actions[0].method, "squash");

  // A Pi thread writes its own from a workspace file; provenance names the file.
  const piThread = (await call("/api/threads", { projectId: project.body.project.id, requestId: "t-pi", text: "publish the notes" })).body.id as string;
  const notes = await until(() => call("/api/artifacts"), value => value.body.artifacts.some((item: any) => item.author.kind === "thread"), "the thread's artifact");
  const threadArtifact = notes.body.artifacts.find((item: any) => item.author.kind === "thread");
  assert.equal(threadArtifact.author.thread, piThread);
  assert.equal(threadArtifact.title, "thread notes", "the title comes from the first heading");
  view = await call(`/api/artifacts/${threadArtifact.id}`);
  assert.equal(view.body.revisions[0].provenance.source.path, "/workspace/notes.md");
  assert.match(view.body.revisions[0].provenance.source.sha256, /^[0-9a-f]{64}$/);
  const idle = async (id: string) => until(() => call(`/api/threads/${id}/history`), value => value.status === 200 && value.body.status.state !== "working" && value.body.status.state !== "idle", `thread ${id} settles`);
  await idle(piThread);

  // Authors are kept apart: the thread cannot revise or read the chat's.
  const steal = await call(`/api/threads/${piThread}/prompt`, { text: `steal ${review.id}`, requestId: "steal" });
  assert.equal(steal.status, 200);
  let history = await until(() => call(`/api/threads/${piThread}/history`), value => JSON.stringify(value.body).includes("t-peek") && value.body.status.state === "completed"
    && JSON.stringify(value.body).includes(`steal ${review.id}`) && value.body.events.at(-1)?.type === "assistant-text", "the steal settles");
  const stolen = JSON.stringify(history.body);
  assert.match(stolen, new RegExp(`not written: no artifact ${review.id} of yours`));
  assert.match(stolen, new RegExp(`no artifact ${review.id} you can read`));
  assert.equal((await call(`/api/artifacts/${review.id}`)).body.artifact.head, 1, "nothing was written");
  // A path outside the workspace and an action on another project's repository are refused.
  await call(`/api/threads/${piThread}/prompt`, { text: "escape the workspace", requestId: "escape" });
  history = await until(() => call(`/api/threads/${piThread}/history`), value => JSON.stringify(value.body).includes("t-esc") && value.body.events.at(-1)?.type === "assistant-text", "escape settles");
  assert.match(JSON.stringify(history.body), /must be inside the workspace/);
  await call(`/api/threads/${piThread}/prompt`, { text: "bad action", requestId: "bad-action" });
  history = await until(() => call(`/api/threads/${piThread}/history`), value => JSON.stringify(value.body).includes("t-act") && value.body.events.at(-1)?.type === "assistant-text", "bad action settles");
  assert.match(JSON.stringify(history.body), /cubeyard\/demo is not a repository of this artifact's project/);
  assert.equal((await call("/api/artifacts")).body.artifacts.length, 2);

  // A Claude Code thread: the mod's /cube/artifacts paths.
  const claudeThread = (await call("/api/threads", { projectId: project.body.project.id, requestId: "t-claude", model: { provider: "claude-code", id: "fable" },
    text: ["write-at /cube/artifacts/design.md # design notes\\n\\n```mermaid\\ngraph TD; A-->B\\n```", "read-at /cube/artifacts/design.md", "write-at /cube/artifacts/../x.md nope",
      "write-at /cube/elsewhere.md nope", "read-at /cube/artifacts"].join("\n") })).body.id as string;
  const claudeHistory = await until(() => call(`/api/threads/${claudeThread}/history`), value => value.status === 200 && value.body.status.state === "completed", "the claude thread finishes");
  const claudeText = JSON.stringify(claudeHistory.body);
  assert.match(claudeText, /created at revision 1/);
  assert.match(claudeText, /--- body of revision 1 ---/);
  assert.match(claudeText, /is not an artifact path/);
  list = await call("/api/artifacts");
  const design = list.body.artifacts.find((item: any) => item.title === "design notes");
  assert.equal(design.author.thread, claudeThread);
  assert.equal((await call(`/api/artifacts/${design.id}`)).body.revisions[0].provenance.agent, "claude-code");
  // The socket's artifact routes need the thread's lease token.
  const unauth = await fetch(`${base}/api/threads/${claudeThread}/workspace/artifacts`);
  assert.equal(unauth.status, 404, "the browser-facing host does not serve them");

  // Comments: drafts, validation, delete, send. A busy thread keeps them queued.
  assert.equal((await call(`/api/artifacts/${threadArtifact.id}/comments`, { revision: 1, anchor: { quote: "x", start: 0, end: 5 }, body: "no", requestId: "bad" })).status, 400);
  const draft = await call(`/api/artifacts/${threadArtifact.id}/comments`, { revision: 1, anchor: anchorOf("the guest wrote this"), body: "who is the guest?", requestId: "k1" });
  assert.equal(draft.body.comment.state, "draft");
  const extra = await call(`/api/artifacts/${threadArtifact.id}/comments`, { revision: 1, anchor: anchorOf("thread notes", 0), body: "drop me", requestId: "k2" });
  assert.equal((await call(`/api/artifacts/${threadArtifact.id}/comments/${extra.body.comment.id}`, undefined, "DELETE")).status, 200);
  await call(`/api/threads/${piThread}/prompt`, { text: "hold until released", requestId: "hold" });
  await until(() => call(`/api/threads/${piThread}/history`), value => value.body.status.state === "working", "the thread works");
  const sent = await call(`/api/artifacts/${threadArtifact.id}/send`, { requestId: "send-a" });
  assert.equal(sent.body.batch.state, "queued");
  const waiting = await until(() => call(`/api/artifacts/${threadArtifact.id}`), value => /thread is working/.test(value.body.comments[0].note ?? ""), "the batch waits");
  assert.equal(waiting.body.comments[0].state, "queued", "nothing interrupts a working thread");
  assert.equal(prompts.filter(prompt => prompt.includes("[artifact ")).length, 0);
  releaseHold();
  await until(() => call(`/api/artifacts/${threadArtifact.id}`), value => value.body.comments[0].state === "delivered", "delivered after the turn");
  await idle(piThread);
  const delivered = prompts.filter(prompt => prompt.includes(`[artifact ${threadArtifact.id.slice(0, 8)}]`));
  assert.equal(delivered.length, 1, "delivered once");
  assert.match(delivered[0]!, /> the guest wrote this/);
  assert.match(delivered[0]!, /comment: who is the guest\?/);
  assert.match(delivered[0]!, /under "post-merge review"/);
  assert.doesNotMatch(delivered[0]!, /drop me/);
  assert.equal((await call(`/api/artifacts/${threadArtifact.id}/send`, { requestId: "send-a" })).body.batch.state, "delivered", "a repeated send is the same batch");

  // A comment on the chat's artifact goes to the chat's own queue.
  await call(`/api/artifacts/${review.id}/comments`, { revision: 1, anchor: anchorOf("The summary line"), body: "expand this", requestId: "k3" });
  await call(`/api/artifacts/${review.id}/send`, { requestId: "send-b" });
  await until(async () => prompts.filter(prompt => prompt.startsWith("optchat:")), value => value.length === 1, "the chat gets it");
  assert.match(prompts.find(prompt => prompt.startsWith("optchat:"))!, /> The summary line[\s\S]*comment: expand this/);

  // Actions: the preview names the target and its live state.
  let preview = await call(`/api/artifacts/${review.id}/actions/merge-7?revision=1`);
  assert.deepEqual(preview.body.preview.problems, []);
  assert.equal(preview.body.preview.confirm, "cubeyard/demo#7");
  assert.equal(preview.body.preview.pull.title, "Add the thing");
  assert.equal((await call(`/api/artifacts/${review.id}/actions/nope?revision=1`)).status, 404);
  // A moved head is refused before anything runs.
  pulls.get("cubeyard/demo#7")!.headSha = MOVED;
  preview = await call(`/api/artifacts/${review.id}/actions/merge-7?revision=1`);
  assert.match(preview.body.preview.problems.join(), /head is now bbbbbbbbbbbb/);
  assert.equal((await call(`/api/artifacts/${review.id}/actions/merge-7`, { revision: 1, confirm: "cubeyard/demo#7", requestId: "m0" })).status, 409);
  pulls.get("cubeyard/demo#7")!.headSha = SHA;
  // A wrong confirmation runs nothing.
  assert.equal((await call(`/api/artifacts/${review.id}/actions/merge-7`, { revision: 1, confirm: "yes", requestId: "m1" })).status, 400);
  // An older revision's action does not run once a newer one exists.
  await chatSays(`revise the review id ${review.id}`, "u2");
  assert.equal((await call(`/api/artifacts/${review.id}`)).body.artifact.head, 2);
  preview = await call(`/api/artifacts/${review.id}/actions/merge-7?revision=1`);
  assert.match(preview.body.preview.problems.join(), /only the newest revision's \(2\) actions run/);
  assert.equal((await call(`/api/artifacts/${review.id}/actions/merge-7`, { revision: 1, confirm: "cubeyard/demo#7", requestId: "m2" })).status, 409);
  assert.equal(merges.length, 0);
  // A failed try is not a success to repeat: its request id answers the failure; a new one merges.
  failMerge = true;
  assert.equal((await call(`/api/artifacts/${review.id}/actions/merge-7`, { revision: 2, confirm: "cubeyard/demo#7", requestId: "m-fail" })).status, 409);
  const again = await call(`/api/artifacts/${review.id}/actions/merge-7`, { revision: 2, confirm: "cubeyard/demo#7", requestId: "m-fail" });
  assert.equal(again.status, 409, "the same request id does not report the failure as done");
  assert.match(again.body.error, /could not reach github/);
  assert.equal(merges.length, 0);
  // Confirmed on the newest revision: merged once, pinned to the head.
  const merged = await call(`/api/artifacts/${review.id}/actions/merge-7`, { revision: 2, confirm: "cubeyard/demo#7", requestId: "m3" });
  assert.equal(merged.status, 200, JSON.stringify(merged.body));
  assert.equal(merged.body.state, "succeeded");
  assert.deepEqual(merges, [{ repository: "cubeyard/demo", number: 7, sha: SHA, method: "squash" }]);
  assert.equal((await call(`/api/artifacts/${review.id}/actions/merge-7`, { revision: 2, confirm: "cubeyard/demo#7", requestId: "m3" })).status, 200, "a repeated request answers again");
  assert.equal((await call(`/api/artifacts/${review.id}/actions/merge-7`, { revision: 2, confirm: "cubeyard/demo#7", requestId: "m4" })).status, 409, "a second merge is refused");
  assert.equal(merges.length, 1);
  preview = await call(`/api/artifacts/${review.id}/actions/merge-7?revision=2`);
  assert.match(preview.body.preview.problems.join(), /already merged/);

  // The chat reads its threads' artifacts, not other ones.
  await chatSays("list artifacts", "u3");
  const chatHistory = JSON.stringify((await call("/api/optchat/history")).body);
  assert.match(chatHistory, /post-merge review/);
  assert.doesNotMatch(chatHistory, /thread notes/, "a thread started from the UI is not the chat's");

  // Everything persists across a restart.
  const before = (await call(`/api/artifacts/${review.id}`)).body;
  await app.close();
  app = await open();
  await listen();
  const after = (await call(`/api/artifacts/${review.id}`)).body;
  assert.deepEqual(after.revisions, before.revisions);
  assert.deepEqual(after.comments, before.comments);
  assert.deepEqual(after.actionRuns, before.actionRuns);
  // An archived thread's comments cannot be delivered and say so.
  await call(`/api/artifacts/${design.id}/comments`, { revision: 1, anchor: anchorOf("design notes", 0), body: "late", requestId: "k4" });
  await until(() => call(`/api/threads/${claudeThread}`, undefined, "DELETE"), value => value.status === 200, "archive the claude thread");
  await call(`/api/artifacts/${design.id}/send`, { requestId: "send-c" });
  const lost = await until(() => call(`/api/artifacts/${design.id}`), value => value.body.comments[0].state === "undeliverable", "undeliverable");
  assert.match(lost.body.comments[0].note, /archived/);
  console.log("ok: artifacts: store, revisions and provenance across a restart, authors apart, hostile actions refused, comments anchored, queued while busy and delivered once, merge checked and run once");
} finally {
  await app.close();
  fs.rmSync(root, { recursive: true, force: true });
}
