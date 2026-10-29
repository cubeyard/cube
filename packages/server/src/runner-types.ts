/** What cubed records about a runner and its templates, whatever protocol
 * reported it. Runners enrolled with protocol 3 (`cube-runner`, retired)
 * keep their rows and last reports in this shape, so they stay readable. */

/** A runner's identity in the registry. */
export interface NodeBinding { nodeId: string; environmentId: number; threadId: string }

/** The largest machine a runner accepts: a protocol-4 VM runner's hello
 * `limits`, or (with the other fields) a protocol-3 runner's old report. */
export interface VmLimits {
  maxVcpus: number; maxMemoryMiB: number; maxDiskGiB: number;
  /** Only in a protocol-3 runner's report. */
  maxFrameBytes?: number; requestTimeoutMs?: number; maxSeedBytes?: number; maxActiveVms?: number;
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
  /** The largest machine it accepts; absent when the runner names none
   * (berth host) or the report predates cubed keeping it. */
  limits?: VmLimits;
  /** The file system of a VM runner's directory as it measured it
   * (`Capacity.disk_*`); absent from a runner that does not report it. */
  disk?: RunnerDisk;
}

/** null: the runner did not say (a failed measurement, no inode count),
 * never 0. `committedBytes` is the runner's estimate of what template
 * builds may still write. */
export interface RunnerDisk {
  freeBytes: number | null; freeInodes: number | null; committedBytes: number | null;
  reserveBytes: number | null; reserveInodes: number | null;
}

/** A VM runner's disk as its report says: `refusing` while berth refuses
 * new machines (free less committed below its reserve, or too few inodes),
 * `low` below 4 × the reserve, `unknown` when the runner does not say. */
export type DiskState = "ok" | "low" | "refusing" | "unknown";
export const LOW_RESERVES = 4;

export function diskState(disk: RunnerDisk | undefined): DiskState {
  if (!disk || disk.freeBytes === null || disk.reserveBytes === null) return "unknown";
  const usable = disk.freeBytes - (disk.committedBytes ?? 0);
  if (usable < disk.reserveBytes || (disk.freeInodes !== null && disk.reserveInodes !== null && disk.freeInodes < disk.reserveInodes)) return "refusing";
  return usable < LOW_RESERVES * disk.reserveBytes ? "low" : "ok";
}

export const TEMPLATE_STATES = ["publishing", "ready", "removing"] as const;
/** A prepared disk on a runner that new machines' overlays are backed by. */
export interface RunnerTemplate {
  id: string; key: string; meta: string; state: typeof TEMPLATE_STATES[number];
  diskGiB: number; bytes: number; createdAt: number; users: number;
}
