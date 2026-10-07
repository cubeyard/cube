/** A pull request's live state and its merge, through GitHub's REST API with
 * the host's token. Only artifact actions the user confirmed use `merge`;
 * the token never leaves this module, and errors carry GitHub's message, not
 * the request. */
export interface PullState {
  repository: string; number: number; url: string; title: string; author: string | null;
  state: "open" | "closed"; merged: boolean; draft: boolean;
  headSha: string; headRef: string; baseRef: string;
  /** GitHub computes this lazily: null means not known yet. */
  mergeable: boolean | null; mergeableState: string;
}
export interface MergeResult { merged: boolean; sha: string | null; message: string }
export interface GithubPulls {
  pull(repository: string, number: number, signal?: AbortSignal): Promise<PullState>;
  /** Merges only if the head is still `sha` (GitHub refuses otherwise). */
  merge(repository: string, number: number, options: { sha: string; method: "merge" | "squash" | "rebase" }): Promise<MergeResult>;
}

export class GithubPullsError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.name = "GithubPullsError"; this.status = status; }
}

const TIMEOUT_MS = 20_000;

export function githubPulls(options: { token: () => Promise<string | null>; api?: string; fetch?: typeof fetch }): GithubPulls {
  const api = (options.api ?? "https://api.github.com").replace(/\/+$/, "");
  const call = options.fetch ?? fetch;
  async function request(method: string, route: string, body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const token = await options.token();
    if (!token) throw new GithubPullsError("github is not connected on this host; connect it in cube first", 401);
    let response: Response;
    try {
      response = await call(`${api}${route}`, {
        method,
        headers: { accept: "application/vnd.github+json", authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "user-agent": "cubed",
          ...body === undefined ? {} : { "content-type": "application/json" } },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new GithubPullsError("could not reach github", 502);
    }
    let data: unknown = null;
    try { data = await response.json(); } catch { /* an empty or broken body */ }
    const record = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : {};
    if (!response.ok) {
      const said = typeof record.message === "string" ? record.message.slice(0, 300) : `status ${response.status}`;
      throw new GithubPullsError(`github: ${said}`, response.status);
    }
    return record;
  }
  const path = (repository: string, number: number) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\/[A-Za-z0-9_.-]+$/.test(repository) || repository.includes("..")) throw new GithubPullsError("not a GitHub repository", 400);
    if (!Number.isSafeInteger(number) || number < 1) throw new GithubPullsError("not a pull request number", 400);
    return `/repos/${repository}/pulls/${number}`;
  };
  return {
    async pull(repository, number, signal) {
      const data = await request("GET", path(repository, number), undefined, signal);
      const head = (data.head ?? {}) as Record<string, unknown>, base = (data.base ?? {}) as Record<string, unknown>;
      const user = (data.user ?? {}) as Record<string, unknown>;
      return {
        repository, number, url: typeof data.html_url === "string" ? data.html_url : `https://github.com/${repository}/pull/${number}`,
        title: String(data.title ?? ""), author: typeof user.login === "string" ? user.login : null,
        state: data.state === "open" ? "open" : "closed", merged: data.merged === true, draft: data.draft === true,
        headSha: String(head.sha ?? ""), headRef: String(head.ref ?? ""), baseRef: String(base.ref ?? ""),
        mergeable: typeof data.mergeable === "boolean" ? data.mergeable : null, mergeableState: String(data.mergeable_state ?? "unknown"),
      };
    },
    async merge(repository, number, { sha, method }) {
      const data = await request("PUT", `${path(repository, number)}/merge`, { sha, merge_method: method });
      return { merged: data.merged === true, sha: typeof data.sha === "string" ? data.sha : null, message: String(data.message ?? "") };
    },
  };
}
