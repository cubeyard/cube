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

/** Banner text for a failure: the message itself, never "Error: …". */
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** One JSON exchange with cubed. A rejection carries the server's own
 * message for every method — a 409 "still setting up" must read as that,
 * not as a status code. */
async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (res.ok) return res.json();
  let message = `${method} ${path} -> ${res.status}`;
  try {
    message = String((await res.json()).error ?? message);
  } catch {
    // non-JSON error body — keep the status line
  }
  throw new Error(message);
}

export const fetchState = () => request<DaemonState>("/api/state");

export const completeOnboarding = () =>
  request<{ onboardingComplete: boolean }>("/api/onboarding", "POST");

export const fetchGithubAuth = () =>
  request<{ github: GithubAuthStatus }>("/api/github/auth").then((r) => r.github);

export const connectGithub = () =>
  request<{ github: GithubAuthStatus }>("/api/github/auth", "POST").then((r) => r.github);

export const disconnectGithub = () =>
  request<{ github: GithubAuthStatus }>("/api/github/auth", "DELETE").then((r) => r.github);

// The UI speaks the thread-first API only — the user-facing unit is the
// thread; the backing cube is invisible (cube routes are debug plumbing).
// The conversation itself is NOT here: it lives on the terminal WebSocket
// (the real pi TUI), see terminalUrl().

export const fetchThreads = (includeArchived = false) =>
  request<{ threads: ThreadSummary[] }>(`/api/threads${includeArchived ? "?includeArchived=1" : ""}`).then(
    (r) => r.threads,
  );

export const fetchProjects = () =>
  request<{ projects: Project[] }>("/api/projects").then((r) => r.projects);

export const fetchProject = (id: string) =>
  request<{ project: Project }>(`/api/projects/${encodeURIComponent(id)}`).then((r) => r.project);

export const createProject = (input: ProjectInput) =>
  request<{ project: Project }>("/api/projects", "POST", input).then((r) => r.project);

export const updateProject = (id: string, input: ProjectInput) =>
  request<{ project: Project }>(`/api/projects/${encodeURIComponent(id)}`, "PUT", input).then((r) => r.project);

export const checkProject = (id: string) =>
  request<{ project: Project }>(`/api/projects/${encodeURIComponent(id)}/check`, "POST").then((r) => r.project);

export const deleteProject = (id: string) =>
  request<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}`, "DELETE");

/** New thread, always from a ready project's prepared repository snapshot. */
export const createUserThread = (projectId: string) =>
  request<{ id: string }>("/api/threads", "POST", { projectId }).then((r) => r.id);

const threadBase = (id: string) => `/api/threads/${encodeURIComponent(id)}`;

export const deleteThread = (id: string) => request<{ ok: true }>(threadBase(id), "DELETE");

export const renameThread = (id: string, title: string) =>
  request<{ ok: true }>(threadBase(id), "PATCH", { title });

/** The thread's terminal WebSocket — raw pi TUI bytes down (binary),
 * JSON control frames as text; JSON input/resize frames up. */
export function terminalUrl(threadId: string, cols: number, rows: number): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${threadBase(threadId)}/pty?cols=${cols}&rows=${rows}`;
}

/** Workspace listing — host-side, so it works while the thread sleeps. */
export const fetchFiles = (threadId: string) =>
  request<WorkspaceListing>(`${threadBase(threadId)}/files`);

/** URL serving one workspace file. */
export const fileUrl = (threadId: string, rel: string) =>
  `${threadBase(threadId)}/files/${rel.split("/").map(encodeURIComponent).join("/")}`;

/** Every project repository with independent live git state. */
export const fetchRepositories = (threadId: string) =>
  request<{ repositories: ThreadRepository[] }>(`${threadBase(threadId)}/repositories`).then(
    (r) => r.repositories,
  );

const repositoryBase = (threadId: string, repositoryId: number) =>
  `${threadBase(threadId)}/repositories/${repositoryId}`;

/** Selected repository changes, separated by committed/staged/unstaged state. */
export const fetchDiff = (threadId: string, repositoryId: number) =>
  request<RepoDiff>(`${repositoryBase(threadId, repositoryId)}/diff`);

/** URL serving one file from a repository checkout. */
export const repositoryFileUrl = (threadId: string, repositoryId: number, rel: string) =>
  `${repositoryBase(threadId, repositoryId)}/files/${rel.split("/").map(encodeURIComponent).join("/")}`;

/** Declared services and their stable portal URLs. */
export const fetchServices = (threadId: string) =>
  request<{ services: ServiceLink[] }>(`${threadBase(threadId)}/services`).then((r) => r.services);
