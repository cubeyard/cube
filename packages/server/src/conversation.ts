/** Host activation and transport, never a second agent state machine. */
import path from "node:path";
import type { ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import { ConversationBusy, LiveDoc } from "@earendil-works/pi-durable";
import { ClaudeAgent, ClaudeBusy, CLAUDE_PROVIDER, type ClaudeRuntime } from "./claude-agent.ts";
import { ClaudeThreadEvents } from "./claude-thread-events.ts";
import { openAgent, type Agent } from "./durable-agent.ts";
import { IrohExecutionNodeClient } from "./iroh-node.ts";
import { PiThreadEvents } from "./pi-thread-events.ts";
import type { ThreadAgent, ThreadEvents, ThreadTranscript } from "./thread-events.ts";
import { serveThreadEvents } from "./thread-events-http.ts";
import { Registry, threadAgent } from "./registry.ts";
import { RunnerWorkspace } from "./workspace.ts";
import { LeaseStore } from "./workspace-lease.ts";
import type { ModelSelection } from "./models.ts";

const context = BACKGROUND_CONTEXT;
/** The registry's first message is submitted once under this request id. */
const INITIAL_REQUEST = "cube:initial";
export class Conversations {
  private readonly registry: Registry;
  private readonly directory: string;
  private readonly models: Models;
  private readonly agents = new Map<string, Promise<Agent>>();
  private readonly workspaces = new Map<string, { workspace: RunnerWorkspace; leases: LeaseStore }>();
  private readonly failures = new Map<string, string>();
  private readonly commands = new Map<string, Promise<unknown>>();
  private readonly feeds = new WeakMap<Agent, PiThreadEvents>();
  private readonly claudes = new Map<string, Promise<ClaudeAgent>>();
  private readonly claudeFeeds = new WeakMap<ClaudeAgent, ClaudeThreadEvents>();
  private readonly claude: ClaudeRuntime | null;
  private closing = false;
  /** `claude` is null when this host has no Claude Code to start. */
  constructor(registry: Registry, directory: string, models: Models, claude: ClaudeRuntime | null = null) {
    this.registry = registry; this.directory = directory; this.models = models; this.claude = claude;
  }
  /** Whether claude-code threads can run on this host. */
  get claudeAvailable(): boolean { return this.claude !== null; }
  async boot(): Promise<void> {
    for (const thread of this.registry.listThreads()) {
      if (thread.archived) continue;
      if (thread.workspaceState === "releasing" || (thread.workspaceState === "failed" && thread.workspaceError?.startsWith("workspace release failed:"))) {
        await this.release(thread.id).catch(() => {});
      }
      else await this.activate(thread.id);
    }
  }
  error(id: string): string | null { return this.failures.get(id) ?? null; }
  async activate(id: string): Promise<void> {
    try {
      await this.ensureWorkspace(id);
      if (this.isClaude(id)) await this.claudeAgent(id);
      else await this.agent(id);
      this.failures.delete(id);
    } catch (error) { this.failures.set(id, String(error)); }
  }
  private runner(id: string): IrohExecutionNodeClient {
    const admission = this.registry.runner(id);
    if (!admission) throw new Error("thread runner allocation is missing");
    return new IrohExecutionNodeClient({ configPath: admission.configPath, configHash: admission.configHash, threadId: id });
  }
  private isClaude(id: string): boolean {
    const thread = this.registry.getThread(id);
    return !!thread && threadAgent(thread) === "claude-code";
  }
  /** The thread's one Workspace and lease store; its owner is the agent the
   * thread was created with. */
  workspace(id: string): RunnerWorkspace {
    if (this.closing) throw new Error("host is stopping");
    const cached = this.workspaces.get(id);
    if (cached) return cached.workspace;
    const runner = this.runner(id);
    const leases = new LeaseStore(path.join(this.directory, id));
    const thread = this.registry.getThread(id);
    const workspace = new RunnerWorkspace({ runner, leases, owner: thread ? threadAgent(thread) : "pi" });
    this.workspaces.set(id, { workspace, leases });
    return workspace;
  }
  private closeWorkspace(id: string): void {
    this.workspaces.get(id)?.leases.close();
    this.workspaces.delete(id);
  }
  private async ensureWorkspace(id: string): Promise<void> {
    const thread = this.registry.getThread(id);
    if (!thread || thread.archived) throw new Error("thread not found");
    if (thread.workspaceState === "available") return;
    if (thread.workspaceState === "releasing") throw new Error("thread workspace is releasing");
    try {
      await this.runner(id).allocateWorkspace(thread.allocation);
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
    const thread = this.registry.getThread(id);
    if (!thread || thread.archived) throw new Error("thread not found");
    if (threadAgent(thread) !== "pi") throw new Error("thread is not a pi thread");
    const cached = this.agents.get(id);
    if (cached) return cached;
    const loading = (async () => {
      const runner = this.runner(id);
      const agent = await openAgent({ directory: path.join(this.directory, id), runner, workspace: this.workspace(id), models: this.models, model: thread.model });
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
    const thread = this.registry.getThread(id);
    if (!thread || thread.archived) throw new Error("thread not found");
    if (threadAgent(thread) !== "claude-code") throw new Error("thread is not a claude code thread");
    if (!this.claude) throw new Error("claude code is not installed on this host — install it and log in with claude /login");
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
    return this.command(id, () => this.accept(id, text, requestId));
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
  async archive(id: string): Promise<void> {
    return this.command(id, async () => {
    const thread = this.registry.getThread(id);
    if (!thread) throw new Error("thread not found");
    if (thread.workspaceState === "failed") {
      this.closeWorkspace(id);
      this.registry.beginRelease(id);
      await this.release(id);
      return;
    }
    if (this.isClaude(id)) {
      const agent = await this.claudeAgent(id);
      if (agent.running) throw new Error("stop the current run before archiving");
      await agent.close(); this.claudes.delete(id);
    } else {
      const agent = await this.agent(id);
      if ((await agent.harness.snapshot(LiveDoc, agent.conversation.id, context))?.run) throw new Error("stop the current run before archiving");
      await agent.close(); this.agents.delete(id);
    }
    this.closeWorkspace(id);
    this.registry.beginRelease(id);
    await this.release(id);
    });
  }
  private async release(id: string): Promise<void> {
    try {
      await this.runner(id).releaseWorkspace();
      this.registry.finishRelease(id);
      this.failures.delete(id);
    } catch (error) {
      const message = `workspace release failed: ${error instanceof Error ? error.message : String(error)}`;
      this.registry.markWorkspaceFailed(id, message);
      this.failures.set(id, message);
      throw new Error(message, { cause: error });
    }
  }
  async stop(id: string): Promise<void> {
    if (this.isClaude(id)) { await (await this.claudeAgent(id)).stop(); return; }
    const agent = await this.agent(id);
    await agent.conversation.abort(context);
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.commands.values());
    await Promise.all([...this.agents.values()].map(async promise => (await promise).close()));
    await Promise.all([...this.claudes.values()].map(async promise => (await promise.catch(() => null))?.close()));
    this.agents.clear(); this.claudes.clear();
    for (const id of [...this.workspaces.keys()]) this.closeWorkspace(id);
  }
}

function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map(part => part.type === "text" ? part.text : part.type === "thinking" ? part.thinking : "").filter(Boolean).join("\n");
}
