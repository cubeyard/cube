/** What cubed knows about its runners, read-only, for the operator and
 * OptChat. Every value comes from a runner's own authenticated status report
 * (`node.status` and the `node.hello` before it) or from cubed's registry;
 * what neither says is listed as unknown, never guessed. Nothing here
 * contacts a runner: the background probe keeps the reports current. */
import type { TrustedRunnerHealth } from "./iroh-node.ts";
import type { Registry, RunnerContactStatus } from "./registry.ts";

/** A report older than this many probe intervals is stale even if the latest
 * probe has not failed yet (cubed was down, or the probe loop is stuck). */
const FRESH_INTERVALS = 3;

/** Unknown for every runner: protocol 3 does not report it. */
export const NOT_REPORTED = [
  "capacity mode: whether --max-active-vms is auto or an explicit number (only the effective bound is reported)",
  "self-update: when the runner's updater last ran, what it found and whether an upgrade is pending",
  "nested virtualization: whether the runner host is itself a virtual machine and whether thread machines get KVM/HVF",
] as const;

export interface RunnerReport {
  /** When cubed received it, and whether it is the current state. */
  at: number; ageMs: number;
  /** From the latest probe, and younger than three probe intervals. */
  fresh: boolean;
  softwareVersion: string; protocolVersion: TrustedRunnerHealth["protocolVersion"];
  lifecycle: TrustedRunnerHealth["lifecycle"]; draining: boolean; error: string | null;
  /** Machines the runner hosts now, and its effective bound. */
  activeVms: number; runningVms: number; maxActiveVms: number;
  retainedVms: number; retainedBytes: number;
  /** As the runner names it (`linux-x86_64`, `macos-aarch64`); null when the
   * report predates cubed keeping it. */
  platform: string | null; os: string | null; arch: string | null;
  /** The accelerator the runner requires before it serves (KVM or HVF). */
  accelerator: "kvm" | "hvf" | null;
  capabilities: string[] | null;
  /** The largest machine the runner accepts. */
  vmLimits: { maxVcpus: number; maxMemoryMiB: number; maxDiskGiB: number } | null;
}

export interface RunnerObservation {
  id: string; nodeId: string; enrolledAt: number | null;
  /** `host`: berth host (protocol 4), unsandboxed; it takes only the
   * threads started on it by name and is never part of the pool. */
  kind: "vm" | "host";
  contact: { status: RunnerContactStatus; lastAttemptAt: number | null; lastContactAt: number | null; unreachableSince: number | null; error: string | null };
  /** The last report the runner sent; null if it never answered. */
  report: RunnerReport | null;
  /** cubed's admission: every open thread reserves a slot until it is
   * archived. `total` is the runner's last advertised bound, or 1 assumed
   * when it never advertised one (runners before 0.7.0). */
  slots: { total: number; totalSource: "reported" | "assumed"; reserved: number; free: number; allocatable: boolean };
  retirement: "none" | "retiring" | "retired";
  unknown: string[];
}

export interface RunnersObservation {
  observedAt: number; probeIntervalMs: number;
  pool: { runners: number; allocatable: number; slots: number; reserved: number; free: number };
  runners: RunnerObservation[];
  notReported: readonly string[];
}

const PLATFORMS: Record<string, { os: string; arch: string; accelerator: "kvm" | "hvf" }> = {
  "linux-x86_64": { os: "linux", arch: "x86_64", accelerator: "kvm" },
  "macos-aarch64": { os: "macos", arch: "aarch64", accelerator: "hvf" },
};

export function observeRunners(registry: Registry, probeIntervalMs: number, now = Date.now()): RunnersObservation {
  const runners = new Map(registry.listRunners().map(runner => [runner.threadId, runner]));
  const observed = registry.runnerStatuses(now).map((status): RunnerObservation => {
    const runner = runners.get(status.id);
    // The current health, if a probe succeeded last, may be newer than the
    // kept report: one recorded before cubed kept reports, or by an older cubed.
    const current = status.health && status.lastContactAt ? { at: status.lastContactAt, health: status.health } : null;
    const last = runner?.report && (!current || runner.report.at >= current.at) ? runner.report : current;
    const unknown: string[] = [];
    let report: RunnerReport | null = null;
    if (last) {
      const health = last.health;
      const host = runner?.kind === "host";
      const known = health.platform && !host ? PLATFORMS[health.platform] : undefined;
      const [hostOs, hostArch] = host && health.platform ? health.platform.split("-") : [];
      const ageMs = Math.max(0, now - last.at);
      report = {
        at: last.at, ageMs, fresh: status.contactStatus === "reachable" && last.at >= (status.lastContactAt ?? 0) && ageMs <= FRESH_INTERVALS * probeIntervalMs,
        softwareVersion: health.softwareVersion, protocolVersion: health.protocolVersion,
        lifecycle: health.lifecycle, draining: health.draining, error: health.error,
        activeVms: health.activeVms, runningVms: health.runningVms, maxActiveVms: health.maxActiveVms,
        retainedVms: health.retainedVms, retainedBytes: health.retainedBytes,
        platform: health.platform ?? null, os: known?.os ?? hostOs ?? null, arch: known?.arch ?? hostArch ?? null, accelerator: known?.accelerator ?? null,
        capabilities: health.capabilities ? [...health.capabilities] : null,
        vmLimits: health.limits ? { maxVcpus: health.limits.maxVcpus, maxMemoryMiB: health.limits.maxMemoryMiB, maxDiskGiB: health.limits.maxDiskGiB } : null,
      };
      if (!health.platform) unknown.push("platform, capabilities and machine limits: the last report predates cubed keeping them; the next probe fills them in");
      else if (!known && !host) unknown.push(`os, architecture and accelerator: platform ${health.platform} is not one cubed knows`);
      if (!report.fresh) unknown.push("current state: the report below is the last one received, not the runner's state now");
    } else unknown.push("everything the runner reports (version, platform, lifecycle, machines): it has not answered a probe");
    const retirement = status.retiredAt ? "retired" : status.allocationState === "retiring" ? "retiring" : "none";
    const kind = runner?.kind === "host" ? "host" : "vm";
    // The pool: what a thread started without naming a runner may get.
    const allocatable = retirement === "none" && kind === "vm";
    const total = status.maxActiveVms;
    return {
      id: status.id, nodeId: status.nodeId, enrolledAt: status.enrolledAt, kind,
      contact: { status: status.contactStatus, lastAttemptAt: status.lastAttemptAt, lastContactAt: status.lastContactAt,
        unreachableSince: status.unreachableSince, error: status.error },
      report,
      slots: { total, totalSource: runner?.maxActiveVms === undefined ? "assumed" : "reported", reserved: status.activeThreads,
        free: allocatable || (kind === "host" && retirement === "none") ? Math.max(0, total - status.activeThreads) : 0, allocatable },
      retirement, unknown,
    };
  });
  const active = observed.filter(runner => runner.retirement !== "retired");
  const allocatable = observed.filter(runner => runner.slots.allocatable);
  return {
    observedAt: now, probeIntervalMs,
    pool: { runners: active.length, allocatable: allocatable.length,
      slots: allocatable.reduce((sum, runner) => sum + runner.slots.total, 0),
      reserved: allocatable.reduce((sum, runner) => sum + runner.slots.reserved, 0),
      free: allocatable.reduce((sum, runner) => sum + runner.slots.free, 0) },
    runners: observed,
    notReported: NOT_REPORTED,
  };
}

const ago = (ms: number) => ms < 90_000 ? `${Math.round(ms / 1000)} s ago` : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)} min ago`
  : ms < 36 * 3600_000 ? `${Math.round(ms / 3600_000)} h ago` : `${Math.round(ms / 86_400_000)} d ago`;

/** A runner error code as is; other probe failures can name local files
 * (the runner's config), which stay in the operator's API. */
const errorCode = (error: string) => /^[A-Z_]{3,40}$/.test(error) ? error : "probe failed; details in /api/runners";

/** The observation as text for a model: facts first, unknowns spelled out. */
export function describeRunners(view: RunnersObservation): string {
  const listed = view.runners.filter(runner => runner.retirement !== "retired");
  if (!listed.length) return "no runners enrolled";
  const lines = [`runners as cubed last heard from them (probed every ${Math.round(view.probeIntervalMs / 60_000) || "<1"} min; nothing below is inferred from a release being published):`];
  for (const runner of listed) {
    const { report, contact, slots } = runner;
    lines.push(`- ${runner.nodeId} (id ${runner.id}${runner.retirement === "retiring" ? "; retiring" : ""})`);
    if (runner.kind === "host") {
      lines.push("  HOST runner (berth host, protocol 4): UNSANDBOXED, commands run as the user who started it on that host, with "
        + "that user's files and gh/git logins; only for developing cube runners. It takes only threads started on it by name "
        + "(spawn with runner), never others; while it is down, its threads wait.");
    }
    const contactText = contact.status === "reachable" ? "reachable"
      : contact.status === "unknown" ? "not probed yet"
      : `${contact.status}${contact.unreachableSince ? ` since ${ago(view.observedAt - contact.unreachableSince)}` : ""}${contact.error ? ` (${errorCode(contact.error)})` : ""}`;
    lines.push(`  contact: ${contactText}; last answer ${contact.lastContactAt ? ago(view.observedAt - contact.lastContactAt) : "never"}`);
    if (report) {
      lines.push(`  ${report.fresh ? "reported" : `last reported ${ago(report.ageMs)} (stale)`}: cube-runner ${report.softwareVersion}, protocol ${report.protocolVersion}, `
        + `${report.platform ? `${report.platform}${report.accelerator ? ` with ${report.accelerator.toUpperCase()}` : ""}` : "platform unknown"}, `
        + `lifecycle ${report.lifecycle}${report.draining ? " (draining: refuses new machines)" : ""}${report.error ? `, error ${report.error}` : ""}`);
      lines.push(`  machines on the runner: ${report.activeVms} active, ${report.runningVms} running, at most ${report.maxActiveVms} at once (its effective bound); `
        + `${report.retainedVms} retained disks`);
      if (report.vmLimits) lines.push(`  largest machine: ${report.vmLimits.maxVcpus} vCPUs, ${report.vmLimits.maxMemoryMiB} MiB, ${report.vmLimits.maxDiskGiB} GiB disk`);
    }
    lines.push(`  cubed's slots: ${slots.reserved} reserved by open threads of ${slots.total}${slots.totalSource === "assumed" ? " (assumed: the runner never advertised a bound)" : ""}, `
      + `${slots.allocatable ? `${slots.free} free` : runner.kind === "host" && runner.retirement === "none" ? `${slots.free} free for threads started on it by name` : "not taking threads"}`);
    for (const item of runner.unknown) lines.push(`  unknown: ${item}`);
  }
  lines.push(`pool: ${view.pool.free} of ${view.pool.slots} slots free across ${view.pool.allocatable} runners taking threads`);
  lines.push(`unknown for every runner (not in the runner protocol):\n${view.notReported.map(item => `- ${item}`).join("\n")}`);
  return lines.join("\n");
}
