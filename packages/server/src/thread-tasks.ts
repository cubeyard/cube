/** Control-plane task journal. Not yet wired to HTTP or Pi delivery.
 * Callers must derive actor from a trusted thread capability, never request data.
 * Only the operator may grant/revoke. This module never starts an agent or node.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type ThreadTaskState = "accepted" | "delivery_unknown" | "delivered" | "completed";
export interface ThreadTask {
  id: string;
  sender: string;
  recipient: string;
  requestKey: string;
  body: string;
  state: ThreadTaskState;
  result: string | null;
  createdAt: number;
}

const projection = `id, sender, recipient, request_key AS requestKey, body, state, result, created_at AS createdAt`;
const MAX_TASKS = 10_000;

function bounded(value: string, bytes: number): void {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > bytes || Buffer.from(value, "utf8").toString("utf8") !== value) {
    throw new Error("invalid or oversized task field");
  }
}

/** Uses cubed's schema on a control-plane-only connection. Enabling this is
 * explicit until lifecycle/API integration is complete. Retained task FKs
 * intentionally block destructive thread deletion; archiving remains possible.
 */
export class ThreadTaskJournal {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_task_grant (
        sender TEXT NOT NULL REFERENCES thread(id),
        recipient TEXT NOT NULL REFERENCES thread(id),
        PRIMARY KEY(sender, recipient), CHECK(sender <> recipient)
      );
      CREATE TABLE IF NOT EXISTS thread_task (
        id TEXT PRIMARY KEY,
        sender TEXT NOT NULL REFERENCES thread(id),
        recipient TEXT NOT NULL REFERENCES thread(id),
        request_key TEXT NOT NULL,
        body TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('accepted','delivery_unknown','delivered','completed')),
        result TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE(sender, request_key), CHECK(sender <> recipient),
        CHECK((state = 'completed') = (result IS NOT NULL))
      );
    `);
  }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private active(id: string): { project_id: string } {
    bounded(id, 128);
    const thread = this.db.prepare("SELECT project_id, archived_at FROM thread WHERE id = ?").get(id);
    if (!thread || thread.archived_at !== null) throw new Error("task thread unavailable");
    return thread as { project_id: string };
  }

  private permitted(sender: string, recipient: string): void {
    const source = this.active(sender);
    const target = this.active(recipient);
    if (source.project_id !== target.project_id || !this.db.prepare(
      "SELECT 1 FROM thread_task_grant WHERE sender = ? AND recipient = ?",
    ).get(sender, recipient)) throw new Error("task destination not permitted");
  }

  /** Operator-only. No transitive, reverse, self or cross-project permission. */
  grant(sender: string, recipient: string): void {
    this.transaction(() => {
      const source = this.active(sender);
      const target = this.active(recipient);
      if (sender === recipient || source.project_id !== target.project_id) throw new Error("task destination not permitted");
      this.db.prepare("INSERT OR IGNORE INTO thread_task_grant VALUES (?, ?)").run(sender, recipient);
    });
  }

  /** Stops new acceptance/delivery, not already handed-off work or result reporting. */
  revoke(sender: string, recipient: string): void {
    this.db.prepare("DELETE FROM thread_task_grant WHERE sender = ? AND recipient = ?").run(sender, recipient);
  }

  /** Stable request key is chosen before this call. Identical retries inspect the
   * original record, including after revocation/archive; they never redeliver.
   */
  accept(sender: string, recipient: string, requestKey: string, body: string): ThreadTask {
    bounded(sender, 128); bounded(recipient, 128); bounded(requestKey, 128); bounded(body, 16_384);
    return this.transaction(() => {
      const existing = this.db.prepare(`SELECT ${projection} FROM thread_task WHERE sender = ? AND request_key = ?`)
        .get(sender, requestKey) as unknown as ThreadTask | undefined;
      if (existing) {
        if (existing.recipient !== recipient || existing.body !== body) throw new Error("task request key conflict");
        return { ...existing };
      }
      this.permitted(sender, recipient);
      const count = this.db.prepare("SELECT count(*) AS n FROM thread_task").get()!.n as number;
      if (count >= MAX_TASKS) throw new Error("task journal full; retained identities cannot be evicted");
      const task: ThreadTask = {
        id: randomUUID(), sender, recipient, requestKey, body,
        state: "accepted", result: null, createdAt: Date.now(),
      };
      this.db.prepare(`INSERT INTO thread_task VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(task.id, sender, recipient, requestKey, body, task.state, null, task.createdAt);
      return task;
    });
  }

  /** Read-only and participant-scoped; no global thread/history enumeration. */
  get(actor: string, id: string): ThreadTask {
    bounded(actor, 128); bounded(id, 128);
    const task = this.db.prepare(`SELECT ${projection} FROM thread_task WHERE id = ? AND (sender = ? OR recipient = ?)`)
      .get(id, actor, actor) as unknown as ThreadTask | undefined;
    if (!task) throw new Error("task not found");
    return { ...task };
  }

  /** Trusted delivery adapter ONLY: reserve durably BEFORE invoking Pi. Returns
   * null on any subsequent attempt, even after restart. A lost response here may
   * mean no prompt was sent; uncertainty is intentional, not permission to retry.
   * This is not an inbox poll: reading status never consumes delivery.
   */
  beginDelivery(recipient: string, id: string): ThreadTask | null {
    return this.transaction(() => {
      const task = this.get(recipient, id);
      if (task.recipient !== recipient) throw new Error("task recipient required");
      if (task.state !== "accepted") return null;
      this.permitted(task.sender, recipient);
      this.db.prepare("UPDATE thread_task SET state = 'delivery_unknown' WHERE id = ?").run(id);
      return { ...task, state: "delivery_unknown" };
    });
  }

  /** Acknowledgement must come from the receiving Pi integration, not merely a
   * successful socket write. Late acknowledgement can reconcile uncertainty.
   */
  acknowledge(recipient: string, id: string): ThreadTask {
    return this.transaction(() => {
      const task = this.get(recipient, id);
      if (task.recipient !== recipient) throw new Error("task recipient required");
      if (task.state === "accepted") throw new Error("task delivery not started");
      if (task.state === "delivery_unknown") {
        this.db.prepare("UPDATE thread_task SET state = 'delivered' WHERE id = ?").run(id);
      }
      return this.get(recipient, id);
    });
  }

  /** Explicit agent result, not inferred from terminal silence or agent_end.
   * Completion records data for the sender to inspect; it does not prompt it.
   * In-flight results may settle after either participant is archived/revoked.
   */
  complete(recipient: string, id: string, result: string): ThreadTask {
    bounded(result, 16_384);
    return this.transaction(() => {
      const task = this.get(recipient, id);
      if (task.recipient !== recipient) throw new Error("task recipient required");
      if (task.state === "completed") {
        if (task.result !== result) throw new Error("task result conflict");
        return task;
      }
      if (task.state !== "delivered") throw new Error("task delivery not acknowledged");
      this.db.prepare("UPDATE thread_task SET state = 'completed', result = ? WHERE id = ?").run(result, id);
      return this.get(recipient, id);
    });
  }
}
