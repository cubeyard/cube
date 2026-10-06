/** Product metadata only. Pi's databases own conversations and execution. */
import fs from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ModelSelection } from "./models.ts";
import type { NodeBinding, TrustedRunnerHealth } from "./iroh-node.ts";
import type { ThreadAgent } from "./thread-events.ts";
import { newPlaceholder } from "./egress-policy.ts";

/** The registry schema; older registries are refused (fresh CUBED_STATE). */
export const REGISTRY_SCHEMA = 102;

export const RUNNER_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

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
export interface Project {
  id: string; name: string; status: "checking" | "ready" | "error"; error: string | null;
  revision: number; checkedAt: number | null; createdAt: number; updatedAt: number;
  repositories: ProjectRepository[];
  /** Absent: no hooks (projects saved before hooks existed). */
  hooks?: ProjectHooks;
}
export interface Runner extends NodeBinding {
  configPath: string; configHash: string;
  /** The most thread machines the runner last said it hosts at once
   * (`maxActiveVms`); absent means one, as every runner before 0.7.0. */
  maxActiveVms?: number;
  /** The project this installation template belonged to before runners became
   * global. It is migration/audit context, never a scheduling constraint. */
  legacyProjectId?: string;
}
export interface WorkspaceRepository {
  url: string; base: string; baseOid: string; checkoutName: string;
}
export interface WorkspaceAllocation {
  projectId: string; projectRevision: number; repositories: WorkspaceRepository[];
  /** The project's hooks when the thread was created; fixed for the thread. */
  hooks?: ProjectHooks;
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
export interface ThreadVm {
  /** 16 hex characters: the runner's VM id and cloud-init instance-id. */
  vmId: string;
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
  build?: { vmId: string; placeholders: Record<string, string>; key: string };
  /** The hooks' latest outcomes, by hook (`pre-setup`, `setup`, `pre-resume`, `resume`). */
  hooks?: Record<string, HookOutcome>;
  /** How long the machine took to become ready for the agent, by phase (ms). */
  startup?: { source: MachinePreparation["source"]; totalMs: number; phases: Record<string, number> };
}
export interface MachinePreparation {
  /** `template`: the disk is backed by a prepared template; `fresh`: by the base image. */
  source: "template" | "fresh";
  templateId?: string;
  /** The template's `.agents/setup` blob, compared after the checkout. */
  setupBlob?: string;
  /** Why the machine started fresh (no template, templates off, a failed build). */
  reason?: string;
}
export interface HookOutcome {
  /** `ok`, `failed`, `skipped` (prepared by a template) or `absent`. */
  status: "ok" | "failed" | "skipped" | "absent";
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
  /** Allocatable runners with their open threads: runners with a failed
   * machine last, then the least loaded, then enrollment order. */
  private runnerLoads(): Array<{ id: string; runner: Runner; slots: number; active: number; failed: number }> {
    // One pass over the open threads (index thread_open), not per runner.
    const rows = this.db.prepare(`SELECT r.id,r.data,coalesce(t.active,0) AS active,coalesce(t.failed,0) AS failed
      FROM runner r JOIN runner_operator o ON o.runner_id=r.id
      LEFT JOIN (SELECT runner_id,count(*) AS active,sum(json_extract(data, '$.workspaceState')='failed') AS failed
        FROM thread WHERE ${OPEN_THREAD} GROUP BY runner_id) t ON t.runner_id=r.id
      WHERE o.retired_at IS NULL AND o.retiring_at IS NULL AND r.state<>'retired' ORDER BY r.rowid`).all() as Array<{ id: string; data: string; active: number; failed: number }>;
    return rows.map(row => {
      const runner = JSON.parse(row.data) as Runner;
      return { id: row.id, runner, slots: runnerSlots(runner), active: Number(row.active), failed: Number(row.failed) };
    }).sort((a, b) => Number(a.failed > 0) - Number(b.failed > 0) || a.active / a.slots - b.active / b.slots
      || (b.slots - b.active) - (a.slots - a.active));
  }
  /** Moves an open thread to another runner with a free slot, for a thread
   * whose runner refused to create its machine. The caller guarantees that
   * nothing of the thread exists on the old runner and nothing is bound to
   * it yet. Returns the new runner's id, or null when no other runner has
   * room. */
  relocateThread(threadId: string): string | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const thread = this.getThread(threadId);
      if (!thread || thread.archived || thread.workspaceState === "available" || thread.workspaceState === "releasing") {
        this.db.exec("COMMIT");
        return null;
      }
      const load = this.runnerLoads().find(candidate => candidate.id !== thread.runnerId && candidate.active < candidate.slots);
      if (!load) { this.db.exec("COMMIT"); return null; }
      this.db.prepare("UPDATE thread SET runner_id=?,data=? WHERE id=?").run(load.id, JSON.stringify({ ...thread, runnerId: load.id }), threadId);
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
    const updated = this.db.prepare(`UPDATE runner_operator SET last_attempt_at=?,
      last_contact_at=CASE WHEN ? THEN ? ELSE last_contact_at END,
      unreachable_since=CASE WHEN ? THEN NULL ELSE coalesce(unreachable_since,?) END,
      last_error=?, health=? WHERE runner_id=? AND retired_at IS NULL`).run(
      at, success ? 1 : 0, at, success ? 1 : 0, at, success ? null : result.error,
      success ? JSON.stringify(result.health) : null, id);
    if (updated.changes !== 1) throw new Error("runner not found or already retired");
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
  createThread(projectId: string, requestId: string, model: ModelSelection, text: string, agent: ThreadAgent = "pi"): Thread {
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
      if (this.getProject(projectId)?.status !== "ready") throw new Error("check the project before starting a thread");
      const project = this.getProject(projectId)!;
      const repositories = allocationRepositories(project, true);
      // Counting open threads and inserting this one in one IMMEDIATE
      // transaction is the slot reservation: no two creations, in this or
      // another process, can take a runner's last slot.
      const load = this.runnerLoads().find(candidate => candidate.active < candidate.slots);
      if (!load) throw new Error("no free thread machine in the global runner pool — archive an idle thread, register another trusted runner or raise a runner's --max-active-vms");
      const thread: Thread = { id: randomUUID(), projectId, runnerId: load.id,
        title: text.replace(/\s+/g, " ").slice(0, 80) || null, model, agent, archived: false, createdAt: Date.now(),
        allocation: { projectId, projectRevision: project.revision, repositories, hooks: { ...NO_HOOKS, ...project.hooks } },
        workspaceState: "allocating", workspaceError: null, workspaceBase: null,
        vm: { vmId: randomBytes(8).toString("hex"), placeholders: { github: newPlaceholder("github") } } };
      this.db.prepare("INSERT INTO thread VALUES (?,?,?,?)").run(thread.id, projectId, load.id, JSON.stringify(thread));
      this.syncRunner(load.id);
      this.db.prepare("INSERT INTO creation VALUES (?,?,?,?)").run(projectId, requestId, thread.id, payload);
      this.db.exec("COMMIT");
      return thread;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.db.close(); }
}
