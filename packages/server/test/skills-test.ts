/** Skills from pinned git commits: resolution over the host's real git
 * (precedence, overrides, surfaces, disabled names, skipped folders, exact
 * pins), the install commands run by bash into a home directory (relative
 * links between skills, scripts' modes, a reinstall replacing the last),
 * and a Pi thread started through cubed's HTTP routes on a local guest: its
 * allocation records the skills, its machine has them and its first model
 * request lists them by name and description only; a source the machine
 * cannot fetch fails its preparation. Local repositories over
 * file://, disposable state, no network. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { GitService } from "@cube/git";
import { createCubed } from "../src/index.ts";
import { SettingsStore } from "../src/settings.ts";
import { defaultSource, GUEST_COMMAND_BYTES, parseSkillsConfig, resolveSkills, skillInstallScripts, skillsPrompt, type SkillSource } from "../src/skills.ts";
import { LocalMachines } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-skills-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Cube Test", "-c", "user.email=cube@example.invalid",
  "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" }).trim();
const skill = (name: string, description: string, extra = "", body = `# ${name}\n`) => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n${body}`;

/** A repository with `files`, committed; its file:// URL and commit. */
function repository(name: string, files: Record<string, string>, executable: string[] = [], links: Record<string, string> = {}): SkillSource {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "--initial-branch=main");
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text, { mode: executable.includes(file) ? 0o755 : 0o644 });
  }
  for (const [file, target] of Object.entries(links)) fs.symlinkSync(target, path.join(dir, file));
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", name);
  return { url: `file://${dir}`, commit: git(dir, "rev-parse", "HEAD"), path: "skills" };
}

const defaults = repository("defaults", {
  "README.md": "not a skill\n",
  "skills/prove-it-works/SKILL.md": skill("prove-it-works", "Check the real thing before reporting it done."),
  "skills/opening-a-pull-request/SKILL.md": skill("opening-a-pull-request", "Open a pull request.", "",
    "Verify first: [prove-it-works](../prove-it-works/SKILL.md). Body: [body.md](body.md).\n"),
  "skills/opening-a-pull-request/body.md": "## Why\n",
  "skills/opening-a-pull-request/scripts/check.sh": "#!/bin/sh\necho checked\n",
  "skills/briefing-a-thread/SKILL.md": skill("briefing-a-thread", "Brief a new thread.", "metadata:\n  cube:\n    surface: optchat\n"),
  "skills/manual-only/SKILL.md": skill("manual-only", "Only when asked by name.", "disable-model-invocation: true\n"),
  "skills/not-a-skill/notes.md": "no SKILL.md here\n",
}, ["skills/opening-a-pull-request/scripts/check.sh"]);
const mine = repository("mine", {
  "skills/prove-it-works/SKILL.md": skill("prove-it-works", "My own way to check work.", "metadata:\n  cube:\n    surface: both\n", "# mine\n"),
  "skills/Bad-Name/SKILL.md": skill("Bad-Name", "Upper case."),
  "skills/wrong-name/SKILL.md": skill("other-name", "Mismatched."),
  "skills/odd-surface/SKILL.md": skill("odd-surface", "Unknown surface.", "metadata:\n  cube:\n    surface: everywhere\n"),
  "skills/no-description/SKILL.md": "---\nname: no-description\n---\n",
  "skills/linked/SKILL.md": skill("linked", "Has a symlink."),
  "skills/extra/SKILL.md": skill("extra", "An extra skill."),
}, [], { "skills/linked/escape": "/etc/passwd" });

const hostGit = new GitService(path.join(root, "mirrors"));

try {
  // 1. Precedence: the default source, then the user's; the last source
  //    with a name wins it whatever its surface; disabled names are left
  //    out; folders that do not qualify are skipped with their reason.
  const resolved = await resolveSkills(hostGit, defaults, { sources: [mine], disabled: ["extra"] });
  assert.deepEqual(resolved.sources, [defaults, mine]);
  assert.deepEqual(resolved.skills.map(({ name, surface, url, commit, dir, hidden, overrides }) => ({ name, surface, url, commit, dir, hidden, overrides })), [
    { name: "briefing-a-thread", surface: "optchat", url: defaults.url, commit: defaults.commit, dir: "skills/briefing-a-thread", hidden: undefined, overrides: undefined },
    { name: "manual-only", surface: "thread", url: defaults.url, commit: defaults.commit, dir: "skills/manual-only", hidden: true, overrides: undefined },
    { name: "opening-a-pull-request", surface: "thread", url: defaults.url, commit: defaults.commit, dir: "skills/opening-a-pull-request", hidden: undefined, overrides: undefined },
    { name: "prove-it-works", surface: "both", url: mine.url, commit: mine.commit, dir: "skills/prove-it-works", hidden: undefined,
      overrides: { url: defaults.url, commit: defaults.commit } },
  ]);
  assert.equal(resolved.skills.find(entry => entry.name === "prove-it-works")!.description, "My own way to check work.");
  assert.deepEqual(resolved.skipped, [
    { url: mine.url, dir: "skills/Bad-Name", reason: "the folder name is not a skill name (lowercase letters, digits and inner hyphens)" },
    { url: mine.url, dir: "skills/linked", reason: "skills/linked/escape is a symlink; skills are plain files" },
    { url: mine.url, dir: "skills/no-description", reason: "description must be 1 to 1024 characters" },
    { url: mine.url, dir: "skills/odd-surface", reason: "metadata.cube.surface \"everywhere\" is not thread, optchat or both" },
    { url: mine.url, dir: "skills/wrong-name", reason: "SKILL.md names \"other-name\", not its folder wrong-name" },
  ]);
  assert.deepEqual((await resolveSkills(hostGit, null, { sources: [], disabled: [] })).skills, [], "no source, no skills");
  console.log("ok: the last source with a name wins it, disabled names are left out, unqualified folders are skipped with a reason");

  // 2. Exact pins: a commit the repository does not have fails resolution;
  //    settings take only full commits and https URLs.
  await assert.rejects(resolveSkills(hostGit, { ...defaults, commit: "f".repeat(40) }, { sources: [], disabled: [] }),
    new RegExp(`skills source ${defaults.url} has no commit f{40}`));
  assert.throws(() => parseSkillsConfig({ sources: [{ url: "https://github.com/me/skills", commit: "main" }] }), /full 40-character commit, not a branch or tag/);
  assert.throws(() => parseSkillsConfig({ sources: [{ url: "https://github.com/me/skills", commit: defaults.commit.slice(0, 12) }] }), /full 40-character commit/);
  assert.throws(() => parseSkillsConfig({ sources: [{ url: "file:///etc", commit: defaults.commit }] }), /https git URL/);
  assert.throws(() => parseSkillsConfig({ sources: [{ url: "https://github.com/me/skills", commit: defaults.commit, path: "../x" }] }), /without \. or \.\./);
  assert.throws(() => parseSkillsConfig({ disabled: ["Nope"] }), /not a skill name/);
  assert.deepEqual(parseSkillsConfig({ sources: [{ url: "https://github.com/me/skills", commit: defaults.commit, path: "skills/" }] }),
    { sources: [{ url: "https://github.com/me/skills", commit: defaults.commit, path: "skills" }], disabled: [] });
  for (const url of ["https://me:ghp_secret@github.com/me/skills", "https://ghp_secret@github.com/me/skills", "https://x-access-token:ghp_secret@github.com:443/me/skills"]) {
    assert.throws(() => parseSkillsConfig({ sources: [{ url, commit: defaults.commit }] }), (error: Error) =>
      /must not carry credentials/.test(error.message) && !error.message.includes("ghp_secret"), `${url} is refused without echoing the token`);
  }
  assert.deepEqual(parseSkillsConfig({ sources: [{ url: "https://github.com/me/skills@v2", commit: defaults.commit }] }).sources[0]!.url,
    "https://github.com/me/skills@v2", "an @ in the path is not userinfo");
  const edited = path.join(root, "edited-settings.json");
  fs.writeFileSync(edited, JSON.stringify({ version: 1, optchat: { compactor: null },
    skills: { sources: [{ url: "https://me:ghp_secret@github.com/me/skills", commit: defaults.commit }], disabled: [] } }));
  const store = new SettingsStore(edited);
  assert.deepEqual(store.get().skills, { sources: [], disabled: [] }, "a hand-edited credential URL is not used");
  assert.match(String(store.error), /must not carry credentials/);
  assert.doesNotMatch(String(store.error), /ghp_secret/);
  console.log("ok: a missing commit fails resolution; settings take only https URLs without credentials and full commits");

  // 2b. A source whose install command would exceed the guest's limit is
  //     refused at resolution, before any thread or machine.
  const deep = "p".repeat(200);
  const oversized = { ...repository("oversized", Object.fromEntries(Array.from({ length: 40 }, (_, index) =>
    [`${deep}/skill-${index}/SKILL.md`, skill(`skill-${index}`, "One of many.")]))), path: deep };
  await assert.rejects(resolveSkills(hostGit, oversized, { sources: [], disabled: [] }),
    new RegExp(`install command of \\d+ bytes, over the machine's ${GUEST_COMMAND_BYTES}`));
  const fewer = await resolveSkills(hostGit, oversized, { sources: [], disabled: Array.from({ length: 20 }, (_, index) => `skill-${index}`) });
  assert.equal(fewer.skills.length, 20, "disabling some brings it under the limit");
  console.log("ok: a source too large for one install command is refused at resolution; disabling skills fits it");

  // 2c. A saved default commit replaces only the default's commit; the
  //     user's sources still win names after it.
  assert.throws(() => parseSkillsConfig({ defaultCommit: "main" }), /defaultCommit must be a full 40-character commit/);
  assert.deepEqual(parseSkillsConfig({ defaultCommit: mine.commit }), { sources: [], disabled: [], defaultCommit: mine.commit });
  assert.deepEqual(defaultSource(defaults, { sources: [], disabled: [], defaultCommit: mine.commit }), { ...defaults, commit: mine.commit });
  assert.equal(defaultSource(defaults, { sources: [], disabled: [] }), defaults);
  assert.equal(defaultSource(null, { sources: [], disabled: [], defaultCommit: mine.commit }), null);
  console.log("ok: a saved default commit must be exact and replaces only the default source's commit");

  // 3. The prompt lists thread and both skills by name, description and
  //    path, not optchat-only or manual ones, and no skill bodies.
  const prompt = skillsPrompt(resolved)!;
  assert.deepEqual([...prompt.matchAll(/<name>(.*)<\/name>/g)].map(match => match[1]), ["opening-a-pull-request", "prove-it-works"]);
  assert.match(prompt, /<location>\/home\/agent\/\.cube\/skills\/prove-it-works\/SKILL\.md<\/location>/);
  assert.doesNotMatch(prompt, /# mine|Verify first/, "bodies are read on demand, not put in the prompt");
  assert.equal(skillsPrompt(undefined), null);
  assert.equal(skillsPrompt({ sources: [defaults], skills: resolved.skills.filter(entry => entry.surface === "optchat"), skipped: [] }), null);
  console.log("ok: the prompt lists thread skills by name and description only");

  // 4. The install commands, run by bash: every winner in its own folder,
  //    a link to ../prove-it-works reaching the override, modes kept, no
  //    symlink, and a reinstall replacing the previous set.
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const install = (skills: typeof resolved) => {
    for (const script of skillInstallScripts(skills)) {
      assert.ok(Buffer.byteLength(script) < 8192, "each command fits the guest's 8 KiB limit");
      execFileSync("bash", ["-c", script], { env: { PATH: process.env.PATH!, HOME: home }, encoding: "utf8" });
    }
  };
  install(resolved);
  const installed = path.join(home, ".cube", "skills");
  const listing = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
  assert.deepEqual(listing(installed), ["briefing-a-thread", "briefing-a-thread/SKILL.md", "manual-only", "manual-only/SKILL.md",
    "opening-a-pull-request", "opening-a-pull-request/SKILL.md", "opening-a-pull-request/body.md", "opening-a-pull-request/scripts",
    "opening-a-pull-request/scripts/check.sh", "prove-it-works", "prove-it-works/SKILL.md"]);
  assert.equal(fs.readFileSync(path.join(installed, "opening-a-pull-request", "../prove-it-works/SKILL.md"), "utf8"),
    skill("prove-it-works", "My own way to check work.", "metadata:\n  cube:\n    surface: both\n", "# mine\n"), "the relative link reaches the override");
  assert.equal(fs.statSync(path.join(installed, "opening-a-pull-request/scripts/check.sh")).mode & 0o777, 0o755);
  install({ sources: [defaults], skills: resolved.skills.filter(entry => entry.name === "manual-only"), skipped: [] });
  assert.deepEqual(listing(installed), ["manual-only", "manual-only/SKILL.md"], "a reinstall replaces the previous set");
  install({ sources: [], skills: [], skipped: [] });
  assert.deepEqual(listing(installed), []);
  console.log("ok: bash installs each winner as ~/.cube/skills/<name>, keeps relative links and modes, and replaces the last set");

  // 5. A thread through cubed: the default source resolves at its start,
  //    its allocation keeps the pins, its machine has the files and its
  //    first model request lists the skills.
  const requests: string[] = [];
  const faux = fauxProvider({ tokensPerSecond: 100_000 });
  faux.setResponses(Array.from({ length: 5 }, () => (request: unknown) => { requests.push(JSON.stringify(request)); return fauxAssistantMessage("done"); }));
  const models = createModels();
  models.setProvider(faux.provider);
  const machines = new LocalMachines(path.join(root, "machines"));
  const app = await createCubed({ state: path.join(root, "state"), models, machines, claude: null, gateway: null, skillSource: defaults });
  try {
    for (const index of [0, 1]) {
      app.registry.enrollRunner({ nodeId: `node-${index}`, threadId: `runner-${index}`, environmentId: index + 1, configPath: `/private/runner-${index}.json`, configHash: `hash-${index}` });
    }
    await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    assert(address && typeof address === "object");
    const call = async (route: string, method = "GET", body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${route}`, { method, ...body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    };
    const shown = await call("/api/settings/skills");
    assert.equal(shown.status, 200);
    assert.deepEqual(shown.body.default, defaults);
    assert.deepEqual((shown.body.resolved as { skills: Array<{ name: string }> }).skills.map(entry => entry.name),
      ["briefing-a-thread", "manual-only", "opening-a-pull-request", "prove-it-works"]);
    const refused = await call("/api/settings/skills", "PUT", { sources: [{ url: "https://github.com/me/skills", commit: "main" }] });
    assert.equal(refused.status, 400);
    assert.match(String(refused.body.error), /full 40-character commit/);
    const unreachable = await call("/api/settings/skills", "PUT", { disabled: ["manual-only"], sources: [{ url: "https://127.0.0.1:9/none", commit: defaults.commit }] });
    assert.equal(unreachable.status, 422, "a source that does not resolve is not saved");
    const saved = await call("/api/settings/skills", "PUT", { disabled: ["manual-only"] });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "state", "settings.json"), "utf8")).skills, { sources: [], disabled: ["manual-only"] });

    const upstream = path.join(root, "project");
    fs.mkdirSync(upstream);
    git(upstream, "init", "-q", "--initial-branch=main");
    fs.writeFileSync(path.join(upstream, "README"), "project\n");
    git(upstream, "add", "README");
    git(upstream, "commit", "-qm", "project");
    const project = (await call("/api/projects", "POST", { name: "skills", repositories: [{ url: upstream }] })).body.project as { id: string };
    const model = { provider: faux.getModel().provider, id: faux.getModel().id };
    const started = await call("/api/threads", "POST", { projectId: project.id, requestId: "one", text: "hello", model });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const id = String(started.body.id);
    for (const deadline = Date.now() + 30_000; requests.length === 0; await delay(25)) {
      assert.ok(Date.now() < deadline, `the thread's first request is sent: ${app.conversations.error(id)}`);
    }
    const allocation = app.registry.getThread(id)!.allocation;
    assert.deepEqual(allocation.skills!.skills.map(entry => [entry.name, entry.commit]),
      [["briefing-a-thread", defaults.commit], ["opening-a-pull-request", defaults.commit], ["prove-it-works", defaults.commit]]);
    assert.deepEqual(listing(path.join(machines.root, id, "home", ".cube", "skills")).filter(entry => entry.endsWith("SKILL.md")),
      ["briefing-a-thread/SKILL.md", "opening-a-pull-request/SKILL.md", "prove-it-works/SKILL.md"]);
    assert.match(requests[0]!, /<name>opening-a-pull-request<\/name>/);
    assert.match(requests[0]!, /<name>prove-it-works<\/name>/);
    assert.doesNotMatch(requests[0]!, /briefing-a-thread|manual-only|Verify first/);
    console.log("ok: a Pi thread's allocation pins its skills, its machine has them and its prompt lists the thread skills");

    // 6. A source the host still has but the machine cannot fetch fails the
    //    preparation visibly, and cube tries again.
    fs.renameSync(new URL(defaults.url).pathname, `${new URL(defaults.url).pathname}-gone`);
    const broken = await call("/api/threads", "POST", { projectId: project.id, requestId: "two", text: "hello", model });
    assert.equal(broken.status, 200, JSON.stringify(broken.body));
    const failed = String(broken.body.id);
    for (const deadline = Date.now() + 30_000; !app.registry.getThread(failed)!.vm?.steps?.some(step => step.name === "prepare" && step.state === "failed"); await delay(25)) {
      assert.ok(Date.now() < deadline, "the preparation fails");
    }
    const step = app.registry.getThread(failed)!.vm!.steps!.find(entry => entry.name === "prepare" && entry.state === "failed")!;
    assert.match(String(step.detail), new RegExp(`installing the thread's skills failed \\(exit 3\\): .*fetching skills from ${defaults.url} at ${defaults.commit} failed`));
    console.log("ok: skills the machine cannot fetch fail its preparation with the source and commit");

    // 7. Through cubed: an oversized source fails the start with 502 and
    //    allocates no thread; a credential URL is not saved.
    const before = app.registry.listThreads().length;
    Object.assign(defaults, oversized);
    const refusedStart = await call("/api/threads", "POST", { projectId: project.id, requestId: "three", text: "hello", model });
    assert.equal(refusedStart.status, 502);
    assert.match(String(refusedStart.body.error), /resolving the skills failed, so no thread was started: .*over the machine's 8192/);
    assert.equal(app.registry.listThreads().length, before, "no thread was allocated");
    const settingsFile = path.join(root, "state", "settings.json");
    const savedBefore = fs.readFileSync(settingsFile, "utf8");
    const leaked = await call("/api/settings/skills", "PUT", { sources: [{ url: "https://me:ghp_secret@github.com/me/skills", commit: oversized.commit }] });
    assert.equal(leaked.status, 400);
    assert.doesNotMatch(JSON.stringify(leaked.body), /ghp_secret/);
    assert.equal(fs.readFileSync(settingsFile, "utf8"), savedBefore, "nothing is saved");
    console.log("ok: through cubed, an oversized source allocates no thread and a credential URL is neither saved nor echoed");
  } finally {
    app.server.closeAllConnections();
    await app.close();
  }

  // 8. Updating the default source through cubed: a check names the branch
  //    tip as an exact commit and saves nothing; a save pins the commit
  //    shown even after the branch moved again; a thread started before
  //    keeps its pins, a new one gets the saved commit; the user's sources
  //    still win names; the pin survives a restart; a branch name or an
  //    unknown commit is refused.
  const upstream = repository("upstream-skills", {
    "skills/prove-it-works/SKILL.md": skill("prove-it-works", "Check the real thing."),
    "skills/old-skill/SKILL.md": skill("old-skill", "Removed later."),
  });
  const upstreamDir = new URL(upstream.url).pathname;
  const advance = (message: string, add: Record<string, string>, remove: string[] = []) => {
    for (const [file, text] of Object.entries(add)) {
      fs.mkdirSync(path.dirname(path.join(upstreamDir, file)), { recursive: true });
      fs.writeFileSync(path.join(upstreamDir, file), text);
    }
    for (const file of remove) fs.rmSync(path.join(upstreamDir, file), { recursive: true });
    git(upstreamDir, "add", "-A");
    git(upstreamDir, "commit", "-qm", message);
    return git(upstreamDir, "rev-parse", "HEAD");
  };
  const state = path.join(root, "update-state");
  const settingsFile = path.join(state, "settings.json");
  const updateFaux = fauxProvider({ tokensPerSecond: 100_000 });
  updateFaux.setResponses(Array.from({ length: 20 }, () => fauxAssistantMessage("done")));
  const updateModels = createModels();
  updateModels.setProvider(updateFaux.provider);
  const updateModel = { provider: updateFaux.getModel().provider, id: updateFaux.getModel().id };
  const open = async () => {
    const app = await createCubed({ state, models: updateModels, machines: new LocalMachines(path.join(root, "update-machines")), claude: null, gateway: null, skillSource: upstream });
    await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const address = app.server.address();
    assert(address && typeof address === "object");
    const call = async (route: string, method = "GET", body?: unknown) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${route}`, { method, ...body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) } });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    let closed = false;
    return { app, call, close: async () => { if (closed) return; closed = true; app.server.closeAllConnections(); await app.close(); } };
  };
  const cubed = await open();
  try {
    for (const index of [0, 1, 2]) {
      cubed.app.registry.enrollRunner({ nodeId: `update-${index}`, threadId: `update-runner-${index}`, environmentId: 10 + index, configPath: `/private/update-${index}.json`, configHash: `update-${index}` });
    }
    const upToDate = await cubed.call("/api/settings/skills/update");
    assert.equal(upToDate.status, 200, JSON.stringify(upToDate.body));
    assert.deepEqual([upToDate.body.branch, upToDate.body.current, upToDate.body.candidate, upToDate.body.upToDate], ["main", upstream.commit, upstream.commit, true]);

    const projectRepo = path.join(root, "update-project");
    fs.mkdirSync(projectRepo);
    git(projectRepo, "init", "-q", "--initial-branch=main");
    fs.writeFileSync(path.join(projectRepo, "README"), "project\n");
    git(projectRepo, "add", "README");
    git(projectRepo, "commit", "-qm", "project");
    const project = (await cubed.call("/api/projects", "POST", { name: "update", repositories: [{ url: projectRepo }] })).body.project as { id: string };
    const start = async (requestId: string) => {
      const started = await cubed.call("/api/threads", "POST", { projectId: project.id, requestId, text: "hello", model: updateModel });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      return String(started.body.id);
    };
    const pins = (id: string) => cubed.app.registry.getThread(id)!.allocation.skills!.skills.map(entry => [entry.name, entry.commit]);
    const before = await start("before");
    assert.deepEqual(pins(before), [["old-skill", upstream.commit], ["prove-it-works", upstream.commit]]);

    const second = advance("second", { "skills/new-skill/SKILL.md": skill("new-skill", "Added upstream.") }, ["skills/old-skill"]);
    const check = await cubed.call("/api/settings/skills/update");
    assert.deepEqual([check.status, check.body.current, check.body.candidate, check.body.upToDate], [200, upstream.commit, second, false]);
    assert.deepEqual(check.body.preview.skills.map((entry: { name: string; commit: string }) => [entry.name, entry.commit]), [["new-skill", second], ["prove-it-works", second]]);
    assert.ok(!fs.existsSync(settingsFile), "a check saves nothing");
    assert.deepEqual(pins(await start("unconfirmed")), [["old-skill", upstream.commit], ["prove-it-works", upstream.commit]], "an unconfirmed update changes no new thread");

    const third = advance("third", { "skills/later/SKILL.md": skill("later", "After the check.") });
    assert.equal((await cubed.call("/api/settings/skills", "PUT", { sources: [], disabled: [], defaultCommit: "main" })).status, 400);
    assert.equal((await cubed.call("/api/settings/skills", "PUT", { sources: [], disabled: [], defaultCommit: "f".repeat(40) })).status, 422);
    assert.ok(!fs.existsSync(settingsFile), "refused saves change nothing");
    const saved = await cubed.call("/api/settings/skills", "PUT", { sources: [], disabled: ["prove-it-works"], defaultCommit: second });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual([saved.body.default, saved.body.builtin], [{ ...upstream, commit: second }, upstream]);
    assert.deepEqual(saved.body.resolved.skills.map((entry: { name: string }) => entry.name), ["new-skill"], "the confirmed commit, not the newer tip; the disabled skill stays out");
    assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")).skills, { sources: [], disabled: ["prove-it-works"], defaultCommit: second });
    assert.notEqual(third, second);

    assert.deepEqual(pins(await start("after")), [["new-skill", second]], "a new thread gets the saved commit");
    assert.deepEqual(pins(before), [["old-skill", upstream.commit], ["prove-it-works", upstream.commit]], "a thread started before keeps its pins");
    const overridden = await resolveSkills(hostGit, defaultSource(upstream, { sources: [], disabled: [], defaultCommit: second }), { sources: [mine], disabled: [] });
    assert.deepEqual(overridden.skills.filter(entry => entry.name === "prove-it-works").map(entry => [entry.url, entry.overrides?.commit]), [[mine.url, second]], "a user source still wins over the saved default");

    // Closing during an activation is another test's subject: let them settle.
    for (const thread of cubed.app.registry.listThreads()) {
      for (const deadline = Date.now() + 30_000; cubed.app.registry.getThread(thread.id)!.workspaceState !== "available"; await delay(25)) {
        assert.ok(Date.now() < deadline, `thread ${thread.id} becomes ready: ${cubed.app.conversations.error(thread.id)}`);
      }
    }
    await cubed.close();
    const reread = new SettingsStore(settingsFile).get().skills;
    assert.deepEqual([reread.defaultCommit, defaultSource(upstream, reread)!.commit], [second, second], "the pin survives a restart");
    console.log("ok: a check names an exact commit and saves nothing; a save pins that commit, not a newer tip; earlier threads keep theirs; a fresh settings store reads it back");
  } finally {
    await cubed.close();
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
