/** The remaining local tool adapters are explicitly authorized by cubed for
 * this thread's permanent local-node binding before EVERY underlying call.
 * No retries, cached permit, or fallback when the bridge is unavailable. */
export interface LocalEnvironmentAccess {
  check(signal?: AbortSignal): Promise<void>;
  run<T>(mutation: boolean, work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

const unavailable = (cause: unknown) => Object.assign(new Error("NODE_UNAVAILABLE: environment access is unavailable; the conversation can continue", { cause }), { code: "NODE_UNAVAILABLE" });
export function createLocalEnvironmentAccess(
  config: { threadId: string; nodeId: string; cubedUrl: string },
  request: typeof fetch = fetch,
): LocalEnvironmentAccess {
  if (!config.threadId || !/^node-[a-zA-Z0-9-]+$/.test(config.nodeId)) throw new Error("invalid managed environment binding");
  const check = async (signal?: AbortSignal) => {
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await request(`${config.cubedUrl}/api/threads/${encodeURIComponent(config.threadId)}/environment-access`, {
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
      });
    } catch (error) { if (signal?.aborted) throw error; throw unavailable(error); }
    const value: unknown = await response.json();
    if (!value || typeof value !== "object") throw new Error("invalid environment access response");
    const body = value as Record<string, unknown>;
    if (!response.ok) {
      if (["NODE_UNAVAILABLE", "ENVIRONMENT_MISSING", "OPERATION_UNSUPPORTED", "COMPLETION_UNKNOWN"].includes(String(body.code))) {
        throw Object.assign(new Error(`${body.code}: ${body.error}`), { code: body.code, completionUnknown: body.completionUnknown === true });
      }
      throw new Error(`environment access refused (${response.status})`);
    }
    if (body.local !== true || body.nodeId !== config.nodeId) throw new Error("local environment adapter binding mismatch");
  };
  return {
    check,
    async run<T>(mutation: boolean, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      await check(signal);
      try { return await work(); }
      catch (error) {
        const fields = error as { code?: unknown; completionUnknown?: boolean; name?: string; unresponsive?: boolean };
        if (fields?.completionUnknown || fields?.name === "IncusTimeoutError" ||
          ["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(String(fields?.code))) {
          if (!mutation) throw unavailable(error);
          throw Object.assign(new Error("COMPLETION_UNKNOWN: environment operation may have completed; inspect its outcome before executing again", { cause: error }), { code: "COMPLETION_UNKNOWN", completionUnknown: true });
        }
        throw error;
      }
    },
  };
}
