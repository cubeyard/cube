/** The CI layout keeps every check somewhere, and the release gate holds. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

type Step = { uses?: string; run?: string; env?: Record<string, string> };
type Job = {
  name?: string;
  "runs-on": string;
  needs?: string | string[];
  strategy?: { matrix: Record<string, unknown[]> };
  steps: Step[];
};
type Workflow = { on: Record<string, any>; concurrency?: { group: string; "cancel-in-progress": string }; jobs: Record<string, Job> };

const root = path.resolve(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const workflow = (name: string) => parse(read(`.github/workflows/${name}`)) as Workflow;
const ci = workflow("ci.yml");
const platforms = workflow("platforms.yml");
const release = workflow("release.yml");
const runs = (w: Workflow) => Object.values(w.jobs).flatMap((job) => job.steps.map((step) => step.run ?? "")).join("\n");

// Pull requests get Linux only, superseded runs are cancelled, main runs every commit.
assert.deepEqual(ci.on.push.branches, ["main"]);
assert.ok("pull_request" in ci.on);
for (const w of [ci, platforms]) {
  assert.equal(w.concurrency?.["cancel-in-progress"], "${{ github.event_name == 'pull_request' }}");
  assert.match(w.concurrency?.group ?? "", /github\.event\.pull_request\.number \|\| github\.sha/);
}
for (const [id, job] of Object.entries(ci.jobs)) assert.equal(job["runs-on"], "ubuntu-latest", `ci.yml ${id} runs on Linux`);

// Every offline suite runs in exactly one shard.
const test = ci.jobs.test!;
const shards = test.strategy!.matrix.shard as number[];
assert.deepEqual(shards, shards.map((_, i) => i + 1));
assert.equal(test.name, `test (\${{ matrix.shard }}/${shards.length})`);
assert.equal(test.steps.find((step) => step.run?.includes("test-offline.sh"))?.env?.CUBE_TEST_SHARD, `\${{ matrix.shard }}/${shards.length}`);
const list = (shard?: string) => {
  const listed = spawnSync("bash", ["scripts/test-offline.sh", "--list"], {
    cwd: root, encoding: "utf8", env: { ...process.env, CUBE_TEST_SHARD: shard ?? "" },
  });
  return { status: listed.status, suites: listed.stdout.split("\n").filter(Boolean) };
};
const all = list("1/1").suites;
assert.ok(all.length > 50);
const sharded = shards.flatMap((k) => list(`${k}/${shards.length}`).suites);
assert.deepEqual([...sharded].sort(), [...all].sort());
for (const bad of ["0/4", "5/4", "1", "a/b"]) assert.equal(list(bad).status, 2, `CUBE_TEST_SHARD=${bad} is refused`);

// Nothing the single check job and the macOS jobs ran is dropped.
for (const command of ["pnpm check:references", "pnpm typecheck", "pnpm lint", "pnpm test:browser", "scripts/test-offline.sh", "scripts/test-node-transport.sh", "bash -n"]) {
  assert.ok(runs(ci).includes(command), `ci.yml runs ${command}`);
}
assert.ok(runs(platforms).includes("scripts/test-node-transport.sh"));
assert.ok(runs(platforms).includes("brew audit --strict"));
const macos = Object.values(platforms.jobs).find((job) => job.name === "node-transport (macos)");
assert.equal(macos?.["runs-on"], "macos-latest");
assert.deepEqual(platforms.on.push.branches, ["main"]);
assert.ok("workflow_dispatch" in platforms.on);
for (const own of [".github/workflows/platforms.yml", ".github/actions/**", "Cargo.lock", "packages/node-transport/**", "packages/gateway/**", "scripts/homebrew/**"]) {
  assert.ok(platforms.on.pull_request.paths.includes(own), `platforms.yml runs on pull requests that touch ${own}`);
}

// The release builds only after the gate, which names the macOS job platforms.yml has.
assert.deepEqual([release.jobs.build!.needs].flat(), ["gate"]);
assert.ok(release.jobs.gate!.steps.some((step) => step.run === "bash scripts/release-gate.sh"));
assert.match(read("scripts/release-gate.sh"), /^macos_job='node-transport \(macos\)'$/m);

// Third-party actions are pinned to a commit.
const actions = [".github/actions/node-deps/action.yml", ".github/actions/rust-deps/action.yml"];
for (const file of [...fs.readdirSync(path.join(root, ".github/workflows")).map((f) => `.github/workflows/${f}`), ...actions]) {
  for (const [, uses] of read(file).matchAll(/uses:\s*(\S+)/g)) {
    assert.match(uses!, /^(\.\/\.github\/actions\/[a-z-]+|[\w.-]+\/[\w.-]+@[0-9a-f]{40})$/, `${file}: ${uses}`);
    if (uses!.startsWith("./")) assert.ok(fs.existsSync(path.join(root, uses!, "action.yml")), `${file}: ${uses}`);
  }
}
console.log("ci-test: Linux-only pull request gate, cancelled superseded runs, every suite in one shard, no check dropped, macOS on main, pinned actions");

// The release gate against a fake gh: each call takes the scenario's next answer.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-gate-"));
try {
  fs.writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const file = process.env.FAKE_GH;
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const args = process.argv.slice(2);
const key = args[1] === "list" ? args[args.indexOf("--workflow") + 1] : "jobs";
if (args[1] === "list") {
  for (const flag of ["--commit", "--event", "--repo"]) if (!args.includes(flag)) process.exit(9);
  if (args[args.indexOf("--commit") + 1] !== process.env.SHA || args[args.indexOf("--event") + 1] !== "push") process.exit(9);
}
const answers = state[key];
const answer = answers.length > 1 ? answers.shift() : answers[0];
fs.writeFileSync(file, JSON.stringify(state));
if (answer) console.log(answer);
`, { mode: 0o755 });
  const gate = (scenario: Record<string, string[]>, timeout = "5") => {
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(scenario));
    return spawnSync("bash", ["scripts/release-gate.sh"], {
      cwd: root, encoding: "utf8",
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_GH: path.join(dir, "state.json"), GITHUB_REPOSITORY: "o/r", SHA: "abc", GATE_TIMEOUT: timeout, GATE_INTERVAL: "0" },
    });
  };
  const passed = gate({ "ci.yml": ["1 completed success"], "platforms.yml": ["2 completed failure"], jobs: ["completed success"] });
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /passed ci \(run 1\) and 'node-transport \(macos\)' \(run 2\)/);
  const waited = gate({ "ci.yml": ["", "1 in_progress ", "1 completed success"], "platforms.yml": ["", "2 in_progress "], jobs: ["queued ", "completed success"] });
  assert.equal(waited.status, 0, waited.stderr);
  const ciFailed = gate({ "ci.yml": ["1 completed failure"], "platforms.yml": ["2 completed success"], jobs: ["completed success"] });
  assert.equal(ciFailed.status, 1);
  assert.match(ciFailed.stderr, /ci run 1 for abc concluded failure/);
  const macosFailed = gate({ "ci.yml": ["1 completed success"], "platforms.yml": ["2 completed failure"], jobs: ["completed failure"] });
  assert.equal(macosFailed.status, 1);
  assert.match(macosFailed.stderr, /'node-transport \(macos\)' in platforms run 2 for abc concluded failure/);
  const notOnMain = gate({ "ci.yml": [""], "platforms.yml": [""], jobs: [""] }, "0");
  assert.equal(notOnMain.status, 1);
  assert.match(notOnMain.stderr, /no finished ci run \(none \) and 'node-transport \(macos\)' \(none \) for abc on main/);
  console.log("ci-test: release gate passes a commit green on main, waits for running checks, refuses failed ci, a failed macOS job and a commit not on main");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
