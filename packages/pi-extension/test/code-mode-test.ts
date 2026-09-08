/** Offline security/behavior tests for QuickJS code mode. No Incus, cubed,
 * credentials, or model are required.
 *
 *   node packages/pi-extension/test/code-mode-test.ts
 */
import assert from "node:assert";

import { createCodeCapability, type CodeCapabilityHost } from "../src/code-capabilities.ts";
import { runCodeMode } from "../src/code-mode.ts";

const files = new Map<string, string>();
const hostCalls: Array<{ operation: string; value?: unknown }> = [];
const host: CodeCapabilityHost = {
  async exec(input) {
    hostCalls.push({ operation: "exec", value: input });
    return { exitCode: 0, output: `ran: ${input.command}` };
  },
  async readText(path) {
    hostCalls.push({ operation: "readText", value: path });
    return files.get(path) ?? "";
  },
  async writeText(path, content) {
    hostCalls.push({ operation: "writeText", value: { path, content } });
    files.set(path, content);
  },
  async listRepositories() {
    hostCalls.push({ operation: "listRepositories" });
    return [
      { id: 7, role: "primary", path: "/workspace", base: "main" },
      { id: 8, role: "additional", path: "/repos/docs", base: "main" },
    ];
  },
  async syncBase(repositoryId) {
    hostCalls.push({ operation: "syncBase", value: repositoryId });
    return { base: "main", oid: "abc123" };
  },
  async pushBranch(repositoryId) {
    hostCalls.push({ operation: "pushBranch", value: repositoryId });
    return { branch: "cube-work" };
  },
  async pushBase(repositoryId) {
    hostCalls.push({ operation: "pushBase", value: repositoryId });
    return { branch: "cube-work", base: "main" };
  },
  async createPr(repositoryId, options) {
    hostCalls.push({ operation: "createPr", value: { repositoryId, options } });
    return { url: "https://github.com/example/repo/pull/1", branch: "cube-work" };
  },
  async ensureServices() {
    hostCalls.push({ operation: "ensureServices" });
    return [{ name: "web", state: "running", url: "https://web.example" }];
  },
  async archiveThread() {
    hostCalls.push({ operation: "archiveThread" });
    return { ok: true };
  },
};
const capability = createCodeCapability(host);

// ---- 1. Plain JavaScript and JSON result ---------------------------------

const plain = await runCodeMode({
  source: `
    const values = [1, 2, 3, 4];
    return { sum: values.reduce((sum, value) => sum + value, 0) };
  `,
  call: capability,
});
assert.deepEqual(plain.value, { sum: 10 });
assert.deepEqual(plain.traces, []);
console.log("1 ok: plain QuickJS execution + JSON result");

const tamperedJson = await runCodeMode({
  source: `
    JSON.stringify = () => "corrupted";
    JSON.parse = () => ({ corrupted: true });
    return { repositories: await cube.repositories.list() };
  `,
  call: capability,
});
assert.equal((tamperedJson.value as { repositories: unknown[] }).repositories.length, 2);
console.log("1b ok: captured bridge serialization cannot be replaced by guest code");

// ---- 2. No ambient Node/browser authority --------------------------------

const ambient = await runCodeMode({
  source: `
    return {
      process: typeof process,
      require: typeof require,
      fetch: typeof fetch,
      window: typeof window,
      document: typeof document,
    };
  `,
  call: capability,
});
assert.deepEqual(ambient.value, {
  process: "undefined",
  require: "undefined",
  fetch: "undefined",
  window: "undefined",
  document: "undefined",
});
console.log("2 ok: process/require/fetch/DOM absent");

// ---- 3. Async capabilities, filtering, and trace -------------------------

hostCalls.length = 0;
const workflow = await runCodeMode({
  source: `
    const repository = await cube.repositories.primary();
    const command = await cube.exec("printf tested", { cwd: repository.path, timeoutMs: 5000 });
    const pushed = await cube.git.pushBase(repository.id);
    return { repository: repository.id, command, pushed };
  `,
  call: capability,
});
assert.deepEqual(workflow.value, {
  repository: 7,
  command: { exitCode: 0, output: "ran: printf tested" },
  pushed: { branch: "cube-work", base: "main" },
});
assert.deepEqual(hostCalls.map((call) => call.operation), ["listRepositories", "exec", "pushBase"]);
assert.deepEqual(
  workflow.traces.filter((trace) => trace.status === "ok").map((trace) => trace.operation),
  ["repositories.list", "exec", "git.pushBase"],
);
console.log("3 ok: async workflow + capability trace");

// ---- 4. Files and other first-slice capabilities -------------------------

hostCalls.length = 0;
const capabilities = await runCodeMode({
  source: `
    await cube.fs.writeText("notes/result.txt", "hello");
    const text = await cube.fs.readText("notes/result.txt");
    const services = await cube.services.ensure();
    const pr = await cube.git.createPr(7, { title: "Code mode", body: "tested" });
    return { text, services, pr };
  `,
  call: capability,
});
assert.equal((capabilities.value as { text: string }).text, "hello");
assert.deepEqual(hostCalls.map((call) => call.operation), ["writeText", "readText", "ensureServices", "createPr"]);
console.log("4 ok: file/service/PR capabilities dispatch");

// ---- 5. Dispatcher validation is fail-closed -----------------------------

const never = new AbortController().signal;
await assert.rejects(() => capability("host.fetch", {}, never), /unknown code capability/);
await assert.rejects(() => capability("git.pushBase", { repositoryId: "7" }, never), /positive integer/);
await assert.rejects(
  () => capability("exec", { command: "true", timeoutMs: 600_001 }, never),
  /timeoutMs must be an integer/,
);
console.log("5 ok: unknown and malformed capabilities rejected");

let invalidOperationDispatched = false;
const invalidOperationTraces: unknown[] = [];
await assert.rejects(
  () => runCodeMode({
    source: `return await __cubeCall("${"x".repeat(129)}", "{}");`,
    call: async () => {
      invalidOperationDispatched = true;
      return null;
    },
    onTrace: (trace) => invalidOperationTraces.push(trace),
  }),
  /ASCII identifier.*128 bytes/,
);
assert.equal(invalidOperationDispatched, false);
assert.deepEqual(invalidOperationTraces, []);
console.log("5b ok: direct bridge calls cannot inject unbounded operation names into traces");

// ---- 6. Host failures reject guest promises without leaking stacks -------

const failedTraces: string[] = [];
await assert.rejects(
  () => runCodeMode({
    source: `return await cube.git.pushBase(7);`,
    call: async () => {
      throw new Error("push denied");
    },
    onTrace: (trace) => failedTraces.push(`${trace.status}:${trace.operation}`),
  }),
  /push denied/,
);
assert.deepEqual(failedTraces, ["running:git.pushBase", "error:git.pushBase"]);
console.log("6 ok: host failures become bounded guest errors");

// ---- 7. Resource, call-count, source, and result limits ------------------

await assert.rejects(
  () => runCodeMode({
    source: "while (true) {}",
    call: capability,
    limits: { guestSliceMs: 20 },
  }),
  /interrupted/,
);
await assert.rejects(
  () => runCodeMode({
    source: `return "x".repeat(8 * 1024 * 1024);`,
    call: capability,
    limits: { memoryBytes: 4 * 1024 * 1024 },
  }),
  /out of memory/,
);
await assert.rejects(
  () => runCodeMode({
    source: `const recurse = () => recurse(); recurse();`,
    call: capability,
    limits: { stackBytes: 128 * 1024 },
  }),
  /stack overflow/,
);
await assert.rejects(
  () => runCodeMode({
    source: `return await cube.repositories.list();`,
    call: async (_operation, _args, signal) =>
      new Promise((_resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }),
    limits: { wallTimeMs: 100 },
  }),
  /execution exceeded 100ms/,
);
await assert.rejects(
  () => runCodeMode({
    source: `
      await cube.repositories.list();
      await cube.repositories.list();
      return await cube.repositories.list();
    `,
    call: capability,
    limits: { maxCalls: 2 },
  }),
  /exceeded 2 capability calls/,
);
await assert.rejects(
  () => runCodeMode({ source: "x".repeat(20), call: capability, limits: { sourceBytes: 10 } }),
  /source exceeds 10 bytes/,
);
await assert.rejects(
  () => runCodeMode({ source: `return "x".repeat(100);`, call: capability, limits: { maxResultBytes: 20 } }),
  /result exceeds 20 bytes/,
);
await assert.rejects(
  () => runCodeMode({ source: `return () => "not JSON";`, call: capability }),
  /result must be JSON-serializable/,
);
const serializationTraces: string[] = [];
await assert.rejects(
  () => runCodeMode({
    source: `return await cube.repositories.list();`,
    call: async () => () => "not JSON",
    onTrace: (trace) => serializationTraces.push(`${trace.status}:${trace.operation}`),
  }),
  /result must be JSON-serializable/,
);
assert.deepEqual(serializationTraces, ["running:repositories.list", "error:repositories.list"]);
console.log("7 ok: CPU/memory/stack/wall/call/source/result limits enforced");

// ---- 8. Every exit path cancels and drains host work before disposal -----

const waitsForAbort = (onAbort: () => void) =>
  async (_operation: string, _args: unknown, signal: AbortSignal): Promise<never> =>
    new Promise((_resolve, reject) => {
      const aborted = () => {
        onAbort();
        reject(signal.reason);
      };
      if (signal.aborted) aborted();
      else signal.addEventListener("abort", aborted, { once: true });
    });

let guestErrorCallCancelled = false;
await assert.rejects(
  () => runCodeMode({
    source: `cube.services.ensure(); throw new Error("guest failed");`,
    call: waitsForAbort(() => (guestErrorCallCancelled = true)),
  }),
  /guest failed/,
);
assert.equal(guestErrorCallCancelled, true);

let callerAbortCallCancelled = false;
const caller = new AbortController();
const callerRun = runCodeMode({
  source: `return await cube.services.ensure();`,
  call: waitsForAbort(() => (callerAbortCallCancelled = true)),
  signal: caller.signal,
});
setTimeout(() => caller.abort(new Error("caller stopped")), 20);
await assert.rejects(callerRun, /caller stopped/);
assert.equal(callerAbortCallCancelled, true);

let wallCallCancelled = false;
await assert.rejects(
  () => runCodeMode({
    source: `return await cube.services.ensure();`,
    call: waitsForAbort(() => (wallCallCancelled = true)),
    limits: { wallTimeMs: 20 },
  }),
  /execution exceeded 20ms/,
);
assert.equal(wallCallCancelled, true);

// Repeated failure/teardown cycles must not retain dead QuickJS callbacks.
for (let i = 0; i < 5; i++) {
  await assert.rejects(
    () => runCodeMode({
      source: `cube.services.ensure(); throw new Error("cycle ${i}");`,
      call: waitsForAbort(() => {}),
    }),
    new RegExp(`cycle ${i}`),
  );
}
const afterFailures = await runCodeMode({ source: `return "still alive";`, call: capability });
assert.equal(afterFailures.value, "still alive");
console.log("8 ok: guest error/caller abort/wall timeout cancel and drain host work");

// ---- 9. Successful unawaited calls stay attached to the invocation -------

let detachedFinished = false;
const detached = await runCodeMode({
  source: `
    cube.services.ensure();
    return "started";
  `,
  call: async (operation) => {
    assert.equal(operation, "services.ensure");
    await new Promise((resolve) => setTimeout(resolve, 20));
    detachedFinished = true;
    return [];
  },
});
assert.equal(detached.value, "started");
assert.equal(detachedFinished, true, "runner waited for the unawaited capability");
console.log("9 ok: unawaited host work is drained before disposal");

console.log("ALL PASS");
