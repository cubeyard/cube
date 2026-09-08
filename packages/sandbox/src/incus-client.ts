/**
 * Thin Incus REST client over the local unix socket. Deliberately minimal:
 * no official TS client exists, and cube only needs request/operation/exec
 * plumbing here plus instance CRUD/state in Phase 2 — build on `request`.
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
  status: string;
  status_code: number;
  err: string;
  /** Operation-specific payload; for exec: { fds: Record<string,string>, return?: number }. */
  metadata: Record<string, unknown> | null;
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

export class IncusHttpError extends Error {
  readonly errorCode: number;
  constructor(errorCode: number, message: string) {
    super(`incus: ${message} (${errorCode})`);
    this.errorCode = errorCode;
  }
}

export class IncusClient {
  readonly socketPath: string;
  constructor(socketPath: string = process.env.INCUS_SOCKET ?? DEFAULT_INCUS_SOCKET) {
    this.socketPath = socketPath;
  }

  /**
   * One REST round trip. Resolves with the parsed envelope; rejects with
   * IncusHttpError when the envelope says type:"error".
   */
  request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
    apiPath: string,
    body?: unknown,
    headers?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<IncusResponse<T>> {
    // JSON by default; a Buffer/string body is sent raw (file push).
    const raw = Buffer.isBuffer(body) || typeof body === "string";
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath: this.socketPath,
          method,
          path: apiPath,
          signal,
          headers: {
            ...(body === undefined ? {} : { "content-type": raw ? "application/octet-stream" : "application/json" }),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("error", reject);
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
      req.on("error", reject);
      if (body !== undefined) req.write(raw ? body : JSON.stringify(body));
      req.end();
    });
  }

  /** Block until the operation finishes; returns its final state. */
  async waitOperation(operationUrl: string, signal?: AbortSignal): Promise<IncusOperation> {
    const { metadata } = await this.request<IncusOperation>("GET", `${operationUrl}/wait`, undefined, undefined, signal);
    return metadata;
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
  ): Promise<IncusOperation> {
    const envelope = await this.request(method, apiPath, body, undefined, signal);
    if (envelope.type !== "async") {
      throw new Error(`incus: expected async response for ${method} ${apiPath}, got ${envelope.type}`);
    }
    let op: IncusOperation;
    try {
      op = await this.waitOperation(envelope.operation, signal);
    } catch (error) {
      if (signal?.aborted) {
        // The HTTP waiter is local; explicitly cancel the Incus operation so
        // request cancellation cannot orphan a root command in the guest.
        await this.request("DELETE", envelope.operation).catch(() => {});
      }
      throw error;
    }
    if (op.status_code !== 200) {
      throw new IncusHttpError(op.status_code, op.err || `${method} ${apiPath}: ${op.status}`);
    }
    return op;
  }

  // ---- instances ----------------------------------------------------------

  async listInstances(): Promise<IncusInstance[]> {
    const { metadata } = await this.request<IncusInstance[]>("GET", "/1.0/instances?recursion=1");
    return metadata;
  }

  async getInstance(name: string): Promise<IncusInstance> {
    const { metadata } = await this.request<IncusInstance>(
      "GET",
      `/1.0/instances/${encodeURIComponent(name)}`,
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

  /** Create (init, not start) an instance and wait for it to exist. */
  async createInstance(spec: IncusInstanceCreate): Promise<void> {
    await this.requestWait("POST", "/1.0/instances", { type: "container", ...spec });
  }

  /**
   * Read-modify-write of the instance's persistent config/devices (the way
   * `incus config device add` works). PATCH is avoided: its device-map merge
   * semantics are shallow and surprising.
   */
  async updateInstance(name: string, mutate: (instance: IncusInstance) => void): Promise<void> {
    const instance = await this.getInstance(name);
    mutate(instance);
    // PUT replaces: every writable field must be copied over or it is erased.
    await this.requestWait("PUT", `/1.0/instances/${encodeURIComponent(name)}`, {
      architecture: instance.architecture,
      config: instance.config,
      description: instance.description,
      devices: instance.devices,
      ephemeral: instance.ephemeral,
      profiles: instance.profiles,
    });
  }

  async setInstanceState(
    name: string,
    action: IncusStateAction,
    opts: { force?: boolean; timeout?: number } = {},
    signal?: AbortSignal,
  ): Promise<void> {
    await this.requestWait("PUT", `/1.0/instances/${encodeURIComponent(name)}/state`, {
      action,
      force: opts.force ?? false,
      timeout: opts.timeout ?? 30,
    }, signal);
  }

  async deleteInstance(name: string): Promise<void> {
    await this.requestWait("DELETE", `/1.0/instances/${encodeURIComponent(name)}`);
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
   */
  async execSimple(name: string, command: string[], signal?: AbortSignal): Promise<number | null> {
    const op = await this.requestWait("POST", `/1.0/instances/${encodeURIComponent(name)}/exec`, {
      command,
      environment: { TERM: "dumb" },
      "wait-for-websocket": false,
      "record-output": false,
      interactive: false,
    }, signal);
    const exitCode = op.metadata?.return;
    return typeof exitCode === "number" ? exitCode : null;
  }

  /** Create a directory inside the instance rootfs (parents via repeated calls). */
  async makeInstanceDirectory(name: string, guestPath: string, mode = "0755"): Promise<void> {
    await this.request(
      "POST",
      `/1.0/instances/${encodeURIComponent(name)}/files?path=${encodeURIComponent(guestPath)}`,
      Buffer.alloc(0),
      { "x-incus-uid": "0", "x-incus-gid": "0", "x-incus-mode": mode, "x-incus-type": "directory" },
    );
  }

  // ---- networks -----------------------------------------------------------

  async getNetwork(
    name: string,
  ): Promise<{ name: string; description: string; managed: boolean; config: Record<string, string> }> {
    const { metadata } = await this.request<{
      name: string;
      description: string;
      managed: boolean;
      config: Record<string, string>;
    }>("GET", `/1.0/networks/${encodeURIComponent(name)}`);
    return metadata;
  }

  async createNetwork(name: string, config: Record<string, string>): Promise<void> {
    await this.request("POST", "/1.0/networks", { name, type: "bridge", config });
  }

  /** Replace the network (PUT replaces: pass full config + description). */
  async updateNetwork(
    name: string,
    body: { config: Record<string, string>; description?: string },
  ): Promise<void> {
    await this.request("PUT", `/1.0/networks/${encodeURIComponent(name)}`, body);
  }

  async deleteNetwork(name: string): Promise<void> {
    await this.request("DELETE", `/1.0/networks/${encodeURIComponent(name)}`);
  }

  // ---- storage volumes ----------------------------------------------------

  async getCustomVolume(
    pool: string,
    name: string,
  ): Promise<{ name: string; description: string; config: Record<string, string> }> {
    const { metadata } = await this.request<{
      name: string;
      description: string;
      config: Record<string, string>;
    }>("GET", `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(name)}`);
    return metadata;
  }

  async createCustomVolume(pool: string, name: string, config: Record<string, string>): Promise<void> {
    await this.request("POST", `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom`, {
      name,
      config,
    });
  }

  /** Replace the volume (PUT replaces: pass full config + description). */
  async updateCustomVolume(
    pool: string,
    name: string,
    body: { config: Record<string, string>; description?: string },
  ): Promise<void> {
    await this.request(
      "PUT",
      `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(name)}`,
      body,
    );
  }

  async deleteCustomVolume(pool: string, name: string): Promise<void> {
    await this.request(
      "DELETE",
      `/1.0/storage-pools/${encodeURIComponent(pool)}/volumes/custom/${encodeURIComponent(name)}`,
    );
  }

  // ---- images -------------------------------------------------------------

  async getImageAlias(alias: string): Promise<{ name: string; target: string }> {
    const { metadata } = await this.request<{ name: string; target: string }>(
      "GET",
      `/1.0/images/aliases/${encodeURIComponent(alias)}`,
    );
    return metadata;
  }

  /** Publish a stopped instance as an image under `alias` (the alias must be free). */
  async publishInstanceAsImage(name: string, alias: string): Promise<string> {
    const op = await this.requestWait("POST", "/1.0/images", {
      source: { type: "instance", name },
      aliases: [{ name: alias }],
    });
    const fingerprint = op.metadata?.fingerprint;
    if (typeof fingerprint !== "string") throw new Error("incus: publish returned no fingerprint");
    return fingerprint;
  }

  async deleteImage(fingerprint: string): Promise<void> {
    await this.requestWait("DELETE", `/1.0/images/${encodeURIComponent(fingerprint)}`);
  }
}
