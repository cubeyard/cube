/** A confirmed action's outcome reaches its author and the chat that owns
 * it: the artifact service over a real store with a fake registry, a fake
 * GitHub, a fake chat and a fake thread prompt. The outcome and its notices
 * are written together; every notice goes once under one request id, waits
 * while it cannot go (chat not open, thread working), says why it cannot
 * (archived thread, past its bound), is skipped for a chat that did not
 * start the thread, and survives a restart, including the restart of a run
 * cut off mid-merge, whose outcome is told as unknown. No network. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Artifacts, type ArtifactChat } from "../src/artifact-service.ts";
import { ArtifactStore, type ArtifactAuthor } from "../src/artifacts.ts";
import { GithubPullsError, type GithubPulls } from "../src/github-pulls.ts";
import type { Registry } from "../src/registry.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-artifact-notices-"));
const file = path.join(root, "artifacts.sqlite");
const SHA = "6a26aa39f9ace624f24549f597d5a4436a0912a9";

const project = { id: "p", name: "cube", repositories: [{ url: "https://github.com/cubeyard/cube" }] };
const threads = new Map<string, { id: string; projectId: string; archived: boolean; createdAt: number }>();
const registry = {
  getThread: (id: string) => threads.get(id) ?? null,
  getProject: (id: string) => id === project.id ? project : null,
  listProjects: () => [project],
} as unknown as Registry;

const merges: Array<{ pull: number; sha: string }> = [];
let mergeError: Error | null = null;
const open = new Set([116, 117, 118, 119, 120]);
const github: GithubPulls = {
  async pull(repository, number) {
    return { repository, number, url: "", title: `pr ${number}`, author: "dizk", state: open.has(number) ? "open" : "closed", merged: !open.has(number), draft: false,
      headSha: SHA, headRef: "fix", baseRef: "main", mergeable: true, mergeableState: "clean" };
  },
  async merge(_repository, number, { sha }) {
    if (mergeError) { const error = mergeError; mergeError = null; throw error; }
    merges.push({ pull: number, sha }); open.delete(number);
    return { merged: true, sha: "c35976b12ade7633423b0c0f5e3824a48628c05c", message: "merged" };
  },
};

/** The chat: open or not, the threads it started, every message it accepted (once per request id). */
const chat = { open: false, started: new Set<string>(), got: new Map<string, string>(), sends: 0 };
const fakeChat: ArtifactChat = {
  async send(text, requestId) { chat.sends++; if (!chat.got.has(requestId)) chat.got.set(requestId, text); },
  async started(id) { return chat.started.has(id); },
};
/** Threads: one working refuses a prompt; each accepts a request id once. */
const working = new Set<string>();
const prompts = new Map<string, string>();
const submit = async (thread: string, text: string, requestId: string) => {
  if (working.has(thread)) throw new Error("the thread is already working");
  if (!prompts.has(requestId)) prompts.set(requestId, `${thread}:${text}`);
};

let store = new ArtifactStore(file);
const service = (options: { giveUpMs?: number } = {}) => new Artifacts({ store, registry, github, optchat: async () => chat.open ? fakeChat : null, submit, retryMs: 25, ...options });
let artifacts = service();
async function until<T>(read: () => T, check: (value: T) => boolean, what: string, ms = 10_000): Promise<T> {
  let value = read();
  for (const deadline = Date.now() + ms; !check(value); value = read()) {
    assert.ok(Date.now() < deadline, `${what}: ${JSON.stringify(value).slice(0, 2000)}`);
    await delay(10);
  }
  return value;
}
const write = (author: ArtifactAuthor, pulls: number[], name: string) => artifacts.write(author,
  { name, title: name, body: `# ${name}`, actions: pulls.map(pull => ({ kind: "github.merge", repository: "cubeyard/cube", pull, headSha: SHA })), project: "cube" },
  { agent: author.kind === "optchat" ? "optchat" : "pi" }, `w-${name}`).id;
const confirm = (id: string, pull: number, requestId: string) => artifacts.run(id, `merge-${pull}`, { revision: 1, confirm: `cubeyard/cube#${pull}`, requestId });
const notices = (id: string) => artifacts.store.notices(id);

try {
  // The case that went missing: a thread OptChat started wrote the review; the user merged it.
  threads.set("eb809312-0000-4000-8000-000000000001", { id: "eb809312-0000-4000-8000-000000000001", projectId: "p", archived: false, createdAt: Date.now() });
  const author = "eb809312-0000-4000-8000-000000000001";
  chat.started.add(author);
  const review = write({ kind: "thread", thread: author }, [116, 117], "review");
  working.add(author);
  const merged = await confirm(review, 116, "m1");
  assert.equal(merged.state, "succeeded");
  assert.deepEqual(merges, [{ pull: 116, sha: SHA }], "merged once, pinned to the reviewed head");
  // Recorded with the outcome, before any delivery.
  const recorded = notices(review);
  assert.deepEqual(recorded.map(notice => [notice.target.kind, notice.state]), [["thread", "queued"], ["starter", "queued"]]);
  // The chat is not open yet and the thread works: both wait, with the reason.
  await until(() => notices(review), list => list[0]!.note?.includes("thread is working") === true && list[1]!.note?.includes("chat is not open") === true, "both wait");
  assert.equal(prompts.size + chat.got.size, 0);
  chat.open = true;
  await until(() => notices(review)[1]!.state, state => state === "delivered", "the chat is told");
  const toChat = [...chat.got.values()][0]!;
  assert.match(toChat, /^\[artifact [0-9a-f]{8}\] The user confirmed "merge cubeyard\/cube#116" \(github\.merge cubeyard\/cube#116 at 6a26aa39f9ac, merge\) on the artifact "review" of thread \[eb809312\]/);
  assert.match(toChat, /Done: merged cubeyard\/cube#116 at 6a26aa39f9ac \(merge\); merge commit c35976b12ade\./);
  working.delete(author);
  await until(() => notices(review)[0]!.state, state => state === "delivered", "the thread is told once its turn ends");
  assert.match([...prompts.values()][0]!, /on your artifact "review".*Done: merged cubeyard\/cube#116/);
  // Many more tries change nothing: one message each, under one request id each.
  await Promise.all([artifacts.pump(), artifacts.pump(), artifacts.pump()]);
  assert.equal(prompts.size, 1);
  assert.equal(chat.got.size, 1);
  assert.deepEqual([...chat.got.keys()], [`report:artifact:${review}:action:${artifacts.store.actionRuns(review)[0]!.id}:starter:${author}`]);
  // A repeated request answers again and merges nothing; another is refused.
  assert.equal((await confirm(review, 116, "m1")).state, "succeeded");
  await assert.rejects(confirm(review, 116, "m2"), /already/);
  assert.equal(merges.length, 1);
  assert.equal(notices(review).length, 2, "no second notice for a repeated request");
  // What the author reads says who was told.
  assert.match(artifacts.read([{ kind: "thread", thread: author }], review), /action merge-116 \(revision 1\): succeeded: merged[\s\S]*told thread \[eb809312\]: delivered[\s\S]*told the chat: delivered/);

  // A failure is told as a failure, never as done; the next try is its own run and notice.
  mergeError = new GithubPullsError("github: Head branch was modified. Review and try the merge again.", 409);
  await assert.rejects(confirm(review, 117, "m3"), /not merged: github: Head branch was modified/);
  await until(() => notices(review).filter(notice => notice.state === "delivered").length, count => count === 4, "the failure is told");
  const failed = [...chat.got.values()].at(-1)!;
  assert.match(failed, /It did not succeed: github: Head branch was modified\. Review and try the merge again\. Nothing says it merged/);
  assert.doesNotMatch(failed, /Done:/);

  // A thread started in cube (not by the chat), older than the chat's grace to record one: the thread is told, the chat is not.
  threads.set("user-thread", { id: "user-thread", projectId: "p", archived: false, createdAt: Date.now() - 11 * 60_000 });
  const notes = write({ kind: "thread", thread: "user-thread" }, [118], "notes");
  const before = chat.got.size;
  await confirm(notes, 118, "m4");
  await until(() => notices(notes).map(notice => notice.state), states => states.join() === "delivered,skipped", "told the thread, skipped the chat");
  assert.equal(notices(notes)[1]!.note, "the chat did not start this thread");
  assert.equal(chat.got.size, before);
  assert.doesNotMatch(artifacts.read([{ kind: "thread", thread: "user-thread" }], notes), /told the chat/);

  // A thread so young the chat may not have recorded spawning it yet: the chat's notice waits, then goes once it has.
  threads.set("young-thread", { id: "young-thread", projectId: "p", archived: false, createdAt: Date.now() });
  open.add(122);
  const young = write({ kind: "thread", thread: "young-thread" }, [122], "young");
  await confirm(young, 122, "m-young");
  await until(() => notices(young)[1]!, notice => notice.note === "waiting: the chat has not recorded this thread as its own yet", "the chat's notice waits");
  chat.started.add("young-thread");
  await until(() => notices(young).map(notice => notice.state), states => states.join() === "delivered,delivered", "the chat is told once it has recorded the thread");

  // An archived author: nothing reaches it, and says so; the chat that started it is still told.
  threads.set("archived-thread", { id: "archived-thread", projectId: "p", archived: false, createdAt: Date.now() });
  chat.started.add("archived-thread");
  const late = write({ kind: "thread", thread: "archived-thread" }, [119], "late");
  threads.get("archived-thread")!.archived = true;
  await confirm(late, 119, "m5");
  await until(() => notices(late).map(notice => notice.state), states => states.join() === "undeliverable,delivered", "archived: the chat only");
  assert.match(notices(late)[0]!.note!, /archived/);

  // The chat's own artifact: told to the chat alone.
  const own = write({ kind: "optchat" }, [120], "own");
  // A run cut off mid-merge: cubed stops after GitHub was asked, before the outcome; told as unknown, never as failed or done.
  artifacts.close();
  store.beginAction(own, 1, "merge-120", "m6");
  store.close();
  store = new ArtifactStore(file);
  chat.open = false;
  artifacts = service();
  const cut = store.actionRuns(own)[0]!;
  assert.equal(cut.state, "failed");
  assert.match(cut.detail, /whether GitHub merged it is unknown/);
  assert.deepEqual(notices(own).map(notice => [notice.target.kind, notice.state]), [["optchat", "queued"]], "the restart wrote its notice");
  chat.open = true;
  await until(() => notices(own)[0]!.state, state => state === "delivered", "the unknown outcome is told");
  assert.match([...chat.got.values()].at(-1)!, /on your artifact "own".*Its outcome is unknown: cubed stopped while this ran, so whether GitHub merged it is unknown.*before saying either way/);
  // Delivered before the restart stays delivered: nothing is told twice.
  assert.equal(notices(review).filter(notice => notice.state === "delivered").length, 4);
  const sentBefore = chat.sends;
  await artifacts.pump();
  assert.equal(chat.sends, sentBefore, "a restart sends nothing already delivered");

  // Bounded: a notice that cannot go for the bound stops waiting and says why.
  artifacts.close();
  artifacts = service({ giveUpMs: 300 });
  threads.set("busy-thread", { id: "busy-thread", projectId: "p", archived: false, createdAt: 0 });
  open.add(121);
  const busy = write({ kind: "thread", thread: "busy-thread" }, [121], "busy");
  working.add("busy-thread");
  await confirm(busy, 121, "m7");
  await until(() => notices(busy)[0]!, notice => notice.state === "undeliverable", "gives up", 5000);
  assert.match(notices(busy)[0]!.note!, /stopped waiting; last: the thread is working/);
  assert.equal(notices(busy)[1]!.state, "skipped");
  console.log("ok: artifact notices: merge outcome told to the author and the starting chat once, waiting, archived, skipped, failures, a cut-off run after a restart, bounded");
} finally {
  artifacts.close();
  store.close();
  fs.rmSync(root, { recursive: true, force: true });
}
