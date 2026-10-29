/** The one place cubed tells runner protocols apart, by the protocol a
 * runner was enrolled with. cubed runs protocol 4 (`cubeyard/runner/4`,
 * RunnerMachines over one RunnerSession: `berth vm` and `berth host`) only.
 * A runner enrolled with protocol 3 (`cube-runner`, retired) keeps its
 * registry row, its threads and their history, but is never contacted or
 * placed on again: RunnerMachines asks `retiredRunner` before anything
 * else, and its threads' machines refuse to start, archive without
 * contacting it, and leave any disk on that runner's host
 * (docs/runner-operations.md). */
import { Runner_Kind, Runner_Lifecycle } from "./gen/runner_pb.js";
import type { Runner } from "./registry.ts";
import { runnerSession } from "./runner-session.ts";
import type { RunnerDisk, TrustedRunnerHealth } from "./runner-types.ts";

export function runnerProtocol(runner: Pick<Runner, "protocol">): 3 | 4 { return runner.protocol === 4 ? 4 : 3; }

/** Whether a thread's runner (`Registry.runner`) is one cubed never
 * contacts: enrolled with protocol 3, or with no admission at all. */
export function retiredRunner(runner: Runner | null): boolean { return !runner || runnerProtocol(runner) === 3; }

/** What a protocol-3 runner's thread says instead of contacting it. */
export const PROTOCOL_3_RETIRED = "this thread's runner uses protocol 3 (cube-runner), which cube no longer runs; "
  + "its history stays readable, its machine is not started again, and any disk it kept stays on that runner's host";

/** What a check of a protocol-3 runner records instead of contacting it. */
export const PROTOCOL_3_UNSUPPORTED = "UNSUPPORTED: protocol 3 (cube-runner) is no longer supported; cubed does not contact this runner";

const LIFECYCLES: Record<number, TrustedRunnerHealth["lifecycle"]> = {
  [Runner_Lifecycle.READY]: "ready", [Runner_Lifecycle.DRAINING]: "draining",
  [Runner_Lifecycle.FAULTED]: "faulted", [Runner_Lifecycle.RECOVERY_REQUIRED]: "recoveryRequired",
};

/** A runner's status as placement and the system page read it. A
 * protocol-3 runner is refused without contact. */
export async function runnerHealth(runner: Runner): Promise<TrustedRunnerHealth> {
  if (runnerProtocol(runner) === 3) throw new Error(PROTOCOL_3_UNSUPPORTED);
  const hello = await runnerSession(runner).hello();
  const described = hello.runner!;
  const capacity = described.capacity;
  const lifecycle = LIFECYCLES[described.lifecycle] ?? "faulted";
  const bounds = described.limits;
  const limits = bounds && bounds.maxVcpus > 0 && bounds.maxMemoryMib > 0
    ? { limits: { maxVcpus: bounds.maxVcpus, maxMemoryMiB: bounds.maxMemoryMib, maxDiskGiB: bounds.maxDiskGib } } : {};
  return {
    lifecycle, draining: lifecycle === "draining", error: null,
    activeVms: capacity?.machinesActive ?? 0, runningVms: capacity?.machinesRunning ?? 0,
    maxActiveVms: Math.max(1, described.limits?.maxMachines ?? 1),
    retainedVms: capacity?.retained ?? 0, retainedBytes: Number(capacity?.retainedBytes ?? 0n),
    softwareVersion: described.softwareVersion, protocolVersion: 4,
    kind: described.kind === Runner_Kind.HOST ? "host" : "vm",
    platform: [described.platform?.os, described.platform?.arch].filter(Boolean).join("-"),
    capabilities: hello.capabilities,
    ...limits,
    ...capacity && capacity.diskReserveBytes !== undefined ? { disk: runnerDisk(capacity) } : {},
  };
}

const known = (value: bigint | undefined) => value === undefined ? null : Number(value);
/** A runner before `Capacity.disk_*` sets none of them: no disk at all. */
function runnerDisk(capacity: { diskFreeBytes?: bigint; diskFreeInodes?: bigint; diskCommittedBytes?: bigint; diskReserveBytes?: bigint; diskReserveInodes?: bigint }): RunnerDisk {
  return { freeBytes: known(capacity.diskFreeBytes), freeInodes: known(capacity.diskFreeInodes), committedBytes: known(capacity.diskCommittedBytes),
    reserveBytes: known(capacity.diskReserveBytes), reserveInodes: known(capacity.diskReserveInodes) };
}
