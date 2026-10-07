/** Wishes not started: what the user asked for in the chat that no thread
 * of the chat has taken up, inferred from the chat's own log. Nobody keeps
 * this list by hand. A cheap model reads the log in order, a chunk at a
 * time and only while the chat is idle, and proposes wishes, repeats, and
 * wishes a spawn or tell took up or the user withdrew. Everything it says
 * is checked against the log: a wish quotes the user's own words from the
 * messages it names; a start names a spawn or tell in the same chunk. Only
 * explicit, high-confidence wishes are kept; the list is a hint, never a
 * record of what was done, merged or released. See docs/optchat.md,
 * "Wishes not started". */
import type { JsonRepresentation } from "@earendil-works/chord";
import type { AssistantMessage, Message, Models, Usage } from "@earendil-works/pi-ai";
import type { LogMessage } from "./optchat-memory.ts";

export const WISH_LIMITS = {
  /** Characters of log a chunk carries; one model call each. */
  chunk: 24_000,
  /** A user message's characters in a chunk; OptChat's reply and a report get fewer. */
  user: 1500, talk: 400, report: 300, tool: 600,
  /** Open wishes kept and sent to the model; dismissed ones sent so they are not found again. */
  open: 30, dismissedSent: 20,
  /** Characters of a wish's own words and of the quote it rests on. */
  text: 160, quote: 240,
  /** Wishes the panel shows at once. */
  shown: 7,
  /** Model calls a UTC day, backlog included. */
  callsPerDay: 60,
  /** Output tokens a call may use. */
  maxTokens: 2000,
} as const;

export type WishStatus = "open" | "started" | "withdrawn" | "dismissed";
export type Wish = {
  /** `w<n>`, never reused. */
  id: string;
  /** The wish in a few words, the model's. */
  text: string;
  /** The user's own words it rests on, checked against the source message. */
  quote: string;
  /** Message ids (the view's) of the user messages that ask for it. */
  sources: number[];
  project: string | null;
  status: WishStatus;
  /** The spawn or tell (message id) that took it up, or the message that withdrew it. */
  by: number | null;
  created: number;
  updated: number;
};
export type Wishes = {
  /** The log's messages before this id are read. */
  through: number;
  /** Set once the whole log was read: before, the list is not shown. */
  ready: boolean;
  seq: number;
  items: Wish[];
  /** The last call's time and failure, and calls on the day `day` (UTC). */
  lastRun: number | null;
  error: string | null;
  day: string;
  callsToday: number;
  /** The calls' usage by `provider/model`, beside Pi like the compactor's. */
  usage: { models: Record<string, JsonRepresentation<Usage>>; calls: Record<string, number> };
};
export const initialWishes = (): Wishes => ({ through: 0, ready: false, seq: 0, items: [], lastRun: null, error: null, day: "", callsToday: 0, usage: { models: {}, calls: {} } });

const REPORT = /^\[[0-9a-f]{8}\] /;
/** A thread's report, which the log holds as a user message. */
export const isReport = (message: LogMessage) => message.kind === "user" && REPORT.test(message.text);
/** The user's own words: a user message that is not a report. */
export const isUserWords = (message: LogMessage) => message.kind === "user" && !REPORT.test(message.text);
/** A tool call that hands work to a thread. */
export const isHandOff = (message: LogMessage) => message.kind === "tool" && /^(spawn|tell) /.test(message.text);
/** The result of the hand-off at `id`, if the log has it: the next tool result. */
const handOffResult = (messages: readonly LogMessage[], id: number) => {
  for (let k = id + 1; k < messages.length && k <= id + 4; k++) if (messages[k]!.kind === "echo") return k;
  return -1;
};
/** Whether the hand-off at `id` reached a thread: a spawn that started one, a tell that was sent. */
export function handedOff(messages: readonly LogMessage[], id: number): boolean {
  const result = messages[handOffResult(messages, id)]?.text ?? "";
  return messages[id]!.text.startsWith("spawn ") ? /^\[[0-9a-f]{8}\] started in /m.test(result) : /^sent to \[[0-9a-f]{8}\]/.test(result);
}
/** A quote long enough to be the user's words rather than any word. */
const QUOTE_WORDS = 3;

const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const cut = (text: string, max: number) => { const value = flat(text); return value.length > max ? `${value.slice(0, max - 1)}…` : value; };

/** One message as a chunk line, or null when the chunk leaves it out (tool
 * results, other tool calls, notes, thinking). */
export function chunkLine(message: LogMessage, id: number, messages?: readonly LogMessage[]): string | null {
  if (message.kind === "echo") {
    // A hand-off's result says whether it reached a thread.
    if (!messages) return null;
    let call = id - 1;
    while (call >= 0 && id - call <= 4 && messages[call]!.kind !== "tool") call--;
    return call >= 0 && isHandOff(messages[call]!) && handOffResult(messages, call) === id ? `#${id} result: ${cut(message.text, WISH_LIMITS.report)}` : null;
  }
  if (isReport(message)) return `#${id} report ${cut(message.text, WISH_LIMITS.report)}`;
  if (message.kind === "user") return `#${id} user: ${cut(message.text, WISH_LIMITS.user)}`;
  if (message.kind === "talk") return `#${id} optchat: ${cut(message.text, WISH_LIMITS.talk)}`;
  if (isHandOff(message)) return `#${id} optchat ${cut(message.text, WISH_LIMITS.tool)}`;
  return null;
}

export type Chunk = { from: number; to: number; lines: string[]; users: number; handOffs: number };
/** The next chunk of `messages` from `from`: whole lines up to the chunk
 * size, at least one message. `to` is the first message after it. */
export function nextChunk(messages: readonly LogMessage[], from: number, size: number = WISH_LIMITS.chunk): Chunk {
  const lines: string[] = [];
  let used = 0, users = 0, handOffs = 0, to = from;
  for (; to < messages.length; to++) {
    const message = messages[to]!;
    const line = chunkLine(message, to, messages);
    if (line && lines.length && used + line.length > size) break;
    if (line) { lines.push(line); used += line.length + 1; }
    if (isUserWords(message)) users++;
    if (isHandOff(message)) handOffs++;
  }
  return { from, to, lines, users, handOffs };
}

export const WISHES_PROMPT = `You read part of the log of OptChat, a chat between one user and an agent
(OptChat) that does the user's work by starting threads (spawn) and sending
them messages (tell). Your job: find what the user explicitly asked to have
done that no thread has taken up, so it is not forgotten.

The log lines are "#id kind: text". user is the user's own words. optchat is
the agent's reply or its spawn/tell call (whose tasks show what a thread was
asked to do). report is a thread's report to OptChat, not the user's words.

Classify each candidate in the user's words as one kind:
- wish: the user plainly wants something done (an order, a request, "I want",
  "we should", "please add"), now or as a standing goal;
- question: asks for information or an opinion only;
- hypothetical: "what if", "could we", musing, no decision;
- rejected: the user says no, or drops it;
- deferred: the user says not now, later, maybe someday;
- suggestion: the agent proposed it and the user did not clearly ask for it;
- done: it was already done or under way when said.
Only wish counts; report the other kinds too so the reason is visible.

A wish is started when a spawn or tell after it in this log asks a thread to
do it and its result shows it started or was sent; then name the spawn or
tell line. An open wish (in <open>) is started, repeated or
withdrawn by lines of this log in the same way. Never infer that something was
done, merged, released or installed: a report says only what a thread said.
Do not add a wish that is the same as an open or dismissed one: name the open
one as repeated instead. Quote the user's own words exactly, copied from the
source line. When unsure, leave it out: an empty answer is a good answer.

Answer with JSON only, no prose:
{"found":[{"kind":"wish","confidence":"high","text":"<the wish in under 20 words>","quote":"<exact words of the user>","source":[<user line ids>],"project":"<project name or null>","started_by":<spawn/tell line id or null>}],
 "repeated":[{"wish":"w1","source":[<user line ids>]}],
 "started":[{"wish":"w1","by":<spawn/tell line id>}],
 "withdrawn":[{"wish":"w1","source":[<user line id>]}]}`;

/** The model's request for one chunk. */
export function wishMessages(chunk: Chunk, doc: Wishes): Message[] {
  const open = doc.items.filter(wish => wish.status === "open").slice(-WISH_LIMITS.open);
  const dismissed = doc.items.filter(wish => wish.status === "dismissed").slice(-WISH_LIMITS.dismissedSent);
  const now = Date.now();
  const text = [
    "<open>", ...open.length ? open.map(wish => `${wish.id}: ${wish.text}${wish.project ? ` (${wish.project})` : ""}`) : ["none"], "</open>",
    "<dismissed>", ...dismissed.length ? dismissed.map(wish => `- ${wish.text}`) : ["none"], "</dismissed>",
    "<log>", ...chunk.lines, "</log>",
  ].join("\n");
  return [{ role: "system", content: WISHES_PROMPT, timestamp: now }, { role: "user", content: [{ type: "text", text }], timestamp: now }];
}

type Found = { kind?: unknown; confidence?: unknown; text?: unknown; quote?: unknown; source?: unknown; project?: unknown; started_by?: unknown };
type Answer = { found?: Found[]; repeated?: Array<{ wish?: unknown; source?: unknown }>; started?: Array<{ wish?: unknown; by?: unknown }>; withdrawn?: Array<{ wish?: unknown; source?: unknown }> };

/** The JSON object in a reply, fenced or not. */
export function parseAnswer(reply: string): Answer {
  const start = reply.indexOf("{"), end = reply.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("the wish finder's reply holds no JSON object");
  const value = JSON.parse(reply.slice(start, end + 1)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("the wish finder's reply is not an object");
  return value as Answer;
}

const words = (text: string) => new Set(text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(word => word.length > 2));
/** Two wishes are the same when their words mostly agree. */
export function similar(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return flat(a).toLowerCase() === flat(b).toLowerCase();
  let both = 0;
  for (const word of x) if (y.has(word)) both++;
  // High: a csv and a pdf export of one page are two wishes. The model
  // names a reworded repeat itself.
  return both / (x.size + y.size - both) >= 0.8;
}
const loose = (text: string) => flat(text).toLowerCase().replace(/[“”"'‘’`]/g, "");

export type Applied = { added: string[]; repeated: string[]; started: string[]; withdrawn: string[]; refused: string[] };

/** Applies one checked answer for `chunk` to `doc`. Whatever the log does
 * not bear out is refused, never kept: a wish needs high confidence, the
 * user's own words quoted from a user message of the chunk, and no twin
 * among the wishes known; a start needs a spawn or tell of the chunk after
 * the wish's words. */
export function applyAnswer(doc: Wishes, answer: Answer, chunk: Chunk, messages: readonly LogMessage[], now: number): Applied {
  const result: Applied = { added: [], repeated: [], started: [], withdrawn: [], refused: [] };
  const inChunk = (id: unknown): id is number => Number.isInteger(id) && (id as number) >= chunk.from && (id as number) < chunk.to;
  const userIds = (value: unknown) => (Array.isArray(value) ? value : [value]).filter((id): id is number => inChunk(id) && isUserWords(messages[id]!));
  // A hand-off that failed (no such project, a refused tell) took nothing up.
  const handOff = (value: unknown): number | null => inChunk(value) && isHandOff(messages[value]!) && handedOff(messages, value) ? value : null;
  const wish = (value: unknown) => typeof value === "string" ? doc.items.find(item => item.id === value.trim()) : undefined;
  const addSources = (item: Wish, ids: readonly number[]) => { item.sources = [...new Set([...item.sources, ...ids])].sort((a, b) => a - b); item.updated = now; };

  for (const found of Array.isArray(answer.found) ? answer.found : []) {
    const label = typeof found.text === "string" ? cut(found.text, 60) : "?";
    if (found.kind !== "wish") { result.refused.push(`${label}: ${typeof found.kind === "string" ? found.kind : "no kind"}`); continue; }
    if (found.confidence !== "high") { result.refused.push(`${label}: not high confidence`); continue; }
    const text = typeof found.text === "string" ? cut(found.text, WISH_LIMITS.text) : "";
    const quote = typeof found.quote === "string" ? flat(found.quote) : "";
    const sources = userIds(found.source);
    if (!text || !quote || !sources.length) { result.refused.push(`${label}: no user message of this chunk named`); continue; }
    if (quote.split(" ").length < QUOTE_WORDS) { result.refused.push(`${label}: quote too short to be the user's words`); continue; }
    // The quote must be the user's own words, in a message it names.
    if (!sources.some(id => loose(messages[id]!.text).includes(loose(quote)))) { result.refused.push(`${label}: quote not found in its source`); continue; }
    const project = typeof found.project === "string" && found.project.trim() && found.project !== "null" ? cut(found.project, 80) : null;
    const twin = doc.items.find(item => similar(item.text, text) || loose(item.quote) === loose(quote));
    const by = handOff(found.started_by);
    const startedBy = by !== null && by > Math.max(...sources) ? by : null;
    if (twin) {
      addSources(twin, sources);
      if (startedBy !== null && twin.status === "open") Object.assign(twin, { status: "started", by: startedBy });
      // A repeat of a wish taken up or withdrawn earlier asks for it again.
      else if ((twin.status === "started" || twin.status === "withdrawn") && startedBy === null && Math.max(...sources) > (twin.by ?? -1)) Object.assign(twin, { status: "open", by: null });
      result.repeated.push(twin.id);
      continue;
    }
    if (startedBy === null && doc.items.filter(item => item.status === "open").length >= WISH_LIMITS.open) { result.refused.push(`${label}: ${WISH_LIMITS.open} wishes are open`); continue; }
    const item: Wish = { id: `w${++doc.seq}`, text, quote: cut(quote, WISH_LIMITS.quote), sources, project,
      status: startedBy === null ? "open" : "started", by: startedBy, created: now, updated: now };
    doc.items.push(item);
    result.added.push(item.id);
  }
  for (const repeat of Array.isArray(answer.repeated) ? answer.repeated : []) {
    const item = wish(repeat.wish), sources = userIds(repeat.source);
    if (!item || !sources.length) continue;
    addSources(item, sources);
    result.repeated.push(item.id);
  }
  for (const start of Array.isArray(answer.started) ? answer.started : []) {
    const item = wish(start.wish), by = handOff(start.by);
    if (!item || item.status !== "open" || by === null || by <= Math.max(...item.sources)) { result.refused.push(`start of ${String(start.wish)}: not borne out`); continue; }
    Object.assign(item, { status: "started", by, updated: now });
    result.started.push(item.id);
  }
  for (const withdraw of Array.isArray(answer.withdrawn) ? answer.withdrawn : []) {
    const item = wish(withdraw.wish), sources = userIds(withdraw.source);
    if (!item || item.status !== "open" || !sources.length || Math.max(...sources) < Math.max(...item.sources)) continue;
    Object.assign(item, { status: "withdrawn", by: Math.max(...sources), updated: now });
    result.withdrawn.push(item.id);
  }
  return result;
}

/** An answer that came back but cannot be used: asking again would cost the same. */
export class WishAnswerError extends Error {}

/** The text of a model's reply; a failed one (a provider's error, retried later) throws. */
export function replyText(message: AssistantMessage): string {
  if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? `wish finder ${message.stopReason}`);
  return message.content.map(part => part.type === "text" ? part.text : "").join("").trim();
}

/** One chunk: one model call, its answer checked and applied. */
export async function findWishes(options: { models: Models; model: { provider: string; id: string }; doc: Wishes; chunk: Chunk; messages: readonly LogMessage[]; signal?: AbortSignal;
  onReply?: (reply: AssistantMessage) => void | Promise<void> }): Promise<Answer> {
  const model = options.models.getModel(options.model.provider, options.model.id);
  if (!model) throw new Error(`model ${options.model.provider}/${options.model.id} is unavailable`);
  const reply = await options.models.completeSimple(model, { messages: wishMessages(options.chunk, options.doc) }, {
    maxTokens: WISH_LIMITS.maxTokens,
    ...(model.reasoning ? { reasoning: "low" as const } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  await options.onReply?.(reply);
  const text = replyText(reply);
  try { return parseAnswer(text); }
  catch (error) { throw new WishAnswerError(error instanceof Error ? error.message : String(error)); }
}

/** A wish as the UI reads it: its words, the user's quote and where they said it. */
export type WishView = Pick<Wish, "id" | "text" | "quote" | "project"> & { sources: Array<{ message: number; entry: number | null; date: number | null }> };
export type WishList = {
  /** off: no model or switched off; catching up: older messages are still being read (nothing shown until done). */
  state: "off" | "catching up" | "ready";
  wishes: WishView[];
  /** Open wishes beyond the ones shown. */
  more: number;
  read: number;
  total: number;
  error: string | null;
  lastRun: number | null;
  reason: string | null;
};
