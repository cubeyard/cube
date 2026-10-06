/** Machine templates and hooks, offline: the hook order and failure rules
 * with the real guest helper under a temporary root (vm.ts scripts), resume
 * once per boot, a template's checkout refresh and stale setup, the template
 * key and its invalidation, selection and collection, the seed's hook files,
 * and project hook validation. Real VMs: scripts/test-vm-templates.ts. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import type { RunnerTemplate } from "../src/iroh-node.ts";
import { MAX_HOOK_BYTES, NO_HOOKS, projectHooks, type WorkspaceAllocation } from "../src/registry.ts";
import { provisionWorkspace, resumeWorkspace } from "../src/vm.ts";
import { VmWorkspace } from "../src/vm-workspace.ts";
import { GUEST_HOOKS_DIRECTORY, GUEST_PACKAGES, vmSeed } from "../src/vm-seed.ts";
import { DEFAULT_TEMPLATE_TTL_MS, TEMPLATE_FORMAT, obsoleteTemplates, pickTemplate, templateKey, templateMeta, templateSettings } from "../src/vm-template.ts";
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
    console.log("ok: fresh machine: pre-setup then .agents/setup, pre-resume then .agents/resume, resume once per boot");
  }

  // 2. Failures: a failing external hook stops its phase, never the thread; logs keep the reason.
  {
    const m = machine({ preSetup: "echo broken-pre-setup; exit 7", preResume: "exit 4" });
    const outcome = await provisionWorkspace(m.workspace, "pi", allocation(first), 1);
    assert.deepEqual(statuses(outcome.hooks), { "pre-setup": "failed:7", setup: "notrun" });
    assert.match(fs.readFileSync(path.join(m.home, ".cache/cube/pre-setup.log"), "utf8"), /broken-pre-setup/);
    assert.deepEqual(statuses((await resumeWorkspace(m.workspace, "pi")).hooks), { "pre-resume": "failed:4", resume: "notrun" });
    assert.deepEqual(m.order(), [], "neither repository hook ran");
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
    const reused = await provisionWorkspace(m.workspace, "pi", allocation(second), 2, { kind: "template", setupBlob: firstBlob });
    assert.deepEqual([statuses(reused.hooks), reused.stale], [{ "pre-setup": "skipped", setup: "skipped" }, false]);
    assert.equal(git(workspace, "rev-parse", "HEAD"), second);
    assert.equal(fs.readFileSync(path.join(workspace, "README.md"), "utf8"), "two\n", "the template's own changes are replaced");
    assert.equal(git(workspace, "reflog", "--all").trim(), "", "the template's history is not the thread's");
    assert.deepEqual(m.order(), []);
    // The setup changed: run it here and report the template stale.
    fs.writeFileSync(path.join(work, ".agents/setup"), agentsScript("setup", "echo v3 >/dev/null"), { mode: 0o755 });
    git(work, "commit", "-qam", "three");
    const third = git(work, "rev-parse", "HEAD");
    git(work, "push", "-q", bare, "main");
    const stale = await provisionWorkspace(m.workspace, "pi", allocation(third), 3, { kind: "template", setupBlob: firstBlob });
    assert.deepEqual([statuses(stale.hooks), stale.stale], [{ "pre-setup": "ok", setup: "ok" }, true]);
    assert.deepEqual(m.order(), ["pre-setup", "setup"]);
    console.log("ok: template machine: refreshed checkout, setup skipped; a changed .agents/setup runs here and marks the template stale");
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
    console.log("ok: template key covers project, repositories, pre-setup, base image, platform, disk, guest helper; not commits or resume hooks");
  }

  // 5. Selection and collection.
  {
    const now = Date.now();
    const meta = (projectId: string) => JSON.stringify({ format: TEMPLATE_FORMAT, projectId, setupBlob: "none", commit: null });
    const template = (id: string, key: string, age: number, projectId = "p1", state: RunnerTemplate["state"] = "ready"): RunnerTemplate =>
      ({ id, key, meta: meta(projectId), state, diskGiB: 8, bytes: 1, createdAt: now - age, users: 0 });
    const k1 = "1".repeat(64), k2 = "2".repeat(64);
    const all = [template("a000000000000001", k1, 5000), template("a000000000000002", k1, 1000), template("a000000000000003", k1, 10, "p1", "removing"),
      template("a000000000000004", k2, 10), template("a000000000000005", k1, DEFAULT_TEMPLATE_TTL_MS + 1),
      { ...template("a000000000000006", k1, 1), meta: "{}" }, template("a000000000000007", k2, 10, "gone")];
    assert.equal(pickTemplate(all, k1, now, DEFAULT_TEMPLATE_TTL_MS)?.id, "a000000000000002", "newest ready, unexpired, readable, same key");
    assert.equal(pickTemplate(all, "3".repeat(64), now, DEFAULT_TEMPLATE_TTL_MS), null);
    assert.equal(pickTemplate(all, k1, now, 500), null, "a shorter TTL");
    const exists = (id: string) => id !== "gone";
    assert.deepEqual(obsoleteTemplates(all, { now, ttlMs: DEFAULT_TEMPLATE_TTL_MS, projectExists: exists }).sort(),
      ["a000000000000005", "a000000000000006", "a000000000000007"], "expired, unreadable, deleted project");
    assert.deepEqual(obsoleteTemplates(all, { now, ttlMs: DEFAULT_TEMPLATE_TTL_MS, projectExists: exists, projectId: "p1", keep: "a000000000000002" }).sort(),
      ["a000000000000001", "a000000000000004", "a000000000000005", "a000000000000006", "a000000000000007"], "a new template supersedes the project's others");
    assert.equal(templateMeta("not json"), null);
    assert.deepEqual(templateSettings({}), { enabled: true, ttlMs: DEFAULT_TEMPLATE_TTL_MS });
    assert.deepEqual(templateSettings({ CUBED_TEMPLATES: "off", CUBED_TEMPLATE_TTL_HOURS: "2" }), { enabled: false, ttlMs: 2 * 3600000 });
    assert.throws(() => templateSettings({ CUBED_TEMPLATE_TTL_HOURS: "-1" }));
    assert.throws(() => templateSettings({ CUBED_TEMPLATES: "maybe" }));
    console.log("ok: newest fresh template of the key is chosen; expired, unreadable, orphaned and superseded ones are removed");
  }

  // 6. The seed carries the hooks; a template's machine skips the package refresh.
  {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(root, "host")]);
    const input = { vmId: "0123456789abcdef", hostKey: { privateKey: fs.readFileSync(path.join(root, "host"), "utf8"), publicKey: fs.readFileSync(path.join(root, "host.pub"), "utf8") },
      clientKeyPub: fs.readFileSync(path.join(root, "host.pub"), "utf8"), caPem: "-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n", placeholders: {} };
    const config = (seed: { userData: string }) => JSON.parse(seed.userData.slice("#cloud-config\n".length));
    const withHooks = config(vmSeed({ ...input, hooks: { preSetup: "echo a", preResume: "#!/bin/sh\necho b" } }));
    const hook = (name: string) => withHooks.write_files.find((file: { path: string }) => file.path === `${GUEST_HOOKS_DIRECTORY}/${name}`);
    assert.equal(gunzipSync(Buffer.from(hook("pre-setup").content, "base64")).toString(), "#!/bin/bash\necho a\n");
    assert.equal(gunzipSync(Buffer.from(hook("pre-resume").content, "base64")).toString(), "#!/bin/sh\necho b\n");
    assert.equal(hook("pre-setup").permissions, "0755");
    assert.deepEqual([withHooks.package_update, withHooks.packages], [true, GUEST_PACKAGES]);
    const none = config(vmSeed({ ...input, hooks: NO_HOOKS }));
    assert.ok(!none.write_files.some((file: { path: string }) => file.path.startsWith(GUEST_HOOKS_DIRECTORY)));
    const onTemplate = config(vmSeed({ ...input, fromTemplate: true }));
    assert.deepEqual([onTemplate.package_update, onTemplate.packages], [false, undefined]);
    // The largest hooks still fit the runner's seed limit.
    vmSeed({ ...input, hooks: { preSetup: "#".repeat(MAX_HOOK_BYTES), preResume: "#".repeat(MAX_HOOK_BYTES) } });
    console.log("ok: seed writes the hooks as executables; a template machine skips the package refresh; maximal hooks fit");
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
