/**
 * cubed's SQLite registry (PLAN §7) — metadata only, for what pi cannot
 * know: which cubes exist (with their allocated subnet), which pi session
 * file backs each thread, service portals (stable hostnames), and volumes. Conversation
 * content stays in pi's JSONL session files; the SSE buffer stays in-memory.
 *
 * Uses node:sqlite (in Node since 22.5, no native dep). Single writer
 * (cubed) — no contention concerns.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface CubeRow {
  id: number;
  name: string;
  /** creating | ready | asleep | waking | error | building-environment (internal). */
  status: string;
  error: string | null;
  image: string;
  workspacePath: string;
  subnetIndex: number;
  createdAt: number;
  lastActiveAt: number;
}

export interface ThreadRow {
  id: string; // pi session id
  cubeId: number;
  projectId: string;
  piSessionPath: string;
  title: string | null;
  createdAt: number;
  archivedAt: number | null;
}

export type ProjectStatus = "checking" | "ready" | "error";

export interface ProjectRow {
  id: string;
  name: string;
  status: ProjectStatus;
  error: string | null;
  revision: number;
  checkedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectRepositoryRow {
  id: string;
  projectId: string;
  position: number;
  url: string;
  /** Requested base; null means resolve the upstream default branch. */
  base: string | null;
  checkoutName: string;
  status: ProjectStatus;
  error: string | null;
  resolvedBase: string | null;
  baseOid: string | null;
  checkedAt: number | null;
}

/** Immutable repository snapshot owned by one thread's backing cube. */
export interface CubeRepositoryRow {
  id: number;
  cubeId: number;
  position: number;
  url: string;
  base: string;
  branch: string;
  baseOid: string;
  checkoutName: string;
  workspacePath: string;
}

export interface PortalRow {
  id: number;
  cubeId: number;
  name: string;
  targetPort: number;
  /** Host-header routing label (`<service>--<cube>`), unique across cubes. */
  hostname: string;
  createdAt: number;
}

export interface VolumeRow {
  id: number;
  cubeId: number;
  purpose: string;
  poolVolume: string;
  capBytes: number;
}

/** Derived per-cube networking. One /24 per cube out of 10.90.0.0/16. */
export interface CubeNetworkPlan {
  bridge: string;
  subnet: string;
  gateway: string;
  ip: string;
}

// Subnet indexes are allocated from [10, 249]: 10.90.1 is the historical
// spike01 bridge, .8/.9 belong to the smoke tests, .250 to the image
// builder (images/build.sh) — all outside the range by construction.
// CUBED_SUBNET_MIN raises the floor — smoke tests use a high band (200+)
// so their fresh temp registries never collide with the production
// daemon's live bridges on the same machine. Read at allocation time:
// module-level would run before a test file's own env assignment (imports
// hoist above it).
const SUBNET_MIN = () => Number(process.env.CUBED_SUBNET_MIN ?? 10);
const SUBNET_MAX = 249;

// Linux IFNAMSIZ is 16 (15 usable): "cbr-" + name must fit, so cube names
// are capped at 11 chars. Validated at cube creation, before any allocation.
/** Also half of the portal label `<service>--<cube>`: no `--` inside and
 * no trailing hyphen, or the label would not split (or be a DNS label). */
export const CUBE_NAME_RE = /^[a-z](?:-?[a-z0-9]){0,10}$/;

export function networkForCube(name: string, subnetIndex: number): CubeNetworkPlan {
  return {
    bridge: `cbr-${name}`,
    subnet: `10.90.${subnetIndex}.1/24`,
    gateway: `10.90.${subnetIndex}.1`,
    ip: `10.90.${subnetIndex}.10`,
  };
}

export class Registry {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL COLLATE NOCASE UNIQUE,
        status     TEXT NOT NULL,
        error      TEXT,
        revision   INTEGER NOT NULL,
        checked_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS project_repository (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
        position      INTEGER NOT NULL,
        url           TEXT NOT NULL,
        base          TEXT,
        checkout_name TEXT NOT NULL,
        status        TEXT NOT NULL,
        error         TEXT,
        resolved_base TEXT,
        base_oid      TEXT,
        checked_at    INTEGER,
        UNIQUE(project_id, position),
        UNIQUE(project_id, checkout_name)
      );
      CREATE TABLE IF NOT EXISTS cube (
        id             INTEGER PRIMARY KEY,
        name           TEXT NOT NULL UNIQUE,
        status         TEXT NOT NULL,
        error          TEXT,
        image          TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        subnet_index   INTEGER NOT NULL UNIQUE,
        created_at     INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS thread (
        id              TEXT PRIMARY KEY,
        cube_id         INTEGER NOT NULL REFERENCES cube(id) ON DELETE CASCADE,
        project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
        pi_session_path TEXT NOT NULL,
        title           TEXT,
        created_at      INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cube_repository (
        id            INTEGER PRIMARY KEY,
        cube_id       INTEGER NOT NULL REFERENCES cube(id) ON DELETE CASCADE,
        position      INTEGER NOT NULL,
        url           TEXT NOT NULL,
        base          TEXT NOT NULL,
        branch        TEXT NOT NULL,
        base_oid      TEXT NOT NULL,
        checkout_name TEXT NOT NULL,
        workspace_path TEXT NOT NULL,
        UNIQUE(cube_id, position),
        UNIQUE(cube_id, checkout_name)
      );
      CREATE TABLE IF NOT EXISTS portal (
        id          INTEGER PRIMARY KEY,
        cube_id     INTEGER NOT NULL REFERENCES cube(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        target_port INTEGER NOT NULL,
        hostname    TEXT NOT NULL UNIQUE,
        created_at  INTEGER NOT NULL,
        UNIQUE(cube_id, name)
      );
      CREATE TABLE IF NOT EXISTS volume (
        id          INTEGER PRIMARY KEY,
        cube_id     INTEGER NOT NULL REFERENCES cube(id) ON DELETE CASCADE,
        purpose     TEXT NOT NULL,
        pool_volume TEXT NOT NULL,
        cap_bytes   INTEGER NOT NULL,
        UNIQUE(cube_id, purpose)
      );
    `);
    this.migratePortalTable();
    this.requireProjectThreads();
    this.migrateThreadArchive(); // after: the project upgrade recreates `thread` without it
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS thread_cube_id_unique ON thread(cube_id)");
  }

  private migrateThreadArchive(): void {
    const columns = this.db.prepare("PRAGMA table_info(thread)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "archived_at")) {
      this.db.exec("ALTER TABLE thread ADD COLUMN archived_at INTEGER");
    }
  }

  /** Projects are a hard model boundary, not a nullable compatibility
   * column. An empty pre-project registry can be upgraded safely; a registry
   * with old threads is left untouched and fails with an explicit recovery
   * instruction rather than silently inventing project membership. */
  private requireProjectThreads(): void {
    const columns = this.db.prepare("PRAGMA table_info(thread)").all() as { name: string }[];
    if (columns.some((column) => column.name === "project_id")) return;
    const count = Number((this.db.prepare("SELECT count(*) AS n FROM thread").get() as { n: number }).n);
    if (count > 0) {
      throw new Error(
        "this registry contains pre-project threads; move the database aside and restart — thread projects are required and legacy repo-per-thread data is not supported",
      );
    }
    this.db.exec(`
      DROP TABLE thread;
      CREATE TABLE thread (
        id              TEXT PRIMARY KEY,
        cube_id         INTEGER NOT NULL REFERENCES cube(id) ON DELETE CASCADE,
        project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
        pi_session_path TEXT NOT NULL,
        title           TEXT,
        created_at      INTEGER NOT NULL
      );
    `);
  }

  /** Phase-2 databases carry the pre-hostname portal schema (host_port
   * allocator, removed 2026-08-27). No proxy ever served those rows —
   * dropping the table loses nothing; CREATE above then recreates it. */
  private migratePortalTable(): void {
    const columns = this.db.prepare("PRAGMA table_info(portal)").all() as { name: string }[];
    if (!columns.some((c) => c.name === "host_port")) return;
    this.db.exec(`
      DROP TABLE portal;
      CREATE TABLE portal (
        id          INTEGER PRIMARY KEY,
        cube_id     INTEGER NOT NULL REFERENCES cube(id) ON DELETE CASCADE,
        name        TEXT NOT NULL,
        target_port INTEGER NOT NULL,
        hostname    TEXT NOT NULL UNIQUE,
        created_at  INTEGER NOT NULL,
        UNIQUE(cube_id, name)
      );
    `);
  }

  // --------------------------------------------------------------- project

  createProject(input: {
    id: string;
    name: string;
    repositories: Array<{ id: string; url: string; base: string | null; checkoutName: string }>;
  }): ProjectRow {
    const now = Date.now();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO project (id, name, status, error, revision, checked_at, created_at, updated_at)
           VALUES (?, ?, 'checking', NULL, 1, NULL, ?, ?)`,
        )
        .run(input.id, input.name, now, now);
      this.insertProjectRepositories(input.id, input.repositories);
    });
    return this.getProject(input.id)!;
  }

  updateProject(
    id: string,
    input: {
      name: string;
      repositories: Array<{ id: string; url: string; base: string | null; checkoutName: string }>;
    },
  ): ProjectRow {
    const now = Date.now();
    this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE project
           SET name = ?, status = 'checking', error = NULL, checked_at = NULL,
               revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(input.name, now, id);
      if (result.changes === 0) throw new Error(`no such project: ${id}`);
      this.db.prepare("DELETE FROM project_repository WHERE project_id = ?").run(id);
      this.insertProjectRepositories(id, input.repositories);
    });
    return this.getProject(id)!;
  }

  private insertProjectRepositories(
    projectId: string,
    repositories: Array<{ id: string; url: string; base: string | null; checkoutName: string }>,
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO project_repository
       (id, project_id, position, url, base, checkout_name, status, error, resolved_base, base_oid, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, 'checking', NULL, NULL, NULL, NULL)`,
    );
    repositories.forEach((repo, position) =>
      insert.run(repo.id, projectId, position, repo.url, repo.base, repo.checkoutName),
    );
  }

  getProject(id: string): ProjectRow | null {
    const row = this.db.prepare("SELECT * FROM project WHERE id = ?").get(id);
    return row ? projectRow(row) : null;
  }

  listProjects(): ProjectRow[] {
    return (this.db.prepare("SELECT * FROM project ORDER BY name COLLATE NOCASE").all() as unknown[]).map(
      projectRow,
    );
  }

  listProjectRepositories(projectId: string): ProjectRepositoryRow[] {
    return (
      this.db
        .prepare("SELECT * FROM project_repository WHERE project_id = ? ORDER BY position")
        .all(projectId) as unknown[]
    ).map(projectRepositoryRow);
  }

  beginProjectCheck(id: string): ProjectRow {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE project
         SET status = 'checking', error = NULL, checked_at = NULL,
             revision = revision + 1, updated_at = ?
         WHERE id = ?`,
      )
      .run(now, id);
    if (result.changes === 0) throw new Error(`no such project: ${id}`);
    this.db
      .prepare(
        `UPDATE project_repository
         SET status = 'checking', error = NULL, resolved_base = NULL, base_oid = NULL, checked_at = NULL
         WHERE project_id = ?`,
      )
      .run(id);
    return this.getProject(id)!;
  }

  setProjectRepositoryCheck(
    id: string,
    result: {
      status: "ready" | "error";
      error?: string | null;
      resolvedBase?: string | null;
      baseOid?: string | null;
      checkedAt: number;
    },
  ): void {
    this.db
      .prepare(
        `UPDATE project_repository
         SET status = ?, error = ?, resolved_base = ?, base_oid = ?, checked_at = ?
         WHERE id = ?`,
      )
      .run(
        result.status,
        result.error ?? null,
        result.resolvedBase ?? null,
        result.baseOid ?? null,
        result.checkedAt,
        id,
      );
  }

  finishProjectCheck(
    id: string,
    revision: number,
    status: "ready" | "error",
    error: string | null,
    checkedAt: number,
  ): void {
    this.db
      .prepare(
        `UPDATE project SET status = ?, error = ?, checked_at = ?, updated_at = ?
         WHERE id = ? AND revision = ?`,
      )
      .run(status, error, checkedAt, checkedAt, id, revision);
  }

  countThreadsForProject(projectId: string): number {
    return Number(
      (this.db.prepare("SELECT count(*) AS n FROM thread WHERE project_id = ?").get(projectId) as { n: number })
        .n,
    );
  }

  deleteProject(id: string): void {
    if (this.countThreadsForProject(id) > 0) {
      throw new Error(`project ${id} still has threads`);
    }
    const result = this.db.prepare("DELETE FROM project WHERE id = ?").run(id);
    if (result.changes === 0) throw new Error(`no such project: ${id}`);
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // ------------------------------------------------------------------ cube

  createCube(input: {
    name: string;
    image: string;
    workspacePath: string;
  }): CubeRow {
    if (!CUBE_NAME_RE.test(input.name)) {
      throw new Error(
        `invalid cube name ${JSON.stringify(input.name)} — need ${CUBE_NAME_RE} (bridge name must fit IFNAMSIZ)`,
      );
    }
    const subnetIndex = this.allocateSubnetIndex();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO cube (name, status, image, workspace_path, subnet_index, created_at, last_active_at)
         VALUES (?, 'creating', ?, ?, ?, ?, ?)`,
      )
      .run(input.name, input.image, input.workspacePath, subnetIndex, now, now);
    return this.getCube(input.name)!;
  }

  addCubeRepositories(
    cubeId: number,
    repositories: Array<{
      url: string;
      base: string;
      branch: string;
      baseOid: string;
      checkoutName: string;
      workspacePath: string;
    }>,
  ): void {
    const insert = this.db.prepare(
      `INSERT INTO cube_repository
       (cube_id, position, url, base, branch, base_oid, checkout_name, workspace_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.transaction(() => {
      repositories.forEach((repo, position) =>
        insert.run(
          cubeId,
          position,
          repo.url,
          repo.base,
          repo.branch,
          repo.baseOid,
          repo.checkoutName,
          repo.workspacePath,
        ),
      );
    });
  }

  listCubeRepositories(cubeId: number): CubeRepositoryRow[] {
    return (
      this.db
        .prepare("SELECT * FROM cube_repository WHERE cube_id = ? ORDER BY position")
        .all(cubeId) as unknown[]
    ).map(cubeRepositoryRow);
  }

  private allocateSubnetIndex(): number {
    const used = new Set(
      (this.db.prepare("SELECT subnet_index AS i FROM cube").all() as { i: number }[]).map(
        (r) => r.i,
      ),
    );
    for (let i = SUBNET_MIN(); i <= SUBNET_MAX; i++) {
      if (!used.has(i)) return i;
    }
    throw new Error("no free cube subnets (10.90.10-249.0/24 all allocated)");
  }

  getCube(name: string): CubeRow | null {
    const row = this.db.prepare("SELECT * FROM cube WHERE name = ?").get(name);
    return row ? cubeRow(row) : null;
  }

  getCubeById(id: number): CubeRow | null {
    const row = this.db.prepare("SELECT * FROM cube WHERE id = ?").get(id);
    return row ? cubeRow(row) : null;
  }

  listCubes(): CubeRow[] {
    return (this.db.prepare("SELECT * FROM cube ORDER BY name").all() as unknown[]).map(cubeRow);
  }

  setCubeStatus(name: string, status: string, error: string | null = null): void {
    this.db
      .prepare("UPDATE cube SET status = ?, error = ? WHERE name = ?")
      .run(status, error, name);
  }

  touchCube(name: string): void {
    this.db.prepare("UPDATE cube SET last_active_at = ? WHERE name = ?").run(Date.now(), name);
  }

  /** Cascades to threads, portals and volumes; frees the subnet index. */
  deleteCube(name: string): void {
    this.db.prepare("DELETE FROM cube WHERE name = ?").run(name);
  }

  // ---------------------------------------------------------------- thread

  addThread(input: {
    id: string;
    cubeId: number;
    projectId: string;
    piSessionPath: string;
    title?: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO thread (id, cube_id, project_id, pi_session_path, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.cubeId, input.projectId, input.piSessionPath, input.title ?? null, Date.now());
  }

  getThread(id: string): ThreadRow | null {
    const row = this.db.prepare("SELECT * FROM thread WHERE id = ?").get(id);
    return row ? threadRow(row) : null;
  }

  listThreads(cubeId: number): ThreadRow[] {
    return (
      this.db
        .prepare("SELECT * FROM thread WHERE cube_id = ? ORDER BY created_at")
        .all(cubeId) as unknown[]
    ).map(threadRow);
  }

  setThreadTitle(id: string, title: string): void {
    this.db.prepare("UPDATE thread SET title = ? WHERE id = ?").run(title, id);
  }

  archiveThread(id: string): void {
    this.db.prepare("UPDATE thread SET archived_at = ? WHERE id = ?").run(Date.now(), id);
  }

  // ---------------------------------------------------------------- portal

  /**
   * Register (or update) the portal behind a declared service. Idempotent
   * per (cube, name); the hostname is stable for the cube's life by
   * construction (derived from cube + service name), the target port may
   * change when the declaration does.
   */
  upsertPortal(cubeId: number, name: string, targetPort: number, hostname: string): PortalRow {
    this.db
      .prepare(
        `INSERT INTO portal (cube_id, name, target_port, hostname, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(cube_id, name) DO UPDATE SET target_port = excluded.target_port`,
      )
      .run(cubeId, name, targetPort, hostname, Date.now());
    return portalRow(
      this.db.prepare("SELECT * FROM portal WHERE cube_id = ? AND name = ?").get(cubeId, name),
    );
  }

  /** Routing lookup: Host-header label -> portal (null = no such portal). */
  getPortalByHostname(hostname: string): PortalRow | null {
    const row = this.db.prepare("SELECT * FROM portal WHERE hostname = ?").get(hostname);
    return row ? portalRow(row) : null;
  }

  releasePortal(cubeId: number, name: string): void {
    this.db.prepare("DELETE FROM portal WHERE cube_id = ? AND name = ?").run(cubeId, name);
  }

  listPortals(cubeId: number): PortalRow[] {
    return (
      this.db
        .prepare("SELECT * FROM portal WHERE cube_id = ? ORDER BY name")
        .all(cubeId) as unknown[]
    ).map(portalRow);
  }

  // ---------------------------------------------------------------- volume

  addVolume(input: { cubeId: number; purpose: string; poolVolume: string; capBytes: number }): void {
    this.db
      .prepare(
        `INSERT INTO volume (cube_id, purpose, pool_volume, cap_bytes) VALUES (?, ?, ?, ?)
         ON CONFLICT(cube_id, purpose) DO UPDATE SET pool_volume = excluded.pool_volume,
                                                     cap_bytes = excluded.cap_bytes`,
      )
      .run(input.cubeId, input.purpose, input.poolVolume, input.capBytes);
  }

  listVolumes(cubeId: number): VolumeRow[] {
    return (
      this.db.prepare("SELECT * FROM volume WHERE cube_id = ?").all(cubeId) as unknown[]
    ).map(volumeRow);
  }

  close(): void {
    this.db.close();
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function cubeRow(r: any): CubeRow {
  return {
    id: Number(r.id),
    name: String(r.name),
    status: String(r.status),
    error: r.error === null ? null : String(r.error),
    image: String(r.image),
    workspacePath: String(r.workspace_path),
    subnetIndex: Number(r.subnet_index),
    createdAt: Number(r.created_at),
    lastActiveAt: Number(r.last_active_at),
  };
}

function threadRow(r: any): ThreadRow {
  return {
    id: String(r.id),
    cubeId: Number(r.cube_id),
    projectId: String(r.project_id),
    piSessionPath: String(r.pi_session_path),
    title: r.title === null ? null : String(r.title),
    createdAt: Number(r.created_at),
    archivedAt: r.archived_at === null ? null : Number(r.archived_at),
  };
}

function projectRow(r: any): ProjectRow {
  return {
    id: String(r.id),
    name: String(r.name),
    status: String(r.status) as ProjectStatus,
    error: r.error === null ? null : String(r.error),
    revision: Number(r.revision),
    checkedAt: r.checked_at === null ? null : Number(r.checked_at),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function projectRepositoryRow(r: any): ProjectRepositoryRow {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    position: Number(r.position),
    url: String(r.url),
    base: r.base === null ? null : String(r.base),
    checkoutName: String(r.checkout_name),
    status: String(r.status) as ProjectStatus,
    error: r.error === null ? null : String(r.error),
    resolvedBase: r.resolved_base === null ? null : String(r.resolved_base),
    baseOid: r.base_oid === null ? null : String(r.base_oid),
    checkedAt: r.checked_at === null ? null : Number(r.checked_at),
  };
}

function cubeRepositoryRow(r: any): CubeRepositoryRow {
  return {
    id: Number(r.id),
    cubeId: Number(r.cube_id),
    position: Number(r.position),
    url: String(r.url),
    base: String(r.base),
    branch: String(r.branch),
    baseOid: String(r.base_oid),
    checkoutName: String(r.checkout_name),
    workspacePath: String(r.workspace_path),
  };
}

function portalRow(r: any): PortalRow {
  return {
    id: Number(r.id),
    cubeId: Number(r.cube_id),
    name: String(r.name),
    targetPort: Number(r.target_port),
    hostname: String(r.hostname),
    createdAt: Number(r.created_at),
  };
}

function volumeRow(r: any): VolumeRow {
  return {
    id: Number(r.id),
    cubeId: Number(r.cube_id),
    purpose: String(r.purpose),
    poolVolume: String(r.pool_volume),
    capBytes: Number(r.cap_bytes),
  };
}
