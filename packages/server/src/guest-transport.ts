/** How cubed reaches the guest inside a thread's machine: keel's
 * `cube-agent` or, on a `berth host`, `cube-guest`, both over runner protocol
 * 4's guest streams (runner-session.ts).
 *
 * One call is one guest request: a JSON header line plus an optional raw
 * body, answered by a JSON header line plus an optional raw body. The guest
 * answers its own errors as `{error: {code, message}}`; anything else (no
 * answer, a lost stream) is a transport failure, and for a mutation its
 * outcome is unknown. */

export type GuestOp = "hello" | "exec" | "get" | "cancel" | "read" | "write" | "stat" | "services" | "install" | "portal";
export interface GuestAnswer { header: Record<string, unknown>; body: Buffer }
export interface GuestCallOptions { body?: Uint8Array; signal?: AbortSignal; timeoutMs?: number }

export interface GuestTransport {
  call(op: GuestOp, header: Record<string, unknown>, options?: GuestCallOptions): Promise<GuestAnswer>;
  /** Ends any persistent connection; later calls open a new one. */
  close(): Promise<void>;
}

/** The guest could not be reached or gave no answer. */
export class GuestTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GuestTransportError";
  }
}

/** Request bytes for the helper. */
export function encodeGuestRequest(header: Record<string, unknown>, body?: Uint8Array): Buffer {
  const fields = body ? { ...header, length: body.length } : header;
  return Buffer.concat([Buffer.from(`${JSON.stringify(fields)}\n`), body ?? Buffer.alloc(0)]);
}

/** Parses the helper's answer; throws GuestTransportError when there is none. */
export function decodeGuestAnswer(stdout: Buffer): GuestAnswer {
  const end = stdout.indexOf(10);
  if (end < 0) throw new GuestTransportError("the guest helper gave no answer");
  let header: unknown;
  try { header = JSON.parse(stdout.subarray(0, end).toString("utf8")); }
  catch (cause) { throw new GuestTransportError("the guest helper answered something that is not JSON", { cause }); }
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new GuestTransportError("the guest helper answer is not an object");
  return { header: header as Record<string, unknown>, body: stdout.subarray(end + 1) };
}
