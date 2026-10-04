import type { Project as ProjectRecord } from "../../../server/src/registry.ts";
export type { ModelSelection } from "../../../server/src/models.ts";
export type { ProjectRepository } from "../../../server/src/registry.ts";
export type { RunnerStatus } from "../../../server/src/registry.ts";
export type { GithubAuthStatus } from "../../../server/src/github-auth.ts";
export type { UpdateStatus } from "../../../server/src/update-service.ts";

export type AuthState =
  | { state: "ok"; provider: string; credentialType: string; expiresAt?: number }
  | { state: "missing"; provider: string };
export interface DaemonState { auth: AuthState; onboardingComplete: boolean }
export type ThreadState = "ready" | "error";
export interface ThreadSummary {
  id: string;
  title: string | null;
  state: ThreadState;
  error: string | null;
  createdAt: number | null;
  archived: boolean;
  /** Fixed at creation; absent means pi. */
  agent?: import("../../../server/src/thread-events.ts").ThreadAgent;
  workspaceBase?: { remote: string; ref: string; oid: string } | null;
  project: { id: string; name: string };
}
export type Project = ProjectRecord & { threadCount: number; retainedThreadCount: number; runnerCount: number; availableRunnerCount: number;
  runnerCapacity: { states: Record<"available" | "allocating" | "busy" | "releasing" | "failed" | "retiring" | "retired", number>; errors: string[] };
  runners: import("../../../server/src/registry.ts").RunnerStatus[] };
export type ProjectStatus = Project["status"];
export interface ProjectInput {
  name: string;
  repositories: Array<{ url: string; base?: string | null; checkoutName?: string }>;
}
export type { ThreadEvent, ThreadStatus, ThreadTranscript } from "../../../server/src/thread-events.ts";
export interface ThreadModels {
  models: import("../../../server/src/models.ts").ModelSelection[];
  selected: import("../../../server/src/models.ts").ModelSelection | null;
}
