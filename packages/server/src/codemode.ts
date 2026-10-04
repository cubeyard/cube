/** Pi's codemode as one pi-durable tool: model JavaScript runs in a QuickJS VM
 * (pi-codemode, a fresh worker per script) whose only capabilities are cube's
 * workspace tools. Every nested call reaches the Workspace under a key built
 * from the codemode task id and the call's sequence number, so each nested
 * call has a stable identity and a key already seen is never executed again.
 *
 * The tool is replay "unsafe": a script interrupted by a crash is reported as
 * possibly partially run, never rerun. Limits are strict and checked by the
 * host, and a call whose outcome cannot be known is reported as uncertain
 * instead of as a plain failure. The worker is a fault-containment boundary
 * for cubed, not a sandbox; the tools themselves act in the thread's VM. */
import type { Context } from "@earendil-works/chord";
import { withAbortSignal } from "@earendil-works/chord/context";
import { Type, validateToolArguments, type ToolCall } from "@earendil-works/pi-ai";
import { CodemodeSandbox, CodemodeSourceError, parseCodemodeSource, renderDeclarations, type CodemodeJsonSchema, type CodemodeResult, type CodemodeTool } from "@earendil-works/pi-codemode";
import { defineTool, type ToolDiagnostic, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";

export interface CodemodeLimits {
  /** UTF-8 bytes of the script, options line included. */
  sourceBytes: number;
  /** QuickJS heap; allocations beyond it fail in the script as out of memory. */
  memoryBytes: number;
  /** Wall deadline for the whole script, nested calls included. */
  timeoutMs: number;
  /** Nested calls per script; one more stops the script. */
  maxCalls: number;
  /** Serialized arguments of one nested call; more stops the script. */
  maxArgumentBytes: number;
  /** Text result of one nested call handed to the script; more rejects that call. */
  maxCallResultBytes: number;
  /** The final result the model sees; more is cut with a notice. */
  maxResultBytes: number;
  /** How long a stopped script waits for running nested calls to settle. */
  settleMs: number;
}

/** Modelled on cube's earlier QuickJS codemode. */
export const CODEMODE_LIMITS: Readonly<CodemodeLimits> = {
  sourceBytes: 64 * 1024,
  memoryBytes: 64 * 1024 * 1024,
  timeoutMs: 15 * 60_000,
  maxCalls: 64,
  maxArgumentBytes: 1024 * 1024,
  maxCallResultBytes: 4 * 1024 * 1024,
  maxResultBytes: 256 * 1024,
  settleMs: 10_000,
};

/** A workspace tool the script can call. `run` executes it under `key`. */
export interface NestedTool {
  registration: ToolRegistration;
  /** Whether a call that is stopped while running may have changed the workspace. */
  mutates: boolean;
  run(args: never, api: ToolExecutionApi, context: Context, key: string): Promise<ToolExecutionResult>;
}

export type NestedCallStatus = "queued" | "running" | "ok" | "error" | "not started" | "uncertain";
export type NestedCall = {
  n: number;
  name: string;
  /** The Workspace key base of this call: `<task key>:code:<n>`. */
  key: string;
  status: NestedCallStatus;
  durationMs?: number;
  error?: string;
};
export type CodemodeDetails = {
  calls: NestedCall[];
  completionUnknown: boolean;
  limit?: string;
};

const TEXT: CodemodeJsonSchema = { type: "string" };
const ERROR_CHARS = 500;

export function createCodemodeTool(options: {
  tools: readonly NestedTool[];
  /** The key of the codemode task; nested keys extend it. */
  key(api: ToolExecutionApi): string;
  limits?: Partial<CodemodeLimits>;
}): ToolRegistration<ReturnType<typeof codemodeParameters>, CodemodeDetails> {
  const limits: CodemodeLimits = { ...CODEMODE_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`invalid codemode limit ${name}`);
  }
  const declarations: Omit<CodemodeTool, "execute">[] = options.tools.map(({ registration }) => ({
    name: registration.name, description: registration.description, inputSchema: registration.parameters as CodemodeJsonSchema, outputSchema: TEXT,
  }));
  // Nested calls a stopped script left running. While any remain, their
  // outcome is unknown and a new script could race them; refuse it.
  const unsettled = new Set<Promise<unknown>>();

  return defineTool({
    name: "codemode",
    description: [
      "Run JavaScript that calls the workspace tools. The input is raw JavaScript (not JSON, no code fence), run as an async function body in a QuickJS VM: top-level `await` and `return` work. There is no Node, file system, network or timers; the only capabilities are the tools below.",
      "- `await tools.<name>({ ...args })` resolves to the tool's text result and rejects with an Error on failure. Nested calls run one at a time in call order; calls still running or queued when the script ends are stopped.",
      "- `text(value)`, `console.log(...)` and `return value` produce the result. `store`/`load` values last only for one script.",
      "- Optional first line: `// @options: {\"timeout_ms\": 60000, \"max_output_tokens\": 4000}`.",
      `- Limits: ${limits.sourceBytes / 1024} KiB source, ${limits.memoryBytes / 1024 / 1024} MiB memory, ${limits.timeoutMs / 1000} s in total, ${limits.maxCalls} nested calls, ${limits.maxArgumentBytes / 1024} KiB arguments per call, ${limits.maxCallResultBytes / 1024} KiB per call result, ${limits.maxResultBytes / 1024} KiB result.`,
      "- A call stopped while running may have partially run; the result then says its outcome is uncertain. Nothing is retried automatically.",
      "",
      renderDeclarations({ tools: declarations.map(declaration => ({ ...declaration, execute: () => undefined })) }),
    ].join("\n"),
    parameters: codemodeParameters(),
    replay: "unsafe",
    executionMode: "sequential",
    async execute(args, api, context) {
      const refuse = (text: string, extra: Partial<CodemodeDetails> = {}) => ({
        content: [{ type: "text" as const, text }], isError: true, details: { calls: [], completionUnknown: false, ...extra },
      });
      const sourceBytes = Buffer.byteLength(args.code);
      if (sourceBytes > limits.sourceBytes) return refuse(`Script not run: the source is ${sourceBytes} bytes; codemode accepts at most ${limits.sourceBytes}.`, { limit: "sourceBytes" });
      let parsed;
      try { parsed = parseCodemodeSource(args.code); }
      catch (error) {
        if (error instanceof CodemodeSourceError) return refuse(`Script not run: ${error.message}`);
        throw error;
      }
      if (unsettled.size) return refuse("Script not run: nested calls of an earlier codemode script are still running and their outcome is unknown. Inspect the workspace before retrying.", { completionUnknown: true });
      const timeoutMs = Math.min(parsed.options.timeoutMs ?? limits.timeoutMs, limits.timeoutMs);
      const resultBytes = Math.min(limits.maxResultBytes, parsed.options.maxOutputTokens === undefined ? Infinity : parsed.options.maxOutputTokens * 4);

      const base = options.key(api);
      const calls: NestedCall[] = [];
      const running = new Set<Promise<unknown>>();
      const stop = new AbortController();
      let limit: string | undefined;
      let limitMessage = "";
      const exceed = (name: keyof CodemodeLimits, message: string) => {
        if (!limit) { limit = name; limitMessage = message; }
        const error = new Error(`codemode limit: ${message}`);
        stop.abort(error);
        return error;
      };
      const outer = context.abortSignal;
      const forward = () => stop.abort(outer?.reason);
      if (outer?.aborted) forward(); else outer?.addEventListener("abort", forward, { once: true });
      let queue: Promise<unknown> = Promise.resolve();
      let published = Promise.resolve();
      const publish = () => {
        const details = { calls: calls.map(call => ({ ...call })), completionUnknown: calls.some(call => call.status === "uncertain"), ...(limit ? { limit } : {}) };
        published = published.then(() => api.details(details, context)).catch(() => {});
      };

      const nested = (tool: NestedTool) => async (input: unknown, { signal }: { signal: AbortSignal }) => {
        const n = calls.length + 1;
        if (n > limits.maxCalls) throw exceed("maxCalls", `more than ${limits.maxCalls} nested calls`);
        const argumentBytes = Buffer.byteLength(JSON.stringify(input ?? null));
        if (argumentBytes > limits.maxArgumentBytes) throw exceed("maxArgumentBytes", `call ${n} has ${argumentBytes} bytes of arguments; at most ${limits.maxArgumentBytes}`);
        const call: NestedCall = { n, name: tool.registration.name, key: `${base}:code:${n}`, status: "queued" };
        calls.push(call);
        // One nested call at a time, in call order: the sequence number is the
        // order of execution, and a later call sees an earlier call's effects.
        const turn = queue.then(() => runNested(tool, call, input, signal));
        queue = turn.catch(() => {});
        return turn;
      };
      const runNested = async (tool: NestedTool, call: NestedCall, input: unknown, signal: AbortSignal): Promise<string> => {
        if (signal.aborted) { call.status = "not started"; throw new Error("not started: the script ended first"); }
        const started = performance.now();
        call.status = "running";
        // Running output survives an interruption: the model then sees which
        // nested calls had started.
        api.output(`[codemode] call ${call.n} ${call.name} started (key ${call.key})\n`);
        publish();
        const work = (async () => {
          const prepared = tool.registration.prepareArguments ? tool.registration.prepareArguments(input) : input;
          if (typeof prepared !== "object" || prepared === null || Array.isArray(prepared)) throw new Error(`${call.name} takes one object argument`);
          const toolCall: ToolCall = { type: "toolCall", id: call.key, name: call.name, arguments: prepared as ToolCall["arguments"] };
          const validated = validateToolArguments(tool.registration, toolCall) as never;
          const diagnostics: ToolDiagnostic[] = [];
          const nestedApi: ToolExecutionApi = {
            ...api, env: undefined, output: () => {}, diagnostic: diagnostic => { diagnostics.push(diagnostic); }, details: async () => {},
          };
          const result = await tool.run(validated, nestedApi, withAbortSignal(signal, context), call.key);
          const text = render(result, diagnostics);
          if (result.isError) throw new Error(text || `${call.name} failed`);
          const bytes = Buffer.byteLength(text);
          if (bytes > limits.maxCallResultBytes) throw new Error(`${call.name} returned ${bytes} bytes; codemode hands at most ${limits.maxCallResultBytes} bytes of one call result to the script`);
          return text;
        })();
        running.add(work);
        unsettled.add(work);
        const done = () => { running.delete(work); unsettled.delete(work); };
        work.then(done, done);
        try {
          const text = await work;
          call.status = "ok";
          return text;
        } catch (error) {
          call.status = (signal.aborted && tool.mutates) || completionUnknown(error) ? "uncertain" : "error";
          call.error = preview(error instanceof Error ? error.message : String(error));
          throw error;
        } finally {
          call.durationMs = Math.round(performance.now() - started);
          publish();
        }
      };

      const sandbox = new CodemodeSandbox({
        tools: options.tools.map((tool, index) => ({ ...declarations[index]!, execute: nested(tool) })),
        timeoutMs, memoryLimitBytes: limits.memoryBytes,
      });
      let result: CodemodeResult;
      try { result = await sandbox.execute(parsed.code, { signal: stop.signal }); }
      finally {
        outer?.removeEventListener("abort", forward);
        await sandbox.close();
      }

      // pi-codemode has aborted every pending call. Give running ones a
      // bounded grace to settle; whatever does not is of unknown outcome.
      let timer: NodeJS.Timeout | undefined;
      const settled = await Promise.race([
        Promise.allSettled([...running]).then(() => true),
        new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), limits.settleMs); }),
      ]);
      clearTimeout(timer);
      for (const call of calls) {
        if (call.status === "queued") call.status = "not started";
        if (call.status === "running" && !settled) { call.status = "uncertain"; call.error = `still running ${limits.settleMs} ms after the script ended`; }
      }
      publish();
      await published;

      const uncertain = calls.filter(call => call.status === "uncertain");
      const body: string[] = [];
      if (limit) body.push(`Script stopped by the ${limit} limit: ${limitMessage}.`);
      else if (!result.ok) body.push(`Script failed (${result.error.kind}): ${result.error.message}`);
      else body.push(uncertain.length ? "Script completed, but the outcome of some nested calls is uncertain." : "Script completed.");
      const output = result.output.map(item => item.type === "text" ? item.text : `[image omitted: codemode results carry text only]`).join("\n");
      if (output) body.push(output);
      if (result.ok && result.value !== undefined) body.push(`Return value:\n${JSON.stringify(result.value)}`);
      if (!result.ok && result.error.kind === "script" && result.error.stack) body.push(`Script error:\n${result.error.stack}`);
      if (uncertain.length) {
        body.push([
          "Outcome uncertain: these nested calls were stopped or lost while running and may have partially run. Inspect the workspace before retrying; nothing is retried automatically.",
          ...uncertain.map(call => `- call ${call.n} ${call.name} (key ${call.key})${call.error ? `: ${call.error}` : ""}`),
        ].join("\n"));
      }
      const details: CodemodeDetails = { calls: calls.map(call => ({ ...call })), completionUnknown: uncertain.length > 0, ...(limit ? { limit } : {}) };
      return { content: [{ type: "text", text: bound(body.join("\n\n"), resultBytes) }], isError: !result.ok || uncertain.length > 0, details };
    },
  });
}

function codemodeParameters() {
  return Type.Object({ code: Type.String({ description: "Raw JavaScript source: the body of an async function." }) });
}

/** A nested result as the script sees it: its text, then any remarks. */
function render(result: ToolExecutionResult, diagnostics: readonly ToolDiagnostic[]): string {
  const text = (result.content ?? []).map(part => part.type === "text" ? part.text : "").join("");
  const remarks = [...diagnostics, ...(result.diagnostics ?? [])].map(each => `[${each.severity}: ${each.message}]`);
  return [text, ...remarks].filter(Boolean).join("\n");
}

/** Whether an error, or anything it wraps, says the outcome is unknown. */
export function completionUnknown(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 8; depth++) {
    if (typeof current !== "object") return false;
    if ((current as { completionUnknown?: unknown }).completionUnknown === true) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function preview(text: string): string {
  return text.length > ERROR_CHARS ? `${text.slice(0, ERROR_CHARS)}…` : text;
}

/** Cut to `bytes` UTF-8 bytes on a character boundary, with a notice. */
function bound(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  const notice = `\n[result cut at ${bytes} bytes; write large output to a workspace file and read parts of it]`;
  const room = Math.max(0, bytes - Buffer.byteLength(notice));
  return new TextDecoder().decode(Buffer.from(text).subarray(0, room)).replace(/�$/, "") + notice;
}
