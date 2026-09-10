/**
 * Thin Incus REST client over the local unix socket. Deliberately minimal:
 * no official TS client exists, and cube only needs request/operation/exec
 * plumbing here plus instance CRUD/state in Phase 2 — build on `request`.
 *
 * Every round trip is bounded. A sync request gets `timeouts.request`. An
 * operation wait is polled in `pollMs` slices (`GET <op>/wait?timeout=N`)
 * under a per-kind deadline, and a slice Incus does not answer within
 * `graceMs` of its own timeout counts as an unresponsive daemon. Either way
 * the caller gets an `IncusTimeoutError` naming the kind, the instance and
 * the seconds — never a promise that hangs a thread in "setting up".
 */
import http from "node:http";
import WebSocket from "ws";

export const DEFAULT_INCUS_SOCKET = "/var/lib/incus/unix.socket";

/** Incus response envelope (both sync and async responses use it). */
export interface IncusResponse<T = unknown> {
  type: "sync" | "async" | "error";
  status: string;
  status_code: number;
  /** For async responses: the operation URL, e.g. "/1.0/operations/<uuid>". */
  operation: string;
  error_code: number;
  error: string;
  metadata: T;
}

/** The subset of an Incus background operation cube cares about. */
export interface IncusOperation {
  id: string;
  class: string;
  description?: string;
  resources?: Record<string, string[]>;
  status: string;
  status_code: number;
  err: string;
  /** Operation-specific payload; for exec: { fds: Record<string,string>, return?: number }. */
  metadata: Record<string, unknown> | null;
}

export interface IncusImage {
  fingerprint: string;
  properties: Record<string, string>;
  aliases: Array<{ name: string; description?: string }>;
}

/** Instance as returned by GET /1.0/instances/<name> (subset). */
export interface IncusInstance {
  name: string;
  description: string;
  status: string;
  status_code: number;
  type: string;
  architecture: string;
  ephemeral: boolean;
  config: Record<string, string>;
  devices: Record<string, Record<string, string>>;
  expanded_config?: Record<string, string>;
  expanded_devices?: Record<string, Record<string, string>>;
  profiles: string[];
  created_at: string;
  last_used_at: string;
}

/** Runtime state from GET /1.0/instances/<name>/state (subset). */
export interface IncusInstanceState {
  status: string;
  status_code: number;
  pid: number;
  processes: number;
  network: Record<
    string,
    { addresses: Array<{ family: string; address: string; netmask: string; scope: string }> }
  > | null;
}

export interface IncusInstanceCreate {
  name: string;
  source: { type: "image"; alias: string } | { type: "image"; fingerprint: string };
  config?: Record<string, string>;
  devices?: Record<string, Record<string, string>>;
  profiles?: string[];
  type?: "container" | "virtual-machine";
}

export type IncusStateAction = "start" | "stop" | "restart" | "freeze" | "unfreeze";

/**
 * Deadlines in milliseconds per kind of Incus work. `state` covers every
 * state action (start/stop/restart/freeze/unfreeze); a stop's own graceful
 * `timeout` (seconds, default 30) always fits inside it, see
 * `setInstanceState`. `request` bounds one sync round trip; `operation` is
 * the fallback for a `waitOperation` call that names no kind; `cancel`
 * bounds the operation cancel issued after a wait was abandoned.
 */
export interface IncusOperationTimeouts {
  create: number;
  update: number;
  state: number;
  delete: number;
  exec: number;
  publish: number;
  imageDelete: number;
  request: number;
  operation: number;
  cancel: number;
}

export const DEFAULT_INCUS_OPERATION_TIMEOUTS: Readonly<IncusOperationTimeouts> = Object.freeze({
  create: 10 * 60_000,
  update: 2 * 60_000,
  state: 2 * 60_000,
  delete: 5 * 60_000,
  exec: 10 * 60_000,
  publish: 15 * 60_000,
  imageDelete: 5 * 60_000,
  request: 60_000,
  operation: 10 * 60_000,
  cancel: 10_000,
});

export interface IncusClientOptions {
  /** Per-kind deadlines; keys left out keep `DEFAULT_INCUS_OPERATION_TIMEOUTS`. */
  timeouts?: Partial<IncusOperationTimeouts>;
  /** Longest single `/wait` slice asked of Incus (its `?timeout=` query). Default 60 s. */
  pollMs?: number;
  /** How long past its own `?timeout=` Incus may take to answer a slice
   * before it counts as unresponsive. Default 30 s. */
  graceMs?: number;
}

/** Bound and identity for one operation wait. */
export interface IncusWaitOptions {
  /** Operation kind for the error ("create", "start", "exec", "publish", …). */
  kind?: string;
  /** Instance the operation belongs to, named in the error. */
  instance?: string;
  /** Whole-wait deadline; `Infinity` keeps only the per-slice liveness bound. */
  timeoutMs?: number;
}

/** Abort/deadline options shared by the bounded instance and image calls. */
export interface IncusCallOptions {
  signal?: AbortSignal;
  /** Overrides the kind's default deadline for this call. */
  timeoutMs?: number;
}

export class IncusHttpError extends Error {
  readonly errorCode: number;
  constructor(errorCode: number, message: string) {
    super(`incus: ${message} (${errorCode})`);
    this.errorCode = errorCode;
  }
}

/**
 * A bounded Incus call gave up. `unresponsive` distinguishes "the daemon
 * stopped answering" (a slice or sync request exceeded its liveness bound)
 * from "the work did not finish in time" (the operation kept reporting
 * Running until the deadline). Either way the operation may still complete
 * on the Incus side later — callers decide whether to roll back, reconcile
 * or leave a journal.
 */
export class IncusTimeoutError extends Error {
  readonly kind: string;
  readonly seconds: number;
  readonly instance?: string;
  readonly operation?: string;
  readonly unresponsive: boolean;
  constructor(
    kind: string,
    seconds: number,
    detail: { instance?: string; operation?: string; request?: string; unresponsive?: boolean } = {},
  ) {
    const subject = detail.instance
      ? `${kind} of ${detail.instance}`
      : detail.request ? `${kind} ${detail.request}` : kind;
    const suffix = detail.operation ? ` (operation ${detail.operation})` : "";
    super(
      detail.unresponsive
        ? `incus: ${subject}: the daemon did not answer within ${seconds}s${suffix}`
        : `incus: ${subject} did not finish within ${seconds}s${suffix}`,
    );
    this.name = "IncusTimeoutError";
    this.kind = kind;
    this.seconds = seconds;
    this.instance = detail.instance;
    this.operation = detail.operation;
    this.unresponsive = detail.unresponsive ?? false;
  }
}

const seconds = (ms: number) => Math.round(ms / 100) / 10;

/**
 * One AbortSignal that fires on the caller's signal (with its reason) or at
 * a deadline (`expired` then reads true). `Infinity` sets no timer: Node
 * would otherwise clamp it to 1 ms.
 */
class Deadline {
  readonly signal: AbortSignal;
  expired = false;
  private readonly controller = new AbortController();
  private readonly parent?: AbortSignal;
  private readonly timer?: NodeJS.Timeout;
  private readonly onAbort = () => this.controller.abort(this.parent?.reason);
  constructor(ms: number, parent?: AbortSignal) {
    this.parent = parent;
    this.signal = this.controller.signal;
    if (parent?.aborted) this.onAbort();
    else parent?.addEventListener("abort", this.onAbort, { once: true });
    if (Number.isFinite(ms) && ms > 0) {
      this.timer = setTimeout(() => {
        this.expired = true;
        this.controller.abort(new Error("incus: deadline exceeded"));
      }, ms);
    }
  }
  release(): void {
    if (this.timer) clearTimeout(this.timer);
    this.parent?.removeEventListener("abort", this.onAbort);
  }
}

export class IncusClient {
  readonly socketPath: string;
  readonly timeouts: Readonly<IncusOperationTimeouts>;
  readonly pollMs: number;
  readonly graceMs: number;
  constructor(socketPath: string = process.env.INCUS_SOCKET ?? DEFAULT_INCUS_SOCKET, opts: IncusClientOptions = {}) {
    this.socketPath = socketPath;
    const timeouts = { ...DEFAULT_INCUS_OPERATION_TIMEOUTS };
    for (const key of Object.keys(timeouts) as Array<keyof IncusOperationTimeouts>) {
      const value = opts.timeouts?.[key];
      if (value !== undefined) timeouts[key] = value;
    }
    this.timeouts = timeouts;
    this.pollMs = opts.pollMs ?? 60_000;
    this.graceMs = opts.graceMs ?? 30_000;
  }

  /**
   * One REST round trip. Resolves with the parsed envelope; rejects with
   * IncusHttpError when the envelope says type:"error", with the signal's
   * reason when the caller aborted, and with IncusTimeoutError when Incus
   * did not answer within `timeoutMs` (default `timeouts.request`;
   * `Infinity` for a request the caller bounds itself).
   */
  request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    apiPath: string,
    body?: unknown,
    headers?: Record<string, string>,
    signal?: AbortSignal,
    timeoutMs: number = this.timeouts.request,
  ): Promise<IncusResponse<T>> {
    // JSON by default; a Buffer/string body is sent raw (file push).
    const raw = Buffer.isBuffer(body) || typeof body === "string";
    const deadline = new Deadline(timeoutMs, signal);
    return new Promise<IncusResponse<T>>((resolve, reject) => {
      const fail = (error: Error) =>
        reject(
          deadline.expired
            ? new IncusTimeoutError("request", seconds(timeoutMs), { request: `${method} ${apiPath}`, unresponsive: true })
            : signal?.aborted ? signal.reason : error,
        );
      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path: apiPath,
          signal: deadline.signal,
          headers: {
            ...(body === undefined ? {} : { "content-type": raw ? "application/octet-stream" : "application/json" }),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("error", fail);
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let envelope: IncusResponse<T>;
            try {
              envelope = JSON.parse(raw);
            } catch {
              return reject(new Error(`incus: non-JSON response for ${method} ${apiPath}: ${raw.slice(0, 200)}`));
            }
            if (envelope.type === "error") {
              return reject(new IncusHttpError(envelope.error_code, envelope.error));
            }
            resolve(envelope);
          });
        },
      );
      req.on("error", fail);
      if (body !== undefined) req.write(raw ? body : JSON.stringify(body));
      req.end();
    }).finally(() => deadline.release());
  }

  /**
   * Block until the operation finishes; returns its final state. Bounded:
   * the wait is sliced into `pollMs` requests carrying `?timeout=`, so a
   * daemon that stops answering is caught within one slice plus `graceMs`,
   * and an operation that keeps running is abandoned at `timeoutMs`
   * (default `timeouts.operation`). Rejects with the signal's reason on
   * abort. The Incus-side operation is NOT cancelled here — see
   * `requestWait` for the calls that do.
   */
  async waitOperation(operationUrl: string, signal?: AbortSignal, wait: IncusWaitOptions = {}): Promise<IncusOperation> {
    const kind = wait.kind ?? "operation";
    const timeoutMs = wait.timeoutMs ?? this.timeouts.operation;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new IncusTimeoutError(kind, seconds(timeoutMs), { instance: wait.instance, operation: operationUrl });
      }
      const sliceSeconds = Math.max(1, Math.ceil(Math.min(remainingMs, this.pollMs) / 1000));
      const sliceMs = sliceSeconds * 1000 + this.graceMs;
      const slice = new Deadline(sliceMs, signal);
      let operation: IncusOperation;
      try {
        ({ metadata: operation } = await this.request<IncusOperation>(
          "GET", `${operationUrl}/wait?timeout=${sliceSeconds}`, undefined, undefined, slice.signal, Infinity,
        ));
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (slice.expired) {
          throw new IncusTimeoutError(kind, seconds(sliceMs), {
            instance: wait.instance, operation: operationUrl, unresponsive: true,
          });
        }
        throw error;
      } finally {
        slice.release();
      }
      // Below 200 Incus rendered a still-running operation at its own
      // timeout; anything else (200 success, 400 failure, 401 cancelled) is final.
      if (operation.status_code >= 200) return operation;
    }
  }

  /**
   * Attach to one of an operation's websocket fds (exec I/O + control).
   * The caller owns the returned socket.
   */
  openOperationWebsocket(operationUrl: string, secret: string): WebSocket {
    return new WebSocket(
      `ws+unix:${this.socketPath}:${operationUrl}/websocket?secret=${encodeURIComponent(secret)}`,
    );
  }

  /** Fire an async request and block until its operation succeeds. */
  private async requestWait(
    method: "POST" | "PUT" | "DELETE" | "PATCH",
    apiPath: string,
    body?: unknown,
    signal?: AbortSignal,
    wait: IncusWaitOptions = {},
  ): Promise<IncusOperation> {
    const envelope = await this.request(method, apiPath, body, undefined, signal);
    if (envelope.type !== "async") {
      throw new Error(`incus: expected async response for ${method} ${apiPath}, got ${envelope.type}`);
    }
    let op: IncusOperation;
    try {
      op = await this.waitOperation(envelope.operation, signal, wait);
    } catch (error) {
      if (signal?.aborted || error instanceof IncusTimeoutError) {
        // The HTTP waiter is local; explicitly cancel the Incus operation so
        // an abandoned wait cannot orphan a root command in the guest. Incus
        // refuses to cancel create/state/delete/publish work (harmless).
        // Signal-free and bounded: the caller has already given up.
        await this.request("DELETE", envelope.operation, undefined, undefined, undefined, this.timeouts.cancel)
          .catch(() => {});
      }
      throw error;
    }
    if (op.status_code !== 200) {
      throw new IncusHttpError(op.status_code, op.err || `${method} ${apiPath}: ${op.status}`);
    }
    return op;
  }

  // ---- instances ----------------------------------------------------------

  async listInstances(signal?: AbortSignal): Promise<IncusInstance[]> {
    const { metadata } = await this.request<IncusInstance[]>(
      "GET", "/1.0/instances?recursion=1", undefined, undefined, signal,
    );
    return metadata;
  }

  async getInstance(name: string, signal?: AbortSignal): Promise<IncusInstance> {
    const { metadata } = await this.request<IncusInstance>(
      "GET",
      `/1.0/instances/${encodeURIComponent(name)}`,
      undefined,
      undefined,
      signal,
    );
    return metadata;
  }

  async getInstanceState(name: string, signal?: AbortSignal): Promise<IncusInstanceState> {
    const { metadata } = await this.request<IncusInstanceState>(
      "GET",
      `/1.0/instances/${encodeURIComponent(name)}/state`,
      undefined,
      undefined,
      signal,
    );
    return metadata;
  }

  /** Create (init, not start) an instance and wait for it to exist. Deadline `timeouts.create`. */
  async createInstance(spec: IncusInstanceCreate, opts: IncusCallOptions = {}): Promise<void> {
    await this.requestWait("POST", "/1.0/instances", { type: "container", ...spec }, opts.signal, {
      kind: "create", instance: spec.name, timeoutMs: opts.timeoutMs ?? this.timeouts.create,
    });
  }

  /**
   * Read-modify-write of the instance's persistent config/devices (the way
   * `incus config device add` works). PATCH is avoided: its device-map merge
   * semantics are shallow and surprising. Deadline `timeouts.update`.
   */
  async updateInstance(
    name: string,
    mutate: (instance: IncusInstance) => void,
    opts: IncusCallOptions = {},
  ): Promise<void> {
    const instance = await this.getInstance(name, opts.signal);
    mutate(instance);
    // PUT replaces: every writable field must be copied over or it is erased.
    await this.requestWait("PUT", `/1.0/instances/${encodeURIComponent(name)}`, {
      architecture: instance.architecture,
      config: instance.config,
      description: instance.description,
      devices: instance.devices,
      ephemeral: instance.ephemeral,
      profiles: instance.profiles,
    }, opts.signal, { kind: "update", instance: name, timeoutMs: opts.timeoutMs ?? this.timeouts.update });
  }

  /**
   * Change run state. `timeout` is Incus's own graceful phase in seconds
   * (default 30: a non-forced stop the guest ignores fails after it, and the
   * caller may force). `timeoutMs` is the client deadline for the whole
   * call (default `timeouts.state`), always stretched to cover the graceful
   * phase plus `graceMs` so a slow but healthy stop never reads as a hang.
   */
  async setInstanceState(
    name: string,
    action: IncusStateAction,
    opts: { force?: boolean; timeout?: number; timeoutMs?: number } = {},
    signal?: AbortSignal,
  ): Promise<void> {
    const timeout = opts.timeout ?? 30;
    const timeoutMs = opts.timeoutMs ?? Math.max(this.timeouts.state, timeout > 0 ? timeout * 1000 + this.graceMs : 0);
    await this.requestWait("PUT", `/1.0/instances/${encodeURIComponent(name)}/state`, {
      action,
      force: opts.force ?? false,
      timeout,
    }, signal, { kind: action, instance: name, timeoutMs });
  }

  /** Deadline `timeouts.delete`. */
  async deleteInstance(name: string, opts: IncusCallOptions = {}): Promise<void> {
    await this.requestWait("DELETE", `/1.0/instances/${encodeURIComponent(name)}`, undefined, opts.signal, {
      kind: "delete", instance: name, timeoutMs: opts.timeoutMs ?? this.timeouts.delete,
    });
  }

  /** Write a file into the instance rootfs (works on stopped instances). */
  async pushInstanceFile(
    name: string,
    guestPath: string,
    content: string | Buffer,
    opts: { uid?: number; gid?: number; mode?: string; signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.request(
      "POST",
      `/1.0/instances/${encodeURIComponent(name)}/files?path=${encodeURIComponent(guestPath)}`,
      typeof content === "string" ? Buffer.from(content, "utf8") : content,
      {
        "x-incus-uid": String(opts.uid ?? 0),
        "x-incus-gid": String(opts.gid ?? 0),
        "x-incus-mode": opts.mode ?? "0644",
        "x-incus-type": "file",
        "x-incus-write": "overwrite",
      },
      opts.signal,
    );
  }

  /**
   * Download a file from the instance rootfs, binary-safe. The files API
   * never follows symlinks — for a symlink the body is the link target and
   * `type` says so, letting callers re-resolve INSIDE the instance (a
   * hostile symlink must never dereference on the host). Rejects when the
   * path is a directory or missing (JSON envelope instead of raw bytes).
   */
  pullInstanceFile(
    name: string,
    guestPath: string,
    opts: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<{ content: Buffer; type: "file" | "symlink" }> {
    const apiPath = `/1.0/instances/${encodeURIComponent(name)}/files?path=${encodeURIComponent(guestPath)}`;
    return new Promise((resolve, reject) => {
      const req = http.request({ socketPath: this.socketPath, method: "GET", path: apiPath, signal: opts.signal }, (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          // Guard a hostile multi-gigabyte guest file: destroy the response
          // rather than buffer it all into host memory. JSON envelopes are
          // tiny, so this only ever trips on real file bodies.
          if (opts.maxBytes !== undefined && total > opts.maxBytes) {
            req.destroy(new Error(`incus: file exceeds ${opts.maxBytes} bytes: ${guestPath}`));
            return;
          }
          chunks.push(c);
        });
        res.on("error", reject);
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          // Raw bytes for files; JSON envelopes for errors and directory
          // listings (X-Incus-type: directory).
          if ((res.headers["content-type"] ?? "").includes("application/json")) {
            let envelope: IncusResponse | undefined;
            try {
              envelope = JSON.parse(body.toString("utf8")) as IncusResponse;
            } catch {
              return reject(new Error(`incus: unparseable file response for ${guestPath}`));
            }
            if (envelope.type === "error") {
              return reject(new IncusHttpError(envelope.error_code, envelope.error));
            }
            return reject(new Error(`incus: not a regular file: ${guestPath}`));
          }
          if (res.statusCode !== 200) {
            return reject(new Error(`incus: file pull failed (${res.statusCode}): ${guestPath}`));
          }
          const type = res.headers["x-incus-type"] === "symlink" ? "symlink" : "file";
          resolve({ content: body, type });
        });
      });
      req.on("error", reject);
      req.end();
    });
  }

  /**
   * Run a command in the instance and wait for its exit code, no I/O
   * (provisioning pokes, not agent bash — that is IncusSandbox.exec).
   * Deadline `timeouts.exec`; an abort or deadline cancels the operation,
   * which kills the guest process.
   */
  async execSimple(
    name: string,
    command: string[],
    signal?: AbortSignal,
    opts: { timeoutMs?: number } = {},
  ): Promise<number | null> {
    const op = await this.requestWait("POST", `/1.0/instances/${encodeURIComponent(name)}/exec`, {
      command,
      environment: { TERM: "dumb" },
      "wait-for-websocket": false,
      "record-output": false,
      interactive: false,
    }, signal, { kind: "exec", instance: name, timeoutMs: opts.timeoutMs ?? this.timeouts.exec });
    const exitCode = op.metadata?.return;
    return typeof exitCode === "number" ? exitCode : null;
  }

  /** Create a directory inside the instance rootfs (parents via repeated calls). */
  async makeInstanceDirectory(name: string, guestPath: string, mode = "0755", signal?: AbortSignal): Promise<void> {
    await this.request(
      "POST",
      `/1.0/instances/${encodeURIComponent(name)}/files?path=${encodeURIComponent(guestPath)}`,
      Buffer.alloc(0),
      { "x-incus-uid": "0", "x-incus-gid": "0", "x-incus-mode": mode, "x-incus-type": "directory" },
      signal,
    );
  }

  // ---- networks -----------------------------------------------------------

  async getNetwork(
    name: string,
    signal?: AbortSignal,
  ): Promise<{ name: string; description: string; managed: boolean; config: Record<string, string> }> {
    const { metadata } = await this.request<{
      name: string;
      description: string;
      managed: boolean;
      config: Record<string, string>;
    }>("GET", `/1.0/networks/${encodeURIComponent(name)}`, undefined, undefined, signal);
    return metadata;
  }

  async createNetwork(name: string, config: Record<string, string>, signal?: AbortSignal): Promise<void> {
    await this.request("POST", "/1.0/networks", { name, type: "bridge", config }, undefined, signal);
  }

  /** Replace the network (PUT replaces: pass full config + description). */
  async updateNetwork(
    name: string,
    body: { config: Record<string, string>; description?: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request("PUT", `/1.0/networks/${encodeURIComponent(name)}`, body, undefined, signal);
  }

  async deleteNetwork(name: string, signal?: AbortSignal): Promise<void> {
    await this.request("DELETE", `/1.0/networks/${encodeURIComponent(name)}`, undefined, undefined, signal);
  }

  // ---- storage volumes ----------------------------------------------------

  async getCustomVolume(
    pool: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<{ name: string; description: string; config: Record<string, string> }> {
    const { metadata } = await this.request<{
      name: string;
      description: string;
      config: Record<string, string>;
    }>(
      "GET",
      `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(name)}`,
      undefined,
      undefined,
      signal,
    );
    return metadata;
  }

  async createCustomVolume(
    pool: string,
    name: string,
    config: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request("POST", `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom`, {
      name,
      config,
    }, undefined, signal);
  }

  /** Replace the volume (PUT replaces: pass full config + description). */
  async updateCustomVolume(
    pool: string,
    name: string,
    body: { config: Record<string, string>; description?: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.request(
      "PUT",
      `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(name)}`,
      body,
      undefined,
      signal,
    );
  }

  async deleteCustomVolume(pool: string, name: string, signal?: AbortSignal): Promise<void> {
    await this.request(
      "DELETE",
      `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(name)}`,
      undefined,
      undefined,
      signal,
    );
  }

  // ---- images -------------------------------------------------------------

  async listImages(signal?: AbortSignal): Promise<IncusImage[]> {
    const { metadata } = await this.request<IncusImage[]>("GET", "/1.0/images?recursion=1", undefined, undefined, signal);
    return metadata;
  }

  /** Active operations, flattened from Incus' status-keyed response. */
  async listOperations(signal?: AbortSignal): Promise<IncusOperation[]> {
    const { metadata } = await this.request<Record<string, IncusOperation[]>>(
      "GET", "/1.0/operations?recursion=1", undefined, undefined, signal,
    );
    return Object.values(metadata).flat();
  }

  async getOperation(operationUrl: string, signal?: AbortSignal): Promise<IncusOperation> {
    const { metadata } = await this.request<IncusOperation>("GET", operationUrl, undefined, undefined, signal);
    return metadata;
  }

  async getImageAlias(alias: string, signal?: AbortSignal): Promise<{ name: string; target: string }> {
    const { metadata } = await this.request<{ name: string; target: string }>(
      "GET",
      `/1.0/images/aliases/${encodeURIComponent(alias)}`,
      undefined,
      undefined,
      signal,
    );
    return metadata;
  }

  /**
   * Publish a stopped instance as an image under `alias` (the alias must be
   * free). Deadline `timeouts.publish`. Incus cannot cancel a publication,
   * so a deadline or abort only releases the waiter: the image may still
   * appear later.
   */
  async publishInstanceAsImage(name: string, alias: string, opts: IncusCallOptions = {}): Promise<string> {
    const op = await this.requestWait("POST", "/1.0/images", {
      source: { type: "instance", name },
      aliases: [{ name: alias }],
    }, opts.signal, { kind: "publish", instance: name, timeoutMs: opts.timeoutMs ?? this.timeouts.publish });
    const fingerprint = op.metadata?.fingerprint;
    if (typeof fingerprint !== "string") throw new Error("incus: publish returned no fingerprint");
    return fingerprint;
  }

  /**
   * Start publication and expose the operation URL before waiting. Deadline
   * `timeouts.publish`; on deadline or abort the operation is left running
   * (Incus cannot cancel it) and the caller's journal of `operationUrl` is
   * the record that decides its outcome later.
   */
  async publishTaggedInstanceAsImage(
    name: string,
    alias: string,
    properties: Record<string, string>,
    operationAccepted: (operationUrl: string) => void,
    opts: IncusCallOptions = {},
  ): Promise<string> {
    const envelope = await this.request("POST", "/1.0/images", {
      source: { type: "instance", name },
      aliases: [{ name: alias }],
      properties,
    }, undefined, opts.signal);
    if (envelope.type !== "async") throw new Error(`incus: expected async image publication, got ${envelope.type}`);
    // Deliberately synchronous: callers durably journal before we issue any
    // further request or yield back to the event loop.
    operationAccepted(envelope.operation);
    const op = await this.waitOperation(envelope.operation, opts.signal, {
      kind: "publish", instance: name, timeoutMs: opts.timeoutMs ?? this.timeouts.publish,
    });
    if (op.status_code !== 200) throw new IncusHttpError(op.status_code, op.err || op.status);
    const fingerprint = op.metadata?.fingerprint;
    if (typeof fingerprint !== "string") throw new Error("incus: publish returned no fingerprint");
    return fingerprint;
  }

  async createImageAlias(alias: string, fingerprint: string, signal?: AbortSignal): Promise<void> {
    await this.request("POST", "/1.0/images/aliases", { name: alias, target: fingerprint }, undefined, signal);
  }

  /** Deadline `timeouts.imageDelete`. */
  async deleteImage(fingerprint: string, opts: IncusCallOptions = {}): Promise<void> {
    await this.requestWait("DELETE", `/1.0/images/${encodeURIComponent(fingerprint)}`, undefined, opts.signal, {
      kind: "image-delete", timeoutMs: opts.timeoutMs ?? this.timeouts.imageDelete,
    });
  }
}
