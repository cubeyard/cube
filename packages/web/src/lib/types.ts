/**
 * UI-side shapes, mirroring cubed's thread-first API responses. The
 * conversation itself has no shapes here: it is the pi TUI streaming over
 * the terminal WebSocket — cubed (and this UI) never model chat.
 */

export type AuthState =
  | { state: "ok"; provider: string; credentialType: string; expiresAt?: number }
  | { state: "missing"; provider: string };

/** GET /api/github/auth — GitHub CLI's login on the VM. */
export type GithubAuthStatus =
  | { state: "disconnected"; error?: string }
  | { state: "pending"; userCode: string; verificationUri: string; expiresAt: number }
  | { state: "connected"; login: string };

/** GET /api/state — daemon-level info. */
export interface DaemonState {
  auth: AuthState;
  onboardingComplete: boolean;
}

/** Thread states as the user sees them. `waking` sits between sleeping
 * and ready: the environment is being started for a returning user — a
 * calm waiting state like `setting-up`, never an error. */
export type ThreadState = "setting-up" | "waking" | "ready" | "sleeping" | "error";

/** One entry of GET /api/threads — the user-facing unit. The backing cube
 * never appears; states are thread states. */
export interface ThreadSummary {
  id: string;
  title: string | null;
  state: ThreadState;
  error: string | null;
  createdAt: number | null;
  archived: boolean;
  project: { id: string; name: string };
}

export type ProjectStatus = "checking" | "ready" | "error";

export interface ProjectRepository {
  id: string;
  projectId: string;
  position: number;
  url: string;
  base: string | null;
  checkoutName: string;
  status: ProjectStatus;
  error: string | null;
  resolvedBase: string | null;
  baseOid: string | null;
  checkedAt: number | null;
}

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  error: string | null;
  /** "<checkout>/<folder>" in a reference that carries .cube; null = the primary's own. */
  environment: string | null;
  revision: number;
  checkedAt: number | null;
  createdAt: number;
  updatedAt: number;
  repositories: ProjectRepository[];
  threadCount: number;
}

export interface ProjectInput {
  name: string;
  repositories: Array<{ url: string; base?: string | null; checkoutName?: string }>;
  environment?: string | null;
}

/** One checkout from GET /api/threads/:id/repositories. */
export interface ThreadRepository {
  id: number;
  role: "primary" | "additional";
  checkoutName: string;
  path: string;
  url: string;
  base: string;
  branch: string;
  state: { branch: string | null; dirty: boolean; ahead: number } | null;
}

export interface RepoDiffSection {
  files: Array<{ path: string; additions: number | null; deletions: number | null }>;
  patch: string;
  truncated: boolean;
}

/** The primary repository's live changes, preserving Git's three layers. */
export interface RepoDiff {
  committed: RepoDiffSection;
  staged: RepoDiffSection;
  unstaged: RepoDiffSection;
  untracked: string[];
  tracked: string[];
  dirty: boolean;
  trackedDirty: boolean;
}

/** GET /api/threads/:id/services — declared services + portal URLs. */
export interface ServiceLink {
  name: string;
  url: string;
}

/** One file of GET /api/threads/:id/files — the thread's workspace,
 * newest first. Tooling dirs (.git, node_modules) count toward
 * `totalBytes` but are not listed. */
export interface WorkspaceFile {
  path: string;
  size: number;
  mtime: number;
}

export interface WorkspaceListing {
  files: WorkspaceFile[];
  totalBytes: number;
  /** A cap was hit — the listing (or the byte total) is partial. */
  truncated: boolean;
}

/** Text control frames on the terminal WebSocket (binary frames are raw
 * pty output). */
export type TerminalControlFrame =
  | { t: "status"; text: string }
  | { t: "spawned" }
  /** Joined a live process; `replay` says a scrollback tail follows. */
  | { t: "attached"; replay: boolean }
  | { t: "exit"; code: number | null }
  | { t: "error"; text: string };
