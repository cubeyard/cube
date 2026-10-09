import type { Project as ProjectRecord } from "../../../server/src/registry.ts";
export type { ModelSelection } from "../../../server/src/models.ts";
export type { ProjectRepository } from "../../../server/src/registry.ts";
export type { RunnerStatus } from "../../../server/src/registry.ts";
export type { GithubAuthStatus } from "../../../server/src/github-auth.ts";
export type { UpdateStatus } from "../../../server/src/update-service.ts";
export type { SettingsView } from "../../../server/src/settings.ts";
export type { SkillSource, SkillsConfig, ThreadSkills } from "../../../server/src/skills.ts";

export type AuthState =
  | { state: "ok"; provider: string; credentialType: string; expiresAt?: number }
  | { state: "missing"; provider: string };
export interface DaemonState { auth: AuthState; onboardingComplete: boolean }
export type ThreadState = "starting" | "ready" | "error";
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
  /** The thread's machine; after archive, whether its disk was kept. */
  vm?: Pick<import("../../../server/src/registry.ts").ThreadVm, "vmId" | "retain" | "retainReason" | "discarded" | "preparation" | "hooks" | "startup" | "steps">;
}
export type Project = ProjectRecord & { threadCount: number; retainedThreadCount: number; runnerCount: number; availableRunnerCount: number;
  /** Free thread machine slots over the pool; a runner hosts `maxActiveVms`. */
  availableSlotCount: number;
  runnerCapacity: { states: Record<"available" | "allocating" | "busy" | "releasing" | "failed" | "retiring" | "retired", number>;
    slots: { free: number; total: number }; errors: string[] };
  runners: import("../../../server/src/registry.ts").RunnerStatus[];
  /** cubed's machine size for a project that sets none, and the most the
   * enrolled runners last said they allow (null: none said yet). */
  machineDefaults: { vcpus: number; memoryMiB: number };
  machineLimits: { maxVcpus: number; maxMemoryMiB: number } | null };
export type ProjectStatus = Project["status"];
export interface ProjectInput {
  name: string;
  repositories: Array<{ url: string; base?: string | null; checkoutName?: string }>;
  /** A hook not given keeps its saved script. */
  hooks?: { preSetup?: string; preResume?: string };
  /** Not given: kept; null or {}: cubed's defaults. */
  machine?: import("../../../server/src/registry.ts").ProjectMachine | null;
}
export type { StartupStep } from "../../../server/src/registry.ts";
export type { StartupLog } from "../../../server/src/vm.ts";
export type { MessageImage, ThreadEvent, ThreadStatus, ThreadTranscript } from "../../../server/src/thread-events.ts";
export type { SubjectUsage, UsageLine } from "../../../server/src/usage.ts";
export type { UsageReport } from "../../../server/src/usage-service.ts";
export type { OverviewThread, ThreadOverview } from "../../../server/src/optchat-overview.ts";
export interface ThreadModels {
  models: import("../../../server/src/models.ts").ModelSelection[];
  selected: import("../../../server/src/models.ts").ModelSelection | null;
  /** The chat only: whether its selected model takes images, and why not. */
  images?: { supported: boolean; reason: string | null };
}
export type { ActionPreview, ArtifactListItem, ArtifactView } from "../../../server/src/artifact-service.ts";
export type { ActionRun, Anchor, ArtifactAction, ArtifactComment, CommentBatch, Revision } from "../../../server/src/artifacts.ts";
