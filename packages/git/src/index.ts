/**
 * @cube/git — host-side git and PR flow (ARCHITECTURE §11). Credentials never leave
 * the host: a cube's workspace is a plain local clone (seeded from a bare
 * mirror under reposRoot, so repeat cube creation needs no network) whose
 * `origin` points at the real upstream. The agent commits locally over bash;
 * its `git push` dies on the egress boundary by design. Push and PR are
 * explicit host actions here, using the host's credential helpers and `gh`.
 *
 * HOSTILE-WORKSPACE MODEL. A rooted agent owns everything under the
 * workspace, `.git` included: hooks, config, refs. So no host-side git in
 * that repo may honor agent-authored config that runs code or redirects
 * credentials:
 *   - every invocation forces `core.hooksPath=/dev/null` (no pre-push /
 *     post-checkout / … RCE) and `core.fsmonitor=` (no fsmonitor command);
 *   - diff runs `--no-ext-diff --no-textconv` (no external filter RCE);
 *   - the NETWORKED push never loads workspace config at all: the branch is
 *     carried to the host-owned mirror as a static bundle (bundle create
 *     runs no upload-pack, so no `uploadpack.packObjectsHook`), and the push
 *     to the upstream runs from the mirror, whose config the agent never
 *     touches — defeating repo-local `credential.helper` / `url.*.insteadOf`
 *     credential theft and origin repointing;
 *   - `gh` is driven with an explicit `-R owner/repo` parsed from the
 *     recorded upstream, never from the workspace remote.
 *
 * Every URL that reaches git came over the API — normalizeRepoUrl is the
 * gate: no option-injection (leading "-"), no command-running transports
 * (ext::), and GIT_ALLOW_PROTOCOL pins the transport set for everything
 * spawned here (clones can otherwise follow redirects to other protocols).
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Prepended to EVERY git invocation (command-line -c overrides repo config).
// Harmless on host-owned repos; load-bearing on the workspace.
const SAFE_CONFIG = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor="];

// The empty-tree OID (git knows it intrinsically). Set as GIT_ATTR_SOURCE so
// gitattributes are read from an EMPTY tree, not the agent-controlled
// worktree — neutralizing attribute-driven filter/diff/textconv drivers,
// each of which is an arbitrary-command host-RCE vector on status/diff.
// Verified: without this a repo-local `filter.x.clean` runs on `git diff`.
const EMPTY_TREE_OID = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Agent attribution appended by the per-checkout commit hook. The
 * reserved .invalid domain cannot accidentally identify somebody else's
 * account; replace it if Cube later owns a bot identity or mail domain. */
export const CUBE_COAUTHOR = "Cube <noreply@cube.invalid>";

export interface GitIdentity {
  name: string;
  email: string;
}

export interface SeedResult {
  /** Base branch the workspace was cut from (resolved from the mirror's
   * HEAD when the caller did not pick one). */
  base: string;
  /** Pinned tip OID of `base` at seed time — the trusted anchor for diff
   * and ahead-count (the worktree's origin ref is agent-writable). */
  baseOid: string;
  branch: string;
}

export interface PreparedRepository {
  /** Resolved default/requested branch in the host-owned mirror. */
  base: string;
  /** Tip checked while host credentials and network access were available. */
  baseOid: string;
}

export interface RepoState {
  /** Current branch, or null on a detached HEAD. */
  branch: string | null;
  /** Uncommitted changes (staged, unstaged, or untracked) exist. */
  dirty: boolean;
  /** Commits on HEAD since the merge-base with origin/<base>. */
  ahead: number;
}

export interface RepoDiffSection {
  files: Array<{ path: string; additions: number | null; deletions: number | null }>;
  patch: string;
  truncated: boolean;
}

export interface RepoDiff {
  /** Pinned base -> HEAD: commits that Push/PR will publish. */
  committed: RepoDiffSection;
  /** HEAD -> index: changes already staged for the next commit. */
  staged: RepoDiffSection;
  /** Index -> worktree: tracked edits not staged yet. */
  unstaged: RepoDiffSection;
  /** Workspace-relative paths Git does not track yet. */
  untracked: string[];
  /** Staged, unstaged, or unmerged tracked paths in the working copy. */
  tracked: string[];
  /** Staged, unstaged, unmerged, or untracked local work exists. */
  dirty: boolean;
  /** Staged, unstaged, or unmerged tracked changes exist. */
  trackedDirty: boolean;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

/** Injectable process runner (tests intercept `gh`; git stays real). Must
 * reject with the command's stderr in the error message on non-zero exit. */
export type ProcessRunner = (
  file: string,
  args: string[],
  opts: { cwd?: string; timeoutMs: number; maxBuffer?: number; signal?: AbortSignal },
) => Promise<RunResult>;

const NETWORK_TIMEOUT_MS = 600_000; // clone/fetch/push/gh may hit the network
const LOCAL_TIMEOUT_MS = 60_000;
const PATCH_MAX_BYTES = 4_000_000; // review payload cap; files list stays full

export const defaultRunner: ProcessRunner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
        signal: opts.signal,
        env: {
          ...process.env,
          // Fail fast, never hang a background provision on a prompt.
          GIT_TERMINAL_PROMPT: "0",
          GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -oBatchMode=yes",
          // file: local mirrors/seeds; https/ssh: upstreams. Everything
          // else (ext::, http) stays refused even via redirects/submodules.
          GIT_ALLOW_PROTOCOL: "file:https:ssh",
          // Attributes from the empty tree, never the hostile worktree.
          GIT_ATTR_SOURCE: EMPTY_TREE_OID,
          LC_ALL: "C",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr).trim() || String(error.message);
          reject(new Error(`${file} ${args[0] ?? ""} failed: ${detail.slice(0, 2000)}`));
        } else {
          resolve({ stdout: String(stdout), stderr: String(stderr) });
        }
      },
    );
  });

/**
 * Validate + canonicalize a repo reference from the API. Accepted forms:
 * `owner/name` (GitHub shorthand), https://, ssh://, scp-style
 * `git@host:path`, and absolute paths / file:// (self-hosted repos on the
 * same machine — and the test harness). Anything else throws.
 */
export function normalizeRepoUrl(raw: string): string {
  const url = raw.trim();
  if (!url) throw new Error("empty repository");
  if (url.startsWith("-")) throw new Error(`invalid repository: ${url}`);
  if (/\s/.test(url)) throw new Error(`invalid repository: ${url}`);
  // A password in the authority is a token the rooted cube would then read
  // from .git/config. Reject `user:secret@` userinfo outright — the user
  // authenticates via the host's credential helper / ssh keys, never inline.
  if (/^(?:https|ssh):\/\/[^/@]*:[^/@]*@/.test(url)) {
    throw new Error("invalid repository: credentials in the URL are not allowed");
  }
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(url)) {
    return `https://github.com/${url.replace(/\.git$/, "")}.git`;
  }
  if (/^https:\/\/[^/]+\/.+/.test(url)) return url;
  if (/^ssh:\/\/[^/]+\/.+/.test(url)) return url;
  // scp-style `[user@]host:path`. A single `user@` (e.g. `git`) is the SSH
  // login, not a secret; a password component (`user:pass@`) is refused.
  if (/^[A-Za-z0-9_.-]+:[^@]*@/.test(url)) {
    throw new Error("invalid repository: credentials in the URL are not allowed");
  }
  if (/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:(?!\/*-).+/.test(url)) return url;
  if (url.startsWith("file://") || path.isAbsolute(url)) return url;
  throw new Error(`unsupported repository: ${url} (use owner/name, https, ssh, or a local path)`);
}

/**
 * `owner/repo` from a GitHub upstream (https, ssh, or scp form), or null if
 * the URL is not github.com. Used to pin `gh -R` to the recorded upstream
 * rather than the agent-controlled workspace remote.
 */
export function parseGitHubRepo(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, "");
  const m =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)$/.exec(trimmed) ??
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/.exec(trimmed) ??
    /^git@github\.com:([^/]+)\/([^/]+)$/.exec(trimmed);
  if (!m) return null;
  const [owner, repo] = [m[1]!, m[2]!];
  if (owner.startsWith("-") || repo.startsWith("-")) return null; // gh arg-injection
  return `${owner}/${repo}`;
}

/**
 * True when a git/gh failure message reads as an authentication/authorization
 * failure rather than a network, ref, or local error. Patterns are real
 * stderr from git's https and ssh transports. "Repository not found" is
 * deliberately NOT here: it is ambiguous with a genuinely absent repo.
 */
export function isGitAuthFailure(message: string): boolean {
  return [
    /could not read (Username|Password) for/,
    /Authentication failed/,
    /Invalid username or token/,
    /Support for password authentication was removed/,
    /The requested URL returned error: 40[13]/,
    /Permission denied \(publickey/,
    /HTTP 40[13]/,
  ].some((re) => re.test(message));
}

/**
 * Product-grade repo-check failure copy (design 2026-08-28-github-auth):
 * an auth failure against a github.com upstream becomes the canonical
 * "connect github" message the UI turns into a CTA; anything else returns
 * null and the caller keeps the raw git error (honesty over prettiness).
 */
export function describeRepoAuthFailure(
  message: string,
  url: string,
  githubConnected: boolean,
): string | null {
  if (!isGitAuthFailure(message) || !parseGitHubRepo(url)) return null;
  // The device flow installs an HTTPS credential helper (gh auth
  // setup-git) — it cannot fix ssh-transport failures, so an ssh upstream
  // gets the honest raw error instead of a CTA that can't help (sol Medium).
  if (!/^https:\/\//i.test(url)) return null;
  return githubConnected
    ? "github: access denied — the connected github account may lack access to this repository"
    : "github: not connected — connect github to check this repository";
}

/** Branch names come from cubed itself, but keep the refspec safe anyway. */
function assertRefName(name: string): void {
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith("-")) {
    throw new Error(`invalid ref name: ${name}`);
  }
}

export class GitService {
  private readonly reposRoot: string;
  private readonly run: ProcessRunner;
  // Serialize all work on one mirror path: two concurrent thread creations
  // for the same URL must not both clone into (or fetch/push against) it.
  private readonly mirrorLocks = new Map<string, Promise<unknown>>();

  constructor(reposRoot: string, runner: ProcessRunner = defaultRunner) {
    this.reposRoot = reposRoot;
    this.run = runner;
  }

  /** reposRoot/<name>-<urlhash>.git — readable, collision-free per URL (the
   * 64-bit hash is the identity; the name is only for human legibility). */
  mirrorPathFor(url: string): string {
    const name =
      url
        .replace(/\/+$/, "")
        .split(/[/:]/)
        .pop()!
        .replace(/\.git$/, "")
        .replace(/[^A-Za-z0-9._-]/g, "")
        .slice(0, 40) || "repo";
    const hash = crypto.createHash("sha256").update(url).digest("hex").slice(0, 16);
    return path.join(this.reposRoot, `${name}-${hash}.git`);
  }

  /** Run `work` while holding the per-mirror lock (serialized, FIFO). */
  private withMirrorLock<T>(mirror: string, work: () => Promise<T>): Promise<T> {
    const prior = this.mirrorLocks.get(mirror) ?? Promise.resolve();
    const next = prior.catch(() => {}).then(work);
    this.mirrorLocks.set(mirror, next);
    // Drop the entry once it is the tail, so the map does not grow forever.
    void next.catch(() => {}).finally(() => {
      if (this.mirrorLocks.get(mirror) === next) this.mirrorLocks.delete(mirror);
    });
    return next;
  }

  /** Bare mirror for a repo: clone it on first sight, fetch it current on
   * every later call. Serialized per path; the clone is atomic (temp dir +
   * rename) so a crash mid-clone never leaves a half-populated cache that a
   * later `remote update` would run against. */
  async ensureMirror(url: string, signal?: AbortSignal): Promise<string> {
    const mirror = this.mirrorPathFor(url);
    return this.withMirrorLock(mirror, async () => {
      signal?.throwIfAborted();
      if (fs.existsSync(mirror)) {
        await this.git(["--git-dir", mirror, "remote", "update", "--prune"], NETWORK_TIMEOUT_MS, undefined, signal);
        return mirror;
      }
      await this.cloneMirrorAtomic(url, mirror, signal);
      return mirror;
    });
  }

  /** `<oid>:<relPath>` from the host mirror of `url`: the blob's text, or
   * null when the path is absent (or a tree). Read-only against objects
   * the mirror already holds. Project checks and fresh thread preparation
   * validate declared environment folders against their exact pinned commit. */
  async readFileAtCommit(url: string, oid: string, relPath: string): Promise<string | null> {
    if (!/^[0-9a-f]{7,64}$/.test(oid)) throw new Error(`invalid commit: ${oid}`);
    try {
      return (await this.git(["--git-dir", this.mirrorPathFor(url), "cat-file", "blob", `${oid}:${relPath}`], LOCAL_TIMEOUT_MS)).stdout;
    } catch {
      return null;
    }
  }

  /** Whether `<oid>:<relPath>` exists (file or tree) in the host mirror of `url`. */
  async pathExistsAtCommit(url: string, oid: string, relPath: string): Promise<boolean> {
    if (!/^[0-9a-f]{7,64}$/.test(oid)) throw new Error(`invalid commit: ${oid}`);
    try {
      await this.git(["--git-dir", this.mirrorPathFor(url), "cat-file", "-e", `${oid}:${relPath}`], LOCAL_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }

  /** Refresh a host-owned mirror and resolve the exact branch tip a later
   * thread should seed from. Used by project checks and again before new
   * thread allocation; provisioning consumes the resulting pinned snapshot. */
  async prepareRepository(url: string, requestedBase?: string | null): Promise<PreparedRepository> {
    const mirror = await this.ensureMirror(url);
    const base =
      requestedBase ??
      (await this.git(["--git-dir", mirror, "symbolic-ref", "--short", "HEAD"], LOCAL_TIMEOUT_MS))
        .stdout.trim();
    assertRefName(base);
    try {
      const baseOid = (
        await this.git(
          ["--git-dir", mirror, "rev-parse", "--verify", `refs/heads/${base}`],
          LOCAL_TIMEOUT_MS,
        )
      ).stdout.trim();
      return { base, baseOid };
    } catch {
      throw new Error(`repository has no branch ${JSON.stringify(base)}`);
    }
  }

  /** Bare mirror without the network refresh — for push, which brings its
   * own objects via bundle. Same lock + atomic clone. */
  private ensureMirrorExists(url: string, signal?: AbortSignal): Promise<string> {
    const mirror = this.mirrorPathFor(url);
    return this.withMirrorLock(mirror, async () => {
      signal?.throwIfAborted();
      if (!fs.existsSync(mirror)) await this.cloneMirrorAtomic(url, mirror, signal);
      return mirror;
    });
  }

  private async cloneMirrorAtomic(url: string, mirror: string, signal?: AbortSignal): Promise<void> {
    fs.mkdirSync(this.reposRoot, { recursive: true });
    const tmp = `${mirror}.tmp-${crypto.randomBytes(6).toString("hex")}`;
    try {
      await this.git(["clone", "--mirror", "--", url, tmp], NETWORK_TIMEOUT_MS, undefined, signal);
      fs.renameSync(tmp, mirror); // atomic on the same filesystem
    } catch (error) {
      fs.rmSync(tmp, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * Seed a workspace from the mirror: local clone of <base> (mirror HEAD
   * when unset), then cut <branch> and point origin at the real upstream —
   * the agent sees a normal clone of the repo. Idempotent: an already
   * seeded workspace (".git" present) is left alone.
   */
  async seedWorkspace(opts: {
    url: string;
    workspacePath: string;
    base?: string | null;
    branch: string;
    identity?: GitIdentity | null;
  }): Promise<SeedResult> {
    const prepared = await this.prepareRepository(opts.url, opts.base);
    return this.seedPreparedWorkspace({
      ...opts,
      base: prepared.base,
      baseOid: prepared.baseOid,
    });
  }

  /** Seed strictly from a prepared mirror snapshot. No remote access occurs
   * here: thread allocation has already refreshed and pinned its repositories,
   * so provisioning must not move them again or silently fall back to old tips. */
  async seedPreparedWorkspace(opts: {
    url: string;
    workspacePath: string;
    base: string;
    baseOid: string;
    branch: string;
    identity?: GitIdentity | null;
  }): Promise<SeedResult> {
    assertRefName(opts.branch);
    assertRefName(opts.base);
    if (!/^[0-9a-f]{7,64}$/.test(opts.baseOid)) {
      throw new Error(`invalid prepared base commit: ${opts.baseOid}`);
    }
    if (fs.existsSync(path.join(opts.workspacePath, ".git"))) {
      // Existing workspaces are agent-writable. Do not write metadata or
      // hooks through paths that may now be symlinks; only fresh host-created
      // clones are safe to initialize below.
      const state = await this.state(opts.workspacePath);
      return { base: opts.base, baseOid: opts.baseOid, branch: state.branch ?? opts.branch };
    }
    const mirror = this.mirrorPathFor(opts.url);
    return this.withMirrorLock(mirror, async () => {
      if (!fs.existsSync(mirror)) {
        throw new Error("prepared repository mirror is missing — check the project again");
      }
      try {
        await this.git(
          ["--git-dir", mirror, "rev-parse", "--verify", `${opts.baseOid}^{commit}`],
          LOCAL_TIMEOUT_MS,
        );
      } catch {
        throw new Error("prepared repository snapshot is missing — check the project again");
      }
      // --no-hardlinks: the default local-clone optimization hardlinks pack
      // inodes, so a rooted cube could corrupt the host-owned mirror (and
      // every sibling clone) by truncating a workspace pack. Copy instead.
      // --no-checkout lets us cut the branch at the EXACT checked OID rather
      // than whichever tip the shared mirror happens to have now.
      await this.git(
        ["clone", "--no-hardlinks", "--no-checkout", "--", mirror, opts.workspacePath],
        NETWORK_TIMEOUT_MS,
      );
      const ws = opts.workspacePath;
      await this.git(["-C", ws, "checkout", "-b", opts.branch, opts.baseOid], LOCAL_TIMEOUT_MS);
      await this.git(["-C", ws, "remote", "set-url", "origin", opts.url], LOCAL_TIMEOUT_MS);
      await this.configureCommitMetadata(ws, opts.identity);
      return { base: opts.base, baseOid: opts.baseOid, branch: opts.branch };
    });
  }

  /** Put the connected user's public GitHub identity in this checkout only
   * and install Cube's attribution hook. Credentials remain host-side;
   * repository-local metadata works in both real cubes and the mock loop
   * without mutating the host's global config. Host-side git always forces
   * hooksPath=/dev/null, so this agent-side hook cannot execute on the host. */
  private async configureCommitMetadata(ws: string, identity?: GitIdentity | null): Promise<void> {
    if (identity) {
      await this.git(["-C", ws, "config", "--local", "user.name", identity.name], LOCAL_TIMEOUT_MS);
      await this.git(["-C", ws, "config", "--local", "user.email", identity.email], LOCAL_TIMEOUT_MS);
    }
    const hook = path.join(ws, ".git", "hooks", "prepare-commit-msg");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(
      hook,
      `#!/bin/sh\n` +
        `case "\${2-}" in commit|merge|squash) exit 0 ;; esac\n` +
        `trailer='Co-Authored-By: ${CUBE_COAUTHOR}'\n` +
        `grep -Fqx "$trailer" "$1" || printf '\\n%s\\n' "$trailer" >> "$1"\n`,
      { mode: 0o755 },
    );
  }

  /**
   * Branch / dirty / ahead — the review header. Host-side .git, so it works
   * while the cube sleeps. `baseOid` is the PINNED seed-time base tip
   * (registry), so `ahead` counts real commits since the base and cannot be
   * forged by rewriting the worktree's origin ref.
   */
  async state(ws: string, baseOid?: string | null, signal?: AbortSignal): Promise<RepoState> {
    const head = (
      await this.git(["-C", ws, "rev-parse", "--abbrev-ref", "HEAD"], LOCAL_TIMEOUT_MS, undefined, signal)
    ).stdout.trim();
    const branch = head === "HEAD" ? null : head;
    // GIT_ATTR_SOURCE (runner env) disables filter drivers, so status may
    // hash worktree blobs without running an agent-defined clean filter.
    const dirty =
      (await this.git(["-C", ws, "status", "--porcelain"], LOCAL_TIMEOUT_MS, undefined, signal)).stdout.trim() !== "";
    let ahead = 0;
    if (baseOid) {
      ahead = Number(
        (
          await this.git(
            ["-C", ws, "rev-list", "--count", `${baseOid}..HEAD`],
            LOCAL_TIMEOUT_MS,
            undefined,
            signal,
          )
        ).stdout.trim(),
      );
    }
    return { branch, dirty, ahead };
  }

  /** One layer of Git's three-layer diff, with a caller-supplied share of
   * the endpoint's total patch budget. The file list remains complete when
   * the text patch is truncated. */
  private async diffSection(
    ws: string,
    comparison: string[],
    patchBudget: number,
  ): Promise<RepoDiffSection> {
    const baseArgs = ["-C", ws, "diff", "--no-ext-diff", "--no-textconv"];
    const numstat = (
      await this.git(
        [...baseArgs, "--numstat", ...comparison],
        LOCAL_TIMEOUT_MS,
      )
    ).stdout;
    const files = numstat
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [additions, deletions, ...rest] = line.split("\t");
        return {
          path: rest.join("\t"),
          // "-" per side = binary file
          additions: additions === "-" ? null : Number(additions),
          deletions: deletions === "-" ? null : Number(deletions),
        };
      });

    if (files.length === 0) return { files, patch: "", truncated: false };
    if (patchBudget <= 0) return { files, patch: "", truncated: true };

    // Bound the process near its remaining payload share instead of letting
    // execFile allocate its 256 MB default, then slice by bytes for UTF-8.
    try {
      let patch = (
        await this.git(
          [...baseArgs, ...comparison],
          LOCAL_TIMEOUT_MS,
          patchBudget + 1024 * 1024,
        )
      ).stdout;
      const bytes = Buffer.from(patch, "utf8");
      const truncated = bytes.length > patchBudget;
      if (truncated) patch = bytes.subarray(0, patchBudget).toString("utf8");
      return { files, patch, truncated };
    } catch (error) {
      if (!/maxBuffer/i.test(String(error))) throw error;
      return { files, patch: "", truncated: true };
    }
  }

  /**
   * Preserve Git's actual layers instead of flattening everything into one
   * patch: pinned base -> HEAD, HEAD -> index, and index -> worktree.
   * GIT_ATTR_SOURCE plus --no-ext-diff/--no-textconv prevent hostile
   * worktree filters from executing. The three patches share one 4 MB cap.
   */
  async diff(ws: string, baseOid: string): Promise<RepoDiff> {
    if (!/^[0-9a-f]{7,64}$/.test(baseOid)) throw new Error(`invalid base commit: ${baseOid}`);

    let remaining = PATCH_MAX_BYTES;
    const committed = await this.diffSection(ws, [`${baseOid}..HEAD`], remaining);
    remaining -= Buffer.byteLength(committed.patch);
    const staged = await this.diffSection(ws, ["--cached", "HEAD"], remaining);
    remaining -= Buffer.byteLength(staged.patch);
    const unstaged = await this.diffSection(ws, [], remaining);

    const untracked = (
      await this.git(
        ["-C", ws, "ls-files", "--others", "--exclude-standard"],
        LOCAL_TIMEOUT_MS,
      )
    ).stdout
      .split("\n")
      .filter(Boolean);
    const statusEntries = (
      await this.git(["-C", ws, "status", "--porcelain=v1", "-z"], LOCAL_TIMEOUT_MS)
    ).stdout.split("\0").filter(Boolean);
    const tracked: string[] = [];
    for (let i = 0; i < statusEntries.length; i++) {
      const entry = statusEntries[i]!;
      const code = entry.slice(0, 2);
      if (code !== "??") tracked.push(entry.slice(3));
      // -z rename/copy records carry a second NUL-delimited source path.
      if (/[RC]/.test(code)) i += 1;
    }
    const trackedDirty = tracked.length > 0;
    const dirty = trackedDirty || untracked.length > 0;
    return { committed, staged, unstaged, untracked, tracked, dirty, trackedDirty };
  }

  /**
   * Push the workspace's current branch to `url` with host credentials.
   * The branch's objects are carried to the host-owned mirror as a static
   * bundle and pushed FROM the mirror — the networked step never loads the
   * (agent-owned) workspace config, so a repo-local credential.helper or
   * url.*.insteadOf cannot steal the host's credentials or redirect the
   * push. Returns the branch pushed.
   */
  async push(ws: string, url: string, targetBranch?: string, signal?: AbortSignal): Promise<string> {
    const { branch } = await this.state(ws, undefined, signal);
    if (!branch) throw new Error("cannot push: detached HEAD");
    assertRefName(branch);
    if (branch.startsWith("cube-review/")) {
      throw new Error("cannot push a prepared review branch directly; inspect planPrUpdate and use publishPrUpdate");
    }
    const target = targetBranch ?? branch;
    assertRefName(target);
    // All publication entry points (including push-to-base and createPr)
    // converge here. A normal fast-forward check alone cannot establish
    // that an agent preserved the tree or understood a restacked PR.
    const slug = parseGitHubRepo(url);
    if (slug) {
      fs.mkdirSync(this.reposRoot, { recursive: true });
      let pulls: unknown;
      try {
        const { stdout } = await this.run("gh", [
          "api", "--hostname", "github.com", "--method", "GET",
          `repos/${slug}/pulls?state=open&head=${encodeURIComponent(`${slug.split("/")[0]}:${target}`)}&per_page=1`,
        ], { cwd: this.reposRoot, timeoutMs: NETWORK_TIMEOUT_MS, signal });
        pulls = JSON.parse(stdout);
      } catch {
        throw new Error("cannot push: unable to verify existing pull requests; remote was not changed");
      }
      if (!Array.isArray(pulls)) {
        throw new Error("cannot push: incomplete pull request response; remote was not changed");
      }
      // Only existence matters, so one result is sufficient; no truncated
      // PR list is ever interpreted as a complete stack snapshot.
      if (pulls.length > 0) {
        throw new Error("cannot push: target branch belongs to an existing open pull request. Use preparePrUpdate for additive review fixes, or preparePrRebase for an explicitly requested standalone rewrite, then planPrUpdate and publishPrUpdate. Do not bypass this check using another branch.");
      }
    }
    await this.ensureMirrorExists(url, signal);
    const mirror = this.mirrorPathFor(url);
    // Full-history bundle of the branch: self-contained (no prerequisites
    // the mirror might lack), and bundle create runs no upload-pack —
    // `uploadpack.packObjectsHook` never fires.
    const bundle = path.join(
      os.tmpdir(),
      `cube-push-${crypto.randomBytes(8).toString("hex")}.bundle`,
    );
    await this.git(
      ["-C", ws, "bundle", "create", bundle, `refs/heads/${branch}`],
      NETWORK_TIMEOUT_MS,
      undefined,
      signal,
    );
    // Serialize the mirror's ref updates against concurrent pushes/seeds.
    return this.withMirrorLock(mirror, async () => {
      try {
        signal?.throwIfAborted();
        // Force into the mirror's own scratch head (a rebased branch is not a
        // fast-forward of the mirror's copy); the UPSTREAM push below stays
        // non-forced — never force-push a shared remote.
        await this.git(
          ["-C", mirror, "fetch", "--no-tags", "--", bundle, `+refs/heads/${branch}:refs/heads/${branch}`],
          LOCAL_TIMEOUT_MS,
          undefined,
          signal,
        );
        await this.git(
          ["-C", mirror, "push", "--", url, `refs/heads/${branch}:refs/heads/${target}`],
          NETWORK_TIMEOUT_MS,
          undefined,
          signal,
        );
      } finally {
        fs.rmSync(bundle, { force: true });
      }
      return branch;
    });
  }

  /** Refresh the trusted host mirror, then update the workspace's
   * origin/<base> through a static bundle. The networked fetch never loads
   * agent-controlled workspace config or receives host credentials. */
  async syncBase(ws: string, url: string, base: string, signal?: AbortSignal): Promise<string> {
    assertRefName(base);
    const mirror = await this.ensureMirror(url, signal);
    const oid = (
      await this.git(
        ["--git-dir", mirror, "rev-parse", "--verify", `refs/heads/${base}`],
        LOCAL_TIMEOUT_MS,
        undefined,
        signal,
      )
    ).stdout.trim();
    const bundle = path.join(os.tmpdir(), `cube-sync-${crypto.randomBytes(8).toString("hex")}.bundle`);
    try {
      await this.git(
        ["--git-dir", mirror, "bundle", "create", bundle, `refs/heads/${base}`],
        NETWORK_TIMEOUT_MS,
        undefined,
        signal,
      );
      await this.git(
        ["-C", ws, "fetch", "--force", "--no-tags", "--", bundle, `refs/heads/${base}:refs/remotes/origin/${base}`],
        LOCAL_TIMEOUT_MS,
        undefined,
        signal,
      );
      return oid;
    } finally {
      fs.rmSync(bundle, { force: true });
    }
  }

  /** Open a PR for the current branch with `gh` (host-side auth). */
  async createPr(
    ws: string,
    opts: { url: string; base: string; title: string; body?: string },
    signal?: AbortSignal,
  ): Promise<{ url: string; branch: string }> {
    const slug = parseGitHubRepo(opts.url);
    if (!slug) throw new Error(`cannot open a PR for a non-GitHub repository: ${opts.url}`);
    assertRefName(opts.base);
    const branch = await this.push(ws, opts.url, undefined, signal);
    // Neutral cwd (reposRoot) so gh never reads the workspace's .git.
    const ghOpts = { cwd: this.reposRoot, timeoutMs: NETWORK_TIMEOUT_MS, signal };
    try {
      const { stdout } = await this.run(
        "gh",
        [
          "pr", "create",
          "-R", slug,
          "--head", branch,
          "--base", opts.base,
          "--title", opts.title,
          "--body", opts.body ?? "",
        ],
        ghOpts,
      );
      const url = stdout.trim().split("\n").pop() ?? "";
      return { url, branch };
    } catch (error) {
      if (!/already exists/i.test(String(error))) throw error;
      const { stdout } = await this.run(
        "gh",
        ["pr", "view", branch, "-R", slug, "--json", "url", "--jq", ".url"],
        ghOpts,
      );
      return { url: stdout.trim(), branch };
    }
  }

  private git(
    args: string[],
    timeoutMs: number,
    maxBuffer?: number,
    signal?: AbortSignal,
  ): Promise<RunResult> {
    return this.run("git", [...SAFE_CONFIG, ...args], { timeoutMs, maxBuffer, signal });
  }
}

export { PrReviewService } from "./pr-review.ts";
