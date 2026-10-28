/** A chat as OptChat's own log has it: a spawn of two threads, a third
 * that failed to start, a tell, reports, an artifact OptChat wrote and one
 * a thread wrote that the chat links, plus a spawn from an older record
 * whose thread cubed no longer has. Shared by the sheet's browser test and
 * its screenshots; every relationship here is one the log itself states. */
import type { ArtifactListItem, ThreadEvent, ThreadOverview, ThreadSummary } from "../../src/lib/types.ts";

export const ID = {
  composer: "aaaaaaa1-1111-4111-8111-111111111111",
  flaky: "bbbbbbb2-2222-4222-8222-222222222222",
  ca: "ccccccc3-3333-4333-8333-333333333333",
  gone: "ddddddd4-4444-4444-8444-444444444444",
  proposal: "eeeeeee5-5555-4555-8555-555555555555",
  review: "fffffff6-6666-4666-8666-666666666666",
};

const user = (id: string, text: string): ThreadEvent => ({ type: "user-message", id, text });
const report = (id: string, thread: string, text: string): ThreadEvent => ({ type: "user-message", id, text: `[${thread.slice(0, 8)}] ${text}`, from: thread.slice(0, 8) });
const agent = (id: string, text: string): ThreadEvent => ({ type: "assistant-text", id, text, reasoning: false, final: true });
const call = (id: string, callId: string, name: string, input: unknown): ThreadEvent => ({ type: "tool-call", id, callId, name, input, final: true });
const result = (id: string, callId: string, name: string, output: string, isError = false): ThreadEvent => ({ type: "tool-result", id, callId, name, output, isError, final: true });

const filler = (n: number): ThreadEvent[] => Array.from({ length: n }, (_, index) => [
  user(`f${index}.0`, `question ${index + 1}: how is the runner pool doing on the office machine this morning?`),
  agent(`f${index}.1`, `All runners answered within the last minute. The office machine has two free slots and nothing retained.\n\nNothing needs you there.`),
]).flat();

/** The chat's events; `older` puts an older record and filler before it. */
export function chatEvents(options: { filler?: number } = {}): ThreadEvent[] {
  return [
    user("o1.0", "start a thread on the java trust issue in keel-images"),
    call("o1.1", "spawn-old", "spawn", { tasks: [{ project: "keel-images", task: "java trusts the runner ca" }] }),
    // an older record: the line had no title then, and cubed no longer has the thread
    result("o1.2", "spawn-old", "spawn", `[${ID.gone.slice(0, 8)}] started in keel-images`),
    agent("o1.3", "Started it in keel-images."),
    ...filler(options.filler ?? 0),
    user("1.0", "the mobile composer feels cramped and the artifact test is flaky again. start threads for both, and one for the java trust in keel-images"),
    agent("2.0", "I'm starting three threads: one measures the composer on a phone, one finds why the artifact test flakes, one makes Java trust the runner's CA in keel-images."),
    call("2.1", "spawn-1", "spawn", { tasks: [
      { project: "cube", task: "composer room: measure the mobile composer and propose more space" },
      { project: "cube", task: "find why the artifact browser test is flaky" },
      { project: "keel-images", task: "java trusts runner ca" },
      { project: "nope", task: "a project that does not exist" },
    ] }),
    result("2.2", "spawn-1", "spawn", [
      `[${ID.composer.slice(0, 8)}] started in cube: composer room: measure the mobile composer and propose more space`,
      `[${ID.flaky.slice(0, 8)}] started in cube: find why the artifact browser test is flaky`,
      `[${ID.ca.slice(0, 8)}] started in keel-images: java trusts runner ca`,
      "task 4 (nope) not started: no project nope",
    ].join("\n")),
    agent("2.3", "Three are running. The fourth task named a project that does not exist, so it did not start."),
    report("3.0", ID.flaky, "turn ended. The test waited on a 140ms settle-in animation before reading the comment key. It now waits for the key's box to stop moving. PR #241 is open and CI is green."),
    agent("3.1", "The flaky test is fixed in [#241](https://github.com/cubeyard/cube/pull/241); CI is green. I'll leave the merge to you."),
    report("4.0", ID.composer, "turn ended. With the keyboard up on 390×844 there are 212px left for the conversation. I wrote a proposal with measurements."),
    agent("4.1", `composer room wrote a proposal: [composer room: more space on the phone](#/a/${ID.proposal}). It keeps the send key and folds the strip while typing.`),
    user("5.0", "go ahead, but keep the send key where it is"),
    call("5.1", "tell-1", "tell", { id: ID.composer.slice(0, 8), message: "go ahead with the proposal; keep the send key where it is" }),
    result("5.2", "tell-1", "tell", `sent to [${ID.composer.slice(0, 8)}]; its report comes back as a message starting "[${ID.composer.slice(0, 8)}] "`),
    agent("5.3", "Told composer room to go ahead and keep the send key."),
    user("6.0", "write me a short review of today's work"),
    call("6.1", "write-1", "artifact_write", { title: "today's review", body: "# today's review\n\n…" }),
    result("6.2", "write-1", "artifact_write", `artifact ${ID.review} "today's review" created at revision 1. The user opens it at #/a/${ID.review} (link it in your reply as [today's review](#/a/${ID.review})); their comments come back to you as a message starting "[artifact ${ID.review.slice(0, 8)}]".`),
    agent("6.3", `Here it is: [today's review](#/a/${ID.review}). The java trust thread failed on its machine; I'll look at it when you want.`),
  ];
}

const thread = (id: string, project: string, title: string, state: string, archived = false) =>
  ({ id, title, project: { id: project, name: project }, state, archived, spawned: Date.now() - 4 * 60_000 });

export const overview = (states: { composer?: string; flaky?: string; ca?: string } = {}): ThreadOverview => ({
  threads: [
    thread(ID.composer, "cube", "composer room: measure the mobile composer and propose more space", states.composer ?? "working"),
    thread(ID.flaky, "cube", "find why the artifact browser test is flaky", states.flaky ?? "completed"),
    thread(ID.ca, "keel-images", "java trusts runner ca", states.ca ?? "machine failed"),
  ],
  archived: { shown: 0, total: 2 }, unknown: 1,
});

export const threads: ThreadSummary[] = [
  { id: ID.composer, title: "composer room: measure the mobile composer and propose more space", state: "ready", error: null, createdAt: Date.now() - 600_000, archived: false, project: { id: "cube", name: "cube" } },
  { id: ID.flaky, title: "find why the artifact browser test is flaky", state: "ready", error: null, createdAt: Date.now() - 600_000, archived: false, project: { id: "cube", name: "cube" } },
  { id: ID.ca, title: "java trusts runner ca", state: "error", error: "machine failed", createdAt: Date.now() - 600_000, archived: false, project: { id: "keel-images", name: "keel-images" } },
];

const artifact = (id: string, title: string, head: number, author: ArtifactListItem["author"], comments: Partial<ArtifactListItem["comments"]> = {}): ArtifactListItem => ({
  id, title, head, author, createdAt: Date.now() - 3_600_000, updatedAt: Date.now() - 120_000, projectId: "cube",
  comments: { draft: 0, queued: 0, delivered: 0, undeliverable: 0, ...comments },
  project: { id: "cube", name: "cube" }, thread: author.kind === "thread" ? { id: author.thread, title: "composer room", archived: false } : null,
});

export const artifacts: ArtifactListItem[] = [
  artifact(ID.review, "today's review", 1, { kind: "optchat" }),
  artifact(ID.proposal, "composer room: more space on the phone", 2, { kind: "thread", thread: ID.composer }, { delivered: 3 }),
];

export const bodies: Record<string, string> = {
  [ID.proposal]: "# composer room: more space on the phone\n\nWith the keyboard up on a 390×844 phone, 212px are left for the conversation.\n\n- fold the strip while typing\n- keep the send key",
  [ID.review]: "# today's review\n\nTwo threads reported, one failed on its machine.",
};
