/** Host activation and transport, never a second agent state machine. */
import path from "node:path";
import type { ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import { ConversationBusy, LiveDoc, type UsageState } from "@earendil-works/pi-durable";
import { ClaudeAgent, ClaudeBusy, CLAUDE_PROVIDER, type ClaudeRuntime } from "./claude-agent.ts";
import { ClaudeThreadEvents } from "./claude-thread-events.ts";
import { assertCurrentThreadStore, openAgent, type Agent } from "./durable-agent.ts";
import { createLogger } from "./log.ts";
import { PiThreadEvents } from "./pi-thread-events.ts";
import type { ThreadAgent, ThreadEvents, ThreadTranscript } from "./thread-events.ts";
import { serveThreadEvents } from "./thread-events-http.ts";
import { readClaudeHistory, readPiHistory, type HistoryPage, type HistoryRequest } from "./thread-history.ts";
import { Registry, threadAgent, type HookOutcome, type Thread } from "./registry.ts";
import { provisioned, provisionWorkspace, refreshGuest, releaseCheck, resumeWorkspace, RunnerWait, type ThreadMachines } from "./vm.ts";
import { VmWorkspace, type GuestPortal } from "./vm-workspace.ts";
import { LeaseStore } from "./workspace-lease.ts";
import type { ModelSelection } from "./models.ts";

const context = BACKGROUND_CONTEXT;
const log = createLogger("threads");
/** The registry's first message is submitted once under this request id. */
const INITIAL_REQUEST = "cube:initial";
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
/** A release that failed or was cut short: only the release is retried. */
export const releaseUnfinished = (thread: Thread) => thread.workspaceState === "releasing"
  || (thread.workspaceState === "failed" && !!thread.workspaceError?.startsWith("workspace release failed:"));
export class Conversations {
  private readonly registry: Registry;
  private readonly directory: string;
  private readonly models: Models;
  private readonly machines: ThreadMachines;
  private readonly agents = new Map<string, Promise<Agent>>();
  private readonly workspaces = new Map<string, { workspace: VmWorkspace; leases: LeaseStore }>();
  private readonly failures = new Map<string, string>();
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
  private readonly feeds = new WeakMap<Agent, PiThreadEvents>();
  private readonly claudes = new Map<string, Promise<ClaudeAgent>>();
  private readonly claudeFeeds = new WeakMap<ClaudeAgent, ClaudeThreadEvents>();
  private readonly claude: ClaudeRuntime | null;
  /** What `cube service` in a machine shows as its URLs (portal.ts). */
  private readonly portal: (thread: Thread) => GuestPortal;
  /** Host tools a Pi thread's agent gets (artifacts). */
  private readonly hostTools: ((thread: Thread) => Parameters<typeof openAgent>[0]["hostTools"]) | null;
  private closing = false;
  /** Told a Pi agent's usage just before the agent closes (usage-service.ts):
   * until it opens again, nothing else may read its store. */
  onUsage: ((id: string, state: UsageState) => void) | null = null;
  /** `claude` is null when this host has no Claude Code to start. */
  constructor(options: { registry: Registry; directory: string; models: Models; machines: ThreadMachines; claude?: ClaudeRuntime | null;
    portal?: (thread: Thread) => GuestPortal; hostTools?: (thread: Thread) => Parameters<typeof openAgent>[0]["hostTools"] }) {
    this.registry = options.registry; this.directory = options.directory; this.models = options.models;
    this.hostTools = options.hostTools ?? null;
    this.machines = options.machines; this.claude = options.claude ?? null;
    this.portal = options.portal ?? (() => ({ reason: "this cube installation has no portal" }));
  }
  /** Whether claude-code threads can run on this host. */
  get claudeAvailable(): boolean { return this.claude !== null; }
  /** Activates every open thread (machines boot concurrently) and finishes
   * releases a crash interrupted. Repeated by cubed's recovery loop; an
   * active thread's machine is only checked, not restarted. */
  async boot(): Promise<void> {
    const work: Promise<unknown>[] = [];
    for (const thread of this.registry.listThreads()) {
      if (thread.archived || this.closing || this.archiveHolds.has(thread.id)) continue;
      if (releaseUnfinished(thread)) {
        work.push(this.command(thread.id, () => this.release(thread.id)).catch(() => {}));
      }
      else work.push(this.activate(thread.id));
    }
    await Promise.all(work);
  }
  error(id: string): string | null { return this.failures.get(id) ?? null; }
  /** Why the thread's machine waits for a runner, if it does. */
  waiting(id: string): string | null { return this.waits.get(id) ?? null; }
  /** Whether the thread's machine is being started (booted, prepared or its
   * agent opened); a check of a running machine under an open agent is not. */
  starting(id: string): boolean { return this.activations.has(id) && !this.checks.has(id); }
  /** Whether an archive of the thread is under way (or deciding). */
  archivingNow(id: string): boolean { return this.archiveHolds.has(id); }
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
    const activation = (async () => {
      try {
        await this.ensureWorkspace(id);
        // An agent that was still opening and failed meanwhile opens again here: a start.
        if (!this.agentOpen(id)) this.checks.delete(id);
        if (this.isClaude(id)) await this.claudeAgent(id);
        else await this.agent(id);
        this.failures.delete(id);
        this.waits.delete(id);
      } catch (error) {
        // An archive that ended is not this thread's failure.
        if (error instanceof ThreadArchiving || this.registry.getThread(id)?.archived !== false) return;
        const message = error instanceof Error ? error.message : String(error);
        if (error instanceof RunnerWait) {
          if (this.waits.get(id) !== message) log.info("waiting for a runner", { thread: id, reason: message });
          this.waits.set(id, message);
          this.failures.delete(id);
          return;
        }
        this.waits.delete(id);
        if (this.failures.get(id) !== message) log.warn("activation failed", { thread: id, error: message });
        this.failures.set(id, message);
      }
    })().finally(() => { this.activations.delete(id); this.checks.delete(id); });
    this.activations.set(id, activation);
    return activation;
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
      if (!outcome || outcome.error) {
        const attempt = last + 1;
        this.registry.updateThreadVm(id, { provisionAttempt: attempt });
        outcome = await provisionWorkspace(workspace, owner, thread.allocation, attempt,
          preparation?.source === "template" && preparation.setupBlob ? { kind: "template", setupBlob: preparation.setupBlob } : { kind: "fresh" });
      }
      this.recordHooks(id, outcome.hooks, "prepare", preparing);
      // A template whose seal could not clean everything: this machine got
      // its identity from its own seed and a fresh journal, but no further
      // machine may start from it.
      const seal = preparation?.source === "template" ? (await workspace.describe()).templateSeal : undefined;
      if (seal && seal !== "ok" && preparation?.templateId) {
        log.warn("the template's seal failed; removing it", { thread: id, template: preparation.templateId, seal });
        this.registry.updateThreadVm(id, { preparation: { ...preparation, sealFailure: seal } });
        await this.machines.invalidateTemplate?.(thread, preparation.templateId).catch(error => log.warn("invalidating the template failed", { thread: id, error }));
      }
      if (outcome.stale && preparation?.templateId) {
        log.info("template is stale: the pinned .agents/setup changed", { thread: id, template: preparation.templateId });
        await this.machines.invalidateTemplate?.(thread, preparation.templateId).catch(error => log.warn("invalidating the template failed", { thread: id, error }));
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
      const message = `workspace allocation failed: ${error instanceof Error ? error.message : String(error)}`;
      this.registry.markWorkspaceFailed(id, message);
      throw new Error(message, { cause: error });
    }
  }
  /** The resume hooks, once per machine boot. A machine that booted again
   * under an open agent (a runner restart) closes the agent first, as a
   * cubed restart would, and the activation reopens it afterwards. */
  private async resume(id: string, booted: boolean): Promise<void> {
    if (!booted && this.resumed.has(id)) return;
    if (this.agents.has(id) || this.claudes.has(id)) {
      if (!booted) { this.resumed.add(id); return; }
      // The machine booted again: from here this is a start.
      this.checks.delete(id);
      await this.closeAgents(id);
      log.warn("the machine booted again; the agent reopens after the resume hooks", { thread: id });
    }
    const thread = this.thread(id);
    // The machine's helper and `cube` command as this cubed ships them, and
    // the portal's settings; a machine without them still serves its agent.
    try {
      const outcome = await refreshGuest(this.workspace(id), threadAgent(thread), this.portal(thread));
      if (outcome !== "current") log.info("guest helper updated", { thread: id, how: outcome });
    } catch (error) {
      log.warn("the machine's cube command could not be brought up to date", { thread: id, error: error instanceof Error ? error.message : String(error) });
    }
    const started = Date.now();
    const { hooks, already } = await resumeWorkspace(this.workspace(id), threadAgent(thread));
    this.resumed.add(id);
    if (!already) this.recordHooks(id, hooks, "resume", started);
  }
  private recordHooks(id: string, hooks: Record<string, HookOutcome>, phase: string, since: number): void {
    const vm = this.thread(id).vm;
    if (!vm) return;
    const startup = vm.startup ?? { source: vm.preparation?.source ?? "fresh", totalMs: 0, phases: {} };
    this.registry.updateThreadVm(id, { hooks: { ...vm.hooks, ...hooks }, startup: { ...startup, phases: { ...startup.phases, [phase]: Date.now() - since } } });
    for (const [name, hook] of Object.entries(hooks)) if (hook.status === "failed") log.warn("hook failed", { thread: id, hook: name, exitCode: hook.exitCode ?? null });
  }
  async agent(id: string): Promise<Agent> {
    if (this.closing) throw new Error("host is stopping");
    const thread = this.thread(id);
    if (threadAgent(thread) !== "pi") throw new Error("thread is not a pi thread");
    this.notArchiving(id);
    const cached = this.agents.get(id);
    if (cached) return cached;
    this.ready(thread);
    const loading = (async () => {
      const hostTools = this.hostTools?.(thread);
      const agent = await openAgent({ directory: path.join(this.directory, id), binding: this.binding(thread), workspace: this.workspace(id), models: this.models, model: thread.model,
        ...hostTools ? { hostTools } : {} });
      try {
        // Pi deduplicates by request id: a reopen finds the first submission
        // instead of submitting it again, whatever happened since.
        const initial = this.registry.initialPrompt(id);
        if (initial) await agent.conversation.submit({ type: "input", content: initial, requestId: INITIAL_REQUEST }, context);
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
    await (await claude?.catch(() => null))?.close(); await this.closePi(id, pi);
  }
  /** Closes a Pi agent, keeping its usage first. */
  private async closePi(id: string, loading: Promise<Agent> | undefined): Promise<void> {
    const agent = await loading?.catch(() => null);
    if (!agent) return;
    try { if (this.onUsage) this.onUsage(id, await agent.harness.usage(context)); }
    catch (error) { log.warn("usage not kept at close", { thread: id, error }); }
    await agent.close();
  }
  /** The open Pi agent's usage (every conversation's `pi.usage`), or null
   * when its agent is not open. Never opens one. */
  async liveUsage(id: string): Promise<UsageState | null> {
    const agent = await this.agents.get(id)?.catch(() => null);
    return agent ? agent.harness.usage(context) : null;
  }
  /** An agent opens only on a machine that finished preparing: it takes the
   * workspace lease for its lifetime, which preparing the machine needs, and
   * its first turn must not run before the checkouts exist. A reader waiting
   * on a failed activation gets the failure instead. */
  private ready(thread: Thread): void {
    if (releaseUnfinished(thread)) throw new Error(this.failures.get(thread.id) ?? "thread workspace is releasing");
    if (thread.workspaceState !== "available") {
      throw new Error(this.failures.get(thread.id) ?? this.waits.get(thread.id) ?? thread.workspaceError ?? "the thread machine is not ready");
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
      const agent = await ClaudeAgent.open({ directory: path.join(this.directory, id), threadId: id, workspace: this.workspace(id), runtime, model: thread.model.id });
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
  submit(id: string, text: string, requestId: string): Promise<{ runId: string }> {
    return this.command(id, async () => { await this.settled(id); return this.accept(id, text, requestId); });
  }
  private async accept(id: string, text: string, requestId: string): Promise<{ runId: string }> {
    if (this.isClaude(id)) {
      const agent = await this.claudeAgent(id);
      try { await agent.submit(requestId, text); }
      catch (error) {
        if (error instanceof ClaudeBusy) throw new Error("thread is already working or message is invalid", { cause: error });
        throw error;
      }
      return { runId: requestId };
    }
    const { conversation } = await this.agent(id);
    // Request identity is committed atomically with the user message by Pi,
    // not stored in a second host workflow journal.
    const prior = await conversation.commit(async tx => {
      const submission = await tx.submissionByRequest(conversation.id, requestId);
      if (!submission) return undefined;
      const entry = submission.type === "input" && submission.entry !== undefined ? await tx.entry(submission.entry) : undefined;
      return { type: submission.type, text: entry?.model?.[0] ? messageText(entry.model[0]) : undefined };
    }, context);
    if (prior && (prior.type !== "input" || (prior.text !== undefined && prior.text !== text))) throw new Error("message request conflicts with the previous request");
    try { await conversation.submit({ type: "input", content: text, requestId, whenBusy: "reject" }, context); }
    catch (error) {
      if (error instanceof ConversationBusy) throw new Error("thread is already working or message is invalid", { cause: error });
      throw error;
    }
    return { runId: requestId };
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
   * stream serves and the browser reads. */
  async events(id: string): Promise<ThreadEvents> {
    await this.settled(id);
    if (this.isClaude(id)) {
      const agent = await this.claudeAgent(id);
      let events = this.claudeFeeds.get(agent);
      if (!events) {
        events = new ClaudeThreadEvents({ agent, owner: () => this.owner(id), failure: () => this.failures.get(id) ?? null });
        this.claudeFeeds.set(agent, events);
      }
      return events;
    }
    const agent = await this.agent(id);
    let events = this.feeds.get(agent);
    if (!events) {
      events = new PiThreadEvents({ agent, owner: () => this.owner(id), failure: () => this.failures.get(id) ?? null });
      this.feeds.set(agent, events);
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
    const failure = this.failures.get(id) ?? null;
    if (threadAgent(thread) === "claude-code") {
      return readClaudeHistory(path.join(directory, "claude.sqlite"), path.join(directory, "claude"), this.owner(id), failure, request);
    }
    assertCurrentThreadStore(directory);
    return readPiHistory(path.join(directory, "pi.sqlite"), this.owner(id), failure, request);
  }
  async stream(id: string, response: ServerResponse): Promise<void> {
    await serveThreadEvents(await this.events(id), response);
  }
  /** Closes the agent and releases the machine. Its disk is deleted only
   * when cubed's own records show the agent never ran a command or wrote a
   * file in it and the machine's release check also reports clean; the
   * guest is agent-controlled, so its report alone never deletes a disk.
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
    if (!failed) {
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
        const workspace = this.openWorkspace(id);
        try { decision = await releaseCheck(workspace, threadAgent(thread), thread.allocation); }
        catch (error) { decision = { clean: false, reason: `the thread machine could not be checked: ${error instanceof Error ? error.message : String(error)}` }; }
        if (decision.clean && workspace.agentChanged()) decision = { clean: false, reason: "the agent ran commands or wrote files in the machine" };
      }
      this.closeWorkspace(id);
      this.resumed.delete(id);
      if (again) decision = { clean: thread.vm?.retain === false, reason: thread.vm?.retainReason ?? decision.reason };
      else if (thread.vm) this.registry.updateThreadVm(id, { retain: !decision.clean, retainReason: decision.reason });
      this.registry.beginRelease(id);
      const released = await this.release(id);
      return { retained: released.retained, reason: decision.reason };
    });
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
      this.registry.finishRelease(id);
      this.failures.delete(id);
      this.waits.delete(id);
      return released;
    } catch (error) {
      const message = `workspace release failed: ${error instanceof Error ? error.message : String(error)}`;
      this.registry.markWorkspaceFailed(id, message);
      this.failures.set(id, message);
      throw new Error(message, { cause: error });
    }
  }
  async stop(id: string): Promise<void> {
    await this.settled(id);
    if (this.isClaude(id)) { await (await this.claudeAgent(id)).stop(); return; }
    const agent = await this.agent(id);
    await agent.conversation.abort(context);
  }
  /** cubed stops; thread machines keep running and the next cubed attaches
   * to them again. */
  async close(): Promise<void> {
    this.closing = true;
    // A machine still booting is left to boot; the next cubed attaches to it.
    await this.machines.close();
    await Promise.allSettled(this.commands.values());
    await Promise.all([...this.agents].map(([id, promise]) => this.closePi(id, promise)));
    await Promise.all([...this.claudes.values()].map(async promise => (await promise.catch(() => null))?.close()));
    this.agents.clear(); this.claudes.clear();
    for (const id of [...this.workspaces.keys()]) this.closeWorkspace(id);
  }
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map(part => part.type === "text" ? part.text : part.type === "thinking" ? part.thinking : "").filter(Boolean).join("\n");
}
