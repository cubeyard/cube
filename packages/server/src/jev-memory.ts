import { TypeSafeClient, choice, noul, type SystemOneRequest } from "@typesafe-ai/sdk";
import {
  list,
  type AgentHarness,
  type AgentMessage,
  type AgentToolResult,
  type Context,
  type JsonValue,
  type Session,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const MIN_TOOL_CHARS = 4_800;
const MEMORY_LIMIT = 150;
const MEMORY_CHARS = 8_000;
const NOTES = list<MemoryNote>("cube.jev", "memory");

interface MemoryNote {
  text: string;
  source: "user" | "assistant";
  createdAt: number;
}

interface StoredOutput {
  [key: string]: JsonValue;
  full: string;
  view: string;
  sentLines: number;
  totalLines: number;
}

export interface JevOutputComparison {
  original: string;
  compressed: string;
  view: string;
  sentLines: number;
  totalLines: number;
}

interface JevAnswer {
  noul?: number;
  choice?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}

export type JevAsk = (apiKey: string, request: SystemOneRequest, signal?: AbortSignal) => Promise<Record<string, JevAnswer>>;

const defaultAsk: JevAsk = async (apiKey, request, signal) => {
  const client = new TypeSafeClient({ apiKey, logLevel: "off", retry: { maxRetries: 0 }, timeout: 15_000 });
  const result = await client.systemOne(request, { signal, timeout: 15_000, retry: { maxRetries: 0 } });
  return result.answers as Record<string, JevAnswer>;
};

function textContent(content: AgentToolResult<unknown>["content"]): string | null {
  if (content.some(part => part.type !== "text")) return null;
  return content.map(part => part.type === "text" ? part.text : "").join("\n");
}

function messageText(message: AgentMessage): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map(part => part.type === "text" ? part.text : "").filter(Boolean).join("\n");
}

function compact(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}

export interface TextView {
  name: string;
  text: string;
  lines: number[];
}

/** Deterministic subsets only: JEV selects a view but never writes tool output. */
export function toolViews(full: string): TextView[] {
  const lines = full.split("\n");
  const make = (name: string, indexes: number[]) => {
    const unique = [...new Set(indexes.filter(index => index >= 0 && index < lines.length))].sort((a, b) => a - b);
    const selected: string[] = [];
    let previous = -2;
    for (const index of unique) {
      if (index > previous + 1) selected.push("⋯");
      selected.push(lines[index]!);
      previous = index;
    }
    return { name, text: selected.join("\n"), lines: unique.map(index => index + 1) };
  };
  const edge = [...Array(Math.min(24, lines.length)).keys(), ...Array.from({ length: Math.min(24, lines.length) }, (_, i) => lines.length - 1 - i)];
  const signals = lines.flatMap((line, index) => /\b(error|failed?|warning|summary|passed?|exit|result)\b/i.test(line) ? [index] : []);
  const candidates = [
    make("signals", [...signals, ...Array.from({ length: Math.min(16, lines.length) }, (_, i) => lines.length - 1 - i)]),
    make("head and tail", edge),
  ].filter(view => view.text.length < full.length * 0.75);
  return [...candidates, { name: "full", text: full, lines: lines.map((_, index) => index + 1) }];
}

export class JevMemory {
  private readonly session: Pick<Session, "readList" | "appendList">;
  private readonly getApiKey: () => string | null;
  private readonly ask: JevAsk;
  private readonly outputs = new Map<string, StoredOutput>();
  private readonly noteTexts = new Set<string>();
  private memorySnapshot = "";
  private latestUser = "";
  private active: boolean;

  private constructor(session: Pick<Session, "readList" | "appendList">, getApiKey: () => string | null, ask: JevAsk) {
    this.session = session;
    this.getApiKey = getApiKey;
    this.ask = ask;
    this.active = getApiKey() !== null;
  }

  static async create(session: Pick<Session, "readList" | "appendList">, getApiKey: () => string | null, context: Context, ask: JevAsk = defaultAsk) {
    const memory = new JevMemory(session, getApiKey, ask);
    const notes = await session.readList(NOTES, { order: "desc", limit: MEMORY_LIMIT }, context);
    const unique: MemoryNote[] = [];
    for (const { value } of notes) {
      const key = value.text.toLocaleLowerCase();
      memory.noteTexts.add(key);
      if (!unique.some(note => note.text.toLocaleLowerCase() === key)) unique.push(value);
    }
    const bullets = unique.map(note => `- ${note.text}`).join("\n").slice(0, MEMORY_CHARS);
    if (bullets) memory.memorySnapshot = `# Memory from earlier turns (JEV)\nThese notes were retained from this thread. Treat them as likely, but verify them before relying on details.\n${bullets}`;
    return memory;
  }

  enabled(): boolean { return this.active && this.getApiKey() !== null; }

  setActive(active: boolean): void { this.active = active; }

  restore(messages: AgentMessage[]): void {
    for (const message of messages) {
      if (message.role !== "toolResult" || !message.details || typeof message.details !== "object") continue;
      const stored = (message.details as { jevMemory?: unknown }).jevMemory;
      if (!stored || typeof stored !== "object") continue;
      const value = stored as Partial<StoredOutput>;
      if (typeof value.full === "string" && typeof value.view === "string" && typeof value.sentLines === "number" && typeof value.totalLines === "number") {
        this.outputs.set(message.toolCallId, value as StoredOutput);
      }
    }
  }

  async afterTool(event: { toolCallId: string; toolName: string; args: Record<string, JsonValue>; content: AgentToolResult<unknown>["content"]; details?: JsonValue; isError: boolean }, signal?: AbortSignal) {
    const apiKey = this.enabled() ? this.getApiKey() : null;
    const full = textContent(event.content);
    if (!apiKey || !full || full.length < MIN_TOOL_CHARS || event.toolName === "recall") return undefined;
    const views = toolViews(full);
    if (views.length < 2) return undefined;
    const criteria = Object.fromEntries(views.map(view => [view.name, view.name === "full" ? "the exact complete output" : `a deterministic ${view.name} subset`]));
    try {
      const answers = await this.ask(apiKey, {
        state: {
          task: compact(this.latestUser, 600),
          tool: { name: event.toolName, arguments: compact(JSON.stringify(event.args), 300), is_error: event.isError },
          result: { total_lines: full.split("\n").length, total_chars: full.length },
          views: Object.fromEntries(views.map(view => [view.name, { lines: view.lines.length, chars: view.text.length, preview: compact(view.text, 1_500) }])),
        },
        questions: {
          view: choice("Choose the smallest view sufficient for the coding agent's next step.", criteria),
          needs_full: noul("Does the agent need the exact complete output rather than a deterministic subset?"),
        },
        model: "jev-latest",
      }, signal);
      const requested = answers.view?.choice;
      const selected = answers.needs_full?.noul != null && answers.needs_full.noul >= 0.5
        ? views.find(view => view.name === "full")!
        : views.find(view => view.name === requested) ?? views.find(view => view.name === "full")!;
      if (selected.name === "full") return undefined;
      const stored: StoredOutput = { full, view: selected.name, sentLines: selected.lines.length, totalLines: full.split("\n").length };
      this.outputs.set(event.toolCallId, stored);
      const footer = `[jev memory: showing the ${selected.name} view, ${stored.sentLines} of ${stored.totalLines} lines. Call recall(id: "${event.toolCallId}") for the full output, or recall with lines/pattern for a slice.]`;
      const original = event.details && typeof event.details === "object" && !Array.isArray(event.details) ? event.details : {};
      return { content: [{ type: "text" as const, text: `${selected.text}\n\n${footer}` }], details: { ...original, jevMemory: stored } };
    } catch { return undefined; }
  }

  transform(messages: AgentMessage[], systemPrompt: string): { messages: AgentMessage[]; systemPrompt: string } | undefined {
    if (!this.enabled()) return undefined;
    this.latestUser = [...messages].reverse().find(message => message.role === "user") ? messageText([...messages].reverse().find(message => message.role === "user")!) : this.latestUser;
    if (!this.memorySnapshot) return undefined;
    return { messages, systemPrompt: `${systemPrompt}\n\n${this.memorySnapshot}` };
  }

  async turnEnd(message: AssistantMessage, context: Context, signal?: AbortSignal): Promise<void> {
    const apiKey = this.enabled() ? this.getApiKey() : null;
    if (!apiKey || message.stopReason === "error" || message.stopReason === "aborted") return;
    const user = compact(this.latestUser, 400);
    const assistant = compact(messageText(message), 400);
    const questions = {
      ...(user.length >= 40 && !this.noteTexts.has(user.toLocaleLowerCase()) ? { user: noul("Will this user-provided fact, preference, constraint, or decision probably help in later turns of this coding thread?") } : {}),
      ...(assistant.length >= 40 && !this.noteTexts.has(assistant.toLocaleLowerCase()) ? { assistant: noul("Will this agent conclusion, decision, or discovered fact probably help in later turns of this coding thread?") } : {}),
    };
    if (!Object.keys(questions).length) return;
    try {
      const answers = await this.ask(apiKey, { state: { first_task: user, latest_agent_message: assistant }, questions, model: "jev-latest" }, signal);
      for (const [source, text] of [["user", user], ["assistant", assistant]] as const) {
        if (!text || (answers[source]?.noul ?? 0) <= 0.7) continue;
        const key = text.toLocaleLowerCase();
        if (this.noteTexts.has(key)) continue;
        await this.session.appendList(NOTES, { text, source, createdAt: Date.now() }, context);
        this.noteTexts.add(key);
      }
    } catch {
      // Classification is fail-open: the original context remains available.
    }
  }

  recall(id: string, lines?: string, pattern?: string): string {
    const output = this.outputs.get(id);
    if (!output) return `No stored output for id ${id}. Re-run the original tool instead.`;
    const all = output.full.split("\n");
    if (lines) {
      const match = lines.match(/^(\d+)-(\d+)$/);
      if (!match) return "lines must look like 120-180";
      const start = Number(match[1]); const end = Number(match[2]);
      if (start < 1 || end < start) return "lines must look like 120-180";
      return all.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n");
    }
    if (pattern) {
      const needle = pattern.toLocaleLowerCase();
      const matches = all.flatMap((line, index) => line.toLocaleLowerCase().includes(needle) ? [index] : []);
      if (!matches.length) return `No lines matched ${pattern}.`;
      const selected = new Set(matches.flatMap(index => [index - 2, index - 1, index, index + 1, index + 2]).filter(index => index >= 0 && index < all.length));
      return [...selected].sort((a, b) => a - b).map(index => `${index + 1}: ${all[index]}`).join("\n");
    }
    return output.full;
  }

  recallTool() {
    return {
      name: "recall",
      label: "recall",
      description: "Retrieve the full output or a line/pattern slice for a tool result compressed by JEV memory. Use the id printed in the JEV memory note.",
      parameters: Type.Object({ id: Type.String(), lines: Type.Optional(Type.String()), pattern: Type.Optional(Type.String()) }),
      replay: "safe" as const,
      execute: async (_id: string, args: { id: string; lines?: string; pattern?: string }) => ({
        content: [{ type: "text" as const, text: this.enabled() ? this.recall(args.id, args.lines, args.pattern) : "JEV memory is disabled." }],
        details: {},
      }),
    };
  }
}

export function installJevMemory(harness: AgentHarness, memory: JevMemory): void {
  harness.hooks.on("after_tool", (event, context) => memory.afterTool(event, context.abortSignal), { id: "cube.jev.after-tool" });
  harness.hooks.on("transform_context", event => memory.transform(event.messages, event.systemPrompt), { id: "cube.jev.context" });
  harness.events.on("turn_end", (event, context) => memory.turnEnd(event.message, context, context.abortSignal));
}

export function redactJevDetails(message: ToolResultMessage): ToolResultMessage {
  if (!message.details || typeof message.details !== "object" || !("jevMemory" in message.details)) return message;
  const { jevMemory: stored, ...details } = message.details as Record<string, unknown>;
  if (!stored || typeof stored !== "object") return { ...message, details };
  const { full: _full, ...safe } = stored as Record<string, unknown>;
  return { ...message, details: { ...details, jevMemory: safe } };
}

export function jevOutputComparison(message: ToolResultMessage): JevOutputComparison | null {
  if (!message.details || typeof message.details !== "object") return null;
  const value = (message.details as { jevMemory?: unknown }).jevMemory;
  if (!value || typeof value !== "object") return null;
  const stored = value as Partial<StoredOutput>;
  if (typeof stored.full !== "string" || typeof stored.view !== "string" || typeof stored.sentLines !== "number" || typeof stored.totalLines !== "number") return null;
  return { original: stored.full, compressed: messageText(message), view: stored.view, sentLines: stored.sentLines, totalLines: stored.totalLines };
}
