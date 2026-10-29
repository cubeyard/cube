/** OptChat's skills: the skills of the `optchat` and `both` surfaces from
 * the skill sources in cube's settings, listed in OptChat's prompt by id
 * and description only (never a body) and read with its skill tool at
 * their pinned commits; `thread` and hidden skills are not listed and not
 * read, a path leaves no skill's folder, a long file comes in pages. The
 * prompt is the same, byte for byte, across turns and a restart, and
 * changes once when the skill settings do; a list slow to resolve holds
 * no request. Real cubed (HTTP routes,
 * settings), real git over file:// repositories, faux model, disposable
 * state, no network. */
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
import { optchatSkills, resolveSkills, SKILL_PAGE, skillsPrompt, type SkillGit, type SkillSource } from "../src/skills.ts";
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
assert.deepEqual((await facility.list()).map(each => each.name), ["checking", "delegating"], "optchat and both, not thread or hidden");
const resolvedOnce = listings;
await Promise.all([facility.list(), facility.list()]);
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
assert.match(await facility.read("delegating", "missing.md"), /^delegating has no file missing.md; its files: SKILL.md, blob.bin, references\/long.md, references\/notes.md$/);
assert.match(await facility.read("delegating", "blob.bin"), /is not text/);
const first = await facility.read("delegating", "references/long.md");
assert.equal(first, `${"x".repeat(SKILL_PAGE)}\n[characters 1-${SKILL_PAGE} of ${SKILL_PAGE + 10}; go on with at = ${SKILL_PAGE}]`);
assert.equal(await facility.read("delegating", "references/long.md", SKILL_PAGE), "x".repeat(10));
assert.match(await facility.read("delegating", "references/long.md", SKILL_PAGE + 10), /^no characters from/);
config = { sources: [extra], disabled: ["checking"] };
assert.deepEqual((await facility.list()).map(each => each.name), ["delegating", "reviewing"], "a settings change is read");
const resolvedTwice = listings;
await facility.list();
assert.ok(resolvedTwice > resolvedOnce && listings === resolvedTwice, "and resolved again, once");
// A thread's list is as before: both, not optchat.
const threadList = skillsPrompt(await resolveSkills(hostGit, defaults, { sources: [], disabled: [] }))!;
assert.deepEqual([...threadList.matchAll(/<name>(.*)<\/name>/g)].map(match => match[1]), ["checking", "investigating"], "a thread lists both and thread, never optchat");

// 2. Through cubed: the prompt OptChat gets, the tool, a settings change, a restart.
const systems: string[] = [];
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

  // 3. A list that takes too long (a new pin's commit being fetched) holds
  //    no request: it goes without the section, the resolution goes on, and
  //    the next request lists the skills.
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const listed = { name: "delegating", description: "Hand work to threads.", surface: "optchat" as const, url: defaults.url, commit: defaults.commit, dir: "skills/delegating" };
  const threads: OptThreads = { startFailure: () => null, onStartFailure: () => () => {}, onRunFeed: () => () => {},
    async projects() { return "projects: none"; }, async runners() { return "no runners"; },
    async spawn() { throw new Error("unused"); }, async tell() {}, async describe() { return ""; },
    async events() { throw new Error("unused"); }, async history() { return null; } };
  const chat = await OptChat.open({ directory: path.join(root, "slow-chat"), models, threads, model: async () => ({ provider: faux.getModel().provider, id: faux.getModel().id }),
    skills: { async list() { await slow; return [listed]; }, async read() { return ""; } }, limits: { skillsWaitMs: 100 } });
  try {
    const asked = async (text: string) => {
      const before = systems.length;
      await chat.send(text, `slow-${text}`);
      for (const deadline = Date.now() + 30_000; systems.length === before; await delay(20)) assert.ok(Date.now() < deadline, `${text} asks the model`);
      await chat.agent.conversation.waitForIdle(BACKGROUND_CONTEXT);
      return systems.at(-1)!;
    };
    script = [];
    assert.ok(!(await asked("first")).includes("<name>delegating</name>"), "the first request went without the list");
    release();
    assert.match(await asked("second"), /<name>delegating<\/name>/, "the next one lists it");
  } finally { await chat.close(); }
} finally {
  await cubed.app.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log("optchat skills: ok");
