/**
 * CubeSupervisor — Phase 2 slices 2+3. Owns WHICH cubes exist and their live
 * runtime state: provisioning via the registry (subnet allocation) +
 * provisionCube, one egress proxy per cube on <gateway>:3128 (pinned to the
 * cube's IP), per-cube threads (each backed by one pi session file), and the
 * sleep/wake lifecycle (idle cubes are `incus stop`ped; a prompt wakes them —
 * gated on waitForCubeNetwork, never on status:Running alone).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { GitService, PrReviewService, describeRepoAuthFailure, normalizeRepoUrl, type RepoDiff, type RepoState } from "@cube/git";
import {
  removeStoppedTree,
  type CubeBackend,
  type CubeProvisionSpec,
  type EgressProxy,
  type CubeTemplateSource,
} from "@cube/sandbox";

import { parseCubeToml, readCubeConfig, readWakeHooks } from "./cube-toml.ts";
import { EnvironmentTemplates, environmentKey } from "./environment-templates.ts";
import { Lifecycle, type LifecyclePhase, type LifecycleResult } from "./lifecycle.ts";
import { Span, describeError, recordPoint } from "./events.ts";
import { describeThreadError } from "./user-facing.ts";
import { readGithub } from "./github-read.ts";
import { ensureServices, portalLabelFor, type ServiceStatus } from "./services.ts";
import {
  Registry,
  networkForCube,
  type CubeRepositoryRow,
  type CubeRow,
  type ProjectRepositoryRow,
  type ProjectRow,
  type ThreadRow,
} from "./registry.ts";

export const EGRESS_PROXY_PORT = 3128;

/** Events older than this are pruned (at boot and hourly). */
const EVENT_RETENTION_MS = 30 * 24 * 3_600_000;
const EVENT_PRUNE_EVERY_MS = 3_600_000;
/** How often the sweep retries environment cleanups boot left pending. */
const ENVIRONMENT_MAINTENANCE_MS = 10 * 60_000;
/** Builder cleanups attempted per maintenance pass, and the deadline of
 * each Incus call a cleanup makes — one stalled request costs one
 * deadline, never the pass or a thread's provisioning. */
const MAINTENANCE_BATCH = 5;
const MAINTENANCE_CALL_TIMEOUT_MS = 60_000;
/** How long a thread-creation idempotency key answers with the same thread,
 * and how many keys are remembered at most (oldest evicted first). */
const CREATE_REQUEST_TTL_MS = 10 * 60_000;
const CREATE_REQUEST_CAP = 1000;
/** Egress allow/deny decisions are aggregated per (cube, decision, kind,
 * host) over this window before landing as one event each — an `npm
 * install` must not write a row per CONNECT. */
const EGRESS_FLUSH_MS = 60_000;
/** Distinct hosts remembered per cube per window. A cube that sprays
 * hostnames (it controls its own DNS queries) rolls past this into one
 * `…and N more` bucket instead of growing host memory or the event table. */
const EGRESS_HOSTS_PER_CUBE = 200;
const EGRESS_HOST_MAX_LEN = 253;

// What the pty bridge spawns per attached thread (Phase 3d step 2). The
// pnpm bin shim is the same one `pnpm vm`'s dev.sh execs; the extension
// entry must be a path (its guard compares tool sourceInfo paths against
// the package dir). `--no-extensions` is LOAD-BEARING security, not tidy-up:
// it keeps a hostile workspace `.pi/extensions` (and any earlier-loading
// extension's `user_bash` handler) from executing on the credentialed host
// — see packages/pi-extension/src/index.ts. `--no-approve` matches the
// harness's projectTrusted:false stance for the same reason.
const PI_BIN = path.resolve(import.meta.dirname, "../node_modules/.bin/pi");
const PI_EXTENSION = path.resolve(import.meta.dirname, "../../pi-extension/src/index.ts");

/** How much of a session file's head autoTitle reads looking for the first
 * user message (the title source). Generous for prose, bounded against a
 * multi-megabyte pasted image. */
const AUTO_TITLE_SCAN_BYTES = 256 * 1024;

/** Built-in package-manager allowlist. Extended by CUBED_EGRESS_ALLOW
 * (index.ts) and, per cube, by `[network] allow` in the environment's
 * cube.toml (startProxy). */
export const DEFAULT_EGRESS_ALLOW = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "archive.ubuntu.com",
  "security.ubuntu.com",
  "ports.ubuntu.com", // the arm64 mirror (apt on an arm64 VM goes nowhere else)
  "download.docker.com", // the image's own docker-ce apt source: every apt-get update asks it
  // inner docker pulls (dockerd honors the proxy drop-in): manifests from
  // the registry, blobs via a 307 to the CDN — cloudfront as of 2026-09,
  // cloudflare kept for the period Hub used it.
  "registry-1.docker.io",
  "auth.docker.io",
  "production.cloudfront.docker.com",
  "production.cloudflare.docker.com",
];

export interface SupervisorConfig {
  /** Per-cube host state root: <cubesRoot>/<name>/{workspace,sessions}. */
  cubesRoot: string;
  /** Bare-mirror root for checked project repositories (ARCHITECTURE §11):
   * <reposRoot>/<repo>-<hash>.git. */
  reposRoot: string;
  pool: string;
  image: string;
  rootSize: string;
  dockerVolumeSize: string;
  egressAllow: string[];
  /** Administrator-selected PEM roots, fixed for the daemon's lifetime. */
  caCertificates?: string;
  /** Prepared environments: threads are cloned from a per-project template
   * that ran setup once (default on; false = every thread sets up fresh). */
  environmentCache?: boolean;
  /** Memory cap per thread (Incus `limits.memory`, e.g. "4GiB"); unset = none. */
  cubeMemory?: string;
  /** Idle-to-sleep timeout in ms off last_active_at (PLAN: default 1h).
   * <= 0 disables the idle sweep entirely. */
  idleMs: number;
  /** Portal hostname base (ARCHITECTURE §10): portals live at
   * `<service>--<cube>.<portalBase>`, routed on the Host header. */
  portalBase: string;
  /** Port portal URLs carry (cubed's public listener; 80 = portless). */
  publicPort: number;
  /** VM-host GitHub CLI credential. Optional: tests and the mock backend
   * run without it; absent means no status check and raw auth errors
   * only get the generic connect-github copy. */
  github?: {
    ensureFresh(): Promise<void>;
    status(): { state: string };
    gitIdentity?(): { name: string; email: string } | null;
  };
}

interface CubeRuntime {
  name: string;
  proxy: EgressProxy | null;
  /** The allowlist `proxy` was started with; a changed declaration
   * (`[network] allow` edited between wakes) replaces the proxy. */
  egressAllow: string[] | null;
}

export interface CubeSummary {
  name: string;
  status: string;
  error: string | null;
  ip: string | null;
  threadCount: number;
  createdAt: number | null;
  lastActiveAt: number | null;
}

/** One entry of the user-facing thread list. Cube vocabulary must not
 * leak: states are thread states, the backing cube is not named. */
export interface UserThreadSummary {
  id: string;
  title: string | null;
  /** `waking` is the routine return path (opening a sleeping thread) and
   * reads as a calm wait, never as green-but-unresponsive. */
  state: "setting-up" | "ready" | "sleeping" | "waking" | "error";
  error: string | null;
  createdAt: number | null;
  archived: boolean;
  project: { id: string; name: string };
}

export interface ProjectRepositoryInput {
  url: string;
  base?: string | null;
  checkoutName?: string;
}

export interface ProjectInput {
  name: string;
  repositories: ProjectRepositoryInput[];
  /** "<checkout>/<folder>" of a reference repository whose folder carries
   * the .cube directory (setup, resume, cube.toml) — for a primary
   * repository that does not ship one. Empty/null: the primary's own. */
  environment?: string | null;
}

export interface ProjectInfo extends ProjectRow {
  repositories: ProjectRepositoryRow[];
  threadCount: number;
}

export interface ThreadRepositoryInfo {
  id: number;
  role: "primary" | "additional";
  checkoutName: string;
  path: string;
  url: string;
  base: string;
  branch: string;
  state: RepoState | null;
}

/** What the HTTP layer needs to route one portal request. */
export interface PortalTargetInfo {
  cubeName: string;
  serviceName: string;
  status: string;
  ip: string;
  port: number;
}

const instanceName = (cube: string) => `cube-${cube}`;

/**
 * Where a cube's environment directory (.cube: setup, resume, cube.toml)
 * lives. Default: inside the primary checkout. With a project environment
 * of "<checkout>/<folder>" it is that folder of a reference repository — a
 * way to keep the environment for a repository that does not ship one,
 * outside that repository. The guest path is relative to /workspace:
 * /workspace and /repos are siblings in a cube exactly as <cube>/workspace
 * and <cube>/repos are on the host, so one string resolves in Incus and in
 * the mock alike. References are mounted read-only, so a declared
 * environment is the user's, not the agent's, to change.
 */
function environmentDirs(cube: Pick<CubeRow, "workspacePath" | "environment">): {
  host: string; guest: string; guestAbsolute: string;
} {
  if (!cube.environment) {
    return { host: path.join(cube.workspacePath, ".cube"), guest: ".cube", guestAbsolute: "/workspace/.cube" };
  }
  const segments = cube.environment.split("/");
  return {
    host: path.join(path.dirname(cube.workspacePath), "repos", ...segments, ".cube"),
    guest: path.posix.join("..", "repos", ...segments, ".cube"),
    guestAbsolute: path.posix.join("/repos", ...segments, ".cube"),
  };
}

/** Recorded on the provision span and the lifecycle result when a thread
 * is deleted while still setting up. */
const PROVISION_CANCELLED = "cancelled: thread deleted";

/** Settle `work`, or reject with the signal's reason the moment it fires.
 * For awaiting shared work (an environment build another thread may also
 * be waiting on) that one caller leaving must not cancel: the work runs
 * on and its eventual outcome is discarded. */
function abortable<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      work.catch(() => {});
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Cube status -> user-visible thread state. "waking" reads as ready — the
 * wake is transparent (a prompt just takes a moment longer). */
function threadState(cubeStatus: string): UserThreadSummary["state"] {
  if (cubeStatus === "creating") return "setting-up";
  if (cubeStatus === "asleep") return "sleeping";
  if (cubeStatus === "waking") return "waking";
  if (cubeStatus === "error") return "error";
  return "ready";
}

export class CubeSupervisor {
  private readonly registry: Registry;
  private readonly backend: CubeBackend;
  private readonly config: SupervisorConfig;
  private readonly git: GitService;
  private readonly prReviews: PrReviewService;
  private readonly lifecycle: Lifecycle;
  private readonly templates: EnvironmentTemplates | null;
  private readonly runtimes = new Map<string, CubeRuntime>();
  // In-flight sleep/wake per cube. Status flips ("asleep"/"waking") happen
  // synchronously before the incus work, so concurrent callers observe the
  // transition and await this promise instead of racing a second stop/start.
  private readonly transitions = new Map<string, Promise<void>>();
  // The provisioning (or setup-retry) transition per cube, cancellable: a
  // thread deleted while its .cube/setup runs aborts the guest script and
  // the remaining stages instead of refusing until they finish. Builders
  // (`buildEnvironment`) are never registered here — they have no thread.
  private readonly provisioning = new Map<string, AbortController>();
  // Cubes mid-removeCube: sleep/wake/second-DELETE must not race the
  // teardown's awaits (destroy would pull the instance out from under a
  // concurrent `incus start`).
  private readonly removing = new Set<string>();
  // In-flight service ensures per cube: a portal hit and a services_ensure
  // tool call racing each other must not double systemd-run a unit.
  private readonly ensuring = new Map<
    string,
    {
      promise: Promise<ServiceStatus[]>;
      controller: AbortController;
      waiters: number;
      settled: boolean;
    }
  >();
  // Outcome of each cube's most recent settled ensure: the portal holding
  // page explains a service that failed to start instead of "starting…"
  // forever (in-memory — the next ensure overwrites it).
  private readonly lastEnsure = new Map<string, { statuses: ServiceStatus[]; error: string | null }>();
  // In-flight host-side git ops (diff/push/PR) per cube: removeCube must not
  // tear a cube down while a push/PR is still publishing (ARCHITECTURE §11).
  private readonly gitOps = new Map<string, number>();
  // Project checks are serialized per project. A manual re-check or edit
  // queues behind the current network operation instead of racing status.
  private readonly projectChecks = new Map<string, Promise<void>>();
  // Session FILES whose head can never yield an auto-title (see autoTitle)
  // — remembered so the thread-list poll stops re-reading them.
  private readonly untitlable = new Set<string>();
  private sweepTimer: NodeJS.Timeout | null = null;
  // Pending egress counters, flushed as aggregated events (see EGRESS_FLUSH_MS).
  private readonly egress = new Map<string, { cube: string; decision: "allow" | "deny"; kind: string; host: string; n: number }>();
  private readonly egressHostsPerCube = new Map<string, number>();
  private egressTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  // Environment maintenance (see maintainEnvironments): at most one pass
  // at a time, at most one per ENVIRONMENT_MAINTENANCE_MS from the sweep.
  private environmentMaintenance: Promise<void> | null = null;
  private lastEnvironmentMaintenance = 0;
  // Idempotency keys of recent thread creations (see createUserThread):
  // `<project>\0<key>` -> the thread it made, in insertion (= time) order.
  // In memory by design — a restart forgets them, and a key is only ever
  // replayed within minutes. Bounded by CREATE_REQUEST_CAP; expiry and
  // deleted threads are swept once a minute, not scanned per request.
  private readonly createRequests = new Map<string, { threadId: string; at: number }>();
  // Reserve keyed creates across the network preflight, not just allocation.
  private readonly pendingCreates = new Map<string, Promise<{ id: string; created: boolean }>>();
  private readonly threadPreparations = new Set<Promise<ProjectRepositoryRow[]>>();
  private closing = false;

  constructor(registry: Registry, backend: CubeBackend, config: SupervisorConfig) {
    this.registry = registry;
    this.backend = backend;
    this.config = config;
    this.git = new GitService(config.reposRoot);
    this.prReviews = new PrReviewService(config.reposRoot);
    this.lifecycle = new Lifecycle(path.join(config.cubesRoot, ".lifecycle"));
    this.templates = config.environmentCache === false
      ? null
      : new EnvironmentTemplates(registry, backend, config.pool, {
        callTimeoutMs: MAINTENANCE_CALL_TIMEOUT_MS,
        onError: (context, error) => recordPoint(registry, {
          kind: "environment", phase: "maintenance", ok: false, detail: `${context}: ${describeError(error)}`,
        }),
      });
  }

  // ---------------------------------------------------------------- events

  /** Start a timed, phased record of one operation on a cube. */
  private span(kind: string, cube: CubeRow | string): Span {
    const name = typeof cube === "string" ? cube : cube.name;
    // Resolved per record: provisioning starts before the thread row lands.
    return new Span(this.registry, { kind, cube: name, thread: () => this.threadIdFor(name) });
  }

  /** Directories under cubesRoot that no cube row claims. */
  private orphanHostTrees(): string[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.config.cubesRoot);
    } catch {
      return [];
    }
    const live = new Set(this.registry.listCubes().map((cube) => cube.name));
    return entries.filter((entry) => !live.has(entry) && !entry.startsWith(".")).sort();
  }

  /** What a still-provisioning cube is doing right now, from the phases its
   * provision span has completed so far, with elapsed minutes once it has
   * been a while (the setup script alone may run for many). */
  private provisionProgress(cube: CubeRow): string {
    // Anchored on the cube's creation, not on this terminal's attach: a
    // reattach mid-setup must still name the running step and the real
    // elapsed time.
    const since = cube.createdAt;
    const last = this.registry.listEvents({ cube: cube.name, kind: "provision", since, limit: 1 })[0];
    const phase = last?.op && last.phase ? last.phase : null;
    const restored = phase === "instance" && /restored/.test(last?.detail ?? "");
    const step =
      phase === null ? "preparing the repositories…"
      : phase === "seed" ? "creating the environment…"
      : restored ? "finishing up…"
      : phase === "instance" || phase === "proxy" ? "running the repository's .cube/setup — this can take a while…"
      : "finishing up…";
    const minutes = Math.floor((Date.now() - since) / 60_000);
    return minutes >= 2 ? `${step} (${minutes} min so far)` : step;
  }

  /** The thread behind a cube (one per cube), when it exists. */
  private threadIdFor(cube: CubeRow | string): string | null {
    const row = typeof cube === "string" ? this.registry.getCube(cube) : cube;
    if (!row) return null;
    return this.registry.listThreads(row.id)[0]?.id ?? null;
  }

  /** Count one egress decision; the batch lands as events on the next flush. */
  private noteEgress(cube: string, decision: "allow" | "deny", kind: string, rawHost: string): void {
    let host = rawHost.slice(0, EGRESS_HOST_MAX_LEN);
    let key = `${cube}\0${decision}\0${kind}\0${host}`;
    if (!this.egress.has(key)) {
      const distinct = this.egressHostsPerCube.get(cube) ?? 0;
      if (distinct >= EGRESS_HOSTS_PER_CUBE) {
        host = "…and more";
        key = `${cube}\0${decision}\0${kind}\0${host}`;
      } else {
        this.egressHostsPerCube.set(cube, distinct + 1);
      }
    }
    const entry = this.egress.get(key);
    if (entry) entry.n += 1;
    else this.egress.set(key, { cube, decision, kind, host, n: 1 });
    if (!this.egressTimer) {
      this.egressTimer = setTimeout(() => this.flushEgress(), EGRESS_FLUSH_MS);
      this.egressTimer.unref();
    }
  }

  private flushEgress(): void {
    if (this.egressTimer) clearTimeout(this.egressTimer);
    this.egressTimer = null;
    const batch = [...this.egress.values()];
    this.egress.clear();
    this.egressHostsPerCube.clear();
    // One thread lookup per cube, not per host.
    const threads = new Map<string, string | null>();
    for (const e of batch) {
      if (!threads.has(e.cube)) threads.set(e.cube, this.threadIdFor(e.cube));
      recordPoint(this.registry, {
        kind: "egress",
        phase: e.decision,
        cube: e.cube,
        thread: threads.get(e.cube) ?? null,
        ok: e.decision === "allow",
        detail: `${e.kind} ${e.host} ×${e.n}`,
      });
    }
  }

  /**
   * Re-attach to registry state after a cubed restart: cubes stuck in
   * "creating" were interrupted mid-provision (mark them so the UI shows a
   * destroy-and-retry path instead of an eternal spinner); a cube stuck in
   * "waking" was interrupted mid-wake — back to "asleep" so the next prompt
   * retries the full wake (hooks must tolerate a re-run; `docker compose
   * up -d` does). Ready cubes get their egress proxy back if the instance is
   * running; a ready cube whose instance is stopped (host reboot) becomes
   * "asleep" — it wakes on demand. Threads reopen lazily on first use.
   */
  async boot(): Promise<void> {
    // Builders have no thread. Reap interrupted builders before reusing any
    // snapshots; never resume setup as though it were a user's environment.
    for (const cube of this.registry.listCubes()) {
      if (cube.status !== "building-environment" || this.registry.listThreads(cube.id).length) continue;
      await this.cleanupEnvironmentBuilder(cube);
    }
    await this.templates?.recover();
    this.lastEnvironmentMaintenance = Date.now(); // the periodic pass continues from here
    const pruned = this.registry.pruneEvents(EVENT_RETENTION_MS);
    recordPoint(this.registry, { kind: "boot", detail: `cubed start; pruned ${pruned} old events` });
    // Host trees with no registry row are disk that nothing will ever free.
    // Named, never deleted here: a registry moved aside must not turn boot
    // into a wipe of every workspace.
    const orphans = this.orphanHostTrees();
    if (orphans.length > 0) {
      recordPoint(this.registry, {
        kind: "boot",
        phase: "orphans",
        ok: false,
        detail: `${orphans.length} host tree(s) under ${this.config.cubesRoot} belong to no thread: ${orphans.slice(0, 8).join(" ")}${orphans.length > 8 ? " …" : ""}`,
      });
    }
    for (const cube of this.registry.listCubes()) {
      if (cube.status === "building-environment") continue; // quarantined cleanup remains retryable
      for (const phase of ["setup", "resume"] as const) {
        const result = this.lifecycle.read(cube.name, phase);
        if (result?.state === "running") this.lifecycle.save(cube.name, phase, {
          ...result, state: "failed", durationMs: Date.now() - result.startedAt,
          error: `${phase} interrupted by cubed restart — retry setup or wake`,
        });
      }
      const span = this.span("boot", cube);
      if (cube.status === "creating") {
        // Interrupted after the instance came up (typically during a long
        // .cube/setup — an app upgrade restarts cubed) leaves a usable
        // environment: wake it on demand and say what may be missing.
        // Interrupted before that, there is nothing to wake.
        const exists = await this.backend.getState(instanceName(cube.name)).then(() => true, () => false);
        this.registry.setCubeStatus(
          cube.name,
          exists ? "asleep" : "error",
          exists
            ? "provisioning was interrupted by a cubed restart — .cube/setup may not have completed"
            : "provisioning interrupted by cubed restart",
        );
        span.end(exists, `interrupted provision -> ${exists ? "asleep" : "error"}`);
        continue;
      }
      if (cube.status === "waking") {
        this.registry.setCubeStatus(cube.name, "asleep", cube.error);
        span.end(true, "interrupted wake -> asleep");
        continue;
      }
      if (cube.status !== "ready") {
        span.end(true, `${cube.status} left as is`);
        continue;
      }
      try {
        const state = await this.backend.getState(instanceName(cube.name));
        if (state.status === "Running") {
          // Running is not readiness: if the instance was just (re)started,
          // its static IP may not be assigned yet — a prompt straight after
          // boot would hit the wake-readiness race (tenth update). Normally
          // the IP is long up and this returns on the first poll.
          const net = networkForCube(cube.name, cube.subnetIndex);
          await this.backend.waitForNetwork(instanceName(cube.name), net.ip);
          await this.startProxy(cube);
          span.end(true, "ready, proxy restarted");
        } else {
          this.registry.setCubeStatus(cube.name, "asleep", cube.error);
          span.end(true, "ready but stopped -> asleep");
        }
      } catch (error) {
        this.registry.setCubeStatus(cube.name, "error", `boot: ${String(error)}`);
        span.fail(error);
      }
    }
    if (!this.pruneTimer) {
      // Retention runs on its own clock: it must not depend on idle sleep
      // being enabled (CUBED_IDLE_MS=0 is supported).
      this.pruneTimer = setInterval(() => this.registry.pruneEvents(EVENT_RETENTION_MS), EVENT_PRUNE_EVERY_MS);
      this.pruneTimer.unref();
    }
    if (!this.sweepTimer) {
      // One minute tick: the idle sleep (when enabled) and, every ten
      // minutes, the environment maintenance boot could not finish.
      this.sweepTimer = setInterval(() => this.sweep(), 60_000);
      this.sweepTimer.unref();
    }
  }

  private sweep(): void {
    if (this.config.idleMs > 0) void this.sweepIdle();
    this.sweepCreateRequests();
    if (Date.now() - this.lastEnvironmentMaintenance >= ENVIRONMENT_MAINTENANCE_MS) void this.maintainEnvironments();
  }

  /**
   * Retry what boot could not finish: builders whose cleanup failed
   * (`building-environment` rows marked "cleanup pending") and cache
   * entries whose publication or eviction never resolved — each one holds
   * an image, a workspace tree or a subnet outside the configured budget
   * until it is gone. Bounded: a batch per pass, a deadline per Incus
   * call, so one stalled request costs one deadline and the pass ends.
   * Best effort: every failure is an event, never a rejection. Concurrent
   * calls share one pass.
   */
  maintainEnvironments(): Promise<void> {
    if (this.environmentMaintenance) return this.environmentMaintenance;
    this.lastEnvironmentMaintenance = Date.now();
    this.environmentMaintenance = (async () => {
      const span = new Span(this.registry, { kind: "environment" });
      let retried = 0;
      for (const cube of this.pendingBuilders().slice(0, MAINTENANCE_BATCH)) {
        retried += 1;
        await this.cleanupEnvironmentBuilder(cube);
      }
      await this.templates?.prune();
      const pending = this.pendingBuilders().length;
      const templates = this.templates?.list().length ?? 0;
      span.end(pending === 0, `maintenance: ${retried} builder cleanup(s) retried, ${pending} still pending; ${templates} template(s) kept`);
    })().finally(() => { this.environmentMaintenance = null; });
    return this.environmentMaintenance;
  }

  /** Builders whose teardown failed: still an instance, a volume, a host
   * tree, and a subnet held by a row nobody can see. */
  private pendingBuilders(): CubeRow[] {
    return this.registry.listCubes().filter((cube) =>
      cube.status === "building-environment" && !!cube.error?.startsWith("cleanup pending") && this.registry.listThreads(cube.id).length === 0);
  }

  // --------------------------------------------------------------- projects

  listProjects(): ProjectInfo[] {
    return this.registry.listProjects().map((project) => this.projectInfo(project));
  }

  getProject(id: string): ProjectInfo {
    const project = this.registry.getProject(id);
    if (!project) throw new Error(`no such project: ${id}`);
    return this.projectInfo(project);
  }

  createProject(input: ProjectInput): ProjectInfo {
    const normalized = this.validateProjectInput(input);
    let project: ProjectRow;
    try {
      project = this.registry.createProject({
        id: crypto.randomUUID(),
        name: normalized.name,
        repositories: normalized.repositories.map((repo) => ({ id: crypto.randomUUID(), ...repo })),
        environment: normalized.environment,
      });
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: project.name")) {
        throw new Error(`project ${JSON.stringify(normalized.name)} already exists`);
      }
      throw error;
    }
    this.queueProjectCheck(project);
    return this.projectInfo(project);
  }

  updateProject(id: string, input: ProjectInput): ProjectInfo {
    const normalized = this.validateProjectInput(input);
    let project: ProjectRow;
    try {
      project = this.registry.updateProject(id, {
        name: normalized.name,
        repositories: normalized.repositories.map((repo) => ({ id: crypto.randomUUID(), ...repo })),
        environment: normalized.environment,
      });
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed: project.name")) {
        throw new Error(`project ${JSON.stringify(normalized.name)} already exists`);
      }
      throw error;
    }
    this.queueProjectCheck(project);
    return this.projectInfo(project);
  }

  checkProject(id: string): ProjectInfo {
    const project = this.registry.beginProjectCheck(id);
    this.queueProjectCheck(project);
    return this.projectInfo(project);
  }

  async deleteProject(id: string): Promise<void> {
    if (this.projectChecks.has(id)) throw new Error(`project ${id} is still checking`);
    if (this.registry.countThreadsForProject(id) > 0) throw new Error(`project ${id} still has threads`);
    // The project's template (a stopped instance and a volume) goes first;
    // a failure there keeps the project, never leaks the instance.
    await this.templates?.forgetProject(id);
    this.registry.deleteProject(id);
  }

  private projectInfo(project: ProjectRow): ProjectInfo {
    return {
      ...project,
      repositories: this.registry.listProjectRepositories(project.id),
      threadCount: this.registry.countThreadsForProject(project.id),
    };
  }

  private validateProjectInput(input: ProjectInput): {
    name: string;
    repositories: Array<{ url: string; base: string | null; checkoutName: string }>;
    environment: string | null;
  } {
    const name = input.name.replace(/\s+/g, " ").trim();
    if (!name) throw new Error("invalid project: name is required");
    if (name.length > 100) throw new Error("invalid project: name is too long (100 characters max)");
    if (!Array.isArray(input.repositories) || input.repositories.length === 0) {
      throw new Error("invalid project: a primary repository is required");
    }
    const checkoutNames = new Set<string>();
    const repositories = input.repositories.map((raw, position) => {
      if (!raw || typeof raw.url !== "string") {
        throw new Error(`invalid project: repository ${position + 1} needs a URL`);
      }
      const { url, base } = this.validateRepoInput(raw);
      const checkoutName =
        position === 0 ? "workspace" : (raw.checkoutName?.trim() || this.checkoutNameFor(url));
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(checkoutName)) {
        throw new Error(
          `invalid project: checkout name ${JSON.stringify(checkoutName)} must use letters, numbers, dot, dash, or underscore`,
        );
      }
      const identity = checkoutName.toLowerCase();
      if (checkoutNames.has(identity)) {
        throw new Error(`invalid project: checkout name ${JSON.stringify(checkoutName)} is used more than once`);
      }
      checkoutNames.add(identity);
      return { url, base, checkoutName };
    });
    return { name, repositories, environment: this.validateEnvironmentInput(input.environment, repositories) };
  }

  /** "<checkout>/<folder>" -> canonical form, or null for none. The first
   * segment must name a reference repository (never the primary: that is
   * the agent-writable checkout, and its own .cube is the default anyway);
   * the rest are plain folder names — no dotfiles, no `..`, no `.git`. */
  private validateEnvironmentInput(
    raw: string | null | undefined,
    repositories: Array<{ checkoutName: string }>,
  ): string | null {
    const value = (raw ?? "").trim().replace(/^\/+|\/+$/g, "");
    if (!value) return null;
    if (value.length > 200) throw new Error("invalid project: environment folder is too long (200 characters max)");
    const [checkoutName, ...folders] = value.split("/");
    const references = repositories.slice(1);
    const reference = references.find((repo) => repo.checkoutName.toLowerCase() === checkoutName!.toLowerCase());
    if (!reference) {
      throw new Error(
        references.length === 0
          ? `invalid project: environment ${JSON.stringify(value)} needs a reference repository to live in — add one first`
          : `invalid project: environment ${JSON.stringify(value)} must start with a reference checkout name (${references.map((repo) => repo.checkoutName).join(", ")})`,
      );
    }
    for (const folder of folders) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(folder)) {
        throw new Error(
          `invalid project: environment folder ${JSON.stringify(value)} must use letters, numbers, dot, dash, or underscore per folder`,
        );
      }
    }
    return [reference.checkoutName, ...folders].join("/");
  }

  private checkoutNameFor(url: string): string {
    return (
      url
        .replace(/[\\/]+$/, "")
        .split(/[/:]/)
        .pop()!
        .replace(/\.git$/, "")
        .replace(/[^A-Za-z0-9._-]/g, "-")
        .replace(/^[^A-Za-z0-9]+/, "")
        .slice(0, 64) || "repo"
    );
  }

  private queueProjectCheck(project: ProjectRow): void {
    const prior = this.projectChecks.get(project.id) ?? Promise.resolve();
    const check = prior.catch(() => {}).then(() => this.runProjectCheck(project.id, project.revision));
    this.projectChecks.set(project.id, check);
    void check
      .finally(() => {
        if (this.projectChecks.get(project.id) === check) this.projectChecks.delete(project.id);
      })
      .catch((error) => console.log(`project check ${project.id}: ${String(error)}`));
  }

  private async runProjectCheck(projectId: string, revision: number): Promise<void> {
    const span = new Span(this.registry, { kind: "project-check" });
    await this.config.github?.ensureFresh();
    const repositories = this.registry.listProjectRepositories(projectId);
    const failures: string[] = [];
    await Promise.all(
      repositories.map(async (repo) => {
        try {
          const prepared = await this.git.prepareRepository(repo.url, repo.base);
          this.registry.setProjectRepositoryCheck(repo.id, {
            status: "ready",
            resolvedBase: prepared.base,
            baseOid: prepared.baseOid,
            checkedAt: Date.now(),
          });
        } catch (error) {
          const raw = error instanceof Error ? error.message : String(error);
          const message =
            describeRepoAuthFailure(raw, repo.url, this.config.github?.status().state === "connected") ?? raw;
          failures.push(`${repo.checkoutName}: ${message}`);
          this.registry.setProjectRepositoryCheck(repo.id, {
            status: "error",
            error: message,
            checkedAt: Date.now(),
          });
        }
      }),
    );
    // Validate the declared environment at the checked snapshot. Creation
    // repeats this validation against the refreshed reference commit.
    const environment = this.registry.getProject(projectId)?.environment ?? null;
    if (failures.length === 0) {
      failures.push(...await this.environmentSnapshotErrors(this.registry.listProjectRepositories(projectId), environment));
    }
    const checkedAt = Date.now();
    this.registry.finishProjectCheck(
      projectId,
      revision,
      failures.length === 0 ? "ready" : "error",
      failures.length === 0 ? null : failures.join("; "),
      checkedAt,
    );
    const name = this.registry.getProject(projectId)?.name ?? projectId;
    span.end(
      failures.length === 0,
      failures.length === 0 ? `${name}: ${repositories.length} repositor${repositories.length === 1 ? "y" : "ies"} ready` : `${name}: ${failures.join("; ")}`,
    );
  }

  /** Validate the declaration against the exact reference commit we will use,
   * both on project check and when a new thread refreshes its repositories. */
  private async environmentSnapshotErrors(repositories: ProjectRepositoryRow[], environment: string | null): Promise<string[]> {
    const failures: string[] = [];
    if (environment) {
      const [checkoutName, ...folders] = environment.split("/");
      const repo = repositories.find((r) => r.checkoutName === checkoutName);
      const folder = [...folders, ".cube"].join("/");
      if (!repo?.baseOid) failures.push(`environment: ${environment} names no checked reference repository`);
      else if (!(await this.git.pathExistsAtCommit(repo.url, repo.baseOid, folder))) {
        failures.push(`environment: no ${folder} in ${repo.checkoutName} at ${repo.resolvedBase} @ ${repo.baseOid.slice(0, 8)}`);
      } else {
        const toml = await this.git.readFileAtCommit(repo.url, repo.baseOid, `${folder}/cube.toml`);
        if (toml !== null) {
          try { parseCubeToml(toml); }
          catch (error) { failures.push(`environment: ${repo.checkoutName}/${folder}/${error instanceof Error ? error.message : String(error)}`); }
        }
      }
    }
    return failures;
  }

  /** A project check verifies configuration/access, not freshness forever.
   * Fetch before allocating anything, pin the results locally, and never use
   * the older checked OIDs as a fallback. Existing threads keep their pins. */
  private async prepareThreadRepositories(project: ProjectRow): Promise<ProjectRepositoryRow[]> {
    const configured = this.registry.listProjectRepositories(project.id);
    const span = new Span(this.registry, { kind: "thread-prepare" });
    try {
      await this.config.github?.ensureFresh();
      // Drain every fetch even if one fails: shutdown must not leave work
      // attached to a registry that has already been closed.
      const results = await Promise.allSettled(configured.map(async (repo) => {
        try {
          const prepared = await this.git.prepareRepository(repo.url, repo.base);
          return { ...repo, resolvedBase: prepared.base, baseOid: prepared.baseOid };
        } catch (error) {
          const raw = error instanceof Error ? error.message : String(error);
          const message = describeRepoAuthFailure(raw, repo.url, this.config.github?.status().state === "connected") ?? raw;
          throw new Error(`could not refresh ${repo.checkoutName}: ${message}`);
        }
      }));
      const repositories = results.map(result => {
        if (result.status === "rejected") throw result.reason;
        return result.value;
      });
      if (this.closing) throw new Error("server is stopping — start the thread again after restart");
      const failures = await this.environmentSnapshotErrors(repositories, project.environment);
      if (failures.length) throw new Error(failures.join("; "));
      // Detect edits/re-checks/deletion during fetch. The caller rechecks
      // after its await too, immediately before synchronous allocation.
      const current = this.requireReadyProject(project.id);
      if (current.revision !== project.revision) throw new Error("project changed while refreshing repositories — start the thread again");
      span.end(true, `${project.id}: ${repositories.map(repo => `${repo.checkoutName}@${repo.baseOid}`).join(", ")}`);
      return repositories;
    } catch (error) {
      span.fail(error);
      throw error;
    }
  }

  // ------------------------------------------------------------------ cubes

  listCubes(): CubeSummary[] {
    const summaries: CubeSummary[] = [];
    for (const cube of this.registry.listCubes()) {
      if (cube.status === "building-environment") continue;
      summaries.push({
        name: cube.name,
        status: cube.status,
        error: cube.error,
        ip: networkForCube(cube.name, cube.subnetIndex).ip,
        threadCount: this.registry.listThreads(cube.id).length,
        createdAt: cube.createdAt,
        lastActiveAt: cube.lastActiveAt,
      });
    }
    return summaries;
  }

  /**
   * Register + provision a cube. Returns as soon as the registry row exists
   * (status "creating"); provisioning continues in the background and flips
   * the row to "ready" or "error". Poll GET /api/cubes for progress.
   */
  createCube(name: string): CubeRow {
    if (this.registry.getCube(name)) throw new Error(`cube ${name} already exists`);
    const row = this.registry.createCube({
      name,
      image: this.config.image,
      workspacePath: path.join(this.config.cubesRoot, name, "workspace"),
    });
    // Provisioning is a transition like sleep/wake: prompts on a thread of a
    // still-creating cube settle on it (prompt-before-ready) instead of
    // failing, and removeCube/sleep are guarded against racing it.
    this.transition(row.name, this.provision(row)).catch(() => {});
    return row;
  }

  /** Allocate a cube from one immutable, already-checked Project snapshot.
   * Repository rows land before provisioning is queued, so the async seed
   * cannot observe a half-attached project. */
  private createProjectCube(name: string, repositories: ProjectRepositoryRow[], environment: string | null): CubeRow {
    if (this.registry.getCube(name)) throw new Error(`cube ${name} already exists`);
    const row = this.registry.createCube({
      name,
      image: this.config.image,
      workspacePath: path.join(this.config.cubesRoot, name, "workspace"),
      environment,
    });
    const root = path.dirname(row.workspacePath);
    const branch = `cube/${name.replace(/^t-/, "")}`;
    try {
      this.registry.addCubeRepositories(
        row.id,
        repositories.map((repo, position) => {
          if (!repo.resolvedBase || !repo.baseOid) {
            throw new Error(`project repository ${repo.checkoutName} is not ready`);
          }
          return {
            url: repo.url,
            base: repo.resolvedBase,
            branch,
            baseOid: repo.baseOid,
            checkoutName: repo.checkoutName,
            workspacePath:
              position === 0 ? row.workspacePath : path.join(root, "repos", repo.checkoutName),
          };
        }),
      );
    } catch (error) {
      // Without the repository snapshot there is no thread to expose this
      // cube in the product UI. Roll back the registry allocation before
      // any asynchronous provisioning starts.
      this.registry.deleteCube(row.name);
      throw error;
    }
    this.transition(row.name, this.provision(row, repositories[0]?.projectId)).catch(() => {});
    return row;
  }

  /** Validate a project repository synchronously (400-path). Rejects
   * bad URLs (incl. inline credentials) and bad base refs; local-path /
   * file:// upstreams are gated behind CUBED_ALLOW_LOCAL_REPOS so the API
   * cannot be used to clone arbitrary host paths (or reach internal hosts)
   * into an untrusted cube. */
  private validateRepoInput(repo: { url: string; base?: string | null }): {
    url: string;
    base: string | null;
  } {
    const url = normalizeRepoUrl(repo.url);
    const isLocal = url.startsWith("file://") || path.isAbsolute(url);
    if (isLocal && process.env.CUBED_ALLOW_LOCAL_REPOS !== "1") {
      throw new Error("invalid repository: local-path repositories are disabled");
    }
    const base = repo.base?.trim() || null;
    // Same ref-safety the seed clone needs, checked up front: no option
    // injection, no path traversal, no `..` range trickery.
    if (base !== null && (!/^[A-Za-z0-9._/-]+$/.test(base) || base.startsWith("-") || base.includes(".."))) {
      throw new Error(`invalid repository: bad base branch ${JSON.stringify(base)}`);
    }
    return { url, base };
  }

  private provisionSpec(cube: CubeRow): CubeProvisionSpec {
    const repositories = this.registry.listCubeRepositories(cube.id);
    return {
      name: instanceName(cube.name),
      image: cube.image,
      pool: this.config.pool,
      rootSize: this.config.rootSize,
      dockerVolumeSize: this.config.dockerVolumeSize,
      hostWorkspace: cube.workspacePath,
      guestWorkspace: "/workspace",
      ...(this.config.cubeMemory ? { memoryLimit: this.config.cubeMemory } : {}),
      ...(repositories.length > 1
        ? {
            hostRepositories: path.join(path.dirname(cube.workspacePath), "repos"),
            guestRepositories: "/repos",
          }
        : {}),
      network: {
        ...networkForCube(cube.name, cube.subnetIndex),
        nat: false, // default-deny egress; the proxy is the only way out
        proxyPort: EGRESS_PROXY_PORT,
        portalBase: this.config.portalBase,
      },
    };
  }

  /** The git service takes no signal (one local clone per repository is
   * bounded work); a cancellation lands between repositories instead. */
  private async seedCube(cube: CubeRow, signal?: AbortSignal): Promise<void> {
    for (const repo of this.registry.listCubeRepositories(cube.id)) {
      signal?.throwIfAborted();
      await this.git.seedPreparedWorkspace({
        url: repo.url, workspacePath: repo.workspacePath, base: repo.base,
        baseOid: repo.baseOid, branch: repo.branch,
        identity: this.config.github?.gitIdentity?.(),
      });
    }
  }

  /**
   * Provision one cube end to end. Cancellable through `this.provisioning`
   * (a thread deleted mid-setup): the signal reaches the guest scripts, is
   * checked between stages, and goes into the backend's instance create /
   * restore, which rolls a half-made instance back on abort (bounded,
   * signal-free) — so the teardown that follows always finds the instance
   * either absent or fully created.
   */
  private async provision(cube: CubeRow, projectId?: string): Promise<void> {
    const span = this.span("provision", cube);
    const controller = new AbortController();
    const signal = controller.signal;
    this.provisioning.set(cube.name, controller);
    // The transition and the controller are reserved (above, synchronously);
    // the work itself starts one tick later so the caller's thread row is
    // in place before the first record — an immediate failure must still
    // name its thread.
    await null;
    try {
      // The first host write of a provision belongs inside the guard: a
      // full or read-only disk fails here as an error the thread can be
      // deleted from, not as an escaped rejection that strands `creating`.
      this.lifecycle.save(cube.name, "setup", { state: "running", startedAt: Date.now(), durationMs: null, error: null });
      // Seed from the exact snapshots refreshed before thread allocation.
      // Provisioning itself stays local-only; never fetch a second tip here.
      await this.seedCube(cube, signal);
      signal.throwIfAborted();
      span.phase("seed");
      const spec = this.provisionSpec(cube);
      // The checkout is still fresh and not mounted in any guest. Inspect
      // only directory entries, never follow a repo symlink on the host.
      // No setup script means the base image is already the best rootfs.
      let hasSetup = false;
      try {
        const environmentDir = environmentDirs(cube).host;
        const dir = fs.lstatSync(environmentDir);
        hasSetup = dir.isSymbolicLink() || (dir.isDirectory() && !!fs.lstatSync(path.join(environmentDir, "setup")));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      // A prepared environment: the project's template for this exact
      // declaration, built now if it does not exist yet. Threads that start
      // together share one build; a thread deleted meanwhile abandons its
      // wait (the builder finishes for the next one).
      let template: { id: string; source: CubeTemplateSource } | null = null;
      if (projectId && this.templates && hasSetup) {
        const repos = this.registry.listCubeRepositories(cube.id);
        const pending = this.templates.acquire(
          projectId,
          await this.environmentKeyFor(cube, spec),
          (instance) => this.buildTemplate(cube, repos, instance),
        );
        try {
          const row = await abortable(signal, pending);
          template = { id: row.id, source: { instance: row.instance, snapshot: row.snapshot, volume: row.volume, volumeSnapshot: row.volumeSnapshot } };
        } catch (error) {
          // An abandoned wait still ends in a lease when the build lands:
          // give it back then, or the template can never be evicted and the
          // project never deleted (Codex review).
          void pending.then((row) => this.templates!.release(row.id), () => {});
          signal.throwIfAborted();
          // Reuse is an optimization; fresh setup remains the path.
          recordPoint(this.registry, {
            kind: "environment", phase: "template-unavailable", cube: cube.name,
            thread: this.threadIdFor(cube), ok: false, detail: `fresh setup instead: ${describeError(error)}`,
          });
          console.warn(`environment template [${cube.name}]: ${String(error)}`);
        }
      }
      signal.throwIfAborted();
      let cloned = false;
      if (template) {
        try {
          await this.backend.provision({ ...spec, template: template.source }, { signal });
          cloned = true;
        } catch (error) {
          signal.throwIfAborted();
          // provisionCube rolled the instance back; the base image still works.
          recordPoint(this.registry, {
            kind: "environment", phase: "clone-failed", cube: cube.name,
            thread: this.threadIdFor(cube), ok: false, detail: `fresh setup instead: ${describeError(error)}`,
          });
          console.warn(`environment clone [${cube.name}]: ${String(error)}`);
        } finally {
          this.templates!.release(template.id);
        }
      }
      if (!cloned) await this.backend.provision(spec, { signal });
      span.phase("instance", cloned ? "cloned from a prepared environment" : null);
      this.registry.addVolume({
        cubeId: cube.id,
        purpose: "docker",
        poolVolume: `${this.config.pool}/${spec.name}-docker`,
        capBytes: parseSize(this.config.dockerVolumeSize),
      });
      signal.throwIfAborted();
      await this.startProxy(cube, signal);
      span.phase("proxy");
      signal.throwIfAborted();
      // Setup runs in every thread: on a clone it is the warm rerun that
      // brings the fresh checkout up to date (dependencies, generated files);
      // an idempotent script makes that seconds, never a second cold build.
      const setupError = await this.runLifecycleScript(cube, "setup", signal);
      span.phase("setup", cloned && setupError === null ? "warm rerun on a prepared environment" : setupError, setupError === null);
      signal.throwIfAborted();
      const activationError = setupError ?? await this.runLifecycleScript(cube, "resume", signal);
      if (setupError === null) span.phase("resume", activationError, activationError === null);
      signal.throwIfAborted();
      this.registry.setCubeStatus(cube.name, "ready", activationError);
      span.end(true, activationError ? "ready with setup complaint" : "ready");
    } catch (error) {
      // provisionCube rolled the instance back; bridge/volume are reusable.
      const cancelled = signal.aborted;
      this.failLifecycle(cube.name, "setup", cancelled ? PROVISION_CANCELLED : String(error));
      // A cancelled provision is torn down by the deletion that cancelled
      // it; the status is only for a teardown that then fails half-way.
      this.registry.setCubeStatus(cube.name, "error", cancelled ? PROVISION_CANCELLED : String(error));
      if (cancelled) span.end(false, PROVISION_CANCELLED);
      else span.fail(error);
    } finally {
      if (this.provisioning.get(cube.name) === controller) this.provisioning.delete(cube.name);
    }
  }

  /** What a template is made of: the environment declaration and what the
   * rootfs is built from. Repository commits are deliberately absent — the
   * workspace is never part of a template. */
  private async environmentKeyFor(cube: CubeRow, spec: CubeProvisionSpec): Promise<string> {
    const dir = environmentDirs(cube).host;
    const read = (file: string): string | null => {
      try { return fs.readFileSync(path.join(dir, file), "utf8"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    };
    return environmentKey({
      version: 1,
      declaration: { setup: read("setup"), resume: read("resume"), toml: read("cube.toml") },
      image: await this.backend.resolveImage(cube.image),
      arch: process.arch,
      rootSize: spec.rootSize,
      dockerVolumeSize: spec.dockerVolumeSize,
      memory: spec.memoryLimit ?? null,
      egress: this.config.egressAllow,
      caCertificates: this.config.caCertificates ?? "",
    });
  }

  /**
   * Build one template in a dedicated builder cube: seed, provision from
   * the base image, run setup once, then hand the stopped instance and its
   * docker volume to the backend to snapshot. `repositories` is the source
   * thread's immutable snapshot, read by the caller before the shared work
   * was queued: the build may run after that thread was deleted. On success
   * the builder's cube row, subnet and host tree are released — the
   * instance lives on as the template. On failure everything is torn down.
   */
  private async buildTemplate(
    source: Pick<CubeRow, "image" | "environment">,
    repositories: CubeRepositoryRow[],
    instance: string,
  ): Promise<CubeTemplateSource> {
    if (repositories.length === 0) throw new Error("environment build refused: the source thread has no repositories");
    const name = instance.replace(/^cube-/, "");
    const builder = this.registry.createCube({
      name, image: source.image,
      workspacePath: path.join(this.config.cubesRoot, name, "workspace"),
      environment: source.environment,
    });
    this.registry.setCubeStatus(name, "building-environment");
    this.registry.addCubeRepositories(builder.id, repositories.map((repo, position) => ({
      url: repo.url, base: repo.base, baseOid: repo.baseOid, branch: "cube/setup",
      checkoutName: repo.checkoutName,
      workspacePath: position === 0 ? builder.workspacePath : path.join(path.dirname(builder.workspacePath), "repos", repo.checkoutName),
    })));
    const spec = this.provisionSpec(builder);
    const span = this.span("environment", builder);
    try {
      await this.seedCube(builder);
      span.phase("seed");
      await this.backend.provision(spec);
      span.phase("instance");
      await this.startProxy(builder);
      const error = await this.runLifecycleScript(builder, "setup");
      span.phase("setup", error, error === null);
      if (error) throw new Error(error);
      await this.runtimes.get(builder.name)?.proxy?.close();
      this.runtimes.delete(builder.name);
      const template = await this.backend.captureTemplate(spec, "env", { timeoutMs: MAINTENANCE_CALL_TIMEOUT_MS });
      span.phase("capture");
      // From here the instance is the template, not a cube: its bridge is
      // gone (captureTemplate), its row, subnet and host tree go now.
      removeStoppedTree(path.dirname(builder.workspacePath));
      this.lifecycle.forget(builder.name);
      this.registry.deleteCube(builder.name);
      span.end(true, "template ready");
      return template;
    } catch (error) {
      span.fail(error);
      await this.cleanupEnvironmentBuilder(builder);
      throw error;
    }
  }

  /** Tear a builder down under a deadline. A failure keeps the row as a
   * "cleanup pending" quarantine that boot and maintenance retry. */
  private async cleanupEnvironmentBuilder(builder: CubeRow): Promise<void> {
    try {
      await this.runtimes.get(builder.name)?.proxy?.close();
      this.runtimes.delete(builder.name);
      await this.backend.destroy(this.provisionSpec(builder), {
        deleteVolume: true, deleteBridge: true, signal: AbortSignal.timeout(MAINTENANCE_CALL_TIMEOUT_MS),
      });
      removeStoppedTree(path.dirname(builder.workspacePath));
      this.lifecycle.forget(builder.name);
      this.registry.deleteCube(builder.name);
    } catch (error) {
      // Never turn one unremovable guest directory into a daemon outage.
      // Keep the internal row/path as a durable quarantine: boot and the
      // periodic maintenance retry it.
      this.registry.setCubeStatus(builder.name, "building-environment", `cleanup pending: ${String(error)}`);
      recordPoint(this.registry, { kind: "environment", phase: "builder-cleanup", cube: builder.name, ok: false, detail: describeError(error) });
      console.warn(`environment builder cleanup [${builder.name}]: ${String(error)}`);
    }
  }

  /** Start this cube's egress proxy, or replace it when the declared policy
   * changed. The allowlist is the built-in package hosts plus the
   * operator's CUBED_EGRESS_ALLOW plus `[network] allow` from the cube's
   * environment directory, read host-side on every start — so a wake or a
   * setup retry picks up an edited declaration. A parse error fails that
   * transition with the offending line rather than silently narrowing
   * egress; the proxy itself still vets every name (ARCHITECTURE §12). */
  private async startProxy(cube: CubeRow, signal?: AbortSignal): Promise<void> {
    // Every provision, builder, boot recovery, wake and setup retry passes
    // this boundary before network-dependent work. This also revokes roots
    // inherited from an older template or persisted across a VM reboot.
    await this.backend.configureCaTrust(instanceName(cube.name), this.config.caCertificates ?? "", signal);
    const runtime = this.runtime(cube.name);
    const declared = readCubeConfig(environmentDirs(cube).host).networkAllow;
    const allow = [...new Set([...this.config.egressAllow, ...declared])];
    if (runtime.proxy) {
      const current = runtime.egressAllow ?? [];
      if (current.length === allow.length && current.every((host, i) => host === allow[i])) return;
      // In-flight tunnels of this cube end here; every caller is a wake,
      // retry or provision boundary where the cube is not mid-download.
      await runtime.proxy.close();
      runtime.proxy = null;
      runtime.egressAllow = null;
    }
    const net = networkForCube(cube.name, cube.subnetIndex);
    runtime.proxy = await this.backend.startEgressProxy({
      listenHost: net.gateway,
      port: EGRESS_PROXY_PORT,
      allow,
      allowSource: [net.ip],
      onDeny: (host, kind) => {
        console.log(`egress deny [${cube.name}] ${kind}: ${host}`);
        this.noteEgress(cube.name, "deny", kind, host);
      },
      onAllow: (host, kind) => this.noteEgress(cube.name, "allow", kind, host),
    });
    runtime.egressAllow = allow;
  }

  // ------------------------------------------------------------ sleep/wake

  /**
   * `incus stop` a ready, non-busy cube. Threads stay live (pi sessions are
   * host-side — history replays without waking); only bash needs the
   * container, and prompt() wakes it first. The egress proxy keeps running:
   * the bridge outlives the instance, and nothing can connect while the
   * cube is off. Status flips to "asleep" before the stop so a concurrent
   * prompt takes the wake path (which awaits the in-flight stop).
   */
  async sleepCube(name: string, reason: "manual" | "idle" = "manual"): Promise<void> {
    for (;;) {
      const inflight = this.pendingTransition(name);
      if (!inflight) break;
      await inflight.catch(() => {}); // failures surface via cube status
    }
    // Sync from here to transition(): check-and-reserve is atomic. (An
    // `await settle()` variant yields to the microtask queue even when
    // nothing is in flight, letting two callers both pass the check —
    // found by sol review.)
    const cube = this.requireCube(name);
    if (cube.status === "asleep") return;
    if (cube.status !== "ready") {
      throw new Error(`cube ${name} is not ready (status: ${cube.status}) — cannot sleep`);
    }
    // Sleep is not a resolution: a setup or hook complaint the user has not
    // read yet survives the idle sweep instead of vanishing an hour later.
    this.registry.setCubeStatus(name, "asleep", cube.error);
    return this.transition(name, this.doSleep(cube, reason));
  }

  /**
   * Wake a cube: `incus start`, then waitForCubeNetwork — status "Running"
   * alone is NOT readiness, networkd assigns the static IP ~1s later (tenth
   * update; do not regress) — then re-start the egress proxy if it died
   * with cubed, then run wake hooks from .cube/cube.toml. Concurrent wakes
   * coalesce on the in-flight transition. A "ready" cube is verified
   * against the actual instance state (a rooted agent can stop its own
   * container; registry status alone is not truth), and "error" is
   * wakeable as the retry path (a transient wake failure must not require
   * destroying the cube).
   */
  async wakeCube(name: string): Promise<void> {
    for (;;) {
      const inflight = this.pendingTransition(name);
      if (inflight) {
        await inflight.catch(() => {}); // failures surface via cube status
        continue;
      }
      const cube = this.requireCube(name);
      if (cube.status === "ready") {
        const state = await this.backend.getState(instanceName(name));
        // Re-validate after the await on BOTH paths: a setup retry or a
        // sleep may have reserved the cube while the state request was out,
        // and returning "running" then would let guest tools race it.
        if (this.pendingTransition(name)) continue;
        if (this.requireCube(name).status !== "ready") continue;
        if (state.status === "Running") {
          // A wake request is activity: the extension asks before every tool
          // call, and a long quiet tool (docker build) must not be slept
          // under it by the idle sweep.
          this.registry.touchCube(name);
          return;
        }
        // Stopped under a ready row (agent-initiated poweroff, out-of-band
        // `incus stop`): demote to asleep and loop into the normal wake path.
        this.registry.setCubeStatus(name, "asleep", cube.error);
        continue;
      }
      if (cube.status === "creating") {
        throw new Error(`cube ${name} is not ready (status: creating) — cannot wake`);
      }
      // asleep | waking (interrupted wake) | error (retry)
      this.registry.setCubeStatus(name, "waking");
      return this.transition(name, this.doWake(cube));
    }
  }

  /** SYNC guard for the check-and-reserve loops: throws mid-removal, else
   * returns the in-flight transition to await (null = free to reserve). */
  private pendingTransition(name: string): Promise<void> | null {
    if (this.removing.has(name)) throw new Error(`cube ${name} is busy being removed`);
    return this.transitions.get(name) ?? null;
  }

  private transition(name: string, work: Promise<void>): Promise<void> {
    const tracked = work.finally(() => {
      // Guarded delete: never evict a successor's entry.
      if (this.transitions.get(name) === tracked) this.transitions.delete(name);
    });
    this.transitions.set(name, tracked);
    return tracked;
  }

  private async doSleep(cube: CubeRow, reason: "manual" | "idle"): Promise<void> {
    const name = instanceName(cube.name);
    const span = this.span("sleep", cube);
    try {
      const state = await this.backend.getState(name);
      let how = "already stopped";
      if (state.status !== "Stopped") {
        try {
          await this.backend.setState(name, "stop", { timeout: 30 });
          how = "stopped";
        } catch {
          // graceful stop timed out (a wedged inner dockerd can do this)
          await this.backend.setState(name, "stop", { force: true });
          how = "force-stopped after a 30s graceful timeout";
        }
      }
      span.end(true, `${reason}: ${how}`);
    } catch (error) {
      this.registry.setCubeStatus(cube.name, "error", `sleep failed: ${String(error)}`);
      span.fail(error);
      throw error;
    }
  }

  private async doWake(cube: CubeRow): Promise<void> {
    const name = instanceName(cube.name);
    const net = networkForCube(cube.name, cube.subnetIndex);
    const span = this.span("wake", cube);
    try {
      const state = await this.backend.getState(name);
      if (state.status !== "Running") await this.backend.setState(name, "start");
      span.phase("start", state.status === "Running" ? "already running" : null);
      await this.backend.waitForNetwork(name, net.ip);
      span.phase("network");
      await this.startProxy(cube); // no-op if it survived the sleep
      // .cube/resume, then the wake hooks — which build on it, so a failed
      // resume skips them and its complaint takes the error field.
      const resumeError = await this.runLifecycleScript(cube, "resume");
      span.phase("resume", resumeError, resumeError === null);
      const hookError = resumeError ?? (await this.runWakeHooks(cube));
      if (resumeError === null) span.phase("hooks", hookError, hookError === null);
      // Touch first: a wake without it would be instantly re-slept by the
      // sweep (last_active_at still predates the idle cutoff).
      this.registry.touchCube(cube.name);
      // A failed hook does not brick the cube — it is up and usable; the
      // error field carries the complaint to the UI.
      this.registry.setCubeStatus(cube.name, "ready", this.lifecycle.read(cube.name, "setup")?.error ?? hookError);
      span.end(true, hookError ? "ready with hook complaint" : "ready");
    } catch (error) {
      // A failed retry of an errored cube keeps the original complaint —
      // that is the root cause; "instance not found" on top of it is not.
      const detail = cube.status === "error" && cube.error ? cube.error : `wake failed: ${String(error)}`;
      this.registry.setCubeStatus(cube.name, "error", detail);
      span.fail(error);
      throw error;
    }
  }

  /** Run wake hooks in order; first failure aborts the rest (they may build
   * on each other). Returns an error description, or null if all passed. */
  private async runWakeHooks(cube: CubeRow): Promise<string | null> {
    let hooks: string[];
    try {
      hooks = readWakeHooks(environmentDirs(cube).host);
    } catch (error) {
      return String(error);
    }
    const sandbox = this.backend.sandbox(instanceName(cube.name));
    for (const hook of hooks) {
      let out = "";
      try {
        const { exitCode } = await sandbox.exec(hook, {
          cwd: "/workspace",
          // Keep only the tail: the hook file is agent-writable, so an
          // unbounded buffer is a host-memory exhaustion primitive
          // (`hooks = ["yes"]` streaming for 120s — sol review).
          onData: (chunk) => (out = (out + chunk.toString("utf8")).slice(-4096)),
          timeout: 120,
        });
        if (exitCode !== 0) {
          return `wake hook failed (exit ${exitCode}): ${hook} — ${out.slice(-500).trim()}`;
        }
      } catch (error) {
        return `wake hook failed: ${hook} — ${String(error)}`;
      }
    }
    return null;
  }

  private runLifecycleScript(cube: CubeRow, script: LifecyclePhase, signal?: AbortSignal): Promise<string | null> {
    return this.lifecycle.run(cube.name, this.backend.sandbox(instanceName(cube.name)), script, {
      signal, directory: environmentDirs(cube).guest,
    });
  }

  /** Lifecycle state + bounded logs per phase, and the environment directory
   * (guest path) the scripts came from. */
  environmentForUserThread(id: string): {
    setup: Partial<LifecycleResult> & { log: string };
    resume: Partial<LifecycleResult> & { log: string };
    directory: string;
    limits: { memory: string | null };
  } {
    const { cubeName } = this.resolveUserThread(id);
    const cube = this.requireCube(cubeName);
    const phase = (name: LifecyclePhase) => ({ ...this.lifecycle.read(cubeName, name), log: this.lifecycle.log(cubeName, name) });
    return {
      setup: phase("setup"), resume: phase("resume"), directory: environmentDirs(cube).guestAbsolute,
      limits: { memory: this.config.cubeMemory ?? null },
    };
  }

  /** Explicit in-place repair. Never publishes a working thread as a cache.
   * Reserve the same transition as provision/wake/remove before any await. */
  retrySetupForUserThread(id: string): Promise<void> {
    const { cubeName } = this.resolveUserThread(id);
    if (this.pendingTransition(cubeName) || this.gitOps.has(cubeName) || this.ensuring.has(cubeName)) {
      throw new Error("environment is busy — retry setup shortly");
    }
    const cube = this.requireCube(cubeName);
    this.registry.setCubeStatus(cubeName, "creating");
    // Cancellable like the first provision: a thread deleted mid-retry
    // aborts the guest script instead of waiting for it.
    const controller = new AbortController();
    const signal = controller.signal;
    this.provisioning.set(cubeName, controller);
    // The transition is registered synchronously with this promise; the
    // body's first host write already runs inside its guard.
    return this.transition(cubeName, (async () => {
      const span = this.span("retry-setup", cube);
      try {
        this.lifecycle.save(cubeName, "setup", { state: "running", startedAt: Date.now(), durationMs: null, error: null });
        const name = instanceName(cubeName);
        const state = await this.backend.getState(name);
        if (state.status !== "Running") await this.backend.setState(name, "start");
        await this.backend.waitForNetwork(name, networkForCube(cubeName, cube.subnetIndex).ip);
        signal.throwIfAborted();
        await this.startProxy(cube, signal);
        span.phase("start");
        const setupError = await this.runLifecycleScript(cube, "setup", signal);
        span.phase("setup", setupError, setupError === null);
        signal.throwIfAborted();
        const error = setupError ?? await this.runLifecycleScript(cube, "resume", signal);
        if (setupError === null) span.phase("resume", error, error === null);
        signal.throwIfAborted();
        this.registry.touchCube(cubeName);
        this.registry.setCubeStatus(cubeName, "ready", error);
        span.end(true, error ? "ready with setup complaint" : "ready");
      } catch (error) {
        const cancelled = signal.aborted;
        this.failLifecycle(cubeName, "setup", cancelled ? PROVISION_CANCELLED : String(error));
        this.registry.setCubeStatus(cubeName, "error", cancelled ? PROVISION_CANCELLED : String(error));
        if (cancelled) span.end(false, PROVISION_CANCELLED);
        else span.fail(error);
        throw error;
      } finally {
        if (this.provisioning.get(cubeName) === controller) this.provisioning.delete(cubeName);
      }
    })());
  }

  /** Close a still-running lifecycle record as failed. Best effort: the
   * host write that failed the operation may fail again here, and it is
   * the registry status, not this file, that keeps the thread deletable —
   * so a second failure is recorded as an event, never thrown. */
  private failLifecycle(name: string, phase: LifecyclePhase, error: string): void {
    try {
      const result = this.lifecycle.read(name, phase);
      if (result?.state === "running") this.lifecycle.save(name, phase, {
        ...result, state: "failed", durationMs: Date.now() - result.startedAt, error,
      });
    } catch (cause) {
      recordPoint(this.registry, {
        kind: "lifecycle", phase, cube: name, thread: this.threadIdFor(name), ok: false,
        detail: `the ${phase} result could not be recorded: ${describeError(cause)}`,
      });
    }
  }

  // --------------------------------------------------------------- services

  /** Full public origin for a portal hostname label. */
  portalUrl(label: string): string {
    const port = this.config.publicPort === 80 ? "" : `:${this.config.publicPort}`;
    return `http://${label}.${this.config.portalBase}${port}`;
  }

  /**
   * Ensure the declared services ([services.*] in .cube/cube.toml) of a
   * cube are running: wake it, then start whatever is missing as systemd
   * units and sync the portal registry. Concurrent ensures coalesce.
   */
  ensureCubeServices(cubeName: string, signal?: AbortSignal): Promise<ServiceStatus[]> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("service ensure aborted"));
    let inflight = this.ensuring.get(cubeName);
    if (!inflight) {
      const controller = new AbortController();
      inflight = {
        controller,
        waiters: 0,
        settled: false,
        promise: undefined as unknown as Promise<ServiceStatus[]>,
      };
      const entry = inflight;
      entry.promise = this.doEnsureServices(cubeName, controller.signal).finally(() => {
        entry.settled = true;
        if (this.ensuring.get(cubeName) === entry) this.ensuring.delete(cubeName);
      });
      this.ensuring.set(cubeName, entry);
    }

    // A portal request and code mode may share one ensure. Cancel the
    // underlying work only after every joined caller has gone away; one
    // disconnected client must not tear down work another still needs.
    inflight.waiters += 1;
    const entry = inflight;
    return new Promise<ServiceStatus[]>((resolve, reject) => {
      let finished = false;
      const finish = () => {
        if (finished) return false;
        finished = true;
        signal?.removeEventListener("abort", onAbort);
        entry.waiters -= 1;
        return true;
      };
      const onAbort = () => {
        if (!finish()) return;
        const reason = signal?.reason ?? new Error("service ensure aborted");
        reject(reason);
        if (entry.waiters === 0 && !entry.settled) entry.controller.abort(reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        (statuses) => {
          if (finish()) resolve(statuses);
        },
        (error) => {
          if (finish()) reject(error);
        },
      );
    });
  }

  private async doEnsureServices(cubeName: string, signal: AbortSignal): Promise<ServiceStatus[]> {
    const span = this.span("service", cubeName);
    try {
      signal.throwIfAborted();
      await this.wakeCube(cubeName);
      signal.throwIfAborted();
      const cube = this.requireCube(cubeName);
      const config = readCubeConfig(environmentDirs(cube).host); // parse errors -> caller
      this.registry.touchCube(cube.name);
      const net = networkForCube(cube.name, cube.subnetIndex);
      const statuses = await ensureServices(
        {
          cubeIp: net.ip,
          gatewayIp: net.gateway,
          portalBase: this.config.portalBase,
          publicUrl: (label) => this.portalUrl(label),
          execRoot: (cmd, execSignal) => this.backend.execSimple(instanceName(cube.name), cmd, execSignal),
          upsertPortal: (name, targetPort, hostname) =>
            this.registry.upsertPortal(cube.id, name, targetPort, hostname),
          releasePortal: (name) => this.registry.releasePortal(cube.id, name),
          listPortals: () => this.registry.listPortals(cube.id),
        },
        cube.name,
        config.services,
        { signal },
      );
      this.lastEnsure.set(cubeName, { statuses, error: null });
      const failed = statuses.filter((s) => s.state === "failed");
      span.end(
        failed.length === 0,
        statuses.length === 0
          ? "no services declared"
          : failed.length === 0
            ? statuses.map((s) => `${s.name}:${s.state}`).join(" ")
            : failed.map((s) => `${s.name}: ${s.detail ?? s.state}`).join("; "),
      );
      return statuses;
    } catch (error) {
      // An abort is the caller leaving, not an outcome.
      if (!signal.aborted) {
        this.lastEnsure.set(cubeName, { statuses: [], error: String(error) });
        span.fail(error);
      } else {
        span.end(true, "caller left before the ensure settled");
      }
      throw error;
    }
  }

  /** Why the most recent ensure left this service down — a start failure's
   * detail, or the error that stopped the ensure itself (wake, cube.toml).
   * Null when it is not known to be down. */
  serviceFailure(cubeName: string, serviceName: string): string | null {
    const last = this.lastEnsure.get(cubeName);
    if (!last) return null;
    if (last.error !== null) return last.error;
    const status = last.statuses.find((s) => s.name === serviceName);
    return status?.state === "failed" ? status.detail : null;
  }

  cubeStatus(cubeName: string): string | null {
    return this.registry.getCube(cubeName)?.status ?? null;
  }

  /** Activity the idle sweep must respect — a browsed portal counts like a prompt. */
  touchCube(cubeName: string): void {
    this.registry.touchCube(cubeName);
  }

  /**
   * A portal label that has no registry row yet, but which a cube's
   * committed `.cube/cube.toml` DOES declare -> that cube's name. Portal
   * rows only appear once services have been ensured; before the TUI (the
   * pty bridge) the agent created them by calling `services_ensure`, a tool
   * the cube extension does not carry. So a link the UI shows from the
   * declaration must be able to bootstrap its own portal — the caller
   * ensures the cube's services and re-resolves.
   */
  declaredPortalCube(label: string): string | null {
    // Labels are `<service>--<cube>`; cube names never contain "--".
    const split = label.lastIndexOf("--");
    if (split < 0) return null;
    const serviceName = label.slice(0, split);
    const cubeName = label.slice(split + 2);
    const cube = this.registry.getCube(cubeName);
    if (!cube) return null;
    try {
      return readCubeConfig(environmentDirs(cube).host).services.some((s) => s.name === serviceName)
        ? cube.name
        : null;
    } catch {
      return null; // unparseable declaration — not a portal we can bootstrap
    }
  }

  /** Host-header label -> live proxy target (null = no such portal). Does
   * not touch the cube: only a request that actually reaches the service is
   * activity, or a forgotten holding-page tab would keep it awake forever. */
  resolvePortal(label: string): PortalTargetInfo | null {
    const portal = this.registry.getPortalByHostname(label);
    if (!portal) return null;
    const cube = this.registry.getCubeById(portal.cubeId);
    if (!cube) return null;
    const net = networkForCube(cube.name, cube.subnetIndex);
    return {
      cubeName: cube.name,
      serviceName: portal.name,
      status: cube.status,
      ip: net.ip,
      port: portal.targetPort,
    };
  }

  /** Declared services + their stable URLs for a thread (reads only the
   * declaration and the portal naming scheme — no cube exec, works while
   * the thread sleeps). */
  listServicesForUserThread(id: string): Array<{ name: string; url: string }> {
    const { cubeName } = this.resolveUserThread(id);
    const cube = this.requireCube(cubeName);
    return readCubeConfig(environmentDirs(cube).host).services.map((service) => ({
      name: service.name,
      url: this.portalUrl(portalLabelFor(cube.name, service.name)),
    }));
  }

  /** Start/check this thread's declared services for the agent's code-mode
   * capability. Resolution through the user-facing thread id keeps callers
   * from naming or operating on sibling cubes. */
  ensureServicesForUserThread(id: string, signal?: AbortSignal): Promise<ServiceStatus[]> {
    const { cubeName } = this.resolveUserThread(id);
    return this.ensureCubeServices(cubeName, signal);
  }

  // ------------------------------------------------------------- git flow
  //
  // ARCHITECTURE §11: the workspace .git is host-side (bind-mounted), so review
  // works while the thread sleeps, and push/PR run with host credentials —
  // the agent's own `git push` dies on the egress boundary by design.

  /** Every repository attached to a thread, with independent live git state.
   * State is null until that checkout has finished seeding. */
  async repositoriesForUserThread(id: string): Promise<ThreadRepositoryInfo[]> {
    const { cubeName } = this.resolveUserThread(id);
    const cube = this.requireCube(cubeName);
    const repositories = this.registry.listCubeRepositories(cube.id);
    return Promise.all(
      repositories.map(async (repo, position) => ({
        id: repo.id,
        role: position === 0 ? "primary" as const : "additional" as const,
        checkoutName: repo.checkoutName,
        path: position === 0 ? "/workspace" : `../repos/${repo.checkoutName}`,
        url: repo.url,
        base: repo.base,
        branch: repo.branch,
        // null until provisioning has seeded it: a half-written clone
        // answers git with errors, not state (the UI showed that as a 500).
        state: cube.status !== "creating" && fs.existsSync(path.join(repo.workspacePath, ".git"))
          ? await this.withGitOp(cube.name, null, () => this.git.state(repo.workspacePath, repo.baseOid))
          : null,
      })),
    );
  }

  async readGithubForUserThread(id: string, input: { number: number; type: string; section?: string; page?: number }, signal?: AbortSignal) {
    const { cubeName } = this.resolveUserThread(id);
    const cube = this.requireCube(cubeName);
    const primary = this.registry.listCubeRepositories(cube.id)[0];
    if (!primary) throw new Error("thread has no primary repository");
    return readGithub(primary.url, input, signal);
  }

  /** Native stack review operations share the existing primary-repository
   * authorization and cube lifetime guard. Snapshots stay on the host. */
  async reviewPrForUserThread(
    id: string,
    repositoryId: number,
    input: { action: "prepare" | "prepare-rebase"; number: number } | { action: "plan" | "verify"; token: string } | { action: "publish"; token: string; plan: string } | { action: "inspect"; token: string; plan: string; number: number; section: "patch" | "prDiff"; page?: number },
    signal?: AbortSignal,
  ) {
    const { cube, repository } = this.primaryRepositoryForThread(id, repositoryId);
    // Planning and inspection use the local snapshot and need no GitHub
    // credentials. Preparation and publication/reconciliation remain online.
    if (input.action !== "inspect" && input.action !== "plan") await this.config.github?.ensureFresh();
    signal?.throwIfAborted();
    this.requireSeeded(cube, repository);
    return this.withGitOp(cube.name, `pr-review ${input.action}`, async () => {
      const { workspacePath: ws, url } = repository;
      switch (input.action) {
        case "prepare": return this.prReviews.prepare(ws, url, input.number, signal);
        case "prepare-rebase": return this.prReviews.prepareRebase(ws, url, input.number, signal);
        case "plan": return this.prReviews.plan(ws, url, input.token, signal);
        case "inspect": return this.prReviews.inspect(ws, url, input.token, input.plan, { number: input.number, section: input.section, page: input.page }, signal);
        case "publish": return this.prReviews.publish(ws, url, input.token, input.plan, signal);
        case "verify": return this.prReviews.verify(ws, url, input.token, signal);
      }
    });
  }

  /** Host-side review diff for one repository, separated into
   * committed, staged, unstaged, and untracked workspace changes. */
  async diffForUserThread(id: string, repositoryId: number): Promise<RepoDiff> {
    const { cube, repository } = this.repositoryForThread(id, repositoryId);
    this.requireSeeded(cube, repository);
    return this.withGitOp(cube.name, null, () => this.git.diff(repository.workspacePath, repository.baseOid));
  }

  /** Push the primary repository's current branch to its upstream (host creds). */
  async pushUserThread(id: string, repositoryId: number, signal?: AbortSignal): Promise<string> {
    const { cube, repository } = this.primaryRepositoryForThread(id, repositoryId);
    await this.config.github?.ensureFresh();
    signal?.throwIfAborted();
    this.requireSeeded(cube, repository);
    return this.withGitOp(cube.name, "push", () =>
      this.git.push(repository.workspacePath, repository.url, undefined, signal),
    );
  }

  /** Refresh origin/<base> through the host-owned mirror so the sandboxed
   * agent can rebase without receiving host network credentials. */
  async syncBaseForUserThread(
    id: string,
    repositoryId: number,
    signal?: AbortSignal,
  ): Promise<{ base: string; oid: string }> {
    const { cube, repository } = this.primaryRepositoryForThread(id, repositoryId);
    await this.config.github?.ensureFresh(); // agent-driven Ship runs long after the 8h token dies (sol Medium)
    signal?.throwIfAborted();
    this.requireSeeded(cube, repository);
    const oid = await this.withGitOp(cube.name, "sync", () =>
      this.git.syncBase(repository.workspacePath, repository.url, repository.base, signal),
    );
    return { base: repository.base, oid };
  }

  /** Publish HEAD to the repository's configured base. This is deliberately
   * non-forced; an upstream advance is returned to the agent as a rejection. */
  async pushBaseForUserThread(
    id: string,
    repositoryId: number,
    signal?: AbortSignal,
  ): Promise<{ branch: string; base: string }> {
    const { cube, repository } = this.primaryRepositoryForThread(id, repositoryId);
    await this.config.github?.ensureFresh(); // agent-driven Ship runs long after the 8h token dies (sol Medium)
    signal?.throwIfAborted();
    this.requireSeeded(cube, repository);
    const branch = await this.withGitOp(cube.name, "push-base", () =>
      this.git.push(repository.workspacePath, repository.url, repository.base, signal),
    );
    return { branch, base: repository.base };
  }

  /** Push, then open a PR via gh (host-side auth). Defaults the title to
   * the thread's own title — the user never has to invent one. */
  async createPrForUserThread(
    id: string,
    repositoryId: number,
    opts: { title?: string; body?: string },
    signal?: AbortSignal,
  ): Promise<{ url: string; branch: string }> {
    const { cube, repository } = this.primaryRepositoryForThread(id, repositoryId);
    await this.config.github?.ensureFresh();
    signal?.throwIfAborted();
    this.requireSeeded(cube, repository);
    const title =
      opts.title?.trim() ||
      this.registry.getThread(id)?.title ||
      repository.branch ||
      "cube changes";
    return this.withGitOp(cube.name, "pr", () =>
      this.git.createPr(
        repository.workspacePath,
        {
          url: repository.url,
          base: repository.base,
          title,
          body: opts.body,
        },
        signal,
      ),
    );
  }

  /** Reject review against a half-written clone: provisioning still
   * running, or (an errored provision) no clone at all. */
  private requireSeeded(cube: CubeRow, repository: CubeRepositoryRow): void {
    if (cube.status === "creating" || !fs.existsSync(path.join(repository.workspacePath, ".git"))) {
      throw new Error("thread environment is still setting up");
    }
  }

  /** Run a git operation registered against the cube so removeCube blocks
   * while a push/PR is mid-flight (a DELETE must not race a publish). */
  /** `label` names the operation in the event record; null for the
   * read-only reads the UI polls (state, diff), which are not recorded. */
  private async withGitOp<T>(cubeName: string, label: string | null, work: () => Promise<T>): Promise<T> {
    if (this.removing.has(cubeName)) throw new Error(`cube ${cubeName} is busy being removed`);
    const count = this.gitOps.get(cubeName) ?? 0;
    this.gitOps.set(cubeName, count + 1);
    const span = label === null ? null : this.span("git", cubeName);
    try {
      const result = await work();
      span?.end(true, label);
      return result;
    } catch (error) {
      span?.end(false, `${label}: ${describeError(error)}`);
      throw error;
    } finally {
      const now = (this.gitOps.get(cubeName) ?? 1) - 1;
      if (now <= 0) this.gitOps.delete(cubeName);
      else this.gitOps.set(cubeName, now);
    }
  }

  /** Resolve a repository id only inside the thread's own cube. */
  private repositoryForThread(
    id: string,
    repositoryId: number,
  ): { cube: CubeRow; repository: CubeRepositoryRow } {
    const { cubeName } = this.resolveUserThread(id);
    const cube = this.requireCube(cubeName);
    const repository = this.registry
      .listCubeRepositories(cube.id)
      .find((candidate) => candidate.id === repositoryId);
    if (!repository) throw new Error(`no such repository ${repositoryId} for thread ${id}`);
    return { cube, repository };
  }

  /** Additional checkouts are immutable references inside the sandbox and
   * never receive host credentials or publishing operations. */
  private primaryRepositoryForThread(
    id: string,
    repositoryId: number,
  ): { cube: CubeRow; repository: CubeRepositoryRow } {
    const result = this.repositoryForThread(id, repositoryId);
    const primary = this.registry.listCubeRepositories(result.cube.id)[0];
    if (result.repository.id !== primary?.id) {
      throw new Error("additional repositories are read-only references; only the primary repository can be published");
    }
    return result;
  }

  private async sweepIdle(): Promise<void> {
    const cutoff = Date.now() - this.config.idleMs;
    for (const cube of this.registry.listCubes()) {
      if (cube.status !== "ready" || cube.lastActiveAt > cutoff) continue;
      // Re-read next to the sleep call: the list is a snapshot, and a prompt
      // that completed while this loop awaited earlier cubes must not get
      // its cube slept right after being active (sleepCube itself rechecks
      // status and busy, but not idleness — manual sleeps ignore it).
      const fresh = this.registry.getCube(cube.name);
      if (!fresh || fresh.status !== "ready" || fresh.lastActiveAt > cutoff) continue;
      await this.sleepCube(cube.name, "idle").catch((error) => {
        console.log(`idle sleep ${cube.name}: ${String(error)}`);
      });
    }
  }

  /** Destroy the instance (and optionally volume+bridge) and forget the cube.
   * A cube still provisioning is cancelled first: the in-flight transition
   * is aborted and awaited, then the teardown runs against whatever the
   * provision left (an instance, or nothing yet). */
  async removeCube(name: string, opts: { deleteVolume?: boolean } = {}): Promise<void> {
    const cube = this.registry.getCube(name);
    if (!cube) throw new Error(`no such cube: ${name}`);
    if (this.removing.has(name)) throw new Error(`cube ${name} is busy (removal in flight) — retry shortly`);
    let cancelling: Promise<void> | null = null;
    if (cube.status === "creating" || cube.status === "building-environment") {
      // A builder has no thread and its own cleanup; a provision without a
      // controller is not ours to interrupt (none exist after boot, which
      // flips interrupted rows to asleep/error).
      const controller = this.provisioning.get(name);
      const inflight = this.transitions.get(name);
      if (cube.status === "building-environment" || (inflight && !controller)) {
        throw new Error(`cube ${name} is busy provisioning — retry once it is ready or errored`);
      }
      cancelling = inflight ?? null;
    } else if (this.transitions.has(name) || cube.status === "waking") {
      // A destroy racing a stop/start would orphan or resurrect the
      // instance mid-teardown.
      throw new Error(`cube ${name} is busy (sleep/wake/removal in flight) — retry shortly`);
    }
    // A push/PR mid-flight must finish (or be waited out) before teardown —
    // destroying the workspace under a running push could publish a partial
    // state or orphan the branch. withGitOp also rejects new ops once
    // `removing` is set below.
    if (this.gitOps.has(name)) throw new Error(`cube ${name} is busy pushing — retry shortly`);
    this.removing.add(name); // sync with the guards above: no await between
    // Cancel the provision only once the removal is reserved: nothing else
    // can now take the cube between the abort and the teardown.
    this.provisioning.get(name)?.abort(new Error("thread deleted"));
    // A portal-triggered ensure still polling readiness would otherwise keep
    // exec'ing into the instance being destroyed.
    this.ensuring.get(name)?.controller.abort(new Error(`cube ${name} is being removed`));
    this.lastEnsure.delete(name);
    // Thread id pinned now: deleteCube below cascades the thread row away.
    const span = new Span(this.registry, { kind: "destroy", cube: name, thread: this.threadIdFor(cube) });
    try {
      // The provision settles its own status and lifecycle record (as
      // cancelled); its failure is not this teardown's.
      if (cancelling) await cancelling.catch(() => {});
      await this.runtimes.get(name)?.proxy?.close();
      this.runtimes.delete(name);
      const net = networkForCube(name, cube.subnetIndex);
      try {
        await this.backend.destroy(
          { name: instanceName(name), pool: this.config.pool, network: { bridge: net.bridge } },
          { deleteVolume: opts.deleteVolume, deleteBridge: true },
        );
      } catch (error) {
        // The runtime side is already torn down; a "ready" row would invite
        // new threads with no proxy. Park it as error — DELETE can be retried.
        this.registry.setCubeStatus(name, "error", `destroy failed (retry DELETE): ${String(error)}`);
        span.fail(error);
        throw error;
      }
      this.registry.deleteCube(name);
      this.lifecycle.forget(name);
      // Deleting a thread destroys its workspace and history (PRODUCT.md):
      // the host-side tree — workspace, reference checkouts, pi sessions —
      // goes with it instead of accumulating under cubesRoot.
      let treeNote = "host tree";
      try {
        removeStoppedTree(path.dirname(cube.workspacePath));
      } catch (error) {
        // The row is gone; say so honestly instead of reporting a clean
        // removal. Boot names the leftover in an event until someone frees it.
        console.log(`cube ${name}: host tree not fully removed: ${String(error)}`);
        recordPoint(this.registry, { kind: "destroy", phase: "host-tree", cube: name, ok: false, detail: describeError(error) });
        treeNote = "host tree NOT fully removed (see destroy.host-tree)";
      }
      span.end(true, opts.deleteVolume ? `instance, volume, bridge and ${treeNote}` : `instance, bridge and ${treeNote}; volume kept`);
    } finally {
      this.removing.delete(name);
    }
  }

  // ---------------------------------------------------------------- threads

  listThreads(cubeName: string): Array<Pick<ThreadRow, "id" | "title" | "createdAt">> {
    const cube = this.requireCube(cubeName);
    return this.registry
      .listThreads(cube.id)
      .map(({ id, title, createdAt }) => ({ id, title, createdAt }));
  }

  // ------------------------------------------------- thread-first facade
  //
  // The product surface (decided 2026-08-27): the user-facing unit is the
  // THREAD — one thread per cube, cubes 100% invisible. Everything below
  // is the facade the UI/API build on; cube CRUD above stays as plumbing.

  /**
   * The Orbs-style "new thread": silently allocates a backing cube
   * (generated name the user never sees) after refreshing its repository
   * tips, starts provisioning, and returns the thread id. No pi session object
   * is created here — the thread's conversation lives in the pi TUI the pty bridge spawns on
   * first attach, against a session file path chosen NOW (pi creates the
   * file at that exact path on its first flush), so creating a thread
   * needs neither model credentials nor a sandbox.
   */
  /**
   * `requestKey` makes creation idempotent: a client-generated id for one
   * user action (a retried POST after a dropped connection, a double
   * submit, two tabs replaying one form) returns the thread the first
   * attempt created instead of allocating a second cube. Keys are scoped
   * to the project and remembered for CREATE_REQUEST_TTL_MS; `created` is
   * false on a replay.
   */
  async createUserThread(projectId: string, requestKey?: string): Promise<{ id: string; created: boolean }> {
    if (this.closing) throw new Error("server is stopping — start the thread again after restart");
    const key = requestKey === undefined ? null : `${projectId}\0${requestKey}`;
    if (key !== null) {
      // O(1) per request: the hit itself is checked for expiry and for a
      // thread that no longer exists; the sweep does the full scan.
      const prior = this.createRequests.get(key);
      if (prior && Date.now() - prior.at <= CREATE_REQUEST_TTL_MS && this.registry.getThread(prior.threadId)) {
        return { id: prior.threadId, created: false };
      }
      if (prior) this.createRequests.delete(key);
    }
    if (key === null) return this.createFreshUserThread(projectId, null);
    const pending = this.pendingCreates.get(key);
    if (pending) return { id: (await pending).id, created: false };
    if (this.pendingCreates.size >= CREATE_REQUEST_CAP) throw new Error("too many thread creations in progress — try again shortly");
    const creation = this.createFreshUserThread(projectId, key);
    this.pendingCreates.set(key, creation);
    try { return await creation; }
    finally { this.pendingCreates.delete(key); }
  }

  private async createFreshUserThread(projectId: string, key: string | null): Promise<{ id: string; created: boolean }> {
    const project = this.requireReadyProject(projectId);
    const preparation = this.prepareThreadRepositories(project);
    this.threadPreparations.add(preparation);
    let repositories: ProjectRepositoryRow[];
    try { repositories = await preparation; }
    finally { this.threadPreparations.delete(preparation); }
    if (this.closing) throw new Error("server is stopping — start the thread again after restart");
    // Recheck after the await as well: a project mutation may have run between
    // preparation's resolution and this continuation. Allocation is synchronous.
    if (this.requireReadyProject(projectId).revision !== project.revision) {
      throw new Error("project changed while refreshing repositories — start the thread again");
    }
    const cube = this.createProjectCube(this.freshCubeName(), repositories, project.environment);
    try {
      const sessionDir = path.join(this.config.cubesRoot, cube.name, "sessions");
      // The pty bridge (and provisioning) need these before either runs.
      fs.mkdirSync(cube.workspacePath, { recursive: true });
      fs.mkdirSync(sessionDir, { recursive: true });
      const id = crypto.randomUUID();
      this.registry.addThread({
        id,
        cubeId: cube.id,
        projectId: project.id,
        piSessionPath: path.join(sessionDir, `${id}.jsonl`),
      });
      if (key !== null) {
        // Bounded: past the cap the oldest key goes. A Map iterates in
        // insertion order and keys are inserted in time order, so the
        // front is the oldest — no scan.
        if (this.createRequests.size >= CREATE_REQUEST_CAP) {
          const oldest = this.createRequests.keys().next().value;
          if (oldest !== undefined) this.createRequests.delete(oldest);
        }
        this.createRequests.set(key, { threadId: id, at: Date.now() });
      }
      return { id, created: true };
    } catch (error) {
      // No thread row means no way for the user to see or delete the cube —
      // reap it once its (already started) provisioning settles.
      void this.reapOrphanCube(cube.name).catch((reapError) => {
        console.log(`orphan cube ${cube.name} not reaped: ${String(reapError)}`);
      });
      throw error;
    }
  }

  /** Forget creation keys past their window and keys whose thread has
   * since been deleted. From the minute sweep: expiry must not depend on
   * another request happening to arrive. Entries are in time order, so
   * the expiry scan stops at the first key still inside the window. */
  private sweepCreateRequests(): void {
    const cutoff = Date.now() - CREATE_REQUEST_TTL_MS;
    for (const [key, entry] of this.createRequests) {
      if (entry.at >= cutoff) break;
      this.createRequests.delete(key);
    }
    for (const [key, entry] of this.createRequests) {
      if (!this.registry.getThread(entry.threadId)) this.createRequests.delete(key);
    }
  }

  private async reapOrphanCube(name: string): Promise<void> {
    for (;;) {
      const inflight = this.transitions.get(name);
      if (!inflight) break;
      await inflight.catch(() => {});
    }
    await this.removeCube(name, { deleteVolume: true });
  }

  /** Internal cube names: "t-" + 8 base36 chars (fits the 11-char cap). */
  private freshCubeName(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      const name = `t-${Math.random().toString(36).slice(2, 10).padEnd(8, "0")}`;
      if (!this.registry.getCube(name)) return name;
    }
    throw new Error("could not allocate a cube name");
  }

  private requireReadyProject(id: string): ProjectRow {
    const project = this.registry.getProject(id);
    if (!project) throw new Error(`no such project: ${id}`);
    if (project.status !== "ready") {
      throw new Error(`project ${project.name} is not ready (status: ${project.status})`);
    }
    const repositories = this.registry.listProjectRepositories(id);
    if (
      repositories.length === 0 ||
      repositories.some((repo) => repo.status !== "ready" || !repo.resolvedBase || !repo.baseOid)
    ) {
      throw new Error(`project ${project.name} is not ready`);
    }
    return project;
  }

  /** Flat, newest-first thread list across all cubes (the UI's home). */
  listUserThreads(includeArchived = false): UserThreadSummary[] {
    const threads: UserThreadSummary[] = [];
    for (const cube of this.registry.listCubes()) {
      for (const thread of this.registry.listThreads(cube.id)) {
        if (thread.archivedAt !== null && !includeArchived) continue;
        const project = this.registry.getProject(thread.projectId);
        if (!project) {
          // One orphaned row must not take the whole list (and the UI) down.
          console.log(`thread ${thread.id} has no project — hidden from the list`);
          continue;
        }
        const failedPhase = (["setup", "resume"] as const)
          .map((phase) => this.lifecycle.read(cube.name, phase))
          .find((result) => result?.state === "failed");
        threads.push({
          id: thread.id,
          title: thread.title ?? this.autoTitle(thread),
          state: failedPhase && cube.status !== "creating" ? "error" : threadState(cube.status),
          // The raw text stays in the registry for diagnosis; the list gets
          // one sentence with the next step. A failed lifecycle phase is the
          // diagnostic when the status column carries none (sleep clears it).
          error: describeThreadError(cube.error ?? failedPhase?.error ?? null),
          createdAt: thread.createdAt,
          archived: thread.archivedAt !== null,
          project: { id: project.id, name: project.name },
        });
      }
    }
    return threads.sort((a, b) => (b.createdAt ?? Infinity) - (a.createdAt ?? Infinity) || (a.id < b.id ? -1 : 1));
  }

  archiveUserThread(id: string): void {
    if (!this.registry.getThread(id)) throw new Error(`no such thread: ${id}`);
    this.registry.archiveThread(id);
  }

  /** Resolve a registered thread to its backing cube. */
  resolveUserThread(id: string): { cubeName: string; threadId: string } {
    const row = this.registry.getThread(id);
    if (row) {
      const cube = this.registry.getCubeById(row.cubeId);
      if (!cube) throw new Error(`no such thread: ${id}`);
      return { cubeName: cube.name, threadId: row.id };
    }
    throw new Error(`no such thread: ${id}`);
  }

  /** Deleting a thread destroys its backing cube — including the docker
   * volume (nothing user-visible refers to it); the workspace directory is
   * kept host-side as a safety net. Product threads are one-per-cube. */
  async removeUserThread(id: string): Promise<void> {
    const { cubeName } = this.resolveUserThread(id);
    await this.removeCube(cubeName, { deleteVolume: true });
  }

  /** Rename a thread. Manual titles stick: prompt() only auto-titles while
   * the title is still null. */
  renameUserThread(id: string, title: string): void {
    const { cubeName, threadId } = this.resolveUserThread(id);
    // requireCube: a rename racing the thread's teardown must 409, not
    // report ok against a row that is about to disappear.
    this.requireCube(cubeName);
    this.registry.setThreadTitle(threadId, title);
  }

  /** Host workspace directory backing a thread. File listing/serving is
   * host-side (the workspace is bind-mounted into the sandbox), so it
   * works without waking — a sleeping thread's files stay visible. */
  workspaceForUserThread(id: string): string {
    const { cubeName } = this.resolveUserThread(id);
    return this.requireCube(cubeName).workspacePath;
  }

  /** Host checkout directory for one repository selected inside a thread. */
  workspaceForUserRepository(id: string, repositoryId: number): string {
    return this.repositoryForThread(id, repositoryId).repository.workspacePath;
  }

  // ------------------------------------------------------------ pty bridge

  /**
   * Spawn plan for a thread's pi TUI (Phase 3d step 2): the real `pi`
   * binary with ONLY the cube extension, this thread's session file, and
   * the workspace cwd. Waits out provisioning first (pi must not discover
   * context from a half-seeded workspace); a sleeping cube is left asleep —
   * the extension wakes it on the first tool use. Errors thrown here reach
   * the user's terminal pane, so they speak thread vocabulary.
   */
  async terminalPlan(
    id: string,
    onStatus: (text: string) => void,
  ): Promise<{ argv: string[]; cwd: string; env: Record<string, string | undefined> }> {
    const { cubeName, threadId } = this.resolveUserThread(id);
    let cube = this.requireCube(cubeName);
    if (cube.status === "creating") {
      // Provisioning runs detached; wait it out (waking would retry a failed
      // provision against a missing instance and bury its error). The
      // events it records say which step is running: report each change so
      // a long .cube/setup reads as progress, not as a stuck spinner.
      let last = "";
      while ((cube = this.requireCube(cubeName)).status === "creating") {
        const text = this.provisionProgress(cube);
        if (text !== last) {
          onStatus(text);
          last = text;
        }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    if (cube.status === "error") {
      throw new Error(`environment error: ${cube.error ?? "unknown"}`);
    }
    const row = this.registry.getThread(threadId)!;
    const sessionPath = this.currentSessionFile(row);
    return {
      argv: [
        PI_BIN,
        "--no-extensions", // load-bearing: see the PI_BIN note above
        "--no-approve",
        // pi runs on the CREDENTIALED host with the (agent- and upstream-
        // controlled) workspace as cwd. Its context loader reads AGENTS.md/
        // CLAUDE.md host-side, following symlinks and ungated by project
        // trust — a workspace `AGENTS.md -> ~/.pi/agent/auth.json` would read
        // host creds straight into the prompt. Disable it: real work happens
        // over the cube-routed tools, never host-side context files.
        "--no-context-files",
        "-e", PI_EXTENSION,
        "--session", sessionPath,
        "--session-dir", path.dirname(row.piSessionPath),
      ],
      cwd: cube.workspacePath,
      env: {
        ...process.env,
        // The extension is a separate process and cannot infer/share cubed's
        // in-memory MockBackend. Tell it which execution adapter to create;
        // real Incus remains the default and fail-closed path.
        CUBE_BACKEND: this.backend.kind,
        CUBE_NAME: cube.name,
        CUBE_THREAD_ID: id,
        CUBE_HOST_WORKSPACE: cube.workspacePath,
        CUBE_GUEST_WORKSPACE: "/workspace",
        CUBED_URL: `http://127.0.0.1:${this.config.publicPort}`,
      },
    };
  }

  /**
   * Which session file this thread's TUI should open. Normally the registry
   * path — but pi owns its own session commands (`/new`, `/resume`), so a
   * user who starts a fresh session inside the TUI writes a DIFFERENT file
   * in the same directory; reattaching to the registry path would silently
   * resume the old conversation and orphan the new one. One thread owns the
   * cube and session directory, so its newest regular JSONL file is the
   * current conversation.
   */
  private currentSessionFile(row: ThreadRow): string {
    const dir = path.dirname(row.piSessionPath);
    let newest: { path: string; mtimeMs: number } | null = null;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return row.piSessionPath;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const file = path.join(dir, entry);
      try {
        // lstat, and regular files only: a symlink planted in this
        // directory must not redirect the session elsewhere on the host.
        const stat = fs.lstatSync(file);
        if (!stat.isFile()) continue;
        if (!newest || stat.mtimeMs > newest.mtimeMs) newest = { path: file, mtimeMs: stat.mtimeMs };
      } catch {
        continue;
      }
    }
    return newest?.path ?? row.piSessionPath;
  }

  /** Terminal I/O is activity: keep the idle sweep off a cube whose TUI is
   * mid-conversation (the extension re-wakes on tool use, but a sleep
   * would kill in-flight bash). */
  touchUserThread(id: string): void {
    try {
      const { cubeName } = this.resolveUserThread(id);
      if (this.registry.getCube(cubeName)) this.registry.touchCube(cubeName);
    } catch {
      // Thread deleted under a live terminal — nothing to touch.
    }
  }

  /**
   * First user message of the thread's session file -> title ("the user
   * never names anything" — prompt() used to do this; with the TUI, pi owns
   * prompting, so the title is read back from pi's own session JSONL).
   * Runs per thread-list poll while the title is null, so it must stay cheap
   * AND must not retry work that can never succeed: the session file is
   * append-only, so a HEAD that already exceeds the scan cap without a
   * usable first user message never will (huge pasted image, say) — give up
   * on it permanently rather than re-reading a megabyte every 3 seconds.
   */
  private autoTitle(row: ThreadRow): string | null {
    // The file the TUI actually writes (pi's own /new switches it). Keyed
    // by PATH, not thread: a /new session gets a fresh chance at a title.
    const sessionPath = this.currentSessionFile(row);
    if (this.untitlable.has(sessionPath)) return null;
    let head: string;
    let capped: boolean;
    try {
      const fd = fs.openSync(sessionPath, "r");
      try {
        const buf = Buffer.alloc(AUTO_TITLE_SCAN_BYTES);
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        capped = read === buf.length;
        head = buf.toString("utf8", 0, read);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return null; // not flushed yet
    }
    // Only COMPLETE lines: a trailing fragment (mid-append, or cut by the
    // cap) is not valid JSON and must not be mistaken for absent content.
    const lastBreak = head.lastIndexOf("\n");
    for (const line of (lastBreak < 0 ? "" : head.slice(0, lastBreak)).split("\n")) {
      let entry: { type?: string; message?: { role?: string; content?: unknown } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // header/noise line
      }
      if (entry?.type !== "message" || entry.message?.role !== "user") continue;
      const content = entry.message.content;
      const text =
        typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content
                .map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
                .join(" ")
            : "";
      const title = text.replace(/\s+/g, " ").trim().slice(0, 80);
      if (title) {
        this.registry.setThreadTitle(row.id, title);
        return title;
      }
      // A first user message with no text at all (image only): nothing to
      // title with, and the head never changes — stop scanning this file.
      this.untitlable.add(sessionPath);
      return null;
    }
    // No complete user entry within the cap. If the head filled the whole
    // cap, it never will (append-only) — otherwise the file is just young.
    if (capped) this.untitlable.add(sessionPath);
    return null;
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.threadPreparations]);
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    await Promise.all([...this.projectChecks.values()].map((check) => check.catch(() => {})));
    for (const runtime of this.runtimes.values()) await runtime.proxy?.close();
    this.runtimes.clear();
    // Proxies are closed: no more egress decisions arrive. Land the last
    // batch while the registry is still open; the timer must not fire later.
    this.flushEgress();
  }

  private runtime(name: string): CubeRuntime {
    let runtime = this.runtimes.get(name);
    if (!runtime) {
      runtime = { name, proxy: null, egressAllow: null };
      this.runtimes.set(name, runtime);
    }
    return runtime;
  }

  private requireCube(name: string): CubeRow {
    // Checked here so thread opens/creates can't start against a cube whose
    // teardown is between its awaits (the registry row still exists then).
    if (this.removing.has(name)) throw new Error(`cube ${name} is busy being removed`);
    const cube = this.registry.getCube(name);
    if (!cube || cube.status === "building-environment") throw new Error(`no such cube: ${name}`);
    return cube;
  }

  // Threads open on cubes in ANY status — even creating and error: pi
  // sessions are host-side, so creating/reopening one touches no sandbox.
  // Replay-without-waking is the point, prompt-before-ready needs threads
  // on provisioning cubes, and an errored cube's history must stay
  // readable. Only prompt() needs the cube up (via wakeCube, which settles
  // on provisioning and retries error cubes).
}

/** "5GiB" -> bytes (for the volume registry row). */
function parseSize(size: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KiB|MiB|GiB|TiB)$/i.exec(size.trim());
  if (!match) throw new Error(`unparseable size: ${size}`);
  const units: Record<string, number> = { b: 1, kib: 2 ** 10, mib: 2 ** 20, gib: 2 ** 30, tib: 2 ** 40 };
  return Math.round(Number(match[1]) * units[match[2]!.toLowerCase()]!);
}
