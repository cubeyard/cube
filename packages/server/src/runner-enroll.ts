/** Operator admission of runners, and the local runner: one `cube-runner` on
 * this host, reached over loopback, initialized and enrolled by one command.
 * Admission never provisions or modifies a runner; the local runner's state
 * is written by `cube-runner init` alone and is never rebound. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Registry } from "./registry.ts";
import { IrohRunnerClient, RUNNER_CONFIG_VERSION } from "./iroh-node.ts";

const run = promisify(execFile);

export interface Enrollment {
  nodeId: string; threadId: string; environmentId: number;
  profile: "vm-runner"; admitted: true;
  softwareVersion: string; platform: string; baseImageSha256: string; maxActiveVms: number;
  next: string;
}

/** Admits the runner a version-2 config describes to the installation's
 * global pool, after an authenticated protocol-3 hello (a protocol-2 runner
 * is refused) and a status exchange. Each runner needs its own control key:
 * two endpoints publishing one Iroh identity break each other's calls. */
export async function enrollRunner(options: { state: string; configPath: string }): Promise<Enrollment> {
  const { state, configPath } = options;
  if (!path.isAbsolute(state) || !path.isAbsolute(configPath)) throw new Error("the state directory and the runner config must be absolute paths");
  const client = new IrohRunnerClient({ configPath });
  const registry = new Registry(path.join(state, "registry.sqlite"));
  try {
    const controlKey = (file: string): Buffer | undefined => {
      try { return fs.readFileSync(JSON.parse(fs.readFileSync(file, "utf8")).controlKey); } catch { return undefined; }
    };
    const mine = controlKey(configPath);
    const retired = new Set(registry.runnerStatuses().filter(status => status.retiredAt).map(status => status.id));
    const shared = registry.listRunners().find(runner => runner.nodeId !== client.binding.nodeId && !retired.has(runner.threadId)
      && mine && controlKey(runner.configPath)?.equals(mine));
    if (shared) throw new Error(`control key already used by runner ${shared.nodeId}; create a separate control key for each runner`);
    const described = await client.describe();
    const health = await client.health();
    registry.enrollRunner({ ...client.binding, configPath, configHash: client.configHash, maxActiveVms: health.maxActiveVms });
    return { ...client.binding, profile: "vm-runner", admitted: true, softwareVersion: described.softwareVersion,
      platform: described.platform, baseImageSha256: described.baseImageSha256, maxActiveVms: health.maxActiveVms,
      next: "restart cubed if this runner's network mode is wider than the others; start a thread in any ready project" };
  } finally { registry.close(); }
}

export interface LocalRunnerOptions {
  /** cubed's state; the registry the runner is enrolled in. */
  state: string;
  /** The local runner's directory (default `~/.cube`): `control.key`,
   * `runner/` (the cube-runner home) and `runner.json`. */
  home: string;
  /** The Debian 13 genericcloud qcow2 the runner copies into its state. */
  image: string;
  /** The loopback address the runner listens on; cubed reaches it there. */
  listen: string;
  nodeId?: string;
  /** The cube-runner binary: the option, `CUBE_RUNNER`, or `cube-runner` on PATH. */
  runner?: string;
  qemu?: string;
  firmware?: string;
  maxVcpus?: number;
  maxMemoryMib?: number;
  maxDiskGib?: number;
  /** How long to wait for the temporary runner to answer. */
  startTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface LocalRunner {
  runner: string; home: string; configPath: string; nodeId: string; peer: string; address: string;
  baseImageSha256: string | null; qemu: string | null;
  /** The admission, or null when the runner could not be started here and
   * `enrollRunner` must be run once it is up. */
  enrollment: Enrollment | null;
  /** Why the runner did not start, when it did not. */
  runnerError: string | null;
}

export const DEFAULT_LOCAL_RUNNER_LISTEN = "127.0.0.1:7778";

/** The `cube-runner` binary: CUBE_RUNNER names it, otherwise the first on PATH. */
export function findRunner(env: NodeJS.ProcessEnv = process.env, configured?: string): string | null {
  const candidate = configured?.trim() || env.CUBE_RUNNER?.trim();
  const candidates = candidate ? [candidate]
    : (env.PATH ?? "").split(path.delimiter).filter(Boolean).map(directory => path.join(directory, "cube-runner"));
  for (const file of candidates) {
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return path.resolve(file); } catch { /* next */ }
  }
  return null;
}

/** `node-local-<host>`: letters, digits and dashes only, at most 64 characters. */
export function localNodeId(hostname = os.hostname()): string {
  const host = hostname.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 52) || "host";
  return `node-local-${host}`;
}

/** Initializes a cube-runner under `home/runner` (its own key, the base image
 * copied in, loopback at `listen`), writes the version-2 config cubed reads,
 * then starts the runner for a moment to enroll it. The runner is left
 * stopped; a service or `cube-runner run --home <home>/runner` starts it. */
export async function initLocalRunner(options: LocalRunnerOptions): Promise<LocalRunner> {
  const log = options.log ?? (() => {});
  const runner = findRunner(process.env, options.runner);
  if (!runner) throw new Error("cube-runner was not found on PATH (install it, or set CUBE_RUNNER to the binary)");
  const home = path.resolve(options.home);
  const state = path.resolve(options.state);
  const image = path.resolve(options.image);
  if (!fs.existsSync(image) || !fs.statSync(image).isFile()) throw new Error(`base image not found: ${image}`);
  if (!/^(127\.\d+\.\d+\.\d+|\[::1\]|localhost):\d{1,5}$/.test(options.listen)) throw new Error("--listen must be a loopback address with a port, for example 127.0.0.1:7778");
  const address = options.listen.replace(/^localhost:/, "127.0.0.1:");
  const nodeId = options.nodeId ?? localNodeId();
  if (!/^node-[a-zA-Z0-9-]{1,123}$/.test(nodeId)) throw new Error("--node-id must start with node- and contain letters, digits and dashes only");
  const version = JSON.parse((await run(runner, ["version"], { encoding: "utf8", timeout: 10000 })).stdout) as { softwareVersion?: string; protocolVersion?: number };
  if (version.protocolVersion !== 3) throw new Error(`${runner} speaks runner protocol ${version.protocolVersion}, not 3; install cube-runner 0.4.0 or newer`);
  const runnerHome = path.join(home, "runner");
  const controlKey = path.join(home, "control.key");
  const configPath = path.join(home, "runner.json");
  for (const existing of [runnerHome, controlKey, configPath]) {
    if (fs.existsSync(existing)) throw new Error(`${existing} already exists; a runner is never rebound (choose another --home, or move the old one aside after archiving its threads)`);
  }
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  log(`cube-runner ${version.softwareVersion ?? "?"} at ${runner}`);
  const control = JSON.parse((await run(runner, ["keygen", "--key", controlKey], { encoding: "utf8", timeout: 10000 })).stdout) as { peerId: string };
  // The binding's thread id is the registry's runner id, so it is the node id: unique per installation by construction.
  const initArgs = ["init", "--home", runnerHome, "--image", image, "--allow-peer", control.peerId, "--node-id", nodeId,
    "--thread-id", nodeId, "--env", "1", "--network", "loopback", "--listen", address];
  if (options.qemu) initArgs.push("--qemu", options.qemu);
  if (options.firmware) initArgs.push("--firmware", options.firmware);
  if (options.maxVcpus !== undefined) initArgs.push("--max-vcpus", String(options.maxVcpus));
  if (options.maxMemoryMib !== undefined) initArgs.push("--max-memory-mib", String(options.maxMemoryMib));
  if (options.maxDiskGib !== undefined) initArgs.push("--max-disk-gib", String(options.maxDiskGib));
  log(`initializing ${runnerHome} (copying the base image)`);
  let initOutput: string;
  try { initOutput = (await run(runner, initArgs, { encoding: "utf8", timeout: 30 * 60_000, maxBuffer: 1 << 20 })).stdout; }
  catch (error) {
    const failure = error as { stderr?: string; message: string };
    throw new Error(`cube-runner init failed: ${(failure.stderr || failure.message).trim()}`);
  }
  const field = (name: string) => initOutput.match(new RegExp(`^${name}: (.+)$`, "m"))?.[1]?.trim() ?? null;
  const peer = field("peer");
  if (!peer || !/^[0-9a-f]{64}$/.test(peer)) throw new Error("cube-runner init did not print the runner's peer");
  const baseImageSha256 = field("base image")?.replace(/^sha256 /, "") ?? null;
  const config = { version: RUNNER_CONFIG_VERSION, binding: { nodeId, threadId: nodeId, environmentId: 1 },
    controlKey, serverPeer: peer, address, network: "loopback" };
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode: 0o600 });
  log(`wrote ${configPath}`);
  const result: LocalRunner = { runner, home, configPath, nodeId, peer, address, baseImageSha256, qemu: field("qemu"), enrollment: null, runnerError: null };

  // Enrollment needs the runner answering: run it until the admission is
  // recorded, then stop it the way its first Ctrl-C would.
  log("starting the runner to enroll it");
  const child = spawn(runner, ["run", "--home", runnerHome], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
  const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  const deadline = Date.now() + (options.startTimeoutMs ?? 20_000);
  let reachable = false;
  let lastError = "no answer yet";
  while (!gone() && Date.now() < deadline) {
    try { await new IrohRunnerClient({ configPath }).describe(); reachable = true; break; }
    catch (error) { lastError = error instanceof Error ? error.message : String(error); }
    await delay(250);
  }
  try {
    if (reachable) {
      result.enrollment = await enrollRunner({ state, configPath });
      log(`enrolled ${nodeId} in ${state}`);
    } else {
      result.runnerError = gone()
        ? `the runner exited (${child.exitCode ?? child.signalCode}): ${lastLines(stderr)}`
        : `the runner did not answer at ${address} in time (${lastError}); ${lastLines(stderr)}`;
    }
  } finally { await stopRunner(child, exited); }
  return result;
}

async function stopRunner(child: ChildProcess, exited: Promise<void>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGINT");
  const forced = setTimeout(() => child.kill("SIGKILL"), 35_000);
  forced.unref();
  await exited;
  clearTimeout(forced);
}

function lastLines(text: string): string {
  const lines = text.trim().split("\n").filter(Boolean);
  const human = lines.filter(line => !line.startsWith("{"));
  return (human.length ? human : lines).slice(-3).join(" | ") || "(no output)";
}
