/** Offline integration test for the native stacked-PR transaction. */
import assert from "node:assert";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRunner, GitService, type ProcessRunner } from "../src/index.ts";
import { PrReviewService } from "../src/pr-review.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-pr-review-"));
const bare = path.join(tmp, "remote.git");
const seed = path.join(tmp, "seed");
const ws = path.join(tmp, "workspace");
const root = path.join(tmp, "state");
const fixtureUrl = "https://github.com/acme/widgets.git";
const slug = "acme/widgets";
const cfg = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const commit = (file: string, text: string, message: string) => {
  fs.writeFileSync(path.join(seed, file), text);
  git(seed, ...cfg, "add", file); git(seed, ...cfg, "commit", "-m", message);
  return git(seed, "rev-parse", "HEAD");
};

git(tmp, "init", "--bare", "-b", "main", bare);
git(tmp, "clone", bare, seed);
const oldBase = commit("base.txt", "old\n", "old base");
git(seed, "push", "origin", "HEAD:main");
const numbers = [842, 843, 844, 845, 846, 847, 848];
const branches = numbers.map((n) => `stack/pr-${n}`);
for (let i = 0; i < numbers.length; i++) {
  git(seed, "switch", "-c", branches[i]!);
  commit(`pr-${numbers[i]}.txt`, `change ${numbers[i]}\n`, `old PR ${numbers[i]}`);
  git(seed, "push", "origin", `HEAD:${branches[i]}`);
}
git(tmp, "clone", bare, ws); // deliberately stale before remote additions/restack
git(ws, "switch", branches[3]!);
const staleHead = git(ws, "rev-parse", "HEAD");
git(seed, "switch", "main");
const latestBase = commit("base.txt", "old\nlatest\n", "latest base");
git(seed, "push", "origin", "HEAD:main");
const original: string[] = [];
for (let i = 0; i < numbers.length; i++) {
  git(seed, "switch", "-C", branches[i]!);
  commit(`pr-${numbers[i]}.txt`, `change ${numbers[i]}\n`, `PR ${numbers[i]}`);
  if (i === 3) commit("remote-only.txt", "newer work to preserve\n", "newer change on target");
  original.push(git(seed, "rev-parse", "HEAD"));
  git(seed, "push", "--force", "origin", `HEAD:${branches[i]}`);
}

let mode: "ok" | "missing" | "truncated" | "queued" | "wrong-sha" | "wrong-order" = "ok";
let raceAtPush = false;
const pushCalls: string[][] = [];
const remoteOid = (ref: string) => git(bare, "rev-parse", `refs/heads/${ref}`);
const apiOid = (ref: string) => mode === "wrong-sha" && ref === branches[3] ? "f".repeat(40) : remoteOid(ref);
function pr(n: number) {
  const i = numbers.indexOf(n), headSha = apiOid(branches[i]!);
  const baseRef = i ? branches[i - 1]! : "main";
  const baseSha = apiOid(baseRef);
  return { number: n, state: "open", merged: false,
    stack: mode === "missing" ? undefined : { id: 71, number: 9, size: 7, position: mode === "wrong-order" ? 7 - i : i + 1, base: { ref: "main", sha: latestBase } },
    head: { ref: branches[i], sha: headSha, repo: { full_name: slug } },
    base: { ref: baseRef, sha: baseSha, repo: { full_name: slug } } };
}
const runner: ProcessRunner = async (file, args, opts) => {
  if (file === "gh") {
    assert.equal(opts.cwd, root, "GitHub must never read workspace configuration");
    const endpoint = args.find((a) => a.startsWith("repos/"));
    if (endpoint?.includes("/pulls/")) return { stdout: JSON.stringify(pr(Number(endpoint.split("/").at(-1)))), stderr: "" };
    if (endpoint?.includes("/stacks/")) return { stdout: JSON.stringify({ id: 71, number: 9, open: true, base: { ref: "main" },
      pull_requests: numbers.slice(0, mode === "truncated" ? 6 : 7).map((n, i) => ({ number: n, head: { ref: branches[i], sha: apiOid(branches[i]!) } })) }), stderr: "" };
    if (args.includes("graphql")) {
      const repository = Object.fromEntries(numbers.map((n, i) => { const x = pr(n); return [`p${i}`, { headRefOid: x.head.sha, baseRefOid: x.base.sha, state: "OPEN", mergeQueueEntry: mode === "queued" && i === 5 ? { id: "queue" } : null }]; }));
      return { stdout: JSON.stringify({ data: { repository } }), stderr: "" };
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  }
  assert.equal(file, "git");
  if (args.includes(fixtureUrl)) assert.notEqual(args[args.indexOf("-C") + 1], ws, "network git must not load guest configuration");
  const rewritten = args.map((a) => a === fixtureUrl ? bare : a); // only exact fixture URL in git argv
  const push = rewritten.indexOf("push");
  if (push >= 0) {
    pushCalls.push([...rewritten]);
    if (raceAtPush) {
      raceAtPush = false;
      const descendant = branches[5]!;
      git(seed, "switch", descendant);
      commit("race.txt", "raced\n", "remote race");
      git(seed, "push", "--force", "origin", `HEAD:${descendant}`);
    }
  }
  return defaultRunner(file, rewritten, opts);
};

const service = new PrReviewService(root, runner);
assert.throws(() => git(ws, "cat-file", "-e", original[3]!));
const prepared = await service.prepare(ws, fixtureUrl, 845);
assert.equal(prepared.head, original[3]);
assert.equal(git(ws, "branch", "--show-current"), branches[3]);
assert.equal(git(ws, "rev-parse", "HEAD"), staleHead);
assert.equal(git(ws, "rev-parse", `refs/remotes/origin/${branches[3]}`), staleHead);
assert.equal(git(ws, "status", "--porcelain"), "");
for (let i = 0; i < 7; i++) assert.equal(git(ws, "rev-parse", `refs/cube/reviews/${prepared.token}/${i}`), original[i]);
assert.equal(git(ws, "rev-parse", `refs/cube/reviews/${prepared.token}/base`), latestBase);
git(ws, "switch", prepared.branch);
await assert.rejects(new GitService(root, runner).push(ws, fixtureUrl), /prepared review branch directly/);
await assert.rejects(new GitService(root, runner).push(ws, fixtureUrl, "main"), /prepared review branch directly/);
fs.writeFileSync(path.join(ws, "review.txt"), "scoped fix\n");
git(ws, ...cfg, "add", "review.txt"); git(ws, ...cfg, "commit", "-m", "review fix");
const localPlanner = new PrReviewService(root, async (file, args, opts) => {
  assert.equal(file, "git", "planning must not call GitHub");
  assert.ok(!args.includes(fixtureUrl) && !args.includes("ls-remote") && !args.includes("push"), "planning must not access remote");
  return defaultRunner(file, args, opts);
});
const plan = await localPlanner.plan(ws, fixtureUrl, prepared.token);
assert.deepEqual(plan.changes.map((c) => c.number), [845, 846, 847, 848]);
// Replanning must reuse the saved commits, not merely happen to rebase in
// the same clock second. A restarted service may not run rebase at all.
const noRebase = new PrReviewService(root, async (file, args, opts) => {
  assert.equal(file, "git");
  assert.ok(!args.includes("ls-remote") && !args.includes(fixtureUrl));
  assert.ok(!args.includes("rebase"), "unchanged candidate must not be restacked again");
  assert.ok(!args.includes("bundle") && !args.includes("fetch"), "unchanged candidate is already imported");
  return runner(file, args, opts);
});
assert.deepEqual(await noRebase.plan(ws, fixtureUrl, prepared.token), plan);
assert.ok(plan.changes.every((change) => !("patch" in change) && !("prDiff" in change)));
let inspectionDiffs = 0;
const offlineInspector = new PrReviewService(root, async (file, args, opts) => {
  assert.equal(file, "git");
  assert.ok(args.includes("diff"), "inspection may only compute a local diff, never fetch or rebase");
  inspectionDiffs++;
  return defaultRunner(file, args, opts);
});
for (const change of plan.changes) {
  assert.equal(change.diffstat.patch, "1 file changed, 1 insertion(+)");
  for (const section of ["patch", "prDiff"] as const) {
    const page = await offlineInspector.inspect(ws, fixtureUrl, prepared.token, plan.plan, { number: change.number, section });
    assert.equal(page.complete, true);
    assert.equal(page.nextPage, null);
    assert.equal(page.hash, crypto.createHash("sha256").update(page.text).digest("hex"));
    assert.equal(page.totalBytes, Buffer.byteLength(page.text));
    if (section === "patch") assert.match(page.text, /\+scoped fix/);
    else if (change.number !== 845) {
      assert.match(page.text, new RegExp(`\\+change ${change.number}`));
      assert.ok(!page.text.includes("scoped fix"), "descendant PR diff must exclude inherited review changes");
    }
  }
}
assert.equal(inspectionDiffs, 8, "one diff per requested PR/section, not the whole stack");
await assert.rejects(service.inspect(ws, fixtureUrl, prepared.token, "0".repeat(32), { number: 845, section: "patch" }), /no matching saved plan/);
await assert.rejects(service.inspect(ws, fixtureUrl, prepared.token, plan.plan, { number: 842, section: "patch" }), /not updated by this plan/);
for (const page of [0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
  await assert.rejects(service.inspect(ws, fixtureUrl, prepared.token, plan.plan, { number: 845, section: "patch", page }), /invalid PR or stack number|out of range/);
}
await assert.rejects(service.verify(ws, fixtureUrl, prepared.token), /publication has not been attempted/);
for (let i = 4; i < 7; i++) {
  const change = plan.changes[i - 3];
  assert.equal(git(root + `/pr-reviews/${prepared.token}/repo`, "merge-base", "--is-ancestor", plan.changes[i - 4].after, change.after), "");
  assert.equal(git(root + `/pr-reviews/${prepared.token}/repo`, "show", `${change.after}:pr-${numbers[i]}.txt`), `change ${numbers[i]}`);
}
const result = await service.publish(ws, fixtureUrl, prepared.token, plan.plan);
assert.equal(result.verified, true);
assert.equal(git(bare, "merge-base", "--is-ancestor", original[3]!, remoteOid(branches[3]!)), "");
for (let i = 3; i < 7; i++) {
  assert.equal(git(bare, "show", `${remoteOid(branches[i]!)}:remote-only.txt`), "newer work to preserve");
  assert.equal(git(bare, "show", `${remoteOid(branches[i]!)}:review.txt`), "scoped fix");
  for (let j = 0; j <= i; j++) assert.equal(git(bare, "show", `${remoteOid(branches[i]!)}:pr-${numbers[j]}.txt`), `change ${numbers[j]}`);
}
for (let i = 0; i < 3; i++) assert.equal(remoteOid(branches[i]!), original[i]);
assert.ok(pushCalls.at(-1)?.includes("--atomic"));
for (let i = 3; i < 7; i++) assert.ok(pushCalls.at(-1)?.includes(`--force-with-lease=refs/heads/${branches[i]}:${original[i]}`));
assert.equal((await new PrReviewService(root, runner).verify(ws, fixtureUrl, prepared.token)).verified, true);

// Native metadata must be complete, and failures must not mutate refs.
const snapshot = branches.map(remoteOid);
mode = "missing"; await assert.rejects(service.prepare(ws, fixtureUrl, 845), /native stack membership/);
mode = "truncated"; await assert.rejects(service.prepare(ws, fixtureUrl, 845), /incomplete or changed native stack/);
mode = "queued"; await assert.rejects(service.prepare(ws, fixtureUrl, 845), /stack is queued/);
mode = "wrong-order"; await assert.rejects(service.prepare(ws, fixtureUrl, 845), /stack changed during discovery/);
mode = "wrong-sha"; await assert.rejects(service.prepare(ws, fixtureUrl, 845), /fetched branch does not match/);
mode = "ok"; assert.deepEqual(branches.map(remoteOid), snapshot);

// Parallel discovery must preserve native order despite reordered replies,
// cap requests at four, and drain outstanding reads before reporting failure.
let inFlight = 0, peak = 0, rejectMember = false;
const concurrent = new PrReviewService(root, async (file, args, opts) => {
  const endpoint = file === "gh" ? args.find((arg) => arg.includes("/pulls/")) : undefined;
  if (!endpoint) return runner(file, args, opts);
  const number = Number(endpoint.split("/").at(-1));
  inFlight++;
  peak = Math.max(peak, inFlight);
  try {
    await new Promise((resolve) => setTimeout(resolve, number === 843 ? 1 : (849 - number) * 3));
    if (rejectMember && number === 843) throw new Error("member unavailable");
    return await runner(file, args, opts);
  } finally { inFlight--; }
});
const concurrentPrep = await concurrent.prepare(ws, fixtureUrl, 845);
assert.deepEqual(concurrentPrep.stack.layers.map((layer) => layer.number), numbers);
assert.equal(peak, 4);
assert.equal(inFlight, 0);
rejectMember = true;
await assert.rejects(concurrent.prepare(ws, fixtureUrl, 845), /GitHub state is unavailable/);
assert.equal(inFlight, 0, "failed discovery must not leave requests running");
assert.deepEqual(branches.map(remoteOid), snapshot);

// Failed fetch cannot fall back to cached refs/objects, even though this
// workspace now contains every current remote object from the first run.
const noFetch = new PrReviewService(root, async (file, args, opts) => {
  if (file === "git" && args.includes("fetch") && args.includes(fixtureUrl)) throw new Error("fetch unavailable");
  return runner(file, args, opts);
});
await assert.rejects(noFetch.prepare(ws, fixtureUrl, 845), /fetch unavailable/);
assert.deepEqual(branches.map(remoteOid), snapshot);

// A token is checkout-bound.
const other = path.join(tmp, "other"); git(tmp, "clone", bare, other);
await assert.rejects(service.verify(other, fixtureUrl, prepared.token), /another checkout/);
await assert.rejects(service.inspect(other, fixtureUrl, prepared.token, plan.plan, { number: 845, section: "patch" }), /another checkout/);

// A stale candidate cannot be relabelled as the prepared branch.
const stale = await service.prepare(ws, fixtureUrl, 845);
git(ws, "switch", stale.branch);
git(ws, "reset", "--hard", staleHead);
await assert.rejects(service.plan(ws, fixtureUrl, stale.token), /older than or diverges/);
assert.deepEqual(branches.map(remoteOid), snapshot);

// Conflicts in descendants never make it to the publication phase.
const conflict = await service.prepare(ws, fixtureUrl, 845);
git(ws, "switch", conflict.branch);
fs.writeFileSync(path.join(ws, "pr-846.txt"), "incompatible review change\n");
git(ws, ...cfg, "add", "pr-846.txt"); git(ws, ...cfg, "commit", "-m", "conflicting fix");
await assert.rejects(service.plan(ws, fixtureUrl, conflict.token), /restack conflict or failure at PR #846/);
assert.deepEqual(branches.map(remoteOid), snapshot);

// A post-plan local commit must not be silently included or ignored.
const localChange = await service.prepare(ws, fixtureUrl, 845);
git(ws, "switch", localChange.branch);
fs.writeFileSync(path.join(ws, "local.txt"), "inspected\n");
git(ws, ...cfg, "add", "local.txt"); git(ws, ...cfg, "commit", "-m", "inspected fix");
const localPlan = await service.plan(ws, fixtureUrl, localChange.token);
fs.writeFileSync(path.join(ws, "local.txt"), "uninspected\n");
git(ws, ...cfg, "commit", "-am", "later local change");
await assert.rejects(service.publish(ws, fixtureUrl, localChange.token, localPlan.plan), /workspace changed after planning/);
const oldPage = await offlineInspector.inspect(ws, fixtureUrl, localChange.token, localPlan.plan, { number: 845, section: "patch" });
assert.match(oldPage.text, /\+inspected/);
assert.ok(!oldPage.text.includes("uninspected"), "inspection must ignore later workspace commits");
const replacement = await service.plan(ws, fixtureUrl, localChange.token);
assert.notEqual(replacement.plan, localPlan.plan);
assert.notEqual(replacement.changes.at(-1)!.after, localPlan.changes.at(-1)!.after);
await assert.rejects(service.inspect(ws, fixtureUrl, localChange.token, localPlan.plan, { number: 845, section: "patch" }), /no matching saved plan/);
await assert.rejects(service.publish(ws, fixtureUrl, localChange.token, localPlan.plan), /no matching unconsumed/);
assert.deepEqual(branches.map(remoteOid), snapshot);

// Planning remains local after an upstream advance. Publication rejects
// both a reused plan and a newly generated plan before invoking push.
const advanced = await service.prepare(ws, fixtureUrl, 845);
git(ws, "switch", advanced.branch);
fs.writeFileSync(path.join(ws, "advance-fix.txt"), "fix\n");
git(ws, ...cfg, "add", "advance-fix.txt"); git(ws, ...cfg, "commit", "-m", "fix before remote advance");
const advancePlan = await service.plan(ws, fixtureUrl, advanced.token);
git(seed, "fetch", "origin");
git(seed, "switch", "--detach", snapshot[6]!);
const remoteAdvance = commit("advance.txt", "another contributor\n", "remote advance");
git(seed, "push", "origin", `HEAD:${branches[6]}`);
const beforeAdvanceCalls = pushCalls.length;
assert.deepEqual(await localPlanner.plan(ws, fixtureUrl, advanced.token), advancePlan);
assert.match((await offlineInspector.inspect(ws, fixtureUrl, advanced.token, advancePlan.plan, { number: 845, section: "patch" })).text, /\+fix/);
await assert.rejects(service.publish(ws, fixtureUrl, advanced.token, advancePlan.plan), /remote PR head, base, or stack changed/);
fs.appendFileSync(path.join(ws, "advance-fix.txt"), "additional local fix\n");
git(ws, ...cfg, "commit", "-am", "continue locally after remote advance");
const stalePlan = await localPlanner.plan(ws, fixtureUrl, advanced.token);
assert.notEqual(stalePlan.plan, advancePlan.plan);
await assert.rejects(service.publish(ws, fixtureUrl, advanced.token, stalePlan.plan), /remote PR head, base, or stack changed/);
assert.equal(pushCalls.length, beforeAdvanceCalls);
assert.deepEqual(branches.map(remoteOid), [...snapshot.slice(0, 6), remoteAdvance]);
git(bare, "update-ref", `refs/heads/${branches[6]}`, snapshot[6]!); // restore only the test's injected advance

// The receive may finish even when its acknowledgement is lost. A fresh
// service must reconcile the saved intent, not repeat the push.
const uncertain = await service.prepare(ws, fixtureUrl, 845);
git(ws, "switch", uncertain.branch);
fs.writeFileSync(path.join(ws, "uncertain.txt"), "preserve after disconnect\n");
git(ws, ...cfg, "add", "uncertain.txt"); git(ws, ...cfg, "commit", "-m", "fix with lost acknowledgement");
const uncertainPlan = await service.plan(ws, fixtureUrl, uncertain.token);
const lostAck = new PrReviewService(root, async (file, args, opts) => {
  const result = await runner(file, args, opts);
  if (file === "git" && args.includes("push")) throw new Error("connection lost after receive");
  return result;
});
await assert.rejects(lostAck.publish(ws, fixtureUrl, uncertain.token, uncertainPlan.plan), /outcome is unknown/);
await assert.rejects(new PrReviewService(root, runner).publish(ws, fixtureUrl, uncertain.token, uncertainPlan.plan), /unconsumed publication plan/);
assert.equal((await new PrReviewService(root, runner).verify(ws, fixtureUrl, uncertain.token)).verified, true);

// Never fall back to a partial push; never roll back if metadata changes
// during a successful ref transaction. The latter is a GitHub API limit.
for (const scenario of ["no-atomic", "metadata-race"]) {
  const prep = await service.prepare(ws, fixtureUrl, 845);
  git(ws, "switch", prep.branch);
  fs.writeFileSync(path.join(ws, `${scenario}.txt`), `${scenario}\n`);
  git(ws, ...cfg, "add", "-A"); git(ws, ...cfg, "commit", "-m", scenario);
  const planned = await service.plan(ws, fixtureUrl, prep.token);
  const before = branches.map(remoteOid);
  if (scenario === "no-atomic") git(bare, "config", "receive.advertiseAtomic", "false");
  const publisher = new PrReviewService(root, async (file, args, opts) => {
    const result = await runner(file, args, opts);
    if (file === "git" && args.includes("push") && scenario === "metadata-race") mode = "wrong-order";
    return result;
  });
  await assert.rejects(publisher.publish(ws, fixtureUrl, prep.token, planned.plan), scenario === "no-atomic" ? /outcome is unknown/ : /needs reconciliation/);
  if (scenario === "no-atomic") {
    assert.deepEqual(branches.map(remoteOid), before);
    git(bare, "config", "--unset", "receive.advertiseAtomic");
  } else {
    for (const change of planned.changes) assert.equal(remoteOid(change.branch), change.after);
    mode = "ok";
    assert.equal((await service.verify(ws, fixtureUrl, prep.token)).verified, true);
  }
}

// Atomic explicit leases reject every update when a descendant races immediately before push.
const p2 = await service.prepare(ws, fixtureUrl, 845);
git(ws, "switch", p2.branch); fs.writeFileSync(path.join(ws, "race-fix.txt"), "fix\n");
git(ws, ...cfg, "add", "race-fix.txt"); git(ws, ...cfg, "commit", "-m", "second fix");
const plan2 = await service.plan(ws, fixtureUrl, p2.token);
const beforeRace = branches.map(remoteOid); raceAtPush = true;
await assert.rejects(service.publish(ws, fixtureUrl, p2.token, plan2.plan), /outcome is unknown/);
assert.ok(pushCalls.at(-1)?.includes("--atomic"));
for (let i = 3; i < 7; i++) assert.ok(pushCalls.at(-1)?.includes(`--force-with-lease=refs/heads/${branches[i]}:${beforeRace[i]}`));
for (let i = 0; i < 7; i++) if (i !== 5) assert.equal(remoteOid(branches[i]!), beforeRace[i], `atomic race changed PR ${numbers[i]}`);
await assert.rejects(new PrReviewService(root, runner).verify(ws, fixtureUrl, p2.token), /reconciliation/);
git(bare, "update-ref", `refs/heads/${branches[5]}`, beforeRace[5]!);

// Both native-stack boundaries: bottom restacks every descendant; top
// changes only itself. No off-by-one parent or target selection.
for (const number of [842, 848]) {
  const prep = await service.prepare(ws, fixtureUrl, number);
  git(ws, "switch", prep.branch);
  fs.writeFileSync(path.join(ws, `boundary-${number}.txt`), `boundary ${number}\n`);
  git(ws, ...cfg, "add", "-A"); git(ws, ...cfg, "commit", "-m", `boundary ${number}`);
  const planned = await service.plan(ws, fixtureUrl, prep.token);
  assert.deepEqual(planned.changes.map((change) => change.number), number === 842 ? numbers : [848]);
  assert.equal((await service.publish(ws, fixtureUrl, prep.token, planned.plan)).verified, true);
}

// Explicitly unstacked PRs still use pinned heads and the same publication
// checks; missing membership is not interpreted as this explicit null.
const standalone = new PrReviewService(root, async (file, args, opts) => {
  if (file !== "gh") return runner(file, args, opts);
  const data = { ...pr(848), stack: null };
  if (args.includes("graphql")) return { stdout: JSON.stringify({ data: { repository: { p0: {
    headRefOid: data.head.sha, baseRefOid: data.base.sha, state: "OPEN", mergeQueueEntry: null,
  } } } }), stderr: "" };
  assert.ok(args.includes(`repos/${slug}/pulls/848`));
  return { stdout: JSON.stringify(data), stderr: "" };
});
const single = await standalone.prepare(ws, fixtureUrl, 848);
assert.equal(single.stack.id, null);
assert.equal(single.stack.layers.length, 1);
git(ws, "switch", single.branch);
fs.writeFileSync(path.join(ws, "standalone.txt"), "standalone fix\n");
// Large, long-line Unicode and binary diffs must fit model output a page
// at a time, without truncation, newline changes, or lost page boundaries.
fs.writeFileSync(path.join(ws, "large.txt"), 'æ😀\\"'.repeat(40_000) + "\n");
fs.writeFileSync(path.join(ws, "binary.bin"), Buffer.from([0, 255, 1, 2, 0, 4]));
git(ws, ...cfg, "add", "-A"); git(ws, ...cfg, "commit", "-m", "standalone fix");
const singlePlan = await standalone.plan(ws, fixtureUrl, single.token);
assert.ok(Buffer.byteLength(JSON.stringify(singlePlan)) < 4096);
const statePath = path.join(root, "pr-reviews", single.token, "state.json");
const savedState = fs.readFileSync(statePath, "utf8");
assert.deepEqual(Object.keys(JSON.parse(savedState).plan).sort(), ["candidate", "heads", "id"]);
assert.ok(Buffer.byteLength(savedState) < 4096, "large diffs must not increase persisted plan size");
for (const section of ["patch", "prDiff"] as const) {
  const parts: string[] = [];
  let pageNumber: number | null = 1;
  const change = singlePlan.changes[0]!;
  while (pageNumber !== null) {
    const page = await offlineInspector.inspect(ws, fixtureUrl, single.token, singlePlan.plan, { number: 848, section, page: pageNumber });
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 128 * 1024, "escaped response must fit the model limit");
    assert.equal(page.complete, page.nextPage === null);
    assert.equal(page.hash, section === "patch" ? change.patchHash : change.prDiffHash);
    parts.push(page.text);
    pageNumber = page.nextPage;
  }
  const text = parts.join("");
  assert.ok(parts.length > 2);
  assert.ok(Buffer.byteLength(text) > 256 * 1024);
  const repo = path.join(root, "pr-reviews", single.token, "repo");
  const range = section === "patch" ? [change.before, change.after] : [`${single.stack.baseOid}...${change.after}`];
  const expected = execFileSync("git", ["diff", "--binary", "--no-color", ...range], { cwd: repo, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  assert.equal(text, expected);
  assert.equal(crypto.createHash("sha256").update(text).digest("hex"), section === "patch" ? change.patchHash : change.prDiffHash);
  assert.equal(Buffer.byteLength(text), section === "patch" ? change.patchBytes : change.prDiffBytes);
  await assert.rejects(offlineInspector.inspect(ws, fixtureUrl, single.token, singlePlan.plan, { number: 848, section, page: parts.length + 1 }), /out of range/);
}
// Inspection and repeated planning leave the existing snapshot format and
// contents untouched, including across service restarts.
assert.deepEqual(await standalone.plan(ws, fixtureUrl, single.token), singlePlan);
assert.equal(fs.readFileSync(statePath, "utf8"), savedState);
assert.equal((await standalone.publish(ws, fixtureUrl, single.token, singlePlan.plan)).verified, true);

console.log("PASS pr-review: restacked 7-layer stale checkout; exact-head preservation; scoped restack; top/bottom; metadata/fetch/conflict/stale guards; atomic race/unsupported transport; restart and lost-ack reconciliation");
fs.rmSync(tmp, { recursive: true, force: true });
