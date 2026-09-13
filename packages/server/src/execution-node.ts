/** Local transition boundary, NOT an iroh implementation. Policy stays in
 * Supervisor; local streams and callbacks deliberately are not wire DTOs. */
import net from "node:net";
import type { Duplex } from "node:stream";
import type { CubeBackend } from "@cube/sandbox";
import { IncusHttpError, IncusTimeoutError } from "../../sandbox/src/incus-client.ts";
import type { Registry } from "./registry.ts";

/** Logical installation identity, independent of any future iroh key. */
export type NodeId = string;
export type NodeContact = "unobserved" | "available" | "unavailable";
export type NodeErrorCode = "NODE_UNAVAILABLE" | "ENVIRONMENT_MISSING" | "OPERATION_UNSUPPORTED" | "COMPLETION_UNKNOWN";
export class ExecutionNodeError extends Error {
  readonly code: NodeErrorCode;
  readonly completionUnknown: boolean;
  constructor(code: NodeErrorCode, cause?: unknown) {
    super(code, { cause });
    this.name = "ExecutionNodeError";
    this.code = code;
    this.completionUnknown = code === "COMPLETION_UNKNOWN";
  }
}
export interface EnvironmentObservation { status: string; observedAt: number }
export interface ExecutionNodeClient {
  readonly nodeId: NodeId;
  readonly contact: NodeContact;
  status(environmentId: number): Promise<EnvironmentObservation>;
  /** Contact only, for an environment not yet provisioned. */
  check(environmentId: number): Promise<void>;
  wake(environmentId: number): Promise<void>;
  sleep(environmentId: number): Promise<void>;
  openPortal(environmentId: number, port: number): Promise<Duplex>;
}
export function isNodeTransportFailure(error: unknown): boolean {
  if (error instanceof IncusTimeoutError && error.unresponsive) return true;
  const code = (error as { code?: unknown })?.code;
  return ["ECONNREFUSED", "ECONNRESET", "ENOENT", "EPIPE", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH"].includes(String(code));
}

export class ExecutionNodes {
  private readonly clients = new Map<string, ExecutionNodeClient>();
  constructor(privateRegistry: Registry, clients: ExecutionNodeClient[]) {
    this.registry = privateRegistry;
    for (const client of clients) {
      if (!/^node-[a-zA-Z0-9-]+$/.test(client.nodeId) || this.clients.has(client.nodeId)) throw new Error("invalid or duplicate node identity");
      this.clients.set(client.nodeId, client);
    }
  }
  private readonly registry: Registry;
  contactForEnvironment(environmentId: number): NodeContact {
    return this.clients.get(this.registry.nodeForCube(environmentId))?.contact ?? "unavailable";
  }
  forEnvironment(environmentId: number): ExecutionNodeClient {
    if (!Number.isSafeInteger(environmentId) || environmentId < 1) throw new Error("invalid environment identity");
    const id = this.registry.nodeForCube(environmentId);
    const client = this.clients.get(id);
    if (!client) throw new ExecutionNodeError("NODE_UNAVAILABLE");
    return client;
  }
}

export class LocalExecutionNodeClient implements ExecutionNodeClient {
  readonly nodeId: NodeId;
  contact: NodeContact = "unobserved";
  private readonly registry: Registry;
  private readonly backend: CubeBackend;
  constructor(registry: Registry, backend: CubeBackend) {
    this.registry = registry;
    this.backend = backend;
    this.nodeId = registry.localNodeId;
  }
  private environment(id: number) {
    if (!Number.isSafeInteger(id) || id < 1 || this.registry.nodeForCube(id) !== this.nodeId) throw new Error("invalid local environment binding");
    const cube = this.registry.getCubeById(id);
    if (!cube) throw new ExecutionNodeError("ENVIRONMENT_MISSING");
    return cube;
  }
  async status(id: number): Promise<EnvironmentObservation> {
    const cube = this.environment(id);
    try {
      const state = await this.backend.getState(`cube-${cube.name}`);
      if (!state || typeof state.status !== "string" || !state.status) throw new Error("invalid backend environment status");
      this.contact = "available";
      const observation = { status: state.status, observedAt: Date.now() };
      this.registry.observeEnvironment(id, observation);
      return observation;
    } catch (error) {
      if (error instanceof IncusHttpError && error.errorCode === 404) {
        this.contact = "available";
        this.registry.observeEnvironment(id, { status: "missing", observedAt: Date.now() });
        throw new ExecutionNodeError("ENVIRONMENT_MISSING", error);
      }
      if (isNodeTransportFailure(error)) {
        this.contact = "unavailable";
        throw new ExecutionNodeError("NODE_UNAVAILABLE", error);
      }
      throw error; // invalid configuration/backend data remains fail-closed
    }
  }
  async check(id: number): Promise<void> {
    try { await this.status(id); }
    catch (error) {
      if (error instanceof ExecutionNodeError && error.code === "ENVIRONMENT_MISSING") return;
      throw error;
    }
  }
  private async change(id: number, action: "start" | "stop"): Promise<void> {
    await this.status(id);
    const cube = this.environment(id);
    try { await this.backend.setState(`cube-${cube.name}`, action, { timeout: 30 }); }
    catch (error) {
      if (isNodeTransportFailure(error) || error instanceof IncusTimeoutError || (error as { completionUnknown?: boolean })?.completionUnknown) {
        this.contact = "unavailable";
        throw new ExecutionNodeError("COMPLETION_UNKNOWN", error);
      }
      throw error;
    }
    await this.status(id);
  }
  wake(id: number) { return this.change(id, "start"); }
  sleep(id: number) { return this.change(id, "stop"); }
  async openPortal(id: number, port: number): Promise<Duplex> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid portal port");
    await this.status(id);
    const cube = this.environment(id);
    const host = this.backend.kind === "mock" ? "127.0.0.1" : `10.90.${cube.subnetIndex}.10`;
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, host);
      const timer = setTimeout(() => socket.destroy(Object.assign(new Error("portal connection timed out"), { code: "ETIMEDOUT" })), 5_000);
      socket.once("error", error => { clearTimeout(timer); reject(error); });
      socket.once("connect", () => { clearTimeout(timer); resolve(socket); });
    });
  }
}
