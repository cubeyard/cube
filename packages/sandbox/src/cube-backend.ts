/**
 * The swappable cube backend (ARCHITECTURE §8: "backends must stay swappable").
 *
 * The supervisor needs a small, fixed set of operations from the sandbox
 * layer — provision/destroy a cube, read/flip its run state, wait for its
 * network, stand up its egress proxy, and exec inside it. This interface is
 * exactly that surface, so the whole of cubed (server, registry, portals,
 * UI) can run against a simulated backend with no Incus daemon in reach —
 * the tier-1 loop of developing cube inside a cube (ARCHITECTURE §13 3d.3).
 *
 * `IncusBackend` is the production path: a thin adapter over the existing
 * IncusClient + provision/destroy/proxy functions. `MockBackend` keeps its
 * instances in memory and runs exec locally against the host workspace.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  provisionCube,
  destroyCube,
  waitForCubeNetwork,
  type CubeProvisionSpec,
  type CubeNetworkSpec,
  type CubeTemplateSource,
  type DestroyOptions,
  type ProvisionOptions,
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

/** Options of `CubeBackend.setState`: Incus's graceful `timeout` (seconds,
 * default 30) plus the client deadline `timeoutMs` and a cancel signal. */
export interface SetStateOptions {
  force?: boolean;
  timeout?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WaitForNetworkOptions {
  signal?: AbortSignal;
  /** Default 30 s. */
  timeoutMs?: number;
}

/** Cancel/deadline options of the template calls. */
export interface TemplateOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** The complete sandbox surface the supervisor depends on. Every method
 * that waits on Incus is bounded by a deadline and accepts an optional
 * AbortSignal; a rejected wait carries the signal's reason or an
 * `IncusTimeoutError`. */
export interface CubeBackend {
  readonly kind: "incus" | "mock";
  /** Create and start a cube (idempotent per resource). */
  provision(spec: CubeProvisionSpec, opts?: ProvisionOptions): Promise<void>;
  /** Tear a cube down; keeps the docker volume/bridge unless asked. */
  destroy(spec: DestroySpec, opts?: DestroyOptions): Promise<void>;
  /** Current run state — only `.status` ("Running"/"Stopped") is read. */
  getState(name: string): Promise<{ status: string }>;
  /** Start/stop/etc. */
  setState(name: string, action: IncusStateAction, opts?: SetStateOptions): Promise<void>;
  /** Resolve once the cube's eth0 holds `ip` (instant on the mock). */
  waitForNetwork(name: string, ip: string, opts?: WaitForNetworkOptions): Promise<void>;
  /** Stand up the per-cube egress proxy (a no-op stub on the mock). */
  startEgressProxy(opts: EgressProxyOptions): Promise<EgressProxy>;
  /** A streaming-exec handle for one cube. */
  sandbox(name: string): Sandbox;
  /** One-shot argv exec as root (systemd/service control). */
  execSimple(name: string, command: string[], signal?: AbortSignal, opts?: { timeoutMs?: number }): Promise<number | null>;
  /** Resolve a mutable image name to its immutable Incus fingerprint. */
  resolveImage(image: string): Promise<string>;
  /** Turn a builder into an environment template: stop it, strip every
   * device but root, and snapshot its rootfs and docker volume so threads
   * can be cloned from them. The builder's bridge is released. */
  captureTemplate(spec: CubeProvisionSpec, snapshot: string, opts?: TemplateOptions): Promise<CubeTemplateSource>;
  /** Delete a template's instance and docker volume; clones live on. */
  deleteTemplate(pool: string, template: CubeTemplateSource, opts?: TemplateOptions): Promise<void>;
}

export interface IncusBackendOptions {
  /** Deadline per rollback step after a failed provision. Default 60 s. */
  rollbackTimeoutMs?: number;
}

/** Production backend: real Incus over the local unix socket. */
export class IncusBackend implements CubeBackend {
  readonly kind = "incus" as const;
  private readonly client: IncusClient;
  private readonly rollbackTimeoutMs?: number;
  constructor(client: IncusClient = new IncusClient(), opts: IncusBackendOptions = {}) {
    this.client = client;
    this.rollbackTimeoutMs = opts.rollbackTimeoutMs;
  }

  provision(spec: CubeProvisionSpec, opts: ProvisionOptions = {}) {
    return provisionCube(this.client, spec, { rollbackTimeoutMs: this.rollbackTimeoutMs, ...opts });
  }
  destroy(spec: DestroySpec, opts?: DestroyOptions) {
    return destroyCube(this.client, spec, opts);
  }
  getState(name: string) {
    return this.client.getInstanceState(name);
  }
  setState(name: string, action: IncusStateAction, opts: SetStateOptions = {}) {
    const { signal, ...rest } = opts;
    return this.client.setInstanceState(name, action, rest, signal);
  }
  waitForNetwork(name: string, ip: string, opts: WaitForNetworkOptions = {}) {
    return waitForCubeNetwork(this.client, name, ip, opts.timeoutMs, opts.signal);
  }
  startEgressProxy(opts: EgressProxyOptions) {
    return startEgressProxy(opts);
  }
  sandbox(name: string): Sandbox {
    return new IncusSandbox(name, this.client);
  }
  execSimple(name: string, command: string[], signal?: AbortSignal, opts?: { timeoutMs?: number }) {
    return this.client.execSimple(name, command, signal, opts);
  }
  async resolveImage(image: string): Promise<string> {
    return (await this.client.getImageAlias(image)).target;
  }
  /**
   * Stage, stop and publish. The staging exec is bounded by
   * `stagingTimeoutMs` on the host; the publication by `publishTimeoutMs`.
   * A publication that runs past its deadline (or is aborted) is NOT
   * cancelled — Incus cannot — and nothing ambiguous is deleted: the
   * journal keeps the accepted operation URL and `reconcileEnvironment`
   * settles it later. The error is an `IncusTimeoutError` of kind
   * "publish" (or the signal's reason).
   */
  async captureTemplate(spec: CubeProvisionSpec, snapshot: string, opts: TemplateOptions = {}): Promise<CubeTemplateSource> {
    const { signal } = opts;
    const state = await this.client.getInstanceState(spec.name, signal);
    if (state.status !== "Stopped") {
      await this.client.setInstanceState(spec.name, "stop", { force: true, timeoutMs: opts.timeoutMs }, signal);
    }
    // A copy inherits the snapshot's devices under the request's own: the
    // builder's nic, workspace, repositories and volume must not ride into
    // clones (their sources are about to disappear). Root stays, and every
    // clone request re-declares it anyway.
    await this.client.updateInstance(spec.name, (instance) => {
      for (const device of Object.keys(instance.devices)) {
        if (device !== "root") delete instance.devices[device];
      }
    }, { signal, timeoutMs: opts.timeoutMs });
    // Every clone gets a machine identity of its own on first boot.
    await this.client.pushInstanceFile(spec.name, "/etc/machine-id", "", { signal });
    await this.client.createInstanceSnapshot(spec.name, snapshot, { signal, timeoutMs: opts.timeoutMs });
    const volume = dockerVolumeName(spec.name);
    await this.client.createCustomVolumeSnapshot(spec.pool, volume, snapshot, { signal, timeoutMs: opts.timeoutMs });
    // The nic is gone, so the bridge (and its dnsmasq) can go too.
    if (await exists(() => this.client.getNetwork(spec.network.bridge, signal))) {
      await this.client.deleteNetwork(spec.network.bridge, signal);
    }
    return { instance: spec.name, snapshot, volume, volumeSnapshot: snapshot };
  }

  async deleteTemplate(pool: string, template: CubeTemplateSource, opts: TemplateOptions = {}): Promise<void> {
    const { signal } = opts;
    if (await exists(() => this.client.getInstance(template.instance, signal))) {
      const state = await this.client.getInstanceState(template.instance, signal);
      if (state.status !== "Stopped") {
        await this.client.setInstanceState(template.instance, "stop", { force: true, timeoutMs: opts.timeoutMs }, signal);
      }
      await this.client.deleteInstance(template.instance, { signal, timeoutMs: opts.timeoutMs });
    }
    if (await exists(() => this.client.getCustomVolume(pool, template.volume, signal))) {
      await this.client.deleteCustomVolume(pool, template.volume, signal);
    }
  }
}

const dockerVolumeName = (cube: string) => `${cube}-docker`;

async function exists(probe: () => Promise<unknown>): Promise<boolean> {
  try {
    await probe();
    return true;
  } catch (error) {
    if (error instanceof IncusHttpError && error.errorCode === 404) return false;
    throw error;
  }
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
  /** Captured templates by instance name. The mock has no rootfs to clone;
   * a template is bookkeeping, and a clone is an ordinary instance. */
  readonly templates = new Map<string, CubeTemplateSource>();
  /** Every provision that cloned from a template, for tests. */
  readonly clones: Array<{ name: string; template: string }> = [];

  async provision(spec: CubeProvisionSpec, opts: ProvisionOptions = {}): Promise<void> {
    opts.signal?.throwIfAborted();
    fs.mkdirSync(spec.hostWorkspace, { recursive: true });
    if (spec.hostRepositories) fs.mkdirSync(spec.hostRepositories, { recursive: true });
    if (spec.template) {
      if (!this.templates.has(spec.template.instance)) {
        throw new Error(`mock backend: template ${spec.template.instance} does not exist`);
      }
      this.clones.push({ name: spec.name, template: spec.template.instance });
    }
    this.instances.set(spec.name, {
      status: "Running",
      hostWorkspace: spec.hostWorkspace,
      guestWorkspace: spec.guestWorkspace,
      hostRepositories: spec.hostRepositories,
      guestRepositories: spec.guestRepositories,
    });
  }

  async destroy(spec: DestroySpec, opts: DestroyOptions = {}): Promise<void> {
    opts.signal?.throwIfAborted();
    // Parity with Incus: the workspace is host-side and outlives the cube.
    this.instances.delete(spec.name);
  }

  async getState(name: string): Promise<{ status: string }> {
    return { status: this.instances.get(name)?.status ?? "Stopped" };
  }

  async setState(name: string, action: IncusStateAction, opts: SetStateOptions = {}): Promise<void> {
    opts.signal?.throwIfAborted();
    const inst: MockInstance = this.instances.get(name) ?? { status: "Stopped" };
    inst.status = action === "stop" ? "Stopped" : "Running";
    this.instances.set(name, inst);
  }

  async waitForNetwork(_name: string, _ip: string, opts: WaitForNetworkOptions = {}): Promise<void> {
    opts.signal?.throwIfAborted();
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

  async captureTemplate(spec: CubeProvisionSpec, snapshot: string, opts: TemplateOptions = {}): Promise<CubeTemplateSource> {
    opts.signal?.throwIfAborted();
    const instance = this.instances.get(spec.name);
    if (!instance) throw new Error(`mock backend: cube ${spec.name} does not exist`);
    instance.status = "Stopped";
    const template = { instance: spec.name, snapshot, volume: `${spec.name}-docker`, volumeSnapshot: snapshot };
    this.templates.set(spec.name, template);
    return template;
  }

  async deleteTemplate(_pool: string, template: CubeTemplateSource, opts: TemplateOptions = {}): Promise<void> {
    opts.signal?.throwIfAborted();
    this.templates.delete(template.instance);
    this.instances.delete(template.instance);
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
