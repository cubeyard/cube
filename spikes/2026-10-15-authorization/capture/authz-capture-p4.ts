/** SPIKE (authorization plan, step 2), protocol 4: record at berth vm's
 * gate what real clients send, with cubed's real code. Derived from
 * runner-vm-cubed-test.ts (C-a): a fresh cubed in this process (faux model,
 * the real egress policy and credential proxy, the host's GitHub token as
 * the github secret), a berth vm built with berth-gate-record.patch
 * (BERTH_GATE_RECORD: each request as the guest sent it, before the policy)
 * and a keel machine. The thread works in a disposable private repository.
 *
 *   node packages/server/test/authz-capture-p4.ts <patched berth> <owner/repo> <out.jsonl>
 *
 * Same environment as runner-vm-cubed-test.ts, plus CUBE_TEST_BERTH_GATEWAY.
 * Run from packages/server/test (imports cubed's sources); kept under
 * spikes/2026-10-15-authorization/capture. Loopback only. */
import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createCubed } from "../src/index.ts";
import { cubeThreads } from "../src/optchat-threads.ts";
import { portalSettings } from "../src/portal.ts";
import { enrollRunner } from "../src/runner-enroll.ts";
import { describeRunners, observeRunners } from "../src/runner-observe.ts";
import { MachineStatus_Phase } from "../src/gen/runner_pb.js";
import { runnerSession, STOP_TIMEOUT_MS } from "../src/runner-session.ts";
import { currentMachineEpoch } from "../src/vm.ts";
import { DIAL_APP, request } from "./portal-dial.ts";

const binary = path.resolve(process.argv[2] ?? "target/debug/berth");
const repository = process.argv[3] ?? "";
const outFile = path.resolve(process.argv[4] ?? "capture-p4.jsonl");
assert.match(repository, /^[\w.-]+\/[\w.-]+$/, "usage: authz-capture-p4.ts <berth> <owner/repo> <out.jsonl>");
const recordFile = path.join(fs.mkdtempSync("/tmp/authz-p4-"), "gate.jsonl");
process.env.BERTH_GATE_RECORD = recordFile;
const repo = path.resolve(import.meta.dirname, "../../..");
assert.ok(fs.existsSync(binary), `${binary}: build berth first (cargo build -p berth)`);
const env = process.env;
const started = Date.now();
const note = (line: string) => console.log(`authz-capture-p4 [${((Date.now() - started) / 1000).toFixed(1)}s]: ${line}`);

const qemu = env.CUBE_TEST_BERTH_QEMU ?? "";
const qemuImg = env.CUBE_TEST_BERTH_QEMU_IMG ?? "";
const keel = env.CUBE_TEST_BERTH_KEEL ?? "";
const image = env.CUBE_TEST_BERTH_IMAGE ?? "";
const mkfs = env.CUBE_TEST_BERTH_MKFS ?? "";
const pulled = env.CUBE_TEST_BERTH_PULLED ?? "";
const accel = env.CUBE_TEST_BERTH_ACCEL ?? (process.platform === "darwin" ? "hvf" : "kvm");
const missing = [
  ...(path.isAbsolute(qemu) && fs.existsSync(qemu) ? [] : ["CUBE_TEST_BERTH_QEMU=<absolute qemu-system path meeting keel's floor>"]),
  ...(path.isAbsolute(qemuImg) && fs.existsSync(qemuImg) ? [] : ["CUBE_TEST_BERTH_QEMU_IMG=<absolute qemu-img path>"]),
  ...(fs.existsSync(path.join(keel, "vmlinuz")) && fs.existsSync(path.join(keel, "base.erofs")) ? [] : ["CUBE_TEST_BERTH_KEEL=<keel out/<arch> with vmlinuz and base.erofs>"]),
  ...(/@sha256:[0-9a-f]{64}$/.test(image) ? [] : ["CUBE_TEST_BERTH_IMAGE=<registry/repository@sha256:digest>"]),
  ...(path.isAbsolute(mkfs) && fs.existsSync(mkfs) ? [] : ["CUBE_TEST_BERTH_MKFS=<absolute mkfs.erofs path>"]),
];
if (missing.length) {
  console.error(`\nSKIP: cubed with berth vm did NOT run; missing:\n${missing.map(m => `  - ${m}`).join("\n")}`);
  if (env.CUBE_TEST_BERTH_VM === "required") process.exit(1);
  process.exit(0);
}

// Short: a machine's sockets must fit sun_path (104 bytes on macOS).
const root = fs.realpathSync(fs.mkdtempSync(path.join(env.CUBE_TEST_BERTH_TMP ?? "/tmp", "cvc-")));
const directory = path.join(root, "m");
const state = path.join(root, "state");
const node = "node-vm-cubed";
const controlKey = path.join(root, "control.key");
const control = JSON.parse(execFileSync(binary, ["keygen", "--key", controlKey], { encoding: "utf8" })) as { peerId: string };

// ---------------------------------------------------------------- berth vm

let listen = "127.0.0.1:0";
async function start(first: boolean): Promise<{ child: ChildProcess; peer: string; address: string; banner: string }> {
  const child = spawn(binary, ["vm", "--dir", directory, "--qemu", qemu, "--qemu-img", qemuImg, "--keel", keel, "--mkfs-erofs", mkfs,
    "--accel", accel, "--image", image, "--listen", listen, ...(first ? ["--allow-peer", control.peerId, "--node-id", node] : [])],
  // Its own process group, as in a terminal: a Ctrl-C reaches the whole group.
  { stdio: ["ignore", "ignore", "pipe"], detached: true });
  let banner = "";
  child.stderr!.setEncoding("utf8");
  const log = fs.createWriteStream(path.join(root, "berth.log"), { flags: "a" });
  child.stderr!.on("data", chunk => log.write(chunk));
  await new Promise<void>((resolve, reject) => {
    child.stderr!.on("data", chunk => { banner += chunk; if (banner.includes("waiting for cubed")) resolve(); });
    child.once("exit", code => reject(new Error(`berth vm exited (${code}): ${banner}`)));
  });
  const field = (name: string) => banner.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1]?.trim() ?? "";
  return { child, peer: field("peer"), address: field("listen").split(", ")[0]!, banner };
}
/** One QMP command on a machine's socket (berth holds no connection between verbs). */
async function qmp(socketPath: string, command: string): Promise<void> {
  const socket = net.connect(socketPath);
  socket.setEncoding("utf8");
  let buffer = "";
  const next = async () => {
    for (;;) {
      const line = buffer.indexOf("\n");
      if (line >= 0) { const message = JSON.parse(buffer.slice(0, line)); buffer = buffer.slice(line + 1); if (!("event" in message)) return message; continue; }
      const [chunk] = await once(socket, "data") as [string];
      buffer += chunk;
    }
  };
  try {
    await next();
    socket.write(`${JSON.stringify({ execute: "qmp_capabilities" })}\n`);
    await next();
    socket.write(`${JSON.stringify({ execute: command })}\n`);
    const answer = await next() as { return?: unknown };
    assert.ok(answer.return !== undefined, `${command}: ${JSON.stringify(answer)}`);
  } finally { socket.destroy(); }
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  process.kill(-child.pid!, "SIGINT");
  await exited;
}
if (pulled) for (const part of ["images", "layers"]) fs.cpSync(path.join(pulled, part), path.join(directory, part), { recursive: true });
let runner = await start(true);
listen = runner.address;
note(runner.banner.split("\n").filter(line => /^(qemu|accelerator|keel|image|listen):/.test(line)).join(" | "));
const configPath = path.join(root, "runner.json");
fs.writeFileSync(configPath, JSON.stringify({ version: 2, protocol: 4, binding: { nodeId: node, threadId: node, environmentId: 9 },
  controlKey, serverPeer: runner.peer, network: "loopback", address: runner.address }), { mode: 0o600 });

// ---------------------------------------------------------------- cubed

const free = net.createServer().listen(0, "127.0.0.1");
await once(free, "listening");
const portalPort = (free.address() as net.AddressInfo).port;
await new Promise(resolve => free.close(resolve));
const text = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => (part as { text?: string }).text ?? "").join("") : "";
const faux = fauxProvider({ tokensPerSecond: 1000, tokenSize: { min: 4, max: 8 } });
// As e2e-fixture.ts: `tool {"name","args"}` calls that tool; then `result: <output>`.
faux.setResponses(Array.from({ length: 1000 }, () => async (request: { messages: Array<{ role: string; content: unknown }> }) => {
  const last = request.messages.at(-1);
  if (last?.role === "toolResult") return fauxAssistantMessage(`result: ${text(last.content)}`);
  const prompt = text(last?.content).trim();
  if (prompt.startsWith("tool ")) {
    const { name, args } = JSON.parse(prompt.slice(5)) as { name: string; args: Record<string, unknown> };
    return fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], { stopReason: "toolUse" });
  }
  return fauxAssistantMessage("ok");
}));
const models = createModels();
models.setProvider(faux.provider);
process.env.CUBED_VM_VCPUS = "4";
process.env.CUBED_VM_MEMORY_MIB = "4096";
process.env.CUBED_VM_DISK_GIB = "16";
const hostToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
const gatewayBin = env.CUBE_TEST_BERTH_GATEWAY!;
assert.ok(gatewayBin && fs.existsSync(gatewayBin), "CUBE_TEST_BERTH_GATEWAY=<cube-gateway>");
const app = await createCubed({ state, models, claude: null, gateway: gatewayBin, skillSource: null,
  secrets: [{ name: "github", hosts: ["github.com", "api.github.com"], value: async () => hostToken }],
  portal: portalSettings({ CUBED_PORTAL_IP: "127.0.0.1", CUBED_PORTAL_DOMAIN: "localhost", CUBED_PORTAL_PORT: String(portalPort) }) });
await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
const api = async (route: string, method = "GET", body?: unknown) => {
  const response = await fetch(`${url}${route}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const answer = await response.text();
  if (response.status >= 400) throw new Error(`${method} ${route}: ${response.status} ${answer}`);
  return answer ? JSON.parse(answer) : undefined;
};
async function until<T>(what: string, ms: number, probe: () => Promise<T | undefined | false> | T | undefined | false): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await delay(250);
  }
}
let requests = 0;
async function prompt(id: string, line: string, ms = 300000): Promise<string> {
  const run = `ca-${++requests}`;
  await api(`/api/threads/${id}/prompt`, "POST", { text: line, requestId: run });
  const history = await until(`run ${run}`, ms, async () => {
    const value = await api(`/api/threads/${id}/history`);
    return value.status?.run === run && !["working", "idle"].includes(value.status.state) ? value : undefined;
  });
  assert.equal(history.status.state, "completed", JSON.stringify(history.status));
  const last = [...history.events].reverse().find((event: { type: string }) => event.type === "assistant-text") as { text?: string } | undefined;
  return last?.text ?? "";
}
async function bash(id: string, command: string, ms = 300000): Promise<string> {
  const answer = await prompt(id, `tool ${JSON.stringify({ name: "bash", args: { command, timeoutMs: Math.min(ms, 600000) } })}`, ms + 30000);
  return answer.replace(/^result: /, "").trimEnd();
}
const scenarios: { name: string; command: string; from: number; to: number; ok: boolean; output: string }[] = [];
async function scenario(id: string, name: string, command: string, ms = 300000): Promise<string> {
  const from = Date.now();
  const output = await bash(id, `set -e; cd /workspace; ${command}`, ms).catch((error: Error) => `[error] ${error.message}`);
  const ok = /\[exit=0;/.test(output);
  scenarios.push({ name, command, from, to: Date.now(), ok, output: output.slice(-2000) });
  note(`${ok ? "ok  " : "FAIL"} ${name}`);
  return output;
}

try {
  await enrollRunner({ state, configPath });
  await api("/api/onboarding", "POST", {});
  const upstream = `https://github.com/${repository}`;
  const project = (await api("/api/projects", "POST", { name: "authz", repositories: [{ url: upstream, base: "main" }] })).project as { id: string };
  const ready = await until("the project is ready", 120000, async () => {
    const row = (await api("/api/projects")).projects.find((p: { id: string }) => p.id === project.id) as { status: string; error: string | null };
    return row.status !== "checking" ? row : undefined;
  });
  assert.equal(ready.status, "ready", ready.error ?? "");
  const threads = cubeThreads({ registry: app.registry, conversations: app.conversations,
    catalog: async () => [{ provider: faux.getModel().provider, id: faux.getModel().id }],
    runners: () => observeRunners(app.registry, 60_000),
    latestCommits: async () => {
      const current = app.registry.getProject(project.id)!;
      return { projectRevision: current.revision, repositories: current.repositories.map(r => ({ url: r.url, base: r.resolvedBase!, baseOid: r.baseOid! })) };
    } });
  assert.ok(app.gateway, "cubed started its gateway");
  await app.gateway.ready();
  const booting = Date.now();
  const id = (await threads.spawn({ project: "authz", task: "say hi", runner: node }, "req-vm")).id;
  await until("the thread's machine is ready", 900000, () => {
    const current = app.registry.getThread(id)!;
    if (current.workspaceState === "failed") throw new Error(`the machine failed: ${current.workspaceError}`);
    return current.workspaceState === "available";
  });
  const vm = app.registry.getThread(id)!.vm!;
  note(`ready in ${((Date.now() - booting) / 1000).toFixed(1)} s: ${vm.steps!.map(step => `${step.name}:${step.state}`).join(", ")}`);
  await until("the first turn", 300000, async () => {
    const value = await api(`/api/threads/${id}/history`);
    return value.status?.run === "cube:initial" && !["working", "idle"].includes(value.status.state) ? value : undefined;
  });
  const placeholder = vm.placeholders.github;
  assert.match(placeholder, /^cube_ph_github_[A-Za-z0-9]{22}$/);
  const t = `t-${id.slice(0, 8)}`;
  const base = "export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 NO_COLOR=1; git config --global user.name capture; git config --global user.email capture@cube.invalid";
  await scenario(id, "whoami", "id; printenv GH_TOKEN | cut -c1-15; git remote -v; git config --show-origin --get-regexp credential || true");
  await scenario(id, "setup-apt", "sudo DEBIAN_FRONTEND=noninteractive apt-get update -q >/dev/null; gh --version | head -1; git --version; npm --version", 900000);
  const url = upstream;
  await scenario(id, "git-clone", `${base}; cd ~; rm -rf repo; git clone ${url} repo`);
  await scenario(id, "git-clone-v0", `${base}; cd ~; rm -rf repo-v0; git -c protocol.version=0 clone ${url} repo-v0`);
  await scenario(id, "git-push-branch", `${base}; cd ~/repo; echo one-${t} > a.txt; git add a.txt; git commit -qm one; git push origin HEAD:refs/heads/cube/${t}/work`);
  await scenario(id, "git-push-main", `${base}; cd ~/repo; echo two-${t} > b.txt; git add b.txt; git commit -qm two; git push origin HEAD:main || (git pull -q --rebase origin main && git push origin HEAD:main)`);
  await scenario(id, "git-push-multi", `${base}; cd ~/repo; git push origin HEAD:refs/heads/cube/${t}/a HEAD:refs/heads/cube/${t}/b`);
  await scenario(id, "git-push-force", `${base}; cd ~/repo; git commit -q --amend -m two-amended; git push -f origin HEAD:refs/heads/cube/${t}/work`);
  await scenario(id, "git-push-delete", `${base}; cd ~/repo; git push origin :refs/heads/cube/${t}/b`);
  await scenario(id, "git-push-tag", `${base}; cd ~/repo; git tag capture-${t}; git push origin capture-${t}`);
  await scenario(id, "git-push-atomic-options", `${base}; cd ~/repo; echo three-${t} > c.txt; git add c.txt; git commit -qm three; git push --atomic -o ci.skip origin HEAD:refs/heads/cube/${t}/work HEAD:refs/heads/cube/${t}/c`);
  await scenario(id, "git-fetch", `${base}; cd ~/repo; git fetch origin`);
  await scenario(id, "git-ls-remote", `${base}; git ls-remote ${url}`);
  await scenario(id, "gh-pr-create", `${base}; cd ~/repo; gh pr create --repo ${repository} --head cube/${t}/work --base main --title "capture ${t}" --body "disposable capture"`);
  await scenario(id, "gh-pr-list-view", `${base}; gh pr list --repo ${repository}; gh pr view --repo ${repository} cube/${t}/work || true`);
  await scenario(id, "gh-api-rest-read", `${base}; gh api repos/${repository} >/dev/null; gh api repos/${repository}/pulls >/dev/null; gh api user >/dev/null`);
  await scenario(id, "gh-api-rest-write-issue", `${base}; gh api -X POST repos/${repository}/issues -f title="capture ${t}" -f body=disposable >/dev/null`);
  await scenario(id, "gh-api-rest-write-contents", `${base}; gh api -X PUT repos/${repository}/contents/rest-${t}.txt -f message="contents api" -f content=$(printf hi | base64) -f branch=cube/${t}/a >/dev/null`);
  await scenario(id, "gh-api-graphql-query", `${base}; gh api graphql -f query='query { viewer { login } }' >/dev/null`);
  await scenario(id, "gh-api-graphql-mutation", `${base}; rid=$(gh api graphql -f query='query($o:String!,$n:String!){repository(owner:$o,name:$n){id}}' -f o=${repository.split("/")[0]} -f n=${repository.split("/")[1]} -q .data.repository.id); gh api graphql -f query='mutation($r:ID!){createIssue(input:{repositoryId:$r,title:"graphql capture"}){issue{number}}}' -f r=$rid >/dev/null`);
  await scenario(id, "gh-pr-merge", `${base}; gh pr merge --repo ${repository} cube/${t}/work --merge`);
  await scenario(id, "gh-api-rest-write-ref", `${base}; sha=$(cd ~/repo && git rev-parse HEAD); gh api -X POST repos/${repository}/git/refs -f ref=refs/heads/cube/${t}/rest -f sha=$sha >/dev/null; gh api -X PATCH repos/${repository}/git/refs/heads/main -f sha=$sha -F force=true >/dev/null || true`);
  await scenario(id, "npm-install", `${base}; mkdir -p ~/npmtest && cd ~/npmtest && npm init -y >/dev/null && npm install --no-audit --no-fund is-number@7.0.0`);
  await scenario(id, "npm-install-audit", `${base}; cd ~/npmtest && npm install --no-fund left-pad@1.3.0`);
  await scenario(id, "curl-download", `${base}; curl -fsS -o /dev/null https://raw.githubusercontent.com/${repository}/main/README.md -H "Authorization: token $GH_TOKEN" || true`);
  const recorded = fs.readFileSync(recordFile, "utf8");
  assert.ok(!recorded.includes(hostToken), "the recording holds placeholders only");
  const scan = await bash(id, `sudo grep -rIl -F ${JSON.stringify(hostToken.slice(4, 24))} /home /etc /root /tmp /workspace 2>/dev/null | head -3; echo scanned`);
  assert.ok(!scan.replace(/\n?\[exit=\d+;[^\]]*\]$/, "").replace("scanned", "").trim(), `the host's token is not in the guest: ${scan}`);
  fs.writeFileSync(outFile, recorded);
  fs.writeFileSync(outFile.replace(/\.jsonl$/, ".scenarios.json"), JSON.stringify({ placeholder, vmId: vm.vmId, id: t, repository, scenarios }, null, 2));
  note(`recorded ${recorded.split("\n").filter(Boolean).length} requests at berth's gate -> ${outFile}`);
} finally {
  app.server.closeAllConnections();
  await app.close();
  await stop(runner.child);
  try { execFileSync("pkill", ["-KILL", "-f", directory], { stdio: "ignore" }); } catch { /* none left */ }
  if (env.CUBE_TEST_KEEP !== "1") fs.rmSync(root, { recursive: true, force: true });
  else note(`kept ${root}`);
}
