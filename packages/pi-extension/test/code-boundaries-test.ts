/** Every crash regression runs in a subprocess with an external watchdog.
 * node packages/pi-extension/test/code-boundaries-test.ts */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCodeMode } from "../src/code-mode.ts";
import { createCodeCapability } from "../src/code-capabilities.ts";

const cases: Record<string, () => Promise<void>> = {
  async recursion() {
    await assert.rejects(runCodeMode({
      source: "function recurse() { return recurse(); } return recurse();", call: async () => null,
    }), /stack overflow/);
    // Even an unsafe override must not take the agent down.
    await assert.rejects(runCodeMode({
      source: "function recurse() { return recurse(); } return recurse();", call: async () => null,
      limits: { stackBytes: 1024 * 1024 },
    }), /stack|worker|Aborted/i);
  },
  async jobs() {
    await assert.rejects(runCodeMode({
      source: "for (let i=0;i<20000;i++) await Promise.resolve(); return 1;", call: async () => null,
    }), /exceeded 10000 promise jobs/);
  },
  async wall() {
    await assert.rejects(runCodeMode({
      source: "const start=Date.now(); while (Date.now()-start < 150) {} return 1;",
      call: async () => null, limits: { wallTimeMs: 20, guestSliceMs: 500 },
    }), /execution exceeded 20ms/);
    await assert.rejects(runCodeMode({
      source: "return new Promise(() => {});", call: async () => null, limits: { wallTimeMs: 20 },
    }), /execution exceeded 20ms/);
  },
  async cancellation() {
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    let first = true;
    const call = async () => {
      if (!first) return null;
      first = false;
      started();
      return new Promise<void>((resolve) => { release = resolve; });
    };
    const controller = new AbortController();
    const running = runCodeMode({
      source: "return await cube.repositories.list();", call,
      signal: controller.signal, limits: { shutdownMs: 30 },
    });
    await begun;
    controller.abort(new Error("caller stopped"));
    await assert.rejects(running, (e: any) => e.code === "ECODE_UNCERTAIN" && e.completionUnknown && /caller stopped/.test(e.message));
    await assert.rejects(runCodeMode({ source: "return 1;", call }), (e: any) => e.code === "ECODE_UNCERTAIN");
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await runCodeMode({ source: "return 2;", call })).value, 2);
    let dispatched = false;
    const aborted = AbortSignal.abort(new Error("already stopped"));
    await assert.rejects(runCodeMode({ source: "return await cube.repositories.list();", signal: aborted,
      call: async () => { dispatched = true; },
    }), /already stopped/);
    assert.equal(dispatched, false);
  },
  async observer() {
    const result = await runCodeMode({ source: "return await cube.repositories.list();", call: async () => [1],
      onTrace: () => { throw new Error("observer failed"); },
    });
    assert.deepEqual(result.value, [1]);
    await assert.rejects(runCodeMode({ source: "return await cube.repositories.list();",
      call: async () => { throw new Error("original failure"); }, onTrace: () => { throw new Error("observer failed"); },
    }), /original failure/);
  },
  async contract() {
    let active = 0, peak = 0;
    const parallel = await runCodeMode({
      source: "return await Promise.all(Array.from({length: 4}, () => cube.repositories.list()));",
      call: async () => { peak = Math.max(peak, ++active); await new Promise(r => setTimeout(r, 30)); active--; return ["æ😀\u0000"]; },
    });
    assert.equal(peak, 4);
    assert.deepEqual(parallel.value, Array.from({ length: 4 }, () => ["æ😀\u0000"]));
    const ignored = await runCodeMode({ source: 'cube.repositories.list(); return "started";', call: async () => { throw new Error("host failed"); } });
    assert.equal(ignored.value, "started");
    assert.equal(ignored.traces.at(-1)?.status, "error");
    const caught = await runCodeMode({ source: 'try { await cube.exec("test"); } catch(e) { return {code:e.code, output:e.output, timeoutMs:e.timeoutMs}; }',
      call: async () => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT", output: "partial", timeoutMs: 100 }); },
    });
    assert.deepEqual(caught.value, { code: "ETIMEDOUT", output: "partial", timeoutMs: 100 });
    await assert.rejects(runCodeMode({ source: 'return await cube.exec("test");',
      call: async () => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT", output: "partial", timeoutMs: 100 }); },
    }), (e: any) => e.code === "ETIMEDOUT" && e.output === "partial");
  },
  async validation() {
    for (const expression of ['{timeotMs: 100}', '{timeotMs: undefined}', 'null', '100', '[]']) {
      let dispatched = false;
      await assert.rejects(runCodeMode({ source: `return await cube.exec("unused", ${expression});`,
        call: async () => { dispatched = true; },
      }), /option/);
      assert.equal(dispatched, false);
    }
    // Direct bridge calls must also fail closed in the authority dispatcher.
    const host = new Proxy({}, { get() { throw new Error("must not dispatch"); } });
    const capability = createCodeCapability(host as any);
    await assert.rejects(capability("exec", { command: "unused", timeotMs: 100 }, new AbortController().signal), /unknown exec option/);
    for (const value of [NaN, Infinity, 0, -1, 1.5]) {
      await assert.rejects(runCodeMode({ source: "return 1", call: async () => null, limits: { maxJobs: value } }), /invalid code limit/);
    }
  },
};

const selected = process.argv[2];
if (selected) {
  await cases[selected]!();
  assert.equal((await runCodeMode({ source: "return 'still alive';", call: async () => null })).value, "still alive");
} else {
  for (const name of Object.keys(cases)) {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], { timeout: 15_000, encoding: "utf8", maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, `${name}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    console.log(`${name} ok: child and subsequent invocation survived`);
  }
  console.log("ALL PASS");
}
