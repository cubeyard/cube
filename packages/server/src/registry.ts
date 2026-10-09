/** Product metadata only. Pi's databases own conversations and execution. */
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ModelSelection } from "./models.ts";
import type { NodeBinding, TrustedRunnerHealth } from "./iroh-node.ts";
import type { ThreadAgent } from "./thread-events.ts";
import type { ThreadSkills } from "./skills.ts";
import { newPlaceholder } from "./egress-policy.ts";

/** The registry schema; older registries are refused (fresh CUBED_STATE). */
export const REGISTRY_SCHEMA = 102;

export const RUNNER_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/** A runner's report this young is trusted for placement without asking
 * again: twice the default probe interval. */
export const RUNNER_FRESH_MS = 2 * 60_000;
/** After a failed contact a runner is asked again no sooner than this, the
 * wait doubling with how long it has failed, up to RUNNER_RETRY_MAX_MS. */
export const RUNNER_RETRY_MIN_MS = 5_000;
export const RUNNER_RETRY_MAX_MS = 60_000;

/** How placement may use a runner, from cubed's last observation of it:
 * `ready`: it answered ready within RUNNER_FRESH_MS; `unverified`: no fresh
 * answer (never asked, too old, or a failure whose retry is due), so it is
 * asked before it gets a machine; `down`: its last contact failed or it was
 * not ready (draining, faulted, recovery required) and its retry is not due. */
export type RunnerFitness = "ready" | "unverified" | "down";
export function runnerFitness(observed: { lastAttemptAt: number | null; lastContactAt: number | null; unreachableSince: number | null;
  error: string | null; health: TrustedRunnerHealth | null }, now = Date.now()): { fitness: RunnerFitness; retryAt: number | null } {
  const { lastAttemptAt, lastContactAt, unreachableSince, error, health } = observed;
  if (!lastAttemptAt) return { fitness: "unverified", retryAt: null };
  if (error || !health) {
    const since = unreachableSince ?? lastAttemptAt;
    const retryAt = lastAttemptAt + Math.min(RUNNER_RETRY_MAX_MS, Math.max(RUNNER_RETRY_MIN_MS, lastAttemptAt - since));
    return { fitness: now < retryAt ? "down" : "unverified", retryAt };
  }
  if (health.lifecycle !== "ready" || health.draining) {
    const retryAt = (lastContactAt ?? lastAttemptAt) + RUNNER_RETRY_MAX_MS;
    return { fitness: now < retryAt ? "down" : "unverified", retryAt };
  }
  return { fitness: lastContactAt && now - lastContactAt <= RUNNER_FRESH_MS ? "ready" : "unverified", retryAt: null };
}
const FITNESS_ORDER: Record<RunnerFitness, number> = { ready: 0, unverified: 1, down: 2 };

export interface ProjectRepository {
  id: string; projectId: string; position: number; url: string; base: string | null;
  checkoutName: string; status: "checking" | "ready" | "error"; error: string | null;
  resolvedBase: string | null; baseOid: string | null; checkedAt: number | null;
}
/** The project's external hooks: scripts cube runs in every thread machine
 * before the repository's own `.agents/setup` and `.agents/resume`. Both run;
 * neither replaces the other. Not secret storage: a guest can read them. */
export interface ProjectHooks { preSetup: string; preResume: string }
export const NO_HOOKS: ProjectHooks = Object.freeze({ preSetup: "", preResume: "" });
/** Each hook is written into the machine's cloud-init seed. */
export const MAX_HOOK_BYTES = 16384;
/** The size a project's new thread machines ask for; absent fields use
 * cubed's defaults (CUBED_VM_VCPUS, CUBED_VM_MEMORY_MIB). Each runner
 * clamps them to its own limits. Fixed for a machine's life. */
export interface ProjectMachine { vcpus?: number; memoryMiB?: number }
export const MACHINE_VCPUS = { min: 1, max: 64 } as const;
export const MACHINE_MEMORY_MIB = { min: 1024, max: 256 * 1024 } as const;

/** Validates a project's machine size from the API; absent keeps `previous`,
 * null or {} uses cubed's defaults. */
export function projectMachine(input: unknown, previous: ProjectMachine = {}): ProjectMachine {
  if (input === undefined) return { ...previous };
  if (input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("machine must be an object");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== "vcpus" && key !== "memoryMiB")) throw new Error("machine has only vcpus and memoryMiB");
  const field = (name: "vcpus" | "memoryMiB", range: { min: number; max: number }) => {
    const given = value[name];
    if (given === undefined || given === null) return {};
    if (!Number.isSafeInteger(given) || (given as number) < range.min || (given as number) > range.max) {
      throw new Error(`machine.${name} must be a whole number from ${range.min} to ${range.max}`);
    }
    return { [name]: given as number };
  };
  return { ...field("vcpus", MACHINE_VCPUS), ...field("memoryMiB", MACHINE_MEMORY_MIB) };
}
export interface Project {
  id: string; name: string; status: "checking" | "ready" | "error"; error: string | null;
  revision: number; checkedAt: number | null; createdAt: number; updatedAt: number;
  repositories: ProjectRepository[];
  /** Absent: no hooks (projects saved before hooks existed). */
  hooks?: ProjectHooks;
  /** When the hooks last changed; absent: not since this was recorded. */
  hooksUpdatedAt?: number;
  /** The size of the project's new thread machines; absent: cubed's defaults. */
  machine?: ProjectMachine;
}
export interface Runner extends NodeBinding {
  configPath: string; configHash: string;
  /** The most thread machines the runner last said it hosts at once
   * (`maxActiveVms`); absent means one, as every runner before 0.7.0. */
  maxActiveVms?: number;
  /** The runner's last successful status report, kept when later probes
   * fail so a stale report can be shown as stale (runner-observe.ts). */
  report?: { at: number; health: TrustedRunnerHealth };
  /** The project this installation template belonged to before runners became
   * global. It is migration/audit context, never a scheduling constraint. */
  legacyProjectId?: string;
}
export interface WorkspaceRepository {
  url: string; base: string; baseOid: string; checkoutName: string;
}
/** Each of a project's repositories as resolved against its upstream for
 * one new thread (`git.prepareRepository`), in the project's order. */
export interface ResolvedRepositories {
  projectRevision: number; repositories: Array<{ url: string; base: string; baseOid: string }>;
  /** The skills resolved for the same thread (skills.ts). */
  skills?: ThreadSkills;
}
export interface WorkspaceAllocation {
  projectId: string; projectRevision: number; repositories: WorkspaceRepository[];
  /** The project's hooks when the thread was created; fixed for the thread. */
  hooks?: ProjectHooks;
  /** The project's machine size when the thread was created; fixed for the thread. */
  machine?: ProjectMachine;
  /** The skills resolved when the thread was created, installed in its
   * machine; absent for threads created before skills. */
  skills?: ThreadSkills;
}
export type RunnerAllocationState = "available" | "allocating" | "busy" | "releasing" | "failed" | "retiring" | "retired";
export type RunnerContactStatus = "unknown" | "reachable" | "unreachable" | "stale" | "retired";
export interface RunnerStatus {
  id: string; nodeId: string; environmentId: number;
  allocationState: RunnerAllocationState;
  /** The latest open thread on the runner; `threadIds` lists all of them. */
  threadId: string | null; threadIds: string[];
  /** Thread machines the runner hosts at once, and how many are taken. */
  maxActiveVms: number; activeThreads: number;
  allocationProjectId: string | null; allocationProjectName: string | null;
  contactStatus: RunnerContactStatus; enrolledAt: number | null; lastAttemptAt: number | null;
  lastContactAt: number | null; unreachableSince: number | null; error: string | null;
  health: TrustedRunnerHealth | null; retiredAt: number | null; retirementReason: string | null;
}
export interface Thread {
  id: string; projectId: string; title: string | null; createdAt: number;
  archived: boolean; model: ModelSelection; runnerId: string;
  /** The agent chosen at creation, fixed for the thread; absent means pi. */
  agent?: ThreadAgent;
  allocation: WorkspaceAllocation;
  workspaceState: "allocating" | "available" | "releasing" | "failed"; workspaceError: string | null;
  workspaceBase?: { remote: string; ref: string; oid: string } | null;
  /** The thread's machine, fixed at creation. */
  vm?: ThreadVm;
}
/** Where the thread's own machine stands on `thread.runnerId`:
 * `provisional`: no `vm.allocate` for it ever reached that runner, so the
 * thread may move; `requested`: one may have (written before it is sent), so
 * it moves only once that runner, after a fenced refusal, finds no machine;
 * `allocated`: the runner returned the machine, and the thread stays there. */
export type ThreadPlacement = "provisional" | "requested" | "allocated";
export interface ThreadVm {
  /** 16 hex characters: the runner's VM id and cloud-init instance-id. */
  vmId: string;
  /** Absent in threads created before placement was kept: see `placement()`. */
  placement?: ThreadPlacement;
  /** Secret placeholders by name; not secret. */
  placeholders: Record<string, string>;
  /** The last provisioning try (its key is `cube:provision:<n>`). */
  provisionAttempt?: number;
  /** Decided at archive: keep the machine's disk. */
  retain?: boolean;
  retainReason?: string;
  /** The retained disk was deleted on the operator's request. */
  discarded?: boolean;
  /** What the machine's disk was made from, decided before it was allocated. */
  preparation?: MachinePreparation;
  /** A template build machine of this thread that has not finished (see
   * vm-template.ts); it is cubed's own and released if it outlives a crash. */
  build?: { vmId: string; placeholders: Record<string, string>; key: string; runnerId?: string };
  /** The hooks' latest outcomes, by hook (`pre-setup`, `setup`, `pre-resume`, `resume`). */
  hooks?: Record<string, HookOutcome>;
  /** How long the machine took to become ready for the agent, by phase (ms). */
  startup?: { source: MachinePreparation["source"]; totalMs: number; phases: Record<string, number> };
  /** What cubed did to start the machine, step by step, oldest first (at
   * most `MAX_STARTUP_STEPS`): what the thread shows while it starts and
   * afterwards, failed tries included. */
  steps?: StartupStep[];
}
/** At most this many startup steps are kept per thread. */
export const MAX_STARTUP_STEPS = 40;
/** At most this much of a failed hook's log is kept on its step. */
export const STEP_LOG_BYTES = 4096;
/** `lookup`: is there a template for the project; `build-*`: a template
 * build machine; `boot`: the thread's machine boots until its guest answers;
 * `prepare`: checkout, pre-setup and setup (one try per `attempt`);
 * `resume`: the resume hooks. */
export type StartupStepName = "lookup" | "build-boot" | "build-prepare" | "build-seal" | "build-publish" | "boot" | "prepare" | "resume";
export interface StartupStep {
  name: StartupStepName;
  /** The preparation try (its command's key is `cube:provision:<attempt>`). */
  attempt?: number;
  /** `interrupted`: cubed stopped (or started the step again) before it ended. */
  state: "running" | "ok" | "failed" | "interrupted";
  startedAt: number; endedAt?: number;
  /** What the step found or why it failed, in a few words. */
  detail?: string;
  /** The end of the failed hook's log (escaped, redacted, at most
   * `STEP_LOG_BYTES`): kept because a build machine's disk goes with it. */
  log?: string;
  /** Only in the thread list, which leaves `log` out: the step has one. */
  hasLog?: boolean;
  /** The memory of cubed's command when it ended, from the guest (the
   * command's own peak, the machine's memory, and how many of its processes
   * the kernel killed for want of memory). */
  memory?: CommandMemory;
}
export interface CommandMemory { peakBytes: number; totalBytes: number; oomKills: number }
export interface MachinePreparation {
  /** `template`: the disk is backed by a prepared template; `fresh`: by the base image. */
  source: "template" | "fresh";
  templateId?: string;
  /** The template's `.agents/setup` blob, compared after the checkout. */
  setupBlob?: string;
  /** Why the machine started fresh (no template, templates off, a failed build). */
  reason?: string;
  /** The template's seal reported a failure; the template was removed. */
  sealFailure?: string;
}
export interface HookOutcome {
  /** `ok`, `failed`, `skipped` (prepared by a template), `notrun` (an
   * earlier hook of its phase failed) or `absent`. */
  status: "ok" | "failed" | "skipped" | "notrun" | "absent";
  exitCode?: number; ms: number; at: number;
}

/** Validates hooks from the API; absent fields keep `previous`. */
export function projectHooks(input: unknown, previous: ProjectHooks = NO_HOOKS): ProjectHooks {
  if (input === undefined || input === null) return { ...previous };
  if (typeof input !== "object" || Array.isArray(input)) throw new Error("hooks must be an object");
  const value = input as Record<string, unknown>;
  const hook = (name: "preSetup" | "preResume") => {
    const text = value[name];
    if (text === undefined) return previous[name];
    if (typeof text !== "string" || text.includes("\0") || Buffer.byteLength(text) > MAX_HOOK_BYTES) {
      throw new Error(`hooks.${name} must be a script of at most ${MAX_HOOK_BYTES} bytes`);
    }
    return text.trim() ? text.replace(/\r\n/g, "\n") : "";
  };
  if (Object.keys(value).some(key => key !== "preSetup" && key !== "preResume")) throw new Error("hooks has only preSetup and preResume");
  return { preSetup: hook("preSetup"), preResume: hook("preResume") };
}

/** The thread's placement; a thread from before placement was kept counts
 * as allocated once its machine was ready and as requested before that. */
export function placement(thread: Pick<Thread, "vm" | "workspaceState">): ThreadPlacement {
  return thread.vm?.placement ?? (thread.workspaceState === "available" ? "allocated" : "requested");
}

/** The thread's agent: claude-code threads are created with a claude model. */
export function threadAgent(thread: Pick<Thread, "agent">): ThreadAgent { return thread.agent ?? "pi"; }

/** The machines a runner hosts at once, as cubed last learned it. */
export function runnerSlots(runner: Pick<Runner, "maxActiveVms">): number {
  return Number.isSafeInteger(runner.maxActiveVms) && runner.maxActiveVms! >= 1 ? runner.maxActiveVms! : 1;
}

/** Every open (unarchived) thread holds one machine slot on its runner from
 * creation until its release finishes, whatever its workspace state: a failed
 * or releasing machine may still exist on the runner. */
const OPEN_THREAD = "json_extract(data, '$.archived')=0";

function allocationRepositories(project: Project, strict: boolean): WorkspaceRepository[] {
  const repositories: WorkspaceRepository[] = [];
  const checkoutNames = new Set<string>();
  for (const repository of project.repositories) {
    if (repository.status !== "ready" || !repository.resolvedBase || !repository.baseOid) {
      if (strict) throw new Error("check the project before starting a thread");
      continue;
    }
    let checkoutName = repositories.length === 0 ? "workspace" : repository.checkoutName;
    if (checkoutNames.has(checkoutName)) {
      const base = `repo-${repository.position + 1}`;
      checkoutName = base;
      for (let suffix = 2; checkoutNames.has(checkoutName); suffix++) checkoutName = `${base}-${suffix}`;
    }
    checkoutNames.add(checkoutName);
    repositories.push({ url: repository.url, base: repository.resolvedBase, baseOid: repository.baseOid, checkoutName });
  }
  return repositories;
}

function observation(row: Record<string, unknown>) {
  const at = (value: unknown) => value == null ? null : Number(value);
  return { lastAttemptAt: at(row.last_attempt_at), lastContactAt: at(row.last_contact_at), unreachableSince: at(row.unreachable_since),
    error: row.last_error == null ? null : String(row.last_error),
    health: row.health == null ? null : JSON.parse(String(row.health)) as TrustedRunnerHealth };
}

export class Registry {
  private readonly db: DatabaseSync;
  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec("PRAGMA busy_timeout=5000");
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const version = this.db.prepare("PRAGMA user_version").get()!.user_version;
      // Protocol-2 runners, their workspaces and threads are not migrated.
      if (tables.length && version !== REGISTRY_SCHEMA) throw new Error("legacy or unsupported registry: choose a fresh CUBED_STATE directory");
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS project(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runner(id TEXT PRIMARY KEY, project_id TEXT REFERENCES project(id),
          node_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, state TEXT NOT NULL, thread_id TEXT, error TEXT);
        CREATE TABLE IF NOT EXISTS thread(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id),
          runner_id TEXT NOT NULL REFERENCES runner(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS creation(project_id TEXT NOT NULL, request_id TEXT NOT NULL,
          thread_id TEXT NOT NULL REFERENCES thread(id), payload TEXT NOT NULL, PRIMARY KEY(project_id, request_id));
        CREATE TABLE IF NOT EXISTS runner_operator(runner_id TEXT PRIMARY KEY REFERENCES runner(id), enrolled_at INTEGER,
          last_attempt_at INTEGER, last_contact_at INTEGER, unreachable_since INTEGER, last_error TEXT, health TEXT,
          retiring_at INTEGER, retired_at INTEGER, retirement_reason TEXT);
        CREATE TABLE IF NOT EXISTS runner_audit(id INTEGER PRIMARY KEY, runner_id TEXT NOT NULL REFERENCES runner(id),
          action TEXT NOT NULL, at INTEGER NOT NULL, evidence TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS thread_open ON thread(json_extract(data, '$.archived'), runner_id);
        PRAGMA user_version=${REGISTRY_SCHEMA};`);
      this.db.exec(`UPDATE runner SET state='available',error=NULL WHERE state='failed' AND thread_id IS NULL
          AND id IN (SELECT runner_id FROM runner_operator WHERE retiring_at IS NOT NULL AND retired_at IS NULL);
        UPDATE runner_operator SET retiring_at=NULL WHERE retiring_at IS NOT NULL AND retired_at IS NULL;`);
    } catch (error) { this.db.close(); throw error; }
  }
  private parse<T>(row: unknown): T | null {
    return row ? JSON.parse((row as { data: string }).data) as T : null;
  }
  getProject(id: string): Project | null { return this.parse(this.db.prepare("SELECT data FROM project WHERE id=?").get(id)); }
  listProjects(): Project[] { return this.db.prepare("SELECT data FROM project").all().map(row => this.parse<Project>(row)!); }
  saveProject(project: Project): void {
    this.db.prepare("INSERT INTO project VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(project.id, JSON.stringify(project));
  }
  /** Replaces only the project's hooks (project-hooks.ts), in one
   * transaction, if they differ; its repositories, revision and check stay
   * as they are. */
  saveProjectHooks(id: string, hooks: ProjectHooks): Project {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const project = this.getProject(id);
      if (!project) throw new Error("project not found");
      if ((project.hooks?.preSetup ?? "") !== hooks.preSetup || (project.hooks?.preResume ?? "") !== hooks.preResume) {
        const now = Date.now();
        this.saveProject({ ...project, hooks: { preSetup: hooks.preSetup, preResume: hooks.preResume }, updatedAt: now, hooksUpdatedAt: now });
      }
      this.db.exec("COMMIT");
      // What the registry now holds, read again.
      return this.getProject(id)!;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  deleteProject(id: string): void {
    if (this.db.prepare("SELECT 1 FROM thread WHERE project_id=?").get(id)) throw new Error("project still has retained thread history");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE runner SET project_id=NULL WHERE project_id=?").run(id);
      this.db.prepare("DELETE FROM project WHERE id=?").run(id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  enrollRunner(runner: Runner): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO runner VALUES (?,?,?,?,?,?,?)").run(runner.threadId, null, runner.nodeId, JSON.stringify(runner), "available", null, null);
      this.db.prepare("INSERT INTO runner_operator(runner_id,enrolled_at) VALUES (?,?)").run(runner.threadId, Date.now());
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  runner(threadId: string): Runner | null {
    return this.parse(this.db.prepare("SELECT r.data FROM runner r JOIN thread t ON t.runner_id=r.id WHERE t.id=?").get(threadId));
  }
  listRunners(): Runner[] {
    return this.db.prepare("SELECT data FROM runner ORDER BY rowid").all().map(row => this.parse<Runner>(row)!);
  }
  getRunner(id: string): Runner | null { return this.parse(this.db.prepare("SELECT data FROM runner WHERE id=?").get(id)); }
  /** Runners that can take a thread now, in allocation order. */
  availableRunners(): Runner[] {
    return this.runnerLoads().filter(load => load.active < load.slots).map(load => load.runner);
  }
  /** Free and total thread machine slots of the allocatable pool, and how
   * many runners have a free one. */
  runnerSlots(): { free: number; total: number; runners: number } {
    const loads = this.runnerLoads();
    return { free: loads.reduce((sum, load) => sum + Math.max(0, load.slots - load.active), 0),
      total: loads.reduce((sum, load) => sum + load.slots, 0), runners: loads.filter(load => load.active < load.slots).length };
  }
  /** Allocatable runners with their open threads: by fitness (ready, then
   * unverified, then down), then runners with a failed machine last, then
   * the least loaded, then enrollment order. */
  private runnerLoads(now = Date.now()): Array<{ id: string; runner: Runner; slots: number; active: number; failed: number; fitness: RunnerFitness }> {
    // One pass over the open threads (index thread_open), not per runner.
    const rows = this.db.prepare(`SELECT r.id,r.data,coalesce(t.active,0) AS active,coalesce(t.failed,0) AS failed,
        o.last_attempt_at,o.last_contact_at,o.unreachable_since,o.last_error,o.health
      FROM runner r JOIN runner_operator o ON o.runner_id=r.id
      LEFT JOIN (SELECT runner_id,count(*) AS active,sum(json_extract(data, '$.workspaceState')='failed') AS failed
        FROM thread WHERE ${OPEN_THREAD} GROUP BY runner_id) t ON t.runner_id=r.id
      WHERE o.retired_at IS NULL AND o.retiring_at IS NULL AND r.state<>'retired' ORDER BY r.rowid`).all() as Array<Record<string, unknown>>;
    return rows.map(row => {
      const runner = JSON.parse(String(row.data)) as Runner;
      const { fitness } = runnerFitness(observation(row), now);
      return { id: String(row.id), runner, slots: runnerSlots(runner), active: Number(row.active), failed: Number(row.failed), fitness };
    }).sort((a, b) => FITNESS_ORDER[a.fitness] - FITNESS_ORDER[b.fitness] || Number(a.failed > 0) - Number(b.failed > 0)
      || a.active / a.slots - b.active / b.slots || (b.slots - b.active) - (a.slots - a.active));
  }
  /** A runner's last observation and what placement may do with it. */
  runnerFitness(id: string, now = Date.now()): { fitness: RunnerFitness; retryAt: number | null; lastContactAt: number | null; unreachableSince: number | null; error: string | null; health: TrustedRunnerHealth | null; retired: boolean } | null {
    const row = this.db.prepare("SELECT last_attempt_at,last_contact_at,unreachable_since,last_error,health,retired_at FROM runner_operator WHERE runner_id=?").get(id);
    if (!row) return null;
    const observed = observation(row);
    return { ...runnerFitness(observed, now), lastContactAt: observed.lastContactAt, unreachableSince: observed.unreachableSince, error: observed.error, health: observed.health,
      retired: row.retired_at != null };
  }
  /** Moves an open thread whose machine was never allocated to another
   * runner with a free slot that is not down and not in `exclude`. Only a
   * `provisional` thread moves: nothing of its own machine reached its runner
   * (the caller also checks nothing is bound to that runner). Counting and
   * moving in one IMMEDIATE transaction is the new slot's reservation and
   * the old one's release. Returns the new runner's id, or null when none
   * can take it. */
  relocateThread(threadId: string, exclude: ReadonlySet<string> = new Set(), now = Date.now()): string | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const thread = this.getThread(threadId);
      if (!thread || thread.archived || thread.workspaceState === "available" || thread.workspaceState === "releasing" || placement(thread) !== "provisional") {
        this.db.exec("COMMIT");
        return null;
      }
      const load = this.runnerLoads(now).find(candidate => candidate.id !== thread.runnerId && !exclude.has(candidate.id)
        && candidate.fitness !== "down" && candidate.active < candidate.slots);
      if (!load) { this.db.exec("COMMIT"); return null; }
      const moved: Thread = { ...thread, runnerId: load.id, ...(thread.vm ? { vm: { ...thread.vm, placement: "provisional" } } : {}) };
      this.db.prepare("UPDATE thread SET runner_id=?,data=? WHERE id=?").run(load.id, JSON.stringify(moved), threadId);
      this.syncRunner(thread.runnerId);
      this.syncRunner(load.id);
      this.db.exec("COMMIT");
      return load.id;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Records the runner's advertised `maxActiveVms` (enrollment, a status
   * check, a machine start). A bound below its open threads only stops new
   * allocations; the runner itself refuses machines beyond it. */
  recordRunnerSlots(id: string, maxActiveVms: number): void {
    if (!Number.isSafeInteger(maxActiveVms) || maxActiveVms < 1) throw new Error("maxActiveVms must be a positive integer");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const runner = this.getRunner(id);
      if (!runner) throw new Error("runner not found");
      if (runner.maxActiveVms !== maxActiveVms) {
        this.db.prepare("UPDATE runner SET data=? WHERE id=?").run(JSON.stringify({ ...runner, maxActiveVms }), id);
        this.syncRunner(id);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Keeps the runner row's `state`, `thread_id` and `error` a summary of its
   * open threads in the shape a one-machine runner always had: `available`
   * while a slot is free, otherwise the latest thread's state. Allocation
   * counts the threads themselves; the summary keeps retirement guards and a
   * registry reopened by an older cubed consistent. Inside a transaction. */
  private syncRunner(id: string): void {
    const runner = this.getRunner(id);
    if (!runner) return;
    const open = this.db.prepare(`SELECT data FROM thread WHERE runner_id=? AND ${OPEN_THREAD} ORDER BY rowid`).all(id).map(row => this.parse<Thread>(row)!);
    const latest = open.at(-1);
    const state: RunnerAllocationState = !latest || open.length < runnerSlots(runner) ? "available"
      : latest.workspaceState === "available" ? "busy" : latest.workspaceState;
    this.db.prepare(`UPDATE runner SET state=?,thread_id=?,error=? WHERE id=? AND state<>'retired'
        AND id NOT IN (SELECT runner_id FROM runner_operator WHERE retiring_at IS NOT NULL OR retired_at IS NOT NULL)`)
      .run(state, latest?.id ?? null, state === "failed" ? latest?.workspaceError ?? null : null, id);
  }
  runnerCount(): number {
    return Number(this.db.prepare("SELECT count(*) AS n FROM runner").get()!.n);
  }
  /** Runner states, thread machine slots and the errors of failed machines
   * that still hold a slot. */
  runnerCapacity(slots = this.runnerSlots()): { states: Record<RunnerAllocationState, number>; slots: { free: number; total: number }; errors: string[] } {
    const states: Record<RunnerAllocationState, number> = { available: 0, allocating: 0, busy: 0, releasing: 0, failed: 0, retiring: 0, retired: 0 };
    const rows = this.db.prepare(`SELECT CASE WHEN o.retiring_at IS NOT NULL AND o.retired_at IS NULL THEN 'retiring' ELSE r.state END AS state
      FROM runner r JOIN runner_operator o ON o.runner_id=r.id`).all() as Array<{ state: RunnerAllocationState }>;
    for (const row of rows) states[row.state]++;
    const failed = this.db.prepare(`SELECT json_extract(data, '$.workspaceError') AS error FROM thread
      WHERE ${OPEN_THREAD} AND json_extract(data, '$.workspaceState')='failed' ORDER BY rowid DESC`).all() as Array<{ error: string | null }>;
    return { states, slots: { free: slots.free, total: slots.total }, errors: failed.flatMap(row => row.error ? [String(row.error)] : []) };
  }
  runnerStatuses(now = Date.now()): RunnerStatus[] {
    const rows = this.db.prepare(`SELECT r.id,r.node_id,r.data,r.state,r.thread_id,
      t.project_id AS allocation_project_id,json_extract(p.data, '$.name') AS allocation_project_name,
      o.enrolled_at,o.last_attempt_at,o.last_contact_at,o.unreachable_since,o.last_error,o.health,o.retiring_at,o.retired_at,o.retirement_reason
      FROM runner r JOIN runner_operator o ON o.runner_id=r.id
      LEFT JOIN thread t ON t.id=r.thread_id LEFT JOIN project p ON p.id=t.project_id ORDER BY r.rowid`).all() as Array<Record<string, unknown>>;
    const open = this.db.prepare(`SELECT id,runner_id FROM thread WHERE ${OPEN_THREAD} ORDER BY rowid`).all() as Array<{ id: string; runner_id: string }>;
    return rows.map(row => {
      const runner = JSON.parse(String(row.data)) as Runner;
      const threadIds = open.filter(thread => thread.runner_id === row.id).map(thread => thread.id);
      const retiringAt = row.retiring_at == null ? null : Number(row.retiring_at);
      const retiredAt = row.retired_at == null ? null : Number(row.retired_at);
      const lastAttemptAt = row.last_attempt_at == null ? null : Number(row.last_attempt_at);
      const lastContactAt = row.last_contact_at == null ? null : Number(row.last_contact_at);
      const unreachableSince = row.unreachable_since == null ? null : Number(row.unreachable_since);
      const error = row.last_error == null ? null : String(row.last_error);
      const contactStatus: RunnerContactStatus = retiredAt ? "retired"
        : !lastAttemptAt ? "unknown"
        : !error && row.health != null ? "reachable"
        : unreachableSince && now - unreachableSince >= RUNNER_STALE_AFTER_MS ? "stale"
        : "unreachable";
      return { id: String(row.id), nodeId: String(row.node_id), environmentId: runner.environmentId,
        allocationState: retiringAt && !retiredAt ? "retiring" : String(row.state) as RunnerAllocationState,
        threadId: row.thread_id == null ? null : String(row.thread_id), threadIds,
        maxActiveVms: runnerSlots(runner), activeThreads: threadIds.length,
        allocationProjectId: row.allocation_project_id == null ? null : String(row.allocation_project_id),
        allocationProjectName: row.allocation_project_name == null ? null : String(row.allocation_project_name),
        contactStatus, enrolledAt: row.enrolled_at == null ? null : Number(row.enrolled_at), lastAttemptAt, lastContactAt,
        unreachableSince, error, health: row.health == null ? null : JSON.parse(String(row.health)) as TrustedRunnerHealth,
        retiredAt, retirementReason: row.retirement_reason == null ? null : String(row.retirement_reason) };
    });
  }
  recordRunnerProbe(id: string, result: { health: TrustedRunnerHealth } | { error: string }, at = Date.now()): void {
    const success = "health" in result;
    // The probe and its kept report land together (runner-observe.ts).
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const updated = this.db.prepare(`UPDATE runner_operator SET last_attempt_at=?,
        last_contact_at=CASE WHEN ? THEN ? ELSE last_contact_at END,
        unreachable_since=CASE WHEN ? THEN NULL ELSE coalesce(unreachable_since,?) END,
        last_error=?, health=? WHERE runner_id=? AND retired_at IS NULL`).run(
        at, success ? 1 : 0, at, success ? 1 : 0, at, success ? null : result.error,
        success ? JSON.stringify(result.health) : null, id);
      if (updated.changes !== 1) throw new Error("runner not found or already retired");
      if (success) this.db.prepare("UPDATE runner SET data=json_set(data,'$.report',json(?)) WHERE id=?").run(JSON.stringify({ at, health: result.health }), id);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    if (success) this.recordRunnerSlots(id, result.health.maxActiveVms);
  }
  beginRunnerRetirement(id: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.db.prepare(`UPDATE runner SET state='failed',error=NULL
        WHERE id=? AND state='available' AND thread_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM thread WHERE runner_id=runner.id AND json_extract(data, '$.archived')=0)
          AND id IN (SELECT runner_id FROM runner_operator WHERE retiring_at IS NULL AND retired_at IS NULL)`).run(id);
      if (changed.changes !== 1) throw new Error("runner has an active global allocation or workspace and cannot be retired");
      const reserved = this.db.prepare("UPDATE runner_operator SET retiring_at=? WHERE runner_id=? AND retiring_at IS NULL AND retired_at IS NULL").run(Date.now(), id);
      if (reserved.changes !== 1) throw new Error("runner retirement reservation changed; check it again");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  cancelRunnerRetirement(id: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const restored = this.db.prepare(`UPDATE runner SET state='available',error=NULL WHERE id=? AND state='failed' AND thread_id IS NULL
        AND id IN (SELECT runner_id FROM runner_operator WHERE retiring_at IS NOT NULL AND retired_at IS NULL)`).run(id);
      if (restored.changes !== 1) throw new Error("runner retirement reservation changed; check it again");
      const cancelled = this.db.prepare("UPDATE runner_operator SET retiring_at=NULL WHERE runner_id=? AND retiring_at IS NOT NULL AND retired_at IS NULL").run(id);
      if (cancelled.changes !== 1) throw new Error("runner retirement reservation changed; check it again");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  finishRunnerRetirement(id: string, reason: string, expectedAttemptAt: number, now = Date.now()): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const status = this.runnerStatuses(now).find(row => row.id === id);
      if (!status || status.allocationState !== "retiring" || status.threadId || status.allocationProjectId) {
        throw new Error("runner global allocation changed; check it again");
      }
      if (status.lastAttemptAt !== expectedAttemptAt) throw new Error("runner status changed; check it again");
      const idleReachable = status.contactStatus === "reachable" && status.health && status.health.activeVms === 0;
      if (!idleReachable && status.contactStatus !== "stale") throw new Error("runner must be reachable and idle, or stale, before retirement");
      const retired = this.db.prepare(`UPDATE runner SET state='retired',error=NULL
        WHERE id=? AND state='failed' AND thread_id IS NULL
          AND NOT EXISTS (SELECT 1 FROM thread WHERE runner_id=runner.id AND json_extract(data, '$.archived')=0)`).run(id);
      if (retired.changes !== 1) throw new Error("runner global allocation changed; check it again");
      const tombstoned = this.db.prepare(`UPDATE runner_operator SET retiring_at=NULL,retired_at=?,retirement_reason=?
        WHERE runner_id=? AND retiring_at IS NOT NULL AND retired_at IS NULL`).run(now, reason, id);
      if (tombstoned.changes !== 1) throw new Error("runner retirement reservation changed; check it again");
      this.db.prepare("INSERT INTO runner_audit(runner_id,action,at,evidence) VALUES (?,'retired',?,?)").run(id, now,
        JSON.stringify({ reason, contactStatus: status.contactStatus, lastContactAt: status.lastContactAt,
          unreachableSince: status.unreachableSince, health: status.health, error: status.error }));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  runnerAudit(id: string): Array<{ action: string; at: number; evidence: unknown }> {
    return (this.db.prepare("SELECT action,at,evidence FROM runner_audit WHERE runner_id=? ORDER BY id").all(id) as Array<{ action: string; at: number; evidence: string }>).map(row => ({ ...row, evidence: JSON.parse(row.evidence) }));
  }
  getThread(id: string): Thread | null { return this.parse(this.db.prepare("SELECT data FROM thread WHERE id=?").get(id)); }
  listThreads(): Thread[] { return this.db.prepare("SELECT data FROM thread ORDER BY rowid DESC").all().map(row => this.parse<Thread>(row)!); }
  saveThread(thread: Thread): void {
    this.db.prepare("UPDATE thread SET data=? WHERE id=?").run(JSON.stringify(thread), thread.id);
  }
  /** The thread a VM belongs to. */
  threadByVm(vmId: string): Thread | null {
    return this.parse(this.db.prepare("SELECT data FROM thread WHERE json_extract(data, '$.vm.vmId')=?").get(vmId));
  }
  /** The thread whose unfinished template build machine this is. */
  threadByBuildVm(vmId: string): Thread | null {
    return this.parse(this.db.prepare("SELECT data FROM thread WHERE json_extract(data, '$.vm.build.vmId')=?").get(vmId));
  }
  /** Changes the thread's machine record (provisioning tries, retention). */
  updateThreadVm(threadId: string, patch: Partial<Pick<ThreadVm, "provisionAttempt" | "retain" | "retainReason" | "discarded" | "preparation" | "build" | "hooks" | "startup">>): Thread {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const thread = this.getThread(threadId);
      if (!thread?.vm) throw new Error("thread has no machine");
      const vm: ThreadVm = { ...thread.vm, ...patch };
      // `undefined` removes a field (a finished build).
      for (const key of Object.keys(patch) as Array<keyof typeof patch>) if (patch[key] === undefined) delete vm[key];
      const updated = { ...thread, vm };
      this.db.prepare("UPDATE thread SET data=? WHERE id=?").run(JSON.stringify(updated), threadId);
      this.db.exec("COMMIT");
      return updated;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Begins a startup step of the thread's machine (`vm.steps`); a step of
   * the same name and attempt still running is marked interrupted. */
  beginStartupStep(threadId: string, step: Pick<StartupStep, "name" | "attempt" | "detail">, at = Date.now()): void {
    this.changeSteps(threadId, steps => [
      ...steps.map(old => old.state === "running" && old.name === step.name && old.attempt === step.attempt ? { ...old, state: "interrupted" as const, endedAt: at } : old),
      { name: step.name, ...(step.attempt !== undefined ? { attempt: step.attempt } : {}), state: "running", startedAt: at, ...(step.detail ? { detail: step.detail } : {}) },
    ]);
  }
  /** Marks every step still running as interrupted. An activation calls it
   * before it records a step of its own: one thread has one activation at a
   * time, so a running step then is one an earlier activation, or a cubed
   * that stopped, never ended. Writes nothing when none runs. */
  interruptStartupSteps(threadId: string, at = Date.now()): void {
    this.changeSteps(threadId, steps => steps.some(step => step.state === "running")
      ? steps.map(step => step.state === "running" ? { ...step, state: "interrupted" as const, endedAt: at } : step) : steps);
  }
  /** Ends the newest running step of that name (and attempt); a step that
   * never began (a cubed that restarted in between) is recorded as it ends.
   * `resumed`: a step marked interrupted may end after all (a preparation
   * try that went on in the guest while cubed was away), in its own place. */
  endStartupStep(threadId: string, step: Pick<StartupStep, "name" | "attempt" | "detail" | "memory" | "log"> & { state: "ok" | "failed" }, at = Date.now(), resumed = false): void {
    this.changeSteps(threadId, steps => {
      const same = (old: StartupStep) => old.name === step.name && old.attempt === step.attempt;
      let index = steps.findLastIndex(old => old.state === "running" && same(old));
      if (index < 0 && resumed) index = steps.findLastIndex(old => old.state === "interrupted" && same(old));
      const begun: Omit<StartupStep, "state"> = index >= 0 ? steps[index]! : { name: step.name, ...(step.attempt !== undefined ? { attempt: step.attempt } : {}), startedAt: at };
      const ended: StartupStep = { ...begun, state: step.state, endedAt: at, ...(step.detail ?? begun.detail ? { detail: step.detail ?? begun.detail } : {}),
        ...(step.memory ? { memory: step.memory } : {}), ...(step.log ? { log: step.log.slice(-STEP_LOG_BYTES) } : {}) };
      return index >= 0 ? steps.map((old, k) => k === index ? ended : old) : [...steps, ended];
    });
  }
  private changeSteps(threadId: string, change: (steps: StartupStep[]) => StartupStep[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const thread = this.getThread(threadId);
      if (thread?.vm) {
        const before = thread.vm.steps ?? [];
        const steps = change(before);
        if (steps !== before) this.db.prepare("UPDATE thread SET data=? WHERE id=?").run(JSON.stringify({ ...thread, vm: { ...thread.vm, steps: steps.slice(-MAX_STARTUP_STEPS) } }), threadId);
      }
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  /** Moves the thread's placement from one of `from` to `to` while it is
   * on `runnerId`; false when it moved or its placement is another. */
  markPlacement(threadId: string, runnerId: string, from: readonly ThreadPlacement[], to: ThreadPlacement): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const thread = this.getThread(threadId);
      const changed = !!thread?.vm && !thread.archived && thread.runnerId === runnerId && from.includes(placement(thread));
      if (changed) this.db.prepare("UPDATE thread SET data=? WHERE id=?").run(JSON.stringify({ ...thread, vm: { ...thread.vm, placement: to } }), threadId);
      this.db.exec("COMMIT");
      return changed;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  markWorkspaceAvailable(threadId: string, workspaceBase: Thread["workspaceBase"] = null): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const thread = this.getThread(threadId);
      if (!thread) throw new Error("thread not found");
      this.db.prepare("UPDATE thread SET data=? WHERE id=?").run(JSON.stringify({ ...thread, workspaceState: "available", workspaceError: null, workspaceBase }), threadId);
      this.syncRunner(thread.runnerId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  markWorkspaceFailed(threadId: string, error: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const thread = this.getThread(threadId);
      if (!thread) throw new Error("thread not found");
      this.db.prepare("UPDATE thread SET data=? WHERE id=?").run(JSON.stringify({ ...thread, workspaceState: "failed", workspaceError: error }), threadId);
      this.syncRunner(thread.runnerId);
      this.db.exec("COMMIT");
    } catch (cause) { this.db.exec("ROLLBACK"); throw cause; }
  }
  beginRelease(threadId: string): Thread {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const thread = this.getThread(threadId);
      if (!thread) throw new Error("thread not found");
      this.db.prepare("UPDATE thread SET data=? WHERE id=?").run(JSON.stringify({ ...thread, workspaceState: "releasing", workspaceError: null }), threadId);
      this.syncRunner(thread.runnerId);
      this.db.exec("COMMIT");
      return thread;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  finishRelease(threadId: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const thread = this.getThread(threadId);
      if (!thread) throw new Error("thread not found");
      this.db.prepare("UPDATE thread SET data=? WHERE id=?").run(JSON.stringify({ ...thread, archived: true }), threadId);
      // Frees the thread's machine slot.
      this.syncRunner(thread.runnerId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  initialPrompt(threadId: string): string {
    const row = this.db.prepare("SELECT payload FROM creation WHERE thread_id=?").get(threadId);
    return row ? (JSON.parse(String(row.payload)) as { text: string }).text : "";
  }
  /** The thread a creation request made, whatever it asked for. */
  threadByRequest(projectId: string, requestId: string): Thread | null {
    const row = this.db.prepare("SELECT thread_id FROM creation WHERE project_id=? AND request_id=?").get(projectId, requestId);
    return row ? this.getThread(String(row.thread_id)) : null;
  }
  /** A replayed request returns the thread it made, with the commits it was
   * pinned to then. A new thread is pinned to `resolved`, the commits just
   * resolved against upstream for it; without it (fixtures only) to the
   * commits of the project's last check. */
  createThread(projectId: string, requestId: string, model: ModelSelection, text: string, agent: ThreadAgent = "pi", resolved?: ResolvedRepositories): Thread {
    const payload = JSON.stringify({ model, text });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db.prepare("SELECT thread_id, payload FROM creation WHERE project_id=? AND request_id=?").get(projectId, requestId);
      if (prior) {
        if (prior.payload !== payload) throw new Error("creation request conflicts with the previous request");
        const thread = this.getThread(String(prior.thread_id))!;
        this.db.exec("COMMIT");
        return thread;
      }
      const project = this.getProject(projectId);
      if (!project) throw new Error("project not found");
      if (project.status !== "ready") throw new Error("check the project before starting a thread");
      let repositories = allocationRepositories(project, true);
      if (resolved) {
        if (resolved.projectRevision !== project.revision || resolved.repositories.length !== repositories.length
          || resolved.repositories.some((repository, index) => repository.url !== repositories[index].url)) {
          throw new Error("the project changed while its latest commits were fetched; start the thread again");
        }
        repositories = repositories.map((repository, index) => ({ ...repository,
          base: resolved.repositories[index].base, baseOid: resolved.repositories[index].baseOid }));
      }
      // Counting open threads and inserting this one in one IMMEDIATE
      // transaction is the slot reservation: no two creations, in this or
      // another process, can take a runner's last slot.
      const load = this.runnerLoads().find(candidate => candidate.active < candidate.slots);
      if (!load) throw new Error("no free thread machine in the global runner pool — archive an idle thread, register another trusted runner or raise a runner's --max-active-vms");
      const thread: Thread = { id: randomUUID(), projectId, runnerId: load.id,
        title: text.replace(/\s+/g, " ").slice(0, 80) || null, model, agent, archived: false, createdAt: Date.now(),
        allocation: { projectId, projectRevision: project.revision, repositories, hooks: { ...NO_HOOKS, ...project.hooks },
          ...(project.machine && Object.keys(project.machine).length ? { machine: { ...project.machine } } : {}),
          ...(resolved?.skills ? { skills: resolved.skills } : {}) },
        workspaceState: "allocating", workspaceError: null, workspaceBase: null,
        vm: { vmId: randomBytes(8).toString("hex"), placeholders: { github: newPlaceholder("github") }, placement: "provisional" } };
      this.db.prepare("INSERT INTO thread VALUES (?,?,?,?)").run(thread.id, projectId, load.id, JSON.stringify(thread));
      this.syncRunner(load.id);
      this.db.prepare("INSERT INTO creation VALUES (?,?,?,?)").run(projectId, requestId, thread.id, payload);
      this.db.exec("COMMIT");
      return thread;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.db.close(); }
}
