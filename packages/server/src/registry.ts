/** Product metadata only. Pi's databases own conversations and execution. */
import fs from "node:fs";
import path from "node:path";
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
export interface Thread {
  id: string; projectId: string; title: string | null; createdAt: number;
  archived: boolean; model: ModelSelection;
}

export class Registry {
  private readonly db: DatabaseSync;
  constructor(filename: string) {
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    try {
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
      const version = this.db.prepare("PRAGMA user_version").get()!.user_version;
      if (tables.length && version !== 100) throw new Error("legacy or unsupported registry: choose a fresh CUBED_STATE directory; old data is not migrated");
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS project(id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runner(thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id),
          node_id TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS thread(id TEXT PRIMARY KEY REFERENCES runner(thread_id),
          project_id TEXT NOT NULL REFERENCES project(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS creation(project_id TEXT NOT NULL, request_id TEXT NOT NULL,
          thread_id TEXT NOT NULL REFERENCES thread(id), payload TEXT NOT NULL, PRIMARY KEY(project_id, request_id));
        PRAGMA user_version=100;`);
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
    if (this.db.prepare("SELECT 1 FROM runner WHERE project_id=?").get(id)) throw new Error("project still has registered runners");
    this.db.prepare("DELETE FROM project WHERE id=?").run(id);
  }
  enrollRunner(runner: Runner): void {
    if (!this.getProject(runner.projectId)) throw new Error("project not found");
    this.db.prepare("INSERT INTO runner VALUES (?,?,?,?)").run(runner.threadId, runner.projectId, runner.nodeId, JSON.stringify(runner));
  }
  runner(threadId: string): Runner | null { return this.parse(this.db.prepare("SELECT data FROM runner WHERE thread_id=?").get(threadId)); }
  availableRunners(projectId: string): Runner[] {
    return this.db.prepare("SELECT data FROM runner WHERE project_id=? AND thread_id NOT IN (SELECT id FROM thread)").all(projectId).map(row => this.parse<Runner>(row)!);
  }
  runnerCount(projectId: string): number {
    return Number(this.db.prepare("SELECT count(*) AS n FROM runner WHERE project_id=?").get(projectId)!.n);
  }
  getThread(id: string): Thread | null { return this.parse(this.db.prepare("SELECT data FROM thread WHERE id=?").get(id)); }
  listThreads(): Thread[] { return this.db.prepare("SELECT data FROM thread ORDER BY rowid DESC").all().map(row => this.parse<Thread>(row)!); }
  saveThread(thread: Thread): void {
    this.db.prepare("UPDATE thread SET data=? WHERE id=?").run(JSON.stringify(thread), thread.id);
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
      const runner = this.availableRunners(projectId)[0];
      if (!runner) throw new Error("no runner available — register a fresh trusted runner for this project");
      const thread: Thread = { id: runner.threadId, projectId, title: text.replace(/\s+/g, " ").slice(0, 80) || null, model, archived: false, createdAt: Date.now() };
      this.db.prepare("INSERT INTO thread VALUES (?,?,?)").run(thread.id, projectId, JSON.stringify(thread));
      this.db.prepare("INSERT INTO creation VALUES (?,?,?,?)").run(projectId, requestId, thread.id, payload);
      this.db.exec("COMMIT");
      return thread;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.db.close(); }
}
