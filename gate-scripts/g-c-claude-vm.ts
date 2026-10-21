/** G-c: one Claude Code thread turn in a real thread VM (review 720f1b4c).
 * A fresh cubed in this process (createCubed on a new state, the real
 * `claude` CLI and its host login, the real cube-gateway with test-hooks)
 * and a real `berth vm` (keel under QEMU) enrolled in it alone. One thread
 * of model claude-code/haiku gets ONE prompt: Bash `pwd`, then write a file
 * named by a nonce. That turn is the only model call (paid, approved);
 * nothing is retried. Then, without the model:
 *   - the guest's own `pwd` and the file are read through cubed's workspace
 *     (the agent's lease), not through Claude;
 *   - the file must not exist on the host: not in Claude Code's cwd, not
 *     anywhere under this run's root, not in $HOME or this process's cwd;
 *   - the Bash result must be the guest's workspace and name no host path.
 * Not part of the repository: copy it to packages/server/test/ of the pinned
 * checkout and run it from there.
 *
 *   CLAUDE=/abs/claude CUBE_TEST_BERTH_* … node packages/server/test/g-c-claude-vm.ts <berth>
 * Environment as runner-vm-cubed-test.ts (QEMU, QEMU_IMG, KEEL, IMAGE, MKFS,
 * ACCEL, TMP, GATEWAY optional), plus CLAUDE (absolute path). Exits by itself. */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxProvider } from "@earendil-works/pi-ai";
import { fakeGithub, git } from "../../../scripts/fake-github.ts";
import { createCubed } from "../src/index.ts";
import { enrollRunner } from "../src/runner-enroll.ts";

const binary = path.resolve(process.argv[2] ?? "");
const repo = path.resolve(import.meta.dirname, "../../..");
const env = process.env;
const started = Date.now();
const note = (line: string) => console.log(`g-c [${((Date.now() - started) / 1000).toFixed(1)}s]: ${line}`);
const claude = env.CLAUDE ?? "";
const [qemu, qemuImg, keel, image, mkfs] = [env.CUBE_TEST_BERTH_QEMU, env.CUBE_TEST_BERTH_QEMU_IMG, env.CUBE_TEST_BERTH_KEEL, env.CUBE_TEST_BERTH_IMAGE, env.CUBE_TEST_BERTH_MKFS].map(v => v ?? "");
const accel = env.CUBE_TEST_BERTH_ACCEL ?? (process.platform === "darwin" ? "hvf" : "kvm");
assert.ok(fs.existsSync(binary), "usage: … g-c-claude-vm.ts <berth binary>");
assert.ok(path.isAbsolute(claude) && fs.existsSync(claude), "CLAUDE=<absolute path of the claude CLI>");
for (const [name, value] of Object.entries({ qemu, qemuImg, mkfs })) assert.ok(path.isAbsolute(value) && fs.existsSync(value), `CUBE_TEST_BERTH_${name}`);
assert.ok(fs.existsSync(path.join(keel, "vmlinuz")) && /@sha256:[0-9a-f]{64}$/.test(image), "CUBE_TEST_BERTH_KEEL / _IMAGE");
note(`claude ${execFileSync(claude, ["--version"], { encoding: "utf8" }).trim()}`);

const root = fs.realpathSync(fs.mkdtempSync(path.join(env.CUBE_TEST_BERTH_TMP ?? "/tmp", "gc-")));
const directory = path.join(root, "m");
const state = path.join(root, "state");
const node = "node-g-c";
const controlKey = path.join(root, "control.key");
const control = JSON.parse(execFileSync(binary, ["keygen", "--key", controlKey], { encoding: "utf8" })) as { peerId: string };
const nonce = randomBytes(6).toString("hex");
const file = `gc-${nonce}.txt`;

// ---- berth vm, enrolled in this cubed only
const berth: ChildProcess = spawn(binary, ["vm", "--dir", directory, "--qemu", qemu, "--qemu-img", qemuImg, "--keel", keel, "--mkfs-erofs", mkfs,
  "--accel", accel, "--image", image, "--listen", "127.0.0.1:0", "--allow-peer", control.peerId, "--node-id", node], { stdio: ["ignore", "ignore", "pipe"], detached: true });
let banner = "";
berth.stderr!.setEncoding("utf8");
const berthLog = fs.createWriteStream(path.join(root, "berth.log"), { flags: "a" });
berth.stderr!.on("data", chunk => berthLog.write(chunk));
await new Promise<void>((resolve, reject) => {
  berth.stderr!.on("data", chunk => { banner += chunk; if (banner.includes("waiting for cubed")) resolve(); });
  berth.once("exit", code => reject(new Error(`berth vm exited (${code}): ${banner}`)));
});
const field = (name: string) => banner.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1]?.trim() ?? "";
note(banner.split("\n").filter(line => /^(qemu|accelerator|keel|image):/.test(line)).join(" | "));
const configPath = path.join(root, "runner.json");
fs.writeFileSync(configPath, JSON.stringify({ version: 2, protocol: 4, binding: { nodeId: node, threadId: node, environmentId: 9 },
  controlKey, serverPeer: field("peer"), network: "loopback", address: field("listen").split(", ")[0] }), { mode: 0o600 });

// ---- the fake GitHub and the repository (the guest checks it out)
const token = `ghs_gc${randomBytes(12).toString("hex")}`;
const github = await fakeGithub({ dir: path.join(root, "github"), token });
const seed = path.join(root, "seed");
git(root, "clone", "-q", github.repository, seed);
fs.writeFileSync(path.join(seed, "README.md"), "g-c\n");
git(seed, "add", "-A");
git(seed, "commit", "-qm", "g-c");
git(seed, "push", "-q", "origin", "HEAD:main");
const gitconfig = path.join(root, "gitconfig");
fs.writeFileSync(gitconfig, `[url "file://${path.join(root, "github", "cube-e2e")}/"]\n\tinsteadOf = https://github.com/cube-e2e/\n`);
process.env.GIT_CONFIG_GLOBAL = gitconfig;
const gatewayBin = env.CUBE_TEST_BERTH_GATEWAY || (() => {
  execFileSync("cargo", ["build", "--locked", "--offline", "-p", "cube-gateway", "--features", "test-hooks"],
    { cwd: repo, env: { ...process.env, CARGO_TARGET_DIR: path.join(repo, "target/test-hooks") }, stdio: "ignore" });
  return path.join(repo, "target/test-hooks/debug/cube-gateway");
})();
process.env.CUBED_GATEWAY_TEST_ARGS = JSON.stringify(["--test-upstream", `github.com=127.0.0.1:${github.port}`,
  "--test-upstream", `api.github.com=127.0.0.1:${github.port}`, "--test-upstream-ca", github.ca]);
process.env.CUBED_VM_VCPUS = "2";
process.env.CUBED_VM_MEMORY_MIB = "2048";
process.env.CUBED_VM_DISK_GIB = "16";

// ---- cubed: the real claude CLI; Pi gets only a faux model (never called here)
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const app = await createCubed({ state, models, claude: [claude], gateway: gatewayBin, skillSource: null,
  secrets: [{ name: "github", hosts: ["github.com", "api.github.com"], value: async () => token }] });
await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
const api = async (route: string, method = "GET", body?: unknown) => {
  const response = await fetch(`${url}${route}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const answer = await response.text();
  if (response.status >= 400) throw new Error(`${method} ${route}: ${response.status} ${answer}`);
  return answer ? JSON.parse(answer) : undefined;
};
async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined | false>): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await delay(500);
  }
}

let failure: unknown = null;
let id = "";
try {
  const enrolled = await enrollRunner({ state, configPath });
  assert.equal(enrolled.profile, "vm-runner");
  await api("/api/onboarding", "POST", {});
  const project = (await api("/api/projects", "POST", { name: "gc", repositories: [{ url: "https://github.com/cube-e2e/repo.git", base: "main" }] })).project as { id: string };
  await until("the project is ready", 60000, async () => (await api("/api/projects")).projects.find((p: { id: string; status: string }) => p.id === project.id && p.status === "ready"));
  await app.gateway!.ready();

  // ---- the one paid turn
  const text = `Use the Bash tool exactly once to run this command, then reply DONE:\npwd && printf %s ${nonce} > ${file} && cat ${file}`;
  id = (await api("/api/threads", "POST", { projectId: project.id, requestId: "g-c", text, model: { provider: "claude-code", id: "haiku" }, runner: node })).id;
  await until("the thread's machine is ready", 900000, async () => {
    const thread = app.registry.getThread(id)!;
    if (thread.workspaceState === "failed") throw new Error(`the machine failed: ${thread.workspaceError}`);
    return thread.workspaceState === "available";
  });
  const vm = app.registry.getThread(id)!.vm!;
  note(`thread ${id} on ${node}: machine ${vm.vmId}, ${vm.steps?.find(step => step.name === "boot")?.detail ?? "?"}`);
  const history = await until("the turn settles", 300000, async () => {
    const value = await api(`/api/threads/${id}/history`);
    return value.status?.run && !["working", "idle", "starting"].includes(value.status.state) ? value : undefined;
  });
  const events = history.events as Array<{ type: string; name?: string; output?: string; isError?: boolean; text?: string }>;
  const calls = events.filter(event => event.type === "tool-call").map(event => event.name);
  const results = events.filter(event => event.type === "tool-result");
  note(`turn: ${history.status.state}; tool calls ${JSON.stringify(calls)}; results ${JSON.stringify(results.map(result => (result.output ?? "").slice(0, 200)))}`);
  assert.equal(history.status.state, "completed", JSON.stringify(history.status));

  // ---- the guest, read through cubed's workspace (not through Claude)
  const agent = await app.conversations.claudeAgent(id) as unknown as { workspace: { exec: Function; operation: Function; readFile: Function }; lease: { token: string }; root: string };
  const lease = agent.lease.token;
  await agent.workspace.exec(lease, `g-c-pwd-${nonce}`, { command: "pwd; hostname; cat /proc/sys/kernel/random/boot_id", timeoutMs: 30000 });
  const op = await until("the guest's pwd", 60000, async () => { const value = await agent.workspace.operation(lease, `g-c-pwd-${nonce}`, { waitMs: 5000 }); return value.state !== "running" ? value : undefined; }) as { state: string; output: Uint8Array };
  assert.equal(op.state, "succeeded", JSON.stringify(op));
  const [guestPwd, guestHost, guestBoot] = Buffer.from(op.output).toString("utf8").trim().split("\n");
  const content = Buffer.from((await agent.workspace.readFile(lease, file) as { content: Uint8Array }).content).toString("utf8");
  note(`guest (read by cubed): pwd ${guestPwd}, hostname ${guestHost}, boot ${guestBoot}; ${file} = ${JSON.stringify(content)}`);
  assert.equal(content, nonce, "the file is in the VM with the nonce");

  // ---- the Bash result is the guest's, and names no host path
  const bashOut = results.map(result => result.output ?? "").join("\n");
  assert.ok(bashOut.split("\n").some(line => line.trim() === guestPwd), `Bash's pwd is the guest's workspace (${guestPwd}): ${bashOut}`);
  assert.ok(bashOut.includes(nonce), "Bash printed the file back");
  for (const host of [agent.root, fs.realpathSync(agent.root), root, os.homedir(), process.cwd()]) assert.ok(!bashOut.includes(host), `the result names no host path (${host})`);
  assert.notEqual(guestHost, os.hostname(), "the guest is not this host");

  // ---- the file is not on the host
  const found = execFileSync("find", [root, "-name", file], { encoding: "utf8" }).trim();
  assert.equal(found, "", `not under the run's root (Claude Code's cwd ${agent.root} is in it): ${found}`);
  for (const dir of [os.homedir(), process.cwd(), os.tmpdir()]) assert.ok(!fs.existsSync(path.join(dir, file)), `not in ${dir}`);
  note(`host: no ${file} under ${root} (Claude Code's cwd ${agent.root}), $HOME, cwd or tmp`);
  const usage = await api(`/api/threads/${id}/usage`).catch(() => null);
  note(`usage: ${JSON.stringify(usage?.usage?.totals ?? usage?.usage ?? null)}`);
  console.log(`ok: G-c: one Claude Code turn in a real ${accel} thread VM: Bash pwd = the guest's ${guestPwd}, ${file} written in the VM and not on the host`);
} catch (error) {
  failure = error;
} finally {
  if (id) await api(`/api/threads/${id}`, "DELETE").catch(error => note(`archive: ${error}`));
  if (id) await api(`/api/threads/${id}/discard`, "POST").catch(() => {});
  await app.close().catch(() => {});
  github.close?.();
  if (berth.exitCode === null) { const exited = once(berth, "exit"); process.kill(-berth.pid!, "SIGINT"); await Promise.race([exited, delay(60000)]); }
  note(`kept for evidence: ${root}`);
}
if (failure) { console.error(failure); process.exit(1); }
process.exit(0);
