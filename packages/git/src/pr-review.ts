/** GitHub PR review transactions (standalone and native stacks).
 * Remote discovery and publication run only in host-owned repositories. The guest receives objects, never
 * credentials, and cannot supply its own expected remote SHAs or stack. */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultRunner, GitService, parseGitHubRepo, type ProcessRunner } from "./index.ts";

interface Layer {
  number: number;
  head: string;
  oid: string;
  base: string;
  baseOid: string;
}

interface Stack {
  id: number | null;
  number: number | null;
  base: string;
  baseOid: string;
  /** Historical native-stack members, not live branch refs. Optional to
   * keep already-persisted all-open snapshots compatible. */
  mergedPrefix?: Array<{ number: number; head: string; oid: string; mergeOid: string }>;
  /** Only the contiguous open suffix participates in Git operations. */
  layers: Layer[];
}

interface Review {
  ws: string;
  url: string;
  number: number;
  branch: string;
  stack: Stack;
  /** Omitted in legacy sessions: additive review remains the default. */
  intent?: "rebase";
  status: "prepared" | "planned" | "publishing" | "verified" | "uncertain";
  plan?: { id: string; candidate: string; heads: string[] };
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const fail = (message: string): never => { throw new Error(`PR review stopped: ${message}`); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail("incomplete GitHub response");
  return value as Record<string, unknown>;
}
function positive(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) return fail("invalid PR or stack number");
  return Number(value);
}
function oid(value: unknown): string {
  if (typeof value !== "string" || !OID.test(value)) return fail("missing full commit SHA");
  return value;
}
function ref(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(value)
    || value.includes("..") || value.includes("//") || value.endsWith("/")
    || value.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock") || part.endsWith("."))) {
    return fail("unsupported or invalid branch name");
  }
  return value;
}

export class PrReviewService {
  private readonly busy = new Set<string>();
  private readonly gitService: GitService;
  private readonly root: string;
  private readonly run: ProcessRunner;

  constructor(root: string, run: ProcessRunner = defaultRunner) {
    this.root = root;
    this.run = run;
    this.gitService = new GitService(root, run);
  }

  private git(cwd: string, args: string[], signal?: AbortSignal, trim = true): Promise<string> {
    return this.run("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=",
      "-c", "fetch.recurseSubmodules=false", "-c", "submodule.recurse=false",
      "--no-replace-objects", "-C", cwd, ...args],
    { timeoutMs: 600_000, maxBuffer: 4 * 1024 * 1024, signal }).then((result) => trim ? result.stdout.trim() : result.stdout);
  }

  private async api(args: string[], signal?: AbortSignal): Promise<unknown> {
    fs.mkdirSync(this.root, { recursive: true });
    try {
      const result = await this.run("gh", ["api", "--hostname", "github.com", ...args],
        { cwd: this.root, timeoutMs: 60_000, maxBuffer: 4 * 1024 * 1024, signal });
      return JSON.parse(result.stdout);
    } catch {
      return fail("GitHub state is unavailable or truncated; no complete snapshot is available");
    }
  }

  /** No local refs or branch-name conventions participate in discovery. */
  private async readStack(url: string, number: number, signal?: AbortSignal): Promise<Stack> {
    const slug = parseGitHubRepo(url);
    if (!slug || !/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(slug)) return fail("a GitHub repository is required");
    positive(number);
    const getPr = async (n: number) => {
      const pr = object(await this.api(["--method", "GET", `repos/${slug}/pulls/${n}`], signal));
      if (pr.number !== n) return fail("GitHub returned a different PR");
      return pr;
    };
    const target = await getPr(number);
    // Ordinary REST pull-request responses can omit the optional stack field.
    // Only a supplied non-null membership opts into native-stack discovery.
    // Do not catch discovery errors and retry as standalone: malformed stack
    // objects, failed reads, and incomplete member responses must still stop.
    const hasStack = Object.hasOwn(target, "stack") && target.stack !== null;
    let members = [target];
    let stackId: number | null = null;
    let stackNumber: number | null = null;
    let base = ref(object(target.base).ref);
    if (hasStack) {
      const membership = object(target.stack);
      stackId = positive(membership.id);
      stackNumber = positive(membership.number);
      const remote = object(await this.api(["--method", "GET", `repos/${slug}/stacks/${stackNumber}`], signal));
      if (remote.id !== stackId || remote.number !== stackNumber || remote.open !== true
        || !Array.isArray(remote.pull_requests) || remote.pull_requests.length !== positive(membership.size)
        || remote.pull_requests.length > 100) return fail("incomplete or changed native stack");
      base = ref(object(remote.base).ref);
      members = [];
      // Bound concurrency and drain the whole batch even on failure. These
      // independent reads must retain native order, not completion order.
      for (let start = 0; start < remote.pull_requests.length; start += 4) {
        const entries = remote.pull_requests.slice(start, start + 4);
        const results = await Promise.allSettled(entries.map(async (entry) => getPr(positive(object(entry).number))));
        for (const [i, result] of results.entries()) {
          if (result.status === "rejected") throw result.reason;
          const member = object(entries[i]);
          const pr = result.value;
          const stack = object(pr.stack);
          if (stack.id !== stackId || stack.number !== stackNumber || stack.size !== remote.pull_requests.length
            || stack.position !== members.length + 1 || object(stack.base).ref !== base
            || object(pr.head).sha !== object(member.head).sha || object(pr.head).ref !== object(member.head).ref) {
            return fail("stack changed during discovery or membership is incomplete");
          }
          members.push(pr);
        }
      }
    }
    const mergedPrefix: NonNullable<Stack["mergedPrefix"]> = [];
    const layers: Layer[] = [];
    for (const pr of members) {
      const head = object(pr.head);
      const parent = object(pr.base);
      if (String(object(head.repo).full_name).toLowerCase() !== slug.toLowerCase()
        || String(object(parent.repo).full_name).toLowerCase() !== slug.toLowerCase()) {
        return fail("forked or inaccessible stack layers require manual reconciliation");
      }
      const entry = { number: positive(pr.number), head: ref(head.ref), oid: oid(head.sha) };
      if (pr.state === "closed" && pr.merged === true) {
        if (layers.length) return fail("merged layers must form a contiguous prefix of the stack");
        mergedPrefix.push({ ...entry, mergeOid: oid(pr.merge_commit_sha) });
      } else {
        if (pr.state !== "open" || pr.merged !== false) return fail("closed but unmerged stack layers require manual reconciliation");
        layers.push({ ...entry, base: ref(parent.ref), baseOid: oid(parent.sha) });
      }
    }
    const allLayers = [...mergedPrefix, ...layers];
    if (new Set(allLayers.map((layer) => layer.number)).size !== allLayers.length
      || new Set([base, ...allLayers.map((layer) => layer.head)]).size !== allLayers.length + 1) return fail("ambiguous stack membership");
    if (!layers.some((layer) => layer.number === number)) return fail("the requested PR must still be open");
    if (mergedPrefix.length && layers[0]!.base !== base) {
      return fail("GitHub has not retargeted the first open PR to the stack base after merging its prefix; wait for native stack reconciliation");
    }
    for (const [i, layer] of layers.entries()) {
      if (layer.base !== (i === 0 ? base : layers[i - 1]!.head)
        || (i > 0 && layer.baseOid !== layers[i - 1]!.oid)) return fail("inconsistent PR bases or head SHAs");
    }
    // Queue state is not on the REST stack resource. Require an explicit
    // answer for every layer, and cross-check OIDs from the same query.
    const [owner, repo] = slug.split("/");
    const query = `query { repository(owner:${JSON.stringify(owner)}, name:${JSON.stringify(repo)}) { ${layers.map((layer, i) =>
      `p${i}:pullRequest(number:${layer.number}) { headRefOid baseRefOid state mergeQueueEntry { id } }`).join(" ")} } }`;
    const result = object(await this.api(["graphql", "-f", `query=${query}`], signal));
    if (result.errors) return fail("incomplete GitHub queue state");
    const repository = object(object(result.data).repository);
    for (const [i, layer] of layers.entries()) {
      const pr = object(repository[`p${i}`]);
      if (pr.mergeQueueEntry !== null || pr.state !== "OPEN" || pr.headRefOid !== layer.oid || pr.baseRefOid !== layer.baseOid) {
        return fail("stack is queued, changed, or its queue state is unavailable");
      }
    }
    return { id: stackId, number: stackNumber, base, baseOid: layers[0]!.baseOid, layers,
      ...(mergedPrefix.length ? { mergedPrefix } : {}) };
  }

  private dir(token: string): string {
    if (!/^[0-9a-f]{32}$/.test(token)) return fail("invalid review token");
    return path.join(this.root, "pr-reviews", token);
  }

  private save(dir: string, review: Review): void {
    fs.writeFileSync(path.join(dir, "state.tmp"), JSON.stringify(review), { mode: 0o600 });
    fs.renameSync(path.join(dir, "state.tmp"), path.join(dir, "state.json"));
  }

  private async session<T>(ws: string, url: string, token: string, work: (dir: string, review: Review) => Promise<T>): Promise<T> {
    const dir = this.dir(token);
    if (this.busy.has(token)) return fail("review operation already running");
    this.busy.add(token);
    try {
      const review = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")) as Review;
      if (review.ws !== ws || review.url !== url) return fail("review belongs to another checkout");
      return await work(dir, review);
    } finally {
      this.busy.delete(token);
    }
  }

  private async unchanged(review: Review, signal?: AbortSignal): Promise<void> {
    if (JSON.stringify(await this.readStack(review.url, review.number, signal)) !== JSON.stringify(review.stack)
      || !await this.refsMatch(review.url, review.stack, signal)) {
      return fail("remote PR head, base, or stack changed; prepare again without discarding local work");
    }
  }

  private async refsMatch(url: string, stack: Stack, signal?: AbortSignal): Promise<boolean> {
    const refs = await this.git(this.root, ["ls-remote", "--refs", "--", url,
      `refs/heads/${stack.base}`, ...stack.layers.map((layer) => `refs/heads/${layer.head}`)], signal);
    const remote = new Map(refs.split("\n").map((line) => { const [sha, name] = line.split(/\s+/); return [name, sha]; }));
    return remote.get(`refs/heads/${stack.base}`) === stack.baseOid
      && stack.layers.every((layer) => remote.get(`refs/heads/${layer.head}`) === layer.oid);
  }

  /** Import every exact remote head, but never reset or check out a guest
   * branch. A fresh local review branch leaves all existing work intact. */
  async prepare(ws: string, url: string, number: number, signal?: AbortSignal) {
    return this.prepareSnapshot(ws, url, number, false, signal);
  }

  /** Explicit, standalone history rewrite. This creates only a fresh local
   * branch; rebase/conflict resolution stay in the guest, publication stays
   * behind the same pinned plans and expected-SHA leases as ordinary reviews. */
  async prepareRebase(ws: string, url: string, number: number, signal?: AbortSignal) {
    return this.prepareSnapshot(ws, url, number, true, signal);
  }

  private async prepareSnapshot(ws: string, url: string, number: number, rebase: boolean, signal?: AbortSignal) {
    if ((await this.gitService.state(ws, undefined, signal)).dirty) return fail("working tree must be clean; preserve local work first");
    const stack = await this.readStack(url, number, signal);
    if (rebase && (stack.id !== null || stack.layers.length !== 1 || stack.mergedPrefix?.length)) {
      return fail("rebase currently supports standalone PRs only; native stacks require a coordinated rewrite");
    }
    const token = crypto.randomBytes(16).toString("hex");
    const dir = this.dir(token);
    const repo = path.join(dir, "repo");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      await this.git(dir, ["init", "--", repo], signal);
      const refs = [`refs/heads/${stack.base}:refs/heads/trunk`, ...stack.layers.map((layer, i) => `refs/heads/${layer.head}:refs/heads/layer-${i}`)];
      await this.git(repo, ["fetch", "--no-tags", "--", url, ...refs], signal);
      for (const [name, expected] of [["trunk", stack.baseOid], ...stack.layers.map((layer, i) => [`layer-${i}`, layer.oid])]) {
        if (await this.git(repo, ["rev-parse", `refs/heads/${name}`], signal) !== expected) return fail("fetched branch does not match the latest GitHub head");
        await this.git(repo, ["cat-file", "-e", `${expected}^{tree}`], signal);
      }
      await this.git(repo, ["fsck", "--connectivity-only", "--no-reflogs"], signal);
      // GitHub's landed SHA, not the old branch head, proves inclusion
      // after squash/rebase merges too. Several PRs in a native group
      // merge may legitimately share one merge result. Deleted historical
      // branch refs are neither fetched nor recreated.
      for (const merged of stack.mergedPrefix ?? []) {
        try {
          await this.git(repo, ["merge-base", "--is-ancestor", merged.mergeOid, stack.baseOid], signal);
        } catch {
          return fail(`merged PR #${merged.number} is not verifiably contained in the current stack base`);
        }
      }
      for (let i = 1; i < stack.layers.length; i++) {
        try {
          await this.git(repo, ["merge-base", "--is-ancestor", stack.layers[i - 1]!.oid, stack.layers[i]!.oid], signal);
        } catch {
          return fail("remote stack needs reconciliation: a layer does not contain its current parent");
        }
      }
      const layer = stack.layers.find((entry) => entry.number === number)!;
      const branch = `cube-review/${token}`;
      const review: Review = { ws, url, number, branch, stack, status: "prepared", ...(rebase ? { intent: "rebase" as const } : {}) };
      // Use the full common-ancestor SHA, not a mutable origin/<base> ref.
      const upstream = rebase ? oid(await this.git(repo, ["merge-base", stack.baseOid, layer.oid], signal)) : undefined;
      await this.unchanged(review, signal);
      await this.git(repo, ["branch", branch, layer.oid], signal);
      const bundle = path.join(dir, "snapshot.bundle");
      await this.git(repo, ["bundle", "create", bundle, "--branches"], signal);
      try {
        await this.git(ws, ["fetch", "--no-tags", "--", bundle,
          `refs/heads/${branch}:refs/heads/${branch}`,
          ...stack.layers.map((_, i) => `refs/heads/layer-${i}:refs/cube/reviews/${token}/${i}`),
          `refs/heads/trunk:refs/cube/reviews/${token}/base`], signal);
      } finally { fs.rmSync(bundle, { force: true }); }
      this.save(dir, review);
      if (rebase) {
        return { token, branch, head: layer.oid, base: layer.base, baseOid: stack.baseOid, upstream, stack,
          rebaseCommand: `git -c core.hooksPath=/dev/null rebase --no-update-refs --no-autostash --no-rebase-merges --force-rebase --onto ${stack.baseOid} ${upstream}`,
          rangeDiffCommand: `git range-diff ${upstream}..${layer.oid} ${stack.baseOid}..HEAD`,
          instruction: `Switch to ${branch}, then run rebaseCommand. It rewrites only this fresh local branch, flattening merge commits onto the pinned base. Resolve conflicts and continue, or abort; existing branches and remote refs are untouched. Preserve all intended PR changes (including merge-conflict resolutions), review rangeDiffCommand and the resulting diff, and run tests. Then use planPrUpdate, inspectPrUpdatePlan (all patch/prDiff pages), and publishPrUpdate. Publish only with explicit authorization to rewrite this PR's history; the host supplies the exact original-SHA lease.` };
      }
      return { token, branch, head: layer.oid, base: layer.base, stack,
        instruction: `Switch to ${branch} before editing. It starts at the exact remote head; existing local branches are untouched. Read all review sections and pages, make only the requested fix, commit, then call planPrUpdate.` };
    } catch (error) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  }

  /** Plan locally against the prepared snapshot; publication checks whether
   * that snapshot is still current before attempting any remote update. */
  async plan(ws: string, url: string, token: string, signal?: AbortSignal) {
    return this.session(ws, url, token, async (dir, review) => {
      if (review.status !== "prepared" && review.status !== "planned") return fail("publication already attempted; do not retry blindly");
      const state = await this.gitService.state(ws, undefined, signal);
      if (state.dirty || state.branch !== review.branch) return fail("commit the review fix on the prepared branch with a clean working tree");
      if (review.plan && await this.git(ws, ["rev-parse", "HEAD"], signal) === review.plan.candidate) {
        return this.planSummary(dir, review, token, signal);
      }
      const repo = path.join(dir, "repo");
      const bundle = path.join(dir, "candidate.bundle");
      try {
        await this.git(ws, ["bundle", "create", bundle, `refs/heads/${review.branch}`], signal);
        await this.git(repo, ["fetch", "--no-tags", "--", bundle, `+refs/heads/${review.branch}:refs/heads/candidate`], signal);
      } finally { fs.rmSync(bundle, { force: true }); }
      const candidate = oid(await this.git(repo, ["rev-parse", "refs/heads/candidate"], signal));
      if (review.plan?.candidate === candidate) {
        return this.planSummary(dir, review, token, signal);
      }
      const { layers } = review.stack;
      const index = layers.findIndex((layer) => layer.number === review.number);
      const target = layers[index]!;
      if (review.intent === "rebase") {
        // Never weaken additive-review sessions. A rewrite requires a token
        // created by prepareRebase and a single unstacked original snapshot.
        if (review.stack.id !== null || layers.length !== 1 || review.stack.mergedPrefix?.length) return fail("invalid standalone rebase session");
        try {
          await this.git(repo, ["merge-base", "--is-ancestor", review.stack.baseOid, candidate], signal);
        } catch { return fail("rebased candidate must contain the exact prepared base commit"); }
        if (candidate === target.oid || candidate === review.stack.baseOid) return fail("rebase must produce a changed, nonempty PR branch");
        // An empty commit has its own SHA, so comparing commits is not enough:
        // a rebase driven through its conflicts with `--skip` can arrive at a
        // branch that carries none of the PR's work, and publishing that would
        // replace the PR with its own base. Compare content, not identity.
        if (await this.git(repo, ["rev-parse", `${candidate}^{tree}`], signal)
          === await this.git(repo, ["rev-parse", `${review.stack.baseOid}^{tree}`], signal)) {
          return fail("the rebased branch changes nothing against its base; if the base already contains this work, close the PR instead of replacing it with an empty branch");
        }
        if (await this.git(repo, ["rev-list", "--merges", `${review.stack.baseOid}..${candidate}`], signal)) {
          return fail("rebased PR history must be linear above the prepared base");
        }
      } else {
        try {
          await this.git(repo, ["merge-base", "--is-ancestor", target.oid, candidate], signal);
        } catch {
          return fail("candidate is older than or diverges from the prepared remote head; existing commits must be preserved");
        }
        if (candidate === target.oid || await this.git(repo, ["rev-list", "--merges", `${target.oid}..${candidate}`], signal)) {
          return fail("review must add linear commits to the prepared remote head, not amend, rebase, or merge it");
        }
      }
      // An old plan must not survive a failed attempt to replace it.
      review.status = "prepared";
      delete review.plan;
      this.save(dir, review);
      const heads = layers.map((layer) => layer.oid);
      heads[index] = candidate;
      for (let i = index + 1; i < layers.length; i++) {
        const oldParent = layers[i - 1]!.oid;
        const child = layers[i]!;
        await this.git(repo, ["merge-base", "--is-ancestor", oldParent, child.oid], signal);
        if (await this.git(repo, ["rev-list", "--merges", `${oldParent}..${child.oid}`], signal)) return fail("nonlinear descendant history requires manual reconciliation");
        await this.git(repo, ["checkout", "--no-recurse-submodules", "--detach", child.oid], signal);
        try {
          await this.git(repo, ["-c", "user.name=Cube", "-c", "user.email=noreply@cube.invalid",
            "-c", "commit.gpgSign=false", "-c", "rerere.enabled=false",
            "rebase", "--no-update-refs", "--no-autostash", "--reapply-cherry-picks", "--empty=keep",
            "--onto", heads[i - 1]!, oldParent], signal);
        } catch {
          await this.git(repo, ["rebase", "--abort"]).catch(() => {});
          return fail(`restack conflict or failure at PR #${child.number}; remote was not changed`);
        }
        heads[i] = oid(await this.git(repo, ["rev-parse", "HEAD"], signal));
        await this.git(repo, ["update-ref", `refs/heads/planned-${i}`, heads[i]!], signal);
      }
      review.plan = { id: crypto.randomBytes(16).toString("hex"), candidate, heads };
      const summary = await this.planSummary(dir, review, token, signal);
      review.status = "planned";
      this.save(dir, review);
      return summary;
    });
  }

  /** Derive diffs from pinned commit IDs, never current refs or workspace
   * content. Diff text and summaries are not persisted or cached. */
  private planDiff(dir: string, review: Review, index: number, section: "patch" | "prDiff",
    format: "binary" | "shortstat", signal?: AbortSignal) {
    const plan = review.plan!;
    const parent = index === 0 ? review.stack.baseOid : plan.heads[index - 1]!;
    const range = section === "patch"
      ? [review.stack.layers[index]!.oid, plan.heads[index]!]
      : [`${parent}...${plan.heads[index]}`];
    return this.git(path.join(dir, "repo"),
      ["diff", "--no-ext-diff", "--no-textconv", "--no-color", `--${format}`, ...range], signal, format === "shortstat");
  }

  private async planSummary(dir: string, review: Review, token: string, signal?: AbortSignal) {
    const plan = review.plan!;
    const changes = [];
    const hash = (text: string) => crypto.createHash("sha256").update(text, "utf8").digest("hex");
    const layers = review.stack.layers;
    for (let i = layers.findIndex((layer) => layer.number === review.number); i < layers.length; i++) {
      const layer = layers[i]!;
      const patch = await this.planDiff(dir, review, i, "patch", "binary", signal);
      const prDiff = await this.planDiff(dir, review, i, "prDiff", "binary", signal);
      const diffstat = {
        patch: await this.planDiff(dir, review, i, "patch", "shortstat", signal),
        prDiff: await this.planDiff(dir, review, i, "prDiff", "shortstat", signal),
      };
      changes.push({ number: layer.number, branch: layer.head, base: layer.base, before: layer.oid, after: plan.heads[i]!,
        patchHash: hash(patch), prDiffHash: hash(prDiff),
        patchBytes: Buffer.byteLength(patch), prDiffBytes: Buffer.byteLength(prDiff), diffstat });
    }
    return { token, plan: plan.id, changes, rewritesHistory: review.intent === "rebase",
      instruction: (review.intent === "rebase"
        ? "This plan rewrites published history. Only publish when that rewrite was explicitly authorized. The patch compares old/new heads (including base updates); also compare the final PR diff and local range-diff to preserve the original work. " : "") + "Use inspectPrUpdatePlan with this plan ID to read every page of patch and prDiff for every PR. Summaries and hashes do not replace review. Publish only if the fix is scoped correctly and existing changes are preserved. Publication uses these exact commits and rechecks remote state." };
  }

  /** Compute only the requested diff and return one bounded page. */
  async inspect(ws: string, url: string, token: string, plan: string,
    input: { number: number; section: "patch" | "prDiff"; page?: number }, signal?: AbortSignal) {
    return this.session(ws, url, token, async (dir, review) => {
      if (!/^[0-9a-f]{32}$/.test(plan) || review.plan?.id !== plan) return fail("no matching saved plan");
      positive(input.number);
      if (input.section !== "patch" && input.section !== "prDiff") return fail("invalid diff section");
      const page = positive(input.page ?? 1);
      const index = review.stack.layers.findIndex((entry) => entry.number === input.number);
      if (index < review.stack.layers.findIndex((entry) => entry.number === review.number)) return fail("PR is not updated by this plan");
      const text = await this.planDiff(dir, review, index, input.section, "binary", signal);
      const pages = Math.max(1, Math.ceil(text.length / 16_000));
      if (page > pages) return fail("diff page out of range");
      return { token, plan, number: input.number, section: input.section, page,
        nextPage: page < pages ? page + 1 : null, complete: page === pages,
        text: text.slice((page - 1) * 16_000, page * 16_000),
        hash: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
        totalBytes: Buffer.byteLength(text) };
    });
  }

  /** Explicit leases are from the saved remote snapshot, never tracking
   * refs. Persist intent before push so disconnect/restart cannot retry it. */
  async publish(ws: string, url: string, token: string, plan: string, signal?: AbortSignal) {
    return this.session(ws, url, token, async (dir, review) => {
      if (review.status !== "planned" || review.plan?.id !== plan) return fail("no matching unconsumed publication plan");
      const state = await this.gitService.state(ws, undefined, signal);
      if (state.dirty || state.branch !== review.branch || await this.git(ws, ["rev-parse", "HEAD"], signal) !== review.plan.candidate) {
        return fail("workspace changed after planning; inspect a new plan before publishing");
      }
      await this.unchanged(review, signal);
      const repo = path.join(dir, "repo");
      const updates = review.stack.layers.flatMap((layer, i) => layer.oid === review.plan!.heads[i] ? [] : [{ layer, after: review.plan!.heads[i]! }]);
      const args = ["push", "--atomic", ...updates.map(({ layer }) => `--force-with-lease=refs/heads/${layer.head}:${layer.oid}`),
        "--", url, ...updates.map(({ layer, after }) => `${after}:refs/heads/${layer.head}`)];
      signal?.throwIfAborted();
      review.status = "publishing";
      this.save(dir, review);
      try {
        await this.git(repo, args, signal);
      } catch {
        review.status = "uncertain";
        this.save(dir, review);
        return fail("atomic push failed or its outcome is unknown. Do not retry or roll back; call verifyPrUpdate to reconcile remote state");
      }
      return this.verifySaved(dir, review, signal);
    });
  }

  private async verifySaved(dir: string, review: Review, signal?: AbortSignal) {
    if (!review.plan) return fail("no publication plan to verify");
    if (review.status === "prepared" || review.status === "planned") return fail("publication has not been attempted; the plan is still available");
    try {
      const actual = await this.readStack(review.url, review.number, signal);
      const expected: Stack = { ...review.stack, layers: review.stack.layers.map((layer, i) => ({ ...layer,
        oid: review.plan!.heads[i]!, baseOid: i === 0 ? review.stack.baseOid : review.plan!.heads[i - 1]! })) };
      if (JSON.stringify(actual) !== JSON.stringify(expected)) return fail("published PR heads, bases, or stack relations do not match the plan");
      // Verify against the transport too, rather than treating GitHub API
      // success as proof that every branch landed at its planned commit.
      if (!await this.refsMatch(review.url, expected, signal)) return fail("remote refs differ from the published plan");
      review.status = "verified";
      this.save(dir, review);
      return { verified: true, number: review.number, stack: actual, plan: review.plan.id };
    } catch (error) {
      review.status = "uncertain";
      this.save(dir, review);
      throw new Error(`PR publication needs reconciliation; remote may already be updated. No automatic rollback was attempted. ${String(error)}`);
    }
  }

  async verify(ws: string, url: string, token: string, signal?: AbortSignal) {
    return this.session(ws, url, token, async (dir, review) => this.verifySaved(dir, review, signal));
  }
}
