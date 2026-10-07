/** The Claude Code adapter of the thread event model: renders the prompts
 * cubed accepted and the stream-json messages Claude Code printed into the
 * same `ThreadTranscript` the Pi adapter produces. Subagent internals
 * (messages with a parent tool use) stay inside their Agent tool call. */
import type { ClaudeAgent, ClaudeState, ClaudeSubmission } from "./claude-agent.ts";
import type { MessageImage, ThreadAgent, ThreadEvent, ThreadEvents, ThreadStatus, ThreadTranscript, ThreadWatch } from "./thread-events.ts";
import { imageNote, shownImage, THREAD_IMAGE_LIMITS } from "./thread-images.ts";

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
    return render(this.agent.state(), this.owner(), this.failure(), this.agent.root);
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

/** Claude Code's tools see the workspace at its host directory (`root`); the
 * transcript shows it as /workspace, as Pi threads do, never the host path:
 * in tool calls and results and in the agent's own words, so a picture the
 * agent names (`![…](path)`) is the path its Read showed. */
export function render(state: ClaudeState, owner: ThreadAgent | null, failure: string | null, root?: string): ThreadTranscript {
  const shown = root ? virtualize(root) : <T>(value: T) => value;
  const events: ThreadEvent[] = [];
  const names = new Map<string, string>();
  const bySubmission = new Map<number, ClaudeState["messages"]>();
  for (const message of state.messages) {
    const list = bySubmission.get(message.submission) ?? [];
    list.push(message);
    bySubmission.set(message.submission, list);
  }
  for (const submission of state.submissions) {
    events.push(submissionEvent(submission));
    for (const { seq, data } of bySubmission.get(submission.seq) ?? []) events.push(...messageEvents(seq, data, names, shown));
  }
  const current = state.submissions.at(-1);
  if (current?.state === "running") {
    state.partial.forEach((block, index) => {
      if (!block) return;
      const id = `live.${current.seq}.${index}`;
      if (block.type === "text" && block.text) events.push({ type: "assistant-text", id, text: shown(block.text), reasoning: false, final: false });
      else if (block.type === "thinking" && block.thinking) events.push({ type: "assistant-text", id, text: shown(block.thinking), reasoning: true, final: false });
      else if (block.type === "tool_use") events.push({ type: "tool-call", id, callId: block.id, name: block.name, input: shown(partialInput(block.json)), final: false });
    });
  }
  return { agent: "claude-code", owner, status: status(current, failure, state.waiting), events };
}

export const submissionEvent = (submission: Pick<ClaudeSubmission, "seq" | "text">): ThreadEvent => ({ type: "user-message", id: `s${submission.seq}`, text: submission.text });

/** The events of one stored stream-json message. `names` maps tool use ids
 * to tool names: the message's calls are added, its results look up the
 * calls before them. */
export function messageEvents(seq: number, data: Record<string, unknown>, names: Pick<Map<string, string>, "get" | "set">, shown: <T>(value: T) => T = value => value): ThreadEvent[] {
  if (data.parent_tool_use_id != null) return [];
  const events: ThreadEvent[] = [];
  const message = data.message as { content?: unknown } | undefined;
  const blocks: Block[] = Array.isArray(message?.content) ? message.content as Block[] : [];
  if (data.type === "assistant") {
    blocks.forEach((block, index) => {
      const id = `m${seq}.${index}`;
      if (block.type === "text" && block.text) events.push({ type: "assistant-text", id, text: shown(block.text), reasoning: false, final: true });
      else if (block.type === "thinking" && block.thinking) events.push({ type: "assistant-text", id, text: shown(block.thinking), reasoning: true, final: true });
      else if (block.type === "tool_use" && block.id) {
        names.set(block.id, block.name ?? "tool");
        events.push({ type: "tool-call", id, callId: block.id, name: block.name ?? "tool", input: shown(block.input ?? {}), final: true });
      }
    });
  } else if (data.type === "user") {
    blocks.forEach((block, index) => {
      if (block.type !== "tool_result" || !block.tool_use_id) return;
      const id = `m${seq}.${index}`;
      const { output, images } = resultContent(id, block.content);
      events.push({ type: "tool-result", id, callId: block.tool_use_id, name: names.get(block.tool_use_id) ?? "tool",
        output: shown(output), isError: block.is_error === true, final: true, ...images.length ? { images } : {} });
    });
  }
  return events;
}

/** `waiting`: the background agents running now (see claude-agent.ts). */
export function status(current: ClaudeSubmission | undefined, failure: string | null, waiting: readonly string[] = []): ThreadStatus {
  const background = waiting.length ? { waiting: [...waiting] } : {};
  if (!current) return { state: "idle", run: null, error: failure, ...background };
  if (current.state === "running") return { state: "working", run: current.requestId, error: failure, ...background };
  return { state: current.state, run: current.requestId, error: current.error ?? failure, ...background };
}

/** A tool result's text and the images it shows by reference (thread-images.ts);
 * an image beyond the bound, or one cube does not serve, stays a mark. */
function resultContent(id: string, content: unknown): { output: string; images: MessageImage[] } {
  if (typeof content === "string") return { output: content, images: [] };
  if (!Array.isArray(content)) return { output: "", images: [] };
  const images: MessageImage[] = [];
  let more = 0;
  const lines = (content as Array<Block & { source?: { type?: string; media_type?: unknown; data?: unknown } }>).flatMap((part, index) => {
    if (part.type === "text") return [part.text ?? ""];
    const image = part.type === "image" && part.source?.type === "base64" ? shownImage(`${id}.${index}`, part.source.media_type, part.source.data) : null;
    if (!image) return [`[${part.type ?? "content"}]`];
    if (images.length < THREAD_IMAGE_LIMITS.perEvent) images.push(image); else more++;
    return [];
  });
  if (more) lines.push(imageNote(more, true));
  return { output: lines.join("\n"), images };
}

export function virtualize(root: string) {
  const prefix = root.replace(/\/+$/, "");
  const swap = (text: string) => text.split(`${prefix}/`).join("/workspace/").split(prefix).join("/workspace");
  const walk = (value: unknown): unknown => typeof value === "string" ? swap(value)
    : Array.isArray(value) ? value.map(walk)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]))
    : value;
  return <T>(value: T): T => walk(value) as T;
}

function partialInput(json: string): unknown {
  try { return JSON.parse(json); } catch { return {}; }
}
