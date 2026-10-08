// The product end to end with real thread VMs: a disposable cubed (faux
// model, fake `claude`) on 127.0.0.1 with CUBED_STATE under $TMPDIR (/tmp), a runner
// running as this user with state under $TMPDIR (/tmp), a cube-gateway built with
// `test-hooks` so github.com and api.github.com reach a local HTTPS fake (with
// `git http-backend` behind it), and a Debian genericcloud guest per thread.
//
//   node scripts/test-vm-e2e.ts <cube-runner> <image.qcow2>
//
// 1 Pi tools in the guest; 2 cubed SIGKILL mid-command; 3 gateway SIGKILL
// mid-command; 4 egress; 5 secrets (gh, git push; the token never in the
// guest, seed, runner state or logs); 6 Claude Code thread through the mod;
// 7 archive clean (deleted) and dirty (retained); 8 every process stopped.
// CUBE_SMOKE_KEEP=1 keeps the work directory.
import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, fork, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import https from "node:https";
import path from "node:path";
import readline from "node:readline";

const [runnerBin, image] = process.argv.slice(2).map(p => path.resolve(p));
if (!runnerBin || !image) throw new Error("usage: test-vm-e2e.ts <cube-runner> <image.qcow2>");
const repo = path.resolve(import.meta.dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "cube-e2e-"));
fs.chmodSync(work, 0o700);
const started = Date.now();
const log = (message: string) => console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s] ${message}`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const children = new Set<ChildProcess>();
const fakeToken = `ghs_e2e${randomBytes(12).toString("hex")}`;
const [tokenHead, tokenTail] = [fakeToken.slice(0, 10), fakeToken.slice(10)];
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=Cube E2E", "-c", "user.email=e2e@example.invalid", "-c", "commit.gpgsign=false", "-C", cwd, ...args], { encoding: "utf8" }).trim();
const production = () => { try { return execFileSync("systemctl", ["--user", "is-active", "cubed.service"], { encoding: "utf8" }).trim(); } catch (error) { return String((error as { stdout?: string }).stdout ?? "unknown").trim(); } };
const productionBefore = production();
const vmIds: string[] = [];

async function until<T>(what: string, seconds: number, probe: () => Promise<T | undefined | false> | T | undefined | false): Promise<T> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

// --- a local GitHub: api.github.com/user and smart HTTP for one repository
function fakeGithub(): Promise<{ port: number; ca: string; repository: string; close(): void; requests: string[] }> {
  const dir = path.join(work, "github");
  fs.mkdirSync(path.join(dir, "cube-e2e"), { recursive: true });
  const openssl = (...args: string[]) => execFileSync("openssl", args, { cwd: dir, stdio: "ignore" });
  openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2", "-subj", "/CN=cube e2e test ca");
  fs.writeFileSync(path.join(dir, "san.ext"), "subjectAltName=DNS:github.com,DNS:api.github.com\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n");
  openssl("req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", "leaf.key", "-out", "leaf.csr", "-subj", "/CN=github.com");
  openssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "leaf.pem", "-days", "2", "-extfile", "san.ext");
  const seedTree = path.join(dir, "seed");
  fs.mkdirSync(seedTree);
  git(seedTree, "init", "-q", "--initial-branch=main");
  fs.writeFileSync(path.join(seedTree, "README.md"), "e2e\n");
  git(seedTree, "add", "README.md");
  git(seedTree, "commit", "-qm", "base");
  const repository = path.join(dir, "cube-e2e", "repo.git");
  git(dir, "clone", "-q", "--bare", seedTree, repository);
  const requests: string[] = [];
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, "leaf.key")), cert: fs.readFileSync(path.join(dir, "leaf.pem")) }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const auth = request.headers.authorization ?? "";
      const host = request.headers.host?.split(":")[0];
      requests.push(`${request.method} ${host}${request.url} auth=${auth ? auth.split(" ")[0] : "none"}`);
      if (host === "api.github.com") {
        const token = /^(?:token|Bearer) (.+)$/.exec(auth)?.[1];
        if (token !== fakeToken) { response.writeHead(401, { "content-type": "application/json" }); response.end('{"message":"Bad credentials"}'); return; }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ login: "cube-e2e", id: 1 }));
        return;
      }
      const basic = /^Basic (.+)$/.exec(auth)?.[1];
      if (!basic || Buffer.from(basic, "base64").toString() !== `x-access-token:${fakeToken}`) {
        response.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' });
        response.end();
        return;
      }
      const url = new URL(request.url!, "https://github.com");
      const backend = spawn("git", ["http-backend"], { env: { PATH: process.env.PATH, GIT_PROJECT_ROOT: dir, GIT_HTTP_EXPORT_ALL: "1",
        REMOTE_USER: "x-access-token", REQUEST_METHOD: request.method, PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1),
        CONTENT_TYPE: request.headers["content-type"] ?? "", CONTENT_LENGTH: String(Buffer.concat(chunks).length),
        HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "", GIT_PROTOCOL: String(request.headers["git-protocol"] ?? "") } });
      const out: Buffer[] = [];
      backend.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      backend.stdin.end(Buffer.concat(chunks));
      backend.on("close", () => {
        const all = Buffer.concat(out);
        const split = all.indexOf("\r\n\r\n");
        const head = all.subarray(0, split).toString().split("\r\n");
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of head) {
          const [name, ...rest] = line.split(":");
          if (name.toLowerCase() === "status") status = Number(rest.join(":").trim().split(" ")[0]);
          else headers[name] = rest.join(":").trim();
        }
        response.writeHead(status, headers);
        response.end(all.subarray(split + 4));
      });
    });
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    const port = (server.address() as { port: number }).port;
    resolve({ port, ca: path.join(dir, "ca.pem"), repository, requests, close: () => server.close() });
  }));
}

// --- processes
async function firstLine(child: ChildProcess): Promise<Record<string, unknown>> {
  const lines = readline.createInterface({ input: child.stdout! });
  return JSON.parse(await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve);
    child.once("exit", code => reject(new Error(`process exited (${code}) before its ready line`)));
  }));
}
async function startRunner(listen: string) {
  const child = spawn(runnerBin, ["runner-serve", "--key", path.join(work, "runner.key"), "--state", path.join(work, "runner-state"), "--listen", listen],
    { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr!.pipe(fs.createWriteStream(path.join(work, "runner.log"), { flags: "a" }));
  children.add(child);
  return { child, ready: await firstLine(child) };
}
type Fixture = { child: ChildProcess; url: string; port: number; provider: string; model: string };
let fixtureEnv: NodeJS.ProcessEnv = {};
async function startCubed(port = 0): Promise<Fixture> {
  const child = fork(path.join(repo, "packages/server/test/e2e-fixture.ts"), [path.join(work, "state")], {
    stdio: ["ignore", "pipe", "pipe", "ipc"], env: { ...fixtureEnv, CUBE_FIXTURE_PORT: String(port) } });
  const output = fs.createWriteStream(path.join(work, "cubed.log"), { flags: "a" });
  child.stdout!.pipe(output); child.stderr!.pipe(output);
  children.add(child);
  const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
    child.once("message", message => resolve(message as Record<string, unknown>));
    child.once("exit", code => reject(new Error(`cubed exited (${code}) before ready; see ${work}/cubed.log`)));
  });
  return { child, url: String(ready.url), port: Number(ready.port), provider: String(ready.provider), model: String(ready.model) };
}
async function kill(child: ChildProcess, signal: NodeJS.Signals = "SIGKILL") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once("exit", resolve));
  child.kill(signal);
  await exited;
  children.delete(child);
}
const gatewayPids = () => { try { return execFileSync("pgrep", ["-f", `serve --state ${path.join(work, "state", "gateway")}`], { encoding: "utf8" }).trim().split("\n").filter(Boolean); } catch { return []; } };

// --- the product API
let cubed: Fixture;
const api = async (route: string, method = "GET", body?: unknown) => {
  const response = await fetch(`${cubed.url}${route}`, { method, ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });
  const text = await response.text();
  if (response.status >= 400) throw new Error(`${method} ${route}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
};
type Row = { id: string; state: string; error: string | null; workspaceState: string; vm?: { vmId: string } };
const threadRow = async (id: string) => (await api("/api/threads")).threads.find((row: Row) => row.id === id) as Row;
async function ready(id: string, seconds = 600): Promise<Row> {
  const row = await until(`thread ${id.slice(0, 8)} ready`, seconds, async () => { const row = await threadRow(id); return row && row.state !== "starting" ? row : undefined; });
  assert.equal(row.state, "ready", row.error ?? "");
  return row;
}
const history = (id: string) => api(`/api/threads/${id}/history`);
async function settled(id: string, run: string, seconds = 300) {
  return until(`run ${run} of ${id.slice(0, 8)}`, seconds, async () => {
    const value = await history(id);
    return value.status?.run === run && !["working", "idle"].includes(value.status.state) ? value : undefined;
  });
}
let requests = 0;
async function prompt(id: string, text: string, seconds = 300): Promise<{ state: string; text: string; transcript: Record<string, unknown> }> {
  const run = `e2e-${++requests}`;
  await api(`/api/threads/${id}/prompt`, "POST", { text, requestId: run });
  const value = await settled(id, run, seconds);
  const last = [...value.events].reverse().find((event: { type: string }) => event.type === "assistant-text") as { text?: string } | undefined;
  return { state: value.status.state, text: last?.text ?? "", transcript: value };
}
const tool = (name: string, args: Record<string, unknown>) => `tool ${JSON.stringify({ name, args })}`;
async function bash(id: string, command: string, seconds = 300): Promise<string> {
  const result = await prompt(id, tool("bash", { command, timeoutMs: Math.min(seconds * 1000, 600000) }), seconds + 30);
  assert.equal(result.state, "completed", JSON.stringify(result.transcript.status));
  assert.match(result.text, /^result: /, result.text);
  return result.text.replace(/^result: /, "").replace(/\n\[exit=\d+; exited\]$/, "").trimEnd();
}

let runner: ChildProcess | undefined;
let github: Awaited<ReturnType<typeof fakeGithub>> | undefined;
try {
  // A gateway built with test-hooks: github.com/api.github.com map to the local fake.
  execFileSync("cargo", ["build", "--locked", "--offline", "-p", "cube-gateway", "--features", "test-hooks", "-j", "4"],
    { cwd: repo, env: { ...process.env, CARGO_TARGET_DIR: path.join(repo, "target/test-hooks") }, stdio: "ignore" });
  const gatewayBin = path.join(repo, "target/test-hooks/debug/cube-gateway");
  github = await fakeGithub();
  log(`fake GitHub on 127.0.0.1:${github.port}`);

  const peerOf = (file: string) => JSON.parse(execFileSync(runnerBin, ["keygen", "--key", file], { encoding: "utf8" })).peerId as string;
  const controlPeer = peerOf(path.join(work, "control.key"));
  peerOf(path.join(work, "runner.key"));
  execFileSync(runnerBin, ["runner-init", "--key", path.join(work, "runner.key"), "--state", path.join(work, "runner-state"), "--image", image,
    "--allow-peer", controlPeer, "--node-id", "node-e2e", "--thread-id", "install-e2e", "--env", "1",
    "--max-vcpus", "2", "--max-memory-mib", "2048", "--max-disk-gib", "16"], { stdio: "ignore" });
  const first = await startRunner("127.0.0.1:0");
  runner = first.child;
  const runnerAddress = (first.ready.addresses as string[])[0];
  const config = path.join(work, "runner.json");
  fs.writeFileSync(config, JSON.stringify({ version: 2, binding: { nodeId: "node-e2e", threadId: "install-e2e", environmentId: 1 },
    controlKey: path.join(work, "control.key"), serverPeer: first.ready.peerId, address: runnerAddress, network: "loopback" }), { mode: 0o600 });
  fs.mkdirSync(path.join(work, "state"), { mode: 0o700 });
  const enrolled = JSON.parse(execFileSync(process.execPath, [path.join(repo, "scripts/enroll-runner.ts"), "--state", path.join(work, "state"), "--config", config, "--trusted-runner"], { encoding: "utf8" }));
  assert.equal(enrolled.admitted, true);
  log(`runner enrolled (${enrolled.platform}, protocol 3)`);
  fs.mkdirSync(path.join(work, "home"), { mode: 0o700 });
  fixtureEnv = { PATH: process.env.PATH, HOME: path.join(work, "home"), PI_CODING_AGENT_DIR: path.join(work, "home", "pi"),
    CUBED_GATEWAY: gatewayBin, CUBED_GITHUB_TOKEN: fakeToken, CUBED_VM_VCPUS: "2", CUBED_VM_MEMORY_MIB: "2048", CUBED_VM_DISK_GIB: "8",
    CUBED_GATEWAY_TEST_ARGS: JSON.stringify(["--test-upstream", `github.com=127.0.0.1:${github.port}`, "--test-upstream", `api.github.com=127.0.0.1:${github.port}`,
      "--test-upstream-ca", github.ca]) };
  cubed = await startCubed();
  const project = (await api("/api/projects", "POST", { name: "e2e", repositories: [] })).project;
  const model = { provider: cubed.provider, id: cubed.model };

  // 1. A Pi thread: write, read, edit, bash and codemode in the guest.
  const pi = (await api("/api/threads", "POST", { projectId: project.id, requestId: "pi", text: "hello", model })).id as string;
  const booted = Date.now();
  const piRow = await ready(pi);
  vmIds.push(piRow.vm!.vmId);
  // The creation text is the first turn; a prompt during it is refused with 409.
  assert.equal((await settled(pi, "cube:initial")).status.state, "completed");
  log(`1: pi thread machine ready in ${((Date.now() - booted) / 1000).toFixed(0)} s`);
  assert.equal((await prompt(pi, tool("write", { path: "notes/a.txt", content: "one\n" }))).state, "completed");
  assert.match((await prompt(pi, tool("read", { path: "notes/a.txt" }))).text, /one/);
  assert.equal((await prompt(pi, tool("edit", { path: "notes/a.txt", edits: [{ oldText: "one", newText: "two" }] }))).state, "completed");
  assert.equal(await bash(pi, "cat notes/a.txt; id -un; pwd; hostname | cut -c1-5"), "two\nagent\n/workspace\ncube-");
  // Node and Python bring their own CA lists; the installation CA reaches them, also under sudo.
  assert.equal(await bash(pi, "echo $NODE_EXTRA_CA_CERTS; sudo printenv NODE_EXTRA_CA_CERTS"), "/etc/ssl/certs/ca-certificates.crt\n/etc/ssl/certs/ca-certificates.crt");
  const coded = await prompt(pi, tool("codemode", { code: "const out = await tools.bash({ command: \"echo from-codemode > cm.txt; cat cm.txt\" }); return out;" }));
  assert.match(coded.text, /from-codemode/);
  // Outside the workspace: the file tools reach the machine's own files, as the agent.
  const portal = "/home/agent/portal-runtime/start-portal.sh";
  assert.equal((await prompt(pi, tool("write", { path: portal, content: "#!/bin/sh\nexec node portal.js\n" }))).state, "completed");
  assert.equal((await prompt(pi, tool("edit", { path: "~/portal-runtime/start-portal.sh", edits: [{ oldText: "node", newText: "bun" }] }))).state, "completed");
  assert.equal(await bash(pi, `cat ${portal}; stat -c %U ${portal}; mkdir -p /tmp/shots && printf shot > /tmp/shots/a.txt`), "#!/bin/sh\nexec bun portal.js\nagent");
  assert.match((await prompt(pi, tool("read", { path: "/tmp/shots/a.txt" }))).text, /^result: shot/);
  assert.match((await prompt(pi, tool("read", { path: "/proc/self/environ" }))).text, /kernel or device filesystem/);
  const leaked = execFileSync("find", [work, "(", "-name", "a.txt", "-o", "-name", "cm.txt", "-o", "-name", "start-portal.sh", ")", "-not", "-path", `${work}/github/*`], { encoding: "utf8" }).trim();
  assert.equal(leaked, "", "nothing the agent wrote appears outside the VM disk");
  log("1: write, read, edit, bash and codemode ran in the guest, also on /home/agent and /tmp; nothing on the runner outside the VM disk");

  // 1b. A guest that lost its packages (e.g. a first boot whose apt step
  // failed) reinstalls them on the next boot instead of staying broken.
  const bootedAt = await bash(pi, "uptime -s");
  assert.equal(await bash(pi, "sudo apt-get remove -y -q git >/dev/null 2>&1; command -v git || echo gone"), "gone");
  // Outside this command's unit: the helper stops a command's whole cgroup when it ends.
  await bash(pi, "sudo systemd-run --quiet --on-active=3 systemctl reboot; echo scheduled");
  await sleep(15000);
  const repaired = await until("git back after the reboot", 300, async () => {
    try { const out = await bash(pi, "command -v git; uptime -s", 60); return out.startsWith("/usr/bin/git") ? out : undefined; } catch { return undefined; }
  });
  assert.notEqual(repaired.split("\n")[1], bootedAt, "the guest really rebooted");
  log(`1b: git removed and the guest rebooted; the per-boot script reinstalled it (${repaired.split("\n")[0]})`);

  // 2. cubed SIGKILL while a command runs: the next cubed reattaches; it ran once.
  const longRun = `e2e-${++requests}`;
  await api(`/api/threads/${pi}/prompt`, "POST", { text: tool("bash", { command: "sleep 20; echo done >> f.txt", timeoutMs: 120000 }), requestId: longRun });
  await until("the long command to start", 60, async () => JSON.stringify((await history(pi)).events).includes("sleep 20"));
  await sleep(3000);
  await kill(cubed.child);
  await until("the old gateway to exit with its lifeline", 30, () => gatewayPids().length === 0);
  cubed = await startCubed(cubed.port);
  const resumed = await settled(pi, longRun, 300);
  assert.equal(resumed.status.state, "completed", JSON.stringify(resumed.status));
  assert.equal(await bash(pi, "wc -l < f.txt"), "1");
  log("2: cubed SIGKILL mid-command: the gateway followed its lifeline, the next cubed reattached, the command ran once");

  // 3. Gateway SIGKILL while a command runs: restarted, SSH back, result retrieved.
  const gatewayRun = `e2e-${++requests}`;
  await api(`/api/threads/${pi}/prompt`, "POST", { text: tool("bash", { command: "sleep 12; echo g >> g.txt; echo finished", timeoutMs: 120000 }), requestId: gatewayRun });
  await until("the command to start", 60, async () => JSON.stringify((await history(pi)).events).includes("sleep 12"));
  await sleep(2000);
  const [oldGateway] = gatewayPids();
  assert.ok(oldGateway, "the supervised gateway runs");
  process.kill(Number(oldGateway), "SIGKILL");
  await until("a new gateway", 60, () => { const pids = gatewayPids(); return pids.length === 1 && pids[0] !== oldGateway; });
  const afterGateway = await settled(pi, gatewayRun, 300);
  assert.equal(afterGateway.status.state, "completed", JSON.stringify(afterGateway.status));
  assert.match(JSON.stringify(afterGateway.events), /finished/);
  assert.equal(await bash(pi, "wc -l < g.txt"), "1");
  assert.equal((await api("/api/health")).gateway, "ready");
  log("3: gateway SIGKILL mid-command: restarted, VM attached again, SSH back, the result retrieved");

  // 4. Egress: public HTTPS only; cubed, the gateway, the LAN and other ports are refused.
  const probes = (await bash(pi, [
    "curl -s -o /dev/null -m 15 -w 'public=%{http_code}\\n' https://example.com/",
    `curl -s -o /dev/null -m 5 -w 'guest-loopback=%{http_code}\\n' http://127.0.0.1:${cubed.port}/api/health`,
    `curl -s -o /dev/null -m 5 -w 'gateway-port=%{http_code}\\n' http://10.77.0.1:${cubed.port}/api/health`,
    "curl -s -o /dev/null -m 5 -w 'gateway-80=%{http_code}\\n' http://10.77.0.1/",
    "curl -s -o /dev/null -m 5 -w 'rfc1918=%{http_code}\\n' http://192.168.1.1/",
    "curl -s -o /dev/null -m 5 -w 'metadata=%{http_code}\\n' http://169.254.169.254/latest/meta-data/",
    "timeout 8 bash -c 'exec 3<>/dev/tcp/140.82.112.3/22' 2>/dev/null && echo ssh-out=open || echo ssh-out=refused",
    "true"].join("; "))).split("\n");
  const probe = Object.fromEntries(probes.map(line => line.split("=")));
  if (probe.public === "200") log("4: https://example.com through interception: 200");
  else log(`4: NOTICE https://example.com answered ${probe.public}; public egress not verified (no upstream internet?)`);
  assert.equal(probe["guest-loopback"], "000", "cubed is not on the guest's loopback");
  assert.equal(probe["gateway-port"], "000", "only 80/443 are terminated");
  assert.equal(probe["gateway-80"], "403");
  assert.equal(probe.rfc1918, "403");
  assert.equal(probe.metadata, "403");
  assert.equal(probe["ssh-out"], "refused");
  log("4: cubed's port, the gateway, RFC 1918, metadata and outbound ssh refused");

  // 5. Secrets: gh and git push work with the host's token; the guest never holds it.
  assert.equal(await bash(pi, "gh api user --jq .login"), "cube-e2e");
  const pushed = await bash(pi, "set -e; rm -rf /tmp/r; git clone -q https://github.com/cube-e2e/repo.git /tmp/r; cd /tmp/r; echo e2e > e2e.txt; git add e2e.txt; "
    + "git -c user.name=e2e -c user.email=e2e@example.invalid commit -qm e2e; git push -q origin HEAD:main; git rev-parse HEAD");
  assert.equal(git(github.repository, "rev-parse", "main"), pushed, "the push reached the fake GitHub");
  const refused = await bash(pi, "GH_TOKEN=bogus gh api user 2>&1 | grep -o 'HTTP [0-9]*' | head -1; "
    + "GH_TOKEN=cube_ph_github_AAAAAAAAAAAAAAAAAAAAAA gh api user 2>&1 | grep -o 'HTTP [0-9]*' | head -1; "
    + "curl -s -o /dev/null -m 15 -w '%{http_code}\\n' -H \"Authorization: Bearer $GH_TOKEN\" https://example.com/");
  assert.deepEqual(refused.split("\n"), ["HTTP 401", "HTTP 403", "403"], "a bogus token reaches GitHub unchanged; a foreign placeholder or another host is denied");
  // The scan joins the token's halves inside the root shell, so the scan's own
  // command line (sudo logs it and puts it in SUDO_COMMAND) never holds it.
  const scan = await bash(pi, `sudo bash -c 'a=${tokenHead}; b=${tokenTail}; grep -rlsF --exclude-dir=proc --exclude-dir=sys --exclude-dir=dev -e "$a$b" / | head -5; `
    + `for f in /proc/[0-9]*/environ; do grep -lsF -e "$a$b" "$f"; done | head -5'; echo scan-done`, 600);
  assert.equal(scan, "scan-done", `the token is in the guest: ${scan}`);
  const hostScan = spawnSync("grep", ["-rlsF", "-e", fakeToken, path.join(work, "runner-state"), path.join(work, "state", "gateway"),
    path.join(work, "cubed.log"), path.join(work, "runner.log")], { encoding: "utf8" });
  assert.equal(hostScan.status, 1, `the token is in the seed, the runner state, the gateway state or a log: ${hostScan.stdout}`);
  log(`5: gh api user and git push through placeholder substitution; foreign placeholder and other host denied; token absent from guest, seed, runner and logs (${github.requests.length} GitHub requests)`);

  // 7a. Archive with changes: the disk is retained, with the reason.
  const dirty = await api(`/api/threads/${pi}`, "DELETE");
  assert.equal(dirty.retained, true);
  assert.match(dirty.reason, /not empty/);
  log(`7: the pi thread archived with changes: retained (${dirty.reason})`);

  // 6. A Claude Code thread through the mod: Bash/Read/Write/Edit in the guest; stop cancels.
  const claude = (await api("/api/threads", "POST", { projectId: project.id, requestId: "claude",
    text: "write c.txt hello\nread c.txt\nedit c.txt hello bye\nrun cat c.txt; id -un; pwd", model: { provider: "claude-code", id: "sonnet" } })).id as string;
  vmIds.push((await ready(claude)).vm!.vmId);
  const claudeFirst = await until("claude's first turn", 300, async () => {
    const value = await history(claude); return ["completed", "failed", "stopped"].includes(value.status?.state) ? value : undefined;
  });
  assert.equal(claudeFirst.status.state, "completed", JSON.stringify(claudeFirst.status));
  const results = (transcript: { events: Array<{ type: string; output?: string }> }) => transcript.events.filter(event => event.type === "tool-result").map(event => event.output ?? "");
  const outputs = claudeFirst.events.filter((event: { type: string }) => event.type === "tool-result").map((event: { output?: string }) => event.output ?? "");
  assert.ok(outputs.some((output: string) => output.includes("bye") && output.includes("agent") && output.includes("/workspace")), JSON.stringify(outputs));
  const machineRun = `e2e-${++requests}`;
  await api(`/api/threads/${claude}/prompt`, "POST", { text: "write-at /home/agent/portal-runtime/start-portal.sh from-claude\nrun cat /home/agent/portal-runtime/start-portal.sh; echo; stat -c %U /home/agent/portal-runtime/start-portal.sh", requestId: machineRun });
  assert.equal(results(await settled(claude, machineRun, 120)).at(-1)?.trim(), "from-claude\nagent", "the mod's Write reached the machine's /home/agent");
  const slowRun = `e2e-${++requests}`;
  await api(`/api/threads/${claude}/prompt`, "POST", { text: "slow sleep 30; touch late.txt", requestId: slowRun });
  await until("claude's slow command", 60, async () => JSON.stringify((await history(claude)).events).includes("late.txt"));
  await sleep(2000);
  await api(`/api/threads/${claude}/stop`, "POST", {});
  assert.equal((await settled(claude, slowRun, 60)).status.state, "stopped");
  const checkRun = `e2e-${++requests}`;
  await api(`/api/threads/${claude}/prompt`, "POST", { text: "run systemctl list-units --plain --no-legend 'cube-op-*' --state=active,activating | wc -l; ls late.txt 2>&1 | grep -c 'No such'", requestId: checkRun });
  const checked = await settled(claude, checkRun, 120);
  assert.equal(results(checked).at(-1)?.trim(), "1\n1", "only the check itself runs; late.txt was never written");
  log("6: claude code thread: Write, Read, Edit and Bash in the guest, Write also to /home/agent; stop cancelled the guest command");
  const claudeArchive = await api(`/api/threads/${claude}`, "DELETE");
  assert.equal(claudeArchive.retained, true);

  // 7b. Archive clean: the disk is deleted.
  const clean = (await api("/api/threads", "POST", { projectId: project.id, requestId: "clean", text: "hello", model })).id as string;
  vmIds.push((await ready(clean)).vm!.vmId);
  await until("the clean thread's first answer", 120, async () => (await history(clean)).status?.state === "completed");
  const vmDirs = () => fs.readdirSync(path.join(work, "runner-state", "vms")).filter(name => fs.existsSync(path.join(work, "runner-state", "vms", name, "disk.qcow2")));
  assert.equal(vmDirs().length, 3);
  const cleanArchive = await api(`/api/threads/${clean}`, "DELETE");
  assert.deepEqual(cleanArchive, { ok: true, retained: false, reason: "clean" });
  assert.equal(vmDirs().length, 2, "the clean machine's disk is deleted; the two changed ones are retained");
  const [runnerStatus] = (await api("/api/runners")).runners;
  const checkedRunner = (await api(`/api/runners/${runnerStatus.id}/check`, "POST", {})).runner;
  assert.equal(checkedRunner.health.retainedVms, 2);
  assert.equal(checkedRunner.health.activeVms, 0);
  log("7: a clean archive deleted the disk; two retained disks reported by the runner");
  // The operator discards a retained disk.
  await api(`/api/threads/${pi}/discard`, "POST", {});
  assert.equal(vmDirs().length, 1, "the discarded disk is gone");
  assert.equal((await api(`/api/runners/${runnerStatus.id}/check`, "POST", {})).runner.health.retainedVms, 1);
  log("7: the operator discarded one retained disk on the runner");

  // 8. Stop everything this run started.
  await kill(cubed.child, "SIGTERM");
  await until("the gateway to exit with cubed", 30, () => gatewayPids().length === 0);
  await kill(runner, "SIGTERM");
  for (const vmId of vmIds) assert.equal(spawnSync("pgrep", ["-f", `guest=${vmId}`]).status, 1, `qemu for ${vmId} is gone`);
  assert.equal(spawnSync("pgrep", ["-f", work]).status, 1, "no process of this run is left");
  assert.equal(production(), productionBefore, "the production cubed unit is untouched");
  log(`8: every process stopped; production cubed.service still ${productionBefore}`);
  console.log(`test-vm-e2e: PASS in ${((Date.now() - started) / 1000).toFixed(0)} s`);
} catch (error) {
  console.error("test-vm-e2e: FAIL", error);
  console.error(`logs: ${work} (kept)`);
  process.env.CUBE_SMOKE_KEEP = "1";
  process.exitCode = 1;
} finally {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await sleep(3000);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  for (const pid of gatewayPids()) { try { process.kill(Number(pid), "SIGKILL"); } catch { /* gone */ } }
  for (const vmId of vmIds) spawnSync("pkill", ["-f", `guest=${vmId}`]);
  github?.close();
  if (process.env.CUBE_SMOKE_KEEP === "1") console.log(`kept ${work}`);
  else fs.rmSync(work, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
