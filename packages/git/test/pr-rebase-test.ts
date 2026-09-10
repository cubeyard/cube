/** Standalone PR rebase transactions, entirely against throwaway local remotes.
 * No authenticated network, live PR, or repository under test is rewritten. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRunner, type ProcessRunner } from "../src/index.ts";
import { PrReviewService } from "../src/pr-review.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-pr-rebase-"));
const bare = path.join(tmp, "remote.git"), seed = path.join(tmp, "seed"), ws = path.join(tmp, "workspace"), root = path.join(tmp, "state");
const url = "https://github.com/acme/rebase-fixture.git", slug = "acme/rebase-fixture";
const cfg = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false", "-c", "core.editor=true"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...cfg, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (file: string, content: string, message: string) => {
  fs.writeFileSync(path.join(seed, file), content);
  git(seed, "add", file); git(seed, "commit", "-m", message);
  return git(seed, "rev-parse", "HEAD");
};
let mode: "ok" | "missing" | "stack" | "queued" | "fork" = "ok";
let raceAtPush = false;
let raceOid = "";
const pushes: string[][] = [];
const remoteOid = (branch: string) => git(bare, "rev-parse", `refs/heads/${branch}`);
const pr = () => ({ number: 30, state: "open", merged: false,
  ...(mode === "missing" ? {} : { stack: mode === "stack" ? { id: 1, number: 7, size: 1, position: 1, base: { ref: "main" } } : null }),
  head: { ref: "feature", sha: remoteOid("feature"), repo: { full_name: mode === "fork" ? "other/repo" : slug } },
  base: { ref: "main", sha: remoteOid("main"), repo: { full_name: slug } },
});
const runner: ProcessRunner = async (file, args, opts) => {
  if (file === "gh") {
    assert.equal(opts.cwd, root);
    const p = pr();
    if (args.includes("graphql")) return { stdout: JSON.stringify({ data: { repository: { p0: {
      headRefOid: p.head.sha, baseRefOid: p.base.sha, state: "OPEN", mergeQueueEntry: mode === "queued" ? { id: "queue" } : null,
    } } } }), stderr: "" };
    if (args.some(a => a.includes("/stacks/"))) return { stdout: JSON.stringify({ id: 1, number: 7, open: true,
      base: { ref: "main" }, pull_requests: [{ number: 30, head: p.head }],
    }), stderr: "" };
    assert.ok(args.some(a => a.endsWith("/pulls/30")));
    return { stdout: JSON.stringify(p), stderr: "" };
  }
  assert.equal(file, "git");
  if (args.includes(url)) assert.notEqual(args[args.indexOf("-C") + 1], ws, "network operations never load workspace config");
  if (args.includes("push")) {
    pushes.push(args);
    assert.ok(args.includes("--atomic"));
    assert.ok(!args.includes("--force"));
    assert.equal(args.filter(a => a.startsWith("--force-with-lease=")).length, 1);
    if (raceAtPush) {
      raceAtPush = false;
      git(seed, "fetch", "origin"); git(seed, "switch", "--detach", "origin/feature");
      raceOid = commit("concurrent.txt", "someone else's work\n", "concurrent update");
      git(seed, "push", "origin", "HEAD:feature");
    }
  }
  return defaultRunner(file, args.map(a => a === url ? bare : a), opts);
};

try {
  git(tmp, "init", "--bare", "-b", "main", bare); git(tmp, "clone", bare, seed);
  const initial = commit("common.txt", "original\n", "initial");
  git(seed, "push", "origin", "main");
  git(seed, "switch", "-c", "feature");
  commit("feature.txt", "intended feature\n", "feature");
  commit("common.txt", "feature edit\n", "feature edit");
  git(seed, "switch", "main"); commit("common.txt", "upstream edit\n", "upstream edit");
  git(seed, "push", "origin", "main");
  git(seed, "switch", "feature");
  assert.throws(() => git(seed, "merge", "main"), /CONFLICT|failed/);
  fs.writeFileSync(path.join(seed, "common.txt"), "resolved both edits\n");
  git(seed, "add", "common.txt"); git(seed, "commit", "-m", "resolve main merge");
  const original = git(seed, "rev-parse", "HEAD");
  git(seed, "push", "origin", "feature");
  git(seed, "switch", "main"); commit("base.txt", "latest base\n", "advance main again");
  git(seed, "push", "origin", "main");
  git(tmp, "clone", bare, ws);
  const service = new PrReviewService(root, runner);
  const additive = await service.prepare(ws, url, 30);
  const prepared = await service.prepareRebase(ws, url, 30);
  assert.equal(git(ws, "branch", "--show-current"), "main", "prepare never switches/resets the caller's branch");
  assert.equal(prepared.head, original);
  assert.equal(prepared.baseOid, remoteOid("main"));
  assert.ok(prepared.rebaseCommand);
  assert.equal(pushes.length, 0);
  git(ws, "switch", prepared.branch);
  assert.throws(() => git(ws, "-c", "user.name=Rebase1", ...prepared.rebaseCommand.split(" ").slice(1)), /CONFLICT|failed/);
  await assert.rejects(service.plan(ws, url, prepared.token), /clean working tree/);
  assert.equal(remoteOid("feature"), original, "local conflicts do not alter the remote");
  // The original merge resolution must be preserved explicitly when flattening.
  fs.writeFileSync(path.join(ws, "common.txt"), git(seed, "show", `${original}:common.txt`) + "\n");
  git(ws, "add", "common.txt"); git(ws, "-c", "user.name=Rebase1", "rebase", "--continue");
  const candidate = git(ws, "rev-parse", "HEAD");
  assert.equal(git(ws, "rev-list", "--merges", `${prepared.baseOid}..HEAD`), "");
  assert.equal(git(ws, "show", "HEAD:common.txt"), "resolved both edits");
  assert.equal(git(ws, "show", "HEAD:feature.txt"), "intended feature");
  assert.equal(git(ws, "show", "HEAD:base.txt"), "latest base");

  // An ordinary review token cannot be repurposed to authorize a rewrite.
  git(ws, "switch", additive.branch); git(ws, "reset", "--hard", candidate);
  await assert.rejects(service.plan(ws, url, additive.token), /existing commits must be preserved/);
  git(ws, "switch", prepared.branch);
  const plan = await service.plan(ws, url, prepared.token);
  assert.equal(plan.rewritesHistory, true);
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0]!.before, original);
  assert.equal(plan.changes[0]!.after, candidate);
  assert.deepEqual(await new PrReviewService(root, runner).plan(ws, url, prepared.token), plan, "saved plans survive service restart");
  for (const section of ["patch", "prDiff"] as const) {
    let page: number | null = 1;
    while (page !== null) {
      const diff = await service.inspect(ws, url, prepared.token, plan.plan, { number: 30, section, page });
      if (section === "prDiff") assert.match(diff.text, /intended feature/);
      page = diff.nextPage;
    }
  }
  // Local tracking refs are deliberately wrong: the lease comes from the host snapshot.
  git(ws, "update-ref", "refs/remotes/origin/feature", initial);
  assert.equal((await service.publish(ws, url, prepared.token, plan.plan)).verified, true);
  assert.equal(remoteOid("feature"), candidate);
  assert.ok(pushes.at(-1)!.includes(`--force-with-lease=refs/heads/feature:${original}`));
  await assert.rejects(service.publish(ws, url, prepared.token, plan.plan), /no matching unconsumed/);
  assert.equal((await new PrReviewService(root, runner).verify(ws, url, prepared.token)).verified, true);
  console.log("1 ok: flatten merged PR, resolve conflicts, inspect, publish using an exact lease; additive reviews stay immutable");

  // The rewrite still has to contain the pinned base and be linear above it.
  const invalid = await service.prepareRebase(ws, url, 30);
  git(ws, "switch", invalid.branch); git(ws, "reset", "--hard", initial);
  await assert.rejects(service.plan(ws, url, invalid.token), /exact prepared base/);
  git(ws, "reset", "--hard", invalid.head);
  git(ws, "switch", "-c", "side");
  fs.writeFileSync(path.join(ws, "side.txt"), "side\n"); git(ws, "add", "side.txt"); git(ws, "commit", "-m", "side");
  git(ws, "switch", invalid.branch); git(ws, "merge", "--no-ff", "side", "-m", "nonlinear candidate");
  await assert.rejects(service.plan(ws, url, invalid.token), /must be linear/);

  let rebaseCount = 1;
  async function rewrite() {
    const snapshot = await service.prepareRebase(ws, url, 30);
    git(ws, "switch", snapshot.branch);
    git(ws, "-c", `user.name=Rebase${++rebaseCount}`, ...snapshot.rebaseCommand!.split(" ").slice(1));
    return { snapshot, plan: await service.plan(ws, url, snapshot.token) };
  }
  const stale = await rewrite();
  const beforePushes = pushes.length;
  git(seed, "switch", "main"); commit("new-base.txt", "advanced after planning\n", "base race"); git(seed, "push", "origin", "main");
  await assert.rejects(service.publish(ws, url, stale.snapshot.token, stale.plan.plan), /remote PR head, base, or stack changed/);
  assert.equal(pushes.length, beforePushes, "base drift is rejected before push");
  const raced = await rewrite();
  raceAtPush = true;
  await assert.rejects(service.publish(ws, url, raced.snapshot.token, raced.plan.plan), /outcome is unknown/);
  assert.equal(remoteOid("feature"), raceOid, "lease protects a last-millisecond concurrent update");
  await assert.rejects(service.publish(ws, url, raced.snapshot.token, raced.plan.plan), /no matching unconsumed/);
  await assert.rejects(service.verify(ws, url, raced.snapshot.token), /needs reconciliation/);
  console.log("2 ok: invalid candidates, base drift, and stale leases rejected without overwriting concurrent work");

  const expected = remoteOid("feature");
  for (const [value, pattern] of [["missing", /native stack membership/], ["stack", /standalone PRs only/],
    ["queued", /queued/], ["fork", /forked/]] as const) {
    mode = value;
    await assert.rejects(service.prepareRebase(ws, url, 30), pattern);
  }
  mode = "ok";
  assert.equal(remoteOid("feature"), expected);
  fs.writeFileSync(path.join(ws, "dirty.txt"), "unsaved work\n");
  await assert.rejects(service.prepareRebase(ws, url, 30), /working tree must be clean/);
  console.log("3 ok: missing metadata, native stacks, queues, forks and dirty workspaces stop safely");
  console.log("ALL PASS");
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
