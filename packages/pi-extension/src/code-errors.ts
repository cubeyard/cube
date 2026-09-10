/** Deliberately bounded, allowlisted error data; never transfer host stacks. */
export interface CodeErrorData {
  message: string;
  code?: string;
  operation?: string;
  path?: string;
  timeoutMs?: number;
  durationMs?: number;
  output?: string;
  outputBytes?: number;
  outputLimitBytes?: number;
  truncated?: boolean;
  completionUnknown?: boolean;
}

export function encodeError(error: unknown): CodeErrorData {
  const data: CodeErrorData = { message: (error instanceof Error ? error.message : String(error)).slice(0, 2000) };
  if (!error || typeof error !== "object") return data;
  const fields = error as Record<string, unknown>;
  for (const key of ["code", "operation", "path", "output"] as const) {
    if (typeof fields[key] === "string") data[key] = fields[key].slice(0, key === "output" ? 1024 * 1024 : 4096);
  }
  for (const key of ["timeoutMs", "durationMs", "outputBytes", "outputLimitBytes"] as const) {
    if (typeof fields[key] === "number" && Number.isFinite(fields[key])) data[key] = fields[key];
  }
  for (const key of ["truncated", "completionUnknown"] as const) {
    if (typeof fields[key] === "boolean") data[key] = fields[key];
  }
  return data;
}

export function decodeError(data: CodeErrorData): Error & CodeErrorData {
  return Object.assign(new Error(data.message), data);
}

/** JSON escaping can expand a bounded byte buffer (e.g. NUL -> six bytes).
 * Preserve a prefix and metadata rather than losing the entire error. */
export function boundError(data: CodeErrorData, maxBytes: number): CodeErrorData {
  if (Buffer.byteLength(JSON.stringify(data)) <= maxBytes) return data;
  if (data.output !== undefined) {
    const output = data.output;
    const bounded = { ...data, output: "", outputBytes: 0, truncated: true };
    let low = 0, high = output.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      bounded.output = output.slice(0, mid);
      bounded.outputBytes = Buffer.byteLength(bounded.output);
      if (Buffer.byteLength(JSON.stringify(bounded)) <= maxBytes) low = mid;
      else high = mid - 1;
    }
    bounded.output = output.slice(0, low);
    bounded.outputBytes = Buffer.byteLength(bounded.output);
    if (Buffer.byteLength(JSON.stringify(bounded)) <= maxBytes) return bounded;
  }
  return { message: `capability error exceeds ${maxBytes} bytes`, code: "EOUTPUTLIMIT" };
}
