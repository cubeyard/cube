/** keel's boot check: the zombie scan ignores processes that exit while it
 * runs, a failing or interrupted check leaves none of its own processes or
 * directories behind (and touches nobody else's), and the snapshot check's
 * bounded wait for progress still fails a frozen workload. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitProgress, ZOMBIE_SCAN, zombieScan } from "./keel-boot-check-lib.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Runs a command as the boot check does: /bin/sh -c, stdout and stderr together. */
const shell = (command: string) => {
  const r = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
  return { status: r.status, output: r.stdout + r.stderr };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, test: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (test()) return;
    await sleep(50);
  }
  assert.fail(what);
}

// A process that exits between the glob and the read leaves a stat file
// that cannot be opened; the scan skips it silently (the boot check runs it
// with stderr on its output, so any error text is a false zombie). The pre-fix scan printed
// "cannot open /proc/0/stat" here.
if (existsSync("/proc/self/stat")) {
  const gone = shell(zombieScan("/proc/0/stat /proc/[0-9]*/stat"));
  assert.equal(gone.status, 0);
  assert.equal(gone.output, "");
  const before = 'for f in /proc/0/stat; do read -r s < $f 2>/dev/null; case "${s##*) }" in Z*) echo "$s";; esac; done; true';
  assert.match(shell(before).output, /cannot open \/proc\/0\/stat/, "the test sees the old defect");

  // And under processes that keep starting and exiting.
  const churn = spawn("/bin/sh", ["-c", "while :; do /bin/true; done"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 300; i++) {
      const scan = shell(ZOMBIE_SCAN);
      assert.equal(scan.status, 0);
      assert.equal(scan.output, "", `scan ${i} printed: ${scan.output}`);
    }
  } finally {
    churn.kill("SIGKILL");
  }

  // A real zombie is still reported: a parent that exec's and never reaps.
  const parent = spawn("/bin/sh", ["-c", "sleep 0 & exec sleep 5"], { stdio: "ignore" });
  try {
    let found = "";
    await until("the zombie child is reported", () => {
      found = spawnSync("/bin/sh", ["-c", ZOMBIE_SCAN], { encoding: "utf8" }).stdout;
      return found.split("\n").some((line) => / Z /.test(line) && line.includes(` ${parent.pid} `));
    });
  } finally {
    parent.kill("SIGKILL");
  }
}

// Owned: on an error and on SIGTERM, the script's own children are killed
// and its directories removed; a process it did not register lives on.
const work = mkdtempSync(join(tmpdir(), "kbc-test-"));
const script = join(work, "owner.ts");
writeFileSync(
  script,
  `import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { Owned } from ${JSON.stringify(join(import.meta.dirname, "keel-boot-check-lib.ts"))};
const owned = new Owned();
const dir = owned.dir(mkdtempSync(join(${JSON.stringify(work)}, "own-")));
const mine = owned.child(spawn("sleep", ["30"], { stdio: "ignore" }));
const other = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
other.unref();
console.log(JSON.stringify({ mine: mine.pid, other: other.pid, dir }));
if (process.argv[2] === "throw") {
  await new Promise((r) => setTimeout(r, 200));
  throw new Error("a check failed");
}
await new Promise((r) => setTimeout(r, 30000));
`,
);
try {
  for (const how of ["throw", "SIGTERM"] as const) {
    const child = spawn(process.execPath, [script, how], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    await until(`${how}: the owner started`, () => out.includes("\n"));
    const { mine, other, dir } = JSON.parse(out) as { mine: number; other: number; dir: string };
    assert.ok(alive(mine) && alive(other) && existsSync(dir));
    if (how === "SIGTERM") child.kill("SIGTERM");
    const code = await exited;
    assert.notEqual(code, 0, `${how}: the owner fails`);
    await until(`${how}: its own child is gone`, () => !alive(mine));
    assert.ok(!existsSync(dir), `${how}: its directory is gone`);
    assert.ok(alive(other), `${how}: a process it did not start is left alone`);
    process.kill(other, "SIGKILL");
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
// The progress wait after a restore (the bound that lets a late first tick
// on real KVM pass) on a virtual clock: a counter that never moves after the
// restore is returned as it was, so the check `tick >= after + 5` fails it
// (the negative control); a moving counter and one that starts late pass.
{
  const progress = async (counter: (ms: number) => number, before: number) => {
    let clock = 0;
    const after = counter(0);
    return awaitProgress(async () => counter(clock), {
      before, after, resumedAt: 0, limitMs: 5000,
      now: () => clock, sleep: async (ms) => { clock += ms; },
    }).then((r) => ({ ...r, after, clock }));
  };
  const frozen = await progress(() => 40, 40);
  assert.equal(frozen.tick, 40, "a frozen counter is returned as it was");
  assert.equal(frozen.progressMs, -1, "a frozen counter never moved");
  assert.ok(!(frozen.tick >= frozen.after + 5), "the boot check's condition fails a frozen workload");
  assert.ok(frozen.clock >= 5000 && frozen.clock < 5100, "it waited the whole bound, no longer");
  const moving = await progress((ms) => 40 + Math.floor(ms / 100), 40);
  assert.ok(moving.tick >= moving.after + 5 && moving.progressMs === 100 && moving.clock <= 600, JSON.stringify(moving));
  const late = await progress((ms) => (ms < 900 ? 40 : 40 + Math.floor((ms - 900) / 100) + 1), 40);
  assert.ok(late.tick >= late.after + 5 && late.progressMs === 900, JSON.stringify(late));
  // Frozen at the save but already past it after cont: progress at once, then stuck.
  const stuck = await progress(() => 41, 40);
  assert.ok(stuck.progressMs === 0 && !(stuck.tick >= stuck.after + 5), JSON.stringify(stuck));
}
console.log("keel boot check: zombie scan, cleanup and the frozen-counter control ok");
