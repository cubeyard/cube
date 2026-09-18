import net from "node:net";
import { randomUUID } from "node:crypto";
import { CUBED_COMMIT, CUBED_STATE_SCHEMA, CUBED_VERSION } from "./version.ts";

export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "verifying" |
  "staging" | "draining" | "restarting" | "probation" | "updated" | "rolled-back" | "failed";

export interface UpdateStatus {
  installation: "managed" | "unmanaged" | "read-only";
  enabled: boolean;
  current: { version: string; commit: string; stateSchema: number };
  available: null | { version: string; commit: string; publishedAt: string | null; bytes: number; notesUrl: string | null };
  phase: UpdatePhase;
  targetVersion: string | null;
  error: string | null;
  message: string | null;
  runnersUpdated: false;
}

type SupervisorInput =
  | { action: "status" | "check" }
  | { action: "install"; targetVersion: string; expectedCurrentVersion: string; requestId: string };

const unmanaged = (): UpdateStatus => ({
  installation: "unmanaged",
  enabled: false,
  current: { version: CUBED_VERSION, commit: CUBED_COMMIT, stateSchema: CUBED_STATE_SCHEMA },
  available: null,
  phase: "idle",
  targetVersion: null,
  error: null,
  message: "this cubed process is managed externally; update it with the method that installed it",
  runnersUpdated: false,
});

/** Thin client for the local lifecycle supervisor. The browser never receives
 * the socket path or bearer token; an unmanaged source checkout is read-only. */
export class UpdateService {
  private readonly socket = process.env.CUBED_SUPERVISOR_SOCKET;
  private readonly token = process.env.CUBED_UPDATE_TOKEN;

  async status(): Promise<UpdateStatus> {
    if (!this.socket || !this.token) return unmanaged();
    return this.call({ action: "status" });
  }

  async check(): Promise<UpdateStatus> {
    this.requireManaged();
    return this.call({ action: "check" });
  }

  async install(input: { targetVersion: unknown; expectedCurrentVersion: unknown; requestId: unknown }): Promise<UpdateStatus> {
    this.requireManaged();
    for (const [name, value] of Object.entries(input)) {
      if (typeof value !== "string" || !value || value.length > 200) throw new Error(`${name} is required`);
    }
    return this.call({ action: "install", targetVersion: input.targetVersion as string,
      expectedCurrentVersion: input.expectedCurrentVersion as string, requestId: input.requestId as string });
  }

  private requireManaged(): void {
    if (!this.socket || !this.token) throw new Error("this cubed installation is managed externally and cannot update from the browser");
  }

  private call(input: SupervisorInput): Promise<UpdateStatus> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(this.socket!);
      let raw = "";
      let settled = false;
      const timeout = setTimeout(() => client.destroy(new Error("update supervisor did not respond")), 15_000);
      const fail = (error: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); reject(error);
      };
      client.setEncoding("utf8");
      client.on("connect", () => client.end(`${JSON.stringify({ ...input, id: randomUUID(), token: this.token })}\n`));
      client.on("data", chunk => {
        raw += chunk;
        if (raw.length > 1024 * 1024) client.destroy(new Error("update supervisor response was too large"));
      });
      client.on("error", fail);
      client.on("end", () => {
        if (settled) return;
        clearTimeout(timeout);
        try {
          const result = JSON.parse(raw) as { ok?: boolean; status?: UpdateStatus; error?: string };
          if (!result.ok || !result.status) throw new Error(result.error || "update supervisor rejected the request");
          settled = true;
          resolve(result.status);
        } catch (error) { fail(error as Error); }
      });
    });
  }
}
