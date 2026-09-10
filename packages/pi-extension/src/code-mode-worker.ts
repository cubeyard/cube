/** Trusted worker wrapper. Never execute model source with Node eval/import.
 * Only QuickJS evaluates it. The parent always terminates this worker, reclaiming
 * its WASM heap even when stack exhaustion has damaged runtime finalizers. */
import { parentPort, workerData } from "node:worker_threads";
import { newQuickJSWASMModule, RELEASE_SYNC, type QuickJSDeferredPromise, type QuickJSHandle } from "quickjs-emscripten";
import { SDK_SOURCE } from "./code-mode-sdk.ts";
import { encodeError, boundError } from "./code-errors.ts";
import type { CodeModeLimits } from "./code-mode.ts";

const port = parentPort!;
const { source, limits } = workerData as { source: string; limits: CodeModeLimits };
let finished = false;
const fail = (error: unknown) => {
  if (finished) return;
  finished = true;
  port.postMessage({ type: "error", error: boundError(encodeError(error), limits.maxCapabilityResultBytes) });
};

try {
  const module = await newQuickJSWASMModule(RELEASE_SYNC);
  const vm = module.newContext();
  const runtime = vm.runtime;
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  let deadline = Infinity;
  let sliceDeadline = Infinity;
  runtime.setInterruptHandler(() => performance.now() >= Math.min(deadline, sliceDeadline));
  const checkTime = () => {
    if (performance.now() >= deadline) throw new Error(`code execution exceeded ${limits.wallTimeMs}ms`);
  };
  const slice = () => { checkTime(); sliceDeadline = performance.now() + limits.guestSliceMs; };
  const calls = new Map<number, QuickJSDeferredPromise>();
  let callCount = 0;
  let jobCount = 0;
  let promise: QuickJSHandle | undefined;
  let encodedResult: string | undefined;
  let scheduled = false;
  const schedule = () => {
    if (scheduled || finished) return;
    scheduled = true;
    setImmediate(() => {
      scheduled = false;
      if (finished) return;
      try {
        checkTime();
        if (runtime.hasPendingJob()) {
          const remaining = limits.maxJobs - jobCount;
          if (remaining <= 0) throw new Error(`code exceeded ${limits.maxJobs} promise jobs`);
          // Preserve the CPU slice across batches; yielding is not a new budget.
          jobCount += vm.unwrapResult(runtime.executePendingJobs(Math.min(remaining, 256)));
          checkTime();
        }
        if (promise && encodedResult === undefined) {
          const state = vm.getPromiseState(promise);
          if (state.type !== "pending") {
            const handle = vm.unwrapResult(state);
            try { encodedResult = vm.getString(handle); } finally { handle.dispose(); }
            if (Buffer.byteLength(encodedResult) > limits.maxResultBytes) {
              throw new Error(`code result exceeds ${limits.maxResultBytes} bytes`);
            }
          }
        }
        if (runtime.hasPendingJob()) return schedule();
        // Drain unawaited capabilities and their continuations before success.
        if (encodedResult !== undefined && calls.size === 0) {
          checkTime();
          finished = true;
          port.postMessage({ type: "result", encoded: encodedResult });
        }
      } catch (error) { fail(error); }
    });
  };
  const bridge = vm.newFunction("__cubeCall", (operationHandle, argsHandle) => {
    checkTime();
    if (vm.typeof(operationHandle) !== "string" || vm.typeof(argsHandle) !== "string") {
      throw new TypeError("capability call requires an operation and JSON argument string");
    }
    const operation = vm.getString(operationHandle);
    if (operation.length > 128 || !/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(operation)) {
      throw new TypeError("capability operation must be an ASCII identifier of at most 128 bytes");
    }
    if (++callCount > limits.maxCalls) throw new Error(`code exceeded ${limits.maxCalls} capability calls`);
    const encoded = vm.getString(argsHandle);
    if (Buffer.byteLength(encoded) > limits.maxArgumentBytes) {
      throw new Error(`capability arguments exceed ${limits.maxArgumentBytes} bytes`);
    }
    // Do not allocate a pending promise for malformed direct bridge calls.
    try { JSON.parse(encoded); } catch { throw new TypeError("capability arguments are not valid JSON"); }
    const deferred = vm.newPromise();
    calls.set(callCount, deferred);
    port.postMessage({ type: "call", id: callCount, operation, encoded });
    return deferred.handle;
  });
  vm.setProp(vm.global, "__cubeCall", bridge);
  bridge.dispose();
  port.on("message", (message) => {
    if (finished) return;
    try {
      if (message.type === "start" && !promise) {
        deadline = performance.now() + limits.wallTimeMs;
        slice();
        promise = vm.unwrapResult(vm.evalCode(
          `(async () => {\n"use strict";\n${SDK_SOURCE}\n` +
          `const __result = await (async () => {\n${source}\n})();\n` +
          `if (__result === undefined) return '{"present":false}';\n` +
          `const __encoded = __jsonStringify(__result);\n` +
          `if (__encoded === undefined) throw new TypeError("code result must be JSON-serializable");\n` +
          `return '{"present":true,"value":' + __encoded + '}';\n})()`,
          "cube-code.js", { type: "global", strict: true },
        ));
      } else if (message.type === "reply") {
        checkTime();
        const deferred = calls.get(message.id);
        if (!deferred) throw new Error("unexpected capability reply");
        slice();
        // Transport JSON strings only. QuickJS's C-string newString API cuts
        // embedded NULs, so constructing error.output as a raw string loses data.
        const encoded = message.error ? JSON.stringify({ ok: false, error: message.error })
          : '{"ok":true,"value":' + message.encoded + '}';
        const handle = vm.newString(encoded);
        try { deferred.resolve(handle); } finally { handle.dispose(); }
        deferred.dispose();
        calls.delete(message.id);
      } else throw new Error("invalid code parent protocol");
      schedule();
    } catch (error) { fail(error); }
  });
  port.postMessage({ type: "ready" });
} catch (error) { fail(error); }
