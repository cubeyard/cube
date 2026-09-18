import type {
  ConversationHistory,
  DaemonState,
  GithubAuthStatus,
  ModelSelection,
  Project,
  ProjectInput,
  RunnerStatus,
  ThreadModels,
  ThreadSummary,
  UpdateStatus,
} from "./types.ts";
import { uid } from "./uid.ts";
import type { ModelAuth } from "../../../server/src/model-auth.ts";
import type { JevOutputComparison } from "../../../server/src/jev-memory.ts";

export const fetchProviders = () => request<{ providers: Awaited<ReturnType<ModelAuth["list"]>> }>("/api/providers").then(result => result.providers);
export const providerAction = (id: string, operation: "login" | "answer" | "cancel" | "disconnect" | "refresh", body?: unknown) => {
  const suffix = operation === "disconnect" ? "" : `/${operation === "cancel" ? "login" : operation}`;
  return request<{ ok?: true }>(`/api/providers/${encodeURIComponent(id)}${suffix}`, operation === "disconnect" || operation === "cancel" ? "DELETE" : "POST", body);
};
export const fetchJevStatus = () => request<{ configured: boolean }>("/api/jev");
export const saveJevKey = (apiKey: string) => request<{ configured: boolean }>("/api/jev", "PUT", { apiKey });
export const removeJevKey = () => request<{ configured: boolean }>("/api/jev", "DELETE");
export const fetchUpdateStatus = () => request<UpdateStatus>("/api/system/update");
export const checkForUpdate = () => request<UpdateStatus>("/api/system/update", "POST", { action: "check" });
export const installUpdate = (targetVersion: string, expectedCurrentVersion: string, requestId: string) =>
  request<UpdateStatus>("/api/system/update", "POST", { action: "install", targetVersion, expectedCurrentVersion, requestId });

/** Banner text for a failure: the message itself, never "Error: …". */
export const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A failed exchange with cubed. `status` is the HTTP status, or 0 when
 * the request never reached the host (connection refused, host starting,
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
  if (body === undefined && ["POST", "PUT", "PATCH"].includes(method)) body = {};
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

// The UI speaks the thread-first product API.

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

export const fetchRunners = () =>
  request<{ runners: RunnerStatus[] }>("/api/runners").then((r) => r.runners);

export const checkRunner = (id: string) =>
  request<{ runner: RunnerStatus }>(`/api/runners/${encodeURIComponent(id)}/check`, "POST").then((r) => r.runner);

export const retireRunner = (id: string, confirm: string, reason: string) =>
  request<{ runner: RunnerStatus }>(`/api/runners/${encodeURIComponent(id)}/retire`, "POST", { confirm, reason }).then((r) => r.runner);

/** New thread, allocated from a ready project's enrolled trusted runners.
 * `requestId` names the user action: a resend after a dropped connection
 * or a double submit with the same id gets the thread the first attempt
 * created, not a second one. Generate it once per action, not per call. */
export const createUserThread = (projectId: string, requestId: string = uid(), firstTurn?: { text: string; model: ModelSelection }) =>
  request<{ id: string }>("/api/threads", "POST", { projectId, requestId, ...firstTurn }).then((r) => r.id);

export const fetchModels = () => request<ThreadModels>("/api/models");

const threadBase = (id: string) => `/api/threads/${encodeURIComponent(id)}`;

export const deleteThread = (id: string) => request<{ ok: true }>(threadBase(id), "DELETE");

export const renameThread = (id: string, title: string) =>
  request<{ ok: true }>(threadBase(id), "PATCH", { title });

export const fetchConversation = (id: string) =>
  request<ConversationHistory>(`${threadBase(id)}/history`);

export const fetchJevToolOutput = (id: string, toolCallId: string) =>
  request<JevOutputComparison>(`${threadBase(id)}/tool-output/${encodeURIComponent(toolCallId)}`);

export const fetchThreadModels = (id: string) =>
  request<ThreadModels>(`${threadBase(id)}/model`);

export const setThreadModel = (id: string, model: ModelSelection) =>
  request<ThreadModels>(`${threadBase(id)}/model`, "PATCH", model);

export const sendPrompt = (id: string, text: string, model: ModelSelection, requestId: string) =>
  request<{ runId: string }>(`${threadBase(id)}/prompt`, "POST", { text, model, requestId });

export const stopThread = (id: string) => request<{ ok: true }>(`${threadBase(id)}/stop`, "POST");
