/** The Pi adapter of the thread event model: renders pi-durable's
 * conversation view (entries plus `pi.live`) into `ThreadTranscript`s. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { ROOT_CONVERSATION_ID, type ConversationView, type EntryRecord, type Storage, type SubmissionRecord, type ToolSlot } from "@earendil-works/pi-durable";
import type { Agent } from "./durable-agent.ts";
import type { ThreadAgent, ThreadEvent, ThreadEvents, ThreadStatus, ThreadTranscript, ThreadWatch } from "./thread-events.ts";

const context = BACKGROUND_CONTEXT;
const SHOWN = new Set(["pi.user", "pi.assistant", "pi.tool-result"]);
type Live = { run?: { taskId: number; inputs: number[] }; generation?: { message?: AssistantMessage }; tools?: ToolSlot[] };

export class PiThreadEvents implements ThreadEvents {
  private readonly agent: Pick<Agent, "conversation" | "storage">;
  private readonly owner: () => ThreadAgent | null;
  private readonly failure: () => string | null;
  private earlier: { head: number; events: ThreadEvent[] } | undefined;
  private settled: { key: string; status: ThreadStatus } | undefined;
  constructor(options: { agent: Pick<Agent, "conversation" | "storage">; owner: () => ThreadAgent | null; failure: () => string | null }) {
    this.agent = options.agent; this.owner = options.owner; this.failure = options.failure;
  }

  async read(): Promise<ThreadTranscript> {
    const watch = await this.agent.conversation.watch(context);
    try { return await this.render(watch.value); }
    finally { await watch.stop(); }
  }

  async watch(listener: (transcript: ThreadTranscript) => void | Promise<void>): Promise<ThreadWatch> {
    // Pi's watch delivers one frame at a time and coalesces a slow listener
    // to the newest view.
    const watch = await this.agent.conversation.watch(context);
    try { await listener(await this.render(watch.value)); }
    catch (error) { await watch.stop(); throw error; }
    watch.start(async value => { await listener(await this.render(value)); });
    return { closed: watch.closed.then(() => {}), async stop() { await watch.stop(); } };
  }

  /** Pi's view holds the active context; entries a compaction or reset hid
   * from the model are still part of the thread, read once and kept. */
  private async render(view: ConversationView): Promise<ThreadTranscript> {
    const head = view.entries[0]?.head;
    let earlier: ThreadEvent[] = [];
    if (head !== undefined && head > 1) {
      if (this.earlier?.head === head) earlier = this.earlier.events;
      else {
        const entries: EntryRecord[] = [];
        let cursor;
        do {
          const page = await this.agent.conversation.entries({ maxEntryId: head }, 256, cursor, context);
          entries.push(...page.items.filter(entry => entry.id < head));
          cursor = page.next;
        } while (cursor);
        earlier = entryEvents(entries.reverse());
        this.earlier = { head, events: earlier };
      }
    }
    const live = view.docs["pi.live"] as Live | undefined;
    const events = [...earlier, ...entryEvents(view.entries)];
    if (live?.run) {
      const streaming = live.generation?.message;
      if (streaming) events.push(...assistantEvents(streaming, `live.${live.run.taskId}`, false));
      for (const slot of live.tools ?? []) {
        if (slot.status !== "running") continue;
        events.push({ type: "tool-result", id: `live.tool.${slot.callId}`, callId: slot.callId, name: slot.name, output: slot.output ?? "", isError: false, final: false });
      }
    }
    const status: ThreadStatus = live?.run
      ? { state: "working", run: String(live.run.inputs[0] ?? live.run.taskId), error: this.failure() }
      : await this.lastRun(`${view.entries.length}:${view.entries.at(-1)?.id}`);
    return { agent: "pi", owner: this.owner(), status, events };
  }

  /** The newest settled input decides the idle status. */
  private async lastRun(key: string): Promise<ThreadStatus> {
    if (this.settled?.key === key) return this.settled.status;
    let last: SubmissionRecord | undefined;
    let cursor;
    do {
      const page = await this.agent.storage.scanSubmissions({ conversationId: this.agent.conversation.id }, 256, cursor, context);
      last = page.items.findLast(submission => submission.type === "input" && (submission.status === "done" || submission.status === "unanswered")) ?? last;
      cursor = page.next;
    } while (cursor);
    const status: ThreadStatus = !last ? { state: "idle", run: null, error: null }
      : { run: last.requestId ?? String(last.id), ...settlement(last) };
    this.settled = { key, status };
    return status;
  }
}

/** A Pi thread's transcript from its store alone, without its Harness: every
 * committed entry and the newest input's state. A run the store shows as
 * working goes on only while the thread's agent is open. */
export async function storedPiTranscript(storage: Pick<Storage, "scanEntries" | "scanSubmissions">, owner: ThreadAgent | null, failure: string | null): Promise<ThreadTranscript> {
  const entries: EntryRecord[] = [];
  let cursor;
  do {
    const page = await storage.scanEntries({ conversationId: ROOT_CONVERSATION_ID }, 256, cursor, context);
    entries.push(...page.items);
    cursor = page.next;
  } while (cursor);
  let last: SubmissionRecord | undefined;
  cursor = undefined;
  do {
    const page = await storage.scanSubmissions({ conversationId: ROOT_CONVERSATION_ID }, 256, cursor, context);
    last = page.items.findLast(submission => submission.type === "input") ?? last;
    cursor = page.next;
  } while (cursor);
  const status: ThreadStatus = !last ? { state: "idle", run: null, error: null }
    : last.status === "queued" || last.status === "placed" ? { state: "working", run: last.requestId ?? String(last.id), error: failure }
    : { run: last.requestId ?? String(last.id), ...settlement(last) };
  return { agent: "pi", owner, status, events: entryEvents(entries.sort((a, b) => a.id - b.id)) };
}

function settlement(submission: SubmissionRecord): Pick<ThreadStatus, "state" | "error"> {
  if (submission.status === "done") return { state: "completed", error: null };
  if (submission.reason === "aborted") return { state: "stopped", error: null };
  return {
    state: "failed",
    error: typeof submission.detail === "string" ? submission.detail : submission.reason === "no_model" ? "model unavailable — choose another model" : submission.reason ?? null,
  };
}

function entryEvents(entries: readonly EntryRecord[]): ThreadEvent[] {
  return entries.flatMap(entry => SHOWN.has(entry.kind) ? (entry.model ?? []).flatMap((message, index) => messageEvents(message, `${entry.id}.${index}`)) : []);
}

function messageEvents(message: Message, id: string): ThreadEvent[] {
  if (message.role === "user") {
    const text = typeof message.content === "string" ? message.content
      : message.content.map(part => part.type === "text" ? part.text : "[image]").join("\n");
    return [{ type: "user-message", id, text }];
  }
  if (message.role === "assistant") return assistantEvents(message, id, true);
  if (message.role !== "toolResult") return [];
  return [{
    type: "tool-result", id, callId: message.toolCallId, name: message.toolName, isError: message.isError, final: true,
    output: message.content.map(part => part.type === "text" ? harnessNote(part.text) : "[image]").join("\n"),
  }];
}

/** pi-durable appends a tool's diagnostics for the model as one
 * `<harness>` block; the thread shows the diagnostic lines themselves. */
function harnessNote(text: string): string {
  return /^<harness>\n([\s\S]*)\n<\/harness>$/.exec(text)?.[1] ?? text;
}

function assistantEvents(message: AssistantMessage, id: string, final: boolean): ThreadEvent[] {
  return message.content.flatMap((part, index): ThreadEvent[] => {
    const partId = `${id}.${index}`;
    if (part.type === "text") return part.text ? [{ type: "assistant-text", id: partId, text: part.text, reasoning: false, final }] : [];
    if (part.type === "thinking") return part.thinking && !part.redacted ? [{ type: "assistant-text", id: partId, text: part.thinking, reasoning: true, final }] : [];
    return [{ type: "tool-call", id: partId, callId: part.id, name: part.name, input: part.arguments ?? {}, final }];
  });
}
