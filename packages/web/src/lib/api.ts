import type {
  DaemonState,
  GithubAuthStatus,
  Project,
  ProjectInput,
  RepoDiff,
  ServiceLink,
  ThreadRepository,
  ThreadSummary,
  WorkspaceListing,
} from "./types.ts";

/** Error carrying the HTTP status, so callers can branch on 409/404. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new ApiError(`GET ${path} -> ${res.status}`, res.status);
  return res.json();
}

/** POST/PATCH/DELETE with the server's rejection message surfaced. */
async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (res.ok) return res.json();
  let message = `HTTP ${res.status}`;
  try {
    message = String((await res.json()).error ?? message);
  } catch {
    // non-JSON error body — keep the status line
  }
  throw new ApiError(message, res.status);
}

export const fetchState = () => getJson<DaemonState>("/api/state");

export const completeOnboarding = () =>
  send<{ onboardingComplete: boolean }>("/api/onboarding", "POST");

export const fetchGithubAuth = () =>
  getJson<{ github: GithubAuthStatus }>("/api/github/auth").then((r) => r.github);

export const connectGithub = () =>
  send<{ github: GithubAuthStatus }>("/api/github/auth", "POST").then((r) => r.github);

export const disconnectGithub = () =>
  send<{ github: GithubAuthStatus }>("/api/github/auth", "DELETE").then((r) => r.github);

// The UI speaks the thread-first API only — the user-facing unit is the
// thread; the backing cube is invisible (cube routes are debug plumbing).
// The conversation itself is NOT here: it lives on the terminal WebSocket
// (the real pi TUI), see terminalUrl().

export const fetchThreads = (includeArchived = false) =>
  getJson<{ threads: ThreadSummary[] }>(`/api/threads${includeArchived ? "?includeArchived=1" : ""}`).then(
    (r) => r.threads,
  );

export const fetchProjects = () =>
  getJson<{ projects: Project[] }>("/api/projects").then((r) => r.projects);

export const fetchProject = (id: string) =>
  getJson<{ project: Project }>(`/api/projects/${encodeURIComponent(id)}`).then((r) => r.project);

export const createProject = (input: ProjectInput) =>
  send<{ project: Project }>("/api/projects", "POST", input).then((r) => r.project);

export const updateProject = (id: string, input: ProjectInput) =>
  send<{ project: Project }>(`/api/projects/${encodeURIComponent(id)}`, "PUT", input).then((r) => r.project);

export const checkProject = (id: string) =>
  send<{ project: Project }>(`/api/projects/${encodeURIComponent(id)}/check`, "POST").then((r) => r.project);

export const deleteProject = (id: string) =>
  send<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}`, "DELETE");

/** New thread, always from a ready project's prepared repository snapshot. */
export const createUserThread = (projectId: string) =>
  send<{ id: string }>("/api/threads", "POST", { projectId }).then((r) => r.id);

const threadBase = (id: string) => `/api/threads/${encodeURIComponent(id)}`;

export const deleteThread = (id: string) => send<{ ok: true }>(threadBase(id), "DELETE");

export const renameThread = (id: string, title: string) =>
  send<{ ok: true }>(threadBase(id), "PATCH", { title });

/** The thread's terminal WebSocket — raw pi TUI bytes down (binary),
 * JSON control frames as text; JSON input/resize frames up. */
export function terminalUrl(threadId: string, cols: number, rows: number): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${threadBase(threadId)}/pty?cols=${cols}&rows=${rows}`;
}

/** Workspace listing — host-side, so it works while the thread sleeps. */
export const fetchFiles = (threadId: string) =>
  getJson<WorkspaceListing>(`${threadBase(threadId)}/files`);

/** URL serving one workspace file. */
export const fileUrl = (threadId: string, rel: string) =>
  `${threadBase(threadId)}/files/${rel.split("/").map(encodeURIComponent).join("/")}`;

/** Every project repository with independent live git state. */
export const fetchRepositories = (threadId: string) =>
  getJson<{ repositories: ThreadRepository[] }>(`${threadBase(threadId)}/repositories`).then(
    (r) => r.repositories,
  );

const repositoryBase = (threadId: string, repositoryId: number) =>
  `${threadBase(threadId)}/repositories/${repositoryId}`;

/** Selected repository changes, separated by committed/staged/unstaged state. */
export const fetchDiff = (threadId: string, repositoryId: number) =>
  getJson<RepoDiff>(`${repositoryBase(threadId, repositoryId)}/diff`);

/** URL serving one file from a repository checkout. */
export const repositoryFileUrl = (threadId: string, repositoryId: number, rel: string) =>
  `${repositoryBase(threadId, repositoryId)}/files/${rel.split("/").map(encodeURIComponent).join("/")}`;

/** Push the thread's branch with host credentials; resolves to the branch. */
export const pushThread = (threadId: string, repositoryId: number) =>
  send<{ branch: string }>(`${repositoryBase(threadId, repositoryId)}/push`, "POST").then((r) => r.branch);

/** Push + open a PR (host-side gh auth); resolves to the PR URL. */
export const createPr = (threadId: string, repositoryId: number) =>
  send<{ url: string; branch: string }>(`${repositoryBase(threadId, repositoryId)}/pr`, "POST");

/** Declared services and their stable portal URLs. */
export const fetchServices = (threadId: string) =>
  getJson<{ services: ServiceLink[] }>(`${threadBase(threadId)}/services`).then((r) => r.services);
