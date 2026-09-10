/** QuickJS runs in a disposable worker. Host authority stays in this dispatcher.
 * Worker termination reclaims even damaged WASM runtimes without invoking their
 * potentially broken finalizers in the agent process. */
import { Worker } from "node:worker_threads";
import { encodeError, decodeError, boundError, type CodeErrorData } from "./code-errors.ts";
export { CODE_MODE_API } from "./code-mode-sdk.ts";

export type CodeModeCapability = (
  operation: string,
  args: unknown,
  signal: AbortSignal,
) => Promise<unknown>;

export interface CodeModeTrace {
  operation: string;
  status: "running" | "ok" | "error";
  durationMs?: number;
  error?: string;
}

export interface CodeModeLimits {
  sourceBytes: number;
  memoryBytes: number;
  stackBytes: number;
  guestSliceMs: number;
  wallTimeMs: number;
  maxCalls: number;
  maxJobs: number;
  maxArgumentBytes: number;
  maxCapabilityResultBytes: number;
  maxResultBytes: number;
  /** Grace for cooperative host cancellation, after which completion is uncertain. */
  shutdownMs: number;
}

const DEFAULT_LIMITS: CodeModeLimits = {
  sourceBytes: 64 * 1024,
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 128 * 1024,
  guestSliceMs: 2_000,
  wallTimeMs: 15 * 60_000,
  maxCalls: 64,
  maxJobs: 10_000,
  maxArgumentBytes: 1024 * 1024,
  maxCapabilityResultBytes: 4 * 1024 * 1024,
  maxResultBytes: 256 * 1024,
  shutdownMs: 10_000,
};

export interface RunCodeModeOptions {
  source: string;
  call: CodeModeCapability;
  signal?: AbortSignal;
  onTrace?: (trace: CodeModeTrace) => void;
  limits?: Partial<CodeModeLimits>;
}

export interface CodeModeResult {
  value: unknown;
  traces: CodeModeTrace[];
}

// An abort-ignoring host operation must not silently become retryable. Block
// reuse of that dispatcher until the outstanding work actually settles.
const uncertain = new WeakSet<CodeModeCapability>();

export async function runCodeMode(options: RunCodeModeOptions): Promise<CodeModeResult> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
      throw new TypeError(`invalid code limit ${key}: expected a positive bounded integer`);
    }
  }
  if (Buffer.byteLength(options.source, "utf8") > limits.sourceBytes) {
    throw new Error(`code source exceeds ${limits.sourceBytes} bytes`);
  }
  if (uncertain.has(options.call)) {
    throw Object.assign(new Error("previous code capabilities are still pending; reconcile before retrying"), {
      code: "ECODE_UNCERTAIN", completionUnknown: true,
    });
  }
  options.signal?.throwIfAborted();
  const worker = new Worker(new URL("./code-mode-worker.ts", import.meta.url), {
    workerData: { source: options.source, limits },
    // The trusted wrapper needs no credentials. Guest code still only sees QuickJS.
    env: {},
    // Do not replay the agent's preload hooks or inspector flags in the worker.
    execArgv: [],
    resourceLimits: { maxOldGenerationSizeMb: 128 },
  });
  const controller = new AbortController();
  const traces: CodeModeTrace[] = [];
  const active = new Set<Promise<void>>();
  let stopped = false;
  let completionUnknown = false;
  let cancellationError: CodeErrorData | undefined;
  let ready = false;
  let calls = 0;
  let deadline = Infinity;
  let timer: NodeJS.Timeout;
  const emit = (trace: CodeModeTrace) => {
    traces.push(trace);
    // Observers are diagnostics, not part of capability or VM correctness.
    try { void Promise.resolve(options.onTrace?.({ ...trace })).catch(() => {}); }
    catch { /* isolate observer failures */ }
  };
  let finish!: (result: CodeModeResult | Error) => void;
  // Resolve rather than reject the internal outcome: failures can occur before
  // any await (including caller abort and worker startup failure).
  const outcome = new Promise<CodeModeResult | Error>((resolve) => {
    finish = (result) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      resolve(result);
    };
  });
  const expired = () => performance.now() >= deadline;
  const timeoutError = () => new Error(`code execution exceeded ${limits.wallTimeMs}ms`);
  const abort = () => finish(decodeError(encodeError(options.signal?.reason ?? new Error("code execution aborted"))));
  options.signal?.addEventListener("abort", abort, { once: true });
  timer = setTimeout(() => finish(new Error("code worker initialization exceeded 30000ms")), 30_000);

  worker.on("error", (error) => finish(decodeError(encodeError(error))));
  worker.on("exit", (code) => finish(new Error(`code worker exited unexpectedly (${code})`)));
  worker.on("message", (message) => {
    if (stopped) return;
    if (message.type === "ready" && !ready) {
      ready = true;
      clearTimeout(timer);
      deadline = performance.now() + limits.wallTimeMs;
      timer = setTimeout(() => finish(timeoutError()), limits.wallTimeMs);
      worker.postMessage({ type: "start" });
      return;
    }
    if (expired()) return finish(timeoutError());
    if (message.type === "error") return finish(decodeError(message.error));
    if (!ready) return finish(new Error("invalid code worker protocol"));
    if (message.type === "result") {
      if (typeof message.encoded !== "string" || Buffer.byteLength(message.encoded) > limits.maxResultBytes) {
        return finish(new Error(`code result exceeds ${limits.maxResultBytes} bytes`));
      }
      try {
        const envelope = JSON.parse(message.encoded);
        if (active.size) throw new Error("code worker completed with pending capabilities");
        finish({ value: envelope.present ? envelope.value : undefined, traces });
      } catch (error) { finish(decodeError(encodeError(error))); }
      return;
    }
    if (message.type !== "call") return finish(new Error("invalid code worker protocol"));
    const { operation, encoded, id } = message;
    // Validate again on the authority side before dispatch/trace allocation.
    if (typeof operation !== "string" || operation.length > 128 ||
        !/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(operation) ||
        typeof encoded !== "string" || Buffer.byteLength(encoded) > limits.maxArgumentBytes ||
        !Number.isSafeInteger(id) || ++calls > limits.maxCalls) {
      return finish(new Error("invalid or excessive code capability call"));
    }
    let args: unknown;
    try { args = JSON.parse(encoded); }
    catch { return finish(new Error("capability arguments are not valid JSON")); }
    const started = performance.now();
    emit({ operation, status: "running" });
    const pending = (async () => {
      let traced = false;
      const cancelled = () => {
        if (traced) return;
        traced = true;
        emit({ operation, status: "error", durationMs: performance.now() - started,
          error: "capability cancelled; completion pending until host settles" });
      };
      controller.signal.addEventListener("abort", cancelled, { once: true });
      try {
        controller.signal.throwIfAborted();
        if (expired()) throw timeoutError();
        const value = await options.call(operation, args, controller.signal);
        if (stopped) return;
        const result = JSON.stringify(value === undefined ? null : value);
        if (result === undefined) throw new TypeError("capability result must be JSON-serializable");
        if (Buffer.byteLength(result) > limits.maxCapabilityResultBytes) {
          throw new Error(`capability result exceeds ${limits.maxCapabilityResultBytes} bytes`);
        }
        traced = true;
        emit({ operation, status: "ok", durationMs: performance.now() - started });
        worker.postMessage({ type: "reply", id, encoded: result });
      } catch (error) {
        const data = encodeError(error);
        completionUnknown ||= stopped && data.completionUnknown === true;
        if (stopped && data.output !== undefined && !cancellationError) cancellationError = data;
        if (!traced) emit({ operation, status: "error", durationMs: performance.now() - started, error: data.message });
        if (!stopped) {
          const bounded = boundError(data, limits.maxCapabilityResultBytes);
          if (Buffer.byteLength(JSON.stringify(bounded)) > limits.maxCapabilityResultBytes) {
            finish(new Error(`capability error exceeds ${limits.maxCapabilityResultBytes} bytes`));
          } else worker.postMessage({ type: "reply", id, error: bounded });
        }
      } finally {
        controller.signal.removeEventListener("abort", cancelled);
      }
    })().catch((error) => finish(decodeError(encodeError(error)))).finally(() => active.delete(pending));
    active.add(pending);
  });

  const result = await outcome;
  options.signal?.removeEventListener("abort", abort);
  controller.abort(result instanceof Error ? result : new Error("code execution finished"));
  // Terminate the worker rather than asking a possibly damaged WASM VM to
  // pump shutdown jobs or run finalizers. No guest job budget is needed here.
  await worker.terminate();
  let drainTimer: NodeJS.Timeout | undefined;
  const drained = Promise.allSettled([...active]);
  const settled = await Promise.race([
    drained.then(() => true),
    new Promise<false>((resolve) => { drainTimer = setTimeout(() => resolve(false), limits.shutdownMs); }),
  ]);
  clearTimeout(drainTimer);
  if (!settled) {
    uncertain.add(options.call);
    void drained.then(() => uncertain.delete(options.call));
    throw Object.assign(new Error(`${result instanceof Error ? result.message + "; " : ""}host cancellation did not settle within ${limits.shutdownMs}ms; completion unknown, reconcile before retrying`), {
      code: "ECODE_UNCERTAIN", completionUnknown: true, traces,
    });
  }
  if (completionUnknown) {
    const message = `${result instanceof Error ? result.message + "; " : ""}remote operation completion unknown; reconcile before retrying`;
    throw Object.assign(new Error(message), cancellationError, {
      message, code: "ECODE_UNCERTAIN", completionUnknown: true, traces,
    });
  }
  if (result instanceof Error) {
    const message = result.message;
    throw Object.assign(result, cancellationError, { message, traces });
  }
  return result;
}
