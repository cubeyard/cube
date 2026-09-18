/** Product metadata only. Pi's databases own conversations and execution. */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { ModelSelection } from "./models.ts";
import type { NodeBinding } from "./iroh-node.ts";

export interface ProjectRepository {
  id: string; projectId: string; position: number; url: string; base: string | null;
  checkoutName: string; status: "checking" | "ready" | "error"; error: string | null;
  resolvedBase: string | null; baseOid: string | null; checkedAt: number | null;
}
export interface Project {
  id: string; name: string; status: "checking" | "ready" | "error"; error: string | null;
  revision: number; checkedAt: number | null; createdAt: number; updatedAt: number;
  repositories: ProjectRepository[];
}
export interface Runner extends NodeBinding {
  projectId: string; configPath: string; configHash: string;
}
export type RunnerAllocationState = "available" | "allocating" | "busy" | "releasing" | "failed";
export interface Thread {
  id: string; projectId: string; title: string | null; createdAt: number;
  archived: boolean; model: ModelSelection; runnerId: string;
  workspaceState: "allocating" | "available" | "releasing" | "failed"; workspaceError: string | null;
  workspaceBase?: { remote: string; ref: string; oid: string } | null;
}

export class Registry {
  private readonly db: DatabaseSync;
  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    try {
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const version = this.db.prepare("PRAGMA user_version").get()!.user_version;
      if (tables.length && version !== 100 && version !== 101) throw new Error("legacy or unsupported registry: choose a fresh CUBED_STATE directory");
      if (version === 100) this.migrate100();
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS project(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runner(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id),
          node_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, state TEXT NOT NULL, thread_id TEXT, error TEXT);
        CREATE TABLE IF NOT EXISTS thread(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id),
          runner_id TEXT NOT NULL REFERENCES runner(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS creation(project_id TEXT NOT NULL, request_id TEXT NOT NULL,
          thread_id TEXT NOT NULL REFERENCES thread(id), payload TEXT NOT NULL, PRIMARY KEY(project_id, request_id));
        PRAGMA user_version=101;`);
    } catch (error) { this.db.close(); throw error; }
  }
  private parse<T>(row: unknown): T | null {
    return row ? JSON.parse((row as { data: string }).data) as T : null;
  }
  private migrate100(): void {
    this.db.exec(`PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE;
      ALTER TABLE runner RENAME TO runner_v100;
      ALTER TABLE thread RENAME TO thread_v100;
      ALTER TABLE creation RENAME TO creation_v100;
      CREATE TABLE runner(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id),
        node_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL, state TEXT NOT NULL, thread_id TEXT, error TEXT);
      CREATE TABLE thread(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id),
        runner_id TEXT NOT NULL REFERENCES runner(id), data TEXT NOT NULL);
      CREATE TABLE creation(project_id TEXT NOT NULL, request_id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES thread(id), payload TEXT NOT NULL, PRIMARY KEY(project_id, request_id));
      INSERT INTO runner SELECT r.thread_id, r.project_id, r.node_id, r.data,
        CASE WHEN t.id IS NULL OR json_extract(t.data, '$.archived') = 1 THEN 'available' ELSE 'busy' END,
        CASE WHEN t.id IS NOT NULL AND json_extract(t.data, '$.archived') = 0 THEN t.id ELSE NULL END, NULL
        FROM runner_v100 r LEFT JOIN thread_v100 t ON t.id=r.thread_id;
      INSERT INTO thread SELECT t.id, t.project_id, t.id,
        json_set(t.data, '$.runnerId', t.id, '$.workspaceState', 'available', '$.workspaceError', NULL)
        FROM thread_v100 t;
      INSERT INTO creation SELECT * FROM creation_v100;
      DROP TABLE creation_v100; DROP TABLE thread_v100; DROP TABLE runner_v100;
      PRAGMA user_version=101; COMMIT; PRAGMA foreign_keys=ON;`);
  }
  getProject(id: string): Project | null { return this.parse(this.db.prepare("SELECT data FROM project WHERE id=?").get(id)); }
  listProjects(): Project[] { return this.db.prepare("SELECT data FROM project").all().map(row => this.parse<Project>(row)!); }
  saveProject(project: Project): void {
    this.db.prepare("INSERT INTO project VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(project.id, JSON.stringify(project));
  }
  deleteProject(id: string): void {
    if (this.db.prepare("SELECT 1 FROM runner WHERE project_id=?").get(id)) throw new Error("project still has registered runners");
    this.db.prepare("DELETE FROM project WHERE id=?").run(id);
  }
  enrollRunner(runner: Runner): void {
    if (!this.getProject(runner.projectId)) throw new Error("project not found");
    this.db.prepare("INSERT INTO runner VALUES (?,?,?,?,?,?,?)").run(runner.threadId, runner.projectId, runner.nodeId, JSON.stringify(runner), "available", null, null);
  }
  runner(threadId: string): Runner | null {
    return this.parse(this.db.prepare("SELECT r.data FROM runner r JOIN thread t ON t.runner_id=r.id WHERE t.id=?").get(threadId));
  }
  listRunners(): Runner[] {
    return this.db.prepare("SELECT data FROM runner ORDER BY rowid").all().map(row => this.parse<Runner>(row)!);
  }
  availableRunners(projectId: string): Runner[] {
    return this.db.prepare("SELECT data FROM runner WHERE project_id=? AND state='available'").all(projectId).map(row => this.parse<Runner>(row)!);
  }
  runnerCount(projectId: string): number {
    return Number(this.db.prepare("SELECT count(*) AS n FROM runner WHERE project_id=?").get(projectId)!.n);
  }
  runnerCapacity(projectId: string): { states: Record<RunnerAllocationState, number>; errors: string[] } {
    const states: Record<RunnerAllocationState, number> = { available: 0, allocating: 0, busy: 0, releasing: 0, failed: 0 };
    const rows = this.db.prepare("SELECT state,error FROM runner WHERE project_id=?").all(projectId) as Array<{ state: RunnerAllocationState; error: string | null }>;
    for (const row of rows) states[row.state]++;
    return { states, errors: rows.flatMap(row => row.error ? [row.error] : []) };
  }
  getThread(id: string): Thread | null { return this.parse(this.db.prepare("SELECT data FROM thread WHERE id=?").get(id)); }
  listThreads(): Thread[] { return this.db.prepare("SELECT data FROM thread ORDER BY rowid DESC").all().map(row => this.parse<Thread>(row)!); }
  saveThread(thread: Thread): void {
    this.db.prepare("UPDATE thread SET data=? WHERE id=?").run(JSON.stringify(thread), thread.id);
  }
  markWorkspaceAvailable(threadId: string, workspaceBase: Thread["workspaceBase"] = null): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const thread = this.getThread(threadId);
      if (!thread) throw new Error("thread not found");
      this.db.prepare("UPDATE thread SET data=? WHERE id=?").run(JSON.stringify({ ...thread, workspaceState: "available", workspaceError: null, workspaceBase }), threadId);
      this.db.prepare("UPDATE runner SET state='busy', error=NULL WHERE id=? AND thread_id=?").run(thread.runnerId, threadId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  markWorkspaceFailed(threadId: string, error: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const thread = this.getThread(threadId);
      if (!thread) throw new Error("thread not found");
      this.db.prepare("UPDATE thread SET data=? WHERE id=?").run(JSON.stringify({ ...thread, workspaceState: "failed", workspaceError: error }), threadId);
      this.db.prepare("UPDATE runner SET state='failed', error=? WHERE id=? AND thread_id=?").run(error, thread.runnerId, threadId);
      this.db.exec("COMMIT");
    } catch (cause) { this.db.exec("ROLLBACK"); throw cause; }
  }
  beginRelease(threadId: string): Thread {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const thread = this.getThread(threadId);
      if (!thread) throw new Error("thread not found");
      this.db.prepare("UPDATE thread SET data=? WHERE id=?").run(JSON.stringify({ ...thread, workspaceState: "releasing", workspaceError: null }), threadId);
      this.db.prepare("UPDATE runner SET state='releasing' WHERE id=? AND thread_id=?").run(thread.runnerId, threadId);
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
      this.db.prepare("UPDATE runner SET state='available', thread_id=NULL, error=NULL WHERE id=? AND thread_id=?").run(thread.runnerId, threadId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  initialPrompt(threadId: string): string {
    const row = this.db.prepare("SELECT payload FROM creation WHERE thread_id=?").get(threadId);
    return row ? (JSON.parse(String(row.payload)) as { text: string }).text : "";
  }
  createThread(projectId: string, requestId: string, model: ModelSelection, text: string): Thread {
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
      const row = this.db.prepare("SELECT id,data FROM runner WHERE project_id=? AND state='available' ORDER BY rowid LIMIT 1").get(projectId) as { id: string; data: string } | undefined;
      const runner = row ? JSON.parse(row.data) as Runner : null;
      if (!runner) throw new Error("no runner available — register a fresh trusted runner for this project");
      const thread: Thread = { id: randomUUID(), projectId, runnerId: row!.id,
        title: text.replace(/\s+/g, " ").slice(0, 80) || null, model, archived: false, createdAt: Date.now(),
        workspaceState: "allocating", workspaceError: null, workspaceBase: null };
      this.db.prepare("INSERT INTO thread VALUES (?,?,?,?)").run(thread.id, projectId, row!.id, JSON.stringify(thread));
      const claimed = this.db.prepare("UPDATE runner SET state='allocating',thread_id=?,error=NULL WHERE id=? AND state='available'").run(thread.id, row!.id);
      if (claimed.changes !== 1) throw new Error("runner allocation conflict");
      this.db.prepare("INSERT INTO creation VALUES (?,?,?,?)").run(projectId, requestId, thread.id, payload);
      this.db.exec("COMMIT");
      return thread;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.db.close(); }
}
