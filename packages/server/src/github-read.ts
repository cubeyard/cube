/** Read-only GitHub access to the host-selected primary repository.
 * Credentials remain in the host's gh process. */
import { execFile } from "node:child_process";
import { parseGitHubRepo } from "@cube/git";

export type GithubReadRunner = (args: string[], signal?: AbortSignal) => Promise<string>;
const runGh: GithubReadRunner = (args, signal) => new Promise((resolve, reject) => {
  execFile("gh", args, { signal, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
    // Never forward CLI diagnostics: they can contain host configuration or credentials.
    if (error) reject(new Error("GitHub read failed: content may be missing or inaccessible, authentication may have expired, or the request exceeded its time/output limit. Check Cube's GitHub connection and repository access."));
    else resolve(stdout);
  });
});

export async function readGithub(
  repositoryUrl: string,
  input: { number: number; type: string; section?: string; page?: number },
  signal?: AbortSignal,
  run: GithubReadRunner = runGh,
) {
  const repo = parseGitHubRepo(repositoryUrl);
  if (!repo || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("thread primary repository is not a GitHub repository");
  if (!Number.isSafeInteger(input.number) || input.number < 1) throw new Error("number must be a positive integer");
  if (input.type !== "issue" && input.type !== "pr") throw new Error("type must be issue or pr");
  const section = input.section ?? "details";
  const page = input.page ?? 1;
  if (!Number.isSafeInteger(page) || page < 1) throw new Error("page must be a positive integer");
  const issue = `repos/${repo}/issues/${input.number}`;
  const pull = `repos/${repo}/pulls/${input.number}`;
  const isPr = input.type === "pr";
  const endpoints: Record<string, string> = {
    details: isPr ? pull : issue,
    comments: `${issue}/comments`,
    timeline: `${issue}/timeline`,
    ...(isPr ? { reviews: `${pull}/reviews`, reviewComments: `${pull}/comments` } : {}),
  };
  if (!Object.hasOwn(endpoints, section)) throw new Error("invalid section for this GitHub URL");
  if (section === "details" && page !== 1) throw new Error("details has only one page");
  signal?.throwIfAborted();
  const paged = section !== "details";
  const endpoint = endpoints[section]! + (paged ? `?per_page=100&page=${page}` : "");
  const text = await run(["api", "--hostname", "github.com", "--method", "GET", endpoint], signal);
  let data: unknown;
  try { data = JSON.parse(text); } catch { throw new Error("GitHub returned invalid or truncated JSON; no complete result is available"); }
  if (paged ? !Array.isArray(data) : !data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("GitHub returned missing or unexpected content");
  }
  // A full page might be the last one. Requiring one more read is safer
  // than declaring completeness without inspecting response headers.
  const nextPage = paged && (data as unknown[]).length === 100 ? page + 1 : null;
  return {
    url: `https://github.com/${repo}/${isPr ? "pull" : "issues"}/${input.number}`,
    section, page, data, nextPage, complete: nextPage === null,
    notice: "Completeness applies only to this section from this page onward. Fetch all relevant sections. Timeline includes visible cross-references; inaccessible linked content is not included. Empty bodies and lists mean GitHub returned no content, not an access check for linked items.",
  };
}
