/**
 * The swappable cube backend (PLAN §8: "backends must stay swappable").
 *
 * The supervisor needs a small, fixed set of operations from the sandbox
 * layer — provision/destroy a cube, read/flip its run state, wait for its
 * network, stand up its egress proxy, and exec inside it. This interface is
 * exactly that surface, so the whole of cubed (server, registry, portals,
 * UI) can run against a simulated backend with no Incus daemon in reach —
 * the tier-1 loop of developing cube inside a cube (PLAN §13 3d.3).
 *
 * `IncusBackend` is the production path: a thin adapter over the existing
 * IncusClient + provision/destroy/proxy functions. `MockBackend` keeps its
 * instances in memory and runs exec locally against the host workspace.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  provisionCube,
  destroyCube,
  waitForCubeNetwork,
  type CubeProvisionSpec,
  type CubeNetworkSpec,
} from "./cube-provision.ts";
import { startEgressProxy, type EgressPolicy, type EgressProxy } from "./egress-proxy.ts";
import { IncusClient, IncusHttpError, type IncusStateAction } from "./incus-client.ts";
import { IncusSandbox, type Sandbox, type SandboxExecOptions } from "./index.ts";
import { removeStoppedTree } from "./stopped-tree.ts";

export type DestroySpec = Pick<CubeProvisionSpec, "name" | "pool"> & {
  network: Pick<CubeNetworkSpec, "bridge">;
};

export interface EgressProxyOptions extends EgressPolicy {
  listenHost: string;
  port: number;
}

/** The complete sandbox surface the supervisor depends on. */
export interface CubeBackend {
  readonly kind: "incus" | "mock";
  /** Create and start a cube (idempotent per resource). */
  provision(spec: CubeProvisionSpec): Promise<void>;
  /** Tear a cube down; keeps the docker volume/bridge unless asked. */
  destroy(spec: DestroySpec, opts?: { deleteVolume?: boolean; deleteBridge?: boolean }): Promise<void>;
  /** Current run state — only `.status` ("Running"/"Stopped") is read. */
  getState(name: string): Promise<{ status: string }>;
  /** Start/stop/etc. */
  setState(name: string, action: IncusStateAction, opts?: { force?: boolean; timeout?: number }): Promise<void>;
  /** Resolve once the cube's eth0 holds `ip` (instant on the mock). */
  waitForNetwork(name: string, ip: string): Promise<void>;
  /** Stand up the per-cube egress proxy (a no-op stub on the mock). */
  startEgressProxy(opts: EgressProxyOptions): Promise<EgressProxy>;
  /** A streaming-exec handle for one cube. */
  sandbox(name: string): Sandbox;
  /** One-shot argv exec as root (systemd/service control). */
  execSimple(name: string, command: string[], signal?: AbortSignal): Promise<number | null>;
  /** Resolve a mutable image name to its immutable Incus fingerprint. */
  resolveImage?(image: string): Promise<string>;
  /** Stop and capture a dedicated setup instance as an immutable image. */
  captureEnvironment?(spec: CubeProvisionSpec, alias: string, journalDirectory?: string): Promise<string>;
  /** Finish/identify a publication left uncertain by a process crash. */
  reconcileEnvironment?(alias: string, journalDirectory: string): Promise<string>;
  /** Delete an environment image by immutable fingerprint. */
  deleteEnvironment?(fingerprint: string): Promise<void>;
}

/** Production backend: real Incus over the local unix socket. */
export class IncusBackend implements CubeBackend {
  readonly kind = "incus" as const;
  private readonly client: IncusClient;
  private readonly stagingTimeoutMs: number;
  private readonly restoreTimeoutMs: number;
  constructor(
    client: IncusClient = new IncusClient(),
    opts: { stagingTimeoutMs?: number; restoreTimeoutMs?: number } = {},
  ) {
    this.client = client;
    this.stagingTimeoutMs = opts.stagingTimeoutMs ?? 10 * 60_000;
    this.restoreTimeoutMs = opts.restoreTimeoutMs ?? 10 * 60_000;
  }

  provision(spec: CubeProvisionSpec) {
    return provisionCube(this.client, spec, this.restoreTimeoutMs);
  }
  destroy(spec: DestroySpec, opts?: { deleteVolume?: boolean; deleteBridge?: boolean }) {
    return destroyCube(this.client, spec, opts);
  }
  getState(name: string) {
    return this.client.getInstanceState(name);
  }
  setState(name: string, action: IncusStateAction, opts?: { force?: boolean; timeout?: number }) {
    return this.client.setInstanceState(name, action, opts);
  }
  waitForNetwork(name: string, ip: string) {
    return waitForCubeNetwork(this.client, name, ip);
  }
  startEgressProxy(opts: EgressProxyOptions) {
    return startEgressProxy(opts);
  }
  sandbox(name: string): Sandbox {
    return new IncusSandbox(name, this.client);
  }
  execSimple(name: string, command: string[], signal?: AbortSignal) {
    return this.client.execSimple(name, command, signal);
  }
  async resolveImage(image: string): Promise<string> {
    return (await this.client.getImageAlias(image)).target;
  }
  async captureEnvironment(spec: CubeProvisionSpec, alias: string, journalDirectory?: string): Promise<string> {
    const abort = new AbortController();
    try {
      // Custom volumes are not part of an Incus image. Quiesce Docker and
      // stage an exact filesystem copy in rootfs; masking guarantees Docker
      // cannot start before provisionCube restores it into the new volume.
      const staging = this.client.execSimple(spec.name, [
        "sh",
        "-c",
        "set -eu; if systemctl is-active --quiet docker.service; then " +
          "docker ps -q | xargs -r docker stop --time 30; fi; " +
          "systemctl stop docker.service docker.socket containerd.service; " +
          "rm -rf /var/lib/cube-environment; mkdir -p /var/lib/cube-environment/docker; " +
          "cp -a --preserve=mode,ownership,timestamps,links,xattr /var/lib/docker/. /var/lib/cube-environment/docker/; " +
          // Numeric IDs in this archive belong to the guest namespace, not
          // the host's current isolated idmap. Extraction stays guest-side.
          "tar --numeric-owner --acls --xattrs --xattrs-include='*' --exclude='./.git' " +
          "-C /workspace -cpf /var/lib/cube-environment/workspace.tar .; " +
          "systemctl mask docker.service docker.socket; " +
          "truncate -s 0 /etc/machine-id; " +
          // Never bake the builder's network identity or proxy policy.
          "rm -f /etc/systemd/network/05-eth0-static.network " +
          "/etc/profile.d/50-cube-proxy.sh /etc/apt/apt.conf.d/50cube-proxy " +
          "/etc/systemd/system/docker.service.d/http-proxy.conf",
      ], abort.signal);
      // An HTTP/guest timeout is not a containment boundary. At the host
      // deadline stop the whole instance; this also kills commands which
      // ignore signals or whose exec HTTP request never settles.
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          abort.abort();
          reject(new Error(`cube ${spec.name}: environment staging deadline exceeded`));
        }, this.stagingTimeoutMs);
        staging.finally(() => clearTimeout(timer)).catch(() => {});
      });
      const rc = await Promise.race([staging, timeout]);
      if (rc !== 0) throw new Error(`cube ${spec.name}: environment staging failed (${rc})`);
    } finally {
      const state = await this.client.getInstanceState(spec.name);
      if (state.status !== "Stopped") {
        await this.client.setInstanceState(spec.name, "stop", { force: true });
      }
    }
    if (!journalDirectory) return this.client.publishInstanceAsImage(spec.name, alias);

    const journal: PublicationJournal = {
      version: 1, alias, instance: spec.name, attempt: randomUUID(), phase: "posting",
    };
    writePublicationJournal(journalDirectory, journal); // before POST
    // On failure the posting/accepted tombstone stays: failure of the POST
    // response is not evidence that Incus did not accept the POST.
    const fingerprint = await this.client.publishTaggedInstanceAsImage(
      spec.name,
      alias,
      { "cube.environment.attempt": journal.attempt, "cube.environment.alias": alias },
      (operation) => writePublicationJournal(journalDirectory, { ...journal, phase: "accepted", operation }),
    );
    writePublicationJournal(journalDirectory, { ...journal, phase: "complete", fingerprint });
    return fingerprint;
  }

  async reconcileEnvironment(alias: string, journalDirectory: string): Promise<string> {
    const journal = readPublicationJournal(journalDirectory);
    if (journal.alias !== alias) throw new Error(`environment journal alias mismatch: ${journal.alias}`);
    if (journal.fingerprint) return journal.fingerprint;

    if (journal.operation) {
      const operation = await this.client.getOperation(journal.operation).catch((error) => {
        if (error instanceof IncusHttpError && error.errorCode === 404) return undefined;
        throw error;
      });
      if (operation && operation.status_code < 200) throw new Error(`environment publication pending for ${alias}`);
    } else {
      // Never wait for image creation during daemon startup. Keep the marker
      // and retry reconciliation on the next use/boot after work settles.
      const operations = await this.client.listOperations();
      const relevant = operations.filter((op) =>
        op.status_code < 200 &&
        (op.description?.toLowerCase().includes("image") || (op.resources?.images?.length ?? 0) > 0),
      );
      if (relevant.length) throw new Error(`environment publication pending for ${alias}`);
    }
    const matches = (await this.client.listImages()).filter(
      (image) => image.properties?.["cube.environment.attempt"] === journal.attempt,
    );
    if (matches.length !== 1) {
      throw new Error(`environment publication unresolved for ${alias} (${matches.length} tagged images)`);
    }
    const image = matches[0]!;
    const current = await this.client.getImageAlias(alias).catch((error) => {
      if (error instanceof IncusHttpError && error.errorCode === 404) return undefined;
      throw error;
    });
    if (current && current.target !== image.fingerprint) {
      throw new Error(`environment alias ${alias} points at a different image`);
    }
    if (!current) await this.client.createImageAlias(alias, image.fingerprint);
    writePublicationJournal(journalDirectory, { ...journal, phase: "complete", fingerprint: image.fingerprint });
    return image.fingerprint;
  }
  async deleteEnvironment(fingerprint: string): Promise<void> {
    try { await this.client.deleteImage(fingerprint); }
    catch (error) { if (!(error instanceof IncusHttpError && error.errorCode === 404)) throw error; }
  }
}

interface PublicationJournal {
  version: 1;
  alias: string;
  instance: string;
  attempt: string;
  phase: "posting" | "accepted" | "complete";
  operation?: string;
  fingerprint?: string;
}

const publicationJournalPath = (directory: string) => `${directory}/publication.json`;

function writePublicationJournal(directory: string, journal: PublicationJournal): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = publicationJournalPath(directory);
  const temporary = `${target}.tmp`;
  const fd = fs.openSync(temporary, "w", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(journal) + "\n");
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, target);
  const dir = fs.openSync(directory, "r");
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

function readPublicationJournal(directory: string): PublicationJournal {
  return JSON.parse(fs.readFileSync(publicationJournalPath(directory), "utf8")) as PublicationJournal;
}

interface MockInstance {
  status: "Running" | "Stopped";
  /** Host path the guest `/workspace` maps to, so exec runs against real files. */
  hostWorkspace?: string;
  guestWorkspace?: string;
  hostRepositories?: string;
  guestRepositories?: string;
}

/**
 * In-memory backend for CUBED_BACKEND=mock. Instances are a Map; network
 * readiness is instant; the egress proxy is a no-op. exec/execSimple run
 * LOCALLY (the surrounding dev cube is the "guest") with the guest
 * workspace path rebased onto the real host workspace, so `.cube/setup`,
 * wake hooks, and service control actually touch the workspace files.
 *
 * SECURITY: there is NO isolation here — a cube command (a repo-provided
 * `.cube/setup`, an agent-written hook) runs with cubed's own uid, filesystem,
 * and network. That is acceptable ONLY because this mode is meant to run
 * INSIDE a real cube (the tier-1 dev loop): the OUTER cube is the sandbox.
 * Running `CUBED_BACKEND=mock` on a bare host with an untrusted repo attached
 * executes that repo's setup on the host — index.ts prints a loud banner.
 *
 * `execSimple` (service control) is NOT root and there is no per-cube systemd,
 * so systemd-based service starts are best-effort; the portal registry/proxy
 * logic still exercises. Instance state is process-lifetime (a cubed restart
 * forgets the Map — waking a stale cube then fails loudly rather than running
 * its hooks in the wrong directory).
 */
export class MockBackend implements CubeBackend {
  readonly kind = "mock" as const;
  private readonly instances = new Map<string, MockInstance>();
  private readonly environments = new Map<string, { workspace: string; ownedRoot?: string }>();

  async provision(spec: CubeProvisionSpec): Promise<void> {
    fs.mkdirSync(spec.hostWorkspace, { recursive: true });
    if (spec.hostRepositories) fs.mkdirSync(spec.hostRepositories, { recursive: true });
    if (spec.restoreWorkspace && spec.imageFingerprint) {
      const environment = this.environments.get(spec.imageFingerprint);
      if (!environment) throw new Error(`mock backend: environment ${spec.imageFingerprint} does not exist`);
      clearWorkspaceExceptGit(spec.hostWorkspace);
      copyWorkspaceExceptGit(environment.workspace, spec.hostWorkspace);
    }
    this.instances.set(spec.name, {
      status: "Running",
      hostWorkspace: spec.hostWorkspace,
      guestWorkspace: spec.guestWorkspace,
      hostRepositories: spec.hostRepositories,
      guestRepositories: spec.guestRepositories,
    });
  }

  async destroy(spec: DestroySpec): Promise<void> {
    // Parity with Incus: the workspace is host-side and outlives the cube.
    this.instances.delete(spec.name);
  }

  async getState(name: string): Promise<{ status: string }> {
    return { status: this.instances.get(name)?.status ?? "Stopped" };
  }

  async setState(name: string, action: IncusStateAction): Promise<void> {
    const inst: MockInstance = this.instances.get(name) ?? { status: "Stopped" };
    inst.status = action === "stop" ? "Stopped" : "Running";
    this.instances.set(name, inst);
  }

  async waitForNetwork(_name: string, _ip: string): Promise<void> {
    // The mock network is up the instant the instance is.
  }

  async startEgressProxy(opts: EgressProxyOptions): Promise<EgressProxy> {
    // No real cube network to bind a proxy on; the shape is all callers need.
    return { port: opts.port, close: async () => {} };
  }

  sandbox(name: string): Sandbox {
    const inst = this.instances.get(name);
    return new MockSandbox(
      name,
      inst?.guestWorkspace,
      inst?.hostWorkspace,
      inst?.guestRepositories,
      inst?.hostRepositories,
    );
  }

  async execSimple(name: string, command: string[], signal?: AbortSignal): Promise<number | null> {
    // Service control (systemctl/systemd-run) is cwd-independent argv; run it
    // in the workspace when known, else a neutral tmp dir — never the server
    // repo, which `process.cwd()` would be.
    const inst = this.instances.get(name);
    return runLocal(command[0], command.slice(1), inst?.hostWorkspace ?? os.tmpdir(), { signal });
  }

  async resolveImage(image: string): Promise<string> {
    return `mock-image:${image}`;
  }

  async captureEnvironment(spec: CubeProvisionSpec, alias: string, journalDirectory?: string): Promise<string> {
    const instance = this.instances.get(spec.name);
    if (!instance) throw new Error(`mock backend: cube ${spec.name} does not exist`);
    instance.status = "Stopped";
    const ownedRoot = journalDirectory ? undefined : fs.mkdtempSync(path.join(os.tmpdir(), "cube-mock-environment-"));
    const workspace = path.join(journalDirectory ?? ownedRoot!, "workspace");
    removeStoppedTree(workspace);
    fs.mkdirSync(workspace, { recursive: true });
    copyWorkspaceExceptGit(spec.hostWorkspace, workspace);
    const fingerprint = `mock-environment:${alias}:${randomUUID()}`;
    this.environments.set(fingerprint, { workspace, ownedRoot });
    return fingerprint;
  }

  async deleteEnvironment(fingerprint: string): Promise<void> {
    const environment = this.environments.get(fingerprint);
    if (!environment) return;
    // Never remove a caller-owned journal directory, only the snapshot entry.
    removeStoppedTree(environment.ownedRoot ?? environment.workspace);
    this.environments.delete(fingerprint);
  }
}

function clearWorkspaceExceptGit(workspace: string): void {
  for (const entry of fs.readdirSync(workspace)) {
    if (entry !== ".git") removeStoppedTree(path.join(workspace, entry));
  }
}

/** Mock fidelity is intentionally limited to mode/timestamps/link shape; it
 * runs unisolated as the current uid and does not claim ownership/xattr parity. */
function copyWorkspaceExceptGit(source: string, destination: string): void {
  for (const entry of fs.readdirSync(source)) {
    if (entry === ".git") continue;
    copyMockEntry(path.join(source, entry), path.join(destination, entry));
  }
}

function copyMockEntry(source: string, destination: string): void {
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), destination);
  } else if (stat.isDirectory()) {
    fs.mkdirSync(destination, { mode: 0o700 });
    for (const entry of fs.readdirSync(source)) {
      copyMockEntry(path.join(source, entry), path.join(destination, entry));
    }
    fs.chmodSync(destination, stat.mode);
    fs.utimesSync(destination, stat.atime, stat.mtime);
  } else if (stat.isFile()) {
    fs.copyFileSync(source, destination);
    fs.chmodSync(destination, stat.mode);
    fs.utimesSync(destination, stat.atime, stat.mtime);
  } else {
    throw new Error(`mock environment: unsupported special file ${source}`);
  }
}

/**
 * Rebase a guest path onto the host workspace. THROWS when the cube has no
 * mapping (an un-provisioned cube — e.g. a mock cube woken after a cubed
 * restart): running the hook in `process.cwd()`
 * (the server repo) instead is a silent-wrong that sol flagged. Mock instance
 * state is process-lifetime; a loud failure is the safe outcome.
 */
function hostCwd(
  cwd: string,
  guestWorkspace?: string,
  hostWorkspace?: string,
  guestRepositories?: string,
  hostRepositories?: string,
): string {
  if (!hostWorkspace) {
    throw new Error(
      "mock backend: this cube has no workspace mapping — provision it in this process " +
        "(mock instance state does not survive a cubed restart)",
    );
  }
  if (guestWorkspace) {
    if (cwd === guestWorkspace) return hostWorkspace;
    if (cwd.startsWith(guestWorkspace + "/")) return hostWorkspace + cwd.slice(guestWorkspace.length);
  }
  if (guestRepositories && hostRepositories) {
    if (cwd === guestRepositories) return hostRepositories;
    if (cwd.startsWith(guestRepositories + "/")) {
      return hostRepositories + cwd.slice(guestRepositories.length);
    }
  }
  return hostWorkspace;
}

/**
 * Streaming exec that runs the command on the local host. Exported for
 * separate mock consumers (notably the pi extension process), which cannot
 * share MockBackend's in-memory instance map with cubed.
 *
 * SECURITY: this is deliberately NOT isolated; callers must select it only
 * when the surrounding machine is itself the disposable development sandbox.
 */
export class MockSandbox implements Sandbox {
  readonly name: string;
  private readonly guestWorkspace?: string;
  private readonly hostWorkspace?: string;
  private readonly guestRepositories?: string;
  private readonly hostRepositories?: string;
  constructor(
    name: string,
    guestWorkspace?: string,
    hostWorkspace?: string,
    guestRepositories?: string,
    hostRepositories?: string,
  ) {
    this.name = name;
    this.guestWorkspace = guestWorkspace;
    this.hostWorkspace = hostWorkspace;
    this.guestRepositories = guestRepositories;
    this.hostRepositories = hostRepositories;
  }

  async exec(command: string, { cwd, onData, signal, timeout }: SandboxExecOptions) {
    const dir = hostCwd(
      cwd,
      this.guestWorkspace,
      this.hostWorkspace,
      this.guestRepositories,
      this.hostRepositories,
    );
    // `bash -lc`, not `sh -c`: the Incus path runs `su - dev -c` (a bash login
    // shell), so a hook using `[[ … ]]`, `source`, or `set -o pipefail` must
    // behave the same here — otherwise the mock gives a false dev signal.
    const exitCode = await runLocal("bash", ["-lc", command], dir, { onData, signal, timeout });
    return { exitCode };
  }
}

function runLocal(
  file: string,
  args: string[],
  cwd: string,
  opts: { onData?: (c: Buffer) => void; signal?: AbortSignal; timeout?: number } = {},
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      // `detached` makes the child its own process-group leader, so a timeout
      // or abort can signal the WHOLE tree (`process.kill(-pid, …)`), not just
      // the immediate shell — a `sleep` a hook backgrounded must die too.
      child = spawn(file, args, { cwd, env: { PATH: process.env.PATH, TERM: "dumb" }, detached: true });
    } catch (error) {
      return reject(error);
    }
    const pid = child.pid;
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const killGroup = (signal: NodeJS.Signals) => {
      if (pid === undefined) return;
      try {
        process.kill(-pid, signal);
      } catch {
        // group already gone
      }
    };
    // TERM the tree, then KILL after a grace period — a `trap '' TERM` hook
    // would otherwise ignore the TERM and the promise would never settle
    // (the old code sent one TERM and resolved on `close`, which never came).
    const terminate = () => {
      killGroup("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => killGroup("SIGKILL"), 5000);
        killTimer.unref();
      }
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => terminate();
    const timer =
      opts.timeout && opts.timeout > 0
        ? setTimeout(() => {
            timedOut = true;
            terminate();
          }, opts.timeout * 1000)
        : undefined;
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout?.on("data", (c: Buffer) => opts.onData?.(c));
    child.stderr?.on("data", (c: Buffer) => opts.onData?.(c));
    // ENOENT (missing binary in the dev cube) reads as a failed exec, not a throw.
    child.on("error", () => finish(() => resolve(null)));
    // Settle only once the tree has actually exited (like the Incus path,
    // which awaits the operation): abort/timeout rejected here, not before, so
    // a signal-ignoring child cannot leave the promise hanging or the tree live.
    child.on("close", (code) =>
      finish(() => {
        if (opts.signal?.aborted) return reject(new Error("aborted"));
        if (timedOut) return reject(new Error(`timeout:${opts.timeout}`));
        resolve(code);
      }),
    );
  });
}
