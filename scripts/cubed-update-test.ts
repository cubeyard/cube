import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { pathToFileURL } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "cubed-update-"));
const install = path.join(root, "install");
const feedRoot = path.join(root, "feed");
const state = path.join(root, "state");
fs.mkdirSync(path.join(install, "releases"), { recursive: true });
fs.mkdirSync(feedRoot); fs.mkdirSync(state);
fs.writeFileSync(path.join(state, "preserved-secret"), "keep", { mode: 0o600 });
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
fs.writeFileSync(path.join(install, "update-public-key.pem"), publicKey.export({ format: "pem", type: "spki" }));
const platform = process.platform === "linux" ? `linux-${process.arch}-gnu` : `${process.platform}-${process.arch}`;
const commits = { v1: "1".repeat(40), v2: "2".repeat(40), v3: "3".repeat(40), v4: "4".repeat(40) };
const serverModule = pathToFileURL(path.resolve("packages/server/src/index.ts")).href;
const fixture = `import fs from "node:fs";import {createCubed} from ${JSON.stringify(serverModule)};
const version=process.env.CUBED_VERSION, commit=process.env.CUBED_COMMIT;
if(process.argv.includes("--self-check")){process.stdout.write(JSON.stringify({version,commit,stateSchema:100})+"\\n");}
else if(version==="v1.2.0"){process.exit(23);}
else {const app=await createCubed({state:process.env.CUBED_STATE});await new Promise((resolve,reject)=>{app.server.once("error",reject);app.server.listen(Number(process.env.CUBED_PORT),"127.0.0.1",resolve)});let closing=false;const close=()=>{if(closing)return;closing=true;void app.close().then(()=>process.exit(0))};for(const signal of ["SIGTERM","SIGINT"])process.once(signal,close);if(process.env.CUBED_SUPERVISOR_LIFELINE_FD==="3"){const life=fs.createReadStream("/dev/null",{fd:3,autoClose:false});life.resume();life.once("end",close);life.once("error",close);}}`;

function makeRelease(version: string, commit: string, directory: string): string {
  const release = path.join(directory, "cubed");
  fs.mkdirSync(path.join(release, "bin"), { recursive: true });
  fs.mkdirSync(path.join(release, "app/packages/server/src"), { recursive: true });
  fs.writeFileSync(path.join(release, "bin/node"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(release, "app/packages/server/src/index.ts"), fixture);
  fs.writeFileSync(path.join(release, "release.json"), JSON.stringify({ version, commit, stateSchema: 100, entry: "app/packages/server/src/index.ts" }));
  return release;
}

const first = makeRelease("v1.0.0", commits.v1, path.join(root, "first"));
fs.renameSync(first, path.join(install, "releases/v1.0.0"));
fs.symlinkSync(path.join(install, "releases/v1.0.0"), path.join(install, "current"));

let manifest = Buffer.alloc(0); let signature = Buffer.alloc(0); let artifact = Buffer.alloc(0);
const feedServer = http.createServer((request, response) => {
  const body = request.url === "/manifest.json" ? manifest : request.url === "/manifest.json.sig" ? signature : artifact;
  response.writeHead(200, { "content-length": body.length }); response.end(body);
});
await new Promise<void>(resolve => feedServer.listen(0, "127.0.0.1", resolve));
const feedPort = (feedServer.address() as net.AddressInfo).port;
const appPort = await freePort();

function publish(version: string, commit: string, validSignature = true): void {
  const staging = fs.mkdtempSync(path.join(root, "candidate-")); makeRelease(version, commit, staging);
  const archive = path.join(feedRoot, `${version}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", staging, "cubed"]); artifact = fs.readFileSync(archive);
  manifest = Buffer.from(`${JSON.stringify({ schema: 1, product: "cubed", version, commit, platform, minimumSupervisor: 1,
    stateSchema: { minimum: 100, maximum: 100, rollbackSafeFrom: 100 },
    artifact: { url: `http://127.0.0.1:${feedPort}/artifact.tar.gz`, sha256: createHash("sha256").update(artifact).digest("hex"), bytes: artifact.length },
    publishedAt: "2026-09-18T10:15:00.000Z", notesUrl: `https://example.test/releases/${version}`,
    includesRunner: false })}\n`);
  signature = Buffer.from(`${sign(null, manifest, privateKey).toString("base64")}\n`);
  if (!validSignature) signature[0] = signature[0] === 65 ? 66 : 65;
  fs.rmSync(staging, { recursive: true, force: true });
}

publish("v1.1.0", commits.v2);
const token = "fixture-control-token";
const supervisorEnvironment = { ...process.env, CUBED_INSTALL_ROOT: install, CUBED_STATE: state, CUBED_PORT: String(appPort), CUBED_HOST: "127.0.0.1",
  PI_CODING_AGENT_DIR: path.join(root, "pi-agent"),
  CUBED_UPDATE_FEED_URL: `http://127.0.0.1:${feedPort}/manifest.json`, CUBED_UPDATE_ALLOW_HTTP: "1", CUBED_GUI_UPDATES: "1",
  CUBED_UPDATE_TEST_TOKEN: token, CUBED_UPDATE_PROBATION_MS: "2000", CUBED_UPDATE_HEALTH_TIMEOUT_MS: "3000", CUBED_UPDATE_STOP_TIMEOUT_MS: "1000" };
let errors = "";
function startSupervisor() {
  const childProcess = spawn(process.execPath, [path.resolve("scripts/cubed-supervisor.ts")], {
    env: supervisorEnvironment, stdio: ["ignore", "pipe", "pipe"],
  });
  childProcess.stderr.on("data", chunk => { errors += String(chunk); });
  return childProcess;
}
let supervisor = startSupervisor();
const socket = path.join(install, "supervisor.sock");

async function duplicateSupervisorExit() {
  const duplicate = spawn(process.execPath, [path.resolve("scripts/cubed-supervisor.ts")], {
    env: supervisorEnvironment, stdio: "ignore",
  });
  const [code] = await once(duplicate, "exit"); return code;
}

async function call(body: Record<string, unknown>) {
  return new Promise<any>((resolve, reject) => {
    const client = net.createConnection(socket); let raw = "";
    client.setEncoding("utf8"); client.on("connect", () => client.end(`${JSON.stringify({ id: "test", token, ...body })}\n`));
    client.on("data", chunk => { raw += chunk; }); client.on("error", reject);
    client.on("end", () => resolve(JSON.parse(raw)));
  });
}
async function guiUpdate(body?: Record<string, unknown>, expectedStatus = 200) {
  const response = await fetch(`http://127.0.0.1:${appPort}/api/system/update`, body ? {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  } : undefined);
  assert.equal(response.status, expectedStatus);
  return response.json() as Promise<any>;
}
async function statusUntil(phase: string, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const status = await guiUpdate(); if (status.phase === phase) return status; } catch { /* restart gap */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${phase}: ${errors}`);
}

try {
  await waitHealth(appPort, "v1.0.0");
  const onboarding = await fetch(`http://127.0.0.1:${appPort}/api/onboarding`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  });
  assert.equal(onboarding.status, 200);
  assert.notEqual(await duplicateSupervisorExit(), 0);
  assert.equal((await call({ action: "status", token: "wrong-token" })).ok, false);
  await guiUpdate({ action: "check" });
  const discovered = await statusUntil("available");
  assert.equal(discovered.available.version, "v1.1.0");
  assert.equal(discovered.available.publishedAt, "2026-09-18T10:15:00.000Z");
  assert.equal(discovered.available.notesUrl, "https://example.test/releases/v1.1.0");
  await guiUpdate({ action: "install", targetVersion: "v1.1.0", expectedCurrentVersion: "v1.0.0", requestId: "install-v2" }, 202);
  const updated = await statusUntil("updated");
  assert.equal(updated.current.version, "v1.1.0"); assert.equal(updated.runnersUpdated, false);
  assert.equal(path.basename(fs.realpathSync(path.join(install, "current"))), "v1.1.0");
  assert.equal(fs.readFileSync(path.join(state, "preserved-secret"), "utf8"), "keep");
  assert.equal((await (await fetch(`http://127.0.0.1:${appPort}/api/state`)).json() as { onboardingComplete: boolean }).onboardingComplete, true);

  publish("v1.2.0", commits.v3);
  await guiUpdate({ action: "check" }); await statusUntil("available");
  await guiUpdate({ action: "install", targetVersion: "v1.2.0", expectedCurrentVersion: "v1.1.0", requestId: "install-v3" }, 202);
  const rolledBack = await statusUntil("rolled-back");
  assert.equal(rolledBack.current.version, "v1.1.0"); assert.match(rolledBack.error, /exited before readiness/);
  await waitHealth(appPort, "v1.1.0");

  publish("v1.3.0", commits.v4, false);
  await guiUpdate({ action: "check" });
  const rejected = await statusUntil("failed");
  assert.match(rejected.error, /signature verification failed/);
  assert.equal(path.basename(fs.realpathSync(path.join(install, "current"))), "v1.1.0");

  publish("v1.3.0", commits.v4);
  await guiUpdate({ action: "check" }); await statusUntil("available");
  artifact[artifact.length - 1] ^= 0xff;
  await guiUpdate({ action: "install", targetVersion: "v1.3.0", expectedCurrentVersion: "v1.1.0", requestId: "bad-checksum-v4" }, 202);
  const checksumRejected = await statusUntil("failed");
  assert.match(checksumRejected.error, /signed size and checksum/);
  assert.equal(path.basename(fs.realpathSync(path.join(install, "current"))), "v1.1.0");

  publish("v1.3.0", commits.v4);
  await guiUpdate({ action: "check" }); await statusUntil("available");
  await guiUpdate({ action: "install", targetVersion: "v1.3.0", expectedCurrentVersion: "v1.1.0", requestId: "crash-v4" }, 202);
  await statusUntil("probation");
  const crashed = once(supervisor, "exit"); supervisor.kill("SIGKILL"); await crashed;
  await waitNoHealth(appPort);
  supervisor = startSupervisor();
  const recovered = await statusUntil("rolled-back");
  assert.equal(recovered.current.version, "v1.1.0");
  await waitHealth(appPort, "v1.1.0");
  assert.equal((await (await fetch(`http://127.0.0.1:${appPort}/api/state`)).json() as { onboardingComplete: boolean }).onboardingComplete, true);
  console.log("cubed-update-test: GUI/API discovery, signed activation, restart probation, state preservation, authorization, single-owner lock, unhealthy and interrupted rollback, and signature/checksum rejection passed");
} finally {
  if (supervisor.exitCode === null && supervisor.signalCode === null) {
    const closed = once(supervisor, "exit"); supervisor.kill("SIGTERM"); await closed;
  }
  await new Promise<void>(resolve => feedServer.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true });
}

async function freePort(): Promise<number> {
  const server = net.createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port; await new Promise<void>(resolve => server.close(() => resolve())); return port;
}
async function waitHealth(port: number, version: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try { const value = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json() as { version?: string }; if (value.version === version) return; } catch { /* starting */ }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`health ${version} timed out`);
}
async function waitNoHealth(port: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { await fetch(`http://127.0.0.1:${port}/api/health`); }
    catch { return; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("child did not exit when its supervisor lifeline closed");
}
