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

/** A failed exchange with cubed. `status` is the HTTP status, or 0 when
 * the request never reached the host (connection refused, VM booting,
 * network gone) — callers use it to tell "no such thing" from "can't
 * reach the host". The message is always a user sentence. */
export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;
export const isUnreachable = (error: unknown) => error instanceof ApiError && error.status === 0;

/** What to say when the server's error body is not JSON — a proxy page, a
 * crashed handler, a restart mid-request. One human sentence per status
 * class; the technical line goes to the console for whoever debugs it. */
function fallbackMessage(status: number): string {
  if (status === 404) return "that no longer exists";
  if (status === 502 || status === 503 || status === 504) return "the host is busy or restarting — try again in a moment";
  if (status >= 500) return "the host had a problem handling that — try again";
  if (status === 409) return "that can't be done right now — try again in a moment";
  return "the host did not accept that request — reload and try again";
}

/** One JSON exchange with cubed. A rejection carries the server's own
 * message for every method — a 409 "still setting up" must read as that,
 * not as a status code. */
async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch (e) {
    console.debug(`${method} ${path} -> no response`, e);
    throw new ApiError("can't reach the host — it may be starting or restarting", 0);
  }
  if (res.ok) return res.json();
  let message: string | null = null;
  try {
    const parsed = (await res.json()) as { error?: unknown };
    if (typeof parsed?.error === "string" && parsed.error) message = parsed.error;
  } catch {
    // non-JSON error body — fall through to the status-class sentence
  }
  if (message === null) {
    console.debug(`${method} ${path} -> ${res.status} ${res.statusText} (non-JSON error body)`);
    message = fallbackMessage(res.status);
  }
  throw new ApiError(message, res.status);
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
