/** What a thread's machine is to cubed, whatever runner hosts it
 * (runner-machines.ts, protocol 4): the ThreadMachines contract, the
 * machine's epoch, and the scripts cubed runs in it.
 *
 * Provisioning (the pinned repository checkouts) and the release check are
 * ordinary workspace commands under the thread's lease and fixed keys, so
 * they are journaled in the guest like every agent command. */
import fs from "node:fs";
import type { Duplex } from "node:stream";
import path from "node:path";
import { STEP_LOG_BYTES, type CommandMemory, type HookOutcome, type Registry, type Thread, type WorkspaceAllocation } from "./registry.ts";
import type { GuestTransport } from "./guest-transport.ts";
import { keelGuest, type GuestPortal, type VmWorkspace } from "./vm-workspace.ts";
import { shippedHelper } from "./vm-seed.ts";
import { clean, type MachineEvidence } from "./vm-diagnostics.ts";
import { skillInstallScripts } from "./skills.ts";
import { settleOperation, WorkspaceError, type WorkspaceOwner } from "./workspace.ts";

/** What Conversations needs from a thread's machine. */
export interface ThreadMachines {
  /** How cubed reaches the thread's guest helper. */
  guest(thread: Thread): GuestTransport;
  /** Boot or re-attach the machine; resolves once its guest answers ready.
   * `booted` says this call started the machine (a first boot or a boot
   * after it had stopped), not only re-attached a running one. `onBoot` is
   * called once the call goes past checking a machine this process already
   * runs: it boots or re-attaches the machine (which may take minutes). */
  start(thread: Thread, options?: StartOptions): Promise<MachineStart | void>;
  /** Stops new machines from using a template (its setup changed). */
  invalidateTemplate?(thread: Thread, templateId: string): Promise<void>;
  /** Release the machine; `retain` keeps its disk. The runner always keeps
   * an interrupted or failed one. */
  release(thread: Thread, retain: boolean): Promise<{ retained: boolean }>;
  /** Deletes an archived thread's retained disk. */
  discard(thread: Thread): Promise<void>;
  close(): Promise<void>;
  /** Whether this process has the thread's machine running and attached;
   * never starts one (the portal must not wake a machine). */
  running?(thread: Thread): boolean;
  /** A TCP connection to a port of the thread's running machine, for the
   * portal (a protocol-4 runner allows 1024-65535). */
  dial?(thread: Thread, port: number): Promise<Duplex>;
  /** Suspend (S-7a, P7-5; runner-machines.ts): whether the thread's machine
   * is suspended; suspend it when idle and `busy` finds nothing running;
   * wake it; something happened for it now (its idle time starts again).
   * Only protocol-4 VM runners suspend. */
  suspended?(thread: Thread): boolean;
  suspendIfIdle?(thread: Thread, busy: () => Promise<string | null>): Promise<boolean>;
  wake?(thread: Thread): Promise<void>;
  touch?(thread: Thread): void;
  /** Whether a start or a wake of the thread's machine is under way in this
   * process (the owner of a `waking` it recorded). */
  wakeInFlight?(thread: Thread): boolean;
  /** Wakes a suspended machine for cubed's own check if a slot is free now;
   * null once it runs, otherwise why it stays suspended. Never waits. */
  wakeNow?(thread: Thread): Promise<string | null>;
  /** A `waking` no one in this process owns (a restart cut the wake short):
   * the runner's own phase is recorded instead, and nothing is started. */
  settleWake?(thread: Thread): Promise<void>;
  /** A new message asks for the machine: its run's first guest call waits
   * for a slot the whole time again, even if an earlier run's wait gave up. */
  renewWake?(thread: Thread): void;
  /** Read-only evidence about the thread's machine (vm-diagnostics.ts);
   * never starts, stops or attaches it. */
  diagnose?(thread: Thread): Promise<MachineEvidence>;
  /** The end of the log of the hook running now in the thread's template
   * build machine or its own machine; null when neither is reachable. Read
   * only, with no lease: it never waits for or disturbs the preparation. */
  startupLog?(thread: Thread): Promise<StartupLog | null>;
}

/** The hook running now in a machine (from ~/.cache/cube/running) and the
 * end of its log, escaped and redacted. */
export interface StartupLog { machine: "build" | "thread"; hook: string | null; text: string; bytes: number; truncated: boolean }
/** Where the guest's hooks write their logs (the seed's user `agent`). */
const HOOK_LOGS = "/home/agent/.cache/cube";
/** How much of a hook's log the thread shows. */
export const STARTUP_LOG_BYTES = 16 * 1024;

/** The hook running now in a machine and the end of its log, read with the
 * guest's `read`, which is not fenced: it needs no lease and changes nothing.
 * `logs`: the hooks' log directory in that machine. */
export async function readStartupLog(transport: GuestTransport, machine: StartupLog["machine"], logs = HOOK_LOGS): Promise<StartupLog> {
  const read = async (file: string, offset: number, limit: number) => {
    const answer = await transport.call("read", { path: `${logs}/${file}`, offset, limit }, { timeoutMs: 10000 });
    const error = answer.header.error as { code?: unknown; message?: unknown } | undefined;
    if (error && typeof error === "object") {
      if (error.code === "NOT_FOUND") return null;
      throw new Error(`reading ${file} failed: ${String(error.message ?? error.code)}`);
    }
    if (!Number.isSafeInteger(answer.header.size)) throw new Error("the guest helper's answer is malformed");
    return { size: answer.header.size as number, content: Buffer.from(answer.body) };
  };
  const running = await read("running", 0, 256);
  const [hook, log] = running ? running.content.toString("utf8").trim().split(" ") : [];
  if (!hook || !log || !/^[a-z-]{1,32}$/.test(hook) || !/^[a-z-]{1,32}\.log$/.test(log)) return { machine, hook: null, text: "", bytes: 0, truncated: false };
  // The size and the text come from the same read: a next try moves the
  // log aside (to .prev) at any moment.
  let offset = 0;
  let tail = await read(log, 0, STARTUP_LOG_BYTES);
  if (tail && tail.size > STARTUP_LOG_BYTES) {
    const end = await read(log, tail.size - STARTUP_LOG_BYTES, STARTUP_LOG_BYTES);
    if (end && end.size >= STARTUP_LOG_BYTES) { offset = tail.size - STARTUP_LOG_BYTES; tail = end; }
  }
  let text = tail ? tail.content.toString("utf8") : "";
  // From the first whole line when the start was cut off.
  if (offset > 0) text = text.slice(text.indexOf("\n") + 1);
  return { machine, hook, text: clean(text, STARTUP_LOG_BYTES * 4), bytes: tail?.size ?? 0, truncated: offset > 0 };
}

export interface MachineStart { booted: boolean }
export interface StartOptions {
  onBoot?: () => void;
  /** Never wait for a slot: a suspended machine its runner has no slot for
   * now stays suspended (RunnerWait), not waiting. */
  once?: boolean;
}

export interface VmSizes { vcpus: number; memoryMiB: number; diskGiB: number }
export const DEFAULT_VM_SIZES: VmSizes = { vcpus: 2, memoryMiB: 4096, diskGiB: 32 };

/** VM sizes from CUBED_VM_VCPUS, CUBED_VM_MEMORY_MIB and CUBED_VM_DISK_GIB. */
export function vmSizes(env: NodeJS.ProcessEnv = process.env): VmSizes {
  const read = (name: string, fallback: number) => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  return { vcpus: read("CUBED_VM_VCPUS", DEFAULT_VM_SIZES.vcpus), memoryMiB: read("CUBED_VM_MEMORY_MIB", DEFAULT_VM_SIZES.memoryMiB),
    diskGiB: read("CUBED_VM_DISK_GIB", DEFAULT_VM_SIZES.diskGiB) };
}

/** A thread's VM epoch, kept in `<directory>/epoch`: increasing for every
 * runner mutation, and at least the wall clock, so a lost file still fences
 * an older cubed. */
export function nextMachineEpoch(directory: string): number {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "epoch");
  const next = Math.max(currentMachineEpoch(directory) + 1, Date.now());
  fs.writeFileSync(`${file}.tmp`, String(next), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  return next;
}
/** The newest epoch `nextMachineEpoch` gave out (0: none yet). */
export function currentMachineEpoch(directory: string): number {
  const file = path.join(directory, "epoch");
  return fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8").trim()) || 0 : 0;
}

/** The thread's machine waits for a runner: none with a free slot can take
 * it now, or the runner that has (or may have) it does not answer. Not a
 * failure of the thread; cubed's recovery loop tries again. */
export class RunnerWait extends Error {
  /** A VM runner does not answer (rather than being full): a new thread's
   * start waits for it only so long (Conversations, RUNNER_WAIT_MS). A host
   * runner runs only while someone runs it; its threads wait (AGENTS.md). */
  readonly unanswered: boolean;
  constructor(message: string, options?: ErrorOptions & { unanswered?: boolean }) { super(message, options); this.name = "RunnerWait"; this.unanswered = !!options?.unanswered; }
}
/** An error as a runner observation records it. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The thread (and placeholders) a machine belongs to, for the egress
 * policy: a thread's own machine or its unfinished template build machine. */
export function machineFor(registry: Registry, vmId: string): { threadId: string; placeholders: Record<string, string> } | null {
  const thread = registry.threadByVm(vmId);
  if (thread?.vm && !thread.archived) return { threadId: thread.id, placeholders: thread.vm.placeholders };
  const building = registry.threadByBuildVm(vmId);
  if (building?.vm?.build && !building.archived) return { threadId: building.id, placeholders: building.vm.build.placeholders };
  return null;
}

function quote(value: string): string { return `'${value.replace(/'/g, "'\\''")}'`; }

/** Repository checkouts of an allocation, relative to /workspace: the
 * primary is the workspace itself, references live in ../repos/<name>. */
function checkouts(allocation: WorkspaceAllocation): Array<{ dir: string; url: string; ref: string; oid: string }> {
  return allocation.repositories.map((repository, index) => ({
    dir: index === 0 ? "." : `../repos/${repository.checkoutName}`,
    url: repository.url,
    ref: repository.base.startsWith("refs/heads/") ? repository.base : `refs/heads/${repository.base}`,
    oid: repository.baseOid,
  }));
}

/** Shell helpers shared by the preparation and resume scripts. `hook NAME
 * FILE LOG` runs FILE (if it is executable) as the agent's account in
 * /workspace with its output in ~/.cache/cube/LOG (the previous try's moves
 * to LOG.prev; $CUBE_LOGS in place of ~/.cache/cube when set) and prints
 * `cube-hook NAME ok|failed:<exit>|absent <ms>`; the
 * same line, with the time it ended, goes to ~/.cache/cube/NAME.status for
 * `cube hooks`. While it runs, `cube-hook-start NAME` is printed and
 * ~/.cache/cube/running names it and its log (what the thread shows live). */
const HOOK_SHELL = [
  // A host machine (berth host) keeps its logs in its own directory.
  "logs=\"${CUBE_LOGS:-${HOME:-/tmp}/.cache/cube}\"",
  "hooks=\"${CUBE_HOOKS:-/etc/cube/hooks}\"",
  "mkdir -p \"$logs\"",
  // A hook killed with its command (out of memory) left its marker: nothing runs yet.
  "rm -f \"$logs/running\"",
  "ms() { if [ -n \"${EPOCHREALTIME:-}\" ]; then t=${EPOCHREALTIME/[.,]/}; echo $((10#$t / 1000)); else echo $(( $(date +%s) * 1000 )); fi; }",
  "outcome() { echo \"cube-hook $1 $2 $3\"; echo \"$2 $3 $(ms)\" >\"$logs/$1.status\" 2>/dev/null || true; }",
  "hook() {",
  "  name=$1 file=$2 log=\"$logs/$3\"",
  "  if [ ! -x \"$file\" ]; then outcome \"$name\" absent 0; return 0; fi",
  "  if [ -e \"$log\" ]; then mv -f \"$log\" \"$log.prev\"; fi",
  "  echo \"cube-hook-start $name\"; echo \"$name $3\" >\"$logs/running\"",
  "  start=$(ms)",
  "  \"$file\" >\"$log\" 2>&1 </dev/null; code=$?",
  "  rm -f \"$logs/running\"",
  "  if [ \"$code\" -eq 0 ]; then outcome \"$name\" ok $(( $(ms) - start )); return 0; fi",
  "  outcome \"$name\" \"failed:$code\" $(( $(ms) - start ))",
  "  echo \"$name failed (exit $code); see $log\"; tail -n 20 \"$log\"",
  "  return 1",
  "}",
];

/** How a machine's workspace is prepared:
 * - `fresh` (a base-image disk, or a template build machine): check out the
 *   pinned commits, then the external pre-setup hook, then the repository's
 *   `.agents/setup` (only if pre-setup succeeded).
 * - `template` (an overlay on a template): bring the template's checkouts to
 *   the thread's pinned commits; pre-setup and setup are skipped, unless the
 *   pinned `.agents/setup` differs from the one the template ran
 *   (`setupBlob`), then both run here and the template is stale.
 * Hooks may fail without failing the thread (the agent can read the logs);
 * a checkout that fails does. */
export type PreparationMode = { kind: "fresh" } | { kind: "template"; setupBlob: string };

export function preparationScript(allocation: WorkspaceAllocation, mode: PreparationMode = { kind: "fresh" }): string {
  const items = checkouts(allocation);
  const lines = [
    "set -eu",
    "export GIT_TERMINAL_PROMPT=0",
    "checkout() {",
    "  dir=$1 url=$2 ref=$3 oid=$4",
    "  mkdir -p \"$dir\"",
    "  git -C \"$dir\" init -q",
    "  git -C \"$dir\" remote remove origin 2>/dev/null || true",
    "  git -C \"$dir\" remote add origin \"$url\"",
    "  git -C \"$dir\" fetch -q --no-tags origin \"+$ref:refs/remotes/origin/${ref#refs/heads/}\"",
    "  git -C \"$dir\" cat-file -e \"$oid^{commit}\" || { echo \"pinned commit $oid is not on $ref\"; exit 3; }",
    // -f: a template's checkout may hold what its setup changed.
    "  git -C \"$dir\" -c advice.detachedHead=false checkout -q -f --detach \"$oid\"",
    // A template's own history must not look like this thread's work.
    ...(mode.kind === "template" ? ["  git -C \"$dir\" reflog expire --expire=now --all"] : []),
    "}",
    ...items.map(item => `checkout ${quote(item.dir)} ${quote(item.url)} ${quote(item.ref)} ${quote(item.oid)}`),
    "set +e",
    ...HOOK_SHELL,
    "blob=$(git rev-parse -q --verify 'HEAD:.agents/setup' 2>/dev/null || echo none)",
    "echo \"cube-setup-blob $blob\"",
    "prepare() {",
    "  if hook pre-setup \"$hooks/pre-setup\" pre-setup.log; then hook setup .agents/setup setup.log",
    "  else outcome setup notrun 0; fi",
    "}",
    ...(mode.kind === "template"
      ? [`if [ "$blob" = ${quote(mode.setupBlob)} ]; then outcome pre-setup skipped 0; outcome setup skipped 0`,
        "else echo \"cube-template stale\"; prepare; fi"]
      : ["prepare"]),
    "echo provisioned",
  ];
  return lines.join("\n");
}

/** The checkout and setup of a machine made from the base image. */
export function provisionScript(allocation: WorkspaceAllocation): string { return preparationScript(allocation, { kind: "fresh" }); }

/** The resume hooks: the external pre-resume hook, then the repository's
 * `.agents/resume` (only if pre-resume succeeded). Once per machine boot,
 * before the agent uses the machine: a marker on a tmpfs records that this
 * boot resumed, and a lock keeps a second try from running beside a first
 * one that a cubed restart left running. First it reports keel's check of
 * Java's system keystore at this boot's setup (keel/agent `keystore.rs`,
 * one line in /run/cube/runner-ca, there only when the machine has the
 * keystore) as the outcome `runner-ca`: `ok` (it holds the runner's CA, or
 * keel added it), `skipped` (left alone on purpose, or a format keel does
 * not read) or `failed` (it lacks the CA and keel could not add it), the
 * line in ~/.cache/cube/runner-ca.log; without the line an earlier boot's
 * outcome goes. */
export function resumeScript(): string {
  return [
    "set -u",
    ...HOOK_SHELL,
    "run=\"${CUBE_RUN:-/dev/shm/cube}\"",
    "mkdir -p \"$run\"",
    "exec 9>\"$run/resume.lock\"",
    "command -v flock >/dev/null 2>&1 && flock 9",
    "if [ -e \"$run/resumed\" ]; then echo \"cube-resume already\"; exit 0; fi",
    "note=\"${CUBE_RUNNER_CA:-/run/cube/runner-ca}\"",
    "if [ -r \"$note\" ] && IFS=' ' read -r ca_outcome ca_detail <\"$note\"; then",
    "  printf '%s %s\\n' \"$ca_outcome\" \"$ca_detail\" >\"$logs/runner-ca.log\" 2>/dev/null",
    "  case \"$ca_outcome\" in",
    "    ok|repaired) outcome runner-ca ok 0 ;;",
    "    skipped) outcome runner-ca skipped 0 ;;",
    "    *) outcome runner-ca failed:1 0; echo \"runner-ca failed (exit 1); see $logs/runner-ca.log\"; printf '%s\\n' \"$ca_detail\" ;;",
    "  esac",
    // No keystore at this boot: an earlier boot's outcome is not this one's.
    "else rm -f \"$logs/runner-ca.status\" \"$logs/runner-ca.log\"",
    "fi",
    "if hook pre-resume \"$hooks/pre-resume\" pre-resume.log; then hook resume .agents/resume resume.log",
    "else outcome resume notrun 0; fi",
    ": >\"$run/resumed\"",
    "echo resumed",
  ].join("\n");
}

export interface PreparationOutcome {
  hooks: Record<string, HookOutcome>;
  /** The command's memory when it ended (a guest helper that reports it). */
  memory?: CommandMemory;
  /** The end of the failed hook's log, as the script printed it. */
  log?: string;
  /** The hook that had started and not ended when the command stopped. */
  running?: string;
  /** The primary checkout's `.agents/setup` blob ("none" without one). */
  setupBlob?: string;
  /** A template's setup differed from the pinned one; setup ran here. */
  stale: boolean;
  /** The checkout (or the command) failed. */
  error?: string;
}

/** Reads the `cube-hook` lines of a preparation or resume command. */
export function preparationOutcome(state: Awaited<ReturnType<typeof settleOperation>>, at = Date.now()): PreparationOutcome {
  if (state.state !== "succeeded") return { hooks: {}, stale: false, error: `the command did not finish (${state.state})` };
  const text = Buffer.from(state.output).toString("utf8");
  const hooks: Record<string, HookOutcome> = {};
  let setupBlob: string | undefined;
  // The hook that had started and not ended when the command stopped.
  let running: string | undefined;
  // The lines the script printed of the last hook that failed.
  let failureLog: string[] | null = null;
  let capturing = false;
  for (const line of text.split("\n")) {
    if (/^[a-z-]+ failed \(exit \d+\); see /.test(line)) { failureLog = []; capturing = true; continue; }
    if (line.startsWith("cube-") || line === "provisioned" || line === "resumed") capturing = false;
    else if (capturing) failureLog!.push(line);
    const started = /^cube-hook-start ([a-z-]+)$/.exec(line.trim());
    if (started) running = started[1];
    const hook = /^cube-hook ([a-z-]+) (ok|absent|skipped|notrun|failed:(\d+)) (\d+)$/.exec(line.trim());
    if (hook) {
      const status = hook[2].startsWith("failed") ? "failed" : hook[2] as HookOutcome["status"];
      hooks[hook[1]] = { status, ms: Number(hook[4]), at, ...(hook[3] ? { exitCode: Number(hook[3]) } : {}) };
      if (hook[1] === running) running = undefined;
    }
    const blob = /^cube-setup-blob ([0-9a-f]{40}|[0-9a-f]{64}|none)$/.exec(line.trim());
    if (blob) setupBlob = blob[1];
  }
  const stale = /^cube-template stale$/m.test(text);
  const memory = { ...(state.memory ? { memory: state.memory } : {}), ...(failureLog?.join("\n").trim() ? { log: stepLog(failureLog.join("\n")) } : {}),
    ...(running ? { running } : {}) };
  if (state.exitCode !== 0) {
    const what = running ?? "the preparation";
    const stopped = stoppedBecause(state);
    if (stopped) return { hooks, stale, ...(setupBlob ? { setupBlob } : {}), ...memory, error: `${what} was stopped: ${stopped}` };
    const tail = text.trim().split("\n").filter(line => !line.startsWith("cube-")).slice(-4).join("; ");
    return { hooks, stale, ...(setupBlob ? { setupBlob } : {}), ...memory, error: `checking out the project failed${tail ? `: ${tail}` : ""}` };
  }
  return { hooks, stale, ...(setupBlob ? { setupBlob } : {}), ...memory };
}

/** Why a command that did not exit on its own stopped, in words; null for
 * one that exited with its own status. */
export function stoppedBecause(state: { exitCode: number | null; termination: string; serviceResult?: string; memory?: CommandMemory }): string | null {
  const oom = state.serviceResult === "oom-kill" || (state.exitCode === null && (state.memory?.oomKills ?? 0) > 0);
  if (oom) return `the machine ran out of memory${state.memory ? ` (this command used up to ${gib(state.memory.peakBytes)}; the machine has ${gib(state.memory.totalBytes)})` : ""}`;
  if (state.termination === "timedOut") return "it did not finish within 30 minutes";
  if (state.exitCode === null) return `it was killed${state.serviceResult && !["success", "exit-code", "signal"].includes(state.serviceResult) ? ` (${state.serviceResult})` : " by a signal"}`;
  return null;
}

/** A step that failed, with the memory its command reported and the end
 * of the failed hook's log. */
export class StepFailure extends Error {
  readonly memory: CommandMemory | undefined;
  log: string | undefined;
  constructor(message: string, memory?: CommandMemory, log?: string) { super(message); this.name = "StepFailure"; this.memory = memory; this.log = log; }
}

/** The last lines of a log as a step keeps them: escaped, redacted, bounded. */
export function stepLog(text: string): string {
  return clean(text.trimEnd().split("\n").slice(-20).join("\n"), STEP_LOG_BYTES * 2).slice(-STEP_LOG_BYTES);
}

export const MIB = 1024 * 1024;
/** Bytes as GB with one decimal ("3.5 GB"), or MB below one GB. */
export function gib(bytes: number): string {
  return bytes >= 1024 * MIB ? `${(bytes / (1024 * MIB)).toFixed(1)} GB` : `${Math.round(bytes / MIB)} MB`;
}
/** The release check: clean means nothing in the workspace is lost with the
 * disk. Every checkout has no uncommitted changes (ignored files aside) and
 * no stashes, and every commit it has (branches, tags, HEAD, and the reflog:
 * a commit left behind by a checkout is still work) is the pinned one's
 * history or was on a remote: pushed, fetched or once at a remote-tracking
 * ref. Its own branches and a HEAD away from the pin are fine. An empty
 * project's /workspace holds only such checkouts. No other command runs.
 * Prints `clean` or `dirty: <reason>`. */
export function releaseCheckScript(allocation: WorkspaceAllocation): string {
  const items = checkouts(allocation);
  const lines = [
    "set -u",
    "dirty() { echo \"dirty: $*\"; exit 0; }",
    // What a remote has or had: the remote-tracking refs' reflogs (a branch force-pushed since).
    "published() {",
    "  [ -z \"$2\" ] || echo \"^$2\"",
    "  git -C \"$1\" for-each-ref --format='%(refname)' refs/remotes | while read -r ref; do git -C \"$1\" reflog show --format='^%H' \"$ref\" -- 2>/dev/null; done",
    "}",
    "check() {",
    "  dir=$1 oid=$2",
    "  [ -e \"$dir/.git\" ] || dirty \"$dir is not a checkout\"",
    "  [ -z \"$(git -C \"$dir\" status --porcelain 2>&1)\" ] || dirty \"$dir has uncommitted changes\"",
    "  [ -z \"$(git -C \"$dir\" stash list 2>&1)\" ] || dirty \"$dir has stashes\"",
    "  [ -z \"$(published \"$dir\" \"$oid\" | git -C \"$dir\" rev-list --all --reflog --not --remotes --not --stdin 2>&1)\" ] || dirty \"$dir has commits that are not pushed\"",
    "}",
    ...(items.length ? items.map(item => `check ${quote(item.dir)} ${quote(item.oid)}`)
      : ["for entry in .[!.]* ..?* *; do",
        "  [ -e \"$entry\" ] || [ -L \"$entry\" ] || continue",
        "  [ -e \"$entry/.git\" ] || dirty \"the workspace is not empty: $entry is not a checkout\"",
        "  check \"$entry\" ''",
        "done"]),
    "if command -v systemctl >/dev/null 2>&1; then",
    "  running=$(systemctl list-units --plain --no-legend --state=active,activating,deactivating 'cube-op-*' 2>/dev/null | wc -l)",
    "  [ \"$running\" -le 1 ] || dirty \"another command is still running\"",
    "fi",
    "echo clean",
  ];
  return lines.join("\n");
}

/** Runs one of cubed's own commands in the thread workspace under a fresh
 * lease and a fixed key; reattaches to it when the key already ran. These
 * are not the agent's changes. */
async function own(workspace: VmWorkspace, owner: WorkspaceOwner, key: string | ((epoch: number) => string), command: string, timeoutMs: number) {
  const lease = await workspace.lease({ owner });
  try {
    if (typeof key !== "string") key = key(lease.epoch);
    await workspace.execOwn(lease.token, key, { command, timeoutMs });
    return await settleOperation(workspace, lease.token, key);
  } finally { await workspace.release(lease.token).catch(() => {}); }
}

/** Checks out the thread's pinned repositories once and prepares the
 * workspace (see `preparationScript`). `attempt` numbers the try: a failed
 * one is never rerun under its key, a new try gets a new key. */
export async function provisionWorkspace(workspace: VmWorkspace, owner: WorkspaceOwner, allocation: WorkspaceAllocation, attempt: number,
  mode: PreparationMode = { kind: "fresh" }): Promise<PreparationOutcome> {
  // The skills first: a try that checked out is not run again (`provisioned`).
  if (allocation.skills) {
    for (const [index, script] of skillInstallScripts(allocation.skills).entries()) {
      const installed = await own(workspace, owner, `cube:skills:${attempt}:${index}`, script, 600000);
      if (installed.state !== "succeeded") throw new StepFailure(`installing the thread's skills did not finish (${installed.state})`);
      if (installed.exitCode !== 0) {
        const output = Buffer.from(installed.output).toString("utf8").trim().split("\n").slice(-3).join("; ");
        throw new StepFailure(`installing the thread's skills failed (exit ${installed.exitCode}): ${output}`);
      }
    }
  }
  const state = await own(workspace, owner, `cube:provision:${attempt}`, preparationScript(allocation, mode), 1800000);
  const outcome = preparationOutcome(state);
  if (outcome.error) throw new StepFailure(outcome.error, outcome.memory, outcome.log);
  return outcome;
}

/** The outcome of a provisioning try that already ran (null: none ran
 * under this key; a try still running is waited for). */
export async function provisioned(workspace: VmWorkspace, owner: WorkspaceOwner, attempt: number): Promise<PreparationOutcome | null> {
  const lease = await workspace.lease({ owner });
  try {
    return preparationOutcome(await settleOperation(workspace, lease.token, `cube:provision:${attempt}`));
  } catch (error) {
    if (error instanceof WorkspaceError && error.code === "NOT_FOUND") return null;
    throw error;
  } finally { await workspace.release(lease.token).catch(() => {}); }
}

/** Runs the resume hooks for this boot of the machine (see `resumeScript`). */
export async function resumeWorkspace(workspace: VmWorkspace, owner: WorkspaceOwner): Promise<{ hooks: Record<string, HookOutcome>; already: boolean; memory?: CommandMemory; log?: string }> {
  const state = await own(workspace, owner, epoch => `cube:resume:${epoch}`, resumeScript(), 1800000);
  const outcome = preparationOutcome(state);
  if (outcome.error) throw new StepFailure(outcome.error.replace("checking out the project failed", "the resume hooks did not run").replace("the preparation was", "the resume hooks were"), outcome.memory, outcome.log);
  return { hooks: outcome.hooks, already: state.state === "succeeded" && /^cube-resume already$/m.test(Buffer.from(state.output).toString("utf8")),
    ...(outcome.memory ? { memory: outcome.memory } : {}), ...(outcome.log ? { log: outcome.log } : {}) };
}

/** Brings a `berth host` machine's guest helper, and with it the agent's
 * `cube` command, to the one this cubed ships, then tells it the portal's
 * settings. A keel machine's cube-agent comes with its image and is never
 * replaced: it only gets the portal's settings. Runs with the workspace
 * lease free (before the agent opens). */
export async function refreshGuest(workspace: VmWorkspace, portal: GuestPortal): Promise<"current" | "installed"> {
  const shipped = shippedHelper();
  const description = await workspace.describe();
  let outcome: "current" | "installed" = "current";
  if (!keelGuest(description) && description.build !== shipped.sha256) {
    if (!description.capabilities.includes("helper.install")) throw new Error("the machine's guest helper cannot be replaced (no helper.install)");
    await workspace.installHelper(shipped.source);
    outcome = "installed";
    const after = await workspace.describe();
    if (after.build !== shipped.sha256) throw new Error("the machine still runs another guest helper");
  }
  await workspace.configurePortal(portal);
  return outcome;
}

/** What the machine reports about its work at archive: `clean` releases the
 * disk, any other answer keeps it (see Conversations.archive). */
export async function releaseCheck(workspace: VmWorkspace, owner: WorkspaceOwner, allocation: WorkspaceAllocation): Promise<{ clean: boolean; reason: string }> {
  const state = await own(workspace, owner, epoch => `cube:release-check:${epoch}`, releaseCheckScript(allocation), 120000);
  if (state.state !== "succeeded" || state.exitCode !== 0) return { clean: false, reason: `the release check did not finish (${state.state})` };
  const output = Buffer.from(state.output).toString("utf8").trim();
  return output === "clean" ? { clean: true, reason: "clean" } : { clean: false, reason: output.replace(/^dirty: /, "") || "unknown" };
}
