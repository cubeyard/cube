/** Transport-neutral control-plane contracts. No Incus/runtime imports. */
import type { Duplex } from "node:stream";

/** Logical installation identity, independent of any future iroh key. */
export type NodeId = string;
export type NodeContact = "unobserved" | "available" | "unavailable";
export type NodeErrorCode = "NODE_UNAVAILABLE" | "ENVIRONMENT_MISSING" | "OPERATION_UNSUPPORTED" | "COMPLETION_UNKNOWN"
  | "WRONG_NODE" | "INVALID_REQUEST" | "CONFLICT" | "CAPACITY_EXCEEDED" | "IO_ERROR";
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
  /** Transport reachability does not authorize control-plane host paths. */
  readonly locality: "local" | "remote";
  readonly nodeId: NodeId;
  readonly contact: NodeContact;
  status(environmentId: number): Promise<EnvironmentObservation>;
  /** Contact only, for an environment not yet provisioned. */
  check(environmentId: number): Promise<void>;
  wake(environmentId: number): Promise<void>;
  sleep(environmentId: number): Promise<void>;
  openPortal(environmentId: number, port: number): Promise<Duplex>;
}
