/** Runner transport contracts. */

/** Logical installation identity, independent of any future iroh key. */
export type NodeId = string;
export type NodeContact = "unobserved" | "available" | "unavailable";
export type NodeErrorCode = "NODE_UNAVAILABLE" | "ENVIRONMENT_MISSING" | "OPERATION_UNSUPPORTED" | "COMPLETION_UNKNOWN"
  | "WRONG_NODE" | "INVALID_REQUEST" | "CONFLICT" | "CAPACITY_EXCEEDED" | "DRAINING" | "CANCELLED"
  | "INCOMPATIBLE_PROTOCOL" | "IO_ERROR" | "LEASE_STALE" | "PRECONDITION_FAILED" | "NOT_FOUND";
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
