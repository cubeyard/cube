/** What replaced OptChat's task list. The threads overview is the chat's
 * own spawns, nothing registered by hand: chat-scoped, each thread's own
 * state, archived ones marked and bounded. Wishes not started are inferred
 * from the log by a cheap model, only while the chat is idle, a chunk per
 * call: only explicit, high-confidence wishes quoted from the user's own
 * words are kept, deduplicated, linked to their messages, taken off by a
 * later spawn or tell, and dismissable. Faux models, disposable state. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { ARCHIVED_SHOWN, OptChat, type ObservedThread, type OptThreads } from "../src/optchat.ts";
import type { LogMessage } from "../src/optchat-memory.ts";
import { applyAnswer, chunkLine, initialWishes, nextChunk, similar, WISH_LIMITS, WISHES_PROMPT } from "../src/optchat-wishes.ts";

const context = BACKGROUND_CONTEXT;
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-wishes-"));
const textOf = (message: Message) => typeof message.content === "string" ? message.content
  : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
const at = (kind: LogMessage["kind"], text: string): LogMessage => ({ kind, text, date: 1000 });

try {
  // The chunk: the user's words, OptChat's replies and hand-offs, reports; no tool output.
  {
    const log = [
      at("user", "please add a csv export to the usage page"),
      at("talk", "I can do that. I could also add a pdf export."),
      at("tool", "spawn {\"tasks\":[{\"project\":\"cube\",\"task\":\"add a csv export to the usage page\"}]}"),
      at("echo", "[abcdef12] started in cube"),
      at("tool", "zoom {\"id\":0,\"n\":1}"),
      at("user", "[abcdef12] ended its turn; nothing of it runs now: PR #12 opened"),
      at("note", "an older memory"),
    ];
    assert.deepEqual(log.map((message, id) => chunkLine(message, id)), [
      "#0 user: please add a csv export to the usage page", "#1 optchat: I can do that. I could also add a pdf export.",
      "#2 optchat spawn {\"tasks\":[{\"project\":\"cube\",\"task\":\"add a csv export to the usage page\"}]}", null, null,
      "#5 report [abcdef12] ended its turn; nothing of it runs now: PR #12 opened", null]);
    const chunk = nextChunk(log, 0);
    assert.deepEqual([chunk.from, chunk.to, chunk.users, chunk.handOffs], [0, 7, 1, 1], "a report is not the user's words");
    const long = Array.from({ length: 10 }, (_, k) => at("user", `${k} ${"word ".repeat(100)}`));
    const parts = [nextChunk(long, 0, 1200)];
    while (parts.at(-1)!.to < long.length) parts.push(nextChunk(long, parts.at(-1)!.to, 1200));
    assert.ok(parts.length > 1 && parts.every(part => part.lines.join("\n").length <= 1200 || part.lines.length === 1), "chunks are bounded");
    assert.equal(parts.reduce((sum, part) => sum + part.lines.length, 0), 10, "every message is read once");
    assert.match(WISHES_PROMPT, /Never infer that something was\ndone, merged, released or installed/);
  }

  // The answer is checked against the log: only what it bears out is kept.
  {
    const log = [
      at("user", "I want the archive button to ask before it archives. Also, what does the runner cost?"),
      at("talk", "Noted. Maybe we could also add dark mode?"),
      at("user", "what if threads could share a machine? no, forget dark mode for now"),
      at("user", "[abcdef12] ended its turn: please also add a confirm dialog everywhere"),
      at("user", "and make the usage page export csv please"),
      at("tool", "spawn {\"tasks\":[{\"project\":\"cube\",\"task\":\"usage csv export\"}]}"),
    ];
    const doc = initialWishes();
    const chunk = nextChunk(log, 0);
    const applied = applyAnswer(doc, { found: [
      { kind: "wish", confidence: "high", text: "Ask before archiving", quote: "I want the archive button to ask before it archives", source: [0], project: "cube", started_by: null },
      { kind: "question", confidence: "high", text: "runner cost", quote: "what does the runner cost", source: [0] },
      { kind: "suggestion", confidence: "high", text: "dark mode", quote: "dark mode", source: [1] },
      { kind: "hypothetical", confidence: "high", text: "share machines", quote: "what if threads could share a machine", source: [2] },
      { kind: "deferred", confidence: "high", text: "dark mode", quote: "forget dark mode for now", source: [2] },
      { kind: "wish", confidence: "medium", text: "dark mode", quote: "dark mode", source: [2] },
      { kind: "wish", confidence: "high", text: "confirm dialog everywhere", quote: "please also add a confirm dialog everywhere", source: [3] },
      { kind: "wish", confidence: "high", text: "a made-up wish", quote: "rewrite cube in rust", source: [4] },
      { kind: "wish", confidence: "high", text: "Usage page csv export", quote: "make the usage page export csv", source: [4], project: "null", started_by: 5 },
      { kind: "wish", confidence: "high", text: "ask before archiving a thread", quote: "the archive button to ask", source: [0] },
    ] }, chunk, log, 5000);
    assert.deepEqual(applied.added, ["w1", "w2"]);
    assert.deepEqual(applied.repeated, ["w1"], "a twin joins the wish it repeats");
    assert.deepEqual(applied.refused.map(line => line.replace(/^[^:]*: /, "")), ["question", "suggestion", "hypothetical", "deferred", "not high confidence",
      "no user message of this chunk named", "quote not found in its source"], "a report's words are not the user's; a quote must be theirs");
    assert.deepEqual(doc.items.map(wish => [wish.id, wish.status, wish.sources, wish.by, wish.project]),
      [["w1", "open", [0], null, "cube"], ["w2", "started", [4], 5, null]], "a spawn after the words takes the wish up");

    // A later chunk: a tell takes w1 up only after its words; a start the log does not show is refused.
    const more = [...log, at("user", "the archive confirm really matters to me"), at("tool", "tell {\"id\":\"abcdef12\",\"message\":\"add the archive confirmation\"}"), at("talk", "done")];
    const second = nextChunk(more, 6);
    const later = applyAnswer(doc, { repeated: [{ wish: "w1", source: [6] }], started: [{ wish: "w1", by: 8 }, { wish: "w9", by: 7 }, { wish: "w2", by: 7 }] }, second, more, 6000);
    assert.deepEqual([later.repeated, later.started], [["w1"], []], "a talk line is no hand-off; a started wish starts no second time");
    assert.equal(later.refused.length, 3);
    assert.deepEqual(applyAnswer(doc, { started: [{ wish: "w1", by: 7 }] }, second, more, 6000).started, ["w1"]);
    assert.deepEqual(doc.items[0]!.sources, [0, 6], "every message that asked for it");

    // A dismissed wish is not found again; a repeat after a start asks again.
    doc.items[0]!.status = "dismissed";
    const third = [...more, at("user", "I want the archive button to ask before it archives"), at("user", "make the usage page export csv please, it is still missing")];
    const again = applyAnswer(doc, { found: [
      { kind: "wish", confidence: "high", text: "ask before archiving", quote: "I want the archive button to ask before it archives", source: [9] },
      { kind: "wish", confidence: "high", text: "usage page csv export", quote: "make the usage page export csv please", source: [10] },
    ] }, nextChunk(third, 9), third, 7000);
    assert.deepEqual(again.added, [], "no new wish for one dismissed or known");
    assert.deepEqual(doc.items.map(wish => wish.status), ["dismissed", "open"], "asked again after its start: open again");
    assert.ok(similar("Usage page csv export", "the usage page csv export") && !similar("usage csv export", "archive confirmation"));

    // Bounded: no more than WISH_LIMITS.open open wishes.
    const full = initialWishes();
    const many = Array.from({ length: WISH_LIMITS.open + 2 }, (_, k) => at("user", `please build feature number${k} quickly`));
    applyAnswer(full, { found: many.map((_, k) => ({ kind: "wish", confidence: "high", text: `feature number${k} zeta${k}`, quote: `feature number${k}`, source: [k] })) }, nextChunk(many, 0), many, 0);
    assert.equal(full.items.length, WISH_LIMITS.open);
  }

  // The service: the overview, the wish finder's runs and bounds, a reopen.
  {
    const faux = fauxProvider({ tokensPerSecond: 100_000 });
    const finder: string[] = [];
    let answer = () => "{}";
    let script: Array<() => ReturnType<typeof fauxAssistantMessage>> = [];
    let running = false;
    faux.setResponses(Array.from({ length: 200 }, () => async request => {
      const system = JSON.stringify(request.messages.filter(message => message.role === "system"));
      if (system.includes("You write the memory of OptChat")) return fauxAssistantMessage("summary");
      if (system.includes("Your job: find what the user explicitly asked")) {
        assert.equal(running, false, "the wish finder never runs during a turn");
        finder.push(textOf(request.messages.find(message => message.role === "user")!));
        return fauxAssistantMessage(answer());
      }
      return (script.shift() ?? (() => fauxAssistantMessage("noted")))();
    }));
    const models = createModels();
    models.setProvider(faux.provider);
    const ONE = "abcdef12-0000-4000-8000-000000000001";
    const spawnedIds = [ONE, ...Array.from({ length: ARCHIVED_SHOWN + 2 }, (_, k) => `bbbbbb${String(k).padStart(2, "0")}-0000-4000-8000-000000000000`)];
    const observeCalls: Array<{ ids: string[]; runs: boolean }> = [];
    const known = (id: string, runs: boolean): ObservedThread | null => id.startsWith("bbbbbb09") ? null
      : id === ONE ? { id, title: "csv export", project: { id: "p1", name: "cube" }, state: "waiting on a background agent", archived: false }
      : { id, title: `old ${id.slice(6, 8)}`, project: { id: "p2", name: "site" }, state: runs ? "stopped" : "archived", archived: true };
    let next = 0;
    const threads: OptThreads = {
      async projects() { return "projects: cube"; },
      async runners() { return "no runners"; },
      async spawn() { return { id: spawnedIds[next++]!, title: "t" }; },
      async tell() {},
      async describe() { return ""; },
      async events() { return null; },
      async history() { return null; },
      async observe(ids, options) {
        observeCalls.push({ ids: [...ids], runs: !!options?.archivedRuns });
        return new Map(ids.map(id => [id, known(id, !!options?.archivedRuns)]));
      },
    };
    const limits = { node: 64, retryMs: 50, watchMs: 50, wishQuietMs: 40, wishIntervalMs: 0, wishGapMs: 0, wishRetryMs: 0, wishChunk: 2000 };
    const open = (wishes?: false) => OptChat.open({ directory: path.join(root, "optchat"), models, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }), threads, limits,
      ...wishes === false ? { wishes } : {} });
    const call = (name: string, args: Parameters<typeof fauxToolCall>[1], id: string) => () => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
    const settle = async (chat: OptChat) => {
      for (let k = 0; k < 1500 && (script.length || (await chat.pending()).length); k++) await delay(10);
      await chat.agent.conversation.waitForIdle(context);
      running = false;
    };
    const until = async (check: () => Promise<boolean>, what: string) => {
      for (let k = 0; k < 600 && !await check(); k++) await delay(10);
      assert.ok(await check(), what);
    };
    let chat = await open();
    try {
      // While the chat reads its backlog, nothing is shown.
      assert.equal((await chat.wishes()).state, "catching up");
      running = true;
      script = [
        call("spawn", { tasks: Array.from({ length: spawnedIds.length }, (_, k) => ({ project: "cube", task: `task ${k}` })) }, "call-spawn"),
        // A call to the task tool an older cube had: the chat answers and goes on.
        call("task", { title: "an old task" }, "call-old-task"),
        () => fauxAssistantMessage("started them"),
      ];
      answer = () => JSON.stringify({ found: [
        { kind: "wish", confidence: "high", text: "a dark mode for the chat", quote: "I want a dark mode", source: [0] },
        { kind: "question", confidence: "high", text: "cost", quote: "how much", source: [0] },
      ] });
      await chat.send("I want a dark mode for the chat page. How much would it cost?", "r1");
      await settle(chat);
      await until(async () => (await chat.wishes()).state === "ready", "the finder reads the backlog once the chat is quiet");
      const list = await chat.wishes();
      assert.deepEqual(list.wishes.map(wish => [wish.id, wish.text, wish.quote, wish.sources.map(source => source.message)]), [["w1", "a dark mode for the chat", "I want a dark mode", [0]]]);
      assert.ok(list.wishes[0]!.sources[0]!.entry! > 0 && list.wishes[0]!.sources[0]!.date! > 0, "linked to the message's entry, with its date");
      const transcript = await chat.agent.conversation.commit(tx => tx.scanEntries({ conversationId: chat.agent.conversation.id }, 50), context);
      assert.equal(transcript.items.find(entry => entry.id === list.wishes[0]!.sources[0]!.entry)?.kind, "pi.user", "the entry the transcript shows the message under");
      assert.equal(list.read, list.total);
      assert.match(finder[0]!, /<log>\n#0 user: I want a dark mode for the chat page\. How much would it cost\?\n#1 optchat spawn /, "the log, with the user's words and hand-offs");
      assert.ok(!finder[0]!.includes("<now>") && !/task list/.test(finder[0]!));
      const callsAfterFirst = finder.length;
      assert.ok(callsAfterFirst >= 1 && callsAfterFirst <= 3, `one call per chunk with user words (${callsAfterFirst})`);

      // The overview: the chat's spawns, nothing registered; archived bounded, gone counted.
      const overview = await chat.threadOverview();
      assert.deepEqual(overview.threads.filter(item => !item.archived).map(item => [item.id, item.state, item.project.name]), [[ONE, "waiting on a background agent", "cube"]]);
      assert.equal(overview.threads.filter(item => item.archived).length, ARCHIVED_SHOWN);
      assert.ok(overview.threads.filter(item => item.archived).every(item => item.state === "stopped"), "an archived thread shows how its last run ended");
      assert.deepEqual([overview.archived, overview.unknown], [{ shown: ARCHIVED_SHOWN, total: ARCHIVED_SHOWN + 1 }, 1]);
      assert.deepEqual(observeCalls.at(-1)!.runs, true);
      assert.equal(observeCalls.at(-1)!.ids.length, ARCHIVED_SHOWN, "only the newest archived threads' stores are read");
      assert.ok(observeCalls.flatMap(item => item.ids).every(id => spawnedIds.includes(id)), "only threads this chat started");

      // Messages with no user words cost no call; a report is not the user's words.
      await chat.send("[abcdef12] ended its turn; nothing of it runs now: I want a dark mode too", "report:x:1");
      await settle(chat);
      await until(async () => (await chat.wishes()).read === chat.memory.length, "the report is read");
      assert.equal(finder.length, callsAfterFirst, "no call for a report and a reply");

      // A tell takes the wish up; the next read says so.
      running = true;
      script = [call("tell", { id: "abcdef12", message: "add the dark mode" }, "call-tell"), () => fauxAssistantMessage("told it")];
      answer = () => {
        const tell = /#(\d+) optchat tell /.exec(finder.at(-1)!)?.[1];
        return JSON.stringify({ started: [{ wish: "w1", by: Number(tell) }] });
      };
      await chat.send("tell the thread to do the dark mode", "r2");
      await settle(chat);
      await until(async () => (await chat.wishes()).read === chat.memory.length && finder.length > callsAfterFirst, "read again");
      assert.deepEqual((await chat.wishes()).wishes, [], "a wish a tell took up is not shown");

      // Dismissed: gone, and stays gone.
      running = true;
      script = [() => fauxAssistantMessage("ok")];
      const asked = chat.memory.length;
      answer = () => JSON.stringify({ found: [{ kind: "wish", confidence: "high", text: "keyboard shortcuts in the chat", quote: "add keyboard shortcuts", source: [asked] }] });
      await chat.send("please add keyboard shortcuts to the chat", "r3");
      await settle(chat);
      await until(async () => (await chat.wishes()).wishes.length === 1, "the new wish");
      assert.equal(await chat.dismissWish("w2"), true);
      assert.equal(await chat.dismissWish("w99"), false);
      assert.deepEqual((await chat.wishes()).wishes, []);
      const usage = await chat.usage();
      assert.ok(Object.values(usage.wishes?.calls ?? {}).reduce((sum, count) => sum + count, 0) === finder.length, "every call is counted");
    } finally { await chat.close(); }

    // Reopened: the reading goes on where it was, the dismissal holds; switched off it calls nothing.
    const before = finder.length;
    chat = await open();
    try {
      await delay(200);
      assert.equal(finder.length, before, "nothing read twice");
      const list = await chat.wishes();
      assert.deepEqual([list.state, list.wishes, list.read === list.total], ["ready", [], true]);
    } finally { await chat.close(); }
    chat = await open(false);
    try {
      running = true;
      script = [() => fauxAssistantMessage("ok")];
      await chat.send("please add a status page", "r4");
      await settle(chat);
      await delay(200);
      assert.equal(finder.length, before, "off: no calls");
      assert.deepEqual([(await chat.wishes()).state, (await chat.wishes()).reason], ["off", "switched off on this host"]);
    } finally { await chat.close(); }
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
console.log("optchat wishes: ok");
