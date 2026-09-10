/** Native stack merged-prefix regressions: real Git, read-only GitHub fixtures. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultRunner, PrReviewService, type ProcessRunner } from "../src/index.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cube-merged-review-"));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, {
  cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
}).trim();
const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgSign=false"];
const slug = "acme/prefix";
const url = `https://github.com/${slug}.git`;
const numbers = [842, 843, 844, 845, 846, 847, 848];
const branches = numbers.map((n) => `stack/pr-${n}`);

try {
  for (const method of ["group-merge", "squash", "rebase"] as const) {
    const dir = path.join(tmp, method);
    fs.mkdirSync(dir);
    const bare = path.join(dir, "remote.git");
    const seed = path.join(dir, "seed");
    const ws = path.join(dir, "workspace");
    const root = path.join(dir, "host");
    git(dir, "init", "--bare", "-b", "main", bare);
    git(dir, "clone", bare, seed);
    const commitFile = (file: string, text: string) => {
      fs.writeFileSync(path.join(seed, file), text);
      git(seed, ...identity, "add", file);
      git(seed, ...identity, "commit", "-m", file);
      return git(seed, "rev-parse", "HEAD");
    };
    const initial = commitFile("initial.txt", "initial\n");
    git(seed, "push", "origin", "main");
    git(dir, "clone", bare, ws); // no stack objects in the guest yet
    const oldHeads: string[] = [];
    for (let i = 0; i < 3; i++) {
      git(seed, "switch", "-c", branches[i]!);
      oldHeads.push(commitFile(`layer-${i}.txt`, `merged work ${i}\n`));
      git(seed, "push", "origin", branches[i]!);
    }
    git(seed, "switch", "main");
    commitFile("trunk-only.txt", "independent trunk work\n");
    const landed: string[] = [];
    if (method === "group-merge") {
      git(seed, ...identity, "merge", "--no-ff", oldHeads[2]!, "-m", "merge native prefix as a group");
      landed.push(...Array<string>(3).fill(git(seed, "rev-parse", "HEAD")));
    } else {
      for (const head of oldHeads) {
        if (method === "squash") {
          git(seed, ...identity, "cherry-pick", "--no-commit", head);
          git(seed, ...identity, "commit", "-m", "squashed layer");
        } else {
          git(seed, ...identity, "cherry-pick", head);
        }
        landed.push(git(seed, "rev-parse", "HEAD"));
      }
    }
    git(seed, "push", "origin", "main");
    const trunk = git(seed, "rev-parse", "HEAD");
    if (method !== "group-merge") {
      assert.throws(() => git(seed, "merge-base", "--is-ancestor", oldHeads[2]!, trunk), "old PR heads need not be ancestors of trunk");
    }
    for (let i = 3; i < 7; i++) {
      git(seed, "switch", "-c", branches[i]!);
      commitFile(`layer-${i}.txt`, `active work ${i}\n`);
      git(seed, "push", "origin", branches[i]!);
    }
    // Deleted merged refs must not be required; retained refs may be stale.
    if (method !== "group-merge") {
      for (const branch of branches.slice(0, 3)) git(bare, "update-ref", "-d", `refs/heads/${branch}`);
    }
    const remoteOid = (branch: string) => git(bare, "rev-parse", `refs/heads/${branch}`);
    const before = git(bare, "show-ref");
    const activeHeads = branches.slice(3).map(remoteOid);
    let mode: "ok" | "unlanded" | "missing-merge" | "closed" | "hole" | "stale-base" | "changed-prefix" = "ok";
    const pr = (i: number) => ({
      number: numbers[i],
      state: i < 3 && !(mode === "hole" && i === 1) ? "closed" : "open",
      merged: i < 3 && !((mode === "closed" || mode === "hole") && i === 1),
      merge_commit_sha: mode === "missing-merge" && i === 1 ? null
        : mode === "unlanded" && i === 1 ? activeHeads[0]
        : mode === "changed-prefix" && i === 1 ? initial : landed[i],
      stack: { id: 91, number: 50, size: 7, position: i + 1, base: { ref: "main", sha: remoteOid("main") } },
      head: { ref: branches[i], sha: i < 3 ? oldHeads[i] : remoteOid(branches[i]!), repo: { full_name: slug } },
      // Historical PR bases deliberately reference deleted branches and old
      // commits. Only active PR bases describe the current dependency chain.
      base: { ref: i === 0 || (i === 3 && mode !== "stale-base") ? "main" : branches[i - 1],
        sha: i < 3 ? (i === 0 ? initial : oldHeads[i - 1])
          : i === 3 ? (mode === "stale-base" ? oldHeads[2] : remoteOid("main")) : remoteOid(branches[i - 1]!),
        repo: { full_name: slug } },
    });
    const pushes: string[][] = [];
    const runner: ProcessRunner = async (file, args, opts) => {
      if (file === "gh") {
        if (args.includes("graphql")) {
          const query = args.find((arg) => arg.startsWith("query="))!;
          assert.ok(!query.includes("mutation"));
          for (const number of numbers.slice(0, 3)) assert.ok(!query.includes(`number:${number})`), "do not query deleted historical base refs");
          return { stdout: JSON.stringify({ data: { repository: Object.fromEntries(numbers.slice(3).map((_, i) => {
            const data = pr(i + 3);
            return [`p${i}`, { state: "OPEN", mergeQueueEntry: null, headRefOid: data.head.sha, baseRefOid: data.base.sha }];
          })) } }), stderr: "" };
        }
        assert.ok(args.includes("GET"), "preparation/review must not mutate native stack metadata");
        const endpoint = args.at(-1)!;
        const data = endpoint.endsWith("/stacks/50") ? {
          id: 91, number: 50, open: true, base: { ref: "main" },
          pull_requests: numbers.map((_, i) => { const data = pr(i); return { number: data.number, head: data.head }; }),
        } : pr(numbers.indexOf(Number(endpoint.split("/").at(-1))));
        return { stdout: JSON.stringify(data), stderr: "" };
      }
      if (args.includes("fetch") && args.includes(url)) {
        for (const branch of branches.slice(0, 3)) assert.ok(!args.some((arg) => arg.startsWith(`refs/heads/${branch}:`)), "never fetch historical head branches");
      }
      if (args.includes("push")) pushes.push(args);
      return defaultRunner(file, args.map((arg) => arg === url ? bare : arg), opts);
    };
    const service = new PrReviewService(root, runner);
    // A merged flag alone is not proof. A missing result, or a real commit
    // present only on an active branch, must not pass the trunk check.
    for (const [failure, pattern] of [
      ["unlanded", /merged PR #843 is not verifiably contained/],
      ["missing-merge", /missing full commit SHA/],
      ["closed", /closed but unmerged/],
      ["hole", /contiguous prefix/],
      ["stale-base", /has not retargeted/],
    ] as const) {
      mode = failure;
      await assert.rejects(service.prepare(ws, url, 845), pattern);
      assert.equal(git(bare, "show-ref"), before);
      assert.equal(pushes.length, 0);
    }
    mode = "ok";
    await assert.rejects(service.prepare(ws, url, 843), /requested PR must still be open/);
    const target = method === "rebase" ? 847 : 845;
    const prepared = await service.prepare(ws, url, target);
    assert.equal(prepared.head, activeHeads[target - 845]);
    assert.equal(prepared.stack.base, "main");
    assert.deepEqual(prepared.stack.layers.map((layer) => layer.number), [845, 846, 847, 848]);
    assert.deepEqual(prepared.stack.mergedPrefix?.map((layer) => layer.number), [842, 843, 844]);
    assert.deepEqual(prepared.stack.mergedPrefix?.map((layer) => layer.mergeOid), landed);
    assert.equal(git(ws, "rev-parse", "HEAD"), initial, "preparation preserves the guest checkout");
    git(ws, "switch", prepared.branch);
    fs.writeFileSync(path.join(ws, "review.txt"), "scoped review fix\n");
    git(ws, ...identity, "add", "review.txt");
    git(ws, ...identity, "commit", "-m", "review fix");
    const plan = await service.plan(ws, url, prepared.token);
    assert.deepEqual(plan.changes.map((change) => change.number), numbers.filter((number) => number >= target));
    assert.equal(git(bare, "show-ref"), before, "planning never publishes");
    mode = "changed-prefix";
    await assert.rejects(service.publish(ws, url, prepared.token, plan.plan), /remote PR head, base, or stack changed/);
    assert.equal(pushes.length, 0);
    mode = "ok";
    assert.equal((await service.publish(ws, url, prepared.token, plan.plan)).verified, true);
    assert.equal(remoteOid("main"), trunk, "do not publish to trunk");
    assert.equal(pushes.length, 1);
    assert.ok(pushes[0]!.includes("--atomic"));
    for (const branch of branches.slice(0, 3)) {
      assert.ok(!pushes[0]!.some((arg) => arg.includes(`refs/heads/${branch}`)), "merged branches must not receive leases or updates");
      if (method === "group-merge") assert.equal(remoteOid(branch), oldHeads[branches.indexOf(branch)]);
      else assert.throws(() => remoteOid(branch), "deleted merged branches must stay deleted");
    }
    for (let i = 3; i < 7; i++) {
      const head = remoteOid(branches[i]!);
      if (numbers[i]! < target) assert.equal(head, activeHeads[i - 3], "active predecessors must not change");
      else {
        assert.ok(pushes[0]!.includes(`--force-with-lease=refs/heads/${branches[i]}:${activeHeads[i - 3]}`));
        assert.equal(git(bare, "show", `${head}:review.txt`), "scoped review fix");
      }
      for (let j = 0; j <= i; j++) {
        assert.equal(git(bare, "show", `${head}:layer-${j}.txt`), `${j < 3 ? "merged" : "active"} work ${j}`);
      }
      assert.equal(git(bare, "merge-base", "--is-ancestor", i === 3 ? trunk : remoteOid(branches[i - 1]!), head), "");
    }
    assert.equal(git(bare, "merge-base", "--is-ancestor", prepared.head, remoteOid(branches[target - 842]!)), "");
    assert.equal((await new PrReviewService(root, runner).verify(ws, url, prepared.token)).verified, true);
    console.log(`PASS merged prefix: ${method}, target #${target}, merged history retained, only active suffix published`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
