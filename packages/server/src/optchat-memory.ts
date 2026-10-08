/** OptChat's memory: the log of messages, the binary tree of one-line
 * summaries over it and the view that tiles the whole chat in a byte
 * sawtooth (VIEW_LOW to VIEW). Pure and synchronous; the service persists messages (as Pi
 * entries) and nodes, and the compactor builds nodes. See docs/optchat.md. */

export const NODE = 512;
/** Once the view passes VIEW bytes, one batch merges it down to VIEW_LOW. */
export const VIEW = 128_000;
export const VIEW_LOW = 64_000;
export const CAP = 30_000;

export type MessageKind = "user" | "talk" | "tool" | "echo" | "note";
export type LogMessage = { kind: MessageKind; text: string; date: number };
/** A view part: tree node `(l, i)`, covering messages `[i·2^l, (i+1)·2^l)`. */
export type Part = { l: number; i: number };

export const PLACEHOLDER = "(not summarized yet: zoom it)";

const encoder = new TextEncoder();
export const bytes = (text: string) => encoder.encode(text).length;
const flat = (text: string) => text.replace(/\s*\n\s*/g, " ");
const key = (l: number, i: number) => `${l}:${i}`;
export const start = (part: Part) => part.i * 2 ** part.l;
export const end = (part: Part) => (part.i + 1) * 2 ** part.l;

/** How due the sibling pair starting at `a` is to merge, with `total`
 * messages in the chat: how long ago the pair's last message was, in its
 * own line size. Measuring from the first message rewrites old lines. */
export const due = (a: Part, total: number) => (total - (end(a) + 2 ** a.l - 1)) / 2 ** a.l;

/** The most due pair of adjacent siblings whose parent is built, the oldest
 * of equal ones, as the index of its first part; -1 if there is none. */
export function mostDue(view: readonly Part[], total: number, built: (l: number, i: number) => boolean): number {
  let best = -1, most = -Infinity;
  for (let k = 0; k + 1 < view.length; k++) {
    const a = view[k]!, b = view[k + 1]!;
    if (a.l !== b.l || a.i % 2 !== 0 || b.i !== a.i + 1 || !built(a.l + 1, a.i / 2)) continue;
    const weight = due(a, total);
    if (weight > most) { most = weight; best = k; }
  }
  return best;
}

/** The text of one message as the tree sees it. */
export const messageLine = (message: LogMessage) => `${message.kind}: ${message.text}`;

/** A long tool result keeps its head and tail, with a note of what was cut. */
export function capText(text: string, cap = CAP): string {
  if (text.length <= cap) return text;
  const half = Math.floor((cap - 64) / 2);
  return `${text.slice(0, half)}\n[… ${text.length - 2 * half} characters cut …]\n${text.slice(-half)}`;
}

/** The first `limit` bytes of `text`, without splitting a character. */
export function cutBytes(text: string, limit: number): string {
  const encoded = encoder.encode(text);
  if (encoded.length <= limit) return text;
  return new TextDecoder().decode(encoded.subarray(0, limit)).replace(/�$/, "");
}

export type Job = { l: number; i: number };

export class Memory {
  readonly messages: LogMessage[] = [];
  readonly view: Part[] = [];
  private readonly nodes = new Map<string, string>();
  /** Per level, the lowest index that may still be unbuilt. */
  private readonly low: number[] = [];
  private size = 0;
  /** The view's high and low marks, in bytes. */
  private readonly upper: number;
  private readonly lower: number;
  private readonly limit: number;
  /** A batch passed VIEW and has not reached VIEW_LOW yet. */
  private merging = false;
  /** Merges made, each a rewrite of the view from the merged line on. */
  merges = 0;
  /** Called after every fit, so waiters can check `settled()`. */
  onChange: () => void = () => {};
  constructor(options: { view?: number; low?: number; node?: number } = {}) {
    this.upper = options.view ?? VIEW;
    this.lower = options.low ?? Math.floor(this.upper / 2);
    this.limit = options.node ?? NODE;
  }

  get length(): number { return this.messages.length; }
  get nodeLimit(): number { return this.limit; }
  /** The view's size in bytes: its rendered lines, each with its newline. */
  get bytes(): number { return this.size; }
  /** Whether a batch is still merging toward VIEW_LOW; stored with the view. */
  get batching(): boolean { return this.merging; }
  built(l: number, i: number): boolean { return this.nodes.has(key(l, i)); }
  node(l: number, i: number): string | undefined { return this.nodes.get(key(l, i)); }
  private partText(part: Part): string { return this.node(part.l, part.i) ?? PLACEHOLDER; }
  /** A view line as rendered: `id+n|text` with its newline. */
  private line(part: Part): string { return `${start(part)}+${2 ** part.l}|${flat(this.partText(part))}`; }
  private lineBytes(part: Part): number { return bytes(this.line(part)) + 1; }

  /** A new message: appended to the log and to the view as its own line. */
  append(message: LogMessage): void {
    this.messages.push(message);
    const part = { l: 0, i: this.messages.length - 1 };
    this.view.push(part);
    this.size += this.lineBytes(part);
    this.fit();
  }

  /** Restores a stored view over the first messages of the log, so a reopen
   * goes on from the view it had instead of folding a different one, and an
   * unfinished batch goes on merging. Refused (false) unless the parts are
   * built and tile exactly those messages. */
  restore(messages: readonly LogMessage[], parts: readonly Part[], batching = false): boolean {
    if (this.messages.length) return false;
    let at = 0;
    for (const part of parts) {
      if (start(part) !== at || !this.built(part.l, part.i)) return false;
      at = end(part);
    }
    if (at !== messages.length) return false;
    this.messages.push(...messages);
    this.view.push(...parts.map(part => ({ ...part })));
    this.size = parts.reduce((sum, part) => sum + this.lineBytes(part), 0);
    this.merging = batching;
    this.fit();
    return true;
  }

  /** A built node. Nodes are immutable: a second build of the same node is ignored. */
  setNode(l: number, i: number, text: string): void {
    if (this.built(l, i)) return;
    const shown = this.view.filter(part => part.l === l && part.i === i);
    for (const part of shown) this.size -= this.lineBytes(part);
    this.nodes.set(key(l, i), text);
    for (const part of shown) this.size += this.lineBytes(part);
    this.fit();
  }

  /** Between batches the view only grows at its end. Once it passes its
   * high mark, one batch merges the most due pairs until it is at most its
   * low mark. A batch merges only pairs whose parent is built; one that
   * cannot reach the low mark yet goes on at each later message or node. */
  private fit(): void {
    const total = this.messages.length;
    if (this.size > this.upper) this.merging = true;
    while (this.merging && this.size > this.lower) {
      const best = mostDue(this.view, total, (l, i) => this.built(l, i));
      if (best < 0) break;
      const a = this.view[best]!, b = this.view[best + 1]!;
      const parent = { l: a.l + 1, i: a.i / 2 };
      this.size += this.lineBytes(parent) - this.lineBytes(a) - this.lineBytes(b);
      this.view.splice(best, 2, parent);
      this.merges++;
    }
    if (this.size <= this.lower) this.merging = false;
    this.onChange();
  }

  /** Every line of the view is a summary: a turn may start. */
  settled(): boolean { return this.view.every(part => this.built(part.l, part.i)); }

  /** The first message whose view line is not built yet. */
  private first(): number {
    for (const part of this.view) if (!this.built(part.l, part.i)) return start(part);
    return this.messages.length;
  }

  /** Nodes that may be built now, in order: their sources exist and every
   * view line before their end is a summary, so the compactor never sees a
   * placeholder. Messages are compressed one at a time, in order. */
  ready(busy: ReadonlySet<string>, limit: number): Job[] {
    const jobs: Job[] = [];
    const total = this.messages.length, first = this.first();
    for (let l = 0; 2 ** l <= total; l++) {
      while ((this.low[l] ?? 0) * 2 ** l < total && this.built(l, this.low[l] ?? 0)) this.low[l] = (this.low[l] ?? 0) + 1;
      for (let i = this.low[l] ?? 0; (i + 1) * 2 ** l <= total; i++) {
        if (jobs.length + busy.size >= limit) return jobs;
        const last = l === 0 ? i : (i + 1) * 2 ** l;
        if (last > first) break;
        if (this.built(l, i) || busy.has(key(l, i))) continue;
        if (l > 0 && !(this.built(l - 1, 2 * i) && this.built(l - 1, 2 * i + 1))) continue;
        jobs.push({ l, i });
      }
    }
    return jobs;
  }

  /** What building node `(l, i)` takes: the free text, when the source
   * already fits, or the source the compactor shrinks. */
  source(l: number, i: number): { free: string } | { message: string } | { merge: [string, string] } {
    if (l === 0) {
      const line = messageLine(this.messages[i]!);
      return bytes(line) <= this.limit ? { free: line } : { message: line };
    }
    const a = this.node(l - 1, 2 * i)!, b = this.node(l - 1, 2 * i + 1)!;
    const joined = `${a}\n${b}`;
    return bytes(joined) <= this.limit ? { free: joined } : { merge: [flat(a), flat(b)] };
  }

  /** The compactor's context for node `(l, i)`: the bare text of the view
   * lines before it (level 0) or up to its last message (a merge). No ids. */
  context(l: number, i: number): string[] {
    const limit = l === 0 ? i : end({ l, i });
    return this.view.filter(part => end(part) <= limit).map(part => flat(this.partText(part)));
  }

  /** The view as every call sees it. `parts` defaults to the current view. */
  render(parts: readonly Part[] = this.view): string {
    const lines = parts.map(part => this.line(part));
    return `<chat>\n${lines.join("\n")}${lines.length ? "\n" : ""}</chat>`;
  }

  /** The `zoom` tool: a line opened into its two halves; n = 1 the whole message. */
  zoom(id: number, n: number): string {
    const total = this.messages.length;
    const valid = Number.isSafeInteger(id) && Number.isSafeInteger(n) && id >= 0 && n >= 1 && (n & (n - 1)) === 0 && id % n === 0 && id + n <= total;
    if (!valid) return `No line ${id}+${n}.`;
    if (n === 1) return `${id}+0|${messageLine(this.messages[id]!)}`;
    const l = Math.log2(n) - 1, i = (2 * id) / n;
    return [{ l, i }, { l, i: i + 1 }].map(part => this.line(part)).join("\n");
  }
}
