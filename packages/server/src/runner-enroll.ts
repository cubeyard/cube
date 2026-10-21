/** Operator admission of runners, and the local runner: one `berth vm` on
 * this host, reached over loopback, set up and enrolled by one command that
 * can be run again. Admission never provisions or modifies a runner; the
 * local berth's directory is written by berth alone and is never rebound. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import dgram from "node:dgram";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { SecretKey } from "@number0/iroh/index.js";
import { Registry } from "./registry.ts";
import { IrohRunnerClient } from "./iroh-node.ts";
import { Runner_Kind } from "./gen/runner_pb.js";
import { loadSessionConfig, RunnerSession } from "./runner-session.ts";

const run = promisify(execFile);

export interface Enrollment {
  nodeId: string; threadId: string; environmentId: number;
  profile: "vm-runner" | "host-runner"; admitted: true;
  softwareVersion: string; platform: string; baseImageSha256: string; maxActiveVms: number;
  next: string;
}

/** Admits the runner a version-2 config describes to the installation (it
 * takes only threads started on it by name, pooledRunner), after an authenticated protocol-3 hello (a protocol-2 runner
 * is refused) and a status exchange. Each runner needs its own control key:
 * two endpoints publishing one Iroh identity break each other's calls. */
export async function enrollRunner(options: { state: string; configPath: string }): Promise<Enrollment> {
  const { state, configPath } = options;
  if (!path.isAbsolute(state) || !path.isAbsolute(configPath)) throw new Error("the state directory and the runner config must be absolute paths");
  let protocol: unknown;
  try { protocol = (JSON.parse(fs.readFileSync(configPath, "utf8")) as { protocol?: unknown }).protocol; } catch { protocol = undefined; }
  if (protocol === 4) return enrollProtocol4(state, configPath);
  const client = new IrohRunnerClient({ configPath });
  const registry = new Registry(path.join(state, "registry.sqlite"));
  try {
    sharedControlKey(registry, configPath, client.binding.nodeId);
    const described = await client.describe();
    const health = await client.health();
    registry.enrollRunner({ ...client.binding, configPath, configHash: client.configHash, maxActiveVms: health.maxActiveVms });
    return { ...client.binding, profile: "vm-runner", admitted: true, softwareVersion: described.softwareVersion,
      platform: described.platform, baseImageSha256: described.baseImageSha256, maxActiveVms: health.maxActiveVms,
      next: `restart cubed if this runner's network mode is wider than the others; start a thread on it by name: ask OptChat to start one on runner ${client.binding.nodeId} (a protocol-3 runner is not in the pool)` };
  } finally { registry.close(); }
}

function sharedControlKey(registry: Registry, configPath: string, nodeId: string): void {
  const controlKey = (file: string): Buffer | undefined => {
    try { return fs.readFileSync(JSON.parse(fs.readFileSync(file, "utf8")).controlKey); } catch { return undefined; }
  };
  const mine = controlKey(configPath);
  const retired = new Set(registry.runnerStatuses().filter(status => status.retiredAt).map(status => status.id));
  const shared = registry.listRunners().find(runner => runner.nodeId !== nodeId && !retired.has(runner.threadId)
    && mine && controlKey(runner.configPath)?.equals(mine));
  if (shared) throw new Error(`control key already used by runner ${shared.nodeId}; create a separate control key for each runner`);
}

/** A protocol-4 runner (`"protocol": 4` in its config; `berth host` or
 * `berth vm`): admitted after an authenticated hello. A `berth vm` joins
 * the pool; only threads started on a `berth host` by name run there
 * (pooledRunner). */
async function enrollProtocol4(state: string, configPath: string): Promise<Enrollment> {
  const { config, hash } = loadSessionConfig(configPath);
  const registry = new Registry(path.join(state, "registry.sqlite"));
  const session = new RunnerSession(config);
  try {
    sharedControlKey(registry, configPath, config.binding.nodeId);
    const runner = (await session.hello()).runner!;
    const host = runner.kind === Runner_Kind.HOST;
    const maxActiveVms = Math.max(1, runner.limits?.maxMachines ?? 1);
    registry.enrollRunner({ ...config.binding, configPath, configHash: hash, maxActiveVms, protocol: 4, kind: host ? "host" : "vm" });
    return { ...config.binding, profile: host ? "host-runner" : "vm-runner", admitted: true, softwareVersion: runner.softwareVersion,
      platform: [runner.platform?.os, runner.platform?.arch].filter(Boolean).join("/"), baseImageSha256: runner.platform?.baseImageSha256 ?? "",
      maxActiveVms,
      next: host ? `start a thread on it by name: ask OptChat to start one on runner ${config.binding.nodeId} (it runs unsandboxed on that host)`
        : `start a thread in any ready project (the pool places it on a berth vm), or ask OptChat to start one on runner ${config.binding.nodeId} by name` };
  } finally {
    await session.close();
    registry.close();
  }
}

/** The local `berth vm` cubed sets up on this host (`cubed runners
 * init-local`), every file under `home` (default `~/.cube`). A protocol-3
 * runner's `runner/`, `runner.json` and `control.key` there are never read
 * or touched. */
export interface LocalBerthFiles {
  /** berth's `--dir`: its key, journal, machine disks and layer cache. */
  dir: string;
  /** cubed's protocol-4 config for it (0600). */
  configPath: string;
  /** cubed's control key for it (0600). */
  controlKey: string;
  /** What the service starts it with: the image, the slots and the listen
   * address (0600). */
  settings: string;
}

export function localBerthFiles(home: string): LocalBerthFiles {
  return { dir: path.join(home, "berth"), configPath: path.join(home, "berth.json"), controlKey: path.join(home, "berth.control.key"),
    settings: path.join(home, "berth.env") };
}

export interface LocalBerthOptions {
  /** cubed's state; the registry the runner is enrolled in. */
  state: string;
  /** The local runner's directory (default `~/.cube`). */
  home: string;
  /** The image every machine is built on: `default` (cube's default,
   * official Debian trixie pinned by berth, which berth prepares for cube),
   * else the operator's own, pinned by digest, which must bring cube's
   * tools itself. Read from `berth.env` once it is recorded; `default` when
   * nothing says otherwise. */
  image?: string;
  /** The loopback address berth listens on (default 127.0.0.1:7779). */
  listen?: string;
  nodeId?: string;
  /** Machines at once (default 2). */
  maxMachines?: number;
  /** The programs and keel's files, by path: the options, else `CUBE_BERTH`,
   * `CUBE_BERTH_QEMU`, `CUBE_BERTH_QEMU_IMG`, `CUBE_BERTH_MKFS_EROFS` and
   * `CUBE_BERTH_KEEL` (Homebrew's launcher sets them), else the programs on
   * PATH; keel has no default. */
  berth?: string; qemu?: string; qemuImg?: string; mkfsErofs?: string; keel?: string;
  /** How long the temporary berth may take to its banner: it pulls the
   * image first (default 30 minutes). */
  startTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface LocalBerth {
  home: string; files: LocalBerthFiles; nodeId: string; address: string; image: string; maxMachines: number;
  /** Everything was already set up and enrolled in this state: nothing changed. */
  already: boolean;
  /** The admission, or null when berth could not be started or asked here (`runnerError`). */
  enrollment: Enrollment | null;
  runnerError: string | null;
}

export const DEFAULT_LOCAL_BERTH_LISTEN = "127.0.0.1:7779";
export const DEFAULT_LOCAL_BERTH_MACHINES = 2;
const PINNED_IMAGE = /^[A-Za-z0-9._/:-]+@sha256:[0-9a-f]{64}$/;
/** berth's own default image (berth `--image default`, packages/berth/debian/trixie.json). */
export const DEFAULT_LOCAL_BERTH_IMAGE = "default";
const imageAccepted = (image: string) => image === DEFAULT_LOCAL_BERTH_IMAGE || PINNED_IMAGE.test(image);

/** The image as people read it. */
export function describeBerthImage(image: string): string {
  return image === DEFAULT_LOCAL_BERTH_IMAGE
    ? "default (official Debian trixie, pinned by berth, which adds sudo, git, gh, curl and ca-certificates from pinned Debian packages)"
    : `${image} (your own: it must bring bash, sudo, flock, git, gh, curl and a CA bundle, or no machine becomes ready)`;
}
/** berth keeps `<dir>/<16-hex machine id>/qmp.sock` within 100 bytes. */
const MAX_DIR_BYTES = 100 - 26;

/** `node-berth-<host>`: a-z, 0-9 and dashes, at most 63 characters; never a
 * protocol-3 local runner's `node-local-<host>`. */
export function localBerthNodeId(hostname = os.hostname()): string {
  const host = hostname.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 52) || "host";
  return `node-berth-${host}`;
}

/** A loopback IPv4 address with a port from 1 to 65535. */
function loopbackListen(listen: string): boolean {
  const port = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}:(\d{1,5})$/.exec(listen);
  return !!port && listen.split(":")[0]!.split(".").every(octet => Number(octet) <= 255) && Number(port[1]) >= 1 && Number(port[1]) <= 65535;
}

/** `berth.env`: what the service passes to `berth vm` besides the paths. */
export function readBerthSettings(text: string): { image: string; maxMachines: number; listen: string } {
  const value = (name: string) => text.split("\n").map(line => line.trim()).find(line => line.startsWith(`${name}=`))?.slice(name.length + 1);
  const image = value("CUBE_BERTH_IMAGE") ?? "";
  const raw = value("CUBE_BERTH_MAX_MACHINES") ?? "";
  const listen = value("CUBE_BERTH_LISTEN") ?? "";
  const maxMachines = Number(raw);
  if (!imageAccepted(image) || !/^[1-9]\d?$/.test(raw) || maxMachines > 64 || !loopbackListen(listen)) {
    throw new Error("is not a berth.env of cubed's (CUBE_BERTH_IMAGE=default or <registry/repository@sha256:…>, CUBE_BERTH_MAX_MACHINES=1…64, CUBE_BERTH_LISTEN=127.x.x.x:<port>)");
  }
  return { image, maxMachines, listen };
}

function berthSettingsText(image: string, maxMachines: number, listen: string): string {
  return "# Written once by `cubed runners init-local`; the cube-berth service starts berth vm with these.\n"
    + `CUBE_BERTH_IMAGE=${image}\nCUBE_BERTH_MAX_MACHINES=${maxMachines}\nCUBE_BERTH_LISTEN=${listen}\n`;
}

/** Why berth could not bind its UDP listen address now, or null if it
 * could. Only a check before the pull: the port can still be taken before
 * berth binds it, which is why nothing records the address until berth
 * listens. */
async function unbindable(listen: string): Promise<string | null> {
  const at = listen.lastIndexOf(":");
  const socket = dgram.createSocket({ type: "udp4" });
  return new Promise(resolve => {
    socket.once("error", (error: NodeJS.ErrnoException) => {
      try { socket.close(); } catch { /* never bound */ }
      resolve(error.code === "EADDRINUSE" ? "is in use" : `cannot be bound here (${error.code ?? error.message})`);
    });
    socket.bind({ address: listen.slice(0, at), port: Number(listen.slice(at + 1)), exclusive: true }, () => socket.close(() => resolve(null)));
  });
}

/** The public half of a 32-byte control key, as berth's `--allow-peer`. */
function controlPeer(file: string): string {
  const bytes = fs.readFileSync(file);
  try {
    if (bytes.length !== 32) throw new Error(`${file} is not a control key (32 bytes)`);
    return Buffer.from(SecretKey.fromBytes(Array.from(bytes)).public().toBytes()).toString("hex");
  } finally { bytes.fill(0); }
}

/** The physical path of an absolute path that may not exist yet: its nearest
 * existing directory resolved, the rest as given. */
function physical(target: string): string {
  let existing = target;
  const rest: string[] = [];
  while (!fs.existsSync(existing)) { rest.unshift(path.basename(existing)); existing = path.dirname(existing); }
  return path.join(fs.realpathSync(existing), ...rest);
}

/** A program by path: the option, else the variable, else the first of
 * `names` on PATH. */
function program(given: string | undefined, variable: string, flag: string, names: string[]): string {
  const configured = given?.trim() || process.env[variable]?.trim();
  const candidates = configured ? [configured]
    : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).flatMap(directory => names.map(name => path.join(directory, name)));
  for (const file of candidates) {
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return path.resolve(file); } catch { /* next */ }
  }
  throw new Error(configured ? `not an executable file: ${configured}` : `${names[0]} was not found on PATH (give ${flag} or set ${variable})`);
}

/** Sets up the local `berth vm` and enrolls it. It can be run again at any
 * time, for example after `brew uninstall` and `brew install`: it creates
 * only what is missing (the control key, berth's directory by berth's own
 * first run, then `berth.env` and `berth.json` once berth listens), checks
 * that what is there belongs together, and never deletes, overwrites or
 * rebinds a file. A run that failed before berth listened (a wrong image
 * digest, a port in use) recorded no image and no listen address, so the
 * next may name others. When all of it
 * is there and enrolled in this state it changes nothing and starts
 * nothing. Enrollment needs berth answering: it is started until the
 * admission is recorded (the first time it pulls the image before it
 * listens), then stopped as its Ctrl-C would. */
export async function initLocalBerth(options: LocalBerthOptions): Promise<LocalBerth> {
  const log = options.log ?? (() => {});
  const home = path.resolve(options.home);
  const state = path.resolve(options.state);
  const files = localBerthFiles(home);
  const exists = (file: string) => fs.existsSync(file);
  const conflict = (what: string) => new Error(`${what}; init-local changes nothing that is there (a runner is never rebound): give the recorded value, or another --home`);

  // What is there already, and whether it belongs together.
  let recorded: ReturnType<typeof readBerthSettings> | null = null;
  if (exists(files.settings)) {
    try { recorded = readBerthSettings(fs.readFileSync(files.settings, "utf8")); } catch (error) { throw new Error(`${files.settings} ${(error as Error).message}`); }
  }
  const config = exists(files.configPath) ? loadSessionConfig(files.configPath) : null;
  const vmHome = path.join(files.dir, ".berth", "vm.json");
  if (exists(path.join(files.dir, ".berth", "host.json"))) throw new Error(`${files.dir} is a berth host directory, not a berth vm's`);
  const berthHome = exists(vmHome) ? JSON.parse(fs.readFileSync(vmHome, "utf8")) as { nodeId?: string; allowedPeer?: string; listen?: string | null } : null;
  const peer = exists(files.controlKey) ? controlPeer(files.controlKey) : null;

  if (options.image !== undefined && !imageAccepted(options.image)) {
    throw new Error("--image must be default (cube's default image; the same as leaving it out) or your own image pinned: <registry/repository>@sha256:<64 hex>");
  }
  if (recorded && options.image !== undefined && options.image !== recorded.image) throw conflict(`${files.settings} names the image ${recorded.image}`);
  const image = options.image ?? recorded?.image ?? DEFAULT_LOCAL_BERTH_IMAGE;
  if (options.maxMachines !== undefined && (!Number.isInteger(options.maxMachines) || options.maxMachines < 1 || options.maxMachines > 64)) {
    throw new Error("--max-machines must be 1 through 64");
  }
  if (recorded && options.maxMachines !== undefined && options.maxMachines !== recorded.maxMachines) {
    throw conflict(`${files.settings} says ${recorded.maxMachines} machine${recorded.maxMachines === 1 ? "" : "s"} at once`);
  }
  const maxMachines = options.maxMachines ?? recorded?.maxMachines ?? DEFAULT_LOCAL_BERTH_MACHINES;
  const recordedNode = config?.config.binding.nodeId ?? berthHome?.nodeId;
  if (options.nodeId !== undefined && recordedNode && options.nodeId !== recordedNode) throw conflict(`this runner is ${recordedNode}`);
  const nodeId = options.nodeId ?? recordedNode ?? localBerthNodeId();
  if (!/^node-[a-z0-9-]{1,59}$/.test(nodeId)) throw new Error("--node-id must start with node- and hold a-z, 0-9 and dashes only (at most 64 characters)");
  // The listen address is fixed once berth has listened on it (berth.env,
  // berth.json), and the service passes berth.env's. The one in berth's
  // vm.json is only what an earlier run tried: berth records it before its
  // pull and bind, and takes another --listen on any start.
  const given = options.listen?.replace(/^localhost:/, "127.0.0.1:");
  if (config && recorded && config.config.address !== recorded.listen) {
    throw conflict(`${files.configPath} names the address ${config.config.address}, but ${files.settings} ${recorded.listen}`);
  }
  const recordedListen = config?.config.address ?? recorded?.listen;
  if (given !== undefined && recordedListen && given !== recordedListen) throw conflict(`this runner listens on ${recordedListen}`);
  const listen = given ?? recordedListen ?? berthHome?.listen ?? DEFAULT_LOCAL_BERTH_LISTEN;
  if (!loopbackListen(listen)) throw new Error("--listen must be a loopback IPv4 address with a port from 1 to 65535, for example 127.0.0.1:7779");
  if (config) {
    const c = config.config;
    if (c.controlKey !== files.controlKey || c.network !== "loopback" || c.binding.threadId !== c.binding.nodeId || c.binding.environmentId !== 1) {
      throw conflict(`${files.configPath} is not this local berth's config (control key ${files.controlKey}, loopback, its node id as id)`);
    }
    if (!peer) throw conflict(`${files.configPath} names ${files.controlKey}, which is missing`);
  }
  if (berthHome) {
    if (berthHome.nodeId !== nodeId) throw conflict(`${vmHome} is runner ${berthHome.nodeId}`);
    if (!peer) throw conflict(`${vmHome} exists, but ${files.controlKey}, the control key it takes, is missing`);
    if (berthHome.allowedPeer !== peer) throw conflict(`${vmHome} takes another control peer than ${files.controlKey}'s`);
  }
  const dir = physical(files.dir);
  if (Buffer.byteLength(dir) > MAX_DIR_BYTES) throw new Error(`${dir} is too long: berth needs <dir>/<machine id>/qmp.sock within 100 bytes (choose a shorter --home)`);

  const result: LocalBerth = { home, files, nodeId, address: listen, image, maxMachines, already: false, enrollment: null, runnerError: null };

  // Enrolled in this state already: nothing is left to do.
  const registry = new Registry(path.join(state, "registry.sqlite"));
  try {
    const enrolled = registry.getRunner(nodeId);
    if (enrolled) {
      if (!config || enrolled.configPath !== files.configPath || enrolled.configHash !== config.hash) {
        throw conflict(`runner ${nodeId} is enrolled in ${state} from ${enrolled.configPath}`);
      }
      if (registry.runnerStatuses().find(status => status.id === nodeId)?.retiredAt) {
        throw new Error(`runner ${nodeId} is retired in ${state}; init-local does not admit it again`);
      }
      if (!berthHome) throw conflict(`runner ${nodeId} is enrolled in ${state}, but its directory ${files.dir} is gone`);
      if (!recorded) {
        // Only the service's settings are missing: written again, nothing
        // else. The image they named is not known here, so it is never
        // guessed: a runner on its own image must not move to the default.
        if (options.image === undefined) {
          throw new Error(`${files.settings} is gone, and runner ${nodeId} is enrolled: give --image as it was (default, or your own image's pinned reference) to write it again`);
        }
        fs.writeFileSync(files.settings, berthSettingsText(image, maxMachines, listen), { mode: 0o600, flag: "wx" });
        log(`wrote ${files.settings}`);
      }
      result.already = recorded !== null;
      return result;
    }
  } finally { registry.close(); }

  // Create what is missing, in an order a failed run continues from.
  const keelGiven = options.keel?.trim() || process.env.CUBE_BERTH_KEEL?.trim();
  if (!keelGiven) throw new Error("keel's vmlinuz and base.erofs: give --keel <directory> or set CUBE_BERTH_KEEL");
  const keel = path.resolve(keelGiven);
  for (const file of ["vmlinuz", "base.erofs"]) if (!exists(path.join(keel, file))) throw new Error(`--keel has no ${file}: ${keel}`);
  const berth = program(options.berth, "CUBE_BERTH", "--berth", ["berth"]);
  const version = JSON.parse((await run(berth, ["version"], { encoding: "utf8", timeout: 10000 })).stdout) as { softwareVersion?: string; protocolVersion?: number };
  if (version.protocolVersion !== 4) throw new Error(`${berth} speaks runner protocol ${version.protocolVersion}, not 4`);
  const qemu = program(options.qemu, "CUBE_BERTH_QEMU", "--qemu", [`qemu-system-${process.arch === "arm64" ? "aarch64" : "x86_64"}`]);
  const qemuImg = program(options.qemuImg, "CUBE_BERTH_QEMU_IMG", "--qemu-img", ["qemu-img"]);
  const mkfs = program(options.mkfsErofs, "CUBE_BERTH_MKFS_EROFS", "--mkfs-erofs", ["mkfs.erofs"]);
  log(`berth ${version.softwareVersion ?? "?"} at ${berth}`);
  // Before anything is written and before the pull: an address berth could
  // not bind. Not once it is recorded, when the service may hold it.
  if (!recorded && !config) {
    const why = await unbindable(listen);
    if (why) throw new Error(`${listen} (UDP) ${why}: give another --listen, or free it (nothing was written)`);
  }
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  let allowPeer = peer;
  if (!allowPeer) {
    allowPeer = (JSON.parse((await run(berth, ["keygen", "--key", files.controlKey], { encoding: "utf8", timeout: 10000 })).stdout) as { peerId: string }).peerId;
    log(`wrote ${files.controlKey}`);
  }
  // berth.env and berth.json come only after berth has pulled the image and
  // listens: until then a run may give another --image, --max-machines or
  // --listen, and the service does not start.

  log(berthHome ? `starting berth vm in ${files.dir} to enroll it` : `starting berth vm in ${files.dir} for the first time: it makes its key and pulls ${image === DEFAULT_LOCAL_BERTH_IMAGE ? "cube's default image (Debian trixie), then prepares it for cube" : image}`);
  const child = spawn(berth, ["vm", "--dir", files.dir, "--qemu", qemu, "--qemu-img", qemuImg, "--keel", keel, "--mkfs-erofs", mkfs,
    "--image", image, "--max-machines", String(maxMachines), "--allow-peer", allowPeer, "--node-id", nodeId, "--network", "loopback", "--listen", listen],
  { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  let pending = "";
  let serverPeer: string | null = null;
  let ready = false;
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-8192);
    pending += chunk;
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      const announced = /^peer: ([0-9a-f]{64})$/.exec(line);
      if (announced) serverPeer = announced[1]!;
      if (line.startsWith("waiting for cubed")) ready = true;
      else if (line && !line.startsWith("{")) log(`  berth: ${line}`);
    }
  });
  const exited = new Promise<void>(resolve => { child.once("exit", () => resolve()); child.once("error", () => resolve()); });
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  // The temporary berth never outlives this command.
  const onSignal = (signal: NodeJS.Signals) => {
    void stopBerth(child, exited).finally(() => { process.exitCode = 130; process.kill(process.pid, signal); });
  };
  const onExit = () => { if (!gone()) child.kill("SIGKILL"); };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, onSignal);
  process.once("exit", onExit);
  try {
    const deadline = Date.now() + (options.startTimeoutMs ?? 30 * 60_000);
    while (!ready && !gone() && Date.now() < deadline) await delay(100);
    await delay(ready ? 0 : 100);
    // A berth that stopped at once may have found its service holding the
    // directory; with a config, whoever answers with its key is it.
    const another = !ready && /another berth vm runs in/.test(stderr);
    const held = another && config !== null;
    if (!ready && !held) {
      result.runnerError = another
        ? `another berth vm runs in ${files.dir} and there is no ${files.configPath} yet, so it cannot be asked: stop that berth vm (a second init-local, or one started by hand), then run init-local again`
        : gone() ? `berth exited (${child.exitCode ?? child.signalCode}): ${lastLines(stderr)}`
          : `berth did not say "waiting for cubed" in time: ${lastLines(stderr)}`;
      return result;
    }
    if (ready && !recorded) {
      // berth runs on this image and listens here: what the service starts
      // it with from now on.
      fs.writeFileSync(files.settings, berthSettingsText(image, maxMachines, listen), { mode: 0o600, flag: "wx" });
      log(`wrote ${files.settings}`);
    }
    if (config) {
      if (serverPeer && serverPeer !== config.config.serverPeer) throw conflict(`${files.configPath} names peer ${config.config.serverPeer}, but the berth in ${files.dir} is ${serverPeer}`);
    } else {
      if (!serverPeer) throw new Error(`berth did not print its peer: ${lastLines(stderr)}`);
      const written = { version: 2, protocol: 4, binding: { nodeId, threadId: nodeId, environmentId: 1 }, controlKey: files.controlKey, serverPeer,
        network: "loopback", address: listen };
      fs.writeFileSync(files.configPath, `${JSON.stringify(written)}\n`, { mode: 0o600, flag: "wx" });
      log(`wrote ${files.configPath}`);
    }
    try {
      result.enrollment = await enrollRunner({ state, configPath: files.configPath });
      log(`enrolled ${nodeId} in ${state}`);
    } catch (error) {
      result.runnerError = `the enrollment failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return result;
  } finally {
    await stopBerth(child, exited);
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, onSignal);
    process.off("exit", onExit);
  }
}

/** As its Ctrl-C would: berth stops its machines' QEMUs and exits; killed
 * after 120 s. */
async function stopBerth(child: ChildProcess, exited: Promise<void>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const forced = setTimeout(() => child.kill("SIGKILL"), 120_000);
  forced.unref();
  await exited;
  clearTimeout(forced);
}

function lastLines(text: string): string {
  const lines = text.trim().split("\n").filter(Boolean);
  const human = lines.filter(line => !line.startsWith("{"));
  return (human.length ? human : lines).slice(-3).join(" | ") || "(no output)";
}
