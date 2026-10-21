/** What cubed records about a runner and its templates, whatever protocol
 * reported it. Runners enrolled with protocol 3 (`cube-runner`, retired)
 * keep their rows and last reports in this shape, so they stay readable. */

/** A runner's identity in the registry. */
export interface NodeBinding { nodeId: string; environmentId: number; threadId: string }

/** Machine bounds a protocol-3 runner advertised; kept in its old reports. */
export interface VmLimits {
  maxFrameBytes: number; requestTimeoutMs: number; maxVcpus: number; maxMemoryMiB: number; maxDiskGiB: number;
  maxSeedBytes: number; maxActiveVms: number;
}

export interface TrustedRunnerHealth {
  lifecycle: "ready" | "draining" | "faulted" | "recoveryRequired";
  draining: boolean;
  error: string | null;
  activeVms: number;
  runningVms: number;
  maxActiveVms: number;
  retainedVms: number;
  retainedBytes: number;
  softwareVersion: string;
  /** 3 only in a report a protocol-3 runner sent before it was retired. */
  protocolVersion: 3 | 4;
  /** Protocol 4: `host` for berth host (absent: a VM runner). */
  kind?: "vm" | "host";
  /** From the same exchange's authenticated hello; absent in health
   * recorded before cubed kept it. */
  platform?: string;
  capabilities?: string[];
  /** Only in a protocol-3 runner's report. */
  limits?: VmLimits;
}

export const TEMPLATE_STATES = ["publishing", "ready", "removing"] as const;
/** A prepared disk on a runner that new machines' overlays are backed by. */
export interface RunnerTemplate {
  id: string; key: string; meta: string; state: typeof TEMPLATE_STATES[number];
  diskGiB: number; bytes: number; createdAt: number; users: number;
}
