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
      source: "def recurse():\n    return recurse()\nreturn recurse()", call: async () => null,
    }), /recursion/i);
    // Even an unsafe override must not take the agent down.
    await assert.rejects(runCodeMode({
      source: "def recurse():\n    return recurse()\nreturn recurse()", call: async () => null,
      limits: { recursionDepth: 10000 },
    }), /recursion|stack|worker|Aborted|memory/i);
  },
  async suspensions() {
    await assert.rejects(runCodeMode({
      source: "for i in range(50):\n    await cube.repositories.list()\nreturn 1", call: async () => null,
      limits: { maxSuspensions: 10 },
    }), /suspension/i);
  },
  async wall() {
    await assert.rejects(runCodeMode({
      source: "while True:\n    pass",
      call: async () => null, limits: { wallTimeMs: 20, cpuTimeMs: 500 },
    }), /execution exceeded 20ms/);
    await assert.rejects(runCodeMode({
      source: "return await cube.services.ensure()", call: async (_op, _args, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
      limits: { wallTimeMs: 20 },
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
    const capabilityScope = {};
    const running = runCodeMode({
      source: "return await cube.repositories.list();", call,
      capabilityScope, signal: controller.signal, limits: { shutdownMs: 30 },
    });
    await begun;
    controller.abort(new Error("caller stopped"));
    await assert.rejects(running, (e: any) => e.code === "ECODE_UNCERTAIN" && e.completionUnknown && /caller stopped/.test(e.message));
    await assert.rejects(runCodeMode({ source: "return 1;", call: async () => null, capabilityScope }),
      (e: any) => e.code === "ECODE_UNCERTAIN");
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await runCodeMode({ source: "return 2;", call, capabilityScope })).value, 2);
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
      source: "import asyncio\nreturn await asyncio.gather(*[cube.repositories.list() for i in range(4)])",
      call: async () => { peak = Math.max(peak, ++active); await new Promise(r => setTimeout(r, 30)); active--; return ["æ😀\u0000"]; },
    });
    assert.equal(peak, 4);
    assert.deepEqual(parallel.value, Array.from({ length: 4 }, () => ["æ😀\u0000"]));
    const ignored = await runCodeMode({ source: 'cube.repositories.list(); return "not started";', call: async () => { throw new Error("host failed"); } });
    assert.equal(ignored.value, "not started");
    assert.deepEqual(ignored.traces, []);
    const caught = await runCodeMode({ source: 'try:\n    await cube.exec("test")\nexcept RuntimeError as e:\n    data = cube.error(e)\n    return {key: data[key] for key in ["code", "output", "timeoutMs"]}',
      call: async () => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT", output: "partial", timeoutMs: 100 }); },
    });
    assert.deepEqual(caught.value, { code: "ETIMEDOUT", output: "partial", timeoutMs: 100 });
    await assert.rejects(runCodeMode({ source: 'return await cube.exec("test");',
      call: async () => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT", output: "partial", timeoutMs: 100 }); },
    }), (e: any) => e.code === "ETIMEDOUT" && e.output === "partial");
  },
  async validation() {
    for (const expression of ['timeotMs=100', 'timeotMs=None', '**None', '**100', '**[]']) {
      let dispatched = false;
      await assert.rejects(runCodeMode({ source: `return await cube.exec("unused", ${expression});`,
        call: async () => { dispatched = true; },
      }), /option|mapping|keyword|dict/i);
      assert.equal(dispatched, false);
    }
    // Direct bridge calls must also fail closed in the authority dispatcher.
    const host = new Proxy({}, { get() { throw new Error("must not dispatch"); } });
    const capability = createCodeCapability(host as any, async () => false, async () => false);
    await assert.rejects(capability("exec", { command: "unused", timeotMs: 100 }, new AbortController().signal), /unknown exec option/);
    for (const value of [NaN, Infinity, 0, -1, 1.5]) {
      await assert.rejects(runCodeMode({ source: "return 1", call: async () => null, limits: { maxSuspensions: value } }), /invalid code limit/);
    }
  },
  async os() {
    // Unknown OS operations and unsupported pathlib signatures must never
    // reach a host capability (nor silently fall back to the host filesystem).
    for (const expression of ['open("/etc/passwd").read()', 'Path("x").exists()',
      'Path("x").read_bytes()', 'Path("x").read_text(encoding="latin-1")',
      'Path("x").write_text("x", encoding="latin-1")', 'os.getenv("PATH")']) {
      let dispatched = false;
      await assert.rejects(runCodeMode({ source: `from pathlib import Path\nimport os\nreturn ${expression}`,
        call: async () => { dispatched = true; },
      }), /denied|argument|supported/i);
      assert.equal(dispatched, false);
    }
    for (const module of ["subprocess", "socket", "ctypes"]) {
      await assert.rejects(runCodeMode({ source: `import ${module}`, call: async () => null }), /module|import/i);
    }
    for (const [code, exception] of [["ENOENT", "FileNotFoundError"], ["EACCES", "PermissionError"]]) {
      const result = await runCodeMode({ source: `from pathlib import Path\ntry:\n    Path("missing").read_text()\nexcept ${exception} as e:\n    return cube.error(e)`,
        call: async () => { throw Object.assign(new Error("guest file failed"), { code, path: "missing" }); },
      });
      assert.deepEqual(result.value, { message: "guest file failed", code, path: "missing" });
    }
    let write = false;
    const controller = new AbortController();
    await assert.rejects(runCodeMode({
      source: 'from pathlib import Path\ntry:\n    Path("slow").read_text()\nexcept Exception:\n    Path("late").write_text("no")',
      signal: controller.signal,
      call: async (operation, _args, signal) => {
        if (operation === "fs.writeText") { write = true; return null; }
        setTimeout(() => controller.abort(new Error("file stopped")), 10);
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      },
    }), /file stopped/);
    assert.equal(write, false);
  },
  async json() {
    let dispatched = false;
    for (const args of ['{1: "not a JSON key"}', '{"n": float("nan")}']) {
      await assert.rejects(runCodeMode({ source: `return await __cubeCall("exec", ${args})`,
        call: async () => { dispatched = true; },
      }), /JSON/);
    }
    await assert.rejects(runCodeMode({ source: 'return await cube.exec("x" * 100)',
      call: async () => { dispatched = true; }, limits: { maxArgumentBytes: 20 },
    }), /arguments exceed/);
    assert.equal(dispatched, false);
    const printed = await runCodeMode({ source: 'print("æ😀")\nreturn {"nested": [True, None, {"x": 3}]}', call: async () => null });
    assert.equal(printed.output, "æ😀\n");
    assert.deepEqual(printed.value, { nested: [true, null, { x: 3 }] });
    assert.equal((await runCodeMode({ source: "return 9007199254740991", call: async () => null })).value, 9007199254740991);
    await assert.rejects(runCodeMode({ source: "return 9007199254740993", call: async () => null }), /safe range/);
    await assert.rejects(runCodeMode({ source: 'print("x" * 100)', call: async () => null,
      limits: { maxResultBytes: 20 },
    }), /print output exceeds/);
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
