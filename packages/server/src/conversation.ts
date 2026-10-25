/** Host activation and transport, never a second agent state machine. */
import path from "node:path";
import type { ServerResponse } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import { ConversationBusy, InboxDoc, LiveDoc, type UsageState, type UserInput } from "@earendil-works/pi-durable";
import { ClaudeAgent, ClaudeBusy, CLAUDE_PROVIDER, type ClaudeRuntime } from "./claude-agent.ts";
import { ClaudeThreadEvents } from "./claude-thread-events.ts";
import { skillsPrompt } from "./skills.ts";
import { SendsDoc } from "./pi-sends.ts";
import { assertCurrentThreadStore, downText, openAgent, type Agent } from "./durable-agent.ts";
import { createLogger } from "./log.ts";
import { PiThreadEvents } from "./pi-thread-events.ts";
import type { ThreadAcceptance, ThreadAgent, ThreadEvents, ThreadTranscript } from "./thread-events.ts";
import { serveThreadEvents } from "./thread-events-http.ts";
import type { WindowQuery } from "./transcript-window.ts";
import { readClaudeHistory, readPiHistory, type HistoryPage, type HistoryRequest } from "./thread-history.ts";
import { isThreadImageRef, readThreadImage } from "./thread-images.ts";
import { Registry, threadAgent, type HookOutcome, type Thread } from "./registry.ts";
import { provisioned, provisionWorkspace, refreshGuest, releaseCheck, resumeWorkspace, RunnerWait, StepFailure, stepLog, type PreparationOutcome,
  type ThreadMachines } from "./vm.ts";
import { VmWorkspace, type GuestPortal } from "./vm-workspace.ts";
import { LeaseStore } from "./workspace-lease.ts";
import { threadCondition, type ThreadCondition } from "./thread-condition.ts";
import { allocationFailed, FailedTry, readFailure, releaseFailed, startFailed, type Failure } from "./thread-failure.ts";
import { needsDemand, recoveryStep, releaseUnfinished, retriesExhausted, START_TRIES } from "./thread-recovery.ts";
import type { ModelSelection } from "./models.ts";

const context = BACKGROUND_CONTEXT;
const log = createLogger("threads");
/** The registry's first message is submitted once under this request id. */
const INITIAL_REQUEST = "cube:initial";
/** How long an idle round waits for the recovery loop's check of a machine. */
const CHECK_WAIT_MS = 60_000;
/** How long a start waits on a runner that does not answer before each try
 * counts as a failed one (as long as a guest call waits for a wake). */
const RUNNER_WAIT_MS = 30 * 60_000;
/** Why a disk the release check let go is kept all the same. */
/** The threads' part of cubed's close (Conversations.close). */
export const THREADS_CLOSE_MS = 9_000;
/** How long the close waits for the thread machines' close. */
const MACHINES_CLOSE_MS = 1_000;
/** How long a thread's request or summary out at a close may take to come back. */
const DRAIN_MS = 5_000;
/** How long the close waits for the commands still running. */
const COMMANDS_MS = 2_000;
const RUNNER_KEPT = "the release check was clean, but the runner kept the disk (a machine that did not stop in time or failed, or a host runner's directory)";
/** What a reader of threads may use: only what reads cubed's own state,
 * an agent already open, or a thread's store. None of it starts or wakes a
 * machine, opens an agent or waits for an activation, so code given only a
 * ThreadReader (OptChat's watcher, `threads`, `history`, the overview)
 * cannot do any of that (docs/thread-lifecycle.md). */
export type ThreadReader = Pick<Conversations, "live" | "storedHistory" | "agentOpen" | "condition" | "owner">;
/** Archive refused: the thread's agent is running. Nothing is interrupted. */
export class ThreadWorking extends Error {
  /** `waiting`: no turn runs, but the agent's background agents do. */
  readonly waiting: boolean;
  constructor(waiting = false) {
    super(waiting ? "stop the thread's background agents before archiving" : "stop the current run before archiving");
    this.name = "ThreadWorking";
    this.waiting = waiting;
  }
}
/** The thread's archive is under way: nothing reopens it meanwhile. Not a
 * failure of the thread; once the archive ends the thread is gone. */
export class ThreadArchiving extends Error {
  constructor() { super("thread is being archived"); this.name = "ThreadArchiving"; }
}
export interface ConversationsOptions {
  registry: Registry; directory: string; models: Models; machines: ThreadMachines; claude?: ClaudeRuntime | null; now?: () => number;
  portal?: (thread: Thread) => GuestPortal; hostTools?: (thread: Thread) => Parameters<typeof openAgent>[0]["hostTools"];
}
export class Conversations {
  private readonly registry: Registry;
  private readonly directory: string;
  private readonly models: Models;
  private readonly machines: ThreadMachines;
  private readonly agents = new Map<string, Promise<Agent>>();
  private readonly workspaces = new Map<string, { workspace: VmWorkspace; leases: LeaseStore }>();
  private readonly failures = new Map<string, Failure>();
  /** Threads this process has tried to start or wake: until then, the try
   * that failed before a restart (`retry`) is still their last one. */
  private readonly tried = new Set<string>();
  /** Why a thread's Pi agent is down: its Session failed. Kept when the
   * agent closes (its machine booted again): reopening it would send the
   * request out at the failure again. Only the thread's release clears it. */
  private readonly downs = new Map<string, string>();
  /** Threads whose machine waits for a runner (RunnerWait): not a failure;
   * the recovery loop tries again. */
  private readonly waits = new Map<string, string>();
  private readonly activations = new Map<string, Promise<void>>();
  /** Activations that only check a machine already running under an open
   * agent (the recovery loop's rounds): not a start unless the check finds
   * the machine booted again and closes the agent. */
  private readonly checks = new Set<string>();
  /** Threads whose machine ran its resume hooks since this process started
   * (or since it last booted the machine). */
  private readonly resumed = new Set<string>();
  /** Threads whose archive is under way: nothing reopens their agent or
   * workspace meanwhile (the recovery loop runs beside commands). */
  private readonly archiving = new Set<string>();
  /** Threads an archive is deciding about (waiting for their activation,
   * asking their agent whether it runs) or archiving: no activation starts,
   * so none overlaps the release check or the release. */
  private readonly archiveHolds = new Set<string>();
  private readonly commands = new Map<string, Promise<unknown>>();
  /** Threads whose machine an idle round is suspending: the recovery loop
   * leaves them alone meanwhile (it would wake what is being saved). */
  private readonly suspends = new Set<string>();
  /** The idle round under way: rounds do not overlap. */
  private suspendRound: Promise<void> | null = null;
  /** The recovery and idle rounds under way (`round`). */
  private readonly rounds = new Set<Promise<void>>();
  private readonly feeds = new WeakMap<Agent, PiThreadEvents>();
  private readonly claudes = new Map<string, Promise<ClaudeAgent>>();
  private readonly claudeFeeds = new WeakMap<ClaudeAgent, ClaudeThreadEvents>();
  private readonly claude: ClaudeRuntime | null;
  /** What `cube service` in a machine shows as its URLs (portal.ts). */
  private readonly portal: (thread: Thread) => GuestPortal;
  /** Host tools a Pi thread's agent gets (artifacts). */
  private readonly hostTools: ((thread: Thread) => Parameters<typeof openAgent>[0]["hostTools"]) | null;
  private closing = false;
  private readonly now: () => number;
  /** Messages (thread and request id) that already gave a thread whose
   * start failed its one more try: a delivery retried under the same id
   * (an artifact comment, OptChat's replay) does not start it again. */
  private readonly retried = new Set<string>();
  /** Since when a start of the thread has found its runner not answering. */
  private readonly unansweredSince = new Map<string, number>();
  /** Told a Pi agent's usage just before the agent closes (usage-service.ts):
   * until it opens again, nothing else may read its store. */
  onUsage: ((id: string, state: UsageState) => void) | null = null;
  /** `claude` is null when this host has no Claude Code to start. */
  constructor(options: ConversationsOptions) {
    this.registry = options.registry; this.directory = options.directory; this.models = options.models;
    this.hostTools = options.hostTools ?? null;
    this.machines = options.machines; this.claude = options.claude ?? null;
    this.now = options.now ?? Date.now;
    this.portal = options.portal ?? (() => ({ reason: "this cube installation has no portal" }));
  }
  /** Whether claude-code threads can run on this host. */
  get claudeAvailable(): boolean { return this.claude !== null; }
  /** One recovery round over every open thread (thread-recovery.ts says
   * what each gets): releases a crash interrupted are finished, a ready
   * thread's machine is checked (started again only when its runner lost
   * it), a machine not yet ready is started. A sleeping machine stays so
   * until something needs it (P7-5): only an agent with a run to go on
   * with wakes it here; a wake no one in this process owns (a restart cut
   * it short) is read back from the runner, not continued. */
  boot(): Promise<void> {
    if (this.closing) return Promise.resolve();
    return this.round(Promise.all(this.registry.listThreads().map(thread => this.recoverOne(thread).catch((error: unknown) => {
      if (!this.closing) log.warn("recovering a thread failed", { thread: thread.id, error: error instanceof Error ? error.message : String(error) });
    }))));
  }
  /** A recovery or idle round, run unawaited (index.ts): it never rejects,
   * and a close waits for it (bounded) before the stores close under it. */
  private round(work: Promise<unknown>): Promise<void> {
    const round = work.then(() => {}, (error: unknown) => {
      if (!this.closing) log.warn("a recovery round failed", { error: error instanceof Error ? error.message : String(error) });
    });
    this.rounds.add(round);
    void round.finally(() => this.rounds.delete(round));
    return round;
  }
  private async recoverOne(thread: Thread): Promise<void> {
    const id = thread.id;
    if (this.closing || this.archiveHolds.has(id) || this.suspends.has(id)) return;
    const owned = this.activations.has(id) || this.machines.wakeInFlight(thread);
    const demand = needsDemand(thread, owned) && await this.demand(id);
    // A close that began meanwhile starts nothing more.
    if (this.closing) return;
    switch (recoveryStep(thread, { owned, demand, now: this.now() })) {
      case "release": await this.command(id, () => this.release(id)).catch(() => {}); return;
      case "check": case "start": await this.activate(id); return;
      case "settle-wake":
        // A runner that does not answer is read again next round.
        await this.machines.settleWake(thread).catch((error: unknown) => {
          if (!(error instanceof RunnerWait)) log.warn("reading back a wake failed", { thread: id, error: error instanceof Error ? error.message : String(error) });
        });
        return;
      case "leave": return;
    }
  }
  /** Whether the thread's agent has a run that only a wake lets go on: a Pi
   * submission its stored conversation has not finished while no agent of
   * it is open here (an open agent's run wakes the machine itself, by its
   * guest calls). A Claude Code turn cut off by a stop is not continued at
   * the reopen (claude-agent.ts), so it needs nothing. */
  private async demand(id: string): Promise<boolean> {
    if (this.isClaude(id) || this.agentOpen(id) || this.downs.has(id)) return false;
    try { return (await this.storedHistory(id, { limit: 1 }))?.status.state === "working"; }
    catch (error) {
      log.warn("the stored run could not be read; the machine stays asleep", { thread: id, error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }
  /** One round of cubed's recovery loop (index.ts, every 30 s): every open
   * thread's activation (for a running machine under an open agent only a
   * check) beside the idle round, which waits for those checks. */
  async recover(): Promise<void> { await Promise.all([this.boot(), this.suspendIdle()]); }
  /** Why the thread's last try failed, also one before a restart until
   * this process tries again; once the recovery loop stopped trying
   * (START_TRIES), that too. */
  failure(id: string): Failure | null {
    const thread = this.registry.getThread(id);
    const failure = this.failures.get(id) ?? (this.tried.has(id) || !thread?.retry ? null : readFailure(thread.retry.error));
    if (!thread?.retry || !retriesExhausted(thread)) return failure;
    const last = failure ?? readFailure(thread.retry.error);
    return { kind: last.kind, text: `${last.text}; cube stopped retrying after ${thread.retry.failures} tries in a row, a message to the thread tries once more` };
  }
  /** `failure`'s words. */
  error(id: string): string | null { return this.failure(id)?.text ?? null; }
  /** Why the thread's Pi agent is down (its Session failed), if it is. */
  down(id: string): string | null { return this.downs.get(id) ?? null; }
  /** Why the thread's machine waits for a runner, if it does. */
  waiting(id: string): string | null { return this.waits.get(id) ?? null; }
  /** Whether the thread's machine is being started (booted, prepared or its
   * agent opened); a check of a running machine under an open agent is not. */
  starting(id: string): boolean { return this.activations.has(id) && !this.checks.has(id); }
  /** Whether an archive of the thread is under way (or deciding). */
  archivingNow(id: string): boolean { return this.archiveHolds.has(id); }
  /** The thread's condition, which every reader renders (thread-condition.ts). */
  condition(thread: Thread): ThreadCondition {
    const id = thread.id;
    return threadCondition(thread, { archiving: this.archivingNow(id), starting: this.starting(id), agentOpen: this.agentOpen(id),
      failure: this.failure(id), down: this.down(id), waiting: this.waiting(id) });
  }
  /** Boots the thread's machine, provisions it once and opens its agent.
   * Concurrent calls share one activation. */
  activate(id: string): Promise<void> {
    const pending = this.activations.get(id);
    if (pending) return pending;
    if (this.archiveHolds.has(id)) return Promise.resolve();
    // A release to finish is the recovery loop's (boot), never a new start.
    const current = this.registry.getThread(id);
    if (current && releaseUnfinished(current)) return Promise.resolve();
    if (current?.workspaceState === "available" && this.agentOpen(id)) this.checks.add(id);
    this.tried.add(id);
    const activation = (async () => {
      try {
        // Steps an earlier activation (or a cubed that stopped) left running
        // end here as interrupted, before this one records its own.
        if (this.registry.getThread(id)?.vm) this.registry.interruptStartupSteps(id);
        await this.ensureWorkspace(id);
        // An agent that was still opening and failed meanwhile opens again here: a start.
        if (!this.agentOpen(id)) this.checks.delete(id);
        if (this.isClaude(id)) await this.claudeAgent(id);
        else await this.agent(id);
        this.failures.delete(id);
        this.waits.delete(id);
        this.unansweredSince.delete(id);
        if (this.registry.getThread(id)?.retry) this.registry.clearFailures(id);
      } catch (error) {
        // An archive that ended is not this thread's failure.
        if (error instanceof ThreadArchiving || this.registry.getThread(id)?.archived !== false) return;
        const message = error instanceof Error ? error.message : String(error);
        // The start of a thread not ready yet waits on a VM runner that does
        // not answer for RUNNER_WAIT_MS; after that each try is a failed
        // one, with the recovery loop's pause and limit. A ready thread
        // (checked, or opened again after a restart) waits as long as it takes.
        const unanswered = error instanceof RunnerWait && !this.checks.has(id) && this.registry.getThread(id)?.workspaceState !== "available"
          ? error.unanswered : null;
        if (!unanswered) this.unansweredSince.delete(id);
        else if (!this.unansweredSince.has(id)) this.unansweredSince.set(id, this.now());
        const waited = unanswered ? this.now() - this.unansweredSince.get(id)! : 0;
        if (error instanceof RunnerWait && waited < RUNNER_WAIT_MS) {
          if (this.waits.get(id) !== message) log.info("waiting for a runner", { thread: id, reason: message });
          this.waits.set(id, message);
          this.failures.delete(id);
          return;
        }
        if (unanswered && waited) {
          this.waits.delete(id);
          const failure: Failure = { kind: "start", text: `runner ${unanswered.runner} has not answered for ${Math.round(RUNNER_WAIT_MS / 60_000)} min; ${unanswered.stays}` };
          if (this.failures.get(id)?.text !== failure.text) log.warn("activation failed", { thread: id, error: failure.text });
          this.failures.set(id, failure);
          this.countFailure(id, failure);
          return;
        }
        this.waits.delete(id);
        const failure = error instanceof FailedTry ? error.failure : startFailed(error);
        if (this.failures.get(id)?.text !== failure.text) log.warn("activation failed", { thread: id, error: failure.text });
        this.failures.set(id, failure);
        this.countFailure(id, failure);
      }
    })().finally(() => { this.activations.delete(id); this.checks.delete(id); });
    this.activations.set(id, activation);
    return activation;
  }
  /** Counts a failed try for the recovery loop's pause and limit. A
   * registry that cannot record it only loses the pause: the try's failure
   * itself stands. */
  private countFailure(id: string, failure: Failure): void {
    try {
      const retry = this.registry.recordFailure(id, failure, this.now());
      if (retry.failures === START_TRIES && !releaseUnfinished(this.registry.getThread(id)!)) {
        log.warn("cube stops retrying the thread's start; a message to it tries once more", { thread: id, tries: retry.failures });
      }
    } catch (error) { log.warn("a failed try was not counted", { thread: id, error: error instanceof Error ? error.message : String(error) }); }
  }
  /** Waits for a running activation; a thread is used only once its machine is up. */
  private async settled(id: string): Promise<void> { await this.activations.get(id); }
  private isClaude(id: string): boolean {
    const thread = this.registry.getThread(id);
    return !!thread && threadAgent(thread) === "claude-code";
  }
  private thread(id: string): Thread {
    const thread = this.registry.getThread(id);
    if (!thread || thread.archived) throw new Error("thread not found");
    return thread;
  }
  /** The machine a thread's storage and keys are bound to. */
  private binding(thread: Thread): string {
    const runner = this.registry.runner(thread.id);
    if (!runner) throw new Error("thread runner allocation is missing");
    if (!thread.vm) throw new Error("thread has no machine");
    return JSON.stringify({ node: runner.nodeId, environment: runner.environmentId, config: runner.configHash, vm: thread.vm.vmId });
  }
  /** The thread's one Workspace and lease store; its owner is the agent the
   * thread was created with. */
  workspace(id: string): VmWorkspace {
    if (this.closing) throw new Error("host is stopping");
    this.notArchiving(id);
    return this.openWorkspace(id);
  }
  private openWorkspace(id: string): VmWorkspace {
    const cached = this.workspaces.get(id);
    if (cached) return cached.workspace;
    const thread = this.thread(id);
    const leases = new LeaseStore(path.join(this.directory, id));
    const workspace = new VmWorkspace({ guest: this.machines.guest(thread), leases, owner: threadAgent(thread), binding: this.binding(thread) });
    this.workspaces.set(id, { workspace, leases });
    return workspace;
  }
  private notArchiving(id: string): void {
    if (this.archiving.has(id)) throw new ThreadArchiving();
  }
  private closeWorkspace(id: string): void {
    this.workspaces.get(id)?.leases.close();
    this.workspaces.delete(id);
  }
  /** Boots (or re-attaches) the machine; the first time, checks out the
   * project's pinned repositories in it and prepares it (pre-setup and
   * `.agents/setup`, or nothing when its disk came from a template); then,
   * once per machine boot, the resume hooks run before the agent opens. */
  private async ensureWorkspace(id: string): Promise<void> {
    let thread = this.thread(id);
    // Its machine is being released: starting it again would race the release.
    if (releaseUnfinished(thread)) throw new Error("thread workspace is releasing");
    if (thread.workspaceState === "available") {
      // A check that finds the machine down boots it: from then it is a start.
      const started = await this.machines.start(thread, { onBoot: () => this.checks.delete(id) });
      await this.resume(id, started?.booted ?? false);
      return;
    }
    // An agent opened on this machine before it was ready holds the lease
    // that preparing it needs (agents now open only on ready machines).
    await this.closeAgents(id);
    try {
      await this.machines.start(thread);
      // The machine's start recorded what its disk was made from.
      thread = this.thread(id);
      const owner = threadAgent(thread);
      const workspace = this.workspace(id);
      const preparation = thread.vm?.preparation;
      const preparing = Date.now();
      const last = thread.vm?.provisionAttempt ?? 0;
      let outcome = last > 0 ? await provisioned(workspace, owner, last) : null;
      // A try that ended while cubed was away is recorded as it ended.
      if (outcome) this.endPrepare(id, last, outcome, true);
      if (!outcome || outcome.error) {
        const attempt = last + 1;
        const mode = preparation?.source === "template" && preparation.setupBlob ? { kind: "template" as const, setupBlob: preparation.setupBlob } : { kind: "fresh" as const };
        this.registry.updateThreadVm(id, { provisionAttempt: attempt });
        this.registry.beginStartupStep(id, { name: "prepare", attempt,
          detail: mode.kind === "template" ? "checkout on the template's disk" : "checkout, pre-setup and .agents/setup" });
        try { outcome = await provisionWorkspace(workspace, owner, thread.allocation, attempt, mode); }
        catch (error) {
          await this.failStep(id, "prepare", attempt, error, "; cube tries again");
          throw error;
        }
        this.endPrepare(id, attempt, outcome);
      }
      this.recordHooks(id, outcome.hooks, "prepare", preparing);
      if (outcome.stale && preparation?.templateId) {
        log.info("template is stale: the pinned .agents/setup changed", { thread: id, template: preparation.templateId });
        await this.machines.invalidateTemplate(thread, preparation.templateId).catch(error => log.warn("invalidating the template failed", { thread: id, error }));
      }
      await this.resume(id, true);
      const startup = this.thread(id).vm?.startup;
      const totalMs = Date.now() - thread.createdAt;
      if (thread.vm) this.registry.updateThreadVm(id, { startup: { source: preparation?.source ?? "fresh", phases: startup?.phases ?? {}, totalMs } });
      log.info("machine ready for the agent", { thread: id, source: preparation?.source ?? "fresh", ...(preparation?.templateId ? { template: preparation.templateId } : {}),
        totalMs, phases: startup?.phases ?? {}, hooks: Object.fromEntries(Object.entries(this.thread(id).vm?.hooks ?? {}).map(([name, hook]) => [name, hook.status])) });
      const primary = thread.allocation.repositories[0];
      this.registry.markWorkspaceAvailable(id, primary
        ? { remote: primary.url, ref: primary.base.startsWith("refs/heads/") ? primary.base : `refs/heads/${primary.base}`, oid: primary.baseOid }
        : null);
    } catch (error) {
      // Nothing failed: the machine waits for a runner, still allocating.
      if (error instanceof RunnerWait) throw error;
      const failure = allocationFailed(error);
      this.registry.markWorkspaceFailed(id, failure);
      throw new FailedTry(failure, { cause: error });
    }
  }
  /** Records how a preparation try ended (`vm.steps`); `late`: only if it
   * is not recorded yet (a try that ended while cubed was away). */
  private endPrepare(id: string, attempt: number, outcome: PreparationOutcome, late = false): void {
    const recorded = this.thread(id).vm?.steps?.some(step => step.name === "prepare" && step.attempt === attempt && (step.state === "ok" || step.state === "failed"));
    if (late && recorded) return;
    const failed = Object.entries(outcome.hooks).filter(([, hook]) => hook.status === "failed").map(([name, hook]) => `${name} failed (exit ${hook.exitCode})`);
    this.registry.endStartupStep(id, { name: "prepare", attempt, state: outcome.error || failed.length ? "failed" : "ok",
      detail: outcome.error ? `${outcome.error}; cube tries again` : failed.length ? failed.join(", ")
        : Object.entries(outcome.hooks).map(([name, hook]) => `${name} ${hook.status}`).join(", "),
      ...(outcome.memory ? { memory: outcome.memory } : {}), ...(outcome.log ? { log: outcome.log } : {}) }, Date.now(), late);
  }
  /** Records a step that threw: its error, the command's memory, and the end
   * of the failed hook's log (what the script printed, or for a hook that
   * was killed, what its log in the machine says). */
  private async failStep(id: string, name: "prepare" | "resume", attempt: number | undefined, error: unknown, suffix = ""): Promise<void> {
    let log = error instanceof StepFailure ? error.log : undefined;
    if (!log) {
      const thread = this.registry.getThread(id);
      const read = thread ? await this.machines.startupLog(thread).catch(() => null) : null;
      if (read?.hook && read.text) log = stepLog(read.text);
    }
    this.registry.endStartupStep(id, { name, ...(attempt !== undefined ? { attempt } : {}), state: "failed",
      detail: `${error instanceof Error ? error.message : String(error)}${suffix}`,
      ...(error instanceof StepFailure && error.memory ? { memory: error.memory } : {}), ...(log ? { log } : {}) });
  }
  /** The resume hooks, once per machine boot. A machine that booted again
   * under an open agent (a runner restart) closes the agent first, as a
   * cubed restart would, and the activation reopens it afterwards (not an
   * agent that is down: see `downs`). */
  private async resume(id: string, booted: boolean): Promise<void> {
    if (!booted && this.resumed.has(id)) return;
    if (this.agents.has(id) || this.claudes.has(id)) {
      if (!booted) { this.resumed.add(id); return; }
      // The machine booted again: from here this is a start.
      this.checks.delete(id);
      await this.closeAgents(id);
      log.warn(this.downs.has(id) ? "the machine booted again; the agent is down and stays closed" : "the machine booted again; the agent reopens after the resume hooks", { thread: id });
    }
    const thread = this.thread(id);
    // The machine's helper and `cube` command as this cubed ships them, and
    // the portal's settings; a machine without them still serves its agent.
    try {
      const outcome = await refreshGuest(this.workspace(id), this.portal(thread));
      if (outcome !== "current") log.info("guest helper updated", { thread: id, how: outcome });
    } catch (error) {
      log.warn("the machine's cube command could not be brought up to date", { thread: id, error: error instanceof Error ? error.message : String(error) });
    }
    const started = Date.now();
    this.registry.beginStartupStep(id, { name: "resume", detail: "pre-resume and .agents/resume" });
    let resumed: Awaited<ReturnType<typeof resumeWorkspace>>;
    try { resumed = await resumeWorkspace(this.workspace(id), threadAgent(thread)); }
    catch (error) {
      await this.failStep(id, "resume", undefined, error);
      throw error;
    }
    const { hooks, already, memory, log: failureLog } = resumed;
    this.resumed.add(id);
    const failed = Object.entries(hooks).filter(([, hook]) => hook.status === "failed").map(([name, hook]) => `${name} failed (exit ${hook.exitCode})`);
    this.registry.endStartupStep(id, { name: "resume", state: failed.length ? "failed" : "ok",
      detail: already ? "already ran in this boot" : failed.length ? failed.join(", ") : Object.entries(hooks).map(([name, hook]) => `${name} ${hook.status}`).join(", "),
      ...(memory ? { memory } : {}), ...(failureLog ? { log: failureLog } : {}) });
    if (!already) this.recordHooks(id, hooks, "resume", started);
  }
  private recordHooks(id: string, hooks: Record<string, HookOutcome>, phase: string, since: number): void {
    const vm = this.thread(id).vm;
    if (!vm) return;
    const startup = vm.startup ?? { source: vm.preparation?.source ?? "fresh", totalMs: 0, phases: {} };
    // runner-ca is this boot's (the resume script reports it when there is one).
    const kept = phase === "resume" ? Object.fromEntries(Object.entries(vm.hooks ?? {}).filter(([name]) => name !== "runner-ca")) : vm.hooks;
    this.registry.updateThreadVm(id, { hooks: { ...kept, ...hooks }, startup: { ...startup, phases: { ...startup.phases, [phase]: Date.now() - since } } });
    for (const [name, hook] of Object.entries(hooks)) if (hook.status === "failed") log.warn("hook failed", { thread: id, hook: name, exitCode: hook.exitCode ?? null });
  }
  async agent(id: string): Promise<Agent> {
    if (this.closing) throw new Error("host is stopping");
    const thread = this.thread(id);
    if (threadAgent(thread) !== "pi") throw new Error("thread is not a pi thread");
    this.notArchiving(id);
    // A down agent is not opened again in this process: Pi would resume its
    // generation and send the request out at the failure again. Before its
    // machine boots again its failed Harness is still cached; a caller is
    // told why, not Pi's "close and reopen it".
    const down = this.downs.get(id);
    if (down) throw new Error(down);
    const cached = this.agents.get(id);
    if (cached) return cached;
    this.ready(thread);
    const loading = (async () => {
      const hostTools = this.hostTools?.(thread);
      const agent = await openAgent({ directory: path.join(this.directory, id), binding: this.binding(thread), workspace: this.workspace(id), models: this.models, model: thread.model,
        skills: skillsPrompt(thread.allocation.skills), ...hostTools ? { hostTools } : {} });
      try {
        // Pi deduplicates by request id: a reopen finds the first submission
        // instead of submitting it again, whatever happened since.
        const initial = this.registry.initialPrompt(id);
        if (initial) await agent.conversation.submit({ type: "input", content: initial, requestId: INITIAL_REQUEST }, context);
        // Pi's Session failed (a storage error): the agent stays down until
        // cubed restarts; nothing here reopens it.
        void agent.harness.closed.then(() => {
          const down = agent.failure();
          if (down && this.agents.get(id) === loading) this.downs.set(id, down);
        }, () => {});
        return agent;
      } catch (error) { await agent.close(); throw error; }
    })();
    this.agents.set(id, loading);
    try { return await loading; }
    catch (error) { this.agents.delete(id); throw error; }
  }
  private async closeAgents(id: string): Promise<void> {
    const claude = this.claudes.get(id), pi = this.agents.get(id);
    this.claudes.delete(id); this.agents.delete(id);
    try { await (await claude?.catch(() => null))?.close(); await this.closePi(id, pi); }
    finally {
      // The thread stays down through the close, also when its Session
      // failed while this close ran.
      const agent = await pi?.catch(() => null);
      const end = agent ? await agent.harness.closed.catch(() => null) : null;
      const down = agent?.failure() ?? (end?.reason === "failed" ? downText(end.error) : null);
      if (down && !this.downs.has(id)) this.downs.set(id, down);
    }
  }
  /** Closes a Pi agent, keeping its usage first. */
  private async closePi(id: string, loading: Promise<Agent> | undefined): Promise<void> {
    const agent = await loading?.catch(() => null);
    if (!agent) return;
    try { if (this.onUsage) this.onUsage(id, await piUsage(agent)); }
    catch (error) { log.warn("usage not kept at close", { thread: id, error }); }
    await agent.close();
  }
  /** The open Pi agent's usage (every conversation's `pi.usage`), or null
   * when its agent is not open. Never opens one. */
  async liveUsage(id: string): Promise<UsageState | null> {
    const agent = await this.agents.get(id)?.catch(() => null);
    return agent ? piUsage(agent) : null;
  }
  /** An agent opens only on a machine that finished preparing: it takes the
   * workspace lease for its lifetime, which preparing the machine needs, and
   * its first turn must not run before the checkouts exist. A reader waiting
   * on a failed activation gets the failure instead. */
  private ready(thread: Thread): void {
    if (releaseUnfinished(thread)) throw new Error(this.failures.get(thread.id)?.text ?? "thread workspace is releasing");
    if (thread.workspaceState !== "available") {
      throw new Error(this.failures.get(thread.id)?.text ?? this.waits.get(thread.id) ?? thread.workspaceError ?? "the thread machine is not ready");
    }
  }
  async claudeAgent(id: string): Promise<ClaudeAgent> {
    if (this.closing) throw new Error("host is stopping");
    const thread = this.thread(id);
    if (threadAgent(thread) !== "claude-code") throw new Error("thread is not a claude code thread");
    if (!this.claude) throw new Error("claude code is not installed on this host — install it and log in with claude /login");
    this.notArchiving(id);
    const cached = this.claudes.get(id);
    if (cached) return cached;
    this.ready(thread);
    const runtime = this.claude;
    const loading = (async () => {
      const agent = await ClaudeAgent.open({ directory: path.join(this.directory, id), threadId: id, workspace: this.workspace(id), runtime, model: thread.model.id,
        skills: skillsPrompt(thread.allocation.skills) });
      try {
        // The first message is accepted once under this request id.
        const initial = this.registry.initialPrompt(id);
        if (initial) await agent.submit(INITIAL_REQUEST, initial);
        return agent;
      } catch (error) { await agent.close(); throw error; }
    })();
    this.claudes.set(id, loading);
    try { return await loading; }
    catch (error) { this.claudes.delete(id); throw error; }
  }
  private async command<T>(id: string, action: () => Promise<T>): Promise<T> {
    const promise = (this.commands.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    this.commands.set(id, promise);
    try { return await promise; }
    finally { if (this.commands.get(id) === promise) this.commands.delete(id); }
  }
  /** A message is an explicit demand: once the thread has it (under its
   * request id) it is answered as accepted, and a replay wakes nothing.
   * A thread that is working refuses it, unless `steer`: then it is queued
   * into the running turn, and the agent takes it in after its current tool
   * call (or, as the turn ends, goes on with it), never in a second turn
   * beside it. `accepted` says what the thread did with it (steer only). */
  submit(id: string, text: string, requestId: string, options: { steer?: boolean } = {}): Promise<{ runId: string; accepted?: ThreadAcceptance }> {
    return this.command(id, async () => {
      await this.settled(id);
      const prior = await this.accepted(id, text, requestId);
      if (prior) return { runId: requestId, ...options.steer ? { accepted: prior } : {} };
      await this.wakeFor(id, requestId);
      const accepted = await this.accept(id, text, requestId, !!options.steer);
      return { runId: requestId, ...options.steer ? { accepted } : {} };
    });
  }
  /** A message to a thread whose machine is suspended wakes it first, so
   * the agent's run never meets a machine that starts again from its disk
   * (B7-5). With a full runner the activation records that it waits, and
   * the run's first guest call waits on (runner-machines.ts `wake`). A
   * thread whose start failed (or whose last check did) gets one more try
   * for each new message, whatever the recovery loop's pause or limit. */
  private async wakeFor(id: string, requestId: string): Promise<void> {
    const thread = this.registry.getThread(id);
    if (!thread || thread.archived) return;
    if (thread.vm?.suspension) { this.machines.renewWake(thread); await this.activate(id); return; }
    const key = `${id}\n${requestId}`;
    if ((thread.workspaceState !== "available" || this.failures.has(id) || retriesExhausted(thread)) && !this.retried.has(key)) {
      this.retried.add(key);
      await this.activate(id);
    }
  }
  /** What the thread did with the message `requestId` if it already has it
   * (a replay): read from its agent, opened if need be, which wakes nothing.
   * Only a ready thread has an agent to ask. */
  private async accepted(id: string, text: string, requestId: string): Promise<ThreadAcceptance | undefined> {
    const thread = this.registry.getThread(id);
    if (!thread || thread.archived || thread.workspaceState !== "available" || this.downs.has(id) || releaseUnfinished(thread)) return undefined;
    if (this.isClaude(id)) {
      if (!this.claude) return undefined;
      return (await this.claudeAgent(id)).request(requestId, text);
    }
    const prior = await this.priorInput(await this.agent(id), requestId);
    if (prior && (prior.type !== "input" || (prior.text !== undefined && prior.text !== text))) throw new Error("message request conflicts with the previous request");
    return prior?.accepted;
  }
  private async priorInput({ conversation }: Agent, requestId: string): Promise<{ type: string; text: string | undefined; accepted: ThreadAcceptance } | undefined> {
    return conversation.commit(async tx => {
      const submission = await tx.submissionByRequest(conversation.id, requestId);
      if (!submission) return undefined;
      const entry = submission.type === "input" && submission.entry !== undefined ? await tx.entry(submission.entry) : undefined;
      // Pi's inbox holds a steer until a boundary places it (its text is
      // there); a stop or a failed run withdraws it unplaced, text and all.
      const queued = submission.status === "queued" ? (await tx.doc(InboxDoc, conversation.id)).items.find(item => item.id === submission.id) : undefined;
      const text = entry?.model?.[0] ? messageText(entry.model[0]) : queued && queued.mode !== "write" ? inputText(queued.content as UserInput) : undefined;
      const accepted = submission.status === "queued" ? "queued" : submission.entry === undefined ? "dropped" : "consumed";
      return { type: submission.type, text, accepted };
    }, context);
  }
  /** Suspends the machines that have been idle for 5 minutes (B7-1; the
   * runner side decides idleness from guest calls, commands and portal
   * connections, machine-idle.ts) and run nothing cubed knows of. Run by
   * the recovery loop. Each thread's attempt is queued with its commands,
   * so a message waits for it and then wakes the machine. */
  suspendIdle(): Promise<void> {
    if (this.closing) return Promise.resolve();
    this.suspendRound ??= this.round(Promise.all(this.registry.listThreads().map(thread => this.suspendOne(thread))))
      .finally(() => { this.suspendRound = null; });
    return this.suspendRound;
  }
  private async suspendOne(thread: Thread): Promise<void> {
    const machines = this.machines;
    const id = thread.id;
    const skip = (current: Thread | null) => !current || current.archived || current.workspaceState !== "available" || !!current.vm?.suspension || releaseUnfinished(current);
    if (skip(thread)) return;
    // The recovery loop's check of a machine that runs is not activity:
    // its end is waited for (B-207-1). A start is.
    // A check that became a start (the machine was down) is not waited for
    // past CHECK_WAIT_MS: the round goes on, and the start counts as activity.
    const check = this.checks.has(id) ? this.activations.get(id) : undefined;
    if (check) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([check, new Promise(resolve => { timer = setTimeout(resolve, CHECK_WAIT_MS); })]);
      clearTimeout(timer);
    }
    const current = this.registry.getThread(id);
    if (skip(current)) return;
    if (this.commands.has(id) || this.activations.has(id) || this.archiveHolds.has(id)) { machines.touch(current!); return; }
    this.suspends.add(id);
    try { await this.command(id, () => machines.suspendIfIdle(this.registry.getThread(id) ?? current!, () => this.busy(id))); }
    catch (error) { log.warn("suspending an idle machine failed", { thread: id, error: error instanceof Error ? error.message : String(error) }); }
    finally { this.suspends.delete(id); }
  }
  /** What cubed runs for the thread now, or null (B7-1, B7-3): a start, an
   * archive, the agent's run or its background agents. */
  private async busy(id: string): Promise<string | null> {
    if (this.closing) return "cubed is stopping";
    if (this.activations.has(id)) return "the machine is starting";
    if (this.archiveHolds.has(id)) return "the thread is being archived";
    const claude = await this.claudes.get(id)?.catch(() => null);
    if (claude?.running) return "the agent is working";
    if (claude?.waiting.length) return "the agent's background agents run";
    const pi = await this.agents.get(id)?.catch(() => null);
    if (pi && (await pi.harness.snapshot(LiveDoc, pi.conversation.id, context))?.run) return "the agent is working";
    return null;
  }
  private async accept(id: string, text: string, requestId: string, steer: boolean): Promise<ThreadAcceptance> {
    if (this.isClaude(id)) {
      const agent = await this.claudeAgent(id);
      try { return await agent.submit(requestId, text, { steer }); }
      catch (error) {
        if (error instanceof ClaudeBusy) throw new Error("thread is already working or message is invalid", { cause: error });
        throw error;
      }
    }
    const agent = await this.agent(id);
    const { conversation } = agent;
    // Request identity is committed atomically with the user message by Pi,
    // not stored in a second host workflow journal.
    const prior = await this.priorInput(agent, requestId);
    if (prior && (prior.type !== "input" || (prior.text !== undefined && prior.text !== text))) throw new Error("message request conflicts with the previous request");
    if (prior) return prior.accepted;
    // A steer is admitted into Pi's inbox in the same commit that finds the
    // run: placed at the run's next tool boundary, or at its final one if
    // the run is ending, which then goes on; an idle thread starts a run.
    let submission;
    try { submission = await conversation.submit({ type: "input", content: text, requestId, whenBusy: steer ? "steer" : "reject" }, context); }
    catch (error) {
      if (error instanceof ConversationBusy) throw new Error("thread is already working or message is invalid", { cause: error });
      throw error;
    }
    if (!steer) return "started";
    const record = await submission.status(context);
    if (record.status === "queued") return "queued";
    const live = await agent.harness.snapshot(LiveDoc, conversation.id, context);
    return live?.run?.inputs[0] === submission.id ? "started" : record.status === "unanswered" && record.entry === undefined ? "dropped" : "consumed";
  }
  async model(id: string, selection?: ModelSelection): Promise<ModelSelection> {
    return this.command(id, async () => {
    await this.settled(id);
    if (this.isClaude(id)) {
      const agent = await this.claudeAgent(id);
      if (selection) {
        if (selection.provider !== CLAUDE_PROVIDER) throw new Error("a claude code thread runs claude models only");
        await agent.setModel(selection.id);
      }
      return { provider: CLAUDE_PROVIDER, id: agent.model };
    }
    const agent = await this.agent(id);
    if (selection) {
      if (selection.provider === CLAUDE_PROVIDER) throw new Error("claude · max is chosen when a thread starts");
      if ((await agent.harness.snapshot(LiveDoc, agent.conversation.id, context))?.run) throw new Error("wait for the current run before changing model");
      if (!this.models.getModel(selection.provider, selection.id)) throw new Error("model unavailable");
      await agent.conversation.configure({ model: { provider: selection.provider, modelId: selection.id } }, context);
    }
    const selected = (await agent.conversation.agent(context)).model;
    if (!selected) throw new Error("thread has no model");
    return { provider: selected.provider, id: selected.modelId };
    });
  }
  /** The thread in the neutral event model; the same interface the SSE
   * stream serves and the browser reads. Opens the agent (not the machine). */
  async events(id: string): Promise<ThreadEvents> {
    await this.settled(id);
    // A failed Harness cannot be read; a reader gets why the agent is down,
    // as it gets a failed activation's error.
    const down = this.downs.get(id);
    if (down) throw new Error(down);
    return this.isClaude(id) ? this.claudeFeed(id, await this.claudeAgent(id)) : this.piFeed(id, await this.agent(id));
  }
  /** The events of the thread's agent if it is open (or opening) in this
   * process, else null: it never opens an agent, waits for no activation and
   * starts nothing. A down agent's reader is told why, as by `events`. */
  async live(id: string): Promise<ThreadEvents | null> {
    const down = this.downs.get(id);
    if (down) throw new Error(down);
    const claude = await this.claudes.get(id)?.catch(() => null);
    if (claude) return this.claudeFeed(id, claude);
    const pi = await this.agents.get(id)?.catch(() => null);
    return pi ? this.piFeed(id, pi) : null;
  }
  private piFeed(id: string, agent: Agent): ThreadEvents {
    let events = this.feeds.get(agent);
    if (!events) {
      events = new PiThreadEvents({ agent, owner: () => this.owner(id), failure: () => this.failures.get(id)?.text ?? null });
      this.feeds.set(agent, events);
    }
    return events;
  }
  private claudeFeed(id: string, agent: ClaudeAgent): ThreadEvents {
    let events = this.claudeFeeds.get(agent);
    if (!events) {
      events = new ClaudeThreadEvents({ agent, owner: () => this.owner(id), failure: () => this.failures.get(id)?.text ?? null });
      this.claudeFeeds.set(agent, events);
    }
    return events;
  }
  /** The thread workspace's current writable owner, if any. */
  owner(id: string): ThreadAgent | null {
    return this.workspaces.get(id)?.leases.holder() ?? null;
  }
  async history(id: string): Promise<ThreadTranscript> {
    return (await this.events(id)).read();
  }
  /** Whether the thread's agent is open (or opening) in this process. */
  agentOpen(id: string): boolean { return this.agents.has(id) || this.claudes.has(id); }
  /** A page of the thread's stored transcript, read without opening its
   * agent, taking its workspace lease or waiting for its machine: archived
   * threads and threads whose machine failed keep theirs. null when the
   * agent never stored one. */
  async storedHistory(id: string, request: HistoryRequest = {}): Promise<HistoryPage | null> {
    const thread = this.registry.getThread(id);
    if (!thread) throw new Error("thread not found");
    const directory = path.join(this.directory, id);
    const failure = this.failures.get(id)?.text ?? this.downs.get(id) ?? null;
    if (threadAgent(thread) === "claude-code") {
      return readClaudeHistory(path.join(directory, "claude.sqlite"), path.join(directory, "claude"), this.owner(id), failure, request);
    }
    assertCurrentThreadStore(directory);
    return readPiHistory(path.join(directory, "pi.sqlite"), this.owner(id), failure, request);
  }
  /** An image the thread's transcript shows, from the thread's own store on
   * this host, read without its agent or its machine: an archived thread and
   * one whose disk is gone keep theirs. null when there is no such image. */
  image(id: string, ref: string): ReturnType<typeof readThreadImage> {
    const thread = this.registry.getThread(id);
    if (!thread || !isThreadImageRef(ref)) return null;
    const directory = path.join(this.directory, id);
    if (threadAgent(thread) === "claude-code") return readThreadImage({ agent: "claude-code", file: path.join(directory, "claude.sqlite") }, ref);
    assertCurrentThreadStore(directory);
    return readThreadImage({ agent: "pi", file: path.join(directory, "pi.sqlite") }, ref);
  }
  async stream(id: string, response: ServerResponse, query: WindowQuery = null): Promise<void> {
    await serveThreadEvents(await this.events(id), response, query);
  }
  /** Closes the agent and releases the machine. Its disk is deleted when the
   * machine's release check reports clean: nothing uncommitted and every
   * commit pushed (see `releaseCheckScript`); the chat, its usage and what
   * was pushed stay. Any other answer, or none, keeps the disk with the
   * reason. The guest is agent-controlled, but an agent that would lie to it
   * can as well delete its own work: the check guards against losing work,
   * not against the agent.
   * A thread whose run goes on is refused (ThreadWorking), never stopped. A
   * thread an earlier archive already archived is left as it is (`already`). */
  async archive(id: string): Promise<{ retained: boolean; reason: string; already?: true }> {
    return this.command(id, async () => {
    // No activation starts from here on; the one under way is waited for.
    // An activation beside the release check or the release would start the
    // machine or take its lease while it is being released.
    this.archiveHolds.add(id);
    try { return await this.archiveHeld(id); }
    finally { this.archiveHolds.delete(id); }
    });
  }
  private async archiveHeld(id: string): Promise<{ retained: boolean; reason: string; already?: true }> {
    await this.settled(id);
    const thread = this.registry.getThread(id);
    if (!thread) throw new Error("thread not found");
    // Archives queue behind each other: the second finds the first's result
    // (cubed's record; the first answers what the runner did).
    if (thread.archived) return { retained: !!thread.vm?.retain && !thread.vm.discarded, reason: thread.vm?.retainReason ?? "already archived", already: true };
    // A machine that is not ready has no agent to stop or ask (see ready()).
    const failed = thread.workspaceState !== "available";
    // A release that failed or was cut short already decided the disk's fate.
    const again = releaseUnfinished(thread);
    // An agent that cannot open (its runtime missing, its store refused) runs
    // nothing: the thread is archived, its disk kept.
    let unopened: string | null = null;
    // A down agent runs nothing (Pi ended every task); it is not opened again.
    if (!failed && !this.downs.has(id)) {
      // Only opening is caught: an open agent whose state cannot be read is not archived.
      const opened = await (this.isClaude(id) ? this.claudeAgent(id) : this.agent(id)).catch((error: unknown) => {
        if (this.closing) throw error;
        unopened = error instanceof Error ? error.message : String(error);
        return null;
      });
      if (opened instanceof ClaudeAgent ? opened.running : opened && (await opened.harness.snapshot(LiveDoc, opened.conversation.id, context))?.run) throw new ThreadWorking();
      // Closing the agent would end its background agents.
      if (opened instanceof ClaudeAgent && opened.waiting.length) throw new ThreadWorking(true);
    }
    // From here until the release ends nothing reopens the thread.
    return this.withArchiving(id, async () => {
      let decision: { clean: boolean; reason: string };
      if (failed) decision = { clean: false, reason: thread.workspaceError ?? "the thread machine was not ready" };
      else if (unopened) decision = { clean: false, reason: `the agent could not open: ${unopened}` };
      else {
        await this.closeAgents(id);
        // A suspended machine is woken for the check only if its runner has
        // a slot free now; otherwise its disk is kept unchecked at once
        // rather than the archive waiting for a slot (nothing is lost).
        const asleep = await this.wakeForCheck(id);
        if (asleep) decision = { clean: false, reason: `its machine is suspended and was not woken to check it (${asleep}); its disk is kept unchecked` };
        else {
          const workspace = this.openWorkspace(id);
          try { decision = await releaseCheck(workspace, threadAgent(thread), thread.allocation); }
          catch (error) { decision = { clean: false, reason: `the thread machine could not be checked: ${error instanceof Error ? error.message : String(error)}` }; }
          if (decision.clean && workspace.agentChanged()) decision = { clean: true, reason: "clean: the agent's work is committed and pushed" };
        }
      }
      this.closeWorkspace(id);
      this.resumed.delete(id);
      if (again) decision = { clean: thread.vm?.retain === false, reason: thread.vm?.retainReason ?? decision.reason };
      else if (thread.vm) this.registry.updateThreadVm(id, { retain: !decision.clean, retainReason: decision.reason });
      this.registry.beginRelease(id);
      const released = await this.release(id);
      return { retained: released.retained, reason: released.retained && decision.clean ? RUNNER_KEPT : decision.reason };
    });
  }
  /** Before an archive's release check: null when the machine runs (woken
   * now if it slept and its runner had a slot), else why it still sleeps. */
  private async wakeForCheck(id: string): Promise<string | null> {
    const thread = this.registry.getThread(id);
    if (!thread?.vm?.suspension) return null;
    try { return await this.machines.wakeNow(thread); }
    catch (error) { return `it could not be woken: ${error instanceof Error ? error.message : String(error)}`; }
  }
  /** Deletes an archived thread's retained machine disk: the operator
   * decided its evidence is no longer needed. */
  async discard(id: string): Promise<void> {
    return this.command(id, async () => {
      const thread = this.registry.getThread(id);
      if (!thread) throw new Error("thread not found");
      if (!thread.archived) throw new Error("archive the thread before discarding its machine");
      if (!thread.vm || thread.vm.discarded) return;
      await this.machines.discard(thread);
      this.registry.updateThreadVm(id, { discarded: true });
    });
  }
  /** Runs `action` with the thread marked as archiving. */
  private async withArchiving<T>(id: string, action: () => Promise<T>): Promise<T> {
    this.archiving.add(id);
    try { return await action(); }
    finally { this.archiving.delete(id); }
  }
  private async release(id: string): Promise<{ retained: boolean }> {
    try {
      const thread = this.registry.getThread(id);
      if (!thread) throw new Error("thread not found");
      // A release a crash interrupted keeps the evidence unless the check was clean.
      const released = await this.machines.release(thread, thread.vm?.retain ?? true);
      // The runner keeps a disk cubed let go when the machine did not stop
      // in time (or failed): recorded, so it is listed and can be discarded.
      if (released.retained && thread.vm && !thread.vm.retain) this.registry.updateThreadVm(id, { retain: true, retainReason: RUNNER_KEPT });
      this.registry.finishRelease(id);
      this.failures.delete(id);
      this.downs.delete(id);
      this.waits.delete(id);
      this.unansweredSince.delete(id);
      return released;
    } catch (error) {
      const failure = releaseFailed(error);
      this.registry.markWorkspaceFailed(id, failure);
      this.failures.set(id, failure);
      // Retried after a pause, for as long as it fails: never given up.
      this.countFailure(id, failure);
      throw new FailedTry(failure, { cause: error });
    }
  }
  async stop(id: string): Promise<void> {
    await this.settled(id);
    if (this.isClaude(id)) { await (await this.claudeAgent(id)).stop(); return; }
    const agent = await this.agent(id);
    await agent.conversation.abort(context);
  }
  /** cubed stops; thread machines keep running and the next cubed attaches
   * to them again. Bounded by `ms` whatever a machine, a command or an agent
   * does, so cubed's whole close stays under its supervisor's SIGKILL. The
   * threads send no new request (held back, sent once after the reopen),
   * and a request or a context summary already out gets up to DRAIN_MS to
   * come back and be stored (Pi's own close aborts it); the machines' close
   * before that gets MACHINES_CLOSE_MS; a command (a tell or an archive
   * OptChat cut off) gets up to COMMANDS_MS, and the agents' own closes the
   * rest. Past a bound the close goes on and logs what was left: a request
   * still out is counted at the next open and not sent again (pi-sends.ts),
   * a guest command goes on and the next cubed reattaches to it, and a tell
   * or an archive is keyed. */
  async close(ms = THREADS_CLOSE_MS): Promise<void> {
    this.closing = true;
    const deadline = Date.now() + ms;
    const left = (cap = Infinity) => Math.min(cap, Math.max(0, deadline - Date.now()));
    // A machine still booting is left to boot; the next cubed attaches to it.
    // Its own cap, so the drain after it always gets its share.
    await within("thread machines", this.machines.close(), left(MACHINES_CLOSE_MS));
    // A recovery round started before the close (cubed's boot) starts
    // nothing more, and ends before the registry closes under it; past its
    // bound it goes on, and its failures are not reported once closing.
    await within("recovery rounds", Promise.all([...this.rounds]), left(COMMANDS_MS));
    const agents = [...this.agents];
    const out = await within("threads' requests out", Promise.all(agents.map(async ([, promise]) => (await promise.catch(() => null))?.drain(left(DRAIN_MS)) ?? true)), left(DRAIN_MS + 200));
    if (Array.isArray(out) && out.includes(false)) log.warn("a thread's request or summary was still out at the close: Pi's close aborts it, and the next open counts it and does not send it again", { threads: agents.filter((_, k) => out[k] === false).map(([id]) => id) });
    await within("commands", Promise.allSettled(this.commands.values()), left(COMMANDS_MS));
    await within("thread agents", Promise.all([...agents.map(([id, promise]) => this.closePi(id, promise)),
      ...[...this.claudes.values()].map(async promise => (await promise.catch(() => null))?.close())]), left());
    this.agents.clear(); this.claudes.clear();
    for (const id of [...this.workspaces.keys()]) this.closeWorkspace(id);
  }
}

function inputText(content: UserInput): string {
  return typeof content === "string" ? content : content.map(part => part.type === "text" ? part.text : "").filter(Boolean).join("\n");
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map(part => part.type === "text" ? part.text : part.type === "thinking" ? part.thinking : "").filter(Boolean).join("\n");
}

/** A thread's Pi usage with the requests that were out at a stop (pi-sends.ts). */
async function piUsage(agent: Agent): Promise<UsageState & { interrupted?: Record<string, number> }> {
  const interrupted = (await agent.harness.snapshot(SendsDoc, context))?.interrupted;
  return { ...await agent.harness.usage(context), ...interrupted && Object.keys(interrupted).length ? { interrupted: { ...interrupted } } : {} };
}

/** `work`, or false once `ms` passed; the close goes on without it. */
async function within<T>(step: string, work: Promise<T>, ms: number): Promise<T | false> {
  const bound = new AbortController();
  const timedOut = Symbol("timed out");
  const result = await Promise.race([work, delay(ms, timedOut, { signal: bound.signal }).catch(() => timedOut)]).finally(() => bound.abort());
  if (result !== timedOut) return result as T;
  log.warn("a step of the close did not end in time; the close goes on", { step, ms });
  return false;
}
