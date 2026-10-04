/** The single writable owner of a thread workspace. One lease per thread:
 * a random token (the authorization), the owner agent, a fencing epoch and,
 * for remote holders, a heartbeat deadline.
 *
 * Liveness of the holding cubed process is OS-backed: while a lease is held,
 * a dedicated SQLite connection keeps `BEGIN IMMEDIATE` open on `lease.lock`.
 * Process death releases it at once, without stale PID files; a competing
 * process or instance cannot take the lock and is refused. The epoch is the
 * only durable lease state. It never decreases, and the runner rejects
 * mutations that carry an older epoch than the newest it has seen. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { WorkspaceError, type WorkspaceLease, type WorkspaceOwner } from "./workspace.ts";

export const MIN_LEASE_TTL_MS = 1000;
export const MAX_LEASE_TTL_MS = 120000;
export const DEFAULT_LEASE_TTL_MS = 30000;
const TOKEN = /^[0-9a-f]{64}$/;

interface Held { tokenSha: Buffer; owner: WorkspaceOwner; epoch: number; ttlMs: number | null; expiresAt: number | null; timer?: NodeJS.Timeout }

export class LeaseStore {
  private readonly db: DatabaseSync;
  private readonly lockPath: string;
  private lock: DatabaseSync | undefined;
  private held: Held | undefined;
  private closed = false;

  constructor(directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.lockPath = path.join(directory, "lease.lock");
    this.db = new DatabaseSync(path.join(directory, "lease.sqlite"));
    try {
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY CHECK(id = 1), epoch INTEGER NOT NULL CHECK(epoch >= 1), owner TEXT NOT NULL);
        CREATE TRIGGER IF NOT EXISTS monotonic_lease_epoch BEFORE UPDATE OF epoch ON lease WHEN NEW.epoch <= OLD.epoch
          BEGIN SELECT RAISE(ABORT, 'lease epoch must increase'); END;`);
    } catch (error) { this.db.close(); throw error; }
  }

  /** Acquire the lease. Without `ttlMs` it is held until release or process
   * death (in-process agents); with `ttlMs` it must be renewed in time. */
  acquire(owner: WorkspaceOwner, ttlMs?: number): WorkspaceLease {
    this.open();
    if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < MIN_LEASE_TTL_MS || ttlMs > MAX_LEASE_TTL_MS)) {
      throw new WorkspaceError("INVALID_REQUEST", `lease ttl must be ${MIN_LEASE_TTL_MS}-${MAX_LEASE_TTL_MS} ms`);
    }
    this.expire();
    if (this.held) throw held();
    const row = this.db.prepare("SELECT epoch, owner FROM lease WHERE id = 1").get() as { epoch: number; owner: string } | undefined;
    if (row && row.owner !== owner) throw new WorkspaceError("CONFLICT", `thread workspace belongs to ${row.owner}`);
    this.takeLock();
    try {
      // Time-based epochs stay increasing even if this file is ever lost:
      // the runner's fence then still admits the new holder.
      const epoch = Math.max((row?.epoch ?? 0) + 1, Date.now());
      this.db.prepare("INSERT INTO lease(id, epoch, owner) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch")
        .run(epoch, owner);
      const token = randomBytes(32).toString("hex");
      this.held = { tokenSha: sha(token), owner, epoch, ttlMs: ttlMs ?? null, expiresAt: null };
      this.schedule();
      return { token, owner, epoch, expiresAt: this.held.expiresAt };
    } catch (error) { this.dropLock(); throw error; }
  }

  /** Heartbeat: extend a remote lease by its ttl. */
  renew(token: string): WorkspaceLease {
    const current = this.verify(token);
    this.schedule();
    return { token, owner: current.owner, epoch: current.epoch, expiresAt: current.expiresAt };
  }

  /** Throws LEASE_STALE unless `token` is the current, unexpired lease. */
  verify(token: string): Held {
    this.open();
    this.expire();
    const current = this.held;
    if (!current || typeof token !== "string" || !TOKEN.test(token) || !timingSafeEqual(sha(token), current.tokenSha)) {
      throw new WorkspaceError("LEASE_STALE", "workspace lease is not held by this token");
    }
    return current;
  }

  /** The owner holding the lease now, if any. */
  holder(): WorkspaceOwner | null {
    if (this.closed) return null;
    this.expire();
    return this.held?.owner ?? null;
  }

  release(token: string): void {
    this.verify(token);
    this.clear();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clear();
    this.db.close();
  }

  private open(): void {
    if (this.closed) throw new WorkspaceError("LEASE_STALE", "workspace lease store is closed");
  }
  private expire(): void {
    if (this.held?.expiresAt != null && this.held.expiresAt <= Date.now()) this.clear();
  }
  private schedule(): void {
    const current = this.held!;
    if (current.ttlMs === null) return;
    current.expiresAt = Date.now() + current.ttlMs;
    clearTimeout(current.timer);
    // Release the OS lock promptly once a remote holder stops heartbeating.
    current.timer = setTimeout(() => this.expire(), current.ttlMs + 10);
    current.timer.unref();
  }
  private clear(): void {
    if (this.held) clearTimeout(this.held.timer);
    this.held = undefined;
    this.dropLock();
  }
  private takeLock(): void {
    const lock = new DatabaseSync(this.lockPath);
    try { lock.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE"); }
    catch (cause) {
      lock.close();
      throw held(cause);
    }
    this.lock = lock;
  }
  private dropLock(): void {
    const lock = this.lock;
    this.lock = undefined;
    lock?.close();
  }
}

function sha(token: string): Buffer { return createHash("sha256").update(token).digest(); }
function held(cause?: unknown): WorkspaceError {
  return new WorkspaceError("LEASE_HELD", "thread workspace already has a writable owner", { cause });
}
