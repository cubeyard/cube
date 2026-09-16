/** Monty WASM lives only in this disposable Node worker. No native addon or
 * subprocess is loaded. The parent terminates us on EVERY exit, including
 * compilation stalls and damaged WASM heaps; callbacks only send JSON IPC. */
import { parentPort, workerData } from "node:worker_threads";
import { Monty, NOT_HANDLED } from "@pydantic/monty/wasm";
import { SDK_SOURCE } from "./code-mode-sdk.ts";
import { encodeError, boundError } from "./code-errors.ts";
import type { CodeModeLimits } from "./code-mode.ts";

const port = parentPort!;
const { source, limits } = workerData as { source: string; limits: CodeModeLimits };
let finished = false;
let started = false;
let callCount = 0;
const calls = new Map<number, (reply: string) => void>();
const fail = (error: unknown) => {
  if (finished) return;
  finished = true;
  port.postMessage({ type: "error", error: boundError(encodeError(error), limits.maxCapabilityResultBytes) });
};

function json(value: unknown): string {
  const encoded = JSON.stringify(value, (_key, item) => {
    // Python dicts cross Monty's boundary as Maps. Do not silently turn them
    // into {}, coerce integer keys, or discard non-JSON numbers/containers.
    if (item instanceof Map) {
      if ([...item.keys()].some(key => typeof key !== "string")) throw new TypeError("JSON object keys must be strings");
      return Object.fromEntries(item);
    }
    if (typeof item === "number" && !Number.isFinite(item)) throw new TypeError("JSON numbers must be finite");
    if (typeof item === "number" && Number.isInteger(item) && !Number.isSafeInteger(item)) {
      throw new TypeError("JSON integer exceeds the safe range; return large numbers as strings");
    }
    if (item !== null && typeof item === "object" && !Array.isArray(item) &&
        Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new TypeError("capability arguments must be JSON-serializable");
    }
    return item;
  });
  if (encoded === undefined) throw new TypeError("value must be JSON-serializable");
  return encoded;
}

function call(operation: string, args: unknown): Promise<string> {
  if (finished) throw new Error("code execution finished");
  if (typeof operation !== "string" || operation.length > 128 ||
      !/^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(operation)) {
    throw new TypeError("capability operation must be an ASCII identifier of at most 128 bytes");
  }
  const encoded = json(args);
  if (Buffer.byteLength(encoded) > limits.maxArgumentBytes) throw new Error(`capability arguments exceed ${limits.maxArgumentBytes} bytes`);
  if (++callCount > limits.maxCalls) throw new Error(`code exceeded ${limits.maxCalls} capability calls`);
  return new Promise(resolve => {
    calls.set(callCount, resolve);
    port.postMessage({ type: "call", id: callCount, operation, encoded });
  });
}

try {
  const pool = await Monty.create({ minProcesses: 0, maxProcesses: 1 });
  const session = await pool.checkout({ limits: {
    maxMemory: limits.memoryBytes,
    maxDurationSecs: limits.cpuTimeMs / 1000,
    maxRecursionDepth: limits.recursionDepth,
    maxSuspensions: limits.maxSuspensions,
  } });
  await session.feedRun(SDK_SOURCE);
  port.on("message", (message) => {
    if (finished) return;
    if (message.type === "reply") {
      const resolve = calls.get(message.id);
      if (!resolve) return fail(new Error("unexpected capability reply"));
      calls.delete(message.id);
      resolve(message.error ? json({ ok: false, error: message.error }) : `{"ok":true,"value":${message.encoded}}`);
      return;
    }
    if (message.type !== "start" || started) return fail(new Error("invalid code parent protocol"));
    started = true;
    let output = "";
    const program = `async def __cube_main():\n${source.split("\n").map(line => "    " + line).join("\n")}\n    pass\n` +
      `try:\n    __cube_result = __cube_dumps({"ok": True, "value": await __cube_main()})\n` +
      `except Exception as __cube_exception:\n    __cube_result = __cube_dumps({"ok": False, "error": cube.error(__cube_exception)})\n` +
      `__cube_result`;
    void session.feedRun(program, {
      externalLookup: { __cubeCall: call },
      os: async (name, args, kwargs) => {
        // The only enabled OS operations are the existing text-file capabilities.
        // Never mount the credentialed host or supply a generic OS fallback.
        if (name !== "Path.read_text" && name !== "Path.write_text") return NOT_HANDLED;
        if (Object.keys(kwargs).length || args.length !== (name === "Path.read_text" ? 1 : 2) ||
            typeof args[0] !== "string" || args[0].includes("\0") ||
            (name === "Path.write_text" && typeof args[1] !== "string")) {
          throw Object.assign(new Error("only UTF-8 text paths without extra options are supported"), { name: "ValueError" });
        }
        const reply = JSON.parse(await call(name === "Path.read_text" ? "fs.readText" : "fs.writeText",
          name === "Path.read_text" ? { path: args[0] } : { path: args[0], content: args[1] }));
        if (!reply.ok) {
          const name = reply.error.code === "ENOENT" ? "FileNotFoundError"
            : ["EACCES", "EPERM"].includes(reply.error.code) ? "PermissionError" : "OSError";
          throw Object.assign(new Error("__CUBE_ERROR__" + json(reply.error)), { name });
        }
        return name === "Path.read_text" ? reply.value : Array.from(args[1] as string).length;
      },
      printCallback: (_stream, text) => {
        if (Buffer.byteLength(output) + Buffer.byteLength(text) > limits.maxResultBytes) throw new Error(`code print output exceeds ${limits.maxResultBytes} bytes`);
        output += text;
      },
    }).then((value) => {
      if (typeof value !== "string") throw new TypeError("code result must be JSON-serializable");
      const result = JSON.parse(value);
      if (!result.ok) return fail(Object.assign(new Error(result.error.message), result.error));
      // Python coroutines do not start until awaited, but raw host futures may
      // have started. Keep every dispatched call attached before success.
      if (calls.size) throw new Error("code completed with unawaited capabilities; await every call");
      const encoded = json({ present: true, value: result.value, output });
      if (Buffer.byteLength(encoded) > limits.maxResultBytes) throw new Error(`code result exceeds ${limits.maxResultBytes} bytes`);
      finished = true;
      port.postMessage({ type: "result", encoded });
    }).catch(fail);
  });
  port.postMessage({ type: "ready" });
} catch (error) { fail(error); }
