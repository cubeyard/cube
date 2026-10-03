/** The Claude Code adapter of the thread event model: renders the prompts
 * cubed accepted and the stream-json messages Claude Code printed into the
 * same `ThreadTranscript` the Pi adapter produces. Subagent internals
 * (messages with a parent tool use) stay inside their Agent tool call. */
import type { ClaudeAgent, ClaudeState, ClaudeSubmission } from "./claude-agent.ts";
import type { ThreadAgent, ThreadEvent, ThreadEvents, ThreadStatus, ThreadTranscript, ThreadWatch } from "./thread-events.ts";

type Block = { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown;
  tool_use_id?: string; content?: unknown; is_error?: boolean };

export class ClaudeThreadEvents implements ThreadEvents {
  private readonly agent: ClaudeAgent;
  private readonly owner: () => ThreadAgent | null;
  private readonly failure: () => string | null;
  constructor(options: { agent: ClaudeAgent; owner: () => ThreadAgent | null; failure: () => string | null }) {
    this.agent = options.agent; this.owner = options.owner; this.failure = options.failure;
  }

  async read(): Promise<ThreadTranscript> {
    return render(this.agent.state(), this.owner(), this.failure());
  }

  async watch(listener: (transcript: ThreadTranscript) => void | Promise<void>): Promise<ThreadWatch> {
    // One delivery at a time; changes during a delivery coalesce into the newest transcript.
    let dirty = false, delivering = false, stopped = false;
    let stopResolve!: () => void;
    const stopping = new Promise<void>(resolve => { stopResolve = resolve; });
    const deliver = async () => {
      if (delivering || stopped) { dirty = true; return; }
      delivering = true;
      try {
        do { dirty = false; await listener(await this.read()); } while (dirty && !stopped);
      } catch { /* a failed delivery waits for the next change */ }
      finally { delivering = false; }
    };
    await listener(await this.read());
    const unsubscribe = this.agent.subscribe(() => { void deliver(); });
    const closed = Promise.race([this.agent.closed, stopping]).then(() => { stopped = true; unsubscribe(); });
    return { closed, async stop() { stopResolve(); await closed; } };
  }
}

export function render(state: ClaudeState, owner: ThreadAgent | null, failure: string | null): ThreadTranscript {
  const events: ThreadEvent[] = [];
  const names = new Map<string, string>();
  const bySubmission = new Map<number, ClaudeState["messages"]>();
  for (const message of state.messages) {
    const list = bySubmission.get(message.submission) ?? [];
    list.push(message);
    bySubmission.set(message.submission, list);
  }
  for (const submission of state.submissions) {
    events.push({ type: "user-message", id: `s${submission.seq}`, text: submission.text });
    for (const { seq, data } of bySubmission.get(submission.seq) ?? []) {
      if (data.parent_tool_use_id != null) continue;
      const message = data.message as { content?: unknown } | undefined;
      const blocks: Block[] = Array.isArray(message?.content) ? message.content as Block[] : [];
      if (data.type === "assistant") {
        blocks.forEach((block, index) => {
          const id = `m${seq}.${index}`;
          if (block.type === "text" && block.text) events.push({ type: "assistant-text", id, text: block.text, reasoning: false, final: true });
          else if (block.type === "thinking" && block.thinking) events.push({ type: "assistant-text", id, text: block.thinking, reasoning: true, final: true });
          else if (block.type === "tool_use" && block.id) {
            names.set(block.id, block.name ?? "tool");
            events.push({ type: "tool-call", id, callId: block.id, name: block.name ?? "tool", input: block.input ?? {}, final: true });
          }
        });
      } else if (data.type === "user") {
        blocks.forEach((block, index) => {
          if (block.type !== "tool_result" || !block.tool_use_id) return;
          events.push({ type: "tool-result", id: `m${seq}.${index}`, callId: block.tool_use_id, name: names.get(block.tool_use_id) ?? "tool",
            output: resultText(block.content), isError: block.is_error === true, final: true });
        });
      }
    }
  }
  const current = state.submissions.at(-1);
  if (current?.state === "running") {
    state.partial.forEach((block, index) => {
      if (!block) return;
      const id = `live.${current.seq}.${index}`;
      if (block.type === "text" && block.text) events.push({ type: "assistant-text", id, text: block.text, reasoning: false, final: false });
      else if (block.type === "thinking" && block.thinking) events.push({ type: "assistant-text", id, text: block.thinking, reasoning: true, final: false });
      else if (block.type === "tool_use") events.push({ type: "tool-call", id, callId: block.id, name: block.name, input: partialInput(block.json), final: false });
    });
  }
  return { agent: "claude-code", owner, status: status(current, failure), events };
}

function status(current: ClaudeSubmission | undefined, failure: string | null): ThreadStatus {
  if (!current) return { state: "idle", run: null, error: failure };
  if (current.state === "running") return { state: "working", run: current.requestId, error: failure };
  return { state: current.state, run: current.requestId, error: current.error ?? failure };
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[]).map(part => part.type === "text" ? part.text ?? "" : `[${part.type ?? "content"}]`).join("\n");
}

function partialInput(json: string): unknown {
  try { return JSON.parse(json); } catch { return {}; }
}
