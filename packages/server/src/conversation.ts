/** Host activation and transport, never a second agent state machine. */
import path from "node:path";
import type { ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, Models } from "@earendil-works/pi-ai";
import { ConversationBusy, LiveDoc, type ConversationView, type EntryRecord, type SubmissionRecord } from "@earendil-works/pi-durable";
import { openAgent, type Agent } from "./durable-agent.ts";
import { IrohExecutionNodeClient } from "./iroh-node.ts";
import { Registry } from "./registry.ts";
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
  private closing = false;
  constructor(registry: Registry, directory: string, models: Models) {
    this.registry = registry; this.directory = directory; this.models = models;
  }
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
      await this.agent(id);
      this.failures.delete(id);
    } catch (error) { this.failures.set(id, String(error)); }
  }
  private runner(id: string): IrohExecutionNodeClient {
    const admission = this.registry.runner(id);
    if (!admission) throw new Error("thread runner allocation is missing");
    return new IrohExecutionNodeClient({ configPath: admission.configPath, configHash: admission.configHash, threadId: id });
  }
  /** The thread's one Workspace and lease store. Every thread agent is Pi
   * until a thread records another agent. */
  workspace(id: string): RunnerWorkspace {
    if (this.closing) throw new Error("host is stopping");
    const cached = this.workspaces.get(id);
    if (cached) return cached.workspace;
    const runner = this.runner(id);
    const leases = new LeaseStore(path.join(this.directory, id));
    const workspace = new RunnerWorkspace({ runner, leases, owner: "pi" });
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
    const agent = await this.agent(id);
    if (selection) {
      if ((await agent.harness.snapshot(LiveDoc, agent.conversation.id, context))?.run) throw new Error("wait for the current run before changing model");
      if (!this.models.getModel(selection.provider, selection.id)) throw new Error("model unavailable");
      await agent.conversation.configure({ model: { provider: selection.provider, modelId: selection.id } }, context);
    }
    const selected = (await agent.conversation.agent(context)).model;
    if (!selected) throw new Error("thread has no model");
    return { provider: selected.provider, id: selected.modelId };
    });
  }
  async history(id: string) {
    const agent = await this.agent(id);
    const watch = await agent.conversation.watch(context);
    try { return await this.render(id, agent, watch.value); }
    finally { await watch.stop(); }
  }
  async stream(id: string, response: ServerResponse): Promise<void> {
    const agent = await this.agent(id);
    const watch = await agent.conversation.watch(context);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
    let closed = false;
    let pending = false;
    const send = async (view: ConversationView) => {
      if (closed) return;
      pending = true;
      try {
        if (!response.write(`data: ${JSON.stringify(await this.render(id, agent, view))}\n\n`)) {
          await new Promise<void>(resolve => {
            const done = () => { response.off("drain", done); response.off("close", done); resolve(); };
            response.once("drain", done); response.once("close", done);
          });
        }
      } finally { pending = false; }
    };
    // Pi's watch delivers one frame at a time and coalesces a slow client to
    // the newest view; reconnect starts from the current committed view.
    const heartbeat = setInterval(() => { if (!pending) response.write(": keepalive\n\n"); }, 15000);
    response.on("close", () => { closed = true; clearInterval(heartbeat); void watch.stop(); });
    try { await send(watch.value); }
    catch { response.destroy(); return; }
    watch.start(async value => { try { await send(value); } catch { response.destroy(); } });
  }
  private readonly earlier = new Map<string, { head: number; messages: HistoryMessage[] }>();
  private readonly results = new Map<string, { key: string; run: HistoryRun | null }>();
  /** The thread transcript in cube's shape. Pi's view holds the active
   * context; entries a compaction or reset hid are read once and kept. */
  private async render(id: string, agent: Agent, view: ConversationView) {
    // A head marker (compaction or reset) leads the view; the entries before
    // its head are only hidden from the model, not from the thread.
    const head = view.entries[0]?.head;
    let earlier: HistoryMessage[] = [];
    if (head !== undefined && head > 1) {
      const cached = this.earlier.get(id);
      if (cached?.head === head) earlier = cached.messages;
      else {
        const entries: EntryRecord[] = [];
        let cursor;
        do {
          const page = await agent.conversation.entries({ maxEntryId: head }, 256, cursor, context);
          entries.push(...page.items.filter(entry => entry.id < head));
          cursor = page.next;
        } while (cursor);
        earlier = messages(entries.reverse());
        this.earlier.set(id, { head, messages: earlier });
      }
    }
    const live = view.docs["pi.live"] as { run?: { taskId: number; inputs: number[] }; generation?: { message?: Message } } | undefined;
    const all = [...earlier, ...messages(view.entries)];
    const streaming = live?.generation?.message;
    if (streaming && live?.run) all.push({ seq: `stream-${live.run.taskId}`, role: "assistant", content: messageText(streaming), payload: streaming, finalized: false });
    const failure = this.failures.get(id) ?? null;
    if (live?.run) return { messages: all, run: { id: String(live.run.inputs[0] ?? live.run.taskId), status: "running", error: failure } as HistoryRun };
    return { messages: all, run: await this.lastRun(id, agent, `${view.entries.length}:${view.entries.at(-1)?.id}`) };
  }
  /** The newest settled input decides the idle run state. */
  private async lastRun(id: string, agent: Agent, key: string): Promise<HistoryRun | null> {
    const cached = this.results.get(id);
    if (cached?.key === key) return cached.run;
    let last: SubmissionRecord | undefined;
    let cursor;
    do {
      const page = await agent.storage.scanSubmissions({ conversationId: agent.conversation.id }, 256, cursor, context);
      last = page.items.findLast(submission => submission.type === "input" && (submission.status === "done" || submission.status === "unanswered")) ?? last;
      cursor = page.next;
    } while (cursor);
    const run: HistoryRun | null = !last ? null : { id: last.requestId ?? String(last.id), status: last.status === "done" ? "completed" : "failed",
      error: last.status === "done" ? null : last.reason === "aborted" ? "stopped" : typeof last.detail === "string" ? last.detail : last.reason === "no_model" ? "model unavailable — choose another model" : last.reason ?? null };
    this.results.set(id, { key, run });
    return run;
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
    const agent = await this.agent(id);
    if ((await agent.harness.snapshot(LiveDoc, agent.conversation.id, context))?.run) throw new Error("stop the current run before archiving");
    await agent.close(); this.agents.delete(id); this.earlier.delete(id); this.results.delete(id);
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
    const agent = await this.agent(id);
    await agent.conversation.abort(context);
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.commands.values());
    await Promise.all([...this.agents.values()].map(async promise => (await promise).close()));
    this.agents.clear();
    for (const id of [...this.workspaces.keys()]) this.closeWorkspace(id);
  }
}

type HistoryMessage = { seq: number | string; role: string; content: string; payload: Message; finalized: boolean };
type HistoryRun = { id: string; status: string; error: string | null };
const SHOWN = new Set(["pi.user", "pi.assistant", "pi.tool-result"]);
function messages(entries: readonly EntryRecord[]): HistoryMessage[] {
  return entries.flatMap(entry => SHOWN.has(entry.kind) ? (entry.model ?? []).map(message => ({
    seq: entry.id, role: message.role === "toolResult" ? "tool" : message.role, content: messageText(message), payload: message, finalized: true,
  })) : []);
}
function messageText(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map(part => part.type === "text" ? part.text : part.type === "thinking" ? part.thinking : "").filter(Boolean).join("\n");
}
