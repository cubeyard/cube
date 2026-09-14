/**
 * cubed's SQLite registry (ARCHITECTURE §7) — metadata only, for what pi cannot
 * know: which cubes exist (with their allocated subnet), Cube-owned thread
 * history and agent runs, service portals (stable hostnames), and volumes.
 *
 * Uses node:sqlite (in Node since 22.5, no native dep). Single writer
 * (cubed) — no contention concerns.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { EventInput } from "./events.ts";
import { createLogger } from "./log.ts";
import { APP_VERSION } from "./version.ts";

// Every error column is written here, so every caller's failure reaches the
// journal (and `cube diagnose`) without each of them remembering to log.
const log = createLogger("registry");

/** The journal gets the head of an error, not the whole script tail: the
 * full text stays in the registry (same host, same trust), while a
 * `.cube/setup` that echoed a secret is not copied into logs wholesale. */
const brief = (error: string): string => (error.length > 200 ? `${error.slice(0, 200)}…` : error);

/** One recorded lifecycle event (see events.ts). */
export interface EventRow {
  id: number;
  /** ms epoch when the event was recorded (the end of a timed phase). */
  ts: number;
  kind: string;
  phase: string | null;
  /** Groups the phases of one operation; null for point events. */
  op: string | null;
  cube: string | null;
  thread: string | null;
  ok: boolean;
  ms: number | null;
  detail: string | null;
  version: string;
}

export interface EventFilter {
  since?: number;
  until?: number;
  cube?: string;
  thread?: string;
  kind?: string;
  /** Failures only. */
  failed?: boolean;
  limit?: number;
}

export interface CubeRow {
  id: number;
  name: string;
  /** creating | ready | asleep | waking | error | building-environment (internal). */
  status: string;
  error: string | null;
  image: string;
  workspacePath: string;
  /** "<checkout>/<path>" of a reference repository whose folder carries
   * this cube's .cube (setup, resume, cube.toml); null = the primary
   * checkout's own .cube. Snapshotted from the project at creation, like
   * the repositories. */
  environment: string | null;
  subnetIndex: number;
  createdAt: number;
  lastActiveAt: number;
}

export interface ThreadRow {
  id: string;
  cubeId: number;
  projectId: string;
  piSessionPath: string;
  title: string | null;
  createdAt: number;
  archivedAt: number | null;
}

export type ConversationRole = "user" | "assistant" | "tool";
export type AgentRunStatus = "queued" | "running" | "completed" | "failed";

export interface ConversationMessageRow {
  seq: number;
  threadId: string;
  runId: string;
  role: ConversationRole;
  content: string;
  payload: unknown;
  finalized: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AgentRunRow {
  id: string;
  threadId: string;
  status: AgentRunStatus;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export type ProjectStatus = "checking" | "ready" | "error";

export interface ProjectRow {
  id: string;
  name: string;
  status: ProjectStatus;
  error: string | null;
  /** "<checkout>/<path>": a folder of a reference repository that carries
   * the .cube directory, for a primary repository that does not ship one.
   * null = the primary's own .cube. */
  environment: string | null;
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

/** A prepared environment: a stopped builder instance plus snapshots of
 * its rootfs and docker volume, cloned into every thread of the project
 * whose environment declaration hashes to `key`. `building` rows mark a
 * capture in flight (boot cleans them up); only `ready` rows are cloned. */
export interface EnvironmentTemplateRow {
  id: string;
  projectId: string;
  key: string;
  status: "building" | "ready";
  instance: string;
  snapshot: string;
  volume: string;
  volumeSnapshot: string;
  createdAt: number;
  usedAt: number;
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

export interface TemporaryPortalRow {
  threadId: string;
  name: string;
  port: number;
  hostname: string;
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
  private transactionDepth = 0;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA recursive_triggers = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL COLLATE NOCASE UNIQUE,
        status      TEXT NOT NULL,
        error       TEXT,
        environment TEXT,
        revision    INTEGER NOT NULL,
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
        environment    TEXT,
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
      CREATE TABLE IF NOT EXISTS agent_run (
        id          TEXT PRIMARY KEY,
        thread_id   TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
        status      TEXT NOT NULL,
        error       TEXT,
        created_at  INTEGER NOT NULL,
        started_at  INTEGER,
        finished_at INTEGER
      );
      CREATE UNIQUE INDEX IF NOT EXISTS agent_run_active_thread
        ON agent_run(thread_id) WHERE status IN ('queued', 'running');
      CREATE TABLE IF NOT EXISTS conversation_message (
        seq        INTEGER PRIMARY KEY,
        thread_id  TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
        run_id     TEXT NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
        role       TEXT NOT NULL,
        content    TEXT NOT NULL,
        payload    TEXT NOT NULL,
        finalized  INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS conversation_message_thread_seq
        ON conversation_message(thread_id, seq);
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
      CREATE TABLE IF NOT EXISTS temporary_portal (
        thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE,
        port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
        name TEXT NOT NULL,
        hostname TEXT NOT NULL UNIQUE,
        PRIMARY KEY(thread_id, port)
      );
      CREATE TABLE IF NOT EXISTS volume (
        id          INTEGER PRIMARY KEY,
        cube_id     INTEGER NOT NULL REFERENCES cube(id) ON DELETE CASCADE,
        purpose     TEXT NOT NULL,
        pool_volume TEXT NOT NULL,
        cap_bytes   INTEGER NOT NULL,
        UNIQUE(cube_id, purpose)
      );
      CREATE TABLE IF NOT EXISTS environment_template (
        id              TEXT PRIMARY KEY,
        project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE RESTRICT,
        key             TEXT NOT NULL,
        status          TEXT NOT NULL,
        instance        TEXT NOT NULL UNIQUE,
        snapshot        TEXT NOT NULL,
        volume          TEXT NOT NULL,
        volume_snapshot TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        used_at         INTEGER NOT NULL,
        UNIQUE(project_id, key)
      );
      CREATE TABLE IF NOT EXISTS event (
        id      INTEGER PRIMARY KEY,
        ts      INTEGER NOT NULL,
        kind    TEXT NOT NULL,
        phase   TEXT,
        op      TEXT,
        cube    TEXT,
        thread  TEXT,
        ok      INTEGER NOT NULL,
        ms      INTEGER,
        detail  TEXT,
        version TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS event_ts ON event(ts);
      CREATE INDEX IF NOT EXISTS event_cube_ts ON event(cube, ts);
    `);
    this.migratePortalTable();
    this.requireProjectThreads();
    this.migrateThreadArchive(); // after: the project upgrade recreates `thread` without it
    this.migrateEnvironmentColumns();
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS thread_cube_id_unique ON thread(cube_id)");
    this.db.exec(`CREATE TABLE IF NOT EXISTS thread_model (
      thread_id TEXT PRIMARY KEY REFERENCES thread(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      id TEXT NOT NULL
    )`);
    this.migrateNodeBinding();
  }

  /** Local installation identity, not a transport key. Never regenerated once
   * the binding schema exists: a missing identity requires operator recovery. */
  get localNodeId(): string {
    const row = this.db.prepare("SELECT id FROM execution_node WHERE local = 1").get() as { id: string } | undefined;
    if (!row) throw new Error("local node identity is missing; restore the registry identity, do not rebind environments");
    return row.id;
  }

  nodeForCube(cubeId: number): string {
    const row = this.db.prepare("SELECT node_id FROM environment_node WHERE cube_id = ?").get(cubeId) as { node_id: string } | undefined;
    if (!row) throw new Error(`environment ${cubeId} has no node binding`);
    return row.node_id;
  }

  private migrateNodeBinding(): void {
    this.transaction(() => {
      const installed = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'execution_node'").get();
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS execution_node (id TEXT PRIMARY KEY, local INTEGER NOT NULL CHECK(local IN (0, 1)));
        CREATE TABLE IF NOT EXISTS environment_node (
          cube_id INTEGER PRIMARY KEY REFERENCES cube(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL REFERENCES execution_node(id)
        );
        CREATE TABLE IF NOT EXISTS environment_observation (
          cube_id INTEGER PRIMARY KEY REFERENCES cube(id) ON DELETE CASCADE, status TEXT NOT NULL, observed_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS thread_create_request (
          key TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES thread(id) ON DELETE CASCADE
        );
      `);
      // Rebuild the old local-only table without disabling foreign keys or
      // changing a single existing binding. Both replacements are transactional.
      const definition = (this.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'execution_node'").get() as { sql: string }).sql;
      if (definition.includes("CHECK(local = 1)")) {
        this.db.exec(`
          DROP TRIGGER IF EXISTS bind_new_environment;
          DROP TRIGGER IF EXISTS immutable_environment_node;
          DROP TRIGGER IF EXISTS retain_environment_node;
          DROP TRIGGER IF EXISTS immutable_node;
          DROP TRIGGER IF EXISTS retain_node;
          ALTER TABLE execution_node RENAME TO execution_node_legacy;
          CREATE TABLE execution_node (id TEXT PRIMARY KEY, local INTEGER NOT NULL CHECK(local IN (0, 1)));
          INSERT INTO execution_node SELECT * FROM execution_node_legacy;
          CREATE TABLE environment_node_new (
            cube_id INTEGER PRIMARY KEY REFERENCES cube(id) ON DELETE CASCADE,
            node_id TEXT NOT NULL REFERENCES execution_node(id)
          );
          INSERT INTO environment_node_new SELECT * FROM environment_node;
          DROP TABLE environment_node;
          ALTER TABLE environment_node_new RENAME TO environment_node;
          DROP TABLE execution_node_legacy;
        `);
      }
      this.db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS one_local_node ON execution_node(local) WHERE local = 1;
        CREATE TABLE IF NOT EXISTS host_node_admission (
          node_id TEXT PRIMARY KEY REFERENCES execution_node(id),
          environment_id INTEGER NOT NULL UNIQUE REFERENCES cube(id) DEFERRABLE INITIALLY DEFERRED,
          thread_id TEXT NOT NULL UNIQUE REFERENCES thread(id) DEFERRABLE INITIALLY DEFERRED,
          config_path TEXT NOT NULL, config_hash TEXT NOT NULL
        );
        CREATE TRIGGER IF NOT EXISTS immutable_host_admission BEFORE UPDATE ON host_node_admission BEGIN
          SELECT RAISE(ABORT, 'host admission is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS retain_host_admission BEFORE DELETE ON host_node_admission BEGIN
          SELECT RAISE(ABORT, 'host admission is permanent');
        END;
      `);
      if (!installed) {
        this.db.prepare("INSERT INTO execution_node(id, local) VALUES (?, 1)").run(`node-${randomUUID()}`);
        this.db.prepare("INSERT INTO environment_node SELECT id, ? FROM cube").run(this.localNodeId);
      } else {
        void this.localNodeId; // missing metadata is not permission to adopt a new host
        const unbound = this.db.prepare("SELECT id FROM cube WHERE id NOT IN (SELECT cube_id FROM environment_node) LIMIT 1").get();
        if (unbound) throw new Error("unbound environment in migrated registry; restore its binding before startup");
      }
      this.db.exec(`
        DROP TRIGGER IF EXISTS bind_new_environment;
        CREATE TRIGGER bind_new_environment AFTER INSERT ON cube BEGIN
          INSERT INTO environment_node(cube_id, node_id) VALUES (NEW.id,
            COALESCE((SELECT node_id FROM host_node_admission WHERE environment_id = NEW.id),
              (SELECT id FROM execution_node WHERE local = 1)));
        END;
        CREATE TRIGGER IF NOT EXISTS check_host_thread BEFORE INSERT ON thread
          WHEN EXISTS (SELECT 1 FROM host_node_admission WHERE environment_id = NEW.cube_id AND thread_id != NEW.id)
            OR EXISTS (SELECT 1 FROM host_node_admission WHERE thread_id = NEW.id AND environment_id != NEW.cube_id) BEGIN
          SELECT RAISE(ABORT, 'wrong host thread binding');
        END;
        CREATE TRIGGER IF NOT EXISTS immutable_environment_node BEFORE UPDATE ON environment_node BEGIN
          SELECT RAISE(ABORT, 'environment node binding is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS retain_environment_node BEFORE DELETE ON environment_node
          WHEN EXISTS (SELECT 1 FROM cube WHERE id = OLD.cube_id) BEGIN
          SELECT RAISE(ABORT, 'environment node binding is permanent');
        END;
        CREATE TRIGGER IF NOT EXISTS immutable_node BEFORE UPDATE ON execution_node BEGIN
          SELECT RAISE(ABORT, 'node identity is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS retain_node BEFORE DELETE ON execution_node BEGIN
          SELECT RAISE(ABORT, 'local node identity is permanent');
        END;
        CREATE TRIGGER IF NOT EXISTS retain_host_environment BEFORE DELETE ON cube
          WHEN EXISTS (SELECT 1 FROM host_node_admission WHERE environment_id = OLD.id) BEGIN
          SELECT RAISE(ABORT, 'host environment is permanent; archive its thread instead');
        END;
        CREATE TRIGGER IF NOT EXISTS retain_host_thread BEFORE DELETE ON thread
          WHEN EXISTS (SELECT 1 FROM host_node_admission WHERE thread_id = OLD.id) BEGIN
          SELECT RAISE(ABORT, 'host thread is permanent; archive it instead');
        END;
        CREATE TRIGGER IF NOT EXISTS immutable_environment_identity BEFORE UPDATE OF id, name, workspace_path ON cube
          WHEN NEW.id != OLD.id OR NEW.name != OLD.name OR NEW.workspace_path != OLD.workspace_path BEGIN
          SELECT RAISE(ABORT, 'environment identity is immutable');
        END;
        CREATE TRIGGER IF NOT EXISTS immutable_thread_environment BEFORE UPDATE OF cube_id ON thread
          WHEN NEW.cube_id != OLD.cube_id BEGIN
          SELECT RAISE(ABORT, 'thread environment binding is immutable');
        END;
      `);
    });
  }

  observeEnvironment(cubeId: number, observation: { status: string; observedAt: number }): void {
    this.db.prepare(`INSERT INTO environment_observation(cube_id, status, observed_at) VALUES (?, ?, ?)
      ON CONFLICT(cube_id) DO UPDATE SET status = excluded.status, observed_at = excluded.observed_at`)
      .run(cubeId, observation.status, observation.observedAt);
  }

  environmentObservation(cubeId: number): { status: string; observedAt: number } | null {
    return (this.db.prepare("SELECT status, observed_at AS observedAt FROM environment_observation WHERE cube_id = ?").get(cubeId) as { status: string; observedAt: number } | undefined) ?? null;
  }

  createdThread(key: string): string | null {
    const row = this.db.prepare("SELECT thread_id FROM thread_create_request WHERE key = ?").get(key) as { thread_id: string } | undefined;
    return row?.thread_id ?? null;
  }

  // ---------------------------------------------------------------- events

  /** Append one lifecycle event (events.ts). Never throws into the caller:
   * a full disk must not turn a successful wake into a failure. Events are
   * not part of any cube/thread cascade — history outlives deletion. */
  recordEvent(input: EventInput): void {
    try {
      this.db
        .prepare(
          `INSERT INTO event (ts, kind, phase, op, cube, thread, ok, ms, detail, version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          Date.now(),
          input.kind,
          input.phase ?? null,
          input.op ?? null,
          input.cube ?? null,
          input.thread ?? null,
          input.ok ? 1 : 0,
          input.ms ?? null,
          input.detail ?? null,
          APP_VERSION,
        );
    } catch (error) {
      console.log(`event not recorded (${input.kind}): ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Newest first. */
  listEvents(filter: EventFilter = {}): EventRow[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.since !== undefined) { where.push("ts >= ?"); params.push(filter.since); }
    if (filter.until !== undefined) { where.push("ts <= ?"); params.push(filter.until); }
    if (filter.cube) { where.push("cube = ?"); params.push(filter.cube); }
    if (filter.thread) { where.push("thread = ?"); params.push(filter.thread); }
    if (filter.kind) { where.push("kind = ?"); params.push(filter.kind); }
    if (filter.failed) where.push("ok = 0");
    const limit = Math.min(Math.max(Math.floor(filter.limit ?? 200), 1), 10_000);
    const sql = `SELECT * FROM event${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ts DESC, id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...params, limit) as unknown[]).map(eventRow);
  }

  /** Drop events older than the retention window and, beyond `maxRows`,
   * the oldest of the rest; returns how many went. Best-effort like
   * recordEvent: telemetry maintenance must never stop a boot or a sweep. */
  pruneEvents(olderThanMs: number, maxRows = 200_000): number {
    try {
      let changes = Number(this.db.prepare("DELETE FROM event WHERE ts < ?").run(Date.now() - olderThanMs).changes);
      changes += Number(
        this.db
          .prepare("DELETE FROM event WHERE id NOT IN (SELECT id FROM event ORDER BY id DESC LIMIT ?)")
          .run(Math.max(1, Math.floor(maxRows))).changes,
      );
      return changes;
    } catch (error) {
      console.log(`events not pruned: ${error instanceof Error ? error.message : String(error)}`);
      return 0;
    }
  }

  private migrateThreadArchive(): void {
    const columns = this.db.prepare("PRAGMA table_info(thread)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "archived_at")) {
      this.db.exec("ALTER TABLE thread ADD COLUMN archived_at INTEGER");
    }
  }

  /** A project may keep its environment (.cube) in a reference repository
   * (2026-09-10); a cube snapshots that choice as it snapshots repositories.
   * Nullable and additive: older rows keep the primary's own .cube. */
  private migrateEnvironmentColumns(): void {
    for (const table of ["project", "cube"]) {
      const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "environment")) {
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN environment TEXT`);
      }
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
    environment?: string | null;
  }): ProjectRow {
    const now = Date.now();
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO project (id, name, status, error, environment, revision, checked_at, created_at, updated_at)
           VALUES (?, ?, 'checking', NULL, ?, 1, NULL, ?, ?)`,
        )
        .run(input.id, input.name, input.environment ?? null, now, now);
      this.insertProjectRepositories(input.id, input.repositories);
    });
    return this.getProject(input.id)!;
  }

  updateProject(
    id: string,
    input: {
      name: string;
      repositories: Array<{ id: string; url: string; base: string | null; checkoutName: string }>;
      environment?: string | null;
    },
  ): ProjectRow {
    const now = Date.now();
    this.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE project
           SET name = ?, status = 'checking', error = NULL, environment = ?, checked_at = NULL,
               revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(input.name, input.environment ?? null, now, id);
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
    if (result.error) log.warn("project repository error", { repository: id, status: result.status, error: brief(result.error) });
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
    if (error) log.warn("project error", { project: id, revision, status, error: brief(error) });
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
    if (this.transactionDepth) return work();
    this.transactionDepth++;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally { this.transactionDepth--; }
  }

  // --------------------------------------------------- environment templates

  createEnvironmentTemplate(input: Omit<EnvironmentTemplateRow, "createdAt" | "usedAt">): EnvironmentTemplateRow {
    const now = Date.now();
    this.db.prepare(
      `INSERT INTO environment_template (id, project_id, key, status, instance, snapshot, volume, volume_snapshot, created_at, used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.id, input.projectId, input.key, input.status, input.instance, input.snapshot, input.volume, input.volumeSnapshot, now, now);
    return this.getEnvironmentTemplate(input.id)!;
  }

  getEnvironmentTemplate(id: string): EnvironmentTemplateRow | null {
    const row = this.db.prepare("SELECT * FROM environment_template WHERE id = ?").get(id);
    return row ? environmentTemplateRow(row) : null;
  }

  findEnvironmentTemplate(projectId: string, key: string): EnvironmentTemplateRow | null {
    const row = this.db.prepare("SELECT * FROM environment_template WHERE project_id = ? AND key = ?").get(projectId, key);
    return row ? environmentTemplateRow(row) : null;
  }

  listEnvironmentTemplates(projectId?: string): EnvironmentTemplateRow[] {
    const rows = projectId === undefined
      ? this.db.prepare("SELECT * FROM environment_template ORDER BY created_at").all()
      : this.db.prepare("SELECT * FROM environment_template WHERE project_id = ? ORDER BY created_at").all(projectId);
    return (rows as unknown[]).map(environmentTemplateRow);
  }

  setEnvironmentTemplateStatus(id: string, status: EnvironmentTemplateRow["status"]): void {
    this.db.prepare("UPDATE environment_template SET status = ?, used_at = ? WHERE id = ?").run(status, Date.now(), id);
  }

  touchEnvironmentTemplate(id: string): void {
    this.db.prepare("UPDATE environment_template SET used_at = ? WHERE id = ?").run(Date.now(), id);
  }

  deleteEnvironmentTemplate(id: string): void {
    this.db.prepare("DELETE FROM environment_template WHERE id = ?").run(id);
  }

  // ------------------------------------------------------------------ cube

  createCube(input: {
    name: string;
    image: string;
    workspacePath: string;
    environment?: string | null;
  }, environmentId?: number): CubeRow {
    if (!CUBE_NAME_RE.test(input.name)) {
      throw new Error(
        `invalid cube name ${JSON.stringify(input.name)} — need ${CUBE_NAME_RE} (bridge name must fit IFNAMSIZ)`,
      );
    }
    const subnetIndex = this.allocateSubnetIndex();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO cube (id, name, status, image, workspace_path, environment, subnet_index, created_at, last_active_at)
         VALUES (?, ?, 'creating', ?, ?, ?, ?, ?, ?)`,
      )
      .run(environmentId ?? null, input.name, input.image, input.workspacePath, input.environment ?? null, subnetIndex, now, now);
    return this.getCube(input.name)!;
  }

  /** Atomic allocation: a crash cannot leave a committed environment without
   * its thread and successful request identity. All inputs are metadata. */
  allocateThread(input: {
    cube: Parameters<Registry["createCube"]>[0];
    repositories: Parameters<Registry["addCubeRepositories"]>[1];
    thread: Omit<Parameters<Registry["addThread"]>[0], "cubeId">;
  }): CubeRow {
    return this.transaction(() => {
      const cube = this.createCube(input.cube);
      this.addCubeRepositories(cube.id, input.repositories);
      this.addThread({ ...input.thread, cubeId: cube.id });
      return cube;
    });
  }

  /** Operator-only, create-only enrollment. No public route calls this method.
   * The host is already initialized with these identities. Existing resources
   * can never be adopted, moved or replaced, even when offline. */
  enrollHostThread(input: {
    nodeId: string; environmentId: number; threadId: string;
    configPath: string; configHash: string; projectId: string;
    name: string; workspacePath: string; piSessionPath: string;
  }): CubeRow {
    if (!/^node-[a-zA-Z0-9-]{1,123}$/.test(input.nodeId)
      || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.threadId)
      || !Number.isSafeInteger(input.environmentId) || input.environmentId < 1
      || !path.isAbsolute(input.configPath) || !/^[0-9a-f]{64}$/.test(input.configHash)
      || !path.isAbsolute(input.workspacePath) || !path.isAbsolute(input.piSessionPath)) throw new Error("invalid host admission");
    return this.transaction(() => {
      if (this.getCubeById(input.environmentId) || this.getThread(input.threadId)) throw new Error("host enrollment requires fresh identities");
      this.db.prepare("INSERT INTO execution_node(id, local) VALUES (?, 0)").run(input.nodeId);
      this.db.prepare("INSERT INTO host_node_admission VALUES (?, ?, ?, ?, ?)")
        .run(input.nodeId, input.environmentId, input.threadId, input.configPath, input.configHash);
      const cube = this.createCube({ name: input.name, image: "trusted-host", workspacePath: input.workspacePath }, input.environmentId);
      this.addThread({ id: input.threadId, cubeId: cube.id, projectId: input.projectId, piSessionPath: input.piSessionPath });
      this.setCubeStatus(cube.name, "ready"); // admission, NOT a live contact observation
      return this.getCube(cube.name)!;
    });
  }

  hostNodeAdmissions(): Array<{ nodeId: string; environmentId: number; threadId: string; configPath: string; configHash: string }> {
    return this.db.prepare(`SELECT node_id AS nodeId, environment_id AS environmentId,
      thread_id AS threadId, config_path AS configPath, config_hash AS configHash FROM host_node_admission`).all() as ReturnType<Registry["hostNodeAdmissions"]>;
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
    if (error) log.warn("cube error", { cube: name, status, error: brief(error) });
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
    requestKey?: string;
  }): void {
    this.transaction(() => {
    this.db
      .prepare(
        `INSERT INTO thread (id, cube_id, project_id, pi_session_path, title, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.id, input.cubeId, input.projectId, input.piSessionPath, input.title ?? null, Date.now());
    if (input.requestKey !== undefined) {
      this.db.prepare("INSERT INTO thread_create_request(key, thread_id) VALUES (?, ?)").run(input.requestKey, input.id);
    }
    });
  }

  getThread(id: string): ThreadRow | null {
    const row = this.db.prepare("SELECT * FROM thread WHERE id = ?").get(id);
    return row ? threadRow(row) : null;
  }

  getThreadModel(threadId: string): { provider: string; id: string } | null {
    return this.db.prepare("SELECT provider, id FROM thread_model WHERE thread_id = ?").get(threadId) as
      { provider: string; id: string } | undefined ?? null;
  }

  setThreadModel(threadId: string, model: { provider: string; id: string }): void {
    this.db.prepare(`INSERT INTO thread_model (thread_id, provider, id) VALUES (?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET provider = excluded.provider, id = excluded.id`)
      .run(threadId, model.provider, model.id);
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
    this.db.prepare("DELETE FROM temporary_portal WHERE thread_id = ?").run(id);
  }

  /** Persist acceptance before any worker starts. The active-run index makes
   * the one-writer-per-thread invariant durable across HTTP requests. */
  createAgentRun(input: { id: string; threadId: string; text: string }): AgentRunRow {
    const now = Date.now();
    this.transaction(() => {
      this.db.prepare(
        `INSERT INTO agent_run (id, thread_id, status, error, created_at)
         VALUES (?, ?, 'queued', NULL, ?)`,
      ).run(input.id, input.threadId, now);
      this.db.prepare(
        `INSERT INTO conversation_message
         (thread_id, run_id, role, content, payload, created_at, updated_at)
         VALUES (?, ?, 'user', ?, ?, ?, ?)`,
      ).run(
        input.threadId,
        input.id,
        input.text,
        JSON.stringify({ role: "user", content: input.text, timestamp: now }),
        now,
        now,
      );
    });
    return this.getAgentRun(input.id)!;
  }

  getAgentRun(id: string): AgentRunRow | null {
    const row = this.db.prepare("SELECT * FROM agent_run WHERE id = ?").get(id);
    return row ? agentRunRow(row) : null;
  }

  activeAgentRun(threadId: string): AgentRunRow | null {
    const row = this.db.prepare(
      "SELECT * FROM agent_run WHERE thread_id = ? AND status IN ('queued', 'running') LIMIT 1",
    ).get(threadId);
    return row ? agentRunRow(row) : null;
  }

  latestAgentRun(threadId: string): AgentRunRow | null {
    const row = this.db.prepare(
      "SELECT * FROM agent_run WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1",
    ).get(threadId);
    return row ? agentRunRow(row) : null;
  }

  setAgentRunStatus(id: string, status: AgentRunStatus, error: string | null = null): void {
    const now = Date.now();
    const result = status === "running"
      ? this.db.prepare(
        "UPDATE agent_run SET status = ?, error = NULL, started_at = ? WHERE id = ? AND status = 'queued'",
      ).run(status, now, id)
      : this.db.prepare(
        `UPDATE agent_run SET status = ?, error = ?, finished_at = ?
         WHERE id = ? AND status IN ('queued', 'running')`,
      ).run(status, error, now, id);
    if (result.changes === 0) throw new Error(`agent run cannot transition to ${status}: ${id}`);
  }

  /** A daemon restart cannot know whether an external model or tool finished.
   * Fail interrupted work rather than replaying side effects. */
  failInterruptedAgentRuns(): number {
    return Number(this.db.prepare(
      `UPDATE agent_run SET status = 'failed', error = 'agent run interrupted by host restart', finished_at = ?
       WHERE status IN ('queued', 'running')`,
    ).run(Date.now()).changes);
  }

  appendConversationMessage(input: {
    threadId: string;
    runId: string;
    role: ConversationRole;
    content: string;
    payload: unknown;
    finalized?: boolean;
  }): ConversationMessageRow {
    const now = Date.now();
    const result = this.db.prepare(
      `INSERT INTO conversation_message
       (thread_id, run_id, role, content, payload, finalized, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.threadId, input.runId, input.role, input.content, JSON.stringify(input.payload), input.finalized === false ? 0 : 1, now, now);
    return this.getConversationMessage(Number(result.lastInsertRowid))!;
  }

  updateConversationMessage(seq: number, content: string, payload: unknown, finalized?: boolean): void {
    this.db.prepare(
      `UPDATE conversation_message SET content = ?, payload = ?,
       finalized = COALESCE(?, finalized), updated_at = ? WHERE seq = ?`,
    ).run(content, JSON.stringify(payload), finalized === undefined ? null : finalized ? 1 : 0, Date.now(), seq);
  }

  getConversationMessage(seq: number): ConversationMessageRow | null {
    const row = this.db.prepare("SELECT * FROM conversation_message WHERE seq = ?").get(seq);
    return row ? conversationMessageRow(row) : null;
  }

  listConversationMessages(threadId: string, after = 0): ConversationMessageRow[] {
    return (this.db.prepare(
      "SELECT * FROM conversation_message WHERE thread_id = ? AND seq > ? ORDER BY seq",
    ).all(threadId, after) as unknown[]).map(conversationMessageRow);
  }

  // ---------------------------------------------------------------- portal

  upsertTemporaryPortal(threadId: string, port: number, name: string, hostname: string): void {
    this.db.prepare(`INSERT INTO temporary_portal (thread_id, port, name, hostname) VALUES (?, ?, ?, ?)
      ON CONFLICT(thread_id, port) DO UPDATE SET name = excluded.name`).run(threadId, port, name, hostname);
  }

  listTemporaryPortals(threadId: string): TemporaryPortalRow[] {
    return this.db.prepare(`SELECT thread_id AS threadId, port, name, hostname FROM temporary_portal
      WHERE thread_id = ? ORDER BY port`).all(threadId) as unknown as TemporaryPortalRow[];
  }

  getTemporaryPortal(hostname: string): TemporaryPortalRow | null {
    return (this.db.prepare(`SELECT p.thread_id AS threadId, p.port, p.name, p.hostname
      FROM temporary_portal p JOIN thread t ON t.id = p.thread_id
      WHERE p.hostname = ? AND t.archived_at IS NULL`).get(hostname) as unknown as TemporaryPortalRow) ?? null;
  }

  removeTemporaryPortal(threadId: string, port: number): void {
    this.db.prepare("DELETE FROM temporary_portal WHERE thread_id = ? AND port = ?").run(threadId, port);
  }

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

function cubeRow(r: any): CubeRow {
  return {
    id: Number(r.id),
    name: String(r.name),
    status: String(r.status),
    error: r.error === null ? null : String(r.error),
    image: String(r.image),
    workspacePath: String(r.workspace_path),
    environment: r.environment === null || r.environment === undefined ? null : String(r.environment),
    subnetIndex: Number(r.subnet_index),
    createdAt: Number(r.created_at),
    lastActiveAt: Number(r.last_active_at),
  };
}

function eventRow(r: any): EventRow {
  return {
    id: Number(r.id),
    ts: Number(r.ts),
    kind: String(r.kind),
    phase: r.phase === null ? null : String(r.phase),
    op: r.op === null ? null : String(r.op),
    cube: r.cube === null ? null : String(r.cube),
    thread: r.thread === null ? null : String(r.thread),
    ok: Number(r.ok) === 1,
    ms: r.ms === null ? null : Number(r.ms),
    detail: r.detail === null ? null : String(r.detail),
    version: String(r.version),
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

function agentRunRow(r: any): AgentRunRow {
  return {
    id: String(r.id),
    threadId: String(r.thread_id),
    status: String(r.status) as AgentRunStatus,
    error: r.error === null ? null : String(r.error),
    createdAt: Number(r.created_at),
    startedAt: r.started_at === null ? null : Number(r.started_at),
    finishedAt: r.finished_at === null ? null : Number(r.finished_at),
  };
}

function conversationMessageRow(r: any): ConversationMessageRow {
  return {
    seq: Number(r.seq),
    threadId: String(r.thread_id),
    runId: String(r.run_id),
    role: String(r.role) as ConversationRole,
    content: String(r.content),
    payload: JSON.parse(String(r.payload)),
    finalized: Number(r.finalized) === 1,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

function projectRow(r: any): ProjectRow {
  return {
    id: String(r.id),
    name: String(r.name),
    status: String(r.status) as ProjectStatus,
    error: r.error === null ? null : String(r.error),
    environment: r.environment === null || r.environment === undefined ? null : String(r.environment),
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

function environmentTemplateRow(r: any): EnvironmentTemplateRow {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    key: String(r.key),
    status: String(r.status) as EnvironmentTemplateRow["status"],
    instance: String(r.instance),
    snapshot: String(r.snapshot),
    volume: String(r.volume),
    volumeSnapshot: String(r.volume_snapshot),
    createdAt: Number(r.created_at),
    usedAt: Number(r.used_at),
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
