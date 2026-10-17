/** keel's boot check: the zombie scan ignores processes that exit while it
 * runs, a failing or interrupted check leaves none of its own processes or
 * directories behind (and touches nobody else's), and the snapshot check's
 * bounded wait for progress still fails a frozen workload. */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

// A stat line is "pid (comm) state ppid ..."; comm may hold ") ", so the
// state follows the last one. Returns the zombie a scan line describes, or
// undefined for anything that is not a zombie stat line.
const zombie = (line: string) => {
  const end = line.lastIndexOf(") ");
  const head = /^(\d+) \((.*)$/s.exec(line.slice(0, end));
  const ppid = /^Z (\d+) /.exec(line.slice(end + 2))?.[1];
  return end > 0 && head && ppid ? { pid: Number(head[1]), comm: head[2], ppid: Number(ppid) } : undefined;
};
const lines = (output: string) => output.split("\n").filter((line) => line !== "");
assert.equal(zombie("cannot open /proc/0/stat"), undefined, "error text is not a zombie stat line");
assert.equal(zombie("1 (init) S 0 1 1"), undefined, "a running process is not a zombie");
assert.equal(zombie("7 (x) Z 9 ) S 1 7 7"), undefined, "the state follows the last ') '");
assert.deepEqual(zombie("7 (a) Z b) Z 9 7 7"), { pid: 7, comm: "a) Z b", ppid: 9 });

// A process that exits between the glob and the read leaves a stat file
// that cannot be opened; the scan skips it silently (the boot check runs it
// with stderr on its output, so any error text is a false zombie). The pre-fix scan printed
// "cannot open /proc/0/stat" here.
if (existsSync("/proc/self/stat")) {
  const gone = shell(zombieScan("/proc/0/stat /proc/self/stat"));
  assert.equal(gone.status, 0);
  assert.equal(gone.output, "");
  const before = 'for f in /proc/0/stat; do read -r s < $f 2>/dev/null; case "${s##*) }" in Z*) echo "$s";; esac; done; true';
  assert.match(shell(before).output, /cannot open \/proc\/0\/stat/, "the test sees the old defect");

  // And under processes that keep starting and exiting, over the whole host.
  // Every line must be a zombie stat line; a zombie is the kernel's own
  // report whoever owns it (a CI runner's systemd-timedated once, a
  // /bin/true of the churn before its wait), so it is logged, not failed.
  const churn = spawn("/bin/sh", ["-c", "while :; do /bin/true; done"], { stdio: "ignore" });
  try {
    for (let i = 0; i < 300; i++) {
      const scan = shell(ZOMBIE_SCAN);
      assert.equal(scan.status, 0, `scan ${i} failed: ${scan.output}`);
      for (const line of lines(scan.output)) {
        const z = zombie(line);
        assert.ok(z, `scan ${i} printed a line that is not a zombie stat line: ${JSON.stringify(line)}`);
        console.log(`keel boot check test: scan ${i} zombie pid ${z.pid} ppid ${z.ppid} comm ${JSON.stringify(z.comm)}${z.ppid === churn.pid ? " (churn)" : ""}`);
      }
    }
  } finally {
    churn.kill("SIGKILL");
  }

  // A real zombie is still reported: a parent that exec's and never reaps.
  const parent = spawn("/bin/sh", ["-c", "sleep 0 & exec sleep 5"], { stdio: "ignore" });
  try {
    await until("the zombie child is reported", () => {
      const scan = shell(ZOMBIE_SCAN);
      assert.equal(scan.status, 0, scan.output);
      return lines(scan.output).some((line) => {
        const z = zombie(line);
        assert.ok(z, `not a zombie stat line: ${JSON.stringify(line)}`);
        return z.ppid === parent.pid && z.pid !== parent.pid;
      });
    });
  } finally {
    parent.kill("SIGKILL");
  }

  // A running process whose name holds ") Z " is not reported: its stat
  // line reads "<pid> (x) Z y) S ...", and the state follows the last paren.
  const odd = mkdtempSync(join(tmpdir(), "kbc-comm-"));
  try {
    const exe = join(odd, "x) Z y");
    copyFileSync("/bin/sleep", exe);
    chmodSync(exe, 0o755);
    const named = spawn(exe, ["30"], { stdio: "ignore", argv0: "sleep" });
    const started = await new Promise<string | undefined>((r) => {
      named.once("spawn", () => r(undefined));
      named.once("error", (e) => r(e.message));
    });
    if (started) console.log(`SKIP: a process named "x) Z y" did not start: ${started}`);
    else {
      try {
        const stat = `/proc/${named.pid}/stat`;
        let line = "";
        await until("the named process sleeps under its name", () => {
          line = shell(`cat ${stat}`).output;
          return line.startsWith(`${named.pid} (x) Z y) S `);
        });
        assert.equal(zombie(line.trim()), undefined);
        const scan = shell(zombieScan(stat));
        assert.equal(scan.status, 0);
        assert.equal(scan.output, "", `a running process with ") Z " in its name was reported: ${scan.output}`);
      } finally {
        named.kill("SIGKILL");
        await until("the named process is gone", () => named.exitCode !== null || named.signalCode !== null);
      }
    }
  } finally {
    rmSync(odd, { recursive: true, force: true });
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
