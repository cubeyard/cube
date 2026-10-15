// Spike for the authorization plan, step 2: record at the gate what real
// clients send. The real cube-runner (protocol 3), a cube-gateway built with
// gateway-record.patch (CUBE_GATEWAY_RECORD: every request as the guest sent
// it, before substitution) and a Debian genericcloud VM; a decision server
// that behaves like cubed's egress policy (the github placeholder becomes the
// host's token only over https to github.com and api.github.com). The guest
// works against a disposable private repository. Derived from
// scripts/smoke-runner-vm.ts; disposable state under $TMPDIR.
//
//   node capture.ts <cube-runner> <cube-gateway-record> <image.qcow2> <owner/repo> <out.jsonl>
//
// The host's token comes from `gh auth token`; it never enters the guest
// (the guest holds a placeholder) and never the output (recorded before
// substitution). redact.ts turns the output into the fixture corpus.
import assert from "node:assert/strict";
import { type ChildProcess, execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import readline from "node:readline";

const [runnerBin, gatewayBin, image] = process.argv.slice(2, 5).map((p) => path.resolve(p));
const [repository, outFile] = [process.argv[5], path.resolve(process.argv[6] ?? "capture.jsonl")];
if (!runnerBin || !gatewayBin || !image || !/^[\w.-]+\/[\w.-]+$/.test(repository ?? "")) {
  throw new Error("usage: capture.ts <cube-runner> <cube-gateway-record> <image.qcow2> <owner/repo> <out.jsonl>");
}
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cube-capture-"));
fs.chmodSync(work, 0o700);
const run = path.join(work, "run");
fs.mkdirSync(run, { mode: 0o700 });
const raw = path.join(work, "raw.jsonl");
const node = "node-capture";
const children: ChildProcess[] = [];
const started = Date.now();
const log = (message: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, seconds: number, probe: () => Promise<T | undefined> | T | undefined): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

function start(file: string, args: string[], name: string, env: NodeJS.ProcessEnv = process.env): ChildProcess {
  const child = spawn(file, args, { stdio: ["pipe", "pipe", "pipe"], env });
  const out = fs.createWriteStream(path.join(work, `${name}.log`), { flags: "a" });
  child.stderr!.pipe(out);
  children.push(child);
  return child;
}

async function firstLine(child: ChildProcess): Promise<Record<string, any>> {
  const lines = readline.createInterface({ input: child.stdout! });
  const line = await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve);
    child.once("exit", (code) => reject(new Error(`process exited (${code}) before its ready line`)));
  });
  return JSON.parse(line);
}

function unixRequest(socket: string, method: string, url: string, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: socket, method, path: url, headers: { "content-type": "application/json" } }, (response) => {
      let text = "";
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, json: text ? JSON.parse(text) : undefined }));
    });
    request.on("error", reject);
    if (body !== undefined) request.write(JSON.stringify(body));
    request.end();
  });
}

const keygen = (file: string) => JSON.parse(execFileSync(runnerBin, ["keygen", "--key", file], { encoding: "utf8" })).peerId as string;
let runnerReady: Record<string, any> = {};
const call = (request: Record<string, unknown>): any => JSON.parse(execFileSync(runnerBin, ["call", "--key", path.join(work, "control.key"),
  "--peer", runnerReady.peerId, "--address", runnerReady.addresses[0], "--expect-node", node, "--request", JSON.stringify(request)], { encoding: "utf8" }));

const vmId = randomBytes(8).toString("hex");
const mac = "02:" + createHash("sha256").update(vmId).digest().subarray(0, 5).toString("hex").match(/../g)!.join(":");
const thread = "t-capture";
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const placeholder = `cube_ph_github_${Array.from(randomBytes(22), (b) => BASE62[b % 62]).join("")}`;
const hostToken = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();

function sshArgs(command: string): string[] {
  return ["-F", "none", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes", "-i", path.join(work, "id_client"),
    "-o", `UserKnownHostsFile=${path.join(work, "known_hosts")}`, "-o", "StrictHostKeyChecking=yes", "-o", `HostKeyAlias=cube-vm-${vmId}`,
    "-o", `ProxyCommand=${gatewayBin} dial --control ${path.join(run, "gateway.sock")} --vm ${vmId} --port 22`,
    "-o", "ConnectTimeout=20", "-o", "LogLevel=ERROR", "cube@cube-vm", command];
}
function ssh(command: string, timeout = 60): string {
  return execFileSync("ssh", sshArgs(command), { encoding: "utf8", timeout: timeout * 1000, stdio: ["ignore", "pipe", "pipe"] });
}

/** Scenario boundaries, matched to recorded requests by time. */
const scenarios: { name: string; command: string; from: number; to: number; ok: boolean; output: string }[] = [];
const execFileAsync = promisify(execFile);
// Async: the decision server lives in this process and must keep answering.
async function scenario(name: string, command: string, timeout = 600): Promise<string> {
  const from = Date.now();
  let output = "";
  let ok = true;
  try {
    const result = await execFileAsync("ssh", sshArgs(`set -e; cd ~; ${command}`), { encoding: "utf8", timeout: timeout * 1000, maxBuffer: 64 << 20 });
    output = `${result.stdout}${result.stderr}`;
  } catch (error: any) { ok = false; output = `${error.stdout ?? ""}${error.stderr ?? ""}`; }
  const to = Date.now();
  scenarios.push({ name, command, from, to, ok, output: output.slice(-2000) });
  log(`${ok ? "ok  " : "FAIL"} ${name}`);
  return output;
}

try {
  // The decision server: cubed's egress policy in miniature (egress-policy.ts).
  const decide = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const asked = JSON.parse(body);
      const host = String(asked.host).toLowerCase();
      let answer: unknown = { allow: true };
      if (asked.method === "CONNECT") answer = { allow: false, reason: "CONNECT is not allowed" };
      else if (asked.placeholders.length) {
        const ours = asked.placeholders.every((p: string) => p === placeholder);
        answer = ours && asked.scheme === "https" && ["github.com", "api.github.com"].includes(host)
          ? { allow: true, substitute: { [placeholder]: hostToken } }
          : { allow: false, reason: "secret not allowed here" };
      }
      response.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((resolve) => decide.listen(path.join(run, "egress.sock"), resolve));

  const gateway = start(gatewayBin, ["serve", "--state", path.join(work, "gateway"), "--control", path.join(run, "gateway.sock"),
    "--decide", path.join(run, "egress.sock"), "--network", "loopback"], "gateway", { ...process.env, CUBE_GATEWAY_RECORD: raw });
  const gatewayPeer = (await firstLine(gateway)).peer as string;
  const caPem: string = (await unixRequest(path.join(run, "gateway.sock"), "GET", "/v1/hello")).json.caPem;
  log(`gateway ${gatewayPeer.slice(0, 12)} ready (recording to ${raw})`);

  const control = keygen(path.join(work, "control.key"));
  keygen(path.join(work, "runner.key"));
  execFileSync(runnerBin, ["runner-init", "--key", path.join(work, "runner.key"), "--state", path.join(work, "state"),
    "--image", image, "--allow-peer", control, "--node-id", node, "--thread-id", "t-install", "--env", "1",
    "--max-vcpus", "4", "--max-memory-mib", "4096", "--max-disk-gib", "16"], { encoding: "utf8" });
  runnerReady = await firstLine(start(runnerBin, ["runner-serve", "--key", path.join(work, "runner.key"), "--state", path.join(work, "state"),
    "--max-active-vms", "1"], "runner"));

  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(work, "id_client")]);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path.join(work, "host_ed25519")]);
  const hostPub = fs.readFileSync(path.join(work, "host_ed25519.pub"), "utf8").trim();
  fs.writeFileSync(path.join(work, "known_hosts"), `cube-vm-${vmId} ${hostPub.split(" ").slice(0, 2).join(" ")}\n`);
  const indent = (text: string, spaces: number) => text.trimEnd().split("\n").map((line) => " ".repeat(spaces) + line).join("\n");
  // The same git credential helper and GH_TOKEN placeholder as vm-seed.ts gives a thread.
  const gitconfig = `[user]\n\tname = cube capture\n\temail = capture@cube.invalid\n[credential "https://github.com"]\n\thelper = "!f() { test \\"$1\\" = get || exit 0; echo username=x-access-token; echo \\"password=$GH_TOKEN\\"; }; f"\n`;
  const userData = `#cloud-config
ssh_pwauth: false
users:
  - name: cube
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys: [${JSON.stringify(fs.readFileSync(path.join(work, "id_client.pub"), "utf8").trim())}]
ssh_deletekeys: true
ssh_genkeytypes: []
ssh_keys:
  ed25519_private: |
${indent(fs.readFileSync(path.join(work, "host_ed25519"), "utf8"), 4)}
  ed25519_public: ${hostPub}
ca_certs:
  trusted:
    - |
${indent(caPem, 6)}
write_files:
  - path: /etc/profile.d/cube-capture.sh
    content: |
      export GH_TOKEN=${placeholder}
      export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt
  - path: /etc/cube-capture.gitconfig
    content: |
${indent(gitconfig, 6)}
`;
  assert.ok(!userData.includes(hostToken), "the host's token never enters the seed");
  const seed = { metaData: `instance-id: ${vmId}\nlocal-hostname: cube-${vmId.slice(0, 8)}\n`, userData,
    networkConfig: "version: 2\nethernets:\n  nic:\n    match: {name: \"e*\"}\n    dhcp4: true\n" };

  call({ method: "vm.allocate", threadId: thread, vmId, epoch: 1, diskGiB: 12 });
  const frameToken = randomBytes(32).toString("hex");
  call({ method: "vm.start", threadId: thread, vmId, epoch: 1, vcpus: 4, memoryMiB: 4096, mac, seed, gateway: { peer: gatewayPeer, frameToken } });
  await unixRequest(path.join(run, "gateway.sock"), "PUT", `/v1/vms/${vmId}`,
    { threadId: thread, runner: { peer: runnerReady.peerId, network: "loopback", address: runnerReady.addresses[0] }, frameToken, mac });
  await until("cloud-init", 420, () => /Cloud-init v\. .* finished at/.test(call({ method: "vm.inspect", threadId: thread, vmId }).consoleTail ?? "") ? true : undefined);
  await until("sshd through cube-gateway dial", 120, () => { try { return ssh("echo ready").trim() === "ready" ? true : undefined; } catch { return undefined; } });
  log("guest ready");

  const url = `https://github.com/${repository}`;
  const env = "source /etc/profile.d/cube-capture.sh; export GIT_CONFIG_GLOBAL=/etc/cube-capture.gitconfig GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 NO_COLOR=1";
  const id = `t-capture-${vmId.slice(0, 6)}`;
  await scenario("probe", `curl -sSv -o /dev/null https://deb.debian.org/debian/dists/trixie/InRelease 2>&1 | grep -iE "^< (HTTP|x-cube|server)" || true`);
  if (process.env.CAPTURE_PROBE_ONLY) throw new Error(scenarios[0].output);
  await scenario("setup-apt", "sudo DEBIAN_FRONTEND=noninteractive apt-get update -q && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q git gh npm curl >/dev/null", 1200);
  await scenario("git-clone", `${env}; git --version; git clone ${url} repo`);
  await scenario("git-clone-v0", `${env}; git -c protocol.version=0 clone ${url} repo-v0`);
  await scenario("git-push-branch", `${env}; cd repo; echo one-${id} > a.txt; git add a.txt; git commit -qm one; git push origin HEAD:refs/heads/cube/${id}/work`);
  await scenario("git-push-main", `${env}; cd repo; echo two-${id} > b.txt; git add b.txt; git commit -qm two; git push origin HEAD:main`);
  await scenario("git-push-multi", `${env}; cd repo; git push origin HEAD:refs/heads/cube/${id}/a HEAD:refs/heads/cube/${id}/b`);
  await scenario("git-push-force", `${env}; cd repo; git commit -q --amend -m two-amended; git push -f origin HEAD:refs/heads/cube/${id}/work`);
  await scenario("git-push-delete", `${env}; cd repo; git push origin :refs/heads/cube/${id}/b`);
  await scenario("git-push-tag", `${env}; cd repo; git tag capture-${id}; git push origin capture-${id}`);
  await scenario("git-push-atomic-options", `${env}; cd repo; echo three-${id} > c.txt; git add c.txt; git commit -qm three; git push --atomic -o ci.skip origin HEAD:refs/heads/cube/${id}/work HEAD:refs/heads/cube/${id}/c`);
  await scenario("git-fetch", `${env}; cd repo; git fetch origin`);
  await scenario("git-ls-remote", `${env}; git ls-remote ${url}`);
  const pr = await scenario("gh-pr-create", `${env}; cd repo; gh --version | head -1; gh pr create --repo ${repository} --head cube/${id}/work --base main --title "capture ${id}" --body "disposable capture"`);
  await scenario("gh-pr-list-view", `${env}; gh pr list --repo ${repository}; gh pr view --repo ${repository} cube/${id}/work`);
  await scenario("gh-api-rest-read", `${env}; gh api repos/${repository} >/dev/null; gh api repos/${repository}/pulls >/dev/null; gh api user >/dev/null`);
  await scenario("gh-api-rest-write-issue", `${env}; gh api -X POST repos/${repository}/issues -f title="capture ${id}" -f body=disposable >/dev/null`);
  await scenario("gh-api-rest-write-contents", `${env}; gh api -X PUT repos/${repository}/contents/rest-${id}.txt -f message="contents api" -f content=$(printf hi | base64) -f branch=cube/${id}/a >/dev/null`);
  await scenario("gh-api-graphql-query", `${env}; gh api graphql -f query='query { viewer { login } }' >/dev/null`);
  await scenario("gh-api-graphql-mutation", `${env}; id=$(gh api graphql -f query='query($o:String!,$n:String!){repository(owner:$o,name:$n){id}}' -f o=${repository.split("/")[0]} -f n=${repository.split("/")[1]} -q .data.repository.id); gh api graphql -f query='mutation($r:ID!){createIssue(input:{repositoryId:$r,title:"graphql capture"}){issue{number}}}' -f r=$id >/dev/null`);
  await scenario("gh-pr-merge", `${env}; gh pr merge --repo ${repository} cube/${id}/work --merge`);
  await scenario("gh-api-rest-write-ref", `${env}; sha=$(cd repo && git rev-parse HEAD); gh api -X POST repos/${repository}/git/refs -f ref=refs/heads/cube/${id}/rest -f sha=$sha >/dev/null; gh api -X PATCH repos/${repository}/git/refs/heads/main -f sha=$sha -F force=true >/dev/null || true`);
  await scenario("npm-install", `${env}; mkdir -p npmtest && cd npmtest && npm init -y >/dev/null && npm install --no-audit --no-fund is-number@7.0.0`);
  await scenario("npm-install-audit", `${env}; cd npmtest && npm install --no-fund left-pad@1.3.0`);
  await scenario("curl-download", `${env}; curl -fsSL -o /dev/null https://raw.githubusercontent.com/${repository}/main/README.md -H "Authorization: token $GH_TOKEN" || true`);
  log(`pr: ${pr.trim().split("\n").pop()}`);

  // The token never in the guest.
  const guestScan = (await execFileAsync("ssh", sshArgs(`sudo grep -rIl --exclude-dir=proc --exclude-dir=sys -F ${JSON.stringify(hostToken.slice(4, 24))} /home /etc /root /tmp /var/log 2>/dev/null || true`), { encoding: "utf8" })).stdout;
  assert.equal(guestScan.trim(), "", "the host's token is not in the guest");
  const recorded = fs.readFileSync(raw, "utf8");
  assert.ok(!recorded.includes(hostToken), "the recording holds placeholders only");
  fs.writeFileSync(outFile, recorded);
  fs.writeFileSync(outFile.replace(/\.jsonl$/, ".scenarios.json"), JSON.stringify({ placeholder, vmId, id, repository, scenarios }, null, 2));
  log(`recorded ${recorded.split("\n").filter(Boolean).length} requests -> ${outFile}`);
  call({ method: "vm.stop", threadId: thread, vmId, epoch: 1 });
} catch (error) {
  console.error("capture: FAIL", error);
  console.error(`logs: ${work} (kept)`);
  process.env.CUBE_SMOKE_KEEP = "1";
  process.exitCode = 1;
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.stdin?.end(); child.kill("SIGTERM"); }
  await sleep(1500);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  try { execFileSync("pkill", ["-f", `guest=${vmId}`]); } catch { /* none left */ }
  if (process.env.CUBE_SMOKE_KEEP !== "1") fs.rmSync(work, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
