/** Host activation and transport, never a second agent state machine. */
import path from "node:path";
import type { ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import { ConversationBusy, LiveDoc } from "@earendil-works/pi-durable";
import { ClaudeAgent, ClaudeBusy, CLAUDE_PROVIDER, type ClaudeRuntime } from "./claude-agent.ts";
import { ClaudeThreadEvents } from "./claude-thread-events.ts";
import { openAgent, type Agent } from "./durable-agent.ts";
import { createLogger } from "./log.ts";
import { PiThreadEvents } from "./pi-thread-events.ts";
import type { ThreadAgent, ThreadEvents, ThreadTranscript } from "./thread-events.ts";
import { serveThreadEvents } from "./thread-events-http.ts";
import { Registry, threadAgent, type Thread } from "./registry.ts";
import { provisioned, provisionWorkspace, releaseCheck, type ThreadMachines } from "./vm.ts";
import { VmWorkspace } from "./vm-workspace.ts";
import { LeaseStore } from "./workspace-lease.ts";
import type { ModelSelection } from "./models.ts";

const context = BACKGROUND_CONTEXT;
const log = createLogger("threads");
/** The registry's first message is submitted once under this request id. */
const INITIAL_REQUEST = "cube:initial";
export class Conversations {
  private readonly registry: Registry;
  private readonly directory: string;
  private readonly models: Models;
  private readonly machines: ThreadMachines;
  private readonly agents = new Map<string, Promise<Agent>>();
  private readonly workspaces = new Map<string, { workspace: VmWorkspace; leases: LeaseStore }>();
  private readonly failures = new Map<string, string>();
  private readonly activations = new Map<string, Promise<void>>();
  /** Threads whose archive is under way: nothing reopens their agent or
   * workspace meanwhile (the recovery loop runs beside commands). */
  private readonly archiving = new Set<string>();
  private readonly commands = new Map<string, Promise<unknown>>();
  private readonly feeds = new WeakMap<Agent, PiThreadEvents>();
  private readonly claudes = new Map<string, Promise<ClaudeAgent>>();
  private readonly claudeFeeds = new WeakMap<ClaudeAgent, ClaudeThreadEvents>();
  private readonly claude: ClaudeRuntime | null;
  private closing = false;
  /** `claude` is null when this host has no Claude Code to start. */
  constructor(options: { registry: Registry; directory: string; models: Models; machines: ThreadMachines; claude?: ClaudeRuntime | null }) {
    this.registry = options.registry; this.directory = options.directory; this.models = options.models;
    this.machines = options.machines; this.claude = options.claude ?? null;
  }
  /** Whether claude-code threads can run on this host. */
  get claudeAvailable(): boolean { return this.claude !== null; }
  /** Activates every open thread (machines boot concurrently) and finishes
   * releases a crash interrupted. Repeated by cubed's recovery loop; an
   * active thread's machine is only checked, not restarted. */
  async boot(): Promise<void> {
    const work: Promise<unknown>[] = [];
    for (const thread of this.registry.listThreads()) {
      if (thread.archived || this.closing || this.archiving.has(thread.id)) continue;
      if (thread.workspaceState === "releasing" || (thread.workspaceState === "failed" && thread.workspaceError?.startsWith("workspace release failed:"))) {
        work.push(this.command(thread.id, () => this.release(thread.id)).catch(() => {}));
      }
      else work.push(this.activate(thread.id));
    }
    await Promise.all(work);
  }
  error(id: string): string | null { return this.failures.get(id) ?? null; }
  /** Whether the thread's machine is being started. */
  starting(id: string): boolean { return this.activations.has(id); }
  /** Boots the thread's machine, provisions it once and opens its agent.
   * Concurrent calls share one activation. */
  activate(id: string): Promise<void> {
    const pending = this.activations.get(id);
    if (pending) return pending;
    if (this.archiving.has(id)) return Promise.resolve();
    const activation = (async () => {
      try {
        await this.ensureWorkspace(id);
        if (this.isClaude(id)) await this.claudeAgent(id);
        else await this.agent(id);
        this.failures.delete(id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.failures.get(id) !== message) log.warn("activation failed", { thread: id, error: message });
        this.failures.set(id, message);
      }
    })().finally(() => this.activations.delete(id));
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
    if (this.archiving.has(id)) throw new Error("thread is being archived");
  }
  private closeWorkspace(id: string): void {
    this.workspaces.get(id)?.leases.close();
    this.workspaces.delete(id);
  }
  /** Boots (or re-attaches) the machine; the first time, checks out the
   * project's pinned repositories in it. */
  private async ensureWorkspace(id: string): Promise<void> {
    const thread = this.thread(id);
    if (thread.workspaceState === "releasing") throw new Error("thread workspace is releasing");
    if (thread.workspaceState === "available") { await this.machines.start(thread); return; }
    try {
      await this.machines.start(thread);
      const owner = threadAgent(thread);
      const workspace = this.workspace(id);
      const last = thread.vm?.provisionAttempt ?? 0;
      if (!(last > 0 && await provisioned(workspace, owner, last))) {
        const attempt = last + 1;
        this.registry.updateThreadVm(id, { provisionAttempt: attempt });
        await provisionWorkspace(workspace, owner, thread.allocation, attempt);
      }
      const primary = thread.allocation.repositories[0];
      this.registry.markWorkspaceAvailable(id, primary
        ? { remote: primary.url, ref: primary.base.startsWith("refs/heads/") ? primary.base : `refs/heads/${primary.base}`, oid: primary.baseOid }
        : null);
    } catch (error) {
      const message = `workspace allocation failed: ${error instanceof Error ? error.message : String(error)}`;
      this.registry.markWorkspaceFailed(id, message);
      throw new Error(message, { cause: error });
    }
  }
  async agent(id: string): Promise<Agent> {
    if (this.closing) throw new Error("host is stopping");
    const thread = this.thread(id);
    if (threadAgent(thread) !== "pi") throw new Error("thread is not a pi thread");
    this.notArchiving(id);
    const cached = this.agents.get(id);
    if (cached) return cached;
    const loading = (async () => {
      const agent = await openAgent({ directory: path.join(this.directory, id), binding: this.binding(thread), workspace: this.workspace(id), models: this.models, model: thread.model });
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
  async claudeAgent(id: string): Promise<ClaudeAgent> {
    if (this.closing) throw new Error("host is stopping");
    const thread = this.thread(id);
    if (threadAgent(thread) !== "claude-code") throw new Error("thread is not a claude code thread");
    if (!this.claude) throw new Error("claude code is not installed on this host — install it and log in with claude /login");
    this.notArchiving(id);
    const cached = this.claudes.get(id);
    if (cached) return cached;
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
  async stream(id: string, response: ServerResponse): Promise<void> {
    await serveThreadEvents(await this.events(id), response);
  }
  /** Closes the agent and releases the machine. Its disk is deleted only
   * when cubed's own records show the agent never ran a command or wrote a
   * file in it and the machine's release check also reports clean; the
   * guest is agent-controlled, so its report alone never deletes a disk. */
  async archive(id: string): Promise<{ retained: boolean; reason: string }> {
    return this.command(id, async () => {
    await this.settled(id);
    const thread = this.registry.getThread(id);
    if (!thread) throw new Error("thread not found");
    const failed = thread.workspaceState === "failed";
    if (!failed) {
      if (this.isClaude(id)) {
        if ((await this.claudeAgent(id)).running) throw new Error("stop the current run before archiving");
      } else {
        const agent = await this.agent(id);
        if ((await agent.harness.snapshot(LiveDoc, agent.conversation.id, context))?.run) throw new Error("stop the current run before archiving");
      }
    }
    // From here until the release ends nothing reopens the thread.
    return this.withArchiving(id, async () => {
      let decision: { clean: boolean; reason: string };
      if (failed) decision = { clean: false, reason: thread.workspaceError ?? "the thread machine failed" };
      else {
        const claude = this.claudes.get(id), pi = this.agents.get(id);
        this.claudes.delete(id); this.agents.delete(id);
        await (await claude)?.close(); await (await pi)?.close();
        const workspace = this.openWorkspace(id);
        try { decision = await releaseCheck(workspace, threadAgent(thread), thread.allocation); }
        catch (error) { decision = { clean: false, reason: `the thread machine could not be checked: ${error instanceof Error ? error.message : String(error)}` }; }
        if (decision.clean && workspace.agentChanged()) decision = { clean: false, reason: "the agent ran commands or wrote files in the machine" };
      }
      this.closeWorkspace(id);
      if (thread.vm) this.registry.updateThreadVm(id, { retain: !decision.clean, retainReason: decision.reason });
      this.registry.beginRelease(id);
      const released = await this.release(id);
      return { retained: released.retained, reason: decision.reason };
    });
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
    await Promise.all([...this.agents.values()].map(async promise => (await promise.catch(() => null))?.close()));
    await Promise.all([...this.claudes.values()].map(async promise => (await promise.catch(() => null))?.close()));
    this.agents.clear(); this.claudes.clear();
    for (const id of [...this.workspaces.keys()]) this.closeWorkspace(id);
  }
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map(part => part.type === "text" ? part.text : part.type === "thinking" ? part.thinking : "").filter(Boolean).join("\n");
}
