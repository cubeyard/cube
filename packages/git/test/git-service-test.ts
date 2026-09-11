/**
 * Offline test for @cube/git against real local repos: URL normalization
 * (the injection gate), mirror clone + refresh, workspace seeding (branch
 * cut, origin rewrite), layered review diff (committed/staged/unstaged),
 * push to the upstream, and PR creation with an intercepted `gh`.
 *
 *   node packages/git/test/git-service-test.ts
 */
import assert from "node:assert";
import { Effect } from "effect";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CUBE_COAUTHOR,
  GitService,
  defaultRunner,
  describeRepoAuthFailure,
  isGitAuthFailure,
  normalizeRepoUrl,
  parseGitHubRepo,
  type ProcessRunner,
} from "../src/index.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-git-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// --- 1. URL normalization: shorthand expands; injection vectors refused
assert.equal(normalizeRepoUrl("cubeyard/cube"), "https://github.com/cubeyard/cube.git");
assert.equal(normalizeRepoUrl("https://github.com/cubeyard/cube.git"), "https://github.com/cubeyard/cube.git");
assert.equal(normalizeRepoUrl("git@github.com:cubeyard/cube.git"), "git@github.com:cubeyard/cube.git");
assert.equal(normalizeRepoUrl("ssh://git@host/repo.git"), "ssh://git@host/repo.git");
assert.equal(normalizeRepoUrl("/srv/repos/thing.git"), "/srv/repos/thing.git");
for (const bad of [
  "",
  "--upload-pack=/bin/sh",
  "-o x",
  "ext::sh -c whoami",
  "http://insecure.example/repo.git", // https only
  "owner/name/extra",
  "owner name",
  "https://oauth2:ghp_secret@github.com/org/repo.git", // inline token
  "ssh://user:pass@host/repo.git",
  "host.com:pw@evil/repo", // scp-style with a password
]) {
  assert.throws(() => normalizeRepoUrl(bad), new RegExp("repository"), `should reject: ${bad}`);
}
// scp-style with just a login user (no password) is fine
assert.equal(normalizeRepoUrl("git@github.com:org/repo.git"), "git@github.com:org/repo.git");
console.log("1 ok: normalizeRepoUrl — shorthand/https/ssh/scp pass; injections + inline creds refused");

// --- 1b. parseGitHubRepo: github forms -> owner/repo; others -> null
assert.equal(parseGitHubRepo("https://github.com/cubeyard/cube.git"), "cubeyard/cube");
assert.equal(parseGitHubRepo("git@github.com:cubeyard/cube.git"), "cubeyard/cube");
assert.equal(parseGitHubRepo("ssh://git@github.com/cubeyard/cube"), "cubeyard/cube");
assert.equal(parseGitHubRepo("https://gitlab.com/cubeyard/cube.git"), null);
assert.equal(parseGitHubRepo("/srv/repos/thing.git"), null);
console.log("1b ok: parseGitHubRepo — github forms parse, non-github is null");

// --- 1c. auth-failure classification: real git stderr → auth; everything else → not
for (const authy of [
  "git clone failed: fatal: could not read Username for 'https://github.com': terminal prompts disabled",
  "fatal: could not read Password for 'https://x-access-token@github.com': terminal prompts disabled",
  "fatal: Authentication failed for 'https://github.com/cubeyard/cube.git/'",
  "remote: Invalid username or token. Password authentication is not supported for Git operations.",
  "remote: Support for password authentication was removed on August 13, 2021.",
  "fatal: unable to access 'https://github.com/cubeyard/cube.git/': The requested URL returned error: 403",
  "git@github.com: Permission denied (publickey).",
]) {
  assert.equal(isGitAuthFailure(authy), true, `should classify as auth: ${authy}`);
}
for (const other of [
  "fatal: unable to access 'https://github.com/cubeyard/cube.git/': Could not resolve host: github.com",
  'repository has no branch "main"',
  "fatal: destination path exists",
  "remote: Repository not found.", // deliberately excluded: ambiguous with an absent repo
  "", // empty is not auth
]) {
  assert.equal(isGitAuthFailure(other), false, `should NOT classify as auth: ${other}`);
}
// Canonical copy only for github.com upstreams; other hosts keep the raw error.
const rawAuth = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
assert.equal(
  describeRepoAuthFailure(rawAuth, "https://github.com/cubeyard/cube.git", false),
  "github: not connected — connect github to check this repository",
);
assert.equal(
  describeRepoAuthFailure(rawAuth, "https://github.com/cubeyard/cube.git", true),
  "github: access denied — the connected github account may lack access to this repository",
);
assert.equal(describeRepoAuthFailure(rawAuth, "https://gitlab.com/x/y.git", false), null);
assert.equal(describeRepoAuthFailure("Could not resolve host: github.com", "https://github.com/x/y.git", false), null);
console.log("1c ok: auth classification — github stderr recognized, canonical copy for github upstreams only");

// --- 1d. Cancellation reaches the actual git/gh process runner.
{
  let receivedSignal: AbortSignal | undefined;
  const blocked: ProcessRunner = (_file, _args, opts) =>
    new Promise((_resolve, reject) => {
      receivedSignal = opts.signal;
      const onAbort = () => reject(opts.signal?.reason);
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
  const controller = new AbortController();
  const pending = new GitService(path.join(tmp, "repos-cancel"), blocked).ensureMirror(
    "https://github.com/x/cancel.git",
    controller.signal,
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new Error("request disconnected"));
  await assert.rejects(pending, /request disconnected/);
  assert.equal(receivedSignal, controller.signal);
  console.log("1d ok: abort propagates to the git process runner");
}

// --- upstream fixture: bare repo with two commits on main, one on a topic
const upstream = path.join(tmp, "upstream.git");
git(tmp, "init", "--bare", "-b", "main", upstream);
const seedClone = path.join(tmp, "seed-clone");
git(tmp, "clone", upstream, seedClone);
const cfg = ["-c", "user.name=test", "-c", "user.email=test@cube", "-c", "commit.gpgSign=false"];
fs.writeFileSync(path.join(seedClone, "README.md"), "hello\n");
fs.mkdirSync(path.join(seedClone, ".cube"), { recursive: true });
fs.writeFileSync(path.join(seedClone, ".cube", "cube.toml"), "# empty\n");
git(seedClone, ...cfg, "add", "-A");
git(seedClone, ...cfg, "commit", "-m", "init");
fs.writeFileSync(path.join(seedClone, "src.txt"), "one\ntwo\n");
git(seedClone, ...cfg, "add", "-A");
git(seedClone, ...cfg, "commit", "-m", "add src");
git(seedClone, "push", "origin", "main");

const service = new GitService(path.join(tmp, "repos"));

// --- 2. mirror + seed: base from mirror HEAD, branch cut, origin rewritten
const ws = path.join(tmp, "ws1");
fs.mkdirSync(ws, { recursive: true }); // pre-existing empty dir, like createUserThread
const seeded = await service.seedWorkspace({
  url: upstream,
  workspacePath: ws,
  branch: "cube/test1",
  identity: { name: "Git Hub User", email: "123+dizk@users.noreply.github.com" },
});
assert.equal(seeded.base, "main");
assert.equal(seeded.branch, "cube/test1");
assert.match(seeded.baseOid, /^[0-9a-f]{40}$/); // pinned base tip
assert.equal(seeded.baseOid, git(upstream, "rev-parse", "refs/heads/main"));
assert.equal(git(ws, "rev-parse", "--abbrev-ref", "HEAD"), "cube/test1");
assert.equal(git(ws, "remote", "get-url", "origin"), upstream);
assert.equal(git(ws, "config", "--local", "user.name"), "Git Hub User");
assert.equal(git(ws, "config", "--local", "user.email"), "123+dizk@users.noreply.github.com");
git(ws, "config", "commit.gpgSign", "false");
git(ws, "config", "core.hooksPath", ".git/hooks");
assert.equal(fs.readFileSync(path.join(ws, "src.txt"), "utf8"), "one\ntwo\n");
const mirror = service.mirrorPathFor(upstream);
assert.ok(fs.existsSync(path.join(mirror, "HEAD")), "mirror exists");
const baseOid = seeded.baseOid;
console.log("2 ok: seedWorkspace — mirror created, base=main+oid, branch cut, origin -> upstream");

// --- 3. state/diff: preserve Git's committed, staged, and unstaged layers.
// One file deliberately appears in BOTH local layers.
fs.writeFileSync(path.join(ws, "src.txt"), "one\ntwo\nthree\n");
git(ws, "commit", "-am", "agent work");
assert.match(git(ws, "log", "-1", "--format=%B"), new RegExp(`Co-Authored-By: ${CUBE_COAUTHOR}`));
fs.writeFileSync(path.join(ws, "README.md"), "hello staged\n");
git(ws, "add", "README.md");
fs.writeFileSync(path.join(ws, "README.md"), "hello staged\nhello unstaged\n");
fs.writeFileSync(path.join(ws, "notes.txt"), "untracked\n");
const state = await service.state(ws, baseOid);
assert.deepEqual(state, { branch: "cube/test1", dirty: true, ahead: 1 });
const diff = await service.diff(ws, baseOid);
assert.deepEqual(diff.committed.files.map((f) => f.path), ["src.txt"]);
assert.deepEqual(diff.staged.files.map((f) => f.path), ["README.md"]);
assert.deepEqual(diff.unstaged.files.map((f) => f.path), ["README.md"]);
assert.deepEqual(diff.untracked, ["notes.txt"]);
assert.deepEqual(diff.tracked, ["README.md"]);
assert.equal(diff.dirty, true); // README modified + notes.txt untracked
assert.equal(diff.trackedDirty, true);
assert.match(diff.committed.patch, /\+three/);
assert.match(diff.staged.patch, /hello staged/);
assert.match(diff.unstaged.patch, /hello unstaged/);
assert.equal(diff.committed.truncated || diff.staged.truncated || diff.unstaged.truncated, false);
console.log("3 ok: diff separates committed, staged, unstaged, and untracked work with exact status metadata");

// --- 3b. base-ref forgery: rewriting the worktree's origin ref must NOT
// change ahead/diff — those anchor on the pinned baseOid, not origin/main
git(ws, "update-ref", "refs/remotes/origin/main", "HEAD");
const forged = await service.state(ws, baseOid);
assert.equal(forged.ahead, 1, "ahead still counts real commits since the pinned base");
const forgedDiff = await service.diff(ws, baseOid);
assert.match(forgedDiff.committed.patch, /\+three/, "diff still shows the committed change");
console.log("3b ok: rewriting origin/main cannot forge an empty review");

// --- 3c. HOSTILE clean filter: a repo-local filter.*.clean assigned via
// .gitattributes must NOT execute when host-side diff/status run
{
  const canary = path.join(tmp, "filter-pwned");
  git(ws, "config", "filter.pwn.clean", `sh -c 'touch ${canary}; cat'`);
  fs.writeFileSync(path.join(ws, ".gitattributes"), "* filter=pwn\n");
  fs.writeFileSync(path.join(ws, "src.txt"), "one\ntwo\nthree\nfour\n");
  await service.state(ws, baseOid);
  await service.diff(ws, baseOid);
  assert.ok(!fs.existsSync(canary), "attribute-driven clean filter must not run host-side");
  // reset the worktree tamper so later steps see a clean slate
  fs.rmSync(path.join(ws, ".gitattributes"));
  git(ws, "config", "--unset", "filter.pwn.clean");
  fs.writeFileSync(path.join(ws, "src.txt"), "one\ntwo\nthree\n");
  console.log("3c ok: agent-defined clean filter ignored by host diff/status");
}

// --- 4. push: current branch lands on the upstream (must commit the
// uncommitted README first — push carries committed objects only)
git(ws, ...cfg, "commit", "-am", "commit before push");
const untrackedOnly = await service.diff(ws, baseOid);
assert.equal(untrackedOnly.dirty, true);
assert.equal(untrackedOnly.trackedDirty, false);
assert.deepEqual(untrackedOnly.tracked, []);
assert.deepEqual(untrackedOnly.untracked, ["notes.txt"]);
const pushedBranch = await service.push(ws, upstream);
assert.equal(pushedBranch, "cube/test1");
assert.equal(
  git(upstream, "rev-parse", "refs/heads/cube/test1"),
  git(ws, "rev-parse", "HEAD"),
);
console.log("4 ok: push — cube/test1 on the upstream at the workspace HEAD");

// --- 4b. HOSTILE workspace config: a repo-local credential.helper that
// would run a command must NOT fire (the networked push runs from the
// host-owned mirror, never loading the workspace config). Also a pre-push
// hook must not run.
{
  const canary = path.join(tmp, "pwned");
  git(ws, "config", "credential.helper", `!touch ${canary}; true`);
  const hookDir = path.join(ws, ".git", "hooks");
  fs.writeFileSync(path.join(hookDir, "pre-push"), `#!/bin/sh\ntouch ${canary}\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(ws, "hostile.txt"), "x\n");
  git(ws, ...cfg, "add", "-A");
  git(ws, ...cfg, "commit", "-m", "hostile");
  await service.push(ws, upstream);
  assert.ok(!fs.existsSync(canary), "workspace credential helper / pre-push hook must not execute");
  assert.equal(
    git(upstream, "rev-parse", "refs/heads/cube/test1"),
    git(ws, "rev-parse", "HEAD"),
    "hostile-config push still lands the commit",
  );
  console.log("4b ok: repo-local credential helper + pre-push hook ignored; push still lands");
}

// --- 5. mirror refresh: upstream advances, a second seed sees it
fs.writeFileSync(path.join(seedClone, "later.txt"), "later\n");
git(seedClone, ...cfg, "add", "-A");
git(seedClone, ...cfg, "commit", "-m", "upstream moved");
git(seedClone, "push", "origin", "main");
const ws2 = path.join(tmp, "ws2");
await service.seedWorkspace({ url: upstream, workspacePath: ws2, base: "main", branch: "cube/test2" });
assert.ok(fs.existsSync(path.join(ws2, "later.txt")), "fresh seed has the new upstream commit");
console.log("5 ok: ensureMirror refreshes — second seed sees the new upstream commit");

// --- 5b. Ship helpers: authenticated fetch updates origin/main through a
// static bundle; publishing HEAD to main stays non-forced.
const syncedOid = await service.syncBase(ws, upstream, "main");
assert.equal(syncedOid, git(upstream, "rev-parse", "refs/heads/main"));
assert.equal(git(ws, "rev-parse", "refs/remotes/origin/main"), syncedOid);
await assert.rejects(service.push(ws, upstream, "main"), /rejected|fetch first|non-fast-forward/);
git(ws, ...cfg, "rebase", "origin/main"); // rebase re-creates commits — needs the identity too (a fresh VM host has no .gitconfig)
await service.push(ws, upstream, "main");
assert.equal(git(upstream, "rev-parse", "refs/heads/main"), git(ws, "rev-parse", "HEAD"));
console.log("5b ok: syncBase refreshes origin/main; push-to-base rejects stale work then fast-forwards");

// --- 6. seeding is idempotent; a missing base branch fails loudly
const again = await service.seedWorkspace({ url: upstream, workspacePath: ws, branch: "cube/other" });
assert.equal(again.branch, "cube/test1", "already-seeded workspace untouched");
await assert.rejects(
  service.seedWorkspace({ url: upstream, workspacePath: path.join(tmp, "ws3"), base: "nope", branch: "cube/x" }),
  /no branch "nope"/,
);
console.log("6 ok: re-seed is a no-op; unknown base branch rejected");

// --- 7. PR: gh intercepted (real API never hit); the bundle-relay push
// runs for real against the local upstream, with the GitHub URL rewritten
// to it so the mirror + push target resolve locally.
// Section 5b rebased the local topic before publishing it to main; remove
// the old topic ref so this independent PR fixture can publish that history.
git(upstream, "update-ref", "-d", "refs/heads/cube/test1");
const GH_URL = "https://github.com/x/y.git";
const rewriteGitToLocal = (file: string, args: string[]) =>
  file === "git" ? args.map((a) => (a === GH_URL ? upstream : a)) : args;
const ghCalls: string[][] = [];
const intercept: ProcessRunner = (file, args, opts) => {
  if (file === "gh") {
    ghCalls.push(args);
    if (args[0] === "api") return Promise.resolve({ stdout: "[]", stderr: "" });
    if (args[1] === "create") return Promise.resolve({ stdout: "https://github.com/x/y/pull/7\n", stderr: "" });
    return Promise.resolve({ stdout: "", stderr: "" });
  }
  return defaultRunner(file, rewriteGitToLocal(file, args), opts);
};
const prService = new GitService(path.join(tmp, "repos-pr"), intercept);
fs.writeFileSync(path.join(ws, "pr.txt"), "pr\n");
git(ws, ...cfg, "add", "-A");
git(ws, ...cfg, "commit", "-m", "pr work");
const pr = await prService.createPr(ws, { url: GH_URL, base: "main", title: "My change", body: "details" });
assert.equal(pr.url, "https://github.com/x/y/pull/7");
assert.equal(pr.branch, "cube/test1");
assert.deepEqual(ghCalls, [
  ["api", "--hostname", "github.com", "--method", "GET", "repos/x/y/pulls?state=open&head=x%3Acube%2Ftest1&per_page=1"],
  ["pr", "create", "-R", "x/y", "--head", "cube/test1", "--base", "main", "--title", "My change", "--body", "details"],
]);
assert.equal(
  git(upstream, "rev-parse", "refs/heads/cube/test1"),
  git(ws, "rev-parse", "HEAD"),
  "createPr pushed before gh ran",
);
console.log("7 ok: createPr pushes (bundle-relay), then drives gh -R with the right argv");

// --- 8. existing-PR fallback: create fails with "already exists" -> view URL
const fallback: ProcessRunner = (file, args, opts) => {
  if (file === "gh") {
    if (args[0] === "api") return Promise.resolve({ stdout: "[]", stderr: "" });
    if (args[1] === "create") return Promise.reject(new Error("a pull request for branch already exists"));
    assert.deepEqual(args, ["pr", "view", "cube/test1", "-R", "x/y", "--json", "url", "--jq", ".url"]);
    return Promise.resolve({ stdout: "https://github.com/x/y/pull/3\n", stderr: "" });
  }
  return defaultRunner(file, rewriteGitToLocal(file, args), opts);
};
const existing = await new GitService(path.join(tmp, "repos-pr2"), fallback).createPr(ws, {
  url: GH_URL,
  base: "main",
  title: "t",
});
assert.equal(existing.url, "https://github.com/x/y/pull/3");
console.log("8 ok: existing PR resolves to its URL instead of an error");

// Existing PR updates must fail before ANY networked git command,
// independently of the local branch's history or tree.
{
  const before = git(upstream, "show-ref");
  for (const response of ['[{"number":845}]', '{"message":"not found"}', '[', null]) {
    const guarded = new GitService(path.join(tmp, "repos-guard"), async (file, args, opts) => {
      if (file === "gh") {
        assert.equal(args[0], "api");
        assert.equal(opts.cwd, path.join(tmp, "repos-guard"));
        assert.match(args[5]!, /head=x%3Acube%2Ftest1&per_page=1$/);
        if (response === null) throw new Error("authentication unavailable");
        return { stdout: response, stderr: "" };
      }
      assert.ok(!args.some((arg) => ["push", "fetch", "clone", "bundle"].includes(arg)), "must reject before transferring or publishing objects");
      return defaultRunner(file, args, opts);
    });
    const expected = response?.startsWith('[{') ? /existing open pull request/
      : response?.startsWith('{') ? /incomplete pull request response/ : /unable to verify existing pull requests/;
    await assert.rejects(guarded.push(ws, GH_URL), expected);
    await assert.rejects(guarded.push(ws, GH_URL, "cube/test1"), expected);
    await assert.rejects(guarded.createPr(ws, { url: GH_URL, base: "main", title: "review fix" }), expected);
    assert.equal(git(upstream, "show-ref"), before);
  }
  console.log("8b ok: existing PR and unavailable metadata block all publication paths without remote changes");
}

// --- 9. non-GitHub PR is refused (gh cannot open one)
await assert.rejects(
  new GitService(path.join(tmp, "repos"), intercept).createPr(ws, {
    url: upstream,
    base: "main",
    title: "t",
  }),
  /non-GitHub/,
);
console.log("9 ok: PR on a non-GitHub upstream refused");

// A bare mirror retains its old HEAD after fetch. New default discovery must
// follow remote HEAD, including a name change and deletion of the old default.
await Effect.runPromise(Effect.gen(function*() {
  git(upstream, "update-ref", "refs/heads/new-default", "refs/heads/main");
  git(upstream, "symbolic-ref", "HEAD", "refs/heads/new-default");
  git(upstream, "update-ref", "-d", "refs/heads/main");
  const snapshots = yield* Effect.all([
    Effect.tryPromise(() => service.prepareRepository(upstream)),
    Effect.tryPromise(() => service.prepareRepository(upstream)),
  ], { concurrency: 2 });
  assert.ok(snapshots.every((s) => s.base === "new-default"));
  assert.equal(snapshots[0]!.baseOid, git(upstream, "rev-parse", "HEAD"));
  assert.deepEqual(snapshots[0], snapshots[1], "same-repository refreshes serialize safely");
  const fresh = path.join(tmp, "new-default-workspace");
  yield* Effect.tryPromise(() => service.seedPreparedWorkspace({ url: upstream, workspacePath: fresh, branch: "cube/default", ...snapshots[0]! }));
  assert.equal(git(fresh, "rev-parse", "HEAD"), snapshots[0]!.baseOid);
  git(upstream, "symbolic-ref", "HEAD", "refs/heads/missing-default");
  yield* Effect.tryPromise(() => assert.rejects(service.prepareRepository(upstream), /no resolvable default branch/));
}));
console.log("10 ok: remote default rename, concurrent refresh, exact seed and missing default");

// The Effect helpers retain the public Promise API, command ordering and the
// existing safety/cancellation boundary on both clone and refresh paths.
const calls: string[] = [];
const observed = new GitService(path.join(tmp, "effect-boundary"), (file, args, opts) => {
  assert.equal(file, "git");
  assert.deepEqual(args.slice(0, 4), ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor="]);
  assert.ok(opts.signal instanceof AbortSignal, "Effect interruption reaches the process runner");
  const command = args[4] === "--git-dir" ? args[6]! : args[4]!;
  calls.push(command);
  return defaultRunner(file, args, opts);
});
// HEAD is deliberately unresolved above: an explicit base must not discover it.
const explicit = await observed.prepareRepository(upstream, "new-default");
assert.equal(explicit.base, "new-default");
assert.deepEqual(calls, ["clone", "rev-parse"]);
const explicitOid = git(upstream, "rev-parse", "refs/heads/new-default");
assert.equal(explicit.baseOid, explicitOid);
calls.length = 0;
git(upstream, "symbolic-ref", "HEAD", "refs/heads/new-default");
assert.deepEqual(await observed.prepareRepository(upstream), explicit);
assert.deepEqual(calls, ["ls-remote", "remote", "rev-parse"], "discover, refresh, then verify");
calls.length = 0;
await assert.rejects(observed.prepareRepository(upstream, "--invalid"), (error: unknown) =>
  error instanceof Error && error.cause instanceof Error && /invalid ref name/.test(error.cause.message));
assert.deepEqual(calls, [], "validation precedes mirror mutation");
await assert.rejects(observed.prepareRepository(upstream, "absent-branch"), /no branch "absent-branch" at the advertised commit/);

const failedRoot = path.join(tmp, "effect-failed-boundary");
const failed = new GitService(failedRoot, () => Promise.reject("network unavailable"));
await assert.rejects(failed.prepareRepository(upstream), (error: unknown) =>
  error instanceof Error && error.message.includes("network unavailable"));
assert.equal(fs.existsSync(failedRoot), false, "discovery failure never starts cloning");
console.log("11 ok: Effect boundaries retain ordering, explicit bases, signals and failures");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("git-service-test: all ok");
