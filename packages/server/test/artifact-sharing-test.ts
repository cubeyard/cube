/** Shared artifact editing over a real store with a fake registry and
 * GitHub: a thread revises OptChat's artifact and another thread's in its
 * project, OptChat revises its thread's; a thread of another project can
 * neither read nor revise; every revision keeps its body, actions and
 * editor while the author stays; a write on an older revision than the
 * newest is refused, also between two writers on the same base; a merge
 * stays pinned to its head commit and a revision runs nothing; comments
 * still go to the author. No network. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Artifacts, type ArtifactScope } from "../src/artifact-service.ts";
import { ArtifactError, ArtifactStore, type ArtifactAuthor } from "../src/artifacts.ts";
import type { GithubPulls, PullState } from "../src/github-pulls.ts";
import type { Registry } from "../src/registry.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-artifact-sharing-"));
const SHA = "a".repeat(40), NEXT = "b".repeat(40);
const projects = [
  { id: "p", name: "cube", repositories: [{ url: "https://github.com/cubeyard/cube" }] },
  { id: "q", name: "other", repositories: [{ url: "https://github.com/cubeyard/other" }] },
];
const A = "aaaaaaaa-0000-4000-8000-000000000001", B = "bbbbbbbb-0000-4000-8000-000000000002", C = "cccccccc-0000-4000-8000-000000000003";
const threads: Record<string, string> = { [A]: "p", [B]: "p", [C]: "q" };
const registry = {
  getThread: (id: string) => threads[id] ? { id, projectId: threads[id], archived: false, createdAt: 0 } : null,
  getProject: (id: string) => projects.find(project => project.id === id) ?? null,
  listProjects: () => projects,
} as unknown as Registry;
const pull: PullState = { repository: "cubeyard/cube", number: 7, url: "https://github.com/cubeyard/cube/pull/7", title: "t", author: "a",
  state: "open", merged: false, draft: false, headSha: SHA, headRef: "feat", baseRef: "main", mergeable: true, mergeableState: "clean" };
const merges: string[] = [];
const github: GithubPulls = {
  async pull() { return { ...pull }; },
  async merge(_repository, _number, { sha }) { merges.push(sha); return { merged: true, sha: "c".repeat(40), message: "merged" }; },
};
const chat: string[] = [], submitted: string[] = [];
const store = new ArtifactStore(path.join(root, "artifacts.sqlite"));
const artifacts = new Artifacts({ store, registry, github, retryMs: 60_000,
  optchat: async () => ({ send: async text => { chat.push(text); }, started: async () => true }),
  submit: async (thread, text) => { submitted.push(`${thread}:${text}`); } });

const optchat: ArtifactAuthor = { kind: "optchat" };
const thread = (id: string): ArtifactAuthor => ({ kind: "thread", thread: id });
// OptChat reads its own and the threads it started (A here); a thread its own and its project's.
const scope = (agent: ArtifactAuthor): ArtifactScope => ({ agent, authors: agent.kind === "optchat" ? [optchat, thread(A)] : [agent] });
let calls = 0;
const write = (agent: ArtifactAuthor, input: { id?: string; base?: number; body: string; actions?: unknown; project?: string }, requestId = `w${++calls}`) =>
  artifacts.write(scope(agent), input, { agent: agent.kind === "optchat" ? "optchat" : "pi", call: requestId }, requestId);
const refused = (run: () => unknown, pattern: RegExp, status: number) => assert.throws(run, (error: unknown) =>
  error instanceof ArtifactError && error.status === status && pattern.test(error.message), String(pattern));
const merge = (headSha: string) => [{ kind: "github.merge", repository: "cubeyard/cube", pull: 7, headSha, method: "squash" }];

try {
  // OptChat writes the pull request's artifact in project p, with its merge pinned to SHA.
  const review = write(optchat, { project: "cube", body: "# PR 7\n\nfirst", actions: merge(SHA) }).id;
  const original = store.revision(review, 1)!;

  // A thread of p sees it; it must read before it revises someone else's revision.
  assert.match(artifacts.read(scope(thread(B)), undefined), new RegExp(`${review} "PR 7" · revision 1 · by optchat`));
  refused(() => write(thread(A), { id: review, body: "# PR 7\n\nblind" }), /was written by optchat; read its newest revision first/, 409);
  assert.equal(store.get(review)!.head, 1, "a blind write writes nothing");
  assert.match(artifacts.read(scope(thread(A)), review), /revision 1 of 1 · by optchat · project cube/);
  const byA = write(thread(A), { id: review, body: "# PR 7\n\nreviewed by A" });
  assert.equal(byA.revision, 2);
  assert.match(byA.text, /it stays optchat's artifact: the user's comments on it go to optchat, not to you\./);
  assert.match(byA.text, /Actions kept from revision 1 .*merge-7: merge cubeyard\/cube#7 at aaaaaaaaaaaa \(squash\)/);
  const second = store.revision(review, 2)!;
  assert.deepEqual(second.actions, original.actions, "actions left out are kept exactly, pinned to the same head");
  assert.deepEqual(second.editor, thread(A));
  assert.equal(second.provenance.thread, A);
  assert.deepEqual(store.get(review)!.author, optchat, "the author stays");
  assert.deepEqual(store.revision(review, 1), original, "the first revision is kept whole");
  assert.match(artifacts.read(scope(optchat), review), /revision 2 of 2 · by optchat · this revision by thread \[aaaaaaaa\]/);

  // Stale: B read revision 2, A wrote 3 on its own newest; B's write on 2 is refused, then made on 3.
  artifacts.read(scope(thread(B)), review);
  assert.equal(write(thread(A), { id: review, body: "# PR 7\n\nA again" }).revision, 3);
  refused(() => write(thread(B), { id: review, body: "# PR 7\n\nB on 2" }), /revision 3 \(by thread \[aaaaaaaa\]\) is newer than revision 2 this write is based on/, 409);
  refused(() => write(thread(B), { id: review, base: 1, body: "# PR 7\n\nB on 1" }), /is newer than revision 1/, 409);
  assert.equal(store.get(review)!.head, 3, "nothing was overwritten");
  artifacts.read(scope(thread(B)), review);
  assert.equal(write(thread(B), { id: review, body: "# PR 7\n\nB on 3" }, "b-on-3").revision, 4);

  // Two writers on the same base: the first wins, the second is refused rather than lost.
  assert.equal(write(optchat, { id: review, base: 4, body: "# PR 7\n\nchat on 4" }).revision, 5);
  refused(() => write(thread(A), { id: review, base: 4, body: "# PR 7\n\nA on 4" }), /revision 5 \(by optchat\) is newer than revision 4/, 409);
  // A replayed call finds its revision whoever wrote since; another editor's request id is no replay.
  assert.equal(write(thread(B), { id: review, body: "# PR 7\n\nB on 3" }, "b-on-3").revision, 4);
  refused(() => write(thread(A), { id: review, base: 5, body: "# PR 7\n\nx" }, "b-on-3"), /another author's write/, 409);

  // Another project's thread can neither read nor revise it, nor list it.
  refused(() => artifacts.read(scope(thread(C)), review), /no artifact .* you can read/, 404);
  refused(() => write(thread(C), { id: review, base: 5, body: "# mine" }), /no artifact .* you can read/, 404);
  assert.equal(artifacts.read(scope(thread(C)), undefined), "no artifacts yet");
  // An artifact without a project stays its author's.
  const plan = write(optchat, { body: "# plan" }).id;
  refused(() => artifacts.read(scope(thread(A)), plan), /you can read/, 404);

  // A thread's artifact: revised by another thread of its project and by the chat that started it.
  const notes = write(thread(A), { body: "# notes\n\nby A" }).id;
  artifacts.read(scope(thread(B)), notes);
  assert.match(write(thread(B), { id: notes, body: "# notes\n\nby B" }).text, /it stays thread \[aaaaaaaa\]'s artifact/);
  artifacts.read(scope(optchat), notes);
  assert.equal(write(optchat, { id: notes, body: "# notes\n\nby the chat" }).revision, 3);
  assert.deepEqual(store.revisions(notes).map(revision => revision.editor), [thread(A), thread(B), optchat]);
  assert.deepEqual(store.get(notes)!.author, thread(A));

  // The merge stays pinned: the user previews revision 5, a thread writes 6; revision 5 no longer runs and nothing ran on write.
  assert.deepEqual((await artifacts.preview(review, "merge-7", 5)).problems, []);
  artifacts.read(scope(thread(A)), review);
  write(thread(A), { id: review, body: "# PR 7\n\nhead moved, new pin", actions: merge(NEXT) });
  assert.equal(store.revision(review, 6)!.actions[0]!.headSha, NEXT);
  assert.equal(store.revision(review, 5)!.actions[0]!.headSha, SHA, "the earlier pin is kept with its revision");
  assert.deepEqual(store.actionRuns(review), [], "a revision runs no action");
  await assert.rejects(artifacts.run(review, "merge-7", { revision: 5, confirm: "cubeyard/cube#7", requestId: "m-old" }), /only the newest revision's \(6\) actions run/);
  assert.match((await artifacts.preview(review, "merge-7", 6)).problems.join(), /head is now aaaaaaaaaaaa, not bbbbbbbbbbbb/, "the new pin does not apply to the old head");
  await assert.rejects(artifacts.run(review, "merge-7", { revision: 6, confirm: "cubeyard/cube#7", requestId: "m-new" }), /not run/);
  assert.deepEqual(merges, []);
  // [] removes the actions; the earlier revisions keep theirs.
  write(thread(A), { id: review, body: "# PR 7\n\nno merge", actions: [] });
  assert.deepEqual(store.revision(review, 7)!.actions, []);
  assert.equal(store.revision(review, 6)!.actions.length, 1);

  // Comments on a revision a thread wrote go to the author, OptChat, saying who wrote it.
  store.comment(review, { revision: 7, anchor: { quote: "no merge", prefix: "", suffix: "", start: 5, end: 13, section: "PR 7" }, body: "why not?" }, "k1");
  const batch = artifacts.queue(review, "send-1")!;
  assert.deepEqual(batch.target, optchat);
  assert.match(batch.text, /on your artifact "PR 7" \(.*, now at revision 7; thread \[aaaaaaaa\] wrote that revision\)/);
  for (let tries = 0; !chat.length && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(chat.length, 1, "the chat got the comments");
  assert.deepEqual(submitted, [], "no thread that revised it was sent them");
  console.log("artifact sharing: ok");
} finally {
  artifacts.close();
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
