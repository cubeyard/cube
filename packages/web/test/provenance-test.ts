/** The chat's margin reads only what its own log states: spawn result
 * lines, artifact tool results, artifact links and comment messages; and
 * places its notes without overlap and without growing the page. */
import assert from "node:assert/strict";
import { place } from "../src/lib/margin-layout.ts";
import { chatToolLine, excerpt, latestReports, mentionsOf, indexThreads, resolveArtifact, resolveThread, spawnLines } from "../src/lib/provenance.ts";
import { transcriptRows } from "../src/lib/transcript.ts";
import { failing, moving, stateText } from "../src/lib/work-state.ts";
import type { ArtifactListItem, OverviewThread, ThreadEvent, ThreadSummary } from "../src/lib/types.ts";
import { artifacts, chatEvents, ID, overview, threads } from "./browser/chat-sheet-data.ts";

// spawn lines: today's, an older record without a title, a newer cubed's name, a failure
assert.deepEqual(spawnLines([
  "[aaaaaaa1] started in cube: composer room: more space",
  "[bbbbbbb2] started in keel-images",
  "[ccccccc3] started in cube as 🦦 calm otter: java trust",
  "task 4 (nope) not started: no project nope",
  "something else entirely",
].join("\n")), {
  threads: [
    { short: "aaaaaaa1", project: "cube", title: "composer room: more space" },
    { short: "bbbbbbb2", project: "keel-images", title: null },
    { short: "ccccccc3", project: "cube", title: "java trust" },
  ],
  unstarted: [{ task: 4, project: "nope", reason: "no project nope" }],
});

const rows = transcriptRows({ events: chatEvents(), status: { state: "completed", run: "r", error: null } });
const mentions = mentionsOf(rows);
assert.deepEqual(mentions.map(mention => ({ row: mention.row, threads: mention.threads.map(thread => thread.short), artifacts: mention.artifacts, unstarted: mention.unstarted.length })), [
  { row: "call:spawn-old", threads: [ID.gone.slice(0, 8)], artifacts: [], unstarted: 0 },
  // composer room was told later: its note is at that tell, not twice
  { row: "call:spawn-1", threads: [ID.flaky.slice(0, 8), ID.ca.slice(0, 8)], artifacts: [], unstarted: 1 },
  { row: "4.1", threads: [], artifacts: [ID.proposal], unstarted: 0 },
  { row: "call:tell-1", threads: [ID.composer.slice(0, 8)], artifacts: [], unstarted: 0 },
  // written by a tool, then linked in the reply: one note, at the write
  { row: "call:write-1", threads: [], artifacts: [ID.review], unstarted: 0 },
], "each artifact once, at its first row; each thread once, at its spawn or the last tell it took; a report adds none");
assert.deepEqual(mentions.find(mention => mention.row === "call:tell-1")!.threads, [{ short: ID.composer.slice(0, 8), project: "cube", title: "composer room: measure the mobile composer and propose more space" }],
  "a note at a tell keeps what the spawn line said of the thread");

// tells: the thread comes back beside the last tell it took, once; a tell it
// did not take (refused, dropped, an error, one still running) moves nothing
{
  const A = "aaaaaaa1", B = "bbbbbbb2";
  const spawn = (id: string): ThreadEvent[] => [
    { type: "tool-call", id: `${id}.c`, callId: id, name: "spawn", input: { tasks: [] }, final: true },
    { type: "tool-result", id: `${id}.r`, callId: id, name: "spawn", output: `[${A}] started in cube: first\n[${B}] started in cube: second`, isError: false, final: true },
  ];
  const tell = (id: string, output: string, isError = false, done = true): ThreadEvent[] => [
    { type: "tool-call", id: `${id}.c`, callId: id, name: "tell", input: { id: A, message: "go on" }, final: true },
    ...done ? [{ type: "tool-result", id: `${id}.r`, callId: id, name: "tell", output, isError, final: true } as ThreadEvent] : [],
  ];
  const placed = (events: ThreadEvent[], state: "completed" | "working" = "completed") => mentionsOf(transcriptRows({ events, status: { state, run: "r", error: null } }))
    .map(mention => [mention.row, mention.threads.map(thread => thread.short)]);
  const report = `its report comes back as a message starting "[${A}] "`;
  const sent = `sent to [${A}]; ${report}`;
  const queued = `queued for [${A}], which is working: it has not read it yet, and reads it after its current tool call, in this turn; ${report}`;
  const consumed = `[${A}] already has it in its conversation; ${report}`;
  const user = (id: string, text: string): ThreadEvent => ({ type: "user-message", id, text });

  assert.deepEqual(placed([...spawn("s"), user("u1", "and then"), ...tell("t1", sent)]), [["call:s", [B]], ["call:t1", [A]]], "a sent tell brings the thread back beside it");
  assert.deepEqual(placed([...spawn("s"), ...tell("t1", sent), user("u1", "more"), ...tell("t2", queued)]), [["call:s", [B]], ["call:t2", [A]]], "a repeated tell moves it to the newest; never twice");
  assert.deepEqual(placed([...spawn("s"), ...tell("t1", queued)]), [["call:s", [B]], ["call:t1", [A]]], "a tell queued into a working thread's turn counts");
  assert.deepEqual(placed([...spawn("s"), ...tell("t1", consumed)]), [["call:s", [B]], ["call:t1", [A]]], "a replayed tell the thread already has counts");
  for (const [what, events] of [
    ["refused", tell("t1", `not sent: [${A}] had 3 tells from you since the user's last message; tell the user what it needs instead`)],
    ["dropped", tell("t1", `[${A}] took it while working, but it never reached the agent; ${report}, saying why`)],
    ["an error", tell("t1", `no thread ${A}`, true)],
  ] as const) assert.deepEqual(placed([...spawn("s"), ...events]), [["call:s", [A, B]]], `a ${what} tell moves nothing`);
  assert.deepEqual(placed([...spawn("s"), ...tell("t1", "", false, false)], "working"), [["call:s", [A, B]]], "a tell still running moves nothing yet");
  assert.deepEqual(placed([...spawn("s"), ...tell("t1", sent), ...tell("t2", `not sent: [${A}] had 3 tells`)]), [["call:s", [B]], ["call:t1", [A]]], "a refused tell after a sent one leaves it at the sent one");
  // its spawn is not among the rows shown (an older page): the tell alone gives it a note, with only its id
  assert.deepEqual(mentionsOf(transcriptRows({ events: tell("t1", sent), status: { state: "completed", run: "r", error: null } })),
    [{ row: "call:t1", threads: [{ short: A, project: null, title: null }], artifacts: [], unstarted: [] }], "a thread whose spawn is out of the rows shown comes back at its tell");
  // a spawn whose every thread was told later keeps only what did not start
  assert.deepEqual(placed([...spawn("s"), ...tell("t1", sent), ...tell("t2", sent.replaceAll(A, B))]), [["call:t1", [A]], ["call:t2", [B]]], "a spawn left with nothing to show has no note");
}

// a spawn still running, or one that failed, starts nothing yet
const running: ThreadEvent[] = [{ type: "tool-call", id: "1", callId: "s", name: "spawn", input: { tasks: [] }, final: true }];
assert.deepEqual(mentionsOf(transcriptRows({ events: running, status: { state: "working", run: "r", error: null } })), []);
const failed: ThreadEvent[] = [...running, { type: "tool-result", id: "2", callId: "s", name: "spawn", output: "[aaaaaaa1] started in cube: x", isError: true, final: true }];
assert.deepEqual(mentionsOf(transcriptRows({ events: failed, status: { state: "completed", run: "r", error: null } })), [], "an error result is not believed");

// reasoning names nothing; a comment message names its artifact by prefix
const talk: ThreadEvent[] = [
  { type: "assistant-text", id: "1", text: `maybe #/a/${ID.review}`, reasoning: true, final: true },
  { type: "user-message", id: "2", text: `[artifact ${ID.review.slice(0, 8)}] two comments on revision 1` },
  { type: "assistant-text", id: "3", text: `see [it](#/a/${ID.review}?rev=1)`, reasoning: false, final: true },
];
assert.deepEqual(mentionsOf(transcriptRows({ events: talk, status: { state: "completed", run: "r", error: null } })).map(mention => [mention.row, mention.artifacts]), [["2", [ID.review.slice(0, 8)]]]);

// resolution: the overview's state first, then the list; "not known to cube"
// only once both were read, the thread is in neither and cube counts lost ones
const full = overview();
const seen = full.threads as OverviewThread[];
const archived: ThreadSummary[] = [...threads, { ...threads[0]!, id: "eeeeeee9-0000-4000-8000-000000000000", title: "old", archived: true }];
assert.deepEqual(resolveThread({ short: ID.ca.slice(0, 8), project: "x", title: "y" }, indexThreads(full, threads, true)),
  { short: ID.ca.slice(0, 8), id: ID.ca, title: "java trusts runner ca", project: "keel-images", state: "machine failed", archived: false, known: "overview", spawned: seen[2]!.spawned });
assert.equal(resolveThread({ short: "eeeeeee9", project: null, title: null }, indexThreads(full, archived, true)).state, "archived");
assert.equal(resolveThread({ short: "eeeeeee9", project: null, title: null }, indexThreads(full, archived, true)).known, "list");
const gone = { short: ID.gone.slice(0, 8), project: "keel-images", title: null };
assert.deepEqual(resolveThread(gone, indexThreads(full, threads, true)),
  { short: ID.gone.slice(0, 8), id: null, title: null, project: "keel-images", state: null, archived: false, known: "none", spawned: null });
assert.equal(resolveThread(gone, indexThreads(null, [], false)).known, "pending", "nothing read yet: nothing claimed");
assert.equal(resolveThread(gone, indexThreads(full, [], false)).known, "pending", "the overview alone does not know archived threads");
assert.equal(resolveThread(gone, indexThreads(null, threads, true)).known, "pending", "the overview not read (or failed): not claimed lost");
assert.equal(resolveThread(gone, indexThreads({ ...full, unknown: 0 }, threads, true)).known, "pending", "cube counts none lost: not claimed lost");
assert.equal(resolveThread({ short: ID.composer.slice(0, 8), project: null, title: null }, indexThreads(null, threads, true)).state, null, "no overview yet: no state is guessed");
assert.equal(resolveThread({ short: ID.composer.slice(0, 8), project: null, title: null }, indexThreads(null, threads, true)).known, "list");
// the index keeps the first of two ids that share a short id, as a walk would; a shorter key still walks
const sharing: ThreadSummary[] = [{ ...threads[0]!, id: "ffffffff-0000-4000-8000-000000000001", title: "first" }, { ...threads[0]!, id: "ffffffff-0000-4000-8000-000000000002", title: "second" }];
assert.equal(resolveThread({ short: "ffffffff", project: null, title: null }, indexThreads(null, sharing, true)).title, "first");
assert.equal(resolveThread({ short: "ffff", project: null, title: null }, indexThreads(null, sharing, true)).title, "first");

assert.equal(resolveArtifact(ID.review, artifacts)?.title, "today's review");
assert.equal(resolveArtifact(ID.proposal.slice(0, 8), artifacts)?.title, "composer room: more space on the phone");
assert.equal(resolveArtifact("12345678", artifacts), null);
assert.equal(resolveArtifact(ID.review, null), null);
const twins = [artifacts[0]!, { ...artifacts[0]!, id: `${ID.review.slice(0, 8)}-0000-4000-8000-000000000000` }] as ArtifactListItem[];
assert.equal(resolveArtifact(ID.review.slice(0, 8), twins), null, "an ambiguous prefix names nothing");

assert.deepEqual([...latestReports(rows).keys()], [ID.flaky.slice(0, 8), ID.composer.slice(0, 8)]);
assert.equal(excerpt("# title\n\nWith the **keyboard** up, see [this](#/x).\n\n- fold the strip\n- keep send-key"), "With the keyboard up, see this. fold the strip keep send-key");
assert.equal(excerpt("a".repeat(300), 10), `${"a".repeat(9)}…`);

// work states, in cubed's own words
assert.equal(stateText("completed"), "turn ended");
assert.ok(moving("waiting for a runner") && moving("starting") && !moving("completed"));
assert.ok(failing("machine failed") && failing("machine error") && failing("failed") && !failing("stopped"));
// only the chat's own write tool counts as writing an artifact
assert.deepEqual(mentionsOf(transcriptRows({ events: [
  { type: "tool-call", id: "1", callId: "e", name: "artifact_edit", input: {}, final: true },
  { type: "tool-result", id: "2", callId: "e", name: "artifact_edit", output: `artifact ${ID.review} "x" wrote revision 2.`, isError: false, final: true },
], status: { state: "completed", run: "r", error: null } })), []);

// layout: in anchor order, no overlap, a held note at its anchor, never past the end
const tall = [{ anchor: 0, height: 100 }, { anchor: 20, height: 50 }, { anchor: 30, height: 40 }, { anchor: 400, height: 30 }];
assert.deepEqual(place(tall, { gap: 10 }), [0, 110, 170, 400]);
assert.deepEqual(place(tall, { gap: 10, hold: 1 }), [0, 110, 170, 400], "a held note that cannot go up keeps the top free");
assert.deepEqual(place([{ anchor: 0, height: 20 }, { anchor: 200, height: 100 }, { anchor: 210, height: 20 }], { gap: 10, hold: 2 }), [0, 100, 210], "the held note stays; the one before moves up");
assert.deepEqual(place([{ anchor: 0, height: 20 }, { anchor: 280, height: 40 }, { anchor: 290, height: 40 }], { gap: 10, limit: 300 }), [0, 210, 260], "past the end they move up");
assert.deepEqual(place([{ anchor: 0, height: 200 }, { anchor: 10, height: 200 }], { gap: 10, limit: 300 }), [0, 210], "with no room, they overflow down rather than above the top");
assert.deepEqual(place([]), []);
for (let trial = 0; trial < 200; trial++) {
  const notes = Array.from({ length: 1 + (trial % 9) }, (_, i) => ({ anchor: i * 37 + ((trial * 13 + i * 7) % 50), height: 18 + ((trial + i) * 11) % 90 }));
  const hold = trial % 3 === 0 ? trial % notes.length : null;
  const tops = place(notes, { gap: 6, limit: 2000, hold });
  for (let i = 1; i < tops.length; i++) assert.ok(tops[i]! >= tops[i - 1]! + notes[i - 1]!.height + 6 - 1e-9, `no overlap (${trial})`);
  assert.ok(tops[0]! >= 0, "never above the top");
}
// the chat's tools in plain words; anything else keeps its raw line
const tool = (callId: string) => rows.find(row => row.kind === "tool" && row.callId === callId) as Extract<typeof rows[number], { kind: "tool" }>;
const titles = (short: string) => short === ID.composer.slice(0, 8) ? "composer room" : null;
assert.equal(chatToolLine(tool("spawn-1"), titles), "started 3 threads · 1 not started");
assert.equal(chatToolLine(tool("spawn-old"), titles), "started 1 thread");
assert.equal(chatToolLine(tool("tell-1"), titles), "told composer room");
assert.equal(chatToolLine({ ...tool("tell-1"), output: "", state: "waiting" }, () => null), `told [${ID.composer.slice(0, 8)}]`, "from its input while it runs");
assert.equal(chatToolLine({ ...tool("tell-1"), output: `not sent: [${ID.composer.slice(0, 8)}] had 3 tells` }, titles), "not sent to composer room");
assert.equal(chatToolLine(tool("write-1"), titles), "created today's review · revision 1");
assert.equal(chatToolLine({ ...tool("spawn-1"), state: "running" }, titles), "starting threads…");
assert.equal(chatToolLine({ ...tool("spawn-1"), state: "error" }, titles), null);
assert.equal(chatToolLine({ ...tool("spawn-1"), name: "bash" }, titles), null);
console.log("provenance: ok");
