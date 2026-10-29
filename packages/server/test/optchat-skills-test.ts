/** OptChat's skills: the skills of the `optchat` and `both` surfaces from
 * the skill sources in cube's settings, listed in OptChat's prompt by id
 * and description only (never a body) and read with its skill tool at
 * their pinned commits; `thread` and hidden skills are not listed and not
 * read, a path leaves no skill's folder, a long file comes in pages that
 * never split a character. One resolution per configuration, shared and
 * cancelled by no caller, a failed one tried again only after a while.
 * The prompt is the same, byte for byte, across turns and restarts (a cold
 * mirror and an unreachable source too), changes once when the skill
 * settings do, never within a turn (a list resolved mid-turn waits for the
 * next one), and a list slow or failing to resolve costs one bounded wait
 * per configuration, not one per request. Real cubed (HTTP routes,
 * settings) and real OptChat.open, real git over file:// repositories,
 * faux model, disposable state, no network. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GitService } from "@cube/git";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createCubed } from "../src/index.ts";
import { OptChat, type OptThreads } from "../src/optchat.ts";
import { optchatSkills, resolveSkills, SKILL_PAGE, skillsPrompt, type OptChatSkills, type ResolvedSkill, type SkillGit, type SkillSource } from "../src/skills.ts";
import { LocalMachines } from "./local-guest.ts";

type ToolArgs = Parameters<typeof fauxToolCall>[1];
const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-optchat-skills-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Cube Test", "-c", "user.email=cube@example.invalid",
  "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" }).trim();
const skill = (name: string, description: string, extra = "", body = `# ${name}\n`) => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}`;
const surface = (value: string) => `metadata:\n  cube:\n    surface: ${value}\n`;
function repository(name: string, files: Record<string, string>): SkillSource {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "--initial-branch=main");
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", name);
  return { url: `file://${dir}`, commit: git(dir, "rev-parse", "HEAD"), path: "skills" };
}

const BODY = "Delegate every command to a thread. BODY-MARKER";
const long = "x".repeat(SKILL_PAGE + 10);
const defaults = repository("defaults", {
  "skills/delegating/SKILL.md": skill("delegating", "Hand work to threads.", surface("optchat"), `${BODY}\nSee [notes](references/notes.md) and [checking](../checking/SKILL.md).\n`),
  "skills/delegating/references/notes.md": "NOTES-MARKER\n",
  "skills/delegating/references/long.md": long,
  "skills/delegating/references/emoji.md": `${"x".repeat(SKILL_PAGE - 1)}😀y`,
  "skills/delegating/blob.bin": "a\0b",
  "skills/checking/SKILL.md": skill("checking", "Check the real thing.", surface("both"), "CHECKING-MARKER\n"),
  "skills/investigating/SKILL.md": skill("investigating", "Investigate in a thread.", "", "THREAD-MARKER\n"),
  "skills/by-name/SKILL.md": skill("by-name", "Only when asked by name.", `disable-model-invocation: true\n${surface("optchat")}`, "HIDDEN-MARKER\n"),
});
const extra = repository("extra", { "skills/reviewing/SKILL.md": skill("reviewing", "Start a review in a fresh thread.", surface("optchat"), "REVIEW-MARKER\n") });

// 1. The facility over the host's real git: what is listed and read, and
//    one resolution per configuration.
const hostGit = new GitService(path.join(root, "mirrors"));
let listings = 0;
const counting: SkillGit = { ensureMirror: (url, signal) => hostGit.ensureMirror(url, signal),
  readFileAtCommit: (url, oid, file) => hostGit.readFileAtCommit(url, oid, file), prepareRepository: url => hostGit.prepareRepository(url),
  listFilesAtCommit: (url, oid, dir) => { if (dir === "skills") listings++; return hostGit.listFilesAtCommit(url, oid, dir); } };
let config = { sources: [] as SkillSource[], disabled: [] as string[] };
const facility = optchatSkills({ git: counting, source: () => defaults, config: () => config });
/** The listed ids once the configuration as it is now has resolved. */
const listedNow = async (skills: OptChatSkills) => { await skills.current().settled; return skills.current().skills?.map(each => each.name); };
assert.deepEqual(await listedNow(facility), ["checking", "delegating"], "optchat and both, not thread or hidden");
const resolvedOnce = listings;
await Promise.all([listedNow(facility), listedNow(facility)]);
assert.equal(listings, resolvedOnce, "resolved once for one configuration");
assert.equal(await facility.read("delegating"), skill("delegating", "Hand work to threads.", surface("optchat"), `${BODY}\nSee [notes](references/notes.md) and [checking](../checking/SKILL.md).\n`));
assert.equal(await facility.read("delegating", "references/notes.md"), "NOTES-MARKER\n");
assert.equal(await facility.read("delegating", "./references/../references/notes.md"), "NOTES-MARKER\n");
assert.match(await facility.read("delegating", "../checking/SKILL.md"), /CHECKING-MARKER/, "a link to another skill reaches it");
assert.match(await facility.read("delegating", "../investigating/SKILL.md"), /THREAD-MARKER/, "as in a thread, a link reaches any installed skill");
assert.match(await facility.read("investigating"), /^no skill "investigating" is listed for you/, "a thread's skill is not OptChat's");
assert.match(await facility.read("by-name"), /^no skill "by-name" is listed for you/, "nor a hidden one");
assert.match(await facility.read("nothing"), /^no skill "nothing"/);
for (const file of ["../../defaults/README", "/etc/passwd", "..", "../nothing/SKILL.md"]) {
  assert.match(await facility.read("delegating", file), /is not a file of a skill/, `${file} leaves the skills`);
}
assert.match(await facility.read("delegating", "missing.md"), /^delegating has no file missing.md; its files: SKILL.md, blob.bin, references\/emoji.md, references\/long.md, references\/notes.md$/);
assert.match(await facility.read("delegating", "blob.bin"), /is not text/);
const first = await facility.read("delegating", "references/long.md");
assert.equal(first, `${"x".repeat(SKILL_PAGE)}\n[characters 1-${SKILL_PAGE} of ${SKILL_PAGE + 10}; go on with at = ${SKILL_PAGE}]`);
assert.equal(await facility.read("delegating", "references/long.md", SKILL_PAGE), "x".repeat(10));
assert.match(await facility.read("delegating", "references/long.md", SKILL_PAGE + 10), /^no characters from/);
const surrogates = await facility.read("delegating", "references/emoji.md");
assert.ok(surrogates.startsWith(`${"x".repeat(SKILL_PAGE - 1)}\n[characters 1-${SKILL_PAGE - 1} of`), "a page ends before a character's two halves");
assert.equal(await facility.read("delegating", "references/emoji.md", SKILL_PAGE - 1), "😀y");
config = { sources: [extra], disabled: ["checking"] };
assert.deepEqual(await listedNow(facility), ["delegating", "reviewing"], "a settings change is read");
const resolvedTwice = listings;
await listedNow(facility);
assert.ok(resolvedTwice > resolvedOnce && listings === resolvedTwice, "and resolved again, once");
// A thread's list is as before: both, not optchat.
const threadList = skillsPrompt(await resolveSkills(hostGit, defaults, { sources: [], disabled: [] }))!;
assert.deepEqual([...threadList.matchAll(/<name>(.*)<\/name>/g)].map(match => match[1]), ["checking", "investigating"], "a thread lists both and thread, never optchat");

// A source that fails: one attempt, the failure is the answer until the
// retry time passes, then one more. A git that hangs: read waits its bound
// and says so; a caller's abort ends its own wait, not the resolution.
let attempts = 0;
const failing = optchatSkills({ git: { ...counting, listFilesAtCommit: async () => null, ensureMirror: async () => { attempts++; throw new Error("unreachable"); } },
  source: () => defaults, config: () => ({ sources: [], disabled: [] }), retryMs: 200 });
for (let k = 0; k < 5; k++) { await failing.current().settled; assert.equal(failing.current().skills, undefined); }
assert.equal(await failing.read("delegating"), "your skills could not be resolved (unreachable); cube tries again within a minute");
assert.equal(attempts, 1, "a failed resolution is not tried again at once");
await delay(250);
await failing.current().settled;
assert.equal(attempts, 2, "but after the retry time");
let unhang!: () => void;
const gate = new Promise<void>(resolve => { unhang = resolve; });
const hanging = optchatSkills({ git: { ...counting, listFilesAtCommit: (url, oid, dir) => gate.then(() => hostGit.listFilesAtCommit(url, oid, dir)) },
  source: () => defaults, config: () => ({ sources: [], disabled: [] }), waitMs: 150 });
const started = performance.now();
assert.match(await hanging.read("delegating"), /^your skills are still being resolved/);
assert.ok(performance.now() - started < 1_000, "read waits its bound, not git's");
const giving = new AbortController();
const reading = hanging.read("delegating", "SKILL.md", 0, giving.signal);
giving.abort(new Error("the call was cut off"));
await assert.rejects(reading, /the call was cut off/);
const shared = hanging.current();
unhang();
await shared.settled;
assert.deepEqual(shared.skills?.map(each => each.name), ["checking", "delegating"], "the abort did not end the shared resolution");
assert.match(await hanging.read("delegating"), /BODY-MARKER/, "which then reads");

// 2. Through cubed: the prompt OptChat gets, the tool, a settings change, a restart.
const systems: string[] = [];
/** How many system messages each request had: a patch of the prompt within a turn adds one. */
const counts: number[] = [];
const results = new Map<string, string>();
let script: Array<() => ReturnType<typeof fauxAssistantMessage>> = [];
const call = (name: string, args: ToolArgs, id: string) => () => fauxAssistantMessage([fauxToolCall(name, args, { id })], { stopReason: "toolUse" });
const textOf = (message: Message) => typeof message.content === "string" ? message.content : message.content.map(part => part.type === "text" ? part.text : "").join("\n");
const faux = fauxProvider({ tokensPerSecond: 100_000 });
faux.setResponses(Array.from({ length: 200 }, () => async request => {
  // The system messages as sent, but for when Pi wrote them.
  const system = JSON.stringify(request.messages.filter(message => message.role === "system").map(({ timestamp: _at, ...message }) => message));
  if (system.includes("You write the memory of OptChat")) return fauxAssistantMessage("summarized line");
  if (system.includes("You are OptChat")) {
    assert.ok(system.includes("\"name\":\"skill\""), "OptChat has the skill tool");
    systems.push(system);
    counts.push(request.messages.filter(message => message.role === "system").length);
    for (const message of request.messages) if (message.role === "toolResult") results.set(message.toolCallId, textOf(message));
    return (script.shift() ?? (() => fauxAssistantMessage("noted")))();
  }
  return fauxAssistantMessage("thread done");
}));
const models = createModels();
models.setProvider(faux.provider);
const state = path.join(root, "state");
const machines = new LocalMachines(path.join(root, "machines"));
const open = async () => {
  const app = await createCubed({ state, models, machines, claude: null, gateway: null, skillSource: defaults });
  await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  assert(address && typeof address === "object");
  return { app, base: `http://127.0.0.1:${address.port}` };
};
let cubed = await open();
const post = (route: string, body: unknown, method = "POST") => fetch(`${cubed.base}${route}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
let users = 0;
async function say(text: string, steps: typeof script): Promise<string> {
  script = steps;
  users++;
  const asked = systems.length;
  const sent = await post("/api/optchat/prompt", { text, requestId: `chat-${users}` });
  assert.equal(sent.status, 200, await sent.clone().text());
  for (const deadline = Date.now() + 60_000; ;) {
    const history = await (await fetch(`${cubed.base}/api/optchat/history`)).json() as { status: { state: string }; events: Array<{ type: string }> };
    if (!script.length && history.status.state === "completed" && history.events.filter(event => event.type === "user-message").length === users) break;
    assert.ok(Date.now() < deadline, `turn ${users} finishes: ${script.length} steps left, ${JSON.stringify(history.status)}, ${systems.length} requests`);
    await delay(50);
  }
  assert.ok(systems.length > asked, "the turn asked the model");
  return systems.at(-1)!;
}

try {
  const one = await say("brief me", [call("skill", { name: "delegating" }, "c1"), call("skill", { name: "delegating", path: "references/notes.md" }, "c2"),
    call("skill", { name: "investigating" }, "c3")]);
  assert.match(one, /<available_skills>.*<name>checking<\/name>.*<description>Check the real thing\.<\/description>.*<name>delegating<\/name>.*<\/available_skills>/);
  for (const marker of ["investigating", "by-name", "BODY-MARKER", "NOTES-MARKER", "CHECKING-MARKER", "<location>"]) assert.ok(!one.includes(marker), `the prompt has no ${marker}`);
  assert.match(results.get("c1")!, /BODY-MARKER/, "skill(name) reads its SKILL.md");
  assert.equal(results.get("c2"), "NOTES-MARKER\n", "and a file it links");
  assert.match(results.get("c3")!, /^no skill "investigating" is listed for you/);
  assert.ok(systems.every(system => system === one), "every step of the turn has the same system prompt");
  assert.equal(await say("again", []), one, "the next turn's system prompt is the same, byte for byte");

  // The default source moves on and the user saves its new commit (a
  // source of their own must be https, which a test without network cannot
  // serve), leaving one skill out.
  const defaultsDir = new URL(defaults.url).pathname;
  fs.mkdirSync(path.join(defaultsDir, "skills/reviewing"));
  fs.writeFileSync(path.join(defaultsDir, "skills/reviewing/SKILL.md"), skill("reviewing", "Start a review in a fresh thread.", surface("optchat")));
  git(defaultsDir, "add", "-A");
  git(defaultsDir, "commit", "-qm", "reviewing");
  const saved = await post("/api/settings/skills", { sources: [], disabled: ["checking"], defaultCommit: git(defaultsDir, "rev-parse", "HEAD") }, "PUT");
  assert.equal(saved.status, 200, await saved.clone().text());
  const changed = await say("after the change", []);
  assert.notEqual(changed, one);
  assert.match(changed, /<name>delegating<\/name>.*<name>reviewing<\/name>/);
  assert.ok(!changed.includes("<name>checking</name>"), "a disabled skill leaves the list");
  assert.equal(await say("and again", []), changed, "then it stays the same");

  await cubed.app.close();
  cubed = await open();
  assert.equal(await say("after a restart", []), changed, "a restart lists the same skills, byte for byte");

  await cubed.app.close();

  // 3. OptChat.open on its own, with lists that resolve late, hang or fail.
  const threads: OptThreads = { startFailure: () => null, onStartFailure: () => () => {}, onRunFeed: () => () => {},
    async projects() { return "projects: none"; }, async runners() { return "no runners"; },
    async spawn() { throw new Error("unused"); }, async tell() {}, async describe() { return ""; },
    async events() { throw new Error("unused"); }, async history() { return null; } };
  const model = async () => ({ provider: faux.getModel().provider, id: faux.getModel().id });
  /** One message of the user, answered: its requests' system prompts and
   * system message counts, and how long it took. */
  const turn = async (chat: OptChat, text: string, steps: typeof script) => {
    script = steps;
    const before = systems.length;
    const started = performance.now();
    await chat.send(text, `direct-${text}`);
    for (const deadline = Date.now() + 30_000; systems.length === before || script.length; await delay(10)) assert.ok(Date.now() < deadline, `${text} is answered`);
    await chat.agent.conversation.waitForIdle(BACKGROUND_CONTEXT);
    return { systems: systems.slice(before), counts: counts.slice(before), ms: performance.now() - started };
  };
  let step = 0;
  const steps = (n: number, first?: () => void) => Array.from({ length: n }, (_, k) => () => { if (k === 0) first?.(); return call("projects", {}, `p-${++step}`)(); });
  const listedSkill: ResolvedSkill = { name: "delegating", description: "Hand work to threads.", surface: "optchat", url: defaults.url, commit: defaults.commit, dir: "skills/delegating" };
  const has = (system: string) => system.includes("<name>delegating</name>");
  const none = () => ({ sources: [], disabled: [] });

  // 3a. Resolved during a turn's first tool call, on a fresh chat (nothing
  //     shown before): the turn keeps the prompt it started with, no patch;
  //     the next turn lists it, once.
  {
    const entry: { key: string; skills?: ResolvedSkill[]; settled: Promise<void> } = { key: "late", settled: Promise.resolve() };
    let resolve!: () => void;
    entry.settled = new Promise<void>(done => { resolve = () => { entry.skills = [listedSkill]; done(); }; });
    const chat = await OptChat.open({ directory: path.join(root, "late-chat"), models, threads, model, limits: { skillsWaitMs: 100 },
      skills: { current: () => entry, async read() { return ""; } } });
    try {
      const first = await turn(chat, "first", steps(2, resolve));
      assert.equal(first.systems.length, 3, "three requests");
      assert.ok(first.systems.every(system => !has(system)), "the turn went without the list, as it started");
      assert.deepEqual(first.counts, [1, 1, 1], "and its prompt was never patched");
      assert.ok(first.systems.every(system => system === first.systems[0]), "byte for byte");
      const second = await turn(chat, "second", steps(1));
      assert.ok(second.systems.every(has), "the next turn lists it");
      assert.deepEqual(second.counts, [1, 1]);
      assert.equal((await turn(chat, "third", [])).systems[0], second.systems[0], "and the one after is the same");
    } finally { await chat.close(); }
  }

  // 3b. A list that never resolves: one bounded wait for the configuration,
  //     at the first turn's start, then none: not per request, not per turn.
  {
    const wait = 400;
    const chat = await OptChat.open({ directory: path.join(root, "hanging-chat"), models, threads, model, limits: { skillsWaitMs: wait },
      skills: optchatSkills({ git: { ...counting, listFilesAtCommit: () => new Promise(() => {}) }, source: () => defaults, config: none, waitMs: wait }) });
    try {
      const first = await turn(chat, "first", steps(2));
      assert.ok(first.ms >= wait && first.ms < 2 * wait, `three requests waited once (${Math.round(first.ms)} ms)`);
      const second = await turn(chat, "second", steps(2));
      assert.ok(second.ms < wait, `the next turn's three did not wait (${Math.round(second.ms)} ms)`);
      assert.ok([...first.systems, ...second.systems].every(system => !has(system) && system === first.systems[0]), "none listed, the same prompt throughout");
      const read = await turn(chat, "read", [call("skill", { name: "delegating" }, "hang-read")]);
      assert.match(results.get("hang-read")!, /^your skills are still being resolved/, "skill says why");
      assert.ok(read.ms < 3 * wait, "after its own bounded wait");
    } finally { await chat.close(); }
  }

  // 3c. A source that fails fast: one attempt per retry time, whatever the
  //     number of requests; the prompt stays as it started.
  {
    let tries = 0;
    const chat = await OptChat.open({ directory: path.join(root, "failing-chat"), models, threads, model, limits: { skillsWaitMs: 300 },
      skills: optchatSkills({ git: { ...counting, listFilesAtCommit: async () => null, ensureMirror: async () => { tries++; throw new Error("unreachable"); } },
        source: () => defaults, config: none }) });
    try {
      const first = await turn(chat, "first", steps(2));
      const second = await turn(chat, "second", steps(2));
      assert.equal(tries, 1, "six requests, one fetch");
      assert.ok(second.ms < 300, "and no wait after the first");
      assert.ok([...first.systems, ...second.systems].every(system => !has(system) && system === first.systems[0]));
    } finally { await chat.close(); }
  }

  // 3d. A restart with a cold mirror and its source out of reach: the turn
  //     sends the list it sent before, byte for byte, without waiting; once
  //     the source is back, the resolved list is the same bytes.
  {
    const directory = path.join(root, "restart-chat");
    const mirrors = path.join(root, "restart-mirrors");
    const facilityAt = () => optchatSkills({ git: new GitService(mirrors), source: () => defaults, config: none, retryMs: 100 });
    let chat = await OptChat.open({ directory, models, threads, model, skills: facilityAt() });
    let warm = "";
    try {
      warm = (await turn(chat, "warm", [])).systems[0]!;
      assert.ok(has(warm), "listed while the source is reachable");
    } finally { await chat.close(); }
    fs.rmSync(mirrors, { recursive: true, force: true });
    const defaultsDir = new URL(defaults.url).pathname;
    fs.renameSync(defaultsDir, `${defaultsDir}.away`);
    chat = await OptChat.open({ directory, models, threads, model, skills: facilityAt(), limits: { skillsWaitMs: 5_000 } });
    try {
      const cold = await turn(chat, "cold", [call("skill", { name: "delegating" }, "cold-read")]);
      assert.ok(cold.systems.every(system => system === warm), "the same prompt, byte for byte");
      assert.ok(cold.ms < 5_000, `without waiting for the source (${Math.round(cold.ms)} ms)`);
      assert.match(results.get("cold-read")!, /^your skills could not be resolved/, "skill says the source is out of reach");
      fs.renameSync(`${defaultsDir}.away`, defaultsDir);
      await delay(150);
      const back = await turn(chat, "back", [call("skill", { name: "delegating" }, "back-read")]);
      assert.ok(back.systems.every(system => system === warm), "resolved again: still the same bytes");
      assert.match(results.get("back-read")!, /BODY-MARKER/, "and skill reads again");
    } finally { await chat.close(); }
  }
} finally {
  await cubed.app.close().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("optchat skills: ok");
