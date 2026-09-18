#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import os from "node:os";
import { createHash, randomBytes, verify } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import type { UpdateStatus } from "../packages/server/src/update-service.ts";

const exec = promisify(execFile);
const SUPERVISOR_VERSION = 1;
const MAX_MANIFEST = 256 * 1024;
const MAX_ARTIFACT = 1024 * 1024 * 1024;
const BUSY = new Set(["checking", "downloading", "verifying", "staging", "draining", "restarting", "probation"]);

interface UpdateManifest {
  schema: 1;
  product: "cubed";
  version: string;
  commit: string;
  platform: string;
  minimumSupervisor: number;
  stateSchema: { minimum: number; maximum: number; rollbackSafeFrom: number };
  artifact: { url: string; sha256: string; bytes: number };
  publishedAt?: string;
  notesUrl?: string;
  includesRunner: false;
}

interface ReleaseRecord { version: string; commit: string; stateSchema: number; entry: string }
interface DurableStatus extends UpdateStatus { lastRequestId?: string | null }

const root = path.resolve(process.env.CUBED_INSTALL_ROOT || path.join(os.homedir(), ".local/share/cubed"));
const releases = path.join(root, "releases");
const currentLink = path.join(root, "current");
const previousLink = path.join(root, "previous");
const socketPath = process.env.CUBED_SUPERVISOR_SOCKET || path.join(root, "supervisor.sock");
const statusPath = path.join(root, "update.json");
const lockPath = path.join(root, "supervisor.lock");
const publicKeyPath = process.env.CUBED_UPDATE_PUBLIC_KEY || path.join(root, "update-public-key.pem");
const feed = process.env.CUBED_UPDATE_FEED_URL;
const enabledByOperator = process.env.CUBED_GUI_UPDATES === "1";
const token = process.env.CUBED_UPDATE_TEST_TOKEN || randomBytes(32).toString("hex");
const timeoutMs = numberEnv("CUBED_UPDATE_HEALTH_TIMEOUT_MS", 30_000);
const probationMs = numberEnv("CUBED_UPDATE_PROBATION_MS", 5_000);
const stopTimeoutMs = numberEnv("CUBED_UPDATE_STOP_TIMEOUT_MS", 30_000);

fs.mkdirSync(releases, { recursive: true, mode: 0o700 });
acquireLock();
const initial = releaseRecord(resolveLink(currentLink));
let state: DurableStatus = baseStatus(initial);
state = recoverStatus(initial);
let child: ChildProcess | null = null;
let orchestrating = false;
let stopping = false;

function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function acquireLock(): void {
  for (;;) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      fs.writeFileSync(path.join(lockPath, "pid"), `${process.pid}\n`, { mode: 0o600 });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let owner = 0;
      try { owner = Number(fs.readFileSync(path.join(lockPath, "pid"), "utf8").trim()); } catch { /* incomplete stale lock */ }
      try {
        if (owner > 0) process.kill(owner, 0);
        if (owner > 0) throw new Error(`another cubed supervisor is already running as pid ${owner}`);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
      }
      const stale = `${lockPath}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
      try { fs.renameSync(lockPath, stale); fs.rmSync(stale, { recursive: true, force: true }); }
      catch (rename) { if ((rename as NodeJS.ErrnoException).code !== "ENOENT") throw rename; }
    }
  }
}

function resolveLink(link: string): string {
  const target = fs.readlinkSync(link);
  return path.resolve(path.dirname(link), target);
}

function releaseRecord(directory: string): ReleaseRecord {
  const value = JSON.parse(fs.readFileSync(path.join(directory, "release.json"), "utf8")) as Partial<ReleaseRecord>;
  if (!validVersion(value.version) || typeof value.commit !== "string" || !/^[0-9a-f]{7,64}$/.test(value.commit) ||
      !Number.isSafeInteger(value.stateSchema) || value.entry !== "app/packages/server/src/index.ts") {
    throw new Error(`invalid release metadata in ${directory}`);
  }
  const entry = path.join(directory, value.entry);
  const node = path.join(directory, "bin/node");
  if (!fs.statSync(entry).isFile() || !fs.statSync(node).isFile()) throw new Error(`incomplete cubed release ${value.version}`);
  return value as ReleaseRecord;
}

function baseStatus(record: ReleaseRecord): DurableStatus {
  const writable = canWrite(root);
  return {
    installation: writable ? "managed" : "read-only",
    enabled: writable && enabledByOperator,
    current: { version: record.version, commit: record.commit, stateSchema: record.stateSchema },
    available: null, phase: "idle", targetVersion: null, error: null,
    message: !writable ? "the cubed installation is read-only; update it with its external package manager"
      : !enabledByOperator ? "browser updates are disabled by the operator" : null,
    runnersUpdated: false, lastRequestId: null,
  };
}

function recoverStatus(record: ReleaseRecord): DurableStatus {
  let prior: DurableStatus | null = null;
  try { prior = JSON.parse(fs.readFileSync(statusPath, "utf8")) as DurableStatus; } catch { /* first start */ }
  if (prior && BUSY.has(prior.phase)) {
    try {
      const switched = prior.phase === "restarting" || prior.phase === "probation";
      if (switched) {
        if (!fs.existsSync(previousLink)) throw new Error("previous release link is missing");
        atomicLink(resolveLink(previousLink), currentLink);
      }
      const recovered = releaseRecord(resolveLink(currentLink));
      const next = { ...baseStatus(recovered), phase: switched ? "rolled-back" as const : "failed" as const,
        error: `interrupted update to ${prior.targetVersion ?? "unknown"} was stopped before startup`,
        message: switched ? "the previous cubed release was restored" : "the installed release was not changed",
        targetVersion: prior.targetVersion };
      persist(next); return next;
    } catch (error) {
      const next = { ...baseStatus(record), phase: "failed" as const,
        error: `interrupted update could not be recovered: ${message(error)}`, message: "manual recovery is required" };
      persist(next); return next;
    }
  }
  return { ...baseStatus(record), available: prior?.available ?? null,
    phase: prior?.phase === "updated" || prior?.phase === "rolled-back" || prior?.phase === "failed" ? prior.phase : "idle",
    targetVersion: prior?.targetVersion ?? null, error: prior?.error ?? null, message: prior?.message ?? baseStatus(record).message,
    lastRequestId: prior?.lastRequestId ?? null };
}

function canWrite(directory: string): boolean {
  try { fs.accessSync(directory, fs.constants.W_OK); return true; } catch { return false; }
}

function persist(next: DurableStatus): void {
  state = { ...next, runnersUpdated: false };
  const temporary = `${statusPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, statusPath);
}

function transition(phase: UpdateStatus["phase"], fields: Partial<DurableStatus> = {}): void {
  persist({ ...state, ...fields, phase });
}

function publicStatus(): UpdateStatus {
  const { lastRequestId: _, ...safe } = state;
  return safe;
}

function validVersion(value: unknown): value is string {
  return typeof value === "string" && /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
}

function compareVersion(a: string, b: string): number {
  const parse = (value: string) => value.replace(/^v/, "").split("-")[0].split(".").map(Number);
  const aa = parse(a); const bb = parse(b);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] - bb[i];
  return a.includes("-") === b.includes("-") ? a.localeCompare(b) : a.includes("-") ? -1 : 1;
}

function platform(): string {
  if (process.platform === "linux") return `linux-${process.arch}-gnu`;
  if (process.platform === "darwin") return `darwin-${process.arch}`;
  return `${process.platform}-${process.arch}`;
}

async function boundedFetch(url: string, maximum: number): Promise<Buffer> {
  const parsed = new URL(url);
  requireSecureUrl(parsed);
  const response = await fetch(parsed, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`update download failed with HTTP ${response.status}`);
  requireSecureUrl(new URL(response.url));
  const declared = Number(response.headers.get("content-length"));
  if (declared > maximum) throw new Error("update download exceeds its size limit");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > maximum) throw new Error("update download exceeds its size limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function requireSecureUrl(url: URL): void {
  if (url.protocol !== "https:" && !(process.env.CUBED_UPDATE_ALLOW_HTTP === "1" && url.hostname === "127.0.0.1")) {
    throw new Error("update URLs and redirects must use HTTPS");
  }
}

async function fetchManifest(): Promise<UpdateManifest> {
  if (!feed) throw new Error("no signed update feed is configured");
  const [bytes, signatureText] = await Promise.all([boundedFetch(feed, MAX_MANIFEST), boundedFetch(`${feed}.sig`, 4096)]);
  const key = fs.readFileSync(publicKeyPath);
  let signature: Buffer;
  try { signature = Buffer.from(signatureText.toString("utf8").trim(), "base64"); }
  catch { throw new Error("update manifest signature is not valid base64"); }
  if (!signature.length || !verify(null, bytes, key, signature)) throw new Error("update manifest signature verification failed");
  const manifest = JSON.parse(bytes.toString("utf8")) as Partial<UpdateManifest>;
  validateManifest(manifest);
  return manifest as UpdateManifest;
}

function validateManifest(value: Partial<UpdateManifest>): asserts value is UpdateManifest {
  if (value.schema !== 1 || value.product !== "cubed" || !validVersion(value.version) ||
      value.version.includes("-") ||
      typeof value.commit !== "string" || !/^[0-9a-f]{40}$/.test(value.commit) || value.platform !== platform() ||
      !Number.isSafeInteger(value.minimumSupervisor) || value.minimumSupervisor! > SUPERVISOR_VERSION ||
      value.includesRunner !== false || !value.stateSchema || !value.artifact ||
      !Number.isSafeInteger(value.stateSchema.minimum) || !Number.isSafeInteger(value.stateSchema.maximum) ||
      !Number.isSafeInteger(value.stateSchema.rollbackSafeFrom) || value.stateSchema.minimum > value.stateSchema.maximum ||
      typeof value.artifact.url !== "string" || !/^[0-9a-f]{64}$/.test(value.artifact.sha256) ||
      !Number.isSafeInteger(value.artifact.bytes) || value.artifact.bytes <= 0 || value.artifact.bytes > MAX_ARTIFACT) {
    throw new Error("signed update manifest is invalid or incompatible");
  }
  const schema = state.current.stateSchema;
  if (schema < value.stateSchema.minimum || schema > value.stateSchema.maximum || schema < value.stateSchema.rollbackSafeFrom) {
    throw new Error(`release ${value.version} does not declare rollback-safe compatibility with state schema ${schema}`);
  }
}

async function check(): Promise<void> {
  requireEnabled();
  transition("checking", { error: null, message: "checking the signed release feed" });
  try {
    const manifest = await fetchManifest();
    const available = compareVersion(manifest.version, state.current.version) > 0 ? {
      version: manifest.version, commit: manifest.commit, publishedAt: manifest.publishedAt ?? null,
      bytes: manifest.artifact.bytes, notesUrl: manifest.notesUrl ?? null,
    } : null;
    transition(available ? "available" : "idle", { available, targetVersion: null,
      message: available ? `${available.version} is ready to install` : "cubed is up to date", error: null });
  } catch (error) {
    transition("failed", { error: message(error), message: "the installed release was not changed" });
  }
}

function requireEnabled(): void {
  if (!state.enabled) throw new Error(state.message || "browser updates are disabled");
  if (BUSY.has(state.phase)) throw new Error("an update operation is already running");
}

function requestInstall(targetVersion: string, expectedCurrentVersion: string, requestId: string): void {
  if (state.lastRequestId === requestId) return;
  requireEnabled();
  if (expectedCurrentVersion !== state.current.version) throw new Error("cubed changed since this page was loaded; check for updates again");
  if (!state.available || state.available.version !== targetVersion) throw new Error("the requested release is not the verified available update");
  persist({ ...state, lastRequestId: requestId, targetVersion, error: null, message: `preparing ${targetVersion}` });
  orchestrating = true;
  void install(targetVersion).finally(() => { orchestrating = false; });
}

async function install(targetVersion: string): Promise<void> {
  const oldDirectory = resolveLink(currentLink);
  let switched = false;
  try {
    transition("verifying", { message: "verifying the signed release manifest" });
    const manifest = await fetchManifest();
    if (manifest.version !== targetVersion || compareVersion(manifest.version, state.current.version) <= 0) throw new Error("release feed changed; check again");
    transition("downloading", { message: `downloading ${manifest.version}` });
    const artifact = await boundedFetch(manifest.artifact.url, manifest.artifact.bytes);
    if (artifact.length !== manifest.artifact.bytes || createHash("sha256").update(artifact).digest("hex") !== manifest.artifact.sha256) {
      throw new Error("downloaded release does not match its signed size and checksum");
    }
    transition("staging", { message: `staging ${manifest.version}` });
    const candidate = await stage(manifest, artifact);
    await selfCheck(candidate, manifest);
    transition("draining", { message: "saving state and stopping the current cubed process" });
    await stopChild();
    atomicLink(oldDirectory, previousLink);
    transition("restarting", { message: `starting ${manifest.version}` });
    atomicLink(candidate, currentLink); switched = true;
    launch();
    await waitHealthy(manifest.version, manifest.commit);
    transition("probation", { message: `verifying ${manifest.version} stays healthy` });
    await waitStable(probationMs);
    transition("updated", { current: { version: manifest.version, commit: manifest.commit, stateSchema: state.current.stateSchema },
      available: null, error: null, message: `${manifest.version} is running; runners were not changed` });
  } catch (error) {
    const failure = message(error);
    if (switched) {
      try {
        await stopChild(); atomicLink(oldDirectory, currentLink); launch();
        const old = releaseRecord(oldDirectory); await waitHealthy(old.version, old.commit);
        transition("rolled-back", { current: { version: old.version, commit: old.commit, stateSchema: old.stateSchema },
          error: failure, message: `${targetVersion} failed; ${old.version} was restored` });
        return;
      } catch (rollback) {
        transition("failed", { error: `${failure}; rollback also failed: ${message(rollback)}`, message: "cubed requires manual recovery" });
        return;
      }
    }
    transition("failed", { error: failure, message: "the installed release was not changed" });
  }
}

async function stage(manifest: UpdateManifest, artifact: Buffer): Promise<string> {
  const destination = path.join(releases, manifest.version);
  if (fs.existsSync(destination)) {
    const existing = releaseRecord(destination);
    if (existing.commit !== manifest.commit) throw new Error(`release directory ${manifest.version} contains different bytes`);
    return destination;
  }
  const temporary = fs.mkdtempSync(path.join(releases, `.stage-${manifest.version}-`));
  const archive = path.join(temporary, "release.tar.gz");
  fs.writeFileSync(archive, artifact, { mode: 0o600 });
  try {
    const { stdout } = await exec("tar", ["-tzf", archive], { maxBuffer: 8 * 1024 * 1024 });
    const names = stdout.split("\n").filter(Boolean);
    if (!names.length || names.length > 100_000 || names.some(name => name.startsWith("/") || name.split("/").includes("..") || !name.startsWith("cubed/"))) {
      throw new Error("release archive contains an unsafe path layout");
    }
    await exec("tar", ["-xzf", archive, "--no-same-owner", "-C", temporary]);
    const unpacked = path.join(temporary, "cubed");
    validateExtractedTree(unpacked);
    const record = releaseRecord(unpacked);
    if (record.version !== manifest.version || record.commit !== manifest.commit || record.stateSchema !== state.current.stateSchema) {
      throw new Error("release metadata does not match its signed manifest or compatible state schema");
    }
    fs.rmSync(archive); fs.renameSync(unpacked, destination); return destination;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

function validateExtractedTree(directory: string): void {
  const rootPath = `${fs.realpathSync(directory)}${path.sep}`;
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) visit(filename);
      else if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(filename);
        if (path.isAbsolute(target)) throw new Error("release archive contains an absolute symlink");
        const resolved = fs.realpathSync(filename);
        if (!resolved.startsWith(rootPath)) throw new Error("release archive contains a symlink outside the release");
      } else if (!entry.isFile()) throw new Error("release archive contains a special filesystem entry");
    }
  };
  visit(directory);
}

async function selfCheck(directory: string, manifest: UpdateManifest): Promise<void> {
  const record = releaseRecord(directory);
  const result = await exec(path.join(directory, "bin/node"), [path.join(directory, record.entry), "--self-check"], {
    env: { ...process.env, CUBED_VERSION: manifest.version, CUBED_COMMIT: manifest.commit,
      CUBED_SUPERVISOR_SOCKET: "", CUBED_UPDATE_TOKEN: "" }, timeout: 20_000,
  });
  const output = JSON.parse(result.stdout.trim()) as { version?: string; commit?: string; stateSchema?: number };
  if (output.version !== manifest.version || output.commit !== manifest.commit || output.stateSchema !== state.current.stateSchema) {
    throw new Error("candidate self-check reported different build metadata");
  }
}

function launch(): void {
  const directory = resolveLink(currentLink); const record = releaseRecord(directory);
  child = spawn(path.join(directory, "bin/node"), [path.join(directory, record.entry)], {
    env: { ...process.env, CUBED_VERSION: record.version, CUBED_COMMIT: record.commit,
      CUBED_SUPERVISOR_SOCKET: socketPath, CUBED_UPDATE_TOKEN: token, CUBED_SUPERVISOR_LIFELINE_FD: "3" },
    stdio: ["inherit", "inherit", "inherit", "pipe"],
  });
  const launched = child;
  launched.once("exit", () => {
    if (child === launched) child = null;
    if (!stopping && !orchestrating) setTimeout(() => { if (!child && !stopping) launch(); }, 1000).unref();
  });
}

async function stopChild(): Promise<void> {
  if (!child) return;
  const target = child; const closed = once(target, "exit"); target.kill("SIGTERM");
  const forced = setTimeout(() => target.kill("SIGKILL"), stopTimeoutMs); forced.unref();
  await closed; clearTimeout(forced); if (child === target) child = null;
}

async function waitHealthy(version: string, commit: string): Promise<void> {
  const deadline = Date.now() + timeoutMs; let last = "no response";
  const host = !process.env.CUBED_HOST || process.env.CUBED_HOST === "0.0.0.0" ? "127.0.0.1" : process.env.CUBED_HOST;
  const url = process.env.CUBED_HEALTH_URL || `http://${host}:${process.env.CUBED_PORT || "7777"}/api/health`;
  while (Date.now() < deadline) {
    if (!child || child.exitCode !== null || child.signalCode !== null) throw new Error(`candidate ${version} exited before readiness`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      const health = await response.json() as { lifecycle?: string; version?: string; commit?: string };
      if (response.ok && health.lifecycle === "ready" && health.version === version && health.commit === commit) return;
      last = `unexpected health response ${JSON.stringify(health)}`;
    } catch (error) { last = message(error); }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`candidate ${version} did not become healthy: ${last}`);
}

async function waitStable(milliseconds: number): Promise<void> {
  const target = child; await new Promise(resolve => setTimeout(resolve, milliseconds));
  if (!target || child !== target || target.exitCode !== null || target.signalCode !== null) throw new Error("candidate exited during the health probation period");
}

function atomicLink(target: string, link: string): void {
  const temporary = `${link}.new.${process.pid}`;
  fs.rmSync(temporary, { force: true }); fs.symlinkSync(target, temporary);
  fs.renameSync(temporary, link);
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

fs.rmSync(socketPath, { force: true });
const control = net.createServer(connection => {
  connection.setEncoding("utf8"); let raw = "";
  // cubed can disappear while a GUI status poll is in flight during restart.
  // That client disconnect must not turn a successful update into supervisor death.
  connection.on("error", () => {});
  connection.on("data", chunk => { raw += chunk; if (raw.length > 64 * 1024) connection.destroy(); });
  connection.on("end", () => {
    try {
      const request = JSON.parse(raw) as Record<string, unknown>;
      if (request.token !== token) throw new Error("update supervisor authorization failed");
      if (request.action === "check") { requireEnabled(); void check(); }
      else if (request.action === "install") requestInstall(String(request.targetVersion), String(request.expectedCurrentVersion), String(request.requestId));
      else if (request.action !== "status") throw new Error("unknown update supervisor action");
      connection.end(`${JSON.stringify({ ok: true, status: publicStatus() })}\n`);
    } catch (error) { connection.end(`${JSON.stringify({ ok: false, error: message(error), status: publicStatus() })}\n`); }
  });
});
control.listen(socketPath, () => { fs.chmodSync(socketPath, 0o600); launch(); });

for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
  stopping = true; control.close(); void stopChild().finally(() => {
    fs.rmSync(socketPath, { force: true }); fs.rmSync(lockPath, { recursive: true, force: true }); process.exit(0);
  });
});
