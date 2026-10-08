/** OptChat's memory: the log of messages, the binary tree of one-line
 * summaries over it, the view that tiles the whole chat in a byte sawtooth
 * (VIEW_LOW to VIEW) and the compactor's own coarser view in a smaller one
 * (COMPACTION_LOW to COMPACTION). Pure and synchronous; the service persists
 * messages (as Pi entries) and nodes, and the compactor builds nodes. See
 * docs/optchat.md. */

export const NODE = 512;
/** Once the view passes VIEW bytes, one batch merges it down to VIEW_LOW. */
export const VIEW = 128_000;
export const VIEW_LOW = 64_000;
/** The compaction view is the view merged further, in the same sawtooth. */
export const COMPACTION = 32_000;
export const COMPACTION_LOW = 16_000;
/** A message's node starts once fewer than UNBUILT lines before it are unbuilt. */
export const UNBUILT = 8;
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

/** Whether `parts` tile the first `total` messages with every line above a
 * message built; a message's own line may still wait for its summary. */
function tilesBuilt(parts: readonly Part[], total: number, built: (l: number, i: number) => boolean): boolean {
  let at = 0;
  for (const part of parts) {
    if (start(part) !== at || (part.l > 0 && !built(part.l, part.i))) return false;
    at = end(part);
  }
  return at === total;
}

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
  private merged = 0;
  /** The compactor's view: the view merged further, each of its parts a run
   * of whole view parts. Between its batches it only grows at its end. */
  readonly compaction: Part[] = [];
  private compactionSize = 0;
  private readonly compactionUpper: number;
  private readonly compactionLower: number;
  /** A compaction view batch has not reached its low mark yet. */
  private compacting = false;
  /** Called after every fit, so waiters can check `settled()`. */
  onChange: () => void = () => {};
  constructor(options: { view?: number; low?: number; node?: number; compaction?: number; compactionLow?: number } = {}) {
    this.upper = options.view ?? VIEW;
    this.lower = options.low ?? Math.floor(this.upper / 2);
    this.limit = options.node ?? NODE;
    this.compactionUpper = options.compaction ?? COMPACTION;
    this.compactionLower = options.compactionLow ?? Math.floor(this.compactionUpper / 2);
  }

  get length(): number { return this.messages.length; }
  get nodeLimit(): number { return this.limit; }
  /** The view's size in bytes: its rendered lines, each with its newline. */
  get bytes(): number { return this.size; }
  /** Whether a batch is still merging toward VIEW_LOW; stored with the view. */
  get batching(): boolean { return this.merging; }
  /** Merges made, each a rewrite of the view from the merged line on. */
  get merges(): number { return this.merged; }
  /** The compaction view's size in bytes: its built lines as the compactor reads them, each with its newline. */
  get compactionBytes(): number { return this.compactionSize; }
  /** Whether a compaction view batch is still merging toward its low mark; stored with the view. */
  get compactionBatching(): boolean { return this.compacting; }
  built(l: number, i: number): boolean { return this.nodes.has(key(l, i)); }
  node(l: number, i: number): string | undefined { return this.nodes.get(key(l, i)); }
  private partText(part: Part): string { return this.node(part.l, part.i) ?? PLACEHOLDER; }
  /** A view line as rendered: `id+n|text` with its newline. */
  private line(part: Part): string { return `${start(part)}+${2 ** part.l}|${flat(this.partText(part))}`; }
  private lineBytes(part: Part): number { return bytes(this.line(part)) + 1; }
  /** A compaction view line as the compactor reads it: no id, with its
   * newline. An unbuilt line is never read, so it counts nothing yet. */
  private bareBytes(part: Part): number {
    const text = this.node(part.l, part.i);
    return text === undefined ? 0 : bytes(flat(text)) + 1;
  }

  /** A new message: appended to the log and to both views as its own line. */
  append(message: LogMessage): void {
    this.messages.push(message);
    const part = { l: 0, i: this.messages.length - 1 };
    this.view.push(part);
    this.size += this.lineBytes(part);
    this.compaction.push({ ...part });
    this.compactionSize += this.bareBytes(part);
    this.fit();
  }

  /** Restores a stored view over the first messages of the log, so a reopen
   * goes on from the view it had instead of folding a different one, and an
   * unfinished batch goes on merging. Refused (false) unless the parts tile
   * exactly those messages and every line above a message is built (a
   * message's own line may still wait for its summary). The compaction view
   * restores too if it coarsens that view; otherwise (views stored before
   * it) it is merged down from the view again. */
  restore(messages: readonly LogMessage[], parts: readonly Part[], batching = false, compaction?: { parts: readonly Part[]; batching: boolean }): boolean {
    if (this.messages.length) return false;
    const built = (l: number, i: number) => this.built(l, i);
    if (!tilesBuilt(parts, messages.length, built)) return false;
    this.messages.push(...messages);
    this.view.push(...parts.map(part => ({ ...part })));
    this.size = parts.reduce((sum, part) => sum + this.lineBytes(part), 0);
    this.merging = batching;
    const starts = new Set(parts.map(start));
    if (compaction && tilesBuilt(compaction.parts, messages.length, built) && compaction.parts.every(part => starts.has(start(part)))) {
      this.compaction.push(...compaction.parts.map(part => ({ ...part })));
      this.compactionSize = compaction.parts.reduce((sum, part) => sum + this.bareBytes(part), 0);
      this.compacting = compaction.batching;
    } else this.refold();
    this.fit();
    return true;
  }

  /** A built node. Nodes are immutable: a second build of the same node is ignored. */
  setNode(l: number, i: number, text: string): void {
    if (this.built(l, i)) return;
    const shown = this.view.filter(part => part.l === l && part.i === i);
    const bare = this.compaction.filter(part => part.l === l && part.i === i);
    for (const part of shown) this.size -= this.lineBytes(part);
    for (const part of bare) this.compactionSize -= this.bareBytes(part);
    this.nodes.set(key(l, i), text);
    for (const part of shown) this.size += this.lineBytes(part);
    for (const part of bare) this.compactionSize += this.bareBytes(part);
    this.fit();
  }

  /** Merges the most due pairs of `parts` whose parent is built while the
   * size, `size` less what was cut by `measure`, is over `low`. */
  private shrink(parts: Part[], size: number, low: number, measure: (part: Part) => number): { size: number; merges: number } {
    const total = this.messages.length;
    let merges = 0;
    while (size > low) {
      const best = mostDue(parts, total, (l, i) => this.built(l, i));
      if (best < 0) break;
      const a = parts[best]!, b = parts[best + 1]!;
      const parent = { l: a.l + 1, i: a.i / 2 };
      size += measure(parent) - measure(a) - measure(b);
      parts.splice(best, 2, parent);
      merges++;
    }
    return { size, merges };
  }

  /** The compaction view starts again from the view, to be merged down to its low mark. */
  private refold(): void {
    this.compaction.splice(0, this.compaction.length, ...this.view.map(part => ({ ...part })));
    this.compactionSize = this.compaction.reduce((sum, part) => sum + this.bareBytes(part), 0);
    this.compacting = true;
  }

  /** Between batches the view only grows at its end. Once it passes its
   * high mark, one batch merges the most due pairs until it is at most its
   * low mark. A batch merges only pairs whose parent is built; one that
   * cannot reach the low mark yet goes on at each later message or node.
   * The compaction view does the same within its own marks, and starts
   * again from the view whenever the view merges, so it stays the view
   * merged further. */
  private fit(): void {
    if (this.size > this.upper) this.merging = true;
    if (this.merging) {
      const { size, merges } = this.shrink(this.view, this.size, this.lower, part => this.lineBytes(part));
      this.size = size;
      this.merged += merges;
      // At every merge, even of a batch that goes on later: refolding only
      // once a batch closes would leave lines finer than the view's.
      if (merges) this.refold();
      if (this.size <= this.lower) this.merging = false;
    }
    if (this.compactionSize > this.compactionUpper) this.compacting = true;
    if (this.compacting) {
      this.compactionSize = this.shrink(this.compaction, this.compactionSize, this.compactionLower, part => this.bareBytes(part)).size;
      if (this.compactionSize <= this.compactionLower) this.compacting = false;
    }
    this.onChange();
  }

  /** Every line of the view is a summary: a turn may start. */
  settled(): boolean { return this.view.every(part => this.built(part.l, part.i)); }

  /** Nodes that may be built now, in order. A message's node starts once
   * fewer than UNBUILT lines before it are unbuilt (an unbuilt line is
   * always a message's own, so: unbuilt messages before it, busy ones
   * included); a merge starts once both its halves are built. No message
   * from `stop` on has started (its unbuilt lines before only ever shrink),
   * so no merge reaching it can start either: the scan ends there. */
  ready(busy: ReadonlySet<string>, limit: number): Job[] {
    const jobs: Job[] = [];
    const total = this.messages.length;
    let stop = total;
    for (let l = 0; 2 ** l <= total; l++) {
      while ((this.low[l] ?? 0) * 2 ** l < total && this.built(l, this.low[l] ?? 0)) this.low[l] = (this.low[l] ?? 0) + 1;
      let unbuilt = 0;
      for (let i = this.low[l] ?? 0; (i + 1) * 2 ** l <= stop; i++) {
        if (jobs.length + busy.size >= limit) return jobs;
        if (l === 0 && unbuilt >= UNBUILT) { stop = i; break; }
        if (this.built(l, i)) continue;
        if (l === 0) unbuilt++;
        if (busy.has(key(l, i))) continue;
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

  /** The compactor's context for node `(l, i)`: the bare text of the
   * compaction view's lines before it (level 0) or up to its last message
   * (a merge), up to the first unbuilt line, so no call sees a placeholder.
   * No ids. */
  context(l: number, i: number): string[] {
    const limit = l === 0 ? i : end({ l, i });
    const lines: string[] = [];
    for (const part of this.compaction) {
      if (end(part) > limit || !this.built(part.l, part.i)) break;
      lines.push(flat(this.partText(part)));
    }
    return lines;
  }

  /** The view as every call sees it. `parts` defaults to the current view. */
  render(parts: readonly Part[] = this.view): string {
    const lines = parts.map(part => this.line(part));
    return `<chat>\n${lines.join("\n")}${lines.length ? "\n" : ""}</chat>`;
  }

  /** The view up to its first unbuilt line, rendered, and the messages its
   * lines cover: what a thread gets, never a placeholder. */
  builtView(): { chat: string; messages: number } {
    const unbuilt = this.view.findIndex(part => !this.built(part.l, part.i));
    const parts = unbuilt < 0 ? this.view : this.view.slice(0, unbuilt);
    return { chat: this.render(parts), messages: parts.length ? end(parts.at(-1)!) : 0 };
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
