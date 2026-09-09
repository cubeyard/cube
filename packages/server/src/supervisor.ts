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
  type CubeBackend,
  type CubeProvisionSpec,
  type EgressProxy,
} from "@cube/sandbox";

import { readCubeConfig, readWakeHooks } from "./cube-toml.ts";
import { Span, describeError, recordPoint } from "./events.ts";
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
const PI_BIN = path.resolve(import.meta.dirname, "../../harness/node_modules/.bin/pi");
const PI_EXTENSION = path.resolve(import.meta.dirname, "../../pi-extension/src/index.ts");

/** How much of a session file's head autoTitle reads looking for the first
 * user message (the title source). Generous for prose, bounded against a
 * multi-megabyte pasted image. */
const AUTO_TITLE_SCAN_BYTES = 256 * 1024;

/** Built-in package-manager allowlist; per-cube .cube/cube.toml comes later. */
export const DEFAULT_EGRESS_ALLOW = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "archive.ubuntu.com",
  "security.ubuntu.com",
  // inner docker pulls (dockerd honors the proxy drop-in)
  "registry-1.docker.io",
  "auth.docker.io",
  "production.cloudflare.docker.com",
];

export interface SupervisorConfig {
  /** Per-cube host state root: <cubesRoot>/<name>/{workspace,sessions}. */
  cubesRoot: string;
  /** Bare-mirror root for checked project repositories (PLAN §11):
   * <reposRoot>/<repo>-<hash>.git. */
  reposRoot: string;
  pool: string;
  image: string;
  rootSize: string;
  dockerVolumeSize: string;
  egressAllow: string[];
  /** Idle-to-sleep timeout in ms off last_active_at (PLAN: default 1h).
   * <= 0 disables the idle sweep entirely. */
  idleMs: number;
  /** Portal hostname base (PLAN §10): portals live at
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
  state: "setting-up" | "ready" | "sleeping" | "error";
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

/** Cube status -> user-visible thread state. "waking" reads as ready — the
 * wake is transparent (a prompt just takes a moment longer). */
function threadState(cubeStatus: string): UserThreadSummary["state"] {
  if (cubeStatus === "creating") return "setting-up";
  if (cubeStatus === "asleep") return "sleeping";
  if (cubeStatus === "error") return "error";
  return "ready";
}

export class CubeSupervisor {
  private readonly registry: Registry;
  private readonly backend: CubeBackend;
  private readonly config: SupervisorConfig;
  private readonly git: GitService;
  private readonly prReviews: PrReviewService;
  private readonly runtimes = new Map<string, CubeRuntime>();
  // In-flight sleep/wake per cube. Status flips ("asleep"/"waking") happen
  // synchronously before the incus work, so concurrent callers observe the
  // transition and await this promise instead of racing a second stop/start.
  private readonly transitions = new Map<string, Promise<void>>();
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
  // tear a cube down while a push/PR is still publishing (PLAN §11).
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

  constructor(registry: Registry, backend: CubeBackend, config: SupervisorConfig) {
    this.registry = registry;
    this.backend = backend;
    this.config = config;
    this.git = new GitService(config.reposRoot);
    this.prReviews = new PrReviewService(config.reposRoot);
  }

  // ---------------------------------------------------------------- events

  /** Start a timed, phased record of one operation on a cube. */
  private span(kind: string, cube: CubeRow | string): Span {
    const name = typeof cube === "string" ? cube : cube.name;
    // Resolved per record: provisioning starts before the thread row lands.
    return new Span(this.registry, { kind, cube: name, thread: () => this.threadIdFor(name) });
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
    const pruned = this.registry.pruneEvents(EVENT_RETENTION_MS);
    recordPoint(this.registry, { kind: "boot", detail: `cubed start; pruned ${pruned} old events` });
    for (const cube of this.registry.listCubes()) {
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
        this.registry.setCubeStatus(cube.name, "asleep");
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
          this.registry.setCubeStatus(cube.name, "asleep");
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
    if (this.config.idleMs > 0 && !this.sweepTimer) {
      this.sweepTimer = setInterval(() => void this.sweepIdle(), 60_000);
      this.sweepTimer.unref();
    }
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

  createProject(input: { name: string; repositories: ProjectRepositoryInput[] }): ProjectInfo {
    const normalized = this.validateProjectInput(input);
    let project: ProjectRow;
    try {
      project = this.registry.createProject({
        id: crypto.randomUUID(),
        name: normalized.name,
        repositories: normalized.repositories.map((repo) => ({ id: crypto.randomUUID(), ...repo })),
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

  updateProject(
    id: string,
    input: { name: string; repositories: ProjectRepositoryInput[] },
  ): ProjectInfo {
    const normalized = this.validateProjectInput(input);
    let project: ProjectRow;
    try {
      project = this.registry.updateProject(id, {
        name: normalized.name,
        repositories: normalized.repositories.map((repo) => ({ id: crypto.randomUUID(), ...repo })),
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

  deleteProject(id: string): void {
    if (this.projectChecks.has(id)) throw new Error(`project ${id} is still checking`);
    this.registry.deleteProject(id);
  }

  private projectInfo(project: ProjectRow): ProjectInfo {
    return {
      ...project,
      repositories: this.registry.listProjectRepositories(project.id),
      threadCount: this.registry.countThreadsForProject(project.id),
    };
  }

  private validateProjectInput(input: {
    name: string;
    repositories: ProjectRepositoryInput[];
  }): {
    name: string;
    repositories: Array<{ url: string; base: string | null; checkoutName: string }>;
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
    return { name, repositories };
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

  // ------------------------------------------------------------------ cubes

  listCubes(): CubeSummary[] {
    const summaries: CubeSummary[] = [];
    for (const cube of this.registry.listCubes()) {
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
  private createProjectCube(name: string, repositories: ProjectRepositoryRow[]): CubeRow {
    if (this.registry.getCube(name)) throw new Error(`cube ${name} already exists`);
    const row = this.registry.createCube({
      name,
      image: this.config.image,
      workspacePath: path.join(this.config.cubesRoot, name, "workspace"),
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
    this.transition(row.name, this.provision(row)).catch(() => {});
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

  private async provision(cube: CubeRow): Promise<void> {
    const span = this.span("provision", cube);
    try {
      // Seed every workspace from the exact snapshots Project readiness
      // prepared. This path is deliberately local-only: auth/network failures
      // belong to the Project switchboard, not thread creation.
      const repositories = this.registry.listCubeRepositories(cube.id);
      for (const repo of repositories) {
        await this.git.seedPreparedWorkspace({
          url: repo.url,
          workspacePath: repo.workspacePath,
          base: repo.base,
          baseOid: repo.baseOid,
          branch: repo.branch,
          identity: this.config.github?.gitIdentity?.(),
        });
      }
      span.phase("seed", `${repositories.length} repositor${repositories.length === 1 ? "y" : "ies"}`);
      const spec = this.provisionSpec(cube);
      await this.backend.provision(spec);
      span.phase("instance");
      this.registry.addVolume({
        cubeId: cube.id,
        purpose: "docker",
        poolVolume: `${this.config.pool}/${spec.name}-docker`,
        capBytes: parseSize(this.config.dockerVolumeSize),
      });
      await this.startProxy(cube);
      span.phase("proxy");
      // .cube/setup (Amp convention): once, right after provisioning, for
      // the deps every cube of this repo needs. A failure surfaces on the
      // error field but the cube stays usable.
      const setupError = await this.runLifecycleScript(cube, "setup", 1200);
      span.phase("setup", setupError, setupError === null);
      this.registry.setCubeStatus(cube.name, "ready", setupError);
      span.end(true, setupError ? "ready with setup complaint" : "ready");
    } catch (error) {
      // provisionCube rolled the instance back; bridge/volume are reusable.
      this.registry.setCubeStatus(cube.name, "error", String(error));
      span.fail(error);
    }
  }

  private async startProxy(cube: CubeRow): Promise<void> {
    const runtime = this.runtime(cube.name);
    if (runtime.proxy) return;
    const net = networkForCube(cube.name, cube.subnetIndex);
    runtime.proxy = await this.backend.startEgressProxy({
      listenHost: net.gateway,
      port: EGRESS_PROXY_PORT,
      allow: this.config.egressAllow,
      allowSource: [net.ip],
      onDeny: (host, kind) => {
        console.log(`egress deny [${cube.name}] ${kind}: ${host}`);
        this.noteEgress(cube.name, "deny", kind, host);
      },
      onAllow: (host, kind) => this.noteEgress(cube.name, "allow", kind, host),
    });
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
    this.registry.setCubeStatus(name, "asleep");
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
        if (state.status === "Running") return;
        // Stopped under a ready row (agent-initiated poweroff, out-of-band
        // `incus stop`). Re-validate after the await, then demote to
        // asleep and loop into the normal wake path.
        if (this.pendingTransition(name)) continue;
        if (this.requireCube(name).status !== "ready") continue;
        this.registry.setCubeStatus(name, "asleep");
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
      const resumeError = await this.runLifecycleScript(cube, "resume", 120);
      span.phase("resume", resumeError, resumeError === null);
      const hookError = resumeError ?? (await this.runWakeHooks(cube));
      if (resumeError === null) span.phase("hooks", hookError, hookError === null);
      // Touch first: a wake without it would be instantly re-slept by the
      // sweep (last_active_at still predates the idle cutoff).
      this.registry.touchCube(cube.name);
      // A failed hook does not brick the cube — it is up and usable; the
      // error field carries the complaint to the UI.
      this.registry.setCubeStatus(cube.name, "ready", hookError);
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
      hooks = readWakeHooks(cube.workspacePath);
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

  /** Presence-based lifecycle script (`.cube/setup` / `.cube/resume`):
   * checked host-side (must be executable), run inside the cube as dev.
   * Returns a complaint string, or null (absent scripts are fine). */
  private async runLifecycleScript(
    cube: CubeRow,
    script: "setup" | "resume",
    timeoutSeconds: number,
  ): Promise<string | null> {
    try {
      fs.accessSync(path.join(cube.workspacePath, ".cube", script), fs.constants.X_OK);
    } catch {
      return null;
    }
    const sandbox = this.backend.sandbox(instanceName(cube.name));
    let out = "";
    try {
      const { exitCode } = await sandbox.exec(`./.cube/${script}`, {
        cwd: "/workspace",
        // Tail only — the script is agent-writable (same rationale as the
        // wake-hook buffer cap).
        onData: (chunk) => (out = (out + chunk.toString("utf8")).slice(-4096)),
        timeout: timeoutSeconds,
      });
      if (exitCode !== 0) {
        return `.cube/${script} failed (exit ${exitCode}): ${out.slice(-500).trim()}`;
      }
    } catch (error) {
      return `.cube/${script} failed: ${String(error)}`;
    }
    return null;
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
      const config = readCubeConfig(cube.workspacePath); // parse errors -> caller
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
      return readCubeConfig(cube.workspacePath).services.some((s) => s.name === serviceName)
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
    return readCubeConfig(cube.workspacePath).services.map((service) => ({
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
  // PLAN §11: the workspace .git is host-side (bind-mounted), so review
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
    input: { action: "prepare"; number: number } | { action: "plan" | "verify"; token: string } | { action: "publish"; token: string; plan: string } | { action: "inspect"; token: string; plan: string; number: number; section: "patch" | "prDiff"; page?: number },
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

  /** Destroy the instance (and optionally volume+bridge) and forget the cube. */
  async removeCube(name: string, opts: { deleteVolume?: boolean } = {}): Promise<void> {
    const cube = this.registry.getCube(name);
    if (!cube) throw new Error(`no such cube: ${name}`);
    if (cube.status === "creating") {
      // Destroying mid-provision would race the in-flight provisionCube
      // (its instance create/start could land after our delete, orphaning
      // the instance). Interrupted "creating" rows become "error" on the
      // next cubed boot and are deletable then.
      throw new Error(`cube ${name} is busy provisioning — retry once it is ready or errored`);
    }
    if (this.removing.has(name) || this.transitions.has(name) || cube.status === "waking") {
      // A destroy racing a stop/start (or a second DELETE) would orphan or
      // resurrect the instance mid-teardown.
      throw new Error(`cube ${name} is busy (sleep/wake/removal in flight) — retry shortly`);
    }
    // A push/PR mid-flight must finish (or be waited out) before teardown —
    // destroying the workspace under a running push could publish a partial
    // state or orphan the branch. withGitOp also rejects new ops once
    // `removing` is set below.
    if (this.gitOps.has(name)) throw new Error(`cube ${name} is busy pushing — retry shortly`);
    this.removing.add(name); // sync with the guards above: no await between
    // A portal-triggered ensure still polling readiness would otherwise keep
    // exec'ing into the instance being destroyed.
    this.ensuring.get(name)?.controller.abort(new Error(`cube ${name} is being removed`));
    this.lastEnsure.delete(name);
    // Thread id pinned now: deleteCube below cascades the thread row away.
    const span = new Span(this.registry, { kind: "destroy", cube: name, thread: this.threadIdFor(cube) });
    try {
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
      span.end(true, opts.deleteVolume ? "instance, volume and bridge" : "instance and bridge; volume kept");
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
   * (generated name the user never sees), starts provisioning, and returns
   * the thread id immediately. No pi session object is created here — the
   * thread's conversation lives in the pi TUI the pty bridge spawns on
   * first attach, against a session file path chosen NOW (pi creates the
   * file at that exact path on its first flush), so creating a thread
   * needs neither model credentials nor a sandbox.
   */
  async createUserThread(projectId: string): Promise<{ id: string }> {
    const project = this.requireReadyProject(projectId);
    const repositories = this.registry.listProjectRepositories(project.id);
    const cube = this.createProjectCube(this.freshCubeName(), repositories);
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
      return { id };
    } catch (error) {
      // No thread row means no way for the user to see or delete the cube —
      // reap it once its (already started) provisioning settles.
      void this.reapOrphanCube(cube.name).catch((reapError) => {
        console.log(`orphan cube ${cube.name} not reaped: ${String(reapError)}`);
      });
      throw error;
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
        if (!project) throw new Error(`thread ${thread.id} has no project`);
        threads.push({
          id: thread.id,
          title: thread.title ?? this.autoTitle(thread),
          state: threadState(cube.status),
          error: cube.error,
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
      onStatus("setting up this thread's environment…");
      // Provisioning runs detached; wait it out (waking would retry a failed
      // provision against a missing instance and bury its error).
      while ((cube = this.requireCube(cubeName)).status === "creating") {
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
      runtime = { name, proxy: null };
      this.runtimes.set(name, runtime);
    }
    return runtime;
  }

  private requireCube(name: string): CubeRow {
    // Checked here so thread opens/creates can't start against a cube whose
    // teardown is between its awaits (the registry row still exists then).
    if (this.removing.has(name)) throw new Error(`cube ${name} is busy being removed`);
    const cube = this.registry.getCube(name);
    if (!cube) throw new Error(`no such cube: ${name}`);
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
