/** Machine templates and hooks, offline: the hook order and failure rules
 * with the real guest helper under a temporary root (vm.ts scripts), resume
 * once per boot, a template's checkout refresh and stale setup, the declared
 * setup inputs, the template key and its invalidation, selection and
 * collection, the hooks in a keel
 * machine's boot documents, and project hook validation. Templates on
 * berth vm: runner-vm-templates-test.ts and runner-vm-cubed-test.ts. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RunnerTemplate } from "../src/runner-types.ts";
import { MAX_HOOK_BYTES, NO_HOOKS, projectHooks, type WorkspaceAllocation } from "../src/registry.ts";
import { provisionWorkspace, readStartupLog, resumeWorkspace, StepFailure } from "../src/vm.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { bootDocuments } from "../src/vm-seed.ts";
import { TEMPLATE_FORMAT, keelTemplateKey as templateKey, missingTemplate, obsoleteTemplates, pickTemplate, templateMeta, templateSettings } from "../src/vm-template.ts";
import { LeaseStore } from "../src/workspace-lease.ts";
import { LocalGuestTransport } from "./local-guest.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cube-template-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Cube Test", "-c", "user.email=cube@example.invalid",
  "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" }).trim();
const guests: LocalGuestTransport[] = [];
let machines = 0;

/** A local machine with the project's hooks where a seed would put them. */
function machine(hooks: { preSetup?: string; preResume?: string }) {
  const guest = new LocalGuestTransport(path.join(root, `machine-${++machines}`));
  guests.push(guest);
  const directory = path.join(guest.root, "hooks");
  fs.mkdirSync(directory, { recursive: true });
  if (hooks.preSetup) fs.writeFileSync(path.join(directory, "pre-setup"), `#!/bin/bash\n${hooks.preSetup}\n`, { mode: 0o755 });
  if (hooks.preResume) fs.writeFileSync(path.join(directory, "pre-resume"), `#!/bin/bash\n${hooks.preResume}\n`, { mode: 0o755 });
  const home = path.join(guest.root, "home");
  fs.writeFileSync(path.join(guest.root, "env"), `CUBE_HOOKS=${directory}\nCUBE_RUN=${path.join(guest.root, "run")}\nHOME=${home}\nORDER=${path.join(guest.root, "order")}\n`);
  const workspace = new VmWorkspace({ guest, leases: new LeaseStore(path.join(guest.root, "lease")), owner: "pi", binding: guest.binding });
  return { guest, workspace, home, order: () => fs.existsSync(path.join(guest.root, "order")) ? fs.readFileSync(path.join(guest.root, "order"), "utf8").split("\n").filter(Boolean) : [],
    reboot: () => fs.rmSync(path.join(guest.root, "run"), { recursive: true, force: true }) };
}
/** `cube hooks --json` in the machine: what an agent there reads. */
type HookView = { name: string; source: string; present: boolean; sha256?: string; last: { status: string; exitCode: number | null; ms: number; endedAt: number } | null; logTail: string | null };
const cubeHooks = (m: ReturnType<typeof machine>, ...args: string[]) =>
  (JSON.parse(execFileSync("sh", ["-c", `${m.guest.cubeCommand()} hooks --json ${args.join(" ")}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as { hooks: HookView[] }).hooks;
const lastOutcomes = (views: HookView[]) => Object.fromEntries(views.map(view => [view.name, view.last ? view.last.status + (view.last.exitCode === null ? "" : `:${view.last.exitCode}`) : null]));
const statuses = (hooks: Record<string, { status: string; exitCode?: number }>) =>
  Object.fromEntries(Object.entries(hooks).map(([name, hook]) => [name, hook.status + (hook.exitCode === undefined ? "" : `:${hook.exitCode}`)]));

try {
  // A repository whose .agents/setup and .agents/resume record their turn.
  const work = path.join(root, "repo-work");
  fs.mkdirSync(path.join(work, ".agents"), { recursive: true });
  git(work, "init", "-q", "--initial-branch=main");
  const agentsScript = (name: string, extra = "") => `#!/bin/bash\necho ${name} >> "$ORDER"\n${extra}`;
  fs.writeFileSync(path.join(work, ".agents/setup"), agentsScript("setup"), { mode: 0o755 });
  fs.writeFileSync(path.join(work, ".agents/resume"), agentsScript("resume"), { mode: 0o755 });
  fs.writeFileSync(path.join(work, "README.md"), "one\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "one");
  const first = git(work, "rev-parse", "HEAD");
  const firstBlob = git(work, "rev-parse", "HEAD:.agents/setup");
  const bare = path.join(root, "repo.git");
  git(root, "clone", "-q", "--bare", work, bare);
  const allocation = (oid: string): WorkspaceAllocation => ({ projectId: "p1", projectRevision: 1,
    repositories: [{ url: bare, base: "main", baseOid: oid, checkoutName: "workspace" }] });
  const preSetup = "echo pre-setup >> \"$ORDER\"";
  const preResume = "echo pre-resume >> \"$ORDER\"";

  // 1. Fresh: checkout, external pre-setup, then the repository's setup; resume: pre-resume, then resume.
  {
    const m = machine({ preSetup, preResume });
    const outcome = await provisionWorkspace(m.workspace, "pi", allocation(first), 1);
    assert.deepEqual(statuses(outcome.hooks), { "pre-setup": "ok", setup: "ok" });
    assert.equal(outcome.setupBlob, firstBlob);
    assert.equal(outcome.setupInputs, "none", "no .agents/setup-inputs");
    assert.equal(outcome.stale, false);
    const resumed = await resumeWorkspace(m.workspace, "pi");
    assert.deepEqual([statuses(resumed.hooks), resumed.already], [{ "pre-resume": "ok", resume: "ok" }, false]);
    assert.deepEqual(m.order(), ["pre-setup", "setup", "pre-resume", "resume"], "external hooks first, both run, setup before resume");
    // Once per boot: a second activation of the same boot runs nothing.
    assert.equal((await resumeWorkspace(m.workspace, "pi")).already, true);
    assert.deepEqual(m.order(), ["pre-setup", "setup", "pre-resume", "resume"]);
    // A new boot (the tmpfs marker is gone) resumes again; setup does not run again.
    m.reboot();
    assert.equal((await resumeWorkspace(m.workspace, "pi")).already, false);
    assert.deepEqual(m.order().slice(4), ["pre-resume", "resume"]);
    assert.ok(fs.existsSync(path.join(m.home, ".cache/cube/setup.log")) && fs.existsSync(path.join(m.home, ".cache/cube/pre-resume.log")));
    assert.deepEqual(lastOutcomes(cubeHooks(m)), { "pre-setup": "ok", setup: "ok", "pre-resume": "ok", resume: "ok" });
    console.log("ok: fresh machine: pre-setup then .agents/setup, pre-resume then .agents/resume, resume once per boot");
  }

  // 2. Failures: a failing external hook stops its phase, never the thread; logs keep the reason.
  {
    const m = machine({ preSetup: "echo broken-pre-setup; exit 7", preResume: "exit 4" });
    const outcome = await provisionWorkspace(m.workspace, "pi", allocation(first), 1);
    assert.deepEqual(statuses(outcome.hooks), { "pre-setup": "failed:7", setup: "notrun" });
    assert.match(fs.readFileSync(path.join(m.home, ".cache/cube/pre-setup.log"), "utf8"), /broken-pre-setup/);
    assert.equal(outcome.log, "broken-pre-setup", "the end of the failed hook's log, kept with its step");
    assert.deepEqual(statuses((await resumeWorkspace(m.workspace, "pi")).hooks), { "pre-resume": "failed:4", resume: "notrun" });
    assert.deepEqual(m.order(), [], "neither repository hook ran");
    // What the agent in that machine reads back: the same outcomes, the scripts and their logs.
    const views = cubeHooks(m);
    assert.deepEqual(views.map(view => [view.name, view.source, view.present]),
      [["pre-setup", "project", true], ["setup", "repository", true], ["pre-resume", "project", true], ["resume", "repository", true]], "in the order they run");
    assert.deepEqual(lastOutcomes(views), { "pre-setup": "failed:7", setup: "notrun", "pre-resume": "failed:4", resume: "notrun" });
    assert.match(views[0]!.logTail ?? "", /broken-pre-setup/);
    assert.ok(views.every(view => !view.last || view.last.endedAt > Date.now() - 600_000));
    assert.equal(cubeHooks(m, "-n", "0")[0]!.logTail, "", "-n bounds the log lines");
    assert.throws(() => cubeHooks(m, "-n", "201"), "at most 200 lines");
    assert.throws(() => cubeHooks(m, "--timeout", "5"), "nothing to set");
    const failing = machine({});
    fs.writeFileSync(path.join(failing.guest.root, "env"), fs.readFileSync(path.join(failing.guest.root, "env"), "utf8") + "SETUP_FAILS=1\n");
    git(work, "checkout", "-q", "-b", "failing");
    fs.writeFileSync(path.join(work, ".agents/setup"), agentsScript("setup", "exit 9"), { mode: 0o755 });
    git(work, "commit", "-qam", "failing setup");
    const failingOid = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", bare, "failing");
    const failed = await provisionWorkspace(failing.workspace, "pi", { ...allocation(failingOid), repositories: [{ url: bare, base: "failing", baseOid: failingOid, checkoutName: "workspace" }] }, 1);
    assert.deepEqual(statuses(failed.hooks), { "pre-setup": "absent", setup: "failed:9" });
    git(work, "checkout", "-q", "main");
    // A checkout that fails does fail provisioning.
    await assert.rejects(provisionWorkspace(machine({}).workspace, "pi", allocation("f".repeat(40)), 1), /pinned commit f+ is not on refs\/heads\/main/);
    console.log("ok: failures: pre-setup failure skips setup, pre-resume failure skips resume, setup failure recorded, failed checkout fails");
  }

  // 2b. A hook the kernel's OOM killer stops: the try fails saying so, with the
  // command's memory; the next try keeps the previous log as <hook>.log.prev.
  {
    // The local guest's stand-in for the unit's cgroup and /proc/meminfo; the
    // hook then kills its whole process group, as a unit stopped for OOM.
    const killed = "if [ ! -e ../once ]; then touch ../once; mkdir -p ../cgroup; echo 3758096384 > ../cgroup/memory.peak; "
      + "printf 'oom 1\\noom_kill 1\\n' > ../cgroup/memory.events; echo 'MemTotal: 4013504 kB' > ../meminfo; echo first-try; kill -9 0; fi; echo second-try";
    const m = machine({ preSetup: killed });
    const failure = await provisionWorkspace(m.workspace, "pi", allocation(first), 1).then(() => null, (error: unknown) => error as StepFailure);
    assert.ok(failure instanceof StepFailure);
    assert.equal(failure.message, "pre-setup was stopped: the machine ran out of memory (this command used up to 3.5 GB; the machine has 3.8 GB)");
    assert.deepEqual(failure.memory, { peakBytes: 3758096384, totalBytes: 4013504 * 1024, oomKills: 1 });
    assert.equal(fs.readFileSync(path.join(m.home, ".cache/cube/running"), "utf8"), "pre-setup pre-setup.log\n", "the killed hook is the one shown");
    // The next command of cubed's (here the resume hooks) clears the killed hook's marker first.
    await resumeWorkspace(m.workspace, "pi");
    assert.ok(!fs.existsSync(path.join(m.home, ".cache/cube/running")), "no stale marker once another command of cubed's began");
    fs.rmSync(path.join(m.guest.root, "cgroup"), { recursive: true });
    const retried = await provisionWorkspace(m.workspace, "pi", allocation(first), 2);
    assert.deepEqual(statuses(retried.hooks), { "pre-setup": "ok", setup: "ok" });
    assert.match(fs.readFileSync(path.join(m.home, ".cache/cube/pre-setup.log"), "utf8"), /second-try/);
    assert.match(fs.readFileSync(path.join(m.home, ".cache/cube/pre-setup.log.prev"), "utf8"), /first-try/);
    assert.ok(!fs.existsSync(path.join(m.home, ".cache/cube/running")), "nothing runs now");
    // The live log: the running hook and the end of a long log, from whole lines.
    fs.writeFileSync(path.join(m.home, ".cache/cube/running"), "setup setup.log\n");
    fs.writeFileSync(path.join(m.home, ".cache/cube/setup.log"), Array.from({ length: 4000 }, (_, k) => `line ${k}`).join("\n") + "\n");
    const live = await readStartupLog(m.guest, "thread", "/home/.cache/cube");
    assert.equal(live.hook, "setup");
    assert.equal(live.bytes, fs.statSync(path.join(m.home, ".cache/cube/setup.log")).size);
    assert.ok(live.truncated && live.text.startsWith("line ") && live.text.endsWith("line 3999\n") && Buffer.byteLength(live.text) <= 16 * 1024, live.text.slice(0, 40));
    fs.rmSync(path.join(m.home, ".cache/cube/running"));
    assert.deepEqual(await readStartupLog(m.guest, "thread", "/home/.cache/cube"), { machine: "thread", hook: null, text: "", bytes: 0, truncated: false });
    console.log("ok: a hook stopped for want of memory fails its try with the command's memory; the next try keeps the previous log; the live log reads the end of a long one");
  }

  // 3. A machine on a template: the checkout moves to the thread's commit and setup is skipped,
  //    unless the pinned .agents/setup differs from the template's: then both setup hooks run and it is stale.
  {
    const m = machine({ preSetup, preResume });
    await provisionWorkspace(m.workspace, "pi", allocation(first), 1);
    const workspace = path.join(m.guest.root, "workspace");
    fs.writeFileSync(path.join(workspace, "README.md"), "changed by setup\n");
    // A later commit with the same setup: the template's preparation still holds.
    fs.writeFileSync(path.join(work, "README.md"), "two\n");
    git(work, "commit", "-qam", "two");
    const second = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", bare, "main");
    fs.writeFileSync(path.join(m.guest.root, "order"), "");
    const reused = await provisionWorkspace(m.workspace, "pi", allocation(second), 2, { kind: "template", setupBlob: firstBlob, setupInputs: "none" });
    assert.deepEqual([statuses(reused.hooks), reused.stale], [{ "pre-setup": "skipped", setup: "skipped" }, false]);
    assert.equal(git(workspace, "rev-parse", "HEAD"), second);
    assert.equal(fs.readFileSync(path.join(workspace, "README.md"), "utf8"), "two\n", "the template's own changes are replaced");
    assert.equal(git(workspace, "reflog", "--all").trim(), "", "the template's history is not the thread's");
    assert.deepEqual(m.order(), []);
    assert.deepEqual(lastOutcomes(cubeHooks(m)).setup, "skipped", "the agent sees that the template ran setup");
    // The setup changed: run it here and report the template stale.
    fs.writeFileSync(path.join(work, ".agents/setup"), agentsScript("setup", "echo v3 >/dev/null"), { mode: 0o755 });
    git(work, "commit", "-qam", "three");
    const third = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", bare, "main");
    const stale = await provisionWorkspace(m.workspace, "pi", allocation(third), 3, { kind: "template", setupBlob: firstBlob, setupInputs: "none" });
    assert.deepEqual([statuses(stale.hooks), stale.stale], [{ "pre-setup": "ok", setup: "ok" }, true]);
    assert.deepEqual(m.order(), ["pre-setup", "setup"]);
    console.log("ok: template machine: refreshed checkout, setup skipped; a changed .agents/setup runs here and marks the template stale");
  }

  {
    const commit = (message: string, change: () => void) => {
      change();
      git(work, "add", "-A");
      git(work, "commit", "-qm", message);
      git(work, "push", "-q", bare, "main");
      return git(work, "rev-parse", "HEAD");
    };
    const write = (file: string, text: string) => {
      fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
      fs.writeFileSync(path.join(work, file), text);
    };
    const declaration = "# what .agents/setup installs from\nlock.txt\n\n  tools/\nlater.txt\n../outside\n/etc/hostname\ntools/../lock.txt\n$(touch injected)\nlast-line-without-newline";
    const declared = commit("declare setup inputs", () => {
      write(".agents/setup-inputs", declaration);
      write("lock.txt", "v1\n");
      write("tools/a.txt", "a1\n");
      write("last-line-without-newline", "x\n");
    });
    const setupBlob = git(work, "rev-parse", "HEAD:.agents/setup");
    const fingerprint = (await provisionWorkspace(machine({}).workspace, "pi", allocation(declared), 1)).setupInputs!;
    assert.match(fingerprint, /^[0-9a-f]{40}$/);
    assert.ok(!fs.readdirSync(root, { recursive: true }).some(name => String(name).endsWith("injected")), "a declared path is never run");
    assert.equal((await provisionWorkspace(machine({}).workspace, "pi", allocation(declared), 1)).setupInputs, fingerprint,
      "the same commit, the same fingerprint in another machine");

    const m = machine({ preSetup, preResume });
    let attempt = 0;
    const onTemplate = async (oid: string, inputs = fingerprint) => {
      fs.writeFileSync(path.join(m.guest.root, "order"), "");
      const outcome = await provisionWorkspace(m.workspace, "pi", allocation(oid), ++attempt, { kind: "template", setupBlob, setupInputs: inputs });
      return { stale: outcome.stale, ran: m.order(), inputs: outcome.setupInputs };
    };
    const reused = { stale: false, ran: [], inputs: fingerprint };
    assert.deepEqual(await onTemplate(declared), reused, "the commit the template was made at");
    fs.writeFileSync(path.join(m.guest.root, "workspace", "later.txt"), "untracked\n");
    const unrelated = commit("an unrelated change", () => write("README.md", "unrelated\n"));
    assert.deepEqual(await onTemplate(unrelated), reused, "another file changed: still the template's preparation");
    fs.rmSync(path.join(m.guest.root, "workspace", "later.txt"));

    const stale = async (message: string, change: () => void) => {
      const oid = commit(message, change);
      const outcome = await onTemplate(oid);
      assert.equal(outcome.stale, true, message);
      assert.deepEqual(outcome.ran, ["pre-setup", "setup"], `${message}: setup runs here`);
      assert.notEqual(outcome.inputs, fingerprint, message);
      return oid;
    };
    await stale("a declared file changes", () => write("lock.txt", "v2\n"));
    await stale("a file in a declared directory changes", () => write("tools/a.txt", "a2\n"));
    await stale("a file is added to a declared directory", () => write("tools/b.txt", "b\n"));
    await stale("a declared file that was missing is added", () => write("later.txt", "now here\n"));
    await stale("a declared file is deleted", () => fs.rmSync(path.join(work, "lock.txt")));
    await stale("the last line, without a newline, is an input", () => write("last-line-without-newline", "y\n"));
    await stale("only a comment of the declaration changes (the refresh lever)", () => write(".agents/setup-inputs", declaration.replace("# what", "# refreshed: what")));
    const undeclared = await stale("the declaration is removed", () => fs.rmSync(path.join(work, ".agents/setup-inputs")));
    assert.equal((await onTemplate(undeclared, "none")).stale, false, "no declaration on either side: the template holds");
    assert.equal((await onTemplate(undeclared, "")).stale, true, "a preparation recorded before cube tracked setup inputs never matches");
    console.log("ok: declared setup inputs: files, directories, missing, added, deleted and the declaration itself make the template stale; other changes do not");
  }

  // 4. The key: what the preparation depends on, and nothing per thread or per resume.
  {
    const runner = { baseImageSha256: "a".repeat(64), platform: "linux-x86_64" };
    const base = { allocation: allocation(first), hooks: { preSetup: "x", preResume: "y" }, runner, diskGiB: 32 };
    const key = templateKey(base);
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(templateKey({ ...base, allocation: allocation("b".repeat(40)) }), key, "a new commit reuses the template (checkout refresh)");
    assert.equal(templateKey({ ...base, hooks: { preSetup: "x", preResume: "other" } }), key, "resume hooks are never cached");
    for (const changed of [
      { ...base, hooks: { preSetup: "x2", preResume: "y" } },
      { ...base, allocation: { ...base.allocation, projectId: "p2" } },
      { ...base, allocation: { ...base.allocation, repositories: [{ ...base.allocation.repositories[0], base: "develop" }] } },
      { ...base, allocation: { ...base.allocation, repositories: [{ ...base.allocation.repositories[0], url: "https://example.invalid/x.git" }] } },
      { ...base, runner: { ...runner, baseImageSha256: "c".repeat(64) } },
      { ...base, runner: { ...runner, platform: "macos-aarch64" } },
      { ...base, diskGiB: 64 },
    ]) assert.notEqual(templateKey(changed), key, JSON.stringify(changed).slice(0, 120));
    console.log("ok: template key covers project, repositories, pre-setup, base image, platform, disk; not commits or resume hooks");
  }

  // 5. Selection and collection.
  {
    const now = Date.now();
    const meta = (projectId: string) => JSON.stringify({ format: TEMPLATE_FORMAT, projectId, setupBlob: "none", setupInputs: "none", commit: null });
    const legacy = (projectId: string) => JSON.stringify({ format: TEMPLATE_FORMAT, projectId, setupBlob: "none", commit: null });
    const year = 365 * 24 * 60 * 60 * 1000;
    const template = (id: string, key: string, age: number, projectId = "p1", state: RunnerTemplate["state"] = "ready"): RunnerTemplate =>
      ({ id, key, meta: meta(projectId), state, diskGiB: 8, bytes: 1, createdAt: now - age, users: 0 });
    const k1 = "1".repeat(64), k2 = "2".repeat(64);
    const all = [template("a000000000000001", k1, 5000), template("a000000000000002", k1, 1000), template("a000000000000003", k1, 10, "p1", "removing"),
      template("a000000000000004", k2, 10), { ...template("a000000000000005", k1, 1), meta: legacy("p1") },
      { ...template("a000000000000006", k1, 1), meta: "{}" }, template("a000000000000007", k2, 10, "gone")];
    assert.equal(pickTemplate(all, k1)?.id, "a000000000000002", "newest ready, readable, with setup inputs, same key");
    assert.equal(pickTemplate(all, "3".repeat(64)), null);
    assert.equal(pickTemplate([template("a000000000000008", k1, year)], k1)?.id, "a000000000000008", "a year-old template is still reused");
    assert.equal(pickTemplate([{ ...template("a000000000000009", k1, 1), meta: legacy("p1") }], k1), null, "never one made before cube tracked setup inputs");
    assert.equal(templateMeta(legacy("p1"))?.setupInputs, null);
    assert.equal(templateMeta(JSON.stringify({ format: TEMPLATE_FORMAT, projectId: "p1", setupBlob: "none", setupInputs: "../x", commit: null }))?.setupInputs, null,
      "a malformed fingerprint reads as none recorded");
    const exists = (id: string) => id !== "gone";
    assert.deepEqual(obsoleteTemplates([...all, template("a00000000000000b", k2, year)], { projectExists: exists }).sort(),
      ["a000000000000005", "a000000000000006", "a000000000000007"], "legacy, unreadable, deleted project; age is no reason");
    assert.deepEqual(obsoleteTemplates(all, { projectExists: exists, projectId: "p1", keep: "a000000000000002" }).sort(),
      ["a000000000000001", "a000000000000004", "a000000000000005", "a000000000000006", "a000000000000007"], "a new template supersedes the project's others");
    assert.equal(templateMeta("not json"), null);
    assert.deepEqual(templateSettings({}), { enabled: true });
    assert.deepEqual(templateSettings({ CUBED_TEMPLATES: "off", CUBED_TEMPLATE_TTL_HOURS: "2" }), { enabled: false }, "the TTL setting is gone");
    assert.throws(() => templateSettings({ CUBED_TEMPLATES: "maybe" }));
    assert.equal(missingTemplate([{ ...template("a00000000000000a", k1, 1), meta: legacy("p1") }],
      { projectId: "p1", key: k1, parts: { repositories: "", preSetup: "", image: "", disk: "" } }),
    "template a00000000000000a was prepared before cube tracked setup inputs");
    console.log("ok: the newest template of the key with setup inputs is chosen at any age; legacy, unreadable, orphaned and superseded ones are removed");
  }

  // 6. The boot documents carry the hooks; the largest hooks still fit berth's bound.
  {
    const documents = bootDocuments({ vmId: "0123456789abcdef", placeholders: {}, hooks: { preSetup: "echo a", preResume: "#!/bin/sh\necho b" } });
    assert.equal(Buffer.from(documents["hooks/pre-setup"]!).toString(), "#!/bin/bash\necho a\n");
    assert.equal(Buffer.from(documents["hooks/pre-resume"]!).toString(), "#!/bin/sh\necho b\n");
    assert.ok(!Object.keys(bootDocuments({ vmId: "0123456789abcdef", placeholders: {}, hooks: NO_HOOKS })).some(name => name.startsWith("hooks/")));
    bootDocuments({ vmId: "0123456789abcdef", placeholders: {}, hooks: { preSetup: "#".repeat(MAX_HOOK_BYTES), preResume: "#".repeat(MAX_HOOK_BYTES) } });
    console.log("ok: boot documents carry the hooks as scripts; maximal hooks fit");
  }

  // 7. Project hook validation.
  {
    assert.deepEqual(projectHooks(undefined), NO_HOOKS);
    assert.deepEqual(projectHooks({ preSetup: "a\r\nb" }, { preSetup: "", preResume: "keep" }), { preSetup: "a\nb", preResume: "keep" });
    assert.deepEqual(projectHooks({ preSetup: "   ", preResume: "" }), NO_HOOKS);
    assert.throws(() => projectHooks({ preSetup: "x".repeat(MAX_HOOK_BYTES + 1) }), /at most/);
    assert.throws(() => projectHooks({ preSetup: "a\0b" }));
    assert.throws(() => projectHooks({ setup: "x" }), /only preSetup and preResume/);
    assert.throws(() => projectHooks("x"));
    console.log("ok: project hooks: size, NUL, unknown fields refused; absent fields kept");
  }
} finally {
  for (const guest of guests) guest.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
