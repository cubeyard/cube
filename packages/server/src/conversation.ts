/** Host activation and transport, never a second agent state machine. */
import path from "node:path";
import type { ServerResponse } from "node:http";
import { BACKGROUND_CONTEXT, type LaneSnapshot, type AgentMessage } from "@earendil-works/pi-agent-core";
import type { Models } from "@earendil-works/pi-ai";
import { openAgent } from "./durable-agent.ts";
import { IrohExecutionNodeClient } from "./iroh-node.ts";
import { jevOutputComparison, redactJevDetails } from "./jev-memory.ts";
import type { JevSettings } from "./jev-settings.ts";
import { Registry } from "./registry.ts";
import type { ModelSelection } from "./models.ts";

const context = BACKGROUND_CONTEXT;
type Agent = Awaited<ReturnType<typeof openAgent>>;
export class Conversations {
  private readonly registry: Registry;
  private readonly directory: string;
  private readonly models: Models;
  private readonly jev: JevSettings;
  private readonly agents = new Map<string, Promise<Agent>>();
  private readonly drives = new Map<string, Promise<void>>();
  private readonly activations = new Set<string>();
  private readonly failures = new Map<string, string>();
  private readonly commands = new Map<string, Promise<unknown>>();
  private closing = false;
  constructor(registry: Registry, directory: string, models: Models, jev: JevSettings) {
    this.registry = registry; this.directory = directory; this.models = models; this.jev = jev;
  }
  async boot(): Promise<void> {
    for (const thread of this.registry.listThreads()) {
      if (!thread.archived) await this.activate(thread.id);
    }
  }
  error(id: string): string | null { return this.failures.get(id) ?? null; }
  async activate(id: string): Promise<void> {
    try {
      const agent = await this.agent(id);
      this.failures.delete(id);
      this.kick(id, agent);
    } catch (error) { this.failures.set(id, String(error)); }
  }
  async agent(id: string): Promise<Agent> {
    if (this.closing) throw new Error("host is stopping");
    const thread = this.registry.getThread(id);
    if (!thread || thread.archived) throw new Error("thread not found");
    const cached = this.agents.get(id);
    if (cached) return cached;
    const loading = (async () => {
      const admission = this.registry.runner(id)!;
      const runner = new IrohExecutionNodeClient({ configPath: admission.configPath, configHash: admission.configHash });
      const agent = await openAgent({ directory: path.join(this.directory, id), runner, models: this.models, model: thread.model, getJevApiKey: () => this.jev.apiKey() });
      try {
        const watch = await agent.lane.watch(context);
        watch.unsubscribe();
        const initial = this.registry.initialPrompt(id);
        if (!watch.snapshot.transcript.length && !watch.snapshot.operation && initial) {
          const accepted = await agent.lane.accept({ kind: "prompt", prompt: initial }, context);
          if (!accepted.ok) throw new Error("could not accept first message");
        }
        this.kick(id, agent);
        return agent;
      } catch (error) { await agent.close(); throw error; }
    })();
    this.agents.set(id, loading);
    try { return await loading; }
    catch (error) { this.agents.delete(id); throw error; }
  }
  private kick(id: string, agent: Agent): void {
    if (this.closing) return;
    if (this.drives.has(id)) { this.activations.add(id); return; }
    const drive = (async () => {
      const execution = await agent.lane.inspectExecution(context);
      if (!execution.current) return;
      this.failures.delete(id);
      const result = await agent.lane.drive({ operationId: execution.current.id, waitForRetry: true, pollDeferred: true }, context);
      if (!result.ok) throw new Error("could not resume thread");
    })().catch(error => { if (!this.closing) this.failures.set(id, String(error)); });
    this.drives.set(id, drive);
    void drive.finally(() => {
      this.drives.delete(id);
      if (this.activations.delete(id)) this.kick(id, agent);
    });
  }
  private async command<T>(id: string, action: () => Promise<T>): Promise<T> {
    const promise = (this.commands.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    this.commands.set(id, promise);
    try { return await promise; }
    finally { if (this.commands.get(id) === promise) this.commands.delete(id); }
  }
  submit(id: string, text: string, operationId: string): Promise<{ runId: string }> {
    return this.command(id, () => this.accept(id, text, operationId));
  }
  private async accept(id: string, text: string, operationId: string): Promise<{ runId: string }> {
    const agent = await this.agent(id);
    const watch = await agent.lane.watch(context);
    watch.unsubscribe();
    const prior = watch.snapshot.transcript.find(entry => entry.type === "message" &&
      (entry.message as AgentMessage & { cubeRequestId?: string }).cubeRequestId === operationId);
    if (prior?.type === "message") {
      if (messageText(prior.message) !== text) throw new Error("message request conflicts with the previous request");
      this.kick(id, agent);
      return { runId: operationId };
    }
    // Request identity is committed atomically with the user message by Pi,
    // not stored in a second host workflow journal.
    const prompt = { role: "user" as const, content: text, timestamp: Date.now(), cubeRequestId: operationId };
    const accepted = await agent.lane.accept({ kind: "prompt", prompt, operationId }, context);
    if (!accepted.ok) throw new Error("thread is already working or message is invalid");
    this.kick(id, agent);
    return { runId: accepted.value.operationId };
  }
  async model(id: string, selection?: ModelSelection): Promise<ModelSelection> {
    return this.command(id, async () => {
    const agent = await this.agent(id);
    if (selection) {
      if ((await agent.lane.inspectExecution(context)).current) throw new Error("wait for the current run before changing model");
      if (!this.models.getModel(selection.provider, selection.id)) throw new Error("model unavailable");
      await agent.lane.setModel({ provider: selection.provider, modelId: selection.id }, context);
    }
    const selected = (await agent.lane.inspectExecution(context)).configuredModel;
    return { provider: selected.provider, id: selected.modelId };
    });
  }
  async syncMemory(): Promise<void> {
    await Promise.all([...this.agents.values()].map(async agent => (await agent).syncMemory()));
  }
  async history(id: string) {
    const watch = await (await this.agent(id)).lane.watch(context);
    watch.unsubscribe();
    return history(watch.snapshot, this.failures.get(id));
  }
  async toolOutput(id: string, toolCallId: string) {
    const lane = (await this.agent(id)).lane;
    const entries = await lane.findEntries({ type: "message", order: "newestFirst" }, context);
    for (const entry of entries) {
      if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolCallId !== toolCallId) continue;
      const comparison = jevOutputComparison(entry.message);
      if (!comparison) throw new Error("tool output was not compressed by JEV");
      return comparison;
    }
    throw new Error("tool output not found");
  }
  async stream(id: string, response: ServerResponse): Promise<void> {
    const watch = await (await this.agent(id)).lane.watch(context);
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" });
    let closed = false;
    let pending = false;
    let dirty = false;
    const send = async (snapshot: LaneSnapshot) => {
      if (!response.write(`data: ${JSON.stringify(history(snapshot, this.failures.get(id)))}\n\n`)) {
        await new Promise<void>(resolve => {
          const done = () => { response.off("drain", done); response.off("close", done); resolve(); };
          response.once("drain", done); response.once("close", done);
        });
      }
    };
    // Coalesce frames, not durable state. Reconnect always reads Pi's snapshot.
    const flush = async () => {
      if (pending || closed) return;
      pending = true;
      try {
        do { dirty = false; const snapshot = await watch.resnapshot(context); if (!closed) await send(snapshot); } while (dirty && !closed);
      } catch { response.destroy(); }
      finally { pending = false; }
    };
    const heartbeat = setInterval(() => { if (!pending) response.write(": keepalive\n\n"); }, 15000);
    response.on("close", () => { closed = true; clearInterval(heartbeat); watch.unsubscribe(); });
    pending = true;
    watch.start(() => { dirty = true; void flush(); });
    try { await send(watch.snapshot); }
    finally { pending = false; if (dirty) void flush(); }
  }
  async archive(id: string): Promise<void> {
    return this.command(id, async () => {
    const thread = this.registry.getThread(id);
    if (!thread) throw new Error("thread not found");
    const agent = await this.agent(id);
    const execution = await agent.lane.inspectExecution(context);
    if (execution.current) throw new Error("stop the current run before archiving");
    this.registry.saveThread({ ...thread, archived: true });
    await agent.close(); this.agents.delete(id);
    });
  }
  async stop(id: string): Promise<void> {
    const agent = await this.agent(id);
    await agent.lane.abort(context);
  }
  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled(this.commands.values());
    await Promise.all([...this.agents.values()].map(async promise => (await promise).close()));
    await Promise.all(this.drives.values());
    this.agents.clear();
  }
}

function messageText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map(part => part.type === "text" ? part.text : part.type === "thinking" ? part.thinking : "").filter(Boolean).join("\n");
}
function history(snapshot: LaneSnapshot, failure?: string) {
  const messages = snapshot.transcript.flatMap(entry => entry.type === "message" ? [{
    seq: entry.id, role: entry.message.role === "toolResult" ? "tool" : entry.message.role,
    content: messageText(entry.message), payload: entry.message.role === "toolResult" ? redactJevDetails(entry.message) : entry.message, finalized: true,
  }] : []);
  const streaming = snapshot.operation?.streamingMessage;
  if (streaming) messages.push({ seq: `stream-${snapshot.operation!.id}`, role: "assistant", content: messageText(streaming), payload: streaming, finalized: false });
  const terminal = snapshot.lastResult;
  return { messages, run: snapshot.operation ? { id: snapshot.operation.id, status: "running", error: failure ?? null }
    : terminal ? { id: terminal.operationId, status: terminal.status === "completed" ? "completed" : "failed", error: terminal.error?.message ?? (terminal.status === "aborted" ? "stopped" : null) } : null };
}
